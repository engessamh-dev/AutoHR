/**
 * screens/setup.js — First-run wizard and startup gate, shown before the login screen.
 *
 * First run, three steps in one window:
 *   1. «مواقع الحفظ»: the data folder and the backup folder. A whole drive or a folder that holds
 *      other files gets the program's own subfolder (Rust decides; the screen shows the result).
 *   2. «حساب المسؤول»: the administrator's own name and password (no temporary password).
 *   3. «القسم والشعبة»: names shown in page headers, reports and the login screen.
 * Then the recovery code («رمز الاستعادة») is shown once, and the program opens signed in.
 *
 * Data folder unavailable (disk unplugged, network share offline): the app never creates a new
 * empty database; the user reconnects the disk and retries, or points to the folder that holds it.
 */
import { api } from "../api.js";
import { escHtml, errorText as translateError, showToast } from "../utils.js";
import { open } from "@tauri-apps/plugin-dialog";
import { loadPasswordPolicy, mountPasswordRules, passwordProblem, addPasswordToggle, watchCapsLock } from "../password-rules.js";
import { printRecoveryCode, copyText } from "../recovery.js";

const TEXT = {
  setupTitle: "إعداد مواقع حفظ البيانات",
  missingTitle: "مجلد البيانات غير متاح",
  failedTitle: "تعذر فتح قاعدة البيانات",
  missingIntro: "لم يتم العثور على قاعدة البيانات في المجلد المحدد. لن يُنشئ البرنامج قاعدة بيانات فارغة حتى لا تضيع بياناتك. صِل القرص أو مجلد الشبكة ثم اضغط «إعادة المحاولة»، أو اختر المجلد الذي يحتوي على الملف «database.db»",
  failedIntro: "قاعدة البيانات موجودة لكن تعذر فتحها، والسبب مكتوب أدناه. لا تحذف المجلد ولا تنقله. إذا لم يتضح الحل، تواصل مع الدعم الفني.",
  existing: "يحتوي المجلد المختار على قاعدة بيانات CNSArch موجودة، وسيتم استخدامها كما هي.",
  adjusted: "اخترت قرصًا كاملًا أو مجلدًا فيه ملفات أخرى، لذلك سيُنشئ البرنامج مجلدًا خاصًا به:",
  chooseData: "اختر مجلد البيانات والمرفقات",
  chooseBackup: "اختر مجلد النسخ الاحتياطية",
  needBoth: "اختر مجلد البيانات ومجلد النسخ الاحتياطية",
  busy: "جاري التحقق...",
};
const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,64}$/;

const errorText = err => translateError(err, "حدث خطأ");
const $ = id => document.getElementById(id);

function setError(id, message) {
  const el = $(id);
  el.textContent = message || "";
  el.classList.toggle("hidden", !message);
}

/** Shows one step of the wizard and marks the indicator. `null` hides the indicator (recovery mode). */
function showStep(step, { indicator = true } = {}) {
  for (const name of ["folders", "admin", "unit", "code"]) {
    $(`setup-step-${name}`).classList.toggle("hidden", name !== step);
  }
  const steps = $("setup-steps");
  steps.classList.toggle("hidden", !indicator || step === "code");
  const order = ["folders", "admin", "unit"];
  steps.querySelectorAll("li").forEach(li => {
    const index = order.indexOf(li.dataset.step);
    li.classList.toggle("is-current", li.dataset.step === step);
    li.classList.toggle("is-done", index < order.indexOf(step));
    if (li.dataset.step === step) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
  });
  $(`setup-step-${step}`).querySelector("input:not([type=checkbox]), button")?.focus();
}

/** Step 1: data and backup folders. Resolves once a database is open. */
function runFolderStep(status, { firstRun }) {
  const form = $("setup-form");
  const dataInput = $("setup-data-root");
  const backupInput = $("setup-backup-root");
  const warnings = $("setup-warnings");
  const submit = $("setup-submit");
  const retry = $("setup-retry");
  const showError = message => setError("setup-error", message);
  const showWarnings = (list = [], info = []) => {
    warnings.innerHTML = [
      ...list.map(w => `<p class="setup-note is-warn">${escHtml(w)}</p>`),
      ...info.map(i => `<p class="setup-note is-info">${i}</p>`),
    ].join("");
  };

  const recovering = status.state !== "needs_setup";
  $("setup-title").textContent = status.state === "needs_setup" ? TEXT.setupTitle : status.state === "data_missing" ? TEXT.missingTitle : TEXT.failedTitle;
  if (recovering) $("setup-intro").textContent = status.state === "open_failed" ? TEXT.failedIntro : TEXT.missingIntro;
  // A newer-version database cannot be fixed by trying again.
  retry.classList.toggle("hidden", !recovering || /إصدار أحدث/.test(status.message || ""));
  dataInput.value = status.data_root || status.suggested_data_root || "";
  backupInput.value = status.backup_root || status.suggested_backup_root || "";
  if (status.state === "open_failed" && status.message) showError(status.message);
  showStep("folders", { indicator: firstRun });

  const check = async () => {
    const dataRoot = dataInput.value.trim();
    const backupRoot = backupInput.value.trim();
    if (!dataRoot || !backupRoot) { showWarnings(); return null; }
    try {
      const result = await api.checkSetupFolders(dataRoot, backupRoot);
      showError("");
      const info = [];
      if (result.adjusted) {
        const paths = [result.data_root !== dataRoot ? result.data_root : "", result.backup_root !== backupRoot ? result.backup_root : ""].filter(Boolean);
        info.push(`${TEXT.adjusted} ${paths.map(p => `<bdi dir="ltr">${escHtml(p)}</bdi>`).join(" و ")}`);
      }
      if (result.existing_database) info.push(escHtml(TEXT.existing));
      showWarnings(result.warnings, info);
      return result;
    } catch (err) {
      showWarnings();
      showError(errorText(err));
      return null;
    }
  };
  const pick = async (input, title) => {
    const selected = await open({ directory: true, multiple: false, title });
    if (selected) { input.value = selected; check(); }
  };
  $("setup-pick-data").addEventListener("click", () => pick(dataInput, TEXT.chooseData));
  $("setup-pick-backup").addEventListener("click", () => pick(backupInput, TEXT.chooseBackup));
  dataInput.addEventListener("change", check);
  backupInput.addEventListener("change", check);
  $("setup-exit").addEventListener("click", () => api.exitApp());
  // First run: show at once whether the suggested folders get a warning. In recovery mode the
  // reason the database could not be opened stays on screen until the user changes something.
  if (firstRun) check();

  return new Promise(resolve => {
    retry.addEventListener("click", async () => {
      showError("");
      try {
        const current = await api.retryDataFolder();
        if (current.state === "ready") { resolve(); return; }
        showError(current.message || TEXT.missingIntro);
      } catch (err) {
        showError(errorText(err));
      }
    });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (!dataInput.value.trim() || !backupInput.value.trim()) { showError(TEXT.needBoth); return; }
      submit.disabled = true;
      const label = submit.textContent;
      submit.textContent = TEXT.busy;
      try {
        const checked = await check();
        if (!checked) return;
        // Save exactly what was shown: the program's own subfolders when they were added.
        dataInput.value = checked.data_root;
        backupInput.value = checked.backup_root;
        const current = await api.completeSetup(checked.data_root, checked.backup_root);
        if (current.state === "ready") resolve();
      } catch (err) {
        showError(errorText(err));
      } finally {
        submit.disabled = false;
        submit.textContent = label;
      }
    });
  });
}

