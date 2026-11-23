import { test, expect } from "@playwright/test";

// Light / dark appearance: chosen in Settings, kept per machine, optional follow-Windows.
test.beforeEach(async ({ page }) => { await page.goto("/tests/scanner-harness.html"); await page.waitForFunction(() => window.ready); });

const theme = page => page.evaluate(() => document.documentElement.dataset.theme);
const bg = (page, selector) => page.locator(selector).first().evaluate(el => getComputedStyle(el).backgroundColor);

test("settings appearance tab switches light and dark and remembers the choice", async ({ page }) => {
  await page.evaluate(() => window.renderActual("settings"));
  await page.locator('[data-settings-tab="appearance"]').click();
  await page.locator('[data-theme-option="light"]').click();
  expect(await theme(page)).toBe("light");
  expect(await page.evaluate(() => localStorage.getItem("autohr.theme"))).toBe("light");
  await expect(page.locator('[data-theme-option="light"]')).toHaveAttribute("aria-checked", "true");
  expect(await bg(page, ".card")).toBe("rgb(255, 255, 255)");
  await page.locator('[data-theme-option="dark"]').click();
  expect(await theme(page)).toBe("dark");
  expect(await bg(page, ".card")).not.toBe("rgb(255, 255, 255)");
});

test("follow Windows tracks the system colour scheme live", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(async () => {
    const { setThemeChoice, initTheme } = await import("/src/theme.js");
    initTheme();
    setThemeChoice("system");
  });
  expect(await theme(page)).toBe("dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect.poll(() => theme(page)).toBe("light");
});

test("dialogs use the theme colours", async ({ page }) => {
  await page.evaluate(async () => (await import("/src/theme.js")).setThemeChoice("light"));
  await page.evaluate(async () => { (await import("/src/utils.js")).confirmAction("تأكيد؟"); });
  const dialog = page.locator('[role="dialog"], [role="alertdialog"]').first();
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(el => getComputedStyle(el).backgroundColor)).toBe("rgb(255, 255, 255)");
});

test("header sun button cycles light, dark and follow Windows", async ({ page }) => {
  await page.evaluate(async () => {
    document.querySelector("#root").innerHTML = `<button id="btn-theme"></button>`;
    const { mountThemeMenu, setThemeChoice } = await import("/src/theme.js");
    setThemeChoice("dark");
    mountThemeMenu(document.getElementById("btn-theme"));
  });
  const button = page.locator("#btn-theme");
  const choice = () => page.evaluate(() => localStorage.getItem("autohr.theme"));
  await button.click(); expect(await choice()).toBe("system");
  await expect(button).toHaveAttribute("title", /حسب إعداد Windows/);
  await button.click(); expect(await choice()).toBe("light");
  expect(await theme(page)).toBe("light");
  await button.click(); expect(await choice()).toBe("dark");
  expect(await theme(page)).toBe("dark");
});
