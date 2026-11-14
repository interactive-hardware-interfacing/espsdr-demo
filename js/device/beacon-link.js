// beacon-link.js — talk to the beacon board's own USB serial port.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The beacon (firmware/beacon/code.py) reads one command per line on its
// CircuitPython console and answers with one line: ID, STATUS, OK … or
// ERR …. Everything else it prints ("beacon on channel 6") is informational
// and goes to onInfo. The command set is listed at the top of code.py and in
// PROTOCOL.md.
//
// This is a second, independent Web Serial port; the receiver keeps its own.

import { SerialLink } from './serial-link.js';

const REPLY = /^(ID BEACON|STATUS |OK\b|ERR\b)/;   // strict, so a REPL echoing "ID" is not a reply

export class BeaconLink {
  constructor() {
    this.link = null; this.buf = ''; this.waiter = null; this.queue = Promise.resolve();
    this.dec = new TextDecoder();
    this.state = { on: false, ch: null, pwr: null, wpm: 5, morse: false };
    this.onInfo = () => {}; this.onDrop = () => {};
  }

  async connect() {
    const link = this.link = new SerialLink();
    link.onData = bytes => this._data(bytes);
    link.onDrop = e => { this.link = null; this.onDrop(e); };
    await link.open(115200);
    // Opening the port can restart code.py; give it a moment, then ask who it is.
    let id = null;
    for (let attempt = 0; attempt < 4 && !id; attempt++) {
      try { id = await this._cmd('ID', 1500); } catch {}
    }
    if (!id || !id.startsWith('ID BEACON')) {
      await this.close();
      throw new Error(id
        ? `that port answered "${id}", not the beacon firmware`
        : 'no beacon answered on that port. Pick the beacon board (not the receiver), and install the beacon firmware from the Firmware tab if it is new. A board still running the pre-0.3 "jammer" code.py needs reinstalling to get the serial commands.');
    }
    this._parse(id);
    return { id, info: link.info() };
  }

  _data(bytes) {
    this.buf += this.dec.decode(bytes, { stream: true }).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '');
    let i;
    while ((i = this.buf.search(/\r?\n/)) >= 0) {
      const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(this.buf.indexOf('\n', i) + 1);
      if (!line) continue;
      if (REPLY.test(line) && this.waiter) { const w = this.waiter; this.waiter = null; w(line); }
      else this.onInfo(line);
    }
  }

  /** Send one command, resolve with its reply line. Commands are serialised. */
  _cmd(cmd, timeout = 2000) {
    const run = () => new Promise((resolve, reject) => {
      if (!this.link) { reject(new Error('beacon not connected')); return; }
      const t = setTimeout(() => { this.waiter = null; reject(new Error(`beacon did not answer "${cmd}"`)); }, timeout);
      this.waiter = line => { clearTimeout(t); resolve(line); };
      this.link.write(cmd + '\r\n').catch(e => { clearTimeout(t); this.waiter = null; reject(e); });
    });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async _ok(cmd) {
    const r = await this._cmd(cmd);
    if (!r.startsWith('OK')) throw new Error(`beacon: ${r}`);
    return r;
  }

  _parse(line) {
    const kv = Object.fromEntries([...line.matchAll(/(\w+)=([^\s]+)/g)].map(m => [m[1], m[2]]));
    if (kv.ch) this.state.ch = Number(kv.ch);
    if (kv.pwr) this.state.pwr = Number(kv.pwr);
    if (kv.on) this.state.on = kv.on === '1';
    if (kv.wpm) this.state.wpm = Number(kv.wpm);
    if (kv.morse) this.state.morse = kv.morse === '1';
  }

  async setOn(on) { await this._ok(on ? 'ON' : 'OFF'); this.state.on = on; if (!on) this.state.morse = false; }
  async setChannel(ch) { await this._ok('CH ' + ch); this.state.ch = ch; }
  async setPower(dbm) { const r = await this._ok('PWR ' + dbm); this.state.pwr = Number(r.split(' ')[2]); return this.state.pwr; }
  async setWpm(n) { await this._ok('WPM ' + n); this.state.wpm = n; }
  async morse(text) { await this._ok('MORSE ' + (text || '')); this.state.morse = !!(text && text.trim()); }
  async status() { const r = await this._cmd('STATUS?'); this._parse(r); return this.state; }

  async close() {
    const link = this.link; this.link = null;
    if (link) { try { await link.write('OFF\r\nMORSE\r\n'); } catch {} try { await link.close(); } catch {} }
  }
}
