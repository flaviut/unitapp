'use strict';

// ---------------------------------------------------------------------------
// UT320i HVAC thermometer over Web Bluetooth.
//
// Wire protocol (verified against captures from two units):
//   AA BB <len u8> <cmd u8> <payload...> <checksum u16 BE>
//     len      = byte count after the len field (cmd + payload + checksum)
//     checksum = additive sum of all bytes from the AA header through payload
//   cmd 0x01 (len 0x14): live measurement — 8 reserved bytes, float32 LE
//     temperature in °C, 4 reserved bytes, 1 status byte
//   The clamp is silent until a command is written to FF01; the UT171-style
//   START frame wakes it, then live frames arrive ~every 1.3 s.
// ---------------------------------------------------------------------------

const UT_SERVICE = 0xff12;
const UT_WRITE_UUID = '0000ff01-0000-1000-8000-00805f9b34fb';
const UT_NOTIFY_UUID = '0000ff02-0000-1000-8000-00805f9b34fb';
const UT_NAME_UUID = '0000ff06-0000-1000-8000-00805f9b34fb';

const PROBE_COMMANDS = [
  { label: 'START stream (UT171)', hex: 'ab cd 04 00 0a 01 16 00' },
  { label: 'live-data poll (UT219P)', hex: 'ab cd 00 04 05 00 09 00' },
  { label: 'device info (UT171)', hex: 'ab cd 04 00 16 5a 7b 00' },
  { label: 'device info (UT219P)', hex: 'ab cd 00 04 17 00 1b 00' },
];

const CANDIDATE_SERVICES = [
  UT_SERVICE,
  'battery_service',
  'device_information',
  'generic_access',
  '0000d0ff-3c17-d293-8e48-14fe2e4da212', // Realtek OTA
];

const COLORS = ['#0a66c2', '#d92d20', '#1a7f37', '#b54708', '#7a5af8', '#0e7090'];
const CHART_WINDOW_MS = 10 * 60 * 1000;

const $ = (id) => document.getElementById(id);

// Each clamp: {device, server, writeChar, name, color, rxBuffer, readings:[{t,c}],
//             latest, connected, el:{card, reading, stats, conn, reconnect}}
const clamps = [];
// Session-wide logs that survive clamp removal.
const readingsLog = []; // {t, name, c}
const framesLog = [];   // {t, name, bytes}
let unit = localStorage.getItem('ut320i-unit') || 'F';
let wakeLock = null;

// --- Protocol -------------------------------------------------------------

function decodeFrame(bytes) {
  if (bytes[3] !== 0x01 || bytes.length < 21) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const c = view.getFloat32(12, true);
  if (!Number.isFinite(c) || c < -60 || c > 400) return null;
  return { c };
}

function extractUtFrames(clamp, chunk) {
  const merged = new Uint8Array(clamp.rxBuffer.length + chunk.length);
  merged.set(clamp.rxBuffer);
  merged.set(chunk, clamp.rxBuffer.length);
  clamp.rxBuffer = merged;

  const found = [];
  let buf = clamp.rxBuffer;
  while (true) {
    let start = -1;
    for (let i = 0; i + 1 < buf.length; i++) {
      if (buf[i] === 0xaa && buf[i + 1] === 0xbb) { start = i; break; }
    }
    if (start < 0) { buf = buf.slice(Math.max(0, buf.length - 1)); break; }
    if (start > 0) buf = buf.slice(start);
    if (buf.length < 4) break;

    const len = buf[2];
    const total = 3 + len;
    if (len < 3 || len > 250) { buf = buf.slice(2); continue; }
    if (buf.length < total) break;

    let sum = 0;
    for (let i = 0; i < total - 2; i++) sum = (sum + buf[i]) & 0xffff;
    const chk = (buf[total - 2] << 8) | buf[total - 1];
    if (sum === chk) {
      found.push(buf.slice(0, total));
      buf = buf.slice(total);
    } else {
      buf = buf.slice(2);
    }
  }
  clamp.rxBuffer = buf;
  return found;
}

