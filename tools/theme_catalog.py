#!/usr/bin/env python3
"""Write Q2 Theme Studio's catalogue: every row of patch/theme.inc with its friendly name and its
geometry in the firmware that BUILD built, so the app offers only what the firmware accepts.

usage: python3 tools/theme_catalog.py BUILD OUT.json"""
import json
import pathlib
import re
import subprocess
import sys

sys.path.insert(0, sys.path[0])
from build import TAG, VERSION
from ipod import decode, inc

ROOT = pathlib.Path(__file__).resolve().parents[1]
ACTIONS = {'TH_HIDE': 'hide', 'TH_MOVE': 'move', 'TH_SIZE': 'size', 'TH_TINT': 'tint', 'TH_FONT': 'font', 'TH_TEXT': 'text',
           'TH_SCALE': 'scale'}
ROW = re.compile(r'^THEME_ROW\("(\w+)", "(\w+)", ([A-Z_ |]+), (\d+), (\d+), (\d+), (\d+)\)$', re.M)
# The app window sits under the 30 px status bar; the lock screen covers it.
PAGES = {
    'playing_page': ('Now Playing', 'playing_page.bin', (0, 30)),
    'home_page': ('Home', 'home_page.bin', (0, 30)),
    'saverscreen_page': ('Lock screen', 'saverscreen_page.bin', (0, 0)),
    'system_bar': ('Status bar', 'system_bar.bin', (0, 0)),
}
# name, kind (text, image, bar, row, group), and a warning when removing it costs something.
LABELS = {
    ('playing_page', 'img_cover'): ('Album art', 'image', 'Tapping the art opens it full screen. Hidden, that tap goes too.'),
    ('playing_page', 'scrlabel_title'): ('Song title', 'text', ''),
    ('playing_page', 'scrlabel_artist'): ('Artist', 'text', ''),
    ('playing_page', 'label_ipod_album'): ('Album', 'text', ''),
    ('playing_page', 'view_eqchip'): ('EQ line', 'text', 'Hidden, tapping to flip EQ goes too. Hold Play/Pause still changes it.'),
    ('playing_page', 'img_playmode'): ('Shuffle and repeat', 'image', 'Hidden, change it from the Play/Pause hold menu or Playback settings.'),
    ('playing_page', 'img_fav'): ('Heart', 'image', 'Hidden, use the Play/Pause hold menu to favourite a song. Tidal songs may have no other way.'),
    ('playing_page', 'label_ipod_pos'): ('Queue position', 'text', ''),
    ('playing_page', 'label_playtime'): ('Elapsed time', 'text', ''),
    ('playing_page', 'label_ipod_remain'): ('Remaining time', 'text', ''),
    ('playing_page', 'slider_play'): ('Progress bar', 'bar', 'Hidden, you can still skip through a song with the scrub control, but cannot see it.'),
    ('playing_page', 'slide_indicator1'): ('Page dots', 'bar', ''),
    ('system_bar', 'label_eq'): ('EQ indicator', 'text', ''),
    ('system_bar', 'img_bt'): ('Bluetooth', 'image', ''),
    ('system_bar', 'img_wifi'): ('Wi-Fi', 'image', ''),
    ('system_bar', 'label_clock'): ('Clock', 'text', ''),
    ('home_page', 'btn_playing'): ('Now Playing row', 'row', 'Return on Home still opens Now Playing.'),
    ('home_page', 'btn_localmusic'): ('Library row', 'row', 'Hidden, the Library menu has no other route. Coverflow and Folder still reach your music.'),
    ('home_page', 'btn_coverflow'): ('Coverflow row', 'row', 'Coverflow has no other way in from Home, unless you use the Carousel layout.'),
    ('home_page', 'btn_folder'): ('Folder row', 'row', 'Folder browsing has no other route from Home.'),
    ('home_page', 'btn_eq'): ('EQ row', 'row', 'Hold Play/Pause on Now Playing still changes EQ.'),
    ('home_page', 'btn_rockbox'): ('Rockbox or Shortcut row', 'row', 'Hidden, your Shortcut goes too. Boot to: Rockbox still starts Rockbox.'),
    ('home_page', 'btn_stream'): ('Streaming row', 'row', 'Spotify, Tidal, Internet Radio and card apps open from here, with no other route.'),
    ('home_page', 'btn_settings'): ('Settings row', 'row', 'Quick Settings still has Playback and System buttons.'),
    ('saverscreen_page', 'view_timeinfo'): ('Clock and battery', 'group', ''),
    ('saverscreen_page', 'clock_time'): ('Time', 'text', ''),
    ('saverscreen_page', 'clock_date'): ('Date', 'text', ''),
    ('saverscreen_page', 'label_battery'): ('Battery percent', 'text', ''),
    ('saverscreen_page', 'img_battery'): ('Battery icon', 'image', ''),
    ('saverscreen_page', 'view_playinfo'): ('Now-playing card', 'group', ''),
    ('saverscreen_page', 'scrlabel_title'): ('Song title', 'text', ''),
    ('saverscreen_page', 'scrlabel_artist'): ('Artist', 'text', ''),
    ('saverscreen_page', 'img_slide'): ('Swipe hint', 'image', ''),
}


