/**
 * screens/employees.js — Full Iraqi HR form with tabbed slide panel
 */
import { api } from "../api.js";
import { bindAttachmentScannerButtons } from "../attachments/integration.js";
import { zoomToolbarHtml, mountZoomViewer } from "../attachments/zoom-viewer.js";
import { convertFileSrc } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { showToast, formatDate, escHtml, debounce, confirmAction, confirmSaveChanges, AIRPORT_ZONES, errorText } from "../utils.js";
import { addressHtml, wireAddress, readAddress, composeResidence, citySuggestions, loadAddressPlaces, addressIsEmpty } from "../address-field.js";
import { can } from "../permissions.js";
import { openNameReview } from "./name-review.js";
import { employeeNameFields, recordNameFields, bindNameFields, readNameFields, readNameGroup, applyNames, joinNameParts } from "./name-fields.js";
import { readDocumentFields } from "./id-reader.js";
import { openAddEmployee } from "./add-wizard.js";
import { alertWindowDays, loadAlertRules, documentStatus, buildDocumentAlerts } from "./document-alerts.js";

let _employees = [];
let _filter = "";
let _statusFilter = "all";
// Large lists render in steps so the screen stays responsive with thousands of employees.
const TABLE_STEP = 300;
let _visibleRows = TABLE_STEP;
let _activeTab = "basic";
let _panelDraft = null;
let _panelDirty = false;
// Save keeps the panel open; these make one save close it, or continue with an upload.
let _closeAfterSave = false;
let _afterSave = null;
let _currentUser = null;
let _companyConfig = null;
// The job grade and step picklists, edited in «الإعدادات ← الدرجات والمراحل».
let _jobLists = { grades: [], steps: [] };
const DOCUMENT_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx"];

async function downloadEmployeeAttachment(path) {
  const fileName = (await api.getDocumentDownloadName(path)).replace(/^\d+_/, "");
  const extension = fileName.includes(".") ? fileName.split(".").pop() : "";
  const destination = await save({
    title: "حفظ الملف باسم",
    defaultPath: fileName,
    ...(extension ? { filters: [{ name: "الملف", extensions: [extension] }] } : {}),
  });
  if (!destination) return;
  try {
    const savedPath = await api.downloadDocument(path, destination);
    showToast(`تم تحميل الملف إلى ${savedPath}`);
  } catch (error) {
    showToast(error?.message ?? "تعذر تحميل الملف", "error");
  }
}

function bindAttachmentDownloadButtons(container) {
  bindAttachmentScannerButtons(container, _currentUser, async path => {
    if (!_panelDraft?.id) return;
    if (_activeTab === "family") {
      if (path.includes("/Spouses/")) await refreshSpouseAttachments(_panelDraft.id);
      else await refreshFamilyAttachments(_panelDraft.id);
    } else if (_activeTab === "vehicle") await refreshVehicleAttachments(_panelDraft.id);
    else await refreshDocumentAttachments(_panelDraft.id);
  }, () => {
    if (_panelDirty) throw new Error("احفظ التعديلات الحالية قبل إعادة معالجة المرفق");
  });
  container.querySelectorAll(".emp-tile-thumb > .smart-scanner-actions").forEach(group => {
    group.closest(".emp-tile")?.querySelector(".emp-tile-menu")?.append(group);
  });
  container.querySelectorAll(".btn-download-attachment").forEach(button => {
    button.addEventListener("click", () => downloadEmployeeAttachment(button.dataset.path));
  });
}

export async function renderEmployees(container, user, ctx) {
  _currentUser = user;
  window.autohrCanLeaveCurrentScreen = confirmLeavePanel;
  const [employees, companyConfig] = await Promise.all([
    api.listEmployees(),
    api.getCompanyConfig().catch(() => null),
    api.getJobLists().then(lists => { _jobLists = lists; }).catch(() => {}),
    // The «قارب على النفاذ» status of each document follows the reminder days in the settings.
    loadAlertRules(),
  ]);
  _employees = employees;
  _companyConfig = companyConfig;
  _filter = "";
  _statusFilter = "all";

  container.innerHTML = `
    <div id="emp-screen" class="flex flex-col gap-4 h-full">
      <div class="flex items-center gap-3 flex-wrap">
        <input id="emp-search" type="text" class="input-field flex-1 min-w-[200px]"
               placeholder="بحث بالاسم أو الرقم الوظيفي أو القسم أو رقم الهوية أو الهاتف أو العنوان الوظيفي…" aria-label="بحث في الموظفين" />
        <select id="emp-status-filter" class="input-field" style="width:auto;min-width:150px" aria-label="حالة الموظف">
          <option value="all">كل الموظفين</option>
          <option value="active">النشطون فقط</option>
          <option value="inactive">غير النشطين فقط</option>
        </select>
        <span id="emp-count" class="badge badge-gray"></span>
        <button id="btn-name-review" class="btn-review-names whitespace-nowrap" hidden title="أسماء قُسّمت تلقائيًا وتحتاج تأكيدًا">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3 2.5 20h19z"/><path d="M12 10v4.5M12 17.5v.01"/></svg>
          <span>مراجعة الأسماء</span><span class="btn-review-count" dir="ltr"></span>
        </button>
        <button id="btn-add-emp" class="btn-primary px-4 py-2.5 whitespace-nowrap">+ إضافة موظف</button>
      </div>
      <div id="emp-table-wrap" class="card overflow-auto flex-1"></div>
    </div>
    <div id="emp-overlay" style="display:none;position:fixed;inset:0;z-index:40;background:rgba(0,0,0,0.38)"></div>
    <div id="emp-panel" style="position:fixed;top:0;bottom:0;right:0;width:min(100vw,max(580px,40vw));container-type:inline-size;z-index:50;
      background:var(--ui-surface);border-left:1px solid var(--ui-line);box-shadow:-8px 0 32px rgba(0,0,0,0.5);
      display:flex;flex-direction:column;transform:translateX(calc(100% + 40px));transition:transform 0.3s ease"></div>`;

  renderTable();
  container.querySelector("#emp-search").addEventListener("input",
    debounce(e => { _filter = e.target.value.trim().toLowerCase(); renderTable(); }, 250));
  container.querySelector("#emp-status-filter").addEventListener("change", e => {
    _statusFilter = e.target.value;
    renderTable();
  });
  container.querySelector("#btn-add-emp").addEventListener("click", () => openAddEmployee({
    user,
    employees: _employees,
    onManual: () => openPanel(null),
    onCreated: async created => {
      _employees = await api.listEmployees();
      renderTable();
      openPanel(_employees.find(e => e.id === created.id) ?? created);
    },
  }));
  container.querySelector("#emp-overlay").addEventListener("click", () => closePanel());
  if (!can(user, "employees.create")) container.querySelector("#btn-add-emp")?.remove();
  if (can(user, "employees.edit")) {
    const reviewButton = container.querySelector("#btn-name-review");
    const refreshReviewCount = async () => {
      const count = (await api.listNameReview().catch(() => [])).length;
      reviewButton.hidden = count === 0;
      reviewButton.querySelector(".btn-review-count").textContent = String(count);
      reviewButton.setAttribute("aria-label", `مراجعة الأسماء (${count})`);
    };
    reviewButton.addEventListener("click", () => openNameReview(async () => {
      _employees = await api.listEmployees();
      renderTable();
      await refreshReviewCount();
    }));
    refreshReviewCount();
  } else container.querySelector("#btn-name-review")?.remove();

  // Opened from another screen (e.g. a document alert): jump straight to that employee's tab.
  if (ctx?.openEmployeeId != null) {
    const target = _employees.find(e => Number(e.id) === Number(ctx.openEmployeeId));
    if (target) {
      openPanel(target, ctx.openEmployeeTab ?? "basic");
    }
  }
}

function filtered() {
  const byStatus = _statusFilter === "all"
    ? _employees
    : _employees.filter(e => (_statusFilter === "active") === Boolean(e.is_active));
  if (!_filter) return byStatus;
  return byStatus.filter(e =>
    e.full_name?.toLowerCase().includes(_filter) ||
    String(e.employee_number ?? "").toLowerCase().includes(_filter) ||
    fixedDepartment(e).toLowerCase().includes(_filter) ||
    e.civil_id?.includes(_filter) ||
    e.phone?.includes(_filter) ||
    e.job_title?.toLowerCase().includes(_filter)
  );
}

/** The list's «المستمسكات» column: what has expired or is close to expiry, by the reminder settings. */
function documentsCell(employee, alertsById) {
  if (!employee.is_active) return `<span class="emp-doc-cell is-none">—</span>`;
  const alerts = alertsById.get(employee.id) ?? [];
  const expired = alerts.filter(a => a.expired).length;
  const soon = alerts.length - expired;
  if (!alerts.length) return `<span class="emp-doc-cell is-ok"><span class="emp-dot ok" aria-hidden="true"></span>سليمة</span>`;
  const label = (count, text) => count > 1 ? `${count} ${text}` : text;
  const parts = [
    expired && `<span class="emp-doc-tag bad">${label(expired, "منتهي")}</span>`,
    soon && `<span class="emp-doc-tag warn">${label(soon, "ينتهي قريبًا")}</span>`,
  ].filter(Boolean).join(`<span class="emp-doc-sep" aria-hidden="true">·</span>`);
  const names = alerts.map(a => `${a.documentName}: ${a.expired ? "منتهي في" : "ينتهي في"} ${formatDate(a.expiryDate)}`).join("\n");
  return `<span class="emp-doc-cell" title="${escHtml(names)}"><span class="emp-dot ${expired ? "bad" : "warn"}" aria-hidden="true"></span>${parts}</span>`;
}

function renderTable({ keepVisibleRows = false } = {}) {
  const wrap = document.getElementById("emp-table-wrap");
  if (!wrap) return;
  if (!keepVisibleRows) _visibleRows = TABLE_STEP;
  const matching = filtered();
  const rows = matching.slice(0, _visibleRows);
  const alertsById = new Map();
  buildDocumentAlerts(rows).forEach(alert => alertsById.set(alert.employeeId, [...(alertsById.get(alert.employeeId) ?? []), alert]));
  const hiddenCount = matching.length - rows.length;
  const countEl = document.getElementById("emp-count");
  if (countEl) countEl.textContent = `${matching.length} / ${_employees.length}`;
  const canCreate = can(_currentUser, "employees.create");
  const emptyMessage = _employees.length === 0
    ? (canCreate ? "لا يوجد موظفون بعد. اضغط «+ إضافة موظف» لإضافة أول موظف." : "لا يوجد موظفون بعد.")
    : "لا توجد نتائج مطابقة للبحث أو الفلتر";
  wrap.innerHTML = `
    <table class="w-full">
      <thead><tr>
        <th class="table-header">الرقم الوظيفي</th>
        <th class="table-header">الاسم الرباعي</th>
        <th class="table-header">العنوان الوظيفي</th>
        <th class="table-header emp-doc-col">المستمسكات</th>
        <th class="table-header">الهاتف</th>
        <th class="table-header">الحالة</th>
      </tr></thead>
      <tbody>
        ${rows.length === 0
          ? `<tr><td colspan="6" class="table-cell text-center text-gray-500 py-10">${emptyMessage}</td></tr>`
          : rows.map(e => `
            <tr class="table-row" data-id="${e.id}" style="cursor:pointer">
              <td class="table-cell" dir="ltr" style="text-align:right">${escHtml(e.employee_number || "—")}</td>
              <td class="table-cell font-medium text-gray-100">${escHtml(e.full_name)}${missingBadge(missingFields(e), "is-inline")}</td>
              <td class="table-cell">${escHtml(e.job_title ?? "—")}</td>
              <td class="table-cell">${documentsCell(e, alertsById)}</td>
              <td class="table-cell" dir="ltr">${escHtml(e.phone ?? "—")}</td>
              <td class="table-cell">
                <span class="badge ${e.is_active ? "badge-green" : "badge-gray"}">
                  ${e.is_active ? "نشط" : "غير نشط"}
                </span>
              </td>
            </tr>`).join("")}
      </tbody>
    </table>
    ${hiddenCount > 0 ? `<div class="text-center py-3">
      <button type="button" id="emp-show-more" class="btn-secondary text-sm px-4 py-1.5">عرض المزيد (${hiddenCount} متبقٍ)</button>
    </div>` : ""}`;
  // One delegated listener instead of one per row.
  wrap.querySelector("tbody")?.addEventListener("click", event => {
    const row = event.target.closest("tr[data-id]");
    if (!row) return;
    const emp = _employees.find(e => e.id == row.dataset.id);
    if (emp) openPanel(emp);
  });
  wrap.querySelector("#emp-show-more")?.addEventListener("click", () => {
    _visibleRows += TABLE_STEP;
    renderTable({ keepVisibleRows: true });
  });
  if (_panelDraft?.id != null) wrap.querySelector(`tr[data-id="${_panelDraft.id}"]`)?.classList.add("is-selected");
}

function openPanel(emp, tab = "basic", sectionState = new Map()) {
  _activeTab = TABS.some(t => t.id === tab) ? tab : "basic";
  _panelDraft = emp ? { ...emp } : { is_active: 1, spouses: "[]", family_members: "[]", vehicles: "[]" };
  const draftNow = _panelDraft;
  // One birth date and place: older records may hold them only in the national card's copy.
  _panelDraft.birthdate ||= _panelDraft.civil_id_birthdate ?? null;
  _panelDraft.birthplace ||= _panelDraft.civil_id_birthplace ?? null;
  _panelDirty = false;
  _sectionState = sectionState;
  // Places users added: the residence lists show them once they arrive.
  loadAddressPlaces().then(() => {
    const box = document.querySelector("#emp-panel [data-address]");
    if (_panelDraft !== draftNow || !box) return;
    const fresh = document.createElement("div");
    fresh.innerHTML = addressHtml(box.dataset.address, panelAddress(), { cities: citySuggestions(_employees) });
    box.replaceWith(fresh.firstElementChild);
  });
  document.getElementById("emp-panel").style.transform = "translateX(0)";
  document.getElementById("emp-overlay").style.display = "block";
  markSelectedRow(emp?.id ?? null);
  reserveSpaceForPanel();
  renderPanel(emp);
}

// The browser reads "translateX(0)" back as "translateX(0px)".
function isPanelOpen(panel = document.getElementById("emp-panel")) {
  return Boolean(panel) && /^translateX\(0(px)?\)$/.test(panel.style.transform);
}

/** Highlights the employee whose panel is open, so the name stays readable next to it. */
function markSelectedRow(id) {
  document.querySelectorAll("#emp-table-wrap tr.is-selected").forEach(row => row.classList.remove("is-selected"));
  if (id == null) return;
  const row = document.querySelector(`#emp-table-wrap tr[data-id="${id}"]`);
  row?.classList.add("is-selected");
  row?.scrollIntoView({ block: "nearest" });
}

/**
 * The side panel covers the right edge of the window, where the name column sits (RTL).
 * Narrow the list while the panel is open so the names stay visible beside it.
 */
function reserveSpaceForPanel() {
  const screen = document.getElementById("emp-screen");
  const panel = document.getElementById("emp-panel");
  if (!screen || !panel) return;
  screen.style.marginRight = "";
  if (!isPanelOpen(panel)) return;
  // Measure where the panel ends up, not where it is mid-slide: it is pinned to the right edge.
  const panelLeft = window.innerWidth - panel.getBoundingClientRect().width;
  const rect = screen.getBoundingClientRect();
  // Under «حجم الواجهة» the shell is zoomed: convert screen pixels back to CSS pixels.
  const toCss = rect.width ? screen.offsetWidth / rect.width : 1;
  const overlap = (rect.right - panelLeft) * toCss + 16;
  if (overlap > 16 && screen.offsetWidth - overlap >= 320) screen.style.marginRight = `${overlap}px`;
}
window.addEventListener("resize", debounce(reserveSpaceForPanel, 150));

async function confirmLeavePanel() {
  const panel = document.getElementById("emp-panel");
  const isOpen = isPanelOpen(panel);
  if (!isOpen || !_panelDirty) return true;
  return await confirmAction("توجد تغييرات غير محفوظة. هل تريد الخروج بدون حفظ؟");
}

async function closePanel(force = false) {
  if (!force && _panelDirty) {
    const choice = await confirmSaveChanges();
    if (choice === "cancel") return;
    if (choice === "save") {
      _closeAfterSave = true;
      document.getElementById("panel-save")?.click();
      return;
    }
  }
  document.getElementById("emp-panel").style.transform = "translateX(calc(100% + 40px))";
  document.getElementById("emp-overlay").style.display = "none";
  const screen = document.getElementById("emp-screen");
  if (screen) screen.style.marginRight = "";
  markSelectedRow(null);
  _panelDraft = null;
  _panelDirty = false;
}

/** The preview paths of a row's two attachments (not saved; the form needs them to show the images). */
function rowFullPaths(row, prefix) {
  const camel = prefix.replace(/_(\w)/g, (_, c) => c.toUpperCase());
  return {
    [`${prefix}_front_full_path`]: row.dataset[`${camel}FrontFullPath`] || null,
    [`${prefix}_back_full_path`]: row.dataset[`${camel}BackFullPath`] || null,
  };
}

/** data-… attributes holding a row's attachment paths, read back by collectVisiblePanelFields. */
function rowPathAttrs(record, prefix) {
  const attr = prefix.replace(/_/g, "-");
  return ["front", "back"].map(side =>
    `data-${attr}-${side}-path="${escHtml(record?.[`${prefix}_${side}_path`] ?? "")}" data-${attr}-${side}-full-path="${escHtml(record?.[`${prefix}_${side}_full_path`] ?? "")}"`).join(" ");
}

function markPanelDirty() {
  _panelDirty = true;
  document.getElementById("panel-dirty")?.removeAttribute("hidden");
}

