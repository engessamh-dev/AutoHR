/**
 * screens/settings.js — Company identity & logo, storage locations, backups (admins only)
 */
import { api }       from "../api.js";
import { showToast, confirmAction, confirmSaveChanges, applyBranding, escHtml, errorText, beginBusyTask, friendlyTime } from "../utils.js";
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

const ltr = text => `\u2066${text}\u2069`;

// One choice for automatic backup: off, only on sign-out/close, or also every N minutes of work.
const AUTO_BACKUP_MODES = [
  ["off", "متوقف"],
  ["0", "عند الخروج فقط"],
  ["30", "كل 30 دقيقة"],
  ["60", "كل ساعة"],
  ["120", "كل ساعتين"],
];
function autoBackupMode(settings) {
  if (!settings?.enabled) return "off";
  const interval = String(settings.interval_minutes ?? 60);
  return AUTO_BACKUP_MODES.some(([value]) => value === interval) ? interval : "60";
}

/** «آخر نسخة: اليوم 1:00 م · التالية: 2:00 م · المساحة: 2.4 GB». */
function autoBackupStatusLine(settings) {
  const last = settings?.last_backup ? friendlyTime(settings.last_backup) : "لم تُنشأ بعد";
  let next;
  const mode = autoBackupMode(settings);
  if (mode === "off") next = "متوقف";
  else if (mode === "0") next = "عند الخروج أو الإغلاق";
  else {
    const lastTime = settings?.last_backup ? new Date(settings.last_backup.replace(" ", "T")) : null;
    const due = lastTime && !Number.isNaN(lastTime.getTime()) ? new Date(lastTime.getTime() + Number(mode) * 60000) : null;
    next = due && due > new Date() ? `${friendlyTime(`${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, "0")}-${String(due.getDate()).padStart(2, "0")} ${String(due.getHours()).padStart(2, "0")}:${String(due.getMinutes()).padStart(2, "0")}`).replace(/^اليوم /, "")} إذا تغيّرت البيانات`
      : "عند أول تغيير في البيانات";
  }
  return `آخر نسخة: ${escHtml(last)} · التالية: ${escHtml(next)} · المساحة: ${escHtml(formatBytes(settings?.used_bytes ?? 0))}`;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  // Wrapped in LTR isolates so «1.40 GB» does not turn into «GB 1.40» inside Arabic text.
  if (value >= 1024 ** 3) return ltr(`${(value / 1024 ** 3).toFixed(2)} GB`);
  if (value >= 1024 ** 2) return ltr(`${(value / 1024 ** 2).toFixed(1)} MB`);
  return ltr(`${Math.max(1, Math.round(value / 1024))} KB`);
}

const BACKUP_KINDS = {
  daily:      { label: "يومية", badge: "badge-gray" },
  weekly:     { label: "أسبوعية", badge: "badge-amber" },
  monthly:    { label: "شهرية", badge: "badge-amber" },
  manual:     { label: "يدوية", badge: "badge-green" },
  prerestore: { label: "أمان قبل الاستعادة", badge: "badge-red", note: "حُفظت تلقائيًا قبل استعادة سابقة" },
  premove:    { label: "أمان قبل النقل", badge: "badge-red", note: "حُفظت تلقائيًا قبل نقل مجلد البيانات" },
  preupdate:  { label: "أمان قبل التحديث", badge: "badge-red", note: "حُفظت تلقائيًا قبل تحديث البرنامج" },
  other:      { label: "نسخة", badge: "badge-gray" },
};
const BACKUP_FILTERS = [
  ["all", "الكل", () => true],
  ["daily", "يومية", item => item.kind === "daily"],
  ["periodic", "أسبوعية وشهرية", item => item.kind === "weekly" || item.kind === "monthly"],
  ["manual", "يدوية", item => item.kind === "manual"],
  ["safety", "نسخ الأمان", item => item.kind.startsWith("pre")],
];

/** «اليوم» / «أمس» / «هذا الأسبوع» / «أقدم», from a local «YYYY-MM-DD HH:MM». */
function backupGroup(time) {
  const day = new Date(`${time.slice(0, 10)}T00:00:00`);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((today - day) / 86400000);
  if (days <= 0) return "اليوم";
  if (days === 1) return "أمس";
  if (days < 7) return "هذا الأسبوع";
  return "أقدم";
}

/**
 * The restore list: backups in the backup folder, newest first and selected. Resolves with the
 * chosen file's path, the path picked with «من ملف آخر…», or null.
 */
