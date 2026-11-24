import { api } from "../api.js";
import { escHtml, formatDate, showToast } from "../utils.js";
import { COMPANY_LOGO } from "../branding.js";
import { save } from "@tauri-apps/plugin-dialog";

const STORAGE_KEY = "autohr.reportBuilder.v1";

const fieldGroups = [
  {
    title: "المعلومات الأساسية",
    fields: [
      ["employee_number", "الرقم الوظيفي"],
      ["full_name", "الاسم الرباعي واللقب"],
      ["mother_name", "اسم الأم"],
      ["father_birthdate", "تاريخ ولادة الأب", "date"],
      ["father_birthplace", "محل ولادة الأب"],
      ["mother_birthdate", "تاريخ ولادة الأم", "date"],
      ["mother_birthplace", "محل ولادة الأم"],
      ["gender", "الجنس"],
      ["marital_status", "الحالة الاجتماعية"],
      ["birthdate", "تاريخ الولادة", "date"],
      ["birthplace", "محل الولادة"],
      ["blood_type", "فصيلة الدم"],
      ["phone", "الهاتف"],
      ["email", "البريد الإلكتروني"],
      ["is_active_label", "حالة الموظف"],
    ],
  },
  {
    title: "الوظيفة",
    fields: [
      ["workplace", "مكان العمل"],
      ["job_title", "العنوان الوظيفي"],
      ["job_grade", "الدرجة الوظيفية"],
      ["department", "القسم"],
      ["division", "الشعبة / الوحدة"],
      ["appointment_date", "\u062a\u0627\u0631\u064a\u062e \u0627\u0644\u062a\u0639\u064a\u064a\u0646", "date"],
      ["hire_date", "تاريخ المباشرة", "date"],
      ["contract_type", "نوع التوظيف"],
      ["work_schedule", "نظام العمل"],
      ["work_type_notes", "ملاحظات نوع التوظيف"],
    ],
  },
  {
    title: "الدراسة",
    fields: [
      ["education_level", "التحصيل الدراسي"],
      ["specialization", "التخصص"],
      ["graduation_year", "سنة التخرج"],
    ],
  },
  {
    title: "البطاقة الوطنية",
    fields: [
      ["civil_id", "رقم البطاقة الوطنية"],
      ["civil_id_issuer", "جهة إصدار البطاقة الوطنية"],
      ["civil_id_issue_date", "تاريخ إصدار البطاقة الوطنية", "date"],
      ["civil_id_expiry_date", "تاريخ نفاذ البطاقة الوطنية", "date"],
      ["civil_id_birthplace", "محل الولادة في البطاقة"],
      ["civil_id_birthdate", "تاريخ الولادة في البطاقة", "date"],
      ["civil_id_family_number", "الرقم العائلي"],
      ["has_civil_id_front", "مرفق وجه البطاقة الوطنية"],
      ["has_civil_id_back", "مرفق خلف البطاقة الوطنية"],
    ],
  },
  {
    title: "جواز السفر",
    fields: [
      ["passport_no", "رقم جواز السفر"],
      ["passport_type", "نوع الجواز"],
      ["passport_name", "الاسم حسب الجواز"],
      ["passport_issue_date", "تاريخ إصدار الجواز", "date"],
      ["passport_expiry_date", "تاريخ نفاذ الجواز", "date"],
      ["has_passport_attachment", "مرفق جواز السفر"],
    ],
  },
  {
    title: "السكن والتموينية",
    fields: [
      ["residence_card_no", "رقم بطاقة السكن"],
      ["residence_card_issuer", "مكتب معلومات بطاقة السكن"],
      ["residence_card_issue_date", "تاريخ إصدار بطاقة السكن", "date"],
      ["residence_head_name", "اسم رب الأسرة"],
      ["residence_form_no", "رقم استمارة السكن"],
      ["residence_address", "عنوان السكن"],
      ["has_residence_front", "مرفق وجه بطاقة السكن"],
      ["has_residence_back", "مرفق خلف بطاقة السكن"],
      ["ration_card_no", "رقم البطاقة التموينية"],
      ["ration_center_name", "اسم مركز التموين"],
      ["has_ration_attachment", "مرفق البطاقة التموينية"],
    ],
  },
  {
    title: "الهويات والباجات",
    fields: [
      ["airport_badge_no", "رقم باج المطار"],
      ["airport_badge_issue_date", "تاريخ إصدار باج المطار", "date"],
      ["airport_badge_expiry", "تاريخ نفاذ باج المطار", "date"],
      ["airport_badge_zones", "صلاحيات باج المطار"],
      ["has_airport_front", "مرفق وجه باج المطار"],
      ["has_airport_back", "مرفق خلف باج المطار"],
      ["ministry_badge_no", "رقم هوية وزارة النقل"],
      ["ministry_badge_issue_date", "تاريخ إصدار هوية الوزارة", "date"],
      ["ministry_badge_expiry", "تاريخ نفاذ هوية الوزارة", "date"],
      ["has_ministry_front", "مرفق وجه هوية الوزارة"],
      ["has_ministry_back", "مرفق خلف هوية الوزارة"],
    ],
  },
  {
    title: "الزوج/الزوجات والعائلة",
    fields: [
      ["spouse_name", "اسم الزوج/الزوجة الأول"],
      ["spouse_mother_name", "اسم أم الزوج/الزوجة الأول"],
      ["spouse_birthdate", "تاريخ ولادة الزوج/الزوجة الأول", "date"],
      ["marriage_date", "تاريخ الزواج الأول", "date"],
      ["spouses_count", "عدد الزوج/الزوجات"],
      ["spouses_names", "أسماء الزوج/الزوجات"],
      ["spouses_cards_count", "عدد مرفقات بطاقات الزوج/الزوجات"],
      ["family_members_count", "عدد أفراد الأسرة"],
      ["family_members_names", "أسماء أفراد الأسرة"],
      ["family_cards_count", "عدد مرفقات بطاقات أفراد الأسرة"],
    ],
  },
  {
    title: "المركبات والمرفقات",
    fields: [
      ["vehicle_plate", "رقم المركبة القديم"],
      ["vehicle_name", "اسم المركبة القديم"],
      ["vehicle_type", "نوع المركبة"],
      ["vehicle_color", "لون المركبة"],
      ["vehicle_manufacture_year", "سنة الصنع"],
      ["vehicle_annual_no", "رقم السنوية"],
      ["vehicle_annual_issue_date", "تاريخ إصدار السنوية", "date"],
      ["vehicle_annual_expiry_date", "تاريخ نفاذ السنوية", "date"],
      ["vehicles_count", "عدد المركبات"],
      ["vehicles_plates", "أرقام المركبات"],
      ["attachments_count", "عدد المرفقات العامة"],
      ["notes", "الملاحظات"],
    ],
  },
];

