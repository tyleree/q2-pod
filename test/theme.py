#!/usr/bin/env python3
"""Card themes (docs/themes.md): theme.c's parser and card sync on the host, under ASan and UBSan, the
Theme Studio catalogue against patch/theme.inc and, with BUILD, a build's pages, and the Studio's EQ
logic (ui/eq.js, which needs node) against peq.c on the same files.
Usage: python3 test/theme.py [BUILD]"""
import json
import pathlib
import random
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
EQ_PRESETS = json.loads((ROOT/'tools/theme-studio/ui/presets.json').read_text())['presets']
EQ_RATES = (44100, 96000)
EQ_POINTS = (20, 31.5, 63, 125, 250, 1000, 3150, 8000, 16000, 20000)
# One JSON line per file: what peq_parse makes of it, then its Auto and curve at each rate.
EQ_DRIVER = r'''
#include "peq.h"
#include <math.h>
#include <stdio.h>
static const int rates[] = { %s };
static const double points[] = { %s };
int main(int argc, char **argv) {
    static char text[1 << 16];
    static peq_engine e;
    for (int i = 1; i < argc; ++i) {
        FILE *f = fopen(argv[i], "rb");
        unsigned n = (unsigned)fread(text, 1, sizeof text, f);
        fclose(f);
        peq_preset p;
        peq_error error = { 0, "" };
        if (!peq_parse(text, n, &p, &error)) {
            printf("{\"ok\":false,\"line\":%%u,\"reason\":\"%%s\"}\n", error.line, error.reason);
            continue;
        }
        printf("{\"ok\":true,\"preamp\":%%.17g,\"balance\":%%.17g,\"automatic\":%%d,\"bands\":[",
               p.preamp, p.balance, p.automatic);
        for (int b = 0; b < p.count; ++b)
            printf("%%s[%%d,%%d,%%.17g,%%.17g,%%.17g]", b ? "," : "", p.bands[b].enabled, p.bands[b].type,
                   p.bands[b].frequency, p.bands[b].gain, p.bands[b].q);
        printf("],\"auto\":[");
        for (unsigned r = 0; r < sizeof rates / sizeof *rates; ++r)
            printf("%%s%%.17g", r ? "," : "", peq_auto(&p, rates[r]));
        printf("],\"curve\":[");
        for (unsigned r = 0, any = 0; r < sizeof rates / sizeof *rates; ++r) {
            peq_compile(&p, rates[r], &e);
            for (unsigned k = 0; k < sizeof points / sizeof *points; ++k) {
                double l, right;
                peq_response(&e, rates[r], points[k], &l, &right);
                printf("%%s%%.17g,%%.17g", any++ ? "," : "", 10 * log10(l), 10 * log10(right));
            }
        }
        printf("]}\n");
    }
    return 0;
}
'''
# ui/eq.js on the same files: the same answer, or the same refusal in the same words. Each preset it
# reads is written back to out, for peq_parse to read in turn.
EQ_CHECK = r'''
const eq = require(process.argv[2]);
const fs = require('fs');
const path = require('path');
const { rates, points, cases } = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const out = process.argv[4];
const close = (a, b, within, what, file) => {
  if (!(Math.abs(a - b) <= within)) throw new Error(`${file}: ${what}: ${a} here, ${b} in peq.c`);
};
for (const { file, c } of cases) {
  const js = eq.parse(fs.readFileSync(file, 'utf8'));
  if (js.ok !== c.ok) throw new Error(`${file}: ${js.ok ? 'taken here' : js.error}, ${JSON.stringify(c).slice(0, 90)} in peq.c`);
  if (!c.ok) {
    if (js.line !== c.line || js.reason !== c.reason) throw new Error(`${file}: ${js.error}, ${c.line} ${c.reason} in peq.c`);
    continue;
  }
  const p = js.preset;
  close(p.preamp, c.preamp, 1e-9, 'preamp', file);
  close(p.balance, c.balance, 1e-9, 'balance', file);
  if (p.auto !== (c.automatic === 1)) throw new Error(`${file}: auto`);
  if (p.bands.length !== c.bands.length) throw new Error(`${file}: bands`);
  p.bands.forEach((b, i) => {
    const [enabled, type, frequency, gain, q] = c.bands[i];
    const on = enabled ? { 1: 'all', 2: 'L', 3: 'R' }[enabled] : null;
    if (b.on !== !!enabled || (b.on && b.channel !== on) || eq.TYPES.indexOf(b.type) !== type) throw new Error(`${file}: band ${i}`);
    close(b.freq, frequency, 1e-9, 'frequency', file);
    close(b.gain, gain, 1e-12, 'gain', file);
    close(b.q, q, 1e-12, 'Q', file);
  });
  let at = 0;
  rates.forEach((rate, r) => {
    close(eq.autoPreamp(p, rate), c.auto[r], 1e-9, 'Auto', file);
    for (const f of points) {
      const { left, right } = eq.response(p, f, rate);
      close(left, c.curve[at++], 1e-7, `left at ${f}`, file);
      close(right, c.curve[at++], 1e-7, `right at ${f}`, file);
    }
  });
  fs.writeFileSync(path.join(out, path.basename(file)), eq.serialize(eq.normalize(p)));
}
'''
DRIVER = r'''
#include "peq.h"
#include <assert.h>
void toast(const char *text) { (void)text; }
void *read_all(const char *path, unsigned max, unsigned *size) {
    FILE *f = fopen(path, "rb");
    char *p = 0;
    long n = f && !fseek(f, 0, 2) ? ftell(f) : -1;
    if (n >= 0 && (unsigned long)n <= max && !fseek(f, 0, 0) && (p = calloc(1, (unsigned)n + 1)) &&
        fread(p, 1, (unsigned)n, f) != (unsigned)n) {
        free(p);
        p = 0;
    }
    if (f) fclose(f);
    *size = p ? (unsigned)n : 0;
    return p;
}
int blob_io(const char *path, const char *tmp, void *buf, unsigned size, int write) {
    assert(write);
    FILE *f = fopen(tmp, "wb");
    if (!f) return 0;
    int ok = fwrite(buf, size, 1, f) == 1;
    if (fclose(f) || !ok) return 0;
    return !rename(tmp, path);
}
/* argv: a command and its file. parse prints the rules; sync prints theme_sync's note. */
int main(int argc, char **argv) {
    if (!strcmp(argv[1], "sync")) {
        const char *note = theme_sync();
        puts(note ? note : "-");
        return 0;
    }
    unsigned n = 0, rgb = 0;
    char *b = read_all(argv[2], 1 << 20, &n);
    int whole = b && theme_whole(b, n);
    printf("whole %d\n", whole);
    if (!whole && !strcmp(argv[1], "parse")) {
        free(b);
        return 0;
    }
    if (b) theme_parse(b);
    printf("on %d tints %d\n", theme_on(), theme_tints());
    if (theme_accent(&rgb)) printf("accent %06x\n", rgb);
    if (theme_battery() >= 0) printf("battery %d\n", theme_battery());
    if (theme_bg(&rgb)) printf("bg %06x\n", rgb);
    if (theme_home_row()) printf("home rows %d\n", theme_home_row());
    if (theme_home_top() >= 0) printf("home top %d\n", theme_home_top());
    if (theme_home_card()) printf("home cards %d\n", theme_home_card());
    int seconds, pins = theme_home_art(&seconds);
    if (pins) printf("art %d %d\n", pins, seconds);
    for (int i = 0; i < pins; ++i) printf("art gif %d\n", theme_home_art_gif((unsigned)i));
    for (int i = 3; i + 1 < argc; i += 2) {
        printf("%s %s hidden %d tint %d\n", argv[i], argv[i + 1], theme_hidden(argv[i], argv[i + 1]),
               theme_tint(argv[i], argv[i + 1], &rgb) ? (int)rgb : -1);
        if (theme_font(argv[i], argv[i + 1])) printf("font %d\n", theme_font(argv[i], argv[i + 1]));
        if (theme_text(argv[i], argv[i + 1])) printf("text [%s]\n", theme_text(argv[i], argv[i + 1]));
    }
    free(b);
    return 0;
}
'''


