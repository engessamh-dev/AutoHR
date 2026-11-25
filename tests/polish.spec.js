import { test, expect } from "@playwright/test";

// 1.0.5 polish: attachment viewer, document form, empty archive, name review, storage warning.
// Synthetic data only: the harness mocks every backend command.
test.beforeEach(async ({ page }) => { await page.goto("/tests/scanner-harness.html"); await page.waitForFunction(() => window.ready); });

async function openNationalCardViewer(page) {
  await page.evaluate(() => window.renderActual("employees"));
  await page.locator('.table-row[data-id="1"]').click();
  await page.locator('.tab-btn[data-tab="documents"]').click();
  await page.locator('[data-sections-all="open"]').first().click();
  await page.locator(".emp-tile-thumb img").first().click();
  return page.locator(".emp-viewer");
}

test("attachment viewer zooms, rotates and fits back", async ({ page }) => {
  const viewer = await openNationalCardViewer(page);
  await expect(viewer).toBeVisible();
  const img = viewer.locator(".zv-img");
  await expect(img).toBeVisible();
  const fitWidth = await img.evaluate(el => el.getBoundingClientRect().width);
  await viewer.locator(".zv-zoom-in").click();
  await viewer.locator(".zv-zoom-in").click();
  expect(await img.evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(fitWidth * 1.2);
  await viewer.locator(".zv-rotate-right").click();
  await expect(img).toHaveAttribute("style", /rotate\(90deg\)/);
  await viewer.locator(".zv-fit").click();
  await page.keyboard.press("r");
  await expect(img).toHaveAttribute("style", /rotate\(180deg\)/);
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
});

test("attachment viewer steps between the attachments of the tab", async ({ page }) => {
  await page.evaluate(() => {
    // A second image attachment (back side) so there is something to step to.
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      const result = await original(command, args);
      if (command === "cmd_list_employees") return result.map(e => ({ ...e, civil_id_back_path: "Files/Employees/1/Documents/NationalCard/back.jpg", civil_id_back_full_path: "synthetic" }));
      return result;
    };
  });
  const viewer = await openNationalCardViewer(page);
  await expect(viewer.locator(".emp-viewer-count")).toHaveText(/^1 \/ \d+$/);
  await expect(viewer.locator(".emp-viewer-title")).toContainText("الوجه الأمامي");
  await viewer.locator(".emp-viewer-next").click();
  await expect(viewer.locator(".emp-viewer-count")).toHaveText(/^2 \/ \d+$/);
  await expect(viewer.locator(".emp-viewer-title")).toContainText("الوجه الخلفي");
  await page.keyboard.press("ArrowRight");
  await expect(viewer.locator(".emp-viewer-count")).toHaveText(/^1 \/ \d+$/);
  await expect(viewer.locator(".emp-viewer-prev")).toBeDisabled();
});

test("archive preview of an image has zoom and rotate", async ({ page }) => {
  await page.evaluate(() => window.renderActual("general"));
  await page.locator(".att-act-preview").first().click();
  await expect(page.locator("#document-preview-tools .zv-zoom-in")).toBeVisible();
  await page.locator("#document-preview-tools .zv-rotate-right").click();
  await expect(page.locator("#document-preview-body .zv-img")).toHaveAttribute("style", /rotate\(90deg\)/);
});

test("empty archive offers «إضافة أول وثيقة», and the new form defaults to today with attachments added before saving", async ({ page }) => {
  await page.evaluate(() => { window.docs = []; window.plainArchive = true; });
  await page.evaluate(() => window.renderActual("general"));
  const first = page.getByRole("button", { name: "+ إضافة أول وثيقة" });
  await expect(first).toBeVisible();
  await first.click();
  const today = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; });
  await expect(page.locator("#d-date")).toHaveValue(today);
  // Two columns on a wide window: the issuer and the subject sit side by side.
  const [a, b] = await Promise.all(["#d-title", "#d-issuer"].map(s => page.locator(s).boundingBox()));
  expect(Math.abs(a.y - b.y)).toBeLessThan(4);
  await page.locator("#d-manage-attachments").click();
  await expect(page.locator(".doc-pending-item")).toHaveCount(1);
  await expect(page.locator("#d-manage-attachments [dir='ltr']")).toHaveText("1");
  await page.locator(".doc-pending-remove").click();
  await expect(page.locator(".doc-pending-item")).toHaveCount(0);
  await page.locator("#d-manage-attachments").click();
  await page.locator("#d-title").fill("جهة تجريبية");
  await page.locator("#d-issuer").fill("أمر إداري");
  await page.locator("#d-count").fill("230/547");
  await page.locator("#btn-save-doc").click();
  await page.getByRole("button", { name: "تأكيد", exact: true }).click();
  // Images ask whether to upload as-is or process first, as with any archive upload.
  await page.locator('[data-choice="original"]').click();
  await expect.poll(() => page.evaluate(() => window.calls.some(c => c.command === "cmd_upload_general_doc_file"))).toBe(true);
  const created = await page.evaluate(() => window.calls.find(c => c.command === "cmd_create_general_doc").args.data);
  expect(created.issue_date).toBe(today);
  const upload = await page.evaluate(() => window.calls.find(c => c.command === "cmd_upload_general_doc_file").args);
  expect(upload).toEqual({ docId: 2, sourcePath: "synthetic.png" });
});

