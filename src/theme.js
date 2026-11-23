/**
 * theme.js — Light / dark appearance.
 *
 * The choice is kept per machine in localStorage (no database change):
 *   "dark"   — the original look (lightened navy, default)
 *   "light"  — light look
 * Anything else saved earlier (for example "system") falls back to "dark".
 * The resolved mode is written to <html data-theme="…">; main.css maps every
 * screen colour from that attribute. Printouts and the login screen are fixed
 * designs and do not change.
 */
import { getCurrentWindow } from "@tauri-apps/api/window";

const STORAGE_KEY = "autohr.theme";
const CHOICES = ["dark", "light"];
const listeners = new Set();

export const themeLabels = {
  dark:   "الأصلي (داكن)",
  light:  "فاتح",
};

export function getThemeChoice() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (CHOICES.includes(saved)) return saved;
  } catch {}
  return "dark";
}

export function resolveTheme(choice = getThemeChoice()) {
  return choice === "light" ? "light" : "dark";
}

function apply() {
  const choice = getThemeChoice();
  const mode = resolveTheme(choice);
  document.documentElement.dataset.theme = mode;
  // Keep the Windows title bar in step; harmless if the API is unavailable.
  try {
    getCurrentWindow().setTheme(mode).catch(() => {});
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
}

const ICONS = {
  dark:   `<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>`,
  light:  `<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>`,
};

export function themeIcon(choice) {
  return `<svg class="theme-icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[choice] ?? ICONS.dark}</svg>`;
}

/** Header button: each click toggles between light and the original. */
const CYCLE = ["light", "dark"];

export function mountThemeMenu(button) {
  if (!button) return;
  const nextOf = choice => CYCLE[(CYCLE.indexOf(choice) + 1) % CYCLE.length];
  const sync = () => {
    const choice = getThemeChoice();
    button.innerHTML = themeIcon(choice);
    const label = `المظهر: ${themeLabels[choice]} (اضغط للتبديل إلى: ${themeLabels[nextOf(choice)]})`;
    button.title = label;
    button.setAttribute("aria-label", label);
  };
  button.addEventListener("click", () => setThemeChoice(nextOf(getThemeChoice())));
  onThemeChange(sync);
  sync();
}
