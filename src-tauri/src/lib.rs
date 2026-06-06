// lib.rs — GCANS v2.0
mod db; mod services; mod files;
use services::*;
use tauri::{AppHandle, Manager, State};
use std::sync::Mutex;
use rusqlite::Connection;

struct DbState(Mutex<Connection>);

// Session state to track current user
struct SessionState(Mutex<Option<String>>);

fn session_user(sess: &State<SessionState>) -> Result<String, AppError> {
    sess.0.lock().unwrap().clone().ok_or(AppError::Unauthorized)
}

#[tauri::command] fn cmd_login(state: State<DbState>, sess: State<SessionState>, username: String, password: String) -> Result<User, AppError> {
    let conn = state.0.lock().unwrap();
    let user = login(&conn, &username, &password)?;
    *sess.0.lock().unwrap() = Some(username);
    Ok(user)
}
#[tauri::command] fn cmd_logout(state: State<DbState>, sess: State<SessionState>, username: String) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap();
    logout(&conn, &username)?;
    *sess.0.lock().unwrap() = None;
    Ok(())
}
#[tauri::command] fn cmd_get_company_config(state: State<DbState>) -> Result<CompanyConfig, AppError> {
    get_company_config(&state.0.lock().unwrap())
}
#[tauri::command] fn cmd_update_company_config(state: State<DbState>, sess: State<SessionState>, _user: String, data: CompanyConfigData) -> Result<CompanyConfig, AppError> {
    let user = session_user(&sess)?;
    update_company_config(&state.0.lock().unwrap(), &user, &data)
}
#[tauri::command] fn cmd_upload_company_logo(state: State<DbState>, sess: State<SessionState>, _user: String, source_path: String) -> Result<CompanyConfig, AppError> {
    let user = session_user(&sess)?;
    upload_company_logo(&state.0.lock().unwrap(), &user, &source_path)
}
#[tauri::command] fn cmd_next_employee_number(state: State<DbState>) -> Result<String, AppError> {
    next_employee_number(&state.0.lock().unwrap())
}
#[tauri::command] fn cmd_list_employees(state: State<DbState>) -> Result<Vec<Employee>, AppError> {
    list_employees(&state.0.lock().unwrap())
}
#[tauri::command] fn cmd_get_employee(state: State<DbState>, id: i64) -> Result<Employee, AppError> {
    get_employee(&state.0.lock().unwrap(), id)
}
#[tauri::command] fn cmd_create_employee(state: State<DbState>, sess: State<SessionState>, data: EmployeeData) -> Result<Employee, AppError> {
    let conn = state.0.lock().unwrap();
    let user = session_user(&sess)?;
    create_employee(&conn, &data, &user)
}
#[tauri::command] fn cmd_update_employee(state: State<DbState>, sess: State<SessionState>, id: i64, data: EmployeeData) -> Result<Employee, AppError> {
    let conn = state.0.lock().unwrap();
    let user = session_user(&sess)?;
    update_employee(&conn, id, &data, &user)
}
#[tauri::command] fn cmd_delete_employee(state: State<DbState>, sess: State<SessionState>, id: i64) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap();
    let user = session_user(&sess)?;
    delete_employee(&conn, id, &user)
}
#[tauri::command] fn cmd_upload_employee_photo(state: State<DbState>, sess: State<SessionState>, employee_id: i64, source_path: String) -> Result<String, AppError> {
    session_user(&sess)?;
    upload_employee_photo(&state.0.lock().unwrap(), employee_id, &source_path)
}
#[tauri::command] fn cmd_upload_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, source_path: String) -> Result<String, AppError> {
    let conn = state.0.lock().unwrap();
    let user = session_user(&sess)?;
    let rel = files::upload_attachment(&conn, employee_id, &source_path)?;
    log_activity(&conn, &user, "UPLOAD_ATTACHMENT", Some("employee"), Some(employee_id), Some(&rel), None);
    Ok(rel)
}
#[tauri::command] fn cmd_upload_national_card_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, side: String, source_path: String) -> Result<String, AppError> {
    let conn = state.0.lock().unwrap();
    let user = session_user(&sess)?;
    let rel = files::upload_national_card_attachment(&conn, employee_id, &side, &source_path)?;
    log_activity(&conn, &user, "UPLOAD_NATIONAL_CARD_ATTACHMENT", Some("employee"), Some(employee_id), Some(&rel), Some(&side));
    Ok(rel)
}
#[tauri::command] fn cmd_delete_national_card_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, side: String) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap();
    let user = session_user(&sess)?;
    files::delete_national_card_attachment(&conn, employee_id, &side)?;
    log_activity(&conn, &user, "DELETE_NATIONAL_CARD_ATTACHMENT", Some("employee"), Some(employee_id), None, Some(&side));
    Ok(())
}
#[tauri::command] fn cmd_upload_residence_card_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, side: String, source_path: String) -> Result<String, AppError> {
    let conn = state.0.lock().unwrap();
    let user = session_user(&sess)?;
    let rel = files::upload_residence_card_attachment(&conn, employee_id, &side, &source_path)?;
    log_activity(&conn, &user, "UPLOAD_RESIDENCE_CARD_ATTACHMENT", Some("employee"), Some(employee_id), Some(&rel), Some(&side));
    Ok(rel)
}
#[tauri::command] fn cmd_delete_residence_card_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, side: String) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap();
    let user = session_user(&sess)?;
    files::delete_residence_card_attachment(&conn, employee_id, &side)?;
    log_activity(&conn, &user, "DELETE_RESIDENCE_CARD_ATTACHMENT", Some("employee"), Some(employee_id), None, Some(&side));
    Ok(())
}
#[tauri::command] fn cmd_upload_passport_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, source_path: String) -> Result<String, AppError> {
    let conn = state.0.lock().unwrap();
    let user = session_user(&sess)?;
    let rel = files::upload_passport_attachment(&conn, employee_id, &source_path)?;
    log_activity(&conn, &user, "UPLOAD_PASSPORT_ATTACHMENT", Some("employee"), Some(employee_id), Some(&rel), None);
    Ok(rel)
}
#[tauri::command] fn cmd_delete_passport_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, relative_path: String) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap();
    let user = session_user(&sess)?;
    files::delete_passport_attachment(&conn, employee_id, &relative_path)?;
    log_activity(&conn, &user, "DELETE_PASSPORT_ATTACHMENT", Some("employee"), Some(employee_id), Some(&relative_path), None);
    Ok(())
}
#[tauri::command] fn cmd_upload_ration_card_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, source_path: String) -> Result<String, AppError> {
    let conn = state.0.lock().unwrap();
    let user = session_user(&sess)?;
    let rel = files::upload_ration_card_attachment(&conn, employee_id, &source_path)?;
    log_activity(&conn, &user, "UPLOAD_RATION_CARD_ATTACHMENT", Some("employee"), Some(employee_id), Some(&rel), None);
    Ok(rel)
}
#[tauri::command] fn cmd_delete_ration_card_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, relative_path: String) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap();
    let user = session_user(&sess)?;
    files::delete_ration_card_attachment(&conn, employee_id, &relative_path)?;
    log_activity(&conn, &user, "DELETE_RATION_CARD_ATTACHMENT", Some("employee"), Some(employee_id), Some(&relative_path), None);
    Ok(())
}
#[tauri::command] fn cmd_delete_attachment(state: State<DbState>, sess: State<SessionState>, employee_id: i64, relative_path: String) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap();
    let user = session_user(&sess)?;
    files::delete_attachment(&conn, employee_id, &relative_path)?;
    log_activity(&conn, &user, "DELETE_ATTACHMENT", Some("employee"), Some(employee_id), Some(&relative_path), None);
    Ok(())
}
#[tauri::command] fn cmd_list_grade_history(state: State<DbState>, employee_id: i64) -> Result<Vec<GradeHistory>, AppError> {
    list_grade_history(&state.0.lock().unwrap(), employee_id)
}
#[tauri::command] fn cmd_add_grade_history(state: State<DbState>, sess: State<SessionState>, employee_id: i64, data: GradeHistoryData) -> Result<GradeHistory, AppError> {
    let conn = state.0.lock().unwrap();
    let user = session_user(&sess)?;
    add_grade_history(&conn, employee_id, &data, &user)
}
#[tauri::command] fn cmd_delete_grade_history(state: State<DbState>, sess: State<SessionState>, id: i64) -> Result<(), AppError> {
    session_user(&sess)?;
    delete_grade_history(&state.0.lock().unwrap(), id)
}
#[tauri::command] fn cmd_list_general_docs(state: State<DbState>) -> Result<Vec<GeneralDoc>, AppError> {
    list_general_docs(&state.0.lock().unwrap())
}
#[tauri::command] fn cmd_create_general_doc(state: State<DbState>, sess: State<SessionState>, data: GeneralDocData) -> Result<GeneralDoc, AppError> {
    let conn = state.0.lock().unwrap();
    let user = session_user(&sess)?;
    create_general_doc(&conn, &data, &user)
}
#[tauri::command] fn cmd_update_general_doc(state: State<DbState>, sess: State<SessionState>, id: i64, data: GeneralDocData) -> Result<GeneralDoc, AppError> {
    let conn = state.0.lock().unwrap();
    let user = session_user(&sess)?;
    update_general_doc(&conn, id, &data, &user)
}
#[tauri::command] fn cmd_delete_general_doc(state: State<DbState>, sess: State<SessionState>, id: i64) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap();
    let user = session_user(&sess)?;
    delete_general_doc(&conn, id, &user)
}
#[tauri::command] fn cmd_upload_general_doc_file(state: State<DbState>, sess: State<SessionState>, doc_id: i64, source_path: String) -> Result<String, AppError> {
    session_user(&sess)?;
    upload_general_doc_file(&state.0.lock().unwrap(), doc_id, &source_path)
}
#[tauri::command] fn cmd_list_activity_log(state: State<DbState>, limit: i64) -> Result<Vec<ActivityLog>, AppError> {
    list_activity_log(&state.0.lock().unwrap(), limit)
}
#[tauri::command] fn cmd_list_users(state: State<DbState>, sess: State<SessionState>) -> Result<Vec<User>, AppError> {
    let conn = state.0.lock().unwrap();
    let user = session_user(&sess)?;
    assert_master(&conn, &user)?;
    list_users(&conn)
}
#[tauri::command] fn cmd_create_user(state: State<DbState>, sess: State<SessionState>, _user: String, data: UserData) -> Result<User, AppError> {
    let user = session_user(&sess)?;
    create_user(&state.0.lock().unwrap(), &user, &data)
}
#[tauri::command] fn cmd_delete_user(state: State<DbState>, sess: State<SessionState>, _user: String, id: i64) -> Result<(), AppError> {
    let user = session_user(&sess)?;
    delete_user(&state.0.lock().unwrap(), &user, id)
}
#[tauri::command] fn cmd_get_storage_path(state: State<DbState>, sess: State<SessionState>) -> Result<String, AppError> {
    let conn = state.0.lock().unwrap();
    let user = session_user(&sess)?;
    assert_master(&conn, &user)?;
    get_storage_path(&conn)
}
#[tauri::command] fn cmd_set_storage_path(app: AppHandle, state: State<DbState>, sess: State<SessionState>, path: String) -> Result<(), AppError> {
    let conn = state.0.lock().unwrap();
    let user = session_user(&sess)?;
    assert_master(&conn, &user)?;
    set_storage_path(&conn, &path)?;
    app.asset_protocol_scope()
        .allow_directory(storage_path(&conn), true)
        .map_err(|e| AppError::Other(e.to_string()))
}
#[tauri::command] fn cmd_get_document_types(state: State<DbState>) -> Result<Vec<String>, AppError> {
    get_document_types(&state.0.lock().unwrap())
}
#[tauri::command] fn cmd_set_document_types(state: State<DbState>, sess: State<SessionState>, types: Vec<String>) -> Result<Vec<String>, AppError> {
    let user = session_user(&sess)?;
    set_document_types(&state.0.lock().unwrap(), &user, &types)
}
// Export stubs (frontend handles HTML-to-print for now)
#[tauri::command] fn cmd_export_employees_pdf(_state: State<DbState>) -> Result<String, AppError> { Ok("".into()) }
#[tauri::command] fn cmd_export_employees_excel(_state: State<DbState>) -> Result<String, AppError> { Ok("".into()) }
#[tauri::command] fn cmd_print_employee_card(_state: State<DbState>, _id: i64) -> Result<String, AppError> { Ok("".into()) }