// --- Formatting -----------------------------------------------------------

const cToF = (c) => c * 9 / 5 + 32;
const fmtAbs = (c) => unit === 'F' ? `${cToF(c).toFixed(2)} °F` : `${c.toFixed(2)} °C`;
const fmtDelta = (dc) => unit === 'F' ? `${(dc * 9 / 5).toFixed(2)} °F` : `${dc.toFixed(2)} °C`;

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

function shortName(name) {
  // "UT320i SN:260500277" → "SN:…0277" keeps cards compact but unambiguous.
  const m = /SN:(\d+)/.exec(name || '');
  return m ? `Clamp …${m[1].slice(-4)}` : (name || 'Clamp');
}

// --- Debug log ------------------------------------------------------------

function logLine(html, cls = 'frame') {
  const el = document.createElement('div');
  el.className = cls;
  el.innerHTML = html;
  const log = $('log');
  log.appendChild(el);
  while (log.childElementCount > 400) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

function logHex(name, bytes, tag, cls = 'frame') {
  logLine(`<span class="t">${new Date().toISOString().slice(11, 23)}</span> ` +
    `<span class="u">${name} ${tag}</span> <span class="hex">${hex(bytes)}</span>`, cls);
}

// --- Clamp cards ----------------------------------------------------------

function makeCard(clamp) {
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML =
    `<div class="card-head">
       <span class="dot" style="background:${clamp.color}"></span>
       <span class="name">${clamp.name}</span>
       <span class="conn">connecting…</span>
       <span class="spacer"></span>
       <button class="small reconnect hidden">Reconnect</button>
       <button class="small remove" title="Remove">✕</button>
     </div>
     <div class="reading">–</div>
     <div class="hint stats"></div>`;
  $('clamps').appendChild(card);
  clamp.el = {
    card,
    name: card.querySelector('.name'),
    conn: card.querySelector('.conn'),
    reading: card.querySelector('.reading'),
    stats: card.querySelector('.stats'),
    reconnect: card.querySelector('.reconnect'),
  };
  card.querySelector('.remove').addEventListener('click', () => removeClamp(clamp));
  clamp.el.reconnect.addEventListener('click', () =>
    setupClamp(clamp).catch((e) => setConn(clamp, `error: ${e.message}`, false)));
}

function setConn(clamp, text, connected) {
  clamp.connected = connected;
  clamp.el.conn.textContent = text;
  clamp.el.conn.classList.toggle('ok', connected);
  clamp.el.reconnect.classList.toggle('hidden', connected);
}

function removeClamp(clamp) {
  try { clamp.device.gatt.disconnect(); } catch { /* already gone */ }
  clamp.removed = true;
  clamp.el.card.remove();
  clamps.splice(clamps.indexOf(clamp), 1);
  updateDelta();
  drawChart();
  refreshWriteTargets();
}

function renderClamp(clamp) {
  const last = clamp.readings[clamp.readings.length - 1];
  if (!last) return;
  clamp.el.reading.textContent = fmtAbs(last.c);
  const cs = clamp.readings.map((r) => r.c);
  const min = Math.min(...cs), max = Math.max(...cs);
  clamp.el.stats.textContent =
    `min ${fmtAbs(min)} · max ${fmtAbs(max)} · ${cs.length} samples`;
}

function updateDelta() {
  const live = clamps.filter((c) => c.readings.length);
  if (live.length < 2) { $('deltaPanel').classList.add('hidden'); return; }
  const [a, b] = live;
  const dc = a.readings[a.readings.length - 1].c - b.readings[b.readings.length - 1].c;
  $('deltaPanel').classList.remove('hidden');
  $('delta').textContent = fmtDelta(dc);
  $('deltaHint').textContent = `${a.name} − ${b.name}`;
}

function renderAll() {
  clamps.forEach(renderClamp);
  updateDelta();
  drawChart();
}

// --- Chart ----------------------------------------------------------------

function drawChart() {
  const canvas = $('chart');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const now = Date.now();
  const from = now - CHART_WINDOW_MS;
  const series = clamps
    .map((c) => ({ color: c.color, pts: c.readings.filter((r) => r.t >= from) }))
    .filter((s) => s.pts.length > 1);
  if (!series.length) return;

  const all = series.flatMap((s) => s.pts.map((p) => p.c));
  let lo = Math.min(...all), hi = Math.max(...all);
  const pad = Math.max((hi - lo) * 0.1, 0.15);
  lo -= pad; hi += pad;

  const x = (t) => 34 + ((t - from) / CHART_WINDOW_MS) * (w - 38);
  const y = (v) => h - 16 - ((v - lo) / (hi - lo)) * (h - 24);

  const style = getComputedStyle(document.documentElement);
  ctx.strokeStyle = style.getPropertyValue('--border').trim() || '#ccc';
  ctx.lineWidth = 1;
  ctx.strokeRect(34, 8, w - 38, h - 24);

  ctx.fillStyle = style.getPropertyValue('--muted').trim() || '#777';
  ctx.font = '10px system-ui';
  const label = (c) => unit === 'F' ? cToF(c).toFixed(1) : c.toFixed(1);
  ctx.fillText(label(hi - pad), 2, y(hi - pad) + 3);
  ctx.fillText(label(lo + pad), 2, y(lo + pad) + 3);

  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    s.pts.forEach((p, i) => (i ? ctx.lineTo(x(p.t), y(p.c)) : ctx.moveTo(x(p.t), y(p.c))));
    ctx.stroke();
  }
}

