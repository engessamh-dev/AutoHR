// lib.rs — GCANS v2.0
mod db; mod services; mod files; mod scanner;
mod scanner_commands;
use scanner_commands::*;
#[cfg(test)] mod scanner_tests;
use services::*;
use tauri::{AppHandle, Emitter, Manager, State, Window};
use std::io::Write;
use std::sync::Mutex;
use rusqlite::Connection;
use rand::RngCore;

struct DbState(Mutex<Connection>);

#[derive(Clone)]
struct Session {
    username: String,
    must_change_password: bool,
}

fn session_user(sess: &State<SessionState>) -> Result<String, AppError> {
    let session = sess.0.lock().unwrap().clone().ok_or(AppError::Unauthorized)?;
    if session.must_change_password {
        return Err(AppError::Unauthorized);
    }
    Ok(session.username)
}

// Session state to track current user and enforce mandatory password changes.
struct SessionState(Mutex<Option<Session>>);

fn session_identity(sess: &State<SessionState>) -> Result<String, AppError> {
    sess.0.lock().unwrap().as_ref().map(|s| s.username.clone()).ok_or(AppError::Unauthorized)
}

fn authorize(conn: &Connection, sess: &State<SessionState>, permission: &str) -> Result<String, AppError> {
    let username = session_user(sess)?;
    if let Err(error) = assert_permission(conn, &username, permission) {
        log_audit(conn, Some(&username), "ACCESS_DENIED", Some("permission"), None, Some(permission), "Failure", None);
        return Err(error);
    }
    Ok(username)
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn excel_column_name(mut index: usize) -> String {
    let mut name = String::new();
    while index > 0 {
        index -= 1;
        name.insert(0, (b'A' + (index % 26) as u8) as char);
        index /= 26;
    }
    name
}

fn xlsx_cell(row: usize, col: usize, value: &str, style: Option<u8>) -> String {
    let reference = format!("{}{}", excel_column_name(col), row);
    let style_attr = style.map(|value| format!(" s=\"{value}\"")).unwrap_or_default();
    format!(
        "<c r=\"{reference}\" t=\"inlineStr\"{style_attr}><is><t>{}</t></is></c>",
        xml_escape(value)
    )
}

fn build_report_xlsx(headers: &[String], rows: &[Vec<String>]) -> AppResult<Vec<u8>> {
    if headers.is_empty() {
        return Err(AppError::Validation("Select at least one report field".into()));
    }
    if headers.len() > 16_384 || rows.len() > 1_048_575 {
        return Err(AppError::Validation("The report is too large for Excel".into()));
    }

    let mut sheet_rows = String::new();
    sheet_rows.push_str("<row r=\"1\" spans=\"1:");
    sheet_rows.push_str(&headers.len().to_string());
    sheet_rows.push_str("\">");
    for (index, header) in headers.iter().enumerate() {
        sheet_rows.push_str(&xlsx_cell(1, index + 1, header, Some(1)));
    }
    sheet_rows.push_str("</row>");
    for (row_index, row) in rows.iter().enumerate() {
        let excel_row = row_index + 2;
        sheet_rows.push_str(&format!("<row r=\"{excel_row}\" spans=\"1:{}\">", headers.len()));
        for col_index in 0..headers.len() {
            let value = row.get(col_index).map(String::as_str).unwrap_or("");
            sheet_rows.push_str(&xlsx_cell(excel_row, col_index + 1, value, None));
        }
        sheet_rows.push_str("</row>");
    }

    let dimension = format!("A1:{}{}", excel_column_name(headers.len()), rows.len() + 1);
    let cols = (1..=headers.len())
        .map(|index| format!("<col min=\"{index}\" max=\"{index}\" width=\"24\" customWidth=\"1\"/>"))
        .collect::<String>();
    let sheet = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<dimension ref="{dimension}"/>
<sheetViews><sheetView workbookViewId="0" rightToLeft="1"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="18"/>
<cols>{cols}</cols>
<sheetData>{sheet_rows}</sheetData>
<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>
</worksheet>"#
    );

    let workbook = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<bookViews><workbookView/></bookViews>
<sheets><sheet name="تقرير الموظفين" sheetId="1" r:id="rId1"/></sheets>
</workbook>"#;
    let workbook_rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>"#;
    let root_rels = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"#;
    let content_types = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>"#;
    let styles = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="right" readingOrder="2"/></xf><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="right" readingOrder="2"/></xf></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>"#;

    let mut cursor = std::io::Cursor::new(Vec::new());
    {
        let mut zip = zip::ZipWriter::new(&mut cursor);
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        for (name, content) in [
            ("[Content_Types].xml", content_types),
            ("_rels/.rels", root_rels),
            ("xl/workbook.xml", workbook),
            ("xl/_rels/workbook.xml.rels", workbook_rels),
            ("xl/styles.xml", styles),
            ("xl/worksheets/sheet1.xml", sheet.as_str()),
        ] {
            zip.start_file(name, options).map_err(|e| AppError::Other(e.to_string()))?;
            zip.write_all(content.as_bytes()).map_err(|e| AppError::Other(e.to_string()))?;
        }
        zip.finish().map_err(|e| AppError::Other(e.to_string()))?;
    }
    Ok(cursor.into_inner())
}

