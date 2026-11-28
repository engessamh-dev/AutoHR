/**
 * main.js — Auth, navigation, RBAC, i18n
 */
import { api }           from "./api.js";
import { applyBranding, showToast, confirmAction, escHtml, errorText, busyTaskLabel } from "./utils.js";
import { renderDashboard }  from "./screens/dashboard.js";
import { alertStageKey, buildDocumentAlerts, loadAlertRules, renderDocumentAlerts } from "./screens/document-alerts.js";
import { renderEmployees }  from "./screens/employees.js";
import { clearAddEmployeeDraft, unsavedAddEmployeeWork } from "./screens/add-wizard.js";
import { renderReports }    from "./screens/reports.js";
import { renderDocuments }  from "./screens/documents.js";
import { renderUsers }     from "./screens/users.js";
import { renderAbout }     from "./screens/about.js";
import { renderSupport }   from "./screens/support.js";
import { renderSettings, installUpdateFlow } from "./screens/settings.js";
import { runStartupGate } from "./screens/setup.js";
import { showWhatsNewIfUpdated } from "./whats-new.js";
import { renderAudit }     from "./screens/audit.js";
import { can, roleLabels } from "./permissions.js";
import { formatAppVersion } from "./version.js";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { initTheme, mountThemeMenu } from "./theme.js";
import { installErrorReporting, setErrorScreen } from "./error-log.js";
import { loadPasswordPolicy, mountPasswordRules, passwordProblem, addPasswordToggle, watchCapsLock } from "./password-rules.js";
import { openForgotPassword } from "./recovery.js";

