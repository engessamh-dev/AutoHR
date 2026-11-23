/**
 * main.js — Auth, navigation, RBAC, i18n
 */
import { api }           from "./api.js";
import { applyBranding, showToast, confirmAction, escHtml } from "./utils.js";
import { renderDashboard }  from "./screens/dashboard.js";
import { buildDocumentAlerts, renderDocumentAlerts } from "./screens/document-alerts.js";
import { renderEmployees }  from "./screens/employees.js";
import { renderReports }    from "./screens/reports.js";
import { renderDocuments }  from "./screens/documents.js";
import { renderUsers }     from "./screens/users.js";
import { renderAbout }     from "./screens/about.js";
import { renderSettings }  from "./screens/settings.js";
import { runStartupGate } from "./screens/setup.js";
import { renderAudit }     from "./screens/audit.js";
import { can, roleLabels } from "./permissions.js";
import { formatAppVersion } from "./version.js";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

// ── i18n ───────────────────────────────────────────────────────────────────
const i18n = {
  appSubtitle: "نظام أرشفة وثائق الملاحة الجوية",
  username: "اسم المستخدم", password: "كلمة المرور",
  login: "تسجيل الدخول", logout: "تسجيل الخروج",
  user: "المستخدم",
  nav_dashboard: "الرئيسية",
  nav_document_alerts: "تنبيهات المستمسكات",
  nav_employees: "الموظفون",
  nav_reports: "التقارير",
  nav_documents: "أرشيف الوثائق",
  nav_users:     "المستخدمين والصلاحيات",
  nav_audit:     "سجل النظام",
  nav_settings:  "الإعدادات",
  nav_about:     "حول النظام",
  loginError:    "اسم المستخدم أو كلمة المرور غير صحيحة",
};

let currentUser = null;
let automaticBackupPromise = null;
let isClosingWindow = false;

function t(key) { return i18n[key] ?? key; }

function applyLang() {
  document.documentElement.lang = "ar";
  document.documentElement.dir  = "rtl";
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const key = el.dataset.i18n;
    if (el.tagName === "INPUT") el.placeholder = t(key);
    else el.textContent = t(key);
  });
  // update sidebar nav labels
  const navMap = {
    dashboard: "nav_dashboard", employees: "nav_employees", reports: "nav_reports", documents: "nav_documents",
    users: "nav_users", audit: "nav_audit", settings: "nav_settings", about: "nav_about",
  };
  document.querySelectorAll(".nav-item[data-screen]").forEach(el => {
    const screen = el.dataset.screen;
    if (!navMap[screen]) return;
    const label = el.querySelector(".nav-label");
    if (label) label.textContent = t(navMap[screen]);
    el.title = t(navMap[screen]);
  });
}

// ── Collapsible sidebar ────────────────────────────────────────────────────
const SIDEBAR_STATE_KEY = "autohr.sidebarCollapsed";

function readSidebarCollapsed() {
  try { return localStorage.getItem(SIDEBAR_STATE_KEY) === "1"; }
  catch { return false; }
}

function setSidebarCollapsed(collapsed) {
  document.getElementById("app-shell")?.classList.toggle("sidebar-collapsed", collapsed);
  const toggle = document.getElementById("btn-toggle-sidebar");
  if (toggle) {
    const label = collapsed ? "إظهار القائمة الجانبية" : "طي القائمة الجانبية";
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.setAttribute("aria-label", label);
    toggle.title = `${label} (Ctrl+B)`;
  }
  try { localStorage.setItem(SIDEBAR_STATE_KEY, collapsed ? "1" : "0"); } catch { /* non-fatal */ }
}

function toggleSidebar() {
  setSidebarCollapsed(!document.getElementById("app-shell")?.classList.contains("sidebar-collapsed"));
}

function renderSidebarUser(user) {
  document.getElementById("current-user").textContent = user.username;
  const role = user.username === "sysadmin" ? "مسؤول النظام" : (roleLabels[user.role] ?? user.role ?? "");
  document.getElementById("current-user-role").textContent = role;
  document.getElementById("sidebar-user-avatar").textContent = (user.username || "?").trim().charAt(0).toUpperCase();
  document.getElementById("sidebar-user").title = role ? `${user.username} · ${role}` : user.username;
}

function applyAppVersion() {
  document.querySelectorAll("[data-app-version]").forEach(el => {
    el.textContent = formatAppVersion();
  });
}

