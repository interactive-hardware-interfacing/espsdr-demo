# code.py — optional "jammer" node for espsdr-demo
#
# Runs on a second XIAO ESP32-C3 in CircuitPython. It parks a continuous
# ESP-NOW carrier a few MHz above a Wi-Fi channel centre so there is always a
# strong, obvious signal to point at during the demo, even in an RF-quiet room.
#
# The receiver's GPIO4 line (driven by the web page's "Jammer" button) is read
# as an enable: pull it high to transmit, let it float/low to go quiet. Wire
# receiver GPIO4 -> this board's D2, and tie the two boards' GND together.
# If you don't wire the enable line, set ALWAYS_ON = True below.
#
# Sweep, on the same single wire: while enabled, a short low pulse on the
# enable line (the page drops it for ~30 ms and raises it again) steps the
# carrier to the next channel in SWEEP_CHANNELS. The page's "Sweep" mode
# sends one pulse a second, which draws a diagonal across the waterfall.
# A drop longer than PULSE_MAX_S is a real "off" and parks it back on CHANNEL.
# No second wire, no jumper.
#
# NOTE: keep this low power and brief. You are transmitting in the 2.4 GHz ISM
# band; it is meant for a classroom bench, not to interfere with anything.

import time
import board
import digitalio
import wifi
import espnow

ALWAYS_ON = False          # True = ignore the enable pin, always transmit
CHANNEL = 6                # Wi-Fi channel to sit on (2437 MHz) when not sweeping
SWEEP_CHANNELS = (1, 3, 5, 6, 7, 9, 11, 13)   # a pulse on the enable line steps to the next
PULSE_MAX_S = 0.3          # a low shorter than this is a step pulse; longer is off
BURST = b"ESPSDR-DEMO-JAMMER-TONE-PACKET-PAYLOAD-0123456789"  # filler payload

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
        wifi.radio.start_ap(ssid="espsdr-jammer", channel=ch)
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
    print("jammer on channel", ch)


tune(CHANNEL)
print("jammer ready on channel", CHANNEL, "- waiting for enable" if not ALWAYS_ON else "- always on")

sweep_i = -1               # index into SWEEP_CHANNELS; -1 = parked on CHANNEL
low_since = None           # when the enable line last went low

while True:
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
                tune(CHANNEL)
            low_since = None
        on = True
    else:
        if low_since is None:
            low_since = time.monotonic()
        on = False
    if led:
        led.value = on
    if on:
        # Blast as fast as CircuitPython allows to approximate a carrier.
        for _ in range(20):
            try:
                e.send(BURST, peer)
            except Exception:
                pass
    else:
        time.sleep(0.01)
