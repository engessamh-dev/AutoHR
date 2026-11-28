// lib.rs — GCANS v2.0
mod account; mod backup_store; mod db; mod names; mod services; mod files; mod scanner; mod paths; mod storage; mod ai_detect; mod secure; mod ocr; mod ocr_parse; mod health; mod errlog; mod integrity; mod notify;
mod scanner_commands;
#[cfg(debug_assertions)]
mod devseed;
use scanner_commands::*;
#[cfg(test)] mod scanner_tests;
use services::*;
use tauri::{AppHandle, Emitter, Manager, State, Window};
use std::io::Write;
use std::sync::Mutex;
use rusqlite::Connection;
#[cfg(target_os = "windows")]
use rand::RngCore;

/// The open database, or `None` while first-run setup is pending or the data folder is
/// unreachable. Every command goes through `conn()`, which reports that state as an error
/// instead of panicking.
struct DbState(Mutex<Option<Connection>>);

struct ConnGuard<'a>(std::sync::MutexGuard<'a, Option<Connection>>);

impl std::ops::Deref for ConnGuard<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        self.0.as_ref().expect("checked in DbState::conn")
    }
}

impl std::ops::DerefMut for ConnGuard<'_> {
    fn deref_mut(&mut self) -> &mut Connection {
        self.0.as_mut().expect("checked in DbState::conn")
    }
}

impl DbState {
    fn conn(&self) -> Result<ConnGuard<'_>, AppError> {
        let guard = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_none() {
            return Err(AppError::Validation("قاعدة البيانات غير مفتوحة. أكمل إعداد مجلد البيانات أولًا.".into()));
        }
        Ok(ConnGuard(guard))
    }
}

/// How the application started, reported to the frontend before the login screen.
#[derive(Clone, serde::Serialize)]
struct StartupStatus {
    /// "ready", "needs_setup", "data_missing" or "open_failed".
    state: String,
    data_root: String,
    backup_root: String,
    message: String,
    suggested_data_root: String,
    suggested_backup_root: String,
}

struct StartupInfo(Mutex<StartupStatus>);

fn suggested_roots() -> (String, String) {
    #[cfg(target_os = "windows")]
    {
        let drives: Vec<String> = ["D", "E", "F", "G"].iter()
            .filter(|d| std::path::Path::new(&format!("{d}:\\")).is_dir())
            .map(|d| d.to_string()).collect();
        // Data on the first drive other than C, backups on the next one. With fewer drives the
        // setup screen still offers a folder (and warns about C or about sharing one drive).
        let data_drive = drives.first().cloned().unwrap_or_else(|| "C".into());
        let backup_drive = drives.get(1).cloned().unwrap_or_else(|| data_drive.clone());
        (format!("{data_drive}:\\{}", storage::DATA_FOLDER_NAME), format!("{backup_drive}:\\{}", storage::BACKUP_FOLDER_NAME))
    }
    #[cfg(not(target_os = "windows"))]
    { (String::new(), String::new()) }
}

fn startup_status(state: &str, message: String) -> StartupStatus {
    let (suggested_data_root, suggested_backup_root) = suggested_roots();
    let configured = paths::current();
    StartupStatus {
        state: state.into(),
        data_root: configured.as_ref().map(|p| p.data_root.to_string_lossy().into_owned()).unwrap_or_default(),
        backup_root: configured.as_ref().map(|p| p.backup_root.to_string_lossy().into_owned()).unwrap_or_default(),
        message,
        suggested_data_root,
        suggested_backup_root,
    }
}

/// Prepares folders and file scopes for a freshly opened database.
fn activate_database(app: &AppHandle, conn: &Connection) {
    ensure_storage_layout(conn).ok();
    scanner::recover_pending_files(conn).ok();
    ensure_backup_layout(conn).ok();
    app.asset_protocol_scope().allow_directory(storage_path(conn), true).ok();
    restrict_managed_folders();
}

/// Limits the data and backup folders to this Windows user, Administrators and SYSTEM. Checked on
/// every start (not only once), so access opened again later is closed again; the outcome is kept
/// for «الفحص والدعم». Runs in the background and never blocks or fails startup. Then seals the
/// attachments that have no seal yet (the first start after the update, or files from a restore).
fn restrict_managed_folders() {
    let roots = [paths::data_root(), paths::backup_root()];
    std::thread::spawn(move || {
        if cfg!(target_os = "windows") {
            for root in roots {
                // Never lock a whole drive (a data folder chosen as «D:\\» by an older release).
                if !root.is_dir() || storage::is_drive_root(&root) { continue; }
                let result = match secure::folder_access(&root) {
                    Ok(secure::FolderAccess::Open(_)) => secure::restrict_folder(&root),
                    Ok(_) => Ok(()),
                    Err(error) => Err(error),
                };
                if let Err(error) = &result { errlog::record_backend("file", &format!("restrict folder: {error}")); }
                health::remember_restrict_result(&root, result);
            }
        }
        if let Ok(conn) = db::open_existing() { integrity::seal_new_files(&conn); }
    });
}

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

/// Records a refused or failed change in the audit log, with the reason, and passes the result on.
/// A refused permission is already recorded by `authorize` as ACCESS_DENIED.
fn logged_failure<T>(conn: &Connection, user: &str, action: &str, target_type: Option<&str>, target_id: Option<i64>,
    target_name: Option<&str>, result: Result<T, AppError>) -> Result<T, AppError> {
    if let Err(error) = &result {
        let reason = match error {
            AppError::Unauthorized => "You are not authorized to perform this action".to_string(),
            AppError::NotFound => "The requested item was not found".to_string(),
            AppError::Validation(message) | AppError::Other(message) => message.clone(),
            AppError::Db(_) => "The database operation could not be completed".to_string(),
        };
        log_audit(conn, Some(user), action, target_type, target_id, target_name, "Failure", Some(&reason));
    }
    result
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

/// Excel's day number for a `YYYY-MM-DD` date (days since 1899-12-30), or None for anything else.
fn excel_date_serial(value: &str) -> Option<i64> {
    let date = chrono::NaiveDate::parse_from_str(value.trim(), "%Y-%m-%d").ok()?;
    let base = chrono::NaiveDate::from_ymd_opt(1899, 12, 30)?;
    Some((date - base).num_days())
}

/// A column wide enough for its longest value (in characters), within limits.
fn report_column_width(header: &str, rows: &[Vec<String>], col: usize) -> usize {
    let longest = rows.iter().filter_map(|row| row.get(col)).map(|v| v.chars().count()).max().unwrap_or(0);
    (longest.max(header.chars().count()) + 3).clamp(8, 60)
}

/// The report workbook. Columns listed in `date_columns` hold `YYYY-MM-DD` dates: those become
/// real Excel dates shown as 2026/12/7 (so they sort and calculate); any other text stays text.
/// Empty values are left as empty cells.
fn build_report_xlsx(headers: &[String], rows: &[Vec<String>], date_columns: &[usize]) -> AppResult<Vec<u8>> {
    if headers.is_empty() {
        return Err(AppError::Validation("اختر عموداً واحداً على الأقل".into()));
    }
    if headers.len() > 16_384 || rows.len() > 1_048_575 {
        return Err(AppError::Validation("التقرير أكبر مما يتسع له ملف Excel".into()));
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
            if value.trim().is_empty() { continue; }
            match excel_date_serial(value).filter(|_| date_columns.contains(&col_index)) {
                Some(serial) => sheet_rows.push_str(&format!(
                    "<c r=\"{}{excel_row}\" s=\"2\"><v>{serial}</v></c>", excel_column_name(col_index + 1))),
                None => sheet_rows.push_str(&xlsx_cell(excel_row, col_index + 1, value, None)),
            }
        }
        sheet_rows.push_str("</row>");
    }

    let last_column = excel_column_name(headers.len());
    let dimension = format!("A1:{last_column}{}", rows.len() + 1);
    let cols = headers.iter().enumerate()
        .map(|(index, header)| format!("<col min=\"{0}\" max=\"{0}\" width=\"{1}\" customWidth=\"1\"/>", index + 1, report_column_width(header, rows, index)))
        .collect::<String>();
    // Landscape, as wide as one page, with the heading row repeated on every printed page.
    let sheet = format!(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>
<dimension ref="{dimension}"/>
<sheetViews><sheetView workbookViewId="0" rightToLeft="1"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="18"/>
<cols>{cols}</cols>
<sheetData>{sheet_rows}</sheetData>
<autoFilter ref="{dimension}"/>
<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>
<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>
</worksheet>"#
    );
    let defined_names = format!(
        "<definedNames><definedName name=\"_xlnm._FilterDatabase\" localSheetId=\"0\" hidden=\"1\">'تقرير الموظفين'!$A$1:${last_column}${0}</definedName><definedName name=\"_xlnm.Print_Titles\" localSheetId=\"0\">'تقرير الموظفين'!$1:$1</definedName></definedNames>",
        rows.len() + 1);

    let workbook = format!(r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<bookViews><workbookView/></bookViews>
<sheets><sheet name="تقرير الموظفين" sheetId="1" r:id="rId1"/></sheets>
{defined_names}
</workbook>"#);
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
<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy/m/d"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment horizontal="right" readingOrder="2"/></xf><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="right" readingOrder="2"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right"/></xf></cellXfs>
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
            ("xl/workbook.xml", workbook.as_str()),
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
    let conn = state.conn()?;
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
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "documents.upload")?;
    drop(conn);

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (user, device_id);
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
        let conn = state.conn()?;
        log_activity(&conn, &user, "SCAN_DOCUMENT", Some("document"), None, output_path.to_str(), None);
        Ok(output_path.to_string_lossy().into_owned())
    }
}

