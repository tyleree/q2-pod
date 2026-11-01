/* Card themes (docs/themes.md): a small text file from the card hides, moves, sizes and tints the
 * widgets theme.inc allows, and sets the accent. The file is checked and copied to /mnt/data at a
 * card mount (theme_sync, off the UI thread), and read once at startup, before the first frame, so a
 * theme never changes on a running UI and nothing has to be undone. The parser is plain C, so
 * test/theme.py also builds it on the host (PEQ_HOST). */
#include "peq.h"
#ifndef PEQ_HOST
#include "offsets.inc"
#endif

#ifndef PEQ_ROOT
#define PEQ_ROOT ""
#endif
#define THEME_SRC PEQ_ROOT "/mnt/mmc/Q2Pod/theme.txt"
#define THEME_DST PEQ_ROOT "/mnt/data/q2pod-theme"
#define THEME_BAD THEME_DST ".bad" /* a theme that took a startup down: the card's copy stays out */
#define THEME_TRY THEME_DST ".try" /* on disk through a theme's first seconds: unfinished starts */
#define THEME_MAX 16384
#define THEME_TRY_MS 15000
#define THEME_MIN_SIZE 40
#define THEME_MIN_ICON 16
#define THEME_MIN_LABEL 12
#define THEME_MIN_FONT 8
#define THEME_MAX_FONT 120
#define THEME_MAX_TEXT 40 /* bytes */
/* Home: its rows' height, its top panel's, and Carousel's cards' size */
#define THEME_MIN_ROW 28
#define THEME_MAX_ROW 64
#define THEME_MAX_TOP 120
#define THEME_MIN_CARD 60
#define THEME_MAX_CARD 220
/* Home's right panel: how many pictures take turns, and seconds each */
#define THEME_MAX_ART 24
#define THEME_MIN_TURN 3
#define THEME_MAX_TURN 600

enum { TH_HIDE = 1, TH_MOVE = 2, TH_SIZE = 4, TH_TINT = 8, TH_FONT = 16, TH_TEXT = 32, TH_SCALE = 64 };
static const struct {
    const char *page, *widget;
    unsigned short actions, x0, y0, x1, y1;
} rows[] = {
#define THEME_ROW(page, widget, actions, x0, y0, x1, y1) { page, widget, actions, x0, y0, x1, y1 },
#include "theme.inc"
#undef THEME_ROW
};
#define ROWS (int)(sizeof rows / sizeof *rows)

/* rule[i] is rows[i]'s; on: any rule; tints, fonts: any of those, so a paint without one asks
 * nothing; texts: any rule's text, which points into the file, so it's kept; battery: 1 + the Battery
 * setting a theme picks, 0 none; home_row, home_card, 0 none, home_top 1 + its height, 0 none; art, 0
 * none, art_turn and art_gifs: the right panel's pictures, their seconds, and a bit for each that's a GIF. */
static struct {
    int loaded, on, tints, fonts, texts, has_accent, has_bg, battery, home_row, home_top, home_card, art, art_turn;
    unsigned accent, bg, try_at, art_gifs;
    const char *note;
    struct {
        unsigned flags, tint;
        const char *text;
        short x, y, w, h, font, sized; /* sized: the status bar's font is on, as it passes each second */
    } rule[ROWS];
} th __attribute__((section(".scratch")));

static int row_of(const char *page, const char *widget) {
    for (int i = 0; page && widget && i < ROWS; ++i) /* a widget can have no name */
        if (!strcmp(rows[i].page, page) && !strcmp(rows[i].widget, widget)) return i;
    return -1;
}

/* #rrggbb, whole. */
static int color_of(const char *s, unsigned *rgb) {
    unsigned v = 0;
    if (*s++ != '#') return 0;
    for (int i = 0; i < 6; ++i, ++s) {
        int d = *s >= '0' && *s <= '9'   ? *s - '0'
                : *s >= 'a' && *s <= 'f' ? *s - 'a' + 10
                : *s >= 'A' && *s <= 'F' ? *s - 'A' + 10
                                         : -1;
        if (d < 0) return 0;
        v = v << 4 | (unsigned)d;
    }
    if (*s) return 0;
    *rgb = v;
    return 1;
}

