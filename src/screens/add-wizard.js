/**
 * screens/add-wizard.js — Adding an employee from the identity documents.
 *
 * «إضافة موظف» first asks how: from the documents (this wizard) or by hand (the usual form).
 * The wizard asks for one document per step. Each picked or scanned image is read on this
 * device straight away and its values appear beside it, to review and edit. Nothing is stored
 * until «حفظ الموظف»: the employee is created, then each image is uploaded with the usual
 * upload commands.
 *
 * Every value keeps where it came from (a document, the employee, or typed): a later document
 * never replaces an earlier value by itself; it shows its own reading beside it to choose.
 */
import { api } from "../api.js";
import { open } from "@tauri-apps/plugin-dialog";
import { showToast, escHtml, confirmAction } from "../utils.js";
import { joinNameParts } from "./name-fields.js";
import { mergeSides } from "./id-reader.js";

const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp"];
const NAME4 = [["first", "الاسم"], ["father", "الأب"], ["grandfather", "الجد"], ["surname", "اللقب"]];
const NAME2 = [["first", "الاسم"], ["father", "الأب"]];
const LATIN = [["given", "Given names"], ["surname", "Surname"]];
const GENDERS = ["ذكر", "أنثى"];
const BLOOD = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
const MARITAL = ["أعزب", "متزوج", "مطلق", "أرمل"];

// One step per document. Each field: target key, label, the reader's key(s), and how it is shown.
const STEPS = [
  { id: "national", title: "البطاقة الوطنية", short: "الوطنية", required: true, sides: ["front", "back"],
    hint: "ارفع الوجهين، وتظهر البيانات المقروءة بجانبهما مباشرة",
    fields: [
      { key: "full_name", label: "اسم الموظف الرباعي واللقب", name: NAME4, full: true },
      { key: "mother_name", label: "اسم الأم", name: NAME2, ocrName: { first: "mother_first", father: "mother_father" }, full: true },
      { key: "gender", label: "الجنس", ocr: "gender", options: GENDERS },
      { key: "birthdate", label: "تاريخ الولادة", ocr: "birthdate", date: true },
      { key: "birthplace", label: "محل الولادة", ocr: "birthplace" },
      { key: "blood_type", label: "فصيلة الدم", ocr: "blood_type", options: BLOOD, ltr: true },
      { key: "civil_id", label: "الرقم الوطني", ocr: "national_no", ltr: true },
      { key: "civil_id_family_number", label: "الرقم العائلي", ocr: "family_no", ltr: true },
      { key: "civil_id_issuer", label: "جهة الإصدار", ocr: "issuer" },
      { key: "civil_id_issue_date", label: "تاريخ الإصدار", ocr: "issue_date", date: true },
      { key: "civil_id_expiry_date", label: "تاريخ النفاذ", ocr: "expiry_date", date: true },
    ] },
  { id: "passport", title: "جواز السفر", short: "الجواز", sides: ["page"],
    hint: "صفحة البيانات تكفي، والشريط السفلي يُطابق المواليد والجنس",
    fields: [
      { key: "passport_name", label: "الاسم بالإنجليزية", name: LATIN, ocrName: { given: "latin_given", surname: "latin_surname" }, latin: true, full: true },
      { key: "passport_no", label: "رقم الجواز", ocr: "passport_no", ltr: true },
      { key: "passport_type", label: "نوع الجواز", ocr: "passport_type", options: ["P", "D", "S"], ltr: true },
      { key: "passport_issue_date", label: "تاريخ الإصدار", ocr: "issue_date", date: true },
      { key: "passport_expiry_date", label: "تاريخ النفاذ", ocr: "expiry_date", date: true },
      { key: "birthdate", label: "تاريخ الولادة", ocr: "birthdate", date: true },
      { key: "gender", label: "الجنس", ocr: "gender", options: GENDERS },
    ] },
  { id: "ministry", title: "هوية وزارة النقل", short: "هوية الوزارة", sides: ["front"],
    hint: "الوجه العربي يكفي: منه القسم والعنوان الوظيفي ورقم الهوية ونفاذها، ويُطابَق الاسم مع البطاقة الوطنية",
    fields: [
      { key: "job_title", label: "العنوان الوظيفي", ocr: "job_title" },
      { key: "department", label: "القسم", ocr: "department", list: "departments" },
      { key: "ministry_badge_no", label: "رقم الهوية", ocr: "doc_number", ltr: true },
      { key: "ministry_badge_issue_date", label: "تاريخ الإصدار", ocr: "issue_date", date: true },
      { key: "ministry_badge_expiry", label: "تاريخ النفاذ", ocr: "expiry_date", date: true },
    ] },
  { id: "airport", title: "باج مطار بغداد", short: "باج المطار", sides: ["front", "back"],
    hint: "الحروف أسفل الباج هي صلاحيات حامله",
    fields: [
      { key: "job_title", label: "العنوان الوظيفي", ocr: "job_title" },
      { key: "airport_badge_no", label: "رقم الباج", ocr: "doc_number", ltr: true },
      { key: "airport_badge_issue_date", label: "تاريخ الإصدار", ocr: "issue_date", date: true },
      { key: "airport_badge_expiry", label: "تاريخ النفاذ", ocr: "expiry_date", date: true },
      { key: "airport_badge_zones", label: "صلاحيات الباج", ocr: "zones", chips: true, full: true },
    ] },
  { id: "ration", title: "البطاقة التموينية", short: "التموينية", sides: ["page"],
    hint: "رقم البطاقة يُقرأ من رمز QR",
    fields: [
      { key: "ration_card_no", label: "رقم البطاقة التموينية", ocr: "ration_no", ltr: true },
      { key: "ration_center_name", label: "اسم رب الأسرة", ocr: "head_name" },
    ] },
  { id: "residence", title: "بطاقة السكن", short: "السكن", sides: ["front", "back"],
    hint: "البطاقة القديمة: يُقرأ رقمها المطبوع فقط، والباقي بخط اليد فانقله من الصورة",
    fields: [
      { key: "residence_card_no", label: "رقم بطاقة السكن", ocr: "doc_number", ltr: true },
      { key: "residence_card_issue_date", label: "تاريخ الإصدار", ocr: "issue_date", date: true },
      { key: "residence_head_name", label: "اسم رب الأسرة", ocr: "head_name" },
      { key: "residence_form_no", label: "رقم الاستمارة", ocr: "form_no", ltr: true },
      { key: "residence_address", label: "العنوان", ocr: "address", full: true },
    ] },
  { id: "family", title: "أفراد الأسرة", short: "الأسرة",
    hint: "ارفع بطاقة كل فرد. للأبناء يُنقل الأب والجد واللقب من الموظف" },
  { id: "summary", title: "الملخص والحفظ", short: "الملخص",
    hint: "أكمل ما لا يوجد في أي مستمسك، ثم احفظ" },
];
const MANUAL = [
  { key: "phone", label: "رقم الهاتف", ltr: true, placeholder: "07xx xxx xxxx" },
  { key: "email", label: "البريد الإلكتروني", ltr: true },
  { key: "hire_date", label: "تاريخ التعيين", date: true },
  { key: "department", label: "القسم", list: "departments" },
  { key: "job_title", label: "العنوان الوظيفي" },
  { key: "marital_status", label: "الحالة الاجتماعية", options: MARITAL },
];
const MEMBER_FIELDS = [
  { key: "name", label: "الاسم الرباعي واللقب", name: NAME4, full: true },
  { key: "mother_name", label: "اسم الأم", name: NAME2, ocrName: { first: "mother_first", father: "mother_father" }, full: true, spouseOnly: true },
  { key: "gender", label: "الجنس", ocr: "gender", options: GENDERS },
  { key: "birthdate", label: "تاريخ الولادة", ocr: "birthdate", date: true },
  { key: "civil_id", label: "الرقم الوطني", ocr: "national_no", ltr: true },
  { key: "blood_type", label: "فصيلة الدم", ocr: "blood_type", options: BLOOD, ltr: true },
  { key: "birthplace", label: "محل الولادة", ocr: "birthplace" },
  { key: "issuer", label: "جهة الإصدار", ocr: "issuer" },
  { key: "issue_date", label: "تاريخ الإصدار", ocr: "issue_date", date: true },
  { key: "expiry_date", label: "تاريخ النفاذ", ocr: "expiry_date", date: true },
];
const RELATIONS = [["spouse", "زوج / زوجة"], ["son", "ابن"], ["daughter", "ابنة"], ["father", "أب"], ["mother", "أم"], ["brother", "أخ"], ["sister", "أخت"], ["other", "أخرى"]];
// What the family member's «صلة القرابة» stores.
const STORED_RELATION = { son: "ابن", daughter: "ابنة", father: "أب", mother: "أم", brother: "أخ", sister: "أخت", other: "أخرى" };
const SIDE_LABEL = { front: "الوجه الأمامي", back: "الوجه الخلفي", page: "صفحة البيانات" };
const UPLOAD = {
  national: (id, side, path) => api.wizardUpload("cmd_upload_national_card_attachment", { employeeId: id, side, sourcePath: path }),
  passport: (id, _side, path) => api.wizardUpload("cmd_upload_passport_attachment", { employeeId: id, sourcePath: path }),
  ministry: (id, side, path) => api.wizardUpload("cmd_upload_ministry_badge_attachment", { employeeId: id, side, sourcePath: path }),
  airport: (id, side, path) => api.wizardUpload("cmd_upload_airport_badge_attachment", { employeeId: id, side, sourcePath: path }),
  ration: (id, _side, path) => api.wizardUpload("cmd_upload_ration_card_attachment", { employeeId: id, sourcePath: path }),
  residence: (id, side, path) => api.wizardUpload("cmd_upload_residence_card_attachment", { employeeId: id, side, sourcePath: path }),
};

