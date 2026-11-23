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
      <section class="card support-card" aria-labelledby="support-check-title">
        <div class="support-card-head">
          <div>
            <h2 id="support-check-title" class="text-lg font-bold">فحص البرنامج</h2>
            <p class="text-sm text-gray-400 mt-1">يفحص قاعدة البيانات والمجلدات والملفات المرفقة والنسخ الاحتياطية دون تغيير أي شيء.</p>
          </div>
          <button type="button" id="btn-run-check" class="btn-primary">بدء الفحص</button>
        </div>
        <div id="check-summary" class="support-summary hidden" role="status"></div>
        <div id="check-results" class="support-check-list"></div>
        <div id="check-actions" class="support-actions hidden">
          <button type="button" id="btn-save-report" class="btn-secondary">حفظ ملف التشخيص</button>
          <p class="text-xs text-gray-400">أرفق هذا الملف عند التواصل معنا. لا يحتوي على أسماء الموظفين أو أرقامهم أو صور مستمسكاتهم أو كلمات المرور.</p>
        </div>
      </section>

      <div class="support-side">
      <section class="card support-card" aria-labelledby="support-contact-title">
        <h2 id="support-contact-title" class="text-lg font-bold">اتصل بنا</h2>
        <p class="text-sm text-gray-400 mt-1">لإرسال اقتراح أو الإبلاغ عن مشكلة. عند الإبلاغ عن مشكلة، احفظ ملف التشخيص أولًا ثم أرفقه في الرسالة.</p>
        ${contact ? `
        <dl class="about-facts">
          <div><dt>واتساب</dt><dd dir="ltr">${escHtml(contact.whatsapp)}</dd></div>
          <div><dt>البريد الإلكتروني</dt><dd dir="ltr">${escHtml(contact.email)}</dd></div>
        </dl>
        <div class="support-contact-row">
          <span class="text-sm text-gray-400">واتساب:</span>
          <button type="button" class="btn-secondary text-sm" data-channel="whatsapp" data-topic="suggestion">إرسال اقتراح</button>
          <button type="button" class="btn-secondary text-sm" data-channel="whatsapp" data-topic="problem">الإبلاغ عن مشكلة</button>
        </div>
        <div class="support-contact-row">
          <span class="text-sm text-gray-400">البريد:</span>
          <button type="button" class="btn-secondary text-sm" data-channel="email" data-topic="suggestion">إرسال اقتراح</button>
          <button type="button" class="btn-secondary text-sm" data-channel="email" data-topic="problem">الإبلاغ عن مشكلة</button>
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