#[tauri::command] fn cmd_login(state: State<DbState>, sess: State<SessionState>, username: String, password: String) -> Result<User, AppError> {
    let conn = state.conn()?;
    let user = login(&conn, &username, &password)?;
    if user.permissions.iter().any(|p| p == "documents.upload") {
        // Load and optimise the document-detection model in the background, so the first scan
        // does not wait for it. Only users who can upload documents ever need it.
        std::thread::spawn(|| { ai_detect::available(); });
    }
    // The name as stored (sign-in ignores case), so the session matches the account exactly.
    let _ = username;
    *sess.0.lock().unwrap() = Some(Session {
        username: user.username.clone(),
        must_change_password: user.must_change_password,
    });
    Ok(user)
}
#[tauri::command] fn cmd_change_password(state: State<DbState>, sess: State<SessionState>, current_password: String, new_password: String) -> Result<User, AppError> {
    let conn = state.conn()?;
    let username = session_identity(&sess)?;
    let user = change_password(&conn, &username, &current_password, &new_password)?;
    *sess.0.lock().unwrap() = Some(Session { username, must_change_password: false });
    Ok(user)
}
#[tauri::command] fn cmd_logout(state: State<DbState>, sess: State<SessionState>) -> Result<(), AppError> {
    let conn = state.conn()?;
    let username = session_identity(&sess)?;
    logout(&conn, &username)?;
    scanner::clear_owner(&username);
    *sess.0.lock().unwrap() = None;
    Ok(())
}
#[tauri::command] fn cmd_get_company_config(state: State<DbState>, sess: State<SessionState>) -> Result<CompanyConfig, AppError> {
    let conn = state.conn()?;
    authorize(&conn, &sess, "dashboard.view")?;
    get_company_config(&conn)
}
// ── Accounts: first-run administrator, password policy, recovery code ───────
#[derive(serde::Serialize)]
struct FirstRunState { needs_admin: bool }
#[tauri::command] fn cmd_get_first_run_state(state: State<DbState>) -> Result<FirstRunState, AppError> {
    Ok(FirstRunState { needs_admin: account::needs_first_admin(&*state.conn()?) })
}
/// Allowed only while the database holds nothing but the built-in first-run account.
#[tauri::command] fn cmd_complete_first_run(state: State<DbState>, sess: State<SessionState>, data: account::FirstRunSetup) -> Result<account::FirstRunResult, AppError> {
    let conn = state.conn()?;
    let result = account::complete_first_run(&conn, &data)?;
    *sess.0.lock().unwrap() = Some(Session { username: result.user.username.clone(), must_change_password: false });
    Ok(result)
}
/// Public: the rules are shown under every new-password field, before anyone has signed in.
#[tauri::command] fn cmd_get_password_policy(state: State<DbState>) -> Result<account::PasswordPolicy, AppError> {
    Ok(account::password_policy(&*state.conn()?))
}
#[tauri::command] fn cmd_set_password_policy(state: State<DbState>, sess: State<SessionState>, policy: account::PasswordPolicy) -> Result<account::PasswordPolicy, AppError> {
    let conn = state.conn()?;
    let user = session_user(&sess)?;
    account::set_password_policy(&conn, &user, policy)
}
/// «ماذا يستطيع كل دور»: which rows «موظف» and «مشاهد» have. Readable by user managers, changed by a System Admin.
#[tauri::command] fn cmd_get_role_permissions(state: State<DbState>, sess: State<SessionState>) -> Result<services::RoleGroups, AppError> {
    let conn = state.conn()?;
    let user = session_user(&sess)?;
    services::assert_permission(&conn, &user, "users.manage")?;
    Ok(services::role_groups(&conn))
}
#[tauri::command] fn cmd_set_role_permissions(state: State<DbState>, sess: State<SessionState>, groups: services::RoleGroups) -> Result<services::RoleGroups, AppError> {
    let conn = state.conn()?;
    let user = session_user(&sess)?;
    services::set_role_groups(&conn, &user, groups)
}
#[tauri::command] fn cmd_get_recovery_options(state: State<DbState>) -> Result<account::RecoveryOptions, AppError> {
    Ok(account::recovery_options(&*state.conn()?))
}
#[tauri::command] fn cmd_new_unlock_challenge(state: State<DbState>) -> Result<String, AppError> {
    account::new_unlock_challenge(&*state.conn()?)
}
#[tauri::command] fn cmd_unlock_admin(state: State<DbState>, unlock_code: String, new_password: String) -> Result<String, AppError> {
    account::unlock_admin(&*state.conn()?, &unlock_code, &new_password)
}
#[tauri::command] fn cmd_get_recovery_status(state: State<DbState>, sess: State<SessionState>) -> Result<account::RecoveryStatus, AppError> {
    let conn = state.conn()?;
    authorize(&conn, &sess, "users.assign_system_admin")?;
    Ok(account::recovery_status(&conn))
}
#[tauri::command] fn cmd_regenerate_recovery_code(state: State<DbState>, sess: State<SessionState>) -> Result<String, AppError> {
    let conn = state.conn()?;
    let user = session_user(&sess)?;
    account::regenerate_recovery_code(&conn, &user)
}
#[tauri::command] fn cmd_recover_admin_password(state: State<DbState>, code: String, new_password: String) -> Result<account::RecoveryResult, AppError> {
    account::recover_admin_password(&*state.conn()?, &code, &new_password)
}
#[tauri::command] fn cmd_get_public_company_config(state: State<DbState>) -> Result<CompanyConfig, AppError> {
    get_company_config(&*state.conn()?)
}
#[tauri::command] fn cmd_update_company_config(state: State<DbState>, sess: State<SessionState>, data: CompanyConfigData) -> Result<CompanyConfig, AppError> {
    let user = session_user(&sess)?;
    let conn = state.conn()?;
    logged_failure(&conn, &user, "CHANGE_SETTING", Some("settings"), None, Some("company_config"), update_company_config(&conn, &user, &data))
}
#[tauri::command] fn cmd_next_employee_number(state: State<DbState>, sess: State<SessionState>) -> Result<String, AppError> {
    let conn = state.conn()?;
    authorize(&conn, &sess, "employees.create")?;
    next_employee_number(&conn)
}
#[tauri::command] fn cmd_list_employees(state: State<DbState>, sess: State<SessionState>) -> Result<Vec<Employee>, AppError> {
    let conn = state.conn()?;
    authorize(&conn, &sess, "employees.view")?;
    list_employees(&conn)
}
#[tauri::command] fn cmd_get_employee(state: State<DbState>, sess: State<SessionState>, id: i64) -> Result<Employee, AppError> {
    let conn = state.conn()?;
    authorize(&conn, &sess, "employees.view")?;
    get_employee(&conn, id)
}
#[tauri::command] fn cmd_create_employee(state: State<DbState>, sess: State<SessionState>, data: EmployeeData) -> Result<Employee, AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "employees.create")?;
    logged_failure(&conn, &user, "CREATE_EMPLOYEE", Some("employee"), None, Some(data.full_name.trim()), create_employee(&conn, &data, &user))
}
#[tauri::command] fn cmd_update_employee(state: State<DbState>, sess: State<SessionState>, id: i64, data: EmployeeData) -> Result<Employee, AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "employees.edit")?;
    logged_failure(&conn, &user, "UPDATE_EMPLOYEE", Some("employee"), Some(id), Some(data.full_name.trim()), update_employee(&conn, id, &data, &user))
}
#[tauri::command] fn cmd_list_name_review(state: State<DbState>, sess: State<SessionState>) -> Result<Vec<names::ReviewItem>, AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "employees.edit")?;
    list_name_review(&conn, &user)
}
#[tauri::command] fn cmd_save_name_review(state: State<DbState>, sess: State<SessionState>, employee_id: i64, owner: String, index: i64, field: String, parts: serde_json::Value) -> Result<String, AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "employees.edit")?;
    save_name_review(&conn, employee_id, &owner, index, &field, &parts, &user)
}
#[tauri::command] fn cmd_delete_employee(state: State<DbState>, sess: State<SessionState>, id: i64) -> Result<(), AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "employees.delete")?;
    logged_failure(&conn, &user, "DELETE_EMPLOYEE", Some("employee"), Some(id), None, delete_employee(&conn, id, &user))
}
#[tauri::command] fn cmd_upload_employee_photo(state: State<DbState>, sess: State<SessionState>, employee_id: i64, source_path: String) -> Result<String, AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "employees.edit")?;
    let result = upload_employee_photo(&conn, employee_id, &source_path)?;
    log_activity(&conn, &user, "UPLOAD_DOCUMENT", Some("employee"), Some(employee_id), Some(&result), Some("photo"));
    Ok(result)
}
#[tauri::command] fn cmd_list_address_places(state: State<DbState>, sess: State<SessionState>) -> Result<Vec<AddressPlace>, AppError> {
    let conn = state.conn()?;
    authorize(&conn, &sess, "employees.view")?;
    list_address_places(&conn)
}
/// A district or sub-district missing from the bundled list, added while entering an address.
#[tauri::command] fn cmd_add_address_place(state: State<DbState>, sess: State<SessionState>, place: AddressPlace) -> Result<AddressPlace, AppError> {
    let conn = state.conn()?;
    let user = session_user(&sess)?;
    let permission = if assert_permission(&conn, &user, "employees.edit").is_ok() { "employees.edit" } else { "employees.create" };
    let user = authorize(&conn, &sess, permission)?;
    add_address_place(&conn, &place, &user)
}
#[tauri::command] fn cmd_delete_employee_photo(state: State<DbState>, sess: State<SessionState>, employee_id: i64) -> Result<(), AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "employees.edit")?;
    files::delete_employee_photo(&conn, employee_id)?;
    log_activity(&conn, &user, "DELETE_DOCUMENT", Some("employee"), Some(employee_id), None, Some("photo"));
    Ok(())
}
#[tauri::command] fn cmd_upload_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, source_path: String) -> Result<String, AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "documents.upload")?;
    let rel = files::upload_attachment(&conn, employee_id, &source_path)?;
    log_activity(&conn, &user, "UPLOAD_ATTACHMENT", Some("employee"), Some(employee_id), Some(&rel), None);
    Ok(rel)
}
#[tauri::command] fn cmd_upload_national_card_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, side: String, source_path: String) -> Result<String, AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "documents.upload")?;
    let rel = files::upload_national_card_attachment(&conn, employee_id, &side, &source_path)?;
    log_activity(&conn, &user, "UPLOAD_NATIONAL_CARD_ATTACHMENT", Some("employee"), Some(employee_id), Some(&rel), Some(&side));
    Ok(rel)
}
#[tauri::command] fn cmd_delete_national_card_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, side: String) -> Result<(), AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "documents.delete")?;
    files::delete_national_card_attachment(&conn, employee_id, &side)?;
    log_activity(&conn, &user, "DELETE_NATIONAL_CARD_ATTACHMENT", Some("employee"), Some(employee_id), None, Some(&side));
    Ok(())
}
#[tauri::command] fn cmd_upload_family_national_card_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, member_index: usize, side: String, source_path: String) -> Result<String, AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "documents.upload")?;
    let rel = files::upload_family_national_card_attachment(&conn, employee_id, member_index, &side, &source_path)?;
    log_activity(&conn, &user, "UPLOAD_FAMILY_NATIONAL_CARD_ATTACHMENT", Some("employee"), Some(employee_id), Some(&rel), Some(&format!("{}:{}", member_index, side)));
    Ok(rel)
}
#[tauri::command] fn cmd_delete_family_national_card_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, member_index: usize, side: String) -> Result<(), AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "documents.delete")?;
    files::delete_family_national_card_attachment(&conn, employee_id, member_index, &side)?;
    log_activity(&conn, &user, "DELETE_FAMILY_NATIONAL_CARD_ATTACHMENT", Some("employee"), Some(employee_id), None, Some(&format!("{}:{}", member_index, side)));
    Ok(())
}
#[tauri::command] fn cmd_upload_vehicle_annual_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, vehicle_index: usize, side: String, source_path: String) -> Result<String, AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "documents.upload")?;
    let rel = files::upload_vehicle_annual_attachment(&conn, employee_id, vehicle_index, &side, &source_path)?;
    log_activity(&conn, &user, "UPLOAD_VEHICLE_ANNUAL_ATTACHMENT", Some("employee"), Some(employee_id), Some(&rel), Some(&format!("{}:{}", vehicle_index, side)));
    Ok(rel)
}
#[tauri::command] fn cmd_delete_vehicle_annual_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, vehicle_index: usize, side: String) -> Result<(), AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "documents.delete")?;
    files::delete_vehicle_annual_attachment(&conn, employee_id, vehicle_index, &side)?;
    log_activity(&conn, &user, "DELETE_VEHICLE_ANNUAL_ATTACHMENT", Some("employee"), Some(employee_id), None, Some(&format!("{}:{}", vehicle_index, side)));
    Ok(())
}
#[tauri::command] fn cmd_upload_spouse_national_card_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, spouse_index: usize, side: String, source_path: String) -> Result<String, AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "documents.upload")?;
    let rel = files::upload_spouse_national_card_attachment(&conn, employee_id, spouse_index, &side, &source_path)?;
    log_activity(&conn, &user, "UPLOAD_SPOUSE_NATIONAL_CARD_ATTACHMENT", Some("employee"), Some(employee_id), Some(&rel), Some(&format!("{}:{}", spouse_index, side)));
    Ok(rel)
}
#[tauri::command] fn cmd_delete_spouse_national_card_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, spouse_index: usize, side: String) -> Result<(), AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "documents.delete")?;
    files::delete_spouse_national_card_attachment(&conn, employee_id, spouse_index, &side)?;
    log_activity(&conn, &user, "DELETE_SPOUSE_NATIONAL_CARD_ATTACHMENT", Some("employee"), Some(employee_id), None, Some(&format!("{}:{}", spouse_index, side)));
    Ok(())
}
#[tauri::command] fn cmd_upload_residence_card_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, side: String, source_path: String) -> Result<String, AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "documents.upload")?;
    let rel = files::upload_residence_card_attachment(&conn, employee_id, &side, &source_path)?;
    log_activity(&conn, &user, "UPLOAD_RESIDENCE_CARD_ATTACHMENT", Some("employee"), Some(employee_id), Some(&rel), Some(&side));
    Ok(rel)
}
#[tauri::command] fn cmd_delete_residence_card_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, side: String) -> Result<(), AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "documents.delete")?;
    files::delete_residence_card_attachment(&conn, employee_id, &side)?;
    log_activity(&conn, &user, "DELETE_RESIDENCE_CARD_ATTACHMENT", Some("employee"), Some(employee_id), None, Some(&side));
    Ok(())
}
#[tauri::command] fn cmd_upload_airport_badge_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, side: String, source_path: String) -> Result<String, AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "documents.upload")?;
    let rel = files::upload_airport_badge_attachment(&conn, employee_id, &side, &source_path)?;
    log_activity(&conn, &user, "UPLOAD_AIRPORT_BADGE_ATTACHMENT", Some("employee"), Some(employee_id), Some(&rel), Some(&side));
    Ok(rel)
}
#[tauri::command] fn cmd_delete_airport_badge_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, side: String) -> Result<(), AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "documents.delete")?;
    files::delete_airport_badge_attachment(&conn, employee_id, &side)?;
    log_activity(&conn, &user, "DELETE_AIRPORT_BADGE_ATTACHMENT", Some("employee"), Some(employee_id), None, Some(&side));
    Ok(())
}
#[tauri::command] fn cmd_upload_ministry_badge_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, side: String, source_path: String) -> Result<String, AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "documents.upload")?;
    let rel = files::upload_ministry_badge_attachment(&conn, employee_id, &side, &source_path)?;
    log_activity(&conn, &user, "UPLOAD_MINISTRY_BADGE_ATTACHMENT", Some("employee"), Some(employee_id), Some(&rel), Some(&side));
    Ok(rel)
}
#[tauri::command] fn cmd_delete_ministry_badge_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, side: String) -> Result<(), AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "documents.delete")?;
    files::delete_ministry_badge_attachment(&conn, employee_id, &side)?;
    log_activity(&conn, &user, "DELETE_MINISTRY_BADGE_ATTACHMENT", Some("employee"), Some(employee_id), None, Some(&side));
    Ok(())
}
#[tauri::command] fn cmd_upload_passport_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, source_path: String) -> Result<String, AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "documents.upload")?;
    let rel = files::upload_passport_attachment(&conn, employee_id, &source_path)?;
    log_activity(&conn, &user, "UPLOAD_PASSPORT_ATTACHMENT", Some("employee"), Some(employee_id), Some(&rel), None);
    Ok(rel)
}
#[tauri::command] fn cmd_delete_passport_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, relative_path: String) -> Result<(), AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "documents.delete")?;
    files::delete_passport_attachment(&conn, employee_id, &relative_path)?;
    log_activity(&conn, &user, "DELETE_PASSPORT_ATTACHMENT", Some("employee"), Some(employee_id), Some(&relative_path), None);
    Ok(())
}
#[tauri::command] fn cmd_upload_ration_card_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, source_path: String) -> Result<String, AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "documents.upload")?;
    let rel = files::upload_ration_card_attachment(&conn, employee_id, &source_path)?;
    log_activity(&conn, &user, "UPLOAD_RATION_CARD_ATTACHMENT", Some("employee"), Some(employee_id), Some(&rel), None);
    Ok(rel)
}
#[tauri::command] fn cmd_delete_ration_card_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, relative_path: String) -> Result<(), AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "documents.delete")?;
    files::delete_ration_card_attachment(&conn, employee_id, &relative_path)?;
    log_activity(&conn, &user, "DELETE_RATION_CARD_ATTACHMENT", Some("employee"), Some(employee_id), Some(&relative_path), None);
    Ok(())
}
#[tauri::command] fn cmd_delete_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, relative_path: String) -> Result<(), AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "documents.delete")?;
    files::delete_attachment(&conn, employee_id, &relative_path)?;
    log_activity(&conn, &user, "DELETE_ATTACHMENT", Some("employee"), Some(employee_id), Some(&relative_path), None);
    Ok(())
}
#[tauri::command] fn cmd_list_grade_history(state: State<DbState>, sess: State<SessionState>, employee_id: i64) -> Result<Vec<GradeHistory>, AppError> {
    let conn = state.conn()?;
    authorize(&conn, &sess, "employees.view")?;
    list_grade_history(&conn, employee_id)
}
#[tauri::command] fn cmd_add_grade_history(state: State<DbState>, sess: State<SessionState>, employee_id: i64, data: GradeHistoryData) -> Result<GradeHistory, AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "employees.edit")?;
    add_grade_history(&conn, employee_id, &data, &user)
}
#[tauri::command] fn cmd_delete_grade_history(state: State<DbState>, sess: State<SessionState>, id: i64) -> Result<(), AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "employees.edit")?;
    delete_grade_history(&conn, id, &user)
}
#[tauri::command] fn cmd_list_general_docs(state: State<DbState>, sess: State<SessionState>) -> Result<Vec<GeneralDoc>, AppError> {
    let conn = state.conn()?;
    authorize(&conn, &sess, "documents.view")?;
    list_general_docs(&conn)
}
#[tauri::command] fn cmd_create_general_doc(state: State<DbState>, sess: State<SessionState>, data: GeneralDocData) -> Result<GeneralDoc, AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "documents.manage")?;
    logged_failure(&conn, &user, "CREATE_DOC", Some("general_doc"), None, Some(data.title.trim()), create_general_doc(&conn, &data, &user))
}
#[tauri::command] fn cmd_update_general_doc(state: State<DbState>, sess: State<SessionState>, id: i64, data: GeneralDocData) -> Result<GeneralDoc, AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "documents.manage")?;
    logged_failure(&conn, &user, "UPDATE_DOC", Some("general_doc"), Some(id), Some(data.title.trim()), update_general_doc(&conn, id, &data, &user))
}
#[tauri::command] fn cmd_delete_general_doc(state: State<DbState>, sess: State<SessionState>, id: i64) -> Result<(), AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "documents.delete")?;
    logged_failure(&conn, &user, "DELETE_DOC", Some("general_doc"), Some(id), None, delete_general_doc(&conn, id, &user))
}
#[tauri::command] fn cmd_upload_general_doc_file(state: State<DbState>, sess: State<SessionState>, doc_id: i64, source_path: String) -> Result<String, AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "documents.upload")?;
    let path = upload_general_doc_file(&conn, doc_id, &source_path)?;
    log_activity(&conn, &user, "UPLOAD_DOCUMENT", Some("general_doc"), Some(doc_id), Some(&path), None);
    Ok(path)
}
#[tauri::command] fn cmd_delete_general_doc_attachment(state: State<DbState>, sess: State<SessionState>, doc_id: i64, relative_path: String) -> Result<(), AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "documents.delete")?;
    delete_general_doc_attachment(&conn, doc_id, &relative_path)?;
    log_activity(&conn, &user, "DELETE_DOCUMENT", Some("general_doc"), Some(doc_id), Some(&relative_path), None);
    Ok(())
}
#[tauri::command] fn cmd_move_general_doc_attachment(state: State<DbState>, sess: State<SessionState>, doc_id: i64, relative_path: String, direction: String) -> Result<(), AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "documents.manage")?;
    move_general_doc_attachment(&conn, doc_id, &relative_path, &direction)?;
    log_activity(&conn, &user, "REORDER_DOCUMENT_ATTACHMENT", Some("general_doc"), Some(doc_id), Some(&relative_path), Some(&direction));
    Ok(())
}
#[tauri::command] fn cmd_list_outgoing_docs(state: State<DbState>, sess: State<SessionState>) -> Result<Vec<GeneralDoc>, AppError> {
    let conn = state.conn()?;
    authorize(&conn, &sess, "documents.view")?;
    list_outgoing_docs(&conn)
}
#[tauri::command] fn cmd_create_outgoing_doc(state: State<DbState>, sess: State<SessionState>, data: GeneralDocData) -> Result<GeneralDoc, AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "documents.manage")?;
    logged_failure(&conn, &user, "CREATE_OUTGOING_DOC", Some("outgoing_doc"), None, Some(data.title.trim()), create_outgoing_doc(&conn, &data, &user))
}
#[tauri::command] fn cmd_update_outgoing_doc(state: State<DbState>, sess: State<SessionState>, id: i64, data: GeneralDocData) -> Result<GeneralDoc, AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "documents.manage")?;
    logged_failure(&conn, &user, "UPDATE_OUTGOING_DOC", Some("outgoing_doc"), Some(id), Some(data.title.trim()), update_outgoing_doc(&conn, id, &data, &user))
}
#[tauri::command] fn cmd_delete_outgoing_doc(state: State<DbState>, sess: State<SessionState>, id: i64) -> Result<(), AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "documents.delete")?;
    logged_failure(&conn, &user, "DELETE_OUTGOING_DOC", Some("outgoing_doc"), Some(id), None, delete_outgoing_doc(&conn, id, &user))
}
#[tauri::command] fn cmd_upload_outgoing_doc_file(state: State<DbState>, sess: State<SessionState>, doc_id: i64, source_path: String) -> Result<String, AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "documents.upload")?;
    let path = upload_outgoing_doc_file(&conn, doc_id, &source_path)?;
    log_activity(&conn, &user, "UPLOAD_DOCUMENT", Some("outgoing_doc"), Some(doc_id), Some(&path), None);
    Ok(path)
}
#[tauri::command] fn cmd_delete_outgoing_doc_attachment(state: State<DbState>, sess: State<SessionState>, doc_id: i64, relative_path: String) -> Result<(), AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "documents.delete")?;
    delete_outgoing_doc_attachment(&conn, doc_id, &relative_path)?;
    log_activity(&conn, &user, "DELETE_DOCUMENT", Some("outgoing_doc"), Some(doc_id), Some(&relative_path), None);
    Ok(())
}
#[tauri::command] fn cmd_move_outgoing_doc_attachment(state: State<DbState>, sess: State<SessionState>, doc_id: i64, relative_path: String, direction: String) -> Result<(), AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "documents.manage")?;
    move_outgoing_doc_attachment(&conn, doc_id, &relative_path, &direction)?;
    log_activity(&conn, &user, "REORDER_DOCUMENT_ATTACHMENT", Some("outgoing_doc"), Some(doc_id), Some(&relative_path), Some(&direction));
    Ok(())
}
#[tauri::command] fn cmd_list_activity_log(state: State<DbState>, sess: State<SessionState>, limit: i64) -> Result<Vec<ActivityLog>, AppError> {
    let conn = state.conn()?;
    authorize(&conn, &sess, "audit.view")?;
    list_activity_log(&conn, limit)
}
#[tauri::command] fn cmd_list_users(state: State<DbState>, sess: State<SessionState>) -> Result<Vec<User>, AppError> {
    let conn = state.conn()?;
    authorize(&conn, &sess, "users.manage")?;
    list_users(&conn)
}
#[tauri::command] fn cmd_create_user(state: State<DbState>, sess: State<SessionState>, data: UserData) -> Result<User, AppError> {
    let user = session_user(&sess)?;
    let conn = state.conn()?;
    logged_failure(&conn, &user, "CREATE_USER", Some("user"), None, Some(data.username.trim()), create_user(&conn, &user, &data))
}
#[tauri::command] fn cmd_delete_user(state: State<DbState>, sess: State<SessionState>, id: i64) -> Result<(), AppError> {
    let user = session_user(&sess)?;
    let conn = state.conn()?;
    logged_failure(&conn, &user, "DELETE_USER", Some("user"), Some(id), None, delete_user(&conn, &user, id))
}
#[tauri::command] fn cmd_update_user_role(state: State<DbState>, sess: State<SessionState>, id: i64, data: UserRoleData) -> Result<User, AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "users.manage")?;
    logged_failure(&conn, &user, "CHANGE_USER_ROLE", Some("user"), Some(id), None, update_user_role(&conn, &user, id, &data.role))
}
#[tauri::command] fn cmd_set_user_disabled(state: State<DbState>, sess: State<SessionState>, id: i64, data: UserDisabledData) -> Result<User, AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "users.manage")?;
    set_user_disabled(&conn, &user, id, data.disabled)
}
#[tauri::command] fn cmd_reset_user_password(state: State<DbState>, sess: State<SessionState>, id: i64, data: PasswordResetData) -> Result<(), AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "users.manage")?;
    logged_failure(&conn, &user, "RESET_USER_PASSWORD", Some("user"), Some(id), None, reset_user_password(&conn, &user, id, &data.password))
}
#[tauri::command] fn cmd_get_storage_path(state: State<DbState>, sess: State<SessionState>) -> Result<String, AppError> {
    let conn = state.conn()?;
    authorize(&conn, &sess, "settings.manage")?;
    get_storage_path(&conn)
}
#[tauri::command] fn cmd_get_backup_path(state: State<DbState>, sess: State<SessionState>) -> Result<String, AppError> {
    let conn = state.conn()?;
    authorize(&conn, &sess, "settings.manage")?;
    get_backup_path(&conn)
}
#[tauri::command] fn cmd_get_startup_status(info: State<StartupInfo>) -> StartupStatus {
    info.0.lock().unwrap_or_else(|e| e.into_inner()).clone()
}
/// Only usable while no database is open (first run, or the data folder went missing).
fn setup_allowed(state: &State<DbState>, info: &State<StartupInfo>) -> Result<bool, AppError> {
    if state.0.lock().unwrap_or_else(|e| e.into_inner()).is_some() {
        return Err(AppError::Unauthorized);
    }
    let current = info.0.lock().unwrap_or_else(|e| e.into_inner()).state.clone();
    match current.as_str() {
        "needs_setup" => Ok(false),
        "data_missing" | "open_failed" => Ok(true),
        _ => Err(AppError::Unauthorized),
    }
}
#[tauri::command] fn cmd_check_setup_folders(state: State<DbState>, info: State<StartupInfo>, data_root: String, backup_root: String) -> Result<storage::SetupCheck, AppError> {
    let require_existing = setup_allowed(&state, &info)?;
    storage::check_setup(std::path::Path::new(data_root.trim()), std::path::Path::new(backup_root.trim()), require_existing)
}
#[tauri::command] fn cmd_complete_setup(app: AppHandle, state: State<DbState>, info: State<StartupInfo>, data_root: String, backup_root: String) -> Result<StartupStatus, AppError> {
    let require_existing = setup_allowed(&state, &info)?;
    let conn = storage::complete_setup(std::path::Path::new(data_root.trim()), std::path::Path::new(backup_root.trim()), require_existing)?;
    activate_database(&app, &conn);
    *state.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(conn);
    let status = startup_status("ready", String::new());
    *info.0.lock().unwrap_or_else(|e| e.into_inner()) = status.clone();
    Ok(status)
}
/// Tries the configured data folder again, for example after plugging the disk back in.
#[tauri::command] fn cmd_retry_data_folder(app: AppHandle, state: State<DbState>, info: State<StartupInfo>) -> Result<StartupStatus, AppError> {
    setup_allowed(&state, &info)?;
    let status = match paths::resolve_startup()? {
        paths::StartupState::Ready(found) => {
            paths::set_current(Some(found));
            match db::open() {
                Ok(conn) => {
                    activate_database(&app, &conn);
                    *state.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(conn);
                    startup_status("ready", String::new())
                }
                Err(error) => startup_status("open_failed", error.to_string()),
            }
        }
        paths::StartupState::DataMissing(found) => {
            paths::set_current(Some(found));
            startup_status("data_missing", "ما زال مجلد البيانات غير متاح.".into())
        }
        paths::StartupState::NeedsSetup => startup_status("needs_setup", String::new()),
    };
    *info.0.lock().unwrap_or_else(|e| e.into_inner()) = status.clone();
    Ok(status)
}
#[tauri::command] fn cmd_get_storage_status(state: State<DbState>, sess: State<SessionState>) -> Result<storage::StorageStatus, AppError> {
    let conn = state.conn()?;
    authorize(&conn, &sess, "settings.manage")?;
    Ok(storage::storage_status())
}
#[tauri::command] fn cmd_change_backup_folder(state: State<DbState>, sess: State<SessionState>, path: String) -> Result<storage::StorageStatus, AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "settings.manage")?;
    storage::change_backup_root(&conn, &user, std::path::Path::new(path.trim()))
}
#[tauri::command]
async fn cmd_export_backup_to(window: Window, state: State<'_, DbState>, sess: State<'_, SessionState>, folder: String, password: String) -> Result<String, AppError> {
    let user = {
        let conn = state.conn()?;
        authorize(&conn, &sess, "backups.manage")?
    };
    let app = window.app_handle().clone();
    let progress_window = window.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DbState>();
        let conn = state.conn()?;
        storage::export_backup_to(&conn, &user, &password, std::path::Path::new(folder.trim()), &mut |progress| {
            let _ = progress_window.emit("backup-progress", progress);
        })
    })
    .await
    .map_err(|error| AppError::Other(error.to_string()))?
}
/// Moves database and attachments to a new folder, verifies the copy, then reopens the
/// database there. The old folder is kept. Everyone must sign in again afterwards.
#[tauri::command]
async fn cmd_move_data_folder(window: Window, state: State<'_, DbState>, sess: State<'_, SessionState>, path: String, password: String) -> Result<storage::StorageStatus, AppError> {
    let user = {
        let conn = state.conn()?;
        authorize(&conn, &sess, "settings.manage")?
    };
    let app = window.app_handle().clone();
    let progress_window = window.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DbState>();
        let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
        let conn = guard.as_ref().ok_or(AppError::Unauthorized)?;
        let old_root = paths::data_root();
        let (moved, safety) = storage::relocate_data(conn, &user, &password, std::path::Path::new(path.trim()), &mut |progress| {
            let _ = progress_window.emit("move-data-progress", progress);
        })?;
        // Switch to the verified copy. If it cannot be opened, stay on the old folder.
        let previous = paths::current();
        paths::set_current(Some(moved.clone()));
        match db::open_at(&moved.data_root.join(paths::DATABASE_FILE), false) {
            Ok(new_conn) => {
                log_activity(&new_conn, &user, "MOVE_DATA_FOLDER", Some("settings"), None, moved.data_root.to_str(),
                    Some(&format!("from {} ; safety backup {safety}", old_root.display())));
                activate_database(&app, &new_conn);
                *guard = Some(new_conn);
                Ok(storage::storage_status())
            }
            Err(error) => {
                paths::set_current(previous.clone());
                if let Some(previous) = previous { paths::write_config(&previous).ok(); }
                Err(AppError::Validation(format!("تم النسخ لكن تعذر فتح قاعدة البيانات في الموقع الجديد، وبقي البرنامج على الموقع القديم: {error}")))
            }
        }
    })
    .await
    .map_err(|error| AppError::Other(error.to_string()))??;
    *sess.0.lock().unwrap() = None;
    Ok(storage::storage_status())
}
/// Opens one of the managed folders (data or backups) in Windows Explorer.
/// The path is resolved here, never taken from the frontend.
#[tauri::command] fn cmd_open_managed_folder(state: State<DbState>, sess: State<SessionState>, kind: String) -> Result<(), AppError> {
    let conn = state.conn()?;
    authorize(&conn, &sess, "settings.manage")?;
    let path = match kind.as_str() {
        "data" => { ensure_storage_layout(&conn).ok(); storage_path(&conn) }
        "backups" => { ensure_backup_layout(&conn).ok(); backup_path(&conn) }
        _ => return Err(AppError::Validation("Unknown folder".into())),
    };
    drop(conn);
    #[cfg(not(target_os = "windows"))]
    { let _ = path; return Err(AppError::Validation("Opening folders is supported on Windows only".into())); }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer.exe")
            .arg(&path)
            .spawn()
            .map_err(|error| AppError::Other(error.to_string()))?;
        Ok(())
    }
}
/// Alert timing is read by everyone who can see employees (the alerts are built from them);
/// only a settings manager may change it.
#[tauri::command] fn cmd_get_document_alert_rules(state: State<DbState>, sess: State<SessionState>) -> Result<Vec<DocumentAlertRule>, AppError> {
    let conn = state.conn()?;
    authorize(&conn, &sess, "employees.view")?;
    get_document_alert_rules(&conn)
}
#[tauri::command] fn cmd_set_document_alert_rules(state: State<DbState>, sess: State<SessionState>, rules: Vec<DocumentAlertRule>) -> Result<Vec<DocumentAlertRule>, AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "settings.manage")?;
    set_document_alert_rules(&conn, &user, &rules)
}
/// For the home-screen reminder: when a full backup was last exported (None: never).
#[tauri::command] fn cmd_last_full_export(state: State<DbState>, sess: State<SessionState>) -> Result<Option<String>, AppError> {
    let conn = state.conn()?;
    authorize(&conn, &sess, "backups.manage")?;
    get_setting(&conn, "backup_last_export")
}
#[tauri::command] fn cmd_get_auto_backup_settings(state: State<DbState>, sess: State<SessionState>) -> Result<AutoBackupSettings, AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "backups.manage")?;
    get_auto_backup_settings(&conn, &user)
}
#[tauri::command] fn cmd_set_auto_backup_settings(state: State<DbState>, sess: State<SessionState>, data: AutoBackupSettingsData) -> Result<AutoBackupSettings, AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "backups.manage")?;
    set_auto_backup_settings(&conn, &user, &data)
}
#[tauri::command]
async fn cmd_run_due_auto_backups(window: Window, sess: State<'_, SessionState>, in_session: Option<bool>) -> Result<Vec<String>, AppError> {
    // Only a signed-in session can trigger backups. Without one nothing could have changed
    // since the last run, so there is nothing due and the call quietly does nothing.
    if session_identity(&sess).is_err() { return Ok(Vec::new()); }
    let progress_window = window.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Never migrates or creates anything: it only runs against an already open,
        // up-to-date database, and quietly does nothing during setup.
        if !db::db_path().is_file() { return Ok(Vec::new()); }
        let conn = db::open_existing().map_err(AppError::from)?;
        // The regular check while someone works is quiet: no progress window.
        let quiet = in_session.unwrap_or(false);
        match run_due_automatic_backups_with_progress(&conn, quiet, move |progress| {
            if quiet { return; }
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
/// Opens and checks a backup before a restore and says what it holds (date, employees, files).
#[tauri::command]
async fn cmd_inspect_backup(state: State<'_, DbState>, sess: State<'_, SessionState>, source_path: String, password: String) -> Result<BackupSummary, AppError> {
    {
        let conn = state.conn()?;
        authorize(&conn, &sess, "backups.restore")?;
    }
    tauri::async_runtime::spawn_blocking(move || inspect_backup(&source_path, &password))
        .await
        .map_err(|error| AppError::Other(error.to_string()))?
}
#[tauri::command]
async fn cmd_list_backups(state: State<'_, DbState>, sess: State<'_, SessionState>) -> Result<Vec<backup_store::BackupListItem>, AppError> {
    {
        let conn = state.conn()?;
        authorize(&conn, &sess, "backups.restore")?;
    }
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db::open_existing().map_err(AppError::from)?;
        Ok(backup_store::list_backups(&conn))
    })
    .await
    .map_err(|error| AppError::Other(error.to_string()))?
}
#[tauri::command] fn cmd_get_job_lists(state: State<DbState>, sess: State<SessionState>) -> Result<JobLists, AppError> {
    let conn = state.conn()?;
    authorize(&conn, &sess, "employees.view")?;
    get_job_lists(&conn)
}
#[tauri::command] fn cmd_set_job_lists(state: State<DbState>, sess: State<SessionState>, lists: JobLists) -> Result<JobLists, AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "settings.manage")?;
    set_job_lists(&conn, &user, &lists)
}
#[tauri::command] fn cmd_get_document_types(state: State<DbState>, sess: State<SessionState>) -> Result<Vec<String>, AppError> {
    let conn = state.conn()?;
    authorize(&conn, &sess, "documents.view")?;
    get_document_types(&conn)
}
#[tauri::command] fn cmd_set_document_types(state: State<DbState>, sess: State<SessionState>, types: Vec<String>) -> Result<Vec<String>, AppError> {
    let user = session_user(&sess)?;
    set_document_types(&*state.conn()?, &user, &types)
}
#[tauri::command]
async fn cmd_create_backup(window: Window, state: State<'_, DbState>, sess: State<'_, SessionState>, password: String) -> Result<String, AppError> {
    let user = {
        let conn = state.conn()?;
        authorize(&conn, &sess, "backups.manage")?
    };
    let app = window.app_handle().clone();
    let progress_window = window.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DbState>();
        let conn = state.conn()?;
        create_backup_with_progress(&conn, &user, &password, move |progress| {
            let _ = progress_window.emit("backup-progress", progress);
        })
    })
    .await
    .map_err(|error| AppError::Other(error.to_string()))?
}
#[tauri::command]
async fn cmd_restore_backup(window: Window, state: State<'_, DbState>, sess: State<'_, SessionState>, source_path: String, password: String) -> Result<String, AppError> {
    let user = {
        let conn = state.conn()?;
        authorize(&conn, &sess, "backups.restore")?
    };
    let app = window.app_handle().clone();
    let progress_window = window.clone();
    let safety_copy = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<DbState>();
        let mut conn = state.conn()?;
        restore_backup_with_progress(&mut conn, &user, &source_path, &password, move |progress| {
            let _ = progress_window.emit("restore-progress", progress);
        })
    })
    .await
    .map_err(|error| AppError::Other(error.to_string()))??;
    *sess.0.lock().unwrap() = None;
    Ok(safety_copy)
}
#[tauri::command] fn cmd_audit_document_view(state: State<DbState>, sess: State<SessionState>, employee_id: i64, document_name: String) -> Result<(), AppError> {
    let conn = state.conn()?; let user = authorize(&conn, &sess, "documents.view")?;
    log_activity(&conn, &user, "VIEW_DOCUMENT", Some("employee"), Some(employee_id), Some(&document_name), None); Ok(())
}
#[tauri::command] fn cmd_audit_document_download(state: State<DbState>, sess: State<SessionState>, employee_id: i64, document_name: String) -> Result<(), AppError> {
    let conn = state.conn()?; let user = authorize(&conn, &sess, "documents.download")?;
    log_activity(&conn, &user, "DOWNLOAD_DOCUMENT", Some("employee"), Some(employee_id), Some(&document_name), None); Ok(())
}
#[tauri::command] fn cmd_download_document(state: State<DbState>, sess: State<SessionState>, relative_path: String, destination_path: String) -> Result<String, AppError> {
    let conn = state.conn()?; let user = authorize(&conn, &sess, "documents.download")?;
    download_document(&conn, &user, &relative_path, &destination_path)
}
#[tauri::command] fn cmd_get_document_preview_path(state: State<DbState>, sess: State<SessionState>, relative_path: String) -> Result<String, AppError> {
    let conn = state.conn()?; let user = authorize(&conn, &sess, "documents.view")?;
    document_preview_path(&conn, &user, &relative_path)
}
#[tauri::command] fn cmd_read_document(state: State<DbState>, sess: State<SessionState>, relative_path: String) -> Result<tauri::ipc::Response, AppError> {
    let conn = state.conn()?; let user = authorize(&conn, &sess, "documents.view")?;
    // Raw bytes reach the frontend as an ArrayBuffer; a Vec<u8> would be sent as a JSON
    // array of numbers, several times larger and slow to parse for big PDFs.
    read_document(&conn, &user, &relative_path).map(tauri::ipc::Response::new)
}
#[tauri::command] fn cmd_print_document(state: State<DbState>, sess: State<SessionState>, relative_path: String) -> Result<(), AppError> {
    let conn = state.conn()?; let user = authorize(&conn, &sess, "documents.print")?;
    print_document(&conn, &user, &relative_path)
}
#[tauri::command] fn cmd_print_employee_documents(state: State<DbState>, sess: State<SessionState>, employee_id: i64, document_names: Vec<String>) -> Result<(), AppError> {
    let conn = state.conn()?; let user = authorize(&conn, &sess, "documents.print")?;
    log_activity(&conn, &user, "PRINT_DOCUMENT", Some("employee"), Some(employee_id), Some(&document_names.join(", ")), None); Ok(())
}
/// Saves the employees report as Excel and records it in the system log (who, how many
/// employees and columns, which file): the report carries personal data.
#[tauri::command] fn cmd_save_report_xlsx(state: State<DbState>, sess: State<SessionState>, destination_path: String, headers: Vec<String>, rows: Vec<Vec<String>>, date_columns: Option<Vec<usize>>) -> Result<(), AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "employees.view")?;
    let workbook = build_report_xlsx(&headers, &rows, &date_columns.unwrap_or_default())?;
    std::fs::write(&destination_path, workbook).map_err(|e| AppError::Other(e.to_string()))?;
    log_activity(&conn, &user, "EXPORT_REPORT", Some("report"), None, file_name_of(&destination_path).as_deref(),
        Some(&report_log_details(rows.len(), &headers)));
    Ok(())
}

