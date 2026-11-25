import { api } from "../api.js";
import { showToast, escHtml, confirmAction, arCount, errorText, formatDate } from "../utils.js";
import { can, roles, roleLabels, roleDescriptions, permissionMatrix } from "../permissions.js";

const MAX_USERS = 10;
// Search and the role filter only help once the list no longer fits at a glance.
const SEARCH_FROM = 7;
const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,64}$/;
const USERNAME_HELP = "بالإنجليزية: أحرف وأرقام و . - _ فقط، من 3 أحرف على الأقل. يُكتب عند الدخول كما هو.";
const TRASH_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>`;

// «2026/11/25 18:04» from «2026-11-25 18:04:31».
function dateTime(value) {
  if (!value) return "";
  const time = String(value).match(/[ T](\d{2}:\d{2})/)?.[1];
  return time ? `${formatDate(value)} ${time}` : formatDate(value);
}

export async function renderUsers(container, user) {
  let users = await api.listUsers();
  let search = "";
  let roleFilter = "";
  const canAssignSystemAdmin = can(user, "users.assign_system_admin");
  const assignableRoles = roles.filter(role => role !== "system_admin" || canAssignSystemAdmin);

  const isSelf = item => item.id === user.id;
  const isBase = item => item.username === "sysadmin";
  // Accounts this admin may change at all (an admin without the System Admin permission
  // cannot touch a System Admin; Rust refuses it too).
  const canManage = item => canAssignSystemAdmin || item.role !== "system_admin";
  const deleteBlock = item => isBase(item) ? "لا يمكن حذف مستخدم النظام الأساسي"
    : isSelf(item) ? "لا يمكنك حذف حسابك"
    : !canManage(item) ? "يديره المسؤول" : "";

  const filteredUsers = () => users.filter(item => {
    const matchesSearch = !search || item.username.toLowerCase().includes(search.toLowerCase());
    return matchesSearch && (!roleFilter || item.role === roleFilter);
  });

  const roleCards = (name, selected, { current = null, disabledReason = "" } = {}) => `
    <div class="role-cards" role="radiogroup" aria-label="الدور">
      ${(disabledReason ? [current] : assignableRoles).map(role => `
        <label class="role-card${role === current && !disabledReason ? " is-current" : ""}"${disabledReason ? ` style="cursor:default"` : ""}>
          ${disabledReason ? "" : `<input type="radio" name="${name}" value="${role}" ${role === selected ? "checked" : ""} />`}
          <span>
            <span class="role-card-name">${escHtml(roleLabels[role])}</span>
            <span class="role-card-help block">${escHtml(roleDescriptions[role])}</span>
          </span>
        </label>`).join("")}
    </div>
    ${disabledReason ? `<p class="field-help">${escHtml(disabledReason)}</p>` : ""}`;

  function openModal({ title, body, submitLabel = "حفظ", onSubmit, onOpen }) {
    const overlay = document.createElement("div");
    overlay.setAttribute("dir", "rtl");
    overlay.style.cssText = "position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.66);display:flex;align-items:center;justify-content:center;padding:20px";
    overlay.innerHTML = `
      <form class="card app-dialog space-y-4" role="dialog" aria-modal="true" novalidate style="width:min(520px,100%);max-height:calc(100vh - 40px);overflow:auto;padding:20px">
        <div class="flex items-start justify-between gap-3">
          <p class="dialog-title">${title}</p>
          <button type="button" class="modal-close" aria-label="إغلاق" title="إغلاق (Esc)"
            style="border:0;background:transparent;color:var(--ui-text-muted);font-size:22px;line-height:1;cursor:pointer;padding:0 8px;border-radius:6px">×</button>
        </div>
        ${body}
        <p class="field-error hidden" data-dialog-error role="alert"></p>
        <div class="flex gap-3 pt-1">
          <button type="submit" class="btn-primary flex-1">${escHtml(submitLabel)}</button>
          <button type="button" class="btn-secondary modal-close">إلغاء</button>
        </div>
      </form>`;
    const form = overlay.querySelector("form");
    const errorLine = overlay.querySelector("[data-dialog-error]");
    const close = () => {
      document.removeEventListener("keydown", onKeyDown);
      overlay.remove();
    };
    const onKeyDown = event => { if (event.key === "Escape") close(); };
    overlay.querySelectorAll(".modal-close").forEach(button => button.addEventListener("click", close));
    overlay.addEventListener("click", event => { if (event.target === overlay) close(); });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const submit = event.submitter ?? form.querySelector("[type=submit]");
      submit.disabled = true;
      errorLine.classList.add("hidden");
      try {
        await onSubmit(overlay);
        close();
      } catch (error) {
        // In the dialog itself, where the admin is looking, and in Arabic.
        errorLine.textContent = errorText(error);
        errorLine.classList.remove("hidden");
      } finally {
        submit.disabled = false;
      }
    });
    document.addEventListener("keydown", onKeyDown);
    document.body.append(overlay);
    onOpen?.(overlay);
    setTimeout(() => overlay.querySelector("input:not([disabled]):not([type=radio]),input[type=radio]:checked:not([disabled])")?.focus(), 0);
  }

  async function reload() {
    users = await api.listUsers();
    render();
  }

  function addUserModal() {
    openModal({
      title: "إضافة مستخدم جديد",
      submitLabel: "إضافة المستخدم",
      body: `
        <div>
          <label for="new-username" class="block text-xs text-gray-500 mb-1">اسم المستخدم</label>
          <input id="new-username" class="input-field" dir="ltr" style="text-align:left" autocomplete="off" spellcheck="false" placeholder="archive.user" />
          <p class="field-help" id="new-username-help">${escHtml(USERNAME_HELP)}</p>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label for="new-user-password" class="block text-xs text-gray-500 mb-1">كلمة المرور المؤقتة</label>
            <input id="new-user-password" class="input-field" type="password" autocomplete="new-password" placeholder="8 أحرف على الأقل" />
          </div>
          <div>
            <label for="new-user-password-confirm" class="block text-xs text-gray-500 mb-1">تأكيد كلمة المرور</label>
            <input id="new-user-password-confirm" class="input-field" type="password" autocomplete="new-password" />
          </div>
        </div>
        <p class="field-help" style="margin-top:-6px">سيُطلب منه تغييرها عند أول دخول.</p>
        <div>
          <p class="block text-xs text-gray-500 mb-1">الدور</p>
          ${roleCards("new-role", null)}
        </div>`,
      onOpen: modal => {
        const input = modal.querySelector("#new-username");
        const help = modal.querySelector("#new-username-help");
        input.addEventListener("input", () => {
          const bad = input.value.trim() && !/^[A-Za-z0-9._-]*$/.test(input.value.trim());
          help.textContent = bad ? "استعمل أحرفًا إنجليزية وأرقامًا و . - _ فقط" : USERNAME_HELP;
          help.classList.toggle("field-error", Boolean(bad));
          help.classList.toggle("field-help", !bad);
        });
      },
      onSubmit: async modal => {
        const username = modal.querySelector("#new-username").value.trim();
        const password = modal.querySelector("#new-user-password").value;
        const confirm = modal.querySelector("#new-user-password-confirm").value;
        const role = modal.querySelector("input[name=new-role]:checked")?.value;
        if (!username) throw new Error("اكتب اسم المستخدم");
        if (!USERNAME_PATTERN.test(username)) throw new Error("اسم المستخدم من 3 أحرف على الأقل: أحرف إنجليزية وأرقام و . - _ فقط");
        if (users.some(item => item.username.toLowerCase() === username.toLowerCase())) throw new Error(`اسم المستخدم «${username}» موجود`);
        if ([...password].length < 8) throw new Error("كلمة المرور يجب أن تكون 8 أحرف على الأقل");
        if (password !== confirm) throw new Error("كلمتا المرور غير متطابقتين");
        if (!role) throw new Error("اختر دور المستخدم");
        await api.createUser({ username, password, role });
        await reload();
        showToast(`تمت إضافة ${username}`);
      },
    });
  }

  function editUserModal(item) {
    const roleLocked = isBase(item) ? "دور مستخدم النظام الأساسي ثابت."
      : isSelf(item) ? "لا يمكنك تغيير دورك. يغيّره مسؤول آخر." : "";
    const canStop = !isBase(item) && !isSelf(item);
    openModal({
      title: `تعديل المستخدم <bdi dir="ltr">${escHtml(item.username)}</bdi>`,
      submitLabel: "حفظ",
      body: `
        <div>
          <p class="block text-xs text-gray-500 mb-1">الدور</p>
          ${roleCards("edit-role", item.role, { current: item.role, disabledReason: roleLocked })}
        </div>
        <div class="space-y-2">
          <p class="block text-xs text-gray-500">إعادة تعيين كلمة المرور <span class="text-gray-500">(اتركها فارغة إن لم تُرد تغييرها)</span></p>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <input id="reset-password" class="input-field" type="password" autocomplete="new-password" placeholder="كلمة مرور مؤقتة جديدة" aria-label="كلمة مرور مؤقتة جديدة" />
            <input id="reset-password-confirm" class="input-field" type="password" autocomplete="new-password" placeholder="تأكيد كلمة المرور" aria-label="تأكيد كلمة المرور" />
          </div>
          <p class="field-help">${isSelf(item) ? "ستُطلب منك كلمة مرور جديدة عند دخولك التالي." : "سيُطلب منه تغييرها عند دخوله التالي."}</p>
        </div>
        ${canStop ? `
        <label class="role-card" style="align-items:center">
          <input type="checkbox" id="user-disabled" ${item.disabled ? "checked" : ""} style="margin-top:0" />
          <span>
            <span class="role-card-name">إيقاف الحساب</span>
            <span class="role-card-help block">لا يستطيع الدخول حتى تعيد تفعيله. يبقى اسمه في سجل النظام.</span>
          </span>
        </label>` : ""}`,
      onSubmit: async modal => {
        const role = modal.querySelector("input[name=edit-role]:checked")?.value ?? item.role;
        const password = modal.querySelector("#reset-password").value;
        const confirm = modal.querySelector("#reset-password-confirm").value;
        const disabled = modal.querySelector("#user-disabled")?.checked ?? item.disabled;
        if (password || confirm) {
          if ([...password].length < 8) throw new Error("كلمة المرور يجب أن تكون 8 أحرف على الأقل");
          if (password !== confirm) throw new Error("كلمتا المرور غير متطابقتين");
        }
        const done = [];
        if (!roleLocked && role !== item.role) {
          await api.updateUserRole(item.id, role);
          done.push(`صار دوره «${roleLabels[role]}»`);
        }
        if (password) {
          await api.resetUserPassword(item.id, password);
          done.push("أُعيد تعيين كلمة المرور");
        }
        if (canStop && disabled !== Boolean(item.disabled)) {
          await api.setUserDisabled(item.id, disabled);
          done.push(disabled ? "أُوقف الحساب" : "أُعيد تفعيل الحساب");
        }
        await reload();
        showToast(done.length ? `${item.username}: ${done.join("، ")}` : "لم يتغير شيء");
      },
    });
  }

  function userStates(item) {
    const states = [];
    if (isBase(item)) states.push(`<span class="user-state is-muted">مستخدم النظام الأساسي</span>`);
    if (item.trusted === false) states.push(`<span class="user-state is-danger" title="عُدّلت بيانات هذا الحساب من خارج البرنامج فأُوقف. احذفه وأنشئه من جديد، أو اعتمد البيانات من «الفحص والدعم».">موقوف: عُدّل من خارج البرنامج</span>`);
    if (item.disabled) states.push(`<span class="user-state is-danger">موقوف</span>`);
    if (item.must_change_password) states.push(`<span class="user-state is-warn">بانتظار تغيير كلمة المرور</span>`);
    return states.join("");
  }

  function actionsCell(item) {
    if (!canManage(item)) return `<span class="text-xs text-gray-500">يديره المسؤول</span>`;
    const block = deleteBlock(item);
    return `
      <div class="flex gap-2 items-center justify-end">
        <button class="btn-secondary text-xs edit-user" data-id="${item.id}">تعديل</button>
        <button type="button" class="user-icon-btn delete-user" data-id="${item.id}" ${block ? `disabled aria-disabled="true" style="opacity:.35;cursor:not-allowed"` : ""}
          title="${escHtml(block || "حذف المستخدم")}" aria-label="${escHtml(block || `حذف ${item.username}`)}">${TRASH_ICON}</button>
      </div>`;
  }

  function render() {
    const visible = filteredUsers();
    const showSearch = users.length >= SEARCH_FROM;
    if (!showSearch) { search = ""; roleFilter = ""; }
    const full = users.length >= MAX_USERS;
    container.innerHTML = `
      <div class="space-y-4">
        <div class="card space-y-4">
          <div class="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <p class="settings-block-title">إدارة المستخدمين</p>
              <p class="settings-block-help">من يدخل إلى البرنامج، وبأي دور. <span class="badge badge-gray" style="margin-inline-start:6px">${users.length} من ${MAX_USERS} مستخدمين</span></p>
            </div>
            ${full
              ? `<div class="flex flex-col items-end gap-1">
                  <button type="button" class="btn-primary" disabled aria-disabled="true" style="opacity:.5;cursor:not-allowed">+ إضافة مستخدم</button>
                  <span class="text-xs text-gray-500">وصلت إلى الحد الأقصى (${MAX_USERS} مستخدمين). احذف مستخدمًا لإضافة آخر.</span>
                </div>`
              : `<button id="btn-add-user" class="btn-primary">+ إضافة مستخدم</button>`}
          </div>
          ${showSearch ? `
          <div class="grid grid-cols-1 md:grid-cols-[1fr_200px_auto] gap-3 items-center">
            <input id="user-search" class="input-field" placeholder="بحث باسم المستخدم..." value="${escHtml(search)}" />
            <select id="user-role-filter" class="input-field">
              <option value="">كل الأدوار</option>
              ${roles.map(role => `<option value="${role}" ${roleFilter === role ? "selected" : ""}>${escHtml(roleLabels[role])}</option>`).join("")}
            </select>
            ${visible.length === users.length ? "" : `<span class="badge badge-gray">${visible.length} من ${arCount(users.length, "user")}</span>`}
          </div>` : ""}

          <div class="overflow-auto">
            <table class="w-full users-table">
              <thead><tr>
                <th class="table-header">اسم المستخدم</th>
                <th class="table-header">الدور</th>
                <th class="table-header">أُنشئ في</th>
                <th class="table-header">آخر دخول</th>
                <th class="table-header"><span class="sr-only">الإجراءات</span></th>
              </tr></thead>
              <tbody>
                ${visible.length ? visible.map(item => `
                  <tr class="table-row${item.disabled || item.trusted === false ? " is-disabled" : ""}">
                    <td class="table-cell">
                      <div class="flex items-center gap-3">
                        <span style="display:grid;place-items:center;width:34px;height:34px;flex:none;border-radius:50%;background:var(--ui-accent-soft);color:var(--ui-info);font-weight:800">
                          ${escHtml(item.username.slice(0, 1).toUpperCase())}
                        </span>
                        <div>
                          <p class="font-medium text-gray-100"><bdi dir="ltr">${escHtml(item.username)}</bdi>${isSelf(item) ? ` <span class="text-xs text-autohr-green">(أنت)</span>` : ""}</p>
                          ${userStates(item)}
                        </div>
                      </div>
                    </td>
                    <td class="table-cell"><span class="role-badge is-${escHtml(item.role)}">${escHtml(roleLabels[item.role] ?? item.role)}</span></td>
                    <td class="table-cell text-sm text-gray-400" dir="ltr" style="text-align:right">${escHtml(formatDate(item.created_at))}</td>
                    <td class="table-cell text-sm text-gray-400" dir="ltr" style="text-align:right">${item.last_login ? escHtml(dateTime(item.last_login)) : `<span dir="rtl">لم يدخل بعد</span>`}</td>
                    <td class="table-cell">${actionsCell(item)}</td>
                  </tr>`).join("") : `<tr><td colspan="5" class="table-cell text-center text-gray-500 py-10">لا توجد نتائج مطابقة</td></tr>`}
              </tbody>
            </table>
          </div>
        </div>

        <details class="card users-help">
          <summary>ماذا يستطيع كل دور</summary>
          <div class="overflow-auto mt-3">
            <table class="users-matrix">
              <thead><tr><th></th>${roles.map(role => `<th><span class="role-badge is-${role}">${escHtml(roleLabels[role])}</span></th>`).join("")}</tr></thead>
              <tbody>
                ${permissionMatrix.map(([label, allowed]) => `<tr><td>${escHtml(label)}</td>${roles.map(role => allowed.includes(role)
                  ? `<td class="yes" aria-label="نعم">✓</td>` : `<td class="no" aria-label="لا">—</td>`).join("")}</tr>`).join("")}
              </tbody>
            </table>
            <p class="field-help mt-2">البرنامج يتحقق من الدور مع كل عملية، فتغيير الدور يسري فورًا. وكل إضافة وحذف وتغيير دور وإعادة كلمة مرور وإيقاف تُسجل في سجل النظام.</p>
          </div>
        </details>
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
    container.querySelectorAll(".edit-user").forEach(button => button.addEventListener("click", () => {
      editUserModal(users.find(item => item.id === Number(button.dataset.id)));
    }));
    container.querySelectorAll(".delete-user:not([disabled])").forEach(button => button.addEventListener("click", async () => {
      const item = users.find(userItem => userItem.id === Number(button.dataset.id));
      const confirmed = await confirmAction(
        `سيُحذف المستخدم ${item.username} نهائيًا، ولن يستطيع الدخول. يبقى اسمه في سجل النظام.\nلإيقافه مؤقتًا بدل الحذف: «تعديل» ثم «إيقاف الحساب».`,
        { title: "حذف المستخدم", confirmLabel: "حذف المستخدم", danger: true },
      );
      if (!confirmed) return;
      try {
        await api.deleteUser(item.id);
        await reload();
        showToast(`حُذف المستخدم ${item.username}`);
      } catch (error) {
        showToast(errorText(error), "error");
      }
    }));
  }

  render();
}
