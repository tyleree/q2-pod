// Theme logic with no page in it: parsing, writing, limits and contrast. Loaded by index.html as
// window.Q2Core and by core.test.mjs as a module.
//
// A theme is { name, author, accent, bg, battery, home, art, rules }: rules[page][id] holds only what differs from the
// catalogue, as { hide: true, move: [x, y], size: [w, h], font: px, text: 'words', tint: '#rrggbb' }. Positions are parent
// coordinates. bg is the page's colour or null, and battery one of BATTERY_MODES, or null to leave
// the Q2's own setting. home holds Home's sizes that differ, and art is null, or { items, seconds } for
// the pictures that take turns in Home's right panel: items are { id, kind }, id the page's own name
// for a picture and kind 'jpg' or 'gif'.
(function (root, make) {
  if (typeof module === 'object' && module.exports) module.exports = make();
  else root.Q2Core = make();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const HEADER = 'q2theme 1';
  const FOOTER = 'end';
  const MAX_BYTES = 16 * 1024;
  const NAME_MAX = 40;
  const SIZE_MIN = 40;
  // patch/theme.c THEME_MIN_ICON, THEME_MIN_LABEL, THEME_MIN_FONT, THEME_MAX_FONT, THEME_MAX_TEXT
  const ICON_MIN = 16;
  const LABEL_MIN = 12;
  const FONT_MIN = 8;
  const FONT_MAX = 120;
  const TEXT_BYTES = 40;
  const TEXT_MAX = 24;
  const ACCENT_MIN = 3;
  const TINT_MIN = 4.5;
  const TEXT_MIN = 4.5;
  const SELECTION_MIN = 1.5;
  // A theme's background, as navigation.c's accent() and flip take it (patch/offsets.inc).
  const PAPER_LIGHT_MIN = 125;
  const SPREAD = 16;
  const INK_DARK = '#161616';
  const INK_LIGHT = '#ffffff';
  const TRACK = '#1c1c1c';
  const MINIMAL_FILL = '#eeeeec';
  // The Shortcut row is not on every Q2: with Shortcut set to Rockbox and no Rockbox on the card,
  // the firmware leaves it out (coverflow_home_layout). So it can never be the row that stays.
  const OPTIONAL_ROW = 'btn_rockbox';

  // The firmware's accents (patch/offsets.inc ACCENTS): the colour and its lighter progress bar tone.
  const PRESETS = [
    { name: 'Graphite', hex: '#424242', light: '#6e6e6e' },
    { name: 'Crimson', hex: '#e8123f', light: '#eb2f56' },
    { name: 'Tidal', hex: '#13838d', light: '#30929b' },
    { name: 'Champagne', hex: '#8c732c', light: '#9a8446' },
    { name: 'Cobalt', hex: '#2a6ad8', light: '#447cdd' },
    { name: 'Tangerine', hex: '#c45400', light: '#cb681e' },
    { name: 'Plum', hex: '#903868', light: '#9d4f7a' },
    { name: 'Green', hex: '#647f34', light: '#778e4c' },
  ];

  // The firmware's Battery setting (patch/theme.c), in its order.
  const BATTERY_MODES = ['icon', 'percent', 'both', 'inside'];

  // The shared library: a public repository of theme files and their index.
  const LIBRARY = 'tyleree/q2-themes';
  const LIBRARY_BRANCH = 'main';
  const LIBRARY_BASE = `https://raw.githubusercontent.com/${LIBRARY}/${LIBRARY_BRANCH}/`;
  const LIBRARY_MAX = 5000;
  const SHARE_URL_MAX = 1900; // Windows may cut a longer link on its way to the browser
  const SLUG_MAX = 60;

  // Home, as patch/theme.c takes it. The right panel's pictures are a letter each, so a theme names no file.
  const HOME = {
    rows: { min: 28, max: 64, normal: 39 },
    top: { min: 0, max: 120, normal: 8 },
    cards: { min: 60, max: 220, normal: 190 },
  };
  const ART = { max: 24, turnMin: 3, turnMax: 600, turn: 12 };
  const ART_LETTERS = { jpg: 'j', gif: 'g' };
  // patch/coverflow.c: the page's height, the list's bottom inset, where Carousel's labels start.
  const HOME_H = 290;
  const HOME_INSET = 8;
  const CARD_LABEL = 232;
  const CARD_GAP = 8;
  const CARD_TOP = 23;
  // The Q2 holds a GIF's every frame decoded for its turn.
  const GIF_BYTES = 6 * 1024 * 1024;
  const GIF_PALETTE = 256;
  const GIF_SAMPLES = 40000;

  const emptyTheme = () => ({ name: '', author: '', accent: null, bg: null, battery: null, home: {}, art: null, rules: {} });

  const byteLength = (text) => new TextEncoder().encode(text).length;

  function cleanName(text) {
    const plain = String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '').trim();
    return Array.from(plain).slice(0, NAME_MAX).join('').trim();
  }

  // '#abc', 'abc', '#AABBCC' or 'aabbcc' to '#aabbcc'; anything else to null.
  function normHex(text) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(text ?? '').trim());
    if (!m) return null;
    const hex = m[1].toLowerCase();
    return '#' + (hex.length === 3 ? hex.replace(/./g, '$&$&') : hex);
  }

  const isFullHex = (text) => /^#[0-9a-f]{6}$/i.test(text);
  const allows = (el, action) => el.actions.includes(action);

  function findElement(cat, page, id) {
    if (!Object.hasOwn(cat.pages, page)) return null;
    return cat.pages[page].elements.find((el) => el.id === id) ?? null;
  }

  function clampAxis(value, low, high) {
    if (high < low) return value; // the box is smaller than the item: leave it where it is
    return Math.min(Math.max(value, low), high);
  }

  // The legal position for an item of size w by h. Boxes are in parent coordinates.
  function clampMove(el, x, y, w = el.w, h = el.h) {
    const box = el.box;
    if (!box) return [el.x, el.y];
    return [
      clampAxis(Math.round(x), box[0], box[2] - w),
      clampAxis(Math.round(y), box[1], box[3] - h),
    ];
  }

  // Sized items stay square and between SIZE_MIN and the largest square their box holds.
  function sizeLimit(el) {
    return el.box ? Math.min(el.box[2] - el.box[0], el.box[3] - el.box[1]) : Math.max(el.w, el.h);
  }

  function clampSize(el, size) {
    return Math.min(Math.max(Math.round(size), SIZE_MIN), Math.max(sizeLimit(el), SIZE_MIN));
  }

  // The album art stays square. Everything else takes any width and height its box holds.
  const isSquare = (el) => el.kind === 'image' && !allows(el, 'scale');
  const leastSize = (el) => (allows(el, 'font') ? LABEL_MIN : allows(el, 'scale') ? ICON_MIN : SIZE_MIN);

  function clampBox(el, w, h) {
    if (isSquare(el)) {
      const side = clampSize(el, Math.min(w, h));
      return [side, side];
    }
    const least = leastSize(el);
    const limit = (value, room) => Math.min(Math.max(Math.round(value), least), Math.max(room, least));
    return [limit(w, el.box[2] - el.box[0]), limit(h, el.box[3] - el.box[1])];
  }

  const clampFont = (px) => Math.min(Math.max(Math.round(px), FONT_MIN), FONT_MAX);

  // A row's words, on one line: what the firmware keeps of a text line.
  function cleanText(text) {
    let plain = cleanName(String(text ?? '').replace(/\s+/g, ' '));
    plain = Array.from(plain).slice(0, TEXT_MAX).join('').trim();
    while (byteLength(plain) > TEXT_BYTES) plain = Array.from(plain).slice(0, -1).join('').trim();
    return plain;
  }

  function cleanHome(home) {
    const out = {};
    for (const [key, { min, max, normal }] of Object.entries(HOME)) {
      const value = home?.[key];
      if (value === undefined || value === null || !Number.isFinite(Number(value))) continue;
      const kept = Math.min(Math.max(Math.round(Number(value)), min), max);
      if (kept !== normal) out[key] = kept;
    }
    return out;
  }

  function cleanArt(art) {
    const seen = new Set();
    const items = [];
    for (const item of Array.isArray(art?.items) ? art.items : []) {
      const id = String(item?.id);
      if (!Object.hasOwn(ART_LETTERS, item?.kind) || seen.has(id) || items.length === ART.max) continue;
      seen.add(id);
      items.push({ id, kind: item.kind });
    }
    if (!items.length) return null;
    const seconds = Number(art.seconds);
    return { items, seconds: Math.min(Math.max(Math.round(Number.isFinite(seconds) ? seconds : ART.turn), ART.turnMin), ART.turnMax) };
  }

  // As coverflow_home_layout: the whole rows that show, the rest scrolling in.
  const rowsShown = (row, top, count) => Math.min(Math.max(Math.floor((HOME_H - top - HOME_INSET) / row), 1), count);

  // A Carousel card's image: a theme's size, held between the panel and the label.
  function cardBox(cards, top) {
    const stock = HOME.cards.normal;
    const size = Math.min(cards ?? stock, CARD_LABEL - top - CARD_GAP);
    const sized = cards !== undefined || top > 0;
    return { size, x: Math.trunc((stock - size) / 2), y: sized ? top + Math.trunc((CARD_LABEL - top - size) / 2) : CARD_TOP };
  }

  // What goes to the library: a theme's pictures stay on its owner's card.
  const shareable = (theme) => ({ ...theme, art: null });

  // The theme with every value legal, and with anything equal to the default removed.
  function normalize(theme, cat) {
    const battery = BATTERY_MODES.includes(theme.battery) ? theme.battery : null;
    const out = {
      name: cleanName(theme.name), author: cleanName(theme.author), accent: normHex(theme.accent), bg: normHex(theme.bg), battery,
      home: cleanHome(theme.home), art: cleanArt(theme.art), rules: {},
    };
    for (const [page, { elements }] of Object.entries(cat.pages)) {
      for (const el of elements) {
        const rule = theme.rules?.[page]?.[el.id];
        if (!rule) continue;
        const kept = {};
        if (rule.hide && allows(el, 'hide')) kept.hide = true;
        let [w, h] = [el.w, el.h];
        if (rule.size && allows(el, 'size')) {
          [w, h] = clampBox(el, rule.size[0], rule.size[1]);
          if (w !== el.w || h !== el.h) kept.size = [w, h];
        }
        if (allows(el, 'move')) {
          const [x, y] = rule.move ?? [el.x, el.y];
          const [nx, ny] = clampMove(el, x, y, w, h);
          if (nx !== el.x || ny !== el.y) kept.move = [nx, ny];
        }
        const font = rule.font && allows(el, 'font') ? clampFont(rule.font) : null;
        if (font && font !== el.font) kept.font = font;
        const words = allows(el, 'text') ? cleanText(rule.text) : '';
        if (words) kept.text = words;
        const tint = normHex(rule.tint);
        if (tint && allows(el, 'tint')) kept.tint = tint;
        if (Object.keys(kept).length) (out.rules[page] ??= {})[el.id] = kept;
      }
    }
    return keepOneRow(out, cat);
  }

  const mainRowsOf = (cat, page) => cat.pages[page].elements.filter((el) => el.kind === 'row' && el.id !== OPTIONAL_ROW);

  // The firmware keeps at least one main Home row, and the app never offers to hide the last.
  function keepOneRow(theme, cat) {
    for (const page of Object.keys(cat.pages)) {
      const rows = mainRowsOf(cat, page);
      if (rows.length && rows.every((el) => theme.rules[page]?.[el.id]?.hide)) {
        const first = theme.rules[page][rows[0].id];
        delete first.hide;
        if (!Object.keys(first).length) delete theme.rules[page][rows[0].id];
      }
    }
    return theme;
  }

  function canHide(theme, cat, page, id) {
    const el = findElement(cat, page, id);
    if (!el || !allows(el, 'hide')) return false;
    if (el.kind !== 'row' || el.id === OPTIONAL_ROW) return true;
    return mainRowsOf(cat, page).some((row) => row.id !== id && !theme.rules[page]?.[row.id]?.hide);
  }

  // What differs between two clean themes, for saying what an undo did and showing where.
  function changes(a, b, cat) {
    const items = [];
    for (const [page, { elements }] of Object.entries(cat.pages)) {
      for (const el of elements) {
        const [before, after] = [a.rules[page]?.[el.id], b.rules[page]?.[el.id]];
        if (JSON.stringify(before) !== JSON.stringify(after)) items.push({ page, id: el.id });
      }
    }
    const homeOf = (theme) => JSON.stringify([theme.home, theme.art]);
    return { name: a.name !== b.name, accent: a.accent !== b.accent, bg: a.bg !== b.bg, battery: a.battery !== b.battery, home: homeOf(a) !== homeOf(b), items };
  }

  // Every difference from the defaults, in catalogue order.
  function diff(theme, cat) {
    const clean = normalize(theme, cat);
    const out = [];
    for (const [page, { elements }] of Object.entries(cat.pages)) {
      for (const el of elements) {
        const rule = clean.rules[page]?.[el.id];
        if (!rule) continue;
        for (const action of ['hide', 'move', 'size', 'font', 'text', 'tint']) {
          if (rule[action] !== undefined) out.push({ page, id: el.id, action, value: rule[action] });
        }
      }
    }
    return out;
  }

  function serialize(theme, cat) {
    const clean = normalize(theme, cat);
    const lines = [HEADER];
    if (clean.name) lines.push(`name ${clean.name}`);
    if (clean.author) lines.push(`author ${clean.author}`);
    if (clean.accent) lines.push(`accent ${clean.accent}`);
    if (clean.bg) lines.push(`color bg ${clean.bg}`);
    if (clean.battery) lines.push(`battery ${clean.battery}`);
    for (const key of Object.keys(HOME)) if (clean.home[key] !== undefined) lines.push(`home ${key} ${clean.home[key]}`);
    if (clean.art) lines.push(`homeart ${clean.art.seconds} ${clean.art.items.map(({ kind }) => ART_LETTERS[kind]).join('')}`);
    let page = null;
    for (const change of diff(clean, cat)) {
      if (change.page !== page) lines.push(`page ${(page = change.page)}`);
      const value = Array.isArray(change.value) ? change.value.join(' ') : change.value;
      lines.push(change.action === 'hide' ? `hide ${change.id}` : `${change.action} ${change.id} ${value}`);
    }
    lines.push(FOOTER);
    return lines.join('\n') + '\n';
  }

  const NOT_A_THEME = 'This does not look like a Q2 theme file.';
  const CUT_SHORT = 'This theme file looks cut short, so it was not opened. Try saving or copying it again.';
  const TOO_BIG = 'This file is bigger than the 16 KB a theme can be, so it was not opened.';

  // { ok: true, theme, ignored } with ignored the count of lines skipped, or { ok: false, error }.
  function parse(text, cat) {
    if (byteLength(text) > MAX_BYTES) return { ok: false, error: TOO_BIG };
    const lines = text.replace(/^﻿/, '').split('\n').map((line) => line.replace(/\r$/, ''));
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    if (lines[0] !== HEADER) return { ok: false, error: NOT_A_THEME };
    if (lines.length < 2 || lines[lines.length - 1] !== FOOTER) return { ok: false, error: CUT_SHORT };

    const theme = emptyTheme();
    let ignored = 0;
    let page = null; // the catalogue page rule lines belong to; null ignores them
    const ruleFor = (id) => (((theme.rules[page] ??= {})[id] ??= {}));
    const elementFor = (id, action) => {
      const el = page && findElement(cat, page, id);
      return el && allows(el, action) ? el : null;
    };
    const whole = (word) => (/^-?\d+$/.test(word) ? Number(word) : null);

    for (const line of lines.slice(1, -1)) {
      if (line === '') continue;
      const [word, ...rest] = line.split(' ');
      let known = false;
      if (word === 'name') {
        theme.name = line.slice(5);
        known = true;
      } else if (word === 'author') {
        theme.author = line.slice(7);
        known = true;
      } else if (word === 'accent' && rest.length === 1 && isFullHex(rest[0])) {
        theme.accent = rest[0].toLowerCase();
        known = true;
      } else if (word === 'color' && rest.length === 2 && rest[0] === 'bg' && isFullHex(rest[1])) {
        theme.bg = rest[1].toLowerCase();
        known = true;
      } else if (word === 'battery' && rest.length === 1 && BATTERY_MODES.includes(rest[0])) {
        theme.battery = rest[0];
        known = true;
      } else if (word === 'home' && rest.length === 2 && Object.hasOwn(HOME, rest[0]) && whole(rest[1]) !== null) {
        theme.home[rest[0]] = whole(rest[1]);
        known = true;
      } else if (word === 'homeart' && rest.length === 2 && whole(rest[0]) !== null && rest[1].length <= ART.max && /^[jg]+$/.test(rest[1])) {
        const items = [...rest[1]].map((letter, index) => ({ id: `card${index + 1}`, kind: letter === 'g' ? 'gif' : 'jpg' }));
        theme.art = { items, seconds: whole(rest[0]) };
        known = true;
      } else if (word === 'page') {
        // A page this version cannot use takes the rule lines under it along with it.
        page = rest.length === 1 && Object.hasOwn(cat.pages, rest[0]) ? rest[0] : null;
        known = page !== null;
      } else if (word === 'hide' && rest.length === 1 && elementFor(rest[0], 'hide')) {
        ruleFor(rest[0]).hide = true;
        known = true;
      } else if (word === 'move' && rest.length === 3 && elementFor(rest[0], 'move')) {
        const [x, y] = [whole(rest[1]), whole(rest[2])];
        if (x !== null && y !== null) {
          ruleFor(rest[0]).move = [x, y];
          known = true;
        }
      } else if (word === 'size' && rest.length === 3 && elementFor(rest[0], 'size')) {
        const [w, h] = [whole(rest[1]), whole(rest[2])];
        if (w !== null && h !== null) {
          ruleFor(rest[0]).size = [w, h];
          known = true;
        }
      } else if (word === 'font' && rest.length === 2 && elementFor(rest[0], 'font')) {
        const px = whole(rest[1]);
        if (px !== null) {
          ruleFor(rest[0]).font = px;
          known = true;
        }
      } else if (word === 'text' && rest.length >= 2 && elementFor(rest[0], 'text')) {
        ruleFor(rest[0]).text = rest.slice(1).join(' ');
        known = true;
      } else if (word === 'tint' && rest.length === 2 && elementFor(rest[0], 'tint') && isFullHex(rest[1])) {
        ruleFor(rest[0]).tint = rest[1].toLowerCase();
        known = true;
      }
      if (!known) ignored += 1;
    }
    return { ok: true, theme: normalize(theme, cat), ignored };
  }

  function luminance(hex) {
    const channel = (at) => {
      const value = parseInt(hex.slice(at, at + 2), 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
  }

  function contrast(a, b) {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (high + 0.05) / (low + 0.05);
  }

  const channels = (hex) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  const toHex = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;

  // The page a background makes: its luma picks the text, as the firmware does.
  function palette(bg) {
    const paper = channels(bg);
    const light = Math.trunc((paper[0] * 299 + paper[1] * 587 + paper[2] * 114) / 1000) >= PAPER_LIGHT_MIN;
    return { paper, ink: channels(light ? INK_DARK : INK_LIGHT), light };
  }

  // The firmware's flip: a neutral colour, black at the paper and white at the ink, per channel. Other
  // hues stay.
  function flip(hex, page) {
    const rgb = channels(hex);
    if (Math.max(...rgb) - Math.min(...rgb) > SPREAD) return hex;
    return toHex(rgb.map((v, i) => page.paper[i] + Math.trunc(v * (page.ink[i] - page.paper[i]) / 255)));
  }

  // The bar is judged by the colour it is drawn in, the same one the preview shows.
  function accentWarnings(accent, bg = null) {
    if (!accent) return [];
    const out = [];
    const track = bg ? flip(TRACK, palette(bg)) : TRACK;
    const fill = bg ? flip(progressFill(accent), palette(bg)) : progressFill(accent);
    if (contrast(accent, '#ffffff') < ACCENT_MIN) out.push('White text on this colour may be hard to read in menus.');
    if (contrast(fill, track) < ACCENT_MIN) out.push('The progress bar may be hard to see in this colour.');
    return out;
  }

  // Warned about, never refused: no background is unreadable, as its text is picked to suit it, but
  // those near the middle give that text less than TEXT_MIN.
  function bgWarnings(bg, accent = null) {
    if (!bg) return [];
    const page = palette(bg);
    const out = [];
    if (contrast(toHex(page.ink), bg) < TEXT_MIN) out.push('Text may be hard to read on this background. A lighter or darker one will help.');
    if (accent && contrast(flip(accent, page), bg) < SELECTION_MIN) out.push('This accent is close to the background, so selected rows may not stand out.');
    return out;
  }

  const tintIsLow = (tint, bg = null) => contrast(tint, bg ?? '#000000') < TINT_MIN;

  // The progress bar's fill. A preset uses the firmware's tone; another colour is lightened the
  // same 12% toward white; no accent is the Minimal theme's own near-white.
  function progressFill(accent) {
    if (!accent) return MINIMAL_FILL;
    const preset = PRESETS.find((p) => p.hex === accent);
    if (preset) return preset.light;
    const mix = (at) => {
      const value = parseInt(accent.slice(at, at + 2), 16);
      return Math.round(value + (255 - value) * 0.12).toString(16).padStart(2, '0');
    };
    return `#${mix(1)}${mix(3)}${mix(5)}`;
  }

  // Everything worth a second look, never a reason to refuse saving.
  function warnings(theme, cat) {
    const clean = normalize(theme, cat);
    const out = [...bgWarnings(clean.bg, clean.accent), ...accentWarnings(clean.accent, clean.bg)]
      .map((text) => ({ kind: 'accent', page: null, id: null, text }));
    const under = clean.bg ? 'this background' : 'black';
    for (const [page, { elements }] of Object.entries(cat.pages)) {
      for (const el of elements) {
        const rule = clean.rules[page]?.[el.id];
        if (rule?.hide && el.warn) out.push({ kind: 'hidden', page, id: el.id, text: el.warn });
        if (rule?.tint && !rule.hide && tintIsLow(rule.tint, clean.bg)) {
          out.push({ kind: 'tint', page, id: el.id, text: `${el.label}: this text colour may be hard to read on ${under}.` });
        }
      }
    }
    return out;
  }

  // A GIF's frames for the Q2: dropped evenly until they fit bytes decoded, their time going to the
  // ones kept. frames: [{ delay: ms, ... }].
  function thinFrames(frames, w, h, bytes = GIF_BYTES) {
    const keep = Math.max(1, Math.min(frames.length, Math.floor(bytes / (w * h * 4))));
    if (keep === frames.length) return frames;
    return Array.from({ length: keep }, (_, index) => {
      const [from, to] = [Math.floor(index * frames.length / keep), Math.floor((index + 1) * frames.length / keep)];
      return { ...frames[from], delay: frames.slice(from, to).reduce((sum, frame) => sum + frame.delay, 0) };
    });
  }

  // Up to colours averages of the packed RGB samples, each box split across its widest channel.
  function medianCut(samples, colours) {
    const measure = (box) => {
      let found = { shift: 0, spread: -1 };
      for (const shift of [16, 8, 0]) {
        let [low, high] = [255, 0];
        for (const pixel of box) {
          const value = pixel >> shift & 255;
          if (value < low) low = value;
          if (value > high) high = value;
        }
        if (high - low > found.spread) found = { shift, spread: high - low };
      }
      return { box, ...found };
    };
    const boxes = [measure(samples)];
    while (boxes.length < colours) {
      let at = -1;
      boxes.forEach((item, index) => {
        if (item.spread > 0 && (at < 0 || item.spread * item.box.length > boxes[at].spread * boxes[at].box.length)) at = index;
      });
      if (at < 0) break;
      const { box, shift } = boxes[at];
      box.sort((a, b) => (a >> shift & 255) - (b >> shift & 255));
      const middle = box.length >> 1;
      boxes.splice(at, 1, measure(box.slice(0, middle)), measure(box.slice(middle)));
    }
    return boxes.map(({ box }) => [16, 8, 0].map((shift) =>
      (box.length ? Math.round(box.reduce((sum, pixel) => sum + (pixel >> shift & 255), 0) / box.length) : 0)));
  }

  // GIF's LZW, in its order of events, which a decoder has to follow to the code.
  function gifLzw(indices, out) {
    const minimum = 8;
    const [clear, stop] = [1 << minimum, (1 << minimum) + 1];
    const block = [];
    let [size, next, held, bits] = [minimum + 1, stop + 1, 0, 0];
    let table = new Map();
    const emit = (code) => {
      held += code * 2 ** bits;
      bits += size;
      while (bits >= 8) {
        block.push(held % 256);
        held = Math.floor(held / 256);
        bits -= 8;
        if (block.length === 255) out.push(255, ...block.splice(0));
      }
    };
    out.push(minimum);
    emit(clear);
    let run = indices[0];
    for (let index = 1; index < indices.length; index += 1) {
      const pixel = indices[index];
      const key = run * 256 + pixel;
      const code = table.get(key);
      if (code !== undefined) {
        run = code;
        continue;
      }
      emit(run);
      if (next === 4096) {
        emit(clear);
        table = new Map();
        [size, next] = [minimum + 1, stop + 1];
      } else {
        if (next >= 1 << size) size += 1;
        table.set(key, next);
        next += 1;
      }
      run = pixel;
    }
    emit(run);
    emit(stop);
    if (bits) block.push(held % 256);
    if (block.length) out.push(block.length, ...block);
    out.push(0);
  }

  // A looping GIF of RGBA frames: [{ rgba, delay: ms }], all width by height. One palette, cut from
  // all the frames; an alpha under half is transparent.
  function encodeGif(width, height, frames) {
    const clearAlpha = 128;
    const clear = frames.some(({ rgba }) => { for (let at = 3; at < rgba.length; at += 4) if (rgba[at] < clearAlpha) return true; return false; });
    const samples = [];
    const stride = 4 * Math.max(1, Math.floor(frames.length * width * height / GIF_SAMPLES));
    for (const { rgba } of frames) {
      for (let at = 0; at < rgba.length; at += stride) if (rgba[at + 3] >= clearAlpha) samples.push(rgba[at] << 16 | rgba[at + 1] << 8 | rgba[at + 2]);
    }
    const palette = medianCut(samples, GIF_PALETTE - (clear ? 1 : 0));
    const blank = GIF_PALETTE - 1;
    const nearest = new Int16Array(1 << 15).fill(-1);
    const lookup = (r, g, b) => {
      const key = r >> 3 << 10 | g >> 3 << 5 | b >> 3;
      if (nearest[key] < 0) {
        let [best, reach] = [0, Infinity];
        palette.forEach(([pr, pg, pb], index) => {
          const away = (pr - r) ** 2 + (pg - g) ** 2 + (pb - b) ** 2;
          if (away < reach) [best, reach] = [index, away];
        });
        nearest[key] = best;
      }
      return nearest[key];
    };

    const word = (value) => [value & 255, value >> 8 & 255];
    const out = [...new TextEncoder().encode('GIF89a'), ...word(width), ...word(height), 0xf7, 0, 0];
    for (let index = 0; index < GIF_PALETTE; index += 1) out.push(...(palette[index] ?? [0, 0, 0]));
    out.push(0x21, 0xff, 11, ...new TextEncoder().encode('NETSCAPE2.0'), 3, 1, 0, 0, 0);
    for (const { rgba, delay } of frames) {
      const hundredths = Math.max(2, Math.min(Math.round(delay / 10), 65535));
      // A transparent frame clears to the page, or the last one shows through its holes.
      out.push(0x21, 0xf9, 4, clear ? 0x09 : 0x04, ...word(hundredths), clear ? blank : 0, 0);
      out.push(0x2c, 0, 0, 0, 0, ...word(width), ...word(height), 0);
      const indices = new Uint8Array(width * height);
      for (let at = 0; at < indices.length; at += 1) {
        const from = at * 4;
        indices[at] = rgba[from + 3] < clearAlpha ? blank : lookup(rgba[from], rgba[from + 1], rgba[from + 2]);
      }
      gifLzw(indices, out);
    }
    out.push(0x3b);
    return Uint8Array.from(out);
  }

  // The library's index, checked: it comes from the internet, so only what fits survives, and a file
  // name can't leave the themes folder.
  function libraryEntries(index) {
    const out = [];
    const seen = new Set();
    for (const entry of Array.isArray(index?.themes) ? index.themes : []) {
      const file = String(entry?.file ?? '');
      const name = cleanName(entry?.name);
      if (!/^[a-z0-9][a-z0-9-]*\.txt$/.test(file) || !name || seen.has(file)) continue;
      seen.add(file);
      out.push({ file, name, author: cleanName(entry.author), accent: normHex(entry.accent), bg: normHex(entry.bg) });
      if (out.length === LIBRARY_MAX) break;
    }
    return out;
  }

  // Every word, in any order, in the name or the author.
  function librarySearch(entries, text) {
    const words = String(text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    return entries.filter((entry) => {
      const hay = `${entry.name} ${entry.author}`.toLowerCase();
      return words.every((word) => hay.includes(word));
    });
  }

  const slug = (text) => String(text ?? '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  function shareFile(name, author) {
    const words = [slug(name), slug(author)].filter(Boolean).join('-by-') || 'theme';
    return `${words.slice(0, SLUG_MAX).replace(/-+$/, '')}.txt`;
  }

  // GitHub's new-file page in the library. With text it is filled in, and someone without write access
  // is offered a fork and a pull request in one step.
  const sharePage = (file) => `https://github.com/${LIBRARY}/new/${LIBRARY_BRANCH}/themes?filename=${encodeURIComponent(file)}`;

  // The link that shares this text, or null when it would be too long to pass to the browser.
  function shareUrl(text, file) {
    const url = `${sharePage(file)}&value=${encodeURIComponent(text)}`;
    return url.length <= SHARE_URL_MAX ? url : null;
  }

  return {
    LIBRARY_BASE, libraryEntries, librarySearch, shareFile, sharePage, shareUrl, shareable,
    HOME, ART, GIF_BYTES, rowsShown, cardBox, thinFrames, encodeGif,
    HEADER, FOOTER, MAX_BYTES, NAME_MAX, SIZE_MIN, FONT_MIN, FONT_MAX, TEXT_MAX, PRESETS, OPTIONAL_ROW, BATTERY_MODES,
    isSquare, clampBox, clampFont, cleanText,
    emptyTheme, byteLength, cleanName, normHex, allows, findElement, clampMove, clampSize, sizeLimit,
    normalize, canHide, changes, diff, serialize, parse, luminance, contrast, palette, flip, accentWarnings, bgWarnings, tintIsLow,
    progressFill, warnings,
  };
});
