//! Backups from 1.0.7 on.
//!
//! * **Attachment store.** Every attachment is copied once into `<backups>/Store/<id>/ab/<sha256>.blob`,
//!   encrypted with a random store key and named by the SHA-256 of its content. Backups share it:
//!   a photo that has not changed is never copied again.
//! * **Backup file (format 3, "snapshot").** A small `.autohrbak` file: the database (compressed)
//!   and the list of attachments it needs, encrypted with the backup's password. It also carries
//!   the store key, so the password alone opens it on another computer, as long as the `Store`
//!   folder is next to it (the whole backup folder is copied).
//! * **Automatic backups.** One file per day, re-written during work and on sign-out when the data
//!   changed. Old days are thinned out by the keep rule (7 days, then one per week for 4 weeks,
//!   then one per month for 12 months). Manual and safety backups are never removed.
//! * **Full export (format 4).** One self-contained file for a USB stick or another computer,
//!   encrypted in 1 MiB chunks, so its size is not limited by memory.

use std::collections::HashSet;
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};

use aes_gcm::{aead::{Aead, KeyInit, Payload}, Aes256Gcm, Nonce};
use chrono::{Datelike, NaiveDate};
use rand::{rngs::OsRng, RngCore};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::services::{self, backup_progress, AppError, AppResult, BackupManifestFile, BackupProgress};

pub const SNAPSHOT_MAGIC: &[u8; 9] = b"AUTOHRBK3";
pub const STREAM_MAGIC: &[u8; 9] = b"AUTOHRBK4";
const BLOB_MAGIC: &[u8; 8] = b"AHRBLOB1";
const REFS_MAGIC: &[u8; 8] = b"AHRREFS1";
const SNAPSHOT_FORMAT: u32 = 3;
const CHUNK: usize = 1024 * 1024;
/// Added to an attachment's size by its encryption: header, nonce and tag.
const BLOB_OVERHEAD: u64 = 8 + 12 + 16;
const STORE_DIR: &str = "Store";
const STORE_KEY_SETTING: &str = "backup_store_key";
pub const MIN_KEEP_DAILY: u32 = 3;
/// An unreferenced attachment is removed from the store only after this long, so a backup that is
/// being written at the same moment never loses a file it has just stored.
const STORE_GRACE: std::time::Duration = std::time::Duration::from_secs(24 * 60 * 60);

fn other(error: impl std::fmt::Display) -> AppError {
    AppError::Other(error.to_string())
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

// ── Store key ───────────────────────────────────────────────────────────────

pub(crate) struct StoreKey {
    pub id: String,
    key: [u8; 32],
}

impl StoreKey {
    fn from_bytes(key: [u8; 32]) -> Self {
        let id = sha256_hex(&key)[..16].to_string();
        Self { id, key }
    }

    fn from_hex(value: &str) -> Option<Self> {
        let bytes = hex::decode(value).ok()?;
        let key: [u8; 32] = bytes.try_into().ok()?;
        Some(Self::from_bytes(key))
    }

    fn cipher(&self) -> Aes256Gcm {
        Aes256Gcm::new_from_slice(&self.key).expect("32-byte key")
    }
}

/// The store key of this computer's backups (DPAPI-protected in the settings). A new one, and so
/// a new store, is made the first time, or when the saved key cannot be read on this computer.
pub(crate) fn store_key(conn: &Connection) -> AppResult<StoreKey> {
    if let Some(stored) = services::get_setting(conn, STORE_KEY_SETTING)?.filter(|value| !value.is_empty()) {
        if let Some(key) = crate::secure::unprotect_secret(&stored).ok().and_then(|secret| StoreKey::from_hex(&secret.value)) {
            return Ok(key);
        }
    }
    let mut key = [0u8; 32];
    OsRng.fill_bytes(&mut key);
    services::set_setting(conn, STORE_KEY_SETTING, &crate::secure::protect_secret(&hex::encode(key))?)?;
    Ok(StoreKey::from_bytes(key))
}

// ── Attachment store ────────────────────────────────────────────────────────

fn store_root(backup_root: &Path, id: &str) -> PathBuf {
    backup_root.join(STORE_DIR).join(id)
}

fn blob_path(store: &Path, sha256: &str) -> PathBuf {
    store.join(&sha256[..2]).join(format!("{sha256}.blob"))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

fn encrypt_blob(key: &StoreKey, sha256: &str, plain: &[u8]) -> AppResult<Vec<u8>> {
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let sealed = key.cipher()
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: plain, aad: sha256.as_bytes() })
        .map_err(other)?;
    let mut out = Vec::with_capacity(plain.len() + BLOB_OVERHEAD as usize);
    out.extend_from_slice(BLOB_MAGIC);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sealed);
    Ok(out)
}

