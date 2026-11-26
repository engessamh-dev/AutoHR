// src-tauri/src/paths.rs
//! Where the application keeps its data and its backups.
//!
//! The two locations are chosen by an administrator on first launch and stored in
//! `config.json` under the fixed application folder (`%APPDATA%\CNSArch` in release,
//! `%APPDATA%\CNSArch-Development` in development). The file lives outside the database
//! so that the application knows where the database is before opening it, and so that
//! upgrades and reinstalls keep the choice.
//!
//! Layout inside the data folder (identical to the historical layout):
//!   <data_root>\database.db
//!   <data_root>\Data\...            attachments, branding, ...
//! Installs that predate this file keep `%APPDATA%\CNSArch` as their data folder and
//! `%APPDATA%\CNSArch\Backups` as their backup folder until an administrator moves them.

use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
#[cfg(not(test))]
use std::sync::RwLock;

use crate::services::{app_data_path, AppError, AppResult};

const CONFIG_FILE: &str = "config.json";
const CONFIG_VERSION: u32 = 1;
pub const DATABASE_FILE: &str = "database.db";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppPaths {
    pub data_root: PathBuf,
    pub backup_root: PathBuf,
}

#[derive(Debug, Serialize, Deserialize)]
struct ConfigFile {
    version: u32,
    data_root: String,
    backup_root: String,
}

#[cfg(not(test))]
static CURRENT: RwLock<Option<AppPaths>> = RwLock::new(None);

#[cfg(not(test))]
pub fn current() -> Option<AppPaths> {
    CURRENT.read().unwrap_or_else(|e| e.into_inner()).clone()
}

#[cfg(not(test))]
pub fn set_current(paths: Option<AppPaths>) {
    *CURRENT.write().unwrap_or_else(|e| e.into_inner()) = paths;
}

// Tests run in parallel threads: keep the configured paths per thread so they never
// leak into each other.
#[cfg(test)]
thread_local! { static CURRENT: std::cell::RefCell<Option<AppPaths>> = const { std::cell::RefCell::new(None) }; }

#[cfg(test)]
pub fn current() -> Option<AppPaths> {
    CURRENT.with(|value| value.borrow().clone())
}

#[cfg(test)]
pub fn set_current(paths: Option<AppPaths>) {
    CURRENT.with(|value| *value.borrow_mut() = paths);
}

/// Data folder in use. Falls back to the historical location when nothing is configured.
pub fn data_root() -> PathBuf {
    current().map(|p| p.data_root).unwrap_or_else(app_data_path)
}

/// Backup folder in use. Falls back to the historical location when nothing is configured.
pub fn backup_root() -> PathBuf {
    current().map(|p| p.backup_root).unwrap_or_else(|| app_data_path().join("Backups"))
}

pub fn config_path() -> PathBuf {
    app_data_path().join(CONFIG_FILE)
}

/// What the application should do on startup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartupState {
    /// Locations are known and the database exists.
    Ready(AppPaths),
    /// First launch: an administrator must choose the two folders.
    NeedsSetup,
    /// Locations are configured but the database cannot be found (disk missing, drive
    /// letter changed, network share offline). A new empty database must NOT be created.
    DataMissing(AppPaths),
}

fn read_config() -> AppResult<Option<AppPaths>> {
    let path = config_path();
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path).map_err(|e| AppError::Other(format!("Cannot read {}: {e}", path.display())))?;
    let config: ConfigFile = serde_json::from_str(&text)
        .map_err(|e| AppError::Other(format!("Invalid {}: {e}", path.display())))?;
    if config.data_root.trim().is_empty() || config.backup_root.trim().is_empty() {
        return Err(AppError::Other(format!("Invalid {}: empty folder", path.display())));
    }
    Ok(Some(AppPaths {
        data_root: PathBuf::from(config.data_root),
        backup_root: PathBuf::from(config.backup_root),
    }))
}

