/**
 * «تنبيهات المستمسكات» tab of «الإعدادات»: for each document type with an expiry date,
 * the days before expiry on which it is flagged. The largest day is when the document first
 * appears in the alerts; each smaller one is a further reminder (a Windows notification).
 */
import { api } from "../api.js";
import { escHtml, showToast, arCount } from "../utils.js";
import "../styles/alert-settings.css";
import { ALERT_DOCUMENT_TYPES, DEFAULT_ALERT_RULES, loadAlertRules, setCachedAlertRules } from "./document-alerts.js";

const MAX_DAYS = 730;
const MAX_REMINDERS = 6;
// Quick picks offered under each document; typing any other number works too.
const QUICK_DAYS = [180, 90, 60, 30, 14, 7];

const clone = rules => rules.map(rule => ({ ...rule, days: [...rule.days] }));
const sameRules = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function dayLabel(days) {
  return days === 1 ? "قبل يوم واحد" : days === 2 ? "قبل يومين" : `قبل ${arCount(days, "day")}`;
}

function ruleRowHtml(rule) {
  const type = ALERT_DOCUMENT_TYPES.find(item => item.key === rule.key);
  const first = rule.days.length ? Math.max(...rule.days) : null;
  const summary = !rule.enabled
    ? "التنبيه متوقف لهذا المستمسك"
    : first === null
      ? "أضف موعداً واحداً على الأقل"
      : `يظهر في التنبيهات ${dayLabel(first)} من تاريخ النفاذ${rule.days.length > 1 ? ` ثم يُذكَّر به ${["", "مرة أخرى", "مرتين أخريين"][rule.days.length - 1] ?? `${rule.days.length - 1} مرات أخرى`}` : ""}.`;
  const quick = QUICK_DAYS.filter(day => !rule.days.includes(day));
  return `
    <div class="alert-rule${rule.enabled ? "" : " is-off"}" data-rule="${escHtml(rule.key)}">
      <label class="alert-rule-head">
        <input type="checkbox" class="alert-rule-enabled" ${rule.enabled ? "checked" : ""} />
        <span class="alert-rule-name">${escHtml(type?.type ?? rule.key)}</span>
      </label>
      <p class="alert-rule-summary">${summary}</p>
      <div class="alert-rule-days" ${rule.enabled ? "" : "aria-disabled=\"true\""}>
        ${rule.days.map(day => `<span class="alert-day-chip">${dayLabel(day)}
          <button type="button" class="alert-day-remove" data-day="${day}" title="حذف هذا الموعد" aria-label="حذف موعد ${dayLabel(day)}" ${rule.enabled ? "" : "disabled"}>×</button>
        </span>`).join("")}
        <span class="alert-day-add">
          <input type="number" class="input-field alert-day-input" min="1" max="${MAX_DAYS}" step="1" inputmode="numeric"
            placeholder="عدد الأيام" aria-label="عدد الأيام قبل النفاذ" ${rule.enabled && rule.days.length < MAX_REMINDERS ? "" : "disabled"} />
          <button type="button" class="btn-secondary alert-day-add-btn" ${rule.enabled && rule.days.length < MAX_REMINDERS ? "" : "disabled"}>إضافة موعد</button>
        </span>
      </div>
      ${rule.enabled && quick.length && rule.days.length < MAX_REMINDERS ? `<div class="alert-day-quick">
        <span>إضافة سريعة:</span>
        ${quick.map(day => `<button type="button" class="alert-day-quick-btn" data-day="${day}">${arCount(day, "day")}</button>`).join("")}
      </div>` : ""}
    </div>`;
}

export async function renderAlertSettings(panel) {
  let saved = clone(await loadAlertRules());
  let draft = clone(saved);

  const render = () => {
    panel.innerHTML = `
      <section class="card settings-block alert-settings">
        <div class="settings-block-head">
          <p class="settings-block-title">مواعيد تنبيه المستمسكات</p>
          <p class="settings-block-help">لكل مستمسك له تاريخ نفاذ، حدّد قبل كم يوماً يُنبَّه عليه. أكبر عدد هو موعد ظهوره أول مرة في «تنبيهات المستمسكات»، وكل موعد أصغر تذكير إضافي يظهر كإشعار في Windows. يمكن إيقاف التنبيه لأي مستمسك.</p>
        </div>
        <div class="alert-rules">${draft.map(ruleRowHtml).join("")}</div>
        <p class="alert-settings-error hidden" role="alert"></p>
        <div class="settings-block-foot">
          <button id="btn-save-alert-rules" type="button" class="btn-primary" ${sameRules(draft, saved) ? "disabled" : ""}>حفظ مواعيد التنبيه</button>
          <button id="btn-reset-alert-rules" type="button" class="btn-secondary" ${sameRules(draft, DEFAULT_ALERT_RULES) ? "disabled" : ""}>استعادة المواعيد الافتراضية</button>
        </div>
      </section>`;
    bind();
  };

  const showError = message => {
    const box = panel.querySelector(".alert-settings-error");
    box.textContent = message;
    box.classList.toggle("hidden", !message);
  };

  const addDay = (rule, raw) => {
    const day = Number(String(raw).trim());
    if (!Number.isInteger(day) || day < 1 || day > MAX_DAYS) {
      showError(`اكتب عدد أيام صحيحاً بين 1 و ${MAX_DAYS}.`);
      return false;
    }
    if (rule.days.includes(day)) { showError("هذا الموعد موجود مسبقاً."); return false; }
    if (rule.days.length >= MAX_REMINDERS) { showError(`الحد الأقصى ${MAX_REMINDERS} مواعيد لكل مستمسك.`); return false; }
    rule.days = [...rule.days, day].sort((a, b) => b - a);
    return true;
  };

  const bind = () => {
    panel.querySelectorAll(".alert-rule").forEach(row => {
      const rule = draft.find(item => item.key === row.dataset.rule);
      row.querySelector(".alert-rule-enabled").addEventListener("change", event => {
        rule.enabled = event.target.checked;
        render();
      });
      row.querySelectorAll(".alert-day-remove").forEach(button => button.addEventListener("click", () => {
        rule.days = rule.days.filter(day => day !== Number(button.dataset.day));
        render();
      }));
      const input = row.querySelector(".alert-day-input");
      const add = () => { if (addDay(rule, input.value)) render(); else input.focus(); };
      row.querySelector(".alert-day-add-btn").addEventListener("click", add);
      input.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); add(); } });
      row.querySelectorAll(".alert-day-quick-btn").forEach(button => button.addEventListener("click", () => {
        if (addDay(rule, button.dataset.day)) render();
      }));
    });

    panel.querySelector("#btn-reset-alert-rules").addEventListener("click", () => {
      draft = clone(DEFAULT_ALERT_RULES);
      render();
    });

    panel.querySelector("#btn-save-alert-rules").addEventListener("click", async event => {
      const empty = draft.find(rule => rule.enabled && !rule.days.length);
      if (empty) {
        const name = ALERT_DOCUMENT_TYPES.find(item => item.key === empty.key)?.type ?? empty.key;
        showError(`«${name}»: أضف موعداً واحداً على الأقل أو أوقف التنبيه له.`);
        return;
      }
      event.currentTarget.disabled = true;
      try {
        saved = clone(setCachedAlertRules(await api.setDocumentAlertRules(draft)));
        draft = clone(saved);
        render();
        showToast("تم حفظ مواعيد التنبيه");
      } catch (err) {
        event.currentTarget.disabled = false;
        showError(err?.message ?? String(err));
      }
    });
  };

  render();
}
