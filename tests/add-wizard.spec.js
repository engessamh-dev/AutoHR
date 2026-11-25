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
  await expect(viewer).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  // Esc closed only the image, not the wizard.
  await expect(page.locator(".aw-overlay")).toBeVisible();
  await page.locator(".aw-thumb img").first().click();
  await expect(viewer).toBeVisible();
  await viewer.click({ position: { x: 5, y: 5 } });
  await expect(viewer).toHaveCount(0);
});

test("the enlarged image zooms with the mouse wheel and moves by dragging", async ({ page }) => {
  await page.click('[data-choice="docs"]');
  await pick(page, "national", "front.jpg");
  await page.locator(".aw-thumb img").first().click();
  const picture = page.locator(".aw-viewer img");
  const box = await picture.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -300);
  await expect(picture).toHaveClass(/is-zoomed/);
  const scale = () => picture.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a);
  await expect.poll(scale).toBeGreaterThan(1);
  const before = await picture.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).e);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => picture.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).e)).toBeGreaterThan(before + 50);
  // A drag ending outside the image does not close the viewer; double-click resets.
  await expect(page.locator(".aw-viewer")).toBeVisible();
  await picture.dblclick();
  await expect.poll(scale).toBe(1);
});

test("the back can be chosen while the front is still being read", async ({ page }) => {
  await page.evaluate(() => {
    window.holdReads = {};
    window.holdReads["front.jpg"] = new Promise(resolve => { window.releaseFront = resolve; });
  });
  await page.click('[data-choice="docs"]');
  await page.evaluate(() => { window.openQueue = ["front.jpg"]; });
  await page.click('[data-pick="national"][data-side="front"]');
  await expect(page.locator(".aw-pic.is-busy")).toHaveCount(1);
  await pick(page, "national", "back.jpg", "back");
  // The front is still being read while the back is done.
  await expect(page.locator(".aw-pic.is-busy")).toHaveCount(1);
  await expect(page.locator('[data-key="birthdate"]')).toHaveValue("1985-03-14");
  await page.evaluate(() => window.releaseFront());
  await expect(page.locator(".aw-pic.is-busy")).toHaveCount(0);
  await expect(page.locator('[data-key="full_name"][data-part="first"]')).toHaveValue("سامر");
  await expect(page.locator('[data-key="birthdate"]')).toHaveValue("1985-03-14");
  await expect(page.locator(".aw-thumb")).toHaveCount(2);
});

test("the thumbnail itself zooms with the wheel without opening or scrolling, and resets on double-click", async ({ page }) => {
  await page.click('[data-choice="docs"]');
  await pick(page, "national", "front.jpg");
  const thumb = page.locator(".aw-thumb img").first();
  const scale = () => thumb.evaluate(el => new DOMMatrix(getComputedStyle(el).transform === "none" ? undefined : getComputedStyle(el).transform).a);
  const scrollTops = () => page.evaluate(() => [...document.querySelectorAll(".aw-overlay *")].filter(e => e.scrollTop > 0).length + window.scrollY);
  const before = await scrollTops();
  const box = await thumb.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -300);
  await expect(thumb).toHaveClass(/is-zoomed/);
  await expect.poll(scale).toBeGreaterThan(1);
  expect(await scrollTops()).toBe(before);
  await expect(page.locator(".aw-viewer")).toHaveCount(0);
  // Dragging moves it without opening the enlarged view.
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(page.locator(".aw-viewer")).toHaveCount(0);
  await thumb.dblclick();
  await expect.poll(scale).toBe(1);
  await expect(page.locator(".aw-viewer")).toHaveCount(0);
  // A plain click still enlarges it.
  await thumb.click();
  await expect(page.locator(".aw-viewer")).toBeVisible();
});

// Review tools: confirming an unsure value, showing it on the card, number checks, drafts.

async function readUnsureFront(page) {
  await page.evaluate(() => {
    window.imageReads["unsure.jpg"] = { document: "national_front", warnings: [], fields: [
      { key: "first", value: "سامر", confidence: 0.95, source: "text" }, { key: "surname", value: "الجبوري", confidence: 0.95, source: "text" },
      { key: "mother_first", value: "سعاد", confidence: 0.6, source: "text" }, { key: "mother_father", value: "حسن", confidence: 0.95, source: "text" },
    ] };
    window.imageRegions = { "unsure.jpg": { mother_first: [0.5, 0.6, 0.9, 0.7] } };
  });
  await page.click('[data-choice="docs"]');
  await pick(page, "national", "unsure.jpg");
}

