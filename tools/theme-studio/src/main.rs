// Q2 Theme Studio: a small window around the embedded page in ui/. The page does all the theme work;
// this file gives it the card (read, write, remove) and the native open and save dialogs.
#![windows_subsystem = "windows"]

use std::borrow::Cow;
use std::fs;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tao::dpi::{LogicalSize, PhysicalPosition, PhysicalSize};
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder, EventLoopProxy};
use tao::window::{Icon, Theme, Window, WindowBuilder};
use windows_sys::Win32::Foundation::MAX_PATH;
use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW};
use windows_sys::Win32::System::Diagnostics::Debug::{SetErrorMode, SEM_FAILCRITICALERRORS};
use windows_sys::Win32::System::WindowsProgramming::{DRIVE_FIXED, DRIVE_REMOVABLE};
use windows_sys::Win32::UI::Shell::ShellExecuteW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    MessageBoxW, IDYES, MB_ICONERROR, MB_ICONINFORMATION, MB_OK, MB_YESNO, SW_SHOWNORMAL,
};
use wry::http::{header::CONTENT_TYPE, Request, Response, StatusCode};
use wry::{NewWindowResponse, WebContext, WebViewBuilder, WebViewBuilderExtWindows};

const INDEX_HTML: &str = include_str!("../ui/index.html");
const CORE_JS: &str = include_str!("../ui/core.js");
const EQ_JS: &str = include_str!("../ui/eq.js");
const EQ_PAGE_JS: &str = include_str!("../ui/eq_page.js");
const LIBRARY_PAGE_JS: &str = include_str!("../ui/library_page.js");
const APP_JS: &str = include_str!("../ui/app.js");
const CATALOGUE: &str = include_str!("../ui/catalogue.json");
const PRESETS: &str = include_str!("../ui/presets.json");

const APP_NAME: &str = "Q2 Theme Studio";
const ORIGIN: &str = "http://app.localhost/";
const WEBVIEW2_PAGE: &str = "https://developer.microsoft.com/microsoft-edge/webview2/";
const LIBRARY_PAGE: &str = "https://github.com/tyleree/q2-themes/"; // ui/core.js LIBRARY
const START_SIZE: (f64, f64) = (1340.0, 860.0);
const MIN_SIZE: (f64, f64) = (1100.0, 700.0);
const MAX_THEME_BYTES: usize = 16 * 1024;
const MAX_EQ_BYTES: usize = 16 * 1024; // patch/peq.h PEQ_FILE_LIMIT
const MAX_EQ_NAME_BYTES: usize = 200;
const MAX_OPEN_BYTES: u64 = 1024 * 1024;
const MAX_PINS: usize = 32; // ui/eq_page.js PINS_MAX
const PINS_HEADER: &str = "q2eqpins 1"; // patch/peq_ui.c quick_pins
const MAX_IMAGE_BYTES: usize = 2 * 1024 * 1024;
const MAX_COVER_BYTES: u64 = 16 * 1024 * 1024;
const COVER_NAMES: [&str; 6] = ["cover.jpg", "folder.jpg", "cover.png", "folder.png", "cover.webp", "folder.webp"]; // patch/coverflow.c
const ALBUM_MAX: usize = 20000;
const ALBUM_DEPTH: usize = 8;
const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

enum UserEvent {
    Ipc(String),
    Reply { id: u64, result: Result<Value, String> },
    Close { now: bool },
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn message_box(text: &str, style: u32) -> i32 {
    let (text, title) = (wide(text), wide(APP_NAME));
    unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), style) }
}

/// Without the WebView2 runtime there is no page to show, so ask here and offer its download page.
fn open_in_browser(url: &str) -> bool {
    let (verb, page) = (wide("open"), wide(url));
    let opened = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            page.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    opened as usize > 32
}

/// The page asks for its library's pages and nothing else: a link goes straight to the shell, so
/// it can't be anything a shell would run.
fn library_url(url: &str) -> Result<&str, String> {
    let plain = url.starts_with(LIBRARY_PAGE) && url.chars().all(|c| c.is_ascii_graphic());
    if plain { Ok(url) } else { Err("That is not a page of the theme library.".into()) }
}

fn webview_missing() {
    let text = format!(
        "{APP_NAME} needs the Microsoft Edge WebView2 Runtime, which is not on this computer yet.\n\n\
         It is free and comes from Microsoft:\n{WEBVIEW2_PAGE}\n\n\
         Open the download page now?"
    );
    if message_box(&text, MB_YESNO | MB_ICONINFORMATION) == IDYES {
        open_in_browser(WEBVIEW2_PAGE);
    }
}

fn drive_root(letter: char) -> PathBuf {
    PathBuf::from(format!("{letter}:\\"))
}

fn letter_arg(args: &Value) -> Result<char, String> {
    let text = args.get("letter").and_then(Value::as_str).unwrap_or("");
    let mut chars = text.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) if c.is_ascii_uppercase() => Ok(c),
        _ => Err("That is not a drive letter.".into()),
    }
}

