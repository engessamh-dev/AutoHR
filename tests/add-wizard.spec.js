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
  // The other documents and saving wait for the national card's essentials.
  await expect(page.locator("[data-next]")).toBeDisabled();
  await expect(page.locator("[data-save-now]")).toBeDisabled();
  await pick(page, "national", "front.jpg");
  await expect(page.locator("[data-next]")).toBeDisabled();
  await expect(page.locator(".aw-hint")).toContainText("تاريخ الولادة");
  await pick(page, "national", "back.jpg", "back");
  await expect(page.locator("[data-next]")).toBeEnabled();
  await expect(page.locator("[data-save-now]")).toBeEnabled();
  await expect(page.locator('[data-key="birthdate"]')).toHaveValue("1985-03-14");
  await expect(page.locator('[data-key="full_name"][data-part="first"]')).toHaveValue("سامر");
  // An edit is tagged as manual.
  await page.fill('[data-key="birthplace"]', "البصرة");
  await expect(page.locator('.aw-field:has([data-key="birthplace"]) .aw-src')).toHaveText(/معدّل يدويًا/);
});

test("a later document does not overwrite an earlier value; the conflict can be taken", async ({ page }) => {
  await page.click('[data-choice="docs"]');
  await pick(page, "national", "front.jpg");
  await pick(page, "national", "back.jpg", "back");
  await page.click("[data-next]");
  await page.click("[data-skip]");
  await pick(page, "ministry", "ministry.jpg");
  await page.click("[data-next]");
  await pick(page, "airport", "airport.jpg");
  await expect(page.locator('[data-key="job_title"]')).toHaveValue("مهندس");
  await expect(page.locator(".aw-chip")).toHaveCount(3);
  // The usual codes not on the badge are one click away.
  await expect(page.locator("[data-chip-add]")).toHaveText(["+ C"]);
  await page.click('[data-chip-add="C"]');
  await expect(page.locator(".aw-chip")).toHaveCount(4);
  await expect(page.locator("[data-chip-add]")).toHaveCount(0);
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
  await expect(civil.locator(".aw-note.is-error")).toContainText("هذا الموظف مسجّل مسبقًا");
  const family = page.locator(".aw-field", { has: page.locator('[data-key="civil_id_family_number"]') });
  await page.fill('[data-key="civil_id_family_number"]', "12AB");
  await expect(family.locator(".aw-check")).toContainText("غير معتادة");
  await page.fill('[data-key="civil_id_family_number"]', "1500B2C9876543210");
  await expect(family.locator(".aw-check")).toBeEmpty();
});

test("closing the wizard can keep a draft to continue or delete", async ({ page }) => {
  await page.click('[data-choice="docs"]');
  await pick(page, "national", "front.jpg");
  await page.locator(".aw-close").click();
  await page.getByRole("button", { name: "حفظ كمسودة" }).click();
  await expect(page.locator(".aw-overlay")).toHaveCount(0);
  await page.click("#btn-add-emp");
  const banner = page.locator(".aw-draft");
  await expect(banner).toContainText("سامر خالد عبد الله الجبوري");
  await banner.getByRole("button", { name: "متابعتها" }).click();
  await expect(page.locator('[data-key="full_name"][data-part="first"]')).toHaveValue("سامر");
  await expect(page.locator(".aw-thumb")).toHaveCount(1);
  // Saving ends the draft; here: keep it again, then delete it.
  await page.locator(".aw-close").click();
  await page.getByRole("button", { name: "حفظ كمسودة" }).click();
  await page.click("#btn-add-emp");
  await banner.getByRole("button", { name: "حذفها" }).click();
  await expect(banner).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.click("#btn-add-emp");
  await expect(page.locator(".aw-draft")).toHaveCount(0);
});

