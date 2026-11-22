/**
 * screens/settings.js — Company identity & logo, storage locations, backups (admins only)
 */
import { api }       from "../api.js";
import { showToast, confirmAction, applyBranding, escHtml } from "../utils.js";
import { open }      from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { can }       from "../permissions.js";
import { listen }    from "@tauri-apps/api/event";

let activeSettingsTab = null;

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
    <div style="width:min(440px,100%);background:#1f1f1f;border:1px solid #2d2d2d;border-radius:10px;padding:18px;box-shadow:0 18px 60px rgba(0,0,0,.45)">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px">
        <p style="font-size:15px;font-weight:700;color:#f3f4f6;margin:0">${title}</p>
        <span id="backup-progress-percent" class="badge badge-gray">0%</span>
      </div>
      <div style="height:10px;background:#111827;border-radius:999px;overflow:hidden;border:1px solid #374151">
        <div id="backup-progress-bar" style="height:100%;width:0%;background:#24a9ff;transition:width .2s ease"></div>
      </div>
      <p id="backup-progress-message" style="font-size:12px;color:#9ca3af;margin:12px 0 0">${message}</p>
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
      <div style="width:min(440px,100%);background:#1f1f1f;border:1px solid #2d2d2d;
        border-radius:10px;padding:18px;box-shadow:0 18px 60px rgba(0,0,0,.45)">
        <p style="font-size:16px;font-weight:700;color:#f3f4f6;margin:0 0 8px">${title}</p>
        <p style="font-size:13px;line-height:1.8;color:#9ca3af;margin:0 0 14px">${message}</p>
        <div style="display:flex;gap:8px;margin-bottom:8px">
          <input id="backup-password-input" class="input-field" type="password"
            autocomplete="current-password" style="flex:1" />
          <button type="button" id="backup-password-toggle" class="btn-secondary"
            aria-pressed="false" style="min-width:74px">إظهار</button>
        </div>
        <p id="backup-password-error" class="hidden" style="font-size:12px;color:#ef4444;margin:0 0 12px"></p>
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

