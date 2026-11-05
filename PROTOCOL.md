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