fn text_arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key).and_then(Value::as_str).ok_or_else(|| "The text is missing.".to_string())
}

fn volume_label(root: &[u16]) -> String {
    let mut label = [0u16; MAX_PATH as usize + 1];
    let ok = unsafe {
        GetVolumeInformationW(
            root.as_ptr(),
            label.as_mut_ptr(),
            label.len() as u32,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
        )
    };
    if ok == 0 {
        return String::new();
    }
    let end = label.iter().position(|&c| c == 0).unwrap_or(label.len());
    String::from_utf16_lossy(&label[..end])
}

/// A Q2 card has one of these at its root. The folder name is the marker this app itself creates.
fn looks_like_q2(root: &Path) -> bool {
    root.join("Q2Pod").is_dir() || root.join("update.tar").is_file() || root.join("_library_data").exists()
}

/// The letter in a value like "C:", as Windows gives it in %SystemDrive%.
fn drive_letter(value: &str) -> Option<char> {
    value.chars().next().map(|c| c.to_ascii_uppercase())
}

/// Local disks only: a card reader can report itself as fixed, and network or optical drives are
/// never a Q2 card. Nor is the drive Windows runs from.
fn drives() -> Value {
    let mask = unsafe { GetLogicalDrives() };
    let system = std::env::var("SystemDrive").ok().and_then(|value| drive_letter(&value));
    let mut found = Vec::new();
    for bit in 0..26u32 {
        if mask & (1 << bit) == 0 {
            continue;
        }
        let letter = (b'A' + bit as u8) as char;
        if Some(letter) == system {
            continue;
        }
        let root = drive_root(letter);
        let root_wide = wide(&root.to_string_lossy());
        let kind = unsafe { GetDriveTypeW(root_wide.as_ptr()) };
        if kind != DRIVE_REMOVABLE && kind != DRIVE_FIXED {
            continue;
        }
        found.push(json!({
            "letter": letter.to_string(),
            "label": volume_label(&root_wide),
            "removable": kind == DRIVE_REMOVABLE,
            "isQ2": looks_like_q2(&root),
        }));
    }
    Value::Array(found)
}

fn theme_path(letter: char) -> PathBuf {
    drive_root(letter).join("Q2Pod").join("theme.txt")
}

fn read_limited(path: &Path) -> Result<String, std::io::Error> {
    let size = fs::metadata(path)?.len();
    if size > MAX_OPEN_BYTES {
        return Err(std::io::Error::new(ErrorKind::InvalidData, "too big"));
    }
    Ok(String::from_utf8_lossy(&fs::read(path)?).into_owned())
}

fn read_theme(letter: char) -> Result<Value, String> {
    match read_limited(&theme_path(letter)) {
        Ok(text) => Ok(Value::String(text)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(Value::Null),
        Err(e) if e.kind() == ErrorKind::InvalidData => Err("The theme on this card is too big to open.".into()),
        Err(_) => Err("The theme on this card could not be read.".into()),
    }
}

fn check_theme_text(text: &str) -> Result<(), String> {
    if text.len() > MAX_THEME_BYTES {
        return Err("This theme is over the 16 KB limit.".into());
    }
    if !text.starts_with("q2theme 1\n") || !text.ends_with("\nend\n") {
        return Err("This theme is not complete, so it was not saved.".into());
    }
    Ok(())
}

fn write_failed(e: std::io::Error, what: &str) -> String {
    match e.kind() {
        ErrorKind::PermissionDenied | ErrorKind::ReadOnlyFilesystem => {
            "The card would not let this app write to it. Check that it is not locked.".into()
        }
        ErrorKind::StorageFull => "The card is full. Free up a little space and try again.".into(),
        _ => format!("The {what} could not be written to the card. Check that it is still connected."),
    }
}

/// Write beside the final file, flush it to the card, then rename over: a card pulled out half way
/// leaves the old file whole, or at worst a temp file the firmware never reads.
fn write_atomic(folder: &Path, name: &str, data: impl AsRef<[u8]>) -> Result<(), std::io::Error> {
    fs::create_dir_all(folder)?;
    let temp = folder.join(format!("{name}.tmp"));
    let written = (|| {
        let mut file = fs::File::create(&temp)?;
        file.write_all(data.as_ref())?;
        file.flush()?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, folder.join(name))
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temp);
    }
    written
}

fn save_theme(letter: char, text: &str) -> Result<Value, String> {
    check_theme_text(text)?;
    write_atomic(&drive_root(letter).join("Q2Pod"), "theme.txt", text).map_err(|e| write_failed(e, "theme"))?;
    Ok(Value::Bool(true))
}

