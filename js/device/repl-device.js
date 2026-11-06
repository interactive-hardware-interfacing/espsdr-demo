// repl-device.js — put a file on a CircuitPython board through its raw REPL.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The XIAO ESP32-C3 has no CIRCUITPY drive (no native USB), so the REPL is the
// only way to touch its filesystem from a laptop. This is the path Thonny and
// mpremote use, made explicit: interrupt code.py, enter raw mode, run Python
// that opens the file and writes it in bytes-literal chunks, then have the
// board report the file's size and CRC32 so a truncated or corrupted write is
// caught before anyone trusts it. Copied from fox-bench and trimmed to what a
// demo needs: identify, write, verify, reboot.
import { ReplLink } from './repl-link.js';

const WRITE_CHUNK = 384;   // bytes per f.write(); bytes-literal escapes roughly double it on the wire

const CRC = Uint32Array.from({ length: 256 }, (_, i) => {
  let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
});
export function crc32(bytes) { let c = 0xffffffff; for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function pyBytesLiteral(bytes) {
  let s = "b'";
  for (const b of bytes) {
    if (b === 0x27) s += "\\'"; else if (b === 0x5c) s += '\\\\';
    else if (b >= 0x20 && b < 0x7f) s += String.fromCharCode(b);
    else s += '\\x' + b.toString(16).padStart(2, '0');
  }
  return s + "'";
}
const VERIFY_SNIPPET = "import os, binascii\nc=0\nf=open(PATH,'rb')\nwhile True:\n b=f.read(512)\n if not b: break\n c=binascii.crc32(b,c)\nf.close()\nprint(os.stat(PATH)[6], c)\n";

export class ReplDevice {
  /** @param {import('./link.js').Link} link  an open Link
   *  @param {(text: string, cls?: string) => void} [log] */
  constructor(link, log) {
    this.link = link;
    this.log = log || (() => {});
    this._queue = Promise.resolve();      // one operation on the wire at a time
    this.repl = new ReplLink(link, t => this.log(t, 'dim'));
    this.repl.onUnsolicited = t => this.log(t.replace(/\r/g, ''), 'reply');
    this.enc = new TextEncoder();
  }
  _run(fn) { const p = this._queue.then(fn, fn); this._queue = p.catch(() => {}); return p; }

  /** Interrupt whatever is running and ask the board who it is. Throws if no REPL answers. */
  async connect() { return this._run(() => this._connect()); }
  async _connect() {
    await this.repl.interrupt();
    const out = await this._exec(
      "import board, microcontroller, os\n" +
      "print(board.board_id)\n" +
      "print(''.join('%02x' % b for b in microcontroller.cpu.uid))\n" +
      "print(os.uname().release)\n");
    const [boardId, uid, cpVersion] = out.trim().split('\n').map(s => s.trim());
    return { boardId, uid, cpVersion };
  }

  async _exec(code, opts) {
    this.log(code.split('\n')[0] + (code.includes('\n') ? ' …' : ''), 'tx');
    const { out } = await this.repl.exec(code, opts);
    return out;
  }

  /** Write bytes to `path`, then have the board report size and CRC32; throws if either differs. */
  async writeBytes(path, bytes) { return this._run(() => this._writeBytes(path, bytes)); }
  async _writeBytes(path, bytes, onProgress = () => {}) {
    await this._exec(`f=open(${JSON.stringify(path)},'wb')`);
    for (let i = 0; i < bytes.length; i += WRITE_CHUNK) {
      await this.repl.exec(`f.write(${pyBytesLiteral(bytes.subarray(i, i + WRITE_CHUNK))})`);
      onProgress(Math.min(1, (i + WRITE_CHUNK) / bytes.length));
    }
    await this.repl.exec('f.close()');
    const { size, crc } = await this._verify(path);
    const want = crc32(bytes);
    if (size !== bytes.length) throw new Error(`${path}: sent ${bytes.length} bytes, board reports ${size} — the write was truncated; try again`);
    if (crc !== want) throw new Error(`${path}: CRC mismatch after write (board ${crc.toString(16)}, sent ${want.toString(16)}) — try again; if it repeats, suspect the cable or the board's flash`);
    this.log(`wrote ${path} (${bytes.length} B, crc ${want.toString(16)}) — verified`, 'ok');
  }
  async writeText(path, text, onProgress) { return this._run(() => this._writeBytes(path, this.enc.encode(text), onProgress)); }

  /** Size and CRC32 of a file as the board sees it; computed on the board in 512-byte pieces so no RAM is needed. */
  async _verify(path) {
    const { out } = await this.repl.exec(VERIFY_SNIPPET.replace(/PATH/g, JSON.stringify(path)));
    const [size, crc] = out.trim().split(' ').map(s => parseInt(s, 10));
    if (!Number.isFinite(size) || !Number.isFinite(crc)) throw new Error(`${path}: could not verify (${out.trim().slice(0, 80)})`);
    return { size, crc: crc >>> 0 };
  }

  /** Soft reboot (Ctrl-D) and return the boot output, collected until `until` matches or `timeout` passes. */
  async reboot(opts) { return this._run(() => this._reboot(opts)); }
  async _reboot({ until = /\{"t":"hello"/, timeout = 15000 } = {}) {
    this.log('soft reboot (Ctrl-D) — watching the boot output', 'dim');
    const text = await this.repl.rebootAndCapture({ until, timeout });
    this.log(text, 'reply');
    return text;
  }

  async close() { try { await this.repl.exitRaw(); } catch {} await this.link.close(); }
}
