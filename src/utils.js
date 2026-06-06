/**
 * utils.js — Shared utilities
 */
import { convertFileSrc } from "@tauri-apps/api/core";

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
    dialog.style.cssText = `
      width:min(420px,100%);background:#1f1f1f;border:1px solid #2d2d2d;
      border-radius:8px;box-shadow:0 18px 60px rgba(0,0,0,.45);
      padding:18px;color:#f3f4f6;
    `;

    const title = document.createElement("p");
    title.textContent = "تأكيد الإجراء";
    title.style.cssText = "font-size:16px;font-weight:700;margin:0 0 10px";

    const body = document.createElement("p");
    body.textContent = message;
    body.style.cssText = "font-size:14px;line-height:1.8;color:#d1d5db;margin:0 0 18px";

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

// ── Branding ───────────────────────────────────────────────────────────────
export function applyBranding(config) {
  const co   = document.getElementById("sidebar-company");
  const dept = document.getElementById("sidebar-dept");
  const logo = document.getElementById("sidebar-logo");
  const fb   = document.getElementById("sidebar-logo-fallback");
  const hdr  = document.getElementById("header-branding");

  if (co)   co.textContent   = config.company_name || "AutoHR";
  if (dept) dept.textContent = [config.department_name, config.division_name].filter(Boolean).join(" · ");
  if (hdr)  hdr.textContent  = [config.company_name, config.department_name].filter(Boolean).join(" — ");

  if (config.logo_full_path && logo && fb) {
    logo.src = convertFileSrc(config.logo_full_path);
    logo.classList.remove("hidden");
    fb.classList.add("hidden");
  } else if (logo && fb) {
    logo.classList.add("hidden");
    fb.classList.remove("hidden");
  }
}

// ── Date helpers ───────────────────────────────────────────────────────────
export function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleDateString("ar-IQ");
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
