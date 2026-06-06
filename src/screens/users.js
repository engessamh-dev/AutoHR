/**
 * screens/users.js — User management (sysadmin only)
 */
import { api }       from "../api.js";
import { showToast, escHtml, confirmAction } from "../utils.js";

const MAX_USERS = 10;

export async function renderUsers(container, user, ctx) {
  let users = await api.listUsers();

  function html() {
    return `<div class="space-y-6">
      <div class="card">
        <div class="flex items-center justify-between mb-4">
          <p class="section-title mb-0">المستخدمون (${users.length}/${MAX_USERS})</p>
          ${users.length < MAX_USERS
            ? `<button id="btn-add-user" class="btn-primary text-sm px-3 py-1.5">+ مستخدم جديد</button>`
            : `<span class="text-xs text-gray-500">الحد الأقصى ${MAX_USERS} مستخدمين</span>`}
        </div>
        <table class="w-full">
          <thead><tr>
            <th class="table-header">اسم المستخدم</th>
            <th class="table-header">الدور</th>
            <th class="table-header">تاريخ الإنشاء</th>
            <th class="table-header">إجراء</th>
          </tr></thead>
          <tbody>
            ${users.map(u => `
              <tr class="table-row">
                <td class="table-cell font-medium" dir="ltr">${escHtml(u.username)}</td>
                <td class="table-cell">
                  <span class="badge ${u.role === "master" ? "badge-green" : "badge-gray"}">
                    ${u.role === "master" ? "مسؤول" : "مشغّل"}
                  </span>
                </td>
                <td class="table-cell">${u.created_at?.slice(0,10) ?? "—"}</td>
                <td class="table-cell">
                  ${u.username !== "sysadmin"
                    ? `<button class="btn-danger text-xs px-2 py-1 btn-del-user" data-uid="${u.id}" data-uname="${escHtml(u.username)}">حذف</button>`
                    : `<span class="text-xs text-gray-600">محمي</span>`}
                </td>
              </tr>`).join("")}
          </tbody>
        </table>
      </div>
    </div>`;
  }

  container.innerHTML = html();

  function attachEvents() {
    container.querySelector("#btn-add-user")?.addEventListener("click", async () => {
      const uname = prompt("اسم المستخدم الجديد:");
      if (!uname?.trim()) return;
      const pass  = prompt("كلمة المرور:");
      if (!pass)  return;
      const role  = await confirmAction("هل يكون المستخدم مسؤولاً؟\nاختر إلغاء لجعله مشغّلاً.") ? "master" : "operator";
      if (!(await confirmAction(`تأكيد إنشاء المستخدم "${uname.trim()}"؟`))) return;
      try {
        await api.createUser(user?.username, { username: uname.trim(), password: pass, role });
        users = await api.listUsers();
        showToast("تم إنشاء المستخدم");
        container.innerHTML = html();
        attachEvents();
      } catch (err) { showToast(err?.message ?? String(err || "خطأ"), "error"); }
    });

    container.querySelectorAll(".btn-del-user").forEach(btn => {
      btn.addEventListener("click", async () => {
        const uid   = parseInt(btn.dataset.uid);
        const uname = btn.dataset.uname;
        if (!(await confirmAction(`تأكيد حذف المستخدم "${uname}"؟`))) return;
        try {
          await api.deleteUser(user?.username, uid);
          users = await api.listUsers();
          showToast("تم حذف المستخدم");
          container.innerHTML = html();
          attachEvents();
        } catch (err) { showToast(err?.message ?? String(err || "خطأ"), "error"); }
      });
    });
  }
  attachEvents();
}
