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
page inherits GPL-3.0. The receiver firmware is ESPARGOS's and keeps its own
license.

Maintained by [LC Linkous](https://github.com/LC-Linkous).
