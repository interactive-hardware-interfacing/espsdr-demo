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
import { CaptureLogger, fmtBytes } from './logger.js';

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
  $('#recDownload').disabled = l.count === 0;
  for (const id of ['logSummary', 'logSpectrum', 'logIq', 'logIqEvery']) $('#' + id).disabled = l.recording;
  if (l.full) { st.textContent = `Stopped at ${fmtBytes(l.bytes)} — memory cap reached. Download, then record again.`; st.className = 'recstatus full'; }
  else if (l.recording) { st.textContent = `recording · ${l.count} captures · ${fmtBytes(l.bytes)}`; st.className = 'recstatus on'; }
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
}

async function start(useSim) {
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
  avg = null;
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
