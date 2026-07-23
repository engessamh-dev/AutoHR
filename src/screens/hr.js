import { api } from "../api.js";
import { can } from "../permissions.js";
import { escHtml, formatDate, showToast, confirmAction } from "../utils.js";

const tabs = [
  ["dashboard", "لوحة HR"],
  ["profile", "ملف الموظف"],
  ["grades", "إعداد الدرجة/المرحلة"],
];

const statusLabels = {
  "Not due": "غير مستحق",
  "Due within 6 months": "مستحق خلال 6 أشهر",
  "Due within 3 months": "مستحق خلال 3 أشهر",
  "Due within 1 month": "مستحق خلال شهر",
  "Due now": "مستحق الآن",
  "Overdue": "متأخر",
  "Blocked / missing data": "بيانات ناقصة",
};

function value(v) {
  return v === null || v === undefined || v === "" ? "—" : String(v);
}

function dateValue(v) {
  return v ? formatDate(v) : "—";
}

function boolText(v) {
  return v ? "نعم" : "لا";
}

function statusText(status) {
  return statusLabels[status] ?? status ?? "—";
}

function typeText(type) {
  return type === "promotion" ? "ترقية" : "علاوة";
}

function nextText(row) {
  return row.next_label || row.next_grade || row.next_step || "—";
}

function input(name, label, current = "", type = "text", attrs = "") {
  return `<label class="space-y-1 text-sm">
    <span class="text-gray-400">${label}</span>
    <input name="${name}" type="${type}" value="${escHtml(current ?? "")}" class="input-field" ${attrs} />
  </label>`;
}

function select(name, label, options, selected = "") {
  return `<label class="space-y-1 text-sm">
    <span class="text-gray-400">${label}</span>
    <select name="${name}" class="input-field">
      ${options.map(([v, t]) => `<option value="${escHtml(v)}" ${String(selected ?? "") === String(v) ? "selected" : ""}>${escHtml(t)}</option>`).join("")}
    </select>
  </label>`;
}

function textarea(name, label, current = "") {
  return `<label class="space-y-1 text-sm md:col-span-2">
    <span class="text-gray-400">${label}</span>
    <textarea name="${name}" class="input-field min-h-[78px]">${escHtml(current ?? "")}</textarea>
  </label>`;
}

function checkbox(name, label, checked = false) {
  return `<label class="flex items-center gap-2 text-sm text-gray-300">
    <input name="${name}" type="checkbox" ${checked ? "checked" : ""} style="width:16px;height:16px;accent-color:#5da12c" />
    <span>${label}</span>
  </label>`;
}

function numberOrNull(v) {
  return v === "" || v === null || v === undefined ? null : Number(v);
}

