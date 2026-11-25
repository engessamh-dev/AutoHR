/**
 * documents.js — General + per-employee document archive
 */
import { isScannable, reprocessAttachment } from "../attachments/scanner.js";
import { zoomToolbarHtml, mountZoomViewer } from "../attachments/zoom-viewer.js";
import { api }       from "../api.js";
import { showToast, escHtml, confirmAction, confirmSaveChanges, arCount, AR_NOUNS, errorText, formatDate, debounce } from "../utils.js";

const FILE_GEN = { ...AR_NOUNS.file, two: "ملفين" };
import { open, save } from "@tauri-apps/plugin-dialog";
import { can }       from "../permissions.js";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// pdf.js is about 460 KB, so it is loaded only when a PDF is first printed, not at startup.
let pdfjsPromise = null;
function loadPdfjs() {
  pdfjsPromise ??= import("pdfjs-dist").then(pdfjsLib => {
    pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
    return pdfjsLib;
  }).catch(error => {
    pdfjsPromise = null;
    throw error;
  });
  return pdfjsPromise;
}
const DOCUMENT_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx"];

/** Today's date as yyyy-mm-dd in local time (the default issue date of a new document). */
function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export async function renderDocuments(container, user, ctx) {
  let [generalDocs, outgoingDocs, employees, documentTypes, companyConfig] = await Promise.all([
    api.listGeneralDocs(),
    api.listOutgoingDocs(),
    api.listEmployees(),
    api.getDocumentTypes().catch(() => []),
    api.getCompanyConfig().catch(() => null),
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
      showToast(errorText(error, "تعذر تحميل الملف"), "error");
    }
  }

  let activeTab = ctx?.archiveTab === "outgoing" ? "outgoing" : "general";
  const initialEditDocId = Number.isFinite(Number(ctx?.editDocId)) ? Number(ctx.editDocId) : null;
  const initialManageAttachmentDocId = Number.isFinite(Number(ctx?.manageAttachmentDocId))
    ? Number(ctx.manageAttachmentDocId)
    : null;
  let activeDocFormGuard = null;
  window.autohrCanLeaveCurrentScreen = () => activeDocFormGuard ? activeDocFormGuard() : true;
  // Page-level listeners of the open document form, removed when another form opens.
  let formListeners = null;
  let generalSearch = "";
  let generalFileFilter = "all";
  let generalDateFrom = "";
  let generalDateTo = "";
  let generalMemoFilter = "all";
  let generalFiltersOpen = false;
  // Newest issue date first; a click on a column header sorts by that column.
  let sortKey = "issue_date";
  let sortDir = "desc";
  let currentPage = 1;
  const PAGE_SIZE = 50;
  const renderSoon = debounce(() => { currentPage = 1; renderGeneral(); }, 200);

  // The stored field names do not match what they hold (kept as they are, so stored data
  // needs no migration): title = الجهة المصدرة، doc_number = إلى، issuer = الموضوع، doc_count = العدد.
  const COLUMN_LABELS = {
    title: "الجهة المصدرة للوثيقة",
    doc_number: "إلى",
    issue_date: "تاريخ الإصدار",
    issuer: "الموضوع",
    doc_count: "العدد",
  };
  // In «الصادر» the sender is always this unit, so «إلى» comes first.
  const listColumns = () => isOutgoing()
    ? ["doc_number", "title", "issue_date", "issuer", "doc_count"]
    : ["title", "doc_number", "issue_date", "issuer", "doc_count"];
  const ownUnitName = () => String(companyConfig?.department_name || companyConfig?.company_name || "").trim();

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

  function fileName(path) {
    return String(path ?? "").split(/[/\\]/).pop() || path;
  }

  /** The file's own name, without the number the program adds in front when storing it. */
  function displayName(path) {
    return fileName(path).replace(/^\d+_/, "");
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
    const [pdfjsLib, bytes] = await Promise.all([
      loadPdfjs(),
      fetch(asset.assetUrl).then(response => response.arrayBuffer()),
    ]);
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
    let zoomer = null;
    const overlay = document.createElement("div");
    overlay.setAttribute("dir", "rtl");
    overlay.style.cssText = "position:fixed;inset:0;z-index:11000;background:rgba(0,0,0,.76);display:flex;flex-direction:column";
    overlay.innerHTML = `
      <div style="height:64px;background:var(--ui-surface);border-bottom:1px solid var(--ui-line);display:flex;align-items:center;gap:10px;padding:10px 18px">
        <strong id="document-preview-title" style="font-size:15px;margin-left:auto;color:var(--ui-text-strong)">${escHtml(asset.title)}</strong>
        <span id="document-preview-tools"></span>
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
      zoomer?.destroy();
      zoomer = null;
      const tools = overlay.querySelector("#document-preview-tools");
      tools.innerHTML = isImage ? zoomToolbarHtml() : "";
      const previewBody = overlay.querySelector("#document-preview-body");
      previewBody.style.padding = isImage ? "0" : "18px";
      previewBody.innerHTML = asset.extension === "pdf"
        ? `<iframe src="${escHtml(asset.assetUrl)}" title="معاينة الوثيقة" style="display:block;width:100%;height:100%;border:0;background:#fff"></iframe>`
        : isImage ? `<div class="document-preview-stage" style="width:100%;height:100%;background:#d1d5db">
            <img src="${escHtml(asset.assetUrl)}" alt="${escHtml(asset.title)}">
          </div>`
        : `<div style="display:grid;place-items:center;width:100%;height:100%;background:#d1d5db;color:#374151;text-align:center;padding:24px">
            <div><p style="font-size:18px;font-weight:700;margin-bottom:8px">لا تتوفر معاينة داخلية لهذا النوع من الملفات</p><p>يمكنك تحميل الملف وفتحه ببرنامج Office المناسب.</p></div>
          </div>`;
      if (isImage) {
        const stage = previewBody.querySelector(".document-preview-stage");
        zoomer = mountZoomViewer({ stage, img: stage.querySelector("img"), toolbar: tools });
      }
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
        showToast(errorText(error, "تعذر فتح المرفق"), "error");
      }
    }

    const close = () => {
      document.removeEventListener("keydown", onKeyDown);
      zoomer?.destroy();
      URL.revokeObjectURL(asset.assetUrl);
      overlay.remove();
    };
    const onKeyDown = event => {
      if (event.key === "Escape") close();
      if (event.key === "ArrowUp") navigatePreview(-1);
      if (event.key === "ArrowDown") navigatePreview(1);
      if (event.key === "ArrowLeft") navigatePreview(1);
      if (event.key === "ArrowRight") navigatePreview(-1);
      if (zoomer?.handleKey(event)) event.preventDefault();
    };
    overlay.querySelector("#document-preview-close").addEventListener("click", close);
    overlay.querySelector("#document-preview-prev")?.addEventListener("click", () => navigatePreview(-1));
    overlay.querySelector("#document-preview-next")?.addEventListener("click", () => navigatePreview(1));
    overlay.querySelector("#document-preview-print")?.addEventListener("click", async () => {
      try { await printDocument(previewPaths[currentIndex], asset.title); }
      catch (error) { showToast(errorText(error, "تعذرت طباعة الوثيقة"), "error"); }
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
      title: displayName(path),
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
      <div style="height:64px;background:var(--ui-surface);border-bottom:1px solid var(--ui-line);display:flex;align-items:center;gap:10px;padding:10px 18px">
        <strong style="font-size:15px;margin-left:auto;color:var(--ui-text-strong)">استعراض كل مرفقات: ${escHtml(title)}</strong>
        <span class="badge badge-gray">${arCount(assets.length, "file")}</span>
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
      catch (error) { showToast(errorText(error, "تعذرت طباعة المرفقات"), "error"); }
    });
    document.addEventListener("keydown", onKeyDown);
    document.body.append(overlay);
  }

  const ICONS = {
    incoming: `<svg aria-hidden="true" class="doc-tab-icon" viewBox="0 0 24 24"><path d="M4 13h4l1.5 2.5h5L16 13h4"/><path d="M4 13 6.5 5h11L20 13v5.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z"/></svg>`,
    outgoing: `<svg aria-hidden="true" class="doc-tab-icon" viewBox="0 0 24 24"><path d="M21 3 10 14"/><path d="m21 3-7 18-4-7-7-4z"/></svg>`,
    clip: `<svg aria-hidden="true" class="doc-clip-icon" viewBox="0 0 24 24"><path d="m20.5 11.5-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.4 8.4a1.7 1.7 0 0 1-2.4-2.4l7.7-7.7"/></svg>`,
  };

  function matchesGeneralSearch(doc) {
    const attachments = generalDocAttachments(doc);
    if (generalFileFilter === "with" && attachments.length === 0) return false;
    if (generalFileFilter === "without" && attachments.length > 0) return false;
    if (generalDateFrom && (!doc.issue_date || doc.issue_date < generalDateFrom)) return false;
    if (generalDateTo && (!doc.issue_date || doc.issue_date > generalDateTo)) return false;
    if (generalMemoFilter === "yes" && !doc.is_internal_memo) return false;
    if (generalMemoFilter === "no" && doc.is_internal_memo) return false;

    const needle = generalSearch.trim().toLowerCase();
    if (!needle) return true;
    return [
      doc.title,
      doc.doc_number,
      doc.issue_date,
      doc.issue_date ? formatDate(doc.issue_date) : "",
      doc.issuer,
      doc.doc_count,
      doc.margin,
      doc.is_internal_memo ? "مذكرة داخلية" : "",
      doc.notes,
      ...attachments.map(fileName),
      ...(doc.employee_names ?? []),
    ].some(value => String(value ?? "").toLowerCase().includes(needle));
  }

  function sortDocs(docs) {
    const direction = sortDir === "asc" ? 1 : -1;
    return [...docs].sort((a, b) => {
      const av = String(a[sortKey] ?? "").trim();
      const bv = String(b[sortKey] ?? "").trim();
      // Empty values always go last, whatever the direction.
      if (!av && bv) return 1;
      if (av && !bv) return -1;
      const order = sortKey === "issue_date" ? av.localeCompare(bv) : av.localeCompare(bv, "ar", { numeric: true });
      return order * direction || b.id - a.id;
    });
  }

  function html() {
    return `<div class="space-y-4">
      <div class="doc-tabs" role="tablist">
        ${[["general", "الوارد", ICONS.incoming], ["outgoing", "الصادر", ICONS.outgoing]].map(([id, label, icon]) => `
          <button type="button" class="doc-tab" role="tab" data-tab="${id}" aria-selected="${activeTab === id}">${icon}<span>${label}</span></button>`).join("")}
      </div>

      <div id="doc-content"></div>
    </div>`;
  }

  function employeesCell(names) {
    if (!names.length) return "—";
    const rest = names.length - 1;
    return `<div class="doc-emp-cell" title="${escHtml(names.join("\n"))}">
      <span class="badge badge-gray doc-emp-name">${escHtml(names[0])}</span>
      ${rest ? `<span class="badge badge-gray doc-emp-more" dir="ltr">+${rest}</span>` : ""}
    </div>`;
  }

  function renderGeneral() {
    const el = document.getElementById("doc-content");
    if (!el) return;
    formListeners?.abort();
    formListeners = null;
    const focusedId = document.activeElement?.id;
    const archiveDocs = currentDocs();
    const filteredDocs = sortDocs(archiveDocs.filter(matchesGeneralSearch));
    const pageCount = Math.max(1, Math.ceil(filteredDocs.length / PAGE_SIZE));
    currentPage = Math.min(Math.max(1, currentPage), pageCount);
    const pageDocs = filteredDocs.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);
    const filteredAttachmentPaths = filteredDocs.flatMap(doc => generalDocAttachments(doc));
    const canDeleteRows = can(user, "documents.delete");
    const canManage = can(user, "documents.manage");
    const columns = listColumns();
    const columnCount = columns.length + 3 + (canDeleteRows ? 1 : 0);
    const advancedFilterCount = [
      generalFileFilter !== "all",
      generalDateFrom,
      generalDateTo,
      generalMemoFilter !== "all",
    ].filter(Boolean).length;
    const hasActiveFilters = Boolean(generalSearch.trim()) || advancedFilterCount > 0;
    const label = (text, forId) => `<label for="${forId}" class="doc-filter-label">${text}</label>`;
    const sortHeader = key => {
      const active = sortKey === key;
      const arrow = active ? (sortDir === "asc" ? "↑" : "↓") : "";
      return `<th class="table-header doc-th" aria-sort="${active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}">
        <button type="button" class="doc-sort${active ? " active" : ""}" data-key="${key}" title="ترتيب حسب ${COLUMN_LABELS[key]}">${COLUMN_LABELS[key]}<span class="doc-sort-arrow" aria-hidden="true">${arrow}</span></button>
      </th>`;
    };
    const cell = (doc, key) => {
      if (key === "issue_date") return `<td class="table-cell doc-cell-date">${formatDate(doc.issue_date)}</td>`;
      if (key === "issuer") return `<td class="table-cell">${escHtml(doc.issuer || "—")}${doc.is_internal_memo ? ` <span class="doc-memo-tag">مذكرة داخلية</span>` : ""}</td>`;
      if (key === "title") return `<td class="table-cell font-medium text-gray-100">${escHtml(doc.title || "—")}</td>`;
      return `<td class="table-cell">${escHtml(doc[key] || "—")}</td>`;
    };
    el.innerHTML = `
      <div class="space-y-4">
        <div class="card space-y-3">
          <div class="flex gap-3 items-center flex-wrap">
            <input id="general-doc-search" class="input-field flex-1 min-w-[220px]"
              placeholder="بحث في ${archiveName()}: الجهة، الموضوع، العدد، الهامش، النبذة، أسماء الموظفين..." value="${escHtml(generalSearch)}" />
            <span class="badge badge-gray" dir="ltr">${filteredDocs.length} / ${archiveDocs.length}</span>
            ${hasActiveFilters && can(user, "documents.print") && filteredAttachmentPaths.length
              ? `<button id="btn-print-filtered-attachments" class="btn-secondary px-3 py-2" title="طباعة مرفقات الوثائق الظاهرة في النتائج">طباعة مرفقات النتائج</button>` : ""}
            <button id="btn-toggle-general-filters" class="btn-secondary px-3 py-2"
              aria-expanded="${generalFiltersOpen ? "true" : "false"}">
              فلاتر البحث${advancedFilterCount ? ` (${advancedFilterCount})` : ""}
            </button>
            ${canManage ? `<button id="btn-add-doc" class="btn-primary px-4 py-2">+ إضافة وثيقة</button>` : ""}
          </div>
          ${generalFiltersOpen ? `
          <div class="doc-filter-grid">
            <div>${label("من تاريخ إصدار", "general-date-from")}
              <input id="general-date-from" class="input-field" type="date" value="${escHtml(generalDateFrom)}" /></div>
            <div>${label("إلى تاريخ إصدار", "general-date-to")}
              <input id="general-date-to" class="input-field" type="date" value="${escHtml(generalDateTo)}" /></div>
            <div>${label("المرفقات", "general-file-filter")}
              <select id="general-file-filter" class="input-field">
                <option value="all" ${generalFileFilter === "all" ? "selected" : ""}>الكل</option>
                <option value="with" ${generalFileFilter === "with" ? "selected" : ""}>لها مرفقات</option>
                <option value="without" ${generalFileFilter === "without" ? "selected" : ""}>بدون مرفقات</option>
              </select></div>
            <div>${label("مذكرة داخلية", "general-memo-filter")}
              <select id="general-memo-filter" class="input-field">
                <option value="all" ${generalMemoFilter === "all" ? "selected" : ""}>الكل</option>
                <option value="yes" ${generalMemoFilter === "yes" ? "selected" : ""}>نعم</option>
                <option value="no" ${generalMemoFilter === "no" ? "selected" : ""}>لا</option>
              </select></div>
          </div>
          <div class="flex justify-end gap-2">
            ${hasActiveFilters ? `<button id="btn-clear-general-filters" class="btn-secondary px-3 py-2">مسح البحث والفلاتر</button>` : ""}
            <button id="btn-close-general-filters" class="btn-secondary px-3 py-2">إغلاق</button>
          </div>
          ` : ""}
        </div>
        <div class="card overflow-auto">
          <table class="w-full doc-table">
            <thead><tr>
              ${columns.map(sortHeader).join("")}
              <th class="table-header doc-th">الهامش</th>
              <th class="table-header doc-th">الموظفون المرتبطون</th>
              <th class="table-header doc-th">المرفقات</th>
              ${canDeleteRows ? `<th class="table-header" style="width:1%"><span class="sr-only">حذف</span></th>` : ""}
            </tr></thead>
            <tbody>
              ${archiveDocs.length === 0
                ? `<tr><td colspan="${columnCount}" class="table-cell"><div class="doc-empty">
                    <span class="doc-empty-icon"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/><path d="M12 11v6M9 14h6"/></svg></span>
                    <p class="doc-empty-title">لا توجد وثائق في ${escHtml(archiveName())} بعد</p>
                    ${canManage
                      ? `<p class="doc-empty-text">ابدأ بإضافة أول وثيقة، ويمكنك إرفاق ملفاتها أو مسحها ضوئيًا.</p>
                         <button type="button" id="btn-add-first-doc" class="btn-primary px-5 py-2">+ إضافة أول وثيقة</button>`
                      : `<p class="doc-empty-text">ستظهر الوثائق هنا عند إضافتها.</p>`}
                  </div></td></tr>`
                : filteredDocs.length === 0
                  ? `<tr><td colspan="${columnCount}" class="table-cell text-center text-gray-500 py-8">لا توجد نتائج مطابقة</td></tr>`
                  : pageDocs.map(d => `
                  <tr class="table-row general-doc-row" data-id="${d.id}" title="${canManage ? "اضغط لتعديل الوثيقة" : "اضغط لعرض الوثيقة"}">
                    ${columns.map(key => cell(d, key)).join("")}
                    <td class="table-cell">${d.margin ? `<span class="doc-cell-clip" title="${escHtml(d.margin)}">${escHtml(d.margin)}</span>` : "—"}</td>
                    <td class="table-cell">${employeesCell(d.employee_names ?? [])}</td>
                    <td class="table-cell">
                      <button class="btn-manage-doc-attachments" data-id="${d.id}" title="مرفقات الوثيقة" aria-label="مرفقات الوثيقة (${generalDocAttachments(d).length})"
                        style="border:none;background:transparent;cursor:pointer;padding:2px">
                        <span class="badge ${generalDocAttachments(d).length ? "badge-green" : "badge-gray"} doc-clip-badge">
                          ${ICONS.clip}<span dir="ltr">${generalDocAttachments(d).length}</span>
                        </span>
                      </button>
                    </td>
                    ${canDeleteRows ? `<td class="table-cell" style="padding-inline:4px">
                      <button type="button" class="att-icon-btn doc-row-delete" data-id="${d.id}"
                        title="حذف الوثيقة" aria-label="حذف الوثيقة">
                        <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 12.5h9l1-12.5M10 11v5.5M14 11v5.5"/></svg>
                      </button>
                    </td>` : ""}
                  </tr>`).join("")}
            </tbody>
          </table>
          ${pageCount > 1 ? `<div class="doc-pager">
            <button type="button" class="btn-secondary px-3 py-1" id="doc-page-prev" ${currentPage === 1 ? "disabled" : ""}>السابق</button>
            <span>صفحة <b dir="ltr">${currentPage}</b> من <b dir="ltr">${pageCount}</b></span>
            <button type="button" class="btn-secondary px-3 py-1" id="doc-page-next" ${currentPage === pageCount ? "disabled" : ""}>التالي</button>
          </div>` : ""}
        </div>
      </div>`;
    el.querySelector("#btn-toggle-general-filters")?.addEventListener("click", () => {
      generalFiltersOpen = !generalFiltersOpen;
      renderGeneral();
    });
    el.querySelector("#btn-close-general-filters")?.addEventListener("click", () => {
      generalFiltersOpen = false;
      renderGeneral();
    });
    el.querySelector("#btn-print-filtered-attachments")?.addEventListener("click", async () => {
      try {
        await printAllDocuments(filteredAttachmentPaths, `مرفقات نتائج البحث في ${archiveName()}`);
      } catch (error) {
        showToast(errorText(error, "تعذرت طباعة مرفقات النتائج"), "error");
      }
    });

    const searchInput = el.querySelector("#general-doc-search");
    if (focusedId === "general-doc-search" && searchInput) {
      searchInput.focus();
      searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
    } else if (focusedId) {
      el.querySelector(`#${focusedId}`)?.focus();
    }
    searchInput?.addEventListener("input", () => {
      generalSearch = searchInput.value;
      renderSoon();
    });
    const onFilter = (selector, apply) => el.querySelector(selector)?.addEventListener("change", event => {
      apply(event.target.value);
      currentPage = 1;
      renderGeneral();
    });
    onFilter("#general-file-filter", value => { generalFileFilter = value; });
    onFilter("#general-date-from", value => { generalDateFrom = value; });
    onFilter("#general-date-to", value => { generalDateTo = value; });
    onFilter("#general-memo-filter", value => { generalMemoFilter = value; });
    el.querySelector("#btn-clear-general-filters")?.addEventListener("click", () => {
      generalSearch = "";
      generalFileFilter = "all";
      generalDateFrom = "";
      generalDateTo = "";
      generalMemoFilter = "all";
      currentPage = 1;
      renderGeneral();
    });
    el.querySelectorAll(".doc-sort").forEach(button => button.addEventListener("click", () => {
      const key = button.dataset.key;
      if (sortKey === key) sortDir = sortDir === "asc" ? "desc" : "asc";
      else { sortKey = key; sortDir = key === "issue_date" ? "desc" : "asc"; }
      currentPage = 1;
      renderGeneral();
    }));
    el.querySelector("#doc-page-prev")?.addEventListener("click", () => { currentPage -= 1; renderGeneral(); });
    el.querySelector("#doc-page-next")?.addEventListener("click", () => { currentPage += 1; renderGeneral(); });

    el.querySelector("#btn-add-doc")?.addEventListener("click", () => showDocForm());
    el.querySelector("#btn-add-first-doc")?.addEventListener("click", () => showDocForm());

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

    el.querySelectorAll(".doc-row-delete").forEach(btn => {
      btn.addEventListener("click", event => {
        event.stopPropagation();
        deleteDocFromList(parseInt(btn.dataset.id, 10));
      });
    });
  }

  // Delete straight from the archive list, without opening the document form.
  // The backend re-checks "documents.delete" and writes the audit log entry.
  async function deleteDocFromList(docId) {
    const doc = currentDocs().find(item => item.id === docId);
    if (!doc) return;
    const label = [doc.title, doc.doc_number, doc.doc_count].map(v => String(v ?? "").trim()).filter(Boolean).join(" — ");
    const attachmentCount = generalDocAttachments(doc).length;
    const what = label ? `الوثيقة «${label}»` : "هذه الوثيقة (بدون بيانات)";
    const files = attachmentCount ? ` ومرفقاتها (${arCount(attachmentCount, "attachment")})` : "";
    if (!(await confirmAction(`تأكيد حذف ${what}${files} من ${archiveName()}؟ لا يمكن التراجع عن هذا الإجراء.`))) return;
    try {
      await deleteCurrentDoc(docId);
      await refreshCurrentDocs();
      showToast("تم حذف الوثيقة");
      renderGeneral();
    } catch (err) {
      showToast(errorText(err, "تعذر حذف الوثيقة"), "error");
    }
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
        if (doc) setAttachmentBadge(document, generalDocAttachments(doc).length);
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
                    <span class="att-name" title="${escHtml(displayName(path))}">${escHtml(displayName(path))}</span>
                    <span class="att-meta">مرفق ${index + 1} · ${escHtml(kind.label)}</span>
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
        catch (error) { showToast(errorText(error, fallback), "error"); }
      };
      const previewAt = index => runSafely(
        () => openDocumentPreview(attachments[index], displayName(attachments[index]), attachments),
        "تعذر استعراض الوثيقة");
      const printAt = index => runSafely(
        () => printDocument(attachments[index], displayName(attachments[index])),
        "تعذرت طباعة الوثيقة");
      const moveAt = (index, direction) => runSafely(async () => {
        await moveCurrentDocAttachment(docId, attachments[index], direction);
        await refreshCurrentDocs();
        renderManager();
      }, "تعذر تغيير ترتيب المرفق");
      const deleteAt = index => runSafely(async () => {
        if (!(await confirmAction(`تأكيد حذف «${displayName(attachments[index])}» (مرفق ${index + 1})؟`))) return;
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
              if (!(await confirmAction(`تأكيد حذف جميع مرفقات الوثيقة (${arCount(attachments.length, "file")})؟ لا يمكن التراجع عن هذا الإجراء.`))) return;
              try {
                for (const path of attachments) await deleteCurrentDocAttachment(docId, path);
                await refreshCurrentDocs();
                showToast(`تم حذف جميع مرفقات الوثيقة (${arCount(attachments.length, "file")})`);
                renderManager();
              } catch (error) {
                await refreshCurrentDocs();
                renderManager();
                showToast(errorText(error, "تعذر حذف جميع المرفقات"), "error");
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
            showToast(`يمكن إضافة ${arCount(remaining, FILE_GEN)} فقط لهذه الوثيقة`, "warn");
            return;
          }
          if (!(await confirmAction(`تأكيد رفع ${arCount(files.length, FILE_GEN)} للوثيقة؟`))) return;
          for (const file of files) await uploadCurrentDocFile(docId, file);
          await refreshCurrentDocs();
          showToast(`تم رفع ${arCount(files.length, FILE_GEN)}`);
          renderManager();
        } catch (err) { showToast(errorText(err, "خطأ"), "error"); }
      });

      loadThumbnails();
    };

    renderManager();
  }

  const fieldLabel = (forId, text, required = false) =>
    `<label for="${forId}" class="doc-field-label">${text}${required ? ` <span class="doc-required" aria-hidden="true">*</span>` : ""}</label>`;

  const ATTACHMENT_BUTTONS = (count, hint) => `
    <div style="border-top:1px solid var(--ui-line);padding-top:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
        <div>
          <p style="font-size:12px;font-weight:700;color:var(--ui-text)">مرفقات الوثيقة</p>
          <p style="font-size:11px;color:var(--ui-text-faint);margin-top:3px">${hint}</p>
        </div>
        <div style="display:flex;align-items:center;gap:8px">
          <button type="button" id="d-manage-attachments" class="btn-secondary doc-att-button">
            ${ICONS.clip.replace("doc-clip-icon", "doc-att-icon")}
            <span>المرفقات</span>
            <span class="badge ${count ? "badge-green" : "badge-gray"} doc-att-count"><span dir="ltr">${count}</span></span>
          </button>
          ${can(user, "documents.upload") ? `<button type="button" id="d-scan-attachment" class="btn-secondary doc-att-button" title="مسح وثيقة ضوئياً وإضافتها إلى المرفقات">
            <svg aria-hidden="true" class="doc-att-icon" viewBox="0 0 24 24">
              <path d="M5 10V7a1.5 1.5 0 0 1 1.5-1.5h11A1.5 1.5 0 0 1 19 7v3"/>
              <rect x="3" y="10" width="18" height="9" rx="2"/>
              <path d="M3 14h18"/>
              <path d="M6.5 16.5h6M17 16.5h.01"/>
            </svg>
            <span>ماسح ضوئي</span>
          </button>` : ""}
        </div>
      </div>
      <ul id="d-pending-list" class="doc-pending-list" hidden></ul>
    </div>
    <div id="d-scan-progress" style="display:none;align-items:center;gap:14px;padding:12px 14px;border:1px solid var(--ui-line-strong);border-radius:10px;background:var(--ui-info-bg)">
      <div id="d-scan-progress-bar" style="width:62px;height:62px;flex:none;display:grid;place-items:center;border-radius:50%;background:conic-gradient(#22c55e 0%,var(--ui-sunken) 0);transition:background .35s ease">
        <div style="width:46px;height:46px;display:grid;place-items:center;border-radius:50%;background:var(--ui-sunken);box-shadow:inset 0 0 8px rgba(0,0,0,.35)">
          <span id="d-scan-progress-percent" dir="ltr" style="font-size:11px;font-weight:700;color:var(--ui-info)">0%</span>
        </div>
      </div>
      <div>
        <p style="font-size:12px;font-weight:700;color:var(--ui-text-strong);margin-bottom:3px">المسح الضوئي</p>
        <span id="d-scan-progress-label" style="font-size:11px;color:var(--ui-info)">جاري بدء المسح الضوئي...</span>
      </div>
    </div>`;

  /** Updates the count on the «المرفقات» button of the open form or view page. */
  function setAttachmentBadge(root, count) {
    const badge = root.querySelector("#d-manage-attachments .badge");
    if (!badge) return;
    badge.classList.toggle("badge-green", count > 0);
    badge.classList.toggle("badge-gray", count === 0);
    badge.querySelector("[dir='ltr']").textContent = String(count);
  }

  /**
   * Runs the scanner with the progress ring of the form. `useScan(path)` receives the scanned
   * file and returns the message to show when it is done; it is the only thing that changes
   * data, so a scan never saves the form's fields.
   */
  async function scanWithProgress(root, useScan) {
    const button = root.querySelector("#d-scan-attachment");
    button.disabled = true;
    let deviceId;
    try {
      deviceId = await api.selectScannerDevice();
    } catch (error) {
      button.disabled = false;
      showToast(errorText(error, "تعذر اختيار الماسح الضوئي"), "error");
      return;
    }
    const progress = root.querySelector("#d-scan-progress");
    const progressBar = root.querySelector("#d-scan-progress-bar");
    const progressLabel = root.querySelector("#d-scan-progress-label");
    const progressPercent = root.querySelector("#d-scan-progress-percent");
    progress.style.borderColor = "";
    delete progress.dataset.error;
    let percent = 5;
    const updateProgress = (value, label) => {
      percent = value;
      progress.style.display = "flex";
      const progressColor = progress.dataset.error === "true" ? "#dc2626" : "#22c55e";
      progressBar.style.background = `conic-gradient(${progressColor} ${value}%,var(--ui-sunken) ${value}%)`;
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
      updateProgress(94, "جاري إضافة الصورة إلى المرفقات...");
      const done = await useScan(scannedPath);
      clearInterval(progressTimer);
      updateProgress(100, done);
      showToast(done);
      await new Promise(resolve => setTimeout(resolve, 900));
      if (progress.isConnected) progress.style.display = "none";
    } catch (error) {
      clearInterval(progressTimer);
      progress.style.borderColor = "var(--ui-danger-line)";
      progress.dataset.error = "true";
      updateProgress(100, "تعذر إكمال عملية المسح");
      showToast(errorText(error, "تعذر استخدام الماسح الضوئي"), "error");
    } finally {
      clearInterval(progressTimer);
      button.disabled = false;
    }
  }

  /** Scans straight into an existing document: only the scanned file is added. */
  function bindScanIntoExistingDoc(root, docId) {
    root.querySelector("#d-scan-attachment")?.addEventListener("click", async () => {
      const current = currentDocs().find(item => item.id === docId);
      if (generalDocAttachments(current).length >= 20) {
        showToast("تم الوصول إلى الحد الأقصى للمرفقات", "warn");
        return;
      }
      await scanWithProgress(root, async scannedPath => {
        await uploadCurrentDocFile(docId, scannedPath);
        await refreshCurrentDocs();
        setAttachmentBadge(root, generalDocAttachments(currentDocs().find(item => item.id === docId)).length);
        return "أُضيفت الصورة الممسوحة إلى مرفقات الوثيقة";
      });
    });
  }

  /** Read-only page for users who may not edit documents. */
  function showDocView(doc) {
    formListeners?.abort();
    formListeners = null;
    activeDocFormGuard = null;
    const el = document.getElementById("doc-content");
    const names = doc.employee_names ?? [];
    const rows = [
      ...listColumns().map(key => [COLUMN_LABELS[key], key === "issue_date" ? formatDate(doc.issue_date) : doc[key]]),
      ["مذكرة داخلية", doc.is_internal_memo ? "نعم" : ""],
      ["نبذة عامة عن الوثيقة", doc.notes],
      ["الهامش", doc.margin],
    ];
    el.innerHTML = `
      <div id="doc-form-stage" class="doc-form-stage">
        <div id="doc-form-card" class="card doc-form-card space-y-4">
          <div class="flex items-center justify-between gap-3">
            <p class="section-title" style="margin:0">عرض وثيقة</p>
            <span class="badge badge-gray">${escHtml(archiveName())}</span>
          </div>
          <dl class="doc-view-grid">
            ${rows.map(([label, value]) => `<div><dt>${label}</dt><dd>${escHtml(String(value ?? "").trim() || "—")}</dd></div>`).join("")}
            <div class="doc-view-wide"><dt>الموظفون المرتبطون</dt><dd>${names.length
              ? `<div class="doc-chip-list">${names.map(name => `<span class="doc-chip">${escHtml(name)}</span>`).join("")}</div>`
              : "—"}</dd></div>
          </dl>
          ${ATTACHMENT_BUTTONS(generalDocAttachments(doc).length, "اضغط «المرفقات» لاستعراضها أو طباعتها")}
          <div class="flex justify-end">
            <button id="btn-cancel-doc" class="btn-secondary px-5">إغلاق</button>
          </div>
        </div>
      </div>`;
    const close = () => renderGeneral();
    el.querySelector("#btn-cancel-doc").addEventListener("click", close);
    el.querySelector("#doc-form-stage").addEventListener("click", event => { if (event.target === event.currentTarget) close(); });
    el.querySelector("#d-manage-attachments").addEventListener("click", () => openAttachmentManager(doc.id, false));
    bindScanIntoExistingDoc(el, doc.id);
  }

  function showDocForm(doc = null) {
    if (!can(user, "documents.manage")) {
      if (doc) showDocView(doc);
      return;
    }
    formListeners?.abort();
    formListeners = new AbortController();
    const { signal } = formListeners;
    const el = document.getElementById("doc-content");
    const isEdit = Boolean(doc);
    const outgoing = isOutgoing();
    let pendingAttachments = [];
    let formDirty = false;
    const selectedEmployeeIds = new Set(doc?.employee_ids ?? []);
    const hasEmployeeLinks = selectedEmployeeIds.size > 0;
    const employeeName = id => employees.find(employee => employee.id === id)?.full_name ?? "";
    const titleField = `<div>
              ${fieldLabel("d-title", COLUMN_LABELS.title, !outgoing)}
              <input id="d-title" class="input-field" ${outgoing ? "" : `required aria-required="true"`} value="${escHtml(doc?.title ?? (outgoing ? ownUnitName() : ""))}" />
            </div>`;
    const toField = `<div>
              ${fieldLabel("d-number", COLUMN_LABELS.doc_number, outgoing)}
              <input id="d-number" class="input-field" ${outgoing ? `required aria-required="true"` : ""} value="${escHtml(doc?.doc_number ?? "")}" />
            </div>`;
    const subjectField = `<div>
              ${fieldLabel("d-issuer", COLUMN_LABELS.issuer, true)}
              <div style="position:relative;min-width:0">
                <input id="d-issuer" class="input-field" required aria-required="true" value="${escHtml(doc?.issuer ?? "")}" autocomplete="off"
                  role="combobox" aria-autocomplete="list" aria-controls="d-subject-menu" aria-expanded="false" />
                <div id="d-subject-menu" class="doc-subject-menu hidden" role="listbox"></div>
              </div>
            </div>`;
    el.innerHTML = `
      <div id="doc-form-stage" class="doc-form-stage">
        <div id="doc-form-card" class="card doc-form-card space-y-4">
          <p class="section-title">${isEdit ? "تعديل وثيقة" : "إضافة وثيقة جديدة"}${outgoing ? " صادرة" : " واردة"}</p>
          <div class="doc-form-grid">
            ${outgoing ? `${toField}${subjectField}${titleField}` : `${titleField}${subjectField}${toField}`}
            <div class="doc-form-pair">
              <div>
                ${fieldLabel("d-date", COLUMN_LABELS.issue_date, true)}
                <input id="d-date" class="input-field" type="date" required aria-required="true" value="${escHtml(doc?.issue_date ?? (isEdit ? "" : todayIso()))}" />
              </div>
              <div>
                ${fieldLabel("d-count", COLUMN_LABELS.doc_count, true)}
                <input id="d-count" class="input-field" required aria-required="true" value="${escHtml(doc?.doc_count ?? "")}" />
              </div>
            </div>
            <div>
              ${fieldLabel("d-notes", "نبذة عامة عن الوثيقة")}
              <textarea id="d-notes" class="input-field" style="height:70px;resize:none">${escHtml(doc?.notes ?? "")}</textarea>
            </div>
            <div>
              ${fieldLabel("d-margin", "الهامش")}
              <textarea id="d-margin" class="input-field" style="height:70px;resize:none">${escHtml(doc?.margin ?? "")}</textarea>
            </div>
          </div>
          <div style="border-top:1px solid var(--ui-line);padding-top:12px">
            <div style="display:flex;flex-wrap:wrap;gap:10px 28px">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:var(--ui-text)">
                <input id="d-internal-memo" type="checkbox" ${doc?.is_internal_memo ? "checked" : ""}
                  style="width:16px;height:16px;accent-color:var(--ui-accent)" />
                مذكرة داخلية
              </label>
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;color:var(--ui-text)">
                <input id="d-has-employees" type="checkbox" ${hasEmployeeLinks ? "checked" : ""}
                  style="width:16px;height:16px;accent-color:var(--ui-accent)" />
                هل لهذه الوثيقة ارتباط بموظفي الشعبة/الوحدة؟
              </label>
            </div>
            <div id="d-employee-linking" class="space-y-3" style="display:${hasEmployeeLinks ? "block" : "none"};margin-top:12px">
              <div class="flex items-center justify-between gap-3">
                <div id="d-employee-chips" class="doc-chip-list"></div>
                <span id="d-selected-count" class="badge badge-gray" style="flex:none">المحدد: ${selectedEmployeeIds.size}</span>
              </div>
              <input id="d-employee-search" class="input-field" placeholder="ابحث باسم الموظف أو رقمه الوظيفي لإضافته..." />
              <div id="d-employee-list" style="max-height:200px;overflow:auto;border:1px solid var(--ui-line);border-radius:8px">
                ${employees.map(employee => `
                  <label class="doc-employee-option" data-search="${escHtml(`${employee.full_name} ${employee.employee_number ?? ""}`.toLowerCase())}"
                    style="display:flex;align-items:center;gap:9px;padding:9px 11px;border-bottom:1px solid var(--ui-line);cursor:pointer">
                    <input class="d-employee-checkbox" type="checkbox" value="${employee.id}"
                      ${selectedEmployeeIds.has(employee.id) ? "checked" : ""}
                      style="width:15px;height:15px;accent-color:var(--ui-accent)" />
                    <span style="font-size:12px;color:var(--ui-text)">${escHtml(employee.full_name)}</span>
                    <span style="font-size:11px;color:var(--ui-text-faint)" dir="ltr">${escHtml(employee.employee_number ?? "")}</span>
                  </label>`).join("") || `<p style="padding:12px;color:var(--ui-text-faint);font-size:12px">لا يوجد موظفون</p>`}
              </div>
            </div>
          </div>
          ${ATTACHMENT_BUTTONS(isEdit ? generalDocAttachments(doc).length : 0,
            isEdit ? "اضغط «المرفقات» لإدارة الملفات، أو امسح وثيقة لإضافتها مباشرة" : "أضف المرفقات الآن، وتُحفظ مع الوثيقة عند الضغط على «حفظ»")}
          <p id="d-required-hint" class="doc-required-hint" role="status" hidden></p>
          <div class="flex gap-3 items-center">
            <button id="btn-save-doc" class="btn-primary flex-1">حفظ</button>
            <button id="btn-cancel-doc" class="btn-secondary">إلغاء</button>
          </div>
          ${isEdit && can(user, "documents.delete") ? `<div style="border-top:1px solid var(--ui-line);padding-top:12px;display:flex;justify-content:flex-end">
            <button id="btn-delete-doc" class="btn-danger px-4">حذف الوثيقة نهائياً</button>
          </div>` : ""}
        </div>
      </div>`;
    if (!can(user, "documents.upload")) el.querySelector("#d-manage-attachments")?.remove();

    // «الموضوع»: the saved subjects, narrowed to what is typed. A new subject joins the list when
    // the document is saved; × next to a subject takes it off the list.
    const subjectInput = el.querySelector("#d-issuer");
    const subjectMenu = el.querySelector("#d-subject-menu");
    const renderSubjectMenu = () => {
      const needle = subjectInput.value.trim().toLowerCase();
      const matches = documentTypes.filter(type => !needle || type.toLowerCase().includes(needle));
      subjectMenu.innerHTML = matches.map(type => `
        <div class="doc-subject-option" role="option">
          <button type="button" class="doc-subject-pick" data-value="${escHtml(type)}">${escHtml(type)}</button>
          <button type="button" class="doc-subject-remove" data-value="${escHtml(type)}" title="حذف «${escHtml(type)}» من قائمة المواضيع" aria-label="حذف ${escHtml(type)} من قائمة المواضيع">✕</button>
        </div>`).join("");
      const open = matches.length > 0 && document.activeElement === subjectInput;
      subjectMenu.classList.toggle("hidden", !open);
      subjectInput.setAttribute("aria-expanded", String(open));
      subjectMenu.querySelectorAll("button").forEach(button => button.addEventListener("mousedown", event => event.preventDefault()));
      subjectMenu.querySelectorAll(".doc-subject-pick").forEach(button => button.addEventListener("click", () => {
        subjectInput.value = button.dataset.value;
        hideSubjectMenu();
        formDirty = true;
        updateRequiredState();
      }));
      subjectMenu.querySelectorAll(".doc-subject-remove").forEach(button => button.addEventListener("click", async () => {
        const subject = button.dataset.value;
        if (!(await confirmAction(`حذف «${subject}» من قائمة المواضيع؟ لا تتغير الوثائق المحفوظة به.`))) return;
        try {
          await saveDocumentTypes(documentTypes.filter(type => type !== subject));
          showToast("حُذف الموضوع من القائمة");
        } catch (error) {
          showToast(errorText(error, "تعذر تحديث قائمة المواضيع"), "error");
        }
        subjectInput.focus();
        renderSubjectMenu();
      }));
    };
    const hideSubjectMenu = () => {
      subjectMenu.classList.add("hidden");
      subjectInput.setAttribute("aria-expanded", "false");
    };
    subjectInput.addEventListener("focus", renderSubjectMenu);
    subjectInput.addEventListener("input", renderSubjectMenu);
    subjectInput.addEventListener("blur", hideSubjectMenu);
    subjectInput.addEventListener("keydown", event => {
      if (event.key === "ArrowDown") { renderSubjectMenu(); subjectMenu.querySelector(".doc-subject-pick")?.focus(); event.preventDefault(); }
      if (event.key === "Escape") hideSubjectMenu();
    });
    subjectMenu.addEventListener("keydown", event => {
      if (event.key === "Escape") { hideSubjectMenu(); subjectInput.focus(); }
    });
    document.addEventListener("mousedown", event => {
      if (!subjectMenu.contains(event.target) && event.target !== subjectInput) hideSubjectMenu();
    }, { signal });

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
      employee_ids: el.querySelector("#d-has-employees")?.checked ? [...selectedEmployeeIds].sort((a, b) => a - b) : [],
    });
    const initialDocData = JSON.stringify(collectDocData());
    const hasUnsavedDocChanges = () =>
      formDirty || pendingAttachments.length > 0 || JSON.stringify(collectDocData()) !== initialDocData;
    // The fields a document cannot be saved without. The date starts as today, so it only
    // blocks saving when someone clears it. In «الصادر» the sender is this unit (filled in),
    // and the receiver is the field that must be filled.
    const requiredDocFields = [
      outgoing ? ["#d-number", COLUMN_LABELS.doc_number] : ["#d-title", COLUMN_LABELS.title],
      ["#d-issuer", COLUMN_LABELS.issuer],
      ["#d-count", COLUMN_LABELS.doc_count],
      ["#d-date", COLUMN_LABELS.issue_date],
    ];
    const missingDocFields = () => requiredDocFields.filter(([selector]) => !el.querySelector(selector)?.value.trim());
    const updateRequiredState = () => {
      const saveButton = el.querySelector("#btn-save-doc");
      const hint = el.querySelector("#d-required-hint");
      const missing = missingDocFields();
      let touchedMissing = false;
      requiredDocFields.forEach(([selector]) => {
        const field = el.querySelector(selector);
        const invalid = missing.some(([s]) => s === selector) && field.dataset.touched === "1";
        touchedMissing ||= invalid;
        field.toggleAttribute("aria-invalid", invalid);
      });
      saveButton.disabled = missing.length > 0;
      saveButton.title = missing.length ? "أكمل الحقول المطلوبة أولاً" : "";
      hint.hidden = missing.length === 0;
      // A quiet note while the form is being filled; red only for a field that was left empty.
      hint.classList.toggle("is-error", touchedMissing);
      hint.textContent = missing.length ? `لحفظ الوثيقة أكمل: ${missing.map(([, label]) => label).join("، ")}` : "";
    };
    const rememberSubject = async subject => {
      if (!subject || documentTypes.includes(subject)) return;
      try { await saveDocumentTypes([...documentTypes, subject]); } catch { /* the document is saved; the list is a convenience */ }
    };
    const saveDoc = async () => {
      const missing = missingDocFields();
      if (missing.length) {
        missing.forEach(([selector]) => { el.querySelector(selector).dataset.touched = "1"; });
        updateRequiredState();
        showToast(`لا يمكن حفظ الوثيقة قبل إكمال: ${missing.map(([, label]) => label).join("، ")}`, "error");
        el.querySelector(missing[0][0])?.focus();
        return false;
      }
      const data = collectDocData();
      let created = null;
      try {
        if (isEdit) {
          await updateCurrentDoc(doc.id, data);
        } else {
          created = await createCurrentDoc(data);
        }
      } catch (err) {
        showToast(errorText(err, "تعذر حفظ الوثيقة"), "error");
        return false;
      }
      await rememberSubject(data.issuer);
      // The document now exists: a file that fails to upload must not lead to saving it twice,
      // so the form becomes the edit form of the new document and names what was not uploaded.
      const failed = [];
      for (const file of pendingAttachments) {
        try { await uploadCurrentDocFile(created.id, file); }
        catch (error) { failed.push(`${pendingName(file)} (${errorText(error, "تعذر الرفع")})`); }
      }
      await refreshCurrentDocs();
      activeDocFormGuard = null;
      if (failed.length) {
        showToast(`حُفظت الوثيقة، ولم يُرفع: ${failed.join("، ")}. أضفه من «المرفقات».`, "error");
        const saved = currentDocs().find(item => item.id === created.id);
        if (saved) showDocForm(saved); else renderGeneral();
        return true;
      }
      showToast(isEdit ? "تم حفظ تعديلات الوثيقة" : "تمت إضافة الوثيقة");
      renderGeneral();
      return true;
    };
    const closeDocForm = async () => {
      if (hasUnsavedDocChanges()) {
        const choice = await confirmSaveChanges();
        if (choice === "cancel") return false;
        if (choice === "save") return await saveDoc();
      }
      activeDocFormGuard = null;
      renderGeneral();
      return true;
    };
    activeDocFormGuard = closeDocForm;
    el.querySelector("#doc-form-stage").addEventListener("click", event => {
      if (event.target === event.currentTarget) closeDocForm();
    });
    el.querySelectorAll("#doc-form-card input,#doc-form-card select,#doc-form-card textarea").forEach(field => {
      if (field.id === "d-employee-search") return;
      field.addEventListener("input", () => { formDirty = true; updateRequiredState(); });
      field.addEventListener("change", () => { formDirty = true; updateRequiredState(); });
    });
    requiredDocFields.forEach(([selector]) => {
      el.querySelector(selector).addEventListener("blur", event => {
        event.currentTarget.dataset.touched = "1";
        updateRequiredState();
      });
    });
    updateRequiredState();

    // Employees: the selected ones show as chips above the list, so they are never lost in it.
    const hasEmployeesCheckbox = el.querySelector("#d-has-employees");
    const employeeLinking = el.querySelector("#d-employee-linking");
    const renderEmployeeChips = () => {
      const chips = el.querySelector("#d-employee-chips");
      chips.innerHTML = [...selectedEmployeeIds].map(id => `<span class="doc-chip">${escHtml(employeeName(id))}
          <button type="button" class="doc-chip-remove" data-id="${id}" aria-label="إزالة ${escHtml(employeeName(id))}" title="إزالة">✕</button></span>`).join("")
        || `<span style="font-size:11px;color:var(--ui-text-faint)">لم يُحدد أي موظف. اختر موظفًا أو أكثر من القائمة.</span>`;
      el.querySelector("#d-selected-count").textContent = `المحدد: ${selectedEmployeeIds.size}`;
      chips.querySelectorAll(".doc-chip-remove").forEach(button => button.addEventListener("click", () => {
        const id = Number(button.dataset.id);
        selectedEmployeeIds.delete(id);
        const checkbox = el.querySelector(`.d-employee-checkbox[value="${id}"]`);
        if (checkbox) checkbox.checked = false;
        formDirty = true;
        renderEmployeeChips();
      }));
    };
    renderEmployeeChips();
    hasEmployeesCheckbox.addEventListener("change", () => {
      employeeLinking.style.display = hasEmployeesCheckbox.checked ? "block" : "none";
      if (!hasEmployeesCheckbox.checked) {
        selectedEmployeeIds.clear();
        el.querySelectorAll(".d-employee-checkbox").forEach(checkbox => { checkbox.checked = false; });
        renderEmployeeChips();
      }
    });
    el.querySelectorAll(".d-employee-checkbox").forEach(checkbox => checkbox.addEventListener("change", () => {
      const id = Number(checkbox.value);
      if (checkbox.checked) selectedEmployeeIds.add(id); else selectedEmployeeIds.delete(id);
      renderEmployeeChips();
    }));
    el.querySelector("#d-employee-search").addEventListener("input", event => {
      const needle = event.target.value.trim().toLowerCase();
      el.querySelectorAll(".doc-employee-option").forEach(option => {
        option.style.display = !needle || option.dataset.search.includes(needle) ? "flex" : "none";
      });
    });

    const pendingName = path => String(path).split(/[\\/]/).pop();
    const renderPendingAttachments = () => {
      setAttachmentBadge(el, pendingAttachments.length);
      const list = el.querySelector("#d-pending-list");
      list.hidden = pendingAttachments.length === 0;
      list.innerHTML = pendingAttachments.map((path, index) => {
        const name = pendingName(path);
        const extension = name.includes(".") ? name.split(".").pop().toUpperCase() : "ملف";
        return `<li class="doc-pending-item" title="${escHtml(path)}">
          <span class="doc-pending-ext">${escHtml(extension)}</span>
          <span class="doc-pending-name">${escHtml(name)}</span>
          <button type="button" class="doc-pending-remove" data-index="${index}" aria-label="إزالة ${escHtml(name)}" title="إزالة">✕</button>
        </li>`;
      }).join("");
      list.querySelectorAll(".doc-pending-remove").forEach(button => button.addEventListener("click", () => {
        pendingAttachments.splice(Number(button.dataset.index), 1);
        formDirty = true;
        renderPendingAttachments();
      }));
    };
    const addPendingAttachments = files => {
      const before = pendingAttachments.length;
      pendingAttachments = [...new Set([...pendingAttachments, ...files])].slice(0, 20);
      if (pendingAttachments.length < before + files.length) showToast("الحد الأقصى 20 مرفقًا للوثيقة", "warn");
      formDirty = true;
      renderPendingAttachments();
    };
    el.querySelector("#d-manage-attachments")?.addEventListener("click", async () => {
      if (isEdit) {
        openAttachmentManager(doc.id, false);
        return;
      }
      const selected = await open({
        multiple: true,
        filters: [{ name: "ملفات الوثائق", extensions: DOCUMENT_EXTENSIONS }],
      });
      if (selected) addPendingAttachments(Array.isArray(selected) ? selected : [selected]);
    });
    if (isEdit) {
      bindScanIntoExistingDoc(el, doc.id);
    } else {
      el.querySelector("#d-scan-attachment")?.addEventListener("click", async () => {
        if (pendingAttachments.length >= 20) {
          showToast("تم الوصول إلى الحد الأقصى للمرفقات", "warn");
          return;
        }
        await scanWithProgress(el, async scannedPath => {
          addPendingAttachments([scannedPath]);
          return "أُضيفت الصورة الممسوحة إلى المرفقات، وتُحفظ مع الوثيقة";
        });
      });
    }

    el.querySelector("#btn-cancel-doc").addEventListener("click", () => closeDocForm());
    el.querySelector("#btn-save-doc").addEventListener("click", () => saveDoc());
    el.querySelector("#btn-delete-doc")?.addEventListener("click", async () => {
      if (!(await confirmAction("تأكيد حذف الوثيقة؟ لا يمكن التراجع عن هذا الإجراء."))) return;
      try {
        await deleteCurrentDoc(doc.id);
        await refreshCurrentDocs();
        activeDocFormGuard = null;
        showToast("تم حذف الوثيقة");
        renderGeneral();
      } catch (err) { showToast(errorText(err, "تعذر حذف الوثيقة"), "error"); }
    });
  }

  container.innerHTML = html();

  container.querySelectorAll(".doc-tab").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (activeDocFormGuard && !(await activeDocFormGuard())) return;
      activeTab = btn.dataset.tab;
      container.querySelectorAll(".doc-tab").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === activeTab)));
      currentPage = 1;
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