/* An integer of at most four digits, whole. */
static int number_of(const char *s, int *value) {
    int v = 0, n = 0, minus = *s == '-';
    for (s += minus; *s >= '0' && *s <= '9' && n < 5; ++s, ++n) v = v * 10 + (*s - '0');
    if (*s || !n || n > 4) return 0;
    *value = minus ? -v : v;
    return 1;
}

static int clamp_to(int v, int low, int high) { return v > high ? high : v < low ? low : v; }

/* word[2] to end, the rest of the line, whole: words the tokenizer split are joined again. */
static int rest_of_line(char *start, char *end) {
    while (end > start && (!end[-1] || end[-1] == ' ' || end[-1] == '\r')) --end;
    if (end - start > THEME_MAX_TEXT) return 0;
    *end = 0;
    for (char *p = start; p < end; ++p)
        if (!*p) *p = ' ';
    return 1;
}

static void home_line(const char *what, int v) {
    if (!strcmp(what, "rows")) th.home_row = clamp_to(v, THEME_MIN_ROW, THEME_MAX_ROW);
    else if (!strcmp(what, "top")) th.home_top = clamp_to(v, 0, THEME_MAX_TOP) + 1;
    else if (!strcmp(what, "cards")) th.home_card = clamp_to(v, THEME_MIN_CARD, THEME_MAX_CARD);
}

/* The right panel's pictures, a letter each: j a still, g a GIF. Anything else, and no cycle. */
static void art_line(const char *kinds, int seconds) {
    unsigned gifs = 0;
    int n = 0;
    for (; kinds[n]; ++n) {
        if (n == THEME_MAX_ART || (kinds[n] != 'j' && kinds[n] != 'g')) return;
        gifs |= (unsigned)(kinds[n] == 'g') << n;
    }
    th.art = n, th.art_gifs = gifs, th.art_turn = clamp_to(seconds, THEME_MIN_TURN, THEME_MAX_TURN);
}

static void rule_line(char **word, int words, const char *page, char *end) {
    const char *verb = word[0];
    int i = words > 1 ? row_of(page, word[1]) : -1, a, b;
    unsigned rgb, actions = i < 0 ? 0 : rows[i].actions;
    if (!strcmp(verb, "accent")) {
        if (words == 2 && color_of(word[1], &rgb)) th.accent = rgb, th.has_accent = 1;
    } else if (!strcmp(verb, "color")) {
        if (words == 3 && !strcmp(word[1], "bg") && color_of(word[2], &rgb)) th.bg = rgb, th.has_bg = 1;
    } else if (!strcmp(verb, "battery")) {
        static const char *const modes[] = { "icon", "percent", "both", "inside" };
        for (int m = 0; words == 2 && m < 4; ++m)
            if (!strcmp(word[1], modes[m])) th.battery = m + 1;
    } else if (!strcmp(verb, "home")) {
        if (words == 3 && number_of(word[2], &a)) home_line(word[1], a);
    } else if (!strcmp(verb, "homeart")) {
        if (words == 3 && number_of(word[1], &a)) art_line(word[2], a);
    } else if (!strcmp(verb, "hide")) {
        if (words == 2 && actions & TH_HIDE) th.rule[i].flags |= TH_HIDE;
    } else if (!strcmp(verb, "move")) {
        if (words == 4 && actions & TH_MOVE && number_of(word[2], &a) && number_of(word[3], &b))
            th.rule[i].x = (short)a, th.rule[i].y = (short)b, th.rule[i].flags |= TH_MOVE;
    } else if (!strcmp(verb, "size")) {
        if (words == 4 && actions & TH_SIZE && number_of(word[2], &a) && number_of(word[3], &b)) {
            int least = actions & TH_FONT ? THEME_MIN_LABEL : actions & TH_SCALE ? THEME_MIN_ICON : THEME_MIN_SIZE;
            th.rule[i].w = (short)clamp_to(a, least, rows[i].x1 - rows[i].x0);
            th.rule[i].h = (short)clamp_to(b, least, rows[i].y1 - rows[i].y0);
            th.rule[i].flags |= TH_SIZE;
        }
    } else if (!strcmp(verb, "font")) {
        if (words == 3 && actions & TH_FONT && number_of(word[2], &a))
            th.rule[i].font = (short)clamp_to(a, THEME_MIN_FONT, THEME_MAX_FONT), th.rule[i].flags |= TH_FONT;
    } else if (!strcmp(verb, "text")) {
        if (words >= 3 && actions & TH_TEXT && rest_of_line(word[2], end))
            th.rule[i].text = word[2], th.rule[i].flags |= TH_TEXT;
    } else if (!strcmp(verb, "tint")) {
        if (words == 3 && actions & TH_TINT && color_of(word[2], &rgb))
            th.rule[i].tint = rgb, th.rule[i].flags |= TH_TINT;
    }
}

