import { api } from "../api.js";
import { escHtml, formatDate, arCount, AR_NOUNS } from "../utils.js";
import { can } from "../permissions.js";

const DAY_MS = 86400000;

/** The document types that carry an expiry date. Their reminder days live in «الإعدادات». */
export const ALERT_DOCUMENT_TYPES = [
  { key: "national", field: "civil_id_expiry_date", type: "البطاقة الوطنية" },
  { key: "passport", field: "passport_expiry_date", type: "جواز السفر" },
  { key: "airport", field: "airport_badge_expiry", type: "باج دخول مطار بغداد" },
  { key: "ministry", field: "ministry_badge_expiry", type: "هوية وزارة النقل" },
  { key: "vehicle", field: "vehicle_annual_expiry_date", type: "سنوية المركبة", tab: "vehicle" },
];

/** Same defaults as the backend (services.rs DOCUMENT_ALERT_DEFAULTS), used until the saved ones load. */
export const DEFAULT_ALERT_RULES = [
  { key: "national", enabled: true, days: [30, 15, 7] },
  { key: "passport", enabled: true, days: [180, 90, 7] },
  { key: "airport", enabled: true, days: [30, 15, 7] },
  { key: "ministry", enabled: true, days: [30, 15, 7] },
  { key: "vehicle", enabled: true, days: [30, 15, 7] },
];

/**
 * The automatic reminders for «نبّهني قبل N يوماً»: the first alert at N days, again halfway
 * (when N is 14 or more), and 7 days before (when N is more than 7). Expiry is always flagged.
 */
export function autoReminderDays(first) {
  const n = Math.trunc(Number(first));
  const days = new Set([n]);
  if (n >= 14) days.add(Math.round(n / 2));
  if (n > 7) days.add(7);
  return [...days].sort((a, b) => b - a);
}

export function isAutoReminders(days) {
  if (!days?.length) return true;
  const auto = autoReminderDays(Math.max(...days));
  return auto.length === days.length && auto.every((day, index) => day === days[index]);
}

let cachedRules = DEFAULT_ALERT_RULES;

export function currentAlertRules() { return cachedRules; }

export function setCachedAlertRules(rules) {
  if (Array.isArray(rules) && rules.length) cachedRules = rules;
  return cachedRules;
}

/** Reads the saved reminder days; keeps the last known (or default) ones if that fails. */
export async function loadAlertRules() {
  try { setCachedAlertRules(await api.getDocumentAlertRules()); } catch (_) { /* keep the last known rules */ }
  return cachedRules;
}

function ruleFor(key, rules = cachedRules) {
  return rules.find(rule => rule.key === key) ?? DEFAULT_ALERT_RULES.find(rule => rule.key === key);
}

/** How many days before expiry a document type starts showing as «قارب على النفاذ» (-1 when off). */
export function alertWindowDays(key, rules = cachedRules) {
  const rule = ruleFor(key, rules);
  if (!rule?.enabled || !rule.days?.length) return -1;
  return Math.max(...rule.days);
}

function parseDate(dateStr) {
  if (!dateStr) return null;
  const match = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
  const date = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : new Date(dateStr);
  return isNaN(date) ? null : date;
}

function daysLeft(dateStr, today = new Date()) {
  const date = parseDate(dateStr);
  if (!date) return null;
  const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.ceil((date - todayStart) / DAY_MS);
}

// Arabic number agreement: يومين، 3–10 أيام، 11+ يوماً
function arabicDays(count) {
  if (count === 1) return "يوم واحد";
  if (count === 2) return "يومين";
  const tens = count % 100;
  return tens >= 3 && tens <= 10 ? `${count} أيام` : `${count} يوماً`;
}

/**
 * One document's status, the same in the employee file and the add-employee wizard: expired,
 * expiring within the reminder days of the settings, or complete / missing an attachment.
 */
export function documentStatus({ values, expiry, maxDays, attached, expected, today = new Date() }) {
  const days = daysLeft(expiry, today);
  if (days !== null && days < 0) return { tone: "bad", label: "منتهٍ" };
  if (days !== null && days <= maxDays) return { tone: "warn", label: days === 0 ? "ينتهي اليوم" : days === 1 ? "ينتهي غداً" : `ينتهي خلال ${arabicDays(days)}` };
  const hasData = values.some(value => String(value ?? "").trim());
  if (!hasData && attached === 0) return { tone: "none", label: "لا توجد بيانات" };
  if (attached < expected) return { tone: "none", label: "مرفق ناقص" };
  return { tone: "ok", label: "مكتمل" };
}

/** The expiry dates to watch for one document type. Vehicles are kept in the «المركبات» list
 *  (each with its own annual registration); the older single-vehicle field is read too. */
function expiryDates(employee, documentType) {
  if (documentType.key !== "vehicle") return [employee[documentType.field]];
  let vehicles = [];
  try { vehicles = JSON.parse(employee.vehicles ?? "[]"); } catch { /* no list */ }
  const dates = (Array.isArray(vehicles) ? vehicles : []).map(vehicle => vehicle?.expiry_date);
  return [...new Set([employee[documentType.field], ...dates].filter(Boolean))];
}

