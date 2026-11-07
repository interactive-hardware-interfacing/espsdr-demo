'use strict';

/*
 * logger.js — record captures to files you can open in Python, a spreadsheet,
 * or GNU Radio.
 *
 * Three products, each optional:
 *
 *   summary.csv   one row per capture: time, centre, rate, FFT size, bits, gain,
 *                 peak frequency and level, capture time, retries. Small. The
 *                 thing to plot in a spreadsheet.
 *   spectrum.csv  one row per capture, one column per FFT bin (dBFS), with a
 *                 header row of bin frequencies in MHz. A waterfall in a file.
 *                 Big: 2048 bins × ~15 captures/s ≈ 250 kB/s.
 *   iq_NNNN.npy   raw I/Q of one capture as a NumPy array, shape (n, 2),
 *                 float32, scaled to ±1. One file per capture while "keep I/Q"
 *                 is on. 2048 samples ≈ 16 kB each. np.load() reads it.
 *
 * Everything is kept in memory and handed over as a .zip on Stop or Download,
 * so a tour laptop never writes to disk until asked. The zip is built here
 * with STORE entries (no compression, no dependency); CSV compresses well but
 * I/Q does not, and simplicity wins.
 */

const MAX_BYTES = 200 * 1024 * 1024;   // refuse to grow past this; the page says so

export class CaptureLogger {
  constructor() {
    this.reset();
    this.onChange = () => {};
  }
  reset() {
    this.recording = false;
    this.startedAt = null;
    this.rows = [];           // summary rows (strings)
    this.specRows = [];       // spectrum rows (strings)
    this.specHeader = null;   // bin frequencies; set from the first capture
    this.iqFiles = [];        // {name, bytes}
    this.marks = [];          // {t, iso, capture, label}
    this.count = 0;
    this.bytes = 0;
    this.full = false;
    this.opts = { summary: true, spectrum: false, iq: false, iqEvery: 1 };
    this._t0v = null;
  }

  start(opts) {
    const keep = this.opts;
    this.reset();
    this.opts = Object.assign(keep, opts || {});
    this.recording = true;
    this.startedAt = new Date();
    this._t0v = performance.now();
    this.onChange(this);
  }
  stop() { this.recording = false; this.onChange(this); }
  /** A labelled event at the current capture. Starts a recording if none is running. */
  mark(label) {
    if (!this.recording && !this.full) this.start();
    const m = { t: Math.max(0, (performance.now() - this._t0()) / 1000), iso: new Date().toISOString(), capture: this.count, label: label || `mark ${this.marks.length + 1}` };
    this.marks.push(m); this.bytes += 40 + m.label.length;
    this.onChange(this);
    return m;
  }

  /** Called once per capture from the main loop. Cheap when not recording. */
  push(cap, extra = {}) {
    if (!this.recording || this.full) return;
    const t = Math.max(0, (performance.now() - this._t0()) / 1000);
    const i = this.count++;

    if (this.opts.summary) {
      const row = [
        i, t.toFixed(3), new Date().toISOString(),
        (cap.frequency).toFixed(3), cap.rate, cap.fft, cap.bits,
        cap.gain?.mode ?? '', cap.gain?.index ?? '',
        (cap.peakHz / 1e6).toFixed(4), cap.peakDb.toFixed(2),
        cap.captureUs, cap.retries, extra.jammer ? 1 : 0,
      ].join(',') + '\n';
      this.rows.push(row); this.bytes += row.length;
    }
    if (this.opts.spectrum) {
      if (!this.specHeader || this.specHeader.n !== cap.fft || this.specHeader.f !== cap.frequency || this.specHeader.r !== cap.rate) {
        // Bin frequencies change with tuning; emit a fresh header row whenever they do.
        const n = cap.fft, f0 = cap.frequency * 1e6, r = cap.rate;
        const hdr = ['capture', 't_s', ...Array.from({ length: n }, (_, k) => ((f0 + (k - n / 2) * r / n) / 1e6).toFixed(4))].join(',') + '\n';
        this.specHeader = { n, f: cap.frequency, r };
        this.specRows.push(hdr); this.bytes += hdr.length;
      }
      let row = i + ',' + t.toFixed(3);
      const s = cap.spectrum;
      for (let k = 0; k < s.length; k++) row += ',' + s[k].toFixed(1);
      row += '\n';
      this.specRows.push(row); this.bytes += row.length;
    }
    if (this.opts.iq && (i % this.opts.iqEvery) === 0) {
      const bytes = npy2col(cap.iq);
      this.iqFiles.push({ name: `iq_${String(i).padStart(5, '0')}.npy`, bytes });
      this.bytes += bytes.length;
    }
    if (this.bytes > MAX_BYTES) { this.full = true; this.recording = false; }
    if ((i & 7) === 0 || this.full) this.onChange(this);
  }
  _t0() { return this._t0v ??= performance.now(); }

