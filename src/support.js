// 💬 Help & support — FAQ answers first, then a chat with TapTayo (no calls; we reply within 24 hours).
// Used on the homepage, the /help page, the owner dashboard and the staff screens.
import { auth, db, call, storage } from "./firebase.js";
import { signInAnonymously } from "firebase/auth";
import { doc, collection, onSnapshot, query, orderBy } from "firebase/firestore";
import { ref, uploadBytes } from "firebase/storage";
import { FAQ, faqSearch } from "./faq.js";
import { resizeImage } from "./upload.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const KEY = "taptayo:support";
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; } };
const save = (o) => { try { localStorage.setItem(KEY, JSON.stringify({ ...load(), ...o })); } catch {} };
let unsubT = null, unsubM = null, thread = null, msgs = [], panel = null, onBadge = null;

function css() {
  if (document.getElementById("tt-sup-css")) return;
  const st = document.createElement("style"); st.id = "tt-sup-css";
  st.textContent = `
  .tt-sup-fab{position:fixed;right:16px;bottom:calc(env(safe-area-inset-bottom,0px) + 16px);z-index:9500;border:3px solid #141414;background:#fff;color:#141414;border-radius:999px;padding:11px 16px;font:800 15px Poppins,system-ui,sans-serif;box-shadow:4px 4px 0 #141414;cursor:pointer;display:flex;gap:6px;align-items:center}
  .tt-sup-fab .dot[hidden]{display:none}.tt-sup-fab .dot{min-width:18px;height:18px;border-radius:9px;background:#dc2626;color:#fff;font-size:11px;display:inline-grid;place-items:center;padding:0 5px}
  .tt-sup{position:fixed;right:16px;bottom:16px;z-index:9600;width:min(400px,calc(100vw - 24px));height:min(640px,calc(100vh - 40px));background:#fff;color:#141414;border:3px solid #141414;border-radius:22px;box-shadow:8px 8px 0 #141414;display:flex;flex-direction:column;font:500 14px/1.45 Poppins,system-ui,sans-serif;overflow:hidden}
  @media (max-width:520px){.tt-sup{right:8px;left:8px;width:auto;bottom:8px;height:calc(100vh - 16px)}}
  .tt-sup header{display:flex;align-items:center;gap:8px;padding:14px 16px;border-bottom:2px solid #eee}.tt-sup header b{flex:1;font-size:16px}
  .tt-sup header button{border:0;background:none;font-size:22px;cursor:pointer;line-height:1}
  .tt-sup .bd{flex:1;overflow:auto;padding:14px 16px}
  .tt-sup input,.tt-sup textarea{width:100%;box-sizing:border-box;border:2px solid #ddd;border-radius:12px;padding:10px 12px;font:inherit;font-size:16px;margin:4px 0 8px}
  .tt-sup .btn{border:2.5px solid #141414;border-radius:999px;background:#141414;color:#fff;font:700 14px Poppins,system-ui,sans-serif;padding:10px 16px;cursor:pointer;width:100%}
  .tt-sup .btn.ghost{background:#fff;color:#141414}
  .tt-sup details{border:2px solid #eee;border-radius:12px;padding:8px 12px;margin:6px 0}.tt-sup summary{font-weight:700;cursor:pointer}
  .tt-sup .muted{color:#6b6461;font-size:12.5px}
  .tt-sup .msg{max-width:85%;padding:9px 12px;border-radius:14px;margin:6px 0;white-space:pre-wrap;word-wrap:break-word}
  .tt-sup .msg.user{margin-left:auto;background:#141414;color:#fff;border-bottom-right-radius:4px}
  .tt-sup .msg.admin{background:#f3eef6;border-bottom-left-radius:4px}.tt-sup .msg.gift{background:#e6f6ec;font-weight:600}
  .tt-sup .msg img{max-width:100%;border-radius:10px;display:block;margin-top:4px}
  .tt-sup .ft{border-top:2px solid #eee;padding:10px 12px;display:flex;gap:6px;align-items:flex-end}.tt-sup .ft textarea{margin:0;flex:1;min-height:44px;max-height:120px}
  .tt-sup .ft label,.tt-sup .ft button{flex:none;border:2px solid #141414;border-radius:12px;background:#fff;padding:9px 11px;cursor:pointer;font:700 14px Poppins,system-ui}
  .tt-sup .ft button.send,.tt-sup .ft .btn{background:#141414;color:#fff;width:100%}.tt-sup .ft .btn.ghost{background:#fff;color:#141414}
  .tt-sup .stars button{border:0;background:none;font-size:26px;cursor:pointer;color:#ccc}.tt-sup .stars button.on{color:#f59e0b}`;
  document.head.appendChild(st);
}