/* Home keeps a main row: Rockbox's may not be there to keep. */
static void keep_home_row(void) {
    int kept = 0;
    for (int i = 0; i < ROWS; ++i)
        kept += !strcmp(rows[i].page, "home_page") && strcmp(rows[i].widget, "btn_rockbox") &&
                !(th.rule[i].flags & TH_HIDE);
    for (int i = 0; !kept && i < ROWS; ++i)
        if (!strcmp(rows[i].page, "home_page")) th.rule[i].flags &= ~(unsigned)TH_HIDE;
}

/* A theme arrives whole: its first line q2theme 1, its last end, so a file cut short by a pulled
 * card is refused rather than read as a shorter theme. */
int theme_whole(const char *text, unsigned n) {
    static const char head[] = "q2theme 1";
    unsigned at = sizeof head - 1;
    if (n > THEME_MAX || strlen(text) != n || n < at || memcmp(text, head, at)) return 0;
    if (text[at] == '\r') ++at;
    if (at >= n || text[at] != '\n') return 0;
    while (n && (text[n - 1] == '\n' || text[n - 1] == '\r' || text[n - 1] == ' ')) --n;
    return n >= 4 && !memcmp(text + n - 4, "\nend", 4);
}

/* Reads text (changing it) into th. Unknown lines, pages and names are skipped, so a newer theme
 * still works here. */
void theme_parse(char *text) {
    const char *page = (char *)0;
    while (*text) {
        char *end = text, *word[5];
        while (*end && *end != '\n') ++end;
        char *next = *end ? end + 1 : end;
        *end = 0;
        int words = 0;
        for (char *p = text; *p && words < 5;) {
            while (*p == ' ' || *p == '\r' || *p == '\t') *p++ = 0;
            if (!*p) break;
            word[words++] = p;
            while (*p && *p != ' ' && *p != '\r' && *p != '\t') ++p;
        }
        if (words == 2 && !strcmp(word[0], "page"))
            page = word[1];
        else if (words)
            rule_line(word, words, page, end);
        text = next;
    }
    keep_home_row();
    for (int i = 0; i < ROWS; ++i) {
        th.on |= th.rule[i].flags != 0;
        th.tints |= (th.rule[i].flags & TH_TINT) != 0;
        th.fonts |= (th.rule[i].flags & TH_FONT) != 0;
        th.texts |= (th.rule[i].flags & TH_TEXT) != 0;
    }
}

