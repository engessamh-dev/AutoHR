/**
 * dashboard.js — GCANS v2.0
 * Stats + expiry alerts (badges) + contract renewal warnings
 */
import { api }        from "../api.js";
import { buildDocumentAlerts } from "./document-alerts.js";
import { escHtml, formatDate } from "../utils.js";

export async function renderDashboard(container, user, ctx) {
  const [employees, incomingDocs, outgoingDocs] = await Promise.all([
    api.listEmployees(),
    api.listGeneralDocs(),
    api.listOutgoingDocs(),
  ]);
  const active    = employees.filter(e => e.is_active);
  const inactive  = employees.filter(e => !e.is_active);

  const documentAlerts = buildDocumentAlerts(employees);

  function recentDocsRows(docs, emptyLabel, archiveTab) {
    return docs
      .slice()
      .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))
      .slice(0, 5)
      .map(d => `
        <tr class="table-row dashboard-doc-row" data-archive-tab="${archiveTab}" data-doc-id="${d.id}" title="اضغط لتعديل الوثيقة">
          <td class="table-cell font-medium text-gray-100">${escHtml(d.title || "—")}</td>
          <td class="table-cell">${escHtml(d.issuer || "—")}</td>
          <td class="table-cell" dir="ltr">${escHtml(d.doc_number || "—")}</td>
          <td class="table-cell">${formatDate(d.issue_date)}</td>
          <td class="table-cell">
            <button type="button" class="dashboard-doc-attachments"
              data-archive-tab="${archiveTab}" data-doc-id="${d.id}"
              title="إدارة مرفقات الوثيقة"
              style="border:none;background:transparent;cursor:pointer;padding:2px">
              <span class="badge ${d.attachment_paths?.length ? "badge-green" : "badge-gray"}"
                style="gap:6px;font-size:12px;padding:5px 11px">
                <span>📎</span>
                <span dir="ltr">${d.attachment_paths?.length ?? 0}</span>
              </span>
            </button>
          </td>
        </tr>`)
      .join("") || `<tr><td colspan="5" class="table-cell text-center text-gray-500">${emptyLabel}</td></tr>`;
  }

  container.innerHTML = `<div class="space-y-5">

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
            <th class="table-header">الموضوع</th>
            <th class="table-header">إلى</th>
            <th class="table-header">تاريخ الإصدار</th>
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
            <th class="table-header">الموضوع</th>
            <th class="table-header">إلى</th>
            <th class="table-header">تاريخ الإصدار</th>
            <th class="table-header">المرفقات</th>
          </tr></thead>
          <tbody>${recentDocsRows(outgoingDocs, "لا توجد وثائق صادرة", "outgoing")}</tbody>
        </table>
      </div>
    </div>
  </div>`;

  container.querySelector("#stat-document-alerts")?.addEventListener("click", () => {
    ctx.navigateTo("documentAlerts");
  });
  container.querySelectorAll(".dashboard-doc-row").forEach(row => {
    row.addEventListener("click", event => {
      if (event.target.closest("button")) return;
      ctx.navigateTo("documents", {
        archiveTab: row.dataset.archiveTab,
        editDocId: parseInt(row.dataset.docId, 10),
        compactArchiveMode: true,
      });
    });
  });
  container.querySelectorAll(".dashboard-doc-attachments").forEach(button => {
    button.addEventListener("click", event => {
      event.stopPropagation();
      ctx.navigateTo("documents", {
        archiveTab: button.dataset.archiveTab,
        manageAttachmentDocId: parseInt(button.dataset.docId, 10),
        compactArchiveMode: true,
      });
    });
  });
}
