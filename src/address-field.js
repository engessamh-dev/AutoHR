/**
 * The residence address, as the add-employee wizard and the employee file enter it:
 * المحافظة → القضاء → الناحية (linked lists), المدينة / الحي, then م / ز / د — or, with
 * «تنسيق عنوان آخر» ticked, one free-text line instead of م / ز / د.
 *
 * Kept as parts ({gov, district, sub, city, m, z, d, other, useOther}) in
 * `residence_address_parts`, and composed into one line in `residence_address` for display,
 * reports and search.
 */
import { api } from "./api.js";
import { escHtml, showToast, parseAddress, composeAddress } from "./utils.js";
import { IRAQ_PLACES, DISTRICT_CENTRE } from "./data/iraq-places.js";

export const EMPTY_ADDRESS = Object.freeze({ gov: "", district: "", sub: "", city: "", m: "", z: "", d: "", other: "", useOther: "" });
const ADD = "__add__";
const text = v => String(v ?? "").trim();

/** Places users added (from the database), loaded once per session. */
let added = [];
let loading = null;
export function loadAddressPlaces() {
  loading ??= api.listAddressPlaces().then(list => { added = list ?? []; }).catch(() => { loading = null; });
  return loading;
}

const unique = list => [...new Set(list.filter(Boolean))];
export const governorates = () => Object.keys(IRAQ_PLACES);
export const districtsOf = gov => unique([...Object.keys(IRAQ_PLACES[gov] ?? {}), ...added.filter(p => p.governorate === gov && !p.subdistrict).map(p => p.district)]);
export const subdistrictsOf = (gov, district) => unique([
  DISTRICT_CENTRE,
  ...(IRAQ_PLACES[gov]?.[district] ?? []),
  ...added.filter(p => p.governorate === gov && p.district === district && p.subdistrict).map(p => p.subdistrict),
]);

/** The stored parts, or an older single-line address split as well as it can be. */
export function readAddress(stored, line) {
  if (stored && typeof stored === "object") return { ...EMPTY_ADDRESS, ...stored };
  try {
    const parsed = stored ? JSON.parse(stored) : null;
    if (parsed && typeof parsed === "object") return { ...EMPTY_ADDRESS, ...parsed };
  } catch { /* an older value: split the line below */ }
  const old = parseAddress(line);
  if (old.loose) return { ...EMPTY_ADDRESS, other: text(line), useOther: "1" };
  return { ...EMPTY_ADDRESS, m: old.m, z: old.z, d: old.d };
}

export const addressIsEmpty = parts => !parts || ["gov", "district", "sub", "city", "m", "z", "d", "other"].every(k => !text(parts[k]));

/** «بغداد / الكرخ / المنصور / حي …، م 000 ز 00 د 0» — the one line kept and shown. */
export function composeResidence(parts) {
  if (!parts) return "";
  const place = [parts.gov, parts.district, parts.sub === DISTRICT_CENTRE ? "" : parts.sub, parts.city].map(text).filter(Boolean).join(" / ");
  const detail = parts.useOther ? text(parts.other) : composeAddress({ m: parts.m, z: parts.z, d: parts.d });
  return [place, detail].filter(Boolean).join("، ");
}

/** Values to suggest for المدينة / الحي: those already entered for other employees. */
export const citySuggestions = employees => unique((employees ?? []).map(e => text(readAddress(e.residence_address_parts, e.residence_address).city))).sort((a, b) => a.localeCompare(b, "ar"));

const state = new WeakMap();

