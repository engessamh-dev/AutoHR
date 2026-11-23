/**
 * theme.js — Light / dark appearance.
 *
 * The choice is kept per machine in localStorage (no database change):
 *   "dark"   — the original dark look (default)
 *   "light"  — light look
 *   "system" — follow the Windows app colour setting, live
 * The resolved mode is written to <html data-theme="…">; main.css maps every
 * screen colour from that attribute. Printouts and the login screen are fixed
 * designs and do not change.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";

const STORAGE_KEY = "autohr.theme";
const CHOICES = ["dark", "light", "system"];
const systemQuery = window.matchMedia?.("(prefers-color-scheme: light)");
const listeners = new Set();

export const themeLabels = {
  dark:   "داكن",
  light:  "فاتح",
  system: "حسب إعداد Windows",
};

export function getThemeChoice() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (CHOICES.includes(saved)) return saved;
  } catch {}
  return "dark";
}

export function resolveTheme(choice = getThemeChoice()) {
  if (choice === "system") return systemQuery?.matches ? "light" : "dark";
  return choice === "light" ? "light" : "dark";
}

function apply() {
  const choice = getThemeChoice();
  const mode = resolveTheme(choice);
  document.documentElement.dataset.theme = mode;
  // Keep the Windows title bar in step; harmless if the API is unavailable.
  try {
    getCurrentWindow().setTheme(choice === "system" ? null : mode).catch(() => {});
  } catch {}
  listeners.forEach(fn => { try { fn(choice, mode); } catch {} });
}

export function setThemeChoice(choice) {
  if (!CHOICES.includes(choice)) return;
  try { localStorage.setItem(STORAGE_KEY, choice); } catch {}
  apply();
}

export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function initTheme() {
  apply();
  systemQuery?.addEventListener?.("change", () => {
    if (getThemeChoice() === "system") apply();
  });
}

const ICONS = {
  dark:   `<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>`,
  light:  `<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>`,
  system: `<rect x="3" y="4" width="18" height="12" rx="1.5"/><path d="M8 20h8M12 16v4"/>`,
};

export function themeIcon(choice) {
  return `<svg class="theme-icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[choice] ?? ICONS.dark}</svg>`;
}

/** Header button: opens a small menu with the three choices. */
export function mountThemeMenu(button) {
  if (!button) return;
  const menu = document.createElement("div");
  menu.className = "theme-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  menu.innerHTML = CHOICES.map(choice => `
    <button type="button" role="menuitemradio" class="theme-menu-item" data-theme-choice="${choice}">
      ${themeIcon(choice)}<span>${themeLabels[choice]}</span>
    </button>`).join("");
  button.after(menu);

  const sync = () => {
    const choice = getThemeChoice();
    button.innerHTML = themeIcon(choice);
    const label = `المظهر: ${themeLabels[choice]}`;
    button.title = label;
    button.setAttribute("aria-label", label);
    menu.querySelectorAll("[data-theme-choice]").forEach(item =>
      item.setAttribute("aria-checked", String(item.dataset.themeChoice === choice)));
  };
  const close = () => { menu.hidden = true; button.setAttribute("aria-expanded", "false"); };
  const open = () => {
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    menu.querySelector('[aria-checked="true"]')?.focus();
  };

  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.addEventListener("click", e => { e.stopPropagation(); menu.hidden ? open() : close(); });
  menu.addEventListener("click", e => {
    const item = e.target.closest("[data-theme-choice]");
    if (!item) return;
    setThemeChoice(item.dataset.themeChoice);
    close();
    button.focus();
  });
  menu.addEventListener("keydown", e => {
    const items = [...menu.querySelectorAll("[data-theme-choice]")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "Escape") { close(); button.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  });
  document.addEventListener("click", e => { if (!menu.hidden && !menu.contains(e.target)) close(); });
  onThemeChange(sync);
  sync();
}