fn remove_theme(letter: char) -> Result<Value, String> {
    match fs::remove_file(theme_path(letter)) {
        Ok(()) => Ok(Value::Bool(true)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(Value::Bool(false)),
        Err(_) => Err("The theme could not be removed from this card. Check that it is not locked.".into()),
    }
}

fn eq_folder(letter: char) -> PathBuf {
    drive_root(letter).join("EQ")
}

/// A bare preset file name, so nothing here can reach outside the EQ folder. The Q2 lists only
/// lower-case .txt names, so a name it would not list is not one here either.
fn eq_file_name(file: &str) -> Result<&str, String> {
    let stem = file.strip_suffix(".txt").unwrap_or("");
    let plain = !stem.is_empty()
        && file.len() <= MAX_EQ_NAME_BYTES
        && !stem.starts_with('.')
        && !stem.ends_with(['.', ' '])
        && !file.chars().any(|c| c.is_control() || "<>:\"/\\|?*".contains(c));
    if plain { Ok(file) } else { Err("That is not a preset's file name.".into()) }
}

fn eq_file_arg(args: &Value) -> Result<&str, String> {
    eq_file_name(args.get("file").and_then(Value::as_str).unwrap_or(""))
}

/// names: the presets the Q2 would list. taken: all that is in the folder, as Windows would let a save
/// replace a.TXT or a folder of that name, so the page can say so first.
fn eq_names(folder: &Path) -> Result<Value, String> {
    let entries = match fs::read_dir(folder) {
        Ok(entries) => entries,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(json!({ "names": [], "taken": [] })),
        Err(_) => return Err("The card's EQ folder could not be read.".into()),
    };
    let mut taken: Vec<(String, bool)> = entries
        .flatten()
        .filter_map(|entry| Some((entry.file_name().into_string().ok()?, entry.path().is_file())))
        .collect();
    taken.sort_by_key(|(name, _)| name.to_lowercase());
    let names: Vec<&String> =
        taken.iter().filter(|(name, file)| *file && eq_file_name(name).is_ok()).map(|(name, _)| name).collect();
    let all: Vec<&String> = taken.iter().map(|(name, _)| name).collect();
    Ok(json!({ "names": names, "taken": all }))
}

fn read_eq(letter: char, file: &str) -> Result<Value, String> {
    match read_limited(&eq_folder(letter).join(file)) {
        Ok(text) => Ok(Value::String(text)),
        Err(e) if e.kind() == ErrorKind::InvalidData => Err("This preset is too big to open.".into()),
        Err(_) => Err("This preset could not be read from the card.".into()),
    }
}

fn save_eq(letter: char, file: &str, text: &str) -> Result<Value, String> {
    if text.len() > MAX_EQ_BYTES {
        return Err("This preset is over the 16 KB limit.".into());
    }
    write_atomic(&eq_folder(letter), file, text).map_err(|e| write_failed(e, "preset"))?;
    Ok(Value::Bool(true))
}

/// What the Q2 would read of a pins file; one that isn't ours pins nothing.
fn pin_names(text: &str) -> Vec<&str> {
    let mut lines = text.lines();
    if lines.next() != Some(PINS_HEADER) {
        return Vec::new();
    }
    lines.filter(|name| eq_file_name(&format!("{name}.txt")).is_ok()).collect()
}

fn pins_folder(letter: char) -> PathBuf {
    drive_root(letter).join("Q2Pod")
}

fn read_pins(letter: char) -> Result<Value, String> {
    match read_limited(&pins_folder(letter).join("eq-pins.txt")) {
        Ok(text) => Ok(json!(pin_names(&text))),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(json!([])),
        Err(_) => Err("The pinned presets could not be read from this card.".into()),
    }
}

fn pins_text(names: &[Value]) -> Result<String, String> {
    if names.len() > MAX_PINS {
        return Err(format!("Up to {MAX_PINS} presets can be pinned."));
    }
    let mut text = format!("{PINS_HEADER}\n");
    for name in names {
        let name = name.as_str().unwrap_or("");
        eq_file_name(&format!("{name}.txt"))?;
        text.push_str(name);
        text.push('\n');
    }
    Ok(text)
}

fn save_pins(letter: char, names: &[Value]) -> Result<Value, String> {
    let text = pins_text(names)?;
    write_atomic(&pins_folder(letter), "eq-pins.txt", &text).map_err(|e| write_failed(e, "pinned list"))?;
    Ok(Value::Bool(true))
}

fn from_base64(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let (mut held, mut bits) = (0u32, 0);
    for byte in text.bytes().filter(|&byte| byte != b'=') {
        held = held << 6 | BASE64.iter().position(|&c| c == byte)? as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((held >> bits) as u8);
            held &= (1 << bits) - 1;
        }
    }
    Some(out)
}

fn to_base64(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len() / 3 * 4 + 4);
    for chunk in data.chunks(3) {
        let held = chunk.iter().fold(0u32, |held, &byte| held << 8 | byte as u32) << (8 * (3 - chunk.len()));
        for at in 0..4 {
            let digit = BASE64[(held >> (18 - 6 * at) & 63) as usize] as char;
            out.push(if at > chunk.len() { '=' } else { digit });
        }
    }
    out
}

