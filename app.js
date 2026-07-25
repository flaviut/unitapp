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

// UT171-family START frame — the only command the clamp needs (see README).
const START_CMD = Uint8Array.of(0xab, 0xcd, 0x04, 0x00, 0x0a, 0x01, 0x16, 0x00);

const COLORS = ['#0a66c2', '#d92d20', '#1a7f37', '#b54708', '#7a5af8', '#0e7090'];
const CHART_WINDOW_MS = 10 * 60 * 1000;

const $ = (id) => document.getElementById(id);

// Each clamp: {device, server, writeChar, name, color, rxBuffer, readings:[{t,c}],
//             connected, el:{card, name, conn, reading}}
const clamps = [];
const framesLog = []; // {t, name, bytes} — last raw frames, for diagnostics
let unit = localStorage.getItem('ut320i-unit') || 'F';
let wakeLock = null;

// --- Protocol -------------------------------------------------------------

function decodeFrame(bytes) {
  if (bytes[3] !== 0x01 || bytes.length < 21) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const c = view.getFloat32(12, true);
  if (!Number.isFinite(c) || c < -60 || c > 400) return null;
  return { c, status: bytes.length >= 23 ? bytes[20] : null };
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

// One decimal everywhere: the clamp itself is only good to about a degree,
// and nobody in an attic cares about hundredths.
const cToF = (c) => c * 9 / 5 + 32;
const fmtAbs = (c) => unit === 'F' ? `${cToF(c).toFixed(1)} °F` : `${c.toFixed(1)} °C`;
const fmtDelta = (dc) => unit === 'F' ? `${(dc * 9 / 5).toFixed(1)} °F` : `${dc.toFixed(1)} °C`;

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');
}

function ascii(bytes) {
  return Array.from(bytes, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '·')).join('');
}