fn decrypt_blob(key: &StoreKey, sha256: &str, sealed: &[u8]) -> AppResult<Vec<u8>> {
    if sealed.len() < BLOB_OVERHEAD as usize || &sealed[..8] != BLOB_MAGIC {
        return Err(AppError::Validation(format!("ملف تالف في مخزن المرفقات: {sha256}")));
    }
    let plain = key.cipher()
        .decrypt(Nonce::from_slice(&sealed[8..20]), Payload { msg: &sealed[20..], aad: sha256.as_bytes() })
        .map_err(|_| AppError::Validation(format!("ملف تالف في مخزن المرفقات: {sha256}")))?;
    if sha256_hex(&plain) != sha256 {
        return Err(AppError::Validation(format!("ملف تالف في مخزن المرفقات: {sha256}")));
    }
    Ok(plain)
}

/// Stores one attachment unless the store already holds it. A new file is read back and checked
/// before it gets its final name. Returns true when it was written.
fn put_blob(key: &StoreKey, store: &Path, sha256: &str, plain: &[u8]) -> AppResult<bool> {
    let path = blob_path(store, sha256);
    if std::fs::metadata(&path).is_ok_and(|meta| meta.is_file() && meta.len() == plain.len() as u64 + BLOB_OVERHEAD) {
        return Ok(false);
    }
    let dir = path.parent().expect("blob folder");
    std::fs::create_dir_all(dir).map_err(other)?;
    let mut pending = tempfile::NamedTempFile::new_in(dir).map_err(other)?;
    pending.write_all(&encrypt_blob(key, sha256, plain)?).map_err(other)?;
    pending.as_file().sync_all().map_err(other)?;
    decrypt_blob(key, sha256, &std::fs::read(pending.path()).map_err(other)?)?;
    // Replaces a damaged or partial file of the same name.
    pending.persist(&path).map_err(other)?;
    Ok(true)
}

// ── Backup files (format 3) ─────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
struct Snapshot {
    format_version: u32,
    created_at: String,
    store_id: String,
    store_key: String,
    database_sha256: String,
    files: Vec<BackupManifestFile>,
}

/// Writes a backup file at `path` (replacing a previous file there only when `replace`).
/// The file is verified before it gets its final name.
pub(crate) fn create_snapshot(
    conn: &Connection,
    password: &str,
    path: &Path,
    replace: bool,
    progress: &mut dyn FnMut(BackupProgress),
) -> AppResult<()> {
    services::validate_new_password(password)?;
    progress(backup_progress(3, "جاري تجهيز النسخة الاحتياطية..."));
    let key = store_key(conn)?;
    let backup_root = crate::paths::backup_root();
    let store = store_root(&backup_root, &key.id);
    std::fs::create_dir_all(&store).map_err(|error| {
        AppError::Validation(format!("مجلد النسخ الاحتياطية غير متاح ({}): {error}", backup_root.display()))
    })?;

    progress(backup_progress(8, "جاري نسخ قاعدة البيانات..."));
    let work_dir = crate::paths::data_root();
    std::fs::create_dir_all(&work_dir).map_err(other)?;
    let database = {
        let snapshot = tempfile::NamedTempFile::new_in(&work_dir).map_err(other)?;
        conn.backup(rusqlite::MAIN_DB, snapshot.path(), None::<fn(rusqlite::backup::Progress)>)?;
        std::fs::read(snapshot.path()).map_err(other)?
    };

    let mut sources = Vec::new();
    services::collect_backup_files(&services::storage_path(conn), Path::new(""), &mut sources)?;
    sources.sort();
    let total = sources.len().max(1);
    let mut files = Vec::with_capacity(sources.len());
    for (index, (archive_path, source)) in sources.into_iter().enumerate() {
        progress(backup_progress(12 + (index * 68 / total) as u8, "جاري حفظ المرفقات الجديدة في مخزن النسخ..."));
        // Read once: the hash and the stored copy always describe the same bytes.
        let bytes = std::fs::read(&source).map_err(other)?;
        let sha256 = sha256_hex(&bytes);
        put_blob(&key, &store, &sha256, &bytes)?;
        files.push(BackupManifestFile { path: archive_path, size: bytes.len() as u64, sha256 });
    }

    progress(backup_progress(82, "جاري ضغط قاعدة البيانات وتشفير النسخة..."));
    let snapshot = Snapshot {
        format_version: SNAPSHOT_FORMAT,
        created_at: chrono::Local::now().to_rfc3339(),
        store_id: key.id.clone(),
        store_key: hex::encode(key.key),
        database_sha256: sha256_hex(&database),
        files,
    };
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    zip.start_file("database.db", options).map_err(other)?;
    zip.write_all(&database).map_err(other)?;
    zip.start_file("snapshot.json", options).map_err(other)?;
    zip.write_all(&serde_json::to_vec(&snapshot).map_err(other)?).map_err(other)?;
    let plain = zip.finish().map_err(other)?.into_inner();
    let encrypted = services::encrypt_backup(&plain, password, SNAPSHOT_MAGIC)?;

    let dir = path.parent().ok_or_else(|| AppError::Validation("Invalid backup destination".into()))?;
    std::fs::create_dir_all(dir).map_err(other)?;
    let mut pending = tempfile::NamedTempFile::new_in(dir).map_err(other)?;
    pending.write_all(&encrypted).map_err(other)?;
    pending.as_file().sync_all().map_err(other)?;
    progress(backup_progress(90, "جاري التحقق من النسخة وتجربة الاستعادة المؤقتة..."));
    verify_snapshot_file(pending.path(), password)?;
    if replace {
        pending.persist(path).map_err(other)?;
    } else {
        pending.persist_noclobber(path).map_err(other)?;
    }
    write_refs(&key, path, snapshot.files.iter().map(|file| file.sha256.as_str()))?;
    progress(backup_progress(100, "اكتملت النسخة الاحتياطية والتحقق منها"));
    Ok(())
}

