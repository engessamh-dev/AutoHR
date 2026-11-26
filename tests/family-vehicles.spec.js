import { test, expect } from "@playwright/test";

// «أفراد الأسرة» and «المركبات» in the employee file (review of 2026-11-26), and the vehicle
// alerts and report columns. Synthetic data only: the harness mocks every backend command.
test.beforeEach(async ({ page }) => { await page.goto("/tests/scanner-harness.html"); await page.waitForFunction(() => window.ready); });

const inDays = days => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const confirmDialog = page => page.locator("[role=alertdialog] button.btn-primary, [role=alertdialog] .btn-danger").last();

async function openTab(page, tab, patch = {}, permissions = null) {
  await page.evaluate(({ patch, permissions }) => {
    window.employeePatch = patch;
    if (permissions) window.permissionsOverride = permissions;
  }, { patch, permissions });
  await page.evaluate(() => window.renderActual("employees"));
  await page.locator('.table-row[data-id="1"]').click();
  await page.locator(`.tab-btn[data-tab="${tab}"]`).click();
}
const saved = page => page.evaluate(() => window.calls.filter(c => c.command === "cmd_update_employee").at(-1)?.args.data);

test("alerts read the vehicles list only, name the plate, and keep two vehicles due the same day", async ({ page }) => {
  const alerts = await page.evaluate(async ({ soon, old }) => {
    const { buildDocumentAlerts } = await import("/src/screens/document-alerts.js");
    const rules = [{ key: "vehicle", enabled: true, days: [30] }];
    const vehicles = JSON.stringify([{ plate: "111 أ بغداد", expiry_date: soon }, { plate: "222 ب بغداد", expiry_date: soon }, { plate: "", expiry_date: "" }]);
    // The old single-vehicle column still holds last year's date: not an alert any more.
    return buildDocumentAlerts([
      { id: 1, is_active: 1, full_name: "A", vehicles, vehicle_annual_expiry_date: old },
      { id: 2, is_active: 1, full_name: "B", vehicles: "[]", vehicle_annual_expiry_date: old },
    ], rules).map(a => a.documentName.replace(/[⁦-⁩]/g, ""));
  }, { soon: inDays(5), old: inDays(-20) });
  expect(alerts).toEqual(["سنوية المركبة 111 أ بغداد", "سنوية المركبة 222 ب بغداد"]);
});

test("adding a family member keeps the labels of the members already listed", async ({ page }) => {
  await openTab(page, "family", { family_members: JSON.stringify([{ name: "علي", relation: "ابن", gender: "ذكر" }]) });
  await page.locator(".family-row .emp-row-head").first().click();
  await page.locator("#btn-add-member").click();
  await expect(page.locator(".family-row").first().getByText("صلة القرابة")).toBeVisible();
  await expect(page.locator(".family-row")).toHaveCount(2);
});

test("choosing «ابنة» sets the gender, and a mismatch or a short national number is flagged", async ({ page }) => {
  await openTab(page, "family", { family_members: JSON.stringify([{ name: "علي", relation: "ابن", gender: "ذكر", civil_id: "123" }]) });
  const row = page.locator(".family-row").first();
  await row.locator(".emp-row-head").click();
  await expect(row.locator(".row-check")).toContainText("الرقم الوطني 12 رقمًا");
  await row.locator(".fm-relation").selectOption("ابنة");
  await expect(row.locator(".fm-gender")).toHaveValue("أنثى");
  await row.locator(".fm-gender").selectOption("ذكر");
  await expect(row.locator(".row-check")).toContainText("لا توافق الجنس");
  await row.locator(".fm-civil").fill("202000100001");
  await row.locator(".fm-gender").selectOption("أنثى");
  await expect(row.locator(".row-check")).toHaveCount(0);
});

test("a family member's expired national card shows in the row heading", async ({ page }) => {
  await openTab(page, "family", { family_members: JSON.stringify([{ name: "مريم", relation: "ابنة", expiry_date: inDays(-30) }]) });
  await expect(page.locator(".family-row .emp-pill.bad")).toHaveText("البطاقة: منتهٍ");
});

