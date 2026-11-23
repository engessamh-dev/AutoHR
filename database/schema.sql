-- GCANS Document Archive System — Schema v2.0

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL UNIQUE,
  password   TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('system_admin','archive_admin','archive_officer','viewer')),
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK(must_change_password IN (0,1)),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS company_config (
  id              INTEGER PRIMARY KEY CHECK(id = 1),
  company_name    TEXT NOT NULL DEFAULT 'الشركة العامة لخدمات الملاحة الجوية',
  department_name TEXT NOT NULL DEFAULT 'GCANS',
  division_name   TEXT NOT NULL DEFAULT '',
  logo_path       TEXT
);
INSERT OR IGNORE INTO company_config(id) VALUES(1);

CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);
INSERT OR IGNORE INTO app_settings(key,value) VALUES('storage_destination','');
INSERT OR IGNORE INTO app_settings(key,value) VALUES('document_types','["أمر إداري","كتاب رسمي","منشور","تعميم","عقد","محضر اجتماع","أخرى"]');

-- Main employees table
CREATE TABLE IF NOT EXISTS employees (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_number           TEXT UNIQUE,
  photo_path                TEXT,
  full_name                 TEXT NOT NULL,
  mother_name               TEXT,
  father_birthplace         TEXT,
  father_birthdate          TEXT,
  mother_birthplace         TEXT,
  mother_birthdate          TEXT,
  gender                    TEXT,
  birthdate                 TEXT,
  birthplace                TEXT,
  marital_status            TEXT,
  blood_type                TEXT,
  workplace                 TEXT,
  job_title                 TEXT,
  job_grade                 TEXT,
  hire_date                 TEXT,
  appointment_date          TEXT,
  contract_type             TEXT DEFAULT 'ملاك',
  work_type_notes           TEXT,
  work_schedule             TEXT,
  department                TEXT,
  division                  TEXT,
  phone                     TEXT,
  email                     TEXT,
  education_level           TEXT,
  specialization            TEXT,
  graduation_year           TEXT,
  civil_id                  TEXT,
  civil_id_issuer           TEXT,
  civil_id_issue_date       TEXT,
  civil_id_expiry_date      TEXT,
  civil_id_birthplace       TEXT,
  civil_id_birthdate        TEXT,
  civil_id_family_number    TEXT,
  civil_id_front_path       TEXT,
  civil_id_back_path        TEXT,
  residence_card_no         TEXT,
  residence_card_issuer     TEXT,
  residence_card_issue_date TEXT,
  residence_head_name       TEXT,
  residence_form_no         TEXT,
  residence_card_front_path TEXT,
  residence_card_back_path  TEXT,
  residence_address         TEXT,
  ration_card_no            TEXT,
  ration_center_name        TEXT,
  ration_center_no          TEXT,
  ration_card_date          TEXT,
  ration_card_attachment_paths TEXT DEFAULT '[]',
  passport_no               TEXT,
  passport_type             TEXT,
  passport_name             TEXT,
  passport_issue_date       TEXT,
  passport_expiry_date      TEXT,
  passport_attachment_paths TEXT DEFAULT '[]',
  airport_badge_no          TEXT,
  airport_badge_issue_date  TEXT,
  airport_badge_expiry      TEXT,
  airport_badge_zones       TEXT,
  airport_badge_front_path  TEXT,
  airport_badge_back_path   TEXT,
  ministry_badge_no         TEXT,
  ministry_badge_issue_date TEXT,
  ministry_badge_expiry     TEXT,
  ministry_badge_front_path TEXT,
  ministry_badge_back_path  TEXT,
  vehicle_plate             TEXT,
  vehicle_name              TEXT,
  vehicle_color_model       TEXT,
  vehicle_type              TEXT,
  vehicle_color             TEXT,
  vehicle_manufacture_year  TEXT,
  vehicle_annual_no         TEXT,
  vehicle_annual_issue_date TEXT,
  vehicle_annual_expiry_date TEXT,
  vehicles                  TEXT DEFAULT '[]',
  spouse_name               TEXT,
  spouse_mother_name        TEXT,
  spouse_birthdate          TEXT,
  marriage_date             TEXT,
  spouses                   TEXT DEFAULT '[]',
  family_members            TEXT DEFAULT '[]',
  attachment_paths          TEXT DEFAULT '[]',
  notes                     TEXT,
  is_active                 INTEGER NOT NULL DEFAULT 1,
  created_at                TEXT DEFAULT (datetime('now')),
  updated_at                TEXT DEFAULT (datetime('now'))
);

