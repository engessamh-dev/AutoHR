#!/usr/bin/env node
/**
 * AutoHR — Seed Database
 * Generates src-tauri/resources/database.db from database/schema.sql
 * Run: npm run seed-db
 */

import Database from "better-sqlite3";
import { readFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { hashSync } from "bcryptjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const dbDir = join(root, "src-tauri", "resources");
const dbPath = join(dbDir, "database.db");
const schemaPath = join(root, "database", "schema.sql");

if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

function hashPassword(plain) {
  return hashSync(plain, 12);
}

console.log("📦 AutoHR Seed Database");
console.log(`→ Output: ${dbPath}`);

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Apply schema
const schema = readFileSync(schemaPath, "utf8");
db.exec(schema);
const userColumns = new Set(
  db.prepare("PRAGMA table_info(users)").all().map(column => column.name)
);
if (!userColumns.has("must_change_password")) {
  db.exec("ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0 CHECK(must_change_password IN (0,1))");
}
const legacyRoleCount = db.prepare("SELECT COUNT(*) count FROM users WHERE role IN ('master','operator','hr_admin','hr_officer')").get().count;
const usersSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get().sql;
if (legacyRoleCount || usersSql.includes("hr_admin") || usersSql.includes("'master'")) {
  db.exec(`
    PRAGMA foreign_keys=OFF;
    ALTER TABLE users RENAME TO users_legacy_roles;
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('system_admin','archive_admin','archive_officer','viewer')),
      must_change_password INTEGER NOT NULL DEFAULT 0 CHECK(must_change_password IN (0,1)),
      created_at TEXT DEFAULT (datetime('now'))
    );
    INSERT INTO users(id,username,password,role,must_change_password,created_at)
      SELECT id,username,password,CASE
        WHEN username='sysadmin' OR role='master' OR role='system_admin' THEN 'system_admin'
        WHEN role='hr_admin' OR role='archive_admin' THEN 'archive_admin'
        ELSE 'archive_officer' END,
        must_change_password,created_at FROM users_legacy_roles;
    DROP TABLE users_legacy_roles;
    PRAGMA foreign_keys=ON;
  `);
}
const auditColumns = new Set(
  db.prepare("PRAGMA table_info(activity_log)").all().map(column => column.name)
);
for (const [column, definition] of [
  ["user_id", "INTEGER"],
  ["role", "TEXT NOT NULL DEFAULT 'unknown'"],
  ["result", "TEXT NOT NULL DEFAULT 'Success'"],
]) {
  if (!auditColumns.has(column)) db.exec(`ALTER TABLE activity_log ADD COLUMN ${column} ${definition}`);
}
const metadataColumns = new Set(db.prepare("PRAGMA table_info(document_metadata)").all().map(column => column.name));
for (const column of ["original_path", "processed_path", "parent_path"]) {
  if (!metadataColumns.has(column)) db.exec(`ALTER TABLE document_metadata ADD COLUMN ${column} TEXT`);
}
console.log("✅ Schema applied");

const obsoleteEmployeeColumns = [
  "nationality_cert_no",
  "nationality_cert_date",
  "nationality_wallet_no",
  "civil_id_register",
  "civil_id_page",
];
const existingEmployeeColumns = new Set(
  db.prepare("PRAGMA table_info(employees)").all().map(column => column.name)
);
for (const [column, definition] of [
  ["father_birthdate", "TEXT"],
  ["mother_birthdate", "TEXT"],
  ["work_type_notes", "TEXT"],
  ["work_schedule", "TEXT"],
  ["civil_id_birthplace", "TEXT"],
  ["civil_id_birthdate", "TEXT"],
  ["civil_id_family_number", "TEXT"],
  ["civil_id_front_path", "TEXT"],
  ["civil_id_back_path", "TEXT"],
  ["passport_type", "TEXT"],
  ["passport_attachment_paths", "TEXT DEFAULT '[]'"],
  ["residence_card_issue_date", "TEXT"],
  ["residence_head_name", "TEXT"],
  ["residence_form_no", "TEXT"],
  ["residence_card_front_path", "TEXT"],
  ["residence_card_back_path", "TEXT"],
  ["ration_card_attachment_paths", "TEXT DEFAULT '[]'"],
  ["airport_badge_issue_date", "TEXT"],
  ["airport_badge_zones", "TEXT"],
  ["residence_address_parts", "TEXT"],
  ["airport_badge_front_path", "TEXT"],
  ["airport_badge_back_path", "TEXT"],
  ["ministry_badge_issue_date", "TEXT"],
  ["ministry_badge_front_path", "TEXT"],
  ["ministry_badge_back_path", "TEXT"],
]) {
  if (!existingEmployeeColumns.has(column)) {
    db.exec(`ALTER TABLE employees ADD COLUMN ${column} ${definition}`);
    existingEmployeeColumns.add(column);
  }
}
for (const column of obsoleteEmployeeColumns) {
  if (existingEmployeeColumns.has(column)) {
    db.exec(`ALTER TABLE employees DROP COLUMN ${column}`);
  }
}
db.exec(`
  UPDATE employees SET
    civil_id_birthplace=COALESCE(NULLIF(civil_id_birthplace,''),birthplace),
    civil_id_birthdate=COALESCE(NULLIF(civil_id_birthdate,''),birthdate)
`);

// Seed default sysadmin user
const existingAdmin = db.prepare("SELECT id FROM users WHERE username = 'sysadmin'").get();
if (!existingAdmin) {
  db.prepare(
    "INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, 'system_admin', 1)"
  ).run("sysadmin", hashPassword("password"));
  console.log("✅ sysadmin user created (password: password)");
} else {
  db.prepare("UPDATE users SET password=?, must_change_password=1 WHERE username='sysadmin'")
    .run(hashPassword("password"));
  console.log("ℹ️  sysadmin already exists — skipped");
}

db.exec(`
  DELETE FROM grade_history;
  DELETE FROM employees;
  DELETE FROM sqlite_sequence WHERE name IN ('employees','grade_history');
`);
console.log("✅ Employee records cleared");

console.log("No employee records are bundled in release databases");

// Default company config
db.prepare(`
  UPDATE company_config SET company_name='AutoHR', department_name='', division_name='' WHERE id=1
`).run();

db.close();
console.log("🎉 database.db ready at src-tauri/resources/database.db");
