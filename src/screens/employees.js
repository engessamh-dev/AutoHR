/**
 * screens/employees.js — Full Iraqi HR form with tabbed slide panel
 */
import { api } from "../api.js";
import { convertFileSrc } from "@tauri-apps/api/core";
import { showToast, formatDate, escHtml, debounce, confirmAction, confirmSaveChanges } from "../utils.js";
import { can } from "../permissions.js";

let _employees = [];
let _filter = "";
let _activeTab = "basic";
let _panelDraft = null;
let _panelDirty = false;
let _skipNextSaveConfirmation = false;
let _currentUser = null;
let _companyConfig = null;

export async function renderEmployees(container, user, ctx) {
  _currentUser = user;
  window.autohrCanLeaveCurrentScreen = confirmLeavePanel;
  const [employees, companyConfig] = await Promise.all([
    api.listEmployees(),
    api.getCompanyConfig().catch(() => null),
  ]);
  _employees = employees;
  _companyConfig = companyConfig;
  _filter = "";

  container.innerHTML = `
    <div class="flex flex-col gap-4 h-full">
      <div class="flex items-center gap-3 flex-wrap">
        <input id="emp-search" type="text" class="input-field flex-1 min-w-[200px]"
               placeholder="بحث بالاسم أو القسم أو رقم الهوية أو الهاتف أو العنوان الوظيفي…" />
        <button id="btn-add-emp" class="btn-primary px-4 py-2.5 whitespace-nowrap">+ إضافة موظف</button>
      </div>
      <div id="emp-table-wrap" class="card overflow-auto flex-1"></div>
    </div>
    <div id="emp-overlay" style="display:none;position:fixed;inset:0;z-index:40;background:rgba(0,0,0,0.5)"></div>
    <div id="emp-panel" style="position:fixed;top:0;bottom:0;right:0;width:580px;z-index:50;
      background:#1f1f1f;border-left:1px solid #2d2d2d;box-shadow:-8px 0 32px rgba(0,0,0,0.5);
      display:flex;flex-direction:column;transform:translateX(100%);transition:transform 0.3s ease"></div>`;

  renderTable();
  container.querySelector("#emp-search").addEventListener("input",
    debounce(e => { _filter = e.target.value.toLowerCase(); renderTable(); }, 250));
  container.querySelector("#btn-add-emp").addEventListener("click", () => openPanel(null));
  container.querySelector("#emp-overlay").addEventListener("click", () => closePanel());
  if (!can(user, "employees.create")) container.querySelector("#btn-add-emp")?.remove();
}

function filtered() {
  if (!_filter) return _employees;
  return _employees.filter(e =>
    e.full_name?.toLowerCase().includes(_filter) ||
    e.department?.toLowerCase().includes(_filter) ||
    e.civil_id?.includes(_filter) ||
    e.phone?.includes(_filter) ||
    e.job_title?.toLowerCase().includes(_filter)
  );
}

function renderTable() {
  const wrap = document.getElementById("emp-table-wrap");
  if (!wrap) return;
  const rows = filtered();
  wrap.innerHTML = `
    <table class="w-full">
      <thead><tr>
        <th class="table-header">الاسم الرباعي</th>
        <th class="table-header">العنوان الوظيفي</th>
        <th class="table-header">القسم</th>
        <th class="table-header">الهاتف</th>
        <th class="table-header">الحالة</th>
      </tr></thead>
      <tbody>
        ${rows.length === 0
          ? `<tr><td colspan="5" class="table-cell text-center text-gray-500 py-10">لا توجد نتائج</td></tr>`
          : rows.map(e => `
            <tr class="table-row" data-id="${e.id}" style="cursor:pointer">
              <td class="table-cell font-medium text-gray-100">${escHtml(e.full_name)}</td>
              <td class="table-cell">${escHtml(e.job_title ?? "—")}</td>
              <td class="table-cell">${escHtml(e.department ?? "—")}</td>
              <td class="table-cell" dir="ltr">${escHtml(e.phone ?? "—")}</td>
              <td class="table-cell">
                <span class="badge ${e.is_active ? "badge-green" : "badge-gray"}">
                  ${e.is_active ? "نشط" : "غير نشط"}
                </span>
              </td>
            </tr>`).join("")}
      </tbody>
    </table>`;
  wrap.querySelectorAll("tr[data-id]").forEach(row =>
    row.addEventListener("click", () => {
      const emp = _employees.find(e => e.id == row.dataset.id);
      if (emp) openPanel(emp);
    }));
}

function openPanel(emp) {
  _activeTab = "basic";
  _panelDraft = emp ? { ...emp } : { is_active: 1, spouses: "[]", family_members: "[]", vehicles: "[]" };
  _panelDirty = false;
  document.getElementById("emp-panel").style.transform = "translateX(0)";
  document.getElementById("emp-overlay").style.display = "block";
  renderPanel(emp);
}

async function confirmLeavePanel() {
  const panel = document.getElementById("emp-panel");
  const isOpen = panel && panel.style.transform === "translateX(0)";
  if (!isOpen || !_panelDirty) return true;
  return await confirmAction("توجد تغييرات غير محفوظة. هل تريد الخروج بدون حفظ؟");
}

async function closePanel(force = false) {
  if (!force && _panelDirty) {
    const choice = await confirmSaveChanges();
    if (choice === "cancel") return;
    if (choice === "save") {
      _skipNextSaveConfirmation = true;
      document.getElementById("panel-save")?.click();
      return;
    }
  }
  document.getElementById("emp-panel").style.transform = "translateX(100%)";
  document.getElementById("emp-overlay").style.display = "none";
  _panelDraft = null;
  _panelDirty = false;
}

function markPanelDirty() {
  _panelDirty = true;
}

function collectVisiblePanelFields(panel) {
  if (!_panelDraft || !panel) return;
  panel.querySelectorAll("[id^='f-']").forEach(el => {
    const key = el.id.slice(2);
    if (el.type === "checkbox") _panelDraft[key] = el.checked ? 1 : 0;
    else _panelDraft[key] = el.value?.trim() || null;
  });

  const familyList = panel.querySelector("#family-list");
  const rows = panel.querySelectorAll(".family-row");
  if (familyList) {
    const arr = [];
    rows.forEach(row => {
      arr.push({
        name:        row.querySelector(".fm-name")?.value?.trim() || "",
        gender:      row.querySelector(".fm-gender")?.value || "",
        birthplace:  row.querySelector(".fm-birthplace")?.value?.trim() || "",
        birthdate:   row.querySelector(".fm-birthdate")?.value || "",
        civil_id:    row.querySelector(".fm-civil")?.value?.trim() || "",
        issue_date:  row.querySelector(".fm-issue")?.value || "",
        expiry_date: row.querySelector(".fm-expiry")?.value || "",
        issuer:      row.querySelector(".fm-issuer")?.value?.trim() || "",
        blood_type:  row.querySelector(".fm-blood")?.value || "",
        national_card_front_path: row.dataset.nationalCardFrontPath || "",
        national_card_back_path:  row.dataset.nationalCardBackPath || "",
      });
    });
    _panelDraft.family_members = JSON.stringify(arr);
  }

  const spouseList = panel.querySelector("#spouse-list");
  if (spouseList) {
    const spouseConfig = spouseSectionConfig(_panelDraft ?? {});
    const spouses = [];
    panel.querySelectorAll(".spouse-row").forEach(row => {
      spouses.push({
        civil_id:    row.querySelector(".sp-civil")?.value?.trim() || "",
        name:        row.querySelector(".sp-name")?.value?.trim() || "",
        mother_name: row.querySelector(".sp-mother")?.value?.trim() || "",
        gender:      row.querySelector(".sp-gender")?.value || "",
        birthplace:  row.querySelector(".sp-birthplace")?.value?.trim() || "",
        birthdate:   row.querySelector(".sp-birthdate")?.value || "",
        issue_date:  row.querySelector(".sp-issue")?.value || "",
        expiry_date: row.querySelector(".sp-expiry")?.value || "",
        issuer:      row.querySelector(".sp-issuer")?.value?.trim() || "",
        blood_type:  row.querySelector(".sp-blood")?.value || "",
        marriage_date: row.querySelector(".sp-marriage")?.value || "",
        national_card_front_path: row.dataset.nationalCardFrontPath || "",
        national_card_back_path:  row.dataset.nationalCardBackPath || "",
      });
    });
    _panelDraft.spouses = JSON.stringify(spouses.slice(0, spouseConfig?.max ?? 4));
    const firstSpouse = spouses[0] ?? {};
    _panelDraft.spouse_name = firstSpouse.name || null;
    _panelDraft.spouse_mother_name = firstSpouse.mother_name || null;
    _panelDraft.spouse_birthdate = firstSpouse.birthdate || null;
    _panelDraft.marriage_date = firstSpouse.marriage_date || null;
  }

  const vehicleList = panel.querySelector("#vehicle-list");
  if (vehicleList) {
    const vehicleRows = vehicleList.querySelectorAll(".vehicle-row");
    const vehicles = [];
    vehicleRows.forEach(row => {
      vehicles.push({
        plate:       row.querySelector(".vehicle-plate")?.value?.trim() || "",
        brand:       row.querySelector(".vehicle-brand")?.value?.trim() || "",
        type:        row.querySelector(".vehicle-type")?.value?.trim() || "",
        color:       row.querySelector(".vehicle-color")?.value?.trim() || "",
        annual_no:   row.querySelector(".vehicle-annual-no")?.value?.trim() || "",
        issue_date:  row.querySelector(".vehicle-issue-date")?.value || "",
        expiry_date: row.querySelector(".vehicle-expiry-date")?.value || "",
      });
    });
    _panelDraft.vehicles = JSON.stringify(vehicles);
  }
}

// ── Field helper ────────────────────────────────────────────────────────────
const f = (id, emp) => escHtml(emp?.[id] ?? "");

function field(label, id, emp, opts = {}) {
  const val = f(id, emp);
  if (opts.type === "select") {
    return `<div>
      <p style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">${label}</p>
      <select id="f-${id}" class="input-field">
        ${opts.options.map(([v,l]) => `<option value="${v}" ${emp?.[id]===v?"selected":""}>${l}</option>`).join("")}
      </select></div>`;
  }
  if (opts.type === "textarea") {
    return `<div style="${opts.span ? 'grid-column:span 2' : ''}">
      <p style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">${label}</p>
      <textarea id="f-${id}" class="input-field" style="height:70px;resize:none">${val}</textarea></div>`;
  }
  return `<div style="${opts.span ? 'grid-column:span 2' : ''}">
    <p style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">${label}</p>
    <input id="f-${id}" class="input-field" type="${opts.date ? 'date' : 'text'}"
           dir="${opts.ltr ? 'ltr' : 'rtl'}" value="${opts.date ? (emp?.[id] ?? '') : val}" /></div>`;
}

