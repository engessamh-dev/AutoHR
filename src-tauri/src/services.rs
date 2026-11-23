// services.rs — GCANS v2.0
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::File,
    io::{Read, Write},
    path::{Path, PathBuf},
};
use bcrypt::{hash, verify, DEFAULT_COST};
use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Nonce};
use argon2::Argon2;
use chrono::Datelike;
use rand::{rngs::OsRng, RngCore};

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Unauthorized")]      Unauthorized,
    #[error("Not found")]         NotFound,
    #[error("Validation: {0}")]   Validation(String),
    #[error("Database: {0}")]     Db(#[from] rusqlite::Error),
    #[error("{0}")]               Other(String),
}
impl serde::Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let message = match self {
            Self::Unauthorized => "You are not authorized to perform this action",
            Self::NotFound => "The requested item was not found",
            Self::Validation(message) => message,
            Self::Db(_) => "The database operation could not be completed",
            Self::Other(_) => "The operation could not be completed",
        };
        s.serialize_str(message)
    }
}
pub type AppResult<T> = Result<T, AppError>;

// ── Models ──────────────────────────────────────────────────────────────────
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct User {
    pub id: i64, pub username: String, pub role: String,
    pub is_master: bool, pub permissions: Vec<String>,
    pub must_change_password: bool, pub created_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CompanyConfig {
    pub company_name: String, pub department_name: String, pub division_name: String,
    pub logo_path: Option<String>, pub logo_full_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Employee {
    pub id: i64,
    pub employee_number: Option<String>,
    pub photo_path: Option<String>,
    pub photo_full_path: Option<String>,
    pub full_name: String,
    pub mother_name: Option<String>,
    pub father_birthplace: Option<String>,
    pub father_birthdate: Option<String>,
    pub mother_birthplace: Option<String>,
    pub mother_birthdate: Option<String>,
    pub gender: Option<String>,
    pub birthdate: Option<String>,
    pub birthplace: Option<String>,
    pub marital_status: Option<String>,
    pub blood_type: Option<String>,
    pub workplace: Option<String>,
    pub job_title: Option<String>,
    pub job_grade: Option<String>,
    pub hire_date: Option<String>,
    pub appointment_date: Option<String>,
    pub contract_type: Option<String>,
    pub work_type_notes: Option<String>,
    pub work_schedule: Option<String>,
    pub department: Option<String>,
    pub division: Option<String>,
    pub phone: Option<String>,
    pub email: Option<String>,
    pub education_level: Option<String>,
    pub specialization: Option<String>,
    pub graduation_year: Option<String>,
    pub civil_id: Option<String>,
    pub civil_id_issuer: Option<String>,
    pub civil_id_issue_date: Option<String>,
    pub civil_id_expiry_date: Option<String>,
    pub civil_id_birthplace: Option<String>,
    pub civil_id_birthdate: Option<String>,
    pub civil_id_family_number: Option<String>,
    pub civil_id_front_path: Option<String>,
    pub civil_id_back_path: Option<String>,
    pub civil_id_front_full_path: Option<String>,
    pub civil_id_back_full_path: Option<String>,
    pub residence_card_no: Option<String>,
    pub residence_card_issuer: Option<String>,
    pub residence_card_issue_date: Option<String>,
    pub residence_head_name: Option<String>,
    pub residence_form_no: Option<String>,
    pub residence_card_front_path: Option<String>,
    pub residence_card_back_path: Option<String>,
    pub residence_card_front_full_path: Option<String>,
    pub residence_card_back_full_path: Option<String>,
    pub residence_address: Option<String>,
    pub ration_card_no: Option<String>,
    pub ration_center_name: Option<String>,
    pub ration_center_no: Option<String>,
    pub ration_card_date: Option<String>,
    pub ration_card_attachment_paths: Option<String>,
    pub ration_card_attachment_full_paths: Vec<String>,
    pub passport_no: Option<String>,
    pub passport_type: Option<String>,
    pub passport_name: Option<String>,
    pub passport_issue_date: Option<String>,
    pub passport_expiry_date: Option<String>,
    pub passport_attachment_paths: Option<String>,
    pub passport_attachment_full_paths: Vec<String>,
    pub airport_badge_no: Option<String>,
    pub airport_badge_issue_date: Option<String>,
    pub airport_badge_expiry: Option<String>,
    /// Access zones printed on the airport badge, comma-separated (e.g. "S1,T,VIP").
    pub airport_badge_zones: Option<String>,
    pub airport_badge_front_path: Option<String>,
    pub airport_badge_back_path: Option<String>,
    pub airport_badge_front_full_path: Option<String>,
    pub airport_badge_back_full_path: Option<String>,
    pub ministry_badge_no: Option<String>,
    pub ministry_badge_issue_date: Option<String>,
    pub ministry_badge_expiry: Option<String>,
    pub ministry_badge_front_path: Option<String>,
    pub ministry_badge_back_path: Option<String>,
    pub ministry_badge_front_full_path: Option<String>,
    pub ministry_badge_back_full_path: Option<String>,
    pub vehicle_plate: Option<String>,
    pub vehicle_name: Option<String>,
    pub vehicle_color_model: Option<String>,
    pub vehicle_type: Option<String>,
    pub vehicle_color: Option<String>,
    pub vehicle_manufacture_year: Option<String>,
    pub vehicle_annual_no: Option<String>,
    pub vehicle_annual_issue_date: Option<String>,
    pub vehicle_annual_expiry_date: Option<String>,
    pub vehicles: Option<String>,
    pub spouse_name: Option<String>,
    pub spouse_mother_name: Option<String>,
    pub spouse_birthdate: Option<String>,
    pub marriage_date: Option<String>,
    pub spouses: Option<String>,
    pub family_members: Option<String>,
    pub attachment_paths: Option<String>,
    pub notes: Option<String>,
    /// Name parts per field (see names.rs).
    pub name_parts: Option<serde_json::Value>,
    pub is_active: i64,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct EmployeeData {
    pub employee_number: Option<String>,
    pub full_name: String,
    pub mother_name: Option<String>,
    pub father_birthplace: Option<String>,
    pub father_birthdate: Option<String>,
    pub mother_birthplace: Option<String>,
    pub mother_birthdate: Option<String>,
    pub gender: Option<String>,
    pub birthdate: Option<String>,
    pub birthplace: Option<String>,
    pub marital_status: Option<String>,
    pub blood_type: Option<String>,
    pub workplace: Option<String>,
    pub job_title: Option<String>,
    pub job_grade: Option<String>,
    pub hire_date: Option<String>,
    pub appointment_date: Option<String>,
    pub contract_type: Option<String>,
    pub work_type_notes: Option<String>,
    pub work_schedule: Option<String>,
    pub department: Option<String>,
    pub division: Option<String>,
    pub phone: Option<String>,
    pub email: Option<String>,
    pub education_level: Option<String>,
    pub specialization: Option<String>,
    pub graduation_year: Option<String>,
    pub civil_id: Option<String>,
    pub civil_id_issuer: Option<String>,
    pub civil_id_issue_date: Option<String>,
    pub civil_id_expiry_date: Option<String>,
    pub civil_id_birthplace: Option<String>,
    pub civil_id_birthdate: Option<String>,
    pub civil_id_family_number: Option<String>,
    pub residence_card_no: Option<String>,
    pub residence_card_issuer: Option<String>,
    pub residence_card_issue_date: Option<String>,
    pub residence_head_name: Option<String>,
    pub residence_form_no: Option<String>,
    pub residence_address: Option<String>,
    pub ration_card_no: Option<String>,
    pub ration_center_name: Option<String>,
    pub ration_center_no: Option<String>,
    pub ration_card_date: Option<String>,
    pub passport_no: Option<String>,
    pub passport_type: Option<String>,
    pub passport_name: Option<String>,
    pub passport_issue_date: Option<String>,
    pub passport_expiry_date: Option<String>,
    pub airport_badge_no: Option<String>,
    pub airport_badge_issue_date: Option<String>,
    pub airport_badge_expiry: Option<String>,
    /// Access zones printed on the airport badge, comma-separated (e.g. "S1,T,VIP").
    pub airport_badge_zones: Option<String>,
    pub ministry_badge_no: Option<String>,
    pub ministry_badge_issue_date: Option<String>,
    pub ministry_badge_expiry: Option<String>,
    pub vehicle_plate: Option<String>,
    pub vehicle_name: Option<String>,
    pub vehicle_color_model: Option<String>,
    pub vehicle_type: Option<String>,
    pub vehicle_color: Option<String>,
    pub vehicle_manufacture_year: Option<String>,
    pub vehicle_annual_no: Option<String>,
    pub vehicle_annual_issue_date: Option<String>,
    pub vehicle_annual_expiry_date: Option<String>,
    pub vehicles: Option<String>,
    pub spouse_name: Option<String>,
    pub spouse_mother_name: Option<String>,
    pub spouse_birthdate: Option<String>,
    pub marriage_date: Option<String>,
    pub spouses: Option<String>,
    pub family_members: Option<String>,
    pub notes: Option<String>,
    pub is_active: Option<i64>,
    /// JSON object of name parts sent by the form; the combined names are rebuilt from it.
    #[serde(default)]
    pub name_parts: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GradeHistory {
    pub id: i64, pub employee_id: i64, pub grade: String,
    pub job_title: Option<String>, pub effective_date: String,
    pub notes: Option<String>, pub created_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GradeHistoryData {
    pub grade: String, pub job_title: Option<String>,
    pub effective_date: String, pub notes: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GeneralDoc {
    pub id: i64, pub title: String, pub doc_type: Option<String>,
    pub doc_number: Option<String>, pub issue_date: Option<String>,
    pub issuer: Option<String>, pub doc_count: Option<String>, pub margin: Option<String>,
    pub is_internal_memo: bool,
    pub hr_effect_type: Option<String>,
    pub hr_affects_promotion: bool,
    pub hr_affects_allowance: bool,
    pub hr_effect_months: i64,
    pub hr_effect_days: i64,
    pub notes: Option<String>,
    pub file_path: Option<String>, pub created_at: Option<String>,
    pub employee_ids: Vec<i64>, pub employee_names: Vec<String>,
    pub attachment_paths: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GeneralDocData {
    pub title: String, pub doc_type: Option<String>, pub doc_number: Option<String>,
    pub issue_date: Option<String>, pub issuer: Option<String>,
    pub doc_count: Option<String>, pub margin: Option<String>, pub is_internal_memo: bool,
    pub hr_effect_type: Option<String>,
    #[serde(default)]
    pub hr_affects_promotion: bool,
    #[serde(default)]
    pub hr_affects_allowance: bool,
    #[serde(default)]
    pub hr_effect_months: i64,
    #[serde(default)]
    pub hr_effect_days: i64,
    pub notes: Option<String>,
    #[serde(default)]
    pub employee_ids: Vec<i64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ActivityLog {
    pub id: i64, pub user_id: Option<i64>, pub username: String, pub role: String, pub action: String,
    pub target_type: Option<String>, pub target_id: Option<i64>,
    pub target_name: Option<String>, pub result: String, pub details: Option<String>,
    pub created_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CompanyConfigData {
    pub company_name: String, pub department_name: Option<String>, pub division_name: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UserData {
    pub username: String, pub password: String, pub role: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UserRoleData { pub role: String }

#[derive(Debug, Serialize, Deserialize)]
pub struct PasswordResetData { pub password: String }

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AutoBackupSettings {
    pub daily_enabled: bool,
    pub weekly_enabled: bool,
    pub monthly_enabled: bool,
    pub has_password: bool,
    pub last_daily: Option<String>,
    pub last_weekly: Option<String>,
    pub last_monthly: Option<String>,
    pub last_daily_path: Option<String>,
    pub last_weekly_path: Option<String>,
    pub last_monthly_path: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AutoBackupSettingsData {
    pub daily_enabled: bool,
    #[serde(default)]
    pub weekly_enabled: bool,
    pub monthly_enabled: bool,
    pub password: Option<String>,
}

// ── Helpers ────────────────────────────────────────────────────────────────
fn legacy_hash_password(plain: &str) -> String {
    let mut h = Sha256::new(); h.update(plain.as_bytes()); hex::encode(h.finalize())
}

fn hash_password(plain: &str) -> AppResult<String> {
    hash(plain, DEFAULT_COST).map_err(|e| AppError::Other(format!("Password hashing failed: {e}")))
}

fn verify_password(plain: &str, stored: &str) -> AppResult<bool> {
    if stored.starts_with("$2") {
        return verify(plain, stored)
            .map_err(|e| AppError::Other(format!("Password verification failed: {e}")));
    }
    Ok(stored.len() == 64 && stored.bytes().all(|b| b.is_ascii_hexdigit()) && legacy_hash_password(plain) == stored)
}

fn validate_new_password(password: &str) -> AppResult<()> {
    if password.len() < 8 {
        return Err(AppError::Validation("Password must be at least 8 characters".into()));
    }
    if password.len() > 72 {
        return Err(AppError::Validation("Password must be at most 72 bytes".into()));
    }
    Ok(())
}

pub fn role_permissions(role: &str) -> &'static [&'static str] {
    match role {
        "system_admin" => &[
            "dashboard.view", "employees.view", "employees.create", "employees.edit", "employees.delete",
            "documents.view", "documents.manage", "documents.upload", "documents.download", "documents.delete", "documents.print",
            "users.manage", "users.assign_system_admin", "audit.view", "settings.manage", "backups.manage", "backups.restore",
        ],
        "archive_admin" => &[
            "dashboard.view", "employees.view", "employees.create", "employees.edit", "employees.delete",
            "documents.view", "documents.manage", "documents.upload", "documents.download", "documents.delete", "documents.print",
            "users.manage", "audit.view", "settings.manage", "backups.manage",
        ],
        "archive_officer" => &[
            "dashboard.view", "employees.view", "employees.create", "employees.edit",
            "documents.view", "documents.upload", "documents.download", "documents.print", "audit.view",
        ],
        "viewer" => &[
            "dashboard.view", "employees.view", "documents.view", "documents.print",
        ],
        _ => &[],
    }
}

fn valid_role(role: &str) -> bool {
    matches!(role, "system_admin" | "archive_admin" | "archive_officer" | "viewer")
}

pub fn user_role(conn: &Connection, username: &str) -> AppResult<String> {
    conn.query_row("SELECT role FROM users WHERE username=?1", params![username], |r| r.get(0))
        .map_err(|_| AppError::Unauthorized)
}

pub fn assert_permission(conn: &Connection, username: &str, permission: &str) -> AppResult<()> {
    let role = user_role(conn, username)?;
    if role_permissions(&role).contains(&permission) { Ok(()) } else { Err(AppError::Unauthorized) }
}

pub fn app_data_path() -> std::path::PathBuf {
    #[cfg(test)]
    if let Some(root) = TEST_APP_DATA_ROOT.with(|value| value.borrow().clone()) { return root; }
    dirs::data_dir().unwrap_or_else(|| std::path::PathBuf::from(".")).join(if cfg!(debug_assertions) { "CNSArch-Development" } else { "CNSArch" })
}

#[cfg(test)]
thread_local! { pub(crate) static TEST_STORAGE_ROOT: std::cell::RefCell<Option<std::path::PathBuf>> = const { std::cell::RefCell::new(None) }; }

#[cfg(test)]
thread_local! { pub(crate) static TEST_APP_DATA_ROOT: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) }; }

pub fn storage_path(_conn: &Connection) -> std::path::PathBuf {
    #[cfg(test)]
    if let Some(root) = TEST_STORAGE_ROOT.with(|value| value.borrow().clone()) { return root; }
    crate::paths::data_root().join("Data")
}

pub fn backup_path(_conn: &Connection) -> std::path::PathBuf {
    crate::paths::backup_root()
}

fn merge_legacy_dir(src: &Path, dst: &Path) -> std::io::Result<bool> {
    if !src.exists() { return Ok(false); }
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            merge_legacy_dir(&from, &to)?;
            std::fs::remove_dir(&from).ok();
        } else if !to.exists() {
            std::fs::rename(&from, &to).or_else(|_| {
                std::fs::copy(&from, &to)?;
                std::fs::remove_file(&from)
            })?;
        }
    }
    std::fs::remove_dir(src).ok();
    Ok(true)
}

fn copy_legacy_dir_missing(src: &Path, dst: &Path) -> std::io::Result<bool> {
    if !src.exists() { return Ok(false); }
    std::fs::create_dir_all(dst)?;
    let mut copied = false;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copied |= copy_legacy_dir_missing(&from, &to)?;
        } else if !to.exists() {
            std::fs::copy(&from, &to)?;
            copied = true;
        }
    }
    Ok(copied)
}

fn backup_date_parts(name: &str) -> Option<(&str, &str)> {
    for part in name.split('_') {
        let bytes = part.as_bytes();
        if bytes.len() == 10
            && bytes[4] == b'-'
            && bytes[7] == b'-'
            && bytes.iter().enumerate().all(|(i, b)| i == 4 || i == 7 || b.is_ascii_digit())
        {
            return Some((&part[0..4], &part[5..7]));
        }
    }
    None
}

fn organize_legacy_backups(root: &Path) -> std::io::Result<()> {
    let backups = root.join("Backups");
    if !backups.exists() { return Ok(()); }
    for entry in std::fs::read_dir(&backups)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() { continue; }
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        let dest_dir = if let Some((year, month)) = backup_date_parts(&name_str) {
            backups.join("Daily").join(year).join(month)
        } else {
            backups.join("Daily").join("Legacy")
        };
        std::fs::create_dir_all(&dest_dir)?;
        let dest = dest_dir.join(&name);
        if dest.exists() {
            std::fs::remove_file(entry.path()).ok();
        } else {
            std::fs::rename(entry.path(), &dest).or_else(|_| {
                std::fs::copy(entry.path(), &dest)?;
                std::fs::remove_file(entry.path())
            })?;
        }
    }
    Ok(())
}

pub fn ensure_storage_layout(conn: &Connection) -> AppResult<()> {
    // Isolated tests must never import the user's legacy Documents folders.
    #[cfg(test)]
    if TEST_STORAGE_ROOT.with(|root| root.borrow().is_some()) {
        std::fs::create_dir_all(storage_path(conn)).map_err(|e| AppError::Other(e.to_string()))?;
        return Ok(());
    }
    let root = storage_path(conn);
    for dir in [
        "Database",
        "Files/Employees",
        "Files/GeneralDocs",
        "Files/OutgoingDocs",
        "Branding",
        "Exports/PDF",
        "Exports/Excel",
        "Logs",
        "Temp",
    ] {
        std::fs::create_dir_all(root.join(dir)).map_err(|e| AppError::Other(e.to_string()))?;
    }

    let moved_employees = merge_legacy_dir(&root.join("Employees"), &root.join("Files").join("Employees")).unwrap_or(false);
    if moved_employees {
        conn.execute("UPDATE employees SET photo_path='Files/' || photo_path WHERE photo_path LIKE 'Employees/%'", [])?;
    }
    let moved_general_docs = merge_legacy_dir(&root.join("GeneralDocs"), &root.join("Files").join("GeneralDocs")).unwrap_or(false);
    if moved_general_docs {
        conn.execute("UPDATE general_docs SET file_path='Files/' || file_path WHERE file_path LIKE 'GeneralDocs/%'", [])?;
    }
    // Development must not import legacy production attachments.
    if !cfg!(debug_assertions) {
    if let Some(documents_dir) = dirs::document_dir() {
        for legacy_name in ["GCANS", "AutoHR"] {
            let legacy_root = documents_dir.join(legacy_name);
            copy_legacy_dir_missing(&legacy_root.join("Files"), &root.join("Files")).ok();
            copy_legacy_dir_missing(&legacy_root.join("Branding"), &root.join("Branding")).ok();
        }
    }
    }
    organize_legacy_backups(&root).ok();

    Ok(())
}

pub fn ensure_backup_layout(conn: &Connection) -> AppResult<()> {
    let root = backup_path(conn);
    for dir in ["Daily", "Weekly", "Monthly"] {
        std::fs::create_dir_all(root.join(dir)).map_err(|e| AppError::Other(e.to_string()))?;
    }
    Ok(())
}

pub fn log_activity(conn: &Connection, username: &str, action: &str,
    target_type: Option<&str>, target_id: Option<i64>, target_name: Option<&str>, details: Option<&str>) {
    log_audit(conn, Some(username), action, target_type, target_id, target_name, "Success", details);
}

#[allow(clippy::too_many_arguments)]
pub fn log_audit(conn: &Connection, username: Option<&str>, action: &str,
    target_type: Option<&str>, target_id: Option<i64>, target_name: Option<&str>, result: &str, details: Option<&str>) {
    let identity = username.and_then(|name| conn.query_row(
        "SELECT id,role FROM users WHERE username=?1", params![name],
        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
    ).ok());
    conn.execute(
        "INSERT INTO activity_log(user_id,username,role,action,target_type,target_id,target_name,result,details)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![
            identity.as_ref().map(|v| v.0), username.unwrap_or("unknown"),
            identity.as_ref().map(|v| v.1.as_str()).unwrap_or("unknown"),
            action, target_type, target_id, target_name, result, details
        ]
    ).ok();
}

fn default_document_types() -> Vec<String> {
    vec![
        "أمر إداري".into(),
        "كتاب رسمي".into(),
        "منشور".into(),
        "تعميم".into(),
        "عقد".into(),
        "محضر اجتماع".into(),
        "أخرى".into(),
    ]
}

fn normalize_document_types(types: &[String]) -> Vec<String> {
    let mut normalized = Vec::new();
    for value in types {
        let trimmed = value.trim();
        if !trimmed.is_empty() && trimmed.chars().count() <= 100 && !normalized.iter().any(|v: &String| v == trimmed) {
            normalized.push(trimmed.to_string());
        }
    }
    normalized
}

// ── Auth ───────────────────────────────────────────────────────────────────
const LOGIN_MAX_FAILURES: u32 = 5;
const LOGIN_LOCKOUT: std::time::Duration = std::time::Duration::from_secs(5 * 60);

/// Failed sign-in attempts per username, kept in the database so that restarting the
/// application does not reset a lockout.
fn login_failures_table(conn: &Connection) {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS login_failures (username_key TEXT PRIMARY KEY, failures INTEGER NOT NULL, last_failure INTEGER NOT NULL)",
        [],
    ).ok();
}

fn now_secs() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn login_key(username: &str) -> String {
    username.trim().to_lowercase()
}

fn login_locked_remaining(conn: &Connection, username: &str) -> Option<std::time::Duration> {
    login_failures_table(conn);
    let key = login_key(username);
    let (count, last): (i64, i64) = conn.query_row(
        "SELECT failures,last_failure FROM login_failures WHERE username_key=?1", params![key], |r| Ok((r.get(0)?, r.get(1)?)),
    ).ok()?;
    if count < LOGIN_MAX_FAILURES as i64 { return None; }
    // A clock moved backwards counts as "just now" rather than unlocking early.
    let elapsed = std::time::Duration::from_secs(now_secs().saturating_sub(last).max(0) as u64);
    if elapsed >= LOGIN_LOCKOUT {
        clear_login_failures(conn, username);
        return None;
    }
    Some(LOGIN_LOCKOUT - elapsed)
}

fn record_login_failure(conn: &Connection, username: &str) {
    login_failures_table(conn);
    conn.execute(
        "INSERT INTO login_failures(username_key,failures,last_failure) VALUES(?1,1,?2)
         ON CONFLICT(username_key) DO UPDATE SET failures=failures+1, last_failure=excluded.last_failure",
        params![login_key(username), now_secs()],
    ).ok();
}

fn clear_login_failures(conn: &Connection, username: &str) {
    login_failures_table(conn);
    conn.execute("DELETE FROM login_failures WHERE username_key=?1", params![login_key(username)]).ok();
}

/// A bcrypt hash of a random value, checked when the username does not exist so that the
/// response time does not reveal which usernames are valid.
fn dummy_password_hash() -> &'static str {
    static HASH: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    HASH.get_or_init(|| {
        let mut random = [0u8; 16];
        OsRng.fill_bytes(&mut random);
        hash_password(&hex::encode(random)).unwrap_or_default()
    })
}

/// Arabic count agreement for minutes: 1 دقيقة واحدة, 2 دقيقتين, 3-10 دقائق, 11+ دقيقة.
fn arabic_minutes(minutes: u64) -> String {
    match minutes {
        1 => "دقيقة واحدة".into(),
        2 => "دقيقتين".into(),
        3..=10 => format!("{minutes} دقائق"),
        _ => format!("{minutes} دقيقة"),
    }
}

pub fn login(conn: &Connection, username: &str, password: &str) -> AppResult<User> {
    if username.trim().is_empty() || username.len() > 64 || password.is_empty() || password.len() > 256 {
        return Err(AppError::Validation("Enter a valid username and password".into()));
    }
    if let Some(remaining) = login_locked_remaining(conn, username) {
        log_audit(conn, Some(username), "LOGIN", Some("session"), None, None, "Failure", Some("Account temporarily locked"));
        let minutes = remaining.as_secs().div_ceil(60).max(1);
        return Err(AppError::Validation(format!(
            "تم إيقاف تسجيل الدخول لهذا الحساب مؤقتًا بسبب تكرار المحاولات الفاشلة. حاول بعد {}.",
            arabic_minutes(minutes)
        )));
    }
    let row = match conn.query_row(
        "SELECT id,username,password,role,must_change_password,created_at FROM users WHERE username=?1",
        params![username],
        |r| Ok((
            r.get::<_,i64>(0)?, r.get::<_,String>(1)?, r.get::<_,String>(2)?,
            r.get::<_,String>(3)?, r.get::<_,bool>(4)?, r.get::<_,Option<String>>(5)?
        )),
    ) {
        Ok(row) => row,
        Err(_) => {
            let _ = verify_password(password, dummy_password_hash());
            record_login_failure(conn, username);
            log_audit(conn, Some(username), "LOGIN", Some("session"), None, None, "Failure", Some("Unknown username"));
            return Err(AppError::Unauthorized);
        }
    };
    if !verify_password(password, &row.2)? {
        record_login_failure(conn, username);
        log_audit(conn, Some(username), "LOGIN", Some("session"), None, None, "Failure", Some("Invalid password"));
        return Err(AppError::Unauthorized);
    }
    clear_login_failures(conn, username);
    if !row.2.starts_with("$2") {
        conn.execute("UPDATE users SET password=?1 WHERE id=?2", params![hash_password(password)?, row.0])?;
    }
    let is_master = row.1 == "sysadmin" || row.3 == "system_admin";
    log_activity(conn, username, "LOGIN", None, None, None, None);
    Ok(User {
        id: row.0, username: row.1, role: row.3.clone(), is_master,
        permissions: role_permissions(&row.3).iter().map(|p| p.to_string()).collect(),
        must_change_password: row.4, created_at: row.5,
    })
}

pub fn change_password(conn: &Connection, username: &str, current_password: &str, new_password: &str) -> AppResult<User> {
    validate_new_password(new_password)?;
    if current_password == new_password {
        return Err(AppError::Validation("New password must be different".into()));
    }
    let stored: String = conn.query_row(
        "SELECT password FROM users WHERE username=?1", params![username], |r| r.get(0)
    ).map_err(|_| AppError::Unauthorized)?;
    if !verify_password(current_password, &stored)? {
        return Err(AppError::Unauthorized);
    }
    conn.execute(
        "UPDATE users SET password=?1, must_change_password=0 WHERE username=?2",
        params![hash_password(new_password)?, username],
    )?;
    log_activity(conn, username, "CHANGE_PASSWORD", Some("user"), None, Some(username), None);
    login(conn, username, new_password)
}

pub fn logout(conn: &Connection, username: &str) -> AppResult<()> {
    log_activity(conn, username, "LOGOUT", None, None, None, None);
    Ok(())
}

// ── Company ────────────────────────────────────────────────────────────────
pub fn get_company_config(conn: &Connection) -> AppResult<CompanyConfig> {
    conn.query_row("SELECT company_name,department_name,division_name,logo_path FROM company_config WHERE id=1",
        [], |r| {
            let logo_path: Option<String> = r.get(3)?;
            let logo_full_path = logo_path.as_ref().map(|p| crate::scanner::effective_path(conn,p).unwrap_or_else(|_|storage_path(conn).join(p)).to_string_lossy().into_owned());
            Ok(CompanyConfig {
                company_name:r.get(0)?,
                department_name:r.get(1)?,
                division_name:r.get(2)?,
                logo_path,
                logo_full_path,
            })
        })
        .map_err(Into::into)
}

pub fn update_company_config(conn: &Connection, user: &str, data: &CompanyConfigData) -> AppResult<CompanyConfig> {
    assert_permission(conn, user, "settings.manage")?;
    conn.execute("UPDATE company_config SET company_name=?1,department_name=?2,division_name=?3 WHERE id=1",
        params![data.company_name, data.department_name.as_deref().unwrap_or(""), data.division_name.as_deref().unwrap_or("")])?;
    log_activity(conn, user, "CHANGE_SETTING", Some("settings"), Some(1), Some("company_config"), None);
    get_company_config(conn)
}

// The company logo is a fixed asset bundled with the frontend (src/assets/branding).
// There is deliberately no command to replace it; `logo_path` is kept only for
// backward compatibility with databases created by earlier releases.

// ── Employee number ────────────────────────────────────────────────────────
pub fn next_employee_number(conn: &Connection) -> AppResult<String> {
    let max: Option<String> = conn.query_row(
        "SELECT employee_number FROM employees WHERE employee_number LIKE 'GC-%' ORDER BY employee_number DESC LIMIT 1",
        [], |r| r.get(0)
    ).ok();
    let next_num = if let Some(s) = max {
        let n: u32 = s.trim_start_matches("GC-").parse().unwrap_or(0);
        n + 1
    } else { 1 };
    Ok(format!("GC-{:03}", next_num))
}

// ── Employees ──────────────────────────────────────────────────────────────
const EMP_COLS: &str = "id,employee_number,photo_path,full_name,mother_name,father_birthplace,mother_birthplace,
  gender,birthdate,birthplace,marital_status,blood_type,workplace,job_title,job_grade,
  hire_date,contract_type,department,division,phone,email,
  education_level,specialization,graduation_year,
  civil_id,civil_id_issuer,civil_id_issue_date,civil_id_expiry_date,
  residence_card_no,residence_card_issuer,residence_address,
  ration_card_no,ration_center_name,ration_center_no,ration_card_date,
  passport_no,passport_name,passport_issue_date,passport_expiry_date,
  airport_badge_no,airport_badge_expiry,ministry_badge_no,ministry_badge_expiry,
  vehicle_plate,vehicle_name,vehicle_color_model,vehicle_annual_no,
  spouse_name,spouse_mother_name,spouse_birthdate,marriage_date,
  family_members,attachment_paths,notes,is_active,created_at,updated_at,work_type_notes,work_schedule,
  civil_id_birthplace,civil_id_birthdate,civil_id_family_number,civil_id_front_path,civil_id_back_path,
  passport_type,passport_attachment_paths,residence_card_issue_date,residence_head_name,residence_form_no,
  residence_card_front_path,residence_card_back_path,ration_card_attachment_paths,
  airport_badge_issue_date,airport_badge_front_path,airport_badge_back_path,
  ministry_badge_issue_date,ministry_badge_front_path,ministry_badge_back_path,
  vehicle_color,vehicle_manufacture_year,vehicle_type,vehicle_annual_issue_date,vehicle_annual_expiry_date,vehicles,spouses,
  appointment_date,father_birthdate,mother_birthdate,name_parts,airport_badge_zones";

fn map_emp(r: &rusqlite::Row) -> rusqlite::Result<Employee> {
    Ok(Employee {
        id:r.get(0)?,employee_number:r.get(1)?,photo_path:r.get(2)?,full_name:r.get(3)?,
        photo_full_path:None,
        mother_name:r.get(4)?,father_birthplace:r.get(5)?,mother_birthplace:r.get(6)?,
        gender:r.get(7)?,birthdate:r.get(8)?,birthplace:r.get(9)?,marital_status:r.get(10)?,blood_type:r.get(11)?,
        workplace:r.get(12)?,job_title:r.get(13)?,job_grade:r.get(14)?,
        hire_date:r.get(15)?,contract_type:r.get(16)?,
        department:r.get(17)?,division:r.get(18)?,phone:r.get(19)?,email:r.get(20)?,
        education_level:r.get(21)?,specialization:r.get(22)?,graduation_year:r.get(23)?,
        civil_id:r.get(24)?,civil_id_issuer:r.get(25)?,civil_id_issue_date:r.get(26)?,civil_id_expiry_date:r.get(27)?,
        residence_card_no:r.get(28)?,residence_card_issuer:r.get(29)?,residence_address:r.get(30)?,
        ration_card_no:r.get(31)?,ration_center_name:r.get(32)?,ration_center_no:r.get(33)?,ration_card_date:r.get(34)?,
        passport_no:r.get(35)?,passport_name:r.get(36)?,passport_issue_date:r.get(37)?,passport_expiry_date:r.get(38)?,
        airport_badge_no:r.get(39)?,airport_badge_expiry:r.get(40)?,
        ministry_badge_no:r.get(41)?,ministry_badge_expiry:r.get(42)?,
        vehicle_plate:r.get(43)?,vehicle_name:r.get(44)?,vehicle_color_model:r.get(45)?,vehicle_annual_no:r.get(46)?,
        spouse_name:r.get(47)?,spouse_mother_name:r.get(48)?,spouse_birthdate:r.get(49)?,marriage_date:r.get(50)?,
        family_members:r.get(51)?,attachment_paths:r.get(52)?,notes:r.get(53)?,
        is_active:r.get(54)?,created_at:r.get(55)?,updated_at:r.get(56)?,
        work_type_notes:r.get(57)?,
        work_schedule:r.get(58)?,
        civil_id_birthplace:r.get(59)?,
        civil_id_birthdate:r.get(60)?,
        civil_id_family_number:r.get(61)?,
        civil_id_front_path:r.get(62)?,
        civil_id_back_path:r.get(63)?,
        passport_type:r.get(64)?,
        passport_attachment_paths:r.get(65)?,
        residence_card_issue_date:r.get(66)?,
        residence_head_name:r.get(67)?,
        residence_form_no:r.get(68)?,
        residence_card_front_path:r.get(69)?,
        residence_card_back_path:r.get(70)?,
        ration_card_attachment_paths:r.get(71)?,
        airport_badge_issue_date:r.get(72)?,
        airport_badge_front_path:r.get(73)?,
        airport_badge_back_path:r.get(74)?,
        ministry_badge_issue_date:r.get(75)?,
        ministry_badge_front_path:r.get(76)?,
        ministry_badge_back_path:r.get(77)?,
        vehicle_color:r.get(78)?,
        vehicle_manufacture_year:r.get(79)?,
        vehicle_type:r.get(80)?,
        vehicle_annual_issue_date:r.get(81)?,
        vehicle_annual_expiry_date:r.get(82)?,
        vehicles:r.get(83)?,
        spouses:r.get(84)?,
        appointment_date:r.get(85)?,
        father_birthdate:r.get(86)?,
        mother_birthdate:r.get(87)?,
        name_parts:r.get::<_, Option<String>>(88)?.and_then(|value| serde_json::from_str(&value).ok()),
        airport_badge_zones:r.get(89)?,
        residence_card_front_full_path:None,
        residence_card_back_full_path:None,
        airport_badge_front_full_path:None,
        airport_badge_back_full_path:None,
        ministry_badge_front_full_path:None,
        ministry_badge_back_full_path:None,
        passport_attachment_full_paths:Vec::new(),
        ration_card_attachment_full_paths:Vec::new(),
        civil_id_front_full_path:None,
        civil_id_back_full_path:None,
    })
}

fn attachment_full_path(conn: &Connection, relative_path: &Option<String>) -> Option<String> {
    let path = relative_path.as_deref().map(Path::new)?;
    if path.is_absolute() || path.components().any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::Prefix(_))) {
        return None;
    }
    Some(crate::scanner::effective_path(conn, relative_path.as_deref()?).unwrap_or_else(|_| storage_path(conn).join(path)).to_string_lossy().into_owned())
}

