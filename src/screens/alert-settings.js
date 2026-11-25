/**
 * «تنبيهات المستمسكات» tab of «الإعدادات». One sentence per document: «نبّهني قبل [N] يوماً
 * من النفاذ». The reminders after that are automatic (halfway, then 7 days before, then the
 * expiry day) and drawn on a small timeline; «تخصيص التذكيرات» opens the manual list.
 */
import { api } from "../api.js";
import { escHtml, showToast, arCount } from "../utils.js";
import {
  ALERT_DOCUMENT_TYPES, DEFAULT_ALERT_RULES, autoReminderDays, isAutoReminders,
  loadAlertRules, setCachedAlertRules,
} from "./document-alerts.js";

const MAX_DAYS = 730;
const MAX_REMINDERS = 6;

const clone = rules => rules.map(rule => ({ ...rule, days: [...rule.days] }));
const sameRules = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const firstDay = rule => (rule.days.length ? Math.max(...rule.days) : 30);

function before(days) {
  return days === 1 ? "قبل يوم" : days === 2 ? "قبل يومين" : `قبل ${arCount(days, "day")}`;
}

/**
 * Start on the right, expiry on the left (time runs right to left in RTL). The points are
 * evenly spaced, not to scale, so «قبل 7 أيام» never sits on top of «يوم النفاذ».
 */
function timelineHtml(rule) {
  const points = [...rule.days].sort((a, b) => b - a);
  const at = index => `${(index / points.length) * 100}%`;
  return `
    <div class="alert-timeline" aria-hidden="true">
      <div class="alert-timeline-track"></div>
      ${points.map((day, index) => `<span class="alert-timeline-point${index === 0 ? " is-first" : ""}" style="inset-inline-start:${at(index)}">
        <span class="alert-timeline-dot"></span><span class="alert-timeline-label">${index === 0 ? "أول تنبيه" : before(day)}</span>
      </span>`).join("")}
      <span class="alert-timeline-point is-expiry" style="inset-inline-start:100%">
        <span class="alert-timeline-dot"></span><span class="alert-timeline-label">يوم النفاذ</span>
      </span>
    </div>`;
}

function reminderSentence(rule) {
  const later = [...rule.days].sort((a, b) => b - a).slice(1);
  if (!later.length) return "ثم تنبيه يوم النفاذ.";
  return `ثم تذكير ${later.map(before).join(" و")}، وتنبيه يوم النفاذ.`;
}

function customHtml(rule) {
  const full = rule.days.length >= MAX_REMINDERS;
  return `
    <div class="alert-custom">
      ${rule.days.map(day => `<span class="alert-day-chip">${before(day)}
        <button type="button" class="alert-day-remove" data-day="${day}" title="حذف هذا التذكير" aria-label="حذف تذكير ${before(day)}"
          ${rule.days.length === 1 ? "disabled" : ""}>×</button></span>`).join("")}
      <span class="alert-day-add">
        <input type="number" class="input-field alert-day-input" min="1" max="${MAX_DAYS}" inputmode="numeric"
          placeholder="عدد الأيام" aria-label="تذكير إضافي: عدد الأيام قبل النفاذ" ${full ? "disabled" : ""} />
        <button type="button" class="btn-secondary alert-day-add-btn" ${full ? "disabled" : ""}>+ تذكير</button>
      </span>
    </div>`;
}

function ruleRowHtml(rule, open) {
  const type = ALERT_DOCUMENT_TYPES.find(item => item.key === rule.key);
  const auto = isAutoReminders(rule.days);
  return `
    <div class="alert-rule${rule.enabled ? "" : " is-off"}" data-rule="${escHtml(rule.key)}">
      <div class="alert-rule-line">
        <label class="alert-rule-head">
          <input type="checkbox" class="alert-rule-enabled" aria-label="تنبيه ${escHtml(type?.type ?? rule.key)}" ${rule.enabled ? "checked" : ""} />
          <span class="alert-rule-name">${escHtml(type?.type ?? rule.key)}</span>
        </label>
        ${rule.enabled ? `<span class="alert-rule-sentence">نبّهني قبل
          <input type="number" class="input-field alert-first-days" min="1" max="${MAX_DAYS}" inputmode="numeric"
            value="${firstDay(rule)}" aria-label="عدد الأيام قبل النفاذ" />
          يوماً من النفاذ</span>` : `<span class="alert-rule-off">لا تنبيه لهذا المستمسك</span>`}
      </div>
      ${rule.enabled ? `
        ${timelineHtml(rule)}
        <div class="alert-rule-foot">
          <span>${reminderSentence(rule)}</span>
          <button type="button" class="alert-link alert-customize" aria-expanded="${open}">${open ? "إخفاء التخصيص" : "تخصيص التذكيرات"}</button>
          ${auto ? "" : `<button type="button" class="alert-link alert-auto">رجوع للتلقائي</button>`}
        </div>
        ${open ? customHtml(rule) : ""}` : ""}
    </div>`;
}

