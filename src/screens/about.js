import { bindAttachmentScannerButtons } from "../attachments/integration.js";
/**
 * screens/about.js — Version, storage path picker
 */
import { api }       from "../api.js";
import { showToast, confirmAction, applyBranding, escHtml } from "../utils.js";
import { open }      from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
import { can }       from "../permissions.js";
import { listen }    from "@tauri-apps/api/event";
import { formatAppVersion } from "../version.js";

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
        <div id="backup-progress-bar" style="height:100%;width:0%;background:#5da12c;transition:width .2s ease"></div>
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

export async function renderAbout(container, user, ctx) {
  const canSettings = can(user, "settings.manage");
  const canBackups = can(user, "backups.manage");
  let storagePath = "";
  let backupPath = "";
  let companyConfig = null;
  let autoBackup = null;
  if (canSettings) {
    try {
      [storagePath, backupPath, companyConfig] = await Promise.all([
        api.getStoragePath(),
        api.getBackupPath(),
        api.getCompanyConfig(),
      ]);
    } catch {}
  }
  if (canBackups) {
    try {
      autoBackup = await api.getAutoBackupSettings();
    } catch {}
  }

  container.innerHTML = `
    <div class="space-y-6 max-w-xl">
      <div class="card space-y-3">
        <div class="flex items-center gap-4">
          <div class="w-14 h-14 rounded-xl bg-autohr-green/20 flex items-center justify-center shrink-0">
            <span class="text-lg font-bold text-autohr-green">CNS</span>
          </div>
          <div>
            <h2 class="text-xl font-bold">CNSArch</h2>
            <p class="text-sm text-gray-400">الشركة العامة لإدارة المطارات والملاحة الجوية - GCAAN</p>
            <p class="text-xs text-gray-500 mt-1">${formatAppVersion()}</p>
          </div>
        </div>
        <hr class="border-autohr-border" />
        <div class="text-sm text-gray-400 space-y-1">
          <p>👨‍💻 <strong class="text-gray-300">المطوّر:</strong> Eng. Essam Al-Emaraa</p>
          ${canSettings ? `
          <p>🗄️ <strong class="text-gray-300">قاعدة البيانات:</strong> SQLite (WAL mode)</p>
          <p>🖥️ <strong class="text-gray-300">الإطار:</strong> Tauri v2 + Vite + Tailwind CSS</p>
          <p>📁 <strong class="text-gray-300">مسار التخزين:</strong>
            <span dir="ltr" class="text-gray-300">${storagePath || "AppData/Roaming/CNSArch/Data (افتراضي)"}</span>
          </p>
          <p>💾 <strong class="text-gray-300">مسار النسخ الاحتياطية:</strong>
            <span dir="ltr" class="text-gray-300">${backupPath || "Documents/GCANS Backups (افتراضي)"}</span>
          </p>` : ""}
        </div>
      </div>

      ${canSettings ? `<div class="card space-y-4">
        <p class="section-title">معلومات الشركة</p>
        <div>
          <label class="section-title">اسم الشركة / الجهة *</label>
          <input id="c-company" class="input-field" value="${escHtml(companyConfig?.company_name ?? "")}" />
        </div>
        <div>
          <label class="section-title">اسم القسم</label>
          <input id="c-dept" class="input-field" value="${escHtml(companyConfig?.department_name ?? "")}" />
        </div>
        <div>
          <label class="section-title">اسم الشعبة / الوحدة</label>
          <input id="c-div" class="input-field" value="${escHtml(companyConfig?.division_name ?? "")}" />
        </div>
        <button id="btn-save-cfg" class="btn-primary px-6">حفظ</button>
      </div>

      <div class="card space-y-4">
        <p class="section-title">شعار المنشأة</p>
        <div id="company-logo-box">
          ${companyConfig?.logo_full_path
            ? `<img src="" data-scan-path="${escHtml(companyConfig.logo_path)}" id="logo-preview" class="w-20 h-20 rounded object-cover border border-autohr-border" />`
            : `<div class="w-20 h-20 rounded bg-autohr-green/20 flex items-center justify-center border border-autohr-border">
                 <span class="text-xl font-bold text-autohr-green">CNS</span>
               </div>`}
        </div>
        <p class="text-xs text-gray-500">يدعم PNG، JPG، JPEG — بحد أقصى 5 MB</p>
        <button id="btn-upload-logo" class="btn-secondary px-4">رفع شعار جديد…</button>
      </div>

      <div class="card space-y-3">
        <p class="section-title">مسار حفظ البيانات والمرفقات</p>
        <div class="flex gap-3">
          <input id="storage-input" class="input-field flex-1" dir="ltr"
                 value="${storagePath}" placeholder="مسار حفظ البيانات…" readonly />
          <button id="btn-pick-storage" class="btn-secondary whitespace-nowrap">تصفّح…</button>
        </div>
        <button id="btn-save-storage" class="btn-primary px-6">حفظ مسار البيانات</button>
      </div>

      <div class="card space-y-3">
        <p class="section-title">مسار النسخ الاحتياطية</p>
        <div class="flex gap-3">
          <input id="backup-input" class="input-field flex-1" dir="ltr"
                 value="${backupPath}" placeholder="مسار النسخ الاحتياطية…" readonly />
          <button id="btn-pick-backup" class="btn-secondary whitespace-nowrap">تصفّح…</button>
        </div>
        <button id="btn-save-backup" class="btn-primary px-6">حفظ مسار النسخ الاحتياطية</button>
      </div>` : ""}
      ${canBackups ? `<div class="card space-y-3">
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
          <button id="btn-restore-backup" class="btn-danger">استعادة نسخة احتياطية…</button>
        </div>
      </div>` : ""}
    </div>`;

  bindPasswordToggle(container, "#auto-backup-password", "#auto-backup-password-toggle");

  function syncCompanyLogoPreview() {
    const preview = container.querySelector("#logo-preview");
    if (preview && companyConfig?.logo_full_path) {
      preview.src = convertFileSrc(companyConfig.logo_full_path);
    }
  }
  syncCompanyLogoPreview();
  bindAttachmentScannerButtons(container, user, async () => { companyConfig = await api.getCompanyConfig(); applyBranding(companyConfig); syncCompanyLogoPreview(); });

  container.querySelector("#btn-save-cfg")?.addEventListener("click", async () => {
    const data = {
      company_name: container.querySelector("#c-company").value.trim(),
      department_name: container.querySelector("#c-dept").value.trim(),
      division_name: container.querySelector("#c-div").value.trim(),
    };
    if (!data.company_name) { showToast("اسم الشركة مطلوب", "error"); return; }
    if (!(await confirmAction("تأكيد حفظ بيانات الجهة؟"))) return;
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
      if (box) {
        box.innerHTML = `<img src="${convertFileSrc(companyConfig.logo_full_path)}" data-scan-path="${escHtml(companyConfig.logo_path)}" id="logo-preview" class="w-20 h-20 rounded object-cover border border-autohr-border" />`;
      }
      showToast("تم رفع الشعار بنجاح");
    } catch (err) {
      showToast(err?.message ?? "فشل رفع الشعار", "error");
    }
  });

  container.querySelector("#btn-pick-storage")?.addEventListener("click", async () => {
    try {
      const dir = await open({ directory: true, multiple: false });
      if (dir) container.querySelector("#storage-input").value = dir;
    } catch {}
  });

  container.querySelector("#btn-save-storage")?.addEventListener("click", async () => {
    const path = container.querySelector("#storage-input").value.trim();
    if (!path) { showToast("اختر مساراً أولاً", "warn"); return; }
    if (!(await confirmAction("تأكيد تغيير مسار حفظ البيانات والمرفقات؟"))) return;
    try {
      await api.setStoragePath(path);
      showToast("تم حفظ مسار البيانات");
    } catch (err) { showToast(err?.message ?? "خطأ", "error"); }
  });

  container.querySelector("#btn-pick-backup")?.addEventListener("click", async () => {
    try {
      const dir = await open({ directory: true, multiple: false });
      if (dir) container.querySelector("#backup-input").value = dir;
    } catch {}
  });

  container.querySelector("#btn-save-backup")?.addEventListener("click", async () => {
    const path = container.querySelector("#backup-input").value.trim();
    if (!path) { showToast("اختر مساراً أولاً", "warn"); return; }
    if (!(await confirmAction("تأكيد تغيير مسار النسخ الاحتياطية؟"))) return;
    try {
      await api.setBackupPath(path);
      showToast("تم حفظ مسار النسخ الاحتياطية");
    } catch (err) { showToast(err?.message ?? "خطأ", "error"); }
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
    if (!(await confirmAction("تأكيد حفظ إعدادات النسخ التلقائي؟"))) return;
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
