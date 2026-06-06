// src-tauri/src/db.rs
use rusqlite::{Connection, Result as SqlResult};
use std::path::PathBuf;
use std::fs;

/// Returns the writable DB path: %APPDATA%/AutoHR/database.db
pub fn db_path() -> PathBuf {
    let base = dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("AutoHR");
    fs::create_dir_all(&base).ok();
    base.join("database.db")
}

fn bundled_db_path() -> Option<PathBuf> {
    // Try next to the executable first
    let exe = std::env::current_exe().ok()?;
    let candidate = exe.parent()?.join("resources").join("database.db");
    if candidate.exists() { return Some(candidate); }

    // Dev mode: walk up from exe looking for src-tauri/resources/
    let mut dir = exe.parent()?;
    for _ in 0..6 {
        let candidate = dir.join("src-tauri").join("resources").join("database.db");
        if candidate.exists() { return Some(candidate); }
        let candidate2 = dir.join("resources").join("database.db");
        if candidate2.exists() { return Some(candidate2); }
        dir = dir.parent()?;
    }
    None
}

fn db_has_users(path: &PathBuf) -> bool {
    if let Ok(conn) = Connection::open(path) {
        // Check table exists and has rows
        let ok: bool = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='users'",
            [],
            |r| r.get::<_, i64>(0),
        ).map(|n| n > 0).unwrap_or(false);
        if !ok { return false; }
        conn.query_row("SELECT COUNT(*) FROM users", [], |r| r.get::<_, i64>(0))
            .map(|n| n > 0)
            .unwrap_or(false)
    } else {
        false
    }
}

fn migrate(conn: &Connection) -> SqlResult<()> {
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
        ("airport_badge_expiry",     "TEXT"),
        ("ministry_badge_no",        "TEXT"),
        ("ministry_badge_expiry",    "TEXT"),
        ("vehicle_plate",            "TEXT"),
        ("vehicle_name",             "TEXT"),
        ("vehicle_color_model",      "TEXT"),
        ("vehicle_annual_no",        "TEXT"),
        ("spouse_name",              "TEXT"),
        ("spouse_mother_name",       "TEXT"),
        ("spouse_birthdate",         "TEXT"),
        ("marriage_date",            "TEXT"),
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
        CREATE TABLE IF NOT EXISTS general_docs (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            title      TEXT NOT NULL,
            doc_type   TEXT,
            doc_number TEXT,
            issue_date TEXT,
            issuer     TEXT,
            notes      TEXT,
            file_path  TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS activity_log (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            username    TEXT NOT NULL,
            action      TEXT NOT NULL,
            target_type TEXT,
            target_id   INTEGER,
            target_name TEXT,
            details     TEXT,
            created_at  TEXT DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS backup_log (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            username    TEXT NOT NULL,
            backup_path TEXT NOT NULL,
            created_at  TEXT DEFAULT (datetime('now'))
        );
        INSERT OR IGNORE INTO company_config(id) VALUES(1);
        INSERT OR IGNORE INTO app_settings(key,value) VALUES('storage_destination','');
        INSERT OR IGNORE INTO app_settings(key,value) VALUES('document_types','[\"أمر إداري\",\"كتاب رسمي\",\"منشور\",\"تعميم\",\"عقد\",\"محضر اجتماع\",\"أخرى\"]');
    ")
}

pub fn open() -> SqlResult<Connection> {
    let path = db_path();

    // Copy bundled DB if:
    // - file doesn't exist, OR
    // - file exists but has no users (was an empty placeholder)
    let needs_copy = !path.exists() || !db_has_users(&path);

    if needs_copy {
        if let Some(src) = bundled_db_path() {
            fs::copy(&src, &path).ok();
        }
    }

    let conn = Connection::open(&path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    migrate(&conn)?;
    Ok(conn)
}
