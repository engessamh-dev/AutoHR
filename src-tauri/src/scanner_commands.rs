//! Authenticated attachment bridge; the processing engine never owns domain records.
use super::*;

#[tauri::command]
pub(crate) fn cmd_get_document_download_name(
    state: State<DbState>,
    sess: State<SessionState>,
    relative_path: String,
) -> Result<String, AppError> {
    let conn = state.0.lock().unwrap();
    authorize(&conn, &sess, "documents.download")?;
    stored_document_path(&conn, &relative_path)?;
    scanner::export_name(&conn, &relative_path)
}
#[tauri::command]
pub(crate) fn cmd_scanner_settings(
    state: State<DbState>,
    sess: State<SessionState>,
) -> Result<scanner::ScannerSettings, AppError> {
    let conn = state.0.lock().unwrap();
    session_user(&sess)?;
    scanner::settings(&conn)
}
#[tauri::command]
pub(crate) fn cmd_set_scanner_settings(
    state: State<DbState>,
    sess: State<SessionState>,
    settings: scanner::ScannerSettings,
) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "settings.manage")?;
    scanner::set_settings(&conn, &user, settings)
}
#[tauri::command]
pub(crate) async fn cmd_scanner_prepare(
    state: State<'_, DbState>,
    sess: State<'_, SessionState>,
    source_path: Option<String>,
    relative_path: Option<String>,
    kind: String,
) -> Result<scanner::ScanPreview, AppError> {
    let target = relative_path.clone();
    let (owner, path, settings) = {
        let conn = state.0.lock().unwrap();
        let owner = session_user(&sess)?;
        let path = if let Some(relative) = relative_path {
            scanner::associated_path(&conn, &owner, &relative, true)?;
            scanner::original_path(&conn, &relative)?
        } else {
            let permission = match kind.as_str() {
                "cmd_upload_employee_photo" => "employees.edit",
                "cmd_upload_company_logo" => "settings.manage",
                _ => "documents.upload",
            };
            assert_permission(&conn, &owner, permission)?;
            std::path::PathBuf::from(
                source_path.ok_or_else(|| AppError::Validation("Select an image".into()))?,
            )
        };
        (owner, path, scanner::settings(&conn)?)
    };
    tauri::async_runtime::spawn_blocking(move || scanner::prepare(owner, &path, settings, target))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}
#[tauri::command]
pub(crate) async fn cmd_scanner_detect(
    sess: State<'_, SessionState>,
    token: String,
) -> Result<scanner::Detection, AppError> {
    let owner = session_user(&sess)?;
    tauri::async_runtime::spawn_blocking(move || scanner::redetect(&owner, &token))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}
#[tauri::command]
pub(crate) async fn cmd_scanner_versions(
    state: State<'_, DbState>,
    sess: State<'_, SessionState>,
    relative_path: String,
) -> Result<scanner::Versions, AppError> {
    let (original, processed) = {
        let conn = state.0.lock().unwrap();
        let owner = session_user(&sess)?;
        scanner::associated_path(&conn, &owner, &relative_path, false)?;
        (
            scanner::original_path(&conn, &relative_path)?,
            scanner::effective_path(&conn, &relative_path)?,
        )
    };
    tauri::async_runtime::spawn_blocking(move || scanner::preview_versions(original, processed))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}
