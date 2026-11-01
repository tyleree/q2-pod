// node --test ui/core.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import core from './core.js';

const cat = JSON.parse(readFileSync(new URL('./catalogue.json', import.meta.url), 'utf8'));
const { emptyTheme, serialize, parse, normalize } = core;
const el = (page, id) => core.findElement(cat, page, id);
const body = (...lines) => ['q2theme 1', ...lines, 'end', ''].join('\n');

function themeWith(rules, extra = {}) {
  return { ...emptyTheme(), ...extra, rules };
}

function roundTrip(theme) {
  const text = serialize(theme, cat);
  const parsed = parse(text, cat);
  assert.equal(parsed.ok, true, parsed.error);
  assert.equal(parsed.ignored, 0);
  assert.deepEqual(parsed.theme, normalize(theme, cat));
  assert.equal(serialize(parsed.theme, cat), text);
}

test('an unchanged theme is only the two fixed lines', () => {
  assert.equal(serialize(emptyTheme(), cat), 'q2theme 1\nend\n');
});

test('the design example survives a round trip', () => {
  const text = body(
    'name Midnight Blue', 'accent #3366ff',
    'page playing_page', 'hide img_fav', 'move img_cover 16 2', 'size img_cover 166 166', 'tint scrlabel_title #ff4040',
    'page system_bar', 'hide label_eq',
    'page home_page', 'hide btn_folder',
  );
  const parsed = parse(text, cat);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ignored, 0);
  assert.equal(parsed.theme.name, 'Midnight Blue');
  assert.equal(parsed.theme.accent, '#3366ff');
  assert.deepEqual(parsed.theme.rules.playing_page.img_fav, { hide: true });
  assert.equal(parsed.theme.rules.playing_page.img_cover, undefined, 'default move and size are dropped');
  roundTrip(parsed.theme);
});

test('every kind of rule on every screen round trips', () => {
  roundTrip(themeWith({
    playing_page: {
      img_cover: { hide: true, move: [10, 4], size: [100, 100] },
      scrlabel_title: { tint: '#ff4040', move: [100, 60] },
      slider_play: { hide: true },
    },
    home_page: { btn_folder: { hide: true }, btn_stream: { hide: true } },
    saverscreen_page: {
      view_playinfo: { move: [10, 100] },
      scrlabel_title: { tint: '#00ff00' },
      img_slide: { hide: true },
    },
    system_bar: { label_clock: { move: [20, 0], tint: '#ffffff' }, img_wifi: { hide: true } },
  }, { name: 'Everything', accent: '#2a6ad8' }));
});

test('output is LF only, in catalogue order, with page only when it has rules', () => {
  const text = serialize(themeWith({
    system_bar: { img_wifi: { hide: true } },
    playing_page: { img_fav: { hide: true }, img_cover: { hide: true, move: [0, 0], size: [50, 50] }, label_ipod_pos: { tint: '#ffffff' } },
  }, { name: 'Order', accent: '#ABCDEF' }), cat);
  assert.equal(text, [
    'q2theme 1', 'name Order', 'accent #abcdef',
    'page playing_page',
    'hide img_cover', 'move img_cover 0 0', 'size img_cover 50 50',
    'hide img_fav', 'tint label_ipod_pos #ffffff',
    'page system_bar', 'hide img_wifi',
    'end', '',
  ].join('\n'));
  assert.ok(!text.includes('\r'));
  assert.ok(!text.includes('home_page'));
});

test('a rule equal to the default is not written', () => {
  const cover = el('playing_page', 'img_cover');
  const text = serialize(themeWith({ playing_page: { img_cover: { move: [cover.x, cover.y], size: [cover.w, cover.h] } } }), cat);
  assert.equal(text, 'q2theme 1\nend\n');
});

test('moves clamp to the box', () => {
  const cover = el('playing_page', 'img_cover');
  assert.deepEqual(core.clampMove(cover, -5, -5), [0, 0]);
  assert.deepEqual(core.clampMove(cover, 999, 999), [375 - 166, 186 - 166]);
  assert.deepEqual(core.clampMove(cover, 20.4, 7.6), [20, 8]);
  const clock = el('system_bar', 'label_clock');
  assert.deepEqual(core.clampMove(clock, 300, 12), [258, 0]);
  const time = el('playing_page', 'label_playtime');
  assert.deepEqual(core.clampMove(time, 0, 0), [0, 245]);
  assert.deepEqual(core.clampMove(time, 400, 400), [295, 274]);
});

test('a size change is part of the clamp', () => {
  const cover = el('playing_page', 'img_cover');
  assert.deepEqual(core.clampMove(cover, 999, 999, 40, 40), [335, 146]);
  const theme = normalize(themeWith({ playing_page: { img_cover: { size: [186, 186] } } }), cat);
  assert.deepEqual(theme.rules.playing_page.img_cover, { size: [186, 186], move: [16, 0] });
});