fn file_name_of(path: &str) -> Option<String> {
    std::path::Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned())
}

// ── سجل النظام ──────────────────────────────────────────────────────────────
#[tauri::command] fn cmd_search_activity_log(state: State<DbState>, sess: State<SessionState>, filter: ActivityLogFilter) -> Result<ActivityLogPage, AppError> {
    let conn = state.conn()?;
    authorize(&conn, &sess, "audit.view")?;
    search_activity_log(&conn, &filter)
}
/// Saves the log entries the screen shows (already in Arabic) to an Excel file, and records it.
#[tauri::command] fn cmd_export_activity_log(state: State<DbState>, sess: State<SessionState>, destination_path: String, headers: Vec<String>, rows: Vec<Vec<String>>) -> Result<(), AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "audit.view")?;
    if rows.len() as i64 > AUDIT_EXPORT_LIMIT { return Err(AppError::Validation("Too many rows to export".into())); }
    let workbook = build_report_xlsx(&headers, &rows, &[])?;
    std::fs::write(&destination_path, workbook).map_err(|e| AppError::Other(e.to_string()))?;
    log_activity(&conn, &user, "EXPORT_AUDIT_LOG", Some("audit"), None, file_name_of(&destination_path).as_deref(),
        Some(&serde_json::json!({ "rows": rows.len() }).to_string()));
    Ok(())
}
/// Printing (or saving as PDF) the employees report happens in the window; it is recorded here.
#[tauri::command] fn cmd_audit_report_print(state: State<DbState>, sess: State<SessionState>, employee_count: usize, headers: Vec<String>) -> Result<(), AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "employees.view")?;
    log_activity(&conn, &user, "PRINT_REPORT", Some("report"), None, None, Some(&report_log_details(employee_count, &headers)));
    Ok(())
}

