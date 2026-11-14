'use strict';

/*
 * sim.js — a fake EspSdr that produces believable I/Q with no hardware.
 * Drop-in for the real client: same connect()/capture()/tune()/setGpio() shape.
 * Used by "Try without hardware" so the page works on any laptop and so the
 * demo looks the same every time (apart from the jammer toggle, which is live).
 */

import { spectrum } from './radio.js';

function gaussian() { // Box–Muller
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const SIM_SWEEP = [1, 3, 5, 6, 7, 9, 11, 13];

export class SimSdr {
  constructor() {
    this.family = 'C3'; this.deviceName = 'ESP32-C3 (simulated)';
    this.rxRates = [80000000, 40000000, 16000000]; this.maxSamples = 16380;
    this.bwLimits = [14, 62, 1, 0]; this.bwSetting = 'auto';   // what a C3 reports in LIMITS?
    this.gainMin = 0; this.gainMax = 60; this.gainStep = 1; this.sampleBits = [8, 10];
    this.hasGain = true; this.hasHwAgc = true; this.hasGpio = true;
    this.gpioPins = [{ pin: 4, state: 'Z' }];
    this._sweepI = -1; this._lowSince = null;
    this.frequency = 2442;
    this.onLog = () => {};
  }

  async connect() {
    this.onLog('← C3SDR 6 burst 16380 (simulated)');
    return { identity: 'C3SDR 6 burst 16380', family: 'C3', device: this.deviceName, rates: this.rxRates, bandwidth: this.bwLimits, gpio: this.gpioPins, simulated: true };
  }
  async disconnect() {}
  async tune(f) { this.frequency = f; }
  async setGain() { return { mode: 'HARDWARE', index: null }; }
  async setBandwidth(mhz = 'auto') { this.bwSetting = mhz; return mhz; }
  async setGpio(pin, state) {
    const e = this.gpioPins.find(p => p.pin === pin); if (!e) return;
    // Model the jammer firmware's single-wire protocol: a short low pulse while
    // on steps the sweep; a long low (> 300 ms) is a real off and resets it.
    if (pin === 4) {
      const now = performance.now();
      if (state === '1' && e.state !== '1') {
        if (this._lowSince != null && now - this._lowSince < 300) this._sweepI = (this._sweepI + 1) % SIM_SWEEP.length;
        else this._sweepI = -1;
        this._lowSince = null;
      } else if (state !== '1' && e.state === '1') this._lowSince = now;
    }
    e.state = state;
  }
  jammerChannel() { return this._sweepI >= 0 ? SIM_SWEEP[this._sweepI] : 6; }

  _jammerOn() { return (this.gpioPins.find(p => p.pin === 4) || {}).state === '1'; }

  async capture({ frequency, rate = 80000000, bits = 8, fft: nfft = 2048, gain = 40, gainMode = 'HARDWARE', bandwidth = null } = {}) {
    if (frequency != null) this.frequency = frequency;
    if (bandwidth != null) this.bwSetting = bandwidth;
    // The analog filter: 'auto'/0 behave as the widest setting (~62 MHz on a C3).
    const bwMHz = typeof this.bwSetting === 'number' && this.bwSetting > 0 ? this.bwSetting : 62;
    const filt = dfMHz => 1 / Math.sqrt(1 + (dfMHz / (bwMHz / 2)) ** 8);   // 4th-order Butterworth-ish
    const f0 = this.frequency, n = Math.max(nfft, 8192);
    const iq = new Float32Array(n * 2);
    const span = rate / 1e6; // MHz across the capture
    const binOffMHz = (df) => df; // df is already MHz offset from center

    // Noise floor: front-end noise that goes through the analog filter
    // (cascaded one-pole low-pass, so narrowing the filter visibly shapes the
    // floor), plus a little white ADC noise that does not.
    // Scaled so the in-band density stays put: total power ∝ passband / span.
    const pole = Math.exp(-2 * Math.PI * (bwMHz / 2) / span);
    let a1i = 0, a1q = 0, a2i = 0, a2q = 0, pw = 0;
    for (let j = 0; j < n; j++) {
      a1i = pole * a1i + (1 - pole) * gaussian(); a1q = pole * a1q + (1 - pole) * gaussian();
      a2i = pole * a2i + (1 - pole) * a1i;        a2q = pole * a2q + (1 - pole) * a1q;
      iq[2 * j] = a2i; iq[2 * j + 1] = a2q; pw += a2i * a2i + a2q * a2q;
    }
    const k = 0.012 * Math.SQRT2 * Math.sqrt(Math.min(1, bwMHz / span)) / Math.sqrt(pw / n || 1);
    for (let j = 0; j < 2 * n; j++) iq[j] = iq[j] * k + gaussian() * 0.003;

    // Helper: add a tone cluster of given MHz offset, amplitude, and width.
    const addSignal = (dfMHz, amp, widthMHz, kind) => {
      if (Math.abs(dfMHz) > span / 2) return;
      amp *= filt(dfMHz);
      const wBins = Math.max(1, Math.round(widthMHz / span * 20));
      for (let c = -wBins; c <= wBins; c++) {
        const cycles = (dfMHz + c * span / 40) / span; // fraction of sample rate
        const w = 2 * Math.PI * cycles;
        const a = amp * (kind === 'wifi' ? (1 - Math.abs(c) / (wBins + 1)) : 1) * (0.6 + 0.4 * Math.random());
        const ph = Math.random() * 2 * Math.PI;
        for (let j = 0; j < n; j++) {
          // modulate a little so it isn't a pure CW spike (except the jammer)
          const mod = kind === 'jammer' ? 1 : (0.7 + 0.3 * Math.sin(j * 0.01 * (c + 2)));
          iq[2 * j] += a * mod * Math.cos(w * j + ph);
          iq[2 * j + 1] += a * mod * Math.sin(w * j + ph);
        }
      }
    };

    // Wi-Fi channels 1/6/11 at 2412/2437/2462 as ~16 MHz humps
    for (const ch of [2412, 2437, 2462]) addSignal(ch - f0, 0.05, 16, 'wifi');
    // A couple of BLE advertising blips near the edges
    for (const ble of [2402, 2426, 2480]) addSignal(ble - f0, 0.03 * (Math.random() > 0.4 ? 1 : 0), 1, 'ble');

    // The jammer node (GPIO4 high) parks a strong carrier ~3 MHz above its channel centre.
    if (this._jammerOn()) addSignal(2407 + 5 * this.jammerChannel() + 3 - f0, 0.5, 0.5, 'jammer');

    // Scale down if anything clipped
    let peak = 0; for (let j = 0; j < iq.length; j++) peak = Math.max(peak, Math.abs(iq[j]));
    if (peak > 0.95) { const s = 0.95 / peak; for (let j = 0; j < iq.length; j++) iq[j] *= s; }

    // Quantize to the requested bit depth so the scatter shows real lattice
    const levels = bits === 8 ? 128 : 512;
    for (let j = 0; j < iq.length; j++) iq[j] = Math.round(iq[j] * levels) / levels;

    const ps = spectrum(iq, nfft);
    let pk = 0; for (let j = 1; j < ps.length; j++) if (ps[j] > ps[pk]) pk = j;
    await new Promise(r => setTimeout(r, 25)); // feel like a real capture
    return {
      iq, spectrum: ps, fft: nfft, rate, bits, frequency: f0,
      gain: { mode: 'HARDWARE', index: null }, bandwidth: this.bwSetting,
      peakHz: f0 * 1e6 + (pk - nfft / 2) * rate / nfft, peakDb: ps[pk],
      captureUs: Math.round(n / rate * 1e6), samples: n, retries: 0,
      elapsedMs: 25, simulated: true,
    };
  }
}
