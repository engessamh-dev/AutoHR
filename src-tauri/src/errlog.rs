// errlog.rs — local log of technical errors, read by the program check (health.rs).
//
// Only technical failures are kept: database errors, file and attachment failures, backup and
// restore failures, document-reading failures, update failures, frontend exceptions and panics.
// Input mistakes and permission refusals are not errors of the program and are never written.
//
// Every message is cleaned before it touches the disk: paths and file names (which can hold
// employee names), e-mail addresses, long numbers (ID, phone and card numbers) and anything that
// follows the word "password" are replaced. The log lives next to the settings file on this
// computer (%APPDATA%\AutoHR\Logs) and never leaves it unless the user attaches the report.
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    fs::{self, OpenOptions},
    io::Write,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};

const LOG_FILE: &str = "errors.log";
const OLD_LOG_FILE: &str = "errors.old.log";
const MAX_LOG_BYTES: u64 = 512 * 1024;
const MAX_MESSAGE_CHARS: usize = 400;
const MAX_STACK_FRAMES: usize = 8;
/// How long an error detail from Rust waits for the screen to say which operation failed.
const PAIR_WINDOW: Duration = Duration::from_secs(10);

/// The messages the frontend receives for database and other unexpected errors
/// (see `impl Serialize for AppError`). Only these are technical errors on that side.
pub const GENERIC_DB_MESSAGE: &str = "The database operation could not be completed";
pub const GENERIC_OTHER_MESSAGE: &str = "The operation could not be completed";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ErrorEntry {
    /// Local time, "YYYY-MM-DD HH:MM:SS".
    pub time: String,
    pub version: String,
    /// database, file, backup, ocr, update, scanner, script, panic, app
    pub kind: String,
    /// The command or operation that failed, such as cmd_create_backup.
    pub operation: String,
    /// The screen that was open, such as employees.
    #[serde(default)]
    pub screen: String,
    pub message: String,
    /// Short stack or extra context, already cleaned.
    #[serde(default)]
    pub context: String,
}

struct Pending { at: Instant, entry: ErrorEntry }

struct State {
    dir: Option<PathBuf>,
    version: String,
    pending: VecDeque<Pending>,
}

static STATE: Mutex<State> = Mutex::new(State { dir: None, version: String::new(), pending: VecDeque::new() });

/// Turns the log on. Until this is called (as in unit tests) nothing is written.
pub fn init(dir: PathBuf, version: &str) {
    if let Ok(mut state) = STATE.lock() {
        state.dir = Some(dir);
        state.version = version.to_string();
    }
}

fn now() -> String { chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string() }

fn entry(version: &str, kind: &str, operation: &str, screen: &str, message: &str, context: &str) -> ErrorEntry {
    ErrorEntry {
        time: now(),
        version: version.to_string(),
        kind: clean_word(kind),
        operation: clean_word(operation),
        screen: clean_word(screen),
        message: sanitize(message),
        context: sanitize_stack(context),
    }
}

fn append(state: &State, entry: &ErrorEntry) {
    let Some(dir) = &state.dir else { return };
    if fs::create_dir_all(dir).is_err() { return; }
    let path = dir.join(LOG_FILE);
    if fs::metadata(&path).map(|m| m.len() > MAX_LOG_BYTES).unwrap_or(false) {
        let _ = fs::rename(&path, dir.join(OLD_LOG_FILE));
    }
    if let (Ok(mut file), Ok(line)) = (OpenOptions::new().create(true).append(true).open(&path), serde_json::to_string(entry)) {
        let _ = writeln!(file, "{line}");
    }
}

/// Writes details that waited too long for their operation name on their own.
fn flush_stale(state: &mut State, all: bool) {
    while state.pending.front().map(|p| all || p.at.elapsed() > PAIR_WINDOW).unwrap_or(false) {
        if let Some(p) = state.pending.pop_front() { append(state, &p.entry); }
    }
}

/// A technical error reached the screen from Rust. Its detail is held for a moment so that the
/// screen's report of which operation and screen it was can be written in the same line.
pub fn record_backend(kind: &str, detail: &str) {
    let Ok(mut state) = STATE.lock() else { return };
    if state.dir.is_none() { return; }
    flush_stale(&mut state, false);
    let e = entry(&state.version, kind, "", "", detail, "");
    state.pending.push_back(Pending { at: Instant::now(), entry: e });
    while state.pending.len() > 20 {
        if let Some(p) = state.pending.pop_front() { append(&state, &p.entry); }
    }
}

/// An error in work that does not report to a screen (startup, background tasks).
pub fn record(kind: &str, operation: &str, detail: &str) {
    let Ok(mut state) = STATE.lock() else { return };
    flush_stale(&mut state, false);
    let e = entry(&state.version, kind, operation, "", detail, "");
    append(&state, &e);
}

