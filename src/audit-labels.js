// «سجل النظام»: Arabic names for every action the program records, and readable details.
// Every action code written by the backend must have an entry here (see tests/audit.spec.js).
import { roleLabels } from "./permissions.js";
import { employeeFieldLabels } from "./screens/reports.js";

export const ACTION_GROUPS = [
  "الدخول", "الموظفون", "مستمسكات الموظف", "الأرشيف", "المعاينة والطباعة والتصدير",
  "المستخدمون", "الإعدادات", "النسخ الاحتياطية", "البرنامج",
];

const A = (label, group) => ({ label, group });
const card = (name, kind) => ({
  [`UPLOAD_${kind}_ATTACHMENT`]: A(`رفع ${name}`, "مستمسكات الموظف"),
  [`DELETE_${kind}_ATTACHMENT`]: A(`حذف ${name}`, "مستمسكات الموظف"),
});

export const ACTIONS = {
  LOGIN: A("تسجيل دخول", "الدخول"),
  LOGOUT: A("تسجيل خروج", "الدخول"),
  CHANGE_PASSWORD: A("تغيير كلمة المرور", "الدخول"),
  ACCESS_DENIED: A("محاولة بلا صلاحية", "الدخول"),

  CREATE_EMPLOYEE: A("إضافة موظف", "الموظفون"),
  UPDATE_EMPLOYEE: A("تعديل بيانات موظف", "الموظفون"),
  DELETE_EMPLOYEE: A("حذف موظف", "الموظفون"),
  ADD_GRADE: A("إضافة درجة وظيفية", "الموظفون"),
  DELETE_GRADE: A("حذف درجة وظيفية", "الموظفون"),
  REVIEW_NAME: A("مراجعة اسم", "الموظفون"),
  ADD_ADDRESS_PLACE: A("إضافة منطقة سكن", "الموظفون"),
  DOCUMENT_TEXT_READ: A("قراءة البيانات من صورة", "الموظفون"),

  UPLOAD_ATTACHMENT: A("رفع مرفق للموظف", "مستمسكات الموظف"),
  DELETE_ATTACHMENT: A("حذف مرفق للموظف", "مستمسكات الموظف"),
  ...card("البطاقة الوطنية", "NATIONAL_CARD"),
  ...card("بطاقة فرد من العائلة", "FAMILY_NATIONAL_CARD"),
  ...card("بطاقة الزوج/الزوجة", "SPOUSE_NATIONAL_CARD"),
  ...card("سنوية المركبة", "VEHICLE_ANNUAL"),
  ...card("بطاقة السكن", "RESIDENCE_CARD"),
  ...card("باج المطار", "AIRPORT_BADGE"),
  ...card("هوية وزارة النقل", "MINISTRY_BADGE"),
  ...card("جواز السفر", "PASSPORT"),
  ...card("البطاقة التموينية", "RATION_CARD"),
  PROCESS_DOCUMENT: A("قص صورة مرفق وتعديلها", "مستمسكات الموظف"),
  SCAN_DOCUMENT: A("مسح ضوئي", "مستمسكات الموظف"),

  UPLOAD_DOCUMENT: A("رفع ملف", "الأرشيف"),
  DELETE_DOCUMENT: A("حذف ملف", "الأرشيف"),
  REORDER_DOCUMENT_ATTACHMENT: A("تغيير ترتيب المرفقات", "الأرشيف"),
  CREATE_DOC: A("إضافة وثيقة واردة", "الأرشيف"),
  UPDATE_DOC: A("تعديل وثيقة واردة", "الأرشيف"),
  DELETE_DOC: A("حذف وثيقة واردة", "الأرشيف"),
  CREATE_OUTGOING_DOC: A("إضافة وثيقة صادرة", "الأرشيف"),
  UPDATE_OUTGOING_DOC: A("تعديل وثيقة صادرة", "الأرشيف"),
  DELETE_OUTGOING_DOC: A("حذف وثيقة صادرة", "الأرشيف"),
  UPDATE_DOCUMENT_TYPES: A("تعديل قائمة المواضيع", "الأرشيف"),

  VIEW_DOCUMENT: A("معاينة", "المعاينة والطباعة والتصدير"),
  PRINT_DOCUMENT: A("طباعة", "المعاينة والطباعة والتصدير"),
  DOWNLOAD_DOCUMENT: A("تحميل ملف إلى الحاسبة", "المعاينة والطباعة والتصدير"),
  PRINT_REPORT: A("طباعة تقرير الموظفين", "المعاينة والطباعة والتصدير"),
  EXPORT_REPORT: A("تصدير تقرير الموظفين إلى Excel", "المعاينة والطباعة والتصدير"),
  EXPORT_AUDIT_LOG: A("تصدير سجل النظام", "المعاينة والطباعة والتصدير"),

  CREATE_USER: A("إضافة مستخدم", "المستخدمون"),
  DELETE_USER: A("حذف مستخدم", "المستخدمون"),
  CHANGE_USER_ROLE: A("تغيير صلاحية مستخدم", "المستخدمون"),
  RESET_USER_PASSWORD: A("إعادة تعيين كلمة مرور", "المستخدمون"),
  FIRST_RUN_SETUP: A("الإعداد الأول: إنشاء حساب المسؤول", "المستخدمون"),
  UPDATE_PASSWORD_POLICY: A("تعديل سياسة كلمة المرور", "المستخدمون"),
  NEW_RECOVERY_CODE: A("إنشاء رمز استعادة جديد", "المستخدمون"),
  RECOVER_ADMIN_PASSWORD: A("استعادة كلمة مرور المسؤول برمز الاستعادة", "الدخول"),
  ADMIN_UNLOCK_REQUEST: A("طلب رمز فتح من المطوّر", "الدخول"),
  ADMIN_UNLOCK: A("فتح حساب المسؤول برمز المطوّر", "الدخول"),
  DISABLE_USER: A("إيقاف حساب مستخدم", "المستخدمون"),
  ENABLE_USER: A("إعادة تشغيل حساب مستخدم", "المستخدمون"),

  CHANGE_SETTING: A("تغيير الإعدادات", "الإعدادات"),
  UPLOAD_COMPANY_LOGO: A("تغيير شعار الجهة", "الإعدادات"),
  UPDATE_SCANNER_SETTINGS: A("إعدادات قص المرفقات", "الإعدادات"),
  UPDATE_AUTO_UPDATE_SETTING: A("إعداد التحديث التلقائي", "الإعدادات"),
  UPDATE_DOCUMENT_ALERT_SETTINGS: A("إعدادات تنبيهات المستمسكات", "الإعدادات"),
  MOVE_DATA_FOLDER: A("نقل مجلد البيانات", "الإعدادات"),
  CHANGE_BACKUP_FOLDER: A("تغيير مجلد النسخ الاحتياطية", "الإعدادات"),
  APPROVE_DATA_INTEGRITY: A("اعتماد البيانات على هذا الجهاز", "الإعدادات"),

  CREATE_BACKUP: A("نسخة احتياطية", "النسخ الاحتياطية"),
  CREATE_AUTO_BACKUP: A("نسخة احتياطية تلقائية", "النسخ الاحتياطية"),
  EXPORT_BACKUP: A("تصدير نسخة احتياطية", "النسخ الاحتياطية"),
  RESTORE_BACKUP: A("استعادة نسخة احتياطية", "النسخ الاحتياطية"),
  DELETE_OLD_BACKUPS: A("حذف النسخ الاحتياطية القديمة", "النسخ الاحتياطية"),

  INSTALL_UPDATE: A("تثبيت تحديث", "البرنامج"),
  SAVE_HEALTH_REPORT: A("حفظ تقرير الفحص", "البرنامج"),
};

