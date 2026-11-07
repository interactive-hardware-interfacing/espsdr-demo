'use strict';

/*
 * app.js — espsdr-demo UI. Runs a capture loop against either the real
 * EspSdr (Web Serial) or the SimSdr, and draws three views from each
 * capture: power spectrum, scrolling waterfall, and raw I/Q scatter
 * (the "constellation"). Plus a jammer GPIO toggle and a serial log.
 */

import { EspSdr } from './radio.js';
import { SimSdr } from './sim.js';
import { initViews } from './views.js';
import { initInstall } from './install.js';
import { CaptureLogger, fmtBytes, parseLog, readNpy } from './logger.js';
import { initPresenter } from './presenter.js';

const $ = sel => document.querySelector(sel);
const logEl = $('#log');
function log(line) {
  const t = new Date().toLocaleTimeString();
  logEl.textContent += `[${t}] ${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

let radio = null;
let running = false;
let simulated = false;

// ---- capture settings from the controls ----
function settings() {
  return {
    frequency: Number($('#freq').value),
    rate: 80000000,
    bits: Number($('#bits').value),
    fft: Number($('#fft').value),
    gainMode: $('#agc').checked ? 'HARDWARE' : 'MANUAL',
    gain: Number($('#gain').value),
  };
}

// ---- spectrum + waterfall ----
const specCanvas = $('#spectrum'), specCtx = specCanvas.getContext('2d');
const wfCanvas = $('#waterfall'), wfCtx = wfCanvas.getContext('2d', { willReadFrequently: true });
let wfImage = null;
let avg = null; // trace averaging buffer
let hold = null;   // peak/max hold buffer (dB per bin)
let lastAxis = { lo: 2402, hi: 2482, n: 2048 };   // what the spectrum last drew, for click → MHz
let hoverX = null;                                 // CSS px under the mouse, or null
const markers = [];                                // [{mhz}] up to 2

// Size a canvas bitmap to its on-screen size × devicePixelRatio so lines and
// text stay crisp; drawing code then works in CSS pixels through a transform.
// Returns the CSS-pixel size. The waterfall is handled separately below
// because its bitmap *is* its history.
function fit(canvas, ctx) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { W: canvas.clientWidth, H: canvas.clientHeight };
}
// The waterfall scrolls by copying its own pixels, so a resize must carry the
// old rows across rather than wipe them. One bitmap row per capture; the row
// height follows DPR so it stays one CSS pixel tall.
function fitWaterfall() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(wfCanvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(wfCanvas.clientHeight * dpr));
  if (wfCanvas.width === w && wfCanvas.height === h) return;
  let old = null;
  try { old = wfCanvas.width && wfCanvas.height ? wfCtx.getImageData(0, 0, wfCanvas.width, wfCanvas.height) : null; } catch {}
  wfCanvas.width = w; wfCanvas.height = h;
  wfImage = null;
  if (old) {
    // stretch the old history onto the new size (stays readable; exact pixels don't matter)
    const tmp = document.createElement('canvas'); tmp.width = old.width; tmp.height = old.height;
    tmp.getContext('2d').putImageData(old, 0, 0);
    wfCtx.imageSmoothingEnabled = false;
    wfCtx.drawImage(tmp, 0, 0, w, h);
  }
}

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

// Waterfall colormap (dB -> rgb). The bottom of the range fades into the
// page background so quiet bins recede and only energy lights up; above that
// it runs blue -> green -> yellow -> red like a conventional waterfall.
function heat(t) {
  t = Math.max(0, Math.min(1, t));
  const r = 255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * t - 3)));
  const g = 255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * t - 2)));
  const b = 255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * t - 1)));
  const k = Math.min(1, t / 0.35);                 // 0 at the floor, 1 from 35 % up
  return [Math.round(r * k + 20 * (1 - k)), Math.round(g * k + 26 * (1 - k)), Math.round(b * k + 34 * (1 - k))];
}

function drawSpectrum(bins, centerMHz, rateHz) {
  const { W, H } = fit(specCanvas, specCtx);
  const floor = Number($('#floor').value), range = Number($('#range').value);
  specCtx.clearRect(0, 0, W, H);

  // grid + channel markers
  specCtx.strokeStyle = cssVar('--grid'); specCtx.lineWidth = 1;
  specCtx.fillStyle = cssVar('--muted'); specCtx.font = '11px system-ui, sans-serif';
  const spanMHz = rateHz / 1e6;
  const loMHz = centerMHz - spanMHz / 2, hiMHz = centerMHz + spanMHz / 2;
  for (const ch of [[2412, '1'], [2437, '6'], [2462, '11']]) {
    if (ch[0] < loMHz || ch[0] > hiMHz) continue;
    const x = (ch[0] - loMHz) / spanMHz * W;
    specCtx.globalAlpha = 0.5;
    specCtx.beginPath(); specCtx.moveTo(x, 0); specCtx.lineTo(x, H); specCtx.stroke();
    specCtx.globalAlpha = 1;
    specCtx.fillText('Wi‑Fi ' + ch[1], x + 3, 12);
  }

  // averaging
  const mode = $('#avgmode').value;
  if (mode === 'off' || !avg || avg.length !== bins.length) avg = Float32Array.from(bins);
  else {
    const a = mode === 'short' ? 0.5 : mode === 'medium' ? 0.25 : 0.12;
    for (let i = 0; i < bins.length; i++) avg[i] = avg[i] * (1 - a) + bins[i] * a;
  }

  // trace
  specCtx.strokeStyle = cssVar('--accent'); specCtx.lineWidth = 1.5;
  specCtx.beginPath();
  for (let i = 0; i < avg.length; i++) {
    const x = i / (avg.length - 1) * W;
    const y = H - (avg[i] - floor) / range * H;
    i ? specCtx.lineTo(x, y) : specCtx.moveTo(x, y);
  }
  specCtx.stroke();
  lastAxis = { lo: loMHz, hi: hiMHz, n: bins.length };

  // peak hold (decays ~1 dB/frame) or max hold (frozen), drawn thin over the live trace
  const hm = $('#hold').value;
  if (hm === 'live') hold = null;
  else {
    if (!hold || hold.length !== bins.length) hold = Float32Array.from(bins);
    for (let i = 0; i < bins.length; i++) {
      if (hm === 'peak') hold[i] = Math.max(bins[i], hold[i] - 1);
      else hold[i] = Math.max(bins[i], hold[i]);
    }
    specCtx.strokeStyle = cssVar(hm === 'peak' ? '--yellow' : '--magenta'); specCtx.lineWidth = 1; specCtx.globalAlpha = .9;
    specCtx.beginPath();
    for (let i = 0; i < hold.length; i++) { const x = i / (hold.length - 1) * W, y = H - (hold[i] - floor) / range * H; i ? specCtx.lineTo(x, y) : specCtx.moveTo(x, y); }
    specCtx.stroke(); specCtx.globalAlpha = 1;
  }

  // markers: dashed line + live dB readout at that bin
  specCtx.font = '11px ui-monospace, monospace';
  markers.forEach((m, k) => {
    if (m.mhz < loMHz || m.mhz > hiMHz) return;
    const x = (m.mhz - loMHz) / spanMHz * W, bi = Math.round((m.mhz - loMHz) / spanMHz * (bins.length - 1));
    const db = avg[Math.max(0, Math.min(bins.length - 1, bi))];
    specCtx.save(); specCtx.strokeStyle = cssVar('--green'); specCtx.setLineDash([4, 3]); specCtx.beginPath(); specCtx.moveTo(x, 0); specCtx.lineTo(x, H); specCtx.stroke(); specCtx.restore();
    const label = `M${k + 1} ${m.mhz.toFixed(1)} MHz ${db.toFixed(0)} dB`;
    specCtx.fillStyle = cssVar('--green'); specCtx.fillText(label, Math.min(x + 4, W - specCtx.measureText(label).width - 2), H - 6 - 14 * k);
    m.db = db;
  });

  // hover cursor
  if (hoverX != null) {
    const mhz = loMHz + hoverX / W * spanMHz;
    specCtx.save(); specCtx.strokeStyle = cssVar('--muted'); specCtx.globalAlpha = .7; specCtx.beginPath(); specCtx.moveTo(hoverX, 0); specCtx.lineTo(hoverX, H); specCtx.stroke(); specCtx.restore();
    specCtx.fillStyle = cssVar('--text'); const t = `${mhz.toFixed(1)} MHz`; specCtx.fillText(t, Math.min(hoverX + 5, W - specCtx.measureText(t).width - 2), 26);
  }

  // waterfall row: one new row of `rowH` bitmap pixels (= 1 CSS pixel) at the top
  fitWaterfall();
  const wfW = wfCanvas.width, wfH = wfCanvas.height;
  const rowH = Math.max(1, Math.round(window.devicePixelRatio || 1));
  if (!wfImage || wfImage.width !== wfW || wfImage.height !== rowH) wfImage = wfCtx.createImageData(wfW, rowH);
  for (let x = 0; x < wfW; x++) {
    const i = Math.floor(x / wfW * bins.length);
    const t = (bins[i] - floor) / range;
    const [r, g, b] = heat(t);
    for (let y = 0; y < rowH; y++) {
      const o = (y * wfW + x) * 4;
      wfImage.data[o] = r; wfImage.data[o + 1] = g; wfImage.data[o + 2] = b; wfImage.data[o + 3] = 255;
    }
  }
  if (wfH > rowH) {
    const prev = wfCtx.getImageData(0, 0, wfW, wfH - rowH);
    wfCtx.putImageData(prev, 0, rowH);
  }
  wfCtx.putImageData(wfImage, 0, 0);
}

// A mark is painted straight into the waterfall bitmap as a magenta row with
// its label; the bitmap scrolls, so the mark scrolls with the history it tags.
function markWaterfall(label) {
  fitWaterfall();
  const dpr = window.devicePixelRatio || 1, rowH = Math.max(1, Math.round(dpr));
  wfCtx.save(); wfCtx.setTransform(1, 0, 0, 1, 0, 0);
  wfCtx.fillStyle = cssVar('--magenta'); wfCtx.fillRect(0, 0, wfCanvas.width, rowH);
  wfCtx.font = `${Math.round(10 * dpr)}px system-ui, sans-serif`; wfCtx.textBaseline = 'top';
  const w = wfCtx.measureText(label).width + 6 * dpr;
  wfCtx.fillStyle = 'rgba(7,9,12,.75)'; wfCtx.fillRect(4 * dpr, rowH + 2 * dpr, w, 13 * dpr);
  wfCtx.fillStyle = cssVar('--magenta'); wfCtx.fillText(label, 7 * dpr, rowH + 3 * dpr);
  wfCtx.restore();
}

// ---- I/Q scatter ("constellation") ----
const iqCanvas = $('#iq'), iqCtx = iqCanvas.getContext('2d');
function drawIq(iq) {
  const { W, H } = fit(iqCanvas, iqCtx);
  const cx = W / 2, cy = H / 2, s = Math.min(W, H) * 0.45;
  iqCtx.fillStyle = cssVar('--panel'); iqCtx.fillRect(0, 0, W, H);
  // axes
  iqCtx.strokeStyle = cssVar('--grid'); iqCtx.lineWidth = 1;
  iqCtx.beginPath(); iqCtx.moveTo(cx, 0); iqCtx.lineTo(cx, H); iqCtx.moveTo(0, cy); iqCtx.lineTo(W, cy); iqCtx.stroke();
  iqCtx.strokeStyle = cssVar('--grid'); iqCtx.globalAlpha = 0.5;
  iqCtx.beginPath(); iqCtx.arc(cx, cy, s, 0, 2 * Math.PI); iqCtx.stroke(); iqCtx.globalAlpha = 1;
  // dots — subsample so we draw a few thousand, not 16k
  iqCtx.fillStyle = cssVar('--accent');
  const n = iq.length / 2, step = Math.max(1, Math.floor(n / 3000));
  for (let j = 0; j < n; j += step) {
    const x = cx + iq[2 * j] * s, y = cy - iq[2 * j + 1] * s;
    iqCtx.fillRect(x, y, 1.5, 1.5);
  }
  iqCtx.fillStyle = cssVar('--muted'); iqCtx.font = '11px system-ui, sans-serif';
  iqCtx.fillText('I', W - 12, cy - 4); iqCtx.fillText('Q', cx + 4, 12);
}

// ---- stat readouts ----
let frames = 0, lastStat = performance.now();
function stats(cap) {
  frames++;
  const now = performance.now();
  if (now - lastStat > 500) {
    $('#fps').textContent = (frames / (now - lastStat) * 1000).toFixed(1);
    frames = 0; lastStat = now;
  }
  $('#peak').textContent = (cap.peakHz / 1e6).toFixed(2);
  $('#peakdb').textContent = cap.peakDb.toFixed(0);
  $('#cap-us').textContent = cap.captureUs;
  $('#retries').textContent = cap.retries;
}

// ---- main loop ----
async function loop() {
  while (running) {
    try {
      const cap = await radio.capture(settings());
      if (!running) break;              // Disconnect landed while the capture was in flight
      drawSpectrum(cap.spectrum, cap.frequency, cap.rate);
      drawIq(cap.iq);
      stats(cap);
      logger.push(cap, { jammer: $('#jammer').classList.contains('on') });
    } catch (e) {
      log('⚠ ' + e.message);
      if (radio.failed) { await stop(); setStatus('Disconnected: ' + e.message, false); break; }
      await new Promise(r => setTimeout(r, 300));
    }
    await new Promise(r => requestAnimationFrame(r));
  }
}

// ---- data logging ----
let connectedNow = false;
const logger = new CaptureLogger();
let lastZip = null;
logger.onChange = l => {
  const st = $('#recStatus');
  $('#recStart').disabled = l.recording || !connectedNow;
  $('#recStart').classList.toggle('on', l.recording);
  $('#recStop').disabled = !l.recording;
  $('#recDownload').disabled = l.count === 0 && l.marks.length === 0;
  $('#recMark').disabled = !connectedNow;
  for (const id of ['logSummary', 'logSpectrum', 'logIq', 'logIqEvery']) $('#' + id).disabled = l.recording;
  if (l.full) { st.textContent = `Stopped at ${fmtBytes(l.bytes)} — memory cap reached. Download, then record again.`; st.className = 'recstatus full'; }
  else if (l.recording) { st.textContent = `recording · ${l.count} captures · ${l.marks.length} marks · ${fmtBytes(l.bytes)}`; st.className = 'recstatus on'; }
  else if (l.count) { st.textContent = `${l.count} captures · ${fmtBytes(l.bytes)} ready to download`; st.className = 'recstatus'; }
  else { st.textContent = 'Connect or start the simulator, then record.'; st.className = 'recstatus'; }
};
$('#recStart').addEventListener('click', () => {
  if (!$('#logSummary').checked && !$('#logSpectrum').checked && !$('#logIq').checked) { log('⚠ pick at least one thing to log'); return; }
  logger.start({ summary: $('#logSummary').checked, spectrum: $('#logSpectrum').checked, iq: $('#logIq').checked, iqEvery: Number($('#logIqEvery').value) });
  log(`[log] recording${simulated ? ' (simulator)' : ''}`);
});
$('#recStop').addEventListener('click', () => { logger.stop(); log(`[log] stopped: ${logger.count} captures, ${fmtBytes(logger.bytes)}`); });
$('#recDownload').addEventListener('click', () => {
  const { blob, name } = logger.toZip({ source: simulated ? 'simulator' : 'board', identity: radio?.identity || '' });
  if (lastZip) URL.revokeObjectURL(lastZip);
  lastZip = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = lastZip; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  log(`[log] ${name} (${fmtBytes(blob.size)})`);
});
const doMark = () => {
  if (!connectedNow) return;
  if (!logger.recording) {
    if (!$('#logSummary').checked && !$('#logSpectrum').checked && !$('#logIq').checked) $('#logSummary').checked = true;
    logger.opts = { summary: $('#logSummary').checked, spectrum: $('#logSpectrum').checked, iq: $('#logIq').checked, iqEvery: Number($('#logIqEvery').value) };
  }
  const m = logger.mark($('#recMarkLabel').value.trim());
  $('#recMarkLabel').value = '';
  log(`[mark] ${m.t.toFixed(1)}s ${m.label}`);
  markWaterfall(m.label);
};
$('#recMark').addEventListener('click', doMark);
$('#recMarkLabel').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doMark(); } });
initPresenter($('#presenter'));
logger.onChange(logger);

function setStatus(text, connected) {
  connectedNow = connected;
  if (!connected && logger.recording) logger.stop();
  logger.onChange(logger);
  $('#status').textContent = text;
  $('#status').className = connected ? 'ok' : '';
  $('#connect').disabled = connected;
  $('#sim').disabled = connected;
  $('#disconnect').disabled = !connected;
  $('#jammer').disabled = !connected || !radio?.hasGpio;
  $('#sweep').disabled = !connected || !radio?.hasGpio;
  $('#holdreset').disabled = $('#hold').value === 'live';
  $('#replayLoad').disabled = connected;
}

async function start(useSim) {
  stopReplay(true);
  simulated = useSim;
  radio = useSim ? new SimSdr() : new EspSdr();
  radio.onLog = log;
  try {
    log(useSim ? 'Starting simulator…' : 'Requesting serial port…');
    const info = await radio.connect();
    log(`Connected: ${info.device}${info.simulated ? '' : ' · ' + info.identity}`);
    setStatus(`${info.device} · ${info.rates[0] / 1e6} MS/s`, true);
    running = true; loop();
  } catch (e) {
    log('✖ ' + e.message); setStatus(e.message, false);
    radio = null;
  }
}

async function stop() {
  running = false;
  await new Promise(r => setTimeout(r, 60));
  if (radio) { try { await radio.disconnect(); } catch {} }
  radio = null;
  avg = null; hold = null;
  sweepStop();
  $('#jammer').textContent = 'Jammer: off'; $('#jammer').classList.remove('on');
  setStatus('Not connected', false);
  log('Disconnected.');
}

// ---- wire up controls ----
$('#connect').addEventListener('click', () => start(false));
$('#sim').addEventListener('click', () => start(true));
$('#disconnect').addEventListener('click', stop);

$('#jammer').addEventListener('click', async () => {
  if (!radio?.hasGpio) return;
  const entry = radio.gpioPins.find(p => p.pin === 4) || radio.gpioPins[0];
  if (!entry) { log('No spare GPIO on this firmware.'); return; }
  const next = entry.state === '1' ? 'Z' : '1';
  try {
    await radio.setGpio(entry.pin, next);
    const on = next === '1';
    $('#jammer').textContent = on ? 'Jammer: ON' : 'Jammer: off';
    $('#jammer').classList.toggle('on', on);
    if (!on) sweepStop();
    log(`Jammer GPIO${entry.pin} → ${next}`);
  } catch (e) { log('⚠ ' + e.message); }
});

$('#gain').addEventListener('input', () => { $('#gainval').textContent = $('#gain').value; });
$('#agc').addEventListener('change', () => { $('#gain').disabled = $('#agc').checked; });

// serial log send box (handy during a demo for poking the firmware)
$('#logsend').addEventListener('click', async () => {
  const cmd = $('#logcmd').value.trim();
  if (!cmd || !radio || simulated) { if (simulated) log('(simulator: commands are not sent)'); return; }
  try { await radio._cmd(cmd); log('→ ' + cmd); } catch (e) { log('⚠ ' + e.message); }
});

// ---- doc views + firmware install ----
const views = initViews(
  $('#instrument'),
  { hardware: $('#hardware'), firmware: $('#firmware'), about: $('#about') },
  [...document.querySelectorAll('nav a[data-view]')],
);
initInstall({
  installJammer: $('#fwInstallJammer'), status: $('#fwStatus'), bar: $('#fwBar'), log: $('#fwLog'), noRepl: $('#fwNoRepl'),
  cpFile: $('#cpFile'), cpLoad: $('#cpLoad'), cpName: $('#cpName'), cpFlash: $('#cpFlash'),
}, { releaseSerial: async () => { if (radio && !simulated) await stop(); } });

// Browser capability hint
if (!navigator.serial) {
  $('#nowebserial').hidden = false;
}

setStatus('Not connected', false);
log('Ready. Click "Try without hardware" for the simulator, or "Connect board" with a XIAO C3 running ESP-SDR.');

// ---- trace hold ----
$('#hold').addEventListener('change', () => { hold = null; $('#holdreset').disabled = $('#hold').value === 'live'; });
$('#holdreset').addEventListener('click', () => { hold = null; });

// ---- tune-to-click, hover readout, markers ----
function specMHz(ev) {
  const r = specCanvas.getBoundingClientRect();
  const x = Math.max(0, Math.min(r.width, ev.clientX - r.left));
  return { x, mhz: lastAxis.lo + x / r.width * (lastAxis.hi - lastAxis.lo) };
}
specCanvas.addEventListener('mousemove', ev => { const { x, mhz } = specMHz(ev); hoverX = x; $('#specreadout').textContent = `${mhz.toFixed(1)} MHz`; });
specCanvas.addEventListener('mouseleave', () => { hoverX = null; $('#specreadout').textContent = ''; });
specCanvas.addEventListener('click', ev => {
  const { mhz } = specMHz(ev);
  if (ev.shiftKey) {
    // toggle a marker: clicking within 1 MHz of an existing one removes it
    const k = markers.findIndex(m => Math.abs(m.mhz - mhz) < 1);
    if (k >= 0) { markers.splice(k, 1); log(`marker removed`); }
    else if (markers.length < 2) { markers.push({ mhz: Math.round(mhz * 10) / 10 }); log(`marker M${markers.length} at ${mhz.toFixed(1)} MHz`); }
    else log('two markers already placed — shift-click one to remove it');
    return;
  }
  const f = Math.round(mhz);
  if (f === Number($('#freq').value)) return;
  $('#freq').value = f;
  $('#freq').dispatchEvent(new Event('change'));
  log(`tune → ${f} MHz`);
});

// ---- jammer sweep: one short pulse on the enable line per second ----
// The jammer firmware counts short lows (< 300 ms) while enabled as "next
// channel"; the page drops GPIO4 for ~30 ms and raises it again. One wire.
let sweepTimer = null;
function sweepStop() { if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; log('[sweep] off'); } $('#sweep').checked = false; }
$('#sweep').addEventListener('change', async () => {
  if (!$('#sweep').checked) { sweepStop(); return; }
  if (!radio?.hasGpio) { $('#sweep').checked = false; return; }
  const entry = radio.gpioPins.find(p => p.pin === 4) || radio.gpioPins[0];
  if (!$('#jammer').classList.contains('on')) { $('#jammer').click(); await new Promise(r => setTimeout(r, 100)); }
  log('[sweep] stepping the jammer across channels once a second');
  sweepTimer = setInterval(async () => {
    if (!radio || !$('#jammer').classList.contains('on')) { sweepStop(); return; }
    try { await radio.setGpio(entry.pin, 'Z'); await new Promise(r => setTimeout(r, 30)); await radio.setGpio(entry.pin, '1'); }
    catch (e) { log('⚠ sweep pulse: ' + e.message); sweepStop(); }
  }, 1000);
});

// ---- replay a downloaded log, no board needed ----
let replay = null;   // {name, data, i, timer, paused}
$('#replayLoad').addEventListener('click', () => $('#replayFile').click());
$('#replayFile').addEventListener('change', async () => {
  const f = $('#replayFile').files?.[0]; $('#replayFile').value = '';
  if (!f) return;
  try {
    const data = parseLog(await f.arrayBuffer());
    if (!data.frames.length) throw new Error('no spectrum rows in this log');
    startReplay(f.name, data);
  } catch (e) { log('⚠ replay: ' + e.message); }
});
function startReplay(name, data) {
  stopReplay(true);
  replay = { name, data, i: 0, paused: false, t0: performance.now() };
  avg = null; hold = null;
  setStatus(`replaying ${name}`, false);
  $('#status').className = 'replay';
  $('#connect').disabled = $('#sim').disabled = $('#replayLoad').disabled = true;
  $('#replayPause').hidden = $('#replayStop').hidden = false; $('#replayPause').textContent = 'Pause';
  log(`[replay] ${name}: ${data.frames.length} frames, ${data.iq.size} I/Q snapshots, ${data.marks.size} marks`);
  replayTick();
}
function replayTick() {
  if (!replay || replay.paused) return;
  const { data } = replay;
  if (replay.i >= data.frames.length) { replay.i = 0; replay.t0 = performance.now(); log('[replay] looping'); }
  const fr = data.frames[replay.i];
  const n = fr.bins.length, lo = fr.bins[0], hi = fr.bins[n - 1], centre = (lo + hi) / 2, rate = (hi - lo) * 1e6 * n / (n - 1);
  drawSpectrum(fr.db, centre, rate);
  const s = data.summary.get(fr.i);
  if (s) { $('#peak').textContent = Number(s.peak_mhz).toFixed(2); $('#peakdb').textContent = Number(s.peak_dbfs).toFixed(0); $('#cap-us').textContent = s.capture_us; $('#retries').textContent = s.retries; }
  else { let p = 0; for (let k = 1; k < fr.db.length; k++) if (fr.db[k] > fr.db[p]) p = k; $('#peak').textContent = fr.bins[p].toFixed(2); $('#peakdb').textContent = fr.db[p].toFixed(0); }
  const iqb = data.iq.get(fr.i); if (iqb) { try { drawIq(readNpy(iqb)); } catch (e) { log('⚠ ' + e.message); } }
  for (const m of data.marks.get(fr.i) || []) markWaterfall(m);
  $('#fps').textContent = 'replay';
  replay.i++;
  // pace by the recorded timestamps; fall back to 15 fps if there is no gap
  const next = data.frames[replay.i], dt = next ? Math.max(16, Math.min(1000, (next.t - fr.t) * 1000)) : 66;
  replay.timer = setTimeout(replayTick, dt);
}
function stopReplay(silent) {
  if (!replay) return;
  clearTimeout(replay.timer); replay = null;
  $('#replayPause').hidden = $('#replayStop').hidden = true;
  if (!silent) { setStatus('Not connected', false); $('#fps').textContent = '—'; log('[replay] stopped'); }
}
$('#replayPause').addEventListener('click', () => { if (!replay) return; replay.paused = !replay.paused; $('#replayPause').textContent = replay.paused ? 'Resume' : 'Pause'; if (!replay.paused) replayTick(); });
$('#replayStop').addEventListener('click', () => stopReplay(false));