function collectVisiblePanelFields(panel) {
  if (!_panelDraft || !panel) return;
  panel.querySelectorAll("[id^='f-']").forEach(el => {
    const key = el.id.slice(2);
    if (el.type === "checkbox") _panelDraft[key] = el.checked ? 1 : 0;
    else _panelDraft[key] = el.value?.trim() || null;
  });
  applyNames(_panelDraft, readNameFields(panel, ".spouse-row,.family-row"));

  const familyList = panel.querySelector("#family-list");
  const rows = panel.querySelectorAll(".family-row");
  if (familyList) {
    const arr = [];
    rows.forEach(row => {
      arr.push(applyNames({
        name:        "",
        relation:    row.querySelector(".fm-relation")?.value || "",
        gender:      row.querySelector(".fm-gender")?.value || "",
        birthplace:  row.querySelector(".fm-birthplace")?.value?.trim() || "",
        birthdate:   row.querySelector(".fm-birthdate")?.value || "",
        civil_id:    row.querySelector(".fm-civil")?.value?.trim() || "",
        issue_date:  row.querySelector(".fm-issue")?.value || "",
        expiry_date: row.querySelector(".fm-expiry")?.value || "",
        issuer:      row.querySelector(".fm-issuer")?.value?.trim() || "",
        blood_type:  row.querySelector(".fm-blood")?.value || "",
        national_card_front_path: row.dataset.nationalCardFrontPath || "",
        national_card_back_path:  row.dataset.nationalCardBackPath || "",
        ...rowFullPaths(row, "national_card"),
      }, readNameFields(row)));
    });
    _panelDraft.family_members = JSON.stringify(arr);
  }

  const spouseList = panel.querySelector("#spouse-list");
  if (spouseList) {
    const spouseConfig = spouseSectionConfig(_panelDraft ?? {});
    const spouses = [];
    panel.querySelectorAll(".spouse-row").forEach(row => {
      spouses.push(applyNames({
        civil_id:    row.querySelector(".sp-civil")?.value?.trim() || "",
        name:        "",
        mother_name: "",
        gender:      row.querySelector(".sp-gender")?.value || "",
        birthplace:  row.querySelector(".sp-birthplace")?.value?.trim() || "",
        birthdate:   row.querySelector(".sp-birthdate")?.value || "",
        issue_date:  row.querySelector(".sp-issue")?.value || "",
        expiry_date: row.querySelector(".sp-expiry")?.value || "",
        issuer:      row.querySelector(".sp-issuer")?.value?.trim() || "",
        blood_type:  row.querySelector(".sp-blood")?.value || "",
        marriage_date: row.querySelector(".sp-marriage")?.value || "",
        national_card_front_path: row.dataset.nationalCardFrontPath || "",
        national_card_back_path:  row.dataset.nationalCardBackPath || "",
        ...rowFullPaths(row, "national_card"),
      }, readNameFields(row)));
    });
    // All rows are kept, even more than the section allows now (the gender was changed):
    // saving is refused until the extra ones are removed by hand, never dropped silently.
    _panelDraft.spouses = JSON.stringify(spouses);
    const firstSpouse = spouses[0] ?? {};
    _panelDraft.spouse_name = firstSpouse.name || null;
    _panelDraft.spouse_mother_name = firstSpouse.mother_name || null;
    _panelDraft.spouse_birthdate = firstSpouse.birthdate || null;
    _panelDraft.marriage_date = firstSpouse.marriage_date || null;
  }

  const vehicleList = panel.querySelector("#vehicle-list");
  if (vehicleList) {
    const vehicleRows = vehicleList.querySelectorAll(".vehicle-row");
    const vehicles = [];
    vehicleRows.forEach(row => {
      vehicles.push({
        plate:       row.querySelector(".vehicle-plate")?.value?.trim() || "",
        brand:       row.querySelector(".vehicle-brand")?.value?.trim() || "",
        type:        row.querySelector(".vehicle-type")?.value?.trim() || "",
        color:       row.querySelector(".vehicle-color")?.value?.trim() || "",
        annual_no:   row.querySelector(".vehicle-annual-no")?.value?.trim() || "",
        issue_date:  row.querySelector(".vehicle-issue-date")?.value || "",
        expiry_date: row.querySelector(".vehicle-expiry-date")?.value || "",
        governorate:    row.querySelector(".vehicle-governorate")?.value?.trim() || "",
        plate_category: row.querySelector(".vehicle-plate-category")?.value?.trim() || "",
        chassis_no:     row.querySelector(".vehicle-chassis")?.value?.trim() || "",
        model_year:     row.querySelector(".vehicle-model-year")?.value?.trim() || "",
        annual_front_path: row.dataset.annualFrontPath || "",
        annual_back_path:  row.dataset.annualBackPath || "",
        ...rowFullPaths(row, "annual"),
      });
    });
    _panelDraft.vehicles = JSON.stringify(vehicles);
  }
}

// ── Field helper ────────────────────────────────────────────────────────────
const f = (id, emp) => escHtml(emp?.[id] ?? "");

function field(label, id, emp, opts = {}) {
  const val = f(id, emp);
  if (opts.type === "select") {
    return `<div>
      <p style="font-size:11px;color:var(--ui-text-faint);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">${label}</p>
      <select id="f-${id}" class="input-field">
        ${opts.options.map(([v,l]) => `<option value="${v}" ${emp?.[id]===v?"selected":""}>${l}</option>`).join("")}
      </select></div>`;
  }
  if (opts.type === "textarea") {
    return `<div style="${opts.span ? 'grid-column:span 2' : ''}">
      <p style="font-size:11px;color:var(--ui-text-faint);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">${label}</p>
      <textarea id="f-${id}" class="input-field${opts.grow ? " emp-grow" : ""}" rows="1" style="${opts.grow ? "" : "height:70px;"}resize:none">${val}</textarea></div>`;
  }
  return `<div style="${opts.span ? 'grid-column:span 2' : ''}">
    <p style="font-size:11px;color:var(--ui-text-faint);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">${label}</p>
    <input id="f-${id}" class="input-field" type="${opts.date ? 'date' : 'text'}"
           dir="${opts.ltr ? 'ltr' : 'rtl'}" value="${opts.date ? (emp?.[id] ?? '') : val}" /></div>`;
}

const JOB_LIST_FIELDS = {
  job_grade: { key: "grades", title: "قائمة الدرجات الوظيفية", noun: "درجة" },
  job_step:  { key: "steps",  title: "قائمة المراحل", noun: "مرحلة" },
};

function jobListOptions(id, current) {
  const items = _jobLists[JOB_LIST_FIELDS[id].key] ?? [];
  const values = current && !items.includes(current) ? [current, ...items] : items;
  return `<option value="" ${current ? "" : "selected"}>—</option>
    ${values.map(value => `<option value="${escHtml(value)}" ${value === current ? "selected" : ""}>${escHtml(value)}${items.includes(value) ? "" : " (ليست في القائمة)"}</option>`).join("")}`;
}

/**
 * The job grade / step picklist. A value saved before (or since removed from the list) stays
 * selectable. Whoever may change settings manages the list right here («تعديل القائمة»).
 */
function listField(label, id, emp) {
  const current = emp?.[id] ?? "";
  const manage = can(_currentUser, "settings.manage")
    ? `<button type="button" class="job-list-manage" data-job-field="${id}" title="إضافة قيم إلى القائمة أو حذفها"
        style="border:none;background:transparent;color:var(--ui-accent);font-size:11px;cursor:pointer;padding:0">تعديل القائمة</button>` : "";
  return `<div>
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:4px">
      <p style="font-size:11px;color:var(--ui-text-faint);text-transform:uppercase;letter-spacing:.05em;margin:0">${label}</p>${manage}
    </div>
    <select id="f-${id}" class="input-field">${jobListOptions(id, current)}</select></div>`;
}

/** Small dialog: the list's values, each with «حذف», a field to add one, then «حفظ» / «إلغاء». */
async function manageJobList(id) {
  const meta = JOB_LIST_FIELDS[id];
  let items = [...(_jobLists[meta.key] ?? [])];
  const overlay = document.createElement("div");
  overlay.setAttribute("dir", "rtl");
  overlay.style.cssText = "position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:20px";
  overlay.innerHTML = `<div class="card app-dialog" role="dialog" aria-modal="true" style="width:min(420px,100%);padding:18px 20px;color:var(--ui-text-strong)">
    <p style="font-size:16px;font-weight:700;margin:0 0 4px">${meta.title}</p>
    <p style="font-size:12px;color:var(--ui-text-muted);margin:0 0 12px">ما تحذفه يختفي من القائمة فقط؛ الموظفون المحفوظة لهم هذه القيمة يبقون عليها.</p>
    <div data-role="items" style="max-height:min(340px,50vh);overflow:auto;border:1px solid var(--ui-line);border-radius:8px"></div>
    <div style="display:flex;gap:8px;margin-top:10px">
      <input data-role="new" class="input-field flex-1" maxlength="60" placeholder="${meta.noun} جديدة" aria-label="${meta.noun} جديدة" />
      <button type="button" data-act="add" class="btn-secondary whitespace-nowrap">+ إضافة</button>
    </div>
    <div style="display:flex;gap:10px;margin-top:14px">
      <button type="button" data-act="save" class="btn-primary">حفظ</button>
      <button type="button" data-act="cancel" class="btn-secondary">إلغاء</button>
    </div></div>`;
  const list = overlay.querySelector('[data-role="items"]');
  const input = overlay.querySelector('[data-role="new"]');
  const draw = () => {
    list.innerHTML = items.length ? items.map((item, index) => `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 12px;${index ? "border-top:1px solid var(--ui-line);" : ""}">
        <span style="font-size:14px">${escHtml(item)}</span>
        <button type="button" data-remove="${index}" class="btn-danger-outline" style="padding:2px 10px;font-size:12px" aria-label="حذف ${escHtml(item)}">حذف</button>
      </div>`).join("")
      : `<p style="font-size:13px;color:var(--ui-text-muted);padding:12px;margin:0">القائمة فارغة. أضف قيمة واحدة على الأقل.</p>`;
  };
  const add = () => {
    const value = input.value.trim();
    if (!value) return;
    if (items.includes(value)) { showToast(`«${value}» موجودة في القائمة`, "error"); return; }
    items.push(value);
    input.value = "";
    draw();
    list.scrollTop = list.scrollHeight;
    input.focus();
  };
  return new Promise(resolve => {
    const finish = saved => { document.removeEventListener("keydown", onKey); overlay.remove(); resolve(saved); };
    const onKey = event => { if (event.key === "Escape") finish(false); };
    list.addEventListener("click", event => {
      const button = event.target.closest("[data-remove]");
      if (button) { items.splice(Number(button.dataset.remove), 1); draw(); }
    });
    input.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); add(); } });
    overlay.querySelector('[data-act="add"]').addEventListener("click", add);
    overlay.querySelector('[data-act="cancel"]').addEventListener("click", () => finish(false));
    overlay.querySelector('[data-act="save"]').addEventListener("click", async () => {
      if (input.value.trim()) add();
      try {
        _jobLists = await api.setJobLists({ ..._jobLists, [meta.key]: items });
        showToast("تم حفظ القائمة");
        finish(true);
      } catch (err) { showToast(errorText(err), "error"); }
    });
    document.addEventListener("keydown", onKey);
    draw();
    document.body.append(overlay);
    input.focus();
  });
}

// One listener for every employee panel: «تعديل القائمة» next to the grade and step fields.
document.addEventListener("click", async event => {
  const button = event.target.closest(".job-list-manage");
  if (!button) return;
  const id = button.dataset.jobField;
  if (!(await manageJobList(id))) return;
  const select = document.getElementById(`f-${id}`);
  if (select) select.innerHTML = jobListOptions(id, select.value);
});

/** The residence address: المحافظة / القضاء / الناحية / المدينة, then م / ز / د or one free line.
 *  Kept as parts (`residence_address_parts`) and as the composed line (`residence_address`). */
const panelAddress = () => readAddress(_panelDraft?.residence_address_parts, _panelDraft?.residence_address);
function addressField(label, id) {
  const parts = panelAddress();
  const legacy = !_panelDraft?.residence_address_parts && parts.useOther && parts.other;
  const cap = "font-size:11px;color:var(--ui-text-faint);margin-bottom:4px";
  return `<div style="grid-column:span 2">
    <p style="${cap};text-transform:uppercase;letter-spacing:.05em">${label}</p>
    ${addressHtml(id, parts, { cities: citySuggestions(_employees) })}
    ${legacy ? `<p class="emp-address-note">⚠ العنوان محفوظ بصيغة قديمة، فوُضع في «تنسيق عنوان آخر»: اختر المحافظة والقضاء ووزّعه على م وز ود إن أمكن.</p>` : ""}</div>`;
}

/** Keeps what the address field holds in the panel's draft. */
function wirePanelAddress(panel) {
  wireAddress(panel, {
    get: () => ({ parts: panelAddress(), cities: citySuggestions(_employees) }),
    set: (_key, parts) => {
      if (!_panelDraft) return;
      _panelDraft.residence_address_parts = addressIsEmpty(parts) ? null : JSON.stringify(parts);
      _panelDraft.residence_address = composeResidence(parts) || null;
      markPanelDirty();
    },
  });
}

/** Comma-separated codes ("S1,T,VIP") → unique upper-case codes. */
function zoneCodes(value) {
  return [...new Set(String(value ?? "").split(/[\s,،;|]+/).map(z => z.trim().toUpperCase()).filter(Boolean))];
}

function zoneChipsHtml(codes) {
  return codes.map(code => `<span class="emp-zone-chip" dir="ltr">${escHtml(code)}<button type="button" class="emp-zone-remove" data-zone="${escHtml(code)}" aria-label="حذف ${escHtml(code)}" title="حذف">×</button></span>`).join("");
}

/** Several short codes shown as chips; the hidden input carries them as "S1,T,VIP". */
function zonesField(label, id, emp) {
  const codes = zoneCodes(emp?.[id]);
  return `<div style="grid-column:span 2">
    <p style="font-size:11px;color:var(--ui-text-faint);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">${label}</p>
    <div class="emp-zones input-field">
      <input type="hidden" id="f-${id}" value="${escHtml(codes.join(","))}" />
      <span class="emp-zone-list">${zoneChipsHtml(codes)}</span>
      <input type="text" class="emp-zone-input" dir="ltr" maxlength="12" placeholder="أضف رمزاً" aria-label="${label}" />
    </div><div class="emp-zone-quick">${zoneQuickHtml(codes)}</div></div>`;
}

/** One-click buttons for the usual codes the badge does not have yet. */
function zoneQuickHtml(codes) {
  return AIRPORT_ZONES.filter(z => !codes.includes(z)).map(z => `<button type="button" class="emp-zone-add" data-zone="${z}" dir="ltr" title="إضافة ${z}">+ ${z}</button>`).join("");
}

function setZones(box, codes) {
  const hidden = box.querySelector("input[type=hidden]");
  hidden.value = codes.join(",");
  box.querySelector(".emp-zone-list").innerHTML = zoneChipsHtml(codes);
  const quick = box.parentElement.querySelector(".emp-zone-quick");
  if (quick) quick.innerHTML = zoneQuickHtml(codes);
  markPanelDirty();
}

function addZonesFromInput(input) {
  const box = input.closest(".emp-zones");
  const added = zoneCodes(input.value);
  input.value = "";
  if (!box || !added.length) return;
  setZones(box, zoneCodes([box.querySelector("input[type=hidden]").value, ...added].join(",")));
}

/** Every employee is in the department set in Settings; an older record's own value only without one. */
function fixedDepartment(emp) {
  return (_companyConfig?.department_name ?? "").trim() || emp?.department || "";
}

/** A value set once for the whole company (Settings): shown faded with a lock, not typed here. */
function fixedCompanyField(label, id, value) {
  return `<div>
    <p style="font-size:11px;color:var(--ui-text-faint);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px">${label}</p>
    <div class="emp-fixed" title="يُغيَّر من «الإعدادات ← الجهة والشعار»">
      <input id="f-${id}" class="input-field" type="text" value="${escHtml(value ?? "")}" readonly tabindex="-1" aria-readonly="true" />
      <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>
    </div>
  </div>`;
}

function sectionTitle(title) {
  return `<div style="grid-column:span 2;border-bottom:1px solid var(--ui-line);padding-bottom:6px;margin-top:8px">
    <p style="font-size:12px;font-weight:700;color:var(--ui-accent);text-transform:uppercase;letter-spacing:.08em">${title}</p>
  </div>`;
}

// ── Unified attachment tiles ────────────────────────────────────────────────
const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp"];

function attachmentTile({ label, path, fullPath, canManage, upload, remove, lockedNote = "احفظ سجل الموظف أولاً", read = null, saveFirst = null }) {
  const name = path?.split(/[/\\]/).pop();
  const extension = name?.split(".").pop()?.toLowerCase();
  const assetUrl = fullPath ? convertFileSrc(fullPath) : "";
  const isImage = Boolean(assetUrl) && IMAGE_EXTENSIONS.includes(extension);
  const viewKind = isImage ? "image" : assetUrl && extension === "pdf" ? "pdf" : "";
  const thumb = isImage
    ? `<img data-scan-path="${escHtml(path)}" src="${escHtml(assetUrl)}" alt="${escHtml(label)}" loading="lazy" />`
    : name ? `<span class="emp-tile-file">${escHtml((extension || "ملف").toUpperCase())}</span>`
    : `<span>لا يوجد ملف</span>`;
  const action = name
    ? `<button type="button" class="emp-tile-more" aria-haspopup="menu" aria-label="خيارات ${escHtml(label)}">⋯</button>`
    : canManage
      ? `<button type="button" class="emp-tile-upload ${upload.cls}" ${upload.attrs}>+ رفع</button>`
      : upload && saveFirst
        // Not saved yet: the button saves first, then continues with the upload.
        ? `<button type="button" class="emp-tile-upload btn-save-then-upload" data-then="${escHtml(saveFirst)}" title="يُحفظ الموظف ثم يُرفع الملف">+ رفع</button>`
        : `<span class="emp-tile-note">${lockedNote}</span>`;
  const menu = name ? `<div class="emp-tile-menu" role="menu">
      ${viewKind ? `<button type="button" role="menuitem" class="emp-menu-item emp-view-attachment" data-url="${escHtml(assetUrl)}" data-kind="${viewKind}" data-title="${escHtml(label)}">عرض</button>` : ""}
      ${read && isImage && can(_currentUser, "employees.edit") ? `<button type="button" role="menuitem" class="emp-menu-item emp-read-fields" data-path="${escHtml(path)}" data-url="${escHtml(assetUrl)}" data-target="${escHtml(read)}" data-title="${escHtml(label)}">قراءة البيانات</button>` : ""}
      ${canManage ? `<button type="button" role="menuitem" class="emp-menu-item ${upload.cls}" ${upload.attrs}>استبدال</button>` : ""}
      ${can(_currentUser, "documents.download") ? `<button type="button" role="menuitem" class="emp-menu-item btn-download-attachment" data-path="${escHtml(path)}">تحميل</button>` : ""}
      ${canManage ? `<button type="button" role="menuitem" class="emp-menu-item is-danger ${remove.cls}" ${remove.attrs}>حذف</button>` : ""}
    </div>` : "";
  return `<div class="emp-tile ${name ? "has-file" : "is-empty"}" title="${escHtml(name ?? "")}">
    <div class="emp-tile-thumb">${thumb}</div>
    <div class="emp-tile-cap"><span>${escHtml(label)}</span>${action}</div>
    ${menu}
  </div>`;
}

function sidedCardTile(label, side, path, fullPath, canUpload, cardType = "national") {
  const attrs = `data-card-type="${cardType}" data-side="${side}"`;
  return attachmentTile({
    label, path, fullPath, canManage: canUpload,
    read: cardType === "national" ? "employee" : cardType === "airport" ? "employee:airport_badge" : cardType === "ministry" ? "employee:ministry_badge" : cardType === "residence" ? "employee:residence_card" : null,
    upload: { cls: "btn-upload-sided-card", attrs },
    remove: { cls: "btn-delete-sided-card", attrs },
    saveFirst: `.btn-upload-sided-card[data-card-type="${cardType}"][data-side="${side}"]`,
  });
}

function firstJsonPath(value) {
  try { return JSON.parse(value ?? "[]")[0]; } catch { return undefined; }
}

function passportTile(emp) {
  const path = firstJsonPath(emp?.passport_attachment_paths);
  return attachmentTile({
    label: "نسخة الجواز", path, fullPath: emp?.passport_attachment_full_paths?.[0], canManage: Boolean(emp?.id), read: "employee",
    upload: { cls: "", attrs: `id="btn-upload-passport"` }, saveFirst: "#btn-upload-passport",
    remove: { cls: "btn-delete-passport", attrs: `data-path="${escHtml(path ?? "")}"` },
  });
}

function rationCardTile(emp) {
  const path = firstJsonPath(emp?.ration_card_attachment_paths);
  return attachmentTile({
    label: "نسخة البطاقة", path, fullPath: emp?.ration_card_attachment_full_paths?.[0], canManage: Boolean(emp?.id), read: "employee:ration_card",
    upload: { cls: "", attrs: `id="btn-upload-ration-card"` }, saveFirst: "#btn-upload-ration-card",
    remove: { cls: "btn-delete-ration-card", attrs: `data-path="${escHtml(path ?? "")}"` },
  });
}