#[tauri::command]
fn cmd_select_scanner_device(state: State<DbState>, sess: State<SessionState>) -> Result<String, AppError> {
    let conn = state.0.lock().unwrap();
    authorize(&conn, &sess, "documents.upload")?;
    drop(conn);

    #[cfg(not(target_os = "windows"))]
    return Err(AppError::Validation("Document scanning is supported on Windows only".into()));

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        let script = "$ErrorActionPreference='Stop';$dialog=New-Object -ComObject WIA.CommonDialog;$device=$dialog.ShowSelectDevice(1,$true,$false);if($null -eq $device){exit 2};[Console]::Out.Write($device.DeviceID)";
        let output = Command::new("powershell.exe")
            .creation_flags(0x08000000)
            .args(["-NoProfile", "-NonInteractive", "-STA", "-Command", script])
            .output().map_err(|error| AppError::Other(error.to_string()))?;
        match output.status.code() {
            Some(0) => {
                let device_id = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if device_id.is_empty() { Err(AppError::Validation("لم يتم اختيار ماسح ضوئي".into())) } else { Ok(device_id) }
            }
            Some(2) => Err(AppError::Validation("تم إلغاء اختيار الماسح الضوئي".into())),
            _ => Err(AppError::Validation("تعذر اختيار جهاز الماسح الضوئي. تأكد من تثبيت تعريف WIA الخاص به.".into())),
        }
    }
}

#[tauri::command]
fn cmd_scan_document(state: State<DbState>, sess: State<SessionState>, device_id: String) -> Result<String, AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "documents.upload")?;
    drop(conn);

    #[cfg(not(target_os = "windows"))]
    {
        let _ = user;
        return Err(AppError::Validation("Document scanning is supported on Windows only".into()));
    }

    #[cfg(target_os = "windows")]
    {
        use std::process::Command;
        use std::os::windows::process::CommandExt;

        let mut random = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut random);
        let output_path = std::env::temp_dir().join(format!("autohr_scan_{}.jpg", hex::encode(random)));
        let escaped_path = output_path.to_string_lossy().replace('\'', "''");
        let escaped_device_id = device_id.replace('\'', "''");
        let script = format!(
            "$ErrorActionPreference='Stop';\
             $manager=New-Object -ComObject WIA.DeviceManager;\
             $info=@($manager.DeviceInfos | Where-Object {{$_.Type -eq 1 -and $_.DeviceID -eq '{escaped_device_id}'}})[0];\
             if($null -eq $info){{exit 3}};\
             $device=$info.Connect();\
             $dialog=New-Object -ComObject WIA.CommonDialog;\
             $image=$dialog.ShowTransfer($device.Items.Item(1),'{{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}}',$false);\
             if($null -eq $image){{exit 2}};\
             $processor=New-Object -ComObject WIA.ImageProcess;\
             $convertId=$processor.FilterInfos.Item('Convert').FilterID;\
             $processor.Filters.Add($convertId);\
             $processor.Filters.Item(1).Properties.Item('FormatID').Value='{{B96B3CAE-0728-11D3-9D7B-0000F81EF32E}}';\
             $processor.Filters.Item(1).Properties.Item('Quality').Value=90;\
             $converted=$processor.Apply($image);\
             $converted.SaveFile('{escaped_path}')"
        );
        let output = Command::new("powershell.exe")
            .creation_flags(0x08000000)
            .args(["-NoProfile", "-NonInteractive", "-STA", "-Command", &script])
            .output()
            .map_err(|error| AppError::Other(error.to_string()))?;
        match output.status.code() {
            Some(0) if output_path.is_file() => {}
            Some(2) => return Err(AppError::Validation("تم إلغاء عملية المسح الضوئي".into())),
            Some(3) => return Err(AppError::Validation(
                "لم يتعرف ويندوز على أي ماسح ضوئي يدعم WIA. تأكد من توصيل الماسح وتثبيت تعريف WIA الخاص به.".into()
            )),
            _ => {
                let details = String::from_utf8_lossy(&output.stderr).trim().to_string();
                let message = if details.is_empty() {
                    "فشل تشغيل الماسح الضوئي. تحقق من تعريف الجهاز وخدمة Windows Image Acquisition.".into()
                } else {
                    format!("فشل تشغيل الماسح الضوئي: {details}")
                };
                return Err(AppError::Validation(message));
            }
        }
        let conn = state.0.lock().unwrap();
        log_activity(&conn, &user, "SCAN_DOCUMENT", Some("document"), None, output_path.to_str(), None);
        Ok(output_path.to_string_lossy().into_owned())
    }
}

