/* What a card theme may touch (docs/themes.md), and so all a hand-edited theme can reach. One row per
 * widget: page, name, actions, then the box it stays in, x0 y0 x1 y1, in its parent's coordinates.
 * tools/theme_catalog.py reads this file for Q2 Theme Studio's catalogue. Rows that only hide or tint
 * have an empty box. TH_FONT is the text size, TH_TEXT rewords a row, and TH_SCALE is an image that scales to its size. Left out on purpose: list rows and repeated names, as widget_lookup finds only the
 * first (Home's btn_* repeat in the carousel, so coverflow_home_layout looks under its list), img_more
 * (the only route to the More page on Tidal), img_state, label_idle and view_battery (bar_sync writes
 * them while painting), img_repeata and img_repeatb (stock places them), Quick Settings. */
THEME_ROW("playing_page", "img_cover", TH_HIDE | TH_MOVE | TH_SIZE, 0, 0, 375, 186)
THEME_ROW("playing_page", "scrlabel_title", TH_HIDE | TH_MOVE | TH_SIZE | TH_FONT | TH_TINT, 0, 0, 375, 186)
THEME_ROW("playing_page", "scrlabel_artist", TH_HIDE | TH_MOVE | TH_SIZE | TH_FONT | TH_TINT, 0, 0, 375, 186)
THEME_ROW("playing_page", "label_ipod_album", TH_HIDE | TH_MOVE | TH_SIZE | TH_FONT | TH_TINT, 0, 0, 375, 186)
THEME_ROW("playing_page", "view_eqchip", TH_HIDE | TH_MOVE, 0, 0, 375, 186)
THEME_ROW("playing_page", "img_playmode", TH_HIDE | TH_MOVE | TH_SIZE | TH_SCALE, 0, 0, 375, 186)
THEME_ROW("playing_page", "img_fav", TH_HIDE | TH_MOVE | TH_SIZE | TH_SCALE, 0, 0, 375, 186)
/* Left of img_more: this label is above it in the hit test, so over it, it would take More's tap. */
THEME_ROW("playing_page", "label_ipod_pos", TH_HIDE | TH_MOVE | TH_SIZE | TH_FONT | TH_TINT, 0, 0, 303, 40)
/* vol_paint's band runs from the slider's top (233) to the lower label's bottom, and its bar sits at
 * about 253: these keep the bar inside the band, and clear of the slide view above. */
THEME_ROW("playing_page", "label_playtime", TH_HIDE | TH_MOVE | TH_SIZE | TH_FONT | TH_TINT, 0, 245, 375, 290)
THEME_ROW("playing_page", "label_ipod_remain", TH_HIDE | TH_MOVE | TH_SIZE | TH_FONT | TH_TINT, 0, 245, 375, 290)
/* A-B's markers stay at stock's place on the bar; vol_paint follows it. */
THEME_ROW("playing_page", "slider_play", TH_HIDE | TH_MOVE | TH_SIZE, 0, 226, 375, 290)
THEME_ROW("playing_page", "slide_indicator1", TH_HIDE, 0, 0, 0, 0)
/* Stock's tick shows these three again each second: ringnav_showface hides them each time. */
THEME_ROW("system_bar", "label_eq", TH_HIDE | TH_FONT, 0, 0, 0, 0)
THEME_ROW("system_bar", "img_bt", TH_HIDE, 0, 0, 0, 0)
THEME_ROW("system_bar", "img_wifi", TH_HIDE, 0, 0, 0, 0)
THEME_ROW("system_bar", "label_clock", TH_HIDE | TH_MOVE | TH_SIZE | TH_FONT | TH_TINT, 0, 0, 375, 30)
/* Home's main rows; coverflow_home_layout hides them, last in the list so the others close up, and
 * gives their labels the size and words. The list fixes their height. */
THEME_ROW("home_page", "btn_playing", TH_HIDE | TH_FONT | TH_TEXT, 0, 0, 0, 0)
THEME_ROW("home_page", "btn_localmusic", TH_HIDE | TH_FONT | TH_TEXT, 0, 0, 0, 0)
THEME_ROW("home_page", "btn_coverflow", TH_HIDE | TH_FONT | TH_TEXT, 0, 0, 0, 0)
THEME_ROW("home_page", "btn_folder", TH_HIDE | TH_FONT | TH_TEXT, 0, 0, 0, 0)
THEME_ROW("home_page", "btn_eq", TH_HIDE | TH_FONT | TH_TEXT, 0, 0, 0, 0)
THEME_ROW("home_page", "btn_rockbox", TH_HIDE | TH_FONT | TH_TEXT, 0, 0, 0, 0)
THEME_ROW("home_page", "btn_stream", TH_HIDE | TH_FONT | TH_TEXT, 0, 0, 0, 0)
THEME_ROW("home_page", "btn_settings", TH_HIDE | TH_FONT | TH_TEXT, 0, 0, 0, 0)
THEME_ROW("saverscreen_page", "view_timeinfo", TH_HIDE, 0, 0, 0, 0)
THEME_ROW("saverscreen_page", "clock_time", TH_HIDE | TH_SIZE | TH_FONT | TH_TINT, 0, 0, 375, 103)
THEME_ROW("saverscreen_page", "clock_date", TH_HIDE | TH_SIZE | TH_FONT | TH_TINT, 0, 0, 375, 103)
THEME_ROW("saverscreen_page", "label_battery", TH_HIDE | TH_SIZE | TH_FONT | TH_TINT, 0, 0, 375, 103)
THEME_ROW("saverscreen_page", "img_battery", TH_HIDE, 0, 0, 0, 0)
THEME_ROW("saverscreen_page", "view_playinfo", TH_HIDE | TH_MOVE | TH_SIZE, 0, 0, 375, 320)
THEME_ROW("saverscreen_page", "scrlabel_title", TH_HIDE | TH_SIZE | TH_FONT | TH_TINT, 0, 0, 335, 80)
THEME_ROW("saverscreen_page", "scrlabel_artist", TH_HIDE | TH_SIZE | TH_FONT | TH_TINT, 0, 0, 335, 80)
THEME_ROW("saverscreen_page", "img_slide", TH_HIDE | TH_MOVE | TH_SIZE | TH_SCALE, 0, 0, 375, 320)
