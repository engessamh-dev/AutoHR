/**
 * screens/settings.js — Company identity & logo, storage locations, backups (admins only)
 */
import { api }       from "../api.js";
import { showToast, confirmAction, applyBranding, escHtml } from "../utils.js";
import { open }      from "@tauri-apps/plugin-dialog";
import { can }       from "../permissions.js";
import { listen }    from "@tauri-apps/api/event";
import { APP_VERSION } from "../version.js";
import { COMPANY_LOGO } from "../branding.js";
import { renderSupport } from "./support.js";
import { renderAbout } from "./about.js";
import { renderUsers } from "./users.js";
import { renderAlertSettings } from "./alert-settings.js";

let activeSettingsTab = null;
// The section open in each tab's inner list, kept while the screen re-renders.
const activeSubsection = {};

/**
 * Keeps a save button dimmed and disabled until one of its fields differs from the saved
 * value. Returns reset(), to call after a successful save so the new values become the baseline.
 */
function trackUnsavedChanges(root, button, selectors) {
  if (!button) return () => {};
  const fields = selectors.map(selector => root.querySelector(selector)).filter(Boolean);
  const read = () => fields.map(field => (field.type === "checkbox" ? String(field.checked) : field.value.trim()));
  let saved = read();
  const update = () => {
    const now = read();
    button.disabled = !now.some((value, index) => value !== saved[index]);
  };
  fields.forEach(field => {
    field.addEventListener("input", update);
    field.addEventListener("change", update);
  });
  update();
  return () => { saved = read(); update(); };
}

/**
 * Turns a tab's cards into an inner list: a side menu built from the cards' data-sub /
 * data-sub-label, showing one card at a time.
 */
function mountSubnav(panel, key) {
  const sections = [...panel.querySelectorAll("[data-sub]")];
  if (sections.length < 2) return;
  const body = document.createElement("div");
  body.className = "settings-subnav-body";
  while (panel.firstChild) body.append(panel.firstChild);
  const nav = document.createElement("nav");
  nav.className = "settings-subnav";
  nav.innerHTML = sections.map(section => `<button type="button" class="settings-subnav-item${section.dataset.subDanger ? " is-danger" : ""}"
    data-sub-target="${escHtml(section.dataset.sub)}">${escHtml(section.dataset.subLabel)}</button>`).join("");
  panel.classList.add("settings-subnav-layout");
  panel.append(nav, body);
  const show = id => {
    activeSubsection[key] = id;
    sections.forEach(section => section.classList.toggle("sub-hidden", section.dataset.sub !== id));
    nav.querySelectorAll("[data-sub-target]").forEach(item => item.setAttribute("aria-current", String(item.dataset.subTarget === id)));
  };
  nav.addEventListener("click", event => {
    const item = event.target.closest("[data-sub-target]");
    if (item) show(item.dataset.subTarget);
  });
  show(sections.some(section => section.dataset.sub === activeSubsection[key]) ? activeSubsection[key] : sections[0].dataset.sub);
}

function bindPasswordToggle(root, inputSelector, buttonSelector) {
  const input = root.querySelector(inputSelector);
  const button = root.querySelector(buttonSelector);
  if (!input || !button) return;
  button.addEventListener("click", () => {
    const showPassword = input.type === "password";
    input.type = showPassword ? "text" : "password";
    button.textContent = showPassword ? "إخفاء" : "إظهار";
    button.setAttribute("aria-pressed", String(showPassword));
    input.focus();
  });
}

