/**
 * api.js — Tauri invoke bridge v2.0
 */
// invoke from error-log.js is Tauri's invoke that also writes technical failures to the local error log.
import { invoke } from "./error-log.js";
import { uploadWithScanner } from "./attachments/scanner.js";

export const api = {
  // Auth
  login:  (username, password) => invoke("cmd_login",  { username, password }),
  changePassword: (currentPassword, newPassword) => invoke("cmd_change_password", { currentPassword, newPassword }),
  logout: ()                   => invoke("cmd_logout"),

  // Company config
  getCompanyConfig:    ()           => invoke("cmd_get_company_config"),
  getPublicCompanyConfig: ()        => invoke("cmd_get_public_company_config"),
  updateCompanyConfig: (data)       => invoke("cmd_update_company_config", { data }),

  // Employees
  listEmployees:    ()         => invoke("cmd_list_employees"),
  getEmployee:      (id)       => invoke("cmd_get_employee",    { id }),
  createEmployee:   (data)     => invoke("cmd_create_employee", { data }),
  updateEmployee:   (id, data) => invoke("cmd_update_employee", { id, data }),
  listNameReview:   () => invoke("cmd_list_name_review"),
  saveNameReview:   (employeeId, owner, index, field, parts) => invoke("cmd_save_name_review", { employeeId, owner, index, field, parts }),
  deleteEmployee:   (id)       => invoke("cmd_delete_employee", { id }),
  nextEmployeeNumber: ()       => invoke("cmd_next_employee_number"),
  uploadAttachment: (empId, path) => uploadWithScanner("cmd_upload_attachment", { employeeId: empId, sourcePath: path }),
  uploadDocumentAttachment: (empId, path) => invoke("cmd_upload_attachment", { employeeId: empId, sourcePath: path }),
  deleteAttachment: (empId, rel)  => invoke("cmd_delete_attachment", { employeeId: empId, relativePath: rel }),
  deleteEmployeePhoto: (empId) => invoke("cmd_delete_employee_photo", { employeeId: empId }),
  uploadEmployeePhoto: (empId, path) => uploadWithScanner("cmd_upload_employee_photo", { employeeId: empId, sourcePath: path }),
  uploadNationalCardAttachment: (empId, side, path) => uploadWithScanner("cmd_upload_national_card_attachment", { employeeId: empId, side, sourcePath: path }),
  deleteNationalCardAttachment: (empId, side) => invoke("cmd_delete_national_card_attachment", { employeeId: empId, side }),
  uploadFamilyNationalCardAttachment: (empId, memberIndex, side, path) => uploadWithScanner("cmd_upload_family_national_card_attachment", { employeeId: empId, memberIndex, side, sourcePath: path }),
  uploadVehicleAnnualAttachment: (empId, vehicleIndex, side, path) => uploadWithScanner("cmd_upload_vehicle_annual_attachment", { employeeId: empId, vehicleIndex, side, sourcePath: path }),
  deleteVehicleAnnualAttachment: (empId, vehicleIndex, side) => invoke("cmd_delete_vehicle_annual_attachment", { employeeId: empId, vehicleIndex, side }),
  deleteFamilyNationalCardAttachment: (empId, memberIndex, side) => invoke("cmd_delete_family_national_card_attachment", { employeeId: empId, memberIndex, side }),
  uploadSpouseNationalCardAttachment: (empId, spouseIndex, side, path) => uploadWithScanner("cmd_upload_spouse_national_card_attachment", { employeeId: empId, spouseIndex, side, sourcePath: path }),
  deleteSpouseNationalCardAttachment: (empId, spouseIndex, side) => invoke("cmd_delete_spouse_national_card_attachment", { employeeId: empId, spouseIndex, side }),
  uploadResidenceCardAttachment: (empId, side, path) => uploadWithScanner("cmd_upload_residence_card_attachment", { employeeId: empId, side, sourcePath: path }),
  deleteResidenceCardAttachment: (empId, side) => invoke("cmd_delete_residence_card_attachment", { employeeId: empId, side }),
  uploadAirportBadgeAttachment: (empId, side, path) => uploadWithScanner("cmd_upload_airport_badge_attachment", { employeeId: empId, side, sourcePath: path }),
  deleteAirportBadgeAttachment: (empId, side) => invoke("cmd_delete_airport_badge_attachment", { employeeId: empId, side }),
  uploadMinistryBadgeAttachment: (empId, side, path) => uploadWithScanner("cmd_upload_ministry_badge_attachment", { employeeId: empId, side, sourcePath: path }),
  deleteMinistryBadgeAttachment: (empId, side) => invoke("cmd_delete_ministry_badge_attachment", { employeeId: empId, side }),
  uploadPassportAttachment: (empId, path) => uploadWithScanner("cmd_upload_passport_attachment", { employeeId: empId, sourcePath: path }),
  deletePassportAttachment: (empId, rel) => invoke("cmd_delete_passport_attachment", { employeeId: empId, relativePath: rel }),
  // Reads the fields of a stored national card or passport image on this device (nothing is saved).
  readDocumentFields: (rel) => invoke("cmd_read_document_fields", { relativePath: rel }),
  readImageFields: (sourcePath) => invoke("cmd_read_image_fields", { sourcePath }),
  // The add-employee wizard uploads the images it already showed and read, without the
  // per-file crop dialog. Only the document upload commands are allowed here.
  wizardUpload: (command, args) => {
    if (!/^cmd_upload_(national_card|passport|ministry_badge|airport_badge|ration_card|residence_card|spouse_national_card|family_national_card)_attachment$/.test(command)) {
      return Promise.reject(new Error("Unsupported upload"));
    }
    return invoke(command, args);
  },
  uploadRationCardAttachment: (empId, path) => uploadWithScanner("cmd_upload_ration_card_attachment", { employeeId: empId, sourcePath: path }),
  deleteRationCardAttachment: (empId, rel) => invoke("cmd_delete_ration_card_attachment", { employeeId: empId, relativePath: rel }),

  // Job grade history
  listGradeHistory: (empId)  => invoke("cmd_list_grade_history", { employeeId: empId }),
  addGradeHistory:  (empId, data) => invoke("cmd_add_grade_history", { employeeId: empId, data }),
  deleteGradeHistory: (id)   => invoke("cmd_delete_grade_history", { id }),

  // General document archive
  listGeneralDocs:   ()       => invoke("cmd_list_general_docs"),
  createGeneralDoc:  (data)   => invoke("cmd_create_general_doc",  { data }),
  updateGeneralDoc:  (id, data) => invoke("cmd_update_general_doc", { id, data }),
  deleteGeneralDoc:  (id)     => invoke("cmd_delete_general_doc",  { id }),
  uploadGeneralDocFile: (docId, path) => uploadWithScanner("cmd_upload_general_doc_file", { docId, sourcePath: path }),
  deleteGeneralDocAttachment: (docId, relativePath) => invoke("cmd_delete_general_doc_attachment", { docId, relativePath }),
  moveGeneralDocAttachment: (docId, relativePath, direction) => invoke("cmd_move_general_doc_attachment", { docId, relativePath, direction }),
  listOutgoingDocs: () => invoke("cmd_list_outgoing_docs"),
  createOutgoingDoc: (data) => invoke("cmd_create_outgoing_doc", { data }),
  updateOutgoingDoc: (id, data) => invoke("cmd_update_outgoing_doc", { id, data }),
  deleteOutgoingDoc: (id) => invoke("cmd_delete_outgoing_doc", { id }),
  uploadOutgoingDocFile: (docId, path) => uploadWithScanner("cmd_upload_outgoing_doc_file", { docId, sourcePath: path }),
  deleteOutgoingDocAttachment: (docId, relativePath) => invoke("cmd_delete_outgoing_doc_attachment", { docId, relativePath }),
  moveOutgoingDocAttachment: (docId, relativePath, direction) => invoke("cmd_move_outgoing_doc_attachment", { docId, relativePath, direction }),
  selectScannerDevice: () => invoke("cmd_select_scanner_device"),
  scanDocument: (deviceId) => invoke("cmd_scan_document", { deviceId }),

  // Activity log
  openManagedFolder: (kind) => invoke("cmd_open_managed_folder", { kind }),
  listActivityLog: (limit) => invoke("cmd_list_activity_log", { limit: limit ?? 50 }),

  // Users
  listUsers:  ()              => invoke("cmd_list_users"),
  createUser: (data)          => invoke("cmd_create_user",  { data }),
  deleteUser: (id)            => invoke("cmd_delete_user",  { id }),
  updateUserRole: (id, role)  => invoke("cmd_update_user_role", { id, data: { role } }),
  resetUserPassword: (id, password) => invoke("cmd_reset_user_password", { id, data: { password } }),

  getScannerSettings: () => invoke("cmd_scanner_settings"),
  setScannerSettings: (settings) => invoke("cmd_set_scanner_settings", { settings }),

  // Settings
  getStoragePath: ()     => invoke("cmd_get_storage_path"),
  getBackupPath: ()      => invoke("cmd_get_backup_path"),
  getStorageStatus: ()   => invoke("cmd_get_storage_status"),
  changeBackupFolder: (path) => invoke("cmd_change_backup_folder", { path }),
  moveDataFolder: (path, password) => invoke("cmd_move_data_folder", { path, password }),
  exportBackupTo: (folder, password) => invoke("cmd_export_backup_to", { folder, password }),

  // First run / data folder unavailable (only work while no database is open)
  getStartupStatus: () => invoke("cmd_get_startup_status"),
  checkSetupFolders: (dataRoot, backupRoot) => invoke("cmd_check_setup_folders", { dataRoot, backupRoot }),
  completeSetup: (dataRoot, backupRoot) => invoke("cmd_complete_setup", { dataRoot, backupRoot }),
  retryDataFolder: () => invoke("cmd_retry_data_folder"),

  // Application updates (administrators only; checked in Rust)
  checkForUpdate: () => invoke("cmd_check_for_update"),
  installUpdate: (password) => invoke("cmd_install_update", { password }),
  getAutoUpdate: () => invoke("cmd_get_auto_update"),
  setAutoUpdate: (enabled) => invoke("cmd_set_auto_update", { enabled }),

  // Program check and support (every signed-in user)
  runHealthCheck: () => invoke("cmd_run_health_check"),
  saveHealthReport: (destinationPath) => invoke("cmd_save_health_report", { destinationPath }),
  getIntegrityStatus: () => invoke("cmd_get_integrity_status"),
  approveIntegrity: () => invoke("cmd_approve_integrity"),
  // Writes a technical error (failed command or script exception) to the local error log.
  logClientError: (operation, screen, message, stack) => invoke("cmd_log_client_error", { operation, screen, message, stack }),
  getSupportContact: () => invoke("cmd_get_support_contact"),
  openSupportLink: (channel, topic) => invoke("cmd_open_support_link", { channel, topic }),
  // Expiry alert timing per document type (read: employees.view; save: settings.manage)
  getDocumentAlertRules: () => invoke("cmd_get_document_alert_rules"),
  setDocumentAlertRules: (rules) => invoke("cmd_set_document_alert_rules", { rules }),
  getAutoBackupSettings: () => invoke("cmd_get_auto_backup_settings"),
  setAutoBackupSettings: (data) => invoke("cmd_set_auto_backup_settings", { data }),
  runDueAutoBackups: () => invoke("cmd_run_due_auto_backups"),
  exitApp: () => invoke("cmd_exit_app"),
  createBackup: (password)       => invoke("cmd_create_backup", { password }),
  restoreBackup: (path, password)  => invoke("cmd_restore_backup", { sourcePath: path, password }),
  getDocumentTypes: ()       => invoke("cmd_get_document_types"),
  setDocumentTypes: (types)  => invoke("cmd_set_document_types", { types }),

  printEmployeeDocuments: (employeeId, documentNames) => invoke("cmd_print_employee_documents", { employeeId, documentNames }),
  saveReportXlsx: (destinationPath, headers, rows) => invoke("cmd_save_report_xlsx", { destinationPath, headers, rows }),
  auditDocumentView: (employeeId, documentName) => invoke("cmd_audit_document_view", { employeeId, documentName }),
  auditDocumentDownload: (employeeId, documentName) => invoke("cmd_audit_document_download", { employeeId, documentName }),
  downloadDocument: (relativePath, destinationPath) => invoke("cmd_download_document", { relativePath, destinationPath }),
  getDocumentDownloadName: (relativePath) => invoke("cmd_get_document_download_name", { relativePath }),
  getDocumentPreviewPath: (relativePath) => invoke("cmd_get_document_preview_path", { relativePath }),
  // The backend sends raw bytes (an ArrayBuffer), not a JSON array of numbers.
  readDocument: async (relativePath) => new Uint8Array(await invoke("cmd_read_document", { relativePath })),
  printDocument: (relativePath) => invoke("cmd_print_document", { relativePath }),
};
