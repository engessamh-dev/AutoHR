/**
 * screens/setup.js — Startup gate shown before the login screen.
 *
 * - First run: the administrator chooses the data folder and the backup folder.
 * - Data folder unavailable (disk unplugged, network share offline): the app never
 *   creates a new empty database; the user reconnects the disk and retries, or points
 *   to the folder that already holds the data.
 */
import { api } from "../api.js";
import { escHtml } from "../utils.js";
import { open } from "@tauri-apps/plugin-dialog";

const TEXT = {
  setupTitle: "إعداد مواقع حفظ البيانات",
  missingTitle: "مجلد البيانات غير متاح",
  failedTitle: "تعذر فتح قاعدة البيانات",
  missingIntro: "لم يتم العثور على قاعدة البيانات في المجلد المحدد. لن يُنشئ البرنامج قاعدة بيانات فارغة حتى لا تضيع بياناتك. صِل القرص أو مجلد الشبكة ثم اضغط «إعادة المحاولة»، أو اختر المجلد الذي يحتوي على الملف database.db.",
  existing: "يحتوي المجلد المختار على قاعدة بيانات CNSArch موجودة، وسيتم استخدامها كما هي.",
  chooseData: "اختر مجلد البيانات والمرفقات",
  chooseBackup: "اختر مجلد النسخ الاحتياطية",
  needBoth: "اختر مجلد البيانات ومجلد النسخ الاحتياطية",
  busy: "جاري التحقق...",
};

function errorText(err) {
  return err?.message ?? String(err ?? "حدث خطأ");
}

/** Resolves once a database is open and the login screen can be shown. */
export async function runStartupGate() {
  let status;
  try {
    status = await api.getStartupStatus();
  } catch {
    return; // Older backend without the gate: nothing to do.
  }
  if (status.state === "ready") return;

  const screen = document.getElementById("setup-screen");
  const login = document.getElementById("login-screen");
  const form = document.getElementById("setup-form");
  const dataInput = document.getElementById("setup-data-root");
  const backupInput = document.getElementById("setup-backup-root");
  const warnings = document.getElementById("setup-warnings");
  const error = document.getElementById("setup-error");
  const submit = document.getElementById("setup-submit");
  const retry = document.getElementById("setup-retry");

  const showError = message => {
    error.textContent = message;
    error.classList.toggle("hidden", !message);
  };
  const showWarnings = (list = [], info = "") => {
    warnings.innerHTML = [
      ...list.map(w => `<p class="text-xs" style="color:#fbbf24;background:rgba(251,191,36,.08);border:1px solid rgba(251,191,36,.3);border-radius:8px;padding:8px 10px">${escHtml(w)}</p>`),
      info ? `<p class="text-xs" style="color:#93c5fd;background:rgba(59,130,246,.08);border:1px solid rgba(59,130,246,.3);border-radius:8px;padding:8px 10px">${escHtml(info)}</p>` : "",
    ].join("");
  };
  const applyStatus = current => {
    const recovering = current.state !== "needs_setup";
    document.getElementById("setup-title").textContent =
      current.state === "needs_setup" ? TEXT.setupTitle : current.state === "data_missing" ? TEXT.missingTitle : TEXT.failedTitle;
    if (recovering) document.getElementById("setup-intro").textContent = TEXT.missingIntro;
    retry.classList.toggle("hidden", !recovering);
    dataInput.value = current.data_root || current.suggested_data_root || "";
    backupInput.value = current.backup_root || current.suggested_backup_root || "";
    if (current.state === "open_failed" && current.message) showError(current.message);
  };

  login.classList.add("hidden");
  screen.classList.remove("hidden");
  applyStatus(status);

  const pick = async (input, title) => {
    const selected = await open({ directory: true, multiple: false, title });
    if (selected) {
      input.value = selected;
      check();
    }
  };
  const check = async () => {
    const dataRoot = dataInput.value.trim();
    const backupRoot = backupInput.value.trim();
    if (!dataRoot || !backupRoot) { showWarnings(); return null; }
    try {
      const result = await api.checkSetupFolders(dataRoot, backupRoot);
      showError("");
      showWarnings(result.warnings, result.existing_database ? TEXT.existing : "");
      return result;
    } catch (err) {
      showWarnings();
      showError(errorText(err));
      return null;
    }
  };
  document.getElementById("setup-pick-data").addEventListener("click", () => pick(dataInput, TEXT.chooseData));
  document.getElementById("setup-pick-backup").addEventListener("click", () => pick(backupInput, TEXT.chooseBackup));
  dataInput.addEventListener("change", check);
  backupInput.addEventListener("change", check);
  document.getElementById("setup-exit").addEventListener("click", () => api.exitApp());

  return new Promise(resolve => {
    const finish = () => {
      screen.classList.add("hidden");
      login.classList.remove("hidden");
      resolve();
    };
    retry.addEventListener("click", async () => {
      showError("");
      try {
        const current = await api.retryDataFolder();
        if (current.state === "ready") { finish(); return; }
        showError(current.message || TEXT.missingIntro);
      } catch (err) {
        showError(errorText(err));
      }
    });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const dataRoot = dataInput.value.trim();
      const backupRoot = backupInput.value.trim();
      if (!dataRoot || !backupRoot) { showError(TEXT.needBoth); return; }
      submit.disabled = true;
      const label = submit.textContent;
      submit.textContent = TEXT.busy;
      try {
        if (!(await check())) return;
        const current = await api.completeSetup(dataRoot, backupRoot);
        if (current.state === "ready") finish();
      } catch (err) {
        showError(errorText(err));
      } finally {
        submit.disabled = false;
        submit.textContent = label;
      }
    });
  });
}
