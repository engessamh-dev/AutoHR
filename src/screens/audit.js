import { api } from "../api.js";
import { debounce, errorText, escHtml, formatDate, showToast } from "../utils.js";
import { save } from "@tauri-apps/plugin-dialog";
import { ACTION_GROUPS, ACTIONS, ROUTINE_ACTIONS, actionGroup, actionLabel, describeLog, describeParts, roleLabel, userLabel } from "../audit-labels.js";

const PAGE_SIZE = 100;
const EXPORT_LIMIT = 50000;
const pad = n => String(n).padStart(2, "0");

// created_at is stored by SQLite datetime('now'), i.e. UTC; it is shown in the computer's time.
function logDate(value) {
  if (!value) return null;
  const date = new Date(`${String(value).replace(" ", "T")}Z`);
  return isNaN(date) ? null : date;
}

export function formatLogTime(value) {
  const date = logDate(value);
  if (!date) return value ?? "";
  return `${formatDate(`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** A local day ("2026-11-25") as the UTC bound the database compares with. */
function utcBound(day, nextDay = false) {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(y, m - 1, d + (nextDay ? 1 : 0));
  return date.toISOString().slice(0, 19).replace("T", " ");
}

export async function renderAudit(container) {
  const state = { search: "", user: "", action: "", result: "", from: "", to: "", routine: false, page: 0 };
  let lists = { users: [], actions: [] };
  let request = 0;

  const filter = (offset, limit) => {
    const needle = state.search.trim();
    const f = { offset, limit, search: needle || null, username: state.user || null, result: state.result || null };
    if (needle) {
      f.search_actions = Object.keys(ACTIONS).filter(code => ACTIONS[code].label.includes(needle));
    }
    if (state.action.startsWith("group:")) {
      const group = state.action.slice(6);
      f.actions = [...new Set([...Object.keys(ACTIONS), ...lists.actions])].filter(code => actionGroup(code) === group);
    } else if (state.action) {
      f.actions = [state.action];
    }
    if (!state.routine && !state.action) f.exclude_actions = ROUTINE_ACTIONS;
    if (state.from) f.from = utcBound(state.from);
    if (state.to) f.to = utcBound(state.to, true);
    return f;
  };

  const actionOptions = () => {
    const present = new Set(lists.actions);
    return ACTION_GROUPS.map(group => {
      const codes = [...present].filter(code => actionGroup(code) === group)
        .sort((a, b) => actionLabel(a).localeCompare(actionLabel(b), "ar"));
      if (!codes.length) return "";
      return `<optgroup label="${escHtml(group)}">
        <option value="group:${escHtml(group)}" ${state.action === `group:${group}` ? "selected" : ""}>${escHtml(group)}: الكل</option>
        ${codes.map(code => `<option value="${escHtml(code)}" ${state.action === code ? "selected" : ""}>${escHtml(actionLabel(code))}</option>`).join("")}
      </optgroup>`;
    }).join("");
  };

  const rowHtml = log => {
    const ok = log.result === "Success";
    const role = roleLabel(log.role);
    return `<tr class="table-row${ok ? "" : " audit-row-failed"}">
      <td class="table-cell text-xs whitespace-nowrap" dir="ltr" style="text-align:end">${escHtml(formatLogTime(log.created_at))}</td>
      <td class="table-cell">
        <span class="block" dir="auto" style="text-align:start">${escHtml(userLabel(log))}</span>
        ${role ? `<span class="block text-xs text-gray-500">${escHtml(role)}</span>` : ""}
      </td>
      <td class="table-cell">${escHtml(actionLabel(log))}</td>
      <td class="table-cell text-xs audit-details">${describeParts(log).map(part => `<bdi>${escHtml(part)}</bdi>`).join(" · ") || "—"}</td>
      <td class="table-cell text-center">
        <span class="badge ${ok ? "badge-green" : "badge-red"}" style="white-space:nowrap">${ok ? "✓ نجحت" : "✗ فشلت"}</span>
      </td>
    </tr>`;
  };

  const load = async () => {
    const mine = ++request;
    const body = container.querySelector("#audit-body");
    body.setAttribute("aria-busy", "true");
    let page;
    try {
      page = await api.searchActivityLog(filter(state.page * PAGE_SIZE, PAGE_SIZE));
    } catch (error) {
      if (mine === request) body.innerHTML = `<tr><td colspan="5" class="table-cell text-center text-red-500 py-8">${escHtml(errorText(error, "تعذر تحميل السجل"))}</td></tr>`;
      return;
    }
    if (mine !== request) return;
    body.removeAttribute("aria-busy");
    const listsChanged = page.users.join() !== lists.users.join() || page.actions.join() !== lists.actions.join();
    lists = { users: page.users, actions: page.actions };
    if (listsChanged) refreshLists();
    const pages = Math.max(1, Math.ceil(page.total / PAGE_SIZE));
    container.querySelector("#audit-count").textContent = `${page.total.toLocaleString("en")} عملية`;
    body.innerHTML = page.rows.map(rowHtml).join("")
      || `<tr><td colspan="5" class="table-cell text-center text-gray-500 py-8">${filtersOn() ? "لا توجد عمليات مطابقة" : "لا توجد عمليات"}</td></tr>`;
    container.querySelector("#audit-pages").classList.toggle("hidden", pages <= 1);
    container.querySelector("#audit-page-label").textContent = `الصفحة ${state.page + 1} من ${pages}`;
    container.querySelector("#audit-prev").disabled = state.page === 0;
    container.querySelector("#audit-next").disabled = state.page + 1 >= pages;
    container.querySelector("#audit-clear").classList.toggle("hidden", !filtersOn());
    container.querySelector("#audit-export").disabled = page.total === 0;
  };

  const filtersOn = () => Boolean(state.search || state.user || state.action || state.result || state.from || state.to);

  const refreshLists = () => {
    const users = container.querySelector("#audit-user");
    users.innerHTML = `<option value="">كل المستخدمين</option>${lists.users.map(name =>
      `<option value="${escHtml(name)}" ${state.user === name ? "selected" : ""}>${escHtml(name === "system" ? "البرنامج (تلقائي)" : name)}</option>`).join("")}`;
    container.querySelector("#audit-action").innerHTML = `<option value="">كل الإجراءات</option>${actionOptions()}`;
  };

  container.innerHTML = `<div class="space-y-4">
    <div class="card space-y-3">
      <div class="flex items-center justify-between gap-3 flex-wrap">
        <p class="text-sm text-gray-400">كل العمليات المهمة في البرنامج: من قام بها، ومتى، وعلى ماذا. لا يمكن تعديل السجل ولا حذف شيء منه.</p>
        <div class="flex items-center gap-2">
          <button type="button" id="audit-clear" class="btn-secondary text-xs px-3 py-1 hidden">مسح الفلاتر</button>
          <span id="audit-count" class="badge badge-gray"></span>
          <button type="button" id="audit-export" class="btn-secondary text-xs px-3 py-1">تصدير إلى Excel</button>
        </div>
      </div>
      <div class="grid grid-cols-1 md:grid-cols-[1.6fr_1.1fr_1.6fr_1fr_1fr_1fr] gap-3">
        <input id="audit-search" class="input-field" placeholder="بحث: اسم موظف، وثيقة، مستخدم…" aria-label="بحث في السجل" />
        <select id="audit-user" class="input-field" aria-label="المستخدم"></select>
        <select id="audit-action" class="input-field" aria-label="نوع الإجراء"></select>
        <select id="audit-result" class="input-field" aria-label="النتيجة">
          <option value="">كل النتائج</option>
          <option value="Failure">الفاشلة فقط</option>
          <option value="Success">الناجحة فقط</option>
        </select>
        <input id="audit-from" type="date" class="input-field" title="من تاريخ" aria-label="من تاريخ" />
        <input id="audit-to" type="date" class="input-field" title="إلى تاريخ" aria-label="إلى تاريخ" />
      </div>
      <label class="flex items-center gap-2 text-xs text-gray-500 cursor-pointer w-fit">
        <input type="checkbox" id="audit-routine" />
        إظهار الدخول والخروج والمعاينة الناجحة
      </label>
    </div>
    <div class="card overflow-auto max-w-full">
      <table class="w-full audit-table">
        <thead><tr>
          <th class="table-header" style="width:140px">الوقت</th>
          <th class="table-header" style="width:150px">المستخدم</th>
          <th class="table-header" style="width:190px">الإجراء</th>
          <th class="table-header">التفاصيل</th>
          <th class="table-header" style="width:90px;text-align:center">النتيجة</th>
        </tr></thead>
        <tbody id="audit-body"></tbody>
      </table>
      <div id="audit-pages" class="flex items-center justify-center gap-3 pt-4 hidden">
        <button id="audit-prev" type="button" class="btn-secondary text-sm px-3 py-1">السابق</button>
        <span id="audit-page-label" class="text-xs text-gray-500"></span>
        <button id="audit-next" type="button" class="btn-secondary text-sm px-3 py-1">التالي</button>
      </div>
    </div>
  </div>`;
  refreshLists();

  const changed = () => { state.page = 0; load(); };
  const bind = (id, key, event = "change") => container.querySelector(id).addEventListener(event, e => {
    state[key] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    changed();
  });
  const searchLater = debounce(changed, 300);
  container.querySelector("#audit-search").addEventListener("input", e => { state.search = e.target.value; searchLater(); });
  bind("#audit-user", "user");
  bind("#audit-action", "action");
  bind("#audit-result", "result");
  bind("#audit-from", "from");
  bind("#audit-to", "to");
  bind("#audit-routine", "routine");
  container.querySelector("#audit-clear").addEventListener("click", () => {
    Object.assign(state, { search: "", user: "", action: "", result: "", from: "", to: "", page: 0 });
    ["#audit-search", "#audit-from", "#audit-to", "#audit-result"].forEach(id => { container.querySelector(id).value = ""; });
    refreshLists();
    load();
  });
  container.querySelector("#audit-prev").addEventListener("click", () => { state.page = Math.max(0, state.page - 1); load(); });
  container.querySelector("#audit-next").addEventListener("click", () => { state.page += 1; load(); });
  container.querySelector("#audit-export").addEventListener("click", () => exportLog(filter(0, EXPORT_LIMIT)));
  await load();
}

async function exportLog(query) {
  try {
    const destination = await save({
      title: "حفظ سجل النظام Excel",
      defaultPath: `system-log-${new Date().toISOString().slice(0, 10)}.xlsx`,
      filters: [{ name: "Excel Workbook", extensions: ["xlsx"] }],
    });
    if (!destination) return;
    const page = await api.searchActivityLog(query);
    const headers = ["الوقت", "المستخدم", "الدور", "الإجراء", "التفاصيل", "النتيجة"];
    const rows = page.rows.map(log => [
      formatLogTime(log.created_at), userLabel(log), roleLabel(log.role), actionLabel(log), describeLog(log),
      log.result === "Success" ? "نجحت" : "فشلت",
    ]);
    await api.exportActivityLog(destination, headers, rows);
    const capped = page.total > rows.length ? ` (أحدث ${rows.length.toLocaleString("en")} من ${page.total.toLocaleString("en")})` : "";
    showToast(`تم تصدير ${rows.length.toLocaleString("en")} عملية${capped}`);
  } catch (error) {
    showToast(errorText(error, "تعذر تصدير السجل"), "error");
  }
}
