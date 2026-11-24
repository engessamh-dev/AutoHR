/**
 * error-log.js — sends technical errors to the local error log (src-tauri/src/errlog.rs),
 * which the program check («فحص البرنامج») shows under «آخر الأخطاء التقنية».
 *
 * Only technical failures are sent: commands that failed with the generic database/other error
 * and unexpected script exceptions. Input mistakes and permission refusals are not. Rust removes
 * paths, file names, long numbers, e-mail addresses and passwords before anything is written.
 */
import { invoke as tauriInvoke } from "@tauri-apps/api/core";

const TECHNICAL_MESSAGES = new Set([
  "The database operation could not be completed",
  "The operation could not be completed",
]);
const MAX_PER_MINUTE = 30;

let currentScreen = "login";
let windowStart = 0;
let sentInWindow = 0;

export function setErrorScreen(screen) {
  currentScreen = String(screen || "");
}

function send(operation, message, stack) {
  const now = Date.now();
  if (now - windowStart > 60_000) { windowStart = now; sentInWindow = 0; }
  if (++sentInWindow > MAX_PER_MINUTE) return;
  tauriInvoke("cmd_log_client_error", {
    operation: String(operation || "").slice(0, 80),
    screen: currentScreen.slice(0, 40),
    message: String(message ?? "").slice(0, 600),
    stack: stack ? String(stack).slice(0, 2000) : null,
  }).catch(() => {});
}

/** Same as Tauri's invoke, but technical failures are written to the local error log. */
export function invoke(command, args, options) {
  return tauriInvoke(command, args, options).catch((error) => {
    if (typeof error !== "string") send(command, error?.message || String(error), error?.stack);
    else if (TECHNICAL_MESSAGES.has(error)) send(command, error, "");
    throw error;
  });
}

let installed = false;
/** Records uncaught script exceptions and rejected promises that nothing handled. */
export function installErrorReporting() {
  if (installed) return;
  installed = true;
  window.addEventListener("error", (event) => {
    if (!event.message && !event.error) return; // a resource (image, script) failed to load
    send("window.onerror", event.error?.message || event.message, event.error?.stack || `${event.filename || ""}:${event.lineno || 0}:${event.colno || 0}`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    // Command errors are strings and were already handled by invoke above.
    if (typeof reason === "string") return;
    send("unhandledrejection", reason?.message || String(reason), reason?.stack);
  });
}