/** Shown only with «إظهار الدخول والمعاينة»: they fill most of the log. Failures always show. */
export const ROUTINE_ACTIONS = ["LOGIN", "LOGOUT", "VIEW_DOCUMENT", "DOCUMENT_TEXT_READ", "PROCESS_DOCUMENT"];

export function actionLabel(log) {
  const action = typeof log === "string" ? log : log.action;
  if (typeof log === "object" && log.result !== "Success") {
    if (action === "LOGIN") return "محاولة دخول فاشلة";
  }
  if (typeof log === "object" && action === "UPLOAD_DOCUMENT" && log.target_type === "employee") return "رفع الصورة الشخصية";
  if (typeof log === "object" && action === "DELETE_DOCUMENT" && log.target_type === "employee") return "حذف الصورة الشخصية";
  if (typeof log === "object" && action === "VIEW_DOCUMENT" && log.target_name === "employee_documents") return "فتح مستمسكات الموظف";
  return ACTIONS[action]?.label ?? action;
}

export const actionGroup = action => ACTIONS[action]?.group ?? "البرنامج";

const SIDES = { front: "الوجه الأمامي", back: "الوجه الخلفي" };
const REASONS = {
  "Invalid password": "كلمة مرور خاطئة",
  "Unknown username": "اسم مستخدم غير موجود",
  "Account temporarily locked": "الحساب موقوف مؤقتًا بعد محاولات فاشلة",
  "Account modified outside the program": "الحساب عُدِّل من خارج البرنامج",
  "You are not authorized to perform this action": "ليست لديه صلاحية",
  "The requested item was not found": "العنصر غير موجود",
  "The database operation could not be completed": "تعذر الحفظ في قاعدة البيانات",
};
const FREQUENCY = { Daily: "يومية", Weekly: "أسبوعية", Monthly: "شهرية" };
const PERMISSIONS = {
  "dashboard.view": "عرض الرئيسية", "employees.view": "عرض الموظفين", "employees.create": "إضافة موظفين",
  "employees.edit": "تعديل الموظفين", "employees.delete": "حذف الموظفين", "documents.view": "عرض الأرشيف",
  "documents.manage": "إدارة الأرشيف", "documents.upload": "رفع الملفات", "documents.download": "تحميل الملفات",
  "documents.delete": "حذف الوثائق", "documents.print": "الطباعة", "users.manage": "إدارة المستخدمين",
  "users.assign_system_admin": "تعيين مسؤول النظام", "audit.view": "سجل النظام", "settings.manage": "الإعدادات",
  "backups.manage": "النسخ الاحتياطية", "backups.restore": "استعادة النسخ",
};
const SETTINGS = {
  company_config: "اسم الجهة والقسم والشعبة", automatic_backups: "النسخ الاحتياطية التلقائية",
  document_types: "قائمة مواضيع الأرشيف",
};
const OTHER_FIELDS = {
  company_name: "اسم الجهة", department_name: "القسم", division_name: "الشعبة",
  title: "الجهة المصدرة", doc_number: "إلى", issuer: "الموضوع", doc_count: "العدد", issue_date: "تاريخ الإصدار",
  margin: "الهامش", is_internal_memo: "مذكرة داخلية", employee_names: "الموظفون المرتبطون",
  spouses: "الزوج/الزوجات", family_members: "أفراد الأسرة", vehicles: "المركبات", is_active: "حالة الموظف",
  marriage_date: "تاريخ الزواج", hr_effect_type: "الأثر الوظيفي",
};

