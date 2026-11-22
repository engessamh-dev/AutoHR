/**
 * documents.js — General + per-employee document archive
 */
import { isScannable, reprocessAttachment } from "../attachments/scanner.js";
import { api }       from "../api.js";
import { showToast, escHtml, confirmAction, confirmSaveChanges } from "../utils.js";
import { open, save } from "@tauri-apps/plugin-dialog";
import { can }       from "../permissions.js";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
const DOCUMENT_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx"];

export async function renderDocuments(container, user, ctx) {
  let [generalDocs, outgoingDocs, employees, documentTypes] = await Promise.all([
    api.listGeneralDocs(),
    api.listOutgoingDocs(),
    api.listEmployees(),
    api.getDocumentTypes().catch(() => []),
  ]);

  async function downloadStoredFile(path) {
    const downloadName = (await api.getDocumentDownloadName(path)).replace(/^\d+_/, "");
    const extension = downloadName.includes(".") ? downloadName.split(".").pop() : "";
    const destination = await save({
      title: "حفظ الملف باسم",
      defaultPath: downloadName,
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

  async function saveDocumentTypes(types) {
    documentTypes = await api.setDocumentTypes(types);
  }

  async function printablePages(asset) {
    if (asset.extension !== "pdf") {
      return [{ title: asset.title, html: `<img src="${escHtml(asset.assetUrl)}" alt="${escHtml(asset.title)}">` }];
    }
    const bytes = await (await fetch(asset.assetUrl)).arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: bytes });
    const pdf = await loadingTask.promise;
    const pages = [];
    try {
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
    } finally {
      await pdf.cleanup?.();
      await loadingTask.destroy();
    }
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
        ${can(user, "documents.download") ? `<button type="button" id="document-preview-download" class="btn-secondary">تحميل</button>` : ""}
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
      const isImage = ["jpg", "jpeg", "png", "webp"].includes(asset.extension);
      overlay.querySelector("#document-preview-body").innerHTML = asset.extension === "pdf"
        ? `<iframe src="${escHtml(asset.assetUrl)}" title="معاينة الوثيقة" style="display:block;width:100%;height:100%;border:0;background:#fff"></iframe>`
        : isImage ? `<div style="width:100%;height:100%;overflow:auto;text-align:center;background:#d1d5db;padding:18px">
            <img src="${escHtml(asset.assetUrl)}" alt="${escHtml(asset.title)}" style="max-width:100%;height:auto;max-height:100%;object-fit:contain;background:#fff;box-shadow:0 3px 18px rgba(0,0,0,.25)">
          </div>`
        : `<div style="display:grid;place-items:center;width:100%;height:100%;background:#d1d5db;color:#374151;text-align:center;padding:24px">
            <div><p style="font-size:18px;font-weight:700;margin-bottom:8px">لا تتوفر معاينة داخلية لهذا النوع من الملفات</p><p>يمكنك تحميل الملف وفتحه ببرنامج Office المناسب.</p></div>
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
    overlay.querySelector("#document-preview-download")?.addEventListener("click", () => {
      downloadStoredFile(previewPaths[currentIndex]);
    });
    renderPreviewBody();
    document.addEventListener("keydown", onKeyDown);
    document.body.append(overlay);
  }

  async function loadDocumentAsset(path) {
    const extension = fileName(path).split(".").pop()?.toLowerCase();
    let mimeType = extension === "pdf" ? "application/pdf"
      : extension === "png" ? "image/png"
      : ["jpg", "jpeg"].includes(extension) ? "image/jpeg"
      : "application/octet-stream";
    const bytes = await api.readDocument(path);
    if (bytes[0] === 255 && bytes[1] === 216) mimeType = "image/jpeg";
    else if (extension === "webp") mimeType = "image/webp";
    const blob = new Blob([new Uint8Array(bytes)], { type: mimeType });
    return {
      path,
      title: fileName(path).replace(/^\d+_/, ""),
      extension,
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
              فلاتر البحث${advancedFilterCount ? ` (${advancedFilterCount})` : ""}
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
              <th class="table-header">المرفقات</th>
            </tr></thead>
            <tbody>
              ${archiveDocs.length === 0
                ? `<tr><td colspan="9" class="table-cell text-center text-gray-500 py-8">لا توجد وثائق</td></tr>`
                : filteredDocs.length === 0
                  ? `<tr><td colspan="9" class="table-cell text-center text-gray-500 py-8">لا توجد نتائج مطابقة</td></tr>`
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
                          <span dir="ltr">${generalDocAttachments(d).length}</span>
                        </span>
                      </button>
                    </td>
                  </tr>`).join("")}
            </tbody>
          </table>
        </div>
      </div>`;
    if (!can(user, "documents.manage")) el.querySelectorAll("#btn-add-doc,#btn-save-doc").forEach(node => node.remove());
    if (!can(user, "documents.delete")) 
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

    el.querySelectorAll(".btn-manage-doc-attachments").forEach(btn => {
      btn.addEventListener("click", () => openAttachmentManager(parseInt(btn.dataset.id, 10)));
    });

    restoreFocus();
  }

  function attachmentKind(path) {
    const ext = fileName(path).split(".").pop()?.toLowerCase() ?? "";
    if (ext === "pdf") return { ext, label: "ملف PDF", short: "PDF", image: false };
    if (["jpg", "jpeg", "png", "webp"].includes(ext)) return { ext, label: `صورة ${ext.toUpperCase()}`, short: ext.toUpperCase(), image: true };
    if (["doc", "docx"].includes(ext)) return { ext, label: "ملف Word", short: "DOC", image: false };
    if (["xls", "xlsx"].includes(ext)) return { ext, label: "ملف Excel", short: "XLS", image: false };
    if (["ppt", "pptx"].includes(ext)) return { ext, label: "ملف PowerPoint", short: "PPT", image: false };
    return { ext, label: ext ? `ملف ${ext.toUpperCase()}` : "ملف", short: ext.toUpperCase().slice(0, 4) || "FILE", image: false };
  }

  function openAttachmentManager(docId, returnToTable = true) {
    const thumbCache = new Map();
    let closeMenu = () => {};
    const overlay = document.createElement("div");
    overlay.setAttribute("dir", "rtl");
    overlay.className = "att-overlay";
    overlay.innerHTML = `
      <div class="att-dialog" role="dialog" aria-modal="true" aria-labelledby="attachment-manager-heading">
        <div class="att-head">
          <div class="att-head-text">
            <p id="attachment-manager-heading" class="att-title">مرفقات الوثيقة</p>
            <p id="attachment-manager-title" class="att-subtitle"></p>
          </div>
          <button type="button" id="attachment-manager-close" class="att-icon-btn" title="إغلاق (Esc)" aria-label="إغلاق">✕</button>
        </div>
        <div id="attachment-manager-content" class="att-body"></div>
      </div>`;
    document.body.append(overlay);

    const close = () => {
      closeMenu();
      document.removeEventListener("keydown", onKeyDown);
      thumbCache.forEach(url => { if (url) URL.revokeObjectURL(url); });
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
          if (countText) countText.textContent = String(count);
        }
      }
    };
    const onKeyDown = event => {
      if (event.key !== "Escape") return;
      if (overlay.querySelector(".att-menu")) { closeMenu(); return; }
      close();
    };
    overlay.querySelector("#attachment-manager-close").addEventListener("click", close);
    overlay.addEventListener("click", event => { if (event.target === overlay) close(); });
    document.addEventListener("keydown", onKeyDown);

    // One floating menu at a time, positioned next to the button that opened it.
    const openMenu = (anchor, items) => {
      const wasOpenFor = overlay.querySelector(".att-menu")?.dataset.anchorId;
      closeMenu();
      if (wasOpenFor && wasOpenFor === anchor.dataset.menuId) return;
      const menu = document.createElement("div");
      menu.className = "att-menu";
      menu.setAttribute("role", "menu");
      menu.dataset.anchorId = anchor.dataset.menuId;
      items.forEach(item => {
        if (item === "sep") { menu.append(Object.assign(document.createElement("hr"))); return; }
        const button = document.createElement("button");
        button.type = "button";
        button.setAttribute("role", "menuitem");
        button.className = item.danger ? "att-menu-item att-menu-danger" : "att-menu-item";
        button.textContent = item.label;
        button.disabled = Boolean(item.disabled);
        button.addEventListener("click", async () => { closeMenu(); await item.run(); });
        menu.append(button);
      });
      overlay.append(menu);
      const rect = anchor.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      const top = rect.bottom + 4 + menuRect.height > window.innerHeight - 8 ? rect.top - menuRect.height - 4 : rect.bottom + 4;
      menu.style.top = `${Math.max(8, top)}px`;
      menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menuRect.width - 8))}px`;
      anchor.setAttribute("aria-expanded", "true");
      const onOutside = event => { if (!menu.contains(event.target) && event.target !== anchor) closeMenu(); };
      setTimeout(() => document.addEventListener("click", onOutside, true));
      closeMenu = () => {
        document.removeEventListener("click", onOutside, true);
        anchor.setAttribute("aria-expanded", "false");
        menu.remove();
        closeMenu = () => {};
      };
      menu.querySelector("button:not(:disabled)")?.focus();
    };

    const loadThumbnails = async () => {
      const images = [...overlay.querySelectorAll(".att-thumb[data-thumb-path]")];
      for (const holder of images) {
        const path = holder.dataset.thumbPath;
        if (!thumbCache.has(path)) {
          try { thumbCache.set(path, (await loadDocumentAsset(path)).assetUrl); }
          catch { thumbCache.set(path, ""); }
        }
        const url = thumbCache.get(path);
        if (url && holder.isConnected) holder.innerHTML = `<img src="${escHtml(url)}" alt="">`;
      }
    };

    const renderManager = () => {
      closeMenu();
      const doc = currentDocs().find(item => item.id === docId);
      if (!doc) { close(); return; }
      const attachments = generalDocAttachments(doc);
      overlay.querySelector("#attachment-manager-title").textContent = doc.title || "وثيقة بدون جهة مصدرة";
      const content = overlay.querySelector("#attachment-manager-content");
      const canUpload = can(user, "documents.upload");
      const canPrint = can(user, "documents.print");
      const canDelete = can(user, "documents.delete");
      const canDownload = can(user, "documents.download");
      const canManage = can(user, "documents.manage");
      const atLimit = attachments.length >= 20;
      content.innerHTML = `
        <div class="att-toolbar">
          <span class="att-count"><b dir="ltr">${attachments.length}</b> ${attachments.length === 1 ? "ملف" : "ملفات"} من 20</span>
          ${attachments.length ? `<button type="button" id="attachment-manager-preview-all" class="btn-secondary att-btn">استعراض الكل</button>` : ""}
          ${canUpload ? (atLimit
            ? `<span class="att-limit">تم الوصول إلى الحد الأقصى</span>`
            : `<button type="button" id="attachment-manager-add" class="btn-primary att-btn">＋ إضافة ملفات</button>`) : ""}
          ${attachments.length && (canPrint || canDownload || canDelete)
            ? `<button type="button" id="attachment-manager-more" class="att-icon-btn" data-menu-id="all" aria-haspopup="menu" aria-expanded="false" title="إجراءات على كل المرفقات" aria-label="إجراءات على كل المرفقات">⋯</button>`
            : ""}
        </div>
        ${attachments.length ? `
          <ul class="att-list">
            ${attachments.map((path, index) => {
              const kind = attachmentKind(path);
              return `
                <li class="att-row" data-index="${index}" tabindex="0" title="اضغط للاستعراض">
                  <span class="att-thumb ${kind.image ? "" : `att-thumb-file att-thumb-${escHtml(kind.ext)}`}" ${kind.image ? `data-thumb-path="${escHtml(path)}"` : ""}>${escHtml(kind.short)}</span>
                  <span class="att-info">
                    <span class="att-name">مرفق ${index + 1}</span>
                    <span class="att-meta">${escHtml(kind.label)}</span>
                  </span>
                  <span class="att-actions">
                    <button type="button" class="att-icon-btn att-act-preview" title="استعراض" aria-label="استعراض مرفق ${index + 1}">
                      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>
                    </button>
                    ${canPrint ? `<button type="button" class="att-icon-btn att-act-print" title="طباعة" aria-label="طباعة مرفق ${index + 1}">
                      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 9V3h10v6M7 17H4v-6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v6h-3M7 14h10v7H7z"/></svg>
                    </button>` : ""}
                    <button type="button" class="att-icon-btn att-act-more" data-menu-id="row-${index}" aria-haspopup="menu" aria-expanded="false" title="مزيد من الإجراءات" aria-label="مزيد من الإجراءات لمرفق ${index + 1}">⋯</button>
                  </span>
                </li>`;
            }).join("")}
          </ul>`
          : `<div class="att-empty">
              <p>لا توجد مرفقات لهذه الوثيقة</p>
              ${canUpload ? `<p class="att-empty-hint">اضغط «إضافة ملفات» لرفع PDF أو صور (حتى 20 ملفاً)</p>` : ""}
            </div>`}`;

      const runSafely = async (task, fallback) => {
        try { await task(); }
        catch (error) { showToast(error?.message ?? fallback, "error"); }
      };
      const previewAt = index => runSafely(
        () => openDocumentPreview(attachments[index], fileName(attachments[index]), attachments),
        "تعذر استعراض الوثيقة");
      const printAt = index => runSafely(
        () => printDocument(attachments[index], fileName(attachments[index])),
        "تعذرت طباعة الوثيقة");
      const moveAt = (index, direction) => runSafely(async () => {
        await moveCurrentDocAttachment(docId, attachments[index], direction);
        await refreshCurrentDocs();
        renderManager();
      }, "تعذر تغيير ترتيب المرفق");
      const deleteAt = index => runSafely(async () => {
        if (!(await confirmAction(`تأكيد حذف «مرفق ${index + 1}»؟`))) return;
        const path = attachments[index];
        await deleteCurrentDocAttachment(docId, path);
        if (thumbCache.get(path)) URL.revokeObjectURL(thumbCache.get(path));
        thumbCache.delete(path);
        await refreshCurrentDocs();
        showToast("تم حذف المرفق");
        renderManager();
      }, "تعذر حذف المرفق");
      const reprocessAt = index => runSafely(async () => {
        const path = attachments[index];
        if (await reprocessAttachment(path)) {
          if (thumbCache.get(path)) URL.revokeObjectURL(thumbCache.get(path));
          thumbCache.delete(path);
          showToast("حُفظت النسخة المعالجة مع الحفاظ على الأصل");
          await refreshCurrentDocs();
          renderManager();
        }
      }, "تعذرت معالجة الصورة");

      content.querySelectorAll(".att-row").forEach(row => {
        const index = Number(row.dataset.index);
        row.addEventListener("click", event => { if (!event.target.closest("button")) previewAt(index); });
        row.addEventListener("keydown", event => {
          if (event.target !== row) return;
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); previewAt(index); }
        });
        row.querySelector(".att-act-preview")?.addEventListener("click", () => previewAt(index));
        row.querySelector(".att-act-print")?.addEventListener("click", () => printAt(index));
        row.querySelector(".att-act-more")?.addEventListener("click", event => {
          const path = attachments[index];
          const items = [];
          if (canDownload) items.push({ label: "تحميل", run: () => downloadStoredFile(path) });
          if (canUpload && isScannable(path)) items.push({ label: "قص وتدوير الصورة", run: () => reprocessAt(index) });
          if (canManage && attachments.length > 1) {
            if (items.length) items.push("sep");
            items.push({ label: "نقل لأعلى", disabled: index === 0, run: () => moveAt(index, "up") });
            items.push({ label: "نقل لأسفل", disabled: index === attachments.length - 1, run: () => moveAt(index, "down") });
          }
          if (canDelete) {
            if (items.length) items.push("sep");
            items.push({ label: "حذف المرفق", danger: true, run: () => deleteAt(index) });
          }
          if (!items.length) items.push({ label: "لا توجد إجراءات إضافية", disabled: true, run: () => {} });
          openMenu(event.currentTarget, items);
        });
      });

      content.querySelector("#attachment-manager-preview-all")?.addEventListener("click", () => runSafely(
        () => openAllDocumentsPreview(attachments, doc.title), "تعذر استعراض المرفقات"));

      content.querySelector("#attachment-manager-more")?.addEventListener("click", event => {
        const items = [];
        if (canPrint) items.push({ label: "طباعة الكل", run: () => runSafely(() => printAllDocuments(attachments, doc.title), "تعذرت طباعة المرفقات") });
        if (canDelete) {
          if (items.length) items.push("sep");
          items.push({
            label: "حذف كل المرفقات…",
            danger: true,
            run: async () => {
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
            },
          });
        }
        openMenu(event.currentTarget, items);
      });

      content.querySelector("#attachment-manager-add")?.addEventListener("click", async () => {
        try {
          const remaining = 20 - attachments.length;
          const selected = await open({
            multiple: true,
            filters: [{ name: "ملفات الوثائق", extensions: DOCUMENT_EXTENSIONS }],
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

      loadThumbnails();
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
              <div style="display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:center">
                <div style="position:relative;min-width:0">
                  <input id="d-issuer" class="input-field" value="${escHtml(doc?.issuer ?? "")}" autocomplete="off" />
                  <div id="d-subject-menu" class="hidden" style="position:absolute;z-index:50;top:calc(100% + 6px);left:0;right:0;max-height:220px;overflow:auto;background:#1f1f1f;border:1px solid #2d5f8a;border-radius:8px;box-shadow:0 12px 28px rgba(0,0,0,.35)">
                    ${documentTypes.map(type => `<button type="button" class="d-subject-option" data-value="${escHtml(type)}" style="display:block;width:100%;text-align:right;padding:10px 12px;border:0;border-bottom:1px solid #2d2d2d;background:transparent;color:#f3f4f6;cursor:pointer">${escHtml(type)}</button>`).join("")}
                  </div>
                </div>
                <datalist id="d-subject-options">
                  ${documentTypes.map(type => `<option value="${escHtml(type)}"></option>`).join("")}
                </datalist>
                <button type="button" id="d-add-subject" class="btn-secondary px-3" title="إضافة الموضوع للقائمة">+</button>
                <button type="button" id="d-delete-subject" class="btn-danger px-3" title="حذف الموضوع من القائمة">-</button>
              </div>
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
                  <span dir="ltr">${isEdit ? generalDocAttachments(doc).length : 0}</span>
                </span>
              </button>
            </div>
          </div>
          <div id="d-scan-progress" style="display:none;align-items:center;gap:14px;padding:12px 14px;border:1px solid #245477;border-radius:10px;background:rgba(5,35,62,.75)">
            <div id="d-scan-progress-bar" style="width:62px;height:62px;flex:none;display:grid;place-items:center;border-radius:50%;background:conic-gradient(#22c55e 0%,#0b2235 0);transition:background .35s ease">
              <div style="width:46px;height:46px;display:grid;place-items:center;border-radius:50%;background:#071827;box-shadow:inset 0 0 8px rgba(0,0,0,.35)">
                <span id="d-scan-progress-percent" dir="ltr" style="font-size:11px;font-weight:700;color:#7dd3fc">0%</span>
              </div>
            </div>
            <div>
              <p style="font-size:12px;font-weight:700;color:#dbeafe;margin-bottom:3px">المسح الضوئي</p>
              <span id="d-scan-progress-label" style="font-size:11px;color:#93c5fd">جاري بدء المسح الضوئي...</span>
            </div>
          </div>
          <div class="flex gap-3">
            <button id="btn-save-doc" class="btn-primary flex-1">حفظ</button>
            ${isEdit && can(user, "documents.delete") ? `<button id="btn-delete-doc" class="btn-danger px-4">حذف الوثيقة</button>` : ""}
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
    if (!can(user, "documents.manage")) {
      el.querySelector("#d-add-subject")?.remove();
      el.querySelector("#d-delete-subject")?.remove();
    }

    const updateSubjectOptions = () => {
      const list = el.querySelector("#d-subject-options");
      if (list) list.innerHTML = documentTypes.map(type => `<option value="${escHtml(type)}"></option>`).join("");
      const menu = el.querySelector("#d-subject-menu");
      if (!menu) return;
      menu.innerHTML = documentTypes.map(type =>
        `<button type="button" class="d-subject-option" data-value="${escHtml(type)}" style="display:block;width:100%;text-align:right;padding:10px 12px;border:0;border-bottom:1px solid #2d2d2d;background:transparent;color:#f3f4f6;cursor:pointer">${escHtml(type)}</button>`
      ).join("");
      bindSubjectOptions();
    };
    const subjectInput = el.querySelector("#d-issuer");
    const subjectMenu = el.querySelector("#d-subject-menu");
    const showSubjectMenu = () => subjectMenu?.classList.remove("hidden");
    const hideSubjectMenu = () => subjectMenu?.classList.add("hidden");
    const bindSubjectOptions = () => {
      el.querySelectorAll(".d-subject-option").forEach(button => {
        button.addEventListener("mousedown", event => event.preventDefault());
        button.addEventListener("click", () => {
          subjectInput.value = button.dataset.value || "";
          formDirty = true;
          hideSubjectMenu();
        });
      });
    };
    bindSubjectOptions();
    subjectInput?.addEventListener("focus", showSubjectMenu);
    subjectInput?.addEventListener("click", showSubjectMenu);
    subjectInput?.addEventListener("keydown", event => {
      if (event.key === "ArrowDown") showSubjectMenu();
      if (event.key === "Escape") hideSubjectMenu();
    });
    document.addEventListener("mousedown", event => {
      if (!el.contains(event.target) || (!subjectInput?.contains(event.target) && !subjectMenu?.contains(event.target))) {
        hideSubjectMenu();
      }
    });
    el.querySelector("#d-add-subject")?.addEventListener("click", async () => {
      const subject = el.querySelector("#d-issuer")?.value.trim();
      if (!subject) return showToast("أدخل الموضوع أولاً", "warn");
      if (documentTypes.includes(subject)) return showToast("الموضوع موجود في القائمة");
      try {
        await saveDocumentTypes([...documentTypes, subject]);
        updateSubjectOptions();
        formDirty = true;
        showToast("تمت إضافة الموضوع للقائمة");
      } catch (error) {
        showToast(error?.message ?? "تعذر حفظ قائمة الموضوعات", "error");
      }
    });
    el.querySelector("#d-delete-subject")?.addEventListener("click", async () => {
      const subject = el.querySelector("#d-issuer")?.value.trim();
      if (!subject) return showToast("اختر الموضوع أولاً", "warn");
      if (!documentTypes.includes(subject)) return showToast("الموضوع غير موجود في القائمة", "warn");
      if (!(await confirmAction("تأكيد حذف هذا الموضوع من القائمة؟"))) return;
      const nextTypes = documentTypes.filter(type => type !== subject);
      if (nextTypes.length === 0) return showToast("يجب أن يبقى موضوع واحد على الأقل", "warn");
      try {
        await saveDocumentTypes(nextTypes);
        updateSubjectOptions();
        formDirty = true;
        showToast("تم حذف الموضوع من القائمة");
      } catch (error) {
        showToast(error?.message ?? "تعذر تحديث قائمة الموضوعات", "error");
      }
    });

    const collectDocData = () => {
      const issuer = el.querySelector("#d-issuer")?.value.trim() || null;
      return {
        title: el.querySelector("#d-title")?.value.trim() || "",
        doc_type: null,
        doc_number: el.querySelector("#d-number")?.value.trim() || null,
        issue_date: el.querySelector("#d-date")?.value || null,
        issuer,
        doc_count: el.querySelector("#d-count")?.value.trim() || null,
        margin: el.querySelector("#d-margin")?.value.trim() || null,
        is_internal_memo: Boolean(el.querySelector("#d-internal-memo")?.checked),
        notes: el.querySelector("#d-notes")?.value.trim() || null,
        employee_ids: el.querySelector("#d-has-employees")?.checked
          ? [...el.querySelectorAll(".d-employee-checkbox:checked")]
              .map(checkbox => parseInt(checkbox.value, 10))
              .sort((a, b) => a - b)
          : [],
      };
    };
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
        filters: [{ name: "ملفات الوثائق", extensions: DOCUMENT_EXTENSIONS }],
      });
      if (!selected) return;
      const files = Array.isArray(selected) ? selected : [selected];
      pendingAttachments = [...new Set([...pendingAttachments, ...files])].slice(0, 20);
      formDirty = true;
      const badge = el.querySelector("#d-manage-attachments .badge");
      badge.classList.toggle("badge-green", pendingAttachments.length > 0);
      badge.classList.toggle("badge-gray", pendingAttachments.length === 0);
      badge.querySelector("[dir='ltr']").textContent = String(pendingAttachments.length);
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
      let deviceId;
      try {
        deviceId = await api.selectScannerDevice();
      } catch (error) {
        button.disabled = false;
        showToast(error?.message ?? String(error || "تعذر اختيار الماسح الضوئي"), "error");
        return;
      }
      const progress = el.querySelector("#d-scan-progress");
      const progressBar = el.querySelector("#d-scan-progress-bar");
      const progressLabel = el.querySelector("#d-scan-progress-label");
      const progressPercent = el.querySelector("#d-scan-progress-percent");
      let percent = 5;
      const updateProgress = (value, label) => {
        percent = value;
        progress.style.display = "flex";
        const progressColor = progress.dataset.error === "true" ? "#dc2626" : "#22c55e";
        progressBar.style.background = `conic-gradient(${progressColor} ${value}%,#0b2235 ${value}%)`;
        progressPercent.textContent = `${value}%`;
        progressLabel.textContent = label;
      };
      updateProgress(percent, "جاري انتظار الماسح الضوئي...");
      const progressTimer = setInterval(() => {
        if (percent >= 90) return;
        const next = Math.min(90, percent + (percent < 55 ? 7 : 3));
        updateProgress(next, next < 55 ? "جاري مسح الوثيقة..." : "جاري معالجة الصورة...");
      }, 700);
      try {
        const scannedPath = await api.scanDocument(deviceId);
        updateProgress(94, "جاري حفظ الوثيقة تلقائياً...");
        if (isEdit) {
          await updateCurrentDoc(doc.id, collectDocData());
          await uploadCurrentDocFile(doc.id, scannedPath);
          await refreshCurrentDocs();
          activeDocFormGuard = null;
          clearInterval(progressTimer);
          updateProgress(100, "اكتمل المسح والحفظ بنجاح");
          showToast("تم مسح الوثيقة وحفظها تلقائياً");
          await new Promise(resolve => setTimeout(resolve, 650));
          showDocForm(currentDocs().find(item => item.id === doc.id));
          return;
        }
        const created = await createCurrentDoc(collectDocData());
        const filesToUpload = [...new Set([...pendingAttachments, scannedPath])].slice(0, 20);
        for (const file of filesToUpload) await uploadCurrentDocFile(created.id, file);
        pendingAttachments = [];
        await refreshCurrentDocs();
        activeDocFormGuard = null;
        clearInterval(progressTimer);
        updateProgress(100, "اكتمل المسح والحفظ بنجاح");
        showToast("تم مسح الوثيقة وإنشاؤها وحفظها تلقائياً");
        await new Promise(resolve => setTimeout(resolve, 650));
        showDocForm(currentDocs().find(item => item.id === created.id));
      } catch (error) {
        clearInterval(progressTimer);
        progress.style.borderColor = "#7f1d1d";
        progress.dataset.error = "true";
        updateProgress(100, "تعذر إكمال عملية المسح");
        showToast(error?.message ?? String(error || "تعذر استخدام الماسح الضوئي"), "error");
      } finally {
        clearInterval(progressTimer);
        button.disabled = false;
      }
    });

    el.querySelector("#btn-cancel-doc").addEventListener("click", () => closeDocForm());
    el.querySelector("#btn-save-doc")?.addEventListener("click", () => saveDoc(false));
    el.querySelector("#btn-delete-doc")?.addEventListener("click", async () => {
      if (!(await confirmAction("تأكيد حذف الوثيقة؟ لا يمكن التراجع عن هذا الإجراء."))) return;
      try {
        await deleteCurrentDoc(doc.id);
        await refreshCurrentDocs();
        activeDocFormGuard = null;
        showToast("تم حذف الوثيقة");
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
          filters: [{ name: "ملفات الوثائق", extensions: DOCUMENT_EXTENSIONS }],
        });
        if (!selected) return;
        const files = Array.isArray(selected) ? selected : [selected];
        if (!(await confirmAction(`تأكيد رفع ${files.length} وثيقة للموظف؟`))) return;
        for (const file of files) {
          await api.uploadDocumentAttachment(empId, file);
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
        await downloadStoredFile(btn.dataset.path);
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
