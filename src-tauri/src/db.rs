// src-tauri/src/db.rs
use rusqlite::{params, Connection, Result as SqlResult};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::fs;

fn recover_interrupted_restore(base: &Path, database: &Path) {
    let marker = base.join("restore.in_progress");
    if !marker.exists() { return; }
    let rollback_database = base.join("database.restore.rollback.db");
    let rollback_data = base.join("Data.restore.rollback");
    let current_data = base.join("Data");
    if rollback_database.is_file() {
        fs::remove_file(database.with_extension("db-wal")).ok();
        fs::remove_file(database.with_extension("db-shm")).ok();
        fs::copy(&rollback_database, database).ok();
    }
    if rollback_data.is_dir() {
        fs::remove_dir_all(&current_data).ok();
        fs::rename(&rollback_data, &current_data).ok();
    }
    fs::remove_file(rollback_database).ok();
    fs::remove_file(marker).ok();
}

fn json_array(value: &str) -> Vec<Value> {
    serde_json::from_str::<Vec<Value>>(value).unwrap_or_default()
}

fn json_text(value: &Value, key: &str) -> Option<String> {
    value.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn migrate_employee_repeating_data(conn: &Connection) -> SqlResult<()> {
    let (spouse_count, family_count, vehicle_count, attachment_count): (i64, i64, i64, i64) = conn.query_row(
        "SELECT
            (SELECT COUNT(*) FROM employee_spouses),
            (SELECT COUNT(*) FROM employee_family_members),
            (SELECT COUNT(*) FROM employee_vehicles),
            (SELECT COUNT(*) FROM employee_attachments)",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    let migrate_spouses = spouse_count == 0;
    let migrate_family = family_count == 0;
    let migrate_vehicles = vehicle_count == 0;
    let migrate_attachments = attachment_count == 0;
    if !(migrate_spouses || migrate_family || migrate_vehicles || migrate_attachments) {
        return Ok(());
    }

    let mut stmt = conn.prepare(
        "SELECT id, COALESCE(spouses,'[]'), spouse_name, spouse_mother_name, spouse_birthdate, marriage_date,
                COALESCE(family_members,'[]'), COALESCE(vehicles,'[]'), COALESCE(attachment_paths,'[]'),
                COALESCE(passport_attachment_paths,'[]'), COALESCE(ration_card_attachment_paths,'[]')
         FROM employees"
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, String>(6)?,
            row.get::<_, String>(7)?,
            row.get::<_, String>(8)?,
            row.get::<_, String>(9)?,
            row.get::<_, String>(10)?,
        ))
    })?.collect::<SqlResult<Vec<_>>>()?;

    for (employee_id, spouses_json, spouse_name, spouse_mother_name, spouse_birthdate, marriage_date, family_json, vehicles_json, attachments_json, passport_json, ration_json) in rows {
        if migrate_spouses {
            let mut spouses = json_array(&spouses_json);
            let has_legacy_spouse = spouse_name.as_deref().is_some_and(|value| !value.trim().is_empty())
                || spouse_mother_name.as_deref().is_some_and(|value| !value.trim().is_empty())
                || spouse_birthdate.as_deref().is_some_and(|value| !value.trim().is_empty())
                || marriage_date.as_deref().is_some_and(|value| !value.trim().is_empty());
            if spouses.is_empty() && has_legacy_spouse {
                spouses.push(serde_json::json!({
                    "name": spouse_name.unwrap_or_default(),
                    "mother_name": spouse_mother_name.unwrap_or_default(),
                    "birthdate": spouse_birthdate.unwrap_or_default(),
                    "marriage_date": marriage_date.unwrap_or_default()
                }));
            }
            for (index, spouse) in spouses.iter().enumerate() {
                conn.execute(
                    "INSERT INTO employee_spouses(employee_id,sort_order,civil_id,name,mother_name,gender,birthplace,birthdate,issue_date,expiry_date,issuer,blood_type,marriage_date,national_card_front_path,national_card_back_path)
                     VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
                    params![
                        employee_id, index as i64,
                        json_text(spouse, "civil_id"), json_text(spouse, "name"), json_text(spouse, "mother_name"),
                        json_text(spouse, "gender"), json_text(spouse, "birthplace"), json_text(spouse, "birthdate"),
                        json_text(spouse, "issue_date"), json_text(spouse, "expiry_date"), json_text(spouse, "issuer"),
                        json_text(spouse, "blood_type"), json_text(spouse, "marriage_date"),
                        json_text(spouse, "national_card_front_path"), json_text(spouse, "national_card_back_path"),
                    ],
                )?;
            }
        }

        if migrate_family {
            for (index, member) in json_array(&family_json).iter().enumerate() {
                conn.execute(
                    "INSERT INTO employee_family_members(employee_id,sort_order,civil_id,name,gender,birthplace,birthdate,issue_date,expiry_date,issuer,blood_type,national_card_front_path,national_card_back_path)
                     VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
                    params![
                        employee_id, index as i64,
                        json_text(member, "civil_id"), json_text(member, "name"), json_text(member, "gender"),
                        json_text(member, "birthplace"), json_text(member, "birthdate"), json_text(member, "issue_date"),
                        json_text(member, "expiry_date"), json_text(member, "issuer"), json_text(member, "blood_type"),
                        json_text(member, "national_card_front_path"), json_text(member, "national_card_back_path"),
                    ],
                )?;
            }
        }

        if migrate_vehicles {
            for (index, vehicle) in json_array(&vehicles_json).iter().enumerate() {
                conn.execute(
                    "INSERT INTO employee_vehicles(employee_id,sort_order,plate,brand,type,color,annual_no,issue_date,expiry_date)
                     VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                    params![
                        employee_id, index as i64,
                        json_text(vehicle, "plate"), json_text(vehicle, "brand"), json_text(vehicle, "type"),
                        json_text(vehicle, "color"), json_text(vehicle, "annual_no"),
                        json_text(vehicle, "issue_date"), json_text(vehicle, "expiry_date"),
                    ],
                )?;
            }
        }

        if migrate_attachments {
            for (kind, value) in [
                ("general", attachments_json.as_str()),
                ("passport", passport_json.as_str()),
                ("ration_card", ration_json.as_str()),
            ] {
                for (index, path) in json_array(value).iter().filter_map(Value::as_str).enumerate() {
                    conn.execute(
                        "INSERT OR IGNORE INTO employee_attachments(employee_id,kind,file_path,sort_order) VALUES(?1,?2,?3,?4)",
                        params![employee_id, kind, path, index as i64],
                    )?;
                }
            }
        }
    }
    Ok(())
}