async function applyLoginBranding() {
  try {
    applyBranding(await api.getPublicCompanyConfig());
  } catch (_) { /* non-fatal */ }
}

async function notifyWindows(title, body) {
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      granted = (await requestPermission()) === "granted";
    }
    if (granted) {
      sendNotification({ title, body });
    }
  } catch (_) { /* notification support is non-fatal */ }
}

function openAutomaticBackupProgress() {
  const overlay = document.createElement("div");
  overlay.setAttribute("dir", "rtl");
  overlay.style.cssText = "position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.62);display:flex;align-items:center;justify-content:center;padding:20px";
  overlay.innerHTML = `
    <div style="width:min(440px,100%);background:#1f1f1f;border:1px solid #2d2d2d;border-radius:10px;padding:18px;box-shadow:0 18px 60px rgba(0,0,0,.45)">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px">
        <p style="font-size:15px;font-weight:700;color:#f3f4f6;margin:0">النسخ الاحتياطي التلقائي</p>
        <span id="auto-backup-progress-percent" class="badge badge-gray">0%</span>
      </div>
      <div style="height:10px;background:#111827;border-radius:999px;overflow:hidden;border:1px solid #374151">
        <div id="auto-backup-progress-bar" style="height:100%;width:0%;background:#24a9ff;transition:width .2s ease"></div>
      </div>
      <p id="auto-backup-progress-message" style="font-size:12px;color:#9ca3af;margin:12px 0 0">جاري فحص النسخ التلقائية...</p>
    </div>`;
  document.body.append(overlay);
  return {
    update(progress = {}) {
      const percent = Math.max(0, Math.min(100, Number(progress.percent ?? 0)));
      overlay.querySelector("#auto-backup-progress-bar").style.width = `${percent}%`;
      overlay.querySelector("#auto-backup-progress-percent").textContent = `${percent}%`;
      overlay.querySelector("#auto-backup-progress-message").textContent = progress.message || "جاري إنشاء النسخة الاحتياطية التلقائية...";
    },
    close() {
      overlay.remove();
    },
  };
}

async function runShutdownAutomaticBackupsOld({ showProgress = true } = {}) {
  if (automaticBackupPromise) return automaticBackupPromise;
  automaticBackupPromise = (async () => {
  const progress = showProgress ? openAutomaticBackupProgress() : null;
  let unlisten = null;
  try {
    if (progress) {
      unlisten = await listen("auto-backup-progress", event => progress.update(event.payload));
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
    }
    const created = await api.runDueAutoBackups();
    if (created.length) {
      const createdTypes = created.join("، ");
      await notifyWindows(
        "\u0646\u0633\u062e \u0627\u062d\u062a\u064a\u0627\u0637\u064a \u062a\u0644\u0642\u0627\u0626\u064a",
        `\u062a\u0645 \u0625\u0646\u0634\u0627\u0621 \u0646\u0633\u062e \u062a\u0644\u0642\u0627\u0626\u064a \u0628\u0646\u062c\u0627\u062d: ${createdTypes}.`,
      );
    }
  } catch (err) {
    await notifyWindows(
      "\u0641\u0634\u0644 \u0627\u0644\u0646\u0633\u062e \u0627\u0644\u062a\u0644\u0642\u0627\u0626\u064a",
      err?.message ?? "\u062a\u0639\u0630\u0631 \u0625\u0646\u0634\u0627\u0621 \u0627\u0644\u0646\u0633\u062e\u0629 \u0627\u0644\u0627\u062d\u062a\u064a\u0627\u0637\u064a\u0629 \u0627\u0644\u062a\u0644\u0642\u0627\u0626\u064a\u0629.",
    );
  } finally {
    if (unlisten) unlisten();
    if (progress) setTimeout(() => progress.close(), 450);
    automaticBackupPromise = null;
  }
  })();
  return automaticBackupPromise;
}