fn row_text(row: &rusqlite::Row, index: usize) -> rusqlite::Result<Option<String>> {
    row.get(index)
}

fn optional_json_value(value: Option<String>) -> serde_json::Value {
    value.map(serde_json::Value::String).unwrap_or(serde_json::Value::Null)
}

fn repeating_array<F>(conn: &Connection, sql: &str, employee_id: i64, mapper: F) -> AppResult<Vec<serde_json::Value>>
where
    F: FnMut(&rusqlite::Row) -> rusqlite::Result<serde_json::Value>,
{
    let mut stmt = conn.prepare(sql)?;
    let values = stmt.query_map(params![employee_id], mapper)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(AppError::from)?;
    Ok(values)
}

fn load_employee_spouses(conn: &Connection, employee_id: i64) -> AppResult<Vec<serde_json::Value>> {
    repeating_array(conn,
        "SELECT civil_id,name,mother_name,gender,birthplace,birthdate,issue_date,expiry_date,issuer,blood_type,marriage_date,national_card_front_path,national_card_back_path,name_parts
         FROM employee_spouses WHERE employee_id=?1 ORDER BY sort_order,id",
        employee_id,
        |row| {
            let front = row_text(row, 11)?;
            let back = row_text(row, 12)?;
            Ok(serde_json::json!({
                "civil_id": optional_json_value(row_text(row, 0)?),
                "name": optional_json_value(row_text(row, 1)?),
                "mother_name": optional_json_value(row_text(row, 2)?),
                "gender": optional_json_value(row_text(row, 3)?),
                "birthplace": optional_json_value(row_text(row, 4)?),
                "birthdate": optional_json_value(row_text(row, 5)?),
                "issue_date": optional_json_value(row_text(row, 6)?),
                "expiry_date": optional_json_value(row_text(row, 7)?),
                "issuer": optional_json_value(row_text(row, 8)?),
                "blood_type": optional_json_value(row_text(row, 9)?),
                "marriage_date": optional_json_value(row_text(row, 10)?),
                "name_parts": serde_json::Value::Object(crate::names::parts_object(row_text(row, 13)?.as_deref())),
                "national_card_front_path": optional_json_value(front.clone()),
                "national_card_back_path": optional_json_value(back.clone()),
                "national_card_front_full_path": optional_json_value(attachment_full_path(conn, &front)),
                "national_card_back_full_path": optional_json_value(attachment_full_path(conn, &back)),
            }))
        })
}

fn load_employee_family_members(conn: &Connection, employee_id: i64) -> AppResult<Vec<serde_json::Value>> {
    repeating_array(conn,
        "SELECT civil_id,name,gender,birthplace,birthdate,issue_date,expiry_date,issuer,blood_type,national_card_front_path,national_card_back_path,name_parts
         FROM employee_family_members WHERE employee_id=?1 ORDER BY sort_order,id",
        employee_id,
        |row| {
            let front = row_text(row, 9)?;
            let back = row_text(row, 10)?;
            Ok(serde_json::json!({
                "civil_id": optional_json_value(row_text(row, 0)?),
                "name": optional_json_value(row_text(row, 1)?),
                "gender": optional_json_value(row_text(row, 2)?),
                "birthplace": optional_json_value(row_text(row, 3)?),
                "birthdate": optional_json_value(row_text(row, 4)?),
                "issue_date": optional_json_value(row_text(row, 5)?),
                "expiry_date": optional_json_value(row_text(row, 6)?),
                "issuer": optional_json_value(row_text(row, 7)?),
                "blood_type": optional_json_value(row_text(row, 8)?),
                "name_parts": serde_json::Value::Object(crate::names::parts_object(row_text(row, 11)?.as_deref())),
                "national_card_front_path": optional_json_value(front.clone()),
                "national_card_back_path": optional_json_value(back.clone()),
                "national_card_front_full_path": optional_json_value(attachment_full_path(conn, &front)),
                "national_card_back_full_path": optional_json_value(attachment_full_path(conn, &back)),
            }))
        })
}

