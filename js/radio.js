'use strict';

/*
 * radio.js — Web Serial client for ESP-SDR firmware, trimmed for the
 * espsdr-demo (XIAO ESP32-C3). Talks the ESP-SDR burst protocol:
 *   https://github.com/ESPARGOS/esp-sdr/blob/main/docs/protocol.md
 *
 * This is an independent, demo-focused reimplementation of the parts of the
 * ESPARGOS esp-web-sdr client (GPL-3.0) that this page needs: connect + SYNC,
 * INFO/CAPS/GAIN/LIMITS negotiation, FREQ tuning, raw CAP16/CAP20 captures
 * with CRC32 check, IQ unpacking, and a JS FFT for the spectrum. We use raw
 * captures (not the SPEC stream) because one CAP16 gives us BOTH the spectrum
 * and the raw I/Q the constellation panel needs, and because snapshot captures
 * are the only spectrum path the C3 has over its native USB anyway.
 *
 * No network, no server. Everything runs against the serial port.
 *
 * Portions adapted from ESPARGOS/esp-web-sdr (radio.js), GPL-3.0-or-later.
 */

// ---- CRC32 (zlib polynomial 0xEDB88320), matches the firmware ----
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
export function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- in-place radix-2 FFT (same structure as the ESPARGOS viewer) ----
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len *= 2) {
    const a = -2 * Math.PI / len, cr = Math.cos(a), ci = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let wr = 1, wi = 0;
      for (let j = 0; j < len / 2; j++) {
        const k = i + j, l = k + len / 2;
        const tr = re[l] * wr - im[l] * wi, ti = re[l] * wi + im[l] * wr;
        re[l] = re[k] - tr; im[l] = im[k] - ti;
        re[k] += tr; im[k] += ti;
        const next = wr * cr - wi * ci;
        wi = wr * ci + wi * cr; wr = next;
      }
    }
  }
}

// Power spectrum in dBFS-ish units from interleaved I/Q (Float32, -1..1).
// DC-removed, Hann-windowed, FFT-shifted so bin 0 is the lowest frequency.
let _ws;
export function spectrum(iq, n) {
  if (!_ws || _ws.n !== n) {
    const window = Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1)));
    _ws = { n, window, norm: window.reduce((a, b) => a + b, 0) ** 2, re: new Float64Array(n), im: new Float64Array(n), sums: new Float64Array(n) };
  }
  const { window, norm, re, im, sums } = _ws;
  const blocks = Math.floor(iq.length / 2 / n);
  sums.fill(0);
  for (let b = 0; b < blocks; b++) {
    let mi = 0, mq = 0;
    for (let j = 0; j < n; j++) { mi += iq[2 * (b * n + j)]; mq += iq[2 * (b * n + j) + 1]; }
    mi /= n; mq /= n;
    for (let j = 0; j < n; j++) {
      re[j] = (iq[2 * (b * n + j)] - mi) * window[j];
      im[j] = (iq[2 * (b * n + j) + 1] - mq) * window[j];
    }
    fft(re, im);
    for (let j = 0; j < n; j++) sums[j] += re[j] ** 2 + im[j] ** 2;
  }
  return Array.from({ length: n }, (_, j) =>
    10 * Math.log10(Math.max(1e-14, blocks ? sums[(j + n / 2) % n] / norm / blocks : 0)));
}

// Rate code table from the firmware protocol doc.
export const RATE_CODES = [80000000, 40000000, 20000000, 10000000, 8000000, 4000000, 16000000, 32000000, 10666667, 6400000];

export class EspSdr {
  constructor() {
    this.port = null; this.reader = null; this.writer = null;
    this.queue = []; this.queued = 0; this.wake = null; this.failed = null;
    this.pumping = null;
    this.family = null; this.maxSamples = 16380;
    this.rxRates = [80000000];
    this.gainMin = 0; this.gainMax = 60; this.gainStep = 1;
    this.sampleBits = [8, 10];
    this.frequency = null; this.gainSetting = null;
    this.hasGpio = false; this.gpioPins = [];
    this.onLog = () => {};
  }