/** Steps 2 and 3, then the recovery code. Resolves with the signed-in administrator. */
async function runAdminSteps() {
  const policy = await loadPasswordPolicy({ fresh: true });
  const username = $("setup-admin-username");
  const password = $("setup-admin-password");
  const confirm = $("setup-admin-confirm");
  addPasswordToggle(password);
  addPasswordToggle(confirm);
  watchCapsLock([password, confirm], $("setup-admin-caps"));
  const refreshRules = mountPasswordRules($("setup-admin-rules"), password, policy, () => username.value);
  username.addEventListener("input", () => { refreshRules(); setError("setup-admin-error", ""); });
  password.addEventListener("input", () => setError("setup-admin-error", ""));
  showStep("admin");

  return new Promise(resolve => {
    $("setup-admin-form").addEventListener("submit", event => {
      event.preventDefault();
      const name = username.value.trim();
      const problem = !name ? "اكتب اسم المستخدم"
        : !USERNAME_PATTERN.test(name) ? "اسم المستخدم من 3 أحرف على الأقل: أحرف إنجليزية وأرقام و . - _ فقط"
        : passwordProblem(policy, password.value, name)
        || (password.value !== confirm.value ? "كلمتا المرور غير متطابقتين" : "");
      setError("setup-admin-error", problem);
      if (problem) return;
      showStep("unit");
    });
    $("setup-unit-back").addEventListener("click", () => showStep("admin"));
    $("setup-unit-form").addEventListener("submit", async event => {
      event.preventDefault();
      const submit = $("setup-unit-submit");
      submit.disabled = true;
      setError("setup-unit-error", "");
      try {
        const result = await api.completeFirstRun({
          username: username.value.trim(),
          password: password.value,
          department_name: $("setup-department").value.trim(),
          division_name: $("setup-division").value.trim(),
        });
        password.value = confirm.value = "";
        showRecoveryCode(result, resolve);
      } catch (err) {
        const message = errorText(err);
        // A password refused by the program belongs to step 2.
        if (/كلمة المرور|اسم المستخدم/.test(message)) { showStep("admin"); setError("setup-admin-error", message); }
        else setError("setup-unit-error", message);
      } finally {
        submit.disabled = false;
      }
    });
  });
}

function showRecoveryCode(result, resolve) {
  $("setup-code-user").textContent = result.user.username;
  $("setup-code").textContent = result.recovery_code;
  showStep("code");
  const saved = $("setup-code-saved");
  const done = $("setup-code-done");
  saved.addEventListener("change", () => { done.disabled = !saved.checked; });
  $("setup-code-print").addEventListener("click", () => printRecoveryCode(result.user.username, result.recovery_code));
  $("setup-code-copy").addEventListener("click", async () => {
    if (await copyText(result.recovery_code)) showToast("نُسخ الرمز. الصقه في ملف تطبعه، ولا تتركه على الحاسبة.");
  });
  done.addEventListener("click", () => resolve(result.user));
}

/**
 * Resolves once the login screen can be shown (with `null`), or with the administrator's account
 * when the first-run wizard has just created it (the program then opens signed in).
 */
export async function runStartupGate() {
  let status;
  try {
    status = await api.getStartupStatus();
  } catch {
    return null; // Older backend without the gate: nothing to do.
  }
  const screen = $("setup-screen");
  const login = $("login-screen");
  const show = () => { login.classList.add("hidden"); screen.classList.remove("hidden"); };
  const hide = () => { screen.classList.add("hidden"); login.classList.remove("hidden"); };

  const firstRun = status.state === "needs_setup";
  if (status.state !== "ready") {
    show();
    await runFolderStep(status, { firstRun });
  }
  let needsAdmin = false;
  try { needsAdmin = (await api.getFirstRunState()).needs_admin; } catch { /* older backend */ }
  if (!needsAdmin) { hide(); return null; }
  show();
  const user = await runAdminSteps();
  screen.classList.add("hidden");
  return user;
}
