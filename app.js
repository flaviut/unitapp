'use strict';

// ---------------------------------------------------------------------------
// UT320i Web Bluetooth app
//
// GATT layout (confirmed on two units, SN:251101079 and SN:260500277):
//
//   Service 0xFF12 (vendor, Realtek chip)
//     FF01 [write-no-response]  command channel
//     FF02 [notify]             data channel — silent until commanded
//     FF03..FF0B [read/write]   config registers (FF05 = user id,
//                               FF06 = device name)
//
// Wire protocol (decoded from live captures, checksum verified on 8 frames):
//
//   AA BB <len u8> <cmd u8> <payload...> <checksum u16 BE>
//     len      = byte count after the len field (cmd + payload + checksum)
//     checksum = additive sum of all bytes from the AA header through the
//                end of payload, big-endian
//
//   cmd 0x01 (len 0x14): live measurement
//     payload: 8 reserved/zero bytes, float32 LE temperature in °C,
//              4 reserved/zero bytes, 1 status byte (0xF3 observed)
//   cmd 0x08 (payload 04 04) and cmd 0x06: status/info responses seen
//     right after the handshake probe
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

// Writing these wakes the stream (frames cmd 0x08/0x06 come back as
// responses, then cmd 0x01 live data flows ~every 1.3 s). Borrowed from the
// UT171/UT219P dialect; the clamp answers in its own AA BB framing.
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
  'generic_access',
  '0000d0ff-3c17-d293-8e48-14fe2e4da212', // Realtek OTA (on the UT320i)
];

const $ = (id) => document.getElementById(id);

let device = null;
let server = null;
let utWriteChar = null;
// [{time, serviceUuid, charUuid, bytes}]
const frames = [];
// [{time, c}] decoded temperature readings
const readings = [];
// charUuid -> writable BluetoothRemoteGATTCharacteristic
const writableChars = new Map();
let rxBuffer = new Uint8Array(0);

// --- Protocol -------------------------------------------------------------

// Parse one validated AA BB frame into a reading, or null.
function decodeFrame(bytes) {
  if (bytes[3] !== 0x01 || bytes.length < 21) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const c = view.getFloat32(12, true);
  if (!Number.isFinite(c) || c < -60 || c > 400) return null;
  return { c, status: bytes.length >= 22 ? bytes[20] : null };
}

