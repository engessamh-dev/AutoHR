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
import { renderAudit }     from "./screens/audit.js";
import { renderHr }        from "./screens/hr.js";
import { can }             from "./permissions.js";
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
  nav_dashboard: "لوحة التحكم العامة",
  nav_document_alerts: "تنبيهات المستمسكات",
  nav_employees: "دليل الموظفين وإدارتهم",
  nav_reports: "التقارير",
  nav_documents: "أرشيف الوثائق",
  nav_hr: "الترقيات والعلاوات",
  nav_users:     "المستخدمين والصلاحيات",
  nav_audit:     "سجل النظام",
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
    dashboard: "nav_dashboard", employees: "nav_employees", reports: "nav_reports", documents: "nav_documents", hr: "nav_hr",
    users: "nav_users", audit: "nav_audit", about: "nav_about",
  };
  const navIcons = {
    dashboard: "▦", employees: "👥", reports: "📈", documents: "📁", hr: "↑",
    users: "👤", audit: "📋", about: "ℹ",
  };
  document.querySelectorAll(".nav-item[data-screen]").forEach(el => {
    const screen = el.dataset.screen;
    if (navMap[screen]) {
      el.textContent = `${navIcons[screen] ?? ""} ${t(navMap[screen])}`.trim();
    }
  });
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
        <div id="auto-backup-progress-bar" style="height:100%;width:0%;background:#5da12c;transition:width .2s ease"></div>
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
  hr: renderHr,
  users:     renderUsers,
  audit:     renderAudit,
  about:     renderAbout,
};

let activeScreen = "dashboard";

async function navigateTo(screen, options = {}) {
  if (screen !== activeScreen && window.autohrCanLeaveCurrentScreen && !(await window.autohrCanLeaveCurrentScreen())) {
    return;
  }

  // RBAC guard
  const required = { users: "users.manage", audit: "audit.view", hr: "hr.dashboard.view" };
  if (required[screen] && !can(currentUser, required[screen])) {
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
    el.classList.toggle("active", el.dataset.screen === screen);
  });

  const titleMap = {
    dashboard: "nav_dashboard", documentAlerts: "nav_document_alerts", employees: "nav_employees", reports: "nav_reports", documents: "nav_documents", hr: "nav_hr",
    users: "nav_users", audit: "nav_audit", about: "nav_about",
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
      container.innerHTML = `<div class="card text-autohr-red" role="alert">خطأ: ${escHtml(err?.message ?? err)}</div>`;
    }
  }
}

// ── Login ──────────────────────────────────────────────────────────────────
async function enterApp(user) {
  currentUser = user;
  document.getElementById("current-user").textContent = user.username;
  document.getElementById("nav-users")?.classList.toggle("hidden", !can(user, "users.manage"));
  document.getElementById("nav-audit")?.classList.toggle("hidden", !can(user, "audit.view"));
  document.getElementById("nav-hr")?.classList.toggle("hidden", !can(user, "hr.dashboard.view"));
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("password-change-screen").classList.add("hidden");
  document.getElementById("app-shell").classList.remove("hidden");
  try {
    applyBranding(await api.getCompanyConfig());
  } catch (_) { /* non-fatal */ }
  await navigateTo("dashboard");
  notifyDocumentAlerts();
}

async function doLogin(username, password) {
  try {
    const user = await api.login(username, password);
    currentUser = user;
    document.getElementById("login-screen").classList.add("hidden");
    if (user.must_change_password) {
      document.getElementById("password-change-screen").classList.remove("hidden");
      document.getElementById("current-password").focus();
      return;
    }
    await enterApp(user);
  } catch (err) {
    const errEl = document.getElementById("login-error");
    // A temporary lockout returns its own Arabic message; other failures stay generic.
    const lockedMessage = typeof err === "string" && err.startsWith("تم إيقاف تسجيل الدخول") ? err : null;
    errEl.textContent = lockedMessage ?? t("loginError");
    errEl.classList.remove("hidden");
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
  document.getElementById("login-error").classList.add("hidden");
  document.getElementById("password-change-form").reset();
  document.getElementById("password-change-error").classList.add("hidden");
}

// ── Bootstrap ──────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  applyLang();
  applyAppVersion();
  applyLoginBranding();
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

  // Login form
  document.getElementById("login-form").addEventListener("submit", e => {
    e.preventDefault();
    const u = document.getElementById("login-username").value.trim();
    const p = document.getElementById("login-password").value;
    if (u && p) doLogin(u, p);
  });

  const loginPassword = document.getElementById("login-password");
  const togglePassword = document.getElementById("btn-toggle-password");
  togglePassword.addEventListener("click", () => {
    const showPassword = loginPassword.type === "password";
    loginPassword.type = showPassword ? "text" : "password";
    togglePassword.setAttribute("aria-pressed", String(showPassword));
    togglePassword.setAttribute("aria-label", showPassword ? "إخفاء كلمة المرور" : "إظهار كلمة المرور");
    loginPassword.focus();
  });

  document.getElementById("btn-forgot-password").addEventListener("click", () => {
    showToast("لاستعادة كلمة المرور، تواصل مع مسؤول النظام لإصدار كلمة مرور مؤقتة آمنة.");
  });

  document.querySelectorAll("#login-username, #login-password").forEach(input => {
    const placeholder = input.placeholder;
    const syncPlaceholder = () => {
      input.placeholder = input.value ? "" : placeholder;
    };
    input.addEventListener("input", () => {
      syncPlaceholder();
      document.getElementById("login-error").classList.add("hidden");
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
  document.getElementById("btn-logout-top").addEventListener("click",  doLogout);
  document.getElementById("btn-logout-side").addEventListener("click", doLogout);
  document.getElementById("btn-password-change-logout").addEventListener("click", doLogout);

  // Sidebar navigation
  document.getElementById("sidebar-nav").addEventListener("click", e => {
    const item = e.target.closest(".nav-item[data-screen]");
    if (item) navigateTo(item.dataset.screen);
  });
});
