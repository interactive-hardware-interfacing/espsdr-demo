'use strict';

/*
 * app.js — espsdr-demo glue. Runs a capture loop against either the real
 * EspSdr (Web Serial) or the SimSdr and hands each capture to the views.
 * The views and panels live in js/ui/:
 *
 *   dom.js        $, cssVar, canvas fit, serial log writer
 *   spectrum.js   power spectrum: averaging, hold, markers, click-to-tune
 *   waterfall.js  scrolling waterfall + marks
 *   iq.js         I/Q scatter
 *   timeview.js   one capture in time: envelope or I/Q, on-air %, clipping
 *   bands.js      Wi-Fi / BLE / 802.15.4 channel tables + spectrum overlay
 *   occupancy.js  per-channel busy share over recent captures
 *   stats.js      numeric readouts
 *   logging.js    Data logging panel (Record / Mark / Download)
 *   replay.js     Replay a log…
 *   jammer.js     Jammer button + Sweep (receiver GPIO4)
 */

import { EspSdr } from './radio.js';
import { SimSdr } from './sim.js';
import { initViews } from './views.js';
import { initInstall } from './install.js';
import { initPresenter } from './presenter.js';
import { $, makeLog } from './ui/dom.js';
import { SpectrumView } from './ui/spectrum.js';
import { WaterfallView } from './ui/waterfall.js';
import { IqView } from './ui/iq.js';
import { TimeView } from './ui/timeview.js';
import { OccupancyView } from './ui/occupancy.js';
import { Stats } from './ui/stats.js';
import { initLogging } from './ui/logging.js';
import { initReplay } from './ui/replay.js';
import { initJammer } from './ui/jammer.js';

const log = makeLog($('#log'));

// Shared, read live by the panels.
const session = { radio: null, running: false, simulated: false, connected: false };

// ---- capture settings from the controls ----
function settings() {
  return {
    frequency: Number($('#freq').value),
    rate: Number($('#rate').value),
    bandwidth: $('#bw').value === 'auto' ? 'auto' : Number($('#bw').value),
    bits: Number($('#bits').value),
    fft: Number($('#fft').value),
    gainMode: $('#agc').checked ? 'HARDWARE' : 'MANUAL',
    gain: Number($('#gain').value),
  };
}
const display = () => ({
  floor: Number($('#floor').value), range: Number($('#range').value),
  avgmode: $('#avgmode').value, hold: $('#hold').value, bands: $('#bands').value, persist: $('#persist').checked,
});

// ---- views ----
const spectrum = new SpectrumView($('#spectrum'), {
  display, log,
  onHover: t => { $('#specreadout').textContent = t; },
  onTune: mhz => {
    const f = Math.round(mhz);
    if (f === Number($('#freq').value)) return;
    $('#freq').value = f;
    $('#freq').dispatchEvent(new Event('change'));
    log(`tune → ${f} MHz`);
  },
});
const waterfall = new WaterfallView($('#waterfall'));
const iqView = new IqView($('#iq'));
const timeView = new TimeView($('#timedomain'),
  () => ({ mode: $('#tdmode').value, window: Number($('#tdwin').value) }),
  (text, warn) => { const el = $('#tdreadout'); el.textContent = text; el.classList.toggle('warn', warn); });
const occupancy = new OccupancyView($('#occupancy'),
  () => ({ band: $('#occband').value, threshold: Number($('#occthr').value), window: Number($('#occwin').value) }),
  text => { $('#occreadout').textContent = text; });
const stats = new Stats();

/** Draw one frame (live capture or replayed row) into every view. */
function render({ bins, center, rate, iq }) {
  const d = display();
  spectrum.draw(bins, center, rate);
  waterfall.push(bins, d.floor, d.range);
  occupancy.push(bins, center, rate);
  if (iq) { iqView.draw(iq); timeView.draw(iq, rate); }
}

// ---- panels ----
const jammer = initJammer({ log, session });
const logging = initLogging({ log, session, markWaterfall: l => waterfall.mark(l) });
const { logger } = logging;
const replay = initReplay({
  log, render, stats, setStatus,
  markWaterfall: l => waterfall.mark(l),
  onStart: () => { spectrum.reset(); occupancy.reset(); },
});
initPresenter($('#presenter'));
logging.refresh();

function setStatus(text, connected) {
  session.connected = connected;
  if (!connected && logger.recording) logger.stop();
  logging.refresh();
  $('#status').textContent = text;
  $('#status').className = connected ? 'ok' : '';
  $('#connect').disabled = connected;
  $('#sim').disabled = connected;
  $('#disconnect').disabled = !connected;
  jammer.refresh(connected);
  $('#holdreset').disabled = $('#hold').value === 'live';
  $('#replayLoad').disabled = connected;
}

