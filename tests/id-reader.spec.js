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
    window.employeePatch = { residence_card_back_path: "Files/Employees/1/Documents/Residence/back.jpg", residence_card_back_full_path: "synthetic", residence_card_issuer: "مكتب 00", residence_form_no: "1111" };
    window.readResult = { document: "other", warnings: [], fields: [{ key: "doc_number", value: "1000001", confidence: 0.6, source: "text" }] };
  });
  await openDocuments(page);
  const tile = page.locator(".emp-tile.has-file", { has: page.locator('[data-target="employee:residence_card"]') });
  await tile.locator(".emp-tile-more").click();
  await tile.getByRole("menuitem", { name: "قراءة البيانات" }).click();
  await page.getByRole("dialog", { name: /قراءة البيانات/ }).getByRole("button", { name: "اعتماد المحدَّد" }).click();
  await expect(page.locator("#f-residence_card_no")).toHaveValue("1000001");
  // The handwritten fields are kept in the file too.
  await expect(page.locator("#f-residence_card_issuer")).toHaveValue("مكتب 00");
  await expect(page.locator("#f-residence_form_no")).toHaveValue("1111");
});

test("ration card: number from the QR code and the head of household", async ({ page }) => {
  await page.evaluate(() => {
    window.employeePatch = { ration_card_attachment_paths: JSON.stringify(["Files/Employees/1/Documents/Ration/card.jpg"]), ration_card_attachment_full_paths: ["synthetic"] };
    window.readResult = {
      document: "ration", warnings: [],
      fields: [
        { key: "ration_no", value: "0100000001", confidence: 0.99, source: "qr" },
        { key: "head_name", value: "أحمد علي حسين كاظم", confidence: 0.9, source: "text" },
      ],
    };
  });
  await openDocuments(page);
  const tile = page.locator(".emp-tile.has-file", { has: page.locator('[data-target="employee:ration_card"]') });
  await tile.locator(".emp-tile-more").click();
  await tile.getByRole("menuitem", { name: "قراءة البيانات" }).click();
  const dialog = page.getByRole("dialog", { name: /قراءة البيانات/ });
  await expect(dialog.locator(".id-reader-badge.is-ok")).toHaveCount(1);
  await dialog.getByRole("button", { name: "اعتماد المحدَّد" }).click();
  await expect(page.locator("#f-ration_card_no")).toHaveValue("0100000001");
  await expect(page.locator("#f-ration_center_name")).toHaveValue("أحمد علي حسين كاظم");
});

test("ministry badge: both sides are read and agreeing values are verified", async ({ page }) => {
  await page.evaluate(() => {
    window.employeePatch = {
      ministry_badge_front_path: "Files/Employees/1/Documents/Ministry/front.jpg", ministry_badge_front_full_path: "synthetic",
      ministry_badge_back_path: "Files/Employees/1/Documents/Ministry/back.jpg", ministry_badge_back_full_path: "synthetic",
    };
    const english = { document: "ministry_badge", warnings: [], fields: [
      { key: "doc_number", value: "100000001", confidence: 0.95, source: "text" },
      { key: "expiry_date", value: "2027-02-01", confidence: 0.95, source: "text" },
    ] };
    const arabic = { document: "ministry_badge", warnings: [], fields: [
      { key: "doc_number", value: "100000001", confidence: 0.93, source: "text" },
      { key: "expiry_date", value: "2027-02-02", confidence: 0.9, source: "text" },
      { key: "job_title", value: "مهندس أقدم", confidence: 0.95, source: "text" },
    ] };
    window.readResults = { "Files/Employees/1/Documents/Ministry/front.jpg": english, "Files/Employees/1/Documents/Ministry/back.jpg": arabic };
  });
  await openDocuments(page);
  const tile = page.locator(".emp-tile.has-file", { has: page.locator('[data-target="employee:ministry_badge"]') }).first();
  await tile.locator(".emp-tile-more").click();
  await tile.getByRole("menuitem", { name: "قراءة البيانات" }).click();
  const dialog = page.getByRole("dialog", { name: /قراءة البيانات/ });
  await expect(dialog.locator("tr", { hasText: "رقم الهوية" }).locator(".id-reader-badge.is-ok")).toHaveCount(1);
  await expect(dialog.locator(".id-reader-warning", { hasText: "تاريخ النفاذ" })).toBeVisible();
  await dialog.getByRole("button", { name: "اعتماد المحدَّد" }).click();
  await expect(page.locator("#f-ministry_badge_no")).toHaveValue("100000001");
  expect((await page.evaluate(() => window.calls.filter(c => c.command === "cmd_read_document_fields").map(c => c.args.relativePath))).sort())
    .toEqual(["Files/Employees/1/Documents/Ministry/back.jpg", "Files/Employees/1/Documents/Ministry/front.jpg"]);
});

