// "Feedback & suggestions" → goes to the TapTayo team (admin page). Works in the owner app and every staff app.
import { call } from "./firebase.js";
import { APP_VERSION } from "./version.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const CSS = `.af-wrap{position:fixed;inset:0;z-index:120;font-family:Poppins,system-ui,sans-serif;color:#111}
.af-dim{position:absolute;inset:0;background:rgba(17,17,17,.4)}
.af-box{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(460px,calc(100vw - 24px));max-height:88vh;overflow:auto;background:#fff;border-radius:20px;padding:20px;box-shadow:0 20px 50px rgba(0,0,0,.25)}
.af-box h2{margin:0 0 4px;font-size:1.2rem}.af-box p{margin:0 0 12px;color:#6B7280;font-size:.9rem}
.af-nps{display:grid;grid-template-columns:repeat(11,1fr);gap:4px;margin:6px 0 2px}.af-nps button{height:36px;border:1px solid #E5E7EB;border-radius:8px;background:#fff;font:600 .85rem Poppins,sans-serif;cursor:pointer}
.af-nps button.on{background:#C62828;border-color:#C62828;color:#fff}.af-scale{display:flex;justify-content:space-between;font-size:.72rem;color:#9CA3AF;margin-bottom:12px}
.af-kinds{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}.af-kinds button{height:34px;padding:0 12px;border:1px solid #E5E7EB;border-radius:999px;background:#fff;font:500 .85rem Poppins,sans-serif;cursor:pointer}.af-kinds button.on{background:#111;color:#fff;border-color:#111}
.af-box textarea{width:100%;box-sizing:border-box;min-height:110px;border:1px solid #D1D5DB;border-radius:12px;padding:10px 12px;font:inherit;font-size:.95rem}
.af-btn{width:100%;height:46px;border:0;border-radius:12px;background:#C62828;color:#fff;font:600 1rem Poppins,sans-serif;margin-top:12px;cursor:pointer}.af-btn.s{background:#fff;color:#111;border:1px solid #E5E7EB}
.af-list{margin-top:14px;border-top:1px solid #EEF0F2;padding-top:10px}.af-item{padding:8px 0;border-bottom:1px solid #F3F4F6;font-size:.86rem}.af-item b{font-weight:600}
.af-st{display:inline-block;font-size:.72rem;font-weight:600;border-radius:999px;padding:2px 8px;margin-left:6px}.af-st.new{background:#F3F4F6;color:#374151}.af-st.planned{background:#EAF2FF;color:#1D4ED8}.af-st.done{background:#ECFDF3;color:#15803D}.af-st.wontdo{background:#FEF2F2;color:#B42318}
.af-reply{margin-top:4px;background:#F5F6F8;border-radius:10px;padding:6px 10px;color:#374151}`;
const ST = { new: "Received", planned: "Planned", done: "Done ✓", wontdo: "Not planned" };

export function openAppFeedback({ staffName = "", page = "" } = {}) {
  if (!document.getElementById("afcss")) { const st = document.createElement("style"); st.id = "afcss"; st.textContent = CSS; document.head.appendChild(st); }
  let score = null, kind = "suggestion";
  const el = document.createElement("div"); el.className = "af-wrap";
  el.innerHTML = `<div class="af-dim" data-x></div><div class="af-box" role="dialog" aria-label="Feedback">
    <h2>Help us improve TapTayo</h2><p>Your message goes straight to the TapTayo team. We read every one.</p>
    <b style="font-size:.9rem">How likely are you to recommend TapTayo to another business owner?</b>
    <div class="af-nps">${Array.from({ length: 11 }, (_, i) => `<button type="button" data-s="${i}">${i}</button>`).join("")}</div><div class="af-scale"><span>Not likely</span><span>Very likely</span></div>
    <div class="af-kinds">${[["suggestion", "💡 Suggestion"], ["bug", "🐞 Something's wrong"], ["praise", "❤️ I like…"]].map(([k, l], i) => `<button type="button" data-k="${k}" class="${i === 0 ? "on" : ""}">${l}</button>`).join("")}</div>
    <textarea data-t placeholder="e.g. It would help if the counter could print the kitchen ticket automatically…"></textarea>
    <button class="af-btn" data-send>Send to TapTayo</button><button class="af-btn s" data-x>Close</button>
    <div class="af-list" data-list><span style="color:#9CA3AF;font-size:.85rem">Loading your past feedback…</span></div></div>`;
  document.body.appendChild(el);
  const close = () => el.remove();
  el.querySelectorAll("[data-x]").forEach((b) => (b.onclick = close));
  el.querySelectorAll("[data-s]").forEach((b) => (b.onclick = () => { score = Number(b.dataset.s); el.querySelectorAll("[data-s]").forEach((x) => x.classList.toggle("on", x === b)); }));
  el.querySelectorAll("[data-k]").forEach((b) => (b.onclick = () => { kind = b.dataset.k; el.querySelectorAll("[data-k]").forEach((x) => x.classList.toggle("on", x === b)); }));
  el.querySelector("[data-send]").onclick = async (e) => {
    const text = el.querySelector("[data-t]").value.trim();
    if (!text && score == null) return el.querySelector("[data-t]").focus();
    e.target.disabled = true; e.target.textContent = "Sending…";
    try { await call("sendAppFeedback", { kind: text ? kind : "rating", text, score, staffName, page: page || location.pathname + location.hash, version: APP_VERSION }); e.target.textContent = "Thank you! ✓"; setTimeout(close, 1200); }
    catch (x) { e.target.disabled = false; e.target.textContent = "Send to TapTayo"; alert(x.message); }
  };
  call("myAppFeedback", {}).then((r) => {
    const items = (r.items || []).filter((x) => x.text);
    el.querySelector("[data-list]").innerHTML = items.length ? `<b style="font-size:.85rem">Your feedback</b>${items.slice(0, 10).map((x) => `<div class="af-item">${esc(x.text.slice(0, 160))}<span class="af-st ${esc(x.status)}">${ST[x.status] || x.status}</span>${x.reply ? `<div class="af-reply">💬 TapTayo: ${esc(x.reply)}</div>` : ""}</div>`).join("")}` : "";
  }).catch(() => (el.querySelector("[data-list]").innerHTML = ""));
}
