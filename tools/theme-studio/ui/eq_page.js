// The EQ tab: edits one preset, and reads and writes the card's EQ folder through the host. app.js
// makes it with the host and its toast and notice, and calls show when the tab opens.
(function () {
  'use strict';

  const eq = window.Q2Eq;
  const $ = (id) => document.getElementById(id);

  const HISTORY_MAX = 200;
  const DEFAULT_RATE = 48000;
  const GRAPH_POINTS = 360;
  const IEM_ROWS = 200; // rows a search shows at once
  const PINS_MAX = 32; // main.rs MAX_PINS: the Q2's EQ list holds 64 rows, the pins first
  const CARD_WATCH_MS = 3000; // a Q2 can take minutes to show up on USB, so the tab keeps looking
  const RANGE_STEP = 6; // the graph's dB range grows in these
  const RANGE_MIN = 12;
  const RANGE_MAX = 30;
  const NODE_R = 6;
  const NODE_REACH = 14; // CSS pixels a press can miss a band's dot by
  const WHEEL_STEP = 1.08;
  const GAP = { left: 42, right: 14, top: 12, bottom: 24 };
  const FREQ_LINES = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  const LOG_LOW = Math.log10(eq.FREQ_MIN);
  const LOG_SPAN = Math.log10(eq.FREQ_MAX) - LOG_LOW;
  const CHANNEL_NAMES = { all: 'Both', L: 'Left', R: 'Right' };
  const TYPE_NAMES = { PK: 'Peak', LSC: 'Low shelf', HSC: 'High shelf' };
  const COLOUR = {
    back: '#141518', grid: '#2c2d32', zero: '#55565e', text: '#a4a5ab',
    both: '#7db0ff', left: '#7db0ff', right: '#f3a35f', band: 'rgba(255, 255, 255, .35)',
    node: '#e8e8ea', off: '#6e6f76', pick: '#f3c15f',
  };

  const signed = (value, digits = 1) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(digits)}`;
  const hertz = (f) => (f >= 1000 ? `${+(f / 1000).toFixed(2)} kHz` : `${Math.round(f)} Hz`);
  const axisHertz = (f) => (f >= 1000 ? `${f / 1000}k` : `${f}`);

  window.Q2EqPage = function make(host, { toast, notice, changed }) {
    let preset = eq.normalize(eq.newPreset());
    let savedState = JSON.stringify(preset);
    let picked = 0;
    let rate = DEFAULT_RATE;
    let shownBands = -1; // the rows the table holds
    let graph = null; // its scale, kept through a drag
    let drag = null;
    const history = { past: [], future: [], key: null };
    // names: what the Q2 would list. taken: everything in the folder. listed: the drive those are for,
    // and a save waits for it, so nothing is replaced without being said.
    const card = { drives: [], letter: null, names: [], taken: [], listed: null, busy: false, seen: '', looking: false, watch: 0 };
    const typing = new WeakSet(); // boxes holding text not yet applied
    let iems = []; // the built-in presets, once presets.json has come
    let chosen = null; // the one last opened from them
    let pins = []; // the names Home's EQ card flips through, in order, as the card has them
    let pinning = false;

    const unsaved = () => JSON.stringify(preset) !== savedState;

    function markSaved() {
      savedState = JSON.stringify(preset);
      changed();
    }

    function commit(next, key = null) {
      const clean = eq.normalize(next);
      const before = JSON.stringify(preset);
      if (before === JSON.stringify(clean)) {
        if (key !== history.key) history.key = null;
        return false;
      }
      if (!key || key !== history.key) {
        history.past.push(before);
        if (history.past.length > HISTORY_MAX) history.past.shift();
      }
      history.key = key;
      history.future.length = 0;
      preset = clean;
      render();
      return true;
    }

    function step(from, to) {
      if (!from.length || drag) return;
      to.push(JSON.stringify(preset));
      preset = JSON.parse(from.pop());
      picked = Math.min(picked, Math.max(preset.bands.length - 1, 0));
      history.key = null;
      render();
    }

    const editBand = (index, edit, key) => {
      const next = structuredClone(preset);
      edit(next.bands[index]);
      return commit(next, key);
    };

    /* ---------- The band table ---------- */

    function field(type, name, attrs) {
      const input = document.createElement('input');
      input.type = type;
      input.dataset.field = name;
      Object.assign(input, attrs);
      return input;
    }

    function choice(name, options, label) {
      const select = document.createElement('select');
      select.dataset.field = name;
      select.setAttribute('aria-label', label);
      for (const [value, text] of Object.entries(options)) select.add(new Option(text, value));
      return select;
    }

    function buildRow(index) {
      const row = document.createElement('tr');
      row.dataset.index = index;
      const number = `Band ${index + 1}`;
      const cells = [
        Object.assign(document.createElement('span'), { textContent: index + 1, className: 'muted' }),
        field('checkbox', 'on', { role: 'switch', title: `Turn ${number.toLowerCase()} on or off`, ariaLabel: `${number} on` }),
        choice('type', TYPE_NAMES, `${number} type`),
        choice('channel', CHANNEL_NAMES, `${number} channel`),
        field('number', 'freq', { min: eq.FREQ_MIN, max: eq.FREQ_MAX, step: 'any', ariaLabel: `${number} frequency in hertz` }),
        field('number', 'gain', { min: -eq.GAIN_MAX, max: eq.GAIN_MAX, step: 0.1, ariaLabel: `${number} gain in decibels` }),
        field('number', 'q', { min: eq.Q_MIN, max: eq.Q_MAX, step: 0.01, ariaLabel: `${number} Q` }),
      ];
      for (const control of cells) {
        const cell = document.createElement('td');
        cell.append(control);
        row.append(cell);
      }
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'quiet';
      remove.dataset.remove = '1';
      remove.textContent = '✕';
      remove.title = `Remove ${number.toLowerCase()}`;
      remove.setAttribute('aria-label', remove.title);
      const cell = document.createElement('td');
      cell.append(remove);
      row.append(cell);
      return row;
    }

    // A box the user is typing in keeps what they typed.
    function setValue(input, value) {
      if (!typing.has(input)) input.value = value;
    }

    function syncTable() {
      const body = $('eqBandRows');
      if (shownBands !== preset.bands.length) {
        body.textContent = '';
        for (let index = 0; index < preset.bands.length; index += 1) body.append(buildRow(index));
        shownBands = preset.bands.length;
      }
      preset.bands.forEach((band, index) => {
        const row = body.children[index];
        row.classList.toggle('selected', index === picked);
        row.classList.toggle('is-off', !band.on);
        for (const input of row.querySelectorAll('[data-field]')) {
          const name = input.dataset.field;
          if (name === 'on') input.checked = band.on;
          else setValue(input, band[name]);
        }
      });
      $('eqEmpty').hidden = preset.bands.length > 0;
      $('eqAdd').disabled = preset.bands.length >= eq.MAX_BANDS;
      $('eqAdd').title = $('eqAdd').disabled ? `The Q2 takes up to ${eq.MAX_BANDS} bands.` : '';
      $('eqSort').disabled = preset.bands.length < 2;
      $('eqCount').textContent = `${preset.bands.length} of ${eq.MAX_BANDS} bands`;
    }

    function addBand(freq = 1000, gain = 0) {
      if (preset.bands.length >= eq.MAX_BANDS) return;
      const next = structuredClone(preset);
      next.bands.push(eq.newBand(freq, gain));
      picked = next.bands.length - 1;
      commit(next);
    }

    function removeBand(index) {
      const next = structuredClone(preset);
      next.bands.splice(index, 1);
      picked = Math.min(picked, Math.max(next.bands.length - 1, 0));
      commit(next);
    }

    function sortBands() {
      const next = structuredClone(preset);
      const chosen = next.bands[picked];
      next.bands.sort((a, b) => a.freq - b.freq);
      picked = Math.max(next.bands.indexOf(chosen), 0);
      commit(next);
    }

    /* ---------- The graph ---------- */

    function sizeCanvas(canvas) {
      const box = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      const [w, h] = [Math.round(box.width * ratio), Math.round(box.height * ratio)];
      if (canvas.width !== w || canvas.height !== h) [canvas.width, canvas.height] = [w, h];
      return { w: box.width, h: box.height, ratio };
    }

    function curvePoints() {
      const points = [];
      for (let i = 0; i < GRAPH_POINTS; i += 1) {
        const f = 10 ** (LOG_LOW + LOG_SPAN * i / (GRAPH_POINTS - 1));
        points.push({ f, ...eq.response(preset, f, rate) });
      }
      return points;
    }

    // The graph's reach follows the curve and the dots, but stands still through a drag.
    function rangeFor(points) {
      if (drag && graph) return graph.range;
      let most = 0;
      for (const point of points) most = Math.max(most, Math.abs(point.left), Math.abs(point.right));
      for (const band of preset.bands) if (band.on) most = Math.max(most, Math.abs(band.gain));
      return Math.min(Math.max(Math.ceil((most + 1) / RANGE_STEP) * RANGE_STEP, RANGE_MIN), RANGE_MAX);
    }

    function drawCurve(context, scale, points, key, colour) {
      context.beginPath();
      points.forEach((point, index) => {
        const [x, y] = [scale.x(point.f), scale.y(point[key])];
        if (index) context.lineTo(x, y);
        else context.moveTo(x, y);
      });
      context.strokeStyle = colour;
      context.lineWidth = 2;
      context.stroke();
    }

    function drawGraph() {
      const canvas = $('eqGraph');
      const { w, h, ratio } = sizeCanvas(canvas);
      if (!w || !h) return;
      const context = canvas.getContext('2d');
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      const points = curvePoints();
      const range = rangeFor(points);
      const [plotW, plotH] = [w - GAP.left - GAP.right, h - GAP.top - GAP.bottom];
      const scale = {
        range,
        x: (f) => GAP.left + (Math.log10(f) - LOG_LOW) / LOG_SPAN * plotW,
        y: (gain) => GAP.top + (range - Math.min(Math.max(gain, -range), range)) / (2 * range) * plotH,
        freqAt: (x) => 10 ** (LOG_LOW + (x - GAP.left) / plotW * LOG_SPAN),
        gainAt: (y) => range - (y - GAP.top) / plotH * 2 * range,
      };
      graph = scale;

      context.fillStyle = COLOUR.back;
      context.fillRect(0, 0, w, h);
      context.font = '11px "Segoe UI", sans-serif';
      context.textBaseline = 'middle';
      context.fillStyle = COLOUR.text;
      context.lineWidth = 1;
      for (const f of FREQ_LINES) {
        const x = Math.round(scale.x(f)) + 0.5;
        context.strokeStyle = COLOUR.grid;
        context.beginPath();
        context.moveTo(x, GAP.top);
        context.lineTo(x, GAP.top + plotH);
        context.stroke();
        context.textAlign = 'center';
        context.fillText(axisHertz(f), x, h - GAP.bottom / 2);
      }
      for (let gain = -range; gain <= range; gain += RANGE_STEP) {
        const y = Math.round(scale.y(gain)) + 0.5;
        context.strokeStyle = gain ? COLOUR.grid : COLOUR.zero;
        context.beginPath();
        context.moveTo(GAP.left, y);
        context.lineTo(GAP.left + plotW, y);
        context.stroke();
        context.textAlign = 'right';
        context.fillText(gain > 0 ? `+${gain}` : `${gain}`.replace('-', '−'), GAP.left - 6, y);
      }

      const band = preset.bands[picked];
      if (band?.on) {
        const own = points.map((point) => ({ f: point.f, gain: eq.bandResponse(band, point.f, rate) }));
        context.save();
        context.setLineDash([4, 4]);
        drawCurve(context, scale, own, 'gain', COLOUR.band);
        context.restore();
      }
      const split = points.some((point) => Math.abs(point.left - point.right) > 0.01);
      if (split) {
        drawCurve(context, scale, points, 'right', COLOUR.right);
        drawCurve(context, scale, points, 'left', COLOUR.left);
      } else {
        drawCurve(context, scale, points, 'left', COLOUR.both);
      }
      $('eqLegend').hidden = !split;

      preset.bands.forEach((item, index) => {
        context.beginPath();
        context.arc(scale.x(item.freq), scale.y(item.gain), NODE_R, 0, 2 * Math.PI);
        context.fillStyle = index === picked ? COLOUR.pick : item.on ? COLOUR.node : COLOUR.off;
        context.fill();
        context.lineWidth = 2;
        context.strokeStyle = COLOUR.back;
        context.stroke();
      });
    }

    function pointerAt(event) {
      const box = $('eqGraph').getBoundingClientRect();
      return { x: event.clientX - box.left, y: event.clientY - box.top };
    }

    function nodeAt({ x, y }) {
      let [best, reach] = [-1, NODE_REACH];
      preset.bands.forEach((band, index) => {
        const away = Math.hypot(graph.x(band.freq) - x, graph.y(band.gain) - y);
        if (away <= reach) [best, reach] = [index, away];
      });
      return best;
    }

    function pick(index) {
      if (index === picked) return;
      picked = index;
      history.key = null;
      render();
    }

    function graphDown(event) {
      if (event.button !== 0 || !graph) return;
      const at = pointerAt(event);
      const index = nodeAt(at);
      if (index < 0) return;
      pick(index);
      const { freq, gain } = preset.bands[index];
      drag = { index, key: `drag:${performance.now()}`, dx: graph.x(freq) - at.x, dy: graph.y(gain) - at.y };
      $('eqGraph').setPointerCapture(event.pointerId);
    }

    function graphMove(event) {
      const canvas = $('eqGraph');
      if (!drag) {
        if (graph) canvas.classList.toggle('over-node', nodeAt(pointerAt(event)) >= 0);
        return;
      }
      if (!event.buttons) {
        graphUp();
        return;
      }
      const { x, y } = pointerAt(event);
      const freq = Number(graph.freqAt(x + drag.dx).toPrecision(3));
      const gain = Math.round(graph.gainAt(y + drag.dy) * 10) / 10;
      editBand(drag.index, (band) => {
        band.freq = freq;
        band.gain = gain;
      }, drag.key);
    }

    function graphUp() {
      if (!drag) return;
      drag = null;
      history.key = null;
      render();
    }

    function graphWheel(event) {
      if (!graph || !preset.bands.length) return;
      event.preventDefault();
      const over = nodeAt(pointerAt(event));
      const index = over >= 0 ? over : picked;
      const factor = event.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP;
      if (index !== picked) picked = index;
      editBand(index, (band) => { band.q = band.q * factor; }, `q:${index}`);
    }

    function graphDouble(event) {
      if (!graph) return;
      const at = pointerAt(event);
      if (nodeAt(at) >= 0) return;
      addBand(Number(graph.freqAt(at.x).toPrecision(3)), Math.round(graph.gainAt(at.y) * 10) / 10);
    }

    /* ---------- The side panel ---------- */

    function fillWarnings(box, messages) {
      box.textContent = '';
      for (const message of messages) {
        const line = document.createElement('p');
        line.textContent = message;
        box.append(line);
      }
      box.hidden = !messages.length;
    }

    function syncSide() {
      $('eqPreampMode').value = preset.auto ? 'auto' : 'set';
      $('eqPreamp').hidden = preset.auto;
      setValue($('eqPreamp'), preset.preamp);
      setValue($('eqBalance'), preset.balance);
      $('eqRate').value = String(rate);
      const cut = eq.autoPreamp(preset);
      $('eqAutoNote').textContent = preset.auto
        ? `Auto cuts ${signed(cut)} dB at 48 kHz. The Q2 works it out again for each song's sample rate.`
        : `Auto would cut ${signed(cut)} dB at 48 kHz.`;
      const { power, at } = eq.peak(preset, rate, eq.FREQ_MIN);
      $('eqPeak').textContent = power > 1
        ? `Loudest boost ${signed(10 * Math.log10(power))} dB at ${hertz(at)}`
        : 'No boost anywhere';
      fillWarnings($('eqWarn'), eq.warnings(preset, rate));
    }

    function render() {
      syncTable();
      drawGraph();
      syncSide();
      setValue($('eqName'), preset.name);
      syncIem();
      syncPins();
      $('eqUndo').disabled = !history.past.length;
      $('eqRedo').disabled = !history.future.length;
      changed();
    }

    /* ---------- Files and the card ---------- */

    // A preset in, replacing this one: undo brings that back.
    function load(text, name, source) {
      const parsed = eq.parse(text, name);
      if (!parsed.ok) {
        notice('This preset could not be opened', `${parsed.error}. The Q2 would refuse it too.`);
        return false;
      }
      const replaced = unsaved();
      picked = 0;
      commit(parsed.preset);
      history.key = null;
      $('eqName').value = preset.name;
      if (!replaced) markSaved(); // what it replaced is only in Undo, so closing still asks
      render();
      toast(`“${preset.name || 'The preset'}” is loaded from ${source}.${replaced ? ' Undo brings back what you had.' : ''}`);
      return true;
    }

    const count = (n) => n.toLocaleString('en-US');

    function syncIem() {
      for (const row of $('eqIemList').children) {
        const iem = iems[Number(row.firstChild.dataset.iem)];
        row.classList.toggle('selected', iem === chosen && eq.cleanName(iem.name) === preset.name);
      }
    }

    /* ---------- Pins ---------- */

    const pinName = (name) => eq.nameOfFile(eq.fileName(name));

    function pinButton(name) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'quiet pin';
      button.dataset.pin = name;
      return button;
    }

    function syncPins() {
      const ready = !!card.letter && card.listed === card.letter && !pinning;
      for (const button of document.querySelectorAll('#eqIemList .pin, #eqCardList .pin')) {
        const on = pins.includes(pinName(button.dataset.pin));
        button.textContent = on ? '★' : '☆';
        button.title = !card.letter ? 'Connect the card to pin presets.' : on ? 'Unpin this preset' : 'Pin this preset';
        button.setAttribute('aria-label', `${on ? 'Unpin' : 'Pin'} ${button.dataset.pin}`);
        button.setAttribute('aria-pressed', String(on));
        button.disabled = !ready;
      }
      for (const button of $('eqPinList').querySelectorAll('button')) button.disabled = !ready;
      const here = pins.includes(pinName(preset.name));
      $('eqPinThis').textContent = here ? 'Unpin this one' : 'Pin this one';
      $('eqPinThis').disabled = !ready;
    }

    function renderPins() {
      const list = $('eqPinList');
      list.textContent = '';
      pins.forEach((name, index) => {
        const row = document.createElement('div');
        row.className = 'row';
        row.dataset.index = index;
        const label = document.createElement('span');
        label.className = 'label pin-name';
        label.textContent = name;
        label.title = name;
        row.append(label);
        for (const [text, title, move] of [['↑', 'Move up', -1], ['↓', 'Move down', 1], ['✕', 'Unpin', 0]]) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'quiet pin';
          button.textContent = text;
          button.title = title;
          button.setAttribute('aria-label', `${title}: ${name}`);
          button.dataset.move = move;
          row.append(button);
        }
        list.append(row);
      });
      $('eqPinNote').textContent = !card.letter ? 'Connect the card to pin presets.'
        : pins.length ? 'Tapping EQ on Now Playing, or turning the wheel in Home\'s EQ, flips through these in this order, and Off.'
          : 'Press a star to pin a preset. With none pinned, the Q2 flips through every preset saved on it.';
      syncPins();
    }

    async function readPins() {
      const letter = card.letter;
      let names = [];
      if (letter) {
        try {
          names = await host.call('eq_pins', { letter });
        } catch {
          names = [];
        }
      }
      if (letter !== card.letter) return;
      pins = names;
      renderPins();
    }

    // A pin goes straight to the card, with its preset when the card doesn't have that yet, so
    // there is nothing left to lose by closing.
    async function writePins(names, file = null) {
      const letter = card.letter;
      if (!letter || card.listed !== letter) return;
      pinning = true;
      syncPins();
      try {
        if (file) await host.call('eq_save', { letter, ...file });
        await host.call('eq_pins_save', { letter, names });
        pins = names;
        if (file) await readNames();
      } catch (error) {
        notice('The pins could not be saved', error.message);
      }
      pinning = false;
      renderPins();
    }

    function togglePin(name, text) {
      const pinned = pinName(name);
      if (pins.includes(pinned)) return writePins(pins.filter((pin) => pin !== pinned));
      if (pins.length >= PINS_MAX) {
        toast(`Up to ${PINS_MAX} presets can be pinned.`);
        return null;
      }
      const file = eq.fileName(name);
      return writePins([...pins, pinned], text !== null && !existing(file) ? { file, text } : null);
    }

    function pinIem(iem) {
      const parsed = eq.parse(iem.text, iem.name);
      if (parsed.ok) togglePin(iem.name, eq.serialize(parsed.preset));
      else notice('This preset could not be pinned', `${parsed.error}. The Q2 would refuse it too.`);
    }

    function pinThis() {
      const on = existing(eq.fileName(preset.name)) && !pins.includes(pinName(preset.name));
      togglePin(preset.name, eq.serialize(preset));
      if (on) toast(`“${pinName(preset.name)}” is already on the card, so that copy is pinned. Save to Q2 to replace it.`);
    }

    function pinListClick(event) {
      const button = event.target.closest('[data-move]');
      if (!button) return;
      const index = Number(button.closest('.row').dataset.index);
      const move = Number(button.dataset.move);
      const names = [...pins];
      if (!move) names.splice(index, 1);
      else if (names[index + move] !== undefined) [names[index], names[index + move]] = [names[index + move], names[index]];
      else return;
      writePins(names);
    }

    /* ---------- The presets ---------- */

    // The short list before a search. A search wants every word, in any order, in the name, source or type.
    function renderIems() {
      const list = $('eqIemList');
      const words = $('eqIemFilter').value.toLowerCase().split(/\s+/).filter(Boolean);
      const found = iems.filter((iem) => (words.length ? words.every((word) => iem.find.includes(word)) : iem.top));
      list.textContent = '';
      for (const iem of found.slice(0, IEM_ROWS)) {
        const row = document.createElement('div');
        row.className = 'row';
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'row-main';
        open.dataset.iem = iem.index;
        open.title = `${iem.name}, ${iem.source}, ${iem.type}`;
        const label = document.createElement('span');
        label.className = 'label';
        label.textContent = iem.name;
        const source = document.createElement('span');
        source.className = 'src';
        source.textContent = iem.source;
        open.append(label, source);
        row.append(open, pinButton(iem.name));
        list.append(row);
      }
      $('eqIemNote').textContent = !words.length ? `Popular IEMs. Search for any of ${count(iems.length)}.`
        : !found.length ? 'No match.'
          : found.length > IEM_ROWS ? `The first ${IEM_ROWS} of ${count(found.length)}. Add a word to narrow it.`
            : `${count(found.length)} found.`;
      syncIem();
      syncPins();
    }

    async function loadIems() {
      if (iems.length) return;
      try {
        const { credit, presets } = await (await fetch('presets.json')).json();
        iems = presets.map((iem, index) => ({ ...iem, index, find: `${iem.name} ${iem.source} ${iem.type}`.toLowerCase() }));
        $('eqCredit').textContent = credit;
        $('eqIemFilter').placeholder = `Search ${count(iems.length)} presets`;
        renderIems();
      } catch {
        $('eqCredit').textContent = 'The built-in presets could not be loaded.';
      }
    }

    async function openFile() {
      try {
        const file = await host.call('import_eq');
        if (file) load(file.text, eq.nameOfFile(file.name), 'the file');
      } catch (error) {
        notice('This preset could not be opened', error.message);
      }
    }

    async function exportFile() {
      try {
        const saved = await host.call('export_eq', { text: eq.serialize(preset), suggested: eq.fileName(preset.name) });
        if (saved === null) return false;
        markSaved();
        toast(`Exported as ${saved}. To import it on the Q2, copy it to the card's EQ folder.`);
        return true;
      } catch (error) {
        notice('This preset could not be exported', error.message);
        return false;
      }
    }

    function driveName(drive) {
      const label = drive.label ? ` ${drive.label}` : '';
      const kind = drive.isQ2 ? ' (Q2 card)' : drive.removable ? ' (removable)' : '';
      return `${drive.letter}:${label}${kind}`;
    }

    const driveOrder = (a, b) => (b.isQ2 - a.isQ2) || (b.removable - a.removable) || a.letter.localeCompare(b.letter);

    function fillDrives(select) {
      select.textContent = '';
      select.add(new Option(card.drives.length ? 'Choose a drive' : 'No drives found', ''));
      for (const drive of card.drives) select.add(new Option(driveName(drive), drive.letter));
      select.value = card.letter ?? '';
    }

    const drivesKey = (drives) => drives.map((drive) => `${drive.letter}${drive.isQ2}`).sort().join();

    async function readDrives() {
      try {
        card.drives = (await host.call('drives')).sort(driveOrder);
      } catch {
        card.drives = [];
      }
      card.seen = drivesKey(card.drives);
      const q2 = card.drives.filter((drive) => drive.isQ2);
      const kept = card.drives.some((drive) => drive.letter === card.letter) ? card.letter : null;
      card.letter = kept ?? (q2.length === 1 ? q2[0].letter : null);
    }

    async function readNames() {
      const letter = card.letter;
      let listing = { names: [], taken: [] };
      let problem = null;
      card.listed = null;
      if (letter) {
        try {
          listing = await host.call('eq_list', { letter });
        } catch (error) {
          problem = error.message;
        }
      }
      if (letter !== card.letter) return;
      card.names = listing.names;
      card.taken = listing.taken;
      card.listed = problem ? null : letter;
      renderCard(problem);
      await readPins();
      return problem;
    }

    function renderCard(problem) {
      const list = $('eqCardList');
      list.textContent = '';
      for (const file of card.names) {
        const row = document.createElement('div');
        row.className = 'row';
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'row-main';
        open.dataset.file = file;
        const label = document.createElement('span');
        label.className = 'label';
        label.textContent = file.replace(/\.txt$/, '');
        label.title = file;
        open.append(label);
        row.append(open, pinButton(file.replace(/\.txt$/, '')));
        list.append(row);
      }
      $('eqCardNote').textContent = problem
        ?? (!card.letter ? 'No Q2 card found yet. Connect it with its USB tile on storage, or choose a drive. It shows here by itself, and a Q2 can take a few minutes to appear.'
          : card.names.length ? '' : `Nothing in the EQ folder on ${card.letter}: yet. Press a star, or Save to Q2, to add a preset. Presets saved on the Q2 itself stay on the Q2, so they don't show here.`);
    }

    async function refreshCard() {
      await readDrives();
      fillDrives($('eqDrive'));
      await readNames();
    }

    // The button's answer when nothing on the page would change.
    async function refreshByHand() {
      $('eqCardRefresh').disabled = true;
      await refreshCard();
      $('eqCardRefresh').disabled = false;
      if (!card.letter) toast('No Q2 card found yet. Check its USB tile is on storage, and that the cable carries data.');
      else toast(`Checked ${card.letter}: and found ${card.names.length} ${card.names.length === 1 ? 'preset' : 'presets'}.`);
    }

    async function lookForCard() {
      if (card.looking || card.busy || pinning || $('dlgEqSave').open) return;
      card.looking = true;
      try {
        if (drivesKey(await host.call('drives')) !== card.seen) await refreshCard();
      } catch {
        // The next look tries again.
      }
      card.looking = false;
    }

    async function openFromCard(file) {
      try {
        const text = await host.call('eq_read', { letter: card.letter, file });
        load(text, eq.nameOfFile(file), 'the card');
      } catch (error) {
        notice('This preset could not be opened', error.message);
      }
    }

    const SAVE_PARTS = ['eqSavePick', 'eqSaveDone'];
    const showSavePart = (part) => { for (const id of SAVE_PARTS) $(id).hidden = id !== part; };

    function showSaveError(message) {
      $('eqSaveError').textContent = message ?? '';
      $('eqSaveError').hidden = !message;
    }

    const existing = (file) => card.taken.some((name) => name.toLowerCase() === file.toLowerCase());

    function syncSave() {
      const file = eq.fileName(preset.name);
      const on = card.letter;
      $('eqSavePath').textContent = on ? `${on}:\\EQ\\${file}` : `EQ\\${file}`;
      const taken = on && existing(file);
      $('eqSaveInfo').textContent = !on ? 'Connect the card, then press Refresh, or choose a drive.'
        : taken ? 'A preset with this name is on the card. Saving replaces it. If the Q2 already has this preset, it keeps its copy until you import it again from EQ settings.'
          : '';
      $('eqSaveGo').textContent = taken ? 'Replace' : 'Save';
      $('eqSaveGo').disabled = !on || card.listed !== on || card.busy;
    }

    // Nothing here saves until this drive's folder is read, and not at all if it could not be.
    async function listForSave() {
      card.listed = null;
      syncSave();
      showSaveError(await readNames());
      syncSave();
    }

    async function refreshSave() {
      showSaveError(null);
      await readDrives();
      fillDrives($('eqSaveDrive'));
      await listForSave();
    }

    async function openSave() {
      showSavePart('eqSavePick');
      showSaveError(null);
      fillWarnings($('eqSaveWarn'), eq.warnings(preset, rate));
      syncSave();
      $('dlgEqSave').showModal();
      await refreshSave();
    }

    function setBusy(on) {
      card.busy = on;
      for (const id of ['eqSaveCancel', 'eqSaveDrive', 'eqSaveRefresh']) $(id).disabled = on;
      syncSave();
    }

    async function saveToCard() {
      const letter = card.letter;
      if (!letter || card.listed !== letter) return;
      const file = eq.fileName(preset.name);
      showSaveError(null);
      setBusy(true);
      try {
        await host.call('eq_save', { letter, file, text: eq.serialize(preset) });
      } catch (error) {
        setBusy(false);
        showSaveError(error.message);
        return;
      }
      setBusy(false);
      markSaved();
      $('eqDoneText').textContent = `“${eq.nameOfFile(file)}” is saved to the EQ folder on drive ${letter}.`;
      showSavePart('eqSaveDone');
      $('eqDoneClose').focus();
      await readNames();
    }

    /* ---------- Events ---------- */

    function bind() {
      $('eqView').addEventListener('input', (event) => {
        if (event.target.type === 'number') typing.add(event.target);
      });
      // A number box's change applies it, or a box left alone goes back to the preset's value.
      $('eqView').addEventListener('focusout', (event) => {
        if (typing.delete(event.target)) render();
      });
      $('eqView').addEventListener('change', (event) => typing.delete(event.target), true);

      const body = $('eqBandRows');
      body.addEventListener('focusin', (event) => {
        const row = event.target.closest('tr');
        if (row) pick(Number(row.dataset.index));
      });
      body.addEventListener('click', (event) => {
        const row = event.target.closest('tr');
        if (!row) return;
        const index = Number(row.dataset.index);
        if (event.target.closest('[data-remove]')) removeBand(index);
        else pick(index);
      });
      body.addEventListener('change', (event) => {
        const input = event.target;
        const index = Number(input.closest('tr').dataset.index);
        const name = input.dataset.field;
        if (name === 'on') {
          editBand(index, (band) => { band.on = input.checked; });
        } else if (name === 'type' || name === 'channel') {
          editBand(index, (band) => { band[name] = input.value; });
        } else if (input.value.trim() !== '') { // an emptied box keeps the old value
          editBand(index, (band) => { band[name] = Number(input.value); });
        }
        if (input.type === 'number') input.value = preset.bands[index][name];
      });

      const canvas = $('eqGraph');
      canvas.addEventListener('pointerdown', graphDown);
      canvas.addEventListener('pointermove', graphMove);
      canvas.addEventListener('pointerup', graphUp);
      canvas.addEventListener('pointercancel', graphUp);
      canvas.addEventListener('lostpointercapture', graphUp);
      canvas.addEventListener('dblclick', graphDouble);
      canvas.addEventListener('wheel', graphWheel, { passive: false });
      new ResizeObserver(drawGraph).observe(canvas);

      $('eqAdd').addEventListener('click', () => addBand());
      $('eqSort').addEventListener('click', sortBands);
      $('eqUndo').addEventListener('click', () => step(history.past, history.future));
      $('eqRedo').addEventListener('click', () => step(history.future, history.past));
      $('eqReset').addEventListener('click', () => {
        picked = 0;
        commit({ ...eq.newPreset(), name: preset.name });
      });

      $('eqName').addEventListener('input', (event) => {
        typing.add(event.target);
        commit({ ...preset, name: event.target.value }, 'name');
      });
      $('eqName').addEventListener('blur', (event) => {
        typing.delete(event.target);
        history.key = null;
        event.target.value = preset.name;
      });
      $('eqPreampMode').addEventListener('change', (event) => {
        const auto = event.target.value === 'auto';
        commit({ ...preset, auto, preamp: auto ? preset.preamp : Number(eq.autoPreamp(preset).toFixed(1)) });
      });
      $('eqPreamp').addEventListener('change', (event) => {
        if (event.target.value.trim() !== '') commit({ ...preset, preamp: Number(event.target.value) });
        event.target.value = preset.preamp;
      });
      $('eqBalance').addEventListener('change', (event) => {
        if (event.target.value.trim() !== '') commit({ ...preset, balance: Number(event.target.value) });
        event.target.value = preset.balance;
      });
      $('eqRate').addEventListener('change', (event) => {
        rate = Number(event.target.value);
        render();
      });

      $('eqIemFilter').addEventListener('input', renderIems);
      $('eqIemList').addEventListener('click', (event) => {
        const pin = event.target.closest('[data-pin]');
        if (pin) {
          pinIem(iems[Number(pin.parentElement.firstChild.dataset.iem)]);
          return;
        }
        const row = event.target.closest('[data-iem]');
        if (!row) return;
        const iem = iems[Number(row.dataset.iem)];
        if (load(iem.text, iem.name, 'the presets')) {
          chosen = iem;
          syncIem();
        }
      });
      $('eqPinList').addEventListener('click', pinListClick);
      $('eqPinThis').addEventListener('click', pinThis);

      $('eqDrive').addEventListener('change', async (event) => {
        card.letter = event.target.value || null;
        await readNames();
      });
      $('eqCardRefresh').addEventListener('click', refreshByHand);
      $('eqCardList').addEventListener('click', (event) => {
        const pin = event.target.closest('[data-pin]');
        const row = event.target.closest('[data-file]');
        if (pin) togglePin(pin.dataset.pin, null);
        else if (row) openFromCard(row.dataset.file);
      });

      $('eqSaveDrive').addEventListener('change', async (event) => {
        showSaveError(null);
        card.letter = event.target.value || null;
        fillDrives($('eqDrive'));
        await listForSave();
      });
      $('eqSaveRefresh').addEventListener('click', refreshSave);
      $('eqSaveCancel').addEventListener('click', () => $('dlgEqSave').close());
      $('eqSaveGo').addEventListener('click', saveToCard);
      $('eqDoneClose').addEventListener('click', () => $('dlgEqSave').close());
      $('dlgEqSave').addEventListener('cancel', (event) => {
        if (card.busy) event.preventDefault();
      });
      $('dlgEqSave').addEventListener('close', () => {
        fillDrives($('eqDrive'));
        if (card.busy) $('dlgEqSave').showModal();
      });
    }

    bind();
    render();

    return {
      show: () => {
        render();
        loadIems();
        refreshCard();
        clearInterval(card.watch);
        card.watch = setInterval(lookForCard, CARD_WATCH_MS);
      },
      hide: () => clearInterval(card.watch),
      openFile,
      exportFile,
      openSave,
      undo: () => step(history.past, history.future),
      redo: () => step(history.future, history.past),
      unsaved,
      busy: () => card.busy,
      get preset() { return preset; },
    };
  };
})();
