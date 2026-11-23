import { test, expect } from "@playwright/test";

// Synthetic data only: the harness mocks every backend command, including the text reader.
test.beforeEach(async ({ page }) => { await page.goto("/tests/scanner-harness.html"); await page.waitForFunction(() => window.ready); });

const field = (key, value, confidence = 0.95, source = "text") => ({ key, value, confidence, source });

async function openDocuments(page) {
  await page.evaluate(() => window.renderActual("employees"));
  await page.locator('.table-row[data-id="1"]').click();
  await page.locator('.tab-btn[data-tab="documents"]').click();
  await page.locator('[data-sections-all="open"]').first().click();
}

test("national card values are reviewed, then fill the form without saving", async ({ page }) => {
  await page.evaluate(() => {
    window.readResult = {
      document: "national",
      warnings: [],
      fields: [
        { key: "first", value: "أحمد", confidence: 0.95, source: "text" },
        { key: "father", value: "علي", confidence: 0.95, source: "text" },
        { key: "grandfather", value: "حسين", confidence: 0.7, source: "text" },
        { key: "surname", value: "الربيعي", confidence: 0.95, source: "text" },
        { key: "gender", value: "ذكر", confidence: 0.99, source: "mrz" },
        { key: "national_no", value: "100000000001", confidence: 0.99, source: "mrz" },
        { key: "issue_date", value: "2020-01-02", confidence: 0.9, source: "text" },
        { key: "blood_type", value: "O+", confidence: 0.9, source: "text" },
      ],
    };
  });
  await openDocuments(page);
  const tile = page.locator(".emp-tile.has-file").first();
  await tile.locator(".emp-tile-more").click();
  await tile.getByRole("menuitem", { name: "قراءة البيانات" }).click();
  const dialog = page.getByRole("dialog", { name: /قراءة البيانات/ });
  await expect(dialog).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.calls.find(c => c.command === "cmd_read_document_fields")?.args)).toEqual({ relativePath: "Files/Employees/1/Documents/NationalCard/card.jpg" });
  // The old name ("Synthetic Employee") differs from the read parts: not picked until the user decides.
  const firstRow = dialog.locator("tr", { hasText: "الاسم" }).first();
  const fatherRow = dialog.locator("tr", { hasText: "اسم الأب" });
  await expect(firstRow.locator(".id-reader-pick")).not.toBeChecked();
  await expect(fatherRow.locator(".id-reader-pick")).not.toBeChecked();
  await expect(dialog.locator("tr", { hasText: "رقم البطاقة الوطنية" }).locator(".id-reader-pick")).toBeChecked();
  await expect(dialog.locator("tr.is-low")).toHaveCount(1);
  await expect(dialog.locator(".id-reader-badge.is-ok")).toHaveCount(2);
  await firstRow.locator(".id-reader-pick").check();
  await fatherRow.locator(".id-reader-pick").check();
  await dialog.locator("tr", { hasText: "فصيلة الدم" }).locator(".id-reader-pick").uncheck();
  await dialog.getByRole("button", { name: "اعتماد المحدَّد" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#f-civil_id")).toHaveValue("100000000001");
  await expect(page.locator("#f-civil_id_issue_date")).toHaveValue("2020-01-02");
  expect(await page.evaluate(() => window.calls.some(c => c.command === "cmd_update_employee"))).toBe(false);
  await page.locator("#panel-save").click();
  await page.getByRole("button", { name: "تأكيد", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.calls.some(c => c.command === "cmd_update_employee"))).toBe(true);
  const data = await page.evaluate(() => window.calls.find(c => c.command === "cmd_update_employee").args.data);
  expect(data.full_name).toBe("أحمد علي حسين الربيعي");
  expect(data.name_parts.full_name).toEqual({ first: "أحمد", father: "علي", grandfather: "حسين", surname: "الربيعي", review: false });
  expect(data.civil_id).toBe("100000000001");
  expect(data.blood_type ?? null).toBe(null);
});

