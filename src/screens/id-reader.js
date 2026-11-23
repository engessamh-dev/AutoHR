// Reads an identity document image on the device and lets the user review the values before
// they go into the form. Nothing is saved here: the chosen values fill the open form, and the
// user still saves the employee record as usual.

import { api } from "../api.js";
import { escHtml, showToast } from "../utils.js";

const LOW_CONFIDENCE = 0.85;

function busyOverlay(text) {
  const overlay = document.createElement("div");
  overlay.className = "emp-viewer id-reader";
  overlay.setAttribute("role", "alertdialog");
  overlay.setAttribute("aria-busy", "true");
  overlay.innerHTML = `<div class="id-reader-busy"><span class="id-reader-spinner" aria-hidden="true"></span>${escHtml(text)}</div>`;
  document.body.append(overlay);
  return () => overlay.remove();
}

function rowHtml(row, index) {
  const conflict = row.current && row.current !== row.value;
  const checked = !row.current || row.current === row.value ? "checked" : "";
  const low = row.confidence < LOW_CONFIDENCE;
  const badge = row.source === "mrz" && !low
    ? `<span class="id-reader-badge is-ok" title="تطابق مع أرقام التحقق في الشريط السفلي">مُتحقَّق</span>`
    : low ? `<span class="id-reader-badge is-warn" title="القراءة غير مؤكدة، راجعها مع الصورة">راجِع</span>` : "";
  return `<tr class="${low ? "is-low" : ""} ${conflict ? "is-conflict" : ""}">
    <td><input type="checkbox" class="id-reader-pick" data-index="${index}" ${checked} aria-label="اعتماد ${escHtml(row.label)}" /></td>
    <th scope="row">${escHtml(row.label)} ${badge}</th>
    <td class="id-reader-current" dir="${row.ltr ? "ltr" : "rtl"}">${row.current ? escHtml(row.current) : `<span class="id-reader-empty">فارغ</span>`}</td>
    <td><input class="input-field id-reader-value" data-index="${index}" type="${row.date ? "date" : "text"}" dir="${row.ltr ? "ltr" : "rtl"}" value="${escHtml(row.value)}" /></td>
  </tr>`;
}

function reviewDialog({ title, imageUrl, rows, warnings }) {
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "emp-viewer id-reader";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", title);
    const conflicts = rows.filter(r => r.current && r.current !== r.value).length;
    overlay.innerHTML = `<div class="emp-viewer-box id-reader-box" dir="rtl">
      <div class="emp-viewer-head"><span>${escHtml(title)}</span><button type="button" class="emp-viewer-close" aria-label="إغلاق">✕</button></div>
      <div class="id-reader-body">
        ${imageUrl ? `<div class="id-reader-image"><img src="${escHtml(imageUrl)}" alt="${escHtml(title)}" /></div>` : ""}
        <div class="id-reader-fields">
          <p class="id-reader-note">قُرئت هذه القيم من الصورة على هذا الجهاز. راجعها مع الصورة، وعدّل ما يلزم، ثم اختر ما تريد اعتماده.
            ${conflicts ? `<br><strong>${conflicts} من الحقول فيها قيمة سابقة مختلفة، ولم تُحدَّد تلقائيًا.</strong>` : ""}</p>
          ${warnings.map(w => `<p class="id-reader-warning">${escHtml(w)}</p>`).join("")}
          <table class="id-reader-table">
            <thead><tr><th></th><th>الحقل</th><th>القيمة الحالية</th><th>المقروء من الصورة</th></tr></thead>
            <tbody>${rows.map(rowHtml).join("")}</tbody>
          </table>
        </div>
      </div>
      <div class="id-reader-actions">
        <button type="button" class="btn-primary id-reader-apply">اعتماد المحدَّد</button>
        <button type="button" class="btn-secondary id-reader-cancel">إلغاء</button>
      </div>
    </div>`;
    const finish = value => {
      document.removeEventListener("keydown", onKey, true);
      overlay.remove();
      resolve(value);
    };
    const onKey = event => { if (event.key === "Escape") { event.stopPropagation(); finish(null); } };
    overlay.addEventListener("input", event => {
      const input = event.target.closest(".id-reader-value");
      if (input) overlay.querySelector(`.id-reader-pick[data-index="${input.dataset.index}"]`).checked = true;
    });
    overlay.addEventListener("click", event => {
      if (event.target === overlay || event.target.closest(".emp-viewer-close, .id-reader-cancel")) finish(null);
      if (event.target.closest(".id-reader-apply")) {
        const chosen = {};
        overlay.querySelectorAll(".id-reader-pick:checked").forEach(box => {
          const index = Number(box.dataset.index);
          const value = overlay.querySelector(`.id-reader-value[data-index="${index}"]`).value.trim();
          if (value) chosen[rows[index].id] = value;
        });
        finish(chosen);
      }
    });
    document.addEventListener("keydown", onKey, true);
    document.body.append(overlay);
    overlay.querySelector(".id-reader-apply").focus();
  });
}

/**
 * Reads the stored attachment at `path` and shows the review dialog.
 * buildRows(result) returns [{ id, label, current, value, confidence, source, ltr?, date? }].
 * Resolves to { id: value } for the confirmed rows, or null when cancelled or nothing was read.
 */
export async function readDocumentFields({ path, imageUrl, title, buildRows }) {
  const done = busyOverlay("جارِ قراءة البيانات من الصورة…");
  let result;
  try {
    result = await api.readDocumentFields(path);
  } catch (err) {
    showToast(err?.message ?? String(err || "تعذّرت قراءة الصورة"), "error");
    return null;
  } finally {
    done();
  }
  const rows = buildRows(result).filter(row => row.value);
  if (rows.length === 0) {
    showToast("لم أتمكن من قراءة بيانات من هذه الصورة. جرّب صورة أوضح أو أدخل البيانات يدويًا.", "error");
    return null;
  }
  return reviewDialog({ title, imageUrl, rows, warnings: result.warnings ?? [] });
}