# ui/core.js's GIF encoder, for a decoder that isn't ours.
GIF_CHECK = r'''
const core = require(process.argv[2]);
const fs = require('fs');
const [w, h] = [64, 48];
const frame = (paint) => {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) rgba.set(paint(x, y), (y * w + x) * 4);
  return rgba;
};
fs.writeFileSync(process.argv[3], core.encodeGif(w, h, [
  { rgba: frame(() => [255, 0, 0, 255]), delay: 100 },
  { rgba: frame((x) => (x < 32 ? [0, 255, 0, 255] : [0, 0, 255, 255])), delay: 200 },
  { rgba: frame((x, y) => (y < 24 ? [0, 0, 0, 0] : [255, 255, 255, 255])), delay: 300 },
]));
'''


def run_gif(tmp):
    (tmp/'gif_check.js').write_text(GIF_CHECK)
    gif = tmp/'check.gif'
    subprocess.run(['node', tmp/'gif_check.js', ROOT/'tools/theme-studio/ui/core.js', gif], check=True)
    info = subprocess.check_output(['identify', '-format', '%w %h %T\n', gif], text=True).split()
    assert info == ['64', '48', '10', '64', '48', '20', '64', '48', '30'], info
    rgba = subprocess.check_output(['convert', gif, '-coalesce', '-depth', '8', 'rgba:-'])
    assert len(rgba) == 3 * 64 * 48 * 4
    pixel = lambda f, x, y: tuple(rgba[(f * 48 + y) * 64 * 4 + (f * 0) + x * 4:][:4])
    assert pixel(0, 5, 5) == (255, 0, 0, 255) and pixel(1, 5, 5) == (0, 255, 0, 255) and pixel(1, 60, 5) == (0, 0, 255, 255)
    assert pixel(2, 5, 5)[3] == 0 and pixel(2, 5, 40) == (255, 255, 255, 255)