test("the employee can be saved from any step once the national card is complete; the wizard stays open and later saves update it", async ({ page }) => {
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
  // The wizard stays open on the saved employee.
  await expect(page.locator(".aw-overlay")).toBeVisible();
  await expect(page.locator(".aw-saved")).toBeVisible();
  await expect(saveNow).toHaveText("حفظ التعديلات");
  await expect(page.locator("#toast-msg")).toContainText("لم تُرفع بعد: جواز السفر، هوية وزارة النقل");
  // A document added afterwards: the next save updates the same employee and uploads only it.
  await page.locator(".aw-step").nth(2).click();
  await pick(page, "ministry", "ministry.jpg");
  await saveNow.click();
  await expect.poll(() => page.evaluate(() => window.calls.some(c => c.command === "cmd_update_employee"))).toBe(true);
  const uploads = await page.evaluate(() => window.calls.filter(c => c.command.startsWith("cmd_upload_")).map(c => c.command));
  expect(uploads).toEqual(["cmd_upload_national_card_attachment", "cmd_upload_national_card_attachment", "cmd_upload_ministry_badge_attachment"]);
  expect(await page.evaluate(() => window.calls.filter(c => c.command === "cmd_create_employee").length)).toBe(1);
  // Nothing unsaved: closing asks nothing.
  await page.locator(".aw-close").click();
  await expect(page.locator(".aw-overlay")).toHaveCount(0);
});

test("ministry ID: one Arabic side fills department and job, and its name is checked against the national card", async ({ page }) => {
  await page.evaluate(() => {
    const f = (key, value) => ({ key, value, confidence: 0.95, source: "text" });
    window.imageReads["mot-same.jpg"] = { document: "ministry_badge", warnings: [], fields: [f("first", "سامر"), f("father", "خالد"), f("grandfather", "عبد الله"), f("department", "قسم هندسة الصيانة"), f("job_title", "مهندس أقدم"), f("doc_number", "200300400"), f("expiry_date", "2028-01-14")] };
    window.imageReads["mot-other.jpg"] = { document: "ministry_badge", warnings: [], fields: [f("first", "كريم"), f("father", "خالد"), f("grandfather", "عبد الله")] };
  });
  await page.click('[data-choice="docs"]');
  await pick(page, "national", "front.jpg");
  await pick(page, "national", "back.jpg", "back");
  await page.click("[data-next]");
  await page.click("[data-skip]");
  await expect(page.locator('[data-pick="ministry"]')).toHaveCount(1);
  await pick(page, "ministry", "mot-same.jpg");
  await expect(page.locator('[data-key="department"]')).toHaveValue("قسم هندسة الصيانة");
  await expect(page.locator('[data-key="job_title"]')).toHaveValue("مهندس أقدم");
  await expect(page.locator(".aw-note.is-ok", { hasText: "يطابق البطاقة الوطنية" })).toBeVisible();
  await page.evaluate(() => { window.openQueue = ["mot-other.jpg"]; });
  await page.click('[data-pick="ministry"][data-side="front"]');
  await expect(page.locator(".aw-other")).toContainText("هذا المستمسك باسم شخص آخر: «كريم خالد عبد الله»");
});

test("another person's document: red warning with replace or confirm; a misread letter only asks to compare", async ({ page }) => {
  await page.evaluate(() => {
    const f = (key, value) => ({ key, value, confidence: 0.95, source: "text" });
    window.imageReads["pass-son.jpg"] = { document: "passport", warnings: [], fields: [f("first", "يوسف"), f("father", "سامر"), f("grandfather", "خالد"), f("surname", "الجبوري"), f("passport_no", "A00000001")] };
    window.imageReads["pass-misread.jpg"] = { document: "passport", warnings: [], fields: [f("first", "سامز"), f("father", "خالد"), f("grandfather", "عبد الله"), f("surname", "الجبوري")] };
    window.imageReads["pass-own.jpg"] = { document: "passport", warnings: [], fields: [f("first", "سامر"), f("father", "خالد"), f("grandfather", "عبد الله"), f("surname", "الجبوري")] };
  });
  await page.click('[data-choice="docs"]');
  await pick(page, "national", "front.jpg");
  await pick(page, "national", "back.jpg", "back");
  await page.click("[data-next]");
  await pick(page, "passport", "pass-son.jpg", "page");
  const other = page.locator(".aw-other");
  await expect(other).toContainText("باسم شخص آخر: «يوسف سامر خالد الجبوري»");
  // Confirming keeps it, with a calm note.
  await other.getByRole("button", { name: "هو للموظف نفسه" }).click();
  await expect(other).toHaveCount(0);
  await expect(page.locator(".aw-note.is-ok", { hasText: "أكّدت أن المستمسك للموظف" })).toBeVisible();
  // Replacing reads a new image: the check starts again.
  await pick(page, "passport", "pass-misread.jpg", "page");
  await expect(page.locator(".aw-note.is-warn", { hasText: "قد يكون خطأ قراءة" })).toBeVisible();
  await expect(other).toHaveCount(0);
  await pick(page, "passport", "pass-son.jpg", "page");
  await page.evaluate(() => { window.openQueue = ["pass-own.jpg"]; });
  await other.getByRole("button", { name: "استبدال الصورة" }).click();
  await expect(page.locator(".aw-note.is-ok", { hasText: "يطابق البطاقة الوطنية" })).toBeVisible();
  await expect(other).toHaveCount(0);
});