export function buildDocumentAlerts(employees, rules = cachedRules, today = new Date()) {
  const alerts = [];
  employees.filter(e => e.is_active).forEach(employee => {
    ALERT_DOCUMENT_TYPES.forEach(documentType => expiryDates(employee, documentType).forEach(expiryDate => {
      const rule = ruleFor(documentType.key, rules);
      if (!rule?.enabled || !rule.days?.length) return;
      const days = daysLeft(expiryDate, today);
      if (days === null || days > Math.max(...rule.days)) return;
      // The reminder reached: the smallest reminder day that is still ≥ the days left.
      const reminder = days < 0 ? null : Math.min(...rule.days.filter(day => day >= days));
      alerts.push({
        employeeId: employee.id,
        employeeTab: documentType.tab ?? "documents",
        employeeName: employee.full_name,
        employeeNumber: employee.employee_number,
        documentKey: documentType.key,
        documentName: documentType.type,
        expiryDate,
        days,
        expired: days < 0,
        reminder,
      });
    }));
  });
  return alerts.sort((a, b) => a.days - b.days);
}

/** Identifies the reminder an alert has reached, so each one is announced only once. */
export function alertStageKey(alert) {
  return {
    id: `${alert.employeeId}:${alert.documentKey}:${alert.expiryDate}`,
    stage: alert.expired ? "expired" : `r${alert.reminder}`,
  };
}

function remainingLabel(alert) {
  if (alert.expired) {
    const ago = -alert.days;
    return ago === 1 ? "انتهى أمس" : `منتهٍ منذ ${arCount(ago, { ...AR_NOUNS.day, two: "يومين" })}`;
  }
  if (alert.days === 0) return "ينتهي اليوم";
  if (alert.days === 1) return "ينتهي غداً";
  return `باقٍ ${arCount(alert.days, "day")}`;
}

function alertBadge(alert) {
  const cls = alert.expired ? "badge-red" : alert.days <= 7 ? "badge-amber" : "badge-gray";
  return `<span class="badge ${cls}">${remainingLabel(alert)}</span>`;
}

const ALERT_FILTERS = [
  { id: "all", label: "الكل", match: () => true },
  { id: "expired", label: "منتهية", match: alert => alert.expired },
  { id: "soon", label: "خلال 30 يوماً", match: alert => !alert.expired && alert.days <= 30 },
  { id: "passport", label: "جوازات", match: alert => alert.documentName === "جواز السفر" },
];
let activeAlertFilter = "all";

function alertRows(alerts) {
  return alerts.map(alert => `
    <tr class="table-row alert-row" data-employee-id="${alert.employeeId}" data-employee-tab="${alert.employeeTab}"
      tabindex="0" title="فتح ملف الموظف">
      <td class="table-cell font-medium text-gray-100">${escHtml(alert.employeeName)}</td>
      <td class="table-cell" dir="ltr">${escHtml(alert.employeeNumber || "—")}</td>
      <td class="table-cell">${escHtml(alert.documentName)}</td>
      <td class="table-cell">${formatDate(alert.expiryDate)}</td>
      <td class="table-cell">${alertBadge(alert)}</td>
    </tr>`).join("");
}

export async function renderDocumentAlerts(container, user, ctx) {
  const [employees, rules] = await Promise.all([api.listEmployees(), loadAlertRules()]);
  const alerts = buildDocumentAlerts(employees, rules);
  const canEditTiming = can(user, "settings.manage");

  const render = () => {
    const filter = ALERT_FILTERS.find(item => item.id === activeAlertFilter) ?? ALERT_FILTERS[0];
    const visible = alerts.filter(filter.match);
    container.innerHTML = `
      <div class="space-y-4">
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <button type="button" id="alerts-back" class="btn-secondary text-sm px-3 py-1.5">→ الرجوع إلى الرئيسية</button>
          <p class="text-sm text-gray-400 flex-1 min-w-[240px]">المستمسكات المنتهية أو التي قاربت على النفاذ للموظفين النشطين. اضغط على أي صف لفتح ملف الموظف.</p>
          <div class="filter-chips" role="group" aria-label="تصفية التنبيهات">
            ${ALERT_FILTERS.map(item => `<button type="button" class="filter-chip" data-alert-filter="${item.id}"
              aria-pressed="${item.id === filter.id}">${item.label}<span class="filter-chip-count">${alerts.filter(item.match).length}</span></button>`).join("")}
          </div>
          ${canEditTiming ? `<button type="button" id="alerts-timing" class="btn-secondary text-sm px-3 py-1.5" title="تعديل عدد الأيام قبل النفاذ لكل مستمسك">مواعيد التنبيه</button>` : ""}
        </div>
        <div class="card overflow-auto">
          <table class="w-full">
            <thead><tr>
              <th class="table-header">الموظف</th>
              <th class="table-header">الرقم الوظيفي</th>
              <th class="table-header">اسم المستمسك</th>
              <th class="table-header">تاريخ النفاذ</th>
              <th class="table-header">المتبقي</th>
            </tr></thead>
            <tbody>
              ${visible.length
                ? alertRows(visible)
                : `<tr><td colspan="5" class="table-cell text-center text-gray-500 py-8">${alerts.length ? "لا توجد تنبيهات ضمن هذا التصنيف" : "لا توجد تنبيهات مستمسكات حاليًا"}</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>`;

    container.querySelector("#alerts-back")?.addEventListener("click", () => ctx.navigateTo("dashboard"));
    container.querySelector("#alerts-timing")?.addEventListener("click", () => ctx.navigateTo("settings", { tab: "alerts" }));
    container.querySelectorAll("[data-alert-filter]").forEach(button => button.addEventListener("click", () => {
      activeAlertFilter = button.dataset.alertFilter;
      render();
    }));
    container.querySelectorAll(".alert-row").forEach(row => {
      const open = () => ctx.navigateTo("employees", {
        openEmployeeId: Number(row.dataset.employeeId),
        openEmployeeTab: row.dataset.employeeTab,
      });
      row.addEventListener("click", open);
      row.addEventListener("keydown", event => { if (event.key === "Enter") open(); });
    });
  };
  render();
}
