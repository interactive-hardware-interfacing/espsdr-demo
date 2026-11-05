'use strict';

/*
 * app.js — espsdr-demo UI. Runs a capture loop against either the real
 * EspSdr (Web Serial) or the SimSdr, and draws three views from each
 * capture: power spectrum, scrolling waterfall, and raw I/Q scatter
 * (the "constellation"). Plus a jammer GPIO toggle and a serial log.
 */

import { EspSdr } from './radio.js';
import { SimSdr } from './sim.js';

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
const wfCanvas = $('#waterfall'), wfCtx = wfCanvas.getContext('2d');
let wfImage = null;
let avg = null; // trace averaging buffer

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

// Turbo-ish colormap for the waterfall (dB -> rgb)
function heat(t) {
  t = Math.max(0, Math.min(1, t));
  const r = Math.round(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * t - 3))));
  const g = Math.round(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * t - 2))));
  const b = Math.round(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * t - 1))));
  return [r, g, b];
}

function drawSpectrum(bins, centerMHz, rateHz) {
  const W = specCanvas.width, H = specCanvas.height;
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

  // waterfall row
  const wfW = wfCanvas.width, wfH = wfCanvas.height;
  if (!wfImage || wfImage.width !== wfW) wfImage = wfCtx.createImageData(wfW, 1);
  for (let x = 0; x < wfW; x++) {
    const i = Math.floor(x / wfW * bins.length);
    const t = (bins[i] - floor) / range;
    const [r, g, b] = heat(t);
    wfImage.data[x * 4] = r; wfImage.data[x * 4 + 1] = g; wfImage.data[x * 4 + 2] = b; wfImage.data[x * 4 + 3] = 255;
  }
  const prev = wfCtx.getImageData(0, 0, wfW, wfH - 1);
  wfCtx.putImageData(prev, 0, 1);
  wfCtx.putImageData(wfImage, 0, 0);
}

// ---- I/Q scatter ("constellation") ----
const iqCanvas = $('#iq'), iqCtx = iqCanvas.getContext('2d');
function drawIq(iq) {
  const W = iqCanvas.width, H = iqCanvas.height, cx = W / 2, cy = H / 2, s = Math.min(W, H) * 0.45;
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
      drawSpectrum(cap.spectrum, cap.frequency, cap.rate);
      drawIq(cap.iq);
      stats(cap);
    } catch (e) {
      log('⚠ ' + e.message);
      if (radio.failed) { await stop(); setStatus('Disconnected: ' + e.message, false); break; }
      await new Promise(r => setTimeout(r, 300));
    }
    await new Promise(r => requestAnimationFrame(r));
  }
}

function setStatus(text, connected) {
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

// Browser capability hint
if (!navigator.serial) {
  $('#nowebserial').hidden = false;
}

setStatus('Not connected', false);
log('Ready. Click "Try without hardware" for the simulator, or "Connect board" with a XIAO C3 running ESP-SDR.');
