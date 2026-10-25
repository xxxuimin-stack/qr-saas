// TapTayo Collab (/collab/) — public creator marketplace: search without an account, niche tiles, ranked creator cards,
// open collab board, videos and demos. Booking / offers happen on the creator's page with a TapTayo login.
import { call, auth } from "./firebase.js";
import { onAuthStateChanged } from "firebase/auth";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const peso = (n) => "₱" + Math.round(Number(n) || 0).toLocaleString("en-PH");
const kfmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : n >= 1e3 ? (n / 1e3).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, "") + "K" : String(Math.round(n || 0)));
const $ = (id) => document.getElementById(id);
const NICHES = [
  ["Food", "/demo/food/sisig.jpg", "Cafés, restos, food vlogs"], ["UGC", "/demo/ugc/floor-film.jpg", "Videos for your page & ads"], ["Beauty", "/demo/salon/styling.jpg", "Salons, skincare, makeup"],
  ["Photography", "/demo/studio/shooting.jpg", "Product & event shoots"], ["Events", "/demo/studio/event.jpg", "Coverage, hosts, SDE"], ["Lifestyle", "/demo/cafe/bulbs.jpg", "Daily vlogs, local finds"],
  ["Travel", "/demo/stay/pool-tropical.jpg", "Stays, resorts, Airbnbs"], ["Family", "/demo/food/boodle-fight.jpg", "Kid-friendly places"],
];
const KNOWN = NICHES.map((n) => n[0].toLowerCase());
let niche = "", items = [];

// hero chips + niche tiles
$("chips").innerHTML = ["All", ...NICHES.map((n) => n[0])].map((n) => `<button type="button" data-n="${n === "All" ? "" : n}">${n}</button>`).join("");
$("tiles").innerHTML = NICHES.map(([n, img, sub]) => `<button type="button" class="tile" data-n="${n}"><img src="${img}" alt="" loading="lazy"/><span>${n}<small>${sub}</small></span></button>`).join("");
document.querySelectorAll("[data-n]").forEach((b) => (b.onclick = () => { niche = b.dataset.n; $("q").value = ""; drawChips(); search(true); }));
const drawChips = () => document.querySelectorAll("#chips [data-n]").forEach((b) => b.classList.toggle("on", b.dataset.n === niche));

