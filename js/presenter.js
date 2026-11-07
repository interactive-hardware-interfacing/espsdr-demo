'use strict';

/*
 * presenter.js — one button for the projector.
 *
 * Presenter mode toggles `presenter` on <body>. The stylesheet (Part 1) then
 * hides anything marked data-presenter="hide" (the serial log, settings,
 * doc tabs), enlarges anything marked data-presenter="hero" (the main chart
 * and the headline numbers), and bumps the base font. Everything keeps
 * running; it is CSS only. Escape or the button leaves it. The choice is
 * remembered per browser so a laptop set up once stays set up.
 */
export function initPresenter(button) {
  const KEY = 'presenter';
  const set = on => {
    document.body.classList.toggle('presenter', on);
    button.textContent = on ? 'Exit presenter' : 'Presenter';
    button.setAttribute('aria-pressed', on ? 'true' : 'false');
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch {}
    window.dispatchEvent(new Event('resize'));   // canvases refit to their new size
  };
  button.addEventListener('click', () => set(!document.body.classList.contains('presenter')));
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.body.classList.contains('presenter')) set(false);
    if (document.body.dataset.nohotkey) return;   // a page may claim the keyboard (e.g. keyboard-keying mode)
    if (e.key === 'p' && !e.ctrlKey && !e.metaKey && !e.altKey && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName)) set(!document.body.classList.contains('presenter'));
  });
  let saved = false; try { saved = localStorage.getItem(KEY) === '1'; } catch {}
  if (saved || new URLSearchParams(location.search).has('presenter')) set(true);
}