def rows():
    text = (ROOT/'patch/theme.inc').read_text()
    found = [(m[1], m[2], [ACTIONS[a.strip()] for a in m[3].split('|')], [int(m[i]) for i in range(4, 8)])
             for m in ROW.finditer(text)]
    assert len(found) == text.count('\nTHEME_ROW('), 'a theme.inc row did not parse'
    return found


def find(node, name, x=0, y=0):
    """The first widget called name, as widget_lookup finds it, with its parent's position."""
    for child in node[3]:
        if child[2].get('name') == name:
            return child, x, y
        hit = find(child, name, x + child[1][0], y + child[1][1])
        if hit:
            return hit
    return None


def font_of(page, name, node):
    """The text size the Studio starts an item at: Minimal's, as its preview draws."""
    if page == 'home_page':
        return inc('HOME_CAPS_PX')
    if name == 'label_ipod_album':
        return inc('NP_CAPS_PX')
    props = node[2]
    style = re.search(r'white(\d+)', props.get('style', ''))
    return int(props.get('style:normal:font_size') or (style and style[1]) or 16)


def catalogue(load):
    pages = {key: {'label': label, 'origin': list(origin), 'elements': []}
             for key, (label, _, origin) in PAGES.items()}
    roots = {key: decode(load(asset)) for key, (_, asset, _) in PAGES.items()}
    for page, name, actions, box in rows():
        hit = find(roots[page], name)
        assert hit, f'{name} is not in {page}'
        node = hit[0]
        (_, (x, y, w, h), props, _), px, py = hit
        if 'w=100%' in props.get('self_layout', ''):  # the page dots: the width the page gives them
            w = 375
        label, kind, warn = LABELS[page, name]
        ox, oy = PAGES[page][2]
        pages[page]['elements'].append({
            'id': name, 'label': label, 'kind': kind, 'actions': actions, 'warn': warn,
            'x': x, 'y': y, 'w': w, 'h': h, 'parent': [ox + px, oy + py],
            'box': box if 'move' in actions or 'size' in actions else None,
            **({'font': font_of(page, name, node)} if 'font' in actions else {})})
    return {'format': 1, 'firmware': VERSION, 'tag': TAG, 'screen': [375, 320], 'pages': pages}


def main(build, out):
    squash = pathlib.Path(build)/'rootfs.squashfs'
    def load(asset):
        return subprocess.check_output(['unsquashfs', '-cat', str(squash), 'release/assets/default/raw/ui/' + asset],
                                       stderr=subprocess.DEVNULL)
    pathlib.Path(out).write_text(json.dumps(catalogue(load), indent=1) + '\n')


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    main(*sys.argv[1:])