/// Reported by the frontend: a failed command or an unexpected script exception.
pub fn record_client(operation: &str, screen: &str, message: &str, stack: &str) {
    let Ok(mut state) = STATE.lock() else { return };
    flush_stale(&mut state, false);
    let technical = message == GENERIC_DB_MESSAGE || message == GENERIC_OTHER_MESSAGE;
    let paired = if technical && operation.starts_with("cmd_") { state.pending.pop_back() } else { None };
    let mut e = match paired {
        Some(p) => {
            let mut e = p.entry;
            e.operation = clean_word(operation);
            e.screen = clean_word(screen);
            e.context = sanitize_stack(stack);
            e
        }
        None => {
            let kind = if operation.starts_with("cmd_") { "app" } else { "script" };
            entry(&state.version, kind, operation, screen, message, stack)
        }
    };
    if let Some(kind) = kind_for_operation(&e.operation) { e.kind = kind.into(); }
    append(&state, &e);
}

/// Panics are written straight away: the program may not live long enough to pair them.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let message = info.payload().downcast_ref::<&str>().map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic".into());
        // Only the source file's name and line: the build folder is not useful and not ours to share.
        let location = info.location().map(|l| {
            let file = l.file().rsplit(['/', '\\']).next().unwrap_or("");
            format!("{file}:{}", l.line())
        }).unwrap_or_default();
        if let Ok(mut state) = STATE.try_lock() {
            flush_stale(&mut state, true);
            let mut e = entry(&state.version, "panic", "", "", &message, "");
            e.context = clean_word(&location);
            append(&state, &e);
        }
        previous(info);
    }));
}

/// The kind follows the operation when the operation says more than the error type.
fn kind_for_operation(operation: &str) -> Option<&'static str> {
    let op = operation.to_ascii_lowercase();
    if op.contains("backup") || op.contains("restore") { Some("backup") }
    else if op.contains("update") && !op.contains("update_employee") && !op.contains("update_company")
        && !op.contains("update_general") && !op.contains("update_outgoing") && !op.contains("update_user") { Some("update") }
    else if op.contains("read_document_fields") || op.contains("ocr") { Some("ocr") }
    else if op.contains("scanner") || op.contains("scan_document") { Some("scanner") }
    else if op.contains("upload") || op.contains("attachment") || op.contains("photo") || op.contains("read_document")
        || op.contains("_file") || op.contains("folder") { Some("file") }
    else { None }
}

/// Newest entries first, at most `limit`, from this log and the previous one.
pub fn recent(limit: usize) -> Vec<ErrorEntry> {
    let dir = match STATE.lock() {
        Ok(mut state) => { flush_stale(&mut state, true); state.dir.clone() }
        Err(_) => None,
    };
    let Some(dir) = dir else { return Vec::new() };
    read_dir_entries(&dir, limit)
}

pub fn read_dir_entries(dir: &std::path::Path, limit: usize) -> Vec<ErrorEntry> {
    let mut out = Vec::new();
    for name in [LOG_FILE, OLD_LOG_FILE] {
        let Ok(text) = fs::read_to_string(dir.join(name)) else { continue };
        for line in text.lines().rev() {
            if out.len() >= limit { return out; }
            if let Ok(e) = serde_json::from_str::<ErrorEntry>(line) { out.push(e); }
        }
    }
    out
}

// ── Cleaning ────────────────────────────────────────────────────────────────

/// Keeps only letters, digits and _ . - : (names of commands, screens and source lines).
fn clean_word(text: &str) -> String {
    text.chars().filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-' | ':')).take(80).collect()
}

const FILE_EXTENSIONS: &[&str] = &[
    "pdf", "jpg", "jpeg", "png", "webp", "bmp", "gif", "tif", "tiff", "heic", "doc", "docx", "xls",
    "xlsx", "csv", "txt", "json", "db", "sqlite", "autohrbak", "zip", "log", "exe", "msi",
];

fn extension_of(text: &str) -> Option<String> {
    let last = text.rsplit(['/', '\\']).next().unwrap_or(text);
    let (_, ext) = last.rsplit_once('.')?;
    let ext = ext.trim_end_matches(|c: char| !c.is_ascii_alphanumeric()).to_ascii_lowercase();
    FILE_EXTENSIONS.contains(&ext.as_str()).then_some(ext)
}

fn path_placeholder(text: &str) -> String {
    match extension_of(text) { Some(ext) => format!("<file>.{ext}"), None => "<path>".into() }
}

