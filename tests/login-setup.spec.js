import { test, expect } from "@playwright/test";
import fs from "node:fs";

// Login screen and first-run wizard (review «شاشة الدخول والإعداد الأول»). The backend is mocked
// (tests/login-setup-mock.js); Rust's own tests cover the real rules (account.rs, storage.rs, services.rs).
const mock = fs.readFileSync(new URL("./login-setup-mock.js", import.meta.url), "utf8");
const ready = { state: "ready", needsAdmin: false, users: { "it.admin": { password: "Nakheel2026", mustChange: false } }, base: "it.admin", recoveryCode: "K7QM-2XPA-9TRF-H4WD", division: "شعبة الحاسبة" };

async function start(page, init = {}) {
  await page.addInitScript(value => { window.__mockInit = value; }, init);
  await page.addInitScript(mock);
  await page.goto("/");
}
const calls = (page, cmd) => page.evaluate(name => window.__mock.calls.filter(c => c.cmd === name).map(c => c.args), cmd);
const login = async (page, username, password) => {
  await page.fill("#login-username", username);
  await page.fill("#login-password", password);
  await page.click(".login-hit-submit");
};

test("first run: folders, the administrator's own account, names, recovery code, then the program opens signed in", async ({ page }) => {
  await start(page);
  await expect(page.locator("#setup-steps li.is-current")).toContainText("مواقع الحفظ");
  await page.fill("#setup-data-root", "D:\\");
  await page.fill("#setup-backup-root", "E:\\");
  await page.dispatchEvent("#setup-backup-root", "change");
  await expect(page.locator("#setup-warnings")).toContainText("D:\\CNSArch-Data");
  await page.click("#setup-submit");
  await expect.poll(() => calls(page, "cmd_complete_setup")).toEqual([{ dataRoot: "D:\\CNSArch-Data", backupRoot: "E:\\CNSArch-Backups" }]);

  await expect(page.locator("#setup-steps li.is-current")).toContainText("حساب المسؤول");
  await page.fill("#setup-admin-username", "it.admin");
  await page.fill("#setup-admin-password", "Password1");
  await expect(page.locator('#setup-admin-rules li[data-rule="common"]')).not.toHaveClass(/is-met/);
  await expect(page.locator('#setup-admin-rules li[data-rule="length"]')).toHaveClass(/is-met/);
  await page.fill("#setup-admin-confirm", "Password1");
  await page.click("#setup-admin-form [type=submit]");
  await expect(page.locator("#setup-admin-error")).toHaveText("كلمة المرور سهلة التخمين، اختر غيرها");
  await page.fill("#setup-admin-password", "Nakheel2026");
  await page.fill("#setup-admin-confirm", "Nakheel2026");
  await page.click("#setup-admin-form [type=submit]");

  await page.fill("#setup-department", "قسم تقنية المعلومات");
  await page.fill("#setup-division", "شعبة الحاسبة");
  await page.click("#setup-unit-submit");
  await expect(page.locator("#setup-code")).toHaveText("K7QM-2XPA-9TRF-H4WD");
  await expect(page.locator("#setup-code-done")).toBeDisabled();
  await page.check("#setup-code-saved");
  await page.click("#setup-code-done");
  await expect(page.locator("#app-shell")).toBeVisible();
  await expect(page.locator("#current-user")).toHaveText("it.admin");
  expect(await calls(page, "cmd_complete_first_run")).toEqual([{ data: { username: "it.admin", password: "Nakheel2026", department_name: "قسم تقنية المعلومات", division_name: "شعبة الحاسبة" } }]);
  expect(await calls(page, "cmd_login")).toEqual([]);
});

test("a database that cannot be opened keeps its reason on screen", async ({ page }) => {
  await start(page, { state: "open_failed", data_root: "D:\\CNSArch-Data", backup_root: "E:\\CNSArch-Backups", needsAdmin: false,
    message: "قاعدة البيانات أُنشئت بإصدار أحدث من البرنامج (إصدار المخطط 14، والمدعوم 11)." });
  await expect(page.locator("#setup-intro")).toContainText("موجودة لكن تعذر فتحها");
  await expect(page.locator("#setup-error")).toContainText("إصدار أحدث");
  await expect(page.locator("#setup-retry")).toBeHidden();
  await expect(page.locator("#setup-steps")).toBeHidden();
});

test("wrong passwords warn before the pause, and the pause blocks only that name", async ({ page }) => {
  await start(page, ready);
  for (let i = 0; i < 2; i++) await login(page, "it.admin", `wrong${i}`);
  await expect(page.locator("#login-error")).toHaveText("اسم المستخدم أو كلمة المرور غير صحيحة");
  await login(page, "it.admin", "wrong2");
  await expect(page.locator("#login-error")).toContainText("بقيت محاولتان");
  await login(page, "it.admin", "wrong3");
  await login(page, "it.admin", "wrong4");
  await expect(page.locator("#login-error")).toContainText("تم إيقاف الدخول مؤقتًا. حاول بعد 0");
  await expect(page.locator(".login-hit-submit")).toBeDisabled();
  await page.fill("#login-username", "clerk.one");
  await expect(page.locator(".login-hit-submit")).toBeEnabled();
  await expect(page.locator("#login-error")).toBeHidden();
  await page.fill("#login-username", "IT.Admin");
  await expect(page.locator(".login-hit-submit")).toBeDisabled();
});

test("forgot password: the recovery code sets a new password and gives a new code", async ({ page }) => {
  await start(page, ready);
  await page.click(".login-hit-forgot");
  await page.click("#recovery-with-code");
  await page.fill("#recovery-code", "k7qm 2xpa 9trf h4wd");
  await page.fill("#recovery-new", "Tigris7Bridge");
  await page.fill("#recovery-confirm", "Tigris7Bridge");
  await page.click("#recovery-form [type=submit]");
  await expect(page.locator(".recovery-dialog .recovery-code")).toHaveText("P3WX-8DKR-5QHN-ZT7A");
  await page.check("#recovery-saved");
  await page.click("#recovery-finish");
  await expect(page.locator("#login-username")).toHaveValue("it.admin");
  await login(page, "it.admin", "Tigris7Bridge");
  await expect(page.locator("#app-shell")).toBeVisible();
});

test("forgot password: the developer code is a QR, with the text only on request", async ({ page }) => {
  await start(page, ready);
  await page.click(".login-hit-forgot");
  await page.click("#recovery-with-developer");
  await expect(page.locator(".unlock-qr svg")).toBeVisible();
  await expect(page.locator("#unlock-challenge")).toBeHidden();
  await page.click(".unlock-text summary");
  await expect(page.locator("#unlock-challenge")).toHaveText("CNS1-K7QMPX-3FA2-20261126");
  await page.fill("#unlock-code", "AAAA-BBBB");
  await page.fill("#recovery-new", "Tigris7Bridge");
  await page.fill("#recovery-confirm", "Tigris7Bridge");
  await page.click("#unlock-form [type=submit]");
  await expect(page.locator("#recovery-error")).toContainText("رمز الفتح غير صحيح");
});

test("a long unit name fits inside the drawn pill", async ({ page }) => {
  await start(page, { ...ready, division: "شعبة الموارد البشرية والأرشفة الإلكترونية" });
  const unit = page.locator("#login-unit-name");
  await expect(unit).toHaveText("شعبة الموارد البشرية والأرشفة الإلكترونية");
  await expect.poll(() => unit.evaluate(el => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1)).toBe(true);
});