function fixedCompanyField(label, id, value) {
  return `<div>
    <p style="font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">${label}</p>
    <input id="f-${id}" class="input-field" type="text" value="${escHtml(value ?? "")}" readonly />
  </div>`;
}

function sectionTitle(title) {
  return `<div style="grid-column:span 2;border-bottom:1px solid #2d2d2d;padding-bottom:6px;margin-top:8px">
    <p style="font-size:12px;font-weight:700;color:#5da12c;text-transform:uppercase;letter-spacing:.08em">${title}</p>
  </div>`;
}

function sidedCardAttachment(label, side, path, fullPath, canUpload, cardType = "national") {
  const name = path?.split(/[/\\]/).pop();
  const extension = name?.split(".").pop()?.toLowerCase();
  const assetUrl = fullPath ? convertFileSrc(fullPath) : "";
  const preview = assetUrl && ["jpg", "jpeg"].includes(extension)
    ? `<img src="${escHtml(assetUrl)}" alt="${label}" style="display:block;max-width:100%;height:auto;border:1px solid #2d2d2d;border-radius:6px;margin:0 auto 9px" />`
    : assetUrl && extension === "pdf"
      ? `<iframe src="${escHtml(assetUrl)}" title="${label}" style="display:block;width:100%;height:220px;background:#fff;border:1px solid #2d2d2d;border-radius:6px;margin-bottom:9px"></iframe>`
      : "";
  return `<div style="padding:10px 12px;background:#181818;border:1px solid #2d2d2d;border-radius:8px">
    <p style="font-size:12px;font-weight:700;color:#d1d5db;margin-bottom:5px">${label}</p>
    ${preview}
    <p style="font-size:11px;color:${name ? "#9ca3af" : "#6b7280"};margin-bottom:9px;word-break:break-all">
      ${name ? escHtml(name) : "لم يُرفع ملف"}
    </p>
    ${canUpload ? `<div style="display:flex;gap:6px">
      <button type="button" class="btn-secondary text-xs px-2 py-1 btn-upload-sided-card" data-card-type="${cardType}" data-side="${side}">
        ${name ? "استبدال" : "رفع"}
      </button>
      ${name ? `<button type="button" class="btn-danger text-xs px-2 py-1 btn-delete-sided-card" data-card-type="${cardType}" data-side="${side}">حذف</button>` : ""}
    </div>` : `<p style="font-size:11px;color:#6b7280">احفظ سجل الموظف أولاً</p>`}
  </div>`;
}

function passportAttachments(emp) {
  let paths = [];
  try { paths = JSON.parse(emp?.passport_attachment_paths ?? "[]"); } catch {}
  const fullPaths = emp?.passport_attachment_full_paths ?? [];
  const path = paths[0];
  const fullPath = fullPaths[0];
  const name = path?.split(/[/\\]/).pop();
  const extension = name?.split(".").pop()?.toLowerCase();
  const assetUrl = fullPath ? convertFileSrc(fullPath) : "";
  const preview = assetUrl && ["jpg", "jpeg"].includes(extension)
    ? `<img src="${escHtml(assetUrl)}" alt="${escHtml(name)}" style="display:block;max-width:100%;height:auto;border:1px solid #2d2d2d;border-radius:6px;margin:0 auto 9px" />`
    : assetUrl && extension === "pdf"
      ? `<iframe src="${escHtml(assetUrl)}" title="${escHtml(name)}" style="display:block;width:100%;height:220px;background:#fff;border:1px solid #2d2d2d;border-radius:6px;margin-bottom:9px"></iframe>`
      : "";
  return `<div style="grid-column:span 2">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <p style="font-size:12px;color:#9ca3af">${path ? "نسخة الجواز مرفوعة" : "لم تُرفع نسخة الجواز"}</p>
      ${emp?.id
        ? (path ? "" : `<button type="button" id="btn-upload-passport" class="btn-secondary text-xs px-3 py-1.5">رفع نسخة…</button>`)
        : `<p style="font-size:11px;color:#6b7280">احفظ سجل الموظف أولاً</p>`}
    </div>
    ${!path ? `<p style="text-align:center;color:#6b7280;padding:18px;font-size:12px;background:#181818;border:1px solid #2d2d2d;border-radius:8px">لا توجد نسخة للجواز</p>` : `
      <div style="padding:10px 12px;background:#181818;border:1px solid #2d2d2d;border-radius:8px">
        ${preview}
        <p style="font-size:11px;color:#9ca3af;word-break:break-all;margin-bottom:8px">${escHtml(name)}</p>
        <div style="display:flex;align-items:center;gap:6px">
          <button type="button" id="btn-upload-passport" class="btn-secondary text-xs px-2 py-1">استبدال</button>
          <button type="button" class="btn-danger text-xs px-2 py-1 btn-delete-passport" data-path="${escHtml(path)}">حذف</button>
        </div>
      </div>`}
  </div>`;
}

function rationCardAttachments(emp) {
  let paths = [];
  try { paths = JSON.parse(emp?.ration_card_attachment_paths ?? "[]"); } catch {}
  const fullPaths = emp?.ration_card_attachment_full_paths ?? [];
  const path = paths[0];
  const fullPath = fullPaths[0];
  const name = path?.split(/[/\\]/).pop();
  const extension = name?.split(".").pop()?.toLowerCase();
  const assetUrl = fullPath ? convertFileSrc(fullPath) : "";
  const preview = assetUrl && ["jpg", "jpeg"].includes(extension)
    ? `<img src="${escHtml(assetUrl)}" alt="${escHtml(name)}" style="display:block;max-width:100%;height:auto;border:1px solid #2d2d2d;border-radius:6px;margin:0 auto 9px" />`
    : assetUrl && extension === "pdf"
      ? `<iframe src="${escHtml(assetUrl)}" title="${escHtml(name)}" style="display:block;width:100%;height:220px;background:#fff;border:1px solid #2d2d2d;border-radius:6px;margin-bottom:9px"></iframe>`
      : "";
  return `<div style="grid-column:span 2">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <p style="font-size:12px;color:#9ca3af">${path ? "نسخة البطاقة التموينية مرفوعة" : "لم تُرفع نسخة البطاقة التموينية"}</p>
      ${emp?.id
        ? (path ? "" : `<button type="button" id="btn-upload-ration-card" class="btn-secondary text-xs px-3 py-1.5">رفع نسخة…</button>`)
        : `<p style="font-size:11px;color:#6b7280">احفظ سجل الموظف أولاً</p>`}
    </div>
    ${!path ? `<p style="text-align:center;color:#6b7280;padding:18px;font-size:12px;background:#181818;border:1px solid #2d2d2d;border-radius:8px">لا توجد نسخة للبطاقة التموينية</p>` : `
      <div style="padding:10px 12px;background:#181818;border:1px solid #2d2d2d;border-radius:8px">
        ${preview}
        <p style="font-size:11px;color:#9ca3af;word-break:break-all;margin-bottom:8px">${escHtml(name)}</p>
        <div style="display:flex;align-items:center;gap:6px">
          <button type="button" id="btn-upload-ration-card" class="btn-secondary text-xs px-2 py-1">استبدال</button>
          <button type="button" class="btn-danger text-xs px-2 py-1 btn-delete-ration-card" data-path="${escHtml(path)}">حذف</button>
        </div>
      </div>`}
  </div>`;
}

function personalPhotoDocument(emp) {
  const assetUrl = emp?.photo_full_path ? convertFileSrc(emp.photo_full_path) : "";
  return `<div style="grid-column:span 2;display:flex;justify-content:center">
    <div style="width:min(260px,100%);text-align:center;padding:14px;background:#181818;border:1px solid #2d2d2d;border-radius:8px">
      <p style="font-size:13px;font-weight:700;color:#d1d5db;margin-bottom:10px">الصورة الشخصية</p>
      ${assetUrl
        ? `<img src="${escHtml(assetUrl)}" alt="الصورة الشخصية" style="display:block;width:150px;height:180px;object-fit:cover;border:1px solid #2d2d2d;border-radius:8px;margin:0 auto 10px;background:#0b1220" />`
        : `<div style="display:grid;place-items:center;width:150px;height:180px;border:1px dashed #374151;border-radius:8px;margin:0 auto 10px;color:#6b7280;background:#0b1220;font-size:12px">لا توجد صورة</div>`}
      ${emp?.id
        ? `<button type="button" id="btn-upload-photo" class="btn-secondary text-xs px-3 py-1.5">${assetUrl ? "استبدال الصورة" : "رفع صورة"}</button>`
        : `<p style="font-size:11px;color:#6b7280">احفظ سجل الموظف أولاً</p>`}
    </div>
  </div>`;
}

const printableDocumentDefinitions = [
  {
    id: "photo",
    title: "الصورة الشخصية",
    render: emp => printablePersonalPhoto(emp),
  },
  {
    id: "national",
    title: "البطاقة الوطنية",
    fields: [
      ["رقم البطاقة الوطنية", "civil_id"],
      ["جهة الإصدار", "civil_id_issuer"],
      ["تاريخ الإصدار", "civil_id_issue_date"],
      ["تاريخ النفاذ", "civil_id_expiry_date"],
      ["محل الولادة", "civil_id_birthplace"],
      ["تاريخ الولادة", "civil_id_birthdate"],
      ["الرقم العائلي", "civil_id_family_number"],
    ],
    attachments: [
      ["الوجه الأمامي", "civil_id_front_path", "civil_id_front_full_path"],
      ["الوجه الخلفي", "civil_id_back_path", "civil_id_back_full_path"],
    ],
  },
  {
    id: "family-national-cards",
    title: "البطاقة الوطنية لأفراد الأسرة",
    render: emp => printableFamilyNationalCards(emp),
  },
  {
    id: "spouse-national-cards",
    title: "البطاقة الوطنية للزوجات",
    render: emp => printableSpouseNationalCards(emp),
  },
  {
    id: "passport",
    title: "جواز السفر",
    fields: [
      ["رقم جواز السفر", "passport_no"],
      ["نوع الجواز", "passport_type"],
      ["الاسم حسب الجواز", "passport_name"],
      ["تاريخ الإصدار", "passport_issue_date"],
      ["تاريخ النفاذ", "passport_expiry_date"],
    ],
    attachmentList: ["passport_attachment_paths", "passport_attachment_full_paths"],
  },
  {
    id: "residence",
    title: "بطاقة السكن",
    fields: [
      ["مكتب معلومات", "residence_card_issuer"],
      ["اسم رب الأسرة", "residence_head_name"],
      ["عنوان السكن الحالي", "residence_address"],
      ["رقم الاستمارة", "residence_form_no"],
      ["رقم بطاقة السكن", "residence_card_no"],
      ["تاريخ الإصدار", "residence_card_issue_date"],
    ],
    attachments: [
      ["الوجه الأمامي", "residence_card_front_path", "residence_card_front_full_path"],
      ["الوجه الخلفي", "residence_card_back_path", "residence_card_back_full_path"],
    ],
  },
  {
    id: "ration",
    title: "البطاقة التموينية الإلكترونية",
    fields: [
      ["رقم البطاقة التموينية", "ration_card_no"],
      ["اسم رب الأسرة", "ration_center_name"],
    ],
    attachmentList: ["ration_card_attachment_paths", "ration_card_attachment_full_paths"],
  },
  {
    id: "airport",
    title: "باج دخول مطار بغداد",
    fields: [
      ["تاريخ الإصدار", "airport_badge_issue_date"],
      ["تاريخ النفاذ", "airport_badge_expiry"],
      ["رقم الهوية", "airport_badge_no"],
    ],
    attachments: [
      ["الوجه الأمامي", "airport_badge_front_path", "airport_badge_front_full_path"],
      ["الوجه الخلفي", "airport_badge_back_path", "airport_badge_back_full_path"],
    ],
  },
  {
    id: "ministry",
    title: "هوية وزارة النقل",
    fields: [
      ["تاريخ الإصدار", "ministry_badge_issue_date"],
      ["تاريخ النفاذ", "ministry_badge_expiry"],
      ["رقم الهوية", "ministry_badge_no"],
    ],
    attachments: [
      ["الوجه الأمامي", "ministry_badge_front_path", "ministry_badge_front_full_path"],
      ["الوجه الخلفي", "ministry_badge_back_path", "ministry_badge_back_full_path"],
    ],
  },
];

