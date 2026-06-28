import { api } from "../api.js";
import { can } from "../permissions.js";
import { escHtml, formatDate, showToast, confirmAction } from "../utils.js";

const tabs = [
  ["dashboard", "لوحة HR"],
  ["profile", "ملف الموظف"],
  ["salary", "سلم الرواتب"],
  ["rules", "القواعد"],
  ["appreciations", "كتب الشكر"],
  ["penalties", "العقوبات"],
  ["interruptions", "انقطاعات الخدمة"],
  ["reports", "التقارير"],
  ["audit", "سجل التدقيق"],
];

function value(v) {
  return v === null || v === undefined || v === "" ? "—" : String(v);
}

function dateValue(v) {
  return v ? formatDate(v) : "—";
}

function boolText(v) {
  return v ? "نعم" : "لا";
}

const statusLabels = {
  "Not due": "غير مستحق",
  "Due within 6 months": "مستحق خلال 6 أشهر",
  "Due within 3 months": "مستحق خلال 3 أشهر",
  "Due within 1 month": "مستحق خلال شهر",
  "Due now": "مستحق الآن",
  "Overdue": "متأخر",
  "Blocked / missing data": "محجوب / بيانات ناقصة",
};

const calculationTypeLabels = {
  promotion: "ترقية",
  allowance: "علاوة",
};

function statusText(status) {
  return statusLabels[status] ?? status ?? "—";
}

function calculationTypeText(type) {
  return calculationTypeLabels[type] ?? type ?? "—";
}

function localizedEffect(value) {
  if (value === "excluded") return "مستبعد";
  if (value === "counted") return "محتسب";
  return value;
}

function localizeHrText(text) {
  if (!text) return "";
  return String(text)
    .replace(/^Configured period from rule (.+)$/u, "المدة المطلوبة حسب القاعدة $1")
    .replace(/^Appreciation (.+)$/u, "كتاب شكر $1")
    .replace(/^Penalty (.+)$/u, "عقوبة $1")
    .replace(/^Service interruption (.+)$/u, "انقطاع خدمة $1")
    .replace(/^grade (.+) \/ step (.+)$/u, "الدرجة $1 / المرحلة $2")
    .replace("Ignored: not marked for this calculation or already disabled", "غير محتسب: غير مؤثر في هذا الحساب أو تم تعطيله")
    .replace("Ignored: cancelled/revoked or does not affect this calculation", "غير محتسب: ملغى أو لا يؤثر في هذا الحساب")
    .replace("Ignored: counted service or does not affect this calculation", "غير محتسب: خدمة محتسبة أو لا تؤثر في هذا الحساب")
    .replace("Missing last promotion date", "تاريخ آخر ترقية غير مدخل")
    .replace("Missing last allowance date", "تاريخ آخر علاوة غير مدخل")
    .replace("Missing current salary grade", "الدرجة الحالية غير مدخلة")
    .replace("Missing current salary step", "المرحلة الحالية غير مدخلة")
    .replace("No active salary scale rule for employee grade/step/date", "لا توجد قاعدة سلم رواتب فعالة للدرجة/المرحلة/التاريخ")
    .replace("Missing configured required period", "مدة الاستحقاق غير مضبوطة في القاعدة");
}

function input(name, label, value = "", type = "text", attrs = "") {
  return `<label class="space-y-1 text-sm">
    <span class="text-gray-400">${label}</span>
    <input name="${name}" type="${type}" value="${escHtml(value ?? "")}" class="input-field" ${attrs} />
  </label>`;
}

function textarea(name, label, value = "", attrs = "") {
  return `<label class="space-y-1 text-sm">
    <span class="text-gray-400">${label}</span>
    <textarea name="${name}" class="input-field min-h-[78px]" ${attrs}>${escHtml(value ?? "")}</textarea>
  </label>`;
}

