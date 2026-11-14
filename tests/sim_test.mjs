// The simulator is the "Try without hardware" path and the CI's stand-in for a
// board: check it still behaves like a C3 and that the beacon controls move it.
//   node tests/sim_test.mjs
import { SimSdr, SimBeacon, morseSchedule } from '../js/sim.js';
import assert from 'node:assert/strict';

const sdr = new SimSdr();
const info = await sdr.connect();
assert.deepEqual(info.rates, [80e6, 40e6, 16e6]);
assert.deepEqual(info.bandwidth, [14, 62, 1, 0]);

for (const rate of info.rates) {
  const c = await sdr.capture({ rate, fft: 2048 });
  assert.equal(c.iq.length, 2 * 16380, 'a C3 burst is 16 380 samples');
  assert.equal(c.spectrum.length, 2048);
  assert.ok(c.iq.every(v => v >= -1 && v <= 1), 'samples stay in ±1');
  assert.ok(Math.abs(c.captureUs - 16380 / rate * 1e6) <= 1);
}

// Beacon over "USB": channel and power move the carrier, 3 dB per 3 dB.
const bc = new SimBeacon(sdr); await bc.connect(); await bc.setOn(true); await bc.setChannel(1);
const peakAt = async dbm => {
  await bc.setPower(dbm); const v = [];
  for (let k = 0; k < 9; k++) { const c = await sdr.capture({ frequency: 2442, gainMode: 'MANUAL', gain: 35 }); v.push(c.peakDb); }
  return v.sort((a, b) => a - b)[4];
};
const hi = await peakAt(20), lo = await peakAt(8);
const c = await sdr.capture({ frequency: 2442, gainMode: 'MANUAL', gain: 35 });
assert.ok(Math.abs(c.peakHz / 1e6 - 2415) < 1, `beacon on ch 1 should peak near 2415 MHz, got ${c.peakHz / 1e6}`);
assert.ok(Math.abs((hi - lo) - 12) < 2.5, `20 → 8 dBm should drop ~12 dB, got ${(hi - lo).toFixed(1)}`);

// Manual gain past full scale clips; hardware AGC does not.
await bc.setPower(20);
const hot = await sdr.capture({ gainMode: 'MANUAL', gain: 60 });
assert.ok(hot.iq.some(v => v <= -1 || v >= 127 / 128), 'gain 60 with the beacon on should clip');
const agc = await sdr.capture({ gainMode: 'HARDWARE' });
assert.ok(agc.iq.every(v => Math.abs(v) < 0.95), 'AGC keeps the burst under full scale');

assert.equal(morseSchedule('SOS').reduce((a, [, u]) => a + u, 0), 34);
await sdr.disconnect();
assert.equal(sdr.beacon, null, 'disconnecting the radio drops the simulated beacon');
console.log(`sim ok · beacon 20 dBm ${hi.toFixed(1)} dBFS, 8 dBm ${lo.toFixed(1)} dBFS`);
