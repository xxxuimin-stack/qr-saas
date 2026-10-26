// STAY / AIRBNB — customer side: rooms, photo gallery by area, calendar booking (ID + waiver + signature + downpayment),
// and the guest status page (countdowns, requests, reschedule, extend, check-out, feedback).
import { whereLine } from "./addrpin.js";
import { doc, onSnapshot } from "firebase/firestore";
import { signaturePad, signAndUploadWaiver } from "./waiver.js";
import { msgrField, readMsgr } from "./msgr.js";
import { uploadCustomerImage, uploadPrivateImage } from "./upload.js";
import { hydratePrivate } from "./privfiles.js";
import { rateRows } from "./ratecats.js";
import { receiptHTML, receiptFoot, stayReceiptData } from "./receipt.js";
import { trustChips, nameWithBadge, enableTrust } from "./trust.js";
import { ensureAccount, isRealAccount } from "./accountgate.js";

let C = null;          // context from menu.js
let store = null, view = "home", stayUnsub = null, tickTimer = null;
const AREAS = ["Bedroom", "Bathroom", "Living", "Kitchen", "Balcony", "Pool", "Outside", "Other"];
const REQ_TYPES = ["Early check-in", "Late check-out", "Extra bed", "Extra towels", "Swimming", "Parking", "Other"];
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDays = (s, n) => { const d = new Date(`${s}T00:00:00`); d.setDate(d.getDate() + n); return ymd(d); };
const fmtD = (s) => new Date(`${s}T00:00:00`).toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric" });
const fmt12 = (hm) => { const [h, m] = (hm || "14:00").split(":").map(Number); return `${h % 12 || 12}${m ? ":" + String(m).padStart(2, "0") : ""} ${h < 12 ? "AM" : "PM"}`; };
const nightsOf = (room, a, b) => { const cfg = store.stay || {}; const out = []; let d = a; let g = 0; while (d < b && g++ < 60) { const dow = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(`${d}T00:00:00`).getDay()]; const sp = (cfg.weekendNights || ["fri", "sat"]).includes(dow) || (cfg.holidays || []).includes(d); out.push({ date: d, price: sp && room.weekendPrice ? room.weekendPrice : room.price, special: sp }); d = addDays(d, 1); } return out; };
/** hour packages for a room: [{hours, price}] (room price overrides the shop's) */
const shortPkgs = (room) => { const sc = store.stay?.short; if (!sc?.enabled) return []; return [3, 6, 12].map((h) => { const r = room.shortPrices?.[h]; const p = sc.packages.find((x) => x.hours === h); const price = r != null && r !== "" ? Number(r) : p ? Number(p.price) : null; return price != null ? { hours: h, price } : null; }).filter(Boolean); };
const DOWS = { sun: "Sun", mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat" };
/** promos now + upcoming (start date in the future) */
const promoList = () => { const t = ymd(new Date()); return (store.stay?.promos || []).filter((p) => !p.end || p.end >= t).map((p) => ({ ...p, upcoming: !!(p.start && p.start > t) })); };
const promoWhen = (p) => `${p.days?.length ? p.days.map((d) => DOWS[d]).join(", ") : "Every day"}${p.from || p.until ? ` · ${fmt12(p.from || "00:00")}–${fmt12(p.until || "23:59")}` : ""}${p.applies === "short" ? " · hour packages" : p.applies === "night" ? " · overnight" : ""}${p.upcoming ? ` · starts ${fmtD(p.start)}` : p.end ? ` · until ${fmtD(p.end)}` : ""}`;
/** client preview of the best promo (the server decides; loyalty is added there) */
const promoFor = ({ nights, short, startMs, sub }) => { let best = null; const dowMs = (ms) => ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(ms + 8 * 3600000).getUTCDay()];
  for (const p of promoList()) { if (p.upcoming) continue; const d0 = new Date(startMs + 8 * 3600000).toISOString().slice(0, 10); if (p.start && d0 < p.start) continue; let amt = 0;
    if (short) { if (p.applies === "night") continue; const hm = new Date(startMs + 8 * 3600000).toISOString().slice(11, 16); if (p.days?.length && !p.days.includes(dowMs(startMs))) continue; if ((p.from && hm < p.from) || (p.until && hm > p.until)) continue; amt = sub * p.percent / 100; }
    else { if (p.applies === "short") continue; amt = nights.filter((n) => !p.days?.length || p.days.includes(["sun", "mon", "tue", "wed", "thu", "fri", "sat"][new Date(`${n.date}T00:00:00Z`).getUTCDay()])).reduce((a, n) => a + n.price, 0) * p.percent / 100; }
    if (amt > 0 && (!best || amt > best.amount)) best = { name: p.name, amount: Math.round(amt * 100) / 100 }; }
  return best; };
