'use strict';

/*
 * dom.js — the small helpers every view module shares: a query shortcut,
 * CSS-variable lookup for canvas colours, DPR-aware canvas sizing, and the
 * serial log writer.
 */

export const $ = sel => document.querySelector(sel);

export function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

// Size a canvas bitmap to its on-screen size × devicePixelRatio so lines and
// text stay crisp; drawing code then works in CSS pixels through a transform.
// Returns the CSS-pixel size. The waterfall is handled separately
// (waterfall.js) because its bitmap *is* its history.
export function fit(canvas, ctx) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { W: canvas.clientWidth, H: canvas.clientHeight };
}

/** The serial-log panel: returns log(line), which timestamps and appends. */
export function makeLog(el) {
  return function log(line) {
    const t = new Date().toLocaleTimeString();
    el.textContent += `[${t}] ${line}\n`;
    el.scrollTop = el.scrollHeight;
  };
}
