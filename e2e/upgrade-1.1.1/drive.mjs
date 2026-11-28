// Drives the INSTALLED CNSArch app (real binary, real WebView2) over the WebView2 DevTools port.
// Fake data only. Runs on a throwaway GitHub Actions Windows VM.
// Usage: node drive.mjs <step>   (steps: seed105, update105, verify, other-install, missing-admin)
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";

const ROOT = "C:\\CNSTest";
const OUT = process.env.OUT_DIR || path.join(ROOT, "out");
const STATE = path.join(ROOT, "state.json");
fs.mkdirSync(OUT, { recursive: true });

const PW = {
  admin105: "Sysadmin#2026a",
  adminRecovered: "Rq8#Vt3Lmwa",
  adminRecovered2: "Rq8#Vt3Lmwb",
  adminRecovered3: "Rq8#Vt3Lmwc",
  archadmin: "Archadmin#2026a",
  officer: "Officer#2026a",
  viewer: "Viewer#2026a",
  backup: "Backup#2026a",
  other: "Kx7#Pq92Lmz",
};

const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, "utf8")) : {};
const saveState = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));
const resultsFile = path.join(OUT, "results.json");
const results = fs.existsSync(resultsFile) ? JSON.parse(fs.readFileSync(resultsFile, "utf8")) : [];
const step = process.argv[2];
function log(point, name, ok, detail) {
  const entry = { step, point, name, ok, detail, at: new Date().toISOString() };
  results.push(entry);
  fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
  console.log(`${ok === true ? "PASS" : ok === false ? "FAIL" : "INFO"} [${point}] ${name}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = buf => crypto.createHash("sha256").update(buf).digest("hex");

let browser, page;
async function connect() {
  for (let i = 0; i < 90; i++) {
    try {
      browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
      break;
    } catch { await sleep(2000); }
  }
  if (!browser) throw new Error("could not reach the app's DevTools port");
  for (let i = 0; i < 60; i++) {
    page = browser.contexts().flatMap(c => c.pages()).find(p => /tauri\.localhost|^tauri:/.test(p.url()));
    if (page) break;
    await sleep(1000);
  }
  if (!page) throw new Error("no app page: " + browser.contexts().flatMap(c => c.pages()).map(p => p.url()).join(","));
  page.on("dialog", d => d.dismiss().catch(() => {}));
  await page.waitForFunction(() => !!window.__TAURI_INTERNALS__, null, { timeout: 60000 });
  await sleep(2500);
}
async function shot(name) {
  try { await page.screenshot({ path: path.join(OUT, `${step}-${name}.png`) }); } catch (e) { console.log("screenshot failed", e.message); }
}
async function invoke(cmd, args = {}) {
  return page.evaluate(async ([c, a]) => {
    try { return { ok: true, value: await window.__TAURI_INTERNALS__.invoke(c, a) }; }
    catch (e) { return { ok: false, error: typeof e === "string" ? e : (e?.message ?? JSON.stringify(e)) }; }
  }, [cmd, args]);
}
async function must(cmd, args) {
  const r = await invoke(cmd, args);
  if (!r.ok) throw new Error(`${cmd} failed: ${r.error}`);
  return r.value;
}
async function readDoc(rel) {
  return page.evaluate(async r => {
    try {
      const v = await window.__TAURI_INTERNALS__.invoke("cmd_read_document", { relativePath: r });
      const bytes = new Uint8Array(v instanceof ArrayBuffer ? v : (v.buffer ?? v));
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return { ok: true, size: bytes.length, sha: [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("") };
    } catch (e) { return { ok: false, error: typeof e === "string" ? e : (e?.message ?? String(e)) }; }
  }, rel);
}
// Opens an employee attachment the way the employee screen does: through the asset protocol.
async function readAsset(full) {
  return page.evaluate(async f => {
    try {
      const url = window.__TAURI_INTERNALS__.convertFileSrc(f, "asset");
      const res = await fetch(url);
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const bytes = new Uint8Array(await res.arrayBuffer());
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return { ok: true, size: bytes.length, sha: [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("") };
    } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
  }, full);
}
async function appVersion() {
  const r = await invoke("plugin:app|version");
  return r.ok ? r.value : `unknown (${r.error})`;
}
function attachmentPaths(emp) {
  const out = [];
  const walk = (v, k) => {
    if (typeof v === "string" && /^\[/.test(v.trim())) { try { return walk(JSON.parse(v), k); } catch {} }
    if (typeof v === "string" && /\.(jpe?g|png|pdf)$/i.test(v) && /^(\\\\\?\\)?[A-Za-z]:\\/.test(v)) out.push({ key: k, rel: v });
    else if (v && typeof v === "object") for (const [kk, vv] of Object.entries(v)) walk(vv, kk);
  };
  walk(emp, "");
  // General attachments carry only their relative path: same data folder as the card.
  const card = emp?.civil_id_front_full_path, cardRel = emp?.civil_id_front_path;
  let rels = emp?.attachment_paths;
  if (typeof rels === "string") { try { rels = JSON.parse(rels); } catch { rels = []; } }
  if (card && cardRel && Array.isArray(rels)) {
    const base = card.slice(0, card.length - cardRel.length);
    for (const r of rels) out.push({ key: "attachment_paths", rel: base + String(r).replace(/\//g, "\\") });
  }
  return [...new Map(out.map(o => [o.rel.replace(/^\\\\\?\\/, "").toLowerCase(), o])).values()];
}
function vehiclesOf(emp) {
  let v = emp?.vehicles;
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { v = []; } }
  return Array.isArray(v) ? v : [];
}
function ps(cmd) {
  return execSync(`powershell -NoProfile -Command "${cmd.replace(/"/g, '\\"')}"`, { encoding: "utf8" });
}

