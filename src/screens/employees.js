/**
 * screens/employees.js — Full Iraqi HR form with tabbed slide panel
 */
import { api } from "../api.js";
import { convertFileSrc } from "@tauri-apps/api/core";
import { showToast, formatDate, escHtml, debounce, confirmAction } from "../utils.js";

let _employees = [];
let _filter = "";
let _activeTab = "basic";
let _panelDraft = null;
let _panelDirty = false;

export async function renderEmployees(container, user, ctx) {
  window.autohrCanLeaveCurrentScreen = confirmLeavePanel;
  _employees = await api.listEmployees();
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
  _panelDraft = emp ? { ...emp } : { is_active: 1, family_members: "[]" };
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
  if (!force && !(await confirmLeavePanel())) return;
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

  const rows = panel.querySelectorAll(".family-row");
  if (rows.length > 0) {
    const arr = [];
    rows.forEach(row => {
      arr.push({
        name:        row.querySelector(".fm-name")?.value?.trim() || "",
        birthplace:  row.querySelector(".fm-birthplace")?.value?.trim() || "",
        civil_id:    row.querySelector(".fm-civil")?.value?.trim() || "",
        issue_date:  row.querySelector(".fm-issue")?.value || "",
        expiry_date: row.querySelector(".fm-expiry")?.value || "",
        issuer:      row.querySelector(".fm-issuer")?.value?.trim() || "",
        blood_type:  row.querySelector(".fm-blood")?.value || "",
      });
    });
    _panelDraft.family_members = JSON.stringify(arr);
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

function sectionTitle(title) {
  return `<div style="grid-column:span 2;border-bottom:1px solid #2d2d2d;padding-bottom:6px;margin-top:8px">
    <p style="font-size:12px;font-weight:700;color:#5da12c;text-transform:uppercase;letter-spacing:.08em">${title}</p>
  </div>`;
}

function sidedCardAttachment(label, side, path, fullPath, canUpload, cardType = "national") {
  const name = path?.split(/[/\\]/).pop();
  const extension = name?.split(".").pop()?.toLowerCase();
  const assetUrl = fullPath ? convertFileSrc(fullPath) : "";
  const preview = assetUrl && ["png", "jpg", "jpeg"].includes(extension)
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
  const preview = assetUrl && ["png", "jpg", "jpeg"].includes(extension)
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
  const preview = assetUrl && ["png", "jpg", "jpeg"].includes(extension)
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

// ── Tabs ────────────────────────────────────────────────────────────────────
const TABS = [
  { id: "basic",       label: "💼 المعلومات الوظيفية" },
  { id: "documents",   label: "🪪 المستمسكات" },
  { id: "family",      label: "👨‍👩‍👧 عائلة" },
  { id: "vehicle",     label: "🚗 مركبة" },
  { id: "attachments", label: "📎 مرفقات" },
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
        ${field("مكان العمل", "workplace", emp)}
        ${field("العنوان الوظيفي", "job_title", emp)}
        ${field("الدرجة الوظيفية", "job_grade", emp)}
        ${field("القسم", "department", emp)}
        ${field("الشعبة / الوحدة", "division", emp)}
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
        ${sectionTitle("باجات الدخول")}
        ${field("رقم وتاريخ باج دخول المطار", "airport_badge_no", emp, {ltr:true})}
        ${field("رقم وتاريخ باج الوزارة", "ministry_badge_no", emp, {ltr:true})}
      </div>`;

    case "family": return `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        ${sectionTitle("معلومات الزوج / الزوجة")}
        ${field("اسم الزوج/الزوجة الرباعي", "spouse_name", emp, {span:true})}
        ${field("اسم أم الزوج/الزوجة الثلاثي", "spouse_mother_name", emp, {span:true})}
        ${field("تاريخ الميلاد", "spouse_birthdate", emp, {date:true})}
        ${field("تاريخ الزواج", "marriage_date", emp, {date:true})}
        ${sectionTitle("أفراد العائلة")}
        <div style="grid-column:span 2">
          <div id="family-list"></div>
          <button id="btn-add-member" class="btn-secondary text-sm mt-2">+ إضافة فرد</button>
        </div>
      </div>`;

    case "vehicle": return `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        ${sectionTitle("معلومات المركبة")}
        ${field("رقم لوحة المركبة ومحل إصدارها", "vehicle_plate", emp, {ltr:true})}
        ${field("اسم المركبة ونوعها", "vehicle_name", emp)}
        ${field("لون المركبة وموديلها", "vehicle_color_model", emp)}
        ${field("رقم السنوية وتاريخ إصدارها", "vehicle_annual_no", emp, {ltr:true})}
      </div>`;

    case "attachments": {
      let paths = [];
      try { paths = JSON.parse(emp?.attachment_paths ?? "[]"); } catch {}
      return `
        <div class="space-y-3">
          <div class="flex justify-between items-center">
            <p style="font-size:13px;color:#9ca3af">${paths.length} مرفق(ات)</p>
            ${emp ? `<button id="btn-upload-att" class="btn-secondary text-sm px-3 py-1.5">رفع ملف…</button>` : `<p style="font-size:12px;color:#6b7280">احفظ السجل أولاً لرفع المرفقات</p>`}
          </div>
          ${paths.length === 0
            ? `<p style="text-align:center;color:#6b7280;padding:32px;font-size:14px">لا توجد مرفقات</p>`
            : paths.map(p => {
                const name = p.split(/[/\\]/).pop();
                return `<div style="display:flex;align-items:center;justify-content:space-between;
                  padding:10px 12px;background:#181818;border:1px solid #2d2d2d;border-radius:8px">
                  <span style="font-size:13px;color:#d1d5db">📄 ${escHtml(name)}</span>
                  <button class="btn-danger text-xs px-2 py-1 btn-del-att" data-path="${escHtml(p)}">حذف</button>
                </div>`;
              }).join("")}
        </div>`;
    }
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
      attachTabEvents(emp);
    });
  });

  attachTabEvents(emp);
  panel.addEventListener("input", markPanelDirty);
  panel.addEventListener("change", markPanelDirty);

  panel.querySelector("#panel-close").addEventListener("click",  () => closePanel());
  panel.querySelector("#panel-cancel").addEventListener("click", () => closePanel());

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
      workplace:             g("workplace"),
      job_title:             g("job_title"),
      job_grade:             g("job_grade"),
      hire_date:             g("hire_date"),
      contract_type:         g("contract_type"),
      work_schedule:         g("work_schedule"),
      work_type_notes:       g("work_type_notes"),
      department:            g("department"),
      division:              g("division"),
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
      passport_no:           g("passport_no"),
      passport_type:         g("passport_type"),
      passport_name:         g("passport_name"),
      passport_issue_date:   g("passport_issue_date"),
      passport_expiry_date:  g("passport_expiry_date"),
      airport_badge_no:      g("airport_badge_no"),
      ministry_badge_no:     g("ministry_badge_no"),
      vehicle_plate:         g("vehicle_plate"),
      vehicle_name:          g("vehicle_name"),
      vehicle_color_model:   g("vehicle_color_model"),
      vehicle_annual_no:     g("vehicle_annual_no"),
      spouse_name:           g("spouse_name"),
      spouse_mother_name:    g("spouse_mother_name"),
      spouse_birthdate:      g("spouse_birthdate"),
      marriage_date:         g("marriage_date"),
      family_members:        g("family_members") || "[]",
      notes:                 g("notes"),
      is_active:             g("is_active") === 0 ? 0 : 1,
    };

    if (!data.full_name) { showToast("الاسم الكامل مطلوب", "error"); return; }
    if (!(await confirmAction(isNew ? "تأكيد إضافة الموظف؟" : "تأكيد حفظ تعديلات الموظف؟"))) return;
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
}

function attachTabEvents(emp) {
  const panel = document.getElementById("emp-panel");
  if (!panel) return;

  if (_activeTab === "documents" && emp) {
    panel.querySelectorAll(".btn-upload-sided-card").forEach(btn => {
      btn.addEventListener("click", async () => {
        try {
          collectVisiblePanelFields(panel);
          const isResidence = btn.dataset.cardType === "residence";
          const cardName = isResidence ? "بطاقة السكن" : "البطاقة الوطنية";
          const { open } = await import("@tauri-apps/plugin-dialog");
          const selected = await open({
            multiple: false,
            filters: [{ name: `ملفات ${cardName}`, extensions: ["png", "jpg", "jpeg", "pdf"] }],
          });
          if (!selected) return;
          if (!(await confirmAction(`تأكيد رفع ${btn.dataset.side === "front" ? "الوجه الأمامي" : "الوجه الخلفي"} لـ${cardName}؟`))) return;
          if (isResidence) await api.uploadResidenceCardAttachment(emp.id, btn.dataset.side, selected);
          else await api.uploadNationalCardAttachment(emp.id, btn.dataset.side, selected);
          showToast(`تم رفع مرفق ${cardName}`);
          await refreshDocumentAttachments(emp.id);
        } catch (err) { showToast(err?.message ?? String(err || "خطأ في الرفع"), "error"); }
      });
    });

    panel.querySelectorAll(".btn-delete-sided-card").forEach(btn => {
      btn.addEventListener("click", async () => {
        const isResidence = btn.dataset.cardType === "residence";
        const cardName = isResidence ? "بطاقة السكن" : "البطاقة الوطنية";
        if (!(await confirmAction(`تأكيد حذف مرفق ${cardName}؟`))) return;
        try {
          collectVisiblePanelFields(panel);
          if (isResidence) await api.deleteResidenceCardAttachment(emp.id, btn.dataset.side);
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
          filters: [{ name: "نسخة جواز السفر", extensions: ["png", "jpg", "jpeg", "pdf"] }],
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
          filters: [{ name: "نسخة البطاقة التموينية", extensions: ["png", "jpg", "jpeg", "pdf"] }],
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
    renderFamilyList(emp);
    panel.querySelector("#btn-add-member")?.addEventListener("click", () => {
      markPanelDirty();
      addFamilyRow();
    });
  }

  // Attachments tab
  if (_activeTab === "attachments" && emp) {
    panel.querySelector("#btn-upload-att")?.addEventListener("click", async () => {
      try {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({ multiple: true });
        if (!selected) return;
        const files = Array.isArray(selected) ? selected : [selected];
        if (!(await confirmAction(`تأكيد رفع ${files.length} ملف(ات)؟`))) return;
        for (const f of files) {
          await api.uploadAttachment(emp.id, f);
        }
        showToast(`تم رفع ${files.length} ملف(ات)`);
        _employees = await api.listEmployees();
        const updated = _employees.find(e => e.id === emp.id);
        document.getElementById("tab-content").innerHTML = tabContent("attachments", updated);
        attachTabEvents(updated);
      } catch (err) { showToast(err?.message ?? String(err || "خطأ في الرفع"), "error"); }
    });

    panel.querySelectorAll(".btn-del-att").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!(await confirmAction("تأكيد حذف المرفق؟"))) return;
        try {
          await api.deleteAttachment(emp.id, btn.dataset.path);
          showToast("تم حذف المرفق");
          _employees = await api.listEmployees();
          const updated = _employees.find(e => e.id === emp.id);
          document.getElementById("tab-content").innerHTML = tabContent("attachments", updated);
          attachTabEvents(updated);
        } catch (err) { showToast(err?.message ?? String(err || "خطأ"), "error"); }
      });
    });
  }
}

async function refreshDocumentAttachments(employeeId) {
  _employees = await api.listEmployees();
  const updated = _employees.find(e => e.id === employeeId);
  if (!updated) return;
  _panelDraft = {
    ...updated,
    ..._panelDraft,
    civil_id_front_path: updated.civil_id_front_path,
    civil_id_back_path: updated.civil_id_back_path,
    civil_id_front_full_path: updated.civil_id_front_full_path,
    civil_id_back_full_path: updated.civil_id_back_full_path,
    residence_card_front_path: updated.residence_card_front_path,
    residence_card_back_path: updated.residence_card_back_path,
    residence_card_front_full_path: updated.residence_card_front_full_path,
    residence_card_back_full_path: updated.residence_card_back_full_path,
    passport_attachment_paths: updated.passport_attachment_paths,
    passport_attachment_full_paths: updated.passport_attachment_full_paths,
    ration_card_attachment_paths: updated.ration_card_attachment_paths,
    ration_card_attachment_full_paths: updated.ration_card_attachment_full_paths,
  };
  document.getElementById("tab-content").innerHTML = tabContent("documents", _panelDraft);
  attachTabEvents(updated);
}

function renderFamilyList(emp) {
  const container = document.getElementById("family-list");
  if (!container) return;
  let members = [];
  try { members = JSON.parse(emp?.family_members ?? "[]"); } catch {}

  container.innerHTML = members.map((m, i) => familyRowHtml(m, i)).join("") ||
    `<p style="font-size:13px;color:#6b7280;padding:8px 0">لا يوجد أفراد مسجلون</p>`;

  container.querySelectorAll(".btn-remove-member").forEach(btn => {
    btn.addEventListener("click", () => {
      markPanelDirty();
      btn.closest(".family-row").remove();
    });
  });
}

function familyRowHtml(m = {}, i = Date.now()) {
  return `<div class="family-row" style="background:#181818;border:1px solid #2d2d2d;border-radius:8px;
    padding:10px;margin-bottom:8px;display:grid;grid-template-columns:1fr 1fr;gap:8px">
    <div style="grid-column:span 2;display:flex;justify-content:space-between;align-items:center">
      <p style="font-size:11px;color:#5da12c;font-weight:700">فرد رقم ${typeof i === "number" && i < 100 ? i+1 : ""}</p>
      <button class="btn-remove-member btn-danger" style="font-size:11px;padding:2px 8px">إزالة</button>
    </div>
    <div style="grid-column:span 2">
      <p style="font-size:10px;color:#6b7280;margin-bottom:3px">الاسم الرباعي</p>
      <input class="input-field fm-name" value="${escHtml(m.name??"")}"/>
    </div>
    <div>
      <p style="font-size:10px;color:#6b7280;margin-bottom:3px">محل الولادة والتاريخ</p>
      <input class="input-field fm-birthplace" value="${escHtml(m.birthplace??"")}"/>
    </div>
    <div>
      <p style="font-size:10px;color:#6b7280;margin-bottom:3px">رقم البطاقة الموحدة</p>
      <input class="input-field fm-civil" dir="ltr" value="${escHtml(m.civil_id??"")}"/>
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
      <p style="font-size:10px;color:#6b7280;margin-bottom:3px">جهة الإصدار</p>
      <input class="input-field fm-issuer" value="${escHtml(m.issuer??"")}"/>
    </div>
    <div>
      <p style="font-size:10px;color:#6b7280;margin-bottom:3px">فصيلة الدم</p>
      <select class="input-field fm-blood">
        ${["","A+","A-","B+","B-","AB+","AB-","O+","O-"].map(b =>
          `<option ${m.blood_type===b?"selected":""}>${b}</option>`).join("")}
      </select>
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
  row.querySelector(".btn-remove-member").addEventListener("click", () => {
    markPanelDirty();
    row.remove();
  });
  container.appendChild(row);
}