fn images_folder(letter: char) -> PathBuf {
    drive_root(letter).join("Q2Pod").join("images")
}

/// A name the Q2 looks for in its images folder, artNN.jpg or artNN.gif, and what such a file has to
/// start with. Nothing else can be written there, so this can't reach outside it.
fn image_kind(name: &str) -> Option<&'static [u8]> {
    let (stem, kind) = name.split_once('.')?;
    if stem.len() != 5 || !stem.starts_with("art") || !stem[3..].bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    match kind {
        "jpg" => Some(b"\xff\xd8"),
        "gif" => Some(b"GIF8"),
        _ => None,
    }
}

fn data_url(name: &str, data: &[u8]) -> String {
    let lower = name.to_lowercase();
    let kind = match lower.rsplit('.').next() {
        Some("png") => "png",
        Some("gif") => "gif",
        Some("webp") => "webp",
        _ => "jpeg",
    };
    format!("data:image/{kind};base64,{}", to_base64(data))
}

fn save_image(letter: char, name: &str, data: &str) -> Result<Value, String> {
    let magic = image_kind(name).ok_or("That is not a name for a Home image.")?;
    let bytes = from_base64(data).ok_or("That image could not be read.")?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("This image is still too big for the Q2 after shrinking it.".into());
    }
    if !bytes.starts_with(magic) {
        return Err("That image could not be read.".into());
    }
    write_atomic(&images_folder(letter), name, &bytes).map_err(|e| write_failed(e, "image"))?;
    Ok(Value::Bool(true))
}

fn read_image(letter: char, name: &str) -> Result<Value, String> {
    image_kind(name).ok_or("That is not a name for a Home image.")?;
    match fs::read(images_folder(letter).join(name)) {
        Ok(data) => Ok(Value::String(data_url(name, &data))),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(Value::Null),
        Err(_) => Err("This image could not be read from the card.".into()),
    }
}

/// Every folder with a cover the Q2 would use, by name; art inside the music files isn't seen here.
fn find_albums(root: &Path, at: &Path, depth: usize, found: &mut Vec<Value>) {
    let Ok(entries) = fs::read_dir(at) else { return };
    let mut folders = Vec::new();
    let mut cover = None;
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else { continue };
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            if !name.starts_with(['.', '_', '$']) && name != "System Volume Information" && name != "Q2Pod" && name != "EQ" {
                folders.push(entry.path());
            }
        } else if cover.is_none() && COVER_NAMES.contains(&name.to_lowercase().as_str()) {
            cover = Some(entry.path());
        }
    }
    if let (Some(path), Ok(album)) = (cover, at.strip_prefix(root)) {
        if let (Some(file), Some(name)) = (path.strip_prefix(root).ok().and_then(Path::to_str), album.to_str()) {
            found.push(json!({ "path": file, "name": name.replace('\\', " / ") }));
        }
    }
    folders.sort();
    for folder in folders {
        if depth < ALBUM_DEPTH && found.len() < ALBUM_MAX {
            find_albums(root, &folder, depth + 1, found);
        }
    }
}

fn albums(letter: char) -> Value {
    let root = drive_root(letter);
    let mut found = Vec::new();
    find_albums(&root, &root, 0, &mut found);
    Value::Array(found)
}

/// A cover find_albums listed: a plain path down the card, ending in a cover's name.
fn cover_path(letter: char, path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(path);
    let plain = relative.components().all(|part| matches!(part, std::path::Component::Normal(_)))
        && relative.file_name().and_then(|name| name.to_str()).is_some_and(|name| COVER_NAMES.contains(&name.to_lowercase().as_str()));
    if plain { Ok(drive_root(letter).join(relative)) } else { Err("That is not an album cover.".into()) }
}

fn read_cover(letter: char, path: &str) -> Result<Value, String> {
    let file = cover_path(letter, path)?;
    let size = fs::metadata(&file).map_err(|_| "This cover could not be read from the card.")?.len();
    if size > MAX_COVER_BYTES {
        return Err("This cover is too big to open.".into());
    }
    let data = fs::read(&file).map_err(|_| "This cover could not be read from the card.")?;
    Ok(Value::String(data_url(path, &data)))
}

fn import_eq(dialog: rfd::FileDialog) -> Result<Value, String> {
    let Some(path) = dialog.pick_file() else { return Ok(Value::Null) };
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    match read_limited(&path) {
        Ok(text) => Ok(json!({ "name": name, "text": text })),
        Err(e) if e.kind() == ErrorKind::InvalidData => Err("That file is too big to be an EQ preset.".into()),
        Err(_) => Err("That file could not be opened.".into()),
    }
}

