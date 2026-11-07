# espsdr-demo

A browser demo that turns a **Seeed XIAO ESP32-C3** into a 2.4 GHz
software-defined radio: live power spectrum, scrolling waterfall, and a raw
I/Q scatter plot — all over Web Serial, no install, no server.

**Live page:** <https://interactive-hardware-interfacing.github.io/espsdr-demo/>
· **Try without hardware** runs the whole page against a built-in simulator.

Part of [Interactive Hardware Interfacing](https://interactive-hardware-interfacing.github.io/).
One of a family of standalone tour demos — this repo is self-contained and
copies nothing from the others.

## What you see

- **Spectrum** — energy vs. frequency across the 2.4 GHz band, with Wi-Fi
  channel markers.
- **Waterfall** — the spectrum scrolling over time.
- **I/Q scatter** — the raw radio samples as dots; the raw material a
  constellation is drawn from. Turn on the jammer and watch it spread.

## Hardware

- 1× XIAO ESP32-C3 (receiver) + u.FL antenna — the only board the browser needs.
- Optional: a 2nd XIAO ESP32-C3 as a "jammer" so there's always a signal to
  point at. See [`wiring/`](wiring/) and [`firmware/jammer/`](firmware/jammer/).

The receiver runs **stock [ESP-SDR](https://github.com/ESPARGOS/esp-sdr)
firmware** (flash it from the [browser installer](https://espargos.net/espsdr/app/flash.html));
this repo ships only the page, not the receiver firmware. See
[`firmware/VERSION.txt`](firmware/VERSION.txt) and [`PROTOCOL.md`](PROTOCOL.md).

## Putting the firmware on the boards

**Receiver:** ESPARGOS's installer, linked above. The page's **Firmware** tab
walks through it.

**Jammer (optional):** the page does it. Open the **Firmware** tab, plug in
the second XIAO ESP32-C3, click **Install jammer**, pick the port. The page
writes `firmware/jammer/code.py` through CircuitPython's raw REPL over Web
Serial (the C3 has no `CIRCUITPY` drive, so this is the only USB path),
verifies size and CRC32 on the board, reboots it, and waits for its
`jammer ready` line.

A jammer board that has never run CircuitPython needs it installed once:
download the `.bin` for the XIAO ESP32-C3 from
[circuitpython.org](https://circuitpython.org/board/seeed_xiao_esp32c3/),
pick it on the Firmware tab, click **Flash CircuitPython**. That path uses
[esptool-js](https://github.com/espressif/esptool-js), kept in
[`flasher/`](flasher/) under its own licence.

## What's in the repo

| Path | What it is |
|---|---|
| `index.html`, `css/`, `js/app.js` | The page: instrument, plus Hardware / Firmware / About views (`js/views.js`). |
| `js/radio.js` | Web Serial client for ESP-SDR and the FFT. Adapted from ESPARGOS's esp-web-sdr. |
| `js/sim.js` | A fake radio for **Try without hardware**. |
| `js/install.js`, `js/device/` | The Firmware tab: CircuitPython raw REPL over Web Serial (write, verify, reboot) for the jammer. |
| `flasher/` | CircuitPython flashing for a bare jammer board (esptool-js). Apache-2.0, see `LICENSES.md`. |
| `firmware/jammer/code.py` | The optional jammer node. |
| `firmware/VERSION.txt` | Which ESP-SDR build the receiver was tested with. |
| `PROTOCOL.md`, `wiring/` | The serial contract and the hookup. |

## On the page

- **Presenter** (or press `P`) hides the log, settings and logging panel and
  enlarges the spectrum, waterfall and I/Q for a projector. `Esc` leaves it;
  the choice is remembered. `?presenter` in the URL turns it on.
- **Trace → peak hold / max hold.** Peak hold (yellow) decays about 1 dB per
  frame; max hold (magenta) is frozen until *Reset hold*. Both draw over the
  live trace.
- **Click the spectrum to tune** there (rounded to 1 MHz). Hover shows the
  frequency under the cursor. **Shift-click** places a marker (up to two) with
  a live dB readout; shift-click a marker to remove it.
- **Sweep** steps the jammer across channels 1→13 once a second, which draws
  a diagonal across the waterfall. It needs the jammer board and the single
  enable wire: the page pulses GPIO4 low for 30 ms per step and the jammer
  firmware counts the pulses (a low longer than 300 ms is a real "off").
- **Mark** (on the logging row) stamps a labelled event into `marks.csv` and
  paints a magenta row with the label into the waterfall, so it scrolls with
  the history it tags. Marking starts a recording if none is running.
- **Replay a log…** plays a zip downloaded earlier back into the page at the
  recorded pace — spectrum, waterfall, stats, marks, and I/Q where `.npy`
  snapshots were kept. No board needed, so a demo can run from a good
  recording when the room's RF is boring. Needs `spectrum.csv` in the zip.

## Logging data

The **Data logging** panel records captures while connected (simulator
included) and hands them over as one `.zip`:

| file | contents |
|---|---|
| `marks.csv` | labelled events: time, capture index, label |
| `summary.csv` | one row per capture: time, centre, rate, FFT size, bits, gain, peak frequency and level, capture time, retries, jammer on/off |
| `spectrum.csv` | one row per capture, one column per FFT bin in dBFS; header row is the bin centre in MHz. A waterfall in a file — about 250 kB/s at 2048 bins |
| `iq_NNNNN.npy` | raw I/Q of one capture as a NumPy `float32` array of shape `(n, 2)`, scaled to ±1. One per capture (or every 5th / 20th / 100th) |

Nothing touches disk until you click **Download**; the page stops recording
by itself at 200 MB. In Python:

```python
import numpy as np, pandas as pd
s  = pd.read_csv('summary.csv')
sp = pd.read_csv('spectrum.csv')          # sp.iloc[:, 2:] is the waterfall
iq = np.load('iq_00000.npy'); z = iq[:, 0] + 1j * iq[:, 1]
```

## Run locally

```
python -m http.server 8000
```

then open <http://localhost:8000/> — the ES modules won't load from `file://`.
Web Serial needs HTTPS or localhost.

## Browser support

Chrome or Edge on a laptop/desktop (Web Serial). The simulator works anywhere.

## License

Page, JS and docs: **GPL-3.0-or-later** (see [`LICENSE`](LICENSE)) — the Web
Serial client borrows structure from ESPARGOS's GPL-3.0 `esp-web-sdr`, so the
page inherits GPL-3.0. `flasher/` is Apache-2.0 (it bundles esptool-js); see
[`LICENSES.md`](LICENSES.md). The receiver firmware is ESPARGOS's and keeps its
own license.

Maintained by [LC Linkous](https://github.com/LC-Linkous).