function viewerItemFromButton(button) {
  const section = button.closest(".emp-sec")?.querySelector(".emp-sec-title")?.textContent?.trim();
  const row = button.closest(".spouse-row,.family-row")?.querySelector(".emp-row-title")?.textContent?.trim();
  const group = [section, row].filter(Boolean).join(" · ");
  const label = button.dataset.title ?? "";
  return { url: button.dataset.url, kind: button.dataset.kind, title: group ? `${group} · ${label}` : label };
}

/** Viewer for employee attachments: zoom, rotate, and next/previous through `items`. */
function openAttachmentViewer(items, startIndex = 0) {
  let index = Math.min(Math.max(0, startIndex), items.length - 1);
  let zoomer = null;
  const overlay = document.createElement("div");
  overlay.className = "emp-viewer";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.innerHTML = `<div class="emp-viewer-box">
    <div class="emp-viewer-head">
      <span class="emp-viewer-title"></span>
      <span class="emp-viewer-tools"></span>
      ${items.length > 1 ? `<span class="emp-viewer-nav">
        <button type="button" class="zv-btn emp-viewer-prev" title="المرفق السابق (→)" aria-label="المرفق السابق">‹</button>
        <span class="emp-viewer-count" dir="ltr"></span>
        <button type="button" class="zv-btn emp-viewer-next" title="المرفق التالي (←)" aria-label="المرفق التالي">›</button>
      </span>` : ""}
      <button type="button" class="emp-viewer-close" aria-label="إغلاق">✕</button>
    </div>
    <div class="emp-viewer-body"></div>
  </div>`;
  const body = overlay.querySelector(".emp-viewer-body");
  const tools = overlay.querySelector(".emp-viewer-tools");

  function show() {
    const item = items[index];
    zoomer?.destroy();
    zoomer = null;
    overlay.setAttribute("aria-label", item.title);
    overlay.querySelector(".emp-viewer-title").textContent = item.title;
    const count = overlay.querySelector(".emp-viewer-count");
    if (count) count.textContent = `${index + 1} / ${items.length}`;
    overlay.querySelector(".emp-viewer-prev")?.toggleAttribute("disabled", index === 0);
    overlay.querySelector(".emp-viewer-next")?.toggleAttribute("disabled", index === items.length - 1);
    if (item.kind === "pdf") {
      tools.innerHTML = "";
      body.innerHTML = `<iframe src="${escHtml(item.url)}" title="${escHtml(item.title)}"></iframe>`;
      return;
    }
    tools.innerHTML = zoomToolbarHtml();
    body.innerHTML = `<img src="${escHtml(item.url)}" alt="${escHtml(item.title)}" />`;
    zoomer = mountZoomViewer({ stage: body, img: body.querySelector("img"), toolbar: tools });
  }
  const go = delta => {
    const next = index + delta;
    if (next < 0 || next >= items.length) return;
    index = next;
    show();
  };
  const onKey = event => {
    if (event.key === "Escape") { event.stopPropagation(); close(); return; }
    // RTL: the left arrow moves forward.
    if (event.key === "ArrowLeft") { event.preventDefault(); go(1); return; }
    if (event.key === "ArrowRight") { event.preventDefault(); go(-1); return; }
    if (zoomer?.handleKey(event)) event.preventDefault();
  };
  const close = () => { zoomer?.destroy(); overlay.remove(); document.removeEventListener("keydown", onKey, true); };
  overlay.addEventListener("click", event => {
    if (event.target === overlay || event.target.closest(".emp-viewer-close")) close();
    else if (event.target.closest(".emp-viewer-prev")) go(-1);
    else if (event.target.closest(".emp-viewer-next")) go(1);
  });
  document.addEventListener("keydown", onKey, true);
  document.body.append(overlay);
  show();
  overlay.querySelector(".emp-viewer-close").focus();
}

// ── Personal photo (panel header) ───────────────────────────────────────────
function employeeInitials(name) {
  return String(name ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join(".");
}

function headerPhotoHtml(emp) {
  const assetUrl = emp?.photo_path && emp?.photo_full_path ? convertFileSrc(emp.photo_full_path) : "";
  const face = assetUrl
    ? `<img data-scan-path="${escHtml(emp.photo_path)}" src="${escHtml(assetUrl)}" alt="الصورة الشخصية" />`
    : `<span>${escHtml(employeeInitials(emp?.full_name)) || "—"}</span>`;
  if (!emp?.id) return `<div class="emp-avatar is-static" title="احفظ سجل الموظف أولاً لإضافة صورة">${face}</div>`;
  return `<div class="employee-photo-card emp-avatar-wrap">
    <button type="button" id="emp-avatar-btn" class="emp-avatar" aria-haspopup="menu" title="الصورة الشخصية">
      ${face}<span class="emp-avatar-edit" aria-hidden="true">✎</span>
    </button>
    <div class="emp-avatar-menu employee-photo-actions" role="menu">
      ${assetUrl ? `<button type="button" role="menuitem" class="emp-menu-item emp-view-attachment" data-url="${escHtml(assetUrl)}" data-kind="image" data-title="الصورة الشخصية">عرض</button>` : ""}
      <button type="button" role="menuitem" id="btn-upload-photo" class="emp-menu-item">${assetUrl ? "استبدال الصورة" : "رفع صورة"}</button>
      ${emp.photo_path && can(_currentUser, "documents.download") ? `<button type="button" role="menuitem" class="emp-menu-item btn-download-attachment" data-path="${escHtml(emp.photo_path)}">تحميل</button>` : ""}
      ${emp.photo_path && can(_currentUser, "employees.edit") ? `<button type="button" role="menuitem" id="btn-delete-photo" class="emp-menu-item is-danger">حذف الصورة</button>` : ""}
    </div>
  </div>`;
}

function bindHeaderPhoto(emp) {
  const panel = document.getElementById("emp-panel");
  const holder = document.getElementById("emp-panel-photo");
  if (!panel || !holder || !emp?.id) return;
  bindAttachmentDownloadButtons(holder);
  holder.querySelector("#btn-delete-photo")?.addEventListener("click", async event => {
    const button = event.currentTarget;
    try {
      if (!(await confirmAction("تأكيد حذف الصورة الشخصية؟"))) return;
      button.disabled = true;
      await api.deleteEmployeePhoto(emp.id);
      await refreshDocumentAttachments(emp.id);
      showToast("تم حذف الصورة الشخصية");
    } catch (error) { showToast(error?.message ?? String(error), "error"); }
    finally { button.disabled = false; }
  });
  holder.querySelector("#btn-upload-photo")?.addEventListener("click", async () => {
    try {
      collectVisiblePanelFields(panel);
      const selected = await open({
        multiple: false,
        filters: [{ name: "الصورة الشخصية", extensions: ["jpg", "jpeg", "png", "webp"] }],
      });
      if (!selected) return;
      if (!(await confirmAction("تأكيد رفع الصورة الشخصية؟"))) return;
      await api.uploadEmployeePhoto(emp.id, selected);
      showToast("تم رفع الصورة الشخصية");
      await refreshDocumentAttachments(emp.id);
    } catch (err) { showToast(errorText(err, "خطأ في رفع الصورة"), "error"); }
  });
}

// ── Collapsible sections and document status ────────────────────────────────
let _sectionState = new Map();

function sectionOpen(key, fallback) {
  return _sectionState.has(key) ? _sectionState.get(key) : fallback;
}

function formSection(key, title, body, { status = null, meta = "", open = false } = {}) {
  const isOpen = sectionOpen(`${_activeTab}:${key}`, open);
  return `<section class="emp-sec${isOpen ? " open" : ""}" id="emp-sec-${key}" data-sec="${key}">
    <button type="button" class="emp-sec-head" aria-expanded="${isOpen}">
      ${status ? `<span class="emp-dot ${status.tone}" aria-hidden="true"></span>` : ""}
      <span class="emp-sec-title">${title}</span>
      ${status ? `<span class="emp-pill ${status.tone}">${status.label}</span>` : ""}
      <span class="emp-sec-meta">${meta}<span class="emp-chev" aria-hidden="true"></span></span>
    </button>
    <div class="emp-sec-body">${body}</div>
  </section>`;
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const date = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((date - today) / 86400000);
}

function documentSections(emp) {
  const hasId = Boolean(emp?.id);
  const sided = (type, prefix) => [
    sidedCardTile(type === "ministry" ? "الوجه العربي" : "الوجه الأمامي", "front", emp?.[`${prefix}_front_path`], emp?.[`${prefix}_front_full_path`], hasId, type),
    sidedCardTile(type === "ministry" ? "الوجه الإنكليزي" : "الوجه الخلفي", "back", emp?.[`${prefix}_back_path`], emp?.[`${prefix}_back_full_path`], hasId, type),
  ];
  const sidedCount = prefix => [emp?.[`${prefix}_front_path`], emp?.[`${prefix}_back_path`]].filter(Boolean).length;
  const sections = [
    {
      key: "national", title: "البطاقة الوطنية", expiry: "civil_id_expiry_date", maxDays: alertWindowDays("national"),
      keys: ["civil_id", "civil_id_issuer", "civil_id_issue_date", "civil_id_expiry_date", "civil_id_family_number"],
      fields: [
        field("الرقم الوطني", "civil_id", emp, {ltr:true, span:true}),
        field("جهة الإصدار", "civil_id_issuer", emp),
        field("تاريخ الإصدار", "civil_id_issue_date", emp, {date:true}),
        field("تاريخ النفاذ", "civil_id_expiry_date", emp, {date:true}),
        field("الرقم العائلي", "civil_id_family_number", emp, {ltr:true}),
      ],
      tiles: sided("national", "civil_id"), attached: sidedCount("civil_id"), expected: 2,
    },
    {
      key: "passport", title: "جواز السفر", expiry: "passport_expiry_date", maxDays: alertWindowDays("passport"),
      keys: ["passport_no", "passport_type", "passport_name", "passport_issue_date", "passport_expiry_date"],
      fields: [
        field("رقم جواز السفر", "passport_no", emp, {ltr:true}),
        field("نوع جواز السفر", "passport_type", emp, {type:"select", options:[["","—"],["P","P"],["D","D"],["S","S"]]}),
        employeeNameFields("الاسم حسب الجواز", "passport_name", emp, {passport:true}),
        field("تاريخ الإصدار", "passport_issue_date", emp, {date:true}),
        field("تاريخ النفاذ", "passport_expiry_date", emp, {date:true}),
      ],
      tiles: [passportTile(emp)], attached: firstJsonPath(emp?.passport_attachment_paths) ? 1 : 0, expected: 1,
    },
    {
      key: "residence", title: "بطاقة السكن",
      // The old card's other fields are handwritten and cannot be read: they are typed.
      keys: ["residence_card_no", "residence_card_issue_date", "residence_card_issuer", "residence_head_name", "residence_form_no", "residence_address"],
      fields: [
        field("رقم بطاقة السكن", "residence_card_no", emp, {ltr:true}),
        field("تاريخ الإصدار", "residence_card_issue_date", emp, {date:true}),
        field("مكتب المعلومات", "residence_card_issuer", emp),
        field("اسم رب الأسرة", "residence_head_name", emp),
        field("رقم الاستمارة", "residence_form_no", emp, {ltr:true}),
        addressField("عنوان السكن", "residence_address"),
      ],
      tiles: sided("residence", "residence_card"), attached: sidedCount("residence_card"), expected: 2,
    },
    {
      key: "ration", title: "البطاقة التموينية الإلكترونية",
      keys: ["ration_card_no", "ration_center_name"],
      fields: [
        field("رقم البطاقة التموينية", "ration_card_no", emp, {ltr:true}),
        field("اسم رب الأسرة", "ration_center_name", emp),
      ],
      tiles: [rationCardTile(emp)], attached: firstJsonPath(emp?.ration_card_attachment_paths) ? 1 : 0, expected: 1,
    },
    {
      key: "airport", title: "باج دخول مطار بغداد", expiry: "airport_badge_expiry", maxDays: alertWindowDays("airport"),
      keys: ["airport_badge_no", "airport_badge_issue_date", "airport_badge_expiry"],
      fields: [
        field("رقم الباج", "airport_badge_no", emp, {ltr:true, span:true}),
        field("تاريخ الإصدار", "airport_badge_issue_date", emp, {date:true}),
        field("تاريخ النفاذ", "airport_badge_expiry", emp, {date:true}),
        zonesField("صلاحيات الباج", "airport_badge_zones", emp),
      ],
      tiles: sided("airport", "airport_badge"), attached: sidedCount("airport_badge"), expected: 2,
    },
    {
      key: "ministry", title: "هوية وزارة النقل", expiry: "ministry_badge_expiry", maxDays: alertWindowDays("ministry"),
      keys: ["ministry_badge_no", "ministry_badge_issue_date", "ministry_badge_expiry"],
      fields: [
        field("رقم الهوية", "ministry_badge_no", emp, {ltr:true, span:true}),
        field("تاريخ الإصدار", "ministry_badge_issue_date", emp, {date:true}),
        field("تاريخ النفاذ", "ministry_badge_expiry", emp, {date:true}),
      ],
      tiles: sided("ministry", "ministry_badge"), attached: sidedCount("ministry_badge"), expected: 2,
    },
  ];
  return sections.map(section => ({
    ...section,
    status: documentStatus({
      values: section.keys.map(key => emp?.[key]),
      expiry: section.expiry ? emp?.[section.expiry] : null,
      maxDays: section.maxDays ?? 0,
      attached: section.attached,
      expected: section.expected,
    }),
  }));
}

function documentsTabHtml(emp) {
  const isNew = !emp?.id;
  const sections = documentSections(emp);
  const body = sections.map(section => {
    const expiryValue = section.expiry ? emp?.[section.expiry] : "";
    const meta = `${expiryValue ? `<span>النفاذ: ${formatDate(expiryValue)}</span>` : ""}<span>المرفقات ${section.attached}/${section.expected}</span>`;
    const content = `<div class="emp-grid">${section.fields.join("")}</div>
      <p class="emp-att-title">المرفقات</p>
      ${isNew ? `<p class="emp-tile-note">احفظ سجل الموظف أولاً لرفع المرفقات</p>` : `<div class="emp-tiles">${section.tiles.join("")}</div>`}`;
    return formSection(section.key, section.title, content, {
      status: section.status, meta, open: isNew || ["bad", "warn"].includes(section.status.tone),
    });
  }).join("");
  return `    <div class="emp-sec-tools"><button type="button" class="emp-link" data-sections-all="open">فتح الكل</button><button type="button" class="emp-link" data-sections-all="close">طيّ الكل</button></div>
    ${body}`;
}

// ── Collapsible list rows (spouses, family members, vehicles) ───────────────
function ageText(birthdate) {
  const days = daysUntil(birthdate);
  if (days === null || days > 0) return "";
  const years = Math.floor(-days / 365.25);
  return years < 1 ? "أقل من سنة" : `${years} سنة`;
}

function personSummary({ name, gender, birthdate }) {
  return [name || "بدون اسم", gender, ageText(birthdate)].filter(Boolean).join(" · ");
}

function vehicleSummary({ brand, type, color, plate }) {
  // The plate first, so a narrow panel cuts the description and not the plate; isolated so
  // "11 Z12345" keeps its order inside the Arabic summary.
  const description = [brand, type, color].filter(Boolean).join(" ");
  return [plate && `\u2068${plate}\u2069`, description || (plate ? "" : "مركبة بدون بيانات")].filter(Boolean).join(" · ");
}

/** «البطاقة: منتهٍ» / «البطاقة: ينتهي خلال 12 يوماً» for a spouse or family member's national
 *  card, with the national card's reminder days from the settings. Nothing while it is valid. */
function cardExpiryPill(record) {
  if (!record?.expiry_date) return "";
  const status = documentStatus({ values: [record.civil_id], expiry: record.expiry_date, maxDays: alertWindowDays("national"), attached: 0, expected: 0 });
  return ["bad", "warn"].includes(status.tone) ? `<span class="emp-pill ${status.tone}" title="نفاذ البطاقة الوطنية: ${formatDate(record.expiry_date)}">البطاقة: ${status.label}</span>` : "";
}

function rowSummaryFromInputs(row) {
  const value = selector => row.querySelector(selector)?.value?.trim() || "";
  if (row.classList.contains("vehicle-row")) {
    return vehicleSummary({ brand: value(".vehicle-brand"), type: value(".vehicle-type"), color: value(".vehicle-color"), plate: value(".vehicle-plate") });
  }
  const prefix = row.classList.contains("spouse-row") ? "sp" : "fm";
  const nameGroup = row.querySelector('.name-fields[data-name-key="name"]');
  return personSummary({ name: nameGroup ? readNameGroup(nameGroup).text : "", gender: value(`.${prefix}-gender`), birthdate: value(`.${prefix}-birthdate`) });
}

function rowHead({ title, summary, extra = "", removeClass }) {
  return `<div class="emp-row-head">
      <span class="emp-row-title">${title}</span>
      <span class="emp-row-summary">${escHtml(summary)}</span>
      ${extra}
      <span class="emp-chev" aria-hidden="true"></span>
      <button type="button" class="${removeClass} btn-danger" style="font-size:11px;padding:2px 8px">حذف</button>
    </div>`;
}

function rowOpenClass(key, isExisting) {
  return sectionOpen(key, !isExisting) ? "" : " collapsed";
}

const printableDocumentDefinitions = [
  {
    id: "photo",
    title: "الصورة الشخصية",
    render: emp => printablePersonalPhoto(emp),
  },
  {
    id: "national",
    title: "البطاقة الوطنية",
    fields: [
      ["الرقم الوطني", "civil_id"],
      ["جهة الإصدار", "civil_id_issuer"],
      ["تاريخ الإصدار", "civil_id_issue_date"],
      ["تاريخ النفاذ", "civil_id_expiry_date"],
      ["محل الولادة", "birthplace"],
      ["تاريخ الولادة", "birthdate"],
      ["الرقم العائلي", "civil_id_family_number"],
    ],
    attachments: [
      ["الوجه الأمامي", "civil_id_front_path", "civil_id_front_full_path"],
      ["الوجه الخلفي", "civil_id_back_path", "civil_id_back_full_path"],
    ],
  },
  {
    id: "family-national-cards",
    title: "البطاقة الوطنية لأفراد الأسرة",
    render: emp => printableFamilyNationalCards(emp),
  },
  {
    id: "spouse-national-cards",
    title: "البطاقة الوطنية للزوجات",
    render: emp => printableSpouseNationalCards(emp),
  },
  {
    id: "passport",
    title: "جواز السفر",
    fields: [
      ["رقم جواز السفر", "passport_no"],
      ["نوع الجواز", "passport_type"],
      ["الاسم حسب الجواز", "passport_name"],
      ["تاريخ الإصدار", "passport_issue_date"],
      ["تاريخ النفاذ", "passport_expiry_date"],
    ],
    attachmentList: ["passport_attachment_paths", "passport_attachment_full_paths"],
  },
  {
    id: "residence",
    title: "بطاقة السكن",
    fields: [
      ["رقم بطاقة السكن", "residence_card_no"],
      ["تاريخ الإصدار", "residence_card_issue_date"],
      ["عنوان السكن", "residence_address"],
    ],
    attachments: [
      ["الوجه الأمامي", "residence_card_front_path", "residence_card_front_full_path"],
      ["الوجه الخلفي", "residence_card_back_path", "residence_card_back_full_path"],
    ],
  },
  {
    id: "ration",
    title: "البطاقة التموينية الإلكترونية",
    fields: [
      ["رقم البطاقة التموينية", "ration_card_no"],
      ["اسم رب الأسرة", "ration_center_name"],
    ],
    attachmentList: ["ration_card_attachment_paths", "ration_card_attachment_full_paths"],
  },
  {
    id: "airport",
    title: "باج دخول مطار بغداد",
    fields: [
      ["تاريخ الإصدار", "airport_badge_issue_date"],
      ["تاريخ النفاذ", "airport_badge_expiry"],
      ["رقم الباج", "airport_badge_no"],
    ],
    attachments: [
      ["الوجه الأمامي", "airport_badge_front_path", "airport_badge_front_full_path"],
      ["الوجه الخلفي", "airport_badge_back_path", "airport_badge_back_full_path"],
    ],
  },
  {
    id: "ministry",
    title: "هوية وزارة النقل",
    fields: [
      ["تاريخ الإصدار", "ministry_badge_issue_date"],
      ["تاريخ النفاذ", "ministry_badge_expiry"],
      ["رقم الهوية", "ministry_badge_no"],
    ],
    attachments: [
      ["الوجه العربي", "ministry_badge_front_path", "ministry_badge_front_full_path"],
      ["الوجه الإنكليزي", "ministry_badge_back_path", "ministry_badge_back_full_path"],
    ],
  },
];

function printableAttachment(label, path, fullPath) {
  if (!path || !fullPath) {
    return "";
  }
  const name = path.split(/[/\\]/).pop();
  const extension = name?.split(".").pop()?.toLowerCase();
  const assetUrl = convertFileSrc(fullPath);
  const content = ["jpg", "jpeg", "png", "webp"].includes(extension)
    ? `<img data-scan-path="${escHtml(path)}" src="${escHtml(assetUrl)}" alt="${escHtml(label)}" />`
    : extension === "pdf"
      ? `<object data="${escHtml(assetUrl)}" type="application/pdf"></object>`
      : "";
  return content ? `<div class="print-attachment">${content}</div>` : "";
}

function printablePersonalPhoto(emp) {
  if (!emp?.photo_full_path) return "";
  const assetUrl = convertFileSrc(emp.photo_full_path);
  return `<section class="print-document print-photo-document" data-print-section="photo">
    <div class="print-photo-wrap">
      <img src="${escHtml(assetUrl)}" alt="الصورة الشخصية" />
    </div>
  </section>`;
}

function parseFamilyMembers(emp) {
  try { return JSON.parse(emp?.family_members ?? "[]"); }
  catch { return []; }
}

function spouseSectionConfig(emp) {
  if (!["متزوج", "أرمل", "ارمل", "مطلق"].includes(emp?.marital_status)) return null;
  if (emp?.gender === "ذكر") {
    return { title: "الزوجات", itemLabel: "زوجة", addLabel: "إضافة زوجة", emptyLabel: "لا توجد زوجات مسجلات", max: 4, defaultGender: "أنثى" };
  }
  if (emp?.gender === "أنثى") {
    return { title: "الزوج", itemLabel: "زوج", addLabel: "إضافة زوج", emptyLabel: "لا يوجد زوج مسجل", max: 1, defaultGender: "ذكر" };
  }
  return null;
}

function spouseSectionHtml(emp) {
  const config = spouseSectionConfig(emp);
  if (!config) return "";
  return `
    ${sectionTitle(config.title)}
    <div style="grid-column:span 2">
      <div id="spouse-list"></div>
      <button id="btn-add-spouse" class="btn-secondary text-sm mt-2">+ ${config.addLabel}</button>
    </div>`;
}

function printableFamilyNationalCards(emp) {
  return parseFamilyMembers(emp).map((member, index) => {
    const label = member?.name || `فرد ${index + 1}`;
    const attachments = [
      ["الوجه الأمامي", member?.national_card_front_path, member?.national_card_front_full_path],
      ["الوجه الخلفي", member?.national_card_back_path, member?.national_card_back_full_path],
    ].map(([sideLabel, path, fullPath]) => printableAttachment(`${label} - ${sideLabel}`, path, fullPath)).join("");
    return attachments ? `<section class="print-document" data-print-section="family-national-card-${index}">${attachments}</section>` : "";
  }).join("");
}

function printableSpouseNationalCards(emp) {
  const config = spouseSectionConfig(emp);
  if (!config) return "";
  return spouseListFromEmployee(emp).map((spouse, index) => {
    const label = spouse?.name || `${config.itemLabel} ${index + 1}`;
    const attachments = [
      ["الوجه الأمامي", spouse?.national_card_front_path, spouse?.national_card_front_full_path],
      ["الوجه الخلفي", spouse?.national_card_back_path, spouse?.national_card_back_full_path],
    ].map(([sideLabel, path, fullPath]) => printableAttachment(`${label} - ${sideLabel}`, path, fullPath)).join("");
    return attachments ? `<section class="print-document" data-print-section="spouse-national-card-${index}">${attachments}</section>` : "";
  }).join("");
}

function printableSection(definition, emp) {
  if (definition.render) return definition.render(emp);
  let attachments = definition.attachments ?? [];
  if (definition.attachmentList) {
    let paths = [];
    try { paths = JSON.parse(emp?.[definition.attachmentList[0]] ?? "[]"); } catch {}
    const fullPaths = emp?.[definition.attachmentList[1]] ?? [];
    attachments = paths.length
      ? paths.map((path, index) => [`المرفق ${index + 1}`, path, fullPaths[index]])
      : [["المرفق", null, null]];
  }
  const content = attachments.map(([label, pathKey, fullPathKey]) => printableAttachment(
        label,
        definition.attachments ? emp?.[pathKey] : pathKey,
        definition.attachments ? emp?.[fullPathKey] : fullPathKey,
      )).join("");
  return content ? `<section class="print-document" data-print-section="${definition.id}">${content}</section>` : "";
}

function printableDefinitionTitle(definition, emp) {
  if (definition.id === "spouse-national-cards") {
    const config = spouseSectionConfig(emp);
    return config?.max === 1 ? "البطاقة الوطنية للزوج" : "البطاقة الوطنية للزوجات";
  }
  return definition.title;
}

function visiblePrintableDocumentDefinitions(emp) {
  return printableDocumentDefinitions.filter(definition => definition.id !== "spouse-national-cards" || spouseSectionConfig(emp));
}

function printableDocumentsHtml(emp, selectedIds) {
  const sections = visiblePrintableDocumentDefinitions(emp)
    .filter(definition => selectedIds.has(definition.id))
    .map(definition => printableSection(definition, emp))
    .join("");
  return `<div class="print-page" dir="rtl">${sections || `<p class="print-no-selection">لا توجد مرفقات محددة للطباعة</p>`}</div>`;
}

const printableDocumentsCss = `
  *{box-sizing:border-box} body{margin:0;background:#d1d5db;font-family:Arial,sans-serif;color:#111827}
  .print-page{width:210mm;min-height:297mm;margin:12px auto;padding:10mm;background:#fff;box-shadow:0 3px 18px rgba(0,0,0,.2)}
  .print-document{display:grid;grid-template-columns:1fr 1fr;gap:8mm;margin:0 0 8mm;break-inside:avoid;page-break-inside:avoid}
  .print-attachment{min-height:50mm;text-align:center;overflow:hidden;break-inside:avoid;page-break-inside:avoid}
  .print-attachment img,.print-attachment object{display:block;width:100%;height:auto;max-height:125mm;object-fit:contain}
  .print-attachment object{height:115mm}
  .print-photo-document{display:flex;justify-content:center}
  .print-photo-wrap{width:45mm;text-align:center}
  .print-photo-wrap img{display:block;width:45mm;height:55mm;object-fit:cover;border:1px solid #d1d5db}
  .print-no-selection{text-align:center;padding:50px;color:#6b7280}
  @page{size:A4;margin:0}@media print{body{background:#fff}.print-page{margin:0;box-shadow:none;width:210mm;min-height:297mm}}
`;

async function printSelectedDocuments(emp, selectedIds) {
  const documentNames = visiblePrintableDocumentDefinitions(emp).filter(definition => selectedIds.has(definition.id)).map(definition => printableDefinitionTitle(definition, emp));
  await api.printEmployeeDocuments(emp.id, documentNames);
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;right:-9999px";
  document.body.append(frame);
  const doc = frame.contentDocument;
  doc.open();
  doc.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><title>مستمسكات ${escHtml(emp.full_name)}</title><style>${printableDocumentsCss}</style></head><body>${printableDocumentsHtml(emp, selectedIds)}</body></html>`);
  doc.close();
  const removeFrame = () => frame.isConnected && frame.remove();
  frame.contentWindow.addEventListener("afterprint", removeFrame, { once: true });
  setTimeout(() => {
    frame.contentWindow.focus();
    frame.contentWindow.print();
  }, 800);
  setTimeout(removeFrame, 60000);
}

function openDocumentsPrintDialog(emp) {
  const overlay = document.createElement("div");
  overlay.setAttribute("dir", "rtl");
  overlay.style.cssText = "position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.72);display:flex;flex-direction:column";
  overlay.innerHTML = `
    <div style="height:64px;background:var(--ui-surface);border-bottom:1px solid var(--ui-line);display:flex;align-items:center;gap:10px;padding:10px 18px">
      <strong style="font-size:16px;margin-left:auto">طباعة مستمسكات ${escHtml(emp.full_name)}</strong>
      <button type="button" id="docs-print" class="btn-primary">طباعة</button>
      <button type="button" id="docs-print-close" class="btn-secondary">إغلاق</button>
    </div>
    <div style="display:grid;grid-template-columns:260px 1fr;min-height:0;flex:1">
      <aside style="background:var(--ui-surface-2);border-left:1px solid var(--ui-line);padding:16px;overflow:auto">
        <p style="font-size:12px;color:var(--ui-text-muted);margin-bottom:12px">أزل التأشير عن المستمسكات التي لا تريد ظهورها في الطباعة.</p>
        ${visiblePrintableDocumentDefinitions(emp).map(definition => `
          <label style="display:flex;align-items:center;gap:8px;padding:9px 6px;border-bottom:1px solid var(--ui-line);cursor:pointer">
            <input type="checkbox" class="docs-print-choice" value="${definition.id}" checked style="width:16px;height:16px;accent-color:var(--ui-accent)" />
            <span style="font-size:13px;color:var(--ui-text-strong)">${escHtml(printableDefinitionTitle(definition, emp))}</span>
          </label>`).join("")}
      </aside>
      <main id="docs-print-preview" style="overflow:auto;background:#555;padding:18px"></main>
    </div>`;
  document.body.append(overlay);

  const selectedIds = () => new Set([...overlay.querySelectorAll(".docs-print-choice:checked")].map(input => input.value));
  const renderPreview = () => {
    const preview = overlay.querySelector("#docs-print-preview");
    preview.innerHTML = `<iframe title="معاينة مستمسكات الموظف" style="display:block;width:100%;height:100%;min-height:700px;border:0;background:#d1d5db"></iframe>`;
    preview.querySelector("iframe").srcdoc = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><style>${printableDocumentsCss}</style></head><body>${printableDocumentsHtml(emp, selectedIds())}</body></html>`;
  };
  overlay.querySelector("#docs-print").addEventListener("click", async () => {
    try { await printSelectedDocuments(emp, selectedIds()); }
    catch (error) { showToast(error?.message ?? "غير مصرح بالطباعة", "error"); }
  });
  overlay.querySelector("#docs-print-close").addEventListener("click", () => overlay.remove());
  overlay.querySelectorAll(".docs-print-choice").forEach(input => input.addEventListener("change", renderPreview));
  renderPreview();
}