def build(tmp):
    (tmp/'mnt/mmc/Q2Pod').mkdir(parents=True)
    (tmp/'mnt/data').mkdir(parents=True)
    (tmp/'driver.c').write_text(DRIVER)
    exe = tmp/'theme_host'
    subprocess.run(['cc', '-g', '-O1', '-std=gnu11', '-Wall', '-Wextra', '-DPEQ_HOST', f'-DPEQ_ROOT="{tmp}"',
                    '-fsanitize=address,undefined', '-fno-sanitize-recover=all', '-I', ROOT/'patch',
                    tmp/'driver.c', ROOT/'patch/theme.c', '-o', exe], check=True)
    return exe


def parse(exe, tmp, text, *ask, mode='parse'):
    f = tmp/'in.txt'
    f.write_bytes(text if isinstance(text, bytes) else text.encode())
    return subprocess.run([exe, mode, f, *ask], capture_output=True, text=True, errors='replace', check=True).stdout


def whole(body):
    return 'q2theme 1\n' + body + 'end\n'


def run_parser(exe, tmp):
    # A theme reads as written, with CRLF line ends too.
    theme = whole('name Midnight Blue\naccent #3366ff\npage playing_page\nhide img_fav\nmove img_cover 16 2\n'
                  'size img_cover 166 166\ntint scrlabel_title #ff4040\npage home_page\nhide btn_folder\n')
    ask = ('playing_page', 'img_fav', 'playing_page', 'scrlabel_title', 'home_page', 'btn_folder')
    want = ('whole 1\non 1 tints 1\naccent 3366ff\nplaying_page img_fav hidden 1 tint -1\n'
            f'playing_page scrlabel_title hidden 0 tint {0xff4040}\nhome_page btn_folder hidden 1 tint -1\n')
    assert parse(exe, tmp, theme, *ask) == want
    assert parse(exe, tmp, theme.replace('\n', '\r\n'), *ask) == want
    assert 'accent aabbcc' in parse(exe, tmp, whole('accent #AaBbCc\n'))
    # A file cut short, or not a theme, is refused whole.
    for bad in ('', 'q2theme 1\n', 'q2theme 1\nhide x\n', 'q2theme 2\nend\n', 'theme\nend\n', 'q2theme 1end\n',
                theme[:-2], theme[:-5], 'q2theme 1\n\0end\n', 'q2theme 1\n' + 'x' * 16400 + '\nend\n'):
        assert parse(exe, tmp, bad).startswith('whole 0'), repr(bad[:40])
    # What the table doesn't allow does nothing, whatever the file says, and later lines still count.
    for line in ('hide img_more', 'hide view_battery', 'hide img_state', 'hide list_view_home', 'hide slide_view',
                 'move slider_play 0 0', 'tint img_fav #ffffff', 'size scrlabel_title 50 50', 'launch rockbox'):
        out = parse(exe, tmp, whole(f'page playing_page\n{line}\nhide label_ipod_pos\n'), 'playing_page', line.split()[1])
        assert 'on 1 tints 0' in out and 'hidden 0 tint -1' in out, (line, out)
    # A rule before any page, or for an unknown page, is skipped.
    assert 'on 0' in parse(exe, tmp, whole('hide img_fav\npage nope\nhide img_fav\n'))
    # Malformed values are skipped.
    for line in ('tint scrlabel_title ff4040', 'tint scrlabel_title #ff404', 'tint scrlabel_title #ff40400',
                 'tint scrlabel_title #gg4040', 'move img_cover 1', 'move img_cover 1 2 3', 'move img_cover a 2',
                 'move img_cover 99999 2', 'move img_cover 1 --2', 'size img_cover 100', 'hide img_fav extra'):
        assert 'on 0 tints 0' in parse(exe, tmp, whole(f'page playing_page\n{line}\n')), line
    assert 'accent' not in parse(exe, tmp, whole('accent 3366ff\naccent #3366f\naccent #3366ffff\n'))
    # A text size stays in range, and only rows that take one do; a row's words are the rest of the line.
    fav, title, row = ('playing_page', 'img_fav'), ('playing_page', 'scrlabel_title'), ('home_page', 'btn_folder')
    assert 'font 30\n' in parse(exe, tmp, whole('page playing_page\nfont scrlabel_title 30\n'), *title)
    assert 'font 8\n' in parse(exe, tmp, whole('page playing_page\nfont scrlabel_title 1\n'), *title)
    assert 'font 120\n' in parse(exe, tmp, whole('page playing_page\nfont scrlabel_title 900\n'), *title)
    for line in ('font img_fav 30', 'font scrlabel_title', 'font scrlabel_title x', 'font scrlabel_title 30 1'):
        out = parse(exe, tmp, whole(f'page playing_page\n{line}\n'), *title, *fav)
        assert 'font' not in out, line
    assert 'text [My Music]\n' in parse(exe, tmp, whole('page home_page\ntext btn_folder My Music\n'), *row)
    assert 'text [A B C D E F]\n' in parse(exe, tmp, whole('page home_page\ntext btn_folder A B C D E F\n'), *row)
    assert 'text [Café]\n' in parse(exe, tmp, whole('page home_page\r\ntext btn_folder Café  \r\n'), *row)
    assert 'text [Ends]\n' in parse(exe, tmp, whole('page home_page\ntext btn_folder Ends\npage playing_page\n'), *row)
    long = 'x' * 41
    for line in ('text btn_folder', f'text btn_folder {long}', 'page playing_page\ntext btn_folder Mine'):
        assert 'text [' not in parse(exe, tmp, whole(f'page home_page\n{line}\n'), *row), line
    assert 'text [' not in parse(exe, tmp, whole('page playing_page\ntext scrlabel_title Mine\n'), *title)
    # A background is one whole colour; other colour slots are for a newer firmware.
    assert 'bg 101820\n' in parse(exe, tmp, whole('color bg #101820\n'))
    assert 'bg' not in parse(exe, tmp, whole('color bg\ncolor bg 101820\ncolor bg #10182\ncolor bg #101820 x\ncolor text #101820\n'))
    # A battery line picks one of the Battery setting's four, by its place in that setting.
    for value, word in enumerate(('icon', 'percent', 'both', 'inside')):
        assert f'battery {value}\n' in parse(exe, tmp, whole(f'battery {word}\n')), word
    assert 'battery' not in parse(exe, tmp, whole('battery\nbattery full\nbattery PERCENT\nbattery icon extra\n'))
    # Home's sizes stay in range, and the right panel's pictures are a letter each, so a theme names no file.
    out = parse(exe, tmp, whole('home rows 46\nhome top 30\nhome cards 150\n'))
    assert all(x in out for x in ('home rows 46\n', 'home top 30\n', 'home cards 150\n')), out
    out = parse(exe, tmp, whole('homeart 20 jgj\n'))
    assert 'art 3 20\nart gif 0\nart gif 1\nart gif 0\n' in out, out
    assert 'art 24 600\n' in parse(exe, tmp, whole(f'homeart 9000 {"g" * 24}\n')) and 'art 1 3\n' in parse(exe, tmp, whole('homeart 1 j\n'))
    assert 'art' not in parse(exe, tmp, whole(f'homeart\nhomeart 3\nhomeart x j\nhomeart 5 jx\nhomeart 5 ../a\nhomeart 5 j g\nhomeart 5 {"j" * 25}\n'))
    out = parse(exe, tmp, whole('home rows 1\nhome top 999\nhome cards 9999\n'))
    assert all(x in out for x in ('home rows 28\n', 'home top 120\n', 'home cards 220\n')), out
    assert 'home cards 60\n' in parse(exe, tmp, whole('home cards -5\n')) and 'home top 0\n' in parse(exe, tmp, whole('home top 0\n'))
    out = parse(exe, tmp, whole('home rows\nhome rows x\nhome size 3\nhome rows 30 40\n'))
    assert 'home' not in out, out
    # Home keeps a main row whatever the theme says.
    rows = ('btn_playing', 'btn_localmusic', 'btn_coverflow', 'btn_folder', 'btn_eq', 'btn_stream', 'btn_settings')
    ask = [x for r in rows for x in ('home_page', r)]
    out = parse(exe, tmp, whole('page home_page\nhide btn_rockbox\n' + ''.join(f'hide {r}\n' for r in rows)),
                *ask, 'home_page', 'btn_rockbox')
    assert out.count('hidden 0') == 8, out
    out = parse(exe, tmp, whole('page home_page\n' + ''.join(f'hide {r}\n' for r in rows[:-1])), *ask)
    assert out.count('hidden 1') == 6, out