export async function renderAlertSettings(panel) {
  let saved = clone(await loadAlertRules());
  let draft = clone(saved);
  const openCustom = new Set();
  let error = "";

  const render = (focusKey = null) => {
    panel.innerHTML = `
      <section class="card settings-block alert-settings">
        <div class="settings-block-head">
          <p class="settings-block-title">مواعيد تنبيه المستمسكات</p>
          <p class="settings-block-help">حدّد لكل مستمسك قبل كم يوماً من نفاذه تريد أن يظهر في «تنبيهات المستمسكات». التذكيرات بعده تلقائية، ويمكن تخصيصها.</p>
        </div>
        <div class="alert-rules">${draft.map(rule => ruleRowHtml(rule, openCustom.has(rule.key))).join("")}</div>
        <p class="alert-settings-error${error ? "" : " hidden"}" role="alert">${escHtml(error)}</p>
        <div class="settings-block-foot">
          <button id="btn-save-alert-rules" type="button" class="btn-primary" ${sameRules(draft, saved) ? "disabled" : ""}>حفظ مواعيد التنبيه</button>
          <button id="btn-reset-alert-rules" type="button" class="btn-secondary" ${sameRules(draft, DEFAULT_ALERT_RULES) ? "disabled" : ""}>استعادة الافتراضي</button>
        </div>
      </section>`;
    bind();
    if (focusKey) panel.querySelector(`[data-rule="${focusKey}"] .alert-day-input`)?.focus();
  };

  const validDay = raw => {
    const day = Number(String(raw).trim());
    return Number.isInteger(day) && day >= 1 && day <= MAX_DAYS ? day : null;
  };

  const bind = () => {
    panel.querySelectorAll(".alert-rule").forEach(row => {
      const rule = draft.find(item => item.key === row.dataset.rule);
      row.querySelector(".alert-rule-enabled").addEventListener("change", event => {
        rule.enabled = event.target.checked;
        if (rule.enabled && !rule.days.length) rule.days = autoReminderDays(30);
        error = "";
        render();
      });

      // The main number: automatic reminders follow it; custom ones smaller than it are kept.
      const first = row.querySelector(".alert-first-days");
      first?.addEventListener("change", () => {
        const day = validDay(first.value);
        if (day === null) { error = `اكتب عدد أيام بين 1 و ${MAX_DAYS}.`; render(); return; }
        error = "";
        rule.days = isAutoReminders(rule.days)
          ? autoReminderDays(day)
          : [day, ...rule.days.filter(d => d < day)].slice(0, MAX_REMINDERS);
        render();
      });
      first?.addEventListener("keydown", event => { if (event.key === "Enter") first.dispatchEvent(new Event("change")); });

      row.querySelector(".alert-customize")?.addEventListener("click", () => {
        openCustom.has(rule.key) ? openCustom.delete(rule.key) : openCustom.add(rule.key);
        render();
      });
      row.querySelector(".alert-auto")?.addEventListener("click", () => {
        rule.days = autoReminderDays(firstDay(rule));
        render();
      });
      row.querySelectorAll(".alert-day-remove").forEach(button => button.addEventListener("click", () => {
        rule.days = rule.days.filter(day => day !== Number(button.dataset.day));
        render();
      }));
      const input = row.querySelector(".alert-day-input");
      const add = () => {
        const day = validDay(input.value);
        if (day === null) error = `اكتب عدد أيام بين 1 و ${MAX_DAYS}.`;
        else if (rule.days.includes(day)) error = "هذا التذكير موجود مسبقاً.";
        else { error = ""; rule.days = [...rule.days, day].sort((a, b) => b - a); }
        render(rule.key);
      };
      row.querySelector(".alert-day-add-btn")?.addEventListener("click", add);
      input?.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); add(); } });
    });

    panel.querySelector("#btn-reset-alert-rules").addEventListener("click", () => {
      draft = clone(DEFAULT_ALERT_RULES);
      openCustom.clear();
      error = "";
      render();
    });

    panel.querySelector("#btn-save-alert-rules").addEventListener("click", async event => {
      event.currentTarget.disabled = true;
      try {
        saved = clone(setCachedAlertRules(await api.setDocumentAlertRules(draft)));
        draft = clone(saved);
        error = "";
        render();
        showToast("تم حفظ مواعيد التنبيه");
      } catch (err) {
        error = err?.message ?? String(err);
        render();
      }
    });
  };

  render();
}
