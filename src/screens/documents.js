/**
 * documents.js — General + per-employee document archive
 */
import { api }       from "../api.js";
import { showToast, escHtml, formatDate, confirmAction } from "../utils.js";
import { open }      from "@tauri-apps/plugin-dialog";

export async function renderDocuments(container, user, ctx) {
  let [generalDocs, employees, documentTypes] = await Promise.all([
    api.listGeneralDocs(),
    api.listEmployees(),
    api.getDocumentTypes(),
  ]);

  let activeTab = "general";
  let generalSearch = "";
  let generalNotesSearch = "";
  let generalTypeFilter = "";
  let generalFileFilter = "all";
  let generalDateFrom = "";
  let generalDateTo = "";

  function parseAttachments(emp) {
    try { return JSON.parse(emp?.attachment_paths ?? "[]"); }
    catch { return []; }
  }

  function fileName(path) {
    return String(path ?? "").split(/[/\\]/).pop() || path;
  }

  function employeesWithDocs() {
    return employees.filter(e => parseAttachments(e).length > 0);
  }

  function matchesGeneralSearch(doc) {
    if (generalTypeFilter && doc.doc_type !== generalTypeFilter) return false;
    if (generalFileFilter === "with" && !doc.file_path) return false;
    if (generalFileFilter === "without" && doc.file_path) return false;
    if (generalDateFrom && (!doc.issue_date || doc.issue_date < generalDateFrom)) return false;
    if (generalDateTo && (!doc.issue_date || doc.issue_date > generalDateTo)) return false;

    const notesNeedle = generalNotesSearch.trim().toLowerCase();
    if (notesNeedle && !String(doc.notes ?? "").toLowerCase().includes(notesNeedle)) return false;

    const needle = generalSearch.trim().toLowerCase();
    if (!needle) return true;
    return [
      doc.title,
      doc.doc_type,
      doc.doc_number,
      doc.issue_date,
      doc.issuer,
      doc.notes,
      doc.file_path,
    ].some(value => String(value ?? "").toLowerCase().includes(needle));
  }

  function renderDocumentTypeOptions(selected = "", placeholder = "— اختر —") {
    return [
      `<option value="">${escHtml(placeholder)}</option>`,
      ...documentTypes.map(type => `<option value="${escHtml(type)}" ${selected === type ? "selected" : ""}>${escHtml(type)}</option>`),
    ].join("");
  }

  function renderDocTypeManager() {
    if (!user?.is_master) return "";
    return `
      <div class="card space-y-3">
        <div class="flex items-center justify-between gap-3">
          <p class="section-title mb-0">أنواع الوثائق</p>
          <span class="badge badge-gray">${documentTypes.length}</span>
        </div>
        <div id="doc-type-list" class="flex flex-wrap gap-2">
          ${documentTypes.map(type => `
            <span class="badge badge-green gap-2">
              ${escHtml(type)}
              <button class="btn-remove-doc-type" data-type="${escHtml(type)}"
                style="border:none;background:transparent;color:inherit;cursor:pointer;font-weight:700">×</button>
            </span>`).join("")}
        </div>
        <div class="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3">
          <input id="new-doc-type" class="input-field" placeholder="نوع وثيقة جديد" />
          <button id="btn-add-doc-type" class="btn-secondary px-4">إضافة نوع</button>
        </div>
      </div>`;
  }

  async function saveDocumentTypes(types) {
    documentTypes = await api.setDocumentTypes(types);
    showToast("تم تحديث أنواع الوثائق");
    renderGeneral();
  }

  function attachDocTypeManagerEvents(root) {
    if (!user?.is_master) return;
    root.querySelector("#btn-add-doc-type")?.addEventListener("click", async () => {
      const input = root.querySelector("#new-doc-type");
      const value = input?.value?.trim();
      if (!value) { showToast("اكتب نوع الوثيقة أولاً", "warn"); return; }
      if (documentTypes.some(type => type === value)) { showToast("هذا النوع موجود مسبقاً", "warn"); return; }
      try {
        await saveDocumentTypes([...documentTypes, value]);
      } catch (err) { showToast(err?.message ?? String(err || "خطأ"), "error"); }
    });

    root.querySelectorAll(".btn-remove-doc-type").forEach(btn => {
      btn.addEventListener("click", async () => {
        const type = btn.dataset.type;
        if (documentTypes.length <= 1) { showToast("يجب إبقاء نوع وثيقة واحد على الأقل", "warn"); return; }
        if (!(await confirmAction(`تأكيد حذف نوع الوثيقة "${type}"؟`))) return;
        try {
          await saveDocumentTypes(documentTypes.filter(item => item !== type));
        } catch (err) { showToast(err?.message ?? String(err || "خطأ"), "error"); }
      });
    });
  }

  function html() {
    return `<div class="space-y-4">
      <!-- Tabs -->
      <div style="display:flex;gap:8px;border-bottom:1px solid #2d2d2d;padding-bottom:0">
        ${[["general","📂 الأرشيف العام"],["employee","👤 وثائق الموظفين"]].map(([id, label]) => `
          <button class="doc-tab" data-tab="${id}" style="padding:8px 16px;border:none;cursor:pointer;
            font-size:13px;border-bottom:2px solid ${activeTab===id?"#5da12c":"transparent"};
            background:transparent;color:${activeTab===id?"#5da12c":"#9ca3af"};
            font-weight:${activeTab===id?"700":"400"}">${label}</button>`).join("")}
      </div>

      <div id="doc-content"></div>
    </div>`;
  }

  function renderGeneral() {
    const el = document.getElementById("doc-content");
    if (!el) return;
    const focusedId = document.activeElement?.id;
    const filteredDocs = generalDocs.filter(matchesGeneralSearch);
    const hasActiveFilters = generalSearch || generalNotesSearch || generalTypeFilter || generalFileFilter !== "all" || generalDateFrom || generalDateTo;
    el.innerHTML = `
      <div class="space-y-4">
        ${renderDocTypeManager()}
        <div class="card space-y-3">
          <div class="flex gap-3 items-center flex-wrap">
            <input id="general-doc-search" class="input-field flex-1 min-w-[220px]"
              placeholder="بحث في الأرشيف العام..." value="${escHtml(generalSearch)}" />
            <span class="badge badge-gray">${filteredDocs.length} / ${generalDocs.length}</span>
            <button id="btn-add-doc" class="btn-primary px-4 py-2">+ إضافة وثيقة</button>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div>
              <p style="font-size:11px;color:#6b7280;margin-bottom:4px">نوع الوثيقة</p>
              <select id="general-type-filter" class="input-field">
                ${renderDocumentTypeOptions(generalTypeFilter, "كل الأنواع")}
              </select>
            </div>
            <div>
              <p style="font-size:11px;color:#6b7280;margin-bottom:4px">حالة المرفق</p>
              <select id="general-file-filter" class="input-field">
                <option value="all" ${generalFileFilter === "all" ? "selected" : ""}>الكل</option>
                <option value="with" ${generalFileFilter === "with" ? "selected" : ""}>لديه مرفق</option>
                <option value="without" ${generalFileFilter === "without" ? "selected" : ""}>بدون مرفق</option>
              </select>
            </div>
            <div>
              <p style="font-size:11px;color:#6b7280;margin-bottom:4px">من تاريخ إصدار</p>
              <input id="general-date-from" class="input-field" type="date" value="${escHtml(generalDateFrom)}" />
            </div>
            <div>
              <p style="font-size:11px;color:#6b7280;margin-bottom:4px">إلى تاريخ إصدار</p>
              <input id="general-date-to" class="input-field" type="date" value="${escHtml(generalDateTo)}" />
            </div>
          </div>
          <div>
            <p style="font-size:11px;color:#6b7280;margin-bottom:4px">البحث في نبذة عامة عن الوثيقة</p>
            <input id="general-notes-search" class="input-field"
              placeholder="اكتب جزءا من نبذة الوثيقة..." value="${escHtml(generalNotesSearch)}" />
          </div>
          ${hasActiveFilters ? `
            <div class="flex justify-end">
              <button id="btn-clear-general-filters" class="btn-secondary px-3 py-2">مسح الفلاتر</button>
            </div>` : ""}
        </div>
        <div class="card overflow-auto">
          <table class="w-full">
            <thead><tr>
              <th class="table-header">العنوان</th>
              <th class="table-header">النوع</th>
              <th class="table-header">الرقم</th>
              <th class="table-header">تاريخ الإصدار</th>
              <th class="table-header">الجهة المصدرة</th>
              <th class="table-header">ملف</th>
              <th class="table-header">إجراء</th>
            </tr></thead>
            <tbody>
              ${generalDocs.length === 0
                ? `<tr><td colspan="7" class="table-cell text-center text-gray-500 py-8">لا توجد وثائق</td></tr>`
                : filteredDocs.length === 0
                  ? `<tr><td colspan="7" class="table-cell text-center text-gray-500 py-8">لا توجد نتائج مطابقة</td></tr>`
                  : filteredDocs.map(d => `
                  <tr class="table-row">
                    <td class="table-cell font-medium text-gray-100">${escHtml(d.title)}</td>
                    <td class="table-cell">${escHtml(d.doc_type ?? "—")}</td>
                    <td class="table-cell" dir="ltr">${escHtml(d.doc_number ?? "—")}</td>
                    <td class="table-cell">${formatDate(d.issue_date)}</td>
                    <td class="table-cell">${escHtml(d.issuer ?? "—")}</td>
                    <td class="table-cell">
                      ${d.file_path
                        ? `<div class="flex items-center gap-2 flex-wrap">
                            <span class="badge badge-green" title="${escHtml(d.file_path)}">📎 مرفق</span>
                            <button class="btn-secondary text-xs px-2 py-1 btn-upload-doc" data-id="${d.id}">استبدال</button>
                          </div>`
                        : `<button class="btn-secondary text-xs px-2 py-1 btn-upload-doc" data-id="${d.id}">رفع</button>`}
                    </td>
                    <td class="table-cell">
                      <div class="flex gap-2 flex-wrap">
                        <button class="btn-secondary text-xs px-2 py-1 btn-edit-doc" data-id="${d.id}">تعديل</button>
                        <button class="btn-danger text-xs px-2 py-1 btn-del-doc" data-id="${d.id}">حذف</button>
                      </div>
                    </td>
                  </tr>`).join("")}
            </tbody>
          </table>
        </div>
      </div>`;

    attachDocTypeManagerEvents(el);

    const restoreFocus = () => {
      if (!focusedId) return;
      const focused = el.querySelector(`#${focusedId}`);
      focused?.focus();
      if (["general-doc-search", "general-notes-search"].includes(focusedId)) {
        focused.setSelectionRange(focused.value.length, focused.value.length);
      }
    };

    const searchInput = el.querySelector("#general-doc-search");
    searchInput?.addEventListener("input", () => {
      generalSearch = searchInput.value;
      renderGeneral();
    });
    const notesSearchInput = el.querySelector("#general-notes-search");
    notesSearchInput?.addEventListener("input", () => {
      generalNotesSearch = notesSearchInput.value;
      renderGeneral();
    });
    el.querySelector("#general-type-filter")?.addEventListener("change", (event) => {
      generalTypeFilter = event.target.value;
      renderGeneral();
    });
    el.querySelector("#general-file-filter")?.addEventListener("change", (event) => {
      generalFileFilter = event.target.value;
      renderGeneral();
    });
    el.querySelector("#general-date-from")?.addEventListener("change", (event) => {
      generalDateFrom = event.target.value;
      renderGeneral();
    });
    el.querySelector("#general-date-to")?.addEventListener("change", (event) => {
      generalDateTo = event.target.value;
      renderGeneral();
    });
    el.querySelector("#btn-clear-general-filters")?.addEventListener("click", () => {
      generalSearch = "";
      generalNotesSearch = "";
      generalTypeFilter = "";
      generalFileFilter = "all";
      generalDateFrom = "";
      generalDateTo = "";
      renderGeneral();
    });

    el.querySelector("#btn-add-doc").addEventListener("click", () => showDocForm());

    el.querySelectorAll(".btn-edit-doc").forEach(btn => {
      btn.addEventListener("click", () => {
        const doc = generalDocs.find(item => item.id === parseInt(btn.dataset.id, 10));
        if (doc) showDocForm(doc);
      });
    });

    el.querySelectorAll(".btn-del-doc").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!(await confirmAction("تأكيد حذف الوثيقة؟"))) return;
        try {
          await api.deleteGeneralDoc(parseInt(btn.dataset.id, 10));
          generalDocs = await api.listGeneralDocs();
          showToast("تم حذف الوثيقة");
          renderGeneral();
        } catch (err) { showToast(err?.message ?? "خطأ", "error"); }
      });
    });

    el.querySelectorAll(".btn-upload-doc").forEach(btn => {
      btn.addEventListener("click", async () => {
        try {
          const selected = await open({ multiple: false });
          if (!selected) return;
          if (!(await confirmAction("تأكيد رفع الملف لهذه الوثيقة؟"))) return;
          await api.uploadGeneralDocFile(parseInt(btn.dataset.id, 10), selected);
          generalDocs = await api.listGeneralDocs();
          showToast("تم رفع الملف");
          renderGeneral();
        } catch (err) { showToast(err?.message ?? "خطأ", "error"); }
      });
    });

    restoreFocus();
  }

  function showDocForm(doc = null) {
    const el = document.getElementById("doc-content");
    const isEdit = Boolean(doc);
    el.innerHTML = `
      <div class="card max-w-lg space-y-4">
        <p class="section-title">${isEdit ? "تعديل وثيقة" : "إضافة وثيقة جديدة"}</p>
        <div>
          <p style="font-size:11px;color:#6b7280;margin-bottom:4px">العنوان *</p>
          <input id="d-title" class="input-field" placeholder="عنوان الوثيقة" value="${escHtml(doc?.title ?? "")}" />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <p style="font-size:11px;color:#6b7280;margin-bottom:4px">نوع الوثيقة</p>
            <select id="d-type" class="input-field">
              ${renderDocumentTypeOptions(doc?.doc_type ?? "")}
            </select>
          </div>
          <div>
            <p style="font-size:11px;color:#6b7280;margin-bottom:4px">رقم الوثيقة</p>
            <input id="d-number" class="input-field" dir="ltr" value="${escHtml(doc?.doc_number ?? "")}" />
          </div>
          <div>
            <p style="font-size:11px;color:#6b7280;margin-bottom:4px">تاريخ الإصدار</p>
            <input id="d-date" class="input-field" type="date" value="${escHtml(doc?.issue_date ?? "")}" />
          </div>
          <div>
            <p style="font-size:11px;color:#6b7280;margin-bottom:4px">الجهة المصدرة</p>
            <input id="d-issuer" class="input-field" value="${escHtml(doc?.issuer ?? "")}" />
          </div>
        </div>
        <div>
          <p style="font-size:11px;color:#6b7280;margin-bottom:4px">نبذه عامة عن الوثيقة</p>
          <textarea id="d-notes" class="input-field" style="height:70px;resize:none">${escHtml(doc?.notes ?? "")}</textarea>
        </div>
        <div class="flex gap-3">
          <button id="btn-save-doc" class="btn-primary flex-1">حفظ</button>
          <button id="btn-cancel-doc" class="btn-secondary">إلغاء</button>
        </div>
      </div>`;

    el.querySelector("#btn-cancel-doc").addEventListener("click", () => renderGeneral());
    el.querySelector("#btn-save-doc").addEventListener("click", async () => {
      const title = el.querySelector("#d-title").value.trim();
      if (!title) { showToast("العنوان مطلوب", "error"); return; }
      if (!(await confirmAction(isEdit ? "تأكيد حفظ تعديلات الوثيقة؟" : "تأكيد إضافة الوثيقة؟"))) return;
      try {
        const data = {
          title,
          doc_type:   el.querySelector("#d-type").value   || null,
          doc_number: el.querySelector("#d-number").value.trim() || null,
          issue_date: el.querySelector("#d-date").value   || null,
          issuer:     el.querySelector("#d-issuer").value.trim() || null,
          notes:      el.querySelector("#d-notes").value.trim()  || null,
        };
        if (isEdit) await api.updateGeneralDoc(doc.id, data);
        else await api.createGeneralDoc(data);
        generalDocs = await api.listGeneralDocs();
        showToast(isEdit ? "تم حفظ تعديلات الوثيقة" : "تمت إضافة الوثيقة");
        renderGeneral();
      } catch (err) { showToast(err?.message ?? "خطأ", "error"); }
    });
  }

  function renderEmployeeDocs() {
    const el = document.getElementById("doc-content");
    if (!el) return;
    const withDocs = employeesWithDocs();
    el.innerHTML = `
      <div class="space-y-4">
        <div class="card space-y-3">
          <p class="section-title">رفع وثيقة لموظف موجود</p>
          <div class="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-end">
            <div>
              <p style="font-size:11px;color:#6b7280;margin-bottom:4px">الموظف</p>
              <select id="emp-doc-employee" class="input-field">
                <option value="">— اختر موظفاً —</option>
                ${employees.map(e => `
                  <option value="${e.id}">
                    ${escHtml(e.full_name)}${e.employee_number ? ` - ${escHtml(e.employee_number)}` : ""}
                  </option>`).join("")}
              </select>
            </div>
            <button id="btn-upload-emp-doc" class="btn-primary px-4 py-2">رفع وثيقة…</button>
          </div>
        </div>

        <div class="card overflow-auto">
          <div class="flex items-center justify-between gap-3 mb-4">
            <p class="section-title mb-0">الوثائق المرفوعة للموظفين</p>
            <span class="badge badge-gray">${withDocs.reduce((sum, e) => sum + parseAttachments(e).length, 0)} وثيقة</span>
          </div>
          ${withDocs.length === 0
            ? `<p class="text-center text-gray-500 py-8">لا توجد وثائق موظفين مرفوعة</p>`
            : withDocs.map(e => {
                const paths = parseAttachments(e);
                return `<div style="border:1px solid #2d2d2d;border-radius:8px;margin-bottom:12px;overflow:hidden">
                  <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;padding:10px 12px;background:#181818">
                    <div>
                      <p class="font-medium text-gray-100">${escHtml(e.full_name)}</p>
                      <p class="text-xs text-gray-500" dir="ltr">${escHtml(e.employee_number ?? "—")}</p>
                    </div>
                    <span class="badge badge-green">${paths.length}</span>
                  </div>
                  <table class="w-full">
                    <thead><tr>
                      <th class="table-header">اسم الوثيقة</th>
                      <th class="table-header">المسار</th>
                      <th class="table-header">إجراء</th>
                    </tr></thead>
                    <tbody>
                      ${paths.map(path => `
                        <tr class="table-row">
                          <td class="table-cell font-medium text-gray-100">📄 ${escHtml(fileName(path))}</td>
                          <td class="table-cell text-xs" dir="ltr">${escHtml(path)}</td>
                          <td class="table-cell">
                            <button class="btn-danger text-xs px-2 py-1 btn-del-emp-doc"
                              data-emp-id="${e.id}" data-path="${escHtml(path)}">حذف</button>
                          </td>
                        </tr>`).join("")}
                    </tbody>
                  </table>
                </div>`;
              }).join("")}
        </div>
      </div>`;

    el.querySelector("#btn-upload-emp-doc")?.addEventListener("click", async () => {
      const empId = parseInt(el.querySelector("#emp-doc-employee")?.value || "0", 10);
      if (!empId) { showToast("اختر الموظف أولاً", "warn"); return; }
      try {
        const selected = await open({ multiple: true });
        if (!selected) return;
        const files = Array.isArray(selected) ? selected : [selected];
        if (!(await confirmAction(`تأكيد رفع ${files.length} وثيقة للموظف؟`))) return;
        for (const file of files) {
          await api.uploadAttachment(empId, file);
        }
        employees = await api.listEmployees();
        showToast(`تم رفع ${files.length} وثيقة`);
        renderEmployeeDocs();
      } catch (err) { showToast(err?.message ?? String(err || "خطأ في الرفع"), "error"); }
    });

    el.querySelectorAll(".btn-del-emp-doc").forEach(btn => {
      btn.addEventListener("click", async () => {
        const empId = parseInt(btn.dataset.empId, 10);
        const path = btn.dataset.path;
        if (!(await confirmAction("تأكيد حذف هذه الوثيقة من ملف الموظف؟"))) return;
        try {
          await api.deleteAttachment(empId, path);
          employees = await api.listEmployees();
          showToast("تم حذف الوثيقة");
          renderEmployeeDocs();
        } catch (err) { showToast(err?.message ?? String(err || "خطأ في الحذف"), "error"); }
      });
    });
  }

  container.innerHTML = html();

  container.querySelectorAll(".doc-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      activeTab = btn.dataset.tab;
      container.querySelectorAll(".doc-tab").forEach(b => {
        const a = b.dataset.tab === activeTab;
        b.style.borderBottomColor = a ? "#5da12c" : "transparent";
        b.style.color = a ? "#5da12c" : "#9ca3af";
        b.style.fontWeight = a ? "700" : "400";
      });
      if (activeTab === "general") renderGeneral();
      else renderEmployeeDocs();
    });
  });

  renderGeneral();
}
