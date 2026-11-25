import { api } from "../api.js";
import { escHtml, formatDate, showToast } from "../utils.js";
import { COMPANY_LOGO } from "../branding.js";
import { save } from "@tauri-apps/plugin-dialog";
import { missingFields } from "./employees.js";
import { buildDocumentAlerts, loadAlertRules } from "./document-alerts.js";
import { readAddress } from "../address-field.js";

const STORAGE_KEY = "autohr.reportBuilder.v2";
const OLD_STORAGE_KEY = "autohr.reportBuilder.v1";
const PANEL_KEY = "autohr.reportBuilder.columnsHidden";

/* Column types: "date" (shown 2026/12/7, a real date in Excel), "ltr" (numbers and Latin
 * text kept left-to-right on one line, so «O+» and «T-1012» are not turned around or broken),
 * "number" (sorted as a number), "name" (kept on one line). */
const fieldGroups = [
  {
    title: "حالة الملف",
    fields: [
      ["missing_count", "عدد البيانات الناقصة", "number"],
      ["missing_fields", "البيانات الناقصة"],
      ["documents_status", "حالة المستمسكات"],
    ],
  },
  {
    title: "المعلومات الأساسية",
    fields: [
      ["employee_number", "الرقم الوظيفي", "ltr"],
      ["full_name", "الاسم الرباعي واللقب", "name"],
      ["mother_name", "اسم الأم"],
      ["father_birthdate", "تاريخ ولادة الأب", "date"],
      ["father_birthplace", "محل ولادة الأب"],
      ["mother_birthdate", "تاريخ ولادة الأم", "date"],
      ["mother_birthplace", "محل ولادة الأم"],
      ["gender", "الجنس"],
      ["marital_status", "الحالة الاجتماعية"],
      ["birthdate", "تاريخ الولادة", "date"],
      ["birthplace", "محل الولادة"],
      ["blood_type", "فصيلة الدم", "ltr"],
      ["phone", "الهاتف", "ltr"],
      ["email", "البريد الإلكتروني", "ltr"],
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
      ["appointment_date", "تاريخ التعيين", "date"],
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
      ["graduation_year", "سنة التخرج", "ltr"],
    ],
  },
  {
    title: "البطاقة الوطنية",
    fields: [
      ["civil_id", "الرقم الوطني", "ltr"],
      ["civil_id_issuer", "جهة إصدار البطاقة الوطنية"],
      ["civil_id_issue_date", "تاريخ إصدار البطاقة الوطنية", "date"],
      ["civil_id_expiry_date", "تاريخ نفاذ البطاقة الوطنية", "date"],
      ["civil_id_birthplace", "محل الولادة في البطاقة"],
      ["civil_id_birthdate", "تاريخ الولادة في البطاقة", "date"],
      ["civil_id_family_number", "الرقم العائلي", "ltr"],
      ["has_civil_id_front", "مرفق وجه البطاقة الوطنية"],
      ["has_civil_id_back", "مرفق خلف البطاقة الوطنية"],
    ],
  },
  {
    title: "جواز السفر",
    fields: [
      ["passport_no", "رقم جواز السفر", "ltr"],
      ["passport_type", "نوع الجواز", "ltr"],
      ["passport_name", "الاسم حسب الجواز", "ltr"],
      ["passport_issue_date", "تاريخ إصدار الجواز", "date"],
      ["passport_expiry_date", "تاريخ نفاذ الجواز", "date"],
      ["has_passport_attachment", "مرفق جواز السفر"],
    ],
  },
  {
    title: "السكن والتموينية",
    fields: [
      ["residence_card_no", "رقم بطاقة السكن", "ltr"],
      ["residence_card_issuer", "مكتب معلومات بطاقة السكن"],
      ["residence_card_issue_date", "تاريخ إصدار بطاقة السكن", "date"],
      ["residence_head_name", "اسم رب الأسرة (السكن)"],
      ["residence_form_no", "رقم استمارة السكن", "ltr"],
      ["residence_governorate", "المحافظة"],
      ["residence_district", "القضاء"],
      ["residence_subdistrict", "الناحية"],
      ["residence_city", "المدينة / الحي"],
      ["residence_address", "عنوان السكن الكامل"],
      ["has_residence_front", "مرفق وجه بطاقة السكن"],
      ["has_residence_back", "مرفق خلف بطاقة السكن"],
      ["ration_card_no", "رقم البطاقة التموينية", "ltr"],
      ["ration_center_name", "اسم رب الأسرة (التموينية)"],
      ["has_ration_attachment", "مرفق البطاقة التموينية"],
    ],
  },
  {
    title: "الهويات والباجات",
    fields: [
      ["airport_badge_no", "رقم باج المطار", "ltr"],
      ["airport_badge_issue_date", "تاريخ إصدار باج المطار", "date"],
      ["airport_badge_expiry", "تاريخ نفاذ باج المطار", "date"],
      ["airport_badge_zones", "صلاحيات باج المطار", "ltr"],
      ["has_airport_front", "مرفق وجه باج المطار"],
      ["has_airport_back", "مرفق خلف باج المطار"],
      ["ministry_badge_no", "رقم هوية وزارة النقل", "ltr"],
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
      ["spouses_count", "عدد الزوج/الزوجات", "number"],
      ["spouses_names", "أسماء الزوج/الزوجات"],
      ["spouses_cards_count", "عدد مرفقات بطاقات الزوج/الزوجات", "number"],
      ["family_members_count", "عدد أفراد الأسرة", "number"],
      ["family_members_names", "أسماء أفراد الأسرة"],
      ["family_cards_count", "عدد مرفقات بطاقات أفراد الأسرة", "number"],
    ],
  },
  {
    // Read from the «المركبات» list (one value per vehicle, separated by «، »).
    title: "المركبات",
    fields: [
      ["vehicles_count", "عدد المركبات", "number"],
      ["vehicles_plates", "أرقام المركبات"],
      ["vehicle_brand", "العلامة التجارية"],
      ["vehicle_type", "نوع المركبة"],
      ["vehicle_color", "لون المركبة"],
      ["vehicle_manufacture_year", "سنة الصنع", "ltr"],
      ["vehicle_annual_no", "رقم السنوية", "ltr"],
      ["vehicle_annual_issue_date", "تاريخ إصدار السنوية", "date"],
      ["vehicle_annual_expiry_date", "تاريخ نفاذ السنوية", "date"],
    ],
  },
  {
    title: "أخرى",
    fields: [
      ["attachments_count", "عدد المرفقات العامة", "number"],
      ["notes", "الملاحظات"],
    ],
  },
];

