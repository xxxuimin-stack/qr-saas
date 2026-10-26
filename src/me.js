// My TapTayo (/me/) — one account for clients: saved details, all my bookings across shops, find creators, become a creator / add a business.
import { auth, call } from "./firebase.js";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { pinBlock, wirePin, readPin } from "./addrpin.js";
import { startI18n, langSwitch } from "./i18n.js";
startI18n(); langSwitch({ into: document.getElementById("langSlot") });
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
  const N = a.notice; const nameNext = P.nameChangedAt ? P.nameChangedAt + (a.nameDays || 90) * 864e5 : 0;
  ME = { first: P.name ? P.name.split(" ")[0] : "", city: P.city || "" };
  document.getElementById("avBtn").textContent = (P.name || a.email || "?").trim()[0].toUpperCase();
  app.innerHTML = `
    ${N ? `<div class="card" style="border:2px solid ${N.kind === "warning" ? "#F59E0B" : "#B91C1C"};background:${N.kind === "warning" ? "#FFFBEB" : "#FEF2F2"}"><b>${N.kind === "banned" ? "🚫 Your account can't book or order on TapTayo" : N.kind === "suspended" ? `⏸ Booking paused until ${new Date(N.until).toLocaleDateString("en-PH", { month: "short", day: "numeric" })}` : "⚠️ Warning from TapTayo"}</b><p class="muted" style="margin:4px 0 0">A shop's report was confirmed: ${esc(N.reason || "")}. ${N.kind === "warning" ? "2 confirmed reports pause booking for 30 days; 3 close booking on TapTayo." : ""} Think this is a mistake? Message TapTayo support.</p></div>` : ""}
    <nav class="tabs" role="tablist"><button role="tab" data-tab="feed" aria-selected="true">${IC.home}<span>Home</span></button><button role="tab" data-tab="book" aria-selected="false">${IC.cal}<span>Bookings</span></button><button role="tab" data-tab="me" aria-selected="false">${IC.user}<span>Profile</span></button></nav>
    <section data-pane="feed">${wantBanner(a, roles)}<div id="feed"><p class="muted">Loading your feed…</p></div></section>
    <section data-pane="me" hidden class="narrow"><h1 style="margin-top:8px">${esc(P.name || "My profile")}</h1><p class="muted" style="margin:0 0 6px">${esc(a.email || "")}</p>
    <div class="chips">${roles.map((r) => `<span class="chip">${{ client: "🙋 Client", creator: "🎨 Creator", business: "🏪 Business", pro: "🧑‍🎨 Freelancer" }[r] || r}</span>`).join("")}</div>
    <a hidden class="card" href="/explore/" style="display:flex;align-items:center;gap:14px;text-decoration:none;color:inherit;background:linear-gradient(120deg,#FFF7ED,#FDF2F8)"><span style="font-size:34px">🌏</span><span style="flex:1"><b style="font-size:17px">Explore services near you</b><br><span class="muted">Nails, hair, spa, photographers, laundry, staycations — near you or where you're going. Your feed follows what you like.</span></span><b>→</b></a>
    <div class="card"><h2>🔎 Find a creator</h2><p class="muted" style="margin:0 0 8px">Vloggers, UGC creators, photographers and makeup artists.</p><form class="search" id="sf"><input id="sq" placeholder="e.g. food vlogger, makeup, UGC" /><button class="btn">Search</button></form></div>
    </section>
    <section data-pane="book" hidden class="narrow"><div class="card"><div class="row" style="justify-content:space-between"><h2 style="margin:0">📅 My bookings</h2><button class="btn ghost" id="ref">↻</button></div><div id="bk"><p class="muted">Loading…</p></div></div></section>
    <section data-pane="me" hidden class="narrow">
    <div class="card"><h2>👤 My details</h2><p class="muted" style="margin:0">Saved once — every TapTayo booking form is filled for you.</p>
      <div class="grid2"><div><label>Name</label><input id="pn" value="${esc(P.name || "")}" ${nameNext > Date.now() ? "readonly style=\"background:#F3F4F6\"" : ""}/><div class="muted" style="font-size:12px;margin-top:3px">${nameNext > Date.now() ? `You can change your name again on ${new Date(nameNext).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" })}` : P.name ? `Name changes: once every ${a.nameDays || 90} days` : ""}</div></div><div><label>Mobile</label><input id="pp" type="tel" value="${esc(P.phone || "")}" /></div>
      <div><label>Messenger</label><input id="pm" placeholder="m.me/yourname" value="${esc(P.messenger || "")}" /></div><div><label>City</label><input id="pc" value="${esc(P.city || "")}" /></div></div>
      <h3 style="margin:14px 0 4px">📍 My address</h3><p class="muted" style="margin:0 0 8px">Your default for deliveries, pickups and home service. Shops see the pin so they can find you.</p>${pinBlock(P, { who: "riders and stylists", btn: "btn ghost" })}
      <div class="row" style="margin-top:10px"><button class="btn" id="save">Save</button><span class="muted" id="saved"></span></div></div>
    ${(a.blockedShops || []).length ? `<div class="card"><h2>🚫 Shops I blocked</h2>${a.blockedShops.map((b) => `<div class="row" style="justify-content:space-between"><span>${esc(b.name)}</span><button class="btn ghost" data-unblock="${esc(b.storeId)}">Unblock</button></div>`).join("")}</div>` : ""}
    ${addCard(a, roles)}
    </section>