// ── UI helpers (1.1.1) ──────────────────────────────────────────────────────
async function dismissOverlays() {
  for (let i = 0; i < 4; i++) {
    const btn = page.locator(".app-dialog button, [role=dialog] button").filter({ hasText: /^(حسنًا|حسنا|تم|إغلاق|فهمت|متابعة)$/ });
    if (await btn.count()) { await btn.first().click().catch(() => {}); await sleep(600); } else break;
  }
}
async function uiLogin(username, password) {
  await page.reload(); await sleep(3000);
  await page.waitForSelector("#login-username", { state: "visible", timeout: 30000 });
  await page.fill("#login-username", username);
  await page.fill("#login-password", password);
  await page.press("#login-password", "Enter");
  await page.waitForSelector("#app-shell:not(.hidden)", { timeout: 30000 });
  await sleep(2500);
  await dismissOverlays();
}

// ── Steps ───────────────────────────────────────────────────────────────────
async function seed105() {
  await connect();
  log("setup", "installed version before upgrade", null, await appVersion());
  const status = await must("cmd_get_startup_status");
  log("setup", "startup status", null, status);
  for (const d of ["data", "backup", "src"]) fs.mkdirSync(path.join(ROOT, d), { recursive: true });
  if (status?.state !== "ready") {
    await must("cmd_complete_setup", { dataRoot: path.join(ROOT, "data"), backupRoot: path.join(ROOT, "backup") });
    await page.reload(); await sleep(3000);
  }
  await shot("login-1.0.5");
  const login = await must("cmd_login", { username: "sysadmin", password: "password" });
  log("setup", "1.0.5 first sign-in sysadmin/password", null, { role: login.role, must_change_password: login.must_change_password });
  await must("cmd_change_password", { currentPassword: "password", newPassword: PW.admin105 });

  for (const [username, role, password] of [["archadmin", "archive_admin", PW.archadmin], ["officer1", "archive_officer", PW.officer], ["viewer1", "viewer", PW.viewer]]) {
    const u = await must("cmd_create_user", { data: { username, password: password + "0", role } });
    state[username] = u.id;
  }
  // New accounts must set their own password at first sign-in (as a real user would have done in 1.0.5).
  for (const [username, password] of [["archadmin", PW.archadmin], ["officer1", PW.officer], ["viewer1", PW.viewer]]) {
    await must("cmd_login", { username, password: password + "0" });
    await must("cmd_change_password", { currentPassword: password + "0", newPassword: password });
  }
  await must("cmd_login", { username: "sysadmin", password: PW.admin105 });
  log("setup", "1.0.5 users created", null, (await must("cmd_list_users")).map(u => `${u.username}:${u.role}`));

  // Point 1: only «تاريخ المباشرة» (hire_date), no «تاريخ التعيين».
  const e1 = await must("cmd_create_employee", { data: { full_name: "سامر خالد عبد الله التجريبي", employee_number: "T-001", hire_date: "2020-03-01", job_title: "موظف تجريبي", civil_id: "199000000101" } });
  // And one with both dates, to check neither moves.
  const e1b = await must("cmd_create_employee", { data: { full_name: "هدى علي حسن التجريبية", employee_number: "T-002", hire_date: "2019-05-12", appointment_date: "2018-11-01", civil_id: "199000000102" } });
  // Point 2a: only a colour in the old single-vehicle columns.
  const e2 = await must("cmd_create_employee", { data: { full_name: "كريم جاسم محمد التجريبي", employee_number: "T-003", vehicle_color: "أبيض", civil_id: "199000000103" } });
  // Point 2b: the same vehicle renewed in the list; old columns hold the old dates + colour/year.
  const renewed = [{ plate: "12345 بغداد", brand: "تويوتا", annual_no: "AN-5555", issue_date: "2026-01-10", expiry_date: "2027-01-10" }];
  const e3 = await must("cmd_create_employee", { data: { full_name: "رنا فاضل كاظم التجريبية", employee_number: "T-004", civil_id: "199000000104",
    vehicles: JSON.stringify(renewed),
    vehicle_plate: "12345  بغداد", vehicle_color: "أسود", vehicle_manufacture_year: "2015",
    vehicle_annual_issue_date: "2024-01-10", vehicle_annual_expiry_date: "2025-01-10" } });
  // Point 2c: an old plate different from the one in the list.
  const e4 = await must("cmd_create_employee", { data: { full_name: "علي حميد ناصر التجريبي", employee_number: "T-005", civil_id: "199000000105",
    vehicles: JSON.stringify([{ plate: "55555 البصرة", brand: "كيا", color: "رمادي", expiry_date: "2027-06-01" }]),
    vehicle_plate: "99999 أربيل", vehicle_name: "هيونداي", vehicle_color: "أحمر", vehicle_manufacture_year: "2012",
    vehicle_annual_no: "AN-9999", vehicle_annual_expiry_date: "2023-03-03" } });
  Object.assign(state, { e1: e1.id, e1b: e1b.id, e2: e2.id, e3: e3.id, e4: e4.id });

  // Attachments (fake files written by the workflow).
  const front = path.join(ROOT, "src", "card-front.jpg");
  const pdf = path.join(ROOT, "src", "letter.pdf");
  const up1 = await invoke("cmd_upload_national_card_attachment", { employeeId: e1.id, side: "front", sourcePath: front });
  const up2 = await invoke("cmd_upload_attachment", { employeeId: e1.id, sourcePath: pdf });
  log("setup", "1.0.5 attachments uploaded", up1.ok && up2.ok ? null : false, { card: up1, pdf: up2 });
  state.srcSha = { card: sha(fs.readFileSync(front)), pdf: sha(fs.readFileSync(pdf)) };

  const before = {};
  for (const k of ["e1", "e1b", "e2", "e3", "e4"]) {
    const e = await must("cmd_get_employee", { id: state[k] });
    before[k] = { hire_date: e.hire_date, appointment_date: e.appointment_date, vehicles: vehiclesOf(e),
      old: { plate: e.vehicle_plate, color: e.vehicle_color, year: e.vehicle_manufacture_year, issue: e.vehicle_annual_issue_date, expiry: e.vehicle_annual_expiry_date } };
  }
  state.before = before;
  log("setup", "1.0.5 data as stored before upgrade", null, before);

  const b1 = await must("cmd_create_backup", { password: PW.backup });
  state.backup105 = b1;
  log("setup", "1.0.5 backup created", null, b1);
  await must("cmd_logout");
  saveState();
  await shot("done");
}