#[tauri::command] fn cmd_login(state: State<DbState>, sess: State<SessionState>, username: String, password: String) -> Result<User, AppError> {
    let conn = state.0.lock().unwrap();
    let user = login(&conn, &username, &password)?;
    *sess.0.lock().unwrap() = Some(Session {
        username,
        must_change_password: user.must_change_password,
    });
    Ok(user)
}
#[tauri::command] fn cmd_change_password(state: State<DbState>, sess: State<SessionState>, current_password: String, new_password: String) -> Result<User, AppError> {
    let conn = state.0.lock().unwrap();
    let username = session_identity(&sess)?;
    let user = change_password(&conn, &username, &current_password, &new_password)?;
    *sess.0.lock().unwrap() = Some(Session { username, must_change_password: false });
    Ok(user)
}
#[tauri::command] fn cmd_logout(state: State<DbState>, sess: State<SessionState>) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap();
    let username = session_identity(&sess)?;
    logout(&conn, &username)?;
    scanner::clear_owner(&username);
    *sess.0.lock().unwrap() = None;
    Ok(())
}
#[tauri::command] fn cmd_get_company_config(state: State<DbState>, sess: State<SessionState>) -> Result<CompanyConfig, AppError> {
    let conn = state.0.lock().unwrap();
    authorize(&conn, &sess, "dashboard.view")?;
    get_company_config(&conn)
}
#[tauri::command] fn cmd_get_public_company_config(state: State<DbState>) -> Result<CompanyConfig, AppError> {
    get_company_config(&state.0.lock().unwrap())
}
#[tauri::command] fn cmd_update_company_config(state: State<DbState>, sess: State<SessionState>, data: CompanyConfigData) -> Result<CompanyConfig, AppError> {
    let user = session_user(&sess)?;
    update_company_config(&state.0.lock().unwrap(), &user, &data)
}
#[tauri::command] fn cmd_upload_company_logo(state: State<DbState>, sess: State<SessionState>, source_path: String) -> Result<CompanyConfig, AppError> {
    let user = session_user(&sess)?;
    upload_company_logo(&state.0.lock().unwrap(), &user, &source_path)
}
#[tauri::command] fn cmd_next_employee_number(state: State<DbState>, sess: State<SessionState>) -> Result<String, AppError> {
    let conn = state.0.lock().unwrap();
    authorize(&conn, &sess, "employees.create")?;
    next_employee_number(&conn)
}
#[tauri::command] fn cmd_list_employees(state: State<DbState>, sess: State<SessionState>) -> Result<Vec<Employee>, AppError> {
    let conn = state.0.lock().unwrap();
    authorize(&conn, &sess, "employees.view")?;
    list_employees(&conn)
}
#[tauri::command] fn cmd_get_employee(state: State<DbState>, sess: State<SessionState>, id: i64) -> Result<Employee, AppError> {
    let conn = state.0.lock().unwrap();
    authorize(&conn, &sess, "employees.view")?;
    get_employee(&conn, id)
}
#[tauri::command] fn cmd_create_employee(state: State<DbState>, sess: State<SessionState>, data: EmployeeData) -> Result<Employee, AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "employees.create")?;
    create_employee(&conn, &data, &user)
}
#[tauri::command] fn cmd_update_employee(state: State<DbState>, sess: State<SessionState>, id: i64, data: EmployeeData) -> Result<Employee, AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "employees.edit")?;
    update_employee(&conn, id, &data, &user)
}
#[tauri::command] fn cmd_delete_employee(state: State<DbState>, sess: State<SessionState>, id: i64) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "employees.delete")?;
    delete_employee(&conn, id, &user)
}
#[tauri::command] fn cmd_upload_employee_photo(state: State<DbState>, sess: State<SessionState>, employee_id: i64, source_path: String) -> Result<String, AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "employees.edit")?;
    let result = upload_employee_photo(&conn, employee_id, &source_path)?;
    log_activity(&conn, &user, "UPLOAD_DOCUMENT", Some("employee"), Some(employee_id), Some(&result), Some("photo"));
    Ok(result)
}
#[tauri::command] fn cmd_delete_employee_photo(state: State<DbState>, sess: State<SessionState>, employee_id: i64) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "employees.edit")?;
    files::delete_employee_photo(&conn, employee_id)?;
    log_activity(&conn, &user, "DELETE_DOCUMENT", Some("employee"), Some(employee_id), None, Some("photo"));
    Ok(())
}
#[tauri::command] fn cmd_upload_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, source_path: String) -> Result<String, AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "documents.upload")?;
    let rel = files::upload_attachment(&conn, employee_id, &source_path)?;
    log_activity(&conn, &user, "UPLOAD_ATTACHMENT", Some("employee"), Some(employee_id), Some(&rel), None);
    Ok(rel)
}
#[tauri::command] fn cmd_upload_national_card_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, side: String, source_path: String) -> Result<String, AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "documents.upload")?;
    let rel = files::upload_national_card_attachment(&conn, employee_id, &side, &source_path)?;
    log_activity(&conn, &user, "UPLOAD_NATIONAL_CARD_ATTACHMENT", Some("employee"), Some(employee_id), Some(&rel), Some(&side));
    Ok(rel)
}
#[tauri::command] fn cmd_delete_national_card_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, side: String) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "documents.delete")?;
    files::delete_national_card_attachment(&conn, employee_id, &side)?;
    log_activity(&conn, &user, "DELETE_NATIONAL_CARD_ATTACHMENT", Some("employee"), Some(employee_id), None, Some(&side));
    Ok(())
}
#[tauri::command] fn cmd_upload_family_national_card_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, member_index: usize, side: String, source_path: String) -> Result<String, AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "documents.upload")?;
    let rel = files::upload_family_national_card_attachment(&conn, employee_id, member_index, &side, &source_path)?;
    log_activity(&conn, &user, "UPLOAD_FAMILY_NATIONAL_CARD_ATTACHMENT", Some("employee"), Some(employee_id), Some(&rel), Some(&format!("{}:{}", member_index, side)));
    Ok(rel)
}
#[tauri::command] fn cmd_delete_family_national_card_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, member_index: usize, side: String) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "documents.delete")?;
    files::delete_family_national_card_attachment(&conn, employee_id, member_index, &side)?;
    log_activity(&conn, &user, "DELETE_FAMILY_NATIONAL_CARD_ATTACHMENT", Some("employee"), Some(employee_id), None, Some(&format!("{}:{}", member_index, side)));
    Ok(())
}
#[tauri::command] fn cmd_upload_spouse_national_card_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, spouse_index: usize, side: String, source_path: String) -> Result<String, AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "documents.upload")?;
    let rel = files::upload_spouse_national_card_attachment(&conn, employee_id, spouse_index, &side, &source_path)?;
    log_activity(&conn, &user, "UPLOAD_SPOUSE_NATIONAL_CARD_ATTACHMENT", Some("employee"), Some(employee_id), Some(&rel), Some(&format!("{}:{}", spouse_index, side)));
    Ok(rel)
}
#[tauri::command] fn cmd_delete_spouse_national_card_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, spouse_index: usize, side: String) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "documents.delete")?;
    files::delete_spouse_national_card_attachment(&conn, employee_id, spouse_index, &side)?;
    log_activity(&conn, &user, "DELETE_SPOUSE_NATIONAL_CARD_ATTACHMENT", Some("employee"), Some(employee_id), None, Some(&format!("{}:{}", spouse_index, side)));
    Ok(())
}
#[tauri::command] fn cmd_upload_residence_card_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, side: String, source_path: String) -> Result<String, AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "documents.upload")?;
    let rel = files::upload_residence_card_attachment(&conn, employee_id, &side, &source_path)?;
    log_activity(&conn, &user, "UPLOAD_RESIDENCE_CARD_ATTACHMENT", Some("employee"), Some(employee_id), Some(&rel), Some(&side));
    Ok(rel)
}
#[tauri::command] fn cmd_delete_residence_card_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, side: String) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "documents.delete")?;
    files::delete_residence_card_attachment(&conn, employee_id, &side)?;
    log_activity(&conn, &user, "DELETE_RESIDENCE_CARD_ATTACHMENT", Some("employee"), Some(employee_id), None, Some(&side));
    Ok(())
}
#[tauri::command] fn cmd_upload_airport_badge_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, side: String, source_path: String) -> Result<String, AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "documents.upload")?;
    let rel = files::upload_airport_badge_attachment(&conn, employee_id, &side, &source_path)?;
    log_activity(&conn, &user, "UPLOAD_AIRPORT_BADGE_ATTACHMENT", Some("employee"), Some(employee_id), Some(&rel), Some(&side));
    Ok(rel)
}
#[tauri::command] fn cmd_delete_airport_badge_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, side: String) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "documents.delete")?;
    files::delete_airport_badge_attachment(&conn, employee_id, &side)?;
    log_activity(&conn, &user, "DELETE_AIRPORT_BADGE_ATTACHMENT", Some("employee"), Some(employee_id), None, Some(&side));
    Ok(())
}
#[tauri::command] fn cmd_upload_ministry_badge_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, side: String, source_path: String) -> Result<String, AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "documents.upload")?;
    let rel = files::upload_ministry_badge_attachment(&conn, employee_id, &side, &source_path)?;
    log_activity(&conn, &user, "UPLOAD_MINISTRY_BADGE_ATTACHMENT", Some("employee"), Some(employee_id), Some(&rel), Some(&side));
    Ok(rel)
}
#[tauri::command] fn cmd_delete_ministry_badge_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, side: String) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "documents.delete")?;
    files::delete_ministry_badge_attachment(&conn, employee_id, &side)?;
    log_activity(&conn, &user, "DELETE_MINISTRY_BADGE_ATTACHMENT", Some("employee"), Some(employee_id), None, Some(&side));
    Ok(())
}
#[tauri::command] fn cmd_upload_passport_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, source_path: String) -> Result<String, AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "documents.upload")?;
    let rel = files::upload_passport_attachment(&conn, employee_id, &source_path)?;
    log_activity(&conn, &user, "UPLOAD_PASSPORT_ATTACHMENT", Some("employee"), Some(employee_id), Some(&rel), None);
    Ok(rel)
}
#[tauri::command] fn cmd_delete_passport_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, relative_path: String) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "documents.delete")?;
    files::delete_passport_attachment(&conn, employee_id, &relative_path)?;
    log_activity(&conn, &user, "DELETE_PASSPORT_ATTACHMENT", Some("employee"), Some(employee_id), Some(&relative_path), None);
    Ok(())
}
#[tauri::command] fn cmd_upload_ration_card_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, source_path: String) -> Result<String, AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "documents.upload")?;
    let rel = files::upload_ration_card_attachment(&conn, employee_id, &source_path)?;
    log_activity(&conn, &user, "UPLOAD_RATION_CARD_ATTACHMENT", Some("employee"), Some(employee_id), Some(&rel), None);
    Ok(rel)
}
#[tauri::command] fn cmd_delete_ration_card_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, relative_path: String) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "documents.delete")?;
    files::delete_ration_card_attachment(&conn, employee_id, &relative_path)?;
    log_activity(&conn, &user, "DELETE_RATION_CARD_ATTACHMENT", Some("employee"), Some(employee_id), Some(&relative_path), None);
    Ok(())
}
#[tauri::command] fn cmd_delete_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, relative_path: String) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "documents.delete")?;
    files::delete_attachment(&conn, employee_id, &relative_path)?;
    log_activity(&conn, &user, "DELETE_ATTACHMENT", Some("employee"), Some(employee_id), Some(&relative_path), None);
    Ok(())
}
#[tauri::command] fn cmd_list_grade_history(state: State<DbState>, sess: State<SessionState>, employee_id: i64) -> Result<Vec<GradeHistory>, AppError> {
    let conn = state.0.lock().unwrap();
    authorize(&conn, &sess, "employees.view")?;
    list_grade_history(&conn, employee_id)
}
#[tauri::command] fn cmd_add_grade_history(state: State<DbState>, sess: State<SessionState>, employee_id: i64, data: GradeHistoryData) -> Result<GradeHistory, AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "employees.edit")?;
    add_grade_history(&conn, employee_id, &data, &user)
}
#[tauri::command] fn cmd_delete_grade_history(state: State<DbState>, sess: State<SessionState>, id: i64) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap();
    authorize(&conn, &sess, "employees.edit")?;
    delete_grade_history(&conn, id)
}
#[tauri::command] fn cmd_list_general_docs(state: State<DbState>, sess: State<SessionState>) -> Result<Vec<GeneralDoc>, AppError> {
    let conn = state.0.lock().unwrap();
    authorize(&conn, &sess, "documents.view")?;
    list_general_docs(&conn)
}
#[tauri::command] fn cmd_create_general_doc(state: State<DbState>, sess: State<SessionState>, data: GeneralDocData) -> Result<GeneralDoc, AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "documents.manage")?;
    create_general_doc(&conn, &data, &user)
}
#[tauri::command] fn cmd_update_general_doc(state: State<DbState>, sess: State<SessionState>, id: i64, data: GeneralDocData) -> Result<GeneralDoc, AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "documents.manage")?;
    update_general_doc(&conn, id, &data, &user)
}
#[tauri::command] fn cmd_delete_general_doc(state: State<DbState>, sess: State<SessionState>, id: i64) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "documents.delete")?;
    delete_general_doc(&conn, id, &user)
}
#[tauri::command] fn cmd_upload_general_doc_file(state: State<DbState>, sess: State<SessionState>, doc_id: i64, source_path: String) -> Result<String, AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "documents.upload")?;
    let path = upload_general_doc_file(&conn, doc_id, &source_path)?;
    log_activity(&conn, &user, "UPLOAD_DOCUMENT", Some("general_doc"), Some(doc_id), Some(&path), None);
    Ok(path)
}
#[tauri::command] fn cmd_delete_general_doc_attachment(state: State<DbState>, sess: State<SessionState>, doc_id: i64, relative_path: String) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "documents.delete")?;
    delete_general_doc_attachment(&conn, doc_id, &relative_path)?;
    log_activity(&conn, &user, "DELETE_DOCUMENT", Some("general_doc"), Some(doc_id), Some(&relative_path), None);
    Ok(())
}
#[tauri::command] fn cmd_move_general_doc_attachment(state: State<DbState>, sess: State<SessionState>, doc_id: i64, relative_path: String, direction: String) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "documents.manage")?;
    move_general_doc_attachment(&conn, doc_id, &relative_path, &direction)?;
    log_activity(&conn, &user, "REORDER_DOCUMENT_ATTACHMENT", Some("general_doc"), Some(doc_id), Some(&relative_path), Some(&direction));
    Ok(())
}
#[tauri::command] fn cmd_list_outgoing_docs(state: State<DbState>, sess: State<SessionState>) -> Result<Vec<GeneralDoc>, AppError> {
    let conn = state.0.lock().unwrap();
    authorize(&conn, &sess, "documents.view")?;
    list_outgoing_docs(&conn)
}
#[tauri::command] fn cmd_create_outgoing_doc(state: State<DbState>, sess: State<SessionState>, data: GeneralDocData) -> Result<GeneralDoc, AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "documents.manage")?;
    create_outgoing_doc(&conn, &data, &user)
}
#[tauri::command] fn cmd_update_outgoing_doc(state: State<DbState>, sess: State<SessionState>, id: i64, data: GeneralDocData) -> Result<GeneralDoc, AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "documents.manage")?;
    update_outgoing_doc(&conn, id, &data, &user)
}
#[tauri::command] fn cmd_delete_outgoing_doc(state: State<DbState>, sess: State<SessionState>, id: i64) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "documents.delete")?;
    delete_outgoing_doc(&conn, id, &user)
}
#[tauri::command] fn cmd_upload_outgoing_doc_file(state: State<DbState>, sess: State<SessionState>, doc_id: i64, source_path: String) -> Result<String, AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "documents.upload")?;
    let path = upload_outgoing_doc_file(&conn, doc_id, &source_path)?;
    log_activity(&conn, &user, "UPLOAD_DOCUMENT", Some("outgoing_doc"), Some(doc_id), Some(&path), None);
    Ok(path)
}
#[tauri::command] fn cmd_delete_outgoing_doc_attachment(state: State<DbState>, sess: State<SessionState>, doc_id: i64, relative_path: String) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "documents.delete")?;
    delete_outgoing_doc_attachment(&conn, doc_id, &relative_path)?;
    log_activity(&conn, &user, "DELETE_DOCUMENT", Some("outgoing_doc"), Some(doc_id), Some(&relative_path), None);
    Ok(())
}
#[tauri::command] fn cmd_move_outgoing_doc_attachment(state: State<DbState>, sess: State<SessionState>, doc_id: i64, relative_path: String, direction: String) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "documents.manage")?;
    move_outgoing_doc_attachment(&conn, doc_id, &relative_path, &direction)?;
    log_activity(&conn, &user, "REORDER_DOCUMENT_ATTACHMENT", Some("outgoing_doc"), Some(doc_id), Some(&relative_path), Some(&direction));
    Ok(())
}
#[tauri::command] fn cmd_list_activity_log(state: State<DbState>, sess: State<SessionState>, limit: i64) -> Result<Vec<ActivityLog>, AppError> {
    let conn = state.0.lock().unwrap();
    authorize(&conn, &sess, "audit.view")?;
    list_activity_log(&conn, limit)
}
#[tauri::command] fn cmd_list_users(state: State<DbState>, sess: State<SessionState>) -> Result<Vec<User>, AppError> {
    let conn = state.0.lock().unwrap();
    authorize(&conn, &sess, "users.manage")?;
    list_users(&conn)
}
#[tauri::command] fn cmd_create_user(state: State<DbState>, sess: State<SessionState>, data: UserData) -> Result<User, AppError> {
    let user = session_user(&sess)?;
    create_user(&state.0.lock().unwrap(), &user, &data)
}
#[tauri::command] fn cmd_delete_user(state: State<DbState>, sess: State<SessionState>, id: i64) -> Result<(), AppError> {
    let user = session_user(&sess)?;
    delete_user(&state.0.lock().unwrap(), &user, id)
}
#[tauri::command] fn cmd_update_user_role(state: State<DbState>, sess: State<SessionState>, id: i64, data: UserRoleData) -> Result<User, AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "users.manage")?;
    update_user_role(&conn, &user, id, &data.role)
}
#[tauri::command] fn cmd_reset_user_password(state: State<DbState>, sess: State<SessionState>, id: i64, data: PasswordResetData) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "users.manage")?;
    reset_user_password(&conn, &user, id, &data.password)
}
#[tauri::command] fn cmd_get_storage_path(state: State<DbState>, sess: State<SessionState>) -> Result<String, AppError> {
    let conn = state.0.lock().unwrap();
    authorize(&conn, &sess, "settings.manage")?;
    get_storage_path(&conn)
}
#[tauri::command] fn cmd_set_storage_path(app: AppHandle, state: State<DbState>, sess: State<SessionState>, path: String) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "settings.manage")?;
    set_storage_path(&conn, &user, &path)?;
    app.asset_protocol_scope()
        .allow_directory(storage_path(&conn), true)
        .map_err(|e| AppError::Other(e.to_string()))
}
#[tauri::command] fn cmd_get_backup_path(state: State<DbState>, sess: State<SessionState>) -> Result<String, AppError> {
    let conn = state.0.lock().unwrap();
    authorize(&conn, &sess, "settings.manage")?;
    get_backup_path(&conn)
}
#[tauri::command] fn cmd_set_backup_path(state: State<DbState>, sess: State<SessionState>, path: String) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "settings.manage")?;
    set_backup_path(&conn, &user, &path)
}
#[tauri::command] fn cmd_get_auto_backup_settings(state: State<DbState>, sess: State<SessionState>) -> Result<AutoBackupSettings, AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "backups.manage")?;
    get_auto_backup_settings(&conn, &user)
}
#[tauri::command] fn cmd_set_auto_backup_settings(state: State<DbState>, sess: State<SessionState>, data: AutoBackupSettingsData) -> Result<AutoBackupSettings, AppError> {
    let conn = state.0.lock().unwrap();
    let user = authorize(&conn, &sess, "backups.manage")?;
    set_auto_backup_settings(&conn, &user, &data)
}
#[tauri::command]
async fn cmd_run_due_auto_backups(window: Window) -> Result<Vec<String>, AppError> {
    let progress_window = window.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db::open().map_err(AppError::from)?;
        match run_due_automatic_backups_with_progress(&conn, move |progress| {
            let _ = progress_window.emit("auto-backup-progress", progress);
        }) {
            Ok(created) => Ok(created),
            Err(error) => {
                log_audit(&conn, Some("system"), "CREATE_AUTO_BACKUP", Some("backup"), None, None, "Failure", Some(&error.to_string()));
                Err(error)
            }
        }
    })
    .await
    .map_err(|error| AppError::Other(error.to_string()))?
}
#[tauri::command]
fn cmd_exit_app(app: AppHandle) {
    app.exit(0);
}
#[tauri::command] fn cmd_get_document_types(state: State<DbState>, sess: State<SessionState>) -> Result<Vec<String>, AppError> {
    let conn = state.0.lock().unwrap();
    authorize(&conn, &sess, "documents.view")?;
    get_document_types(&conn)
}
#[tauri::command] fn cmd_set_document_types(state: State<DbState>, sess: State<SessionState>, types: Vec<String>) -> Result<Vec<String>, AppError> {
    let user = session_user(&sess)?;
    set_document_types(&state.0.lock().unwrap(), &user, &types)
}
#[tauri::command]
async fn cmd_create_backup(window: Window, state: State<'_, DbState>, sess: State<'_, SessionState>, password: String) -> Result<String, AppError> {
    let user = {
        let conn = state.0.lock().unwrap();
        authorize(&conn, &sess, "backups.manage")?
    };
    let app = window.app_handle().clone();
    let progress_window = window.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DbState>();
        let conn = state.0.lock().unwrap();
        create_backup_with_progress(&conn, &user, &password, move |progress| {
            let _ = progress_window.emit("backup-progress", progress);
        })
    })
    .await
    .map_err(|error| AppError::Other(error.to_string()))?
}
#[tauri::command]
async fn cmd_restore_backup(window: Window, state: State<'_, DbState>, sess: State<'_, SessionState>, source_path: String, password: String) -> Result<(), AppError> {
    let user = {
        let conn = state.0.lock().unwrap();
        authorize(&conn, &sess, "backups.manage")?
    };
    let app = window.app_handle().clone();
    let progress_window = window.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DbState>();
        let mut conn = state.0.lock().unwrap();
        restore_backup_with_progress(&mut conn, &user, &source_path, &password, move |progress| {
            let _ = progress_window.emit("restore-progress", progress);
        })
    })
    .await
    .map_err(|error| AppError::Other(error.to_string()))??;
    *sess.0.lock().unwrap() = None;
    Ok(())
}
#[tauri::command] fn cmd_audit_document_view(state: State<DbState>, sess: State<SessionState>, employee_id: i64, document_name: String) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap(); let user = authorize(&conn, &sess, "documents.view")?;
    log_activity(&conn, &user, "VIEW_DOCUMENT", Some("employee"), Some(employee_id), Some(&document_name), None); Ok(())
}
#[tauri::command] fn cmd_audit_document_download(state: State<DbState>, sess: State<SessionState>, employee_id: i64, document_name: String) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap(); let user = authorize(&conn, &sess, "documents.download")?;
    log_activity(&conn, &user, "DOWNLOAD_DOCUMENT", Some("employee"), Some(employee_id), Some(&document_name), None); Ok(())
}
#[tauri::command] fn cmd_download_document(state: State<DbState>, sess: State<SessionState>, relative_path: String, destination_path: String) -> Result<String, AppError> {
    let conn = state.0.lock().unwrap(); let user = authorize(&conn, &sess, "documents.download")?;
    download_document(&conn, &user, &relative_path, &destination_path)
}
#[tauri::command] fn cmd_get_document_preview_path(state: State<DbState>, sess: State<SessionState>, relative_path: String) -> Result<String, AppError> {
    let conn = state.0.lock().unwrap(); let user = authorize(&conn, &sess, "documents.view")?;
    document_preview_path(&conn, &user, &relative_path)
}
#[tauri::command] fn cmd_read_document(state: State<DbState>, sess: State<SessionState>, relative_path: String) -> Result<Vec<u8>, AppError> {
    let conn = state.0.lock().unwrap(); let user = authorize(&conn, &sess, "documents.view")?;
    read_document(&conn, &user, &relative_path)
}
#[tauri::command] fn cmd_print_document(state: State<DbState>, sess: State<SessionState>, relative_path: String) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap(); let user = authorize(&conn, &sess, "documents.print")?;
    print_document(&conn, &user, &relative_path)
}
#[tauri::command] fn cmd_print_employee_documents(state: State<DbState>, sess: State<SessionState>, employee_id: i64, document_names: Vec<String>) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap(); let user = authorize(&conn, &sess, "documents.print")?;
    log_activity(&conn, &user, "PRINT_DOCUMENT", Some("employee"), Some(employee_id), Some(&document_names.join(", ")), None); Ok(())
}
#[tauri::command] fn cmd_save_report_xlsx(state: State<DbState>, sess: State<SessionState>, destination_path: String, headers: Vec<String>, rows: Vec<Vec<String>>) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap();
    authorize(&conn, &sess, "employees.view")?;
    let workbook = build_report_xlsx(&headers, &rows)?;
    std::fs::write(destination_path, workbook).map_err(|e| AppError::Other(e.to_string()))
}