/// «14 موظفاً، 7 أعمدة: الرقم الوظيفي، الاسم …» for the system log.
fn report_log_details(employees: usize, headers: &[String]) -> String {
    format!("{employees} موظفاً، {} أعمدة: {}", headers.len(), headers.join("، "))
}
/// The archive's preview reads files with `cmd_read_document`, which also feeds thumbnails and so
/// does not log. Opening an attachment to look at it is recorded here, once per opening.
#[tauri::command] fn cmd_audit_archive_view(state: State<DbState>, sess: State<SessionState>, relative_path: String) -> Result<(), AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "documents.view")?;
    let found = |table: &str, column: &str| conn.query_row(
        &format!("SELECT {column} FROM {table} WHERE file_path=?1"), rusqlite::params![relative_path], |r| r.get::<_, i64>(0)).ok();
    let (kind, id) = match found("general_doc_attachments", "general_doc_id") {
        Some(id) => ("general_doc", Some(id)),
        None => ("outgoing_doc", found("outgoing_doc_attachments", "outgoing_doc_id")),
    };
    if id.is_none() { return Err(AppError::NotFound); }
    log_activity(&conn, &user, "VIEW_DOCUMENT", Some(kind), id, Some(&relative_path), None);
    Ok(())
}


// ── Application updates ──────────────────────────────────────────────────────
// Checking and installing run in Rust so that only an administrator can trigger them,
// and so that a verified backup is always taken before an update is installed.