// creator cards
function card(c) {
  const cr = c.creator || {}; const P = (cr.portfolio || []).slice(0, 4);
  return `<article class="card"><div class="cover" style="${c.coverUrl ? `background-image:url('${esc(c.coverUrl)}')` : ""}">${c.logoUrl ? `<img class="ava" src="${esc(c.logoUrl)}" alt=""/>` : `<div class="ava">🎥</div>`}</div>
    <div class="bd"><div class="nm">${esc(c.name)} ${cr.verified ? `<span class="ver" title="Verified by TapTayo">✔</span>` : ""}</div>
      <div class="badges">${c.rising ? `<span class="rise">🌱 Rising</span>` : ""}${cr.ugc ? `<span class="ugc">📱 UGC</span>` : ""}${(cr.niches || []).slice(0, 3).map((n) => `<span>${esc(n)}</span>`).join("")}${cr.paused ? `<span>⏸ On a break</span>` : ""}</div>
      <div class="meta">${cr.city ? `📍 ${esc(cr.city)}${cr.radiusKm ? ` · up to ${cr.radiusKm} km` : ""}` : esc(c.tagline || "")}${cr.sideJob ? ` · 🕒 ${esc(cr.sideJob)}` : ""}</div>
      <div class="stats">${cr.followers ? `<span>👥 <b>${kfmt(cr.followers)}</b></span>` : ""}${c.rating ? `<span>★ <b>${c.rating.avg}</b> (${c.rating.n})</span>` : ""}${cr.onTime ? `<span>⏱ <b>${cr.onTime.rate}%</b> on time</span>` : ""}${cr.projectsDone ? `<span>✅ ${cr.projectsDone} done</span>` : ""}${cr.xdeal ? `<span>🎁 X-Deal${cr.xdeal.minTip ? ` (tip ₱${cr.xdeal.minTip}+)` : ""}</span>` : ""}${c.from ? `<span>from <b>${peso(c.from)}</b></span>` : ""}</div>
      ${P.length ? `<div class="port">${P.map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener" title="${esc(x.label)}">${x.thumb ? `<img src="${esc(x.thumb)}" alt="${esc(x.label)}" loading="lazy"/>` : ""}${x.kind === "video" ? "<i>▶</i>" : ""}</a>`).join("")}</div>` : ""}
      ${cr.pitch ? `<div class="meta">${esc(cr.pitch.slice(0, 120))}${cr.pitch.length > 120 ? "…" : ""}</div>` : ""}
      <div class="cta"><a class="btn sm" href="/m/${esc(c.slug)}">${cr.offers && !cr.paused ? "See rates · make an offer" : "See rates · book"}</a></div></div></article>`;
}
async function search(scroll) {
  const raw = $("q").value.trim(); const city = $("city").value.trim();
  const asNiche = !niche && KNOWN.includes(raw.toLowerCase()) ? NICHES.find((n) => n[0].toLowerCase() === raw.toLowerCase())[0] : niche;
  const isUgc = asNiche === "UGC" || $("ugcOnly").checked;
  $("results").innerHTML = `<div class="empty">Searching…</div>`;
  try {
    items = await call("creatorDirectory", { niche: asNiche === "UGC" ? "" : asNiche, q: asNiche ? "" : raw, city, ugc: isUgc });
    $("resTitle").textContent = asNiche || raw ? `${asNiche || `“${raw}”`} creators${city ? ` in ${city}` : ""}` : city ? `Creators in ${city}` : "Top creators right now";
    $("resSub").textContent = `${items.length} found · ranked by their work and results — not just followers.`;
    $("results").innerHTML = items.map(card).join("") || `<div class="empty"><b>No creators found yet.</b><br>Try another niche or city — or <a href="/login/?signup=1&role=business">post an open collab</a> so creators find you.</div>`;
  } catch (e) { $("results").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  try { const u = new URL(location.href); ["q", "niche", "city"].forEach((k) => u.searchParams.delete(k)); if (raw) u.searchParams.set("q", raw); if (niche) u.searchParams.set("niche", niche); if (city) u.searchParams.set("city", city); history.replaceState(null, "", u); } catch {}
  if (scroll) $("creators").scrollIntoView({ behavior: "smooth" });
}
$("searchForm").onsubmit = (e) => { e.preventDefault(); niche = ""; drawChips(); search(true); };
$("ugcOnly").onchange = () => search(false);

// open collabs
async function collabs() {
  try {
    const L = await call("collabList", {});
    $("collabList").innerHTML = L.slice(0, 9).map((c) => `<article class="cb"><div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start"><h3>${esc(c.title)}</h3><span class="tag">${esc(c.niche)}${c.ugc ? " · UGC" : ""}</span></div>
      <div class="meta">🏪 <b>${esc(c.storeName)}</b>${c.city ? ` · 📍 ${esc(c.city)}` : ""}${c.deadline ? ` · by ${new Date(c.deadline + "T00:00:00").toLocaleDateString("en-PH", { month: "short", day: "numeric" })}` : ""}</div>
      <div><span class="money">${c.budgetEach ? `${peso(c.budgetEach)}` : "Freebies"}</span>${c.budgetEach ? ` <span class="meta">per creator</span>` : ""}${c.freebies ? `<div class="meta">+ ${esc(c.freebies)}</div>` : ""}</div>
      ${c.deliverables ? `<div class="meta">📦 ${esc(c.deliverables)}</div>` : ""}${c.details ? `<div class="meta">${esc(c.details.slice(0, 140))}</div>` : ""}
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:auto"><span class="meta">${Math.max(0, c.slots - c.filled)} slot${c.slots - c.filled === 1 ? "" : "s"} left${c.apps ? ` · ${c.apps} applied` : ""}</span><a class="btn sm" href="/login/?signup=1&role=creator&next=${encodeURIComponent("/app/#projects")}">Apply</a></div></article>`).join("") || `<div class="empty">No open collabs right now. <a href="/login/?signup=1&role=business">Post the first one</a>.</div>`;
  } catch (e) { $("collabList").innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}

// video tabs
document.querySelectorAll("[data-v]").forEach((b) => (b.onclick = () => {
  document.querySelectorAll("[data-v]").forEach((x) => { const on = x === b; x.classList.toggle("on", on); x.style.background = on ? "var(--ink)" : "transparent"; x.style.color = on ? "#fff" : "var(--ink)"; });
  const tall = matchMedia("(max-width: 640px)").matches; const v = $("vid"); const k = b.dataset.v + (tall ? "-v" : "");
  v.poster = `/videos/${k}.jpg`; v.src = `/videos/${k}.mp4`; v.play()?.catch?.(() => {});
}));
if (matchMedia("(max-width: 640px)").matches) { const v = $("vid"); v.style.aspectRatio = "9 / 16"; v.parentElement.style.maxWidth = "420px"; v.poster = "/videos/collab-v.jpg"; v.src = "/videos/collab-v.mp4"; }

// coming soon → progress to the first N creators + waitlist
call("collabStatus", {}).then((c) => {
  if (c.live) return; const b = $("soon"); b.hidden = false;
  b.querySelector("[data-city]").textContent = c.city; b.querySelector("[data-target]").textContent = c.target; b.querySelector("[data-count]").textContent = c.creators; b.querySelector("[data-bar]").style.width = Math.min(100, Math.round((c.creators / c.target) * 100)) + "%";
  b.querySelector("[data-wl]").onclick = async (e) => { try { await call("collabWaitlist", { role: "business" }); e.target.textContent = "✓ You're on the list"; e.target.disabled = true; } catch (x) { if (/Log in/.test(x.message)) location.href = "/login/?signup=1&role=business&next=/collab/"; else alert(x.message); } };
  document.querySelectorAll('#collabList .btn').forEach((a) => (a.textContent = "Soon"));
}).catch(() => {});

// logged in? → "My TapTayo"
onAuthStateChanged(auth, (u) => { if (u && !u.isAnonymous) { const a = $("loginLink"); a.textContent = "My TapTayo"; a.href = "/me/"; } });

// start: ?q= / ?niche= / ?city= from links (e.g. My TapTayo search)
const P = new URLSearchParams(location.search);
if (P.get("q")) $("q").value = P.get("q"); if (P.get("city")) $("city").value = P.get("city"); if (P.get("niche")) niche = P.get("niche");
drawChips(); search(!!(P.get("q") || P.get("niche") || P.get("city"))); collabs();
