import { test, expect } from "@playwright/test";

// «الإعدادات ← تنبيهات المستمسكات»: reminder days per document type, and the alerts that follow them.
// Synthetic data only: the harness mocks the backend; the alert commands are mocked here.
test.beforeEach(async ({ page }) => {
  await page.goto("/tests/scanner-harness.html");
  await page.waitForFunction(() => window.ready);
  await page.evaluate(() => {
    window.alertRules = [
      { key: "national", enabled: true, days: [30, 15, 7] },
      { key: "passport", enabled: true, days: [180, 90, 7] },
      { key: "airport", enabled: true, days: [30, 15, 7] },
      { key: "ministry", enabled: true, days: [30, 15, 7] },
      { key: "vehicle", enabled: true, days: [30, 15, 7] },
    ];
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "cmd_get_document_alert_rules") return structuredClone(window.alertRules);
      if (command === "cmd_set_document_alert_rules") {
        window.savedRules = args.rules;
        window.alertRules = args.rules.map(rule => ({ ...rule, days: [...rule.days].sort((a, b) => b - a) }));
        return structuredClone(window.alertRules);
      }
      return original(command, args);
    };
  });
});

const inDays = days => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

test("alerts follow the reminder days, and a switched-off type is left out", async ({ page }) => {
  const result = await page.evaluate(async ({ national, passport, airport }) => {
    const { buildDocumentAlerts } = await import("/src/screens/document-alerts.js");
    const employees = [{ id: 1, is_active: 1, full_name: "A", civil_id_expiry_date: national, passport_expiry_date: passport, airport_badge_expiry: airport }];
    const rules = [
      { key: "national", enabled: true, days: [60, 14] },
      { key: "passport", enabled: true, days: [30] },
      { key: "airport", enabled: false, days: [30] },
    ];
    return buildDocumentAlerts(employees, rules).map(a => ({ key: a.documentKey, reminder: a.reminder, expired: a.expired }));
  }, { national: inDays(45), passport: inDays(100), airport: inDays(3) });
  // National card 45 days out: inside the 60-day reminder. Passport 100 days out: not yet.
  // Airport badge: switched off.
  expect(result).toEqual([{ key: "national", reminder: 60, expired: false }]);
});

test("automatic reminders: first alert, halfway, 7 days before", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { autoReminderDays, isAutoReminders } = await import("/src/screens/document-alerts.js");
    return { d60: autoReminderDays(60), d180: autoReminderDays(180), d10: autoReminderDays(10), d5: autoReminderDays(5),
      auto: isAutoReminders([30, 15, 7]), custom: isAutoReminders([30, 7]) };
  });
  expect(result).toEqual({ d60: [60, 30, 7], d180: [180, 90, 7], d10: [10, 7], d5: [5], auto: true, custom: false });
});

test("settings: one number per document, reminders follow it, custom list on demand", async ({ page }) => {
  await page.evaluate(() => window.renderActual("settings"));
  await page.locator('[data-settings-tab="alerts"]').click();
  const national = page.locator('.alert-rule[data-rule="national"]');
  const save = page.locator("#btn-save-alert-rules");
  await expect(national.locator(".alert-first-days")).toHaveValue("30");
  await expect(national.locator(".alert-custom")).toHaveCount(0);
  await expect(save).toBeDisabled();

  // Changing the one number moves the automatic reminders with it.
  await national.locator(".alert-first-days").fill("60");
  await national.locator(".alert-first-days").press("Enter");
  await expect(national.locator(".alert-timeline-label")).toHaveText(["أول تنبيه", "قبل 30 يوماً", "قبل 7 أيام", "يوم النفاذ"]);
  await expect(national.locator(".alert-auto")).toHaveCount(0);

  // Custom reminders are behind «تخصيص التذكيرات».
  await national.locator(".alert-customize").click();
  await national.locator(".alert-day-input").fill("3");
  await national.locator(".alert-day-add-btn").click();
  await national.locator('.alert-day-remove[data-day="30"]').click();
  await expect(national.locator(".alert-auto")).toBeVisible();
  await national.locator(".alert-day-input").fill("999");
  await national.locator(".alert-day-add-btn").click();
  await expect(page.locator(".alert-settings-error")).toBeVisible();

  await page.locator('.alert-rule[data-rule="vehicle"] .alert-rule-enabled').uncheck();
  await expect(page.locator('.alert-rule[data-rule="vehicle"] .alert-first-days')).toHaveCount(0);
  await save.click();
  await expect(save).toBeDisabled();
  const saved = await page.evaluate(() => window.savedRules);
  expect(saved.find(r => r.key === "national").days).toEqual([60, 7, 3]);
  expect(saved.find(r => r.key === "vehicle").enabled).toBe(false);

  // «رجوع للتلقائي» and «استعادة الافتراضي».
  await national.locator(".alert-auto").click();
  await expect(national.locator(".alert-timeline-label")).toHaveCount(4);
  await page.locator("#btn-reset-alert-rules").click();
  await expect(national.locator(".alert-first-days")).toHaveValue("30");
  await expect(page.locator('.alert-rule[data-rule="vehicle"] .alert-rule-enabled')).toBeChecked();
});

test("employee documents tab shows «ينتهي خلال» from the saved reminder days", async ({ page }) => {
  await page.evaluate(date => {
    window.alertRules[0] = { key: "national", enabled: true, days: [60] };
    window.employeePatch = { civil_id_expiry_date: date };
  }, inDays(45));
  await page.evaluate(() => window.renderActual("employees"));
  await page.locator('.table-row[data-id="1"]').click();
  await page.locator('.tab-btn[data-tab="documents"]').click();
  await expect(page.getByText(/ينتهي خلال 45/).first()).toBeVisible();
});

test("employee list «المستمسكات» column: plain labels, count only above one, names and dates on hover", async ({ page }) => {
  await page.evaluate(({ expired, soon1, soon2 }) => {
    window.employeePatch = { civil_id_expiry_date: expired, passport_expiry_date: soon1, airport_badge_expiry: soon2 };
  }, { expired: inDays(-3), soon1: inDays(20), soon2: inDays(10) });
  await page.evaluate(() => window.renderActual("employees"));
  const cell = page.locator('.table-row[data-id="1"] .emp-doc-cell');
  await expect(cell.locator(".emp-doc-tag.bad")).toHaveText("منتهي");
  await expect(cell.locator(".emp-doc-tag.warn")).toHaveText("2 ينتهي قريبًا");
  const title = await cell.getAttribute("title");
  expect(title.split("\n")).toHaveLength(3);
  expect(title).toMatch(/منتهي في/);
  expect(title).toMatch(/ينتهي في/);
  // Nothing in the column is cut off.
  const clipped = await cell.evaluate(el => el.scrollWidth > el.parentElement.clientWidth);
  expect(clipped).toBe(false);
});