function printableAttachment(label, path, fullPath) {
  if (!path || !fullPath) {
    return "";
  }
  const name = path.split(/[/\\]/).pop();
  const extension = name?.split(".").pop()?.toLowerCase();
  const assetUrl = convertFileSrc(fullPath);
  const content = ["jpg", "jpeg"].includes(extension)
    ? `<img src="${escHtml(assetUrl)}" alt="${escHtml(label)}" />`
    : extension === "pdf"
      ? `<object data="${escHtml(assetUrl)}" type="application/pdf"></object>`
      : "";
  return content ? `<div class="print-attachment">${content}</div>` : "";
}

function printablePersonalPhoto(emp) {
  if (!emp?.photo_full_path) return "";
  const assetUrl = convertFileSrc(emp.photo_full_path);
  return `<section class="print-document print-photo-document" data-print-section="photo">
    <div class="print-photo-wrap">
      <img src="${escHtml(assetUrl)}" alt="الصورة الشخصية" />
    </div>
  </section>`;
}

function parseFamilyMembers(emp) {
  try { return JSON.parse(emp?.family_members ?? "[]"); }
  catch { return []; }
}

function spouseSectionConfig(emp) {
  if (!["متزوج", "أرمل", "ارمل"].includes(emp?.marital_status)) return null;
  if (emp?.gender === "ذكر") {
    return { title: "معلومات الزوجات", itemLabel: "زوجة", addLabel: "إضافة زوجة", emptyLabel: "لا توجد زوجات مسجلات", max: 4, defaultGender: "أنثى" };
  }
  if (emp?.gender === "أنثى") {
    return { title: "معلومات الزوج", itemLabel: "زوج", addLabel: "إضافة زوج", emptyLabel: "لا يوجد زوج مسجل", max: 1, defaultGender: "ذكر" };
  }
  return null;
}

function spouseSectionHtml(emp) {
  const config = spouseSectionConfig(emp);
  if (!config) return "";
  return `
    ${sectionTitle(config.title)}
    <div style="grid-column:span 2">
      <div id="spouse-list"></div>
      <button id="btn-add-spouse" class="btn-secondary text-sm mt-2">+ ${config.addLabel}</button>
    </div>`;
}

function printableFamilyNationalCards(emp) {
  return parseFamilyMembers(emp).map((member, index) => {
    const label = member?.name || `فرد ${index + 1}`;
    const attachments = [
      ["الوجه الأمامي", member?.national_card_front_path, member?.national_card_front_full_path],
      ["الوجه الخلفي", member?.national_card_back_path, member?.national_card_back_full_path],
    ].map(([sideLabel, path, fullPath]) => printableAttachment(`${label} - ${sideLabel}`, path, fullPath)).join("");
    return attachments ? `<section class="print-document" data-print-section="family-national-card-${index}">${attachments}</section>` : "";
  }).join("");
}

function printableSpouseNationalCards(emp) {
  const config = spouseSectionConfig(emp);
  if (!config) return "";
  return spouseListFromEmployee(emp).map((spouse, index) => {
    const label = spouse?.name || `${config.itemLabel} ${index + 1}`;
    const attachments = [
      ["الوجه الأمامي", spouse?.national_card_front_path, spouse?.national_card_front_full_path],
      ["الوجه الخلفي", spouse?.national_card_back_path, spouse?.national_card_back_full_path],
    ].map(([sideLabel, path, fullPath]) => printableAttachment(`${label} - ${sideLabel}`, path, fullPath)).join("");
    return attachments ? `<section class="print-document" data-print-section="spouse-national-card-${index}">${attachments}</section>` : "";
  }).join("");
}

function printableSection(definition, emp) {
  if (definition.render) return definition.render(emp);
  let attachments = definition.attachments ?? [];
  if (definition.attachmentList) {
    let paths = [];
    try { paths = JSON.parse(emp?.[definition.attachmentList[0]] ?? "[]"); } catch {}
    const fullPaths = emp?.[definition.attachmentList[1]] ?? [];
    attachments = paths.length
      ? paths.map((path, index) => [`المرفق ${index + 1}`, path, fullPaths[index]])
      : [["المرفق", null, null]];
  }
  const content = attachments.map(([label, pathKey, fullPathKey]) => printableAttachment(
        label,
        definition.attachments ? emp?.[pathKey] : pathKey,
        definition.attachments ? emp?.[fullPathKey] : fullPathKey,
      )).join("");
  return content ? `<section class="print-document" data-print-section="${definition.id}">${content}</section>` : "";
}

function printableDefinitionTitle(definition, emp) {
  if (definition.id === "spouse-national-cards") {
    const config = spouseSectionConfig(emp);
    return config?.max === 1 ? "البطاقة الوطنية للزوج" : "البطاقة الوطنية للزوجات";
  }
  return definition.title;
}

function visiblePrintableDocumentDefinitions(emp) {
  return printableDocumentDefinitions.filter(definition => definition.id !== "spouse-national-cards" || spouseSectionConfig(emp));
}

function printableDocumentsHtml(emp, selectedIds) {
  const sections = visiblePrintableDocumentDefinitions(emp)
    .filter(definition => selectedIds.has(definition.id))
    .map(definition => printableSection(definition, emp))
    .join("");
  return `<div class="print-page" dir="rtl">${sections || `<p class="print-no-selection">لا توجد مرفقات محددة للطباعة</p>`}</div>`;
}

const printableDocumentsCss = `
  *{box-sizing:border-box} body{margin:0;background:#d1d5db;font-family:Arial,sans-serif;color:#111827}
  .print-page{width:210mm;min-height:297mm;margin:12px auto;padding:10mm;background:#fff;box-shadow:0 3px 18px rgba(0,0,0,.2)}
  .print-document{display:grid;grid-template-columns:1fr 1fr;gap:8mm;margin:0 0 8mm;break-inside:avoid;page-break-inside:avoid}
  .print-attachment{min-height:50mm;text-align:center;overflow:hidden;break-inside:avoid;page-break-inside:avoid}
  .print-attachment img,.print-attachment object{display:block;width:100%;height:auto;max-height:125mm;object-fit:contain}
  .print-attachment object{height:115mm}
  .print-photo-document{display:flex;justify-content:center}
  .print-photo-wrap{width:45mm;text-align:center}
  .print-photo-wrap img{display:block;width:45mm;height:55mm;object-fit:cover;border:1px solid #d1d5db}
  .print-no-selection{text-align:center;padding:50px;color:#6b7280}
  @page{size:A4;margin:0}@media print{body{background:#fff}.print-page{margin:0;box-shadow:none;width:210mm;min-height:297mm}}
`;

async function printSelectedDocuments(emp, selectedIds) {
  const documentNames = visiblePrintableDocumentDefinitions(emp).filter(definition => selectedIds.has(definition.id)).map(definition => printableDefinitionTitle(definition, emp));
  await api.printEmployeeDocuments(emp.id, documentNames);
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;right:-9999px";
  document.body.append(frame);
  const doc = frame.contentDocument;
  doc.open();
  doc.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><title>مستمسكات ${escHtml(emp.full_name)}</title><style>${printableDocumentsCss}</style></head><body>${printableDocumentsHtml(emp, selectedIds)}</body></html>`);
  doc.close();
  const removeFrame = () => frame.isConnected && frame.remove();
  frame.contentWindow.addEventListener("afterprint", removeFrame, { once: true });
  setTimeout(() => {
    frame.contentWindow.focus();
    frame.contentWindow.print();
  }, 800);
  setTimeout(removeFrame, 60000);
}

function openDocumentsPrintDialog(emp) {
  const overlay = document.createElement("div");
  overlay.setAttribute("dir", "rtl");
  overlay.style.cssText = "position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.72);display:flex;flex-direction:column";
  overlay.innerHTML = `
    <div style="height:64px;background:#1f1f1f;border-bottom:1px solid #333;display:flex;align-items:center;gap:10px;padding:10px 18px">
      <strong style="font-size:16px;margin-left:auto">طباعة مستمسكات ${escHtml(emp.full_name)}</strong>
      <button type="button" id="docs-print" class="btn-primary">طباعة</button>
      <button type="button" id="docs-print-close" class="btn-secondary">إغلاق</button>
    </div>
    <div style="display:grid;grid-template-columns:260px 1fr;min-height:0;flex:1">
      <aside style="background:#181818;border-left:1px solid #333;padding:16px;overflow:auto">
        <p style="font-size:12px;color:#9ca3af;margin-bottom:12px">أزل التأشير عن المستمسكات التي لا تريد ظهورها في الطباعة.</p>
        ${visiblePrintableDocumentDefinitions(emp).map(definition => `
          <label style="display:flex;align-items:center;gap:8px;padding:9px 6px;border-bottom:1px solid #2d2d2d;cursor:pointer">
            <input type="checkbox" class="docs-print-choice" value="${definition.id}" checked style="width:16px;height:16px;accent-color:#5da12c" />
            <span style="font-size:13px;color:#e5e7eb">${escHtml(printableDefinitionTitle(definition, emp))}</span>
          </label>`).join("")}
      </aside>
      <main id="docs-print-preview" style="overflow:auto;background:#555;padding:18px"></main>
    </div>`;
  document.body.append(overlay);

  const selectedIds = () => new Set([...overlay.querySelectorAll(".docs-print-choice:checked")].map(input => input.value));
  const renderPreview = () => {
    const preview = overlay.querySelector("#docs-print-preview");
    preview.innerHTML = `<iframe title="معاينة مستمسكات الموظف" style="display:block;width:100%;height:100%;min-height:700px;border:0;background:#d1d5db"></iframe>`;
    preview.querySelector("iframe").srcdoc = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><style>${printableDocumentsCss}</style></head><body>${printableDocumentsHtml(emp, selectedIds())}</body></html>`;
  };
  overlay.querySelector("#docs-print").addEventListener("click", async () => {
    try { await printSelectedDocuments(emp, selectedIds()); }
    catch (error) { showToast(error?.message ?? "غير مصرح بالطباعة", "error"); }
  });
  overlay.querySelector("#docs-print-close").addEventListener("click", () => overlay.remove());
  overlay.querySelectorAll(".docs-print-choice").forEach(input => input.addEventListener("change", renderPreview));
  renderPreview();
}

