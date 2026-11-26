import { test, expect } from "@playwright/test";

// Document archive (review of the archive screen). Synthetic data only: the harness mocks every backend command.
test.beforeEach(async ({ page }) => {
  await page.goto("/tests/scanner-harness.html");
  await page.waitForFunction(() => window.ready);
  await page.evaluate(() => {
    window.plainArchive = true;
    window.settings.enabled = false; // upload files as they are, without the scanner's choice dialog
    window.types = ["أمر إداري", "ترفيع", "تعميم"];
    document.body.insertAdjacentHTML("beforeend", `<div id="toast" class="opacity-0"><span id="toast-msg"></span></div>`);
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "cmd_get_document_types") return window.types;
      if (command === "cmd_set_document_types") { window.types = args.types; return args.types; }
      if (command === "cmd_update_general_doc" || command === "cmd_update_outgoing_doc") { window.calls.push({ command, args }); return { id: args.id, ...args.data }; }
      return original(command, args);
    };
  });
});

const doc = (id, extra = {}) => ({ id, title: `جهة ${id}`, doc_number: null, issue_date: "2026-01-01", issuer: "تعميم", doc_count: `${id}`, margin: null,
  is_internal_memo: false, notes: null, attachment_paths: [], employee_ids: [], employee_names: [], ...extra });
const count = (page, command) => page.evaluate(name => window.calls.filter(c => c.command === name).length, command);

test("a file that fails to upload does not lead to saving the document twice", async ({ page }) => {
  await page.evaluate(() => {
    window.docs = [];
    window.openQueue = [["C:/a.pdf", "C:/b.pdf"]];
    const original = window.__TAURI_INTERNALS__.invoke;
    let uploads = 0;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "cmd_create_general_doc") { window.calls.push({ command, args }); window.docs = [{ id: 2, ...args.data, attachment_paths: [], employee_names: [] }]; return window.docs[0]; }
      if (command === "cmd_upload_general_doc_file" && ++uploads === 2) throw "الملف أكبر من الحد المسموح";
      return original(command, args);
    };
  });
  await page.evaluate(() => window.renderActual("general"));
  await page.locator("#btn-add-first-doc").click();
  await page.locator("#d-title").fill("جهة تجريبية");
  await page.locator("#d-issuer").fill("أمر إداري");
  await page.locator("#d-count").fill("1/2");
  await page.locator("#d-manage-attachments").click();
  await expect(page.locator(".doc-pending-item")).toHaveCount(2);
  await page.locator("#btn-save-doc").click();
  await expect(page.locator("#doc-form-card .section-title")).toContainText("تعديل وثيقة");
  await expect(page.locator("#toast-msg")).toContainText("b.pdf");
  await expect(page.locator("#toast-msg")).toContainText("الملف أكبر من الحد المسموح");
  await page.locator("#d-margin").fill("للحفظ");
  await page.locator("#btn-save-doc").click();
  await expect.poll(() => count(page, "cmd_update_general_doc")).toBe(1);
  expect(await count(page, "cmd_create_general_doc")).toBe(1);
});

test("scanning into an existing document adds the file only and keeps the unsaved edits", async ({ page }) => {
  await page.evaluate(d => { window.docs = [d]; }, doc(1));
  await page.evaluate(() => window.renderActual("general"));
  await page.locator(".general-doc-row").first().click();
  await page.locator("#d-number").fill("تعديل لم يُحفظ");
  await page.locator("#d-scan-attachment").click();
  await expect.poll(() => count(page, "cmd_upload_general_doc_file")).toBe(1);
  expect(await count(page, "cmd_update_general_doc")).toBe(0);
  await expect(page.locator("#d-number")).toHaveValue("تعديل لم يُحفظ");
});

