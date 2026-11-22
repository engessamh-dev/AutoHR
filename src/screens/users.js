import { api } from "../api.js";
import { showToast, escHtml, confirmAction } from "../utils.js";
import { can, roleLabels } from "../permissions.js";

const MAX_USERS = 10;
const roles = ["system_admin", "archive_admin", "archive_officer", "viewer"];

export async function renderUsers(container, user) {
  let users = await api.listUsers();
  let search = "";
  let roleFilter = "";
  const canAssignSystemAdmin = can(user, "users.assign_system_admin");
  const assignableRoles = roles.filter(role => role !== "system_admin" || canAssignSystemAdmin);

  const roleBadgeClass = role => ({
    system_admin: "badge-green",
    archive_admin: "badge-green",
    archive_officer: "badge-gray",
    viewer: "badge-gray",
  })[role] ?? "badge-gray";

  const filteredUsers = () => users.filter(item => {
    const matchesSearch = !search || item.username.toLowerCase().includes(search.toLowerCase());
    return matchesSearch && (!roleFilter || item.role === roleFilter);
  });

  function openModal({ title, body, submitLabel = "حفظ", onSubmit }) {
    const overlay = document.createElement("div");
    overlay.setAttribute("dir", "rtl");
    overlay.style.cssText = "position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.66);display:flex;align-items:center;justify-content:center;padding:20px";
    overlay.innerHTML = `
      <form class="card space-y-4" style="width:min(500px,100%);max-height:calc(100vh - 40px);overflow:auto;padding:20px">
        <div class="flex items-center justify-between gap-3">
          <div>
            <p class="section-title mb-0">${escHtml(title)}</p>
            <p class="text-xs text-gray-500 mt-1">أدخل البيانات المطلوبة ثم اضغط ${escHtml(submitLabel)}</p>
          </div>
          <button type="button" class="btn-secondary modal-close">إغلاق</button>
        </div>
        ${body}
        <div class="flex gap-3 pt-2">
          <button type="submit" class="btn-primary flex-1">${escHtml(submitLabel)}</button>
          <button type="button" class="btn-secondary modal-close">إلغاء</button>
        </div>
      </form>`;
    const close = () => {
      document.removeEventListener("keydown", onKeyDown);
      overlay.remove();
    };
    const onKeyDown = event => { if (event.key === "Escape") close(); };
    overlay.querySelectorAll(".modal-close").forEach(button => button.addEventListener("click", close));
    overlay.addEventListener("click", event => { if (event.target === overlay) close(); });
    overlay.querySelector("form").addEventListener("submit", async event => {
      event.preventDefault();
      const submit = event.submitter;
      submit.disabled = true;
      try {
        await onSubmit(overlay);
        close();
      } catch (error) {
        showToast(error?.message ?? String(error), "error");
      } finally {
        submit.disabled = false;
      }
    });
    document.addEventListener("keydown", onKeyDown);
    document.body.append(overlay);
    setTimeout(() => overlay.querySelector("input,select")?.focus(), 0);
  }

  function addUserModal() {
    openModal({
      title: "إضافة مستخدم جديد",
      submitLabel: "إضافة المستخدم",
      body: `
        <div>
          <p class="text-xs text-gray-500 mb-1">اسم المستخدم</p>
          <input id="new-username" class="input-field" autocomplete="off" placeholder="مثال: archive.user" />
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <p class="text-xs text-gray-500 mb-1">كلمة المرور المؤقتة</p>
            <input id="new-password" class="input-field" type="password" autocomplete="new-password" placeholder="8 أحرف على الأقل" />
          </div>
          <div>
            <p class="text-xs text-gray-500 mb-1">تأكيد كلمة المرور</p>
            <input id="new-password-confirm" class="input-field" type="password" autocomplete="new-password" />
          </div>
        </div>
        <div>
          <p class="text-xs text-gray-500 mb-1">الدور</p>
          <select id="new-role" class="input-field">
            ${assignableRoles.map(role => `<option value="${role}">${escHtml(roleLabels[role])}</option>`).join("")}
          </select>
        </div>
        `,
      onSubmit: async modal => {
        const username = modal.querySelector("#new-username").value.trim();
        const password = modal.querySelector("#new-password").value;
        const confirm = modal.querySelector("#new-password-confirm").value;
        if (!username) throw new Error("اسم المستخدم مطلوب");
        if (password.length < 8) throw new Error("كلمة المرور يجب أن تكون 8 أحرف على الأقل");
        if (password !== confirm) throw new Error("كلمتا المرور غير متطابقتين");
        await api.createUser({
          username,
          password,
          role: modal.querySelector("#new-role").value,
        });
        users = await api.listUsers();
        render();
        showToast("تم إنشاء المستخدم");
      },
    });
  }

  function resetPasswordModal(item) {
    openModal({
      title: `إعادة تعيين كلمة مرور ${item.username}`,
      submitLabel: "إعادة التعيين",
      body: `
        <div class="rounded-lg border border-autohr-border p-3 text-xs text-gray-400">
          سيُطلب من المستخدم تغيير كلمة المرور المؤقتة عند تسجيل الدخول التالي.
        </div>
        <div>
          <p class="text-xs text-gray-500 mb-1">كلمة المرور المؤقتة الجديدة</p>
          <input id="reset-password" class="input-field" type="password" autocomplete="new-password" placeholder="8 أحرف على الأقل" />
        </div>
        <div>
          <p class="text-xs text-gray-500 mb-1">تأكيد كلمة المرور</p>
          <input id="reset-password-confirm" class="input-field" type="password" autocomplete="new-password" />
        </div>`,
      onSubmit: async modal => {
        const password = modal.querySelector("#reset-password").value;
        if (password.length < 8) throw new Error("كلمة المرور يجب أن تكون 8 أحرف على الأقل");
        if (password !== modal.querySelector("#reset-password-confirm").value) throw new Error("كلمتا المرور غير متطابقتين");
        await api.resetUserPassword(item.id, password);
        users = await api.listUsers();
        render();
        showToast("تمت إعادة تعيين كلمة المرور");
      },
    });
  }

  function roleModal(item) {
    openModal({
      title: `تعديل دور ${item.username}`,
      submitLabel: "حفظ الدور",
      body: `
        <div>
          <p class="text-xs text-gray-500 mb-1">الدور الجديد</p>
          <select id="edit-role" class="input-field">
            ${assignableRoles.map(role => `<option value="${role}" ${role === item.role ? "selected" : ""}>${escHtml(roleLabels[role])}</option>`).join("")}
          </select>
        </div>`,
      onSubmit: async modal => {
        await api.updateUserRole(item.id, modal.querySelector("#edit-role").value);
        users = await api.listUsers();
        render();
        showToast("تم تغيير الدور");
      },
    });
  }

  function render() {
    const visible = filteredUsers();
    container.innerHTML = `
      <div class="space-y-4">
        <div class="card space-y-4">
          <div class="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <p class="section-title mb-0">إدارة المستخدمين</p>
              <p class="text-xs text-gray-500 mt-1">إضافة المستخدمين وإدارة أدوارهم وكلمات المرور</p>
            </div>
            ${users.length < MAX_USERS ? `<button id="btn-add-user" class="btn-primary">+ إضافة مستخدم</button>` : ""}
          </div>
          <div class="grid grid-cols-1 md:grid-cols-[1fr_230px_auto] gap-3 items-center">
            <input id="user-search" class="input-field" placeholder="بحث باسم المستخدم..." value="${escHtml(search)}" />
            <select id="user-role-filter" class="input-field">
              <option value="">كل الأدوار</option>
              ${roles.map(role => `<option value="${role}" ${roleFilter === role ? "selected" : ""}>${escHtml(roleLabels[role])}</option>`).join("")}
            </select>
            <span class="badge badge-gray">${visible.length} / ${users.length} مستخدم</span>
          </div>
        </div>

        <div class="card overflow-auto">
          <table class="w-full">
            <thead><tr>
              <th class="table-header">اسم المستخدم</th>
              <th class="table-header">الدور</th>
              <th class="table-header">الإجراءات</th>
            </tr></thead>
            <tbody>
              ${visible.length ? visible.map(item => `
                <tr class="table-row">
                  <td class="table-cell">
                    <div class="flex items-center gap-3">
                      <span style="display:grid;place-items:center;width:34px;height:34px;border-radius:50%;background:#08284a;color:#7dd3fc;font-weight:800">
                        ${escHtml(item.username.slice(0, 1).toUpperCase())}
                      </span>
                      <div>
                        <p class="font-medium text-gray-100" dir="ltr">${escHtml(item.username)}</p>
                        ${item.username === "sysadmin" ? `<p class="text-xs text-gray-500">مستخدم النظام الأساسي</p>` : ""}
                        ${item.must_change_password ? `<span class="badge badge-amber mt-1">بانتظار تغيير كلمة المرور</span>` : ""}
                      </div>
                    </div>
                  </td>
                  <td class="table-cell"><span class="badge ${roleBadgeClass(item.role)}">${escHtml(roleLabels[item.role])}</span></td>
                  <td class="table-cell">
                    <div class="flex gap-2 flex-wrap">
                      ${item.username !== "sysadmin" || canAssignSystemAdmin
                        ? `<button class="btn-secondary text-xs edit-role" data-id="${item.id}">تعديل الدور</button>` : ""}
                      <button class="btn-secondary text-xs reset-password" data-id="${item.id}">إعادة تعيين كلمة المرور</button>
                      ${item.username !== "sysadmin"
                        ? `<button class="btn-danger text-xs delete-user" data-id="${item.id}">حذف</button>`
                        : `<span class="text-xs text-gray-500 self-center">لا يمكن حذف مستخدم النظام</span>`}
                    </div>
                  </td>
                </tr>`).join("") : `<tr><td colspan="3" class="table-cell text-center text-gray-500 py-10">لا توجد نتائج مطابقة</td></tr>`}
            </tbody>
          </table>
        </div>
      </div>`;
    attach();
  }

  function attach() {
    container.querySelector("#btn-add-user")?.addEventListener("click", addUserModal);
    container.querySelector("#user-search")?.addEventListener("input", event => {
      search = event.target.value;
      render();
      const input = container.querySelector("#user-search");
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    container.querySelector("#user-role-filter")?.addEventListener("change", event => {
      roleFilter = event.target.value;
      render();
    });
    container.querySelectorAll(".edit-role").forEach(button => button.addEventListener("click", () => {
      roleModal(users.find(item => item.id === Number(button.dataset.id)));
    }));
    container.querySelectorAll(".reset-password").forEach(button => button.addEventListener("click", () => {
      resetPasswordModal(users.find(item => item.id === Number(button.dataset.id)));
    }));
    container.querySelectorAll(".delete-user").forEach(button => button.addEventListener("click", async () => {
      const item = users.find(userItem => userItem.id === Number(button.dataset.id));
      if (!(await confirmAction(`تأكيد حذف المستخدم "${item.username}"؟`))) return;
      try {
        await api.deleteUser(item.id);
        users = await api.listUsers();
        render();
        showToast("تم حذف المستخدم");
      } catch (error) {
        showToast(error?.message ?? String(error), "error");
      }
    }));
  }

  render();
}