pub fn scanner_self_test() -> Result<(), String> {
    scanner::production_self_test().map_err(|error| error.to_string())
}

pub fn run() {
    let conn = db::open().expect("Failed to open database");
    ensure_storage_layout(&conn).ok();
    scanner::recover_pending_files(&conn).ok();
    ensure_backup_layout(&conn).ok();
    let storage_root = storage_path(&conn);
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(DbState(Mutex::new(conn)))
        .manage(SessionState(Mutex::new(None)))
        .setup(move |app| {
            app.asset_protocol_scope().allow_directory(&storage_root, true)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            cmd_login, cmd_change_password, cmd_logout,
            cmd_get_company_config, cmd_get_public_company_config, cmd_update_company_config, cmd_upload_company_logo,
            cmd_next_employee_number,
            cmd_list_employees, cmd_get_employee,
            cmd_create_employee, cmd_update_employee, cmd_delete_employee,
            cmd_upload_employee_photo, cmd_delete_employee_photo,
            cmd_upload_national_card_attachment, cmd_delete_national_card_attachment,
            cmd_upload_family_national_card_attachment, cmd_delete_family_national_card_attachment,
            cmd_upload_spouse_national_card_attachment, cmd_delete_spouse_national_card_attachment,
            cmd_upload_residence_card_attachment, cmd_delete_residence_card_attachment,
            cmd_upload_airport_badge_attachment, cmd_delete_airport_badge_attachment,
            cmd_upload_ministry_badge_attachment, cmd_delete_ministry_badge_attachment,
            cmd_upload_passport_attachment, cmd_delete_passport_attachment,
            cmd_upload_ration_card_attachment, cmd_delete_ration_card_attachment,
            cmd_upload_attachment, cmd_delete_attachment,
            cmd_scanner_settings, cmd_set_scanner_settings, cmd_scanner_prepare, cmd_scanner_render,
            cmd_scanner_release, cmd_scanner_save_existing, cmd_scanner_upload, cmd_scanner_detect, cmd_scanner_versions,
            cmd_get_document_download_name,
            cmd_list_grade_history, cmd_add_grade_history, cmd_delete_grade_history,
            cmd_list_general_docs, cmd_create_general_doc, cmd_update_general_doc, cmd_delete_general_doc,
            cmd_upload_general_doc_file, cmd_delete_general_doc_attachment, cmd_move_general_doc_attachment,
            cmd_list_outgoing_docs, cmd_create_outgoing_doc, cmd_update_outgoing_doc, cmd_delete_outgoing_doc,
            cmd_upload_outgoing_doc_file, cmd_delete_outgoing_doc_attachment, cmd_move_outgoing_doc_attachment,
            cmd_select_scanner_device, cmd_scan_document,
            cmd_list_activity_log,
            cmd_list_users, cmd_create_user, cmd_delete_user, cmd_update_user_role, cmd_reset_user_password,
            cmd_get_storage_path, cmd_set_storage_path, cmd_get_backup_path, cmd_set_backup_path,
            cmd_get_auto_backup_settings, cmd_set_auto_backup_settings,
            cmd_run_due_auto_backups, cmd_exit_app,
            cmd_get_document_types, cmd_set_document_types,
            cmd_create_backup, cmd_restore_backup, cmd_audit_document_view, cmd_audit_document_download, cmd_download_document,
            cmd_get_document_preview_path, cmd_read_document, cmd_print_document, cmd_print_employee_documents, cmd_save_report_xlsx,
        ])
        .run(tauri::generate_context!())
        .expect("error while running application");
}

#[cfg(test)]
mod report_export_tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn report_xlsx_contains_workbook_and_rtl_sheet() {
        let bytes = build_report_xlsx(
            &["الاسم الرباعي".to_string(), "الهاتف".to_string()],
            &[vec!["سيف ناظم كريم".to_string(), "07700000001".to_string()]],
        ).unwrap();
        let cursor = std::io::Cursor::new(bytes);
        let mut archive = zip::ZipArchive::new(cursor).unwrap();
        assert!(archive.by_name("xl/workbook.xml").is_ok());
        let mut sheet = String::new();
        archive.by_name("xl/worksheets/sheet1.xml").unwrap().read_to_string(&mut sheet).unwrap();
        assert!(sheet.contains("rightToLeft=\"1\""));
        assert!(sheet.contains("الاسم الرباعي"));
    }
}
