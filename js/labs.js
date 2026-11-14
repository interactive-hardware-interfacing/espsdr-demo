'use strict';

/*
 * labs.js — the guided labs, as data. Each lab is a few steps; a step has
 * HTML text, an optional `setup` the "Set it up" button applies to the
 * instrument's controls, and an optional `ask` question for the worksheet.
 *
 * setup keys → control ids:
 *   freq #freq · rate #rate · bw #bw · fft #fft · bits #bits · bands #bands
 *   avgmode #avgmode · hold #hold · persist #persist · agc #agc · gain #gain
 *   tdmode #tdmode · tdwin #tdwin · occband #occband · occthr #occthr · occwin #occwin
 *   log: { summary, spectrum, iq } → the Data logging checkboxes
 *
 * Everything works in the simulator; the beacon labs need the second board
 * for real numbers.
 */

export const LABS = [
  {
    id: 'read', title: 'Reading the band', minutes: 10, needs: 'receiver (or simulator)',
    steps: [
      { text: 'Connect the board or start the simulator. The spectrum is energy against frequency across 80 MHz; the waterfall is the same thing scrolling down, newest on top.',
        setup: { freq: 2442, rate: 80000000, bw: 'auto', fft: 2048, bands: 'wifi', avgmode: 'short', hold: 'live', persist: false },
        ask: 'How many humps can you see, and which Wi-Fi channels are they centred on?' },
      { text: '<b>Shift-click</b> just left and just right of the biggest hump to drop two markers. Under the plot: the width between them, the power between them, and the SNR.',
        ask: 'About how wide is a Wi-Fi channel? What is its SNR here?' },
      { text: 'Switch the trace to <b>max hold</b> and leave it for 30 seconds. Anything that showed up even once stays drawn.',
        setup: { hold: 'max' },
        ask: 'What did max hold catch that the live trace kept missing?' },
    ],
  },
  {
    id: 'span', title: 'Span vs. resolution', minutes: 10, needs: 'receiver (or simulator)',
    steps: [
      { text: 'Full span: 80 MS/s, 2048-point FFT. Read <b>kHz / bin</b> under the plots.',
        setup: { freq: 2437, rate: 80000000, fft: 2048, bw: 'auto', hold: 'live' },
        ask: 'kHz per bin at 80 MS/s, 2048 bins = ? (Check: sample rate ÷ FFT size.)' },
      { text: 'Zoom in: <b>16 MS/s</b>. Same FFT size, a fifth of the span, so every bin is five times narrower.',
        setup: { rate: 16000000 },
        ask: 'kHz per bin now? Does the Wi-Fi hump still fit on screen?' },
      { text: 'Now trade: try 512 and then 4096 FFT bins. Finer bins come from longer FFTs, and one 16 380-sample burst holds 32 blocks of 512 but only 4 of 4096 to average.',
        setup: { fft: 4096, avgmode: 'off' },
        ask: 'Which FFT size gives the smoothest noise floor, and why?' },
      { text: 'The analog filter sits in front of the ADC. Back to 80 MS/s and narrow it to 20 MHz: the band edges sink.',
        setup: { rate: 80000000, fft: 2048, bw: 20, avgmode: 'medium' },
        ask: 'Why would you narrow the filter if you only care about one channel?' },
    ],
  },
  {
    id: 'time', title: 'Packets in time', minutes: 10, needs: 'receiver (or simulator); beacon for step 3',
    steps: [
      { text: 'The <b>Time domain</b> panel is one capture, sample by sample. Packets are where the envelope steps up and back down.',
        setup: { freq: 2437, rate: 80000000, bw: 'auto', tdmode: 'env', tdwin: 1, agc: true },
        ask: 'Roughly how long is one packet, in µs? What does “on air” read?' },
      { text: 'Zoom to the first 1⁄16 and show I and Q. Inside a packet the two components swing back and forth: that is the carrier, offset from the centre frequency.',
        setup: { tdmode: 'iq', tdwin: 0.0625 } },
      { text: 'Beacon on. Untick <b>Hardware AGC</b> and raise the manual gain until the readout says <b>clipping</b>.',
        setup: { tdmode: 'env', tdwin: 1, agc: false, gain: 50 },
        ask: 'What happens to the I/Q scatter and to the spectrum when the samples clip?' },
    ],
  },
  {
    id: 'busy', title: 'Who’s busy?', minutes: 15, needs: 'receiver (or simulator)',
    steps: [
      { text: '<b>Channel occupancy</b> counts how often each channel was 10 dB above the floor over the last 200 captures. Wi-Fi neighbours overlap, so compare 1, 6 and 11.',
        setup: { freq: 2442, rate: 80000000, bw: 'auto', bands: 'wifi', occband: 'wifi', occthr: 10, occwin: 200 },
        ask: 'Which of 1, 6 and 11 is busiest? Does that match what you see in the waterfall?' },
      { text: 'Record a minute with <b>summary.csv</b> and <b>spectrum.csv</b> ticked, then download it. The notebook in <code>notebooks/analyze_log.ipynb</code> computes the same occupancy from the file.',
        setup: { log: { summary: true, spectrum: true, iq: false } } },
      { text: 'Bluetooth LE: overlay all three bands, occupancy on BLE. Advertising lives on 37 / 38 / 39, tucked between Wi-Fi 1, 6 and 11.',
        setup: { bands: 'all', occband: 'ble', persist: true },
        ask: 'Why would BLE put its advertising channels in those three gaps?' },
    ],
  },
  {
    id: 'loss', title: 'Path loss', minutes: 20, needs: 'receiver + beacon over USB (or simulator)',
    steps: [
      { text: 'Connect the beacon in <b>Beacon control</b>. Turn <b>Hardware AGC off</b> (it would turn the gain down as the beacon gets louder and hide the steps) and set a manual gain where the beacon is well below clipping.',
        setup: { freq: 2442, rate: 80000000, bw: 'auto', agc: false, gain: 35, log: { summary: true, spectrum: false, iq: false } } },
      { text: 'Beacon 1 m from the receiver. Type <code>d=1m</code> in the mark box and press Mark, then tick <b>power steps</b>: 20 → 2 dBm, 3 s each, with a mark at every step.',
        ask: 'How much does the received peak drop per 3 dB step?' },
      { text: 'Move the beacon to 3 m, mark <code>d=3m</code>, run the power steps again. Stop and download the log.',
        ask: 'Free space predicts 20·log10(3) ≈ 9.5 dB more loss at 3 m. What did you measure? What in the room makes it differ?' },
      { text: 'Open <code>notebooks/analyze_log.ipynb</code>, point it at the zip and run it: it fits received level against transmit power for each distance.' },
    ],
  },
  {
    id: 'morse', title: 'Read the waterfall', minutes: 10, needs: 'receiver + beacon over USB (or simulator)',
    steps: [
      { text: 'Connect the beacon in <b>Beacon control</b> and park it on a channel. One person types a short word and presses <b>Key it</b> at 5 WPM; the other reads it off the waterfall.',
        setup: { freq: 2442, rate: 80000000, bw: 'auto', avgmode: 'off', hold: 'live', persist: false },
        ask: 'What was the word? (A dot is 240 ms at 5 WPM, a dash three dots.)' },
      { text: 'Go to 12 WPM. A dot is now 100 ms. Compare with frames / s.',
        ask: 'At how many frames per second does a dot stop showing up reliably? Why?' },
    ],
  },
];