// ── Tabs ────────────────────────────────────────────────────────────────────
const TABS = [
  { id: "basic",       label: "💼 المعلومات الوظيفية" },
  { id: "documents",   label: "🪪 المستمسكات" },
  { id: "family",      label: "👨‍👩‍👧 أفراد الأسرة" },
  { id: "vehicle",     label: "🚗 معلومات المركبة" },
];

function tabContent(tab, emp) {
  switch(tab) {
    case "basic": return `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        ${sectionTitle("المعلومات الشخصية")}
        ${field("الاسم الرباعي واللقب *", "full_name", emp, {span:true})}
        ${field("اسم الأم الرباعي واللقب", "mother_name", emp, {span:true})}
        ${field("الجنس", "gender", emp, {type:"select", options:[["","—"],["ذكر","ذكر"],["أنثى","أنثى"]]})}
        ${field("الحالة الاجتماعية", "marital_status", emp, {type:"select", options:[["","—"],["أعزب","أعزب"],["متزوج","متزوج"],["مطلق","مطلق"],["أرمل","أرمل"]]})}
        ${field("مواليد الأب ومحل الولادة", "father_birthplace", emp)}
        ${field("مواليد الأم ومحل الولادة", "mother_birthplace", emp)}
        ${field("فصيلة الدم", "blood_type", emp, {type:"select", options:[["","—"],["A+","A+"],["A-","A-"],["B+","B+"],["B-","B-"],["AB+","AB+"],["AB-","AB-"],["O+","O+"],["O-","O-"]]})}
        ${field("رقم الهاتف", "phone", emp, {ltr:true})}
        ${field("البريد الإلكتروني", "email", emp, {ltr:true})}
        ${sectionTitle("بيانات التوظيف")}
        ${fixedCompanyField("مكان العمل", "workplace", _companyConfig?.company_name ?? emp?.workplace ?? "")}
        ${field("العنوان الوظيفي", "job_title", emp)}
        ${field("الدرجة الوظيفية", "job_grade", emp)}
        ${field("\u062a\u0627\u0631\u064a\u062e \u0627\u0644\u062a\u0639\u064a\u064a\u0646", "appointment_date", emp, {date:true})}
        ${fixedCompanyField("القسم", "department", _companyConfig?.department_name ?? emp?.department ?? "")}
        ${fixedCompanyField("الشعبة / الوحدة", "division", _companyConfig?.division_name ?? emp?.division ?? "")}
        ${field("تاريخ المباشرة", "hire_date", emp, {date:true})}
        ${field("نوع التوظيف", "contract_type", emp, {type:"select", options:[["","—"],["ملاك","ملاك"],["عقد","عقد"],["تنسيب","تنسيب"],["تكليف","تكليف"],["اجر يومي","اجر يومي"]]})}
        ${field("نظام العمل", "work_schedule", emp, {type:"select", options:[["","—"],["صباحي","صباحي"],["مناوب مسائي","مناوب مسائي"]]})}
        ${field("ملاحظات نوع التوظيف", "work_type_notes", emp, {type:"textarea", span:true})}
        ${sectionTitle("التحصيل الدراسي")}
        ${field("التحصيل الدراسي", "education_level", emp, {type:"select", options:[["","—"],["ابتدائية","ابتدائية"],["متوسطة","متوسطة"],["إعدادية","إعدادية"],["دبلوم","دبلوم"],["بكالوريوس","بكالوريوس"],["ماجستير","ماجستير"],["دكتوراه","دكتوراه"]]})}
        ${field("التخصص", "specialization", emp)}
        ${field("سنة التخرج", "graduation_year", emp, {ltr:true})}
        ${sectionTitle("معلومات إضافية")}
        ${field("ملاحظات", "notes", emp, {type:"textarea", span:true})}
        <div style="grid-column:span 2;display:flex;align-items:center;gap:8px">
          <input id="f-is_active" type="checkbox" style="width:16px;height:16px;accent-color:#5da12c"
                 ${(!emp || emp.is_active) ? "checked" : ""} />
          <label for="f-is_active" style="font-size:14px;color:#d1d5db">موظف نشط</label>
        </div>
      </div>`;

    case "documents": return `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        ${personalPhotoDocument(emp)}
        ${sectionTitle("البطاقة الوطنية")}
        ${field("رقم البطاقة الوطنية", "civil_id", emp, {ltr:true, span:true})}
        ${field("جهة الإصدار", "civil_id_issuer", emp)}
        ${field("تاريخ الإصدار", "civil_id_issue_date", emp, {date:true})}
        ${field("تاريخ النفاذ", "civil_id_expiry_date", emp, {date:true})}
        ${field("محل الولادة", "civil_id_birthplace", emp)}
        ${field("تاريخ الولادة", "civil_id_birthdate", emp, {date:true})}
        ${field("الرقم العائلي", "civil_id_family_number", emp, {ltr:true})}
        ${sectionTitle("مرفقات البطاقة الوطنية")}
        ${sidedCardAttachment("الوجه الأمامي", "front", emp?.civil_id_front_path, emp?.civil_id_front_full_path, Boolean(emp?.id))}
        ${sidedCardAttachment("الوجه الخلفي", "back", emp?.civil_id_back_path, emp?.civil_id_back_full_path, Boolean(emp?.id))}
        ${sectionTitle("جواز السفر")}
        ${field("رقم جواز السفر", "passport_no", emp, {ltr:true})}
        ${field("نوع جواز السفر", "passport_type", emp, {type:"select", options:[["","—"],["P","P"],["D","D"],["S","S"]]})}
        ${field("الاسم حسب الجواز", "passport_name", emp, {ltr:true})}
        ${field("تاريخ الإصدار", "passport_issue_date", emp, {date:true})}
        ${field("تاريخ النفاذ", "passport_expiry_date", emp, {date:true})}
        ${sectionTitle("مرفقات جواز السفر")}
        ${passportAttachments(emp)}
        ${sectionTitle("بطاقة السكن")}
        ${field("مكتب معلومات", "residence_card_issuer", emp)}
        ${field("اسم رب الأسرة", "residence_head_name", emp)}
        ${field("عنوان السكن الحالي", "residence_address", emp)}
        ${field("رقم الاستمارة", "residence_form_no", emp, {ltr:true})}
        ${field("رقم بطاقة السكن", "residence_card_no", emp, {ltr:true})}
        ${field("تاريخ الإصدار", "residence_card_issue_date", emp, {date:true})}
        ${sectionTitle("مرفقات بطاقة السكن")}
        ${sidedCardAttachment("الوجه الأمامي", "front", emp?.residence_card_front_path, emp?.residence_card_front_full_path, Boolean(emp?.id), "residence")}
        ${sidedCardAttachment("الوجه الخلفي", "back", emp?.residence_card_back_path, emp?.residence_card_back_full_path, Boolean(emp?.id), "residence")}
        ${sectionTitle("البطاقة التموينية الالكترونية")}
        ${field("رقم البطاقة التموينية", "ration_card_no", emp, {ltr:true})}
        ${field("اسم رب الأسرة", "ration_center_name", emp)}
        ${sectionTitle("مرفقات البطاقة التموينية")}
        ${rationCardAttachments(emp)}
        ${sectionTitle("باج دخول مطار بغداد")}
        ${field("تاريخ الإصدار", "airport_badge_issue_date", emp, {date:true})}
        ${field("تاريخ النفاذ", "airport_badge_expiry", emp, {date:true})}
        ${field("رقم الهوية", "airport_badge_no", emp, {ltr:true, span:true})}
        ${sectionTitle("مرفقات باج دخول مطار بغداد")}
        ${sidedCardAttachment("الوجه الأمامي", "front", emp?.airport_badge_front_path, emp?.airport_badge_front_full_path, Boolean(emp?.id), "airport")}
        ${sidedCardAttachment("الوجه الخلفي", "back", emp?.airport_badge_back_path, emp?.airport_badge_back_full_path, Boolean(emp?.id), "airport")}
        ${sectionTitle("هوية وزارة النقل")}
        ${field("تاريخ الإصدار", "ministry_badge_issue_date", emp, {date:true})}
        ${field("تاريخ النفاذ", "ministry_badge_expiry", emp, {date:true})}
        ${field("رقم الهوية", "ministry_badge_no", emp, {ltr:true, span:true})}
        ${sectionTitle("مرفقات هوية وزارة النقل")}
        ${sidedCardAttachment("الوجه الأمامي", "front", emp?.ministry_badge_front_path, emp?.ministry_badge_front_full_path, Boolean(emp?.id), "ministry")}
        ${sidedCardAttachment("الوجه الخلفي", "back", emp?.ministry_badge_back_path, emp?.ministry_badge_back_full_path, Boolean(emp?.id), "ministry")}
      </div>`;

    case "family": return `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        ${spouseSectionHtml(emp)}
        ${sectionTitle("أفراد العائلة")}
        <div style="grid-column:span 2">
          <div id="family-list"></div>
          <button id="btn-add-member" class="btn-secondary text-sm mt-2">+ إضافة فرد</button>
        </div>
      </div>`;

    case "vehicle": return `
      <div>
        <div id="vehicle-list"></div>
        <button id="btn-add-vehicle" class="btn-secondary text-sm mt-2">+ إضافة مركبة</button>
      </div>`;

  }
}