test("a document number of another employee is flagged; a shared ration card and its head of household only noted", async ({ page }) => {
  await page.evaluate(() => {
    const f = (key, value) => ({ key, value, confidence: 0.95, source: "text" });
    window.imageReads["ration.jpg"] = { document: "ration", warnings: [], fields: [f("ration_no", "0100000001"), f("head_name", "خالد عبد الله حسن الجبوري")] };
  });
  await page.keyboard.press("Escape");
  await page.evaluate(async () => { window.employeePatch = { passport_no: "A00000001", ration_card_no: "0100000001" }; await window.renderActual("employees"); });
  await page.click("#btn-add-emp");
  await page.click('[data-choice="docs"]');
  await pick(page, "national", "front.jpg");
  await pick(page, "national", "back.jpg", "back");
  await page.click("[data-next]");
  const passport = page.locator(".aw-field", { has: page.locator('[data-key="passport_no"]') });
  await page.fill('[data-key="passport_no"]', "a00000001");
  await expect(passport.locator(".aw-note.is-error")).toContainText("رقم جواز هذا مسجّل للموظف Synthetic Employee");
  await page.locator(".aw-step").nth(4).click();
  await pick(page, "ration", "ration.jpg", "page");
  const ration = page.locator(".aw-field", { has: page.locator('[data-key="ration_card_no"]') });
  await expect(ration.locator(".aw-note.is-warn")).toContainText("طبيعي إن كانا من أسرة واحدة");
  await expect(page.locator(".aw-note.is-warn", { hasText: "رب الأسرة في البطاقة «خالد عبد الله حسن الجبوري» وليس الموظف" })).toBeVisible();
  await expect(page.locator(".aw-other")).toHaveCount(0);
});


test("other documents stay locked until the national card is complete, then open in any order", async ({ page }) => {
  await page.click('[data-choice="docs"]');
  const steps = page.locator(".aw-step");
  await expect(steps).toHaveCount(8);
  for (const i of [1, 2, 7]) await expect(steps.nth(i)).toBeDisabled();
  await pick(page, "national", "front.jpg");
  await expect(steps.nth(2)).toBeDisabled();
  // Typing the missing birth date unlocks them without re-reading.
  await page.fill('[data-key="birthdate"]', "1985-03-14");
  await expect(steps.nth(2)).toBeEnabled();
  for (const i of [3, 7, 1, 5]) {
    await steps.nth(i).click();
    await expect(steps.nth(i)).toHaveClass(/is-current/);
  }
  await expect(page.locator("[data-save-now]")).toBeEnabled();
  // An invalid national number locks them again.
  await steps.nth(0).click();
  await page.fill('[data-key="civil_id"]', "123");
  await expect(steps.nth(3)).toBeDisabled();
  await expect(page.locator("[data-save-now]")).toBeDisabled();
});

