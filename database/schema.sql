-- GCANS Document Archive System — Schema v2.0

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL UNIQUE,
  password   TEXT NOT NULL,
  role       TEXT NOT NULL DEFAULT 'operator' CHECK(role IN ('master','operator')),
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
  mother_birthplace         TEXT,
  gender                    TEXT,
  birthdate                 TEXT,
  birthplace                TEXT,
  marital_status            TEXT,
  blood_type                TEXT,
  workplace                 TEXT,
  job_title                 TEXT,
  job_grade                 TEXT,
  hire_date                 TEXT,
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

-- General document archive (not linked to any employee)
CREATE TABLE IF NOT EXISTS general_docs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT NOT NULL,
  doc_type    TEXT,
  doc_number  TEXT,
  issue_date  TEXT,
  issuer      TEXT,
  notes       TEXT,
  file_path   TEXT,
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);

-- Activity / audit log
CREATE TABLE IF NOT EXISTS activity_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT NOT NULL,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   INTEGER,
  target_name TEXT,
  details     TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

-- Backup log
CREATE TABLE IF NOT EXISTS backup_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT NOT NULL,
  backup_path TEXT NOT NULL,
  created_at  TEXT DEFAULT (datetime('now'))
);