fn read_snapshot(path: &Path, password: &str) -> AppResult<(Snapshot, Vec<u8>)> {
    let encrypted = std::fs::read(path).map_err(|_| AppError::Validation("تعذرت قراءة ملف النسخة الاحتياطية".into()))?;
    let plain = services::decrypt_with_magic(&encrypted, password, SNAPSHOT_MAGIC)?;
    let damaged = || AppError::Validation("ملف النسخة الاحتياطية تالف".into());
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(plain)).map_err(|_| damaged())?;
    if archive.len() != 2 {
        return Err(damaged());
    }
    let mut read_entry = |name: &str| -> AppResult<Vec<u8>> {
        let mut entry = archive.by_name(name).map_err(|_| damaged())?;
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).map_err(|_| damaged())?;
        Ok(bytes)
    };
    let snapshot: Snapshot = serde_json::from_slice(&read_entry("snapshot.json")?).map_err(|_| damaged())?;
    let database = read_entry("database.db")?;
    if snapshot.format_version != SNAPSHOT_FORMAT {
        return Err(AppError::Validation("هذه النسخة من إصدار أحدث من البرنامج".into()));
    }
    if sha256_hex(&database) != snapshot.database_sha256
        || StoreKey::from_hex(&snapshot.store_key).is_none_or(|key| key.id != snapshot.store_id)
    {
        return Err(damaged());
    }
    let mut seen = HashSet::new();
    for file in &snapshot.files {
        crate::files::safe_relative_path(&file.path)?;
        if !file.path.starts_with("Data/") || !valid_sha256(&file.sha256) || !seen.insert(file.path.as_str()) {
            return Err(damaged());
        }
    }
    Ok((snapshot, database))
}

/// Finds the attachment store for a backup file: next to it (the backup folder it lives in, even
/// when that folder was copied elsewhere), or in the configured backup folder.
fn find_store(snapshot_path: &Path, id: &str) -> Option<PathBuf> {
    snapshot_path.ancestors().skip(1).take(5)
        .map(|folder| store_root(folder, id))
        .chain(std::iter::once(store_root(&crate::paths::backup_root(), id)))
        .find(|candidate| candidate.is_dir())
}

fn missing_store_error() -> AppError {
    AppError::Validation(
        "لم يُعثر على مخزن المرفقات (مجلد Store) بجانب هذه النسخة. انسخ مجلد النسخ الاحتياطية كاملًا، أو استعمل «تصدير نسخة كاملة» لنقل نسخة في ملف واحد.".into(),
    )
}

/// Checks a backup file without restoring it: the database (integrity, references, a trial
/// restore), and that every attachment it lists is in the store with the right size.
pub(crate) fn verify_snapshot_file(path: &Path, password: &str) -> AppResult<()> {
    let (snapshot, database) = read_snapshot(path, password)?;
    let check = tempfile::tempdir().map_err(other)?;
    let database_path = check.path().join("database.db");
    std::fs::write(&database_path, &database).map_err(other)?;
    services::validate_database(&database_path)?;
    let listed: HashSet<String> = snapshot.files.iter().map(|file| file.path.clone()).collect();
    services::validate_backup_references_with(&database_path, &|relative| {
        listed.contains(&format!("Data/{}", relative.to_string_lossy().replace('\\', "/")))
    })?;
    services::trial_restore_database(&database_path)?;
    let store = find_store(path, &snapshot.store_id).ok_or_else(missing_store_error)?;
    for file in &snapshot.files {
        let blob = blob_path(&store, &file.sha256);
        if std::fs::metadata(&blob).map(|meta| meta.len()).ok() != Some(file.size + BLOB_OVERHEAD) {
            return Err(AppError::Validation(format!("مخزن المرفقات ينقصه ملف: {}", file.path)));
        }
    }
    Ok(())
}

