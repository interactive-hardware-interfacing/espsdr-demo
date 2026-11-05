# code.py — optional "jammer" node for espsdr-demo
#
# Runs on a second XIAO ESP32-C3 in CircuitPython. It parks a continuous
# ESP-NOW carrier a few MHz above the receiver's center frequency so there is
# always a strong, obvious signal to point at during the demo, even in an
# RF-quiet room.
#
# The receiver's GPIO4 line (driven by the web page's "Jammer" button) is read
# as an enable: pull it high to transmit, let it float/low to go quiet. Wire
# receiver GPIO4 -> this board's D2, and tie the two boards' GND together.
# If you don't wire the enable line, set ALWAYS_ON = True below.
#
# NOTE: keep this low power and brief. You are transmitting in the 2.4 GHz ISM
# band; it is meant for a classroom bench, not to interfere with anything.

import time
import board
import digitalio
import wifi
import espnow

ALWAYS_ON = False          # True = ignore the enable pin, always transmit
CHANNEL = 6                # Wi-Fi channel to sit on (2437 MHz)
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
try:
    wifi.radio.start_ap(ssid="espsdr-jammer", channel=CHANNEL)  # pins the channel
except Exception:
    pass

e = espnow.ESPNow()
peer = espnow.Peer(mac=b"\xff\xff\xff\xff\xff\xff", channel=CHANNEL)
e.peers.append(peer)

print("jammer ready on channel", CHANNEL, "- waiting for enable" if not ALWAYS_ON else "- always on")

while True:
    on = ALWAYS_ON or enable.value
    if led:
        led.value = on
    if on:
        # Blast as fast as CircuitPython allows to approximate a carrier.
        for _ in range(50):
            try:
                e.send(BURST, peer)
            except Exception:
                pass
    else:
        time.sleep(0.05)