  /** Build the zip. Returns a Blob. */
  toZip(meta = {}) {
    const enc = new TextEncoder();
    const files = [];
    const stamp = (this.startedAt || new Date()).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const readme =
`espsdr-demo capture log
started: ${(this.startedAt || new Date()).toISOString()}
captures: ${this.count}
source: ${meta.source || 'unknown'}
${meta.identity ? 'board: ' + meta.identity + '\n' : ''}
files:
  summary.csv   one row per capture (see header)
  spectrum.csv  one row per capture, one column per FFT bin, dBFS; header row = bin centre MHz
                (a new header row appears whenever the tuning or FFT size changed)
  iq_NNNNN.npy  raw I/Q of capture NNNNN, numpy float32 array of shape (n, 2), scaled to +-1
  marks.csv     labelled events: t_s, iso_time, capture (index into the other files), label

python:
  import numpy as np, pandas as pd
  s = pd.read_csv('summary.csv')
  iq = np.load('iq_00000.npy'); z = iq[:,0] + 1j*iq[:,1]
`;
    files.push({ name: 'README.txt', bytes: enc.encode(readme) });
    files.push({ name: 'marks.csv', bytes: enc.encode('t_s,iso_time,capture,label\n' + this.marks.map(m => `${m.t.toFixed(3)},${m.iso},${m.capture},${/[",\n]/.test(m.label) ? '"' + m.label.replace(/"/g, '""') + '"' : m.label}\n`).join('')) });
    if (this.opts.summary) {
      const hdr = 'capture,t_s,iso_time,center_mhz,rate_hz,fft,bits,gain_mode,gain_index,peak_mhz,peak_dbfs,capture_us,retries,jammer\n';
      files.push({ name: 'summary.csv', bytes: enc.encode(hdr + this.rows.join('')) });
    }
    if (this.opts.spectrum) files.push({ name: 'spectrum.csv', bytes: enc.encode(this.specRows.join('')) });
    for (const f of this.iqFiles) files.push(f);
    return { blob: zipStore(files), name: `espsdr-log-${stamp}.zip` };
  }
}