test('an item bigger than its box keeps its position on that axis', () => {
  const wide = { x: 10, y: 5, w: 100, h: 10, actions: ['move'], box: [0, 0, 50, 50] };
  assert.deepEqual(core.clampMove(wide, 30, 90), [30, 40]);
  assert.deepEqual(core.clampMove(wide, -30, -9), [-30, 0]);
});

test('a clamp on load applies to hand-edited files', () => {
  const parsed = parse(body('page playing_page', 'move img_cover 9999 -40', 'move scrlabel_title 0 0'), cat);
  assert.deepEqual(parsed.theme.rules.playing_page.img_cover.move, [209, 0]);
});

test('size stays square and between 40 and the box', () => {
  const cover = el('playing_page', 'img_cover');
  assert.equal(core.clampSize(cover, 10), 40);
  assert.equal(core.clampSize(cover, 500), 186);
  assert.equal(core.clampSize(cover, 99.6), 100);
  const parsed = parse(body('page playing_page', 'size img_cover 120 90'), cat);
  assert.deepEqual(parsed.theme.rules.playing_page.img_cover.size, [90, 90]);
});

test('names lose control characters and stop at 40', () => {
  assert.equal(core.cleanName('  Midnight\nBlue\r\t\u0000\u007f\u0085\u2028  '), 'MidnightBlue');
  assert.equal(core.cleanName('x'.repeat(50)).length, 40);
  assert.equal(Array.from(core.cleanName('\u{1F3B5}'.repeat(50))).length, 40);
  assert.equal(core.cleanName(undefined), '');
  const text = serialize(themeWith({}, { name: 'Line\nbreak\nend' }), cat);
  assert.equal(text, 'q2theme 1\nname Linebreakend\nend\n');
});

test('an empty name writes no name line', () => {
  assert.equal(serialize(themeWith({}, { name: ' \n ' }), cat), 'q2theme 1\nend\n');
});

test('a file without the header is refused', () => {
  for (const text of ['', 'hello\n', 'end\n', 'q2theme 2\nend\n', ' q2theme 1\nend\n', 'name x\nq2theme 1\nend\n']) {
    const parsed = parse(text, cat);
    assert.equal(parsed.ok, false, text);
    assert.match(parsed.error, /does not look like a Q2 theme/);
  }
});

test('a file without the final end line is refused as cut short', () => {
  for (const text of ['q2theme 1\n', 'q2theme 1', 'q2theme 1\nname x\n', 'q2theme 1\nend\nname x\n', 'q2theme 1\nen']) {
    const parsed = parse(text, cat);
    assert.equal(parsed.ok, false, text);
    assert.match(parsed.error, /cut short/);
  }
});

test('CRLF files and a BOM are accepted', () => {
  const parsed = parse('﻿q2theme 1\r\nname Win\r\npage home_page\r\nhide btn_folder\r\nend\r\n', cat);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ignored, 0);
  assert.equal(parsed.theme.name, 'Win');
  assert.deepEqual(parsed.theme.rules.home_page.btn_folder, { hide: true });
});

test('unknown lines, pages and items are ignored and counted', () => {
  const parsed = parse(body(
    'futureline 1 2 3',
    'page playing_page', 'hide img_fav', 'hide no_such_item', 'glow img_fav 3',
    'page no_such_page', 'hide img_fav', 'tint img_fav #ffffff',
    'page home_page', 'hide btn_folder',
  ), cat);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ignored, 6);
  assert.deepEqual(parsed.theme.rules, {
    playing_page: { img_fav: { hide: true } },
    home_page: { btn_folder: { hide: true } },
  });
});

test('a page named after a built-in object is an unknown page, not a crash', () => {
  for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const parsed = parse(body(`page ${name}`, 'hide img_fav', 'tint img_fav #ffffff'), cat);
    assert.equal(parsed.ok, true, name);
    assert.equal(parsed.ignored, 3, name);
    assert.deepEqual(parsed.theme.rules, {}, name);
    assert.equal(parse(body(`page ${name}`), cat).ignored, 1, `${name} with no rules`);
    assert.equal(core.findElement(cat, name, 'img_fav'), null, name);
  }
});

test('a malformed page line ends the page before it', () => {
  for (const line of ['page future_page extra', 'page', 'page ']) {
    const parsed = parse(body('page playing_page', line, 'hide img_fav', 'page home_page', 'hide btn_folder'), cat);
    assert.equal(parsed.ok, true, line);
    assert.equal(parsed.ignored, 2, line);
    assert.deepEqual(parsed.theme.rules, { home_page: { btn_folder: { hide: true } } }, line);
  }
});

