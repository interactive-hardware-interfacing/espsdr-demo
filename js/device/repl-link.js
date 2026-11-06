// repl-link.js — the CircuitPython raw-REPL protocol over a Link.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// This is what Thonny and mpremote do, made explicit (PROTOCOL.md, "Installing").
// Copied from fox-bench (same author); the C3 quirks it handles were
// found on real XIAO boards there:
//   interrupt   \r\x03\x03          stop code.py
//   enter raw   \r\x01              expect "raw REPL; CTRL-B to exit\r\n>"
//   exec        <code>\x04          expect "OK" <stdout> \x04 <stderr> \x04 ">"
//   exit raw    \r\x02              friendly REPL
//   reboot      \x04 at friendly    runs code.py; we capture the boot log
//
// Code is sent in small chunks with a pause: CircuitPython's input buffer
// is a few hundred bytes without raw-paste mode, and USB-CDC on the C3
// has no flow control.

const CHUNK = 128;
/** CircuitPython's REPL emits terminal escapes: ESC[2K ESC[0G (clear line), ESC]0;title BEL/ESC\\ (title bar). */
export const stripAnsi = t => t.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\r/g, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));

export class ReplLink {
  constructor(link, log, { timeouts = {} } = {}) {
    this.link = link; this.log = log || (() => {});
    this.T = { ctrlC: 2500, enter: 2000, exitRaw: 2000, retryGap: 500, ...timeouts };   // ms; tests shrink them
    this.dec = new TextDecoder();
    this.buf = '';
    this.waiters = [];
    this.capture = null;                // { text } while rebootAndCapture is collecting the boot log
    this.busy = 0;                      // depth of operations in progress
    this.inRaw = false;
    this.onUnsolicited = null;          // text arriving when nobody is waiting (boot output, the running firmware's lines)
    link.onData = bytes => this._onData(bytes);
  }

  _onData(bytes) {
    this.buf += this.dec.decode(bytes, { stream: true });
    if (this.waiters.length) this.waiters[0].check();
    else if (this.capture) { this.capture.text += this.buf; this.buf = ''; }
    else if (!this.busy) this._flushUnsolicited();
    // else: an operation is between two waits; the next _waitFor picks the bytes up
  }
  _flushUnsolicited() {
    if (!this.buf) return;
    const t = stripAnsi(this.buf); this.buf = '';
    if (this.onUnsolicited && t.replace(/[\s>]/g, '')) this.onUnsolicited(t);
  }
  /** Mark an operation in progress: bytes arriving between its waits are kept for the next wait, not treated as board output. */
  async _op(fn) { this.busy++; try { return await fn(); } finally { if (--this.busy === 0) this._flushUnsolicited(); } }

  /** Register the wait before sending, so a reply that arrives in the same tick is never mistaken for unsolicited output. */
  _sendAndWait(s, marker, timeout) { const p = this._waitFor(marker, timeout); p.catch(() => {}); return this._send(s).then(() => p); }

  /** Resolve when `buf` contains `marker`; returns text before it and removes through it. */
  _waitFor(marker, timeout = 3000) {
    return new Promise((resolve, reject) => {
      const w = { check: () => {
        const i = this.buf.indexOf(marker);
        if (i < 0) return;
        const before = this.buf.slice(0, i); this.buf = this.buf.slice(i + marker.length);
        clearTimeout(t); this.waiters.shift(); resolve(before);
        if (this.waiters.length) this.waiters[0].check();
      } };
      const t = setTimeout(() => { const k = this.waiters.indexOf(w); if (k >= 0) this.waiters.splice(k, 1); reject(new Error(`timeout waiting for ${JSON.stringify(marker)}; got ${JSON.stringify(this.buf.slice(-120))}`)); }, timeout);
      this.waiters.push(w); w.check();
    });
  }

  async _send(s) { await this.link.write(s); }

  /** Stop whatever is running and get a prompt. Tolerates a board mid-boot or already at a prompt. */
  async interrupt() { return this._op(() => this._interrupt()); }
  async _interrupt() {
    this.buf = '';
    // Known to be in raw mode (our own exec left it there): Ctrl-B is the one thing that gets a prompt, and trying
    // Ctrl-C first cost 4.5 s on every Bench action. Fall through to the full dance only if that fails.
    if (this.inRaw) { try { await this._sendAndWait('\r\x02', '>>> ', this.T.exitRaw); this.inRaw = false; return; } catch {} }
    for (let attempt = 0; attempt < 4; attempt++) {
      try { await this._sendAndWait('\r\x03\x03', '>>> ', this.T.ctrlC); this.inRaw = false; this.log('interrupted → friendly REPL'); return; } catch {}
      // maybe at "Press any key to enter the REPL", mid-boot, or already in raw mode
      try { await this._sendAndWait('\r', '>>> ', this.T.enter); this.inRaw = false; return; } catch {}
      try { await this._sendAndWait('\r\x02', '>>> ', this.T.exitRaw); this.inRaw = false; return; } catch {}
      await sleep(this.T.retryGap);
    }
    throw new Error('no REPL prompt — is this a CircuitPython board? (Try: unplug, replug without holding B, then Connect.)');
  }

  async enterRaw() { return this._op(() => this._enterRaw()); }
  async _enterRaw() {
    if (this.inRaw) return;
    this.buf = '';
    await this._sendAndWait('\r\x01', 'raw REPL; CTRL-B to exit\r\n>', 3000);
    this.inRaw = true;
  }
  async exitRaw() { return this._op(() => this._exitRaw()); }
  async _exitRaw() {
    if (!this.inRaw) return;
    try { await this._sendAndWait('\r\x02', '>>> ', this.T.exitRaw); } catch {}
    this.inRaw = false;
  }

  /** Run Python in raw mode; returns { out, err }. Throws on a Python exception unless {soft}. */
  async exec(code, opts) { return this._op(() => this._exec(code, opts)); }
  async _exec(code, { timeout = 10000, soft = false } = {}) {
    await this._enterRaw();
    this.buf = '';
    for (let i = 0; i < code.length; i += CHUNK) { await this._send(code.slice(i, i + CHUNK)); await sleep(8); }
    await this._sendAndWait('\x04', 'OK', 3000);
    const out = await this._waitFor('\x04', timeout);
    const err = await this._waitFor('\x04', 3000);
    try { await this._waitFor('>', 2000); } catch { /* both \x04 seen: the exec completed; the prompt may arrive with the next read */ }
    if (err && !soft) throw new Error(err.trim().split('\n').pop() || err);
    return { out, err };
  }

  /** Soft reboot and collect the boot log until `until` matches or timeout. */
  async rebootAndCapture(opts) { return this._op(() => this._rebootAndCapture(opts)); }
  async _rebootAndCapture({ timeout = 15000, until = /\{"t":"hello"/ } = {}) {
    await this._exitRaw();
    this.buf = '';
    const cap = this.capture = { text: '' };
    try {
      await this._send('\x04');
      const start = performance.now();
      while (performance.now() - start < timeout) {
        await sleep(100);
        if (until.test(cap.text)) { await sleep(300); break; }
        if (/Traceback|Error:/.test(cap.text) && /Press any key|Code done running/.test(cap.text)) break;
      }
    } finally { this.capture = null; }
    return stripAnsi(cap.text);
  }
}
