'use strict';

// ---------------------------------------------------------------------------
// UT320i Web Bluetooth explorer
//
// GATT layout confirmed via nRF Connect (2026-07-24, UT320i SN:251101079):
//
//   Service 0xFF12 (vendor, Realtek chip)
//     FF01 [write-no-response]  command channel
//     FF02 [notify]             data channel — silent until a command arrives
//     FF03..FF0B [read/write]   config registers (FF05 = user id "000001",
//                               FF06 = device name "UT320i SN:...")
//     FFF0, FFF1 [write]
//   0x180A Device Information, plus a Realtek OTA service (d0ff...)
//
// Related UNI-T "Smart Measure" meters (UT171/UT219P, see README) frame
// everything as:  AB CD <len u16> <cmd> <payload...> <checksum u16 LE>
// where checksum = additive sum of bytes from offset 2. They emit nothing
// until a START command. The UT320i likely speaks the same dialect over
// FF01/FF02 — the auto-probe below tries the known START variants and logs
// which one wakes the stream. Once frames arrive, use the candidate columns
// to find the temperature and finalize decodeFrame().
// ---------------------------------------------------------------------------

const UT_SERVICE = 0xff12;
const UT_WRITE_UUID = '0000ff01-0000-1000-8000-00805f9b34fb';
const UT_NOTIFY_UUID = '0000ff02-0000-1000-8000-00805f9b34fb';

const UT_CHAR_LABELS = {
  '0000ff01-0000-1000-8000-00805f9b34fb': 'command (write)',
  '0000ff02-0000-1000-8000-00805f9b34fb': 'data (notify)',
  '0000ff05-0000-1000-8000-00805f9b34fb': 'user id',
  '0000ff06-0000-1000-8000-00805f9b34fb': 'device name',
};

// Known command frames from reverse-engineered UNI-T Smart Measure meters.
// Byte sequences are verbatim from the ble-multimeter protocol docs; the
// auto-probe sends each in turn until the clamp starts notifying on FF02.
const PROBE_COMMANDS = [
  { label: 'START stream (UT171)', hex: 'ab cd 04 00 0a 01 16 00' },
  { label: 'live-data poll (UT219P)', hex: 'ab cd 00 04 05 00 09 00' },
  { label: 'device info (UT171)', hex: 'ab cd 04 00 16 5a 7b 00' },
  { label: 'device info (UT219P)', hex: 'ab cd 00 04 17 00 1b 00' },
];

// Web Bluetooth only exposes services declared up front.
const CANDIDATE_SERVICES = [
  UT_SERVICE,
  'battery_service',
  'device_information',
  'environmental_sensing',
  'health_thermometer',
  'generic_access',
  '0000d0ff-3c17-d293-8e48-14fe2e4da212', // Realtek OTA (on the UT320i)
  0xFFE0,
  0xFFF0,
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART
  '49535343-fe7d-4ae5-8fa9-9fafd205e455', // Microchip UART (older UNI-T meters)
];

const $ = (id) => document.getElementById(id);

let device = null;
let server = null;
let utWriteChar = null;
// [{time, serviceUuid, charUuid, bytes}]
const frames = [];
// charUuid -> writable BluetoothRemoteGATTCharacteristic
const writableChars = new Map();
let rxBuffer = new Uint8Array(0);

// --- Decoding -------------------------------------------------------------

// TODO: finalize once a live frame is captured. UT171-family live frames are
// AB CD <len u16 LE> 02 <flags u16> <mode u8> <range u8> <float32 LE value>
// <precision/overload u8> <unit u8> <checksum u16 LE>. Return {value, unit}
// or null.
function decodeFrame(bytes) {
  if (bytes.length >= 17 && bytes[0] === 0xab && bytes[1] === 0xcd && bytes[4] === 0x02) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const value = view.getFloat32(9, true);
    if (Number.isFinite(value) && value > -60 && value < 400) {
      return { value: value.toFixed(1), unit: '°C?' };
    }
  }
  return null;
}

