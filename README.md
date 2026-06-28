# AutoHR v1.0.0

تطبيق سطح مكتب خفيف لإدارة الموارد البشرية وأرشفة الوثائق (50–75 موظف).

## التشغيل

```powershell
npm install
npm install better-sqlite3 --save-dev
npm run seed-db
npm run tauri:dev
```

## الدخول الافتراضي

- **Username:** `sysadmin`
- **Temporary password:** `password` (must be changed before the system can be used)

## الشاشات

| الشاشة | الوصول |
|--------|--------|
| لوحة التحكم | الجميع |
| دليل الموظفين | الجميع |
| أرشيف الوثائق | الجميع |
| إعدادات الهوية والأقسام | **sysadmin فقط** |
| حول النظام | الجميع |

راجع [ARCHITECTURE.md](ARCHITECTURE.md) للتفاصيل الكاملة.

## HR Promotion and Annual Allowance Module

CNSArch includes a configurable HR module for Iraqi government promotion and annual allowance workflows.
The module keeps legal/business values in SQLite tables and does not hard-code them in Rust or JavaScript.
Seeded values, if added later, must be treated as editable examples only.

Main areas:

- HR Dashboard: promotion and allowance alerts, overdue employees, missing HR data, unprocessed appreciation letters, and active penalties.
- Employee HR Profile: salary grade/step, base salary, last promotion date, last allowance date, service status, linked document references, and approved manual override dates.
- Salary Scale: grade/step salary, allowance amount, promotion period, allowance period, target grade/step after promotion, effective dates, version, and active status.
- Rules: appreciation, penalty, service interruption, and alert lead-time configuration with versioning and effective dates.
- Records: appreciation letters, penalties, and service interruptions linked to existing employee records.
- Reports: promotion eligibility, annual allowance eligibility, missing data, overdue cases, and calculation sheets with Excel export.

Calculation flow:

1. Configure salary scale rows for each active grade/step and effective date.
2. Fill each employee HR profile with current grade/step and last promotion/allowance dates.
3. Add appreciation letters, penalties, and service interruptions.
4. Open the HR Dashboard or Reports tab to recalculate eligibility.
5. Review Calculation Details on the employee HR profile. The system shows original due date, credits, delays, excluded service periods, final due date, alert date, status, and counted/ignored items.

Manual overrides keep the calculated system date and store the approved manual date separately. Override reason and approval notes are audited in the existing immutable activity log.

**Eng. Essam Al-Emaraa**