async function update105() {
  await connect();
  log("updater", "version before", null, await appVersion());
  await must("cmd_login", { username: "sysadmin", password: PW.admin105 });
  const info = await invoke("cmd_check_for_update");
  log("updater", "1.0.5 check for update", info.ok && info.value?.available !== false ? null : false, info);
  // The same command the Settings button calls; it makes a PreUpdate backup, downloads the
  // published installer, checks its signature and runs it. The app then exits.
  page.evaluate(p => window.__TAURI_INTERNALS__.invoke("cmd_install_update", { password: p }).then(
    () => console.log("install_update returned"), e => console.log("install_update error", e)), PW.backup).catch(() => {});
  const msgs = [];
  page.on("console", m => msgs.push(m.text()));
  await sleep(15000);
  log("updater", "console during install", null, msgs.slice(-10));
}

async function section(point, fn) {
  try { await fn(); }
  catch (e) {
    let text = "";
    try { text = await page.evaluate(() => [...document.querySelectorAll("body *")].filter(el => el.offsetParent && el.children.length === 0 && el.innerText?.trim()).map(el => el.innerText.trim()).slice(0, 80).join(" | ")); } catch {}
    log(point, "section stopped", false, { error: e.message.split("\n")[0], screenText: text.slice(0, 1500) });
    await shot(`error-${point}`);
    await page.keyboard.press("Escape").catch(() => {});
  }
}