// ── Panel render ────────────────────────────────────────────────────────────
function renderPanel(emp) {
  const panel = document.getElementById("emp-panel");
  const isNew = !emp;
  const draft = _panelDraft ?? emp ?? {};

  panel.innerHTML = `
    <!-- Header -->
    <div style="flex-shrink:0;padding:14px 20px;border-bottom:1px solid #2d2d2d;
                display:flex;align-items:center;justify-content:space-between">
      <div>
        <h3 style="font-weight:700;font-size:15px">${isNew ? "إضافة موظف جديد" : escHtml(emp.full_name)}</h3>
        ${!isNew ? `<p style="font-size:11px;color:#6b7280">${escHtml(emp.job_title??"")} ${emp.department ? "· "+escHtml(emp.department) : ""}</p>` : ""}
      </div>
      <button id="panel-close" style="color:#9ca3af;font-size:20px;background:none;border:none;cursor:pointer">✕</button>
    </div>

    <!-- Tabs -->
    <div style="flex-shrink:0;display:flex;gap:2px;padding:8px 12px;
                border-bottom:1px solid #2d2d2d;overflow-x:auto;flex-wrap:nowrap">
      ${TABS.map(t => `
        <button class="tab-btn" data-tab="${t.id}" style="
          white-space:nowrap;padding:6px 10px;border-radius:6px;font-size:12px;border:none;
          cursor:pointer;transition:all .15s;
          background:${_activeTab===t.id ? "#5da12c20" : "transparent"};
          color:${_activeTab===t.id ? "#5da12c" : "#9ca3af"};
          font-weight:${_activeTab===t.id ? "700" : "400"}">
          ${t.label}
        </button>`).join("")}
    </div>

    <!-- Tab Content -->
    <div id="tab-content" style="flex:1;overflow-y:auto;padding:16px 20px">
      ${tabContent(_activeTab, draft)}
    </div>

    <!-- Footer -->
    <div style="flex-shrink:0;padding:12px 20px;border-top:1px solid #2d2d2d;display:flex;gap:10px">
      <button id="panel-save" class="btn-primary" style="flex:1">حفظ</button>
      ${!isNew ? `<button id="panel-print-documents" class="btn-secondary" style="display:${_activeTab === "documents" ? "inline-flex" : "none"}">طباعة المستمسكات</button>` : ""}
      ${!isNew ? `<button id="panel-delete" class="btn-danger">حذف</button>` : ""}
      <button id="panel-cancel" class="btn-secondary">إلغاء</button>
    </div>`;

  // Tab switching
  panel.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      collectVisiblePanelFields(panel);
      _activeTab = btn.dataset.tab;
      panel.querySelectorAll(".tab-btn").forEach(b => {
        const active = b.dataset.tab === _activeTab;
        b.style.background = active ? "#5da12c20" : "transparent";
        b.style.color       = active ? "#5da12c"   : "#9ca3af";
        b.style.fontWeight  = active ? "700"        : "400";
      });
      document.getElementById("tab-content").innerHTML = tabContent(_activeTab, _panelDraft ?? draft);
      const printDocumentsButton = panel.querySelector("#panel-print-documents");
      if (printDocumentsButton) {
        printDocumentsButton.style.display = _activeTab === "documents" ? "inline-flex" : "none";
      }
      attachTabEvents(emp);
    });
  });

  attachTabEvents(emp);
  panel.addEventListener("input", markPanelDirty);
  panel.addEventListener("change", markPanelDirty);

  panel.querySelector("#panel-close").addEventListener("click",  () => closePanel());
  panel.querySelector("#panel-cancel").addEventListener("click", () => closePanel());
  panel.querySelector("#panel-print-documents")?.addEventListener("click", () => {
    collectVisiblePanelFields(panel);
    openDocumentsPrintDialog(_panelDraft ?? emp);
  });

  // Save
  panel.querySelector("#panel-save").addEventListener("click", async () => {
    collectVisiblePanelFields(panel);
    const g = id => _panelDraft?.[id] ?? null;

    const data = {
      full_name:             g("full_name") || "",
      mother_name:           g("mother_name"),
      father_birthplace:     g("father_birthplace"),
      mother_birthplace:     g("mother_birthplace"),
      gender:                g("gender"),
      birthdate:             g("birthdate"),
      birthplace:            g("birthplace"),
      marital_status:        g("marital_status"),
      blood_type:            g("blood_type"),
      employee_number:       g("employee_number"),
      workplace:             _companyConfig?.company_name ?? g("workplace"),
      job_title:             g("job_title"),
      job_grade:             g("job_grade"),
      appointment_date:      g("appointment_date"),
      hire_date:             g("hire_date"),
      contract_type:         g("contract_type"),
      work_schedule:         g("work_schedule"),
      work_type_notes:       g("work_type_notes"),
      department:            _companyConfig?.department_name ?? g("department"),
      division:              _companyConfig?.division_name ?? g("division"),
      phone:                 g("phone"),
      email:                 g("email"),
      education_level:       g("education_level"),
      specialization:        g("specialization"),
      graduation_year:       g("graduation_year"),
      civil_id:              g("civil_id"),
      civil_id_issuer:       g("civil_id_issuer"),
      civil_id_issue_date:   g("civil_id_issue_date"),
      civil_id_expiry_date:  g("civil_id_expiry_date"),
      civil_id_birthplace:   g("civil_id_birthplace"),
      civil_id_birthdate:    g("civil_id_birthdate"),
      civil_id_family_number:g("civil_id_family_number"),
      residence_card_no:     g("residence_card_no"),
      residence_card_issuer: g("residence_card_issuer"),
      residence_card_issue_date:g("residence_card_issue_date"),
      residence_head_name:   g("residence_head_name"),
      residence_form_no:     g("residence_form_no"),
      residence_address:     g("residence_address"),
      ration_card_no:        g("ration_card_no"),
      ration_center_name:    g("ration_center_name"),
      // Preserve legacy ration-card values that are no longer editable in the form.
      ration_center_no:      g("ration_center_no"),
      ration_card_date:      g("ration_card_date"),
      passport_no:           g("passport_no"),
      passport_type:         g("passport_type"),
      passport_name:         g("passport_name"),
      passport_issue_date:   g("passport_issue_date"),
      passport_expiry_date:  g("passport_expiry_date"),
      airport_badge_no:      g("airport_badge_no"),
      airport_badge_issue_date:g("airport_badge_issue_date"),
      airport_badge_expiry:  g("airport_badge_expiry"),
      ministry_badge_no:     g("ministry_badge_no"),
      ministry_badge_issue_date:g("ministry_badge_issue_date"),
      ministry_badge_expiry: g("ministry_badge_expiry"),
      vehicle_plate:         g("vehicle_plate"),
      vehicle_name:          g("vehicle_name"),
      // Preserve the legacy combined value while saving the new separate fields.
      vehicle_color_model:   g("vehicle_color_model"),
      vehicle_type:          g("vehicle_type"),
      vehicle_color:         g("vehicle_color"),
      vehicle_manufacture_year:g("vehicle_manufacture_year"),
      vehicle_annual_no:     g("vehicle_annual_no"),
      vehicle_annual_issue_date:g("vehicle_annual_issue_date"),
      vehicle_annual_expiry_date:g("vehicle_annual_expiry_date"),
      vehicles:               g("vehicles") || "[]",
      spouse_name:           g("spouse_name"),
      spouse_mother_name:    g("spouse_mother_name"),
      spouse_birthdate:      g("spouse_birthdate"),
      marriage_date:         g("marriage_date"),
      spouses:               g("spouses") || "[]",
      family_members:        g("family_members") || "[]",
      notes:                 g("notes"),
      is_active:             g("is_active") === 0 ? 0 : 1,
    };

    const skipConfirmation = _skipNextSaveConfirmation;
    _skipNextSaveConfirmation = false;
    if (!data.full_name) { showToast("الاسم الكامل مطلوب", "error"); return; }
    if (!skipConfirmation && !(await confirmAction(isNew ? "تأكيد إضافة الموظف؟" : "تأكيد حفظ تعديلات الموظف؟"))) return;
    try {
      if (isNew) {
        await api.createEmployee(data);
        showToast("تم إضافة الموظف بنجاح");
      } else {
        await api.updateEmployee(emp.id, data);
        showToast("تم تحديث بيانات الموظف");
      }
      _employees = await api.listEmployees();
      renderTable();
      closePanel(true);
    } catch (err) { showToast(err?.message ?? String(err || "خطأ في الحفظ"), "error"); }
  });

  // Delete
  panel.querySelector("#panel-delete")?.addEventListener("click", async () => {
    if (!(await confirmAction(`تأكيد حذف الموظف "${emp.full_name}"؟`))) return;
    try {
      await api.deleteEmployee(emp.id);
      showToast("تم حذف الموظف");
      _employees = await api.listEmployees();
      renderTable();
      closePanel(true);
    } catch (err) { showToast(err?.message ?? String(err || "خطأ"), "error"); }
  });
  applyEmployeePermissions(panel, isNew);
}

function applyEmployeePermissions(panel, isNew) {
  if (!can(_currentUser, isNew ? "employees.create" : "employees.edit")) {
    panel.querySelector("#panel-save")?.remove();
    panel.querySelectorAll("input,select,textarea").forEach(field => { field.disabled = true; });
    panel.querySelectorAll("#btn-add-spouse,#btn-add-member,#btn-add-vehicle,.btn-remove-spouse,.btn-remove-member,.btn-remove-vehicle").forEach(el => el.remove());
  }
  if (!can(_currentUser, "employees.delete")) {
    panel.querySelector("#panel-delete")?.remove();
  }
  if (isNew || !can(_currentUser, "documents.delete")) {
    panel.querySelectorAll(".btn-delete-sided-card,.btn-delete-passport,.btn-delete-ration-card,.btn-delete-family-card,.btn-delete-spouse-card").forEach(el => el.remove());
  }
  if (isNew || !can(_currentUser, "documents.upload")) {
    panel.querySelectorAll(".btn-upload-sided-card,#btn-upload-passport,#btn-upload-ration-card,.btn-upload-family-card,.btn-upload-spouse-card").forEach(el => el.remove());
  }
  if (isNew || !can(_currentUser, isNew ? "employees.create" : "employees.edit")) {
    panel.querySelector("#btn-upload-photo")?.remove();
  }
  if (!can(_currentUser, "documents.print")) panel.querySelector("#panel-print-documents")?.remove();
}

