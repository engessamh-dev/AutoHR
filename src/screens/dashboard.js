/**
 * dashboard.js — GCANS v2.0
 * Stats + expiry alerts (badges) + contract renewal warnings
 */
import { api }        from "../api.js";
import { buildDocumentAlerts, loadAlertRules } from "./document-alerts.js";
import { escHtml, formatDate, daysSince, friendlyTime } from "../utils.js";
import { can } from "../permissions.js";

export async function renderDashboard(container, user, ctx) {
  const canBackups = can(user, "backups.manage");
  const [employees, incomingDocs, outgoingDocs, alertRules, lastExport] = await Promise.all([
    api.listEmployees(),
    api.listGeneralDocs(),
    api.listOutgoingDocs(),
    loadAlertRules(),
    // undefined: not asked (no permission) or unknown; null: never exported.
    canBackups ? api.lastFullExport().catch(() => undefined) : Promise.resolve(undefined),
  ]);
  // A copy outside this computer is the only protection against a disk failure or theft,
  // so a month without «تصدير نسخة كاملة» brings a reminder here.
  const exportAge = daysSince(lastExport);
  const exportReminder = lastExport !== undefined && (lastExport === null || exportAge >= 30);
  const active    = employees.filter(e => e.is_active);
  const inactive  = employees.filter(e => !e.is_active);

  const documentAlerts = buildDocumentAlerts(employees, alertRules);

  function recentDocsRows(docs, emptyLabel, archiveTab) {
    return docs
      .slice()
      .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))
      .slice(0, 5)
      .map(d => `
        <tr class="table-row dashboard-doc-row" data-archive-tab="${archiveTab}" data-doc-id="${d.id}" title="اضغط لتعديل الوثيقة">
          <td class="table-cell font-medium text-gray-100">${escHtml(d.title || "—")}</td>
          <td class="table-cell">${escHtml(d.doc_number || "—")}</td>
          <td class="table-cell">${formatDate(d.issue_date)}</td>
          <td class="table-cell">${escHtml(d.issuer || "—")}</td>
          <td class="table-cell">
            <button type="button" class="dashboard-doc-attachments"
              data-archive-tab="${archiveTab}" data-doc-id="${d.id}"
              title="إدارة مرفقات الوثيقة"
              style="border:none;background:transparent;cursor:pointer;padding:2px">
              <span class="badge ${d.attachment_paths?.length ? "badge-green" : "badge-gray"} doc-clip-badge">
                <svg aria-hidden="true" class="doc-clip-icon" viewBox="0 0 24 24"><path d="m20.5 11.5-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.4 8.4a1.7 1.7 0 0 1-2.4-2.4l7.7-7.7"/></svg>
                <span dir="ltr">${d.attachment_paths?.length ?? 0}</span>
              </span>
            </button>
          </td>
        </tr>`)
      .join("") || `<tr><td colspan="5" class="table-cell text-center text-gray-500">${emptyLabel}</td></tr>`;
  }

  container.innerHTML = `<div class="space-y-5">
    ${exportReminder ? `<div class="settings-storage-warning text-sm" role="status" style="display:flex;align-items:center;justify-content:space-between;gap:12px">
      <span>${lastExport ? `مرّ ${exportAge} يومًا على آخر «تصدير نسخة كاملة» (${escHtml(friendlyTime(lastExport))}).` : "لم تُصدَّر بعد نسخة كاملة خارج هذا الجهاز."}
        احفظ نسخة على فلاش أو قرص خارجي لتحمي البيانات إذا تعطّل الجهاز.</span>
      <button type="button" id="btn-export-reminder" class="btn-primary whitespace-nowrap">تصدير نسخة كاملة…</button>
    </div>` : ""}

    <!-- Stats -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
      <div class="stat-card"><span class="stat-value">${employees.length}</span><span class="stat-label">إجمالي الموظفين</span></div>
      <div class="stat-card"><span class="stat-value">${active.length}</span><span class="stat-label">الموظفون النشطون</span></div>
      <div class="stat-card"><span class="stat-value">${inactive.length}</span><span class="stat-label">الموظفون غير النشطين</span></div>
      <button id="stat-document-alerts" type="button" class="stat-card stat-card-action text-right">
        <span class="stat-value">${documentAlerts.length}</span>
        <span class="stat-label">تنبيهات المستمسكات</span>
      </button>
    </div>


    <div class="space-y-4">
      <div class="card overflow-auto">
        <div class="flex items-center justify-between gap-3 mb-4">
          <p class="section-title mb-0">الوارد</p>
          <span class="badge badge-gray">آخر 5 وثائق</span>
        </div>
        <table class="w-full">
          <thead><tr>
            <th class="table-header">الجهة المصدرة</th>
            <th class="table-header">إلى</th>
            <th class="table-header">تاريخ الإصدار</th>
            <th class="table-header">الموضوع</th>
            <th class="table-header">المرفقات</th>
          </tr></thead>
          <tbody>${recentDocsRows(incomingDocs, "لا توجد وثائق واردة", "general")}</tbody>
        </table>
      </div>

      <div class="card overflow-auto">
        <div class="flex items-center justify-between gap-3 mb-4">
          <p class="section-title mb-0">الصادر</p>
          <span class="badge badge-gray">آخر 5 وثائق</span>
        </div>
        <table class="w-full">
          <thead><tr>
            <th class="table-header">الجهة المصدرة</th>
            <th class="table-header">إلى</th>
            <th class="table-header">تاريخ الإصدار</th>
            <th class="table-header">الموضوع</th>
            <th class="table-header">المرفقات</th>
          </tr></thead>
          <tbody>${recentDocsRows(outgoingDocs, "لا توجد وثائق صادرة", "outgoing")}</tbody>
        </table>
      </div>
    </div>
  </div>`;

  container.querySelector("#btn-export-reminder")?.addEventListener("click", () => {
    ctx.navigateTo("settings", { tab: "storage", sub: "manual" });
  });
  container.querySelector("#stat-document-alerts")?.addEventListener("click", () => {
    ctx.navigateTo("documentAlerts");
  });
  container.querySelectorAll(".dashboard-doc-row").forEach(row => {
    row.addEventListener("click", event => {
      if (event.target.closest("button")) return;
      ctx.navigateTo("documents", {
        archiveTab: row.dataset.archiveTab,
        editDocId: parseInt(row.dataset.docId, 10),
      });
    });
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
