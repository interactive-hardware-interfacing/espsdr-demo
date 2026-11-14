'use strict';

/*
 * jammer.js — the Jammer button and the Sweep box. Both drive the receiver's
 * spare GPIO (pin 4) through ESP-SDR's GPIO command; the jammer board reads
 * that line on its D2.
 *
 * Sweep: the jammer firmware counts short lows (< 300 ms) while enabled as
 * "next channel"; the page drops GPIO4 for ~30 ms and raises it again once a
 * second. One wire.
 */

import { $ } from './dom.js';

/**
 * @param {object} o
 * @param {(line:string) => void} o.log
 * @param {object} o.session   { radio } — read live
 * @returns {{ isOn: () => boolean, reset: () => void, refresh: (connected:boolean) => void }}
 */
export function initJammer({ log, session }) {
  const btn = $('#jammer'), sweep = $('#sweep');
  const isOn = () => btn.classList.contains('on');
  const pin = () => session.radio?.gpioPins.find(p => p.pin === 4) || session.radio?.gpioPins[0];

  btn.addEventListener('click', async () => {
    const radio = session.radio;
    if (!radio?.hasGpio) return;
    const entry = pin();
    if (!entry) { log('No spare GPIO on this firmware.'); return; }
    const next = entry.state === '1' ? 'Z' : '1';
    try {
      await radio.setGpio(entry.pin, next);
      const on = next === '1';
      btn.textContent = on ? 'Jammer: ON' : 'Jammer: off';
      btn.classList.toggle('on', on);
      if (!on) sweepStop();
      log(`Jammer GPIO${entry.pin} → ${next}`);
    } catch (e) { log('⚠ ' + e.message); }
  });

  let sweepTimer = null;
  function sweepStop() { if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null; log('[sweep] off'); } sweep.checked = false; }
  sweep.addEventListener('change', async () => {
    if (!sweep.checked) { sweepStop(); return; }
    if (!session.radio?.hasGpio) { sweep.checked = false; return; }
    const entry = pin();
    if (!isOn()) { btn.click(); await new Promise(r => setTimeout(r, 100)); }
    log('[sweep] stepping the jammer across channels once a second');
    sweepTimer = setInterval(async () => {
      const radio = session.radio;
      if (!radio || !isOn()) { sweepStop(); return; }
      try { await radio.setGpio(entry.pin, 'Z'); await new Promise(r => setTimeout(r, 30)); await radio.setGpio(entry.pin, '1'); }
      catch (e) { log('⚠ sweep pulse: ' + e.message); sweepStop(); }
    }, 1000);
  });

  return {
    isOn,
    /** After a disconnect: sweep off, button back to off. */
    reset() { sweepStop(); btn.textContent = 'Jammer: off'; btn.classList.remove('on'); },
    refresh(connected) {
      btn.disabled = !connected || !session.radio?.hasGpio;
      sweep.disabled = !connected || !session.radio?.hasGpio;
    },
  };
}
