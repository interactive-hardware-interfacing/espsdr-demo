'use strict';

/*
 * sim.js — a fake EspSdr that produces believable I/Q with no hardware.
 * Drop-in for the real client: same connect()/capture()/tune()/setGpio() shape.
 * Used by "Try without hardware" so the page works on any laptop and so the
 * demo looks the same every time (apart from the beacon toggle, which is live).
 *
 * What it models, roughly: Wi-Fi 1/6/11 and BLE advertising as bursts of
 * packets; the beacon as near-continuous ESP-NOW frames; the three C3 sample
 * rates; the analog filter; hardware AGC vs manual gain (with clipping); and
 * 8/10-bit quantisation. It is a teaching prop, not a channel model.
 */

import { spectrum } from './radio.js';

function gaussian() { // Box–Muller
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const SIM_SWEEP = [1, 3, 5, 6, 7, 9, 11, 13];

const MORSE = { A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..', 0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.', '/': '-..-.', '?': '..--..', '.': '.-.-.-', ',': '--..--', '=': '-...-' };
/** Same timing as firmware/beacon/code.py: dot 1, dash 3, gaps 1 / 3 / 7 units. */
export function morseSchedule(text) {
  const out = [];
  for (const word of text.toUpperCase().split(/\s+/).filter(Boolean)) {
    for (const ch of word) {
      const code = MORSE[ch]; if (!code) continue;
      for (const sym of code) out.push([true, sym === '.' ? 1 : 3], [false, 1]);
      out[out.length - 1] = [false, 3];
    }
    if (out.length) out[out.length - 1] = [false, 7];
  }
  return out;
}

/**
 * The beacon's USB serial control, simulated: same methods as
 * js/device/beacon-link.js, and SimSdr reads its state when drawing the
 * beacon's carrier (channel, power, on/off, Morse keying).
 */
export class SimBeacon {
  constructor(sdr) {
    this.sdr = sdr; this.state = { on: false, ch: 6, pwr: 19.5, wpm: 5, morse: false };
    this.keying = null; this.onInfo = () => {}; this.onDrop = () => {};
  }
  async connect() { this.sdr.beacon = this; this.sdr.home = this.state.ch; return { id: 'ID BEACON 1 ch=6 pwr=19.5 on=0 (simulated)', info: 'simulated' }; }
  async setOn(on) { this.state.on = on; if (!on) { this.keying = null; this.state.morse = false; } }
  async setChannel(ch) { if (!(ch >= 1 && ch <= 13)) throw new Error('beacon: ERR channel 1-13'); this.state.ch = ch; this.sdr.home = ch; this.sdr._sweepI = -1; this.onInfo('beacon on channel ' + ch); }
  async setPower(dbm) { if (!(dbm >= 2 && dbm <= 20)) throw new Error('beacon: ERR power 2-20 dBm'); this.state.pwr = Math.round(dbm * 4) / 4; return this.state.pwr; }
  async setWpm(n) { this.state.wpm = n; if (this.keying) this.keying.t0 = performance.now(); }
  async morse(text) {
    const sched = morseSchedule(text || '');
    this.keying = sched.length ? { sched, total: sched.reduce((a, [, u]) => a + u, 0), t0: performance.now() } : null;
    this.state.morse = !!this.keying;
  }
  async status() { return this.state; }
  async close() { this.state.on = false; this.keying = null; this.state.morse = false; if (this.sdr.beacon === this) this.sdr.beacon = null; }
  /** Is the key down at time t (ms)? Without Morse: whether serial ON is set. */
  keyed(t) {
    if (!this.keying) return this.state.on;
    const unit = 1200 / this.state.wpm;
    let pos = ((t - this.keying.t0) / unit) % this.keying.total;
    for (const [down, units] of this.keying.sched) { if (pos < units) return down; pos -= units; }
    return false;
  }
}

export class SimSdr {
  constructor() {
    this.family = 'C3'; this.deviceName = 'ESP32-C3 (simulated)';
    this.rxRates = [80000000, 40000000, 16000000]; this.maxSamples = 16380;
    this.bwLimits = [14, 62, 1, 0]; this.bwSetting = 'auto';   // what a C3 reports in LIMITS?
    this.gainMin = 0; this.gainMax = 60; this.gainStep = 1; this.sampleBits = [8, 10];
    this.hasGain = true; this.hasHwAgc = true; this.hasGpio = true;
    this.gpioPins = [{ pin: 4, state: 'Z' }];
    this._sweepI = -1; this._lowSince = null;
    this.home = 6;            // the beacon's home channel (CH over serial changes it)
    this.beacon = null;       // a connected SimBeacon, if any
    this.frequency = 2442;
    this.onLog = () => {};
  }

  async connect() {
    this.onLog('← C3SDR 6 burst 16380 (simulated)');
    return { identity: 'C3SDR 6 burst 16380', family: 'C3', device: this.deviceName, rates: this.rxRates, bandwidth: this.bwLimits, gpio: this.gpioPins, simulated: true };
  }
  async disconnect() { if (this.beacon) await this.beacon.close(); }
  async tune(f) { this.frequency = f; }
  async setGain(mode = 'HARDWARE', index = 40) { return { mode, index: mode === 'MANUAL' ? index : null }; }
  async setBandwidth(mhz = 'auto') { this.bwSetting = mhz; return mhz; }
  async setGpio(pin, state) {
    const e = this.gpioPins.find(p => p.pin === pin); if (!e) return;
    // Model the beacon firmware's single-wire protocol: a short low pulse while
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
  beaconChannel() { return this._sweepI >= 0 ? SIM_SWEEP[this._sweepI] : this.home; }

  // Same rule as code.py: wire high OR serial ON, and Morse keying overrides.
  _wireOn() { return (this.gpioPins.find(p => p.pin === 4) || {}).state === '1'; }
  _beaconOn(t = performance.now()) {
    if (this.beacon?.keying) return this.beacon.keyed(t);
    return this._wireOn() || !!this.beacon?.state.on;
  }
  // Carrier amplitude follows the beacon's power setting, 0.5 at ~20 dBm.
  _beaconAmp() { return 0.5 * 10 ** (((this.beacon?.state.pwr ?? 19.5) - 19.5) / 20); }

  async capture({ frequency, rate = 80000000, bits = 8, fft: nfft = 2048, gain = 40, gainMode = 'HARDWARE', bandwidth = null } = {}) {
    if (frequency != null) this.frequency = frequency;
    if (bandwidth != null) this.bwSetting = bandwidth;
    // The analog filter: 'auto'/0 behave as the widest setting (~62 MHz on a C3).
    const bwMHz = typeof this.bwSetting === 'number' && this.bwSetting > 0 ? this.bwSetting : 62;
    const filt = dfMHz => 1 / Math.sqrt(1 + (dfMHz / (bwMHz / 2)) ** 8);   // 4th-order Butterworth-ish
    const f0 = this.frequency, n = Math.max(nfft, this.maxSamples);   // 16 380, like the real burst
    const iq = new Float32Array(n * 2);
    const span = rate / 1e6; // MHz across the capture
    const perUs = rate / 1e6; // samples per microsecond

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

    // Packets: every transmitter is on in bursts, not continuously, so the
    // time-domain view has something to show. gate() returns 0..1 per sample
    // with short ramps; on/off lengths are in microseconds.
    const gate = (onUs, offUs, pStartOn = 0.5) => {
      const g = new Float32Array(n), ramp = Math.max(1, Math.round(0.4 * perUs));
      let j = 0, on = Math.random() < pStartOn;
      while (j < n) {
        const len = Math.max(1, Math.round((on ? onUs() : offUs()) * perUs));
        if (on) for (let t = 0; t < len && j + t < n; t++) g[j + t] = Math.min(1, (t + 1) / ramp, (len - t) / ramp);
        j += len; on = !on;
      }
      return g;
    };
    const uniform = (a, b) => () => a + Math.random() * (b - a);
    const expo = mean => () => -mean * Math.log(1 - Math.random());

    // Add a cluster of tones (a crude occupied bandwidth) at an MHz offset,
    // gated by g. Phasor recurrence instead of cos/sin per sample.
    const addSignal = (dfMHz, amp, widthMHz, g, shaped) => {
      if (Math.abs(dfMHz) > span / 2) return;
      amp *= filt(dfMHz);
      const wBins = Math.round(widthMHz / span * 20);   // 0 = a single carrier
      for (let c = -wBins; c <= wBins; c++) {
        const w = 2 * Math.PI * (dfMHz + c * span / 40) / span;   // radians per sample
        const a = amp * (shaped ? (1 - Math.abs(c) / (wBins + 1)) : 1) * (0.6 + 0.4 * Math.random());
        const cr = Math.cos(w), ci = Math.sin(w);
        let ph = Math.random() * 2 * Math.PI, re = Math.cos(ph), im = Math.sin(ph);
        for (let j = 0; j < n; j++) {
          const v = a * g[j];
          if (v) { iq[2 * j] += v * re; iq[2 * j + 1] += v * im; }
          const r2 = re * cr - im * ci; im = re * ci + im * cr; re = r2;
        }
      }
    };

    // Wi-Fi channels 1/6/11 at 2412/2437/2462 as ~16 MHz humps, packets of
    // 20–150 µs. Different loads so the occupancy panel has a story: 6 is the
    // busy one, 1 moderate, 11 mostly idle.
    for (const [ch, gapUs, pOn] of [[2412, 400, 0.3], [2437, 70, 0.5], [2462, 2500, 0.05]]) addSignal(ch - f0, 0.05, 16, gate(uniform(20, 150), expo(gapUs), pOn), true);
    // BLE advertising on 37/38/39: now and then one packet of 80–376 µs
    for (const ble of [2402, 2426, 2480]) if (Math.random() < 0.5) addSignal(ble - f0, 0.03, 1, gate(uniform(80, 376), uniform(50, 400), 0.3), false);

    // The beacon node (GPIO4 high) parks a strong carrier ~3 MHz above its
    // channel centre: back-to-back ESP-NOW frames, so nearly always on.
    if (this._beaconOn()) addSignal(2407 + 5 * this.beaconChannel() + 3 - f0, this._beaconAmp(), 0.5, gate(uniform(50, 70), uniform(8, 20), 0.9), false);

    // Gain. Hardware AGC: scale the burst so its peak sits just under full
    // scale (it hides absolute level changes). Manual: a fixed scale from the
    // gain index, 1 dB per step around 40, and anything past full scale clips.
    let peak = 0; for (let j = 0; j < iq.length; j++) peak = Math.max(peak, Math.abs(iq[j]));
    const scale = gainMode === 'MANUAL' ? 10 ** ((gain - 40) / 20) : (peak > 0.9 ? 0.9 / peak : 1);
    for (let j = 0; j < iq.length; j++) iq[j] = Math.max(-1, Math.min(1, iq[j] * scale));

    // Quantize to the requested bit depth so the scatter shows real lattice
    // (8-bit tops out at 127/128, like the real CAP16 unpacking)
    const levels = bits === 8 ? 128 : 512;
    for (let j = 0; j < iq.length; j++) iq[j] = Math.max(-levels, Math.min(levels - 1, Math.round(iq[j] * levels))) / levels;

    const ps = spectrum(iq, nfft);
    let pk = 0; for (let j = 1; j < ps.length; j++) if (ps[j] > ps[pk]) pk = j;
    await new Promise(r => setTimeout(r, 25)); // feel like a real capture
    return {
      iq, spectrum: ps, fft: nfft, rate, bits, frequency: f0,
      gain: { mode: gainMode, index: gainMode === 'MANUAL' ? gain : null }, bandwidth: this.bwSetting,
      peakHz: f0 * 1e6 + (pk - nfft / 2) * rate / nfft, peakDb: ps[pk],
      captureUs: Math.round(n / rate * 1e6), samples: n, retries: 0,
      elapsedMs: 25, simulated: true,
    };
  }
}