function openBackupProgress({ title = "إنشاء نسخة احتياطية", message = "جاري بدء النسخ..." } = {}) {
  const overlay = document.createElement("div");
  overlay.setAttribute("dir", "rtl");
  overlay.style.cssText = "position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.62);display:flex;align-items:center;justify-content:center;padding:20px";
  overlay.innerHTML = `
    <div style="width:min(440px,100%);background:var(--ui-surface);border:1px solid var(--ui-line);border-radius:10px;padding:18px;box-shadow:0 18px 60px rgba(0,0,0,.45)">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px">
        <p style="font-size:15px;font-weight:700;color:var(--ui-text-strong);margin:0">${title}</p>
        <span id="backup-progress-percent" class="badge badge-gray">0%</span>
      </div>
      <div style="height:10px;background:var(--ui-sunken);border-radius:999px;overflow:hidden;border:1px solid var(--ui-line)">
        <div id="backup-progress-bar" style="height:100%;width:0%;background:var(--ui-accent);transition:width .2s ease"></div>
      </div>
      <p id="backup-progress-message" style="font-size:12px;color:var(--ui-text-muted);margin:12px 0 0">${message}</p>
    </div>`;
  document.body.append(overlay);
  return {
    update(progress = {}) {
      const percent = Math.max(0, Math.min(100, Number(progress.percent ?? 0)));
      overlay.querySelector("#backup-progress-bar").style.width = `${percent}%`;
      overlay.querySelector("#backup-progress-percent").textContent = `${percent}%`;
      overlay.querySelector("#backup-progress-message").textContent = progress.message || "جاري إنشاء النسخة الاحتياطية...";
    },
    close() {
      overlay.remove();
    },
    // Keeps the result on screen (with the full file path) until the user closes it.
    done(message, path = "") {
      this.update({ percent: 100, message });
      const box = overlay.firstElementChild;
      if (path) {
        const pathLine = document.createElement("p");
        pathLine.dir = "ltr";
        pathLine.style.cssText = "font-size:12px;color:var(--ui-text-strong);background:var(--ui-sunken);border:1px solid var(--ui-line);border-radius:6px;padding:8px;margin:10px 0 0;word-break:break-all;user-select:text";
        pathLine.textContent = path;
        box.append(pathLine);
      }
      const ok = document.createElement("button");
      ok.type = "button";
      ok.className = "btn-primary";
      ok.style.marginTop = "14px";
      ok.textContent = "تم";
      ok.addEventListener("click", () => overlay.remove());
      box.append(ok);
      ok.focus();
    },
  };
}

function requestBackupPassword({ title, message, minLength = 1 }) {
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.setAttribute("dir", "rtl");
    overlay.style.cssText = `
      position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.62);
      display:flex;align-items:center;justify-content:center;padding:20px;
    `;
    overlay.innerHTML = `
      <div style="width:min(440px,100%);background:var(--ui-surface);border:1px solid var(--ui-line);
        border-radius:10px;padding:18px;box-shadow:0 18px 60px rgba(0,0,0,.45)">
        <p style="font-size:16px;font-weight:700;color:var(--ui-text-strong);margin:0 0 8px">${title}</p>
        <p style="font-size:13px;line-height:1.8;color:var(--ui-text-muted);margin:0 0 14px">${message}</p>
        <div style="display:flex;gap:8px;margin-bottom:8px">
          <input id="backup-password-input" class="input-field" type="password"
            autocomplete="current-password" style="flex:1" />
          <button type="button" id="backup-password-toggle" class="btn-secondary"
            aria-pressed="false" style="min-width:74px">إظهار</button>
        </div>
        <p id="backup-password-error" class="hidden" style="font-size:12px;color:var(--ui-danger);margin:0 0 12px"></p>
        <div style="display:flex;gap:10px;justify-content:flex-start">
          <button type="button" id="backup-password-confirm" class="btn-primary">تأكيد</button>
          <button type="button" id="backup-password-cancel" class="btn-secondary">إلغاء</button>
        </div>
      </div>`;

    const input = overlay.querySelector("#backup-password-input");
    const error = overlay.querySelector("#backup-password-error");
    bindPasswordToggle(overlay, "#backup-password-input", "#backup-password-toggle");
    const finish = value => {
      document.removeEventListener("keydown", onKeyDown);
      overlay.remove();
      resolve(value);
    };
    const submit = () => {
      const password = input.value;
      if (password.length < minLength) {
        error.textContent = `كلمة المرور يجب أن تكون ${minLength} أحرف على الأقل`;
        error.classList.remove("hidden");
        input.focus();
        return;
      }
      finish(password);
    };
    const onKeyDown = event => {
      if (event.key === "Escape") finish(null);
      if (event.key === "Enter") submit();
    };

    overlay.querySelector("#backup-password-confirm").addEventListener("click", submit);
    overlay.querySelector("#backup-password-cancel").addEventListener("click", () => finish(null));
    overlay.addEventListener("click", event => {
      if (event.target === overlay) finish(null);
    });
    document.addEventListener("keydown", onKeyDown);
    document.body.append(overlay);
    setTimeout(() => input.focus(), 0);
  });
}

// Storage warnings («على نفس القرص»…) can be dismissed per device. The key includes both
// folders, so the warning shows again after either folder changes and the condition still holds.
const DISMISSED_STORAGE_WARNINGS_KEY = "autohr.dismissedStorageWarnings";

