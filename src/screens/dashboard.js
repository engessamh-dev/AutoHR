/**
 * dashboard.js — GCANS v2.0
 * Stats + expiry alerts (badges) + contract renewal warnings
 */
import { api }        from "../api.js";
import { buildDocumentAlerts } from "./document-alerts.js";
import { confirmAction, escHtml, formatDate } from "../utils.js";

export async function renderDashboard(container, user, ctx) {
  const [employees, incomingDocs, outgoingDocs] = await Promise.all([
    api.listEmployees(),
    api.listGeneralDocs(),
    api.listOutgoingDocs(),
  ]);
  const active    = employees.filter(e => e.is_active);
  const inactive  = employees.filter(e => !e.is_active);

  const documentAlerts = buildDocumentAlerts(employees);

  function alertRow(a, typeLabel = "") {
    const color  = a.expired ? "#dc2626" : "#d97706";
    const bg     = a.expired ? "#dc262615" : "#d9770615";
    const label  = a.expired ? "منتهي" : `${a.days} يوم`;
    return `<tr style="border-bottom:1px solid #2d2d2d">
      <td class="table-cell font-medium">${escHtml(a.name)}</td>
      <td class="table-cell" dir="ltr">${escHtml(a.num ?? "—")}</td>
      ${typeLabel ? `<td class="table-cell">${escHtml(a.type ?? typeLabel)}</td>` : ""}
      <td class="table-cell">${formatDate(a.date)}</td>
      <td class="table-cell">
        <span style="padding:2px 10px;border-radius:999px;font-size:12px;font-weight:700;
          background:${bg};color:${color}">${label}</span>
      </td>
    </tr>`;
  }

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
                <span dir="ltr">${d.attachment_paths?.length ?? 0} / 20</span>
              </span>
            </button>
          </td>
          <td class="table-cell">
            <button type="button" class="btn-danger text-xs px-2 py-1 dashboard-doc-delete"
              data-archive-tab="${archiveTab}" data-doc-id="${d.id}">حذف</button>
          </td>
        </tr>`)
      .join("") || `<tr><td colspan="6" class="table-cell text-center text-gray-500">${emptyLabel}</td></tr>`;
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

    <!-- Document alerts -->
    ${documentAlerts.length > 0 ? `
    <div class="card" style="border-color:#dc262640">
      <button id="document-alerts-toggle" type="button"
        style="width:100%;display:flex;align-items:center;justify-content:space-between;gap:12px;background:transparent;border:0;padding:0;cursor:pointer;text-align:right">
        <span class="section-title mb-0" style="color:#dc2626">تنبيهات المستمسكات — منتهية أو قريبة النفاذ</span>
        <span style="display:flex;align-items:center;gap:8px">
          <span class="badge badge-red">${documentAlerts.length}</span>
          <span id="document-alerts-toggle-icon" style="color:#f3f4f6;font-size:18px;line-height:1">⌄</span>
        </span>
      </button>
      <div id="document-alerts-dropdown" class="hidden" style="margin-top:14px">
        <table class="w-full">
          <thead><tr>
            <th class="table-header">الموظف</th>
            <th class="table-header">الرقم الوظيفي</th>
            <th class="table-header">اسم المستمسك</th>
            <th class="table-header">تاريخ النفاذ</th>
            <th class="table-header">المتبقي</th>
          </tr></thead>
          <tbody>${documentAlerts.map(a => alertRow({
            name: a.employeeName,
            num: a.employeeNumber,
            type: a.documentName,
            date: a.expiryDate,
            days: a.days,
            expired: a.expired,
          }, "المستمسك")).join("")}</tbody>
        </table>
      </div>
    </div>` : ""}

    <!-- Contract alerts -->

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
            <th class="table-header">إجراء</th>
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
            <th class="table-header">إجراء</th>
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
  container.querySelectorAll(".dashboard-doc-delete").forEach(button => {
    button.addEventListener("click", async event => {
      event.stopPropagation();
      if (!(await confirmAction("تأكيد حذف الوثيقة؟"))) return;
      try {
        const id = parseInt(button.dataset.docId, 10);
        if (button.dataset.archiveTab === "outgoing") await api.deleteOutgoingDoc(id);
        else await api.deleteGeneralDoc(id);
        ctx.showToast("تم حذف الوثيقة");
        await renderDashboard(container, user, ctx);
      } catch (error) {
        ctx.showToast(error?.message ?? "تعذر حذف الوثيقة", "error");
      }
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
  container.querySelector("#document-alerts-toggle")?.addEventListener("click", () => {
    const dropdown = container.querySelector("#document-alerts-dropdown");
    const icon = container.querySelector("#document-alerts-toggle-icon");
    dropdown?.classList.toggle("hidden");
    if (icon) icon.textContent = dropdown?.classList.contains("hidden") ? "⌄" : "⌃";
  });
}