const fieldDefs = fieldGroups.flatMap(group =>
  group.fields.map(([key, label, type]) => ({ key, label, type, group: group.title }))
);
const fieldByKey = new Map(fieldDefs.map(field => [field.key, field]));

const defaultColumns = ["employee_number", "full_name", "job_title", "department", "civil_id", "phone", "is_active_label"];
const defaultFilters = { search: "", status: "active", docs: "all", data: "all" };

/** Ready-made reports: columns and filters set with one choice. */
const PRESETS = [
  { id: "contacts", label: "قائمة الاتصال", columns: ["employee_number", "full_name", "job_title", "phone", "email"], filters: {} },
  { id: "documents", label: "المستمسكات المنتهية أو القريبة", columns: ["employee_number", "full_name", "documents_status", "civil_id_expiry_date", "passport_expiry_date", "airport_badge_expiry", "ministry_badge_expiry", "vehicle_annual_expiry_date"], filters: { docs: "alerts" } },
  { id: "missing", label: "البيانات الناقصة", columns: ["employee_number", "full_name", "missing_count", "missing_fields"], filters: { data: "missing" } },
  { id: "family", label: "العائلة", columns: ["employee_number", "full_name", "marital_status", "spouses_names", "family_members_count", "family_members_names"], filters: {} },
  { id: "address", label: "السكن", columns: ["employee_number", "full_name", "residence_governorate", "residence_district", "residence_subdistrict", "residence_city", "residence_address", "phone"], filters: {} },
  { id: "vehicles", label: "المركبات", columns: ["employee_number", "full_name", "vehicles_count", "vehicles_plates", "vehicle_type", "vehicle_annual_expiry_date"], filters: {} },
];

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const yesNo = value => (value ? "نعم" : "لا");
const listNames = (items, key = "name") => items.map(item => item?.[key]).filter(Boolean).join("، ");
const text = value => String(value ?? "").trim();