/** The field's HTML. `key` names the value; `cities` are suggestions for المدينة / الحي. */
export function addressHtml(key, parts, { cities = [], adding = "" } = {}) {
  const p = { ...EMPTY_ADDRESS, ...parts };
  const option = (value, label = value, selected = false) => `<option value="${escHtml(value)}" ${selected ? "selected" : ""}>${escHtml(label)}</option>`;
  const choices = (list, current, placeholder, addLabel) => {
    const items = current && !list.includes(current) ? [...list, current] : list;
    return option("", placeholder, !current) + items.map(v => option(v, v, v === current)).join("") + (addLabel ? option(ADD, addLabel) : "");
  };
  const label = (title, control, cls = "") => `<label class="addr-cell ${cls}"><span>${title}</span>${control}</label>`;
  const select = (part, list, current, placeholder, addLabel, disabled) =>
    `<select class="input-field" data-addr="${part}" aria-label="${placeholder}" ${disabled ? "disabled" : ""}>${choices(list, current, placeholder, addLabel)}</select>`;
  const input = (part, value, title, extra = "") => `<input class="input-field" data-addr="${part}" value="${escHtml(value)}" aria-label="${title}" ${extra}>`;
  const listId = `addr-cities-${key}`;
  const addRow = adding ? `<div class="addr-add" role="group" aria-label="إضافة ${adding === "district" ? "قضاء" : "ناحية"}">
      <input class="input-field" data-addr-new placeholder="${adding === "district" ? `اسم القضاء في ${escHtml(p.gov)}` : `اسم الناحية في ${escHtml(p.district)}`}" aria-label="الاسم الجديد">
      <button type="button" class="btn-primary" data-addr-save>إضافة</button><button type="button" class="btn-secondary" data-addr-cancel>إلغاء</button></div>` : "";
  return `<div class="addr" data-address="${escHtml(key)}" data-adding="${adding}">
    <div class="addr-row addr-place">
      ${label("المحافظة", select("gov", governorates(), p.gov, "اختر المحافظة", "", false))}
      ${label("القضاء", select("district", p.gov ? districtsOf(p.gov) : [], p.district, p.gov ? "اختر القضاء" : "اختر المحافظة أولًا", p.gov ? `+ إضافة قضاء غير موجود في ${p.gov}…` : "", !p.gov))}
      ${label("الناحية", select("sub", p.district ? subdistrictsOf(p.gov, p.district) : [], p.sub, p.district ? "اختر الناحية" : "اختر القضاء أولًا", p.district ? `+ إضافة ناحية غير موجودة في ${p.district}…` : "", !p.district))}
      ${label("المدينة / الحي", input("city", p.city, "المدينة / الحي", `list="${listId}" placeholder="اكتب أو اختر"`))}
    </div>
    ${addRow}
    <datalist id="${listId}">${cities.map(c => `<option value="${escHtml(c)}">`).join("")}</datalist>
    <div class="addr-row addr-mzd ${p.useOther ? "is-off" : ""}">
      ${["m", "z", "d"].map(part => label({ m: "م", z: "ز", d: "د" }[part], input(part, p.useOther ? "" : p[part], { m: "م", z: "ز", d: "د" }[part], p.useOther ? "disabled" : ""))).join("")}
    </div>
    <label class="addr-other-toggle"><input type="checkbox" data-addr="useOther" ${p.useOther ? "checked" : ""}> <b>تنسيق عنوان آخر</b> <small>(لعنوان لا يُكتب بصيغة م / ز / د)</small></label>
    ${p.useOther ? label("تنسيق عنوان آخر", input("other", p.other, "تنسيق عنوان آخر", 'placeholder="اكتب العنوان كما هو"'), "is-full") : ""}
  </div>`;
}

/**
 * Wires every address field under `root` (once per root): the lists follow each other, the
 * check box switches م / ز / د for the free-text line, and missing places are added.
 * `get(key)` returns the field's parts and cities; `set(key, parts)` keeps the new parts.
 */
export function wireAddress(root, { get, set }) {
  if (state.has(root)) return;
  state.set(root, true);
  const redraw = (box, parts, adding = "") => {
    const { cities } = get(box.dataset.address);
    const fresh = document.createElement("div");
    fresh.innerHTML = addressHtml(box.dataset.address, parts, { cities, adding });
    const next = fresh.firstElementChild;
    box.replaceWith(next);
    return next;
  };
  const update = (box, change, structural) => {
    const key = box.dataset.address;
    const parts = { ...EMPTY_ADDRESS, ...get(key).parts, ...change };
    set(key, parts);
    if (structural) return redraw(box, parts);
    return box;
  };
  root.addEventListener("input", event => {
    const el = event.target.closest?.("[data-addr]");
    const box = el?.closest("[data-address]");
    if (!box || el.tagName === "SELECT" || el.type === "checkbox") return;
    update(box, { [el.dataset.addr]: el.value }, false);
  });
  root.addEventListener("change", event => {
    const el = event.target.closest?.("[data-addr]");
    const box = el?.closest("[data-address]");
    if (!box) return;
    const part = el.dataset.addr;
    if (el.type === "checkbox") {
      // The free-text line replaces م / ز / د: the ones not in use are emptied.
      update(box, el.checked ? { useOther: "1", m: "", z: "", d: "" } : { useOther: "", other: "" }, true);
      return;
    }
    if (el.tagName !== "SELECT") return;
    if (el.value === ADD) {
      const next = redraw(box, get(box.dataset.address).parts, part === "district" ? "district" : "sub");
      next.querySelector("[data-addr-new]")?.focus();
      return;
    }
    const change = part === "gov" ? { gov: el.value, district: "", sub: "" } : part === "district" ? { district: el.value, sub: "" } : { sub: el.value };
    update(box, change, true);
  });
  root.addEventListener("click", async event => {
    const box = event.target.closest?.("[data-address]");
    if (!box) return;
    if (event.target.closest("[data-addr-cancel]")) { redraw(box, get(box.dataset.address).parts); return; }
    if (!event.target.closest("[data-addr-save]")) return;
    const name = text(box.querySelector("[data-addr-new]")?.value);
    if (!name) { box.querySelector("[data-addr-new]")?.focus(); return; }
    const parts = get(box.dataset.address).parts;
    const district = box.dataset.adding === "district";
    try {
      const place = await api.addAddressPlace({ governorate: parts.gov, district: district ? name : parts.district, subdistrict: district ? "" : name });
      added.push(place);
      update(box, district ? { district: place.district, sub: "" } : { sub: place.subdistrict }, true);
      showToast(district ? `أُضيف القضاء «${place.district}» إلى ${place.governorate}` : `أُضيفت الناحية «${place.subdistrict}» إلى ${place.district}`);
    } catch (error) {
      showToast(error?.message ?? String(error || "تعذّرت الإضافة"), "error");
    }
  });
  root.addEventListener("keydown", event => {
    if (event.key === "Enter" && event.target.matches?.("[data-addr-new]")) {
      event.preventDefault();
      event.target.closest("[data-address]")?.querySelector("[data-addr-save]")?.click();
    }
  });
}
