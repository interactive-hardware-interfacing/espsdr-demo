'use strict';

/*
 * views.js — Instrument / Hardware / Firmware / About as swapped-in views.
 *
 * The instrument is the default. Clicking a doc tab hides the instrument block
 * and shows that one section in its place, with a "Back to instrument" button;
 * the URL hash (#hardware, #firmware, #about) follows so a link can be shared
 * and the browser's back button works. Nothing is torn down on a switch: the
 * simulator, decoder and sidetone keep running underneath.
 */

/**
 * @param {HTMLElement} instrument       the block hidden while a doc view is open
 * @param {Record<string, HTMLElement>} views   id → section
 * @param {HTMLElement[]} tabs           nav links with data-view="<id>" ("" = instrument)
 * @param {(id: string) => void} [onChange]
 */
export function initViews(instrument, views, tabs, onChange) {
  let current = '';
  function show(id) {
    if (!(id in views)) id = '';
    current = id;
    instrument.hidden = !!id;
    for (const [k, el] of Object.entries(views)) el.hidden = k !== id;
    for (const t of tabs) t.setAttribute('aria-current', (t.dataset.view || '') === id ? 'page' : 'false');
    if (id) views[id].scrollIntoView({ block: 'start' }); else window.scrollTo({ top: 0 });
    if (onChange) onChange(id);
  }
  function go(id) {
    show(id);
    const url = id ? '#' + id : location.pathname + location.search;
    history.replaceState(null, '', url);
  }
  for (const t of tabs) t.addEventListener('click', e => { e.preventDefault(); go(t.dataset.view || ''); });
  for (const el of Object.values(views)) el.querySelectorAll('[data-back]').forEach(b => b.addEventListener('click', () => go('')));
  window.addEventListener('hashchange', () => show(location.hash.slice(1)));
  show(location.hash.slice(1));
  return { go, get current() { return current; } };
}
