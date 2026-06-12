/**
 * documents.js — General + per-employee document archive
 */
import { api }       from "../api.js";
import { showToast, escHtml, confirmAction } from "../utils.js";
import { open }      from "@tauri-apps/plugin-dialog";

export async function renderDocuments(container, user, ctx) {
  let [generalDocs, outgoingDocs, employees, documentTypes] = await Promise.all([
    api.listGeneralDocs(),
    api.listOutgoingDocs(),
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

  const isOutgoing = () => activeTab === "outgoing";
  const archiveName = () => isOutgoing() ? "الصادر" : "الوارد";
  const currentDocs = () => isOutgoing() ? outgoingDocs : generalDocs;
  const refreshCurrentDocs = async () => {
    if (isOutgoing()) outgoingDocs = await api.listOutgoingDocs();
    else generalDocs = await api.listGeneralDocs();
  };
  const createCurrentDoc = data => isOutgoing() ? api.createOutgoingDoc(data) : api.createGeneralDoc(data);
  const updateCurrentDoc = (id, data) => isOutgoing() ? api.updateOutgoingDoc(id, data) : api.updateGeneralDoc(id, data);
  const deleteCurrentDoc = id => isOutgoing() ? api.deleteOutgoingDoc(id) : api.deleteGeneralDoc(id);
  const uploadCurrentDocFile = (id, path) => isOutgoing() ? api.uploadOutgoingDocFile(id, path) : api.uploadGeneralDocFile(id, path);
  const deleteCurrentDocAttachment = (id, path) =>
    isOutgoing() ? api.deleteOutgoingDocAttachment(id, path) : api.deleteGeneralDocAttachment(id, path);

  function parseAttachments(emp) {
    try { return JSON.parse(emp?.attachment_paths ?? "[]"); }
    catch { return []; }
  }

  function fileName(path) {
    return String(path ?? "").split(/[/\\]/).pop() || path;
  }

  function generalDocAttachments(doc) {
    return doc?.attachment_paths ?? [];
  }

  function formatIncomingDate(value) {
    const match = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    return match ? `${match[3]}/${match[2]}/${match[1]}` : "—";
  }

  function employeesWithDocs() {
    return employees.filter(e => parseAttachments(e).length > 0);
  }

  function matchesGeneralSearch(doc) {
    if (generalTypeFilter && doc.doc_type !== generalTypeFilter) return false;
    const attachments = generalDocAttachments(doc);
    if (generalFileFilter === "with" && attachments.length === 0) return false;
    if (generalFileFilter === "without" && attachments.length > 0) return false;
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
      ...attachments,
      ...(doc.employee_names ?? []),
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
        ${[["general","📂 الوارد"],["outgoing","📤 الصادر"]].map(([id, label]) => `
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
    const archiveDocs = currentDocs();
    const filteredDocs = archiveDocs.filter(matchesGeneralSearch);
    const hasActiveFilters = generalSearch || generalNotesSearch || generalTypeFilter || generalFileFilter !== "all" || generalDateFrom || generalDateTo;
    el.innerHTML = `
      <div class="space-y-4">
        ${renderDocTypeManager()}
        <div class="card space-y-3">
          <div class="flex gap-3 items-center flex-wrap">
            <input id="general-doc-search" class="input-field flex-1 min-w-[220px]"
              placeholder="بحث في ${archiveName()}..." value="${escHtml(generalSearch)}" />
            <span class="badge badge-gray">${filteredDocs.length} / ${archiveDocs.length}</span>
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
              <th class="table-header">${isOutgoing() ? "الجهة المرسل إليها" : "الجهة المصدرة"}</th>
              <th class="table-header">الموظفون المرتبطون</th>
              <th class="table-header">ملف</th>
              <th class="table-header">إجراء</th>
            </tr></thead>
            <tbody>
              ${archiveDocs.length === 0
                ? `<tr><td colspan="8" class="table-cell text-center text-gray-500 py-8">لا توجد وثائق</td></tr>`
                : filteredDocs.length === 0
                  ? `<tr><td colspan="8" class="table-cell text-center text-gray-500 py-8">لا توجد نتائج مطابقة</td></tr>`
                  : filteredDocs.map(d => `
                  <tr class="table-row general-doc-row" data-id="${d.id}" title="اضغط لتعديل الوثيقة">
                    <td class="table-cell font-medium text-gray-100">${escHtml(d.title)}</td>
                    <td class="table-cell">${escHtml(d.doc_type ?? "—")}</td>
                    <td class="table-cell" dir="ltr">${escHtml(d.doc_number ?? "—")}</td>
                    <td class="table-cell" dir="ltr">${formatIncomingDate(d.issue_date)}</td>
                    <td class="table-cell">${escHtml(d.issuer ?? "—")}</td>
                    <td class="table-cell">
                      ${(d.employee_names ?? []).length
                        ? `<div class="flex gap-1 flex-wrap">${d.employee_names.map(name =>
                            `<span class="badge badge-green">${escHtml(name)}</span>`).join("")}</div>`
                        : "—"}
                    </td>
                    <td class="table-cell">
                      <button class="btn-manage-doc-attachments" data-id="${d.id}" title="إدارة مرفقات الوثيقة"
                        style="border:none;background:transparent;cursor:pointer;padding:2px">
                        <span class="badge ${generalDocAttachments(d).length ? "badge-green" : "badge-gray"}"
                          style="gap:6px;font-size:12px;padding:5px 11px">
                          <span>📎</span>
                          <span dir="ltr">${generalDocAttachments(d).length} / 20</span>
                        </span>
                      </button>
                    </td>
                    <td class="table-cell">
                      <div class="flex gap-2 flex-wrap">
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

    el.querySelectorAll(".general-doc-row").forEach(row => {
      row.addEventListener("click", event => {
        if (event.target.closest("button, input, select, textarea, a")) return;
        const doc = currentDocs().find(item => item.id === parseInt(row.dataset.id, 10));
        if (doc) showDocForm(doc);
      });
    });

    el.querySelectorAll(".btn-del-doc").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!(await confirmAction("تأكيد حذف الوثيقة؟"))) return;
        try {
          await deleteCurrentDoc(parseInt(btn.dataset.id, 10));
          await refreshCurrentDocs();
          showToast("تم حذف الوثيقة");
          renderGeneral();
        } catch (err) { showToast(err?.message ?? "خطأ", "error"); }
      });
    });

    el.querySelectorAll(".btn-manage-doc-attachments").forEach(btn => {
      btn.addEventListener("click", () => openAttachmentManager(parseInt(btn.dataset.id, 10)));
    });

    restoreFocus();
  }

  function openAttachmentManager(docId, returnToTable = true) {
    const overlay = document.createElement("div");
    overlay.setAttribute("dir", "rtl");
    overlay.style.cssText = `
      position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.66);
      display:flex;align-items:center;justify-content:center;padding:20px;
    `;
    overlay.innerHTML = `
      <div style="width:min(620px,100%);max-height:min(720px,calc(100vh - 40px));background:#1f1f1f;
        border:1px solid #2d2d2d;border-radius:12px;box-shadow:0 18px 60px rgba(0,0,0,.5);
        display:flex;flex-direction:column;overflow:hidden">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:15px 18px;border-bottom:1px solid #2d2d2d">
          <div>
            <p style="font-size:15px;font-weight:700;color:#f3f4f6">مرفقات الوثيقة</p>
            <p id="attachment-manager-title" style="font-size:11px;color:#6b7280;margin-top:3px"></p>
          </div>
          <button type="button" id="attachment-manager-close" class="btn-secondary">إغلاق</button>
        </div>
        <div id="attachment-manager-content" style="padding:16px;overflow:auto"></div>
      </div>`;
    document.body.append(overlay);

    const close = () => {
      document.removeEventListener("keydown", onKeyDown);
      overlay.remove();
      if (returnToTable) {
        renderGeneral();
      } else {
        const doc = currentDocs().find(item => item.id === docId);
        const badge = document.querySelector("#d-manage-attachments .badge");
        if (badge && doc) {
          const count = generalDocAttachments(doc).length;
          badge.classList.toggle("badge-green", count > 0);
          badge.classList.toggle("badge-gray", count === 0);
          const countText = badge.querySelector("[dir='ltr']");
          if (countText) countText.textContent = `${count} / 20`;
        }
      }
    };
    const onKeyDown = event => { if (event.key === "Escape") close(); };
    overlay.querySelector("#attachment-manager-close").addEventListener("click", close);
    overlay.addEventListener("click", event => { if (event.target === overlay) close(); });
    document.addEventListener("keydown", onKeyDown);

    const renderManager = () => {
      const doc = currentDocs().find(item => item.id === docId);
      if (!doc) { close(); return; }
      const attachments = generalDocAttachments(doc);
      overlay.querySelector("#attachment-manager-title").textContent = doc.title;
      const content = overlay.querySelector("#attachment-manager-content");
      content.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px">
          <span class="badge ${attachments.length ? "badge-green" : "badge-gray"}" style="gap:6px;padding:5px 11px">
            <span>📎</span><span dir="ltr">${attachments.length} / 20</span>
          </span>
          ${attachments.length < 20
            ? `<button type="button" id="attachment-manager-add" class="btn-secondary">إضافة ملفات</button>`
            : `<span style="font-size:11px;color:#6b7280">تم الوصول إلى الحد الأقصى</span>`}
        </div>
        <div style="border:1px solid #2d2d2d;border-radius:9px;overflow:hidden">
          ${attachments.length
            ? attachments.map((path, index) => `
                <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;
                  padding:10px 12px;border-bottom:${index < attachments.length - 1 ? "1px solid #2d2d2d" : "none"}">
                  <div style="display:flex;align-items:center;gap:8px;min-width:0">
                    <span style="color:#5da12c">📎</span>
                    <span style="font-size:12px;color:#d1d5db;word-break:break-all">
                      ${escHtml(fileName(path).replace(/^\d+_/, ""))}
                    </span>
                  </div>
                  <button type="button" class="btn-danger text-xs btn-manager-delete" data-path="${escHtml(path)}">حذف</button>
                </div>`).join("")
            : `<p style="padding:28px;text-align:center;color:#6b7280;font-size:13px">لا توجد مرفقات لهذه الوثيقة</p>`}
        </div>`;

      content.querySelector("#attachment-manager-add")?.addEventListener("click", async () => {
        try {
          const remaining = 20 - attachments.length;
          const selected = await open({
            multiple: true,
            filters: [{ name: "ملفات الوثائق", extensions: ["jpg", "jpeg", "pdf"] }],
          });
          if (!selected) return;
          const files = Array.isArray(selected) ? selected : [selected];
          if (files.length > remaining) {
            showToast(`يمكن إضافة ${remaining} ملف فقط لهذه الوثيقة`, "warn");
            return;
          }
          if (!(await confirmAction(`تأكيد رفع ${files.length} ملف للوثيقة؟`))) return;
          for (const file of files) await uploadCurrentDocFile(docId, file);
          await refreshCurrentDocs();
          showToast(`تم رفع ${files.length} ملف`);
          renderManager();
        } catch (err) { showToast(err?.message ?? "خطأ", "error"); }
      });

      content.querySelectorAll(".btn-manager-delete").forEach(button => {
        button.addEventListener("click", async () => {
          if (!(await confirmAction("تأكيد حذف مرفق الوثيقة؟"))) return;
          try {
            await deleteCurrentDocAttachment(docId, button.dataset.path);
            await refreshCurrentDocs();
            showToast("تم حذف المرفق");
            renderManager();
          } catch (err) { showToast(err?.message ?? "خطأ", "error"); }
        });
      });
    };

    renderManager();
  }

  function showDocForm(doc = null) {
    const el = document.getElementById("doc-content");
    const isEdit = Boolean(doc);
    const selectedEmployeeIds = new Set(doc?.employee_ids ?? []);
    const hasEmployeeLinks = selectedEmployeeIds.size > 0;
    el.innerHTML = `
      <div class="card max-w-2xl space-y-4">
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
            <p style="font-size:11px;color:#6b7280;margin-bottom:4px">${isOutgoing() ? "الجهة المرسل إليها" : "الجهة المصدرة"}</p>
            <input id="d-issuer" class="input-field" value="${escHtml(doc?.issuer ?? "")}" />
          </div>
        </div>
        <div>
          <p style="font-size:11px;color:#6b7280;margin-bottom:4px">نبذه عامة عن الوثيقة</p>
          <textarea id="d-notes" class="input-field" style="height:70px;resize:none">${escHtml(doc?.notes ?? "")}</textarea>
        </div>
        <div style="border-top:1px solid #2d2d2d;padding-top:12px">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:#d1d5db">
            <input id="d-has-employees" type="checkbox" ${hasEmployeeLinks ? "checked" : ""}
              style="width:16px;height:16px;accent-color:#5da12c" />
            هل لهذه الوثيقة ارتباط بموظفي الشعبة/الوحدة؟
          </label>
          <div id="d-employee-linking" class="space-y-3" style="display:${hasEmployeeLinks ? "block" : "none"};margin-top:12px">
            <input id="d-employee-search" class="input-field" placeholder="بحث باسم الموظف أو رقمه الوظيفي..." />
            <div class="flex items-center justify-between">
              <p style="font-size:11px;color:#6b7280">يمكن تحديد موظف واحد أو أكثر</p>
              <span id="d-selected-count" class="badge badge-gray">${selectedEmployeeIds.size} محدد</span>
            </div>
            <div id="d-employee-list" style="max-height:240px;overflow:auto;border:1px solid #2d2d2d;border-radius:8px">
              ${employees.map(employee => `
                <label class="doc-employee-option" data-search="${escHtml(`${employee.full_name} ${employee.employee_number ?? ""}`.toLowerCase())}"
                  style="display:flex;align-items:center;gap:9px;padding:9px 11px;border-bottom:1px solid #252525;cursor:pointer">
                  <input class="d-employee-checkbox" type="checkbox" value="${employee.id}"
                    ${selectedEmployeeIds.has(employee.id) ? "checked" : ""}
                    style="width:15px;height:15px;accent-color:#5da12c" />
                  <span style="font-size:12px;color:#d1d5db">${escHtml(employee.full_name)}</span>
                  <span style="font-size:11px;color:#6b7280" dir="ltr">${escHtml(employee.employee_number ?? "")}</span>
                </label>`).join("") || `<p style="padding:12px;color:#6b7280;font-size:12px">لا يوجد موظفون</p>`}
            </div>
          </div>
        </div>
        ${isEdit ? `
          <div style="border-top:1px solid #2d2d2d;padding-top:12px;display:flex;align-items:center;justify-content:space-between;gap:12px">
            <div>
              <p style="font-size:12px;font-weight:700;color:#d1d5db">مرفقات الوثيقة</p>
              <p style="font-size:11px;color:#6b7280;margin-top:3px">اضغط على الأيقونة لإدارة الملفات المرفقة</p>
            </div>
            <button type="button" id="d-manage-attachments" title="إدارة مرفقات الوثيقة"
              style="border:none;background:transparent;cursor:pointer;padding:2px">
              <span class="badge ${generalDocAttachments(doc).length ? "badge-green" : "badge-gray"}"
                style="gap:6px;font-size:12px;padding:5px 11px">
                <span>📎</span>
                <span dir="ltr">${generalDocAttachments(doc).length} / 20</span>
              </span>
            </button>
          </div>` : ""}
        <div class="flex gap-3">
          <button id="btn-save-doc" class="btn-primary flex-1">حفظ</button>
          <button id="btn-cancel-doc" class="btn-secondary">إلغاء</button>
        </div>
      </div>`;

    const hasEmployeesCheckbox = el.querySelector("#d-has-employees");
    const employeeLinking = el.querySelector("#d-employee-linking");
    const updateSelectedCount = () => {
      const count = el.querySelectorAll(".d-employee-checkbox:checked").length;
      el.querySelector("#d-selected-count").textContent = `${count} محدد`;
    };
    hasEmployeesCheckbox.addEventListener("change", () => {
      employeeLinking.style.display = hasEmployeesCheckbox.checked ? "block" : "none";
      if (!hasEmployeesCheckbox.checked) {
        el.querySelectorAll(".d-employee-checkbox").forEach(checkbox => { checkbox.checked = false; });
        updateSelectedCount();
      }
    });
    el.querySelectorAll(".d-employee-checkbox").forEach(checkbox =>
      checkbox.addEventListener("change", updateSelectedCount));
    el.querySelector("#d-employee-search")?.addEventListener("input", event => {
      const needle = event.target.value.trim().toLowerCase();
      el.querySelectorAll(".doc-employee-option").forEach(option => {
        option.style.display = !needle || option.dataset.search.includes(needle) ? "flex" : "none";
      });
    });
    el.querySelector("#d-manage-attachments")?.addEventListener("click", () => openAttachmentManager(doc.id, false));

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
          employee_ids: hasEmployeesCheckbox.checked
            ? [...el.querySelectorAll(".d-employee-checkbox:checked")].map(checkbox => parseInt(checkbox.value, 10))
            : [],
        };
        if (isEdit) await updateCurrentDoc(doc.id, data);
        else await createCurrentDoc(data);
        await refreshCurrentDocs();
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
        const selected = await open({
          multiple: true,
          filters: [{ name: "ملفات الوثائق", extensions: ["jpg", "jpeg", "pdf"] }],
        });
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
      renderGeneral();
    });
  });

  renderGeneral();
}