// ── Tabs ────────────────────────────────────────────────────────────────────
const TABS = [
  { id: "basic",       label: "البيانات الأساسية" },
  { id: "documents",   label: "المستمسكات" },
  { id: "family",      label: "أفراد الأسرة" },
  { id: "vehicle",     label: "المركبات" },
];

function tabContent(tab, emp) {
  switch(tab) {
    case "basic": {
      const isNew = !emp?.id;
      const personal = `<div class="emp-grid">
        ${employeeNameFields("اسم الموظف", "full_name", emp, {required:true})}
        ${employeeNameFields("اسم الأم", "mother_name", emp)}
        ${field("الجنس", "gender", emp, {type:"select", options:[["","—"],["ذكر","ذكر"],["أنثى","أنثى"]]})}
        ${field("الحالة الاجتماعية", "marital_status", emp, {type:"select", options:maritalOptions(emp?.gender)})}
        ${field("تاريخ الولادة", "birthdate", emp, {date:true})}
        ${field("محل الولادة", "birthplace", emp)}
        ${field("فصيلة الدم", "blood_type", emp, {type:"select", options:[["","—"],...BLOOD_OPTIONS]})}
        ${field("رقم الهاتف", "phone", emp, {ltr:true})}
        ${field("البريد الإلكتروني", "email", emp, {ltr:true, span:true})}
      </div>`;
      const parents = `<div class="emp-grid">
        ${field("تاريخ ولادة الأب", "father_birthdate", emp, {date:true})}
        ${field("محل ولادة الأب", "father_birthplace", emp)}
        ${field("تاريخ ولادة الأم", "mother_birthdate", emp, {date:true})}
        ${field("محل ولادة الأم", "mother_birthplace", emp)}
      </div>`;
      const employment = `<div class="emp-grid">
        ${field("الرقم الوظيفي", "employee_number", emp, {ltr:true})}
        ${fixedCompanyField("مكان العمل", "workplace", _companyConfig?.company_name ?? emp?.workplace ?? "")}
        ${field("العنوان الوظيفي", "job_title", emp)}
        ${listField("الدرجة الوظيفية", "job_grade", emp)}
        ${listField("المرحلة", "job_step", emp)}
        ${field("تاريخ التعيين", "appointment_date", emp, {date:true})}
        ${fixedCompanyField("القسم", "department", fixedDepartment(emp))}
        ${fixedCompanyField("الشعبة / الوحدة", "division", _companyConfig?.division_name ?? emp?.division ?? "")}
        ${field("تاريخ المباشرة", "hire_date", emp, {date:true})}
        ${field("نوع التوظيف", "contract_type", emp, {type:"select", options:[["","—"],["ملاك","ملاك"],["عقد","عقد"],["تنسيب","تنسيب"],["تكليف","تكليف"],["اجر يومي","اجر يومي"]]})}
        ${field("نظام العمل", "work_schedule", emp, {type:"select", options:[["","—"],["صباحي","صباحي"],["مناوب مسائي","مناوب مسائي"]]})}
        ${field("ملاحظات نوع التوظيف", "work_type_notes", emp, {type:"textarea", span:true, grow:true})}
      </div>`;
      const education = `<div class="emp-grid">
        ${field("التحصيل الدراسي", "education_level", emp, {type:"select", options:[["","—"],["ابتدائية","ابتدائية"],["متوسطة","متوسطة"],["إعدادية","إعدادية"],["دبلوم","دبلوم"],["بكالوريوس","بكالوريوس"],["ماجستير","ماجستير"],["دكتوراه","دكتوراه"]]})}
        ${field("التخصص", "specialization", emp)}
        ${field("سنة التخرج", "graduation_year", emp, {ltr:true})}
      </div>`;
      const extra = `<div class="emp-grid">
        ${field("ملاحظات", "notes", emp, {type:"textarea", span:true, grow:true})}
        <div style="grid-column:span 2;display:flex;align-items:center;gap:8px">
          <input id="f-is_active" type="checkbox" style="width:16px;height:16px;accent-color:var(--ui-accent)"
                 ${(!emp || emp.is_active) ? "checked" : ""} />
          <label for="f-is_active" style="font-size:14px;color:var(--ui-text)">موظف نشط</label>
        </div>
      </div>`;
      return `<div class="emp-sec-tools"><button type="button" class="emp-link" data-sections-all="open">فتح الكل</button><button type="button" class="emp-link" data-sections-all="close">طيّ الكل</button></div>
        ${formSection("personal", "المعلومات الشخصية", personal, { open: true })}
        ${formSection("parents", "معلومات الوالدين", parents, { open: isNew })}
        ${formSection("employment", "بيانات التوظيف", employment, { open: true })}
        ${formSection("education", "التحصيل الدراسي", education, { open: isNew })}
        ${formSection("extra", "ملاحظات وحالة الموظف", extra, { open: isNew })}`;
    }

    case "documents": return documentsTabHtml(emp);

    case "family": return `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
        ${spouseSectionHtml(emp)}
        ${sectionTitle("الأبناء وبقية الأسرة")}
        <div style="grid-column:span 2">
          <div id="family-list"></div>
          <button id="btn-add-member" class="btn-secondary text-sm mt-2">+ إضافة فرد</button>
        </div>
      </div>`;

    case "vehicle": return `
      <div>
        <div id="vehicle-list"></div>
        <button id="btn-add-vehicle" class="btn-secondary text-sm mt-2">+ إضافة مركبة</button>
      </div>`;

  }
}

/** The stored values stay «متزوج» etc.; a woman's file shows «متزوجة». */
const MARITAL_FEMININE = { "أعزب": "عزباء", "متزوج": "متزوجة", "مطلق": "مطلقة", "أرمل": "أرملة" };
export function maritalLabel(value, gender) {
  return gender === "أنثى" ? MARITAL_FEMININE[value] ?? value : value;
}
function maritalOptions(gender) {
  return [["", "—"], ...["أعزب", "متزوج", "مطلق", "أرمل"].map(value => [value, maritalLabel(value, gender)])];
}

function parseJsonList(value) {
  try { const list = JSON.parse(value ?? "[]"); return Array.isArray(list) ? list : []; } catch { return []; }
}

/** Blood types with a left-to-right mark after the label, so «O+» is not shown as «+O» in a right-to-left line. */
const BLOOD_OPTIONS = ["A+","A-","B+","B-","AB+","AB-","O+","O-"].map(v => [v, `${v}\u200E`]);

// ── Missing data ───────────────────────────────────────────────────────────
/** The «البيانات الأساسية» fields every employee file should have. The rest (email, parents,
 *  start date, specialization, notes, …) are optional. Documents have their own status. */
export const REQUIRED_FIELDS = [
  ["employee_number", "الرقم الوظيفي"], ["full_name", "اسم الموظف"], ["mother_name", "اسم الأم"],
  ["gender", "الجنس"], ["marital_status", "الحالة الاجتماعية"], ["birthdate", "تاريخ الولادة"],
  ["birthplace", "محل الولادة"], ["blood_type", "فصيلة الدم"], ["phone", "رقم الهاتف"],
  ["job_title", "العنوان الوظيفي"], ["job_grade", "الدرجة الوظيفية"], ["appointment_date", "تاريخ التعيين"],
  ["contract_type", "نوع التوظيف"], ["education_level", "التحصيل الدراسي"],
];

/** The labels of the required fields an employee record leaves empty. */
export function missingFields(emp) {
  return REQUIRED_FIELDS.filter(([key]) => !String(emp?.[key] ?? "").trim()).map(([, label]) => label);
}

/** «ناقص N» with the empty fields named on hover, or nothing. */
function missingBadge(missing, cls = "") {
  return missing.length ? `<span class="emp-missing-badge ${cls}" title="بيانات ناقصة: ${escHtml(missing.join("، "))}">ناقص ${missing.length}</span>` : "";
}