async function verify() {
  await connect();
  const version = await appVersion();
  log("upgrade", "version after upgrade", version === "1.1.1", version);
  await shot("01-login-after-upgrade");
  await must("cmd_login", { username: "sysadmin", password: PW.admin105 });

  await section("1-2", async () => {
  // ── Point 1 ──
  const e1 = await must("cmd_get_employee", { id: state.e1 });
  const e1b = await must("cmd_get_employee", { id: state.e1b });
  log("1", "start date kept (only start date)", e1.hire_date === "2020-03-01" && !e1.appointment_date,
    { before: state.before.e1, after: { hire_date: e1.hire_date, appointment_date: e1.appointment_date } });
  log("1", "both dates kept apart", e1b.hire_date === "2019-05-12" && e1b.appointment_date === "2018-11-01",
    { before: state.before.e1b, after: { hire_date: e1b.hire_date, appointment_date: e1b.appointment_date } });

  // ── Point 2 ──
  const e2 = await must("cmd_get_employee", { id: state.e2 });
  const v2 = vehiclesOf(e2);
  log("2", "colour-only old vehicle moved into the list", v2.length === 1 && v2[0].color === "أبيض", v2);
  const e3 = await must("cmd_get_employee", { id: state.e3 });
  const v3 = vehiclesOf(e3);
  log("2", "renewed vehicle keeps its new dates; colour/year filled", v3.length === 1 && v3[0].issue_date === "2026-01-10" && v3[0].expiry_date === "2027-01-10" && v3[0].color === "أسود" && String(v3[0].model_year) === "2015", v3);
  const e4 = await must("cmd_get_employee", { id: state.e4 });
  const v4 = vehiclesOf(e4);
  const old4 = v4.find(v => (v.plate || "").includes("99999"));
  log("2", "different old plate added as a second vehicle", v4.length === 2 && !!old4 && old4.color === "أحمر" && v4.some(v => (v.plate || "").includes("55555") && v.expiry_date === "2027-06-01"), v4);
  log("2", "old single-vehicle columns emptied", [e2, e3, e4].every(e => !e.vehicle_plate && !e.vehicle_color && !e.vehicle_annual_expiry_date),
    [e2, e3, e4].map(e => ({ plate: e.vehicle_plate ?? null, color: e.vehicle_color ?? null, expiry: e.vehicle_annual_expiry_date ?? null })));

  });
  await section("ui-1-2", async () => {
  // UI view of the vehicles of e4 and the dates of e1 (screenshots).
  await uiLogin("sysadmin", PW.admin105);
  await shot("02-dashboard-sysadmin");
  await page.click('.nav-item[data-screen="employees"]'); await sleep(2500);
  await shot("03-employees");
  for (const [key, label] of [["e1", "04-employee-e1"], ["e4", "05-employee-e4"]]) {
    const row = page.locator("tr, .emp-row, [data-id]").filter({ hasText: key === "e1" ? "سامر خالد" : "علي حميد" }).first();
    if (await row.count()) {
      await row.click().catch(() => {}); await sleep(2500); await shot(label);
      const tabs = page.locator("button, [role=tab]").filter({ hasText: key === "e1" ? /الوظيف|العمل/ : /المركبات/ });
      if (await tabs.count()) { await tabs.first().click().catch(() => {}); await sleep(1500); await shot(label + "-tab"); }
      await page.keyboard.press("Escape"); await sleep(800);
    }
  }

  });
  await section("4", async () => {
  // ── Point 4 ──
  const users = await must("cmd_list_users");
  const arch = users.find(u => u.username === "archadmin");
  log("4", "former archive admin is now «موظف» (archive_officer)", arch?.role === "archive_officer", users.map(u => `${u.username}:${u.role}`));
  const audit = await invoke("cmd_list_activity_log", { limit: 2000 });
  if (audit.ok) {
    const rows = (Array.isArray(audit.value) ? audit.value : audit.value?.rows || audit.value?.entries || []).filter(r => JSON.stringify(r).includes("CHANGE_USER_ROLE"));
    log("4", "role change written to the system log", rows.length > 0 ? true : null, rows.slice(0, 3));
  }
  const usersScreen = page.locator('.nav-item[data-screen="users"], [data-screen="users"]');
  if (await usersScreen.count()) { await usersScreen.first().click().catch(() => {}); await sleep(2500); await shot("06-users-as-sysadmin"); }

  await must("cmd_login", { username: "archadmin", password: PW.archadmin });
  const promoteOther = await invoke("cmd_update_user_role", { id: state.officer1, data: { role: "system_admin" } });
  log("4", "archadmin cannot make another user System Admin", !promoteOther.ok, promoteOther);
  const promoteSelf = await invoke("cmd_update_user_role", { id: state.archadmin, data: { role: "system_admin" } });
  log("4", "archadmin cannot make itself System Admin", !promoteSelf.ok, promoteSelf);
  const createAdmin = await invoke("cmd_create_user", { data: { username: "sneaky1", password: "Sneaky#2026a", role: "system_admin" } });
  log("4", "archadmin cannot create a System Admin", !createAdmin.ok, createAdmin);
  const inspect = await invoke("cmd_inspect_backup", { sourcePath: state.backup105, password: PW.backup });
  const restore = await invoke("cmd_restore_backup", { sourcePath: state.backup105, password: PW.backup });
  log("4", "archadmin cannot open/restore a backup", !inspect.ok && !restore.ok, { inspect, restore });
  await uiLogin("archadmin", PW.archadmin);
  await shot("07-archadmin-signed-in");
  const navs = await page.locator(".nav-item:visible").allTextContents();
  log("4", "archadmin sidebar (UI)", null, navs.map(s => s.trim()));
  const settingsNav = page.locator('.nav-item[data-screen="settings"]:visible');
  if (await settingsNav.count()) {
    await settingsNav.click(); await sleep(2000); await shot("08-archadmin-settings");
    const restoreBtn = await page.locator("button:visible").filter({ hasText: /استعادة/ }).count();
    log("4", "archadmin sees no restore button in Settings (UI)", restoreBtn === 0, { visibleRestoreButtons: restoreBtn });
  } else log("4", "archadmin has no Settings screen (UI)", true, "settings nav hidden");
  await must("cmd_login", { username: "sysadmin", password: PW.admin105 });

  });
  await section("6", async () => {
  // ── Point 6 (UI) ──
  await uiLogin("sysadmin", PW.admin105);
  await page.click('.nav-item[data-screen="employees"]'); await sleep(2000);
  await page.click("#btn-add-emp"); await sleep(1200);
  await page.click('[data-choice="docs"]'); await sleep(1500);
  const first = page.locator('[data-key="full_name"][data-part="first"]');
  let typed = false;
  if (await first.count()) { await first.fill("مسودة"); typed = true; }
  else {
    const anyInput = page.locator(".aw-overlay input[type=text]:visible").first();
    if (await anyInput.count()) { await anyInput.fill("مسودة"); typed = true; }
  }
  const father = page.locator('[data-key="full_name"][data-part="father"]');
  if (await father.count()) await father.fill("تجريبية");
  await shot("09-wizard-with-entry");
  await page.locator(".aw-close").first().click(); await sleep(800);
  await shot("10-close-wizard-choices");
  const keep = page.getByRole("button", { name: "حفظ كمسودة" });
  if (await keep.count()) await keep.first().click();
  await sleep(1000);
  log("6", "draft created in «إضافة موظف»", typed && (await keep.count()) === 0, { typed });

  // Sign out → warning → «إلغاء» (stay).
  await page.click("#btn-logout-side"); await sleep(1200);
  await shot("11-logout-warning");
  const dlg = page.locator(".app-dialog");
  const dlgText = (await dlg.count()) ? (await dlg.first().innerText()) : "";
  log("6", "sign-out warns about the unsaved draft", /غير محفوظة|مسودة/.test(dlgText), dlgText);
  const buttons = (await dlg.count()) ? await dlg.first().locator("button").allTextContents() : [];
  log("6", "buttons in the warning", null, buttons);
  await page.locator(".app-dialog button").filter({ hasText: "إلغاء" }).first().click().catch(() => {});
  await sleep(1000);
  const stillIn = await page.locator("#app-shell:not(.hidden)").count();
  await page.click("#btn-add-emp"); await sleep(1200);
  const banner = page.locator(".aw-draft");
  const bannerText = (await banner.count()) ? await banner.first().innerText() : "";
  await shot("12-draft-still-there-after-stay");
  log("6", "«إلغاء» after sign-out warning keeps the session and the draft", stillIn === 1 && /مسودة/.test(bannerText), { stillSignedIn: stillIn === 1, banner: bannerText });
  await page.keyboard.press("Escape"); await sleep(800);
  await page.locator(".aw-overlay .aw-close").first().click().catch(() => {}); await sleep(500);

  // Close window (WM_CLOSE, like the X button) → warning → «إلغاء».
  ps("Get-Process CNSArch | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [void]$_.CloseMainWindow() }");
  await sleep(2500);
  await shot("13-close-warning");
  const dlg2 = page.locator(".app-dialog");
  const dlg2Text = (await dlg2.count()) ? await dlg2.first().innerText() : "";
  log("6", "closing the window warns about the unsaved draft", /غير محفوظة|مسودة/.test(dlg2Text), dlg2Text);
  await page.locator(".app-dialog button").filter({ hasText: "إلغاء" }).first().click().catch(() => {});
  await sleep(1500);
  const alive = ps("(Get-Process CNSArch -ErrorAction SilentlyContinue | Measure-Object).Count").trim();
  await page.click("#btn-add-emp").catch(() => {}); await sleep(1200);
  const banner2 = (await page.locator(".aw-draft").count()) ? await page.locator(".aw-draft").first().innerText() : "";
  await shot("14-draft-still-there-after-close-cancel");
  log("6", "«إلغاء» after close warning keeps the app open and the draft", Number(alive) > 0 && /مسودة/.test(banner2), { processes: alive, banner: banner2 });
  await page.keyboard.press("Escape"); await sleep(600);

  });
  await section("3", async () => {
  // ── Point 3 ──
  await must("cmd_login", { username: "sysadmin", password: PW.admin105 });
  const emp1 = await must("cmd_get_employee", { id: state.e1 });
  const atts = attachmentPaths(emp1);
  const readsBefore = [];
  for (const a of atts) readsBefore.push({ ...a, ...(await readAsset(a.rel)) });
  log("3", "attachments after upgrade open", readsBefore.length >= 2 && readsBefore.every(r => r.ok) && readsBefore.some(r => r.sha === state.srcSha.card) && readsBefore.some(r => r.sha === state.srcSha.pdf), readsBefore);
  const b4 = await must("cmd_create_backup", { password: PW.backup });
  state.backup111 = b4;
  const insp = await invoke("cmd_inspect_backup", { sourcePath: b4, password: PW.backup });
  log("3", "new 1.1.1 backup inspects clean", insp.ok, insp);
  // Change something after the backup, so the restore is visible.
  await must("cmd_update_employee", { id: state.e1b, data: { ...(await must("cmd_get_employee", { id: state.e1b })), notes: "تغيير بعد النسخة" } }).catch(e => log("3", "edit after backup", null, e.message));
  const rest = await invoke("cmd_restore_backup", { sourcePath: b4, password: PW.backup });
  log("3", "restore of the 1.1.1 backup", rest.ok, rest);
  await page.reload(); await sleep(3000);
  await must("cmd_login", { username: "sysadmin", password: PW.admin105 });
  const afterRestore = [];
  for (const a of atts) afterRestore.push({ ...a, ...(await readAsset(a.rel)) });
  log("3", "attachments open after restore, same content", afterRestore.every(r => r.ok) && afterRestore.every(r => readsBefore.find(b => b.rel === r.rel)?.sha === r.sha), afterRestore);
  const notes = (await must("cmd_get_employee", { id: state.e1b })).notes;
  log("3", "restored data is the backup's (edit after backup gone)", !String(notes || "").includes("تغيير بعد النسخة"), { notes });
  // UI: open the documents tab of e1 and show the card.
  await uiLogin("sysadmin", PW.admin105);
  await page.click('.nav-item[data-screen="employees"]'); await sleep(2000);
  const row1 = page.locator("tr, .emp-row, [data-id]").filter({ hasText: "سامر خالد" }).first();
  if (await row1.count()) {
    await row1.click().catch(() => {}); await sleep(2000);
    const docTab = page.locator("button, [role=tab]").filter({ hasText: /المستمسكات|الوثائق|المرفقات/ });
    if (await docTab.count()) { await docTab.first().click().catch(() => {}); await sleep(2000); }
    await shot("15-restored-attachments-tab");
    const img = page.locator("img[src*='asset'], img[src^='blob:'], img[src*='localhost']").first();
    if (await img.count()) { await img.click().catch(() => {}); await sleep(2000); await shot("16-restored-attachment-open"); await page.keyboard.press("Escape"); }
  }
  // Damage the stored copy of the card, same size.
  const cardSha = readsBefore.find(r => r.sha === state.srcSha.card)?.sha || state.srcSha.card;
  const blob = findFile(path.join(ROOT, "backup"), `${cardSha}.blob`);
  if (!blob) log("3", "find stored attachment in backup Store", false, "blob not found");
  else {
    const buf = fs.readFileSync(blob); const size = buf.length;
    const i = Math.floor(size / 2); buf[i] = buf[i] ^ 0xff; fs.writeFileSync(blob, buf);
    log("3", "damaged one stored attachment, size unchanged", fs.statSync(blob).size === size, { blob, size });
    await must("cmd_login", { username: "sysadmin", password: PW.admin105 });
    const insp2 = await invoke("cmd_inspect_backup", { sourcePath: b4, password: PW.backup });
    log("3", "check rejects the backup with the damaged attachment", !insp2.ok, insp2);
    const rest2 = await invoke("cmd_restore_backup", { sourcePath: b4, password: PW.backup });
    log("3", "restore refuses the backup with the damaged attachment", !rest2.ok, rest2);
    if (rest2.ok) { await page.reload(); await sleep(3000); await must("cmd_login", { username: "sysadmin", password: PW.admin105 }); }
    const still = [];
    for (const a of atts) still.push({ ...a, ...(await readAsset(a.rel)) });
    log("3", "current attachments untouched by the refused restore", still.every(r => r.ok && readsBefore.find(b => b.rel === r.rel)?.sha === r.sha), still);
    const b5 = await invoke("cmd_create_backup", { password: PW.backup });
    const healed = !fs.readFileSync(blob).equals(buf);
    const insp3 = await invoke("cmd_inspect_backup", { sourcePath: b4, password: PW.backup });
    log("3", "next backup replaces the damaged copy; old backup checks clean again", b5.ok && healed && insp3.ok, { newBackup: b5, blobRewritten: healed, inspectOld: insp3.ok ? "ok" : insp3 });
  }

  });
  await section("5", async () => {
  // ── Point 5 ──
  await must("cmd_login", { username: "sysadmin", password: PW.admin105 });
  const codeX = await must("cmd_regenerate_recovery_code");
  const b6 = await must("cmd_create_backup", { password: PW.backup });
  const codeY = await must("cmd_regenerate_recovery_code");
  Object.assign(state, { codeX, codeY, backupWithX: b6 });
  log("5", "made code X, backup, then code Y (latest)", null, { b6 });
  const r6 = await invoke("cmd_restore_backup", { sourcePath: b6, password: PW.backup });
  log("5", "restored the older backup (made with code X)", r6.ok, r6);
  await page.reload(); await sleep(3000);
  await invoke("cmd_logout");
  const status5 = await invoke("cmd_get_recovery_options");
  log("5", "«نسيت كلمة المرور؟» options after the restore", null, status5);
  const tryX = await invoke("cmd_recover_admin_password", { code: codeX, newPassword: PW.adminRecovered });
  log("5", "older code X no longer works", !tryX.ok, tryX);
  const tryY = await invoke("cmd_recover_admin_password", { code: codeY, newPassword: PW.adminRecovered });
  log("5", "latest code Y still works after restoring the older backup", tryY.ok, tryY.ok ? { username: tryY.value.username, newCodeShown: !!tryY.value.recovery_code } : tryY);
  const lg = await invoke("cmd_login", { username: "sysadmin", password: PW.adminRecovered });
  log("5", "sign in with the password set by the code", lg.ok, lg.ok ? "ok" : lg);
  if (tryY.ok) state.codeZ = tryY.value.recovery_code;
  // Also a backup older than recovery codes: the 1.0.5 one.
  const r105 = await invoke("cmd_restore_backup", { sourcePath: state.backup105, password: PW.backup });
  log("5", "restored the 1.0.5 backup (older than recovery codes)", r105.ok, r105);
  await page.reload(); await sleep(3000);
  await invoke("cmd_logout");
  const tryZ = await invoke("cmd_recover_admin_password", { code: state.codeZ || state.codeY, newPassword: PW.adminRecovered2 });
  log("5", "latest code still works after restoring the 1.0.5 backup", tryZ.ok, tryZ.ok ? { username: tryZ.value.username } : tryZ);
  if (tryZ.ok) state.codeW = tryZ.value.recovery_code;
  state.adminPw = tryZ.ok ? PW.adminRecovered2 : (lg.ok ? PW.adminRecovered : PW.admin105);
  // UI of «نسيت كلمة المرور؟»
  await page.reload(); await sleep(3000);
  const forgot = page.locator("button, a").filter({ hasText: /نسيت/ });
  if (await forgot.count()) { await forgot.first().click().catch(() => {}); await sleep(1500); await shot("17-forgot-password-ui"); await page.keyboard.press("Escape"); }
  });
  saveState();
}