function chooseBackupToRestore(backupRoot) {
  return new Promise(async resolve => {
    const overlay = document.createElement("div");
    overlay.setAttribute("dir", "rtl");
    overlay.style.cssText = "position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:20px";
    overlay.innerHTML = `
      <div class="card app-dialog" role="dialog" aria-modal="true" aria-labelledby="restore-pick-title" style="width:min(640px,100%);padding:18px 20px;color:var(--ui-text-strong)">
        <div style="display:flex;justify-content:space-between;align-items:start;gap:12px">
          <div>
            <p id="restore-pick-title" style="font-size:16px;font-weight:700;margin:0">اختر النسخة التي تريد استعادتها</p>
            <p style="font-size:12px;color:var(--ui-text-muted);margin:4px 0 10px">النسخ الموجودة في مجلد النسخ الاحتياطية، الأحدث أولًا. لن يتغير شيء قبل أن تؤكد.</p>
          </div>
          <button type="button" data-act="cancel" class="btn-secondary" style="padding:2px 10px" aria-label="إغلاق">✕</button>
        </div>
        <div data-role="body"><p style="font-size:13px;color:var(--ui-text-muted);padding:30px 0;text-align:center">جاري قراءة مجلد النسخ...</p></div>
        <div style="display:flex;gap:10px;justify-content:space-between;align-items:center;margin-top:14px;border-top:1px solid var(--ui-line);padding-top:14px">
          <div style="display:flex;gap:10px">
            <button type="button" data-act="continue" class="btn-primary" disabled>متابعة…</button>
            <button type="button" data-act="cancel" class="btn-secondary">إلغاء</button>
          </div>
          <button type="button" data-act="other" class="btn-secondary">من ملف آخر…</button>
        </div>
      </div>`;
    const body = overlay.querySelector('[data-role="body"]');
    const continueButton = overlay.querySelector('[data-act="continue"]');
    let items = [];
    let filter = "all";
    let selected = null;
    const finish = value => {
      document.removeEventListener("keydown", onKeyDown);
      overlay.remove();
      resolve(value);
    };
    const onKeyDown = event => {
      if (event.key === "Escape") finish(null);
      if (event.key === "Enter" && selected) finish(selected);
    };
    const draw = () => {
      if (!items.length) {
        body.innerHTML = `<div style="text-align:center;padding:40px 10px;color:var(--ui-text-muted)">
          <p style="font-size:15px;font-weight:700;color:var(--ui-text-strong);margin:0 0 6px">لا توجد نسخ في مجلد النسخ الاحتياطية</p>
          <p style="font-size:13px;margin:0">${backupRoot ? `المجلد: ${escHtml(ltr(backupRoot))}<br>` : ""}إذا كانت النسخة على قرص خارجي أو في مكان آخر، اختر «من ملف آخر…».</p></div>`;
        continueButton.disabled = true;
        return;
      }
      const chips = BACKUP_FILTERS.map(([id, label, test]) => [id, label, items.filter(test).length])
        .filter(([id, , count]) => id === "all" || count > 0)
        .map(([id, label, count]) => `<button type="button" data-filter="${id}" class="${id === filter ? "btn-primary" : "btn-secondary"}"
          style="padding:4px 12px;font-size:12px" aria-pressed="${id === filter}">${label} (${count})</button>`).join("");
      const test = BACKUP_FILTERS.find(([id]) => id === filter)[2];
      let last = "";
      const rows = items.filter(test).map(item => {
        const kind = BACKUP_KINDS[item.kind] ?? BACKUP_KINDS.other;
        const group = backupGroup(item.time);
        const head = group !== last ? `<p style="font-size:11px;font-weight:700;color:var(--ui-text-faint);margin:12px 4px 6px">${group}</p>` : "";
        last = group;
        const on = item.path === selected;
        const counts = item.employees != null
          ? `${item.employees} موظفًا${item.documents != null ? ` · ${item.documents} وثيقة` : ""}`
          : "عدد الموظفين يظهر بعد إدخال كلمة المرور";
        return `${head}<label data-path="${escHtml(item.path)}" title="${escHtml(item.path)}" style="display:grid;grid-template-columns:20px 1fr auto;gap:12px;align-items:center;padding:10px 12px;margin-bottom:6px;border-radius:8px;cursor:pointer;
            border:1px solid ${on ? "var(--ui-accent)" : "var(--ui-line)"};background:${on ? "var(--ui-accent-soft)" : "var(--ui-surface)"}">
          <input type="radio" name="restore-pick" ${on ? "checked" : ""} />
          <div style="min-width:0">
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <span style="font-size:14px;font-weight:700;color:var(--ui-text-strong)">${escHtml(ltr(item.time))}</span>
              <span class="badge ${kind.badge}">${kind.label}</span>
              ${item === items[0] ? `<span class="badge badge-green">الأحدث</span>` : ""}
              ${item.old_format ? `<span class="badge badge-gray">إصدار سابق</span>` : ""}
            </div>
            <div style="font-size:12px;color:var(--ui-text-muted);margin-top:3px">${counts}${kind.note ? ` · ${kind.note}` : ""}</div>
          </div>
          <span style="font-size:12px;color:var(--ui-text-faint)">${escHtml(formatBytes(item.size_bytes))}</span>
        </label>`;
      }).join("");
      const list = body.querySelector('[data-role="list"]');
      const scroll = list?.scrollTop ?? 0;
      body.innerHTML = `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:4px">${chips}</div>
        <div data-role="list" style="max-height:min(400px,55vh);overflow:auto;padding-inline-end:4px">${rows}</div>`;
      body.querySelector('[data-role="list"]').scrollTop = scroll;
      continueButton.disabled = !selected;
    };
    body.addEventListener("click", event => {
      const chip = event.target.closest("[data-filter]");
      if (chip) {
        filter = chip.dataset.filter;
        // Never keep a selection that the filter hides: pick the newest one shown.
        const test = BACKUP_FILTERS.find(([id]) => id === filter)[2];
        if (!items.some(item => item.path === selected && test(item))) selected = items.find(test)?.path ?? null;
        draw();
        return;
      }
      const row = event.target.closest("[data-path]");
      if (row) { selected = row.dataset.path; draw(); }
    });
    body.addEventListener("dblclick", event => {
      const row = event.target.closest("[data-path]");
      if (row) finish(row.dataset.path);
    });
    overlay.querySelectorAll('[data-act="cancel"]').forEach(button => button.addEventListener("click", () => finish(null)));
    continueButton.addEventListener("click", () => selected && finish(selected));
    overlay.querySelector('[data-act="other"]').addEventListener("click", async () => {
      const picked = await open({ multiple: false, filters: [{ name: "نسخة CNSArch مشفرة", extensions: ["cnsarchbak", "autohrbak"] }] });
      if (picked) finish(picked);
    });
    overlay.addEventListener("click", event => { if (event.target === overlay) finish(null); });
    document.addEventListener("keydown", onKeyDown);
    document.body.append(overlay);
    continueButton.focus();
    try {
      items = await api.listBackups();
      selected = items[0]?.path ?? null;
    } catch (err) {
      body.innerHTML = `<p style="font-size:13px;color:var(--ui-danger);padding:20px 0;text-align:center">${escHtml(errorText(err))}</p>`;
      return;
    }
    draw();
    if (selected) continueButton.focus();
  });
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
    done(message, path = "", onDone = null) {
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
      ok.addEventListener("click", () => { overlay.remove(); onDone?.(); });
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
  const endBusy = beginBusyTask("تحديث البرنامج");
  try {
    unlisten = await listen("update-progress", event => progress.update(event.payload));
    await api.installUpdate(password);
  } catch (err) {
    showToast(errorText(err), "error");
    progress.close();
  } finally {
    endBusy();
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
    canSettings && { id: "jobs", label: "الدرجات والمراحل" },
    canSettings && { id: "alerts", label: "تنبيهات المستمسكات" },
    { id: "support", label: "الدعم وحول النظام" },
  ].filter(Boolean);
  if (ctx?.tab) activeSettingsTab = ctx.tab;
  if (activeSettingsTab === "backup") activeSettingsTab = "storage";
  if (activeSettingsTab === "about") activeSettingsTab = "support";
  // «التحديثات» is now a section of «الدعم وحول النظام».
  if (activeSettingsTab === "updates") { activeSettingsTab = "support"; activeSubsection.support = "updates"; }
  if (!tabs.some(tab => tab.id === activeSettingsTab)) activeSettingsTab = tabs[0].id;
  if (ctx?.sub && !ctx?.keepPosition) activeSubsection[activeSettingsTab] = ctx.sub;

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
          <p class="settings-block-help">نسخة واحدة لكل يوم تُحدَّث أثناء العمل كل فترة تختارها (إذا تغيّر شيء)، وعند تسجيل الخروج أو إغلاق البرنامج. المرفقات تُحفظ مرة واحدة في مخزن مشفر تشترك فيه كل النسخ، فتبقى النسخة اليومية صغيرة. النسخ اليدوية لا تُحذف تلقائيًا أبدًا.</p>
        </div>
        ${autoBackup?.has_password && autoBackup?.password_works === false ? `<div class="settings-storage-warning text-xs" role="alert">
          <span>كلمة مرور النسخ التلقائي المحفوظة لا تعمل على هذا الجهاز أو حساب Windows هذا، لذلك لا تُنشأ نسخ تلقائية. أدخل كلمة المرور من جديد واحفظ.</span>
        </div>` : ""}
        ${autoBackup?.same_drive ? `<div class="settings-storage-warning text-xs" role="status">
          <span>النسخ على نفس القرص لا تحميك إذا تعطّل. اختر قرصًا آخر أو فلاشًا من «مواقع الحفظ ← تغيير المجلد…».</span>
        </div>` : ""}
        <p class="settings-status-line">${autoBackupStatusLine(autoBackup)}</p>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label class="settings-path-label" for="auto-backup-mode">النسخ التلقائي</label>
            <select id="auto-backup-mode" class="input-field">
              ${AUTO_BACKUP_MODES.map(([value, label]) =>
                `<option value="${value}" ${autoBackupMode(autoBackup) === value ? "selected" : ""}>${label}</option>`).join("")}
            </select>
          </div>
        </div>
        <div>
          <p class="settings-path-label">الاحتفاظ بالنسخ التلقائية</p>
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <label class="text-xs">آخر أيام (يومية)
              <input id="auto-keep-daily" class="input-field" type="number" min="3" max="365" value="${escHtml(String(autoBackup?.keep_daily ?? 7))}" /></label>
            <label class="text-xs">ثم أسابيع (نسخة لكل أسبوع)
              <input id="auto-keep-weekly" class="input-field" type="number" min="0" max="104" value="${escHtml(String(autoBackup?.keep_weekly ?? 4))}" /></label>
            <label class="text-xs">ثم أشهر (نسخة لكل شهر)
              <input id="auto-keep-monthly" class="input-field" type="number" min="0" max="120" value="${escHtml(String(autoBackup?.keep_monthly ?? 12))}" /></label>
          </div>
          <label class="backup-schedule mt-2">
            <input id="auto-backup-delete" type="checkbox" ${autoBackup?.auto_delete !== false ? "checked" : ""} />
            <span class="backup-schedule-name">حذف النسخ التلقائية الأقدم تلقائيًا</span>
            <span class="backup-schedule-last">يُحذف ما زاد عن العدد أعلاه فقط، وتبقى 3 نسخ يومية على الأقل دائمًا.</span>
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
          <p class="settings-block-help">«إنشاء نسخة الآن» تحفظ نسخة صغيرة في مجلد النسخ تعتمد على مخزن المرفقات فيه. «تصدير نسخة كاملة» تكتب ملفًا واحدًا فيه كل شيء، يصلح لقرص خارجي أو لنقله إلى جهاز آخر.</p>
        </div>
        <div class="flex gap-3 flex-wrap">
          <button id="btn-create-backup" class="btn-primary">إنشاء نسخة الآن</button>
          <button id="btn-export-backup" class="btn-secondary">تصدير نسخة كاملة إلى…</button>
        </div>
      </div>

      ${canRestore ? `<div class="card danger-zone settings-block" data-sub="restore" data-sub-label="الاستعادة" data-sub-danger="1">
        <div class="settings-block-head">
          <p class="danger-zone-title"><span aria-hidden="true">⚠</span> استعادة نسخة احتياطية</p>
          <p class="settings-block-help">تستبدل الاستعادة كل البيانات والمرفقات الحالية بمحتوى النسخة المختارة، وتضيع أي تغييرات بعد تاريخها، وتعود كلمات المرور والمستخدمون إلى ما كانوا عليه في تاريخ النسخة. قبل الاستبدال يُعرض عليك ما في النسخة، وتُحفظ نسخة أمان من بياناتك الحالية.</p>
        </div>
        <div>
          <button id="btn-restore-backup" class="btn-danger-outline">استعادة نسخة احتياطية…</button>
        </div>
      </div>` : ""}` : ""}
      </section>` : ""}




      ${canUsers ? `<div class="settings-panel" data-settings-panel="users"></div>` : ""}
      ${canSettings ? `<section class="card settings-panel settings-block" data-settings-panel="jobs">
        <div class="settings-block-head">
          <p class="settings-block-title">الدرجة الوظيفية والمرحلة</p>
          <p class="settings-block-help">تظهر هاتان القائمتان في بطاقة الموظف للاختيار منهما بدل الكتابة. اضغط «تعديل» للإضافة أو التغيير أو الحذف أو الترتيب. المراحل افتراضيًا من 1 إلى 11، عدّلها إن كان في دائرتك مدى مختلف. قيمة محفوظة سابقًا لموظف تبقى كما هي حتى لو حُذفت من القائمة.</p>
        </div>
        <div id="job-lists-body" class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <p class="text-sm text-gray-400">جاري التحميل...</p>
        </div>
        <div class="settings-block-foot">
          <button id="btn-edit-job-lists" type="button" class="btn-primary" disabled>تعديل</button>
          <button id="btn-save-job-lists" type="button" class="btn-primary hidden" disabled>حفظ</button>
          <button id="btn-cancel-job-lists" type="button" class="btn-secondary hidden">إلغاء</button>
        </div>
      </section>
      <div class="settings-panel" data-settings-panel="alerts"></div>` : ""}
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
  let jobsLoaded = false;
  // «الدرجات والمراحل»: read-only until «تعديل»; then each item can be renamed, moved or
  // deleted, items added, and the whole change saved or dropped.
  const JOB_LIST_LABELS = { grades: "الدرجات الوظيفية", steps: "المراحل" };
  let jobLists = null;
  let jobDraft = null;
  const jobsBody = () => container.querySelector("#job-lists-body");
  const cleanDraft = () => ({
    grades: jobDraft.grades.map(item => item.trim()).filter(Boolean),
    steps: jobDraft.steps.map(item => item.trim()).filter(Boolean),
  });
  const jobsChanged = () => jobDraft && JSON.stringify(cleanDraft()) !== JSON.stringify(jobLists);
  const updateJobButtons = () => {
    const editing = Boolean(jobDraft);
    container.querySelector("#btn-edit-job-lists").classList.toggle("hidden", editing);
    container.querySelector("#btn-edit-job-lists").disabled = !jobLists;
    container.querySelector("#btn-save-job-lists").classList.toggle("hidden", !editing);
    container.querySelector("#btn-cancel-job-lists").classList.toggle("hidden", !editing);
    container.querySelector("#btn-save-job-lists").disabled = !jobsChanged();
  };
  const drawJobLists = (focus = null) => {
    jobsBody().innerHTML = ["grades", "steps"].map(key => {
      const label = JOB_LIST_LABELS[key];
      if (!jobDraft) {
        return `<div>
          <p class="section-title">${label} <span class="badge badge-gray">${jobLists[key].length}</span></p>
          <ol class="job-list-view" style="list-style:none;margin:0;padding:0;border:1px solid var(--ui-line);border-radius:8px;overflow:hidden">
            ${jobLists[key].map((item, index) => `<li style="display:flex;gap:10px;align-items:center;padding:7px 12px;${index ? "border-top:1px solid var(--ui-line);" : ""}color:var(--ui-text-strong);font-size:14px">
              <span style="min-width:20px;font-size:11px;color:var(--ui-text-faint)">${index + 1}</span><span>${escHtml(item)}</span></li>`).join("")}
          </ol></div>`;
      }
      const items = jobDraft[key];
      return `<div data-job-list="${key}">
        <p class="section-title">${label} <span class="badge badge-gray">${items.filter(item => item.trim()).length}</span></p>
        <div style="display:flex;flex-direction:column;gap:6px">
          ${items.map((item, index) => `<div style="display:flex;gap:6px;align-items:center">
            <span style="min-width:20px;font-size:11px;color:var(--ui-text-faint)">${index + 1}</span>
            <input class="input-field flex-1" data-job-item="${index}" value="${escHtml(item)}" maxlength="60" aria-label="${label} ${index + 1}" />
            <button type="button" class="btn-secondary" data-job-act="up" data-index="${index}" ${index === 0 ? "disabled" : ""} title="نقل للأعلى" aria-label="نقل للأعلى" style="padding:4px 9px">↑</button>
            <button type="button" class="btn-secondary" data-job-act="down" data-index="${index}" ${index === items.length - 1 ? "disabled" : ""} title="نقل للأسفل" aria-label="نقل للأسفل" style="padding:4px 9px">↓</button>
            <button type="button" class="btn-danger-outline" data-job-act="delete" data-index="${index}" title="حذف" aria-label="حذف ${escHtml(item)}" style="padding:4px 10px">حذف</button>
          </div>`).join("")}
        </div>
        <button type="button" class="btn-secondary" data-job-act="add" style="margin-top:8px">+ إضافة ${key === "grades" ? "درجة" : "مرحلة"}</button>
      </div>`;
    }).join("");
    if (focus) jobsBody().querySelector(`[data-job-list="${focus.key}"] [data-job-item="${focus.index}"]`)?.focus();
    updateJobButtons();
  };
  const loadJobLists = async () => {
    try {
      jobLists = await api.getJobLists();
      drawJobLists();
    } catch (err) {
      jobsBody().innerHTML = `<p class="text-sm" style="color:var(--ui-danger)">${escHtml(errorText(err))}</p>`;
    }
  };
  container.querySelector("#job-lists-body")?.addEventListener("input", event => {
    const input = event.target.closest("[data-job-item]");
    if (!input || !jobDraft) return;
    jobDraft[input.closest("[data-job-list]").dataset.jobList][Number(input.dataset.jobItem)] = input.value;
    updateJobButtons();
  });
  container.querySelector("#job-lists-body")?.addEventListener("click", event => {
    const button = event.target.closest("[data-job-act]");
    if (!button || !jobDraft) return;
    const key = button.closest("[data-job-list]").dataset.jobList;
    const list = jobDraft[key];
    const index = Number(button.dataset.index);
    if (button.dataset.jobAct === "add") { list.push(""); drawJobLists({ key, index: list.length - 1 }); return; }
    if (button.dataset.jobAct === "delete") { list.splice(index, 1); drawJobLists(); return; }
    const to = button.dataset.jobAct === "up" ? index - 1 : index + 1;
    [list[index], list[to]] = [list[to], list[index]];
    drawJobLists({ key, index: to });
  });
  container.querySelector("#btn-edit-job-lists")?.addEventListener("click", () => {
    jobDraft = { grades: [...jobLists.grades], steps: [...jobLists.steps] };
    drawJobLists();
  });
  container.querySelector("#btn-cancel-job-lists")?.addEventListener("click", async () => {
    if (jobsChanged() && !(await confirmAction("ستُلغى التعديلات على القائمتين. هل تريد المتابعة؟", { title: "إلغاء التعديلات" }))) return;
    jobDraft = null;
    drawJobLists();
  });
  const showTab = id => {
    if (id === "jobs" && !jobsLoaded) {
      jobsLoaded = true;
      loadJobLists();
    }
    if (id === "alerts" && !alertsRendered) {
      alertsRendered = true;
      const panel = container.querySelector('[data-settings-panel="alerts"]');
      renderAlertSettings(panel).catch(err => {
        panel.innerHTML = `<div class="card text-sm text-gray-400" dir="auto">${escHtml(errorText(err))}</div>`;
      });
    }
    activeSettingsTab = id;
    if (id === "users" && !usersRendered) {
      usersRendered = true;
      const panel = container.querySelector('[data-settings-panel="users"]');
      renderUsers(panel, user).catch(err => {
        panel.innerHTML = `<div class="card text-sm text-gray-400" dir="auto">${escHtml(errorText(err))}</div>`;
      });
    }
    if (id === "support" && !supportRendered) {
      supportRendered = true;
      const panel = container.querySelector('[data-settings-panel="support"]');
      Promise.all([["about", renderAbout], ["support", renderSupport]].map(([key, render]) => {
        const host = panel.querySelector(`[data-embedded="${key}"]`);
        return render(host, user, { ...ctx, embedded: true }).catch(err => {
          host.innerHTML = `<div class="card text-sm text-gray-400" dir="auto">${escHtml(errorText(err))}</div>`;
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
    ["#auto-backup-mode", "#auto-keep-daily", "#auto-keep-weekly", "#auto-keep-monthly", "#auto-backup-delete", "#auto-backup-password"]);

  const saveCompany = async () => {
    const data = {
      company_name: container.querySelector("#c-company").value.trim(),
      department_name: container.querySelector("#c-dept").value.trim(),
      division_name: container.querySelector("#c-div").value.trim(),
    };
    if (!data.company_name) { showToast("اسم الشركة مطلوب", "error"); return false; }
    try {
      companyConfig = await api.updateCompanyConfig(data);
      applyBranding(companyConfig);
      resetCompanyDirty();
      showToast("تم حفظ بيانات الجهة");
      return true;
    } catch (err) { showToast(errorText(err), "error"); return false; }
  };
  container.querySelector("#btn-save-cfg")?.addEventListener("click", saveCompany);

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
      showToast(errorText(err), "error");
    }
  });

  container.querySelector("#btn-move-storage")?.addEventListener("click", async () => {
    const selected = await pickFolder("اختر مجلدًا فارغًا لنقل البيانات إليه");
    if (!selected) return;
    if (!(await confirmAction(`سيتم نسخ قاعدة البيانات وجميع المرفقات إلى: ${selected} ثم التحقق منها قبل التحويل. يبقى المجلد الحالي كما هو دون حذف، وهو نسخة غير مشفرة من بياناتك، فاحذفه بنفسك بعد التأكد من أن كل شيء يعمل في الموقع الجديد. سيُطلب تسجيل الدخول من جديد. هل تريد المتابعة؟`))) return;
    const password = await requestBackupPassword({
      title: "نسخة أمان قبل النقل",
      message: "قبل النقل تُنشأ نسخة احتياطية مشفرة للأمان. أدخل كلمة مرور لها (8 أحرف على الأقل) واحتفظ بها.",
      minLength: 8,
    });
    if (!password) return;
    const progress = openBackupProgress({ title: "نقل مجلد البيانات", message: "جاري التحضير..." });
    let unlisten = null;
    const endBusy = beginBusyTask("نقل مجلد البيانات");
    try {
      unlisten = await listen("move-data-progress", event => progress.update(event.payload));
      await api.moveDataFolder(selected, password);
      progress.update({ percent: 100, message: "تم النقل والتحقق. سيتم إعادة تسجيل الدخول." });
      showToast("تم نقل مجلد البيانات بنجاح. بقيت نسخة غير مشفرة في الموقع القديم: احذفها بعد التأكد من أن كل شيء يعمل.");
      setTimeout(() => window.location.reload(), 1500);
    } catch (err) {
      showToast(errorText(err), "error");
      progress.close();
    } finally {
      endBusy();
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
      updateStatus.textContent = `الإصدار الحالي: ${APP_VERSION} — ${errorText(err)}`;
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
      showToast(errorText(err), "error");
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
    const progress = openBackupProgress({ title: "تصدير نسخة كاملة" });
    let unlisten = null;
    const endBusy = beginBusyTask("تصدير نسخة كاملة");
    try {
      unlisten = await listen("backup-progress", event => progress.update(event.payload));
      const path = await api.exportBackupTo(selected, password);
      progress.done("تم تصدير النسخة الكاملة والتحقق منها بنجاح. مكان الملف:", path);
    } catch (err) {
      showToast(errorText(err), "error");
      progress.close();
    } finally {
      endBusy();
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
    const endBusy = beginBusyTask("إنشاء نسخة احتياطية");
    try {
      unlisten = await listen("backup-progress", event => progress.update(event.payload));
      const backup = await api.createBackup(password);
      progress.done("اكتمل إنشاء النسخة الاحتياطية والتحقق منها. مكان الملف:", backup);
    } catch (err) {
      showToast(errorText(err), "error");
      progress.close();
    } finally {
      endBusy();
      if (unlisten) unlisten();
    }
  });
  const saveAutoBackup = async () => {
    const number = id => Number(container.querySelector(id)?.value);
    const data = {
      enabled: container.querySelector("#auto-backup-mode")?.value !== "off",
      password: container.querySelector("#auto-backup-password")?.value || null,
      // «متوقف» keeps the last interval, so turning it back on restores the same choice.
      interval_minutes: container.querySelector("#auto-backup-mode")?.value === "off"
        ? Number(autoBackup?.interval_minutes ?? 60) : number("#auto-backup-mode"),
      keep_daily: number("#auto-keep-daily"),
      keep_weekly: number("#auto-keep-weekly"),
      keep_monthly: number("#auto-keep-monthly"),
      auto_delete: Boolean(container.querySelector("#auto-backup-delete")?.checked),
    };
    if (data.enabled && !autoBackup?.has_password && !data.password) {
      showToast("أدخل كلمة مرور للنسخ التلقائية قبل التفعيل", "error");
      return false;
    }
    if (data.password && data.password.length < 8) {
      showToast("كلمة مرور النسخ التلقائية يجب أن تكون 8 أحرف على الأقل", "error");
      return false;
    }
    if (!Number.isInteger(data.keep_daily) || data.keep_daily < 3) {
      showToast("عدد النسخ اليومية المحتفظ بها يجب أن يكون 3 على الأقل", "error");
      return false;
    }
    try {
      autoBackup = await api.setAutoBackupSettings(data);
      container.querySelector("#auto-backup-password").value = "";
      resetAutoBackupDirty();
      showToast("تم حفظ إعدادات النسخ التلقائي");
      return true;
    } catch (err) {
      showToast(errorText(err), "error");
      return false;
    }
  };
  container.querySelector("#btn-save-auto-backup")?.addEventListener("click", async () => {
    // Redrawn so the password warning and the status line follow the saved settings.
    if (await saveAutoBackup()) renderSettings(container, user, { ...ctx, tab: undefined, keepPosition: true });
  });

  const saveJobLists = async () => {
    const draft = cleanDraft();
    const duplicate = ["grades", "steps"].map(key => draft[key].find((item, index) => draft[key].indexOf(item) !== index)).find(Boolean);
    if (duplicate) { showToast(`«${duplicate}» مكرر في القائمة`, "error"); return false; }
    try {
      jobLists = await api.setJobLists(draft);
      jobDraft = null;
      drawJobLists();
      showToast("تم حفظ قائمتي الدرجات والمراحل");
      return true;
    } catch (err) {
      showToast(errorText(err), "error");
      return false;
    }
  };
  container.querySelector("#btn-save-job-lists")?.addEventListener("click", saveJobLists);

  // Leaving «الإعدادات» (another screen, sign-out, closing) with unsaved changes asks first.
  const saveCompanyButton = container.querySelector("#btn-save-cfg");
  const saveAutoButton = container.querySelector("#btn-save-auto-backup");
  const saveJobsButton = container.querySelector("#btn-save-job-lists");
  window.autohrCanLeaveCurrentScreen = async () => {
    const dirty = [saveCompanyButton, saveAutoButton, saveJobsButton].filter(button => button && !button.disabled);
    if (!dirty.length) return true;
    const choice = await confirmSaveChanges("توجد تغييرات غير محفوظة في الإعدادات. هل تريد حفظها قبل المغادرة؟");
    if (choice === "save") {
      for (const button of dirty) {
        const saved = button === saveAutoButton ? await saveAutoBackup()
          : button === saveJobsButton ? await saveJobLists()
          : await saveCompany();
        if (!saved) return false;
      }
      return true;
    }
    return choice === "discard";
  };

  container.querySelector("#btn-restore-backup")?.addEventListener("click", async () => {
    const selected = await chooseBackupToRestore(storageStatus?.backup_root);
    if (!selected) return;
    const password = await requestBackupPassword({
      title: "استعادة نسخة احتياطية",
      message: "أدخل كلمة مرور النسخة الاحتياطية المحددة. سيُفحص الملف أولًا ويُعرض عليك ما فيه قبل أي تغيير.",
    });
    if (!password) return;
    // 1) Check the file and show what it holds. Nothing changes yet.
    let summary;
    const checking = openBackupProgress({ title: "فحص النسخة الاحتياطية", message: "جاري فك التشفير وفحص الملفات... لم يتغير شيء بعد." });
    checking.update({ percent: 30, message: "جاري فك التشفير وفحص الملفات... لم يتغير شيء بعد." });
    let endBusy = beginBusyTask("فحص نسخة احتياطية");
    try {
      summary = await api.inspectBackup(selected, password);
    } catch (err) {
      showToast(errorText(err), "error");
      return;
    } finally {
      endBusy();
      checking.close();
    }
    const when = summary.last_change || summary.file_time ? ltr(summary.last_change || summary.file_time) : "غير معروف";
    const details = [
      `النوع: ${summary.kind}`,
      `تاريخ البيانات: ${when}`,
      `الموظفون: ${summary.employees} · الوثائق في الأرشيف: ${summary.archive_documents}`,
      `المستخدمون: ${summary.users} · المرفقات: ${summary.attachments} · الحجم: ${formatBytes(summary.size_bytes)}`,
      "",
      "ستُستبدل كل البيانات والمرفقات الحالية بمحتوى هذه النسخة، وتضيع أي تغييرات بعد تاريخها.",
      "تعود كلمات المرور والمستخدمون والصلاحيات إلى ما كانت عليه في تاريخ النسخة، وقد تحتاج كلمة المرور القديمة لتسجيل الدخول.",
      "قبل الاستبدال تُحفظ نسخة أمان من بياناتك الحالية بنفس كلمة المرور.",
    ].join("\n");
    if (!(await confirmAction(details, { title: "استعادة هذه النسخة؟", confirmLabel: "استبدال البيانات بهذه النسخة", danger: true }))) return;
    // 2) Restore.
    const progress = openBackupProgress({ title: "استعادة نسخة احتياطية", message: "جاري بدء الاستعادة..." });
    let unlisten = null;
    endBusy = beginBusyTask("استعادة نسخة احتياطية");
    try {
      unlisten = await listen("restore-progress", event => progress.update(event.payload));
      await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
      const safetyCopy = await api.restoreBackup(selected, password);
      endBusy();
      window.autohrCanLeaveCurrentScreen = null;
      progress.done("اكتملت الاستعادة. حُفظت نسخة أمان من بياناتك السابقة هنا (بنفس كلمة المرور). اضغط «تم» لإعادة تسجيل الدخول:", safetyCopy || "", () => window.location.reload());
    }
    catch (err) {
      showToast(errorText(err), "error");
      progress.close();
    } finally {
      endBusy();
      if (unlisten) unlisten();
    }
  });
}