// ── Screen routing ─────────────────────────────────────────────────────────
async function runShutdownAutomaticBackups({ showProgress = true } = {}) {
  if (automaticBackupPromise) return automaticBackupPromise;
  automaticBackupPromise = (async () => {
    let progress = null;
    let unlisten = null;
    try {
      if (showProgress) {
        unlisten = await listen("auto-backup-progress", event => {
          if (!progress) progress = openAutomaticBackupProgress();
          progress.update(event.payload);
        });
        await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
      }
      const created = await api.runDueAutoBackups();
      if (created.length) {
        const createdTypes = created.join("، ");
        const message = `تم إنشاء نسخ تلقائي بنجاح: ${createdTypes}.`;
        progress?.update({ percent: 100, message });
        await notifyWindows("نسخ احتياطي تلقائي", message);
      }
    } catch (err) {
      progress?.update({
        percent: 100,
        message: "تعذر إكمال النسخ التلقائي.",
      });
      await notifyWindows(
        "فشل النسخ التلقائي",
        err?.message ?? "تعذر إنشاء النسخة الاحتياطية التلقائية.",
      );
    } finally {
      if (unlisten) unlisten();
      if (progress) {
        await new Promise(resolve => setTimeout(resolve, 450));
        progress.close();
      }
      automaticBackupPromise = null;
    }
  })();
  return automaticBackupPromise;
}

async function notifyDocumentAlerts() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const storageKey = "cnsarch.documentAlertsNotificationDate";
    if (localStorage.getItem(storageKey) === today) return;

    const employees = await api.listEmployees();
    const alerts = buildDocumentAlerts(employees);
    if (!alerts.length) return;

    const expired = alerts.filter(alert => alert.expired).length;
    const expiring = alerts.length - expired;
    await notifyWindows(
      "\u062a\u0646\u0628\u064a\u0647\u0627\u062a \u0627\u0644\u0645\u0633\u062a\u0645\u0633\u0643\u0627\u062a",
      `\u0644\u062f\u064a\u0643 ${alerts.length} \u062a\u0646\u0628\u064a\u0647 \u0645\u0633\u062a\u0645\u0633\u0643\u0627\u062a: ${expired} \u0645\u0646\u062a\u0647\u064a\u0629 \u0648 ${expiring} \u0642\u0631\u064a\u0628\u0629 \u0627\u0644\u0646\u0641\u0627\u0630.`,
    );
    localStorage.setItem(storageKey, today);
  } catch (_) { /* document alert notifications are non-fatal */ }
}

const screenRenderers = {
  dashboard: renderDashboard,
  documentAlerts: renderDocumentAlerts,
  employees: renderEmployees,
  reports: renderReports,
  documents: renderDocuments,
  users:     renderUsers,
  settings:  renderSettings,
  audit:     renderAudit,
  about:     renderAbout,
};

let activeScreen = "dashboard";

async function navigateTo(screen, options = {}) {
  if (screen !== activeScreen && window.autohrCanLeaveCurrentScreen && !(await window.autohrCanLeaveCurrentScreen())) {
    return;
  }

  // RBAC guard
  const required = { users: ["users.manage"], audit: ["audit.view"], settings: ["settings.manage", "backups.manage"] };
  if (required[screen] && !required[screen].some(permission => can(currentUser, permission))) {
    document.getElementById("screen-container").innerHTML = `
      <div class="flex flex-col items-center justify-center h-full text-gray-500">
        <p class="text-5xl mb-4">🔒</p>
        <p class="text-xl">غير مصرح</p>
        <p class="text-sm mt-2">هذه الصفحة للمسؤول فقط</p>
      </div>`;
    return;
  }

  activeScreen = screen;
  window.autohrCanLeaveCurrentScreen = null;
  document.querySelectorAll(".nav-item").forEach(el => {
    const navScreen = screen === "documentAlerts" ? "dashboard" : screen;
    el.classList.toggle("active", el.dataset.screen === navScreen);
  });

  const titleMap = {
    dashboard: "nav_dashboard", documentAlerts: "nav_document_alerts", employees: "nav_employees", reports: "nav_reports", documents: "nav_documents",
    users: "nav_users", audit: "nav_audit", settings: "nav_settings", about: "nav_about",
  };
  document.getElementById("page-title").textContent = t(titleMap[screen] ?? screen);

  const container = document.getElementById("screen-container");
  container.innerHTML = `<div class="flex items-center justify-center h-full text-gray-500 text-sm">جارٍ التحميل…</div>`;

  const renderer = screenRenderers[screen];
  if (renderer) {
    try {
      await renderer(container, currentUser, { t, navigateTo, showToast, ...options });
    } catch (err) {
      console.error(err);
      container.innerHTML = `<div class="card space-y-3" role="alert">
        <p class="font-semibold text-autohr-red">تعذر تحميل هذه الصفحة</p>
        <p class="text-sm text-gray-400" dir="auto">${escHtml(err?.message ?? err)}</p>
        <button type="button" id="btn-screen-retry" class="btn-secondary">إعادة المحاولة</button>
      </div>`;
      container.querySelector("#btn-screen-retry")?.addEventListener("click", () => navigateTo(screen, options));
    }
  }
}

