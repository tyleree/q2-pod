"""Q2 Z (THEME 4): big thin lowercase type on black. Its text selection (SEL_TEXT), the firmware's words in lowercase
(lowercase.c) and its thin face. Its pivot bar is an asset's layout (test/unit/test_ipod.py); Modern's flat screens, which
it takes as they are, are test_flat_pages' and test_flat_dialogs'."""
import ctypes as C

import pytest

from test_nav_painters import THEMES, MODERN, Page, Scheme, Ui, layout, library, rgba, text_ink, theme  # noqa: F401 (fixtures, by name)

Q2_Z = next(i for i, t in enumerate(THEMES) if t['name'] == 'Q2 Z')
WHITE, GREY = 0xffffff, 0xaaaaaa


def test_no_fill_goes_under_the_selected_row_its_ink_is_the_selection(fw, st, layout):
    """Magenta's ink on the selected row, every other row of the list grey, nothing filled behind them."""
    page = Page(fw, Q2_Z)
    page.paint()
    S = Scheme(fw, layout)
    assert page.band() == {} and page.canvas.boxes == [] and S.sel_text == 0xff1aa6
    assert [text_ink(fw, st, page.rows[k].children[0]) for k in range(4)] == [rgba(GREY), rgba(S.sel_text), rgba(GREY), rgba(GREY)]


def test_a_touch_leaves_every_row_in_its_own_ink(fw, st, layout):
    """Touch hides the selection (no row loaded as selected): no row greyed, none lit."""
    page = Page(fw, Q2_Z)
    st('touch_mode').value = 1
    page.paint()
    assert page.band() == {} and [text_ink(fw, st, page.rows[k].children[0]) for k in range(4)] == [rgba(WHITE)] * 4


def test_modern_s_bar_is_as_before(fw, st, layout):
    page = Page(fw, MODERN)
    page.paint()
    assert page.band() and text_ink(fw, st, page.rows[2].children[0]) == rgba(WHITE)  # no grey off the bar


class Words:
    """A label's text as AWTK holds it (its own buffer, which caps_lower folds) and what stock's language reads its
    translation key as."""
    def __init__(self, fw, ui, tr=None):
        self.ui, self.tr = ui, dict(tr or {})
        self.cstr = {}
        fw.mock('locale_info', lambda *_: 1)
        fw.mock('locale_info_tr', lambda info, key, *_: self.c(self.tr.get(C.string_at(key).decode(), C.string_at(key).decode())))
        fw.mock('widget_get_text_utf8', self.utf8)

    def c(self, s):
        self.cstr.setdefault(s, C.create_string_buffer(s.encode()))
        return C.addressof(self.cstr[s])

    def utf8(self, w, out, size, *_):
        node = self.ui.nodes.get(w)
        if node is None:
            return 1
        data = self.ui.text(node).encode()[:size - 1]
        C.memmove(out, data + b'\0', len(data) + 1)
        return 0

    def shown(self, node):
        """What the label draws now: its buffer."""
        return ''.join(map(chr, node.wide[:len(node.text)]))


def rows(fw, ui, titles, keys):
    """A Library page's rows (library()), each title's label given its translation key, None for none."""
    view, buttons = library(fw, ui, len(titles), titles=titles)
    labels = [b.children[0] for b in buttons]
    for label, key in zip(labels, keys):
        if key:
            label.props['tr_text'] = key
    return view, labels


def caps_lower(fw, w):
    fw.fn('caps_lower', None, C.c_void_p)(w.addr)


def test_the_firmware_s_words_on_a_list_are_lowercase_and_a_name_keeps_its_case(fw):
    """A row whose text is still its key's translation is a word; one a name was written over (the key kept, as AWTK's
    widget_set_text keeps it) and one with no key are names. Only A to Z fold: É and Ä stay."""
    theme(fw, Q2_Z)
    ui = Ui(fw)
    words = Words(fw, ui, {'localmusic_album': 'Albums', 'localmusic_artist': 'Artists', 'about_version': 'Über Version'})
    _, labels = rows(fw, ui, ['Albums', 'Pink Floyd', 'ÉCLAIR Mix', 'Über Version'], ['localmusic_album', 'localmusic_artist', None, 'about_version'])
    for label in labels:
        caps_lower(fw, label)
    assert [words.shown(label) for label in labels] == ['albums', 'Pink Floyd', 'ÉCLAIR Mix', 'Über version']


