import { test, expect } from "@playwright/test";

// «الفحص والدعم»: program check, diagnostic file, update check and contact buttons.
// Synthetic data only: the harness mocks every backend command.
const report = {
  generated_at: "2026-01-01 10:00", app_version: "1.0.5", overall: "warn", text: "synthetic",
  items: [
    { key: "app", title: "البرنامج", status: "ok", details: ["الإصدار: 1.0.5 (إصدار نهائي)", "نظام التشغيل: windows x86_64"] },
    { key: "database", title: "قاعدة البيانات", status: "ok", details: ["سلامة قاعدة البيانات: سليمة", "إصدار هيكل القاعدة: 4"] },
    { key: "folders", title: "المجلدات", status: "ok", details: ["مجلد البيانات: متاح وقابل للكتابة", "  D:\\CNSArch\\Data"] },
    { key: "files", title: "الملفات المرفقة", status: "warn", details: ["عدد الملفات المسجلة: 120", "ملفات مفقودة من مجلد البيانات: 2", "  ملفات الموظفين: 2"] },
    { key: "backups", title: "النسخ الاحتياطية", status: "ok", details: ["آخر نسخة احتياطية: 2026-01-01 09:00:00 (قبل 0 يوم) · العدد: 14", "النسخ التلقائي: يومي"] },
    { key: "failures", title: "الأخطاء خلال 30 يومًا", status: "info", details: ["LOGIN: 3"] },
  ],
};

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/scanner-harness.html");
  await page.waitForFunction(() => window.ready);
  await page.evaluate(r => { window.healthReport = r; }, report);
  await page.evaluate(() => window.renderActual("support"));
});

test("program check shows each result and saves the diagnostic file", async ({ page }) => {
  await page.getByRole("button", { name: "بدء الفحص" }).click();
  await expect(page.locator(".support-check-item")).toHaveCount(6);
  await expect(page.locator("#check-summary")).toHaveClass(/support-summary-warn/);
  await expect(page.locator(".support-check-item").nth(3).locator(".badge")).toHaveText("تنبيه");
  // The results fold away after reading, leaving the summary and the save button.
  await page.getByRole("button", { name: "إخفاء التفاصيل" }).click();
  await expect(page.locator(".support-check-item").first()).toBeHidden();
  await expect(page.locator("#check-summary")).toBeVisible();
  await page.getByRole("button", { name: "عرض التفاصيل" }).click();
  await expect(page.locator(".support-check-item").first()).toBeVisible();
  await page.getByRole("button", { name: "حفظ ملف التشخيص" }).click();
  await expect.poll(() => page.evaluate(() => window.calls.find(c => c.command === "cmd_save_health_report")?.args.destinationPath)).toBe("C:\\Synthetic\\diag.txt");
});

test("a progress bar runs while checking and the result banner takes the result's colour", async ({ page }) => {
  await page.evaluate(() => { window.healthDelay = 700; });
  await page.getByRole("button", { name: "بدء الفحص" }).click();
  const progress = page.locator("#check-progress");
  await expect(progress).toBeVisible();
  await expect(page.locator("#check-progress-label")).toContainText("جارٍ فحص");
  await expect(progress).toBeHidden();
  await expect(page.locator("#check-summary")).toHaveClass(/support-summary-warn/);
  const warnBg = await page.locator("#check-summary").evaluate(el => getComputedStyle(el).backgroundImage);
  expect(warnBg).toContain("rgb(251, 146, 60)");
  // A clean result is bright green, a real problem red.
  await page.evaluate(() => { window.healthDelay = 0; window.healthReport = { ...window.healthReport, overall: "ok" }; });
  await page.getByRole("button", { name: "إعادة الفحص" }).click();
  await expect(page.locator("#check-summary")).toHaveClass(/support-summary-ok/);
  expect(await page.locator("#check-summary").evaluate(el => getComputedStyle(el).backgroundImage)).toContain("rgb(34, 197, 94)");
  await page.evaluate(() => { window.healthReport = { ...window.healthReport, overall: "fail" }; });
  await page.getByRole("button", { name: "إعادة الفحص" }).click();
  await expect(page.locator("#check-summary")).toHaveClass(/support-summary-fail/);
  expect(await page.locator("#check-summary").evaluate(el => getComputedStyle(el).backgroundImage)).toContain("rgb(239, 68, 68)");
});

