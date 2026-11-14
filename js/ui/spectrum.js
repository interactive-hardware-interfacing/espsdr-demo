'use strict';

/*
 * spectrum.js — the power-spectrum plot: averaged live trace, optional
 * peak/max hold, an optional persistence (density) layer, a band overlay (Wi-Fi / BLE / 802.15.4, bands.js), up to two markers with live dB
 * readouts, a hover cursor, and click-to-tune / shift-click-for-marker.
 */

import { cssVar, fit } from './dom.js';
import { drawBands } from './bands.js';
import { heat } from './waterfall.js';

const HEAT = Array.from({ length: 256 }, (_, i) => heat(i / 255));
const PERSIST_DECAY = 0.94;   // per frame: a hit fades to ~10 % in about 40 frames

export class SpectrumView {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} o
   * @param {() => {floor:number, range:number, avgmode:string, hold:string, bands:string, persist:boolean}} o.display  current display settings
   * @param {(mhz:number) => void} o.onTune     plain click
   * @param {(text:string) => void} o.onHover   hover readout text ('' when the mouse leaves)
   * @param {(msg:string) => void} o.log
   */
  constructor(canvas, { display, onTune, onHover, log }) {
    this.canvas = canvas; this.ctx = canvas.getContext('2d');
    this.display = display; this.log = log;
    this.avg = null;                                   // trace averaging buffer
    this.hold = null;                                  // peak/max hold buffer (dB per bin)
    this.axis = { lo: 2402, hi: 2482, n: 2048 };       // what was last drawn, for click → MHz
    this.hoverX = null;                                // CSS px under the mouse, or null
    this.markers = [];                                 // [{mhz, db}] up to 2

    const toMHz = ev => {
      const r = canvas.getBoundingClientRect();
      const x = Math.max(0, Math.min(r.width, ev.clientX - r.left));
      return { x, mhz: this.axis.lo + x / r.width * (this.axis.hi - this.axis.lo) };
    };
    canvas.addEventListener('mousemove', ev => { const { x, mhz } = toMHz(ev); this.hoverX = x; onHover(`${mhz.toFixed(1)} MHz`); });
    canvas.addEventListener('mouseleave', () => { this.hoverX = null; onHover(''); });
    canvas.addEventListener('click', ev => {
      const { mhz } = toMHz(ev);
      if (ev.shiftKey) this.toggleMarker(mhz);
      else onTune(mhz);
    });
  }

  /** Forget averaging and hold (new connection, new replay). */
  reset() { this.avg = null; this.hold = null; this.dens = null; }
  resetHold() { this.hold = null; }

  // clicking within 1 MHz of an existing marker removes it
  toggleMarker(mhz) {
    const { markers } = this;
    const k = markers.findIndex(m => Math.abs(m.mhz - mhz) < 1);
    if (k >= 0) { markers.splice(k, 1); this.log('marker removed'); }
    else if (markers.length < 2) { markers.push({ mhz: Math.round(mhz * 10) / 10 }); this.log(`marker M${markers.length} at ${mhz.toFixed(1)} MHz`); }
    else this.log('two markers already placed — shift-click one to remove it');
  }

  // Persistence: a decaying 2-D histogram (column × dB row) of the raw,
  // unaveraged bins at CSS-pixel resolution, drawn under everything else.
  drawPersistence(bins, { W, H, floor, range, key }) {
    const w = Math.max(1, Math.round(W)), h = Math.max(1, Math.round(H));
    let d = this.dens;
    if (!d || d.w !== w || d.h !== h || d.key !== key) {
      const off = document.createElement('canvas'); off.width = w; off.height = h;
      d = this.dens = { w, h, key, cell: new Float32Array(w * h), off, octx: off.getContext('2d'), img: null };
      d.img = d.octx.createImageData(w, h);
    }
    const { cell, img } = d;
    for (let k = 0; k < cell.length; k++) cell[k] *= PERSIST_DECAY;
    const n = bins.length;
    for (let x = 0; x < w; x++) {
      const a = Math.floor(x / w * n), z = Math.max(a + 1, Math.floor((x + 1) / w * n));
      for (let i = a; i < z; i++) {
        const y = Math.floor((1 - (bins[i] - floor) / range) * h);
        if (y >= 0 && y < h) cell[y * w + x] += 1 / (z - a);
      }
    }
    let max = 1e-6; for (let k = 0; k < cell.length; k++) if (cell[k] > max) max = cell[k];
    const lmax = Math.log1p(max), px = img.data;
    for (let k = 0; k < cell.length; k++) {
      const v = cell[k], o = k * 4;
      if (v < 0.02) { px[o + 3] = 0; continue; }
      const c = HEAT[Math.min(255, Math.round(Math.log1p(v) / lmax * 255))];
      px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255;
    }
    d.octx.putImageData(img, 0, 0);
    this.ctx.drawImage(d.off, 0, 0, W, H);
  }

  draw(bins, centerMHz, rateHz) {
    const { canvas, ctx } = this;
    const { W, H } = fit(canvas, ctx);
    const { floor, range, avgmode, hold: hm, bands = 'wifi', persist = false } = this.display();
    ctx.clearRect(0, 0, W, H);

    // grid + channel markers
    ctx.strokeStyle = cssVar('--grid'); ctx.lineWidth = 1;
    ctx.fillStyle = cssVar('--muted'); ctx.font = '11px system-ui, sans-serif';
    const spanMHz = rateHz / 1e6;
    const loMHz = centerMHz - spanMHz / 2, hiMHz = centerMHz + spanMHz / 2;

    // frequency axis: ticks + MHz labels along the bottom, about 8 across
    const step = [1, 2, 5, 10, 20, 50].find(s => spanMHz / s <= 9) || 50;
    ctx.save(); ctx.fillStyle = cssVar('--faint'); ctx.font = '10px ui-monospace, monospace'; ctx.textBaseline = 'alphabetic';
    for (let f = Math.ceil(loMHz / step) * step; f <= hiMHz; f += step) {
      const x = (f - loMHz) / spanMHz * W;
      ctx.beginPath(); ctx.moveTo(x, H); ctx.lineTo(x, H - 5); ctx.stroke();
      const t = String(f), tw = ctx.measureText(t).width;
      if (x - tw / 2 > 2 && x + tw / 2 < W - 2) ctx.fillText(t, x - tw / 2, H - 7);
    }
    ctx.restore();
    if (persist) this.drawPersistence(bins, { W, H, floor, range, key: `${centerMHz}|${rateHz}|${floor}|${range}` });
    else this.dens = null;
    const labelsEnd = drawBands(ctx, { W, H, loMHz, hiMHz, choice: bands });

    // averaging
    if (avgmode === 'off' || !this.avg || this.avg.length !== bins.length) this.avg = Float32Array.from(bins);
    else {
      const a = avgmode === 'short' ? 0.5 : avgmode === 'medium' ? 0.25 : 0.12;
      for (let i = 0; i < bins.length; i++) this.avg[i] = this.avg[i] * (1 - a) + bins[i] * a;
    }
    const avg = this.avg;

    // trace
    ctx.strokeStyle = cssVar('--accent'); ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < avg.length; i++) {
      const x = i / (avg.length - 1) * W;
      const y = H - (avg[i] - floor) / range * H;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
    this.axis = { lo: loMHz, hi: hiMHz, n: bins.length };

    // peak hold (decays ~1 dB/frame) or max hold (frozen), drawn thin over the live trace
    if (hm === 'live') this.hold = null;
    else {
      if (!this.hold || this.hold.length !== bins.length) this.hold = Float32Array.from(bins);
      const hold = this.hold;
      for (let i = 0; i < bins.length; i++) {
        if (hm === 'peak') hold[i] = Math.max(bins[i], hold[i] - 1);
        else hold[i] = Math.max(bins[i], hold[i]);
      }
      ctx.strokeStyle = cssVar(hm === 'peak' ? '--yellow' : '--magenta'); ctx.lineWidth = 1; ctx.globalAlpha = .9;
      ctx.beginPath();
      for (let i = 0; i < hold.length; i++) { const x = i / (hold.length - 1) * W, y = H - (hold[i] - floor) / range * H; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.stroke(); ctx.globalAlpha = 1;
    }

    // markers: dashed line + live dB readout at that bin
    ctx.font = '11px ui-monospace, monospace';
    this.markers.forEach((m, k) => {
      if (m.mhz < loMHz || m.mhz > hiMHz) return;
      const x = (m.mhz - loMHz) / spanMHz * W, bi = Math.round((m.mhz - loMHz) / spanMHz * (bins.length - 1));
      const db = avg[Math.max(0, Math.min(bins.length - 1, bi))];
      ctx.save(); ctx.strokeStyle = cssVar('--green'); ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); ctx.restore();
      const label = `M${k + 1} ${m.mhz.toFixed(1)} MHz ${db.toFixed(0)} dB`;
      ctx.fillStyle = cssVar('--green'); ctx.fillText(label, Math.min(x + 4, W - ctx.measureText(label).width - 2), H - 22 - 14 * k);
      m.db = db;
    });

    // hover cursor
    if (this.hoverX != null) {
      const hx = this.hoverX, mhz = loMHz + hx / W * spanMHz;
      ctx.save(); ctx.strokeStyle = cssVar('--muted'); ctx.globalAlpha = .7; ctx.beginPath(); ctx.moveTo(hx, 0); ctx.lineTo(hx, H); ctx.stroke(); ctx.restore();
      ctx.fillStyle = cssVar('--text'); const t = `${mhz.toFixed(1)} MHz`; ctx.fillText(t, Math.min(hx + 5, W - ctx.measureText(t).width - 2), Math.max(26, labelsEnd + 2));
    }
  }
}
