/**
 * api.js — Tauri invoke bridge v2.0
 */
import { invoke } from "@tauri-apps/api/core";

export const api = {
  // Auth
  login:  (username, password) => invoke("cmd_login",  { username, password }),
  logout: (username)           => invoke("cmd_logout", { username }),

  // Company config
  getCompanyConfig:    ()           => invoke("cmd_get_company_config"),
  updateCompanyConfig: (user, data) => invoke("cmd_update_company_config", { user, data }),
  uploadCompanyLogo:   (user, path) => invoke("cmd_upload_company_logo", { user, sourcePath: path }),

  // Employees
  listEmployees:    ()         => invoke("cmd_list_employees"),
  getEmployee:      (id)       => invoke("cmd_get_employee",    { id }),
  createEmployee:   (data)     => invoke("cmd_create_employee", { data }),
  updateEmployee:   (id, data) => invoke("cmd_update_employee", { id, data }),
  deleteEmployee:   (id)       => invoke("cmd_delete_employee", { id }),
  nextEmployeeNumber: ()       => invoke("cmd_next_employee_number"),
  uploadAttachment: (empId, path) => invoke("cmd_upload_attachment", { employeeId: empId, sourcePath: path }),
  deleteAttachment: (empId, rel)  => invoke("cmd_delete_attachment", { employeeId: empId, relativePath: rel }),
  uploadEmployeePhoto: (empId, path) => invoke("cmd_upload_employee_photo", { employeeId: empId, sourcePath: path }),
  uploadNationalCardAttachment: (empId, side, path) => invoke("cmd_upload_national_card_attachment", { employeeId: empId, side, sourcePath: path }),
  deleteNationalCardAttachment: (empId, side) => invoke("cmd_delete_national_card_attachment", { employeeId: empId, side }),
  uploadResidenceCardAttachment: (empId, side, path) => invoke("cmd_upload_residence_card_attachment", { employeeId: empId, side, sourcePath: path }),
  deleteResidenceCardAttachment: (empId, side) => invoke("cmd_delete_residence_card_attachment", { employeeId: empId, side }),
  uploadPassportAttachment: (empId, path) => invoke("cmd_upload_passport_attachment", { employeeId: empId, sourcePath: path }),
  deletePassportAttachment: (empId, rel) => invoke("cmd_delete_passport_attachment", { employeeId: empId, relativePath: rel }),

  // Job grade history
  listGradeHistory: (empId)  => invoke("cmd_list_grade_history", { employeeId: empId }),
  addGradeHistory:  (empId, data) => invoke("cmd_add_grade_history", { employeeId: empId, data }),
  deleteGradeHistory: (id)   => invoke("cmd_delete_grade_history", { id }),

  // General document archive
  listGeneralDocs:   ()       => invoke("cmd_list_general_docs"),
  createGeneralDoc:  (data)   => invoke("cmd_create_general_doc",  { data }),
  updateGeneralDoc:  (id, data) => invoke("cmd_update_general_doc", { id, data }),
  deleteGeneralDoc:  (id)     => invoke("cmd_delete_general_doc",  { id }),
  uploadGeneralDocFile: (docId, path) => invoke("cmd_upload_general_doc_file", { docId, sourcePath: path }),

  // Activity log
  listActivityLog: (limit) => invoke("cmd_list_activity_log", { limit: limit ?? 50 }),

  // Users
  listUsers:  ()              => invoke("cmd_list_users"),
  createUser: (user, data)    => invoke("cmd_create_user",  { user, data }),
  deleteUser: (user, id)      => invoke("cmd_delete_user",  { user, id }),

  // Settings
  getStoragePath: ()     => invoke("cmd_get_storage_path"),
  setStoragePath: (path) => invoke("cmd_set_storage_path", { path }),
  getDocumentTypes: ()       => invoke("cmd_get_document_types"),
  setDocumentTypes: (types)  => invoke("cmd_set_document_types", { types }),

  // Export
  exportEmployeesPdf:   ()    => invoke("cmd_export_employees_pdf"),
  exportEmployeesExcel: ()    => invoke("cmd_export_employees_excel"),
  printEmployeeCard:    (id)  => invoke("cmd_print_employee_card", { id }),
};
