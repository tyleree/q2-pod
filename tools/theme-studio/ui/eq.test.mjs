// node --test ui/eq.test.mjs
// test/theme.py runs this logic and the firmware's patch/peq.c on the same files and compares them.
// These are the cases a person can check by hand.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import eq from './eq.js';

const near = (actual, expected, within = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= within, `${actual} is not ${expected}`);
const band = (extra) => ({ ...eq.newBand(), ...extra });
const presetOf = (bands, extra = {}) => ({ name: '', auto: true, preamp: 0, balance: 0, bands, ...extra });
const read = (text) => {
  const parsed = eq.parse(text);
  assert.equal(parsed.ok, true, parsed.error);
  return parsed.preset;
};

test('every built-in preset is a file the Q2 can import, under a name the card can hold', () => {
  const { credit, presets } = JSON.parse(readFileSync(new URL('./presets.json', import.meta.url), 'utf8'));
  assert.match(credit, /AutoEq/);
  assert.ok(presets.length > 8000);
  for (const { name, source, text } of presets) {
    const preset = read(text);
    assert.equal(preset.auto, false, name);
    assert.ok(preset.bands.length > 0 && preset.bands.length <= eq.MAX_BANDS, name);
    assert.deepEqual(read(eq.serialize(eq.normalize(preset))), eq.normalize(preset), `${name}, ${source}`);
    assert.match(eq.fileName(name), /^[^.\\/:*?"<>|][^\\/:*?"<>|]*[^. ]\.txt$/, name);
  }
});

test('the short list before a search is 25 clean names that fit their own preamps', () => {
  const { presets } = JSON.parse(readFileSync(new URL('./presets.json', import.meta.url), 'utf8'));
  const top = presets.filter((p) => p.top);
  assert.equal(top.length, 25);
  assert.equal(new Set(top.map((p) => p.name)).size, 25);
  for (const { name, text } of top) {
    assert.equal(eq.fileName(name), `${name}.txt`, name);
    assert.deepEqual(eq.warnings(read(text), 48000), [], name);
  }
});

test('a new preset is the Q2 Reset: ten flat bands', () => {
  const preset = eq.newPreset();
  assert.deepEqual(preset.bands.map((b) => b.freq), [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]);
  assert.ok(preset.bands.every((b) => b.gain === 0 && b.q === 1.41 && b.type === 'PK'));
  assert.equal(eq.autoPreamp(preset), 0);
});

test('a typical AutoEQ file reads as written', () => {
  const preset = read([
    'Preamp: -6.4 dB',
    'Filter 1: ON LSC Fc 105 Hz Gain 5.5 dB Q 0.70',
    'Filter 2: ON PK Fc 3200 Hz Gain -2.1 dB Q 1.41',
    'Filter 3: OFF HSC Fc 10000 Hz Gain 3 dB Q 0.7',
    '',
  ].join('\r\n'));
  assert.equal(preset.auto, false);
  assert.equal(preset.preamp, -6.4);
  assert.deepEqual(preset.bands.map((b) => [b.on, b.type, b.freq, b.gain, b.q]), [
    [true, 'LSC', 105, 5.5, 0.7], [true, 'PK', 3200, -2.1, 1.41], [false, 'HSC', 10000, 3, 0.7],
  ]);
});

test('no Preamp line means Auto', () => {
  assert.equal(read('Filter: ON PK Fc 1000 Hz Gain 3 dB Q 1\n').auto, true);
});

test('Channel sections and side preamps become bands and balance', () => {
  const preset = read('Channel: L\nPreamp: -2 dB\nFilter 1: ON PK Fc 100 Hz Gain 1 dB Q 1\n'
    + 'Channel: R\nPreamp: -5 dB\nFilter 2: ON PK Fc 200 Hz Gain 1 dB Q 1\nChannel: all\nFilter 3: ON PK Fc 300 Hz Gain 1 dB Q 1\n');
  assert.deepEqual(preset.bands.map((b) => b.channel), ['L', 'R', 'all']);
  assert.equal(preset.preamp, -2);
  assert.equal(preset.balance, -3);
});