test("airport badge: access zones are read into chips, edited, and saved", async ({ page }) => {
  await page.evaluate(() => {
    window.employeePatch = { airport_badge_front_path: "Files/Employees/1/Documents/Airport/badge.jpg", airport_badge_front_full_path: "synthetic", airport_badge_zones: null };
    window.readResult = { document: "airport_badge", warnings: [], fields: [
      { key: "expiry_date", value: "2028-02-01", confidence: 0.95, source: "text" },
      { key: "zones", value: "S1,T,VIP,C", confidence: 0.95, source: "text" },
    ] };
  });
  await openDocuments(page);
  const tile = page.locator(".emp-tile.has-file", { has: page.locator('[data-target="employee:airport_badge"]') });
  await tile.locator(".emp-tile-more").click();
  await tile.getByRole("menuitem", { name: "قراءة البيانات" }).click();
  const dialog = page.getByRole("dialog", { name: /قراءة البيانات/ });
  await expect(dialog.locator("tr", { hasText: "صلاحيات الباج" }).locator(".id-reader-value")).toHaveValue("S1,T,VIP,C");
  await dialog.getByRole("button", { name: "اعتماد المحدَّد" }).click();
  const chips = page.locator(".emp-zone-chip");
  await expect(chips).toHaveText(["S1×", "T×", "VIP×", "C×"]);
  await page.getByRole("button", { name: "حذف T" }).click();
  await page.locator(".emp-zone-input").fill("s2");
  await page.locator(".emp-zone-input").press("Enter");
  await expect(chips).toHaveText(["S1×", "VIP×", "C×", "S2×"]);
  await expect(page.locator("#f-airport_badge_zones")).toHaveValue("S1,VIP,C,S2");
  await page.locator("#panel-save").click();
  await page.getByRole("button", { name: "تأكيد", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.calls.some(c => c.command === "cmd_update_employee"))).toBe(true);
  const data = await page.evaluate(() => window.calls.find(c => c.command === "cmd_update_employee").args.data);
  expect(data.airport_badge_zones).toBe("S1,VIP,C,S2");
});

test("car registration: both sides fill the vehicle row and keep the images on save", async ({ page }) => {
  const front = "Files/Employees/1/Vehicles/1/Annual/front.jpg";
  const back = "Files/Employees/1/Vehicles/1/Annual/back.jpg";
  await page.evaluate(({ front, back }) => {
    window.employeePatch = { vehicles: JSON.stringify([{ plate: "", annual_front_path: front, annual_back_path: back, annual_front_full_path: "synthetic", annual_back_full_path: "synthetic" }]) };
    window.readResults = {
      [front]: { document: "vehicle_registration", warnings: [], fields: [
        { key: "plate", value: "12 A34567", confidence: 0.6, source: "text" },
        { key: "governorate", value: "نينوى", confidence: 0.6, source: "text" },
        { key: "plate_category", value: "خصوصي", confidence: 0.9, source: "text" },
        { key: "annual_no", value: "X12345678", confidence: 0.99, source: "mrz" },
        { key: "issue_date", value: "2025-02-03", confidence: 0.9, source: "text" },
        { key: "expiry_date", value: "2030-02-02", confidence: 0.9, source: "text" },
      ] },
      [back]: { document: "vehicle_registration", warnings: [], fields: [
        { key: "brand", value: "تويوتا", confidence: 0.95, source: "text" },
        { key: "vehicle_type", value: "كامري", confidence: 0.95, source: "text" },
        { key: "color", value: "أبيض", confidence: 0.95, source: "text" },
        { key: "year", value: "2022", confidence: 0.95, source: "text" },
        { key: "chassis_no", value: "ABCDE1234567890XY", confidence: 0.99, source: "both" },
      ] },
    };
  }, { front, back });
  await page.evaluate(() => window.renderActual("employees"));
  await page.locator('.table-row[data-id="1"]').click();
  await page.locator('.tab-btn[data-tab="vehicle"]').click();
  const row = page.locator(".vehicle-row").first();
  if (!(await row.locator(".vehicle-brand").isVisible())) await row.locator(".emp-row-title").click();
  const tile = row.locator(".emp-tile.has-file").first();
  await tile.locator(".emp-tile-more").click();
  await tile.getByRole("menuitem", { name: "قراءة البيانات" }).click();
  const dialog = page.getByRole("dialog", { name: /قراءة البيانات/ });
  await expect(dialog.locator("tr", { hasText: "رقم السنوية" }).locator(".id-reader-badge.is-ok")).toHaveCount(1);
  await expect(dialog.locator("tr", { hasText: "رقم اللوحة" })).toHaveClass(/is-low/);
  await expect(dialog.locator("tr", { hasText: "رقم اللوحة" }).locator(".id-reader-value")).toHaveAttribute("dir", "auto");
  await dialog.getByRole("button", { name: "اعتماد المحدَّد" }).click();
  await expect(dialog).toBeHidden();
  await expect(row.locator(".vehicle-brand")).toHaveValue("تويوتا");
  await expect(row.locator(".vehicle-annual-no")).toHaveValue("X12345678");
  await expect(row.locator(".vehicle-plate")).toHaveValue("12 A34567");
  await expect(row.locator(".vehicle-plate")).toHaveAttribute("dir", "auto");
  await expect(row.locator(".vehicle-governorate")).toHaveValue("نينوى");
  await expect(row.locator(".vehicle-plate-category")).toHaveValue("خصوصي");
  await expect(row.locator(".vehicle-chassis")).toHaveValue("ABCDE1234567890XY");
  await expect(row.locator(".vehicle-model-year")).toHaveValue("2022");
  await expect(row.locator(".vehicle-expiry-date")).toHaveValue("2030-02-02");
  await page.locator("#panel-save").click();
  await page.getByRole("button", { name: "تأكيد", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.calls.some(c => c.command === "cmd_update_employee"))).toBe(true);
  const data = await page.evaluate(() => window.calls.find(c => c.command === "cmd_update_employee").args.data);
  const [vehicle] = JSON.parse(data.vehicles);
  expect(vehicle).toMatchObject({ brand: "تويوتا", type: "كامري", color: "أبيض", annual_no: "X12345678", issue_date: "2025-02-03", governorate: "نينوى", chassis_no: "ABCDE1234567890XY", model_year: "2022", annual_front_path: front, annual_back_path: back });
});