function findFile(dir, name) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { const f = findFile(p, name); if (f) return f; }
    else if (entry.name === name) return p;
  }
  return null;
}

// A separate installation (fresh %APPDATA%) whose administrator is not «sysadmin».
async function otherInstall() {
  await connect();
  for (const d of ["data2", "backup2"]) fs.mkdirSync(path.join(ROOT, d), { recursive: true });
  const status = await must("cmd_get_startup_status");
  if (status?.state !== "ready") {
    await must("cmd_complete_setup", { dataRoot: path.join(ROOT, "data2"), backupRoot: path.join(ROOT, "backup2") });
    await page.reload(); await sleep(3000);
  }
  await shot("first-run");
  const fr = await must("cmd_complete_first_run", { data: { username: "otheradmin", password: PW.other, department_name: "قسم تجريبي", division_name: "شعبة تجريبية" } });
  log("5", "second install: first-run admin «otheradmin»", null, { user: fr.user?.username, codeShown: !!fr.recovery_code });
  state.otherCode = fr.recovery_code;
  await must("cmd_create_employee", { data: { full_name: "موظف من نسخة أخرى", employee_number: "O-001" } });
  state.backupOther = await must("cmd_create_backup", { password: PW.backup });
  log("5", "backup without «sysadmin» made", null, state.backupOther);
  saveState();
}

