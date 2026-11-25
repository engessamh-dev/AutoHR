import { test, expect } from "@playwright/test";

// «الإعدادات ← تنبيهات المستمسكات»: reminder days per document type, and the alerts that follow them.
// Synthetic data only: the harness mocks the backend; the alert commands are mocked here.
test.beforeEach(async ({ page }) => {
  await page.goto("/tests/scanner-harness.html");
  await page.waitForFunction(() => window.ready);
  await page.evaluate(() => {
    window.alertRules = [
      { key: "national", enabled: true, days: [30, 7] },
      { key: "passport", enabled: true, days: [180, 90, 30] },
      { key: "airport", enabled: true, days: [30, 7] },
      { key: "ministry", enabled: true, days: [30, 7] },
      { key: "vehicle", enabled: true, days: [30, 7] },
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

test("settings tab adds, removes and saves reminder days", async ({ page }) => {
  await page.evaluate(() => window.renderActual("settings"));
  await page.locator('[data-settings-tab="alerts"]').click();
  const national = page.locator('.alert-rule[data-rule="national"]');
  await expect(national.locator(".alert-day-chip")).toHaveCount(2);
  const save = page.locator("#btn-save-alert-rules");
  await expect(save).toBeDisabled();

  await national.locator(".alert-day-input").fill("60");
  await national.locator(".alert-day-add-btn").click();
  await expect(national.locator(".alert-day-chip")).toHaveCount(3);
  await expect(national.locator(".alert-day-chip").first()).toContainText("60");
  await national.locator('.alert-day-remove[data-day="7"]').click();
  await expect(national.locator(".alert-day-chip")).toHaveCount(2);

  // Out-of-range input is refused with a message.
  await national.locator(".alert-day-input").fill("999");
  await national.locator(".alert-day-add-btn").click();
  await expect(page.locator(".alert-settings-error")).toBeVisible();

  await page.locator('.alert-rule[data-rule="vehicle"] .alert-rule-enabled').uncheck();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(save).toBeDisabled();
  const saved = await page.evaluate(() => window.savedRules);
  expect(saved.find(r => r.key === "national").days).toEqual([60, 30]);
  expect(saved.find(r => r.key === "vehicle").enabled).toBe(false);

  // Back to the defaults.
  await page.locator("#btn-reset-alert-rules").click();
  await expect(page.locator('.alert-rule[data-rule="vehicle"] .alert-rule-enabled')).toBeChecked();
  await expect(national.locator(".alert-day-chip")).toHaveCount(2);
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
