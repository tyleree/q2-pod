# Card themes

A card theme recolours, moves and hides parts of the interface from a small text file on the microSD card,
with no firmware update. **Q2 Theme Studio** ([`tools/theme-studio`](../tools/theme-studio)) writes it from a Windows PC; the file is plain text, so it can
also be written by hand. The source of what a theme can reach is
[`patch/theme.inc`](../patch/theme.inc), in the firmware and in the Studio's catalogue alike.

## Using a theme

1. Put the file on the card as `/Q2Pod/theme.txt`, with the card in a reader or the Q2 in USB storage mode.
2. Put the card back, or leave USB storage mode. Q2 Pod shows **Theme saved. Restart to apply**.
3. Restart the Q2.

To go back, delete the file and do the same: **Theme removed. Restart to finish**. A file that isn't a whole
theme shows **Theme file can't be used**, and the current theme stays.

While a theme sets the accent, Display's Accent row reads **Accent: Theme**, and your own accent setting
returns when the theme goes.

## The file

UTF-8 text of at most 16 KB, with LF or CRLF line ends. Words are separated by spaces.

```
q2theme 1
name Midnight Blue
accent #3366ff
color bg #101820
battery percent
page playing_page
hide img_fav
move img_cover 16 2
size img_cover 166 166
tint scrlabel_title #ff4040
page system_bar
hide label_eq
page home_page
hide btn_folder
end
```

| Line                | Meaning                                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| `q2theme 1`         | Required first line                                                                            |
| `end`               | Required last line, so a file cut short is refused whole                                       |
| `name TEXT`         | For the Studio; the firmware ignores it                                                        |
| `author TEXT`       | For the Studio's Library; the firmware ignores it                                              |
| `color bg #rrggbb`  | The page's colour. Text turns white or near-black to suit it, greys shade between the two, and Display's Light Mode row reads **Light Mode: Theme** while your own setting waits |
| `accent #rrggbb`    | The accent: selection, progress, highlights. Selection is the colour, the rest 12% toward white; a grey accent has Graphite's silver text, and Light Mode treats it as it does Graphite |
| `battery MODE`      | The status bar's battery: `icon`, `percent`, `both` or `inside`, Display's Battery setting's four, and the Large clock follows. The row reads **Battery: Theme**, and your own setting returns when the theme goes |
| `home rows PX`      | Home's row height, 28 to 64. The list shows the whole rows that fit, and the rest scroll in |
| `home top PX`       | Space under the status bar on Home, 0 to 120 px. The list starts below it |
| `home cards PX`     | Carousel's card images, 60 to 220 px, held above their labels |
| `homeart SECONDS KINDS` | The pictures that take turns in Home's right panel, `Q2Pod/images/art01` on, up to 24: a letter each, `j` for `.jpg` and `g` for `.gif`, for 3 to 600 seconds each |
| `page NAME`         | The window the following rules are for                                                         |
| `hide WIDGET`       | Not drawn, and no longer takes taps                                                            |
| `move WIDGET X Y`   | Position in the widget's parent's coordinates, kept inside its box in `theme.inc`              |
| `size WIDGET W H`   | Size within its box: at least 12 px for text, 16 for icons, which scale to it, and 40 otherwise |
| `font WIDGET PX`    | Text size, 8 to 120, in every state, Minimal's capitals included                               |
| `text WIDGET WORDS` | Home rows only: the row's words, the rest of the line, up to 40 bytes                          |
| `tint WIDGET #rrggbb` | Text colour, in every state: Light Mode and the accent leave it alone, but for Minimal's album line, which Light Mode flips |

Lines, pages and names the firmware doesn't know are skipped, so a theme made for a newer firmware still
loads, and a rule `theme.inc` doesn't allow does nothing. Now Playing's rules are for the iPod layout; **Centred**
Now Playing ignores its moves and hides. Home's hides apply in Split and Full; Carousel keeps its cards. If a
theme hides every main Home row, its Home rows are ignored.

