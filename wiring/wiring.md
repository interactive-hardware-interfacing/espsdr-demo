# Wiring — espsdr-demo

This is the source of truth for the hardware/wiring tables on the page.
`wiring.svg` is the diagram; the page embeds an inline, theme-aware copy of it.

## Receiver node (required)

| Signal          | XIAO C3 pin | Goes to            | Note                                             |
|-----------------|-------------|--------------------|--------------------------------------------------|
| USB data + power| USB-C       | Laptop             | The only required connection                     |
| Antenna         | u.FL        | Whip antenna       | Clip on firmly — the only antenna the C3 has     |
| Jammer enable   | GPIO4       | Jammer input (D2)  | Optional; only if using the jammer node          |

Runs **ESP-SDR** stock firmware (see `../firmware/VERSION.txt`).

## Jammer node (optional)

| Signal        | XIAO C3 pin | Goes to              | Note                                    |
|---------------|-------------|----------------------|-----------------------------------------|
| Enable in     | D2          | Receiver GPIO4       | Pull-down; high = transmit              |
| GND           | GND         | Receiver GND         | Required if using the enable line       |
| USB power     | USB-C       | USB bank or laptop   | Separate from the receiver              |
| Antenna       | u.FL        | Whip antenna         | Clip on firmly                          |

Runs the CircuitPython sketch in `../firmware/jammer/code.py`.

## Notes

- Only the receiver talks to the browser. The jammer is independent.
- No level shifting needed here: both boards are 3.3 V logic, and GPIO4↔D2 is
  3.3 V on both ends.
- Without the jammer, the demo runs on the room's ambient Wi-Fi/BLE instead.