/// The database lives in the configured data folder (see `paths.rs`). Development and
/// release use separate application folders, so they never share a configuration.
pub fn db_path() -> PathBuf {
    let base = crate::paths::data_root();
    fs::create_dir_all(&base).ok();
    base.join(crate::paths::DATABASE_FILE)
}

/// Schema version stored in `PRAGMA user_version` after a successful upgrade.
///
/// * 0 — any database created before versioning existed (v1.0.0 to v1.0.3).
/// * 1 — the schema produced by `migrate()` (Phase B, before the name split).
/// * 2 — person names split into parts (`name_parts`, `name_split_originals`; see `names.rs`).
/// * 3 — airport badge access zones; car registration (السنوية) images per vehicle.
///
/// To change the schema later: bump this constant and add an `if from < N { ... }` step in
/// `upgrade()`. Every upgrade of an existing database runs only after a verified
/// pre-upgrade snapshot exists, and the snapshot is restored automatically if a step fails.
pub const SCHEMA_VERSION: i64 = 3;

#[derive(Debug)]
pub enum OpenError {
    Sql(rusqlite::Error),
    /// The database file does not exist and creating a new one is not allowed.
    Missing(PathBuf),
    /// The database was written by a newer version of the application.
    NewerSchema { found: i64, supported: i64 },
    /// The pre-upgrade snapshot could not be written or verified, so nothing was changed.
    Snapshot(String),
    /// The upgrade failed. `restored` tells whether the snapshot was put back.
    UpgradeFailed { from: i64, error: String, snapshot: PathBuf, restored: bool },
}

impl From<rusqlite::Error> for OpenError {
    fn from(error: rusqlite::Error) -> Self { OpenError::Sql(error) }
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpenError::Sql(error) => write!(f, "تعذر فتح قاعدة البيانات: {error}"),
            OpenError::Missing(path) => write!(f, "لم يتم العثور على قاعدة البيانات في {}", path.display()),
            OpenError::NewerSchema { found, supported } => write!(
                f,
                "قاعدة البيانات أُنشئت بإصدار أحدث من البرنامج (إصدار المخطط {found}، والمدعوم {supported}). ثبّت الإصدار الأحدث ولا تستخدم هذا الإصدار معها."
            ),
            OpenError::Snapshot(error) => write!(
                f,
                "تعذر إنشاء نسخة الأمان قبل ترقية قاعدة البيانات، لذلك لم تُعدَّل البيانات: {error}"
            ),
            OpenError::UpgradeFailed { from, error, snapshot, restored } => write!(
                f,
                "فشلت ترقية قاعدة البيانات من الإصدار {from}: {error}. {} نسخة الأمان: {}",
                if *restored { "أُعيدت قاعدة البيانات إلى حالتها السابقة." } else { "تعذرت الإعادة التلقائية، استخدم نسخة الأمان يدويًا." },
                snapshot.display()
            ),
        }
    }
}

pub fn schema_version(conn: &Connection) -> SqlResult<i64> {
    conn.query_row("PRAGMA user_version", [], |r| r.get(0))
}

fn integrity_ok(conn: &Connection) -> SqlResult<bool> {
    let result: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
    Ok(result == "ok")
}

/// Copies the database with SQLite's backup API to `PreUpgrade`, preferring the backup
/// folder and falling back to the data folder, then checks the copy's integrity.
pub fn pre_upgrade_snapshot(conn: &Connection, from: i64) -> Result<PathBuf, String> {
    let stamp = chrono::Local::now().format("%Y-%m-%d_%H%M%S");
    let mut errors = Vec::new();
    for dir in [crate::paths::backup_root().join("PreUpgrade"), crate::paths::data_root().join("PreUpgrade")] {
        let attempt = (|| -> Result<PathBuf, String> {
            fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let destination = dir.join(format!("database_v{from}_to_v{SCHEMA_VERSION}_{stamp}.db"));
            if destination.exists() {
                return Err(format!("{} already exists", destination.display()));
            }
            conn.backup(rusqlite::MAIN_DB, &destination, None::<fn(rusqlite::backup::Progress)>).map_err(|e| e.to_string())?;
            // Keep the snapshot a single self-contained file (no -wal / -shm beside it).
            Connection::open(&destination)
                .and_then(|copy| copy.pragma_update(None, "journal_mode", "DELETE"))
                .map_err(|e| e.to_string())?;
            let copy = Connection::open_with_flags(&destination, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|e| e.to_string())?;
            if !integrity_ok(&copy).map_err(|e| e.to_string())? {
                return Err("integrity_check failed on the snapshot".into());
            }
            Ok(destination)
        })();
        match attempt {
            Ok(path) => return Ok(path),
            Err(error) => errors.push(format!("{}: {error}", dir.display())),
        }
    }
    Err(errors.join("; "))
}

#[cfg(test)]
thread_local! { static FAIL_UPGRADE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) }; }

/// Brings a database from `from` up to `SCHEMA_VERSION`.
fn upgrade(conn: &Connection, from: i64) -> SqlResult<()> {
    if from < 1 {
        conn.execute_batch(include_str!("../../database/schema.sql"))?;
        migrate(conn)?;
    }
    if from < 2 {
        crate::names::upgrade_to_v2(conn)?;
    }
    if from < 3 {
        upgrade_to_v3(conn)?;
    }
    // Future steps go here, for example: if from < 4 { ... }
    #[cfg(test)]
    if FAIL_UPGRADE.with(|flag| flag.get()) {
        return Err(rusqlite::Error::InvalidQuery);
    }
    if !integrity_ok(conn)? {
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CORRUPT),
            Some("integrity_check failed after upgrade".into()),
        ));
    }
    conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
    Ok(())
}