export const roleLabel = role => roleLabels[role] ?? (role === "unknown" ? "" : role ?? "");

/** Who did it, as shown: the program itself, a known account, or a masked unknown name. */
export function userLabel(log) {
  if (log.username === "system") return "البرنامج (تلقائي)";
  if (log.role === "unknown" && log.action === "LOGIN" && log.details === "Unknown username" && !log.username.endsWith("…")) {
    // Entries written before names were masked: show only the first two characters.
    return `${[...log.username.trim()].slice(0, 2).join("")}…`;
  }
  return log.username ?? "—";
}

function fieldLabel(key, docLike) {
  if (docLike && OTHER_FIELDS[key]) return OTHER_FIELDS[key];
  return employeeFieldLabels[key] ?? OTHER_FIELDS[key] ?? key;
}

function translateNote(note) {
  const text = String(note).trim();
  if (SIDES[text]) return SIDES[text];
  if (text === "photo") return "";
  if (REASONS[text]) return REASONS[text];
  if (FREQUENCY[text]) return `نسخة ${FREQUENCY[text]}`;
  if (text === "enabled") return "تشغيل";
  if (text === "disabled") return "إيقاف";
  if (text === "up") return "إلى الأعلى";
  if (text === "down") return "إلى الأسفل";
  let match = text.match(/^(\d+):(front|back)$/);
  if (match) return `رقم ${Number(match[1]) + 1}، ${SIDES[match[2]]}`;
  match = text.match(/^(\w+) -> (\w+)$/);
  if (match) return `من «${roleLabel(match[1]) || match[1]}» إلى «${roleLabel(match[2]) || match[2]}»`;
  match = text.match(/^(\w+); before: (\w+)$/);
  if (match) return match[1] === "restore" ? "بعد استعادة نسخة احتياطية" : "اعتماد يدوي";
  if (text.startsWith("offline-scanner")) return "مع الاحتفاظ بالأصل";
  if (text.startsWith("{") || text.startsWith("[")) return "";
  return text;
}