/// Writes config.json atomically (temporary file + rename) so a crash never leaves a
/// half-written file behind.
pub fn write_config(paths: &AppPaths) -> AppResult<()> {
    let dir = app_data_path();
    std::fs::create_dir_all(&dir).map_err(|e| AppError::Other(e.to_string()))?;
    let config = ConfigFile {
        version: CONFIG_VERSION,
        data_root: paths.data_root.to_string_lossy().into_owned(),
        backup_root: paths.backup_root.to_string_lossy().into_owned(),
    };
    let bytes = serde_json::to_vec_pretty(&config).map_err(|e| AppError::Other(e.to_string()))?;
    let mut pending = tempfile::NamedTempFile::new_in(&dir).map_err(|e| AppError::Other(e.to_string()))?;
    std::io::Write::write_all(&mut pending, &bytes).map_err(|e| AppError::Other(e.to_string()))?;
    pending.as_file().sync_all().map_err(|e| AppError::Other(e.to_string()))?;
    pending.persist(config_path()).map_err(|e| AppError::Other(e.to_string()))?;
    Ok(())
}

pub fn legacy_paths() -> AppPaths {
    AppPaths { data_root: app_data_path(), backup_root: app_data_path().join("Backups") }
}

/// Decides how to start. Existing installs without config.json are recorded with their
/// historical locations so that nothing moves during an upgrade.
pub fn resolve_startup() -> AppResult<StartupState> {
    if let Some(paths) = read_config()? {
        return Ok(if paths.data_root.join(DATABASE_FILE).is_file() {
            StartupState::Ready(paths)
        } else {
            StartupState::DataMissing(paths)
        });
    }
    let legacy = legacy_paths();
    if legacy.data_root.join(DATABASE_FILE).is_file() {
        write_config(&legacy)?;
        return Ok(StartupState::Ready(legacy));
    }
    Ok(StartupState::NeedsSetup)
}

/// True when the data folder is still the historical `%APPDATA%\CNSArch` location.
pub fn is_legacy_location(paths: &AppPaths) -> bool {
    normalize(&paths.data_root) == normalize(&app_data_path())
}

// ── Validation ─────────────────────────────────────────────────────────────

fn normalize(path: &Path) -> PathBuf {
    // Canonicalize the deepest folder that exists, then re-append the rest, so that a
    // folder that does not exist yet still compares correctly with existing ones.
    let mut existing = path.to_path_buf();
    let mut rest = Vec::new();
    let canonical = loop {
        if let Ok(found) = std::fs::canonicalize(&existing) {
            break found;
        }
        match (existing.file_name().map(|n| n.to_os_string()), existing.parent()) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                existing = parent.to_path_buf();
            }
            _ => {
                rest.clear();
                break path.to_path_buf();
            }
        }
    };
    let mut absolute = canonical;
    for name in rest.into_iter().rev() {
        absolute.push(name);
    }
    if cfg!(windows) {
        // Drop the \\?\ verbatim prefix that canonicalize adds, and compare
        // case-insensitively like Windows does.
        let text = absolute.to_string_lossy().to_string();
        let text = text.strip_prefix(r"\\?\UNC\").map(|t| format!(r"\\{t}")).unwrap_or(text);
        let text = text.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(text);
        PathBuf::from(text.to_lowercase())
    } else {
        absolute
    }
}

pub fn is_same_or_inside(path: &Path, parent: &Path) -> bool {
    normalize(path).starts_with(normalize(parent))
}

pub(crate) fn drive_of(path: &Path) -> Option<String> {
    match normalize(path).components().next() {
        Some(Component::Prefix(prefix)) => Some(prefix.as_os_str().to_string_lossy().to_lowercase()),
        _ => None,
    }
}

fn program_dir() -> Option<PathBuf> {
    std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf))
}

