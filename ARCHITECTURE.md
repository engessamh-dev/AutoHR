# AutoHR — Architecture Reference v1.0.0

## Directory Structure

```
AutoHR/
├── index.html                      # RTL shell: login + sidebar + workspace
├── package.json / vite.config.js / tailwind.config.js
├── database/
│   └── schema.sql                  # SQLite DDL (users, company_config, employees, documents…)
├── scripts/
│   └── seed-database.js            # Generates src-tauri/resources/database.db
├── src/
│   ├── main.js                     # Auth, navigation, RBAC nav visibility, logout backup
│   ├── api.js                      # Tauri invoke bridge
│   ├── utils.js                    # Branding, toast, convertFileSrc for logo
│   ├── styles/main.css             # Tailwind + dark theme (#181818…)
│   └── screens/
│       ├── dashboard.js            # Metrics, alerts, employee breakdown
│       ├── employees.js            # CRUD + slide panel + attachments
│       ├── documents.js            # General and employee document archive
│       ├── users.js                # sysadmin-only user management
│       ├── company.js              # sysadmin-only identity + logo upload
│       └── about.js                # Version, storage path picker
└── src-tauri/
    ├── Cargo.toml / tauri.conf.json
    ├── resources/database.db       # Bundled seed DB (generated)
    └── src/
        ├── lib.rs                  # Tauri commands
        ├── db.rs                   # Open DB, versioned upgrades (PRAGMA user_version)
        ├── paths.rs                # config.json: data + backup folder locations
        ├── storage.rs              # First-run setup, safe data move, backup folder, export
        ├── services.rs             # Auth, RBAC, CRUD, documents
        ├── files.rs                # Backup, logo validation, attachments
        └── bin/seed_db.rs          # Rust alternative seeder
```

---

## Database Schema (Updated)

| Table | Purpose |
|-------|---------|
| `users` | Operators (max 10). Roles: `system_admin`, `archive_admin`, `archive_officer`, `viewer`. Seeded: `sysadmin`, forced password change |
| `company_config` | Single row: `company_name`, `department_name`, `division_name`, `logo_path` |
| `app_settings` | `storage_destination` → Documents/AutoHR default |
| `employees` | Full HR records + relative attachment paths |
| `backup_log` | Audit trail on logout |

---

## RBAC Flow

```
Login → User { is_master: username == "sysadmin" || role == "master" }
         │
         ├─ sysadmin → nav "إعدادات الهوية والأقسام" visible
         │              └─ cmd_update_company_config / cmd_upload_company_logo
         │                 assert_master() in Rust
         │
         └─ operator → nav item hidden
                        direct navigate → "غير مصرح" UI screen
```

---

## Logo Upload (Restricted)

```
Frontend open() filters: ["png","jpg","jpeg"]
         │
         ▼
cmd_upload_company_logo(user, source_path)
         ├─ assert_master(user)
         ├─ validate_logo_extension() — rejects non jpg/jpeg/png
         ├─ copy → {storage}/Branding/company_logo.{ext}
         ├─ UPDATE company_config.logo_path
         └─ return CompanyConfig with logo_full_path
                └─ applyBranding() → sidebar logo via convertFileSrc
```

---

## Logout Backup Flow

```
"تسجيل الخروج" → cmd_logout(username)
    → {storage_destination}/Backups/AutoHR_Backup_2026-06-03_1630.db
    → INSERT backup_log
    → redirect to login
```

## Full Backup Format

Manual backups use encrypted `.autohrbak` v2 containers. Each backup contains a consistent SQLite
snapshot, the managed attachment/document data tree, and a SHA-256 manifest. Restore extracts into
staging, validates all database relationships and referenced files, creates a full pre-restore backup,
then swaps the data directory and database before requiring re-authentication.

All backup categories write to a temporary file on the destination volume and sync it to disk.
Before publishing the final filename, the application reads that file back, authenticates/decrypts it,
decompresses every entry, checks manifest sizes and SHA-256 hashes, validates SQLite integrity and
foreign keys, and checks referenced attachments. Verification also restores SQLite into an isolated
temporary database and validates the restored database. Failed verification removes the temporary
backup and does not report success. Existing final backup files are never overwritten.
The same isolated restore trial runs when opening a backup for restoration, before changing live data.

## Storage Locations and Upgrades

Folder locations live in `config.json` in the application's own AppData folder
(`%APPDATA%\CNSArch`, or `CNSArch-Development` for dev builds), outside the database, so
upgrading or reinstalling keeps them. `data_root` holds `database.db` and the `Data` tree
(attachments, branding); `backup_root` holds `Daily/Weekly/Monthly/Manual/PreMove/PreUpgrade`.

- First run with no config and no legacy database: the setup screen asks for both folders.
  The backup folder may not be inside the data folder (or the reverse) nor inside the program folder.
- Existing installs whose database is in `%APPDATA%\CNSArch` are recorded as is and keep working.
- If the configured data folder is unreachable the app shows a recovery screen and never
  creates a new empty database. An unreachable backup folder only shows a warning.
- Moving the data folder (Settings → مواقع الحفظ): encrypted `PreMove` backup, copy database and
  files, verify sizes, SHA-256, integrity and row counts, then switch config. The old folder is kept.
- «تصدير نسخة إلى…» writes a fresh verified backup to any chosen folder.

Schema upgrades are versioned with `PRAGMA user_version` (`db::SCHEMA_VERSION`). Before upgrading an
existing database, a verified SQLite snapshot is written to `PreUpgrade`; if the upgrade fails the
database is restored from it automatically. A database from a newer version is refused untouched.
Restoring an older backup upgrades it; restoring a newer one is refused.

Schema versions: 0 = v1.0.0–v1.0.3 (no version), 1 = Phase B schema, 2 = person names split
into national-card fields (الاسم، الأب، الجد، اللقب) (`names.rs`). Names (employee, mother, residence-card head of household,
passport, spouses and their mothers, family members) keep their combined column, which stays the
source for display, search and reports; the parts live in a `name_parts` JSON column and every
save rebuilds the combined text from them. Step 2 is additive: it archives every original text in
`name_split_originals`, splits best effort, and flags unsure splits (`review: true`) for the
«مراجعة الأسماء» dialog on the employees screen. See [docs/NAME_SPLIT.md](docs/NAME_SPLIT.md).

---

## Build

```powershell
npm install
npm install better-sqlite3 --save-dev   # for seed-db
npm run seed-db
# Add icons: npx tauri icon app-icon.png
npm run tauri:build
```

Output: `src-tauri/target/release/bundle/nsis/` — standalone Windows installer.

**Developer:** Eng. Essam Al-Emaraa
