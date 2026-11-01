# Q2 Theme Studio

Recolour, move and remove parts of the interface of a Shanling Q2 running the Q2 Pod firmware, make EQ presets
for it, and share themes with other people, from a Windows PC. There is no coding and no flashing: the app saves small
text files to the microSD card, and the Q2 picks them up. Themes need a Q2 Pod firmware with card themes. EQ presets work
on any Q2 Pod with **Import from SD /EQ**.

The app is one portable .exe. It goes online only for its Library tab, and it holds no Shanling images: the preview is
drawn from scratch.

## Using it

### Themes

1. Run `q2-theme-studio.exe`. Windows 11 already has the WebView2 Runtime it needs. If it is missing,
   the app says so and offers Microsoft's download page.
2. Pick a screen, click anything on it, then change, move, resize or hide it. Text has a size of its own, and Home's rows
   can be reworded. **Colours**, on the right, sets the background to
   any hex colour, with the text turning white or near-black to suit it, and the accent. **Battery** picks how the
   status bar shows the level.
3. Press **Save to Q2**, with the card in a reader or the Q2 in USB storage mode.
4. Safely eject the card and put it back in the Q2, or, if the Q2 is connected by USB, leave USB mode.
   Wait for "Theme saved", then restart the Q2. If "Theme saved" does not appear, your firmware does
   not support card themes yet. The file on the card does no harm.

### Home

Pick **Home** and the right-hand side shows what you can change there.

- **Right panel** is the picture on the right of Home, when Home is set to Split. Add your own images and GIFs with **Add images**,
  or find album covers on the card with **Find albums** and press a star. They take turns in the order you set, for **Seconds
  each**, in place of the playing track's cover, and one picture just stays there. Click a row to see it in the preview.
  **Find albums** sees folders with a cover file, so use **Add images** for art kept inside the music files. A GIF with more
  than about 28 frames loses some, as the Q2 holds them all in memory for its turn.
- **Home sizes** sets row height, top panel height and card size. **Preview as** picks Split, Full or Carousel, which only
  changes the preview: the layout itself is the Q2's Home setting. Rows that don't fit scroll in on the Q2. The top panel is
  space under the status bar, which keeps its own height.

The Library shares a theme's text, so its pictures stay on your card.

### Library

The **Library** tab shows themes other people have shared. Click one to open it in the editor, change it if you like, and
save it to your Q2. **Share this theme** opens a GitHub page with yours filled in: press **Propose changes** to send it in.
That needs a free GitHub account, and the theme appears once it has been checked and merged.

### EQ

1. Open the **EQ** tab. Search the presets for your IEMs or headphones, press **Open…** for an AutoEQ or Equalizer
   APO file, or start from the ten flat bands.
2. Change it if you like. Drag a dot on the curve for frequency and gain, scroll over it for Q, double-click to add a
   band, or use the table. The Q2 takes up to 30 bands, each peak or shelf, on both channels or one.
3. Press **Save to Q2**. The preset goes in the card's `EQ` folder.
4. On the Q2, with a song on Now Playing: hold Play/Pause, choose **EQ**, and pick the preset. It plays straight away.
   That list has your saved presets, then the card's, and **Off**, so it's also how you switch between them.
5. To flip between favourites, press the star on a preset. It goes straight to the card, and **Pinned** keeps them in
   order. On the Q2, tap the **EQ** line under the album on Now Playing for the next one, or open **EQ** on Home and turn the
   wheel. The sound changes as soon as you stop, with the song still playing.

Preamp **Auto** leaves the file without a Preamp line, so the Q2 works the cut out for each song's sample rate.

## Presets

The app holds all 8,850 parametric EQs the [AutoEq](https://github.com/jaakkopasanen/AutoEq) project publishes: 6,036 models
of IEM, headphone and earbud, many of them from more than one measurement, so each row names its source. Before a search it
shows 25 popular IEMs, a choice of ours, as nobody publishes a ranking. The presets aim at AutoEq's targets, and models
newer than its last update, in July 2025, are missing. AutoEq is MIT licensed: see `AUTOEQ-LICENSE.txt`. Its presets come
from measurements by Crinacle, oratory1990, Rtings and others, so check their terms before releasing this list publicly.

## SmartScreen

The exe is not code signed, so Windows SmartScreen may warn about it the first time. Choose
**More info**, then **Run anyway**.

## Building

Needs Rust (msvc toolchain). The UI is embedded in the exe, so there is nothing else to install.

```
cargo build --release
```

The exe is `target\release\q2-theme-studio.exe`, or under `CARGO_TARGET_DIR` if that is set.

Tests:

```
node --test ui/core.test.mjs ui/eq.test.mjs
cargo test
```

`test/theme.py` in the firmware repo also runs `ui/eq.js` and the firmware's `peq.c` on the same files and compares them.

To work on the page without the exe, serve `ui\` with any local web server and open `index.html`. With
no exe around it uses a built-in pretend card (`window.__mock` in the console).

## Files

| Path | What it is |
| --- | --- |
| `src/main.rs` | The window, the card (read, save, remove) and the open and save dialogs |
| `ui/index.html` | The page and its styles |
| `ui/core.js` | Theme logic with no page in it: parse, write, limits, contrast |
| `ui/app.js` | The preview, editing and dialogs |
| `ui/eq.js` | EQ logic with no page in it: parse, write, limits, the curve |
| `ui/eq_page.js` | The EQ tab |
| `ui/library_page.js` | The Library tab |
| `ui/catalogue.json` | What may be changed, generated from the firmware; the app shows the version its screens are based on |
| `ui/presets.json` | The built-in IEM presets, generated by `tools/theme_presets.py` |