function checkbox(name, label, checked = false) {
  return `<label class="flex items-center gap-2 text-sm text-gray-300">
    <input name="${name}" type="checkbox" ${checked ? "checked" : ""} style="width:16px;height:16px;accent-color:#5da12c" />
    <span>${label}</span>
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

function numberOrNull(value) {
  return value === "" || value === null || value === undefined ? null : Number(value);
}

function textOrNull(value) {
  const v = String(value ?? "").trim();
  return v ? v : null;
}

function documentRefsText(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.filter(Boolean).join("\n") : String(value ?? "");
  } catch {
    return String(value ?? "");
  }
}

function documentRefsJson(value) {
  const refs = String(value ?? "")
    .split(/\r?\n/)
    .map(item => item.trim())
    .filter(Boolean);
  return JSON.stringify(refs);
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

function availableTabs(user) {
  return tabs.filter(([key]) => {
    if (key === "salary" || key === "rules") return can(user, "hr.rules.view");
    if (key === "reports") return can(user, "hr.reports.view");
    if (key === "audit") return can(user, "audit.view");
    return can(user, "hr.employees.view") || key === "dashboard";
  });
}

function renderTabs(active, user) {
  return `<div class="flex gap-2 flex-wrap">
    ${availableTabs(user).map(([key, label]) => `<button type="button" class="hr-tab btn-secondary text-xs px-3 py-2 ${key === active ? "active" : ""}" data-tab="${key}">${label}</button>`).join("")}
  </div>`;
}

function calcRows(rows) {
  return rows.map(row => `<tr class="table-row hr-calc-row" data-employee-id="${row.employee_id}">
    <td class="table-cell font-medium">${escHtml(row.full_name)}</td>
    <td class="table-cell">${escHtml(row.employee_number ?? "—")}</td>
    <td class="table-cell">${escHtml(row.current_grade ?? "—")} / ${escHtml(row.current_step ?? "—")}</td>
    <td class="table-cell">${dateValue(row.original_due_date)}</td>
    <td class="table-cell">${dateValue(row.final_due_date)}</td>
    <td class="table-cell">${dateValue(row.manual_due_date)}</td>
    <td class="table-cell">${statusBadge(row.status)}</td>
  </tr>`).join("") || `<tr><td colspan="7" class="table-cell text-center text-gray-500">لا توجد بيانات</td></tr>`;
}

async function renderDashboardTab(container, state) {
  const summary = await api.hrDashboardSummary();
  container.querySelector("#hr-content").innerHTML = `
    <div class="space-y-4">
      <div class="grid grid-cols-2 xl:grid-cols-4 gap-4">
        <div class="stat-card"><span class="stat-value">${summary.promotion_due_6_months}</span><span class="stat-label">ترقيات خلال 6 أشهر</span></div>
        <div class="stat-card"><span class="stat-value">${summary.promotion_due_3_months}</span><span class="stat-label">ترقيات خلال 3 أشهر</span></div>
        <div class="stat-card"><span class="stat-value">${summary.promotion_due_this_month}</span><span class="stat-label">ترقيات هذا الشهر</span></div>
        <div class="stat-card"><span class="stat-value">${summary.overdue_promotions}</span><span class="stat-label">ترقيات متأخرة</span></div>
        <div class="stat-card"><span class="stat-value">${summary.allowance_due}</span><span class="stat-label">علاوات مستحقة</span></div>
        <div class="stat-card"><span class="stat-value">${summary.missing_hr_data}</span><span class="stat-label">بيانات HR ناقصة</span></div>
        <div class="stat-card"><span class="stat-value">${summary.unprocessed_appreciations}</span><span class="stat-label">كتب شكر غير محتسبة</span></div>
        <div class="stat-card"><span class="stat-value">${summary.active_penalties}</span><span class="stat-label">عقوبات فعالة</span></div>
      </div>
      <div class="card overflow-auto">
        <div class="flex items-center justify-between mb-3">
          <p class="section-title mb-0">استحقاقات الترقية</p>
          <button type="button" id="hr-refresh" class="btn-secondary text-xs px-3 py-1">إعادة احتساب</button>
        </div>
        <table class="w-full">
          <thead><tr><th class="table-header">الموظف</th><th class="table-header">الرقم</th><th class="table-header">الدرجة/المرحلة</th><th class="table-header">الأصلي</th><th class="table-header">النهائي</th><th class="table-header">اليدوي</th><th class="table-header">الحالة</th></tr></thead>
          <tbody>${calcRows(summary.promotions)}</tbody>
        </table>
      </div>
    </div>`;
  container.querySelector("#hr-refresh")?.addEventListener("click", async () => {
    await api.calculateHrAll();
    showToast("تم تحديث حسابات HR");
    await renderDashboardTab(container, state);
  });
  container.querySelectorAll(".hr-calc-row").forEach(row => row.addEventListener("click", () => {
    state.employeeId = Number(row.dataset.employeeId);
    renderTab(container, state, "profile");
  }));
}

async function renderProfileTab(container, state) {
  const [profiles, employees] = await Promise.all([api.listHrProfiles(), api.listEmployees()]);
  state.employeeId ||= profiles[0]?.employee_id || employees[0]?.id;
  const profile = profiles.find(p => p.employee_id === state.employeeId) || profiles[0];
  const calculations = state.employeeId ? await api.calculateHrEmployee(state.employeeId).catch(() => []) : [];
  container.querySelector("#hr-content").innerHTML = `
    <div class="grid grid-cols-1 xl:grid-cols-[320px_1fr] gap-4">
      <aside class="card overflow-auto" style="max-height:calc(100vh - 220px)">
        <input id="hr-employee-search" class="input-field mb-3" placeholder="بحث عن موظف" />
        <div id="hr-employee-list" class="space-y-1">
          ${profiles.map(p => `<button type="button" class="nav-item ${p.employee_id === state.employeeId ? "active" : ""}" data-employee-id="${p.employee_id}">
            ${escHtml(p.full_name)}<span class="block text-xs text-gray-500">${escHtml(p.employee_number ?? "—")}</span>
          </button>`).join("")}
        </div>
      </aside>
      <main class="space-y-4">
        ${profile ? profileForm(profile) : `<div class="card text-gray-500">أضف موظفين أولا من دليل الموظفين.</div>`}
        ${calculationDetails(calculations)}
      </main>
    </div>`;
  container.querySelector("#hr-employee-search")?.addEventListener("input", e => {
    const q = e.target.value.trim();
    container.querySelectorAll("#hr-employee-list .nav-item").forEach(btn => {
      btn.classList.toggle("hidden", q && !btn.textContent.includes(q));
    });
  });
  container.querySelectorAll("#hr-employee-list .nav-item").forEach(btn => btn.addEventListener("click", () => {
    state.employeeId = Number(btn.dataset.employeeId);
    renderProfileTab(container, state);
  }));
  container.querySelector("#hr-profile-form")?.addEventListener("submit", async e => {
    e.preventDefault();
    const f = formData(e.currentTarget);
    await api.saveHrProfile({
      employee_id: Number(f.employee_id),
      certificate: textOrNull(f.certificate),
      current_salary_grade: textOrNull(f.current_salary_grade),
      current_salary_step: numberOrNull(f.current_salary_step),
      current_base_salary: numberOrNull(f.current_base_salary),
      last_promotion_date: textOrNull(f.last_promotion_date),
      last_allowance_date: textOrNull(f.last_allowance_date),
      service_status: textOrNull(f.service_status),
      linked_document_refs: documentRefsJson(f.linked_document_refs),
      manual_promotion_due_date: textOrNull(f.manual_promotion_due_date),
      promotion_override_reason: textOrNull(f.promotion_override_reason),
      promotion_approval_note: textOrNull(f.promotion_approval_note),
      promotion_override_attachment: textOrNull(f.promotion_override_attachment),
      manual_allowance_due_date: textOrNull(f.manual_allowance_due_date),
      allowance_override_reason: textOrNull(f.allowance_override_reason),
      allowance_approval_note: textOrNull(f.allowance_approval_note),
      allowance_override_attachment: textOrNull(f.allowance_override_attachment),
      notes: textOrNull(f.notes),
    });
    showToast("تم حفظ ملف HR");
    await renderProfileTab(container, state);
  });
}

function profileForm(p) {
  const editable = true;
  return `<form id="hr-profile-form" class="card space-y-4">
    <input type="hidden" name="employee_id" value="${p.employee_id}" />
    <div class="flex items-center justify-between gap-3">
      <div>
        <p class="section-title mb-1">${escHtml(p.full_name)}</p>
        <p class="text-xs text-gray-500">${escHtml(p.department ?? "—")} / ${escHtml(p.job_title ?? "—")}</p>
      </div>
      ${editable ? `<button class="btn-primary px-4 py-2" type="submit">حفظ</button>` : ""}
    </div>
    <div class="grid md:grid-cols-3 gap-3">
      ${input("certificate", "الشهادة", p.certificate ?? p.certificate)}
      ${input("current_salary_grade", "الدرجة الحالية", p.current_salary_grade)}
      ${input("current_salary_step", "المرحلة الحالية", p.current_salary_step, "number", "min='0'")}
      ${input("current_base_salary", "الراتب الاسمي", p.current_base_salary, "number", "step='0.01' min='0'")}
      ${input("last_promotion_date", "آخر ترقية", p.last_promotion_date, "date")}
      ${input("last_allowance_date", "آخر علاوة", p.last_allowance_date, "date")}
      ${input("service_status", "حالة الخدمة", p.service_status)}
      ${textarea("linked_document_refs", "مراجع الوثائق المرتبطة", documentRefsText(p.linked_document_refs))}
      ${input("notes", "ملاحظات", p.notes)}
    </div>
    <div class="grid md:grid-cols-2 gap-4">
      <section class="p-3 border border-autohr-border rounded">
        <p class="font-bold mb-3">تجاوز يدوي للترقية</p>
        <div class="grid md:grid-cols-2 gap-3">
          ${input("manual_promotion_due_date", "التاريخ المعتمد", p.manual_promotion_due_date, "date")}
          ${input("promotion_override_reason", "السبب", p.promotion_override_reason)}
          ${input("promotion_approval_note", "ملاحظة الموافقة", p.promotion_approval_note)}
          ${input("promotion_override_attachment", "مرفق الموافقة", p.promotion_override_attachment)}
        </div>
      </section>
      <section class="p-3 border border-autohr-border rounded">
        <p class="font-bold mb-3">تجاوز يدوي للعلاوة</p>
        <div class="grid md:grid-cols-2 gap-3">
          ${input("manual_allowance_due_date", "التاريخ المعتمد", p.manual_allowance_due_date, "date")}
          ${input("allowance_override_reason", "السبب", p.allowance_override_reason)}
          ${input("allowance_approval_note", "ملاحظة الموافقة", p.allowance_approval_note)}
          ${input("allowance_override_attachment", "مرفق الموافقة", p.allowance_override_attachment)}
        </div>
      </section>
    </div>
  </form>`;
}

function calculationDetails(items) {
  return `<div class="grid xl:grid-cols-2 gap-4">
    ${items.map(item => `<section class="card overflow-auto">
      <div class="flex items-center justify-between gap-3 mb-3">
        <p class="section-title mb-0">${item.calculation_type === "promotion" ? "تفاصيل الترقية" : "تفاصيل العلاوة"}</p>
        ${statusBadge(item.status)}
      </div>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm mb-4">
        <div><span class="text-gray-500 block">الأصلي</span>${dateValue(item.original_due_date)}</div>
        <div><span class="text-gray-500 block">النهائي</span>${dateValue(item.final_due_date)}</div>
        <div><span class="text-gray-500 block">التنبيه</span>${dateValue(item.alert_date)}</div>
        <div><span class="text-gray-500 block">المعتمد يدويا</span>${dateValue(item.manual_due_date)}</div>
      </div>
      ${item.notes?.length ? `<p class="text-sm text-autohr-red mb-3">${item.notes.map(localizeHrText).map(escHtml).join("، ")}</p>` : ""}
      <table class="w-full">
        <thead><tr><th class="table-header">البند</th><th class="table-header">التاريخ</th><th class="table-header">أشهر</th><th class="table-header">أيام</th><th class="table-header">احتسب</th></tr></thead>
        <tbody>${item.components.map(c => `<tr class="table-row"><td class="table-cell">${escHtml(localizeHrText(c.label))}${c.notes ? `<div class="text-xs text-gray-500">${escHtml(localizeHrText(c.notes))}</div>` : ""}</td><td class="table-cell">${dateValue(c.date)}</td><td class="table-cell">${c.months}</td><td class="table-cell">${c.days}</td><td class="table-cell">${boolText(c.counted)}</td></tr>`).join("") || `<tr><td colspan="5" class="table-cell text-center text-gray-500">لا توجد تفاصيل</td></tr>`}</tbody>
      </table>
    </section>`).join("")}
  </div>`;
}

async function renderSalaryTab(container) {
  const rows = await api.listHrSalaryScales();
  container.querySelector("#hr-content").innerHTML = `
    <div class="space-y-4">
      ${salaryForm()}
      <div class="card overflow-auto">
        <table class="w-full">
          <thead><tr><th class="table-header">الدرجة</th><th class="table-header">المرحلة</th><th class="table-header">الراتب</th><th class="table-header">العلاوة</th><th class="table-header">مدة الترقية</th><th class="table-header">نسخة</th><th class="table-header">فعال</th><th class="table-header"></th></tr></thead>
          <tbody>${rows.map(r => `<tr class="table-row"><td class="table-cell">${escHtml(r.grade)}</td><td class="table-cell">${r.step}</td><td class="table-cell">${value(r.base_salary)}</td><td class="table-cell">${value(r.annual_allowance_amount)}</td><td class="table-cell">${value(r.required_promotion_months)} شهر</td><td class="table-cell">${escHtml(r.rule_version)}</td><td class="table-cell">${boolText(r.active)}</td><td class="table-cell"><button class="btn-danger text-xs px-2 py-1 hr-delete-salary" data-id="${r.id}">حذف</button></td></tr>`).join("") || `<tr><td colspan="8" class="table-cell text-center text-gray-500">لا توجد قواعد</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;
  container.querySelector("#hr-salary-form").addEventListener("submit", async e => {
    e.preventDefault();
    const f = formData(e.currentTarget);
    await api.saveHrSalaryScale(null, {
      rule_name: textOrNull(f.rule_name),
      grade: f.grade,
      step: Number(f.step),
      base_salary: numberOrNull(f.base_salary),
      annual_allowance_amount: numberOrNull(f.annual_allowance_amount),
      steps_per_grade: numberOrNull(f.steps_per_grade),
      required_promotion_months: numberOrNull(f.required_promotion_months),
      allowance_period_months: numberOrNull(f.allowance_period_months),
      promotion_target_grade: textOrNull(f.promotion_target_grade),
      promotion_target_step: numberOrNull(f.promotion_target_step),
      effective_from: f.effective_from,
      effective_to: textOrNull(f.effective_to),
      rule_version: textOrNull(f.rule_version),
      active: Boolean(f.active),
      change_reason: textOrNull(f.change_reason),
    });
    showToast("تم حفظ قاعدة سلم الرواتب");
    await renderSalaryTab(container);
  });
  container.querySelectorAll(".hr-delete-salary").forEach(btn => btn.addEventListener("click", async () => {
    if (!(await confirmAction("تأكيد حذف قاعدة سلم الرواتب؟"))) return;
    await api.deleteHrSalaryScale(Number(btn.dataset.id));
    await renderSalaryTab(container);
  }));
}

function salaryForm() {
  return `<form id="hr-salary-form" class="card space-y-3">
    <div class="grid md:grid-cols-4 gap-3">
      ${input("rule_name", "اسم القاعدة", "salary_scale")}
      ${input("grade", "الدرجة", "", "text", "required")}
      ${input("step", "المرحلة", "", "number", "required min='0'")}
      ${input("base_salary", "الراتب الاسمي", "", "number", "step='0.01' min='0'")}
      ${input("annual_allowance_amount", "مبلغ العلاوة", "", "number", "step='0.01' min='0'")}
      ${input("steps_per_grade", "عدد المراحل", "", "number", "min='0'")}
      ${input("required_promotion_months", "مدة الترقية بالأشهر", "", "number", "min='0'")}
      ${input("allowance_period_months", "مدة العلاوة بالأشهر", "12", "number", "required min='1'")}
      ${input("promotion_target_grade", "درجة ما بعد الترقية")}
      ${input("promotion_target_step", "مرحلة ما بعد الترقية", "", "number", "min='0'")}
      ${input("effective_from", "نافذ من", new Date().toISOString().slice(0, 10), "date", "required")}
      ${input("effective_to", "نافذ إلى", "", "date")}
      ${input("rule_version", "نسخة القاعدة", "1")}
      ${input("change_reason", "سبب التغيير")}
      <div class="flex items-end">${checkbox("active", "فعال", true)}</div>
    </div>
    <div class="flex justify-end"><button class="btn-primary px-4 py-2">حفظ قاعدة</button></div>
  </form>`;
}

async function renderRulesTab(container) {
  const [appRules, penaltyRules, intRules, lead] = await Promise.all([
    api.listHrAppreciationRules(), api.listHrPenaltyRules(), api.listHrInterruptionRules(), api.getHrAlertLeadMonths(),
  ]);
  container.querySelector("#hr-content").innerHTML = `
    <div class="space-y-4">
      <form id="hr-alert-form" class="card flex items-end gap-3 flex-wrap">
        ${input("months", "مهلة التنبيه بالأشهر", lead, "number", "min='1' max='24'")}
        <button class="btn-primary px-4 py-2">حفظ</button>
      </form>
      <div class="grid xl:grid-cols-3 gap-4">
        ${rulePanel("appreciation", "قواعد كتب الشكر", appreciationRuleForm(), appRules.map(r => `${r.source_name}: ${r.credit_months}ش ${r.credit_days}ي`).join("<br>"))}
        ${rulePanel("penalty", "قواعد العقوبات", penaltyRuleForm(), penaltyRules.map(r => `${r.penalty_type}: ${r.delay_months}ش ${r.delay_days}ي`).join("<br>"))}
        ${rulePanel("interruption", "قواعد انقطاع الخدمة", interruptionRuleForm(), intRules.map(r => `${r.interruption_type}: ${r.counted_or_excluded}`).join("<br>"))}
      </div>
    </div>`;
  container.querySelector("#hr-alert-form").addEventListener("submit", async e => {
    e.preventDefault();
    await api.setHrAlertLeadMonths(Number(formData(e.currentTarget).months));
    showToast("تم حفظ مهلة التنبيه");
  });
  bindRuleForm(container, "appreciation", api.saveHrAppreciationRule, renderRulesTab);
  bindRuleForm(container, "penalty", api.saveHrPenaltyRule, renderRulesTab);
  bindRuleForm(container, "interruption", api.saveHrInterruptionRule, renderRulesTab);
}

function rulePanel(key, title, form, list) {
  return `<section class="card space-y-3">
    <p class="section-title mb-0">${title}</p>
    ${form}
    <div class="text-sm text-gray-300 border-t border-autohr-border pt-3">${list || "لا توجد قواعد"}</div>
  </section>`;
}

function appreciationRuleForm() {
  return `<form id="hr-rule-appreciation" class="space-y-2">
    ${input("source_name", "المصدر", "", "text", "required")}
    ${input("appreciation_type", "النوع")}
    <div class="grid grid-cols-2 gap-2">${input("credit_months", "أشهر", "0", "number", "min='0'")}${input("credit_days", "أيام", "0", "number", "min='0'")}</div>
    ${input("max_accumulation_days", "حد التراكم بالأيام", "", "number", "min='0'")}
    ${input("effective_from", "نافذ من", new Date().toISOString().slice(0, 10), "date", "required")}
    ${input("rule_version", "النسخة", "1")}
    ${checkbox("affects_promotion", "تؤثر على الترقية", true)}
    ${checkbox("affects_allowance", "تؤثر على العلاوة", false)}
    ${checkbox("active", "فعال", true)}
    <button class="btn-primary w-full py-2">حفظ</button>
  </form>`;
}

function penaltyRuleForm() {
  return `<form id="hr-rule-penalty" class="space-y-2">
    ${input("penalty_type", "نوع العقوبة", "", "text", "required")}
    <div class="grid grid-cols-2 gap-2">${input("delay_months", "أشهر", "0", "number", "min='0'")}${input("delay_days", "أيام", "0", "number", "min='0'")}</div>
    ${select("multiple_rule", "قاعدة التعدد", [["accumulate", "تراكم"], ["strongest_only", "الأشد فقط"]])}
    ${input("effective_from", "نافذ من", new Date().toISOString().slice(0, 10), "date", "required")}
    ${input("rule_version", "النسخة", "1")}
    ${checkbox("affects_promotion", "تؤثر على الترقية", true)}
    ${checkbox("affects_allowance", "تؤثر على العلاوة", true)}
    ${checkbox("active", "فعال", true)}
    <button class="btn-primary w-full py-2">حفظ</button>
  </form>`;
}

function interruptionRuleForm() {
  return `<form id="hr-rule-interruption" class="space-y-2">
    ${input("interruption_type", "نوع الانقطاع", "", "text", "required")}
    ${select("counted_or_excluded", "المعاملة", [["excluded", "مستبعد"], ["counted", "محتسب"]])}
    ${input("effective_from", "نافذ من", new Date().toISOString().slice(0, 10), "date", "required")}
    ${input("rule_version", "النسخة", "1")}
    ${checkbox("affects_promotion", "تؤثر على الترقية", true)}
    ${checkbox("affects_allowance", "تؤثر على العلاوة", true)}
    ${checkbox("active", "فعال", true)}
    <button class="btn-primary w-full py-2">حفظ</button>
  </form>`;
}

function bindRuleForm(container, key, saveFn, rerender) {
  container.querySelector(`#hr-rule-${key}`).addEventListener("submit", async e => {
    e.preventDefault();
    const f = formData(e.currentTarget);
    const base = {
      effective_from: f.effective_from,
      effective_to: textOrNull(f.effective_to),
      rule_version: textOrNull(f.rule_version),
      active: Boolean(f.active),
      affects_promotion: Boolean(f.affects_promotion),
      affects_allowance: Boolean(f.affects_allowance),
      change_reason: textOrNull(f.change_reason),
    };
    let data;
    if (key === "appreciation") data = { ...base, source_name: f.source_name, appreciation_type: textOrNull(f.appreciation_type), credit_months: numberOrNull(f.credit_months), credit_days: numberOrNull(f.credit_days), max_accumulation_days: numberOrNull(f.max_accumulation_days) };
    if (key === "penalty") data = { ...base, penalty_type: f.penalty_type, delay_months: numberOrNull(f.delay_months), delay_days: numberOrNull(f.delay_days), multiple_rule: f.multiple_rule };
    if (key === "interruption") data = { ...base, interruption_type: f.interruption_type, counted_or_excluded: f.counted_or_excluded };
    await saveFn(null, data);
    showToast("تم حفظ القاعدة");
    await rerender(container);
  });
}