def run_fuzz(exe, tmp):
    seed = whole('name x\naccent #123456\ncolor bg #204060\nbattery inside\nhome rows 46\nhome top 30\nhome cards 150\nhomeart 12 jgj\npage home_page\nfont btn_folder 20\ntext btn_folder My Music\npage playing_page\nhide img_fav\nmove img_cover 1 2\nsize img_cover 80 80\n'
                 'tint scrlabel_title #010203\npage system_bar\nhide label_eq\n').encode()
    rng = random.Random(0x51)
    for _ in range(1500):
        b = bytearray(seed)
        for _ in range(rng.randrange(1, 24)):
            kind, at = rng.randrange(4), rng.randrange(len(b))
            if kind == 0: b[at] = rng.randrange(256)
            elif kind == 1: del b[at:at + rng.randrange(1, 12)]
            elif kind == 2: b[at:at] = bytes(rng.randrange(256) for _ in range(rng.randrange(1, 12)))
            else: b[at:at] = b' ' * rng.randrange(1, 40)
            if not b: b = bytearray(b'\n')
        parse(exe, tmp, bytes(b), mode='raw')  # raises on a sanitizer report
    # One very long line and no line ends at all.
    parse(exe, tmp, b'q2theme 1\n' + b'a ' * 8000, mode='raw')
    parse(exe, tmp, b'\n' * 16000, mode='raw')
    parse(exe, tmp, b' ' * 16000, mode='raw')


