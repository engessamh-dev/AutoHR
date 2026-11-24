import { test, expect } from "@playwright/test";

// Light / dark appearance: chosen with the header button, kept per machine; two modes only.
test.beforeEach(async ({ page }) => { await page.goto("/tests/scanner-harness.html"); await page.waitForFunction(() => window.ready); });

const theme = page => page.evaluate(() => document.documentElement.dataset.theme);

test("settings has no appearance tab: the header button is the one place to switch", async ({ page }) => {
  await page.evaluate(() => window.renderActual("settings"));
  await expect(page.locator('[data-settings-tab="appearance"]')).toHaveCount(0);
  await expect(page.locator("[data-theme-option]")).toHaveCount(0);
});

test("an old follow-Windows choice falls back to the original", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.evaluate(async () => {
    localStorage.setItem("autohr.theme", "system");
    const { initTheme, getThemeChoice } = await import("/src/theme.js");
    initTheme();
    window.__choice = getThemeChoice();
  });
  expect(await page.evaluate(() => window.__choice)).toBe("dark");
  expect(await theme(page)).toBe("dark");
});

test("dialogs use the theme colours", async ({ page }) => {
  await page.evaluate(async () => (await import("/src/theme.js")).setThemeChoice("light"));
  await page.evaluate(async () => { (await import("/src/utils.js")).confirmAction("تأكيد؟"); });
  const dialog = page.locator('[role="dialog"], [role="alertdialog"]').first();
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(el => getComputedStyle(el).backgroundColor)).toBe("rgb(255, 255, 255)");
});

test("header sun button toggles light and the original", async ({ page }) => {
  await page.evaluate(async () => {
    document.querySelector("#root").innerHTML = `<button id="btn-theme"></button>`;
    const { mountThemeMenu, setThemeChoice } = await import("/src/theme.js");
    setThemeChoice("dark");
    mountThemeMenu(document.getElementById("btn-theme"));
  });
  const button = page.locator("#btn-theme");
  const choice = () => page.evaluate(() => localStorage.getItem("autohr.theme"));
  await button.click(); expect(await choice()).toBe("light");
  expect(await theme(page)).toBe("light");
  await expect(button).toHaveAttribute("title", /الأصلي/);
  await button.click(); expect(await choice()).toBe("dark");
  expect(await theme(page)).toBe("dark");
  await button.click(); expect(await choice()).toBe("light");
});