const fieldDefs = fieldGroups.flatMap(group =>
  group.fields.map(([key, label, type]) => ({ key, label, type, group: group.title }))
);

const defaultColumns = ["employee_number", "full_name", "job_title", "department", "civil_id", "phone", "is_active_label"];

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function yesNo(value) {
  return value ? "نعم" : "لا";
}

function listNames(items, key = "name") {
  return items.map(item => item?.[key]).filter(Boolean).join("، ");
}

function storedConfig() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return {
      columns: Array.isArray(parsed.columns) && parsed.columns.length ? parsed.columns : defaultColumns,
      filters: {
        employeeIds: Array.isArray(parsed.filters?.employeeIds) ? parsed.filters.employeeIds : [],
      },
    };
  } catch {
    return { columns: defaultColumns, filters: { employeeIds: [] } };
  }
}

function saveConfig(columns, filters) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ columns, filters }));
}

function derivedValue(employee, key) {
  const spouses = parseJsonArray(employee.spouses);
  const family = parseJsonArray(employee.family_members);
  const vehicles = parseJsonArray(employee.vehicles);
  const attachments = parseJsonArray(employee.attachment_paths);
  const passportAttachments = parseJsonArray(employee.passport_attachment_paths);
  const rationAttachments = parseJsonArray(employee.ration_card_attachment_paths);

  const derived = {
    birthdate: employee.birthdate || employee.civil_id_birthdate || "",
    birthplace: employee.birthplace || employee.civil_id_birthplace || "",
    is_active_label: employee.is_active ? "نشط" : "غير نشط",
    has_civil_id_front: yesNo(employee.civil_id_front_path),
    has_civil_id_back: yesNo(employee.civil_id_back_path),
    has_passport_attachment: yesNo(passportAttachments.length),
    has_residence_front: yesNo(employee.residence_card_front_path),
    has_residence_back: yesNo(employee.residence_card_back_path),
    has_ration_attachment: yesNo(rationAttachments.length),
    has_airport_front: yesNo(employee.airport_badge_front_path),
    has_airport_back: yesNo(employee.airport_badge_back_path),
    has_ministry_front: yesNo(employee.ministry_badge_front_path),
    has_ministry_back: yesNo(employee.ministry_badge_back_path),
    spouses_count: spouses.length,
    spouses_names: listNames(spouses),
    spouses_cards_count: spouses.reduce((count, spouse) => count + Number(Boolean(spouse?.national_card_front_path)) + Number(Boolean(spouse?.national_card_back_path)), 0),
    family_members_count: family.length,
    family_members_names: listNames(family),
    family_cards_count: family.reduce((count, member) => count + Number(Boolean(member?.national_card_front_path)) + Number(Boolean(member?.national_card_back_path)), 0),
    vehicles_count: vehicles.length,
    vehicles_plates: vehicles.map(vehicle => vehicle?.plate).filter(Boolean).join("، "),
    attachments_count: attachments.length,
  };
  return derived[key] ?? employee[key] ?? "";
}

