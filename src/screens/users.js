import { api } from "../api.js";
import { showToast, escHtml, confirmAction, arCount, errorText, formatDate } from "../utils.js";
import { can, roles, roleLabels, roleDescriptions, permissionMatrix } from "../permissions.js";
import { loadPasswordPolicy, forgetPasswordPolicy, mountPasswordRules, passwordProblem } from "../password-rules.js";
import { printRecoveryCode, copyText } from "../recovery.js";

const MAX_USERS = 10;
// Search and the role filter only help once the list no longer fits at a glance.
const SEARCH_FROM = 7;
const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,64}$/;
const USERNAME_HELP = "بالإنجليزية: أحرف وأرقام و . - _ فقط، من 3 أحرف على الأقل. لا يهم حجم الأحرف عند الدخول.";
const TRASH_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>`;

// «2026/11/25 18:04» from «2026-11-25 18:04:31».
function dateTime(value) {
  if (!value) return "";
  const time = String(value).match(/[ T](\d{2}:\d{2})/)?.[1];
  return time ? `${formatDate(value)} ${time}` : formatDate(value);
}

export async function renderUsers(host, user) {
  // Each part is its own item in the side list of «المستخدمين والصلاحيات» (settings.js mounts the list,
  // as in «الدعم وحول النظام»). The users list re-renders on every search; the other parts stay put.
  const canManageUsers = can(user, "users.manage");
  const canRecovery = canManageUsers && can(user, "users.assign_system_admin");
  host.innerHTML = `<div class="settings-stack">
    <div data-sub="list" data-sub-label="إدارة المستخدمين" data-users-list></div>
    <div data-sub="roles" data-sub-label="ماذا يستطيع كل دور" data-users-roles></div>
    ${canManageUsers ? `<div data-sub="policy" data-sub-label="سياسة كلمة المرور" data-users-policy></div>` : ""}
    ${canRecovery ? `<div data-sub="recovery" data-sub-label="رمز استعادة المسؤول" data-users-recovery></div>` : ""}
  </div>`;
  const container = host.querySelector("[data-users-list]");
  let users = await api.listUsers();
  let policy = await loadPasswordPolicy({ fresh: true });
  let search = "";
  let roleFilter = "";
  const canAssignSystemAdmin = can(user, "users.assign_system_admin");
  const assignableRoles = roles.filter(role => role !== "system_admin" || canAssignSystemAdmin);

  const isSelf = item => item.id === user.id;
  const isBase = item => item.is_base ?? item.username === "sysadmin";
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
            <input id="new-user-password" class="input-field" type="password" dir="ltr" autocomplete="new-password" />
          </div>
          <div>
            <label for="new-user-password-confirm" class="block text-xs text-gray-500 mb-1">تأكيد كلمة المرور</label>
            <input id="new-user-password-confirm" class="input-field" type="password" autocomplete="new-password" />
          </div>
        </div>
        <div id="new-user-rules"></div>
        <p class="field-help" style="margin-top:-6px">سيُطلب منه تغييرها عند أول دخول.</p>
        <div>
          <p class="block text-xs text-gray-500 mb-1">الدور</p>
          ${roleCards("new-role", null)}
        </div>`,
      onOpen: modal => {
        const input = modal.querySelector("#new-username");
        const help = modal.querySelector("#new-username-help");
        const refresh = mountPasswordRules(modal.querySelector("#new-user-rules"), modal.querySelector("#new-user-password"), policy, () => input.value);
        input.addEventListener("input", refresh);
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
        const problem = passwordProblem(policy, password, username);
        if (problem) throw new Error(problem);
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
            <input id="reset-password" class="input-field" type="password" dir="ltr" autocomplete="new-password" placeholder="كلمة مرور مؤقتة جديدة" aria-label="كلمة مرور مؤقتة جديدة" />
            <input id="reset-password-confirm" class="input-field" type="password" dir="ltr" autocomplete="new-password" placeholder="تأكيد كلمة المرور" aria-label="تأكيد كلمة المرور" />
          </div>
          <div id="reset-rules" class="hidden"></div>
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
      onOpen: modal => {
        // The rules appear once someone starts typing a new password.
        const input = modal.querySelector("#reset-password");
        const holder = modal.querySelector("#reset-rules");
        mountPasswordRules(holder, input, policy, () => item.username);
        input.addEventListener("input", () => holder.classList.toggle("hidden", !input.value));
      },
      onSubmit: async modal => {
        const role = modal.querySelector("input[name=edit-role]:checked")?.value ?? item.role;
        const password = modal.querySelector("#reset-password").value;
        const confirm = modal.querySelector("#reset-password-confirm").value;
        const disabled = modal.querySelector("#user-disabled")?.checked ?? item.disabled;
        if (password || confirm) {
          const problem = passwordProblem(policy, password, item.username);
          if (problem) throw new Error(problem);
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
  host.querySelector("[data-users-roles]").innerHTML = `
    <section class="card settings-block users-help" aria-labelledby="roles-title">
      <div class="settings-block-head"><p id="roles-title" class="settings-block-title">ماذا يستطيع كل دور</p></div>
      <div class="overflow-auto">
        <table class="users-matrix">
          <thead><tr><th></th>${roles.map(role => `<th><span class="role-badge is-${role}">${escHtml(roleLabels[role])}</span></th>`).join("")}</tr></thead>
          <tbody>
            ${permissionMatrix.map(([label, allowed]) => `<tr><td>${escHtml(label)}</td>${roles.map(role => allowed.includes(role)
              ? `<td class="yes" aria-label="نعم">✓</td>` : `<td class="no" aria-label="لا">—</td>`).join("")}</tr>`).join("")}
          </tbody>
        </table>
        <p class="field-help mt-2">البرنامج يتحقق من الدور مع كل عملية، فتغيير الدور يسري فورًا. وكل إضافة وحذف وتغيير دور وإعادة كلمة مرور وإيقاف تُسجل في سجل النظام.</p>
      </div>
    </section>`;
  if (canManageUsers) {
    const policyHost = host.querySelector("[data-users-policy]");
    const recoveryHost = host.querySelector("[data-users-recovery]");
    renderSecurity(policyHost, recoveryHost, () => loadPasswordPolicy({ fresh: true }).then(p => { policy = p; }))
      .catch(err => { policyHost.innerHTML = `<div class="card text-sm text-gray-400" dir="auto">${escHtml(errorText(err))}</div>`; });
  }
}

/** «سياسة كلمة المرور» into `host`, and «رمز استعادة حساب المسؤول» into `recoveryHost` when the admin may see it. */
async function renderSecurity(host, recoveryHost, onPolicyChange) {
  const policy = await loadPasswordPolicy({ fresh: true });
  const canRecovery = Boolean(recoveryHost);
  let recovery = null;
  if (canRecovery) { try { recovery = await api.getRecoveryStatus(); } catch { recovery = null; } }
  const check = (id, label, on) => `<label class="policy-check"><input type="checkbox" id="${id}" ${on ? "checked" : ""} /> ${escHtml(label)}</label>`;
  host.innerHTML = `
    <section class="card settings-block space-y-3" aria-labelledby="policy-title">
      <div class="settings-block-head">
        <p id="policy-title" class="settings-block-title">سياسة كلمة المرور</p>
        <p class="settings-block-help">تسري على كل كلمة مرور جديدة: إضافة مستخدم، وإعادة التعيين، وتغيير كلمة المرور. كلمات المرور الحالية تبقى تعمل حتى تُغيَّر.</p>
      </div>
      <div class="policy-grid">
        <div>
          <label class="section-title" for="policy-length">أقل عدد من الأحرف</label>
          <input id="policy-length" class="input-field" type="number" min="8" max="64" value="${policy.min_length}" />
        </div>
        <div class="policy-checks">
          <p class="section-title">يجب أن تحتوي على</p>
          ${check("policy-upper", "حرف إنجليزي كبير (A-Z)", policy.require_upper)}
          ${check("policy-lower", "حرف إنجليزي صغير (a-z)", policy.require_lower)}
          ${check("policy-digit", "رقم (0-9)", policy.require_digit)}
          ${check("policy-symbol", "رمز مثل ! @ # $", policy.require_symbol)}
        </div>
        <div class="policy-checks">
          <p class="section-title">رفض</p>
          ${check("policy-common", "الكلمات السهلة والمتسلسلة (مثل 12345678 وPassword1)", policy.reject_common)}
          <p class="field-help">واسم المستخدم داخل كلمة المرور مرفوض دائمًا.</p>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="section-title" for="policy-failures">محاولات قبل الإيقاف</label>
            <input id="policy-failures" class="input-field" type="number" min="3" max="20" value="${policy.max_failures}" />
          </div>
          <div>
            <label class="section-title" for="policy-lockout">مدة الإيقاف (دقائق)</label>
            <input id="policy-lockout" class="input-field" type="number" min="1" max="60" value="${policy.lockout_minutes}" />
          </div>
          <p class="field-help col-span-2">المحاولات الخاطئة المتباعدة (أكثر من 15 دقيقة) لا تُحسب.</p>
        </div>
      </div>
      <p id="policy-error" class="text-autohr-red text-sm hidden" role="alert"></p>
      <div class="settings-block-foot"><button id="btn-save-policy" type="button" class="btn-primary" disabled>حفظ سياسة كلمة المرور</button></div>
    </section>`;
  if (canRecovery) recoveryHost.innerHTML = `
    <section class="card settings-block space-y-3" aria-labelledby="recovery-settings-title">
      <div class="settings-block-head">
        <p id="recovery-settings-title" class="settings-block-title">رمز استعادة حساب المسؤول</p>
        <p class="settings-block-help">إذا نسي المسؤول الأساسي كلمة مروره، يكتب هذا الرمز في «نسيت كلمة المرور؟» بشاشة الدخول.</p>
      </div>
      <p class="text-sm" id="recovery-state">${recovery?.exists
        ? `يوجد رمز للحساب <bdi dir="ltr">${escHtml(recovery.admin)}</bdi>، أُنشئ في <bdi dir="ltr">${escHtml(String(recovery.created_at ?? "").replaceAll("-", "/"))}</bdi>.`
        : `<span class="setup-note is-warn" style="display:inline-block">لا يوجد رمز استعادة بعد. أنشئ واحدًا واحفظه مطبوعًا.</span>`}</p>
      <div class="settings-block-foot"><button id="btn-new-recovery" type="button" class="btn-secondary">إنشاء رمز جديد</button></div>
    </section>`;

  const error = host.querySelector("#policy-error");
  const saveButton = host.querySelector("#btn-save-policy");
  const readForm = () => {
    const number = id => Number(host.querySelector(id).value);
    return {
      min_length: number("#policy-length"), max_failures: number("#policy-failures"), lockout_minutes: number("#policy-lockout"),
      require_upper: host.querySelector("#policy-upper").checked, require_lower: host.querySelector("#policy-lower").checked,
      require_digit: host.querySelector("#policy-digit").checked, require_symbol: host.querySelector("#policy-symbol").checked,
      reject_common: host.querySelector("#policy-common").checked,
    };
  };
  // «حفظ» stays off until something in the policy form differs from what is saved.
  let saved = JSON.stringify(readForm());
  const refreshSave = () => { saveButton.disabled = JSON.stringify(readForm()) === saved; };
  host.querySelectorAll(".policy-grid input").forEach(input => {
    input.addEventListener("input", refreshSave);
    input.addEventListener("change", refreshSave);
  });
  saveButton.addEventListener("click", async () => {
    const next = readForm();
    const problem = !(next.min_length >= 8 && next.min_length <= 64) ? "أقل عدد من الأحرف من 8 إلى 64"
      : !(next.max_failures >= 3 && next.max_failures <= 20) ? "المحاولات قبل الإيقاف من 3 إلى 20"
      : !(next.lockout_minutes >= 1 && next.lockout_minutes <= 60) ? "مدة الإيقاف من 1 إلى 60 دقيقة" : "";
    error.textContent = problem;
    error.classList.toggle("hidden", !problem);
    if (problem) return;
    try {
      await api.setPasswordPolicy(next);
      saved = JSON.stringify(next);
      refreshSave();
      forgetPasswordPolicy();
      await onPolicyChange();
      showToast("تم حفظ سياسة كلمة المرور");
    } catch (err) {
      error.textContent = errorText(err);
      error.classList.remove("hidden");
    }
  });

  recoveryHost?.querySelector("#btn-new-recovery")?.addEventListener("click", async () => {
    const ok = await confirmAction("سيتوقف الرمز القديم فورًا، ويُعرض رمز جديد مرة واحدة فقط. هل تريد المتابعة؟",
      { title: "رمز استعادة جديد", confirmLabel: "إنشاء رمز جديد" });
    if (!ok) return;
    try {
      const code = await api.regenerateRecoveryCode();
      const status = await api.getRecoveryStatus().catch(() => ({ admin: "" }));
      const overlay = document.createElement("div");
      overlay.className = "recovery-overlay";
      overlay.setAttribute("dir", "rtl");
      overlay.innerHTML = `<div class="card app-dialog recovery-dialog" role="dialog" aria-modal="true">
        <p class="dialog-title">رمز الاستعادة الجديد</p>
        <p class="text-sm leading-7">اطبعه أو اكتبه واحفظه في مكان آمن. <strong>لن يظهر مرة أخرى.</strong></p>
        <div class="recovery-code-box"><p class="recovery-code-user">الحساب: <bdi dir="ltr">${escHtml(status.admin)}</bdi></p><p class="recovery-code" dir="ltr">${escHtml(code)}</p></div>
        <div class="flex gap-3 flex-wrap"><button type="button" data-print class="btn-secondary">طباعة</button><button type="button" data-copy class="btn-secondary">نسخ</button></div>
        <label class="role-card" style="align-items:center"><input type="checkbox" data-saved style="margin-top:0" /><span class="role-card-name">حفظت الرمز في مكان آمن</span></label>
        <button type="button" data-done class="btn-primary" disabled>تم</button>
      </div>`;
      document.body.append(overlay);
      overlay.querySelector("[data-print]").addEventListener("click", () => printRecoveryCode(status.admin, code));
      overlay.querySelector("[data-copy]").addEventListener("click", () => copyText(code));
      overlay.querySelector("[data-saved]").addEventListener("change", e => { overlay.querySelector("[data-done]").disabled = !e.target.checked; });
      overlay.querySelector("[data-done]").addEventListener("click", () => { overlay.remove(); renderSecurity(host, recoveryHost, onPolicyChange); });
    } catch (err) {
      showToast(errorText(err), "error");
    }
  });
}
