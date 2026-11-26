/**
 * whats-new.js — «ما الجديد»: what changed in each version.
 *
 * Where the notes come from, in order:
 *   1. The description of the GitHub release v<version> in CNSArch-releases (written on
 *      GitHub, can be edited at any time without a new build).
 *   2. whats-new.json, bundled with the app (used when offline or when the release has no text).
 * After an update the window opens once, on the first sign-in with the new version; it can be
 * opened again from «حول النظام». A brand-new installation does not show it (setup marks it seen).
 */
import notes from "./whats-new.json";
import { api } from "./api.js";
import { escHtml } from "./utils.js";
import { APP_VERSION } from "./version.js";

const SEEN_KEY = "cnsarch.whatsNewSeen";

function bundledItems(version) {
  const entry = (Array.isArray(notes?.versions) ? notes.versions : []).find(v => v?.version === version);
  return Array.isArray(entry?.items) ? entry.items.map(String) : [];
}

/** Records that this version's notes need not be shown (fresh install, or already shown). */
export function markWhatsNewSeen(version = APP_VERSION) {
  try { localStorage.setItem(SEEN_KEY, version); } catch { /* storage unavailable */ }
}

function seenVersion() {
  try { return localStorage.getItem(SEEN_KEY); } catch { return APP_VERSION; }
}

/**
 * Turns the release text into safe HTML: lines starting with "-", "*" or "•" become a list,
 * "#" lines become headings, other lines paragraphs. Everything is escaped (no HTML from GitHub).
 */
export function notesToHtml(text) {
  const out = [];
  let list = [];
  const flush = () => { if (list.length) { out.push(`<ul>${list.map(i => `<li>${escHtml(i)}</li>`).join("")}</ul>`); list = []; } };
  for (const raw of String(text ?? "").replace(/\r/g, "").split("\n")) {
    const line = raw.trim().replace(/\*\*(.+?)\*\*/g, "$1");
    const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (bullet) { list.push(bullet[1]); continue; }
    flush();
    if (!line) continue;
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    out.push(heading ? `<p class="whats-new-heading">${escHtml(heading[1])}</p>` : `<p>${escHtml(line)}</p>`);
  }
  flush();
  return out.join("");
}

async function loadNotes(version) {
  try {
    const text = await api.getReleaseNotes(version);
    if (text && text.trim()) return notesToHtml(text);
  } catch { /* offline: use the bundled notes */ }
  const items = bundledItems(version);
  return items.length ? notesToHtml(items.map(i => `- ${i}`).join("\n")) : "";
}

/** Shows the notes once after an update. Resolves when the window is closed (or not shown). */
export async function showWhatsNewIfUpdated() {
  if (seenVersion() === APP_VERSION) return;
  markWhatsNewSeen();
  const html = await loadNotes(APP_VERSION);
  if (html) await openWhatsNewWindow(html);
}

/** Opens «ما الجديد» for the current version (from «حول النظام»). */
export async function openWhatsNew() {
  const html = await loadNotes(APP_VERSION);
  return openWhatsNewWindow(html || `<p>لا توجد ملاحظات لهذا الإصدار.</p>`);
}

function openWhatsNewWindow(html) {
  document.getElementById("whats-new-overlay")?.remove();
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.id = "whats-new-overlay";
    overlay.className = "whats-new-overlay";
    overlay.setAttribute("dir", "rtl");
    overlay.innerHTML = `
      <div class="whats-new-box" role="dialog" aria-modal="true" aria-labelledby="whats-new-title">
        <h2 id="whats-new-title" class="whats-new-title">ما الجديد في الإصدار <span dir="ltr">${escHtml(APP_VERSION)}</span></h2>
        <div class="whats-new-body">${html}</div>
        <div class="whats-new-actions"><button type="button" class="btn-primary" id="whats-new-ok">حسنًا</button></div>
      </div>`;
    const close = () => { overlay.remove(); document.removeEventListener("keydown", onKey); resolve(); };
    const onKey = event => { if (event.key === "Escape") close(); };
    overlay.querySelector("#whats-new-ok").addEventListener("click", close);
    overlay.addEventListener("click", event => { if (event.target === overlay) close(); });
    document.addEventListener("keydown", onKey);
    document.body.append(overlay);
    overlay.querySelector("#whats-new-ok").focus();
  });
}