/// Ends an absolute path: quotes, brackets, a new line, a comma, or ": " / " (" after it.
fn absolute_path_end(chars: &[char], start: usize) -> usize {
    let mut i = start;
    while i < chars.len() {
        let c = chars[i];
        if matches!(c, '"' | '\'' | '`' | ')' | '(' | '\n' | '\r' | ',' | '،' | '>' | '<' | '|' | '?' | '*') { break; }
        if c == ':' && i > start + 1 && chars.get(i + 1).map(|n| n.is_whitespace()).unwrap_or(true) { break; }
        i += 1;
    }
    // A trailing full stop ends the sentence, not the path.
    while i > start && matches!(chars[i - 1], '.' | ' ') { i -= 1; }
    i
}

fn starts_absolute_path(chars: &[char], i: usize) -> bool {
    let at = |k: usize| chars.get(i + k).copied().unwrap_or('\0');
    let boundary = i == 0 || !chars[i - 1].is_alphanumeric();
    if !boundary { return false; }
    (at(0).is_ascii_alphabetic() && at(1) == ':' && (at(2) == '\\' || at(2) == '/'))
        || (at(0) == '\\' && at(1) == '\\')
        || (at(0) == '/' && at(1).is_alphanumeric() && (i == 0 || chars[i - 1].is_whitespace() || matches!(chars[i - 1], '"' | '\'' | '(')))
        || (at(0) == '%' && chars[i..].iter().take(14).collect::<String>().starts_with("%USERPROFILE%"))
}

fn is_url_start(chars: &[char], i: usize) -> Option<usize> {
    let rest: String = chars[i..].iter().take(12).collect();
    ["https://", "http://", "tauri://", "asset://", "file://", "ipc://"].iter()
        .find(|p| rest.starts_with(**p)).map(|p| p.len())
}

/// Keeps the host of web addresses (for update servers) and the script file and line of the
/// program's own scripts; anything else, such as an asset link to a document, is dropped.
fn clean_url(url: &str, scheme_len: usize) -> String {
    let scheme = &url[..scheme_len];
    let rest = &url[scheme_len..];
    let host = rest.split('/').next().unwrap_or("");
    let last = rest.rsplit('/').next().unwrap_or("");
    let script = last.split(':').next().unwrap_or("");
    if (script.ends_with(".js") || script.ends_with(".mjs")) && !scheme.starts_with("asset") && !scheme.starts_with("file") {
        return clean_word(last);
    }
    if scheme.starts_with("http") && !host.is_empty() && !host.contains('@') {
        return format!("{scheme}{}/…", clean_word(host));
    }
    "<link>".into()
}

