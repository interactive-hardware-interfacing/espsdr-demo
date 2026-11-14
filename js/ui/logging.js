'use strict';

/*
 * logging.js — the Data logging panel: Record / Stop / Download / Mark,
 * wired to a CaptureLogger (js/logger.js).
 */

import { $ } from './dom.js';
import { CaptureLogger, fmtBytes } from '../logger.js';

/**
 * @param {object} o
 * @param {(line:string) => void} o.log
 * @param {object} o.session          { connected, simulated, radio } — read live
 * @param {(label:string) => void} o.markWaterfall
 * @returns {{ logger: CaptureLogger, refresh: () => void }}
 */
export function initLogging({ log, session, markWaterfall }) {
  const logger = new CaptureLogger();
  let lastZip = null;
  const opts = () => ({ summary: $('#logSummary').checked, spectrum: $('#logSpectrum').checked, iq: $('#logIq').checked, iqEvery: Number($('#logIqEvery').value) });
  const nothingTicked = () => !$('#logSummary').checked && !$('#logSpectrum').checked && !$('#logIq').checked;

  logger.onChange = l => {
    const st = $('#recStatus');
    $('#recStart').disabled = l.recording || !session.connected;
    $('#recStart').classList.toggle('on', l.recording);
    $('#recStop').disabled = !l.recording;
    $('#recDownload').disabled = l.count === 0 && l.marks.length === 0;
    $('#recMark').disabled = !session.connected;
    for (const id of ['logSummary', 'logSpectrum', 'logIq', 'logIqEvery']) $('#' + id).disabled = l.recording;
    if (l.full) { st.textContent = `Stopped at ${fmtBytes(l.bytes)} — memory cap reached. Download, then record again.`; st.className = 'recstatus full'; }
    else if (l.recording) { st.textContent = `recording · ${l.count} captures · ${l.marks.length} marks · ${fmtBytes(l.bytes)}`; st.className = 'recstatus on'; }
    else if (l.count) { st.textContent = `${l.count} captures · ${fmtBytes(l.bytes)} ready to download`; st.className = 'recstatus'; }
    else { st.textContent = 'Connect or start the simulator, then record.'; st.className = 'recstatus'; }
  };

  $('#recStart').addEventListener('click', () => {
    if (nothingTicked()) { log('⚠ pick at least one thing to log'); return; }
    logger.start(opts());
    log(`[log] recording${session.simulated ? ' (simulator)' : ''}`);
  });
  $('#recStop').addEventListener('click', () => { logger.stop(); log(`[log] stopped: ${logger.count} captures, ${fmtBytes(logger.bytes)}`); });
  $('#recDownload').addEventListener('click', () => {
    const { blob, name } = logger.toZip({ source: session.simulated ? 'simulator' : 'board', identity: session.radio?.identity || '' });
    if (lastZip) URL.revokeObjectURL(lastZip);
    lastZip = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = lastZip; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    log(`[log] ${name} (${fmtBytes(blob.size)})`);
  });
  const doMark = () => {
    if (!session.connected) return;
    if (!logger.recording) {
      if (nothingTicked()) $('#logSummary').checked = true;
      logger.opts = opts();
    }
    const m = logger.mark($('#recMarkLabel').value.trim());
    $('#recMarkLabel').value = '';
    log(`[mark] ${m.t.toFixed(1)}s ${m.label}`);
    markWaterfall(m.label);
  };
  $('#recMark').addEventListener('click', doMark);
  $('#recMarkLabel').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doMark(); } });

  return { logger, refresh: () => logger.onChange(logger) };
}