fn load_employee_vehicles(conn: &Connection, employee_id: i64) -> AppResult<Vec<serde_json::Value>> {
    repeating_array(conn,
        "SELECT plate,brand,type,color,annual_no,issue_date,expiry_date,annual_front_path,annual_back_path,governorate,plate_category,chassis_no,model_year FROM employee_vehicles WHERE employee_id=?1 ORDER BY sort_order,id",
        employee_id,
        |row| {
            let front = row_text(row, 7)?;
            let back = row_text(row, 8)?;
            Ok(serde_json::json!({
                "plate": optional_json_value(row_text(row, 0)?),
                "brand": optional_json_value(row_text(row, 1)?),
                "type": optional_json_value(row_text(row, 2)?),
                "color": optional_json_value(row_text(row, 3)?),
                "annual_no": optional_json_value(row_text(row, 4)?),
                "issue_date": optional_json_value(row_text(row, 5)?),
                "expiry_date": optional_json_value(row_text(row, 6)?),
                "annual_front_path": optional_json_value(front.clone()),
                "annual_back_path": optional_json_value(back.clone()),
                "governorate": optional_json_value(row_text(row, 9)?),
                "plate_category": optional_json_value(row_text(row, 10)?),
                "chassis_no": optional_json_value(row_text(row, 11)?),
                "model_year": optional_json_value(row_text(row, 12)?),
                "annual_front_full_path": optional_json_value(attachment_full_path(conn, &front)),
                "annual_back_full_path": optional_json_value(attachment_full_path(conn, &back)),
            }))
        })
}

fn load_employee_attachment_paths(conn: &Connection, employee_id: i64, kind: &str) -> AppResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT file_path FROM employee_attachments WHERE employee_id=?1 AND kind=?2 ORDER BY sort_order,id"
    )?;
    let paths = stmt.query_map(params![employee_id, kind], |row| row.get(0))?
        .collect::<rusqlite::Result<Vec<String>>>()
        .map_err(AppError::from)?;
    Ok(paths)
}

fn add_employee_full_paths(conn: &Connection, employee: &mut Employee) {
    employee.photo_full_path = attachment_full_path(conn, &employee.photo_path);
    employee.civil_id_front_full_path = attachment_full_path(conn, &employee.civil_id_front_path);
    employee.civil_id_back_full_path = attachment_full_path(conn, &employee.civil_id_back_path);
    employee.residence_card_front_full_path = attachment_full_path(conn, &employee.residence_card_front_path);
    employee.residence_card_back_full_path = attachment_full_path(conn, &employee.residence_card_back_path);
    employee.airport_badge_front_full_path = attachment_full_path(conn, &employee.airport_badge_front_path);
    employee.airport_badge_back_full_path = attachment_full_path(conn, &employee.airport_badge_back_path);
    employee.ministry_badge_front_full_path = attachment_full_path(conn, &employee.ministry_badge_front_path);
    employee.ministry_badge_back_full_path = attachment_full_path(conn, &employee.ministry_badge_back_path);
    let paths: Vec<String> = employee.passport_attachment_paths.as_deref()
        .and_then(|value| serde_json::from_str(value).ok())
        .unwrap_or_default();
    employee.passport_attachment_full_paths = paths.iter().take(1)
        .filter_map(|path| attachment_full_path(conn, &Some(path.clone())))
        .collect();
    let ration_paths: Vec<String> = employee.ration_card_attachment_paths.as_deref()
        .and_then(|value| serde_json::from_str(value).ok())
        .unwrap_or_default();
    employee.ration_card_attachment_full_paths = ration_paths.iter().take(1)
        .filter_map(|path| attachment_full_path(conn, &Some(path.clone())))
        .collect();
    if let Ok(spouses) = load_employee_spouses(conn, employee.id) {
        employee.spouses = serde_json::to_string(&spouses).ok();
    }
    if let Ok(members) = load_employee_family_members(conn, employee.id) {
        employee.family_members = serde_json::to_string(&members).ok();
    }
    if let Ok(vehicles) = load_employee_vehicles(conn, employee.id) {
        employee.vehicles = serde_json::to_string(&vehicles).ok();
    }
    if let Ok(paths) = load_employee_attachment_paths(conn, employee.id, "general") {
        employee.attachment_paths = serde_json::to_string(&paths).ok();
    }
    if let Ok(paths) = load_employee_attachment_paths(conn, employee.id, "passport") {
        employee.passport_attachment_paths = serde_json::to_string(&paths).ok();
        employee.passport_attachment_full_paths = paths.iter().take(1)
            .filter_map(|path| attachment_full_path(conn, &Some(path.clone())))
            .collect();
    }
    if let Ok(paths) = load_employee_attachment_paths(conn, employee.id, "ration_card") {
        employee.ration_card_attachment_paths = serde_json::to_string(&paths).ok();
        employee.ration_card_attachment_full_paths = paths.iter().take(1)
            .filter_map(|path| attachment_full_path(conn, &Some(path.clone())))
            .collect();
    }
}

fn validate_passport_type(passport_type: &Option<String>) -> AppResult<()> {
    if passport_type.as_deref().is_some_and(|value| !["P", "D", "S"].contains(&value)) {
        return Err(AppError::Validation("passport_type must be P, D, or S".into()));
    }
    Ok(())
}

fn validate_json_array(value: &Option<String>, field: &str) -> AppResult<()> {
    if let Some(value) = value {
        if serde_json::from_str::<Vec<serde_json::Value>>(value).is_err() {
            return Err(AppError::Validation(format!("{field} must be a valid JSON array")));
        }
    }
    Ok(())
}

fn validate_spouses(data: &EmployeeData) -> AppResult<()> {
    let Some(value) = data.spouses.as_deref() else { return Ok(()); };
    let spouses: Vec<serde_json::Value> = serde_json::from_str(value)
        .map_err(|_| AppError::Validation("spouses must be a valid JSON array".into()))?;
    let has_spouse_section = matches!(data.marital_status.as_deref(), Some("متزوج" | "أرمل" | "ارمل"));
    let max = if has_spouse_section && data.gender.as_deref() == Some("أنثى") {
        1
    } else {
        4
    };
    if spouses.len() > max {
        return Err(AppError::Validation(format!("spouses cannot contain more than {max} record(s)")));
    }
    Ok(())
}

fn validate_employee_data(data: &EmployeeData) -> AppResult<()> {
    if data.full_name.trim().is_empty() || data.full_name.chars().count() > 200 {
        return Err(AppError::Validation("Enter a valid employee name".into()));
    }
    if data.is_active.is_some_and(|value| value != 0 && value != 1) {
        return Err(AppError::Validation("Employee status must be active or inactive".into()));
    }
    validate_passport_type(&data.passport_type)?;
    validate_spouses(data)?;
    validate_json_array(&data.family_members, "family_members")?;
    validate_json_array(&data.vehicles, "vehicles")?;
    Ok(())
}