test("save keeps the panel open on the same tab", async ({ page }) => {
  await page.evaluate(() => window.renderActual("employees"));
  await page.locator('.table-row[data-id="1"]').click();
  await page.locator('.tab-btn[data-tab="vehicle"]').click();
  await page.locator("#btn-add-vehicle").click();
  await page.locator(".vehicle-row .vehicle-plate").first().fill("TEST 1");
  await page.locator("#panel-save").click();
  await page.getByRole("button", { name: "تأكيد", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.calls.some(c => c.command === "cmd_update_employee"))).toBe(true);
  await expect(page.locator('.tab-btn[data-tab="vehicle"]')).toHaveCSS("font-weight", "700");
  await expect(page.locator("#emp-panel")).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
  await expect(page.locator("#btn-add-vehicle")).toBeVisible();
});

test("a new vehicle's registration image: + رفع saves, then uploads to the saved row", async ({ page }) => {
  await page.evaluate(() => { window.applySaves = true; window.renderActual("employees"); });
  await page.locator('.table-row[data-id="1"]').click();
  await page.locator('.tab-btn[data-tab="vehicle"]').click();
  await page.locator("#btn-add-vehicle").click();
  const row = page.locator(".vehicle-row").first();
  await row.locator(".vehicle-plate").fill("TEST 2");
  await row.locator(".btn-save-then-upload").first().click();
  await page.getByRole("button", { name: "تأكيد", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.calls.some(c => c.command === "cmd_update_employee"))).toBe(true);
  // The upload continues on the saved row: confirm it, then upload the original file.
  await page.getByRole("button", { name: "تأكيد", exact: true }).click();
  await page.getByRole("button", { name: "رفع بالطريقة المعتادة" }).click();
  await expect.poll(() => page.evaluate(() => window.calls.find(c => c.command === "cmd_upload_vehicle_annual_attachment")?.args)).toMatchObject({ employeeId: 1, vehicleIndex: 0, side: "front" });
  await expect(page.locator('.tab-btn[data-tab="vehicle"]')).toHaveCSS("font-weight", "700");
});

test("badge zones: the usual codes, C included, are added with one click", async ({ page }) => {
  await page.evaluate(() => { window.employeePatch = { airport_badge_zones: "S1,T" }; });
  await openDocuments(page);
  const quick = page.locator(".emp-zone-add");
  await expect(quick).toHaveText(["+ VIP", "+ C"]);
  await page.click('.emp-zone-add[data-zone="C"]');
  await expect(page.locator("#f-airport_badge_zones")).toHaveValue("S1,T,C");
  await expect(quick).toHaveText(["+ VIP"]);
});
