// link.js — Link: a byte stream to the board. Implementations: serial-link.js.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// A Link delivers received bytes to onData(Uint8Array) and accepts
// write(Uint8Array|string). It knows nothing about REPLs or files.

export class Link {
  constructor() { this.onData = null; this.onDrop = null; this.closed = false; this.enc = new TextEncoder(); }
  async open() { throw new Error('not implemented'); }
  async write(data) { throw new Error('not implemented'); }
  async close() { this.closed = true; }
  info() { return ''; }
  _feed(bytes) { if (this.onData) this.onData(bytes); }
}