/// Rebuilds a backup in `staging` (database.db and Data/), each attachment decrypted and checked
/// against its SHA-256, then validated like a full backup.
pub(crate) fn materialize_snapshot(path: &Path, password: &str, staging: &Path) -> AppResult<()> {
    let (snapshot, database) = read_snapshot(path, password)?;
    let key = StoreKey::from_hex(&snapshot.store_key).ok_or_else(|| AppError::Validation("ملف النسخة الاحتياطية تالف".into()))?;
    let store = find_store(path, &snapshot.store_id).ok_or_else(missing_store_error)?;
    std::fs::create_dir_all(staging.join("Data")).map_err(other)?;
    let database_path = staging.join("database.db");
    std::fs::write(&database_path, &database).map_err(other)?;
    for file in &snapshot.files {
        let sealed = std::fs::read(blob_path(&store, &file.sha256))
            .map_err(|_| AppError::Validation(format!("مخزن المرفقات ينقصه ملف: {}", file.path)))?;
        let plain = decrypt_blob(&key, &file.sha256, &sealed)?;
        if plain.len() as u64 != file.size {
            return Err(AppError::Validation(format!("ملف تالف في مخزن المرفقات: {}", file.path)));
        }
        let target = staging.join(crate::files::safe_relative_path(&file.path)?);
        std::fs::create_dir_all(target.parent().expect("parent")).map_err(other)?;
        std::fs::write(&target, plain).map_err(other)?;
    }
    services::validate_database(&database_path)?;
    services::validate_backup_references(&database_path, staging)?;
    services::trial_restore_database(&database_path)
}

// ── Reference lists (for cleaning the store) ────────────────────────────────

fn refs_path(snapshot: &Path) -> PathBuf {
    let mut name = snapshot.as_os_str().to_owned();
    name.push(".refs");
    PathBuf::from(name)
}

/// Next to each backup file: the attachments it uses, encrypted with the store key, with the
/// store id in clear so the store can be cleaned without any backup password.
fn write_refs<'a>(key: &StoreKey, snapshot: &Path, hashes: impl Iterator<Item = &'a str>) -> AppResult<()> {
    let list: Vec<&str> = hashes.collect();
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let sealed = key.cipher()
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: &serde_json::to_vec(&list).map_err(other)?, aad: b"refs" })
        .map_err(other)?;
    let path = refs_path(snapshot);
    let mut pending = tempfile::NamedTempFile::new_in(path.parent().expect("parent")).map_err(other)?;
    pending.write_all(REFS_MAGIC).map_err(other)?;
    pending.write_all(key.id.as_bytes()).map_err(other)?;
    pending.write_all(&nonce).map_err(other)?;
    pending.write_all(&sealed).map_err(other)?;
    pending.as_file().sync_all().map_err(other)?;
    pending.persist(&path).map_err(other)?;
    Ok(())
}

/// The store id named in a reference list, and its hashes when `key` opens it.
fn read_refs(path: &Path, key: &StoreKey) -> Option<(String, Option<Vec<String>>)> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() < 8 + 16 + 12 || &bytes[..8] != REFS_MAGIC {
        return None;
    }
    let id = String::from_utf8(bytes[8..24].to_vec()).ok()?;
    if id != key.id {
        return Some((id, None));
    }
    let plain = key.cipher()
        .decrypt(Nonce::from_slice(&bytes[24..36]), Payload { msg: &bytes[36..], aad: b"refs" })
        .ok()?;
    Some((id, Some(serde_json::from_slice(&plain).ok()?)))
}

// ── Walking the backup folder ───────────────────────────────────────────────

fn walk_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => walk_files(&path, out),
            Ok(kind) if kind.is_file() => out.push(path),
            _ => {}
        }
    }
}

fn is_backup_file(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("autohrbak"))
}

fn has_magic(path: &Path, magic: &[u8; 9]) -> bool {
    let mut head = [0u8; 9];
    File::open(path).and_then(|mut file| file.read_exact(&mut head)).is_ok() && &head == magic
}

/// Backup files under the backup folder (the store is skipped).
fn backup_files(backup_root: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(backup_root) else { return Vec::new() };
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && entry.file_name() != STORE_DIR {
            walk_files(&path, &mut files);
        } else if path.is_file() {
            files.push(path);
        }
    }
    files.retain(|path| is_backup_file(path));
    files
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Usage {
    pub bytes: u64,
    pub backup_files: u64,
}

/// Space used by the backup folder: backup files, reference lists and the attachment store.
pub(crate) fn usage(backup_root: &Path) -> Usage {
    let mut files = Vec::new();
    walk_files(backup_root, &mut files);
    Usage {
        bytes: files.iter().filter_map(|path| std::fs::metadata(path).ok()).map(|meta| meta.len()).sum(),
        backup_files: files.iter().filter(|path| is_backup_file(path)).count() as u64,
    }
}

// ── Keep rule ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Retention {
    pub keep_daily: u32,
    pub keep_weekly: u32,
    pub keep_monthly: u32,
    pub auto_delete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AutoBackup {
    pub path: PathBuf,
    pub date: NaiveDate,
    /// Orders backups of the same day (the time in older file names; later is larger).
    pub order: String,
}

fn date_in_name(name: &str) -> Option<(NaiveDate, String)> {
    let start = name.char_indices().find_map(|(index, _)| {
        let part = name.get(index..index + 10)?;
        NaiveDate::parse_from_str(part, "%Y-%m-%d").ok().map(|date| (index, date))
    })?;
    Some((start.1, name[start.0 + 10..].to_string()))
}