function attachTabEvents(emp) {
  const panel = document.getElementById("emp-panel");
  if (!panel) return;

  if (_activeTab === "documents" && emp) {
    api.auditDocumentView(emp.id, "employee_documents").catch(() => {});
    panel.querySelector("#btn-upload-photo")?.addEventListener("click", async () => {
      try {
        collectVisiblePanelFields(panel);
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({
          multiple: false,
          filters: [{ name: "الصورة الشخصية", extensions: ["jpg", "jpeg", "png"] }],
        });
        if (!selected) return;
        if (!(await confirmAction("تأكيد رفع الصورة الشخصية؟"))) return;
        await api.uploadEmployeePhoto(emp.id, selected);
        showToast("تم رفع الصورة الشخصية");
        await refreshDocumentAttachments(emp.id);
      } catch (err) { showToast(err?.message ?? String(err || "خطأ في رفع الصورة"), "error"); }
    });

    panel.querySelectorAll(".btn-upload-sided-card").forEach(btn => {
      btn.addEventListener("click", async () => {
        try {
          collectVisiblePanelFields(panel);
          const cardType = btn.dataset.cardType;
          const cardName = {
            residence: "بطاقة السكن",
            airport: "باج دخول مطار بغداد",
            ministry: "هوية وزارة النقل",
          }[cardType] ?? "البطاقة الوطنية";
          const { open } = await import("@tauri-apps/plugin-dialog");
          const selected = await open({
            multiple: false,
            filters: [{ name: `ملفات ${cardName}`, extensions: ["jpg", "jpeg", "pdf"] }],
          });
          if (!selected) return;
          if (!(await confirmAction(`تأكيد رفع ${btn.dataset.side === "front" ? "الوجه الأمامي" : "الوجه الخلفي"} لـ${cardName}؟`))) return;
          if (cardType === "residence") await api.uploadResidenceCardAttachment(emp.id, btn.dataset.side, selected);
          else if (cardType === "airport") await api.uploadAirportBadgeAttachment(emp.id, btn.dataset.side, selected);
          else if (cardType === "ministry") await api.uploadMinistryBadgeAttachment(emp.id, btn.dataset.side, selected);
          else await api.uploadNationalCardAttachment(emp.id, btn.dataset.side, selected);
          showToast(`تم رفع مرفق ${cardName}`);
          await refreshDocumentAttachments(emp.id);
        } catch (err) { showToast(err?.message ?? String(err || "خطأ في الرفع"), "error"); }
      });
    });

    panel.querySelectorAll(".btn-delete-sided-card").forEach(btn => {
      btn.addEventListener("click", async () => {
        const cardType = btn.dataset.cardType;
        const cardName = {
          residence: "بطاقة السكن",
          airport: "باج دخول مطار بغداد",
          ministry: "هوية وزارة النقل",
        }[cardType] ?? "البطاقة الوطنية";
        if (!(await confirmAction(`تأكيد حذف مرفق ${cardName}؟`))) return;
        try {
          collectVisiblePanelFields(panel);
          if (cardType === "residence") await api.deleteResidenceCardAttachment(emp.id, btn.dataset.side);
          else if (cardType === "airport") await api.deleteAirportBadgeAttachment(emp.id, btn.dataset.side);
          else if (cardType === "ministry") await api.deleteMinistryBadgeAttachment(emp.id, btn.dataset.side);
          else await api.deleteNationalCardAttachment(emp.id, btn.dataset.side);
          showToast(`تم حذف مرفق ${cardName}`);
          await refreshDocumentAttachments(emp.id);
        } catch (err) { showToast(err?.message ?? String(err || "خطأ في الحذف"), "error"); }
      });
    });

    panel.querySelector("#btn-upload-passport")?.addEventListener("click", async () => {
      try {
        collectVisiblePanelFields(panel);
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({
          multiple: false,
          filters: [{ name: "نسخة جواز السفر", extensions: ["jpg", "jpeg", "pdf"] }],
        });
        if (!selected) return;
        if (!(await confirmAction("تأكيد رفع نسخة جواز السفر؟"))) return;
        await api.uploadPassportAttachment(emp.id, selected);
        showToast("تم رفع نسخة جواز السفر");
        await refreshDocumentAttachments(emp.id);
      } catch (err) { showToast(err?.message ?? String(err || "خطأ في الرفع"), "error"); }
    });

    panel.querySelectorAll(".btn-delete-passport").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!(await confirmAction("تأكيد حذف مرفق جواز السفر؟"))) return;
        try {
          collectVisiblePanelFields(panel);
          await api.deletePassportAttachment(emp.id, btn.dataset.path);
          showToast("تم حذف مرفق جواز السفر");
          await refreshDocumentAttachments(emp.id);
        } catch (err) { showToast(err?.message ?? String(err || "خطأ في الحذف"), "error"); }
      });
    });

    panel.querySelector("#btn-upload-ration-card")?.addEventListener("click", async () => {
      try {
        collectVisiblePanelFields(panel);
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({
          multiple: false,
          filters: [{ name: "نسخة البطاقة التموينية", extensions: ["jpg", "jpeg", "pdf"] }],
        });
        if (!selected) return;
        if (!(await confirmAction("تأكيد رفع نسخة البطاقة التموينية؟"))) return;
        await api.uploadRationCardAttachment(emp.id, selected);
        showToast("تم رفع نسخة البطاقة التموينية");
        await refreshDocumentAttachments(emp.id);
      } catch (err) { showToast(err?.message ?? String(err || "خطأ في الرفع"), "error"); }
    });

    panel.querySelectorAll(".btn-delete-ration-card").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!(await confirmAction("تأكيد حذف مرفق البطاقة التموينية؟"))) return;
        try {
          collectVisiblePanelFields(panel);
          await api.deleteRationCardAttachment(emp.id, btn.dataset.path);
          showToast("تم حذف مرفق البطاقة التموينية");
          await refreshDocumentAttachments(emp.id);
        } catch (err) { showToast(err?.message ?? String(err || "خطأ في الحذف"), "error"); }
      });
    });
  }

  // Family tab events
  if (_activeTab === "family") {
    renderSpouseList(emp);
    panel.querySelector("#btn-add-spouse")?.addEventListener("click", () => {
      const config = spouseSectionConfig(_panelDraft ?? emp);
      if (!config) return;
      const count = panel.querySelectorAll(".spouse-row").length;
      if (count >= config.max) {
        showToast(`يمكن إضافة ${config.max} ${config.itemLabel}${config.max > 1 ? " كحد أقصى" : " فقط"}`, "error");
        return;
      }
      markPanelDirty();
      addSpouseRow(config);
    });
    renderFamilyList(emp);
    panel.querySelector("#btn-add-member")?.addEventListener("click", () => {
      markPanelDirty();
      addFamilyRow();
    });
  }

  if (_activeTab === "vehicle") {
    renderVehicleList(_panelDraft ?? emp);
    panel.querySelector("#btn-add-vehicle")?.addEventListener("click", () => {
      markPanelDirty();
      addVehicleRow();
    });
  }

  applyEmployeePermissions(panel, !emp);
}

async function refreshDocumentAttachments(employeeId) {
  _employees = await api.listEmployees();
  const updated = _employees.find(e => e.id === employeeId);
  if (!updated) return;
  _panelDraft = {
    ...updated,
    ..._panelDraft,
    photo_path: updated.photo_path,
    photo_full_path: updated.photo_full_path,
    civil_id_front_path: updated.civil_id_front_path,
    civil_id_back_path: updated.civil_id_back_path,
    civil_id_front_full_path: updated.civil_id_front_full_path,
    civil_id_back_full_path: updated.civil_id_back_full_path,
    residence_card_front_path: updated.residence_card_front_path,
    residence_card_back_path: updated.residence_card_back_path,
    residence_card_front_full_path: updated.residence_card_front_full_path,
    residence_card_back_full_path: updated.residence_card_back_full_path,
    airport_badge_front_path: updated.airport_badge_front_path,
    airport_badge_back_path: updated.airport_badge_back_path,
    airport_badge_front_full_path: updated.airport_badge_front_full_path,
    airport_badge_back_full_path: updated.airport_badge_back_full_path,
    ministry_badge_front_path: updated.ministry_badge_front_path,
    ministry_badge_back_path: updated.ministry_badge_back_path,
    ministry_badge_front_full_path: updated.ministry_badge_front_full_path,
    ministry_badge_back_full_path: updated.ministry_badge_back_full_path,
    passport_attachment_paths: updated.passport_attachment_paths,
    passport_attachment_full_paths: updated.passport_attachment_full_paths,
    ration_card_attachment_paths: updated.ration_card_attachment_paths,
    ration_card_attachment_full_paths: updated.ration_card_attachment_full_paths,
  };
  document.getElementById("tab-content").innerHTML = tabContent("documents", _panelDraft);
  attachTabEvents(updated);
}

async function refreshFamilyAttachments(employeeId) {
  _employees = await api.listEmployees();
  const updated = _employees.find(e => e.id === employeeId);
  if (!updated) return;
  _panelDraft = {
    ...updated,
    ..._panelDraft,
    family_members: updated.family_members,
  };
  document.getElementById("tab-content").innerHTML = tabContent("family", _panelDraft);
  attachTabEvents(updated);
}

async function refreshSpouseAttachments(employeeId) {
  _employees = await api.listEmployees();
  const updated = _employees.find(e => e.id === employeeId);
  if (!updated) return;
  _panelDraft = {
    ...updated,
    ..._panelDraft,
    spouses: updated.spouses,
  };
  document.getElementById("tab-content").innerHTML = tabContent("family", _panelDraft);
  attachTabEvents(updated);
}

function spouseListFromEmployee(emp) {
  const config = spouseSectionConfig(emp);
  if (!config) return [];
  let spouses = [];
  try { spouses = JSON.parse(emp?.spouses ?? "[]"); } catch {}
  if (spouses.length === 0 && (emp?.spouse_name || emp?.spouse_mother_name || emp?.spouse_birthdate || emp?.marriage_date)) {
    spouses = [{
      name: emp?.spouse_name ?? "",
      mother_name: emp?.spouse_mother_name ?? "",
      birthdate: emp?.spouse_birthdate ?? "",
      marriage_date: emp?.marriage_date ?? "",
      gender: config.defaultGender,
    }];
  }
  return spouses.slice(0, config.max);
}

