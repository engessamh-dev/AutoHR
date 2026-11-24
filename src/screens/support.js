/**
 * screens/support.js — «الفحص والدعم»: program health check with a diagnostic file,
 * update check (administrators) and «اتصل بنا» (WhatsApp and email). Visible to every user.
 */
import { api }       from "../api.js";
import { showToast, escHtml } from "../utils.js";
import { save }      from "@tauri-apps/plugin-dialog";
import { can }       from "../permissions.js";
import { APP_VERSION } from "../version.js";

const STATUS = {
  ok:   { label: "سليم",   badge: "badge-green" },
  warn: { label: "تنبيه",  badge: "badge-amber" },
  fail: { label: "خلل",    badge: "badge-red" },
  info: { label: "معلومة", badge: "badge-gray" },
};

const OVERALL_TEXT = {
  ok:   "البرنامج يعمل بشكل سليم.",
  warn: "البرنامج يعمل، لكن توجد ملاحظات تستحق المراجعة.",
  fail: "توجد مشكلة تحتاج إلى معالجة. احفظ ملف التشخيص وأرسله إلى الدعم.",
};

function statusBadge(status) {
  const s = STATUS[status] ?? STATUS.info;
  return `<span class="badge ${s.badge}">${s.label}</span>`;
}

function renderItems(report) {
  return report.items.map(item => `
    <div class="support-check-item">
      <div class="support-check-head">
        <span class="font-semibold">${escHtml(item.title)}</span>
        ${statusBadge(item.status)}
      </div>
      <ul class="support-check-details">${item.details.map(line => `<li dir="auto">${escHtml(line)}</li>`).join("")}</ul>
    </div>`).join("");
}