#[derive(Clone, serde::Serialize)]
struct UpdateInfo {
    configured: bool,
    available: bool,
    current_version: String,
    version: String,
    notes: String,
    date: String,
}

const UPDATER_PUBKEY_PLACEHOLDER: &str = "REPLACE_WITH_PUBLIC_KEY";

fn is_real_pubkey(key: &str) -> bool {
    !key.trim().is_empty() && !key.starts_with(UPDATER_PUBKEY_PLACEHOLDER)
}

fn updater_configured(app: &AppHandle) -> bool {
    app.config().plugins.0.get("updater")
        .and_then(|value| value.get("pubkey"))
        .and_then(|value| value.as_str())
        .is_some_and(is_real_pubkey)
}

/// A short Arabic explanation of an updater error, by its cause.
fn update_error_message(error: &tauri_plugin_updater::Error) -> &'static str {
    use tauri_plugin_updater::Error as E;
    match error {
        // The request never got an answer: no network, DNS, or the server is unreachable.
        E::Reqwest(e) if e.is_connect() || e.is_timeout() || e.is_request() =>
            "لا يوجد اتصال بالإنترنت، أو تعذر الوصول إلى خادم التحديثات. أعد المحاولة لاحقًا.",
        // The server answered, but there is no usable release file for this computer.
        E::ReleaseNotFound | E::Serialization(_) | E::Semver(_)
        | E::TargetNotFound(_) | E::TargetsNotFound(_) => "لا يوجد تحديث متاح حاليًا.",
        E::Minisign(_) | E::SignedVersionMismatch { .. } | E::MissingSignedVersion =>
            "توقيع التحديث غير صحيح، لذلك لم يُثبَّت ولم يتغير شيء. تواصل مع المطوّر.",
        _ => "تعذر التحقق من التحديثات. أعد المحاولة لاحقًا.",
    }
}