fn value_string(value: &serde_json::Value, key: &str) -> Option<String> {
    value.get(key)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

/// Stored name parts of the spouse / family rows of one employee, by position.
fn stored_row_parts(conn: &Connection, table: &str, employee_id: i64) -> AppResult<Vec<serde_json::Map<String, serde_json::Value>>> {
    let mut stmt = conn.prepare(&format!("SELECT name_parts FROM {table} WHERE employee_id=?1 ORDER BY sort_order,id"))?;
    let rows = stmt.query_map(params![employee_id], |r| r.get::<_, Option<String>>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows.iter().map(|value| crate::names::parts_object(value.as_deref())).collect())
}

/// Resolves the split names of one spouse / family JSON record. Returns the combined
/// names (in `fields` order) and the `name_parts` JSON to store.
fn resolve_row_names(record: &serde_json::Value, stored: Option<&serde_json::Map<String, serde_json::Value>>, fields: &[&str]) -> (Vec<Option<String>>, Option<String>) {
    let sent = crate::names::parts_from_value(record.get("name_parts"));
    let mut parts = serde_json::Map::new();
    let mut names = Vec::new();
    for field in fields {
        let (text, value) = crate::names::resolve_arabic(sent.get(*field), stored.and_then(|s| s.get(*field)), value_string(record, field).as_deref());
        if let Some(value) = value { parts.insert(field.to_string(), value); }
        names.push(text);
    }
    (names, (!parts.is_empty()).then(|| serde_json::Value::Object(parts).to_string()))
}

fn replace_employee_spouses(conn: &Connection, employee_id: i64, spouses_json: &str) -> AppResult<()> {
    let stored = stored_row_parts(conn, "employee_spouses", employee_id)?;
    conn.execute("DELETE FROM employee_spouses WHERE employee_id=?1", params![employee_id])?;
    let spouses: Vec<serde_json::Value> = serde_json::from_str(spouses_json).unwrap_or_default();
    for (index, spouse) in spouses.iter().enumerate() {
        let (names, name_parts) = resolve_row_names(spouse, stored.get(index), &crate::names::SPOUSE_ARABIC);
        conn.execute(
            "INSERT INTO employee_spouses(employee_id,sort_order,civil_id,name,mother_name,gender,birthplace,birthdate,issue_date,expiry_date,issuer,blood_type,marriage_date,national_card_front_path,national_card_back_path,name_parts)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)",
            params![
                employee_id, index as i64,
                value_string(spouse, "civil_id"), names[0], names[1],
                value_string(spouse, "gender"), value_string(spouse, "birthplace"), value_string(spouse, "birthdate"),
                value_string(spouse, "issue_date"), value_string(spouse, "expiry_date"), value_string(spouse, "issuer"),
                value_string(spouse, "blood_type"), value_string(spouse, "marriage_date"),
                value_string(spouse, "national_card_front_path"), value_string(spouse, "national_card_back_path"),
                name_parts,
            ],
        )?;
    }
    // The legacy single-spouse columns mirror the first spouse (reports read them).
    if !spouses.is_empty() {
        conn.execute(
            "UPDATE employees SET spouse_name=(SELECT name FROM employee_spouses WHERE employee_id=?1 AND sort_order=0),
                                  spouse_mother_name=(SELECT mother_name FROM employee_spouses WHERE employee_id=?1 AND sort_order=0)
             WHERE id=?1",
            params![employee_id],
        )?;
    }
    Ok(())
}

fn replace_employee_family_members(conn: &Connection, employee_id: i64, family_json: &str) -> AppResult<()> {
    let stored = stored_row_parts(conn, "employee_family_members", employee_id)?;
    conn.execute("DELETE FROM employee_family_members WHERE employee_id=?1", params![employee_id])?;
    let members: Vec<serde_json::Value> = serde_json::from_str(family_json).unwrap_or_default();
    for (index, member) in members.iter().enumerate() {
        let (names, name_parts) = resolve_row_names(member, stored.get(index), &crate::names::FAMILY_ARABIC);
        conn.execute(
            "INSERT INTO employee_family_members(employee_id,sort_order,civil_id,name,gender,birthplace,birthdate,issue_date,expiry_date,issuer,blood_type,national_card_front_path,national_card_back_path,name_parts)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
            params![
                employee_id, index as i64,
                value_string(member, "civil_id"), names[0], value_string(member, "gender"),
                value_string(member, "birthplace"), value_string(member, "birthdate"), value_string(member, "issue_date"),
                value_string(member, "expiry_date"), value_string(member, "issuer"), value_string(member, "blood_type"),
                value_string(member, "national_card_front_path"), value_string(member, "national_card_back_path"),
                name_parts,
            ],
        )?;
    }
    Ok(())
}

fn replace_employee_vehicles(conn: &Connection, employee_id: i64, vehicles_json: &str) -> AppResult<()> {
    // Registration images are uploaded by their own command. A saved row may only keep a path
    // this employee's vehicles already had (rows can move when one is removed); anything else
    // the form sends is dropped.
    let stored: Vec<String> = {
        let mut stmt = conn.prepare(
            "SELECT annual_front_path FROM employee_vehicles WHERE employee_id=?1 AND annual_front_path IS NOT NULL
             UNION SELECT annual_back_path FROM employee_vehicles WHERE employee_id=?1 AND annual_back_path IS NOT NULL")?;
        let paths = stmt.query_map(params![employee_id], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        paths
    };
    let kept = |vehicle: &serde_json::Value, key: &str| value_string(vehicle, key).filter(|path| stored.contains(path));
    conn.execute("DELETE FROM employee_vehicles WHERE employee_id=?1", params![employee_id])?;
    let vehicles: Vec<serde_json::Value> = serde_json::from_str(vehicles_json).unwrap_or_default();
    for (index, vehicle) in vehicles.iter().enumerate() {
        conn.execute(
            "INSERT INTO employee_vehicles(employee_id,sort_order,plate,brand,type,color,annual_no,issue_date,expiry_date,annual_front_path,annual_back_path,governorate,plate_category,chassis_no,model_year)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
            params![
                employee_id, index as i64,
                value_string(vehicle, "plate"), value_string(vehicle, "brand"), value_string(vehicle, "type"),
                value_string(vehicle, "color"), value_string(vehicle, "annual_no"),
                value_string(vehicle, "issue_date"), value_string(vehicle, "expiry_date"),
                kept(vehicle, "annual_front_path"), kept(vehicle, "annual_back_path"),
                value_string(vehicle, "governorate"), value_string(vehicle, "plate_category"),
                value_string(vehicle, "chassis_no"), value_string(vehicle, "model_year"),
            ],
        )?;
    }
    Ok(())
}

fn replace_employee_repeating_data(conn: &Connection, employee_id: i64, data: &EmployeeData) -> AppResult<()> {
    replace_employee_spouses(conn, employee_id, data.spouses.as_deref().unwrap_or("[]"))?;
    replace_employee_family_members(conn, employee_id, data.family_members.as_deref().unwrap_or("[]"))?;
    replace_employee_vehicles(conn, employee_id, data.vehicles.as_deref().unwrap_or("[]"))?;
    Ok(())
}

pub fn list_employees(conn: &Connection) -> AppResult<Vec<Employee>> {
    let mut stmt = conn.prepare(&format!("SELECT {} FROM employees ORDER BY full_name", EMP_COLS))?;
    let mut result = stmt.query_map([], map_emp)?.collect::<rusqlite::Result<Vec<_>>>()?;
    for employee in &mut result {
        add_employee_full_paths(conn, employee);
    }
    Ok(result)
}

pub fn get_employee(conn: &Connection, id: i64) -> AppResult<Employee> {
    let mut employee = conn.query_row(&format!("SELECT {} FROM employees WHERE id=?1", EMP_COLS), params![id], map_emp)
        .map_err(|_| AppError::NotFound)?;
    add_employee_full_paths(conn, &mut employee);
    Ok(employee)
}

/// Rebuilds the employee's combined names from their parts (see names.rs) and returns the
/// data to save plus the `name_parts` JSON to store beside it.
fn resolve_employee_names(conn: &Connection, id: Option<i64>, d: &EmployeeData) -> AppResult<(EmployeeData, String)> {
    let stored = match id {
        Some(id) => conn.query_row("SELECT name_parts FROM employees WHERE id=?1", params![id], |r| r.get::<_, Option<String>>(0))
            .map_err(|_| AppError::NotFound)?,
        None => None,
    };
    let stored = crate::names::parts_object(stored.as_deref());
    let sent = crate::names::parts_from_value(d.name_parts.as_ref());
    let mut data = d.clone();
    let mut parts = serde_json::Map::new();
    let mut apply = |field: &str, text: Option<String>, passport: bool| -> Option<String> {
        let resolve = if passport { crate::names::resolve_passport } else { crate::names::resolve_arabic };
        let (combined, value) = resolve(sent.get(field), stored.get(field), text.as_deref());
        if let Some(value) = value { parts.insert(field.to_string(), value); }
        combined
    };
    data.full_name = apply("full_name", Some(d.full_name.clone()), false).unwrap_or_default();
    data.mother_name = apply("mother_name", d.mother_name.clone(), false);
    data.residence_head_name = apply("residence_head_name", d.residence_head_name.clone(), false);
    data.passport_name = apply("passport_name", d.passport_name.clone(), true);
    Ok((data, serde_json::Value::Object(parts).to_string()))
}

pub fn create_employee(conn: &Connection, d: &EmployeeData, username: &str) -> AppResult<Employee> {
    assert_permission(conn, username, "employees.create")?;
    let (d, name_parts) = resolve_employee_names(conn, None, d)?;
    let d = &d;
    validate_employee_data(d)?;
    conn.execute("INSERT INTO employees(employee_number,full_name,mother_name,father_birthplace,mother_birthplace,
      gender,birthdate,birthplace,marital_status,blood_type,workplace,job_title,job_grade,
      hire_date,contract_type,department,division,phone,email,
      education_level,specialization,graduation_year,
      civil_id,civil_id_issuer,civil_id_issue_date,civil_id_expiry_date,
      residence_card_no,residence_card_issuer,residence_address,
      ration_card_no,ration_center_name,ration_center_no,ration_card_date,
      passport_no,passport_name,passport_issue_date,passport_expiry_date,
      airport_badge_no,airport_badge_expiry,ministry_badge_no,ministry_badge_expiry,
      vehicle_plate,vehicle_name,vehicle_color_model,vehicle_annual_no,
      spouse_name,spouse_mother_name,spouse_birthdate,marriage_date,
      family_members,notes,is_active,work_type_notes,work_schedule,
      civil_id_birthplace,civil_id_birthdate,civil_id_family_number,passport_type,
      residence_card_issue_date,residence_head_name,residence_form_no,
      airport_badge_issue_date,ministry_badge_issue_date,vehicle_color,vehicle_manufacture_year,vehicle_type,
      vehicle_annual_issue_date,vehicle_annual_expiry_date,vehicles,spouses,appointment_date,
      father_birthdate,mother_birthdate,airport_badge_zones)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,
           ?21,?22,?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34,?35,?36,?37,?38,
           ?39,?40,?41,?42,?43,?44,?45,?46,?47,?48,?49,?50,?51,?52,?53,?54,?55,?56,?57,?58,
           ?59,?60,?61,?62,?63,?64,?65,?66,?67,?68,?69,?70,?71,?72,?73,?74)",
    params![d.employee_number,d.full_name.trim(),d.mother_name,d.father_birthplace,d.mother_birthplace,
      d.gender,d.birthdate,d.birthplace,d.marital_status,d.blood_type,
      d.workplace,d.job_title,d.job_grade,d.hire_date,d.contract_type,d.department,d.division,d.phone,d.email,
      d.education_level,d.specialization,d.graduation_year,
      d.civil_id,d.civil_id_issuer,d.civil_id_issue_date,d.civil_id_expiry_date,
      d.residence_card_no,d.residence_card_issuer,d.residence_address,
      d.ration_card_no,d.ration_center_name,d.ration_center_no,d.ration_card_date,
      d.passport_no,d.passport_name,d.passport_issue_date,d.passport_expiry_date,
      d.airport_badge_no,d.airport_badge_expiry,d.ministry_badge_no,d.ministry_badge_expiry,
      d.vehicle_plate,d.vehicle_name,d.vehicle_color_model,d.vehicle_annual_no,
      d.spouse_name,d.spouse_mother_name,d.spouse_birthdate,d.marriage_date,
      d.family_members.as_deref().unwrap_or("[]"),d.notes,d.is_active.unwrap_or(1),d.work_type_notes,d.work_schedule,
      d.civil_id_birthplace,d.civil_id_birthdate,d.civil_id_family_number,d.passport_type,
      d.residence_card_issue_date,d.residence_head_name,d.residence_form_no,
      d.airport_badge_issue_date,d.ministry_badge_issue_date,d.vehicle_color,d.vehicle_manufacture_year,d.vehicle_type,
      d.vehicle_annual_issue_date,d.vehicle_annual_expiry_date,d.vehicles.as_deref().unwrap_or("[]"),
      d.spouses.as_deref().unwrap_or("[]"),d.appointment_date,d.father_birthdate,d.mother_birthdate,d.airport_badge_zones])?;
    let id = conn.last_insert_rowid();
    conn.execute("UPDATE employees SET name_parts=?1 WHERE id=?2", params![name_parts, id])?;
    replace_employee_repeating_data(conn, id, d)?;
    log_activity(conn, username, "CREATE_EMPLOYEE", Some("employee"), Some(id), Some(d.full_name.trim()), None);
    get_employee(conn, id)
}

pub fn update_employee(conn: &Connection, id: i64, d: &EmployeeData, username: &str) -> AppResult<Employee> {
    assert_permission(conn, username, "employees.edit")?;
    let (d, name_parts) = resolve_employee_names(conn, Some(id), d)?;
    let d = &d;
    validate_employee_data(d)?;
    conn.execute("UPDATE employees SET employee_number=?1,full_name=?2,mother_name=?3,father_birthplace=?4,
      mother_birthplace=?5,gender=?6,birthdate=?7,birthplace=?8,marital_status=?9,blood_type=?10,
      workplace=?11,job_title=?12,job_grade=?13,hire_date=?14,contract_type=?15,
      department=?16,division=?17,phone=?18,email=?19,education_level=?20,specialization=?21,graduation_year=?22,
      civil_id=?23,civil_id_issuer=?24,civil_id_issue_date=?25,civil_id_expiry_date=?26,
      residence_card_no=?27,residence_card_issuer=?28,residence_address=?29,
      ration_card_no=?30,ration_center_name=?31,ration_center_no=?32,ration_card_date=?33,
      passport_no=?34,passport_name=?35,passport_issue_date=?36,passport_expiry_date=?37,
      airport_badge_no=?38,airport_badge_expiry=?39,ministry_badge_no=?40,ministry_badge_expiry=?41,
      vehicle_plate=?42,vehicle_name=?43,vehicle_color_model=?44,vehicle_annual_no=?45,
      spouse_name=?46,spouse_mother_name=?47,spouse_birthdate=?48,marriage_date=?49,
      family_members=?50,notes=?51,is_active=?52,work_type_notes=?53,work_schedule=?54,
      civil_id_birthplace=?55,civil_id_birthdate=?56,civil_id_family_number=?57,passport_type=?58,
      residence_card_issue_date=?59,residence_head_name=?60,residence_form_no=?61,
      airport_badge_issue_date=?62,ministry_badge_issue_date=?63,
      vehicle_color=?64,vehicle_manufacture_year=?65,vehicle_type=?66,
      vehicle_annual_issue_date=?67,vehicle_annual_expiry_date=?68,
      vehicles=?69,spouses=?70,appointment_date=?71,father_birthdate=?72,mother_birthdate=?73,
      airport_badge_zones=?74,updated_at=datetime('now') WHERE id=?75",
    params![d.employee_number,d.full_name.trim(),d.mother_name,d.father_birthplace,d.mother_birthplace,
      d.gender,d.birthdate,d.birthplace,d.marital_status,d.blood_type,
      d.workplace,d.job_title,d.job_grade,d.hire_date,d.contract_type,d.department,d.division,d.phone,d.email,
      d.education_level,d.specialization,d.graduation_year,
      d.civil_id,d.civil_id_issuer,d.civil_id_issue_date,d.civil_id_expiry_date,
      d.residence_card_no,d.residence_card_issuer,d.residence_address,
      d.ration_card_no,d.ration_center_name,d.ration_center_no,d.ration_card_date,
      d.passport_no,d.passport_name,d.passport_issue_date,d.passport_expiry_date,
      d.airport_badge_no,d.airport_badge_expiry,d.ministry_badge_no,d.ministry_badge_expiry,
      d.vehicle_plate,d.vehicle_name,d.vehicle_color_model,d.vehicle_annual_no,
      d.spouse_name,d.spouse_mother_name,d.spouse_birthdate,d.marriage_date,
      d.family_members.as_deref().unwrap_or("[]"),d.notes,d.is_active.unwrap_or(1),d.work_type_notes,d.work_schedule,
      d.civil_id_birthplace,d.civil_id_birthdate,d.civil_id_family_number,d.passport_type,
      d.residence_card_issue_date,d.residence_head_name,d.residence_form_no,
      d.airport_badge_issue_date,d.ministry_badge_issue_date,d.vehicle_color,d.vehicle_manufacture_year,d.vehicle_type,
      d.vehicle_annual_issue_date,d.vehicle_annual_expiry_date,d.vehicles.as_deref().unwrap_or("[]"),
      d.spouses.as_deref().unwrap_or("[]"),d.appointment_date,d.father_birthdate,d.mother_birthdate,d.airport_badge_zones,id])?;
    conn.execute("UPDATE employees SET name_parts=?1 WHERE id=?2", params![name_parts, id])?;
    replace_employee_repeating_data(conn, id, d)?;
    log_activity(conn, username, "UPDATE_EMPLOYEE", Some("employee"), Some(id), Some(d.full_name.trim()), None);
    get_employee(conn, id)
}

/// Names whose automatic split is unsure, for the "مراجعة الأسماء" screen.
pub fn list_name_review(conn: &Connection, username: &str) -> AppResult<Vec<crate::names::ReviewItem>> {
    assert_permission(conn, username, "employees.edit")?;
    Ok(crate::names::list_review(conn)?)
}

/// Saves the corrected parts of one reviewed name and clears its review flag.
pub fn save_name_review(conn: &Connection, employee_id: i64, owner: &str, index: i64, field: &str, parts: &serde_json::Value, username: &str) -> AppResult<String> {
    assert_permission(conn, username, "employees.edit")?;
    let combined = crate::names::save_review(conn, employee_id, owner, index, field, parts).map_err(AppError::Validation)?;
    log_activity(conn, username, "REVIEW_NAME", Some("employee"), Some(employee_id), Some(&format!("{owner}/{field}: {combined}")), None);
    Ok(combined)
}

pub fn delete_employee(conn: &Connection, id: i64, username: &str) -> AppResult<()> {
    assert_permission(conn, username, "employees.delete")?;
    let name: String = conn.query_row("SELECT full_name FROM employees WHERE id=?1", params![id], |r| r.get(0))
        .unwrap_or_default();
    conn.execute("DELETE FROM employees WHERE id=?1", params![id])?;
    if conn.changes() == 0 { return Err(AppError::NotFound); }
    crate::scanner::remove_metadata_prefix(conn,&format!("Files/Employees/{id}/"))?;
    std::fs::remove_dir_all(storage_path(conn).join("Files").join("Employees").join(id.to_string())).ok();
    log_activity(conn, username, "DELETE_EMPLOYEE", Some("employee"), Some(id), Some(&name), None);
    Ok(())
}

pub fn upload_employee_photo(conn: &Connection, employee_id: i64, source_path: &str) -> AppResult<String> {
    ensure_storage_layout(conn)?;
    let previous: Option<String> = conn.query_row(
        "SELECT photo_path FROM employees WHERE id=?1", params![employee_id], |r| r.get(0)
    ).map_err(|_| AppError::NotFound)?;
    let dir = crate::services::storage_path(conn)
        .join("Files")
        .join("Employees")
        .join(employee_id.to_string())
        .join("Photo");
    let rel = crate::files::copy_validated_upload(conn, source_path, &dir,
        &format!("Files/Employees/{}/Photo", employee_id), false, true, crate::files::MAX_IMAGE_SIZE)?;
    conn.execute("UPDATE employees SET photo_path=?1 WHERE id=?2", params![rel, employee_id])?;
    if let Some(previous) = previous {
        if let Ok(path) = crate::files::safe_relative_path(&previous) {
            crate::scanner::remove_replaced(conn, source_path, path);
        }
    }
    Ok(rel)
}

// ── Grade history ──────────────────────────────────────────────────────────
pub fn list_grade_history(conn: &Connection, employee_id: i64) -> AppResult<Vec<GradeHistory>> {
    let mut stmt = conn.prepare(
        "SELECT id,employee_id,grade,job_title,effective_date,notes,created_at FROM grade_history WHERE employee_id=?1 ORDER BY effective_date DESC"
    )?;
    let result = stmt.query_map(params![employee_id], |r| Ok(GradeHistory {
        id:r.get(0)?,employee_id:r.get(1)?,grade:r.get(2)?,job_title:r.get(3)?,
        effective_date:r.get(4)?,notes:r.get(5)?,created_at:r.get(6)?,
    }))?.collect::<rusqlite::Result<_>>()?;
    Ok(result)
}

pub fn add_grade_history(conn: &Connection, employee_id: i64, data: &GradeHistoryData, username: &str) -> AppResult<GradeHistory> {
    assert_permission(conn, username, "employees.edit")?;
    conn.execute(
        "INSERT INTO grade_history(employee_id,grade,job_title,effective_date,notes) VALUES(?1,?2,?3,?4,?5)",
        params![employee_id, data.grade, data.job_title, data.effective_date, data.notes]
    )?;
    let id = conn.last_insert_rowid();
    log_activity(conn, username, "ADD_GRADE", Some("employee"), Some(employee_id), Some(&data.grade), None);
    conn.query_row("SELECT id,employee_id,grade,job_title,effective_date,notes,created_at FROM grade_history WHERE id=?1",
        params![id], |r| Ok(GradeHistory { id:r.get(0)?,employee_id:r.get(1)?,grade:r.get(2)?,
            job_title:r.get(3)?,effective_date:r.get(4)?,notes:r.get(5)?,created_at:r.get(6)? }))
        .map_err(Into::into)
}

pub fn delete_grade_history(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute("DELETE FROM grade_history WHERE id=?1", params![id])?;
    Ok(())
}

// ── General docs ───────────────────────────────────────────────────────────
fn add_general_doc_employees(conn: &Connection, doc: &mut GeneralDoc) -> AppResult<()> {
    let mut stmt = conn.prepare(
        "SELECT e.id,e.full_name
         FROM general_doc_employees gde
         JOIN employees e ON e.id=gde.employee_id
         WHERE gde.general_doc_id=?1
         ORDER BY e.full_name"
    )?;
    let linked = stmt.query_map(params![doc.id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    doc.employee_ids = linked.iter().map(|(id, _)| *id).collect();
    doc.employee_names = linked.into_iter().map(|(_, name)| name).collect();
    Ok(())
}

fn replace_general_doc_employees(conn: &Connection, doc_id: i64, employee_ids: &[i64]) -> AppResult<()> {
    conn.execute("DELETE FROM general_doc_employees WHERE general_doc_id=?1", params![doc_id])?;
    let mut ids = employee_ids.to_vec();
    ids.sort_unstable();
    ids.dedup();
    for employee_id in ids {
        conn.execute(
            "INSERT INTO general_doc_employees(general_doc_id,employee_id)
             SELECT ?1,?2 WHERE EXISTS(SELECT 1 FROM employees WHERE id=?2)",
            params![doc_id, employee_id],
        )?;
    }
    Ok(())
}

fn validate_document_data(data: &GeneralDocData) -> AppResult<()> {
    if data.title.chars().count() > 300 {
        return Err(AppError::Validation("Enter a valid document title".into()));
    }
    if data.employee_ids.len() > 1000 {
        return Err(AppError::Validation("Too many linked employees".into()));
    }
    let effect_type = data.hr_effect_type.as_deref().unwrap_or("none");
    if !matches!(effect_type, "none" | "appreciation" | "penalty") {
        return Err(AppError::Validation("Invalid HR effect type".into()));
    }
    if data.hr_effect_months < 0 || data.hr_effect_days < 0 {
        return Err(AppError::Validation("HR effect months and days must be non-negative".into()));
    }
    Ok(())
}

fn add_general_doc_attachments(conn: &Connection, doc: &mut GeneralDoc) -> AppResult<()> {
    let mut stmt = conn.prepare(
        "SELECT file_path FROM general_doc_attachments WHERE general_doc_id=?1 ORDER BY sort_order,id"
    )?;
    doc.attachment_paths = stmt.query_map(params![doc.id], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(())
}

pub fn list_general_docs(conn: &Connection) -> AppResult<Vec<GeneralDoc>> {
    let mut stmt = conn.prepare(
        "SELECT id,title,doc_type,doc_number,issue_date,issuer,doc_count,margin,is_internal_memo,
                hr_effect_type,hr_affects_promotion,hr_affects_allowance,hr_effect_months,hr_effect_days,
                notes,file_path,created_at
         FROM general_docs ORDER BY created_at DESC"
    )?;
    let mut result: Vec<GeneralDoc> = stmt.query_map([], |r| Ok(GeneralDoc {
        id:r.get(0)?,title:r.get(1)?,doc_type:r.get(2)?,doc_number:r.get(3)?,
        issue_date:r.get(4)?,issuer:r.get(5)?,doc_count:r.get(6)?,margin:r.get(7)?,
        is_internal_memo:r.get(8)?,hr_effect_type:r.get(9)?,
        hr_affects_promotion:r.get::<_, i64>(10)? == 1,hr_affects_allowance:r.get::<_, i64>(11)? == 1,
        hr_effect_months:r.get(12)?,hr_effect_days:r.get(13)?,
        notes:r.get(14)?,file_path:r.get(15)?,created_at:r.get(16)?,
        employee_ids:Vec::new(),employee_names:Vec::new(),attachment_paths:Vec::new(),
    }))?.collect::<rusqlite::Result<_>>()?;
    for doc in &mut result {
        add_general_doc_employees(conn, &mut *doc)?;
        add_general_doc_attachments(conn, &mut *doc)?;
    }
    Ok(result)
}

fn get_general_doc(conn: &Connection, id: i64) -> AppResult<GeneralDoc> {
    let mut doc = conn.query_row(
        "SELECT id,title,doc_type,doc_number,issue_date,issuer,doc_count,margin,is_internal_memo,
                hr_effect_type,hr_affects_promotion,hr_affects_allowance,hr_effect_months,hr_effect_days,
                notes,file_path,created_at
         FROM general_docs WHERE id=?1",
        params![id], |r| Ok(GeneralDoc { id:r.get(0)?,title:r.get(1)?,doc_type:r.get(2)?,doc_number:r.get(3)?,
            issue_date:r.get(4)?,issuer:r.get(5)?,doc_count:r.get(6)?,margin:r.get(7)?,
            is_internal_memo:r.get(8)?,hr_effect_type:r.get(9)?,
            hr_affects_promotion:r.get::<_, i64>(10)? == 1,hr_affects_allowance:r.get::<_, i64>(11)? == 1,
            hr_effect_months:r.get(12)?,hr_effect_days:r.get(13)?,
            notes:r.get(14)?,file_path:r.get(15)?,created_at:r.get(16)?,
            employee_ids:Vec::new(),employee_names:Vec::new(),attachment_paths:Vec::new() }))
        .map_err(|_| AppError::NotFound)?;
    add_general_doc_employees(conn, &mut doc)?;
    add_general_doc_attachments(conn, &mut doc)?;
    Ok(doc)
}

pub fn create_general_doc(conn: &Connection, data: &GeneralDocData, username: &str) -> AppResult<GeneralDoc> {
    assert_permission(conn, username, "documents.manage")?;
    validate_document_data(data)?;
    let tx = conn.unchecked_transaction()?;
    tx.execute("INSERT INTO general_docs(title,doc_type,doc_number,issue_date,issuer,doc_count,margin,is_internal_memo,hr_effect_type,hr_affects_promotion,hr_affects_allowance,hr_effect_months,hr_effect_days,notes) VALUES(?1,NULL,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
        params![data.title.trim(),data.doc_number,data.issue_date,data.issuer,data.doc_count,data.margin,data.is_internal_memo,
            data.hr_effect_type.as_deref().unwrap_or("none"),data.hr_affects_promotion,data.hr_affects_allowance,data.hr_effect_months,data.hr_effect_days,data.notes])?;
    let id = tx.last_insert_rowid();
    replace_general_doc_employees(&tx, id, &data.employee_ids)?;
    log_activity(&tx, username, "CREATE_DOC", Some("general_doc"), Some(id), Some(data.title.trim()), None);
    tx.commit()?;
    get_general_doc(conn, id)
}

pub fn update_general_doc(conn: &Connection, id: i64, data: &GeneralDocData, username: &str) -> AppResult<GeneralDoc> {
    assert_permission(conn, username, "documents.manage")?;
    validate_document_data(data)?;
    let tx = conn.unchecked_transaction()?;
    // The HR effect fields are no longer edited from the UI. They are intentionally left out of
    // this UPDATE so that values already stored on existing documents are preserved.
    tx.execute("UPDATE general_docs SET title=?1,doc_type=NULL,doc_number=?2,issue_date=?3,issuer=?4,doc_count=?5,margin=?6,is_internal_memo=?7,notes=?8,updated_at=datetime('now') WHERE id=?9",
        params![data.title.trim(),data.doc_number,data.issue_date,data.issuer,data.doc_count,data.margin,data.is_internal_memo,
            data.notes,id])?;
    if tx.changes() == 0 { return Err(AppError::NotFound); }
    replace_general_doc_employees(&tx, id, &data.employee_ids)?;
    log_activity(&tx, username, "UPDATE_DOC", Some("general_doc"), Some(id), Some(data.title.trim()), None);
    tx.commit()?;
    get_general_doc(conn, id)
}

pub fn delete_general_doc(conn: &Connection, id: i64, username: &str) -> AppResult<()> {
    assert_permission(conn, username, "documents.delete")?;
    let title: String = conn.query_row("SELECT title FROM general_docs WHERE id=?1", params![id], |r| r.get(0)).unwrap_or_default();
    conn.execute("DELETE FROM general_doc_attachments WHERE general_doc_id=?1", params![id])?;
    conn.execute("DELETE FROM general_doc_employees WHERE general_doc_id=?1", params![id])?;
    conn.execute("DELETE FROM general_docs WHERE id=?1", params![id])?;
    crate::scanner::remove_metadata_prefix(conn,&format!("Files/GeneralDocs/{id}/"))?;
    std::fs::remove_dir_all(storage_path(conn).join("Files").join("GeneralDocs").join(id.to_string())).ok();
    log_activity(conn, username, "DELETE_DOC", Some("general_doc"), Some(id), Some(&title), None);
    Ok(())
}

pub fn upload_general_doc_file(conn: &Connection, doc_id: i64, source_path: &str) -> AppResult<String> {
    ensure_storage_layout(conn)?;
    let document_exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM general_docs WHERE id=?1)",
        params![doc_id],
        |r| r.get(0),
    )?;
    if !document_exists { return Err(AppError::NotFound); }
    let attachment_count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM general_doc_attachments WHERE general_doc_id=?1",
        params![doc_id],
        |r| r.get(0),
    )?;
    if attachment_count >= 20 {
        return Err(AppError::Validation("Maximum 20 attachments per document".into()));
    }
    let dir  = crate::services::storage_path(conn)
        .join("Files")
        .join("GeneralDocs")
        .join(doc_id.to_string());
    let rel = crate::files::copy_validated_upload(conn, source_path, &dir,
        &format!("Files/GeneralDocs/{}", doc_id), true, false, crate::files::MAX_DOCUMENT_SIZE)?;
    conn.execute(
        "INSERT INTO general_doc_attachments(general_doc_id,file_path,sort_order)
         VALUES(?1,?2,COALESCE((SELECT MAX(sort_order)+1 FROM general_doc_attachments WHERE general_doc_id=?1),1))",
        params![doc_id, rel],
    )?;
    conn.execute("UPDATE general_docs SET updated_at=datetime('now') WHERE id=?1", params![doc_id])?;
    Ok(rel)
}

pub fn delete_general_doc_attachment(conn: &Connection, doc_id: i64, relative_path: &str) -> AppResult<()> {
    let stored_path: String = conn.query_row(
        "SELECT file_path FROM general_doc_attachments WHERE general_doc_id=?1 AND file_path=?2",
        params![doc_id, relative_path],
        |r| r.get(0),
    ).map_err(|_| AppError::NotFound)?;
    let normalized = stored_path.replace('\\', "/");
    let expected_prefix = format!("Files/GeneralDocs/{}/", doc_id);
    if !normalized.starts_with(&expected_prefix) || normalized.contains("../") {
        return Err(AppError::Validation("Invalid attachment path".into()));
    }
    conn.execute(
        "DELETE FROM general_doc_attachments WHERE general_doc_id=?1 AND file_path=?2",
        params![doc_id, stored_path],
    )?;
    conn.execute("UPDATE general_docs SET updated_at=datetime('now') WHERE id=?1", params![doc_id])?;
    crate::scanner::cleanup_metadata_file(conn, &stored_path);
    Ok(())
}

fn move_attachment(
    conn: &Connection,
    table: &str,
    parent_column: &str,
    doc_id: i64,
    relative_path: &str,
    direction: &str,
) -> AppResult<()> {
    if !matches!(direction, "up" | "down") {
        return Err(AppError::Validation("Invalid attachment move direction".into()));
    }
    let tx = conn.unchecked_transaction()?;
    let (id, order): (i64, i64) = tx.query_row(
        &format!("SELECT id,sort_order FROM {table} WHERE {parent_column}=?1 AND file_path=?2"),
        params![doc_id, relative_path],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).map_err(|_| AppError::NotFound)?;
    let operator = if direction == "up" { "<" } else { ">" };
    let ordering = if direction == "up" { "DESC" } else { "ASC" };
    let neighbor: Option<(i64, i64)> = tx.query_row(
        &format!(
            "SELECT id,sort_order FROM {table}
             WHERE {parent_column}=?1 AND (sort_order {operator} ?2 OR (sort_order=?2 AND id {operator} ?3))
             ORDER BY sort_order {ordering},id {ordering} LIMIT 1"
        ),
        params![doc_id, order, id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    ).optional()?;
    let Some((neighbor_id, neighbor_order)) = neighbor else { return Ok(()); };
    tx.execute(&format!("UPDATE {table} SET sort_order=?1 WHERE id=?2"), params![neighbor_order, id])?;
    tx.execute(&format!("UPDATE {table} SET sort_order=?1 WHERE id=?2"), params![order, neighbor_id])?;
    tx.commit()?;
    Ok(())
}

pub fn move_general_doc_attachment(conn: &Connection, doc_id: i64, relative_path: &str, direction: &str) -> AppResult<()> {
    move_attachment(conn, "general_doc_attachments", "general_doc_id", doc_id, relative_path, direction)
}

// ── Outgoing docs ──────────────────────────────────────────────────────────
fn add_outgoing_doc_details(conn: &Connection, doc: &mut GeneralDoc) -> AppResult<()> {
    let mut employee_stmt = conn.prepare(
        "SELECT e.id,e.full_name
         FROM outgoing_doc_employees ode
         JOIN employees e ON e.id=ode.employee_id
         WHERE ode.outgoing_doc_id=?1
         ORDER BY e.full_name"
    )?;
    let linked = employee_stmt.query_map(params![doc.id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    doc.employee_ids = linked.iter().map(|(id, _)| *id).collect();
    doc.employee_names = linked.into_iter().map(|(_, name)| name).collect();

    let mut attachment_stmt = conn.prepare(
        "SELECT file_path FROM outgoing_doc_attachments WHERE outgoing_doc_id=?1 ORDER BY sort_order,id"
    )?;
    doc.attachment_paths = attachment_stmt.query_map(params![doc.id], |r| r.get(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(())
}

fn replace_outgoing_doc_employees(conn: &Connection, doc_id: i64, employee_ids: &[i64]) -> AppResult<()> {
    conn.execute("DELETE FROM outgoing_doc_employees WHERE outgoing_doc_id=?1", params![doc_id])?;
    let mut ids = employee_ids.to_vec();
    ids.sort_unstable();
    ids.dedup();
    for employee_id in ids {
        conn.execute(
            "INSERT INTO outgoing_doc_employees(outgoing_doc_id,employee_id)
             SELECT ?1,?2 WHERE EXISTS(SELECT 1 FROM employees WHERE id=?2)",
            params![doc_id, employee_id],
        )?;
    }
    Ok(())
}

pub fn list_outgoing_docs(conn: &Connection) -> AppResult<Vec<GeneralDoc>> {
    let mut stmt = conn.prepare(
        "SELECT id,title,doc_type,doc_number,issue_date,issuer,doc_count,margin,is_internal_memo,notes,created_at FROM outgoing_docs ORDER BY created_at DESC"
    )?;
    let mut result: Vec<GeneralDoc> = stmt.query_map([], |r| Ok(GeneralDoc {
        id:r.get(0)?,title:r.get(1)?,doc_type:r.get(2)?,doc_number:r.get(3)?,
        issue_date:r.get(4)?,issuer:r.get(5)?,doc_count:r.get(6)?,margin:r.get(7)?,
        is_internal_memo:r.get(8)?,hr_effect_type:Some("none".into()),
        hr_affects_promotion:false,hr_affects_allowance:false,hr_effect_months:0,hr_effect_days:0,
        notes:r.get(9)?,file_path:None,created_at:r.get(10)?,
        employee_ids:Vec::new(),employee_names:Vec::new(),attachment_paths:Vec::new(),
    }))?.collect::<rusqlite::Result<_>>()?;
    for doc in &mut result { add_outgoing_doc_details(conn, &mut *doc)?; }
    Ok(result)
}

fn get_outgoing_doc(conn: &Connection, id: i64) -> AppResult<GeneralDoc> {
    let mut doc = conn.query_row(
        "SELECT id,title,doc_type,doc_number,issue_date,issuer,doc_count,margin,is_internal_memo,notes,created_at FROM outgoing_docs WHERE id=?1",
        params![id], |r| Ok(GeneralDoc {
            id:r.get(0)?,title:r.get(1)?,doc_type:r.get(2)?,doc_number:r.get(3)?,
            issue_date:r.get(4)?,issuer:r.get(5)?,doc_count:r.get(6)?,margin:r.get(7)?,
            is_internal_memo:r.get(8)?,hr_effect_type:Some("none".into()),
            hr_affects_promotion:false,hr_affects_allowance:false,hr_effect_months:0,hr_effect_days:0,
            notes:r.get(9)?,file_path:None,created_at:r.get(10)?,
            employee_ids:Vec::new(),employee_names:Vec::new(),attachment_paths:Vec::new(),
        })
    ).map_err(|_| AppError::NotFound)?;
    add_outgoing_doc_details(conn, &mut doc)?;
    Ok(doc)
}

pub fn create_outgoing_doc(conn: &Connection, data: &GeneralDocData, username: &str) -> AppResult<GeneralDoc> {
    assert_permission(conn, username, "documents.manage")?;
    validate_document_data(data)?;
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "INSERT INTO outgoing_docs(title,doc_type,doc_number,issue_date,issuer,doc_count,margin,is_internal_memo,notes) VALUES(?1,NULL,?2,?3,?4,?5,?6,?7,?8)",
        params![data.title.trim(),data.doc_number,data.issue_date,data.issuer,data.doc_count,data.margin,data.is_internal_memo,data.notes],
    )?;
    let id = tx.last_insert_rowid();
    replace_outgoing_doc_employees(&tx, id, &data.employee_ids)?;
    log_activity(&tx, username, "CREATE_OUTGOING_DOC", Some("outgoing_doc"), Some(id), Some(data.title.trim()), None);
    tx.commit()?;
    get_outgoing_doc(conn, id)
}

pub fn update_outgoing_doc(conn: &Connection, id: i64, data: &GeneralDocData, username: &str) -> AppResult<GeneralDoc> {
    assert_permission(conn, username, "documents.manage")?;
    validate_document_data(data)?;
    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "UPDATE outgoing_docs SET title=?1,doc_type=NULL,doc_number=?2,issue_date=?3,issuer=?4,doc_count=?5,margin=?6,is_internal_memo=?7,notes=?8,updated_at=datetime('now') WHERE id=?9",
        params![data.title.trim(),data.doc_number,data.issue_date,data.issuer,data.doc_count,data.margin,data.is_internal_memo,data.notes,id],
    )?;
    if tx.changes() == 0 { return Err(AppError::NotFound); }
    replace_outgoing_doc_employees(&tx, id, &data.employee_ids)?;
    log_activity(&tx, username, "UPDATE_OUTGOING_DOC", Some("outgoing_doc"), Some(id), Some(data.title.trim()), None);
    tx.commit()?;
    get_outgoing_doc(conn, id)
}

pub fn delete_outgoing_doc(conn: &Connection, id: i64, username: &str) -> AppResult<()> {
    assert_permission(conn, username, "documents.delete")?;
    let title: String = conn.query_row("SELECT title FROM outgoing_docs WHERE id=?1", params![id], |r| r.get(0))
        .unwrap_or_default();
    conn.execute("DELETE FROM outgoing_doc_attachments WHERE outgoing_doc_id=?1", params![id])?;
    conn.execute("DELETE FROM outgoing_doc_employees WHERE outgoing_doc_id=?1", params![id])?;
    conn.execute("DELETE FROM outgoing_docs WHERE id=?1", params![id])?;
    crate::scanner::remove_metadata_prefix(conn,&format!("Files/OutgoingDocs/{id}/"))?;
    std::fs::remove_dir_all(storage_path(conn).join("Files").join("OutgoingDocs").join(id.to_string())).ok();
    log_activity(conn, username, "DELETE_OUTGOING_DOC", Some("outgoing_doc"), Some(id), Some(&title), None);
    Ok(())
}

pub fn upload_outgoing_doc_file(conn: &Connection, doc_id: i64, source_path: &str) -> AppResult<String> {
    ensure_storage_layout(conn)?;
    let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM outgoing_docs WHERE id=?1)", params![doc_id], |r| r.get(0))?;
    if !exists { return Err(AppError::NotFound); }
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM outgoing_doc_attachments WHERE outgoing_doc_id=?1", params![doc_id], |r| r.get(0))?;
    if count >= 20 { return Err(AppError::Validation("Maximum 20 attachments per document".into())); }
    let dir = storage_path(conn).join("Files").join("OutgoingDocs").join(doc_id.to_string());
    let rel = crate::files::copy_validated_upload(conn, source_path, &dir,
        &format!("Files/OutgoingDocs/{}", doc_id), true, false, crate::files::MAX_DOCUMENT_SIZE)?;
    conn.execute(
        "INSERT INTO outgoing_doc_attachments(outgoing_doc_id,file_path,sort_order)
         VALUES(?1,?2,COALESCE((SELECT MAX(sort_order)+1 FROM outgoing_doc_attachments WHERE outgoing_doc_id=?1),1))",
        params![doc_id, rel],
    )?;
    conn.execute("UPDATE outgoing_docs SET updated_at=datetime('now') WHERE id=?1", params![doc_id])?;
    Ok(rel)
}

pub fn delete_outgoing_doc_attachment(conn: &Connection, doc_id: i64, relative_path: &str) -> AppResult<()> {
    let stored_path: String = conn.query_row(
        "SELECT file_path FROM outgoing_doc_attachments WHERE outgoing_doc_id=?1 AND file_path=?2",
        params![doc_id, relative_path], |r| r.get(0),
    ).map_err(|_| AppError::NotFound)?;
    let normalized = stored_path.replace('\\', "/");
    if !normalized.starts_with(&format!("Files/OutgoingDocs/{}/", doc_id)) || normalized.contains("../") {
        return Err(AppError::Validation("Invalid attachment path".into()));
    }
    conn.execute("DELETE FROM outgoing_doc_attachments WHERE outgoing_doc_id=?1 AND file_path=?2", params![doc_id, stored_path])?;
    conn.execute("UPDATE outgoing_docs SET updated_at=datetime('now') WHERE id=?1", params![doc_id])?;
    crate::scanner::cleanup_metadata_file(conn, &stored_path);
    Ok(())
}

pub fn move_outgoing_doc_attachment(conn: &Connection, doc_id: i64, relative_path: &str, direction: &str) -> AppResult<()> {
    move_attachment(conn, "outgoing_doc_attachments", "outgoing_doc_id", doc_id, relative_path, direction)
}

// ── Activity log ───────────────────────────────────────────────────────────
pub fn list_activity_log(conn: &Connection, limit: i64) -> AppResult<Vec<ActivityLog>> {
    let limit = limit.clamp(1, 1000);
    let mut stmt = conn.prepare(
        "SELECT id,user_id,username,role,action,target_type,target_id,target_name,result,details,created_at FROM activity_log ORDER BY id DESC LIMIT ?1"
    )?;
    let result = stmt.query_map(params![limit], |r| Ok(ActivityLog {
        id:r.get(0)?,user_id:r.get(1)?,username:r.get(2)?,role:r.get(3)?,action:r.get(4)?,target_type:r.get(5)?,
        target_id:r.get(6)?,target_name:r.get(7)?,result:r.get(8)?,details:r.get(9)?,created_at:r.get(10)?,
    }))?.collect::<rusqlite::Result<_>>()?;
    Ok(result)
}

// ── Users ──────────────────────────────────────────────────────────────────
pub fn list_users(conn: &Connection) -> AppResult<Vec<User>> {
    let mut stmt = conn.prepare("SELECT id,username,role,must_change_password,created_at FROM users ORDER BY id")?;
    let result = stmt.query_map([], |r| {
        let username: String = r.get(1)?; let role: String = r.get(2)?;
        let is_master = username == "sysadmin" || role == "system_admin";
        Ok(User {
            id:r.get(0)?, username, role: role.clone(), is_master,
            permissions: role_permissions(&role).iter().map(|p| p.to_string()).collect(),
            must_change_password:r.get(3)?, created_at:r.get(4)?,
        })
    })?.collect::<rusqlite::Result<_>>()?;
    Ok(result)
}

pub fn create_user(conn: &Connection, caller: &str, data: &UserData) -> AppResult<User> {
    assert_permission(conn, caller, "users.manage")?;
    let username = data.username.trim();
    if username.len() < 3 || username.len() > 64 || !username.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')) {
        return Err(AppError::Validation("Username must be 3-64 letters, numbers, dots, dashes, or underscores".into()));
    }
    if !valid_role(&data.role) { return Err(AppError::Validation("Invalid role".into())); }
    if data.role == "system_admin" {
        assert_permission(conn, caller, "users.assign_system_admin")?;
    }
    validate_new_password(&data.password)?;
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))?;
    if count >= 10 { return Err(AppError::Validation("Max 10 users".into())); }
    conn.execute("INSERT INTO users(username,password,role,must_change_password) VALUES(?1,?2,?3,1)",
        params![data.username.trim(), hash_password(&data.password)?, data.role])?;
    let id = conn.last_insert_rowid();
    log_activity(conn, caller, "CREATE_USER", Some("user"), Some(id), Some(data.username.trim()), None);
    conn.query_row("SELECT id,username,role,must_change_password,created_at FROM users WHERE id=?1", params![id], |r| {
        let username: String = r.get(1)?; let role: String = r.get(2)?;
        let is_master = username == "sysadmin" || role == "system_admin";
        Ok(User {
            id:r.get(0)?, username, role: role.clone(), is_master,
            permissions: role_permissions(&role).iter().map(|p| p.to_string()).collect(),
            must_change_password:r.get(3)?, created_at:r.get(4)?,
        })
    }).map_err(Into::into)
}