test('the same words refuse what the Q2 refuses', () => {
  const refused = [
    ['Filter 1: ON BP Fc 100 Hz Gain 1 dB Q 1', 'Line 1: unsupported filter type'],
    ['Filter 1: ON PK Fc 100 Hz Gain 1 dB', 'Line 1: peaking filter requires Q'],
    ['Filter 1: ON PK Fc 10 Hz Gain 1 dB Q 1', 'Line 1: range: 20..20000 Hz, -24..24 dB, Q 0.1..10'],
    ['\nInclude: other.txt', 'Line 2: unsupported command'],
    ['Preamp: 30 dB', 'Line 1: preamp outside -60..24 dB or invalid number'],
    ['Channel: X', 'Line 1: only channels L, R and all are supported'],
  ];
  for (const [text, error] of refused) assert.equal(eq.parse(text).error, error);
  assert.equal(eq.parse('#'.repeat(16385)).error, 'Line 1: file exceeds 16384 bytes');
  assert.equal(eq.parse('#'.repeat(513)).error, 'Line 1: line exceeds 512 bytes');
  const many = Array.from({ length: 31 }, (_, i) => `Filter ${i + 1}: ON PK Fc 100 Hz Gain 1 dB Q 1`).join('\n');
  assert.equal(eq.parse(many).error, 'Line 31: more than 30 bands');
});

test('blank slots are skipped, as APO and exporters write them', () => {
  assert.equal(read('Filter 1: OFF PK Fc 0 Hz Gain 0 dB Q 0\nFilter 2: ON None\n').bands.length, 0);
});

test('an exponent with no digits reads as the Q2 reads it', () => {
  assert.equal(read('Filter: ON PK Fc 355E Hz Gain 1e+ dB Q 1.5e\n').bands[0].freq, 355);
  assert.equal(eq.parse('Filter: ON PK Fc .e5 Hz Gain 1 dB Q 1\n').error, 'Line 1: invalid frequency or gain number');
});

test('a comma is a decimal mark and # ends a line', () => {
  const [only] = read('Filter 1: ON PK Fc 1000,5 Hz Gain 2,5 dB Q 1 # note\n').bands;
  assert.equal(only.freq, 1000.5);
  assert.equal(only.gain, 2.5);
});

test('LS and HS with a Q move to the centre the Q2 uses; LSC and HSC stay', () => {
  near(read('Filter: ON LSC Fc 100 Hz Gain 6 dB Q 0.7\n').bands[0].freq, 100);
  assert.notEqual(read('Filter: ON LS Fc 100 Hz Gain 6 dB Q 0.7\n').bands[0].freq, 100);
});

test('what is written reads back the same', () => {
  const preset = eq.normalize(presetOf([
    band({ type: 'LSC', freq: 105, gain: 5.5, q: 0.7 }),
    band({ channel: 'L', freq: 3200, gain: -2.1, q: 1.41 }),
    band({ channel: 'R', freq: 4000, gain: 1, q: 3 }),
    band({ on: false, freq: 9000, gain: 2, q: 2 }),
  ], { auto: false, preamp: -6.4 }));
  assert.deepEqual(read(eq.serialize(preset)), preset);
  assert.equal(eq.serialize(preset), [
    'Preamp: -6.4 dB',
    'Filter 1: ON LSC Fc 105 Hz Gain 5.5 dB Q 0.7',
    'Channel: L',
    'Filter 2: ON PK Fc 3200 Hz Gain -2.1 dB Q 1.41',
    'Channel: R',
    'Filter 3: ON PK Fc 4000 Hz Gain 1 dB Q 3',
    'Channel: all',
    'Filter 4: OFF PK Fc 9000 Hz Gain 2 dB Q 2',
    '',
  ].join('\n'));
});

test('balance is written as the two side preamps the Q2 reads back', () => {
  for (const balance of [3.5, -7]) {
    const preset = eq.normalize(presetOf([band({ gain: 2 })], { auto: false, preamp: -1, balance }));
    assert.deepEqual(read(eq.serialize(preset)), preset);
  }
});

test('Auto with balance saves its 48 kHz cut, and says so', () => {
  const preset = presetOf([band({ gain: 6, q: 1 })], { balance: 2 });
  const parsed = read(eq.serialize(preset));
  assert.equal(parsed.auto, false);
  near(parsed.preamp, -6, 0.01);
  assert.equal(parsed.balance, 2);
  assert.match(eq.warnings(preset, 48000).join(' '), /saves Auto as -6 dB/);
});

test('a peak filter gives its gain at its centre', () => {
  for (const gain of [6, -9, 24]) {
    near(eq.response(presetOf([band({ gain, q: 2 })]), 1000, 48000).left, gain);
  }
});

