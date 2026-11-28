import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const runner = source.slice(source.indexOf("async function runShutdownAutomaticBackups({"), source.indexOf("async function notifyDocumentAlerts()"));
const logout = source.slice(source.indexOf("async function doLogout()"), source.indexOf("// ── Bootstrap"));
const closeStart = source.indexOf("  getCurrentWindow().onCloseRequested(");
const close = source.slice(closeStart, source.indexOf("\n  // First run", closeStart));

function harness({ fail = 0, choices = [], unsaved = "", keepUnsaved = true } = {}) {
  const calls = [];
  let failures = fail === true ? Infinity : fail;
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
        if (failures > 0) { failures -= 1; throw "تعذر التحقق من النسخة الاحتياطية الجديدة"; }
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
    unsavedAddEmployeeWork: () => unsaved,
    confirmLoseAddEmployeeWork: async () => {
      if (!unsaved) return true;
      calls.push("asked-unsaved-employee");
      return !keepUnsaved;
    },
    confirmLeaveWhileBusy: async () => true,
    stopInSessionBackups: () => {},
    stopDocumentAlertChecks: () => {},
    startInSessionBackups: () => { calls.push("checks-restarted"); },
    startDocumentAlertChecks: () => {},
    chooseAction: async (message, options) => {
      calls.push(`asked:${options.choices.map(c => c.label).join("|")}`);
      return choices.shift() ?? "stay";
    },
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

  test(`${action}: a failed backup stops and offers retry, stay, or go on without a new copy`, async () => {
    const h = harness({ fail: true, choices: ["stay"] });
    h.finish();
    await (action === "logout" ? h.context.doLogout() : h.context.closeHandler({ preventDefault() {} }));
    const asked = h.calls.find(call => call.startsWith("asked:"));
    assert.ok(asked, "the user is asked");
    const end = action === "close" ? "الإغلاق" : "تسجيل الخروج";
    assert.equal(asked, `asked:إعادة المحاولة|البقاء في البرنامج|${end} بدون نسخة جديدة`);
    assert.ok(!h.calls.includes("logout") && !h.calls.includes("exit"), "«البقاء في البرنامج» keeps the program open");
    assert.ok(h.calls.includes("checks-restarted"));
  });

  test(`${action}: «إعادة المحاولة» tries again and goes on once the backup is verified`, async () => {
    const h = harness({ fail: 1, choices: ["retry"] });
    h.finish();
    await (action === "logout" ? h.context.doLogout() : h.context.closeHandler({ preventDefault() {} }));
    assert.equal(h.calls.filter(call => call === "backup-start").length, 2);
    const end = action === "logout" ? "logout" : "exit";
    assert.ok(h.calls.indexOf(end) > h.calls.indexOf("backup-verified"));
  });

  test(`${action}: going on without a new copy is the user's choice, and is said`, async () => {
    const h = harness({ fail: true, choices: ["retry", "continue"] });
    h.finish();
    await (action === "logout" ? h.context.doLogout() : h.context.closeHandler({ preventDefault() {} }));
    assert.equal(h.calls.filter(call => call === "backup-start").length, 2);
    assert.ok(h.calls.some(call => call === "notification:فشل النسخ التلقائي"));
    assert.ok(h.calls.includes(action === "logout" ? "logout" : "exit"));
  });
}

for (const action of ["logout", "close"]) {
  test(`${action} with an unsaved new employee asks first and stops when the user stays`, async () => {
    const h = harness({ unsaved: "لديك مسودة موظف لم يُحفظ.", keepUnsaved: true });
    await (action === "logout"
      ? h.context.doLogout()
      : h.context.closeHandler({ preventDefault() { h.calls.push("prevent-close"); } }));
    assert.ok(h.calls.includes("asked-unsaved-employee"));
    assert.ok(!h.calls.includes("logout") && !h.calls.includes("exit") && !h.calls.includes("backup-start"));
  });
}
