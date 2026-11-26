import { test, expect } from "@playwright/test";

// Users screen (review of «المستخدمين والصلاحيات»). Synthetic accounts only: the harness mocks every backend command.
const admin = ["users.manage", "users.assign_system_admin", "settings.manage"];
const account = (id, username, role, extra = {}) => ({ id, username, role, must_change_password: false, created_at: "2026-10-01 09:00:00",
  disabled: false, trusted: true, last_login: "2026-11-20 08:15:00", ...extra });

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/scanner-harness.html");
  await page.waitForFunction(() => window.ready);
  await page.evaluate(accounts => {
    window.permissionsOverride = ["users.manage", "users.assign_system_admin", "settings.manage"];
    window.accounts = accounts;
    document.body.insertAdjacentHTML("beforeend", `<div id="toast" class="opacity-0"><span id="toast-msg"></span></div>`);
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "cmd_list_users") return window.accounts;
      if (command === "cmd_create_user") { window.calls.push({ command, args }); window.accounts.push({ ...args.data, id: 99 }); return args.data; }
      if (command === "cmd_update_user_role") { window.calls.push({ command, args }); if (window.refuse) throw window.refuse; return {}; }
      if (command === "cmd_set_user_disabled" || command === "cmd_reset_user_password" || command === "cmd_delete_user") { window.calls.push({ command, args }); return {}; }
      return original(command, args);
    };
  }, [account(1, "sysadmin", "system_admin"), account(2, "it.manager", "system_admin"), account(3, "archive.clerk", "archive_officer"),
      account(4, "reception", "viewer", { disabled: true }), account(5, "auditor", "viewer", { trusted: false, last_login: null })]);
  await page.evaluate(() => window.renderActual("users"));
});

const called = (page, command) => page.evaluate(name => window.calls.filter(c => c.command === name).map(c => c.args), command);

test("a new user gets no role until the admin picks one, and the username is checked in Arabic", async ({ page }) => {
  await page.locator("#btn-add-user").click();
  await expect(page.locator("input[name=new-role]:checked")).toHaveCount(0);
  await expect(page.locator(".role-card")).toHaveCount(3);
  await expect(page.locator("#new-username")).toHaveAttribute("dir", "ltr");
  await page.locator("#new-username").fill("أحمد");
  await page.locator("#new-user-password").fill("Archive7Desk");
  await page.locator("#new-user-password-confirm").fill("Archive7Desk");
  await page.locator("form.card [type=submit]").click();
  await expect(page.locator("[data-dialog-error]")).toContainText("أحرف إنجليزية");
  await page.locator("#new-username").fill("IT.Manager");
  await page.locator("form.card [type=submit]").click();
  await expect(page.locator("[data-dialog-error]")).toContainText("موجود");
  await page.locator("#new-username").fill("new.clerk");
  await page.locator("form.card [type=submit]").click();
  await expect(page.locator("[data-dialog-error]")).toHaveText("اختر دور المستخدم");
  await page.locator(".role-card:has(input[value=archive_officer])").click();
  await page.locator("form.card [type=submit]").click();
  await expect.poll(() => called(page, "cmd_create_user")).toEqual([{ data: { username: "new.clerk", password: "Archive7Desk", role: "archive_officer" } }]);
});

test("your own account cannot be deleted and its role is not offered", async ({ page }) => {
  const own = page.locator(".table-row", { hasText: "sysadmin" });
  await expect(own.locator(".delete-user")).toBeDisabled();
  await own.locator(".edit-user").click();
  await expect(page.locator("input[name=edit-role]")).toHaveCount(0);
  await expect(page.locator("form.card")).toContainText("ثابت");
  await expect(page.locator("#user-disabled")).toHaveCount(0);
  await expect(page.locator(".dialog-title")).toHaveCSS("text-transform", "none");
});

test("editing changes the role and stops the account in one save", async ({ page }) => {
  await page.locator(".table-row", { hasText: "archive.clerk" }).locator(".edit-user").click();
  await page.locator(".role-card:has(input[value=viewer])").click();
  await page.locator("#user-disabled").check();
  await page.locator("form.card [type=submit]").click();
  await expect.poll(() => called(page, "cmd_update_user_role")).toEqual([{ id: 3, data: { role: "viewer" } }]);
  expect(await called(page, "cmd_set_user_disabled")).toEqual([{ id: 3, data: { disabled: true } }]);
  expect(await called(page, "cmd_reset_user_password")).toEqual([]);
});

test("a refusal from the program is shown in Arabic inside the dialog", async ({ page }) => {
  await page.evaluate(() => { window.refuse = "You are not authorized to perform this action"; });
  await page.locator(".table-row", { hasText: "it.manager" }).locator(".edit-user").click();
  await page.locator(".role-card:has(input[value=viewer])").click();
  await page.locator("form.card [type=submit]").click();
  await expect(page.locator("[data-dialog-error]")).toHaveText("ليست لديك صلاحية لهذا الإجراء");
});

test("states, dates and the roles table are shown; search appears only for a long list", async ({ page }) => {
  await expect(page.locator(".table-row", { hasText: "reception" })).toContainText("موقوف");
  await expect(page.locator(".table-row", { hasText: "auditor" })).toContainText("عُدّل من خارج البرنامج");
  await expect(page.locator(".table-row", { hasText: "auditor" })).toContainText("لم يدخل بعد");
  await expect(page.locator(".table-row", { hasText: "it.manager" })).toContainText("2026/11/20 08:15");
  await expect(page.locator("#user-search")).toHaveCount(0);
  await expect(page.getByText("5 من 10 مستخدمين")).toBeVisible();
  await expect(page.locator(".users-matrix tbody tr")).toHaveCount(8);
});

test("deleting asks on a red button that names the action", async ({ page }) => {
  await page.locator(".table-row", { hasText: "archive.clerk" }).locator(".delete-user").click();
  const confirm = page.locator("[role=alertdialog]");
  await expect(confirm).toContainText("archive.clerk");
  await expect(confirm.locator(".btn-danger-solid")).toHaveText("حذف المستخدم");
  await confirm.locator(".btn-danger-solid").click();
  await expect.poll(() => called(page, "cmd_delete_user")).toEqual([{ id: 3 }]);
});

test("«حفظ سياسة كلمة المرور» stays off until the policy changes, and easy passwords are allowed by default", async ({ page }) => {
  await page.evaluate(async () => {
    const before = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "cmd_get_password_policy") return {};
      if (command === "cmd_set_password_policy") { window.calls.push({ command, args }); return args.policy; }
      return before(command, args);
    };
    await window.renderActual("users");
  });
  const save = page.locator("#btn-save-policy");
  await expect(page.locator("#policy-common")).not.toBeChecked();
  await expect(save).toBeDisabled();
  await page.locator("#policy-common").check();
  await expect(save).toBeEnabled();
  await page.locator("#policy-common").uncheck();
  await expect(save).toBeDisabled();
  await page.locator("#policy-length").fill("10");
  await expect(save).toBeEnabled();
  await save.click();
  await expect.poll(() => called(page, "cmd_set_password_policy")).toEqual([{ policy: expect.objectContaining({ min_length: 10, reject_common: false }) }]);
  await expect(save).toBeDisabled();
});
