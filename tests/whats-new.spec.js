import { test, expect } from "@playwright/test";

// «ما الجديد»: shown once after an update, notes from the GitHub release with the bundled
// notes as the offline fallback. Synthetic data only: the harness mocks every backend command.
test.beforeEach(async ({ page }) => {
  await page.goto("/tests/scanner-harness.html");
  await page.waitForFunction(() => window.ready);
  await page.evaluate(() => localStorage.removeItem("cnsarch.whatsNewSeen"));
});

test("after an update the GitHub release notes are shown once, as a list", async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem("cnsarch.whatsNewSeen", "1.0.5");
    window.releaseNotes = "## إضافات\n- ميزة أولى\n- ميزة <b>ثانية</b>\n\nسطر عادي";
    window.whatsNewDone = window.whatsNew.showWhatsNewIfUpdated().then(() => true);
  });
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("ما الجديد في الإصدار");
  await expect(dialog.locator("li")).toHaveText(["ميزة أولى", "ميزة <b>ثانية</b>"]);
  await expect(dialog.locator(".whats-new-heading")).toHaveText("إضافات");
  await expect(dialog.locator("b")).toHaveCount(0);
  await page.getByRole("button", { name: "حسنًا" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await page.evaluate(() => window.whatsNewDone)).toBe(true);
  // Not shown again for the same version.
  await page.evaluate(() => window.whatsNew.showWhatsNewIfUpdated());
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("offline, the notes bundled with the app are shown", async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem("cnsarch.whatsNewSeen", "1.0.5");
    window.releaseNotesError = "تعذر جلب ملاحظات الإصدار من الإنترنت.";
    window.whatsNew.showWhatsNewIfUpdated();
  });
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("li").first()).toBeVisible();
  expect(await dialog.locator("li").count()).toBeGreaterThan(3);
});

test("a fresh installation does not show it", async ({ page }) => {
  await page.evaluate(async () => {
    window.whatsNew.markWhatsNewSeen();
    window.releaseNotes = "- شيء";
    await window.whatsNew.showWhatsNewIfUpdated();
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("«حول النظام» opens it at any time", async ({ page }) => {
  await page.evaluate(() => { window.releaseNotes = "- ملاحظة من GitHub"; });
  await page.evaluate(() => window.renderActual("about"));
  await page.getByRole("button", { name: "ما الجديد في هذا الإصدار" }).click();
  await expect(page.getByRole("dialog").locator("li")).toHaveText(["ملاحظة من GitHub"]);
  await expect.poll(() => page.evaluate(() => window.calls.filter(c => c.command === "cmd_get_release_notes").length)).toBe(1);
});
