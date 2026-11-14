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
| `LIMITS?`          | `LIMITS {json}`                     | Gain range, rates, bit depths, filter range |
| `GAIN?` / `GAIN …` | `GAIN …` / `OK`                     | AGC or manual gain index          |
| `FREQ <MHz>`       | `OK`                                | Tune (whole MHz)                  |
| `BANDWIDTH <MHz>`  | `OK`                                | Analog filter; 0 = widest (C3: 14–62) |
| `LPF AUTO`         | `OK`                                | Back to the calibrated filter ("Auto") |
| `GPIO <pin> <Z|0|1>`| `OK GPIO <pin> <state>`            | Beacon enable line                |
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
- Rate codes: the C3 offers 0 = 80, 1 = 40 and 6 = 16 MS/s (`LIMITS?` lists them
  as `"rates":[80000000,40000000,16000000]`). The page's **Span** menu is filled
  from that list. Older builds without `LIMITS?` advertise `RX40` / `RX16` in `CAPS`.
- `LIMITS?` on the C3 reports `"bandwidth":[14,62,1,0]`. The page's **Analog
  filter** menu offers Auto (sends nothing, or `LPF AUTO` to undo a change) and
  steps inside that range via `BANDWIDTH <MHz>`. The setting applies from the
  next capture.

## Why raw captures and not `SPEC`?

ESP-SDR also offers an on-chip FFT stream (`SPEC`). We use raw `CAP16` instead
because one capture gives us **both** the spectrum (we FFT it in JS) **and** the
raw I/Q the scatter plot needs — and on the C3 the spectrum is snapshot-based
either way. Simpler, one code path, same picture.

Type `INFO` (or any command) in the page's serial log box to poke the firmware
by hand.

## Installing the beacon (the Firmware tab)

Not part of the radio protocol — this is how the page gets `code.py` onto the
optional beacon board. The receiver is never touched by this; it runs
ESPARGOS's compiled firmware, flashed from their installer.

Same kind of port, 115200 8N1 (the C3's USB-JTAG/serial ignores the rate).
It is CircuitPython's raw REPL, the exchange Thonny and mpremote use:

| step | page sends | expects |
|---|---|---|
| interrupt | `\r\x03\x03` (up to 4×, with `\r` and `\x02` fallbacks) | `>>> ` |
| enter raw | `\r\x01` | `raw REPL; CTRL-B to exit\r\n>` |
| exec | code in 128-byte chunks, 8 ms apart, then `\x04` | `OK` · stdout · `\x04` · stderr · `\x04` · `>` |
| exit raw | `\r\x02` | `>>> ` |
| soft reboot | `\x04` at the friendly prompt | boot output until `beacon ready on channel N` (15 s max) |

The write is `f=open('code.py','wb')`, then one `f.write(b'…')` per 384-byte
chunk, `f.close()`, then the board prints `os.stat` size and `binascii.crc32`
of the file read back in 512-byte pieces. Both must match what was sent.

A bare board (no REPL answers) gets CircuitPython first through `flasher/` —
the ROM bootloader protocol, handled by esptool-js.

## Beacon enable line (receiver GPIO4 → beacon D2)

One wire, three meanings, decoded by `firmware/beacon/code.py`:

| line | meaning |
|---|---|
| high | transmit on the current channel |
| low for more than 300 ms | off; the next high parks it back on `CHANNEL` (6) |
| low for less than 300 ms, then high | step to the next entry in `SWEEP_CHANNELS` (1, 3, 5, 6, 7, 9, 11, 13) |

The page's **Sweep** box sends one 30 ms low pulse per second (`GPIO 4 Z`,
wait, `GPIO 4 1`). The simulator models the same rule.

## Beacon over its own USB port (the Beacon control panel)

Optional, and independent of the enable wire above: the page can open the
beacon board's own USB serial port (115200 8N1, a second Web Serial port).
`firmware/beacon/code.py` polls its CircuitPython console between frames and
answers each command line with exactly one line:

| command | reply | effect |
|---|---|---|
| `ID` | `ID BEACON 1 ch=<n> pwr=<dBm> on=<0\|1>` | identify; the page checks this on connect |
| `STATUS?` | `STATUS on= wire= ch= pwr= wpm= morse=` | current state |
| `ON` / `OFF` | `OK ON` / `OK OFF` | serial enable; `OFF` also stops Morse |
| `CH <1-13>` | `OK CH <n>` | retune; also the channel a long low on the wire returns to |
| `PWR <2-20>` | `OK PWR <dBm>` | `wifi.radio.tx_power`; the reply is what the radio reports |
| `WPM <3-20>` | `OK WPM <n>` | Morse speed (dot = 1.2 / WPM seconds) |
| `MORSE <text>` | `OK MORSE <units> units` | key the carrier with `text`, repeating, 7-unit gap between repeats |
| `MORSE` | `OK MORSE OFF` | stop keying |
| other | `ERR <reason>` | |

Transmit = wire high **or** `ALWAYS_ON` **or** `ON`; while Morse is keying, the
code decides. Lines that don't start with `ID BEACON`, `STATUS `, `OK` or `ERR`
(for example `beacon on channel 6`) are informational; the page logs them.
Disconnecting from the panel sends `OFF` and `MORSE` first.
