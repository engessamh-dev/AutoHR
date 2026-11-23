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
  dark:   "الأصلي (داكن)",
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

/** Header button: each click moves to the next mode (light → dark → Windows). */
const CYCLE = ["light", "dark", "system"];

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
