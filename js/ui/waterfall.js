'use strict';

/*
 * waterfall.js — the scrolling waterfall under the spectrum. One bitmap row
 * (one CSS pixel) per capture, newest at the top; marks are painted straight
 * into the bitmap so they scroll with the history they tag.
 */

import { cssVar } from './dom.js';

// Waterfall colormap (0..1 -> rgb). The bottom of the range fades into the
// page background so quiet bins recede and only energy lights up; above that
// it runs blue -> green -> yellow -> red like a conventional waterfall.
export function heat(t) {
  t = Math.max(0, Math.min(1, t));
  const r = 255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * t - 3)));
  const g = 255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * t - 2)));
  const b = 255 * Math.min(1, Math.max(0, 1.5 - Math.abs(4 * t - 1)));
  const k = Math.min(1, t / 0.35);                 // 0 at the floor, 1 from 35 % up
  return [Math.round(r * k + 20 * (1 - k)), Math.round(g * k + 26 * (1 - k)), Math.round(b * k + 34 * (1 - k))];
}

export class WaterfallView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { willReadFrequently: true });
    this.row = null;
  }

  // The waterfall scrolls by copying its own pixels, so a resize must carry the
  // old rows across rather than wipe them. One bitmap row per capture; the row
  // height follows DPR so it stays one CSS pixel tall.
  fit() {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width === w && canvas.height === h) return;
    let old = null;
    try { old = canvas.width && canvas.height ? ctx.getImageData(0, 0, canvas.width, canvas.height) : null; } catch {}
    canvas.width = w; canvas.height = h;
    this.row = null;
    if (old) {
      // stretch the old history onto the new size (stays readable; exact pixels don't matter)
      const tmp = document.createElement('canvas'); tmp.width = old.width; tmp.height = old.height;
      tmp.getContext('2d').putImageData(old, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tmp, 0, 0, w, h);
    }
  }

  /** Add one capture's bins (dBFS, lowest frequency first) as a new top row. */
  push(bins, floor, range) {
    this.fit();
    const { canvas, ctx } = this;
    const wfW = canvas.width, wfH = canvas.height;
    const rowH = Math.max(1, Math.round(window.devicePixelRatio || 1));
    if (!this.row || this.row.width !== wfW || this.row.height !== rowH) this.row = ctx.createImageData(wfW, rowH);
    const data = this.row.data;
    for (let x = 0; x < wfW; x++) {
      const i = Math.floor(x / wfW * bins.length);
      const [r, g, b] = heat((bins[i] - floor) / range);
      for (let y = 0; y < rowH; y++) {
        const o = (y * wfW + x) * 4;
        data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
      }
    }
    if (wfH > rowH) {
      const prev = ctx.getImageData(0, 0, wfW, wfH - rowH);
      ctx.putImageData(prev, 0, rowH);
    }
    ctx.putImageData(this.row, 0, 0);
  }

  /** A mark: a magenta row with its label, painted into the bitmap. */
  mark(label) {
    this.fit();
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1, rowH = Math.max(1, Math.round(dpr));
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = cssVar('--magenta'); ctx.fillRect(0, 0, canvas.width, rowH);
    ctx.font = `${Math.round(10 * dpr)}px system-ui, sans-serif`; ctx.textBaseline = 'top';
    const w = ctx.measureText(label).width + 6 * dpr;
    ctx.fillStyle = 'rgba(7,9,12,.75)'; ctx.fillRect(4 * dpr, rowH + 2 * dpr, w, 13 * dpr);
    ctx.fillStyle = cssVar('--magenta'); ctx.fillText(label, 7 * dpr, rowH + 3 * dpr);
    ctx.restore();
  }
}