/// Automatic backups: today's format (`cnsarch_daily_2026-11-25.autohrbak`) and the files of
/// earlier releases (`cnsarch_daily|weekly|monthly_2026-11-25_141203.autohrbak`, several a day).
pub(crate) fn automatic_backups(backup_root: &Path) -> Vec<AutoBackup> {
    let mut found = Vec::new();
    for folder in ["Daily", "Weekly", "Monthly"] {
        let mut files = Vec::new();
        walk_files(&backup_root.join(folder), &mut files);
        for path in files.into_iter().filter(|path| is_backup_file(path)) {
            let Some(name) = path.file_name().and_then(|n| n.to_str()).map(str::to_string) else { continue };
            if !["cnsarch_daily_", "cnsarch_weekly_", "cnsarch_monthly_"].iter().any(|prefix| name.starts_with(prefix)) {
                continue;
            }
            if let Some((date, rest)) = date_in_name(&name) {
                // A current daily file (no time in its name) is the latest of its day.
                let order = if rest.starts_with('.') { "~".to_string() } else { rest };
                found.push(AutoBackup { path, date, order });
            }
        }
    }
    found
}

/// Which automatic backups to keep: the newest one of each of the last `keep_daily` days that
/// have a backup; of the older ones, the newest of each of the next `keep_weekly` weeks; of the
/// older ones still, the newest of each of the next `keep_monthly` months.
pub(crate) fn plan_retention(mut backups: Vec<AutoBackup>, retention: &Retention) -> (Vec<AutoBackup>, Vec<AutoBackup>) {
    backups.sort_by(|a, b| (b.date, &b.order).cmp(&(a.date, &a.order)));
    let mut keep = vec![false; backups.len()];
    let mut boundary: Option<NaiveDate> = None;

    let pick = |period: &dyn Fn(NaiveDate) -> (i32, u32), count: u32, boundary: &mut Option<NaiveDate>, keep: &mut Vec<bool>| {
        let mut periods: Vec<(i32, u32)> = Vec::new();
        let mut oldest_kept = None;
        for (index, backup) in backups.iter().enumerate() {
            if boundary.is_some_and(|limit| backup.date >= limit) {
                continue;
            }
            let key = period(backup.date);
            if periods.contains(&key) {
                continue;
            }
            if periods.len() as u32 >= count {
                break;
            }
            periods.push(key);
            keep[index] = true;
            oldest_kept = Some(backup.date);
        }
        // Older stages only look at what lies before the first day of the oldest kept period.
        if let Some(date) = oldest_kept {
            let first_day = backups.iter().map(|b| b.date).filter(|d| period(*d) == period(date)).min().unwrap_or(date);
            *boundary = Some(first_day);
        }
    };
    pick(&|date| (date.num_days_from_ce(), 0), retention.keep_daily.max(MIN_KEEP_DAILY), &mut boundary, &mut keep);
    pick(&|date| { let week = date.iso_week(); (week.year(), week.week()) }, retention.keep_weekly, &mut boundary, &mut keep);
    pick(&|date| (date.year(), date.month()), retention.keep_monthly, &mut boundary, &mut keep);

    let mut kept = Vec::new();
    let mut removed = Vec::new();
    for (backup, keep) in backups.into_iter().zip(keep) {
        if keep { kept.push(backup) } else { removed.push(backup) }
    }
    (kept, removed)
}

/// Applies the keep rule to the automatic backups, then removes from the store the attachments
/// no backup uses any more. Returns how many backup files were removed.
pub(crate) fn apply_retention(backup_root: &Path, retention: &Retention, key: &StoreKey) -> AppResult<usize> {
    if !retention.auto_delete {
        return Ok(0);
    }
    let (_, removed) = plan_retention(automatic_backups(backup_root), retention);
    for backup in &removed {
        std::fs::remove_file(&backup.path).map_err(other)?;
        std::fs::remove_file(refs_path(&backup.path)).ok();
    }
    clean_store(backup_root, key);
    Ok(removed.len())
}

fn modified_long_ago(path: &Path) -> bool {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.elapsed().ok())
        .is_some_and(|age| age >= STORE_GRACE)
}

