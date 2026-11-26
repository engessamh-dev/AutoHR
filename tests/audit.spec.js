import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync } from "fs";

// «سجل النظام». Synthetic data only: the harness mocks every backend command.
test.beforeEach(async ({ page }) => {
  await page.goto("/tests/scanner-harness.html");
  await page.waitForFunction(() => window.ready);
});

/** Every action code the backend writes to the audit log. */
function backendActions() {
  const dir = "src-tauri/src";
  const source = readdirSync(dir).filter(name => name.endsWith(".rs") && !name.includes("test"))
    .map(name => readFileSync(`${dir}/${name}`, "utf8")).join("\n");
  const codes = new Set();
  for (const call of source.matchAll(/(?:log_activity|log_audit|logged_failure|audit_processing_action)\(([^;]*)/g)) {
    for (const code of call[1].matchAll(/"([A-Z][A-Z_]{3,})"/g)) codes.add(code[1]);
  }
  // Scanner uploads are named after their command: cmd_upload_x → UPLOAD_X.
  for (const command of source.matchAll(/"cmd_upload_([a-z_]+)"/g)) {
    if (!["general_doc_file", "outgoing_doc_file", "employee_photo"].includes(command[1])) codes.add(`UPLOAD_${command[1].toUpperCase()}`);
  }
  return [...codes].sort();
}

test("every action the program records has an Arabic name", async ({ page }) => {
  const codes = backendActions();
  expect(codes.length).toBeGreaterThan(60);
  const missing = await page.evaluate(async codes => {
    const { ACTIONS } = await import("/src/audit-labels.js");
    return codes.filter(code => !ACTIONS[code]);
  }, codes);
  expect(missing).toEqual([]);
});

test("details are readable Arabic, for new and old entries", async ({ page }) => {
  const lines = await page.evaluate(async () => {
    const { describeLog, actionLabel, userLabel } = await import("/src/audit-labels.js");
    const log = (action, extra = {}) => ({ action, result: "Success", username: "hr", role: "archive_admin", ...extra });
    return {
      ministry: describeLog(log("UPLOAD_MINISTRY_BADGE_ATTACHMENT", { target_type: "employee", target_id: 7,
        target_name: "Files/Employees/7/Documents/MinistryBadge/ab12cd34ef56ab12cd34.jpg",
        details: JSON.stringify({ employee: "علي حسن كاظم", employee_number: "1024", note: "back" }) })),
      oldMinistry: describeLog(log("UPLOAD_MINISTRY_BADGE_ATTACHMENT", { target_type: "employee", target_id: 7, target_name: "Files/Employees/7/x.jpg", details: "front" })),
      role: describeLog(log("CHANGE_USER_ROLE", { target_type: "user", target_name: "viewer1", details: "viewer -> archive_officer" })),
      number: describeLog(log("UPDATE_EMPLOYEE", { target_type: "employee", target_name: "علي",
        details: JSON.stringify({ employee: "علي", changes: [{ field: "employee_number", old: "1024", new: "1042" }] }) })),
      dept: describeLog(log("CHANGE_SETTING", { target_type: "settings", target_name: "company_config",
        details: JSON.stringify({ changes: [{ field: "department_name", old: "قسم الاتصالات", new: "قسم الصيانة" }] }) })),
      docDelete: describeLog(log("DELETE_DOC", { target_type: "general_doc", target_name: "وزارة النقل",
        details: JSON.stringify({ doc: { from: "وزارة النقل", subject: "تعميم", number: "م/4133", date: "2026-10-08", files: 2 } }) })),
      failed: [actionLabel(log("LOGIN", { result: "Failure", details: "Invalid password" })), describeLog(log("LOGIN", { result: "Failure", details: "Invalid password" }))],
      leakedName: userLabel(log("LOGIN", { result: "Failure", role: "unknown", username: "pa55word!", details: "Unknown username" })),
      alerts: describeLog(log("UPDATE_DOCUMENT_ALERT_SETTINGS", { target_type: "settings", details: '{"national":{"enabled":true}}' })),
    };
  });
  expect(lines.ministry).toBe("الموظف: علي حسن كاظم (1024) · الوجه الخلفي");
  expect(lines.oldMinistry).toBe("الموظف رقم 7 · الوجه الأمامي");
  expect(lines.role).toBe("المستخدم: viewer1 · من «مشاهد» إلى «موظف»");
  expect(lines.number).toContain("الرقم الوظيفي: من «1024» إلى «1042»");
  expect(lines.dept).toContain("القسم: من «قسم الاتصالات» إلى «قسم الصيانة»");
  expect(lines.docDelete).toBe("وزارة النقل، تعميم، العدد م/4133، 2026/10/8، مرفقات: 2");
  expect(lines.failed).toEqual(["محاولة دخول فاشلة", "السبب: كلمة مرور خاطئة"]);
  expect(lines.leakedName).toBe("pa…");
  expect(lines.alerts).toBe("");
});

test("the screen asks the database for one page, with the filters", async ({ page }) => {
  await page.evaluate(() => {
    window.queries = [];
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: 1000 - i, username: "sysadmin", role: "system_admin", action: "CREATE_BACKUP",
      target_type: "backup", target_name: `autohr_manual_${i}.autohrbak`, result: "Success", details: null, created_at: "2026-11-25 11:00:00" }));
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "cmd_search_activity_log") {
        window.queries.push(args.filter);
        return { rows, total: 1424, users: ["hr.admin", "sysadmin", "system"], actions: ["CREATE_BACKUP", "LOGIN", "UPLOAD_MINISTRY_BADGE_ATTACHMENT"] };
      }
      return original(command, args);
    };
  });
  await page.evaluate(async () => (await import("/src/screens/audit.js")).renderAudit(document.querySelector("#root")));
  await expect(page.locator("#audit-count")).toHaveText("1,424 عملية");
  await expect(page.locator("#audit-page-label")).toHaveText("الصفحة 1 من 15");
  await expect(page.locator("#audit-body tr")).toHaveCount(100);
  // Successful sign-ins and previews are hidden until asked for.
  expect(await page.evaluate(() => window.queries[0])).toMatchObject({ offset: 0, limit: 100, exclude_actions: ["LOGIN", "LOGOUT", "VIEW_DOCUMENT", "DOCUMENT_TEXT_READ", "PROCESS_DOCUMENT"] });
  await expect(page.locator("#audit-action option", { hasText: "رفع هوية وزارة النقل" })).toHaveCount(1);
  await expect(page.locator("#audit-user option", { hasText: "البرنامج (تلقائي)" })).toHaveCount(1);

  await page.locator("#audit-next").click();
  await expect.poll(() => page.evaluate(() => window.queries.at(-1).offset)).toBe(100);
  await page.locator("#audit-result").selectOption("Failure");
  await expect.poll(() => page.evaluate(() => window.queries.at(-1))).toMatchObject({ offset: 0, result: "Failure" });
  await page.locator("#audit-action").selectOption("group:مستمسكات الموظف");
  await expect(page.locator("#audit-action option[value='group:مستمسكات الموظف']")).toHaveText("مستمسكات الموظف: الكل");
  const groupQuery = await page.evaluate(() => window.queries.at(-1));
  expect(groupQuery.actions).toContain("UPLOAD_MINISTRY_BADGE_ATTACHMENT");
  expect(groupQuery.actions).not.toContain("LOGIN");
  await page.locator("#audit-search").fill("هوية وزارة");
  await expect.poll(() => page.evaluate(() => window.queries.at(-1).search)).toBe("هوية وزارة");
  expect(await page.evaluate(() => window.queries.at(-1).search_actions)).toContain("UPLOAD_MINISTRY_BADGE_ATTACHMENT");
  await page.locator("#audit-from").fill("2026-11-25");
  await page.locator("#audit-from").dispatchEvent("change");
  const dated = await page.evaluate(() => window.queries.at(-1));
  expect(dated.from).toMatch(/^2026-11-2[45] \d\d:00:00$/);
});