// ── Login ──────────────────────────────────────────────────────────────────
async function enterApp(user) {
  currentUser = user;
  renderSidebarUser(user);
  const canManageUsers = can(user, "users.manage");
  const canViewAudit = can(user, "audit.view");
  document.getElementById("nav-users")?.classList.toggle("hidden", !canManageUsers);
  document.getElementById("nav-audit")?.classList.toggle("hidden", !canViewAudit);
  const canOpenSettings = can(user, "settings.manage") || can(user, "backups.manage");
  document.getElementById("nav-settings")?.classList.toggle("hidden", !canOpenSettings);
  document.getElementById("nav-admin-section")?.classList.toggle("hidden", !canManageUsers && !canViewAudit && !canOpenSettings);
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("password-change-screen").classList.add("hidden");
  document.getElementById("app-shell").classList.remove("hidden");
  try {
    applyBranding(await api.getCompanyConfig());
  } catch (_) { /* non-fatal */ }
  await navigateTo("dashboard");
  notifyDocumentAlerts();
}

// ── Login messages ─────────────────────────────────────────────────────────
// One fixed slot at the bottom of the card, under the unit name, so a message
// never covers the fields, the login button or the "forgot password" link.
let loginLockoutTimer = null;
let loginBusy = false;

function showLoginMessage(text, kind = "error", field = null) {
  const slot = document.getElementById("login-error");
  slot.textContent = text;
  slot.dataset.kind = kind;
  slot.setAttribute("role", kind === "error" ? "alert" : "status");
  slot.classList.remove("hidden", "is-long");
  // The box has a fixed size from the design: a message that does not fit on one line
  // is shown on two smaller lines.
  if (slot.scrollWidth > slot.clientWidth) slot.classList.add("is-long");
  document.querySelectorAll("#login-username, #login-password").forEach(input => {
    input.classList.toggle("login-field-invalid", kind === "error" && input.id === `login-${field}`);
  });
}

function clearLoginMessage() {
  if (loginLockoutTimer) return;
  const slot = document.getElementById("login-error");
  slot.classList.add("hidden");
  slot.textContent = "";
  document.querySelectorAll(".login-field-invalid").forEach(input => input.classList.remove("login-field-invalid"));
}

function setLoginBusy(busy) {
  loginBusy = busy;
  const submit = document.querySelector(".login-hit-submit");
  if (submit) submit.disabled = busy || Boolean(loginLockoutTimer);
  document.getElementById("login-form")?.setAttribute("aria-busy", String(busy));
}

function lockoutMinutes(message) {
  if (message.includes("دقيقة واحدة")) return 1;
  if (message.includes("دقيقتين")) return 2;
  return Number(message.match(/(\d+)/)?.[1] ?? 5);
}

function startLoginLockout(minutes) {
  let remaining = Math.max(1, minutes) * 60;
  const tick = () => {
    const mm = String(Math.floor(remaining / 60)).padStart(2, "0");
    const ss = String(remaining % 60).padStart(2, "0");
    showLoginMessage(`الحساب موقوف مؤقتاً. حاول بعد ${mm}:${ss}`, "error");
    remaining -= 1;
  };
  if (loginLockoutTimer) clearInterval(loginLockoutTimer);
  tick();
  loginLockoutTimer = setInterval(() => {
    if (remaining < 0) {
      clearInterval(loginLockoutTimer);
      loginLockoutTimer = null;
      clearLoginMessage();
      setLoginBusy(false);
      document.getElementById("login-password")?.focus();
      return;
    }
    tick();
  }, 1000);
  setLoginBusy(false);
}