fn import_theme(dialog: rfd::FileDialog) -> Result<Value, String> {
    let Some(path) = dialog.pick_file() else { return Ok(Value::Null) };
    match read_limited(&path) {
        Ok(text) => Ok(Value::String(text)),
        Err(e) if e.kind() == ErrorKind::InvalidData => Err("That file is too big to be a theme.".into()),
        Err(_) => Err("That file could not be opened.".into()),
    }
}

fn export_text(dialog: rfd::FileDialog, text: &str, what: &str) -> Result<Value, String> {
    let Some(path) = dialog.save_file() else { return Ok(Value::Null) };
    fs::write(&path, text).map_err(|_| format!("The {what} could not be saved there."))?;
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(Value::String(name))
}

/// Characters Windows refuses in a file name, and control characters, become spaces.
fn safe_file_name(suggested: &str) -> String {
    let cleaned: String =
        suggested.chars().map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { ' ' } else { c }).collect();
    let name = cleaned.trim().trim_end_matches('.').trim();
    if name.is_empty() { "theme.txt".into() } else { name.to_string() }
}

fn file_dialog(window: &Window, title: &str, kind: &str) -> rfd::FileDialog {
    rfd::FileDialog::new().set_title(title).add_filter(kind, &["txt"]).set_parent(window)
}

/// Runs on a worker thread: a slow card or an open dialog must not stall the window.
fn run(cmd: &str, args: &Value, dialog: Option<rfd::FileDialog>) -> Result<Value, String> {
    match (cmd, dialog) {
        ("drives", _) => Ok(drives()),
        ("read_theme", _) => read_theme(letter_arg(args)?),
        ("save_theme", _) => save_theme(letter_arg(args)?, text_arg(args, "text")?),
        ("remove_theme", _) => remove_theme(letter_arg(args)?),
        ("import_theme", Some(dialog)) => import_theme(dialog),
        ("export_theme", Some(dialog)) => export_text(dialog, text_arg(args, "text")?, "theme"),
        ("open_url", _) => {
            let url = library_url(args.get("url").and_then(Value::as_str).unwrap_or(""))?;
            if open_in_browser(url) { Ok(Value::Bool(true)) } else { Err("Your web browser could not be opened.".into()) }
        }
        ("eq_list", _) => eq_names(&eq_folder(letter_arg(args)?)),
        ("eq_read", _) => read_eq(letter_arg(args)?, eq_file_arg(args)?),
        ("eq_save", _) => save_eq(letter_arg(args)?, eq_file_arg(args)?, text_arg(args, "text")?),
        ("eq_pins", _) => read_pins(letter_arg(args)?),
        ("eq_pins_save", _) => {
            let names = args.get("names").and_then(Value::as_array).ok_or("The pins are missing.")?;
            save_pins(letter_arg(args)?, names)
        }
        ("image_save", _) => save_image(letter_arg(args)?, text_arg(args, "name")?, text_arg(args, "data")?),
        ("image_read", _) => read_image(letter_arg(args)?, text_arg(args, "name")?),
        ("albums", _) => Ok(albums(letter_arg(args)?)),
        ("album_art", _) => read_cover(letter_arg(args)?, text_arg(args, "path")?),
        ("import_eq", Some(dialog)) => import_eq(dialog),
        ("export_eq", Some(dialog)) => export_text(dialog, text_arg(args, "text")?, "preset"),
        _ => Err("The app asked for something it does not know.".into()),
    }
}

fn handle_ipc(body: &str, window: &Window, proxy: &EventLoopProxy<UserEvent>) {
    let Ok(message) = serde_json::from_str::<Value>(body) else { return };
    let Some(id) = message.get("id").and_then(Value::as_u64) else { return };
    let cmd = message.get("cmd").and_then(Value::as_str).unwrap_or("").to_string();
    let args = message.get("args").cloned().unwrap_or(Value::Null);
    if cmd == "close_now" || cmd == "close_held" {
        let _ = proxy.send_event(UserEvent::Close { now: cmd == "close_now" });
        let _ = proxy.send_event(UserEvent::Reply { id, result: Ok(Value::Bool(true)) });
        return;
    }
    // The parent window is only reachable on this thread; the dialog itself opens on the worker.
    let dialog = match cmd.as_str() {
        "import_theme" => Some(file_dialog(window, "Open a theme", "Theme file")),
        "import_eq" => Some(file_dialog(window, "Open an EQ preset", "EQ preset")),
        "export_theme" | "export_eq" => {
            let suggested = args.get("suggested").and_then(Value::as_str).unwrap_or("");
            let (title, kind) =
                if cmd == "export_eq" { ("Export this preset", "EQ preset") } else { ("Export this theme", "Theme file") };
            Some(file_dialog(window, title, kind).set_file_name(safe_file_name(suggested)))
        }
        _ => None,
    };
    let proxy = proxy.clone();
    std::thread::spawn(move || {
        let result = run(&cmd, &args, dialog);
        let _ = proxy.send_event(UserEvent::Reply { id, result });
    });
}

