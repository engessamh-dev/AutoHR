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
        ├── db.rs                   # %APPDATA%/AutoHR extraction
        ├── services.rs             # Auth, RBAC, CRUD, documents
        ├── files.rs                # Backup, logo validation, attachments
        └── bin/seed_db.rs          # Rust alternative seeder
```

---

## Database Schema (Updated)

| Table | Purpose |
|-------|---------|
| `users` | Operators (max 10). `role`: `master` \| `operator`. Seeded: `sysadmin` |
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