function renderSpouseList(emp) {
  const container = document.getElementById("spouse-list");
  if (!container) return;
  const config = spouseSectionConfig(emp);
  if (!config) return;
  const spouses = spouseListFromEmployee(emp);
  container.innerHTML = spouses.map((spouse, index) => spouseRowHtml(spouse, index, config)).join("") ||
    `<p class="spouse-empty" style="font-size:13px;color:#6b7280;padding:8px 0">${config.emptyLabel}</p>`;
  const addButton = document.getElementById("btn-add-spouse");
  if (addButton) {
    addButton.style.display = spouses.length >= config.max ? "none" : "inline-flex";
  }

  container.querySelectorAll(".btn-remove-spouse").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!(await confirmAction("تأكيد حذف الزوجة؟"))) return;
      markPanelDirty();
      btn.closest(".spouse-row").remove();
      const addButton = document.getElementById("btn-add-spouse");
      if (addButton && container.querySelectorAll(".spouse-row").length < config.max) {
        addButton.style.display = "inline-flex";
      }
    });
  });

  container.querySelectorAll(".btn-upload-spouse-card").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (_panelDirty) {
        showToast("احفظ تعديلات الزوجات قبل رفع المرفقات", "error");
        return;
      }
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({
          multiple: false,
          filters: [{ name: "مرفق البطاقة الوطنية", extensions: ["jpg", "jpeg", "pdf"] }],
        });
        if (!selected) return;
        const sideName = btn.dataset.side === "front" ? "الوجه الأمامي" : "الوجه الخلفي";
        if (!(await confirmAction(`تأكيد رفع ${sideName} للبطاقة الوطنية للـ${config.itemLabel}؟`))) return;
        await api.uploadSpouseNationalCardAttachment(_panelDraft.id, Number(btn.dataset.spouseIndex), btn.dataset.side, selected);
        showToast(`تم رفع مرفق البطاقة الوطنية للـ${config.itemLabel}`);
        await refreshSpouseAttachments(_panelDraft.id);
      } catch (err) { showToast(err?.message ?? String(err || "خطأ في رفع المرفق"), "error"); }
    });
  });

  container.querySelectorAll(".btn-delete-spouse-card").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (_panelDirty) {
        showToast("احفظ تعديلات الزوجات قبل حذف المرفقات", "error");
        return;
      }
      const sideName = btn.dataset.side === "front" ? "الوجه الأمامي" : "الوجه الخلفي";
      if (!(await confirmAction(`تأكيد حذف ${sideName} للبطاقة الوطنية للـ${config.itemLabel}؟`))) return;
      try {
        await api.deleteSpouseNationalCardAttachment(_panelDraft.id, Number(btn.dataset.spouseIndex), btn.dataset.side);
        showToast(`تم حذف مرفق البطاقة الوطنية للـ${config.itemLabel}`);
        await refreshSpouseAttachments(_panelDraft.id);
      } catch (err) { showToast(err?.message ?? String(err || "خطأ في حذف المرفق"), "error"); }
    });
  });
}

function spouseAttachmentCard(label, side, spouse, spouseIndex, maxSpouses = 4) {
  const path = side === "front" ? spouse?.national_card_front_path : spouse?.national_card_back_path;
  const fullPath = side === "front" ? spouse?.national_card_front_full_path : spouse?.national_card_back_full_path;
  const name = path?.split(/[/\\]/).pop();
  const extension = name?.split(".").pop()?.toLowerCase();
  const assetUrl = fullPath ? convertFileSrc(fullPath) : "";
  const preview = assetUrl && ["jpg", "jpeg"].includes(extension)
    ? `<img src="${escHtml(assetUrl)}" alt="${escHtml(label)}" style="display:block;max-width:100%;height:auto;border:1px solid #2d2d2d;border-radius:6px;margin:0 auto 8px" />`
    : assetUrl && extension === "pdf"
      ? `<iframe src="${escHtml(assetUrl)}" title="${escHtml(label)}" style="display:block;width:100%;height:160px;background:#fff;border:1px solid #2d2d2d;border-radius:6px;margin-bottom:8px"></iframe>`
      : "";
  const canUpload = Boolean(_panelDraft?.id) && !_panelDirty && Number.isInteger(spouseIndex) && spouseIndex < maxSpouses;
  return `<div style="padding:9px;background:#111827;border:1px solid #2d2d2d;border-radius:8px">
    <p style="font-size:11px;font-weight:700;color:#d1d5db;margin-bottom:5px">${label}</p>
    ${preview}
    <p style="font-size:10px;color:${name ? "#9ca3af" : "#6b7280"};word-break:break-all;margin-bottom:8px">${name ? escHtml(name) : "لم يرفع ملف"}</p>
    ${canUpload ? `<div style="display:flex;gap:6px;flex-wrap:wrap">
      <button type="button" class="btn-secondary text-xs px-2 py-1 btn-upload-spouse-card" data-spouse-index="${spouseIndex}" data-side="${side}">${name ? "استبدال" : "رفع"}</button>
      ${name ? `<button type="button" class="btn-danger text-xs px-2 py-1 btn-delete-spouse-card" data-spouse-index="${spouseIndex}" data-side="${side}">حذف</button>` : ""}
    </div>` : `<p style="font-size:10px;color:#6b7280">احفظ سجل الموظف أولاً</p>`}
  </div>`;
}

function spouseRowHtml(spouse = {}, index = Date.now(), config = { itemLabel: "زوجة", defaultGender: "أنثى", max: 4 }) {
  const number = typeof index === "number" && index < 100 ? index + 1 : "";
  return `<div class="spouse-row" data-national-card-front-path="${escHtml(spouse.national_card_front_path ?? "")}" data-national-card-back-path="${escHtml(spouse.national_card_back_path ?? "")}" style="background:#181818;border:1px solid #2d2d2d;border-radius:8px;
    padding:10px;margin-bottom:8px;display:grid;grid-template-columns:1fr 1fr;gap:8px">
    <div style="grid-column:span 2;display:flex;justify-content:space-between;align-items:center">
      <p style="font-size:11px;color:#5da12c;font-weight:700">${config.itemLabel} رقم ${number}</p>
      <button class="btn-remove-spouse btn-danger" style="font-size:11px;padding:2px 8px">حذف</button>
    </div>
    <div style="grid-column:span 2">
      <p style="font-size:10px;color:#6b7280;margin-bottom:3px">رقم البطاقة الموحدة</p>
      <input class="input-field sp-civil" dir="ltr" value="${escHtml(spouse.civil_id??"")}"/>
    </div>
    <div style="grid-column:span 2">
      <p style="font-size:10px;color:#6b7280;margin-bottom:3px">الاسم الرباعي</p>
      <input class="input-field sp-name" value="${escHtml(spouse.name??"")}"/>
    </div>
    <div style="grid-column:span 2">
      <p style="font-size:10px;color:#6b7280;margin-bottom:3px">اسم الأم الثلاثي</p>
      <input class="input-field sp-mother" value="${escHtml(spouse.mother_name??"")}"/>
    </div>
    <div>
      <p style="font-size:10px;color:#6b7280;margin-bottom:3px">الجنس</p>
      <select class="input-field sp-gender">
        ${[["","—"],["ذكر","ذكر"],["أنثى","أنثى"]].map(([value, label]) =>
          `<option value="${value}" ${(spouse.gender || config.defaultGender)===value?"selected":""}>${label}</option>`).join("")}
      </select>
    </div>
    <div>
      <p style="font-size:10px;color:#6b7280;margin-bottom:3px">فصيلة الدم</p>
      <select class="input-field sp-blood">
        ${["","A+","A-","B+","B-","AB+","AB-","O+","O-"].map(b =>
          `<option ${spouse.blood_type===b?"selected":""}>${b}</option>`).join("")}
      </select>
    </div>
    <div>
      <p style="font-size:10px;color:#6b7280;margin-bottom:3px">جهة الإصدار</p>
      <input class="input-field sp-issuer" value="${escHtml(spouse.issuer??"")}"/>
    </div>
    <div>
      <p style="font-size:10px;color:#6b7280;margin-bottom:3px">تاريخ الإصدار</p>
      <input class="input-field sp-issue" type="date" value="${spouse.issue_date??""}" />
    </div>
    <div>
      <p style="font-size:10px;color:#6b7280;margin-bottom:3px">تاريخ النفاذ</p>
      <input class="input-field sp-expiry" type="date" value="${spouse.expiry_date??""}" />
    </div>
    <div>
      <p style="font-size:10px;color:#6b7280;margin-bottom:3px">محل الولادة</p>
      <input class="input-field sp-birthplace" value="${escHtml(spouse.birthplace??"")}"/>
    </div>
    <div>
      <p style="font-size:10px;color:#6b7280;margin-bottom:3px">تاريخ الولادة</p>
      <input class="input-field sp-birthdate" type="date" value="${spouse.birthdate??""}" />
    </div>
    <div style="grid-column:span 2">
      <p style="font-size:10px;color:#6b7280;margin-bottom:3px">تاريخ الزواج</p>
      <input class="input-field sp-marriage" type="date" value="${spouse.marriage_date??""}" />
    </div>
    <div style="grid-column:span 2;border-top:1px solid #2d2d2d;padding-top:8px;margin-top:2px">
      <p style="font-size:11px;color:#5da12c;font-weight:700;margin-bottom:8px">مرفقات البطاقة الوطنية</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        ${spouseAttachmentCard("الوجه الأمامي", "front", spouse, index, config.max)}
        ${spouseAttachmentCard("الوجه الخلفي", "back", spouse, index, config.max)}
      </div>
    </div>
  </div>`;
}

function addSpouseRow(config = spouseSectionConfig(_panelDraft ?? {}) ?? { defaultGender: "أنثى", itemLabel: "زوجة", max: 4 }) {
  const container = document.getElementById("spouse-list");
  if (!container) return;
  container.querySelector(".spouse-empty")?.remove();
  const div = document.createElement("div");
  div.innerHTML = spouseRowHtml({ gender: config.defaultGender }, container.querySelectorAll(".spouse-row").length, config);
  const row = div.firstElementChild;
  row.querySelector(".btn-remove-spouse").addEventListener("click", async () => {
    if (!(await confirmAction("تأكيد حذف الزوجة؟"))) return;
    markPanelDirty();
    row.remove();
    const addButton = document.getElementById("btn-add-spouse");
    if (addButton && container.querySelectorAll(".spouse-row").length < config.max) {
      addButton.style.display = "inline-flex";
    }
  });
  container.appendChild(row);
  const addButton = document.getElementById("btn-add-spouse");
  if (addButton && container.querySelectorAll(".spouse-row").length >= config.max) {
    addButton.style.display = "none";
  }
}

function renderFamilyList(emp) {
  const container = document.getElementById("family-list");
  if (!container) return;
  let members = [];
  try { members = JSON.parse(emp?.family_members ?? "[]"); } catch {}

  container.innerHTML = members.map((m, i) => familyRowHtml(m, i)).join("") ||
    `<p style="font-size:13px;color:#6b7280;padding:8px 0">لا يوجد أفراد مسجلون</p>`;

  container.querySelectorAll(".btn-remove-member").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!(await confirmAction("تأكيد حذف فرد العائلة؟"))) return;
      markPanelDirty();
      btn.closest(".family-row").remove();
    });
  });

  container.querySelectorAll(".btn-upload-family-card").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (_panelDirty) {
        showToast("احفظ تعديلات أفراد الأسرة قبل رفع المرفقات", "error");
        return;
      }
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({
          multiple: false,
          filters: [{ name: "مرفق البطاقة الوطنية", extensions: ["jpg", "jpeg", "pdf"] }],
        });
        if (!selected) return;
        const sideName = btn.dataset.side === "front" ? "الوجه الأمامي" : "الوجه الخلفي";
        if (!(await confirmAction(`تأكيد رفع ${sideName} للبطاقة الوطنية لفرد الأسرة؟`))) return;
        await api.uploadFamilyNationalCardAttachment(_panelDraft.id, Number(btn.dataset.memberIndex), btn.dataset.side, selected);
        showToast("تم رفع مرفق البطاقة الوطنية لفرد الأسرة");
        await refreshFamilyAttachments(_panelDraft.id);
      } catch (err) { showToast(err?.message ?? String(err || "خطأ في رفع المرفق"), "error"); }
    });
  });

  container.querySelectorAll(".btn-delete-family-card").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (_panelDirty) {
        showToast("احفظ تعديلات أفراد الأسرة قبل حذف المرفقات", "error");
        return;
      }
      const sideName = btn.dataset.side === "front" ? "الوجه الأمامي" : "الوجه الخلفي";
      if (!(await confirmAction(`تأكيد حذف ${sideName} للبطاقة الوطنية لفرد الأسرة؟`))) return;
      try {
        await api.deleteFamilyNationalCardAttachment(_panelDraft.id, Number(btn.dataset.memberIndex), btn.dataset.side);
        showToast("تم حذف مرفق البطاقة الوطنية لفرد الأسرة");
        await refreshFamilyAttachments(_panelDraft.id);
      } catch (err) { showToast(err?.message ?? String(err || "خطأ في حذف المرفق"), "error"); }
    });
  });
}

