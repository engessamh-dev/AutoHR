// src-tauri/src/files.rs
use rusqlite::{params, Connection};
use rand::{rngs::OsRng, RngCore};
use std::{fs::File, io::Read, path::{Component, Path}};
use crate::services::{ensure_storage_layout, storage_path, AppError};

pub type AppResult<T> = Result<T, AppError>;

pub const MAX_DOCUMENT_SIZE: u64 = 20 * 1024 * 1024;
pub const MAX_IMAGE_SIZE: u64 = 5 * 1024 * 1024;

fn office_upload_type(source: &Path, extension: &str) -> Option<(&'static str, &'static str)> {
    match extension {
        "doc" => Some(("doc", "application/msword")),
        "xls" => Some(("xls", "application/vnd.ms-excel")),
        "ppt" => Some(("ppt", "application/vnd.ms-powerpoint")),
        "docx" | "xlsx" | "pptx" => {
            let file = File::open(source).ok()?;
            let mut archive = zip::ZipArchive::new(file).ok()?;
            let required_dir = match extension {
                "docx" => "word/",
                "xlsx" => "xl/",
                "pptx" => "ppt/",
                _ => return None,
            };
            let valid = archive.by_name("[Content_Types].xml").is_ok()
                && (0..archive.len()).any(|index| archive.by_index(index).is_ok_and(|entry| entry.name().is_ok_and(|name| name.starts_with(required_dir))));
            if !valid { return None; }
            Some(match extension {
                "docx" => ("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
                "xlsx" => ("xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
                "pptx" => ("pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"),
                _ => return None,
            })
        }
        _ => None,
    }
}

pub struct ValidatedUpload {
    pub original_name: String,
    pub extension: &'static str,
    pub mime_type: &'static str,
    pub size: u64,
}

pub fn safe_relative_path(relative_path: &str) -> AppResult<&Path> {
    let path = Path::new(relative_path);
    if path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir | Component::Prefix(_))) {
        return Err(AppError::Validation("Invalid attachment path".into()));
    }
    Ok(path)
}

pub fn validate_upload(source_path: &str, allow_pdf: bool, _allow_png: bool, max_size: u64) -> AppResult<ValidatedUpload> {
    let source = Path::new(source_path);
    let metadata = std::fs::metadata(source).map_err(|_| AppError::Validation("The selected file could not be read".into()))?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err(AppError::Validation("Select a non-empty file".into()));
    }
    if metadata.len() > max_size {
        return Err(AppError::Validation(format!("The selected file exceeds the {} MB limit", max_size / 1024 / 1024)));
    }
    let original_name = source.file_name().and_then(|n| n.to_str())
        .filter(|name| !name.is_empty()).ok_or_else(|| AppError::Validation("The selected filename is invalid".into()))?.to_string();
    let supplied_extension = source.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    let mut signature = [0u8; 12];
    let mut file = File::open(source).map_err(|_| AppError::Validation("The selected file could not be read".into()))?;
    let read = file.read(&mut signature).map_err(|_| AppError::Validation("The selected file could not be read".into()))?;
    let legacy_office_signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
    let office_type = if allow_pdf && ((read >= 4 && &signature[..4] == b"PK\x03\x04") || (read >= 8 && signature[..8] == legacy_office_signature)) {
        office_upload_type(source, &supplied_extension)
    } else {
        None
    };
    let (extension, mime_type) = if read >= 5 && &signature[..5] == b"%PDF-" && allow_pdf {
        ("pdf", "application/pdf")
    } else if read >= 3 && signature[..3] == [0xff, 0xd8, 0xff] {
        ("jpg", "image/jpeg")
    } else if read >= 8 && signature[..8] == [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a] {
        ("png", "image/png")
    } else if read >= 12 && &signature[..4] == b"RIFF" && &signature[8..12] == b"WEBP" {
        ("webp", "image/webp")
    } else if let Some(office_type) = office_type {
        office_type
    } else {
        return Err(AppError::Validation("Only valid PDF, image, Word, Excel, or PowerPoint files are allowed".into()));
    };
    if supplied_extension != extension && !(extension == "jpg" && supplied_extension == "jpeg") {
        return Err(AppError::Validation("The file extension does not match its contents".into()));
    }
    Ok(ValidatedUpload { original_name, extension, mime_type, size: metadata.len() })
}

