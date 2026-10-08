import { api } from "../api.js";
import { escHtml } from "../utils.js";
import { roleLabels } from "../permissions.js";

const actionDetails = {
  PROCESS_DOCUMENT: "تمت معالجة صورة المرفق محليًا مع الحفاظ على الأصل",
  UPDATE_SCANNER_SETTINGS: "تم تحديث إعدادات قص المرفقات وتدويرها",
  LOGIN: "تم تسجيل الدخول إلى النظام",
  LOGOUT: "تم تسجيل الخروج من النظام",
  CHANGE_PASSWORD: "تم تغيير كلمة المرور",
  CREATE_EMPLOYEE: "تم إنشاء سجل موظف جديد",
  UPDATE_EMPLOYEE: "تم تحديث بيانات الموظف",
  DELETE_EMPLOYEE: "تم حذف سجل الموظف",
  ADD_GRADE: "تمت إضافة درجة وظيفية للموظف",
  CREATE_DOC: "تم إنشاء وثيقة واردة",
  UPDATE_DOC: "تم تحديث الوثيقة الواردة",
  DELETE_DOC: "تم حذف الوثيقة الواردة",
  CREATE_OUTGOING_DOC: "تم إنشاء وثيقة صادرة",
  UPDATE_OUTGOING_DOC: "تم تحديث الوثيقة الصادرة",
  DELETE_OUTGOING_DOC: "تم حذف الوثيقة الصادرة",
  UPLOAD_DOCUMENT: "تم رفع ملف أو مستمسك",
  UPLOAD_ATTACHMENT: "تم رفع مرفق للموظف",
  DELETE_DOCUMENT: "تم حذف ملف وثيقة",
  DELETE_ATTACHMENT: "تم حذف مرفق الموظف",
  PRINT_DOCUMENT: "تمت طباعة الوثيقة",
  VIEW_DOCUMENT: "تمت معاينة الوثيقة",
  DOWNLOAD_DOCUMENT: "تم تحميل الوثيقة إلى الحاسبة",
  SCAN_DOCUMENT: "تم مسح الوثيقة ضوئياً",
  REORDER_DOCUMENT_ATTACHMENT: "تم تغيير ترتيب مرفقات الوثيقة",
  CREATE_USER: "تم إنشاء مستخدم جديد",
  DELETE_USER: "تم حذف المستخدم",
  CHANGE_USER_ROLE: "تم تغيير صلاحية المستخدم",
  RESET_USER_PASSWORD: "تمت إعادة تعيين كلمة مرور المستخدم",
  CHANGE_SETTING: "تم تغيير إعدادات النظام",
  UPLOAD_COMPANY_LOGO: "تم تحديث شعار الجهة",
  CREATE_BACKUP: "تم إنشاء نسخة احتياطية",
  CREATE_AUTO_BACKUP: "تم إنشاء نسخة احتياطية تلقائية",
  RESTORE_BACKUP: "تمت استعادة نسخة احتياطية",
  UPDATE_DOCUMENT_TYPES: "تم تحديث أنواع الوثائق",
};

function activityDetails(log) {
  if (log.details?.trim()) return log.details;
  const description = actionDetails[log.action] ?? `تم تنفيذ الإجراء ${log.action}`;
  const target = log.target_name
    ? `: ${log.target_name}`
    : log.target_id != null
      ? ` على السجل رقم ${log.target_id}`
      : "";
  return `${description}${target}`;
}

export async function renderAudit(container) {
  const logs = await api.listActivityLog(500);
  container.innerHTML = `<div class="card overflow-auto max-w-full">
    <div class="flex items-center justify-between mb-4">
      <p class="section-title mb-0">سجل التدقيق غير القابل للتعديل</p>
      <span class="badge badge-gray">${logs.length}</span>
    </div>
    <table class="w-full table-fixed audit-table">
      <colgroup>
        <col style="width:12%">
        <col style="width:10%">
        <col style="width:11%">
        <col style="width:14%">
        <col style="width:27%">
        <col style="width:10%">
        <col style="width:16%">
      </colgroup>
      <thead><tr>
        <th class="table-header">الوقت</th><th class="table-header">المستخدم</th>
        <th class="table-header">الدور</th><th class="table-header">الإجراء</th>
        <th class="table-header">الهدف</th><th class="table-header">النتيجة</th><th class="table-header">التفاصيل</th>
      </tr></thead>
      <tbody>${logs.map(log => `<tr class="table-row">
        <td class="table-cell text-xs" dir="ltr">${escHtml(log.created_at ?? "")}</td>
        <td class="table-cell" dir="ltr">${escHtml(log.username)}</td>
        <td class="table-cell">${escHtml(roleLabels[log.role] ?? log.role)}</td>
        <td class="table-cell" dir="ltr">${escHtml(log.action)}</td>
        <td class="table-cell">${escHtml(log.target_type ?? "")}${log.target_id != null ? ` #${log.target_id}` : ""}${log.target_name ? ` - ${escHtml(log.target_name)}` : ""}</td>
        <td class="table-cell"><span class="badge ${log.result === "Success" ? "badge-green" : "badge-gray"}">${escHtml(log.result)}</span></td>
        <td class="table-cell text-xs">${escHtml(activityDetails(log))}</td>
      </tr>`).join("") || `<tr><td colspan="7" class="table-cell text-center text-gray-500">لا توجد سجلات</td></tr>`}</tbody>
    </table>
  </div>`;
}
