'use strict';

/*
 * install.js — the Firmware tab: put the jammer's code.py on a XIAO ESP32-C3
 * from the browser, and (for a bare board) put CircuitPython on it first.
 *
 * Only the optional jammer node runs CircuitPython. The receiver runs
 * ESPARGOS's compiled ESP-SDR firmware, flashed from their own installer; the
 * page does not touch it.
 *
 * The C3 has no CIRCUITPY drive, so "copy code.py to the board" means talking
 * to CircuitPython's raw REPL over Web Serial (js/device/). The write is
 * verified by size and CRC32 on the board, then the board is soft-rebooted and
 * we watch for the firmware's "jammer ready" line to prove it is running.
 *
 * Installing CircuitPython itself goes through flasher/ (esptool-js, loaded
 * only when that button is used). circuitpython.org does not allow a page to
 * fetch the .bin directly, so that path is: download it, pick the file here.
 */

import { SerialLink, hasWebSerial } from './device/serial-link.js';
import { ReplDevice } from './device/repl-device.js';

const FIRMWARE = { jammer: 'firmware/jammer/code.py' };
const BOOT_LINE = { jammer: /jammer ready on channel \d+/ };
const EXPECT_BOARD = /xiao_esp32c3/i;

/**
 * @param {object} ui   { installJammer, status, bar, log, noRepl, cpFile, cpLoad, cpName, cpFlash }
 * @param {object} opts { releaseSerial: () => Promise<void> }   closes the instrument's own port first
 */
export function initInstall(ui, { releaseSerial = async () => {} } = {}) {
  const log = (t, cls = '') => {
    if (!t) return;
    const line = document.createElement('div');
    if (cls) line.className = cls;
    line.textContent = t.replace(/\s+$/, '');
    ui.log.appendChild(line);
    while (ui.log.childElementCount > 400) ui.log.firstChild.remove();
    ui.log.scrollTop = ui.log.scrollHeight;
  };
  const phase = (t, cls = '') => { ui.status.textContent = t; ui.status.className = 'fwstatus ' + cls; log('— ' + t, 'dim'); };
  const progress = f => { ui.bar.hidden = f == null; if (f != null) ui.bar.value = Math.max(0, Math.min(1, f)); };
  let busy = false;
  const setBusy = b => { busy = b; ui.installJammer.disabled = b; ui.cpFlash.disabled = b || !image; ui.cpLoad.disabled = b; };

  if (!hasWebSerial()) {
    phase('This browser has no Web Serial. Use Chrome or Edge on a laptop or desktop to install firmware.', 'warn');
    ui.installJammer.disabled = ui.cpLoad.disabled = ui.cpFlash.disabled = true;
    return;
  }

  // ---- 1. code.py over the REPL --------------------------------------------
  async function install(role) {
    if (busy) return;
    const path = FIRMWARE[role];
    setBusy(true); progress(null); ui.noRepl.hidden = true;
    let link = null, dev = null;
    try {
      await releaseSerial();
      phase(`fetching ${path}`);
      const r = await fetch(path, { cache: 'no-cache' });
      if (!r.ok) throw new Error(`could not fetch ${path} (${r.status})`);
      const text = await r.text();
      log(`${path}: ${text.length} bytes`);

      phase('choose the board\'s port in the chooser');
      link = new SerialLink();
      link.onDrop = e => log('port dropped: ' + (e?.message || e), 'warn');
      await link.open(115200);
      log('port open (' + link.info() + ')');
      dev = new ReplDevice(link, log);

      phase('looking for CircuitPython on the board…');
      let id;
      try { id = await dev.connect(); }
      catch (e) {
        log(e.message, 'warn');
        phase('No CircuitPython answered. If this is a bare board, install CircuitPython first (below), then try again. If it is the receiver, it runs ESP-SDR, not CircuitPython: nothing to install from here.', 'warn');
        ui.noRepl.hidden = false;
        return;
      }
      log(`board ${id.boardId} · CircuitPython ${id.cpVersion} · uid ${id.uid}`, 'ok');
      if (!EXPECT_BOARD.test(id.boardId)) log(`note: this firmware is written for the XIAO ESP32-C3; the board reports "${id.boardId}". Pins may differ.`, 'warn');

      phase(`writing code.py (${role} role)…`);
      progress(0);
      await dev.writeText('code.py', text, progress);
      progress(null);

      phase('rebooting the board and watching for its ready line…');
      const boot = await dev.reboot({ until: BOOT_LINE[role] });
      if (BOOT_LINE[role].test(boot)) {
        phase('Done. This board is the jammer. Move it to a USB bank, clip its antenna on, and use the Jammer button on the instrument (with the enable wire) or set ALWAYS_ON in code.py.', 'ok');
      } else if (/Traceback|Error/.test(boot)) {
        phase('code.py written and verified, but it crashed on boot. The Python error is in the log above.', 'warn');
      } else {
        phase('code.py written and verified, but no "jammer ready" line was seen within 15 s. Check the boot output above.', 'warn');
      }
    } catch (e) {
      log(e.message || String(e), 'warn');
      phase('Install failed: ' + (e.message || e), 'warn');
    } finally {
      try { await dev?.close(); } catch {}
      if (!dev) { try { await link?.close(); } catch {} }
      progress(null);
      setBusy(false);
    }
  }
  ui.installJammer.addEventListener('click', () => install('jammer'));

  // ---- 2. CircuitPython itself, for a bare board -------------------------------
  let flasher = null, image = null;
  ui.cpLoad.addEventListener('click', () => ui.cpFile.click());
  ui.cpFile.addEventListener('change', async () => {
    const f = ui.cpFile.files?.[0];
    if (!f) return;
    try {
      flasher ??= await import('../flasher/flasher.js');
      const bytes = new Uint8Array(await f.arrayBuffer());
      flasher.setImage(f.name, bytes);
      image = flasher.image;
      const info = image.info;
      ui.cpName.textContent = `${f.name} · ${(bytes.length / 1024).toFixed(0)} kB` + (info ? ` · CircuitPython ${info.version} for ${info.boardId}` : '');
      if (info && !EXPECT_BOARD.test(info.boardId)) log(`note: that image is for "${info.boardId}", not the XIAO ESP32-C3.`, 'warn');
      if (!info) log('note: the file name is not the usual adafruit-circuitpython-<board>-<lang>-<version>.bin shape; make sure it is the .bin (not .uf2) for the XIAO ESP32-C3.', 'warn');
      ui.cpFlash.disabled = busy;
    } catch (e) { log('could not load the image: ' + (e.message || e), 'warn'); }
  });
  ui.cpFlash.addEventListener('click', async () => {
    if (busy || !image?.bytes) return;
    setBusy(true); progress(null);
    try {
      await releaseSerial();
      flasher ??= await import('../flasher/flasher.js');
      const facts = await flasher.flash({
        offset: 0x0, eraseAll: true, baud: 460800, expectChip: 'esp32c3',
        onPhase: t => phase(t), onProgress: f => progress(f), onLog: t => log(t, 'dim'),
      });
      progress(null);
      phase(`CircuitPython flashed (${facts.chip}, ${facts.seconds}s). Unplug and replug the board, then click Install firmware.`, 'ok');
    } catch (e) {
      const m = e.message || String(e);
      log(m, 'warn');
      if (/Failed to connect|timeout/i.test(m)) log('The chip did not answer. Unplug the board, hold its BOOT button (B) while plugging it back in, release, and try again.', 'warn');
      phase('Flash failed: ' + m, 'warn');
    } finally { progress(null); setBusy(false); }
  });
}