/// Creates the folder if needed and proves it is writable by writing and deleting a file.
pub fn ensure_writable(dir: &Path) -> AppResult<()> {
    std::fs::create_dir_all(dir)
        .map_err(|e| AppError::Validation(format!("تعذر إنشاء المجلد {}: {e}", dir.display())))?;
    let probe = tempfile::NamedTempFile::new_in(dir)
        .map_err(|e| AppError::Validation(format!("لا يمكن الكتابة في المجلد {}: {e}", dir.display())))?;
    std::io::Write::write_all(&mut probe.as_file(), b"cnsarch-write-test")
        .map_err(|e| AppError::Validation(format!("لا يمكن الكتابة في المجلد {}: {e}", dir.display())))?;
    probe.close()
        .map_err(|e| AppError::Validation(format!("لا يمكن الحذف من المجلد {}: {e}", dir.display())))?;
    Ok(())
}

fn validate_absolute(path: &Path, label: &str) -> AppResult<()> {
    if path.as_os_str().is_empty() || !path.is_absolute() {
        return Err(AppError::Validation(format!("اختر مسارًا كاملًا لـ{label}")));
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err(AppError::Validation(format!("مسار {label} غير صالح")));
    }
    Ok(())
}

fn validate_not_program_dir(path: &Path, label: &str) -> AppResult<()> {
    if let Some(program) = program_dir() {
        if is_same_or_inside(path, &program) || is_same_or_inside(&program, path) {
            return Err(AppError::Validation(format!(
                "لا يمكن وضع {label} داخل مجلد البرنامج، لأن التحديثات وإلغاء التثبيت قد تحذفه"
            )));
        }
    }
    Ok(())
}

/// Checks a pair of folders. Returns non-blocking warnings (for example both on the same disk).
pub fn validate_pair(data_root: &Path, backup_root: &Path) -> AppResult<Vec<String>> {
    validate_absolute(data_root, "مجلد البيانات")?;
    validate_absolute(backup_root, "مجلد النسخ الاحتياطية")?;
    validate_not_program_dir(data_root, "مجلد البيانات")?;
    validate_not_program_dir(backup_root, "مجلد النسخ الاحتياطية")?;
    if is_same_or_inside(backup_root, data_root) || is_same_or_inside(data_root, backup_root) {
        return Err(AppError::Validation(
            "يجب أن يكون مجلد النسخ الاحتياطية منفصلًا عن مجلد البيانات، وليس داخله أو يحتويه".into(),
        ));
    }
    let mut warnings = Vec::new();
    if let (Some(a), Some(b)) = (drive_of(data_root), drive_of(backup_root)) {
        if a == b {
            warnings.push("مجلد البيانات ومجلد النسخ الاحتياطية على نفس القرص. يُفضّل وضع النسخ على قرص آخر أو مجلد شبكة.".into());
        }
    }
    Ok(warnings)
}

/// A folder is "empty enough" to receive a fresh copy of the data when it holds no
/// database and no Data tree.
pub fn has_existing_data(dir: &Path) -> bool {
    dir.join(DATABASE_FILE).exists() || dir.join("Data").exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backup_folder_inside_data_folder_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let error = validate_pair(&data, &data.join("Backups")).unwrap_err();
        assert!(matches!(error, AppError::Validation(_)));
        let error = validate_pair(&data.join("inner"), &data).unwrap_err();
        assert!(matches!(error, AppError::Validation(_)));
        assert!(validate_pair(&data, &data).is_err());
    }

    #[test]
    fn separate_folders_are_accepted_with_same_disk_warning_only_on_windows() {
        let dir = tempfile::tempdir().unwrap();
        let warnings = validate_pair(&dir.path().join("data"), &dir.path().join("backups")).unwrap();
        if cfg!(windows) { assert_eq!(warnings.len(), 1); } else { assert!(warnings.is_empty()); }
    }

    #[test]
    fn relative_paths_are_rejected() {
        assert!(validate_pair(Path::new("data"), Path::new("/tmp/backups")).is_err());
    }

    #[test]
    fn writable_probe_leaves_no_files() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("new-folder");
        ensure_writable(&target).unwrap();
        assert_eq!(std::fs::read_dir(&target).unwrap().count(), 0);
    }
}
