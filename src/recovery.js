/**
 * recovery.js — «نسيت كلمة المرور؟» on the login screen, and printing the recovery code.
 *
 * Two ways for the base administrator to set a new password:
 *   1. the recovery code («رمز الاستعادة») shown once when the account was made;
 *   2. a developer unlock: the program shows a QR code for this computer and today (text on request),
 *      the developer signs it with tools/admin-unlock and sends back an unlock code.
 * Other users ask an administrator to reset their password.
 */
import QRCode from "qrcode";
import { api } from "./api.js";
import { escHtml, errorText } from "./utils.js";
import { loadPasswordPolicy, mountPasswordRules, passwordProblem, addPasswordToggle } from "./password-rules.js";

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/** Prints a small sheet with the recovery code (nothing else from the screen). */
export function printRecoveryCode(username, code) {
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;left:-10px;top:-10px";
  document.body.append(frame);
  const date = new Date().toLocaleDateString("ar-IQ-u-nu-latn");
  frame.srcdoc = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>رمز الاستعادة</title>
    <style>body{font-family:"Segoe UI",Tahoma,sans-serif;padding:32px;color:#000}h1{font-size:20px;margin:0 0 6px}
    .code{font:700 28px/1.4 Consolas,monospace;letter-spacing:2px;border:2px dashed #000;padding:14px;text-align:center;direction:ltr;margin:18px 0}
    p{font-size:14px;line-height:1.8;margin:4px 0}</style></head><body>
    <h1>CNSArch — رمز استعادة حساب المسؤول</h1>
    <p>الحساب: <bdi dir="ltr">${escHtml(username)}</bdi> · تاريخ الإنشاء: ${escHtml(date)}</p>
    <div class="code">${escHtml(code)}</div>
    <p>إذا نُسيت كلمة مرور المسؤول: في شاشة الدخول اضغط «نسيت كلمة المرور؟» ثم «لدي رمز الاستعادة».</p>
    <p>يعمل الرمز مرة واحدة، ويعطيك البرنامج بعدها رمزًا جديدًا. احفظ هذه الورقة في مكان مقفل.</p>
    </body></html>`;
  frame.addEventListener("load", () => {
    frame.contentWindow.focus();
    frame.contentWindow.print();
    setTimeout(() => frame.remove(), 1000);
  }, { once: true });
}

function dialog(html) {
  const overlay = document.createElement("div");
  overlay.className = "recovery-overlay";
  overlay.setAttribute("dir", "rtl");
  overlay.innerHTML = `<div class="card app-dialog recovery-dialog" role="dialog" aria-modal="true" aria-labelledby="recovery-title">${html}</div>`;
  document.body.append(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener("keydown", event => { if (event.key === "Escape") close(); });
  overlay.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", close));
  return { overlay, box: overlay.firstElementChild, close };
}

const passwordFields = `
  <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
    <div><label class="section-title" for="recovery-new">كلمة المرور الجديدة</label><input id="recovery-new" class="input-field" type="password" dir="ltr" autocomplete="new-password" /></div>
    <div><label class="section-title" for="recovery-confirm">تأكيد كلمة المرور</label><input id="recovery-confirm" class="input-field" type="password" dir="ltr" autocomplete="new-password" /></div>
  </div>
  <div id="recovery-rules"></div>
  <p id="recovery-error" class="text-autohr-red text-sm hidden" role="alert"></p>`;

async function bindPasswordFields(box) {
  const policy = await loadPasswordPolicy({ fresh: true });
  const input = box.querySelector("#recovery-new");
  addPasswordToggle(input);
  addPasswordToggle(box.querySelector("#recovery-confirm"));
  mountPasswordRules(box.querySelector("#recovery-rules"), input, policy);
  return () => {
    const password = input.value;
    return passwordProblem(policy, password) || (password !== box.querySelector("#recovery-confirm").value ? "كلمتا المرور غير متطابقتين" : "");
  };
}

function showError(box, message) {
  const el = box.querySelector("#recovery-error");
  el.textContent = message || "";
  el.classList.toggle("hidden", !message);
}

/**
 * Opens «نسيت كلمة المرور؟». `onDone(username)` runs after the administrator's password was set,
 * so the login screen can fill in the name.
 */
export async function openForgotPassword(onDone) {
  let options = { recovery_code: false, developer_unlock: false };
  try { options = await api.getRecoveryOptions(); } catch { /* older backend: only the advice */ }
  const { box, close } = dialog(`
    <div class="flex items-start justify-between gap-3">
      <p id="recovery-title" class="dialog-title">نسيت كلمة المرور؟</p>
      <button type="button" class="icon-btn" data-close aria-label="إغلاق">✕</button>
    </div>
    <p class="text-sm leading-7"><strong>مستخدم عادي:</strong> اطلب من المسؤول إعادة تعيين كلمة مرورك من «الإعدادات ← المستخدمين والصلاحيات».</p>
    <p class="text-sm leading-7"><strong>المسؤول الأساسي:</strong> ${options.recovery_code || options.developer_unlock
      ? "اختر الطريقة:" : "لم يُنشأ رمز استعادة في هذا البرنامج. تواصل مع الدعم الفني."}</p>
    <div class="flex gap-3 flex-wrap">
      ${options.recovery_code ? `<button type="button" id="recovery-with-code" class="btn-primary">لدي رمز الاستعادة</button>` : ""}
      ${options.developer_unlock ? `<button type="button" id="recovery-with-developer" class="btn-secondary">طلب رمز فتح من المطوّر</button>` : ""}
    </div>
    <div id="recovery-body"></div>`);
  const body = box.querySelector("#recovery-body");

  box.querySelector("#recovery-with-code")?.addEventListener("click", async () => {
    body.innerHTML = `<form id="recovery-form" class="space-y-3 recovery-section" novalidate>
      <div><label class="section-title" for="recovery-code">رمز الاستعادة</label>
        <input id="recovery-code" class="input-field recovery-code-input" dir="ltr" autocomplete="off" spellcheck="false" placeholder="XXXX-XXXX-XXXX-XXXX" /></div>
      ${passwordFields}
      <button type="submit" class="btn-primary px-6">تعيين كلمة المرور</button>
    </form>`;
    const problem = await bindPasswordFields(body);
    body.querySelector("#recovery-code").focus();
    body.querySelector("#recovery-form").addEventListener("submit", async event => {
      event.preventDefault();
      const code = body.querySelector("#recovery-code").value.trim();
      const message = !code ? "اكتب رمز الاستعادة" : problem();
      showError(body, message);
      if (message) return;
      try {
        const result = await api.recoverAdminPassword(code, body.querySelector("#recovery-new").value);
        body.innerHTML = `<div class="space-y-3 recovery-section">
          <p class="setup-note is-ok">تم تعيين كلمة مرور جديدة للحساب <bdi dir="ltr">${escHtml(result.username)}</bdi>.</p>
          <p class="text-sm leading-7">الرمز القديم لم يعد يعمل. هذا رمز الاستعادة الجديد، احفظه بدل القديم. <strong>لن يظهر مرة أخرى.</strong></p>
          <div class="recovery-code-box"><p class="recovery-code" dir="ltr">${escHtml(result.recovery_code)}</p></div>
          <div class="flex gap-3 flex-wrap">
            <button type="button" id="recovery-print" class="btn-secondary">طباعة</button>
            <button type="button" id="recovery-copy" class="btn-secondary">نسخ</button>
          </div>
          <label class="role-card" style="align-items:center"><input type="checkbox" id="recovery-saved" style="margin-top:0" /><span class="role-card-name">حفظت الرمز الجديد في مكان آمن</span></label>
          <button type="button" id="recovery-finish" class="btn-primary px-6" disabled>العودة إلى الدخول</button>
        </div>`;
        box.querySelector(".icon-btn[data-close]")?.remove();
        body.querySelector("#recovery-print").addEventListener("click", () => printRecoveryCode(result.username, result.recovery_code));
        body.querySelector("#recovery-copy").addEventListener("click", () => copyText(result.recovery_code));
        body.querySelector("#recovery-saved").addEventListener("change", e => { body.querySelector("#recovery-finish").disabled = !e.target.checked; });
        body.querySelector("#recovery-finish").addEventListener("click", () => { close(); onDone?.(result.username); });
      } catch (err) {
        showError(body, errorText(err));
      }
    });
  });

  box.querySelector("#recovery-with-developer")?.addEventListener("click", async () => {
    let challenge;
    try { challenge = await api.newUnlockChallenge(); }
    catch (err) { body.innerHTML = `<p class="text-autohr-red text-sm mt-3" role="alert">${escHtml(errorText(err))}</p>`; return; }
    const qr = await QRCode.toString(challenge, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } });
    body.innerHTML = `<form id="unlock-form" class="space-y-3 recovery-section" novalidate>
      <p class="text-sm leading-7">١. صوّر هذا المربع بكاميرا الهاتف وأرسل الصورة إلى المطوّر. يعمل على هذا الجهاز واليوم فقط.</p>
      <div class="unlock-challenge">
        <div class="unlock-qr" role="img" aria-label="رمز الجهاز (QR) لإرساله إلى المطوّر">${qr}</div>
      </div>
      <details class="unlock-text">
        <summary>عرض كنص</summary>
        <div class="flex items-center gap-3 flex-wrap mt-2">
          <p id="unlock-challenge" class="recovery-code is-small" dir="ltr">${escHtml(challenge)}</p>
          <button type="button" id="unlock-copy" class="btn-secondary">نسخ</button>
        </div>
      </details>
      <p class="text-sm leading-7">٢. الصق رمز الفتح الذي وصلك من المطوّر، ثم اكتب كلمة المرور الجديدة.</p>
      <div><label class="section-title" for="unlock-code">رمز الفتح</label>
        <textarea id="unlock-code" class="input-field recovery-code-input" dir="ltr" rows="3" spellcheck="false" placeholder="XXXX-XXXX-…"></textarea></div>
      ${passwordFields}
      <button type="submit" class="btn-primary px-6">فتح الحساب</button>
    </form>`;
    const problem = await bindPasswordFields(body);
    body.querySelector("#unlock-copy").addEventListener("click", () => copyText(challenge));
    body.querySelector("#unlock-form").addEventListener("submit", async event => {
      event.preventDefault();
      const code = body.querySelector("#unlock-code").value.trim();
      const message = !code ? "الصق رمز الفتح الذي وصلك من المطوّر" : problem();
      showError(body, message);
      if (message) return;
      try {
        const username = await api.unlockAdmin(code, body.querySelector("#recovery-new").value);
        close();
        onDone?.(username, "تم فتح حساب المسؤول وتعيين كلمة المرور الجديدة. ادخل بها الآن.");
      } catch (err) {
        showError(body, errorText(err));
      }
    });
  });
}