function storedConfig() {
  const valid = columns => Array.isArray(columns) ? columns.filter(key => fieldByKey.has(key)) : [];
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (saved) {
      const columns = valid(saved.columns);
      return { columns: columns.length ? columns : defaultColumns, filters: { ...defaultFilters, ...(saved.filters ?? {}) } };
    }
    // An earlier saved setting: keep its columns. Its list of chosen employees is not used,
    // so employees added since then are in the report.
    const old = valid(JSON.parse(localStorage.getItem(OLD_STORAGE_KEY) ?? "{}").columns);
    return { columns: old.length ? old : defaultColumns, filters: { ...defaultFilters } };
  } catch {
    return { columns: defaultColumns, filters: { ...defaultFilters } };
  }
}

/** Local date as 2026-11-25 (not UTC, which is a day behind after midnight in Baghdad). */
function localIsoDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** The values the report shows for one employee, worked out once. `company` is Settings: every
 *  employee is in the company, department and division set there (as in the employee file). */
function reportRow(employee, company, alerts) {
  const spouses = parseJsonArray(employee.spouses);
  const family = parseJsonArray(employee.family_members);
  const vehicles = parseJsonArray(employee.vehicles);
  const address = readAddress(employee.residence_address_parts, employee.residence_address);
  const missing = missingFields(employee);
  const fromVehicles = key => vehicles.map(vehicle => text(vehicle?.[key])).filter(Boolean);
  const expired = alerts.filter(alert => alert.expired);
  const soon = alerts.filter(alert => !alert.expired);
  const statusParts = [
    expired.length && `منتهٍ: ${[...new Set(expired.map(alert => alert.documentName))].join("، ")}`,
    soon.length && `قارب على النفاذ: ${[...new Set(soon.map(alert => alert.documentName))].join("، ")}`,
  ].filter(Boolean);

  const derived = {
    missing_count: missing.length,
    missing_fields: missing.join("، "),
    documents_status: employee.is_active ? (statusParts.join(" · ") || "سليمة") : "",
    is_active_label: employee.is_active ? "نشط" : "غير نشط",
    workplace: text(company?.company_name) || employee.workplace,
    department: text(company?.department_name) || employee.department,
    division: text(company?.division_name) || employee.division,
    residence_governorate: address.gov,
    residence_district: address.district,
    residence_subdistrict: address.sub,
    residence_city: address.city,
    has_civil_id_front: yesNo(employee.civil_id_front_path),
    has_civil_id_back: yesNo(employee.civil_id_back_path),
    has_passport_attachment: yesNo(parseJsonArray(employee.passport_attachment_paths).length),
    has_residence_front: yesNo(employee.residence_card_front_path),
    has_residence_back: yesNo(employee.residence_card_back_path),
    has_ration_attachment: yesNo(parseJsonArray(employee.ration_card_attachment_paths).length),
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
    vehicles_plates: fromVehicles("plate").join("، "),
    vehicle_brand: fromVehicles("brand").join("، "),
    vehicle_type: fromVehicles("type").join("، "),
    vehicle_color: fromVehicles("color").join("، "),
    vehicle_manufacture_year: fromVehicles("model_year").join("، "),
    vehicle_annual_no: fromVehicles("annual_no").join("، "),
    vehicle_annual_issue_date: fromVehicles("issue_date"),
    vehicle_annual_expiry_date: fromVehicles("expiry_date"),
    attachments_count: parseJsonArray(employee.attachment_paths).length,
  };
  const values = {};
  fieldDefs.forEach(({ key }) => { values[key] = key in derived ? derived[key] : employee[key]; });
  return { employee, values, missing: missing.length, alerts, expired: expired.length };
}