test('rules outside what the catalogue allows are ignored and counted', () => {
  const parsed = parse(body(
    'hide img_fav',
    'accent red',
    'page playing_page', 'move slide_indicator1 0 0', 'tint img_cover #ffffff', 'size slide_indicator1 50 50',
    'tint scrlabel_title red', 'move img_cover 1', 'move img_cover a b',
    'page saverscreen_page', 'move clock_time 0 0',
  ), cat);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ignored, 9);
  assert.deepEqual(parsed.theme.rules, {});
  assert.equal(parsed.theme.accent, null);
});

test('the same id on two screens stays separate', () => {
  const parsed = parse(body('page saverscreen_page', 'tint scrlabel_title #112233'), cat);
  assert.deepEqual(parsed.theme.rules, { saverscreen_page: { scrlabel_title: { tint: '#112233' } } });
});

test('the 16 KB limit: over it is refused, at it is read', () => {
  const frame = body('name x').length;
  const fill = '#'.repeat(core.MAX_BYTES - frame);
  const exact = body('name x', fill);
  assert.equal(core.byteLength(exact), core.MAX_BYTES + 1);
  const atLimit = body('name x', fill.slice(1));
  assert.equal(core.byteLength(atLimit), core.MAX_BYTES);
  assert.equal(parse(atLimit, cat).ok, true);
  const over = parse(exact, cat);
  assert.equal(over.ok, false);
  assert.match(over.error, /16 KB/);
});

test('the limit counts bytes, not characters', () => {
  const text = body('name x', 'é'.repeat(core.MAX_BYTES / 2));
  assert.ok(text.length <= core.MAX_BYTES);
  assert.equal(parse(text, cat).ok, false);
});

test('the largest possible theme fits the limit', () => {
  const rules = {};
  for (const [page, { elements }] of Object.entries(cat.pages)) {
    rules[page] = {};
    for (const item of elements) {
      rules[page][item.id] = { hide: item.kind !== 'row', move: [1, 1], size: [41, 41], tint: '#123456' };
    }
  }
  const text = serialize(themeWith(rules, { name: '\u{1F3B5}'.repeat(50), accent: '#123456' }), cat);
  assert.ok(core.byteLength(text) < core.MAX_BYTES, `${core.byteLength(text)} bytes`);
  assert.equal(parse(text, cat).ok, true);
});

test('one Home row always stays', () => {
  const home = cat.pages.home_page.elements;
  const rules = { home_page: Object.fromEntries(home.map((row) => [row.id, { hide: true }])) };
  const clean = normalize(themeWith(rules), cat);
  assert.equal(Object.keys(clean.rules.home_page).length, home.length - 1);
  assert.equal(clean.rules.home_page[home[0].id], undefined);
  assert.equal(core.canHide(clean, cat, 'home_page', home[0].id), false);
  assert.equal(core.canHide(clean, cat, 'home_page', home[1].id), true);
  assert.equal(core.canHide(emptyTheme(), cat, 'home_page', home[0].id), true);
  assert.equal(core.canHide(emptyTheme(), cat, 'playing_page', 'img_cover'), true);
});

test('the Shortcut row is not on every Q2, so it cannot be the row that stays', () => {
  const home = cat.pages.home_page.elements;
  const allBut = (...kept) => Object.fromEntries(home.filter((row) => !kept.includes(row.id)).map((row) => [row.id, { hide: true }]));
  const shortcutOnly = normalize(themeWith({ home_page: allBut(core.OPTIONAL_ROW) }), cat);
  assert.equal(shortcutOnly.rules.home_page[home[0].id], undefined, 'the first main row comes back');
  assert.deepEqual(shortcutOnly.rules.home_page.btn_settings, { hide: true });
  const twoLeft = normalize(themeWith({ home_page: allBut(core.OPTIONAL_ROW, 'btn_settings') }), cat);
  assert.equal(core.canHide(twoLeft, cat, 'home_page', 'btn_settings'), false);
  assert.equal(core.canHide(twoLeft, cat, 'home_page', core.OPTIONAL_ROW), true);
  assert.equal(core.canHide(themeWith({ home_page: allBut('btn_settings') }), cat, 'home_page', 'btn_settings'), false);
});

