import { api } from "../api.js";
import { escHtml, formatDate } from "../utils.js";

const DAY_MS = 86400000;

const expiringDocuments = [
  { field: "civil_id_expiry_date", type: "البطاقة الوطنية", maxDays: 30 },
  { field: "passport_expiry_date", type: "جواز السفر", maxDays: 183 },
  { field: "airport_badge_expiry", type: "باج دخول مطار بغداد", maxDays: 30 },
  { field: "ministry_badge_expiry", type: "هوية وزارة النقل", maxDays: 30 },
  { field: "vehicle_annual_expiry_date", type: "سنوية المركبة", maxDays: 30 },
];

function parseDate(dateStr) {
  if (!dateStr) return null;
  const match = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
  const date = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : new Date(dateStr);
  return isNaN(date) ? null : date;
}

function daysLeft(dateStr, today = new Date()) {
  const date = parseDate(dateStr);
  if (!date) return null;
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.ceil((date - todayStart) / DAY_MS);
}

export function buildDocumentAlerts(employees, today = new Date()) {
  const alerts = [];
  employees.filter(e => e.is_active).forEach(employee => {
    expiringDocuments.forEach(documentType => {
      const days = daysLeft(employee[documentType.field], today);
      if (days === null || days > documentType.maxDays) return;
      alerts.push({
        employeeName: employee.full_name,
        employeeNumber: employee.employee_number,
        documentName: documentType.type,
        expiryDate: employee[documentType.field],
        days,
        expired: days < 0,
      });
    });
  });
  return alerts.sort((a, b) => a.days - b.days);
}

function remainingLabel(alert) {
  if (alert.expired) return "منتهي";
  if (alert.days === 0) return "ينتهي اليوم";
  return `${alert.days} يوم`;
}

function alertBadge(alert) {
  const cls = alert.expired ? "badge-red" : alert.days <= 7 ? "badge-amber" : "badge-gray";
  return `<span class="badge ${cls}">${remainingLabel(alert)}</span>`;
}

function alertRows(alerts) {
  return alerts.map(alert => `
    <tr class="table-row">
      <td class="table-cell font-medium text-gray-100">${escHtml(alert.employeeName)}</td>
      <td class="table-cell" dir="ltr">${escHtml(alert.employeeNumber || "—")}</td>
      <td class="table-cell">${escHtml(alert.documentName)}</td>
      <td class="table-cell">${formatDate(alert.expiryDate)}</td>
      <td class="table-cell">${alertBadge(alert)}</td>
    </tr>`).join("");
}

export async function renderDocumentAlerts(container, user, ctx) {
  const employees = await api.listEmployees();
  const alerts = buildDocumentAlerts(employees);
  const expiredCount = alerts.filter(alert => alert.expired).length;
  const passportCount = alerts.filter(alert => alert.documentName === "جواز السفر").length;

  container.innerHTML = `
    <div class="space-y-5">
      <div class="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p class="section-title mb-1">تنبيهات المستمسكات</p>
          <p class="text-sm text-gray-500">المستمسكات المنتهية أو التي قاربت على النفاذ</p>
        </div>
        <button id="btn-back-dashboard" type="button" class="btn-secondary">العودة للوحة التحكم</button>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div class="stat-card"><span class="stat-value">${alerts.length}</span><span class="stat-label">إجمالي التنبيهات</span></div>
        <div class="stat-card"><span class="stat-value">${expiredCount}</span><span class="stat-label">مستمسكات منتهية</span></div>
        <div class="stat-card"><span class="stat-value">${passportCount}</span><span class="stat-label">تنبيهات الجوازات</span></div>
      </div>

      <div class="card overflow-auto">
        <table class="w-full">
          <thead><tr>
            <th class="table-header">الموظف</th>
            <th class="table-header">الرقم الوظيفي</th>
            <th class="table-header">اسم المستمسك</th>
            <th class="table-header">تاريخ النفاذ</th>
            <th class="table-header">المتبقي</th>
          </tr></thead>
          <tbody>
            ${alerts.length
              ? alertRows(alerts)
              : `<tr><td colspan="5" class="table-cell text-center text-gray-500">لا توجد تنبيهات مستمسكات حاليًا</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>`;

  container.querySelector("#btn-back-dashboard")?.addEventListener("click", () => ctx.navigateTo("dashboard"));
}