// ── Recent usernames ──────────────────────────────────────────────────────
// The WebView's own "Saved info" popup is turned off (autocomplete="off"),
// because it is a dark native box that covers the password field. Instead the
// last few usernames that signed in successfully are offered in a small list
// styled like the login card. Only usernames are kept, never passwords.
const RECENT_USERNAMES_KEY = "cnsarch.recentUsernames";
function recentLoginUsernames() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_USERNAMES_KEY) || "[]");
    return Array.isArray(list) ? list.filter(v => typeof v === "string" && v).slice(0, 5) : [];
  } catch { return []; }
}
function rememberLoginUsername(username) {
  const name = String(username || "").trim();
  if (!name) return;
  const list = [name, ...recentLoginUsernames().filter(v => v !== name)].slice(0, 5);
  try { localStorage.setItem(RECENT_USERNAMES_KEY, JSON.stringify(list)); } catch { /* storage is optional */ }
}
function bindLoginUsernameSuggestions() {
  const input = document.getElementById("login-username");
  const box = document.getElementById("login-suggestions");
  if (!input || !box) return;
  let active = -1;
  const items = () => [...box.querySelectorAll("[data-username]")];
  const close = () => { box.classList.add("hidden"); input.setAttribute("aria-expanded", "false"); active = -1; };
  const render = () => {
    const typed = input.value.trim().toLowerCase();
    const matches = recentLoginUsernames().filter(v => v.toLowerCase().startsWith(typed) && v.toLowerCase() !== typed);
    if (!matches.length) { close(); return; }
    box.innerHTML = matches.map((name, i) =>
      `<li role="option" id="login-suggestion-${i}" data-username="${escHtml(name)}" dir="ltr">${escHtml(name)}</li>`).join("");
    box.classList.remove("hidden");
    input.setAttribute("aria-expanded", "true");
    active = -1;
  };
  const pick = name => {
    input.value = name;
    input.dispatchEvent(new Event("input"));
    close();
    document.getElementById("login-password")?.focus();
  };
  const highlight = index => {
    const list = items();
    active = (index + list.length) % list.length;
    list.forEach((li, i) => li.classList.toggle("is-active", i === active));
    input.setAttribute("aria-activedescendant", list[active]?.id || "");
  };
  input.addEventListener("focus", render);
  input.addEventListener("input", render);
  input.addEventListener("blur", () => setTimeout(close, 120));
  input.addEventListener("keydown", event => {
    if (box.classList.contains("hidden")) return;
    if (event.key === "ArrowDown") { event.preventDefault(); highlight(active + 1); }
    else if (event.key === "ArrowUp") { event.preventDefault(); highlight(active - 1); }
    else if (event.key === "Enter" && active >= 0) { event.preventDefault(); pick(items()[active].dataset.username); }
    else if (event.key === "Escape") close();
  });
  box.addEventListener("mousedown", event => {
    const li = event.target.closest("[data-username]");
    if (li) { event.preventDefault(); pick(li.dataset.username); }
  });
}

async function doLogin(username, password) {
  if (loginBusy || loginLockoutTimer) return;
  setLoginBusy(true);
  showLoginMessage("جارٍ التحقق…", "info");
  try {
    const user = await api.login(username, password);
    currentUser = user;
    rememberLoginUsername(username);
    clearLoginMessage();
    document.getElementById("login-screen").classList.add("hidden");
    if (user.must_change_password) {
      document.getElementById("password-change-screen").classList.remove("hidden");
      document.getElementById("current-password").focus();
      return;
    }
    await enterApp(user);
  } catch (err) {
    const message = typeof err === "string" ? err : String(err?.message ?? err ?? "");
    if (message.startsWith("تم إيقاف تسجيل الدخول")) {
      startLoginLockout(lockoutMinutes(message));
    } else if (message === "You are not authorized to perform this action") {
      showLoginMessage(t("loginError"), "error", "password");
      const password = document.getElementById("login-password");
      password.value = "";
      password.focus();
    } else {
      showLoginMessage("تعذر تسجيل الدخول بسبب خطأ في النظام. حاول مرة أخرى.", "error");
    }
  } finally {
    setLoginBusy(false);
  }
}

async function doLogout() {
  if (window.autohrCanLeaveCurrentScreen && !(await window.autohrCanLeaveCurrentScreen())) {
    return;
  }
  if (!(await confirmAction("تأكيد تسجيل الخروج؟"))) return;

  await runShutdownAutomaticBackups();

  if (currentUser) {
    try { await api.logout(); } catch (_) { /* non-fatal */ }
  }
  currentUser = null;
  document.getElementById("app-shell").classList.add("hidden");
  document.getElementById("password-change-screen").classList.add("hidden");
  document.getElementById("login-screen").classList.remove("hidden");
  document.getElementById("login-username").value = "";
  document.getElementById("login-password").value = "";
  clearLoginMessage();
  document.getElementById("password-change-form").reset();
  document.getElementById("password-change-error").classList.add("hidden");
}