test("technical command failures go to the error log, input mistakes do not", async ({ page }) => {
  await page.evaluate(() => { window.failRead = "The operation could not be completed"; window.runUpload("readDocumentFields", ["synthetic.jpg"]); return window.pending; });
  const logged = await page.evaluate(() => window.calls.filter(c => c.command === "cmd_log_client_error").map(c => c.args));
  expect(logged).toHaveLength(1);
  expect(logged[0].operation).toBe("cmd_read_document_fields");
  expect(logged[0].message).toBe("The operation could not be completed");
  await page.evaluate(() => { window.failRead = "قراءة البيانات تعمل على الصور فقط"; window.runUpload("readDocumentFields", ["synthetic.jpg"]); return window.pending; });
  expect(await page.evaluate(() => window.calls.filter(c => c.command === "cmd_log_client_error").length)).toBe(1);
});

test("contact buttons send only a channel and a topic", async ({ page }) => {
  await page.locator('[data-channel="whatsapp"][data-topic="problem"]').click();
  await page.locator('[data-channel="email"][data-topic="suggestion"]').click();
  const calls = await page.evaluate(() => window.calls.filter(c => c.command === "cmd_open_support_link").map(c => c.args));
  expect(calls).toEqual([{ channel: "whatsapp", topic: "problem" }, { channel: "email", topic: "suggestion" }]);
});

test("update check reports the latest version or leads to settings", async ({ page }) => {
  await page.getByRole("button", { name: "التحقق من التحديثات" }).click();
  await expect(page.locator("#support-update-status")).toHaveText("لديك أحدث إصدار (1.0.5).");
  await page.evaluate(() => { window.updateInfo = { configured: true, available: true, current_version: "1.0.5", version: "1.0.6", notes: "", date: "" }; });
  await page.getByRole("button", { name: "التحقق من التحديثات" }).click();
  await page.getByRole("button", { name: "التثبيت من الإعدادات" }).click();
  expect(await page.evaluate(() => window.navigated)).toEqual({ target: "settings", options: { tab: "updates" } });
});

test("settings has one «الدعم وحول النظام» tab for every user, and one tab for storage and backups", async ({ page }) => {
  await page.evaluate(async () => {
    const { renderSettings } = await import("/src/screens/settings.js");
    await renderSettings(document.querySelector("#root"), { username: "admin", permissions: ["settings.manage", "backups.manage"] }, {});
  });
  const tabs = page.locator("[data-settings-tab]");
  await expect(tabs.filter({ hasText: "الحفظ والنسخ الاحتياطي" })).toHaveCount(1);
  await tabs.filter({ hasText: "الحفظ والنسخ الاحتياطي" }).click();
  // Storage and backups is an inner list showing one section at a time.
  const storage = page.locator('[data-settings-panel="storage"]');
  await expect(storage.locator(".settings-subnav-item")).toHaveText(["مواقع الحفظ", "النسخ التلقائي", "نسخة يدوية"]);
  await expect(storage.locator('[data-sub="locations"]')).toBeVisible();
  await storage.getByRole("button", { name: "نسخة يدوية" }).click();
  await expect(storage.locator('[data-sub="manual"]')).toBeVisible();
  await expect(storage.locator('[data-sub="locations"]')).toBeHidden();
  const support = tabs.filter({ hasText: "الدعم وحول النظام" });
  await expect(support).toHaveCount(1);
  await expect(tabs.filter({ hasText: /^حول النظام$/ })).toHaveCount(0);
  await support.click();
  const panel = page.locator('[data-settings-panel="support"]');
  await expect(tabs.filter({ hasText: "التحديثات" })).toHaveCount(0);
  await expect(panel.locator(".settings-subnav-item")).toHaveText(["حول النظام", "فحص البرنامج", "اتصل بنا", "التحديثات"]);
  await panel.getByRole("button", { name: "التحديثات" }).click();
  await expect(page.locator("#btn-check-update")).toBeVisible();
  // «التحديث التلقائي» is on by default and saved as soon as it is switched.
  const autoUpdate = page.locator("#auto-update-enabled");
  await expect(autoUpdate).toBeChecked();
  await autoUpdate.uncheck();
  await expect.poll(() => page.evaluate(() => window.calls.filter(c => c.command === "cmd_set_auto_update").map(c => c.args.enabled))).toEqual([false]);
  await expect(autoUpdate).not.toBeChecked();
  await panel.getByRole("button", { name: "حول النظام" }).click();
  await expect(page.locator(".about-card")).toBeVisible();
  await panel.getByRole("button", { name: "فحص البرنامج" }).click();
  await expect(page.getByRole("button", { name: "بدء الفحص" })).toBeVisible();
  await expect(page.locator(".about-card")).toBeHidden();
  // The «التحديثات» section already covers updates, and the user is already in Settings.
  await expect(page.locator("#btn-support-check-update")).toHaveCount(0);
  await expect(page.locator("#btn-open-settings")).toHaveCount(0);
});

