import { test, expect } from "@playwright/test";

// Employees report (review of the reports screen). Synthetic data only: the harness mocks every backend command.
const today = new Date();
const iso = days => { const d = new Date(today); d.setDate(d.getDate() + days); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const person = (id, extra = {}) => ({
  id, employee_number: `T-${1000 + id}`, full_name: `موظف ${id}`, mother_name: "أم", gender: "ذكر", marital_status: "متزوج",
  birthdate: "1990-01-01", birthplace: "بغداد", blood_type: "O+", phone: "07700000000", job_title: "مهندس", job_grade: "السادسة",
  appointment_date: "2015-03-01", contract_type: "ملاك", education_level: "بكالوريوس", is_active: 1,
  department: "قسم قديم", division: null, workplace: "المقر العام", spouses: "[]", family_members: "[]", vehicles: "[]", attachment_paths: "[]", ...extra,
});

async function openReports(page, employees, { storage = {}, company } = {}) {
  await page.goto("/tests/scanner-harness.html");
  await page.waitForFunction(() => window.ready);
  await page.evaluate(({ employees, storage, company }) => {
    localStorage.clear();
    Object.entries(storage).forEach(([key, value]) => localStorage.setItem(key, value));
    document.body.insertAdjacentHTML("beforeend", `<div id="toast" class="opacity-0"><span id="toast-msg"></span></div>`);
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = async (command, args) => {
      if (command === "cmd_list_employees") return JSON.parse(JSON.stringify(employees));
      if (command === "cmd_get_company_config") return company ?? { company_name: "الشركة", department_name: "قسم الإعدادات", division_name: "شعبة الإعدادات" };
      if (command === "cmd_get_document_alert_rules") return null;
      if (command === "cmd_save_report_xlsx" || command === "cmd_audit_report_print") { window.calls.push({ command, args }); return null; }
      if (command === "plugin:dialog|save") { window.calls.push({ command, args }); return "C:\\report.xlsx"; }
      return original(command, args);
    };
  }, { employees, storage, company });
  await page.evaluate(() => window.renderActual("reports"));
  await expect(page.locator("#report-table table")).toBeVisible();
}

const columns = async (page, keys) => {
  await page.locator("#report-clear").click();
  for (const key of keys) await page.locator(`.report-field[value="${key}"]`).check();
};
const cells = (page, row) => page.locator("#report-table tbody tr").nth(row).locator("td");

test("a saved setting keeps columns and filters, not the list of employees", async ({ page }) => {
  // An older setting listed employee 1 only: employee 2, added later, is still in the report.
  await openReports(page, [person(1), person(2)], { storage: { "autohr.reportBuilder.v1": JSON.stringify({ columns: ["full_name", "phone"], filters: { employeeIds: [1] } }) } });
  await expect(page.locator(".report-employee:checked")).toHaveCount(2);
  await expect(page.locator("#report-table thead th")).toHaveText(["", "ت", "الاسم الرباعي واللقب", "الهاتف"]);
  await page.locator(".report-employee").first().uncheck();
  await page.locator("#report-status").selectOption("all");
  await page.locator("#report-save").click();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("autohr.reportBuilder.v2")));
  expect(saved).toEqual({ columns: ["full_name", "phone"], filters: { search: "", status: "all", docs: "all", data: "all" } });
});

test("department, division and workplace come from Settings, like the employee file", async ({ page }) => {
  await openReports(page, [person(1)]);
  await columns(page, ["workplace", "department", "division"]);
  await expect(cells(page, 0).nth(2)).toHaveText("الشركة");
  await expect(cells(page, 0).nth(3)).toHaveText("قسم الإعدادات");
  await expect(cells(page, 0).nth(4)).toHaveText("شعبة الإعدادات");
});

test("vehicle columns read the vehicles list, one value per vehicle", async ({ page }) => {
  const vehicles = JSON.stringify([
    { plate: "111 أ بغداد", type: "صالون", color: "أبيض", model_year: "2019", annual_no: "A1", expiry_date: "2027-05-01" },
    { plate: "222 ب بغداد", type: "بيك أب", color: "أسود", model_year: "2021", annual_no: "A2", expiry_date: "2028-01-09" },
  ]);
  await openReports(page, [person(1, { vehicles })]);
  await columns(page, ["vehicles_count", "vehicle_type", "vehicle_color", "vehicle_annual_expiry_date"]);
  await expect(cells(page, 0).nth(2)).toHaveText("2");
  await expect(cells(page, 0).nth(3)).toHaveText("صالون، بيك أب");
  await expect(cells(page, 0).nth(4)).toHaveText("أبيض، أسود");
  await expect(cells(page, 0).nth(5)).toHaveText("2027/5/1، 2028/1/9");
});

