import { api } from "../api.js";
import { escHtml } from "../utils.js";
import { roleLabels } from "../permissions.js";

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
        <td class="table-cell text-xs">${escHtml(log.details ?? "")}</td>
      </tr>`).join("") || `<tr><td colspan="7" class="table-cell text-center text-gray-500">لا توجد سجلات</td></tr>`}</tbody>
    </table>
  </div>`;
}