pub fn run() {
    let conn = db::open().expect("Failed to open database");
    ensure_storage_layout(&conn).ok();
    let storage_root = storage_path(&conn);
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(DbState(Mutex::new(conn)))
        .manage(SessionState(Mutex::new(None)))
        .setup(move |app| {
            app.asset_protocol_scope().allow_directory(&storage_root, true)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            cmd_login, cmd_logout,
            cmd_get_company_config, cmd_update_company_config, cmd_upload_company_logo,
            cmd_next_employee_number,
            cmd_list_employees, cmd_get_employee,
            cmd_create_employee, cmd_update_employee, cmd_delete_employee,
            cmd_upload_employee_photo,
            cmd_upload_national_card_attachment, cmd_delete_national_card_attachment,
            cmd_upload_residence_card_attachment, cmd_delete_residence_card_attachment,
            cmd_upload_passport_attachment, cmd_delete_passport_attachment,
            cmd_upload_ration_card_attachment, cmd_delete_ration_card_attachment,
            cmd_upload_attachment, cmd_delete_attachment,
            cmd_list_grade_history, cmd_add_grade_history, cmd_delete_grade_history,
            cmd_list_general_docs, cmd_create_general_doc, cmd_update_general_doc, cmd_delete_general_doc,
            cmd_upload_general_doc_file,
            cmd_list_activity_log,
            cmd_list_users, cmd_create_user, cmd_delete_user,
            cmd_get_storage_path, cmd_set_storage_path,
            cmd_get_document_types, cmd_set_document_types,
            cmd_export_employees_pdf, cmd_export_employees_excel, cmd_print_employee_card,
        ])
        .run(tauri::generate_context!())
        .expect("error while running application");
}
