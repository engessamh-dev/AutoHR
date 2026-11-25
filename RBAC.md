# AutoHR RBAC

Three roles since schema v8. Permissions live in `role_permissions()` ([services.rs](src-tauri/src/services.rs)) and are checked in Rust on every command; the users screen shows the same table to the admin ([permissions.js](src/permissions.js) `permissionMatrix`).

| Permission | مسؤول (`system_admin`) | موظف (`archive_officer`) | مشاهد (`viewer`) |
|---|---:|---:|---:|
| View dashboard, employees, and documents | Yes | Yes | Yes |
| Print and download documents (logged in the audit log) | Yes | Yes | Yes |
| Create and edit employees | Yes | Yes | No |
| Upload and scan attachments | Yes | Yes | No |
| Manage general/outgoing document records | Yes | No | No |
| Delete employees, documents and attachments | Yes | No | No |
| View the Audit Log | Yes | No | No |
| Manage users, settings and backups | Yes | No | No |
| Restore a backup (replaces all data, including users) | Yes | No | No |
| Export reports/data | Not available | Not available | Not available |

Account rules (enforced in Rust):

- `sysadmin` cannot be deleted, stopped, or given another role.
- Nobody can change their own role, delete their own account, or stop it.
- A stopped account (`users.disabled`) cannot sign in or run any command until an admin enables it again.
- An account changed outside the program (integrity check) has no permissions until it is recreated or the data is approved.
- At most 10 users; usernames are unique ignoring letter case.

History: v8 merged `archive_admin` («مسؤول الأرشيف») into `system_admin`, removed the Audit Log from `archive_officer`, and gave `viewer` downloads. Earlier, legacy `master` users migrated to `system_admin`, `operator` to `archive_officer`, and `hr_admin` / `hr_officer` to their Archive equivalents.