const isStoredPath = value => /^Files\//.test(value ?? "") || /^[0-9a-f]{20,}\.\w+$/i.test(value ?? "");

function targetText(log) {
  const name = log.target_name;
  if (!name || isStoredPath(name)) return "";
  if (log.target_type === "user") return `المستخدم: ${name}`;
  if (log.target_type === "permission") return `الصلاحية: ${PERMISSIONS[name] ?? name}`;
  if (log.target_type === "settings") return SETTINGS[name] ?? (name.includes("\\") || name.includes("/") ? `المجلد: ${name}` : name);
  if (log.action === "ADD_GRADE" || log.action === "DELETE_GRADE") return `الدرجة: ${name}`;
  if (log.target_type === "report" || log.target_type === "audit" || log.target_type === "backup") return `الملف: ${name}`;
  if (log.action === "VIEW_DOCUMENT" && name === "employee_documents") return "";
  if (log.action === "DOCUMENT_TEXT_READ") return name === "add-employee wizard" ? "معالج إضافة موظف" : "";
  if (log.action === "REVIEW_NAME") return name.replace(/^[\w]+\/[\w]+:\s*/, "");
  if (log.target_type === "app") return name === "Healthy" || name === "Ok" ? "" : name;
  return name;
}

function docText(doc) {
  const head = [doc.from, doc.to && `إلى ${doc.to}`].filter(Boolean).join(" ");
  return [
    head,
    doc.subject,
    doc.number && `العدد ${doc.number}`,
    doc.date && doc.date.replace(/^(\d{4})-0?(\d{1,2})-0?(\d{1,2}).*/, "$1/$2/$3"),
    doc.files ? `مرفقات: ${doc.files}` : "",
  ].filter(Boolean).join("، ");
}

function changesText(changes, docLike) {
  if (!changes?.length) return "";
  const shown = changes.slice(0, 4).map(change => {
    const label = fieldLabel(change.field, docLike);
    if (!("old" in change)) return label;
    const old = change.old === "" ? "فارغ" : change.old;
    const now = change.new === "" ? "فارغ" : change.new;
    return `${label}: من «${old}» إلى «${now}»`;
  });
  const rest = changes.length > 4 ? ` و${changes.length - 4} حقول أخرى` : "";
  return `التغييرات: ${shown.join("؛ ")}${rest}`;
}

/** One readable line for the «التفاصيل» column, from old and new entries alike. */
export function describeLog(log) {
  return describeParts(log).join(" · ");
}

/** The parts of the details line, each to be shown in its own direction. */
export function describeParts(log) {
  let data = null;
  const raw = log.details?.trim() ?? "";
  if (raw.startsWith("{")) {
    try { data = JSON.parse(raw); } catch { data = null; }
  }
  const docLike = ["general_doc", "outgoing_doc", "settings"].includes(log.target_type);
  const parts = [];
  if (data?.employee) parts.push(`الموظف: ${data.employee}${data.employee_number ? ` (${data.employee_number})` : ""}`);
  else if (log.target_type === "employee" && !["CREATE_EMPLOYEE", "UPDATE_EMPLOYEE", "DELETE_EMPLOYEE"].includes(log.action) && log.target_id != null) {
    parts.push(`الموظف رقم ${log.target_id}`);
  }
  if (data?.doc) parts.push(docText(data.doc));
  else if (["general_doc", "outgoing_doc"].includes(log.target_type) && log.target_id != null && isStoredPath(log.target_name)) {
    parts.push(`${log.target_type === "outgoing_doc" ? "الوثيقة الصادرة" : "الوثيقة الواردة"} رقم ${log.target_id}`);
  }
  const target = targetText(log);
  if (target && !(data?.employee && target === data.employee) && !(data?.doc && target === data.doc.from)) parts.push(target);
  if (data?.changes) parts.push(changesText(data.changes, docLike));
  if (data?.rows != null) parts.push(`عدد الصفوف: ${data.rows}`);
  const note = data ? data.note : raw;
  if (note && log.action === "DOWNLOAD_DOCUMENT") {
    parts.push(`حُفظ في: ${note}`);
  } else if (note) {
    const text = translateNote(note);
    if (text) parts.push(log.result !== "Success" ? `السبب: ${text}` : text);
  }
  return parts.filter(Boolean);
}
