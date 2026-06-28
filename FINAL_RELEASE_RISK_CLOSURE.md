# AutoHR Final Release Risk Closure

Date: 2026-06-13

## Risks Closed

1. Backups now contain the SQLite database, all managed employee attachments, uploaded incoming and
   outgoing documents, branding files, and a SHA-256 manifest.
2. Restore validates encryption, archive paths, the manifest, every file hash and size, required
   database tables, SQLite integrity, foreign keys, roles, and every database-referenced managed file.
3. Restore creates a full pre-restore safety backup, stages and validates the replacement before use,
   swaps the managed data directory with rollback support, restores SQLite, and requires re-login.
4. Unimplemented PDF/Excel export and employee-card IPC commands were removed. No broken export action
   remains visible or callable. Implemented employee-document printing remains available.
5. Vite was upgraded to `8.0.16` and patched `esbuild` was added at `0.28.1`. `npm audit` reports zero
   vulnerabilities.

## Backup And Restore Design

- Format: encrypted `.autohrbak` v2 container using Argon2-derived AES-256-GCM encryption.
- Contents: `database.db`, the managed `Data` tree excluding temporary/generated `Temp` and `Exports`
  directories, and `manifest.json`.
- Manifest: format version, creation timestamp, archive-relative path, byte size, and SHA-256 hash for
  every included file.
- Validation: rejects unsafe paths, duplicate/unlisted files, missing files, hash/size mismatches,
  unsupported schemas or roles, inconsistent foreign keys, corrupt SQLite, and missing referenced
  attachments.
- Restore: decrypt to memory, extract to staging, validate fully, create a full pre-restore backup,
  persist a restore marker and local rollback snapshot, rename current data to rollback storage,
  activate staged data, restore SQLite, remove rollback data, preserve audit history, and clear the
  active session. Startup automatically restores the rollback snapshot if the process was interrupted.
- Legacy v1 database-only backups are detected and rejected for restore because they cannot safely
  reproduce attachment state.

## Export And Report Status

- Employee-document printing: implemented and retained.
- Employee PDF export: disabled and removed from IPC until implemented.
- Employee Excel export: disabled and removed from IPC until implemented.
- Employee-card printing: disabled and removed from IPC until implemented.
- The About screen clearly states that PDF and Excel reports are unavailable in this release.

## Dependency Advisory Status

- Previous advisory: Vite 6 transitive `esbuild` binary-integrity advisory affecting the Node build
  toolchain.
- Resolution: upgraded to `vite@8.0.16` and `esbuild@0.28.1`.
- Runtime exposure: Vite and esbuild are development dependencies and are not embedded as executable
  services in the installed offline desktop application.
- Current status: `npm audit` reports zero vulnerabilities.

## Manual Backup And Restore Checklist

1. Sign in as System Admin or Archive Admin.
2. Create an employee and upload a general attachment, passport copy, national-card image, and photo.
3. Create incoming and outgoing document records and upload at least one file to each.
4. Create a manual backup with a unique strong password.
5. Confirm the `.autohrbak` file exists below the managed `Backups/Manual/<year>` directory.
6. Change the employee name, delete one uploaded attachment, and add a new document after the backup.
7. Restore the backup and provide its password.
8. Confirm AutoHR reloads and requires login.
9. Confirm the original employee values and every backed-up attachment/document open correctly.
10. Confirm changes made after the backup are absent.
11. Confirm a full pre-restore backup exists below `Backups/PreRestore/<year>`.
12. Attempt restore with a wrong password and confirm current data remains unchanged.
13. Copy and corrupt a backup file, then confirm restore rejects it and current data remains unchanged.
14. Attempt to restore a legacy v1 database-only backup and confirm AutoHR rejects it with a clear
    completeness warning.

## Remaining Risks

- Backup creation and decryption currently buffer the encrypted archive in memory and enforce a 1 GB
  maximum. This is acceptable for the intended small/medium organization scope but should be revisited
  if managed files approach that limit.
- Vite still reports harmless mixed static/dynamic import optimization warnings.
- The Tauri bundle identifier ending in `.app` remains discouraged for future macOS packaging.

## Final Release Recommendation

**Ready** for the intended internal Windows production release, after completing the manual backup and
restore checklist on the release candidate installer.