test('changes names what differs between two themes', () => {
  const before = normalize(themeWith({ playing_page: { img_fav: { hide: true } } }, { name: 'A', accent: '#123456' }), cat);
  const after = normalize(themeWith({ playing_page: { img_cover: { hide: true } }, system_bar: { img_wifi: { hide: true } } }, { name: 'A', accent: '#654321' }), cat);
  assert.deepEqual(core.changes(before, after, cat), {
    name: false,
    accent: true,
    bg: false,
    battery: false,
    home: false,
    items: [
      { page: 'playing_page', id: 'img_cover' },
      { page: 'playing_page', id: 'img_fav' },
      { page: 'system_bar', id: 'img_wifi' },
    ],
  });
  assert.deepEqual(core.changes(before, before, cat), { name: false, accent: false, bg: false, battery: false, home: false, items: [] });
});

test('a battery choice is one line, and anything else is no choice', () => {
  for (const mode of core.BATTERY_MODES) {
    const theme = { ...emptyTheme(), battery: mode };
    assert.equal(serialize(theme, cat), body(`battery ${mode}`));
    roundTrip(theme);
  }
  assert.equal(normalize({ ...emptyTheme(), battery: 'full' }, cat).battery, null);
  const parsed = parse(body('battery full', 'battery percent extra'), cat);
  assert.equal(parsed.ignored, 2);
  assert.equal(parsed.theme.battery, null);
  assert.equal(core.changes(emptyTheme(), { ...emptyTheme(), battery: 'percent' }, cat).battery, true);
});

test('text and icons take any size in their box, and the art stays square', () => {
  const title = el('playing_page', 'scrlabel_title');
  const heart = el('playing_page', 'img_fav');
  const art = el('playing_page', 'img_cover');
  assert.deepEqual(core.clampBox(title, 120, 30), [120, 30]);
  assert.deepEqual(core.clampBox(title, 1, 1), [12, 12]);
  assert.deepEqual(core.clampBox(title, 999, 999), [375, 186]);
  assert.deepEqual(core.clampBox(heart, 1, 1), [16, 16]);
  assert.deepEqual(core.clampBox(art, 100, 150), [100, 100]);
  assert.equal(core.isSquare(art), true);
  assert.equal(core.isSquare(heart), false);
  assert.deepEqual(core.clampBox(el('playing_page', 'slider_play'), 1, 1), [40, 40]);
});

test('sizes, text sizes and words each make a line and read back', () => {
  const theme = themeWith({
    playing_page: { scrlabel_title: { size: [120, 30], font: 30 }, img_fav: { size: [30, 30] } },
    home_page: { btn_folder: { font: 24, text: 'My Music' } },
  });
  const text = serialize(theme, cat);
  assert.match(text, /size scrlabel_title 120 30\nfont scrlabel_title 30\n/);
  assert.match(text, /font btn_folder 24\ntext btn_folder My Music\n/);
  roundTrip(theme);
});

test('a text size at its default is dropped, and out of range is pulled in', () => {
  const title = el('playing_page', 'scrlabel_title');
  assert.equal(title.font, 22);
  assert.deepEqual(normalize(themeWith({ playing_page: { scrlabel_title: { font: 22 } } }), cat).rules, {});
  const out = (font) => normalize(themeWith({ playing_page: { scrlabel_title: { font } } }), cat).rules.playing_page.scrlabel_title.font;
  assert.equal(out(2), core.FONT_MIN);
  assert.equal(out(900), core.FONT_MAX);
});

test('only items that take them keep a size, a text size or words', () => {
  const rules = { playing_page: { slide_indicator1: { size: [90, 90], font: 20, text: 'x' }, img_fav: { font: 20 } } };
  assert.deepEqual(normalize(themeWith(rules), cat).rules, {});
  const parsed = parse(body('page playing_page', 'font img_fav 20', 'size slide_indicator1 90 90', 'text scrlabel_title Hi', 'font scrlabel_title x'), cat);
  assert.equal(parsed.ignored, 4);
  assert.deepEqual(parsed.theme.rules, {});
});

test('a row keeps its words to one short line', () => {
  assert.equal(core.cleanText('  My   Music\n'), 'My Music');
  assert.equal(core.cleanText('x'.repeat(60)).length, core.TEXT_MAX);
  assert.ok(new TextEncoder().encode(core.cleanText('音'.repeat(30))).length <= 40);
  assert.equal(core.cleanText('a\u0007b'), 'ab');
  const parsed = parse(body('page home_page', 'text btn_folder A  B'), cat);
  assert.equal(parsed.theme.rules.home_page.btn_folder.text, 'A B');
});

test('a background is one line, and a line for a newer firmware is skipped', () => {
  const theme = { ...emptyTheme(), bg: '#101820' };
  assert.equal(serialize(theme, cat), body('color bg #101820'));
  roundTrip(theme);
  assert.equal(parse(body('color bg #AABBCC'), cat).theme.bg, '#aabbcc');
  const parsed = parse(body('color text #ffffff', 'color bg 101820', 'color bg #1018'), cat);
  assert.equal(parsed.ignored, 3);
  assert.equal(parsed.theme.bg, null);
  assert.equal(core.changes(emptyTheme(), theme, cat).bg, true);
});

