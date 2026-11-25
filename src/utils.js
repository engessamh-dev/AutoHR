/**
 * utils.js — Shared utilities
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import { COMPANY_LOGO } from "./branding.js";

// ── Toast ──────────────────────────────────────────────────────────────────
let _toastTimer = null;
export function showToast(msg, type = "info") {
  const el  = document.getElementById("toast");
  const txt = document.getElementById("toast-msg");
  if (!el || !txt) return;
  txt.textContent = msg;
  el.className = el.className
    .replace(/border-\S+/, "")
    .replace(/opacity-\d+/, "")
    .replace(/translate-y-\d+/, "");
  const colorMap = { info: "border-autohr-green", error: "border-autohr-red", warn: "border-autohr-amber" };
  el.classList.add("opacity-100", "translate-y-0", colorMap[type] ?? colorMap.info);
  el.classList.remove("opacity-0", "translate-y-4");
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    el.classList.add("opacity-0", "translate-y-4");
    el.classList.remove("opacity-100", "translate-y-0");
  }, 3000);
}

let _confirmActive = null;
export function confirmAction(message = "هل أنت متأكد من تنفيذ هذا الإجراء؟") {
  if (_confirmActive) return _confirmActive;

  _confirmActive = new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.setAttribute("dir", "rtl");
    overlay.style.cssText = `
      position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.58);
      display:flex;align-items:center;justify-content:center;padding:20px;
    `;

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.style.cssText = `
      width:min(420px,100%);background:var(--ui-surface);border:1px solid var(--ui-line);
      border-radius:8px;box-shadow:0 18px 60px rgba(0,0,0,.45);
      padding:18px;color:var(--ui-text-strong);
    `;

    const title = document.createElement("p");
    title.textContent = "تأكيد الإجراء";
    title.style.cssText = "font-size:16px;font-weight:700;margin:0 0 10px";

    const body = document.createElement("p");
    body.textContent = message;
    body.style.cssText = "font-size:14px;line-height:1.8;color:var(--ui-text);margin:0 0 18px;white-space:pre-line";

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:10px;justify-content:flex-start";

    const ok = document.createElement("button");
    ok.type = "button";
    ok.className = "btn-primary";
    ok.textContent = "تأكيد";
    ok.style.cssText = "min-width:96px";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn-secondary";
    cancel.textContent = "إلغاء";
    cancel.style.cssText = "min-width:96px";

    const finish = value => {
      document.removeEventListener("keydown", onKeyDown);
      overlay.remove();
      _confirmActive = null;
      resolve(value);
    };

    const onKeyDown = event => {
      if (event.key === "Escape") finish(false);
      if (event.key === "Enter") finish(true);
    };

    ok.addEventListener("click", () => finish(true));
    cancel.addEventListener("click", () => finish(false));
    overlay.addEventListener("click", event => {
      if (event.target === overlay) finish(false);
    });
    document.addEventListener("keydown", onKeyDown);

    actions.append(ok, cancel);
    dialog.append(title, body, actions);
    overlay.append(dialog);
    document.body.append(overlay);
    setTimeout(() => ok.focus(), 0);
  });

  return _confirmActive;
}

// ── Unsaved changes ────────────────────────────────────────────────────────
export function confirmSaveChanges(message = "توجد تغييرات غير محفوظة. هل تريد حفظها قبل الإغلاق؟") {
  if (_confirmActive) return _confirmActive;

  _confirmActive = new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.setAttribute("dir", "rtl");
    overlay.style.cssText = `
      position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.58);
      display:flex;align-items:center;justify-content:center;padding:20px;
    `;

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.style.cssText = `
      width:min(460px,100%);background:var(--ui-surface);border:1px solid var(--ui-line);
      border-radius:8px;box-shadow:0 18px 60px rgba(0,0,0,.45);
      padding:18px;color:var(--ui-text-strong);
    `;

    const title = document.createElement("p");
    title.textContent = "تغييرات غير محفوظة";
    title.style.cssText = "font-size:16px;font-weight:700;margin:0 0 10px";

    const body = document.createElement("p");
    body.textContent = message;
    body.style.cssText = "font-size:14px;line-height:1.8;color:var(--ui-text);margin:0 0 18px;white-space:pre-line";

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:10px;justify-content:flex-start;flex-wrap:wrap";

    const save = document.createElement("button");
    save.type = "button";
    save.className = "btn-primary";
    save.textContent = "حفظ";

    const discard = document.createElement("button");
    discard.type = "button";
    discard.className = "btn-danger";
    discard.textContent = "خروج دون حفظ";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn-secondary";
    cancel.textContent = "إلغاء";

    const finish = value => {
      document.removeEventListener("keydown", onKeyDown);
      overlay.remove();
      _confirmActive = null;
      resolve(value);
    };

    const onKeyDown = event => {
      if (event.key === "Escape") finish("cancel");
      if (event.key === "Enter") finish("save");
    };

    save.addEventListener("click", () => finish("save"));
    discard.addEventListener("click", () => finish("discard"));
    cancel.addEventListener("click", () => finish("cancel"));
    overlay.addEventListener("click", event => {
      if (event.target === overlay) finish("cancel");
    });
    document.addEventListener("keydown", onKeyDown);

    actions.append(save, discard, cancel);
    dialog.append(title, body, actions);
    overlay.append(dialog);
    document.body.append(overlay);
    setTimeout(() => save.focus(), 0);
  });

  return _confirmActive;
}

// ── Branding ───────────────────────────────────────────────────────────────
export function applyBranding(config) {
  const co   = document.getElementById("sidebar-company");
  const dept = document.getElementById("sidebar-dept");
  const logo = document.getElementById("sidebar-logo");
  const fb   = document.getElementById("sidebar-logo-fallback");
  const hdr  = document.getElementById("header-branding");
  const loginUnit = document.getElementById("login-unit-name");

  // Sidebar shows the full company name (wrapping to two lines when needed) and, under it,
  // the section and unit names, so the header reads the same as Settings → الجهة والشعار.
  const companyName = String(config.company_name ?? "").trim() || "CNSArch";
  const subtitle = [config.department_name, config.division_name]
    .map(v => String(v ?? "").trim())
    .filter(Boolean)
    .join(" · ");
  if (co)   co.textContent   = companyName;
  if (dept) dept.textContent = subtitle;
  const brand = document.getElementById("sidebar-brand");
  if (brand) brand.title = [companyName, config.department_name, config.division_name].filter(Boolean).join("\n");
  if (hdr)  hdr.textContent  = [config.company_name, config.department_name].filter(Boolean).join(" — ");
  if (loginUnit) {
    // Login screen: show the configured unit name, or a muted hint telling the admin where to set it.
    const unitName = String(config.division_name ?? "").trim();
    loginUnit.textContent = unitName || "لم يُحدَّد اسم الشعبة/الوحدة";
    loginUnit.title = unitName ? "" : "يضبطه مدير النظام من الإعدادات ← الجهة والشعار";
    loginUnit.classList.toggle("is-hint", !unitName);
  }

  // The company logo is fixed and bundled with the app; any logo_path stored by an
  // older release is ignored.
  if (logo) {
    logo.src = COMPANY_LOGO.small;
    logo.alt = COMPANY_LOGO.alt;
    logo.classList.remove("hidden");
  }
  if (fb) fb.classList.add("hidden");
}

// ── Date helpers ───────────────────────────────────────────────────────────
export function formatDate(iso) {
  if (!iso) return "—";
  const match = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  const d = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : new Date(iso);
  return isNaN(d) ? iso : d.toLocaleDateString();
}

export function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// ── Misc ───────────────────────────────────────────────────────────────────
export function escHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function debounce(fn, ms = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ── Arabic number agreement ────────────────────────────────────────────────
// 1 → «ملف واحد»، 2 → «ملفان»، 3–10 → «3 ملفات»، 11–99 → «11 ملفاً»، 100 → «100 ملف»
export const AR_NOUNS = {
  file:       { sing: "ملف",     one: "ملف واحد",     two: "ملفان",     few: "ملفات",     many: "ملفاً" },
  attachment: { sing: "مرفق",    one: "مرفق واحد",    two: "مرفقان",    few: "مرفقات",    many: "مرفقاً" },
  document:   { sing: "وثيقة",   one: "وثيقة واحدة",  two: "وثيقتان",   few: "وثائق",     many: "وثيقةً" },
  day:        { sing: "يوم",     one: "يوم واحد",     two: "يومان",     few: "أيام",      many: "يوماً" },
  user:       { sing: "مستخدم",  one: "مستخدم واحد",  two: "مستخدمان",  few: "مستخدمين",  many: "مستخدماً" },
  employee:   { sing: "موظف",    one: "موظف واحد",    two: "موظفان",    few: "موظفين",    many: "موظفاً" },
};

/**
 * Formats a count with the correctly agreeing Arabic noun.
 * `forms` is an AR_NOUNS entry (or a key of it); pass `{ ...AR_NOUNS.file, two: "ملفين" }`
 * where the sentence needs the genitive/accusative dual.
 */
export function arCount(count, forms) {
  const f = typeof forms === "string" ? AR_NOUNS[forms] : forms;
  const n = Math.abs(Math.trunc(Number(count) || 0));
  if (n === 1) return f.one;
  if (n === 2) return f.two;
  const r = n % 100;
  if (r >= 3 && r <= 10) return `${n} ${f.few}`;
  if (r >= 11) return `${n} ${f.many}`;
  return `${n} ${f.sing}`;
}

/** Baghdad airport badge access codes offered for one-click adding (any other code can be typed). */
export const AIRPORT_ZONES = ["S1", "T", "VIP", "C"];