const text = value => String(value ?? "").trim();
const isEmpty = value => value == null || (typeof value === "object" ? !Object.values(value).some(v => text(v)) : !text(value));
const shown = (field, value) => field.name ? joinNameParts(value, field.latin) : text(value);
const same = (field, a, b) => shown(field, a).replace(/\s+/g, " ") === shown(field, b).replace(/\s+/g, " ");

/** Values of one person: key -> { value, source, edited, unsure }. */
function model() { return {}; }

/** The reader's values for the fields, keyed by target key. */
function readingsFor(fields, result) {
  const get = key => (result?.fields ?? []).find(f => f.key === key);
  const out = {};
  for (const field of fields) {
    if (field.name) {
      const map = field.ocrName ?? Object.fromEntries(field.name.map(([part]) => [part, part]));
      const parts = {};
      let unsure = false, any = false;
      for (const [part, key] of Object.entries(map)) {
        const f = get(key);
        if (f?.value) { parts[part] = f.value; any = true; unsure ||= f.confidence < 0.8; }
      }
      if (any) out[field.key] = { value: parts, unsure };
    } else if (field.ocr) {
      const f = get(field.ocr);
      if (f?.value) out[field.key] = { value: field.chips ? f.value.split(/[,\s]+/).filter(Boolean).join(",") : f.value, unsure: f.confidence < 0.8 };
    }
  }
  return out;
}

/** Fields the card has written by hand (not read), on any side. */
const handwrittenOf = results => [...new Set(Object.values(results ?? {}).flatMap(r => r?.handwritten ?? []))];

/** Puts readings into the values: only where nothing is there yet. */
function applyReadings(values, readings, source) {
  for (const [key, reading] of Object.entries(readings)) {
    if (isEmpty(values[key]?.value)) values[key] = { value: reading.value, source, edited: false, unsure: reading.unsure };
  }
}

/**
 * An unfinished wizard, kept in memory when the wizard is closed before saving, to continue
 * later. Never written to disk (it holds identity data and card images); it ends with the
 * session: logging out, closing the app, or saving the employee.
 */
let draft = null;

function dropDraft() {
  if (!draft) return;
  revokeImages(draft.state);
  draft = null;
}

function revokeImages(state) {
  Object.values(state.docs).forEach(d => Object.values(d.images).forEach(i => URL.revokeObjectURL(i.url)));
  state.members.forEach(m => Object.values(m.images).forEach(i => URL.revokeObjectURL(i.url)));
}

/** Called on logout: a draft belongs to the session that made it. */
export function clearAddEmployeeDraft() { dropDraft(); }

export function openAddEmployee({ user, employees = [], onManual, onCreated }) {
  const canWizard = can => user?.permissions?.includes(can);
  if (!canWizard("documents.upload")) { onManual(); return; }
  const overlay = document.createElement("div");
  overlay.className = "aw-overlay";
  overlay.innerHTML = `<div class="aw-choice" dir="rtl" role="dialog" aria-modal="true" aria-label="إضافة موظف جديد">
    <div class="aw-head"><h2>إضافة موظف جديد</h2><span class="aw-sub">اختر طريقة الإدخال</span><button type="button" class="aw-close" aria-label="إغلاق">✕</button></div>
    <div class="aw-choice-grid">
      <button type="button" class="aw-choice-card is-recommended" data-choice="docs">
        <span class="aw-badge">موصى به</span>
        <span class="aw-choice-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="11" r="2"/><path d="M6 16c.6-1.4 1.5-2 2.5-2s1.9.6 2.5 2M14 10h4M14 13h4"/></svg></span>
        <b>من المستمسكات</b>
        <span class="aw-choice-text">اختر صورة كل مستمسك من الحاسبة أو امسحه، فتُملأ البيانات منه وتراجعها خطوة بخطوة.</span>
        <span class="aw-choice-foot">يبقى يدويًا: الهاتف والبريد وتاريخ التعيين</span>
      </button>
      <button type="button" class="aw-choice-card" data-choice="manual">
        <span class="aw-choice-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg></span>
        <b>إدخال يدوي</b>
        <span class="aw-choice-text">النموذج المعتاد، عندما لا تتوفر صور المستمسكات الآن. يمكنك قراءتها لاحقًا من تبويب «المستمسكات».</span>
      </button>
    </div></div>`;
  document.body.append(overlay);
  const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey, true); };
  const onKey = event => { if (event.key === "Escape") { event.stopPropagation(); close(); } };
  document.addEventListener("keydown", onKey, true);
  overlay.querySelector(".aw-close").addEventListener("click", close);
  overlay.addEventListener("click", event => { if (event.target === overlay) close(); });
  overlay.querySelector('[data-choice="manual"]').addEventListener("click", () => { close(); onManual(); });
  overlay.querySelector('[data-choice="docs"]').addEventListener("click", () => { close(); openWizard({ user, employees, onCreated }); });
  // An unfinished wizard of this user: continue it or throw it away.
  if (draft && draft.owner !== user?.username) dropDraft();
  if (draft) {
    const name = joinNameParts(draft.state.values.full_name?.value) || "بدون اسم بعد";
    const time = draft.savedAt.toLocaleTimeString("ar-IQ", { hour: "2-digit", minute: "2-digit" });
    const banner = document.createElement("div");
    banner.className = "aw-draft";
    banner.innerHTML = `<div><b>لديك إضافة لم تكتمل</b><span>${escHtml(name)} · أُغلقت الساعة ${escHtml(time)}</span></div>
      <button type="button" class="btn-primary" data-draft="resume">متابعتها</button>
      <button type="button" class="btn-secondary" data-draft="drop">حذفها</button>`;
    overlay.querySelector(".aw-choice-grid").before(banner);
    banner.querySelector('[data-draft="resume"]').addEventListener("click", () => {
      const resume = draft.state;
      draft = null;
      close();
      openWizard({ user, employees, onCreated, resume });
    });
    banner.querySelector('[data-draft="drop"]').addEventListener("click", () => { dropDraft(); banner.remove(); });
    banner.querySelector('[data-draft="resume"]').focus();
  }
  if (!draft) overlay.querySelector('[data-choice="docs"]').focus();
}