async function missingAdmin() {
  await connect();
  await must("cmd_login", { username: "sysadmin", password: state.adminPw || PW.admin105 });
  const before = await must("cmd_get_recovery_status");
  const r = await invoke("cmd_restore_backup", { sourcePath: state.backupOther, password: PW.backup });
  log("5", "restored a backup whose data has no «sysadmin»", r.ok, r);
  await page.reload(); await sleep(3000);
  await shot("restored-other");
  const status = await invoke("cmd_get_recovery_options");
  const rs = await invoke("cmd_get_recovery_status");
  log("5", "recovery status after that restore", null, { before, options: status, status: rs });
  const FIX = process.env.EXPECT_FIX === "1";
  const latest = state.codeW || state.codeZ || state.codeY;
  const tryW = await invoke("cmd_recover_admin_password", { code: latest, newPassword: PW.adminRecovered3 });
  log("5", "this computer's latest code, its admin account missing from the restored data", FIX ? (!tryW.ok && /غير موجود/.test(tryW.error)) : null, tryW.ok ? { ok: true, username: tryW.value.username } : tryW);
  const tryOther = await invoke("cmd_recover_admin_password", { code: state.otherCode, newPassword: PW.adminRecovered3 });
  log("5", "the other install's code on this computer", FIX ? !tryOther.ok : null, tryOther.ok ? { ok: true, username: tryOther.value.username } : tryOther);
  const sysLogin = await invoke("cmd_login", { username: "sysadmin", password: state.adminPw });
  const otherLogin = await invoke("cmd_login", { username: "otheradmin", password: PW.other });
  const otherNew = await invoke("cmd_login", { username: "otheradmin", password: PW.adminRecovered3 });
  log("5", "who can sign in afterwards", FIX ? (otherLogin.ok === true && !otherNew.ok) : null, { sysadmin: sysLogin.ok || sysLogin.error, otheradmin_old: otherLogin.ok || otherLogin.error, otheradmin_new: otherNew.ok || otherNew.error });
  if (FIX && r.ok) {
    // Back to this computer's own data (the safety copy made by that restore): the same code works.
    await must("cmd_login", { username: "otheradmin", password: PW.other });
    const back = await invoke("cmd_restore_backup", { sourcePath: r.value, password: PW.backup });
    await page.reload(); await sleep(3000);
    const again = await invoke("cmd_recover_admin_password", { code: latest, newPassword: PW.adminRecovered3 });
    log("5", "after restoring this computer's own data again, the same (not used up) code works", back.ok && again.ok && again.value.username === "sysadmin", { restore: back.ok || back.error, recover: again.ok ? again.value.username : again.error });
    if (again.ok) { state.adminPw = PW.adminRecovered3; state.codeLatest = again.value.recovery_code; }
  }
  await page.reload(); await sleep(2500);
  const forgot = page.locator("button, a").filter({ hasText: /نسيت/ });
  if (await forgot.count()) { await forgot.first().click().catch(() => {}); await sleep(1500); await shot("forgot-ui"); }
}