export async function renderSettings(container, user, ctx) {
  const canSettings = can(user, "settings.manage");
  const canBackups = can(user, "backups.manage");
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

  const tabs = [
    canSettings && { id: "company", label: "الجهة والشعار" },
    canSettings && { id: "storage", label: "مواقع الحفظ" },
    canBackups && { id: "backup", label: "النسخ الاحتياطي" },
  ].filter(Boolean);
  if (!tabs.length) {
    container.innerHTML = `<div class="card text-gray-400">لا توجد إعدادات متاحة لهذا المستخدم.</div>`;
    return;
  }
  if (!tabs.some(tab => tab.id === activeSettingsTab)) activeSettingsTab = tabs[0].id;

  const logoMarkup = () => companyConfig?.logo_full_path
    ? `<img src="${escHtml(convertFileSrc(companyConfig.logo_full_path))}" id="logo-preview" alt="شعار الجهة" class="settings-logo" />`
    : `<div class="settings-logo settings-logo-fallback">CNS</div>`;

  container.innerHTML = `
    <div class="settings-screen space-y-4">
      <div class="settings-tabs" role="tablist">
        ${tabs.map(tab => `<button type="button" role="tab" class="settings-tab" data-settings-tab="${tab.id}"
          aria-selected="${tab.id === activeSettingsTab}">${tab.label}</button>`).join("")}
      </div>

      ${canSettings ? `<section class="card settings-panel" data-settings-panel="company">
        <div class="settings-company">
          <div class="settings-logo-col">
            <div id="company-logo-box">${logoMarkup()}</div>
            <button id="btn-upload-logo" type="button" class="btn-secondary text-sm px-3 py-1.5">تغيير الشعار…</button>
            <p class="text-xs text-gray-500">PNG أو JPG، حتى 5 MB</p>
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
            <button id="btn-save-cfg" type="button" class="btn-primary px-6">حفظ</button>
          </div>
        </div>
      </section>

      <section class="card settings-panel space-y-1" data-settings-panel="storage">
        <p class="text-xs text-gray-500">يمكن نقل مجلد البيانات أو تغيير مجلد النسخ الاحتياطية بأمان: يُنسخ كل شيء ويُتحقق منه أولًا، ويبقى الموقع القديم كما هو دون حذف.</p>
        ${(storageStatus?.warnings || []).map(w => `<p class="settings-storage-warning text-xs" style="color:#fbbf24;background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.3);border-radius:8px;padding:8px 10px;margin:6px 0">${escHtml(w)}</p>`).join("")}
        <div class="settings-path-row">
          <div class="min-w-0">
            <p class="settings-path-label">مجلد البيانات والمرفقات</p>
            <p id="storage-path-text" class="settings-path-value" dir="ltr">${escHtml(storageStatus?.data_root || "—")}</p>
          </div>
          <div class="flex gap-2">
            <button id="btn-open-storage" type="button" class="btn-secondary whitespace-nowrap">فتح المجلد</button>
            ${canBackups ? `<button id="btn-move-storage" type="button" class="btn-secondary whitespace-nowrap">نقل مجلد البيانات…</button>` : ""}
          </div>
        </div>
        <div class="settings-path-row">
          <div class="min-w-0">
            <p class="settings-path-label">مجلد النسخ الاحتياطية</p>
            <p id="backup-path-text" class="settings-path-value" dir="ltr">${escHtml(storageStatus?.backup_root || "—")}</p>
          </div>
          <div class="flex gap-2">
            <button id="btn-open-backup" type="button" class="btn-secondary whitespace-nowrap">فتح المجلد</button>
            <button id="btn-change-backup" type="button" class="btn-secondary whitespace-nowrap">تغيير المجلد…</button>
          </div>
        </div>
      </section>` : ""}

      ${canBackups ? `<section class="settings-panel" data-settings-panel="backup">
      <div class="card space-y-3">
        <p class="section-title">عمليات النسخ الاحتياطي</p>
        <p class="text-xs text-gray-400">تشمل النسخة الاحتياطية قاعدة البيانات وجميع المرفقات والوثائق المرفوعة.</p>
        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 border border-autohr-border rounded-lg p-3 bg-autohr-bg/40">
          <label class="flex items-center gap-2 text-sm">
            <input id="auto-backup-daily" type="checkbox" ${autoBackup?.daily_enabled ? "checked" : ""} />
            <span>تفعيل النسخ اليومي التلقائي</span>
          </label>
          <label class="flex items-center gap-2 text-sm">
            <input id="auto-backup-weekly" type="checkbox" ${autoBackup?.weekly_enabled ? "checked" : ""} />
            <span>تفعيل النسخ الأسبوعي التلقائي</span>
          </label>
          <label class="flex items-center gap-2 text-sm">
            <input id="auto-backup-monthly" type="checkbox" ${autoBackup?.monthly_enabled ? "checked" : ""} />
            <span>تفعيل النسخ الشهري التلقائي</span>
          </label>
          <div class="sm:col-span-3">
            <label class="section-title">كلمة مرور النسخ التلقائية</label>
            <div class="flex gap-2">
              <input id="auto-backup-password" class="input-field flex-1" type="password"
                placeholder="${autoBackup?.has_password ? "اتركها فارغة للإبقاء على كلمة المرور الحالية" : "أدخل كلمة مرور 8 أحرف على الأقل"}"
                autocomplete="new-password" />
              <button type="button" id="auto-backup-password-toggle" class="btn-secondary whitespace-nowrap"
                aria-pressed="false">إظهار</button>
            </div>
          </div>
          <p class="text-xs text-gray-500 sm:col-span-3">
            آخر نسخة يومية: ${autoBackup?.last_daily || "—"} · آخر نسخة أسبوعية: ${autoBackup?.last_weekly || "—"} · آخر نسخة شهرية: ${autoBackup?.last_monthly || "—"}
          </p>
          <div class="sm:col-span-3">
            <button id="btn-save-auto-backup" class="btn-secondary">حفظ إعدادات النسخ التلقائي</button>
          </div>
        </div>
        <div class="flex gap-3">
          <button id="btn-create-backup" class="btn-primary">إنشاء نسخة احتياطية الآن</button>
          <button id="btn-export-backup" class="btn-secondary">تصدير نسخة إلى…</button>
          <button id="btn-restore-backup" class="btn-danger">استعادة نسخة احتياطية…</button>
        </div>
      </div>
      </section>` : ""}
    </div>`;

  const showTab = id => {
    activeSettingsTab = id;
    container.querySelectorAll("[data-settings-tab]").forEach(tab => tab.setAttribute("aria-selected", String(tab.dataset.settingsTab === id)));
    container.querySelectorAll("[data-settings-panel]").forEach(panel => panel.classList.toggle("hidden", panel.dataset.settingsPanel !== id));
  };
  container.querySelectorAll("[data-settings-tab]").forEach(tab => tab.addEventListener("click", () => showTab(tab.dataset.settingsTab)));
  showTab(activeSettingsTab);

  bindPasswordToggle(container, "#auto-backup-password", "#auto-backup-password-toggle");

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
      showToast("تم حفظ بيانات الجهة");
    } catch (err) { showToast(err?.message ?? "خطأ", "error"); }
  });

  container.querySelector("#btn-upload-logo")?.addEventListener("click", async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }],
      });
      if (!selected) return;
      if (!(await confirmAction("تأكيد رفع شعار جديد؟"))) return;
      companyConfig = await api.uploadCompanyLogo(selected);
      applyBranding(companyConfig);
      const box = container.querySelector("#company-logo-box");
      if (box) box.innerHTML = logoMarkup();
      showToast("تم رفع الشعار بنجاح");
    } catch (err) {
      showToast(err?.message ?? "فشل رفع الشعار", "error");
    }
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
  bindOpenFolder("#btn-open-backup", "backups");

  const pickFolder = title => open({ directory: true, multiple: false, title });

  container.querySelector("#btn-change-backup")?.addEventListener("click", async () => {
    const selected = await pickFolder("اختر مجلد النسخ الاحتياطية الجديد");
    if (!selected) return;
    if (!(await confirmAction(`سيتم حفظ النسخ الاحتياطية الجديدة في: ${selected} — النسخ القديمة تبقى في مكانها. هل تريد المتابعة؟`))) return;
    try {
      await api.changeBackupFolder(selected);
      showToast("تم تغيير مجلد النسخ الاحتياطية");
      renderSettings(container, user, ctx);
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
      progress.update({ percent: 100, message: "تم التصدير والتحقق" });
      showToast(`تم تصدير النسخة والتحقق منها: ${path}`);
    } catch (err) {
      showToast(err?.message ?? String(err), "error");
    } finally {
      if (unlisten) unlisten();
      setTimeout(() => progress.close(), 700);
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
      progress.update({ percent: 100, message: "اكتمل إنشاء النسخة الاحتياطية" });
      showToast(`تم إنشاء النسخة: ${backup}`);
    } catch (err) {
      showToast(err?.message ?? "خطأ", "error");
    } finally {
      if (unlisten) unlisten();
      setTimeout(() => progress.close(), 700);
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
      showToast("تم حفظ إعدادات النسخ التلقائي");
    } catch (err) {
      showToast(err?.message ?? "خطأ", "error");
    }
  });
  container.querySelector("#btn-restore-backup")?.addEventListener("click", async () => {
    const selected = await open({ multiple: false, filters: [{ name: "Encrypted AutoHR Backup", extensions: ["autohrbak"] }] });
    if (!selected || !(await confirmAction("ستستبدل الاستعادة قاعدة البيانات الحالية. هل تريد المتابعة؟"))) return;
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