#[tauri::command]
pub(crate) async fn cmd_scanner_render(
    sess: State<'_, SessionState>,
    token: String,
    corners: [[f32; 2]; 4],
    rotation: u16,
) -> Result<Vec<u8>, AppError> {
    let owner = session_user(&sess)?;
    tauri::async_runtime::spawn_blocking(move || scanner::render(&owner, &token, corners, rotation))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
}
#[tauri::command]
pub(crate) fn cmd_scanner_release(
    sess: State<SessionState>,
    token: String,
) -> Result<(), AppError> {
    scanner::release(&session_user(&sess)?, &token)
}
#[tauri::command]
pub(crate) fn cmd_scanner_save_existing(
    state: State<DbState>,
    sess: State<SessionState>,
    token: String,
    relative_path: String,
) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap();
    let owner = session_user(&sess)?;
    scanner::save_existing(&conn, &owner, &token, &relative_path)
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ScanUploadContext {
    pub employee_id: Option<i64>,
    pub doc_id: Option<i64>,
    pub side: Option<String>,
    pub member_index: Option<usize>,
    pub spouse_index: Option<usize>,
}
#[tauri::command]
pub(crate) fn cmd_scanner_upload(
    state: State<DbState>,
    sess: State<SessionState>,
    token: String,
    command: String,
    context: ScanUploadContext,
) -> Result<serde_json::Value, AppError> {
    let conn = state.0.lock().unwrap();
    let owner = session_user(&sess)?;
    scanner_upload(&conn, &owner, &token, &command, context)
}
pub(crate) fn scanner_upload(
    conn: &Connection,
    owner: &str,
    token: &str,
    command: &str,
    context: ScanUploadContext,
) -> Result<serde_json::Value, AppError> {
    let result = scanner_upload_inner(conn, owner, token, command, context);
    let _ = scanner::recover_pending_files(conn);
    result
}
fn scanner_upload_inner(
    conn: &Connection,
    owner: &str,
    token: &str,
    command: &str,
    context: ScanUploadContext,
) -> Result<serde_json::Value, AppError> {
    let permission = match command {
        "cmd_upload_employee_photo" => "employees.edit",
        "cmd_upload_company_logo" => "settings.manage",
        _ => "documents.upload",
    };
    assert_permission(conn, owner, permission)?;
    scanner::validate_target(owner, token, None)?;
    let source = scanner::stage(owner, token)?;
    let tx = conn.unchecked_transaction()?;
    let before: Vec<String> = {
        let mut stmt = tx.prepare("SELECT stored_path FROM document_metadata")?;
        let rows = stmt
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        rows
    };
    let missing = || AppError::Validation("Missing upload context".into());
    let result = (|| -> Result<serde_json::Value, AppError> {
        let rel = match command {
            "cmd_upload_company_logo" => {
                return serde_json::to_value(upload_company_logo(&tx, owner, &source)?)
                    .map_err(|e| AppError::Other(e.to_string()))
            }
            "cmd_upload_employee_photo" => {
                upload_employee_photo(&tx, context.employee_id.ok_or_else(missing)?, &source)?
            }
            "cmd_upload_attachment" => {
                files::upload_attachment(&tx, context.employee_id.ok_or_else(missing)?, &source)?
            }
            "cmd_upload_national_card_attachment" => files::upload_national_card_attachment(
                &tx,
                context.employee_id.ok_or_else(missing)?,
                context.side.as_deref().ok_or_else(missing)?,
                &source,
            )?,
            "cmd_upload_residence_card_attachment" => files::upload_residence_card_attachment(
                &tx,
                context.employee_id.ok_or_else(missing)?,
                context.side.as_deref().ok_or_else(missing)?,
                &source,
            )?,
            "cmd_upload_airport_badge_attachment" => files::upload_airport_badge_attachment(
                &tx,
                context.employee_id.ok_or_else(missing)?,
                context.side.as_deref().ok_or_else(missing)?,
                &source,
            )?,
            "cmd_upload_ministry_badge_attachment" => files::upload_ministry_badge_attachment(
                &tx,
                context.employee_id.ok_or_else(missing)?,
                context.side.as_deref().ok_or_else(missing)?,
                &source,
            )?,
            "cmd_upload_family_national_card_attachment" => {
                files::upload_family_national_card_attachment(
                    &tx,
                    context.employee_id.ok_or_else(missing)?,
                    context.member_index.ok_or_else(missing)?,
                    context.side.as_deref().ok_or_else(missing)?,
                    &source,
                )?
            }
            "cmd_upload_spouse_national_card_attachment" => {
                files::upload_spouse_national_card_attachment(
                    &tx,
                    context.employee_id.ok_or_else(missing)?,
                    context.spouse_index.ok_or_else(missing)?,
                    context.side.as_deref().ok_or_else(missing)?,
                    &source,
                )?
            }
            "cmd_upload_passport_attachment" => files::upload_passport_attachment(
                &tx,
                context.employee_id.ok_or_else(missing)?,
                &source,
            )?,
            "cmd_upload_ration_card_attachment" => files::upload_ration_card_attachment(
                &tx,
                context.employee_id.ok_or_else(missing)?,
                &source,
            )?,
            "cmd_upload_general_doc_file" => {
                upload_general_doc_file(&tx, context.doc_id.ok_or_else(missing)?, &source)?
            }
            "cmd_upload_outgoing_doc_file" => {
                upload_outgoing_doc_file(&tx, context.doc_id.ok_or_else(missing)?, &source)?
            }
            _ => return Err(AppError::Validation("Unsupported attachment target".into())),
        };
        scanner::audit_upload(
            &tx,
            owner,
            command,
            context.employee_id.or(context.doc_id),
            &rel,
        )?;
        Ok(serde_json::Value::String(rel))
    })();
    let new_paths: Vec<String> = {
        let mut stmt = tx.prepare("SELECT stored_path FROM document_metadata")?;
        let paths = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        paths.into_iter().filter(|p| !before.contains(p)).collect()
    };
    if result.is_err() {
        for p in &new_paths {
            scanner::cleanup_metadata_file(&tx, p);
        }
        return result;
    }
    let physical: Vec<std::path::PathBuf> = new_paths
        .iter()
        .flat_map(|p| {
            let original: Option<String> = tx
                .query_row(
                    "SELECT original_path FROM document_metadata WHERE stored_path=?1",
                    [p],
                    |r| r.get(0),
                )
                .ok()
                .flatten();
            std::iter::once(p.clone())
                .chain(original)
                .map(|v| storage_path(&tx).join(v))
                .collect::<Vec<_>>()
        })
        .collect();
    if let Err(e) = tx.commit() {
        for p in physical {
            std::fs::remove_file(p).ok();
        }
        return Err(e.into());
    }
    scanner::finish_upload(conn, token);
    result
}