// Apply the saved light/dark choice before anything is shown.
installErrorReporting();
initTheme();

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
  nav_support:   "الفحص والدعم",
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
    users: "nav_users", audit: "nav_audit", settings: "nav_settings", support: "nav_support", about: "nav_about",
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
  // Two buttons share the state: ☰ in the page header and the arrow on the sidebar's edge.
  const label = collapsed ? "إظهار القائمة الجانبية" : "طي القائمة الجانبية";
  for (const id of ["btn-toggle-sidebar", "btn-sidebar-edge"]) {
    const toggle = document.getElementById(id);
    if (!toggle) continue;
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
  const role = roleLabels[user.role] ?? user.role ?? "";
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
    <div style="width:min(440px,100%);background:var(--ui-surface);border:1px solid var(--ui-line);border-radius:10px;padding:18px;box-shadow:0 18px 60px rgba(0,0,0,.45)">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px">
        <p style="font-size:15px;font-weight:700;color:var(--ui-text-strong);margin:0">النسخ الاحتياطي التلقائي</p>
        <span id="auto-backup-progress-percent" class="badge badge-gray">0%</span>
      </div>
      <div style="height:10px;background:var(--ui-sunken);border-radius:999px;overflow:hidden;border:1px solid var(--ui-line)">
        <div id="auto-backup-progress-bar" style="height:100%;width:0%;background:var(--ui-accent);transition:width .2s ease"></div>
      </div>
      <p id="auto-backup-progress-message" style="font-size:12px;color:var(--ui-text-muted);margin:12px 0 0">جاري فحص النسخ التلقائية...</p>
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

// While someone works, today's automatic backup is refreshed quietly. Rust decides whether one is
// due (the interval chosen in Settings, and only when something changed), so checking often is cheap.
const IN_SESSION_BACKUP_CHECK_MS = 5 * 60 * 1000;
let inSessionBackupTimer = null;
let inSessionBackupPromise = null;

function startInSessionBackups() {
  stopInSessionBackups();
  inSessionBackupTimer = setInterval(() => {
    if (!currentUser || automaticBackupPromise || inSessionBackupPromise) return;
    // Not marked busy: signing out or closing waits for it, then refreshes today's backup itself.
    inSessionBackupPromise = (async () => {
      try {
        await api.runDueAutoBackups(true);
      } catch (err) {
        // Rust records the failure in the log; one quiet line here is enough.
        console.warn("automatic backup", errorText(err));
      } finally {
        inSessionBackupPromise = null;
      }
    })();
  }, IN_SESSION_BACKUP_CHECK_MS);
}

function stopInSessionBackups() {
  if (inSessionBackupTimer) clearInterval(inSessionBackupTimer);
  inSessionBackupTimer = null;
}

/** Asks before closing or signing out while a backup, restore, export, move or update runs. */
/** Entries in «إضافة موظف» live in memory only: say they will be lost before `action`. */
async function confirmLoseAddEmployeeWork(action) {
  const what = unsavedAddEmployeeWork();
  if (!what) return true;
  return confirmAction(
    `${what} ${action} الآن يحذفها نهائيًا، لأن المسودة لا تُحفظ على الحاسبة. احفظ الموظف أولًا إذا تريد بياناته.`,
    { title: "بيانات موظف غير محفوظة", confirmLabel: `${action} وحذفها`, danger: true },
  );
}

async function confirmLeaveWhileBusy(action) {
  const label = busyTaskLabel();
  if (!label) return true;
  return confirmAction(
    `ما زالت عملية «${label}» جارية. ${action} الآن قد يقطعها ويترك ملفًا غير مكتمل. يُنصح بالانتظار حتى تنتهي.`,
    { title: "عملية جارية", confirmLabel: `${action} على أي حال`, danger: true },
  );
}

// ── Screen routing ─────────────────────────────────────────────────────────
async function runShutdownAutomaticBackups({ showProgress = true } = {}) {
  if (automaticBackupPromise) return automaticBackupPromise;
  if (inSessionBackupPromise) await inSessionBackupPromise;
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
      // Errors from Rust arrive as plain strings. Show an Arabic reason when there is one;
      // technical (English) details are in the error log («فحص البرنامج»).
      const detail = typeof err === "string" ? err : err?.message;
      await notifyWindows(
        "فشل النسخ التلقائي",
        /[\u0600-\u06FF]/.test(detail ?? "") ? detail : "تعذر إنشاء النسخة الاحتياطية التلقائية. التفاصيل في «فحص البرنامج».",
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

/**
 * Windows notification for document alerts: shown when a document reaches one of its reminder
 * days (set in «الإعدادات ← تنبيهات المستمسكات») or expires. Each reminder is announced once,
 * even if the program was not opened on that exact day.
 */
async function notifyDocumentAlerts() {
  try {
    // Kept per user: on a shared computer each person is told about each reminder once.
    const storageKey = `cnsarch.documentAlertStages.${currentUser?.username ?? ""}`;
    const [employees, rules] = await Promise.all([api.listEmployees(), loadAlertRules()]);
    const alerts = buildDocumentAlerts(employees, rules);
    let announced = {};
    try { announced = JSON.parse(localStorage.getItem(storageKey)
      // Until this user's own list exists, start from the one the computer kept before (no repeats after the update).
      ?? localStorage.getItem("cnsarch.documentAlertStages") ?? "{}") || {}; } catch (_) { announced = {}; }

    const current = {};
    const fresh = [];
    alerts.forEach(alert => {
      const { id, stage } = alertStageKey(alert);
      current[id] = stage;
      if (announced[id] !== stage) fresh.push(alert);
    });
    localStorage.setItem(storageKey, JSON.stringify(current));
    if (!fresh.length) return;

    const expired = fresh.filter(alert => alert.expired).length;
    const expiring = fresh.length - expired;
    await notifyWindows(
      "تنبيهات المستمسكات",
      `وصل ${fresh.length} مستمسك إلى موعد تنبيه: ${expired} منتهية و ${expiring} قريبة النفاذ. مجموع التنبيهات الحالية ${alerts.length}.`,
    );
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
  support:   renderSupport,
  about:     renderAbout,
};

let activeScreen = "dashboard";

async function navigateTo(screen, options = {}) {
  if (screen !== activeScreen && window.autohrCanLeaveCurrentScreen && !(await window.autohrCanLeaveCurrentScreen())) {
    return;
  }

  // «الفحص والدعم» and «حول النظام» now live as tabs inside «الإعدادات».
  // «المستخدمين والصلاحيات» is a tab of «الإعدادات» too (shown only with users.manage).
  if (screen === "support" || screen === "about" || screen === "users") {
    options = { ...options, tab: screen };
    screen = "settings";
  }

  // RBAC guard
  const required = { audit: ["audit.view"] };
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
  setErrorScreen(screen);
  window.autohrCanLeaveCurrentScreen = null;
  document.querySelectorAll(".nav-item").forEach(el => {
    const navScreen = screen === "documentAlerts" ? "dashboard" : screen;
    el.classList.toggle("active", el.dataset.screen === navScreen);
  });

  const titleMap = {
    dashboard: "nav_dashboard", documentAlerts: "nav_document_alerts", employees: "nav_employees", reports: "nav_reports", documents: "nav_documents",
    users: "nav_users", audit: "nav_audit", settings: "nav_settings", support: "nav_support", about: "nav_about",
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
// ── UI scale («حجم الواجهة») ───────────────────────────────────────────────
// Saved per machine; applied only while signed in so the login screen keeps its own layout.
const UI_SCALE_KEY = "autohr.uiScale";
const UI_SCALES = [90, 100, 110];
function savedUiScale() {
  try {
    const value = Number(localStorage.getItem(UI_SCALE_KEY));
    return UI_SCALES.includes(value) ? value : 100;
  } catch { return 100; }
}
function applyUiScale(percent) {
  const root = document.documentElement;
  if (!percent || percent === 100) {
    root.style.removeProperty("zoom");
    root.style.removeProperty("--ui-scale");
    delete root.dataset.uiScale;
  } else {
    root.style.zoom = String(percent / 100);
    root.style.setProperty("--ui-scale", String(percent / 100));
    root.dataset.uiScale = String(percent);
  }
  document.querySelectorAll("[data-ui-scale-option]").forEach(button => {
    button.setAttribute("aria-pressed", String(Number(button.dataset.uiScaleOption) === (percent || 100)));
  });
}
function bindUiScalePicker() {
  document.querySelectorAll("[data-ui-scale-option]").forEach(button => {
    button.addEventListener("click", () => {
      const percent = Number(button.dataset.uiScaleOption);
      try { localStorage.setItem(UI_SCALE_KEY, String(percent)); } catch { /* non-fatal */ }
      applyUiScale(percent);
    });
  });
}

async function enterApp(user) {
  currentUser = user;
  startInSessionBackups();
  applyUiScale(savedUiScale());
  renderSidebarUser(user);
  const canViewAudit = can(user, "audit.view");
  document.getElementById("nav-audit")?.classList.toggle("hidden", !canViewAudit);
  // «الإعدادات» is open to every user: it always holds «الدعم وحول النظام», and shows
  // the administrative tabs (users, storage, backups, updates) only with the permission.
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("password-change-screen").classList.add("hidden");
  document.getElementById("app-shell").classList.remove("hidden");
  try {
    applyBranding(await api.getCompanyConfig());
  } catch (_) { /* non-fatal */ }
  await navigateTo("dashboard");
  // «ما الجديد»: once, on the first sign-in after an update.
  await showWhatsNewIfUpdated();
  notifyDocumentAlerts();
  await checkDataIntegrity(user);
  offerAvailableUpdate(user);
}

// «كشف التعديل من خارج البرنامج»: after a System Admin signs in, ask once to approve data that was
// moved or restored from another computer, and warn when something was changed outside the program.
let integrityChecked = false;
async function checkDataIntegrity(user) {
  if (integrityChecked || !can(user, "users.assign_system_admin")) return;
  integrityChecked = true;
  try {
    const status = await api.getIntegrityStatus();
    if (status.state === "unapproved") {
      const ok = await confirmAction("هذه البيانات منقولة من جهاز آخر (أو مستعادة)، هل تعتمدها؟\n\nبعد الاعتماد يكشف البرنامج أي تعديل عليها من خارجه. إذا لم تنقل البيانات أنت، فاختر «إلغاء» وافحص البرنامج من «الفحص والدعم».");
      if (ok) {
        await api.approveIntegrity();
        showToast("تم اعتماد البيانات على هذا الجهاز.");
      }
    } else if (status.tampered) {
      const accounts = status.tampered_users?.length ? ` الحسابات المعنية: ${status.tampered_users.join("، ")}.` : "";
      showToast(`اكتُشف تعديل على البيانات من خارج البرنامج.${accounts} راجع «الإعدادات ← الفحص والدعم».`, "error");
    }
  } catch { /* the health check reports the details */ }
}

// «التحديث التلقائي»: once per run, after an administrator signs in, check quietly for a
// signed update and offer to install it. Nothing is installed without the user's yes.
let updateOffered = false;
async function offerAvailableUpdate(user) {
  if (updateOffered || !can(user, "settings.manage") || !can(user, "backups.manage")) return;
  updateOffered = true;
  try {
    if (!(await api.getAutoUpdate())) return;
    const info = await api.checkForUpdate();
    if (!info?.configured || !info.available) return;
    const notes = info.notes ? `\n\n${String(info.notes).slice(0, 400)}` : "";
    if (await confirmAction(`يوجد إصدار جديد من البرنامج: ${info.version} (الإصدار الحالي ${info.current_version}).${notes}\n\nسيتم إنشاء نسخة احتياطية ثم تثبيت التحديث، وسيُغلق البرنامج ويُعاد فتحه. هل تريد التثبيت الآن؟`)) {
      await installUpdateFlow({ confirmed: true });
    }
  } catch { /* offline or not configured: the «التحديثات» section reports it when opened */ }
}

// ── Login messages ─────────────────────────────────────────────────────────
// One fixed slot at the bottom of the card, under the unit name, so a message
// never covers the fields, the login button or the "forgot password" link.
let loginLockoutTimer = null;
// The name the countdown is for: another name on the same computer can still sign in.
let lockedLoginName = "";
let loginBusy = false;
const typedLoginName = () => (document.getElementById("login-username")?.value || "").trim().toLowerCase();
const lockoutApplies = () => Boolean(loginLockoutTimer) && typedLoginName() === lockedLoginName;

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
  if (lockoutApplies()) return;
  const slot = document.getElementById("login-error");
  slot.classList.add("hidden");
  slot.textContent = "";
  document.querySelectorAll(".login-field-invalid").forEach(input => input.classList.remove("login-field-invalid"));
}

function setLoginBusy(busy) {
  loginBusy = busy;
  const submit = document.querySelector(".login-hit-submit");
  if (submit) submit.disabled = busy || lockoutApplies();
  document.getElementById("login-form")?.setAttribute("aria-busy", String(busy));
}

function lockoutMinutes(message) {
  if (message.includes("دقيقة واحدة")) return 1;
  if (message.includes("دقيقتين")) return 2;
  return Number(message.match(/(\d+)/)?.[1] ?? 5);
}

function startLoginLockout(minutes) {
  let remaining = Math.max(1, minutes) * 60;
  lockedLoginName = typedLoginName();
  const tick = () => {
    const mm = String(Math.floor(remaining / 60)).padStart(2, "0");
    const ss = String(remaining % 60).padStart(2, "0");
    // Shown only while the paused name is in the field.
    if (lockoutApplies()) showLoginMessage(`تم إيقاف الدخول مؤقتًا. حاول بعد ${mm}:${ss}`, "error");
    remaining -= 1;
  };
  if (loginLockoutTimer) clearInterval(loginLockoutTimer);
  tick();
  loginLockoutTimer = setInterval(() => {
    if (remaining < 0) {
      clearInterval(loginLockoutTimer);
      loginLockoutTimer = null;
      lockedLoginName = "";
      clearLoginMessage();
      setLoginBusy(false);
      document.getElementById("login-password")?.focus();
      return;
    }
    tick();
  }, 1000);
  setLoginBusy(false);
}

/** Back on the paused name: show its countdown again at once (the timer keeps running). */
function startLoginLockoutDisplay() {
  showLoginMessage("تم إيقاف الدخول مؤقتًا بسبب تكرار المحاولات الخاطئة.", "error");
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
  if (loginBusy || lockoutApplies()) return;
  setLoginBusy(true);
  showLoginMessage("جارٍ التحقق…", "info");
  try {
    const user = await api.login(username, password);
    currentUser = user;
    rememberLoginUsername(user.username);
    clearLoginMessage();
    document.getElementById("login-screen").classList.add("hidden");
    if (user.must_change_password) {
      document.getElementById("password-change-screen").classList.remove("hidden");
      await window.autohrShowPasswordChange?.();
      document.getElementById("current-password").focus();
      return;
    }
    await enterApp(user);
  } catch (err) {
    const message = typeof err === "string" ? err : String(err?.message ?? err ?? "");
    if (message.startsWith("تم تعديل بيانات هذا الحساب") || message.startsWith("هذا الحساب موقوف")) {
      showLoginMessage(message, "error");
    } else if (message.startsWith("تم إيقاف الدخول مؤقتًا")) {
      startLoginLockout(lockoutMinutes(message));
      document.getElementById("login-password").value = "";
    } else if (message === "You are not authorized to perform this action" || message.startsWith(t("loginError"))) {
      // A wrong name or password; near the limit Rust adds how many attempts are left.
      showLoginMessage(message.startsWith(t("loginError")) ? message : t("loginError"), "error", "password");
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
  if (!(await confirmLeaveWhileBusy("تسجيل الخروج"))) return;
  if (unsavedAddEmployeeWork()) {
    if (!(await confirmLoseAddEmployeeWork("تسجيل الخروج"))) return;
  } else if (!(await confirmAction("تأكيد تسجيل الخروج؟"))) return;
  stopInSessionBackups();

  await runShutdownAutomaticBackups();

  if (currentUser) {
    try { await api.logout(); } catch (_) { /* non-fatal */ }
  }
  currentUser = null;
  clearAddEmployeeDraft();
  applyUiScale(100);
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
    if (!(await confirmLeaveWhileBusy("إغلاق البرنامج"))) return;
    if (!(await confirmLoseAddEmployeeWork("إغلاق البرنامج"))) return;
    isClosingWindow = true;
    stopInSessionBackups();
    try {
      await runShutdownAutomaticBackups();
    } finally {
      await api.exitApp();
    }
  });

  // First run or unavailable data folder: choose folders before the login screen.
  const firstRunUser = await runStartupGate();
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
    openForgotPassword((username, note) => {
      const name = document.getElementById("login-username");
      name.value = username;
      name.dispatchEvent(new Event("input"));
      document.getElementById("login-password").value = "";
      document.getElementById("login-password").focus();
      showLoginMessage(note || "تم تعيين كلمة المرور الجديدة. ادخل بها الآن.", "info");
    });
  });

  document.querySelectorAll("#login-username, #login-password").forEach(input => {
    const placeholder = input.placeholder;
    const syncPlaceholder = () => {
      input.placeholder = input.value ? "" : placeholder;
    };
    input.addEventListener("input", () => {
      syncPlaceholder();
      clearLoginMessage();
      if (lockoutApplies()) startLoginLockoutDisplay();
      setLoginBusy(loginBusy);
    });
    input.addEventListener("change", syncPlaceholder);
    syncPlaceholder();
  });

  const newPasswordInput = document.getElementById("new-password");
  ["current-password", "new-password", "confirm-password"].forEach(id => addPasswordToggle(document.getElementById(id)));
  watchCapsLock(["current-password", "new-password", "confirm-password"].map(id => document.getElementById(id)), document.getElementById("password-change-caps"));
  let changePolicy = null;
  const refreshChangeRules = async () => {
    changePolicy = await loadPasswordPolicy({ fresh: true });
    const holder = document.getElementById("password-change-rules");
    const clone = newPasswordInput; // rules follow this field as it is typed
    mountPasswordRules(holder, clone, changePolicy, () => currentUser?.username ?? "");
  };
  window.autohrShowPasswordChange = refreshChangeRules;

  document.getElementById("password-change-form").addEventListener("submit", async e => {
    e.preventDefault();
    const currentPassword = document.getElementById("current-password").value;
    const newPassword = document.getElementById("new-password").value;
    const confirmPassword = document.getElementById("confirm-password").value;
    const error = document.getElementById("password-change-error");
    const problem = !currentPassword ? "اكتب كلمة المرور الحالية"
      : (changePolicy && passwordProblem(changePolicy, newPassword, currentUser?.username ?? ""))
      || (newPassword !== confirmPassword ? "كلمتا المرور الجديدتان غير متطابقتين" : "");
    if (problem) {
      error.textContent = problem;
      error.classList.remove("hidden");
      return;
    }
    try {
      const user = await api.changePassword(currentPassword, newPassword);
      error.classList.add("hidden");
      document.getElementById("password-change-form").reset();
      await enterApp(user);
      showToast("تم تغيير كلمة المرور");
    } catch (err) {
      // A wrong current password comes back as «not authorized».
      error.textContent = errorText(err, "تعذر تغيير كلمة المرور") === "ليست لديك صلاحية لهذا الإجراء"
        ? "كلمة المرور الحالية غير صحيحة"
        : errorText(err, "تعذر تغيير كلمة المرور");
      error.classList.remove("hidden");
    }
  });

  // Logout buttons
  // Collapsible sidebar: ☰ button and Ctrl+B, state remembered between sessions.
  setSidebarCollapsed(readSidebarCollapsed());
  document.getElementById("btn-toggle-sidebar").addEventListener("click", toggleSidebar);
  document.getElementById("btn-sidebar-edge").addEventListener("click", toggleSidebar);
  // Light → dark → follow Windows on each click, available to every user from the header.
  mountThemeMenu(document.getElementById("btn-theme"));
  document.addEventListener("keydown", event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    if (event.code !== "KeyB" && event.key?.toLowerCase() !== "b") return;
    if (document.getElementById("app-shell")?.classList.contains("hidden")) return;
    event.preventDefault();
    toggleSidebar();
  });
  document.getElementById("btn-logout-side").addEventListener("click", doLogout);
  bindUiScalePicker();
  document.getElementById("btn-password-change-logout").addEventListener("click", doLogout);

  // Sidebar navigation
  document.getElementById("sidebar-nav").addEventListener("click", e => {
    const item = e.target.closest(".nav-item[data-screen]");
    if (item) navigateTo(item.dataset.screen);
  });

  // The first-run wizard has just made the administrator's account: open the program signed in.
  if (firstRunUser) {
    rememberLoginUsername(firstRunUser.username);
    await enterApp(firstRunUser);
    showToast("اكتمل الإعداد. مرحبًا بك في CNSArch");
  }
});