/// Removes attachments no backup refers to. Does nothing unless every backup file of format 3
/// in the folder has an up-to-date reference list, so a file that cannot be accounted for never
/// loses its attachments.
pub(crate) fn clean_store(backup_root: &Path, key: &StoreKey) {
    let mut used: HashSet<String> = HashSet::new();
    let mut stores_in_use: HashSet<String> = HashSet::new();
    for snapshot in backup_files(backup_root).into_iter().filter(|path| has_magic(path, SNAPSHOT_MAGIC)) {
        let refs = refs_path(&snapshot);
        let fresh = match (std::fs::metadata(&snapshot).and_then(|m| m.modified()), std::fs::metadata(&refs).and_then(|m| m.modified())) {
            (Ok(snapshot_time), Ok(refs_time)) => refs_time >= snapshot_time,
            _ => false,
        };
        let Some((id, hashes)) = read_refs(&refs, key).filter(|_| fresh) else { return };
        if id == key.id {
            let Some(hashes) = hashes else { return };
            used.extend(hashes);
        }
        stores_in_use.insert(id);
    }
    let mut blobs = Vec::new();
    walk_files(&store_root(backup_root, &key.id), &mut blobs);
    for blob in blobs {
        let name = blob.file_stem().and_then(|n| n.to_str()).unwrap_or_default().to_string();
        if !used.contains(&name) && modified_long_ago(&blob) {
            std::fs::remove_file(&blob).ok();
        }
    }
    // Stores of earlier keys (another computer, or a key that could not be read) that no backup
    // refers to any more.
    if let Ok(entries) = std::fs::read_dir(backup_root.join(STORE_DIR)) {
        for entry in entries.flatten() {
            let id = entry.file_name().to_string_lossy().into_owned();
            if id == key.id || stores_in_use.contains(&id) || !entry.path().is_dir() {
                continue;
            }
            let mut files = Vec::new();
            walk_files(&entry.path(), &mut files);
            if files.iter().all(|file| modified_long_ago(file)) {
                std::fs::remove_dir_all(entry.path()).ok();
            }
        }
    }
}

// ── Automatic backups ───────────────────────────────────────────────────────

fn now_text() -> String {
    chrono::Local::now().format("%Y-%m-%d %H:%M").to_string()
}

fn minutes_since(text: &str) -> Option<i64> {
    let then = chrono::NaiveDateTime::parse_from_str(text.trim(), "%Y-%m-%d %H:%M").ok()?;
    Some((chrono::Local::now().naive_local() - then).num_minutes())
}

/// Takes today's automatic backup when the data changed since the last one. `in_session` is the
/// regular check while someone works: it also waits for the chosen interval. On sign-out and
/// close any change is backed up. Returns the kinds created («يومي»), or nothing.
pub(crate) fn run_due_automatic_backups(conn: &Connection, in_session: bool, progress: &mut dyn FnMut(BackupProgress)) -> AppResult<Vec<String>> {
    if !services::auto_backup_enabled(conn)? {
        return Ok(Vec::new());
    }
    let password = services::auto_backup_password(conn)?;
    if password.is_empty() {
        return Ok(Vec::new());
    }
    let Some(latest_change) = services::latest_data_change_activity_id(conn)? else {
        return Ok(Vec::new());
    };
    // Earlier releases kept one marker per kind; the daily one is the most recent.
    let last_change = services::parse_setting_i64(conn, "auto_backup_last_change_id")?
        .or(services::parse_setting_i64(conn, "auto_backup_last_daily_change_id")?);
    if last_change.is_some_and(|id| id >= latest_change) {
        return Ok(Vec::new());
    }
    if in_session {
        let interval = services::backup_interval_minutes(conn)?;
        if interval == 0 {
            return Ok(Vec::new());
        }
        let last = services::get_setting(conn, "auto_backup_last_time")?;
        if last.as_deref().and_then(minutes_since).is_some_and(|minutes| minutes < interval as i64) {
            return Ok(Vec::new());
        }
    }

    let today = chrono::Local::now().date_naive();
    let backup_root = crate::paths::backup_root();
    services::ensure_backup_layout(conn)?;
    let path = backup_root.join("Daily").join(today.format("%Y").to_string())
        .join(format!("cnsarch_daily_{}.autohrbak", today.format("%Y-%m-%d")));
    create_snapshot(conn, &password, &path, true, progress)?;
    services::set_setting(conn, "auto_backup_last_daily", &today.format("%Y-%m-%d").to_string())?;
    services::set_setting(conn, "auto_backup_last_daily_path", &path.to_string_lossy())?;
    services::set_setting(conn, "auto_backup_last_change_id", &latest_change.to_string())?;
    services::set_setting(conn, "auto_backup_last_time", &now_text())?;
    services::log_activity(conn, "system", "CREATE_AUTO_BACKUP", Some("backup"), None, path.file_name().and_then(|n| n.to_str()), Some("Daily"));

    // Thinning old backups never fails the backup that was just made.
    let retention = services::backup_retention(conn)?;
    match store_key(conn).and_then(|key| apply_retention(&backup_root, &retention, &key)) {
        Ok(0) => {}
        Ok(removed) => services::log_activity(conn, "system", "DELETE_OLD_BACKUPS", Some("backup"), None, None, Some(&format!("{removed} files"))),
        Err(error) => services::log_audit(conn, Some("system"), "DELETE_OLD_BACKUPS", Some("backup"), None, None, "Failure", Some(&error.to_string())),
    }
    Ok(vec!["يومي".to_string()])
}

// ── Full export (format 4) ──────────────────────────────────────────────────

fn chunk_nonce(prefix: &[u8; 7], counter: u32, last: bool) -> [u8; 12] {
    let mut nonce = [0u8; 12];
    nonce[..7].copy_from_slice(prefix);
    nonce[7..11].copy_from_slice(&counter.to_be_bytes());
    nonce[11] = u8::from(last);
    nonce
}