test('a background picks its text as the firmware does', () => {
  assert.deepEqual(core.palette('#102030'), { paper: [16, 32, 48], ink: [255, 255, 255], light: false });
  assert.deepEqual(core.palette('#f0d8b0'), { paper: [240, 216, 176], ink: [22, 22, 22], light: true });
  assert.equal(core.palette('#7a7a7a').light, false);
  assert.equal(core.palette('#7e7e7e').light, true);
});

test('neutral colours map between the paper and the ink, per channel, and hues stay', () => {
  const page = core.palette('#102030');
  assert.equal(core.flip('#000000', page), '#102030');
  assert.equal(core.flip('#ffffff', page), '#ffffff');
  assert.equal(core.flip('#808080', page), '#878f97'); // 16 + 128 * 239 / 255, and so on
  assert.equal(core.flip('#ff9f0a', page), '#ff9f0a');
  assert.equal(core.flip('#000000', core.palette('#f0d8b0')), '#f0d8b0');
  assert.equal(core.flip('#ffffff', core.palette('#f0d8b0')), '#161616');
});

test('backgrounds warn when their text or the accent would be hard to see, and never stop a save', () => {
  assert.deepEqual(core.bgWarnings(null), []);
  assert.deepEqual(core.bgWarnings('#101820'), []);
  assert.deepEqual(core.bgWarnings('#f0d8b0'), []);
  assert.deepEqual(core.bgWarnings('#808080'), [], 'dark text clears 4.5 here');
  assert.match(core.bgWarnings('#7c7c7c')[0], /hard to read/); // the worst the choice of text allows
  assert.match(core.bgWarnings('#2a6ad8', '#2a6ad8').join(' '), /close to the background/);
  assert.equal(core.warnings({ ...emptyTheme(), bg: '#7c7c7c' }, cat).length, 1);
  assert.equal(core.tintIsLow('#111111', '#f0d8b0'), false);
  assert.equal(core.tintIsLow('#ffffff', '#f0d8b0'), true);
  const tinted = themeWith({ playing_page: { scrlabel_title: { tint: '#eeeeee' } } }, { bg: '#f0d8b0' });
  assert.match(core.warnings(tinted, cat)[0].text, /this background/);
});

test('an author is one line that round-trips, and the firmware skips it', () => {
  const theme = { ...emptyTheme(), name: 'Night', author: 'Sam' };
  assert.equal(serialize(theme, cat), body('name Night', 'author Sam'));
  roundTrip(theme);
});

test('the library index keeps only what fits, whatever the internet sends', () => {
  const good = { file: 'night-by-sam.txt', name: 'Night', author: 'Sam', accent: '#123456', bg: '#102030' };
  assert.deepEqual(core.libraryEntries({ themes: [good] }), [good]);
  for (const bad of [null, 'text', {}, { name: 'x' }, { file: 'a.txt' }, { file: '../a.txt', name: 'x' }, { file: 'a/b.txt', name: 'x' },
    { file: 'A.txt', name: 'x' }, { file: 'a.jpg', name: 'x' }, { file: '.txt', name: 'x' }, { file: 'a.txt\n', name: 'x' }]) {
    assert.deepEqual(core.libraryEntries({ themes: [bad] }), [], JSON.stringify(bad));
  }
  for (const index of [null, 'x', 5, {}, { themes: 'x' }]) assert.deepEqual(core.libraryEntries(index), []);
  const odd = core.libraryEntries({ themes: [{ file: 'a.txt', name: 'x<b>\u0007', author: 7, accent: 'red;', bg: 'url(x)' }] })[0];
  assert.deepEqual(odd, { file: 'a.txt', name: 'x<b>', author: '7', accent: null, bg: null });
  assert.equal(core.libraryEntries({ themes: [good, good] }).length, 1);
});

test('the library search wants every word, in the name or the author', () => {
  const entries = [{ name: 'Midnight Blue', author: 'Sam' }, { name: 'Paper', author: 'Lee' }];
  assert.equal(core.librarySearch(entries, '').length, 2);
  assert.deepEqual(core.librarySearch(entries, 'sam blue').map((e) => e.name), ['Midnight Blue']);
  assert.deepEqual(core.librarySearch(entries, 'nothing'), []);
});

