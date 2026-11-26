import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const runner = source.slice(source.indexOf("async function runShutdownAutomaticBackups({"), source.indexOf("async function notifyDocumentAlerts()"));
const logout = source.slice(source.indexOf("async function doLogout()"), source.indexOf("// ── Bootstrap"));
const closeStart = source.indexOf("  getCurrentWindow().onCloseRequested(");
const close = source.slice(closeStart, source.indexOf("\n  // First run", closeStart));

function harness({ fail = false } = {}) {
  const calls = [];
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const element = {
    classList: { add() {}, remove() {} }, reset() {}, value: "", textContent: "",
  };
  const context = vm.createContext({
    calls,
    api: {
      async runDueAutoBackups() {
        calls.push("backup-start");
        await pending;
        if (fail) throw new Error("Verification failed");
        calls.push("backup-verified");
        return ["daily"];
      },
      async logout() { calls.push("logout"); },
      async exitApp() { calls.push("exit"); },
    },
    document: { getElementById: () => element },
    window: {},
    getCurrentWindow: () => ({ onCloseRequested(fn) { context.closeHandler = fn; } }),
    confirmAction: async () => true,
    clearLoginMessage: () => {},
    applyUiScale: () => {},
    clearAddEmployeeDraft: () => {},
    confirmLeaveWhileBusy: async () => true,
    stopInSessionBackups: () => {},
    listen: async () => () => {},
    requestAnimationFrame: fn => fn(),
    setTimeout: fn => { fn(); },
    notifyWindows: async title => { calls.push(`notification:${title}`); },
    openAutomaticBackupProgress: () => { throw new Error("No progress event expected in mock"); },
  });
  vm.runInContext(`let automaticBackupPromise = null; let inSessionBackupPromise = null; let isClosingWindow = false; let currentUser = { username: 'test' };\n${runner}\n${logout}\n${close}`, context);
  return { context, calls, finish };
}

for (const action of ["logout", "close"]) {
  test(`${action} waits for verified automatic backup`, async () => {
    const h = harness();
    const operation = action === "logout"
      ? h.context.doLogout()
      : h.context.closeHandler({ preventDefault() { h.calls.push("prevent-close"); } });
    // Allow the real shutdown runner to reach its asynchronous backup call.
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(h.calls.includes("backup-start"));
    assert.ok(!h.calls.includes("logout") && !h.calls.includes("exit"));
    h.finish();
    await operation;
    const end = action === "logout" ? "logout" : "exit";
    assert.ok(h.calls.indexOf(end) > h.calls.indexOf("backup-verified"));
  });

  test(`${action} reports backup failure and continues (current behavior)`, async () => {
    const h = harness({ fail: true });
    const operation = action === "logout"
      ? h.context.doLogout()
      : h.context.closeHandler({ preventDefault() {} });
    h.finish();
    await operation;
    assert.ok(h.calls.some(call => call.startsWith("notification:")));
    assert.ok(!h.calls.includes("backup-verified"));
    assert.ok(h.calls.includes(action === "logout" ? "logout" : "exit"));
  });
}
