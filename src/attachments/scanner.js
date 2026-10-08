import { createLivePreview } from "./live-preview.js";
import { invoke } from "@tauri-apps/api/core";

export const isScannable = path => /\.(jpe?g|png|webp)$/i.test(String(path));
let active = false;
const blobUrl = bytes => URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }));

function modal(content) {
  const previous = document.activeElement;
  const overlay = document.createElement("div");
  overlay.className = "smart-scanner-overlay";
  overlay.dir = "rtl";
  overlay.innerHTML = `<section class="smart-scanner-dialog" role="dialog" aria-modal="true" aria-label="تحديد حدود المرفق وتدويره">${content}</section>`;
  document.body.append(overlay);
  const trap = event => {
    if (event.key !== "Tab") return;
    const nodes = [...overlay.querySelectorAll('button:not(:disabled),input:not(:disabled),[tabindex="0"]')];
    const first = nodes[0], last = nodes.at(-1);
    if (event.shiftKey && (document.activeElement === first || !overlay.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  overlay.addEventListener("keydown", trap);
  overlay.addEventListener("keydown", event => event.stopPropagation());
  overlay.querySelector("button,input")?.focus();
  return { overlay, close() { overlay.remove(); previous?.isConnected && previous.focus(); } };
}

async function chooseUpload() {
  return new Promise(resolve => {
    const view = modal(`<h2>رفع الصورة</h2><p>يمكن حفظ الصورة كما هي، أو تحديد حدود المستند يدويًا وتصحيح المنظور محليًا.</p>
      <div class="smart-scanner-actions"><button type="button" class="btn-primary" data-choice="scan">تحديد حدود المرفق وتدويره</button>
      <button type="button" class="btn-secondary" data-choice="original">رفع بالطريقة المعتادة</button>
      <button type="button" class="btn-secondary" data-choice="cancel">إلغاء الرفع</button></div>`);
    const finish = value => { view.close(); resolve(value); };
    view.overlay.querySelectorAll("[data-choice]").forEach(button => button.addEventListener("click", () => finish(button.dataset.choice)));
    view.overlay.addEventListener("keydown", event => { if (event.key === "Escape") { event.stopPropagation(); finish("cancel"); } });
  });
}
async function prepareScanner(args) {
  const view = modal(`<h2>تحديد حدود المرفق وتدويره</h2><p role="status">جارٍ تحميل الصورة وتصحيح اتجاهها لتحديد الحدود والتدوير…</p>`);
  try { return await invoke("cmd_scanner_prepare", args); }
  finally { view.close(); }
}

export async function scanDialog(input) {
  const automaticDetection = import.meta.env.DEV && input.automatic_detection_available !== false;
  const originalUrl = blobUrl(input.preview);
  let processedUrl = null, rotation = 0, busy = false;
  let corners = automaticDetection && input.reliable ? input.corners.map(p => [...p]) : [[0, 0], [input.width - 1, 0], [input.width - 1, input.height - 1], [0, input.height - 1]];
  return new Promise(resolve => {
    const view = modal(`<h2>تحديد حدود المرفق وتدويره</h2>
      <p data-status role="status">${automaticDetection && input.reliable ? `ثقة الكشف: ${Math.round(input.confidence * 100)}٪ — راجع الحواف قبل الحفظ.` : !automaticDetection || input.settings.auto_detect === false ? "حرّك الزوايا الأربع لتحديد حدود المرفق، ودوّر الناتج عند الحاجة، ثم راجع المعاينة قبل الحفظ." : "الكشف غير موثوق: لم يُطبّق قص تلقائي. الإطار البرتقالي نقطة بداية يدوية، وليس مستنداً مكتشفاً. عدّل الزوايا أو احتفظ بكامل الصورة."}</p>
      <div class="smart-scanner-toolbar">
        <label>تكبير <input data-zoom type="range" min="50" max="400" step="25" value="100"></label>
        <button type="button" class="btn-secondary" data-fit>ملاءمة الصورة</button>
        <button type="button" class="btn-secondary" data-reset>إعادة تعيين الحواف</button>
        <button type="button" class="btn-secondary" data-rotate>تدوير الناتج 90°</button>
      </div>
      <div class="smart-scanner-previews">
        <section><h3>الأصل — حرّك الزوايا أو استخدم مفاتيح الأسهم</h3><div class="smart-scanner-scroll"><div class="smart-scanner-image">
          <img data-original alt="الصورة الأصلية بعد تصحيح اتجاه الكاميرا">
          <svg data-frame viewBox="0 0 ${input.width - 1} ${input.height - 1}" preserveAspectRatio="none" aria-label="حدود المستند"><g data-debug-overlay></g><polygon data-selected></polygon></svg>
          ${["أعلى اليسار", "أعلى اليمين", "أسفل اليمين", "أسفل اليسار"].map((label, i) => `<button type="button" class="smart-scanner-corner" data-corner="${i}" aria-label="زاوية ${label}"></button>`).join("")}
        </div></div></section>
        <section><h3>معاينة النتيجة</h3><img data-result alt="المستند بعد القص وتصحيح المنظور" hidden></section>
      </div>
      ${automaticDetection ? '<details data-debug><summary>Detection diagnostics (Development)</summary><pre data-metrics dir="ltr"></pre></details>' : ''}
      <p data-error role="alert"></p>
      <div class="smart-scanner-actions"><button type="button" class="btn-primary" data-process>تطبيق القص / إعادة المعالجة</button>
      <button type="button" class="btn-secondary" data-cancel>إلغاء دون تغيير</button></div>`);
    const root = view.overlay;
    root.querySelector("[data-original]").src = originalUrl;
    let manual = !automaticDetection || !input.reliable;
    const imageBox = root.querySelector(".smart-scanner-image");
    const viewport = root.querySelector(".smart-scanner-scroll");
    const fit = () => {
      const scale = Math.min((viewport.clientWidth - 32) / input.width, (viewport.clientHeight - 32) / input.height);
      const zoom = Number(root.querySelector("[data-zoom]").value) / 100;
      imageBox.style.width = `${Math.max(1, input.width * scale * zoom)}px`;
      imageBox.style.height = `${Math.max(1, input.height * scale * zoom)}px`;
    };
    const observer = new ResizeObserver(fit); observer.observe(viewport);
    root.querySelector("[data-original]").addEventListener("load", fit);
    const debugDraw = () => {
      const panel = root.querySelector("[data-debug]"); if (!panel) return;
      const metrics = input.debug || { ai_status: "No diagnostic data supplied" };
      root.querySelector("[data-metrics]").textContent = JSON.stringify({ ...metrics, contours: metrics.contours?.length, selected_polygon: corners, selection: manual ? "manual starting position / edited" : "detected", confidence: input.confidence, confidence_threshold: input.settings.confidence_threshold, reliable: input.reliable }, null, 2);
      const group = root.querySelector("[data-debug-overlay]"); group.replaceChildren();
      if (!panel.open) return;
      const add = (points, color) => { const el = document.createElementNS("http://www.w3.org/2000/svg", "polyline"); el.setAttribute("points", points.map(p => p.join(",")).join(" ")); el.setAttribute("fill", "none"); el.setAttribute("stroke", color); el.setAttribute("stroke-width", "1"); el.setAttribute("vector-effect", "non-scaling-stroke"); group.append(el); };
      (metrics.contours || []).forEach(points => add(points, "#38bdf8"));
      (metrics.candidates || []).forEach(c => add([...c.corners, c.corners[0]], c.rejection ? "#f87171" : "#c084fc"));
    };
    root.querySelector("[data-debug]")?.addEventListener("toggle", debugDraw);
    let livePreview, previewFrame = null;
    const updatePreview = () => {
      if (previewFrame !== null) return;
      previewFrame = requestAnimationFrame(() => {
        previewFrame = null;
        if (!livePreview || !root.isConnected || busy) return;
        const url = livePreview(corners, rotation);
        if (!url) return;
        const result = root.querySelector("[data-result]");
        result.src = url; result.hidden = false;
      });
    };
    const original = root.querySelector("[data-original]");
    const initializePreview = () => {
      livePreview = createLivePreview(original, input.width, input.height);
      updatePreview();
    };
    original.addEventListener("load", initializePreview, { once: true });
    if (original.complete && original.naturalWidth) initializePreview();
    const invalidate = updatePreview;
    const draw = () => {
      imageBox.classList.toggle("is-manual", manual);
      debugDraw();
      root.querySelector("[data-selected]").setAttribute("points", corners.map(p => p.join(",")).join(" "));
      root.querySelectorAll("[data-corner]").forEach((button, i) => { button.style.left = `${corners[i][0] / (input.width - 1) * 100}%`; button.style.top = `${corners[i][1] / (input.height - 1) * 100}%`; });
    };
    const finish = result => {
      if (busy) return;
      if (previewFrame !== null) cancelAnimationFrame(previewFrame);
      observer.disconnect(); URL.revokeObjectURL(originalUrl); if (processedUrl) URL.revokeObjectURL(processedUrl);
      view.close(); resolve(result);
    };
    root.addEventListener("keydown", event => { if (event.key === "Escape") { event.stopPropagation(); finish(null); } });
    root.querySelector("[data-cancel]").addEventListener("click", () => finish(null));
    root.querySelector("[data-fit]").addEventListener("click", () => { root.querySelector("[data-zoom]").value = "100"; fit(); viewport.scrollTop = 0; viewport.scrollLeft = 0; });
    root.querySelector("[data-zoom]").addEventListener("input", event => { fit(); });
    root.querySelector("[data-reset]").addEventListener("click", () => { corners = [[0, 0], [input.width - 1, 0], [input.width - 1, input.height - 1], [0, input.height - 1]]; rotation = 0; manual = true; root.querySelector("[data-status]").textContent = automaticDetection ? "تحديد يدوي: إطار الصورة نقطة بداية فقط، وليس مستنداً مكتشفاً." : "حرّك الزوايا لتحديد الحدود، ثم طبّق القص والتدوير للمعاينة."; invalidate(); draw(); });
    root.querySelector("[data-rotate]").addEventListener("click", () => {
      if (busy) return;
      rotation = (rotation + 90) % 360;
      updatePreview();
    });
    root.querySelectorAll("[data-corner]").forEach((button, i) => {
      const move = (x, y) => { manual = true; corners[i] = [Math.max(0, Math.min(input.width - 1, x)), Math.max(0, Math.min(input.height - 1, y))]; invalidate(); draw(); };
      button.addEventListener("pointerdown", event => { if (!busy) { event.preventDefault(); button.focus({ preventScroll: true }); button.setPointerCapture(event.pointerId); } });
      button.addEventListener("pointermove", event => {
        if (busy || !button.hasPointerCapture(event.pointerId)) return;
        const rect = root.querySelector(".smart-scanner-image").getBoundingClientRect();
        move((event.clientX - rect.left) / rect.width * (input.width - 1), (event.clientY - rect.top) / rect.height * (input.height - 1));
      });
      button.addEventListener("pointerup", event => { if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId); });
      button.addEventListener("keydown", event => {
        if (busy || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation(); const step = event.shiftKey ? 10 : 1;
        move(corners[i][0] + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0), corners[i][1] + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0));
      });
    });
    const renderPreview = async () => {
      if (busy) return false;
      busy = true; root.querySelector("[data-error]").textContent = "";
      root.querySelector("[data-status]").textContent = "جارٍ تصحيح المنظور بالدقة الأصلية…";
      root.querySelectorAll("button,input").forEach(el => { el.disabled = true; });
      try {
        const bytes = await invoke("cmd_scanner_render", { token: input.token, corners, rotation });
        const nextUrl = blobUrl(bytes);
        try {
          const image = new Image(); image.src = nextUrl;
          await image.decode();
        } catch (error) { URL.revokeObjectURL(nextUrl); throw error; }
        const previousUrl = processedUrl;
        processedUrl = nextUrl;
        const result = root.querySelector("[data-result]");
        result.src = processedUrl; result.hidden = false;
        if (previousUrl) URL.revokeObjectURL(previousUrl);
        root.querySelector("[data-status]").textContent = "راجع النتيجة. الحفظ يحافظ على الأصل دون تغييره.";
        return true;
      } catch (error) {
        root.querySelector("[data-error]").textContent = `تعذرت المعالجة: ${String(error)}`;
        root.querySelector("[data-status]").textContent = "تعذر تحديث المعاينة. أعد تطبيق المعالجة قبل الحفظ.";
        return false;
      }
      finally { busy = false; root.querySelectorAll("button,input").forEach(el => { el.disabled = false; }); }
    };
    root.querySelector("[data-process]").addEventListener("click", async () => {
      if (await renderPreview()) finish(input.token);
    });
    draw();
  });
}

/** All current and future attachment entry points should call this bridge. */
export async function uploadWithScanner(command, args) {
  if (!isScannable(args.sourcePath)) return invoke(command, args);
  if (active) throw new Error("أغلق الماسح الحالي أولًا");
  active = true; let token;
  try {
    const settings = await invoke("cmd_scanner_settings");
    if (!settings.enabled) return await invoke(command, args);
    const choice = await chooseUpload();
    if (choice === "cancel") throw new Error("أُلغي الرفع دون تغيير المرفق");
    if (choice === "original") return await invoke(command, args);
    const prepared = await prepareScanner({ sourcePath: args.sourcePath, relativePath: null, kind: command }); token = prepared.token;
    if (!await scanDialog(prepared)) throw new Error("أُلغيت المعالجة دون تغيير المرفق");
    const { sourcePath: _source, ...context } = args;
    return await invoke("cmd_scanner_upload", { token, command, context });
  } finally { if (token) await invoke("cmd_scanner_release", { token }).catch(() => {}); active = false; }
}

export async function reprocessAttachment(relativePath) {
  if (!isScannable(relativePath)) return false;
  if (active) throw new Error("أغلق الماسح الحالي أولًا");
  active = true; let token;
  try {
    const input = await prepareScanner({ relativePath, sourcePath: null, kind: "existing" }); token = input.token;
    if (!await scanDialog(input)) return false;
    await invoke("cmd_scanner_save_existing", { token, relativePath });
    return true;
  } finally { if (token) await invoke("cmd_scanner_release", { token }).catch(() => {}); active = false; }
}