  // ---- low-level serial plumbing ----
  async _pump() {
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) {
          this.queue.push(value); this.queued += value.length;
          if (this.queued > 4 * 1024 * 1024) throw new Error('Receive queue overflow');
          if (this.wake) this.wake();
        }
      }
    } catch (e) { this.failed = e; }
    finally { this.failed ||= new Error('Serial disconnected'); if (this.wake) this.wake(); }
  }

  async _read(n, deadline = performance.now() + 5000, idleMs = Infinity) {
    let idle = performance.now() + idleMs;
    const out = new Uint8Array(n); let off = 0;
    while (off < n) {
      if (this.queued) {
        const b = this.queue[0], k = Math.min(n - off, b.length);
        out.set(b.subarray(0, k), off); off += k; this.queued -= k;
        idle = performance.now() + idleMs;
        if (k === b.length) this.queue.shift(); else this.queue[0] = b.subarray(k);
        continue;
      }
      if (this.failed) throw this.failed;
      const ms = Math.min(deadline, idle) - performance.now();
      if (ms <= 0) throw Object.assign(new Error('Serial read timed out'), { code: 'TIMEOUT' });
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => { this.wake = null; reject(Object.assign(new Error('Serial read timed out'), { code: 'TIMEOUT' })); }, ms);
        this.wake = () => { clearTimeout(t); this.wake = null; resolve(); };
      });
    }
    return out;
  }

  async _line(prefix = '', limit = 512) {
    let s = '', end = performance.now() + 5000;
    for (let j = 0; j < limit; j++) {
      const b = (await this._read(1, end))[0];
      if (b === 10) { s = s.trim(); if (prefix && !s.startsWith(prefix)) throw new Error(s || 'Empty response'); return s; }
      s += String.fromCharCode(b);
    }
    throw new Error('Response line too long');
  }

  async _cmd(s) { await this.writer.write(new TextEncoder().encode(s + '\n')); }

  // Resync after a port open (which may reset the board) by sending a unique
  // marker and discarding everything up to its echo.
  async _sync() {
    for (let attempt = 0; attempt < 3; attempt++) {
      const marker = 'SYNC ' + Date.now(), deadline = performance.now() + 2000;
      await this._cmd('\n' + marker);
      let w = '';
      try {
        for (let j = 0; j < 70000; j++) {
          w += String.fromCharCode((await this._read(1, deadline))[0]);
          if (w.length > marker.length + 1) w = w.slice(-marker.length - 1);
          if (w === marker + '\n') return;
        }
      } catch (e) { if (this.failed) throw e; }
    }
    throw new Error('Could not sync with the board. Unplug the XIAO and plug it back in, make sure ESP-SDR firmware is installed, and close any other SDR page or serial monitor.');
  }

  // ---- connect / negotiate ----
  async connect() {
    if (!navigator.serial) throw new Error('This browser has no Web Serial. Use Chrome or Edge on a laptop or desktop.');
    if (!isSecureContext) throw new Error('Serve this page over HTTPS or localhost.');
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: 2000000, bufferSize: 131072, flowControl: 'none' });
    this.port = port;
    this.reader = port.readable.getReader();
    this.writer = port.writable.getWriter();
    this.queue = []; this.queued = 0; this.failed = null;
    this.pumping = this._pump();
    await this._sync();
    return this._negotiate();
  }

  async _negotiate() {
    await this._cmd('INFO');
    const info = await this._line();
    const m = /^(ESP32|C2|C3|C5|C6|C61|H2|S2|S3|S31)SDR \d+ burst (\d+)$/.exec(info);
    if (!m) throw new Error('This board is not running ESP-SDR burst firmware (got: "' + info + '"). Flash it from the Firmware section.');
    this.family = m[1];
    this.maxSamples = Number(m[2]);
    this.identity = info;
    this.onLog('← ' + info);

    await this._cmd('CAPS');
    const caps = (await this._line()).split(' ');
    this.hasGain = caps.includes('GAIN');
    this.hasHwAgc = caps.includes('HWAGC');
    this.hasGpio = caps.includes('GPIO');

    // Gain range: prefer LIMITS?, fall back to GAIN?
    if (caps.includes('RXLIMITS')) {
      await this._cmd('LIMITS?');
      const lim = JSON.parse((await this._line('LIMITS ')).slice(7));
      if (Array.isArray(lim.gain)) [this.gainMin, this.gainMax, this.gainStep] = lim.gain;
      if (Array.isArray(lim.rates) && lim.rates.length) this.rxRates = lim.rates;
      if (Array.isArray(lim.bits) && lim.bits.length) this.sampleBits = lim.bits;
    } else if (this.hasGain) {
      await this._cmd('GAIN?');
      const g = (await this._line('GAIN ')).split(' ');
      this.gainMin = Number(g[3]); this.gainMax = Number(g[4]);
    }
    // The C3 only advertises 80 MS/s.
    if (this.family === 'C3' && !this.rxRates.length) this.rxRates = [80000000];

    if (this.hasGpio) {
      await this._cmd('GPIO?');
      const line = await this._line('', 512);
      const pins = line.slice(4).trim();
      this.gpioPins = pins ? pins.split(' ').map(e => { const [p, s] = e.split(':'); return { pin: Number(p), state: s }; }) : [];
    }
    this.deviceName = this.family === 'ESP32' ? 'ESP32' : 'ESP32-' + this.family;
    return { identity: info, family: this.family, device: this.deviceName, rates: this.rxRates, gpio: this.gpioPins };
  }

  async disconnect() {
    try {
      if (this.writer && !this.failed) { try { await this._cmd('RELEASE'); } catch {} }
    } finally {
      if (this.reader) { try { await this.reader.cancel(); } catch {} ; try { await this.pumping; } catch {} ; try { this.reader.releaseLock(); } catch {} ; this.reader = null; }
      if (this.writer) { try { this.writer.releaseLock(); } catch {} ; this.writer = null; }
      if (this.port) { try { await this.port.close(); } catch {} ; this.port = null; }
      this.frequency = null; this.gainSetting = null;
    }
  }

  // ---- radio controls ----
  async tune(freqMHz) {
    if (!Number.isInteger(freqMHz)) throw new Error('Frequency must be a whole number of MHz.');
    if (this.frequency === freqMHz) return;
    this.frequency = null;
    await this._cmd('FREQ ' + freqMHz);
    await this._line('OK');
    this.frequency = freqMHz;
  }

  async setGain(mode = 'HARDWARE', index = 40) {
    if (!this.hasGain) return { mode: 'none', index: null };
    const setting = mode === 'MANUAL' ? 'MANUAL ' + index : 'HARDWARE';
    if (setting !== this.gainSetting) {
      await this._cmd('GAIN ' + setting);
      await this._line('OK');
      this.gainSetting = setting;
    }
    return { mode, index: mode === 'MANUAL' ? index : null };
  }

  async setGpio(pin, state) {
    if (!this.hasGpio) throw new Error('This firmware has no spare GPIO.');
    await this._cmd(`GPIO ${pin} ${state}`);
    const r = await this._line();
    if (r !== `OK GPIO ${pin} ${state}`) throw new Error(r.startsWith('ERR') ? r : 'Unexpected GPIO reply');
    const entry = this.gpioPins.find(p => p.pin === pin);
    if (entry) entry.state = state;
  }

  // ---- one raw capture -> {iq, spectrum, peak} ----
  // bits: 8 or 10 ; fft: power of two <= samples ; rate in Hz
  async capture({ frequency, rate = 80000000, bits = 8, fft: nfft = 2048, gainMode = 'HARDWARE', gain = 40 } = {}) {
    if (!this.port) throw new Error('Connect the board first.');
    const divider = RATE_CODES.indexOf(rate);
    if (divider < 0) throw new Error('Unsupported sample rate.');
    const start = performance.now();
    if (frequency != null) await this.tune(frequency);
    const g = await this.setGain(gainMode, gain);

    const n = Math.max(nfft, Math.min(this.maxSamples, 16380));
    let bytes, captureUs, retries = 0;
    for (let attempt = 0; ; attempt++) {
      await this._cmd(`CAP${bits * 2} ${n} ${divider}`);
      try {
        const header = await this._line();
        if (header.startsWith('ERR')) throw new Error(header);
        const h = /^DATA (\d+) ([0-9a-fA-F]{1,8}) (\d+)$/.exec(header);
        if (!h || Number(h[1]) !== n) throw Object.assign(new Error('Bad capture header'), { code: 'DAMAGED' });
        const need = Math.ceil(n * bits * 2 / 8);
        bytes = await this._read(need, performance.now() + 5000, 500);
        if (crc32(bytes) !== parseInt(h[2], 16)) throw Object.assign(new Error('Capture CRC mismatch'), { code: 'DAMAGED' });
        captureUs = Number(h[3]); retries = attempt;
        break;
      } catch (e) {
        if (this.failed || !['TIMEOUT', 'DAMAGED'].includes(e.code)) throw e;
        try { await this._sync(); } catch (se) { throw new Error(`${e.message}; resync failed: ${se.message}`); }
        if (attempt >= 5) throw new Error(`Capture failed after 6 tries: ${e.message}`);
      }
    }

    // Unpack to Float32 interleaved I/Q in -1..1. Q is negated to match the
    // ESPARGOS convention (spectrum orientation).
    const iq = new Float32Array(n * 2);
    if (bits === 8) {
      for (let j = 0; j < n; j++) {
        let i = bytes[j * 2], q = bytes[j * 2 + 1];
        if (i >= 128) i -= 256; if (q >= 128) q -= 256;
        iq[2 * j] = (i * 4) / 512; iq[2 * j + 1] = -(q * 4) / 512;
      }
    } else { // 10-bit packed, 20 bits per pair, LSB first
      let acc = 0, nbits = 0, k = 0;
      for (let j = 0; j < n; j++) {
        while (nbits < 20) { acc |= bytes[k++] << nbits; nbits += 8; }
        const w = acc & 0xfffff; acc >>>= 20; nbits -= 20;
        let i = w & 1023, q = w >>> 10;
        if (i >= 512) i -= 1024; if (q >= 512) q -= 1024;
        iq[2 * j] = i / 512; iq[2 * j + 1] = -q / 512;
      }
    }

    const ps = spectrum(iq, nfft);
    let peak = 0;
    for (let j = 1; j < ps.length; j++) if (ps[j] > ps[peak]) peak = j;
    return {
      iq, spectrum: ps, fft: nfft, rate, bits,
      frequency: this.frequency, gain: g,
      peakHz: this.frequency * 1e6 + (peak - nfft / 2) * rate / nfft,
      peakDb: ps[peak],
      captureUs, samples: n, retries,
      elapsedMs: performance.now() - start,
    };
  }
}