fn update_error(error: tauri_plugin_updater::Error) -> AppError {
    // The technical detail goes to the error log (فحص البرنامج), not to the user.
    errlog::record_backend("update", &error.to_string());
    AppError::Validation(update_error_message(&error).into())
}

/// The public repository whose GitHub releases carry the installers and the «ما الجديد» notes.
const RELEASES_REPO: &str = "engessamh-dev/CNSArch-releases";

/// True for a plain version number such as 1.1.0 (the only text put into the notes URL).
fn is_plain_version(version: &str) -> bool {
    !version.is_empty() && version.len() <= 20
        && version.chars().all(|c| c.is_ascii_digit() || c == '.')
        && !version.starts_with('.') && !version.ends_with('.')
}

/// «ما الجديد»: the description written on GitHub for release v<version> (the current version
/// when none is given). Read only from the fixed releases repository; shown as plain text.
#[tauri::command]
async fn cmd_get_release_notes(app: AppHandle, version: Option<String>) -> Result<String, AppError> {
    let version = version.unwrap_or_else(|| app.package_info().version.to_string());
    if !is_plain_version(&version) {
        return Err(AppError::Validation("رقم إصدار غير صالح".into()));
    }
    let url = format!("https://api.github.com/repos/{RELEASES_REPO}/releases/tags/v{version}");
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let fetch = async {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(8))
            .user_agent("CNSArch-app")
            .build()?;
        let response = client.get(&url).header("Accept", "application/vnd.github+json").send().await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(String::new());
        }
        let release: serde_json::Value = response.error_for_status()?.json().await?;
        Ok::<_, reqwest::Error>(release.get("body").and_then(|b| b.as_str()).unwrap_or_default().chars().take(20_000).collect())
    };
    fetch.await.map_err(|error| {
        errlog::record_backend("update", &format!("release notes: {error}"));
        AppError::Validation("تعذر جلب ملاحظات الإصدار من الإنترنت.".into())
    })
}