/** What a cell shows: dates as 2026/12/7, a list of dates joined, «—» when empty. */
function displayValue(row, field) {
  const value = row.values[field.key];
  if (field.type === "date") {
    const dates = (Array.isArray(value) ? value : [value]).filter(Boolean);
    return dates.length ? dates.map(formatDate).join("، ") : "—";
  }
  return text(value) === "" ? "—" : String(value);
}

/** What goes to Excel: a single date as YYYY-MM-DD (the program makes it a real date),
 *  several dates as text, and an empty cell for an empty value. */
function excelValue(row, field) {
  const value = row.values[field.key];
  if (field.type === "date") {
    const dates = (Array.isArray(value) ? value : [value]).filter(Boolean);
    return dates.length === 1 ? String(dates[0]).slice(0, 10) : dates.map(formatDate).join("، ");
  }
  return text(value);
}

function sortValue(row, field) {
  const value = row.values[field.key];
  if (field.type === "date") return (Array.isArray(value) ? value[0] : value) || "";
  if (field.type === "number") return Number(value) || 0;
  return text(value);
}

function compareRows(a, b, field) {
  const x = sortValue(a, field), y = sortValue(b, field);
  // Empty values go last whichever way the column is sorted.
  if (x === "" && y !== "") return 1;
  if (y === "" && x !== "") return -1;
  if (typeof x === "number") return x - y;
  return String(x).localeCompare(String(y), "ar", { numeric: true });
}

function cellAttrs(field) {
  if (field.type === "name") return ' class="table-cell report-name"';
  return field.type === "ltr" || field.type === "date" || field.type === "number" ? ' class="table-cell report-ltr"' : ' class="table-cell"';
}

// ── Printing ────────────────────────────────────────────────────────────────
const PRINT_PAGE_PX = 1040; // A4 landscape less the margins, at 96 dpi

/** Columns spread over as many pages as needed; each page repeats «ت» and the name (or the first column). */
function printPages(rows, fields, fontPx) {
  const charPx = fontPx * 0.62;
  const widthOf = field => {
    const longest = Math.max(field.label.length * 0.55, ...rows.map(row => Math.min(displayValue(row, field).length, 40)));
    return Math.max(42, Math.min(longest, 40) * charPx + 12);
  };
  const keyField = fields.find(field => field.key === "full_name") ?? fields[0];
  const rest = fields.filter(field => field !== keyField);
  const fixed = 30 + widthOf(keyField);
  const pages = [];
  let current = [], used = fixed;
  rest.forEach(field => {
    const width = widthOf(field);
    if (current.length && used + width > PRINT_PAGE_PX) { pages.push(current); current = []; used = fixed; }
    current.push(field); used += width;
  });
  pages.push(current);
  return pages.map(page => [keyField, ...page]);
}

