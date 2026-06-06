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
import { createHash } from "crypto";
import { sampleEmployees } from "./sample-employees.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const dbDir = join(root, "src-tauri", "resources");
const dbPath = join(dbDir, "database.db");
const schemaPath = join(root, "database", "schema.sql");

if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

// Simple SHA-256 password hash (Rust side uses same approach for demo)
// In production use argon2 or bcrypt via Rust
function hashPassword(plain) {
  return createHash("sha256").update(plain).digest("hex");
}

console.log("📦 AutoHR Seed Database");
console.log(`→ Output: ${dbPath}`);

const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Apply schema
const schema = readFileSync(schemaPath, "utf8");
db.exec(schema);
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
    "INSERT INTO users (username, password, role) VALUES (?, ?, 'master')"
  ).run("sysadmin", hashPassword("password"));
  console.log("✅ sysadmin user created (password: password)");
} else {
  console.log("ℹ️  sysadmin already exists — skipped");
}

db.exec(`
  DELETE FROM grade_history;
  DELETE FROM employees;
  DELETE FROM sqlite_sequence WHERE name IN ('employees','grade_history');
`);
console.log("✅ Employee records cleared");

const availableEmployeeColumns = new Set(
  db.prepare("PRAGMA table_info(employees)").all().map(column => column.name)
);
const sampleEmployeeColumns = Object.keys(sampleEmployees[0]).filter(column =>
  availableEmployeeColumns.has(column)
);
const insertEmployee = db.prepare(`
  INSERT INTO employees (${sampleEmployeeColumns.join(", ")})
  VALUES (${sampleEmployeeColumns.map(column => `@${column}`).join(", ")})
`);
const insertSampleEmployees = db.transaction(employees => {
  for (const employee of employees) {
    insertEmployee.run(employee);
  }
});
insertSampleEmployees(sampleEmployees);
console.log(`Seeded ${sampleEmployees.length} fictional employee records`);

// Default company config
db.prepare(`
  UPDATE company_config SET company_name='AutoHR', department_name='', division_name='' WHERE id=1
`).run();

db.close();
console.log("🎉 database.db ready at src-tauri/resources/database.db");
