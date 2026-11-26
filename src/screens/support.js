/**
 * screens/support.js — «الفحص والدعم»: program health check with a diagnostic file,
 * update check (administrators) and «اتصل بنا» (WhatsApp and email). Visible to every user.
 */
import { api }       from "../api.js";
import { showToast, escHtml, confirmAction } from "../utils.js";
import { save }      from "@tauri-apps/plugin-dialog";
import { listen }    from "@tauri-apps/api/event";
import { can }       from "../permissions.js";
import { APP_VERSION } from "../version.js";

const STATUS = {
  ok:   { label: "سليم",   badge: "badge-green" },
  warn: { label: "تنبيه",  badge: "badge-amber" },
  fail: { label: "خلل",    badge: "badge-red" },
  info: { label: "معلومة", badge: "badge-gray" },
};

// Same steps, same order as health::run_with_progress in Rust.
const CHECK_STEPS = [
  "معلومات البرنامج",
  "قاعدة البيانات",
  "مجلدات البيانات والنسخ",
  "صلاحيات المجلدات",
  "الملفات المرفقة",
  "كشف التعديل من خارج البرنامج",
  "النسخ الاحتياطية",
  "العمليات الفاشلة",
  "الأخطاء التقنية",
];
const STEP_MS = 160;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const OVERALL_TEXT = {
  ok:   "البرنامج يعمل بشكل سليم.",
  warn: "البرنامج يعمل، لكن توجد ملاحظات تستحق المراجعة.",
  fail: "توجد مشكلة تحتاج إلى معالجة. احفظ ملف التشخيص وأرسله إلى الدعم.",
};

function statusBadge(status) {
  const s = STATUS[status] ?? STATUS.info;
  return `<span class="badge ${s.badge}">${s.label}</span>`;
}

// Technical error lines are "time | kind | العملية: … | الخطأ: … | السياق: …". The English
// error text is set apart left-to-right so it does not get mixed into the Arabic sentence.
const LTR_FIELDS = ["العملية: ", "الخطأ: ", "السياق: "];
function errorLine(line) {
  const parts = line.split(" | ");
  if (parts.length < 3) return `<li dir="auto">${escHtml(line)}</li>`;
  const [head, ...rest] = parts;
  const fields = rest.map(part => {
    const label = LTR_FIELDS.find(l => part.startsWith(l));
    if (!label) return `<span class="support-error-meta">${escHtml(part)}</span>`;
    return `<span class="support-error-field"><span class="support-error-label">${escHtml(label.trim())}</span> <bdi dir="ltr" class="support-error-code">${escHtml(part.slice(label.length))}</bdi></span>`;
  });
  return `<li class="support-error-line"><span class="support-error-time" dir="ltr">${escHtml(head)}</span>${fields.join("")}</li>`;
}

// «اعتماد البيانات» is offered to the System Admin next to the tamper-detection item.
function itemAction(item, canApprove) {
  if (item.action !== "approve_integrity" || !canApprove) return "";
  return `<div class="support-check-action"><button type="button" class="btn-secondary text-sm" data-action="approve_integrity">اعتماد البيانات الحالية</button></div>`;
}

function renderItems(report, canApprove = false) {
  return report.items.map(item => `
    <div class="support-check-item">
      <div class="support-check-head">
        <span class="font-semibold">${escHtml(item.title)}</span>
        ${statusBadge(item.status)}
      </div>
      <ul class="support-check-details">${item.details.map(line => item.key === "errors" ? errorLine(line) : `<li dir="auto">${escHtml(line)}</li>`).join("")}</ul>
      ${itemAction(item, canApprove)}
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
        <div id="check-progress" class="support-progress hidden" role="progressbar" aria-label="تقدم الفحص" aria-valuemin="0" aria-valuemax="${CHECK_STEPS.length}" aria-valuenow="0">
          <div class="support-progress-head">
            <span id="check-progress-label">جارٍ التحضير…</span>
            <span id="check-progress-count" class="support-progress-count"></span>
          </div>
          <div class="support-progress-track"><div id="check-progress-bar" class="support-progress-bar"></div></div>
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
        : `<p class="text-sm text-gray-400 mt-3">تثبيت التحديثات متاح للمسؤول.</p>`}
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

  const progress = container.querySelector("#check-progress");
  const progressBar = container.querySelector("#check-progress-bar");
  const progressLabel = container.querySelector("#check-progress-label");
  const progressCount = container.querySelector("#check-progress-count");
  const total = CHECK_STEPS.length;
  // The bar moves one step at a time towards the step Rust last reported, so even a very
  // quick check visibly passes through every step.
  let shown = 0;
  let target = 0;
  const paint = () => {
    const done = shown >= total;
    progressBar.style.width = `${Math.round((shown / total) * 100)}%`;
    progressLabel.textContent = done ? "اكتمل الفحص" : `جارٍ فحص: ${CHECK_STEPS[shown]}`;
    progressCount.textContent = `${Math.min(shown + (done ? 0 : 1), total)} من ${total}`;
    progress.setAttribute("aria-valuenow", String(shown));
  };
  const advanceTo = async step => {
    target = Math.max(target, Math.min(step, total));
    while (shown < target) {
      await wait(STEP_MS);
      if (shown < target) { shown += 1; paint(); }
    }
  };

  runButton.addEventListener("click", async () => {
    runButton.disabled = true;
    runButton.textContent = "جارٍ الفحص…";
    results.innerHTML = "";
    summary.classList.add("hidden");
    container.querySelector("#check-summary-row").classList.add("hidden");
    actions.classList.add("hidden");
    shown = 0; target = 0;
    paint();
    progress.classList.remove("hidden");
    let unlisten = null;
    try {
      unlisten = await listen("health-check-progress", event => { advanceTo(Number(event.payload?.step) || 0); });
    } catch { /* no event bridge (tests): the bar still runs through the steps at the end */ }
    try {
      const report = await api.runHealthCheck();
      await advanceTo(total);
      await wait(250);
      summary.className = `support-summary support-summary-${report.overall}`;
      summary.innerHTML = `${statusBadge(report.overall)} <span>${escHtml(OVERALL_TEXT[report.overall] ?? "")}</span>`;
      results.innerHTML = renderItems(report, can(user, "users.assign_system_admin"));
      setResultsOpen(true);
      container.querySelector("#check-summary-row").classList.remove("hidden");
      toggle.classList.remove("hidden");
      actions.classList.remove("hidden");
    } catch (err) {
      showToast(err?.message ?? String(err), "error");
    } finally {
      unlisten?.();
      progress.classList.add("hidden");
      runButton.disabled = false;
      runButton.textContent = "إعادة الفحص";
    }
  });

  results.addEventListener("click", async event => {
    if (!event.target.closest('[data-action="approve_integrity"]')) return;
    const ok = await confirmAction("سيُعتمد وضع البيانات الحالي كما هو، وتُعدّ أي تعديلات سابقة من خارج البرنامج مقبولة. يُسجَّل هذا الاعتماد باسمك في سجل النظام. هل تريد المتابعة؟");
    if (!ok) return;
    try {
      await api.approveIntegrity();
      showToast("تم اعتماد البيانات. أعد الفحص للتأكد.");
      runButton.click();
    } catch (err) {
      showToast(err?.message ?? String(err), "error");
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