// ── Bootstrap ──────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  applyLang();
  applyAppVersion();
  getCurrentWindow().onCloseRequested(async event => {
    if (isClosingWindow) return;
    event.preventDefault();
    if (window.autohrCanLeaveCurrentScreen && !(await window.autohrCanLeaveCurrentScreen())) {
      return;
    }
    isClosingWindow = true;
    try {
      await runShutdownAutomaticBackups();
    } finally {
      await api.exitApp();
    }
  });

  // First run or unavailable data folder: choose folders before the login screen.
  await runStartupGate();
  applyLoginBranding();

  // Login form
  document.getElementById("login-form").addEventListener("submit", e => {
    e.preventDefault();
    const u = document.getElementById("login-username").value.trim();
    const p = document.getElementById("login-password").value;
    if (!u) { showLoginMessage("أدخل اسم المستخدم", "error", "username"); document.getElementById("login-username").focus(); return; }
    if (!p) { showLoginMessage("أدخل كلمة المرور", "error", "password"); document.getElementById("login-password").focus(); return; }
    doLogin(u, p);
  });

  bindLoginUsernameSuggestions();

  const loginPassword = document.getElementById("login-password");
  const togglePassword = document.getElementById("btn-toggle-password");
  togglePassword.addEventListener("click", () => {
    const showPassword = loginPassword.type === "password";
    loginPassword.type = showPassword ? "text" : "password";
    togglePassword.setAttribute("aria-pressed", String(showPassword));
    togglePassword.setAttribute("aria-label", showPassword ? "إخفاء كلمة المرور" : "إظهار كلمة المرور");
    loginPassword.focus();
  });

  const syncCapsLock = event => {
    if (typeof event.getModifierState !== "function") return;
    const slot = document.getElementById("login-error");
    const capsOn = event.getModifierState("CapsLock");
    if (capsOn && (slot.classList.contains("hidden") || slot.dataset.kind === "caps")) {
      showLoginMessage("تنبيه: مفتاح Caps Lock مفعّل", "caps");
    } else if (!capsOn && slot.dataset.kind === "caps") {
      clearLoginMessage();
    }
  };
  loginPassword.addEventListener("keydown", syncCapsLock);
  loginPassword.addEventListener("keyup", syncCapsLock);

  document.getElementById("btn-forgot-password").addEventListener("click", () => {
    showLoginMessage("تواصل مع مدير النظام لإعادة تعيين كلمة المرور", "info");
  });

  document.querySelectorAll("#login-username, #login-password").forEach(input => {
    const placeholder = input.placeholder;
    const syncPlaceholder = () => {
      input.placeholder = input.value ? "" : placeholder;
    };
    input.addEventListener("input", () => {
      syncPlaceholder();
      clearLoginMessage();
    });
    input.addEventListener("change", syncPlaceholder);
    syncPlaceholder();
  });

  document.getElementById("password-change-form").addEventListener("submit", async e => {
    e.preventDefault();
    const currentPassword = document.getElementById("current-password").value;
    const newPassword = document.getElementById("new-password").value;
    const confirmPassword = document.getElementById("confirm-password").value;
    const error = document.getElementById("password-change-error");
    if (newPassword !== confirmPassword) {
      error.textContent = "كلمتا المرور الجديدتان غير متطابقتين";
      error.classList.remove("hidden");
      return;
    }
    try {
      const user = await api.changePassword(currentPassword, newPassword);
      error.classList.add("hidden");
      document.getElementById("password-change-form").reset();
      await enterApp(user);
    } catch (err) {
      error.textContent = err?.message ?? String(err || "تعذر تغيير كلمة المرور");
      error.classList.remove("hidden");
    }
  });

  // Logout buttons
  // Collapsible sidebar: ☰ button and Ctrl+B, state remembered between sessions.
  setSidebarCollapsed(readSidebarCollapsed());
  document.getElementById("btn-toggle-sidebar").addEventListener("click", toggleSidebar);
  document.addEventListener("keydown", event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    if (event.code !== "KeyB" && event.key?.toLowerCase() !== "b") return;
    if (document.getElementById("app-shell")?.classList.contains("hidden")) return;
    event.preventDefault();
    toggleSidebar();
  });
  document.getElementById("btn-logout-side").addEventListener("click", doLogout);
  document.getElementById("btn-password-change-logout").addEventListener("click", doLogout);

  // Sidebar navigation
  document.getElementById("sidebar-nav").addEventListener("click", e => {
    const item = e.target.closest(".nav-item[data-screen]");
    if (item) navigateTo(item.dataset.screen);
  });
});
