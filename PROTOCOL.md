# Protocol — espsdr-demo

This page is a client for **ESP-SDR** firmware. The authoritative protocol spec
is ESPARGOS's: <https://github.com/ESPARGOS/esp-sdr/blob/main/docs/protocol.md>.
This file records only the subset this demo uses, so you can re-verify it
against a board before a tour.

## Link

- Native USB (USB Serial/JTAG on the C3), **2,000,000 baud, 8N1, no flow control**.
- ASCII commands terminated by `\n`; one text reply line per command. Some
  replies are followed by a binary payload. Errors start with `ERR`.
- After opening the port, send a `SYNC <nonce>` and discard everything up to the
  echoed nonce (the port open can reset the board). `js/radio.js` does this.

## Commands this demo sends

| Command            | Reply                               | Used for                          |
|--------------------|-------------------------------------|-----------------------------------|
| `SYNC <nonce>`     | `SYNC <nonce>`                      | Resync after connect              |
| `INFO`             | e.g. `C3SDR 6 burst 16380`          | Identify chip + max capture length|
| `CAPS`             | `CAPS <flags...>`                   | Feature flags (GAIN, GPIO, …)     |
| `LIMITS?`          | `LIMITS {json}`                     | Gain range, rates, bit depths     |
| `GAIN?` / `GAIN …` | `GAIN …` / `OK`                     | AGC or manual gain index          |
| `FREQ <MHz>`       | `OK`                                | Tune (whole MHz)                  |
| `GPIO <pin> <Z|0|1>`| `OK GPIO <pin> <state>`            | Jammer enable line                |
| `CAP16 <n> <rate>` | `DATA <n> <crc32hex> <us>` + bytes  | Raw 8-bit I/Q capture             |
| `CAP20 <n> <rate>` | `DATA <n> <crc32hex> <us>` + bytes  | Raw 10-bit I/Q capture            |
| `RELEASE`          | `OK`                                | Give up the port on disconnect    |

### Identity string

`js/radio.js` matches: `^(ESP32|C2|C3|C5|C6|C61|H2|S2|S3|S31)SDR \d+ burst (\d+)$`.
On the C3 you should see `C3SDR 6 burst 16380`. **If ESPARGOS bumps the protocol
version number, this regex still matches (it allows any `\d+`), but double-check
the capture framing below hasn't changed.**

### Capture framing

- Reply line: `DATA <samples> <crc32-hex> <capture-microseconds>`.
- Then exactly `ceil(samples * bits * 2 / 8)` bytes.
- CRC32 is the zlib polynomial (0xEDB88320); check it before using the data.
- **IQ8** (`CAP16`): signed 8-bit I, signed 8-bit Q, interleaved.
- **IQ10** (`CAP20`): packed signed 10-bit, 20 bits per I/Q pair, LSB first.
- Rate codes (we use 0 = 80 MS/s on the C3): see the table in the upstream doc.

## Why raw captures and not `SPEC`?

ESP-SDR also offers an on-chip FFT stream (`SPEC`). We use raw `CAP16` instead
because one capture gives us **both** the spectrum (we FFT it in JS) **and** the
raw I/Q the scatter plot needs — and on the C3 the spectrum is snapshot-based
either way. Simpler, one code path, same picture.

Type `INFO` (or any command) in the page's serial log box to poke the firmware
by hand.

## Installing the jammer (the Firmware tab)

Not part of the radio protocol — this is how the page gets `code.py` onto the
optional jammer board. The receiver is never touched by this; it runs
ESPARGOS's compiled firmware, flashed from their installer.

Same kind of port, 115200 8N1 (the C3's USB-JTAG/serial ignores the rate).
It is CircuitPython's raw REPL, the exchange Thonny and mpremote use:

| step | page sends | expects |
|---|---|---|
| interrupt | `\r\x03\x03` (up to 4×, with `\r` and `\x02` fallbacks) | `>>> ` |
| enter raw | `\r\x01` | `raw REPL; CTRL-B to exit\r\n>` |
| exec | code in 128-byte chunks, 8 ms apart, then `\x04` | `OK` · stdout · `\x04` · stderr · `\x04` · `>` |
| exit raw | `\r\x02` | `>>> ` |
| soft reboot | `\x04` at the friendly prompt | boot output until `jammer ready on channel N` (15 s max) |

The write is `f=open('code.py','wb')`, then one `f.write(b'…')` per 384-byte
chunk, `f.close()`, then the board prints `os.stat` size and `binascii.crc32`
of the file read back in 512-byte pieces. Both must match what was sent.

A bare board (no REPL answers) gets CircuitPython first through `flasher/` —
the ROM bootloader protocol, handled by esptool-js.

## Jammer enable line (receiver GPIO4 → jammer D2)

One wire, three meanings, decoded by `firmware/jammer/code.py`:

| line | meaning |
|---|---|
| high | transmit on the current channel |
| low for more than 300 ms | off; the next high parks it back on `CHANNEL` (6) |
| low for less than 300 ms, then high | step to the next entry in `SWEEP_CHANNELS` (1, 3, 5, 6, 7, 9, 11, 13) |

The page's **Sweep** box sends one 30 ms low pulse per second (`GPIO 4 Z`,
wait, `GPIO 4 1`). The simulator models the same rule.
