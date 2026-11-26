/**
 * password-rules.js — The account password rules («سياسة كلمة المرور»), shown live under every
 * new-password field (first-run wizard, password change, add user, reset password, recovery).
 *
 * The rules come from Rust (`cmd_get_password_policy`, set in «الإعدادات ← المستخدمين والصلاحيات»).
 * The checks below mirror `account::check_against` in Rust, which has the final word.
 */
import { api } from "./api.js";
import { escHtml } from "./utils.js";

export const DEFAULT_POLICY = {
  min_length: 9, require_upper: true, require_lower: true, require_digit: true, require_symbol: false,
  reject_common: false, max_failures: 5, lockout_minutes: 5,
};

let cached = null;
export async function loadPasswordPolicy({ fresh = false } = {}) {
  if (cached && !fresh) return cached;
  try { cached = { ...DEFAULT_POLICY, ...(await api.getPasswordPolicy()) }; }
  catch { cached = { ...DEFAULT_POLICY }; }
  return cached;
}
export function forgetPasswordPolicy() { cached = null; }

/** «9 أحرف» / «12 حرفًا». */
export function lettersCount(count) {
  return count >= 3 && count <= 10 ? `${count} أحرف` : `${count} حرفًا`;
}

// Same list as account.rs (COMMON): compared without case and without digits/symbols at the ends.
const COMMON = new Set([
  "password", "passw0rd", "p@ssword", "p@ssw0rd", "admin", "administrator", "sysadmin", "root", "user", "guest",
  "welcome", "letmein", "login", "master", "secret", "changeme", "default", "test", "qwerty", "qwertyuiop",
  "asdfgh", "asdfghjkl", "zxcvbn", "zxcvbnm", "azerty", "iloveyou", "dragon", "monkey", "football", "baseball",
  "sunshine", "princess", "shadow", "superman", "michael", "freedom", "whatever", "trustno1", "abc", "abcd",
  "abcdef", "abcdefg", "abcdefgh", "abcdefghi", "aaaaaa", "cnsarch", "autohr", "gcaan", "gcans", "iraq",
  "baghdad", "company", "archive", "airport", "computer", "internet", "windows", "microsoft", "google", "samsung",
  "123456", "1234567", "12345678", "123456789", "1234567890", "987654321", "111111", "000000", "121212", "123123",
  "qazwsx", "1qaz2wsx", "1q2w3e4r", "1q2w3e", "q1w2e3r4", "zaq12wsx", "hello", "summer", "winter", "spring",
]);
const isEdge = c => /[0-9]/.test(c) || !/[\p{L}\p{N}]/u.test(c);

export function isCommonPassword(password) {
  const lower = password.toLowerCase();
  const chars = [...lower];
  let end = chars.length; while (end > 0 && isEdge(chars[end - 1])) end--;
  let start = 0; while (start < end && isEdge(chars[start])) start++;
  const core = chars.slice(start, end).join("");
  if (COMMON.has(lower) || (core && COMMON.has(core))) return true;
  if (new Set(chars).size <= 2) return true;
  const steps = step => chars.slice(1).filter((c, i) => c.codePointAt(0) - chars[i].codePointAt(0) === step).length;
  return Math.max(steps(1), steps(-1)) + 2 >= chars.length;
}

/** Each rule with whether `password` meets it. `password` may be empty (nothing met yet). */
export function passwordChecks(policy, password, username = "") {
  const name = String(username || "").trim().toLowerCase();
  const checks = [
    { key: "length", label: `${lettersCount(policy.min_length)} على الأقل`, ok: [...password].length >= policy.min_length },
  ];
  if (policy.require_upper) checks.push({ key: "upper", label: "حرف إنجليزي كبير (A-Z)", ok: /[A-Z]/.test(password) });
  if (policy.require_lower) checks.push({ key: "lower", label: "حرف إنجليزي صغير (a-z)", ok: /[a-z]/.test(password) });
  if (policy.require_digit) checks.push({ key: "digit", label: "رقم (0-9)", ok: /[0-9]/.test(password) });
  if (policy.require_symbol) checks.push({ key: "symbol", label: "رمز مثل ! @ # $", ok: /[^\p{L}\p{N}\s]/u.test(password) });
  if (name.length >= 3) checks.push({ key: "name", label: "لا تحتوي على اسم المستخدم", ok: Boolean(password) && !password.toLowerCase().includes(name) });
  if (policy.reject_common) checks.push({ key: "common", label: "ليست سهلة التخمين (مثل 12345678 أو Password1)", ok: Boolean(password) && !isCommonPassword(password) });
  return checks;
}

/** The first unmet rule as an error sentence, or "" when the password is acceptable. */
export function passwordProblem(policy, password, username = "") {
  if ([...password].length > 0 && new TextEncoder().encode(password).length > 72) return "كلمة المرور طويلة جدًا (الحد 72 حرفًا إنجليزيًا أو 36 حرفًا عربيًا)";
  const missing = passwordChecks(policy, password, username).find(check => !check.ok);
  if (!missing) return "";
  if (missing.key === "common") return "كلمة المرور سهلة التخمين، اختر غيرها";
  if (missing.key === "name") return "كلمة المرور يجب ألا تحتوي على اسم المستخدم";
  if (missing.key === "length") return `كلمة المرور يجب أن تكون ${lettersCount(policy.min_length)} على الأقل`;
  return `كلمة المرور يجب أن تحتوي على ${missing.label}`;
}

/**
 * A live checklist under `input`: each rule turns green with ✓ as it is met.
 * `getUsername` returns the account name the password is for (to refuse it inside the password).
 */
export function mountPasswordRules(holder, input, policy, getUsername = () => "") {
  holder.classList.add("password-rules");
  holder.setAttribute("aria-live", "polite");
  const render = () => {
    holder.innerHTML = `<p class="password-rules-title">كلمة المرور يجب أن تحتوي على:</p><ul>${passwordChecks(policy, input.value, getUsername())
      .map(check => `<li class="${check.ok ? "is-met" : ""}" data-rule="${check.key}"><span aria-hidden="true">${check.ok ? "✓" : "○"}</span> ${escHtml(check.label)}</li>`).join("")}</ul>`;
  };
  input.addEventListener("input", render);
  render();
  return render;
}

/** A small «إظهار» eye button for a password input (placed inside a relative wrapper). */
export function addPasswordToggle(input) {
  const wrap = document.createElement("div");
  wrap.className = "password-field";
  input.parentNode.insertBefore(wrap, input);
  wrap.append(input);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "password-eye";
  button.setAttribute("aria-label", "إظهار كلمة المرور");
  button.setAttribute("aria-pressed", "false");
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
  button.addEventListener("click", () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    button.setAttribute("aria-pressed", String(show));
    button.setAttribute("aria-label", show ? "إخفاء كلمة المرور" : "إظهار كلمة المرور");
    input.focus();
  });
  wrap.append(button);
  return button;
}

/** Shows «Caps Lock مفعّل» in `note` while typing in any of `inputs` with Caps Lock on. */
export function watchCapsLock(inputs, note) {
  const sync = event => {
    if (typeof event.getModifierState !== "function") return;
    note.classList.toggle("hidden", !event.getModifierState("CapsLock"));
  };
  inputs.forEach(input => { input.addEventListener("keydown", sync); input.addEventListener("keyup", sync); });
}