fn add_column_if_missing(conn: &Connection, table: &str, column: &str, definition: &str) -> SqlResult<()> {
    let exists = conn
        .prepare(&format!("PRAGMA table_info({table})"))?
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<SqlResult<Vec<_>>>()?
        .iter()
        .any(|c| c == column);
    if !exists {
        conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"), [])?;
    }
    Ok(())
}

/// v3: columns added after v2 shipped. `migrate()` only runs for version 0, so columns for
/// databases that are already versioned must be added here.
fn upgrade_to_v3(conn: &Connection) -> SqlResult<()> {
    add_column_if_missing(conn, "employees", "airport_badge_zones", "TEXT")?;
    add_column_if_missing(conn, "employee_vehicles", "annual_front_path", "TEXT")?;
    add_column_if_missing(conn, "employee_vehicles", "annual_back_path", "TEXT")?;
    Ok(())
}

/// Upgrades a database that was just restored from a backup, if it is older. The restore
/// itself keeps a rollback copy, so no extra snapshot is taken here.
pub fn upgrade_restored(conn: &Connection) -> Result<(), OpenError> {
    let version = schema_version(conn)?;
    if version > SCHEMA_VERSION {
        return Err(OpenError::NewerSchema { found: version, supported: SCHEMA_VERSION });
    }
    if version < SCHEMA_VERSION {
        upgrade(conn, version)?;
    }
    Ok(())
}

/// Builds the current schema on an empty connection (tests only).
#[cfg(test)]
pub(crate) fn migrate_for_tests(conn: &Connection) { upgrade(conn, 0).unwrap(); }

