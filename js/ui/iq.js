'use strict';

/*
 * iq.js — the I/Q scatter ("constellation"): every sample of one capture as a
 * dot, I across, Q up, full scale on the circle.
 */

import { cssVar, fit } from './dom.js';

export class IqView {
  constructor(canvas) { this.canvas = canvas; this.ctx = canvas.getContext('2d'); }

  draw(iq) {
    const { canvas, ctx } = this;
    const { W, H } = fit(canvas, ctx);
    const cx = W / 2, cy = H / 2, s = Math.min(W, H) * 0.45;
    ctx.fillStyle = cssVar('--panel'); ctx.fillRect(0, 0, W, H);
    // axes
    ctx.strokeStyle = cssVar('--grid'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, H); ctx.moveTo(0, cy); ctx.lineTo(W, cy); ctx.stroke();
    ctx.strokeStyle = cssVar('--grid'); ctx.globalAlpha = 0.5;
    ctx.beginPath(); ctx.arc(cx, cy, s, 0, 2 * Math.PI); ctx.stroke(); ctx.globalAlpha = 1;
    // dots — subsample so we draw a few thousand, not 16k
    ctx.fillStyle = cssVar('--accent');
    const n = iq.length / 2, step = Math.max(1, Math.floor(n / 3000));
    for (let j = 0; j < n; j += step) {
      const x = cx + iq[2 * j] * s, y = cy - iq[2 * j + 1] * s;
      ctx.fillRect(x, y, 1.5, 1.5);
    }
    ctx.fillStyle = cssVar('--muted'); ctx.font = '11px system-ui, sans-serif';
    ctx.fillText('I', W - 12, cy - 4); ctx.fillText('Q', cx + 4, 12);
  }
}
