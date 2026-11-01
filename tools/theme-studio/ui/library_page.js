// The Library tab: themes people have shared, read from the library's public repository, and a way to
// share this one. A shared theme is data from a stranger: it reaches the editor only through
// core.parse, and its index only through core.libraryEntries, and nothing here builds markup from it.
(function () {
  'use strict';

  const core = window.Q2Core;
  const $ = (id) => document.getElementById(id);
  const FETCH_MS = 15000;
  const FALLBACK_INK = '#ffffff';
  const FALLBACK_BAR = '#eeeeec';

  window.Q2LibraryPage = function make(host, { base, cat, toast, notice, openText, themeNow, setAuthor }) {
    let entries = [];
    let loading = false;

    async function getText(path) {
      const stop = new AbortController();
      const timer = setTimeout(() => stop.abort(), FETCH_MS);
      try {
        const reply = await fetch(`${base}${path}`, { signal: stop.signal, cache: 'no-cache' });
        if (!reply.ok) throw new Error(`HTTP ${reply.status}`);
        return await reply.text();
      } finally {
        clearTimeout(timer);
      }
    }

    function card(entry) {
      const page = entry.bg ? core.palette(entry.bg) : null;
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'lib-card';
      open.dataset.file = entry.file;
      const swatch = document.createElement('div');
      swatch.className = 'swatch';
      swatch.style.background = entry.bg ?? '#000000';
      swatch.style.color = page ? core.flip(FALLBACK_INK, page) : FALLBACK_INK;
      const sample = document.createElement('span');
      sample.textContent = 'Now Playing';
      const bar = document.createElement('i');
      bar.style.background = entry.accent ?? FALLBACK_BAR;
      swatch.append(sample, bar);
      const name = document.createElement('span');
      name.className = 'lib-name';
      name.textContent = entry.name;
      const author = document.createElement('span');
      author.className = 'note';
      author.textContent = entry.author ? `by ${entry.author}` : ' ';
      open.append(swatch, name, author);
      return open;
    }

    function render() {
      const grid = $('libGrid');
      const found = core.librarySearch(entries, $('libSearch').value);
      grid.textContent = '';
      grid.append(...found.map(card));
      $('libCount').textContent = entries.length ? `${found.length} of ${entries.length}` : '';
    }

    function say(message) {
      $('libNote').textContent = message;
      $('libNote').hidden = !message;
    }

    async function refresh() {
      if (loading) return;
      loading = true;
      $('libRefresh').disabled = true;
      say('Loading the library…');
      try {
        entries = core.libraryEntries(JSON.parse(await getText('index.json')));
        say(entries.length ? '' : 'The library has no themes yet. Yours could be the first.');
      } catch {
        say('The library could not be reached. Check your internet connection, then press Refresh.');
      }
      loading = false;
      $('libRefresh').disabled = false;
      render();
    }

    async function open(file) {
      try {
        openText(await getText(`themes/${file}`));
      } catch {
        notice('This theme could not be opened', 'It could not be downloaded. Check your internet connection and try again.');
      }
    }

    function syncShare() {
      const named = core.cleanName(themeNow().name);
      const text = named ? core.serialize(core.shareable({ ...themeNow(), author: $('shareAuthor').value }), cat) : '';
      const file = named ? core.shareFile(named, $('shareAuthor').value) : '';
      const pictures = themeNow().art;
      $('shareName').textContent = named || 'This theme has no name yet.';
      $('shareGo').disabled = !named;
      $('shareNote').textContent = [
        named && !core.shareUrl(text, file) ? 'This theme is too long to fill in by itself. It is copied when you press the button: paste it into the page.' : '',
        pictures ? 'Its right panel pictures stay on your card. Everyone else gets the colours, sizes and layout.' : '',
      ].filter(Boolean).join(' ');
    }

    function openShare() {
      $('shareAuthor').value = themeNow().author ?? '';
      $('shareError').hidden = true;
      syncShare();
      $('dlgShare').showModal();
    }

    async function share() {
      const author = core.cleanName($('shareAuthor').value);
      setAuthor(author);
      const theme = { ...themeNow(), author };
      const text = core.serialize(core.shareable(theme), cat);
      const file = core.shareFile(theme.name, author);
      const url = core.shareUrl(text, file);
      try {
        if (!url) await navigator.clipboard.writeText(text);
        await host.call('open_url', { url: url ?? core.sharePage(file) });
      } catch (error) {
        $('shareError').textContent = error.message;
        $('shareError').hidden = false;
        return;
      }
      $('dlgShare').close();
      toast(url ? 'On the GitHub page, press Propose changes to send it in.' : 'Paste the theme into the GitHub page, then press Propose changes.');
    }

    function bind() {
      $('libSearch').addEventListener('input', render);
      $('libRefresh').addEventListener('click', refresh);
      $('libShare').addEventListener('click', openShare);
      $('libGrid').addEventListener('click', (event) => {
        const row = event.target.closest('[data-file]');
        if (row) open(row.dataset.file);
      });
      $('shareAuthor').addEventListener('input', syncShare);
      $('shareCancel').addEventListener('click', () => $('dlgShare').close());
      $('shareGo').addEventListener('click', share);
    }

    bind();
    return {
      show: () => {
        if (!entries.length) refresh();
      },
    };
  };
})();