fn read_up_to(reader: &mut impl Read, size: usize) -> std::io::Result<Vec<u8>> {
    let mut buffer = Vec::with_capacity(size);
    reader.take(size as u64).read_to_end(&mut buffer)?;
    Ok(buffer)
}

/// Encrypts `reader` into `writer` in 1 MiB chunks. Each chunk is authenticated with its number
/// and whether it is the last, so chunks cannot be reordered, dropped or cut off unnoticed.
pub(crate) fn encrypt_stream(mut reader: impl Read, writer: &mut impl Write, password: &str) -> AppResult<()> {
    let mut salt = [0u8; 16];
    let mut prefix = [0u8; 7];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut prefix);
    let cipher = Aes256Gcm::new_from_slice(&services::backup_key(password, &salt)?).map_err(other)?;
    writer.write_all(STREAM_MAGIC).map_err(other)?;
    writer.write_all(&salt).map_err(other)?;
    writer.write_all(&prefix).map_err(other)?;
    let mut counter: u32 = 0;
    let mut current = read_up_to(&mut reader, CHUNK).map_err(other)?;
    loop {
        let next = read_up_to(&mut reader, CHUNK).map_err(other)?;
        let last = next.is_empty();
        let sealed = cipher.encrypt(Nonce::from_slice(&chunk_nonce(&prefix, counter, last)), current.as_slice()).map_err(other)?;
        writer.write_all(&(sealed.len() as u32).to_le_bytes()).map_err(other)?;
        writer.write_all(&sealed).map_err(other)?;
        if last {
            return Ok(());
        }
        current = next;
        counter = counter.checked_add(1).ok_or_else(|| other("backup too large"))?;
    }
}

fn read_chunk_length(reader: &mut impl Read) -> AppResult<Option<u32>> {
    let mut bytes = [0u8; 4];
    let read = read_up_to(reader, 4).map_err(other)?;
    match read.len() {
        0 => Ok(None),
        4 => { bytes.copy_from_slice(&read); Ok(Some(u32::from_le_bytes(bytes))) }
        _ => Err(AppError::Validation("ملف النسخة الاحتياطية تالف أو ناقص".into())),
    }
}

pub(crate) fn decrypt_stream(mut reader: impl Read, writer: &mut impl Write, password: &str) -> AppResult<()> {
    let damaged = || AppError::Validation("ملف النسخة الاحتياطية تالف أو ناقص".into());
    let mut header = [0u8; 9 + 16 + 7];
    reader.read_exact(&mut header).map_err(|_| damaged())?;
    if &header[..9] != STREAM_MAGIC {
        return Err(AppError::Validation("هذا الملف ليس نسخة احتياطية صالحة للبرنامج".into()));
    }
    let cipher = Aes256Gcm::new_from_slice(&services::backup_key(password, &header[9..25])?).map_err(other)?;
    let prefix: [u8; 7] = header[25..32].try_into().expect("7 bytes");
    let mut counter: u32 = 0;
    let mut length = read_chunk_length(&mut reader)?.ok_or_else(damaged)?;
    loop {
        if length as usize > CHUNK + 16 {
            return Err(damaged());
        }
        let sealed = read_up_to(&mut reader, length as usize).map_err(other)?;
        if sealed.len() != length as usize {
            return Err(damaged());
        }
        let next = read_chunk_length(&mut reader)?;
        let last = next.is_none();
        let plain = cipher.decrypt(Nonce::from_slice(&chunk_nonce(&prefix, counter, last)), sealed.as_slice())
            .map_err(|_| if counter == 0 { AppError::Validation(services::WRONG_BACKUP_PASSWORD.into()) } else { damaged() })?;
        writer.write_all(&plain).map_err(other)?;
        match next {
            None => return Ok(()),
            Some(value) => length = value,
        }
        counter = counter.checked_add(1).ok_or_else(damaged)?;
    }
}

pub(crate) fn decrypt_stream_file(path: &Path, out: &File, password: &str) -> AppResult<()> {
    let reader = BufReader::new(File::open(path).map_err(|_| AppError::Validation("تعذرت قراءة ملف النسخة الاحتياطية".into()))?);
    let mut writer = BufWriter::new(out);
    decrypt_stream(reader, &mut writer, password)?;
    writer.flush().map_err(other)?;
    Ok(())
}

