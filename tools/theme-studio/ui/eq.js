// EQ logic with no page in it: a preset's text, its limits and its curve. Loaded by index.html as
// window.Q2Eq and by eq.test.mjs as a module.
//
// The firmware's patch/peq.c is the model. parse takes and refuses what peq_parse does, in its words,
// and the curve is peq_compile's filters, so a file that passes here is one the Q2 imports.
// test/theme.py runs both on the same files and compares them.
//
// A preset is { name, auto, preamp, balance, bands }. auto: no Preamp line, so the Q2 works the preamp
// out for each song's rate. balance: dB, above 0 turns the left channel down. Each band is
// { on, channel: 'all' | 'L' | 'R', type: 'PK' | 'LSC' | 'HSC', freq, gain, q }.
(function (root, make) {
  if (typeof module === 'object' && module.exports) module.exports = make();
  else root.Q2Eq = make();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_BANDS = 30;
  const FILE_MAX = 16384;
  const LINE_MAX = 512;
  const TOKENS_MAX = 16;
  const FREQ_MIN = 20;
  const FREQ_MAX = 20000;
  const GAIN_MAX = 24;
  const Q_MIN = 0.1;
  const Q_MAX = 10;
  const PREAMP_MIN = -60;
  const PREAMP_MAX = 24;
  const BALANCE_MAX = 12;
  const NAME_BYTES = 60; // the Q2's editor keeps 63 bytes of a preset's name
  const AUTO_RATE = 48000; // the rate the Q2's editor shows Auto's figure for
  const GRID = 1024; // peak()'s points
  const NO_PEAK = 1.0000230261; // under 0.0001 dB is none
  const CLIP_SLACK = 0.1; // dB: AutoEQ's preamps are rounded to this, so a peak this far over is no news
  const TAU = 6.283185307179586;

  const TYPES = ['PK', 'LSC', 'HSC'];
  const CHANNELS = ['all', 'L', 'R'];
  const DEFAULT_FREQS = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const DEFAULT_Q = 1.41;
  const FALLBACK_NAME = 'My EQ';
  const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

  const utf8 = new TextEncoder();
  const byteLength = (text) => utf8.encode(text).length;
  const clamp = (value, low, high) => Math.min(Math.max(value, low), high);
  const round = (value, digits) => +value.toFixed(digits);
  const finite = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

  const newBand = (freq = 1000, gain = 0) => ({ on: true, channel: 'all', type: 'PK', freq, gain, q: DEFAULT_Q });

  // The ten bands the Q2's Reset gives.
  const newPreset = (name = '') => ({
    name, auto: true, preamp: 0, balance: 0, bands: DEFAULT_FREQS.map((freq) => newBand(freq)),
  });

  // A name the card can hold, as the Q2's Rename allows: FAT's characters out, and no leading dot.
  function cleanName(text) {
    let name = String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029/\\:*?"<>|]/g, '').trim();
    name = name.replace(/^[.\s]+/, '');
    while (byteLength(name) > NAME_BYTES) name = Array.from(name).slice(0, -1).join('');
    return name.replace(/[.\s]+$/, '');
  }

  function fileName(name) {
    const clean = cleanName(name) || FALLBACK_NAME;
    return `${RESERVED.test(clean) ? `EQ ${clean}` : clean}.txt`;
  }

  const nameOfFile = (file) => cleanName(String(file ?? '').replace(/^.*[\\/]/, '').replace(/\.txt$/i, ''));

  function normalizeBand(band) {
    return {
      on: !!band.on,
      channel: CHANNELS.includes(band.channel) ? band.channel : 'all',
      type: TYPES.includes(band.type) ? band.type : 'PK',
      freq: clamp(round(finite(band.freq, 1000), 2), FREQ_MIN, FREQ_MAX),
      gain: clamp(round(finite(band.gain, 0), 2), -GAIN_MAX, GAIN_MAX),
      q: clamp(round(finite(band.q, DEFAULT_Q), 3), Q_MIN, Q_MAX),
    };
  }

  // The preset with every value legal and at the file's precision.
  function normalize(preset) {
    return {
      name: cleanName(preset.name),
      auto: !!preset.auto,
      preamp: clamp(round(finite(preset.preamp, 0), 2), PREAMP_MIN, PREAMP_MAX),
      balance: clamp(round(finite(preset.balance, 0), 2), -BALANCE_MAX, BALANCE_MAX),
      bands: preset.bands.slice(0, MAX_BANDS).map(normalizeBand),
    };
  }

  /* ---------- Reading ---------- */

  // peq_number: decimal only, a comma as the mark, the token used whole. Null if it is not one. The
  // C library's %lf also takes an exponent with no digits, as in 355E, and reads it as 355.
  function number(token) {
    const text = token.replace(/,/g, '.');
    const parts = /^([+-]?(?:\d+\.?\d*|\.\d+))(?:[eE][+-]?\d*)?$/.exec(text);
    if (!parts) return null;
    const value = Number(/\d$/.test(text) ? text : parts[1]);
    return Number.isFinite(value) ? value : null;
  }

  const between = (value, low, high) => value >= low && value <= high;

  // A line's words, with a colon always a word of its own, and # ending the line. Null past the limit.
  function words(line) {
    const out = [];
    const stops = ' \t\r:#';
    let at = 0;
    while (at < line.length && line[at] !== '#') {
      if (' \t\r'.includes(line[at])) { at += 1; continue; }
      if (out.length === TOKENS_MAX) return null;
      if (line[at] === ':') { out.push(':'); at += 1; continue; }
      const start = at;
      while (at < line.length && !stops.includes(line[at])) at += 1;
      out.push(line.slice(start, at));
      if (line[at] === ':') {
        if (out.length === TOKENS_MAX) return null;
        out.push(':');
        at += 1;
      } else if (line[at] === '#') {
        break;
      }
    }
    return out;
  }

  const validBand = (band) => between(band.freq, FREQ_MIN, FREQ_MAX) && between(band.gain, -GAIN_MAX, GAIN_MAX)
    && between(band.q, Q_MIN, Q_MAX);

  // { ok: true, preset } with the values as read, or { ok: false, line, reason, error }.
  function parse(text, name = '') {
    const fail = (line, reason) => ({ ok: false, line, reason, error: `Line ${line}: ${reason}` });
    if (byteLength(text) > FILE_MAX) return fail(1, 'file exceeds 16384 bytes');
    const lines = text.replace(/^\ufeff/, '').split('\n');
    if (lines[lines.length - 1] === '') lines.pop(); // the end of the last line, not a line after it

    const preset = { name, auto: true, preamp: 0, balance: 0, bands: [] };
    const side = { L: 0, R: 0 };
    let scope = 'all';
    let preampLine = 0;

    for (let index = 0; index < lines.length; index += 1) {
      const raw = lines[index];
      const line = index + 1;
      // The Q2 reads a line a byte at a time, so whichever comes first is what it reports.
      const nul = raw.indexOf('\0');
      const tooLong = byteLength(raw) > LINE_MAX;
      if (nul >= 0 && (!tooLong || byteLength(raw.slice(0, nul)) < LINE_MAX)) return fail(line, 'embedded NUL');
      if (tooLong) return fail(line, 'line exceeds 512 bytes');
      const t = words(raw);
      if (t === null) return fail(line, 'unsupported filter form');
      const n = t.length;
      if (!n) continue;

      if (t[0] === 'Preamp') {
        if (n !== 4 || t[1] !== ':' || t[3] !== 'dB') return fail(line, 'expected Preamp: <gain> dB');
        const gain = number(t[2]);
        if (gain === null || !between(gain, PREAMP_MIN, PREAMP_MAX)) {
          return fail(line, 'preamp outside -60..24 dB or invalid number');
        }
        if (scope === 'all') preset.preamp += gain;
        else side[scope] += gain;
        preampLine = line;
        continue;
      }

      if (t[0] === 'Channel') {
        if (n < 3 || t[1] !== ':') return fail(line, 'expected Channel: L, R or all');
        let [left, right] = [false, false];
        for (const word of t.slice(2)) {
          if (word === 'L') left = true;
          else if (word === 'R') right = true;
          else if (word === 'all') left = right = true;
          else return fail(line, 'only channels L, R and all are supported');
        }
        scope = left && right ? 'all' : left ? 'L' : 'R';
        continue;
      }

      if (t[0] !== 'Filter') return fail(line, 'unsupported command');
      let k = 1;
      if (n > 1 && t[1] !== ':') {
        if (!/^\d*$/.test(t[1])) return fail(line, 'invalid filter label');
        k += 1;
      }
      if (n <= k || t[k] !== ':') return fail(line, 'expected Filter [number]:');
      k += 1;
      if (n - k === 2 && t[k + 1] === 'None') continue; // REW's and APO's empty slot
      if (n - k !== 8 && n - k !== 10) return fail(line, 'unsupported filter form');

      const band = { on: true, channel: scope, type: 'PK', freq: 0, gain: 0, q: 0.7071067811865476 };
      if (t[k] === 'OFF') band.on = false;
      else if (t[k] !== 'ON') return fail(line, 'expected ON or OFF');
      k += 1;
      const kind = t[k];
      if (kind === 'PK' || kind === 'PEQ') band.type = 'PK';
      else if (kind === 'LS' || kind === 'LSC') band.type = 'LSC';
      else if (kind === 'HS' || kind === 'HSC') band.type = 'HSC';
      else return fail(line, 'unsupported filter type');
      const corner = kind.length === 2; // APO: LS and HS give a corner, LSC and HSC the centre
      k += 1;
      if (t[k] !== 'Fc' || t[k + 2] !== 'Hz' || t[k + 3] !== 'Gain' || t[k + 5] !== 'dB') {
        return fail(line, 'expected Fc <Hz> Hz Gain <dB> dB');
      }
      const [freq, gain] = [number(t[k + 1]), number(t[k + 4])];
      if (freq === null || gain === null) return fail(line, 'invalid frequency or gain number');
      band.freq = freq;
      band.gain = gain;
      k += 6;
      const hasQ = k < n;
      if (hasQ) {
        const q = t[k] === 'Q' ? number(t[k + 1]) : null;
        if (q === null) return fail(line, 'expected Q <number>');
        band.q = q;
      } else if (band.type === 'PK') {
        return fail(line, 'peaking filter requires Q');
      }

      if (band.type !== 'PK' && validBand(band)) {
        // As Equalizer APO: no Q means slope 0.9 at Fc, and LS or HS with a Q shift the corner to the centre.
        const a = 10 ** (band.gain / 40);
        const ab = a + 1 / a;
        if (!hasQ) {
          band.q = 1 / Math.sqrt(ab * (1 / 0.9 - 1) + 2);
        } else if (corner) {
          const shift = 10 ** (Math.abs(band.gain) / 80 * ((1 / (band.q * band.q) - 2) / ab + 1));
          band.freq = band.type === 'LSC' ? band.freq * shift : band.freq / shift;
          band.freq = clamp(band.freq, FREQ_MIN, FREQ_MAX); // past the range is clamped, not refused
        }
      }
      if (!validBand(band)) {
        if (!band.on) continue; // APO ignores OFF filters, and exporters fill blank slots with Fc 0 Q 0
        return fail(line, 'range: 20..20000 Hz, -24..24 dB, Q 0.1..10');
      }
      if (preset.bands.length === MAX_BANDS) return fail(line, 'more than 30 bands');
      preset.bands.push(band);
    }

    // Each side's preamp becomes the louder one's common preamp plus a balance turning the other down.
    preset.preamp += Math.max(side.L, side.R);
    preset.balance = side.R - side.L;
    if (!between(preset.preamp, PREAMP_MIN, PREAMP_MAX)) return fail(preampLine, 'summed preamp outside -60..24 dB');
    if (!between(preset.balance, -BALANCE_MAX, BALANCE_MAX)) return fail(preampLine, 'L/R preamp differ by more than 12 dB');
    preset.auto = !preampLine;
    return { ok: true, preset };
  }

  /* ---------- Writing ---------- */

  // A plain decimal: the Q2 reads exponents too, but no other tool needs to meet one.
  function decimal(value, digits) {
    const rounded = round(value, digits) || 0; // no -0
    const text = rounded.toFixed(digits);
    return digits ? text.replace(/\.?0+$/, '') : text;
  }

  // LSC and HSC always, so the Q2 takes the frequency as it stands here. A preset with balance needs
  // Preamp lines, so Auto is written as its 48 kHz figure.
  function serialize(preset) {
    const clean = normalize(preset);
    const lines = [];
    if (!clean.auto || clean.balance) {
      lines.push(`Preamp: ${decimal(clean.auto ? autoPreamp(clean) : clean.preamp, 2)} dB`);
    }
    if (clean.balance) {
      lines.push(`Channel: L`, `Preamp: ${decimal(Math.min(-clean.balance, 0), 2)} dB`);
      lines.push(`Channel: R`, `Preamp: ${decimal(Math.min(clean.balance, 0), 2)} dB`, 'Channel: all');
    }
    let scope = 'all';
    clean.bands.forEach((band, index) => {
      if (band.channel !== scope) lines.push(`Channel: ${(scope = band.channel)}`);
      lines.push(`Filter ${index + 1}: ${band.on ? 'ON' : 'OFF'} ${band.type} Fc ${decimal(band.freq, 2)} Hz `
        + `Gain ${decimal(band.gain, 2)} dB Q ${decimal(band.q, 3)}`);
    });
    return `${lines.join('\n')}\n`;
  }

  /* ---------- The curve ---------- */

  // peq_compile's filter for a band at this rate, or null where the Q2 skips it.
  function design(band, rate) {
    if (!band.on || !band.gain || band.freq >= rate * 0.5) return null;
    const a = 10 ** (band.gain / 40);
    const w = TAU * band.freq / rate;
    const c = Math.cos(w);
    const alpha = Math.sin(w) / (2 * band.q);
    const r = 2 * Math.sqrt(a) * alpha;
    let b0; let b1; let b2; let a0; let a1; let a2;
    if (band.type === 'PK') {
      b0 = 1 + alpha * a; b1 = -2 * c; b2 = 1 - alpha * a;
      a0 = 1 + alpha / a; a1 = -2 * c; a2 = 1 - alpha / a;
    } else if (band.type === 'LSC') {
      b0 = a * ((a + 1) - (a - 1) * c + r); b1 = 2 * a * ((a - 1) - (a + 1) * c);
      b2 = a * ((a + 1) - (a - 1) * c - r); a0 = (a + 1) + (a - 1) * c + r;
      a1 = -2 * ((a - 1) + (a + 1) * c); a2 = (a + 1) + (a - 1) * c - r;
    } else {
      b0 = a * ((a + 1) + (a - 1) * c + r); b1 = -2 * a * ((a - 1) + (a + 1) * c);
      b2 = a * ((a + 1) + (a - 1) * c - r); a0 = (a + 1) - (a - 1) * c + r;
      a1 = 2 * ((a - 1) - (a + 1) * c); a2 = (a + 1) - (a - 1) * c - r;
    }
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0, channel: band.channel };
  }

  const designAll = (preset, rate) => preset.bands.map((band) => design(band, rate)).filter(Boolean);

  // |H|^2 of a band's filter at f.
  function power(filter, f, rate) {
    const w = TAU * f / rate;
    const [c1, s1] = [Math.cos(w), Math.sin(w)];
    const [c2, s2] = [2 * c1 * c1 - 1, 2 * s1 * c1];
    const nr = filter.b0 + filter.b1 * c1 + filter.b2 * c2;
    const ni = filter.b1 * s1 + filter.b2 * s2;
    const dr = 1 + filter.a1 * c1 + filter.a2 * c2;
    const di = filter.a1 * s1 + filter.a2 * s2;
    return (nr * nr + ni * ni) / (dr * dr + di * di);
  }

  // peq_response: |H|^2 of each channel's chain, without preamp or balance.
  function chain(filters, f, rate) {
    let [left, right] = [1, 1];
    for (const filter of filters) {
      const m = power(filter, f, rate);
      if (filter.channel !== 'R') left *= m;
      if (filter.channel !== 'L') right *= m;
    }
    return { left, right };
  }

  const db = (ratio) => 10 * Math.log10(ratio);

  // Each channel's gain in dB at f.
  function response(preset, f, rate) {
    const { left, right } = chain(designAll(preset, rate), f, rate);
    return { left: db(left), right: db(right) };
  }

  // One band's own gain in dB at f, for showing it alone.
  function bandResponse(band, f, rate) {
    const filter = design(band, rate);
    return filter ? db(power(filter, f, rate)) : 0;
  }

  // peak(): the loudest |H|^2 of either channel on the Q2's own points, and where. At least 1, as
  // Auto never boosts, and at most 60 dB. The Q2 counts down to DC, where a low shelf's boost sits. low
  // leaves out what is under it, for saying what music can reach.
  function peak(preset, rate, low = 0) {
    const filters = designAll(preset, rate);
    const nyquist = rate * 0.5;
    const points = [0, nyquist];
    for (let k = 0; k < GRID; k += 1) points.push(nyquist ** (k / (GRID - 1)));
    for (const band of preset.bands) points.push(band.freq);
    if (low) points.push(low);
    let [best, at] = [1, low];
    points.forEach((f, index) => {
      if ((f >= nyquist && index !== 1) || f < low) return;
      const { left, right } = chain(filters, f, rate);
      const loudest = Math.max(left, right);
      if (loudest > best) [best, at] = [loudest, f];
    });
    return { power: best < NO_PEAK ? 1 : Math.min(best, 1e6), at };
  }

  // peq_auto: the cut in dB that keeps that peak under full scale.
  function autoPreamp(preset, rate = AUTO_RATE) {
    const { power: loudest } = peak(preset, rate);
    return loudest > 1 ? -db(loudest) : 0;
  }

  // Worth a second look, never a reason to refuse saving.
  function warnings(preset, rate) {
    const clean = normalize(preset);
    const out = [];
    if (!clean.bands.some((band) => band.on && band.gain)) out.push('No band changes the sound yet.');
    const { power: loudest } = peak(clean, rate, FREQ_MIN);
    const over = db(loudest) + clean.preamp;
    if (!clean.auto && over > CLIP_SLACK) {
      out.push(`Peaks reach ${decimal(over, 1)} dB over full scale, so loud music may clip. Lower the preamp, or use Auto.`);
    }
    if (clean.auto && clean.balance) {
      out.push(`Balance needs a fixed preamp in the file, so this saves Auto as ${decimal(autoPreamp(clean), 1)} dB.`);
    }
    return out;
  }

  return {
    MAX_BANDS, FILE_MAX, FREQ_MIN, FREQ_MAX, GAIN_MAX, Q_MIN, Q_MAX, PREAMP_MIN, PREAMP_MAX, BALANCE_MAX,
    TYPES, CHANNELS, newBand, newPreset, cleanName, fileName, nameOfFile, normalize, parse, serialize,
    response, bandResponse, peak, autoPreamp, warnings,
  };
});