// Plausible pipe temperatures for an HVAC clamp, used to rank candidates.
const PLAUSIBLE_C = [-50, 150];

function candidateValues(bytes) {
  const out = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let off = 0; off + 2 <= bytes.length; off++) {
    for (const [scale, label] of [[10, '/10'], [100, '/100']]) {
      const v = view.getInt16(off, true) / scale;
      if (v >= PLAUSIBLE_C[0] && v <= PLAUSIBLE_C[1] && v !== 0) {
        out.push(`@${off} i16${label}=${v.toFixed(scale === 10 ? 1 : 2)}`);
      }
    }
    if (off + 4 <= bytes.length) {
      const f = view.getFloat32(off, true);
      if (Number.isFinite(f) && f >= PLAUSIBLE_C[0] && f <= PLAUSIBLE_C[1] && Math.abs(f) > 1e-3) {
        out.push(`@${off} f32=${f.toFixed(2)}`);
      }
    }
  }
  return out;
}

// Reassemble AB CD ... frames that may span several notifications. Tries both
// byte orders for the length field since docs disagree between models.
function extractUtFrames(chunk) {
  const merged = new Uint8Array(rxBuffer.length + chunk.length);
  merged.set(rxBuffer);
  merged.set(chunk, rxBuffer.length);
  rxBuffer = merged;

  const found = [];
  while (true) {
    let start = -1;
    for (let i = 0; i + 1 < rxBuffer.length; i++) {
      if (rxBuffer[i] === 0xab && rxBuffer[i + 1] === 0xcd) { start = i; break; }
    }
    if (start < 0) { rxBuffer = new Uint8Array(0); break; }
    if (start > 0) rxBuffer = rxBuffer.slice(start);
    if (rxBuffer.length < 6) break;

    const lenLE = rxBuffer[2] | (rxBuffer[3] << 8);
    const lenBE = (rxBuffer[2] << 8) | rxBuffer[3];
    const total = (len) => 4 + len; // header(2) + len(2) + body incl. checksum
    let frameLen = 0;
    for (const len of [lenLE, lenBE]) {
      if (len >= 3 && len <= 512 && rxBuffer.length >= total(len)) {
        const end = total(len);
        let sum = 0;
        for (let i = 2; i < end - 2; i++) sum = (sum + rxBuffer[i]) & 0xffff;
        const chk = rxBuffer[end - 2] | (rxBuffer[end - 1] << 8);
        if (sum === chk) { frameLen = end; break; }
      }
    }
    if (!frameLen) {
      // No checksum-valid frame yet; wait for more data unless the buffer is
      // clearly garbage, then drop the header and rescan.
      if (rxBuffer.length > 512) rxBuffer = rxBuffer.slice(2);
      break;
    }
    found.push(rxBuffer.slice(0, frameLen));
    rxBuffer = rxBuffer.slice(frameLen);
  }
  return found;
}

// --- UI helpers -----------------------------------------------------------

function setStatus(text, connected) {
  $('status').textContent = text;
  $('status').classList.toggle('connected', !!connected);
  $('connect').disabled = !!connected;
  $('disconnect').disabled = !connected;
  $('probe').disabled = !connected || !utWriteChar;
}

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

function ascii(bytes) {
  return Array.from(bytes, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '·')).join('');
}

function shortUuid(uuid) {
  const m = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/.exec(uuid);
  return m ? '0x' + m[1].toUpperCase() : uuid;
}

