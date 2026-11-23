// Zoom, rotate and pan for an image shown in an attachment viewer.
// Shared by the employee documents viewer and the archive preview.

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];

const ICONS = {
  out: `<path d="M5 12h14"/>`,
  in: `<path d="M12 5v14M5 12h14"/>`,
  fit: `<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>`,
  left: `<path d="M9 4 4 9l5 5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>`,
  right: `<path d="m15 4 5 5-5 5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>`,
};
const icon = name => `<svg aria-hidden="true" viewBox="0 0 24 24" class="zv-icon">${ICONS[name]}</svg>`;

/** Toolbar markup; bind it with mountZoomViewer(). */
export function zoomToolbarHtml() {
  return `<div class="zv-toolbar" role="toolbar" aria-label="أدوات العرض">
    <button type="button" class="zv-btn zv-zoom-out" title="تصغير (-)" aria-label="تصغير">${icon("out")}</button>
    <button type="button" class="zv-btn zv-percent" title="ملاءمة الشاشة (0)" aria-label="ملاءمة الشاشة" dir="ltr">100%</button>
    <button type="button" class="zv-btn zv-zoom-in" title="تكبير (+)" aria-label="تكبير">${icon("in")}</button>
    <button type="button" class="zv-btn zv-fit" title="ملاءمة الشاشة (0)" aria-label="ملاءمة الشاشة">${icon("fit")}</button>
    <span class="zv-sep" aria-hidden="true"></span>
    <button type="button" class="zv-btn zv-rotate-right" title="تدوير مع عقارب الساعة (R)" aria-label="تدوير مع عقارب الساعة">${icon("right")}</button>
    <button type="button" class="zv-btn zv-rotate-left" title="تدوير عكس عقارب الساعة" aria-label="تدوير عكس عقارب الساعة">${icon("left")}</button>
  </div>`;
}

/**
 * Makes `img` inside the scrollable `stage` zoomable and rotatable.
 * `toolbar` holds the buttons from zoomToolbarHtml(). Returns { handleKey, destroy }.
 */
export function mountZoomViewer({ stage, img, toolbar }) {
  let fitScale = 1;
  let zoom = 1; // relative to "fit"
  let rotation = 0;
  stage.classList.add("zv-stage");
  const frame = document.createElement("div");
  frame.className = "zv-frame";
  img.replaceWith(frame);
  frame.append(img);
  img.classList.add("zv-img");
  img.draggable = false;

  const natural = () => ({ w: img.naturalWidth || 1, h: img.naturalHeight || 1 });
  const turned = () => rotation % 180 !== 0;

  function computeFit() {
    const { w, h } = natural();
    const [bw, bh] = turned() ? [h, w] : [w, h];
    const availW = Math.max(40, stage.clientWidth - 24);
    const availH = Math.max(40, stage.clientHeight - 24);
    fitScale = Math.min(availW / bw, availH / bh);
  }

  function layout(anchor = null) {
    const before = anchor && { x: stage.scrollLeft + anchor.x, y: stage.scrollTop + anchor.y, w: frame.offsetWidth, h: frame.offsetHeight };
    const { w, h } = natural();
    const scale = fitScale * zoom;
    const iw = w * scale, ih = h * scale;
    const [fw, fh] = turned() ? [ih, iw] : [iw, ih];
    frame.style.width = `${fw}px`;
    frame.style.height = `${fh}px`;
    img.style.width = `${iw}px`;
    img.style.height = `${ih}px`;
    img.style.transform = `translate(-50%, -50%) rotate(${rotation}deg)`;
    stage.classList.toggle("is-pannable", fw > stage.clientWidth || fh > stage.clientHeight);
    const percent = toolbar?.querySelector(".zv-percent");
    if (percent) percent.textContent = `${Math.round(scale * 100)}%`;
    if (before && before.w && before.h) {
      stage.scrollLeft = before.x * (fw / before.w) - anchor.x;
      stage.scrollTop = before.y * (fh / before.h) - anchor.y;
    }
  }

  function setZoom(next, anchor = null) {
    zoom = Math.min(8 / Math.max(fitScale, 0.01), Math.max(0.1, next));
    layout(anchor ?? { x: stage.clientWidth / 2, y: stage.clientHeight / 2 });
  }
  function step(direction, anchor) {
    const actual = fitScale * zoom;
    const target = direction > 0
      ? ZOOM_STEPS.find(s => s > actual + 0.001) ?? actual * 1.25
      : [...ZOOM_STEPS].reverse().find(s => s < actual - 0.001) ?? actual / 1.25;
    setZoom(target / fitScale, anchor);
  }
  function fit() { zoom = 1; computeFit(); layout(); }
  function rotate(delta) { rotation = (rotation + delta + 360) % 360; computeFit(); zoom = 1; layout(); }

  const clicks = {
    ".zv-zoom-in": () => step(1),
    ".zv-zoom-out": () => step(-1),
    ".zv-fit": fit,
    ".zv-percent": fit,
    ".zv-rotate-right": () => rotate(90),
    ".zv-rotate-left": () => rotate(-90),
  };
  const onToolbarClick = event => {
    for (const [selector, run] of Object.entries(clicks)) {
      if (event.target.closest(selector)) { event.stopPropagation(); run(); return; }
    }
  };
  toolbar?.addEventListener("click", onToolbarClick);

  const onWheel = event => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    const rect = stage.getBoundingClientRect();
    step(event.deltaY < 0 ? 1 : -1, { x: event.clientX - rect.left, y: event.clientY - rect.top });
  };
  stage.addEventListener("wheel", onWheel, { passive: false });
  stage.addEventListener("dblclick", event => {
    const rect = stage.getBoundingClientRect();
    if (zoom > 1.01) fit();
    else setZoom(2, { x: event.clientX - rect.left, y: event.clientY - rect.top });
  });

  let drag = null;
  stage.addEventListener("pointerdown", event => {
    if (!stage.classList.contains("is-pannable") || event.button !== 0) return;
    drag = { x: event.clientX, y: event.clientY, left: stage.scrollLeft, top: stage.scrollTop };
    stage.setPointerCapture(event.pointerId);
    stage.classList.add("is-dragging");
  });
  stage.addEventListener("pointermove", event => {
    if (!drag) return;
    stage.scrollLeft = drag.left - (event.clientX - drag.x);
    stage.scrollTop = drag.top - (event.clientY - drag.y);
  });
  const endDrag = () => { drag = null; stage.classList.remove("is-dragging"); };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);

  const onResize = () => { computeFit(); layout(); };
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(onResize) : null;
  observer?.observe(stage);
  if (img.complete && img.naturalWidth) fit();
  else img.addEventListener("load", fit, { once: true });

  /** Keyboard shortcuts; returns true when the key was used. */
  function handleKey(event) {
    if (event.ctrlKey || event.metaKey || event.altKey) return false;
    if (event.key === "+" || event.key === "=") { step(1); return true; }
    if (event.key === "-" || event.key === "_") { step(-1); return true; }
    if (event.key === "0") { fit(); return true; }
    if (event.key === "r" || event.key === "R" || event.key === "ق") { rotate(event.shiftKey ? -90 : 90); return true; }
    return false;
  }

  return {
    handleKey,
    get rotation() { return rotation; },
    destroy() { observer?.disconnect(); toolbar?.removeEventListener("click", onToolbarClick); },
  };
}
