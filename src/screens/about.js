/**
 * screens/about.js — Product identity, version and developer (visible to every user)
 */
import { api }       from "../api.js";
import { escHtml }   from "../utils.js";
import { convertFileSrc } from "@tauri-apps/api/core";
import { can }       from "../permissions.js";
import { APP_VERSION } from "../version.js";

export async function renderAbout(container, user, ctx) {
  let companyConfig = null;
  try { companyConfig = await api.getPublicCompanyConfig(); } catch {}
  const companyLine = [companyConfig?.company_name, companyConfig?.department_name].filter(Boolean).join(" · ");
  const canOpenSettings = can(user, "settings.manage") || can(user, "backups.manage");

  container.innerHTML = `
    <div class="card about-card">
      ${companyConfig?.logo_full_path
        ? `<img src="${escHtml(convertFileSrc(companyConfig.logo_full_path))}" alt="شعار الجهة" class="about-logo" />`
        : `<div class="about-logo about-logo-fallback">CNS</div>`}
      <div class="min-w-0">
        <h2 class="text-xl font-bold">CNSArch</h2>
        <p class="text-sm text-gray-300">نظام الأرشفة الإلكتروني</p>
        ${companyLine ? `<p class="text-sm text-gray-400 mt-1">${escHtml(companyLine)}</p>` : ""}
        <dl class="about-facts">
          <div><dt>الإصدار</dt><dd><span dir="ltr">${escHtml(APP_VERSION)}</span></dd></div>
          <div><dt>المطوّر</dt><dd dir="ltr">Eng. Essam Hassan</dd></div>
        </dl>
        ${canOpenSettings ? `<button type="button" id="btn-open-settings" class="btn-secondary text-sm px-3 py-1.5 mt-4">إعدادات النظام</button>` : ""}
      </div>
    </div>`;

  container.querySelector("#btn-open-settings")?.addEventListener("click", () => ctx?.navigateTo?.("settings"));
}