function textOrNull(v) {
  const value = String(v ?? "").trim();
  return value ? value : null;
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function statusBadge(status) {
  const color = status === "Overdue" ? "badge-red"
    : status === "Due now" || status === "Due within 1 month" ? "badge-yellow"
    : status === "Blocked / missing data" ? "badge-gray"
    : "badge-green";
  return `<span class="badge ${color}">${escHtml(statusText(status))}</span>`;
}

function renderTabs(active) {
  return `<div class="flex gap-2 flex-wrap">
    ${tabs.map(([key, label]) => `<button type="button" class="hr-tab btn-secondary text-xs px-3 py-2 ${key === active ? "active" : ""}" data-tab="${key}">${label}</button>`).join("")}
  </div>`;
}

function calcRows(rows) {
  return rows.map(row => `<tr class="table-row hr-profile-row" data-employee-id="${row.employee_id}">
    <td class="table-cell font-medium">${escHtml(row.full_name)}</td>
    <td class="table-cell">${escHtml(row.department ?? "—")}</td>
    <td class="table-cell">${escHtml(row.current_grade ?? "—")}</td>
    <td class="table-cell">${escHtml(row.current_step ?? "—")}</td>
    <td class="table-cell">${typeText(row.calculation_type)}</td>
    <td class="table-cell">${dateValue(row.final_due_date)}</td>
    <td class="table-cell">${statusBadge(row.status)}</td>
    <td class="table-cell">${escHtml(nextText(row))}</td>
  </tr>`).join("") || `<tr><td colspan="8" class="table-cell text-center text-gray-500">لا توجد بيانات</td></tr>`;
}

async function exportHrReport(rows = null) {
  const reportRows = rows ?? await api.calculateHrAll();
  const { save } = await import("@tauri-apps/plugin-dialog");
  const destination = await save({
    title: "حفظ تقرير HR",
    defaultPath: `hr-report-${new Date().toISOString().slice(0, 10)}.xlsx`,
    filters: [{ name: "Excel", extensions: ["xlsx"] }],
  });
  if (!destination) return;
  await api.saveReportXlsx(
    destination,
    ["الموظف", "القسم", "الدرجة الحالية", "المرحلة الحالية", "النوع", "تاريخ الاستحقاق", "الحالة", "التالي"],
    reportRows.map(row => [
      row.full_name,
      row.department ?? "",
      row.current_grade ?? "",
      String(row.current_step ?? ""),
      typeText(row.calculation_type),
      row.final_due_date ?? "",
      statusText(row.status),
      nextText(row),
    ]),
  );
  showToast("تم تصدير تقرير HR");
}

async function renderDashboard(container, state) {
  const summary = await api.hrDashboardSummary();
  const allRows = [...summary.promotions, ...summary.allowances];
  const upcoming = [...summary.promotions, ...summary.allowances]
    .filter(row => ["Due within 6 months", "Due within 3 months", "Due within 1 month", "Due now", "Overdue", "Blocked / missing data"].includes(row.status));
  container.querySelector("#hr-content").innerHTML = `
    <div class="space-y-4">
      <div class="grid grid-cols-2 xl:grid-cols-5 gap-4">
        <div class="stat-card"><span class="stat-value">${summary.promotion_due_6_months}</span><span class="stat-label">ترقيات خلال 6 أشهر</span></div>
        <div class="stat-card"><span class="stat-value">${summary.overdue_promotions}</span><span class="stat-label">ترقيات متأخرة</span></div>
        <div class="stat-card"><span class="stat-value">${summary.allowance_due_6_months ?? 0}</span><span class="stat-label">علاوات خلال 6 أشهر</span></div>
        <div class="stat-card"><span class="stat-value">${summary.overdue_allowances ?? 0}</span><span class="stat-label">علاوات متأخرة</span></div>
        <div class="stat-card"><span class="stat-value">${summary.missing_hr_data}</span><span class="stat-label">موظفون ببيانات ناقصة</span></div>
      </div>
      <div class="card overflow-auto">
        <div class="flex items-center justify-between mb-3 gap-3 flex-wrap">
          <p class="section-title mb-0">تنبيهات الاستحقاق</p>
          <div class="flex items-center gap-2">
            <button type="button" id="hr-export" class="btn-primary text-xs px-3 py-1">تصدير Excel</button>
            <button type="button" id="hr-refresh" class="btn-secondary text-xs px-3 py-1">إعادة احتساب</button>
          </div>
        </div>
        <table class="w-full">
          <thead><tr>
            <th class="table-header">الموظف</th>
            <th class="table-header">القسم</th>
            <th class="table-header">الدرجة</th>
            <th class="table-header">المرحلة</th>
            <th class="table-header">النوع</th>
            <th class="table-header">تاريخ الاستحقاق</th>
            <th class="table-header">الحالة</th>
            <th class="table-header">التالي</th>
          </tr></thead>
          <tbody>${calcRows(upcoming)}</tbody>
        </table>
      </div>
    </div>`;
  container.querySelector("#hr-refresh").addEventListener("click", async () => {
    await api.calculateHrAll();
    showToast("تم تحديث تنبيهات HR");
    await renderDashboard(container, state);
  });
  container.querySelector("#hr-export").addEventListener("click", () => exportHrReport(allRows));
  container.querySelectorAll(".hr-profile-row").forEach(row => row.addEventListener("click", () => {
    state.employeeId = Number(row.dataset.employeeId);
    renderTab(container, state, "profile");
  }));
}

async function renderProfile(container, state) {
  const [profiles, employees] = await Promise.all([api.listHrProfiles(), api.listEmployees()]);
  state.employeeId ||= profiles[0]?.employee_id || employees[0]?.id;
  const profile = profiles.find(item => item.employee_id === state.employeeId) || profiles[0];
  container.querySelector("#hr-content").innerHTML = `
    <div class="grid grid-cols-1 xl:grid-cols-[320px_1fr] gap-4">
      <aside class="card overflow-auto" style="max-height:calc(100vh - 220px)">
        <input id="hr-search" class="input-field mb-3" placeholder="بحث عن موظف" />
        <div id="hr-list" class="space-y-1">
          ${profiles.map(item => `<button type="button" class="nav-item ${item.employee_id === state.employeeId ? "active" : ""}" data-employee-id="${item.employee_id}">
            ${escHtml(item.full_name)}
            <span class="block text-xs text-gray-500">${escHtml(item.employee_number ?? "—")}</span>
          </button>`).join("")}
        </div>
      </aside>
      <main class="space-y-4">
        ${profile ? profileForm(profile) : `<div class="card text-gray-500">لا يوجد موظفون.</div>`}
        ${profile ? await profileCalculations(profile.employee_id) : ""}
      </main>
    </div>`;
  container.querySelector("#hr-search")?.addEventListener("input", event => {
    const q = event.target.value.trim();
    container.querySelectorAll("#hr-list .nav-item").forEach(button => {
      button.classList.toggle("hidden", q && !button.textContent.includes(q));
    });
  });
  container.querySelectorAll("#hr-list .nav-item").forEach(button => button.addEventListener("click", () => {
    state.employeeId = Number(button.dataset.employeeId);
    renderProfile(container, state);
  }));
  container.querySelector("#hr-profile-form")?.addEventListener("submit", async event => {
    event.preventDefault();
    const data = formData(event.currentTarget);
    await api.saveHrProfile({
      employee_id: Number(data.employee_id),
      current_salary_grade: textOrNull(data.current_salary_grade),
      current_salary_step: numberOrNull(data.current_salary_step),
      last_promotion_date: textOrNull(data.last_promotion_date),
      last_allowance_date: textOrNull(data.last_allowance_date),
      service_status: textOrNull(data.service_status),
      notes: textOrNull(data.notes),
    });
    showToast("تم حفظ بيانات HR");
    await renderProfile(container, state);
  });
}

function profileForm(profile) {
  return `<form id="hr-profile-form" class="card space-y-4">
    <input type="hidden" name="employee_id" value="${profile.employee_id}" />
    <div class="flex items-center justify-between gap-3">
      <div>
        <p class="section-title mb-1">${escHtml(profile.full_name)}</p>
        <p class="text-xs text-gray-500">${escHtml(profile.employee_number ?? "—")} / ${escHtml(profile.department ?? "—")}</p>
      </div>
      <button type="submit" class="btn-primary px-4 py-2">حفظ</button>
    </div>
    <div class="grid md:grid-cols-2 gap-3">
      ${input("current_salary_grade", "الدرجة الحالية", profile.current_salary_grade)}
      ${input("current_salary_step", "المرحلة الحالية", profile.current_salary_step, "number", "min='0'")}
      ${input("last_promotion_date", "تاريخ آخر ترقية", profile.last_promotion_date, "date")}
      ${input("last_allowance_date", "تاريخ آخر علاوة", profile.last_allowance_date, "date")}
      ${input("service_status", "حالة الخدمة", profile.service_status)}
      ${textarea("notes", "ملاحظات", profile.notes)}
    </div>
  </form>`;
}

async function profileCalculations(employeeId) {
  const rows = await api.calculateHrEmployee(employeeId).catch(() => []);
  return `<div class="card overflow-auto">
    <p class="section-title">نتيجة الاستحقاق</p>
    <table class="w-full">
      <thead><tr><th class="table-header">النوع</th><th class="table-header">تاريخ الاستحقاق</th><th class="table-header">الحالة</th><th class="table-header">التالي</th></tr></thead>
      <tbody>${rows.map(row => `<tr class="table-row">
        <td class="table-cell">${typeText(row.calculation_type)}</td>
        <td class="table-cell">${dateValue(row.final_due_date)}</td>
        <td class="table-cell">${statusBadge(row.status)}</td>
        <td class="table-cell">${escHtml(nextText(row))}</td>
      </tr>`).join("") || `<tr><td colspan="4" class="table-cell text-center text-gray-500">لا توجد نتيجة</td></tr>`}</tbody>
    </table>
  </div>`;
}

async function renderGradeConfig(container) {
  const rows = await api.listHrSalaryScales();
  const grades = [...new Set(rows.map(row => row.grade).filter(Boolean))];
  const defaultGrade = grades[0] ?? "";
  container.querySelector("#hr-content").innerHTML = `
    <div class="space-y-4">
      ${gradeForm()}
      <div class="card">
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p class="section-title mb-1">الإعدادات الحالية</p>
            <p class="text-sm text-gray-500">${rows.length} إعداد محفوظ. الجدول مخفي لتبقى الشاشة أبسط.</p>
          </div>
          <div class="flex items-center gap-2 flex-wrap">
            ${grades.length ? `<select id="hr-grade-filter" class="input-field w-auto min-w-[180px]">
              ${grades.map(grade => `<option value="${escHtml(grade)}" ${grade === defaultGrade ? "selected" : ""}>${escHtml(grade)}</option>`).join("")}
            </select>` : ""}
            <button type="button" id="hr-toggle-grade-list" class="btn-secondary px-4 py-2">عرض الإعدادات</button>
          </div>
        </div>
        <div id="hr-grade-list" class="hidden mt-4 overflow-auto"></div>
      </div>
    </div>`;

  const list = container.querySelector("#hr-grade-list");
  const filter = container.querySelector("#hr-grade-filter");
  const paintGradeList = () => {
    const selectedGrade = filter?.value ?? "";
    const visibleRows = selectedGrade ? rows.filter(row => row.grade === selectedGrade) : rows;
    list.innerHTML = gradeSettingsTable(visibleRows);
    list.querySelectorAll(".hr-delete-grade").forEach(button => button.addEventListener("click", async () => {
      if (!(await confirmAction("تأكيد حذف هذا الإعداد؟"))) return;
      await api.deleteHrSalaryScale(Number(button.dataset.id));
      await renderGradeConfig(container);
    }));
  };
  paintGradeList();
  filter?.addEventListener("change", paintGradeList);
  container.querySelector("#hr-toggle-grade-list").addEventListener("click", event => {
    const isHidden = list.classList.toggle("hidden");
    event.currentTarget.textContent = isHidden ? "عرض الإعدادات" : "إخفاء الإعدادات";
  });

  container.querySelector("#hr-grade-form").addEventListener("submit", async event => {
    event.preventDefault();
    const data = formData(event.currentTarget);
    await api.saveHrSalaryScale(null, {
      rule_name: "simple_grade_step",
      grade: data.grade,
      step: Number(data.step),
      steps_per_grade: numberOrNull(data.steps_per_grade),
      required_promotion_months: numberOrNull(data.required_promotion_months),
      allowance_period_months: numberOrNull(data.allowance_period_months),
      promotion_target_grade: textOrNull(data.promotion_target_grade),
      allowance_next_step: numberOrNull(data.allowance_next_step),
      effective_from: "2000-01-01",
      rule_version: "simple",
      active: Boolean(data.active),
    });
    showToast("تم حفظ إعداد الدرجة/المرحلة");
    await renderGradeConfig(container);
  });
}

function gradeSettingsTable(rows) {
  return `<table class="w-full">
    <thead><tr>
      <th class="table-header">الدرجة</th>
      <th class="table-header">المرحلة</th>
      <th class="table-header">ترقية بعد</th>
      <th class="table-header">علاوة بعد</th>
      <th class="table-header">التالي</th>
      <th class="table-header">فعال</th>
      <th class="table-header"></th>
    </tr></thead>
    <tbody>${rows.map(row => `<tr class="table-row">
      <td class="table-cell">${escHtml(row.grade)}</td>
      <td class="table-cell">${row.step}</td>
      <td class="table-cell">${value(row.required_promotion_months)} شهر</td>
      <td class="table-cell">${value(row.allowance_period_months)} شهر</td>
      <td class="table-cell">${escHtml(row.promotion_target_grade ?? "—")} / ${escHtml(row.allowance_next_step ?? "آخر مرحلة")}</td>
      <td class="table-cell">${boolText(row.active)}</td>
      <td class="table-cell"><button type="button" class="btn-danger text-xs px-2 py-1 hr-delete-grade" data-id="${row.id}">حذف</button></td>
    </tr>`).join("") || `<tr><td colspan="7" class="table-cell text-center text-gray-500">لا توجد إعدادات</td></tr>`}</tbody>
  </table>`;
}

function gradeForm() {
  return `<form id="hr-grade-form" class="card space-y-3">
    <div class="grid md:grid-cols-4 gap-3">
      ${input("grade", "الدرجة", "", "text", "required")}
      ${input("step", "المرحلة", "", "number", "required min='0'")}
      ${input("required_promotion_months", "ترقية بعد / شهر", "", "number", "required min='0'")}
      ${input("allowance_period_months", "علاوة بعد / شهر", "12", "number", "required min='1'")}
      ${input("promotion_target_grade", "الدرجة التالية")}
      ${input("allowance_next_step", "المرحلة التالية", "", "number", "min='0'")}
      ${input("steps_per_grade", "آخر مرحلة", "", "number", "min='0'")}
      <div class="flex items-end">${checkbox("active", "فعال", true)}</div>
    </div>
    <div class="flex justify-end"><button type="submit" class="btn-primary px-4 py-2">حفظ الإعداد</button></div>
  </form>`;
}

async function renderTab(container, state, tab) {
  if (tab === "reports") tab = "dashboard";
  state.tab = tab;
  container.querySelector("#hr-tabs").innerHTML = renderTabs(tab);
  container.querySelectorAll(".hr-tab").forEach(button => {
    button.addEventListener("click", () => renderTab(container, state, button.dataset.tab));
  });
  if (tab === "dashboard") return renderDashboard(container, state);
  if (tab === "profile") return renderProfile(container, state);
  if (tab === "grades") return renderGradeConfig(container, state);
}

export async function renderHr(container, user, ctx = {}) {
  if (!can(user, "hr.dashboard.view")) {
    container.innerHTML = `<div class="card text-autohr-red">غير مصرح</div>`;
    return;
  }
  window.autohrCanLeaveCurrentScreen = null;
  const state = { tab: ctx.hrTab === "reports" ? "dashboard" : (ctx.hrTab || "dashboard"), employeeId: ctx.employeeId || null };
  container.innerHTML = `<div class="space-y-4"><div id="hr-tabs"></div><div id="hr-content"></div></div>`;
  await renderTab(container, state, state.tab);
}