function printReport(rows, fields, { company, filterText }) {
  const fontPx = fields.length > 8 ? 9 : 11;
  const pages = printPages(rows, fields, fontPx);
  const table = (pageFields, index) => `
    <section class="${index ? "next-page" : ""}">
      ${pages.length > 1 ? `<p class="part">الجزء ${index + 1} من ${pages.length} من أعمدة التقرير</p>` : ""}
      <table><thead><tr><th class="n">ت</th>${pageFields.map(field => `<th>${escHtml(field.label)}</th>`).join("")}</tr></thead>
      <tbody>${rows.map((row, i) => `<tr><td class="n">${i + 1}</td>${pageFields.map(field => `<td${field.type === "ltr" || field.type === "date" ? ' class="ltr"' : ""}>${escHtml(displayValue(row, field))}</td>`).join("")}</tr>`).join("")}</tbody></table>
    </section>`;
  const unit = [company?.department_name, company?.division_name].map(text).filter(Boolean).join(" · ");
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;right:-9999px";
  document.body.append(frame);
  const doc = frame.contentDocument;
  doc.open();
  doc.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><title>تقرير الموظفين</title>
    <style>
      body{font-family:Arial,sans-serif;margin:0;color:#111827}
      .report-head{display:flex;flex-direction:column;align-items:center;text-align:center;gap:4px;margin:0 0 8px}
      .report-head img{width:26mm;height:auto}
      .report-head h1{font-size:17px;margin:2px 0 0}
      .report-head p{font-size:11px;margin:0;color:#374151}
      .meta{display:flex;justify-content:center;gap:18px;font-size:10px;color:#374151;margin:0 0 8px;flex-wrap:wrap}
      .part{font-size:10px;color:#374151;margin:0 0 4px}
      table{width:100%;border-collapse:collapse;font-size:${fontPx}px}
      th,td{border:1px solid #d1d5db;padding:3px 4px;vertical-align:top;overflow-wrap:anywhere}
      th{background:#f3f4f6}
      thead{display:table-header-group}
      tr{break-inside:avoid}
      .n{width:22px;text-align:center;white-space:nowrap}
      .ltr{direction:ltr;unicode-bidi:isolate;text-align:right;white-space:nowrap}
      .next-page{break-before:page}
      @page{size:A4 landscape;margin:9mm 8mm 12mm;@bottom-center{content:"صفحة " counter(page) " من " counter(pages);font:9px Arial,sans-serif;color:#6b7280}}
    </style></head><body>
    <header class="report-head"><img src="${escHtml(new URL(COMPANY_LOGO.print, location.href).href)}" alt="${escHtml(COMPANY_LOGO.alt)}" />
      <h1>تقرير الموظفين</h1><p>${escHtml(text(company?.company_name))}${unit ? ` — ${escHtml(unit)}` : ""}</p></header>
    <div class="meta"><span>تاريخ الطباعة: ${escHtml(formatDate(localIsoDate()))}</span><span>عدد الموظفين: ${rows.length}</span>${filterText ? `<span>${escHtml(filterText)}</span>` : ""}</div>
    ${pages.map(table).join("")}</body></html>`);
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
  return pages.length;
}

async function downloadExcel(rows, fields) {
  const destination = await save({
    title: "حفظ تقرير الموظفين بصيغة Excel",
    defaultPath: `تقرير الموظفين ${localIsoDate()}.xlsx`,
    filters: [{ name: "ملف Excel", extensions: ["xlsx"] }],
  });
  if (!destination) return;
  const headers = fields.map(field => field.label);
  const values = rows.map(row => fields.map(field => excelValue(row, field)));
  const dateColumns = fields.map((field, index) => (field.type === "date" ? index : -1)).filter(index => index >= 0);
  await api.saveReportXlsx(destination, headers, values, dateColumns);
  showToast("تم تصدير التقرير إلى Excel بنجاح");
}

// ── Screen ─────────────────────────────────────────────────────────────────
const STATUS_OPTIONS = [["active", "النشطون فقط"], ["all", "كل الموظفين"], ["inactive", "غير النشطين"]];
const DOCS_OPTIONS = [["all", "كل المستمسكات"], ["alerts", "منتهية أو قريبة"], ["expired", "منتهية فقط"]];
const DATA_OPTIONS = [["all", "كل البيانات"], ["missing", "بياناته ناقصة"], ["complete", "بياناته كاملة"]];
const optionsHtml = (options, chosen) => options.map(([value, label]) => `<option value="${value}" ${value === chosen ? "selected" : ""}>${label}</option>`).join("");

export async function renderReports(container) {
  window.autohrCanLeaveCurrentScreen = null;
  const [employees, company] = await Promise.all([api.listEmployees(), api.getCompanyConfig().catch(() => null), loadAlertRules()]);
  const alertsById = new Map();
  buildDocumentAlerts(employees).forEach(alert => alertsById.set(alert.employeeId, [...(alertsById.get(alert.employeeId) ?? []), alert]));
  const allRows = employees.map(employee => reportRow(employee, company, alertsById.get(employee.id) ?? []));

  const config = storedConfig();
  const state = {
    columns: [...config.columns],
    filters: { ...config.filters },
    excluded: new Set(), // employees unticked by hand; not saved
    sort: null, // { key, dir: 1 | -1 }
    panelHidden: localStorage.getItem(PANEL_KEY) === "1",
  };

  container.innerHTML = `
    <div class="report-screen">
      <div class="card report-toolbar">
        <div class="report-filters">
          <input id="report-search" type="search" class="input-field" placeholder="بحث بالاسم أو الرقم أو الهاتف…" />
          <select id="report-status" class="input-field" aria-label="حالة الموظف">${optionsHtml(STATUS_OPTIONS, state.filters.status)}</select>
          <select id="report-docs" class="input-field" aria-label="المستمسكات">${optionsHtml(DOCS_OPTIONS, state.filters.docs)}</select>
          <select id="report-data" class="input-field" aria-label="البيانات">${optionsHtml(DATA_OPTIONS, state.filters.data)}</select>
          <span id="report-summary" class="report-count"></span>
        </div>
        <div class="report-actions">
          <button type="button" id="report-save" class="btn-secondary" title="يحفظ الأعمدة والفلاتر ليفتح بها التقرير لاحقاً">حفظ الإعداد</button>
          <button type="button" id="report-reset" class="btn-secondary">استعادة الافتراضي</button>
          <button type="button" id="report-print" class="btn-secondary">طباعة</button>
          <button type="button" id="report-excel" class="btn-primary">تصدير Excel</button>
        </div>
      </div>

      <div class="report-body ${state.panelHidden ? "is-panel-hidden" : ""}">
        <aside class="card report-columns" id="report-columns">
          <div class="report-columns-head">
            <p class="section-title">أعمدة التقرير</p>
            <button type="button" id="report-hide-columns" class="emp-link">إخفاء</button>
          </div>
          <label class="report-preset-label">تقرير جاهز
            <select id="report-preset" class="input-field"><option value="">اختر…</option>${PRESETS.map(preset => `<option value="${preset.id}">${preset.label}</option>`).join("")}</select>
          </label>
          <div class="report-column-tools">
            <button type="button" id="report-select-all" class="btn-secondary text-xs px-2 py-1">تحديد كل الأعمدة</button>
            <button type="button" id="report-clear" class="btn-secondary text-xs px-2 py-1">إلغاء تحديد الأعمدة</button>
          </div>
          <p class="report-hint">تظهر الأعمدة في الجدول بترتيب اختيارها.</p>
          ${fieldGroups.map(group => `
            <section class="report-group">
              <p class="report-group-title">${escHtml(group.title)}</p>
              ${group.fields.map(([key, label]) => `
                <label class="report-field-label">
                  <input type="checkbox" class="report-field" value="${key}" />
                  <span>${escHtml(label)}</span>
                </label>`).join("")}
            </section>`).join("")}
        </aside>

        <main class="card report-table-card">
          <button type="button" id="report-show-columns" class="btn-secondary text-xs px-2 py-1 report-show-columns">أعمدة التقرير</button>
          <div id="report-table" class="report-table-wrap"></div>
        </main>
      </div>
    </div>`;

  const $ = selector => container.querySelector(selector);
  $("#report-search").value = state.filters.search;

  const fields = () => state.columns.map(key => fieldByKey.get(key)).filter(Boolean);

  const matches = row => {
    const { search, status, docs, data } = state.filters;
    const employee = row.employee;
    if (status === "active" && !employee.is_active) return false;
    if (status === "inactive" && employee.is_active) return false;
    if (docs === "alerts" && !row.alerts.length) return false;
    if (docs === "expired" && !row.expired) return false;
    if (data === "missing" && !row.missing) return false;
    if (data === "complete" && row.missing) return false;
    const query = text(search).toLowerCase();
    if (!query) return true;
    return [employee.full_name, employee.employee_number, employee.job_title, employee.phone, employee.civil_id]
      .some(value => text(value).toLowerCase().includes(query));
  };

  const filterText = () => {
    const parts = [];
    const label = (options, value) => options.find(([v]) => v === value)?.[1];
    if (state.filters.status !== "all") parts.push(label(STATUS_OPTIONS, state.filters.status));
    if (state.filters.docs !== "all") parts.push(`المستمسكات: ${label(DOCS_OPTIONS, state.filters.docs)}`);
    if (state.filters.data !== "all") parts.push(label(DATA_OPTIONS, state.filters.data));
    if (text(state.filters.search)) parts.push(`بحث: ${text(state.filters.search)}`);
    return parts.join(" · ");
  };

  const current = () => {
    const visible = allRows.filter(matches);
    const sortField = state.sort && fieldByKey.get(state.sort.key);
    if (sortField) visible.sort((a, b) => compareRows(a, b, sortField) * (sortValue(a, sortField) === "" || sortValue(b, sortField) === "" ? 1 : state.sort.dir));
    const chosen = visible.filter(row => !state.excluded.has(row.employee.id));
    return { visible, chosen, fields: fields() };
  };

  const syncChecks = () => {
    container.querySelectorAll(".report-field").forEach(input => { input.checked = state.columns.includes(input.value); });
  };

  const render = () => {
    const { visible, chosen, fields: shown } = current();
    $("#report-summary").textContent = `في التقرير: ${chosen.length} من ${visible.length} موظفاً`;
    container.querySelector(".report-body").classList.toggle("is-panel-hidden", state.panelHidden);
    if (!shown.length) {
      $("#report-table").innerHTML = `<div class="p-8 text-center text-gray-500">اختر عموداً واحداً على الأقل من «أعمدة التقرير»</div>`;
      return;
    }
    const allChosen = visible.length > 0 && chosen.length === visible.length;
    $("#report-table").innerHTML = `<table class="w-full report-table">
        <thead><tr>
          <th class="table-header report-check"><input id="report-employees-all" type="checkbox" ${allChosen ? "checked" : ""} title="تحديد جميع الموظفين الظاهرين" /></th>
          <th class="table-header report-n">ت</th>
          ${shown.map(field => {
            const sorted = state.sort?.key === field.key;
            return `<th class="table-header report-sort ${sorted ? "is-sorted" : ""}" data-sort="${field.key}" title="اضغط للترتيب حسب «${escHtml(field.label)}»">${escHtml(field.label)}${sorted ? `<span class="report-sort-arrow">${state.sort.dir === 1 ? "↓" : "↑"}</span>` : ""}</th>`;
          }).join("")}
        </tr></thead>
        <tbody>${visible.length ? visible.map((row, index) => `<tr class="table-row ${state.excluded.has(row.employee.id) ? "is-excluded" : ""}">
          <td class="table-cell report-check"><input type="checkbox" class="report-employee" value="${row.employee.id}" ${state.excluded.has(row.employee.id) ? "" : "checked"} aria-label="تحديد ${escHtml(row.employee.full_name)}" /></td>
          <td class="table-cell report-n">${index + 1}</td>
          ${shown.map(field => `<td${cellAttrs(field)}>${escHtml(displayValue(row, field))}</td>`).join("")}
        </tr>`).join("") : `<tr><td colspan="${shown.length + 2}" class="table-cell text-center text-gray-500">لا يوجد موظفون مطابقون للبحث أو الفلتر</td></tr>`}</tbody>
      </table>`;
    const selectAll = $("#report-employees-all");
    if (selectAll) selectAll.indeterminate = chosen.length > 0 && chosen.length < visible.length;
  };

  // Columns: a ticked column goes to the end, so the table follows the order of choosing.
  container.querySelectorAll(".report-field").forEach(input => input.addEventListener("change", () => {
    state.columns = state.columns.filter(key => key !== input.value);
    if (input.checked) state.columns.push(input.value);
    $("#report-preset").value = "";
    render();
  }));
  $("#report-select-all").addEventListener("click", () => {
    state.columns = [...state.columns, ...fieldDefs.map(field => field.key).filter(key => !state.columns.includes(key))];
    syncChecks(); render();
  });
  $("#report-clear").addEventListener("click", () => { state.columns = []; syncChecks(); render(); });
  $("#report-preset").addEventListener("change", event => {
    const preset = PRESETS.find(item => item.id === event.target.value);
    if (!preset) return;
    state.columns = [...preset.columns];
    state.filters = { ...state.filters, docs: "all", data: "all", ...preset.filters };
    state.sort = null;
    $("#report-docs").value = state.filters.docs;
    $("#report-data").value = state.filters.data;
    syncChecks(); render();
  });
  $("#report-hide-columns").addEventListener("click", () => { state.panelHidden = true; localStorage.setItem(PANEL_KEY, "1"); render(); });
  $("#report-show-columns").addEventListener("click", () => { state.panelHidden = false; localStorage.setItem(PANEL_KEY, "0"); render(); });

  // Filters.
  let searchTimer = null;
  $("#report-search").addEventListener("input", event => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.filters.search = event.target.value; render(); }, 200);
  });
  [["#report-status", "status"], ["#report-docs", "docs"], ["#report-data", "data"]].forEach(([selector, key]) =>
    $(selector).addEventListener("change", event => { state.filters[key] = event.target.value; render(); }));

  // Table: sorting by a heading, ticking employees.
  $("#report-table").addEventListener("click", event => {
    const heading = event.target.closest("[data-sort]");
    if (!heading) return;
    const key = heading.dataset.sort;
    state.sort = state.sort?.key === key ? (state.sort.dir === 1 ? { key, dir: -1 } : null) : { key, dir: 1 };
    render();
  });
  $("#report-table").addEventListener("change", event => {
    const { visible } = current();
    if (event.target.id === "report-employees-all") {
      visible.forEach(row => (event.target.checked ? state.excluded.delete(row.employee.id) : state.excluded.add(row.employee.id)));
    } else if (event.target.classList.contains("report-employee")) {
      const id = Number(event.target.value);
      if (event.target.checked) state.excluded.delete(id); else state.excluded.add(id);
    } else {
      return;
    }
    render();
  });

  $("#report-reset").addEventListener("click", () => {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(OLD_STORAGE_KEY);
    renderReports(container);
  });
  $("#report-save").addEventListener("click", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ columns: state.columns, filters: state.filters }));
    showToast("تم حفظ الأعمدة والفلاتر، وسيفتح بها التقرير لاحقاً. الموظفون الجدد يدخلون فيه تلقائياً");
  });

  const readyToOutput = ({ chosen, fields: shown }) => {
    if (!shown.length) { showToast("اختر عموداً واحداً على الأقل من «أعمدة التقرير»", "warn"); return false; }
    if (!chosen.length) { showToast("حدد موظفاً واحداً على الأقل من الجدول", "warn"); return false; }
    return true;
  };
  $("#report-excel").addEventListener("click", async () => {
    const report = current();
    if (!readyToOutput(report)) return;
    try {
      await downloadExcel(report.chosen, report.fields);
    } catch (error) {
      showToast(typeof error === "string" ? error : error?.message ?? "تعذر تصدير Excel", "error");
    }
  });
  $("#report-print").addEventListener("click", async () => {
    const report = current();
    if (!readyToOutput(report)) return;
    try {
      await api.auditReportPrint(report.chosen.length, report.fields.map(field => field.label));
    } catch (error) {
      showToast(typeof error === "string" ? error : error?.message ?? "تعذر تسجيل الطباعة", "error");
      return;
    }
    const pages = printReport(report.chosen, report.fields, { company, filterText: filterText() });
    if (pages > 1) showToast(`الأعمدة كثيرة على عرض الورقة، فقُسّمت على ${pages} أجزاء، وفي كل جزء التسلسل والاسم`);
  });

  syncChecks();
  render();
}