test('a shared theme gets a plain file name and a link GitHub fills in', () => {
  assert.equal(core.shareFile('Midnight Blue!', 'Sam L.'), 'midnight-blue-by-sam-l.txt');
  assert.equal(core.shareFile('Café', ''), 'cafe.txt');
  assert.equal(core.shareFile('日本', ''), 'theme.txt');
  assert.ok(core.shareFile('x'.repeat(200), 'y').length <= 64);
  const url = new URL(core.shareUrl('q2theme 1\nname A & B\nend\n', 'a.txt'));
  assert.equal(url.origin, 'https://github.com');
  assert.equal(url.searchParams.get('filename'), 'a.txt');
  assert.equal(url.searchParams.get('value'), 'q2theme 1\nname A & B\nend\n');
  assert.equal(core.shareUrl('x'.repeat(3000), 'a.txt'), null);
});

test('the diff lists only real changes, in catalogue order', () => {
  const changes = core.diff(themeWith({
    system_bar: { label_eq: { hide: true } },
    playing_page: { img_fav: { hide: true }, img_cover: { tint: '#ffffff', move: [16, 2], hide: true } },
    no_such_page: { nothing: { hide: true } },
  }), cat);
  assert.deepEqual(changes, [
    { page: 'playing_page', id: 'img_cover', action: 'hide', value: true },
    { page: 'playing_page', id: 'img_fav', action: 'hide', value: true },
    { page: 'system_bar', id: 'label_eq', action: 'hide', value: true },
  ]);
});

test('hex values are normalised', () => {
  assert.equal(core.normHex('#ABCDEF'), '#abcdef');
  assert.equal(core.normHex('abc'), '#aabbcc');
  assert.equal(core.normHex(' 123456 '), '#123456');
  for (const bad of ['', '#12', '#12345g', 'red', null, undefined]) assert.equal(core.normHex(bad), null);
});

test('contrast matches the WCAG figures', () => {
  assert.ok(Math.abs(core.contrast('#000000', '#ffffff') - 21) < 1e-9);
  assert.equal(core.contrast('#123456', '#123456'), 1);
  assert.ok(Math.abs(core.contrast('#777777', '#ffffff') - 4.48) < 0.01);
  assert.equal(core.contrast('#000000', '#ffffff'), core.contrast('#ffffff', '#000000'));
});

test('accent warnings: 3:1 against white and, for the bar colour, against the track', () => {
  assert.deepEqual(core.accentWarnings(null), []);
  assert.deepEqual(core.accentWarnings('#e8123f'), []);
  assert.equal(core.accentWarnings('#ffff00').length, 1, 'too light for white text');
  assert.match(core.accentWarnings('#ffff00')[0], /White text/);
  assert.equal(core.accentWarnings('#202020').length, 1, 'too dark for the track');
  assert.match(core.accentWarnings('#202020')[0], /progress bar/);
  assert.doesNotMatch(core.accentWarnings('#202020')[0], /track/);
});

test('no firmware preset warns, and the bar warning matches the colour drawn', () => {
  for (const preset of core.PRESETS) {
    assert.deepEqual(core.accentWarnings(preset.hex), [], preset.name);
    assert.ok(core.contrast(core.progressFill(preset.hex), '#1c1c1c') >= 3, preset.name);
  }
  // Under 3:1 as picked, but the 12% lift the bar is drawn with brings it over.
  assert.ok(core.contrast('#5f5f5f', '#1c1c1c') < 3);
  assert.deepEqual(core.accentWarnings('#5f5f5f'), []);
});

test('tint warnings use 4.5:1 against black', () => {
  assert.equal(core.tintIsLow('#ffffff'), false);
  assert.equal(core.tintIsLow('#757575'), false);
  assert.equal(core.tintIsLow('#606060'), true);
  assert.equal(core.tintIsLow('#000000'), true);
});

test('warnings collect hidden items, dark tints and the accent, and never stop a save', () => {
  const theme = themeWith({
    playing_page: {
      img_fav: { hide: true },
      scrlabel_title: { tint: '#111111' },
      scrlabel_artist: { tint: '#111111', hide: true },
      label_ipod_pos: { hide: true },
    },
  }, { accent: '#202020' });
  const found = core.warnings(theme, cat);
  assert.deepEqual(found.map((w) => w.kind), ['accent', 'tint', 'hidden']);
  assert.equal(found[1].id, 'scrlabel_title');
  assert.equal(found[2].id, 'img_fav');
  assert.equal(found[2].text, el('playing_page', 'img_fav').warn);
  assert.equal(parse(serialize(theme, cat), cat).ok, true);
});

test('the progress fill follows the firmware', () => {
  assert.equal(core.progressFill(null), '#eeeeec');
  assert.equal(core.progressFill('#424242'), '#6e6e6e');
  assert.equal(core.progressFill('#e8123f'), '#eb2f56');
  assert.equal(core.progressFill('#000000'), '#1f1f1f');
});

