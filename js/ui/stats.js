'use strict';

/*
 * stats.js — the row of numeric readouts under the instrument.
 */

import { $ } from './dom.js';

export class Stats {
  constructor() { this.frames = 0; this.lastStat = performance.now(); }

  /** One live capture: count frames for the fps readout, show the rest. */
  update(cap) {
    this.frames++;
    const now = performance.now();
    if (now - this.lastStat > 500) {
      $('#fps').textContent = (this.frames / (now - this.lastStat) * 1000).toFixed(1);
      this.frames = 0; this.lastStat = now;
    }
    this.show({ peakMHz: cap.peakHz / 1e6, peakDb: cap.peakDb, captureUs: cap.captureUs, retries: cap.retries });
  }

  /** Set readouts directly (replay). Missing fields are left alone. */
  show({ peakMHz, peakDb, captureUs, retries }) {
    if (peakMHz != null) $('#peak').textContent = Number(peakMHz).toFixed(2);
    if (peakDb != null) $('#peakdb').textContent = Number(peakDb).toFixed(0);
    if (captureUs != null) $('#cap-us').textContent = captureUs;
    if (retries != null) $('#retries').textContent = retries;
  }

  fps(text) { $('#fps').textContent = text; }
}
