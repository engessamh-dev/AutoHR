import { test, expect } from "@playwright/test";

// Synthetic data only: the harness mocks every backend command, including the image reader.
const f = (key, value, confidence = 0.95, source = "text") => ({ key, value, confidence, source });

test.beforeEach(async ({ page }) => {
  await page.goto("/tests/scanner-harness.html");
  await page.waitForFunction(() => window.ready);
  await page.evaluate(reads => { window.imageReads = reads; }, {
    "front.jpg": { document: "national_front", warnings: [], fields: [f("first", "سامر"), f("father", "خالد"), f("grandfather", "عبد الله"), f("surname", "الجبوري"), f("gender", "ذكر", 0.99), f("national_no", "199000000001", 0.99, "mrz")] },
    "back.jpg": { document: "national_back", warnings: [], fields: [f("birthdate", "1985-03-14", 0.99, "mrz"), f("birthplace", "بغداد"), f("expiry_date", "2031-06-02")] },
    "airport.jpg": { document: "airport_badge", warnings: [], fields: [f("doc_number", "BGW-00456"), f("job_title", "مهندس اتصالات"), f("zones", "S1,T,VIP")] },
    "ministry.jpg": { document: "ministry_badge", warnings: [], fields: [f("doc_number", "MT-000123"), f("job_title", "مهندس")] },
  });
  await page.evaluate(() => window.renderActual("employees"));
  await page.click("#btn-add-emp");
});

async function pick(page, step, file, side = "front") {
  await page.evaluate(path => { window.openQueue = [path]; }, file);
  await page.click(`[data-pick="${step}"][data-side="${side}"]`);
  await expect.poll(() => page.evaluate(path => window.calls.some(c => c.command === "cmd_read_image_fields" && c.args.sourcePath === path), file)).toBe(true);
}

test("manual entry opens the existing form", async ({ page }) => {
  await page.click('[data-choice="manual"]');
  await expect(page.locator(".aw-overlay")).toHaveCount(0);
  await expect(page.locator("#panel-save")).toBeVisible();
});

test("national card is required, values are read and tagged by source", async ({ page }) => {
  await page.click('[data-choice="docs"]');
  await expect(page.locator("[data-next]")).toBeDisabled();
  await pick(page, "national", "front.jpg");
  await pick(page, "national", "back.jpg", "back");
  await expect(page.locator("[data-next]")).toBeEnabled();
  await expect(page.locator('[data-key="birthdate"]')).toHaveValue("1985-03-14");
  await expect(page.locator('[data-key="full_name"][data-part="first"]')).toHaveValue("سامر");
  // An edit is tagged as manual.
  await page.fill('[data-key="birthplace"]', "البصرة");
  await expect(page.locator('.aw-field:has([data-key="birthplace"]) .aw-src')).toHaveText(/معدّل يدويًا/);
});

test("a later document does not overwrite an earlier value; the conflict can be taken", async ({ page }) => {
  await page.click('[data-choice="docs"]');
  await pick(page, "national", "front.jpg");
  await page.click("[data-next]");
  await page.click("[data-skip]");
  await pick(page, "ministry", "ministry.jpg");
  await page.click("[data-next]");
  await pick(page, "airport", "airport.jpg");
  await expect(page.locator('[data-key="job_title"]')).toHaveValue("مهندس");
  await expect(page.locator(".aw-chip")).toHaveCount(3);
  await page.locator('[data-take="job_title"]').click();
  await expect(page.locator('[data-key="job_title"]')).toHaveValue("مهندس اتصالات");
});

test("save creates the employee with family relations, then uploads each image", async ({ page }) => {
  await page.click('[data-choice="docs"]');
  await pick(page, "national", "front.jpg");
  await pick(page, "national", "back.jpg", "back");
  await page.click("[data-next]");
  for (let i = 0; i < 5; i++) await page.click("[data-skip]");
  await page.click('[data-member-add="manual"]');
  await page.selectOption('[data-relation="0"]', "son");
  await page.click("[data-next]");
  await page.fill('[data-key="phone"]', "07700000000");
  await page.click("[data-save]");
  await expect.poll(() => page.evaluate(() => window.calls.some(c => c.command === "cmd_create_employee"))).toBe(true);
  const data = await page.evaluate(() => window.calls.find(c => c.command === "cmd_create_employee").args.data);
  expect(data.full_name).toBe("سامر خالد عبد الله الجبوري");
  expect(data.phone).toBe("07700000000");
  expect(data.civil_id_birthdate).toBe("1985-03-14");
  const family = JSON.parse(data.family_members);
  expect(family[0].relation).toBe("ابن");
  expect(family[0].name_parts.name).toMatchObject({ father: "سامر", grandfather: "خالد", surname: "الجبوري" });
  await expect.poll(() => page.evaluate(() => window.calls.filter(c => c.command === "cmd_upload_national_card_attachment").map(c => c.args.side))).toEqual(["front", "back"]);
});

test("an enlarged image closes with the × button, Esc, or a click outside it", async ({ page }) => {
  await page.click('[data-choice="docs"]');
  await pick(page, "national", "front.jpg");
  const viewer = page.locator(".aw-viewer");
  await page.locator(".aw-thumb img").first().click();
  await expect(viewer).toBeVisible();
  await viewer.getByRole("button", { name: "إغلاق الصورة" }).click();
  await expect(viewer).toHaveCount(0);
  await page.locator(".aw-thumb img").first().click();
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  // Esc closed only the image, not the wizard.
  await expect(page.locator(".aw-overlay")).toBeVisible();
  await page.locator(".aw-thumb img").first().click();
  await viewer.click({ position: { x: 5, y: 5 } });
  await expect(viewer).toHaveCount(0);
});