// --- BLE ------------------------------------------------------------------

async function addClamp() {
  const device = await navigator.bluetooth.requestDevice({
    filters: [
      { namePrefix: 'UT320' },
      { namePrefix: 'UNI-T' },
      { namePrefix: 'UT' },
      { services: [UT_SERVICE] },
    ],
    optionalServices: CANDIDATE_SERVICES,
  });

  let clamp = clamps.find((c) => c.device.id === device.id);
  if (!clamp) {
    clamp = {
      device,
      name: shortName(device.name),
      fullName: device.name || device.id,
      color: COLORS[clamps.length % COLORS.length],
      rxBuffer: new Uint8Array(0),
      readings: [],
      connected: false,
    };
    clamps.push(clamp);
    makeCard(clamp);
    device.addEventListener('gattserverdisconnected', () => {
      if (!clamp.removed) setConn(clamp, 'disconnected', false);
    });
  }
  await setupClamp(clamp);
}

async function setupClamp(clamp) {
  setConn(clamp, 'connecting…', false);
  clamp.server = await clamp.device.gatt.connect();
  const service = await clamp.server.getPrimaryService(UT_SERVICE);
  const chars = await service.getCharacteristics();
  clamp.writeChar = chars.find((ch) => ch.uuid === UT_WRITE_UUID) || null;
  const notifyChar = chars.find((ch) => ch.uuid === UT_NOTIFY_UUID);
  const nameChar = chars.find((ch) => ch.uuid === UT_NAME_UUID);

  if (nameChar?.properties.read) {
    try {
      const dv = await nameChar.readValue();
      clamp.fullName = ascii(new Uint8Array(dv.buffer));
      clamp.name = shortName(clamp.fullName);
      clamp.el.name.textContent = clamp.name;
      clamp.el.name.title = clamp.fullName;
    } catch { /* keep advertised name */ }
  }

  if (!notifyChar) throw new Error('FF02 notify characteristic not found');
  await notifyChar.startNotifications();
  if (!clamp.notifyHooked) {
    clamp.notifyHooked = true;
    notifyChar.addEventListener('characteristicvaluechanged', (ev) => onNotification(clamp, ev));
  }

  setConn(clamp, 'connected', true);
  refreshWriteTargets();
  probeHandshake(clamp).catch((e) => logLine(`${clamp.name} probe error: ${e.message}`, 'frame err'));
}

