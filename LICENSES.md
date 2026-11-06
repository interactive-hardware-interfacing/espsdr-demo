# Licences in this repository

| What | Where | Licence | Text |
|---|---|---|---|
| The demo: page, scripts, jammer firmware, docs | everything not listed below | **GPL-3.0-or-later** | `LICENSE` |
| **Flasher**: CircuitPython flashing from the page | `flasher/` | **Apache-2.0** | `flasher/LICENSE`, `flasher/NOTICE` |
| esptool-js (Espressif) | `flasher/vendor/esptool-js/` | Apache-2.0 | `flasher/vendor/esptool-js/LICENSE` |

The page is GPL-3.0-or-later because `js/radio.js` is adapted from ESPARGOS's
[esp-web-sdr](https://github.com/ESPARGOS/esp-web-sdr) (GPL-3.0-or-later).

The flasher is kept in its own directory with its own licence so that its
provenance is clear. Apache-2.0 code may be combined with GPL-3.0 code, so
the combination is distributed under GPL-3.0-or-later as a whole; the files in
`flasher/` remain Apache-2.0 on their own. Nothing in `flasher/` depends on
anything outside it, and nothing outside it depends on anything in it except
the Firmware tab's "Flash CircuitPython" button.

The **receiver firmware** is ESPARGOS's [ESP-SDR](https://github.com/ESPARGOS/esp-sdr)
(GPL-3.0) and is not shipped in this repository; it is flashed from their
installer.