test("leaving with entries asks: save, keep a draft, leave without saving, or stay", async ({ page }) => {
  await page.click('[data-choice="docs"]');
  // Nothing entered: closes at once.
  await page.locator(".aw-close").click();
  await expect(page.locator(".aw-overlay")).toHaveCount(0);
  await page.click("#btn-add-emp");
  await page.click('[data-choice="docs"]');
  await pick(page, "national", "front.jpg");
  await page.keyboard.press("Escape");
  const ask = page.locator(".aw-ask");
  await expect(ask).toBeVisible();
  // Not complete yet: saving is offered but disabled, with what is missing.
  await expect(ask.getByRole("button", { name: "حفظ الموظف" })).toBeDisabled();
  await expect(ask).toContainText("تاريخ الولادة");
  await ask.getByRole("button", { name: "متابعة الإدخال" }).click();
  await expect(ask).toHaveCount(0);
  // Leaving without saving keeps nothing.
  await page.locator(".aw-close").click();
  await ask.getByRole("button", { name: "خروج دون حفظ" }).click();
  await expect(page.locator(".aw-overlay")).toHaveCount(0);
  await page.click("#btn-add-emp");
  await expect(page.locator(".aw-draft")).toHaveCount(0);
  // Complete: saving from the question creates the employee.
  await page.click('[data-choice="docs"]');
  await pick(page, "national", "front.jpg");
  await pick(page, "national", "back.jpg", "back");
  await page.locator(".aw-close").click();
  await ask.getByRole("button", { name: "حفظ الموظف" }).click();
  await expect.poll(() => page.evaluate(() => window.calls.some(c => c.command === "cmd_create_employee"))).toBe(true);
  await expect(page.locator(".aw-overlay")).toHaveCount(0);
});

test("a step shows ✓ only when all its fields are filled; visiting it is not enough", async ({ page }) => {
  await page.evaluate(() => {
    const f = (key, value) => ({ key, value, confidence: 0.95, source: "text" });
    window.imageReads["mot-full.jpg"] = { document: "ministry_badge", warnings: [], fields: [f("department", "قسم هندسة الصيانة"), f("job_title", "مهندس أقدم"), f("doc_number", "200300400"), f("issue_date", "2023-01-15"), f("expiry_date", "2028-01-14")] };
  });
  await page.click('[data-choice="docs"]');
  const steps = page.locator(".aw-step");
  await pick(page, "national", "front.jpg");
  await pick(page, "national", "back.jpg", "back");
  for (const i of [1, 3, 4]) await steps.nth(i).click();
  for (const i of [1, 3]) {
    await expect(steps.nth(i)).not.toHaveClass(/is-done/);
    await expect(steps.nth(i).locator("i")).not.toHaveText("✓");
  }
  await steps.nth(2).click();
  await pick(page, "ministry", "mot-full.jpg");
  await steps.nth(4).click();
  // National: some fields only (front side) → a count, no ✓.
  await expect(steps.nth(0)).toHaveClass(/is-partial/);
  await expect(steps.nth(0).locator("small")).toContainText("من 11");
  // Ministry: every field read → ✓.
  await expect(steps.nth(2)).toHaveClass(/is-done/);
  await expect(steps.nth(2).locator("i")).toHaveText("✓");
});

test("residence card: the printed serial is read, handwritten fields are flagged to copy from the image and saved", async ({ page }) => {
  await page.evaluate(reads => Object.assign(window.imageReads, reads), {
    "res-front.jpg": { document: "residence", fields: [], handwritten: ["head_name", "address", "form_no"],
      warnings: ["مكتوب بخط اليد ولا يُقرأ آليًا: اسم رب الأسرة، العنوان، رقم الاستمارة. انقلها من الصورة."] },
    "res-back.jpg": { document: "residence", fields: [f("doc_number", "1234567")], handwritten: ["issue_date"], warnings: [] },
  });
  await page.evaluate(() => { window.imageRegions = { "res-front.jpg": { address: [0.6, 0.6, 0.95, 0.7] } }; });
  await page.click('[data-choice="docs"]');
  await pick(page, "national", "front.jpg");
  await pick(page, "national", "back.jpg", "back");
  await page.locator(".aw-step").nth(5).click();
  await pick(page, "residence", "res-front.jpg");
  await pick(page, "residence", "res-back.jpg", "back");
  await expect(page.locator('[data-key="residence_card_no"]')).toHaveValue("1234567");
  const flagged = key => page.locator(`.aw-field:has([data-key="${key}"]) .aw-note`);
  for (const key of ["residence_head_name", "residence_form_no", "residence_address", "residence_card_issue_date"]) {
    await expect(flagged(key)).toContainText("بخط اليد");
  }
  await expect(flagged("residence_card_no")).toHaveCount(0);
  // Typing a handwritten field zooms the card to it.
  await page.locator('[data-key="residence_address"]').focus();
  await expect(page.locator('.aw-thumb img[data-side="front"]')).toHaveClass(/is-zoomed/);
  await page.fill('[data-key="residence_address"]', "محلة 000 زقاق 00 دار 0");
  await page.fill('[data-key="residence_head_name"]', "سامر خالد عبد الله");
  await page.fill('[data-key="residence_form_no"]', "1111");
  await page.click("[data-save-now]");
  await expect.poll(() => page.evaluate(() => window.calls.some(c => c.command === "cmd_create_employee"))).toBe(true);
  const data = await page.evaluate(() => window.calls.find(c => c.command === "cmd_create_employee").args.data);
  expect(data.residence_card_no).toBe("1234567");
  expect(data.residence_head_name).toBe("سامر خالد عبد الله");
  expect(data.residence_form_no).toBe("1111");
});