async function renderRecordsTab(container, kind) {
  const [employees, appRows, penaltyRows, intRows] = await Promise.all([
    api.listEmployees(),
    kind === "appreciations" ? api.listHrAppreciations() : Promise.resolve([]),
    kind === "penalties" ? api.listHrPenalties() : Promise.resolve([]),
    kind === "interruptions" ? api.listHrInterruptions() : Promise.resolve([]),
  ]);
  const rows = kind === "appreciations" ? appRows : kind === "penalties" ? penaltyRows : intRows;
  container.querySelector("#hr-content").innerHTML = `
    <div class="space-y-4">
      <div class="card">${recordForm(kind, employees)}</div>
      <div class="card overflow-auto">${recordsTable(kind, rows)}</div>
    </div>`;
  container.querySelector("#hr-record-form").addEventListener("submit", async e => {
    e.preventDefault();
    const f = formData(e.currentTarget);
    if (kind === "appreciations") await api.saveHrAppreciation(null, {
      employee_id: Number(f.employee_id), letter_number: f.letter_number, letter_date: f.letter_date,
      issuing_authority: textOrNull(f.issuing_authority), appreciation_type: textOrNull(f.appreciation_type),
      credit_months: numberOrNull(f.credit_months), credit_days: numberOrNull(f.credit_days),
      affects_promotion: Boolean(f.affects_promotion), affects_allowance: Boolean(f.affects_allowance),
      used_in_calculation: Boolean(f.used_in_calculation), attachment_path: textOrNull(f.attachment_path), notes: textOrNull(f.notes),
    });
    if (kind === "penalties") await api.saveHrPenalty(null, {
      employee_id: Number(f.employee_id), penalty_order_number: f.penalty_order_number, penalty_date: f.penalty_date, penalty_type: f.penalty_type,
      delay_months: numberOrNull(f.delay_months), delay_days: numberOrNull(f.delay_days),
      affects_promotion: Boolean(f.affects_promotion), affects_allowance: Boolean(f.affects_allowance),
      cancelled: Boolean(f.cancelled), cancellation_order: textOrNull(f.cancellation_order), cancellation_date: textOrNull(f.cancellation_date),
      attachment_path: textOrNull(f.attachment_path), notes: textOrNull(f.notes),
    });
    if (kind === "interruptions") await api.saveHrInterruption(null, {
      employee_id: Number(f.employee_id), interruption_type: f.interruption_type, start_date: f.start_date, end_date: f.end_date,
      affects_promotion: Boolean(f.affects_promotion), affects_allowance: Boolean(f.affects_allowance),
      counted_or_excluded: f.counted_or_excluded, attachment_path: textOrNull(f.attachment_path), notes: textOrNull(f.notes),
    });
    showToast("تم حفظ السجل");
    await renderRecordsTab(container, kind);
  });
}