test('shelves reach their gain on their own side and leave the other alone', () => {
  const low = presetOf([band({ type: 'LSC', freq: 200, gain: 6, q: 0.7 })]);
  near(eq.response(low, 20, 48000).left, 6, 0.01);
  near(eq.response(low, 20000, 48000).left, 0, 0.01);
  near(eq.response(low, 200, 48000).left, 3, 0.01); // half its dB at the centre
  const high = presetOf([band({ type: 'HSC', freq: 2000, gain: -6, q: 0.7 })]);
  near(eq.response(high, 20, 48000).left, 0, 0.01);
  near(eq.response(high, 15000, 48000).left, -6, 0.05);
});

test('a side band changes only that side', () => {
  const { left, right } = eq.response(presetOf([band({ channel: 'R', gain: 6, q: 1 })]), 1000, 48000);
  near(left, 0);
  near(right, 6);
});

test('off, zero-gain and past-Nyquist bands do nothing, as on the Q2', () => {
  for (const item of [band({ on: false, gain: 6 }), band({ gain: 0 }), band({ freq: 20000, gain: 6 })]) {
    near(eq.response(presetOf([item]), 1000, 32000).left, 0, item.freq === 20000 ? 0 : 1e-12);
  }
});

test('Auto cuts the loudest boost and never boosts', () => {
  near(eq.autoPreamp(presetOf([band({ gain: 6, q: 1 })])), -6, 1e-9);
  assert.equal(eq.autoPreamp(presetOf([band({ gain: -6, q: 1 })])), 0);
  const { at } = eq.peak(presetOf([band({ gain: 6, q: 1 })]), 48000);
  assert.equal(at, 1000);
});

test('a hand preamp that leaves a peak over full scale is flagged', () => {
  const loud = presetOf([band({ gain: 6, q: 1 })], { auto: false, preamp: -2 });
  assert.match(eq.warnings(loud, 48000).join(' '), /Peaks reach 4 dB over full scale/);
  assert.deepEqual(eq.warnings({ ...loud, preamp: -6 }, 48000), []);
  assert.deepEqual(eq.warnings({ ...loud, auto: true }, 48000), []);
});

test('a low shelf\'s boost under 20 Hz is no reason to warn, though Auto still counts it', () => {
  const shelf = presetOf([band({ type: 'LSC', freq: 100, gain: 6, q: 0.7 }), band({ freq: 25, gain: -6, q: 1 })],
    { auto: false, preamp: -5 });
  assert.deepEqual(eq.warnings(shelf, 48000), []);
  assert.ok(eq.autoPreamp(shelf) < -5.9);
  assert.ok(eq.peak(shelf, 48000, 20).at >= 20);
});

test('a flat preset says so', () => {
  assert.match(eq.warnings(eq.newPreset(), 48000).join(' '), /No band changes/);
});

test('names fit the card and the Q2', () => {
  assert.equal(eq.fileName('HD 600'), 'HD 600.txt');
  assert.equal(eq.fileName('a/b:c?'), 'abc.txt');
  assert.equal(eq.fileName(' ...trailing. '), 'trailing.txt');
  assert.equal(eq.fileName(''), 'My EQ.txt');
  assert.equal(eq.fileName('con'), 'EQ con.txt');
  assert.ok(new TextEncoder().encode(eq.cleanName('é'.repeat(50))).length <= 60);
  assert.equal(eq.nameOfFile('C:\\presets\\HD 600.txt'), 'HD 600');
});

test('normalize keeps every value in the Q2 range', () => {
  const [wild] = eq.normalize(presetOf([band({ freq: 1, gain: 99, q: 99, type: 'X', channel: 'X' })])).bands;
  assert.deepEqual(wild, { on: true, channel: 'all', type: 'PK', freq: 20, gain: 24, q: 10 });
  const big = eq.normalize(presetOf(Array.from({ length: 40 }, () => band({})), { preamp: -99, balance: 99 }));
  assert.equal(big.bands.length, eq.MAX_BANDS);
  assert.equal(big.preamp, -60);
  assert.equal(big.balance, 12);
  assert.equal(eq.normalize(presetOf([band({ freq: NaN, gain: Infinity })])).bands[0].freq, 1000);
});

test('no number in a file has an exponent or a negative zero', () => {
  const text = eq.serialize(presetOf([band({ gain: -0.0000001, q: 0.1 })], { auto: false, preamp: -0.0000001 }));
  assert.doesNotMatch(text, /\de|-0 /);
});