-- Job grade history
CREATE TABLE IF NOT EXISTS grade_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  grade       TEXT NOT NULL,
  job_title   TEXT,
  effective_date TEXT NOT NULL,
  notes       TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS employee_spouses (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id              INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  sort_order               INTEGER NOT NULL DEFAULT 0,
  civil_id                 TEXT,
  name                     TEXT,
  mother_name              TEXT,
  gender                   TEXT,
  birthplace               TEXT,
  birthdate                TEXT,
  issue_date               TEXT,
  expiry_date              TEXT,
  issuer                   TEXT,
  blood_type               TEXT,
  marriage_date            TEXT,
  national_card_front_path TEXT,
  national_card_back_path  TEXT,
  created_at               TEXT DEFAULT (datetime('now')),
  updated_at               TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS employee_family_members (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id              INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  sort_order               INTEGER NOT NULL DEFAULT 0,
  civil_id                 TEXT,
  name                     TEXT,
  gender                   TEXT,
  birthplace               TEXT,
  birthdate                TEXT,
  issue_date               TEXT,
  expiry_date              TEXT,
  issuer                   TEXT,
  blood_type               TEXT,
  national_card_front_path TEXT,
  national_card_back_path  TEXT,
  created_at               TEXT DEFAULT (datetime('now')),
  updated_at               TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS employee_vehicles (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  plate       TEXT,
  brand       TEXT,
  type        TEXT,
  color       TEXT,
  annual_no   TEXT,
  issue_date  TEXT,
  expiry_date TEXT,
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS employee_attachments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK(kind IN ('general','passport','ration_card')),
  file_path   TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now')),
  UNIQUE(employee_id, kind, file_path)
);

-- General document archive (not linked to any employee)
CREATE TABLE IF NOT EXISTS general_docs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  doc_type    TEXT,
  doc_number  TEXT,
  issue_date  TEXT,
  issuer      TEXT,
  doc_count   TEXT,
  margin      TEXT,
  is_internal_memo INTEGER NOT NULL DEFAULT 0 CHECK(is_internal_memo IN (0,1)),
  hr_effect_type TEXT NOT NULL DEFAULT 'none' CHECK(hr_effect_type IN ('none','appreciation','penalty')),
  hr_affects_promotion INTEGER NOT NULL DEFAULT 0 CHECK(hr_affects_promotion IN (0,1)),
  hr_affects_allowance INTEGER NOT NULL DEFAULT 0 CHECK(hr_affects_allowance IN (0,1)),
  hr_effect_months INTEGER NOT NULL DEFAULT 0,
  hr_effect_days INTEGER NOT NULL DEFAULT 0,
  notes       TEXT,
  file_path   TEXT,
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS general_doc_employees (
  general_doc_id INTEGER NOT NULL REFERENCES general_docs(id) ON DELETE CASCADE,
  employee_id    INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  PRIMARY KEY (general_doc_id, employee_id)
);

CREATE TABLE IF NOT EXISTS general_doc_attachments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  general_doc_id INTEGER NOT NULL REFERENCES general_docs(id) ON DELETE CASCADE,
  file_path      TEXT NOT NULL,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS outgoing_docs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  doc_type    TEXT,
  doc_number  TEXT,
  issue_date  TEXT,
  issuer      TEXT,
  doc_count   TEXT,
  margin      TEXT,
  is_internal_memo INTEGER NOT NULL DEFAULT 0 CHECK(is_internal_memo IN (0,1)),
  notes       TEXT,
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS outgoing_doc_employees (
  outgoing_doc_id INTEGER NOT NULL REFERENCES outgoing_docs(id) ON DELETE CASCADE,
  employee_id     INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  PRIMARY KEY (outgoing_doc_id, employee_id)
);

CREATE TABLE IF NOT EXISTS outgoing_doc_attachments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  outgoing_doc_id INTEGER NOT NULL REFERENCES outgoing_docs(id) ON DELETE CASCADE,
  file_path       TEXT NOT NULL,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT DEFAULT (datetime('now'))
);

-- Activity / audit log
CREATE TABLE IF NOT EXISTS activity_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER,
    username    TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'unknown',
    action      TEXT NOT NULL,
    target_type TEXT,
    target_id   INTEGER,
    target_name TEXT,
    result      TEXT NOT NULL DEFAULT 'Success' CHECK(result IN ('Success','Failure')),
    details     TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
);
CREATE TRIGGER IF NOT EXISTS activity_log_no_update BEFORE UPDATE ON activity_log
BEGIN SELECT RAISE(ABORT, 'audit log is immutable'); END;
CREATE TRIGGER IF NOT EXISTS activity_log_no_delete BEFORE DELETE ON activity_log
BEGIN SELECT RAISE(ABORT, 'audit log is immutable'); END;