test("a registered national number blocks a second record: go back, open the file, or add the documents to it", async ({ page }) => {
  await page.keyboard.press("Escape");
  await page.evaluate(async () => { window.employeePatch = { civil_id: "199000000001", birthdate: null, gender: "ذكر" }; await window.renderActual("employees"); });
  await page.click("#btn-add-emp");
  await page.click('[data-choice="docs"]');
  await pick(page, "national", "front.jpg");
  await pick(page, "national", "back.jpg", "back");
  const dialog = page.getByRole("alertdialog", { name: "الموظف مسجّل مسبقًا" });
  // «إلغاء» goes back to the national number, to fix a misread.
  await page.click("[data-save-now]");
  await expect(dialog).toContainText("هذا الموظف مسجّل مسبقًا: Synthetic Employee");
  await dialog.getByRole("button", { name: "إلغاء" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('[data-key="civil_id"]')).toBeFocused();
  // Adding the documents lists the differing fields; only the ticked ones are updated.
  await page.click("[data-save-now]");
  await dialog.getByRole("button", { name: "إضافة المستمسكات إلى ملفه" }).click();
  const attach = page.getByRole("alertdialog", { name: "إضافة المستمسكات إلى ملفه" });
  await expect(attach.locator('[data-diff="full_name"]')).not.toBeChecked();
  await expect(attach.locator('[data-diff="birthdate"]')).toBeChecked();
  await expect(attach.locator('[data-diff="gender"]')).toHaveCount(0);
  await attach.getByRole("button", { name: /إضافة وتحديث المحدَّد/ }).click();
  await expect(page.locator(".aw-overlay")).toHaveCount(0);
  const calls = await page.evaluate(() => window.calls.map(c => ({ command: c.command, args: c.args })));
  expect(calls.some(c => c.command === "cmd_create_employee")).toBe(false);
  const update = calls.find(c => c.command === "cmd_update_employee");
  expect(update.args.data.full_name).toBe("Synthetic Employee");
  expect(update.args.data.birthdate).toBe("1985-03-14");
  expect(calls.filter(c => c.command.startsWith("cmd_upload_") && c.args.employeeId === 1).length).toBe(2);
});

test("a registered national number: «فتح ملفه» opens that employee and keeps the entries as a draft", async ({ page }) => {
  await page.keyboard.press("Escape");
  await page.evaluate(async () => { window.employeePatch = { civil_id: "199000000001" }; await window.renderActual("employees"); });
  await page.click("#btn-add-emp");
  await page.click('[data-choice="docs"]');
  await pick(page, "national", "front.jpg");
  await pick(page, "national", "back.jpg", "back");
  await page.click("[data-save-now]");
  await page.getByRole("alertdialog", { name: "الموظف مسجّل مسبقًا" }).getByRole("button", { name: "فتح ملفه" }).click();
  await expect(page.locator(".aw-overlay")).toHaveCount(0);
  await expect(page.locator("#panel-save")).toBeVisible();
  expect(await page.evaluate(() => window.calls.some(c => c.command === "cmd_create_employee" || c.command === "cmd_update_employee"))).toBe(false);
  await page.click("#panel-close").catch(() => page.keyboard.press("Escape"));
  await page.click("#btn-add-emp");
  await expect(page.locator(".aw-draft")).toContainText("سامر خالد عبد الله الجبوري");
});