function shortName(name) {
  // "UT320i SN:260500277" → "SN:…0277" keeps cards compact but unambiguous.
  const m = /SN:(\d+)/.exec(name || '');
  return m ? `Clamp …${m[1].slice(-4)}` : (name || 'Clamp');
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
       <button class="small remove" title="Remove">✕</button>
     </div>
     <div class="reading">–</div>`;
  $('clamps').appendChild(card);
  clamp.el = {
    card,
    name: card.querySelector('.name'),
    conn: card.querySelector('.conn'),
    reading: card.querySelector('.reading'),
  };
  card.querySelector('.remove').addEventListener('click', () => removeClamp(clamp));
}

function setConn(clamp, text, connected) {
  clamp.connected = connected;
  clamp.el.conn.textContent = text;
  clamp.el.conn.classList.toggle('ok', connected);
}

function removeClamp(clamp) {
  clamp.removed = true;
  rememberDevice(clamp.device.id, false);
  try { clamp.device.gatt.disconnect(); } catch { /* already gone */ }
  clamp.el.card.remove();
  clamps.splice(clamps.indexOf(clamp), 1);
  updateDelta();
  drawChart();
  refreshClampSelects();
  syncWakeLock();
}

function renderClamp(clamp) {
  const last = clamp.readings[clamp.readings.length - 1];
  if (!last) return;
  clamp.el.reading.textContent = fmtAbs(last.c);
}

function updateDelta() {
  const live = clamps.filter((c) => c.readings.length);
  if (live.length >= 2) {
    const [a, b] = live;
    const dc = a.readings[a.readings.length - 1].c - b.readings[b.readings.length - 1].c;
    $('deltaPanel').classList.remove('hidden');
    $('delta').textContent = fmtDelta(dc);
    $('deltaHint').textContent = `${a.name} − ${b.name}`;
  } else {
    $('deltaPanel').classList.add('hidden');
  }
  updateShSc();
}

// --- Superheat / subcool --------------------------------------------------
//
// Saturation tables generated with CoolProp 8.0 (NIST-grade Helmholtz
// equations of state; R410A pseudo-pure, R454B as HEOS mixture), −40…150 °F
// in 5 °F steps: [temp °F, bubble psig, dew psig] at sea level (14.696 psia).
// Superheat uses the dew line, subcool the bubble line, so glide blends
// (R-407C, R-454B) are handled correctly. Linear interpolation between rows.
const PT_TABLES = {"R410A":[[-40,10.8,10.7],[-35,14.1,14.0],[-30,17.8,17.7],[-25,21.9,21.8],[-20,26.3,26.2],[-15,31.2,31.0],[-10,36.5,36.3],[-5,42.2,42.0],[0,48.4,48.2],[5,55.2,54.9],[10,62.4,62.2],[15,70.3,70.0],[20,78.7,78.4],[25,87.7,87.4],[30,97.4,97.0],[35,107.7,107.3],[40,118.8,118.4],[45,130.6,130.1],[50,143.1,142.6],[55,156.5,156.0],[60,170.7,170.1],[65,185.8,185.1],[70,201.7,201.1],[75,218.6,217.9],[80,236.5,235.7],[85,255.4,254.6],[90,275.3,274.5],[95,296.4,295.4],[100,318.5,317.6],[105,341.9,340.8],[110,366.5,365.4],[115,392.3,391.2],[120,419.5,418.3],[125,448.0,446.8],[130,478.0,476.8],[135,509.5,508.4],[140,542.6,541.5],[145,577.4,576.3],[150,613.9,613.0]],"R22":[[-40,0.6,0.6],[-35,2.6,2.6],[-30,4.9,4.9],[-25,7.4,7.4],[-20,10.2,10.2],[-15,13.2,13.2],[-10,16.5,16.5],[-5,20.1,20.1],[0,24.0,24.0],[5,28.3,28.3],[10,32.8,32.8],[15,37.8,37.8],[20,43.1,43.1],[25,48.8,48.8],[30,55.0,55.0],[35,61.5,61.5],[40,68.6,68.6],[45,76.1,76.1],[50,84.1,84.1],[55,92.6,92.6],[60,101.6,101.6],[65,111.2,111.2],[70,121.4,121.4],[75,132.2,132.2],[80,143.6,143.6],[85,155.7,155.7],[90,168.4,168.4],[95,181.8,181.8],[100,195.9,195.9],[105,210.8,210.8],[110,226.4,226.4],[115,242.8,242.8],[120,260.0,260.0],[125,278.0,278.0],[130,296.9,296.9],[135,316.7,316.7],[140,337.4,337.4],[145,359.0,359.0],[150,381.7,381.7]],"R134a":[[-40,-7.3,-7.3],[-35,-6.1,-6.1],[-30,-4.8,-4.8],[-25,-3.4,-3.4],[-20,-1.8,-1.8],[-15,-0.0,-0.0],[-10,1.9,1.9],[-5,4.1,4.1],[0,6.5,6.5],[5,9.1,9.1],[10,11.9,11.9],[15,15.0,15.0],[20,18.4,18.4],[25,22.1,22.1],[30,26.1,26.1],[35,30.4,30.4],[40,35.0,35.0],[45,40.1,40.1],[50,45.4,45.4],[55,51.2,51.2],[60,57.4,57.4],[65,64.0,64.0],[70,71.1,71.1],[75,78.7,78.7],[80,86.7,86.7],[85,95.2,95.2],[90,104.3,104.3],[95,113.9,113.9],[100,124.2,124.2],[105,135.0,135.0],[110,146.4,146.4],[115,158.4,158.4],[120,171.2,171.2],[125,184.6,184.6],[130,198.7,198.7],[135,213.6,213.6],[140,229.2,229.2],[145,245.7,245.7],[150,262.9,262.9]],"R32":[[-40,11.0,11.0],[-35,14.4,14.4],[-30,18.2,18.2],[-25,22.3,22.3],[-20,26.8,26.8],[-15,31.7,31.7],[-10,37.1,37.1],[-5,42.9,42.9],[0,49.3,49.3],[5,56.1,56.1],[10,63.5,63.5],[15,71.4,71.4],[20,80.0,80.0],[25,89.2,89.2],[30,99.1,99.1],[35,109.7,109.7],[40,121.0,121.0],[45,133.0,133.0],[50,145.8,145.8],[55,159.5,159.5],[60,174.0,174.0],[65,189.5,189.5],[70,205.8,205.8],[75,223.2,223.2],[80,241.5,241.5],[85,260.9,260.9],[90,281.3,281.3],[95,302.9,302.9],[100,325.7,325.7],[105,349.6,349.6],[110,374.9,374.9],[115,401.4,401.4],[120,429.3,429.3],[125,458.7,458.7],[130,489.5,489.5],[135,521.8,521.8],[140,555.8,555.8],[145,591.4,591.4],[150,628.8,628.8]],"R407C":[[-40,2.7,-2.3],[-35,5.1,-0.4],[-30,7.7,1.6],[-25,10.6,3.9],[-20,13.7,6.5],[-15,17.2,9.3],[-10,20.9,12.3],[-5,25.0,15.7],[0,29.5,19.4],[5,34.3,23.5],[10,39.5,27.9],[15,45.2,32.7],[20,51.2,37.9],[25,57.7,43.5],[30,64.7,49.6],[35,72.2,56.1],[40,80.2,63.2],[45,88.8,70.7],[50,97.9,78.8],[55,107.6,87.5],[60,117.9,96.8],[65,128.9,106.7],[70,140.5,117.3],[75,152.8,128.5],[80,165.8,140.5],[85,179.6,153.2],[90,194.1,166.7],[95,209.4,181.0],[100,225.5,196.1],[105,242.4,212.1],[110,260.2,229.0],[115,278.9,246.9],[120,298.6,265.8],[125,319.2,285.6],[130,340.7,306.6],[135,363.3,328.7],[140,387.0,352.0],[145,411.7,376.6],[150,437.5,402.5]],"R404A":[[-40,4.9,4.3],[-35,7.5,6.8],[-30,10.3,9.6],[-25,13.4,12.7],[-20,16.8,16.0],[-15,20.5,19.7],[-10,24.6,23.6],[-5,28.9,27.9],[0,33.7,32.6],[5,38.8,37.7],[10,44.3,43.1],[15,50.2,49.0],[20,56.6,55.3],[25,63.4,62.1],[30,70.7,69.3],[35,78.6,77.1],[40,86.9,85.4],[45,95.8,94.2],[50,105.3,103.6],[55,115.3,113.6],[60,126.0,124.2],[65,137.3,135.5],[70,149.3,147.4],[75,162.0,160.1],[80,175.4,173.4],[85,189.5,187.5],[90,204.5,202.4],[95,220.2,218.1],[100,236.8,234.7],[105,254.2,252.1],[110,272.6,270.4],[115,291.8,289.7],[120,312.1,309.9],[125,333.4,331.2],[130,355.7,353.6],[135,379.1,377.1],[140,403.7,401.7],[145,429.6,427.7],[150,456.8,455.0]],"R454B":[[-40,9.8,8.5],[-35,13.0,11.5],[-30,16.6,14.9],[-25,20.5,18.6],[-20,24.7,22.7],[-15,29.4,27.1],[-10,34.5,32.0],[-5,40.0,37.2],[0,45.9,42.9],[5,52.4,49.1],[10,59.3,55.7],[15,66.8,62.9],[20,74.8,70.6],[25,83.5,78.9],[30,92.7,87.8],[35,102.6,97.3],[40,113.2,107.5],[45,124.5,118.3],[50,136.4,129.9],[55,149.2,142.2],[60,162.7,155.3],[65,177.1,169.2],[70,192.3,183.9],[75,208.4,199.5],[80,225.4,216.0],[85,243.4,233.5],[90,262.3,251.9],[95,282.3,271.4],[100,303.3,291.9],[105,325.4,313.5],[110,348.6,336.3],[115,373.0,360.3],[120,398.6,385.5],[125,425.5,412.1],[130,453.6,440.0],[135,483.4,469.6],[140,514.1,500.2],[145,546.7,532.9],[150,580.3,566.8]]};

// Invert the PT table: gauge pressure → saturation temp °F. col 1 = bubble
// (subcool), col 2 = dew (superheat). Returns null outside the table.
function satTempF(ref, psig, col) {
  const t = PT_TABLES[ref];
  if (!t || psig < t[0][col] || psig > t[t.length - 1][col]) return null;
  for (let i = 1; i < t.length; i++) {
    if (psig <= t[i][col]) {
      const [t0, p0] = [t[i - 1][0], t[i - 1][col]];
      const [t1, p1] = [t[i][0], t[i][col]];
      return t0 + (psig - p0) / (p1 - p0) * (t1 - t0);
    }
  }
  return null;
}

const fmtAbsF = (f) => unit === 'F' ? `${f.toFixed(1)} °F` : `${((f - 32) * 5 / 9).toFixed(1)} °C`;
const fmtDeltaF = (df) => unit === 'F' ? `${df.toFixed(1)} °F` : `${(df * 5 / 9).toFixed(1)} °C`;

function shscSide(psigId, clampId, outId, detailId, col, sign) {
  const psig = parseFloat($(psigId).value);
  const clamp = clamps[Number($(clampId).value)];
  const last = clamp?.readings[clamp.readings.length - 1];
  if (!Number.isFinite(psig) || !last) {
    $(outId).textContent = '–';
    $(detailId).textContent = Number.isFinite(psig) && !last ? 'waiting for clamp data…' : '';
    return;
  }
  const satF = satTempF($('refrigerant').value, psig, col);
  if (satF === null) {
    $(outId).textContent = '–';
    $(detailId).textContent = 'pressure out of table range';
    return;
  }
  const lineF = cToF(last.c);
  $(outId).textContent = fmtDeltaF(sign * (lineF - satF));
  $(detailId).textContent = `sat ${fmtAbsF(satF)} · line ${fmtAbsF(lineF)}`;
}

function updateShSc() {
  shscSide('shPsig', 'shClamp', 'shOut', 'shDetail', 2, 1);
  shscSide('scPsig', 'scClamp', 'scOut', 'scDetail', 1, -1);
  localStorage.setItem('ut320i-shsc', JSON.stringify({
    ref: $('refrigerant').value, sh: $('shPsig').value, sc: $('scPsig').value,
  }));
}

function refreshClampSelects() {
  for (const [id, defIdx] of [['shClamp', 0], ['scClamp', 1]]) {
    const sel = $(id);
    const prev = sel.value;
    sel.textContent = '';
    clamps.forEach((clamp, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = clamp.name;
      sel.appendChild(opt);
    });
    sel.value = prev !== '' && Number(prev) < clamps.length ? prev
      : String(Math.min(defIdx, Math.max(clamps.length - 1, 0)));
  }
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
    // Break the line where samples are missing (phone asleep, clamp
    // disconnected) instead of bridging the gap with a false straight line.
    s.pts.forEach((p, i) => {
      if (!i || p.t - s.pts[i - 1].t > 8000) ctx.moveTo(x(p.t), y(p.c));
      else ctx.lineTo(x(p.t), y(p.c));
    });
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
    optionalServices: [UT_SERVICE],
  });
  await adoptDevice(device);
}

// Wire up a device we're allowed to use — fresh from the chooser or
// remembered from a previous visit — and get it streaming. A failed first
// setup goes into the same retry loop as a dropped connection.
async function adoptDevice(device) {
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
    rememberDevice(device.id, true);
    device.addEventListener('gattserverdisconnected', () => {
      if (!clamp.removed) autoReconnect(clamp);
    });
  }
  syncWakeLock();
  try { await setupClamp(clamp); }
  catch { autoReconnect(clamp); }
}

function rememberedIds() {
  try { return JSON.parse(localStorage.getItem('ut320i-devices') || '[]'); }
  catch { return []; }
}

function rememberDevice(id, keep) {
  const ids = rememberedIds().filter((x) => x !== id);
  if (keep) ids.push(id);
  localStorage.setItem('ut320i-devices', JSON.stringify(ids));
}

// Reconnect to previously-used clamps without the chooser. Key on Android:
// a clamp that still holds its link to the phone stops advertising, so the
// chooser can't see it — but a direct reconnect by permission still works.
async function reconnectRemembered() {
  const ids = rememberedIds();
  if (!ids.length || !navigator.bluetooth?.getDevices) return;
  let devices = [];
  try { devices = await navigator.bluetooth.getDevices(); } catch { return; }
  for (const device of devices) {
    if (ids.includes(device.id)) adoptDevice(device);
  }
}

// A dropped clamp is normal in the field (walked to the truck, phone slept).
// Keep retrying quietly until it comes back or the card is removed.
async function autoReconnect(clamp) {
  if (clamp.reconnecting) return;
  clamp.reconnecting = true;
  setConn(clamp, 'reconnecting…', false);
  while (!clamp.removed && !clamp.connected) {
    try {
      await setupClamp(clamp);
    } catch {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  clamp.reconnecting = false;
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
  // Hook the listener before subscribing so the very first frames (the
  // cmd 0x08/0x06 handshake responses) can't slip through unheard.
  if (!clamp.notifyHooked) {
    clamp.notifyHooked = true;
    notifyChar.addEventListener('characteristicvaluechanged', (ev) => onNotification(clamp, ev));
  }
  await notifyChar.startNotifications();

  setConn(clamp, 'connected', true);
  refreshClampSelects();
  startStream(clamp).catch(() => { /* connection died; auto-reconnect handles it */ });
}

// The clamp streams nothing until commanded. Keep nudging with START until
// data flows — quickly at first, then every 10 s for as long as we're
// connected, so a clamp that wakes up late still comes through on its own.
async function startStream(clamp) {
  if (!clamp.writeChar) { setConn(clamp, 'error: no command channel', true); return; }
  const gen = clamp.startGen = (clamp.startGen || 0) + 1;
  for (let i = 0; clamp.connected && clamp.startGen === gen; i++) {
    const before = clamp.readings.length;
    await writeBytes(clamp.writeChar, START_CMD);
    await new Promise((r) => setTimeout(r, i < 3 ? 2500 : 10000));
    if (clamp.readings.length > before) return;
    if (i === 2) setConn(clamp, 'connected — no data', true);
  }
}

function onNotification(clamp, ev) {
  const dv = ev.target.value;
  const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
  const t = Date.now();
  framesLog.push({ t, name: clamp.fullName, bytes });
  if (framesLog.length > 300) framesLog.shift();

  for (const f of extractUtFrames(clamp, bytes)) {
    const decoded = decodeFrame(f);
    if (decoded) {
      clamp.readings.push({ t, c: decoded.c });
      if (clamp.readings.length > 4000) clamp.readings.shift();
      if (decoded.status !== null) clamp.statusByte = decoded.status;
      renderClamp(clamp);
      updateDelta();
      drawChart();
    } else {
      // Status/info responses: keep the latest payload per command for
      // diagnostics (field meanings not yet mapped).
      clamp.info = clamp.info || {};
      clamp.info[f[3]] = hex(f.slice(4, f.length - 2));
    }
  }
}

async function writeBytes(ch, bytes) {
  if (ch.properties.writeWithoutResponse) {
    await ch.writeValueWithoutResponse(bytes);
  } else {
    await ch.writeValueWithResponse(bytes);
  }
}

// --- Diagnostics ----------------------------------------------------------

function diagText() {
  const build = $('build')?.textContent || '?';
  const lines = [
    `UT320i app diagnostics — build ${build} — ${new Date().toISOString()}`,
    `UA: ${navigator.userAgent}`,
    `Clamps (${clamps.length}):`,
    ...clamps.map((c) => {
      const last = c.readings[c.readings.length - 1];
      const status = c.statusByte != null
        ? ` | status 0x${c.statusByte.toString(16).padStart(2, '0')}` : '';
      const info = c.info
        ? Object.entries(c.info).map(([cmd, p]) => ` | cmd 0x0${Number(cmd).toString(16)}: ${p}`).join('')
        : '';
      return `  - ${c.fullName} | ${c.connected ? 'connected' : 'disconnected'} | ` +
        `${c.readings.length} samples${last ? ` | last ${last.c.toFixed(3)} °C` : ''}${status}${info}`;
    }),
    `Last raw frames (up to 30):`,
    ...framesLog.slice(-30).map((f) => `  ${new Date(f.t).toISOString()} ${f.name}: ${hex(f.bytes)}`),
  ];
  return lines.join('\n');
}

async function copyText(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const old = btn.textContent;
    btn.textContent = 'Copied ✓';
    setTimeout(() => { btn.textContent = old; }, 1500);
  } catch (e) {
    alert(`Copy failed: ${e.message}`);
  }
}

// --- Wake lock ------------------------------------------------------------
// Automatic: while any clamp is on screen, the screen stays on. No checkbox
// to remember — a phone that sleeps mid-measurement is a lost reading.

async function syncWakeLock() {
  const want = clamps.length > 0 && document.visibilityState === 'visible';
  if (want && !wakeLock) {
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch { /* unsupported or denied — nothing actionable */ }
  } else if (!want && wakeLock) {
    wakeLock.release();
    wakeLock = null;
  }
}
document.addEventListener('visibilitychange', syncWakeLock);

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

// Superheat/subcool controls
for (const name of Object.keys(PT_TABLES)) {
  const opt = document.createElement('option');
  opt.value = name;
  opt.textContent = name.replace(/^R(\d)/, 'R-$1');
  $('refrigerant').appendChild(opt);
}
try {
  const saved = JSON.parse(localStorage.getItem('ut320i-shsc') || '{}');
  if (saved.ref && PT_TABLES[saved.ref]) $('refrigerant').value = saved.ref;
  if (saved.sh) $('shPsig').value = saved.sh;
  if (saved.sc) $('scPsig').value = saved.sc;
} catch { /* fresh start */ }
for (const id of ['refrigerant', 'shPsig', 'scPsig', 'shClamp', 'scClamp']) {
  $(id).addEventListener('input', updateShSc);
}

$('connect').addEventListener('click', () =>
  addClamp().catch((e) => {
    if (e.name !== 'NotFoundError') $('status').textContent = `Error: ${e.message}`;
  }));
$('copyDiag').addEventListener('click', (e) => copyText(diagText(), e.target));
reconnectRemembered();

// Redraw the rolling window even when no new data arrives.
setInterval(drawChart, 5000);