async function ensureAuth() { if (!auth.currentUser) await signInAnonymously(auth); return auth.currentUser; }
function watch(id) {
  unsubT?.(); unsubM?.();
  const lost = () => { save({ threadId: null }); thread = null; msgs = []; unsubT?.(); unsubM?.(); if (view === "chat") view = "faq"; draw(); };
  unsubT = onSnapshot(doc(db, "supportThreads", id), (s) => { thread = s.exists() ? { id, ...s.data() } : null; onBadge?.(thread?.unreadUser || 0); draw(); }, lost);
  unsubM = onSnapshot(query(collection(db, "supportThreads", id, "messages"), orderBy("at")), (s) => { msgs = s.docs.map((d) => ({ id: d.id, ...d.data() })); draw(); }, () => {});
}

/** floating "💬 Help" button (homepage, help page) */
export function mountSupportButton({ label = "💬 Help" } = {}) {
  css();
  const b = document.createElement("button"); b.className = "tt-sup-fab"; b.type = "button"; b.innerHTML = `${label}<span class="dot" hidden></span>`;
  b.onclick = () => openSupport();
  document.body.appendChild(b);
  onBadge = (n) => { const d = b.querySelector(".dot"); d.hidden = !n; d.textContent = n; };
  const tid = load().threadId; if (tid) auth.authStateReady?.().then(() => auth.currentUser && watch(tid));
  return b;
}
/** call from a menu item; onUnread(n) updates your own badge */
export function supportBadge(fn) { onBadge = fn; const tid = load().threadId; if (tid) auth.authStateReady?.().then(() => auth.currentUser && watch(tid)); }

let view = "faq", q = "";
export function openSupport({ start } = {}) {
  css(); panel?.remove();
  panel = document.createElement("div"); panel.className = "tt-sup"; panel.setAttribute("role", "dialog"); panel.setAttribute("aria-label", "Help");
  document.body.appendChild(panel);
  const tid = load().threadId;
  view = start || (tid ? "chat" : "faq");
  if (tid && auth.currentUser) watch(tid);
  draw();
}
const close = () => { panel?.remove(); panel = null; };

