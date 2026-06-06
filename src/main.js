/**
 * main.js — Auth, navigation, RBAC, i18n
 */
import { api }           from "./api.js";
import { applyBranding, showToast, confirmAction } from "./utils.js";
import { renderDashboard }  from "./screens/dashboard.js";
import { renderEmployees }  from "./screens/employees.js";
import { renderDocuments }  from "./screens/documents.js";
import { renderCompany }   from "./screens/company.js";
import { renderUsers }     from "./screens/users.js";
import { renderAbout }     from "./screens/about.js";

// ── i18n ───────────────────────────────────────────────────────────────────
const i18n = {
  appSubtitle: "نظام أرشفة وثائق الملاحة الجوية",
  username: "اسم المستخدم", password: "كلمة المرور",
  login: "تسجيل الدخول", logout: "تسجيل الخروج",
  user: "المستخدم",
  nav_dashboard: "لوحة التحكم العامة",
  nav_employees: "دليل الموظفين وإدارتهم",
  nav_documents: "أرشيف الوثائق",
  nav_company:   "إعدادات الهوية والأقسام",
  nav_users:     "إدارة المستخدمين والصلاحيات",
  nav_about:     "حول النظام",
  loginError:    "اسم المستخدم أو كلمة المرور غير صحيحة",
};

let currentUser = null;

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
    dashboard: "nav_dashboard", employees: "nav_employees",
    company: "nav_company", users: "nav_users", about: "nav_about",
  };
  document.querySelectorAll(".nav-item[data-screen]").forEach(el => {
    const screen = el.dataset.screen;
    if (navMap[screen]) {
      // preserve emoji prefix
      const icon = el.textContent.match(/^\S+/)?.[0] ?? "";
      el.textContent = icon + " " + t(navMap[screen]);
    }
  });
}

// ── Screen routing ─────────────────────────────────────────────────────────
const screenRenderers = {
  dashboard: renderDashboard,
  employees: renderEmployees,
  documents: renderDocuments,
  company:   renderCompany,
  users:     renderUsers,
  about:     renderAbout,
};

let activeScreen = "dashboard";

async function navigateTo(screen) {
  if (screen !== activeScreen && window.autohrCanLeaveCurrentScreen && !(await window.autohrCanLeaveCurrentScreen())) {
    return;
  }

  // RBAC guard
  const adminOnly = ["company", "users"];
  if (adminOnly.includes(screen) && !currentUser?.is_master) {
    document.getElementById("screen-container").innerHTML = `
      <div class="flex flex-col items-center justify-center h-full text-gray-500">
        <p class="text-5xl mb-4">🔒</p>
        <p class="text-xl">غير مصرح</p>
        <p class="text-sm mt-2">هذه الصفحة للمسؤول فقط</p>
      </div>`;
    return;
  }

  activeScreen = screen;
  document.querySelectorAll(".nav-item").forEach(el => {
    el.classList.toggle("active", el.dataset.screen === screen);
  });

  const titleMap = {
    dashboard: "nav_dashboard", employees: "nav_employees",
    company: "nav_company", users: "nav_users", about: "nav_about",
  };
  document.getElementById("page-title").textContent = t(titleMap[screen] ?? screen);

  const container = document.getElementById("screen-container");
  container.innerHTML = `<div class="flex items-center justify-center h-full text-gray-500 text-sm">جارٍ التحميل…</div>`;

  const renderer = screenRenderers[screen];
  if (renderer) {
    try {
      await renderer(container, currentUser, { t, navigateTo, showToast });
    } catch (err) {
      console.error(err);
      container.innerHTML = `<div class="card text-autohr-red">خطأ: ${err?.message ?? err}</div>`;
    }
  }
}

// ── Login ──────────────────────────────────────────────────────────────────
async function doLogin(username, password) {
  try {
    const user = await api.login(username, password);
    currentUser = user;
    document.getElementById("current-user").textContent = username;

    // RBAC nav visibility
    const navCompany = document.getElementById("nav-company");
    const navUsers   = document.getElementById("nav-users");
    if (user.is_master) {
      navCompany?.classList.remove("hidden");
      navUsers?.classList.remove("hidden");
    } else {
      navCompany?.classList.add("hidden");
      navUsers?.classList.add("hidden");
    }

    // Show app shell
    document.getElementById("login-screen").classList.add("hidden");
    document.getElementById("app-shell").classList.remove("hidden");

    // Apply company branding
    try {
      const cfg = await api.getCompanyConfig();
      applyBranding(cfg);
    } catch (_) { /* non-fatal */ }

    await navigateTo("dashboard");
  } catch (err) {
    const errEl = document.getElementById("login-error");
    errEl.textContent = t("loginError");
    errEl.classList.remove("hidden");
  }
}

async function doLogout() {
  if (window.autohrCanLeaveCurrentScreen && !(await window.autohrCanLeaveCurrentScreen())) {
    return;
  }
  if (!(await confirmAction("تأكيد تسجيل الخروج؟"))) return;

  if (currentUser) {
    try { await api.logout(currentUser.username); } catch (_) { /* non-fatal */ }
  }
  currentUser = null;
  document.getElementById("app-shell").classList.add("hidden");
  document.getElementById("login-screen").classList.remove("hidden");
  document.getElementById("login-username").value = "";
  document.getElementById("login-password").value = "";
  document.getElementById("login-error").classList.add("hidden");
}

// ── Bootstrap ──────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  applyLang();

  // Login form
  document.getElementById("login-form").addEventListener("submit", e => {
    e.preventDefault();
    const u = document.getElementById("login-username").value.trim();
    const p = document.getElementById("login-password").value;
    if (u && p) doLogin(u, p);
  });

  // Logout buttons
  document.getElementById("btn-logout-top").addEventListener("click",  doLogout);
  document.getElementById("btn-logout-side").addEventListener("click", doLogout);

  // Sidebar navigation
  document.getElementById("sidebar-nav").addEventListener("click", e => {
    const item = e.target.closest(".nav-item[data-screen]");
    if (item) navigateTo(item.dataset.screen);
  });
});