pub fn delete_user(conn: &Connection, caller: &str, id: i64) -> AppResult<()> {
    assert_permission(conn, caller, "users.manage")?;
    let (username, role): (String, String) = conn.query_row(
        "SELECT username,role FROM users WHERE id=?1", params![id], |r| Ok((r.get(0)?, r.get(1)?))
    ).map_err(|_| AppError::NotFound)?;
    if username == "sysadmin" { return Err(AppError::Validation("Cannot delete sysadmin".into())); }
    if role == "system_admin" { assert_permission(conn, caller, "users.assign_system_admin")?; }
    conn.execute("DELETE FROM users WHERE id=?1", params![id])?;
    log_activity(conn, caller, "DELETE_USER", Some("user"), Some(id), Some(&username), None);
    Ok(())
}

// ── Settings ───────────────────────────────────────────────────────────────
pub fn get_storage_path(conn: &Connection) -> AppResult<String> {
    ensure_storage_layout(conn).ok();
    Ok(storage_path(conn).to_string_lossy().into_owned())
}

pub fn update_user_role(conn: &Connection, caller: &str, id: i64, role: &str) -> AppResult<User> {
    assert_permission(conn, caller, "users.manage")?;
    if !valid_role(role) { return Err(AppError::Validation("Invalid role".into())); }
    let (username, old_role): (String, String) = conn.query_row(
        "SELECT username,role FROM users WHERE id=?1", params![id], |r| Ok((r.get(0)?, r.get(1)?))
    ).map_err(|_| AppError::NotFound)?;
    if username == "sysadmin" || old_role == "system_admin" || role == "system_admin" {
        assert_permission(conn, caller, "users.assign_system_admin")?;
    }
    if username == "sysadmin" && role != "system_admin" {
        return Err(AppError::Validation("Cannot change sysadmin role".into()));
    }
    conn.execute("UPDATE users SET role=?1 WHERE id=?2", params![role, id])?;
    log_activity(conn, caller, "CHANGE_USER_ROLE", Some("user"), Some(id), Some(&username), Some(&format!("{old_role} -> {role}")));
    list_users(conn)?.into_iter().find(|u| u.id == id).ok_or(AppError::NotFound)
}

pub fn reset_user_password(conn: &Connection, caller: &str, id: i64, password: &str) -> AppResult<()> {
    assert_permission(conn, caller, "users.manage")?;
    validate_new_password(password)?;
    let (username, role): (String, String) = conn.query_row(
        "SELECT username,role FROM users WHERE id=?1", params![id], |r| Ok((r.get(0)?, r.get(1)?))
    ).map_err(|_| AppError::NotFound)?;
    if role == "system_admin" { assert_permission(conn, caller, "users.assign_system_admin")?; }
    conn.execute("UPDATE users SET password=?1,must_change_password=1 WHERE id=?2", params![hash_password(password)?, id])?;
    log_activity(conn, caller, "RESET_USER_PASSWORD", Some("user"), Some(id), Some(&username), None);
    Ok(())
}

#[cfg(test)]
mod auth_tests {
    use super::*;

    fn auth_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("
            CREATE TABLE users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL UNIQUE,
                password TEXT NOT NULL,
                role TEXT NOT NULL,
                must_change_password INTEGER NOT NULL DEFAULT 0,
                created_at TEXT DEFAULT (datetime('now'))
            );
            CREATE TABLE activity_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                username TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'unknown',
                action TEXT NOT NULL,
                target_type TEXT,
                target_id INTEGER,
                target_name TEXT,
                result TEXT NOT NULL DEFAULT 'Success',
                details TEXT,
                created_at TEXT DEFAULT (datetime('now'))
            );
        ").unwrap();
        conn
    }

    #[test]
    fn bcrypt_hashes_use_unique_salts() {
        let first = hash_password("correct horse battery staple").unwrap();
        let second = hash_password("correct horse battery staple").unwrap();
        assert_ne!(first, second);
        assert!(verify_password("correct horse battery staple", &first).unwrap());
    }

    #[test]
    fn legacy_sha256_login_is_upgraded_without_removing_user() {
        let conn = auth_db();
        conn.execute(
            "INSERT INTO users(username,password,role) VALUES('legacy',?1,'archive_officer')",
            params![legacy_hash_password("old-password")],
        ).unwrap();

        let user = login(&conn, "legacy", "old-password").unwrap();
        let stored: String = conn.query_row(
            "SELECT password FROM users WHERE username='legacy'", [], |r| r.get(0)
        ).unwrap();

        assert_eq!(user.username, "legacy");
        assert!(stored.starts_with("$2"));
        assert!(verify_password("old-password", &stored).unwrap());
    }

    #[test]
    fn password_change_clears_mandatory_change_flag() {
        let conn = auth_db();
        conn.execute(
            "INSERT INTO users(username,password,role,must_change_password) VALUES('sysadmin',?1,'system_admin',1)",
            params![hash_password("temporary-password").unwrap()],
        ).unwrap();

        let user = change_password(&conn, "sysadmin", "temporary-password", "new-secure-password").unwrap();

        assert!(!user.must_change_password);
        assert!(login(&conn, "sysadmin", "temporary-password").is_err());
        assert!(login(&conn, "sysadmin", "new-secure-password").is_ok());
    }

    #[test]
    fn viewer_can_view_and_print_but_cannot_download_export_or_modify() {
        let conn = auth_db();
        conn.execute(
            "INSERT INTO users(username,password,role) VALUES('viewer',?1,'viewer')",
            params![hash_password("viewer-password").unwrap()],
        ).unwrap();
        assert!(assert_permission(&conn, "viewer", "documents.print").is_ok());
        assert!(assert_permission(&conn, "viewer", "documents.view").is_ok());
        assert!(assert_permission(&conn, "viewer", "documents.download").is_err());
        assert!(assert_permission(&conn, "viewer", "documents.upload").is_err());
        assert!(assert_permission(&conn, "viewer", "documents.delete").is_err());
        assert!(assert_permission(&conn, "viewer", "reports.export").is_err());
    }

    #[test]
    fn archive_admin_cannot_assign_system_admin() {
        let conn = auth_db();
        conn.execute(
            "INSERT INTO users(username,password,role) VALUES('archiveadmin',?1,'archive_admin')",
            params![hash_password("admin-password").unwrap()],
        ).unwrap();
        assert!(assert_permission(&conn, "archiveadmin", "users.manage").is_ok());
        assert!(assert_permission(&conn, "archiveadmin", "users.assign_system_admin").is_err());
        // A restore replaces the users table, so it would let an Archive Admin promote themselves.
        assert!(assert_permission(&conn, "archiveadmin", "backups.restore").is_err());
    }

    #[test]
    fn archive_admin_cannot_delete_system_admin() {
        let conn = auth_db();
        for (name, role) in [("archiveadmin2", "archive_admin"), ("secondadmin", "system_admin"), ("officer1", "archive_officer")] {
            conn.execute(
                "INSERT INTO users(username,password,role) VALUES(?1,?2,?3)",
                params![name, hash_password("admin-password").unwrap(), role],
            ).unwrap();
        }
        let id = |name: &str| conn.query_row("SELECT id FROM users WHERE username=?1", params![name], |r| r.get::<_, i64>(0)).unwrap();
        assert!(matches!(delete_user(&conn, "archiveadmin2", id("secondadmin")), Err(AppError::Unauthorized)));
        assert!(delete_user(&conn, "archiveadmin2", id("officer1")).is_ok());
        let remaining: i64 = conn.query_row("SELECT COUNT(*) FROM users WHERE username='secondadmin'", [], |r| r.get(0)).unwrap();
        assert_eq!(remaining, 1);
    }

    #[test]
    fn repeated_failed_logins_lock_the_username_temporarily() {
        let conn = auth_db();
        conn.execute(
            "INSERT INTO users(username,password,role) VALUES('lockme',?1,'viewer')",
            params![hash_password("correct-password").unwrap()],
        ).unwrap();
        for _ in 0..LOGIN_MAX_FAILURES {
            assert!(matches!(login(&conn, "lockme", "wrong-password"), Err(AppError::Unauthorized)));
        }
        // Even the correct password is refused while locked.
        assert!(matches!(login(&conn, "LockMe", "correct-password"), Err(AppError::Validation(_))));
        clear_login_failures(&conn, "lockme");
        assert!(login(&conn, "lockme", "correct-password").is_ok());
    }

    #[test]
    fn lockout_minutes_use_arabic_number_agreement() {
        assert_eq!(arabic_minutes(1), "دقيقة واحدة");
        assert_eq!(arabic_minutes(2), "دقيقتين");
        assert_eq!(arabic_minutes(5), "5 دقائق");
        assert_eq!(arabic_minutes(11), "11 دقيقة");
    }

    #[test]
    fn successful_login_resets_failure_count() {
        let conn = auth_db();
        conn.execute(
            "INSERT INTO users(username,password,role) VALUES('resetme',?1,'viewer')",
            params![hash_password("correct-password").unwrap()],
        ).unwrap();
        for _ in 0..LOGIN_MAX_FAILURES - 1 {
            assert!(login(&conn, "resetme", "wrong-password").is_err());
        }
        assert!(login(&conn, "resetme", "correct-password").is_ok());
        assert!(login(&conn, "resetme", "wrong-password").is_err());
        assert!(login(&conn, "resetme", "correct-password").is_ok());
    }

    #[test]
    fn archive_officer_cannot_delete_or_manage_system() {
        let permissions = role_permissions("archive_officer");
        assert!(permissions.contains(&"employees.edit"));
        assert!(permissions.contains(&"documents.upload"));
        assert!(permissions.contains(&"documents.print"));
        assert!(!permissions.contains(&"employees.delete"));
        assert!(!permissions.contains(&"documents.delete"));
        assert!(!permissions.contains(&"users.manage"));
        assert!(!permissions.contains(&"settings.manage"));
        assert!(!permissions.contains(&"backups.manage"));
    }
}

