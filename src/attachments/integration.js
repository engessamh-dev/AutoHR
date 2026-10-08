import { isScannable, reprocessAttachment } from "./scanner.js";
import { can } from "../permissions.js";
import { showToast } from "../utils.js";

/** Binds existing attachment controls without duplicating scanner UI or storage logic. */
export function bindAttachmentScannerButtons(root, user, onSaved = () => {}, beforeProcess = () => {}) {
  const paths = new Set([...root.querySelectorAll("[data-scanner-for]")].map(el => el.dataset.scannerFor));
  root.querySelectorAll("[data-path],[data-scan-path]").forEach(anchor => {
    const path = anchor.dataset.scanPath || anchor.dataset.path;
    if (!isScannable(path) || paths.has(path)) return;
    paths.add(path);
    const group = document.createElement("div");
    group.className = "smart-scanner-actions";
    group.dataset.scannerFor = path;
    const writable = path.includes("/Photo/") ? can(user, "employees.edit") : path.startsWith("Branding/") ? can(user, "settings.manage") : can(user, "documents.upload");
    if (writable) {
      const process = document.createElement("button"); process.type = "button"; process.className = "btn-secondary text-xs"; process.textContent = "إعادة معالجة المستمسك";
      process.addEventListener("click", async () => {
        process.disabled = true;
        try { await beforeProcess(path); if (await reprocessAttachment(path)) { showToast("حُفظت النسخة المعالجة مع الحفاظ على الأصل"); await onSaved(path); } }
        catch (error) { showToast(String(error), "error"); }
        finally { process.disabled = false; }
      }); group.append(process);
    }
    if (group.childElementCount) {
      const photoActions = anchor.closest(".employee-photo-card")?.querySelector(".employee-photo-actions");
      (photoActions || anchor.parentElement).append(group);
    }
  });
}
