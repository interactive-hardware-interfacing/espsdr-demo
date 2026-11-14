# code.py — optional "beacon" node for espsdr-demo
#
# Runs on a second XIAO ESP32-C3 in CircuitPython. It parks a continuous
# ESP-NOW carrier a few MHz above a Wi-Fi channel centre so there is always a
# strong, obvious signal to point at during the demo, even in an RF-quiet room.
#
# Two ways to drive it; use either or both.
#
# 1. The enable wire (no second USB port needed). The receiver's GPIO4 line
#    (driven by the web page's "Beacon" button) is read as an enable: pull it
#    high to transmit, let it float/low to go quiet. Wire receiver GPIO4 ->
#    this board's D2, and tie the two boards' GND together. If you don't wire
#    the enable line, set ALWAYS_ON = True below.
#
#    Sweep, on the same single wire: while enabled, a short low pulse on the
#    enable line (the page drops it for ~30 ms and raises it again) steps the
#    carrier to the next channel in SWEEP_CHANNELS. The page's "Sweep" mode
#    sends one pulse a second, which draws a diagonal across the waterfall.
#    A drop longer than PULSE_MAX_S is a real "off" and parks it back on the
#    home channel. No second wire, no jumper.
#
# 2. Its own USB serial port (the page's "Beacon control" panel opens it with
#    Web Serial, 115200 8N1). One command per line, one reply line each:
#
#      ID              -> ID BEACON 1 ch=<n> pwr=<dBm> on=<0|1>
#      STATUS?         -> STATUS on=<0|1> wire=<0|1> ch=<n> pwr=<dBm> wpm=<n> morse=<0|1>
#      ON / OFF        -> OK ON / OK OFF        (OFF also stops Morse keying)
#      CH <1-13>       -> OK CH <n>             (also becomes the home channel)
#      PWR <2-20>      -> OK PWR <dBm>          (what the radio reports back)
#      WPM <3-20>      -> OK WPM <n>
#      MORSE <text>    -> OK MORSE <n> units    (keys the carrier, repeats until MORSE or OFF)
#      MORSE           -> OK MORSE OFF
#      anything else   -> ERR <reason>
#
#    Transmit = enable wire high OR ALWAYS_ON OR serial ON. While Morse is
#    keying, the carrier follows the code instead.
#    Other lines it prints ("beacon on channel N") are informational.
#
# NOTE: keep this low power and brief. You are transmitting in the 2.4 GHz ISM
# band; it is meant for a classroom bench, not to interfere with anything.

import sys
import time
import board
import supervisor
import digitalio
import wifi
import espnow

ALWAYS_ON = False          # True = ignore the enable pin, always transmit
CHANNEL = 6                # Wi-Fi channel to sit on (2437 MHz) at boot; CH changes it
SWEEP_CHANNELS = (1, 3, 5, 6, 7, 9, 11, 13)   # a pulse on the enable line steps to the next
PULSE_MAX_S = 0.3          # a low shorter than this is a step pulse; longer is off
BURST = b"ESPSDR-DEMO-BEACON-TONE-PACKET-PAYLOAD-0123456789"  # filler payload
PWR_RANGE = (2.0, 20.0)    # dBm the PWR command accepts; the C3 tops out near 20
DEFAULT_WPM = 5            # Morse speed: 5 WPM = 240 ms dot, a few waterfall rows

MORSE = {
    "A": ".-", "B": "-...", "C": "-.-.", "D": "-..", "E": ".", "F": "..-.", "G": "--.",
    "H": "....", "I": "..", "J": ".---", "K": "-.-", "L": ".-..", "M": "--", "N": "-.",
    "O": "---", "P": ".--.", "Q": "--.-", "R": ".-.", "S": "...", "T": "-", "U": "..-",
    "V": "...-", "W": ".--", "X": "-..-", "Y": "-.--", "Z": "--..",
    "0": "-----", "1": ".----", "2": "..---", "3": "...--", "4": "....-",
    "5": ".....", "6": "-....", "7": "--...", "8": "---..", "9": "----.",
    "/": "-..-.", "?": "..--..", ".": ".-.-.-", ",": "--..--", "=": "-...-",
}

# Enable input from the receiver's GPIO4
enable = digitalio.DigitalInOut(board.D2)
enable.direction = digitalio.Direction.INPUT
enable.pull = digitalio.Pull.DOWN

# Onboard LED as a visible "transmitting" indicator
try:
    led = digitalio.DigitalInOut(board.LED)
    led.direction = digitalio.Direction.OUTPUT
except Exception:
    led = None

wifi.radio.enabled = True
e = espnow.ESPNow()
peer = None
current = None


def tune(ch):
    """Park the radio on Wi-Fi channel `ch` (ESP-NOW follows the AP's channel)."""
    global peer, current
    if ch == current:
        return
    try:
        wifi.radio.stop_ap()
    except Exception:
        pass
    try:
        wifi.radio.start_ap(ssid="espsdr-beacon", channel=ch)
    except Exception:
        pass
    if peer is not None:
        try:
            e.peers.remove(peer)
        except Exception:
            pass
    peer = espnow.Peer(mac=b"\xff\xff\xff\xff\xff\xff", channel=ch)
    e.peers.append(peer)
    current = ch
    print("beacon on channel", ch)