test("changing a man with two wives to «أنثى» does not drop the second: saving is refused", async ({ page }) => {
  await openTab(page, "basic", { spouses: JSON.stringify([{ name: "فاطمة" }, { name: "نور" }]) });
  await page.locator("#f-gender").selectOption("أنثى");
  await page.locator('.tab-btn[data-tab="family"]').click();
  await expect(page.locator(".spouse-row")).toHaveCount(2);
  await expect(page.locator(".spouse-limit")).toContainText("زوج واحد فقط");
  await page.locator("#panel-save").click();
  await page.waitForTimeout(300);
  expect(await saved(page)).toBeUndefined();
  // Removing the extra one lets it save, with the remaining spouse only.
  await page.locator(".spouse-row .btn-remove-spouse").last().click();
  await confirmDialog(page).click();
  await expect(page.locator(".spouse-limit")).toHaveCount(0);
  await page.locator("#panel-save").click();
  await expect.poll(async () => JSON.parse((await saved(page))?.spouses ?? "[]").length).toBe(1);
});

test("unsaved family changes stay after switching tabs, and an empty new row is not saved", async ({ page }) => {
  await openTab(page, "family", { family_members: JSON.stringify([{ name: "علي", relation: "ابن" }]) });
  await page.locator(".family-row .emp-row-head").first().click();
  await page.locator(".family-row .fm-birthplace").first().fill("البصرة");
  await page.locator("#btn-add-member").click();
  await page.locator('.tab-btn[data-tab="vehicle"]').click();
  await page.locator('.tab-btn[data-tab="family"]').click();
  await page.locator(".family-row .emp-row-head").first().click();
  await expect(page.locator(".family-row .fm-birthplace").first()).toHaveValue("البصرة");
  await page.locator("#panel-save").click();
  await expect.poll(async () => JSON.parse((await saved(page))?.family_members ?? "[]").map(m => m.birthplace)).toEqual(["البصرة"]);
});

test("removing a member asks by name and numbers the rest again", async ({ page }) => {
  await openTab(page, "family", { family_members: JSON.stringify([{ name: "علي" }, { name: "مريم" }]) });
  await page.locator(".family-row .btn-remove-member").first().click();
  await expect(page.locator("[role=alertdialog]")).toContainText("علي");
  await confirmDialog(page).click();
  await expect(page.locator(".family-row .emp-row-title")).toHaveText(["فرد رقم 1"]);
});

test("«موظف»: no delete for a registration image, nor for a vehicle that has one", async ({ page }) => {
  const clerk = ["dashboard.view", "employees.view", "employees.create", "employees.edit", "documents.view", "documents.upload", "documents.download", "documents.print"];
  await openTab(page, "vehicle", { vehicles: JSON.stringify([
    { plate: "111 أ بغداد", annual_front_path: "Files/Employees/1/Vehicles/1/Annual/a.jpg", annual_front_full_path: "x" },
    { plate: "222 ب بغداد" },
  ]) }, clerk);
  await expect(page.locator(".btn-delete-vehicle-annual")).toHaveCount(0);
  await expect(page.locator(".vehicle-row").nth(0).locator(".btn-remove-vehicle")).toBeDisabled();
  await expect(page.locator(".vehicle-row").nth(1).locator(".btn-remove-vehicle")).toBeEnabled();
});

test("a viewer opens an employee without a script error", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await openTab(page, "family", {}, ["dashboard.view", "employees.view", "documents.view", "documents.download", "documents.print"]);
  await expect(page.locator("#panel-save")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("vehicle heading starts with the plate, and the old single-vehicle fields are not sent", async ({ page }) => {
  await openTab(page, "vehicle", { vehicle_plate: "old", vehicle_annual_expiry_date: "2020-01-01",
    vehicles: JSON.stringify([{ plate: "12345 أ بغداد", brand: "تويوتا", type: "صالون", color: "أبيض" }]) });
  await expect(page.locator(".vehicle-row .emp-row-summary")).toHaveText("⁨12345 أ بغداد⁩ · تويوتا صالون أبيض");
  await page.locator("#panel-save").click();
  await expect.poll(async () => (await saved(page))?.vehicles).toBeTruthy();
  const data = await saved(page);
  expect(data.vehicle_plate).toBeUndefined();
  expect(data.vehicle_annual_expiry_date).toBeUndefined();
});

test("a woman's marital status reads «متزوجة»; the stored value stays «متزوج»", async ({ page }) => {
  await openTab(page, "basic", { gender: "أنثى", marital_status: "متزوج", spouses: "[]" });
  await expect(page.locator("#f-marital_status option:checked")).toHaveText("متزوجة");
  await page.locator("#f-gender").selectOption("ذكر");
  await expect(page.locator("#f-marital_status option:checked")).toHaveText("متزوج");
  await expect(page.locator("#f-marital_status")).toHaveValue("متزوج");
});