function employeeOptions(employees) {
  return employees.map(e => [e.id, `${e.full_name} - ${e.employee_number ?? "بدون رقم"}`]);
}

function recordForm(kind, employees) {
  const employeeSelect = select("employee_id", "الموظف", employeeOptions(employees));
  if (kind === "appreciations") return `<form id="hr-record-form" class="space-y-3"><div class="grid md:grid-cols-4 gap-3">
    ${employeeSelect}${input("letter_number", "رقم الكتاب", "", "text", "required")}${input("letter_date", "تاريخ الكتاب", "", "date", "required")}${input("issuing_authority", "الجهة")}
    ${input("appreciation_type", "النوع")}${input("credit_months", "أشهر", "0", "number")}${input("credit_days", "أيام", "0", "number")}${input("attachment_path", "المرفق")}
    ${input("notes", "ملاحظات")}<div class="space-y-2">${checkbox("affects_promotion", "ترقية", true)}${checkbox("affects_allowance", "علاوة", false)}${checkbox("used_in_calculation", "يحتسب", true)}</div>
  </div><button class="btn-primary px-4 py-2">حفظ</button></form>`;
  if (kind === "penalties") return `<form id="hr-record-form" class="space-y-3"><div class="grid md:grid-cols-4 gap-3">
    ${employeeSelect}${input("penalty_order_number", "رقم الأمر", "", "text", "required")}${input("penalty_date", "تاريخ العقوبة", "", "date", "required")}${input("penalty_type", "نوع العقوبة", "", "text", "required")}
    ${input("delay_months", "أشهر", "0", "number")}${input("delay_days", "أيام", "0", "number")}${input("cancellation_order", "أمر الإلغاء")}${input("cancellation_date", "تاريخ الإلغاء", "", "date")}
    ${input("attachment_path", "المرفق")}${input("notes", "ملاحظات")}<div class="space-y-2">${checkbox("affects_promotion", "ترقية", true)}${checkbox("affects_allowance", "علاوة", true)}${checkbox("cancelled", "ملغاة", false)}</div>
  </div><button class="btn-primary px-4 py-2">حفظ</button></form>`;
  return `<form id="hr-record-form" class="space-y-3"><div class="grid md:grid-cols-4 gap-3">
    ${employeeSelect}${input("interruption_type", "نوع الانقطاع", "", "text", "required")}${input("start_date", "من", "", "date", "required")}${input("end_date", "إلى", "", "date", "required")}
    ${select("counted_or_excluded", "المعاملة", [["excluded", "مستبعد"], ["counted", "محتسب"]])}${input("attachment_path", "المرفق")}${input("notes", "ملاحظات")}<div class="space-y-2">${checkbox("affects_promotion", "ترقية", true)}${checkbox("affects_allowance", "علاوة", true)}</div>
  </div><button class="btn-primary px-4 py-2">حفظ</button></form>`;
}