int theme_on(void) { return th.on; }
int theme_tints(void) { return th.tints; }
int theme_accent(unsigned *rgb) {
    if (th.has_accent) *rgb = th.accent;
    return th.has_accent;
}
int theme_bg(unsigned *rgb) {
    if (th.has_bg) *rgb = th.bg;
    return th.has_bg;
}
/* The Battery setting's value a theme picks, -1 with none. */
int theme_battery(void) { return th.battery - 1; }
/* Home's row height and card size, 0 with none; its top panel's height, -1 with none. */
int theme_home_row(void) { return th.home_row; }
int theme_home_top(void) { return th.home_top - 1; }
int theme_home_card(void) { return th.home_card; }
/* The pictures that take turns in Home's right panel, 0 with none, and the seconds each one shows. */
int theme_home_art(int *seconds) {
    *seconds = th.art_turn;
    return th.art;
}
/* Whether this turn's picture is a GIF. */
int theme_home_art_gif(unsigned turn) { return th.art_gifs >> turn & 1; }
int theme_hidden(const char *page, const char *widget) {
    int i = th.on ? row_of(page, widget) : -1;
    return i >= 0 && th.rule[i].flags & TH_HIDE;
}
int theme_tint(const char *page, const char *widget, unsigned *rgb) {
    int i = th.tints ? row_of(page, widget) : -1;
    if (i < 0 || !(th.rule[i].flags & TH_TINT)) return 0;
    *rgb = th.rule[i].tint;
    return 1;
}

/* The text size a theme gives this row, 0 with none. */
int theme_font(const char *page, const char *widget) {
    int i = th.fonts ? row_of(page, widget) : -1;
    return i >= 0 && th.rule[i].flags & TH_FONT ? th.rule[i].font : 0;
}
/* The words a theme gives this row, 0 with none. */
const char *theme_text(const char *page, const char *widget) {
    int i = th.texts ? row_of(page, widget) : -1;
    return i >= 0 && th.rule[i].flags & TH_TEXT ? th.rule[i].text : (char *)0;
}

/* Copies a whole theme from the card; 0 with nothing to say, else a toast. The worker's: the UI's
 * table is only read at startup. */
const char *theme_sync(void) {
    if (access(THEME_SRC, 0)) {
        if (access(THEME_DST, 0) && access(THEME_BAD, 0)) return (char *)0;
        unlink(THEME_DST), unlink(THEME_BAD), unlink(THEME_TRY);
        return "Theme removed. Restart to finish";
    }
    unsigned n = 0, old_n = 0, bad_n = 0;
    char *b = read_all(THEME_SRC, THEME_MAX, &n), *old = (char *)0, *bad = (char *)0;
    const char *note = "Theme file can't be used";
    if (b && theme_whole(b, n)) {
        old = read_all(THEME_DST, THEME_MAX, &old_n);
        bad = read_all(THEME_BAD, THEME_MAX, &bad_n);
        if ((old && old_n == n && !memcmp(old, b, n)) || (bad && bad_n == n && !memcmp(bad, b, n)))
            note = (char *)0; /* the same bytes are not written again each boot */
        else if (blob_io(THEME_DST, THEME_DST ".tmp", b, n, 1)) {
            unlink(THEME_BAD), unlink(THEME_TRY); /* the marks were about the old bytes */
            note = "Theme saved. Restart to apply";
        } else {
            unlink(THEME_DST ".tmp");
            note = "Could not save theme";
        }
    }
    free(b), free(old), free(bad);
    return note;
}

#ifndef PEQ_HOST
/* Once, on the first setting read, before the first frame. THEME_TRY counts the starts that never
 * got through a theme's first seconds. One may be a power-off or Rockbox; two in a row and the theme
 * goes, and stays out of a later mount's copy, so a bad theme costs two starts, not every start.
 * With no way to keep count there is no theme. */
void theme_load(void) {
    if (th.loaded) return;
    th.loaded = 1;
    unsigned n = 0;
    char *b = read_all(THEME_TRY, 8, &n), starts = b && n ? b[0] : '0';
    free(b);
    if (starts >= '2') {
        unlink(THEME_TRY);
        if (!rename(THEME_DST, THEME_BAD)) th.note = "Theme turned off after a failed start";
        return;
    }
    b = read_all(THEME_DST, THEME_MAX, &n);
    if (b && theme_whole(b, n)) theme_parse(b);
    if (!th.texts) free(b);
    if (!th.on && !th.has_accent && !th.has_bg && !th.battery && !th.home_row && !th.home_top && !th.home_card &&
        !th.art)
        return;
    ++starts;
    if (blob_io(THEME_TRY, THEME_TRY ".tmp", &starts, 1, 1)) {
        th.try_at = time_now_ms() | 1;
    } else {
        unlink(THEME_TRY ".tmp");
        th.on = th.tints = th.has_accent = th.has_bg = th.battery = 0;
        th.home_row = th.home_top = th.home_card = th.art = 0;
    }
}