def run_sync(exe, tmp):
    src, dst = tmp/'mnt/mmc/Q2Pod/theme.txt', tmp/'mnt/data/q2pod-theme'
    bad = pathlib.Path(str(dst) + '.bad')
    def sync():
        return subprocess.run([exe, 'sync', 'x'], capture_output=True, text=True, check=True).stdout.strip()
    assert sync() == '-'  # nothing on the card, nothing here
    src.write_text(whole('accent #123456\n'))
    assert sync() == 'Theme saved. Restart to apply' and dst.read_bytes() == src.read_bytes()
    assert sync() == '-'  # the same bytes: no write, no toast
    src.write_text('q2theme 1\ncut sho')
    assert sync() == "Theme file can't be used" and b'123456' in dst.read_bytes()  # the last good one stays
    src.write_text(whole('accent #654321\n'))
    assert sync() == 'Theme saved. Restart to apply' and b'654321' in dst.read_bytes()
    src.unlink()
    assert sync() == 'Theme removed. Restart to finish' and not dst.exists()
    # A theme that took a start down stays out, until the card holds a different one.
    bad.write_text(whole('accent #111111\n'))
    src.write_text(whole('accent #111111\n'))
    assert sync() == '-' and not dst.exists()
    src.write_text(whole('accent #222222\n'))
    assert sync() == 'Theme saved. Restart to apply' and dst.exists() and not bad.exists()
    src.unlink()
    assert sync() == 'Theme removed. Restart to finish'
    assert not list((tmp/'mnt/data').glob('*.tmp'))
    # A new theme or none clears the count of unfinished starts: it was about the old bytes.
    guard = pathlib.Path(str(dst) + '.try')
    guard.write_text('1'); src.write_text(whole('accent #333333\n'))
    assert sync() == 'Theme saved. Restart to apply' and not guard.exists()
    guard.write_text('1'); src.unlink()
    assert sync() == 'Theme removed. Restart to finish' and not guard.exists()
    # A mark with no theme left goes too.
    bad.write_text(whole('accent #111111\n'))
    assert sync() == 'Theme removed. Restart to finish' and not bad.exists()
    # A write that fails keeps what is there.
    src.write_text(whole('accent #444444\n')); dst.write_text(whole('accent #555555\n'))
    (tmp/'mnt/data').chmod(0o555)
    try:
        assert sync() == 'Could not save theme' and b'555555' in dst.read_bytes()
    finally:
        (tmp/'mnt/data').chmod(0o755)
    src.unlink(); dst.unlink()