pub fn get_backup_path(conn: &Connection) -> AppResult<String> {
    ensure_backup_layout(conn).ok();
    Ok(backup_path(conn).to_string_lossy().into_owned())
}

fn get_setting(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    conn.query_row("SELECT value FROM app_settings WHERE key=?1", params![key], |r| r.get(0))
        .optional()
        .map_err(Into::into)
}

/// The automatic-backup password, unwrapped from DPAPI. A plain-text value left by an older
/// release is re-saved protected the first time it is read.
fn auto_backup_password(conn: &Connection) -> AppResult<String> {
    let Some(stored) = get_setting(conn, "auto_backup_password")?.filter(|value| !value.is_empty()) else {
        return Ok(String::new());
    };
    let secret = crate::secure::unprotect_secret(&stored)?;
    if secret.legacy && !secret.value.is_empty() {
        set_setting(conn, "auto_backup_password", &crate::secure::protect_secret(&secret.value)?)?;
    }
    Ok(secret.value)
}

fn set_auto_backup_password(conn: &Connection, password: &str) -> AppResult<()> {
    set_setting(conn, "auto_backup_password", &crate::secure::protect_secret(password)?)
}

fn set_setting(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO app_settings(key,value) VALUES(?1,?2)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn setting_bool(conn: &Connection, key: &str) -> AppResult<bool> {
    Ok(matches!(get_setting(conn, key)?.as_deref(), Some("1") | Some("true")))
}

pub fn get_auto_backup_settings(conn: &Connection, user: &str) -> AppResult<AutoBackupSettings> {
    assert_permission(conn, user, "backups.manage")?;
    Ok(AutoBackupSettings {
        daily_enabled: setting_bool(conn, "auto_backup_daily_enabled")?,
        weekly_enabled: setting_bool(conn, "auto_backup_weekly_enabled")?,
        monthly_enabled: setting_bool(conn, "auto_backup_monthly_enabled")?,
        has_password: get_setting(conn, "auto_backup_password")?.is_some_and(|value| !value.is_empty()),
        last_daily: get_setting(conn, "auto_backup_last_daily")?,
        last_weekly: get_setting(conn, "auto_backup_last_weekly")?,
        last_monthly: get_setting(conn, "auto_backup_last_monthly")?,
        last_daily_path: get_setting(conn, "auto_backup_last_daily_path")?,
        last_weekly_path: get_setting(conn, "auto_backup_last_weekly_path")?,
        last_monthly_path: get_setting(conn, "auto_backup_last_monthly_path")?,
    })
}

pub fn set_auto_backup_settings(conn: &Connection, user: &str, data: &AutoBackupSettingsData) -> AppResult<AutoBackupSettings> {
    assert_permission(conn, user, "backups.manage")?;
    let existing_password = get_setting(conn, "auto_backup_password")?.unwrap_or_default();
    // Moves a legacy plain-text password to DPAPI even when only the toggles change.
    if !existing_password.is_empty() { auto_backup_password(conn).ok(); }
    let password = data.password.as_deref().unwrap_or("").trim();
    if (data.daily_enabled || data.weekly_enabled || data.monthly_enabled) && password.is_empty() && existing_password.is_empty() {
        return Err(AppError::Validation("Enter an automatic backup password before enabling automatic backups".into()));
    }
    if !password.is_empty() {
        validate_new_password(password)?;
        set_auto_backup_password(conn, password)?;
    }
    set_setting(conn, "auto_backup_daily_enabled", if data.daily_enabled { "1" } else { "0" })?;
    set_setting(conn, "auto_backup_weekly_enabled", if data.weekly_enabled { "1" } else { "0" })?;
    set_setting(conn, "auto_backup_monthly_enabled", if data.monthly_enabled { "1" } else { "0" })?;
    log_activity(conn, user, "CHANGE_SETTING", Some("settings"), None, Some("automatic_backups"), None);
    get_auto_backup_settings(conn, user)
}

const BACKUP_MAGIC_V1: &[u8; 9] = b"AUTOHRBK1";
const BACKUP_MAGIC_V2: &[u8; 9] = b"AUTOHRBK2";
const BACKUP_FORMAT_VERSION: u32 = 2;
const MAX_BACKUP_SIZE: u64 = 1024 * 1024 * 1024;
const MAX_BACKUP_FILES: usize = 100_000;
type AuditSnapshotRow = (
    Option<i64>, String, String, String, Option<String>, Option<i64>,
    Option<String>, String, Option<String>, Option<String>,
);

#[derive(Debug, Serialize, Deserialize)]
struct BackupManifest {
    format_version: u32,
    created_at: String,
    files: Vec<BackupManifestFile>,
}

#[derive(Debug, Serialize, Deserialize)]
struct BackupManifestFile {
    path: String,
    size: u64,
    sha256: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackupProgress {
    pub percent: u8,
    pub message: String,
}

pub(crate) fn backup_progress(percent: u8, message: &str) -> BackupProgress {
    BackupProgress { percent, message: message.to_string() }
}

fn backup_key(password: &str, salt: &[u8]) -> AppResult<[u8; 32]> {
    validate_new_password(password)?;
    let mut key = [0u8; 32];
    Argon2::default().hash_password_into(password.as_bytes(), salt, &mut key).map_err(|e| AppError::Other(e.to_string()))?;
    Ok(key)
}

fn encrypt_backup(plaintext: &[u8], password: &str, magic: &[u8; 9]) -> AppResult<Vec<u8>> {
    let mut salt = [0u8; 16]; let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut salt); OsRng.fill_bytes(&mut nonce_bytes);
    let key = backup_key(password, &salt)?;
    let ciphertext = Aes256Gcm::new_from_slice(&key).map_err(|e| AppError::Other(e.to_string()))?
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext).map_err(|e| AppError::Other(e.to_string()))?;
    let mut output = Vec::new();
    output.extend_from_slice(magic); output.extend_from_slice(&salt); output.extend_from_slice(&nonce_bytes); output.extend_from_slice(&ciphertext);
    Ok(output)
}

fn decrypt_backup(encrypted: &[u8], password: &str) -> AppResult<(bool, Vec<u8>)> {
    let header = BACKUP_MAGIC_V2.len() + 16 + 12;
    if encrypted.len() <= header {
        return Err(AppError::Validation("This is not a valid encrypted AutoHR backup".into()));
    }
    let magic = if &encrypted[..9] == BACKUP_MAGIC_V2 {
        BACKUP_MAGIC_V2
    } else if &encrypted[..9] == BACKUP_MAGIC_V1 {
        BACKUP_MAGIC_V1
    } else {
        return Err(AppError::Validation("This is not a valid encrypted AutoHR backup".into()));
    };
    let key = backup_key(password, &encrypted[magic.len()..magic.len() + 16])?;
    let plaintext = Aes256Gcm::new_from_slice(&key).map_err(|e| AppError::Other(e.to_string()))?
        .decrypt(Nonce::from_slice(&encrypted[magic.len() + 16..header]), &encrypted[header..])
        .map_err(|_| AppError::Validation("The backup password is incorrect or the backup is damaged".into()))?;
    Ok((magic == BACKUP_MAGIC_V1, plaintext))
}

pub(crate) fn sha256_file(path: &Path) -> AppResult<(u64, String)> {
    let mut file = File::open(path).map_err(|e| AppError::Other(e.to_string()))?;
    let mut hash = Sha256::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|e| AppError::Other(e.to_string()))?;
        if read == 0 { break; }
        size += read as u64;
        hash.update(&buffer[..read]);
    }
    Ok((size, hex::encode(hash.finalize())))
}

fn collect_backup_files(root: &Path, relative: &Path, files: &mut Vec<(String, PathBuf)>) -> AppResult<()> {
    let current = root.join(relative);
    if !current.exists() { return Ok(()); }
    for entry in std::fs::read_dir(&current).map_err(|e| AppError::Other(e.to_string()))? {
        let entry = entry.map_err(|e| AppError::Other(e.to_string()))?;
        let child_relative = relative.join(entry.file_name());
        if relative.as_os_str().is_empty() && matches!(entry.file_name().to_str(), Some("Temp" | "Exports")) {
            continue;
        }
        if entry.file_type().map_err(|e| AppError::Other(e.to_string()))?.is_dir() {
            collect_backup_files(root, &child_relative, files)?;
        } else {
            if files.len() >= MAX_BACKUP_FILES {
                return Err(AppError::Validation("Too many files to include in one backup".into()));
            }
            let archive_path = format!("Data/{}", child_relative.to_string_lossy().replace('\\', "/"));
            files.push((archive_path, entry.path()));
        }
    }
    Ok(())
}

fn collect_relative_file_paths(root: &Path, relative: &Path, files: &mut Vec<String>) -> AppResult<()> {
    for entry in std::fs::read_dir(root.join(relative)).map_err(|e| AppError::Other(e.to_string()))? {
        let entry = entry.map_err(|e| AppError::Other(e.to_string()))?;
        let child_relative = relative.join(entry.file_name());
        if entry.file_type().map_err(|e| AppError::Other(e.to_string()))?.is_dir() {
            collect_relative_file_paths(root, &child_relative, files)?;
        } else {
            files.push(child_relative.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(())
}

pub(crate) fn create_backup_archive(
    conn: &Connection,
    password: &str,
    path: &Path,
    progress: &mut dyn FnMut(BackupProgress),
) -> AppResult<()> {
    progress(backup_progress(3, "جاري تجهيز ملف النسخة الاحتياطية..."));
    let work_dir = crate::paths::data_root();
    std::fs::create_dir_all(&work_dir).map_err(|e| AppError::Other(e.to_string()))?;
    let db_snapshot = tempfile::NamedTempFile::new_in(&work_dir).map_err(|e| AppError::Other(e.to_string()))?;
    progress(backup_progress(8, "جاري نسخ قاعدة البيانات..."));
    conn.backup(rusqlite::MAIN_DB, db_snapshot.path(), None::<fn(rusqlite::backup::Progress)>)?;
    let archive = tempfile::NamedTempFile::new_in(&work_dir).map_err(|e| AppError::Other(e.to_string()))?;
    let mut zip = zip::ZipWriter::new(archive.reopen().map_err(|e| AppError::Other(e.to_string()))?);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let mut files = vec![("database.db".to_string(), db_snapshot.path().to_path_buf())];
    progress(backup_progress(15, "جاري جمع الملفات والمرفقات..."));
    collect_backup_files(&storage_path(conn), Path::new(""), &mut files)?;
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let mut manifest_files = Vec::with_capacity(files.len());
    let total_files = files.len().max(1);
    for (index, (archive_path, source_path)) in files.into_iter().enumerate() {
        let file_percent = 20 + (((index as u64) * 60) / (total_files as u64)) as u8;
        progress(backup_progress(file_percent.min(80), "جاري ضغط الملفات داخل النسخة..."));
        let (size, sha256) = sha256_file(&source_path)?;
        zip.start_file(&archive_path, options).map_err(|e| AppError::Other(e.to_string()))?;
        let mut source = File::open(&source_path).map_err(|e| AppError::Other(e.to_string()))?;
        std::io::copy(&mut source, &mut zip).map_err(|e| AppError::Other(e.to_string()))?;
        manifest_files.push(BackupManifestFile { path: archive_path, size, sha256 });
    }
    progress(backup_progress(84, "جاري كتابة فهرس النسخة..."));
    let manifest = BackupManifest {
        format_version: BACKUP_FORMAT_VERSION,
        created_at: chrono::Utc::now().to_rfc3339(),
        files: manifest_files,
    };
    zip.start_file("manifest.json", options).map_err(|e| AppError::Other(e.to_string()))?;
    zip.write_all(&serde_json::to_vec_pretty(&manifest).map_err(|e| AppError::Other(e.to_string()))?)
        .map_err(|e| AppError::Other(e.to_string()))?;
    zip.finish().map_err(|e| AppError::Other(e.to_string()))?;
    progress(backup_progress(90, "جاري تشفير النسخة الاحتياطية..."));
    let plaintext = std::fs::read(archive.path()).map_err(|e| AppError::Other(e.to_string()))?;
    // Verify bytes read back from the destination volume before publishing the backup.
    let mut pending = tempfile::NamedTempFile::new_in(path.parent().ok_or_else(|| AppError::Validation("Invalid backup destination".into()))?)
        .map_err(|e| AppError::Other(e.to_string()))?;
    pending.write_all(&encrypt_backup(&plaintext, password, BACKUP_MAGIC_V2)?)
        .map_err(|e| AppError::Other(e.to_string()))?;
    pending.as_file().sync_all().map_err(|e| AppError::Other(e.to_string()))?;
    progress(backup_progress(94, "جاري فحص SHA-256 وفك الضغط وتجربة الاستعادة المؤقتة..."));
    verify_written_backup(pending.path(), password)?;
    pending.persist_noclobber(path).map_err(|e| AppError::Other(e.to_string()))?;
    progress(backup_progress(100, "اكتمل إنشاء النسخة الاحتياطية"));
    Ok(())
}

pub(crate) fn create_backup_at(
    conn: &Connection,
    user: &str,
    password: &str,
    category: &str,
    progress: &mut dyn FnMut(BackupProgress),
) -> AppResult<String> {
    assert_permission(conn, user, "backups.manage")?;
    ensure_backup_layout(conn)?;
    let now = chrono::Local::now();
    let dir = backup_path(conn).join(category).join(now.format("%Y").to_string());
    std::fs::create_dir_all(&dir).map_err(|e| AppError::Other(e.to_string()))?;
    let path = dir.join(format!("autohr_{}_{}.autohrbak", category.to_lowercase(), now.format("%Y-%m-%d_%H%M%S")));
    create_backup_archive(conn, password, &path, progress)?;
    log_activity(conn, user, "CREATE_BACKUP", Some("backup"), None, path.file_name().and_then(|n| n.to_str()), None);
    Ok(path.to_string_lossy().into_owned())
}

pub fn create_backup_with_progress<F>(conn: &Connection, user: &str, password: &str, mut progress: F) -> AppResult<String>
where
    F: FnMut(BackupProgress),
{
    create_backup_at(conn, user, password, "Manual", &mut progress)
}

fn create_automatic_backup(
    conn: &Connection,
    password: &str,
    category: &str,
    progress: &mut dyn FnMut(BackupProgress),
) -> AppResult<String> {
    ensure_backup_layout(conn)?;
    let now = chrono::Local::now();
    let dir = backup_path(conn).join(category).join(now.format("%Y").to_string());
    std::fs::create_dir_all(&dir).map_err(|e| AppError::Other(e.to_string()))?;
    let path = dir.join(format!("cnsarch_{}_{}.autohrbak", category.to_lowercase(), now.format("%Y-%m-%d_%H%M%S")));
    create_backup_archive(conn, password, &path, progress)?;
    log_activity(conn, "system", "CREATE_AUTO_BACKUP", Some("backup"), None, path.file_name().and_then(|n| n.to_str()), Some(category));
    Ok(path.to_string_lossy().into_owned())
}

fn stored_backup_file_exists(conn: &Connection, path_key: &str) -> AppResult<bool> {
    Ok(get_setting(conn, path_key)?
        .as_deref()
        .map(Path::new)
        .is_some_and(Path::is_file))
}

fn dated_automatic_backup_exists(conn: &Connection, category: &str, marker: &str) -> AppResult<bool> {
    let year = marker.get(..4).unwrap_or(marker);
    let dir = backup_path(conn).join(category).join(year);
    if !dir.is_dir() {
        return Ok(false);
    }
    let prefix = if category == "Monthly" {
        format!("cnsarch_{}_{}", category.to_lowercase(), marker)
    } else {
        format!("cnsarch_{}_{}_", category.to_lowercase(), marker)
    };
    for entry in std::fs::read_dir(&dir).map_err(|e| AppError::Other(e.to_string()))? {
        let entry = entry.map_err(|e| AppError::Other(e.to_string()))?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue; };
        if entry.path().is_file() && name.starts_with(&prefix) && name.ends_with(".autohrbak") {
            return Ok(true);
        }
    }
    Ok(false)
}

fn automatic_backup_is_current(conn: &Connection, date_key: &str, path_key: &str, marker: &str, category: &str) -> AppResult<bool> {
    if get_setting(conn, date_key)?.as_deref() != Some(marker) {
        return Ok(false);
    }
    if stored_backup_file_exists(conn, path_key)? {
        return Ok(true);
    }
    dated_automatic_backup_exists(conn, category, marker)
}

fn latest_data_change_activity_id(conn: &Connection) -> AppResult<Option<i64>> {
    conn.query_row(
        "SELECT MAX(id) FROM activity_log
         WHERE result='Success'
           AND action NOT IN (
             'LOGIN','LOGOUT','VIEW_DOCUMENT','DOWNLOAD_DOCUMENT','PRINT_DOCUMENT',
             'CREATE_BACKUP','CREATE_AUTO_BACKUP'
           )
           AND (target_type IS NOT NULL OR action='SCAN_DOCUMENT')",
        [],
        |row| row.get(0),
    ).map_err(Into::into)
}

fn parse_setting_i64(conn: &Connection, key: &str) -> AppResult<Option<i64>> {
    Ok(get_setting(conn, key)?.and_then(|value| value.parse::<i64>().ok()))
}

fn last_automatic_backup_activity_id(conn: &Connection, category: &str) -> AppResult<Option<i64>> {
    conn.query_row(
        "SELECT MAX(id) FROM activity_log
         WHERE result='Success' AND action='CREATE_AUTO_BACKUP' AND details=?1",
        params![category],
        |row| row.get(0),
    ).map_err(Into::into)
}

fn last_recorded_backup_change_id(conn: &Connection, change_key: &str, category: &str) -> AppResult<Option<i64>> {
    match parse_setting_i64(conn, change_key)? {
        Some(id) => Ok(Some(id)),
        None => last_automatic_backup_activity_id(conn, category),
    }
}

fn automatic_backup_needs_creation(
    conn: &Connection,
    date_key: &str,
    path_key: &str,
    change_key: &str,
    marker: &str,
    category: &str,
    latest_change_id: Option<i64>,
) -> AppResult<bool> {
    let Some(latest_change_id) = latest_change_id else {
        return Ok(false);
    };
    if last_recorded_backup_change_id(conn, change_key, category)?
        .is_some_and(|backup_change_id| backup_change_id >= latest_change_id)
    {
        return Ok(false);
    }
    Ok(!automatic_backup_is_current(conn, date_key, path_key, marker, category)? || latest_change_id > 0)
}

fn create_and_record_automatic_backup(
    conn: &Connection,
    password: &str,
    category: &str,
    date_key: &str,
    path_key: &str,
    change_key: &str,
    marker: &str,
    latest_change_id: i64,
    progress: &mut dyn FnMut(BackupProgress),
) -> AppResult<String> {
    let path = create_automatic_backup(conn, password, category, progress)?;
    set_setting(conn, date_key, marker)?;
    set_setting(conn, path_key, &path)?;
    set_setting(conn, change_key, &latest_change_id.to_string())?;
    Ok(path)
}

pub fn run_due_automatic_backups_with_progress<F>(conn: &Connection, mut progress: F) -> AppResult<Vec<String>>
where
    F: FnMut(BackupProgress),
{
    let password = auto_backup_password(conn)?;
    if password.is_empty() {
        return Ok(Vec::new());
    }

    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let iso_week = chrono::Local::now().iso_week();
    let week = format!("{}-W{:02}", iso_week.year(), iso_week.week());
    let month = chrono::Local::now().format("%Y-%m").to_string();
    let latest_change_id = latest_data_change_activity_id(conn)?;
    let mut created = Vec::new();

    if setting_bool(conn, "auto_backup_daily_enabled")?
        && automatic_backup_needs_creation(
            conn,
            "auto_backup_last_daily",
            "auto_backup_last_daily_path",
            "auto_backup_last_daily_change_id",
            &today,
            "Daily",
            latest_change_id,
        )?
    {
        progress(backup_progress(2, "جاري إنشاء النسخة اليومية التلقائية..."));
        create_and_record_automatic_backup(
            conn,
            &password,
            "Daily",
            "auto_backup_last_daily",
            "auto_backup_last_daily_path",
            "auto_backup_last_daily_change_id",
            &today,
            latest_change_id.unwrap_or_default(),
            &mut progress,
        )?;
        created.push("يومي".to_string());
    }

    if setting_bool(conn, "auto_backup_weekly_enabled")?
        && automatic_backup_needs_creation(
            conn,
            "auto_backup_last_weekly",
            "auto_backup_last_weekly_path",
            "auto_backup_last_weekly_change_id",
            &week,
            "Weekly",
            latest_change_id,
        )?
    {
        progress(backup_progress(2, "جاري إنشاء النسخة الأسبوعية التلقائية..."));
        create_and_record_automatic_backup(
            conn,
            &password,
            "Weekly",
            "auto_backup_last_weekly",
            "auto_backup_last_weekly_path",
            "auto_backup_last_weekly_change_id",
            &week,
            latest_change_id.unwrap_or_default(),
            &mut progress,
        )?;
        created.push("أسبوعي".to_string());
    }

    if setting_bool(conn, "auto_backup_monthly_enabled")?
        && automatic_backup_needs_creation(
            conn,
            "auto_backup_last_monthly",
            "auto_backup_last_monthly_path",
            "auto_backup_last_monthly_change_id",
            &month,
            "Monthly",
            latest_change_id,
        )?
    {
        progress(backup_progress(2, "جاري إنشاء النسخة الشهرية التلقائية..."));
        create_and_record_automatic_backup(
            conn,
            &password,
            "Monthly",
            "auto_backup_last_monthly",
            "auto_backup_last_monthly_path",
            "auto_backup_last_monthly_change_id",
            &month,
            latest_change_id.unwrap_or_default(),
            &mut progress,
        )?;
        created.push("شهري".to_string());
    }

    Ok(created)
}

fn validate_database(path: &Path) -> AppResult<()> {
    let source_conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    validate_database_connection(&source_conn)
}

fn validate_database_connection(source_conn: &Connection) -> AppResult<()> {
    source_conn.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
        .and_then(|result| if result == "ok" { Ok(result) } else { Err(rusqlite::Error::InvalidQuery) })?;
    let required_tables: i64 = source_conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('users','employees','company_config','app_settings','activity_log')",
        [], |r| r.get(0),
    ).map_err(|_| AppError::Validation("Backup is from an unsupported AutoHR version".into()))?;
    if required_tables != 5 { return Err(AppError::Validation("Backup is missing required AutoHR data".into())); }
    let foreign_key_errors: i64 = source_conn.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |r| r.get(0))
        .map_err(|_| AppError::Validation("Backup relationships could not be validated".into()))?;
    if foreign_key_errors > 0 { return Err(AppError::Validation("Backup contains inconsistent relationships".into())); }
    let invalid_roles: i64 = source_conn.query_row(
        "SELECT COUNT(*) FROM users WHERE role NOT IN ('system_admin','archive_admin','archive_officer','viewer')", [], |r| r.get(0)
    ).map_err(|_| AppError::Validation("Backup is from an unsupported AutoHR version".into()))?;
    if invalid_roles > 0 { return Err(AppError::Validation("Backup contains unsupported roles".into())); }
    Ok(())
}

