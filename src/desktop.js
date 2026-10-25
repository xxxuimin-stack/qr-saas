// Desktop layout (≥ 1100px wide), clean like Facebook:
//   left  = navigation on top (pages, categories, ordering), then one-line buttons that open on tap
//           (hours, location + map, payments, contact, policies, team, news, promos, photos, amenities, nearby)
//   middle = the normal page (#app) — unchanged, so phones and tablets look exactly the same
//   right = just a little: the order / book box, your booking, badge + rating, stamps, open on your phone
// Built from the store data + the page on screen; refreshed when the page or the cart changes.
import { trustBadge } from "./trust.js";
import { openStatus, hoursLine, fmt12, DAY_KEYS, DAY_NAMES } from "./hours.js";
import { qrGroup } from "./brandqr.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const peso = (n) => "₱" + Number(n || 0).toLocaleString("en-PH", { maximumFractionDigits: 2 });
const MQ = "(min-width: 1100px)";
let ctx = null, on = false, timer = null, obs = null;
const cache = { stamps: undefined, mine: undefined, free: undefined }; // async bits, loaded once per page view

/** ctx: { app, slug, getStore, getCart, openCart, call, loadLocal, isReal, openTab(tab), bookWith(staffId), viewLast(kind, rec) } */
export function enableDesktop(c) {
  ctx = c;
  if (enableDesktop.done) return; enableDesktop.done = true;
  const mq = window.matchMedia(MQ);
  const apply = () => (mq.matches ? turnOn() : turnOff());
  mq.addEventListener?.("change", apply); apply();
  window.addEventListener("tt:cart", () => schedule());
}
export function desktopRefresh() { schedule(); }

function turnOn() {
  if (on) return; on = true;
  document.documentElement.classList.add("dsk");
  for (const [id, cls] of [["dTop", "d-top"], ["dL", "d-side d-left"], ["dR", "d-side d-right"]]) {
    if (!document.getElementById(id)) { const el = document.createElement(id === "dTop" ? "header" : "aside"); el.id = id; el.className = cls; document.body.prepend(el); }
  }
  obs = new MutationObserver(() => schedule()); obs.observe(ctx.app, { childList: true, subtree: true });
  draw(); loadAsync();
}
function turnOff() {
  if (!on) return; on = false;
  document.documentElement.classList.remove("dsk");
  obs?.disconnect(); ["dTop", "dL", "dR"].forEach((id) => document.getElementById(id)?.remove());
}
function schedule() { if (!on) return; clearTimeout(timer); timer = setTimeout(draw, 120); }