test('all eight firmware presets are offered', () => {
  assert.deepEqual(core.PRESETS.map((p) => p.hex), [
    '#424242', '#e8123f', '#13838d', '#8c732c', '#2a6ad8', '#c45400', '#903868', '#647f34',
  ]);
});

test('the catalogue shape this app relies on holds', () => {
  assert.deepEqual(Object.keys(cat.pages), ['playing_page', 'home_page', 'saverscreen_page', 'system_bar']);
  for (const page of Object.values(cat.pages)) {
    for (const item of page.elements) {
      if (core.allows(item, 'move')) {
        assert.ok(item.box, `${item.id} needs a box`);
        assert.deepEqual(core.clampMove(item, item.x, item.y), [item.x, item.y], `${item.id} starts in its box`);
      }
    }
  }
});

test('Home\'s sizes and right panel round trip', () => {
  const theme = {
    ...emptyTheme(),
    home: { rows: 46, top: 40, cards: 150 },
    art: { items: [{ id: 'card1', kind: 'jpg' }, { id: 'card2', kind: 'gif' }, { id: 'card3', kind: 'jpg' }], seconds: 20 },
  };
  roundTrip(theme);
  assert.equal(serialize(theme, cat), body('home rows 46', 'home top 40', 'home cards 150', 'homeart 20 jgj'));
});

test('Home\'s sizes stay in range, and its defaults aren\'t written', () => {
  assert.deepEqual(normalize({ ...emptyTheme(), home: { rows: 1, top: 999, cards: 9999 } }, cat).home, { rows: 28, top: 120, cards: 220 });
  assert.deepEqual(normalize({ ...emptyTheme(), home: { rows: 39, top: 8, cards: 190 } }, cat).home, {});
  assert.deepEqual(normalize({ ...emptyTheme(), home: { top: 0 } }, cat).home, { top: 0 });
  assert.deepEqual(normalize({ ...emptyTheme(), home: { rows: 'x', top: null } }, cat).home, {});
});

test('The right panel\'s pictures stay in range', () => {
  const items = Array.from({ length: 30 }, (_, index) => ({ id: `p${index}`, kind: 'jpg' }));
  const art = normalize({ ...emptyTheme(), art: { items: [...items, items[0]], seconds: 1 } }, cat).art;
  assert.equal(art.items.length, core.ART.max);
  assert.equal(art.seconds, core.ART.turnMin);
  assert.equal(normalize({ ...emptyTheme(), art: { items: [], seconds: 5 } }, cat).art, null);
  assert.equal(normalize({ ...emptyTheme(), art: { items: [{ id: 'a', kind: 'png' }], seconds: 5 } }, cat).art, null);
  assert.equal(normalize({ ...emptyTheme(), art: { items: [{ id: 'a', kind: 'gif' }] } }, cat).art.seconds, core.ART.turn);
});

test('Home lines the firmware would skip are skipped here too', () => {
  const bad = ['home size 3', 'home rows x', 'home rows', 'homeart 5', 'homeart x j', 'homeart 5 jx', 'homeart 5 j g', `homeart 5 ${'j'.repeat(25)}`, 'homeart 5 ../a'];
  const parsed = parse(body(...bad), cat);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ignored, bad.length);
  assert.equal(serialize(parsed.theme, cat), body());
});

test('A theme\'s pictures stay out of the library', () => {
  const theme = { ...emptyTheme(), name: 'Mine', home: { rows: 46 }, art: { items: [{ id: 'a', kind: 'gif' }], seconds: 9 } };
  assert.equal(serialize(core.shareable(theme), cat), body('name Mine', 'home rows 46'));
});

test('Home\'s fit matches the firmware', () => {
  assert.equal(core.rowsShown(39, 8, 8), 7);
  assert.equal(core.rowsShown(34, 8, 8), 8);
  assert.equal(core.rowsShown(50, 40, 8), 4);
  assert.equal(core.rowsShown(64, 120, 8), 2);
  assert.equal(core.rowsShown(64, 120, 1), 1);
  assert.deepEqual(core.cardBox(undefined, 0), { size: 190, x: 0, y: 23 });
  assert.deepEqual(core.cardBox(120, 0), { size: 120, x: 35, y: 56 });
  assert.deepEqual(core.cardBox(undefined, 100), { size: 124, x: 33, y: 104 });
});

test('A GIF keeps its time when it loses frames', () => {
  const frames = Array.from({ length: 10 }, (_, index) => ({ index, delay: 100 }));
  assert.equal(core.thinFrames(frames, 10, 10, 1e6), frames);
  const kept = core.thinFrames(frames, 100, 100, 4 * 100 * 100 * 4);
  assert.deepEqual(kept.map((frame) => frame.index), [0, 2, 5, 7]);
  assert.equal(kept.reduce((sum, frame) => sum + frame.delay, 0), 1000);
  assert.equal(core.thinFrames(frames, 300, 300, 10).length, 1);
});