/** The panel's values now: what is typed in the visible tab, otherwise the draft. */
function liveMissing(panel) {
  const values = { ..._panelDraft };
  panel.querySelectorAll("#tab-content [id^='f-']").forEach(el => { values[el.id.slice(2)] = el.value; });
  panel.querySelectorAll("#tab-content .name-fields[data-name-key]").forEach(group => {
    if (REQUIRED_FIELDS.some(([key]) => key === group.dataset.nameKey)) {
      values[group.dataset.nameKey] = [...group.querySelectorAll(".name-part")].map(input => input.value.trim()).join(" ").trim();
    }
  });
  return missingFields(values);
}

/** Header badge, tab badge and the empty required fields outlined, kept in step with typing. */
function refreshMissing() {
  const panel = document.getElementById("emp-panel");
  if (!panel || !_panelDraft) return;
  const missing = liveMissing(panel);
  const slot = panel.querySelector("#emp-panel-missing");
  if (slot) slot.innerHTML = missingBadge(missing);
  const badge = panel.querySelector('.emp-tab-count[data-count-for="basic"]');
  if (badge) {
    badge.hidden = !missing.length;
    badge.textContent = missing.length ? `ناقص ${missing.length}` : "";
    badge.title = missing.length ? `بيانات ناقصة: ${missing.join("، ")}` : "";
    badge.classList.add("is-warn");
  }
  REQUIRED_FIELDS.forEach(([key]) => {
    const target = panel.querySelector(`#tab-content #f-${key}`) ?? panel.querySelector(`#tab-content .name-fields[data-name-key="${key}"]`);
    if (!target) return;
    const value = target.matches(".name-fields") ? [...target.querySelectorAll(".name-part")].some(input => input.value.trim()) : String(target.value ?? "").trim();
    (target.matches(".name-fields") ? target : target.closest("div")).classList.toggle("emp-is-missing", !value);
  });
}

function updateTabCounts() {
  const panel = document.getElementById("emp-panel");
  const draft = _panelDraft;
  if (!panel || !draft) return;
  const alerts = documentSections(draft).filter(section => ["bad", "warn"].includes(section.status.tone)).length;
  const counts = {
    documents: alerts ? { text: `${alerts} تنبيه`, warn: true } : null,
    family: (() => {
      const total = spouseListFromEmployee(draft).length + parseJsonList(draft.family_members).length;
      return total ? { text: String(total) } : null;
    })(),
    vehicle: (() => {
      const total = parseJsonList(draft.vehicles).length;
      return total ? { text: String(total) } : null;
    })(),
  };
  panel.querySelectorAll(".emp-tab-count").forEach(badge => {
    if (badge.dataset.countFor === "basic") return;
    const count = counts[badge.dataset.countFor];
    badge.hidden = !count;
    badge.textContent = count?.text ?? "";
    badge.classList.toggle("is-warn", Boolean(count?.warn));
  });
  refreshMissing();
}

function closeEmployeeMenus(except = null) {
  document.querySelectorAll("#emp-panel .emp-tile.menu-open, #emp-panel .emp-avatar-wrap.menu-open").forEach(holder => {
    if (holder !== except) holder.classList.remove("menu-open");
  });
}

function setSectionOpen(section, open) {
  section.classList.toggle("open", open);
  section.querySelector(":scope > .emp-sec-head")?.setAttribute("aria-expanded", String(open));
  _sectionState.set(`${_activeTab}:${section.dataset.sec}`, open);
}

/**
 * Saves the employee (the panel stays open), then presses the same upload button again.
 * Row buttons are found again by the row's position, which is its index once saved.
 */
async function saveThenUpload(button) {
  let selector = button.dataset.then;
  const row = button.closest(".vehicle-row, .family-row, .spouse-row");
  if (row) {
    const kind = [...row.classList].find(c => c.endsWith("-row") && c !== "emp-row");
    const position = [...document.querySelectorAll(`#emp-panel .${kind}`)].indexOf(row);
    const indexAttr = { "vehicle-row": "data-vehicle-index", "family-row": "data-member-index", "spouse-row": "data-spouse-index" }[kind];
    selector ??= `.${[...button.classList].find(c => c.startsWith("btn-upload-"))}[${indexAttr}="{i}"][data-side="${button.dataset.side}"]`;
    selector = selector.replace("{i}", String(position));
  }
  if (!selector) return;
  if (!(await confirmAction("يُحفظ الموظف أولاً ثم يُرفع الملف. متابعة؟"))) return;
  _afterSave = () => {
    const next = document.querySelector(`#emp-panel ${selector}`);
    next?.closest(".emp-row")?.classList.remove("collapsed");
    next?.click();
  };
  document.getElementById("panel-save")?.click();
}

function handlePanelUiClick(event) {
  const target = event.target;
  const saveFirst = target.closest(".btn-save-then-upload");
  if (saveFirst) { saveThenUpload(saveFirst); return; }
  const menuToggle = target.closest(".emp-tile-more, #emp-avatar-btn");
  if (menuToggle) {
    const holder = menuToggle.closest(".emp-tile, .emp-avatar-wrap");
    closeEmployeeMenus(holder);
    holder?.classList.remove("menu-up");
    holder?.classList.toggle("menu-open");
    const menu = holder?.querySelector(".emp-tile-menu");
    const content = document.getElementById("tab-content");
    if (menu && content && holder.classList.contains("menu-open")
        && menu.getBoundingClientRect().bottom > content.getBoundingClientRect().bottom) {
      holder.classList.add("menu-up");
    }
    return;
  }
  const viewer = target.closest(".emp-view-attachment");
  if (viewer) {
    const scope = viewer.closest("#tab-content") ?? document;
    const buttons = [...scope.querySelectorAll(".emp-view-attachment")];
    openAttachmentViewer(buttons.map(viewerItemFromButton), Math.max(0, buttons.indexOf(viewer)));
  }
  const zoneAdd = target.closest(".emp-zone-add");
  if (zoneAdd) {
    const box = zoneAdd.parentElement.previousElementSibling;
    setZones(box, zoneCodes([box.querySelector("input[type=hidden]").value, zoneAdd.dataset.zone].join(",")));
    return;
  }
  const zoneRemove = target.closest(".emp-zone-remove");
  if (zoneRemove) {
    const box = zoneRemove.closest(".emp-zones");
    setZones(box, zoneCodes(box.querySelector("input[type=hidden]").value).filter(z => z !== zoneRemove.dataset.zone));
    return;
  }
  const reader = target.closest(".emp-read-fields");
  if (reader) readFieldsInto(reader.dataset.target, reader.dataset.path, reader.dataset.url, reader.dataset.title);
  const thumb = target.closest(".emp-tile-thumb");
  if (thumb) thumb.closest(".emp-tile")?.querySelector(".emp-view-attachment")?.click();
  closeEmployeeMenus();
  if (target.closest("input,select,textarea")) return;

  const head = target.closest(".emp-sec-head");
  if (head) { const section = head.closest(".emp-sec"); setSectionOpen(section, !section.classList.contains("open")); return; }

  const all = target.closest("[data-sections-all]");
  if (all) {
    document.querySelectorAll("#tab-content .emp-sec").forEach(section => setSectionOpen(section, all.dataset.sectionsAll === "open"));
    return;
  }

  const rowHeadEl = target.closest(".emp-row-head");
  if (rowHeadEl && !target.closest("button")) {
    const row = rowHeadEl.closest(".emp-row");
    const collapsed = !row.classList.contains("collapsed");
    row.classList.toggle("collapsed", collapsed);
    const summary = row.querySelector(".emp-row-summary");
    if (summary) summary.textContent = rowSummaryFromInputs(row);
    if (row.dataset.rowKey) _sectionState.set(row.dataset.rowKey, !collapsed);
  }
}

// ── Panel render ────────────────────────────────────────────────────────────
function renderPanel(emp) {
  const panel = document.getElementById("emp-panel");
  const isNew = !emp;
  const draft = _panelDraft ?? emp ?? {};

  panel.innerHTML = `
    <!-- Header -->
    <div style="flex-shrink:0;padding:14px 20px;border-bottom:1px solid var(--ui-line);
                display:flex;align-items:center;justify-content:space-between">
      <div style="display:flex;align-items:center;gap:12px;min-width:0">
        <div id="emp-panel-photo">${headerPhotoHtml(draft)}</div>
        <div style="min-width:0">
          <h3 style="font-weight:700;font-size:15px">${isNew ? "إضافة موظف جديد" : escHtml(emp.full_name)}</h3>
          ${!isNew ? `<p style="font-size:11px;color:var(--ui-text-faint)">${[emp.employee_number ? `<span dir="ltr">${escHtml(emp.employee_number)}</span>` : "", escHtml(emp.job_title ?? ""), escHtml(fixedDepartment(emp))].filter(Boolean).join(" · ")}</p>` : ""}
        </div>
        ${!isNew ? `<span class="emp-pill ${emp.is_active ? "ok" : "none"}">${emp.is_active ? "نشط" : "غير نشط"}</span>` : ""}
        ${!isNew ? `<span id="emp-panel-missing"></span>` : ""}
      </div>
      <button id="panel-close" style="color:var(--ui-text-muted);font-size:20px;background:none;border:none;cursor:pointer">✕</button>
    </div>

    <!-- Tabs -->
    <div style="flex-shrink:0;display:flex;gap:2px;padding:8px 12px;
                border-bottom:1px solid var(--ui-line);overflow-x:auto;flex-wrap:nowrap">
      ${TABS.map(t => `
        <button class="tab-btn" data-tab="${t.id}" style="
          white-space:nowrap;padding:6px 10px;border-radius:6px;font-size:12px;border:none;
          cursor:pointer;transition:all .15s;
          background:${_activeTab===t.id ? "var(--ui-accent-soft)" : "transparent"};
          color:${_activeTab===t.id ? "var(--ui-accent)" : "var(--ui-text-muted)"};
          font-weight:${_activeTab===t.id ? "700" : "400"}">
          ${t.label}<span class="emp-tab-count" data-count-for="${t.id}" hidden></span>
        </button>`).join("")}
    </div>

    <!-- Tab Content -->
    <div id="tab-content" style="flex:1;overflow-y:auto;padding:16px 20px 32px">
      ${tabContent(_activeTab, draft)}
    </div>

    <!-- Footer -->
    <div class="emp-footer">
      <span id="panel-dirty" class="emp-dirty" hidden>● تغييرات غير محفوظة</span>
      <div class="emp-footer-bar">
        <div class="emp-footer-main">
          <button id="panel-save" class="btn-primary">حفظ</button>
          <button id="panel-cancel" class="btn-secondary">إلغاء</button>
        </div>
        <div class="emp-footer-mid">
          ${!isNew ? `<button id="panel-print-documents" class="btn-secondary" style="display:${_activeTab === "documents" ? "inline-flex" : "none"}">طباعة المستمسكات</button>` : ""}
        </div>
        <div class="emp-footer-end">
          ${!isNew ? `<button id="panel-delete" class="btn-danger">حذف الموظف</button>` : ""}
        </div>
      </div>
    </div>`;

  // Tab switching
  panel.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      collectVisiblePanelFields(panel);
      _activeTab = btn.dataset.tab;
      panel.querySelectorAll(".tab-btn").forEach(b => {
        const active = b.dataset.tab === _activeTab;
        b.style.background = active ? "var(--ui-accent-soft)" : "transparent";
        b.style.color       = active ? "var(--ui-accent)"   : "var(--ui-text-muted)";
        b.style.fontWeight  = active ? "700"        : "400";
      });
      document.getElementById("tab-content").innerHTML = tabContent(_activeTab, _panelDraft ?? draft);
      const printDocumentsButton = panel.querySelector("#panel-print-documents");
      if (printDocumentsButton) {
        printDocumentsButton.style.display = _activeTab === "documents" ? "inline-flex" : "none";
      }
      attachTabEvents(emp);
      updateTabCounts();
    });
  });

  if (!panel.dataset.sectionUiBound) {
    panel.addEventListener("click", handlePanelUiClick);
    panel.addEventListener("keydown", event => {
      if (event.key === "Escape") closeEmployeeMenus();
      if (event.target.matches?.(".emp-zone-input") && (event.key === "Enter" || event.key === ",")) {
        event.preventDefault();
        addZonesFromInput(event.target);
      }
    });
    panel.addEventListener("focusout", event => {
      if (event.target.matches?.(".emp-zone-input")) addZonesFromInput(event.target);
    });
    panel.dataset.sectionUiBound = "1";
  }
  bindHeaderPhoto(emp);
  attachTabEvents(emp);
  updateTabCounts();
  panel.addEventListener("input", markPanelDirty);
  panel.addEventListener("input", refreshMissing);
  panel.addEventListener("change", onRowFieldChange);
  panel.addEventListener("input", event => { if (event.target.closest?.(".emp-row")) refreshRowWarnings(); });
  panel.addEventListener("change", refreshMissing);
  panel.addEventListener("change", markPanelDirty);
  bindNameFields(panel);
  wirePanelAddress(panel);

  panel.querySelector("#panel-close").addEventListener("click",  () => closePanel());
  panel.querySelector("#panel-cancel").addEventListener("click", () => closePanel());
  panel.querySelector("#panel-print-documents")?.addEventListener("click", () => {
    collectVisiblePanelFields(panel);
    openDocumentsPrintDialog(_panelDraft ?? emp);
  });

  // Save
  panel.querySelector("#panel-save")?.addEventListener("click", async () => {
    collectVisiblePanelFields(panel);
    const g = id => _panelDraft?.[id] ?? null;

    const data = {
      full_name:             g("full_name") || "",
      mother_name:           g("mother_name"),
      father_birthplace:     g("father_birthplace"),
      father_birthdate:      g("father_birthdate"),
      mother_birthplace:     g("mother_birthplace"),
      mother_birthdate:      g("mother_birthdate"),
      gender:                g("gender"),
      birthdate:             g("birthdate"),
      birthplace:            g("birthplace"),
      marital_status:        g("marital_status"),
      blood_type:            g("blood_type"),
      employee_number:       g("employee_number"),
      workplace:             _companyConfig?.company_name ?? g("workplace"),
      job_title:             g("job_title"),
      job_grade:             g("job_grade"),
      job_step:              g("job_step"),
      appointment_date:      g("appointment_date"),
      hire_date:             g("hire_date"),
      contract_type:         g("contract_type"),
      work_schedule:         g("work_schedule"),
      work_type_notes:       g("work_type_notes"),
      department:            fixedDepartment(_panelDraft),
      division:              _companyConfig?.division_name ?? g("division"),
      phone:                 g("phone"),
      email:                 g("email"),
      education_level:       g("education_level"),
      specialization:        g("specialization"),
      graduation_year:       g("graduation_year"),
      civil_id:              g("civil_id"),
      civil_id_issuer:       g("civil_id_issuer"),
      civil_id_issue_date:   g("civil_id_issue_date"),
      civil_id_expiry_date:  g("civil_id_expiry_date"),
      civil_id_birthplace:   g("birthplace"),
      civil_id_birthdate:    g("birthdate"),
      civil_id_family_number:g("civil_id_family_number"),
      residence_card_no:     g("residence_card_no"),
      residence_card_issuer: g("residence_card_issuer"),
      residence_card_issue_date:g("residence_card_issue_date"),
      residence_head_name:   g("residence_head_name"),
      residence_form_no:     g("residence_form_no"),
      residence_address:     g("residence_address"),
      residence_address_parts: g("residence_address_parts"),
      ration_card_no:        g("ration_card_no"),
      ration_center_name:    g("ration_center_name"),
      // Preserve legacy ration-card values that are no longer editable in the form.
      ration_center_no:      g("ration_center_no"),
      ration_card_date:      g("ration_card_date"),
      passport_no:           g("passport_no"),
      passport_type:         g("passport_type"),
      passport_name:         g("passport_name"),
      name_parts:            g("name_parts") || {},
      passport_issue_date:   g("passport_issue_date"),
      passport_expiry_date:  g("passport_expiry_date"),
      airport_badge_no:      g("airport_badge_no"),
      airport_badge_issue_date:g("airport_badge_issue_date"),
      airport_badge_expiry:  g("airport_badge_expiry"),
      airport_badge_zones:   g("airport_badge_zones"),
      ministry_badge_no:     g("ministry_badge_no"),
      ministry_badge_issue_date:g("ministry_badge_issue_date"),
      ministry_badge_expiry: g("ministry_badge_expiry"),
      // Preserve the legacy combined value while saving the new separate fields.
      vehicles:               g("vehicles") || "[]",
      spouse_name:           g("spouse_name"),
      spouse_mother_name:    g("spouse_mother_name"),
      spouse_birthdate:      g("spouse_birthdate"),
      marriage_date:         g("marriage_date"),
      spouses:               g("spouses") || "[]",
      family_members:        g("family_members") || "[]",
      notes:                 g("notes"),
      is_active:             g("is_active") === 0 ? 0 : 1,
    };

    const closeAfter = _closeAfterSave;
    const afterSave = _afterSave;
    _closeAfterSave = false;
    _afterSave = null;
    if (!data.full_name) { showToast("الاسم الكامل مطلوب", "error"); return; }
    data.spouses = withoutEmptyRows(data.spouses);
    data.family_members = withoutEmptyRows(data.family_members);
    data.vehicles = withoutEmptyRows(data.vehicles);
    const spouseConfig = spouseSectionConfig(_panelDraft);
    const spouseLimit = spouseConfig && spouseLimitText(parseJsonList(_panelDraft.spouses).length, spouseConfig);
    if (spouseLimit) {
      showToast(spouseLimit, "error");
      if (_activeTab !== "family") panel.querySelector('.tab-btn[data-tab="family"]')?.click();
      return;
    }
    try {
      let saved;
      if (isNew) {
        saved = await api.createEmployee(data);
        showToast("تم إضافة الموظف بنجاح");
      } else {
        saved = await api.updateEmployee(emp.id, data);
        showToast("تم تحديث بيانات الموظف");
      }
      _employees = await api.listEmployees();
      renderTable();
      const id = saved?.id ?? emp?.id;
      const fresh = _employees.find(e => e.id === id);
      if (closeAfter || !fresh) { closePanel(true); return; }
      // Stay on the same employee and tab, with the same sections open.
      openPanel(fresh, _activeTab, _sectionState);
      if (afterSave) await afterSave();
    } catch (err) { showToast(errorText(err, "خطأ في الحفظ"), "error"); }
  });

  // Delete
  panel.querySelector("#panel-delete")?.addEventListener("click", async () => {
    if (!(await confirmAction(`تأكيد حذف الموظف "${emp.full_name}"؟`))) return;
    try {
      await api.deleteEmployee(emp.id);
      showToast("تم حذف الموظف");
      _employees = await api.listEmployees();
      renderTable();
      closePanel(true);
    } catch (err) { showToast(errorText(err, "خطأ"), "error"); }
  });
  applyEmployeePermissions(panel, isNew);
}