const box = (title, inner, cls = "") => `<section class="d-box ${cls}">${title ? `<h4>${title}</h4>` : ""}${inner}</section>`;
const scrollToEl = (el) => window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 76, behavior: "smooth" });
const safeUrl = (u) => { const s = String(u || "").trim(); return /^https:\/\/[^\s"'<>]+$/i.test(s) ? s : ""; };
const handle = (v, base) => { const s = String(v || "").trim(); if (!s) return ""; if (/^https?:\/\//i.test(s)) return safeUrl(s.replace(/^http:/i, "https:")); const h = s.replace(/^@/, "").replace(/^(www\.)?(facebook|instagram|tiktok)\.com\/@?/i, "").replace(/[^A-Za-z0-9._-]/g, ""); return h ? base + h : ""; };
const PAY_ICON = { gcash: "💙", maya: "💚", paymaya: "💚", cash: "💵", card: "💳", bank: "🏦", qrph: "🔳", grabpay: "🟢", shopeepay: "🧡" };

/** things that need a server call — fetched once, then the sidebars redraw */
async function loadAsync() {
  const store = ctx.getStore(); if (!store) return;
  const L = ctx.loadLocal?.() || {};
  if (store.loyalty && cache.stamps === undefined) {
    cache.stamps = null; const phone = L.customer?.phone;
    if (phone) { try { const r = await ctx.call("myStamps", { slug: ctx.slug, phone }); if (r && typeof r.stamps === "number") cache.stamps = r; } catch {} schedule(); }
  }
  if (cache.mine === undefined) {
    cache.mine = null;
    if (ctx.isReal?.()) { try { const list = await ctx.call("myBookings", {}); cache.mine = (list || []).filter((b) => b.storeId === store.storeId); } catch {} schedule(); }
  }
  if (store.mode === "stay" && cache.free === undefined && (store.rooms || [])[0]) {
    cache.free = null;
    try {
      const room = store.rooms[0]; const r = await ctx.call("getStayCalendar", { slug: ctx.slug, roomId: room.id });
      const booked = new Set([...(r.booked || []), ...(r.blocked || [])]); const out = [];
      for (let i = 0; i < 60 && out.length < 4; i++) { const d = new Date(Date.now() + 8 * 3600e3 + i * 864e5).toISOString().slice(0, 10); if (!booked.has(d)) out.push(d); }
      cache.free = { room: room.name, dates: out };
    } catch {}
    schedule();
  }
}

const OPEN = new Set();          // which folded rows the person opened (kept across redraws)
let ACTS = {}, lastL = "", lastR = "", lastTop = "";
const fold = (k, icon, label, summary, inner) => `<details class="d-fold" data-k="${k}" ${OPEN.has(k) ? "open" : ""}><summary><span class="d-ic">${icon}</span><span class="d-lb">${label}</span>${summary ? `<small>${summary}</small>` : ""}</summary><div class="d-fin">${OPEN.has(k) || k !== "map" ? inner : ""}</div></details>`;

function draw() {
  const store = ctx.getStore(); if (!store || !on) return;
  const app = ctx.app, top = document.getElementById("dTop"), L = document.getElementById("dL"), R = document.getElementById("dR");
  if (!top || !L || !R) return;
  const mode = store.mode || "table";
  const isFood = !["salon", "stay", "laundry"].includes(mode) && store.businessType !== "freelance";
  const local = ctx.loadLocal?.() || {};
  const c = store.contact || {};
  // actions look things up on the page when clicked, so they still work after the page re-renders
  const acts = {}; let ai = 0; const act = (fn) => { const k = "a" + ai++; acts[k] = fn; return `data-da="${k}"`; };
  const q = (sel) => app.querySelector(sel), qa = (sel) => [...app.querySelectorAll(sel)];

  // ---------- top bar
  const topHtml = `<div class="d-top-in"><a class="d-brand" href="${esc(location.pathname)}">${store.logoUrl ? `<img src="${esc(store.logoUrl)}" alt=""/>` : `<span class="d-lg">${esc((store.name || "·").trim()[0])}</span>`}<b>${esc(store.name)}</b>${trustBadge(store)}</a>
    <nav class="d-top-links">${c.phone ? `<a href="tel:${esc(String(c.phone).replace(/[^\d+]/g, ""))}">📞 ${esc(c.phone)}</a>` : ""}<a href="/me/">👤 My bookings</a></nav></div>`;

  // ---------- LEFT: navigation on top, everything else folded into one-line buttons
  const left = [];
  const tabs = qa("nav.c-tabs:not([data-tabs]) [data-tab]"), jumps = qa("[data-jump]"), svc = qa(".c-service [data-svc]");
  let nav = "";
  if (tabs.length > 1) nav += `<div class="d-nav">${tabs.map((b, i) => `<a href="#" ${act(() => { qa("nav.c-tabs:not([data-tabs]) [data-tab]")[i]?.click(); window.scrollTo({ top: 0 }); })} class="${b.classList.contains("active") ? "on" : ""}">${esc(b.textContent.trim())}</a>`).join("")}</div>`;
  if (jumps.length) nav += `<div class="d-sub">${esc(store.labels?.items || (isFood ? "Menu" : "Services"))}</div><div class="d-nav d-nav-sm">${jumps.map((b, i) => `<a href="#" ${act(() => qa("[data-jump]")[i]?.click())} class="${b.classList.contains("on") ? "on" : ""}">${esc(b.textContent.trim())}</a>`).join("")}</div>`;
  else if (tabs.length < 2) {
    const heads = qa("h2").filter((h) => h.offsetParent && h.textContent.trim()).slice(0, 8);
    if (heads.length > 1) nav += `<div class="d-nav">${heads.map((h, i) => `<a href="#" ${act(() => { const hh = qa("h2").filter((x) => x.offsetParent && x.textContent.trim())[i]; if (hh) scrollToEl(hh); })}>${esc(h.childNodes[0]?.textContent?.trim() || h.textContent.trim())}</a>`).join("")}</div>`;
  }
  if (svc.length) nav += `<div class="d-sub">Ordering</div><div class="d-chips">${svc.map((b, i) => `<button type="button" ${act(() => qa(".c-service [data-svc]")[i]?.click())} class="${b.classList.contains("active") ? "on" : ""}">${esc(b.textContent.trim())}</button>`).join("")}</div>`;
  if (nav) left.push(`<section class="d-box d-navbox">${nav}</section>`);

  const rows = [];
  if (mode === "stay" && store.stay) {
    const s = store.stay;
    rows.push(fold("inout", "🕑", "Check-in / out", `${fmt12(s.checkIn || "14:00")} · ${fmt12(s.checkOut || "12:00")}`, `<div class="d-row"><span>Check-in</span><b>${fmt12(s.checkIn || "14:00")}</b></div><div class="d-row"><span>Check-out</span><b>${fmt12(s.checkOut || "12:00")}</b></div>${s.downPct != null ? `<div class="d-row"><span>Downpayment</span><b>${s.downPct}%</b></div>` : ""}`));
    if ((s.amenities || []).length) { const paid = s.amenities.filter((a) => a.unit !== "free"); rows.push(fold("amen", "🏊", "Amenities", `${s.amenities.length}${paid.length ? ` · from ${peso(Math.min(...paid.map((a) => a.price)))}` : " · free"}`, s.amenities.map((a) => `<div class="d-row"><span>${esc(a.name)}</span><span class="d-mut">${a.unit === "free" ? "Free" : `${peso(a.price)} / ${a.unit === "head" ? "person" : a.unit === "hour" ? "hr" : "stay"}`}</span></div>`).join(""))); }
    const pics = (store.rooms || []).flatMap((r) => (r.photos || []).map((p) => ({ url: p.url, id: r.id, name: r.name }))).filter((p) => /^(https:|data:image\/)/.test(p.url || "")).slice(0, 6);
    if (pics.length) rows.push(fold("pics", "📷", "Photos", String(pics.length), `<div class="d-gal">${pics.map((p) => `<button type="button" ${act(() => q(`[data-room="${CSS.escape(p.id)}"]`)?.click())} style="background-image:url('${esc(String(p.url).replace(/'/g, "%27"))}')" aria-label="${esc(p.name)}"></button>`).join("")}</div>`));
  }
  if (store.hours && Object.keys(store.hours).length && mode !== "stay") {
    const st = openStatus(store.hours), todayK = DAY_KEYS[new Date().getDay()];
    rows.push(fold("hours", "🕑", "Hours", `<b style="color:${st.open ? "#15803d" : "#b42318"}">${st.open ? "Open" : "Closed"}</b>${st.open ? (st.closesAt ? ` · until ${fmt12(st.closesAt)}` : "") : st.opensAt ? ` · opens ${fmt12(st.opensAt)}` : ""}`,
      `<div class="d-week">${["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((k) => `<div class="${k === todayK ? "today" : ""}"><span>${DAY_NAMES[k].slice(0, 3)}</span><span>${esc(hoursLine(store.hours, k))}</span></div>`).join("")}</div>`));
  }
  const mapQ = String(c.address || "").trim();
  if (mapQ || safeUrl(c.mapUrl)) {
    const dir = safeUrl(c.mapUrl) || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQ)}`;
    rows.push(fold("map", "📍", "Location", esc(mapQ.split(",")[0] || "Map"), `${mapQ ? `<iframe class="d-map" loading="lazy" referrerpolicy="no-referrer-when-downgrade" title="Map of ${esc(store.name)}" src="https://www.google.com/maps?q=${encodeURIComponent(mapQ)}&output=embed"></iframe><div class="d-mut" style="margin-top:6px">${esc(mapQ)}</div>` : ""}<a class="d-link" href="${esc(dir)}" target="_blank" rel="noopener">Get directions ›</a>`));
  }
  const pays = (store.payments || []).filter((p) => p && (p.name || p.type));
  if (pays.length) rows.push(fold("pay", "💳", "Payments", esc(pays.slice(0, 2).map((p) => p.name || p.type).join(", ") + (pays.length > 2 ? ` +${pays.length - 2}` : "")), `<div class="d-chips d-static">${pays.map((p) => `<span>${PAY_ICON[String(p.type || "").toLowerCase()] || PAY_ICON[String(p.name || "").toLowerCase()] || "💠"} ${esc(p.name || p.type)}</span>`).join("")}</div>`));
  const soc = [["facebook", "Facebook", "https://facebook.com/", "📘"], ["instagram", "Instagram", "https://instagram.com/", "📸"], ["tiktok", "TikTok", "https://www.tiktok.com/@", "🎵"]].map(([k, l, base, ic]) => [l, handle(c[k], base), ic]).filter((x) => x[1]);
  if (safeUrl(c.messenger)) soc.push(["Messenger", safeUrl(c.messenger), "💬"]);
  if (c.phone || soc.length) rows.push(fold("contact", "💬", "Contact", esc(c.phone || soc.map((x) => x[0]).join(", ")), `${c.phone ? `<a class="d-link" href="tel:${esc(String(c.phone).replace(/[^\d+]/g, ""))}">📞 ${esc(c.phone)}</a>` : ""}${soc.length ? `<div class="d-chips d-static" style="margin-top:6px">${soc.map(([l, u, ic]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${ic} ${l}</a>`).join("")}</div>` : ""}`));
  const pol = []; const bp = store.bookingPolicy;
  if (bp) { const Rr = bp.reschedule || {}; pol.push(bp.refundable === false ? "Non-refundable" : "Refundable per shop policy", Rr.allowed === false ? "No rescheduling" : `Reschedule${Rr.max ? ` up to ${Rr.max}×` : ""}${Rr.cutoffHours ? ` until ${Rr.cutoffHours} h before` : ""}`); }
  const cx = store.stay?.cancel;
  if (mode === "stay" && cx && (cx.fullDays || cx.partialDays)) pol.push([cx.fullDays ? `Full refund ${cx.fullDays}+ days before` : "", cx.partialDays ? `${cx.partialPct}% refund ${cx.partialDays}+ days before` : ""].filter(Boolean).join(" · "));
  const longPol = mode === "stay" ? store.stay?.policy : store.policies?.salon || store.policies?.table || "";
  if (pol.length || longPol) rows.push(fold("pol", "📋", "Policies", esc(pol[0] || "Read"), `${pol.map((p) => `<div class="d-mut">• ${esc(p)}</div>`).join("")}${longPol ? `<div class="d-mut" style="white-space:pre-wrap;margin-top:6px;max-height:240px;overflow:auto">${esc(String(longPol).slice(0, 1500))}</div>` : ""}`));
  if ((store.team || []).length && mode === "salon") rows.push(fold("team", "💇", "Our team", String(store.team.length), `<div class="d-team">${store.team.slice(0, 8).map((t) => `<button type="button" ${act(() => ctx.bookWith?.(t.id))}>${t.photoUrl ? `<img src="${esc(t.photoUrl)}" alt="" loading="lazy"/>` : `<span class="d-av">${esc((t.name || "?")[0])}</span>`}<span><b>${esc(t.name)}</b><small>${t.rating ? `★ ${t.rating.avg} · ` : ""}Book with ${esc(String(t.name || "").split(" ")[0])}</small></span></button>`).join("")}</div>`));
  const news = (store.announcements || []).slice(0, 3);
  if (news.length) rows.push(fold("news", "📣", "News", String(news.length), news.map((a) => `<div class="d-news">${a.imageUrl ? `<img src="${esc(a.imageUrl)}" alt="" loading="lazy"/>` : ""}<div><b>${esc(a.title || "")}</b>${a.body ? `<div class="d-mut">${esc(String(a.body).slice(0, 160))}</div>` : ""}</div></div>`).join("")));
  const promos = (store.promos || []).filter((p) => p && p.name && p.active !== false).slice(0, 5);
  if (promos.length) rows.push(fold("promo", "🎁", "Promos", String(promos.length), promos.map((p) => `<div class="d-mut">• ${esc(p.name)}</div>`).join("")));
  if (q('[data-tab="gift"]')) rows.push(fold("gift", "🎁", "Gift cards", "", `<p class="d-mut" style="margin:0 0 6px">Give a treat — sent by text, used here.</p><button type="button" class="d-btn d-ghost" ${act(() => { q('[data-tab="gift"]')?.click(); window.scrollTo({ top: 0 }); })}>Give a gift card</button>`));
  if (mode === "stay" && (store.stay?.nearby || []).length) rows.push(fold("near", "🗺️", "Nearby", String(store.stay.nearby.length), store.stay.nearby.slice(0, 8).map((x) => `<div class="d-mut">${esc(x.kind || "📍")} ${esc(x.name)}${x.mins ? ` · ${x.mins} min` : ""}</div>`).join("")));
  if (rows.length) left.push(`<section class="d-box d-folds">${rows.join("")}</section>`);

  // ---------- RIGHT: just a little — the main action, yours, trust, open on phone
  const right = [];
  if (isFood) {
    const cart = ctx.getCart?.() || { lines: [], count: 0, total: 0 };
    if (cart.count) right.push(box("🛒 Your order", `${cart.lines.slice(0, 6).map((l) => `<div class="d-row"><span>${l.qty}× ${esc(l.name)}</span><b>${peso(l.amt)}</b></div>`).join("")}${cart.lines.length > 6 ? `<div class="d-mut">+${cart.lines.length - 6} more</div>` : ""}${cart.label ? `<div class="d-mut">${esc(cart.label)}</div>` : ""}<hr/><div class="d-row d-big"><b>Total</b><b>${peso(cart.total)}</b></div><button type="button" class="d-btn" ${act(() => ctx.openCart?.())}>Review order</button>`));
    else {
      const best = (store.bestsellers || []).map((id) => (store.items || []).find((i) => i.id === id)).filter((i) => i && i.available !== false).slice(0, 3);
      right.push(box("🛒 Your order", `<p class="d-mut" style="margin:0 0 ${best.length ? 6 : 0}px">Your cart is empty.${best.length ? " Popular:" : " Tap <b>+ Add</b> on anything."}</p>${best.map((i) => `<button type="button" class="d-best" ${act(() => { const el = document.getElementById("cat-best") || q(".c-cats"); if (el) scrollToEl(el); })}>${i.thumbUrl || i.imageUrl ? `<img src="${esc(i.thumbUrl || i.imageUrl)}" alt="" loading="lazy"/>` : `<span class="d-noimg">🍽</span>`}<span><b>${esc(i.name)}</b><small>${peso(i.price)}</small></span></button>`).join("")}`));
    }
  } else if (mode === "stay") {
    const rooms = (store.rooms || []).slice(0, 5); const bookBtn = q(".s-bookbar [data-book]");
    const free = cache.free?.dates?.length ? `<div class="d-mut" style="margin-top:8px">🗓 Next free: ${cache.free.dates.slice(0, 3).map((d) => new Date(d + "T12:00:00+08:00").toLocaleDateString("en-PH", { month: "short", day: "numeric" })).join(", ")}</div>` : "";
    if (bookBtn) { const nm = q(".s-room-top h1")?.textContent?.trim() || "this room", pr = q(".s-bookbar b")?.textContent || "";
      right.push(box("📅 Book this room", `<div class="d-row"><b>${esc(nm)}</b><span class="d-price">${esc(pr)}<small>/night</small></span></div><button type="button" class="d-btn" ${act(() => q(".s-bookbar [data-book]")?.click())}>Check dates & book</button>`)); }
    else if (rooms.length) right.push(box("📅 Book a room", `${rooms.map((r) => `<button type="button" class="d-roomrow" ${act(() => q(`[data-room="${CSS.escape(r.id)}"]`)?.click())}><span><b>${esc(r.name)}</b><small>Up to ${r.capacity || "?"} guests</small></span><span class="d-price">${peso(r.price)}<small>/night</small></span></button>`).join("")}${free}`));
  } else {
    right.push(box(mode === "laundry" ? "🧺 Laundry" : "📅 Book", `<p class="d-mut" style="margin:0">${mode === "laundry" ? "Book a pickup or drop-off." : "Pick your services, staff and time — confirmed right away."}</p><button type="button" class="d-btn" ${act(() => { const t = q('[data-tab="book"]'); if (t) t.click(); else ctx.openTab?.("book"); window.scrollTo({ top: 0, behavior: "smooth" }); })}>Book now</button>`));
  }
  const DONE = ["cancelled", "removed", "completed", "done", "checked_out", "no_show", "rejected"];
  const mine = (cache.mine || []).filter((b) => b.when && b.when > Date.now() - 3 * 3600e3 && !DONE.includes(b.status)).sort((a, b) => a.when - b.when)[0];
  if (mine) right.push(`<button type="button" class="d-box d-line" ${act(() => ctx.viewLast?.(mine.kind, { id: mine.id, storeId: mine.storeId, at: Date.now() }))}><span>⏰</span><span><b>Your booking</b><small>${new Date(mine.when).toLocaleString("en-PH", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</small></span><em>›</em></button>`);
  else {
    const kind = local.lastAppt ? "appt" : local.lastStay ? "stay" : local.lastOrder ? "order" : null; const last = kind && (local.lastAppt || local.lastStay || local.lastOrder);
    if (last && Date.now() - (last.at || 0) < 30 * 864e5) right.push(`<button type="button" class="d-box d-line" ${act(() => ctx.viewLast?.(kind, last))}><span>🧾</span><span><b>${kind === "order" ? "Your last order" : "Your last booking"}</b><small>${new Date(last.at).toLocaleDateString("en-PH", { month: "short", day: "numeric" })}${kind === "order" ? " · order again" : ""}</small></span><em>›</em></button>`);
  }
  // trust + rating in one small card
  const fb = store.feedback || {}, tb = trustBadge(store);
  if ((tb && store.trust) || fb.avg) {
    const b = new Set(store.trust?.badges || []); const docs = ["dti", "bir", "permit"].filter((k) => b.has(k));
    const title = b.has("verified") ? (docs.length === 3 ? "Fully verified" : "Verified business") : b.has("active") ? "Active on TapTayo" : docs.length ? "Documents checked" : tb ? "New on TapTayo" : "Reviews";
    const r0 = (fb.reviews || [])[0];
    right.push(`<section class="d-box"><h4>${tb} ${title}</h4><div class="d-mut">${[fb.avg ? `★ ${fb.avg} (${fb.count})` : "", store.trust?.tx >= 10 ? `${Number(store.trust.tx).toLocaleString("en-PH")} ${mode === "salon" || mode === "stay" ? "bookings" : "orders"}` : ""].filter(Boolean).join(" · ")}</div>${r0 ? `<div class="d-rev" style="margin:6px 0 0">“${esc(String(r0.comment || "").slice(0, 90))}”${r0.name ? ` — ${esc(r0.name)}` : ""}</div>` : ""}</section>`);
  }
  if (store.loyalty) { const lo = store.loyalty, have = cache.stamps?.stamps ?? null, of = cache.stamps?.of || lo.stamps || 10;
    right.push(`<section class="d-box"><h4>☕ Stamps</h4>${have === null ? `<div class="d-mut">Collect ${of} → ${esc(lo.rewardText || "a free treat")}</div>` : `<div class="d-stamps">${Array.from({ length: of }, (_, i) => `<i class="${i < have ? "on" : ""}"></i>`).join("")}</div><div class="d-mut">${have} of ${of}</div>`}</section>`); }
  // open on phone (QR folded)
  const link = `https://taptayo.com/m/${encodeURIComponent(store.slug || ctx.slug || "")}`;
  let qr = ""; try { qr = `<svg viewBox="0 0 120 120" width="120" height="120" aria-label="QR code to open this page on your phone">${qrGroup(link, { size: 120, color: "#141414" })}</svg>`; } catch {}
  right.push(`<section class="d-box d-folds">${fold("qr", "📱", "Open on your phone", "", `<div class="d-share">${qr}<div><p class="d-mut" style="margin:0 0 8px">Scan with your phone camera.</p><button type="button" class="d-btn d-ghost" ${act(async () => { try { if (navigator.share) await navigator.share({ title: store.name, url: link }); else { await navigator.clipboard.writeText(link); toastLite("Link copied"); } } catch {} })}>🔗 Share link</button></div></div>`)}</section>`);
  if (!store.hideBranding) right.push(`<a class="d-powered" href="https://taptayo.com/?ref=${encodeURIComponent(store.slug || "")}&utm_source=desktop" target="_blank" rel="noopener"><img src="/logo/favicon.svg" alt="" width="16" height="16"/> Powered by <b>TapTayo</b></a>`);

  ACTS = acts;
  const lh = left.join(""), rh = right.join("");
  // only touch the DOM when something changed (keeps open rows, the map and scroll position)
  if (topHtml !== lastTop) { top.innerHTML = topHtml; lastTop = topHtml; }
  for (const [el, html, key] of [[L, lh, "L"], [R, rh, "R"]]) {
    if ((key === "L" ? lastL : lastR) === html) continue;
    el.innerHTML = html; if (key === "L") lastL = html; else lastR = html;
    el.querySelectorAll("[data-da]").forEach((n) => (n.onclick = (e) => { e.preventDefault(); ACTS[n.dataset.da]?.(); }));
    el.querySelectorAll("details.d-fold").forEach((d) => d.addEventListener("toggle", () => { const k = d.dataset.k; if (d.open) OPEN.add(k); else OPEN.delete(k); if (k === "map" && d.open && !d.querySelector("iframe")) { lastL = ""; schedule(); } }));
  }
}

function toastLite(t) { const n = document.createElement("div"); n.className = "c-toast show"; n.textContent = t; document.body.appendChild(n); setTimeout(() => n.remove(), 1800); }