`;
  wirePin(app);
  document.getElementById("sf").onsubmit = (e) => { e.preventDefault(); location.href = `/collab/?q=${encodeURIComponent(document.getElementById("sq").value.trim())}`; };
  document.getElementById("save").onclick = async (e) => { e.target.disabled = true; try { const pin = readPin(app) || {}; await call("saveProfile", { name: v("pn"), phone: v("pp"), messenger: v("pm"), city: v("pc"), address: pin.address || "", landmark: pin.landmark || "", mapUrl: pin.mapUrl || "" }); document.getElementById("saved").textContent = "✓ Saved"; } catch (x) { document.getElementById("saved").textContent = x.message; } e.target.disabled = false; };
  document.querySelectorAll("[data-new]").forEach((b) => (b.onclick = async () => {
    const r = b.dataset.new;
    if (r === "creator" && !a.adult && !confirm("Creators on TapTayo must be 18 or older. Are you 18 or older?")) return;
    b.disabled = true;
    try { await call("accountSetup", { role: r, adult: r === "creator" ? true : undefined }); } catch (x) { b.disabled = false; return alert(x.message); }
    try {
      localStorage.removeItem("taptayo:want");
      if (r === "creator") { localStorage.removeItem("taptayo:edition"); }
      else { localStorage.removeItem("taptayo:edition"); localStorage.removeItem("taptayo:shopName"); }
    } catch {}
    location.href = a.hasStore ? "/app/#overview" : "/app/";
  }));
  document.getElementById("ref").onclick = loadBookings; loadBookings();
  // tabs (remembered on this phone)
  const show = (t) => { document.querySelectorAll("[data-goto]").forEach((b) => b.classList.toggle("on", b.dataset.goto === t)); app.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === t))); app.querySelectorAll("[data-pane]").forEach((x) => (x.hidden = x.dataset.pane !== t)); try { localStorage.setItem("taptayo:meTab", t); } catch {} };
  app.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => show(b.dataset.tab)));
  document.querySelectorAll("[data-goto]").forEach((b) => (b.onclick = (e) => { e.preventDefault(); show(b.dataset.goto); scrollTo(0, 0); }));
  try { const t = localStorage.getItem("taptayo:meTab"); if (t && t !== "feed") show(t); } catch {}
  const ms = document.getElementById("ms"); if (ms) ms.onsubmit = (e) => { e.preventDefault(); const q = document.getElementById("msq").value.trim(), w = document.getElementById("msw").value.trim(); location.href = `/explore/?${new URLSearchParams({ ...(q ? { q } : {}), ...(w ? { where: w } : {}) })}`; };
  if (P.city && document.getElementById("msw")) document.getElementById("msw").placeholder = `Near me · ${P.city}`;
  loadFeed(P);
  document.querySelectorAll("[data-unblock]").forEach((b) => (b.onclick = async () => { b.disabled = true; try { await call("blockShop", { storeId: b.dataset.unblock, unblock: true }); b.closest(".row").remove(); } catch (x) { alert(x.message); b.disabled = false; } }));
});
const v = (id) => document.getElementById(id).value.trim();
async function loadBookings() {
  const box = document.getElementById("bk"); box.innerHTML = `<p class="muted">Loading…</p>`;
  try {
    const L = await call("myBookings", {});
    box.innerHTML = L.map((b) => { const [t, c] = ST(b.status); return `<a class="bk" href="/m/${esc(b.slug)}?my=${b.kind}:${esc(b.id)}">${b.logoUrl ? `<img src="${esc(b.logoUrl)}" alt=""/>` : `<span class="ph">${ICON[b.businessType] || "🏪"}</span>`}<div style="flex:1;min-width:0"><b>${esc(b.storeName)}</b><div class="muted" style="font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${KIND[b.kind] || ""}${b.code ? ` ${esc(b.code)}` : ""}${b.title ? ` · ${esc(b.title)}` : ""}</div><div class="muted" style="font-size:12px">${b.when ? new Date(b.when).toLocaleString("en-PH", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}${b.total ? ` · ${peso(b.total)}` : ""}</div></div><span class="pill ${c}">${esc(t)}</span></a>`; }).join("") || `<p class="muted">No bookings yet. Book any TapTayo shop or creator while logged in and it shows up here.</p>`;
  } catch (e) { box.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

/** "Add an account" — business, creator page, or freelancer for shops. What they signed up for (homepage button) goes first. */
function addCard(a, roles) {
  let want = ""; try { want = localStorage.getItem("taptayo:want") || ""; } catch {}
  const opts = [
    { k: "business", ic: "🏪", t: a.hasStore ? "Your business" : "Business account", d: "One email, one business. Another shop needs another email.", btn: a.hasStore ? `<a class="btn" href="/app/#overview">Open Overview</a>` : `<button class="btn" data-new="business">Set up my business</button>` },
  ];
  return `<div class="card" style="${want ? "border:2px solid #C62828" : ""}"><h2>➕ ${roles.some((r) => r !== "client") || a.hasStore ? "Your accounts" : "What do you want to do on TapTayo?"}</h2>
    ${a.hasStore ? `<div class="row" style="margin-bottom:8px"><a class="btn" href="/app/">Open my dashboard</a></div>` : ""}
    <div style="display:grid;gap:10px">${opts.map((o) => `<div class="row" style="justify-content:space-between;align-items:center;gap:12px;padding:12px;border:1px solid #E5E7EB;border-radius:14px${o.k === want ? ";background:#FEF2F2" : ""}"><div style="display:flex;gap:12px;align-items:center;min-width:0"><span style="font-size:28px">${o.ic}</span><div><b>${o.t}</b><div class="muted" style="font-size:13.5px">${o.d}</div></div></div>${o.btn}</div>`).join("")}</div>
    <p class="muted" style="margin:10px 0 0;font-size:13px">🙋 Just booking? You're all set — use Explore below.</p></div>`;
}

/** came from the homepage to set up a business / creator page → a slim reminder on top of the feed (they can still just book) */
function wantBanner(a, roles) {
  let want = ""; try { want = localStorage.getItem("taptayo:want") || ""; } catch {}
  if (!want || a.hasStore || roles.includes(want)) return "";
  return `<div class="card" style="display:flex;gap:12px;align-items:center;justify-content:space-between;border-color:#F4A9A9;background:#FEF2F2"><span>🏪 Ready to set up your business?</span><span class="row"><button class="btn" data-new="business">Set up now</button><button class="btn ghost" onclick="try{localStorage.removeItem('taptayo:want')}catch(e){};this.closest('.card').remove()">Later</button></span></div>`;
}

// ---- 📰 home feed (marketplace style): categories · popular near you · updates from shops
let ME = { first: "", city: "" };
const sv = (d) => `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const IC = {
  all: sv('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 3v4M17 5h4"/>'),
  nails: sv('<path d="M9.5 3h5v5.5a2.5 2.5 0 0 1-5 0z"/><path d="M10.5 11v9a1.5 1.5 0 0 0 3 0v-9"/>'),
  hair: sv('<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>'),
  spa: sv('<path d="M12 21c-4.5 0-8-3-8-7 2.5 0 5.5 1.2 8 4 2.5-2.8 5.5-4 8-4 0 4-3.5 7-8 7z"/><path d="M12 18c-1.8-2.2-2.5-4.4-2.5-6.5S10.6 6.7 12 4c1.4 2.7 2.5 5.3 2.5 7.5S13.8 15.8 12 18z"/>'),
  lashes: sv('<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/><path d="M5 7 3.6 5.2M9 5.3 8.5 3.2M15 5.3l.5-2.1M19 7l1.4-1.8"/>'),
  makeup: sv('<path d="M9 21h6M10 21V10h4v11"/><path d="M10 10V6.5L13.5 3H14v7"/>'),
  laundry: sv('<rect x="4" y="2.5" width="16" height="19" rx="2.5"/><path d="M4 7h16"/><circle cx="12" cy="14" r="4.2"/><path d="M7.5 4.8h.01M10 4.8h.01"/>'),
  stay: sv('<path d="M3 20v-7.5a1.5 1.5 0 0 1 1.5-1.5h15a1.5 1.5 0 0 1 1.5 1.5V20"/><path d="M5 11V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v4"/><path d="M3 17h18M9 11V9.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V11"/>'),
  food: sv('<path d="M4 3v7a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2V3M7 3v18"/><path d="M20 15V3c-2.5 0-4 2.2-4 5v5a2 2 0 0 0 2 2h2zm0 0v6"/>'),
  coffee: sv('<path d="M17 9h1.5a3 3 0 0 1 0 6H17"/><path d="M4 9h13v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M8 2.5v3M12 2.5v3"/>'),
  photo: sv('<path d="M14.5 4h-5L7.5 7H4.5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h15a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3.5"/>'),
  creator: sv('<rect x="2.5" y="6" width="13" height="12" rx="2.5"/><path d="m15.5 10.5 6-3.5v10l-6-3.5"/>'),
  home: sv('<path d="M3 11 12 4l9 7v8.5a1.5 1.5 0 0 1-1.5 1.5H15v-6H9v6H4.5A1.5 1.5 0 0 1 3 19.5z"/>'),
  cal: sv('<rect x="3" y="4.5" width="18" height="16.5" rx="2.5"/><path d="M3 9.5h18M8 2.5v4M16 2.5v4"/>'),
  user: sv('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>'),
  heart: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 20.5 4.2 13A5 5 0 0 1 12 6.6 5 5 0 0 1 19.8 13z" fill="rgba(0,0,0,.35)" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  pin: sv('<path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>'),
};
const NICON = Object.fromEntries(Object.keys(IC).map((k) => [k, IC[k]]));
const ORDER = ["nails", "hair", "spa", "lashes", "makeup", "laundry", "stay", "food", "coffee", "photo", "creator"];
let feedNiche = "";
const saved = new Set((() => { try { return JSON.parse(localStorage.getItem("taptayo:saved")) || []; } catch { return []; } })());
async function loadFeed(P) {
  const box = document.getElementById("feed"); if (!box) return;
  const place = (() => { try { return JSON.parse(localStorage.getItem("taptayo:place")) || null; } catch { return null; } })();
  const at = Number.isFinite(P.lat) ? { lat: P.lat, lng: P.lng, name: P.city || "you" } : place && Number.isFinite(place.lat) ? place : null;
  let r; try { r = await call("exploreFeed", { lat: at?.lat, lng: at?.lng, interests: P.interests || [], niche: feedNiche }); } catch (e) { box.innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
  const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 60 ? `${Math.max(1, m)}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };
  const labels = r.niches || {};
  const cats = [["", "For you"], ...ORDER.filter((k) => labels[k]).map((k) => [k, labels[k]])];
  const card = (x) => { const img = x.coverUrl || x.topImage || x.logoUrl || "";
    return `<a class="mc" href="/m/${esc(x.slug)}?utm_source=home"><span class="im" ${img ? `style="background-image:url('${esc(img)}')"` : ""}>${img ? "" : `<i>${IC[x.niches?.[0]] || IC.all}</i>`}${x.rating ? `<em>★ ${x.rating}</em>` : x.sample ? "<em>Demo</em>" : x.verified ? "<em>✓ Verified</em>" : ""}<button type="button" class="hrt ${saved.has(x.slug) ? "on" : ""}" data-save="${esc(x.slug)}" aria-label="Save">${IC.heart}</button></span>
      <span class="row1"><b>${esc(x.name)}${x.verified ? ' <span class="vf">✓</span>' : ""}</b>${x.rating ? `<small>★ ${x.rating}</small>` : ""}</span><small>${esc([x.topService, x.serves ? "Comes to you" : x.distKm != null ? `${x.distKm} km` : x.city].filter(Boolean).join(" · "))}</small>${x.fromPrice ? `<small><b style="color:#111">₱${Number(x.fromPrice).toLocaleString("en-PH")}</b> starting</small>` : ""}</a>`; };
  const post = (p) => `<article class="card fp"><a class="hd" href="/m/${esc(p.slug)}?utm_source=home_post">${p.logoUrl ? `<img src="${esc(p.logoUrl)}" alt=""/>` : `<span class="lg">${IC[p.niches?.[0]] || IC.all}</span>`}<span><b>${esc(p.storeName)}${p.verified ? ' <span class="vf">✓</span>' : ""}</b><small>${{ promo: "Promo", portfolio: "New work", update: "Update", event: "Event" }[p.kind] || "Update"} · ${ago(p.at)}${p.distKm != null ? ` · ${p.distKm} km` : ""}</small></span></a>
    ${p.text ? `<p>${esc(p.text)}</p>` : ""}${p.photos?.length ? `<div class="pics n${Math.min(p.photos.length, 4)}">${p.photos.slice(0, 4).map((u) => `<img src="${esc(u)}" alt="" loading="lazy"/>`).join("")}</div>` : ""}
    <div class="row" style="margin-top:12px"><a class="btn" href="/m/${esc(p.slug)}?utm_source=home_post">Book now</a><button type="button" class="btn ghost" data-save="${esc(p.slug)}">♡ Save</button></div></article>`;
  const shops = [...(r.shops || []), ...(r.samples || [])];
  const where = at ? `near ${esc(at.name || "you")}` : "on TapTayo";
  box.innerHTML = `<nav class="cats" aria-label="Categories">${cats.map(([k, l]) => `<button type="button" class="cat ${feedNiche === k ? "on" : ""}" data-niche="${k}">${k ? IC[k] || IC.all : IC.all}<span>${esc(k ? l : "For you")}</span></button>`).join("")}</nav>
    <div class="feedin">${at ? "" : `<div class="card nudge"><span>${IC.pin}<span>Add your address to see what's near you.</span></span><a class="btn ghost" href="#" data-goto2="me">Add address</a></div>`}
    <h2 class="fh">${ME.first ? `Hi ${esc(ME.first)} — ` : ""}popular ${where}</h2><p class="muted" style="margin:0 0 18px">Book in a few taps · no app</p>
    ${shops.length ? `<div class="grid">${shops.slice(0, 12).map(card).join("")}</div>` : `<div class="card" style="text-align:center"><p class="muted" style="margin:0">No shops here yet for this category.</p></div>`}
    <div class="row" style="justify-content:center;margin:22px 0 6px"><a class="btn ghost" href="/explore/">See more in Explore</a></div>
    <h2 class="fh" style="margin-top:34px">Updates from shops ${where}</h2>
    ${(r.posts || []).length ? `<div class="posts">${r.posts.map(post).join("")}</div>` : `<div class="card" style="text-align:center"><p class="muted" style="margin:0">No posts yet — when shops share promos, new work or updates, they show up here.</p></div>`}</div>`;
  box.querySelectorAll("[data-niche]").forEach((b) => (b.onclick = () => { feedNiche = b.dataset.niche; box.style.opacity = ".6"; loadFeed(P).then(() => (box.style.opacity = "")); }));
  box.querySelectorAll("[data-goto2]").forEach((b) => (b.onclick = (e) => { e.preventDefault(); document.querySelector('[data-tab="me"]')?.click(); }));
  box.querySelectorAll("[data-save]").forEach((b) => (b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); const k = b.dataset.save; saved.has(k) ? saved.delete(k) : saved.add(k); try { localStorage.setItem("taptayo:saved", JSON.stringify([...saved])); } catch {} box.querySelectorAll(`[data-save="${CSS.escape(k)}"]`).forEach((x) => { x.classList.toggle("on", saved.has(k)); if (!x.classList.contains("hrt")) x.textContent = saved.has(k) ? "♥ Saved" : "♡ Save"; }); }));
}
