"""Write a small synthetic log zip in the page's format (summary.csv,
spectrum.csv with a re-tune mid-way, marks.csv with two distances, a couple
of .npy snapshots) so CI can run the notebook end to end without a board.

    python tests/make_fixture_log.py /tmp/fixture.zip
"""
import io, sys, zipfile
import numpy as np

rng = np.random.default_rng(1)
out = sys.argv[1] if len(sys.argv) > 1 else 'fixture.zip'
summary = ['capture,t_s,iso_time,center_mhz,rate_hz,fft,bits,gain_mode,gain_index,peak_mhz,peak_dbfs,'
           'capture_us,retries,beacon,filter_mhz,beacon_ch,beacon_pwr_dbm']
spectrum, marks, npys = [], ['t_s,iso_time,capture,label'], {}
c = 0
for center, rate in [(2442, 80e6), (2437, 16e6)]:
    n = 512
    mhz = center + (np.arange(n) - n / 2) * rate / n / 1e6
    spectrum.append(','.join(['capture', 't_s'] + [f'{f:.4f}' for f in mhz]))
    for distance, loss in [(1, 0.0), (3, 9.5)]:
        marks.append(f'{c * 0.1:.3f},2026-01-01T00:00:00Z,{c},d={distance}m')
        for p in [20, 17, 14, 11, 8, 5, 2]:
            for _ in range(4):
                db = -95 + rng.normal(0, 2, n)
                for ch, busy in [(2412, .5), (2437, .9), (2462, .1)]:
                    if rng.random() < busy:
                        db[np.abs(mhz - ch) < 8] = -60 + rng.normal(0, 2, (np.abs(mhz - ch) < 8).sum())
                peak = -30 + p - loss + rng.normal(0, .5)
                summary.append(f'{c},{c * 0.1:.3f},2026-01-01T00:00:00Z,{center},{int(rate)},{n},8,MANUAL,35,2415.0,'
                               f'{peak:.2f},205,0,1,auto,1,{p}')
                spectrum.append(f'{c},{c * 0.1:.3f},' + ','.join(f'{v:.1f}' for v in db))
                if c % 50 == 0:
                    iq = (rng.normal(0, .02, (16380, 2))).astype('<f4')
                    b = io.BytesIO(); np.save(b, iq); npys[f'iq_{c:05d}.npy'] = b.getvalue()
                c += 1
with zipfile.ZipFile(out, 'w', zipfile.ZIP_STORED) as z:
    z.writestr('README.txt', 'synthetic fixture for tests/run_notebook.py\n')
    z.writestr('summary.csv', '\n'.join(summary) + '\n')
    z.writestr('spectrum.csv', '\n'.join(spectrum) + '\n')
    z.writestr('marks.csv', '\n'.join(marks) + '\n')
    for name, data in npys.items(): z.writestr(name, data)
print(f'{out}: {c} captures, {len(npys)} snapshots')