def eq_cases(rng):
    """Presets peq_parse takes, the same with bytes damaged, and the limits."""
    def number(low, high):
        return f'{rng.uniform(low, high):.{rng.choice((0, 1, 2, 6))}f}'

    def band():
        kind = rng.choice(('PK', 'PEQ', 'LS', 'LSC', 'HS', 'HSC'))
        line = (f'Filter {rng.randint(1, 99)}: {rng.choice(("ON", "ON", "ON", "OFF"))} {kind} '
                f'Fc {number(20, 20000)} Hz Gain {number(-24, 24)} dB')
        return line if kind not in ('PK', 'PEQ') and rng.random() < .3 else f'{line} Q {number(.1, 10)}'

    def preset():
        lines = []
        for _ in range(rng.randint(0, 8)):
            lines.append(rng.choice(('', '# a note', 'Channel: L', 'Channel: R', 'Channel: all', 'Channel: L R',
                                     'Filter 3: ON None', f'Preamp: {number(-20, 5)} dB')))
            lines.extend(band() for _ in range(rng.randint(0, 4)))
        return rng.choice(('\n', '\r\n')).join(lines) + rng.choice(('\n', ''))

    def damaged(text):
        chars = list(text) or [' ']
        for _ in range(rng.randint(1, 3)):
            at = rng.randrange(len(chars))
            if rng.random() < .5:
                del chars[at]
                chars = chars or [' ']
            else:
                chars.insert(at, rng.choice(' :#,.+-eE0129QHzdBLRNF\t\r\n\0'))
        return ''.join(chars)

    texts = [preset() for _ in range(500)]
    texts += [damaged(text) for text in texts]
    full = ''.join(f'Filter: ON PK Fc 100 Hz Gain 1 dB Q 1\n' for _ in range(30))
    texts += [full, full + 'Filter: ON PK Fc 100 Hz Gain 1 dB Q 1\n', '#' * 512, '#' * 513, '#' * 16384, '#' * 16385,
              '﻿Preamp: -3 dB\n', '', '\n', 'Channel: L\nPreamp: 13 dB\nChannel: R\nPreamp: 0 dB\n']
    return texts + [p['text'] for p in EQ_PRESETS]


