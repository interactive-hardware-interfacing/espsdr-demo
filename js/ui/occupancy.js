'use strict';

/*
 * occupancy.js — which channel is busiest? For every capture, each channel of
 * the chosen band (bands.js) is "busy" if its average power across its
 * occupied width sits more than the threshold above the capture's noise
 * floor. Occupancy is the share of the last N captures in which it was busy.
 *
 * Caveats worth saying out loud in a lab:
 *   - a capture is a ~0.2–1 ms snapshot with gaps between them, so this is a
 *     sample of the air, not a continuous duty cycle;
 *   - Wi-Fi channels overlap (1 and 2 share most of their width), so
 *     neighbours always read alike — 1, 6 and 11 are the honest comparison;
 *   - the noise floor is the 20th-percentile bin, which stays noise unless
 *     more than ~80 % of the span is lit.
 */

import { cssVar, fit } from './dom.js';
import { BANDS } from './bands.js';

export class OccupancyView {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {() => {band:string, threshold:number, window:number}} settings
   * @param {(text:string) => void} onReadout
   */
  constructor(canvas, settings, onReadout) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d');
    this.settings = settings; this.onReadout = onReadout;
    this.reset();
  }
  reset() { this.hist = new Map(); this.key = ''; this.frames = 0; }

  /** One capture's bins (dBFS, lowest frequency first). */
  push(bins, centerMHz, rateHz) {
    const { band, threshold, window } = this.settings();
    const b = BANDS[band] || BANDS.wifi;
    const span = rateHz / 1e6, lo = centerMHz - span / 2, n = bins.length;
    const key = `${band}|${centerMHz}|${rateHz}|${threshold}`;
    if (key !== this.key) { this.hist = new Map(); this.key = key; this.frames = 0; }   // new view, new statistics

    const sorted = Float32Array.from(bins).sort();
    const floor = sorted[Math.floor(n * 0.2)];
    const busyAt = floor + threshold;
    this.frames++;
    for (const c of b.channels) {
      if (b === BANDS.ble && !c.key && span > 40) continue;   // same rule as the overlay
      const a = Math.round((c.mhz - c.width / 2 - lo) / span * n), z = Math.round((c.mhz + c.width / 2 - lo) / span * n);
      if (a < 0 || z > n || z <= a) { this.hist.delete(c.ch); continue; }   // not wholly inside the span
      let p = 0; for (let k = a; k < z; k++) p += 10 ** (bins[k] / 10);
      const db = 10 * Math.log10(p / (z - a));
      const h = this.hist.get(c.ch) || [];
      h.push(db > busyAt ? 1 : 0); if (h.length > window) h.shift();
      this.hist.set(c.ch, h);
    }
    this.draw(b, threshold, window);
  }

  draw(b, threshold, window) {
    const { canvas, ctx } = this;
    const { W, H } = fit(canvas, ctx);
    ctx.clearRect(0, 0, W, H);
    const chans = b.channels.filter(c => this.hist.has(c.ch));
    if (!chans.length) { this.onReadout(`no ${b.name} channel fits inside this span — widen it or retune`); return; }
    const padB = 16, padT = 14, slot = W / chans.length, bw = Math.max(2, Math.min(28, slot * 0.7));
    ctx.font = '10px ui-monospace, monospace'; ctx.textAlign = 'center';
    // 50 % guide
    ctx.strokeStyle = cssVar('--grid'); ctx.setLineDash([2, 4]);
    ctx.beginPath(); ctx.moveTo(0, padT + (H - padT - padB) / 2); ctx.lineTo(W, padT + (H - padT - padB) / 2); ctx.stroke(); ctx.setLineDash([]);
    let best = null;
    chans.forEach((c, i) => {
      const h = this.hist.get(c.ch), occ = h.reduce((a, v) => a + v, 0) / h.length;
      // Wi-Fi neighbours overlap, so only 1 / 6 / 11 compete for "busiest"
      if ((b !== BANDS.wifi || c.key) && (!best || occ > best.occ)) best = { c, occ };
      const x = slot * (i + 0.5), bh = occ * (H - padT - padB);
      ctx.fillStyle = cssVar(c.key ? '--accent' : '--muted'); ctx.globalAlpha = c.key ? 1 : 0.6;
      ctx.fillRect(x - bw / 2, H - padB - bh, bw, bh); ctx.globalAlpha = 1;
      const every = Math.ceil(26 / slot);   // thin out labels when there are many channels
      if (c.key || i % every === 0) {
        ctx.fillStyle = cssVar(c.key ? '--text' : '--faint'); ctx.fillText(String(c.ch), x, H - 3);
        if (slot > 22) { ctx.fillStyle = cssVar('--yellow'); ctx.fillText(`${Math.round(occ * 100)}`, x, Math.max(10, H - padB - bh - 3)); }
      }
    });
    ctx.textAlign = 'start';
    const got = Math.min(this.frames, window);
    this.onReadout(`${b.name} · busy = ${threshold} dB over the floor · last ${got} captures` + (best && best.occ > 0 ? ` · busiest: ${b.prefix}${best.c.ch} (${Math.round(best.occ * 100)} %)` : ''));
  }
}
