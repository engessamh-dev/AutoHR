//! Choosing, moving and checking the data and backup folders.
//!
//! Every operation here is copy-then-verify: the old location is never deleted, and the
//! configuration only switches after the new copy has been proven identical.
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;

use crate::paths::{self, AppPaths, DATABASE_FILE};
use crate::services::{
    assert_permission, backup_progress, create_backup_at, ensure_backup_layout,
    log_activity, sha256_file, AppError, AppResult, BackupProgress,
};

fn io_err(error: std::io::Error) -> AppError {
    AppError::Other(error.to_string())
}

#[derive(Debug, Clone, Serialize)]
pub struct StorageStatus {
    pub data_root: String,
    pub backup_root: String,
    pub backup_reachable: bool,
    pub legacy_location: bool,
    pub warnings: Vec<String>,
}

/// Reports where data and backups live, with non-blocking warnings for the Settings screen.
pub fn storage_status() -> StorageStatus {
    let current = AppPaths { data_root: paths::data_root(), backup_root: paths::backup_root() };
    let backup_reachable = current.backup_root.is_dir() && paths::ensure_writable(&current.backup_root).is_ok();
    let legacy_location = paths::is_legacy_location(&current);
    let mut warnings = Vec::new();
    if !backup_reachable {
        warnings.push("مجلد النسخ الاحتياطية غير متاح حاليًا (قرص غير موصول أو مجلد شبكة غير متصل). العمل مستمر، لكن النسخ التلقائي لن يعمل حتى يعود المجلد أو تختار مجلدًا آخر.".into());
    }
    if legacy_location {
        warnings.push("البيانات محفوظة في الموقع القديم داخل قرص النظام (AppData). يمكنك نقلها إلى قرص آخر من زر «نقل المجلد…» في الإعدادات ← مجلد البيانات.".into());
    }
    if let Ok(mut pair) = paths::validate_pair(&current.data_root, &current.backup_root) {
        warnings.append(&mut pair);
    }
    StorageStatus {
        data_root: current.data_root.to_string_lossy().into_owned(),
        backup_root: current.backup_root.to_string_lossy().into_owned(),
        backup_reachable,
        legacy_location,
        warnings,
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SetupCheck {
    pub warnings: Vec<String>,
    /// The chosen data folder already holds an AutoHR database that will be used as is.
    pub existing_database: bool,
}

/// Validates the two folders chosen on first run (or after the data folder went missing).
/// With `require_existing`, the data folder must already contain a database: used when the
/// configured folder disappeared, so that a new empty database is never created by mistake.
pub fn check_setup(data_root: &Path, backup_root: &Path, require_existing: bool) -> AppResult<SetupCheck> {
    let warnings = paths::validate_pair(data_root, backup_root)?;
    let existing_database = data_root.join(DATABASE_FILE).is_file();
    if require_existing && !existing_database {
        return Err(AppError::Validation(format!(
            "لم يتم العثور على قاعدة بيانات AutoHR في {}. اختر المجلد الذي يحتوي على الملف {DATABASE_FILE}.",
            data_root.display()
        )));
    }
    if !existing_database && data_root.join("Data").exists() {
        return Err(AppError::Validation(
            "المجلد المختار يحتوي على مجلد Data بدون قاعدة بيانات. اختر مجلدًا فارغًا أو مجلد بيانات AutoHR كاملًا.".into(),
        ));
    }
    if existing_database {
        let probe = Connection::open_with_flags(data_root.join(DATABASE_FILE), OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let ok: String = probe.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        if ok != "ok" {
            return Err(AppError::Validation("قاعدة البيانات الموجودة في المجلد المختار تالفة ولا يمكن استخدامها.".into()));
        }
    }
    Ok(SetupCheck { warnings, existing_database })
}

/// Finishes first-run setup: creates or opens the database in the chosen folder, prepares
/// the backup folder, then records both in config.json. Returns the open connection.
pub fn complete_setup(data_root: &Path, backup_root: &Path, require_existing: bool) -> AppResult<Connection> {
    check_setup(data_root, backup_root, require_existing)?;
    paths::ensure_writable(data_root)?;
    let backup_ok = paths::ensure_writable(backup_root).is_ok();
    let chosen = AppPaths { data_root: data_root.to_path_buf(), backup_root: backup_root.to_path_buf() };
    paths::set_current(Some(chosen.clone()));
    let opened = crate::db::open_at(&data_root.join(DATABASE_FILE), !require_existing).map_err(AppError::from);
    let conn = match opened {
        Ok(conn) => conn,
        Err(error) => {
            paths::set_current(None);
            return Err(error);
        }
    };
    if backup_ok {
        ensure_backup_layout(&conn).ok();
    }
    if let Err(error) = paths::write_config(&chosen) {
        paths::set_current(None);
        return Err(error);
    }
    Ok(conn)
}

/// Changes only the backup folder. Old backups stay where they are.
pub fn change_backup_root(conn: &Connection, user: &str, new_root: &Path) -> AppResult<StorageStatus> {
    assert_permission(conn, user, "settings.manage")?;
    let data_root = paths::data_root();
    paths::validate_pair(&data_root, new_root)?;
    paths::ensure_writable(new_root)?;
    let updated = AppPaths { data_root, backup_root: new_root.to_path_buf() };
    paths::write_config(&updated)?;
    paths::set_current(Some(updated));
    ensure_backup_layout(conn)?;
    log_activity(conn, user, "CHANGE_BACKUP_FOLDER", Some("settings"), None, new_root.to_str(), None);
    Ok(storage_status())
}

/// Writes a fresh, verified, self-contained backup file (database and every attachment) into
/// any folder the user picks (USB stick, network share). Works even while the configured backup folder is offline.
pub fn export_backup_to(
    conn: &Connection,
    user: &str,
    password: &str,
    folder: &Path,
    progress: &mut dyn FnMut(BackupProgress),
) -> AppResult<String> {
    assert_permission(conn, user, "backups.manage")?;
    if folder.as_os_str().is_empty() || !folder.is_absolute() {
        return Err(AppError::Validation("اختر مجلدًا صالحًا لحفظ النسخة".into()));
    }
    if paths::is_same_or_inside(folder, &paths::data_root()) {
        return Err(AppError::Validation("لا يمكن تصدير النسخة إلى داخل مجلد البيانات نفسه. اختر قرصًا أو مجلدًا آخر.".into()));
    }
    paths::ensure_writable(folder)?;
    let stamp = chrono::Local::now().format("%Y-%m-%d_%H%M%S");
    let path = folder.join(format!("cnsarch_export_{stamp}.{}", crate::backup_store::BACKUP_EXTENSION));
    if path.exists() {
        return Err(AppError::Validation("يوجد ملف بنفس الاسم في المجلد المختار. أعد المحاولة بعد ثانية.".into()));
    }
    crate::backup_store::write_full_export(conn, password, &path, progress)?;
    log_activity(conn, user, "EXPORT_BACKUP", Some("backup"), None, path.to_str(), None);
    progress(backup_progress(100, "تم تصدير النسخة الاحتياطية والتحقق منها"));
    Ok(path.to_string_lossy().into_owned())
}

/// Lists every regular file under `root` (relative paths), skipping the Temp folder.
fn list_files(root: &Path) -> AppResult<Vec<PathBuf>> {
    let mut files = Vec::new();
    let mut pending = vec![PathBuf::new()];
    while let Some(relative) = pending.pop() {
        let dir = root.join(&relative);
        if !dir.exists() {
            continue;
        }
        for entry in std::fs::read_dir(&dir).map_err(io_err)? {
            let entry = entry.map_err(io_err)?;
            let child = relative.join(entry.file_name());
            if relative.as_os_str().is_empty() && entry.file_name() == "Temp" {
                continue;
            }
            let kind = entry.file_type().map_err(io_err)?;
            if kind.is_dir() {
                pending.push(child);
            } else if kind.is_file() {
                files.push(child);
            }
        }
    }
    files.sort();
    Ok(files)
}

/// Copies the database and the Data tree to `new_root`, then proves the copy is identical.
fn copy_and_verify(conn: &Connection, old_root: &Path, new_root: &Path, progress: &mut dyn FnMut(BackupProgress)) -> AppResult<()> {
    let new_db = new_root.join(DATABASE_FILE);
    progress(backup_progress(40, "جاري نسخ قاعدة البيانات إلى الموقع الجديد..."));
    conn.backup(rusqlite::MAIN_DB, &new_db, None::<fn(rusqlite::backup::Progress)>)?;

    let old_data = old_root.join("Data");
    let new_data = new_root.join("Data");
    let files = list_files(&old_data)?;
    let total = files.len().max(1);
    for (index, relative) in files.iter().enumerate() {
        let target = new_data.join(relative);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(io_err)?;
        }
        std::fs::copy(old_data.join(relative), &target).map_err(io_err)?;
        if index % 25 == 0 {
            let percent = (45 + index * 35 / total) as u8;
            progress(backup_progress(percent, "جاري نسخ المرفقات..."));
        }
    }
    std::fs::create_dir_all(new_data.join("Temp")).map_err(io_err)?;

    progress(backup_progress(82, "جاري التحقق من تطابق الملفات..."));
    for relative in &files {
        let (old_size, old_hash) = sha256_file(&old_data.join(relative))?;
        let (new_size, new_hash) = sha256_file(&new_data.join(relative))?;
        if old_size != new_size || old_hash != new_hash {
            return Err(AppError::Other(format!("الملف المنسوخ لا يطابق الأصل: {}", relative.display())));
        }
    }
    progress(backup_progress(92, "جاري التحقق من سلامة قاعدة البيانات المنسوخة..."));
    let copy = Connection::open_with_flags(&new_db, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let integrity: String = copy.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    if integrity != "ok" {
        return Err(AppError::Other("فشل فحص سلامة قاعدة البيانات المنسوخة".into()));
    }
    let count = |c: &Connection, table: &str| -> AppResult<i64> {
        Ok(c.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0))?)
    };
    for table in ["employees", "users", "general_docs"] {
        if count(conn, table)? != count(&copy, table)? {
            return Err(AppError::Other(format!("عدد السجلات في الجدول {table} لا يطابق الأصل")));
        }
    }
    if crate::db::schema_version(conn)? != crate::db::schema_version(&copy)? {
        return Err(AppError::Other("إصدار قاعدة البيانات المنسوخة لا يطابق الأصل".into()));
    }
    Ok(())
}

/// Moves the data folder (database + attachments) to `new_root`.
///
/// 1. the new folder must be empty or new, separate from the backup folder;
/// 2. an encrypted, verified safety backup is written to `Backups/PreMove`;
/// 3. database and files are copied and verified (size, SHA-256, integrity, row counts);
/// 4. only then config.json switches to the new folder.
///
/// The old folder is left untouched. On any failure, only what this function created in
/// the new folder is removed and the configuration does not change.
pub fn relocate_data(
    conn: &Connection,
    user: &str,
    password: &str,
    new_root: &Path,
    progress: &mut dyn FnMut(BackupProgress),
) -> AppResult<(AppPaths, String)> {
    assert_permission(conn, user, "settings.manage")?;
    assert_permission(conn, user, "backups.manage")?;
    let old_root = paths::data_root();
    let backup_root = paths::backup_root();
    paths::validate_pair(new_root, &backup_root)?;
    if paths::is_same_or_inside(new_root, &old_root) || paths::is_same_or_inside(&old_root, new_root) {
        return Err(AppError::Validation("اختر مجلدًا جديدًا منفصلًا عن مجلد البيانات الحالي".into()));
    }
    let existed = new_root.exists();
    if existed {
        let empty = std::fs::read_dir(new_root).map_err(io_err)?.next().is_none();
        if !empty || paths::has_existing_data(new_root) {
            return Err(AppError::Validation("يجب أن يكون المجلد الجديد فارغًا حتى لا تُخلط البيانات أو يُكتب فوق ملفات موجودة".into()));
        }
    }
    paths::ensure_writable(new_root)?;

    progress(backup_progress(2, "جاري إنشاء نسخة احتياطية للأمان قبل النقل..."));
    let mut nested = |p: BackupProgress| progress(backup_progress(2 + (u16::from(p.percent) * 35 / 100) as u8, &p.message));
    let safety = create_backup_at(conn, user, password, "PreMove", &mut nested).map_err(|error| {
        AppError::Validation(format!("تعذر إنشاء نسخة الأمان قبل النقل، لذلك لم يتم النقل: {error}"))
    })?;

    if let Err(error) = copy_and_verify(conn, &old_root, new_root, progress) {
        // Only remove what this function created; the folder was empty or new.
        std::fs::remove_file(new_root.join(DATABASE_FILE)).ok();
        std::fs::remove_file(new_root.join(format!("{DATABASE_FILE}-wal"))).ok();
        std::fs::remove_file(new_root.join(format!("{DATABASE_FILE}-shm"))).ok();
        std::fs::remove_dir_all(new_root.join("Data")).ok();
        if !existed {
            std::fs::remove_dir(new_root).ok();
        }
        return Err(AppError::Validation(format!("فشل نقل البيانات، ولم يتغير شيء وبقي البرنامج على المجلد الحالي: {error}")));
    }

    let updated = AppPaths { data_root: new_root.to_path_buf(), backup_root };
    paths::write_config(&updated)?;
    // The caller writes the audit entry into the NEW database once it is open.
    progress(backup_progress(100, "تم نقل البيانات والتحقق منها. بقيت نسخة غير مشفرة في الموقع القديم: احذفها بنفسك بعد التأكد من أن كل شيء يعمل."));
    Ok((updated, safety))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::TEST_APP_DATA_ROOT;

    struct Env {
        _dir: tempfile::TempDir,
        root: PathBuf,
    }

    fn env() -> Env {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        TEST_APP_DATA_ROOT.with(|v| *v.borrow_mut() = Some(root.join("appdata")));
        paths::set_current(None);
        Env { _dir: dir, root }
    }

    fn admin(conn: &Connection) -> String {
        conn.execute("UPDATE users SET must_change_password=0 WHERE username='sysadmin'", []).unwrap();
        "sysadmin".into()
    }

    #[test]
    fn setup_creates_database_and_config_then_startup_is_ready() {
        let env = env();
        let data = env.root.join("AutoHR-Data");
        let backups = env.root.join("AutoHR-Backups");
        assert_eq!(paths::resolve_startup().unwrap(), paths::StartupState::NeedsSetup);
        let conn = complete_setup(&data, &backups, false).unwrap();
        assert!(data.join(DATABASE_FILE).is_file());
        assert!(backups.join("Daily").is_dir());
        assert_eq!(crate::db::schema_version(&conn).unwrap(), crate::db::SCHEMA_VERSION);
        drop(conn);
        paths::set_current(None);
        assert_eq!(
            paths::resolve_startup().unwrap(),
            paths::StartupState::Ready(AppPaths { data_root: data, backup_root: backups })
        );
    }

    #[test]
    fn missing_data_folder_never_creates_an_empty_database() {
        let env = env();
        let data = env.root.join("AutoHR-Data");
        let backups = env.root.join("AutoHR-Backups");
        drop(complete_setup(&data, &backups, false).unwrap());
        std::fs::rename(&data, env.root.join("unplugged")).unwrap();
        paths::set_current(None);
        assert!(matches!(paths::resolve_startup().unwrap(), paths::StartupState::DataMissing(_)));
        assert!(complete_setup(&data, &backups, true).is_err());
        assert!(!data.join(DATABASE_FILE).exists());
        assert!(crate::db::open_at(&data.join(DATABASE_FILE), false).is_err());
        assert!(!data.join(DATABASE_FILE).exists());
        // Pointing at the real folder again works.
        let found = env.root.join("unplugged");
        assert!(complete_setup(&found, &backups, true).is_ok());
    }

    #[test]
    fn legacy_install_keeps_working_from_its_old_folder() {
        let env = env();
        let legacy = paths::legacy_paths();
        std::fs::create_dir_all(&legacy.data_root).unwrap();
        drop(crate::db::open_at(&legacy.data_root.join(DATABASE_FILE), true).unwrap());
        let _ = env;
        assert_eq!(paths::resolve_startup().unwrap(), paths::StartupState::Ready(legacy.clone()));
        assert!(paths::config_path().is_file());
        paths::set_current(Some(legacy));
        assert!(storage_status().legacy_location);
    }

    #[test]
    fn data_folder_move_copies_verifies_and_keeps_the_old_folder() {
        let env = env();
        let data = env.root.join("old-data");
        let backups = env.root.join("backups");
        let conn = complete_setup(&data, &backups, false).unwrap();
        let user = admin(&conn);
        let file = data.join("Data/Files/Employees/1/card.pdf");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, b"%PDF-1.4 test attachment").unwrap();
        std::fs::create_dir_all(data.join("Data/Temp")).unwrap();
        std::fs::write(data.join("Data/Temp/scratch.tmp"), b"x").unwrap();

        let new_root = env.root.join("new-data");
        let (moved, _) = relocate_data(&conn, &user, "Backup-Pass-2026", &new_root, &mut |_| {}).unwrap();
        assert_eq!(moved.data_root, new_root);
        assert_eq!(std::fs::read(new_root.join("Data/Files/Employees/1/card.pdf")).unwrap(), b"%PDF-1.4 test attachment");
        assert!(!new_root.join("Data/Temp/scratch.tmp").exists());
        assert!(file.is_file(), "old data must stay");
        assert!(data.join(DATABASE_FILE).is_file());
        let safety: Vec<_> = list_files(&backups.join("PreMove")).unwrap();
        // The backup file and its list of attachments (for cleaning the store).
        assert_eq!(safety.iter().filter(|p| p.extension().is_some_and(|e| e == "cnsarchbak")).count(), 1);
        paths::set_current(None);
        assert_eq!(
            paths::resolve_startup().unwrap(),
            paths::StartupState::Ready(AppPaths { data_root: new_root, backup_root: backups })
        );
    }

    #[test]
    fn data_folder_move_refuses_a_non_empty_target_and_changes_nothing() {
        let env = env();
        let data = env.root.join("old-data");
        let backups = env.root.join("backups");
        let conn = complete_setup(&data, &backups, false).unwrap();
        let user = admin(&conn);
        let target = env.root.join("busy");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("someone-else.txt"), b"keep me").unwrap();
        assert!(relocate_data(&conn, &user, "Backup-Pass-2026", &target, &mut |_| {}).is_err());
        assert_eq!(std::fs::read(target.join("someone-else.txt")).unwrap(), b"keep me");
        assert_eq!(paths::data_root(), data);
        // Backup folder inside the target is also rejected.
        assert!(relocate_data(&conn, &user, "Backup-Pass-2026", &backups.join("x"), &mut |_| {}).is_err());
    }

    #[test]
    fn export_writes_a_verified_backup_outside_the_data_folder() {
        let env = env();
        let data = env.root.join("data");
        let backups = env.root.join("backups");
        let conn = complete_setup(&data, &backups, false).unwrap();
        let user = admin(&conn);
        let usb = env.root.join("usb");
        let path = export_backup_to(&conn, &user, "Backup-Pass-2026", &usb, &mut |_| {}).unwrap();
        assert!(Path::new(&path).is_file());
        crate::services::verify_written_backup(Path::new(&path), "Backup-Pass-2026").unwrap();
        assert!(export_backup_to(&conn, &user, "Backup-Pass-2026", &data.join("Data"), &mut |_| {}).is_err());
    }

    #[test]
    fn backup_folder_change_is_validated_and_saved() {
        let env = env();
        let data = env.root.join("data");
        let backups = env.root.join("backups");
        let conn = complete_setup(&data, &backups, false).unwrap();
        let user = admin(&conn);
        assert!(change_backup_root(&conn, &user, &data.join("Backups")).is_err());
        let other = env.root.join("nas-backups");
        let status = change_backup_root(&conn, &user, &other).unwrap();
        assert!(status.backup_reachable);
        assert!(other.join("Weekly").is_dir());
        assert!(backups.is_dir(), "old backups stay");
        paths::set_current(None);
        assert_eq!(
            paths::resolve_startup().unwrap(),
            paths::StartupState::Ready(AppPaths { data_root: data, backup_root: other })
        );
    }

    // ── Backups from 1.0.7: store, daily file, restore of every kind ─────────

    use crate::services::{create_backup_with_progress, restore_backup_with_progress, log_activity, AutoBackupSettingsData};
    use rusqlite::params;

    fn add_employee(conn: &Connection, data: &Path, id: i64, name: &str) {
        let relative = format!("Files/Employees/{id}/Attachments/card.pdf");
        let file = data.join("Data").join(&relative);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, format!("%PDF-1.7 card of {name}")).unwrap();
        conn.execute("INSERT INTO employees(id,full_name,employee_number,attachment_paths) VALUES(?1,?2,?3,?4)",
            params![id, name, format!("E-{id}"), serde_json::to_string(&[&relative]).unwrap()]).unwrap();
        log_activity(conn, "sysadmin", "CREATE_EMPLOYEE", Some("employee"), Some(id), Some(name), None);
    }

    fn names(conn: &Connection) -> Vec<String> {
        let mut stmt = conn.prepare("SELECT full_name FROM employees ORDER BY id").unwrap();
        stmt.query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect()
    }

    fn store_files(backups: &Path) -> usize {
        let mut count = 0;
        let mut pending = vec![backups.join("Store")];
        while let Some(dir) = pending.pop() {
            for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
                if entry.path().is_dir() { pending.push(entry.path()) } else { count += 1 }
            }
        }
        count
    }

    #[test]
    fn small_backup_shares_attachments_and_restores_everything() {
        let env = env();
        let data = env.root.join("data");
        let backups = env.root.join("backups");
        let mut conn = complete_setup(&data, &backups, false).unwrap();
        let user = admin(&conn);
        add_employee(&conn, &data, 1, "قبل النسخة");
        let first = create_backup_with_progress(&conn, &user, "Backup-2026!", |_| {}).unwrap();
        assert_eq!(store_files(&backups), 1);
        // The restore list shows it with its type and employee count, without the password.
        let listed = crate::backup_store::list_backups(&conn);
        assert_eq!(listed.len(), 1);
        assert_eq!((listed[0].kind.as_str(), listed[0].employees, listed[0].old_format), ("manual", Some(1), false));
        assert!(listed[0].path.ends_with(".cnsarchbak") && listed[0].path.contains("cnsarch_manual_"));
        // A second backup does not copy the unchanged attachment again.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        create_backup_with_progress(&conn, &user, "Backup-2026!", |_| {}).unwrap();
        assert_eq!(store_files(&backups), 1);
        // The backup file itself is small: the attachment is in the store, not in the file.
        assert!(std::fs::metadata(&first).unwrap().len() < 200_000);

        add_employee(&conn, &data, 2, "بعد النسخة");
        conn.execute("INSERT INTO users(username,password,role,must_change_password) VALUES('new.clerk','x','viewer',0)", []).unwrap();
        crate::services::set_auto_backup_settings(&conn, &user, &AutoBackupSettingsData {
            enabled: true, password: Some("Auto-Pass-2026".into()), interval_minutes: 30,
            keep_daily: 10, keep_weekly: 4, keep_monthly: 12, auto_delete: true,
        }).unwrap();

        assert!(restore_backup_with_progress(&mut conn, &user, &first, "Wrong-pass-1", |_| {}).is_err());
        let failures: i64 = conn.query_row("SELECT COUNT(*) FROM activity_log WHERE action='RESTORE_BACKUP' AND result='Failure'", [], |r| r.get(0)).unwrap();
        assert_eq!(failures, 1, "a failed restore is logged");

        restore_backup_with_progress(&mut conn, &user, &first, "Backup-2026!", |_| {}).unwrap();
        assert_eq!(names(&conn), vec!["قبل النسخة"]);
        assert!(data.join("Data/Files/Employees/1/Attachments/card.pdf").is_file());
        assert!(!data.join("Data/Files/Employees/2").exists());
        let new_clerk: i64 = conn.query_row("SELECT COUNT(*) FROM users WHERE username='new.clerk'", [], |r| r.get(0)).unwrap();
        assert_eq!(new_clerk, 0);
        // The automatic-backup settings of this computer survive the restore.
        let settings = crate::services::get_auto_backup_settings(&conn, &user).unwrap();
        assert!(settings.enabled && settings.password_works);
        assert_eq!((settings.interval_minutes, settings.keep_daily), (30, 10));
        // The log keeps every entry once, including the safety backup made before the restore.
        let duplicates: i64 = conn.query_row(
            "SELECT COUNT(*) FROM (SELECT 1 FROM activity_log GROUP BY action,username,IFNULL(target_name,''),created_at,IFNULL(details,''),result HAVING COUNT(*)>1)",
            [], |r| r.get(0)).unwrap();
        assert_eq!(duplicates, 0);
        let safety: i64 = conn.query_row("SELECT COUNT(*) FROM activity_log WHERE action='CREATE_BACKUP' AND details='PreRestore'", [], |r| r.get(0)).unwrap();
        assert_eq!(safety, 1);
    }

    #[test]
    fn copied_backup_folder_restores_elsewhere_and_missing_store_is_explained() {
        let env = env();
        let data = env.root.join("data");
        let backups = env.root.join("backups");
        let conn = complete_setup(&data, &backups, false).unwrap();
        let user = admin(&conn);
        add_employee(&conn, &data, 1, "موظف");
        let path = PathBuf::from(create_backup_with_progress(&conn, &user, "Backup-2026!", |_| {}).unwrap());
        // The whole backup folder copied to a USB stick: the store is found next to the file.
        let usb = env.root.join("usb");
        let copy = |from: &Path, to: &Path| {
            let mut pending = vec![PathBuf::new()];
            while let Some(relative) = pending.pop() {
                std::fs::create_dir_all(to.join(&relative)).unwrap();
                for entry in std::fs::read_dir(from.join(&relative)).unwrap().flatten() {
                    let child = relative.join(entry.file_name());
                    if entry.path().is_dir() { pending.push(child) } else { std::fs::copy(entry.path(), to.join(&child)).unwrap(); }
                }
            }
        };
        copy(&backups, &usb);
        std::fs::rename(&backups, env.root.join("backups-away")).unwrap();
        let on_usb = usb.join(path.strip_prefix(&backups).unwrap());
        let staging = tempfile::tempdir().unwrap();
        crate::services::stage_backup(&on_usb, "Backup-2026!", staging.path()).unwrap();
        assert!(staging.path().join("Data/Files/Employees/1/Attachments/card.pdf").is_file());
        // The file alone, without its store, is refused with an explanation.
        let alone = env.root.join("alone.autohrbak");
        std::fs::copy(&on_usb, &alone).unwrap();
        let error = crate::services::stage_backup(&alone, "Backup-2026!", tempfile::tempdir().unwrap().path()).unwrap_err();
        assert!(serde_json::to_string(&error).unwrap().contains("Store"));
    }

    #[test]
    fn full_export_and_old_full_backup_both_restore() {
        let env = env();
        let data = env.root.join("data");
        let backups = env.root.join("backups");
        let mut conn = complete_setup(&data, &backups, false).unwrap();
        let user = admin(&conn);
        add_employee(&conn, &data, 1, "في التصدير");
        let export = export_backup_to(&conn, &user, "Backup-2026!", &env.root.join("usb"), &mut |_| {}).unwrap();
        let old = env.root.join("old-1.0.6.autohrbak");
        crate::services::create_backup_archive(&conn, "Backup-2026!", &old, &mut |_| {}).unwrap();
        add_employee(&conn, &data, 2, "بعد التصدير");
        restore_backup_with_progress(&mut conn, &user, &export, "Backup-2026!", |_| {}).unwrap();
        assert_eq!(names(&conn), vec!["في التصدير"]);
        add_employee(&conn, &data, 3, "بعد الاستعادة");
        restore_backup_with_progress(&mut conn, &user, old.to_str().unwrap(), "Backup-2026!", |_| {}).unwrap();
        assert_eq!(names(&conn), vec!["في التصدير"]);
        assert!(data.join("Data/Files/Employees/1/Attachments/card.pdf").is_file());
    }

    #[test]
    fn restore_that_cannot_swap_folders_changes_nothing_and_loses_nothing_later() {
        let env = env();
        let data = env.root.join("data");
        let backups = env.root.join("backups");
        let mut conn = complete_setup(&data, &backups, false).unwrap();
        let user = admin(&conn);
        add_employee(&conn, &data, 1, "قديم");
        let backup = create_backup_with_progress(&conn, &user, "Backup-2026!", |_| {}).unwrap();
        // Something in the way of renaming the data folder (on Windows: a file open elsewhere).
        std::fs::write(data.join("Data.restore.rollback"), b"blocker").unwrap();
        let error = restore_backup_with_progress(&mut conn, &user, &backup, "Backup-2026!", |_| {}).unwrap_err();
        assert!(serde_json::to_string(&error).unwrap().contains("لم يتغير شيء"));
        assert!(!data.join("restore.in_progress").exists());
        add_employee(&conn, &data, 2, "أضيف بعد الفشل");
        drop(conn);
        std::fs::remove_file(data.join("Data.restore.rollback")).ok();
        let conn = crate::db::open_at(&data.join(DATABASE_FILE), false).unwrap();
        assert_eq!(names(&conn), vec!["قديم", "أضيف بعد الفشل"]);
    }

    #[test]
    fn automatic_backups_are_one_per_day_and_old_days_are_thinned() {
        let env = env();
        let data = env.root.join("data");
        let backups = env.root.join("backups");
        let conn = complete_setup(&data, &backups, false).unwrap();
        let user = admin(&conn);
        crate::services::set_auto_backup_settings(&conn, &user, &AutoBackupSettingsData {
            enabled: true, password: Some("Auto-Pass-2026".into()), interval_minutes: 60,
            keep_daily: 7, keep_weekly: 4, keep_monthly: 12, auto_delete: true,
        }).unwrap();
        // Forty days of files from 1.0.6 (three a day: daily, weekly, monthly).
        let today = chrono::Local::now().date_naive();
        for day in 1..=40u64 {
            let date = today - chrono::Days::new(day);
            for kind in ["daily", "weekly", "monthly"] {
                let folder = backups.join(format!("{}{}", kind[..1].to_uppercase(), &kind[1..])).join(date.format("%Y").to_string());
                std::fs::create_dir_all(&folder).unwrap();
                std::fs::write(folder.join(format!("cnsarch_{kind}_{}_090000.autohrbak", date.format("%Y-%m-%d"))), b"old").unwrap();
            }
        }
        // A manual backup is never thinned.
        std::fs::create_dir_all(backups.join("Manual/2025")).unwrap();
        std::fs::write(backups.join("Manual/2025/autohr_manual_2025-01-01_100000.autohrbak"), b"manual").unwrap();
        for round in 0..3 {
            add_employee(&conn, &data, 10 + round, &format!("موظف {round}"));
            assert_eq!(crate::services::run_due_automatic_backups_with_progress(&conn, false, |_| {}).unwrap(), vec!["يومي"]);
        }
        let left = crate::backup_store::automatic_backups(&backups);
        // Today + 6 earlier days, 4 weeks, and the months that remain of the forty days.
        assert!(left.len() <= 7 + 4 + 2, "{} left", left.len());
        assert_eq!(left.iter().filter(|b| b.date == today).count(), 1);
        assert!(backups.join("Manual/2025/autohr_manual_2025-01-01_100000.autohrbak").is_file());
        let removed: i64 = conn.query_row("SELECT COUNT(*) FROM activity_log WHERE action='DELETE_OLD_BACKUPS'", [], |r| r.get(0)).unwrap();
        assert!(removed >= 1);
    }
}
