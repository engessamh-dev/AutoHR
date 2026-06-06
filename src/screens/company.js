/**
 * screens/company.js — sysadmin-only identity + logo upload
 */
import { api }       from "../api.js";
import { showToast, applyBranding, escHtml, confirmAction } from "../utils.js";
import { open }      from "@tauri-apps/plugin-dialog";

export async function renderCompany(container, user, ctx) {
  let cfg = await api.getCompanyConfig();

  function html() {
    return `<div class="space-y-6 max-w-xl">
      <div class="card space-y-4">
        <p class="section-title">هوية المنشأة</p>

        <div>
          <label class="section-title">اسم الشركة / الجهة *</label>
          <input id="c-company" class="input-field" value="${escHtml(cfg?.company_name ?? "")}" />
        </div>
        <div>
          <label class="section-title">اسم القسم</label>
          <input id="c-dept" class="input-field" value="${escHtml(cfg?.department_name ?? "")}" />
        </div>
        <div>
          <label class="section-title">اسم الشعبة / الوحدة</label>
          <input id="c-div" class="input-field" value="${escHtml(cfg?.division_name ?? "")}" />
        </div>

        <button id="btn-save-cfg" class="btn-primary px-6">حفظ</button>
      </div>

      <div class="card space-y-4">
        <p class="section-title">شعار المنشأة</p>
        ${cfg?.logo_full_path
          ? `<img src="" id="logo-preview" class="w-20 h-20 rounded object-cover border border-autohr-border" />`
          : `<div class="w-20 h-20 rounded bg-autohr-green/20 flex items-center justify-center border border-autohr-border">
               <span class="text-2xl font-bold text-autohr-green">AH</span>
             </div>`}
        <p class="text-xs text-gray-500">يدعم PNG، JPG، JPEG — بحد أقصى 5 MB</p>
        <button id="btn-upload-logo" class="btn-secondary px-4">رفع شعار جديد…</button>
      </div>
    </div>`;
  }

  container.innerHTML = html();

  // Fix logo preview src via convertFileSrc
  if (cfg?.logo_full_path) {
    const { convertFileSrc } = await import("@tauri-apps/api/core");
    const preview = container.querySelector("#logo-preview");
    if (preview) preview.src = convertFileSrc(cfg.logo_full_path);
  }

  container.querySelector("#btn-save-cfg").addEventListener("click", async () => {
    const data = {
      company_name:    container.querySelector("#c-company").value.trim(),
      department_name: container.querySelector("#c-dept").value.trim(),
      division_name:   container.querySelector("#c-div").value.trim(),
    };
    if (!data.company_name) { showToast("اسم الشركة مطلوب", "error"); return; }
    if (!(await confirmAction("تأكيد حفظ بيانات الجهة؟"))) return;
    try {
      cfg = await api.updateCompanyConfig(user?.username ?? "sysadmin", data);
      applyBranding(cfg);
      showToast("تم حفظ بيانات الجهة");
    } catch (err) { showToast(err?.message ?? "خطأ", "error"); }
  });

  container.querySelector("#btn-upload-logo").addEventListener("click", async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }],
      });
      if (!selected) return;
      if (!(await confirmAction("تأكيد رفع شعار جديد؟"))) return;
      cfg = await api.uploadCompanyLogo(user?.username ?? "sysadmin", selected);
      applyBranding(cfg);
      showToast("تم رفع الشعار بنجاح");
      container.innerHTML = html();
    } catch (err) {
      showToast(err?.message ?? "فشل رفع الشعار", "error");
    }
  });
}