export async function renderSupport(container, user, ctx) {
  let contact = null;
  try { contact = await api.getSupportContact(); } catch { /* shown as unavailable below */ }
  const canUpdate = can(user, "settings.manage");
  // Inside «الإعدادات» the «التحديثات» tab already does this, so the card is left out there.
  const showUpdateCard = !ctx?.embedded;

  container.innerHTML = `
    <div class="support-grid">
      <section class="card settings-block support-card" aria-labelledby="support-check-title" data-sub="check" data-sub-label="فحص البرنامج">
        <div class="settings-block-head">
          <h2 id="support-check-title" class="settings-block-title">فحص البرنامج</h2>
          <p class="settings-block-help">يفحص قاعدة البيانات والمجلدات والملفات المرفقة والنسخ الاحتياطية دون تغيير أي شيء.</p>
        </div>
        <div class="settings-block-foot">
          <button type="button" id="btn-run-check" class="btn-primary">بدء الفحص</button>
        </div>
        <div class="support-summary-row hidden" id="check-summary-row">
          <div id="check-summary" class="support-summary hidden" role="status"></div>
          <button type="button" id="btn-toggle-results" class="btn-secondary text-sm hidden" aria-expanded="true" aria-controls="check-results">إخفاء التفاصيل</button>
        </div>
        <div id="check-results" class="support-check-list"></div>
        <div id="check-actions" class="support-actions hidden">
          <button type="button" id="btn-save-report" class="btn-secondary">حفظ ملف التشخيص</button>
          <p class="text-xs text-gray-400">أرفق هذا الملف عند التواصل معنا. لا يحتوي على أسماء الموظفين أو أرقامهم أو صور مستمسكاتهم أو كلمات المرور.</p>
        </div>
      </section>

      <div class="support-side">
      <section class="card settings-block support-card" aria-labelledby="support-contact-title" data-sub="contact" data-sub-label="اتصل بنا">
        <div class="settings-block-head">
          <h2 id="support-contact-title" class="settings-block-title">اتصل بنا</h2>
          <p class="settings-block-help">لإرسال اقتراح أو الإبلاغ عن مشكلة. عند الإبلاغ عن مشكلة، احفظ ملف التشخيص أولًا ثم أرفقه في الرسالة.</p>
        </div>
        ${contact ? `
        <div class="support-contact-table">
          <div>
            <span class="support-contact-label">واتساب</span>
            <span class="support-contact-value" dir="ltr">${escHtml(contact.whatsapp)}</span>
            <span class="support-contact-buttons">
              <button type="button" class="btn-secondary text-sm" data-channel="whatsapp" data-topic="suggestion">إرسال اقتراح</button>
              <button type="button" class="btn-secondary text-sm" data-channel="whatsapp" data-topic="problem">الإبلاغ عن مشكلة</button>
            </span>
          </div>
          <div>
            <span class="support-contact-label">البريد الإلكتروني</span>
            <span class="support-contact-value" dir="ltr">${escHtml(contact.email)}</span>
            <span class="support-contact-buttons">
              <button type="button" class="btn-secondary text-sm" data-channel="email" data-topic="suggestion">إرسال اقتراح</button>
              <button type="button" class="btn-secondary text-sm" data-channel="email" data-topic="problem">الإبلاغ عن مشكلة</button>
            </span>
          </div>
        </div>` : `<p class="text-sm text-gray-400 mt-3">تعذر عرض بيانات التواصل.</p>`}
      </section>

      ${showUpdateCard ? `<section class="card support-card" aria-labelledby="support-update-title">
        <h2 id="support-update-title" class="text-lg font-bold">التحقق من التحديثات</h2>
        <p class="text-sm text-gray-400 mt-1">الإصدار الحالي: <span dir="ltr">${escHtml(APP_VERSION)}</span></p>
        ${canUpdate ? `
        <div class="support-contact-row">
          <button type="button" id="btn-support-check-update" class="btn-secondary text-sm">التحقق من التحديثات</button>
          <button type="button" id="btn-support-go-install" class="btn-primary text-sm hidden">التثبيت من الإعدادات</button>
        </div>
        <p id="support-update-status" class="text-sm mt-2 support-card-status" dir="auto"></p>`
        : `<p class="text-sm text-gray-400 mt-3">تثبيت التحديثات متاح لمسؤول النظام.</p>`}
      </section>` : ""}
      </div>
    </div>`;

  const runButton = container.querySelector("#btn-run-check");
  const summary = container.querySelector("#check-summary");
  const results = container.querySelector("#check-results");
  const actions = container.querySelector("#check-actions");
  const toggle = container.querySelector("#btn-toggle-results");
  const setResultsOpen = open => {
    results.classList.toggle("hidden", !open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = open ? "إخفاء التفاصيل" : "عرض التفاصيل";
  };
  toggle.addEventListener("click", () => setResultsOpen(results.classList.contains("hidden")));

  runButton.addEventListener("click", async () => {
    runButton.disabled = true;
    runButton.textContent = "جارٍ الفحص…";
    results.innerHTML = "";
    summary.classList.add("hidden");
    try {
      const report = await api.runHealthCheck();
      summary.className = `support-summary support-summary-${report.overall}`;
      summary.innerHTML = `${statusBadge(report.overall)} <span>${escHtml(OVERALL_TEXT[report.overall] ?? "")}</span>`;
      results.innerHTML = renderItems(report);
      setResultsOpen(true);
      container.querySelector("#check-summary-row").classList.remove("hidden");
      toggle.classList.remove("hidden");
      actions.classList.remove("hidden");
    } catch (err) {
      showToast(err?.message ?? String(err), "error");
    } finally {
      runButton.disabled = false;
      runButton.textContent = "إعادة الفحص";
    }
  });

  container.querySelector("#btn-save-report")?.addEventListener("click", async () => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
    const destination = await save({
      title: "حفظ ملف التشخيص",
      defaultPath: `CNSArch-diagnostic-${stamp}.txt`,
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
    if (!destination) return;
    try {
      const path = await api.saveHealthReport(destination);
      showToast(`تم حفظ ملف التشخيص: ${path}`);
    } catch (err) {
      showToast(err?.message ?? String(err), "error");
    }
  });

  container.querySelectorAll("[data-channel]").forEach(button => {
    button.addEventListener("click", async () => {
      try {
        await api.openSupportLink(button.dataset.channel, button.dataset.topic);
      } catch (err) {
        showToast(err?.message ?? String(err), "error");
      }
    });
  });

  const updateStatus = container.querySelector("#support-update-status");
  const goInstall = container.querySelector("#btn-support-go-install");
  container.querySelector("#btn-support-check-update")?.addEventListener("click", async event => {
    const button = event.currentTarget;
    button.disabled = true;
    goInstall.classList.add("hidden");
    updateStatus.textContent = "جارٍ التحقق…";
    try {
      const info = await api.checkForUpdate();
      if (!info.configured) {
        updateStatus.textContent = "التحديث التلقائي غير مُعد في هذه النسخة.";
      } else if (info.available) {
        updateStatus.textContent = `يوجد إصدار جديد: ${info.version}. يُثبَّت من الإعدادات بعد أخذ نسخة احتياطية.`;
        goInstall.classList.remove("hidden");
      } else {
        updateStatus.textContent = `لديك أحدث إصدار (${info.current_version}).`;
      }
    } catch (err) {
      updateStatus.textContent = err?.message ?? String(err);
    } finally {
      button.disabled = false;
    }
  });
  goInstall?.addEventListener("click", () => ctx?.navigateTo?.("settings", { tab: "updates" }));
}
