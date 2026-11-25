//! Authenticated attachment bridge; the processing engine never owns domain records.
use super::*;

#[tauri::command]
pub(crate) fn cmd_get_document_download_name(
    state: State<DbState>,
    sess: State<SessionState>,
    relative_path: String,
) -> Result<String, AppError> {
    let conn = state.conn()?;
    authorize(&conn, &sess, "documents.download")?;
    stored_document_path(&conn, &relative_path)?;
    scanner::export_name(&conn, &relative_path)
}
#[tauri::command]
pub(crate) fn cmd_scanner_settings(
    state: State<DbState>,
    sess: State<SessionState>,
) -> Result<scanner::ScannerSettings, AppError> {
    let conn = state.conn()?;
    session_user(&sess)?;
    scanner::settings(&conn)
}
#[tauri::command]
pub(crate) fn cmd_set_scanner_settings(
    state: State<DbState>,
    sess: State<SessionState>,
    settings: scanner::ScannerSettings,
) -> Result<(), AppError> {
    let conn = state.conn()?;
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
        let conn = state.conn()?;
        let owner = session_user(&sess)?;
        let path = if let Some(relative) = relative_path {
            scanner::associated_path(&conn, &owner, &relative, true)?;
            scanner::original_path(&conn, &relative)?
        } else {
            let permission = match kind.as_str() {
                "cmd_upload_employee_photo" => "employees.edit",
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
        let conn = state.conn()?;
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
    adjustments: Option<scanner::Adjustments>,
) -> Result<tauri::ipc::Response, AppError> {
    let owner = session_user(&sess)?;
    let adjustments = adjustments.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || scanner::render(&owner, &token, corners, rotation, adjustments))
        .await
        .map_err(|e| AppError::Other(e.to_string()))?
        .map(tauri::ipc::Response::new)
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
    let conn = state.conn()?;
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
    pub vehicle_index: Option<usize>,
}
#[tauri::command]
pub(crate) fn cmd_scanner_upload(
    state: State<DbState>,
    sess: State<SessionState>,
    token: String,
    command: String,
    context: ScanUploadContext,
) -> Result<serde_json::Value, AppError> {
    let conn = state.conn()?;
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
            "cmd_upload_vehicle_annual_attachment" => files::upload_vehicle_annual_attachment(
                &tx,
                context.employee_id.ok_or_else(missing)?,
                context.vehicle_index.ok_or_else(missing)?,
                context.side.as_deref().ok_or_else(missing)?,
                &source,
            )?,
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
/// Reads the fields of a stored national card or passport image on this device. The image and the
/// text never leave the computer, and nothing is written: the user reviews the values in the form.
#[tauri::command]
pub(crate) async fn cmd_read_document_fields(
    state: State<'_, DbState>,
    sess: State<'_, SessionState>,
    relative_path: String,
) -> Result<ocr_parse::ReadResult, AppError> {
    let path = {
        let conn = state.conn()?;
        let owner = authorize(&conn, &sess, "employees.edit")?;
        scanner::associated_path(&conn, &owner, &relative_path, false)?;
        let path = scanner::effective_path(&conn, &relative_path)?;
        log_audit(&conn, Some(&owner), "DOCUMENT_TEXT_READ", Some("document"), None, Some(&relative_path), "Success", None);
        path
    };
    tauri::async_runtime::spawn_blocking(move || {
        let image = scanner::load_image(&path)
            .map_err(|_| AppError::Validation("قراءة البيانات تعمل على الصور فقط (JPEG أو PNG أو WebP)".into()))?;
        let lines = ocr::read_lines(&image).ok_or_else(|| AppError::Other("text reader unavailable".into()))?;
        Ok(ocr_parse::parse_with_codes(&lines, &ocr::read_qr_codes(&image)))
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

/// What the add-employee wizard gets back for one picked or scanned image.
#[derive(serde::Serialize)]
pub(crate) struct ImageReading {
    pub result: ocr_parse::ReadResult,
    /// A small JPEG of the image, upright, for the wizard to show beside the read values.
    pub preview: Vec<u8>,
    /// Where each printed value was read, as fractions of the preview: key -> [x0, y0, x1, y1].
    pub regions: std::collections::HashMap<String, [f32; 4]>,
    /// Quarter turns that made the image upright: a crop of the preview maps back to the file.
    pub turns: u8,
    /// On a national card front: a first guess of where the personal photo is (fractions of the
    /// preview), for «قصّ من البطاقة الوطنية». The user adjusts it.
    pub face: Option<[f32; 4]>,
}

/// Reads the fields of a document image the user just picked (or scanned) for a new employee.
/// Nothing is stored: the wizard uploads the file with the usual upload commands after saving.
#[tauri::command]
pub(crate) async fn cmd_read_image_fields(
    state: State<'_, DbState>,
    sess: State<'_, SessionState>,
    source_path: String,
) -> Result<ImageReading, AppError> {
    {
        let conn = state.conn()?;
        let owner = authorize(&conn, &sess, "employees.create")?;
        assert_permission(&conn, &owner, "documents.upload")?;
        let upload = files::validate_upload(&source_path, false, true, 25 * 1024 * 1024)?;
        if !upload.mime_type.starts_with("image/") {
            return Err(AppError::Validation("قراءة البيانات تعمل على الصور فقط (JPEG أو PNG أو WebP)".into()));
        }
        log_audit(&conn, Some(&owner), "DOCUMENT_TEXT_READ", Some("document"), None, Some("add-employee wizard"), "Success", None);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let image = scanner::load_image(std::path::Path::new(&source_path))
            .map_err(|_| AppError::Validation("قراءة البيانات تعمل على الصور فقط (JPEG أو PNG أو WebP)".into()))?;
        let Some((lines, upright, turns)) = ocr::read_lines_upright(&image) else {
            return Err(AppError::Other("text reader unavailable".into()));
        };
        let result = ocr_parse::parse_with_codes(&lines, &ocr::read_qr_codes(&image));
        let (w, h) = (upright.width().max(1) as f32, upright.height().max(1) as f32);
        let regions = ocr_parse::locate(&result, &lines)
            .into_iter()
            .map(|(key, b)| (key, [(b[0] / w).clamp(0., 1.), (b[1] / h).clamp(0., 1.), (b[2] / w).clamp(0., 1.), (b[3] / h).clamp(0., 1.)]))
            .collect();
        let face = matches!(result.document.as_str(), "national_front" | "national").then(|| face_guess(&lines, w, h)).flatten();
        let preview = scanner::jpeg(&scanner::thumbnail(&image::DynamicImage::ImageRgb8(upright), 900), 85)?;
        Ok(ImageReading { result, preview, regions, turns, face })
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
}

/// The personal photo on a national card front: no text is printed over it. Taken as the widest
/// column left of the text, from below the top header to the bottom of the text, at a portrait
/// shape. Only a starting point for the user's crop box.
fn face_guess(lines: &[ocr::Line], w: f32, h: f32) -> Option<[f32; 4]> {
    if lines.len() < 4 {
        return None;
    }
    let top = lines.iter().map(|l| l.bbox[1]).fold(f32::MAX, f32::min);
    let bottom = lines.iter().map(|l| l.bbox[3]).fold(f32::MIN, f32::max);
    let left = lines.iter().map(|l| l.bbox[0]).fold(f32::MAX, f32::min);
    let right = lines.iter().map(|l| l.bbox[2]).fold(f32::MIN, f32::max);
    // Rows in the lower part of the card: the photo sits left of where they start.
    let body_top = top + (bottom - top) * 0.3;
    let body_left = lines.iter().filter(|l| l.bbox[1] >= body_top).map(|l| l.bbox[0]).fold(f32::MAX, f32::min);
    let width = (right - left).max(1.);
    let (x0, x1) = if body_left - left > width * 0.15 { (left, body_left) } else { (left, left + width * 0.28) };
    // Text printed under the photo (a card number) ends it; otherwise the text's bottom does.
    let under = lines
        .iter()
        .filter(|l| l.bbox[1] >= body_top && l.bbox[2] <= x1 + width * 0.05)
        .map(|l| l.bbox[1])
        .fold(f32::MAX, f32::min);
    let end = if under < f32::MAX { under - (x1 - x0) * 0.03 } else { bottom };
    let photo_h = ((x1 - x0) * 1.3).min(end - top);
    let y0 = end - photo_h;
    Some([(x0 / w).clamp(0., 1.), (y0 / h).clamp(0., 1.), (x1 / w).clamp(0., 1.), (end / h).clamp(0., 1.)])
}

/// A small upright-as-stored JPEG of a picked image, for the wizard's photo crop box (the asset
/// protocol only serves the data folder). Nothing is stored.
#[tauri::command]
pub(crate) async fn cmd_image_preview(
    state: State<'_, DbState>,
    sess: State<'_, SessionState>,
    source_path: String,
) -> Result<tauri::ipc::Response, AppError> {
    {
        let conn = state.conn()?;
        authorize(&conn, &sess, "employees.create")?;
        let upload = files::validate_upload(&source_path, false, true, 25 * 1024 * 1024)?;
        if !upload.mime_type.starts_with("image/") {
            return Err(AppError::Validation("الصورة الشخصية: JPEG أو PNG أو WebP".into()));
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        let image = scanner::load_image(std::path::Path::new(&source_path))?;
        scanner::jpeg(&scanner::thumbnail(&image, 900), 85)
    })
    .await
    .map_err(|e| AppError::Other(e.to_string()))?
    .map(tauri::ipc::Response::new)
}

/// Saves part of a picked image as the employee's personal photo: the image is turned upright
/// as the reader turned it (`turns`), then cut to `rect` (fractions of the upright image).
#[tauri::command]
pub(crate) fn cmd_upload_employee_photo_crop(
    state: State<DbState>,
    sess: State<SessionState>,
    employee_id: i64,
    source_path: String,
    turns: u8,
    rect: [f32; 4],
) -> Result<String, AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "employees.edit")?;
    files::validate_upload(&source_path, false, true, 25 * 1024 * 1024)?;
    let image = scanner::load_image(std::path::Path::new(&source_path))?;
    let photo = crop_upright(&image, turns, rect)?;
    let temp = tempfile::Builder::new().prefix("autohr-photo-").suffix(".jpg").tempfile().map_err(|e| AppError::Other(e.to_string()))?;
    std::fs::write(temp.path(), scanner::jpeg(&photo, 92)?).map_err(|e| AppError::Other(e.to_string()))?;
    let path = temp.path().to_str().ok_or_else(|| AppError::Validation("Invalid path".into()))?.to_owned();
    let result = crate::services::upload_employee_photo(&conn, employee_id, &path)?;
    crate::services::log_activity(&conn, &user, "UPLOAD_DOCUMENT", Some("employee"), Some(employee_id), Some(&result), Some("photo"));
    Ok(result)
}

pub(crate) fn crop_upright(image: &image::DynamicImage, turns: u8, rect: [f32; 4]) -> Result<image::DynamicImage, AppError> {
    let upright = ocr::rotate(&image.to_rgb8(), turns % 4);
    let (w, h) = (upright.width() as f32, upright.height() as f32);
    let [x0, y0, x1, y1] = rect.map(|v| if v.is_finite() { v.clamp(0., 1.) } else { 0. });
    let (left, top) = ((x0.min(x1) * w) as u32, (y0.min(y1) * h) as u32);
    let (width, height) = (((x1 - x0).abs() * w) as u32, ((y1 - y0).abs() * h) as u32);
    if width < 16 || height < 16 {
        return Err(AppError::Validation("منطقة الصورة صغيرة جدًا".into()));
    }
    Ok(image::DynamicImage::ImageRgb8(image::imageops::crop_imm(&upright, left, top, width, height).to_image()))
}

#[cfg(test)]
mod photo_tests {
    use super::*;

    #[test]
    fn crop_turns_the_image_upright_then_cuts_the_fractions() {
        // 40 x 20, red on the left half: one quarter turn makes it 20 x 40 with red on the top half.
        let mut img = image::RgbImage::new(40, 20);
        for (x, _, p) in img.enumerate_pixels_mut() { *p = if x < 20 { image::Rgb([255, 0, 0]) } else { image::Rgb([0, 0, 255]) }; }
        let source = image::DynamicImage::ImageRgb8(img);
        let unturned = crop_upright(&source, 0, [0., 0., 0.5, 1.]).unwrap().to_rgb8();
        assert_eq!((unturned.width(), unturned.height()), (20, 20));
        assert!(unturned.pixels().all(|p| p.0 == [255, 0, 0]));
        let turned = crop_upright(&source, 1, [0., 0., 1., 0.5]).unwrap().to_rgb8();
        assert_eq!((turned.width(), turned.height()), (20, 20));
        let colours: std::collections::HashSet<_> = turned.pixels().map(|p| p.0).collect();
        assert_eq!(colours.len(), 1);
        assert!(crop_upright(&source, 0, [0., 0., 0.1, 0.1]).is_err());
        assert!(crop_upright(&source, 0, [f32::NAN, 0., 1., 1.]).is_ok());
    }

    #[test]
    fn face_guess_is_left_of_the_text_body() {
        let l = |x0: f32, y0: f32, x1: f32| ocr::Line { text: "x".into(), confidence: 0.9, bbox: [x0, y0, x1, y0 + 20.] };
        let lines = vec![l(0., 0., 1000.), l(0., 40., 1000.), l(400., 200., 1000.), l(400., 300., 1000.), l(400., 500., 1000.)];
        let f = face_guess(&lines, 1000., 600.).unwrap();
        assert!(f[0] < 0.01 && (f[2] - 0.4).abs() < 0.01, "{f:?}");
        assert!(f[3] <= 0.88 && f[3] > f[1], "{f:?}");
        // A number printed under the photo ends it.
        let mut with_number = lines.clone();
        with_number.push(l(10., 560., 300.));
        let f = face_guess(&with_number, 1000., 600.).unwrap();
        assert!(f[3] < 560. / 600., "{f:?}");
    }
}
