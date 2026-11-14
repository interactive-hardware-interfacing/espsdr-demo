'use strict';

/*
 * replay.js — play a downloaded log .zip back into the page at the recorded
 * pace: spectrum, waterfall, stats, marks, and I/Q where snapshots were kept.
 * No board needed.
 */

import { $ } from './dom.js';
import { parseLog, readNpy } from '../logger.js';

/**
 * @param {object} o
 * @param {(line:string) => void} o.log
 * @param {(frame:{bins:Float32Array|number[], center:number, rate:number, iq?:Float32Array}) => void} o.render
 * @param {(label:string) => void} o.markWaterfall
 * @param {import('./stats.js').Stats} o.stats
 * @param {(text:string, connected:boolean) => void} o.setStatus
 * @param {() => void} o.onStart     reset views before the first frame
 * @returns {{ stop: (silent?:boolean) => void, get active(): boolean }}
 */
export function initReplay({ log, render, markWaterfall, stats, setStatus, onStart }) {
  let replay = null;   // {name, data, i, timer, paused}

  $('#replayLoad').addEventListener('click', () => $('#replayFile').click());
  $('#replayFile').addEventListener('change', async () => {
    const f = $('#replayFile').files?.[0]; $('#replayFile').value = '';
    if (!f) return;
    try {
      const data = parseLog(await f.arrayBuffer());
      if (!data.frames.length) throw new Error('no spectrum rows in this log');
      start(f.name, data);
    } catch (e) { log('⚠ replay: ' + e.message); }
  });

  function start(name, data) {
    stop(true);
    replay = { name, data, i: 0, paused: false, t0: performance.now() };
    onStart();
    setStatus(`replaying ${name}`, false);
    $('#status').className = 'replay';
    $('#connect').disabled = $('#sim').disabled = $('#replayLoad').disabled = true;
    $('#replayPause').hidden = $('#replayStop').hidden = false; $('#replayPause').textContent = 'Pause';
    log(`[replay] ${name}: ${data.frames.length} frames, ${data.iq.size} I/Q snapshots, ${data.marks.size} marks`);
    tick();
  }

  function tick() {
    if (!replay || replay.paused) return;
    const { data } = replay;
    if (replay.i >= data.frames.length) { replay.i = 0; replay.t0 = performance.now(); log('[replay] looping'); }
    const fr = data.frames[replay.i];
    const n = fr.bins.length, lo = fr.bins[0], hi = fr.bins[n - 1], center = (lo + hi) / 2, rate = (hi - lo) * 1e6 * n / (n - 1);
    let iq = null;
    const iqb = data.iq.get(fr.i); if (iqb) { try { iq = readNpy(iqb); } catch (e) { log('⚠ ' + e.message); } }
    render({ bins: fr.db, center, rate, iq });
    const s = data.summary.get(fr.i);
    if (s) stats.show({ peakMHz: s.peak_mhz, peakDb: s.peak_dbfs, captureUs: s.capture_us, retries: s.retries });
    else { let p = 0; for (let k = 1; k < fr.db.length; k++) if (fr.db[k] > fr.db[p]) p = k; stats.show({ peakMHz: fr.bins[p], peakDb: fr.db[p] }); }
    stats.show({ rbwKHz: rate / n / 1e3 });
    for (const m of data.marks.get(fr.i) || []) markWaterfall(m);
    stats.fps('replay');
    replay.i++;
    // pace by the recorded timestamps; fall back to 15 fps if there is no gap
    const next = data.frames[replay.i], dt = next ? Math.max(16, Math.min(1000, (next.t - fr.t) * 1000)) : 66;
    replay.timer = setTimeout(tick, dt);
  }

  function stop(silent) {
    if (!replay) return;
    clearTimeout(replay.timer); replay = null;
    $('#replayPause').hidden = $('#replayStop').hidden = true;
    if (!silent) { setStatus('Not connected', false); stats.fps('—'); log('[replay] stopped'); }
  }

  $('#replayPause').addEventListener('click', () => { if (!replay) return; replay.paused = !replay.paused; $('#replayPause').textContent = replay.paused ? 'Resume' : 'Pause'; if (!replay.paused) tick(); });
  $('#replayStop').addEventListener('click', () => stop(false));

  return { stop, get active() { return !!replay; } };
}
