import { test, expect } from "@playwright/test";

// Synthetic data only: the harness mocks every backend command.
test.beforeEach(async ({ page }) => { await page.goto("/tests/scanner-harness.html"); await page.waitForFunction(() => window.ready); });

const group = (page, key, scope = page) => scope.locator(`.name-fields[data-name-key="${key}"]`).first();
const part = (g, name) => g.locator(`.name-part[data-part="${name}"]`);

test("employee name is edited in national-card fields and saved as parts plus the combined name", async ({ page }) => {
  await page.evaluate(() => window.renderActual("employees"));
  await page.locator('.table-row[data-id="1"]').click();
  const full = group(page, "full_name");
  // Not split yet: the old text sits in the first field and is flagged.
  await expect(part(full, "first")).toHaveValue("Synthetic Employee");
  await expect(full.locator(".name-review-badge")).toBeVisible();
  for (const [name, value] of [["first", "علي"], ["father", "حسن"], ["grandfather", "كاظم"], ["great_grandfather", ""], ["surname", "الربيعي"]]) {
    await part(full, name).fill(value);
  }
  await expect(full.locator(".name-review-badge")).toBeHidden();
  await page.locator("#panel-save").click();
  await page.getByRole("button", { name: "تأكيد", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.calls.some(c => c.command === "cmd_update_employee"))).toBe(true);
  const data = await page.evaluate(() => window.calls.find(c => c.command === "cmd_update_employee").args.data);
  expect(data.full_name).toBe("علي حسن كاظم الربيعي");
  expect(data.name_parts.full_name).toEqual({ first: "علي", father: "حسن", grandfather: "كاظم", great_grandfather: "", surname: "الربيعي", review: false });
  // Untouched names without parts are sent as text only, for the backend to split.
  expect(data.name_parts.mother_name).toBeUndefined();
});

test("spouse and family names use the same fields", async ({ page }) => {
  await page.evaluate(() => window.renderActual("employees"));
  await page.locator('.table-row[data-id="1"]').click();
  await page.locator('.tab-btn[data-tab="family"]').click();
  const spouse = page.locator(".spouse-row").first();
  await spouse.locator(".emp-row-head").click();
  await expect(part(group(page, "name", spouse), "first")).toHaveValue("Synthetic Spouse");
  await expect(group(page, "mother_name", spouse)).toBeVisible();
  const member = page.locator(".family-row").first();
  await member.locator(".emp-row-head").click();
  await part(group(page, "name", member), "first").fill("حسن");
  await part(group(page, "name", member), "surname").fill("الربيعي");
  await member.locator(".emp-row-head").click();
  await expect(member.locator(".emp-row-summary")).toContainText("حسن الربيعي");
  await page.locator("#panel-save").click();
  await page.getByRole("button", { name: "تأكيد", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.calls.some(c => c.command === "cmd_update_employee"))).toBe(true);
  const data = await page.evaluate(() => window.calls.find(c => c.command === "cmd_update_employee").args.data);
  const family = JSON.parse(data.family_members);
  expect(family[0].name).toBe("حسن الربيعي");
  expect(family[0].name_parts.name.surname).toBe("الربيعي");
});

test("review dialog lists unsure names and confirms them", async ({ page }) => {
  await page.evaluate(() => {
    window.nameReview = [{
      employee_id: 1, employee_name: "Synthetic Employee", owner: "employee", index: 0, field: "full_name",
      text: "علي حسين كاظم جاسم", original_text: "علي حسين كاظم جاسم",
      parts: { first: "علي", father: "حسين", grandfather: "كاظم", great_grandfather: "جاسم", surname: "", review: true },
    }];
  });
  await page.evaluate(() => window.renderActual("employees"));
  const button = page.locator("#btn-name-review");
  await expect(button).toHaveText("مراجعة الأسماء (1)");
  await button.click();
  const dialog = page.getByRole("dialog", { name: "مراجعة الأسماء" });
  const g = group(page, "full_name", dialog);
  await part(g, "great_grandfather").fill("");
  await part(g, "surname").fill("جاسم");
  await dialog.getByRole("button", { name: "تأكيد", exact: true }).click();
  await expect(dialog.getByText("لا توجد أسماء بحاجة لمراجعة.")).toBeVisible();
  const saved = await page.evaluate(() => window.calls.find(c => c.command === "cmd_save_name_review").args);
  expect(saved.parts).toEqual({ first: "علي", father: "حسين", grandfather: "كاظم", great_grandfather: "", surname: "جاسم", review: false });
  await dialog.getByRole("button", { name: "إغلاق" }).click();
  await expect(button).toBeHidden();
});
