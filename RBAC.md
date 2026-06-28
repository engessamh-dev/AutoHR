# AutoHR RBAC

| Permission | System Admin | Archive Admin | Archive Officer | Viewer |
|---|---:|---:|---:|---:|
| View dashboard, employees, and documents | Yes | Yes | Yes | Yes |
| Create and edit employees | Yes | Yes | Yes | No |
| Delete employees | Yes | Yes | No | No |
| Manage general/outgoing document records | Yes | Yes | No | No |
| Upload employee documents | Yes | Yes | Yes | No |
| Download documents | Yes | Yes | Yes | No |
| Delete documents | Yes | Yes | No | No |
| Print employee documents | Yes | Yes | Yes | Yes |
| Export reports/data | Not available | Not available | Not available | No |
| Manage users and reset passwords | Yes | Yes | No | No |
| Assign System Admin | Yes | No | No | No |
| View immutable Audit Log | Yes | Yes | Read-only | No |
| Manage application settings | Yes | Yes | No | No |
| Create and restore backups | Yes | Yes | No | No |

Legacy `master` users migrate to `system_admin`; legacy `operator` users migrate to `archive_officer`. Existing `hr_admin` and `hr_officer` roles migrate to their Archive equivalents.
