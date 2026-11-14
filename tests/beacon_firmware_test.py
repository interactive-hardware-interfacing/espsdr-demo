"""Exercise firmware/beacon/code.py's serial commands on CPython, with the
CircuitPython modules it imports mocked. Runs the file up to its main loop,
feeds command lines through a fake console, and checks the replies.

    python tests/beacon_firmware_test.py
"""
# Exercise beacon code.py's command handling on CPython with CircuitPython modules mocked.
import sys, types, io
mods = {}
for name in ['board', 'digitalio', 'wifi', 'espnow', 'supervisor']: mods[name] = types.ModuleType(name); sys.modules[name] = mods[name]
mods['board'].D2 = 'D2'; mods['board'].LED = 'LED'
class DIO:
    def __init__(self, pin): self.value = False
mods['digitalio'].DigitalInOut = DIO
mods['digitalio'].Direction = types.SimpleNamespace(INPUT=0, OUTPUT=1); mods['digitalio'].Pull = types.SimpleNamespace(DOWN=0)
class Radio:
    enabled = True; tx_power = 19.5
    def start_ap(self, **k): pass
    def stop_ap(self): pass
mods['wifi'].radio = Radio()
sent = []
class ESPNow:
    def __init__(self): self.peers = []
    def send(self, b, p): sent.append(p.channel)
mods['espnow'].ESPNow = ESPNow
mods['espnow'].Peer = lambda mac, channel: types.SimpleNamespace(mac=mac, channel=channel)
import os
src = open(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', 'firmware', 'beacon', 'code.py')).read()
src = src[:src.index('\nwhile True:')]
pending = io.StringIO()
class RT:
    @property
    def serial_bytes_available(self): return pending.tell() < len(pending.getvalue())
mods['supervisor'].runtime = RT()
g = {}
exec(compile(src, 'code.py', 'exec'), g)
sys.stdin = pending
def send(text):
    pos = pending.tell(); pending.write(text); pending.seek(pos)
    g['poll_serial']()
import contextlib
def ask(cmd):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        send(cmd + '\r\n')
    lines = [l for l in out.getvalue().splitlines() if l and not l.startswith('beacon on channel')]
    assert len(lines) == 1, (cmd, lines)
    return lines[0]

checks = [
    ('ID', r'^ID BEACON 1 ch=6 pwr=19\.5 on=0$'),
    ('ON', r'^OK ON$'),
    ('CH 11', r'^OK CH 11$'),
    ('CH 14', r'^ERR '),
    ('PWR 8', r'^OK PWR 8\.0$'),
    ('PWR 30', r'^ERR '),
    ('PWR abc', r'^ERR '),
    ('WPM 8', r'^OK WPM 8$'),
    ('MORSE SOS', r'^OK MORSE 34 units$'),
    ('STATUS?', r'^STATUS on=1 wire=0 ch=11 pwr=8\.0 wpm=8 morse=1$'),
    ('MORSE', r'^OK MORSE OFF$'),
    ('OFF', r'^OK OFF$'),
    ('bogus', r'^ERR command$'),
]
import re
for cmd, pattern in checks:
    r = ask(cmd)
    assert re.search(pattern, r), f'{cmd!r} -> {r!r}, wanted /{pattern}/'
    print(f'ok  {cmd:10s} -> {r}')

# CH also moves the home channel a long low on the wire returns to
ask('CH 3'); assert g['home'] == 3 and g['current'] == 3

# Morse timing: SOS = 3 dots, 3 dashes, 3 dots, 1/3/7-unit gaps, 34 units
s = g['morse_schedule']('SOS')
assert sum(u for _, u in s) == 34 and s[0] == (True, 1) and s[6] == (True, 3) and s[-1] == (False, 7)
g['keying'] = {'sched': s, 'total': 34, 't0': 0.0}; g['wpm'] = 5      # unit = 0.24 s
pattern = ''.join('#' if g['key_down'](0.12 + 0.24 * k) else '.' for k in range(34))
assert pattern == '#.#.#...###.###.###...#.#.#.......', pattern
print('ok  morse timing', pattern)
print('all beacon firmware checks passed')