fn serve(path: &str) -> Response<Cow<'static, [u8]>> {
    let (body, kind) = match path {
        "/" | "/index.html" => (INDEX_HTML, "text/html; charset=utf-8"),
        "/core.js" => (CORE_JS, "text/javascript; charset=utf-8"),
        "/eq.js" => (EQ_JS, "text/javascript; charset=utf-8"),
        "/eq_page.js" => (EQ_PAGE_JS, "text/javascript; charset=utf-8"),
        "/library_page.js" => (LIBRARY_PAGE_JS, "text/javascript; charset=utf-8"),
        "/app.js" => (APP_JS, "text/javascript; charset=utf-8"),
        "/catalogue.json" => (CATALOGUE, "application/json; charset=utf-8"),
        "/presets.json" => (PRESETS, "application/json; charset=utf-8"),
        _ => ("", "text/plain; charset=utf-8"),
    };
    let status = if body.is_empty() { StatusCode::NOT_FOUND } else { StatusCode::OK };
    let builder = Response::builder().status(status).header(CONTENT_TYPE, kind);
    builder.body(Cow::Borrowed(body.as_bytes())).expect("static response is valid")
}

/// WebView2 keeps its profile here, not beside the exe, which may sit somewhere read-only.
fn data_folder() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("Q2ThemeStudio")
}

/// A small generated mark: the app ships no image files.
fn app_icon() -> Option<Icon> {
    const SIZE: u32 = 32;
    let mut rgba = Vec::with_capacity((SIZE * SIZE * 4) as usize);
    for y in 0..SIZE {
        for x in 0..SIZE {
            let (dx, dy) = (x as f32 - 15.5, y as f32 - 15.5);
            let corner = (dx.abs() - 8.0).max(0.0).hypot((dy.abs() - 8.0).max(0.0));
            let dot = (dx + 5.5).hypot(dy + 5.5);
            let color = if corner > 7.5 {
                [0, 0, 0, 0]
            } else if dot < 3.5 {
                [255, 255, 255, 255]
            } else if dy > 2.0 && dy < 5.0 && dx.abs() < 9.5 {
                [232, 18, 63, 255]
            } else {
                [28, 28, 30, 255]
            };
            rgba.extend_from_slice(&color);
        }
    }
    Icon::from_rgba(rgba, SIZE, SIZE).ok()
}

/// The preview's 2x view fits the start size. Both sizes give way to a smaller screen, such as a
/// 1080p laptop at 150%, where the normal minimum would run off the bottom. The window is centred.
fn place_window(window: &Window) {
    let Some(monitor) = window.current_monitor() else { return };
    let (screen, origin, scale) = (monitor.size(), monitor.position(), monitor.scale_factor());
    let (room_w, room_h) = (screen.width as f64 * 0.96, screen.height as f64 * 0.90);
    let wanted = LogicalSize::new(START_SIZE.0, START_SIZE.1).to_physical::<f64>(scale);
    let min = LogicalSize::new(MIN_SIZE.0, MIN_SIZE.1).to_physical::<f64>(scale);
    window.set_min_inner_size(Some(PhysicalSize::new(min.width.min(room_w), min.height.min(room_h))));
    window.set_inner_size(PhysicalSize::new(wanted.width.min(room_w), wanted.height.min(room_h)));
    let outer = window.outer_size();
    window.set_outer_position(PhysicalPosition::new(
        origin.x + (screen.width as i32 - outer.width as i32) / 2,
        origin.y + (screen.height as i32 - outer.height as i32).max(0) / 2,
    ));
}