/* From power_poll: the guard comes off once a theme has run, and load's note is shown. */
void theme_poll(void) {
    if (th.try_at && time_now_ms() - th.try_at >= THEME_TRY_MS) {
        unlink(THEME_TRY);
        th.try_at = 0;
    }
    const char *note = th.note;
    if (note) th.note = (char *)0, toast(note); /* first: a toast's dialog polls here again */
}

/* w's text at px, in every state it paints in. */
static void set_font(void *w, int px) {
    static const char *const states[] = { "style:normal:font_size", "style:focused:font_size",
                                          "style:disable:font_size" };
    for (int i = 0; i < 3; ++i) widget_set_prop_int(w, states[i], px);
}

/* A row's label, whose row the theme names: its size and words, for labels stock lays out. */
void theme_label(void *label, const char *page, const char *widget) {
    int px = theme_font(page, widget);
    const char *text = theme_text(page, widget);
    if (label && px) set_font(label, px);
    if (label && text) widget_set_text_utf8(label, text);
}

/* The page's hides, moves, sizes and text sizes under root. Hidden means opacity 0 as well, as stock's ticks
 * write visible on some of these, and not sensitive, as stock's hit test ignores visible. Nothing
 * changes what already holds, as the status bar comes here each second. */
void theme_apply(void *root, const char *page) {
    for (int i = 0; th.on && i < ROWS; ++i) {
        unsigned flags = th.rule[i].flags;
        if (!(flags & (TH_HIDE | TH_MOVE | TH_SIZE | TH_FONT)) || strcmp(rows[i].page, page)) continue;
        void *w = widget_lookup(root, rows[i].widget, 1);
        if (!w) continue;
        if (flags & TH_SIZE && (I(w, W_W) != th.rule[i].w || I(w, W_H) != th.rule[i].h)) {
            widget_resize(w, th.rule[i].w, th.rule[i].h);
            if (rows[i].actions & TH_SCALE) image_set_draw_type(w, IMAGE_DRAW_SCALE_AUTO);
        }
        /* Pages are built anew, but the status bar is never rebuilt and comes here each second. */
        if (flags & TH_FONT && !th.rule[i].sized) {
            set_font(w, th.rule[i].font);
            th.rule[i].sized = !strcmp(page, "system_bar");
        }
        if (flags & (TH_MOVE | TH_SIZE)) { /* a size alone stays in the box too */
            /* a box too small for the widget leaves it where it is on that axis */
            int room_x = rows[i].x1 - I(w, W_W), room_y = rows[i].y1 - I(w, W_H);
            int want_x = flags & TH_MOVE ? th.rule[i].x : I(w, W_X),
                want_y = flags & TH_MOVE ? th.rule[i].y : I(w, W_Y);
            int x = room_x < rows[i].x0 ? I(w, W_X) : clamp_to(want_x, rows[i].x0, room_x),
                y = room_y < rows[i].y0 ? I(w, W_Y) : clamp_to(want_y, rows[i].y0, room_y);
            if (I(w, W_X) != x || I(w, W_Y) != y) widget_move(w, x, y);
        }
        /* a widget stock has hidden for now still needs its opacity: stock may show it later */
        if (flags & TH_HIDE && (widget_get_visible(w) || widget_get_prop_int(w, "opacity", 0))) {
            widget_set_visible(w, 0, 0);
            widget_set_opacity(w, 0);
            widget_set_sensitive(w, 0);
        }
    }
}
#endif