test("an unsure reading is confirmed with «صحيح», which clears the flag and the warning", async ({ page }) => {
  await readUnsureFront(page);
  const mother = page.locator(".aw-field", { has: page.locator('[data-key="mother_name"]') });
  await expect(mother.locator(".aw-src")).toHaveText("راجِع");
  await expect(mother.locator(".aw-note.is-warn")).toBeVisible();
  await mother.getByRole("button", { name: "✓ صحيح" }).click();
  await expect(mother.locator(".aw-src")).not.toHaveText("راجِع");
  await expect(mother.locator(".aw-note.is-warn")).toHaveCount(0);
  await expect(mother.getByRole("button", { name: "✓ صحيح" })).toHaveCount(0);
  await expect(page.locator('[data-key="mother_name"][data-part="first"]')).toHaveValue("سعاد");
});

test("focusing an unsure value zooms the card image to where it was read", async ({ page }) => {
  await readUnsureFront(page);
  const thumb = page.locator('.aw-thumb img[data-side="front"]');
  await page.locator('[data-key="mother_name"][data-part="first"]').focus();
  await expect(thumb).toHaveClass(/is-zoomed/);
  const matrix = () => thumb.evaluate(el => { const m = new DOMMatrix(getComputedStyle(el).transform); return { a: m.a, e: m.e, f: m.f }; });
  await expect.poll(async () => (await matrix()).a).toBeGreaterThan(1.4);
  // The region is right of and below the centre: the image moves left and up.
  const m = await matrix();
  expect(m.e).toBeLessThan(0);
  expect(m.f).toBeLessThan(0);
});

test("national and family numbers are checked, and a registered national number is flagged", async ({ page }) => {
  await page.keyboard.press("Escape");
  await page.evaluate(async () => { window.employeePatch = { civil_id: "199000000001" }; await window.renderActual("employees"); });
  await page.click("#btn-add-emp");
  await page.click('[data-choice="docs"]');
  const civil = page.locator(".aw-field", { has: page.locator('[data-key="civil_id"]') });
  await page.fill('[data-key="civil_id"]', "1990000");
  await expect(civil.locator(".aw-check")).toContainText("12 رقمًا");
  await page.fill('[data-key="civil_id"]', "199000000001");
  await expect(civil.locator(".aw-note.is-error")).toContainText("يوجد موظف مسجّل");
  const family = page.locator(".aw-field", { has: page.locator('[data-key="civil_id_family_number"]') });
  await page.fill('[data-key="civil_id_family_number"]', "12AB");
  await expect(family.locator(".aw-check")).toContainText("غير معتادة");
  await page.fill('[data-key="civil_id_family_number"]', "1500B2C9876543210");
  await expect(family.locator(".aw-check")).toBeEmpty();
});

test("closing the wizard keeps a draft to continue or delete", async ({ page }) => {
  await page.click('[data-choice="docs"]');
  await pick(page, "national", "front.jpg");
  await page.locator(".aw-close").click();
  await expect(page.locator(".aw-overlay")).toHaveCount(0);
  await page.click("#btn-add-emp");
  const banner = page.locator(".aw-draft");
  await expect(banner).toContainText("سامر خالد عبد الله الجبوري");
  await banner.getByRole("button", { name: "متابعتها" }).click();
  await expect(page.locator('[data-key="full_name"][data-part="first"]')).toHaveValue("سامر");
  await expect(page.locator(".aw-thumb")).toHaveCount(1);
  // Saving ends the draft; here: close again, then delete it.
  await page.locator(".aw-close").click();
  await page.click("#btn-add-emp");
  await banner.getByRole("button", { name: "حذفها" }).click();
  await expect(banner).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.click("#btn-add-emp");
  await expect(page.locator(".aw-draft")).toHaveCount(0);
});

test("the employee can be saved from any step once there is a name; missing documents are named", async ({ page }) => {
  // The harness has no toast area: add one to read the message after saving.
  await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", '<div id="toast" class="opacity-0"><span id="toast-msg"></span></div>'));
  await page.click('[data-choice="docs"]');
  const saveNow = page.locator("[data-save-now]");
  await expect(saveNow).toBeDisabled();
  await pick(page, "national", "front.jpg");
  await pick(page, "national", "back.jpg", "back");
  await expect(saveNow).toBeEnabled();
  await saveNow.click();
  await expect.poll(() => page.evaluate(() => window.calls.some(c => c.command === "cmd_create_employee"))).toBe(true);
  const data = await page.evaluate(() => window.calls.find(c => c.command === "cmd_create_employee").args.data);
  expect(data.full_name).toBe("سامر خالد عبد الله الجبوري");
  expect(data.civil_id_birthdate).toBe("1985-03-14");
  await expect(page.locator(".aw-overlay")).toHaveCount(0);
  await expect(page.locator("#toast-msg")).toContainText("لم تُرفع بعد: جواز السفر، هوية وزارة النقل");
});