// ── New cases of the fix branch (installed build) ──────────────────────────
const NOTIFY_KEY = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings\\com.autohr.app";
// «الإعدادات ← النظام ← الإشعارات ← CNSArch» off/on, as Windows itself stores it; the
// notification service is restarted so it reads the change at once. Returns what Windows then
// reports for the program (ToastNotifier.Setting).
function setToasts(enabled) {
  const restart = "Get-Service WpnUserService*, WpnService -ErrorAction SilentlyContinue | Restart-Service -Force -ErrorAction SilentlyContinue; Start-Sleep 3";
  if (!enabled) {
    ps(`New-Item -Path '${NOTIFY_KEY}' -Force | Out-Null; New-ItemProperty -Path '${NOTIFY_KEY}' -Name Enabled -Value 0 -PropertyType DWord -Force | Out-Null; ${restart}`);
    return windowsToastSetting();
  }
  // Back on: the switch set to 1, then (if Windows still says off) the program's entry removed.
  const tried = [];
  ps(`New-ItemProperty -Path '${NOTIFY_KEY}' -Name Enabled -Value 1 -PropertyType DWord -Force | Out-Null; ${restart}`);
  tried.push(`Enabled=1: ${windowsToastSetting()}`);
  if (!tried.at(-1).endsWith("Enabled")) {
    ps(`Remove-Item -Path '${NOTIFY_KEY}' -Recurse -Force -ErrorAction SilentlyContinue; ${restart}`);
    tried.push(`entry removed: ${windowsToastSetting()}`);
  }
  return tried.join(" | ");
}
function windowsToastSetting() {
  try {
    return ps("[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]; [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('com.autohr.app').Setting").trim();
  } catch (e) { return "error: " + String(e.message).split("\n")[0]; }
}
// Counts the program's notification requests as they reach the backend (Tauri IPC requests seen
// over DevTools), with whether the backend accepted them. The program itself is not changed.
const ipcNotifications = [];
let ipcWatching = false;
async function countNotifications() {
  if (ipcWatching) return;
  ipcWatching = true;
  page.on("response", async response => {
    if (!response.url().includes("cmd_show_notification")) return;
    const headers = response.headers();
    ipcNotifications.push({ ok: response.status() === 200 && headers["tauri-response"] !== "error", status: response.status(), at: Date.now() });
  });
}

// Signs in through the login form with the notification counter already in place, so the check
// made at sign-in is counted too.
async function loginCounted(username, password) {
  await page.reload(); await sleep(3000);
  await countNotifications();
  await page.waitForSelector("#login-username", { state: "visible", timeout: 30000 });
  await page.fill("#login-username", username);
  await page.fill("#login-password", password);
  await page.press("#login-password", "Enter");
  await page.waitForSelector("#app-shell:not(.hidden)", { timeout: 30000 });
  await sleep(4000);
  await dismissOverlays();
}
const notifyCalls = async () => { await sleep(500); return ipcNotifications.map(c => ({ ...c })); };
const stages = user => page.evaluate(u => JSON.parse(localStorage.getItem(`cnsarch.documentAlertStages.${u}`) || "{}"), user);
const inDays = days => { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); };