test("passport values fill the passport section and the Latin name", async ({ page }) => {
  await page.evaluate(() => {
    window.readResult = {
      document: "passport",
      warnings: [],
      fields: [
        { key: "passport_no", value: "X00000001", confidence: 0.99, source: "mrz" },
        { key: "passport_type", value: "P", confidence: 0.95, source: "mrz" },
        { key: "expiry_date", value: "2031-12-12", confidence: 0.99, source: "mrz" },
        { key: "latin_given", value: "AHMED ALI", confidence: 0.9, source: "mrz" },
        { key: "latin_surname", value: "TESTER", confidence: 0.9, source: "mrz" },
      ],
    };
  });
  await openDocuments(page);
  // After the upload the list returns the stored passport image.
  await page.evaluate(() => {
    window.employeePatch = { passport_attachment_paths: JSON.stringify(["Files/Employees/1/Documents/Passport/passport.jpg"]), passport_attachment_full_paths: ["synthetic"] };
  });
  await page.locator("#btn-upload-passport").click();
  await page.getByRole("button", { name: "تأكيد", exact: true }).click();
  await page.getByRole("button", { name: "رفع بالطريقة المعتادة" }).click();
  const dialog = page.getByRole("dialog", { name: /قراءة البيانات/ });
  await expect(dialog).toBeVisible({ timeout: 10000 });
  expect(await page.evaluate(() => window.calls.find(c => c.command === "cmd_read_document_fields").args)).toEqual({ relativePath: "Files/Employees/1/Documents/Passport/passport.jpg" });
  await dialog.getByRole("button", { name: "اعتماد المحدَّد" }).click();
  await expect(page.locator("#f-passport_no")).toHaveValue("X00000001");
  await expect(page.locator("#f-passport_expiry_date")).toHaveValue("2031-12-12");
  const latin = page.locator('.name-fields[data-name-key="passport_name"]');
  await expect(latin.locator('.name-part[data-part="given"]')).toHaveValue("AHMED ALI");
  await expect(latin.locator('.name-part[data-part="surname"]')).toHaveValue("TESTER");
});

test("nothing read: a clear message and no dialog", async ({ page }) => {
  await openDocuments(page);
  const tile = page.locator(".emp-tile.has-file").first();
  await tile.locator(".emp-tile-more").click();
  await tile.getByRole("menuitem", { name: "قراءة البيانات" }).click();
  await expect.poll(() => page.evaluate(() => window.calls.some(c => c.command === "cmd_read_document_fields"))).toBe(true);
  await expect(page.locator(".id-reader")).toHaveCount(0);
});

test("badge: number and dates fill the badge section", async ({ page }) => {
  await page.evaluate(() => {
    window.employeePatch = { airport_badge_front_path: "Files/Employees/1/Documents/Airport/badge.jpg", airport_badge_front_full_path: "synthetic" };
    window.readResult = {
      document: "other",
      warnings: ["تخمين"],
      fields: [
        { key: "doc_number", value: "004512", confidence: 0.6, source: "text" },
        { key: "issue_date", value: "2024-01-10", confidence: 0.6, source: "text" },
        { key: "expiry_date", value: "2026-01-09", confidence: 0.6, source: "text" },
      ],
    };
  });
  await openDocuments(page);
  const tile = page.locator(".emp-tile.has-file", { has: page.locator('[data-target="employee:airport_badge"]') });
  await tile.locator(".emp-tile-more").click();
  await tile.getByRole("menuitem", { name: "قراءة البيانات" }).click();
  const dialog = page.getByRole("dialog", { name: /قراءة البيانات/ });
  await expect(dialog.locator("tr.is-low")).toHaveCount(3);
  await dialog.getByRole("button", { name: "اعتماد المحدَّد" }).click();
  await expect(page.locator("#f-airport_badge_no")).toHaveValue("004512");
  await expect(page.locator("#f-airport_badge_expiry")).toHaveValue("2026-01-09");
});

test("residence card: the printed serial fills the card number", async ({ page }) => {
  await page.evaluate(() => {
    window.employeePatch = { residence_card_back_path: "Files/Employees/1/Documents/Residence/back.jpg", residence_card_back_full_path: "synthetic" };
    window.readResult = { document: "other", warnings: [], fields: [{ key: "doc_number", value: "1000001", confidence: 0.6, source: "text" }] };
  });
  await openDocuments(page);
  const tile = page.locator(".emp-tile.has-file", { has: page.locator('[data-target="employee:residence_card"]') });
  await tile.locator(".emp-tile-more").click();
  await tile.getByRole("menuitem", { name: "قراءة البيانات" }).click();
  await page.getByRole("dialog", { name: /قراءة البيانات/ }).getByRole("button", { name: "اعتماد المحدَّد" }).click();
  await expect(page.locator("#f-residence_card_no")).toHaveValue("1000001");
});