function formatReportValue(employee, field) {
  const value = derivedValue(employee, field.key);
  if (field.type === "date") return formatDate(value);
  return value === null || value === undefined || value === "" ? "—" : String(value);
}

function selectedColumns(container) {
  return [...container.querySelectorAll(".report-field:checked")].map(input => input.value);
}

function buildExcelPayload(rows, fields) {
  const exportFields = fields;
  return {
    headers: exportFields.map(field => field.label),
    rows: rows.map(employee => exportFields.map(field => formatReportValue(employee, field))),
  };
}


async function downloadExcel(rows, fields) {
  const destination = await save({
    title: "حفظ تقرير الموظفين Excel",
    defaultPath: `employees-report-${new Date().toISOString().slice(0, 10)}.xlsx`,
    filters: [{ name: "Excel Workbook", extensions: ["xlsx"] }],
  });
  if (!destination) return;
  const payload = buildExcelPayload(rows, fields);
  await api.saveReportXlsx(destination, payload.headers, payload.rows);
  showToast("تم تصدير التقرير إلى Excel بنجاح");
}

function printReport(rows, fields) {
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;right:-9999px";
  document.body.append(frame);
  const doc = frame.contentDocument;
  const table = `<table><thead><tr>${fields.map(field => `<th>${escHtml(field.label)}</th>`).join("")}</tr></thead>
    <tbody>${rows.map(employee => `<tr>${fields.map(field => `<td>${escHtml(formatReportValue(employee, field))}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  doc.open();
  doc.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><title>تقرير الموظفين</title>
    <style>
      body{font-family:Arial,sans-serif;margin:14mm;color:#111827}
      h1{font-size:18px;margin:0 0 10px}
      table{width:100%;border-collapse:collapse;font-size:10px}
      th,td{border:1px solid #d1d5db;padding:5px;vertical-align:top}
      th{background:#f3f4f6}
      .report-head{display:flex;align-items:center;gap:12px;margin:0 0 10px}
      .report-head img{width:30mm;height:auto}
      .report-head h1{margin:0}
      @page{size:A4 landscape;margin:8mm}
    </style></head><body><header class="report-head"><img src="${escHtml(new URL(COMPANY_LOGO.print, location.href).href)}" alt="${escHtml(COMPANY_LOGO.alt)}" /><h1>تقرير الموظفين</h1></header>${table}</body></html>`);
  doc.close();
  // Print only after the company logo has loaded, so it is never missing from the page.
  const logo = doc.querySelector(".report-head img");
  const logoReady = !logo || logo.complete
    ? Promise.resolve()
    : new Promise(resolve => { logo.onload = logo.onerror = resolve; });
  Promise.all([logoReady, new Promise(resolve => setTimeout(resolve, 400))]).then(() => {
    frame.contentWindow.focus();
    frame.contentWindow.print();
  });
  setTimeout(() => frame.remove(), 60000);
}

export async function renderReports(container) {
  window.autohrCanLeaveCurrentScreen = null;
  const employees = await api.listEmployees();
  const config = storedConfig();
  const selected = new Set(config.columns);
  let chosenEmployeeIds = new Set(
    config.filters.employeeIds.length
      ? config.filters.employeeIds.map(Number)
      : employees.map(employee => Number(employee.id))
  );

  container.innerHTML = `
    <div class="h-full flex flex-col gap-4">
      <div class="card p-4">
        <div class="flex gap-2 flex-wrap justify-end">
            <button type="button" id="report-save" class="btn-secondary">حفظ الإعداد</button>
            <button type="button" id="report-reset" class="btn-secondary">استعادة الافتراضي</button>
            <button type="button" id="report-print" class="btn-secondary">طباعة</button>
            <button type="button" id="report-excel" class="btn-primary">تصدير Excel</button>
        </div>
      </div>

      <div class="grid grid-cols-1 xl:grid-cols-[330px_1fr] gap-4 min-h-0 flex-1">
        <aside class="card p-4 overflow-auto">
          <p class="section-title mb-2">أعمدة التقرير</p>
          <div class="flex items-center gap-2 mb-3 flex-wrap">
            <button type="button" id="report-select-all" class="btn-secondary text-xs px-2 py-1">تحديد كل الأعمدة</button>
            <button type="button" id="report-clear" class="btn-secondary text-xs px-2 py-1">إلغاء تحديد الأعمدة</button>
          </div>
          ${fieldGroups.map(group => `
            <section style="border-top:1px solid var(--ui-line);padding-top:10px;margin-top:10px">
              <p style="font-size:12px;font-weight:700;color:var(--ui-accent);margin-bottom:8px">${escHtml(group.title)}</p>
              <div class="space-y-2">
                ${group.fields.map(([key, label]) => `
                  <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--ui-text);cursor:pointer">
                    <input type="checkbox" class="report-field" value="${key}" ${selected.has(key) ? "checked" : ""} style="width:15px;height:15px;accent-color:var(--ui-accent)" />
                    <span>${escHtml(label)}</span>
                  </label>`).join("")}
              </div>
            </section>`).join("")}
        </aside>

        <main class="card overflow-auto">
          <div id="report-summary" style="padding:12px 14px;border-bottom:1px solid var(--ui-line);font-size:13px;color:var(--ui-text-muted)"></div>
          <div id="report-table"></div>
        </main>
      </div>
    </div>`;

  const render = () => {
    const columns = selectedColumns(container);
    const employeeIds = [...chosenEmployeeIds];
    const rows = employees.filter(employee => chosenEmployeeIds.has(Number(employee.id)));
    const fields = columns.map(key => fieldDefs.find(field => field.key === key)).filter(Boolean);
    container.querySelector("#report-summary").textContent = `الموظفون المحددون للتقرير: ${rows.length} / ${employees.length}`;
    container.querySelector("#report-table").innerHTML = fields.length
      ? `<table class="w-full">
          <thead><tr>
            <th class="table-header" style="width:54px;text-align:center"><input id="report-employees-all" type="checkbox" ${rows.length === employees.length ? "checked" : ""} style="width:16px;height:16px;accent-color:var(--ui-accent)" title="تحديد جميع الموظفين" /></th>
            ${fields.map(field => `<th class="table-header">${escHtml(field.label)}</th>`).join("")}
          </tr></thead>
          <tbody>${employees.length ? employees.map(employee => `<tr class="table-row">
            <td class="table-cell" style="text-align:center"><input type="checkbox" class="report-employee" value="${employee.id}" ${chosenEmployeeIds.has(Number(employee.id)) ? "checked" : ""} style="width:16px;height:16px;accent-color:var(--ui-accent)" aria-label="تحديد ${escHtml(employee.full_name)}" /></td>
            ${fields.map(field => `<td class="table-cell">${escHtml(formatReportValue(employee, field))}</td>`).join("")}
          </tr>`).join("") : `<tr><td colspan="${fields.length + 1}" class="table-cell text-center text-gray-500">لا توجد نتائج</td></tr>`}</tbody>
        </table>`
      : `<div class="p-8 text-center text-gray-500">اختر حقلاً واحداً على الأقل</div>`;
    const selectAll = container.querySelector("#report-employees-all");
    if (selectAll) selectAll.indeterminate = rows.length > 0 && rows.length < employees.length;
    return { rows, fields, filters: { employeeIds }, columns };
  };

  container.querySelectorAll(".report-field").forEach(input => input.addEventListener("input", render));
  container.querySelector("#report-table").addEventListener("change", event => {
    if (event.target.id === "report-employees-all") {
      chosenEmployeeIds = event.target.checked
        ? new Set(employees.map(employee => Number(employee.id)))
        : new Set();
    } else if (event.target.classList.contains("report-employee")) {
      const employeeId = Number(event.target.value);
      if (event.target.checked) chosenEmployeeIds.add(employeeId);
      else chosenEmployeeIds.delete(employeeId);
    } else {
      return;
    }
    render();
  });
  container.querySelector("#report-select-all").addEventListener("click", () => {
    container.querySelectorAll(".report-field").forEach(input => { input.checked = true; });
    render();
  });
  container.querySelector("#report-clear").addEventListener("click", () => {
    container.querySelectorAll(".report-field").forEach(input => { input.checked = false; });
    render();
  });
  container.querySelector("#report-reset").addEventListener("click", () => {
    localStorage.removeItem(STORAGE_KEY);
    renderReports(container);
  });
  container.querySelector("#report-save").addEventListener("click", () => {
    const state = render();
    saveConfig(state.columns, state.filters);
    showToast("تم حفظ إعداد التقرير، وسيُستخدم عند فتح التقارير لاحقاً");
  });

  const readyToOutput = state => {
    if (!state.fields.length) { showToast("اختر عموداً واحداً على الأقل من «أعمدة التقرير»", "warn"); return false; }
    if (!state.rows.length) { showToast("حدد موظفاً واحداً على الأقل من الجدول", "warn"); return false; }
    return true;
  };
  container.querySelector("#report-excel").addEventListener("click", async () => {
    const state = render();
    if (!readyToOutput(state)) return;
    try {
      await downloadExcel(state.rows, state.fields);
    } catch (error) {
      showToast(error?.message ?? "تعذر تصدير Excel", "error");
    }
  });
  container.querySelector("#report-print").addEventListener("click", () => {
    const state = render();
    if (readyToOutput(state)) printReport(state.rows, state.fields);
  });

  render();
}
