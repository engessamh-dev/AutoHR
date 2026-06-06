// src-tauri/src/files.rs
use rusqlite::{params, Connection};
use std::path::{Component, Path};
use crate::services::{ensure_storage_layout, storage_path, AppError};

pub type AppResult<T> = Result<T, AppError>;

fn safe_relative_path(relative_path: &str) -> AppResult<&Path> {
    let path = Path::new(relative_path);
    if path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir | Component::Prefix(_))) {
        return Err(AppError::Validation("Invalid attachment path".into()));
    }
    Ok(path)
}

fn national_card_column(side: &str) -> AppResult<&'static str> {
    match side {
        "front" => Ok("civil_id_front_path"),
        "back" => Ok("civil_id_back_path"),
        _ => Err(AppError::Validation("Invalid national card side".into())),
    }
}

fn residence_card_column(side: &str) -> AppResult<&'static str> {
    match side {
        "front" => Ok("residence_card_front_path"),
        "back" => Ok("residence_card_back_path"),
        _ => Err(AppError::Validation("Invalid residence card side".into())),
    }
}

fn upload_sided_card_attachment(
    conn: &Connection,
    employee_id: i64,
    side: &str,
    source_path: &str,
    column: &str,
    folder: &str,
) -> AppResult<String> {
    ensure_storage_layout(conn)?;
    let src = Path::new(source_path);
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if !["png", "jpg", "jpeg", "pdf"].contains(&ext.as_str()) {
        return Err(AppError::Validation("Only png/jpg/jpeg/pdf allowed".into()));
    }
    let previous: Option<String> = conn.query_row(
        &format!("SELECT {} FROM employees WHERE id=?1", column),
        params![employee_id],
        |r| r.get(0),
    ).map_err(|_| AppError::NotFound)?;
    let dest_dir = storage_path(conn)
        .join("Files").join("Employees").join(employee_id.to_string())
        .join("Documents").join(folder);
    std::fs::create_dir_all(&dest_dir).map_err(|e| AppError::Other(e.to_string()))?;
    let filename = format!("{}.{}", side, ext);
    std::fs::copy(src, dest_dir.join(&filename)).map_err(|e| AppError::Other(e.to_string()))?;
    let rel = format!("Files/Employees/{}/Documents/{}/{}", employee_id, folder, filename);
    conn.execute(
        &format!("UPDATE employees SET {}=?1, updated_at=datetime('now') WHERE id=?2", column),
        params![rel, employee_id],
    )?;
    if let Some(old) = previous {
        if old != rel {
            if let Ok(path) = safe_relative_path(&old) {
                std::fs::remove_file(storage_path(conn).join(path)).ok();
            }
        }
    }
    Ok(rel)
}

fn delete_sided_card_attachment(
    conn: &Connection,
    employee_id: i64,
    column: &str,
) -> AppResult<()> {
    let existing: Option<String> = conn.query_row(
        &format!("SELECT {} FROM employees WHERE id=?1", column),
        params![employee_id],
        |r| r.get(0),
    ).map_err(|_| AppError::NotFound)?;
    if let Some(relative_path) = existing {
        let path = safe_relative_path(&relative_path)?;
        std::fs::remove_file(storage_path(conn).join(path)).ok();
    }
    conn.execute(
        &format!("UPDATE employees SET {}=NULL, updated_at=datetime('now') WHERE id=?1", column),
        params![employee_id],
    )?;
    Ok(())
}

/// Copy the front or back national card attachment into its dedicated folder.
pub fn upload_national_card_attachment(
    conn: &Connection,
    employee_id: i64,
    side: &str,
    source_path: &str,
) -> AppResult<String> {
    let column = national_card_column(side)?;
    upload_sided_card_attachment(conn, employee_id, side, source_path, column, "NationalCard")
}

pub fn delete_national_card_attachment(
    conn: &Connection,
    employee_id: i64,
    side: &str,
) -> AppResult<()> {
    let column = national_card_column(side)?;
    delete_sided_card_attachment(conn, employee_id, column)
}

pub fn upload_residence_card_attachment(
    conn: &Connection,
    employee_id: i64,
    side: &str,
    source_path: &str,
) -> AppResult<String> {
    let column = residence_card_column(side)?;
    upload_sided_card_attachment(conn, employee_id, side, source_path, column, "ResidenceCard")
}

pub fn delete_residence_card_attachment(
    conn: &Connection,
    employee_id: i64,
    side: &str,
) -> AppResult<()> {
    let column = residence_card_column(side)?;
    delete_sided_card_attachment(conn, employee_id, column)
}

