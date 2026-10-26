// Explore (/explore/): find services near you — or where you're going (trip mode) — ranked by what you like.
// Shops + short posts from businesses (what's new, portfolio, promos). Location: current (auto), saved home pin, or any place you search.
import "./explore.css";
import { auth, call } from "./firebase.js";
import { onAuthStateChanged } from "firebase/auth";
import { startI18n, langSwitch } from "./i18n.js";
startI18n();

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const peso = (n) => "₱" + Math.round(Number(n) || 0).toLocaleString("en-PH");
const $ = (id) => document.getElementById(id);
const LS = { get: (k, d) => { try { return JSON.parse(localStorage.getItem("taptayo:" + k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem("taptayo:" + k, JSON.stringify(v)); } catch {} } };
const CATS = [
  ["photo", "Photography", "studio/camera.jpg"], ["nails", "Nails", "salon/nail-art.jpg"], ["hair", "Hair", "salon/styling.jpg"], ["spa", "Spa & massage", "spa/hot-stone.jpg"],
  ["makeup", "Makeup", "studio/makeup.jpg"], ["lashes", "Lashes & brows", "salon/hair-care.jpg"], ["stay", "Staycation", "stay/pool-palms.jpg"], ["laundry", "Laundry", "laundry/folded-shirts.jpg"],
  ["coffee", "Coffee", "drink/latte-pour.jpg"], ["food", "Food", "food/sisig.jpg"], ["creator", "Creators", "creator/vlogger.jpg"],
];
const LABEL = Object.fromEntries(CATS.map(([k, l]) => [k, l]));
const ICON = { photo: "📸", nails: "💅", hair: "💇", spa: "💆", makeup: "💄", lashes: "👁", stay: "🏡", laundry: "🧺", coffee: "☕", food: "🍽", creator: "🎥" };

let place = LS.get("place", null);     // { lat, lng, name, mine:true (current location) }
let interests = LS.get("interests", []);
let niche = "", q = "", account = null, saved = new Set(LS.get("saved", []));
{ const u = new URLSearchParams(location.search); const n = u.get("niche"); if (n && CATS.some(([k]) => k === n)) niche = n; const t = (u.get("q") || "").trim().slice(0, 40); if (t) { const hit = CATS.find(([k, l]) => l.toLowerCase().includes(t.toLowerCase()) || k === t.toLowerCase()); if (hit) niche = hit[0]; else q = t; if (t) { const i = document.getElementById("sq"); if (i) i.value = t; } } } // from the homepage search
let here = null;                       // my current location (for "trip mode")

// ---- top bar: account
onAuthStateChanged(auth, async (u) => {
  if (!u || u.isAnonymous) return;
  $("meBtn").textContent = "My TapTayo"; $("meBtn").href = "/me/";
  try { account = await call("myAccount", {}); const P = account.profile || {};
    if (!interests.length && (P.interests || []).length) { interests = P.interests; LS.set("interests", interests); drawChips(); load(); }
    if (!place && Number.isFinite(P.lat)) { setPlace({ lat: P.lat, lng: P.lng, name: "Home", home: true }, false); }
  } catch {}
});

// ---- location
function setPlace(p, reload = true) { place = p; LS.set("place", p); drawPlace(); if (reload) load(); }
// "Where" from the My TapTayo search bar → look the place up once and show what's there
{ const w = (new URLSearchParams(location.search).get("where") || "").trim().slice(0, 60);
  if (w && !/^near me/i.test(w)) fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=ph&accept-language=en&q=${encodeURIComponent(w)}`).then((r) => r.json()).then((L) => { const x = L && L[0]; if (x) setPlace({ name: x.display_name.split(",")[0], full: x.display_name.split(",").slice(1, 3).join(",").trim(), lat: Number(x.lat), lng: Number(x.lon) }); }).catch(() => {}); }
function drawPlace() {
  const trip = place && here && !place.mine && km(place, here) > 25;
  $("placeTxt").textContent = !place ? "Near you" : place.mine ? "Near you" : place.name;
  $("catH").textContent = !place || place.mine || place.home ? "Find services near you" : `Find services in ${place.name}`;
  $("trip").innerHTML = trip ? `<div class="ex-trip">✈️ <div><b>Going to ${esc(place.name)}?</b> These shops serve ${esc(place.name)} — book ahead so it's ready when you arrive.</div><button type="button" data-near>Back to near me</button></div>`
    : !place ? `<div class="ex-trip ask">📍 <div><b>See what's near you</b> — allow location, or pick a place.</div><button type="button" data-locate>Use my location</button></div>` : "";
}
$("trip").onclick = (e) => { if (e.target.closest("[data-locate]")) locate(); if (e.target.closest("[data-near]")) here ? setPlace({ ...here, mine: true, name: "Near you" }) : locate(); };
function locate(quiet) {
  if (!navigator.geolocation) return quiet ? null : openPlace();
  navigator.geolocation.getCurrentPosition((p) => { here = { lat: p.coords.latitude, lng: p.coords.longitude }; LS.set("here", here); if (!place || place.mine) setPlace({ ...here, mine: true, name: "Near you" }); else drawPlace(); },
    () => { if (!quiet) openPlace("Location is blocked — pick a place instead."); }, { timeout: 10000, maximumAge: 300000 });
}
const km = (a, b) => { const R = 6371, dLa = ((b.lat - a.lat) * Math.PI) / 180, dLo = ((b.lng - a.lng) * Math.PI) / 180; const x = Math.sin(dLa / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };

// place picker sheet
function sheet(inner) {
  closeSheet(); const w = document.createElement("div"); w.className = "ex-sheetwrap"; w.innerHTML = `<div class="ex-shade" data-close></div><div class="ex-sheet" role="dialog">${inner}</div>`;
  document.body.appendChild(w); w.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeSheet(); }); return w;
}
function closeSheet() { document.querySelector(".ex-sheetwrap")?.remove(); }
function openPlace(msg = "") {
  const recent = LS.get("recentPlaces", []);
  const w = sheet(`<div class="ex-sh"><b>Where?</b><button class="ex-x" data-close>✕</button></div>${msg ? `<p class="ex-warn">${esc(msg)}</p>` : ""}
    <button class="ex-opt" data-mine>📍 <span><b>Near me</b><small>Use my current location</small></span></button>
    ${Number.isFinite(account?.profile?.lat) ? `<button class="ex-opt" data-home>🏠 <span><b>Home</b><small>${esc(account.profile.address || "My saved address")}</small></span></button>` : ""}
    <form class="ex-search sm" data-pf><span>🔎</span><input data-pq placeholder="Tagaytay, Baguio, SM North, Brgy…" autocomplete="off"/><button>Go</button></form>
    <div data-pres></div>
    ${recent.length ? `<div class="ex-sub">Recent</div>${recent.map((r, i) => `<button class="ex-opt" data-rec="${i}">🕘 <span><b>${esc(r.name)}</b><small>${esc(r.full || "")}</small></span></button>`).join("")}` : ""}
    <div class="ex-sub">Popular trips</div><div class="ex-chips">${[["Tagaytay", 14.1153, 120.9621], ["Baguio", 16.4023, 120.596], ["La Union", 16.6159, 120.3209], ["Boracay", 11.9674, 121.9248], ["Cebu City", 10.3157, 123.8854], ["Siargao", 9.848, 126.0458]].map(([n, la, ln]) => `<button class="ex-chip" data-pop="${n}|${la}|${ln}">${n}</button>`).join("")}</div>
    <p class="ex-note">Planning a trip? Pick where you're going — you'll see shops that serve that area, so you can book ahead.</p>`);
  w.querySelector("[data-mine]").onclick = () => { closeSheet(); here ? setPlace({ ...here, mine: true, name: "Near you" }) : locate(); };
  w.querySelector("[data-home]")?.addEventListener("click", () => { closeSheet(); setPlace({ lat: account.profile.lat, lng: account.profile.lng, name: "Home", home: true }); });
  w.querySelectorAll("[data-rec]").forEach((b) => (b.onclick = () => { closeSheet(); setPlace(recent[Number(b.dataset.rec)]); }));
  w.querySelectorAll("[data-pop]").forEach((b) => (b.onclick = () => { const [n, la, ln] = b.dataset.pop.split("|"); pick({ name: n, lat: Number(la), lng: Number(ln), full: n }); }));
  const pick = (p) => { closeSheet(); LS.set("recentPlaces", [p, ...recent.filter((r) => r.name !== p.name)].slice(0, 5)); setPlace(p); };
  w.querySelector("[data-pf]").onsubmit = async (e) => {
    e.preventDefault(); const t = w.querySelector("[data-pq]").value.trim(); if (t.length < 3) return; const box = w.querySelector("[data-pres]"); box.innerHTML = `<p class="ex-note">Searching…</p>`;
    try { const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&countrycodes=ph&accept-language=en&q=${encodeURIComponent(t)}`); const L = await r.json();
      box.innerHTML = L.length ? L.map((x, i) => `<button class="ex-opt" data-i="${i}">📍 <span><b>${esc(x.display_name.split(",")[0])}</b><small>${esc(x.display_name.split(",").slice(1, 4).join(","))}</small></span></button>`).join("") : `<p class="ex-note">No place found — try a city or landmark.</p>`;
      box.querySelectorAll("[data-i]").forEach((b) => (b.onclick = () => { const x = L[Number(b.dataset.i)]; pick({ name: x.display_name.split(",")[0], full: x.display_name.split(",").slice(1, 3).join(",").trim(), lat: Number(x.lat), lng: Number(x.lon) }); }));
    } catch { box.innerHTML = `<p class="ex-note">Search isn't available right now.</p>`; }
  };
  setTimeout(() => w.querySelector("[data-pq]")?.focus(), 50);
}
$("placeBtn").onclick = () => openPlace();

// ---- categories + interests
function drawCats() {
  $("cats").innerHTML = CATS.map(([k, l, img]) => `<button class="ex-cat ${niche === k ? "on" : ""}" data-cat="${k}"><span class="im" style="background-image:url('/demo/${img}')"></span><span>${l}</span></button>`).join("");
}
$("cats").onclick = (e) => { const b = e.target.closest("[data-cat]"); if (!b) return; niche = niche === b.dataset.cat ? "" : b.dataset.cat; drawCats(); load(); };
function drawChips() {
  $("chips").innerHTML = interests.length ? interests.map((k) => `<span class="ex-chip on">${ICON[k] || ""} ${LABEL[k] || k}</span>`).join("") : `<button class="ex-chip add" data-int>+ Pick what you like — your feed follows it</button>`;
}
$("chips").onclick = (e) => { if (e.target.closest("[data-int]")) openInterests(); };
$("editInt").onclick = () => openInterests();
function openInterests(first) {
  const sel = new Set(interests);
  const w = sheet(`<div class="ex-sh"><b>${first ? "What are you into? 👀" : "My interests"}</b><button class="ex-x" data-close>✕</button></div><p class="ex-note" style="margin-top:0">Pick a few — your feed shows these first. You can change it anytime.</p>
    <div class="ex-intgrid">${CATS.map(([k, l, img]) => `<button class="ex-int ${sel.has(k) ? "on" : ""}" data-k="${k}"><span class="im" style="background-image:url('/demo/${img}')"></span><b>${l}</b></button>`).join("")}</div>
    <button class="ex-go" data-save>Show my feed</button>`);
  w.querySelectorAll("[data-k]").forEach((b) => (b.onclick = () => { const k = b.dataset.k; sel.has(k) ? sel.delete(k) : sel.add(k); b.classList.toggle("on"); }));
  w.querySelector("[data-save]").onclick = async () => { interests = [...sel]; LS.set("interests", interests); closeSheet(); drawChips(); load(); if (account) call("saveProfile", { interests }).catch(() => {}); };
}

// ---- search
$("sf").onsubmit = (e) => { e.preventDefault(); const t = $("sq").value.trim().toLowerCase(); const hit = CATS.find(([k, l]) => l.toLowerCase().includes(t) || k === t); if (hit) { niche = hit[0]; q = ""; } else q = t; drawCats(); load(); };

// ---- feed
const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 60 ? `${Math.max(1, m)}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };
const dist = (s) => (s.distKm == null ? "" : s.distKm < 1 ? `${Math.round(s.distKm * 1000)} m away` : `${s.distKm} km away`);
function title(s) {
  if (s.businessType === "freelance" && s.topService) return `${s.topService.replace(/\s*\([^)]*\)\s*$/, "")} by ${s.by || s.name.split(/[\s·|-]/)[0]}`;
  return s.name;
}
function shopCard(s) {
  const img = s.coverUrl || s.topImage || s.logoUrl || "";
  const sub = [s.businessType === "freelance" ? s.name : s.topService || (s.niches[0] ? LABEL[s.niches[0]] : ""), s.serves ? "🚗 Comes to you" : dist(s)].filter(Boolean).join(" · ");
  const price = s.fromPrice ? `From <b>${peso(s.fromPrice)}</b>${s.businessType === "freelance" ? " / booking" : ""}` : s.mode === "stay" ? "See rooms & prices" : "";
  return `<a class="ex-card" href="/m/${esc(s.slug)}?utm_source=explore">
    <div class="ph" ${img ? `style="background-image:url('${esc(img)}')"` : ""}>${img ? "" : `<span>${ICON[s.niches[0]] || "🏪"}</span>`}${s.tx >= 50 ? `<em>Popular</em>` : s.sample ? `<em>Demo</em>` : ""}<button class="hrt ${saved.has(s.slug) ? "on" : ""}" data-save="${esc(s.slug)}" aria-label="Save">${saved.has(s.slug) ? "♥" : "♡"}</button></div>
    <b class="t">${esc(title(s))}${s.verified ? ` <span class="vf" title="Verified by TapTayo">✓</span>` : ""}</b>
    <span class="s">${esc(sub)}</span><span class="s">${price}${s.rating ? ` · ★ ${s.rating}` : ""}</span></a>`;
}
function postCard(p) {
  return `<article class="ex-post"><a class="hd" href="/m/${esc(p.slug)}?utm_source=explore_post">${p.logoUrl ? `<img src="${esc(p.logoUrl)}" alt=""/>` : `<span class="lg">${ICON[p.niches[0]] || "🏪"}</span>`}<span><b>${esc(p.storeName)}${p.verified ? ` <span class="vf">✓</span>` : ""}</b><small>${{ promo: "🔥 Promo", portfolio: "🖼 Portfolio", new: "✨ New", update: "📣 Update" }[p.kind] || "📣"} · ${ago(p.at)}${p.distKm != null ? ` · ${p.distKm} km` : ""}</small></span></a>
    <p>${esc(p.text)}</p>${p.photos.length ? `<div class="ex-pics n${Math.min(p.photos.length, 4)}">${p.photos.map((u) => `<img src="${esc(u)}" alt="" loading="lazy"/>`).join("")}</div>` : ""}
    <a class="ex-cta" href="/m/${esc(p.slug)}?utm_source=explore_post">See shop & book →</a></article>`;
}
let loading = 0;
async function load() {
  const my = ++loading; $("feed").innerHTML = `<div class="ex-skel"></div><div class="ex-skel"></div><div class="ex-skel"></div>`; $("more").innerHTML = "";
  const at = place || here || LS.get("here", null) || { lat: 14.5995, lng: 120.9842 };
  let r; try { r = await call("exploreFeed", { lat: at.lat, lng: at.lng, interests, niche, q }); } catch (e) { if (my === loading) $("feed").innerHTML = `<p class="ex-note">${esc(e.message || "Couldn't load right now.")}</p>`; return; }
  if (my !== loading) return;
  // mix: a post after every 2 shops
  const out = []; const P = [...r.posts]; r.shops.forEach((s, i) => { out.push(shopCard(s)); if (i % 2 === 1 && P.length) out.push(postCard(P.shift())); }); P.forEach((p) => out.push(postCard(p)));
  const where = !place || place.mine || place.home ? "near you" : `in ${place.name}`;
  $("feed").innerHTML = out.join("") || `<div class="ex-empty"><b>No ${niche ? LABEL[niche].toLowerCase() : "shops"} ${where} on TapTayo yet</b><p>Know a good one? Send them TapTayo — it's free for them to list.</p><button type="button" class="ex-go" data-share>📤 Invite a shop</button></div>`;
  if (r.samples?.length) $("more").innerHTML = `<h2 class="ex-h">Sample shops <span class="ex-tag">demo</span></h2><p class="ex-note" style="margin-top:-6px">See how booking works — these are TapTayo demo shops.</p><div class="ex-feed">${r.samples.map(shopCard).join("")}</div>`;
}
document.addEventListener("click", (e) => {
  const h = e.target.closest("[data-save]"); if (h) { e.preventDefault(); const k = h.dataset.save; saved.has(k) ? saved.delete(k) : saved.add(k); LS.set("saved", [...saved]); h.classList.toggle("on"); h.textContent = saved.has(k) ? "♥" : "♡"; return; }
  if (e.target.closest("[data-share]")) { const t = "List your shop on TapTayo — customers find and book you near them: https://taptayo.com/?utm_source=invite"; if (navigator.share) navigator.share({ text: t }).catch(() => {}); else { navigator.clipboard?.writeText(t); e.target.textContent = "✓ Link copied"; } }
});

// ---- start
here = LS.get("here", null);
const qp = new URLSearchParams(location.search);
if (qp.get("cat") && LABEL[qp.get("cat")]) niche = qp.get("cat");
if (qp.get("in")) { const [n, la, ln] = qp.get("in").split("|"); if (Number.isFinite(Number(la))) place = { name: n, lat: Number(la), lng: Number(ln) }; }
langSwitch({ into: $("langSlot") });
drawCats(); drawChips(); drawPlace();
(async () => { try { const p = await navigator.permissions?.query({ name: "geolocation" }); if (p?.state === "granted") locate(true); } catch {} })();
load();
if (!interests.length && !LS.get("askedInt", false)) { LS.set("askedInt", true); setTimeout(() => openInterests(true), 900); }