test("export saves every matching entry in Arabic and is recorded by the backend", async ({ page }) => {
  await page.evaluate(() => {
    window.savePath = "C:\\Synthetic\\log.xlsx";
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "cmd_search_activity_log") {
        return { rows: [{ id: 1, username: "hr.admin", role: "archive_admin", action: "DELETE_EMPLOYEE", target_type: "employee", target_id: 4,
          target_name: "رنا هادي", result: "Success", details: JSON.stringify({ employee: "رنا هادي" }), created_at: "2026-11-25 11:00:00" }],
          total: 1, users: ["hr.admin"], actions: ["DELETE_EMPLOYEE"] };
      }
      if (command === "cmd_export_activity_log") { window.exported = args; return; }
      return original(command, args);
    };
    document.body.insertAdjacentHTML("beforeend", `<div id="toast" class="opacity-0"><span id="toast-msg"></span></div>`);
  });
  await page.evaluate(async () => (await import("/src/screens/audit.js")).renderAudit(document.querySelector("#root")));
  await page.locator("#audit-export").click();
  await expect.poll(() => page.evaluate(() => window.exported?.rows?.[0])).toEqual([expect.stringMatching(/^2026\/11\/25 \d\d:00$/), "hr.admin", "مسؤول الأرشيف (سابقًا)", "حذف موظف", "الموظف: رنا هادي", "نجحت"]);
});