function storageWarningKey(warning, status) {
  return [warning, status?.data_root ?? "", status?.backup_root ?? ""].join("|");
}

function dismissedStorageWarnings() {
  try { return JSON.parse(localStorage.getItem(DISMISSED_STORAGE_WARNINGS_KEY) || "[]"); }
  catch { return []; }
}

function isStorageWarningDismissed(key) {
  return dismissedStorageWarnings().includes(key);
}

function dismissStorageWarning(key) {
  const list = [...new Set([...dismissedStorageWarnings(), key])].slice(-20);
  try { localStorage.setItem(DISMISSED_STORAGE_WARNINGS_KEY, JSON.stringify(list)); } catch { /* storage is optional */ }
}

/**
 * Installs an available update the safe way: the user confirms, gives a password for the
 * encrypted backup taken first, then Rust verifies the backup and the developer's signature.
 * Used by the «التحديثات» section and by the offer shown after sign-in (automatic updates).
 */
export async function installUpdateFlow({ confirmed = false } = {}) {
  if (!confirmed && !(await confirmAction("سيتم إنشاء نسخة احتياطية ثم تنزيل التحديث وتثبيته، وسيُغلق البرنامج ويُعاد فتحه. هل تريد المتابعة؟"))) return;
  const password = await requestBackupPassword({
    title: "نسخة احتياطية قبل التحديث",
    message: "أدخل كلمة مرور للنسخة الاحتياطية التي تُنشأ قبل التحديث (8 أحرف على الأقل).",
    minLength: 8,
  });
  if (!password) return;
  const progress = openBackupProgress({ title: "تحديث البرنامج", message: "جاري التحضير..." });
  let unlisten = null;
  try {
    unlisten = await listen("update-progress", event => progress.update(event.payload));
    await api.installUpdate(password);
  } catch (err) {
    showToast(err?.message ?? String(err), "error");
    progress.close();
  } finally {
    if (unlisten) unlisten();
  }
}