/// Removes personal data from an error message. See the header of this file.
pub fn sanitize(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        if let Some(scheme_len) = is_url_start(&chars, i) {
            let end = (i..chars.len()).find(|&k| chars[k].is_whitespace() || matches!(chars[k], '"' | '\'' | ')' | '(')).unwrap_or(chars.len());
            out.push_str(&clean_url(&chars[i..end].iter().collect::<String>(), scheme_len));
            i = end;
            continue;
        }
        if starts_absolute_path(&chars, i) {
            let end = absolute_path_end(&chars, i).max(i + 1);
            out.push_str(&path_placeholder(&chars[i..end].iter().collect::<String>()));
            i = end;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    let mut cleaned: Vec<String> = Vec::new();
    let mut hide_next = false;
    for word in out.split(' ') {
        if hide_next && !word.is_empty() { cleaned.push("<hidden>".into()); hide_next = false; continue; }
        let lower = word.to_lowercase();
        let bare = word.trim_matches(|c: char| matches!(c, '"' | '\'' | '`' | '(' | ')' | '[' | ']' | ',' | '.' | ';' | ':' | '،'));
        if lower.contains("password") || lower.contains("passwd") || word.contains("كلمة_المرور") {
            // Keep the word, hide what follows it.
            match word.split_once(['=', ':']) {
                Some((key, rest)) if !rest.is_empty() => cleaned.push(format!("{key}=<hidden>")),
                Some(_) => { cleaned.push(word.into()); hide_next = true; }
                None => cleaned.push(word.into()),
            }
            continue;
        }
        if bare.contains('@') && bare.contains('.') && !bare.starts_with('@') {
            cleaned.push(word.replace(bare, "<email>"));
        } else if (bare.contains('/') || bare.contains('\\')) && bare.chars().any(|c| c.is_alphanumeric()) && !bare.starts_with('<') && !bare.starts_with("http") {
            // Relative paths such as employees/12/front.jpg.
            cleaned.push(word.replace(bare, &path_placeholder(bare)));
        } else if extension_of(bare).is_some() && bare.contains('.') && !bare.ends_with(".js") && !bare.ends_with(".rs") {
            // A file name with spaces: the words before it in another script are part of it.
            while cleaned.last().map(|w| is_name_word(w)).unwrap_or(false) { cleaned.pop(); }
            cleaned.push(word.replace(bare, &path_placeholder(bare)));
        } else {
            cleaned.push(hide_long_numbers(word));
        }
    }
    let joined = cleaned.join(" ");
    let mut result: String = joined.chars().filter(|c| !c.is_control() || *c == '\n').take(MAX_MESSAGE_CHARS).collect();
    if joined.chars().count() > MAX_MESSAGE_CHARS { result.push('…'); }
    result.trim().to_string()
}

fn is_name_word(word: &str) -> bool {
    !word.is_empty() && !word.ends_with(':') && !word.starts_with('<')
        && word.chars().any(|c| c.is_alphabetic() && !c.is_ascii())
}

/// Five or more digits in a row (ID, phone, card and employee numbers) become <number>.
fn hide_long_numbers(word: &str) -> String {
    let mut out = String::new();
    let mut digits = String::new();
    let flush = |digits: &mut String, out: &mut String| {
        if digits.chars().count() >= 5 { out.push_str("<number>"); } else { out.push_str(digits); }
        digits.clear();
    };
    for c in word.chars() {
        if c.is_numeric() { digits.push(c); } else { flush(&mut digits, &mut out); out.push(c); }
    }
    flush(&mut digits, &mut out);
    out
}

/// A script stack: at most a few frames, each reduced to function name and file:line.
pub fn sanitize_stack(stack: &str) -> String {
    stack.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .take(MAX_STACK_FRAMES)
        .map(sanitize)
        .collect::<Vec<_>>()
        .join(" | ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_names_and_numbers_are_removed() {
        let text = r"Cannot read C:\Users\Ali Hassan\Documents\علي حسن جواز.jpg: Access is denied. (os error 5)";
        let clean = sanitize(text);
        assert!(!clean.contains("Ali"), "{clean}");
        assert!(!clean.contains("علي"), "{clean}");
        assert!(clean.contains("<file>.jpg"), "{clean}");
        assert!(clean.contains("os error 5"), "{clean}");

        let clean = sanitize("file copy failed: employees/12/ahmed_front.png does not match");
        assert!(!clean.contains("ahmed"), "{clean}");
        assert!(clean.contains("<file>.png"), "{clean}");

        let clean = sanitize("UNIQUE constraint failed: employees.national_id value 199012345678 user ali@example.com");
        assert!(clean.contains("employees.national_id"), "{clean}");
        assert!(!clean.contains("199012345678"), "{clean}");
        assert!(!clean.contains("ali@example.com"), "{clean}");

        let clean = sanitize("bad login password=Secret123 then password: hunter2");
        assert!(!clean.contains("Secret123") && !clean.contains("hunter2"), "{clean}");

        let clean = sanitize("مستند محمد كاظم.pdf غير موجود");
        assert!(!clean.contains("كاظم") && !clean.contains("محمد"), "{clean}");
    }

    #[test]
    fn urls_keep_only_what_helps() {
        let clean = sanitize("error sending request for url (https://github.com/owner/repo/releases/latest/download/latest.json)");
        assert!(clean.contains("https://github.com/…"), "{clean}");
        assert!(!clean.contains("owner"), "{clean}");
        let stack = "TypeError: x is undefined\n    at renderEmployees (http://tauri.localhost/assets/index-Ab12.js:120:33)\n    at asset://localhost/C%3A%5CUsers%5Cali%5Cphoto.jpg";
        let clean = sanitize_stack(stack);
        assert!(clean.contains("index-Ab12.js:120:33"), "{clean}");
        assert!(!clean.contains("ali"), "{clean}");
    }

    #[test]
    fn backend_detail_is_paired_with_the_screen_operation() {
        let dir = tempfile::tempdir().unwrap();
        init(dir.path().to_path_buf(), "1.0.5");
        record_backend("database", "database is locked");
        record_client("cmd_create_backup", "settings", GENERIC_DB_MESSAGE, "");
        record_client("window.onerror", "employees", "TypeError: Cannot read properties of undefined (reading 'full_name')", "at render (http://tauri.localhost/assets/index-1.js:5:9)");
        let entries = read_dir_entries(dir.path(), 10);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[1].operation, "cmd_create_backup");
        assert_eq!(entries[1].kind, "backup");
        assert_eq!(entries[1].screen, "settings");
        assert_eq!(entries[1].message, "database is locked");
        assert_eq!(entries[0].kind, "script");
        assert!(entries[0].context.contains("index-1.js:5:9"));
        *STATE.lock().unwrap() = State { dir: None, version: String::new(), pending: VecDeque::new() };
    }
}
