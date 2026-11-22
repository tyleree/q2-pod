/* A theme's lowercase (theme.xml caps="lower", docs/internals.md#themes): the firmware's own words
 * on Home's rows (home.rows.caps), on a page's lists (list.row.caps) and in the bar's title
 * (bar.title.caps), never a song's, album's, artist's, file's or playlist's name. The words stay
 * AWTK's labels, in their own face, box, scroll and ellipsis: only their letters A to Z are made
 * small (script_lower), in the label's own text, before it paints. */
#include "navigation.h"

extern int coverflow_home_owns(void *w);

/* w's text is a firmware word: what its translation key reads, as stock's pages and the payload's
 * widget_set_tr_text write one. A name written over a label that had a key keeps the key (AWTK's
 * widget_set_text leaves tr_text), so the text must still be the key's translation. */
static int tr_word(void *w) {
    const char *key = widget_get_prop_str(w, "tr_text", (const char *)0);
    if (!key || !*key) return 0;
    const char *tr = locale_info_tr(locale_info(), key);
    char now[128];
    return tr && !widget_get_text_utf8(w, now, sizeof now) && !tk_strcmp(now, tr);
}

/* w's own text, its capitals A to Z made small in place: the same length, so AWTK lays it out,
 * clips, scrolls and ends it as it would any text. Stock writing the text again puts its own back,
 * and the next paint folds it again. */
static void text_lower(void *w) {
    for (unsigned *s = (unsigned *)widget_get_text(w); s && *s; ++s) *s = script_lower(*s);
}

/* Before a label paints (ringnav_paint_bg): under home.rows.caps lower, a label of Home's rows;
 * under list.row.caps lower, a firmware word (tr_word) on a list of a page, not a dialog's message
 * or a song's row. A text with no capital left costs a look at its letters. */
void caps_lower(void *w) {
    const theme_t *T = theme();
    if ((T->caps_home != CAPS_LOWER && T->caps_list != CAPS_LOWER) || !w) return;
    const char *type = widget_get_type(w);
    if (tk_strcmp(type, "label") && tk_strcmp(type, "hscroll_label")) return;
    const unsigned *s = widget_get_text(w);
    while (s && *s && script_lower(*s) == *s) ++s;
    if (!s || !*s) return;
    int list = 0;
    for (void *p = P(w, W_PARENT); p && !list; p = P(p, W_PARENT))
        list = !tk_strcmp(widget_get_type(p), "list_view") ||
               !tk_strcmp(widget_get_type(p), "scroll_view");
    if ((T->caps_home == CAPS_LOWER && coverflow_home_owns(w)) ||
        (T->caps_list == CAPS_LOWER && list && tr_word(w)))
        text_lower(w);
}

/* A menu row's text the payload writes (Display's rows, a switch's or a value's), a firmware word:
 * in lowercase under list.row.caps lower, as stock's are. */
void word_text(void *label, const char *s) {
    widget_set_text_utf8(label, s);
    if (theme()->caps_list == CAPS_LOWER) text_lower(label);
}

/* The bar's title t, in lowercase into out (n bytes) under bar.title.caps lower when it is a word:
 * a page's own name (from 0), or what a page's title label from shows while that is a word
 * (tr_word); else t. UTF-8's bytes past ASCII are none of A to Z, so a name's other letters stay.
 */
const char *title_lower(const char *t, void *from, char *out, unsigned n) {
    if (theme()->caps_mark != CAPS_LOWER || (from && !tr_word(from))) return t;
    unsigned i = 0;
    for (; t[i] && i + 1 < n; ++i) out[i] = (char)script_lower((unsigned char)t[i]);
    out[i] = 0;
    return out;
}