-- Backup log
CREATE TABLE IF NOT EXISTS backup_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT NOT NULL,
  backup_path TEXT NOT NULL,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS document_metadata (
  stored_path   TEXT PRIMARY KEY,
  original_name TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL CHECK(size_bytes > 0),
  created_at    TEXT DEFAULT (datetime('now')),
  original_path TEXT,
  processed_path TEXT,
  parent_path TEXT
);

CREATE INDEX IF NOT EXISTS idx_employees_full_name ON employees(full_name);
CREATE INDEX IF NOT EXISTS idx_employees_department ON employees(department);
CREATE INDEX IF NOT EXISTS idx_grade_history_employee_date ON grade_history(employee_id, effective_date DESC);
CREATE INDEX IF NOT EXISTS idx_employee_spouses_employee ON employee_spouses(employee_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_employee_family_members_employee ON employee_family_members(employee_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_employee_vehicles_employee ON employee_vehicles(employee_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_employee_attachments_employee_kind ON employee_attachments(employee_id, kind, sort_order);
CREATE INDEX IF NOT EXISTS idx_general_docs_created_at ON general_docs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_general_doc_employees_employee ON general_doc_employees(employee_id);
CREATE INDEX IF NOT EXISTS idx_general_doc_attachments_doc ON general_doc_attachments(general_doc_id);
CREATE INDEX IF NOT EXISTS idx_outgoing_docs_created_at ON outgoing_docs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outgoing_doc_employees_employee ON outgoing_doc_employees(employee_id);
CREATE INDEX IF NOT EXISTS idx_outgoing_doc_attachments_doc ON outgoing_doc_attachments(outgoing_doc_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_created_at ON activity_log(created_at DESC);

-- Configurable HR promotion and annual allowance module.
-- Values below are operational examples only; administrators must review and edit them.
INSERT OR IGNORE INTO app_settings(key,value) VALUES('hr_alert_lead_months','6');

CREATE TABLE IF NOT EXISTS hr_employee_profiles (
  employee_id                  INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  certificate                  TEXT,
  current_salary_grade         TEXT,
  current_salary_step          INTEGER,
  current_base_salary          REAL,
  last_promotion_date          TEXT,
  last_allowance_date          TEXT,
  service_status               TEXT,
  linked_document_refs         TEXT DEFAULT '[]',
  system_promotion_due_date    TEXT,
  manual_promotion_due_date    TEXT,
  promotion_override_reason    TEXT,
  promotion_approval_note      TEXT,
  promotion_override_attachment TEXT,
  system_allowance_due_date    TEXT,
  manual_allowance_due_date    TEXT,
  allowance_override_reason    TEXT,
  allowance_approval_note      TEXT,
  allowance_override_attachment TEXT,
  notes                        TEXT,
  created_at                   TEXT DEFAULT (datetime('now')),
  updated_at                   TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS hr_salary_scales (
  id                         INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_name                  TEXT NOT NULL DEFAULT 'salary_scale',
  grade                      TEXT NOT NULL,
  step                       INTEGER NOT NULL,
  base_salary                REAL,
  annual_allowance_amount    REAL,
  steps_per_grade            INTEGER,
  required_promotion_months  INTEGER,
  allowance_period_months    INTEGER NOT NULL DEFAULT 12,
  promotion_target_grade     TEXT,
  promotion_target_step      INTEGER,
  allowance_next_step         INTEGER,
  effective_from             TEXT NOT NULL,
  effective_to               TEXT,
  rule_version               TEXT NOT NULL DEFAULT '1',
  active                     INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_by                 TEXT,
  updated_by                 TEXT,
  change_reason              TEXT,
  created_at                 TEXT DEFAULT (datetime('now')),
  updated_at                 TEXT DEFAULT (datetime('now')),
  UNIQUE(grade, step, rule_version)
);

CREATE TABLE IF NOT EXISTS hr_appreciation_rules (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  source_name              TEXT NOT NULL,
  appreciation_type        TEXT,
  credit_months            INTEGER NOT NULL DEFAULT 0,
  credit_days              INTEGER NOT NULL DEFAULT 0,
  affects_promotion        INTEGER NOT NULL DEFAULT 1 CHECK(affects_promotion IN (0,1)),
  affects_allowance        INTEGER NOT NULL DEFAULT 0 CHECK(affects_allowance IN (0,1)),
  max_accumulation_days    INTEGER,
  effective_from           TEXT NOT NULL,
  effective_to             TEXT,
  rule_version             TEXT NOT NULL DEFAULT '1',
  active                   INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_by               TEXT,
  updated_by               TEXT,
  change_reason            TEXT,
  created_at               TEXT DEFAULT (datetime('now')),
  updated_at               TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS hr_penalty_rules (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  penalty_type             TEXT NOT NULL,
  delay_months             INTEGER NOT NULL DEFAULT 0,
  delay_days               INTEGER NOT NULL DEFAULT 0,
  affects_promotion        INTEGER NOT NULL DEFAULT 1 CHECK(affects_promotion IN (0,1)),
  affects_allowance        INTEGER NOT NULL DEFAULT 1 CHECK(affects_allowance IN (0,1)),
  multiple_rule            TEXT NOT NULL DEFAULT 'accumulate',
  effective_from           TEXT NOT NULL,
  effective_to             TEXT,
  rule_version             TEXT NOT NULL DEFAULT '1',
  active                   INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_by               TEXT,
  updated_by               TEXT,
  change_reason            TEXT,
  created_at               TEXT DEFAULT (datetime('now')),
  updated_at               TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS hr_interruption_rules (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  interruption_type        TEXT NOT NULL,
  affects_promotion        INTEGER NOT NULL DEFAULT 1 CHECK(affects_promotion IN (0,1)),
  affects_allowance        INTEGER NOT NULL DEFAULT 1 CHECK(affects_allowance IN (0,1)),
  counted_or_excluded      TEXT NOT NULL DEFAULT 'excluded',
  effective_from           TEXT NOT NULL,
  effective_to             TEXT,
  rule_version             TEXT NOT NULL DEFAULT '1',
  active                   INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_by               TEXT,
  updated_by               TEXT,
  change_reason            TEXT,
  created_at               TEXT DEFAULT (datetime('now')),
  updated_at               TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS hr_appreciation_letters (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id              INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  letter_number            TEXT NOT NULL,
  letter_date              TEXT NOT NULL,
  issuing_authority        TEXT,
  appreciation_type        TEXT,
  credit_months            INTEGER NOT NULL DEFAULT 0,
  credit_days              INTEGER NOT NULL DEFAULT 0,
  affects_promotion        INTEGER NOT NULL DEFAULT 1 CHECK(affects_promotion IN (0,1)),
  affects_allowance        INTEGER NOT NULL DEFAULT 0 CHECK(affects_allowance IN (0,1)),
  used_in_calculation      INTEGER NOT NULL DEFAULT 1 CHECK(used_in_calculation IN (0,1)),
  attachment_path          TEXT,
  notes                    TEXT,
  created_at               TEXT DEFAULT (datetime('now')),
  updated_at               TEXT DEFAULT (datetime('now')),
  UNIQUE(employee_id, letter_number, letter_date)
);

CREATE TABLE IF NOT EXISTS hr_penalties (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id              INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  penalty_order_number     TEXT NOT NULL,
  penalty_date             TEXT NOT NULL,
  penalty_type             TEXT NOT NULL,
  delay_months             INTEGER NOT NULL DEFAULT 0,
  delay_days               INTEGER NOT NULL DEFAULT 0,
  affects_promotion        INTEGER NOT NULL DEFAULT 1 CHECK(affects_promotion IN (0,1)),
  affects_allowance        INTEGER NOT NULL DEFAULT 1 CHECK(affects_allowance IN (0,1)),
  cancelled                INTEGER NOT NULL DEFAULT 0 CHECK(cancelled IN (0,1)),
  cancellation_order       TEXT,
  cancellation_date        TEXT,
  attachment_path          TEXT,
  notes                    TEXT,
  created_at               TEXT DEFAULT (datetime('now')),
  updated_at               TEXT DEFAULT (datetime('now')),
  UNIQUE(employee_id, penalty_order_number, penalty_date)
);

CREATE TABLE IF NOT EXISTS hr_service_interruptions (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id              INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  interruption_type        TEXT NOT NULL,
  start_date               TEXT NOT NULL,
  end_date                 TEXT NOT NULL,
  affects_promotion        INTEGER NOT NULL DEFAULT 1 CHECK(affects_promotion IN (0,1)),
  affects_allowance        INTEGER NOT NULL DEFAULT 1 CHECK(affects_allowance IN (0,1)),
  counted_or_excluded      TEXT NOT NULL DEFAULT 'excluded',
  attachment_path          TEXT,
  notes                    TEXT,
  created_at               TEXT DEFAULT (datetime('now')),
  updated_at               TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_hr_profiles_grade_step ON hr_employee_profiles(current_salary_grade, current_salary_step);
CREATE INDEX IF NOT EXISTS idx_hr_salary_active ON hr_salary_scales(active, grade, step, effective_from);
CREATE INDEX IF NOT EXISTS idx_hr_appreciations_employee ON hr_appreciation_letters(employee_id, letter_date);
CREATE INDEX IF NOT EXISTS idx_hr_penalties_employee ON hr_penalties(employee_id, penalty_date);
CREATE INDEX IF NOT EXISTS idx_hr_interruptions_employee ON hr_service_interruptions(employee_id, start_date);
