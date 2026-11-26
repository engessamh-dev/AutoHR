/**
 * dashboard.js — «الرئيسية»
 * Cards (employees, missing data, document alerts), the nearest document alerts, and one
 * short list of the latest archive documents. Each part loads on its own, so one failing
 * call does not hide the others.
 */
import { api }        from "../api.js";
import { buildDocumentAlerts, loadAlertRules, alertRows, bindAlertRows } from "./document-alerts.js";
import { missingFields } from "./employees.js";
import { escHtml, formatDate, daysSince, friendlyTime, arCount } from "../utils.js";
import { can } from "../permissions.js";

const ALERTS_SHOWN = 5;
const DOCS_SHOWN = 5;

/** Newest issue date first, as in the archive; documents entered later come first on the same date. */
function byIssueDate(a, b) {
  return String(b.issue_date ?? "").localeCompare(String(a.issue_date ?? ""))
    || String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""))
    || (b.id ?? 0) - (a.id ?? 0);
}

const settled = promise => promise.then(value => ({ ok: true, value }), error => ({ ok: false, error }));

function failedPart(title) {
  return `<div class="card space-y-2" role="alert">
    <p class="section-title mb-0">${title}</p>
    <p class="text-sm text-gray-400">تعذر التحميل.</p>
    <button type="button" class="btn-secondary text-sm px-3 py-1.5 dashboard-retry">إعادة المحاولة</button>
  </div>`;
}