@pytest.mark.parametrize('number', [MODERN, 0, 1, 3])
def test_no_other_theme_folds_a_word(fw, number):
    theme(fw, number)
    ui = Ui(fw)
    words = Words(fw, ui, {'localmusic_album': 'Albums'})
    _, labels = rows(fw, ui, ['Albums'], ['localmusic_album'])
    caps_lower(fw, labels[0])
    assert words.shown(labels[0]) == 'Albums'


def test_a_word_off_a_list_keeps_its_case(fw):
    """A dialog's message or a page's own label with a key is no menu row: list.row.caps is a list's."""
    theme(fw, Q2_Z)
    ui = Ui(fw)
    words = Words(fw, ui, {'delete_song': 'Delete Song?'})
    label = ui.add('label', ui.window('confirm_dialog', kind='dialog'), (0, 0, 300, 40), 'label_msg', tr_text='delete_song')
    ui.set_text(label, 'Delete Song?')
    caps_lower(fw, label)
    assert words.shown(label) == 'Delete Song?'


@pytest.mark.parametrize('number, want', [(Q2_Z, 'theme: q2 z'), (MODERN, 'Theme: Q2 Z')])
def test_the_payload_s_menu_rows_are_lowercase(fw, number, want):
    """word_text, the payload's own rows' writer (Display's, a switch's, a value's): its words, folded."""
    theme(fw, number)
    ui = Ui(fw)
    Words(fw, ui)
    label = ui.add('label', ui.window('display_page'), (0, 0, 300, 40), 'label')
    fw.fn('word_text', None, C.c_void_p, C.c_char_p)(label.addr, b'Theme: Q2 Z')
    assert ''.join(map(chr, label.wide[:len(label.text)])) == want


@pytest.mark.parametrize('t, from_word, want', [('Now Playing', None, 'now playing'), ('Q2 Pod', None, 'q2 pod'),
                                                ('Albums', True, 'albums'), ('Pink Floyd', False, 'Pink Floyd'),
                                                ('Café Del Mar', False, 'Café Del Mar')])
def test_the_bar_s_title_is_lowercase_when_it_is_a_word(fw, t, from_word, want):
    """A page's own name (from none) or its title label's word; a name in the title label (an artist's albums) keeps
    its case, as AWTK's widget_set_text keeps the key it replaced."""
    theme(fw, Q2_Z)
    ui = Ui(fw)
    Words(fw, ui, {'localmusic_album': 'Albums'})
    label = 0
    if from_word is not None:
        node = ui.add('hscroll_label', ui.window('localclass_page'), (0, 0, 300, 40), 'scrlabel_title', tr_text='localmusic_album')
        ui.set_text(node, t)
        label = node.addr
    out = C.create_string_buffer(256)
    got = fw.fn('title_lower', C.c_char_p, C.c_char_p, C.c_void_p, C.c_char_p, C.c_uint)(t.encode(), label, out, 256)
    assert got.decode() == want


def test_the_bar_s_title_keeps_its_case_under_another_theme(fw):
    theme(fw, MODERN)
    out = C.create_string_buffer(256)
    assert fw.fn('title_lower', C.c_char_p, C.c_char_p, C.c_void_p, C.c_char_p, C.c_uint)(b'Now Playing', 0, out, 256) == b'Now Playing'


def test_the_thin_face_falls_to_stock_s_regular_one_with_no_bold_pass(fw):
    """Q2 Z's rows in thin.ttf; a title it lacks a letter of (CJK) in stock's face at its own px, not marked bold."""
    theme(fw, Q2_Z)
    ui = Ui(fw)
    label = ui.add('hscroll_label', ui.window('localmusic_page'), (0, 0, 300, 40), 'title')
    font = fw.fn('theme_font', C.c_int, C.c_void_p, C.c_int, C.c_int)
    for text, face in (('Albums', 'thin'), ('专辑', 'default')):
        ui.set_text(label, text)
        label.props.pop('_q2_bold_fallback', None)
        font(label.addr, 0, -1)  # ROLE_TITLE
        assert label.props['style:normal:font_name'] == face and label.props['style:normal:font_size'] == 26
        assert label.props.get('_q2_bold_fallback', 0) == 0
