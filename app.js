'use strict';

// ---------------------------------------------------------------------------
// UT320i Web Bluetooth explorer
//
// The UT320i's BLE protocol is not publicly documented, so this app starts as
// a protocol explorer: it connects, enumerates every service/characteristic it
// is allowed to see, subscribes to all notify characteristics, and hex-dumps
// each frame. For every frame it also prints "candidate" int16 interpretations
// so the temperature bytes stand out (change the clamp temperature and watch
// which candidate tracks it). Once the format is known, fill in decodeFrame().
// ---------------------------------------------------------------------------

// Web Bluetooth only exposes services listed here. Cast a wide net: standard
// sensor services plus vendor UART-style services used across UNI-T and the
// common BLE modules (JDY/HM-10, WCH, TI, Nordic, Microchip).
const CANDIDATE_SERVICES = [
  'battery_service',
  'device_information',
  'environmental_sensing',
  'health_thermometer',
  'generic_access',
  0xFFE0, // JDY-xx / HM-10 UART
  0xFFF0, // WCH / common vendor UART
  0xFF12, // seen on UNI-T BLE meters
  0xFFB0,
  0xFFE5,
  0xAE00, // seen on some UNI-T devices
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART
  '49535343-fe7d-4ae5-8fa9-9fafd205e455', // Microchip Transparent UART
];

const $ = (id) => document.getElementById(id);

let device = null;
let server = null;
// [{time, serviceUuid, charUuid, bytes}]
const frames = [];
// charUuid -> BluetoothRemoteGATTCharacteristic (writable)
const writableChars = new Map();

// --- Decoding -------------------------------------------------------------

// TODO: fill in once the frame format is known. Return {value, unit} or null.
// Typical UNI-T patterns to try first: a fixed header (e.g. 0xAB 0xCD), then a
// little-endian int16 temperature scaled by 10 or 100, plus battery/flags.
function decodeFrame(bytes) {
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
        out.push(`@${off} i16le${label}=${v.toFixed(scale === 10 ? 1 : 2)}`);
      }
    }
  }
  return out;
}

// --- UI helpers -----------------------------------------------------------

function setStatus(text, connected) {
  $('status').textContent = text;
  $('status').classList.toggle('connected', !!connected);
  $('connect').disabled = !!connected;
  $('disconnect').disabled = !connected;
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

function logFrame(frame) {
  const el = document.createElement('div');
  el.className = 'frame';
  const t = frame.time.toISOString().slice(11, 23);
  let html = `<span class="t">${t}</span> <span class="u">${shortUuid(frame.charUuid)}</span> ` +
    `<span class="hex">${hex(frame.bytes)}</span> <span class="ascii">${ascii(frame.bytes)}</span>`;
  if ($('showCandidates').checked) {
    const cands = candidateValues(frame.bytes);
    if (cands.length) html += `<div class="cands">${cands.join('  ')}</div>`;
  }
  el.innerHTML = html;
  const log = $('log');
  log.appendChild(el);
  // Keep the DOM bounded; full history stays in `frames` for CSV export.
  while (log.childElementCount > 500) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

// --- BLE ------------------------------------------------------------------

async function connect() {
  const acceptAll = $('acceptAll').checked;
  const options = acceptAll
    ? { acceptAllDevices: true, optionalServices: CANDIDATE_SERVICES }
    : {
        filters: [
          { namePrefix: 'UT320' },
          { namePrefix: 'UT-320' },
          { namePrefix: 'UNI-T' },
          { namePrefix: 'UT' },
        ],
        optionalServices: CANDIDATE_SERVICES,
      };

  device = await navigator.bluetooth.requestDevice(options);
  device.addEventListener('gattserverdisconnected', () => {
    setStatus(`Disconnected from ${device.name || device.id}`, false);
  });
  setStatus(`Connecting to ${device.name || device.id}…`, false);
  server = await device.gatt.connect();
  setStatus(`Connected: ${device.name || device.id}`, true);
  await enumerate();
}

async function enumerate() {
  const container = $('services');
  container.textContent = '';
  writableChars.clear();

  let services = [];
  try {
    services = await server.getPrimaryServices();
  } catch (e) {
    container.textContent =
      'No services visible. The device may use a service UUID not in ' +
      'CANDIDATE_SERVICES (app.js) — find the real UUID with nRF Connect ' +
      'on Android and add it. Error: ' + e.message;
    return;
  }

  for (const service of services) {
    const sEl = document.createElement('div');
    sEl.className = 'service';
    sEl.innerHTML = `<strong>Service ${shortUuid(service.uuid)}</strong>`;
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
      cEl.textContent = `↳ ${shortUuid(ch.uuid)} [${props}]`;
      sEl.appendChild(cEl);

      if (ch.properties.notify || ch.properties.indicate) {
        try {
          await ch.startNotifications();
          ch.addEventListener('characteristicvaluechanged', (ev) => {
            const dv = ev.target.value;
            const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
            const frame = { time: new Date(), serviceUuid: service.uuid, charUuid: ch.uuid, bytes };
            frames.push(frame);
            logFrame(frame);
            const decoded = decodeFrame(bytes);
            if (decoded) $('reading').textContent = `${decoded.value} ${decoded.unit}`;
          });
          cEl.textContent += ' — subscribed';
        } catch (e) {
          cEl.textContent += ` — subscribe failed: ${e.message}`;
        }
      }

      if (ch.properties.write || ch.properties.writeWithoutResponse) {
        writableChars.set(ch.uuid, ch);
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
    opt.textContent = shortUuid(uuid);
    sel.appendChild(opt);
  }
  $('writeBtn').disabled = writableChars.size === 0;
}

async function writeHex() {
  const ch = writableChars.get($('writeTarget').value);
  if (!ch) return;
  const text = $('writeHex').value.trim();
  const bytes = new Uint8Array(text.split(/[\s,]+/).filter(Boolean).map((h) => parseInt(h, 16)));
  if (!bytes.length || Array.from(bytes).some(Number.isNaN)) {
    alert('Enter hex bytes like: ab cd 04 5e 01 d9');
    return;
  }
  if (ch.properties.writeWithoutResponse && !ch.properties.write) {
    await ch.writeValueWithoutResponse(bytes);
  } else {
    await ch.writeValueWithResponse(bytes);
  }
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

$('connect').addEventListener('click', () =>
  connect().catch((e) => setStatus(`Error: ${e.message}`, false)));
$('disconnect').addEventListener('click', () => device?.gatt.disconnect());
$('writeBtn').addEventListener('click', () =>
  writeHex().catch((e) => alert(`Write failed: ${e.message}`)));
$('clearLog').addEventListener('click', () => { $('log').textContent = ''; });
$('exportCsv').addEventListener('click', exportCsv);
