'use strict';

/*
 * spectrum.js — the power-spectrum plot: averaged live trace, optional
 * peak/max hold, Wi-Fi channel lines, up to two markers with live dB
 * readouts, a hover cursor, and click-to-tune / shift-click-for-marker.
 */

import { cssVar, fit } from './dom.js';

export class SpectrumView {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} o
   * @param {() => {floor:number, range:number, avgmode:string, hold:string}} o.display  current display settings
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
  reset() { this.avg = null; this.hold = null; }
  resetHold() { this.hold = null; }

  // clicking within 1 MHz of an existing marker removes it
  toggleMarker(mhz) {
    const { markers } = this;
    const k = markers.findIndex(m => Math.abs(m.mhz - mhz) < 1);
    if (k >= 0) { markers.splice(k, 1); this.log('marker removed'); }
    else if (markers.length < 2) { markers.push({ mhz: Math.round(mhz * 10) / 10 }); this.log(`marker M${markers.length} at ${mhz.toFixed(1)} MHz`); }
    else this.log('two markers already placed — shift-click one to remove it');
  }

  draw(bins, centerMHz, rateHz) {
    const { canvas, ctx } = this;
    const { W, H } = fit(canvas, ctx);
    const { floor, range, avgmode, hold: hm } = this.display();
    ctx.clearRect(0, 0, W, H);

    // grid + channel markers
    ctx.strokeStyle = cssVar('--grid'); ctx.lineWidth = 1;
    ctx.fillStyle = cssVar('--muted'); ctx.font = '11px system-ui, sans-serif';
    const spanMHz = rateHz / 1e6;
    const loMHz = centerMHz - spanMHz / 2, hiMHz = centerMHz + spanMHz / 2;
    for (const ch of [[2412, '1'], [2437, '6'], [2462, '11']]) {
      if (ch[0] < loMHz || ch[0] > hiMHz) continue;
      const x = (ch[0] - loMHz) / spanMHz * W;
      ctx.globalAlpha = 0.5;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillText('Wi‑Fi ' + ch[1], x + 3, 12);
    }

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
      ctx.fillStyle = cssVar('--green'); ctx.fillText(label, Math.min(x + 4, W - ctx.measureText(label).width - 2), H - 6 - 14 * k);
      m.db = db;
    });

    // hover cursor
    if (this.hoverX != null) {
      const hx = this.hoverX, mhz = loMHz + hx / W * spanMHz;
      ctx.save(); ctx.strokeStyle = cssVar('--muted'); ctx.globalAlpha = .7; ctx.beginPath(); ctx.moveTo(hx, 0); ctx.lineTo(hx, H); ctx.stroke(); ctx.restore();
      ctx.fillStyle = cssVar('--text'); const t = `${mhz.toFixed(1)} MHz`; ctx.fillText(t, Math.min(hx + 5, W - ctx.measureText(t).width - 2), 26);
    }
  }
}