// ---- NumPy .npy writer: float32, shape (n, 2), C order ----
function npy2col(iq) {
  const n = iq.length / 2;
  let header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${n}, 2), }`;
  // total header length (10 + header + newline) must be a multiple of 64
  const pad = 64 - ((10 + header.length + 1) % 64);
  header += ' '.repeat(pad === 64 ? 0 : pad) + '\n';
  const hb = new TextEncoder().encode(header);
  const out = new Uint8Array(10 + hb.length + n * 2 * 4);
  out.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0], 0);   // \x93NUMPY, v1.0
  out[8] = hb.length & 0xff; out[9] = hb.length >> 8;
  out.set(hb, 10);
  const f = new Float32Array(out.buffer, 10 + hb.length, n * 2);
  f.set(iq);   // already interleaved I,Q, scaled to ±1 by radio.js
  return out;
}

// ---- minimal ZIP (STORE only) ----
const CRC_T = Uint32Array.from({ length: 256 }, (_, i) => { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function dosTime(d) { return ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff; }
function dosDate(d) { return (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff; }
function zipStore(files) {
  const enc = new TextEncoder(), now = new Date();
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.bytes), n = f.bytes.length;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime(now), true); lh.setUint16(12, dosDate(now), true);
    lh.setUint32(14, crc, true); lh.setUint32(18, n, true); lh.setUint32(22, n, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, f.bytes);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime(now), true); ch.setUint16(14, dosDate(now), true);
    ch.setUint32(16, crc, true); ch.setUint32(20, n, true); ch.setUint32(24, n, true);
    ch.setUint16(28, name.length, true); ch.setUint16(30, 0, true); ch.setUint16(32, 0, true); ch.setUint16(34, 0, true); ch.setUint16(36, 0, true);
    ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + n;
  }
  const cdStart = offset, cdLen = central.reduce((a, b) => a + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdLen, true); end.setUint32(16, cdStart, true); end.setUint16(20, 0, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

export function fmtBytes(b) { return b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' kB' : (b / 1048576).toFixed(1) + ' MB'; }

// ---- reading a log back (STORE-only zip, the kind this file writes) ----
/** @returns {Map<string, Uint8Array>} name → bytes */
export function unzipStore(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf), out = new Map(), dec = new TextDecoder();
  let p = 0;
  while (p + 30 <= u8.length && dv.getUint32(p, true) === 0x04034b50) {
    const method = dv.getUint16(p + 8, true), size = dv.getUint32(p + 18, true);
    const nlen = dv.getUint16(p + 26, true), xlen = dv.getUint16(p + 28, true);
    const name = dec.decode(u8.subarray(p + 30, p + 30 + nlen));
    const start = p + 30 + nlen + xlen;
    if (method !== 0) throw new Error(`${name}: compressed entries are not supported (this reader only handles the zips this page writes)`);
    out.set(name, u8.subarray(start, start + size));
    p = start + size;
  }
  if (!out.size) throw new Error('not a zip this page can read');
  return out;
}

/** Parse a NumPy .npy of float32 shape (n, 2) → Float32Array of interleaved I,Q. */
export function readNpy(bytes) {
  if (bytes[0] !== 0x93 || String.fromCharCode(...bytes.subarray(1, 6)) !== 'NUMPY') throw new Error('not a .npy file');
  const major = bytes[6];
  const hlen = major === 1 ? bytes[8] | (bytes[9] << 8) : new DataView(bytes.buffer, bytes.byteOffset).getUint32(8, true);
  const hstart = major === 1 ? 10 : 12;
  const header = new TextDecoder().decode(bytes.subarray(hstart, hstart + hlen));
  if (!/'descr':\s*'<f4'/.test(header)) throw new Error('.npy is not little-endian float32');
  const data = bytes.subarray(hstart + hlen);
  const n = data.byteLength >> 2;
  const f = new Float32Array(n);
  // the data may not be 4-byte aligned inside the zip buffer; copy via DataView
  const dv = new DataView(data.buffer, data.byteOffset, n * 4);
  for (let i = 0; i < n; i++) f[i] = dv.getFloat32(i * 4, true);
  return f;
}

/** Parse a log zip into frames the page can replay. */
export function parseLog(buf) {
  const files = unzipStore(buf), dec = new TextDecoder();
  const text = n => files.has(n) ? dec.decode(files.get(n)) : null;
  const csv = s => s ? s.trim().split('\n').map(l => l.split(',')) : null;
  const summary = csv(text('summary.csv')), spectrum = csv(text('spectrum.csv')), marks = csv(text('marks.csv'));
  if (!spectrum) throw new Error('this log has no spectrum.csv — record with "spectrum.csv" ticked to replay it');
  const frames = [];
  let bins = null;
  for (const row of spectrum) {
    if (row[0] === 'capture') { bins = row.slice(2).map(Number); continue; }   // header: bin centre MHz
    if (!bins) continue;
    frames.push({ i: Number(row[0]), t: Number(row[1]), bins, db: Float32Array.from(row.slice(2), Number) });
  }
  const sumBy = new Map();
  if (summary) { const h = summary[0]; for (const r of summary.slice(1)) sumBy.set(Number(r[0]), Object.fromEntries(h.map((k, j) => [k, r[j]]))); }
  const marksBy = new Map();
  if (marks) for (const r of marks.slice(1)) { const c = Number(r[2]); marksBy.set(c, (marksBy.get(c) || []).concat(r.slice(3).join(','))); }
  const iq = new Map();
  for (const [name, bytes] of files) { const m = /^iq_(\d+)\.npy$/.exec(name); if (m) iq.set(Number(m[1]), bytes); }
  return { frames, summary: sumBy, marks: marksBy, iq, readme: text('README.txt') || '' };
}
