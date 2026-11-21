// The card, for the page on the web. The exe's host (src/main.rs) finds drives and reads and writes
// them; a browser can't, so here the folder the visitor picks stands in as the one drive. Every
// command answers as main.rs does, with the same limits and the same words when it fails. A browser
// without the folder picker (Firefox, Safari) gets no card: its files open and export only.
(function () {
  'use strict';

  const LETTER = 'Q'; // the one "drive": the page's other code names a card by a letter
  const LIBRARY_PAGE = 'https://github.com/tyleree/q2-themes/'; // core.js LIBRARY
  const MAX_THEME_BYTES = 16 * 1024;
  const MAX_EQ_BYTES = 16 * 1024;
  const MAX_EQ_NAME_BYTES = 200;
  const MAX_OPEN_BYTES = 1024 * 1024;
  const MAX_PINS = 32;
  const PINS_HEADER = 'q2eqpins 1';
  const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
  const MAX_COVER_BYTES = 16 * 1024 * 1024;
  const COVER_NAMES = ['cover.jpg', 'folder.jpg', 'cover.png', 'folder.png', 'cover.webp', 'folder.webp'];
  const ALBUM_MAX = 20000;
  const ALBUM_DEPTH = 8;
  const SKIPPED_FOLDERS = ['System Volume Information', 'Q2Pod', 'EQ'];
  const BAD_NAME = /[\u0000-\u001f\u007f<>:"/\\|?*]/;

  const bytesOf = (text) => new TextEncoder().encode(text);
  const missing = (error) => error?.name === 'NotFoundError' || error?.name === 'TypeMismatchError';

  // A bare preset file name the Q2 would list, so nothing here can reach outside the EQ folder.
  function eqFileName(file) {
    const stem = typeof file === 'string' && file.endsWith('.txt') ? file.slice(0, -4) : '';
    const plain = stem !== '' && bytesOf(file).length <= MAX_EQ_NAME_BYTES && !stem.startsWith('.')
      && !/[. ]$/.test(stem) && !BAD_NAME.test(file);
    if (!plain) throw new Error("That is not a preset's file name.");
    return file;
  }

  const isEqFile = (file) => {
    try {
      return Boolean(eqFileName(file));
    } catch {
      return false;
    }
  };

  // artNN.jpg or artNN.gif, and what such a file has to start with.
  function imageKind(name) {
    const found = /^art\d\d\.(jpg|gif)$/.exec(typeof name === 'string' ? name : '');
    if (!found) throw new Error('That is not a name for a Home image.');
    return found[1] === 'jpg' ? [0xff, 0xd8] : [0x47, 0x49, 0x46, 0x38];
  }

  function mimeOf(name) {
    const kind = name.toLowerCase().split('.').pop();
    return `image/${['png', 'gif', 'webp'].includes(kind) ? kind : 'jpeg'}`;
  }

  function dataUrl(name, buffer) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(new Blob([buffer], { type: mimeOf(name) }));
    });
  }

  function fromBase64(text) {
    try {
      const raw = atob(text);
      return Uint8Array.from(raw, (c) => c.charCodeAt(0));
    } catch {
      return null;
    }
  }

  function safeFileName(suggested) {
    const cleaned = Array.from(String(suggested ?? ''), (c) => (BAD_NAME.test(c) ? ' ' : c)).join('');
    return cleaned.trim().replace(/\.+$/, '').trim() || 'theme.txt';
  }

  function writeFailed(error, what) {
    if (['NotAllowedError', 'NoModificationAllowedError', 'SecurityError'].includes(error?.name)) {
      return 'The card would not let this page write to it. Check that it is not locked, and choose the card again.';
    }
    if (error?.name === 'QuotaExceededError') return 'The card is full. Free up a little space and try again.';
    return `The ${what} could not be written to the card. Check that it is still connected.`;
  }

  // One file from the visitor's computer, or null when they close the dialog.
  function pickFile() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.txt,text/plain';
      input.addEventListener('change', () => resolve(input.files[0] ?? null));
      input.addEventListener('cancel', () => resolve(null));
      input.click();
    });
  }

  async function openText(tooBig) {
    const file = await pickFile();
    if (!file) return null;
    if (file.size > MAX_OPEN_BYTES) throw new Error(tooBig);
    try {
      return { name: file.name, text: await file.text() };
    } catch {
      throw new Error('That file could not be opened.');
    }
  }

  // The browser's Save dialog where it has one, else a download; the name it went by, or null.
  async function exportText(text, suggested, what, kind) {
    const name = safeFileName(suggested);
    if (typeof window.showSaveFilePicker === 'function') {
      let handle;
      try {
        handle = await window.showSaveFilePicker({
          id: 'q2export',
          suggestedName: name,
          types: [{ description: kind, accept: { 'text/plain': ['.txt'] } }],
        });
      } catch (error) {
        if (error?.name === 'AbortError') return null;
        throw new Error(`The ${what} could not be saved there.`);
      }
      try {
        const out = await handle.createWritable();
        await out.write(text);
        await out.close();
      } catch {
        throw new Error(`The ${what} could not be saved there.`);
      }
      return handle.name;
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    return name;
  }

  window.Q2WebHost = function () {
    const canPick = typeof window.showDirectoryPicker === 'function';
    let root = null; // the card: a FileSystemDirectoryHandle

    function card(args) {
      if (args.letter !== LETTER) throw new Error('That is not a drive letter.');
      if (!root) throw new Error('The card is not chosen yet.');
      return root;
    }

    // The folder down `parts` from the card, or null when it isn't there and `create` is off.
    async function folder(from, parts, create = false) {
      let at = from;
      for (const part of parts) {
        try {
          at = await at.getDirectoryHandle(part, { create });
        } catch (error) {
          if (!create && missing(error)) return null;
          throw error;
        }
      }
      return at;
    }

    async function fileIn(dir, name) {
      if (!dir) return null;
      try {
        return await (await dir.getFileHandle(name)).getFile();
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
    }

    // A file's text, null when it isn't there; 'big' is thrown for one over the limit.
    async function readText(from, parts, name) {
      const file = await fileIn(await folder(from, parts), name);
      if (!file) return null;
      if (file.size > MAX_OPEN_BYTES) throw new Error('big');
      return file.text();
    }

    // The browser writes to a swap file and puts it in place on close, so a card pulled out half
    // way leaves the old file whole, as main.rs's write_atomic does.
    async function write(from, parts, name, data, what) {
      let out = null;
      try {
        const dir = await folder(from, parts, true);
        out = await (await dir.getFileHandle(name, { create: true })).createWritable();
        await out.write(data);
        await out.close();
      } catch (error) {
        try {
          await out?.abort();
        } catch {
          // Nothing was put in place.
        }
        throw new Error(writeFailed(error, what));
      }
      return true;
    }

    async function has(dir, name, kind) {
      try {
        await (kind === 'folder' ? dir.getDirectoryHandle(name) : dir.getFileHandle(name));
        return true;
      } catch {
        return false;
      }
    }

    // A card that was pulled out reads as no drive, and as itself again once it is back.
    async function drives() {
      if (!root) return [];
      try {
        const isQ2 = (await has(root, 'Q2Pod', 'folder')) || (await has(root, 'update.tar', 'file'))
          || (await has(root, '_library_data', 'folder')) || (await has(root, '_library_data', 'file'));
        // A folder that has gone throws here; one that is merely empty doesn't.
        for await (const name of root.keys()) {
          void name;
          break;
        }
        const label = cardName();
        return [{ letter: LETTER, label, removable: true, isQ2, title: isQ2 ? `${label} (Q2 card)` : label }];
      } catch {
        return [];
      }
    }

    function cardName() {
      const name = (root?.name ?? '').replace(/[\\/]/g, '').trim();
      return name ? `“${name}”` : 'The card';
    }

    async function readTheme(args) {
      try {
        return await readText(card(args), ['Q2Pod'], 'theme.txt');
      } catch (error) {
        throw new Error(error.message === 'big' ? 'The theme on this card is too big to open.' : 'The theme on this card could not be read.');
      }
    }

    function saveTheme(args) {
      const from = card(args);
      const text = String(args.text ?? '');
      if (bytesOf(text).length > MAX_THEME_BYTES) throw new Error('This theme is over the 16 KB limit.');
      if (!text.startsWith('q2theme 1\n') || !text.endsWith('\nend\n')) {
        throw new Error('This theme is not complete, so it was not saved.');
      }
      return write(from, ['Q2Pod'], 'theme.txt', text, 'theme');
    }

    async function removeTheme(args) {
      const dir = await folder(card(args), ['Q2Pod']).catch(() => {
        throw new Error('The theme could not be removed from this card. Check that it is not locked.');
      });
      if (!dir) return false;
      try {
        await dir.removeEntry('theme.txt');
        return true;
      } catch (error) {
        if (missing(error)) return false;
        throw new Error('The theme could not be removed from this card. Check that it is not locked.');
      }
    }

    async function eqList(args) {
      const taken = [];
      try {
        const dir = await folder(card(args), ['EQ']);
        if (!dir) return { names: [], taken: [] };
        for await (const [name, handle] of dir.entries()) taken.push([name, handle.kind === 'file']);
      } catch (error) {
        if (error.message === 'The card is not chosen yet.' || error.message === 'That is not a drive letter.') throw error;
        throw new Error("The card's EQ folder could not be read.");
      }
      const lower = (name) => name.toLowerCase();
      taken.sort((a, b) => (lower(a[0]) < lower(b[0]) ? -1 : lower(a[0]) > lower(b[0]) ? 1 : 0));
      return {
        names: taken.filter(([name, file]) => file && isEqFile(name)).map(([name]) => name),
        taken: taken.map(([name]) => name),
      };
    }

    async function eqRead(args) {
      const from = card(args);
      const file = eqFileName(args.file);
      let text = null;
      try {
        text = await readText(from, ['EQ'], file);
      } catch (error) {
        throw new Error(error.message === 'big' ? 'This preset is too big to open.' : 'This preset could not be read from the card.');
      }
      if (text === null) throw new Error('This preset could not be read from the card.');
      return text;
    }

    function eqSave(args) {
      const from = card(args);
      const file = eqFileName(args.file);
      const text = String(args.text ?? '');
      if (bytesOf(text).length > MAX_EQ_BYTES) throw new Error('This preset is over the 16 KB limit.');
      return write(from, ['EQ'], file, text, 'preset');
    }

    // What the Q2 would read of a pins file; one that isn't ours pins nothing.
    async function eqPins(args) {
      let text = null;
      try {
        text = await readText(card(args), ['Q2Pod'], 'eq-pins.txt');
      } catch {
        throw new Error('The pinned presets could not be read from this card.');
      }
      if (text === null) return [];
      const lines = text.split('\n').map((line) => line.replace(/\r$/, ''));
      if (lines.at(-1) === '') lines.pop();
      if (lines.shift() !== PINS_HEADER) return [];
      return lines.filter((name) => isEqFile(`${name}.txt`));
    }

    function eqPinsSave(args) {
      const from = card(args);
      if (!Array.isArray(args.names)) throw new Error('The pins are missing.');
      if (args.names.length > MAX_PINS) throw new Error(`Up to ${MAX_PINS} presets can be pinned.`);
      for (const name of args.names) eqFileName(`${typeof name === 'string' ? name : ''}.txt`);
      const text = `${PINS_HEADER}\n${args.names.map((name) => `${name}\n`).join('')}`;
      return write(from, ['Q2Pod'], 'eq-pins.txt', text, 'pinned list');
    }

    function imageSave(args) {
      const from = card(args);
      const magic = imageKind(args.name);
      const bytes = fromBase64(String(args.data ?? ''));
      if (!bytes) throw new Error('That image could not be read.');
      if (bytes.length > MAX_IMAGE_BYTES) throw new Error('This image is still too big for the Q2 after shrinking it.');
      if (!magic.every((byte, at) => bytes[at] === byte)) throw new Error('That image could not be read.');
      return write(from, ['Q2Pod', 'images'], args.name, bytes, 'image');
    }

    async function imageRead(args) {
      const from = card(args);
      imageKind(args.name);
      try {
        const file = await fileIn(await folder(from, ['Q2Pod', 'images']), args.name);
        return file ? await dataUrl(args.name, await file.arrayBuffer()) : null;
      } catch {
        throw new Error('This image could not be read from the card.');
      }
    }

    // Every folder with a cover the Q2 would use, by name; art inside the music files isn't seen.
    async function findAlbums(dir, parts, found) {
      const folders = [];
      let cover = null;
      try {
        for await (const [name, handle] of dir.entries()) {
          if (handle.kind === 'directory') {
            if (!/^[._$]/.test(name) && !SKIPPED_FOLDERS.includes(name)) folders.push([name, handle]);
          } else if (!cover && COVER_NAMES.includes(name.toLowerCase())) {
            cover = name;
          }
        }
      } catch {
        return;
      }
      if (cover && parts.length) found.push({ path: [...parts, cover].join('/'), name: parts.join(' / ') });
      folders.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      for (const [name, handle] of folders) {
        if (parts.length < ALBUM_DEPTH && found.length < ALBUM_MAX) await findAlbums(handle, [...parts, name], found);
      }
    }

    async function albums(args) {
      const found = [];
      await findAlbums(card(args), [], found);
      return found;
    }

    // A cover findAlbums listed: a plain path down the card, ending in a cover's name.
    async function albumArt(args) {
      const from = card(args);
      const parts = String(args.path ?? '').split(/[\\/]/);
      const plain = parts.length > 0 && parts.every((part) => part && part !== '.' && part !== '..')
        && COVER_NAMES.includes(parts.at(-1).toLowerCase());
      if (!plain) throw new Error('That is not an album cover.');
      let file = null;
      try {
        file = await fileIn(await folder(from, parts.slice(0, -1)), parts.at(-1));
      } catch {
        file = null;
      }
      if (!file) throw new Error('This cover could not be read from the card.');
      if (file.size > MAX_COVER_BYTES) throw new Error('This cover is too big to open.');
      try {
        return await dataUrl(parts.at(-1), await file.arrayBuffer());
      } catch {
        throw new Error('This cover could not be read from the card.');
      }
    }

    async function importFile(tooBig, whole) {
      const file = await openText(tooBig);
      return file && (whole ? file : file.text);
    }

    function openUrl(args) {
      const url = String(args.url ?? '');
      if (!url.startsWith(LIBRARY_PAGE) || !/^[\x21-\x7e]+$/.test(url)) throw new Error('That is not a page of the theme library.');
      window.open(url, '_blank', 'noopener');
      return true;
    }

    const commands = {
      drives,
      read_theme: readTheme,
      save_theme: saveTheme,
      remove_theme: removeTheme,
      import_theme: () => importFile('That file is too big to be a theme.', false),
      export_theme: (args) => exportText(String(args.text ?? ''), args.suggested, 'theme', 'Theme file'),
      open_url: openUrl,
      eq_list: eqList,
      eq_read: eqRead,
      eq_save: eqSave,
      eq_pins: eqPins,
      eq_pins_save: eqPinsSave,
      image_save: imageSave,
      image_read: imageRead,
      albums,
      album_art: albumArt,
      import_eq: () => importFile('That file is too big to be an EQ preset.', true),
      export_eq: (args) => exportText(String(args.text ?? ''), args.suggested, 'preset', 'EQ preset'),
      close_now: () => true, // a browser tab closes itself; app.js asks first when work is unsaved
      close_held: () => true,
    };

    return {
      web: true,
      canPick,
      async call(cmd, args = {}) {
        if (!Object.hasOwn(commands, cmd)) throw new Error('The app asked for something it does not know.');
        return commands[cmd](args);
      },
      // Asks for the card's folder. Needs a click behind it; false when the visitor backs out.
      async pick() {
        if (!canPick) return false;
        try {
          root = await window.showDirectoryPicker({ id: 'q2card', mode: 'readwrite' });
          return true;
        } catch (error) {
          if (error?.name === 'AbortError') return false;
          throw new Error('That folder could not be opened. Choose the drive of the Q2\'s card.');
        }
      },
      // For trying the page with no card: a private folder kept by the browser stands in for one.
      async useBrowserFolder() {
        root = await navigator.storage.getDirectory();
      },
      at: () => cardName().replace(/^The card$/, 'the card'),
      drive: () => cardName().replace(/^The card$/, 'the card'),
    };
  };
})();