def run_eq(tmp):
    if not shutil.which('node'):
        print('theme: no node, so the EQ comparison is skipped')
        return 0
    (tmp/'eq_driver.c').write_text(EQ_DRIVER % (', '.join(map(str, EQ_RATES)), ', '.join(map(str, EQ_POINTS))))
    exe = tmp/'eq_host'
    subprocess.run(['cc', '-O2', '-DPEQ_HOST', f'-DPEQ_ROOT="{tmp}"', '-I', ROOT/'patch', tmp/'eq_driver.c',
                    ROOT/'patch/peq.c', '-lm', '-Wl,--unresolved-symbols=ignore-all', '-o', exe], check=True)
    def verdicts(paths):
        return [json.loads(line) for line in subprocess.check_output([exe, *map(str, paths)]).decode().splitlines()]

    (tmp/'eq').mkdir()
    (tmp/'eq_back').mkdir()
    files = []
    for i, text in enumerate(eq_cases(random.Random(20261031))):
        files.append(tmp/'eq'/f'{i:04}.txt')
        files[-1].write_bytes(text.encode())
    first = verdicts(files)
    assert len(first) == len(files)
    assert all(c['ok'] for c in first[-len(EQ_PRESETS):]), 'a built-in preset the Q2 would refuse'
    taken = [(f, c) for f, c in zip(files, first) if c['ok']]
    assert 300 < len(taken) < len(files), len(taken)  # both answers get a fair run
    (tmp/'eq_cases.json').write_text(json.dumps({
        'rates': EQ_RATES, 'points': EQ_POINTS, 'cases': [{'file': str(f), 'c': c} for f, c in zip(files, first)]}))
    (tmp/'eq_check.js').write_text(EQ_CHECK)
    subprocess.run(['node', tmp/'eq_check.js', ROOT/'tools/theme-studio/ui/eq.js', tmp/'eq_cases.json', tmp/'eq_back'],
                   check=True)
    # What the Studio writes, peq_parse reads as the same EQ, to the file's rounding.
    back = verdicts(tmp/'eq_back'/f.name for f, _ in taken)
    for (file, c), again in zip(taken, back):
        assert again['ok'], (file, again)
        assert len(again['bands']) == len(c['bands']) and again['automatic'] == c['automatic'], file
        assert abs(again['balance'] - c['balance']) < .011 and abs(again['preamp'] - c['preamp']) < .011, file
        assert max(abs(a - b) for a, b in zip(again['curve'], c['curve'])) < .05, file
    return len(files)