function applyEmployeePermissions(panel, isNew) {
  if (!can(_currentUser, isNew ? "employees.create" : "employees.edit")) {
    panel.querySelector("#panel-save")?.remove();
    panel.querySelectorAll("input,select,textarea").forEach(field => { field.disabled = true; });
    panel.querySelectorAll("#btn-add-spouse,#btn-add-member,#btn-add-vehicle,.btn-remove-spouse,.btn-remove-member,.btn-remove-vehicle").forEach(el => el.remove());
  }
  if (!can(_currentUser, "employees.delete")) {
    panel.querySelector("#panel-delete")?.remove();
  }
  if (!can(_currentUser, "documents.delete")) {
    // Removing a row deletes its images, which only «مسؤول» may do (Rust refuses it too).
    panel.querySelectorAll(".spouse-row, .family-row, .vehicle-row").forEach(row => {
      const button = row.querySelector(".btn-remove-spouse, .btn-remove-member, .btn-remove-vehicle");
      if (button && rowHasFiles(row)) {
        button.disabled = true;
        button.title = "له مرفقات: حذفه يحتاج إلى «مسؤول»";
      }
    });
  }
  if (isNew || !can(_currentUser, "documents.delete")) {
    panel.querySelectorAll(".btn-delete-sided-card,.btn-delete-passport,.btn-delete-ration-card,.btn-delete-family-card,.btn-delete-spouse-card,.btn-delete-vehicle-annual").forEach(el => el.remove());
  }
  if (!can(_currentUser, "documents.upload") || !can(_currentUser, isNew ? "employees.create" : "employees.edit")) {
    panel.querySelectorAll(".btn-save-then-upload").forEach(el => el.remove());
  }
  if (isNew || !can(_currentUser, "documents.upload")) {
    panel.querySelectorAll(".btn-upload-sided-card,#btn-upload-passport,#btn-upload-ration-card,.btn-upload-family-card,.btn-upload-spouse-card").forEach(el => el.remove());
  }
  if (isNew || !can(_currentUser, isNew ? "employees.create" : "employees.edit")) {
    panel.querySelector("#btn-upload-photo")?.remove();
  }
  if (!can(_currentUser, "documents.print")) panel.querySelector("#panel-print-documents")?.remove();
  panel.querySelectorAll(".emp-tile-menu").forEach(menu => {
    if (!menu.querySelector("button")) { menu.closest(".emp-tile")?.querySelector(".emp-tile-more")?.remove(); menu.remove(); }
  });
  const avatarMenu = panel.querySelector(".emp-avatar-menu");
  if (avatarMenu && !avatarMenu.querySelector("button")) {
    avatarMenu.remove();
    const avatar = panel.querySelector("#emp-avatar-btn");
    if (avatar) { avatar.disabled = true; avatar.querySelector(".emp-avatar-edit")?.remove(); }
  }
}

const _documentsViewLogged = new Set();

function attachTabEvents(emp) {
  const panel = document.getElementById("emp-panel");
  if (!panel) return;

  if (_activeTab === "documents" && emp) {
    // Recorded once per employee and sign-in, not on every return to the tab.
    if (!_documentsViewLogged.has(emp.id)) {
      _documentsViewLogged.add(emp.id);
      api.auditDocumentView(emp.id, "employee_documents").catch(() => {});
    }
    bindAttachmentDownloadButtons(document.getElementById("tab-content"));
    panel.querySelectorAll(".btn-upload-sided-card").forEach(btn => {
      btn.addEventListener("click", async () => {
        try {
          collectVisiblePanelFields(panel);
          const cardType = btn.dataset.cardType;
          const cardName = {
            residence: "بطاقة السكن",
            airport: "باج دخول مطار بغداد",
            ministry: "هوية وزارة النقل",
          }[cardType] ?? "البطاقة الوطنية";
          const selected = await open({
            multiple: false,
            filters: [{ name: `ملفات ${cardName}`, extensions: DOCUMENT_EXTENSIONS }],
          });
          if (!selected) return;
          if (!(await confirmAction(`تأكيد رفع ${btn.dataset.side === "front" ? "الوجه الأمامي" : "الوجه الخلفي"} لـ${cardName}؟`))) return;
          if (cardType === "residence") await api.uploadResidenceCardAttachment(emp.id, btn.dataset.side, selected);
          else if (cardType === "airport") await api.uploadAirportBadgeAttachment(emp.id, btn.dataset.side, selected);
          else if (cardType === "ministry") await api.uploadMinistryBadgeAttachment(emp.id, btn.dataset.side, selected);
          else await api.uploadNationalCardAttachment(emp.id, btn.dataset.side, selected);
          showToast(`تم رفع مرفق ${cardName}`);
          await refreshDocumentAttachments(emp.id);
          const readTarget = { national: "employee", airport: "employee:airport_badge", ministry: "employee:ministry_badge", residence: "employee:residence_card" }[cardType];
          const prefix = { national: "civil_id", airport: "airport_badge", ministry: "ministry_badge", residence: "residence_card" }[cardType];
          if (readTarget) await readUploadedFields(readTarget, _panelDraft?.[`${prefix}_${btn.dataset.side}_path`], _panelDraft?.[`${prefix}_${btn.dataset.side}_full_path`], `${cardName}، ${btn.dataset.side === "front" ? "الوجه الأمامي" : "الوجه الخلفي"}`);
        } catch (err) { showToast(errorText(err, "خطأ في الرفع"), "error"); }
      });
    });

    panel.querySelectorAll(".btn-delete-sided-card").forEach(btn => {
      btn.addEventListener("click", async () => {
        const cardType = btn.dataset.cardType;
        const cardName = {
          residence: "بطاقة السكن",
          airport: "باج دخول مطار بغداد",
          ministry: "هوية وزارة النقل",
        }[cardType] ?? "البطاقة الوطنية";
        if (!(await confirmAction(`تأكيد حذف مرفق ${cardName}؟`))) return;
        try {
          collectVisiblePanelFields(panel);
          if (cardType === "residence") await api.deleteResidenceCardAttachment(emp.id, btn.dataset.side);
          else if (cardType === "airport") await api.deleteAirportBadgeAttachment(emp.id, btn.dataset.side);
          else if (cardType === "ministry") await api.deleteMinistryBadgeAttachment(emp.id, btn.dataset.side);
          else await api.deleteNationalCardAttachment(emp.id, btn.dataset.side);
          showToast(`تم حذف مرفق ${cardName}`);
          await refreshDocumentAttachments(emp.id);
        } catch (err) { showToast(errorText(err, "خطأ في الحذف"), "error"); }
      });
    });

    panel.querySelector("#btn-upload-passport")?.addEventListener("click", async () => {
      try {
        collectVisiblePanelFields(panel);
        const selected = await open({
          multiple: false,
          filters: [{ name: "نسخة جواز السفر", extensions: DOCUMENT_EXTENSIONS }],
        });
        if (!selected) return;
        if (!(await confirmAction("تأكيد رفع نسخة جواز السفر؟"))) return;
        await api.uploadPassportAttachment(emp.id, selected);
        showToast("تم رفع نسخة جواز السفر");
        await refreshDocumentAttachments(emp.id);
        const passportPaths = parseJsonList(_panelDraft?.passport_attachment_paths);
        const passportIndex = passportPaths.length - 1;
        await readUploadedFields("employee", passportPaths[passportIndex], _panelDraft?.passport_attachment_full_paths?.[passportIndex], "جواز السفر");
      } catch (err) { showToast(errorText(err, "خطأ في الرفع"), "error"); }
    });

    panel.querySelectorAll(".btn-delete-passport").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!(await confirmAction("تأكيد حذف مرفق جواز السفر؟"))) return;
        try {
          collectVisiblePanelFields(panel);
          await api.deletePassportAttachment(emp.id, btn.dataset.path);
          showToast("تم حذف مرفق جواز السفر");
          await refreshDocumentAttachments(emp.id);
        } catch (err) { showToast(errorText(err, "خطأ في الحذف"), "error"); }
      });
    });

    panel.querySelector("#btn-upload-ration-card")?.addEventListener("click", async () => {
      try {
        collectVisiblePanelFields(panel);
        const selected = await open({
          multiple: false,
          filters: [{ name: "نسخة البطاقة التموينية", extensions: DOCUMENT_EXTENSIONS }],
        });
        if (!selected) return;
        if (!(await confirmAction("تأكيد رفع نسخة البطاقة التموينية؟"))) return;
        await api.uploadRationCardAttachment(emp.id, selected);
        showToast("تم رفع نسخة البطاقة التموينية");
        await refreshDocumentAttachments(emp.id);
        const rationPaths = parseJsonList(_panelDraft?.ration_card_attachment_paths);
        const rationIndex = rationPaths.length - 1;
        await readUploadedFields("employee:ration_card", rationPaths[rationIndex], _panelDraft?.ration_card_attachment_full_paths?.[rationIndex], "البطاقة التموينية");
      } catch (err) { showToast(errorText(err, "خطأ في الرفع"), "error"); }
    });

    panel.querySelectorAll(".btn-delete-ration-card").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!(await confirmAction("تأكيد حذف مرفق البطاقة التموينية؟"))) return;
        try {
          collectVisiblePanelFields(panel);
          await api.deleteRationCardAttachment(emp.id, btn.dataset.path);
          showToast("تم حذف مرفق البطاقة التموينية");
          await refreshDocumentAttachments(emp.id);
        } catch (err) { showToast(errorText(err, "خطأ في الحذف"), "error"); }
      });
    });
  }

  // Family tab events
  if (_activeTab === "family") {
    // From the draft: unsaved changes made before switching tabs stay in the form.
    renderSpouseList(_panelDraft ?? emp);
    panel.querySelector("#btn-add-spouse")?.addEventListener("click", () => {
      const config = spouseSectionConfig(_panelDraft ?? emp);
      if (!config) return;
      const count = panel.querySelectorAll(".spouse-row").length;
      if (count >= config.max) {
        showToast(`يمكن إضافة ${config.max} ${config.itemLabel}${config.max > 1 ? " كحد أقصى" : " فقط"}`, "error");
        return;
      }
      markPanelDirty();
      addSpouseRow(config);
    });
    renderFamilyList(_panelDraft ?? emp);
    refreshRowWarnings();
    bindAttachmentDownloadButtons(document.getElementById("tab-content"));
    panel.querySelector("#btn-add-member")?.addEventListener("click", () => {
      markPanelDirty();
      addFamilyRow();
    });
  }

  if (_activeTab === "vehicle") {
    renderVehicleList(_panelDraft ?? emp);
    refreshRowWarnings();
    bindAttachmentDownloadButtons(document.getElementById("tab-content"));
    panel.querySelector("#btn-add-vehicle")?.addEventListener("click", () => {
      markPanelDirty();
      addVehicleRow();
    });
  }

  applyEmployeePermissions(panel, !emp);
}

async function refreshDocumentAttachments(employeeId) {
  _employees = await api.listEmployees();
  const updated = _employees.find(e => e.id === employeeId);
  if (!updated) return;
  _panelDraft = {
    ...updated,
    ..._panelDraft,
    photo_path: updated.photo_path,
    photo_full_path: updated.photo_full_path,
    civil_id_front_path: updated.civil_id_front_path,
    civil_id_back_path: updated.civil_id_back_path,
    civil_id_front_full_path: updated.civil_id_front_full_path,
    civil_id_back_full_path: updated.civil_id_back_full_path,
    residence_card_front_path: updated.residence_card_front_path,
    residence_card_back_path: updated.residence_card_back_path,
    residence_card_front_full_path: updated.residence_card_front_full_path,
    residence_card_back_full_path: updated.residence_card_back_full_path,
    airport_badge_front_path: updated.airport_badge_front_path,
    airport_badge_back_path: updated.airport_badge_back_path,
    airport_badge_front_full_path: updated.airport_badge_front_full_path,
    airport_badge_back_full_path: updated.airport_badge_back_full_path,
    ministry_badge_front_path: updated.ministry_badge_front_path,
    ministry_badge_back_path: updated.ministry_badge_back_path,
    ministry_badge_front_full_path: updated.ministry_badge_front_full_path,
    ministry_badge_back_full_path: updated.ministry_badge_back_full_path,
    passport_attachment_paths: updated.passport_attachment_paths,
    passport_attachment_full_paths: updated.passport_attachment_full_paths,
    ration_card_attachment_paths: updated.ration_card_attachment_paths,
    ration_card_attachment_full_paths: updated.ration_card_attachment_full_paths,
  };
  const photoHolder = document.getElementById("emp-panel-photo");
  if (photoHolder) {
    photoHolder.innerHTML = headerPhotoHtml(_panelDraft);
    bindHeaderPhoto(updated);
  }
  if (_activeTab === "documents") {
    document.getElementById("tab-content").innerHTML = tabContent("documents", _panelDraft);
    attachTabEvents(updated);
  } else {
    applyEmployeePermissions(document.getElementById("emp-panel"), false);
  }
  updateTabCounts();
}

async function refreshFamilyAttachments(employeeId) {
  _employees = await api.listEmployees();
  const updated = _employees.find(e => e.id === employeeId);
  if (!updated) return;
  _panelDraft = {
    ...updated,
    ..._panelDraft,
    family_members: updated.family_members,
  };
  document.getElementById("tab-content").innerHTML = tabContent("family", _panelDraft);
  attachTabEvents(updated);
}

async function refreshSpouseAttachments(employeeId) {
  _employees = await api.listEmployees();
  const updated = _employees.find(e => e.id === employeeId);
  if (!updated) return;
  _panelDraft = {
    ...updated,
    ..._panelDraft,
    spouses: updated.spouses,
  };
  document.getElementById("tab-content").innerHTML = tabContent("family", _panelDraft);
  attachTabEvents(updated);
}

function spouseListFromEmployee(emp) {
  const config = spouseSectionConfig(emp);
  if (!config) return [];
  let spouses = [];
  try { spouses = JSON.parse(emp?.spouses ?? "[]"); } catch {}
  if (spouses.length === 0 && (emp?.spouse_name || emp?.spouse_mother_name || emp?.spouse_birthdate || emp?.marriage_date)) {
    spouses = [{
      name: emp?.spouse_name ?? "",
      mother_name: emp?.spouse_mother_name ?? "",
      birthdate: emp?.spouse_birthdate ?? "",
      marriage_date: emp?.marriage_date ?? "",
      gender: config.defaultGender,
    }];
  }
  return spouses;
}

/** The spouse section allows `config.max` records (one husband, up to four wives). When the
 *  gender was changed with more on file, say so above the list; saving is refused until fixed. */
function spouseLimitText(count, config) {
  if (count <= config.max) return "";
  return config.max === 1
    ? `للموظفة زوج واحد فقط، والمسجَّل هنا ${count}. احذف السجل الزائد ثم احفظ.`
    : `لا يمكن تسجيل أكثر من ${config.max} زوجات، والمسجَّل هنا ${count}. احذف الزائد ثم احفظ.`;
}

function refreshSpouseLimitNote(container, config) {
  const count = container.querySelectorAll(".spouse-row").length;
  let note = container.parentElement?.querySelector(".spouse-limit");
  const message = spouseLimitText(count, config);
  if (!message) { note?.remove(); return; }
  if (!note) {
    note = document.createElement("p");
    note.className = "emp-row-warning spouse-limit";
    container.before(note);
  }
  note.textContent = message;
}

/** «حذف علي أحمد؟ …»: names the row being removed and says when it takes effect. */
async function confirmRowRemoval(row, fallback, hasFiles) {
  const name = rowSummaryFromInputs(row).split(" · ").find(part => part && part !== "بدون اسم" && part !== "مركبة بدون بيانات");
  const what = name ? `«${name}»` : fallback;
  const files = hasFiles ? " مع صور مرفقاته" : "";
  return confirmAction(`حذف ${what}؟ يُحذف نهائيًا${files} عند الضغط على «حفظ».`);
}

/** After a row is removed: the saved rows are numbered again by position («فرد رقم 2» becomes
 *  «فرد رقم 1»), and the «none» line comes back when the list is empty. */
function afterRowRemoved(container, emptyHtml = "") {
  let position = 0;
  container.querySelectorAll(".emp-row").forEach(row => {
    position += 1;
    const title = row.querySelector(".emp-row-title");
    if (title && / رقم \d+$/.test(title.textContent)) title.textContent = title.textContent.replace(/ رقم \d+$/, ` رقم ${position}`);
  });
  if (!position && emptyHtml && !container.querySelector(".list-empty")) container.innerHTML = emptyHtml;
}

const FAMILY_EMPTY = `<p class="family-empty list-empty" style="font-size:13px;color:var(--ui-text-faint);padding:8px 0">لا يوجد أفراد مسجلون</p>`;
const VEHICLE_EMPTY = `<p class="vehicle-empty list-empty" style="font-size:13px;color:var(--ui-text-faint);padding:8px 0">لا توجد مركبات مسجلة</p>`;

// ── Checks on spouse / family / vehicle rows ─────────────────────────────────
// Shown under the row as a warning; saving is not blocked (the card may really say so).
const MALE_RELATIONS = ["ابن", "أب", "أخ"];
const FEMALE_RELATIONS = ["ابنة", "أم", "أخت"];

function rowWarnings(row, { employeeBirthdate, civilCounts, plateCounts, today }) {
  const value = selector => row.querySelector(selector)?.value?.trim() || "";
  const warnings = [];
  const vehicle = row.classList.contains("vehicle-row");
  const prefix = row.classList.contains("spouse-row") ? "sp" : "fm";
  const issue = value(vehicle ? ".vehicle-issue-date" : `.${prefix}-issue`);
  const expiry = value(vehicle ? ".vehicle-expiry-date" : `.${prefix}-expiry`);
  if (issue && expiry && expiry < issue) warnings.push("تاريخ النفاذ قبل تاريخ الإصدار");
  if (vehicle) {
    const year = value(".vehicle-model-year");
    if (year && (!/^\d{4}$/.test(year) || Number(year) < 1950 || Number(year) > today.getFullYear() + 1)) warnings.push("سنة الصنع أربعة أرقام، مثل 2019");
    const plate = value(".vehicle-plate").replace(/\s+/g, " ");
    if (plate && plateCounts.get(plate) > 1) warnings.push("رقم اللوحة مكرر في مركبة أخرى");
    return warnings;
  }
  const civil = value(`.${prefix}-civil`);
  if (civil && !/^\d{12}$/.test(civil)) warnings.push("الرقم الوطني 12 رقمًا");
  else if (civil && civilCounts.get(civil) > 1) warnings.push("الرقم الوطني مكرر في سجل آخر");
  const birthdate = value(`.${prefix}-birthdate`);
  const todayIso = localIso(today);
  if (birthdate && birthdate > todayIso) warnings.push("تاريخ الولادة في المستقبل");
  if (prefix === "fm") {
    const relation = value(".fm-relation");
    const gender = value(".fm-gender");
    if (gender && ((MALE_RELATIONS.includes(relation) && gender !== "ذكر") || (FEMALE_RELATIONS.includes(relation) && gender !== "أنثى"))) {
      warnings.push(`صلة القرابة «${relation}» لا توافق الجنس «${gender}»`);
    }
    if (["ابن", "ابنة"].includes(relation) && birthdate && employeeBirthdate && birthdate <= employeeBirthdate) {
      warnings.push("تاريخ ولادة الابن قبل تاريخ ولادة الموظف");
    }
  }
  return warnings;
}