// The format's own decoder, to hold the encoder to it.
function readGif(bytes) {
  const word = (at) => bytes[at] | bytes[at + 1] << 8;
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 6)), 'GIF89a');
  const [width, height] = [word(6), word(8)];
  const palette = bytes.subarray(13, 13 + 768);
  const frames = [];
  let at = 13 + 768;
  let control = null;
  while (bytes[at] !== 0x3b) {
    if (bytes[at] === 0x21) {
      if (bytes[at + 1] === 0xf9) control = { blank: bytes[at + 3] & 1 ? bytes[at + 6] : -1, delay: word(at + 4) };
      at += 2;
      while (bytes[at]) at += bytes[at] + 1;
      at += 1;
      continue;
    }
    assert.equal(bytes[at], 0x2c);
    const minimum = bytes[at + 10];
    at += 11;
    const data = [];
    for (; bytes[at]; at += bytes[at] + 1) data.push(...bytes.subarray(at + 1, at + 1 + bytes[at]));
    at += 1;
    const [clear, stop] = [1 << minimum, (1 << minimum) + 1];
    const out = [];
    let table = [];
    let size = minimum + 1;
    let last = null;
    let [held, bits, read] = [0, 0, 0];
    const reset = () => {
      table = Array.from({ length: stop + 1 }, (_, code) => [code]);
      size = minimum + 1;
      last = null;
    };
    reset();
    for (;;) {
      while (bits < size) {
        held += data[read] * 2 ** bits;
        read += 1;
        bits += 8;
      }
      const code = held % 2 ** size;
      held = Math.floor(held / 2 ** size);
      bits -= size;
      if (code === clear) {
        reset();
        continue;
      }
      if (code === stop) break;
      const entry = code < table.length ? table[code] : [...last, last[0]];
      out.push(...entry);
      if (last && table.length < 4096) table.push([...last, entry[0]]);
      if (table.length === 1 << size && size < 12) size += 1;
      last = entry;
    }
    frames.push({ ...control, indices: out });
  }
  return { width, height, palette, frames };
}

test('A GIF decodes back to its frames', () => {
  const [w, h] = [40, 30];
  const frame = (paint) => {
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) rgba.set(paint(x, y), (y * w + x) * 4);
    }
    return rgba;
  };
  const frames = [
    { rgba: frame(() => [255, 0, 0, 255]), delay: 100 },
    { rgba: frame((x) => (x < 20 ? [0, 255, 0, 255] : [0, 0, 255, 255])), delay: 250 },
    { rgba: frame((x, y) => [x * 6, y * 8, 128, 255]), delay: 5 },
  ];
  const gif = readGif(core.encodeGif(w, h, frames));
  assert.deepEqual([gif.width, gif.height, gif.frames.length], [w, h, 3]);
  assert.deepEqual(gif.frames.map((item) => item.delay), [10, 25, 2]);
  assert.ok(gif.frames.every((item) => item.blank === -1 && item.indices.length === w * h));
  gif.frames.forEach((item, index) => {
    item.indices.forEach((colour, at) => {
      for (let channel = 0; channel < 3; channel += 1) {
        const away = Math.abs(gif.palette[colour * 3 + channel] - frames[index].rgba[at * 4 + channel]);
        assert.ok(away <= 24, `frame ${index} pixel ${at}: ${away}`);
      }
    });
  });
});

test('A GIF keeps transparency, and survives more codes than the table holds', () => {
  const [w, h] = [200, 200];
  const rgba = new Uint8ClampedArray(w * h * 4);
  let seed = 7;
  for (let at = 0; at < rgba.length; at += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      seed = seed * 1103515245 + 12345 & 0x7fffffff;
      rgba[at + channel] = seed >> 16;
    }
    rgba[at + 3] = at % 40 ? 255 : 0;
  }
  const gif = readGif(core.encodeGif(w, h, [{ rgba, delay: 100 }]));
  const [frame] = gif.frames;
  assert.equal(frame.blank, 255);
  assert.equal(frame.indices.length, w * h);
  frame.indices.forEach((colour, at) => assert.equal(colour === 255, !(at % 10), `pixel ${at}`));
});

test('A blank GIF still encodes', () => {
  const rgba = new Uint8ClampedArray(4 * 4 * 4);
  const gif = readGif(core.encodeGif(4, 4, [{ rgba, delay: 100 }]));
  assert.ok(gif.frames[0].indices.every((colour) => colour === 255));
});