function draw() {
  if (!panel) return;
  const S = load();
  if (view === "faq") {
    const hits = q ? faqSearch(q, 6) : FAQ.filter((f) => f[0] === "help" || ["Do my customers need to download an app?", "How do I pay for a plan?", "I'm not getting order or booking alerts."].includes(f[1]));
    panel.innerHTML = `<header><b>💬 Help</b><button data-x aria-label="Close">×</button></header>
      <div class="bd"><div class="muted">What do you need help with?</div><input data-q placeholder="e.g. GCash, printer, Airbnb sync, staff PIN" value="${esc(q)}"/>
      ${hits.length ? hits.map((f) => `<details><summary>${esc(f[1])}</summary><div style="margin-top:6px">${esc(f[2])}</div></details>`).join("") : `<p class="muted">No matching answer — send us a message below.</p>`}
      <p style="margin-top:14px"><a href="/help/" target="_blank" rel="noopener">See all questions →</a></p></div>
      <div class="ft" style="flex-direction:column;align-items:stretch">${S.threadId ? `<button class="btn ghost" data-open>Open my chat${thread?.unreadUser ? ` (${thread.unreadUser} new)` : ""}</button>` : ""}<button class="btn" data-new>Still need help? Message TapTayo</button><div class="muted" style="text-align:center">We reply within 24 hours · no calls needed</div></div>`;
    const qi = panel.querySelector("[data-q]"); qi.oninput = () => { q = qi.value; const pos = qi.selectionStart; draw(); const n = panel.querySelector("[data-q]"); n.focus(); n.setSelectionRange(pos, pos); };
    panel.querySelector("[data-new]").onclick = () => { view = "new"; draw(); };
    panel.querySelector("[data-open]")?.addEventListener("click", async () => { await ensureAuth(); watch(S.threadId); view = "chat"; draw(); });
  } else if (view === "new") {
    const loggedShop = !!S.shop;
    panel.innerHTML = `<header><button data-back aria-label="Back">‹</button><b>Message TapTayo</b><button data-x aria-label="Close">×</button></header>
      <div class="bd">${loggedShop ? "" : `<label>Your name</label><input data-name value="${esc(S.name || "")}" autocomplete="name"/><label>Mobile number or email (so we can reply)</label><input data-contact value="${esc(S.contact || "")}"/>`}
      <label>What happened?</label><textarea data-text rows="5" placeholder="Tell us what you were doing and what you saw. A screenshot helps a lot.">${esc(q)}</textarea>
      <label class="muted">Screenshot (optional)</label><input type="file" accept="image/*" data-photo/>
      <p class="muted">We reply within 24 hours. You'll see our answer here${loggedShop ? " and on your dashboard" : " — keep this page or come back to it on this phone"}.</p><div data-err style="color:#b91c1c"></div></div>
      <div class="ft"><button class="send btn" data-send style="width:100%">Send</button></div>`;
    panel.querySelector("[data-back]").onclick = () => { view = "faq"; draw(); };
    panel.querySelector("[data-send]").onclick = async (e) => {
      const err = panel.querySelector("[data-err]"); err.textContent = ""; e.target.disabled = true;
      try {
        const u = await ensureAuth(); const name = panel.querySelector("[data-name]")?.value.trim() || ""; const contact = panel.querySelector("[data-contact]")?.value.trim() || "";
        save({ name, contact });
        const photo = await upload(u.uid, panel.querySelector("[data-photo]").files?.[0]);
        const r = await call("supportSend", { text: panel.querySelector("[data-text]").value, photo, name, contact, page: location.pathname });
        save({ threadId: r.threadId }); watch(r.threadId); view = "chat"; q = ""; draw();
      } catch (x) { err.textContent = x.message; e.target.disabled = false; }
    };
  } else {
    const closed = thread?.status === "closed";
    panel.innerHTML = `<header><button data-back aria-label="Back">‹</button><b>TapTayo support</b><button data-x aria-label="Close">×</button></header>
      <div class="bd" data-bd>${msgs.map((m) => `<div class="msg ${m.from}${m.gift ? " gift" : ""}">${esc(m.text || "")}${m.photo ? `<img data-sp="${esc(m.photo)}" alt="screenshot"/>` : ""}<div class="muted" style="${m.from === "user" ? "color:#ccc" : ""}">${new Date(m.at).toLocaleString("en-PH", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div></div>`).join("") || `<p class="muted">Loading…</p>`}
      ${thread && thread.lastFrom === "user" && !closed ? `<p class="muted" style="text-align:center">✓ Sent — we'll reply within 24 hours.</p>` : ""}
      ${closed ? `<div style="text-align:center;margin-top:10px"><div class="muted">Chat closed${thread.rating ? ` · you rated ${"★".repeat(thread.rating)}` : " — how did we do?"}</div>${thread.rating ? "" : `<div class="stars">${[1, 2, 3, 4, 5].map((n) => `<button data-star="${n}">★</button>`).join("")}</div>`}</div>` : ""}</div>
      <div class="ft"><label title="Attach a screenshot">📷<input type="file" accept="image/*" data-photo hidden/></label><textarea data-text rows="1" placeholder="${closed ? "Write to start a new chat…" : "Type a message…"}"></textarea><button class="send" data-send>Send</button></div>
      ${!closed && thread ? `<div style="text-align:center;padding:0 0 8px"><button data-done style="border:0;background:none;color:#6b6461;font:600 12px Poppins;cursor:pointer;text-decoration:underline">My problem is solved — close chat</button></div>` : ""}`;
    const bd = panel.querySelector("[data-bd]"); bd.scrollTop = bd.scrollHeight;
    panel.querySelectorAll("[data-sp]").forEach(async (im) => { try { const r = await call("supportFile", { path: im.dataset.sp }); im.src = `data:${r.contentType};base64,${r.base64}`; } catch { im.alt = "(photo)"; } });
    panel.querySelector("[data-back]").onclick = () => { view = "faq"; draw(); };
    panel.querySelector("[data-send]").onclick = async (e) => {
      const t = panel.querySelector("[data-text]"); const f = panel.querySelector("[data-photo]").files?.[0]; if (!t.value.trim() && !f) return;
      e.target.disabled = true;
      try { const u = await ensureAuth(); const photo = await upload(u.uid, f); const r = await call("supportSend", { threadId: load().threadId, text: t.value, photo, name: load().name, contact: load().contact, page: location.pathname }); if (r.threadId !== load().threadId) { save({ threadId: r.threadId }); watch(r.threadId); } t.value = ""; }
      catch (x) { alert(x.message); }
      e.target.disabled = false;
    };
    panel.querySelector("[data-done]")?.addEventListener("click", () => call("supportClose", { threadId: load().threadId }).catch((x) => alert(x.message)));
    panel.querySelectorAll("[data-star]").forEach((b) => (b.onclick = () => call("supportClose", { threadId: load().threadId, rating: Number(b.dataset.star) }).catch(() => {})));
    if (thread?.unreadUser) call("supportSeen", { threadId: thread.id }).catch(() => {});
  }
  panel.querySelector("[data-x]").onclick = close;
}
async function upload(uid, f) {
  if (!f) return "";
  const blob = await resizeImage(f, 1400); const path = `support/${uid}/${Date.now()}.jpg`;
  await uploadBytes(ref(storage, path), blob, { contentType: "image/jpeg" }); return path;
}
/** dashboard / staff apps: remember that this person is a shop (no name/contact needed) */
export function supportAsShop() { save({ shop: true }); }
