# AutoHR

Lightweight Arabic-RTL desktop HR & document-archiving app for small companies (50–75 employees). Tauri (Rust) shell wrapping a vanilla-JS + Tailwind frontend, backed by SQLite.

## Stack & layout

- **Frontend**: Vanilla JS (ES modules) + Vite + Tailwind, in [src/](src/)
  - [src/main.js](src/main.js) — auth, navigation/routing, RBAC nav visibility, i18n (Arabic strings), logout
  - [src/api.js](src/api.js) — the *only* bridge to the backend; every Rust command is wrapped here via `invoke("cmd_...")`
  - [src/utils.js](src/utils.js) — branding, toasts, confirm dialogs, `convertFileSrc`
  - [src/screens/](src/screens/) — one render function per screen (`dashboard`, `employees`, `documents`, `users`, `company`, `about`)
- **Backend**: Tauri v2 / Rust, in [src-tauri/src/](src-tauri/src/)
  - [lib.rs](src-tauri/src/lib.rs) — `#[tauri::command] fn cmd_*` definitions (one per frontend `api.js` call)
  - [services.rs](src-tauri/src/services.rs) — auth, RBAC, CRUD, document logic
  - [db.rs](src-tauri/src/db.rs) — DB extraction to `%APPDATA%/AutoHR`
  - [files.rs](src-tauri/src/files.rs) — upload validation, attachment path safety
  - [storage.rs](src-tauri/src/storage.rs) — data/backup folders, setup, moving data
  - [secure.rs](src-tauri/src/secure.rs) — DPAPI for stored secrets, NTFS ACLs on the data/backup folders
- **Database**: SQLite, schema in [database/schema.sql](database/schema.sql); seeded via [scripts/seed-database.js](scripts/seed-database.js) into `src-tauri/resources/database.db`

## Running

```powershell
npm install
npm install better-sqlite3 --save-dev
npm run seed-db
npm run tauri:dev
```

Initial login: `sysadmin` / temporary password `password`. The account is blocked from normal system access until the password is changed. See [README.md](README.md) and [ARCHITECTURE.md](ARCHITECTURE.md) for fuller detail.

## Conventions to follow

- **Frontend never trusts itself for auth.** Sensitive Tauri commands derive the acting user from `SessionState` (Rust-side), not from a username string passed by the frontend — see `session_user()` in [lib.rs](src-tauri/src/lib.rs). Don't add commands that re-introduce a frontend-supplied identity for privileged actions.
- **Attachment/file paths must go through `safe_relative_path`** ([files.rs](src-tauri/src/files.rs)) — rejects absolute paths and `..` traversal. Any new file-handling command must validate paths the same way.
- **RBAC**: permissions per role live in `role_permissions()` ([services.rs](src-tauri/src/services.rs)) and are checked in Rust with `authorize()` / `assert_permission()`; the frontend mirrors them with `can()` ([permissions.js](src/permissions.js)). Guard on both sides for any new privileged feature. Restoring a backup (`backups.restore`) is System Admin only because it replaces the users table.
- **Secrets in the database** (such as the automatic-backup password) go through `secure::protect_secret`, never plain `set_setting`.
- **Every new backend command** needs: a `#[tauri::command] fn cmd_*` in [lib.rs](src-tauri/src/lib.rs), registration in the Tauri builder, and a matching wrapper entry in [api.js](src/api.js) (this file is the single source of truth for what the frontend can call).
- **UI strings are Arabic, RTL.** Add new copy to the `i18n` map in [main.js](src/main.js) rather than hardcoding strings in screens where reasonable, matching the existing pattern.
- Issues/known defects are tracked locally in [ISSUES.md](ISSUES.md) (Arabic) using `AHR-XXX` IDs — check it before assuming something is unimplemented or broken, and reference the ID in commits that close one.

## Known open issues (see ISSUES.md for full detail)

- **AHR-002**: `cmd_export_employees_pdf` / `cmd_export_employees_excel` / `cmd_print_employee_card` in [lib.rs](src-tauri/src/lib.rs) are stubs returning empty results — not yet implemented.
- **AHR-004**: Vite warns about static+dynamic imports of Tauri modules preventing chunk splitting (build still succeeds).

## Testing / verification

- `cargo test -p autohr --lib` (Rust, about 70 tests); `npm run test:scanner` adds the Playwright scanner tests
- `cargo audit` and `npm audit` before a release
- `npm run build` — Vite build; should succeed (may show AHR-004 chunking warnings)