export async function renderDashboard(container, user, ctx) {
  const canBackups = can(user, "backups.manage");
  const canAddEmployee = can(user, "employees.create");
  const canAddDocument = can(user, "documents.manage");
  const canEditDocument = can(user, "documents.manage");
  const canUpload = can(user, "documents.upload");

  const [employeesResult, incomingResult, outgoingResult, alertRules, lastExport] = await Promise.all([
    settled(api.listEmployees()),
    settled(api.listGeneralDocs()),
    settled(api.listOutgoingDocs()),
    loadAlertRules(),
    // undefined: not asked (no permission) or unknown; null: never exported.
    canBackups ? api.lastFullExport().catch(() => undefined) : Promise.resolve(undefined),
  ]);
  const employees = employeesResult.ok ? employeesResult.value : [];
  const incomingDocs = incomingResult.ok ? incomingResult.value : [];
  const outgoingDocs = outgoingResult.ok ? outgoingResult.value : [];
  const docsLoaded = incomingResult.ok && outgoingResult.ok;

  // Nothing entered yet (a new installation): a «start here» card instead of zeros and reminders.
  const isEmpty = employeesResult.ok && docsLoaded && !employees.length && !incomingDocs.length && !outgoingDocs.length;

  // A copy outside this computer is the only protection against a disk failure or theft,
  // so a month without «تصدير نسخة كاملة» brings a reminder here (once there is data to protect).
  const exportAge = daysSince(lastExport);
  const exportReminder = !isEmpty && lastExport !== undefined && (lastExport === null || exportAge >= 30);

  const active = employees.filter(e => e.is_active);
  const inactiveCount = employees.length - active.length;
  const incomplete = active.filter(e => missingFields(e).length);
  const alerts = buildDocumentAlerts(employees, alertRules);
  const expiredCount = alerts.filter(a => a.expired).length;
  const soonCount = alerts.length - expiredCount;
  const alertTone = expiredCount ? "is-bad" : soonCount ? "is-warn" : "";

  const quickActions = [
    canAddEmployee && `<button type="button" id="dash-add-employee" class="btn-secondary text-sm px-3 py-1.5">+ إضافة موظف</button>`,
    canAddDocument && `<button type="button" id="dash-add-document" class="btn-secondary text-sm px-3 py-1.5">+ إضافة وثيقة واردة</button>`,
  ].filter(Boolean).join("");
  // The quick actions sit beside the cards (a fourth column), so they take no row of their own.
  const actionsCard = quickActions ? `<div class="stat-card dashboard-actions" aria-label="إجراءات سريعة">${quickActions}</div>` : "";

  const startCard = () => `
    <div class="card space-y-3 dashboard-start">
      <p class="section-title mb-0">ابدأ من هنا</p>
      <p class="text-sm text-gray-400">لا توجد بيانات بعد.${canAddEmployee || can(user, "settings.manage") ? " هذه أول خطوتين:" : " سيظهر هنا ملخص الموظفين والوثائق بعد إدخالها."}</p>
      <ol class="dashboard-start-steps">
        ${can(user, "settings.manage") ? `<li><button type="button" id="dash-start-company" class="btn-secondary text-sm px-3 py-1.5">اسم الجهة والشعار</button>
          <span class="text-sm text-gray-400">يظهران في أعلى البرنامج وفي التقارير المطبوعة.</span></li>` : ""}
        ${canAddEmployee ? `<li><button type="button" id="dash-start-employee" class="btn-primary text-sm px-3 py-1.5">+ إضافة أول موظف</button>
          <span class="text-sm text-gray-400">يمكن قراءة البيانات من صورة البطاقة الوطنية.</span></li>` : ""}
      </ol>
    </div>`;

  const cards = () => employeesResult.ok ? `
    <div class="grid grid-cols-1 sm:grid-cols-3 ${actionsCard ? "lg:grid-cols-4" : ""} gap-4">
      <button type="button" class="stat-card stat-card-action text-right" data-open-employees="active"
        title="فتح قائمة الموظفين النشطين">
        <span class="stat-value">${active.length}</span>
        <span class="stat-label">الموظفون النشطون</span>
        <span class="stat-sub">${inactiveCount ? `و${arCount(inactiveCount, { sing: "موظف غير نشط", one: "موظف واحد غير نشط", two: "موظفان غير نشطين", few: "موظفين غير نشطين", many: "موظفًا غير نشط" })}` : "لا يوجد موظفون غير نشطين"}</span>
      </button>
      <button type="button" class="stat-card stat-card-action text-right ${incomplete.length ? "is-warn" : ""}" data-open-employees="incomplete"
        title="فتح قائمة الموظفين الذين تنقص ملفاتهم بيانات أساسية">
        <span class="stat-value">${incomplete.length}</span>
        <span class="stat-label">ملفات ناقصة</span>
        <span class="stat-sub">${incomplete.length ? "بيانات أساسية غير مكتملة" : "كل الملفات مكتملة"}</span>
      </button>
      <button id="stat-document-alerts" type="button" class="stat-card stat-card-action text-right ${alertTone}"
        title="فتح كل تنبيهات المستمسكات">
        <span class="stat-value">${alerts.length}</span>
        <span class="stat-label">تنبيهات المستمسكات</span>
        <span class="stat-sub">${alerts.length
          ? [expiredCount && `<span class="emp-doc-tag bad">${expiredCount} منتهية</span>`, soonCount && `<span class="emp-doc-tag warn">${soonCount} قريبة النفاذ</span>`].filter(Boolean).join(" · ")
          : "لا يوجد ما ينتهي قريبًا"}</span>
      </button>
      ${actionsCard}
    </div>` : `${failedPart("الموظفون")}${actionsCard ? `<div class="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-4 gap-4">${actionsCard}</div>` : ""}`;

  const nearestAlerts = () => {
    if (!employeesResult.ok || !alerts.length) return "";
    return `
    <div class="card overflow-auto">
      <div class="flex items-center justify-between gap-3 mb-3">
        <p class="section-title mb-0">أقرب التنبيهات</p>
        ${alerts.length > ALERTS_SHOWN ? `<button type="button" id="dash-all-alerts" class="btn-secondary text-sm px-3 py-1">عرض الكل (${alerts.length})</button>` : ""}
      </div>
      <table class="w-full dashboard-table">
        <thead><tr>
          <th class="table-header">الموظف</th>
          <th class="table-header">اسم المستمسك</th>
          <th class="table-header">تاريخ النفاذ</th>
          <th class="table-header">المتبقي</th>
        </tr></thead>
        <tbody>${alertRows(alerts.slice(0, ALERTS_SHOWN), { showNumber: false })}</tbody>
      </table>
    </div>`;
  };

  const recentDocs = () => {
    if (!docsLoaded) return failedPart("آخر الوثائق");
    const docs = [
      ...incomingDocs.map(d => ({ ...d, archiveTab: "general" })),
      ...outgoingDocs.map(d => ({ ...d, archiveTab: "outgoing" })),
    ].sort(byIssueDate).slice(0, DOCS_SHOWN);
    const rowTitle = canEditDocument ? "اضغط لتعديل الوثيقة" : "اضغط لعرض الوثيقة";
    const clipTitle = canUpload ? "إدارة مرفقات الوثيقة" : "عرض مرفقات الوثيقة";
    const rows = docs.map(d => {
      const outgoing = d.archiveTab === "outgoing";
      // Incoming: who sent it (title). Outgoing: who it went to (doc_number); the sender is this unit.
      const party = outgoing ? d.doc_number : d.title;
      return `
        <tr class="table-row dashboard-doc-row" data-archive-tab="${d.archiveTab}" data-doc-id="${d.id}" tabindex="0" title="${rowTitle}">
          <td class="table-cell"><span class="dash-kind ${outgoing ? "is-out" : "is-in"}">${outgoing ? "صادر" : "وارد"}</span></td>
          <td class="table-cell font-medium text-gray-100"><span class="text-gray-500 text-xs">${outgoing ? "إلى:" : "من:"}</span> ${escHtml(party || "—")}</td>
          <td class="table-cell">${escHtml(d.issuer || "—")}</td>
          <td class="table-cell doc-cell-date">${formatDate(d.issue_date)}</td>
          <td class="table-cell">
            <button type="button" class="dashboard-doc-attachments"
              data-archive-tab="${d.archiveTab}" data-doc-id="${d.id}"
              title="${clipTitle}" aria-label="${clipTitle}"
              style="border:none;background:transparent;cursor:pointer;padding:2px">
              <span class="badge ${d.attachment_paths?.length ? "badge-green" : "badge-gray"} doc-clip-badge">
                <svg aria-hidden="true" class="doc-clip-icon" viewBox="0 0 24 24"><path d="m20.5 11.5-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.4 8.4a1.7 1.7 0 0 1-2.4-2.4l7.7-7.7"/></svg>
                <span dir="ltr">${d.attachment_paths?.length ?? 0}</span>
              </span>
            </button>
          </td>
        </tr>`;
    }).join("") || `<tr><td colspan="5" class="table-cell text-center text-gray-500">لا توجد وثائق في الأرشيف بعد</td></tr>`;
    return `
    <div class="card overflow-auto">
      <div class="flex items-center justify-between gap-3 mb-3">
        <p class="section-title mb-0">آخر الوثائق</p>
        <button type="button" id="dash-open-archive" class="btn-secondary text-sm px-3 py-1">فتح الأرشيف</button>
      </div>
      <table class="w-full dashboard-table">
        <thead><tr>
          <th class="table-header" style="width:1%">النوع</th>
          <th class="table-header">من / إلى</th>
          <th class="table-header">الموضوع</th>
          <th class="table-header">تاريخ الإصدار</th>
          <th class="table-header" style="width:1%">المرفقات</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  };

  container.innerHTML = `<div class="space-y-4">
    ${exportReminder ? `<div class="settings-storage-warning text-sm" role="status" style="display:flex;align-items:center;justify-content:space-between;gap:12px">
      <span>${lastExport ? `مرّ ${arCount(exportAge, "day")} على آخر «تصدير نسخة كاملة» (${escHtml(friendlyTime(lastExport))}).` : "لم تُصدَّر بعد نسخة كاملة خارج هذا الجهاز."}
        احفظ نسخة على فلاش أو قرص خارجي لتحمي البيانات إذا تعطّل الجهاز.</span>
      <button type="button" id="btn-export-reminder" class="btn-primary whitespace-nowrap">تصدير نسخة كاملة…</button>
    </div>` : ""}
    ${isEmpty ? startCard() : `${cards()}${nearestAlerts()}${recentDocs()}`}
  </div>`;

  const on = (selector, handler) => container.querySelector(selector)?.addEventListener("click", handler);
  on("#btn-export-reminder", () => ctx.navigateTo("settings", { tab: "storage", sub: "manual", action: "export" }));
  on("#dash-add-employee", () => ctx.navigateTo("employees", { openAdd: true }));
  on("#dash-start-employee", () => ctx.navigateTo("employees", { openAdd: true }));
  on("#dash-start-company", () => ctx.navigateTo("settings", { tab: "company" }));
  on("#dash-add-document", () => ctx.navigateTo("documents", { archiveTab: "general", addDoc: true }));
  on("#dash-open-archive", () => ctx.navigateTo("documents"));
  on("#stat-document-alerts", () => ctx.navigateTo("documentAlerts", { alertFilter: "all" }));
  on("#dash-all-alerts", () => ctx.navigateTo("documentAlerts", { alertFilter: "all" }));
  container.querySelectorAll("[data-open-employees]").forEach(card => card.addEventListener("click", () => {
    ctx.navigateTo("employees", { statusFilter: card.dataset.openEmployees });
  }));
  container.querySelectorAll(".dashboard-retry").forEach(button => button.addEventListener("click", () => ctx.navigateTo("dashboard")));
  bindAlertRows(container, ctx);
  container.querySelectorAll(".dashboard-doc-row").forEach(row => {
    const open = () => ctx.navigateTo("documents", {
      archiveTab: row.dataset.archiveTab,
      editDocId: parseInt(row.dataset.docId, 10),
    });
    row.addEventListener("click", event => { if (!event.target.closest("button")) open(); });
    row.addEventListener("keydown", event => { if (event.key === "Enter" && event.target === row) open(); });
  });
  container.querySelectorAll(".dashboard-doc-attachments").forEach(button => {
    button.addEventListener("click", event => {
      event.stopPropagation();
      ctx.navigateTo("documents", {
        archiveTab: button.dataset.archiveTab,
        manageAttachmentDocId: parseInt(button.dataset.docId, 10),
      });
    });
  });
}