#[tauri::command]
async fn cmd_check_for_update(app: AppHandle, state: State<'_, DbState>, sess: State<'_, SessionState>) -> Result<UpdateInfo, AppError> {
    {
        let conn = state.conn()?;
        authorize(&conn, &sess, "settings.manage")?;
    }
    let current_version = app.package_info().version.to_string();
    let mut info = UpdateInfo {
        configured: updater_configured(&app),
        available: false,
        current_version,
        version: String::new(),
        notes: String::new(),
        date: String::new(),
    };
    if !info.configured {
        return Ok(info);
    }
    use tauri_plugin_updater::UpdaterExt;
    let update = app.updater().map_err(update_error)?.check().await.map_err(update_error)?;
    if let Some(update) = update {
        info.available = true;
        info.version = update.version.clone();
        info.notes = update.body.clone().unwrap_or_default();
        info.date = update.date.map(|d| d.to_string()).unwrap_or_default();
    }
    Ok(info)
}

#[tauri::command]
fn cmd_get_auto_update(state: State<DbState>, sess: State<SessionState>) -> Result<bool, AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "settings.manage")?;
    assert_permission(&conn, &user, "backups.manage")?;
    get_auto_update(&conn)
}

#[tauri::command]
fn cmd_set_auto_update(state: State<DbState>, sess: State<SessionState>, enabled: bool) -> Result<bool, AppError> {
    let conn = state.conn()?;
    let user = authorize(&conn, &sess, "settings.manage")?;
    assert_permission(&conn, &user, "backups.manage")?;
    set_auto_update(&conn, &user, enabled)
}

/// Takes a verified encrypted backup (Backups/PreUpdate), then downloads, verifies the
/// signature of, and installs the update. Windows closes the app while the installer runs.
#[tauri::command]
async fn cmd_install_update(window: Window, state: State<'_, DbState>, sess: State<'_, SessionState>, password: String) -> Result<(), AppError> {
    let user = {
        let conn = state.conn()?;
        let user = authorize(&conn, &sess, "settings.manage")?;
        assert_permission(&conn, &user, "backups.manage")?;
        user
    };
    let app = window.app_handle().clone();
    if cfg!(debug_assertions) {
        return Err(AppError::Validation("تثبيت التحديثات غير متاح في نسخة التطوير".into()));
    }
    if !updater_configured(&app) {
        return Err(AppError::Validation("التحديث التلقائي غير مُعد بعد في هذه النسخة".into()));
    }
    use tauri_plugin_updater::UpdaterExt;
    let update = app.updater().map_err(update_error)?.check().await.map_err(update_error)?
        .ok_or_else(|| AppError::Validation("لا يوجد تحديث جديد".into()))?;

    let backup_app = app.clone();
    let progress_window = window.clone();
    let version = update.version.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = backup_app.state::<DbState>();
        let conn = state.conn()?;
        create_backup_at(&conn, &user, &password, "PreUpdate", &mut |progress| {
            let _ = progress_window.emit("update-progress", BackupProgress {
                percent: progress.percent / 2,
                message: format!("نسخة احتياطية قبل التحديث: {}", progress.message),
            });
        })?;
        log_activity(&conn, &user, "INSTALL_UPDATE", Some("app"), None, Some(&version), None);
        Ok::<_, AppError>(())
    })
    .await
    .map_err(|error| AppError::Other(error.to_string()))??;

    let progress_window = window.clone();
    let mut downloaded: u64 = 0;
    update.download_and_install(
        |chunk, total| {
            downloaded += chunk as u64;
            let percent = total.filter(|t| *t > 0).map(|t| 50 + (downloaded * 45 / t) as u8).unwrap_or(60);
            let _ = progress_window.emit("update-progress", BackupProgress {
                percent: percent.min(95),
                message: "جاري تنزيل التحديث والتحقق من توقيعه...".into(),
            });
        },
        || {
            let _ = window.emit("update-progress", BackupProgress { percent: 100, message: "جاري تثبيت التحديث...".into() });
        },
    ).await.map_err(|error| {
        errlog::record_backend("update", &error.to_string());
        let reason = match error {
            tauri_plugin_updater::Error::Minisign(_) => update_error_message(&error),
            _ => "فشل تنزيل التحديث أو تثبيته، ولم يتغير شيء. أعد المحاولة لاحقًا.",
        };
        AppError::Validation(reason.into())
    })?;
    app.restart();
}

// ── Program check and support («الفحص والدعم») ──────────────────────────────
// Available to every signed-in user. The report holds no personal data (see health.rs).

#[tauri::command]
async fn cmd_run_health_check(app: AppHandle, window: Window, state: State<'_, DbState>, sess: State<'_, SessionState>) -> Result<health::HealthReport, AppError> {
    // Signed in and a database is open; the check itself runs on its own read connection off
    // the main thread so the screen can show its progress bar while it works.
    { let _conn = state.conn()?; session_user(&sess)?; }
    let version = app.package_info().version.to_string();
    let updater = updater_configured(&app);
    tauri::async_runtime::spawn_blocking(move || {
        let conn = db::open_existing().map_err(AppError::from)?;
        Ok(health::run_with_progress(&conn, &version, updater, &errlog::recent(300), |step, total| {
            let _ = window.emit("health-check-progress", serde_json::json!({ "step": step, "total": total }));
        }))
    })
    .await
    .map_err(|error| AppError::Other(error.to_string()))?
}

/// Runs the check again in Rust and writes its text to the .txt file the user chose,
/// so the frontend cannot put anything else into the diagnostic file.
#[tauri::command]
fn cmd_save_health_report(app: AppHandle, state: State<DbState>, sess: State<SessionState>, destination_path: String) -> Result<String, AppError> {
    let conn = state.conn()?;
    let user = session_user(&sess)?;
    let destination = std::path::PathBuf::from(&destination_path);
    if !destination.is_absolute() || !destination.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("txt")) {
        return Err(AppError::Validation("اختر مكانًا لحفظ ملف نصي (.txt)".into()));
    }
    let report = health::run(&conn, &app.package_info().version.to_string(), updater_configured(&app), &errlog::recent(300));
    health::save(&report, &destination).map_err(|e| AppError::Other(e.to_string()))?;
    log_activity(&conn, &user, "SAVE_HEALTH_REPORT", Some("app"), None, Some(report.overall.as_str()), None);
    Ok(destination_path)
}

/// «كشف التعديل من خارج البرنامج» for the System Admin right after sign-in: whether the data still
/// needs approval on this computer, and which accounts were changed outside the program.
#[tauri::command]
fn cmd_get_integrity_status(state: State<DbState>, sess: State<SessionState>) -> Result<integrity::Status, AppError> {
    let conn = state.conn()?;
    authorize(&conn, &sess, "users.assign_system_admin")?;
    Ok(integrity::status(&conn))
}

/// The System Admin accepts the data as it is now (after a move, or after deliberate outside
/// changes). Seals everything with this computer's key and records it in the audit log.
#[tauri::command]
fn cmd_approve_integrity(state: State<DbState>, sess: State<SessionState>) -> Result<integrity::Status, AppError> {
    let conn = state.conn()?;
    // Checked by role only: approving is how a System Admin repairs flagged accounts, and an
    // account changed outside the program has no permissions at all (assert_permission).
    let user = authorize(&conn, &sess, "users.assign_system_admin")?;
    integrity::approve(&conn, &user, "approved by System Admin")?;
    Ok(integrity::status(&conn))
}

#[tauri::command]
fn cmd_get_support_contact() -> health::SupportContact {
    health::support_contact()
}

/// Opens WhatsApp or the mail program with a fixed support address. Only the URLs built
/// in health::support_url can be opened; nothing comes from the frontend but two keywords.
#[tauri::command]
fn cmd_open_support_link(app: AppHandle, channel: String, topic: String) -> Result<(), AppError> {
    let url = health::support_url(&channel, &topic, &app.package_info().version.to_string())
        .ok_or_else(|| AppError::Validation("Unknown support link".into()))?;
    #[cfg(not(target_os = "windows"))]
    { let _ = url; return Err(AppError::Validation("Opening links is supported on Windows only".into())); }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", url.as_str()])
            .spawn()
            .map_err(|error| AppError::Other(error.to_string()))?;
        Ok(())
    }
}

pub fn scanner_self_test() -> Result<(), String> {
    scanner::production_self_test().map_err(|error| error.to_string())
}

/// The screen reports a failed command or an unexpected script error. Everything is cleaned of
/// personal data in Rust (errlog.rs) before it is written; nothing here needs a session, so
/// errors on the sign-in screen are kept too.
#[tauri::command]
fn cmd_log_client_error(operation: String, screen: String, message: String, stack: Option<String>) {
    errlog::record_client(&operation, &screen, &message, stack.as_deref().unwrap_or(""));
}
/// A Windows notification, resolved only once Windows accepted it: a refusal (notifications
/// turned off for the program) or a failure is an error, so the caller can try again later.
#[tauri::command]
fn cmd_show_notification(app: AppHandle, title: String, body: String) -> Result<(), AppError> {
    let clip = |text: &str, max: usize| text.chars().take(max).collect::<String>();
    notify::show(&app.config().identifier, &clip(&title, 120), &clip(&body, 500)).map_err(|reason| {
        errlog::record_client("show_notification", "", &reason, "");
        AppError::Other(format!("Notification not shown: {reason}"))
    })
}