function recordsTable(kind, rows) {
  const title = kind === "appreciations" ? ["الكتاب", "letter_number", "letter_date"] : kind === "penalties" ? ["الأمر", "penalty_order_number", "penalty_date"] : ["النوع", "interruption_type", "start_date"];
  return `<table class="w-full"><thead><tr><th class="table-header">الموظف</th><th class="table-header">${title[0]}</th><th class="table-header">التاريخ</th><th class="table-header">الأثر</th><th class="table-header">ملاحظات</th></tr></thead>
    <tbody>${rows.map(r => `<tr class="table-row"><td class="table-cell">${escHtml(r.employee_name ?? "—")}</td><td class="table-cell">${escHtml(r[title[1]] ?? "—")}</td><td class="table-cell">${dateValue(r[title[2]])}</td><td class="table-cell">${escHtml(localizedEffect(r.credit_months ?? r.delay_months ?? r.counted_or_excluded ?? "—"))}</td><td class="table-cell">${escHtml(r.notes ?? "")}</td></tr>`).join("") || `<tr><td colspan="5" class="table-cell text-center text-gray-500">لا توجد سجلات</td></tr>`}</tbody></table>`;
}

async function renderReportsTab(container) {
  const rows = await api.calculateHrAll();
  container.querySelector("#hr-content").innerHTML = `
    <div class="card overflow-auto">
      <div class="flex justify-end mb-3"><button type="button" id="hr-export" class="btn-primary px-4 py-2">تصدير Excel</button></div>
      <table class="w-full">
        <thead><tr><th class="table-header">النوع</th><th class="table-header">الموظف</th><th class="table-header">القسم</th><th class="table-header">الأصلي</th><th class="table-header">النهائي</th><th class="table-header">الحالة</th><th class="table-header">تفسير</th></tr></thead>
        <tbody>${rows.map(r => `<tr class="table-row"><td class="table-cell">${calculationTypeText(r.calculation_type)}</td><td class="table-cell">${escHtml(r.full_name)}</td><td class="table-cell">${escHtml(r.department ?? "—")}</td><td class="table-cell">${dateValue(r.original_due_date)}</td><td class="table-cell">${dateValue(r.final_due_date)}</td><td class="table-cell">${statusBadge(r.status)}</td><td class="table-cell">${escHtml(r.notes.map(localizeHrText).join("، ") || `${r.appreciation_credit_days} يوم شكر، ${r.penalty_delay_days} يوم عقوبة، ${r.excluded_service_days} يوم انقطاع`)}</td></tr>`).join("")}</tbody>
      </table>
    </div>`;
  container.querySelector("#hr-export").addEventListener("click", async () => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const destination = await save({ title: "حفظ تقرير HR", defaultPath: `hr-report-${new Date().toISOString().slice(0, 10)}.xlsx`, filters: [{ name: "Excel", extensions: ["xlsx"] }] });
    if (!destination) return;
    await api.saveReportXlsx(destination, ["النوع", "الموظف", "القسم", "الأصلي", "النهائي", "المعتمد يدويا", "الحالة"], rows.map(r => [calculationTypeText(r.calculation_type), r.full_name, r.department ?? "", r.original_due_date ?? "", r.final_due_date ?? "", r.manual_due_date ?? "", statusText(r.status)]));
    showToast("تم تصدير تقرير HR");
  });
}