pub fn random_filename(extension: &str) -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    format!("{}.{}", hex::encode(bytes), extension)
}
fn copy_new_file(source: &Path, destination: &Path) -> AppResult<()> {
    let mut input = File::open(source).map_err(|e| AppError::Other(e.to_string()))?;
    let mut output = std::fs::OpenOptions::new().write(true).create_new(true).open(destination)
        .map_err(|e| AppError::Other(e.to_string()))?;
    if let Err(error) = std::io::copy(&mut input, &mut output).and_then(|_| output.sync_all()) {
        drop(output); std::fs::remove_file(destination).ok();
        return Err(AppError::Other(error.to_string()));
    }
    Ok(())
}

pub fn copy_validated_upload(conn: &Connection, source_path: &str, destination_dir: &Path, relative_dir: &str,
    allow_pdf: bool, allow_png: bool, max_size: u64) -> AppResult<String> {
    let upload = validate_upload(source_path, allow_pdf, allow_png, max_size)?;
    let scanned_original = crate::scanner::original_for_stage(source_path).map(|(path, owner)| {
        let meta = validate_upload(path.to_str().ok_or_else(|| AppError::Validation("Invalid original path".into()))?, false, true, max_size)?;
        Ok::<_, AppError>((path, owner, meta))
    }).transpose()?;
    std::fs::create_dir_all(destination_dir).map_err(|e| AppError::Other(e.to_string()))?;
    let filename = random_filename(upload.extension);
    let destination = destination_dir.join(&filename);
    let rel = format!("{}/{}", relative_dir.trim_end_matches('/'), filename);
    let original_rel = scanned_original.as_ref().map(|(_,_,meta)|format!("{}/{}",relative_dir.trim_end_matches('/'),random_filename(meta.extension)));
    if let Some(original_path)=&original_rel { crate::scanner::register_pending_files(conn,&[rel.clone(),original_path.clone()])?; }
    copy_new_file(Path::new(source_path), &destination)?;
    if let Err(error) = conn.execute(
        "INSERT OR REPLACE INTO document_metadata(stored_path,original_name,mime_type,size_bytes) VALUES(?1,?2,?3,?4)",
        params![rel, upload.original_name, upload.mime_type, upload.size as i64],
    ) {
        std::fs::remove_file(destination).ok();
        return Err(error.into());
    }
    if let Some((original, owner, meta)) = scanned_original {
        let original_rel = original_rel.expect("scanned uploads register their original path");
        let original_dest = storage_path(conn).join(&original_rel);
        let result = (|| -> AppResult<()> {
            copy_new_file(&original, &original_dest)?;
            conn.execute("UPDATE document_metadata SET original_name=?1, original_path=?2 WHERE stored_path=?3", params![meta.original_name, original_rel, rel])?;
            crate::scanner::audit_processing(conn, &owner, &rel)?;
            Ok(())
        })();
        if let Err(error) = result {
            std::fs::remove_file(&destination).ok(); std::fs::remove_file(&original_dest).ok();
            conn.execute("DELETE FROM document_metadata WHERE stored_path=?1", params![rel]).ok();
            return Err(error);
        }
    }
    Ok(rel)
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

fn airport_badge_column(side: &str) -> AppResult<&'static str> {
    match side {
        "front" => Ok("airport_badge_front_path"),
        "back" => Ok("airport_badge_back_path"),
        _ => Err(AppError::Validation("Invalid airport badge side".into())),
    }
}

fn ministry_badge_column(side: &str) -> AppResult<&'static str> {
    match side {
        "front" => Ok("ministry_badge_front_path"),
        "back" => Ok("ministry_badge_back_path"),
        _ => Err(AppError::Validation("Invalid ministry badge side".into())),
    }
}