/// One self-contained backup file with the database and every attachment. Plain data only ever
/// sits in a temporary file inside the data folder; the destination gets the encrypted file,
/// verified before it receives its final name.
pub(crate) fn write_full_export(conn: &Connection, password: &str, path: &Path, progress: &mut dyn FnMut(BackupProgress)) -> AppResult<()> {
    services::validate_new_password(password)?;
    progress(backup_progress(3, "جاري تجهيز ملف النسخة الكاملة..."));
    let work_dir = crate::paths::data_root();
    std::fs::create_dir_all(&work_dir).map_err(other)?;
    let database = tempfile::NamedTempFile::new_in(&work_dir).map_err(other)?;
    progress(backup_progress(8, "جاري نسخ قاعدة البيانات..."));
    conn.backup(rusqlite::MAIN_DB, database.path(), None::<fn(rusqlite::backup::Progress)>)?;
    let archive = tempfile::NamedTempFile::new_in(&work_dir).map_err(other)?;
    services::write_plain_archive(conn, database.path(), archive.reopen().map_err(other)?, progress)?;
    drop(database);

    progress(backup_progress(75, "جاري تشفير النسخة..."));
    let dir = path.parent().ok_or_else(|| AppError::Validation("Invalid backup destination".into()))?;
    let pending = tempfile::NamedTempFile::new_in(dir).map_err(other)?;
    {
        let mut writer = BufWriter::new(pending.as_file());
        encrypt_stream(BufReader::new(archive.reopen().map_err(other)?), &mut writer, password)?;
        writer.flush().map_err(other)?;
    }
    pending.as_file().sync_all().map_err(other)?;
    drop(archive);
    progress(backup_progress(85, "جاري فحص النسخة: فك التشفير والتحقق من كل ملف وتجربة الاستعادة..."));
    services::verify_written_backup(pending.path(), password)?;
    pending.persist_noclobber(path).map_err(other)?;
    progress(backup_progress(100, "تم تصدير النسخة والتحقق منها"));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn backups(dates: &[&str]) -> Vec<AutoBackup> {
        dates.iter().map(|date| AutoBackup {
            path: PathBuf::from(format!("cnsarch_daily_{date}.autohrbak")),
            date: NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap(),
            order: "~".into(),
        }).collect()
    }

    #[test]
    fn keep_rule_keeps_days_then_weeks_then_months() {
        // One backup every day for a year and a half.
        let start = NaiveDate::from_ymd_opt(2025, 6, 1).unwrap();
        let dates: Vec<String> = (0..540).map(|day| (start + chrono::Days::new(day)).format("%Y-%m-%d").to_string()).collect();
        let refs: Vec<&str> = dates.iter().map(String::as_str).collect();
        let rule = Retention { keep_daily: 7, keep_weekly: 4, keep_monthly: 12, auto_delete: true };
        let (kept, removed) = plan_retention(backups(&refs), &rule);
        assert_eq!(kept.len(), 7 + 4 + 12, "{:?}", kept.iter().map(|b| b.date).collect::<Vec<_>>());
        assert_eq!(kept.len() + removed.len(), 540);
        let newest = start + chrono::Days::new(539);
        assert_eq!(kept[0].date, newest);
        assert_eq!(kept[6].date, newest - chrono::Days::new(6));
        // Weeks and months never overlap the days kept before them.
        let mut seen = HashSet::new();
        assert!(kept.iter().all(|b| seen.insert(b.date)));
    }

    #[test]
    fn several_backups_of_one_day_keep_only_the_latest() {
        let mut list = backups(&["2026-11-25", "2026-11-25", "2026-11-24"]);
        list[0].order = "_090000.autohrbak".into();
        list[1].order = "_170000.autohrbak".into();
        let rule = Retention { keep_daily: 7, keep_weekly: 0, keep_monthly: 0, auto_delete: true };
        let (kept, removed) = plan_retention(list, &rule);
        assert_eq!(kept.len(), 2);
        assert_eq!(kept[0].order, "_170000.autohrbak");
        assert_eq!(removed.len(), 1);
    }

    #[test]
    fn keep_daily_never_goes_below_three() {
        let rule = Retention { keep_daily: 1, keep_weekly: 0, keep_monthly: 0, auto_delete: true };
        let (kept, _) = plan_retention(backups(&["2026-11-25", "2026-11-24", "2026-11-23", "2026-11-22"]), &rule);
        assert_eq!(kept.len(), 3);
    }

    #[test]
    fn stream_encryption_round_trips_and_detects_tampering() {
        let data: Vec<u8> = (0..(CHUNK * 2 + 123)).map(|i| (i % 251) as u8).collect();
        let mut sealed = Vec::new();
        encrypt_stream(data.as_slice(), &mut sealed, "Backup-2026!").unwrap();
        let mut plain = Vec::new();
        decrypt_stream(sealed.as_slice(), &mut plain, "Backup-2026!").unwrap();
        assert_eq!(plain, data);
        assert!(decrypt_stream(sealed.as_slice(), &mut Vec::new(), "Wrong-pass-1").is_err());
        // Cut after the first chunk: the missing end is noticed.
        let first = 9 + 16 + 7 + 4 + CHUNK + 16;
        assert!(decrypt_stream(&sealed[..first], &mut Vec::new(), "Backup-2026!").is_err());
        let mut flipped = sealed.clone();
        let last = flipped.len() - 1;
        flipped[last] ^= 1;
        assert!(decrypt_stream(flipped.as_slice(), &mut Vec::new(), "Backup-2026!").is_err());
        // Empty input still makes a valid file.
        let mut empty = Vec::new();
        encrypt_stream([].as_slice(), &mut empty, "Backup-2026!").unwrap();
        let mut out = Vec::new();
        decrypt_stream(empty.as_slice(), &mut out, "Backup-2026!").unwrap();
        assert!(out.is_empty());
    }
}