function onNotification(clamp, ev) {
  const dv = ev.target.value;
  const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
  const t = Date.now();
  framesLog.push({ t, name: clamp.fullName, bytes });
  if (framesLog.length > 5000) framesLog.shift();
  if ($('showRaw').checked) logHex(clamp.name, bytes, 'raw');

  for (const f of extractUtFrames(clamp, bytes)) {
    const decoded = decodeFrame(f);
    if (decoded) {
      clamp.readings.push({ t, c: decoded.c });
      if (clamp.readings.length > 4000) clamp.readings.shift();
      readingsLog.push({ t, name: clamp.fullName, c: decoded.c });
      renderClamp(clamp);
      updateDelta();
      drawChart();
    } else {
      logHex(clamp.name, f, `cmd 0x${f[3].toString(16).padStart(2, '0')}`, 'frame ok');
    }
  }
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

async function probeHandshake(clamp) {
  if (!clamp.writeChar) return;
  for (const cmd of PROBE_COMMANDS) {
    const before = clamp.readings.length;
    logLine(`→ ${clamp.name}: ${cmd.label} (${cmd.hex})`, 'frame tx');
    await writeBytes(clamp.writeChar, parseHex(cmd.hex));
    await new Promise((r) => setTimeout(r, 1800));
    if (clamp.readings.length > before) return;
  }
  logLine(`✗ ${clamp.name}: no probe elicited data — try Reconnect.`, 'frame err');
}

// --- Debug: GATT dump & manual writes ------------------------------------

async function dumpGatt() {
  const container = $('services');
  container.textContent = clamps.length ? '' : 'No clamps connected.';
  for (const clamp of clamps.filter((c) => c.connected)) {
    const head = document.createElement('div');
    head.innerHTML = `<strong>${clamp.fullName}</strong>`;
    container.appendChild(head);
    let services = [];
    try { services = await clamp.server.getPrimaryServices(); } catch (e) {
      head.innerHTML += ` — ${e.message}`;
      continue;
    }
    for (const service of services) {
      const sEl = document.createElement('div');
      sEl.className = 'service';
      sEl.innerHTML = `<strong>Service ${shortUuid(service.uuid)}</strong>`;
      container.appendChild(sEl);
      for (const ch of await service.getCharacteristics()) {
        const props = ['read', 'write', 'writeWithoutResponse', 'notify', 'indicate']
          .filter((p) => ch.properties[p]).join(', ');
        const cEl = document.createElement('div');
        cEl.className = 'char';
        cEl.textContent = `↳ ${shortUuid(ch.uuid)} [${props}]`;
        sEl.appendChild(cEl);
        if (ch.properties.read) {
          try {
            const dv = await ch.readValue();
            const bytes = new Uint8Array(dv.buffer);
            cEl.textContent += ` = ${hex(bytes)} "${ascii(bytes)}"`;
          } catch { /* unreadable */ }
        }
      }
    }
  }
}

function refreshWriteTargets() {
  const sel = $('writeTarget');
  sel.textContent = '';
  clamps.forEach((clamp, i) => {
    if (clamp.writeChar && clamp.connected) {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = `${clamp.name} FF01`;
      sel.appendChild(opt);
    }
  });
  $('writeBtn').disabled = sel.childElementCount === 0;
}

// --- Export / copy --------------------------------------------------------

function readingsCsv() {
  const rows = [['iso_time', 'clamp', 'temp_c', 'temp_f']];
  for (const r of readingsLog) {
    rows.push([new Date(r.t).toISOString(), r.name, r.c.toFixed(3), cToF(r.c).toFixed(3)]);
  }
  return rows.map((r) => r.join(',')).join('\n');
}

function framesCsv() {
  const rows = [['iso_time', 'clamp', 'hex']];
  for (const f of framesLog) {
    rows.push([new Date(f.t).toISOString(), f.name, hex(f.bytes)]);
  }
  return rows.map((r) => r.join(',')).join('\n');
}

function diagText() {
  const build = document.querySelector('footer code')?.textContent || '?';
  const lines = [
    `UT320i app diagnostics — build ${build} — ${new Date().toISOString()}`,
    `UA: ${navigator.userAgent}`,
    `Clamps (${clamps.length}):`,
    ...clamps.map((c) => {
      const last = c.readings[c.readings.length - 1];
      return `  - ${c.fullName} | ${c.connected ? 'connected' : 'disconnected'} | ` +
        `${c.readings.length} samples${last ? ` | last ${last.c.toFixed(3)} °C` : ''}`;
    }),
    `Last raw frames (up to 30):`,
    ...framesLog.slice(-30).map((f) => `  ${new Date(f.t).toISOString()} ${f.name}: ${hex(f.bytes)}`),
  ];
  return lines.join('\n');
}

function download(text, name) {
  const blob = new Blob([text], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const old = btn.textContent;
    btn.textContent = 'Copied ✓';
    setTimeout(() => { btn.textContent = old; }, 1500);
  } catch (e) {
    alert(`Copy failed (${e.message}) — use the download button instead.`);
  }
}

// --- Wake lock ------------------------------------------------------------

async function setAwake(on) {
  if (on) {
    try { wakeLock = await navigator.wakeLock.request('screen'); }
    catch (e) { alert(`Keep-awake unavailable: ${e.message}`); $('keepAwake').checked = false; }
  } else {
    wakeLock?.release();
    wakeLock = null;
  }
}
document.addEventListener('visibilitychange', () => {
  if ($('keepAwake').checked && document.visibilityState === 'visible') setAwake(true);
});

// --- Wiring ---------------------------------------------------------------

if (!navigator.bluetooth) {
  $('unsupported').classList.remove('hidden');
  $('connect').disabled = true;
}

function setUnit(u) {
  unit = u;
  localStorage.setItem('ut320i-unit', u);
  document.querySelectorAll('#unitToggle button').forEach((b) =>
    b.classList.toggle('active', b.dataset.unit === u));
  renderAll();
}
document.querySelectorAll('#unitToggle button').forEach((b) =>
  b.addEventListener('click', () => setUnit(b.dataset.unit)));
setUnit(unit);

const presetSel = $('presets');
for (const cmd of PROBE_COMMANDS) {
  const opt = document.createElement('option');
  opt.value = cmd.hex;
  opt.textContent = cmd.label;
  presetSel.appendChild(opt);
}
presetSel.addEventListener('change', () => { $('writeHex').value = presetSel.value; });

$('connect').addEventListener('click', () =>
  addClamp().catch((e) => {
    if (e.name !== 'NotFoundError') $('status').textContent = `Error: ${e.message}`;
  }));
$('keepAwake').addEventListener('change', (e) => setAwake(e.target.checked));
$('resetSession').addEventListener('click', () => {
  clamps.forEach((c) => { c.readings = []; c.el.reading.textContent = '–'; c.el.stats.textContent = ''; });
  readingsLog.length = 0;
  updateDelta();
  drawChart();
});
$('exportReadings').addEventListener('click', () =>
  download(readingsCsv(), `ut320i-readings-${Date.now()}.csv`));
$('copyReadings').addEventListener('click', (e) => copyText(readingsCsv(), e.target));
$('exportCsv').addEventListener('click', () =>
  download(framesCsv(), `ut320i-frames-${Date.now()}.csv`));
$('copyFrames').addEventListener('click', (e) => copyText(framesCsv(), e.target));
$('copyDiag').addEventListener('click', (e) => copyText(diagText(), e.target));
$('dumpGatt').addEventListener('click', () =>
  dumpGatt().catch((e) => { $('services').textContent = `Dump failed: ${e.message}`; }));
$('writeBtn').addEventListener('click', () => {
  const clamp = clamps[Number($('writeTarget').value)];
  const bytes = parseHex($('writeHex').value);
  if (!clamp?.writeChar || !bytes) { alert('Enter hex bytes like: ab cd 04 00 0a 01 16 00'); return; }
  logHex(clamp.name, bytes, '→ write', 'frame tx');
  writeBytes(clamp.writeChar, bytes).catch((e) => alert(`Write failed: ${e.message}`));
});

// Redraw the rolling window even when no new data arrives.
setInterval(drawChart, 5000);