fn validate_backup_references(database_path: &Path, staging: &Path) -> AppResult<()> {
    let conn = Connection::open(database_path)?;
    let mut references = Vec::<String>::new();
    let metadata_columns: Vec<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(document_metadata)")?;
        let columns = stmt.query_map([], |r| r.get::<_, String>(1))?.collect::<rusqlite::Result<_>>()?;
        columns
    };
    // Older backups have no scanner columns; current backups must contain both image versions.
    for column in ["original_path", "processed_path"] {
        if metadata_columns.iter().any(|name| name == column) {
            let mut stmt = conn.prepare(&format!("SELECT {column} FROM document_metadata WHERE {column} IS NOT NULL"))?;
            references.extend(stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?);
        }
    }
    if metadata_columns.iter().any(|name| name == "parent_path") {
        let mut stmt = conn.prepare("SELECT stored_path FROM document_metadata WHERE parent_path IS NOT NULL")?;
        references.extend(stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?);
    }
    // Registration images per vehicle exist from schema v3 on.
    let vehicle_columns: Vec<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(employee_vehicles)")?;
        let columns = stmt.query_map([], |r| r.get::<_, String>(1))?.collect::<rusqlite::Result<_>>()?;
        columns
    };
    for column in ["annual_front_path", "annual_back_path"] {
        if vehicle_columns.iter().any(|name| name == column) {
            let mut stmt = conn.prepare(&format!("SELECT {column} FROM employee_vehicles WHERE {column} IS NOT NULL"))?;
            references.extend(stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?);
        }
    }
    for query in [
        "SELECT logo_path FROM company_config WHERE logo_path IS NOT NULL",
        "SELECT photo_path FROM employees WHERE photo_path IS NOT NULL",
        "SELECT civil_id_front_path FROM employees WHERE civil_id_front_path IS NOT NULL",
        "SELECT civil_id_back_path FROM employees WHERE civil_id_back_path IS NOT NULL",
        "SELECT residence_card_front_path FROM employees WHERE residence_card_front_path IS NOT NULL",
        "SELECT residence_card_back_path FROM employees WHERE residence_card_back_path IS NOT NULL",
        "SELECT airport_badge_front_path FROM employees WHERE airport_badge_front_path IS NOT NULL",
        "SELECT airport_badge_back_path FROM employees WHERE airport_badge_back_path IS NOT NULL",
        "SELECT ministry_badge_front_path FROM employees WHERE ministry_badge_front_path IS NOT NULL",
        "SELECT ministry_badge_back_path FROM employees WHERE ministry_badge_back_path IS NOT NULL",
        "SELECT national_card_front_path FROM employee_spouses WHERE national_card_front_path IS NOT NULL",
        "SELECT national_card_back_path FROM employee_spouses WHERE national_card_back_path IS NOT NULL",
        "SELECT national_card_front_path FROM employee_family_members WHERE national_card_front_path IS NOT NULL",
        "SELECT national_card_back_path FROM employee_family_members WHERE national_card_back_path IS NOT NULL",
        "SELECT file_path FROM employee_attachments",
        "SELECT file_path FROM general_docs WHERE file_path IS NOT NULL",
        "SELECT file_path FROM general_doc_attachments",
        "SELECT file_path FROM outgoing_doc_attachments",
    ] {
        let mut stmt = conn.prepare(query)?;
        references.extend(stmt.query_map([], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?);
    }
    for query in [
        "SELECT attachment_paths FROM employees",
        "SELECT passport_attachment_paths FROM employees",
        "SELECT ration_card_attachment_paths FROM employees",
    ] {
        let mut stmt = conn.prepare(query)?;
        for json in stmt.query_map([], |row| row.get::<_, Option<String>>(0))? {
            if let Some(json) = json? {
                let paths: Vec<String> = serde_json::from_str(&json)
                    .map_err(|_| AppError::Validation("Backup contains invalid attachment metadata".into()))?;
                references.extend(paths);
            }
        }
    }
    for reference in references {
        let relative = crate::files::safe_relative_path(&reference)?;
        if !staging.join("Data").join(relative).is_file() {
            return Err(AppError::Validation(format!("Backup is missing referenced file {reference}")));
        }
    }
    Ok(())
}

fn extract_and_validate_backup(plaintext: &[u8], staging: &Path) -> AppResult<BackupManifest> {
    std::fs::create_dir_all(staging.join("Data")).map_err(|e| AppError::Other(e.to_string()))?;
    let cursor = std::io::Cursor::new(plaintext);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|_| AppError::Validation("Backup archive is damaged".into()))?;
    if archive.len() > MAX_BACKUP_FILES + 1 {
        return Err(AppError::Validation("Backup contains too many files".into()));
    }
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|_| AppError::Validation("Backup archive is damaged".into()))?;
        let enclosed = entry.enclosed_name().ok_or_else(|| AppError::Validation("Backup contains an unsafe path".into()))?;
        let destination = staging.join(enclosed);
        if entry.is_dir() {
            std::fs::create_dir_all(&destination).map_err(|e| AppError::Other(e.to_string()))?;
            continue;
        }
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent).map_err(|e| AppError::Other(e.to_string()))?;
        }
        let mut output = File::create(&destination).map_err(|e| AppError::Other(e.to_string()))?;
        std::io::copy(&mut entry, &mut output).map_err(|e| AppError::Other(e.to_string()))?;
    }
    let manifest: BackupManifest = serde_json::from_slice(
        &std::fs::read(staging.join("manifest.json")).map_err(|_| AppError::Validation("Backup manifest is missing".into()))?
    ).map_err(|_| AppError::Validation("Backup manifest is invalid".into()))?;
    if manifest.format_version != BACKUP_FORMAT_VERSION {
        return Err(AppError::Validation("Backup format is not supported".into()));
    }
    if manifest.files.len() > MAX_BACKUP_FILES {
        return Err(AppError::Validation("Backup contains too many files".into()));
    }
    let manifest_paths: HashSet<&str> = manifest.files.iter().map(|item| item.path.as_str()).collect();
    if manifest_paths.len() != manifest.files.len() || !manifest_paths.contains("database.db") {
        return Err(AppError::Validation("Backup manifest contains invalid or duplicate entries".into()));
    }
    let mut extracted = Vec::new();
    collect_relative_file_paths(staging, Path::new(""), &mut extracted)?;
    for path in extracted {
        if path != "manifest.json" && !manifest_paths.contains(path.as_str()) {
            return Err(AppError::Validation(format!("Backup contains unlisted file {path}")));
        }
    }
    for item in &manifest.files {
        let relative = crate::files::safe_relative_path(&item.path)?;
        let path = staging.join(relative);
        let (size, sha256) = sha256_file(&path)?;
        if size != item.size || sha256 != item.sha256 {
            return Err(AppError::Validation(format!("Backup integrity check failed for {}", item.path)));
        }
    }
    validate_database(&staging.join("database.db"))?;
    validate_backup_references(&staging.join("database.db"), staging)?;
    trial_restore_database(&staging.join("database.db"))?;
    Ok(manifest)
}

// Exercise the real SQLite restore API in isolation before touching live data.
fn trial_restore_database(source: &Path) -> AppResult<()> {
    let trial = tempfile::tempdir().map_err(|e| AppError::Other(e.to_string()))?;
    let mut conn = Connection::open(trial.path().join("trial.db"))?;
    conn.restore(rusqlite::MAIN_DB, source, None::<fn(rusqlite::backup::Progress)>)?;
    // Reject backups made by a newer AutoHR, and prove an older one upgrades cleanly.
    crate::db::upgrade_restored(&conn)?;
    crate::scanner::ensure_metadata_columns(&conn)?;
    validate_database_connection(&conn)
}

pub(crate) fn verify_written_backup(path: &Path, password: &str) -> AppResult<()> {
    let size = std::fs::metadata(path).map_err(|e| AppError::Other(e.to_string()))?.len();
    if size == 0 || size > MAX_BACKUP_SIZE {
        return Err(AppError::Validation("The backup file is empty or too large".into()));
    }
    let encrypted = std::fs::read(path).map_err(|e| AppError::Other(e.to_string()))?;
    let (legacy, plaintext) = decrypt_backup(&encrypted, password)?;
    if legacy {
        return Err(AppError::Validation("Full backup verification requires a v2 backup".into()));
    }
    let staging = tempfile::tempdir().map_err(|e| AppError::Other(e.to_string()))?;
    extract_and_validate_backup(&plaintext, staging.path())?;
    Ok(())
}

pub fn restore_backup_with_progress<F>(conn: &mut Connection, user: &str, source_path: &str, password: &str, mut progress: F) -> AppResult<()>
where
    F: FnMut(BackupProgress),
{
    // A restore replaces the users table too, so it is limited to System Admins.
    assert_permission(conn, user, "backups.restore")?;
    progress(backup_progress(2, "جاري تجهيز عملية الاستعادة..."));
    let source = Path::new(source_path);
    if source.extension().and_then(|e| e.to_str()).is_none_or(|e| !e.eq_ignore_ascii_case("autohrbak")) {
        return Err(AppError::Validation("Select an encrypted .autohrbak backup file".into()));
    }
    progress(backup_progress(6, "جاري فحص ملف النسخة الاحتياطية..."));
    let metadata = std::fs::metadata(source).map_err(|_| AppError::Validation("The backup file could not be read".into()))?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_BACKUP_SIZE {
        return Err(AppError::Validation("The backup file is empty or too large".into()));
    }
    progress(backup_progress(10, "جاري قراءة ملف النسخة الاحتياطية..."));
    let encrypted = std::fs::read(source).map_err(|_| AppError::Validation("The backup file could not be read".into()))?;
    progress(backup_progress(18, "جاري فك تشفير النسخة الاحتياطية..."));
    let (is_legacy, plaintext) = decrypt_backup(&encrypted, password)?;
    if is_legacy {
        return Err(AppError::Validation("This legacy database-only backup cannot safely restore attachments. Use an AutoHR v2 full backup.".into()));
    }
    progress(backup_progress(28, "جاري فحص SHA-256 وفك الضغط وتجربة الاستعادة المؤقتة..."));
    let staging = tempfile::tempdir_in(crate::paths::data_root()).map_err(|e| AppError::Other(e.to_string()))?;
    extract_and_validate_backup(&plaintext, staging.path())?;
    progress(backup_progress(40, "جاري حفظ سجل التدقيق الحالي..."));
    let audit: Vec<AuditSnapshotRow> = {
        let mut stmt = conn.prepare("SELECT user_id,username,role,action,target_type,target_id,target_name,result,details,created_at FROM activity_log ORDER BY id")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?,r.get(9)?)))?
            .collect::<rusqlite::Result<_>>()?;
        rows
    };
    progress(backup_progress(45, "جاري إنشاء نسخة أمان قبل الاستعادة..."));
    let mut backup_progress_mapper = |step: BackupProgress| {
        let mapped = 45 + (((step.percent as u16) * 18) / 100) as u8;
        progress(backup_progress(mapped.min(63), "جاري إنشاء نسخة أمان قبل الاستعادة..."));
    };
    create_backup_at(conn, user, password, "PreRestore", &mut backup_progress_mapper)?;
    progress(backup_progress(65, "جاري تجهيز ملفات الاستعادة..."));
    let current_data = storage_path(conn);
    let data_root = crate::paths::data_root();
    let rollback_data = data_root.join("Data.restore.rollback");
    let rollback_database = data_root.join("database.restore.rollback.db");
    let restore_marker = data_root.join("restore.in_progress");
    std::fs::remove_dir_all(&rollback_data).ok();
    std::fs::remove_file(&rollback_database).ok();
    progress(backup_progress(70, "جاري حفظ نسخة تراجع من قاعدة البيانات الحالية..."));
    conn.backup(rusqlite::MAIN_DB, &rollback_database, None::<fn(rusqlite::backup::Progress)>)?;
    std::fs::write(&restore_marker, b"AutoHR restore in progress").map_err(|e| AppError::Other(e.to_string()))?;
    let staged_data = staging.path().join("Data");
    progress(backup_progress(76, "جاري استبدال المرفقات والملفات..."));
    if current_data.exists() {
        std::fs::rename(&current_data, &rollback_data).map_err(|e| AppError::Other(e.to_string()))?;
    }
    if let Err(error) = std::fs::rename(&staged_data, &current_data) {
        if rollback_data.exists() { std::fs::rename(&rollback_data, &current_data).ok(); }
        std::fs::remove_file(&rollback_database).ok();
        std::fs::remove_file(&restore_marker).ok();
        return Err(AppError::Other(error.to_string()));
    }
    progress(backup_progress(86, "جاري استعادة قاعدة البيانات..."));
    if let Err(error) = conn.restore(rusqlite::MAIN_DB, staging.path().join("database.db"), None::<fn(rusqlite::backup::Progress)>).map_err(AppError::from)
        .and_then(|_| crate::db::upgrade_restored(conn).map_err(AppError::from))
        .and_then(|_| crate::scanner::ensure_metadata_columns(conn).map_err(AppError::from)) {
        std::fs::remove_dir_all(&current_data).ok();
        if rollback_data.exists() { std::fs::rename(&rollback_data, &current_data).ok(); }
        conn.restore(rusqlite::MAIN_DB, &rollback_database, None::<fn(rusqlite::backup::Progress)>).ok();
        std::fs::remove_file(&rollback_database).ok();
        std::fs::remove_file(&restore_marker).ok();
        return Err(error);
    }
    progress(backup_progress(94, "جاري إعادة ربط سجل التدقيق..."));
    for row in audit {
        conn.execute(
            "INSERT INTO activity_log(user_id,username,role,action,target_type,target_id,target_name,result,details,created_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![row.0,row.1,row.2,row.3,row.4,row.5,row.6,row.7,row.8,row.9],
        )?;
    }
    log_activity(conn, user, "RESTORE_BACKUP", Some("backup"), None, source.file_name().and_then(|n| n.to_str()), None);
    std::fs::remove_dir_all(&rollback_data).ok();
    std::fs::remove_file(&rollback_database).ok();
    std::fs::remove_file(&restore_marker).ok();
    progress(backup_progress(100, "اكتملت استعادة النسخة الاحتياطية"));
    Ok(())
}

pub(crate) fn stored_document_path(conn: &Connection, relative_path: &str) -> AppResult<std::path::PathBuf> {
    let relative = Path::new(relative_path);
    if relative.is_absolute() || relative.components().any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::Prefix(_))) {
        return Err(AppError::Validation("Invalid document path".into()));
    }
    if !relative_path.replace('\\', "/").starts_with("Files/") {
        return Err(AppError::Validation("Only stored documents can be downloaded".into()));
    }
    let source = storage_path(conn).join(relative);
    if !source.is_file() { return Err(AppError::NotFound); }
    Ok(source)
}

