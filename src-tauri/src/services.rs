// services.rs — GCANS v2.0
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;

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
        s.serialize_str(&self.to_string())
    }
}
pub type AppResult<T> = Result<T, AppError>;

// ── Models ──────────────────────────────────────────────────────────────────
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct User {
    pub id: i64, pub username: String, pub role: String,
    pub is_master: bool, pub created_at: Option<String>,
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
    pub full_name: String,
    pub mother_name: Option<String>,
    pub father_birthplace: Option<String>,
    pub mother_birthplace: Option<String>,
    pub gender: Option<String>,
    pub birthdate: Option<String>,
    pub birthplace: Option<String>,
    pub marital_status: Option<String>,
    pub blood_type: Option<String>,
    pub workplace: Option<String>,
    pub job_title: Option<String>,
    pub job_grade: Option<String>,
    pub hire_date: Option<String>,
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
    pub family_members: Option<String>,
    pub attachment_paths: Option<String>,
    pub notes: Option<String>,
    pub is_active: i64,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct EmployeeData {
    pub employee_number: Option<String>,
    pub full_name: String,
    pub mother_name: Option<String>,
    pub father_birthplace: Option<String>,
    pub mother_birthplace: Option<String>,
    pub gender: Option<String>,
    pub birthdate: Option<String>,
    pub birthplace: Option<String>,
    pub marital_status: Option<String>,
    pub blood_type: Option<String>,
    pub workplace: Option<String>,
    pub job_title: Option<String>,
    pub job_grade: Option<String>,
    pub hire_date: Option<String>,
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
    pub family_members: Option<String>,
    pub notes: Option<String>,
    pub is_active: Option<i64>,
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
    pub issuer: Option<String>, pub notes: Option<String>,
    pub file_path: Option<String>, pub created_at: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GeneralDocData {
    pub title: String, pub doc_type: Option<String>, pub doc_number: Option<String>,
    pub issue_date: Option<String>, pub issuer: Option<String>, pub notes: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ActivityLog {
    pub id: i64, pub username: String, pub action: String,
    pub target_type: Option<String>, pub target_id: Option<i64>,
    pub target_name: Option<String>, pub details: Option<String>,
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

// ── Helpers ────────────────────────────────────────────────────────────────
fn hash_password(plain: &str) -> String {
    let mut h = Sha256::new(); h.update(plain.as_bytes()); hex::encode(h.finalize())
}

pub fn assert_master(conn: &Connection, username: &str) -> AppResult<()> {
    let role: String = conn.query_row(
        "SELECT role FROM users WHERE username=?1", params![username], |r| r.get(0)
    ).map_err(|_| AppError::Unauthorized)?;
    if username == "sysadmin" || role == "master" { Ok(()) } else { Err(AppError::Unauthorized) }
}

pub fn storage_path(conn: &Connection) -> std::path::PathBuf {
    let val: String = conn.query_row(
        "SELECT value FROM app_settings WHERE key='storage_destination'", [], |r| r.get(0)
    ).unwrap_or_default();
    if val.is_empty() { dirs::document_dir().unwrap_or_default().join("GCANS") }
    else { std::path::PathBuf::from(val) }
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
    let root = storage_path(conn);
    for dir in [
        "Database",
        "Backups/Daily",
        "Backups/Monthly",
        "Files/Employees",
        "Files/GeneralDocs",
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
    let old_attachments_cleaned: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM app_settings WHERE key='employee_attachments_cleanup_v1')",
        [],
        |row| row.get(0),
    ).unwrap_or(false);
    if !old_attachments_cleaned {
        let employees_dir = root.join("Files").join("Employees");
        if let Ok(entries) = std::fs::read_dir(&employees_dir) {
            for entry in entries.flatten() {
                std::fs::remove_dir_all(entry.path().join("Attachments")).ok();
            }
        }
        conn.execute("UPDATE employees SET attachment_paths='[]'", [])?;
        conn.execute(
            "INSERT INTO app_settings(key,value) VALUES('employee_attachments_cleanup_v1','done')",
            [],
        )?;
    }

    let moved_general_docs = merge_legacy_dir(&root.join("GeneralDocs"), &root.join("Files").join("GeneralDocs")).unwrap_or(false);
    if moved_general_docs {
        conn.execute("UPDATE general_docs SET file_path='Files/' || file_path WHERE file_path LIKE 'GeneralDocs/%'", [])?;
    }
    organize_legacy_backups(&root).ok();

    Ok(())
}

pub fn log_activity(conn: &Connection, username: &str, action: &str,
    target_type: Option<&str>, target_id: Option<i64>, target_name: Option<&str>, details: Option<&str>) {
    conn.execute(
        "INSERT INTO activity_log(username,action,target_type,target_id,target_name,details) VALUES(?1,?2,?3,?4,?5,?6)",
        params![username, action, target_type, target_id, target_name, details]
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
        if !trimmed.is_empty() && !normalized.iter().any(|v: &String| v == trimmed) {
            normalized.push(trimmed.to_string());
        }
    }
    normalized
}

// ── Auth ───────────────────────────────────────────────────────────────────
pub fn login(conn: &Connection, username: &str, password: &str) -> AppResult<User> {
    let hashed = hash_password(password);
    let row = conn.query_row(
        "SELECT id,username,role,created_at FROM users WHERE username=?1 AND password=?2",
        params![username, hashed],
        |r| Ok((r.get::<_,i64>(0)?, r.get::<_,String>(1)?, r.get::<_,String>(2)?, r.get::<_,Option<String>>(3)?)),
    ).map_err(|_| AppError::Unauthorized)?;
    let is_master = row.1 == "sysadmin" || row.2 == "master";
    log_activity(conn, username, "LOGIN", None, None, None, None);
    Ok(User { id: row.0, username: row.1, role: row.2, is_master, created_at: row.3 })
}

pub fn logout(conn: &Connection, username: &str) -> AppResult<()> {
    let storage = storage_path(conn);
    ensure_storage_layout(conn).ok();
    conn.execute_batch("PRAGMA wal_checkpoint(FULL);").ok();
    let now = chrono::Local::now();
    let backups = storage
        .join("Backups")
        .join("Daily")
        .join(now.format("%Y").to_string())
        .join(now.format("%m").to_string());
    std::fs::create_dir_all(&backups).ok();
    let filename = format!("autohr_{}.db", now.format("%Y-%m-%d_%H%M"));
    let dst = backups.join(filename);
    std::fs::copy(&crate::db::db_path(), &dst).ok();
    std::fs::copy(&crate::db::db_path(), storage.join("Database").join("autohr.db")).ok();
    conn.execute("INSERT INTO backup_log(username,backup_path) VALUES(?1,?2)",
        params![username, dst.to_string_lossy().as_ref()])?;
    log_activity(conn, username, "LOGOUT", None, None, None, None);
    Ok(())
}

// ── Company ────────────────────────────────────────────────────────────────
pub fn get_company_config(conn: &Connection) -> AppResult<CompanyConfig> {
    conn.query_row("SELECT company_name,department_name,division_name,logo_path FROM company_config WHERE id=1",
        [], |r| {
            let logo_path: Option<String> = r.get(3)?;
            let logo_full_path = logo_path.as_ref().map(|p| storage_path(conn).join(p).to_string_lossy().into_owned());
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
    assert_master(conn, user)?;
    conn.execute("UPDATE company_config SET company_name=?1,department_name=?2,division_name=?3 WHERE id=1",
        params![data.company_name, data.department_name.as_deref().unwrap_or(""), data.division_name.as_deref().unwrap_or("")])?;
    get_company_config(conn)
}

pub fn upload_company_logo(conn: &Connection, user: &str, source_path: &str) -> AppResult<CompanyConfig> {
    assert_master(conn, user)?;
    ensure_storage_layout(conn)?;
    let src = std::path::Path::new(source_path);
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if !["png", "jpg", "jpeg"].contains(&ext.as_str()) {
        return Err(AppError::Validation("Only png/jpg/jpeg allowed".into()));
    }
    let size = std::fs::metadata(src).map_err(|e| AppError::Other(e.to_string()))?.len();
    if size > 5 * 1024 * 1024 {
        return Err(AppError::Validation("Logo must be 5 MB or less".into()));
    }
    let dir = storage_path(conn).join("Branding");
    std::fs::create_dir_all(&dir).map_err(|e| AppError::Other(e.to_string()))?;
    let filename = format!("company_logo.{}", ext);
    std::fs::copy(src, dir.join(&filename)).map_err(|e| AppError::Other(e.to_string()))?;
    let rel = format!("Branding/{}", filename);
    conn.execute("UPDATE company_config SET logo_path=?1 WHERE id=1", params![rel])?;
    log_activity(conn, user, "UPLOAD_COMPANY_LOGO", Some("company_config"), Some(1), None, None);
    get_company_config(conn)
}

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
  vehicle_color,vehicle_manufacture_year,vehicle_type,vehicle_annual_issue_date,vehicle_annual_expiry_date,vehicles";

fn map_emp(r: &rusqlite::Row) -> rusqlite::Result<Employee> {
    Ok(Employee {
        id:r.get(0)?,employee_number:r.get(1)?,photo_path:r.get(2)?,full_name:r.get(3)?,
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
    Some(storage_path(conn).join(path).to_string_lossy().into_owned())
}

fn add_employee_full_paths(conn: &Connection, employee: &mut Employee) {
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
}

fn validate_passport_type(passport_type: &Option<String>) -> AppResult<()> {
    if passport_type.as_deref().is_some_and(|value| !["P", "D", "S"].contains(&value)) {
        return Err(AppError::Validation("passport_type must be P, D, or S".into()));
    }
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

pub fn create_employee(conn: &Connection, d: &EmployeeData, username: &str) -> AppResult<Employee> {
    if d.full_name.trim().is_empty() { return Err(AppError::Validation("full_name required".into())); }
    validate_passport_type(&d.passport_type)?;
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
      vehicle_annual_issue_date,vehicle_annual_expiry_date,vehicles)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,
           ?21,?22,?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34,?35,?36,?37,?38,
           ?39,?40,?41,?42,?43,?44,?45,?46,?47,?48,?49,?50,?51,?52,?53,?54,?55,?56,?57,?58,
           ?59,?60,?61,?62,?63,?64,?65,?66,?67,?68,?69)",
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
      d.vehicle_annual_issue_date,d.vehicle_annual_expiry_date,d.vehicles.as_deref().unwrap_or("[]")])?;
    let id = conn.last_insert_rowid();
    log_activity(conn, username, "CREATE_EMPLOYEE", Some("employee"), Some(id), Some(d.full_name.trim()), None);
    get_employee(conn, id)
}

pub fn update_employee(conn: &Connection, id: i64, d: &EmployeeData, username: &str) -> AppResult<Employee> {
    validate_passport_type(&d.passport_type)?;
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
      vehicles=?69,updated_at=datetime('now') WHERE id=?70",
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
      d.vehicle_annual_issue_date,d.vehicle_annual_expiry_date,d.vehicles.as_deref().unwrap_or("[]"),id])?;
    log_activity(conn, username, "UPDATE_EMPLOYEE", Some("employee"), Some(id), Some(d.full_name.trim()), None);
    get_employee(conn, id)
}

pub fn delete_employee(conn: &Connection, id: i64, username: &str) -> AppResult<()> {
    let name: String = conn.query_row("SELECT full_name FROM employees WHERE id=?1", params![id], |r| r.get(0))
        .unwrap_or_default();
    conn.execute("DELETE FROM employees WHERE id=?1", params![id])?;
    log_activity(conn, username, "DELETE_EMPLOYEE", Some("employee"), Some(id), Some(&name), None);
    Ok(())
}

pub fn upload_employee_photo(conn: &Connection, employee_id: i64, source_path: &str) -> AppResult<String> {
    ensure_storage_layout(conn)?;
    let src = std::path::Path::new(source_path);
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if !["png","jpg","jpeg"].contains(&ext.as_str()) {
        return Err(AppError::Validation("Only png/jpg/jpeg allowed".into()));
    }
    let dir = crate::services::storage_path(conn)
        .join("Files")
        .join("Employees")
        .join(employee_id.to_string())
        .join("Photo");
    std::fs::create_dir_all(&dir).ok();
    let filename = format!("photo.{}", ext);
    std::fs::copy(src, dir.join(&filename)).map_err(|e| AppError::Other(e.to_string()))?;
    let rel = format!("Files/Employees/{}/Photo/{}", employee_id, filename);
    conn.execute("UPDATE employees SET photo_path=?1 WHERE id=?2", params![rel, employee_id])?;
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
pub fn list_general_docs(conn: &Connection) -> AppResult<Vec<GeneralDoc>> {
    let mut stmt = conn.prepare(
        "SELECT id,title,doc_type,doc_number,issue_date,issuer,notes,file_path,created_at FROM general_docs ORDER BY created_at DESC"
    )?;
    let result = stmt.query_map([], |r| Ok(GeneralDoc {
        id:r.get(0)?,title:r.get(1)?,doc_type:r.get(2)?,doc_number:r.get(3)?,
        issue_date:r.get(4)?,issuer:r.get(5)?,notes:r.get(6)?,file_path:r.get(7)?,created_at:r.get(8)?,
    }))?.collect::<rusqlite::Result<_>>()?;
    Ok(result)
}

fn get_general_doc(conn: &Connection, id: i64) -> AppResult<GeneralDoc> {
    conn.query_row("SELECT id,title,doc_type,doc_number,issue_date,issuer,notes,file_path,created_at FROM general_docs WHERE id=?1",
        params![id], |r| Ok(GeneralDoc { id:r.get(0)?,title:r.get(1)?,doc_type:r.get(2)?,doc_number:r.get(3)?,
            issue_date:r.get(4)?,issuer:r.get(5)?,notes:r.get(6)?,file_path:r.get(7)?,created_at:r.get(8)? }))
        .map_err(|_| AppError::NotFound)
}

pub fn create_general_doc(conn: &Connection, data: &GeneralDocData, username: &str) -> AppResult<GeneralDoc> {
    if data.title.trim().is_empty() { return Err(AppError::Validation("title required".into())); }
    conn.execute("INSERT INTO general_docs(title,doc_type,doc_number,issue_date,issuer,notes) VALUES(?1,?2,?3,?4,?5,?6)",
        params![data.title.trim(),data.doc_type,data.doc_number,data.issue_date,data.issuer,data.notes])?;
    let id = conn.last_insert_rowid();
    log_activity(conn, username, "CREATE_DOC", Some("general_doc"), Some(id), Some(data.title.trim()), None);
    get_general_doc(conn, id)
}

pub fn update_general_doc(conn: &Connection, id: i64, data: &GeneralDocData, username: &str) -> AppResult<GeneralDoc> {
    if data.title.trim().is_empty() { return Err(AppError::Validation("title required".into())); }
    conn.execute("UPDATE general_docs SET title=?1,doc_type=?2,doc_number=?3,issue_date=?4,issuer=?5,notes=?6,updated_at=datetime('now') WHERE id=?7",
        params![data.title.trim(),data.doc_type,data.doc_number,data.issue_date,data.issuer,data.notes,id])?;
    if conn.changes() == 0 { return Err(AppError::NotFound); }
    log_activity(conn, username, "UPDATE_DOC", Some("general_doc"), Some(id), Some(data.title.trim()), None);
    get_general_doc(conn, id)
}

pub fn delete_general_doc(conn: &Connection, id: i64, username: &str) -> AppResult<()> {
    let title: String = conn.query_row("SELECT title FROM general_docs WHERE id=?1", params![id], |r| r.get(0)).unwrap_or_default();
    conn.execute("DELETE FROM general_docs WHERE id=?1", params![id])?;
    log_activity(conn, username, "DELETE_DOC", Some("general_doc"), Some(id), Some(&title), None);
    Ok(())
}

pub fn upload_general_doc_file(conn: &Connection, doc_id: i64, source_path: &str) -> AppResult<String> {
    ensure_storage_layout(conn)?;
    let src  = std::path::Path::new(source_path);
    let ext = src.extension().and_then(|value| value.to_str()).unwrap_or("").to_lowercase();
    if !["jpg", "jpeg", "pdf"].contains(&ext.as_str()) {
        return Err(AppError::Validation("Only jpg/jpeg/pdf allowed".into()));
    }
    let name = src.file_name().ok_or_else(|| AppError::Validation("Invalid filename".into()))?;
    let dir  = crate::services::storage_path(conn)
        .join("Files")
        .join("GeneralDocs")
        .join(doc_id.to_string());
    std::fs::create_dir_all(&dir).ok();
    std::fs::copy(src, dir.join(name)).map_err(|e| AppError::Other(e.to_string()))?;
    let rel = format!("Files/GeneralDocs/{}/{}", doc_id, name.to_string_lossy());
    conn.execute("UPDATE general_docs SET file_path=?1,updated_at=datetime('now') WHERE id=?2", params![rel, doc_id])?;
    Ok(rel)
}

// ── Activity log ───────────────────────────────────────────────────────────
pub fn list_activity_log(conn: &Connection, limit: i64) -> AppResult<Vec<ActivityLog>> {
    let mut stmt = conn.prepare(
        "SELECT id,username,action,target_type,target_id,target_name,details,created_at FROM activity_log ORDER BY created_at DESC LIMIT ?1"
    )?;
    let result = stmt.query_map(params![limit], |r| Ok(ActivityLog {
        id:r.get(0)?,username:r.get(1)?,action:r.get(2)?,target_type:r.get(3)?,
        target_id:r.get(4)?,target_name:r.get(5)?,details:r.get(6)?,created_at:r.get(7)?,
    }))?.collect::<rusqlite::Result<_>>()?;
    Ok(result)
}

// ── Users ──────────────────────────────────────────────────────────────────
pub fn list_users(conn: &Connection) -> AppResult<Vec<User>> {
    let mut stmt = conn.prepare("SELECT id,username,role,created_at FROM users ORDER BY id")?;
    let result = stmt.query_map([], |r| {
        let username: String = r.get(1)?; let role: String = r.get(2)?;
        let is_master = username == "sysadmin" || role == "master";
        Ok(User { id:r.get(0)?, username, role, is_master, created_at:r.get(3)? })
    })?.collect::<rusqlite::Result<_>>()?;
    Ok(result)
}

pub fn create_user(conn: &Connection, caller: &str, data: &UserData) -> AppResult<User> {
    assert_master(conn, caller)?;
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))?;
    if count >= 10 { return Err(AppError::Validation("Max 10 users".into())); }
    conn.execute("INSERT INTO users(username,password,role) VALUES(?1,?2,?3)",
        params![data.username.trim(), hash_password(&data.password), data.role])?;
    let id = conn.last_insert_rowid();
    log_activity(conn, caller, "CREATE_USER", Some("user"), Some(id), Some(data.username.trim()), None);
    conn.query_row("SELECT id,username,role,created_at FROM users WHERE id=?1", params![id], |r| {
        let username: String = r.get(1)?; let role: String = r.get(2)?;
        let is_master = username == "sysadmin" || role == "master";
        Ok(User { id:r.get(0)?, username, role, is_master, created_at:r.get(3)? })
    }).map_err(Into::into)
}

pub fn delete_user(conn: &Connection, caller: &str, id: i64) -> AppResult<()> {
    assert_master(conn, caller)?;
    let username: String = conn.query_row("SELECT username FROM users WHERE id=?1", params![id], |r| r.get(0))
        .map_err(|_| AppError::NotFound)?;
    if username == "sysadmin" { return Err(AppError::Validation("Cannot delete sysadmin".into())); }
    conn.execute("DELETE FROM users WHERE id=?1", params![id])?;
    log_activity(conn, caller, "DELETE_USER", Some("user"), Some(id), Some(&username), None);
    Ok(())
}

// ── Settings ───────────────────────────────────────────────────────────────
pub fn get_storage_path(conn: &Connection) -> AppResult<String> {
    let val: String = conn.query_row(
        "SELECT value FROM app_settings WHERE key='storage_destination'", [], |r| r.get(0)
    ).unwrap_or_default();
    ensure_storage_layout(conn).ok();
    if val.is_empty() { Ok(dirs::document_dir().unwrap_or_default().join("GCANS").to_string_lossy().into_owned()) }
    else { Ok(val) }
}

pub fn set_storage_path(conn: &Connection, path: &str) -> AppResult<()> {
    conn.execute("INSERT INTO app_settings(key,value) VALUES('storage_destination',?1)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![path])?;
    ensure_storage_layout(conn)?;
    Ok(())
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
    assert_master(conn, user)?;
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