fn main() {
    // An empty card reader must fail quietly, not raise a "no disk" system dialog.
    unsafe { SetErrorMode(SEM_FAILCRITICALERRORS) };

    if wry::webview_version().is_err() {
        webview_missing();
        return;
    }

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let window = match WindowBuilder::new()
        .with_title(APP_NAME)
        .with_inner_size(LogicalSize::new(START_SIZE.0, START_SIZE.1))
        .with_min_inner_size(LogicalSize::new(MIN_SIZE.0, MIN_SIZE.1))
        .with_theme(Some(Theme::Dark))
        .with_window_icon(app_icon())
        .with_visible(false)
        .build(&event_loop)
    {
        Ok(window) => window,
        Err(_) => {
            message_box("The window could not be opened.", MB_OK | MB_ICONERROR);
            return;
        }
    };
    place_window(&window);

    let ipc_proxy = event_loop.create_proxy();
    let mut context = WebContext::new(Some(data_folder()));
    let built = WebViewBuilder::new_with_web_context(&mut context)
        .with_custom_protocol("app".into(), |_, request: Request<Vec<u8>>| serve(request.uri().path()))
        .with_url("app://localhost/index.html")
        .with_ipc_handler(move |request: Request<String>| {
            let _ = ipc_proxy.send_event(UserEvent::Ipc(request.into_body()));
        })
        .with_navigation_handler(|url| url.starts_with(ORIGIN))
        .with_new_window_req_handler(|_, _| NewWindowResponse::Deny)
        .with_background_color((27, 28, 31, 255))
        .with_devtools(false)
        .with_browser_accelerator_keys(false)
        .build(&window);
    let webview = match built {
        Ok(webview) => webview,
        Err(_) => {
            webview_missing();
            return;
        }
    };
    window.set_visible(true);

    let proxy = event_loop.create_proxy();
    let mut close_asked = false;
    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;
        match event {
            Event::UserEvent(UserEvent::Close { now }) => {
                close_asked = false;
                if now {
                    *control_flow = ControlFlow::Exit;
                }
            }
            Event::UserEvent(UserEvent::Ipc(body)) => handle_ipc(&body, &window, &proxy),
            Event::UserEvent(UserEvent::Reply { id, result }) => {
                let (ok, value) = match result {
                    Ok(value) => (true, value),
                    Err(message) => (false, Value::String(message)),
                };
                let _ = webview.evaluate_script(&format!("window.__hostReply({id},{ok},{value})"));
            }
            // The page knows about unsaved work, so it decides. If it never answers, the next
            // click on the close button closes anyway: a stuck page must not trap the window.
            Event::WindowEvent { event: WindowEvent::CloseRequested, .. } => {
                if close_asked {
                    *control_flow = ControlFlow::Exit;
                } else {
                    close_asked = true;
                    let _ = webview.evaluate_script("window.__closeRequested()");
                }
            }
            _ => {}
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = "q2theme 1\nname Test\nend\n";

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("q2-theme-studio-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn letters_are_a_single_capital() {
        assert_eq!(letter_arg(&json!({ "letter": "E" })), Ok('E'));
        for bad in ["", "e", "EE", "1", "E:", ".."] {
            assert!(letter_arg(&json!({ "letter": bad })).is_err(), "{bad}");
        }
        assert!(letter_arg(&json!({})).is_err());
    }

    #[test]
    fn a_locked_card_is_told_so() {
        let locked = write_failed(std::io::Error::from(ErrorKind::ReadOnlyFilesystem), "theme");
        assert!(locked.contains("not locked"), "{locked}");
        // Windows error 19, the write-protect tab on an SD adapter.
        let protected = write_failed(std::io::Error::from_raw_os_error(19), "theme");
        assert!(protected.contains("not locked"), "{protected}");
        assert!(write_failed(std::io::Error::from(ErrorKind::NotFound), "preset").contains("preset could not"));
    }

    #[test]
    fn the_system_drive_is_read_from_its_variable() {
        assert_eq!(drive_letter("C:"), Some('C'));
        assert_eq!(drive_letter("d:"), Some('D'));
        assert_eq!(drive_letter(""), None);
    }

    #[test]
    fn write_replaces_the_old_theme_and_leaves_no_temp_file() {
        let folder = scratch("write").join("Q2Pod");
        write_atomic(&folder, "theme.txt", "first").unwrap();
        write_atomic(&folder, "theme.txt", GOOD).unwrap();
        assert_eq!(fs::read_to_string(folder.join("theme.txt")).unwrap(), GOOD);
        assert!(!folder.join("theme.txt.tmp").exists());
        fs::remove_dir_all(folder.parent().unwrap()).unwrap();
    }

    #[test]
    fn only_the_library_opens_in_a_browser() {
        let good = "https://github.com/tyleree/q2-themes/new/main/themes?filename=a.txt&value=q2theme%201";
        assert_eq!(library_url(good), Ok(good));
        for bad in [
            "",
            "https://github.com/",
            "https://github.com/tyleree/q2-themes",
            "https://github.com/tyleree/q2-themes-evil/",
            "https://evil.example/https://github.com/tyleree/q2-themes/",
            "file:///C:/Windows/System32/calc.exe",
            "calc.exe",
            "https://github.com/tyleree/q2-themes/ a",
            "https://github.com/tyleree/q2-themes/\n",
        ] {
            assert!(library_url(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn preset_names_stay_in_the_eq_folder() {
        assert_eq!(eq_file_name("Sennheiser HD 600.txt"), Ok("Sennheiser HD 600.txt"));
        for bad in ["", ".txt", "a", "a.TXT", "../a.txt", "a/b.txt", "a\\b.txt", "C:a.txt", ".a.txt", "a .txt", "a..txt"] {
            assert!(eq_file_name(bad).is_err(), "{bad}");
        }
        assert!(eq_file_name(&format!("{}.txt", "x".repeat(MAX_EQ_NAME_BYTES))).is_err());
    }

    #[test]
    fn the_eq_folder_lists_what_the_q2_would() {
        let folder = scratch("eq-list").join("EQ");
        assert_eq!(eq_names(&folder), Ok(json!({ "names": [], "taken": [] })));
        write_atomic(&folder, "b.txt", "x").unwrap();
        write_atomic(&folder, "A.txt", "x").unwrap();
        write_atomic(&folder, "skip.TXT", "x").unwrap();
        write_atomic(&folder, "notes.md", "x").unwrap();
        fs::create_dir_all(folder.join("dir.txt")).unwrap();
        let listed = eq_names(&folder).unwrap();
        assert_eq!(listed["names"], json!(["A.txt", "b.txt"]));
        assert_eq!(listed["taken"], json!(["A.txt", "b.txt", "dir.txt", "notes.md", "skip.TXT"]));
        fs::remove_dir_all(folder.parent().unwrap()).unwrap();
    }

    #[test]
    fn base64_goes_there_and_back() {
        for size in 0..300 {
            let data: Vec<u8> = (0..size).map(|i| (i * 7) as u8).collect();
            assert_eq!(from_base64(&to_base64(&data)), Some(data));
        }
        assert_eq!(to_base64(b"Man"), "TWFu");
        assert_eq!(to_base64(b"Ma"), "TWE=");
        assert_eq!(to_base64(b"M"), "TQ==");
        assert_eq!(from_base64("not base64!"), None);
    }

    #[test]
    fn only_the_right_panels_pictures_are_written() {
        for good in ["art01.jpg", "art24.jpg", "art02.gif"] {
            assert!(image_kind(good).is_some(), "{good}");
        }
        for bad in ["", "art01", "top.png", "eq.gif", "art01.png", "art1.jpg", "artab.jpg", "../art01.jpg", "a/art01.jpg", "art01.jpg.exe"] {
            assert!(image_kind(bad).is_none(), "{bad}");
        }
        assert!(save_image('Z', "../art01.jpg", "").is_err());
        assert_eq!(save_image('Z', "art01.jpg", &to_base64(b"GIF8")).unwrap_err(), "That image could not be read.");
        assert!(save_image('Z', "art01.gif", &to_base64(&vec![0x47; MAX_IMAGE_BYTES + 1])).unwrap_err().contains("too big"));
    }

    #[test]
    fn albums_are_the_folders_with_covers() {
        let root = scratch("albums");
        for (folder, file) in [("Music/One", "cover.jpg"), ("Music/Two", "Folder.PNG"), ("Music/None", "a.flac"), ("Q2Pod/images", "cover.jpg"), (".coverflow", "cover.jpg")] {
            write_atomic(&root.join(folder), file, "x").unwrap();
        }
        let mut found = Vec::new();
        find_albums(&root, &root, 0, &mut found);
        assert_eq!(found, [json!({ "path": r"Music\One\cover.jpg", "name": "Music / One" }), json!({ "path": r"Music\Two\Folder.PNG", "name": "Music / Two" })]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_cover_stays_a_cover() {
        assert!(cover_path('E', r"Music\One\cover.jpg").is_ok());
        for bad in ["", "cover.txt", r"..\cover.jpg", r"Music\..\..\cover.jpg", r"C:\cover.jpg", r"\cover.jpg", r"Music\song.flac"] {
            assert!(cover_path('E', bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn pins_read_as_the_q2_reads_them() {
        assert_eq!(pin_names("q2eqpins 1\nA\r\n../b\n\nC D\n"), ["A", "C D"]);
        assert!(pin_names("q2eqpins 2\nA\n").is_empty());
        assert!(pin_names("A\nB\n").is_empty());
        assert!(pin_names("").is_empty());
    }

    #[test]
    fn only_preset_names_are_pinned() {
        assert_eq!(pins_text(&[json!("A"), json!("C D")]), Ok("q2eqpins 1\nA\nC D\n".to_string()));
        assert_eq!(pins_text(&[]), Ok("q2eqpins 1\n".to_string()));
        for bad in [json!(""), json!("../a"), json!("a\\b"), json!("a\nb"), json!(1)] {
            assert!(pins_text(&[bad.clone()]).is_err(), "{bad}");
        }
        assert!(pins_text(&vec![json!("A"); MAX_PINS + 1]).unwrap_err().contains("Up to"));
    }

    #[test]
    fn a_preset_over_the_limit_is_refused() {
        assert!(save_eq('Z', "a.txt", &"x".repeat(MAX_EQ_BYTES + 1)).unwrap_err().contains("16 KB"));
    }

    #[test]
    fn only_a_whole_theme_is_saved() {
        assert!(check_theme_text(GOOD).is_ok());
        assert!(check_theme_text("q2theme 1\nname Test\n").is_err());
        assert!(check_theme_text("name Test\nend\n").is_err());
        let big = format!("q2theme 1\nname {}\nend\n", "x".repeat(MAX_THEME_BYTES));
        assert!(check_theme_text(&big).is_err());
    }

    #[test]
    fn suggested_file_names_are_safe() {
        assert_eq!(safe_file_name("Midnight Blue.txt"), "Midnight Blue.txt");
        assert_eq!(safe_file_name("a/b:c?.txt"), "a b c .txt");
        assert_eq!(safe_file_name("  ... "), "theme.txt");
    }
}