pub fn run() {
    errlog::init(app_data_path().join("Logs"), env!("CARGO_PKG_VERSION"));
    errlog::install_panic_hook();
    #[cfg(debug_assertions)]
    devseed::prepare();
    let (conn, status) = match paths::resolve_startup() {
        Ok(paths::StartupState::Ready(found)) => {
            paths::set_current(Some(found));
            match db::open() {
                Ok(conn) => (Some(conn), startup_status("ready", String::new())),
                Err(error) => (None, startup_status("open_failed", error.to_string())),
            }
        }
        Ok(paths::StartupState::DataMissing(found)) => {
            paths::set_current(Some(found));
            (None, startup_status("data_missing", "مجلد البيانات المحدد غير متاح. صِل القرص أو مجلد الشبكة ثم أعد المحاولة، أو اختر المجلد الذي يحتوي على البيانات.".into()))
        }
        Ok(paths::StartupState::NeedsSetup) => (None, startup_status("needs_setup", String::new())),
        Err(error) => (None, startup_status("open_failed", error.to_string())),
    };
    if status.state == "open_failed" || status.state == "data_missing" {
        errlog::record("database", &format!("startup_{}", status.state), &status.message);
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(DbState(Mutex::new(None)))
        .manage(SessionState(Mutex::new(None)))
        .manage(StartupInfo(Mutex::new(status)))
        .setup(move |app| {
            if let Some(conn) = conn {
                activate_database(app.handle(), &conn);
                *app.state::<DbState>().0.lock().unwrap() = Some(conn);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            cmd_login, cmd_change_password, cmd_logout,
            cmd_get_first_run_state, cmd_complete_first_run, cmd_get_password_policy, cmd_set_password_policy, cmd_get_role_permissions, cmd_set_role_permissions,
            cmd_get_recovery_options, cmd_new_unlock_challenge, cmd_unlock_admin, cmd_get_recovery_status, cmd_regenerate_recovery_code, cmd_recover_admin_password,
            cmd_get_company_config, cmd_get_public_company_config, cmd_update_company_config,
            cmd_next_employee_number,
            cmd_list_employees, cmd_get_employee,
            cmd_create_employee, cmd_update_employee, cmd_delete_employee,
            cmd_list_name_review, cmd_save_name_review,
            cmd_upload_employee_photo, cmd_delete_employee_photo, cmd_upload_employee_photo_crop, cmd_image_preview, cmd_list_address_places, cmd_add_address_place,
            cmd_upload_national_card_attachment, cmd_delete_national_card_attachment,
            cmd_upload_family_national_card_attachment, cmd_delete_family_national_card_attachment,
            cmd_upload_spouse_national_card_attachment, cmd_delete_spouse_national_card_attachment,
            cmd_upload_vehicle_annual_attachment, cmd_delete_vehicle_annual_attachment,
            cmd_upload_residence_card_attachment, cmd_delete_residence_card_attachment,
            cmd_upload_airport_badge_attachment, cmd_delete_airport_badge_attachment,
            cmd_upload_ministry_badge_attachment, cmd_delete_ministry_badge_attachment,
            cmd_upload_passport_attachment, cmd_delete_passport_attachment,
            cmd_upload_ration_card_attachment, cmd_delete_ration_card_attachment,
            cmd_upload_attachment, cmd_delete_attachment,
            cmd_scanner_settings, cmd_set_scanner_settings, cmd_scanner_prepare, cmd_scanner_render,
            cmd_scanner_release, cmd_scanner_save_existing, cmd_scanner_upload, cmd_scanner_detect, cmd_scanner_versions,
            cmd_get_document_download_name, cmd_read_document_fields, cmd_read_image_fields,
            cmd_list_grade_history, cmd_add_grade_history, cmd_delete_grade_history,
            cmd_list_general_docs, cmd_create_general_doc, cmd_update_general_doc, cmd_delete_general_doc,
            cmd_upload_general_doc_file, cmd_delete_general_doc_attachment, cmd_move_general_doc_attachment,
            cmd_list_outgoing_docs, cmd_create_outgoing_doc, cmd_update_outgoing_doc, cmd_delete_outgoing_doc,
            cmd_upload_outgoing_doc_file, cmd_delete_outgoing_doc_attachment, cmd_move_outgoing_doc_attachment,
            cmd_select_scanner_device, cmd_scan_document,
            cmd_list_activity_log,
            cmd_search_activity_log,
            cmd_export_activity_log,
            cmd_audit_archive_view,
            cmd_audit_report_print,
            cmd_list_users, cmd_create_user, cmd_delete_user, cmd_update_user_role, cmd_reset_user_password, cmd_set_user_disabled,
            cmd_get_storage_path, cmd_get_backup_path, cmd_open_managed_folder,
            cmd_get_startup_status, cmd_check_setup_folders, cmd_complete_setup, cmd_retry_data_folder,
            cmd_get_storage_status, cmd_change_backup_folder, cmd_export_backup_to, cmd_move_data_folder,
            cmd_check_for_update, cmd_install_update, cmd_get_release_notes,
            cmd_run_health_check, cmd_save_health_report, cmd_get_integrity_status, cmd_approve_integrity, cmd_get_support_contact, cmd_open_support_link, cmd_log_client_error, cmd_show_notification, cmd_get_auto_update, cmd_set_auto_update,
            cmd_get_auto_backup_settings, cmd_set_auto_backup_settings,
            cmd_get_document_alert_rules, cmd_set_document_alert_rules,
            cmd_run_due_auto_backups, cmd_exit_app,
            cmd_get_document_types, cmd_set_document_types,
            cmd_inspect_backup, cmd_list_backups, cmd_last_full_export, cmd_get_job_lists, cmd_set_job_lists,
            cmd_create_backup, cmd_restore_backup, cmd_audit_document_view, cmd_audit_document_download, cmd_download_document,
            cmd_get_document_preview_path, cmd_read_document, cmd_print_document, cmd_print_employee_documents, cmd_save_report_xlsx,
        ])
        .run(tauri::generate_context!())
        .expect("error while running application");
}

#[cfg(test)]
mod report_export_tests {
    use super::*;

    #[test]
    fn release_notes_use_only_plain_versions_from_the_shipped_releases_repo() {
        assert!(is_plain_version("1.1.0"));
        for bad in ["", "1.1.0/../x", "v1.1.0", "1.1.0?a=b", ".1", "1."] { assert!(!is_plain_version(bad), "{bad}"); }
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let endpoint = config["plugins"]["updater"]["endpoints"][0].as_str().unwrap();
        assert!(endpoint.starts_with(&format!("https://github.com/{RELEASES_REPO}/releases/")));
    }

    #[test]
    fn update_errors_explain_their_cause() {
        use tauri_plugin_updater::Error as E;
        assert_eq!(update_error_message(&E::ReleaseNotFound), "لا يوجد تحديث متاح حاليًا.");
        assert_eq!(update_error_message(&E::TargetNotFound("windows-x86_64".into())), "لا يوجد تحديث متاح حاليًا.");
        let bad_json = serde_json::from_str::<serde_json::Value>("{").unwrap_err();
        assert_eq!(update_error_message(&E::Serialization(bad_json)), "لا يوجد تحديث متاح حاليًا.");
        assert!(update_error_message(&E::MissingSignedVersion).contains("توقيع"));
        assert!(update_error_message(&E::Network("500".into())).starts_with("تعذر التحقق"));
        // No English detail reaches the user.
        for error in [E::ReleaseNotFound, E::MissingSignedVersion, E::EmptyEndpoints] {
            assert!(!update_error_message(&error).chars().any(|c| c.is_ascii_alphabetic()));
        }
    }

    #[test]
    fn shipped_config_has_a_real_updater_public_key() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let updater = &config["plugins"]["updater"];
        assert!(is_real_pubkey(updater["pubkey"].as_str().unwrap()), "the real public key must be configured");
        assert!(!is_real_pubkey("REPLACE_WITH_PUBLIC_KEY_FROM_TAURI_SIGNER_GENERATE"));
        assert!(!is_real_pubkey("  "));
        assert!(is_real_pubkey("dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk="));
        // Endpoints must be HTTPS: the plugin refuses plain HTTP unless explicitly allowed.
        for endpoint in updater["endpoints"].as_array().unwrap() {
            // Releases live in the public releases-only repository, not the source repository.
            assert!(endpoint.as_str().unwrap().starts_with("https://github.com/engessamh-dev/CNSArch-releases/releases/"));
        }
    }
    use std::io::Read;

    #[test]
    fn report_xlsx_contains_workbook_and_rtl_sheet() {
        let bytes = build_report_xlsx(
            &["الاسم الرباعي".to_string(), "الهاتف".to_string()],
            &[vec!["سيف ناظم كريم".to_string(), "07700000001".to_string()]],
            &[],
        ).unwrap();
        let cursor = std::io::Cursor::new(bytes);
        let mut archive = zip::ZipArchive::new(cursor).unwrap();
        assert!(archive.by_name("xl/workbook.xml").is_ok());
        let mut sheet = String::new();
        archive.by_name("xl/worksheets/sheet1.xml").unwrap().read_to_string(&mut sheet).unwrap();
        assert!(sheet.contains("rightToLeft=\"1\""));
        assert!(sheet.contains("الاسم الرباعي"));
    }

    #[test]
    fn report_xlsx_writes_real_dates_and_leaves_empty_cells_empty() {
        let bytes = build_report_xlsx(
            &["الاسم".to_string(), "تاريخ النفاذ".to_string(), "الهاتف".to_string()],
            &[vec!["سيف".to_string(), "2026-12-07".to_string(), "".to_string()],
              vec!["مريم".to_string(), "2026-12-07، 2027-01-02".to_string(), "07700000001".to_string()]],
            &[1],
        ).unwrap();
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap();
        let mut sheet = String::new();
        archive.by_name("xl/worksheets/sheet1.xml").unwrap().read_to_string(&mut sheet).unwrap();
        // 2026-12-07 is day 46363 in Excel, shown with the yyyy/m/d style.
        assert!(sheet.contains(r#"<c r="B2" s="2"><v>46363</v></c>"#));
        // Two dates in one cell stay text; the empty phone has no cell; the phone keeps its 0.
        assert!(sheet.contains("2026-12-07، 2027-01-02"));
        assert!(!sheet.contains(r#"r="C2""#));
        assert!(sheet.contains("07700000001"));
        assert!(sheet.contains("<autoFilter"));
        let mut styles = String::new();
        archive.by_name("xl/styles.xml").unwrap().read_to_string(&mut styles).unwrap();
        assert!(styles.contains(r#"formatCode="yyyy/m/d""#));
        let mut workbook = String::new();
        archive.by_name("xl/workbook.xml").unwrap().read_to_string(&mut workbook).unwrap();
        assert!(workbook.contains("_xlnm.Print_Titles"));
    }

    #[test]
    fn report_log_details_name_the_count_and_columns() {
        assert_eq!(report_log_details(14, &["الاسم".to_string(), "الهاتف".to_string()]), "14 موظفاً، 2 أعمدة: الاسم، الهاتف");
    }
}