test("missing data, document status and the address parts are columns and filters", async ({ page }) => {
  const parts = JSON.stringify({ gov: "بغداد", district: "الكرخ", sub: "المنصور", city: "حي الجامعة", m: "615", z: "12", d: "4", other: "", useOther: "" });
  await openReports(page, [
    person(1, { passport_expiry_date: iso(-3), residence_address_parts: parts, residence_address: "بغداد / الكرخ / المنصور / حي الجامعة، م 615 ز 12 د 4" }),
    person(2, { phone: "", blood_type: "" }),
  ]);
  await columns(page, ["full_name", "missing_count", "missing_fields", "documents_status", "residence_governorate", "residence_district"]);
  await expect(cells(page, 0).nth(3)).toHaveText("0");
  await expect(cells(page, 0).nth(5)).toHaveText("منتهٍ: جواز السفر");
  await expect(cells(page, 0).nth(6)).toHaveText("بغداد");
  await expect(cells(page, 0).nth(7)).toHaveText("الكرخ");
  await expect(cells(page, 1).nth(3)).toHaveText("2");
  await expect(cells(page, 1).nth(4)).toHaveText("فصيلة الدم، رقم الهاتف");
  await page.locator("#report-data").selectOption("missing");
  await expect(page.locator("#report-table tbody tr")).toHaveCount(1);
  await page.locator("#report-data").selectOption("all");
  await page.locator("#report-docs").selectOption("expired");
  await expect(page.locator("#report-table tbody tr")).toHaveCount(1);
  await expect(cells(page, 0).nth(2)).toHaveText("موظف 1");
});

test("inactive employees are left out unless asked for, and headings sort the rows", async ({ page }) => {
  await openReports(page, [person(1, { full_name: "باسم" }), person(2, { full_name: "أحمد", is_active: 0 }), person(3, { full_name: "جاسم" })]);
  await expect(page.locator("#report-table tbody tr")).toHaveCount(2);
  await page.locator("#report-status").selectOption("all");
  await columns(page, ["full_name"]);
  await page.locator('[data-sort="full_name"]').click();
  await expect(page.locator("#report-table tbody tr td:nth-child(3)")).toHaveText(["أحمد", "باسم", "جاسم"]);
  await page.locator('[data-sort="full_name"]').click();
  await expect(page.locator("#report-table tbody tr td:nth-child(3)")).toHaveText(["جاسم", "باسم", "أحمد"]);
});

test("Excel gets real dates, empty cells, an Arabic file name, and is logged by the program", async ({ page }) => {
  await openReports(page, [person(1, { passport_expiry_date: "2027-02-03", phone: "" })]);
  await columns(page, ["full_name", "passport_expiry_date", "phone", "blood_type"]);
  await page.locator("#report-excel").click();
  await expect.poll(() => page.evaluate(() => window.calls.filter(c => c.command === "cmd_save_report_xlsx").length)).toBe(1);
  const { dialog, saved } = await page.evaluate(() => ({ dialog: window.calls.find(c => c.command === "plugin:dialog|save").args.options, saved: window.calls.find(c => c.command === "cmd_save_report_xlsx").args }));
  expect(dialog.defaultPath).toMatch(/^تقرير الموظفين \d{4}-\d{2}-\d{2}\.xlsx$/);
  expect(saved.rows).toEqual([["موظف 1", "2027-02-03", "", "O+"]]);
  expect(saved.dateColumns).toEqual([1]);
});

test("printing many columns splits them over pages, names the company and date, and is logged", async ({ page }) => {
  await openReports(page, [person(1), person(2)]);
  await page.evaluate(() => { window.print = () => {}; HTMLIFrameElement.prototype.focus = () => {}; });
  await page.locator("#report-select-all").click();
  await page.locator("#report-print").click();
  await expect.poll(() => page.evaluate(() => window.calls.filter(c => c.command === "cmd_audit_report_print").length)).toBe(1);
  const printed = await page.evaluate(() => {
    const doc = [...document.querySelectorAll("iframe")].pop().contentDocument;
    doc.defaultView.print = () => {};
    return { sections: doc.querySelectorAll("section").length, headings: [...doc.querySelectorAll("section:nth-of-type(2) th")].slice(0, 2).map(th => th.textContent), meta: doc.querySelector(".meta").textContent, unit: doc.querySelector(".report-head p").textContent };
  });
  expect(printed.sections).toBeGreaterThan(1);
  expect(printed.headings).toEqual(["ت", "الاسم الرباعي واللقب"]);
  expect(printed.meta).toContain("عدد الموظفين: 2");
  expect(printed.meta).toContain("تاريخ الطباعة");
  expect(printed.unit).toContain("قسم الإعدادات");
  const audit = await page.evaluate(() => window.calls.find(c => c.command === "cmd_audit_report_print").args);
  expect(audit.employeeCount).toBe(2);
});

test("blood type, numbers and dates are kept left-to-right", async ({ page }) => {
  await openReports(page, [person(1)]);
  await columns(page, ["blood_type", "employee_number"]);
  await expect(cells(page, 0).nth(2)).toHaveCSS("direction", "ltr");
  await expect(cells(page, 0).nth(3)).toHaveCSS("white-space", "nowrap");
});

test("a vehicle in the vehicles list counts for the document status (and the expiry reminders)", async ({ page }) => {
  await openReports(page, [person(1, { vehicles: JSON.stringify([{ plate: "1", expiry_date: iso(-5) }, { plate: "2", expiry_date: iso(400) }]) })]);
  await columns(page, ["documents_status"]);
  await expect(cells(page, 0).nth(2)).toHaveText("منتهٍ: سنوية المركبة");
});
