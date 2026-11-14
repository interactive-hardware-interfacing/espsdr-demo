'use strict';

/*
 * labs-panel.js — the "Guided labs" panel: pick a lab, step through it, and
 * let "Set it up" put the instrument's controls where the step wants them.
 * Lab content lives in js/labs.js. `?lab=<id>&step=<n>` in the URL opens a
 * lab directly (n counts from 1), so a handout can link straight to a step.
 */

import { $ } from './dom.js';
import { LABS } from '../labs.js';

const IDS = {
  freq: '#freq', rate: '#rate', bw: '#bw', fft: '#fft', bits: '#bits', bands: '#bands',
  avgmode: '#avgmode', hold: '#hold', persist: '#persist', agc: '#agc', gain: '#gain',
  tdmode: '#tdmode', tdwin: '#tdwin', occband: '#occband', occthr: '#occthr', occwin: '#occwin',
};

/** @param {{ log: (line:string) => void }} o */
export function initLabs({ log }) {
  const ui = {
    box: $('#labs'), pick: $('#labPick'), meta: $('#labMeta'), step: $('#labStep'), text: $('#labText'), ask: $('#labAsk'),
    prev: $('#labPrev'), next: $('#labNext'), setup: $('#labSetup'), copy: $('#labCopy'),
  };
  ui.pick.replaceChildren(...LABS.map((l, i) => new Option(`${i + 1}. ${l.title}`, l.id)));
  let lab = LABS[0], i = 0;

  function show() {
    const s = lab.steps[i];
    ui.meta.textContent = `about ${lab.minutes} min · needs ${lab.needs}`;
    ui.step.textContent = `step ${i + 1} of ${lab.steps.length}`;
    ui.text.innerHTML = s.text;                       // lab text is our own markup, from labs.js
    ui.ask.hidden = !s.ask; ui.ask.textContent = s.ask ? '? ' + s.ask : '';
    ui.prev.disabled = i === 0; ui.next.disabled = i === lab.steps.length - 1;
    ui.setup.disabled = !s.setup;
  }

  function set(sel, value) {
    const el = $(sel); if (!el) return;
    if (el.type === 'checkbox') { if (el.checked !== !!value) { el.checked = !!value; el.dispatchEvent(new Event('change')); } return; }
    const v = String(value);
    if (el.tagName === 'SELECT' && ![...el.options].some(o => o.value === v)) { log(`(lab: ${sel.slice(1)} = ${v} needs a board connected first)`); return; }
    if (el.value === v) return;
    el.value = v;
    el.dispatchEvent(new Event(el.type === 'range' ? 'input' : 'change'));
    if (el.type === 'range') el.dispatchEvent(new Event('change'));
  }
  function apply(setup) {
    for (const [k, v] of Object.entries(setup)) {
      if (k === 'log') { for (const [f, on] of Object.entries(v)) { const el = $('#log' + f[0].toUpperCase() + f.slice(1)); if (el && !el.disabled) el.checked = on; } continue; }
      // gain only moves when manual gain is on, so apply agc first
      if (k === 'gain' && 'agc' in setup) set(IDS.agc, setup.agc);
      if (IDS[k]) set(IDS[k], v);
    }
    log(`[lab] ${lab.title}, step ${i + 1}: set up`);
  }

  function choose(id, step = 0) {
    lab = LABS.find(l => l.id === id) || LABS[0];
    i = Math.max(0, Math.min(lab.steps.length - 1, step));
    ui.pick.value = lab.id; show();
  }
  ui.pick.addEventListener('change', () => choose(ui.pick.value));
  ui.prev.addEventListener('click', () => { if (i > 0) { i--; show(); } });
  ui.next.addEventListener('click', () => { if (i < lab.steps.length - 1) { i++; show(); } });
  ui.setup.addEventListener('click', () => { const s = lab.steps[i]; if (s.setup) apply(s.setup); });
  ui.copy.addEventListener('click', async () => {
    const strip = h => h.replace(/<[^>]+>/g, '');
    const md = `# ${lab.title}\n\n_about ${lab.minutes} min · needs ${lab.needs}_\n\n` + lab.steps.map((s, k) =>
      `${k + 1}. ${strip(s.text)}${s.ask ? `\n   - **Q:** ${s.ask}\n   - **A:** ` : ''}`).join('\n\n') + '\n';
    try { await navigator.clipboard.writeText(md); log(`[lab] worksheet for "${lab.title}" copied (Markdown)`); }
    catch { log('⚠ the browser would not let the page use the clipboard'); }
  });

  const q = new URLSearchParams(location.search);
  if (q.has('lab')) { choose(q.get('lab'), (Number(q.get('step')) || 1) - 1); ui.box.open = true; }
  else show();
  return { choose };
}
