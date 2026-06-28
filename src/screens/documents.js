/**
 * documents.js — General + per-employee document archive
 */
import { api }       from "../api.js";
import { convertFileSrc } from "@tauri-apps/api/core";
import { showToast, escHtml, confirmAction, confirmSaveChanges } from "../utils.js";
import { open }      from "@tauri-apps/plugin-dialog";
import { can }       from "../permissions.js";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export async function renderDocuments(container, user, ctx) {
  let [generalDocs, outgoingDocs, employees] = await Promise.all([
    api.listGeneralDocs(),
    api.listOutgoingDocs(),
    api.listEmployees(),
  ]);

  let activeTab = ctx?.archiveTab === "outgoing" ? "outgoing" : "general";
  const compactArchiveMode = Boolean(ctx?.compactArchiveMode);
  const initialEditDocId = Number.isFinite(Number(ctx?.editDocId)) ? Number(ctx.editDocId) : null;
  const initialManageAttachmentDocId = Number.isFinite(Number(ctx?.manageAttachmentDocId))
    ? Number(ctx.manageAttachmentDocId)
    : null;
  let activeDocFormGuard = null;
  window.autohrCanLeaveCurrentScreen = () => activeDocFormGuard ? activeDocFormGuard() : true;
  let generalSearch = "";
  let generalNotesSearch = "";
  let generalFileFilter = "all";
  let generalDateFrom = "";
  let generalDateTo = "";
  let generalIssuerFilter = "";
  let generalRecipientFilter = "";
  let generalSubjectFilter = "";
  let generalCountFilter = "";
  let generalMarginFilter = "";
  let generalMemoFilter = "all";
  let generalEmployeeFilter = "";
  let generalFiltersOpen = false;

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
  const moveCurrentDocAttachment = (id, path, direction) =>
    isOutgoing() ? api.moveOutgoingDocAttachment(id, path, direction) : api.moveGeneralDocAttachment(id, path, direction);

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

  async function printablePages(asset) {
    if (asset.extension !== "pdf") {
      return [{ title: asset.title, html: `<img src="${escHtml(asset.assetUrl)}" alt="${escHtml(asset.title)}">` }];
    }
    const bytes = await (await fetch(asset.assetUrl)).arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
    const pages = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
      pages.push({
        title: pdf.numPages > 1 ? `${asset.title} - ${pageNumber}` : asset.title,
        html: `<img src="${canvas.toDataURL("image/jpeg", 0.94)}" alt="${escHtml(asset.title)} - ${pageNumber}">`,
      });
      page.cleanup();
    }
    await pdf.destroy();
    return pages;
  }

  async function waitForPrintImages(doc) {
    await Promise.all([...doc.images].map(image => image.complete
      ? image.decode?.().catch(() => {})
      : new Promise(resolve => {
          image.addEventListener("load", resolve, { once: true });
          image.addEventListener("error", resolve, { once: true });
        })));
  }

  async function printPreparedAssets(assets, title) {
    const pages = [];
    for (const asset of assets) pages.push(...await printablePages(asset));
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;left:-10000px;top:0;width:210mm;height:297mm;border:0;background:#fff;opacity:1;pointer-events:none";
    document.body.append(frame);
    const printDoc = frame.contentDocument;
    printDoc.open();
    printDoc.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><title>${escHtml(title)}</title>
      <style>
        *{box-sizing:border-box}html,body{margin:0;background:#fff;font-family:Arial,sans-serif}
        .page{width:210mm;height:297mm;padding:10mm;text-align:center;overflow:hidden;break-after:page;page-break-after:always}
        .page:last-child{break-after:auto;page-break-after:auto}
        .title{font-size:11px;color:#374151;margin:0 0 3mm}
        img{display:block;width:auto;max-width:190mm;height:auto;max-height:267mm;margin:auto;object-fit:contain}
        @page{size:A4;margin:0}
      </style></head><body>
      ${pages.map(page => `<section class="page"><p class="title">${escHtml(page.title)}</p>${page.html}</section>`).join("")}
      </body></html>`);
    printDoc.close();
    await waitForPrintImages(printDoc);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const cleanup = () => {
      assets.forEach(asset => URL.revokeObjectURL(asset.assetUrl));
      frame.remove();
    };
    frame.contentWindow.addEventListener("afterprint", cleanup, { once: true });
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(cleanup, 60000);
  }

  async function printDocument(path, title) {
    await api.printDocument(path);
    const asset = await loadDocumentAsset(path);
    await printPreparedAssets([asset], title);
  }

  async function openDocumentPreview(path, title = fileName(path), paths = [path]) {
    const previewPaths = paths.length ? paths : [path];
    let currentIndex = Math.max(0, previewPaths.indexOf(path));
    let asset = await loadDocumentAsset(previewPaths[currentIndex]);
    const overlay = document.createElement("div");
    overlay.setAttribute("dir", "rtl");
    overlay.style.cssText = "position:fixed;inset:0;z-index:11000;background:rgba(0,0,0,.76);display:flex;flex-direction:column";
    overlay.innerHTML = `
      <div style="height:64px;background:#1f1f1f;border-bottom:1px solid #333;display:flex;align-items:center;gap:10px;padding:10px 18px">
        <strong id="document-preview-title" style="font-size:15px;margin-left:auto;color:#f3f4f6">${escHtml(asset.title)}</strong>
        ${previewPaths.length > 1 ? `
          <span id="document-preview-counter" class="badge badge-gray" dir="ltr"></span>
          <button type="button" id="document-preview-prev" class="btn-secondary" title="المرفق السابق" style="min-width:42px">↑</button>
          <button type="button" id="document-preview-next" class="btn-secondary" title="المرفق اللاحق" style="min-width:42px">↓</button>
        ` : ""}
        ${can(user, "documents.print") ? `<button type="button" id="document-preview-print" class="btn-primary">طباعة</button>` : ""}
        <button type="button" id="document-preview-close" class="btn-secondary">إغلاق</button>
      </div>
      <main id="document-preview-body" style="min-height:0;flex:1;padding:18px;background:#555"></main>`;

    function renderPreviewBody() {
      overlay.querySelector("#document-preview-title").textContent = asset.title;
      const counter = overlay.querySelector("#document-preview-counter");
      if (counter) counter.textContent = `${currentIndex + 1} / ${previewPaths.length}`;
      const prev = overlay.querySelector("#document-preview-prev");
      const next = overlay.querySelector("#document-preview-next");
      if (prev) prev.disabled = currentIndex === 0;
      if (next) next.disabled = currentIndex === previewPaths.length - 1;
      overlay.querySelector("#document-preview-body").innerHTML = asset.extension === "pdf"
        ? `<iframe src="${escHtml(asset.assetUrl)}" title="معاينة الوثيقة" style="display:block;width:100%;height:100%;border:0;background:#fff"></iframe>`
        : `<div style="width:100%;height:100%;overflow:auto;text-align:center;background:#d1d5db;padding:18px">
            <img src="${escHtml(asset.assetUrl)}" alt="${escHtml(asset.title)}" style="max-width:100%;height:auto;max-height:100%;object-fit:contain;background:#fff;box-shadow:0 3px 18px rgba(0,0,0,.25)">
          </div>`;
    }

    async function navigatePreview(direction) {
      const nextIndex = currentIndex + direction;
      if (nextIndex < 0 || nextIndex >= previewPaths.length) return;
      const oldAssetUrl = asset.assetUrl;
      currentIndex = nextIndex;
      try {
        asset = await loadDocumentAsset(previewPaths[currentIndex]);
        URL.revokeObjectURL(oldAssetUrl);
        renderPreviewBody();
      } catch (error) {
        currentIndex -= direction;
        showToast(error?.message ?? "تعذر فتح المرفق", "error");
      }
    }

    const close = () => {
      document.removeEventListener("keydown", onKeyDown);
      URL.revokeObjectURL(asset.assetUrl);
      overlay.remove();
    };
    const onKeyDown = event => {
      if (event.key === "Escape") close();
      if (event.key === "ArrowUp") navigatePreview(-1);
      if (event.key === "ArrowDown") navigatePreview(1);
    };
    overlay.querySelector("#document-preview-close").addEventListener("click", close);
    overlay.querySelector("#document-preview-prev")?.addEventListener("click", () => navigatePreview(-1));
    overlay.querySelector("#document-preview-next")?.addEventListener("click", () => navigatePreview(1));
    overlay.querySelector("#document-preview-print")?.addEventListener("click", async () => {
      try { await printDocument(previewPaths[currentIndex], asset.title); }
      catch (error) { showToast(error?.message ?? "تعذرت طباعة الوثيقة", "error"); }
    });
    renderPreviewBody();
    document.addEventListener("keydown", onKeyDown);
    document.body.append(overlay);
  }

  async function loadDocumentAsset(path) {
    const fullPath = await api.getDocumentPreviewPath(path);
    const response = await fetch(convertFileSrc(fullPath));
    if (!response.ok) throw new Error("تعذر تحميل ملف الوثيقة");
    const blob = await response.blob();
    return {
      path,
      title: fileName(path).replace(/^\d+_/, ""),
      extension: fileName(path).split(".").pop()?.toLowerCase(),
      assetUrl: URL.createObjectURL(blob),
    };
  }

  function documentPreviewContent(asset, printMode = false) {
    if (asset.extension === "pdf") {
      return `<object data="${escHtml(asset.assetUrl)}" type="application/pdf"
        style="display:block;width:100%;height:${printMode ? "270mm" : "720px"};border:0;background:#fff">
        <p>تعذر عرض ملف PDF.</p>
      </object>`;
    }
    return `<img src="${escHtml(asset.assetUrl)}" alt="${escHtml(asset.title)}"
      style="display:block;max-width:100%;width:auto;height:auto;max-height:${printMode ? "270mm" : "720px"};margin:auto;object-fit:contain">`;
  }

  async function printAllDocuments(paths, title) {
    for (const path of paths) await api.printDocument(path);
    const assets = await Promise.all(paths.map(loadDocumentAsset));
    await printPreparedAssets(assets, title);
  }

  async function openAllDocumentsPreview(paths, title) {
    const assets = await Promise.all(paths.map(loadDocumentAsset));
    const overlay = document.createElement("div");
    overlay.setAttribute("dir", "rtl");
    overlay.style.cssText = "position:fixed;inset:0;z-index:11000;background:rgba(0,0,0,.76);display:flex;flex-direction:column";
    overlay.innerHTML = `
      <div style="height:64px;background:#1f1f1f;border-bottom:1px solid #333;display:flex;align-items:center;gap:10px;padding:10px 18px">
        <strong style="font-size:15px;margin-left:auto;color:#f3f4f6">استعراض كل مرفقات: ${escHtml(title)}</strong>
        <span class="badge badge-gray">${assets.length} ملف</span>
        ${can(user, "documents.print") ? `<button type="button" id="all-documents-print" class="btn-primary">طباعة الكل</button>` : ""}
        <button type="button" id="all-documents-close" class="btn-secondary">إغلاق</button>
      </div>
      <main style="min-height:0;flex:1;overflow:auto;background:#555;padding:18px">
        ${assets.map((asset, index) => `
          <section style="max-width:1100px;margin:0 auto 18px;background:#d1d5db;padding:14px;border-radius:10px">
            <p style="margin:0 0 10px;color:#111827;font-weight:700">${index + 1}. ${escHtml(asset.title)}</p>
            ${documentPreviewContent(asset)}
          </section>`).join("")}
      </main>`;
    const close = () => {
      document.removeEventListener("keydown", onKeyDown);
      assets.forEach(asset => URL.revokeObjectURL(asset.assetUrl));
      overlay.remove();
    };
    const onKeyDown = event => { if (event.key === "Escape") close(); };
    overlay.querySelector("#all-documents-close").addEventListener("click", close);
    overlay.querySelector("#all-documents-print")?.addEventListener("click", async () => {
      try { await printAllDocuments(paths, title); }
      catch (error) { showToast(error?.message ?? "تعذرت طباعة المرفقات", "error"); }
    });
    document.addEventListener("keydown", onKeyDown);
    document.body.append(overlay);
  }

  function formatIncomingDate(value) {
    const match = String(value ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
    return match ? `${match[3]}/${match[2]}/${match[1]}` : "—";
  }

  function employeesWithDocs() {
    return employees.filter(e => parseAttachments(e).length > 0);
  }

  function matchesGeneralSearch(doc) {
    const attachments = generalDocAttachments(doc);
    if (generalFileFilter === "with" && attachments.length === 0) return false;
    if (generalFileFilter === "without" && attachments.length > 0) return false;
    if (generalDateFrom && (!doc.issue_date || doc.issue_date < generalDateFrom)) return false;
    if (generalDateTo && (!doc.issue_date || doc.issue_date > generalDateTo)) return false;
    if (generalMemoFilter === "yes" && !doc.is_internal_memo) return false;
    if (generalMemoFilter === "no" && doc.is_internal_memo) return false;

    const includesNeedle = (value, needle) => String(value ?? "").toLowerCase().includes(needle);
    const issuerNeedle = generalIssuerFilter.trim().toLowerCase();
    if (issuerNeedle && !includesNeedle(doc.title, issuerNeedle)) return false;
    const recipientNeedle = generalRecipientFilter.trim().toLowerCase();
    if (recipientNeedle && !includesNeedle(doc.doc_number, recipientNeedle)) return false;
    const subjectNeedle = generalSubjectFilter.trim().toLowerCase();
    if (subjectNeedle && !includesNeedle(doc.issuer, subjectNeedle)) return false;
    const countNeedle = generalCountFilter.trim().toLowerCase();
    if (countNeedle && !includesNeedle(doc.doc_count, countNeedle)) return false;
    const marginNeedle = generalMarginFilter.trim().toLowerCase();
    if (marginNeedle && !includesNeedle(doc.margin, marginNeedle)) return false;
    const employeeNeedle = generalEmployeeFilter.trim().toLowerCase();
    if (employeeNeedle && !(doc.employee_names ?? []).some(name => includesNeedle(name, employeeNeedle))) return false;

    const notesNeedle = generalNotesSearch.trim().toLowerCase();
    if (notesNeedle && !includesNeedle(doc.notes, notesNeedle)) return false;

    const needle = generalSearch.trim().toLowerCase();
    if (!needle) return true;
    return [
      doc.title,
      doc.doc_number,
      doc.issue_date,
      doc.issuer,
      doc.doc_count,
      doc.margin,
      doc.is_internal_memo ? "مذكرة داخلية" : "",
      doc.notes,
      ...attachments,
      ...(doc.employee_names ?? []),
    ].some(value => includesNeedle(value, needle));
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
    const filteredAttachmentPaths = filteredDocs.flatMap(doc => generalDocAttachments(doc));
    const advancedFilterCount = [
      generalNotesSearch,
      generalFileFilter !== "all",
      generalDateFrom,
      generalDateTo,
      generalIssuerFilter,
      generalRecipientFilter,
      generalSubjectFilter,
      generalCountFilter,
      generalMarginFilter,
      generalMemoFilter !== "all",
      generalEmployeeFilter,
    ].filter(Boolean).length;
    const hasActiveFilters = generalSearch || advancedFilterCount > 0;
    el.innerHTML = `
      <div class="space-y-4">
        ${compactArchiveMode ? "" : `<div class="card space-y-3">
          <div class="flex gap-3 items-center flex-wrap">
            <input id="general-doc-search" class="input-field flex-1 min-w-[220px]"
              placeholder="بحث في ${archiveName()}..." value="${escHtml(generalSearch)}" />
            <span class="badge badge-gray">${filteredDocs.length} / ${archiveDocs.length}</span>
            <button id="btn-toggle-general-filters" class="btn-secondary px-3 py-2"
              aria-expanded="${generalFiltersOpen ? "true" : "false"}">
              الفلاتر${advancedFilterCount ? ` (${advancedFilterCount})` : ""}
            </button>
            <button id="btn-add-doc" class="btn-primary px-4 py-2">+ إضافة وثيقة</button>
          </div>
          ${generalFiltersOpen ? `
          <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <p style="font-size:11px;color:#6b7280;margin-bottom:4px">الجهة المصدرة للوثيقة</p>
              <input id="general-issuer-filter" class="input-field"
                placeholder="فلترة حسب الجهة..." value="${escHtml(generalIssuerFilter)}" />
            </div>
            <div>
              <p style="font-size:11px;color:#6b7280;margin-bottom:4px">إلى</p>
              <input id="general-recipient-filter" class="input-field"
                placeholder="فلترة حسب الجهة المستلمة..." value="${escHtml(generalRecipientFilter)}" />
            </div>
            <div>
              <p style="font-size:11px;color:#6b7280;margin-bottom:4px">الموضوع</p>
              <input id="general-subject-filter" class="input-field"
                placeholder="فلترة حسب الموضوع..." value="${escHtml(generalSubjectFilter)}" />
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
            <div>
              <p style="font-size:11px;color:#6b7280;margin-bottom:4px">العدد</p>
              <input id="general-count-filter" class="input-field"
                placeholder="فلترة حسب العدد..." value="${escHtml(generalCountFilter)}" />
            </div>
            <div>
              <p style="font-size:11px;color:#6b7280;margin-bottom:4px">الهامش</p>
              <input id="general-margin-filter" class="input-field"
                placeholder="فلترة حسب الهامش..." value="${escHtml(generalMarginFilter)}" />
            </div>
            <div>
              <p style="font-size:11px;color:#6b7280;margin-bottom:4px">مذكرة داخلية</p>
              <select id="general-memo-filter" class="input-field">
                <option value="all" ${generalMemoFilter === "all" ? "selected" : ""}>الكل</option>
                <option value="yes" ${generalMemoFilter === "yes" ? "selected" : ""}>نعم</option>
                <option value="no" ${generalMemoFilter === "no" ? "selected" : ""}>لا</option>
              </select>
            </div>
            <div>
              <p style="font-size:11px;color:#6b7280;margin-bottom:4px">الموظفون المرتبطون</p>
              <input id="general-employee-filter" class="input-field"
                placeholder="فلترة باسم الموظف..." value="${escHtml(generalEmployeeFilter)}" />
            </div>
          </div>
          <div>
            <p style="font-size:11px;color:#6b7280;margin-bottom:4px">البحث في نبذة عامة عن الوثيقة</p>
            <input id="general-notes-search" class="input-field"
              placeholder="اكتب جزءا من نبذة الوثيقة..." value="${escHtml(generalNotesSearch)}" />
          </div>
          <div class="flex justify-end">
            ${hasActiveFilters ? `<button id="btn-clear-general-filters" class="btn-secondary px-3 py-2">مسح الفلاتر</button>` : ""}
            ${can(user, "documents.print") ? `<button id="btn-print-filtered-attachments" class="btn-primary px-3 py-2" style="margin-right:8px">طباعة مرفقات النتائج</button>` : ""}
            <button id="btn-close-general-filters" class="btn-secondary px-3 py-2" style="margin-right:8px">إغلاق</button>
          </div>
          ` : ""}
        </div>`}
        <div class="card overflow-auto">
          <table class="w-full">
            <thead><tr>
              <th class="table-header">الجهة المصدرة للوثيقة</th>
              <th class="table-header">إلى</th>
              <th class="table-header">تاريخ الإصدار</th>
              <th class="table-header">الموضوع</th>
              <th class="table-header">العدد</th>
              <th class="table-header">الهامش</th>
              <th class="table-header">مذكرة داخلية</th>
              <th class="table-header">الموظفون المرتبطون</th>
              <th class="table-header">ملف</th>
              <th class="table-header">إجراء</th>
            </tr></thead>
            <tbody>
              ${archiveDocs.length === 0
                ? `<tr><td colspan="10" class="table-cell text-center text-gray-500 py-8">لا توجد وثائق</td></tr>`
                : filteredDocs.length === 0
                  ? `<tr><td colspan="10" class="table-cell text-center text-gray-500 py-8">لا توجد نتائج مطابقة</td></tr>`
                  : filteredDocs.map(d => `
                  <tr class="table-row general-doc-row" data-id="${d.id}" title="اضغط لتعديل الوثيقة">
                    <td class="table-cell font-medium text-gray-100">${escHtml(d.title || "—")}</td>
                    <td class="table-cell" dir="ltr">${escHtml(d.doc_number ?? "—")}</td>
                    <td class="table-cell" dir="ltr">${formatIncomingDate(d.issue_date)}</td>
                    <td class="table-cell">${escHtml(d.issuer ?? "—")}</td>
                    <td class="table-cell">${escHtml(d.doc_count ?? "—")}</td>
                    <td class="table-cell">${escHtml(d.margin ?? "—")}</td>
                    <td class="table-cell">${d.is_internal_memo ? `<span class="badge badge-green">نعم</span>` : "—"}</td>
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
    if (!can(user, "documents.manage")) el.querySelectorAll("#btn-add-doc,#btn-save-doc").forEach(node => node.remove());
    if (!can(user, "documents.delete")) el.querySelectorAll(".btn-del-doc,.btn-manager-delete").forEach(node => node.remove());
    if (!can(user, "documents.upload")) el.querySelectorAll("#attachment-manager-add").forEach(node => node.remove());

    el.querySelector("#btn-toggle-general-filters")?.addEventListener("click", () => {
      generalFiltersOpen = !generalFiltersOpen;
      renderGeneral();
    });
    el.querySelector("#btn-close-general-filters")?.addEventListener("click", () => {
      generalFiltersOpen = false;
      renderGeneral();
    });
    el.querySelector("#btn-print-filtered-attachments")?.addEventListener("click", async () => {
      if (filteredAttachmentPaths.length === 0) {
        showToast("لا توجد مرفقات ضمن نتائج الفلتر", "error");
        return;
      }
      try {
        await printAllDocuments(filteredAttachmentPaths, `مرفقات نتائج فلتر ${archiveName()}`);
      } catch (error) {
        showToast(error?.message ?? "تعذرت طباعة مرفقات النتائج", "error");
      }
    });

    const restoreFocus = () => {
      if (!focusedId) return;
      const focused = el.querySelector(`#${focusedId}`);
      focused?.focus();
      if (["general-doc-search", "general-notes-search", "general-issuer-filter", "general-recipient-filter",
        "general-subject-filter", "general-count-filter", "general-margin-filter", "general-employee-filter"].includes(focusedId)) {
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
    el.querySelector("#general-issuer-filter")?.addEventListener("input", (event) => {
      generalIssuerFilter = event.target.value;
      renderGeneral();
    });
    el.querySelector("#general-recipient-filter")?.addEventListener("input", (event) => {
      generalRecipientFilter = event.target.value;
      renderGeneral();
    });
    el.querySelector("#general-subject-filter")?.addEventListener("input", (event) => {
      generalSubjectFilter = event.target.value;
      renderGeneral();
    });
    el.querySelector("#general-count-filter")?.addEventListener("input", (event) => {
      generalCountFilter = event.target.value;
      renderGeneral();
    });
    el.querySelector("#general-margin-filter")?.addEventListener("input", (event) => {
      generalMarginFilter = event.target.value;
      renderGeneral();
    });
    el.querySelector("#general-memo-filter")?.addEventListener("change", (event) => {
      generalMemoFilter = event.target.value;
      renderGeneral();
    });
    el.querySelector("#general-employee-filter")?.addEventListener("input", (event) => {
      generalEmployeeFilter = event.target.value;
      renderGeneral();
    });
    el.querySelector("#btn-clear-general-filters")?.addEventListener("click", () => {
      generalSearch = "";
      generalNotesSearch = "";
      generalFileFilter = "all";
      generalDateFrom = "";
      generalDateTo = "";
      generalIssuerFilter = "";
      generalRecipientFilter = "";
      generalSubjectFilter = "";
      generalCountFilter = "";
      generalMarginFilter = "";
      generalMemoFilter = "all";
      generalEmployeeFilter = "";
      renderGeneral();
    });

    el.querySelector("#btn-add-doc")?.addEventListener("click", () => showDocForm());

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
      overlay.querySelector("#attachment-manager-title").textContent = doc.title || "وثيقة بدون جهة مصدرة";
      const content = overlay.querySelector("#attachment-manager-content");
      content.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px">
          <span class="badge ${attachments.length ? "badge-green" : "badge-gray"}" style="gap:6px;padding:5px 11px">
            <span>📎</span><span dir="ltr">${attachments.length} / 20</span>
          </span>
          <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap">
            ${attachments.length ? `<button type="button" id="attachment-manager-preview-all" class="btn-secondary">استعراض الكل</button>` : ""}
            ${attachments.length && can(user, "documents.print") ? `<button type="button" id="attachment-manager-print-all" class="btn-secondary">طباعة الكل</button>` : ""}
            ${attachments.length && can(user, "documents.delete") ? `<button type="button" id="attachment-manager-delete-all" class="btn-danger">حذف الكل</button>` : ""}
            ${attachments.length < 20
              ? `<button type="button" id="attachment-manager-add" class="btn-secondary">إضافة ملفات</button>`
              : `<span style="font-size:11px;color:#6b7280">تم الوصول إلى الحد الأقصى</span>`}
          </div>
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
                  <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                    ${can(user, "documents.manage") ? `
                      <button type="button" class="btn-secondary text-xs btn-manager-move" data-direction="up"
                        data-path="${escHtml(path)}" ${index === 0 ? "disabled" : ""} title="رفع المرفق درجة">↑</button>
                      <button type="button" class="btn-secondary text-xs btn-manager-move" data-direction="down"
                        data-path="${escHtml(path)}" ${index === attachments.length - 1 ? "disabled" : ""} title="تنزيل المرفق درجة">↓</button>` : ""}
                    <button type="button" class="btn-secondary text-xs btn-manager-preview" data-path="${escHtml(path)}">استعراض</button>
                    ${can(user, "documents.print") ? `<button type="button" class="btn-secondary text-xs btn-manager-print" data-path="${escHtml(path)}">طباعة</button>` : ""}
                    <button type="button" class="btn-danger text-xs btn-manager-delete" data-path="${escHtml(path)}">حذف</button>
                  </div>
                </div>`).join("")
            : `<p style="padding:28px;text-align:center;color:#6b7280;font-size:13px">لا توجد مرفقات لهذه الوثيقة</p>`}
        </div>`;

      if (!can(user, "documents.upload")) content.querySelector("#attachment-manager-add")?.remove();
      if (!can(user, "documents.delete")) content.querySelectorAll(".btn-manager-delete").forEach(node => node.remove());
      content.querySelectorAll(".btn-manager-move").forEach(button => {
        button.addEventListener("click", async () => {
          try {
            await moveCurrentDocAttachment(docId, button.dataset.path, button.dataset.direction);
            await refreshCurrentDocs();
            renderManager();
          } catch (error) { showToast(error?.message ?? "تعذر تغيير ترتيب المرفق", "error"); }
        });
      });
      content.querySelector("#attachment-manager-preview-all")?.addEventListener("click", async () => {
        try { await openAllDocumentsPreview(attachments, doc.title); }
        catch (error) { showToast(error?.message ?? "تعذر استعراض المرفقات", "error"); }
      });
      content.querySelector("#attachment-manager-print-all")?.addEventListener("click", async () => {
        try { await printAllDocuments(attachments, doc.title); }
        catch (error) { showToast(error?.message ?? "تعذرت طباعة المرفقات", "error"); }
      });
      content.querySelector("#attachment-manager-delete-all")?.addEventListener("click", async () => {
        if (!(await confirmAction(`تأكيد حذف جميع مرفقات الوثيقة (${attachments.length} ملف)؟ لا يمكن التراجع عن هذا الإجراء.`))) return;
        try {
          for (const path of attachments) await deleteCurrentDocAttachment(docId, path);
          await refreshCurrentDocs();
          showToast(`تم حذف جميع مرفقات الوثيقة (${attachments.length} ملف)`);
          renderManager();
        } catch (error) {
          await refreshCurrentDocs();
          renderManager();
          showToast(error?.message ?? "تعذر حذف جميع المرفقات", "error");
        }
      });
      content.querySelectorAll(".btn-manager-preview").forEach(button => {
        button.addEventListener("click", async () => {
          try { await openDocumentPreview(button.dataset.path, fileName(button.dataset.path), attachments); }
          catch (error) { showToast(error?.message ?? "تعذر استعراض الوثيقة", "error"); }
        });
      });
      content.querySelectorAll(".btn-manager-print").forEach(button => {
        button.addEventListener("click", async () => {
          try { await printDocument(button.dataset.path, fileName(button.dataset.path)); }
          catch (error) { showToast(error?.message ?? "تعذرت طباعة الوثيقة", "error"); }
        });
      });
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
    let pendingAttachments = [];
    let formDirty = false;
    const selectedEmployeeIds = new Set(doc?.employee_ids ?? []);
    const hasEmployeeLinks = selectedEmployeeIds.size > 0;
    el.innerHTML = `
      <div id="doc-form-stage" style="min-height:calc(100vh - 190px);padding:20px 0 20px 56px">
        <div id="doc-form-card" class="card max-w-2xl space-y-4">
          <p class="section-title">${isEdit ? "تعديل وثيقة" : "إضافة وثيقة جديدة"}</p>
          <div>
            <p style="font-size:11px;color:#6b7280;margin-bottom:4px">الجهة المصدرة للوثيقة</p>
            <input id="d-title" class="input-field" placeholder="الجهة المصدرة للوثيقة" value="${escHtml(doc?.title ?? "")}" />
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <p style="font-size:11px;color:#6b7280;margin-bottom:4px">إلى</p>
              <input id="d-number" class="input-field" value="${escHtml(doc?.doc_number ?? "")}" />
            </div>
            <div>
              <p style="font-size:11px;color:#6b7280;margin-bottom:4px">الموضوع</p>
              <input id="d-issuer" class="input-field" value="${escHtml(doc?.issuer ?? "")}" />
            </div>
            <div>
              <p style="font-size:11px;color:#6b7280;margin-bottom:4px">تاريخ الإصدار</p>
              <input id="d-date" class="input-field" type="date" value="${escHtml(doc?.issue_date ?? "")}" />
            </div>
            <div>
              <p style="font-size:11px;color:#6b7280;margin-bottom:4px">العدد</p>
              <input id="d-count" class="input-field" value="${escHtml(doc?.doc_count ?? "")}" />
            </div>
          </div>
          <div>
            <p style="font-size:11px;color:#6b7280;margin-bottom:4px">نبذه عامة عن الوثيقة</p>
            <textarea id="d-notes" class="input-field" style="height:70px;resize:none">${escHtml(doc?.notes ?? "")}</textarea>
          </div>
          <div>
            <p style="font-size:11px;color:#6b7280;margin-bottom:4px">الهامش</p>
            <textarea id="d-margin" class="input-field" style="height:70px;resize:none">${escHtml(doc?.margin ?? "")}</textarea>
          </div>
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:#d1d5db">
            <input id="d-internal-memo" type="checkbox" ${doc?.is_internal_memo ? "checked" : ""}
              style="width:16px;height:16px;accent-color:#5da12c" />
            مذكرة داخلية
          </label>
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
          <div style="border-top:1px solid #2d2d2d;padding-top:12px;display:flex;align-items:center;justify-content:space-between;gap:12px">
            <div>
              <p style="font-size:12px;font-weight:700;color:#d1d5db">مرفقات الوثيقة</p>
              <p style="font-size:11px;color:#6b7280;margin-top:3px">${isEdit ? "اضغط على الأيقونة لإدارة الملفات المرفقة" : "اختر المرفقات وسيتم رفعها بعد حفظ الوثيقة"}</p>
            </div>
            <div style="display:flex;align-items:center;gap:8px">
              <button type="button" id="d-scan-attachment" class="btn-secondary" title="مسح وثيقة ضوئياً">
                <svg aria-hidden="true" viewBox="0 0 24 24" style="width:17px;height:17px;fill:none;stroke:currentColor;stroke-width:1.8">
                  <path d="M7 3h10v5H7zM5 14h14v7H5zM4 8h16a2 2 0 0 1 2 2v6h-3M5 16H2v-6a2 2 0 0 1 2-2"/>
                  <path d="M8 17h8M8 19h8M18 11h.01"/>
                </svg>
                <span>ماسح ضوئي</span>
              </button>
              <button type="button" id="d-manage-attachments" title="إدارة مرفقات الوثيقة"
                style="border:none;background:transparent;cursor:pointer;padding:2px">
                <span class="badge ${isEdit && generalDocAttachments(doc).length ? "badge-green" : "badge-gray"}"
                  style="gap:6px;font-size:12px;padding:5px 11px">
                  <span>📎</span>
                  <span dir="ltr">${isEdit ? generalDocAttachments(doc).length : 0} / 20</span>
                </span>
              </button>
            </div>
          </div>
          <div class="flex gap-3">
            <button id="btn-save-doc" class="btn-primary flex-1">حفظ</button>
            <button id="btn-cancel-doc" class="btn-secondary">إلغاء</button>
          </div>
        </div>
      </div>`;
    if (!can(user, "documents.upload")) el.querySelector("#btn-upload-emp-doc")?.remove();
    if (!can(user, "documents.delete")) el.querySelectorAll(".btn-del-emp-doc").forEach(node => node.remove());

    if (!can(user, "documents.manage")) {
      el.querySelector("#btn-save-doc")?.remove();
      el.querySelectorAll("input,select,textarea").forEach(field => { field.disabled = true; });
    }
    if (!can(user, "documents.upload")) {
      el.querySelector("#d-manage-attachments")?.remove();
      el.querySelector("#d-scan-attachment")?.remove();
    }

    const collectDocData = () => ({
      title: el.querySelector("#d-title")?.value.trim() || "",
      doc_type: null,
      doc_number: el.querySelector("#d-number")?.value.trim() || null,
      issue_date: el.querySelector("#d-date")?.value || null,
      issuer: el.querySelector("#d-issuer")?.value.trim() || null,
      doc_count: el.querySelector("#d-count")?.value.trim() || null,
      margin: el.querySelector("#d-margin")?.value.trim() || null,
      is_internal_memo: Boolean(el.querySelector("#d-internal-memo")?.checked),
      notes: el.querySelector("#d-notes")?.value.trim() || null,
      employee_ids: el.querySelector("#d-has-employees")?.checked
        ? [...el.querySelectorAll(".d-employee-checkbox:checked")]
            .map(checkbox => parseInt(checkbox.value, 10))
            .sort((a, b) => a - b)
        : [],
    });
    const initialDocData = JSON.stringify(collectDocData());
    const hasUnsavedDocChanges = () =>
      can(user, "documents.manage") && (formDirty || pendingAttachments.length > 0 || JSON.stringify(collectDocData()) !== initialDocData);
    const saveDoc = async (skipConfirm = false) => {
      if (!skipConfirm && !(await confirmAction(isEdit ? "تأكيد حفظ تعديلات الوثيقة؟" : "تأكيد إضافة الوثيقة؟"))) return false;
      try {
        const data = collectDocData();
        if (isEdit) {
          await updateCurrentDoc(doc.id, data);
        } else {
          const created = await createCurrentDoc(data);
          for (const file of pendingAttachments) await uploadCurrentDocFile(created.id, file);
        }
        await refreshCurrentDocs();
        activeDocFormGuard = null;
        showToast(isEdit ? "تم حفظ تعديلات الوثيقة" : "تمت إضافة الوثيقة");
        renderGeneral();
        return true;
      } catch (err) {
        showToast(err?.message ?? "خطأ", "error");
        return false;
      }
    };
    const closeDocForm = async () => {
      if (hasUnsavedDocChanges()) {
        const choice = await confirmSaveChanges();
        if (choice === "cancel") return false;
        if (choice === "save") return await saveDoc(true);
      }
      activeDocFormGuard = null;
      renderGeneral();
      return true;
    };
    activeDocFormGuard = closeDocForm;
    el.querySelector("#doc-form-stage")?.addEventListener("click", event => {
      if (event.target === event.currentTarget) closeDocForm();
    });
    el.querySelectorAll("#doc-form-card input,#doc-form-card select,#doc-form-card textarea").forEach(field => {
      field.addEventListener("input", () => { formDirty = true; });
      field.addEventListener("change", () => { formDirty = true; });
    });

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
    el.querySelector("#d-manage-attachments")?.addEventListener("click", async () => {
      if (isEdit) {
        openAttachmentManager(doc.id, false);
        return;
      }
      const selected = await open({
        multiple: true,
        filters: [{ name: "ملفات الوثائق", extensions: ["jpg", "jpeg", "pdf"] }],
      });
      if (!selected) return;
      const files = Array.isArray(selected) ? selected : [selected];
      pendingAttachments = [...new Set([...pendingAttachments, ...files])].slice(0, 20);
      formDirty = true;
      const badge = el.querySelector("#d-manage-attachments .badge");
      badge.classList.toggle("badge-green", pendingAttachments.length > 0);
      badge.classList.toggle("badge-gray", pendingAttachments.length === 0);
      badge.querySelector("[dir='ltr']").textContent = `${pendingAttachments.length} / 20`;
      showToast(`تم اختيار ${pendingAttachments.length} مرفق وسيتم رفعها بعد الحفظ`);
    });
    el.querySelector("#d-scan-attachment")?.addEventListener("click", async () => {
      const attachmentCount = isEdit ? generalDocAttachments(doc).length : pendingAttachments.length;
      if (attachmentCount >= 20) {
        showToast("تم الوصول إلى الحد الأقصى للمرفقات", "warn");
        return;
      }
      const button = el.querySelector("#d-scan-attachment");
      button.disabled = true;
      try {
        const scannedPath = await api.scanDocument();
        if (isEdit) {
          await uploadCurrentDocFile(doc.id, scannedPath);
          await refreshCurrentDocs();
          showToast("تم مسح الوثيقة وإضافتها إلى المرفقات");
          showDocForm(currentDocs().find(item => item.id === doc.id));
          return;
        }
        pendingAttachments = [...new Set([...pendingAttachments, scannedPath])].slice(0, 20);
        formDirty = true;
        const badge = el.querySelector("#d-manage-attachments .badge");
        badge.classList.add("badge-green");
        badge.classList.remove("badge-gray");
        badge.querySelector("[dir='ltr']").textContent = `${pendingAttachments.length} / 20`;
        showToast("تم مسح الوثيقة وستُرفع بعد الحفظ");
      } catch (error) {
        showToast(error?.message ?? String(error || "تعذر استخدام الماسح الضوئي"), "error");
      } finally {
        button.disabled = false;
      }
    });

    el.querySelector("#btn-cancel-doc").addEventListener("click", () => closeDocForm());
    el.querySelector("#btn-save-doc")?.addEventListener("click", () => saveDoc(false));
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
                            ${can(user, "documents.download") ? `<button class="btn-secondary text-xs px-2 py-1 btn-download-emp-doc"
                              data-path="${escHtml(path)}">تنزيل</button>` : ""}
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
    el.querySelectorAll(".btn-download-emp-doc").forEach(btn => {
      btn.addEventListener("click", async () => {
        const destination = await open({ directory: true, multiple: false });
        if (!destination) return;
        try { showToast(`تم تنزيل الوثيقة إلى ${await api.downloadDocument(btn.dataset.path, destination)}`); }
        catch (err) { showToast(err?.message ?? "تعذر تنزيل الوثيقة", "error"); }
      });
    });
  }

  container.innerHTML = html();

  container.querySelectorAll(".doc-tab").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (activeDocFormGuard && !(await activeDocFormGuard())) return;
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
  if (initialEditDocId !== null) {
    const doc = currentDocs().find(item => item.id === initialEditDocId);
    if (doc) showDocForm(doc);
    else showToast("تعذر العثور على الوثيقة المطلوبة", "warn");
  } else if (initialManageAttachmentDocId !== null) {
    const doc = currentDocs().find(item => item.id === initialManageAttachmentDocId);
    if (doc) openAttachmentManager(doc.id);
    else showToast("تعذر العثور على الوثيقة المطلوبة", "warn");
  }
}