function localIso(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** Puts each row's warnings under it, and «تنبيه» in its heading while it is folded. */
function refreshRowWarnings() {
  const content = document.getElementById("tab-content");
  if (!content) return;
  const rows = [...content.querySelectorAll(".spouse-row, .family-row, .vehicle-row")];
  if (!rows.length) return;
  const count = (selector, normalize = v => v) => {
    const counts = new Map();
    content.querySelectorAll(selector).forEach(input => {
      const v = normalize(input.value.trim());
      if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
    });
    return counts;
  };
  const context = {
    employeeBirthdate: document.querySelector("#emp-panel #f-birthdate")?.value || _panelDraft?.birthdate || "",
    civilCounts: count(".sp-civil, .fm-civil"),
    plateCounts: count(".vehicle-plate", v => v.replace(/\s+/g, " ")),
    today: new Date(),
  };
  rows.forEach(row => {
    const warnings = rowWarnings(row, context);
    let box = row.querySelector(":scope > .row-check");
    let flag = row.querySelector(":scope > .emp-row-head .row-check-flag");
    if (!warnings.length) { box?.remove(); flag?.remove(); return; }
    if (!box) {
      box = document.createElement("p");
      box.className = "emp-row-warning row-check";
      box.style.gridColumn = "span 2";
      row.appendChild(box);
    }
    box.textContent = `تحقق: ${warnings.join(" · ")}`;
    if (!flag) {
      flag = document.createElement("span");
      flag.className = "emp-pill warn row-check-flag";
      flag.textContent = "تحقق";
      row.querySelector(":scope > .emp-row-head .emp-row-summary")?.after(flag);
    }
    flag.title = warnings.join("، ");
  });
}

/** A row the user added and left completely empty (no value, no attachment) is not saved. */
function withoutEmptyRows(json) {
  const rows = parseJsonList(json);
  const filled = rows.filter(row => Object.entries(row ?? {}).some(([key, value]) => {
    if (key === "gender" || key === "name_parts") return false; // a spouse row starts with a gender
    return String(value ?? "").trim() !== "";
  }));
  return JSON.stringify(filled);
}

/** Inside a family / vehicle row: «ابن» picks «ذكر» (and so on), then the row checks run again. */
function onRowFieldChange(event) {
  if (event.target.id === "f-gender") {
    document.querySelectorAll("#f-marital_status option").forEach(option => {
      option.textContent = option.value ? maritalLabel(option.value, event.target.value) : "—";
    });
  }
  const row = event.target.closest?.(".emp-row");
  if (!row) return;
  if (event.target.matches(".fm-relation")) {
    const gender = row.querySelector(".fm-gender");
    const relation = event.target.value;
    const wanted = MALE_RELATIONS.includes(relation) ? "ذكر" : FEMALE_RELATIONS.includes(relation) ? "أنثى" : "";
    if (gender && wanted) gender.value = wanted;
  }
  refreshRowWarnings();
}

function rowHasFiles(row) {
  return Object.entries(row.dataset).some(([key, value]) => /(Front|Back)Path$/.test(key) && !/FullPath$/.test(key) && value);
}

function renderSpouseList(emp) {
  const container = document.getElementById("spouse-list");
  if (!container) return;
  const config = spouseSectionConfig(emp);
  if (!config) return;
  const spouses = spouseListFromEmployee(emp);
  container.innerHTML = spouses.map((spouse, index) => spouseRowHtml(spouse, index, config)).join("") ||
    `<p class="spouse-empty" style="font-size:13px;color:var(--ui-text-faint);padding:8px 0">${config.emptyLabel}</p>`;
  refreshSpouseLimitNote(container, config);
  const addButton = document.getElementById("btn-add-spouse");
  if (addButton) {
    addButton.style.display = spouses.length >= config.max ? "none" : "inline-flex";
  }

  container.querySelectorAll(".btn-remove-spouse").forEach(btn => {
    btn.addEventListener("click", async () => {
      const row = btn.closest(".spouse-row");
      if (!(await confirmRowRemoval(row, `هذا ${config.itemLabel}`, rowHasFiles(row)))) return;
      markPanelDirty();
      row.remove();
      afterRowRemoved(container);
      refreshSpouseLimitNote(container, config);
      const addButton = document.getElementById("btn-add-spouse");
      if (addButton && container.querySelectorAll(".spouse-row").length < config.max) {
        addButton.style.display = "inline-flex";
      }
    });
  });

  container.querySelectorAll(".btn-upload-spouse-card").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (_panelDirty) {
        await saveThenUpload(btn);
        return;
      }
      try {
        const selected = await open({
          multiple: false,
          filters: [{ name: "مرفق البطاقة الوطنية", extensions: DOCUMENT_EXTENSIONS }],
        });
        if (!selected) return;
        const sideName = btn.dataset.side === "front" ? "الوجه الأمامي" : "الوجه الخلفي";
        if (!(await confirmAction(`تأكيد رفع ${sideName} للبطاقة الوطنية للـ${config.itemLabel}؟`))) return;
        await api.uploadSpouseNationalCardAttachment(_panelDraft.id, Number(btn.dataset.spouseIndex), btn.dataset.side, selected);
        showToast(`تم رفع مرفق البطاقة الوطنية للـ${config.itemLabel}`);
        await refreshSpouseAttachments(_panelDraft.id);
        const spouse = ocrTarget(`spouse:${btn.dataset.spouseIndex}`).record;
        await readUploadedFields(`spouse:${btn.dataset.spouseIndex}`, spouse?.[`national_card_${btn.dataset.side}_path`], spouse?.[`national_card_${btn.dataset.side}_full_path`], `البطاقة الوطنية للـ${config.itemLabel}`);
      } catch (err) { showToast(errorText(err, "خطأ في رفع المرفق"), "error"); }
    });
  });

  container.querySelectorAll(".btn-delete-spouse-card").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (_panelDirty) {
        showToast("احفظ تعديلات الزوجات قبل حذف المرفقات", "error");
        return;
      }
      const sideName = btn.dataset.side === "front" ? "الوجه الأمامي" : "الوجه الخلفي";
      if (!(await confirmAction(`تأكيد حذف ${sideName} للبطاقة الوطنية للـ${config.itemLabel}؟`))) return;
      try {
        await api.deleteSpouseNationalCardAttachment(_panelDraft.id, Number(btn.dataset.spouseIndex), btn.dataset.side);
        showToast(`تم حذف مرفق البطاقة الوطنية للـ${config.itemLabel}`);
        await refreshSpouseAttachments(_panelDraft.id);
      } catch (err) { showToast(errorText(err, "خطأ في حذف المرفق"), "error"); }
    });
  });
}

function spouseAttachmentCard(label, side, spouse, spouseIndex, maxSpouses = 4) {
  const path = side === "front" ? spouse?.national_card_front_path : spouse?.national_card_back_path;
  const fullPath = side === "front" ? spouse?.national_card_front_full_path : spouse?.national_card_back_full_path;
  const canUpload = Boolean(_panelDraft?.id) && !_panelDirty && Number.isInteger(spouseIndex) && spouseIndex < maxSpouses;
  const attrs = `data-spouse-index="${spouseIndex}" data-side="${side}"`;
  return attachmentTile({
    label, path, fullPath, canManage: canUpload, read: `spouse:${spouseIndex}`,
    upload: { cls: "btn-upload-spouse-card", attrs },
    saveFirst: `.btn-upload-spouse-card[data-spouse-index="{i}"][data-side="${side}"]`,
    remove: { cls: "btn-delete-spouse-card", attrs },
    lockedNote: "احفظ أولاً",
  });
}

function spouseRowHtml(spouse = {}, index = Date.now(), config = { itemLabel: "زوجة", defaultGender: "أنثى", max: 4 }) {
  const number = typeof index === "number" && index < 100 ? index + 1 : "";
  const existing = typeof index === "number" && index < 100;
  const rowKey = existing ? `row:spouse:${index}` : "";
  const attached = [spouse.national_card_front_path, spouse.national_card_back_path].filter(Boolean).length;
  return `<div class="spouse-row emp-row${rowOpenClass(rowKey, existing)}" data-row-key="${rowKey}" ${rowPathAttrs(spouse, "national_card")}>
    ${rowHead({
      title: `${config.itemLabel} ${number ? `رقم ${number}` : config.itemLabel === "زوج" ? "جديد" : "جديدة"}`,
      summary: personSummary({ name: spouse.name, gender: spouse.gender || config.defaultGender, birthdate: spouse.birthdate }),
      extra: `${cardExpiryPill(spouse)}<span class="emp-pill ${attached === 2 ? "ok" : "none"}">المرفقات ${attached}/2</span>`,
      removeClass: "btn-remove-spouse",
    })}
    <div style="grid-column:span 2">
      <p style="font-size:10px;color:var(--ui-text-faint);margin-bottom:3px">الرقم الوطني</p>
      <input class="input-field sp-civil" dir="ltr" value="${escHtml(spouse.civil_id??"")}"/>
    </div>
    ${recordNameFields("الاسم", "name", spouse)}
    ${recordNameFields("اسم الأم", "mother_name", spouse)}
    <div>
      <p style="font-size:10px;color:var(--ui-text-faint);margin-bottom:3px">الجنس</p>
      <select class="input-field sp-gender">
        ${[["","—"],["ذكر","ذكر"],["أنثى","أنثى"]].map(([value, label]) =>
          `<option value="${value}" ${(spouse.gender || config.defaultGender)===value?"selected":""}>${label}</option>`).join("")}
      </select>
    </div>
    <div>
      <p style="font-size:10px;color:var(--ui-text-faint);margin-bottom:3px">فصيلة الدم</p>
      <select class="input-field sp-blood">
        ${["","A+","A-","B+","B-","AB+","AB-","O+","O-"].map(b =>
          `<option value="${b}" ${spouse.blood_type===b?"selected":""}>${b ? `${b}\u200E` : ""}</option>`).join("")}
      </select>
    </div>
    <div>
      <p style="font-size:10px;color:var(--ui-text-faint);margin-bottom:3px">جهة الإصدار</p>
      <input class="input-field sp-issuer" value="${escHtml(spouse.issuer??"")}"/>
    </div>
    <div>
      <p style="font-size:10px;color:var(--ui-text-faint);margin-bottom:3px">تاريخ الإصدار</p>
      <input class="input-field sp-issue" type="date" value="${spouse.issue_date??""}" />
    </div>
    <div>
      <p style="font-size:10px;color:var(--ui-text-faint);margin-bottom:3px">تاريخ النفاذ</p>
      <input class="input-field sp-expiry" type="date" value="${spouse.expiry_date??""}" />
    </div>
    <div>
      <p style="font-size:10px;color:var(--ui-text-faint);margin-bottom:3px">محل الولادة</p>
      <input class="input-field sp-birthplace" value="${escHtml(spouse.birthplace??"")}"/>
    </div>
    <div>
      <p style="font-size:10px;color:var(--ui-text-faint);margin-bottom:3px">تاريخ الولادة</p>
      <input class="input-field sp-birthdate" type="date" value="${spouse.birthdate??""}" />
    </div>
    <div style="grid-column:span 2">
      <p style="font-size:10px;color:var(--ui-text-faint);margin-bottom:3px">تاريخ الزواج</p>
      <input class="input-field sp-marriage" type="date" value="${spouse.marriage_date??""}" />
    </div>
    <div style="grid-column:span 2">
      <p class="emp-att-title">مرفقات البطاقة الوطنية</p>
      <div class="emp-tiles">
        ${spouseAttachmentCard("الوجه الأمامي", "front", spouse, index, config.max)}
        ${spouseAttachmentCard("الوجه الخلفي", "back", spouse, index, config.max)}
      </div>
    </div>
  </div>`;
}

function addSpouseRow(config = spouseSectionConfig(_panelDraft ?? {}) ?? { defaultGender: "أنثى", itemLabel: "زوجة", max: 4 }) {
  const container = document.getElementById("spouse-list");
  if (!container) return;
  container.querySelector(".spouse-empty")?.remove();
  const div = document.createElement("div");
  div.innerHTML = spouseRowHtml({ gender: config.defaultGender }, container.querySelectorAll(".spouse-row").length, config);
  const row = div.firstElementChild;
  row.classList.remove("collapsed");
  row.querySelector(".btn-remove-spouse").addEventListener("click", async () => {
    if (!(await confirmRowRemoval(row, `هذا ${config.itemLabel}`, false))) return;
    markPanelDirty();
    row.remove();
    afterRowRemoved(container);
    refreshSpouseLimitNote(container, config);
    const addButton = document.getElementById("btn-add-spouse");
    if (addButton && container.querySelectorAll(".spouse-row").length < config.max) {
      addButton.style.display = "inline-flex";
    }
  });
  container.appendChild(row);
  const addButton = document.getElementById("btn-add-spouse");
  if (addButton && container.querySelectorAll(".spouse-row").length >= config.max) {
    addButton.style.display = "none";
  }
}

function renderFamilyList(emp) {
  const container = document.getElementById("family-list");
  if (!container) return;
  let members = [];
  try { members = JSON.parse(emp?.family_members ?? "[]"); } catch {}

  container.innerHTML = members.map((m, i) => familyRowHtml(m, i)).join("") || FAMILY_EMPTY;

  container.querySelectorAll(".btn-remove-member").forEach(btn => {
    btn.addEventListener("click", async () => {
      const row = btn.closest(".family-row");
      if (!(await confirmRowRemoval(row, "هذا الفرد", rowHasFiles(row)))) return;
      markPanelDirty();
      row.remove();
      afterRowRemoved(container, FAMILY_EMPTY);
    });
  });

  container.querySelectorAll(".btn-upload-family-card").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (_panelDirty) {
        await saveThenUpload(btn);
        return;
      }
      try {
        const selected = await open({
          multiple: false,
          filters: [{ name: "مرفق البطاقة الوطنية", extensions: DOCUMENT_EXTENSIONS }],
        });
        if (!selected) return;
        const sideName = btn.dataset.side === "front" ? "الوجه الأمامي" : "الوجه الخلفي";
        if (!(await confirmAction(`تأكيد رفع ${sideName} للبطاقة الوطنية لفرد الأسرة؟`))) return;
        await api.uploadFamilyNationalCardAttachment(_panelDraft.id, Number(btn.dataset.memberIndex), btn.dataset.side, selected);
        showToast("تم رفع مرفق البطاقة الوطنية لفرد الأسرة");
        await refreshFamilyAttachments(_panelDraft.id);
        const member = ocrTarget(`family:${btn.dataset.memberIndex}`).record;
        await readUploadedFields(`family:${btn.dataset.memberIndex}`, member?.[`national_card_${btn.dataset.side}_path`], member?.[`national_card_${btn.dataset.side}_full_path`], "البطاقة الوطنية لفرد الأسرة");
      } catch (err) { showToast(errorText(err, "خطأ في رفع المرفق"), "error"); }
    });
  });

  container.querySelectorAll(".btn-delete-family-card").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (_panelDirty) {
        showToast("احفظ تعديلات أفراد الأسرة قبل حذف المرفقات", "error");
        return;
      }
      const sideName = btn.dataset.side === "front" ? "الوجه الأمامي" : "الوجه الخلفي";
      if (!(await confirmAction(`تأكيد حذف ${sideName} للبطاقة الوطنية لفرد الأسرة؟`))) return;
      try {
        await api.deleteFamilyNationalCardAttachment(_panelDraft.id, Number(btn.dataset.memberIndex), btn.dataset.side);
        showToast("تم حذف مرفق البطاقة الوطنية لفرد الأسرة");
        await refreshFamilyAttachments(_panelDraft.id);
      } catch (err) { showToast(errorText(err, "خطأ في حذف المرفق"), "error"); }
    });
  });
}

function familyAttachmentCard(label, side, member, memberIndex) {
  const path = side === "front" ? member?.national_card_front_path : member?.national_card_back_path;
  const fullPath = side === "front" ? member?.national_card_front_full_path : member?.national_card_back_full_path;
  const canUpload = Boolean(_panelDraft?.id) && Number.isInteger(memberIndex) && memberIndex < 100;
  const attrs = `data-member-index="${memberIndex}" data-side="${side}"`;
  return attachmentTile({
    label, path, fullPath, canManage: canUpload, read: `family:${memberIndex}`,
    upload: { cls: "btn-upload-family-card", attrs },
    saveFirst: `.btn-upload-family-card[data-member-index="{i}"][data-side="${side}"]`,
    remove: { cls: "btn-delete-family-card", attrs },
    lockedNote: "احفظ أولاً",
  });
}

export const FAMILY_RELATIONS = [["", "—"], ["ابن", "ابن"], ["ابنة", "ابنة"], ["أب", "أب"], ["أم", "أم"], ["أخ", "أخ"], ["أخت", "أخت"], ["أخرى", "أخرى"]];

function familyRowHtml(m = {}, i = Date.now()) {
  const existing = typeof i === "number" && i < 100;
  const rowKey = existing ? `row:family:${i}` : "";
  const attached = [m.national_card_front_path, m.national_card_back_path].filter(Boolean).length;
  return `<div class="family-row emp-row${rowOpenClass(rowKey, existing)}" data-row-key="${rowKey}" ${rowPathAttrs(m, "national_card")}>
    ${rowHead({
      title: existing ? `فرد رقم ${i + 1}` : "فرد جديد",
      summary: [m.relation, personSummary({ name: m.name, gender: m.gender, birthdate: m.birthdate })].filter(Boolean).join(" · "),
      extra: `${cardExpiryPill(m)}<span class="emp-pill ${attached === 2 ? "ok" : "none"}">المرفقات ${attached}/2</span>`,
      removeClass: "btn-remove-member",
    })}
    <div>
      <p style="font-size:10px;color:var(--ui-text-faint);margin-bottom:3px">صلة القرابة</p>
      <select class="input-field fm-relation">
        ${FAMILY_RELATIONS.map(([value, label]) =>
          `<option value="${value}" ${(m.relation ?? "")===value?"selected":""}>${label}</option>`).join("")}
      </select>
    </div>
    <div>
      <p style="font-size:10px;color:var(--ui-text-faint);margin-bottom:3px">الرقم الوطني</p>
      <input class="input-field fm-civil" dir="ltr" value="${escHtml(m.civil_id??"")}"/>
    </div>
    ${recordNameFields("الاسم", "name", m)}
    <div>
      <p style="font-size:10px;color:var(--ui-text-faint);margin-bottom:3px">الجنس</p>
      <select class="input-field fm-gender">
        ${[["","—"],["ذكر","ذكر"],["أنثى","أنثى"]].map(([value, label]) =>
          `<option value="${value}" ${m.gender===value?"selected":""}>${label}</option>`).join("")}
      </select>
    </div>
    <div>
      <p style="font-size:10px;color:var(--ui-text-faint);margin-bottom:3px">فصيلة الدم</p>
      <select class="input-field fm-blood">
        ${["","A+","A-","B+","B-","AB+","AB-","O+","O-"].map(b =>
          `<option value="${b}" ${m.blood_type===b?"selected":""}>${b ? `${b}\u200E` : ""}</option>`).join("")}
      </select>
    </div>
    <div>
      <p style="font-size:10px;color:var(--ui-text-faint);margin-bottom:3px">جهة الإصدار</p>
      <input class="input-field fm-issuer" value="${escHtml(m.issuer??"")}"/>
    </div>
    <div>
      <p style="font-size:10px;color:var(--ui-text-faint);margin-bottom:3px">تاريخ الإصدار</p>
      <input class="input-field fm-issue" type="date" value="${m.issue_date??""}" />
    </div>
    <div>
      <p style="font-size:10px;color:var(--ui-text-faint);margin-bottom:3px">تاريخ النفاذ</p>
      <input class="input-field fm-expiry" type="date" value="${m.expiry_date??""}" />
    </div>
    <div>
      <p style="font-size:10px;color:var(--ui-text-faint);margin-bottom:3px">محل الولادة</p>
      <input class="input-field fm-birthplace" value="${escHtml(m.birthplace??"")}"/>
    </div>
    <div>
      <p style="font-size:10px;color:var(--ui-text-faint);margin-bottom:3px">تاريخ الولادة</p>
      <input class="input-field fm-birthdate" type="date" value="${m.birthdate??""}" />
    </div>
    <div style="grid-column:span 2">
      <p class="emp-att-title">مرفقات البطاقة الوطنية</p>
      <div class="emp-tiles">
        ${familyAttachmentCard("الوجه الأمامي", "front", m, i)}
        ${familyAttachmentCard("الوجه الخلفي", "back", m, i)}
      </div>
    </div>
  </div>`;
}