fn upload_sided_card_attachment(
    conn: &Connection,
    employee_id: i64,
    _side: &str,
    source_path: &str,
    column: &str,
    folder: &str,
) -> AppResult<String> {
    ensure_storage_layout(conn)?;
    let previous: Option<String> = conn.query_row(
        &format!("SELECT {} FROM employees WHERE id=?1", column),
        params![employee_id],
        |r| r.get(0),
    ).map_err(|_| AppError::NotFound)?;
    let dest_dir = storage_path(conn)
        .join("Files").join("Employees").join(employee_id.to_string())
        .join("Documents").join(folder);
    let rel = copy_validated_upload(conn, source_path, &dest_dir,
        &format!("Files/Employees/{}/Documents/{}", employee_id, folder), true, false, MAX_DOCUMENT_SIZE)?;
    conn.execute(
        &format!("UPDATE employees SET {}=?1, updated_at=datetime('now') WHERE id=?2", column),
        params![rel, employee_id],
    )?;
    if let Some(old) = previous {
        if old != rel {
            if let Ok(path) = safe_relative_path(&old) {
                crate::scanner::remove_replaced(conn, source_path, path);
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
    conn.execute(
        &format!("UPDATE employees SET {}=NULL, updated_at=datetime('now') WHERE id=?1", column),
        params![employee_id],
    )?;
    if let Some(relative_path) = existing {
        let path = safe_relative_path(&relative_path)?;
        crate::scanner::cleanup_metadata_file(conn, &path.to_string_lossy());
    }
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

pub fn delete_employee_photo(conn: &Connection, employee_id: i64) -> AppResult<()> {
    delete_sided_card_attachment(conn, employee_id, "photo_path")
}

pub fn delete_national_card_attachment(
    conn: &Connection,
    employee_id: i64,
    side: &str,
) -> AppResult<()> {
    let column = national_card_column(side)?;
    delete_sided_card_attachment(conn, employee_id, column)
}

fn family_national_card_key(side: &str) -> AppResult<&'static str> {
    match side {
        "front" => Ok("national_card_front_path"),
        "back" => Ok("national_card_back_path"),
        _ => Err(AppError::Validation("Invalid family national card side".into())),
    }
}

fn family_members_json(conn: &Connection, employee_id: i64) -> AppResult<Vec<serde_json::Value>> {
    let mut stmt = conn.prepare(
        "SELECT civil_id,name,gender,birthplace,birthdate,issue_date,expiry_date,issuer,blood_type,national_card_front_path,national_card_back_path
         FROM employee_family_members WHERE employee_id=?1 ORDER BY sort_order,id"
    )?;
    let members = stmt.query_map(params![employee_id], |row| {
        Ok(serde_json::json!({
            "civil_id": row.get::<_, Option<String>>(0)?.unwrap_or_default(),
            "name": row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            "gender": row.get::<_, Option<String>>(2)?.unwrap_or_default(),
            "birthplace": row.get::<_, Option<String>>(3)?.unwrap_or_default(),
            "birthdate": row.get::<_, Option<String>>(4)?.unwrap_or_default(),
            "issue_date": row.get::<_, Option<String>>(5)?.unwrap_or_default(),
            "expiry_date": row.get::<_, Option<String>>(6)?.unwrap_or_default(),
            "issuer": row.get::<_, Option<String>>(7)?.unwrap_or_default(),
            "blood_type": row.get::<_, Option<String>>(8)?.unwrap_or_default(),
            "national_card_front_path": row.get::<_, Option<String>>(9)?.unwrap_or_default(),
            "national_card_back_path": row.get::<_, Option<String>>(10)?.unwrap_or_default(),
        }))
    })?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(members)
}

pub fn upload_family_national_card_attachment(
    conn: &Connection,
    employee_id: i64,
    member_index: usize,
    side: &str,
    source_path: &str,
) -> AppResult<String> {
    ensure_storage_layout(conn)?;
    let key = family_national_card_key(side)?;
    let mut members = family_members_json(conn, employee_id)?;
    let member = members.get_mut(member_index).ok_or(AppError::NotFound)?;
    let member_object = member.as_object_mut()
        .ok_or_else(|| AppError::Validation("Invalid family member data".into()))?;
    let previous = member_object.get(key).and_then(|value| value.as_str()).map(str::to_owned);
    let dest_dir = storage_path(conn)
        .join("Files").join("Employees").join(employee_id.to_string())
        .join("Family").join((member_index + 1).to_string()).join("NationalCard");
    let rel = copy_validated_upload(conn, source_path, &dest_dir,
        &format!("Files/Employees/{}/Family/{}/NationalCard", employee_id, member_index + 1),
        true, false, MAX_DOCUMENT_SIZE)?;
    member_object.insert(key.to_string(), serde_json::Value::String(rel.clone()));
    let updated = conn.execute(
        &format!("UPDATE employee_family_members SET {}=?1, updated_at=datetime('now') WHERE employee_id=?2 AND sort_order=?3", key),
        params![rel, employee_id, member_index as i64],
    )?;
    if updated == 0 {
        return Err(AppError::NotFound);
    }
    if let Some(old) = previous {
        if old != rel {
            if let Ok(path) = safe_relative_path(&old) {
                crate::scanner::remove_replaced(conn, source_path, path);
            }
        }
    }
    Ok(rel)
}

pub fn delete_family_national_card_attachment(
    conn: &Connection,
    employee_id: i64,
    member_index: usize,
    side: &str,
) -> AppResult<()> {
    let key = family_national_card_key(side)?;
    let mut members = family_members_json(conn, employee_id)?;
    let member = members.get_mut(member_index).ok_or(AppError::NotFound)?;
    let member_object = member.as_object_mut()
        .ok_or_else(|| AppError::Validation("Invalid family member data".into()))?;
    let existing = member_object.remove(key).and_then(|value| value.as_str().map(str::to_owned));
    let updated = conn.execute(
        &format!("UPDATE employee_family_members SET {}=NULL, updated_at=datetime('now') WHERE employee_id=?1 AND sort_order=?2", key),
        params![employee_id, member_index as i64],
    )?;
    if updated == 0 {
        return Err(AppError::NotFound);
    }
    if let Some(relative_path) = existing {
        let path = safe_relative_path(&relative_path)?;
        crate::scanner::cleanup_metadata_file(conn, &path.to_string_lossy());
    }
    Ok(())
}

fn spouses_json(conn: &Connection, employee_id: i64) -> AppResult<Vec<serde_json::Value>> {
    let mut stmt = conn.prepare(
        "SELECT civil_id,name,mother_name,gender,birthplace,birthdate,issue_date,expiry_date,issuer,blood_type,marriage_date,national_card_front_path,national_card_back_path
         FROM employee_spouses WHERE employee_id=?1 ORDER BY sort_order,id"
    )?;
    let spouses = stmt.query_map(params![employee_id], |row| {
        Ok(serde_json::json!({
            "civil_id": row.get::<_, Option<String>>(0)?.unwrap_or_default(),
            "name": row.get::<_, Option<String>>(1)?.unwrap_or_default(),
            "mother_name": row.get::<_, Option<String>>(2)?.unwrap_or_default(),
            "gender": row.get::<_, Option<String>>(3)?.unwrap_or_default(),
            "birthplace": row.get::<_, Option<String>>(4)?.unwrap_or_default(),
            "birthdate": row.get::<_, Option<String>>(5)?.unwrap_or_default(),
            "issue_date": row.get::<_, Option<String>>(6)?.unwrap_or_default(),
            "expiry_date": row.get::<_, Option<String>>(7)?.unwrap_or_default(),
            "issuer": row.get::<_, Option<String>>(8)?.unwrap_or_default(),
            "blood_type": row.get::<_, Option<String>>(9)?.unwrap_or_default(),
            "marriage_date": row.get::<_, Option<String>>(10)?.unwrap_or_default(),
            "national_card_front_path": row.get::<_, Option<String>>(11)?.unwrap_or_default(),
            "national_card_back_path": row.get::<_, Option<String>>(12)?.unwrap_or_default(),
        }))
    })?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(spouses)
}

pub fn upload_spouse_national_card_attachment(
    conn: &Connection,
    employee_id: i64,
    spouse_index: usize,
    side: &str,
    source_path: &str,
) -> AppResult<String> {
    ensure_storage_layout(conn)?;
    if spouse_index >= 4 {
        return Err(AppError::Validation("Only up to 4 spouses are allowed".into()));
    }
    let key = family_national_card_key(side)?;
    let mut spouses = spouses_json(conn, employee_id)?;
    let spouse = spouses.get_mut(spouse_index).ok_or(AppError::NotFound)?;
    let spouse_object = spouse.as_object_mut()
        .ok_or_else(|| AppError::Validation("Invalid spouse data".into()))?;
    let previous = spouse_object.get(key).and_then(|value| value.as_str()).map(str::to_owned);
    let dest_dir = storage_path(conn)
        .join("Files").join("Employees").join(employee_id.to_string())
        .join("Spouses").join((spouse_index + 1).to_string()).join("NationalCard");
    let rel = copy_validated_upload(conn, source_path, &dest_dir,
        &format!("Files/Employees/{}/Spouses/{}/NationalCard", employee_id, spouse_index + 1),
        true, false, MAX_DOCUMENT_SIZE)?;
    spouse_object.insert(key.to_string(), serde_json::Value::String(rel.clone()));
    let updated = conn.execute(
        &format!("UPDATE employee_spouses SET {}=?1, updated_at=datetime('now') WHERE employee_id=?2 AND sort_order=?3", key),
        params![rel, employee_id, spouse_index as i64],
    )?;
    if updated == 0 {
        return Err(AppError::NotFound);
    }
    if let Some(old) = previous {
        if old != rel {
            if let Ok(path) = safe_relative_path(&old) {
                crate::scanner::remove_replaced(conn, source_path, path);
            }
        }
    }
    Ok(rel)
}

pub fn delete_spouse_national_card_attachment(
    conn: &Connection,
    employee_id: i64,
    spouse_index: usize,
    side: &str,
) -> AppResult<()> {
    if spouse_index >= 4 {
        return Err(AppError::Validation("Only up to 4 spouses are allowed".into()));
    }
    let key = family_national_card_key(side)?;
    let mut spouses = spouses_json(conn, employee_id)?;
    let spouse = spouses.get_mut(spouse_index).ok_or(AppError::NotFound)?;
    let spouse_object = spouse.as_object_mut()
        .ok_or_else(|| AppError::Validation("Invalid spouse data".into()))?;
    let existing = spouse_object.remove(key).and_then(|value| value.as_str().map(str::to_owned));
    let updated = conn.execute(
        &format!("UPDATE employee_spouses SET {}=NULL, updated_at=datetime('now') WHERE employee_id=?1 AND sort_order=?2", key),
        params![employee_id, spouse_index as i64],
    )?;
    if updated == 0 {
        return Err(AppError::NotFound);
    }
    if let Some(relative_path) = existing {
        let path = safe_relative_path(&relative_path)?;
        crate::scanner::cleanup_metadata_file(conn, &path.to_string_lossy());
    }
    Ok(())
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

pub fn upload_airport_badge_attachment(
    conn: &Connection,
    employee_id: i64,
    side: &str,
    source_path: &str,
) -> AppResult<String> {
    let column = airport_badge_column(side)?;
    upload_sided_card_attachment(conn, employee_id, side, source_path, column, "AirportBadge")
}

pub fn delete_airport_badge_attachment(
    conn: &Connection,
    employee_id: i64,
    side: &str,
) -> AppResult<()> {
    let column = airport_badge_column(side)?;
    delete_sided_card_attachment(conn, employee_id, column)
}

pub fn upload_ministry_badge_attachment(
    conn: &Connection,
    employee_id: i64,
    side: &str,
    source_path: &str,
) -> AppResult<String> {
    let column = ministry_badge_column(side)?;
    upload_sided_card_attachment(conn, employee_id, side, source_path, column, "MinistryBadge")
}

pub fn delete_ministry_badge_attachment(
    conn: &Connection,
    employee_id: i64,
    side: &str,
) -> AppResult<()> {
    let column = ministry_badge_column(side)?;
    delete_sided_card_attachment(conn, employee_id, column)
}

pub fn upload_passport_attachment(
    conn: &Connection,
    employee_id: i64,
    source_path: &str,
) -> AppResult<String> {
    ensure_storage_layout(conn)?;
    let dest_dir = storage_path(conn)
        .join("Files")
        .join("Employees")
        .join(employee_id.to_string())
        .join("Documents")
        .join("Passport");
    let rel = copy_validated_upload(conn, source_path, &dest_dir,
        &format!("Files/Employees/{}/Documents/Passport", employee_id), true, false, MAX_DOCUMENT_SIZE)?;
    let existing: String = conn.query_row(
        "SELECT COALESCE(passport_attachment_paths,'[]') FROM employees WHERE id=?1",
        params![employee_id],
        |r| r.get(0),
    ).map_err(|_| AppError::NotFound)?;
    let paths: Vec<String> = serde_json::from_str(&existing).unwrap_or_default();

    conn.execute(
        "UPDATE employees SET passport_attachment_paths=?1, updated_at=datetime('now') WHERE id=?2",
        params![serde_json::to_string(&vec![rel.clone()]).map_err(|e| AppError::Other(e.to_string()))?, employee_id],
    )?;
    conn.execute("DELETE FROM employee_attachments WHERE employee_id=?1 AND kind='passport'", params![employee_id])?;
    conn.execute(
        "INSERT INTO employee_attachments(employee_id,kind,file_path,sort_order) VALUES(?1,'passport',?2,0)",
        params![employee_id, rel],
    )?;
    for old in paths {
        if old != rel {
            if let Ok(path) = safe_relative_path(&old) {
                crate::scanner::remove_replaced(conn, source_path, path);
            }
        }
    }
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

    conn.execute(
        "UPDATE employees SET passport_attachment_paths=?1, updated_at=datetime('now') WHERE id=?2",
        params!["[]", employee_id],
    )?;
    conn.execute(
        "DELETE FROM employee_attachments WHERE employee_id=?1 AND kind='passport' AND file_path=?2",
        params![employee_id, relative_path],
    )?;
    crate::scanner::cleanup_metadata_file(conn, &rel_path.to_string_lossy());
    Ok(())
}

/// Replace the employee's ration card attachment and return its relative path.
pub fn upload_ration_card_attachment(
    conn: &Connection,
    employee_id: i64,
    source_path: &str,
) -> AppResult<String> {
    ensure_storage_layout(conn)?;
    let dest_dir = storage_path(conn)
        .join("Files")
        .join("Employees")
        .join(employee_id.to_string())
        .join("Documents")
        .join("RationCard");
    let rel = copy_validated_upload(conn, source_path, &dest_dir,
        &format!("Files/Employees/{}/Documents/RationCard", employee_id), true, false, MAX_DOCUMENT_SIZE)?;
    let existing: String = conn.query_row(
        "SELECT COALESCE(ration_card_attachment_paths,'[]') FROM employees WHERE id=?1",
        params![employee_id],
        |r| r.get(0),
    ).map_err(|_| AppError::NotFound)?;
    let paths: Vec<String> = serde_json::from_str(&existing).unwrap_or_default();

    conn.execute(
        "UPDATE employees SET ration_card_attachment_paths=?1, updated_at=datetime('now') WHERE id=?2",
        params![serde_json::to_string(&vec![rel.clone()]).map_err(|e| AppError::Other(e.to_string()))?, employee_id],
    )?;
    conn.execute("DELETE FROM employee_attachments WHERE employee_id=?1 AND kind='ration_card'", params![employee_id])?;
    conn.execute(
        "INSERT INTO employee_attachments(employee_id,kind,file_path,sort_order) VALUES(?1,'ration_card',?2,0)",
        params![employee_id, rel],
    )?;
    for old in paths {
        if old != rel {
            if let Ok(path) = safe_relative_path(&old) {
                crate::scanner::remove_replaced(conn, source_path, path);
            }
        }
    }
    Ok(rel)
}

pub fn delete_ration_card_attachment(
    conn: &Connection,
    employee_id: i64,
    relative_path: &str,
) -> AppResult<()> {
    let rel_path = safe_relative_path(relative_path)?;
    let expected_prefix = format!("Files/Employees/{}/Documents/RationCard/", employee_id);
    if !relative_path.replace('\\', "/").starts_with(&expected_prefix) {
        return Err(AppError::Validation("Invalid ration card attachment path".into()));
    }

    let existing: String = conn.query_row(
        "SELECT COALESCE(ration_card_attachment_paths,'[]') FROM employees WHERE id=?1",
        params![employee_id],
        |r| r.get(0),
    ).map_err(|_| AppError::NotFound)?;
    let paths: Vec<String> = serde_json::from_str(&existing).unwrap_or_default();
    if paths.first().is_none_or(|path| path != relative_path) {
        return Err(AppError::NotFound);
    }

    conn.execute(
        "UPDATE employees SET ration_card_attachment_paths=?1, updated_at=datetime('now') WHERE id=?2",
        params!["[]", employee_id],
    )?;
    conn.execute(
        "DELETE FROM employee_attachments WHERE employee_id=?1 AND kind='ration_card' AND file_path=?2",
        params![employee_id, relative_path],
    )?;
    crate::scanner::cleanup_metadata_file(conn, &rel_path.to_string_lossy());
    Ok(())
}

pub fn upload_attachment(conn: &Connection, employee_id: i64, source_path: &str) -> AppResult<String> {
    ensure_storage_layout(conn)?;
    let dest_dir = storage_path(conn)
        .join("Files").join("Employees").join(employee_id.to_string()).join("Attachments");
    let rel = copy_validated_upload(conn, source_path, &dest_dir,
        &format!("Files/Employees/{}/Attachments", employee_id), true, false, MAX_DOCUMENT_SIZE)?;
    let existing: String = conn.query_row(
        "SELECT COALESCE(attachment_paths,'[]') FROM employees WHERE id=?1",
        params![employee_id], |r| r.get(0),
    ).unwrap_or_else(|_| "[]".into());
    let mut paths: Vec<String> = serde_json::from_str(&existing).unwrap_or_default();
    if !paths.contains(&rel) { paths.push(rel.clone()); }
    conn.execute(
        "UPDATE employees SET attachment_paths=?1, updated_at=datetime('now') WHERE id=?2",
        params![serde_json::to_string(&paths).unwrap_or_default(), employee_id],
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO employee_attachments(employee_id,kind,file_path,sort_order)
         VALUES(?1,'general',?2,COALESCE((SELECT MAX(sort_order)+1 FROM employee_attachments WHERE employee_id=?1 AND kind='general'),0))",
        params![employee_id, rel],
    )?;
    Ok(rel)
}

pub fn delete_attachment(conn: &Connection, employee_id: i64, relative_path: &str) -> AppResult<()> {
    let rel_path = safe_relative_path(relative_path)?;
    let expected_prefix = format!("Files/Employees/{}/Attachments/", employee_id);
    if !relative_path.replace('\\', "/").starts_with(&expected_prefix) {
        return Err(AppError::Validation("Invalid attachment path".into()));
    }
    let existing: String = conn.query_row(
        "SELECT COALESCE(attachment_paths,'[]') FROM employees WHERE id=?1",
        params![employee_id], |r| r.get(0),
    ).unwrap_or_else(|_| "[]".into());
    let mut paths: Vec<String> = serde_json::from_str(&existing).unwrap_or_default();
    if !paths.iter().any(|path| path == relative_path) { return Err(AppError::NotFound); }
    paths.retain(|path| path != relative_path);
    conn.execute(
        "UPDATE employees SET attachment_paths=?1, updated_at=datetime('now') WHERE id=?2",
        params![serde_json::to_string(&paths).unwrap_or_default(), employee_id],
    )?;
    conn.execute(
        "DELETE FROM employee_attachments WHERE employee_id=?1 AND kind='general' AND file_path=?2",
        params![employee_id, relative_path],
    )?;
    crate::scanner::cleanup_metadata_file(conn, &rel_path.to_string_lossy());
    Ok(())
}

#[cfg(test)]
mod security_tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn rejects_path_traversal() {
        assert!(safe_relative_path("../database.db").is_err());
        assert!(safe_relative_path("Files/Employees/1/doc.pdf").is_ok());
    }

    #[test]
    fn validates_signature_and_extension() {
        let dir = tempfile::tempdir().unwrap();
        let valid = dir.path().join("document.pdf");
        std::fs::write(&valid, b"%PDF-1.7\nsafe").unwrap();
        assert!(validate_upload(valid.to_str().unwrap(), true, false, MAX_DOCUMENT_SIZE).is_ok());
        let spoofed = dir.path().join("malware.pdf");
        std::fs::write(&spoofed, b"MZ executable").unwrap();
        assert!(validate_upload(spoofed.to_str().unwrap(), true, false, MAX_DOCUMENT_SIZE).is_err());
    }

    #[test]
    fn rejects_oversized_upload() {
        let mut file = tempfile::NamedTempFile::new().unwrap();
        file.write_all(b"%PDF-").unwrap();
        file.as_file().set_len(1025).unwrap();
        assert!(validate_upload(file.path().to_str().unwrap(), true, false, 1024).is_err());
    }

    #[test]
    fn internal_names_are_random() {
        assert_ne!(random_filename("pdf"), random_filename("pdf"));
    }
}