function logLine(html, cls = 'frame') {
  const el = document.createElement('div');
  el.className = cls;
  el.innerHTML = html;
  const log = $('log');
  log.appendChild(el);
  while (log.childElementCount > 500) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

function logFrame(frame, tag) {
  const t = frame.time.toISOString().slice(11, 23);
  let html = `<span class="t">${t}</span> <span class="u">${tag || shortUuid(frame.charUuid)}</span> ` +
    `<span class="hex">${hex(frame.bytes)}</span> <span class="ascii">${ascii(frame.bytes)}</span>`;
  if ($('showCandidates').checked) {
    const cands = candidateValues(frame.bytes);
    if (cands.length) html += `<div class="cands">${cands.join('  ')}</div>`;
  }
  logLine(html);
}

// --- BLE ------------------------------------------------------------------

async function connect() {
  const acceptAll = $('acceptAll').checked;
  const options = acceptAll
    ? { acceptAllDevices: true, optionalServices: CANDIDATE_SERVICES }
    : {
        filters: [
          { namePrefix: 'UT320' },
          { namePrefix: 'UNI-T' },
          { namePrefix: 'UT' },
          { services: [UT_SERVICE] },
        ],
        optionalServices: CANDIDATE_SERVICES,
      };

  device = await navigator.bluetooth.requestDevice(options);
  device.addEventListener('gattserverdisconnected', () => {
    utWriteChar = null;
    setStatus(`Disconnected from ${device.name || device.id}`, false);
  });
  setStatus(`Connecting to ${device.name || device.id}…`, false);
  server = await device.gatt.connect();
  setStatus(`Connected: ${device.name || device.id}`, true);
  await enumerate();
  if (utWriteChar) {
    setStatus(`Connected: ${device.name || device.id}`, true);
    probeHandshake().catch((e) => logLine(`probe error: ${e.message}`, 'frame err'));
  }
}

function onNotification(service, ch, ev) {
  const dv = ev.target.value;
  const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
  const frame = { time: new Date(), serviceUuid: service.uuid, charUuid: ch.uuid, bytes };
  frames.push(frame);
  logFrame(frame);

  if (ch.uuid === UT_NOTIFY_UUID) {
    for (const f of extractUtFrames(bytes)) {
      logFrame({ time: new Date(), serviceUuid: service.uuid, charUuid: ch.uuid, bytes: f }, '✔frame');
      const decoded = decodeFrame(f);
      if (decoded) $('reading').textContent = `${decoded.value} ${decoded.unit}`;
    }
  }
}

async function enumerate() {
  const container = $('services');
  container.textContent = '';
  writableChars.clear();
  utWriteChar = null;

  let services = [];
  try {
    services = await server.getPrimaryServices();
  } catch (e) {
    container.textContent =
      'No services visible. Add the missing UUID to CANDIDATE_SERVICES in ' +
      'app.js. Error: ' + e.message;
    return;
  }

  for (const service of services) {
    const sEl = document.createElement('div');
    sEl.className = 'service';
    const isUt = shortUuid(service.uuid) === '0xFF12';
    sEl.innerHTML = `<strong>Service ${shortUuid(service.uuid)}${isUt ? ' — UT320i data service' : ''}</strong>`;
    container.appendChild(sEl);

    const chars = await service.getCharacteristics();
    for (const ch of chars) {
      const props = Object.entries({
        read: ch.properties.read,
        write: ch.properties.write,
        writeNR: ch.properties.writeWithoutResponse,
        notify: ch.properties.notify,
        indicate: ch.properties.indicate,
      }).filter(([, v]) => v).map(([k]) => k).join(', ');

      const cEl = document.createElement('div');
      cEl.className = 'char';
      const label = UT_CHAR_LABELS[ch.uuid] ? ` ${UT_CHAR_LABELS[ch.uuid]}` : '';
      cEl.textContent = `↳ ${shortUuid(ch.uuid)}${label} [${props}]`;
      sEl.appendChild(cEl);

      if (ch.properties.notify || ch.properties.indicate) {
        try {
          await ch.startNotifications();
          ch.addEventListener('characteristicvaluechanged', (ev) => onNotification(service, ch, ev));
          cEl.textContent += ' — subscribed';
        } catch (e) {
          cEl.textContent += ` — subscribe failed: ${e.message}`;
        }
      }

      if (ch.properties.write || ch.properties.writeWithoutResponse) {
        writableChars.set(ch.uuid, ch);
        if (ch.uuid === UT_WRITE_UUID) utWriteChar = ch;
      }

      if (ch.properties.read) {
        try {
          const dv = await ch.readValue();
          const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
          cEl.textContent += ` = ${hex(bytes)} "${ascii(bytes)}"`;
        } catch { /* some readable chars still reject reads */ }
      }
    }
  }

  const sel = $('writeTarget');
  sel.textContent = '';
  for (const uuid of writableChars.keys()) {
    const opt = document.createElement('option');
    opt.value = uuid;
    opt.textContent = shortUuid(uuid) + (UT_CHAR_LABELS[uuid] ? ` (${UT_CHAR_LABELS[uuid]})` : '');
    if (uuid === UT_WRITE_UUID) opt.selected = true;
    sel.appendChild(opt);
  }
  $('writeBtn').disabled = writableChars.size === 0;
}

function parseHex(text) {
  const bytes = new Uint8Array(text.trim().split(/[\s,]+/).filter(Boolean).map((h) => parseInt(h, 16)));
  if (!bytes.length || Array.from(bytes).some(Number.isNaN)) return null;
  return bytes;
}

async function writeBytes(ch, bytes) {
  if (ch.properties.writeWithoutResponse) {
    await ch.writeValueWithoutResponse(bytes);
  } else {
    await ch.writeValueWithResponse(bytes);
  }
}

// Send each known Smart Measure command until the clamp starts notifying.
async function probeHandshake() {
  if (!utWriteChar) return;
  for (const cmd of PROBE_COMMANDS) {
    const before = frames.length;
    logLine(`→ probing FF01 with ${cmd.label}: ${cmd.hex}`, 'frame tx');
    await writeBytes(utWriteChar, parseHex(cmd.hex));
    await new Promise((r) => setTimeout(r, 1800));
    if (frames.length > before) {
      logLine(`✓ "${cmd.label}" got a response — protocol dialect identified`, 'frame ok');
      return;
    }
  }
  logLine('✗ no probe elicited data. Capture the official app\'s handshake ' +
    'via Android HCI snoop log and replay it in the Write box.', 'frame err');
}

function exportCsv() {
  const rows = [['iso_time', 'service_uuid', 'characteristic_uuid', 'hex']];
  for (const f of frames) {
    rows.push([f.time.toISOString(), f.serviceUuid, f.charUuid, hex(f.bytes)]);
  }
  const blob = new Blob([rows.map((r) => r.join(',')).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ut320i-frames-${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// --- Wiring ---------------------------------------------------------------

if (!navigator.bluetooth) {
  $('unsupported').classList.remove('hidden');
  $('connect').disabled = true;
}

const presetSel = $('presets');
for (const cmd of PROBE_COMMANDS) {
  const opt = document.createElement('option');
  opt.value = cmd.hex;
  opt.textContent = cmd.label;
  presetSel.appendChild(opt);
}
presetSel.addEventListener('change', () => { $('writeHex').value = presetSel.value; });

$('connect').addEventListener('click', () =>
  connect().catch((e) => setStatus(`Error: ${e.message}`, false)));
$('disconnect').addEventListener('click', () => device?.gatt.disconnect());
$('probe').addEventListener('click', () =>
  probeHandshake().catch((e) => logLine(`probe error: ${e.message}`, 'frame err')));
$('writeBtn').addEventListener('click', () => {
  const ch = writableChars.get($('writeTarget').value);
  const bytes = parseHex($('writeHex').value);
  if (!ch || !bytes) { alert('Enter hex bytes like: ab cd 04 00 0a 01 16 00'); return; }
  logLine(`→ write ${shortUuid(ch.uuid)}: ${hex(bytes)}`, 'frame tx');
  writeBytes(ch, bytes).catch((e) => alert(`Write failed: ${e.message}`));
});
$('clearLog').addEventListener('click', () => { $('log').textContent = ''; });
$('exportCsv').addEventListener('click', exportCsv);
