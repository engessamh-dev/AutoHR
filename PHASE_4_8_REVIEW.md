# AutoHR Phase 4-8 Review

Date: 2026-06-13

## Executive Summary

AutoHR is an appropriately small, offline-first Tauri desktop application. Its current stack is
vanilla JavaScript, Vite, Tailwind CSS, Rust, and SQLite; it is not currently a React/TypeScript
application. The core security design is sound for a local small-organization tool: backend-enforced
RBAC, Rust-side session identity, encrypted backups, restricted Tauri capabilities, upload signature
checks, and path traversal defenses are present.

The review found one critical accidental-data-loss path in startup storage migration. It could delete
all employee general attachments on first execution of that migration. This was removed. The review
also hardened file-write ordering, restore validation, database indexing, IPC identity handling,
employee/document validation, and keyboard/screen-reader behavior.

Production release should remain blocked until the database-only backup limitation and the unimplemented
report/export commands are explicitly accepted or resolved.

## Scores

| Area | Score |
|---|---:|
| Overall Architecture | 7.2 / 10 |
| Code Quality | 6.8 / 10 |
| UI/UX | 6.7 / 10 |
| Data Integrity | 7.0 / 10 |
| Performance | 7.4 / 10 |
| Security | 7.3 / 10 |
| Maintainability | 6.6 / 10 |
| Production Readiness | 6.4 / 10 |

## Implemented Improvements

- Removed a destructive startup migration that deleted employee attachment directories and cleared
  attachment references.
- Added 10 SQLite indexes for employee, document relationship, attachment, history, and audit queries.
- Added SQLite busy timeout handling and schema-level positive document-size validation.
- Made document creation/update and employee-link replacement transactional.
- Validated employee status, family JSON, vehicle JSON, document title length, linked employee count,
  audit query limits, document type length, and backup size.
- Hardened restore with required-table checks, foreign-key checks, integrity checks, role checks, and
  an automatic encrypted safety backup before replacement.
- Reordered attachment deletion/replacement so database writes succeed before old files are removed.
- Removed stale employee directories after successful employee deletion and old photo/logo files after
  successful replacement.
- Removed frontend-supplied usernames from privileged IPC calls; identity is derived only from Rust
  session state.
- Added dashboard summary cards, keyboard-accessible navigation buttons, focus-visible styling,
  live-region status/error feedback, and dialog semantics.

## Findings

### Critical

**Resolved: destructive employee attachment cleanup**

- Description: startup storage initialization recursively removed every employee `Attachments` folder
  and reset `attachment_paths`.
- Impact: irreversible accidental loss of employee documents.
- Recommendation: never perform destructive cleanup during routine startup.
- Implementation: removed the cleanup block from `ensure_storage_layout`.

### High

**Remaining: backups contain SQLite data but not managed attachment files**

- Description: encrypted backups protect the database only.
- Impact: a restore can produce valid database references to files that are absent or from a different
  point in time.
- Recommendation: introduce a backward-compatible versioned backup container containing the database,
  managed files, and a manifest with hashes.
- Suggested implementation: retain support for current `.autohrbak` files and add a v2 archive format
  with authenticated manifest validation and staged atomic restore.

**Remaining: report/export commands are exposed but return empty results**

- Description: PDF export, Excel export, and employee-card print commands are stubs.
- Impact: visible workflows appear successful without producing output.
- Recommendation: hide the actions until implemented or implement local exports with explicit file
  creation and error handling.

**Remaining: development toolchain advisory**

- Description: `npm audit` reports a high-severity Vite/esbuild advisory. The automatic fix requires a
  major Vite 8 upgrade.
- Impact: primarily affects a compromised package registry/build environment, not the packaged offline
  runtime.
- Recommendation: test and schedule the Vite 8 upgrade before the next release.

### Medium

**Ad-hoc schema migrations**

- Description: migrations infer state from columns/table SQL and run during database open.
- Impact: future migrations are harder to reason about, test, and roll back.
- Recommendation: adopt sequential `PRAGMA user_version` migrations, each inside a transaction.

**Database restore and active session**

- Description: after restore, the current session remains in memory even if its user or role changed.
- Impact: the next authorization check fails safely, but the UX is confusing.
- Recommendation: clear the session after restore and require re-authentication.

**No login throttling**

- Description: failed local login attempts are audited but not delayed or throttled.
- Impact: an attacker with interactive machine access can attempt passwords rapidly.
- Recommendation: add a short in-memory exponential delay after repeated failures without introducing
  permanent lockout risk.

**Document list N+1 queries**

- Description: each listed incoming/outgoing document performs additional employee and attachment
  queries.
- Impact: list latency grows with document count.
- Recommendation: aggregate relationships in bounded bulk queries if real datasets show a problem.

### Low

- `services.rs`, `employees.js`, and `documents.js` are large and mix several responsibilities.
- Native `prompt()` dialogs provide weak validation and inconsistent UX.
- Vite reports static/dynamic import chunking warnings.
- The Tauri bundle identifier ends in `.app`, which is discouraged for macOS packaging.
- Automated tests cover backend security/authentication but not business CRUD, migrations, restore
  integration, or UI workflows.
- Dark mode is the only visual mode; there is no explicit high-contrast mode.

## Modified Files

- `database/schema.sql`
- `PHASE_4_8_REVIEW.md`
- `index.html`
- `src-tauri/src/db.rs`
- `src-tauri/src/files.rs`
- `src-tauri/src/lib.rs`
- `src-tauri/src/services.rs`
- `src/api.js`
- `src/main.js`
- `src/screens/company.js`
- `src/screens/dashboard.js`
- `src/screens/users.js`
- `src/styles/main.css`
- `src/utils.js`

The repository already contained extensive uncommitted changes before this review; those existing edits
were preserved.

## Verification

- `cargo test --workspace`: passed, 13 tests.
- `cargo clippy --workspace --all-targets -- -D warnings`: passed.
- `npm run build`: passed.
- `npm run tauri:build`: passed; MSI and NSIS installers were produced.
- In-memory SQLite schema: `integrity_check=ok`, zero foreign-key errors, 10 custom indexes.
- `npm audit --omit=dev`: no production dependency vulnerabilities.
- `npm audit`: two high development-toolchain findings through Vite/esbuild.
- `cargo fmt --all -- --check`: reports broad pre-existing formatting drift.

## Future Recommendations

1. Implement a versioned full backup container for both SQLite and managed files.
2. Replace ad-hoc migrations with transactional `user_version` migrations and migration tests.
3. Implement or hide incomplete export/report actions.
4. Split backend models/auth/employees/documents/backups into focused modules.
5. Add CRUD, migration, restore, and permission-boundary integration tests.
6. Replace native prompts with the existing modal pattern and accessible form validation.
7. Test a Vite 8 upgrade and remove mixed static/dynamic Tauri imports.
