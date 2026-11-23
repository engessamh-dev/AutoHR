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
  await page.getByRole("button", { name: "حفظ ملف التشخيص" }).click();
  await expect.poll(() => page.evaluate(() => window.calls.find(c => c.command === "cmd_save_health_report")?.args.destinationPath)).toBe("C:\\Synthetic\\diag.txt");
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

test("settings holds «الفحص والدعم» and «حول النظام» as tabs for every user", async ({ page }) => {
  await page.evaluate(() => window.renderActual("settings"));
  const tabs = page.locator("[data-settings-tab]");
  await expect(tabs.filter({ hasText: "الفحص والدعم" })).toHaveCount(1);
  await expect(tabs.filter({ hasText: "حول النظام" })).toHaveCount(1);
  await tabs.filter({ hasText: "الفحص والدعم" }).click();
  await expect(page.getByRole("button", { name: "بدء الفحص" })).toBeVisible();
  // The «التحديثات» tab already covers updates, so the support tab leaves that card out.
  await expect(page.locator("#btn-support-check-update")).toHaveCount(0);
  await tabs.filter({ hasText: "حول النظام" }).click();
  await expect(page.locator(".about-card")).toBeVisible();
  await expect(page.locator("#btn-open-settings")).toHaveCount(0);
});
