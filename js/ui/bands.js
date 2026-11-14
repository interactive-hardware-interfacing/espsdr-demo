'use strict';

/*
 * bands.js — who else lives in 2.4 GHz. Channel tables for Wi-Fi (802.11b/g/n),
 * Bluetooth Low Energy and IEEE 802.15.4 (Zigbee / Thread / Matter), and the
 * overlay that draws them on the spectrum. The occupancy panel uses the same
 * tables, so "channel" means the same thing in both places.
 *
 *   Wi-Fi     ch 1–13 at 2407 + 5·ch MHz, ~20 MHz wide (ch 14, 2484, Japan/11b only)
 *   BLE       40 channels, 2 MHz apart from 2402; advertising on 37 / 38 / 39
 *             = 2402 / 2426 / 2480 MHz, deliberately in the gaps between Wi-Fi 1/6/11
 *   802.15.4  ch 11–26 at 2405 + 5·(ch − 11) MHz, 2 MHz wide
 */

import { cssVar } from './dom.js';

const wifi = Array.from({ length: 13 }, (_, k) => ({ ch: k + 1, mhz: 2412 + 5 * k, width: 20, key: [1, 6, 11].includes(k + 1) }));
// BLE channel index → frequency: advertising 37/38/39 sit at 2402/2426/2480, data 0–36 fill the rest.
const bleMHz = i => i === 37 ? 2402 : i === 38 ? 2426 : i === 39 ? 2480 : 2404 + 2 * i + (i >= 11 ? 2 : 0);
const ble = Array.from({ length: 40 }, (_, i) => ({ ch: i, mhz: bleMHz(i), width: 2, key: i >= 37 }));
const z154 = Array.from({ length: 16 }, (_, k) => ({ ch: k + 11, mhz: 2405 + 5 * k, width: 2, key: [15, 20, 25, 26].includes(k + 11) }));

export const BANDS = {
  wifi: { name: 'Wi‑Fi', prefix: 'Wi‑Fi ', channels: wifi, dash: [] },
  ble: { name: 'BLE', prefix: 'BLE ', channels: ble, dash: [2, 3] },
  z154: { name: '802.15.4', prefix: '15.4 ch', channels: z154, dash: [6, 3] },
};

/** Which band sets an overlay choice turns on. */
export function bandSets(choice) {
  return choice === 'all' ? ['wifi', 'ble', 'z154'] : choice === 'none' ? [] : [choice];
}

/**
 * Draw the overlay. Returns the y (CSS px) below the last label row, so
 * other text can sit under it.
 */
export function drawBands(ctx, { W, H, loMHz, hiMHz, choice }) {
  const span = hiMHz - loMHz, X = f => (f - loMHz) / span * W;
  const sets = bandSets(choice);
  const zoomed = span <= 40;
  let y = 12;
  ctx.save();
  ctx.font = '11px system-ui, sans-serif';
  for (const id of sets) {
    const b = BANDS[id];
    let lastEnd = -Infinity;
    for (const c of b.channels) {
      if (c.mhz + c.width / 2 < loMHz || c.mhz - c.width / 2 > hiMHz) continue;
      // BLE data channels are only worth drawing when zoomed in; otherwise it's a comb
      if (id === 'ble' && !c.key && !zoomed) continue;
      const x = X(c.mhz);
      // occupied width, shaded, for the channels people actually plan around
      if (c.key) {
        ctx.fillStyle = cssVar('--text'); ctx.globalAlpha = id === 'wifi' ? 0.035 : 0.06;
        ctx.fillRect(X(c.mhz - c.width / 2), 0, X(c.mhz + c.width / 2) - X(c.mhz - c.width / 2), H);
      }
      ctx.strokeStyle = cssVar(c.key ? '--muted' : '--grid'); ctx.globalAlpha = c.key ? 0.55 : 0.5;
      ctx.setLineDash(b.dash); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      ctx.setLineDash([]);
      // label the key channels always, the rest when zoomed, and never on top of each other
      if (c.key || zoomed) {
        const t = b.prefix + c.ch, w = ctx.measureText(t).width;
        if (x + 3 > lastEnd + 4 && x + 3 + w < W) {
          ctx.globalAlpha = 1; ctx.fillStyle = cssVar(c.key ? '--muted' : '--faint');
          ctx.fillText(t, x + 3, y); lastEnd = x + 3 + w;
        }
      }
    }
    y += 13;
  }
  ctx.restore();
  return y;
}