test("without the edit permission a document opens as a read-only page, and scanning still works", async ({ page }) => {
  await page.evaluate(d => {
    window.docs = [d];
    window.permissionsOverride = ["documents.view", "documents.upload", "documents.print"];
  }, doc(1, { employee_names: ["موظف تجريبي"], employee_ids: [1] }));
  await page.evaluate(() => window.renderActual("general"));
  await expect(page.locator("#btn-add-doc")).toHaveCount(0);
  await expect(page.locator(".general-doc-row").first()).toHaveAttribute("title", "اضغط لعرض الوثيقة");
  await page.locator(".general-doc-row").first().click();
  await expect(page.locator("#doc-form-card .section-title")).toHaveText("عرض وثيقة");
  await expect(page.locator("#doc-form-card input")).toHaveCount(0);
  await expect(page.locator(".doc-chip")).toHaveText(["موظف تجريبي"]);
  await page.locator("#d-scan-attachment").click();
  await expect.poll(() => count(page, "cmd_upload_general_doc_file")).toBe(1);
  expect(await count(page, "cmd_update_general_doc")).toBe(0);
});

test("the subject list narrows to what is typed, and a new subject joins it when the document is saved", async ({ page }) => {
  await page.evaluate(() => { window.docs = []; });
  await page.evaluate(() => window.renderActual("general"));
  await page.locator("#btn-add-first-doc").click();
  await page.locator("#d-issuer").click();
  await expect(page.locator(".doc-subject-pick")).toHaveCount(3);
  await page.locator("#d-issuer").fill("ترف");
  await expect(page.locator(".doc-subject-pick")).toHaveText(["ترفيع"]);
  await page.locator("#d-issuer").fill("كتاب شكر");
  await page.locator("#d-title").fill("جهة تجريبية");
  await page.locator("#d-count").fill("5");
  await page.locator("#btn-save-doc").click();
  await expect.poll(() => page.evaluate(() => window.types)).toContain("كتاب شكر");
});

test("«الصادر» asks for the receiver and fills in this unit as the sender", async ({ page }) => {
  await page.evaluate(() => { window.docs = []; });
  await page.evaluate(() => window.renderActual("outgoing"));
  await page.locator("#btn-add-first-doc").click();
  await expect(page.locator("#d-title")).toHaveValue("Test");
  await expect(page.locator("#d-required-hint")).toContainText("إلى");
  await expect(page.locator("#d-required-hint")).not.toContainText("الجهة المصدرة");
  // The note is quiet until a required field is left empty.
  await expect(page.locator("#d-required-hint")).not.toHaveClass(/is-error/);
  await page.locator("#d-number").focus();
  await page.locator("#d-count").focus();
  await expect(page.locator("#d-required-hint")).toHaveClass(/is-error/);
});

test("the list is sorted by issue date, newest first, and a header click sorts by that column", async ({ page }) => {
  await page.evaluate(([a, b, c]) => { window.docs = [a, b, c]; },
    [doc(1, { issue_date: "2026-03-01", title: "ب" }), doc(2, { issue_date: "2026-11-17", title: "ج" }), doc(3, { issue_date: "2025-12-30", title: "أ" })]);
  await page.evaluate(() => window.renderActual("general"));
  await expect(page.locator(".general-doc-row")).toHaveCount(3);
  await expect(page.locator(".general-doc-row td.doc-cell-date")).toHaveText(["2026/11/17", "2026/3/1", "2025/12/30"]);
  await page.locator('.doc-sort[data-key="title"]').click();
  await expect(page.locator(".general-doc-row td:first-child")).toHaveText(["أ", "ب", "ج"]);
});

test("many documents are split into pages of 50", async ({ page }) => {
  await page.evaluate(docs => { window.docs = docs; }, Array.from({ length: 120 }, (_, i) => doc(i + 1)));
  await page.evaluate(() => window.renderActual("general"));
  await expect(page.locator(".general-doc-row")).toHaveCount(50);
  await expect(page.locator(".doc-pager")).toContainText("صفحة 1 من 3");
  await page.locator("#doc-page-next").click();
  await page.locator("#doc-page-next").click();
  await expect(page.locator(".general-doc-row")).toHaveCount(20);
});