test("open employee panel leaves the name column visible and marks the row", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 850 });
  await page.evaluate(() => window.renderActual("employees"));
  await page.locator('.table-row[data-id="1"]').click();
  const row = page.locator('.table-row[data-id="1"]');
  await expect(row).toHaveClass(/is-selected/);
  await expect.poll(async () => {
    const [cell, panel] = await Promise.all([row.locator("td").first().boundingBox(), page.locator("#emp-panel").boundingBox()]);
    return cell.x + cell.width <= panel.x + 1;
  }).toBe(true);
});

test("name review: «اعتماد الكل» confirms every suggested split", async ({ page }) => {
  await page.evaluate(() => {
    const parts = { first: "أحمد", father: "علي", grandfather: "حسين", surname: "كاظم الجبوري", review: true };
    window.nameReview = [
      { employee_id: 1, employee_name: "Synthetic Employee", owner: "employee", index: 0, field: "full_name", text: "أحمد علي حسين كاظم الجبوري", original_text: "", parts },
      { employee_id: 1, employee_name: "Synthetic Employee", owner: "employee", index: 0, field: "mother_name", text: "زينب علي حسين", original_text: "", parts: { first: "زينب", father: "علي", grandfather: "حسين", surname: "", review: true } },
    ];
  });
  await page.evaluate(() => window.renderActual("employees"));
  await expect(page.locator("#btn-name-review .btn-review-count")).toHaveText("2");
  await page.locator("#btn-name-review").click();
  await page.locator("#name-review-accept-all").click();
  await page.getByRole("button", { name: "تأكيد", exact: true }).last().click();
  await expect(page.getByText("لا توجد أسماء بحاجة لمراجعة.")).toBeVisible();
  const saved = await page.evaluate(() => window.calls.filter(c => c.command === "cmd_save_name_review").map(c => c.args));
  expect(saved).toHaveLength(2);
  expect(saved[0].parts).toEqual({ first: "أحمد", father: "علي", grandfather: "حسين", surname: "كاظم الجبوري", review: false });
});

test("employee panel: «اعتماد التقسيم» confirms the split name in one click", async ({ page }) => {
  await page.evaluate(() => {
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      const result = await original(command, args);
      if (command === "cmd_list_employees") return result.map(e => ({ ...e, full_name: "علي حسن كاظم الربيعي", name_parts: JSON.stringify({ full_name: { first: "علي", father: "حسن", grandfather: "كاظم", surname: "الربيعي", review: true } }) }));
      return result;
    };
  });
  await page.evaluate(() => window.renderActual("employees"));
  await page.locator('.table-row[data-id="1"]').click();
  const full = page.locator('.name-fields[data-name-key="full_name"]').first();
  await expect(full.locator(".name-review-badge")).toBeVisible();
  await full.locator(".name-review-accept").click();
  await expect(full.locator(".name-review-badge")).toBeHidden();
  await expect(full.locator(".name-review-accept")).toBeHidden();
  await page.locator("#panel-save").click();
  await page.getByRole("button", { name: "تأكيد", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.calls.some(c => c.command === "cmd_update_employee"))).toBe(true);
  const data = await page.evaluate(() => window.calls.find(c => c.command === "cmd_update_employee").args.data);
  expect(data.name_parts.full_name.review).toBe(false);
});

