// Person names split into the fields of the national card (and the passport).
// The combined name is still stored and shown everywhere; these inputs edit its parts.

import { escHtml } from "../utils.js";

export const ARABIC_PARTS = [
  ["first", "الاسم"],
  ["father", "الأب"],
  ["grandfather", "الجد"],
  ["surname", "اللقب"],
];

export const PASSPORT_PARTS = [
  ["given", "Given names / الأسماء"],
  ["surname", "Surname / اللقب"],
];

const clean = value => String(value ?? "").trim().split(/\s+/).filter(Boolean).join(" ");

export function joinNameParts(parts, passport = false) {
  if (!parts) return "";
  return (passport ? PASSPORT_PARTS : ARABIC_PARTS).map(([key]) => clean(parts[key])).filter(Boolean).join(" ");
}

function storedParts(emp, key) {
  const all = typeof emp?.name_parts === "string" ? safeParse(emp.name_parts) : emp?.name_parts;
  return all?.[key] ?? null;
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Renders the inputs of one split name.
 * key: the combined field (full_name, mother_name, name, ...); parts: stored parts or null;
 * text: the combined name, shown in the first field when there are no parts yet.
 */
export function nameFieldsHtml({ key, label, parts, text, passport = false, required = false, span = true }) {
  const fields = passport ? PASSPORT_PARTS : ARABIC_PARTS;
  const hasParts = parts && joinNameParts(parts, passport);
  const review = hasParts ? parts.review === true : Boolean(clean(text));
  const value = part => hasParts ? escHtml(parts[part] ?? "") : (part === fields[0][0] ? escHtml(text ?? "") : "");
  return `<div class="name-fields" data-name-key="${key}" data-passport="${passport ? 1 : 0}" data-review="${review ? 1 : 0}" data-has-parts="${hasParts ? 1 : 0}"
      style="${span ? "grid-column:1 / -1;" : ""}">
    <p style="font-size:11px;color:var(--ui-text-faint);letter-spacing:.05em;margin-bottom:4px;display:flex;gap:8px;align-items:center">
      <span>${label}${required ? " *" : ""}</span>
      <span class="name-review-badge" ${review ? "" : "hidden"} title="قُسّم الاسم تلقائيًا ويحتاج تأكيدًا"
        style="font-size:11px;color:var(--ui-warn);background:var(--ui-warn-bg);border-radius:999px;padding:1px 8px">بحاجة لمراجعة</span>
      <button type="button" class="name-review-accept" ${review && hasParts ? "" : "hidden"} title="الإبقاء على التقسيم الظاهر في الحقول">✓ اعتماد التقسيم</button>
    </p>
    <div style="display:grid;grid-template-columns:repeat(${fields.length}, minmax(0, 1fr));gap:6px">
      ${fields.map(([part, partLabel]) => `<label style="display:block;min-width:0">
        <span style="display:block;font-size:10px;color:var(--ui-text-faint);margin-bottom:2px">${partLabel}</span>
        <input class="input-field name-part" data-part="${part}" dir="${passport ? "ltr" : "rtl"}" value="${value(part)}" />
      </label>`).join("")}
    </div>
  </div>`;
}

/** Inputs for a field of the employee record (emp.name_parts holds the parts). */
export function employeeNameFields(label, key, emp, opts = {}) {
  return nameFieldsHtml({ key, label, parts: storedParts(emp, key), text: emp?.[key], ...opts });
}

/** Inputs for a spouse / family member record (record.name_parts holds the parts). */
export function recordNameFields(label, key, record, opts = {}) {
  return nameFieldsHtml({ key, label, parts: storedParts(record, key), text: record?.[key], span: true, ...opts });
}

/** Typing in a split name, or «اعتماد التقسيم», confirms it: the review badge goes away. */
export function bindNameFields(root) {
  root.addEventListener("input", event => {
    const group = event.target.closest?.(".name-fields");
    if (!group) return;
    group.dataset.review = "0";
    group.dataset.touched = "1";
    group.querySelector(".name-review-badge")?.setAttribute("hidden", "");
    group.querySelector(".name-review-accept")?.setAttribute("hidden", "");
  });
  root.addEventListener("click", event => {
    const accept = event.target.closest?.(".name-review-accept");
    if (!accept) return;
    // Same path as typing, so the form is marked as changed and the parts are saved as confirmed.
    accept.closest(".name-fields")?.querySelector(".name-part")?.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/**
 * Reads one split name. Returns { text, parts } where parts is null when the name was not
 * split yet and not edited (the backend then splits the text itself).
 */
export function readNameGroup(group) {
  const passport = group.dataset.passport === "1";
  const parts = {};
  group.querySelectorAll(".name-part").forEach(input => { parts[input.dataset.part] = clean(input.value); });
  const text = joinNameParts(parts, passport);
  if (group.dataset.hasParts !== "1" && group.dataset.touched !== "1") return { text, parts: null };
  parts.review = group.dataset.review === "1";
  return { text, parts };
}

/** Reads every split name inside `root` (not nested in `exclude` rows). */
export function readNameFields(root, excludeSelector = null) {
  const result = {};
  root.querySelectorAll(".name-fields").forEach(group => {
    if (excludeSelector && group.closest(excludeSelector)) return;
    result[group.dataset.nameKey] = readNameGroup(group);
  });
  return result;
}

/** Puts read names into a record: combined text in record[key], parts in record.name_parts. */
export function applyNames(record, names) {
  const parts = typeof record.name_parts === "object" && record.name_parts ? { ...record.name_parts } : {};
  for (const [key, { text, parts: value }] of Object.entries(names)) {
    record[key] = text || null;
    if (value) parts[key] = value; else delete parts[key];
  }
  record.name_parts = parts;
  return record;
}