Not reachable, on purpose: list rows, Quick Settings, the height of Home's rows, which the list sets, the size of the page dots and the status bar's Bluetooth and Wi-Fi icons, which stock lays out each second, the words of anything the Q2 fills in (a song's title, the clock), moving or hiding the status bar's battery and play state
icon (`bar_sync` writes them while painting; `battery` picks the style, nothing more), and the More button, which on Tidal is the only way to the More page. Base text and
status bar colours aren't themeable yet. Spotify's and Internet Radio's own Now Playing pages are separate
windows and aren't covered.

## How it works

**Getting it onto the Q2.** `theme_sync` runs with the boot logo's sync (`logo_sync`) on each card mount, off the
UI thread. It checks the file (`theme_whole`) and copies it to `/mnt/data/q2pod-theme` through `blob_io`. The
same bytes aren't written again. With no file on the card, the copy goes.

**Loading.** `theme_load` runs once, from `accent()`'s first setting read, which comes before the first frame.
The card can mount after `demo` starts, which is why startup reads the copy in `/mnt/data`. A theme never
changes on a running UI: the status bar and Home are never rebuilt and a rule keeps no original to go back to,
so a change waits for a restart, as the boot logo's does.

**A theme that breaks a start.** `theme_load` counts starts in `/mnt/data/q2pod-theme.try` before the theme runs,
and `theme_poll` deletes it `THEME_TRY_MS` (15 s) later. One unfinished start may be a power-off or Rockbox. Two in
a row and the theme moves to `q2pod-theme.bad`, so the third start runs without it and shows **Theme turned off
after a failed start**. `theme_sync` won't copy those same bytes back, and a different file clears both marks. A
crash after the first 15 s is not caught. With no way to write the count, the theme stays off for that start.

**Applying.** Rules run where each page already passes through the payload, not on a paint or a main-loop pass:
`window_manager_paint` runs on every pass, stock's ticks and `bar_sync` rewrite some of these widgets, and either
would turn a per-pass rule into a repaint loop.

| Page               | Where                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `playing_page`     | `np_rules`, in `ringnav_playing` before `rate_bind`, whose badge takes its place from the heart   |
| `saverscreen_page` | The end of `lockscreen_init`, after `big_clock`                                                  |
| `system_bar`       | `ringnav_showface`, after stock's one-second tick shows its icons and before layout can see them |
| `home_page`        | `coverflow_home_layout`                                                                          |

Hiding clears visibility, opacity and sensitivity (Home's rows, visibility and sensitivity, through `home_show`).
Stock's hit test ignores visibility, so a widget hidden any other way keeps its taps; opacity keeps it hidden
through stock's writes to `visible`. Home's rows are put back in their
order and the hidden ones restacked last, so the rest close up however the layout treats a hidden row, and
`collect` skips them for the wheel. `np_rules` keeps the pause glyph and the buffering spinner centred on the art.

**Sizes and words.** A sized image of `TH_SCALE` draws `scale_auto`, or a bigger one would only grow its tap. `set_font` writes
`font_size` to all three states, as stock paints some labels disabled. A page is built anew each open, so it takes its sizes
each time, but the status bar is never rebuilt and comes through `theme_apply` each second, so it takes them once (`sized`).
Minimal's Home labels and album are `paint_caps`' own text, so it asks `theme_font` as it paints. Home's rows go through
`coverflow_home_layout`, with `theme_label` on each row's first child. A rule's words point into the theme file, which then
stays loaded. A clock sized for one Lock Clock setting misfits the other, as its box differs.

**Colours.** A tint is looked up as the colour is read (`ringnav_style_color`), by the painting widget's window and
name, so it covers every state, needs no mutable style, and is final: it returns before Light Mode's flip and the
accent's mapping. Minimal's album line is `paint_caps`' own text, so it asks too. The accent is one more row:
`accent()` returns `ACCENT_THEME`, `accent_row` gives `st.theme_row`, and `minimal_card` stands aside, as Ivory's card
would otherwise leave the colour unused. It's never written to `config.ini`.

**Background.** Light Mode's flip already maps every neutral colour stock and the payload draw, so a background is that
flip from another paper. `st.paper` and `st.ink` hold it per channel, set once in `accent()`: `LIGHT_PAPER` and
`LIGHT_INK`, or the theme's colour and the ink for its luma (`PAPER_LIGHT_MIN`). A light page is Light Mode from there,
as `ipod_light()` answers 1. A dark one answers 0, so tones stay dark-mode's, but `ipod_paper()` still answers 1, which is
what maps colours. Because channels now differ, `flip` is for a color_t and `flip_rgb` for a 0xRRGGBB, or red and blue
swap. Clear colours stay clear, as stock tests for them. On a dark page every colourless theme image flips, which white
glyphs survive and which turns black plates into the page. On a light page a plate stays, as in Light Mode, and so do
the status icons' own colours. Neither this nor the accent is ever saved, and the Theme row's preset leaves those settings be. Limits: Solitaire's cards can't pass a light page's paper, so their faces take its colour; a
card app's own pixels, the video bar and photos aren't touched; `saverscreen_page`'s shade is tinted by the page.

**Battery.** `accent()`'s first read overwrites `st.battery` with `theme_battery()`, so the status bar and the Large
clock need nothing of their own. `st.theme_battery` keeps `setting_click` from saving it: `config.ini` holds your
setting throughout. As ever, `bar_sync` shows the icon when a style won't fit (`BATT_ROOM`).

## Home's sizes and right panel

Home's lines stand on their own, with no `page` line. A theme gives the right panel's pictures a letter each and never a file name, so a theme from someone else can't reach anything but `Q2Pod/images`.

The status bar keeps its height, because stock's pages are laid out to fit exactly under it, so the top panel is Home's own space below it. Stock's card images are style `bg_image`s, which don't scale, so a card a theme sizes shows its picture as the widget's own, at `scale_auto`, and loses stock's pressed picture.

The right panel is Split's art panel. Pictures replace the playing track's cover there, in their order, whatever plays, and one that's gone falls back to the track's. `coverflow_home_art` works out the turn from the clock, so it needs no timer of its own and loads a picture only when its turn comes round. The Studio makes a still a 290 px square, so a change costs no more than a track change. Full and Carousel have no panel, so they show none of this.

A GIF plays in a `gif` widget the panel's size, over the empty art, taking no taps. It draws at the widget's size, and AWTK holds all of a GIF's frames decoded, so the Studio makes a GIF 188 by 290 and drops frames until it comes to about 6 MB decoded, and `home_gif_off` frees it when its turn ends. A GIF put on the card by hand gets none of that, and the start guard above is what stands behind it.

The Library shares a theme's text alone: its pictures stay on the card that has them.

## Tests and the catalogue

`test/theme.py` builds `theme.c` on the host under ASan and UBSan: refused files, what the table refuses, the card
copy's cases and 1500 damaged files. It also checks `tools/theme_catalog.py`'s labels against
`theme.inc`. `test/patch.py` runs the hooks in the patched MIPS payload.

It also runs `ui/eq.js`, the Studio's EQ logic, and `peq.c` on the same files (below), when node is there.

`python3 tools/theme_catalog.py BUILD tools/theme-studio/ui/catalogue.json` writes the Studio's catalogue from a build: each `theme.inc`
row with its friendly name and the widget's geometry in that build. Regenerate it when `theme.inc` or the pages change.

## The theme library

The Studio's **Library** tab reads a public GitHub repository, [`tyleree/q2-themes`](https://github.com/tyleree/q2-themes): `themes/*.txt` and an
`index.json` that its workflow rebuilds with `tools/build_index.py`. There's no server and nothing to sign in to here. The
page fetches both from `raw.githubusercontent.com`, the one host its content security policy allows, and only while the tab
is open.

Sharing is GitHub's own: **Share this theme** opens the repository's new-file page with the file name and text in the link.
Someone without write access gets a fork and a pull request in one step, and that pull request's check runs the same script.
A theme that makes the link too long is copied, for pasting into the page.

A library theme is a stranger's file, so nothing trusts it. The index passes `libraryEntries`: file names can't leave
`themes/`, colours must be colours, and text is only ever set as text. A theme passes `parse`, the same allowlist as any
file, and the firmware has its own, and the bad-start guard above. `open_url` in the exe takes the library's own pages and
nothing else, as a link goes straight to the shell.

## The Studio's EQ tab

The EQ tab needs no firmware of its own: it writes an Equalizer APO `.txt` to `/EQ/` on the card, which **Import from SD
/EQ** already reads ([guide](manual/guide.html#eqimport)). A theme can't carry an EQ, and an EQ never changes without
**Apply changes** on the Q2, so nothing here can change the sound at a start.

`ui/eq.js` takes and refuses what `peq_parse` does, in its words, and draws `peq_compile`'s filters. It writes `LSC` and
`HSC` so the Q2 leaves frequencies alone, numbers to 2 places (Q to 3), and `Channel:` sections for L and R bands. Balance
needs `Preamp:` lines, so Auto with balance is saved as its 48 kHz figure. Its peak matches the Q2's down to DC for Auto,
but warns only from 20 Hz, as a low shelf's boost below that is no reason to expect clipping.

`test/theme.py` writes 500 random presets, a damaged copy of each, the limits and every built-in preset, then checks
that `ui/eq.js` and a host build of `peq.c` agree on every one: the refusal's line and words, or every value, Auto at two
rates and the curve at ten frequencies. What `eq.js` writes back goes through `peq_parse` too, and must stay within 0.05 dB.

**Built-in presets.** `python3 tools/theme_presets.py tools/theme-studio/ui/presets.json` rebuilds `ui/presets.json` from one
AutoEq commit: all 8,850 parametric EQs it publishes, about 5 MB of the exe. A search shows at most 200 rows, and the page
draws them only as the search changes, not on each edit. Before a search it shows 25 popular IEMs (`TOP`, a choice of ours,
as nobody publishes a ranking). Nothing comes from
Hangout.Audio itself: it serves measurements one at a time through an encrypted endpoint, and has no preset files.
