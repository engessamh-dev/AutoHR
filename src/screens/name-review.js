// "مراجعة الأسماء": names that were split automatically but need a person to confirm them.

import { api } from "../api.js";
import { showToast, escHtml } from "../utils.js";
import { nameFieldsHtml, readNameGroup } from "./name-fields.js";

const FIELD_LABELS = {
  "employee/full_name": "اسم الموظف",
  "employee/mother_name": "اسم الأم",
  "employee/residence_head_name": "اسم رب الأسرة (بطاقة السكن)",
  "employee/passport_name": "الاسم حسب الجواز",
  "spouse/name": "اسم الزوج/الزوجة",
  "spouse/mother_name": "اسم أم الزوج/الزوجة",
  "family/name": "اسم فرد الأسرة",
};

function itemLabel(item) {
  const label = FIELD_LABELS[`${item.owner}/${item.field}`] ?? item.field;
  return item.owner === "employee" ? label : `${label} ${item.index + 1}`;
}

function itemHtml(item, i) {
  const original = item.original_text && item.original_text !== item.text
    ? `<span style="color:var(--ui-text-faint)"> · الأصل: ${escHtml(item.original_text)}</span>` : "";
  return `<div class="name-review-item card" data-i="${i}" style="padding:12px;display:flex;flex-direction:column;gap:8px">
    <div style="font-size:13px;display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
      <span><strong>${escHtml(item.employee_name)}</strong> · ${escHtml(itemLabel(item))}</span>
      <span style="color:var(--ui-text-muted)">${escHtml(item.text)}${original}</span>
    </div>
    ${nameFieldsHtml({ key: item.field, label: "", parts: item.parts, text: item.text, passport: item.field === "passport_name" })}
    <div style="display:flex;justify-content:flex-end">
      <button class="btn-primary text-sm px-3 py-1.5 btn-confirm-name">تأكيد</button>
    </div>
  </div>`;
}

/** Opens the review dialog. `onChanged` runs after each confirmed name. */
export async function openNameReview(onChanged) {
  let items = await api.listNameReview();
  const overlay = document.createElement("div");
  overlay.style.cssText = "position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px";
  overlay.innerHTML = `<div role="dialog" aria-label="مراجعة الأسماء" dir="rtl"
      style="background:var(--ui-surface);border:1px solid var(--ui-line);border-radius:12px;width:min(760px,100%);max-height:90vh;display:flex;flex-direction:column">
    <div style="padding:14px 16px;border-bottom:1px solid var(--ui-line);display:flex;align-items:center;gap:8px">
      <strong style="font-size:15px">مراجعة الأسماء</strong>
      <span id="name-review-count" style="font-size:12px;color:var(--ui-text-muted)"></span>
      <button id="name-review-close" class="btn-secondary text-sm" style="margin-right:auto">إغلاق</button>
    </div>
    <p style="padding:10px 16px 0;font-size:12px;color:var(--ui-text-muted)">قُسّمت هذه الأسماء تلقائيًا ولم يكن التقسيم مؤكدًا. صحّح الحقول إن لزم ثم اضغط «تأكيد». الاسم الكامل يُعاد تجميعه من الحقول.</p>
    <div id="name-review-list" style="padding:12px 16px;overflow:auto;display:flex;flex-direction:column;gap:10px"></div>
  </div>`;
  document.body.append(overlay);

  const close = () => overlay.remove();
  overlay.querySelector("#name-review-close").addEventListener("click", close);
  overlay.addEventListener("click", event => { if (event.target === overlay) close(); });

  const render = () => {
    overlay.querySelector("#name-review-count").textContent = items.length ? `${items.length} اسم` : "";
    const list = overlay.querySelector("#name-review-list");
    list.innerHTML = items.length
      ? items.map(itemHtml).join("")
      : `<p style="font-size:13px;color:var(--ui-text-muted);padding:12px 0">لا توجد أسماء بحاجة لمراجعة.</p>`;
    list.querySelectorAll(".btn-confirm-name").forEach(button => {
      button.addEventListener("click", async () => {
        const row = button.closest(".name-review-item");
        const item = items[Number(row.dataset.i)];
        const group = row.querySelector(".name-fields");
        group.dataset.touched = "1";
        group.dataset.review = "0";
        const values = readNameGroup(group).parts;
        button.disabled = true;
        try {
          await api.saveNameReview(item.employee_id, item.owner, item.index, item.field, values);
          items = items.filter(other => other !== item);
          render();
          showToast("تم تأكيد الاسم");
          await onChanged?.();
        } catch (err) {
          button.disabled = false;
          showToast(err?.message ?? String(err || "تعذر الحفظ"), "error");
        }
      });
    });
  };
  render();
}