pub fn upload_passport_attachment(
    conn: &Connection,
    employee_id: i64,
    source_path: &str,
) -> AppResult<String> {
    ensure_storage_layout(conn)?;
    let src = Path::new(source_path);
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    if !["png", "jpg", "jpeg", "pdf"].contains(&ext.as_str()) {
        return Err(AppError::Validation("Only png/jpg/jpeg/pdf allowed".into()));
    }
    let name = src.file_name().ok_or_else(|| AppError::Validation("Invalid filename".into()))?;
    let dest_dir = storage_path(conn)
        .join("Files")
        .join("Employees")
        .join(employee_id.to_string())
        .join("Documents")
        .join("Passport");
    std::fs::create_dir_all(&dest_dir).map_err(|e| AppError::Other(e.to_string()))?;

    let rel = format!(
        "Files/Employees/{}/Documents/Passport/{}",
        employee_id,
        name.to_string_lossy()
    );
    let existing: String = conn.query_row(
        "SELECT COALESCE(passport_attachment_paths,'[]') FROM employees WHERE id=?1",
        params![employee_id],
        |r| r.get(0),
    ).map_err(|_| AppError::NotFound)?;
    let paths: Vec<String> = serde_json::from_str(&existing).unwrap_or_default();

    std::fs::copy(src, dest_dir.join(name)).map_err(|e| AppError::Other(e.to_string()))?;
    for old in paths {
        if old != rel {
            if let Ok(path) = safe_relative_path(&old) {
                std::fs::remove_file(storage_path(conn).join(path)).ok();
            }
        }
    }
    conn.execute(
        "UPDATE employees SET passport_attachment_paths=?1, updated_at=datetime('now') WHERE id=?2",
        params![serde_json::to_string(&vec![rel.clone()]).map_err(|e| AppError::Other(e.to_string()))?, employee_id],
    )?;
    Ok(rel)
}

pub fn delete_passport_attachment(
    conn: &Connection,
    employee_id: i64,
    relative_path: &str,
) -> AppResult<()> {
    let rel_path = safe_relative_path(relative_path)?;
    let expected_prefix = format!("Files/Employees/{}/Documents/Passport/", employee_id);
    if !relative_path.replace('\\', "/").starts_with(&expected_prefix) {
        return Err(AppError::Validation("Invalid passport attachment path".into()));
    }

    let existing: String = conn.query_row(
        "SELECT COALESCE(passport_attachment_paths,'[]') FROM employees WHERE id=?1",
        params![employee_id],
        |r| r.get(0),
    ).map_err(|_| AppError::NotFound)?;
    let paths: Vec<String> = serde_json::from_str(&existing).unwrap_or_default();
    if paths.first().is_none_or(|path| path != relative_path) {
        return Err(AppError::NotFound);
    }

    std::fs::remove_file(storage_path(conn).join(rel_path)).ok();
    conn.execute(
        "UPDATE employees SET passport_attachment_paths=?1, updated_at=datetime('now') WHERE id=?2",
        params!["[]", employee_id],
    )?;
    Ok(())
}

/// Copy a file into the employee's attachments folder.
/// Returns the relative path stored in the DB.
pub fn upload_attachment(conn: &Connection, employee_id: i64, source_path: &str) -> AppResult<String> {
    ensure_storage_layout(conn)?;
    let src  = Path::new(source_path);
    let name = src.file_name().ok_or_else(|| AppError::Validation("Invalid filename".into()))?;

    let dest_dir = storage_path(conn)
        .join("Files")
        .join("Employees")
        .join(employee_id.to_string())
        .join("Attachments");
    std::fs::create_dir_all(&dest_dir).map_err(|e| AppError::Other(e.to_string()))?;

    let dest = dest_dir.join(name);
    std::fs::copy(src, &dest).map_err(|e| AppError::Other(e.to_string()))?;

    // relative path for portability
    let rel = format!("Files/Employees/{}/Attachments/{}", employee_id, name.to_string_lossy());

    // update attachment_paths JSON array in DB
    let existing: String = conn.query_row(
        "SELECT COALESCE(attachment_paths,'[]') FROM employees WHERE id=?1",
        params![employee_id],
        |r| r.get(0),
    ).unwrap_or_else(|_| "[]".into());

    let mut paths: Vec<String> = serde_json::from_str(&existing).unwrap_or_default();
    if !paths.contains(&rel) {
        paths.push(rel.clone());
    }
    let new_json = serde_json::to_string(&paths).unwrap_or_default();
    conn.execute(
        "UPDATE employees SET attachment_paths=?1, updated_at=datetime('now') WHERE id=?2",
        params![new_json, employee_id],
    )?;
    Ok(rel)
}

/// Delete an attachment by its relative path.
pub fn delete_attachment(conn: &Connection, employee_id: i64, relative_path: &str) -> AppResult<()> {
    let rel_path = safe_relative_path(relative_path)?;
    let full = storage_path(conn).join(rel_path);
    std::fs::remove_file(&full).ok(); // ignore if already gone

    let existing: String = conn.query_row(
        "SELECT COALESCE(attachment_paths,'[]') FROM employees WHERE id=?1",
        params![employee_id],
        |r| r.get(0),
    ).unwrap_or_else(|_| "[]".into());

    let mut paths: Vec<String> = serde_json::from_str(&existing).unwrap_or_default();
    paths.retain(|p| p != relative_path);
    let new_json = serde_json::to_string(&paths).unwrap_or_default();
    conn.execute(
        "UPDATE employees SET attachment_paths=?1, updated_at=datetime('now') WHERE id=?2",
        params![new_json, employee_id],
    )?;
    Ok(())
}