function addFamilyRow() {
  const container = document.getElementById("family-list");
  if (!container) return;
  // Only the «no members» line: a <p> inside a member row is a field label.
  container.querySelector(".family-empty")?.remove();
  const div = document.createElement("div");
  div.innerHTML = familyRowHtml({}, Date.now());
  const row = div.firstElementChild;
  row.querySelector(".btn-remove-member").addEventListener("click", async () => {
    if (!(await confirmRowRemoval(row, "هذا الفرد", false))) return;
    markPanelDirty();
    row.remove();
    afterRowRemoved(container, FAMILY_EMPTY);
  });
  container.appendChild(row);
}

function renderVehicleList(emp) {
  const container = document.getElementById("vehicle-list");
  if (!container) return;
  let vehicles = [];
  try { vehicles = JSON.parse(emp?.vehicles ?? "[]"); } catch {}

  container.innerHTML = vehicles.map((vehicle, index) => vehicleRowHtml(vehicle, index)).join("") || VEHICLE_EMPTY;

  attachVehicleRemoveEvents(container);
  attachVehicleAnnualEvents(container);
}

function vehicleRowHtml(vehicle = {}, index = Date.now()) {
  const existing = typeof index === "number" && index < 100;
  const rowKey = existing ? `row:vehicle:${index}` : "";
  const status = documentStatus({ values: [vehicle.annual_no], expiry: vehicle.expiry_date, maxDays: alertWindowDays("vehicle"), attached: 0, expected: 0 });
  const annual = vehicle.expiry_date
    ? `<span class="emp-pill ${status.tone}">السنوية: ${["bad", "warn"].includes(status.tone) ? status.label : formatDate(vehicle.expiry_date)}</span>`
    : "";
  const attached = [vehicle.annual_front_path, vehicle.annual_back_path].filter(Boolean).length;
  return `<div class="vehicle-row emp-row${rowOpenClass(rowKey, existing)}" data-row-key="${rowKey}" ${rowPathAttrs(vehicle, "annual")}>
    ${rowHead({
      title: existing ? `مركبة رقم ${index + 1}` : "مركبة جديدة",
      summary: vehicleSummary(vehicle),
      extra: `${annual}${existing ? `<span class="emp-pill ${attached === 2 ? "ok" : "none"}">المرفقات ${attached}/2</span>` : ""}`,
      removeClass: "btn-remove-vehicle",
    })}
    ${vehicleInput("رقم اللوحة", "vehicle-plate", vehicle.plate, "auto")}
    ${vehicleInput("المحافظة", "vehicle-governorate", vehicle.governorate)}
    ${vehicleInput("نوع اللوحة", "vehicle-plate-category", vehicle.plate_category)}
    ${vehicleInput("العلامة التجارية للمركبة", "vehicle-brand", vehicle.brand)}
    ${vehicleInput("نوع المركبة", "vehicle-type", vehicle.type)}
    ${vehicleInput("لون المركبة", "vehicle-color", vehicle.color)}
    ${vehicleInput("سنة الصنع", "vehicle-model-year", vehicle.model_year, true)}
    ${vehicleInput("رقم الشاصي", "vehicle-chassis", vehicle.chassis_no, true)}
    ${vehicleInput("رقم السنوية", "vehicle-annual-no", vehicle.annual_no, true)}
    ${vehicleInput("تاريخ الإصدار", "vehicle-issue-date", vehicle.issue_date, false, true)}
    ${vehicleInput("تاريخ النفاذ", "vehicle-expiry-date", vehicle.expiry_date, false, true)}
    <div style="grid-column:span 2">
      <p class="emp-att-title">مرفقات السنوية</p>
      <div class="emp-tiles">
        ${vehicleAnnualTile("الوجه الأمامي", "front", vehicle, existing ? index : null)}
        ${vehicleAnnualTile("الوجه الخلفي", "back", vehicle, existing ? index : null)}
      </div>
    </div>
  </div>`;
}

function vehicleAnnualTile(label, side, vehicle, vehicleIndex) {
  const attrs = `data-vehicle-index="${vehicleIndex ?? ""}" data-side="${side}"`;
  return attachmentTile({
    label, path: vehicle?.[`annual_${side}_path`], fullPath: vehicle?.[`annual_${side}_full_path`],
    canManage: Boolean(_panelDraft?.id) && !_panelDirty && Number.isInteger(vehicleIndex) && can(_currentUser, "documents.upload"),
    read: Number.isInteger(vehicleIndex) ? `vehicle:${vehicleIndex}` : null,
    upload: { cls: "btn-upload-vehicle-annual", attrs },
    saveFirst: `.btn-upload-vehicle-annual[data-vehicle-index="{i}"][data-side="${side}"]`,
    remove: { cls: "btn-delete-vehicle-annual", attrs },
    lockedNote: "احفظ أولاً",
  });
}

async function refreshVehicleAttachments(employeeId) {
  _employees = await api.listEmployees();
  const updated = _employees.find(e => e.id === employeeId);
  if (!updated) return;
  _panelDraft = { ...updated, ..._panelDraft, vehicles: updated.vehicles };
  document.getElementById("tab-content").innerHTML = tabContent("vehicle", _panelDraft);
  attachTabEvents(updated);
}

function attachVehicleAnnualEvents(container) {
  container.querySelectorAll(".btn-upload-vehicle-annual").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (_panelDirty) {
        await saveThenUpload(btn);
        return;
      }
      try {
        const selected = await open({ multiple: false, filters: [{ name: "مرفق السنوية", extensions: DOCUMENT_EXTENSIONS }] });
        if (!selected) return;
        const sideName = btn.dataset.side === "front" ? "الوجه الأمامي" : "الوجه الخلفي";
        if (!(await confirmAction(`تأكيد رفع ${sideName} لسنوية المركبة؟`))) return;
        const index = Number(btn.dataset.vehicleIndex);
        await api.uploadVehicleAnnualAttachment(_panelDraft.id, index, btn.dataset.side, selected);
        showToast("تم رفع مرفق السنوية");
        await refreshVehicleAttachments(_panelDraft.id);
        const vehicle = ocrTarget(`vehicle:${index}`).record;
        await readUploadedFields(`vehicle:${index}`, vehicle?.[`annual_${btn.dataset.side}_path`], vehicle?.[`annual_${btn.dataset.side}_full_path`], "سنوية المركبة");
      } catch (err) { showToast(errorText(err, "خطأ في رفع المرفق"), "error"); }
    });
  });
  container.querySelectorAll(".btn-delete-vehicle-annual").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (_panelDirty) {
        showToast("احفظ تعديلات المركبات قبل حذف المرفقات", "error");
        return;
      }
      const sideName = btn.dataset.side === "front" ? "الوجه الأمامي" : "الوجه الخلفي";
      if (!(await confirmAction(`تأكيد حذف ${sideName} لسنوية المركبة؟`))) return;
      try {
        await api.deleteVehicleAnnualAttachment(_panelDraft.id, Number(btn.dataset.vehicleIndex), btn.dataset.side);
        showToast("تم حذف مرفق السنوية");
        await refreshVehicleAttachments(_panelDraft.id);
      } catch (err) { showToast(errorText(err, "خطأ في حذف المرفق"), "error"); }
    });
  });
}

function vehicleInput(label, className, value = "", ltr = false, date = false) {
  return `<div>
    <p style="font-size:10px;color:var(--ui-text-faint);margin-bottom:3px">${label}</p>
    <input class="input-field ${className}" type="${date ? "date" : "text"}"
      dir="${ltr === "auto" ? "auto" : ltr ? "ltr" : "rtl"}" value="${date ? (value ?? "") : escHtml(value ?? "")}" />
  </div>`;
}

function attachVehicleRemoveEvents(container) {
  container.querySelectorAll(".btn-remove-vehicle").forEach(button => {
    button.addEventListener("click", async () => {
      const row = button.closest(".vehicle-row");
      const list = row.parentElement;
      if (!(await confirmRowRemoval(row, "هذه المركبة", rowHasFiles(row)))) return;
      markPanelDirty();
      row.remove();
      afterRowRemoved(list, VEHICLE_EMPTY);
    });
  });
}

function addVehicleRow() {
  const container = document.getElementById("vehicle-list");
  if (!container) return;
  container.querySelector(".vehicle-empty")?.remove();
  const wrapper = document.createElement("div");
  wrapper.innerHTML = vehicleRowHtml({}, Date.now());
  const row = wrapper.firstElementChild;
  container.appendChild(row);
  attachVehicleRemoveEvents(row);
}

// ── Reading identity documents into the form ───────────────────────────────
// The values read from a national card or passport image are reviewed by the user and then put
// into the open form (not saved): the user saves the employee record as usual.

const OCR_NAME_PARTS = [["first", "الاسم"], ["father", "اسم الأب"], ["grandfather", "اسم الجد"], ["surname", "اللقب"]];
const OCR_IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "webp"];

function namePartsOf(record) {
  const value = record?.name_parts;
  if (!value) return {};
  if (typeof value === "string") { try { return JSON.parse(value) ?? {}; } catch { return {}; } }
  return { ...value };
}

/** Current parts of a split name; an unsplit name is split by words like the name review does. */
function currentNameParts(record, key, passport = false) {
  const stored = namePartsOf(record)[key];
  if (stored && joinNameParts(stored, passport)) return stored;
  const words = String(record?.[key] ?? "").trim().split(/\s+/).filter(Boolean);
  if (passport) return { given: words.slice(0, -1).join(" ") || words[0] || "", surname: words.length > 1 ? words.at(-1) : "" };
  return { first: words[0] ?? "", father: words[1] ?? "", grandfather: words[2] ?? "", surname: words.slice(3).join(" ") };
}

function ocrTarget(target) {
  const [kind, index] = String(target).split(":");
  if (kind === "employee") return { kind, badge: index ?? null, record: _panelDraft };
  const listKey = kind === "spouse" ? "spouses" : kind === "vehicle" ? "vehicles" : "family_members";
  let list = [];
  try { list = JSON.parse(_panelDraft?.[listKey] ?? "[]"); } catch {}
  if (kind === "spouse" && list.length === 0) list = spouseListFromEmployee(_panelDraft);
  return { kind, index: Number(index), listKey, list, record: list[Number(index)] ?? {} };
}

function ocrRows(result, target) {
  const { kind, badge, record } = ocrTarget(target);
  const read = key => result.fields.find(f => f.key === key);
  const passport = result.document === "passport";
  const rows = [];
  const add = (id, label, key, current, opts = {}) => {
    const field = read(key);
    if (field) rows.push({ id, label, value: field.value, confidence: field.confidence, source: field.source, current: current ?? "", ...opts });
  };
  if (kind === "vehicle") {
    // "11 Z12345" reads left to right, "12345 هـ" right to left: let the text decide.
    add("field:plate", "رقم اللوحة", "plate", record?.plate, { dir: "auto" });
    add("field:governorate", "المحافظة", "governorate", record?.governorate);
    add("field:plate_category", "نوع اللوحة", "plate_category", record?.plate_category);
    add("field:annual_no", "رقم السنوية", "annual_no", record?.annual_no, { ltr: true });
    add("field:brand", "العلامة التجارية للمركبة", "brand", record?.brand);
    add("field:type", "نوع المركبة", "vehicle_type", record?.type);
    add("field:color", "لون المركبة", "color", record?.color);
    add("field:model_year", "سنة الصنع", "year", record?.model_year, { ltr: true });
    add("field:chassis_no", "رقم الشاصي", "chassis_no", record?.chassis_no, { ltr: true });
    add("field:issue_date", "تاريخ الإصدار", "issue_date", record?.issue_date, { date: true });
    add("field:expiry_date", "تاريخ النفاذ", "expiry_date", record?.expiry_date, { date: true });
    return rows;
  }
  if (badge === "ration_card") {
    add("field:ration_card_no", "رقم البطاقة التموينية", "ration_no", record?.ration_card_no, { ltr: true });
    add("field:ration_center_name", "اسم رب الأسرة", "head_name", record?.ration_center_name);
    return rows;
  }
  if (badge === "residence_card") {
    // Old-style residence cards: only the printed serial is readable; the rest is handwritten.
    add("field:residence_card_no", "رقم بطاقة السكن (التسلسل)", "doc_number", record?.residence_card_no, { ltr: true });
    add("field:residence_card_issue_date", "تاريخ الإصدار", read("issue_date") ? "issue_date" : "expiry_date", record?.residence_card_issue_date, { date: true });
    return rows;
  }
  if (badge) {
    add(`field:${badge}_no`, "رقم الهوية", "doc_number", record?.[`${badge}_no`], { ltr: true });
    add(`field:${badge}_issue_date`, "تاريخ الإصدار", "issue_date", record?.[`${badge}_issue_date`], { date: true });
    add(`field:${badge}_expiry`, "تاريخ النفاذ", "expiry_date", record?.[`${badge}_expiry`], { date: true });
    if (badge === "airport_badge") add("field:airport_badge_zones", "صلاحيات الباج", "zones", record?.airport_badge_zones, { ltr: true });
    // Suggestions for the employee record from the badge (unticked when they differ).
    add("field:job_title", "العنوان الوظيفي", "job_title", record?.job_title);
    const names = currentNameParts(record, "full_name");
    OCR_NAME_PARTS.forEach(([part, label]) => add(`name:full_name:${part}`, label, part, names[part]));
    return rows;
  }
  const nameKey = kind === "employee" ? "full_name" : "name";
  const names = currentNameParts(record, nameKey);
  OCR_NAME_PARTS.forEach(([part, label]) => add(`name:${nameKey}:${part}`, label, part, names[part]));
  if (kind !== "family") {
    const mother = currentNameParts(record, "mother_name");
    add("name:mother_name:first", "اسم الأم", "mother_first", mother.first);
    add("name:mother_name:father", "اسم والد الأم", "mother_father", mother.father);
  }
  add("field:gender", "الجنس", "gender", record?.gender);
  add("field:blood_type", "فصيلة الدم", "blood_type", record?.blood_type, { ltr: true });
  const fields = kind === "employee"
    ? passport
      ? [["passport_no", "رقم جواز السفر", "passport_no", { ltr: true }], ["passport_type", "نوع جواز السفر", "passport_type", { ltr: true }],
         ["passport_issue_date", "تاريخ إصدار الجواز", "issue_date", { date: true }], ["passport_expiry_date", "تاريخ نفاذ الجواز", "expiry_date", { date: true }],
         ["civil_id", "الرقم الوطني", "national_no", { ltr: true }], ["birthdate", "تاريخ الولادة", "birthdate", { date: true }]]
      : [["civil_id", "الرقم الوطني", "national_no", { ltr: true }], ["civil_id_issuer", "جهة الإصدار", "issuer"],
         ["civil_id_issue_date", "تاريخ الإصدار", "issue_date", { date: true }], ["civil_id_expiry_date", "تاريخ النفاذ", "expiry_date", { date: true }],
         ["civil_id_family_number", "الرقم العائلي", "family_no", { ltr: true }],
         ["birthplace", "محل الولادة", "birthplace"], ["birthdate", "تاريخ الولادة", "birthdate", { date: true }]]
    : [["civil_id", "الرقم الوطني", "national_no", { ltr: true }], ["issuer", "جهة الإصدار", "issuer"],
       ["issue_date", "تاريخ الإصدار", "issue_date", { date: true }], ["expiry_date", "تاريخ النفاذ", "expiry_date", { date: true }],
       ["birthplace", "محل الولادة", "birthplace"], ["birthdate", "تاريخ الولادة", "birthdate", { date: true }]];
  fields.forEach(([id, label, key, opts]) => add(`field:${id}`, label, key, record?.[id], opts));
  if (kind === "employee" && passport) {
    const latin = currentNameParts(record, "passport_name", true);
    add("name:passport_name:given", "الأسماء حسب الجواز", "latin_given", latin.given, { ltr: true });
    add("name:passport_name:surname", "اللقب حسب الجواز", "latin_surname", latin.surname, { ltr: true });
  }
  return rows;
}

function applyOcrValues(target, chosen) {
  const panel = document.getElementById("emp-panel");
  const before = ocrTarget(target);
  collectVisiblePanelFields(panel);
  const info = ocrTarget(target);
  // Rows read back from the form keep only stored paths; keep the preview paths too.
  info.list?.forEach((entry, i) => {
    Object.entries(before.list?.[i] ?? {}).forEach(([key, value]) => {
      if (key.endsWith("_full_path") && entry[key] == null) entry[key] = value;
    });
  });
  const record = info.kind === "employee" ? _panelDraft : { ...info.record };
  const parts = namePartsOf(record);
  for (const [id, value] of Object.entries(chosen)) {
    const [type, key, part] = id.split(":");
    if (type === "field") { record[key] = value; continue; }
    const passport = key === "passport_name";
    const group = { ...currentNameParts(record, key, passport), ...(parts[key] ?? {}), [part]: value, review: false };
    parts[key] = group;
    record[key] = joinNameParts(group, passport);
  }
  if (info.kind !== "vehicle") record.name_parts = parts;
  if (info.kind !== "employee") {
    info.list[info.index] = record;
    _panelDraft[info.listKey] = JSON.stringify(info.list);
  }
  document.getElementById("tab-content").innerHTML = tabContent(_activeTab, _panelDraft);
  attachTabEvents(_panelDraft);
  updateTabCounts();
  markPanelDirty();
  showToast("أُدخلت القيم في النموذج. راجعها ثم اضغط حفظ.");
}

/** Right after an upload: offer the read values straight away (images only). */
async function readUploadedFields(target, path, fullPath, title) {
  if (!can(_currentUser, "employees.edit")) return;
  await readFieldsInto(target, path, fullPath ? convertFileSrc(fullPath) : "", title);
}

const OCR_FIELD_LABELS = { plate: "رقم اللوحة", governorate: "المحافظة", plate_category: "نوع اللوحة", chassis_no: "رقم الشاصي", year: "سنة الصنع", annual_no: "رقم السنوية", brand: "العلامة التجارية", vehicle_type: "نوع المركبة", color: "اللون", doc_number: "رقم الهوية", issue_date: "تاريخ الإصدار", expiry_date: "تاريخ النفاذ", job_title: "العنوان الوظيفي", zones: "صلاحيات الباج", first: "الاسم", father: "اسم الأب", grandfather: "اسم الجد" };

/** The other side of a two-sided badge, when it is an image too. */
function otherBadgeSide(target, path) {
  const info = ocrTarget(target);
  if (info.kind === "vehicle") {
    const other = [info.record?.annual_front_path, info.record?.annual_back_path].find(p => p && p !== path);
    return other && OCR_IMAGE_EXTENSIONS.includes(other.split(".").pop()?.toLowerCase()) ? other : null;
  }
  const badge = info.badge;
  if (!["airport_badge", "ministry_badge"].includes(badge)) return null;
  const sides = [_panelDraft?.[`${badge}_front_path`], _panelDraft?.[`${badge}_back_path`]];
  const other = sides.find(p => p && p !== path);
  return other && OCR_IMAGE_EXTENSIONS.includes(other.split(".").pop()?.toLowerCase()) ? other : null;
}

async function readFieldsInto(target, path, imageUrl, title) {
  const extension = String(path ?? "").split(".").pop()?.toLowerCase();
  if (!path || !OCR_IMAGE_EXTENSIONS.includes(extension)) return;
  const chosen = await readDocumentFields({
    path, otherPath: otherBadgeSide(target, path), labels: OCR_FIELD_LABELS, imageUrl, title: `قراءة البيانات: ${title ?? ""}`,
    buildRows: result => ocrRows(result, target),
  });
  if (chosen && Object.keys(chosen).length) applyOcrValues(target, chosen);
}
