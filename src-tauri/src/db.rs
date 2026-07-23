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

/// Returns the writable DB path: %APPDATA%/CNSArch/database.db
pub fn db_path() -> PathBuf {
    let base = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("CNSArch");
    fs::create_dir_all(&base).ok();
    base.join("database.db")
}

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
        ("mother_birthplace",    "TEXT"),
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

pub fn open() -> SqlResult<Connection> {
    let path = db_path();
    if let Some(base) = path.parent().map(PathBuf::from) {
        recover_interrupted_restore(&base, &path);
    }
    let conn = Connection::open(&path)?;
    conn.execute_batch(include_str!("../../database/schema.sql"))?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "busy_timeout", 5000)?;
    migrate(&conn)?;
    let user_count: i64 = conn.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))?;
    if user_count == 0 {
        let password = bcrypt::hash("password", bcrypt::DEFAULT_COST).map_err(|_| rusqlite::Error::InvalidQuery)?;
        conn.execute("INSERT INTO users(username,password,role,must_change_password) VALUES('sysadmin',?1,'system_admin',1)", [password])?;
    }
    Ok(conn)
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