def run_catalogue(build):
    # The Studio offers the Battery setting's words, in its order.
    words = re.search(r'modes\[\] = \{ (.*?) \};', (ROOT/'patch/theme.c').read_text()).group(1)
    studio = re.search(r'BATTERY_MODES = \[(.*?)\];', (ROOT/'tools/theme-studio/ui/core.js').read_text()).group(1)
    assert re.findall(r'"(\w+)"', words) == re.findall(r"'(\w+)'", studio)
    # The exe opens the same library the page reads.
    library = re.search(r"LIBRARY = '([^']+)'", (ROOT/'tools/theme-studio/ui/core.js').read_text()).group(1)
    assert f'https://github.com/{library}/' in (ROOT/'tools/theme-studio/src/main.rs').read_text()
    # And draws a background by the firmware's numbers.
    core = (ROOT/'tools/theme-studio/ui/core.js').read_text()
    offsets = (ROOT/'patch/offsets.inc').read_text()
    number = lambda name: int(re.search(rf'#define {name} (\w+)', offsets).group(1), 0)
    assert int(re.search(r'PAPER_LIGHT_MIN = (\d+)', core).group(1)) == number('PAPER_LIGHT_MIN')
    assert int(re.search(r'SPREAD = (\d+)', core).group(1)) == number('LIGHT_SPREAD')
    assert re.search(r"INK_DARK = '#(\w\w)", core).group(1) == f"{number('LIGHT_INK'):02x}"
    sys.path.insert(0, str(ROOT/'tools'))
    import theme_catalog as tc
    # Every accent read goes through accent_row, or a theme's accent reads past the table.
    nav = (ROOT/'patch/navigation.c').read_text()
    assert len(re.findall(r'\baccents\[', nav)) == 2 and 'accents[preset]' in nav  # its table and accent_row
    rows = tc.rows()
    assert len(rows) == (ROOT/'patch/theme.inc').read_text().count('\nTHEME_ROW(')
    assert {(p, w) for p, w, _, _ in rows} == set(tc.LABELS), 'a theme.inc row without a label, or the reverse'
    assert len({(p, w) for p, w, _, _ in rows}) == len(rows), 'a repeated theme.inc row'
    for page, name, actions, box in rows:
        assert page in tc.PAGES
        assert ('move' in actions or 'size' in actions) == any(box), (page, name, box)
        assert not any(k in name for k in ('img_more', 'view_battery', 'img_state', 'label_idle')), name
    if build:  # the real pages: every name resolves, moved widgets fit their boxes, boxes their parents
        def load(asset):
            return subprocess.check_output(['unsquashfs', '-cat', str(pathlib.Path(build)/'rootfs.squashfs'),
                                            'release/assets/default/raw/ui/' + asset], stderr=subprocess.DEVNULL)
        pages = tc.catalogue(load)['pages']
        for page in pages.values():
            for e in page['elements']:
                if e['box']:
                    x0, y0, x1, y1 = e['box']
                    assert x0 <= e['x'] and e['x'] + e['w'] <= x1 and y0 <= e['y'] and e['y'] + e['h'] <= y1, e


with tempfile.TemporaryDirectory(prefix='q2-theme-') as d:
    tmp = pathlib.Path(d)
    exe = build(tmp)
    run_parser(exe, tmp)
    run_sync(exe, tmp)
    run_fuzz(exe, tmp)
    eq_files = run_eq(tmp)
    run_gif(tmp)
run_catalogue(sys.argv[1] if len(sys.argv) > 1 else None)
print(f'theme: parser, card sync, 1500 damaged files, the catalogue, GIFs through ImageMagick and {eq_files} EQ files against peq.c passed')
