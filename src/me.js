// My TapTayo (/me/) — one account for clients: saved details, all my bookings across shops, find creators, become a creator / add a business.
import { auth, call } from "./firebase.js";
import { onAuthStateChanged, signOut } from "firebase/auth";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const peso = (n) => "₱" + Math.round(Number(n) || 0).toLocaleString("en-PH");
const app = document.getElementById("app");
const ICON = { cafe: "☕", salon: "💇", spa: "💆", laundry: "🧺", stay: "🏡", freelance: "🎨" };
const KIND = { appt: "Booking", order: "Order", stay: "Stay", resv: "Reservation", inq: "Project" };
const ST = (s) => ({ pending: ["Waiting", "wait"], unconfirmed: ["Confirm on Messenger", "wait"], confirmed: ["Confirmed", "ok"], accepted: ["Confirmed", "ok"], in_progress: ["In progress", "ok"], preparing: ["Preparing", "ok"], ready: ["Ready", "ok"], checked_in: ["Checked in", "ok"], done: ["Done", "off"], completed: ["Done", "off"], checked_out: ["Done", "off"], claimed: ["Done", "off"], cancelled: ["Cancelled", "off"], declined: ["Declined", "off"], no_show: ["No-show", "off"], new: ["Sent", "wait"], negotiating: ["Negotiating", "wait"], quoted: ["Quote ready", "wait"], delivered: ["Delivered", "ok"] }[s] || [s || "", ""]);

onAuthStateChanged(auth, async (u) => {
  if (!u || u.isAnonymous) { location.replace("/login/?next=/me/&signup=1&role=client"); return; }
  document.getElementById("out").hidden = false; document.getElementById("out").onclick = async () => { await signOut(auth); location.replace("/"); };
  let a = {}; try { a = await call("myAccount", {}); } catch (e) { app.innerHTML = `<p>${esc(e.message)}</p>`; return; }
  const P = a.profile || {}; const roles = a.roles || [];
  app.innerHTML = `<h1>Hi${P.name ? `, ${esc(P.name.split(" ")[0])}` : ""}! 👋</h1><p class="muted">${esc(a.email || "")}</p>
    <div class="chips">${roles.map((r) => `<span class="chip">${{ client: "🙋 Client", creator: "🎨 Creator", business: "🏪 Business" }[r] || r}</span>`).join("")}</div>
    <div class="card"><h2>🔎 Find a creator</h2><p class="muted" style="margin:0 0 8px">Vloggers, UGC creators, photographers and makeup artists.</p><form class="search" id="sf"><input id="sq" placeholder="e.g. food vlogger, makeup, UGC" /><button class="btn">Search</button></form></div>
    <div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">📅 My bookings</h2><button class="btn ghost" id="ref">↻</button></div><div id="bk"><p class="muted">Loading…</p></div></div>
    <div class="card"><h2>👤 My details</h2><p class="muted" style="margin:0">Saved once — every TapTayo booking form is filled for you.</p>
      <div class="grid2"><div><label>Name</label><input id="pn" value="${esc(P.name || "")}" /></div><div><label>Mobile</label><input id="pp" type="tel" value="${esc(P.phone || "")}" /></div>
      <div><label>Messenger</label><input id="pm" placeholder="m.me/yourname" value="${esc(P.messenger || "")}" /></div><div><label>City</label><input id="pc" value="${esc(P.city || "")}" /></div></div>
      <label>Address (for delivery / home service)</label><input id="pa" value="${esc(P.address || "")}" />
      <div class="row" style="margin-top:10px"><button class="btn" id="save">Save</button><span class="muted" id="saved"></span></div></div>
    <div class="card"><h2>➕ More with your account</h2><div class="row">
      ${a.hasStore ? `<a class="btn" href="/app/">Open my dashboard</a>` : ""}
      ${roles.includes("creator") ? "" : `<button class="btn ghost" data-new="creator">🎨 Become a creator — earn even with few followers</button>`}
      ${roles.includes("business") ? "" : `<button class="btn ghost" data-new="business">🏪 Add my business</button>`}
    </div></div>`;
  document.getElementById("sf").onsubmit = (e) => { e.preventDefault(); location.href = `/collab/?q=${encodeURIComponent(document.getElementById("sq").value.trim())}`; };
  document.getElementById("save").onclick = async (e) => { e.target.disabled = true; try { await call("saveProfile", { name: v("pn"), phone: v("pp"), messenger: v("pm"), city: v("pc"), address: v("pa") }); document.getElementById("saved").textContent = "✓ Saved"; } catch (x) { document.getElementById("saved").textContent = x.message; } e.target.disabled = false; };
  document.querySelectorAll("[data-new]").forEach((b) => (b.onclick = async () => {
    const r = b.dataset.new;
    if (r === "creator" && !a.adult && !confirm("Creators on TapTayo must be 18 or older. Are you 18 or older?")) return;
    try { await call("accountSetup", { role: r, adult: r === "creator" ? true : undefined }); } catch (x) { return alert(x.message); }
    try { localStorage.setItem("taptayo:edition", r === "creator" ? "freelance" : ""); if (P.name) localStorage.setItem("taptayo:shopName", P.name); } catch {}
    location.href = "/app/";
  }));
  document.getElementById("ref").onclick = loadBookings; loadBookings();
});
const v = (id) => document.getElementById(id).value.trim();
async function loadBookings() {
  const box = document.getElementById("bk"); box.innerHTML = `<p class="muted">Loading…</p>`;
  try {
    const L = await call("myBookings", {});
    box.innerHTML = L.map((b) => { const [t, c] = ST(b.status); return `<a class="bk" href="/m/${esc(b.slug)}?my=${b.kind}:${esc(b.id)}">${b.logoUrl ? `<img src="${esc(b.logoUrl)}" alt=""/>` : `<span class="ph">${ICON[b.businessType] || "🏪"}</span>`}<div style="flex:1;min-width:0"><b>${esc(b.storeName)}</b><div class="muted" style="font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${KIND[b.kind] || ""}${b.code ? ` ${esc(b.code)}` : ""}${b.title ? ` · ${esc(b.title)}` : ""}</div><div class="muted" style="font-size:12px">${b.when ? new Date(b.when).toLocaleString("en-PH", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}${b.total ? ` · ${peso(b.total)}` : ""}</div></div><span class="pill ${c}">${esc(t)}</span></a>`; }).join("") || `<p class="muted">No bookings yet. Book any TapTayo shop or creator while logged in and it shows up here.</p>`;
  } catch (e) { box.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}
