'use strict';

/*
 * beacon-panel.js — "Beacon control": drive the beacon board directly over
 * its own USB port (js/device/beacon-link.js) instead of, or as well as, the
 * single enable wire. Transmit on/off, channel, power, a channel sweep, a
 * power-step run for the path-loss lab, and Morse keying you can read off
 * the waterfall.
 *
 * In the simulator the same panel drives a SimBeacon inside the simulated
 * radio, so every control has a visible effect without hardware.
 */

import { $ } from './dom.js';
import { BeaconLink } from '../device/beacon-link.js';
import { SimBeacon } from '../sim.js';

const POWER_STEPS = [20, 17, 14, 11, 8, 5, 2];   // dBm, 3 dB apart
const STEP_MS = 3000;

/**
 * @param {object} o
 * @param {(line:string) => void} o.log
 * @param {object} o.session                  { radio, simulated } — read live
 * @param {(label:string) => void} o.mark     drop a labelled mark (starts a recording if needed)
 */
export function initBeaconPanel({ log, session, mark }) {
  const ui = {
    connect: $('#bcConnect'), on: $('#bcOn'), ch: $('#bcCh'), pwr: $('#bcPwr'), pwrVal: $('#bcPwrVal'),
    sweep: $('#bcSweep'), steps: $('#bcSteps'), text: $('#bcMorse'), wpm: $('#bcWpm'), key: $('#bcKey'), unkey: $('#bcUnkey'),
    status: $('#bcStatus'), hint: $('#bcHint'),
  };
  ui.ch.replaceChildren(...Array.from({ length: 13 }, (_, k) => new Option(`${k + 1} · ${2412 + 5 * k} MHz`, k + 1)));
  ui.ch.value = 6;
  let link = null, sweepTimer = null, stepTimer = null;

  const controls = [ui.on, ui.ch, ui.pwr, ui.sweep, ui.steps, ui.text, ui.wpm, ui.key, ui.unkey];
  function refresh() {
    const up = !!link;
    controls.forEach(el => { el.disabled = !up; });
    ui.connect.textContent = up ? 'Disconnect beacon' : 'Connect beacon board';
    const s = link?.state;
    ui.on.textContent = s?.on ? 'Transmit: ON' : 'Transmit: off';
    ui.on.classList.toggle('on', !!s?.on);
    if (s?.ch) ui.ch.value = s.ch;
    if (s?.pwr != null && s.pwr >= 0) { ui.pwrVal.textContent = s.pwr.toFixed(1); }
    ui.status.textContent = up ? `${link instanceof SimBeacon ? 'simulated beacon' : 'beacon'} · ch ${s.ch} · ${s.pwr != null && s.pwr >= 0 ? s.pwr.toFixed(1) + ' dBm' : 'power ?'}${s.on ? ' · transmitting' : ''}${s.morse ? ' · keying Morse' : ''}`
      : (session.simulated ? 'Simulator running: connect to drive the simulated beacon.' : 'Not connected. Plug the beacon board in by USB, then connect.');
    ui.status.className = 'recstatus' + (s?.on || s?.morse ? ' on' : '');
    hint();
  }
  function hint() {
    const agc = $('#agc').checked;
    ui.hint.hidden = !ui.steps.checked;
    ui.hint.textContent = ui.steps.checked && agc
      ? 'Hardware AGC is on: the receiver will turn its own gain down as the beacon gets louder and hide the steps. Untick Hardware AGC for this lab.'
      : ui.steps.checked ? `Power steps: ${POWER_STEPS.join(' → ')} dBm, ${STEP_MS / 1000} s each, a mark at every step. Record with summary.csv, then plot peak_dbfs against beacon_pwr_dbm.` : '';
  }
  const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { log('⚠ ' + e.message); } refresh(); };

  async function connect() {
    if (link) { await disconnect(); return; }
    const l = session.simulated && session.radio ? new SimBeacon(session.radio) : new BeaconLink();
    if (!(l instanceof SimBeacon) && !navigator.serial) { log('⚠ this browser has no Web Serial: use Chrome or Edge to drive the beacon board'); return; }
    l.onInfo = line => log('[beacon] ' + line);
    l.onDrop = e => { log('⚠ beacon port dropped: ' + (e?.message || e)); link = null; stopTimers(); refresh(); };
    try {
      log(l instanceof SimBeacon ? '[beacon] simulated beacon' : '[beacon] pick the beacon board\'s port…');
      const r = await l.connect();
      link = l;
      log('[beacon] ' + r.id);
      if (link.state.pwr != null && link.state.pwr >= 0) ui.pwr.value = Math.round(link.state.pwr);
    } catch (e) { log('✖ beacon: ' + e.message); }
    refresh();
  }
  async function disconnect() {
    stopTimers();
    const l = link; link = null;
    if (l) { try { await l.close(); } catch {} log('[beacon] disconnected'); }
    refresh();
  }
  function stopTimers() {
    if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; }
    if (stepTimer) { clearTimeout(stepTimer); stepTimer = null; }
    ui.sweep.checked = false; ui.steps.checked = false;
  }

  ui.connect.addEventListener('click', connect);
  ui.on.addEventListener('click', guard(async () => { await link.setOn(!link.state.on); log(`[beacon] transmit ${link.state.on ? 'on' : 'off'}`); }));
  ui.ch.addEventListener('change', guard(async () => { await link.setChannel(Number(ui.ch.value)); log(`[beacon] channel ${ui.ch.value}`); }));
  ui.pwr.addEventListener('input', () => { ui.pwrVal.textContent = Number(ui.pwr.value).toFixed(1); });
  ui.pwr.addEventListener('change', guard(async () => { const p = await link.setPower(Number(ui.pwr.value)); log(`[beacon] power ${p} dBm`); }));
  ui.key.addEventListener('click', guard(async () => {
    const t = ui.text.value.trim(); if (!t) { log('⚠ type something to key'); return; }
    await link.setWpm(Number(ui.wpm.value)); await link.morse(t);
    log(`[beacon] keying "${t}" at ${ui.wpm.value} WPM — read it off the waterfall`);
  }));
  ui.text.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); ui.key.click(); } });
  ui.unkey.addEventListener('click', guard(async () => { await link.morse(''); log('[beacon] Morse stopped'); }));
  ui.wpm.addEventListener('change', guard(async () => { if (link.state.morse) await link.setWpm(Number(ui.wpm.value)); }));

  ui.sweep.addEventListener('change', guard(async () => {
    if (!ui.sweep.checked) { clearInterval(sweepTimer); sweepTimer = null; log('[beacon] sweep off'); return; }
    if (!link.state.on) await link.setOn(true);
    log('[beacon] stepping channels 1 → 13, one a second');
    sweepTimer = setInterval(guard(async () => {
      if (!link) return;
      const next = (link.state.ch % 13) + 1;
      await link.setChannel(next);
    }), 1000);
  }));

  ui.steps.addEventListener('change', guard(async () => {
    if (!ui.steps.checked) { clearTimeout(stepTimer); stepTimer = null; log('[beacon] power steps stopped'); return; }
    if (!link.state.on && !link.state.morse) await link.setOn(true);
    let i = 0;
    const step = guard(async () => {
      if (!link || !ui.steps.checked) return;
      if (i >= POWER_STEPS.length) { ui.steps.checked = false; stepTimer = null; log('[beacon] power steps done'); return; }
      const p = await link.setPower(POWER_STEPS[i++]);
      ui.pwr.value = Math.round(p);
      mark(`beacon ${p} dBm`);
      stepTimer = setTimeout(step, STEP_MS);
    });
    step();
  }));
  $('#agc').addEventListener('change', hint);

  refresh();
  return {
    /** For summary.csv: null when no beacon is connected. */
    state: () => (link ? { ...link.state } : null),
    /** The simulator went away: a simulated beacon goes with it. */
    radioChanged() { if (link instanceof SimBeacon) { stopTimers(); link = null; } refresh(); },
  };
}