function openWizard({ user, employees, onCreated, resume = null }) {
  const state = resume ? { ...resume, saving: false } : {
    step: 0,
    values: model(),
    docs: Object.fromEntries(STEPS.filter(s => s.sides).map(s => [s.id, { images: {}, results: {}, readings: {}, skipped: false, busy: {} }])),
    members: [],
    saving: false,
  };
  const departments = [...new Set(employees.map(e => text(e.department)).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ar"));
  const overlay = document.createElement("div");
  overlay.className = "aw-overlay";
  document.body.append(overlay);
  let unlistenDrop = null;
  // `keep`: what was entered stays as a draft (in memory) to continue later.
  const close = (keep = false) => {
    if (state.employee) { keep = false; onCreated(state.employee); }
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
    unlistenDrop?.();
    if (keep && hasWork()) {
      dropDraft();
      draft = { owner: user?.username, savedAt: new Date(), state };
      showToast("حُفظت المسودة: تجدها عند «إضافة موظف» حتى تسجيل الخروج");
    } else {
      revokeImages(state);
    }
  };

  /** Leaving with entries asks what to do with them: save the employee, keep a draft, or discard. */
  function askClose() {
    if (!unsaved()) return close(false);
    if (overlay.querySelector(".aw-ask")) return;
    const missing = nationalMissing();
    const ask = htmlToNode(`<div class="aw-ask" role="alertdialog" aria-modal="true" aria-label="حفظ قبل الخروج؟">
      <div class="aw-ask-box"><h3>حفظ قبل الخروج؟</h3>
        <p>${state.employee ? "لديك تعديلات لم تُحفظ على هذا الموظف." : "لم يُحفظ هذا الموظف بعد."}${missing.length ? ` لحفظه أكمل في البطاقة الوطنية: ${missing.join("، ")}.` : ""}</p>
        <div class="aw-ask-actions">
          <button type="button" class="btn-primary" data-ask="save" ${canSaveNow() ? "" : "disabled"}>حفظ الموظف</button>
          ${state.employee ? "" : `<button type="button" class="btn-secondary" data-ask="draft">حفظ كمسودة</button>`}
          <button type="button" class="btn-secondary aw-danger" data-ask="discard">خروج دون حفظ</button>
          <button type="button" class="btn-secondary" data-ask="stay">متابعة الإدخال</button>
        </div></div></div>`);
    overlay.appendChild(ask);
    ask.addEventListener("click", event => {
      const choice = event.target.closest("[data-ask]")?.dataset.ask ?? (event.target === ask ? "stay" : null);
      if (!choice) return;
      ask.remove();
      if (choice === "save") save().then(ok => { if (ok) close(false); });
      else if (choice === "draft") close(true);
      else if (choice === "discard") close(false);
    });
    ask.querySelector(canSaveNow() ? '[data-ask="save"]' : '[data-ask="stay"]').focus();
  }
  const hasWork = () => Object.values(state.docs).some(d => Object.keys(d.images).length) || Object.keys(state.values).length > 0;
  const onKey = event => {
    if (event.key !== "Escape") return;
    const viewer = overlay.querySelector(".aw-viewer");
    if (viewer) { event.stopPropagation(); viewer.remove(); return; }
    const ask = overlay.querySelector(".aw-ask");
    if (ask) { event.stopPropagation(); ask.remove(); return; }
    if (!overlay.querySelector(".aw-busy")) { event.stopPropagation(); askClose(); }
  };

  /** Mouse-wheel zoom at the pointer (1x–8x) and drag to move, on an image inside `area`; the page
   *  does not scroll while the wheel zooms. Double-click resets. Returns { reset, zoomBy, moved }:
   *  `moved()` tells a click that ended a drag from a plain click. */
  function attachZoom(area, picture) {
    let scale = 1, x = 0, y = 0, drag = null, dragged = false;
    const apply = () => {
      picture.style.transform = scale === 1 ? "" : `translate(${x}px, ${y}px) scale(${scale})`;
      picture.classList.toggle("is-zoomed", scale > 1);
    };
    const reset = () => { scale = 1; x = 0; y = 0; apply(); };
    const zoomAt = (factor, cx, cy) => {
      const next = Math.min(8, Math.max(1, scale * factor));
      if (next === 1) return reset();
      // Keep the point under the pointer in place.
      const rect = picture.getBoundingClientRect();
      const ox = cx - (rect.left + rect.width / 2), oy = cy - (rect.top + rect.height / 2);
      x -= ox * (next / scale - 1);
      y -= oy * (next / scale - 1);
      scale = next;
      apply();
    };
    area.addEventListener("wheel", event => { event.preventDefault(); zoomAt(event.deltaY < 0 ? 1.2 : 1 / 1.2, event.clientX, event.clientY); }, { passive: false });
    picture.addEventListener("dblclick", event => { event.stopPropagation(); reset(); });
    picture.addEventListener("pointerdown", event => {
      dragged = false;
      if (scale === 1 || event.button !== 0) return;
      drag = { px: event.clientX, py: event.clientY, x, y };
      picture.setPointerCapture(event.pointerId);
      picture.classList.add("is-dragging");
    });
    picture.addEventListener("pointermove", event => {
      if (!drag) return;
      x = drag.x + event.clientX - drag.px;
      y = drag.y + event.clientY - drag.py;
      dragged ||= Math.abs(event.clientX - drag.px) + Math.abs(event.clientY - drag.py) > 3;
      apply();
    });
    const endDrag = () => { drag = null; picture.classList.remove("is-dragging"); };
    picture.addEventListener("pointerup", endDrag);
    picture.addEventListener("pointercancel", endDrag);
    const zoomBy = factor => { const r = picture.getBoundingClientRect(); zoomAt(factor, r.left + r.width / 2, r.top + r.height / 2); };
    /** Fills the area with a region of the image, given as fractions [x0, y0, x1, y1]. */
    const focusRect = ([x0, y0, x1, y1]) => {
      const pw = picture.offsetWidth, ph = picture.offsetHeight;
      const rw = Math.max((x1 - x0) * pw, 1), rh = Math.max((y1 - y0) * ph, 1);
      scale = Math.min(5, Math.max(1.5, Math.min(area.clientWidth / rw, area.clientHeight / rh) * 0.85));
      x = -((x0 + x1) / 2 - 0.5) * pw * scale;
      y = -((y0 + y1) / 2 - 0.5) * ph * scale;
      apply();
      picture.classList.add("is-focused");
      setTimeout(() => picture.classList.remove("is-focused"), 900);
    };
    return { reset, zoomBy, focusRect, moved: () => { const was = dragged; dragged = false; return was; } };
  }

  /** Full-size view of a document image, with the same zoom; closes with ×, Esc, or a click
   *  outside the image. */
  function openViewer(img) {
    overlay.querySelector(".aw-viewer")?.remove();
    const viewer = htmlToNode(`<div class="aw-viewer" role="dialog" aria-modal="true" aria-label="${img.alt}">
      <div class="aw-viewer-tools">
        <button type="button" data-zoom="in" aria-label="تكبير" title="تكبير (عجلة الماوس)">+</button>
        <button type="button" data-zoom="out" aria-label="تصغير" title="تصغير">−</button>
        <button type="button" data-zoom="reset" aria-label="الحجم الأصلي" title="الحجم الأصلي (نقر مزدوج)">⤢</button>
        <button type="button" class="aw-viewer-close" aria-label="إغلاق الصورة" title="إغلاق الصورة (Esc)">×</button>
      </div>
      <img src="${img.src}" alt="${img.alt}" draggable="false">
    </div>`);
    const zoom = attachZoom(viewer, viewer.querySelector("img"));
    viewer.querySelectorAll("[data-zoom]").forEach(b => b.addEventListener("click", () => {
      if (b.dataset.zoom === "reset") zoom.reset();
      else zoom.zoomBy(b.dataset.zoom === "in" ? 1.4 : 1 / 1.4);
    }));
    viewer.querySelector(".aw-viewer-close").addEventListener("click", () => viewer.remove());
    viewer.addEventListener("click", event => { if (!zoom.moved() && event.target === viewer) viewer.remove(); });
    overlay.appendChild(viewer);
    viewer.querySelector(".aw-viewer-close").focus();
  }
  document.addEventListener("keydown", onKey, true);

  // Dropping image files on a picture slot: the window reports the paths and where they fell.
  import("@tauri-apps/api/webview").then(({ getCurrentWebview }) => getCurrentWebview().onDragDropEvent(event => {
    if (event.payload.type !== "drop" || !overlay.isConnected) return;
    const ratio = window.devicePixelRatio || 1;
    const target = document.elementFromPoint(event.payload.position.x / ratio, event.payload.position.y / ratio)?.closest("[data-slot]");
    const path = event.payload.paths?.find(p => IMAGE_EXTENSIONS.includes(p.split(".").pop()?.toLowerCase()));
    if (target && path) useImage(target.dataset.slot, target.dataset.side, path);
  })).then(unlisten => { unlistenDrop = unlisten; }).catch(() => {});

  const current = () => STEPS[state.step];
  const zoomers = new Map();
  const filledCount = () => Object.values(state.values).filter(v => v.source && !isEmpty(v.value)).length
    + state.members.reduce((n, m) => n + Object.values(m.values).filter(v => v.source && !isEmpty(v.value)).length, 0);

  /** How far a step is filled: its own fields with a value (not those another document filled). */
  function stepFill(s) {
    if (s.id === "family") {
      const named = state.members.filter(m => !isEmpty(m.values.name?.value)).length;
      return { filled: named, total: state.members.length };
    }
    const fields = s.id === "summary" ? MANUAL : s.fields ?? [];
    const own = fields.filter(f => {
      const entry = state.values[f.key];
      if (isEmpty(entry?.value)) return false;
      return s.id === "summary" || !entry.source || entry.edited || entry.source === s.id || !STEPS.some(o => o.id === entry.source && o.id !== s.id);
    });
    return { filled: own.length, total: fields.length };
  }

  /** The side list: ✓ only when every field of the step is filled; otherwise how many are. */
  function stepperHtml() {
    return `<nav class="aw-stepper" aria-label="خطوات الإضافة"><p class="aw-stepper-title">المستمسكات بالترتيب</p>
      ${STEPS.map((s, i) => {
        const doc = state.docs[s.id];
        const { filled, total } = stepFill(s);
        const complete = total > 0 && filled === total;
        const skipped = doc?.skipped && !Object.keys(doc.images).length && !filled;
        const current = i === state.step;
        const cls = current ? "is-current" : complete ? "is-done" : filled ? "is-partial" : skipped ? "is-skipped" : "";
        const note = s.id === "family"
          ? (state.members.length ? `${state.members.length} أفراد` : "")
          : complete ? "مكتمل" : filled ? `${filled} من ${total}` : skipped ? "تُخطّي" : s.required ? "إلزامي" : "";
        return `<button type="button" class="aw-step ${cls}" data-go="${i}" ${i > 0 && !nationalDone() ? "disabled" : ""} title="${complete ? "كل حقول هذا المستمسك مملوءة" : filled ? `مُلئ ${filled} من ${total} حقول` : ""}">
          <i>${complete && !current ? "✓" : skipped && !current ? "–" : i + 1}</i><span>${s.title}</span><small>${note}</small></button>`;
      }).join("")}
      <div class="aw-progress">الخطوة ${state.step + 1} من ${STEPS.length}<div class="aw-bar"><i style="width:${(state.step + 1) / STEPS.length * 100}%"></i></div></div>
      <div class="aw-progress">مُلئ من المستمسكات: <b>${filledCount()}</b> حقلًا</div></nav>`;
  }

  /** The source tag of a field, inside a wrapper the input handler can replace. An unsure reading
   *  gets «صحيح» beside it: the user confirms it against the image without retyping it. */
  function tag(entry, here, key = "", scope = "") {
    const confirm = entry?.unsure && !entry.edited && !isEmpty(entry.value)
      ? `<button type="button" class="aw-confirm" data-confirm="${key}" data-scope="${scope}" title="قارنت القيمة بالصورة وهي صحيحة">✓ صحيح</button>` : "";
    return `<span class="aw-tag">${tagLabel(entry, here)}${confirm}</span>`;
  }

  function tagLabel(entry, here) {
    if (!entry || isEmpty(entry.value)) return `<span class="aw-src is-manual">يدوي</span>`;
    if (entry.edited) return `<span class="aw-src is-edited">معدّل يدويًا</span>`;
    if (entry.source === "employee" || entry.source === "spouse") return `<span class="aw-src is-inherited">${entry.source === "employee" ? "من الموظف" : "من الزوجة"}</span>`;
    if (entry.source === "derived") return `<span class="aw-src is-inherited">مستنتج</span>`;
    if (entry.unsure) return `<span class="aw-src is-warn">راجِع</span>`;
    const step = STEPS.find(s => s.id === entry.source);
    return `<span class="aw-src">${escHtml(entry.source === here ? "من الصورة" : step?.short ?? entry.source)}</span>`;
  }

  /** The note under a field: how this document's reading compares with the value kept. */
  function note(field, entry, reading, here, handwritten = []) {
    if (!reading && field.ocr && handwritten.includes(field.ocr) && isEmpty(entry?.value))
      return `<div class="aw-note is-warn">✍ مكتوب بخط اليد على البطاقة: انقله من الصورة</div>`;
    if (!reading) return entry?.unsure && entry.source === here ? `<div class="aw-note is-warn">⚠ القراءة غير مؤكدة، قارنها بالصورة</div>` : "";
    if (same(field, reading.value, entry?.value)) {
      if (entry?.source && entry.source !== here) return `<div class="aw-note is-ok">✓ يطابق ${escHtml(STEPS.find(s => s.id === entry.source)?.short ?? "")}</div>`;
      return entry?.unsure ? `<div class="aw-note is-warn">⚠ القراءة غير مؤكدة، قارنها بالصورة</div>` : "";
    }
    const where = entry?.edited ? "قيمتك" : `في ${escHtml(STEPS.find(s => s.id === entry?.source)?.short ?? "القيمة الحالية")}`;
    return `<div class="aw-note is-warn">⚠ هذا المستمسك يكتب «${escHtml(shown(field, reading.value))}»، و${where} «${escHtml(shown(field, entry?.value))}».
      <button type="button" class="aw-link" data-take="${field.key}">اعتماد «${escHtml(shown(field, reading.value))}»</button></div>`;
  }

  /** Format checks on identity numbers, and an employee already registered with the national number. */
  function checkHtml(key, value, scope = "") {
    const v = text(value);
    if (!v) return "";
    if (key === "civil_id") {
      if (!/^\d{12}$/.test(v)) return `<div class="aw-note is-warn">⚠ الرقم الوطني 12 رقمًا، والمكتوب ${v.replace(/\D/g, "").length} أرقام</div>`;
      const same = !scope && duplicateOf(v);
      if (same) return `<div class="aw-note is-error">⚠ يوجد موظف مسجّل بهذا الرقم الوطني: ${escHtml(same.full_name ?? "")}</div>`;
    }
    if (key === "civil_id_family_number") {
      const digits = v.replace(/\D/g, "").length;
      if (!/^[0-9A-Z]{14,22}$/.test(v) || digits < 10) return `<div class="aw-note is-warn">⚠ صيغة الرقم العائلي غير معتادة: أرقام مع حرف أو حرفين لاتينيين (14 إلى 22 خانة)</div>`;
    }
    return "";
  }
  const duplicateOf = civilId => employees.find(e => text(e.civil_id) && text(e.civil_id) === civilId);

  function fieldHtml(field, values, readings, here, scope = "", handwritten = []) {
    const entry = values[field.key];
    const id = `aw-${scope}${field.key}`;
    const value = entry?.value;
    const attrs = `data-key="${field.key}" data-scope="${scope}"`;
    let control;
    if (field.name) {
      control = `<div class="aw-name" style="--parts:${field.name.length}">${field.name.map(([part, label]) => `<label><span>${label}</span>
        <input class="input-field" ${attrs} data-part="${part}" dir="${field.latin ? "ltr" : "rtl"}" value="${escHtml(value?.[part] ?? "")}"></label>`).join("")}</div>`;
    } else if (field.options) {
      control = `<select id="${id}" class="input-field" ${attrs} ${field.ltr ? 'dir="ltr"' : ""}><option value="">—</option>${field.options.map(o => `<option ${o === value ? "selected" : ""}>${o}</option>`).join("")}${value && !field.options.includes(value) ? `<option selected>${escHtml(value)}</option>` : ""}</select>`;
    } else if (field.chips) {
      const codes = text(value).split(",").filter(Boolean);
      control = `<div class="aw-chips" data-chips="${field.key}" data-scope="${scope}">${codes.map(c => `<span class="aw-chip" dir="ltr">${escHtml(c)}<button type="button" data-chip-remove="${escHtml(c)}" aria-label="حذف ${escHtml(c)}">✕</button></span>`).join("")}
        <input class="aw-chip-input" dir="ltr" placeholder="أضف رمزًا ثم Enter" aria-label="إضافة صلاحية"></div>`;
    } else {
      control = `<input id="${id}" class="input-field" ${attrs} type="${field.date ? "date" : "text"}" dir="${field.ltr || field.date ? "ltr" : "rtl"}" value="${escHtml(value ?? "")}" placeholder="${escHtml(field.placeholder ?? "")}" ${field.list ? `list="aw-${field.list}"` : ""}>`;
    }
    return `<div class="aw-field ${field.full ? "is-full" : ""} ${isEmpty(value) && !field.name ? "is-empty" : ""}">
      <div class="aw-label"><label for="${id}">${field.label}</label>${tag(entry, here, field.key, scope)}</div>${control}${note(field, entry, readings?.[field.key], here, handwritten)}<div class="aw-check">${checkHtml(field.key, value, scope)}</div></div>`;
  }

  function slotHtml(slot, side, image, busy) {
    if (busy?.[side]) return `<div class="aw-pic is-busy"><div class="aw-drop"><span class="aw-spinner" aria-hidden="true"></span><b>جارٍ قراءة ${SIDE_LABEL[side]}…</b></div></div>`;
    if (image) return `<div class="aw-pic"><div class="aw-thumb"><img src="${image.url}" alt="${SIDE_LABEL[side]}" data-slot="${slot}" data-side="${side}"><span class="aw-thumb-cap">${SIDE_LABEL[side]}<em>${image.count ? `✓ قُرئ ${image.count}` : "لم يُقرأ شيء"}</em></span></div>
      <div class="aw-pic-actions"><button type="button" class="btn-secondary" data-pick="${slot}" data-side="${side}">استبدال</button><button type="button" class="btn-secondary" data-remove="${slot}" data-side="${side}">إزالة</button></div></div>`;
    return `<div class="aw-pic"><div class="aw-drop" data-slot="${slot}" data-side="${side}"><b>${SIDE_LABEL[side]}</b>
      <div class="aw-drop-actions"><button type="button" class="btn-primary" data-pick="${slot}" data-side="${side}">اختيار صورة من الحاسبة</button><button type="button" class="btn-secondary" data-scan="${slot}" data-side="${side}">مسح بالماسح</button></div>
      <small>أو اسحب الصورة إلى هنا · JPG · PNG · WebP</small></div></div>`;
  }

  function docBody(step) {
    const doc = state.docs[step.id];
    const readings = Object.values(doc.readings).length ? doc.readings : null;
    return `<div class="aw-pics">${step.sides.map(side => slotHtml(step.id, side, doc.images[side], doc.busy)).join("")}</div>
      <div class="aw-fields">${step.fields.map(f => fieldHtml(f, state.values, readings, step.id, "", doc.handwritten ?? [])).join("")}
      ${step.id === "national" ? "" : nameCheckHtml(doc)}
      ${(doc.warnings ?? []).map(w => `<div class="aw-field is-full aw-note is-warn">⚠ ${escHtml(w)}</div>`).join("")}</div>`;
  }

  /** A document that prints the employee's name (first, father, grandfather): compared with the
   *  name from the national card, part by part, as far as the document goes. */
  function nameCheckHtml(doc) {
    const fields = Object.values(doc.results ?? {}).flatMap(r => r.fields ?? []);
    const read = Object.fromEntries(["first", "father", "grandfather", "surname"].map(k => [k, fields.find(f => f.key === k)?.value]).filter(([, v]) => v));
    const parts = Object.keys(read);
    const kept = state.values.full_name?.value ?? {};
    if (!parts.length || isEmpty(kept)) return "";
    const norm = v => text(v).replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/[ىی]/g, "ي").replace(/\s+/g, " ");
    const shownRead = parts.map(k => read[k]).join(" ");
    const shownKept = parts.map(k => kept[k] ?? "").join(" ");
    if (parts.every(k => norm(read[k]) === norm(kept[k]))) return `<div class="aw-field is-full aw-note is-ok">✓ الاسم في هذا المستمسك «${escHtml(shownRead)}» يطابق البطاقة الوطنية</div>`;
    return `<div class="aw-field is-full aw-note is-warn">⚠ الاسم في هذا المستمسك «${escHtml(shownRead)}» يختلف عن البطاقة الوطنية «${escHtml(shownKept.trim())}»: تأكد أنه للموظف نفسه</div>`;
  }

  function memberHtml(member, index) {
    const scope = `m${index}-`;
    const fields = MEMBER_FIELDS.filter(f => !f.spouseOnly || member.relation === "spouse");
    return `<section class="aw-member"><div class="aw-member-head"><b>الفرد ${index + 1}</b>
        <label>صلة القرابة <select class="input-field" data-relation="${index}">${RELATIONS.map(([v, l]) => `<option value="${v}" ${v === member.relation ? "selected" : ""}>${l}</option>`).join("")}</select></label>
        <button type="button" class="aw-link is-danger" data-member-remove="${index}">حذف الفرد</button></div>
      <div class="aw-member-body"><div class="aw-pics is-small">${["front", "back"].map(side => slotHtml(`member:${index}`, side, member.images[side], member.busy)).join("")}</div>
      <div class="aw-fields">${fields.map(f => fieldHtml(f, member.values, Object.keys(member.readings).length ? member.readings : null, "member", scope)).join("")}</div></div></section>`;
  }

  function familyBody() {
    const spouses = state.members.filter(m => m.relation === "spouse").length;
    const marital = state.values.marital_status;
    const suggest = spouses && marital?.value !== "متزوج" && !marital?.edited
      ? `<div class="aw-banner">للموظف ${spouses === 1 ? "زوجة" : `${spouses} زوجات`}، فستُحفظ حالته الاجتماعية «متزوج». يمكنك تغييرها في الملخص.</div>` : "";
    return `<div class="aw-family">${suggest}${state.members.map(memberHtml).join("")}
      <div class="aw-add-member"><button type="button" class="btn-primary" data-member-add="card">+ فرد من بطاقته</button>
        <button type="button" class="btn-secondary" data-member-add="manual">+ فرد يدويًا</button>
        <span>بطاقة كل فرد خطوة منفصلة داخل هذه الصفحة. ${state.members.length ? "" : "إن لم يكن للموظف أسرة اضغط «تخطٍّ»."}</span></div></div>`;
  }

  function summaryBody() {
    const missing = MANUAL.filter(f => isEmpty(state.values[f.key]?.value));
    const card = (title, rows, status = "") => `<div class="aw-sum-card"><h4>${title}${status}</h4>${rows.filter(([, v]) => v).map(([k, v]) => `<div><span>${k}</span><span>${escHtml(v)}</span></div>`).join("") || `<div><span>لم يُرفع</span><span></span></div>`}</div>`;
    const v = key => shown({ name: ["full_name", "mother_name", "passport_name"].includes(key) ? NAME4 : null, latin: key === "passport_name" }, state.values[key]?.value);
    const expiry = key => {
      const date = text(state.values[key]?.value);
      if (!date) return "";
      const days = Math.round((new Date(date) - new Date()) / 86400000);
      return days < 0 ? `<span class="emp-pill bad">منتهٍ</span>` : days <= 60 ? `<span class="emp-pill warn">ينتهي بعد ${days} يومًا</span>` : `<span class="emp-pill ok">حتى ${date.slice(0, 4)}</span>`;
    };
    return `<div class="aw-summary">
      <div class="aw-manual ${missing.length ? "" : "is-done"}"><p>${missing.length ? `تبقّت ${missing.length} حقول لا توجد في المستمسكات التي رفعتها` : "كل الحقول مكتملة"}</p>
        <div class="aw-fields is-three">${MANUAL.map(f => fieldHtml(f, state.values, null, "summary")).join("")}</div></div>
      <div class="aw-sum-grid">
        ${card("البيانات الشخصية", [["الاسم", v("full_name")], ["الأم", v("mother_name")], ["الولادة", [v("birthdate"), v("birthplace")].filter(Boolean).join(" · ")], ["الجنس والدم", [v("gender"), v("blood_type")].filter(Boolean).join(" · ")]])}
        ${card("الوظيفة", [["القسم", v("department")], ["العنوان الوظيفي", v("job_title")], ["صلاحيات الباج", v("airport_badge_zones").replaceAll(",", " · ")]])}
        ${card("الأسرة", state.members.map((m, i) => [RELATIONS.find(r => r[0] === m.relation)?.[1] ?? `فرد ${i + 1}`, joinNameParts(m.values.name?.value)]))}
        ${card("البطاقة الوطنية", [["الرقم", v("civil_id")]], expiry("civil_id_expiry_date"))}
        ${card("جواز السفر", [["الرقم", v("passport_no")]], expiry("passport_expiry_date"))}
        ${card("هوية الوزارة", [["الرقم", v("ministry_badge_no")]], expiry("ministry_badge_expiry"))}
        ${card("باج المطار", [["الرقم", v("airport_badge_no")]], expiry("airport_badge_expiry"))}
        ${card("التموينية", [["الرقم", v("ration_card_no")]])}
        ${card("بطاقة السكن", [["الرقم", v("residence_card_no")]])}
      </div></div>`;
  }

  /**
   * The national card is required: the other documents open, and the employee can be saved, once
   * its essentials are in: the full four-part name, a 12-digit national number, birth date and
   * gender. Returns the labels still missing.
   */
  function nationalMissing() {
    const v = key => state.values[key]?.value;
    const name = v("full_name") ?? {};
    const missing = [];
    if (!NAME4.every(([part]) => text(name[part]))) missing.push("الاسم الرباعي واللقب");
    if (!/^\d{12}$/.test(text(v("civil_id")))) missing.push("الرقم الوطني (12 رقمًا)");
    if (!text(v("birthdate"))) missing.push("تاريخ الولادة");
    if (!text(v("gender"))) missing.push("الجنس");
    return missing;
  }
  const nationalDone = () => nationalMissing().length === 0;

  /** Saving is possible from any step once the national card is complete and nothing is being read. */
  function canSaveNow() {
    const reading = [...Object.values(state.docs), ...state.members].some(h => Object.keys(h.busy ?? {}).length);
    return !state.saving && !reading && nationalDone();
  }

  /** After an edit: unlock or lock the other steps and the save buttons without redrawing the form. */
  function refreshGate() {
    const nav = overlay.querySelector(".aw-stepper");
    if (nav) {
      nav.replaceWith(htmlToNode(stepperHtml()));
      overlay.querySelectorAll(".aw-stepper [data-go]").forEach(b => b.addEventListener("click", () => go(Number(b.dataset.go))));
    }
    const ok = canSaveNow();
    overlay.querySelectorAll("[data-save-now], [data-save]").forEach(b => { b.disabled = !ok; b.title = saveTitle(); });
    const next = overlay.querySelector("[data-next]");
    if (next) next.disabled = current().required && !nationalDone();
    const hint = overlay.querySelector(".aw-hint");
    if (hint) hint.textContent = gateHint();
  }
  const saveLabel = () => state.saving ? "جارٍ الحفظ…" : state.employee ? "حفظ التعديلات" : "حفظ الموظف";
  const saveTitle = () => {
    const missing = nationalMissing();
    if (missing.length) return `يُفعَّل بعد إكمال البطاقة الوطنية: ${missing.join("، ")}`;
    return state.employee ? "يحفظ التعديلات ويرفع المستمسكات المضافة، وتبقى الواجهة مفتوحة" : "يحفظ الموظف الآن وتبقى الواجهة مفتوحة لإكمال بقية المستمسكات";
  };
  const gateHint = () => {
    const missing = nationalMissing();
    return missing.length ? `أكمل البطاقة الوطنية لتنتقل لبقية المستمسكات وتحفظ: ${missing.join("، ")}` : "كل القيم قابلة للتعديل قبل الحفظ";
  };

  /** Documents with no image yet: named after saving, to add later. */
  const missingDocs = () => STEPS.filter(s => s.sides && !Object.keys(state.docs[s.id].images).length).map(s => s.title);

  function render() {
    const step = current();
    const body = step.id === "family" ? familyBody() : step.id === "summary" ? summaryBody() : docBody(step);
    const last = state.step === STEPS.length - 1;
    const next = STEPS[state.step + 1];
    const scroll = overlay.querySelector(".aw-content-body")?.scrollTop ?? 0;
    overlay.innerHTML = `<div class="aw-box" dir="rtl" role="dialog" aria-modal="true" aria-label="إضافة موظف من المستمسكات">
      <div class="aw-head"><h2>إضافة موظف من المستمسكات</h2><span class="aw-sub">مستمسك واحد في كل خطوة</span>
        ${state.employee ? `<span class="aw-saved" title="الموظف محفوظ؛ يمكنك متابعة إضافة مستمسكاته هنا">✓ محفوظ</span>` : ""}
        <button type="button" class="btn-primary aw-head-save" data-save-now ${canSaveNow() ? "" : "disabled"} title="${escHtml(saveTitle())}">${saveLabel()}</button>
        <button type="button" class="aw-close" aria-label="إغلاق">✕</button></div>
      <div class="aw-main">${stepperHtml()}
        <div class="aw-content"><div class="aw-content-title"><b>${step.title}</b><span>${step.hint}</span></div>
          <div class="aw-content-body ${step.sides ? "" : "is-single"}">${body}</div>
          <div class="aw-foot">
            ${last ? `<button type="button" class="btn-primary" data-save ${canSaveNow() ? "" : "disabled"} title="${escHtml(saveTitle())}">${saveLabel()}</button>`
                   : `<button type="button" class="btn-primary" data-next ${step.required && !nationalDone() ? "disabled" : ""}>التالي: ${next.title}</button>`}
            ${!step.required && !last ? `<button type="button" class="btn-secondary" data-skip>تخطٍّ</button>` : ""}
            ${state.step > 0 ? `<button type="button" class="btn-secondary" data-back>رجوع</button>` : ""}
            <span class="aw-hint">${escHtml(gateHint())}</span>
          </div></div></div>
      <datalist id="aw-departments">${departments.map(d => `<option value="${escHtml(d)}">`).join("")}</datalist></div>`;
    const content = overlay.querySelector(".aw-content-body");
    if (content) content.scrollTop = scroll;
    bind();
  }

  function valuesOf(scope) {
    if (!scope) return state.values;
    const index = Number(scope.slice(1, -1));
    return state.members[index].values;
  }

  /** Zooms the card thumbnail to where a field's value was read. */
  function showOnCard(scope, key, part) {
    const slot = scope ? `member:${Number(scope.slice(1, -1))}` : current().id;
    const { holder, fields } = slotTarget(slot);
    const field = fields.find(f => f.key === key);
    if (!field || !holder?.regions) return;
    const ocrKeys = field.name ? [ (field.ocrName ?? {})[part] ?? part ] : [field.ocr];
    for (const [side, regions] of Object.entries(holder.regions)) {
      const region = ocrKeys.map(k => regions?.[k]).find(Boolean);
      const zoom = zoomers.get(`${slot}|${side}`);
      if (region && zoom) { zoom.focusRect(region); return; }
    }
  }

  function bind() {
    overlay.querySelector(".aw-close").addEventListener("click", askClose);
    overlay.querySelector("[data-next]")?.addEventListener("click", () => go(state.step + 1));
    overlay.querySelector("[data-back]")?.addEventListener("click", () => go(state.step - 1));
    overlay.querySelector("[data-skip]")?.addEventListener("click", () => {
      const doc = state.docs[current().id];
      if (doc) doc.skipped = true;
      go(state.step + 1);
    });
    overlay.querySelector("[data-save]")?.addEventListener("click", save);
    overlay.querySelector("[data-save-now]")?.addEventListener("click", save);
    overlay.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => go(Number(b.dataset.go))));
    overlay.querySelectorAll("[data-pick]").forEach(b => b.addEventListener("click", () => pick(b.dataset.pick, b.dataset.side)));
    overlay.querySelectorAll("[data-scan]").forEach(b => b.addEventListener("click", () => scan(b.dataset.scan, b.dataset.side)));
    overlay.querySelectorAll("[data-remove]").forEach(b => b.addEventListener("click", () => removeImage(b.dataset.remove, b.dataset.side)));
    // On the thumbnail itself: wheel zooms, drag moves, double-click resets; a plain click enlarges.
    zoomers.clear();
    overlay.querySelectorAll(".aw-thumb img").forEach(img => {
      img.draggable = false;
      const zoom = attachZoom(img.closest(".aw-thumb"), img);
      zoomers.set(`${img.dataset.slot}|${img.dataset.side}`, zoom);
      // Wait a moment so a double-click (reset) does not also open the enlarged view.
      let pending = null;
      img.addEventListener("click", () => { if (!zoom.moved()) { clearTimeout(pending); pending = setTimeout(() => openViewer(img), 260); } });
      img.addEventListener("dblclick", () => clearTimeout(pending));
    });
    // Typing marks a value as the user's own: later documents never replace it by themselves.
    overlay.querySelectorAll("[data-key]").forEach(input => {
      const update = () => {
        const values = valuesOf(input.dataset.scope);
        const key = input.dataset.key;
        const before = values[key] ?? {};
        let value = input.value;
        if (input.dataset.part) value = { ...(typeof before.value === "object" ? before.value : {}), [input.dataset.part]: input.value };
        values[key] = { ...before, value, edited: !!before.source || before.edited, unsure: false, source: before.source ?? null };
        if (!before.source && !before.edited) values[key].edited = false;
        const field = input.closest(".aw-field");
        field?.querySelector(".aw-tag")?.replaceWith(htmlToNode(tag(values[key], current().id, key, input.dataset.scope)));
        const check = field?.querySelector(".aw-check");
        if (check) check.innerHTML = checkHtml(key, values[key].value, input.dataset.scope);
        field?.classList.toggle("is-empty", isEmpty(values[key].value) && !input.dataset.part);
        refreshGate();
        if (input.dataset.scope && key === "name") inheritChildNames();
      };
      input.addEventListener(input.tagName === "SELECT" ? "change" : "input", update);
    });
    overlay.querySelectorAll("[data-confirm]").forEach(b => b.addEventListener("click", () => {
      const entry = valuesOf(b.dataset.scope)[b.dataset.confirm];
      if (entry) entry.unsure = false;
      render();
    }));
    // Focusing a value to review shows where it is on the card.
    overlay.querySelectorAll("[data-key]").forEach(input => input.addEventListener("focus", () => {
      const entry = valuesOf(input.dataset.scope)[input.dataset.key];
      // A handwritten field being typed: the card zooms to it, to copy from.
      const field = !input.dataset.scope && current().fields?.find(f => f.key === input.dataset.key);
      const handwritten = field?.ocr && (state.docs[current().id]?.handwritten ?? []).includes(field.ocr);
      if (entry?.unsure || handwritten) showOnCard(input.dataset.scope, input.dataset.key, input.dataset.part);
    }));
    overlay.querySelectorAll("[data-take]").forEach(b => b.addEventListener("click", () => {
      const scope = b.closest(".aw-member") ? `m${[...overlay.querySelectorAll(".aw-member")].indexOf(b.closest(".aw-member"))}-` : "";
      const values = valuesOf(b.closest(".aw-member") ? scope : "");
      const readings = b.closest(".aw-member") ? state.members[Number(scope.slice(1, -1))].readings : state.docs[current().id].readings;
      values[b.dataset.take] = { value: readings[b.dataset.take].value, source: b.closest(".aw-member") ? "member" : current().id, edited: false, unsure: false };
      render();
    }));
    overlay.querySelectorAll("[data-chips]").forEach(box => {
      const values = valuesOf(box.dataset.scope);
      const key = box.dataset.chips;
      const set = codes => {
        const before = values[key] ?? {};
        values[key] = { ...before, value: [...new Set(codes)].join(","), edited: !!before.source, source: before.source ?? null };
        render();
      };
      const codes = () => text(values[key]?.value).split(",").filter(Boolean);
      box.querySelectorAll("[data-chip-remove]").forEach(b => b.addEventListener("click", () => set(codes().filter(c => c !== b.dataset.chipRemove))));
      const input = box.querySelector(".aw-chip-input");
      input.addEventListener("keydown", event => {
        if ((event.key === "Enter" || event.key === ",") && input.value.trim()) {
          event.preventDefault();
          set([...codes(), ...input.value.toUpperCase().split(/[,\s]+/).filter(Boolean)]);
          overlay.querySelector(".aw-chip-input")?.focus();
        } else if (event.key === "Backspace" && !input.value && codes().length) set(codes().slice(0, -1));
      });
    });
    overlay.querySelectorAll("[data-relation]").forEach(sel => sel.addEventListener("change", () => {
      const member = state.members[Number(sel.dataset.relation)];
      member.relation = sel.value;
      const gender = { son: "ذكر", father: "ذكر", brother: "ذكر", daughter: "أنثى", mother: "أنثى", sister: "أنثى" }[sel.value];
      if (gender && !member.values.gender?.edited && (isEmpty(member.values.gender?.value) || member.values.gender?.source === "derived")) {
        member.values.gender = { value: gender, source: "derived", edited: false };
      }
      inheritChildNames();
      render();
    }));
    overlay.querySelectorAll("[data-member-remove]").forEach(b => b.addEventListener("click", () => {
      state.members.splice(Number(b.dataset.memberRemove), 1);
      deriveMarital();
      render();
    }));
    overlay.querySelectorAll("[data-member-add]").forEach(b => b.addEventListener("click", () => {
      const member = { relation: "spouse", values: {}, images: {}, results: {}, readings: {}, busy: {} };
      state.members.push(member);
      deriveMarital();
      render();
      if (b.dataset.memberAdd === "card") pick(`member:${state.members.length - 1}`, "front");
    }));
  }

  const htmlToNode = html => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstChild; };

  /** Children: father, grandfather and surname come from the employee unless typed or read. */
  function inheritChildNames() {
    const parts = state.values.full_name?.value ?? {};
    for (const member of state.members) {
      if (member.relation !== "son" && member.relation !== "daughter") continue;
      const entry = member.values.name ?? { value: {}, source: "employee", edited: false };
      if (entry.edited || entry.source === "member") continue;
      member.values.name = { value: { ...entry.value, father: parts.first ?? "", grandfather: parts.father ?? "", surname: parts.surname ?? "" }, source: "employee", edited: false };
    }
  }

  function deriveMarital() {
    const spouses = state.members.filter(m => m.relation === "spouse").length;
    const entry = state.values.marital_status;
    if (entry?.edited) return;
    if (spouses) state.values.marital_status = { value: "متزوج", source: "derived", edited: false };
    else if (entry?.source === "derived") delete state.values.marital_status;
  }

  function go(index) {
    if (index < 0 || index >= STEPS.length) return;
    if (index > 0 && !nationalDone()) return;
    if (STEPS[index].id === "family") inheritChildNames();
    if (STEPS[index].id === "summary") deriveMarital();
    state.step = index;
    render();
    overlay.querySelector(".aw-content-body input, .aw-content-body button")?.focus();
  }

  // ── Images ────────────────────────────────────────────────────────────
  function slotTarget(slot) {
    if (slot.startsWith("member:")) {
      const member = state.members[Number(slot.split(":")[1])];
      return { holder: member, values: member.values, fields: MEMBER_FIELDS, source: "member" };
    }
    const step = STEPS.find(s => s.id === slot);
    return { holder: state.docs[slot], values: state.values, fields: step.fields, source: slot };
  }

  async function pick(slot, side) {
    const selected = await open({ multiple: false, filters: [{ name: "صور المستمسك", extensions: IMAGE_EXTENSIONS }] });
    if (selected) await useImage(slot, side, selected);
  }

  async function scan(slot, side) {
    try {
      const device = await api.selectScannerDevice();
      const path = await api.scanDocument(device);
      if (path) await useImage(slot, side, path);
    } catch (error) {
      showToast(error?.message ?? String(error || "تعذّر المسح الضوئي"), "error");
    }
  }

  async function useImage(slot, side, path) {
    const { holder, values, fields, source } = slotTarget(slot);
    // Each side reads on its own: the other side can be chosen while this one is read.
    holder.busy[side] = true;
    render();
    try {
      const reading = await api.readImageFields(path);
      const old = holder.images[side];
      if (old) URL.revokeObjectURL(old.url);
      const url = URL.createObjectURL(new Blob([new Uint8Array(reading.preview)], { type: "image/jpeg" }));
      holder.results[side] = reading.result;
      holder.regions = { ...(holder.regions ?? {}), [side]: reading.regions ?? {} };
      const merged = mergeSides(Object.values(holder.results));
      holder.warnings = merged.warnings;
      holder.handwritten = handwrittenOf(holder.results);
      holder.readings = readingsFor(fields, merged);
      holder.images[side] = { path, url, count: Object.keys(readingsFor(fields, reading.result)).length };
      holder.skipped = false;
      applyReadings(values, holder.readings, source);
      if (slot.startsWith("member:")) {
        const member = holder;
        const gender = values.gender?.value;
        if (member.relation === "spouse" && gender === "ذكر" && state.values.gender?.value === "ذكر") member.relation = "son";
        inheritChildNames();
        deriveMarital();
      }
      if (!holder.images[side].count) showToast("لم أتمكن من قراءة بيانات من هذه الصورة. جرّب صورة أوضح أو أدخل البيانات يدويًا.", "error");
    } catch (error) {
      showToast(error?.message ?? String(error || "تعذّرت قراءة الصورة"), "error");
    } finally {
      delete holder.busy[side];
      render();
    }
  }

  function removeImage(slot, side) {
    const { holder, fields } = slotTarget(slot);
    URL.revokeObjectURL(holder.images[side]?.url);
    delete holder.images[side];
    delete holder.results[side];
    if (holder.regions) delete holder.regions[side];
    const merged = Object.values(holder.results).length ? mergeSides(Object.values(holder.results)) : null;
    holder.readings = merged ? readingsFor(fields, merged) : {};
    holder.warnings = merged?.warnings ?? [];
    holder.handwritten = handwrittenOf(holder.results);
    render();
  }

  // ── Saving ────────────────────────────────────────────────────────────
  function payload() {
    const v = key => {
      const value = state.values[key]?.value;
      return isEmpty(value) ? null : typeof value === "object" ? value : text(value);
    };
    const names = { full_name: v("full_name"), mother_name: v("mother_name"), passport_name: v("passport_name") };
    const data = {
      full_name: joinNameParts(names.full_name),
      mother_name: joinNameParts(names.mother_name) || null,
      passport_name: joinNameParts(names.passport_name, true) || null,
      name_parts: Object.fromEntries(Object.entries(names).filter(([, parts]) => parts).map(([key, parts]) => [key, { ...parts, review: false }])),
      is_active: 1,
    };
    const plain = ["gender", "birthdate", "birthplace", "blood_type", "marital_status", "job_title", "department", "hire_date", "phone", "email",
      "civil_id", "civil_id_issuer", "civil_id_issue_date", "civil_id_expiry_date", "civil_id_family_number",
      "passport_no", "passport_type", "passport_issue_date", "passport_expiry_date",
      "ministry_badge_no", "ministry_badge_issue_date", "ministry_badge_expiry",
      "airport_badge_no", "airport_badge_issue_date", "airport_badge_expiry", "airport_badge_zones",
      "ration_card_no", "ration_center_name", "residence_card_no", "residence_card_issue_date", "residence_address",
      "residence_head_name", "residence_form_no"];
    plain.forEach(key => { data[key] = v(key); });
    // The national card's own copies of the birth data, as the form keeps them.
    data.civil_id_birthdate = data.birthdate;
    data.civil_id_birthplace = data.birthplace;
    const person = (m, spouse) => {
      const mv = key => { const value = m.values[key]?.value; return isEmpty(value) ? null : typeof value === "object" ? value : text(value); };
      const record = { name: joinNameParts(mv("name")), gender: mv("gender"), birthdate: mv("birthdate"), birthplace: mv("birthplace"), civil_id: mv("civil_id"),
        blood_type: mv("blood_type"), issuer: mv("issuer"), issue_date: mv("issue_date"), expiry_date: mv("expiry_date"), name_parts: {} };
      if (mv("name")) record.name_parts.name = { ...mv("name"), review: false };
      if (!spouse) record.relation = STORED_RELATION[m.relation] ?? "";
      if (spouse) {
        record.mother_name = joinNameParts(mv("mother_name")) || null;
        if (mv("mother_name")) record.name_parts.mother_name = { ...mv("mother_name"), review: false };
      }
      return record;
    };
    const spouses = state.members.filter(m => m.relation === "spouse");
    const family = state.members.filter(m => m.relation !== "spouse");
    data.spouses = JSON.stringify(spouses.map(m => person(m, true)));
    data.family_members = JSON.stringify(family.map(m => person(m, false)));
    return { data, spouses, family };
  }

  /** Images not uploaded yet, with how to upload each, once the employee exists. */
  function pendingUploads(id, spouses, family) {
    const out = [];
    for (const step of STEPS.filter(st => st.sides)) {
      for (const [side, image] of Object.entries(state.docs[step.id].images)) {
        if (!image.uploaded) out.push({ image, label: `${step.title} (${SIDE_LABEL[side]})`, task: () => UPLOAD[step.id](id, side, image.path) });
      }
    }
    for (const [index, member] of spouses.entries()) {
      for (const [side, image] of Object.entries(member.images)) {
        if (!image.uploaded) out.push({ image, label: `بطاقة الزوجة ${index + 1}`, task: () => api.wizardUpload("cmd_upload_spouse_national_card_attachment", { employeeId: id, spouseIndex: index, side, sourcePath: image.path }) });
      }
    }
    for (const [index, member] of family.entries()) {
      for (const [side, image] of Object.entries(member.images)) {
        if (!image.uploaded) out.push({ image, label: `بطاقة الفرد ${index + 1}`, task: () => api.wizardUpload("cmd_upload_family_national_card_attachment", { employeeId: id, memberIndex: index, side, sourcePath: image.path }) });
      }
    }
    return out;
  }

  /** Whether anything changed since the last save (or anything was entered, before the first). */
  function unsaved() {
    if (!state.employee) return hasWork();
    const { data, spouses, family } = payload();
    return JSON.stringify(data) !== state.savedData || pendingUploads(0, spouses, family).length > 0;
  }

  /**
   * Saves and stays open: the first save creates the employee, later saves update it and upload
   * only the images added since. The employee list is refreshed when the wizard closes.
   */
  async function save() {
    if (!nationalDone()) { go(0); showToast(`أكمل البطاقة الوطنية أولًا: ${nationalMissing().join("، ")}`, "error"); return false; }
    if (!state.employee) {
      const twin = duplicateOf(text(state.values.civil_id?.value));
      if (twin && !(await confirmAction(`يوجد موظف مسجّل بنفس الرقم الوطني: ${twin.full_name ?? ""}. حفظ موظف جديد رغم ذلك؟`))) return false;
    }
    const { data, spouses, family } = payload();
    state.saving = true;
    render();
    const first = !state.employee;
    try {
      state.employee = first
        ? await api.createEmployee(data)
        // Keep what the wizard does not edit (employee number, photo, …) as the record has it.
        : await api.updateEmployee(state.employee.id, { ...state.employee, ...data });
    } catch (error) {
      state.saving = false;
      render();
      showToast(error?.message ?? String(error || "تعذّر حفظ الموظف"), "error");
      return false;
    }
    state.savedData = JSON.stringify(data);
    // The pictures go in with the usual upload commands, now that the employee exists.
    const failed = [];
    for (const upload of pendingUploads(state.employee.id, spouses, family)) {
      try { await upload.task(); upload.image.uploaded = true; } catch { failed.push(upload.label); }
    }
    dropDraft();
    state.saving = false;
    render();
    const missing = missingDocs();
    const what = first ? "حُفظ الموظف" : "حُفظت التعديلات";
    if (failed.length) showToast(`${what}، لكن تعذّر رفع: ${failed.join("، ")}. اضغط «حفظ» مرة أخرى أو ارفعها من تبويب «المستمسكات».`, "error");
    else if (missing.length) showToast(`${what}. لم تُرفع بعد: ${missing.join("، ")}. أضفها الآن هنا أو لاحقًا من تبويب «المستمسكات».`);
    else showToast(`${what} ومستمسكاته`);
    return true;
  }

  render();
}