export async function renderSettings(container, user, ctx) {
  // Opening «الإعدادات» always starts on the first tab and the first item of its inner list.
  // Only a redraw from inside this screen (keepPosition) stays where the user was.
  if (!ctx?.keepPosition) {
    activeSettingsTab = null;
    Object.keys(activeSubsection).forEach(key => delete activeSubsection[key]);
  }
  const canSettings = can(user, "settings.manage");
  const canBackups = can(user, "backups.manage");
  const canUsers = can(user, "users.manage");
  // Restoring replaces every table, users included, so only a System Admin may do it.
  const canRestore = can(user, "backups.restore");
  let storageStatus = null;
  let companyConfig = null;
  let autoBackup = null;
  if (canSettings) {
    try {
      [storageStatus, companyConfig] = await Promise.all([
        api.getStorageStatus(),
        api.getCompanyConfig(),
      ]);
    } catch {}
  }
  if (canBackups) {
    try {
      autoBackup = await api.getAutoBackupSettings();
    } catch {}
  }

  let autoUpdate = true;
  if (canSettings && canBackups) {
    try { autoUpdate = await api.getAutoUpdate(); } catch {}
  }

  const tabs = [
    canSettings && { id: "company", label: "الجهة والشعار" },
    canUsers && { id: "users", label: "المستخدمين والصلاحيات" },
    (canSettings || canBackups) && { id: "storage", label: "الحفظ والنسخ الاحتياطي" },
    canSettings && { id: "alerts", label: "تنبيهات المستمسكات" },
    { id: "support", label: "الدعم وحول النظام" },
  ].filter(Boolean);
  if (ctx?.tab) activeSettingsTab = ctx.tab;
  if (activeSettingsTab === "backup") activeSettingsTab = "storage";
  if (activeSettingsTab === "about") activeSettingsTab = "support";
  // «التحديثات» is now a section of «الدعم وحول النظام».
  if (activeSettingsTab === "updates") { activeSettingsTab = "support"; activeSubsection.support = "updates"; }
  if (!tabs.some(tab => tab.id === activeSettingsTab)) activeSettingsTab = tabs[0].id;

  const logoMarkup = () =>
    `<img src="${escHtml(COMPANY_LOGO.medium)}" id="logo-preview" alt="${escHtml(COMPANY_LOGO.alt)}" class="settings-logo company-logo-tile" />`;

  container.innerHTML = `
    <div class="settings-screen space-y-4">
      <div class="settings-tabs" role="tablist">
        ${tabs.map(tab => `<button type="button" role="tab" class="settings-tab" data-settings-tab="${tab.id}"
          aria-selected="${tab.id === activeSettingsTab}">${tab.label}</button>`).join("")}
      </div>

      ${canSettings ? `<section class="card settings-panel settings-block" data-settings-panel="company">
        <div class="settings-block-head">
          <p class="settings-block-title">الجهة والشعار</p>
          <p class="settings-block-help">يظهر اسم الجهة والقسم في رأس الشاشات وفي المطبوعات والتقارير.</p>
        </div>
        <div class="settings-company">
          <div class="settings-logo-col">
            <div id="company-logo-box">${logoMarkup()}</div>
            <p class="text-xs text-gray-500">شعار الشركة ثابت ومضمَّن في النظام</p>
          </div>
          <div class="settings-company-fields space-y-3">
            <div>
              <label class="section-title" for="c-company">اسم الشركة / الجهة *</label>
              <input id="c-company" class="input-field" value="${escHtml(companyConfig?.company_name ?? "")}" />
            </div>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label class="section-title" for="c-dept">اسم القسم</label>
                <input id="c-dept" class="input-field" value="${escHtml(companyConfig?.department_name ?? "")}" />
              </div>
              <div>
                <label class="section-title" for="c-div">اسم الشعبة / الوحدة</label>
                <input id="c-div" class="input-field" value="${escHtml(companyConfig?.division_name ?? "")}" />
              </div>
            </div>
          </div>
        </div>
        <div class="settings-block-foot">
          <button id="btn-save-cfg" type="button" class="btn-primary">حفظ بيانات الجهة</button>
        </div>
      </section>` : ""}


      ${canSettings || canBackups ? `<section class="settings-panel settings-stack" data-settings-panel="storage">
      ${canSettings ? `<div class="card settings-block" data-sub="locations" data-sub-label="مواقع الحفظ">
        <div class="settings-block-head">
          <p class="settings-block-title">مواقع الحفظ</p>
          <p class="settings-block-help">يمكن نقل مجلد البيانات أو تغيير مجلد النسخ بأمان: يُنسخ كل شيء ويُتحقق منه أولًا، ويبقى الموقع القديم كما هو.</p>
        </div>
        ${(storageStatus?.warnings || []).filter(w => !isStorageWarningDismissed(storageWarningKey(w, storageStatus))).map(w => `<div class="settings-storage-warning text-xs" role="status" data-warning-key="${escHtml(storageWarningKey(w, storageStatus))}">
          <span>${escHtml(w)}</span>
          <button type="button" class="settings-warning-dismiss" title="إخفاء هذا التنبيه على هذا الجهاز">حسنًا</button>
        </div>`).join("")}
        <div>
          <div class="settings-path-row">
            <div class="min-w-0">
              <p class="settings-path-label">مجلد البيانات والمرفقات</p>
              <p id="storage-path-text" class="settings-path-value" dir="ltr">${escHtml(storageStatus?.data_root || "—")}</p>
            </div>
            <div class="settings-path-actions">
              <button id="btn-open-storage" type="button" class="btn-secondary whitespace-nowrap">فتح المجلد</button>
              ${canBackups ? `<button id="btn-move-storage" type="button" class="btn-secondary whitespace-nowrap">نقل المجلد…</button>` : ""}
            </div>
          </div>
          <div class="settings-path-row">
            <div class="min-w-0">
              <p class="settings-path-label">مجلد النسخ الاحتياطية</p>
              <p id="backup-path-text" class="settings-path-value" dir="ltr">${escHtml(storageStatus?.backup_root || "—")}</p>
            </div>
            <div class="settings-path-actions">
              <button id="btn-open-backup" type="button" class="btn-secondary whitespace-nowrap">فتح المجلد</button>
              <button id="btn-change-backup" type="button" class="btn-secondary whitespace-nowrap">تغيير المجلد…</button>
            </div>
          </div>
        </div>
      </div>` : ""}

      ${canBackups ? `<div class="card settings-block" data-sub="auto" data-sub-label="النسخ التلقائي">
        <div class="settings-block-head">
          <p class="settings-block-title">النسخ التلقائي</p>
          <p class="settings-block-help">تشمل كل نسخة قاعدة البيانات وجميع المرفقات والوثائق، وتُشفَّر بكلمة المرور أدناه.</p>
        </div>
        <div class="backup-schedules">
            <label class="backup-schedule">
              <input id="auto-backup-daily" type="checkbox" ${autoBackup?.daily_enabled ? "checked" : ""} />
              <span class="backup-schedule-name">يومي</span>
              <span class="backup-schedule-last">آخر نسخة: <span dir="ltr">${escHtml(autoBackup?.last_daily || "—")}</span></span>
            </label>
            <label class="backup-schedule">
              <input id="auto-backup-weekly" type="checkbox" ${autoBackup?.weekly_enabled ? "checked" : ""} />
              <span class="backup-schedule-name">أسبوعي</span>
              <span class="backup-schedule-last">آخر نسخة: <span dir="ltr">${escHtml(autoBackup?.last_weekly || "—")}</span></span>
            </label>
            <label class="backup-schedule">
              <input id="auto-backup-monthly" type="checkbox" ${autoBackup?.monthly_enabled ? "checked" : ""} />
              <span class="backup-schedule-name">شهري</span>
              <span class="backup-schedule-last">آخر نسخة: <span dir="ltr">${escHtml(autoBackup?.last_monthly || "—")}</span></span>
            </label>
        </div>
        <div class="backup-password-row">
          <label class="settings-path-label" for="auto-backup-password">كلمة مرور النسخ التلقائية</label>
          <div class="flex gap-2">
            <input id="auto-backup-password" class="input-field flex-1" type="password"
              placeholder="${autoBackup?.has_password ? "اتركها فارغة للإبقاء على كلمة المرور الحالية" : "أدخل كلمة مرور 8 أحرف على الأقل"}"
              autocomplete="new-password" />
            <button type="button" id="auto-backup-password-toggle" class="btn-secondary whitespace-nowrap"
              aria-pressed="false">إظهار</button>
          </div>
        </div>
        <div class="settings-block-foot">
          <button id="btn-save-auto-backup" class="btn-primary">حفظ إعدادات النسخ التلقائي</button>
        </div>
      </div>

      <div class="card settings-block" data-sub="manual" data-sub-label="نسخة يدوية">
        <div class="settings-block-head">
          <p class="settings-block-title">نسخة يدوية</p>
          <p class="settings-block-help">أنشئ نسخة الآن في مجلد النسخ، أو صدّرها إلى قرص خارجي أو مجلد شبكة.</p>
        </div>
        <div class="flex gap-3 flex-wrap">
          <button id="btn-create-backup" class="btn-primary">إنشاء نسخة احتياطية الآن</button>
          <button id="btn-export-backup" class="btn-secondary">تصدير نسخة إلى…</button>
        </div>
      </div>

      ${canRestore ? `<div class="card danger-zone settings-block" data-sub="restore" data-sub-label="الاستعادة" data-sub-danger="1">
        <div class="settings-block-head">
          <p class="danger-zone-title"><span aria-hidden="true">⚠</span> استعادة نسخة احتياطية</p>
          <p class="settings-block-help">تستبدل الاستعادة كل البيانات والمرفقات الحالية بمحتوى النسخة المختارة، وتضيع أي تغييرات بعد تاريخها. يُنصح بإنشاء نسخة الآن قبل الاستعادة.</p>
        </div>
        <div>
          <button id="btn-restore-backup" class="btn-danger-outline">استعادة نسخة احتياطية…</button>
        </div>
      </div>` : ""}` : ""}
      </section>` : ""}




      ${canUsers ? `<div class="settings-panel" data-settings-panel="users"></div>` : ""}
      ${canSettings ? `<div class="settings-panel" data-settings-panel="alerts"></div>` : ""}
      <div class="settings-panel settings-stack" data-settings-panel="support">
        <div data-embedded="about"></div>
        <div data-embedded="support"></div>
        ${canSettings && canBackups ? `<section class="card settings-block" data-sub="updates" data-sub-label="التحديثات">
          <div class="settings-block-head">
            <p class="settings-block-title">تحديث البرنامج</p>
            <p class="settings-block-help">يتحقق البرنامج من وجود إصدار جديد موقّع. قبل التثبيت تُنشأ نسخة احتياطية مشفرة ويُتحقق منها، ولا يُثبَّت أي ملف لا يحمل توقيع المطوّر.</p>
          </div>
          <label class="backup-schedule auto-update-toggle">
          <input id="auto-update-enabled" type="checkbox" ${autoUpdate ? "checked" : ""} />
          <span class="backup-schedule-name">التحديث التلقائي</span>
          <span class="backup-schedule-last">عند الدخول يتحقق البرنامج من وجود إصدار جديد ويعرض عليك تثبيته. لا يبدأ التثبيت إلا بموافقتك وبعد نسخة احتياطية مشفرة.</span>
        </label>
        <p id="update-status" class="settings-status-line">الإصدار الحالي: <span dir="ltr">${escHtml(APP_VERSION)}</span></p>
          <div id="update-notes" class="hidden text-xs text-gray-400 whitespace-pre-line border border-autohr-border rounded-lg p-3"></div>
          <div class="settings-block-foot">
            <button id="btn-check-update" type="button" class="btn-primary">التحقق من التحديثات</button>
            <button id="btn-install-update" type="button" class="btn-primary hidden">تثبيت التحديث</button>
          </div>
        </section>` : ""}
      </div>
    </div>`;


  // «الدعم وحول النظام» draws the about card and the check/contact screen into one tab on first open.
  let supportRendered = false;
  let usersRendered = false;
  let alertsRendered = false;
  const showTab = id => {
    if (id === "alerts" && !alertsRendered) {
      alertsRendered = true;
      const panel = container.querySelector('[data-settings-panel="alerts"]');
      renderAlertSettings(panel).catch(err => {
        panel.innerHTML = `<div class="card text-sm text-gray-400" dir="auto">${escHtml(err?.message ?? String(err))}</div>`;
      });
    }
    activeSettingsTab = id;
    if (id === "users" && !usersRendered) {
      usersRendered = true;
      const panel = container.querySelector('[data-settings-panel="users"]');
      renderUsers(panel, user).catch(err => {
        panel.innerHTML = `<div class="card text-sm text-gray-400" dir="auto">${escHtml(err?.message ?? String(err))}</div>`;
      });
    }
    if (id === "support" && !supportRendered) {
      supportRendered = true;
      const panel = container.querySelector('[data-settings-panel="support"]');
      Promise.all([["about", renderAbout], ["support", renderSupport]].map(([key, render]) => {
        const host = panel.querySelector(`[data-embedded="${key}"]`);
        return render(host, user, { ...ctx, embedded: true }).catch(err => {
          host.innerHTML = `<div class="card text-sm text-gray-400" dir="auto">${escHtml(err?.message ?? String(err))}</div>`;
        });
      })).then(() => mountSubnav(panel, "support"));
    }
    container.querySelectorAll("[data-settings-tab]").forEach(tab => tab.setAttribute("aria-selected", String(tab.dataset.settingsTab === id)));
    container.querySelectorAll("[data-settings-panel]").forEach(panel => panel.classList.toggle("hidden", panel.dataset.settingsPanel !== id));
  };
  container.querySelectorAll("[data-settings-tab]").forEach(tab => tab.addEventListener("click", () => showTab(tab.dataset.settingsTab)));
  const storagePanel = container.querySelector('[data-settings-panel="storage"]');
  if (storagePanel) mountSubnav(storagePanel, "storage");
  showTab(activeSettingsTab);

  bindPasswordToggle(container, "#auto-backup-password", "#auto-backup-password-toggle");

  const resetCompanyDirty = trackUnsavedChanges(container, container.querySelector("#btn-save-cfg"), ["#c-company", "#c-dept", "#c-div"]);
  const resetAutoBackupDirty = trackUnsavedChanges(container, container.querySelector("#btn-save-auto-backup"),
    ["#auto-backup-daily", "#auto-backup-weekly", "#auto-backup-monthly", "#auto-backup-password"]);

  container.querySelector("#btn-save-cfg")?.addEventListener("click", async () => {
    const data = {
      company_name: container.querySelector("#c-company").value.trim(),
      department_name: container.querySelector("#c-dept").value.trim(),
      division_name: container.querySelector("#c-div").value.trim(),
    };
    if (!data.company_name) { showToast("اسم الشركة مطلوب", "error"); return; }
    try {
      companyConfig = await api.updateCompanyConfig(data);
      applyBranding(companyConfig);
      resetCompanyDirty();
      showToast("تم حفظ بيانات الجهة");
    } catch (err) { showToast(err?.message ?? "خطأ", "error"); }
  });

  // The data and backup folders are fixed by the backend for safety, so they
  // are shown read-only with a button that opens them in Windows Explorer.
  const bindOpenFolder = (buttonId, kind) => {
    container.querySelector(buttonId)?.addEventListener("click", async () => {
      try { await api.openManagedFolder(kind); }
      catch (err) { showToast(err?.message ?? "تعذر فتح المجلد", "error"); }
    });
  };
  bindOpenFolder("#btn-open-storage", "data");
  container.querySelectorAll(".settings-warning-dismiss").forEach(button => button.addEventListener("click", () => {
    const warning = button.closest(".settings-storage-warning");
    dismissStorageWarning(warning.dataset.warningKey);
    warning.remove();
  }));
  bindOpenFolder("#btn-open-backup", "backups");

  const pickFolder = title => open({ directory: true, multiple: false, title });

  container.querySelector("#btn-change-backup")?.addEventListener("click", async () => {
    const selected = await pickFolder("اختر مجلد النسخ الاحتياطية الجديد");
    if (!selected) return;
    if (!(await confirmAction(`سيتم حفظ النسخ الاحتياطية الجديدة في: ${selected} — النسخ القديمة تبقى في مكانها. هل تريد المتابعة؟`))) return;
    try {
      await api.changeBackupFolder(selected);
      showToast("تم تغيير مجلد النسخ الاحتياطية");
      renderSettings(container, user, { ...ctx, tab: undefined, keepPosition: true });
    } catch (err) {
      showToast(err?.message ?? String(err), "error");
    }
  });

  container.querySelector("#btn-move-storage")?.addEventListener("click", async () => {
    const selected = await pickFolder("اختر مجلدًا فارغًا لنقل البيانات إليه");
    if (!selected) return;
    if (!(await confirmAction(`سيتم نسخ قاعدة البيانات وجميع المرفقات إلى: ${selected} ثم التحقق منها قبل التحويل. يبقى المجلد الحالي كما هو دون حذف، وسيُطلب تسجيل الدخول من جديد. هل تريد المتابعة؟`))) return;
    const password = await requestBackupPassword({
      title: "نسخة أمان قبل النقل",
      message: "قبل النقل تُنشأ نسخة احتياطية مشفرة للأمان. أدخل كلمة مرور لها (8 أحرف على الأقل) واحتفظ بها.",
      minLength: 8,
    });
    if (!password) return;
    const progress = openBackupProgress({ title: "نقل مجلد البيانات", message: "جاري التحضير..." });
    let unlisten = null;
    try {
      unlisten = await listen("move-data-progress", event => progress.update(event.payload));
      await api.moveDataFolder(selected, password);
      progress.update({ percent: 100, message: "تم النقل والتحقق. سيتم إعادة تسجيل الدخول." });
      showToast("تم نقل مجلد البيانات بنجاح. الموقع القديم بقي كما هو.");
      setTimeout(() => window.location.reload(), 1500);
    } catch (err) {
      showToast(err?.message ?? String(err), "error");
      progress.close();
    } finally {
      if (unlisten) unlisten();
    }
  });

  const updateStatus = container.querySelector("#update-status");
  const installButton = container.querySelector("#btn-install-update");
  container.querySelector("#btn-check-update")?.addEventListener("click", async event => {
    const button = event.currentTarget;
    button.disabled = true;
    updateStatus.textContent = "جاري التحقق...";
    installButton.classList.add("hidden");
    const notes = container.querySelector("#update-notes");
    notes.classList.add("hidden");
    try {
      const info = await api.checkForUpdate();
      if (!info.configured) {
        updateStatus.textContent = `الإصدار الحالي: ${info.current_version} — التحديث التلقائي غير مُعد بعد في هذه النسخة.`;
      } else if (info.available) {
        updateStatus.textContent = `يوجد إصدار جديد: ${info.version} (الإصدار الحالي ${info.current_version})`;
        if (info.notes) { notes.textContent = info.notes; notes.classList.remove("hidden"); }
        installButton.classList.remove("hidden");
      } else {
        updateStatus.textContent = `الإصدار الحالي ${info.current_version} هو الأحدث.`;
      }
    } catch (err) {
      updateStatus.textContent = `الإصدار الحالي: ${APP_VERSION} — ${err?.message ?? String(err)}`;
    } finally {
      button.disabled = false;
    }
  });
  installButton?.addEventListener("click", () => installUpdateFlow());
  container.querySelector("#auto-update-enabled")?.addEventListener("change", async event => {
    const input = event.currentTarget;
    input.disabled = true;
    try {
      input.checked = await api.setAutoUpdate(input.checked);
      showToast(input.checked ? "تم تفعيل التحديث التلقائي" : "تم إيقاف التحديث التلقائي");
    } catch (err) {
      input.checked = !input.checked;
      showToast(err?.message ?? String(err), "error");
    } finally {
      input.disabled = false;
    }
  });

  container.querySelector("#btn-export-backup")?.addEventListener("click", async () => {
    const selected = await pickFolder("اختر المجلد الذي ستُحفظ فيه النسخة (قرص خارجي أو مجلد شبكة)");
    if (!selected) return;
    const password = await requestBackupPassword({
      title: "تصدير نسخة احتياطية",
      message: "أدخل كلمة مرور للنسخة المصدّرة (8 أحرف على الأقل).",
      minLength: 8,
    });
    if (!password) return;
    const progress = openBackupProgress({ title: "تصدير نسخة احتياطية" });
    let unlisten = null;
    try {
      unlisten = await listen("backup-progress", event => progress.update(event.payload));
      const path = await api.exportBackupTo(selected, password);
      progress.done("تم تصدير النسخة والتحقق منها بنجاح. مكان الملف:", path);
    } catch (err) {
      showToast(err?.message ?? String(err), "error");
      progress.close();
    } finally {
      if (unlisten) unlisten();
    }
  });

  container.querySelector("#btn-create-backup")?.addEventListener("click", async () => {
    const password = await requestBackupPassword({
      title: "إنشاء نسخة احتياطية",
      message: "أدخل كلمة مرور للنسخة الاحتياطية (8 أحرف على الأقل).",
      minLength: 8,
    });
    if (!password) return;
    const progress = openBackupProgress();
    let unlisten = null;
    try {
      unlisten = await listen("backup-progress", event => progress.update(event.payload));
      const backup = await api.createBackup(password);
      progress.done("اكتمل إنشاء النسخة الاحتياطية والتحقق منها. مكان الملف:", backup);
    } catch (err) {
      showToast(err?.message ?? "خطأ", "error");
      progress.close();
    } finally {
      if (unlisten) unlisten();
    }
  });
  container.querySelector("#btn-save-auto-backup")?.addEventListener("click", async () => {
    const data = {
      daily_enabled: Boolean(container.querySelector("#auto-backup-daily")?.checked),
      weekly_enabled: Boolean(container.querySelector("#auto-backup-weekly")?.checked),
      monthly_enabled: Boolean(container.querySelector("#auto-backup-monthly")?.checked),
      password: container.querySelector("#auto-backup-password")?.value || null,
    };
    if ((data.daily_enabled || data.weekly_enabled || data.monthly_enabled) && !autoBackup?.has_password && !data.password) {
      showToast("أدخل كلمة مرور للنسخ التلقائية قبل التفعيل", "error");
      return;
    }
    if (data.password && data.password.length < 8) {
      showToast("كلمة مرور النسخ التلقائية يجب أن تكون 8 أحرف على الأقل", "error");
      return;
    }
    try {
      autoBackup = await api.setAutoBackupSettings(data);
      container.querySelector("#auto-backup-password").value = "";
      resetAutoBackupDirty();
      showToast("تم حفظ إعدادات النسخ التلقائي");
    } catch (err) {
      showToast(err?.message ?? "خطأ", "error");
    }
  });
  container.querySelector("#btn-restore-backup")?.addEventListener("click", async () => {
    const selected = await open({ multiple: false, filters: [{ name: "Encrypted CNSArch Backup", extensions: ["autohrbak"] }] });
    if (!selected || !(await confirmAction("ستُستبدل كل البيانات والمرفقات الحالية بمحتوى النسخة المختارة، وتضيع أي تغييرات بعد تاريخها. هل تريد المتابعة؟"))) return;
    const password = await requestBackupPassword({
      title: "استعادة نسخة احتياطية",
      message: "أدخل كلمة مرور النسخة الاحتياطية المحددة.",
    });
    if (!password) return;
    const progress = openBackupProgress({
      title: "استعادة نسخة احتياطية",
      message: "جاري بدء الاستعادة...",
    });
    let unlisten = null;
    try {
      unlisten = await listen("restore-progress", event => progress.update(event.payload));
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
      await api.restoreBackup(selected, password);
      progress.update({ percent: 100, message: "اكتملت استعادة النسخة الاحتياطية" });
      showToast("تمت استعادة النسخة الاحتياطية. سيتم إعادة تسجيل الدخول.");
      setTimeout(() => window.location.reload(), 1200);
    }
    catch (err) {
      showToast(err?.message ?? "خطأ", "error");
      progress.close();
    } finally {
      if (unlisten) unlisten();
    }
  });
}