def morse_schedule(text):
    """Text -> [(key_down, units), ...]: dot 1, dash 3, gap 1 / 3 (letter) / 7 (word, and before repeating)."""
    out = []
    for word in text.upper().split():
        for letter in word:
            code = MORSE.get(letter)
            if not code:
                continue
            for sym in code:
                out.append((True, 1 if sym == "." else 3))
                out.append((False, 1))
            out[-1] = (False, 3)
        if out:
            out[-1] = (False, 7)
    return out


def power():
    try:
        return round(wifi.radio.tx_power, 1)
    except Exception:
        return -1


home = CHANNEL             # where a long low on the wire parks it
serial_on = False          # ON / OFF over USB
wpm = DEFAULT_WPM
keying = None              # Morse: {"sched": [...], "total": units, "t0": monotonic}
line = ""


def reply(text):
    print(text)


def handle(cmdline):
    global serial_on, home, sweep_i, wpm, keying
    parts = cmdline.strip().split(None, 1)
    if not parts:
        return
    cmd, arg = parts[0].upper(), (parts[1] if len(parts) > 1 else "")
    try:
        if cmd == "ID":
            reply("ID BEACON 1 ch=%d pwr=%s on=%d" % (current, power(), 1 if serial_on else 0))
        elif cmd == "STATUS?":
            reply("STATUS on=%d wire=%d ch=%d pwr=%s wpm=%d morse=%d" % (
                1 if serial_on else 0, 1 if enable.value else 0, current, power(), wpm, 1 if keying else 0))
        elif cmd == "ON":
            serial_on = True
            reply("OK ON")
        elif cmd == "OFF":
            serial_on = False
            keying = None
            reply("OK OFF")
        elif cmd == "CH":
            ch = int(arg)
            if not 1 <= ch <= 13:
                raise ValueError("channel 1-13")
            home = ch
            sweep_i = -1
            tune(ch)
            reply("OK CH %d" % ch)
        elif cmd == "PWR":
            dbm = float(arg)
            if not PWR_RANGE[0] <= dbm <= PWR_RANGE[1]:
                raise ValueError("power %g-%g dBm" % PWR_RANGE)
            wifi.radio.tx_power = dbm
            reply("OK PWR %s" % power())
        elif cmd == "WPM":
            n = int(arg)
            if not 3 <= n <= 20:
                raise ValueError("wpm 3-20")
            wpm = n
            if keying:
                keying["t0"] = time.monotonic()
            reply("OK WPM %d" % wpm)
        elif cmd == "MORSE":
            sched = morse_schedule(arg)
            if not sched:
                keying = None
                reply("OK MORSE OFF")
            else:
                keying = {"sched": sched, "total": sum(u for _, u in sched), "t0": time.monotonic()}
                reply("OK MORSE %d units" % keying["total"])
        else:
            reply("ERR command")
    except Exception as ex:   # bad number, out of range, radio refused
        reply("ERR %s" % ex)


def poll_serial():
    """Read whatever the host sent, one character at a time, without blocking."""
    global line
    for _ in range(64):
        if not supervisor.runtime.serial_bytes_available:
            return
        c = sys.stdin.read(1)
        if not c:
            return
        if c in "\r\n":
            if line:
                handle(line)
            line = ""
        elif len(line) < 120:
            line += c


def key_down(now):
    """Morse: is the key down right now?"""
    unit = 1.2 / wpm
    pos = ((now - keying["t0"]) / unit) % keying["total"]
    for down, units in keying["sched"]:
        if pos < units:
            return down
        pos -= units
    return False


tune(CHANNEL)
print("beacon ready on channel", CHANNEL, "- waiting for enable" if not ALWAYS_ON else "- always on")

sweep_i = -1               # index into SWEEP_CHANNELS; -1 = parked on the home channel
low_since = None           # when the enable line last went low

while True:
    poll_serial()
    if ALWAYS_ON:
        on = True
    elif enable.value:
        if low_since is not None:
            # Line came back up. A short low was a step pulse; a long one was off/on.
            if time.monotonic() - low_since < PULSE_MAX_S:
                sweep_i = (sweep_i + 1) % len(SWEEP_CHANNELS)
                tune(SWEEP_CHANNELS[sweep_i])
            else:
                sweep_i = -1
                tune(home)
            low_since = None
        on = True
    else:
        if low_since is None:
            low_since = time.monotonic()
        on = False
    on = on or serial_on
    if keying:
        on = key_down(time.monotonic())
    if led:
        led.value = on
    if on:
        # Blast as fast as CircuitPython allows to approximate a carrier. Fewer
        # frames per pass while keying Morse, so the key timing stays tight.
        for _ in range(4 if keying else 20):
            try:
                e.send(BURST, peer)
            except Exception:
                pass
    else:
        time.sleep(0.002 if keying else 0.01)