function familyAttachmentCard(label, side, member, memberIndex) {
  const path = side === "front" ? member?.national_card_front_path : member?.national_card_back_path;
  const fullPath = side === "front" ? member?.national_card_front_full_path : member?.national_card_back_full_path;
  const name = path?.split(/[/\\]/).pop();
  const extension = name?.split(".").pop()?.toLowerCase();
  const assetUrl = fullPath ? convertFileSrc(fullPath) : "";
  const preview = assetUrl && ["jpg", "jpeg"].includes(extension)
    ? `<img src="${escHtml(assetUrl)}" alt="${escHtml(label)}" style="display:block;max-width:100%;height:auto;border:1px solid #2d2d2d;border-radius:6px;margin:0 auto 8px" />`
    : assetUrl && extension === "pdf"
      ? `<iframe src="${escHtml(assetUrl)}" title="${escHtml(label)}" style="display:block;width:100%;height:160px;background:#fff;border:1px solid #2d2d2d;border-radius:6px;margin-bottom:8px"></iframe>`
      : "";
  const canUpload = Boolean(_panelDraft?.id) && Number.isInteger(memberIndex) && memberIndex < 100;
  return `<div style="padding:9px;background:#111827;border:1px solid #2d2d2d;border-radius:8px">
    <p style="font-size:11px;font-weight:700;color:#d1d5db;margin-bottom:5px">${label}</p>
    ${preview}
    <p style="font-size:10px;color:${name ? "#9ca3af" : "#6b7280"};word-break:break-all;margin-bottom:8px">${name ? escHtml(name) : "لم يرفع ملف"}</p>
    ${canUpload ? `<div style="display:flex;gap:6px;flex-wrap:wrap">
      <button type="button" class="btn-secondary text-xs px-2 py-1 btn-upload-family-card" data-member-index="${memberIndex}" data-side="${side}">${name ? "استبدال" : "رفع"}</button>
      ${name ? `<button type="button" class="btn-danger text-xs px-2 py-1 btn-delete-family-card" data-member-index="${memberIndex}" data-side="${side}">حذف</button>` : ""}
    </div>` : `<p style="font-size:10px;color:#6b7280">احفظ سجل الموظف أولاً</p>`}
  </div>`;
}

function familyRowHtml(m = {}, i = Date.now()) {
  return `<div class="family-row" data-national-card-front-path="${escHtml(m.national_card_front_path ?? "")}" data-national-card-back-path="${escHtml(m.national_card_back_path ?? "")}" style="background:#181818;border:1px solid #2d2d2d;border-radius:8px;
    padding:10px;margin-bottom:8px;display:grid;grid-template-columns:1fr 1fr;gap:8px">
    <div style="grid-column:span 2;display:flex;justify-content:space-between;align-items:center">
      <p style="font-size:11px;color:#5da12c;font-weight:700">فرد رقم ${typeof i === "number" && i < 100 ? i+1 : ""}</p>
      <button class="btn-remove-member btn-danger" style="font-size:11px;padding:2px 8px">حذف</button>
    </div>
    <div style="grid-column:span 2">
      <p style="font-size:10px;color:#6b7280;margin-bottom:3px">رقم البطاقة الموحدة</p>
      <input class="input-field fm-civil" dir="ltr" value="${escHtml(m.civil_id??"")}"/>
    </div>
    <div style="grid-column:span 2">
      <p style="font-size:10px;color:#6b7280;margin-bottom:3px">الاسم الرباعي</p>
      <input class="input-field fm-name" value="${escHtml(m.name??"")}"/>
    </div>
    <div>
      <p style="font-size:10px;color:#6b7280;margin-bottom:3px">الجنس</p>
      <select class="input-field fm-gender">
        ${[["","—"],["ذكر","ذكر"],["أنثى","أنثى"]].map(([value, label]) =>
          `<option value="${value}" ${m.gender===value?"selected":""}>${label}</option>`).join("")}
      </select>
    </div>
    <div>
      <p style="font-size:10px;color:#6b7280;margin-bottom:3px">فصيلة الدم</p>
      <select class="input-field fm-blood">
        ${["","A+","A-","B+","B-","AB+","AB-","O+","O-"].map(b =>
          `<option ${m.blood_type===b?"selected":""}>${b}</option>`).join("")}
      </select>
    </div>
    <div>
      <p style="font-size:10px;color:#6b7280;margin-bottom:3px">جهة الإصدار</p>
      <input class="input-field fm-issuer" value="${escHtml(m.issuer??"")}"/>
    </div>
    <div>
      <p style="font-size:10px;color:#6b7280;margin-bottom:3px">تاريخ الإصدار</p>
      <input class="input-field fm-issue" type="date" value="${m.issue_date??""}" />
    </div>
    <div>
      <p style="font-size:10px;color:#6b7280;margin-bottom:3px">تاريخ النفاذ</p>
      <input class="input-field fm-expiry" type="date" value="${m.expiry_date??""}" />
    </div>
    <div>
      <p style="font-size:10px;color:#6b7280;margin-bottom:3px">محل الولادة</p>
      <input class="input-field fm-birthplace" value="${escHtml(m.birthplace??"")}"/>
    </div>
    <div>
      <p style="font-size:10px;color:#6b7280;margin-bottom:3px">تاريخ الولادة</p>
      <input class="input-field fm-birthdate" type="date" value="${m.birthdate??""}" />
    </div>
    <div style="grid-column:span 2;border-top:1px solid #2d2d2d;padding-top:8px;margin-top:2px">
      <p style="font-size:11px;color:#5da12c;font-weight:700;margin-bottom:8px">مرفقات البطاقة الوطنية</p>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        ${familyAttachmentCard("الوجه الأمامي", "front", m, i)}
        ${familyAttachmentCard("الوجه الخلفي", "back", m, i)}
      </div>
    </div>
  </div>`;
}

function addFamilyRow() {
  const container = document.getElementById("family-list");
  if (!container) return;
  // remove "no members" text if present
  const empty = container.querySelector("p");
  if (empty) empty.remove();
  const div = document.createElement("div");
  div.innerHTML = familyRowHtml({}, Date.now());
  const row = div.firstElementChild;
  row.querySelector(".btn-remove-member").addEventListener("click", async () => {
    if (!(await confirmAction("تأكيد حذف فرد العائلة؟"))) return;
    markPanelDirty();
    row.remove();
  });
  container.appendChild(row);
}

function renderVehicleList(emp) {
  const container = document.getElementById("vehicle-list");
  if (!container) return;
  let vehicles = [];
  try { vehicles = JSON.parse(emp?.vehicles ?? "[]"); } catch {}

  container.innerHTML = vehicles.map((vehicle, index) => vehicleRowHtml(vehicle, index)).join("") ||
    `<p class="vehicle-empty" style="font-size:13px;color:#6b7280;padding:8px 0">لا توجد مركبات مسجلة</p>`;

  attachVehicleRemoveEvents(container);
}

function vehicleRowHtml(vehicle = {}, index = Date.now()) {
  const number = typeof index === "number" && index < 100 ? index + 1 : "";
  return `<div class="vehicle-row" style="background:#181818;border:1px solid #2d2d2d;border-radius:8px;
    padding:10px;margin-bottom:10px;display:grid;grid-template-columns:1fr 1fr;gap:8px">
    <div style="grid-column:span 2;display:flex;justify-content:space-between;align-items:center">
      <p style="font-size:11px;color:#5da12c;font-weight:700">مركبة رقم ${number}</p>
      <button type="button" class="btn-remove-vehicle btn-danger" style="font-size:11px;padding:2px 8px">حذف</button>
    </div>
    ${vehicleInput("رقم اللوحة", "vehicle-plate", vehicle.plate, true)}
    ${vehicleInput("العلامة التجارية للمركبة", "vehicle-brand", vehicle.brand)}
    ${vehicleInput("نوع المركبة", "vehicle-type", vehicle.type)}
    ${vehicleInput("لون المركبة", "vehicle-color", vehicle.color)}
    ${vehicleInput("رقم السنوية", "vehicle-annual-no", vehicle.annual_no, true)}
    ${vehicleInput("تاريخ الإصدار", "vehicle-issue-date", vehicle.issue_date, false, true)}
    ${vehicleInput("تاريخ النفاذ", "vehicle-expiry-date", vehicle.expiry_date, false, true)}
  </div>`;
}

function vehicleInput(label, className, value = "", ltr = false, date = false) {
  return `<div>
    <p style="font-size:10px;color:#6b7280;margin-bottom:3px">${label}</p>
    <input class="input-field ${className}" type="${date ? "date" : "text"}"
      dir="${ltr ? "ltr" : "rtl"}" value="${date ? (value ?? "") : escHtml(value ?? "")}" />
  </div>`;
}

function attachVehicleRemoveEvents(container) {
  container.querySelectorAll(".btn-remove-vehicle").forEach(button => {
    button.addEventListener("click", async () => {
      if (!(await confirmAction("تأكيد حذف المركبة؟"))) return;
      markPanelDirty();
      button.closest(".vehicle-row").remove();
      if (!container.querySelector(".vehicle-row")) {
        container.innerHTML = `<p class="vehicle-empty" style="font-size:13px;color:#6b7280;padding:8px 0">لا توجد مركبات مسجلة</p>`;
      }
    });
  });
}

function addVehicleRow() {
  const container = document.getElementById("vehicle-list");
  if (!container) return;
  container.querySelector(".vehicle-empty")?.remove();
  const wrapper = document.createElement("div");
  wrapper.innerHTML = vehicleRowHtml({}, Date.now());
  const row = wrapper.firstElementChild;
  container.appendChild(row);
  attachVehicleRemoveEvents(row);
}
