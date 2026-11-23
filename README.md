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

## المعالجة الذكية للمرفقات — Offline Smart Scanner

- محرك واحد داخل `src-tauri/src/scanner.rs`: تصحيح EXIF، تدرّج رمادي، إزالة ضوضاء Gaussian، حواف Canny، تتبّع contours، تقريب رباعي، ترتيب الزوايا، تصحيح منظور وتحويل بالدقة الأصلية، وتدوير اختياري. يستخدم `image` و`imageproc` المضمّنتين في ملف التشغيل؛ لا يحتاج إلى OpenCV/Python أو نموذج خارجي أو إنترنت. درجة الثقة تقدير هندسي وليست ضمانًا لصحة التحديد.
- واجهة واحدة داخل `src/attachments/scanner.js`: أربع زوايا بالسحب أو لوحة المفاتيح، تكبير، تدوير، إعادة كشف/تعيين، معاينة قبل الحفظ، وإلغاء دون تعديل. الكشف غير الموثوق يبدأ بكامل الصورة. راجع الحواف والنتيجة قبل الحفظ.
- جميع عمليات الرفع الحالية تمر عبر `uploadWithScanner` في `src/api.js`، بما فيها صورة الموظف والبطاقات والجواز والبطاقة التموينية ومستمسكات الأسرة والأرشيف الإداري والصادر والشعار. على الوحدات المستقبلية استخدام الجسر نفسه مع سياق رفع معتمد في Rust؛ لا تستدعِ محركًا أو نظام تخزين آخر.
- الصور المدعومة: JPEG/PNG/WebP. الناتج JPEG بجودة قابلة للضبط. PDF لا يُقص ولا يُحوّل؛ تبقى طبقاته النصية وترتيب صفحاته كما هي. Word/Excel/PowerPoint تستمر عبر التحقق والرفع القائمين، دون تحويل أو تغيير محتواها. لا تضيف هذه الميزة دعم صيغ أخرى لم يكن النظام يدعمها.
- الإعدادات في شاشة «حول النظام» ضمن `app_settings` الحالية: التفعيل، الكشف التلقائي داخل الماسح، التباين، حد الثقة، وجودة JPEG. فتح الماسح اختيار واضح عند الرفع؛ يمكن تجاوز المعالجة.
- `scanner_commands.rs` يعيد فحص الصلاحيات الحالية والسياق عند الحفظ. جلسة المعالجة مرتبطة بالمستخدم؛ العمليات الثقيلة تعمل عبر `spawn_blocking`. الحد 40 megapixels / 16000px؛ حدود حجم المرفقات الحالية باقية (5MB للصور الشخصية/الشعار و20MB للمستندات).
- الجدول الحالي `document_metadata` يُوسّع بصورة متوافقة بإضافة `original_path` و`processed_path` و`parent_path` فقط. الرفع المعالج يحفظ نسخة الأصل بايتًا ببايت بجانب الناتج. إعادة معالجة مرفق محفوظ تغيّر مؤشر النسخة الحالية وتحتفظ بالأصل والنسخ السابقة وبنفس ارتباط السجل. لا يُكتب فوق ملف محفوظ: أسماء عشوائية و`create_new`. حذف المرفق أو سجله بشكل صريح يحذف نسخه المرتبطة وفق الصلاحيات القائمة.
- حفظ المعالجة والسجل والتدقيق يتم في معاملة SQLite. فشل الحفظ يُزيل ملفات المحاولة، واستبدال مرفق سابق يؤجل حذفه إلى ما بعد commit. نظام الملفات ليس جزءًا من معاملة SQLite موزّعة: انقطاع العملية/الطاقة في لحظة الكتابة قد يترك ملفًا غير مرجعي؛ لا يوجد تنظيف تلقائي يحذف ملفات مستخدمين في الخلفية. النسخ الاحتياطي يشمل الصور الأصلية والمعالجة ويتحقق من مراجعها عند الاستعادة.

### التحقق

```powershell
npm run test:scanner
npm run build
npm run tauri:build
$scanCheck = Start-Process -FilePath .\target\release\CNSArch.exe -ArgumentList '--scanner-self-test' -WindowStyle Hidden -Wait -PassThru
$scanCheck.ExitCode # 0 = PASS
```

`--scanner-self-test` اختبار صريح للمحرك داخل ملف Production نفسه: يولّد مستندًا اصطناعيًا، يختبر JPEG/PNG/WebP وكشف الحدود وتصحيح المنظور والتدوير والحفاظ على الأصل، ثم ينظّف بياناته المؤقتة. لا يفتح قاعدة بيانات المستخدم ولا مستنداته. اختبارات Rust تستخدم SQLite وتخزينًا مؤقتًا معزولًا؛ اختبارات Playwright تستخدم الشاشات الحقيقية وجسر Tauri بديلًا للاختبار. لم يُختبر جهاز ماسح ضوئي فعلي أو مستند شخصي؛ تعديل الحواف اليدوي يبقى ضروريًا عند ضعف التباين أو ازدحام الخلفية.