// Reassemble AA BB frames that may span notifications; drop checksum failures.
function extractUtFrames(chunk) {
  const merged = new Uint8Array(rxBuffer.length + chunk.length);
  merged.set(rxBuffer);
  merged.set(chunk, rxBuffer.length);
  rxBuffer = merged;

  const found = [];
  while (true) {
    let start = -1;
    for (let i = 0; i + 1 < rxBuffer.length; i++) {
      if (rxBuffer[i] === 0xaa && rxBuffer[i + 1] === 0xbb) { start = i; break; }
    }
    if (start < 0) {
      if (rxBuffer.length > 1) rxBuffer = rxBuffer.slice(rxBuffer.length - 1);
      break;
    }
    if (start > 0) rxBuffer = rxBuffer.slice(start);
    if (rxBuffer.length < 4) break;

    const len = rxBuffer[2];
    const total = 3 + len;
    if (len < 3 || len > 250) { rxBuffer = rxBuffer.slice(2); continue; }
    if (rxBuffer.length < total) break;

    let sum = 0;
    for (let i = 0; i < total - 2; i++) sum = (sum + rxBuffer[i]) & 0xffff;
    const chk = (rxBuffer[total - 2] << 8) | rxBuffer[total - 1];
    if (sum === chk) {
      found.push(rxBuffer.slice(0, total));
      rxBuffer = rxBuffer.slice(total);
    } else {
      rxBuffer = rxBuffer.slice(2);
    }
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
  if (!$('showRaw').checked) return;
  const t = frame.time.toISOString().slice(11, 23);
  logLine(`<span class="t">${t}</span> <span class="u">${tag || shortUuid(frame.charUuid)}</span> ` +
    `<span class="hex">${hex(frame.bytes)}</span> <span class="ascii">${ascii(frame.bytes)}</span>`);
}

// --- Live reading display -------------------------------------------------

function pushReading(r, time) {
  readings.push({ time, c: r.c });
  const f = r.c * 9 / 5 + 32;
  $('reading').innerHTML =
    `${r.c.toFixed(2)}<span class="unit">°C</span> <span class="alt">${f.toFixed(1)} °F</span>`;

  const cs = readings.map((x) => x.c);
  const min = Math.min(...cs), max = Math.max(...cs);
  const avg = cs.reduce((a, x) => a + x, 0) / cs.length;
  $('stats').textContent =
    `min ${min.toFixed(2)} · avg ${avg.toFixed(2)} · max ${max.toFixed(2)} °C · ${cs.length} samples`;
  drawChart(cs, min, max);
}

function drawChart(cs, min, max) {
  const canvas = $('chart');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const n = Math.min(cs.length, 900);
  const data = cs.slice(-n);
  const lo = min - 0.2, hi = max + 0.2;
  const x = (i) => (n <= 1 ? w : (i / (n - 1)) * (w - 4) + 2);
  const y = (v) => h - 4 - ((v - lo) / (hi - lo)) * (h - 8);

  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#0a66c2';
  ctx.lineWidth = 2;
  ctx.beginPath();
  data.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.stroke();
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
  const time = new Date();
  frames.push({ time, serviceUuid: service.uuid, charUuid: ch.uuid, bytes });
  logFrame({ time, charUuid: ch.uuid, bytes });

  if (ch.uuid !== UT_NOTIFY_UUID) return;
  for (const f of extractUtFrames(bytes)) {
    const decoded = decodeFrame(f);
    if (decoded) {
      pushReading(decoded, time);
    } else {
      // Non-measurement frame (status/info) — always show these.
      logLine(`<span class="t">${time.toISOString().slice(11, 23)}</span> ` +
        `<span class="u">cmd 0x${f[3].toString(16).padStart(2, '0')}</span> ` +
        `<span class="hex">${hex(f)}</span>`, 'frame ok');
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

// Send wake-up commands until live data flows.
async function probeHandshake() {
  if (!utWriteChar) return;
  for (const cmd of PROBE_COMMANDS) {
    const before = readings.length + frames.length;
    logLine(`→ probing FF01 with ${cmd.label}: ${cmd.hex}`, 'frame tx');
    await writeBytes(utWriteChar, parseHex(cmd.hex));
    await new Promise((r) => setTimeout(r, 1800));
    if (readings.length + frames.length > before) {
      logLine('✓ clamp is streaming', 'frame ok');
      return;
    }
  }
  logLine('✗ no probe elicited data — try again or use the Write box.', 'frame err');
}

function downloadCsv(rows, name) {
  const blob = new Blob([rows.map((r) => r.join(',')).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
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
$('resetStats').addEventListener('click', () => {
  readings.length = 0;
  $('stats').textContent = '';
  $('reading').textContent = '–';
  const ctx = $('chart').getContext('2d');
  ctx.clearRect(0, 0, $('chart').width, $('chart').height);
});
$('exportReadings').addEventListener('click', () =>
  downloadCsv(
    [['iso_time', 'temp_c'], ...readings.map((r) => [r.time.toISOString(), r.c.toFixed(3)])],
    `ut320i-readings-${Date.now()}.csv`));
$('exportCsv').addEventListener('click', () =>
  downloadCsv(
    [['iso_time', 'service_uuid', 'characteristic_uuid', 'hex'],
     ...frames.map((f) => [f.time.toISOString(), f.serviceUuid, f.charUuid, hex(f.bytes)])],
    `ut320i-frames-${Date.now()}.csv`));
