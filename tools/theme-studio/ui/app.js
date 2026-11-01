// The page: draws the preview, handles editing, and talks to the host (the exe, or a mock in a browser).
(function () {
  'use strict';

  const core = window.Q2Core;
  const $ = (id) => document.getElementById(id);

  const PLAYING = 'playing_page';
  const HOME = 'home_page';
  const LOCK = 'saverscreen_page';
  const BAR = 'system_bar';

  const SCREEN_TOP = 30; // the status bar, over every page
  const ART_SIZE = 290; // Split's panel, high, and a still's side
  const PANEL_W = 188; // Split's panel, wide
  const ART_QUALITY = 0.9;
  const GIF_FRAMES = 48; // read from an upload, before thinning for the Q2
  const GIF_FILE_MAX = 1800 * 1024; // main.rs MAX_IMAGE_BYTES, with room to spare
  const ALBUM_ROWS = 200; // rows a search shows at once

  const HISTORY_MAX = 200;
  const NUDGE_REST_MS = 800;
  const DRAG_START = 1.5; // screen pixels of travel before a press becomes a drag
  // The Q2's font draws smaller than Arial at the same nominal size: measured 0.86 on its screenshots.
  const FONT_SCALE = 0.86;
  const fontPx = (nominal) => +(nominal * FONT_SCALE).toFixed(2);
  // The status bar's battery (patch/offsets.inc BATT_*). pctW is "80%" at BATT_PX, as the Q2 measures it.
  const BAR_RIGHT = 321;
  const BATT = { bodyW: 16, bodyH: 11, nubW: 2, nubH: 5, gap: 2, insideW: 28, insideH: 15, insidePx: 13, px: 16, pctW: 33 };

  const SAMPLE = {
    title: 'Slow Tide', artist: 'The Lanterns', album: 'Night Harbour', position: '31 of 551',
    elapsed: '0:31', remaining: '-2:17', progress: 0.185, clock: '23:50', date: '2026-10-31', battery: '80%',
    rows: {
      btn_playing: 'Now Playing', btn_localmusic: 'Library', btn_coverflow: 'Coverflow', btn_folder: 'Folder', btn_eq: 'EQ',
      btn_rockbox: 'Favorites', btn_stream: 'Streaming', btn_settings: 'Settings',
    },
  };

  // Text colours as the Minimal theme draws them, shown until a tint replaces them.
  const TEXT_COLOUR = {
    [PLAYING]: {
      scrlabel_title: '#ffffff', scrlabel_artist: '#cccccc', label_ipod_album: '#bbbbbb', view_eqchip: '#bbbbbb',
      label_ipod_pos: '#8c8c8c', label_playtime: '#8c8c8c', label_ipod_remain: '#8c8c8c',
    },
  };
  const textColour = (page, id) => TEXT_COLOUR[page]?.[id] ?? '#ffffff';

  const PAGE_NOTES = {
    [PLAYING]: 'These changes are for the standard Now Playing layout. They are skipped while Centred Now Playing is on.',
    [HOME]: 'Rows can take new words and any text size. Heights, card sizes and images are on the right. Rows that don\'t fit scroll in.',
    [BAR]: 'EQ and Bluetooth show on the Q2 only while they are in use. Bluetooth, Wi-Fi and the battery keep the size the Q2 gives them.',
  };

  // The catalogue is generated from the firmware, so plainer wording is laid over it here.
  const WORDING = {
    [PLAYING]: {
      img_cover: { warn: 'Tapping the art opens it full screen. If you hide it, that tap goes too.' },
      img_playmode: { warn: 'If you hide this, change it from the Play/Pause hold menu or Playback settings.' },
      slider_play: { warn: 'You can still skip through a song, but you will not see the bar.' },
    },
    [HOME]: {
      btn_playing: { warn: 'The Return button on Home still opens Now Playing.' },
      btn_localmusic: { warn: 'If you hide this, nothing else opens the Library menu. Coverflow and Folder still reach your music.' },
      btn_rockbox: { label: 'Shortcut row (Favorites)' },
    },
  };
  const SHORTCUT_NOTE = 'This row shows your Shortcut setting: Favorites, or Rockbox if the card has it, unless you chose another.';

  // A control that turns itself off would drop keyboard focus, so it passes it on to one of these.
  const FOCUS_NEXT = {
    btnUndo: ['btnRedo'], btnRedo: ['btnUndo'],
    btnResetScreen: ['btnResetAll'], btnResetAll: ['btnResetScreen'],
    inspReset: ['inspShow'], inspTintClear: ['inspTintHex'], inspTextClear: ['inspTextBox'], accentClear: ['accentHex'], bgClear: ['bgHex'],
  };

  let cat = null;
  let theme = core.emptyTheme();
  let savedState = JSON.stringify(theme); // the theme as last saved, exported or loaded
  const view = { mode: 'theme', page: PLAYING, under: PLAYING, sel: null, ghosts: false, scale: 2, layout: 'split', art: null };
  // The right panel's pictures, by item id: a theme only says how many and what kind. { url, frames:
  // [{ bitmap, delay }], name }, a still being one frame.
  const pictures = {};
  let picturesChanged = false; // an image was replaced, which the theme's text can't show
  let nextPin = 1;
  const albums = { letter: null, list: [] };
  const history = { past: [], future: [], key: null };
  let drag = null;
  let dragCount = 0;
  let nudgeTimer = 0;
  let toastTimer = 0;
  let eqPage = null;
  let libraryPage = null;

  /* ---------- Host ---------- */

  function nativeHost() {
    const pending = new Map();
    let nextId = 1;
    window.__hostReply = (id, ok, value) => {
      const call = pending.get(id);
      if (!call) return;
      pending.delete(id);
      if (ok) call.resolve(value);
      else call.reject(new Error(String(value)));
    };
    return {
      call(cmd, args = {}) {
        return new Promise((resolve, reject) => {
          const id = nextId++;
          pending.set(id, { resolve, reject });
          window.ipc.postMessage(JSON.stringify({ id, cmd, args }));
        });
      },
    };
  }

  // One fake card, for trying the page in a normal browser. window.__mock is there to poke at.
  function mockHost() {
    const params = new URLSearchParams(location.search);
    const mock = {
      drives: [{ letter: 'E', label: 'Q2 CARD', removable: true, isQ2: true }],
      files: {},
      eq: {}, // each drive's EQ folder: { E: { 'Name.txt': text } }
      pins: {}, // each drive's pinned presets: { E: ['Name'] }
      images: {}, // each drive's Home images: { E: { 'top.png': base64 } }
      albums: {}, // each drive's albums: { E: [{ path, name }] }
      covers: {}, // a cover's data URL, by path
      importEq: { name: 'Sample.txt', text: 'Preamp: -3 dB\nFilter 1: ON PK Fc 1000 Hz Gain 3 dB Q 1.41\n' },
      importText: 'q2theme 1\nname Sample Theme\naccent #13838d\npage playing_page\nhide img_fav\nend\n',
      exported: null,
      calls: [],
      delays: {}, // milliseconds by command, to try a slow card
      closed: false,
      text: () => core.serialize(theme, cat),
      view,
    };
    if (params.has('card')) mock.files.E = params.get('card').replace(/\\n/g, '\n');
    const letter = (args) => {
      if (!/^[A-Z]$/.test(args.letter ?? '')) throw new Error('That is not a drive letter.');
      return args.letter;
    };
    const commands = {
      drives: () => mock.drives.map((drive) => ({ ...drive })),
      read_theme: (args) => mock.files[letter(args)] ?? null,
      save_theme: (args) => { mock.files[letter(args)] = args.text; return true; },
      remove_theme: (args) => { const had = letter(args) in mock.files; delete mock.files[args.letter]; return had; },
      import_theme: () => mock.importText,
      export_theme: (args) => { mock.exported = args; return mock.cancelDialog ? null : args.suggested; },
      eq_list: (args) => {
        const taken = Object.keys(mock.eq[letter(args)] ?? {}).sort();
        return { names: taken.filter((name) => name.endsWith('.txt')), taken };
      },
      eq_read: (args) => mock.eq[letter(args)][args.file],
      eq_save: (args) => { (mock.eq[letter(args)] ??= {})[args.file] = args.text; return true; },
      image_save: (args) => { (mock.images[letter(args)] ??= {})[args.name] = args.data; return true; },
      image_read: (args) => mock.images[letter(args)]?.[args.name] ?? null,
      albums: (args) => mock.albums[letter(args)] ?? [],
      album_art: (args) => mock.covers[args.path],
      eq_pins: (args) => mock.pins[letter(args)] ?? [],
      eq_pins_save: (args) => { mock.pins[letter(args)] = args.names; return true; },
      import_eq: () => mock.importEq,
      export_eq: (args) => { mock.exported = args; return mock.cancelDialog ? null : args.suggested; },
      open_url: (args) => { mock.opened = args.url; return true; },
      close_now: () => { mock.closed = true; return true; },
      close_held: () => true,
    };
    window.__mock = mock;
    return {
      call(cmd, args = {}) {
        mock.calls.push({ cmd, args });
        return new Promise((resolve, reject) => {
          setTimeout(() => {
            try {
              if (mock.failNext) throw new Error(mock.failNext);
              resolve(commands[cmd](args));
            } catch (error) {
              reject(error);
            } finally {
              mock.failNext = null;
            }
          }, mock.delays[cmd] ?? 5);
        });
      },
    };
  }

  const host = window.ipc && window.ipc.postMessage ? nativeHost() : mockHost();

  /* ---------- Theme changes ---------- */

  function commit(next, key = null) {
    const clean = core.normalize(next, cat);
    const before = JSON.stringify(theme);
    if (before === JSON.stringify(clean)) {
      if (key !== history.key) history.key = null; // no change starts no run, or its undo step is lost
      return false;
    }
    if (!key || key !== history.key) {
      history.past.push(before);
      if (history.past.length > HISTORY_MAX) history.past.shift();
    }
    history.key = key;
    history.future.length = 0;
    theme = clean;
    refresh();
    return true;
  }

  function editRule(page, id, edit, key) {
    const next = structuredClone(theme);
    edit(((next.rules[page] ??= {})[id] ??= {}));
    return commit(next, key);
  }

  function step(from, to, word) {
    if (!from.length || drag?.active) return;
    const before = theme;
    to.push(JSON.stringify(theme));
    theme = JSON.parse(from.pop());
    history.key = null;
    showChange(before, word);
    refresh();
  }
  const undo = () => step(history.past, history.future, 'Undid');
  const redo = () => step(history.future, history.past, 'Redid');

  // Undo can reach a change on another screen: go there, pick the item out, and say what it was.
  function showChange(before, word) {
    const { name, accent, bg, battery, home, items } = core.changes(before, theme, cat);
    const total = items.length + (name ? 1 : 0) + (accent ? 1 : 0) + (bg ? 1 : 0) + (battery ? 1 : 0) + (home ? 1 : 0);
    if (!total) return;
    if (items.length && !items.some((item) => item.page === view.page)) setPage(items[0].page);
    if (home && !items.length) setPage(HOME);
    if (items.length === 1) view.sel = items[0];
    let what = `${total} changes`;
    if (total === 1) {
      what = name ? 'theme name' : accent ? 'accent colour' : bg ? 'background colour' : battery ? 'battery style'
        : home ? 'Home sizes and right panel'
          : `${elementOf(items[0].page, items[0].id).label} on ${cat.pages[items[0].page].label}`;
    }
    toast(`${word}: ${what}`);
  }

  const endRun = () => { history.key = null; };

  /* ---------- Geometry ---------- */

  const elementOf = (page, id) => core.findElement(cat, page, id);
  const elementsOf = (page) => cat.pages[page].elements;

  function geo(page, el) {
    const rule = theme.rules[page]?.[el.id] ?? {};
    const [x, y] = rule.move ?? [el.x, el.y];
    const [w, h] = rule.size ?? [el.w, el.h];
    return { x, y, w, h, hidden: !!rule.hide, tint: rule.tint ?? null, font: rule.font ?? el.font ?? null, text: rule.text ?? null };
  }

  // The group an item sits in: its parent is where the catalogue places that group.
  function groupOf(page, el) {
    return elementsOf(page).find((g) => g.kind === 'group' && g !== el && g.x === el.parent[0] && g.y === el.parent[1]) ?? null;
  }

  function originOf(page, el) {
    const group = groupOf(page, el);
    if (!group) return { x: el.parent[0], y: el.parent[1] };
    const { x, y } = screenAt(page, group);
    return { x, y };
  }

  function screenAt(page, el) {
    const origin = originOf(page, el);
    const g = geo(page, el);
    return { ...g, x: origin.x + g.x, y: origin.y + g.y };
  }

  /* ---------- Preview drawing ---------- */

  const px = (r) => `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`;

  // Words go into the preview's markup, and a shared theme's are a stranger's.
  const escapeHtml = (text) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  // A colour as the firmware draws it on this theme's background.
  function ink(hex) {
    const full = core.normHex(hex);
    return theme.bg ? core.flip(full, core.palette(theme.bg)) : full;
  }

  const ICONS = {
    play: '<path d="M3 9 13 15 3 21Z" fill="#fff"/>',
    heart: '<path d="M12 19.2C5.2 13.9.8 10.2.8 5.9.8 3 3.1.8 5.9.8 8.3.8 10.6 2.2 12 4.6 13.4 2.2 15.7.8 18.1.8c2.8 0 5.1 2.2 5.1 5.1 0 4.3-4.4 8-11.2 13.3Z" fill="none" stroke="#eee" stroke-width="1.5" stroke-linejoin="round"/>',
    shuffle: '<g fill="none" stroke="#eee" stroke-width="1.5"><path d="M0 4h3.6c4.8 0 6 12 10.8 12h5"/><path d="M0 16h3.6c4.8 0 6-12 10.8-12h5"/></g><path d="M18.6.4 23 4l-4.4 3.6ZM18.6 12.4 23 16l-4.4 3.6Z" fill="#eee"/>',
    wifi: '<g fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round"><path d="M1.2 4.4a8.6 8.6 0 0 1 11.6 0"/><path d="M3.4 6.9a5.4 5.4 0 0 1 7.2 0"/></g><circle cx="7" cy="9.8" r="1.6" fill="#fff"/>',
    bt: '<path d="M1 4.5 9 11l-4 4V1l4 4-8 6.5" fill="none" stroke="#fff" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/>',
    swipe: '<g fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m1.5 1.5 6.5 6.5-6.5 6.5"/><path d="m12 1.5 6.5 6.5-6.5 6.5"/><path d="m22.5 1.5 6.5 6.5-6.5 6.5"/></g>',
  };
  const svg = (name, w, h, box, style = '') =>
    `<svg class="w" style="${style}" width="${w}" height="${h}" viewBox="${box}" aria-hidden="true">${ICONS[name].replace(/#[0-9a-f]{3,6}\b/gi, (hex) => ink(hex))}</svg>`;

  // The battery as paint_battery draws it at the sample level, ending at BAR_RIGHT. No choice shows
  // the Icon, the Q2's own default.
  function batteryBar(mode) {
    const level = parseInt(SAMPLE.battery, 10);
    const white = ink('#fff');
    const { bodyW, bodyH, nubW, nubH, gap, insideW, insideH, insidePx, px: digitPx, pctW } = BATT;
    const nub = (x, y, h) => `<div class="w" style="left:${x}px;top:${y + (h - nubH) / 2}px;width:${nubW}px;height:${nubH}px;background:${white}"></div>`;
    const digits = (x) => `<div class="w t mid" style="left:${x}px;top:0;width:${pctW}px;height:30px;font-size:${fontPx(digitPx)}px;color:${white}">${SAMPLE.battery}</div>`;
    const icon = (x, y) => `<div class="w" style="left:${x}px;top:${y}px;width:${bodyW}px;height:${bodyH}px;border:1px solid ${white};border-radius:1px;box-sizing:border-box"></div>` +
      `<div class="w" style="left:${x + 2}px;top:${y + 2}px;width:${Math.floor((bodyW - 4) * level / 100)}px;height:${bodyH - 4}px;background:${white}"></div>` +
      nub(x + bodyW, y, bodyH);
    if (mode === 'percent') return { width: pctW, html: digits(BAR_RIGHT - pctW) };
    if (mode === 'inside') {
      const width = insideW + nubW;
      const [x, y] = [BAR_RIGHT - width, 8];
      return {
        width,
        html: `<div class="w t mid" style="left:${x}px;top:${y}px;width:${insideW}px;height:${insideH}px;background:${white};border-radius:3px;font-size:${fontPx(insidePx)}px;color:${ink('#000')}">${level}</div>` +
          nub(x + insideW, y, insideH),
      };
    }
    if (mode === 'both') {
      const width = bodyW + nubW + gap + pctW;
      const x = BAR_RIGHT - width;
      return { width, html: icon(x, 9) + digits(x + bodyW + nubW + gap) };
    }
    return { width: bodyW + nubW, html: icon(BAR_RIGHT - bodyW - nubW, 10) };
  }

  // A drawing pass: collects the click targets and the dashed outlines as it goes.
  function newPass() {
    return { hits: [], ghosts: [] };
  }

  function place(pass, page, el, rect) {
    pass.hits.push({ page, id: el.id, ...rect });
  }

  function ghost(pass, page, el, rect) {
    pass.ghosts.push({ page, id: el.id, label: el.label, ...rect });
  }

  // The item at its place, or nothing but an outline when it is hidden.
  function item(pass, page, id, draw, adjust) {
    const el = elementOf(page, id);
    const at = screenAt(page, el);
    const rect = adjust ? { ...at, ...adjust(at) } : at;
    if (at.hidden) {
      ghost(pass, page, el, rect);
      return '';
    }
    place(pass, page, el, rect);
    return draw(at, rect);
  }

  function text(pass, page, id, value, opts) {
    return item(pass, page, id, (at, rect) => {
      const colour = at.tint ?? ink(textColour(page, id));
      return `<div class="w t ${opts.cls ?? ''}" style="${px(rect)};font-size:${fontPx(at.font ?? opts.size)}px;color:${colour}">${value}</div>`;
    });
  }

  function drawBar(pass) {
    // EQ and Bluetooth come and go on the Q2, so only the Status bar tab, where they are edited, draws them.
    const allIcons = view.page === BAR;
    let html = svg('play', 15, 30, '0 0 15 30', 'left:54px;top:0');
    if (allIcons) {
      html += item(pass, BAR, 'label_eq', (at) => `<div class="w t" style="left:73px;top:0;width:28px;height:30px;font-size:${fontPx(at.font ?? 16)}px;color:${ink('#fff')}">EQ</div>`,
        () => ({ x: 73, y: 0, w: 28, h: 30 }));
    }
    html += text(pass, BAR, 'label_clock', SAMPLE.clock, { size: 16, cls: 'mid' });

    // The right group ends STATUS_MARGIN from the edge and closes up around whatever is hidden.
    const battery = batteryBar(theme.battery);
    html += battery.html;
    let right = BAR_RIGHT - battery.width - 4;
    const shown = [];
    const hidden = [];
    for (const [id, width] of allIcons ? [['img_wifi', 14], ['img_bt', 43]] : [['img_wifi', 14]]) {
      (geo(BAR, elementOf(BAR, id)).hidden ? hidden : shown).push([id, width]);
    }
    for (const [id, width] of [...shown, ...hidden]) {
      const el = elementOf(BAR, id);
      const x = right - width;
      right -= width + 4;
      const rect = id === 'img_bt' ? { x: x + 29, y: 0, w: 18, h: 30 } : { x, y: 0, w: width, h: 30 };
      if (geo(BAR, el).hidden) {
        ghost(pass, BAR, el, rect);
        continue;
      }
      place(pass, BAR, el, rect);
      html += id === 'img_wifi'
        ? svg('wifi', 14, 12, '0 0 14 12', `left:${x}px;top:9px`)
        : svg('bt', 10, 16, '0 0 10 16', `left:${x + 33}px;top:7px`);
    }
    return html;
  }

  // An icon at fullW by fullH 1:1, scaled to its place as the firmware's scale_auto does, and centred.
  function fitted(name, w, h, box, at, fullW, fullH) {
    const scale = Math.min(at.w / fullW, at.h / fullH);
    const [drawnW, drawnH] = [w * scale, h * scale];
    return svg(name, drawnW, drawnH, box, `left:${at.x + (at.w - drawnW) / 2}px;top:${at.y + (at.h - drawnH) / 2}px`);
  }

  function drawPlaying(pass) {
    const P = PLAYING;
    let html = item(pass, P, 'img_cover', (at) =>
      `<div class="w art" style="${px(at)};border-radius:${Math.round(at.w * 12 / 166)}px"></div>`);
    html += text(pass, P, 'label_ipod_pos', SAMPLE.position, { size: 16 });
    const dots = ink('#eee');
    html += `<div class="w" style="left:316px;top:48px;width:4px;height:4px;border-radius:50%;background:${dots};box-shadow:10px 0 ${dots},20px 0 ${dots}"></div>`;
    html += text(pass, P, 'scrlabel_title', SAMPLE.title, { size: 22, cls: 'inset' });
    html += text(pass, P, 'scrlabel_artist', SAMPLE.artist, { size: 18, cls: 'inset' });
    html += text(pass, P, 'label_ipod_album', SAMPLE.album, { size: 15, cls: 'caps inset' });
    html += text(pass, P, 'view_eqchip', 'EQ: Off', { size: 15, cls: 'inset' });
    // The glyphs end level with the art at the default place (ipod.py NP_ICON_PAD). The screenshots
    // show the look, but they predate 1.6.0's layout, so positions follow the catalogue.
    html += item(pass, P, 'img_playmode', (at) => fitted('shuffle', 23, 20, '0 0 23 20', at, 50, 50));
    html += item(pass, P, 'img_fav', (at) => fitted('heart', 24, 20, '0 0 24 20', at, 50, 50));
    html += item(pass, P, 'slide_indicator1', () => {
      const dots = [0, 1, 2, 3].map((i) =>
        `<div class="w" style="left:${159 + i * 16}px;top:248px;width:8px;height:8px;border-radius:50%;background:${ink(i ? '#555' : '#eee')}"></div>`);
      return dots.join('');
    }, () => ({ x: 154, y: 243, w: 66, h: 19 }));
    html += item(pass, P, 'slider_play', (at) => {
      const fill = ink(core.progressFill(theme.accent));
      const top = at.y + Math.round(at.h / 2) - 2;
      return `<div class="w" style="left:${at.x}px;top:${top}px;width:${at.w}px;height:4px;background:${ink('#1c1c1c')}"></div>` +
        `<div class="w" style="left:${at.x}px;top:${top}px;width:${Math.round(at.w * SAMPLE.progress)}px;height:4px;background:${fill}"></div>`;
    });
    html += text(pass, P, 'label_playtime', SAMPLE.elapsed, { size: 14 });
    html += text(pass, P, 'label_ipod_remain', SAMPLE.remaining, { size: 14, cls: 'end' });
    return html;
  }

  const homeSize = (key) => theme.home[key] ?? core.HOME[key].normal;

  // Stored images are local: a blob or data URL the page made itself.
  const imageTag = (picture, rect) => `<img class="w" alt="" src="${picture.url}" style="${px(rect)};object-fit:cover">`;

  // The picture picked on the right, else the cycle's first, else the sample. A still is a square
  // cover the Q2 crops to the panel; a GIF is made the panel's size.
  function drawArtPanel() {
    const items = theme.art?.items ?? [];
    const item = items.find(({ id }) => id === view.art) ?? items[0];
    const picture = item ? pictures[item.id] : null;
    const box = item?.kind === 'gif' ? { x: 0, y: 0, w: PANEL_W, h: ART_SIZE } : { x: -51, y: 0, w: ART_SIZE, h: ART_SIZE };
    return `<div class="w" style="left:187px;top:${SCREEN_TOP}px;width:${PANEL_W}px;height:${ART_SIZE}px;overflow:hidden">` +
      `${picture ? imageTag(picture, box) : `<div class="w art" style="${px(box)}"></div>`}</div>`;
  }

  function drawRows(pass, top) {
    const P = HOME;
    const row = homeSize('rows');
    const width = view.layout === 'full' ? 375 : 187;
    const rows = elementsOf(P);
    const shown = rows.filter((el) => !geo(P, el).hidden);
    const visible = shown.slice(0, core.rowsShown(row, top, shown.length));
    const dotRow = visible.find((el) => el.id === 'btn_stream') ?? visible[0];
    let html = '';
    let y = SCREEN_TOP + top;
    for (const el of visible) {
      const selected = el === dotRow;
      const g = geo(P, el);
      place(pass, P, el, { x: 0, y, w: width, h: row });
      html += `<div class="w t caps" style="left:39px;top:${y - 1}px;width:${width - 47}px;height:${row}px;font-size:${fontPx(g.font ?? 18)}px;color:${ink(selected ? '#fff' : '#8c8c8c')}">${escapeHtml(g.text ?? SAMPLE.rows[el.id])}</div>`;
      if (selected) html += `<div class="w" style="left:25px;top:${y + Math.round(row / 2) - 3}px;width:6px;height:6px;border-radius:50%;background:${ink('#fff')}"></div>`;
      y += row;
    }
    // Hidden rows close up on the device; their outlines use the room that leaves at the bottom.
    for (const el of rows) {
      if (!geo(P, el).hidden) continue;
      ghost(pass, P, el, { x: 0, y, w: width, h: row });
      y += row;
    }
    return html;
  }

  // Carousel shows one card at a time: the row picked on the left, else the first.
  function drawCard(pass, panel) {
    const P = HOME;
    const box = core.cardBox(theme.home.cards, panel);
    const rect = { x: 96 + box.x, y: SCREEN_TOP + box.y, w: box.size, h: box.size };
    const el = elementOf(P, view.sel?.page === P ? view.sel.id : 'btn_playing');
    const g = geo(P, el);
    const name = g.text ?? SAMPLE.rows[el.id];
    place(pass, P, el, rect);
    return `<div class="w card-tile" style="${px(rect)}">${escapeHtml(name.slice(0, 1))}</div>` +
      `<div class="w t mid" style="left:0;top:${SCREEN_TOP + 232}px;width:375px;height:28px;font-size:${fontPx(g.font ?? 28)}px;color:${ink('#fff')}">${escapeHtml(name)}</div>` +
      `<div class="w t mid card-arrow" style="left:0;top:${SCREEN_TOP}px;width:70px;height:${ART_SIZE}px">‹</div>` +
      `<div class="w t mid card-arrow" style="left:305px;top:${SCREEN_TOP}px;width:70px;height:${ART_SIZE}px">›</div>`;
  }

  // Carousel's cards start from the top panel; rows, with none, from Home's inset.
  function drawHome(pass) {
    const html = view.layout === 'split' ? drawArtPanel() : '';
    return html + (view.layout === 'carousel' ? drawCard(pass, theme.home.top ?? 0) : drawRows(pass, homeSize('top')));
  }

  function drawLock(pass) {
    const P = LOCK;
    let html = '<div class="wallpaper"></div><div class="shade"></div>';
    html += item(pass, P, 'view_timeinfo', () => {
      let inner = text(pass, P, 'clock_time', SAMPLE.clock, { size: 70 });
      inner += text(pass, P, 'clock_date', SAMPLE.date, { size: 42 });
      inner += text(pass, P, 'label_battery', SAMPLE.battery, { size: 20, cls: 'mid' });
      inner += item(pass, P, 'img_battery', (at) =>
        `<div class="w" style="${px({ ...at, w: 32 })};border:1.5px solid ${ink('#fff')};border-radius:3px;padding:1.5px"><div style="width:80%;height:100%;background:${ink('#fff')};border-radius:1px"></div></div>` +
        `<div class="w" style="left:${at.x + 32}px;top:${at.y + 6}px;width:2px;height:8px;background:${ink('#fff')};border-radius:0 1px 1px 0"></div>`);
      return inner;
    });
    html += item(pass, P, 'view_playinfo', (at) => {
      let inner = `<div class="w" style="${px(at)};background:${ink('#000')}50;border-radius:14px"></div>`;
      inner += `<div class="w art" style="left:${at.x + 10}px;top:${at.y + 10}px;width:60px;height:60px;border-radius:10px"></div>`;
      inner += text(pass, P, 'scrlabel_title', SAMPLE.title, { size: 20 });
      inner += text(pass, P, 'scrlabel_artist', SAMPLE.artist, { size: 16 });
      return inner;
    });
    html += item(pass, P, 'img_slide', (at) => fitted('swipe', 30, 16, '0 0 30 16', at, 30, 16));
    return html;
  }

  function drawScreen() {
    const pass = newPass();
    let html;
    if (view.page === LOCK) {
      html = drawLock(pass);
    } else {
      const under = view.under === HOME ? drawHome : drawPlaying;
      if (view.page === BAR) {
        // The screen under the bar is only context here, so it takes no clicks.
        html = `<div class="dim">${under(newPass())}</div>${drawBar(pass)}`;
      } else {
        html = under(pass) + drawBar(pass);
      }
    }
    $('content').innerHTML = html;
    $('content').style.background = ink('#000');
    drawOverlay(pass);
  }

  function canMove(page, id) {
    const el = elementOf(page, id);
    if (core.allows(el, 'move')) return true;
    const group = groupOf(page, el);
    return !!group && core.allows(group, 'move');
  }

  function overlayNode(cls, rect, data) {
    const node = document.createElement('div');
    node.className = cls;
    node.style.cssText = px(rect);
    if (data) Object.assign(node.dataset, data);
    return node;
  }

  function drawOverlay(pass) {
    const overlay = $('overlay');
    overlay.textContent = '';
    for (const hit of pass.hits) {
      const cls = canMove(hit.page, hit.id) ? 'hit can-move' : 'hit';
      overlay.append(overlayNode(cls, hit, { page: hit.page, id: hit.id }));
    }
    const sel = view.sel;
    for (const outline of pass.ghosts) {
      if (!view.ghosts && !(sel && sel.page === outline.page && sel.id === outline.id)) continue;
      const node = overlayNode('ghost', outline, { page: outline.page, id: outline.id });
      if (outline.w >= 40 && outline.h >= 16) node.textContent = outline.label;
      overlay.append(node);
    }
    if (!sel) return;
    const rect = [...pass.hits, ...pass.ghosts].find((r) => r.page === sel.page && r.id === sel.id);
    if (!rect) return;
    const el = elementOf(sel.page, sel.id);
    if (drag?.active && el.box) {
      const origin = originOf(sel.page, el);
      overlay.append(overlayNode('guide', {
        x: origin.x + el.box[0], y: origin.y + el.box[1], w: el.box[2] - el.box[0], h: el.box[3] - el.box[1],
      }));
    }
    overlay.append(overlayNode('sel', rect));
    if (core.allows(el, 'size') && !geo(sel.page, el).hidden) {
      const handle = overlayNode('handle', { x: rect.x + rect.w, y: rect.y + rect.h, w: 11, h: 11 });
      handle.title = 'Drag to resize';
      overlay.append(handle);
    }
  }

  /* ---------- Left panel ---------- */

  function renderTabs() {
    const tabs = $('tabs');
    tabs.textContent = '';
    for (const [page, { label }] of Object.entries(cat.pages)) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'tab';
      tab.role = 'tab';
      tab.id = `tab-${page}`;
      tab.dataset.page = page;
      tab.setAttribute('aria-controls', 'elements');
      const name = document.createElement('span');
      name.textContent = label;
      const count = document.createElement('span');
      count.className = 'count';
      tab.append(name, count);
      tabs.append(tab);
    }
  }

  function renderList() {
    const list = $('elements');
    list.textContent = '';
    $('listTitle').textContent = `On ${cat.pages[view.page].label}`;
    $('pageNote').textContent = PAGE_NOTES[view.page] ?? '';
    for (const el of elementsOf(view.page)) {
      const row = document.createElement('div');
      row.className = groupOf(view.page, el) ? 'row child' : 'row';
      row.dataset.id = el.id;

      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'row-main';
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = el.label;
      const flag = document.createElement('span');
      flag.className = 'flag';
      flag.textContent = '!';
      flag.hidden = true;
      main.append(label, flag);

      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.role = 'switch';
      toggle.setAttribute('aria-label', `Show ${el.label}`);
      toggle.title = `Show or hide ${el.label}`;

      row.append(main, toggle);
      list.append(row);
    }
  }

  function setShown(page, id, shown, control) {
    if (!shown && !core.canHide(theme, cat, page, id)) {
      control.checked = true;
      toast('Keep at least one other row on Home. The Shortcut row does not count, as not every Q2 shows it.');
      return;
    }
    editRule(page, id, (rule) => {
      if (shown) delete rule.hide;
      else rule.hide = true;
    });
  }

  function setPage(page) {
    if (page === view.page) return;
    if (page === PLAYING || page === HOME) view.under = page;
    view.page = page;
    if (view.sel && view.sel.page !== page) view.sel = null;
    renderList();
    refresh();
  }

  function select(page, id) {
    if (page !== view.page) setPage(page);
    view.sel = { page, id };
    endRun();
    refresh();
  }

  function deselect() {
    view.sel = null;
    refresh();
  }

  const homeChanges = () => Object.keys(theme.home).length + (theme.art ? 1 : 0);
  const changedOn = (page) => Object.keys(theme.rules[page] ?? {}).length + (page === HOME ? homeChanges() : 0);

  function syncLeft() {
    for (const tab of $('tabs').children) {
      const page = tab.dataset.page;
      tab.setAttribute('aria-selected', String(page === view.page));
      tab.tabIndex = page === view.page ? 0 : -1;
      const count = changedOn(page);
      const badge = tab.querySelector('.count');
      badge.textContent = count || '';
      badge.title = count ? `${count} changed` : '';
    }
    const flagged = new Map();
    for (const warning of core.warnings(theme, cat)) {
      if (warning.page === view.page) flagged.set(warning.id, warning.text);
    }
    for (const row of $('elements').children) {
      const el = elementOf(view.page, row.dataset.id);
      const g = geo(view.page, el);
      const group = groupOf(view.page, el);
      const toggle = row.querySelector('input');
      toggle.checked = !g.hidden;
      toggle.disabled = !core.allows(el, 'hide');
      row.classList.toggle('selected', view.sel?.id === el.id);
      row.classList.toggle('is-hidden', g.hidden);
      row.classList.toggle('under-hidden', !!group && geo(view.page, group).hidden);
      const flag = row.querySelector('.flag');
      flag.hidden = !flagged.has(el.id);
      flag.title = flagged.get(el.id) ?? '';
      row.querySelector('.row-main').setAttribute('aria-pressed', String(view.sel?.id === el.id));
    }
    $('btnResetScreen').disabled = !changedOn(view.page);
    $('btnResetAll').disabled = !Object.keys(theme.rules).length && !theme.accent && !theme.bg && !theme.battery && !homeChanges();
  }

  /* ---------- Home's sizes and right panel ---------- */

  function setHomeSize(key, value, run) {
    commit({ ...theme, home: { ...theme.home, [key]: value } }, run);
  }

  function renderCycle() {
    const list = $('artPins');
    const items = theme.art?.items ?? [];
    const shown = items.find(({ id }) => id === view.art) ?? items[0];
    list.textContent = '';
    items.forEach((item, index) => {
      const picture = pictures[item.id];
      const row = document.createElement('div');
      row.className = 'image-row';
      row.classList.toggle('selected', view.layout === 'split' && item === shown);
      row.dataset.index = index;
      const thumb = document.createElement('img');
      thumb.className = 'thumb';
      thumb.alt = '';
      if (picture) thumb.src = picture.url;
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = picture?.name ?? `On the card, ${index + 1}${item.kind === 'gif' ? ' (GIF)' : ''}`;
      label.title = label.textContent;
      row.append(thumb, label);
      for (const [text, title, move] of [['↑', 'Move up', -1], ['↓', 'Move down', 1], ['✕', 'Remove', 0]]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'quiet';
        button.textContent = text;
        button.title = title;
        button.setAttribute('aria-label', `${title}: ${label.textContent}`);
        button.dataset.move = move;
        row.append(button);
      }
      list.append(row);
    });
    $('artEmpty').hidden = items.length > 0;
  }

  function syncHome() {
    const on = view.page === HOME;
    $('homeSection').hidden = !on;
    $('artSection').hidden = !on;
    if (!on) return;
    $('homeLayout').value = view.layout;
    for (const [key, range, box] of [['rows', 'homeRows', 'homeRowsBox'], ['top', 'homeTop', 'homeTopBox'], ['cards', 'homeCards', 'homeCardsBox']]) {
      const { min, max } = core.HOME[key];
      for (const id of [range, box]) {
        $(id).min = min;
        $(id).max = max;
        setValue($(id), homeSize(key));
      }
    }
    setValue($('artSeconds'), theme.art?.seconds ?? core.ART.turn);
    $('artSeconds').min = core.ART.turnMin;
    $('artSeconds').max = core.ART.turnMax;
    renderCycle();
    syncAlbums();
  }

  async function readFrames(blob) {
    if (blob.type !== 'image/gif' || !('ImageDecoder' in window)) return [{ bitmap: await createImageBitmap(blob), delay: 0 }];
    const decoder = new ImageDecoder({ data: await blob.arrayBuffer(), type: 'image/gif' });
    await decoder.tracks.ready;
    const count = decoder.tracks.selectedTrack.frameCount;
    const wanted = Math.min(count, GIF_FRAMES);
    const frames = [];
    for (let index = 0; index < wanted; index += 1) {
      const { image } = await decoder.decode({ frameIndex: Math.floor(index * count / wanted) });
      frames.push({ bitmap: await createImageBitmap(image), delay: (image.duration ?? 100000) / 1000 * count / wanted });
      image.close();
    }
    decoder.close();
    return frames;
  }

  async function makePicture(blob, name) {
    return { url: URL.createObjectURL(blob), frames: await readFrames(blob), name };
  }

  // The host's data URL as a file. The page's policy lets it fetch nothing but its library.
  function blobOf(url) {
    const [head, data] = url.split(',');
    return new Blob([Uint8Array.from(atob(data), (c) => c.charCodeAt(0))], { type: head.slice(5, head.indexOf(';')) });
  }

  async function addPicture(blob, name, id) {
    if ((theme.art?.items.length ?? 0) >= core.ART.max) {
      toast(`Up to ${core.ART.max} pictures can take turns.`);
      return;
    }
    try {
      pictures[id] = await makePicture(blob, name);
    } catch {
      notice('This image could not be opened', 'It may be damaged, or not an image the Q2 Theme Studio can read. PNG, JPEG and GIF all work.');
      return;
    }
    picturesChanged = true;
    view.art = id;
    view.layout = 'split';
    const item = { id, kind: pictures[id].frames.length > 1 ? 'gif' : 'jpg' };
    commit({ ...theme, art: { items: [...(theme.art?.items ?? []), item], seconds: theme.art?.seconds ?? core.ART.turn } });
  }

  function setCycle(items) {
    commit({ ...theme, art: items.length ? { ...theme.art, items } : null });
  }

  // A row shows its picture in the preview; its buttons move or remove it.
  function cycleClick(event) {
    const row = event.target.closest('.image-row');
    if (!row) return;
    const index = Number(row.dataset.index);
    const button = event.target.closest('[data-move]');
    const items = [...theme.art.items];
    if (!button) {
      view.art = items[index].id;
      view.layout = 'split';
      refresh();
      return;
    }
    const move = Number(button.dataset.move);
    if (!move) items.splice(index, 1);
    else if (items[index + move]) [items[index], items[index + move]] = [items[index + move], items[index]];
    else return;
    setCycle(items);
  }

  const albumPin = (path) => `album:${path}`;
  const inCycle = (id) => !!theme.art?.items.some((item) => item.id === id);

  function syncAlbums() {
    for (const button of $('artAlbums').querySelectorAll('[data-album]')) {
      const on = inCycle(albumPin(button.dataset.album));
      button.textContent = on ? '★' : '☆';
      button.setAttribute('aria-pressed', String(on));
      button.title = on ? 'Take this cover out' : 'Add this cover';
    }
  }

  function renderAlbums() {
    const list = $('artAlbums');
    const words = $('artFilter').value.toLowerCase().split(/\s+/).filter(Boolean);
    const found = albums.list.filter((album) => words.every((word) => album.name.toLowerCase().includes(word)));
    list.textContent = '';
    for (const album of found.slice(0, ALBUM_ROWS)) {
      const row = document.createElement('div');
      row.className = 'image-row';
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = album.name;
      label.title = album.name;
      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'quiet pin';
      pin.dataset.album = album.path;
      pin.dataset.name = album.name;
      pin.setAttribute('aria-label', `Add ${album.name}`);
      row.append(label, pin);
      list.append(row);
    }
    $('artNote').textContent = !albums.list.length ? 'No album folders with a cover file were found. Use Add images for art kept inside the music files.'
      : found.length > ALBUM_ROWS ? `The first ${ALBUM_ROWS} of ${found.length}. Add a word to narrow it.`
        : `${found.length} of ${albums.list.length} albums.`;
    $('artNote').hidden = false;
    syncAlbums();
  }

  async function findAlbums() {
    $('artFind').disabled = true;
    try {
      const q2 = (await host.call('drives')).sort(driveOrder)[0];
      if (!q2) {
        toast('Connect the card first.');
      } else {
        toast(`Looking through ${q2.letter}:…`);
        albums.letter = q2.letter;
        albums.list = await host.call('albums', { letter: q2.letter });
        $('artFilter').hidden = false;
        $('artAlbums').hidden = false;
        renderAlbums();
      }
    } catch (error) {
      notice('The albums could not be read', error.message);
    }
    $('artFind').disabled = false;
  }

  async function albumClick(event) {
    const button = event.target.closest('[data-album]');
    if (!button) return;
    const { album: path, name } = button.dataset;
    const id = albumPin(path);
    if (inCycle(id)) {
      setCycle(theme.art.items.filter((item) => item.id !== id));
      return;
    }
    try {
      await addPicture(blobOf(await host.call('album_art', { letter: albums.letter, path })), name, id);
    } catch (error) {
      notice('This cover could not be read', error.message);
    }
  }

  // Cropped to fill, as the preview shows it.
  function drawCover(context, bitmap, w, h) {
    const scale = Math.max(w / bitmap.width, h / bitmap.height);
    const [drawnW, drawnH] = [bitmap.width * scale, bitmap.height * scale];
    context.drawImage(bitmap, (w - drawnW) / 2, (h - drawnH) / 2, drawnW, drawnH);
  }

  function sized(w, h) {
    const canvas = document.createElement('canvas');
    [canvas.width, canvas.height] = [w, h];
    return canvas;
  }

  // JPEG has no transparency, so a still goes on black.
  function stillData(picture) {
    const canvas = sized(ART_SIZE, ART_SIZE);
    const context = canvas.getContext('2d');
    context.fillStyle = '#000';
    context.fillRect(0, 0, ART_SIZE, ART_SIZE);
    drawCover(context, picture.frames[0].bitmap, ART_SIZE, ART_SIZE);
    return canvas.toDataURL('image/jpeg', ART_QUALITY).split(',')[1];
  }

  function toBase64(bytes) {
    let text = '';
    for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    return btoa(text);
  }

  // Exactly the panel's size, which is how the Q2 draws a GIF, and small enough to hold decoded.
  function gifData(picture) {
    const context = sized(PANEL_W, ART_SIZE).getContext('2d', { willReadFrequently: true });
    for (let bytes = core.GIF_BYTES; ; bytes /= 2) {
      const frames = core.thinFrames(picture.frames, PANEL_W, ART_SIZE, bytes).map(({ bitmap, delay }) => {
        context.clearRect(0, 0, PANEL_W, ART_SIZE);
        drawCover(context, bitmap, PANEL_W, ART_SIZE);
        return { rgba: context.getImageData(0, 0, PANEL_W, ART_SIZE).data, delay };
      });
      const file = core.encodeGif(PANEL_W, ART_SIZE, frames);
      if (file.length <= GIF_FILE_MAX || frames.length === 1) return toBase64(file);
    }
  }

  const artFile = (index, kind) => `art${String(index + 1).padStart(2, '0')}.${kind}`;

  // Each picture before the theme, so a theme on the card always finds what it counts. One with no
  // picture here came with the theme, and stays on the card as it is.
  async function saveCycle(letter) {
    for (const [index, { id, kind }] of (theme.art?.items ?? []).entries()) {
      if (!pictures[id]) continue;
      await host.call('image_save', { letter, name: artFile(index, kind), data: kind === 'gif' ? gifData(pictures[id]) : stillData(pictures[id]) });
    }
  }

  // The pictures of a theme just loaded from this card, so it can be seen and saved again.
  async function readCycle(letter) {
    try {
      for (const [index, { id, kind }] of (theme.art?.items ?? []).entries()) {
        const url = await host.call('image_read', { letter, name: artFile(index, kind) });
        if (url !== null) pictures[id] = await makePicture(blobOf(url), null);
      }
    } catch {
      toast('Some of this theme\'s pictures could not be read from the card.');
    }
    refresh();
  }

  /* ---------- Inspector and Colours ---------- */

  // A number or colour box the user is typing in keeps what they typed.
  function setValue(input, value) {
    if (document.activeElement !== input) input.value = value;
  }

  function fillWarnings(box, messages) {
    box.textContent = '';
    for (const message of messages) {
      const line = document.createElement('p');
      line.textContent = message;
      box.append(line);
    }
    box.hidden = !messages.length;
  }

  function syncInspector() {
    const sel = view.sel;
    $('inspEmpty').hidden = !!sel;
    $('inspBody').hidden = !sel;
    if (!sel) {
      $('inspTitle').textContent = 'Nothing selected';
      return;
    }
    const el = elementOf(sel.page, sel.id);
    const g = geo(sel.page, el);
    const group = groupOf(sel.page, el);
    $('inspTitle').textContent = el.label;

    const show = $('inspShow');
    show.checked = !g.hidden;
    show.disabled = !core.allows(el, 'hide');
    show.setAttribute('aria-label', `Show ${el.label} on screen`);

    const note = $('inspNote');
    const lastRow = !g.hidden && el.kind === 'row' && !core.canHide(theme, cat, sel.page, sel.id);
    const underHidden = !!group && geo(sel.page, group).hidden;
    note.textContent = lastRow ? 'This is the last main row, and Home needs at least one.'
      : underHidden ? `Hidden along with ${group.label}.`
      : el.id === core.OPTIONAL_ROW ? SHORTCUT_NOTE : '';
    note.hidden = !note.textContent;

    const messages = [];
    if (g.hidden && el.warn) messages.push(el.warn);
    if (!g.hidden && g.tint && core.tintIsLow(g.tint, theme.bg)) messages.push(`This text colour may be hard to read on ${theme.bg ? 'this background' : 'black'}.`);
    fillWarnings($('inspWarn'), messages);

    const movable = core.allows(el, 'move');
    $('inspMove').hidden = !movable;
    if (movable) {
      // Shown from the screen's top left corner. The file keeps the catalogue's own coordinates.
      const origin = originOf(sel.page, el);
      const low = core.clampMove(el, -9999, -9999, g.w, g.h);
      const high = core.clampMove(el, 9999, 9999, g.w, g.h);
      const x = $('inspX');
      const y = $('inspY');
      x.min = origin.x + low[0]; x.max = origin.x + high[0];
      y.min = origin.y + low[1]; y.max = origin.y + high[1];
      y.disabled = low[1] === high[1];
      setValue(x, origin.x + g.x);
      setValue(y, origin.y + g.y);
    }

    const sizable = core.allows(el, 'size');
    $('inspSize').hidden = !sizable;
    if (sizable) {
      const [low, high] = [core.clampBox(el, 0, 0), core.clampBox(el, 9999, 9999)];
      for (const [id, axis, value] of [['inspW', 0, g.w], ['inspH', 1, g.h]]) {
        $(id).min = low[axis];
        $(id).max = high[axis];
        setValue($(id), value);
      }
      const note = core.isSquare(el) ? 'The album art stays square.'
        : core.allows(el, 'font') ? 'The box the text sits in. A size too small cuts the text off.' : '';
      $('inspSizeNote').textContent = note;
      $('inspSizeNote').hidden = !note;
    }

    const worded = core.allows(el, 'font');
    $('inspFont').hidden = !worded;
    if (worded) {
      $('inspFontPx').min = core.FONT_MIN;
      $('inspFontPx').max = core.FONT_MAX;
      setValue($('inspFontPx'), g.font);
    }

    const rewordable = core.allows(el, 'text');
    $('inspText').hidden = !rewordable;
    if (rewordable) {
      $('inspTextBox').maxLength = core.TEXT_MAX;
      $('inspTextBox').placeholder = SAMPLE.rows[el.id];
      setValue($('inspTextBox'), g.text ?? '');
      $('inspTextClear').disabled = !g.text;
    }

    const tintable = core.allows(el, 'tint');
    $('inspTint').hidden = !tintable;
    if (tintable) {
      const colour = g.tint ?? ink(textColour(sel.page, sel.id));
      setValue($('inspTintPick'), colour);
      setValue($('inspTintHex'), colour);
      $('inspTintClear').disabled = !g.tint;
      $('inspTintHex').removeAttribute('aria-invalid');
    }
    $('inspReset').disabled = !theme.rules[sel.page]?.[sel.id];
  }

  function syncColours() {
    const accent = theme.accent;
    setValue($('accentHex'), accent ?? '');
    setValue($('accentPick'), accent ?? '#eeeeec');
    $('accentHex').removeAttribute('aria-invalid');
    $('accentClear').disabled = !accent;
    for (const chip of $('chips').children) chip.setAttribute('aria-pressed', String(chip.dataset.hex === accent));
    const sample = $('menuSample');
    sample.style.background = accent ?? '#eeeeec';
    sample.style.color = accent ? '#fff' : '#111';
    fillWarnings($('accentWarn'), core.accentWarnings(accent, theme.bg));
    setValue($('bgHex'), theme.bg ?? '');
    setValue($('bgPick'), theme.bg ?? '#000000');
    $('bgHex').removeAttribute('aria-invalid');
    $('bgClear').disabled = !theme.bg;
    fillWarnings($('bgWarn'), core.bgWarnings(theme.bg, accent));
    $('batterySelect').value = theme.battery ?? '';
  }

  function renderChips() {
    for (const preset of core.PRESETS) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.dataset.hex = preset.hex;
      chip.setAttribute('aria-label', `${preset.name} accent`);
      const swatch = document.createElement('i');
      swatch.style.background = preset.hex;
      const name = document.createElement('span');
      name.textContent = preset.name;
      chip.append(swatch, name);
      $('chips').append(chip);
    }
  }

  // A colour input and hex box that stay in step; apply(hex) gets each valid value.
  function bindColour(pick, box, apply) {
    pick.addEventListener('input', () => apply(pick.value));
    pick.addEventListener('change', endRun);
    box.addEventListener('input', () => {
      const hex = core.normHex(box.value);
      if (box.value === '') {
        box.removeAttribute('aria-invalid');
      } else if (hex) {
        box.removeAttribute('aria-invalid');
        apply(hex);
      } else {
        box.setAttribute('aria-invalid', 'true');
      }
    });
    box.addEventListener('blur', () => {
      endRun();
      refresh();
    });
  }

  function syncHint() {
    const sel = view.sel;
    let hint = 'Click something on the screen to change it.';
    if (sel) {
      const el = elementOf(sel.page, sel.id);
      if (geo(sel.page, el).hidden) hint = 'This item is hidden. Turn on Show on screen to bring it back.';
      else if (core.allows(el, 'move')) hint = `Drag to move${core.allows(el, 'size') ? ', and drag its corner to resize' : ''}. Arrow keys move it 1 pixel, or 10 with Shift.`;
      else if (canMove(sel.page, sel.id)) hint = `Drag to move the whole ${groupOf(sel.page, el).label.toLowerCase()}.`;
      else {
        const can = [];
        if (core.allows(el, 'hide')) can.push('hide it');
        if (core.allows(el, 'size')) can.push('resize it');
        if (core.allows(el, 'font')) can.push('change its text size');
        if (core.allows(el, 'text')) can.push('reword it');
        if (core.allows(el, 'tint')) can.push('change its colour');
        hint = `This item stays where it is, but you can ${can.join(', ')}.`;
      }
    }
    $('hint').textContent = hint;
  }

  const unsaved = () => JSON.stringify(theme) !== savedState || picturesChanged;

  function markSaved() {
    savedState = JSON.stringify(theme);
    syncToolbar();
  }

  function syncToolbar() {
    $('btnUndo').disabled = !history.past.length;
    $('btnRedo').disabled = !history.future.length;
    setValue($('themeName'), theme.name);
    $('unsaved').hidden = !(view.mode === 'eq' ? eqPage?.unsaved() : unsaved());
    $('chkGhosts').checked = view.ghosts;
  }

  function passFocus(control) {
    if (control === document.body || !(control.disabled || !control.offsetParent)) return;
    const next = [...(FOCUS_NEXT[control.id] ?? []), 'stage'].map($).find((node) => !node.disabled && node.offsetParent);
    next?.focus();
  }

  function refresh() {
    const focused = document.activeElement;
    drawScreen();
    syncLeft();
    syncInspector();
    syncHome();
    syncColours();
    syncHint();
    syncToolbar();
    if (focused) passFocus(focused);
  }

  function syncModes() {
    for (const [id, mode] of [['modeTheme', 'theme'], ['modeEq', 'eq'], ['modeLibrary', 'library']]) {
      $(id).setAttribute('aria-selected', String(view.mode === mode));
      $(id).tabIndex = view.mode === mode ? 0 : -1;
    }
  }

  function setMode(mode) {
    if (mode === view.mode) return;
    view.mode = mode;
    const onEq = mode === 'eq';
    $('themeView').hidden = mode !== 'theme';
    $('eqView').hidden = !onEq;
    $('libraryView').hidden = mode !== 'library';
    $('themeNameField').hidden = onEq;
    $('eqNameField').hidden = !onEq;
    syncModes();
    if (!onEq) eqPage.hide();
    if (onEq) eqPage.show();
    else if (mode === 'library') libraryPage.show();
    else refresh();
    syncToolbar();
  }

  /* ---------- Moving and sizing ---------- */

  function moveTo(page, el, x, y, key) {
    const g = geo(page, el);
    const [nx, ny] = core.clampMove(el, x, y, g.w, g.h);
    editRule(page, el.id, (rule) => { rule.move = [nx, ny]; }, key);
  }

  function setSize(page, el, w, h, key) {
    const size = core.clampBox(el, w, h);
    editRule(page, el.id, (rule) => { rule.size = size; }, key);
  }

  function nudge(dx, dy) {
    const sel = view.sel;
    if (!sel) return false;
    const el = elementOf(sel.page, sel.id);
    if (!core.allows(el, 'move') || geo(sel.page, el).hidden) return false;
    const g = geo(sel.page, el);
    const key = `nudge:${sel.page}:${sel.id}`;
    moveTo(sel.page, el, g.x + dx, g.y + dy, key);
    clearTimeout(nudgeTimer);
    nudgeTimer = setTimeout(() => { if (history.key === key) endRun(); }, NUDGE_REST_MS);
    return true;
  }

  function startDrag(event, kind, page, el) {
    const g = geo(page, el);
    drag = {
      kind, page, el, x0: g.x, y0: g.y, w0: g.w, h0: g.h, startX: event.clientX, startY: event.clientY,
      active: false, key: `drag:${++dragCount}`, before: JSON.stringify(theme),
      past: [...history.past], future: [...history.future],
    };
    $('stage').setPointerCapture(event.pointerId);
  }

  function pointerDown(event) {
    if (event.button !== 0) return;
    const stage = $('stage');
    stage.classList.add('by-pointer');
    stage.focus({ preventScroll: true });
    if (event.target.closest('.handle')) {
      const { page, id } = view.sel;
      startDrag(event, 'size', page, elementOf(page, id));
      return;
    }
    const target = event.target.closest('.hit, .ghost');
    if (!target) {
      deselect();
      return;
    }
    const { page, id } = target.dataset;
    select(page, id);
    if (target.classList.contains('ghost')) return;
    const el = elementOf(page, id);
    const group = groupOf(page, el);
    const moving = core.allows(el, 'move') ? el : group && core.allows(group, 'move') ? group : null;
    if (moving) startDrag(event, 'move', page, moving);
  }

  function pointerMove(event) {
    if (!drag) return;
    const dx = (event.clientX - drag.startX) / view.scale;
    const dy = (event.clientY - drag.startY) / view.scale;
    if (!drag.active) {
      if (Math.hypot(dx, dy) < DRAG_START) return;
      drag.active = true;
      $('stage').classList.add('dragging');
      if (view.sel?.id !== drag.el.id) view.sel = { page: drag.page, id: drag.el.id };
    }
    if (drag.kind === 'move') {
      moveTo(drag.page, drag.el, drag.x0 + dx, drag.y0 + dy, drag.key);
    } else if (core.isSquare(drag.el)) {
      const box = drag.el.box;
      const side = Math.min(drag.w0 + Math.max(dx, dy), box[2] - drag.x0, box[3] - drag.y0);
      setSize(drag.page, drag.el, side, side, drag.key);
    } else {
      setSize(drag.page, drag.el, drag.w0 + dx, drag.h0 + dy, drag.key);
    }
  }

  function endDrag() {
    if (!drag) return;
    const wasActive = drag.active;
    drag = null;
    $('stage').classList.remove('dragging');
    endRun();
    if (wasActive) refresh();
  }

  function cancelDrag() {
    if (!drag?.active) return false;
    const { before, past, future } = drag;
    drag.active = false;
    endDrag();
    history.past = past;
    history.future = future;
    theme = JSON.parse(before);
    refresh();
    return true;
  }

  /* ---------- Files and the card ---------- */

  function toast(message) {
    const box = $('toast');
    box.textContent = message;
    box.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => box.classList.remove('show'), 4200);
  }

  function notice(title, message) {
    $('noticeTitle').textContent = title;
    $('noticeText').textContent = message;
    $('dlgNotice').showModal();
  }

  const skippedNote = (count) =>
    (count ? ` ${count} ${count === 1 ? 'line was' : 'lines were'} skipped because this version does not know them.` : '');

  function loadText(text, source) {
    const parsed = core.parse(text, cat);
    if (!parsed.ok) {
      notice('This theme could not be opened', parsed.error);
      return false;
    }
    const replaced = unsaved();
    view.sel = null;
    commit(parsed.theme);
    endRun();
    $('themeName').value = theme.name; // the box skips updates while it has the cursor
    if (!replaced) markSaved(); // what it replaced is only in Undo, so closing still asks
    refresh();
    const name = parsed.theme.name ? `“${parsed.theme.name}”` : 'The theme';
    const back = replaced ? ' Undo brings back what you had.' : '';
    toast(`${name} is loaded from ${source}.${skippedNote(parsed.ignored)}${back}`);
    return true;
  }

  async function openFile() {
    try {
      const text = await host.call('import_theme');
      if (text !== null) loadText(text, 'the file');
    } catch (error) {
      notice('This theme could not be opened', error.message);
    }
  }

  async function exportFile() {
    const suggested = `${theme.name || 'theme'}.txt`;
    try {
      const saved = await host.call('export_theme', { text: core.serialize(theme, cat), suggested });
      if (saved === null) return false;
      markSaved();
      toast(`Exported as ${saved}. To use it by hand, name it theme.txt in the card's Q2Pod folder.`);
      return true;
    } catch (error) {
      notice('This theme could not be exported', error.message);
      return false;
    }
  }

  const SAVE_PARTS = ['savePick', 'saveDone', 'saveConfirm', 'saveRemoved'];
  const BUSY_LOCKS = ['saveCancel', 'driveSelect', 'driveRefresh', 'saveLoad', 'saveRemove', 'confirmKeep', 'confirmRemove'];
  const card = { drives: [], letter: null, text: null, busy: false };

  // While the card is being written the dialog stays open, so the result is always seen.
  function setBusy(on) {
    card.busy = on;
    for (const id of BUSY_LOCKS) $(id).disabled = on;
    $('saveGo').disabled = on || !card.letter;
  }

  function showSavePart(part) {
    for (const id of SAVE_PARTS) $(id).hidden = id !== part;
  }

  function driveName(drive) {
    const label = drive.label ? ` ${drive.label}` : '';
    const kind = drive.isQ2 ? ' (Q2 card)' : drive.removable ? ' (removable)' : '';
    return `${drive.letter}:${label}${kind}`;
  }

  const driveOrder = (a, b) => (b.isQ2 - a.isQ2) || (b.removable - a.removable) || a.letter.localeCompare(b.letter);

  function showSaveError(message) {
    const box = $('saveError');
    box.textContent = message ?? '';
    box.hidden = !message;
  }

  async function refreshDrives() {
    showSaveError(null);
    try {
      card.drives = (await host.call('drives')).sort(driveOrder);
    } catch (error) {
      card.drives = [];
      showSaveError(error.message);
    }
    const q2 = card.drives.filter((drive) => drive.isQ2);
    const keep = card.drives.some((drive) => drive.letter === card.letter) ? card.letter : null;
    const pick = keep ?? (q2.length === 1 ? q2[0].letter : null);

    const select = $('driveSelect');
    select.textContent = '';
    const blank = new Option(card.drives.length ? 'Choose a drive' : 'No drives found', '');
    select.add(blank);
    for (const drive of card.drives) select.add(new Option(driveName(drive), drive.letter));
    select.value = pick ?? '';
    await chooseDrive(pick);
  }

  function showCardActions(text, parsed) {
    $('cardActions').hidden = text === null;
    $('saveLoad').hidden = !parsed?.ok;
  }

  function driveNote(letter, drive, text, parsed) {
    const q2Cards = card.drives.filter((d) => d.isQ2).length;
    if (!letter) {
      if (q2Cards > 1) return 'More than one Q2 card found. Choose one.';
      if (q2Cards) return 'Choose a drive to save to.';
      return card.drives.length
        ? 'No Q2 card found. Connect it, then press Refresh, or choose a drive.'
        : 'No Q2 card found. Connect it, then press Refresh.';
    }
    if (!drive?.isQ2) return 'This drive does not look like a Q2 card. A Q2Pod folder will be made on it.';
    if (parsed?.ok) {
      return parsed.theme.name
        ? `This card has the theme “${parsed.theme.name}”. Saving replaces it.`
        : 'This card already has a theme. Saving replaces it.';
    }
    return text === null ? '' : 'This card has a theme file that cannot be read. Saving replaces it.';
  }

  async function chooseDrive(letter) {
    card.letter = letter;
    card.text = null;
    // Nothing here acts on the card until its theme is read.
    $('saveGo').disabled = true;
    showCardActions(null, null);
    let text = null;
    if (letter) {
      try {
        text = await host.call('read_theme', { letter });
      } catch (error) {
        if (letter === card.letter) showSaveError(error.message);
      }
    }
    if (letter !== card.letter) return; // the choice moved on while reading
    card.text = text;
    const drive = card.drives.find((d) => d.letter === letter);
    const parsed = text === null ? null : core.parse(text, cat);
    $('driveInfo').textContent = driveNote(letter, drive, text, parsed);
    $('saveGo').disabled = !letter;
    showCardActions(text, parsed);
  }

  function saveWarnings() {
    const box = $('saveWarn');
    const found = core.warnings(theme, cat);
    box.textContent = '';
    box.hidden = !found.length;
    if (!found.length) return;
    const lead = document.createElement('p');
    lead.textContent = 'Worth a look first (you can still save):';
    const list = document.createElement('ul');
    for (const warning of found) {
      const line = document.createElement('li');
      const el = warning.kind === 'hidden' ? elementOf(warning.page, warning.id) : null;
      line.textContent = el ? `${cat.pages[warning.page].label}, ${el.label}: ${warning.text}` : warning.text;
      list.append(line);
    }
    box.append(lead, list);
  }

  async function openSave() {
    showSavePart('savePick');
    saveWarnings();
    $('saveGo').disabled = true;
    showCardActions(null, null);
    $('driveInfo').textContent = '';
    $('dlgSave').showModal();
    await refreshDrives();
  }

  async function saveToCard() {
    const letter = card.letter;
    if (!letter) return;
    showSaveError(null);
    setBusy(true);
    try {
      await saveCycle(letter);
      await host.call('save_theme', { letter, text: core.serialize(theme, cat) });
    } catch (error) {
      setBusy(false);
      showSaveError(error.message);
      $('saveGo').focus();
      return;
    }
    setBusy(false);
    picturesChanged = false;
    markSaved();
    $('doneText').textContent = `Your theme is saved to drive ${letter}.`;
    showSavePart('saveDone');
    $('doneClose').focus();
  }

  function askRemove() {
    $('confirmText').textContent = `The theme file on ${card.letter}: is deleted. The theme you are editing here stays open.`;
    $('confirmError').hidden = true;
    showSavePart('saveConfirm');
    $('confirmKeep').focus();
  }

  function refuseRemove(message) {
    $('confirmError').textContent = message;
    $('confirmError').hidden = false;
    $('confirmKeep').focus();
  }

  async function removeFromCard() {
    const letter = card.letter;
    setBusy(true);
    let removed = false;
    try {
      removed = await host.call('remove_theme', { letter });
    } catch (error) {
      setBusy(false);
      refuseRemove(error.message);
      return;
    }
    setBusy(false);
    if (!removed) {
      refuseRemove(`No theme was found on ${letter}:. Check the card is still connected.`);
      return;
    }
    $('removedText').textContent = `The theme is removed from drive ${letter}.`;
    showSavePart('saveRemoved');
    $('removedClose').focus();
  }

  const closeSave = () => $('dlgSave').close();

  // The exe asks before closing. Saying nothing would strand the window, so every path answers.
  function closeRequested() {
    const busy = card.busy || eqPage.busy();
    if (!unsaved() && !eqPage.unsaved() && !busy) {
      host.call('close_now');
      return;
    }
    host.call('close_held');
    if (busy) {
      toast('Still saving to the card. Please wait a moment.');
    } else if (!$('dlgClose').open) {
      const what = !eqPage.unsaved() ? 'This theme has' : unsaved() ? 'This theme and this EQ preset have' : 'This EQ preset has';
      $('closeText').textContent = `${what} changes that are not saved. If you close now, they are lost.`;
      $('dlgClose').showModal();
    }
  }

  async function saveCopyAndClose() {
    if (unsaved() && !(await exportFile())) return;
    if (eqPage.unsaved() && !(await eqPage.exportFile())) return;
    host.call('close_now');
  }

  // Offer a theme already on the card, once, when the app starts.
  async function offerCardTheme() {
    let drives;
    try {
      drives = await host.call('drives');
    } catch {
      return;
    }
    for (const drive of drives.filter((d) => d.isQ2)) {
      let text = null;
      try {
        text = await host.call('read_theme', { letter: drive.letter });
      } catch {
        continue;
      }
      const parsed = text === null ? null : core.parse(text, cat);
      if (!parsed?.ok) continue;
      const name = parsed.theme.name ? `“${parsed.theme.name}”` : 'A theme';
      $('loadText').textContent = `${name} is on the card in ${drive.letter}:. Load it to keep working on it?`;
      card.letter = drive.letter;
      card.text = text;
      $('dlgLoad').showModal();
      return;
    }
  }

  /* ---------- Events ---------- */

  function bindEvents() {
    $('tabs').addEventListener('click', (event) => {
      const tab = event.target.closest('.tab');
      if (tab) setPage(tab.dataset.page);
    });
    $('tabs').addEventListener('keydown', (event) => {
      const pages = Object.keys(cat.pages);
      const move = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[event.key];
      if (!move) return;
      event.preventDefault();
      event.stopPropagation();
      const page = pages[(pages.indexOf(view.page) + move + pages.length) % pages.length];
      setPage(page);
      $(`tab-${page}`).focus();
    });

    $('elements').addEventListener('click', (event) => {
      const row = event.target.closest('.row');
      if (row && event.target.closest('.row-main')) select(view.page, row.dataset.id);
    });
    $('elements').addEventListener('change', (event) => {
      const row = event.target.closest('.row');
      if (!row) return;
      view.sel = { page: view.page, id: row.dataset.id };
      setShown(view.page, row.dataset.id, event.target.checked, event.target);
      refresh();
    });

    const stage = $('stage');
    stage.addEventListener('pointerdown', pointerDown);
    stage.addEventListener('pointermove', pointerMove);
    stage.addEventListener('pointerup', endDrag);
    stage.addEventListener('pointercancel', endDrag);
    stage.addEventListener('lostpointercapture', endDrag);
    stage.addEventListener('blur', () => stage.classList.remove('by-pointer'));

    $('inspShow').addEventListener('change', (event) => {
      setShown(view.sel.page, view.sel.id, event.target.checked, event.target);
    });
    const commitOnChange = (input, apply) => {
      input.addEventListener('change', () => {
        if (input.value.trim() !== '') apply(); // an emptied box keeps the old value
        input.value = '';
        const active = document.activeElement === input;
        if (active) input.blur();
        refresh();
        if (active) input.focus();
      });
    };
    commitOnChange($('inspX'), () => {
      const { page, id } = view.sel;
      const el = elementOf(page, id);
      moveTo(page, el, Number($('inspX').value) - originOf(page, el).x, geo(page, el).y);
    });
    commitOnChange($('inspY'), () => {
      const { page, id } = view.sel;
      const el = elementOf(page, id);
      moveTo(page, el, geo(page, el).x, Number($('inspY').value) - originOf(page, el).y);
    });
    commitOnChange($('inspW'), () => {
      const { page, id } = view.sel;
      const el = elementOf(page, id);
      const w = Number($('inspW').value);
      setSize(page, el, w, core.isSquare(el) ? w : geo(page, el).h);
    });
    commitOnChange($('inspH'), () => {
      const { page, id } = view.sel;
      const el = elementOf(page, id);
      const h = Number($('inspH').value);
      setSize(page, el, core.isSquare(el) ? h : geo(page, el).w, h);
    });
    commitOnChange($('inspFontPx'), () => {
      const { page, id } = view.sel;
      editRule(page, id, (rule) => { rule.font = Number($('inspFontPx').value); });
    });
    $('inspTextBox').addEventListener('input', (event) => {
      const { page, id } = view.sel;
      editRule(page, id, (rule) => { rule.text = event.target.value; }, `text:${page}:${id}`);
    });
    $('inspTextBox').addEventListener('blur', () => {
      endRun();
      refresh();
    });
    $('inspTextClear').addEventListener('click', () => {
      const { page, id } = view.sel;
      editRule(page, id, (rule) => { delete rule.text; });
    });

    bindColour($('inspTintPick'), $('inspTintHex'), (hex) => {
      const { page, id } = view.sel;
      editRule(page, id, (rule) => { rule.tint = hex; }, `tint:${page}:${id}`);
    });
    $('inspTintClear').addEventListener('click', () => {
      const { page, id } = view.sel;
      editRule(page, id, (rule) => { delete rule.tint; });
    });
    $('inspReset').addEventListener('click', () => {
      const { page, id } = view.sel;
      const next = structuredClone(theme);
      delete next.rules[page][id];
      commit(next);
    });

    // Only Now Playing shows the accent, so elsewhere a pick needs a word to say it took.
    const setAccent = (hex, key) => {
      if (commit({ ...theme, accent: hex }, key) && hex && view.page !== PLAYING) {
        toast('The accent shows on menus and the Now Playing progress bar, not on this screen.');
      }
    };
    bindColour($('bgPick'), $('bgHex'), (hex) => commit({ ...theme, bg: hex }, 'bg'));
    $('bgClear').addEventListener('click', () => commit({ ...theme, bg: null }));
    bindColour($('accentPick'), $('accentHex'), (hex) => setAccent(hex, 'accent'));
    $('accentClear').addEventListener('click', () => setAccent(null));
    $('chips').addEventListener('click', (event) => {
      const chip = event.target.closest('.chip');
      if (chip) setAccent(chip.dataset.hex);
    });

    $('themeName').addEventListener('input', (event) => commit({ ...theme, name: event.target.value }, 'name'));
    $('themeName').addEventListener('blur', () => {
      endRun();
      refresh();
    });

    $('modeTheme').addEventListener('click', () => setMode('theme'));
    $('modeEq').addEventListener('click', () => setMode('eq'));
    $('modeLibrary').addEventListener('click', () => setMode('library'));

    $('batterySelect').addEventListener('change', (event) => {
      if (commit({ ...theme, battery: event.target.value || null }) && view.page === LOCK && theme.battery) {
        toast('This shows in the status bar, not on this screen.');
      }
    });

    $('btnUndo').addEventListener('click', undo);
    $('btnRedo').addEventListener('click', redo);
    $('chkGhosts').addEventListener('change', (event) => {
      view.ghosts = event.target.checked;
      refresh();
    });
    $('btnResetScreen').addEventListener('click', () => {
      const next = structuredClone(theme);
      delete next.rules[view.page];
      if (view.page === HOME) Object.assign(next, { home: {}, art: null });
      view.sel = null;
      commit(next);
      refresh();
    });

    $('homeLayout').addEventListener('change', (event) => {
      view.layout = event.target.value;
      refresh();
    });
    for (const [key, range, box] of [['rows', 'homeRows', 'homeRowsBox'], ['top', 'homeTop', 'homeTopBox'], ['cards', 'homeCards', 'homeCardsBox']]) {
      const { min, max } = core.HOME[key];
      $(range).addEventListener('input', (event) => setHomeSize(key, Number(event.target.value), `home:${key}`));
      $(range).addEventListener('change', endRun);
      commitOnChange($(box), () => setHomeSize(key, Math.min(Math.max(Number($(box).value), min), max)));
    }
    $('imagePick').addEventListener('change', async (event) => {
      for (const file of [...event.target.files]) await addPicture(file, file.name, `file:${nextPin++}`);
    });
    $('artAdd').addEventListener('click', () => {
      $('imagePick').value = '';
      $('imagePick').click();
    });
    $('artPins').addEventListener('click', cycleClick);
    $('artFind').addEventListener('click', findAlbums);
    $('artFilter').addEventListener('input', renderAlbums);
    $('artAlbums').addEventListener('click', albumClick);
    commitOnChange($('artSeconds'), () => {
      if (theme.art) commit({ ...theme, art: { ...theme.art, seconds: Number($('artSeconds').value) } });
    });
    $('btnResetAll').addEventListener('click', () => {
      view.sel = null;
      commit({ ...core.emptyTheme(), name: theme.name });
      refresh();
    });

    $('btnOpen').addEventListener('click', openHere);
    $('btnExport').addEventListener('click', () => (view.mode === 'eq' ? eqPage.exportFile() : exportFile()));
    $('btnSave').addEventListener('click', saveHere);

    $('driveSelect').addEventListener('change', (event) => {
      showSaveError(null);
      chooseDrive(event.target.value || null);
    });
    $('driveRefresh').addEventListener('click', refreshDrives);
    $('saveCancel').addEventListener('click', closeSave);
    $('saveGo').addEventListener('click', saveToCard);
    $('saveRemove').addEventListener('click', askRemove);
    $('saveLoad').addEventListener('click', () => {
      closeSave();
      if (loadText(card.text, 'the card')) readCycle(card.letter);
    });
    $('doneClose').addEventListener('click', closeSave);
    $('confirmKeep').addEventListener('click', () => {
      showSavePart('savePick');
      $('saveCancel').focus();
      refreshDrives();
    });
    $('confirmRemove').addEventListener('click', removeFromCard);
    $('removedClose').addEventListener('click', closeSave);
    $('dlgSave').addEventListener('cancel', (event) => {
      if (card.busy) event.preventDefault();
    });
    // A second Esc closes a dialog with no cancel event at all.
    $('dlgSave').addEventListener('close', () => {
      if (card.busy) $('dlgSave').showModal();
    });

    window.__closeRequested = closeRequested;
    $('closeDiscard').addEventListener('click', () => host.call('close_now'));
    $('closeKeep').addEventListener('click', () => $('dlgClose').close());
    $('closeCopy').addEventListener('click', saveCopyAndClose);

    $('loadSkip').addEventListener('click', () => $('dlgLoad').close());
    $('loadYes').addEventListener('click', () => {
      $('dlgLoad').close();
      if (loadText(card.text, 'the card')) readCycle(card.letter);
    });
    $('noticeClose').addEventListener('click', () => $('dlgNotice').close());

    document.addEventListener('keydown', onKey);
    document.addEventListener('contextmenu', (event) => {
      if (!event.target.matches('input[type=text], input[type=number]')) event.preventDefault();
    });
    // A file dropped on the window must not replace the app.
    document.addEventListener('dragover', (event) => event.preventDefault());
    document.addEventListener('drop', (event) => event.preventDefault());

    new ResizeObserver(fitPreview).observe($('stageWrap'));
  }

  const openHere = () => (view.mode === 'eq' ? eqPage.openFile() : openFile());
  const saveHere = () => (view.mode === 'eq' ? eqPage.openSave() : openSave());

  function onKey(event) {
    const typing = event.target.matches?.('input[type=text]');
    if (event.ctrlKey && !event.altKey) {
      const key = event.key.toLowerCase();
      const redoKey = key === 'y' || (key === 'z' && event.shiftKey);
      if ((key === 'z' || redoKey) && !typing && !document.querySelector('dialog[open]')) {
        event.preventDefault();
        if (view.mode === 'eq') (redoKey ? eqPage.redo : eqPage.undo)();
        else if (redoKey) redo();
        else undo();
      } else if (key === 's') {
        event.preventDefault();
        if (!document.querySelector('dialog[open]')) saveHere();
      } else if (key === 'o') {
        event.preventDefault();
        if (!document.querySelector('dialog[open]')) openHere();
      }
      return;
    }
    if (document.querySelector('dialog[open]') || view.mode !== 'theme') return;
    if (event.key === 'Escape') {
      if (!cancelDrag() && view.sel && !typing) deselect();
      return;
    }
    const arrow = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!arrow) return;
    if (event.target.matches?.('input:not([type=checkbox]), select')) return;
    const by = event.shiftKey ? 10 : 1;
    if (nudge(arrow[0] * by, arrow[1] * by)) event.preventDefault();
  }

  // 2x when there is room, smaller on a small window. It is all vector, so it stays sharp.
  function fitPreview() {
    const wrap = $('stageWrap').getBoundingClientRect();
    const frame = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--frame'));
    const room = 2 * frame + 4;
    const fit = Math.min(2, (wrap.width - room - 8) / 375, (wrap.height - room) / 320);
    view.scale = Math.max(0.5, Math.floor(fit * 100) / 100);
    document.documentElement.style.setProperty('--s', view.scale);
  }

  async function start() {
    cat = await (await fetch('catalogue.json')).json();
    for (const [page, items] of Object.entries(WORDING)) {
      for (const [id, wording] of Object.entries(items)) Object.assign(elementOf(page, id), wording);
    }
    $('about').textContent = `Screens based on firmware ${cat.firmware}. Saved themes need a Q2 Pod firmware with card themes.`;
    eqPage = window.Q2EqPage(host, { toast, notice, changed: syncToolbar });
    libraryPage = window.Q2LibraryPage(host, {
      base: new URLSearchParams(location.search).get('library') ?? core.LIBRARY_BASE,
      cat,
      toast,
      notice,
      themeNow: () => theme,
      setAuthor: (author) => commit({ ...theme, author }),
      openText: (text) => {
        if (loadText(text, 'the library')) setMode('theme');
      },
    });
    syncModes();
    renderTabs();
    renderChips();
    renderList();
    bindEvents();
    fitPreview();
    refresh();
    offerCardTheme();
  }

  start();
})();