test("storage warning hides with «حسنًا» and comes back when a folder changes", async ({ page }) => {
  const warning = "مجلد البيانات ومجلد النسخ الاحتياطية على نفس القرص.";
  await page.evaluate(w => { localStorage.clear(); window.storageStatus = { data_root: "D:\\Data", backup_root: "D:\\Backups", warnings: [w] }; }, warning);
  const open = async () => { await page.evaluate(() => window.renderActual("settings")); await page.locator('[data-settings-tab="storage"]').click(); };
  await open();
  await expect(page.getByText(warning)).toBeVisible();
  await page.getByRole("button", { name: "حسنًا" }).click();
  await expect(page.getByText(warning)).toHaveCount(0);
  await open();
  await expect(page.getByText(warning)).toHaveCount(0);
  await page.evaluate(() => { window.storageStatus = { ...window.storageStatus, backup_root: "D:\\Other" }; });
  await open();
  await expect(page.getByText(warning)).toBeVisible();
});

test("archive list deletes a document from its row without opening it", async ({ page }) => {
  await page.evaluate(() => {
    window.plainArchive = true;
    window.docs = [
      { id: 1, title: "Synthetic Document", attachment_paths: ["Files/GeneralDocs/1/a.jpg"], employee_ids: [] },
      { id: 7, title: "", attachment_paths: ["Files/GeneralDocs/7/a.jpg", "Files/GeneralDocs/7/b.jpg"], employee_ids: [] },
    ];
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "cmd_delete_general_doc" || command === "cmd_delete_outgoing_doc") {
        window.calls.push({ command, args });
        window.docs = window.docs.filter(d => d.id !== args.id);
        return;
      }
      return original(command, args);
    };
  });
  await page.evaluate(() => window.renderActual("general"));
  await expect(page.locator(".general-doc-row")).toHaveCount(2);
  await page.locator('.doc-row-delete[data-id="7"]').click();
  // The confirmation names the empty row and its attachments; the form never opens.
  await expect(page.getByRole("alertdialog")).toContainText("بدون بيانات");
  await expect(page.getByRole("alertdialog")).toContainText("مرفقان");
  await expect(page.locator("#btn-save-doc")).toHaveCount(0);
  await page.getByRole("button", { name: "إلغاء" }).click();
  expect(await page.evaluate(() => window.calls.some(c => c.command === "cmd_delete_general_doc"))).toBe(false);
  await page.locator('.doc-row-delete[data-id="7"]').click();
  await page.getByRole("button", { name: "تأكيد", exact: true }).click();
  await expect(page.locator(".general-doc-row")).toHaveCount(1);
  const deleted = await page.evaluate(() => window.calls.filter(c => c.command === "cmd_delete_general_doc").map(c => c.args));
  expect(deleted).toEqual([{ id: 7 }]);
});

test("archive list hides the row delete button without «documents.delete»", async ({ page }) => {
  await page.evaluate(() => {
    window.plainArchive = true;
    window.permissionsOverride = ["documents.view", "documents.manage", "documents.upload"];
  });
  await page.evaluate(() => window.renderActual("general"));
  await expect(page.locator(".general-doc-row")).toHaveCount(1);
  await expect(page.locator(".doc-row-delete")).toHaveCount(0);
});

test("document form will not save until the issuer, subject, number and date are filled", async ({ page }) => {
  await page.evaluate(() => { window.docs = []; window.plainArchive = true; });
  await page.evaluate(() => window.renderActual("general"));
  await page.getByRole("button", { name: "+ إضافة أول وثيقة" }).click();
  const save = page.locator("#btn-save-doc");
  const hint = page.locator("#d-required-hint");
  await expect(save).toBeDisabled();
  await expect(hint).toHaveText("لحفظ الوثيقة أكمل: الجهة المصدرة للوثيقة، الموضوع، العدد");
  await page.locator("#d-title").fill("مركز الوزارة");
  await page.locator("#d-issuer").fill("أمر إداري");
  await expect(hint).toHaveText("لحفظ الوثيقة أكمل: العدد");
  await page.locator("#d-count").fill("230/547");
  await page.locator("#d-date").fill("");
  await expect(hint).toHaveText("لحفظ الوثيقة أكمل: تاريخ الإصدار");
  await expect(save).toBeDisabled();
  await page.locator("#d-date").fill("2026-11-25");
  await expect(save).toBeEnabled();
  await expect(hint).toBeHidden();
  expect(await page.evaluate(() => window.calls.some(c => c.command === "cmd_create_general_doc"))).toBe(false);
});