const phMs = (ymdStr, hm) => new Date(`${ymdStr}T${hm}:00+08:00`).getTime();
const bg = (u) => String(u || "").replace(/'/g, "%27").replace(/"/g, "%22");
const dur = (ms) => { if (ms <= 0) return "now"; const m = Math.floor(ms / 60000), dd = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60; return dd ? `${dd}d ${h}h` : h ? `${h}h ${mm}m` : `${mm} min`; };

export function stayStore(s, ctx, first) {
  C = ctx; store = s;
  if (first) {
    const my = new URLSearchParams(location.search).get("my"); // from My TapTayo
    if (my && my.startsWith("stay:")) { const rec = { id: my.slice(5), storeId: s.storeId, at: Date.now() }; C.saveLocal({ lastStay: rec }); return renderStatus(rec); }
    const last = C.loadLocal().lastStay;
    if (last && new URLSearchParams(location.search).get("view") !== "rooms") return renderStatus(last);
    return renderHome();
  }
  if (view === "home") renderHome(true);
}

// ---------------- HOME ----------------
function renderHome(keep) {
  view = "home"; stayUnsub?.(); clearInterval(tickTimer);
  const { esc, html, money } = C;
  const y = keep ? window.scrollY : 0;
  const rooms = store.rooms || [];
  const last = C.loadLocal().lastStay;
  const fb = store.feedback || {};
  C.app.innerHTML = "";
  const root = html(`<div class="c-page s-page">
    <header class="s-hero" style="${store.coverUrl ? `background-image:linear-gradient(180deg,rgba(0,0,0,.1),rgba(0,0,0,.65)),url('${bg(store.coverUrl)}')` : ""}">
      <div class="s-hero-in">${store.logoUrl ? `<img class="s-logo" src="${esc(store.logoUrl)}" alt=""/>` : ""}<h1>${nameWithBadge(store)}</h1>${store.tagline ? `<p>${esc(store.tagline)}</p>` : ""}${whereLine(store)}${trustChips(store)}
        <div class="s-chips"><span>🕑 Check-in ${fmt12(store.stay?.checkIn)}</span><span>Check-out ${fmt12(store.stay?.checkOut)}</span>${fb.count ? `<span>★ ${fb.avg} (${fb.count})</span>` : ""}</div></div>
    </header>
    <div class="s-body">
      ${last ? `<button class="c-bigbtn" data-mystay style="margin-bottom:14px"><span class="ic">🧳</span><span><b>View my booking</b><small>Status, check-out time, requests</small></span></button>` : ""}
      ${promoList().length ? `<div class="s-promos">${promoList().map((p) => `<div class="c-alert ${p.upcoming ? "" : "ok"}" style="margin-bottom:8px"><b>🏷️ ${esc(p.name)} · ${p.percent}% off</b>${p.upcoming ? ` <span class="small">(coming soon)</span>` : ""}<br><span class="small">${esc(promoWhen(p))}</span></div>`).join("")}</div>` : ""}
      ${store.stay?.loyalty?.enabled ? `<div class="c-alert" style="margin-bottom:12px">🎁 <b>Loyalty card:</b> every ${store.stay.loyalty.every}th stay is ${store.stay.loyalty.percent}% off.</div>` : ""}
      ${(store.announcements || []).filter((a) => a.imageUrl).slice(0, 4).map((a) => `<img class="s-poster" src="${esc(a.imageUrl)}" alt="${esc(a.title || "")}"/>`).join("")}
      <h2 class="s-h">Rooms</h2>
      <div class="s-rooms">${rooms.map((r) => { const ph = r.photos?.[0]?.url || r.posters?.[0]; return `<article class="s-room" data-room="${r.id}">
        <div class="s-room-img" ${ph ? `style="background-image:url('${bg(ph)}')"` : ""}>${ph ? "" : "🏡"}${r.photos?.length ? `<span class="s-count">📷 ${r.photos.length}</span>` : ""}</div>
        <div class="s-room-in"><div class="s-room-top"><b>${esc(r.name)}</b><span class="s-price">${money(r.price)}<small>/night</small></span></div>
          ${r.theme ? `<div class="muted small">${esc(r.theme)}</div>` : ""}
          <div class="s-meta">${r.rating ? `<b style="color:#b45309">★ ${r.rating.avg}</b> <span class="muted">(${r.rating.n})</span> · ` : ""}👥 Up to ${r.capacity}${r.beds ? ` · 🛏 ${esc(r.beds)}` : ""}</div>
          ${(r.notices || []).length ? `<div class="small" style="color:#b45309;font-weight:600">⚠️ ${esc(r.notices.map((n) => n.label).join(" · "))} · ${Math.max(...r.notices.map((n) => n.percent || 0))}% off</div>` : ""}
          <div class="s-ams">${(r.amenities || []).slice(0, 4).map((a) => `<span>${esc(a)}</span>`).join("")}</div>
          <button class="c-btn brand block" style="margin-top:10px">View &amp; book</button></div></article>`; }).join("") || `<p class="muted">Rooms are being set up. Please check back soon.</p>`}</div>
      ${(store.stay?.amenities || []).length ? `<div class="c-card-soft"><h2>Amenities</h2>${store.stay.amenities.map((a) => `<div class="c-mini"><span>${esc(a.name)}${a.note ? ` <small class="muted">· ${esc(a.note)}</small>` : ""}</span><span class="amt">${a.unit === "free" ? "Free" : `${money(a.price)} ${a.unit === "head" ? "/ person" : a.unit === "hour" ? "/ hour" : "/ stay"}`}</span></div>`).join("")}</div>` : ""}
      ${(store.stay?.nearby || []).length ? `<div class="c-card-soft"><h2>Nearby</h2>${store.stay.nearby.map((x) => `<div class="c-mini"><span>${esc(x.kind || "📍")} ${x.map ? `<a href="${esc(x.map)}" target="_blank" rel="noopener">${esc(x.name)}</a>` : esc(x.name)}</span><span class="amt">${x.mins ? `${x.mins} min` : ""}</span></div>`).join("")}</div>` : ""}
      ${store.stay?.policy ? `<div class="c-card-soft"><h2>House policy</h2><div class="s-policy">${esc(store.stay.policy)}</div></div>` : ""}
      ${(fb.reviews || []).length ? `<div class="c-card-soft"><h2>Guest reviews · ★ ${fb.avg} (${fb.count})</h2>${fb.reviews.map((r) => `<div class="s-review"><div style="color:var(--accent)">${"★".repeat(r.rating)}</div><div>“${esc(r.comment)}”</div><div class="muted small">— ${esc(r.name)}</div></div>`).join("")}</div>` : ""}
      ${store.contact?.phone || store.contact?.address ? `<div class="c-card-soft"><h2>Contact</h2>${store.contact.address ? `<div>📍 ${esc(store.contact.address)}</div>` : ""}${store.contact.phone ? `<div>📞 ${esc(store.contact.phone)}</div>` : ""}</div>` : ""}
    </div></div>`);
  root.querySelectorAll("[data-room]").forEach((el) => (el.onclick = () => renderRoom(rooms.find((r) => r.id === el.dataset.room))));
  root.querySelector("[data-mystay]")?.addEventListener("click", () => renderStatus(last));
  C.app.appendChild(root);
  window.scrollTo(0, y);
}

// ---------------- ROOM ----------------
function renderRoom(room) {
  if (!room) return renderHome();
  view = "room";
  const { esc, html, money } = C;
  const photos = room.photos || [];
  const areas = AREAS.filter((a) => photos.some((p) => (p.area || "Other") === a));
  let area = "All";
  C.app.innerHTML = "";
  const root = html(`<div class="c-page s-page">
    <div class="s-topbar"><button class="s-back" data-back>‹ Rooms</button><b>${esc(store.name)}</b></div>
    <div class="s-gallery"><div class="s-main" data-main></div><div class="s-areas" data-areas></div><div class="s-thumbs" data-thumbs></div></div>
    <div class="s-body">
      <div class="s-room-top"><h1 style="margin:0">${esc(room.name)}</h1><span class="s-price">${money(room.price)}<small>/night</small></span></div>
      ${room.theme ? `<div class="muted">${esc(room.theme)}</div>` : ""}
      ${room.weekendPrice && room.weekendPrice !== room.price ? `<div class="small muted">Weekend &amp; holiday nights: <b>${money(room.weekendPrice)}</b></div>` : ""}
      ${shortPkgs(room).length ? `<div class="small" style="margin-top:4px">⏳ Short stays: ${shortPkgs(room).map((p) => `<b>${p.hours} h ${money(p.price)}</b>`).join(" · ")}</div>` : ""}
      <div class="s-meta" style="margin:10px 0">👥 Up to ${room.capacity} guests${room.beds ? ` · 🛏 ${esc(room.beds)}` : ""}</div>
      ${room.description ? `<p>${esc(room.description)}</p>` : ""}
      ${room.rating ? `<div class="c-card-soft" style="margin:10px 0"><b style="font-size:1.2rem;color:#b45309">★ ${room.rating.avg}</b> <span class="muted">· ${room.rating.n} review${room.rating.n > 1 ? "s" : ""}</span>${room.rating.cats ? `<div class="small" style="display:grid;grid-template-columns:1fr auto;gap:2px 10px;margin-top:6px">${Object.entries(room.rating.cats).map(([k, v]) => `<span>${esc(k[0].toUpperCase() + k.slice(1))}</span><b>${(v / room.rating.n).toFixed(1)}</b>`).join("")}</div>` : ""}</div>` : ""}
      ${(room.notices || []).length ? `<div class="c-alert warn" style="text-align:left"><b>⚠️ Room notice — ${Math.max(...room.notices.map((n) => n.percent || 0))}% off</b>${room.notices.map((n) => `<div>• ${esc(n.label)}</div>`).join("")}<div class="small">We tell you before you book, so there are no surprises.</div></div>` : ""}
      ${room.doorType === "smartlock" || room.doorType === "lockbox" ? `<div class="small" style="margin:6px 0">🔑 Self check-in (${room.doorType === "smartlock" ? "smart lock" : "key lockbox"}) — your code shows on your booking page.</div>` : ""}
      ${(room.amenities || []).length ? `<h3 class="s-h3">Amenities</h3><div class="s-ams big">${room.amenities.map((a) => `<span>${esc(a)}</span>`).join("")}</div>` : ""}
      ${store.stay?.pool?.mode && store.stay.pool.mode !== "none" ? `<div class="c-alert ok" style="margin-top:12px">🏊 Pool: ${store.stay.pool.mode === "included" ? "included" : store.stay.pool.mode === "per_head" ? `${money(store.stay.pool.price)} per swimmer` : "ask the caretaker (add it as a request)"}</div>` : ""}
      ${(room.posters || []).map((p) => `<img class="s-poster" src="${esc(p)}" alt=""/>`).join("")}
      ${room.rules ? `<h3 class="s-h3">Room rules</h3><div class="s-policy">${esc(room.rules)}</div>` : ""}
    </div>
    <div class="s-bookbar"><div><b>${money(room.price)}</b><span class="muted small"> / night</span></div><button class="c-btn brand" data-book>Book this room</button></div>
  </div>`);
  const drawGallery = () => {
    const list = area === "All" ? photos : photos.filter((p) => (p.area || "Other") === area);
    const main = root.querySelector("[data-main]");
    const first = list[0];
    main.innerHTML = first ? `<img src="${esc(first.url)}" alt=""/><span class="s-tag">${esc(first.area || "Photo")}</span>` : `<div class="s-noimg">🏡</div>`;
    root.querySelector("[data-areas]").innerHTML = areas.length > 1 ? ["All", ...areas].map((a) => `<button class="${a === area ? "on" : ""}" data-a="${a}">${a}</button>`).join("") : "";
    root.querySelector("[data-thumbs]").innerHTML = list.map((p, i) => `<img src="${esc(p.url)}" data-i="${i}" class="${i === 0 ? "on" : ""}" alt="${esc(p.area || "")}"/>`).join("");
    root.querySelectorAll("[data-a]").forEach((b) => (b.onclick = () => { area = b.dataset.a; drawGallery(); }));
    root.querySelectorAll("[data-i]").forEach((im) => (im.onclick = () => { const p = list[Number(im.dataset.i)]; main.innerHTML = `<img src="${esc(p.url)}" alt=""/><span class="s-tag">${esc(p.area || "Photo")}</span>`; root.querySelectorAll("[data-i]").forEach((x) => x.classList.toggle("on", x === im)); }));
  };
  drawGallery();
  root.querySelector("[data-back]").onclick = () => renderHome();
  root.querySelector("[data-book]").onclick = () => openBooking(room);
  C.app.appendChild(root);
  window.scrollTo(0, 0);
}

// ---------------- CALENDAR (range picker; booked nights disabled) ----------------
function calendar(el, booked, onPick, initial = {}) {
  let month = new Date(); month.setDate(1);
  let a = initial.a || null, b = initial.b || null;
  const today = ymd(new Date());
  const draw = () => {
    const y = month.getFullYear(), m = month.getMonth(), first = new Date(y, m, 1).getDay(), days = new Date(y, m + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < first; i++) cells.push(`<span></span>`);
    for (let d = 1; d <= days; d++) {
      const s = ymd(new Date(y, m, d));
      const past = s < today, bk = booked.has(s);
      const inR = a && b && s >= a && s < b, isA = s === a, isB = s === b;
      cells.push(`<button type="button" data-d="${s}" class="${bk ? "bk" : ""} ${inR ? "in" : ""} ${isA ? "a" : ""} ${isB ? "b" : ""}" ${past || (bk && !(a && !b && s > a)) ? "disabled" : ""}>${d}</button>`);
    }
    el.innerHTML = `<div class="s-cal"><div class="s-cal-h"><button type="button" data-prev>‹</button><b>${month.toLocaleDateString("en-PH", { month: "long", year: "numeric" })}</b><button type="button" data-next>›</button></div>
      <div class="s-cal-g">${["S", "M", "T", "W", "T", "F", "S"].map((x) => `<i>${x}</i>`).join("")}${cells.join("")}</div>
      <div class="small muted" style="margin-top:6px">${!a ? "Tap your check-in date" : !b ? "Now tap your check-out date" : `${fmtD(a)} → ${fmtD(b)}`} · <span class="s-key bk"></span> booked</div></div>`;
    el.querySelector("[data-prev]").onclick = () => { const t = new Date(); t.setDate(1); if (month > t) { month.setMonth(month.getMonth() - 1); draw(); } };
    el.querySelector("[data-next]").onclick = () => { month.setMonth(month.getMonth() + 1); draw(); };
    el.querySelectorAll("[data-d]").forEach((btn) => (btn.onclick = () => {
      const s = btn.dataset.d;
      if (!a || b || s <= a) { if (booked.has(s)) return; a = s; b = null; }
      else {
        // the range can't cross a booked night
        let d = a, ok = true; while (d < s) { if (booked.has(d)) { ok = false; break; } d = addDays(d, 1); }
        if (!ok) { C.toast("Some nights in between are already booked"); return; }
        b = s;
      }
      draw(); onPick(a, b);
    }));
  };
  draw();
}

// ---------------- BOOKING ----------------
async function openBooking(room) {
  if (!store.demo && !isRealAccount()) { if (await ensureAccount({ openSheet: C.openSheet, closeSheet: C.closeSheet, html: C.html, toast: C.toast }, "book your stay")) return openBooking(room); return; }
  const { esc, html, money } = C;
  const cfg = store.stay || {};
  const saved = C.loadLocal().customer || {};
  const gcash = (store.payments || []).filter((m) => m.type !== "cash" && m.type !== "card");
  const pkgs = shortPkgs(room);
  let mode = "night", sh = { date: null, hours: pkgs[0]?.hours || null, time: null }, busy = [];
  const addq = {}, amq = {}; let kids = 0;
  let dates = { a: null, b: null }, guests = Math.min(2, room.capacity || 2), swimmers = 0, payId = gcash[0]?.id || null;
  const body = html(`<div class="s-book s-wiz">
    <ol class="s-prog" data-prog>${["When", "Guests", "Details", "Confirm"].map((l, i) => `<li data-pg="${i + 1}"><i>${i + 1}</i><span>${l}</span></li>`).join("")}</ol>
    <section data-pane="1">
    <h3 class="s-step">${pkgs.length ? "When are you staying?" : "Pick your dates"}</h3>
    ${pkgs.length ? `<div class="c-chips" data-modes style="margin-bottom:10px"><button type="button" class="chip on" data-mode="night">🌙 Overnight</button><button type="button" class="chip" data-mode="short">⏳ By the hour</button></div>` : ""}
    <div data-cal><p class="muted small">Loading availability…</p></div>
    <div data-short hidden>
      <label>Package</label><div class="c-pick" data-pk>${pkgs.map((p) => `<button type="button" data-h="${p.hours}"><b>${p.hours} hours</b><span>${money(p.price)}</span></button>`).join("")}</div>
      <label>Date</label><input type="date" data-sdate min="${ymd(new Date())}"/>
      <label>Check-in time</label><div class="c-slots" data-times><span class="muted small">Pick a date first.</span></div>
      <p class="small muted">Great if you only need the room for a few hours — no need to pay for the whole night.</p>
    </div>
    <div data-sum class="s-sum"></div>
    </section>
    <section data-pane="2" hidden>
    <h3 class="s-step">Who's coming?</h3>
    <div class="row between"><span>Adults <span class="muted small">(max ${room.capacity}${cfg.kids?.countInPax ? " incl. kids" : ""})</span></span><div class="c-qty"><button type="button" data-gm>−</button><span data-g>${guests}</span><button type="button" data-gp>+</button></div></div>
    <div class="row between" style="margin-top:8px"><span>Kids <span class="muted small">${cfg.kids?.freeUnder ? `(below ${cfg.kids.freeUnder} free)` : ""}</span></span><div class="c-qty"><button type="button" data-km>−</button><span data-k>0</span><button type="button" data-kp>+</button></div></div>
    ${(cfg.amenities || []).length ? `<h3 class="s-step">Amenities <span class="muted small">(pick what you'll use)</span></h3><div class="s-amen">${cfg.amenities.map((a) => `<div style="display:flex;align-items:center;gap:10px;margin:8px 0"><span style="flex:1;min-width:0"><b>${esc(a.name)}</b><br><span class="muted small">${a.unit === "free" ? "Free for guests" : `${money(a.price)} ${a.unit === "head" ? "per person" : a.unit === "hour" ? "per hour" : "per stay"}`}${a.note ? ` · ${esc(a.note)}` : ""}</span></span>${a.unit === "free" ? `<span class="pill ok">included</span>` : `<div class="c-qty" style="flex:none"><button type="button" data-mm="${a.id}">−</button><span data-mq="${a.id}">0</span><button type="button" data-mp="${a.id}">+</button></div>`}</div>`).join("")}</div>` : ""}
    ${(cfg.amenities || []).length ? "" : cfg.pool?.mode === "ask" ? `<div class="small muted" style="margin-top:6px">🏊 Want to swim? Add it in your request — the caretaker will tell you the price.</div>` : ""}
    ${(cfg.addons || []).length ? `<h3 class="s-step">Extras <span class="muted small">(optional)</span></h3><div class="s-addons">${cfg.addons.map((a) => `<div style="display:flex;align-items:center;gap:10px;margin:8px 0"><span style="flex:1;min-width:0"><b>${esc(a.name)}</b><br><span class="muted small">${money(a.price)}${a.per === "night" ? " / night" : ""}${a.approval ? " · if available" : ""}</span></span><div class="c-qty" style="flex:none"><button type="button" data-am="${a.id}">−</button><span data-aq="${a.id}">0</span><button type="button" data-ap="${a.id}">+</button></div></div>`).join("")}<p class="small muted">Items marked "if available" are confirmed by the caretaker. Kits are ready in the room when you arrive.</p></div>` : ""}
    <div data-gids></div>
    <h3 class="s-step">Request <span class="muted small">(optional)</span></h3>
    <textarea data-req rows="2" maxlength="300" placeholder="e.g. early check-in, extra towels, celebrating a birthday"></textarea>
    </section>
    <section data-pane="3" hidden>
    <h3 class="s-step">Your details</h3>
    <label>Full name</label><input data-name value="${esc(saved.name || "")}"/>
    <label>Phone</label><input data-phone type="tel" value="${esc(saved.phone || "")}" placeholder="09XX XXX XXXX"/>
    ${msgrField(saved)}
    <h3 class="s-step">Downpayment</h3>
    <div data-pay></div>
    </section>
    <section data-pane="4" hidden>
    <h3 class="s-step">Before you book</h3>
    <div class="s-policy">
      <div><span>🕑</span><span>Check-in <b>${fmt12(cfg.checkIn || "14:00")}</b> · Check-out <b>${fmt12(cfg.checkOut || "12:00")}</b></span></div>
      <div><span>💸</span><span>${store.bookingPolicy?.refundable !== false && (cfg.cancel?.fullDays || cfg.cancel?.partialDays) ? `${cfg.cancel.fullDays ? `Full refund ${cfg.cancel.fullDays}+ days before` : ""}${cfg.cancel.fullDays && cfg.cancel.partialDays ? " · " : ""}${cfg.cancel.partialDays ? `${cfg.cancel.partialPct}% refund ${cfg.cancel.partialDays}+ days before` : ""}` : "<b>Non-refundable</b> — you may ask to move your dates"}</span></div>
      ${ovRate(cfg) ? `<div><span>⏰</span><span>Late check-out: ${money(ovRate(cfg))} per hour${cfg.overstay?.graceMin ? ` after ${cfg.overstay.graceMin} min` : ""}</span></div>` : ""}
      ${(room.deposit ?? cfg.deposit?.amount) ? `<div><span>🔐</span><span>Security deposit ${money(room.deposit ?? cfg.deposit.amount)} — refundable</span></div>` : ""}
      <div><span>🪪</span><span>If the shop asks for an ID, send the photo in Message us on Messenger. It is not saved on this form.</span></div>
    </div>
    ${store.bookingPolicy ? `<div class="small muted" style="margin:6px 0">📅 ${C.esc((() => { const bp = store.bookingPolicy, R = bp.reschedule || {}; return [bp.refundable === false ? "Non-refundable" : "", R.allowed === false ? "No rescheduling" : `Reschedule${R.max ? ` up to ${R.max}×` : ""}${R.cutoffHours ? ` until ${R.cutoffHours} h before` : ""}`, R.allowed !== false && R.fee ? `${R.feeType === "percent" ? R.fee + "%" : money(R.fee)} moving date fee` : ""].filter(Boolean).join(" · "); })())}</div>` : ""}
    ${(room.notices || []).length ? `<div class="c-alert warn" style="text-align:left"><b>⚠️ Room notice</b>${room.notices.map((n) => `<div>• ${esc(n.label)}</div>`).join("")}<div class="small">That's why this room is <b>${Math.max(...room.notices.map((n) => n.percent || 0))}% off</b> right now.</div><label class="c-agree" style="margin-top:6px"><input type="checkbox" data-noticeok/> I know about this and still want to book</label></div>` : ""}
    ${cfg.policy ? `<details class="s-more"><summary>Read the house policy</summary><div class="waiver-text">${esc(cfg.policy)}</div></details>` : ""}
    <label class="c-agree"><input type="checkbox" data-ok1/> I have read and agree to the house policy</label>
    ${cfg.houseRules ? `<details class="s-more"><summary>Read the house rules</summary><div class="waiver-text">${esc(cfg.houseRules)}</div></details><label class="c-agree"><input type="checkbox" data-rules/> I accept the house rules</label>` : ""}
    ${ovRate(cfg) ? `<label class="c-agree"><input type="checkbox" data-ovack/> <span>I understand: staying past check-out costs <b>${money(ovRate(cfg))} per hour</b>${cfg.overstay?.graceMin ? ` after a ${cfg.overstay.graceMin}-minute grace period` : ""}${cfg.deposit?.amount ? " (taken from the security deposit if unpaid)" : ""}.</span></label>` : ""}
    ${cfg.cleaning?.minutes ? `<p class="small muted" style="margin:4px 0 0">🧹 Rooms are cleaned between guests (about ${cfg.cleaning.minutes} min) — you'll see on your booking page when your room is ready.</p>` : ""}
    <label class="c-agree"><input type="checkbox" data-ok2/> <span>${store.bookingPolicy?.refundable !== false && (cfg.cancel?.fullDays || cfg.cancel?.partialDays) ? `<b>Refund policy:</b> ${cfg.cancel.fullDays ? `full refund if cancelled ${cfg.cancel.fullDays}+ days before` : ""}${cfg.cancel.fullDays && cfg.cancel.partialDays ? ", " : ""}${cfg.cancel.partialDays ? `${cfg.cancel.partialPct}% refund ${cfg.cancel.partialDays}+ days before` : ""}; no refund after that. I may request to reschedule.` : `<b>No refund.</b> I understand payments are non-refundable; I may request to reschedule.`}</span></label>
    ${cfg.waiverText ? `<details class="s-more"><summary>Read the waiver you're signing</summary><div class="waiver-text">${esc(cfg.waiverText)}</div></details>` : ""}
    
    <label>Signature</label><div data-sig></div>
    </section>
    <div data-err></div></div>`);
  const foot = html(`<div class="s-foot"><div class="s-tot"><small>Total</small><b data-ft>—</b><span data-fdown></span></div><button class="c-btn ghost" type="button" data-back hidden>Back</button><button class="c-btn brand" type="button" data-fwd>Next</button><button class="c-btn brand" data-go hidden><span>Book</span></button></div>`);
  let step = 1;
  const goStep = (n) => {
    step = Math.max(1, Math.min(4, n));
    body.querySelectorAll("[data-pane]").forEach((p) => (p.hidden = Number(p.dataset.pane) !== step));
    body.querySelectorAll("[data-pg]").forEach((li) => { const i = Number(li.dataset.pg); li.classList.toggle("on", i === step); li.classList.toggle("done", i < step); });
    foot.querySelector("[data-back]").hidden = step === 1; foot.querySelector("[data-fwd]").hidden = step === 4; foot.querySelector("[data-go]").hidden = step !== 4;
    body.querySelector("[data-err]").innerHTML = ""; body.closest(".c-sheet-body, .c-sheet, [data-sheet-body]")?.scrollTo?.({ top: 0 }); body.scrollIntoView?.({ block: "start" });
  };
  body.querySelectorAll("[data-pg]").forEach((li) => (li.onclick = () => { if (Number(li.dataset.pg) < step) goStep(Number(li.dataset.pg)); }));
  const pad = signaturePad(); body.querySelector("[data-sig]").appendChild(pad.el);
  const extras = (n) => [...(cfg.addons || []).filter((a) => addq[a.id]).map((a) => ({ ...a, qty: addq[a.id], amount: a.price * addq[a.id] * (a.per === "night" ? Math.max(1, n) : 1) })), ...(cfg.amenities || []).filter((a) => a.unit !== "free" && amq[a.id]).map((a) => ({ ...a, name: `${a.name}${a.unit === "head" ? "" : a.unit === "hour" ? " (hours)" : ""}`, qty: amq[a.id], amount: a.price * (a.unit === "stay" ? 1 : amq[a.id]) }))];
  const noticePct = Math.max(0, ...(room.notices || []).map((n) => n.percent || 0));
  const finish = (o) => { const ex = extras(o.nights.length); const exT = ex.reduce((x, y) => x + y.amount, 0); const disc = promoFor({ nights: o.nights, short: o.short, startMs: o.startMs, sub: o.sub }); const nd = Math.round(o.sub * noticePct) / 100; const tot = o.sub + o.pool + exT - (disc?.amount || 0) - nd; return { ...o, ex, disc, nd, tot, down: Math.min(Math.round(tot * (cfg.downPct ?? 50)) / 100, store.trust?.newShop ? 1500 : Infinity) }; };
  const total = () => { if (mode === "short") { const p = pkgs.find((x) => x.hours === sh.hours); if (!p || !sh.date || !sh.time) return { nights: [], sub: 0, pool: 0, tot: 0, down: 0, ex: [] }; const pool = cfg.pool?.mode === "per_head" ? swimmers * (cfg.pool.price || 0) : 0; return finish({ nights: [], short: p, sub: p.price, pool, startMs: phMs(sh.date, sh.time) }); }
    if (!dates.a || !dates.b) return { nights: [], sub: 0, pool: 0, tot: 0, down: 0, ex: [] }; const n = nightsOf(room, dates.a, dates.b); const sub = n.reduce((x, y) => x + y.price, 0); const pool = cfg.pool?.mode === "per_head" ? swimmers * (cfg.pool.price || 0) : 0; return finish({ nights: n, sub, pool, startMs: phMs(dates.a, cfg.checkIn || "14:00") }); };
  const depAmt = room.deposit ?? cfg.deposit?.amount ?? 0;
  const extraLines = (t) => `${(t.ex || []).map((a) => `<div class="c-mini small"><span>${esc(a.name)} × ${a.qty}${a.approval ? " · if available" : ""}</span><span class="amt">${money(a.amount)}</span></div>`).join("")}${t.disc ? `<div class="c-mini small" style="color:var(--ok,#15803d)"><span>🏷️ ${esc(t.disc.name)}</span><span class="amt">−${money(t.disc.amount)}</span></div>` : ""}${t.nd ? `<div class="c-mini small" style="color:var(--ok,#15803d)"><span>⚠️ Room notice ${noticePct}% off</span><span class="amt">−${money(t.nd)}</span></div>` : ""}`;
  const depLine = () => depAmt ? `<div class="c-mini small muted"><span>🔐 Security deposit (refundable, paid separately)</span><span class="amt">${money(depAmt)}</span></div>` : "";
  const draw = () => {
    const t = total();
    if (mode === "short") drawShort();
    body.querySelector("[data-sum]").innerHTML = t.short ? `<div class="c-mini"><span>⏳ ${t.short.hours}-hour stay · ${fmtD(sh.date)} ${fmt12(sh.time)} → ${new Date(phMs(sh.date, sh.time) + t.short.hours * 3600000).toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit" })}</span><span class="amt">${money(t.short.price)}</span></div>
      ${t.pool ? `<div class="c-mini small"><span>Pool · ${swimmers} swimmer${swimmers > 1 ? "s" : ""}</span><span class="amt">${money(t.pool)}</span></div>` : ""}
      ${extraLines(t)}<div class="c-total big"><span>Total</span><span>${money(t.tot)}</span></div>${depLine()}` : t.nights.length ? `<div class="c-mini"><span>${t.nights.length} night${t.nights.length > 1 ? "s" : ""} · ${fmtD(dates.a)} ${fmt12(cfg.checkIn)} → ${fmtD(dates.b)} ${fmt12(cfg.checkOut)}</span></div>
      ${t.nights.map((n) => `<div class="c-mini small"><span>${fmtD(n.date)}${n.special ? " · weekend/holiday" : ""}</span><span class="amt">${money(n.price)}</span></div>`).join("")}
      ${t.pool ? `<div class="c-mini small"><span>Pool · ${swimmers} swimmer${swimmers > 1 ? "s" : ""}</span><span class="amt">${money(t.pool)}</span></div>` : ""}
      ${extraLines(t)}<div class="c-total big"><span>Total</span><span>${money(t.tot)}</span></div>${depLine()}` : "";
    body.querySelector("[data-g]").textContent = guests;
    (cfg.addons || []).forEach((a) => { const q = body.querySelector(`[data-aq="${a.id}"]`); if (q) q.textContent = addq[a.id] || 0; });
    (cfg.amenities || []).forEach((a) => { const q = body.querySelector(`[data-mq="${a.id}"]`); if (q) q.textContent = amq[a.id] || 0; });
    const kq = body.querySelector("[data-k]"); if (kq) kq.textContent = kids;
    const gw = body.querySelector("[data-gids]"); const need = cfg.guestIds ? guests - 1 : 0; void 0;
    if (gw && gw.childElementCount !== need) { const keep = [...gw.querySelectorAll("input[type=file]")].map((i) => i.files?.[0]); gw.innerHTML = false ? `<h3 class="s-step">Valid ID of each guest</h3>${Array.from({ length: need }, (_, i) => `<label>Guest ${i + 2} — valid ID photo</label><input type="file" accept="image/*" data-gid="${i}"/>`).join("")}<div class="small muted">🔒 Seen only by the staff · deleted after 90 days.</div>` : ""; void keep; }
    body.querySelector("[data-pay]").innerHTML = t.tot ? `${store.trust?.newShop ? `<div class="c-alert" style="text-align:left;margin:0 0 6px">🌱 <b>New on TapTayo</b> — to keep you safe, the downpayment is at most ${money(1500)} until this place earns the gold badge. Pay the rest at check-in.</div>` : ""}<div class="c-mini"><span>Downpayment${store.trust?.newShop && t.down >= 1500 ? "" : ` (${cfg.downPct ?? 50}%)`}</span><b>${money(t.down)}</b></div><div class="c-mini small muted"><span>Balance at check-in</span><span>${money(t.tot - t.down)}</span></div>
      ${gcash.length ? `<div class="c-pick" data-pays style="margin-top:8px">${gcash.map((m) => `<button type="button" data-pm="${m.id}" class="${payId === m.id ? "on" : ""}"><b>${esc(m.name)}</b><span>${esc(m.number || "")}${m.accountName ? " · " + esc(m.accountName) : ""}</span></button>`).join("")}</div>
      ${(() => { const m = gcash.find((x) => x.id === payId); return m?.qrUrl ? `<img src="${esc(m.qrUrl)}" alt="QR" style="width:170px;display:block;margin:8px auto;border-radius:10px"/>` : ""; })()}
      <label>Reference number</label><input data-ref placeholder="e.g. 1234 567 890" maxlength="60"/>
      <label>Screenshot of payment (optional)</label><input type="file" accept="image/*" data-proof/>` : `<p class="small muted">Pay the downpayment as instructed by the caretaker on Messenger.</p>`}` : `<p class="muted small">Pick your dates first.</p>`;
    body.querySelectorAll("[data-pm]").forEach((b) => (b.onclick = () => { payId = b.dataset.pm; draw(); }));
    foot.querySelector("[data-ft]").textContent = t.tot ? money(t.tot) : "—";
    foot.querySelector("[data-fdown]").textContent = t.tot && t.down ? `Downpayment ${money(t.down)}` : t.short ? `${t.short.hours} hours` : t.nights.length ? `${t.nights.length} night${t.nights.length > 1 ? "s" : ""}` : "Pick your dates";
  };
  const sc = store.stay?.short || {};
  const drawShort = () => {
    body.querySelectorAll("[data-h]").forEach((b) => b.classList.toggle("on", Number(b.dataset.h) === sh.hours));
    const tw = body.querySelector("[data-times]");
    if (!sh.date) { tw.innerHTML = `<span class="muted small">Pick a date first.</span>`; return; }
    const [fh] = (sc.from || "08:00").split(":").map(Number), [th] = (sc.until || "20:00").split(":").map(Number);
    const opts = [];
    for (let h = fh; h <= th; h++) { const hm = `${String(h).padStart(2, "0")}:00`; const s0 = phMs(sh.date, hm), e0 = s0 + sh.hours * 3600000; const bad = s0 < Date.now() + 20 * 60000 || busy.some(([a, b]) => a < e0 && b > s0); opts.push([hm, bad]); }
    if (sh.time && opts.find((o) => o[0] === sh.time)?.[1]) sh.time = null;
    tw.innerHTML = opts.map(([hm, bad]) => `<button type="button" class="slot ${sh.time === hm ? "on" : ""}" data-tm="${hm}" ${bad ? "disabled" : ""} style="${bad ? "opacity:.35;text-decoration:line-through" : ""}">${fmt12(hm)}</button>`).join("") || `<span class="muted small">No times that day.</span>`;
    tw.querySelectorAll("[data-tm]").forEach((b) => (b.onclick = () => { sh.time = b.dataset.tm; draw(); }));
  };
  body.querySelectorAll("[data-mode]").forEach((b) => (b.onclick = () => { mode = b.dataset.mode; body.querySelectorAll("[data-mode]").forEach((x) => x.classList.toggle("on", x === b)); body.querySelector("[data-cal]").hidden = mode === "short"; body.querySelector("[data-short]").hidden = mode !== "short"; draw(); }));
  body.querySelectorAll("[data-h]").forEach((b) => (b.onclick = () => { sh.hours = Number(b.dataset.h); draw(); }));
  body.querySelector("[data-sdate]")?.addEventListener("change", (e) => { sh.date = e.target.value || null; sh.time = null; draw(); });
  body.querySelectorAll("[data-mp]").forEach((b) => (b.onclick = () => { const a = cfg.amenities.find((x) => x.id === b.dataset.mp); const cap = a?.unit === "head" ? guests + kids : a?.unit === "stay" ? 1 : 24; amq[b.dataset.mp] = Math.min(cap, (amq[b.dataset.mp] || 0) + 1); draw(); }));
  body.querySelectorAll("[data-mm]").forEach((b) => (b.onclick = () => { amq[b.dataset.mm] = Math.max(0, (amq[b.dataset.mm] || 0) - 1); draw(); }));
  body.querySelector("[data-kp]")?.addEventListener("click", () => { if (cfg.kids?.countInPax && guests + kids >= (room.capacity || 20)) return; kids = Math.min(10, kids + 1); draw(); });
  body.querySelector("[data-km]")?.addEventListener("click", () => { kids = Math.max(0, kids - 1); draw(); });
  body.querySelectorAll("[data-ap]").forEach((b) => (b.onclick = () => { const a = cfg.addons.find((x) => x.id === b.dataset.ap); addq[a.id] = Math.min(a.max || 4, (addq[a.id] || 0) + 1); draw(); }));
  body.querySelectorAll("[data-am]").forEach((b) => (b.onclick = () => { addq[b.dataset.am] = Math.max(0, (addq[b.dataset.am] || 0) - 1); draw(); }));
  body.querySelector("[data-gm]").onclick = () => { guests = Math.max(1, guests - 1); swimmers = Math.min(swimmers, guests); draw(); };
  body.querySelector("[data-gp]").onclick = () => { guests = Math.min(room.capacity || 20, guests + 1); draw(); };
  const stepFail = (m) => { body.querySelector("[data-err]").innerHTML = `<div class="c-alert error">${esc(m)}</div>`; };
  foot.querySelector("[data-back]").onclick = () => goStep(step - 1);
  foot.querySelector("[data-fwd]").onclick = () => {
    const t = total();
    if (step === 1 && mode === "short" && (!sh.date || !sh.time || !t.short)) return stepFail("Pick the package, date and check-in time.");
    if (step === 1 && mode !== "short" && (!dates.a || !dates.b)) return stepFail("Pick your check-in and check-out dates.");
    if (step === 2 && cfg.guestIds && [...body.querySelectorAll("[data-gid]")].some((i) => !i.files?.[0])) return stepFail("Please upload a valid ID for each guest.");
    if (step === 3) {
      const name = body.querySelector("[data-name]").value.trim(), phone = body.querySelector("[data-phone]").value.trim();
      if (name.length < 2 || phone.replace(/\D/g, "").length < 7) return stepFail("Enter your full name and phone number.");
      if (gcash.length && t.down > 0 && gcash.some((m) => m.askRefBookings !== false) && (body.querySelector("[data-ref]")?.value.trim() || "").length < 4 && !body.querySelector("[data-proof]")?.files?.[0]) return stepFail("Enter the reference number of your downpayment, or attach the screenshot.");
    }
    goStep(step + 1);
  };
  draw(); goStep(1);
  C.openSheet(room.name, body, foot, "Book your stay");
  try {
    const r = await C.call("getStayCalendar", { slug: C.slug, roomId: room.id });
    busy = r.busy || []; if ((r.blocked || []).length) busy = busy.concat(r.blocked.map((d) => [phMs(d, "00:00"), phMs(d, "00:00") + 86400000]));
    calendar(body.querySelector("[data-cal]"), new Set(r.booked || []), (a, b) => { dates = { a, b }; draw(); });
  } catch (e) { body.querySelector("[data-cal]").innerHTML = `<div class="c-alert error">${esc(e.message)}</div>`; }

  foot.querySelector("[data-go]").onclick = async () => {
    const err = body.querySelector("[data-err]"); err.innerHTML = "";
    const fail = (m) => { const back = /dates|package|check-in time/i.test(m) ? 1 : /valid ID for each guest/i.test(m) ? 2 : /name and phone|reference number/i.test(m) ? 3 : 4; if (back !== step) goStep(back); err.innerHTML = `<div class="c-alert error">${esc(m)}</div>`; err.scrollIntoView({ behavior: "smooth", block: "center" }); };
    const name = body.querySelector("[data-name]").value.trim(), phone = body.querySelector("[data-phone]").value.trim();
    const t = total();
    if (mode === "short" && (!sh.date || !sh.time || !t.short)) return fail("Pick the package, date and check-in time.");
    if (mode !== "short" && (!dates.a || !dates.b)) return fail("Pick your check-in and check-out dates.");
    if (name.length < 2 || phone.replace(/\D/g, "").length < 7) return fail("Enter your full name and phone number.");
    if (gcash.length && t.down > 0 && gcash.some((m) => m.askRefBookings !== false) && (body.querySelector("[data-ref]")?.value.trim() || "").length < 4 && !body.querySelector("[data-proof]")?.files?.[0]) return fail("Enter the reference number of your downpayment, or attach the screenshot.");
    if (!body.querySelector("[data-ok1]").checked || !body.querySelector("[data-ok2]").checked) return fail("Please agree to the house policy and the no-refund policy.");
    const idFile = body.querySelector("[data-id]").files[0]; const noId = !idFile && !!body.querySelector("[data-noid]")?.checked;
    if (false && !idFile && !noId) return fail("Please upload a photo of a valid ID — or tick “I don't have a valid ID”.");
    if ((room.notices || []).length && !body.querySelector("[data-noticeok]")?.checked) return fail("Please read the room notice and tick the box.");
    if (cfg.houseRules && !body.querySelector("[data-rules]")?.checked) return fail("Please accept the house rules.");
    if (ovRate(cfg) && !body.querySelector("[data-ovack]")?.checked) return fail("Please acknowledge the overstay fee.");
    if (pad.isEmpty()) return fail("Please sign inside the box.");
    const gidFiles = [...body.querySelectorAll("[data-gid]")].map((i) => i.files?.[0]);
    if (gidFiles.some((f) => !f)) return fail("Please upload a valid ID for each guest.");
    const btn = foot.querySelector("[data-go]"); btn.disabled = true; btn.querySelector("span").textContent = "Uploading ID & waiver…";
    try {
      const code = "S-" + Array.from({ length: 5 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");
      const uid = C.auth.currentUser.uid;
      const w = await signAndUploadWaiver({ storeId: store.storeId, uid, store, resv: { code, kind: "stay", name, phone, date: mode === "short" ? `${sh.date} · ${sh.hours}-hour stay` : `${dates.a} → ${dates.b}`, time: fmt12(mode === "short" ? sh.time : cfg.checkIn), pax: guests, roomName: room.name, estimate: t.tot, deposit: t.down }, waiverText: `${cfg.policy || ""}\n\n${cfg.waiverText || ""}`.trim(), signerName: name, sigDataUrl: pad.dataUrl(), idFile });
      const guestIds = []; for (const f of gidFiles) guestIds.push(await uploadPrivateImage(store.storeId, uid, f, { max: 1400 }));
      w.guestIds = guestIds;
      let proofUrl = null; const pf = body.querySelector("[data-proof]")?.files?.[0];
      if (pf) proofUrl = await uploadPrivateImage(store.storeId, uid, pf, { max: 1400 });
      btn.querySelector("span").textContent = "Booking…";
      const res = await C.call("bookStay", { slug: C.slug, code, roomId: room.id, overstayAck: !!body.querySelector("[data-ovack]")?.checked, ...(mode === "short" ? { checkIn: sh.date, shortHours: sh.hours, startTime: sh.time } : { checkIn: dates.a, checkOut: dates.b }), guests, adults: guests, kids, noId, noticeAck: !!body.querySelector("[data-noticeok]")?.checked, rulesAck: !!body.querySelector("[data-rules]")?.checked, amenities: Object.entries(amq).filter(([, q]) => q > 0).map(([id, qty]) => ({ id, qty, hours: qty })), poolGuests: swimmers, addons: Object.entries(addq).filter(([, q]) => q > 0).map(([id, qty]) => ({ id, qty })), request: body.querySelector("[data-req]").value.trim(), customer: { name, phone, messenger: readMsgr(body) }, policyAccepted: true, noRefundAccepted: true, waiver: w, payment: payId ? { methodId: payId, refNo: body.querySelector("[data-ref]")?.value.trim() || "", proofUrl } : null });
      C.saveLocal({ customer: { ...(C.loadLocal().customer || {}), name, phone, messenger: readMsgr(body) }, lastStay: { id: res.id, storeId: res.storeId, at: Date.now() } });
      C.closeSheet(); renderStatus({ id: res.id, storeId: res.storeId });
    } catch (e) { console.error(e); fail(e.message || "Couldn't book. Please try again."); btn.disabled = false; btn.querySelector("span").textContent = "Book"; }
  };
}

// ---------------- STATUS ----------------
const STEPS = [["unconfirmed", "Message us on Messenger"], ["pending", "Waiting for the caretaker"], ["confirmed", "Confirmed"], ["checked_in", "Checked in"], ["checked_out", "Checked out"]];
function renderStatus(rec) {
  view = "status"; stayUnsub?.(); clearInterval(tickTimer);
  const { esc, html, money } = C;
  C.app.innerHTML = `<div class="c-status"><div class="c-loading" style="min-height:40vh"><div class="c-spinner"></div></div></div>`;
  stayUnsub = onSnapshot(doc(C.db, "stores", rec.storeId, "stays", rec.id), (snap) => {
    if (!snap.exists()) { C.saveLocal({ lastStay: null }); return renderHome(); }
    const s = snap.data();
    const cfg = store.stay || {};
    const over = ["cancelled", "declined"].includes(s.status);
    const finished = ["checked_out", "done"].includes(s.status);
    // keep the booking on this phone until a day after check-out
    if ((over || finished) && Date.now() - (s.checkOut?.toMillis?.() || 0) > 86400000) C.saveLocal({ lastStay: null });
    const steps = s.needsConfirm ? STEPS : STEPS.slice(1);
    const st = s.status === "done" ? "checked_out" : s.status;
    const idx = Math.max(0, steps.findIndex((x) => x[0] === st));
    const balance = Math.max(0, (s.total || 0) - (s.paidAmount || 0));
    const reqs = s.requests || [];
    const canResched = ["unconfirmed", "pending", "confirmed"].includes(s.status) && s.reschedule?.status !== "pending";
    C.app.innerHTML = "";
    const root = html(`<div class="c-page s-page"><div class="s-topbar"><button class="s-back" data-rooms>‹ Rooms</button><b>${esc(store.name)}</b></div>
      <div class="c-status">
        <div class="c-ticket main">
          <div class="eyebrow">Booking</div><div class="c-orderno" style="font-size:2.2rem">${esc(s.code)}</div>
          <div class="c-when">🏡 ${esc(s.roomName)} · 👥 ${s.guests}</div>
          ${s.short ? `<div class="c-when">⏳ ${s.short.hours}-hour stay</div>` : ""}
          <div class="c-when">${fmtD(s.checkInYmd)} ${s.short ? fmt12(s.short.startTime) : fmt12(cfg.checkIn)} → ${fmtD(s.checkOutYmd)} ${s.checkOut?.toDate ? s.checkOut.toDate().toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" }) : fmt12(cfg.checkOut)}</div>
          ${over ? `<div class="c-cancel">${s.status === "declined" ? "Declined" : "Cancelled"}</div><p class="muted">${esc(s.cancelReason || "")}</p>` : `
          <div class="s-count" data-cd></div>
          ${s.status === "unconfirmed" ? `<div class="c-alert warn" style="text-align:left;margin-top:10px"><b>Message us on Messenger</b> to confirm — within <b data-dl></b>, or the booking is cancelled automatically.</div><button class="c-btn brand block" data-msgr>💬 Message us on Messenger</button>` : ""}
          <div class="c-timeline">${steps.map((x, i) => `<div class="c-tl ${i <= idx ? "on" : ""} ${i === idx ? "now" : ""}"><div><div class="dot"></div>${i < steps.length - 1 ? `<div class="line"></div>` : ""}</div><div class="lab">${esc(x[1])}</div></div>`).join("")}</div>`}
        </div>
        ${stayExtrasHTML(s, rec)}
        ${!over ? `<div class="c-actions">
          ${s.status === "checked_in" ? `<button class="c-bigbtn" data-out><span class="ic">🚪</span><span><b>I've checked out</b><small>Tap when you leave so we can clean the room</small></span></button>` : ""}
          ${!finished ? `<button class="c-bigbtn alt" data-req><span class="ic">🙋</span><span><b>Make a request</b><small>Towels, extra bed, swimming, late check-out…</small></span></button>` : ""}
          ${s.status === "checked_in" && cfg.extension?.enabled ? `<button class="c-bigbtn alt" data-ext><span class="ic">⏱</span><span><b>Extend my stay</b><small>${money(cfg.extension.pricePerHour)} per hour · if the room is free after you</small></span></button>` : ""}
          ${canResched ? `<button class="c-bigbtn alt" data-res><span class="ic">📅</span><span><b>Reschedule</b><small>Pick new dates — the caretaker approves</small></span></button>` : ""}
        </div>` : ""}
        ${s.reschedule ? `<div class="c-ticket"><div class="eyebrow">Reschedule</div><div>${fmtD(s.reschedule.checkIn)} → ${fmtD(s.reschedule.checkOut)}</div><span class="pill ${s.reschedule.status === "approved" ? "ok" : s.reschedule.status === "declined" ? "" : "wait"}">${s.reschedule.status}</span>${s.reschedule.reply ? `<div class="small muted">${esc(s.reschedule.reply)}</div>` : ""}</div>` : ""}
        ${s.extension ? `<div class="c-ticket"><div class="eyebrow">Extension</div><div>+${s.extension.hours} h · ${money(s.extension.price)}</div><span class="pill ${s.extension.status === "approved" ? "ok" : s.extension.status === "declined" ? "" : "wait"}">${s.extension.status}</span>${s.extension.reason ? `<div class="small muted">${esc(s.extension.reason)}</div>` : ""}</div>` : ""}
        ${reqs.length ? `<div class="c-ticket"><div class="eyebrow">Your requests</div>${reqs.map((r) => `<div class="s-req"><div><b>${esc(r.type)}</b> · ${esc(r.text)}${r.reply ? `<div class="small muted">↳ ${esc(r.reply)}</div>` : ""}</div><span class="pill ${r.status === "approved" ? "ok" : r.status === "declined" ? "" : "wait"}">${r.status === "approved" && r.price ? money(r.price) : r.status}</span></div>`).join("")}</div>` : ""}
        <div class="c-ticket">
          ${s.short ? `<div class="c-mini"><span>⏳ ${s.short.hours}-hour package</span><span class="amt">${money(s.subtotal)}</span></div>` : ""}
          ${(s.nights || []).length ? `<div class="c-mini"><span>${s.nightsCount} night${s.nightsCount > 1 ? "s" : ""}</span><span class="amt">${money(s.subtotal)}</span></div>` : ""}
          ${s.poolFee ? `<div class="c-mini"><span>Pool · ${s.poolGuests} swimmer${s.poolGuests > 1 ? "s" : ""}</span><span class="amt">${money(s.poolFee)}</span></div>` : ""}
          ${(s.addons || []).map((a) => `<div class="c-mini"><span>${esc(a.name)} × ${a.qty} <span class="pill ${a.status === "approved" ? "ok" : a.status === "declined" ? "" : "wait"}">${a.status === "approved" ? "ok" : a.status === "declined" ? "not available" : "checking"}</span></span><span class="amt" style="${a.status === "declined" ? "text-decoration:line-through;opacity:.5" : ""}">${money(a.amount)}</span></div>`).join("")}
          ${(s.charges || []).map((c) => `<div class="c-mini"><span>${esc(c.label)}</span><span class="amt">${money(c.amount)}</span></div>`).join("")}
          ${s.discount ? `<div class="c-mini" style="color:#15803d"><span>${s.discount.kind === "loyalty" ? "🎁" : "🏷️"} ${esc(s.discount.name)}</span><span class="amt">−${money(s.discount.amount)}</span></div>` : ""}
          <div class="c-total big"><span>Total</span><span>${money(s.total)}</span></div>
          <div class="c-mini"><span>Paid</span><span class="amt">${money(s.paidAmount || 0)}${s.payment?.status === "to_verify" ? " · downpayment being checked" : ""}</span></div>
          <div class="c-mini"><span><b>Balance</b></span><span class="amt"><b>${money(balance)}</b></span></div>
        </div>
        ${finished && store.feedback?.enabled !== false ? (s.rating ? `<div class="c-ticket main"><div class="eyebrow">Your rating</div><div style="font-size:1.6rem;color:var(--accent)">${"★".repeat(s.rating)}</div><div class="muted small">Thank you for staying with us!</div></div>` : `<div class="c-ticket main"><div class="eyebrow">How was your stay?</div><div class="c-stars">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-star="${n}">★</button>`).join("")}</div></div>`) : ""}
        ${(s.paidAmount || 0) > 0 || ["checked_in", "checked_out", "done"].includes(s.status) ? `<button class="c-btn ghost block" data-stayreceipt style="margin-bottom:10px">🧾 View receipt</button>` : ""}
        ${store.stay?.reminders && ["pending", "confirmed"].includes(s.status) ? `<label class="c-agree small" style="margin:0 0 10px"><input type="checkbox" data-nosms ${s.noSms ? "checked" : ""}/> 🔕 Don't text me a reminder before check-in</label>` : ""}
        <p class="muted small" style="text-align:center">🔒 No refund · reschedule with approval. This page updates on its own and stays on this phone.</p>
      </div></div>`);
    C.app.appendChild(root);
    root.querySelector("[data-rooms]").onclick = () => { stayUnsub?.(); renderHome(); };
    bindStayExtras(root, rec, s);
    root.querySelector("[data-nosms]")?.addEventListener("change", async (e) => { try { await C.call("reminderOptOut", { storeId: rec.storeId, kind: "stay", id: rec.id, off: e.target.checked }); C.toast(e.target.checked ? "OK — no SMS reminders" : "Reminders on"); } catch (x) { e.target.checked = !e.target.checked; C.toast(x.message); } });
    root.querySelector("[data-stayreceipt]")?.addEventListener("click", () => { const r = stayReceiptData(s); C.openSheet("Receipt", C.html(receiptHTML(store, r)), receiptFoot(C.html, store, r), s.code || ""); });
    root.querySelector("[data-out]")?.addEventListener("click", async () => { if (!confirmBox(`Check out now?\n\nTap only when you have LEFT the room — the cleaner comes to check it.${s.deposit?.amount ? " Your deposit is returned after the room check." : ""}\nIf you're found still inside, overstay is charged.`)) return; try { await C.call("stayGuestAction", { storeId: rec.storeId, id: rec.id, action: "checkout" }); C.toast("Thank you! Safe travels 👋"); } catch (e) { C.toast(e.message); } });
    root.querySelector("[data-req]")?.addEventListener("click", () => openRequest(rec));
    root.querySelector("[data-ext]")?.addEventListener("click", () => openExtend(rec));
    root.querySelector("[data-res]")?.addEventListener("click", () => openResched(rec, s));
    root.querySelector("[data-msgr]")?.addEventListener("click", async () => {
      const msg = `Hi! Booking ${s.code} — ${s.customer?.name || ""}, ${s.customer?.phone || ""}. ${s.roomName}, ${s.checkInYmd} to ${s.checkOutYmd}, ${s.guests} guest(s). Total ${money(s.total)}${s.payment?.refNo ? `, downpayment ref ${s.payment.refNo}` : ""}. Please confirm. Thank you!`;
      try { await navigator.clipboard.writeText(msg); C.toast("Message copied — paste it in Messenger"); } catch {}
      const link = store.confirm?.messengerLink || ""; if (link) setTimeout(() => window.open(link.startsWith("http") ? link : "https://" + link, "_blank"), 600);
    });
    root.querySelectorAll("[data-star]").forEach((b) => (b.onclick = () => openRate(rec, s, Number(b.dataset.star))));
    const tick = () => {
      const el = root.querySelector("[data-cd]"); if (!el) return;
      const now = Date.now(), ci = s.checkIn?.toMillis?.() || 0, co = s.checkOut?.toMillis?.() || 0;
      el.innerHTML = s.status === "checked_in" ? (co > now ? `<span>Check-out in</span><b>${dur(co - now)}</b>` : `<span>Check-out time</span><b>now</b>`) : ["confirmed", "pending", "unconfirmed"].includes(s.status) ? `<span>Check-in in</span><b>${dur(ci - now)}</b>` : finished ? `<span>Thank you for staying!</span>` : "";
      const dc = root.querySelector("[data-depcd]"); if (dc && s.deposit?.checkBy) { const l = Math.max(0, s.deposit.checkBy - now); dc.textContent = `${Math.floor(l / 60000)}:${String(Math.floor((l % 60000) / 1000)).padStart(2, "0")}`; }
      const dl = root.querySelector("[data-dl]"); if (dl && s.confirmDeadline?.toMillis) { const l = Math.max(0, s.confirmDeadline.toMillis() - now); dl.textContent = `${Math.floor(l / 60000)}:${String(Math.floor((l % 60000) / 1000)).padStart(2, "0")}`; }
    };
    tick(); clearInterval(tickTimer); tickTimer = setInterval(tick, 1000);
  }, () => { C.saveLocal({ lastStay: null }); renderHome(); });
}
const confirmBox = (m) => window.confirm(m);

function openRequest(rec) {
  const { html } = C;
  let type = REQ_TYPES[0];
  const body = html(`<div><div class="c-chips" data-types>${REQ_TYPES.map((t, i) => `<button type="button" class="chip ${i === 0 ? "on" : ""}" data-t="${t}">${t}</button>`).join("")}</div>
    <label>Details</label><textarea data-x rows="3" maxlength="300" placeholder="e.g. 2 extra towels, swimming for 4 people at 3 PM"></textarea>
    <p class="small muted">The caretaker checks if it's available and replies here. Some requests may have a fee.</p><div data-err></div></div>`);
  body.querySelectorAll("[data-t]").forEach((b) => (b.onclick = () => { type = b.dataset.t; body.querySelectorAll("[data-t]").forEach((x) => x.classList.toggle("on", x === b)); }));
  const foot = html(`<div><button class="c-btn brand block" data-send>Send request</button></div>`);
  foot.querySelector("[data-send]").onclick = async () => { try { await C.call("stayGuestAction", { storeId: rec.storeId, id: rec.id, action: "request", type, text: body.querySelector("[data-x]").value.trim() || type }); C.closeSheet(); C.toast("Request sent ✓"); } catch (e) { body.querySelector("[data-err]").innerHTML = `<div class="c-alert error">${C.esc(e.message)}</div>`; } };
  C.openSheet("Make a request", body, foot);
}
function openExtend(rec) {
  const { html, money } = C; const cfg = store.stay?.extension || {};
  let hours = 1;
  const body = html(`<div><p>How many extra hours?</p><div class="row between"><span data-h>1 hour</span><div class="c-qty"><button type="button" data-m>−</button><span data-n>1</span><button type="button" data-p>+</button></div></div>
    <div class="c-total big" style="margin-top:10px"><span>Extension fee</span><span data-f>${money(cfg.pricePerHour)}</span></div>
    <p class="small muted">If another guest is booked right after you, the extension is declined automatically.</p><div data-err></div></div>`);
  const upd = () => { body.querySelector("[data-n]").textContent = hours; body.querySelector("[data-h]").textContent = `${hours} hour${hours > 1 ? "s" : ""}`; body.querySelector("[data-f]").textContent = money(hours * (cfg.pricePerHour || 0)); };
  body.querySelector("[data-m]").onclick = () => { hours = Math.max(1, hours - 1); upd(); };
  body.querySelector("[data-p]").onclick = () => { hours = Math.min(cfg.maxHours || 6, hours + 1); upd(); };
  const foot = html(`<div><button class="c-btn brand block" data-send>Request extension</button></div>`);
  foot.querySelector("[data-send]").onclick = async () => { try { const r = await C.call("stayGuestAction", { storeId: rec.storeId, id: rec.id, action: "extend", hours }); C.closeSheet(); C.toast(r.declined ? r.reason : "Extension requested — waiting for the caretaker"); } catch (e) { body.querySelector("[data-err]").innerHTML = `<div class="c-alert error">${C.esc(e.message)}</div>`; } };
  C.openSheet("Extend my stay", body, foot);
}
async function openResched(rec, s) {
  const { html } = C;
  let dates = { a: null, b: null };
  const body = html(`<div><p class="small muted">Current: ${fmtD(s.checkInYmd)} → ${fmtD(s.checkOutYmd)}. Pick new dates — the caretaker will approve.</p><div data-cal><p class="muted small">Loading…</p></div><div data-err></div></div>`);
  const foot = html(`<div><button class="c-btn brand block" data-send disabled>Request new dates</button></div>`);
  C.openSheet("Reschedule", body, foot);
  try {
    const r = await C.call("getStayCalendar", { slug: C.slug, roomId: s.roomId });
    // my own nights don't block me
    const mine = new Set(); let d = s.checkInYmd; while (d < s.checkOutYmd) { mine.add(d); d = addDays(d, 1); }
    calendar(body.querySelector("[data-cal]"), new Set((r.booked || []).filter((x) => !mine.has(x))), (a, b) => { dates = { a, b }; foot.querySelector("[data-send]").disabled = !(a && b); });
  } catch (e) { body.querySelector("[data-cal]").innerHTML = `<div class="c-alert error">${C.esc(e.message)}</div>`; }
  foot.querySelector("[data-send]").onclick = async () => { try { await C.call("stayGuestAction", { storeId: rec.storeId, id: rec.id, action: "reschedule", checkIn: dates.a, checkOut: dates.b }); C.closeSheet(); C.toast("Reschedule requested ✓"); } catch (e) { body.querySelector("[data-err]").innerHTML = `<div class="c-alert error">${C.esc(e.message)}</div>`; } };
}
function openRate(rec, s, initial) {
  const { html } = C; let rating = initial;
  const RR = rateRows("stay", initial);
  const body = html(`<div>${RR.html}<label>Comment (optional)</label><textarea data-c rows="3" maxlength="500" placeholder="How was the room, the place, the caretaker?"></textarea><div data-err></div></div>`);
  RR.bind(body); void rating;
  const foot = html(`<div><button class="c-btn brand block" data-send>Submit</button></div>`);
  foot.querySelector("[data-send]").onclick = async () => { try { if (!RR.complete()) return C.toast("Please rate each one (tap the stars)."); await C.call("submitFeedback", { storeId: rec.storeId, orderId: rec.id, kind: "stay", cats: RR.R, comment: body.querySelector("[data-c]").value.trim() }); C.closeSheet(); C.toast("Thank you for your review! ⭐"); if (RR.avg() >= 5 && store.reviewUrl && confirm("So happy you loved it! Share a quick Google review? It really helps us.")) window.open(store.reviewUrl, "_blank"); } catch (e) { body.querySelector("[data-err]").innerHTML = `<div class="c-alert error">${C.esc(e.message)}</div>`; } };
  C.openSheet("Rate your stay", body, foot, s.code);
}

const ovRate = (cfg) => (cfg?.overstay?.enabled === false ? 0 : Number(cfg?.overstay?.ratePerHour) || Number(cfg?.extension?.pricePerHour) || 0);
// ---------- door code · item list · security deposit · overstay (guest status) ----------
const DEP = { due: ["Pay the deposit", "wait"], to_verify: ["Being checked", "wait"], rejected: ["Payment not found", ""], held: ["Held", "ok"], checking: ["Waiting for room check", "wait"], checked: ["Room checked", "ok"], released: ["Returned", "ok"] };
function stayExtrasHTML(s, rec) {
  const { esc, money } = C; const cfg = store.stay || {}; const t12 = (ms) => new Date(ms).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" });
  const out = [];
  if (s.roomState && cfg.cleaning?.showGuests !== false && ["confirmed", "pending", "unconfirmed"].includes(s.status)) { const R = s.roomState; out.push(R.status === "ready" ? `<div class="c-alert ok" style="text-align:left">✅ <b>Your room is clean and ready</b> · since ${t12(R.at)}</div>` : `<div class="c-alert" style="text-align:left">🧹 <b>Your room is ${R.status === "cleaning" ? "being cleaned" : "waiting to be cleaned"}</b>${R.eta ? ` · ready around ${t12(R.eta)}` : ""}. We'll show it here when it's ready.</div>`); }
  if (s.status === "checked_in" && s.overstay?.hours) out.push(`<div class="c-alert error" style="text-align:left">⏰ <b>You're ${s.overstay.hours} h past check-out.</b> Overstay is ${money(ovRate(cfg))} per hour (${money(s.overstay.amount || 0)} so far)${s.deposit?.amount ? ", taken from your deposit" : ""}. Tap <b>I've checked out</b> when you leave.</div>`);
  if (s.stillInsideAt && s.status === "checked_in") out.push(`<div class="c-alert warn" style="text-align:left">🧹 The cleaner found the room still occupied after you tapped "checked out". Overstay continues until you leave.</div>`);
  const doorOn = ["confirmed", "checked_in"].includes(s.status);
  if (doorOn && (cfg.selfCheck || (store.rooms || []).find((r) => r.id === s.roomId)?.selfDoor)) out.push(`<div class="c-ticket"><div class="eyebrow">🔑 ${cfg.selfCheck ? "Self check-in" : "Door code"}</div><div data-door><button class="c-btn brand block" data-showcode>Show my door code</button></div>${cfg.selfCheck && s.status === "confirmed" ? `<button class="c-btn ghost block" data-selfin style="margin-top:8px">🛎 I'm here — check me in</button>` : ""}<div class="small muted" style="margin-top:6px">The code shows when your booking is confirmed and paid, ${cfg.codeHoursBefore ?? 2} hours before check-in.</div></div>`);
  if ((s.inventory || []).length && ["confirmed", "checked_in", "checked_out", "done"].includes(s.status)) out.push(`<details class="c-ticket" ${!s.inventoryAck && doorOn ? "open" : ""}><summary class="eyebrow" style="cursor:pointer">📋 Items in your room ${s.inventoryAck ? "· confirmed ✓" : ""}</summary><div style="margin-top:8px">${s.inventory.map((i) => `<div class="c-mini"><span>${esc(i.name)}</span><span class="amt">× ${i.qty}${i.price ? ` <span class="muted small">(${money(i.price)} if missing)</span>` : ""}</span></div>`).join("")}</div>${!s.inventoryAck && doorOn ? `<button class="c-btn brand block" data-ack style="margin-top:8px">✓ I've checked — all items are here</button><div class="small muted" style="margin-top:4px">Something missing or damaged already? Make a request with a note before you confirm.</div>` : `<div class="small muted" style="margin-top:6px">These are counted again at check-out.</div>`}</details>`);
  const d = s.deposit;
  if (d?.amount) {
    const [lab, pill] = DEP[d.status] || [d.status, ""]; const pays = (store.payments || []).filter((m) => m.type !== "cash" && m.type !== "card");
    let body = "";
    if (["due", "rejected"].includes(d.status) && !["cancelled", "declined", "checked_out", "done"].includes(s.status)) body = `${d.status === "rejected" ? `<div class="c-alert error">${esc(d.reason || "We couldn't find that payment.")}</div>` : ""}<p class="small">Refundable — returned after the room is checked at check-out.${cfg.selfCheck ? " Needed before your door code shows." : ""}</p>${pays.length ? `<div class="c-pick" data-dpays>${pays.map((m, i) => `<button type="button" data-dpm="${m.id}" class="${i ? "" : "on"}"><b>${esc(m.name)}</b><span>${esc(m.number || "")}${m.accountName ? " · " + esc(m.accountName) : ""}</span></button>`).join("")}</div><label>Reference number</label><input data-dref maxlength="60" placeholder="e.g. 1234 567 890"/><button class="c-btn brand block" data-dsend style="margin-top:8px">Send deposit details</button>` : `<p class="small muted">Pay the deposit to the caretaker at check-in.</p>`}`;
    else if (d.status === "to_verify") body = `<p class="small">Ref ${esc(d.payment?.refNo || "")} · the caretaker is checking it.</p>`;
    else if (d.status === "held") body = `<p class="small">Returned after the room check at check-out.</p>`;
    else if (d.status === "checking") body = `<div style="text-align:center;margin:8px 0"><div class="small muted">🔍 The cleaner is checking the room — before</div><div style="font-size:1.6rem;font-weight:800">${t12(d.checkBy)}</div><div style="font-size:1.1rem;font-weight:700;color:var(--primary)">⏳ <span data-depcd></span> left</div></div><p class="small" style="text-align:center">If it isn't checked in time, your full deposit is returned.</p>`;
    else if (["checked", "released"].includes(d.status)) body = `${d.autoNoIssues ? `<p class="small">Not checked in time — full refund.</p>` : (d.deductions || []).length ? `<div class="small muted" style="margin:4px 0">Deductions (with photo proof):</div>${d.deductions.map((x) => `<div class="c-mini"><span>${esc(x.label)}${x.photo ? `<br><img data-priv="${esc(x.photo)}" data-priv-order="${esc(rec.id)}" alt="" style="width:96px;height:72px;object-fit:cover;border-radius:8px;margin-top:4px;cursor:zoom-in" onclick="this.src&&window.open(this.src,'_blank')"/>` : ""}</span><span class="amt">−${money(x.amount)}</span></div>`).join("")}` : `<p class="small">✅ No issues found — thank you!</p>`}<div class="c-total"><span>${d.status === "released" ? "Returned" : "To be returned"}</span><span>${money(d.refund ?? d.amount)}</span></div>${d.owed ? `<div class="c-alert error">Still owed: ${money(d.owed)}</div>` : ""}${d.status === "released" ? `<div class="small muted">${esc(d.releaseMethod || "")}${d.releaseRef ? ` · ref ${esc(d.releaseRef)}` : ""}</div>` : `<div class="small muted">The caretaker sends it back to you.</div>`}
      ${d.dispute ? `<div class="c-alert ${d.dispute.status === "open" ? "warn" : d.dispute.status === "accepted" ? "ok" : "error"}" style="text-align:left;margin-top:8px">⚖️ <b>Dispute ${d.dispute.status === "open" ? "sent — the owner is reviewing" : d.dispute.status === "accepted" ? `accepted · ${money(d.dispute.back || 0)} back to you` : "not accepted"}</b>${d.dispute.reply ? `<br><span class="small">${esc(d.dispute.reply)}</span>` : ""}${d.dispute.status === "rejected" ? `<br><button class="c-linkbtn" data-escalate>Still not fair? Chat with TapTayo</button>` : ""}</div>`
        : (d.deductions || []).length && (d.checkedAt || 0) > Date.now() - 48 * 3600000 ? `<button class="c-btn ghost block" data-dispute style="margin-top:8px">⚖️ Dispute a deduction</button><div class="small muted" style="text-align:center">Within 48 hours of the room check</div>` : ""}`;
    out.push(`<div class="c-ticket"><div class="eyebrow">🔐 Security deposit · ${money(d.amount)} <span class="pill ${pill}">${esc(lab)}</span></div>${body}</div>`);
  }
  if (s.needsIdOk && ["unconfirmed", "pending"].includes(s.status)) out.push(`<div class="c-alert warn" style="text-align:left">🪪 You booked without a valid ID — the owner is checking if that's OK.</div>`);
  if (s.short && cfg.short?.timerOnArrival !== false && ["confirmed", "pending"].includes(s.status)) out.push(`<div class="c-alert" style="text-align:left">⏱ Your ${s.short.hours} hour${s.short.hours > 1 ? "s" : ""} start when you're in the room — at the latest ${new Date(s.checkIn.toMillis() + (cfg.short?.graceMin ?? 15) * 60000).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}.</div>`);
  (s.moves || []).slice(-1).forEach((m) => out.push(`<div class="c-alert ok" style="text-align:left">🔁 Moved from ${esc(m.from)} to <b>${esc(m.to)}</b>${m.diff > 0 ? ` · +${money(m.diff)}` : m.diff < 0 ? ` · ${money(-m.diff)} refund` : ""}</div>`));
  if (s.refund && s.refund.status !== "none") out.push(`<div class="c-ticket"><div class="eyebrow">↩️ Refund · ${money(s.refund.amount)} <span class="pill ${s.refund.status === "sent" ? "ok" : "wait"}">${s.refund.status === "sent" ? "sent" : "to be sent"}</span></div><div class="small">${esc(s.refund.reason || "")}${s.refund.status === "sent" ? ` · ${esc(s.refund.method || "")}${s.refund.ref ? ` ref ${esc(s.refund.ref)}` : ""}` : ""}</div></div>`);
  if (s.roomChange?.status === "pending") out.push(`<div class="c-alert" style="text-align:left">🔁 Room change requested — waiting for the caretaker.</div>`);
  if (s.roomChange?.status === "declined") out.push(`<div class="c-alert warn" style="text-align:left">🔁 Room change: ${esc(s.roomChange.reply || "not available")}</div>`);
  (s.issues || []).forEach((x) => out.push(`<div class="c-mini small"><span>🛠 ${esc(x.text)}${x.reply ? `<br><span class="muted">↳ ${esc(x.reply)}</span>` : ""}</span><span class="pill ${x.status === "fixed" ? "ok" : "wait"}">${x.status === "fixed" ? "fixed" : x.status === "seen" ? "seen" : "sent"}</span></div>`));
  if (cfg.visitorLog && ["confirmed", "checked_in"].includes(s.status)) out.push(`<details class="c-ticket"><summary class="eyebrow" style="cursor:pointer">👥 Visitors (${(s.visitors || []).length})</summary>${(s.visitors || []).map((v) => `<div class="c-mini small"><span>${esc(v.name)} × ${v.count}</span><span>${esc(v.until || "")}</span></div>`).join("")}<div class="row" style="gap:6px;margin-top:8px"><input data-vname placeholder="Visitor name" style="flex:2"/><input data-vcount type="number" min="1" value="1" style="flex:1"/><input data-vuntil placeholder="until e.g. 9 PM" style="flex:1.5"/></div><button class="c-btn ghost block" data-vadd style="margin-top:6px">Add visitor</button><div class="small muted">House rules apply to visitors too.</div></details>`);
  const live = ["confirmed", "checked_in"].includes(s.status);
  if (live) out.push(`<div class="c-actions"><button class="c-bigbtn alt" data-issue><span class="ic">🛠</span><span><b>Report a problem</b><small>Something broken? Send a photo — proof it wasn't you</small></span></button>${(store.rooms || []).length > 1 ? `<button class="c-bigbtn alt" data-move><span class="ic">🔁</span><span><b>Change room</b><small>Ask to move — the price follows the room</small></span></button>` : ""}</div>`);
  if (["unconfirmed", "pending", "confirmed"].includes(s.status)) out.push(`<button class="c-btn ghost block" data-cxl style="margin-bottom:10px">Cancel booking</button>`);
  if (s.visitNo && store.stay?.loyalty?.enabled) { const L = store.stay.loyalty; const n = ((s.visitNo - 1) % L.every) + 1; out.push(`<div class="c-ticket"><div class="eyebrow">🎁 Loyalty card</div><div style="font-size:1.4rem;letter-spacing:4px">${Array.from({ length: L.every }, (_, i) => (i < n ? "●" : "○")).join("")}</div><div class="small muted">Stay #${s.visitNo} · every ${L.every}th stay is ${L.percent}% off</div></div>`); }
  return out.join("");
}
function bindStayExtras(root, rec, s) {
  const act = (body) => C.call("stayGuestAction", { storeId: rec.storeId, id: rec.id, ...body });
  root.querySelector("[data-showcode]")?.addEventListener("click", async (e) => { e.target.disabled = true; try { const r = await act({ action: "passcode" }); root.querySelector("[data-door]").innerHTML = `<div class="c-orderno" style="font-size:2.4rem;letter-spacing:.12em">${C.esc(r.code)}</div>${r.note ? `<p class="small">${C.esc(r.note)}</p>` : ""}<div class="small muted">Valid until check-out · ${new Date(r.until).toLocaleString("en-PH", { weekday: "short", hour: "numeric", minute: "2-digit" })}</div>`; } catch (x) { C.toast(x.message); e.target.disabled = false; } });
  root.querySelector("[data-selfin]")?.addEventListener("click", async (e) => { e.target.disabled = true; try { await act({ action: "selfCheckin" }); C.toast("Checked in — enjoy your stay!"); } catch (x) { C.toast(x.message); e.target.disabled = false; } });
  root.querySelector("[data-ack]")?.addEventListener("click", async (e) => { e.target.disabled = true; try { await act({ action: "ack" }); } catch (x) { C.toast(x.message); e.target.disabled = false; } });
  root.querySelectorAll("[data-dpm]").forEach((b) => (b.onclick = () => root.querySelectorAll("[data-dpm]").forEach((x) => x.classList.toggle("on", x === b))));
  root.querySelector("[data-dsend]")?.addEventListener("click", async (e) => { const m = root.querySelector("[data-dpm].on")?.dataset.dpm; e.target.disabled = true; try { await act({ action: "payDeposit", methodId: m, refNo: root.querySelector("[data-dref]").value.trim() }); C.toast("Sent — the caretaker will check it"); } catch (x) { C.toast(x.message); e.target.disabled = false; } });
  root.querySelector("[data-vadd]")?.addEventListener("click", async (e) => { e.target.disabled = true; try { await act({ action: "visitor", name: root.querySelector("[data-vname]").value, count: root.querySelector("[data-vcount]").value, until: root.querySelector("[data-vuntil]").value }); C.toast("Visitor added"); } catch (x) { C.toast(x.message); } e.target.disabled = false; });
  root.querySelector("[data-issue]")?.addEventListener("click", () => {
    const body = C.html(`<div><label>What's the problem?</label><textarea data-t rows="3" maxlength="300" placeholder="e.g. The toilet flush is broken"></textarea><label>Photo</label><input type="file" accept="image/*" capture="environment" data-p/><p class="small muted">Reported problems are not charged to your deposit.</p></div>`);
    const foot = C.html(`<div><button class="c-btn brand block">Send</button></div>`);
    foot.querySelector("button").onclick = async (e) => { e.target.disabled = true; try { const f = body.querySelector("[data-p]").files?.[0]; const photo = f ? await uploadPrivateImage(rec.storeId, C.auth.currentUser.uid, f, { max: 1280 }) : ""; await act({ action: "issue", text: body.querySelector("[data-t]").value, photo }); C.closeSheet(); C.toast("Sent — the caretaker is on it"); } catch (x) { C.toast(x.message); e.target.disabled = false; } };
    C.openSheet("Report a problem", body, foot, s.code);
  });
  root.querySelector("[data-move]")?.addEventListener("click", () => {
    const others = (store.rooms || []).filter((r) => r.id !== s.roomId && (r.capacity || 20) >= (s.guests || 1));
    const body = C.html(`<div><label>Move to</label><select data-r><option value="">Any room that's free</option>${others.map((r) => `<option value="${r.id}">${C.esc(r.name)} · ${C.money(r.price)}/night</option>`).join("")}</select><label>Why? (optional)</label><textarea data-w rows="2" maxlength="200" placeholder="e.g. Aircon is too weak"></textarea><p class="small muted">If the new room costs more you pay the difference; if it costs less you get the difference back.</p></div>`);
    const foot = C.html(`<div><button class="c-btn brand block">Send request</button></div>`);
    foot.querySelector("button").onclick = async (e) => { e.target.disabled = true; try { await act({ action: "roomChange", roomId: body.querySelector("[data-r]").value, reason: body.querySelector("[data-w]").value }); C.closeSheet(); C.toast("Sent — the caretaker will check"); } catch (x) { C.toast(x.message); e.target.disabled = false; } };
    C.openSheet("Change room", body, foot, s.code);
  });
  root.querySelector("[data-cxl]")?.addEventListener("click", async () => {
    const pol = s.cancelPolicy || store.stay?.cancel || {}; const days = (s.checkIn.toMillis() - Date.now()) / 86400000;
    const pct = pol.fullDays && days >= pol.fullDays ? 100 : pol.partialDays && days >= pol.partialDays ? pol.partialPct : 0;
    if (!confirm(`Cancel this booking?\n\nRefund: ${pct}% of what you paid (${C.money(((s.paidAmount || 0) * pct) / 100)}).${s.deposit?.status === "held" ? "\nYour security deposit is returned in full." : ""}`)) return;
    try { await act({ action: "cancel" }); C.toast("Booking cancelled"); } catch (x) { C.toast(x.message); }
  });
  root.querySelector("[data-dispute]")?.addEventListener("click", () => {
    const D = s.deposit;
    const body = C.html(`<div><p class="small">Pick what you disagree with and tell us why. That amount is held until the owner decides.</p>${(D.deductions || []).map((x, i) => `<label class="c-agree"><input type="checkbox" data-di="${i}" checked/> ${C.esc(x.label)} · ${C.money(x.amount)}</label>`).join("")}<label>Why?</label><textarea data-r rows="3" maxlength="500" placeholder="e.g. The towel was already missing when we checked in"></textarea><label>Photo (optional)</label><input type="file" accept="image/*" data-p/></div>`);
    const foot = C.html(`<div><button class="c-btn brand block">Send dispute</button></div>`);
    foot.querySelector("button").onclick = async (e) => { e.target.disabled = true; try { const f = body.querySelector("[data-p]").files?.[0]; const photo = f ? await uploadPrivateImage(rec.storeId, C.auth.currentUser.uid, f, { max: 1280 }) : ""; await act({ action: "disputeDeposit", reason: body.querySelector("[data-r]").value, photo, items: [...body.querySelectorAll("[data-di]:checked")].map((c) => c.dataset.di) }); C.closeSheet(); C.toast("Dispute sent"); } catch (x) { C.toast(x.message); e.target.disabled = false; } };
    C.openSheet("Dispute a deduction", body, foot, s.code);
  });
  root.querySelector("[data-escalate]")?.addEventListener("click", () => import("./support.js").then((m) => m.openSupport({ start: "new" })));
  hydratePrivate(root);
}