fn migrate(conn: &Connection) -> SqlResult<()> {
    conn.execute("DELETE FROM app_settings WHERE key='biometric_username'", []).ok();
    let user_columns: Vec<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(users)")?;
        let columns = stmt.query_map([], |r| r.get::<_, String>(1))?.collect::<SqlResult<_>>()?;
        columns
    };
    if !user_columns.iter().any(|column| column == "must_change_password") {
        conn.execute(
            "ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0 CHECK(must_change_password IN (0,1))",
            [],
        )?;
        // Existing sysadmin credentials may still be the publicly documented default.
        conn.execute(
            "UPDATE users SET must_change_password=1 WHERE username='sysadmin'",
            [],
        )?;
    }
    let legacy_roles: i64 = conn.query_row(
        "SELECT COUNT(*) FROM users WHERE role IN ('master','operator','hr_admin','hr_officer')", [], |r| r.get(0)
    )?;
    let users_sql: String = conn.query_row(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='users'", [], |r| r.get(0)
    )?;
    if legacy_roles > 0 || users_sql.contains("hr_admin") || users_sql.contains("'master'") {
        conn.execute_batch("
            PRAGMA foreign_keys=OFF;
            BEGIN;
            ALTER TABLE users RENAME TO users_legacy_roles;
            CREATE TABLE users (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              username TEXT NOT NULL UNIQUE,
              password TEXT NOT NULL,
              role TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('system_admin','archive_admin','archive_officer','viewer')),
              must_change_password INTEGER NOT NULL DEFAULT 0 CHECK(must_change_password IN (0,1)),
              created_at TEXT DEFAULT (datetime('now'))
            );
            INSERT INTO users(id,username,password,role,must_change_password,created_at)
              SELECT id,username,password,
                CASE
                  WHEN username='sysadmin' OR role='master' OR role='system_admin' THEN 'system_admin'
                  WHEN role='hr_admin' OR role='archive_admin' THEN 'archive_admin'
                  ELSE 'archive_officer'
                END,
                must_change_password,created_at
              FROM users_legacy_roles;
            DROP TABLE users_legacy_roles;
            COMMIT;
            PRAGMA foreign_keys=ON;
        ")?;
    }

    // Add any employee columns missing from older schema versions
    let existing: Vec<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(employees)")?;
        let cols = stmt.query_map([], |r| r.get::<_, String>(1))?.collect::<SqlResult<_>>()?;
        cols
    };
    let need: &[(&str, &str)] = &[
        ("photo_path",           "TEXT"),
        ("mother_name",          "TEXT"),
        ("father_birthplace",    "TEXT"),
        ("father_birthdate",     "TEXT"),
        ("mother_birthplace",    "TEXT"),
        ("mother_birthdate",     "TEXT"),
        ("gender",               "TEXT"),
        ("birthdate",            "TEXT"),
        ("birthplace",           "TEXT"),
        ("marital_status",       "TEXT"),
        ("blood_type",           "TEXT"),
        ("workplace",            "TEXT"),
        ("job_grade",            "TEXT"),
        ("hire_date",            "TEXT"),
        ("appointment_date",     "TEXT"),
        ("contract_type",        "TEXT DEFAULT 'ملاك'"),
        ("work_type_notes",      "TEXT"),
        ("work_schedule",        "TEXT"),
        ("education_level",      "TEXT"),
        ("specialization",       "TEXT"),
        ("graduation_year",      "TEXT"),
        ("civil_id",             "TEXT"),
        ("civil_id_issuer",      "TEXT"),
        ("civil_id_issue_date",  "TEXT"),
        ("civil_id_expiry_date", "TEXT"),
        ("civil_id_birthplace",  "TEXT"),
        ("civil_id_birthdate",   "TEXT"),
        ("civil_id_family_number", "TEXT"),
        ("civil_id_front_path",  "TEXT"),
        ("civil_id_back_path",   "TEXT"),
        ("residence_card_no",        "TEXT"),
        ("residence_card_issuer",    "TEXT"),
        ("residence_card_issue_date", "TEXT"),
        ("residence_head_name",      "TEXT"),
        ("residence_form_no",        "TEXT"),
        ("residence_card_front_path", "TEXT"),
        ("residence_card_back_path",  "TEXT"),
        ("residence_address",        "TEXT"),
        ("ration_card_no",           "TEXT"),
        ("ration_center_name",       "TEXT"),
        ("ration_center_no",         "TEXT"),
        ("ration_card_date",         "TEXT"),
        ("ration_card_attachment_paths", "TEXT DEFAULT '[]'"),
        ("passport_no",              "TEXT"),
        ("passport_type",            "TEXT"),
        ("passport_name",            "TEXT"),
        ("passport_issue_date",      "TEXT"),
        ("passport_expiry_date",     "TEXT"),
        ("passport_attachment_paths", "TEXT DEFAULT '[]'"),
        ("airport_badge_no",         "TEXT"),
        ("airport_badge_issue_date", "TEXT"),
        ("airport_badge_expiry",     "TEXT"),
        ("airport_badge_zones",      "TEXT"),
        ("airport_badge_front_path", "TEXT"),
        ("airport_badge_back_path",  "TEXT"),
        ("ministry_badge_no",        "TEXT"),
        ("ministry_badge_issue_date", "TEXT"),
        ("ministry_badge_expiry",    "TEXT"),
        ("ministry_badge_front_path", "TEXT"),
        ("ministry_badge_back_path",  "TEXT"),
        ("vehicle_plate",            "TEXT"),
        ("vehicle_name",             "TEXT"),
        ("vehicle_color_model",      "TEXT"),
        ("vehicle_type",             "TEXT"),
        ("vehicle_color",            "TEXT"),
        ("vehicle_manufacture_year", "TEXT"),
        ("vehicle_annual_no",        "TEXT"),
        ("vehicle_annual_issue_date", "TEXT"),
        ("vehicle_annual_expiry_date", "TEXT"),
        ("vehicles",                  "TEXT DEFAULT '[]'"),
        ("spouse_name",              "TEXT"),
        ("spouse_mother_name",       "TEXT"),
        ("spouse_birthdate",         "TEXT"),
        ("marriage_date",            "TEXT"),
        ("spouses",                  "TEXT DEFAULT '[]'"),
        ("family_members",           "TEXT DEFAULT '[]'"),
        ("attachment_paths",         "TEXT DEFAULT '[]'"),
    ];
    for (col, def) in need {
        if !existing.iter().any(|c| c == col) {
            conn.execute(&format!("ALTER TABLE employees ADD COLUMN {} {}", col, def), [])?;
        }
    }
    for obsolete in [
        "nationality_cert_no",
        "nationality_cert_date",
        "nationality_wallet_no",
        "civil_id_register",
        "civil_id_page",
    ] {
        if existing.iter().any(|existing_col| existing_col == obsolete) {
            conn.execute(&format!("ALTER TABLE employees DROP COLUMN {}", obsolete), [])?;
        }
    }
    conn.execute_batch("
        UPDATE employees SET contract_type='ملاك' WHERE contract_type='permanent';
        UPDATE employees SET contract_type='عقد' WHERE contract_type='contract';
        UPDATE employees SET contract_type='اجر يومي' WHERE contract_type='temporary';
        UPDATE employees SET
            civil_id_birthplace=COALESCE(NULLIF(civil_id_birthplace,''),birthplace),
            civil_id_birthdate=COALESCE(NULLIF(civil_id_birthdate,''),birthdate);
        UPDATE employees SET
            vehicle_color=COALESCE(NULLIF(vehicle_color,''), TRIM(CASE
                WHEN INSTR(vehicle_color_model,' - ') > 0
                THEN SUBSTR(vehicle_color_model,1,INSTR(vehicle_color_model,' - ')-1)
                ELSE vehicle_color_model
            END)),
            vehicle_manufacture_year=COALESCE(NULLIF(vehicle_manufacture_year,''), TRIM(CASE
                WHEN INSTR(vehicle_color_model,' - ') > 0
                THEN SUBSTR(vehicle_color_model,INSTR(vehicle_color_model,' - ')+3)
                ELSE NULL
            END));
    ")?;

    // Create tables introduced in v2 schema if they don't exist yet
    conn.execute_batch("
        ALTER TABLE company_config ADD COLUMN logo_path TEXT;
    ").ok();

    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS grade_history (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
            grade       TEXT NOT NULL,
            job_title   TEXT,
            effective_date TEXT NOT NULL,
            notes       TEXT,
            created_at  TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS employee_spouses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
          sort_order INTEGER NOT NULL DEFAULT 0,
          civil_id TEXT,
          name TEXT,
          mother_name TEXT,
          gender TEXT,
          birthplace TEXT,
          birthdate TEXT,
          issue_date TEXT,
          expiry_date TEXT,
          issuer TEXT,
          blood_type TEXT,
          marriage_date TEXT,
          national_card_front_path TEXT,
          national_card_back_path TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS employee_family_members (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
          sort_order INTEGER NOT NULL DEFAULT 0,
          civil_id TEXT,
          name TEXT,
          gender TEXT,
          birthplace TEXT,
          birthdate TEXT,
          issue_date TEXT,
          expiry_date TEXT,
          issuer TEXT,
          blood_type TEXT,
          national_card_front_path TEXT,
          national_card_back_path TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS employee_vehicles (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
          sort_order INTEGER NOT NULL DEFAULT 0,
          plate TEXT,
          brand TEXT,
          type TEXT,
          color TEXT,
          annual_no TEXT,
          issue_date TEXT,
          expiry_date TEXT,
          annual_front_path TEXT,
          annual_back_path TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS employee_attachments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK(kind IN ('general','passport','ration_card')),
          file_path TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          UNIQUE(employee_id, kind, file_path)
        );
        CREATE TABLE IF NOT EXISTS general_docs (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            title      TEXT NOT NULL,
            doc_type   TEXT,
            doc_number TEXT,
            issue_date TEXT,
            issuer     TEXT,
            doc_count  TEXT,
            margin     TEXT,
            is_internal_memo INTEGER NOT NULL DEFAULT 0,
            hr_effect_type TEXT NOT NULL DEFAULT 'none',
            hr_affects_promotion INTEGER NOT NULL DEFAULT 0,
            hr_affects_allowance INTEGER NOT NULL DEFAULT 0,
            hr_effect_months INTEGER NOT NULL DEFAULT 0,
            hr_effect_days INTEGER NOT NULL DEFAULT 0,
            notes      TEXT,
            file_path  TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS general_doc_employees (
          general_doc_id INTEGER NOT NULL REFERENCES general_docs(id) ON DELETE CASCADE,
          employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
          PRIMARY KEY (general_doc_id, employee_id)
        );
        CREATE TABLE IF NOT EXISTS general_doc_attachments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          general_doc_id INTEGER NOT NULL REFERENCES general_docs(id) ON DELETE CASCADE,
          file_path TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS outgoing_docs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          doc_type TEXT,
          doc_number TEXT,
          issue_date TEXT,
          issuer TEXT,
          doc_count TEXT,
          margin TEXT,
          is_internal_memo INTEGER NOT NULL DEFAULT 0,
          notes TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS outgoing_doc_employees (
          outgoing_doc_id INTEGER NOT NULL REFERENCES outgoing_docs(id) ON DELETE CASCADE,
          employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
          PRIMARY KEY (outgoing_doc_id, employee_id)
        );
        CREATE TABLE IF NOT EXISTS outgoing_doc_attachments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          outgoing_doc_id INTEGER NOT NULL REFERENCES outgoing_docs(id) ON DELETE CASCADE,
          file_path TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS activity_log (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     INTEGER,
            username    TEXT NOT NULL,
            role        TEXT NOT NULL DEFAULT 'unknown',
            action      TEXT NOT NULL,
            target_type TEXT,
            target_id   INTEGER,
            target_name TEXT,
            result      TEXT NOT NULL DEFAULT 'Success',
            details     TEXT,
            created_at  TEXT DEFAULT (datetime('now'))
        );
        CREATE TRIGGER IF NOT EXISTS activity_log_no_update BEFORE UPDATE ON activity_log
        BEGIN SELECT RAISE(ABORT, 'audit log is immutable'); END;
        CREATE TRIGGER IF NOT EXISTS activity_log_no_delete BEFORE DELETE ON activity_log
        BEGIN SELECT RAISE(ABORT, 'audit log is immutable'); END;
        CREATE TABLE IF NOT EXISTS backup_log (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            username    TEXT NOT NULL,
            backup_path TEXT NOT NULL,
            created_at  TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS document_metadata (
            stored_path   TEXT PRIMARY KEY,
            original_name TEXT NOT NULL,
            mime_type     TEXT NOT NULL,
            size_bytes    INTEGER NOT NULL,
            created_at    TEXT DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_employees_full_name ON employees(full_name);
        CREATE INDEX IF NOT EXISTS idx_employees_department ON employees(department);
        CREATE INDEX IF NOT EXISTS idx_grade_history_employee_date ON grade_history(employee_id, effective_date DESC);
        CREATE INDEX IF NOT EXISTS idx_employee_spouses_employee ON employee_spouses(employee_id, sort_order);
        CREATE INDEX IF NOT EXISTS idx_employee_family_members_employee ON employee_family_members(employee_id, sort_order);
        CREATE INDEX IF NOT EXISTS idx_employee_vehicles_employee ON employee_vehicles(employee_id, sort_order);
        CREATE INDEX IF NOT EXISTS idx_employee_attachments_employee_kind ON employee_attachments(employee_id, kind, sort_order);
        CREATE INDEX IF NOT EXISTS idx_general_docs_created_at ON general_docs(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_general_doc_employees_employee ON general_doc_employees(employee_id);
        CREATE INDEX IF NOT EXISTS idx_general_doc_attachments_doc ON general_doc_attachments(general_doc_id);
        CREATE INDEX IF NOT EXISTS idx_outgoing_docs_created_at ON outgoing_docs(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_outgoing_doc_employees_employee ON outgoing_doc_employees(employee_id);
        CREATE INDEX IF NOT EXISTS idx_outgoing_doc_attachments_doc ON outgoing_doc_attachments(outgoing_doc_id);
        CREATE INDEX IF NOT EXISTS idx_activity_log_created_at ON activity_log(created_at DESC);
        INSERT OR IGNORE INTO company_config(id) VALUES(1);
        INSERT OR IGNORE INTO app_settings(key,value) VALUES('storage_destination','');
        INSERT OR IGNORE INTO app_settings(key,value) VALUES('document_types','[\"أمر إداري\",\"كتاب رسمي\",\"منشور\",\"تعميم\",\"عقد\",\"محضر اجتماع\",\"أخرى\"]');
    ")?;
    crate::scanner::ensure_metadata_columns(conn)?;
    for definition in [
        "user_id INTEGER",
        "role TEXT NOT NULL DEFAULT 'unknown'",
        "result TEXT NOT NULL DEFAULT 'Success'",
    ] {
        conn.execute(&format!("ALTER TABLE activity_log ADD COLUMN {}", definition), []).ok();
    }
    for table in ["general_doc_attachments", "outgoing_doc_attachments"] {
        let columns: Vec<String> = {
            let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
            let result = stmt.query_map([], |r| r.get::<_, String>(1))?.collect::<SqlResult<_>>()?;
            result
        };
        if !columns.iter().any(|column| column == "sort_order") {
            conn.execute(&format!("ALTER TABLE {table} ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0"), [])?;
        }
        conn.execute(&format!("UPDATE {table} SET sort_order=id WHERE sort_order=0"), [])?;
    }
    for table in ["general_docs", "outgoing_docs"] {
        let columns: Vec<String> = {
            let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
            let result = stmt.query_map([], |r| r.get::<_, String>(1))?.collect::<SqlResult<_>>()?;
            result
        };
        if !columns.iter().any(|column| column == "doc_count") {
            conn.execute(&format!("ALTER TABLE {table} ADD COLUMN doc_count TEXT"), [])?;
        }
        if !columns.iter().any(|column| column == "margin") {
            conn.execute(&format!("ALTER TABLE {table} ADD COLUMN margin TEXT"), [])?;
        }
        if !columns.iter().any(|column| column == "is_internal_memo") {
            conn.execute(&format!("ALTER TABLE {table} ADD COLUMN is_internal_memo INTEGER NOT NULL DEFAULT 0"), [])?;
        }
    }
    let general_doc_columns: Vec<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(general_docs)")?;
        let columns = stmt.query_map([], |r| r.get::<_, String>(1))?.collect::<SqlResult<_>>()?;
        columns
    };
    for (column, definition) in [
        ("hr_effect_type", "TEXT NOT NULL DEFAULT 'none'"),
        ("hr_affects_promotion", "INTEGER NOT NULL DEFAULT 0"),
        ("hr_affects_allowance", "INTEGER NOT NULL DEFAULT 0"),
        ("hr_effect_months", "INTEGER NOT NULL DEFAULT 0"),
        ("hr_effect_days", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        if !general_doc_columns.iter().any(|existing| existing == column) {
            conn.execute(&format!("ALTER TABLE general_docs ADD COLUMN {column} {definition}"), [])?;
        }
    }
    let salary_columns: Vec<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(hr_salary_scales)")?;
        let columns = stmt.query_map([], |r| r.get::<_, String>(1))?.collect::<SqlResult<_>>()?;
        columns
    };
    if !salary_columns.iter().any(|column| column == "allowance_next_step") {
        conn.execute("ALTER TABLE hr_salary_scales ADD COLUMN allowance_next_step INTEGER", [])?;
    }
    migrate_employee_repeating_data(conn)?;
    Ok(())
}

#[cfg(test)]
pub(crate) fn initialize_test(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(include_str!("../../database/schema.sql"))?;
    migrate(conn)?;
    crate::names::upgrade_to_v2(conn)
}

/// Opens (and if needed upgrades) the database in the configured data folder.
/// `allow_create` is true only for a brand-new installation; otherwise a missing database
/// is reported instead of silently creating an empty one.
pub fn open_at(path: &Path, allow_create: bool) -> Result<Connection, OpenError> {
    if !allow_create && !path.is_file() {
        return Err(OpenError::Missing(path.to_path_buf()));
    }
    if let Some(base) = path.parent() {
        fs::create_dir_all(base).ok();
        recover_interrupted_restore(base, path);
    }
    let existed = fs::metadata(path).map(|m| m.is_file() && m.len() > 0).unwrap_or(false);
    let mut conn = Connection::open(path)?;
    conn.pragma_update(None, "busy_timeout", 5000)?;
    let version = schema_version(&conn)?;
    if version > SCHEMA_VERSION {
        return Err(OpenError::NewerSchema { found: version, supported: SCHEMA_VERSION });
    }
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    if version < SCHEMA_VERSION {
        if existed {
            let snapshot = pre_upgrade_snapshot(&conn, version).map_err(OpenError::Snapshot)?;
            if let Err(error) = upgrade(&conn, version) {
                let restored = conn
                    .restore(rusqlite::MAIN_DB, &snapshot, None::<fn(rusqlite::backup::Progress)>)
                    .is_ok();
                return Err(OpenError::UpgradeFailed { from: version, error: error.to_string(), snapshot, restored });
            }
        } else {
            upgrade(&conn, version)?;
        }
    }
    // Accounts still on the unsalted SHA-256 hash of early releases must choose a new
    // password at their next sign-in (which also stores it with bcrypt).
    conn.execute("UPDATE users SET must_change_password=1 WHERE password NOT LIKE '$2%' AND must_change_password=0", [])?;
    let user_count: i64 = conn.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))?;
    if user_count == 0 {
        let password = bcrypt::hash("password", bcrypt::DEFAULT_COST).map_err(|_| rusqlite::Error::InvalidQuery)?;
        conn.execute("INSERT INTO users(username,password,role,must_change_password) VALUES('sysadmin',?1,'system_admin',1)", [password])?;
    }
    Ok(conn)
}

pub fn open() -> Result<Connection, OpenError> {
    open_at(&db_path(), false)
}

/// A second connection to the live database for background work (automatic backups).
/// It never creates, migrates or recovers anything.
pub fn open_existing() -> Result<Connection, OpenError> {
    let path = db_path();
    if !path.is_file() {
        return Err(OpenError::Missing(path));
    }
    let conn = Connection::open(&path)?;
    conn.pragma_update(None, "busy_timeout", 5000)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    let version = schema_version(&conn)?;
    if version != SCHEMA_VERSION {
        return Err(OpenError::NewerSchema { found: version, supported: SCHEMA_VERSION });
    }
    Ok(conn)
}

#[cfg(test)]
mod v3_tests {
    use super::*;

    /// A database from the previous release (schema v2) gains the v3 columns on open.
    #[test]
    fn v2_database_gains_zone_and_registration_columns() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_for_tests(&conn);
        conn.execute_batch("ALTER TABLE employees DROP COLUMN airport_badge_zones;
            ALTER TABLE employee_vehicles DROP COLUMN annual_front_path;
            ALTER TABLE employee_vehicles DROP COLUMN annual_back_path;
            PRAGMA user_version = 2;").unwrap();
        upgrade_restored(&conn).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), SCHEMA_VERSION);
        conn.prepare("SELECT airport_badge_zones FROM employees").unwrap();
        conn.prepare("SELECT annual_front_path, annual_back_path FROM employee_vehicles").unwrap();
        // Running the step again changes nothing.
        upgrade_to_v3(&conn).unwrap();
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::*;

    #[test]
    fn interrupted_restore_recovers_database_and_data() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().to_path_buf();
        let database = base.join("database.db");
        fs::write(&database, b"new database").unwrap();
        fs::write(base.join("database.restore.rollback.db"), b"old database").unwrap();
        fs::create_dir_all(base.join("Data")).unwrap();
        fs::write(base.join("Data/new.txt"), b"new").unwrap();
        fs::create_dir_all(base.join("Data.restore.rollback")).unwrap();
        fs::write(base.join("Data.restore.rollback/old.txt"), b"old").unwrap();
        fs::write(base.join("restore.in_progress"), b"in progress").unwrap();

        recover_interrupted_restore(&base, &database);

        assert_eq!(fs::read(&database).unwrap(), b"old database");
        assert!(base.join("Data/old.txt").is_file());
        assert!(!base.join("restore.in_progress").exists());
    }
}

impl From<OpenError> for crate::services::AppError {
    fn from(error: OpenError) -> Self {
        match error {
            OpenError::Sql(e) => crate::services::AppError::Db(e),
            other @ (OpenError::Missing(_) | OpenError::NewerSchema { .. }) => crate::services::AppError::Validation(other.to_string()),
            other => crate::services::AppError::Other(other.to_string()),
        }
    }
}

#[cfg(test)]
mod upgrade_tests {
    use super::*;
    use crate::paths::{self, AppPaths};

    struct Env {
        _dir: tempfile::TempDir,
        db: PathBuf,
        backups: PathBuf,
    }

    fn env() -> Env {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let backups = dir.path().join("backups");
        fs::create_dir_all(&data).unwrap();
        paths::set_current(Some(AppPaths { data_root: data.clone(), backup_root: backups.clone() }));
        Env { db: data.join(paths::DATABASE_FILE), backups, _dir: dir }
    }

    /// Builds a database exactly as an older AutoHR release would have, with test data.
    fn old_database(path: &Path, schema: &str) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(schema).unwrap();
        let role = if schema.contains("'system_admin'") { "system_admin" } else { "master" };
        conn.execute("INSERT INTO users(username,password,role) VALUES('old_admin','$2b$12$fixturehash',?1)", [role]).unwrap();
        conn.execute("INSERT INTO employees(employee_number,full_name) VALUES('E-001','موظف تجريبي')", []).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), 0);
    }

    fn snapshots(backups: &Path) -> Vec<PathBuf> {
        fs::read_dir(backups.join("PreUpgrade")).map(|entries| entries.map(|e| e.unwrap().path()).collect()).unwrap_or_default()
    }

    fn upgrade_keeps_data(schema: &str) {
        let env = env();
        old_database(&env.db, schema);
        Connection::open(&env.db).unwrap().execute(
            "INSERT INTO users(username,password,role) VALUES('legacy_user',?1,(SELECT role FROM users WHERE username='old_admin'))", [&"a".repeat(64)],
        ).unwrap();
        let conn = open_at(&env.db, false).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), SCHEMA_VERSION);
        let legacy: i64 = conn.query_row("SELECT must_change_password FROM users WHERE username='legacy_user'", [], |r| r.get(0)).unwrap();
        assert_eq!(legacy, 1, "unsalted legacy hashes must pick a new password");
        let name: String = conn.query_row("SELECT full_name FROM employees WHERE employee_number='E-001'", [], |r| r.get(0)).unwrap();
        assert_eq!(name, "موظف تجريبي");
        let flag: i64 = conn.query_row("SELECT must_change_password FROM users WHERE username='old_admin'", [], |r| r.get(0)).unwrap();
        assert_eq!(flag, 0);
        // Exactly one verified snapshot of the old database, holding the old data.
        let taken = snapshots(&env.backups);
        assert_eq!(taken.len(), 1);
        let snap = Connection::open_with_flags(&taken[0], rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert_eq!(schema_version(&snap).unwrap(), 0);
        let count: i64 = snap.query_row("SELECT COUNT(*) FROM employees", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1);
        drop(conn);
        // Opening again does not migrate or snapshot a second time.
        drop(open_at(&env.db, false).unwrap());
        assert_eq!(snapshots(&env.backups).len(), 1);
    }

    #[test]
    fn upgrades_database_from_first_release_schema() {
        upgrade_keeps_data(include_str!("test_fixtures/schema_initial_cca9a40.sql"));
    }

    #[test]
    fn upgrades_database_from_release_with_hr_tables() {
        upgrade_keeps_data(include_str!("test_fixtures/schema_hr_124eff9.sql"));
    }

    #[test]
    fn failed_upgrade_restores_the_original_database() {
        let env = env();
        old_database(&env.db, include_str!("test_fixtures/schema_initial_cca9a40.sql"));
        FAIL_UPGRADE.with(|flag| flag.set(true));
        let result = open_at(&env.db, false);
        FAIL_UPGRADE.with(|flag| flag.set(false));
        match result {
            Err(OpenError::UpgradeFailed { from: 0, restored: true, snapshot, .. }) => assert!(snapshot.is_file()),
            Err(other) => panic!("unexpected error: {other}"),
            Ok(_) => panic!("upgrade should have failed"),
        }
        let conn = Connection::open(&env.db).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), 0);
        let columns: Vec<String> = conn.prepare("PRAGMA table_info(users)").unwrap()
            .query_map([], |r| r.get::<_, String>(1)).unwrap().map(|c| c.unwrap()).collect();
        assert!(!columns.iter().any(|c| c == "must_change_password"), "schema changes must be rolled back");
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM employees", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn database_from_a_newer_version_is_refused_untouched() {
        let env = env();
        drop(open_at(&env.db, true).unwrap());
        let conn = Connection::open(&env.db).unwrap();
        conn.pragma_update(None, "user_version", SCHEMA_VERSION + 5).unwrap();
        drop(conn);
        assert!(matches!(open_at(&env.db, false), Err(OpenError::NewerSchema { .. })));
        let conn = Connection::open(&env.db).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), SCHEMA_VERSION + 5);
    }

    fn parts(conn: &Connection, sql: &str) -> serde_json::Value {
        let text: String = conn.query_row(sql, [], |r| r.get(0)).unwrap();
        serde_json::from_str(&text).unwrap()
    }

    fn count(conn: &Connection, sql: &str) -> i64 {
        conn.query_row(sql, [], |r| r.get(0)).unwrap()
    }

    /// The path of the real data: a database written by v1.0.3 (no user_version), upgraded
    /// through the Phase B step (0 -> 1) and the name split (1 -> 2) in one go.
    #[test]
    fn database_from_1_0_3_gets_split_names_and_keeps_every_original() {
        let env = env();
        old_database(&env.db, include_str!("test_fixtures/schema_v1_0_3_42e8a5e.sql"));
        {
            let conn = Connection::open(&env.db).unwrap();
            conn.execute_batch(
                "UPDATE employees SET full_name='أحمد علي حسين كاظم الجبوري', mother_name='زينب محمد جاسم الموسوي',
                     residence_head_name='علي حسين كاظم', passport_name='AHMED ALI HUSSEIN ALJABOURI' WHERE employee_number='E-001';
                 INSERT INTO employee_spouses(employee_id,sort_order,name,mother_name) VALUES(1,0,'فاطمة عبد الله نور الدين علي الربيعي','سعاد كريم');
                 INSERT INTO employee_family_members(employee_id,sort_order,name) VALUES(1,0,'حسن أحمد علي حسين');",
            ).unwrap();
        }
        let conn = open_at(&env.db, false).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), SCHEMA_VERSION);
        // The combined names are untouched.
        let (full, mother, head, passport): (String, String, String, String) = conn.query_row(
            "SELECT full_name,mother_name,residence_head_name,passport_name FROM employees WHERE id=1", [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        ).unwrap();
        assert_eq!((full.as_str(), mother.as_str(), head.as_str(), passport.as_str()),
            ("أحمد علي حسين كاظم الجبوري", "زينب محمد جاسم الموسوي", "علي حسين كاظم", "AHMED ALI HUSSEIN ALJABOURI"));
        let employee = parts(&conn, "SELECT name_parts FROM employees WHERE id=1");
        assert_eq!(employee["full_name"]["surname"], "كاظم الجبوري");
        assert_eq!(employee["full_name"]["review"], true);
        assert_eq!(employee["mother_name"]["surname"], "الموسوي");
        assert_eq!(employee["residence_head_name"]["review"], true);
        assert_eq!(employee["passport_name"]["surname"], "ALJABOURI");
        let spouse = parts(&conn, "SELECT name_parts FROM employee_spouses WHERE employee_id=1");
        assert_eq!(spouse["name"]["father"], "عبد الله");
        assert_eq!(spouse["name"]["grandfather"], "نور الدين");
        assert_eq!(spouse["mother_name"]["review"], true);
        let family = parts(&conn, "SELECT name_parts FROM employee_family_members WHERE employee_id=1");
        assert_eq!(family["name"]["surname"], "حسين");
        assert_eq!(family["name"]["review"], true);
        // Every original text is archived word for word.
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM name_split_originals"), 7);
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM name_split_originals WHERE field='full_name' AND original_text='أحمد علي حسين كاظم الجبوري'"), 1);
        // Unsure splits wait for review: the five-part names, head of household, spouse's mother, family member.
        let review = crate::names::list_review(&conn).unwrap();
        assert_eq!(review.len(), 5);
        assert_eq!(review[0].original_text.as_deref(), Some("أحمد علي حسين كاظم الجبوري"));
        // One verified snapshot of the v1.0.3 database.
        let taken = snapshots(&env.backups);
        assert_eq!(taken.len(), 1);
        let snap = Connection::open_with_flags(&taken[0], rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert_eq!(schema_version(&snap).unwrap(), 0);
        assert_eq!(count(&snap, "SELECT COUNT(*) FROM employee_spouses"), 1);
        drop(conn);
        // Opening again changes nothing.
        let conn = open_at(&env.db, false).unwrap();
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM name_split_originals"), 7);
        assert_eq!(parts(&conn, "SELECT name_parts FROM employees WHERE id=1"), employee);
        assert_eq!(snapshots(&env.backups).len(), 1);
    }

    /// Spouses and family members that the oldest releases kept in JSON columns are moved
    /// to their tables by step 1 and then split by step 2.
    #[test]
    fn names_kept_in_old_json_columns_are_split_too() {
        let env = env();
        old_database(&env.db, include_str!("test_fixtures/schema_initial_cca9a40.sql"));
        {
            let conn = Connection::open(&env.db).unwrap();
            conn.execute(
                "UPDATE employees SET spouse_name='مريم علي حسن الساعدي', family_members=?1 WHERE id=1",
                [r#"[{"name":"علي أحمد حسين كاظم الجبوري"}]"#],
            ).unwrap();
        }
        let conn = open_at(&env.db, false).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), SCHEMA_VERSION);
        let spouse = parts(&conn, "SELECT name_parts FROM employee_spouses WHERE employee_id=1");
        assert_eq!(spouse["name"]["surname"], "الساعدي");
        let family = parts(&conn, "SELECT name_parts FROM employee_family_members WHERE employee_id=1");
        assert_eq!(family["name"]["surname"], "كاظم الجبوري");
        let name: String = conn.query_row("SELECT full_name FROM employees WHERE id=1", [], |r| r.get(0)).unwrap();
        assert_eq!(name, "موظف تجريبي");
    }

    /// A database already on version 1 (this release before the name split) gets step 2 only.
    #[test]
    fn database_on_version_1_is_upgraded_to_2() {
        let env = env();
        {
            let conn = Connection::open(&env.db).unwrap();
            conn.execute_batch(include_str!("../../database/schema.sql")).unwrap();
            migrate(&conn).unwrap();
            conn.pragma_update(None, "user_version", 1).unwrap();
            conn.execute("INSERT INTO users(username,password,role) VALUES('old_admin','$2b$12$fixturehash','system_admin')", []).unwrap();
            conn.execute("INSERT INTO employees(full_name) VALUES('سارة محمد علي حسن العبيدي')", []).unwrap();
        }
        let conn = open_at(&env.db, false).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), SCHEMA_VERSION);
        assert_eq!(parts(&conn, "SELECT name_parts FROM employees")["full_name"]["first"], "سارة");
        let taken = snapshots(&env.backups);
        assert_eq!(taken.len(), 1);
        assert!(taken[0].to_string_lossy().contains(&format!("database_v1_to_v{SCHEMA_VERSION}_")));
    }

    #[test]
    fn failed_name_split_restores_the_version_1_database() {
        let env = env();
        {
            let conn = Connection::open(&env.db).unwrap();
            conn.execute_batch(include_str!("../../database/schema.sql")).unwrap();
            migrate(&conn).unwrap();
            conn.pragma_update(None, "user_version", 1).unwrap();
            conn.execute("INSERT INTO employees(full_name) VALUES('سارة محمد علي حسن العبيدي')", []).unwrap();
        }
        FAIL_UPGRADE.with(|flag| flag.set(true));
        let result = open_at(&env.db, false);
        FAIL_UPGRADE.with(|flag| flag.set(false));
        assert!(matches!(result, Err(OpenError::UpgradeFailed { from: 1, restored: true, .. })));
        let conn = Connection::open(&env.db).unwrap();
        assert_eq!(schema_version(&conn).unwrap(), 1);
        assert!(!conn.prepare("PRAGMA table_info(employees)").unwrap()
            .query_map([], |r| r.get::<_, String>(1)).unwrap().any(|c| c.unwrap() == "name_parts"));
        assert_eq!(count(&conn, "SELECT COUNT(*) FROM sqlite_master WHERE name='name_split_originals'"), 0);
    }

    #[test]
    fn missing_database_is_not_created() {
        let env = env();
        assert!(matches!(open_at(&env.db, false), Err(OpenError::Missing(_))));
        assert!(!env.db.exists());
    }
}
