/**
 * screens/about.js — Version, storage path picker
 */
import { api }       from "../api.js";
import { showToast, confirmAction } from "../utils.js";
import { open }      from "@tauri-apps/plugin-dialog";

export async function renderAbout(container, user, ctx) {
  const isMaster = Boolean(user?.is_master);
  let storagePath = "";
  if (isMaster) {
    try { storagePath = await api.getStoragePath(); } catch {}
  }

  container.innerHTML = `
    <div class="space-y-6 max-w-xl">
      <div class="card space-y-3">
        <div class="flex items-center gap-4">
          <div class="w-14 h-14 rounded-xl bg-autohr-green/20 flex items-center justify-center shrink-0">
            <span class="text-2xl font-bold text-autohr-green">AH</span>
          </div>
          <div>
            <h2 class="text-xl font-bold">AutoHR</h2>
            <p class="text-sm text-gray-400">الشركة العامة لخدمات الملاحة الجوية — GCANS</p>
            <p class="text-xs text-gray-500 mt-1">الإصدار 1.0.0</p>
          </div>
        </div>
        <hr class="border-autohr-border" />
        <div class="text-sm text-gray-400 space-y-1">
          <p>👨‍💻 <strong class="text-gray-300">المطوّر:</strong> Eng. Essam Al-Emaraa</p>
          ${isMaster ? `
          <p>🗄️ <strong class="text-gray-300">قاعدة البيانات:</strong> SQLite (WAL mode)</p>
          <p>🖥️ <strong class="text-gray-300">الإطار:</strong> Tauri v2 + Vite + Tailwind CSS</p>
          <p>📁 <strong class="text-gray-300">مسار التخزين:</strong>
            <span dir="ltr" class="text-gray-300">${storagePath || "Documents/AutoHR (افتراضي)"}</span>
          </p>` : ""}
        </div>
      </div>

      ${isMaster ? `<div class="card space-y-3">
        <p class="section-title">مسار حفظ البيانات والنسخ الاحتياطية</p>
        <div class="flex gap-3">
          <input id="storage-input" class="input-field flex-1" dir="ltr"
                 value="${storagePath}" placeholder="مسار التخزين…" readonly />
          <button id="btn-pick-storage" class="btn-secondary whitespace-nowrap">تصفّح…</button>
        </div>
        <button id="btn-save-storage" class="btn-primary px-6">حفظ المسار</button>
      </div>` : ""}
    </div>`;

  container.querySelector("#btn-pick-storage")?.addEventListener("click", async () => {
    try {
      const dir = await open({ directory: true, multiple: false });
      if (dir) container.querySelector("#storage-input").value = dir;
    } catch {}
  });

  container.querySelector("#btn-save-storage")?.addEventListener("click", async () => {
    const path = container.querySelector("#storage-input").value.trim();
    if (!path) { showToast("اختر مساراً أولاً", "warn"); return; }
    if (!(await confirmAction("تأكيد تغيير مسار حفظ البيانات والنسخ الاحتياطية؟"))) return;
    try {
      await api.setStoragePath(path);
      showToast("تم حفظ مسار التخزين");
    } catch (err) { showToast(err?.message ?? "خطأ", "error"); }
  });
}