async function renderAuditTab(container) {
  const rows = (await api.listActivityLog(300)).filter(row => row.action.includes("_HR_") || row.target_type?.startsWith("hr_"));
  container.querySelector("#hr-content").innerHTML = `<div class="card overflow-auto"><table class="w-full">
    <thead><tr><th class="table-header">الوقت</th><th class="table-header">المستخدم</th><th class="table-header">الإجراء</th><th class="table-header">الكيان</th><th class="table-header">التفاصيل</th></tr></thead>
    <tbody>${rows.map(r => `<tr class="table-row"><td class="table-cell">${dateValue(r.created_at)}</td><td class="table-cell">${escHtml(r.username)}</td><td class="table-cell">${escHtml(r.action)}</td><td class="table-cell">${escHtml(r.target_type ?? "—")} #${escHtml(r.target_id ?? "")}</td><td class="table-cell">${escHtml(r.details ?? "")}</td></tr>`).join("") || `<tr><td colspan="5" class="table-cell text-center text-gray-500">لا توجد أحداث HR</td></tr>`}</tbody>
  </table></div>`;
}

async function renderTab(container, state, tab) {
  if (!availableTabs(state.user).some(([key]) => key === tab)) tab = "dashboard";
  state.tab = tab;
  container.querySelector("#hr-tabs").innerHTML = renderTabs(tab, state.user);
  container.querySelectorAll(".hr-tab").forEach(btn => btn.addEventListener("click", () => renderTab(container, state, btn.dataset.tab)));
  if (tab === "dashboard") return renderDashboardTab(container, state);
  if (tab === "profile") return renderProfileTab(container, state);
  if (tab === "salary") return renderSalaryTab(container);
  if (tab === "rules") return renderRulesTab(container);
  if (tab === "appreciations") return renderRecordsTab(container, "appreciations");
  if (tab === "penalties") return renderRecordsTab(container, "penalties");
  if (tab === "interruptions") return renderRecordsTab(container, "interruptions");
  if (tab === "reports") return renderReportsTab(container);
  if (tab === "audit") return renderAuditTab(container);
}

export async function renderHr(container, user, ctx = {}) {
  if (!can(user, "hr.dashboard.view")) {
    container.innerHTML = `<div class="card text-autohr-red">غير مصرح</div>`;
    return;
  }
  window.autohrCanLeaveCurrentScreen = null;
  const state = { tab: ctx.hrTab || "dashboard", employeeId: ctx.employeeId || null, user };
  container.innerHTML = `<div class="space-y-4"><div id="hr-tabs"></div><div id="hr-content"></div></div>`;
  await renderTab(container, state, state.tab);
}