test("opening settings again starts on the first tab and the first inner item", async ({ page }) => {
  const open = () => page.evaluate(async () => {
    const { renderSettings } = await import("/src/screens/settings.js");
    await renderSettings(document.querySelector("#root"), { username: "admin", permissions: ["settings.manage", "backups.manage"] }, {});
  });
  await open();
  await page.locator("[data-settings-tab]").filter({ hasText: "الحفظ والنسخ الاحتياطي" }).click();
  await page.locator('[data-settings-panel="storage"]').getByRole("button", { name: "نسخة يدوية" }).click();
  await open();
  await expect(page.locator('[data-settings-tab][aria-selected="true"]')).toHaveText("الجهة والشعار");
  await page.locator("[data-settings-tab]").filter({ hasText: "الحفظ والنسخ الاحتياطي" }).click();
  await expect(page.locator('[data-settings-panel="storage"] [aria-current="true"]')).toHaveText("مواقع الحفظ");
});

test("users without settings and backup rights do not see the updates section", async ({ page }) => {
  await page.evaluate(async () => {
    const { renderSettings } = await import("/src/screens/settings.js");
    await renderSettings(document.querySelector("#root"), { username: "viewer", permissions: [] }, { tab: "updates" });
  });
  const panel = page.locator('[data-settings-panel="support"]');
  await expect(panel.locator(".settings-subnav-item")).toHaveText(["حول النظام", "فحص البرنامج", "اتصل بنا"]);
  await expect(page.locator("#btn-check-update")).toHaveCount(0);
});

test("save buttons stay dim until something changes", async ({ page }) => {
  await page.evaluate(async () => {
    const { renderSettings } = await import("/src/screens/settings.js");
    await renderSettings(document.querySelector("#root"), { username: "admin", permissions: ["settings.manage", "backups.manage"] }, { tab: "company" });
  });
  const saveCompany = page.locator("#btn-save-cfg");
  await expect(saveCompany).toBeDisabled();
  const original = await page.locator("#c-dept").inputValue();
  await page.locator("#c-dept").fill("قسم آخر");
  await expect(saveCompany).toBeEnabled();
  await page.locator("#c-dept").fill(original);
  await expect(saveCompany).toBeDisabled();
  await page.locator('[data-settings-tab="storage"]').click();
  await page.getByRole("button", { name: "النسخ التلقائي" }).click();
  const saveBackup = page.locator("#btn-save-auto-backup");
  await expect(saveBackup).toBeDisabled();
  await page.locator("#auto-backup-weekly").check();
  await expect(saveBackup).toBeEnabled();
});

test("«المستخدمين والصلاحيات» is a settings tab only for users.manage", async ({ page }) => {
  const render = perms => page.evaluate(async permissions => {
    const { renderSettings } = await import("/src/screens/settings.js");
    await renderSettings(document.querySelector("#root"), { username: "admin", permissions }, { tab: "users" });
  }, perms);
  await render(["settings.manage"]);
  await expect(page.locator('[data-settings-tab="users"]')).toHaveCount(0);
  await render(["settings.manage", "users.manage"]);
  await expect(page.locator('[data-settings-tab="users"]')).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("إدارة المستخدمين")).toBeVisible();
  await expect(page.getByText("synthetic-viewer")).toBeVisible();
});