fn archive_document_path(conn: &Connection, relative_path: &str) -> AppResult<std::path::PathBuf> {
    let source = stored_document_path(conn, relative_path)?;
    let exists: bool = conn.query_row(
        "SELECT EXISTS(
            SELECT 1 FROM general_doc_attachments WHERE file_path=?1
            UNION ALL
            SELECT 1 FROM outgoing_doc_attachments WHERE file_path=?1
        )",
        params![relative_path],
        |row| row.get(0),
    )?;
    if !exists { return Err(AppError::NotFound); }
    Ok(source)
}

pub fn document_preview_path(conn: &Connection, user: &str, relative_path: &str) -> AppResult<String> {
    assert_permission(conn, user, "documents.view")?;
    archive_document_path(conn, relative_path)?;
    let source = crate::scanner::effective_path(conn, relative_path)?;
    log_activity(conn, user, "VIEW_DOCUMENT", Some("document"), None, Some(relative_path), None);
    Ok(source.to_string_lossy().into_owned())
}

pub fn read_document(conn: &Connection, user: &str, relative_path: &str) -> AppResult<Vec<u8>> {
    assert_permission(conn, user, "documents.view")?;
    archive_document_path(conn, relative_path)?;
    let source = crate::scanner::effective_path(conn, relative_path)?;
    std::fs::read(&source).map_err(|e| AppError::Other(e.to_string()))
}

pub fn print_document(conn: &Connection, user: &str, relative_path: &str) -> AppResult<()> {
    assert_permission(conn, user, "documents.print")?;
    archive_document_path(conn, relative_path)?;
    log_activity(conn, user, "PRINT_DOCUMENT", Some("document"), None, Some(relative_path), None);
    Ok(())
}

pub fn download_document(conn: &Connection, user: &str, relative_path: &str, destination_path: &str) -> AppResult<String> {
    assert_permission(conn, user, "documents.download")?;
    stored_document_path(conn, relative_path)?;
    let source = crate::scanner::effective_path(conn, relative_path)?;
    let name = source.file_name().ok_or_else(|| AppError::Validation("Invalid document name".into()))?;
    let destination = Path::new(destination_path);
    if destination.file_name().is_none() || !destination.parent().is_some_and(Path::is_dir) {
        return Err(AppError::Validation("Invalid download destination".into()));
    }
    // The copy may only produce a file of the same type, so a download can never be used to
    // write or overwrite an executable, script or DLL elsewhere on the computer.
    let extension_of = |path: &Path| path.extension().and_then(|e| e.to_str()).map(|e| match e.to_ascii_lowercase().as_str() {
        "jpeg" => "jpg".to_string(),
        other => other.to_string(),
    });
    if extension_of(&source).is_none() || extension_of(&source) != extension_of(destination) {
        return Err(AppError::Validation("The download must keep the document's file type".into()));
    }
    std::fs::copy(&source, destination).map_err(|e| AppError::Other(e.to_string()))?;
    log_activity(conn, user, "DOWNLOAD_DOCUMENT", Some("document"), None, name.to_str(), Some(&destination.to_string_lossy()));
    Ok(destination.to_string_lossy().into_owned())
}

pub fn get_document_types(conn: &Connection) -> AppResult<Vec<String>> {
    let val: String = conn.query_row(
        "SELECT value FROM app_settings WHERE key='document_types'", [], |r| r.get(0)
    ).unwrap_or_default();
    let parsed: Vec<String> = serde_json::from_str(&val).unwrap_or_default();
    let normalized = normalize_document_types(&parsed);
    if normalized.is_empty() { Ok(default_document_types()) } else { Ok(normalized) }
}

pub fn set_document_types(conn: &Connection, user: &str, types: &[String]) -> AppResult<Vec<String>> {
    if assert_permission(conn, user, "documents.manage").is_err() {
        assert_permission(conn, user, "settings.manage")?;
    }
    let normalized = normalize_document_types(types);
    if normalized.is_empty() {
        return Err(AppError::Validation("document types required".into()));
    }
    if normalized.len() > 50 {
        return Err(AppError::Validation("maximum 50 document types".into()));
    }
    let json = serde_json::to_string(&normalized).map_err(|e| AppError::Other(e.to_string()))?;
    conn.execute("INSERT INTO app_settings(key,value) VALUES('document_types',?1)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![json])?;
    log_activity(conn, user, "UPDATE_DOCUMENT_TYPES", Some("settings"), None, Some("document_types"), None);
    Ok(normalized)
}

#[cfg(test)]
mod phase3_security_tests {
    use super::*;

    // Opt-in timing check: `cargo test -p autohr --lib list_employees_timing -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn list_employees_timing() {
        let conn = Connection::open_in_memory().unwrap();
        crate::db::migrate_for_tests(&conn);
        for count in [75_i64, 1000] {
            conn.execute("DELETE FROM employees", []).unwrap();
            for id in 1..=count {
                conn.execute("INSERT INTO employees(id,full_name,employee_number,photo_path) VALUES(?1,?2,?3,?4)",
                    params![id, format!("موظف {id}"), format!("E-{id}"), format!("Files/Employees/{id}/p.jpg")]).unwrap();
                for order in 0..2 { conn.execute("INSERT INTO employee_spouses(employee_id,name,sort_order) VALUES(?1,'x',?2)", params![id, order]).unwrap(); }
                for order in 0..3 { conn.execute("INSERT INTO employee_attachments(employee_id,kind,file_path,sort_order) VALUES(?1,'general',?2,?3)", params![id, format!("Files/Employees/{id}/a{order}.pdf"), order]).unwrap(); }
            }
            list_employees(&conn).unwrap();
            let started = std::time::Instant::now();
            let employees = list_employees(&conn).unwrap();
            println!("list_employees: {} employees in {:?}", employees.len(), started.elapsed());
        }
    }

    #[test]
    fn daily_backup_after_employee_change_is_verified_and_not_repeated() {
        let dir = tempfile::tempdir().unwrap();
        struct ResetRoot;
        impl Drop for ResetRoot {
            fn drop(&mut self) { TEST_APP_DATA_ROOT.with(|root| *root.borrow_mut() = None); }
        }
        TEST_APP_DATA_ROOT.with(|root| *root.borrow_mut() = Some(dir.path().to_path_buf()));
        let _reset = ResetRoot;
        let conn = Connection::open(dir.path().join("database.db")).unwrap();
        conn.execute_batch(include_str!("../../database/schema.sql")).unwrap();
        conn.execute("INSERT INTO users(username,password,role) VALUES('testadmin','unused','system_admin')", []).unwrap();
        set_setting(&conn, "auto_backup_daily_enabled", "1").unwrap();
        set_setting(&conn, "auto_backup_password", "strong-password").unwrap();
        // No data changes means no backup.
        assert!(run_due_automatic_backups_with_progress(&conn, |_| {}).unwrap().is_empty());
        conn.execute("INSERT INTO employees(id,full_name) VALUES(1,'Before change')", []).unwrap();
        log_activity(&conn, "testadmin", "CREATE_EMPLOYEE", Some("employee"), Some(1), None, None);
        assert_eq!(run_due_automatic_backups_with_progress(&conn, |_| {}).unwrap(), vec!["يومي"]);
        // A plain-text password from an older release is re-saved protected once read.
        assert_ne!(get_setting(&conn, "auto_backup_password").unwrap().unwrap(), "strong-password");
        assert_eq!(auto_backup_password(&conn).unwrap(), "strong-password");
        let first_path = get_setting(&conn, "auto_backup_last_daily_path").unwrap().unwrap();
        verify_written_backup(Path::new(&first_path), "strong-password").unwrap();
        // Login/logout and reading documents must not cause another backup.
        for action in ["LOGIN", "LOGOUT", "VIEW_DOCUMENT"] {
            log_activity(&conn, "testadmin", action, Some("employee"), Some(1), None, None);
        }
        assert!(run_due_automatic_backups_with_progress(&conn, |_| {}).unwrap().is_empty());
        std::thread::sleep(std::time::Duration::from_millis(1100));
        conn.execute("UPDATE employees SET full_name='After change' WHERE id=1", []).unwrap();
        log_activity(&conn, "testadmin", "UPDATE_EMPLOYEE", Some("employee"), Some(1), None, None);
        assert_eq!(run_due_automatic_backups_with_progress(&conn, |_| {}).unwrap(), vec!["يومي"]);
        let second_path = get_setting(&conn, "auto_backup_last_daily_path").unwrap().unwrap();
        assert_ne!(first_path, second_path);
        assert!(Path::new(&first_path).is_file());
        let encrypted = std::fs::read(&second_path).unwrap();
        let (_, plaintext) = decrypt_backup(&encrypted, "strong-password").unwrap();
        let staging = tempfile::tempdir().unwrap();
        extract_and_validate_backup(&plaintext, staging.path()).unwrap();
        let restored = Connection::open(staging.path().join("database.db")).unwrap();
        let name: String = restored.query_row("SELECT full_name FROM employees WHERE id=1", [], |r| r.get(0)).unwrap();
        assert_eq!(name, "After change");
        assert!(run_due_automatic_backups_with_progress(&conn, |_| {}).unwrap().is_empty());
        conn.execute("UPDATE employees SET full_name='Disabled backup' WHERE id=1", []).unwrap();
        log_activity(&conn, "testadmin", "UPDATE_EMPLOYEE", Some("employee"), Some(1), None, None);
        set_setting(&conn, "auto_backup_daily_enabled", "0").unwrap();
        assert!(run_due_automatic_backups_with_progress(&conn, |_| {}).unwrap().is_empty());
        set_setting(&conn, "auto_backup_daily_enabled", "1").unwrap();
        set_setting(&conn, "auto_backup_password", "").unwrap();
        assert!(run_due_automatic_backups_with_progress(&conn, |_| {}).unwrap().is_empty());
    }

    fn backup_test_archive(hash_override: Option<&str>) -> Vec<u8> {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("database.db");
        let conn = Connection::open(&db_path).unwrap();
        conn.execute_batch(include_str!("../../database/schema.sql")).unwrap();
        conn.execute(
            "INSERT INTO employees(full_name,attachment_paths) VALUES('Backup Test','[\"Files/Employees/1/Attachments/test.pdf\"]')",
            [],
        ).unwrap();
        drop(conn);
        let database = std::fs::read(&db_path).unwrap();
        let attachment = b"%PDF-1.7\nbackup test".to_vec();
        let hash_bytes = |bytes: &[u8]| hex::encode(Sha256::digest(bytes));
        let manifest = BackupManifest {
            format_version: BACKUP_FORMAT_VERSION,
            created_at: chrono::Utc::now().to_rfc3339(),
            files: vec![
                BackupManifestFile {
                    path: "database.db".into(),
                    size: database.len() as u64,
                    sha256: hash_bytes(&database),
                },
                BackupManifestFile {
                    path: "Data/Files/Employees/1/Attachments/test.pdf".into(),
                    size: attachment.len() as u64,
                    sha256: hash_override.map(str::to_string).unwrap_or_else(|| hash_bytes(&attachment)),
                },
            ],
        };
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        for (name, bytes) in [
            ("database.db", database),
            ("Data/Files/Employees/1/Attachments/test.pdf", attachment),
            ("manifest.json", serde_json::to_vec(&manifest).unwrap()),
        ] {
            writer.start_file(name, options).unwrap();
            writer.write_all(&bytes).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn written_backup_verification_roundtrip_and_corruption() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.autohrbak");
        let encrypted = encrypt_backup(&backup_test_archive(None), "strong-password", BACKUP_MAGIC_V2).unwrap();
        std::fs::write(&path, &encrypted).unwrap();
        verify_written_backup(&path, "strong-password").unwrap();
        assert!(verify_written_backup(&path, "wrong-password").is_err());
        let mut damaged = encrypted;
        *damaged.last_mut().unwrap() ^= 1;
        std::fs::write(&path, damaged).unwrap();
        assert!(verify_written_backup(&path, "strong-password").is_err());
        let invalid = encrypt_backup(&backup_test_archive(Some("invalid-hash")), "strong-password", BACKUP_MAGIC_V2).unwrap();
        std::fs::write(&path, invalid).unwrap();
        assert!(verify_written_backup(&path, "strong-password").is_err());
    }

    #[test]
    fn trial_restore_rejects_invalid_database_and_leaves_source_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let staging = dir.path().join("staging");
        extract_and_validate_backup(&backup_test_archive(None), &staging).unwrap();
        let source = staging.join("database.db");
        let before = sha256_file(&source).unwrap();
        trial_restore_database(&source).unwrap();
        assert_eq!(before, sha256_file(&source).unwrap());
        std::fs::write(&source, b"damaged SQLite database").unwrap();
        assert!(trial_restore_database(&source).is_err());
    }

    #[test]
    fn encrypted_backups_are_authenticated() {
        let encrypted = encrypt_backup(b"SQLite data", "strong-password", BACKUP_MAGIC_V2).unwrap();
        assert_ne!(&encrypted[..], b"SQLite data");
        assert_eq!(decrypt_backup(&encrypted, "strong-password").unwrap().1, b"SQLite data");
        assert!(decrypt_backup(&encrypted, "wrong-password").is_err());
        let mut damaged = encrypted;
        *damaged.last_mut().unwrap() ^= 1;
        assert!(decrypt_backup(&damaged, "strong-password").is_err());
    }

    #[test]
    fn full_backup_manifest_validates_database_and_attachments() {
        let archive = backup_test_archive(None);
        let staging = tempfile::tempdir().unwrap();
        let manifest = extract_and_validate_backup(&archive, staging.path()).unwrap();
        assert_eq!(manifest.format_version, BACKUP_FORMAT_VERSION);
        assert!(staging.path().join("database.db").is_file());
        assert!(staging.path().join("Data/Files/Employees/1/Attachments/test.pdf").is_file());
    }

    #[test]
    fn full_backup_manifest_rejects_tampered_attachment() {
        let archive = backup_test_archive(Some("invalid-hash"));
        let staging = tempfile::tempdir().unwrap();
        assert!(extract_and_validate_backup(&archive, staging.path()).is_err());
    }

    #[test]
    fn backup_validation_checks_normalized_employee_attachments() {
        let dir = tempfile::tempdir().unwrap();
        let database = dir.path().join("database.db");
        let conn = Connection::open(&database).unwrap();
        conn.execute_batch(include_str!("../../database/schema.sql")).unwrap();
        conn.execute("INSERT INTO employees(id,full_name) VALUES(1,'Synthetic')", []).unwrap();
        for (table, column) in [
            ("employee_spouses", "national_card_front_path"),
            ("employee_spouses", "national_card_back_path"),
            ("employee_family_members", "national_card_front_path"),
            ("employee_family_members", "national_card_back_path"),
            ("employee_attachments", "file_path"),
        ] {
            let relative = format!("Files/Employees/1/{table}-{column}.jpg");
            if table == "employee_attachments" {
                conn.execute("INSERT INTO employee_attachments(employee_id,kind,file_path) VALUES(1,'general',?1)", [&relative]).unwrap();
            } else {
                conn.execute(&format!("INSERT INTO {table}(employee_id,name,{column}) VALUES(1,'Synthetic',?1)"), [&relative]).unwrap();
            }
            assert!(validate_backup_references(&database, dir.path()).is_err());
            let path = dir.path().join("Data").join(relative);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, b"synthetic attachment").unwrap();
            validate_backup_references(&database, dir.path()).unwrap();
        }
    }

    #[test]
    fn role_boundaries_match_phase_three() {
        let viewer = role_permissions("viewer");
        assert!(viewer.contains(&"documents.view") && viewer.contains(&"documents.print"));
        assert!(!viewer.contains(&"documents.download"));
        let officer = role_permissions("archive_officer");
        assert!(officer.contains(&"documents.upload") && !officer.contains(&"documents.delete"));
        let admin = role_permissions("archive_admin");
        assert!(admin.contains(&"backups.manage") && !admin.contains(&"users.assign_system_admin"));
        assert!(!admin.contains(&"backups.restore"), "only a System Admin may restore a backup");
        assert!(role_permissions("system_admin").contains(&"users.assign_system_admin"));
        assert!(role_permissions("system_admin").contains(&"backups.restore"));
    }

    #[test]
    fn audit_records_are_generated_and_immutable() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("
            CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT, role TEXT);
            CREATE TABLE activity_log(
                id INTEGER PRIMARY KEY, user_id INTEGER, username TEXT, role TEXT, action TEXT,
                target_type TEXT, target_id INTEGER, target_name TEXT, result TEXT, details TEXT,
                created_at TEXT DEFAULT (datetime('now')));
            CREATE TRIGGER activity_log_no_update BEFORE UPDATE ON activity_log
            BEGIN SELECT RAISE(ABORT, 'audit log is immutable'); END;
            CREATE TRIGGER activity_log_no_delete BEFORE DELETE ON activity_log
            BEGIN SELECT RAISE(ABORT, 'audit log is immutable'); END;
            INSERT INTO users VALUES(1,'admin','system_admin');
        ").unwrap();
        log_activity(&conn, "admin", "UPLOAD_DOCUMENT", Some("employee"), Some(7), Some("doc.pdf"), None);
        assert_eq!(conn.query_row("SELECT COUNT(*) FROM activity_log", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
        assert!(conn.execute("DELETE FROM activity_log", []).is_err());
        assert!(conn.execute("UPDATE activity_log SET action='changed'", []).is_err());
    }

    #[test]
    fn archive_attachments_move_one_position_at_a_time() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("
            CREATE TABLE general_doc_attachments(
                id INTEGER PRIMARY KEY,
                general_doc_id INTEGER NOT NULL,
                file_path TEXT NOT NULL,
                sort_order INTEGER NOT NULL
            );
            INSERT INTO general_doc_attachments VALUES(1,7,'first.pdf',1);
            INSERT INTO general_doc_attachments VALUES(2,7,'second.pdf',2);
            INSERT INTO general_doc_attachments VALUES(3,7,'third.pdf',3);
        ").unwrap();
        move_general_doc_attachment(&conn, 7, "third.pdf", "up").unwrap();
        let ordered = || {
            let mut stmt = conn.prepare(
                "SELECT file_path FROM general_doc_attachments WHERE general_doc_id=7 ORDER BY sort_order,id"
            ).unwrap();
            stmt.query_map([], |row| row.get::<_, String>(0)).unwrap()
                .collect::<rusqlite::Result<Vec<_>>>().unwrap()
        };
        assert_eq!(ordered(), vec!["first.pdf", "third.pdf", "second.pdf"]);
        move_general_doc_attachment(&conn, 7, "third.pdf", "down").unwrap();
        assert_eq!(ordered(), vec!["first.pdf", "second.pdf", "third.pdf"]);
    }
}

#[cfg(test)]
#[test]
fn updating_a_general_doc_preserves_stored_hr_effect() {
    let conn = Connection::open_in_memory().unwrap();
    crate::db::initialize_test(&conn).unwrap();
    conn.execute(
        "INSERT INTO users(username,password,role) VALUES('docadmin',?1,'archive_admin')",
        params![hash_password("admin-password").unwrap()],
    ).unwrap();
    conn.execute(
        "INSERT INTO general_docs(title,hr_effect_type,hr_affects_promotion,hr_affects_allowance,hr_effect_months,hr_effect_days)
         VALUES('Legacy','appreciation',1,0,3,10)",
        [],
    ).unwrap();
    let id = conn.last_insert_rowid();
    let data = GeneralDocData {
        title: "Edited".into(), doc_type: None, doc_number: None, issue_date: None, issuer: None,
        doc_count: None, margin: None, is_internal_memo: false,
        hr_effect_type: None, hr_affects_promotion: false, hr_affects_allowance: false,
        hr_effect_months: 0, hr_effect_days: 0, notes: None, employee_ids: vec![],
    };
    update_general_doc(&conn, id, &data, "docadmin").unwrap();
    let stored: (String, String, i64, i64, i64, i64) = conn.query_row(
        "SELECT title,hr_effect_type,hr_affects_promotion,hr_affects_allowance,hr_effect_months,hr_effect_days FROM general_docs WHERE id=?1",
        params![id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
    ).unwrap();
    assert_eq!(stored, ("Edited".into(), "appreciation".into(), 1, 0, 3, 10));
}

#[cfg(test)]
#[test]
fn development_data_path_is_isolated() {
    let base=dirs::data_dir().unwrap_or_else(||std::path::PathBuf::from("."));
    assert_eq!(app_data_path(),base.join("CNSArch-Development"));
    assert_ne!(app_data_path(),base.join("CNSArch"));
    assert_eq!(crate::db::db_path(),app_data_path().join("database.db"));
}
