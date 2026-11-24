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
  UPDATE_AUTO_UPDATE_SETTING: "تم تغيير إعداد التحديث التلقائي",
  RESTORE_BACKUP: "تمت استعادة نسخة احتياطية",
  UPDATE_DOCUMENT_TYPES: "تم تحديث أنواع الوثائق",
};

const PAGE_SIZE = 500;
const MAX_LOGS = 1000; // backend cap in list_activity_log

function actionLabel(action) {
  return actionDetails[action] ?? action;
}

function logDetails(log) {
  if (log.details?.trim()) return log.details;
  if (log.target_name) return log.target_name;
  if (log.target_id != null) return `السجل رقم ${log.target_id}`;
  return "";
}

// created_at is stored by SQLite datetime('now'), i.e. UTC.
function logDate(value) {
  if (!value) return null;
  const date = new Date(`${String(value).replace(" ", "T")}Z`);
  return isNaN(date) ? null : date;
}

function formatLogTime(value) {
  const date = logDate(value);
  if (!date) return escHtml(value ?? "");
  const pad = n => String(n).padStart(2, "0");
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function localDay(value) {
  const date = logDate(value);
  if (!date) return "";
  const pad = n => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export async function renderAudit(container) {
  let limit = PAGE_SIZE;
  let logs = await api.listActivityLog(limit);
  const state = { search: "", user: "", action: "", from: "", to: "" };

  const filtered = () => {
    const needle = state.search.trim().toLowerCase();
    return logs.filter(log => {
      if (state.user && log.username !== state.user) return false;
      if (state.action && log.action !== state.action) return false;
      const day = localDay(log.created_at);
      if (state.from && day < state.from) return false;
      if (state.to && day > state.to) return false;
      if (!needle) return true;
      return [log.username, actionLabel(log.action), logDetails(log), log.target_type]
        .some(value => String(value ?? "").toLowerCase().includes(needle));
    });
  };

  const renderRows = () => {
    const visible = filtered();
    container.querySelector("#audit-count").textContent = `${visible.length} من ${logs.length}`;
    container.querySelector("#audit-body").innerHTML = visible.map(log => {
      const ok = log.result === "Success";
      return `<tr class="table-row">
        <td class="table-cell text-xs whitespace-nowrap" dir="ltr">${formatLogTime(log.created_at)}</td>
        <td class="table-cell">
          <span class="block" dir="ltr" style="text-align:start">${escHtml(log.username ?? "—")}</span>
          <span class="block text-xs text-gray-500">${escHtml(roleLabels[log.role] ?? log.role ?? "")}</span>
        </td>
        <td class="table-cell">${escHtml(actionLabel(log.action))}</td>
        <td class="table-cell text-xs">${escHtml(logDetails(log)) || "—"}</td>
        <td class="table-cell text-center">
          <span class="badge ${ok ? "badge-green" : "badge-red"}" style="white-space:nowrap" title="${ok ? "نجحت" : "فشلت"}">${ok ? "✓ نجحت" : "✗ فشلت"}</span>
        </td>
      </tr>`;
    }).join("") || `<tr><td colspan="5" class="table-cell text-center text-gray-500 py-8">${logs.length ? "لا توجد سجلات مطابقة" : "لا توجد سجلات"}</td></tr>`;
    container.querySelector("#audit-clear").classList.toggle("hidden", !Object.values(state).some(Boolean));
    const more = container.querySelector("#audit-more");
    more.classList.toggle("hidden", logs.length < limit || limit >= MAX_LOGS);
    container.querySelector("#audit-cap").classList.toggle("hidden", !(limit >= MAX_LOGS && logs.length >= MAX_LOGS));
  };

  const render = () => {
    const users = [...new Set(logs.map(log => log.username).filter(Boolean))].sort();
    const actions = [...new Set(logs.map(log => log.action).filter(Boolean))]
      .sort((a, b) => actionLabel(a).localeCompare(actionLabel(b), "ar"));
    container.innerHTML = `<div class="space-y-4">
      <div class="card space-y-3">
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <p class="text-sm text-gray-400">سجل تدقيق غير قابل للتعديل لكل العمليات في النظام.</p>
          <div class="flex items-center gap-2">
            <button type="button" id="audit-clear" class="btn-secondary text-xs px-3 py-1 hidden">مسح الفلاتر</button>
            <span id="audit-count" class="badge badge-gray"></span>
          </div>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-[1.6fr_1.2fr_1.6fr_1fr_1fr] gap-3">
          <input id="audit-search" class="input-field" placeholder="بحث في السجل…" value="${escHtml(state.search)}" aria-label="بحث في السجل" />
          <select id="audit-user" class="input-field" aria-label="المستخدم">
            <option value="">كل المستخدمين</option>
            ${users.map(name => `<option value="${escHtml(name)}" ${state.user === name ? "selected" : ""}>${escHtml(name)}</option>`).join("")}
          </select>
          <select id="audit-action" class="input-field" aria-label="نوع الإجراء">
            <option value="">كل الإجراءات</option>
            ${actions.map(action => `<option value="${escHtml(action)}" ${state.action === action ? "selected" : ""}>${escHtml(actionLabel(action))}</option>`).join("")}
          </select>
          <input id="audit-from" type="date" class="input-field" value="${escHtml(state.from)}" title="من تاريخ" aria-label="من تاريخ" />
          <input id="audit-to" type="date" class="input-field" value="${escHtml(state.to)}" title="إلى تاريخ" aria-label="إلى تاريخ" />
        </div>
      </div>
      <div class="card overflow-auto max-w-full">
        <table class="w-full audit-table">
          <thead><tr>
            <th class="table-header" style="width:130px">الوقت</th>
            <th class="table-header" style="width:150px">المستخدم</th>
            <th class="table-header" style="width:26%">الإجراء</th>
            <th class="table-header">التفاصيل</th>
            <th class="table-header" style="width:90px;text-align:center">النتيجة</th>
          </tr></thead>
          <tbody id="audit-body"></tbody>
        </table>
        <div class="flex justify-center pt-4">
          <button id="audit-more" type="button" class="btn-secondary hidden">تحميل المزيد</button>
          <p id="audit-cap" class="text-xs text-gray-500 hidden">يعرض السجل آخر ${MAX_LOGS} عملية كحد أقصى.</p>
        </div>
      </div>
    </div>`;

    const bind = (id, key, event = "input") => container.querySelector(id).addEventListener(event, e => {
      state[key] = e.target.value;
      renderRows();
    });
    bind("#audit-search", "search");
    bind("#audit-user", "user", "change");
    bind("#audit-action", "action", "change");
    bind("#audit-from", "from", "change");
    bind("#audit-to", "to", "change");
    container.querySelector("#audit-clear").addEventListener("click", () => {
      Object.keys(state).forEach(key => { state[key] = ""; });
      render();
    });
    container.querySelector("#audit-more").addEventListener("click", async event => {
      event.currentTarget.disabled = true;
      limit = Math.min(MAX_LOGS, limit + PAGE_SIZE);
      logs = await api.listActivityLog(limit);
      render();
    });
    renderRows();
  };
  render();
}
