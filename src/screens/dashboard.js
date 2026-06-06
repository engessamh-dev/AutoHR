/**
 * dashboard.js — GCANS v2.0
 * Stats + expiry alerts (badges) + contract renewal warnings
 */
import { api }        from "../api.js";
import { formatDate } from "../utils.js";

export async function renderDashboard(container, user, ctx) {
  const employees = await api.listEmployees();
  const active    = employees.filter(e => e.is_active);
  const inactive  = employees.filter(e => !e.is_active);

  const today     = new Date();
  const in30      = new Date(); in30.setDate(today.getDate() + 30);

  function isExpiringSoon(dateStr) {
    if (!dateStr) return false;
    const d = new Date(dateStr);
    return !isNaN(d) && d >= today && d <= in30;
  }
  function isExpired(dateStr) {
    if (!dateStr) return false;
    const d = new Date(dateStr);
    return !isNaN(d) && d < today;
  }
  function daysLeft(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    if (isNaN(d)) return null;
    return Math.ceil((d - today) / 86400000);
  }

  // Badge alerts
  const badgeAlerts = [];
  active.forEach(e => {
    if (isExpiringSoon(e.airport_badge_expiry) || isExpired(e.airport_badge_expiry)) {
      const days = daysLeft(e.airport_badge_expiry);
      badgeAlerts.push({ name: e.full_name, num: e.employee_number, type: "باج المطار",
        date: e.airport_badge_expiry, days, expired: days !== null && days < 0 });
    }
    if (isExpiringSoon(e.ministry_badge_expiry) || isExpired(e.ministry_badge_expiry)) {
      const days = daysLeft(e.ministry_badge_expiry);
      badgeAlerts.push({ name: e.full_name, num: e.employee_number, type: "باج الوزارة",
        date: e.ministry_badge_expiry, days, expired: days !== null && days < 0 });
    }
  });

  // Dept breakdown
  const deptMap = {};
  active.forEach(e => { const d = e.department || "غير محدد"; deptMap[d] = (deptMap[d]||0)+1; });

  function alertRow(a, typeLabel = "") {
    const color  = a.expired ? "#dc2626" : "#d97706";
    const bg     = a.expired ? "#dc262615" : "#d9770615";
    const label  = a.expired ? "منتهي" : `${a.days} يوم`;
    return `<tr style="border-bottom:1px solid #2d2d2d">
      <td class="table-cell font-medium">${a.name}</td>
      <td class="table-cell" dir="ltr">${a.num ?? "—"}</td>
      ${typeLabel ? `<td class="table-cell">${a.type ?? typeLabel}</td>` : ""}
      <td class="table-cell">${formatDate(a.date)}</td>
      <td class="table-cell">
        <span style="padding:2px 10px;border-radius:999px;font-size:12px;font-weight:700;
          background:${bg};color:${color}">${label}</span>
      </td>
    </tr>`;
  }

  container.innerHTML = `<div class="space-y-5">

    <!-- Stats -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">

    <!-- Badge alerts -->
    ${badgeAlerts.length > 0 ? `
    <div class="card" style="border-color:#dc262640">
      <p class="section-title" style="color:#dc2626">⚠️ تنبيهات الباجات — منتهية أو تنتهي خلال 30 يوم</p>
      <table class="w-full">
        <thead><tr>
          <th class="table-header">الموظف</th>
          <th class="table-header">الرقم الوظيفي</th>
          <th class="table-header">نوع الباج</th>
          <th class="table-header">تاريخ الانتهاء</th>
          <th class="table-header">المتبقي</th>
        </tr></thead>
        <tbody>${badgeAlerts.map(a => alertRow(a, "نوع")).join("")}</tbody>
      </table>
    </div>` : ""}

    <!-- Contract alerts -->

    <!-- Dept breakdown -->
    <div class="card">
      <p class="section-title">توزيع الموظفين النشطين حسب القسم</p>
      ${Object.keys(deptMap).length === 0
        ? `<p class="text-gray-500 text-sm text-center py-4">لا يوجد موظفون</p>`
        : `<table class="w-full"><thead><tr>
            <th class="table-header">القسم</th>
            <th class="table-header">العدد</th>
          </tr></thead><tbody>
          ${Object.entries(deptMap).sort((a,b) => b[1]-a[1]).map(([dept, count]) => `
            <tr class="table-row">
              <td class="table-cell">${dept}</td>
              <td class="table-cell">
                <div style="display:flex;align-items:center;gap:8px">
                  <div style="flex:1;background:#2d2d2d;border-radius:999px;height:8px">
                    <div style="background:#5da12c;height:8px;border-radius:999px;width:${Math.round((count/active.length)*100)}%"></div>
                  </div>
                  <span style="font-size:12px;color:#9ca3af;min-width:20px">${count}</span>
                </div>
              </td>
            </tr>`).join("")}
          </tbody></table>`}
    </div>

    <!-- Recent employees -->
    <div class="card">
      <p class="section-title">آخر الموظفين المضافين</p>
      <table class="w-full">
        <thead><tr>
          <th class="table-header">الاسم</th>
          <th class="table-header">الرقم الوظيفي</th>
          <th class="table-header">العنوان الوظيفي</th>
          <th class="table-header">تاريخ المباشرة</th>
        </tr></thead>
        <tbody>
          ${active.slice(-5).reverse().map(e => `
            <tr class="table-row">
              <td class="table-cell font-medium text-gray-100">${e.full_name}</td>
              <td class="table-cell" dir="ltr">${e.employee_number ?? "—"}</td>
              <td class="table-cell">${e.job_title ?? "—"}</td>
              <td class="table-cell">${formatDate(e.hire_date)}</td>
            </tr>`).join("") ||
            `<tr><td colspan="4" class="table-cell text-center text-gray-500">لا يوجد موظفون</td></tr>`}
        </tbody>
      </table>
    </div>
  </div>`;
}