// ---- main loop ----
async function loop() {
  while (session.running) {
    const radio = session.radio;
    try {
      const cap = await radio.capture(settings());
      if (!session.running) break;              // Disconnect landed while the capture was in flight
      render({ bins: cap.spectrum, center: cap.frequency, rate: cap.rate, iq: cap.iq });
      stats.update(cap);
      logger.push(cap, { jammer: jammer.isOn() });
    } catch (e) {
      log('⚠ ' + e.message);
      if (radio.failed) { await stop(); setStatus('Disconnected: ' + e.message, false); break; }
      await new Promise(r => setTimeout(r, 300));
    }
    await new Promise(r => requestAnimationFrame(r));
  }
}

// Fill the Span and Analog filter menus from what the board reported.
const BW_STEPS = [62, 50, 40, 30, 24, 20, 16, 14];
function applyLimits(info) {
  const rate = $('#rate'), keep = Number(rate.value);
  const rates = [...info.rates].sort((a, b) => b - a);
  rate.replaceChildren(...rates.map(r => new Option(`${r / 1e6} MHz · ${r / 1e6} MS/s`, r)));
  rate.value = rates.includes(keep) ? keep : rates[0];
  rate.disabled = rates.length < 2;
  const bw = $('#bw'), keepBw = bw.value, lim = info.bandwidth;
  const steps = lim ? BW_STEPS.filter(m => m >= lim[0] && m <= lim[1]) : [];
  if (lim && !steps.includes(lim[1])) steps.unshift(lim[1]);
  bw.replaceChildren(new Option('Auto (calibrated)', 'auto'), ...steps.map(m => new Option(`${m} MHz${m === lim[1] ? ' (widest)' : ''}`, m)));
  bw.value = [...bw.options].some(o => o.value === keepBw) ? keepBw : 'auto';
  bw.disabled = !lim;
  if (!lim) bw.title = 'This firmware does not report a characterised filter (LIMITS? bandwidth is null).';
}

async function start(useSim) {
  replay.stop(true);
  session.simulated = useSim;
  const radio = session.radio = useSim ? new SimSdr() : new EspSdr();
  radio.onLog = log;
  try {
    log(useSim ? 'Starting simulator…' : 'Requesting serial port…');
    const info = await radio.connect();
    log(`Connected: ${info.device}${info.simulated ? '' : ' · ' + info.identity}`);
    applyLimits(info);
    setStatus(`${info.device} · ${info.rates.map(r => r / 1e6).join(' / ')} MS/s`, true);
    session.running = true; loop();
  } catch (e) {
    log('✖ ' + e.message); setStatus(e.message, false);
    session.radio = null;
  }
}

async function stop() {
  session.running = false;
  await new Promise(r => setTimeout(r, 60));
  if (session.radio) { try { await session.radio.disconnect(); } catch {} }
  session.radio = null;
  spectrum.reset();
  occupancy.reset();
  jammer.reset();
  setStatus('Not connected', false);
  log('Disconnected.');
}

// ---- wire up controls ----
$('#connect').addEventListener('click', () => start(false));
$('#sim').addEventListener('click', () => start(true));
$('#disconnect').addEventListener('click', stop);

$('#rate').addEventListener('change', () => { spectrum.reset(); log(`span → ${Number($('#rate').value) / 1e6} MHz`); });
$('#bw').addEventListener('change', () => log(`analog filter → ${$('#bw').value === 'auto' ? 'auto' : $('#bw').value + ' MHz'}`));
$('#gain').addEventListener('input', () => { $('#gainval').textContent = $('#gain').value; });
$('#agc').addEventListener('change', () => { $('#gain').disabled = $('#agc').checked; });
$('#hold').addEventListener('change', () => { spectrum.resetHold(); $('#holdreset').disabled = $('#hold').value === 'live'; });
$('#holdreset').addEventListener('click', () => spectrum.resetHold());

// serial log send box (handy during a demo for poking the firmware)
$('#logsend').addEventListener('click', async () => {
  const cmd = $('#logcmd').value.trim();
  const radio = session.radio;
  if (!cmd || !radio || session.simulated) { if (session.simulated) log('(simulator: commands are not sent)'); return; }
  try { await radio._cmd(cmd); log('→ ' + cmd); } catch (e) { log('⚠ ' + e.message); }
});

// ---- doc views + firmware install ----
initViews(
  $('#instrument'),
  { hardware: $('#hardware'), firmware: $('#firmware'), about: $('#about') },
  [...document.querySelectorAll('nav a[data-view]')],
);
initInstall({
  installJammer: $('#fwInstallJammer'), status: $('#fwStatus'), bar: $('#fwBar'), log: $('#fwLog'), noRepl: $('#fwNoRepl'),
  cpFile: $('#cpFile'), cpLoad: $('#cpLoad'), cpName: $('#cpName'), cpFlash: $('#cpFlash'),
}, { releaseSerial: async () => { if (session.radio && !session.simulated) await stop(); } });

// Browser capability hint
if (!navigator.serial) $('#nowebserial').hidden = false;

setStatus('Not connected', false);
log('Ready. Click "Try without hardware" for the simulator, or "Connect board" with a XIAO C3 running ESP-SDR.');
