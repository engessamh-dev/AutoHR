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
- **Password:** `password`

## الشاشات

| الشاشة | الوصول |
|--------|--------|
| لوحة التحكم | الجميع |
| دليل الموظفين | الجميع |
| أرشيف الوثائق | الجميع |
| إعدادات الهوية والأقسام | **sysadmin فقط** |
| حول النظام | الجميع |

راجع [ARCHITECTURE.md](ARCHITECTURE.md) للتفاصيل الكاملة.

**Eng. Essam Al-Emaraa**
