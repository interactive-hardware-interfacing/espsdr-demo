'use strict';

/*
 * timeview.js — one capture in the time domain. A C3 burst is 16 380
 * samples: about 205 µs at 80 MS/s, 1 ms at 16 MS/s. That is long enough to
 * see individual Wi-Fi / BLE / ESP-NOW packets switch on and off, which the
 * spectrum (an average over the whole burst) hides.
 *
 *   envelope  |I + jQ| — packet on/off, the thing to look at first
 *   I and Q   both components — the raw waveform
 *
 * Each pixel column draws the min..max of the samples it covers, so nothing
 * is lost to decimation. Two readouts: how much of the capture is "on air"
 * (envelope more than ~10 dB above a noise estimate taken from the quietest
 * quarter-microsecond blocks), and how many samples hit full scale — clipping, which the
 * Wi-Fi AGC does not prevent for a strong continuous signal.
 */

import { cssVar, fit } from './dom.js';

const CLIP = 0.98;      // |I| or |Q| at or above this counts as full scale (8-bit tops out at 127/128)
const ON_AIR = 3.16;    // envelope / noise ratio that counts as "on air" (+10 dB)

export class TimeView {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {() => {mode:'env'|'iq', window:number}} display   window = fraction of the capture to show
   * @param {(text:string, warn:boolean) => void} onReadout
   */
  constructor(canvas, display, onReadout) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d');
    this.display = display; this.onReadout = onReadout;
  }

  draw(iq, rateHz) {
    const { canvas, ctx } = this;
    const { W, H } = fit(canvas, ctx);
    const { mode, window: frac } = this.display();
    const total = iq.length / 2, n = Math.max(16, Math.floor(total * frac));
    const us = n / rateHz * 1e6;
    ctx.clearRect(0, 0, W, H);

    // whole-capture readouts (independent of the window)
    const env = new Float32Array(total);
    let clipped = 0;
    for (let j = 0; j < total; j++) {
      const i = iq[2 * j], q = iq[2 * j + 1];
      env[j] = Math.hypot(i, q);
      if (Math.abs(i) >= CLIP || Math.abs(q) >= CLIP) clipped++;
    }
    // Noise level from the quietest stretches: average the envelope over
    // ~0.25 µs blocks and take the 1st-percentile block. In a busy band the
    // median is signal, but a few blocks always fall between packets.
    const B = Math.max(16, Math.round(rateHz / 4e6)), means = [];
    for (let b = 0; b + B <= total; b += B) { let m = 0; for (let j = b; j < b + B; j++) m += env[j]; means.push(m / B); }
    means.sort((a, b) => a - b);
    const noise = Math.max(means[Math.floor(means.length * 0.01)] || 0, 1 / 128), thresh = noise * ON_AIR;
    let on = 0; for (let j = 0; j < total; j++) if (env[j] > thresh) on++;

    // axes: time ticks along the bottom, zero / full-scale lines
    const padB = 14, plotH = H - padB;
    const yOf = mode === 'env' ? v => plotH - v * (plotH - 4) : v => plotH / 2 - v * (plotH / 2 - 3);
    ctx.strokeStyle = cssVar('--grid'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, yOf(0)); ctx.lineTo(W, yOf(0)); ctx.stroke();
    ctx.save(); ctx.setLineDash([3, 4]); ctx.strokeStyle = cssVar('--err'); ctx.globalAlpha = .6;
    ctx.beginPath(); ctx.moveTo(0, yOf(1)); ctx.lineTo(W, yOf(1));
    if (mode === 'iq') { ctx.moveTo(0, yOf(-1)); ctx.lineTo(W, yOf(-1)); }
    ctx.stroke(); ctx.restore();
    ctx.fillStyle = cssVar('--faint'); ctx.font = '10px ui-monospace, monospace';
    ctx.fillText('full scale', 4, yOf(1) + 11);
    const step = [1, 2, 5, 10, 20, 50, 100, 200, 500].find(s => us / s <= 8) || 1000;
    for (let t = 0; t <= us; t += step) {
      const x = t / us * W;
      ctx.beginPath(); ctx.moveTo(x, plotH); ctx.lineTo(x, plotH + 4); ctx.stroke();
      const lab = t + (t === 0 ? ' µs' : ''), w = ctx.measureText(lab).width;
      if (x + w < W - 2) ctx.fillText(lab, Math.max(1, x - (t ? w / 2 : 0)), H - 2);
    }
    if (mode === 'env') {   // the on-air threshold
      ctx.save(); ctx.setLineDash([2, 3]); ctx.strokeStyle = cssVar('--muted'); ctx.globalAlpha = .6;
      ctx.beginPath(); ctx.moveTo(0, yOf(Math.min(1, thresh))); ctx.lineTo(W, yOf(Math.min(1, thresh))); ctx.stroke(); ctx.restore();
    }

    // traces: per-column min/max
    const cols = Math.max(1, Math.floor(W));
    const series = mode === 'env' ? [[j => env[j], '--accent']] : [[j => iq[2 * j], '--accent'], [j => iq[2 * j + 1], '--yellow']];
    for (const [get, color] of series) {
      ctx.strokeStyle = cssVar(color); ctx.lineWidth = 1; ctx.globalAlpha = mode === 'iq' ? 0.8 : 1;
      ctx.beginPath();
      if (n < 2 * cols) {   // zoomed in past one sample per two pixels: join the dots
        for (let j = 0; j < n; j++) { const x = (j + 0.5) / n * W, y = yOf(get(j)); j ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      } else for (let c = 0; c < cols; c++) {
        const a = Math.floor(c / cols * n), b = Math.max(a + 1, Math.floor((c + 1) / cols * n));
        let lo = Infinity, hi = -Infinity;
        for (let j = a; j < b; j++) { const v = get(j); if (v < lo) lo = v; if (v > hi) hi = v; }
        const x = c + 0.5;
        ctx.moveTo(x, yOf(hi)); ctx.lineTo(x, Math.max(yOf(lo), yOf(hi) + 1));
      }
      ctx.stroke(); ctx.globalAlpha = 1;
    }

    const capUs = total / rateHz * 1e6;
    const text = `${total} samples · ${capUs.toFixed(capUs < 100 ? 1 : 0)} µs · on air ${(on / total * 100).toFixed(0)} %`
      + (clipped ? ` · clipping: ${clipped} samples at full scale` : '');
    this.onReadout(text, clipped > 0);
  }
}
