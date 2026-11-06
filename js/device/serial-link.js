// serial-link.js — Web Serial implementation of Link.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// No USB filter: the XIAO ESP32-C3 enumerates as Espressif's USB-JTAG/serial
// (303a:1001) under CircuitPython and as the ROM bootloader on the same IDs,
// but other boards will differ, so the chooser shows every port.
import { Link } from './link.js';

export const hasWebSerial = () => 'serial' in navigator;

export class SerialLink extends Link {
  constructor() { super(); this.port = null; this.reader = null; this.writer = null; }

  /** `port`: an already granted SerialPort (from `granted()` or a previous session) opens without the chooser. */
  async open(baudRate = 115200, port = null) {
    this.port = port || await navigator.serial.requestPort();
    await this.port.open({ baudRate });
    this.writer = this.port.writable.getWriter();
    this._readLoop();
  }
  async _readLoop() {
    try {
      this.reader = this.port.readable.getReader();
      for (;;) { const { value, done } = await this.reader.read(); if (done) break; this._feed(value); }
      // a clean `done` while we did not close is the port going away too (some bridges end the stream instead of erroring)
      if (!this.closed && this.onDrop) this.onDrop(new Error('the port closed its read stream'));
    } catch (e) { if (!this.closed && this.onDrop) this.onDrop(e); }
  }
  async write(data) {
    const bytes = typeof data === 'string' ? this.enc.encode(data) : data;
    await this.writer.write(bytes);
  }
  /** Pulse DTR/RTS low→high: resets most boards without touching the flash button. */
  async reset() {
    try { await this.port.setSignals({ dataTerminalReady: false, requestToSend: true }); await new Promise(r => setTimeout(r, 100)); await this.port.setSignals({ dataTerminalReady: true, requestToSend: false }); } catch {}
  }
  /** The ports the user has already granted this site (Chrome keeps the grant across unplug/replug). */
  static async granted() { try { return await navigator.serial.getPorts(); } catch { return []; } }
  /** Same device as `port`: the same object (Chrome keeps it for a granted device that comes back), or the same usb ids. */
  static same(a, b) {
    if (a === b) return true;
    try { const x = a.getInfo(), y = b.getInfo(); return x.usbVendorId != null && x.usbVendorId === y.usbVendorId && x.usbProductId === y.usbProductId; } catch { return false; }
  }
  info() {
    try { const i = this.port.getInfo(); return `usb ${i.usbVendorId?.toString(16).padStart(4, '0')}:${i.usbProductId?.toString(16).padStart(4, '0')}`; } catch { return 'serial'; }
  }
  async close() {
    this.closed = true;
    try { if (this.reader) { await this.reader.cancel(); this.reader.releaseLock(); } } catch {}
    try { this.writer?.releaseLock(); } catch {}
    try { await this.port?.close(); } catch {}
  }
}
