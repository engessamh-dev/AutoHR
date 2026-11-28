import { test, expect } from "@playwright/test";
import fs from "node:fs";

// Document-alert notifications that Windows refuses, and a failed automatic backup on sign-out.
// The whole program runs (main.js); the backend is mocked (tests/login-setup-mock.js plus the
// commands below). Synthetic data only. Rust's own tests cover notify/backup/recovery logic.
const mock = fs.readFileSync(new URL("./login-setup-mock.js", import.meta.url), "utf8");
const { version } = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const ready = { state: "ready", needsAdmin: false, users: { "it.admin": { password: "Nakheel2026", mustChange: false } }, base: "it.admin", division: "شعبة الحاسبة" };

const inDays = days => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

async function start(page, extra = {}) {
  await page.addInitScript(value => { window.__mockInit = value; }, ready);
  await page.addInitScript(mock);
  await page.addInitScript(({ extra, expiry, version }) => {
    const X = window.__extra = Object.assign({ notify: "ok", backupFailures: 0, notifications: [], backups: 0, logouts: 0 }, extra);
    // No automatic repeat in the tests: each check is started by the test.
    window.autohrDocumentAlertCheckMs = 24 * 60 * 60 * 1000;
    // «ما الجديد» already seen, so it does not cover the program.
    localStorage.setItem("cnsarch.whatsNewSeen", version);
    const base = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (cmd, args = {}) => {
      switch (cmd) {
        case "cmd_list_employees":
          return [{ id: 7, is_active: 1, full_name: "موظف تجريبي", civil_id_expiry_date: expiry }];
        case "cmd_get_document_alert_rules":
          return [{ key: "national", enabled: true, days: [30, 15, 7] }];
        case "cmd_show_notification":
          X.notifications.push(args.title);
          if (X.notify === "refuse") throw "Notification not shown: notifications are turned off for this program in Windows";
          if (X.notify === "fail") throw "Notification not shown: the toast could not be shown";
          return null;
        case "cmd_run_due_auto_backups":
          X.backups += 1;
          if (X.backupFailures > 0) { X.backupFailures -= 1; throw "تعذر التحقق من النسخة الاحتياطية الجديدة"; }
          return ["يومي"];
        case "cmd_logout": X.logouts += 1; return null;
        default: return base(cmd, args);
      }
    };
  }, { extra, expiry: inDays(5), version });
  await page.goto("/");
  await page.fill("#login-username", "it.admin");
  await page.fill("#login-password", "Nakheel2026");
  await page.click(".login-hit-submit");
  await expect(page.locator("#app-shell")).toBeVisible();
}
const extra = page => page.evaluate(() => ({ ...window.__extra }));
const announced = page => page.evaluate(() => JSON.parse(localStorage.getItem("cnsarch.documentAlertStages.it.admin") || "{}"));
const check = page => page.evaluate(() => window.autohrCheckDocumentAlerts());

test("alerts: refused by Windows stays pending, is tried again, then sent once and not repeated", async ({ page }) => {
  await start(page, { notify: "refuse" });
  await expect.poll(async () => (await extra(page)).notifications.length).toBe(1);
  expect(await announced(page)).toEqual({});

  // The request fails instead of being refused: still pending.
  await page.evaluate(() => { window.__extra.notify = "fail"; });
  await check(page);
  expect((await extra(page)).notifications.length).toBe(2);
  expect(await announced(page)).toEqual({});

  // Notifications allowed again in Windows: the next check sends it, and it is recorded.
  await page.evaluate(() => { window.__extra.notify = "ok"; });
  await check(page);
  expect((await extra(page)).notifications).toEqual(["تنبيهات المستمسكات", "تنبيهات المستمسكات", "تنبيهات المستمسكات"]);
  expect(Object.values(await announced(page))).toEqual(["r7"]);

  // Same user, same stage: not sent again.
  await check(page);
  await check(page);
  expect((await extra(page)).notifications.length).toBe(3);
});

async function signOut(page) {
  await page.click("#btn-logout-side");
  await page.locator(".app-dialog button", { hasText: "تأكيد" }).click();
}
const choice = page => page.locator(".app-choice-dialog");

test("sign-out: a failed backup asks; «البقاء» keeps the session, «إعادة المحاولة» signs out once it works", async ({ page }) => {
  await start(page, { backupFailures: 2 });
  await signOut(page);
  await expect(choice(page)).toBeVisible();
  await expect(choice(page)).toContainText("فشل النسخ الاحتياطي التلقائي");
  await expect(choice(page)).toContainText("آخر نسخة سليمة باقية كما هي");
  await expect(choice(page).locator("button")).toHaveText(["إعادة المحاولة", "البقاء في البرنامج", "تسجيل الخروج بدون نسخة جديدة"]);
  await choice(page).locator("button", { hasText: "البقاء في البرنامج" }).click();
  await expect(choice(page)).toHaveCount(0);
  await expect(page.locator("#app-shell")).toBeVisible();
  expect((await extra(page)).logouts).toBe(0);

  await signOut(page);
  await expect(choice(page)).toBeVisible();
  await choice(page).locator("button", { hasText: "إعادة المحاولة" }).click();
  await expect(page.locator("#login-screen")).toBeVisible();
  const x = await extra(page);
  expect(x.backups).toBe(3);
  expect(x.logouts).toBe(1);
});

test("sign-out: «تسجيل الخروج بدون نسخة جديدة» is the user's choice, and is said", async ({ page }) => {
  await start(page, { backupFailures: 99 });
  await signOut(page);
  await choice(page).locator("button", { hasText: "بدون نسخة جديدة" }).click();
  await expect(page.locator("#login-screen")).toBeVisible();
  const x = await extra(page);
  expect(x.logouts).toBe(1);
  expect(x.notifications).toContain("فشل النسخ التلقائي");
});