async function newCases() {
  await connect();
  const adminPw = state.adminPw || PW.admin105;
  await must("cmd_login", { username: "sysadmin", password: adminPw });
  // ── Alerts ──
  await section("alerts", async () => {
    const e = await must("cmd_get_employee", { id: state.e1 });
    await must("cmd_update_employee", { id: state.e1, data: { ...e, civil_id_expiry_date: inDays(5) } });
    await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith("cnsarch.documentAlertStages")).forEach(k => localStorage.removeItem(k)));
    const consoleLines = [];
    page.on("console", m => consoleLines.push(`${m.type()}: ${m.text()}`));
    const rules = await invoke("cmd_get_document_alert_rules");
    const emps = (await must("cmd_list_employees")).map(x => ({ id: x.id, active: x.is_active, national: x.civil_id_expiry_date, vehicles: x.vehicles }));
    log("alerts", "data for the alerts", null, { rules, emps, shortcut: ps("Get-ChildItem \"$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\" -Recurse -Filter *CNSArch* | Select-Object -ExpandProperty FullName").trim() });
    log("alerts", "Windows notification setting before", null, windowsToastSetting());
    const off = setToasts(false);
    log("alerts", "Windows notification setting after turning it off", null, off);
    const direct = await invoke("cmd_show_notification", { title: "اختبار", body: "إشعارات البرنامج مطفأة في Windows" });
    log("alerts", "Windows notifications off for the program: the request is refused", !direct.ok, direct);
    await loginCounted("sysadmin", adminPw);
    const s1 = await stages("sysadmin");
    const c1 = await notifyCalls();
    log("alerts", "refused at sign-in: the reminder is not recorded as sent (stays pending)", c1.length >= 1 && c1.every(c => !c.ok) && Object.keys(s1).length === 0, { calls: c1, recorded: s1,
      storage: await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter(k => k.includes("Alert")).map(k => [k, localStorage.getItem(k)]))),
      hook: await page.evaluate(() => typeof window.autohrCheckDocumentAlerts) });
    await page.evaluate(() => window.autohrCheckDocumentAlerts()); await sleep(1500);
    const c2 = await notifyCalls();
    log("alerts", "next check tries again while still refused", c2.length === c1.length + 1 && Object.keys(await stages("sysadmin")).length === 0, { calls: c2.length });
    log("alerts", "Windows notification setting after turning it on", null, setToasts(true));
    await page.evaluate(() => window.autohrCheckDocumentAlerts()); await sleep(2000);
    const c3 = await notifyCalls(); const s3 = await stages("sysadmin");
    await shot("alerts-allowed");
    log("alerts", "notifications allowed again: the next check sends it and records it", c3.length === c2.length + 1 && c3.at(-1).ok && Object.values(s3).includes("r7"), { last: c3.at(-1), recorded: s3 });
    await page.evaluate(() => window.autohrCheckDocumentAlerts()); await sleep(1200);
    await page.evaluate(() => window.autohrCheckDocumentAlerts()); await sleep(1200);
    const c4 = await notifyCalls();
    log("alerts", "same user and stage: not sent again", c4.length === c3.length, { calls: c4.length });
    // Signing in again (same user) does not repeat it either.
    await loginCounted("sysadmin", adminPw);
    const c5 = await notifyCalls();
    log("alerts", "console", null, consoleLines.slice(-15));
    log("alerts", "after signing in again: still not repeated", c5.length === c4.length, { before: c4.length, after: c5.length });
  });

  // ── Backup on sign-out / close ──
  await section("close-backup", async () => {
    await must("cmd_login", { username: "sysadmin", password: adminPw });
    const set = await invoke("cmd_set_auto_backup_settings", { data: { enabled: true, password: PW.backup, interval_minutes: 0 } });
    log("close-backup", "automatic daily backup turned on", set.ok, set.ok ? "ok" : set);
    const touch = async note => { const e = await must("cmd_get_employee", { id: state.e1b }); await must("cmd_update_employee", { id: state.e1b, data: { ...e, notes: note } }); };
    await touch("قبل النسخة اليومية");
    const first = await invoke("cmd_run_due_auto_backups", { inSession: false });
    const st = await must("cmd_get_auto_backup_settings");
    const daily = st.last_backup_path;
    log("close-backup", "a good daily backup exists", first.ok && !!daily && fs.existsSync(daily), { first, daily });
    const goodSha = sha(fs.readFileSync(daily));
    await touch("تغيير لم يُنسخ بعد");
    // Hold today's file open so Windows refuses to replace it: the new copy cannot take its place.
    const lockScript = path.join(ROOT, "lock.ps1");
    fs.writeFileSync(lockScript, `$f=[IO.File]::Open('${daily}','Open','Read','Read'); Start-Sleep 900`);
    const lockStart = () => execSync(`powershell -NoProfile -Command "Start-Process powershell -WindowStyle Hidden -ArgumentList '-NoProfile','-File','${lockScript}' -PassThru | Select-Object -ExpandProperty Id"`, { encoding: "utf8" }).trim();
    const lockStop = pid => { try { execSync(`taskkill /PID ${pid} /F`); } catch {} };
    let pid = lockStart(); await sleep(2500);

    await uiLogin("sysadmin", adminPw);
    await page.click("#btn-logout-side"); await sleep(800);
    await page.locator(".app-dialog button").filter({ hasText: /^تأكيد$/ }).first().click().catch(() => {});
    const dlg = page.locator(".app-choice-dialog");
    await dlg.waitFor({ state: "visible", timeout: 120000 }).catch(() => {});
    await shot("logout-backup-failed");
    const text = (await dlg.count()) ? await dlg.innerText() : "";
    const buttons = (await dlg.count()) ? await dlg.locator("button").allTextContents() : [];
    log("close-backup", "sign-out: failed backup does not sign out; offers the three choices", buttons.join("|") === "إعادة المحاولة|البقاء في البرنامج|تسجيل الخروج بدون نسخة جديدة", { text, buttons });
    await dlg.locator("button", { hasText: "إعادة المحاولة" }).click().catch(() => {});
    await sleep(1000);
    await dlg.waitFor({ state: "visible", timeout: 120000 }).catch(() => {});
    log("close-backup", "«إعادة المحاولة» tries again (still failing: asked again)", (await dlg.count()) === 1, {});
    await dlg.locator("button", { hasText: "البقاء في البرنامج" }).click().catch(() => {});
    await sleep(1500);
    log("close-backup", "«البقاء في البرنامج» keeps the session", (await page.locator("#app-shell:not(.hidden)").count()) === 1 && (await page.locator(".app-choice-dialog").count()) === 0, {});
    log("close-backup", "the last good backup is unchanged", sha(fs.readFileSync(daily)) === goodSha, { daily });

    // Close (WM_CLOSE, like the X button) with the backup still failing → choices → stay.
    ps("Get-Process CNSArch | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [void]$_.CloseMainWindow() }");
    await dlg.waitFor({ state: "visible", timeout: 120000 }).catch(() => {});
    await shot("close-backup-failed");
    const closeButtons = (await dlg.count()) ? await dlg.locator("button").allTextContents() : [];
    log("close-backup", "close: failed backup does not close; offers the three choices", closeButtons.join("|") === "إعادة المحاولة|البقاء في البرنامج|الإغلاق بدون نسخة جديدة", { closeButtons });
    await dlg.locator("button", { hasText: "البقاء في البرنامج" }).click().catch(() => {});
    await sleep(1500);
    const alive = ps("(Get-Process CNSArch -ErrorAction SilentlyContinue | Measure-Object).Count").trim();
    log("close-backup", "«البقاء في البرنامج» keeps the program open", Number(alive) > 0, { processes: alive });
    log("close-backup", "the last good backup is still unchanged", sha(fs.readFileSync(daily)) === goodSha, {});

    // The cause goes away: «إعادة المحاولة» makes the backup and signs out.
    await page.click("#btn-logout-side"); await sleep(800);
    await page.locator(".app-dialog button").filter({ hasText: /^تأكيد$/ }).first().click().catch(() => {});
    await dlg.waitFor({ state: "visible", timeout: 120000 }).catch(() => {});
    lockStop(pid); await sleep(1500);
    await dlg.locator("button", { hasText: "إعادة المحاولة" }).click().catch(() => {});
    await page.waitForSelector("#login-screen:not(.hidden)", { timeout: 120000 }).catch(() => {});
    const signedOut = (await page.locator("#login-screen:not(.hidden)").count()) === 1;
    const newSha = sha(fs.readFileSync(daily));
    log("close-backup", "after the cause is fixed, «إعادة المحاولة» backs up and signs out", signedOut && newSha !== goodSha, { signedOut, replaced: newSha !== goodSha });
    const goodSha2 = newSha;

    // «الإغلاق بدون نسخة جديدة»: the program closes, the last good backup stays.
    await uiLogin("sysadmin", adminPw);
    await must("cmd_login", { username: "sysadmin", password: adminPw });
    await touch("تغيير آخر لم يُنسخ");
    pid = lockStart(); await sleep(2500);
    ps("Get-Process CNSArch | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [void]$_.CloseMainWindow() }");
    await dlg.waitFor({ state: "visible", timeout: 120000 }).catch(() => {});
    await dlg.locator("button", { hasText: "الإغلاق بدون نسخة جديدة" }).click().catch(() => {});
    await sleep(6000);
    const left = ps("(Get-Process CNSArch -ErrorAction SilentlyContinue | Measure-Object).Count").trim();
    lockStop(pid); await sleep(1000);
    log("close-backup", "«الإغلاق بدون نسخة جديدة» closes the program; the last good backup stays", Number(left) === 0 && sha(fs.readFileSync(daily)) === goodSha2, { processes: left });
  });
  saveState();
}

const steps = { seed105, update105, verify, "other-install": otherInstall, "missing-admin": missingAdmin, "new-cases": newCases };
try {
  await steps[step]();
} catch (e) {
  log("error", `step ${step} stopped`, false, e.stack || String(e));
  await shot("error");
  process.exitCode = 1;
} finally {
  saveState();
}
process.exit(process.exitCode || 0);
