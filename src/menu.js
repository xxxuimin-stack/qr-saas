// Customer ordering page: /m/{slug}?t={tableToken}
import { applyWording } from "./wording.js";
import { intakeForm } from "./intake.js";
import { calcSalonPromos, salonPromoTag, promoHits } from "./salonpromo.js";
import { auth, db, call } from "./firebase.js";
import { hydratePrivate, PRIVACY_NOTE } from "./privfiles.js";
import { rateRows } from "./ratecats.js";
import { msgrField, readMsgr, msgrBtn } from "./msgr.js";
import { quoteCTA, mediaKit, creatorProfile, openQuoteForm, renderInquiry } from "./inquiry.js";
import { signInAnonymously, onAuthStateChanged } from "firebase/auth";
import { doc, onSnapshot, updateDoc, arrayUnion, serverTimestamp, getDoc } from "firebase/firestore";
import { applyTheme, resolveTheme } from "./themes.js";
import { openStatus, rangesFor, hoursLine, fmt12 } from "./hours.js";
import { promoForItem, freeDeliveryPromo, lineDiscount, promoLabel, promoActive, overtimeFor, overtimeClause } from "./promo.js";
import { uploadCustomerImage, uploadPrivateImage } from "./upload.js";
import { signaturePad, signAndUploadWaiver, WAIVER_CSS } from "./waiver.js";
import { drawGiftCard, loadLogo, downloadCanvas, GIFT_DESIGNS } from "./giftcard.js";
if (!document.getElementById("waiver-css")) { const st = document.createElement("style"); st.id = "waiver-css"; st.textContent = WAIVER_CSS; document.head.appendChild(st); }
import { collection, query, where, limit } from "firebase/firestore";
import { watchMaintenance } from "./maint.js";
watchMaintenance("customer");

const slug = location.pathname.replace(/^\/m\/?/, "").split("/")[0];
const params = new URLSearchParams(location.search);
const tableToken = (() => {
  const t = params.get("t"), k = "orderqr:tbl:" + location.pathname.replace(/^\/m\/?/, "").split("/")[0];
  try { if (t) { localStorage.setItem(k, JSON.stringify({ t, at: Date.now() })); return t; } const s = JSON.parse(localStorage.getItem(k) || "null"); return s && Date.now() - s.at < 6 * 3600e3 ? s.t : null; } catch { return t; }
})();
const app = document.getElementById("app");
// "Powered by taptayo" — small footer under every customer page (referral link helps us grow; hidden only for white-label plans)
function mountPowered() {
  if (!store || store.hideBranding || document.getElementById("ttPowered")) return;
  const a = document.createElement("a"); a.id = "ttPowered"; a.className = "c-powered";
  a.href = `https://taptayo.com/?ref=${encodeURIComponent(store.slug || "")}&utm_source=powered&utm_medium=${encodeURIComponent(store.mode || "")}`; a.target = "_blank"; a.rel = "noopener";
  a.innerHTML = `<img src="/logo/favicon.svg" alt="" width="16" height="16"/><span>Powered by <b>taptayo</b></span><em>Get your own free QR ${store.mode === "salon" || store.mode === "laundry" ? "booking page" : "menu"} →</em>`;
  app.after(a);
}

/** Demo stores (taptayo-cafe, …): a slim bar on top — pretend orders, sample reviews, get your own */
function mountDemo() {
  if (!store?.demo || document.getElementById("ttDemo")) return;
  const kind = { salon: "booking page", laundry: "laundry page", stay: "booking page" }[store.mode] || "QR menu";
  const bar = document.createElement("div"); bar.id = "ttDemo"; bar.className = "c-demo";
  bar.innerHTML = `<span>🧪 <b>Demo store</b> · try it, nothing is charged · sample reviews</span><a href="https://taptayo.com/?utm_source=demo&utm_medium=${encodeURIComponent(store.mode || "")}" target="_blank" rel="noopener">Get your own free ${kind} →</a>`;
  bar.insertAdjacentHTML("beforeend", `<a href="/app/?demo=${encodeURIComponent(slug)}" target="_blank" rel="noopener">👀 Owner dashboard</a> · <a href="/counter/?demo=${encodeURIComponent(slug)}" target="_blank" rel="noopener">📱 Staff screens</a>`);
  document.body.prepend(bar); document.body.classList.add("has-demo");
}

// ---------------- helpers ----------------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const html = (str) => { const t = document.createElement("template"); t.innerHTML = str.trim(); return t.content.firstElementChild; };
let CUR = "PHP";
const money = (n) => (CUR === "PHP" ? "₱" : CUR + " ") + Number(n || 0).toLocaleString("en-PH", { maximumFractionDigits: 2 });
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const isOpenNow = (hours) => openStatus(hours).open;
let toastTimer;
function toast(msg) {
  let el = document.querySelector(".c-toast");
  if (!el) { el = html(`<div class="c-toast"></div>`); document.body.appendChild(el); }
  el.textContent = msg; el.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 2000);
}
const storageKey = `orderqr:${slug}`;
const loadLocal = () => { try { return JSON.parse(localStorage.getItem(storageKey) || "{}"); } catch { return {}; } };
const saveLocal = (patch) => { try { localStorage.setItem(storageKey, JSON.stringify({ ...loadLocal(), ...patch })); } catch {} };

// ---------------- state ----------------
let store = null;          // publicStores/{slug}
let cart = [];             // [{ key, itemId, name, qty, unitPrice, choices:[{group,label,add}], note }]
let serviceType = null;    // dine_in | take_out | pickup | delivery
// ➕ additional order linked to an open order: { id, orderNo, serviceType }
let addTo = (() => { try { return JSON.parse(sessionStorage.getItem("orderqr:addto:" + slug) || "null"); } catch { return null; } })();
const setAddTo = (v) => { addTo = v; try { v ? sessionStorage.setItem("orderqr:addto:" + slug, JSON.stringify(v)) : sessionStorage.removeItem("orderqr:addto:" + slug); } catch {} };
const adultCat = (id) => (store?.categories || []).some((c) => c.id === id && c.adult);
const promoCtx = () => ({ vip: !!table?.isRoom });
const itemPromo = (it) => store?.mode === "salon" ? salonBadge(it) : promoForItem({ ...it, adult: adultCat(it.categoryId) }, store.promos || [], undefined, promoCtx());
// salon/spa: a badge when an "everyone" promo covers the service (its days/hours are in the promo banner); the exact price is shown after picking a time
const todayYmd = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const promoLive = (p) => p.active !== false && (!p.schedule?.dateFrom || p.schedule.dateFrom <= todayYmd()) && (!p.schedule?.dateTo || p.schedule.dateTo >= todayYmd()) && !(p.maxUses && (p.usedCount || 0) >= p.maxUses);
function salonBadge(it) { const l = { itemId: it.id, categoryId: it.categoryId }; return (store.promos || []).filter((p) => ["percent", "amount"].includes(p.type) && (p.audience || "all") === "all" && !p.staffIds?.length && promoLive(p) && promoHits(p, l)).sort((a, b) => (b.type === "percent" ? it.price * b.value / 100 : b.value) - (a.type === "percent" ? it.price * a.value / 100 : a.value))[0] || null; }
const DAYN = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const hm12 = (v) => { if (!v) return ""; const [h, m] = v.split(":").map(Number); return `${((h + 11) % 12) + 1}${m ? ":" + String(m).padStart(2, "0") : ""}${h < 12 ? "AM" : "PM"}`; };
function promoWhen(s = {}) {
  const d = (s.days || []).length && s.days.length < 7 ? s.days.map((k) => DAYN[k] || k).join(", ") : "";
  const t = s.start || s.end ? `${hm12(s.start || "00:00")}–${hm12(s.end || "23:59")}` : "";
  const dt = s.dateTo ? `until ${new Date(s.dateTo + "T00:00:00+08:00").toLocaleDateString("en-PH", { month: "short", day: "numeric" })}` : "";
  return [d, t, dt].filter(Boolean).join(" · ");
}
const AUD = { first_visit: "first visit", couple: "2 pax / couple", code: "with code" };
// ---- live availability & the walk-in line (salon / spa) ----
const atShop = (() => { try { if (new URLSearchParams(location.search).get("shop") === "1") sessionStorage.setItem("tt:atshop:" + slug, String(Date.now())); return Date.now() - Number(sessionStorage.getItem("tt:atshop:" + slug) || 0) < 6 * 3600e3; } catch { return false; } })();
let liveAv = null, liveAt = 0, liveKey = "";
async function loadLive(opts = {}, force = false) {
  const key = JSON.stringify(opts);
  if (!force && liveAv && key === liveKey && Date.now() - liveAt < 45000) return liveAv;
  try { liveAv = await call("getAvailability", { slug, atShop, ...opts }); liveAt = Date.now(); liveKey = key; } catch { liveAv = null; }
  return liveAv;
}
const tShort = (ms) => new Date(ms).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" });
function staffLiveText(x) {
  if (!x) return "";
  return { free: "🟢 Free now", busy: `🟡 Free ${tShort(x.freeAt)}`, home: `🏠 Back ~${tShort(x.freeAt)}`, break: `☕ Break${x.until ? " till " + tShort(x.until) : ""}`, later: `🕘 In at ${tShort(x.at)}`, off: "⚪ Off today", full: "🔴 Fully booked today", away: "⚪ Out" }[x.status] || "";
}
function waitLine(q) {
  if (!q || q.enabled === false) return "";
  if (!q.ok && q.code === "QUEUE_CLOSED") return "";
  const free = (liveAv?.staff || []).filter((x) => x.status === "free").length;
  if (free && !q.count) return `🟢 <b>${free} free now</b> — walk in or join from here`;
  return `⏱ Wait now: <b>~${q.waitMin ?? "?"} min</b> · ${q.count} in line${q.ok ? "" : q.code === "QUEUE_FULL" ? " · <b>line full</b>" : q.code === "QUEUE_PAUSED" ? " · <b>paused</b>" : ""}`;
}
function salonPromoBanner() {
  const live = (store.promos || []).filter(promoLive);
  if (!live.length) return "";
  const name = (id) => (store.team || []).find((t) => t.id === id)?.name || "";
  return `<div class="c-promos">${live.map((p) => `<span class="c-promo"><b>${esc(salonPromoTag(p))}</b> ${esc(p.name || "")}${p.type === "free_home_fee" ? ` · home service ₱${Number(p.value || 0).toLocaleString()}+` : ""}${p.type === "bundle" ? ` · ${esc((p.itemIds || []).map((id) => (store.items || []).find((i) => i.id === id)?.name).filter(Boolean).join(" + "))}` : ""}${AUD[p.audience] ? ` · ${AUD[p.audience]}` : ""}${p.place === "home" ? " · home service" : p.place === "shop" ? " · in the shop" : ""}${p.staffIds?.length ? ` · with ${esc(p.staffIds.map(name).filter(Boolean).join(", "))}` : ""}${promoWhen(p.schedule) ? ` · ${esc(promoWhen(p.schedule))}` : ""}${p.maxUses ? ` · ${Math.max(0, p.maxUses - (p.usedCount || 0))} left` : ""}</span>`).join("")}</div>`;
}
function upcomingStrip() {
  const up = store.upcomingPromos || []; if (!up.length) return "";
  const d = (x) => new Date(x + "T00:00:00+08:00").toLocaleDateString("en-PH", { month: "short", day: "numeric" });
  return `<div class="c-upcoming"><div class="small" style="font-weight:800;margin-bottom:6px">🔜 Coming soon — watch for these</div><div class="c-upc-row">${up.map((p) => `<div class="c-upc"><b>${esc(p.label)}</b><span>${esc(p.name)}</span><small>Starts ${d(p.dateFrom)}${p.dateTo ? ` – ${d(p.dateTo)}` : ""}${promoWhen(p) ? ` · ${esc(promoWhen(p))}` : ""}</small>${p.note ? `<small>${esc(p.note)}</small>` : ""}</div>`).join("")}</div></div>`;
}
let myOrders = loadLocal().orders || [];   // [{ id, storeId, at }]
let myResv = loadLocal().resv || [];       // [{ id, storeId, code, at }]
let table = null;            // from the QR token (per-table mode) or picked by the customer (single mode)
let landed = sessionStorage.getItem("orderqr:landed:" + slug) === "1";
let preorderFor = JSON.parse(sessionStorage.getItem("orderqr:preorder:" + slug) || "null"); // { id, code, kind, when }
let roomSession = null, roomUnsub = null, roomTimer = null;
// 🔞 18+ menu: from the 18+ table QR (?menu=18) or any VIP room QR. Beer & liquor on top + the full food menu.
const AGE_KEY = "orderqr:18ok:" + slug;
let adultDeclined = sessionStorage.getItem("orderqr:18no:" + slug) === "1";
const adultMode = () => !adultDeclined && (params.get("menu") === "18" || !!table?.isRoom);
const ageOk = () => { try { return localStorage.getItem(AGE_KEY) === "1"; } catch { return false; } };
function watchRoom() {
  if (!table?.isRoom || roomUnsub) return;
  roomUnsub = onSnapshot(doc(db, "publicStores", slug, "rooms", table.roomId), (snap) => { roomSession = snap.exists() && snap.data().open ? snap.data() : null; drawRoomBar(); }, () => {});
  roomTimer = setInterval(drawRoomBar, 30000);
}
function roomBarHTML() {
  if (!roomSession) return "";
  const r = roomSession;
  const started = r.startedAt?.toDate?.() || new Date();
  const mins = Math.max(0, Math.floor((Date.now() - started) / 60000));
  const ends = new Date(started.getTime() + Math.max(r.bookedHours || 0, r.minHours || 1) * 3600000);
  const target = r.pricing === "consumable" ? r.minSpend : r.pricing === "hour_consumable" ? r.ratePerHour * Math.max(r.bookedHours || 0, r.minHours || 1) : 0;
  const pct = target ? Math.min(100, Math.round((r.consumed || 0) / target * 100)) : 0;
  const ot = overtimeFor(store?.vip?.overtime, started.getTime(), Math.max(r.bookedHours || 0, r.minHours || 1));
  return `<div class="c-roombar${ot.overMin ? " over" : ""}"><div><b>🎤 ${esc(r.roomName)}</b> · ${Math.floor(mins / 60)}h ${mins % 60}m in · until ~${ends.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}</div>
    ${ot.overMin ? `<div class="small" style="color:#b4423a;font-weight:700">⏱ Overtime ${ot.overMin} min · +${money(ot.penalty)}</div>` : ""}
    ${target ? `<div class="bar"><span style="width:${pct}%"></span></div><div class="small">Consumed <b>${money(r.consumed || 0)}</b> / min ${money(target)}${pct >= 100 ? " ✓" : ` · ${money(target - (r.consumed || 0))} to go`}</div>` : `<div class="small">${money(r.ratePerHour)} / hour</div>`}</div>`;
}
function drawRoomBar() {
  document.querySelectorAll("[data-roombar]").forEach((el) => (el.innerHTML = roomBarHTML()));
}

// ---------------- boot ----------------
if (!slug) {
  app.innerHTML = `<div class="c-closed"><div class="ic">🔍</div><h2>No store</h2><p class="muted">Scan the store's QR code to get started.</p></div>`;
} else {
  // Never replace an existing login (e.g. the owner testing in the same browser) with an anonymous one.
  auth.authStateReady().then(() => { if (!auth.currentUser) signInAnonymously(auth).catch((e) => console.error("anon auth", e)); });
  // save menu photos on the phone (instant on next visit)
  if ("serviceWorker" in navigator && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") navigator.serviceWorker.register("/sw.js").catch(() => {});
  onAuthStateChanged(auth, (u) => { if (u) { start(); fillFromAccount(u); } });
}
/** logged in with a TapTayo account → fill my saved details (name, mobile, Messenger, address) into every form */
let filled = false;
async function fillFromAccount(u) {
  if (filled || !u || u.isAnonymous || !u.email) return; filled = true;
  try { const a = await call("myAccount", {}); const P = a.profile || {}; const cur = loadLocal().customer || {};
    const add = Object.fromEntries(Object.entries({ name: P.name, phone: P.phone, messenger: P.messenger, address: P.address }).filter(([k, v]) => v && !cur[k]));
    if (Object.keys(add).length) saveLocal({ customer: { ...cur, ...add } });
  } catch {}
}

function start() {
  onSnapshot(doc(db, "publicStores", slug), async (snap) => {
    if (!snap.exists()) {
      app.innerHTML = `<div class="c-closed"><div class="ic">🔍</div><h2>Store not found</h2><p class="muted">There's no store called "${esc(slug)}".</p></div>`;
      return;
    }
    if (snap.data().redirectTo) { location.replace(location.href.replace(`/m/${slug}`, `/m/${snap.data().redirectTo}`)); return; }
    const first = !store;
    store = snap.data(); applyWording(store);
    CUR = store.currency || "PHP";
    document.title = store.name;
    mountPowered(); if (store.hideBranding) document.getElementById("ttPowered")?.remove(); mountDemo();
    const th = applyTheme(store.theme, undefined, store.name);
    document.querySelector('meta[name=theme-color]')?.setAttribute("content", th.header[0]);
    // not launched yet → "Coming soon" (Test mode lets the owner try everything)
    if (store.comingSoon && !testing()) return renderComingSoon();
    if (store.mode === "stay") {
      const m = await import("./stay.js");
      return m.stayStore(store, { app, slug, call, db, auth, esc, html, money, toast, openSheet, closeSheet, loadLocal, saveLocal }, first);
    }
    if (tableToken) { table = (store.tables || []).find((t) => t.qrToken === tableToken) || null; watchRoom(); }
    else if (store.qrMode === "single") { const tid = sessionStorage.getItem("orderqr:table:" + slug); table = (store.tables || []).find((t) => t.id === tid) || null; }
    if (first) {
      serviceType = defaultService();
      if (params.get("job") && params.get("k")) {
        try { await call("bindLaundryJob", { storeId: store.storeId, orderId: params.get("job"), code: params.get("k") }); const rec = { id: params.get("job"), storeId: store.storeId, at: Date.now() }; const L0 = loadLocal(); saveLocal({ lastOrder: rec, orders: [...(L0.orders || []).filter((x) => x.id !== rec.id), rec] }); history.replaceState(null, "", location.pathname); return renderStatus(rec); }
        catch (e) { toast(e.message); }
      }
      if (params.get("my")) { // from My TapTayo → open that booking's live status
        const [k, id] = String(params.get("my")).split(":"); const rec = { id, storeId: store.storeId, at: Date.now() };
        if (k === "inq") return renderInquiry(inqCtx(), rec);
        if (k === "appt" && store.mode === "salon") { saveLocal({ lastAppt: rec }); return renderApptStatus(rec); }
        if (k === "resv") { saveLocal({ lastResv: rec }); return renderResvStatus(rec); }
        if (k === "order") { saveLocal({ lastOrder: rec }); return renderStatus(rec); }
      }
      if (params.get("inq")) { const L = loadLocal().lastInquiry; return renderInquiry(inqCtx(), { id: params.get("inq"), storeId: store.storeId, ...(L?.id === params.get("inq") ? L : {}) }); }
      if (table?.isWaitlist) return renderWaitlist();
      if (store.mode === "salon" && params.get("v")) return renderVisit(params.get("v"));
      if (store.mode === "laundry" && !loadLocal().lastOrder) landed = true; // no landing screen for laundry
      // if this session has an active order, show its status first
      const active = loadLocal().lastOrder;
      if (active && params.get("view") !== "menu") return renderStatus(active);
      const lastResv = loadLocal().lastResv;
      if (lastResv && params.get("view") !== "menu") return renderResvStatus(lastResv);
      const lastAppt = loadLocal().lastAppt;
      if (lastAppt && params.get("view") !== "menu") return renderApptStatus(lastAppt);
      if (store.mode === "salon") landed = true;
      if (store.landing !== false && !landed && !store.locked) return renderLanding();
      renderMenu();
    } else if (document.querySelector(".c-page")) {
      renderMenu(true); // live update: sold out, prices
    }
  });
}

const testing = () => !!(store?.demo || (store?.testMode && store.testMode.until > Date.now()));
/** Closed by opening hours but the shop accepts orders for later (pickup / delivery at a chosen time) */
function advanceOnly() {
  if (!store || store.mode !== "table" || store.locked || store.acceptOrders === false || store.advanceWhenClosed === false || preorderFor || testing()) return false;
  const s = store.service || {};
  return !isOpenNow(store.hours) && (s.pickup || s.delivery) && s.allowSchedule !== false;
}
function availableServices() {
  const s = store.service || {};
  const out = [];
  if (store.mode === "table") {
    const single = store.qrMode === "single";
    if (preorderFor) return [["dine_in", "📅 Pre-order"]];
    const later = advanceOnly(); // closed → only "order for later" services
    if ((table || single || testing()) && s.dineIn !== false && !later) out.push(["dine_in", "🍽️ Dine-in"]);
    if ((table || single || testing()) && s.takeOut !== false && !later) out.push(["take_out", "🥡 Take-out"]);
    if (s.pickup) out.push(["pickup", "🛍️ Pickup"]);
    if (s.delivery) out.push(["delivery", "🛵 Delivery"]);
  } else if (store.mode === "laundry" || store.mode === "salon") {
    return []; // pricelist only; bookings go through the Book tab — jobs are created at the counter; online booking comes with the Book tab
  } else {
    out.push(["pickup", "🛍️ Drop-off / Pickup"]);
  }
  return out;
}
function reserveFeatures() {
  if (store.mode !== "table" || store.locked) return [];
  const out = [];
  if (store.reservations?.enabled !== false) out.push("table");
  if (store.events?.enabled) out.push("event");
  if (store.vip?.enabled && (store.vip.rooms || []).length) out.push("vip");
  return out;
}
function defaultService() {
  const list = availableServices();
  return list[0]?.[0] || null;
}

// ---------------- MENU ----------------
// ---------------- LANDING: "How would you like to order?" ----------------
function smsCardHTML(rec, doc_, kind) {
  if (!store.sms?.enabled) return "";
  const phone = doc_.customer?.phone || doc_.phone || loadLocal().customer?.phone || "";
  const on = !!doc_.smsOptIn;
  return `<div class="c-ticket c-sms"><label class="c-agree" style="margin:0"><input type="checkbox" data-smsopt ${on ? "checked" : ""}/> 📱 ${esc(store.sms.optInText)}</label>
    <div class="row" style="gap:8px;margin-top:8px;${on ? "display:none" : ""}" data-smsrow><input data-smsphone type="tel" inputmode="numeric" placeholder="09XXXXXXXXX" value="${esc(phone)}" style="flex:1"/></div>
    <div class="muted small" style="margin-top:6px">${on ? "You're subscribed. Untick to stop." : "Promos and updates only, no spam. You can unsubscribe here anytime."}</div></div>`;
}
function bindSms(rootEl, rec, kind) {
  const cb = rootEl.querySelector("[data-smsopt]"); if (!cb) return;
  cb.onchange = async () => {
    const phone = rootEl.querySelector("[data-smsphone]")?.value.trim();
    if (cb.checked && !/^(\+?63|0)?9\d{9}$/.test((phone || "").replace(/[\s-]/g, ""))) { cb.checked = false; return toast("Enter your mobile number (09XXXXXXXXX)"); }
    cb.disabled = true;
    try { await call("smsOptIn", { storeId: rec.storeId, [kind === "resv" ? "reservationId" : kind === "appt" ? "appointmentId" : "orderId"]: rec.id, phone, optIn: cb.checked }); toast(cb.checked ? "Subscribed ✓" : "Unsubscribed"); }
    catch (e) { cb.checked = !cb.checked; toast(e.message); }
    cb.disabled = false;
  };
}
const NEWS_T = { news: "📢 News", event: "🎉 Event", closed: "⛔ Closed", hiring: "🧑‍🍳 We're hiring", promo: "🏷️ Promo" };
function newsHTML() {
  const list = store.announcements || [];
  const up = store.upcomingPromos || [];
  const d = (x) => new Date(x + "T00:00:00+08:00").toLocaleDateString("en-PH", { month: "short", day: "numeric" });
  if (!list.length && !up.length) return `<div class="c-empty">No announcements right now.</div>`;
  return `<div class="c-anns" style="margin-top:12px">${list.map((a) => `<div class="c-ann c-news t-${esc(a.type || "news")}">${a.imageUrl ? `<img src="${esc(a.imageUrl)}" alt=""/>` : ""}<div style="flex:1;min-width:0"><span class="c-ntype">${NEWS_T[a.type] || NEWS_T.news}${a.pinned ? " · 📌" : ""}</span><b>${esc(a.title)}</b>${a.body ? `<p>${esc(a.body)}</p>` : ""}${a.dateTo ? `<div class="muted small">Until ${d(a.dateTo)}</div>` : ""}${a.btnUrl ? `<a class="c-btn brand sm" style="margin-top:8px" href="${esc(a.btnUrl)}" target="_blank" rel="noopener">${esc(a.btnText || "Open")} ›</a>` : ""}${a.type === "hiring" && a.btnUrl ? `<div class="c-qrbox"><canvas data-qr="${esc(a.btnUrl)}"></canvas><span class="small muted">Scan to apply</span></div>` : ""}</div></div>`).join("")}</div>
    ${up.length ? `<div class="c-card-soft"><h2>🔜 Coming soon — promos to watch for</h2>${up.map((p) => `<div class="c-mini"><span><b>${esc(p.label)}</b> ${esc(p.name)}</span><span class="small muted">${d(p.dateFrom)}${p.dateTo ? "–" + d(p.dateTo) : ""}</span></div>`).join("")}</div>` : ""}`;
}
function closedBannerHTML() {
  const a = (store.announcements || []).find((x) => x.type === "closed");
  return a ? `<button type="button" class="c-closedbanner" data-gonews>⛔ <b>${esc(a.title)}</b>${a.body ? ` — ${esc(a.body.slice(0, 140))}${a.body.length > 140 ? "…" : ""}` : ""} <span>More ›</span></button>` : "";
}
function annHTML(limitN = 5) {
  let hidden = []; try { hidden = JSON.parse(localStorage.getItem("orderqr:annhide:" + slug) || "[]"); } catch {}
  const list = (store.announcements || []).filter((a) => !hidden.includes(a.id)).slice(0, limitN);
  if (!list.length) return "";
  return `<div class="c-anns">${list.map((a) => `<div class="c-ann" data-ann="${esc(a.id)}">${a.imageUrl ? `<img src="${esc(a.imageUrl)}" alt=""/>` : ""}<div><b>${a.pinned ? "📌 " : "📣 "}${esc(a.title)}</b>${a.body ? `<p>${esc(a.body)}</p>` : ""}</div><button class="x" data-annhide="${esc(a.id)}" aria-label="Hide">×</button></div>`).join("")}</div>`;
}
function bindAnn(rootEl) {
  rootEl.querySelectorAll("[data-annhide]").forEach((b) => (b.onclick = () => { let hidden = []; try { hidden = JSON.parse(localStorage.getItem("orderqr:annhide:" + slug) || "[]"); } catch {} hidden.push(b.dataset.annhide); try { localStorage.setItem("orderqr:annhide:" + slug, JSON.stringify(hidden.slice(-20))); } catch {} b.closest(".c-ann")?.remove(); }));
}
function renderComingSoon() {
  const c = store.contact || {};
  app.innerHTML = `<div class="c-page">${infoCard(store.tagline || "")}<div class="c-body"><div class="c-card-soft" style="text-align:center;padding:34px 20px">
    <div style="font-size:3rem">🚀</div><h2 style="margin:8px 0">Opening soon!</h2>
    <p class="muted">${esc(store.name)} is getting ready. Check back soon — you'll be able to ${store.mode === "salon" ? "book" : store.mode === "laundry" ? "book a pickup" : "order"} right here.</p>
    ${c.phone ? `<a class="c-btn ghost block" href="tel:${esc(c.phone)}" style="margin-top:12px">📞 ${esc(c.phone)}</a>` : ""}${c.address ? `<p class="small muted" style="margin-top:10px">📍 ${esc(c.address)}</p>` : ""}
  </div></div></div>`;
}
function renderLanding() {
  applyTheme(store.theme, undefined, store.name);
  const services = availableServices();
  const feats = reserveFeatures();
  const single = store.qrMode === "single";
  const opts = [];
  for (const [k, l] of services) {
    const sub = { dine_in: single && !table ? "You'll pick your table number" : table ? table.label : "", take_out: "Pick up at the counter", pickup: "Order ahead, pick up in store", delivery: "Delivered to your address" }[k];
    opts.push(`<button class="c-land" data-svc="${k}"><span class="ic">${l.split(" ")[0]}</span><span><b>${l.slice(l.indexOf(" ") + 1)}</b><small>${esc(sub)}</small></span><span class="chev">›</span></button>`);
  }
  if (feats.length) opts.push(`<button class="c-land" data-reserve><span class="ic">📅</span><span><b>Reserve / Book</b><small>${feats.map((f) => ({ table: "Table", event: "Event", vip: "VIP room" }[f])).join(" · ")}</small></span><span class="chev">›</span></button>`);
  opts.push(`<button class="c-land ghost" data-browse><span class="ic">📋</span><span><b>Just browse the ${esc((store.labels?.items || "menu").toLowerCase())}</b><small>Just take a look</small></span><span class="chev">›</span></button>`);

  app.innerHTML = `<div class="c-page">
    ${infoCard(store.tagline || "Welcome")}${seasonBar()}
    <div class="c-body">${annHTML(2)}<h2 class="c-landq">How would you like to order?</h2><div class="c-lands">${opts.join("")}</div></div></div>`;
  bindAnn(app);
  app.querySelectorAll("[data-svc]").forEach((b) => (b.onclick = () => {
    serviceType = b.dataset.svc;
    if (single && !table && (serviceType === "dine_in")) return pickTable();
    done();
  }));
  app.querySelector("[data-reserve]")?.addEventListener("click", () => { uiTab = "reserve"; done(); });
  app.querySelector("[data-browse]").onclick = () => done();
  function done() { landed = true; sessionStorage.setItem("orderqr:landed:" + slug, "1"); renderMenu(); }
}

function pickTable(after) {
  const tables = store.tables || [];
  const body = html(`<div><p class="desc">Which table are you at? Check the number on your table.</p>
    <div class="c-pax wide">${tables.map((t) => `<button type="button" data-id="${t.id}" class="${table?.id === t.id ? "on" : ""}">${esc(t.label.replace(/^table\s*/i, ""))}</button>`).join("") || `<p class="muted">No tables have been set up yet.</p>`}</div></div>`);
  body.querySelectorAll("[data-id]").forEach((b) => (b.onclick = () => {
    table = tables.find((t) => t.id === b.dataset.id);
    sessionStorage.setItem("orderqr:table:" + slug, table.id);
    closeSheet();
    landed = true; sessionStorage.setItem("orderqr:landed:" + slug, "1");
    if (after) after(); else renderMenu(true);
  }));
  openSheet("Select your table", body, null, store.name);
}

/** Seasonal ribbon + floating decorations (customer pages only) */
function seasonBar() {
  const t = resolveTheme(store.theme || {}, store.name);
  const tb = testing() && !store.demo ? `<div class="c-testbar">🧪 <b>TEST MODE</b> — ${store.mode === "salon" ? "bookings" : store.mode === "stay" ? "bookings" : "orders"} here are practice only and don't count in sales.</div>` : "";
  return tb + (t.season ? `<div class="c-banner">${esc(t.banner)}</div>${floaties(t)}` : "");
}
function floaties(t) {
  if (!t.season || !t.float?.length) return "";
  return `<div class="c-floaties" aria-hidden="true">${t.float.map((e, i) => `<span style="left:${(i * 97 + 7) % 92}%;animation-delay:${-i * 2.3}s;animation-duration:${11 + (i % 4) * 3}s">${e}</span>`).join("")}</div>`;
}
function infoCard(tag, extra = "") {
  return `<header class="c-cover ${store.coverUrl ? "has-cover" : ""}">${store.coverUrl ? `<img class="cover" src="${esc(store.coverUrl)}" alt=""/>` : ""}<div class="decor">${(resolveTheme(store.theme || {}, store.name).decor || []).map((e, i) => `<span class="dc d${i % 6}">${e}</span>`).join("")}</div></header>
    <section class="c-info"><div class="ci-top"><div class="ci-logo">${store.logoUrl ? `<img src="${esc(store.logoUrl)}" alt=""/>` : esc(store.name.trim()[0] || "·")}</div><div class="ci-name"><h1>${esc(store.name)}</h1><div class="ci-tag">${esc(tag)}</div></div></div>${extra}</section>`;
}
const layoutOf = () => store.theme?.layout || "list";
function sizePill(it) {
  const g = (it.options || []).find((o) => !o.multi && /size|serving/i.test(o.name || ""));
  const ch = g?.choices?.find((c) => Number(c.add) > 0);
  return ch ? `<span class="c-sizepill"><span>${esc(ch.label)}</span><span>+${money(ch.add)}</span></span>` : "";
}
let uiTab = "menu";      // menu | reserve | info
let uiSearch = "";
let openCats = null;     // Set of expanded category ids (null = default: first category)

function showAgeGate() {
  if (document.querySelector(".c-agegate")) return;
  const g = html(`<div class="c-agegate"><div class="box"><div style="font-size:44px">🔞</div><h2>18+ Menu</h2><p>This menu has beer and liquor. Are you 18 years old or older?</p>
    <button class="c-btn block" data-yes>Yes, I'm 18 or older</button><button class="c-btn ghost block" data-no style="margin-top:8px">No — show the regular menu</button>
    <p class="small muted" style="margin-top:10px">Staff may ask for a valid ID. Please drink responsibly.</p></div></div>`);
  g.querySelector("[data-yes]").onclick = () => { try { localStorage.setItem(AGE_KEY, "1"); } catch {} g.remove(); openCats = null; renderMenu(); };
  g.querySelector("[data-no]").onclick = () => { adultDeclined = true; sessionStorage.setItem("orderqr:18no:" + slug, "1"); g.remove(); renderMenu(); };
  document.body.appendChild(g);
}
function renderMenu(keepScroll = false) {
  if (addTo) serviceType = addTo.serviceType;
  if (adultMode() && !ageOk()) setTimeout(showAgeGate, 0);
  const y = keepScroll ? window.scrollY : 0;
  const t = applyTheme(store.theme, undefined, store.name);
  const open = isOpenNow(store.hours);
  const services = availableServices();
  const later = advanceOnly();
  const closedMsg = store.locked ? "Ordering is temporarily unavailable." : !store.acceptOrders ? "We're not taking orders right now." : !open && !preorderFor && !testing() && !later ? "We're closed right now." : null;
  const noService = !services.length;
  const feats = reserveFeatures();
  const canReserve = feats.length > 0;
  const adult = adultMode() && ageOk();
  const allCats = store.categories || [];
  const adultIds = new Set(allCats.filter((c) => c.adult).map((c) => c.id));
  const cats = adult ? [...allCats.filter((c) => c.adult), ...allCats.filter((c) => !c.adult)] : allCats.filter((c) => !c.adult);
  const items = (store.items || []).filter((it) => adult || !adultIds.has(it.categoryId));
  const st = openStatus(store.hours);
  const decor = t.decor.length ? t.decor.map((e, i) => `<span class="dc d${i % 6}">${e}</span>`).join("") : "";

  const root = html(`<div class="c-page">
    ${infoCard(store.tagline || store.labels?.items || "Menu", `<div class="ci-meta">
        ${store.feedback?.display && store.feedback.display !== "off" && store.feedback.count ? `<span class="ci-rate">★ ${store.feedback.avg} <span>(${store.feedback.count})</span></span>` : ""}
        <span class="ci-open ${closedMsg || !open ? "closed" : ""}">${closedMsg || !open ? "Closed" : "Open now"}${!closedMsg && open && st.closesAt ? ` · until ${fmt12(st.closesAt)}` : !open && st.opensAt ? ` · opens ${fmt12(st.opensAt)}${st.opensDay ? " " + ["", "tomorrow", "", "", "", "", ""][st.opensDay] || "" : ""}` : ""}</span>
        ${table ? `<span class="chip stamp" ${store.qrMode === "single" ? 'data-pick style="cursor:pointer"' : ""}>${esc(table.label)}${store.qrMode === "single" ? " ✎" : ""}</span>` : store.qrMode === "single" && serviceType === "dine_in" ? `<span class="chip stamp" data-pick style="cursor:pointer">Select table ✎</span>` : ""}
      </div>`)}
    ${t.banner ? `<div class="c-banner">${esc(t.banner)}</div>` : ""}${floaties(t)}
    <nav class="c-tabs">
      <button data-tab="menu" class="${uiTab === "menu" ? "active" : ""}">${esc(store.labels?.items || "Menu")}</button>
      ${canReserve ? `<button data-tab="reserve" class="${uiTab === "reserve" ? "active" : ""}">Reserve</button>` : ""}
      ${store.mode === "laundry" && laundryBookModes().length ? `<button data-tab="book" class="${uiTab === "book" ? "active" : ""}">Book pickup</button>` : ""}
      ${store.mode === "salon" ? `<button data-tab="book" class="${uiTab === "book" ? "active" : ""}">Book</button><button data-tab="team" class="${uiTab === "team" ? "active" : ""}">Our team</button>${giftOn() ? `<button data-tab="gift" class="${uiTab === "gift" ? "active" : ""}">🎁 Gift cards</button>` : ""}` : ""}
      ${store.mode === "laundry" || store.mode === "salon" || (store.announcements || []).length || (store.upcomingPromos || []).length ? `<button data-tab="news" class="${uiTab === "news" ? "active" : ""}">News${(store.announcements || []).length ? ` <b class="dotn">${store.announcements.length}</b>` : ""}</button>` : ""}
      <button data-tab="info" class="${uiTab === "info" ? "active" : ""}">Info${myOrders.length || myResv.length ? ` <b class="dotn">${myOrders.length + myResv.length}</b>` : ""}</button>
    </nav>
    <div class="c-body"></div>
  </div>`);
  const body = root.querySelector(".c-body");
  root.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => { uiTab = b.dataset.tab; renderMenu(true); }));

  // ---------- MENU TAB ----------
  if (uiTab === "menu") {
    const lastO = loadLocal().lastActive;
    body.innerHTML = `
      ${closedBannerHTML()}
      ${lastO && Date.now() - lastO.at < 6 * 3600e3 ? `<button class="c-activebar" data-viewactive>🧾 Order #${lastO.orderNo || ""} · ${esc(lastO.status || "in progress")} <span>View status ›</span></button>` : ""}
      <div data-roombar>${roomBarHTML()}</div>${mediaKit(store, esc)}${creatorProfile(store, esc)}${store.businessType === "freelance" && loadLocal().lastInquiry ? `<button class="c-activebar" data-myinq>📨 Your inquiry <span>View quote ›</span></button>` : ""}${uiTab === "menu" ? quoteCTA(store, esc) : ""}
      ${preorderFor ? `<div class="c-alert ok" style="margin-top:12px"><b>📅 Pre-order for ${esc(preorderFor.code)}</b> · ${esc(preorderFor.when || "")}<br><span class="small">We'll have it ready before you arrive. <a href="#" data-cancelpre>Cancel pre-order</a></span></div>` : ""}
      ${annHTML()}
      ${store.welcome ? `<p class="c-welcome">${esc(store.welcome)}</p>` : ""}
      ${adult ? `<div class="c-18">🔞 <b>18+ MENU</b> — beer &amp; liquor on top, plus our full food menu.<small>18+ only · Please drink responsibly · Beer &amp; liquor are dine-in only.</small></div>` : ""}
      ${store.mode === "salon" && (presenceLine(store.salon?.presence) || store.salon?.presence?.waitNote) ? `<div class="c-alert c-presence" role="status">${esc(presenceLine(store.salon.presence) || "🟢 We're in")}${store.salon.presence.waitNote ? ` · ${esc(store.salon.presence.waitNote)}` : ""}</div>` : ""}
    ${later ? `<div class="c-alert warn">🌙 <b>We're closed right now</b>${(() => { const os = openStatus(store.hours); return os.opensAt ? ` · opens ${fmt12(os.opensAt)}${os.opensDay === 1 ? " tomorrow" : ""}` : ""; })()}. You can still order now for <b>pickup${store.service?.delivery ? " or delivery" : ""} later</b> — pick a time at checkout.</div>` : closedMsg ? `<div class="c-alert warn">${esc(closedMsg)}</div>` : store.kitchen?.status === "busy" ? `<div class="c-alert warn">🔥 We're busy right now — orders take about <b>${store.kitchen.busyPrep || 35} minutes</b> right now.</div>` : ""}
      ${noService && store.mode !== "laundry" && store.mode !== "salon" ? `<div class="c-alert warn">Scan the QR code on your table to order. You can still browse the menu.</div>` : ""}
      ${store.mode === "salon" ? `<div class="c-ctabox"><span><b>Book an appointment</b><small>Pick services, a stylist and a time</small></span><button class="c-btn brand" data-gobook>Book now</button></div>${(store.team || []).length ? `<div class="c-teamstrip">${store.team.slice(0, 8).map((m) => `<button type="button" data-gostaff="${esc(m.id)}"><span class="av">${m.photoUrl ? `<img src="${esc(m.photoUrl)}" alt=""/>` : esc((m.name || "?").trim()[0])}</span><b>${esc((m.name || "").split(" ")[0])}</b></button>`).join("")}</div>` : ""}` : ""}
      ${protectHTML(true)}
      ${store.mode === "laundry" && laundryBookModes().length ? `<div class="c-ctabox"><span><b>Book a pickup</b><small>A rider picks up your laundry — or just drop it off</small></span><button class="c-btn brand" data-golbook>Book</button></div>` : ""}
      ${store.mode === "laundry" ? `${store.laundry?.pause?.active ? `<div class="c-alert warn"><b>⏸ ${esc(store.laundry.pause.reason)}</b>${store.laundry.pause.until ? ` · expected to resume ${esc(store.laundry.pause.until)}` : ""}</div>` : ""}${store.laundry?.busy ? `<div class="c-alert warn"><b>🔥 Busy right now</b> — jobs take about +${store.laundry.busy.extraDays} day${store.laundry.busy.extraDays > 1 ? "s" : ""} longer. Rush service is available for faster turnaround.</div>` : ""}<div class="c-alert ok" style="margin-top:12px"><b>Pricelist</b> · min ${store.laundry?.minKg || 0} kg${store.laundry?.rushValue ? ` · Rush ${store.laundry.rushMode === "fixed" ? "+₱" + store.laundry.rushValue : store.laundry.rushMode === "double" ? "2× price" : "+" + store.laundry.rushValue + "%"}` : ""}<br><span class="small">Your total is computed after weighing at the shop. Drop off your laundry and follow the price and status here with your claim stub.</span></div>` : ""}
      ${services.length > 1 && !addTo ? `<div class="c-service">${services.map(([k, l]) => `<button data-svc="${k}" class="${serviceType === k ? "active" : ""}">${l}</button>`).join("")}</div>` : ""}
      ${store.mode === "salon" ? `<div data-livewait></div>` : ""}
      ${upcomingStrip()}
      ${store.mode === "salon" ? salonPromoBanner() : (() => { const live = (store.promos || []).filter((p) => promoActive(p) && (!p.validFor || p.validFor === "all" || p.validFor === "adult" || table?.isRoom) && (p.type !== "free_delivery" || (store.service || {}).delivery)); return live.length ? `<div class="c-promos">${live.map((p) => `<span class="c-promo"><b>${esc(promoLabel(p))}</b>${p.name && p.name.toLowerCase() !== promoLabel(p).toLowerCase() ? " " + esc(p.name) : ""}${p.type === "free_delivery" && Number(p.value) ? ` · ₱${Number(p.value).toLocaleString()}+` : ""}${p.validFor === "vip" || p.validFor === "vip_adult" ? " · VIP room" : ""}</span>`).join("")}</div>` : ""; })()}
      ${addTo ? `<div class="c-alert ok c-addto"><b>➕ Adding to order #${esc(addTo.orderNo)}</b><br><span class="small">Same ${addTo.serviceType === "delivery" ? "delivery — no extra delivery fee" : addTo.serviceType === "pickup" ? "pickup" : "table"}, one bill. Pick what to add, then tap Review order.</span> <a href="#" data-cancelAdd class="small">Cancel</a></div>` : ""}
      ${cats.length > 2 && !uiSearch ? `<nav class="c-tabs" data-tabs>${(store.bestsellers || []).length ? `<button data-jump="best">For you</button>` : ""}${cats.map((c) => `<button data-jump="${c.id}">${esc(c.name)}</button>`).join("")}</nav>` : ""}
      <div class="c-search"><span>⌕</span><input type="search" placeholder="Search ${esc((store.labels?.items || "menu").toLowerCase())}…" value="${esc(uiSearch)}" /></div>
      <div class="c-cats"></div>`;
    body.querySelectorAll("[data-svc]").forEach((b) => (b.onclick = () => { serviceType = b.dataset.svc; renderMenu(true); }));
    body.querySelector("[data-cancelAdd]")?.addEventListener("click", (e) => { e.preventDefault(); setAddTo(null); cart = []; serviceType = defaultService(); renderMenu(); });
    body.querySelectorAll("[data-jump]").forEach((b) => (b.onclick = () => {
      const id = b.dataset.jump;
      const el = document.getElementById("cat-" + id); if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 70, behavior: "smooth" });
      body.querySelectorAll("[data-jump]").forEach((x) => x.classList.toggle("on", x === b));
    }));
    bindAnn(body); bindProtect(body);
    { const lw = body.querySelector("[data-livewait]"); if (lw) loadLive().then((av) => { const t = waitLine(av?.queue); if (t && lw.isConnected) { lw.innerHTML = `<button type="button" class="c-livewait"><span class="t">${t}</span><span class="go">Book ›</span></button>`; lw.querySelector("button").onclick = () => { uiTab = "book"; renderMenu(); window.scrollTo({ top: 0 }); }; } }); }
    body.querySelector("[data-gobook]")?.addEventListener("click", () => { uiTab = "book"; renderMenu(); });
    body.querySelector("[data-gonews]")?.addEventListener("click", () => { uiTab = "news"; renderMenu(); window.scrollTo({ top: 0 }); });
    body.querySelector("[data-golbook]")?.addEventListener("click", () => { uiTab = "book"; renderMenu(); window.scrollTo({ top: 0 }); });
    body.querySelectorAll("[data-gostaff]").forEach((b) => (b.onclick = () => { bookPrefProvider = b.dataset.gostaff; uiTab = "book"; renderMenu(); window.scrollTo({ top: 0 }); }));
    body.querySelector("[data-viewactive]")?.addEventListener("click", () => { const o = loadLocal().lastActive; saveLocal({ lastOrder: { id: o.id, storeId: o.storeId, at: o.at } }); renderStatus({ id: o.id, storeId: o.storeId, at: o.at }); });
    body.querySelector("[data-cancelpre]")?.addEventListener("click", (e) => { e.preventDefault(); preorderFor = null; sessionStorage.removeItem("orderqr:preorder:" + slug); serviceType = defaultService(); cart = []; renderMenu(); });
    const search = body.querySelector(".c-search input");
    search.oninput = (e) => { uiSearch = e.target.value; drawCats(); };
    const catsEl = body.querySelector(".c-cats");

    function drawCats() {
      catsEl.innerHTML = ""; imgCount = 0;
      const q = uiSearch.trim().toLowerCase();
      if (!openCats) openCats = new Set(cats[0] ? [cats[0].id] : []);
      let any = false;
      // 🔥 Top picks — grid tiles (Grab "For you")
      const best = (store.bestsellers || []).map((id) => items.find((it) => it.id === id)).filter(Boolean).filter((it) => !q || (it.name + " " + (it.description || "")).toLowerCase().includes(q));
      if (best.length && !q) {
        const sec = html(`<section class="c-cat open best" id="cat-best"><h2 class="c-sech">For you <small>Customer favorites</small></h2><div class="c-catbody lay-grid"></div></section>`);
        best.slice(0, 6).forEach((it) => sec.querySelector(".c-catbody").appendChild(itemRow(it, closedMsg, noService)));
        catsEl.appendChild(sec); any = true;
      }
      // every category open, one after the other (no accordions) — like Grab
      for (const c of cats) {
        let rows = items.filter((it) => it.categoryId === c.id);
        if (q) rows = rows.filter((it) => (it.name + " " + (it.description || "")).toLowerCase().includes(q));
        if (!rows.length) continue;
        any = true;
        const sec = html(`<section class="c-cat open" id="cat-${c.id}"><h2 class="c-sech">${esc(c.name)}${c.description ? `<small>${esc(c.description)}</small>` : ""}</h2><div class="c-catbody"></div></section>`);
        const list = sec.querySelector(".c-catbody");
        list.classList.add("lay-" + layoutOf());
        for (const it of rows) list.appendChild(itemRow(it, closedMsg, noService));
        catsEl.appendChild(sec);
      }
      if (!any) catsEl.innerHTML = q
        ? `<div class="c-empty">No results for "${esc(uiSearch)}".</div>`
        : `<div class="c-empty"><div class="big">${esc(store.name)}</div><p>The ${esc((store.labels?.items || "menu").toLowerCase())} is still being set up. Please check back later.</p></div>`;
    }
    drawCats();
  }

  // ---------- BOOK TAB (laundry / salon) ----------
  if (uiTab === "book") { if (store.mode === "salon") renderSalonBook(body); else renderLaundryBook(body); }
  if (uiTab === "team") renderTeam(body);
  if (uiTab === "gift") renderGiftShop(body);
  // ---------- RESERVE TAB ----------
  if (uiTab === "reserve") {
    const rs = store.reservations || {}, ev = store.events || {}, vp = store.vip || {};
    body.innerHTML = `
      ${feats.includes("table") ? `<div class="c-card-soft c-feat" data-kind="table"><div class="fi">🪑</div><div><h2>Reserve a table</h2><p class="muted">Up to ${rs.maxPax || 12} pax${rs.leadTimeHours ? ` · ${rs.leadTimeHours}h advance` : ""}</p></div><span class="chev">›</span></div>` : ""}
      ${feats.includes("event") ? `<div class="c-card-soft c-feat" data-kind="event"><div class="fi">🎉</div><div><h2>Book an event</h2><p class="muted">Birthdays, meetings, parties${(ev.packages || []).length ? ` · ${ev.packages.length} package${ev.packages.length > 1 ? "s" : ""}` : ""}${ev.leadTimeDays ? ` · ${ev.leadTimeDays} days advance` : ""}</p></div><span class="chev">›</span></div>` : ""}
      ${feats.includes("vip") ? `<div class="c-card-soft c-feat" data-kind="vip"><div class="fi">🎤</div><div><h2>VIP / private room</h2><p class="muted">${(vp.rooms || []).length} room${(vp.rooms || []).length > 1 ? "s" : ""} available${vp.leadTimeHours ? ` · ${vp.leadTimeHours}h advance` : ""}</p></div><span class="chev">›</span></div>` : ""}
      ${store.floorPlanUrl ? `<div class="c-card-soft"><h2>Floor plan</h2><a href="${esc(store.floorPlanUrl)}" target="_blank"><img src="${esc(store.floorPlanUrl)}" alt="Floor plan" style="width:100%;border-radius:10px"/></a><p class="muted small" style="margin:6px 0 0">Tap to enlarge. Mention a preferred spot in your notes.</p></div>` : ""}
      ${myResv.length ? `<button class="c-btn ghost block" style="margin-top:12px" data-myresv>My reservations (${myResv.length})</button>` : ""}`;
    body.querySelectorAll(".c-feat").forEach((c) => (c.onclick = () => openReserve(c.dataset.kind)));
    body.querySelector("[data-myresv]")?.addEventListener("click", () => renderMyResv());
  }

  // ---------- NEWS TAB (laundry) ----------
  if (uiTab === "news") {
    body.innerHTML = newsHTML();
    body.querySelectorAll("[data-qr]").forEach(async (c) => { try { const QR = (await import("qrcode")).default; await QR.toCanvas(c, c.dataset.qr, { width: 140, margin: 1 }); } catch {} });
  }
  // ---------- INFO TAB ----------
  if (uiTab === "info") {
    const hrs = store.hours || {};
    const dayNames = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
    body.innerHTML = `
      ${myOrders.length || myResv.length ? `<div class="c-card-soft"><h2>Your activity</h2>
        ${myOrders.length ? `<button class="c-btn ghost block" data-myorders>My orders (${myOrders.length})</button>` : ""}
        ${myResv.length ? `<button class="c-btn ghost block" style="margin-top:8px" data-myresv>My reservations (${myResv.length})</button>` : ""}</div>` : ""}
      <div class="c-card-soft"><h2>${esc(store.name)}</h2>
        ${store.contact?.address ? `<div class="c-mini"><span>Address</span><span>${esc(store.contact.address)}</span></div>` : ""}
        ${store.contact?.phone ? `<div class="c-mini"><span>Phone</span><a href="tel:${esc(store.contact.phone)}">${esc(store.contact.phone)}</a></div>` : ""}
      </div>
      ${(store.feedback?.reviews || []).length ? `<div class="c-card-soft"><h2>Reviews · ★ ${store.feedback.avg} (${store.feedback.count})</h2>${store.feedback.reviews.map((r) => `<div class="c-review"><div><b>${"★".repeat(r.rating)}<span class="muted">${"★".repeat(5 - r.rating)}</span></b> <span class="muted small">${esc(r.name)}</span></div><div>${esc(r.comment)}</div></div>`).join("")}</div>` : ""}
      ${Object.keys(hrs).length ? `<div class="c-card-soft"><h2>Hours</h2>${Object.entries(dayNames).map(([k, n]) => `<div class="c-mini ${k === DAYS[new Date().getDay()] ? "today" : ""}"><span>${n}</span><span>${hoursLine(hrs, k)}</span></div>`).join("")}</div>` : ""}`;
    body.querySelector("[data-myorders]")?.addEventListener("click", () => renderMyOrders());
    body.querySelector("[data-myresv]")?.addEventListener("click", () => renderMyResv());
  }

  app.innerHTML = "";
  app.appendChild(root);
  renderCartBar();
  renderCallButton();
  window.onscroll = null;
  window.scrollTo(0, y);
}

function openItemView(it, why) {
  const body = html(`<div>${it.imageUrl ? `<img class="hero" src="${esc(it.imageUrl)}" alt=""/>` : ""}${it.description ? `<p class="desc">${esc(it.description)}</p>` : ""}<div class="price-big">${it.unit === "estimate" ? "Quote after inspection" : money(it.price)}${it.durationMinutes && store.mode === "salon" ? ` <span class="muted small">· ~${it.durationMinutes} min</span>` : ""}</div>${why ? `<div class="c-alert warn" style="margin-top:12px">${esc(why)}</div>` : ""}</div>`);
  openSheet(it.name, body, html(`<div></div>`));
}
let imgCount = 0;
function itemRow(it, closedMsg, noService) {
  const inCart = cart.filter((l) => l.itemId === it.id).reduce((a, l) => a + l.qty, 0);
  const canOrder = it.available && !closedMsg && !noService;
  const quick = canOrder && !(it.options || []).length;
  const promo = itemPromo(it);
  const promoPrice = promo && promo.type !== "bogo" && (store.mode !== "salon" || promoActive(promo)) ? Math.max(0, it.price - lineDiscount(promo, it.price, it.price, 1).discount) : null;
  const card = html(`<div class="c-item ${it.available ? "" : "out"}">
    ${inCart ? `<span class="inbag"></span>` : ""}
    <div><div class="n">${inCart ? `<span class="inbag-n">${inCart}×</span>` : ""}${esc(it.name)}${promo ? ` <span class="c-badge">${esc(store.mode === "salon" ? salonPromoTag(promo) : promoLabel(promo))}</span>` : ""}${it.compareAt ? ` <span class="c-badge combo">COMBO</span>` : ""}${(store.bestsellers || []).includes(it.id) ? ` <span class="c-badge hot">🔥 Top pick</span>` : ""}${it.isNew ? ` <span class="c-badge new">NEW</span>` : ""}</div><div class="d">${esc(it.description)}</div>
      <div class="p">${store.mode === "salon" && (it.variants || []).length ? `<span style="font-size:.8rem;font-weight:600">from</span> ${money(Math.min(...it.variants.map((v) => Number(v.price) || 0)))}` : store.mode === "salon" && !Number(it.price) ? `<span style="font-size:.85rem">Price on consult</span>` : it.unit === "estimate" ? "Quote" : promoPrice != null ? `<s class="was">${money(it.compareAt || it.price)}</s> ${money(promoPrice)}` : it.compareAt ? `<s class="was">${money(it.compareAt)}</s> ${money(it.price)}` : money(it.price)}${store.mode === "salon" && it.durationMinutes ? `<span class="unit"> · ~${it.durationMinutes} min</span>` : it.unit === "estimate" ? `<span class="unit"> after inspection</span>` : it.unit && it.unit !== "piece" ? `<span class="unit"> / ${esc(it.unit)}</span>` : ""}${it.available ? "" : `<span class="out-tag">Sold out${it.soldUntil ? ` · back at ${new Date(it.soldUntil).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}` : ""}</span>`}</div>${sizePill(it)}</div>
    ${it.imageUrl ? `<div class="img"><img src="${esc(layoutOf() === "grid" ? it.imageUrl : it.thumbUrl || it.imageUrl)}" alt="" ${imgCount++ < 6 ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async"/>${quick ? `<button class="c-add" aria-label="Add ${esc(it.name)}">+</button>` : ""}</div>`
                  : `<div class="noimg">${quick ? `<button class="c-add" aria-label="Add ${esc(it.name)}">+</button>` : ""}</div>`}
  </div>`);
  // fade the photo in once loaded (listeners attached here; inline onload doesn't run on template-built nodes)
  const im = card.querySelector(".img img");
  if (im) { const done = () => im.classList.add("ok"); im.addEventListener("load", done); im.addEventListener("error", done); if (im.complete) done(); setTimeout(done, 4000); }
  const addBtn = card.querySelector(".c-add");
  if (addBtn) addBtn.onclick = (e) => { e.stopPropagation(); quickAdd(it); };
  if (store.mode === "salon") {
    if (it.available) {
      const pill = html(`<button class="c-bookpill" type="button">Book ›</button>`);
      (card.querySelector(".img") || card.querySelector(".noimg")).appendChild(pill);
      card.onclick = () => { bookSel = new Set([...(bookSel || []), it.id]); uiTab = "book"; renderMenu(); window.scrollTo({ top: 0 }); };
    }
    return card;
  }
  if (canOrder) card.onclick = () => openItem(it);
  else card.onclick = () => openItemView(it, closedMsg || (noService ? "Scan the QR code on your table to order." : it.available ? "" : it.soldUntil ? `Sold out — available again at ${new Date(it.soldUntil).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}.` : "Sold out right now."));
  return card;
}

function quickAdd(it) {
  const key = it.id + "||";
  const existing = cart.find((l) => l.key === key);
  if (existing) existing.qty += 1;
  else cart.push({ key, itemId: it.id, name: it.name, qty: 1, unitPrice: it.price, choices: [], note: "" });
  toast(`Added ${it.name}`);
  renderMenu(true);
}

// ---------------- ITEM SHEET ----------------
function openItem(it) {
  let qty = 1;
  const picked = {}; // group -> [labels]
  const body = html(`<div>
    ${it.imageUrl ? `<img class="hero" src="${esc(it.imageUrl)}" alt=""/>` : ""}
    ${it.description ? `<p class="desc">${esc(it.description)}</p>` : ""}
    <div class="price-big">${money(it.price)}</div>
    <div data-opts></div>
    <label>Note (optional)</label><input data-note placeholder="e.g. less ice, no onions" maxlength="120"/>
  </div>`);
  const opts = body.querySelector("[data-opts]");
  for (const g of it.options || []) {
    picked[g.name] = [];
    const box = html(`<div class="c-opt ${!g.multi && (g.choices || []).length <= 4 ? "pills" : ""}"><div class="t"><span>${esc(g.name)}</span>${g.required ? `<span class="req">Required</span>` : `<span class="muted small">${g.multi ? "Pick any" : "Optional"}</span>`}</div></div>`);
    for (const ch of g.choices || []) {
      const row = html(`<label class="c-choice"><input type="${g.multi ? "checkbox" : "radio"}" name="opt-${esc(g.name)}"/><span class="lbl">${esc(ch.label)}</span><span class="add">${ch.add ? "+" + money(ch.add) : ""}</span></label>`);
      row.querySelector("input").onchange = (e) => {
        if (g.multi) picked[g.name] = e.target.checked ? [...picked[g.name], ch.label] : picked[g.name].filter((l) => l !== ch.label);
        else picked[g.name] = [ch.label];
        updateTotal();
      };
      box.appendChild(row);
    }
    opts.appendChild(box);
  }
  const foot = html(`<div class="c-ftrow">
    <div class="c-qty"><button data-m>−</button><span data-q>1</span><button data-p>+</button></div>
    <button class="c-btn" data-add><span>Add to order</span><b data-tot></b></button>
  </div>`);
  const unit = () => it.price + Object.entries(picked).flatMap(([g, labels]) => labels.map((l) => (it.options.find((o) => o.name === g)?.choices.find((c) => c.label === l)?.add) || 0)).reduce((a, b) => a + b, 0);
  const updateTotal = () => { foot.querySelector("[data-tot]").textContent = money(unit() * qty); foot.querySelector("[data-q]").textContent = qty; };
  foot.querySelector("[data-m]").onclick = () => { qty = Math.max(1, qty - 1); updateTotal(); };
  foot.querySelector("[data-p]").onclick = () => { qty = Math.min(99, qty + 1); updateTotal(); };
  foot.querySelector("[data-add]").onclick = () => {
    for (const g of it.options || []) if (g.required && !picked[g.name].length) return toast(`Please choose ${g.name}`);
    const choices = Object.entries(picked).flatMap(([g, labels]) => labels.map((l) => ({ group: g, label: l, add: it.options.find((o) => o.name === g)?.choices.find((c) => c.label === l)?.add || 0 })));
    const note = body.querySelector("[data-note]").value.trim();
    const key = it.id + "|" + choices.map((c) => c.group + ":" + c.label).join(",") + "|" + note;
    const existing = cart.find((l) => l.key === key);
    if (existing) existing.qty += qty;
    else cart.push({ key, itemId: it.id, name: it.name, qty, unitPrice: unit(), choices, note });
    closeSheet();
    toast(`Added ${it.name}`);
    renderMenu(true);
  };
  updateTotal();
  openSheet(it.name, body, foot);
}

// ---------------- CART ----------------
const cartCount = () => cart.reduce((a, l) => a + l.qty, 0);
function lineInfo(l) {
  const it = (store.items || []).find((x) => x.id === l.itemId);
  const promo = it ? itemPromo(it) : null;
  const { discount, label } = lineDiscount(promo, it?.price || l.unitPrice, l.unitPrice, l.qty);
  return { gross: l.unitPrice * l.qty, discount, label, net: l.unitPrice * l.qty - discount };
}
const cartSubtotal = () => cart.reduce((a, l) => a + lineInfo(l).net, 0);
const cartPromoDiscount = () => cart.reduce((a, l) => a + lineInfo(l).discount, 0);
let voucher = null; // { code, discount }

function renderCartBar() {
  document.querySelector(".c-cartbar")?.remove();
  if (!cartCount()) return;
  const bar = html(`<div class="c-cartbar"><button><span class="cnt">${cartCount()}</span><span class="lbl">Review order</span><span class="tot">${money(cartSubtotal())}</span></button></div>`);
  bar.querySelector("button").onclick = openCart;
  document.body.appendChild(bar);
}

function openCart() {
  const svc = store.service || {};
  const isAdd = !!addTo;
  const freeDelOf = (sub) => (serviceType === "delivery" && !isAdd ? freeDeliveryPromo(store.promos || [], sub) : null);
  const freeDelAny = serviceType === "delivery" && !isAdd ? (store.promos || []).filter((p) => p.type === "free_delivery" && promoActive(p)).sort((a, b) => (a.value || 0) - (b.value || 0))[0] : null;
  const feeByCounterBase = serviceType === "delivery" && svc.deliveryFeeMode === "counter" && !isAdd;
  const baseFee = serviceType === "delivery" && !feeByCounterBase && !isAdd ? Number(svc.deliveryFee) || 0 : 0;
  let feeByCounter = feeByCounterBase, fee = baseFee;
  const smallFor = Array.isArray(svc.smallOrderFor) && svc.smallOrderFor.length ? svc.smallOrderFor : ["delivery"];
  const smallFeeOf = (sub) => (!isAdd && Number(svc.smallOrderMin) > 0 && Number(svc.smallOrderFee) > 0 && smallFor.includes(serviceType) && sub < Number(svc.smallOrderMin) ? Number(svc.smallOrderFee) : 0);
  const needInfo = !isAdd && (serviceType === "pickup" || serviceType === "delivery");
  const saved = loadLocal().customer || {};
  const payMethods = needInfo ? (store.payments || []).filter((m) => !m.forServices?.length || m.forServices.includes(serviceType)) : [];
  const body = html(`<div>
    <div data-lines></div>
    <div class="c-total"><span>Subtotal</span><span data-sub></span></div>
    <div class="c-total hidden" data-promorow><span>Promo savings</span><span data-promo></span></div>
    <div class="c-voucher"><input data-vcode placeholder="Voucher code" style="text-transform:uppercase"/><button class="c-btn ghost sm" type="button" data-vapply>Apply</button></div>
    ${store.loyalty && !isAdd ? `<div class="c-loy" data-loy></div><div class="c-total hidden" data-lrow><span>🎁 Loyalty reward</span><span data-ldisc></span></div>` : ""}
    <div class="c-total hidden" data-vrow><span>Voucher <b data-vcodelbl></b> <a href="#" data-vremove class="small">remove</a></span><span data-vdisc></span></div>
    ${isAdd ? `<div class="c-alert ok" style="margin:8px 0"><b>➕ Add-on to order #${esc(addTo.orderNo)}</b> — it goes on the same bill.</div>${addTo.serviceType === "dine_in" ? `<label class="c-agree" style="margin:4px 0 8px"><input type="checkbox" data-pack/> 🥡 Pack these to take home (take-out)</label>` : ""}` : ""}
    <div class="c-total" data-feerow ${serviceType === "delivery" && !isAdd ? "" : 'style="display:none"'}><span>Delivery fee</span><span data-fee></span></div>
    <div class="c-total" data-smallrow style="display:none"><span>Small-order fee</span><span data-small></span></div>
    <div class="c-nudge" data-nudge style="display:none"></div>
    <div class="c-total big"><span data-totlbl>Total</span><span data-total></span></div>
    ${isAdd ? "" : `<label>Name ${needInfo ? "" : "(optional)"}</label><input data-name value="${esc(saved.name || "")}" placeholder="Your name"/>`}
    ${needInfo ? `<label>Phone number</label><input data-phone type="tel" value="${esc(saved.phone || "")}" placeholder="09XX XXX XXXX"/>${msgrField(saved)}` : ""}
    ${serviceType === "delivery" ? `<label>Delivery address</label><input data-address value="${esc(saved.address || "")}" placeholder="House no., street, barangay"/>` : ""}
    ${needInfo && svc.allowSchedule !== false ? `<label>When?</label>
      <div class="c-service" style="padding:0"><button type="button" data-when="asap" class="active">⚡ ASAP</button><button type="button" data-when="later">⏰ Pick a time</button></div>
      <div data-slots class="hidden" style="margin-top:8px"><div class="c-grid2"><div><label>Date</label><select data-sdate></select></div><div><label>Time</label><select data-stime></select></div></div></div>` : ""}
    ${payMethods.length ? `<label>Payment</label>
      <div class="c-pick" data-pays>${payMethods.map((m) => `<button type="button" data-id="${m.id}"><b>${esc(m.name)}</b><span>${m.type === "cash" ? (serviceType === "delivery" ? "Pay the rider on delivery" : "Pay at the counter") : m.type === "card" ? "Card at the counter" :`${esc(m.number || "")}${m.accountName ? " · " + esc(m.accountName) : ""}`}</span></button>`).join("")}</div>
      <div data-paydetail style="margin-top:8px"></div>` : ""}
    <label>Order note (optional)</label><input data-onote placeholder="Anything else?" maxlength="300"/>
    <p class="small muted" style="margin:10px 0 0">🔒 Orders can't be cancelled once sent. Need a change? Message or call the store.</p>
    <div data-err></div>
  </div>`);
  // --- payment picker ---
  let payMethodId = null, changeFor = null, gWhen = "now";
  const sendsNow = () => !(serviceType === "delivery" && gWhen === "arrival");
  const isRemote = () => ["pickup", "delivery"].includes(serviceType) || !!preorderFor;
  const setPlaceLabel = () => {
    let b; try { b = foot.querySelector("[data-place] span"); } catch { return; } // foot is created further down
    if (!b) return;
    const m = payMethods.find((x) => x.id === payMethodId);
    b.textContent = m && !["cash", "card"].includes(m.type) && isRemote() && sendsNow() ? `I've sent · Place order` : "Place order";
  };
  const payEl = body.querySelector("[data-pays]"), payDetail = body.querySelector("[data-paydetail]");
  if (payEl) {
    const pick = (m) => {
      payMethodId = m.id; changeFor = null;
      payEl.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x.dataset.id === m.id));
      if (m.type === "cash") {
        const total = cartSubtotal() + fee + smallFeeOf(cartSubtotal());
        const bills = [total, 200, 500, 1000].filter((v, i, a) => v >= total && a.indexOf(v) === i);
        payDetail.innerHTML = `<div class="small muted" style="margin-bottom:6px">Change for:</div><div class="c-pax wide" data-bills>${bills.map((v) => `<button type="button" data-v="${v}" class="${v === total ? "on" : ""}">${v === total ? "Exact" : money(v)}</button>`).join("")}<button type="button" data-v="other">Other</button></div>`;
        changeFor = total;
        payDetail.querySelectorAll("[data-v]").forEach((b) => (b.onclick = () => { payDetail.querySelectorAll("[data-v]").forEach((x) => x.classList.toggle("on", x === b)); if (b.dataset.v === "other") { const v = prompt("How much cash will you pay with?", ""); changeFor = Number(v) || total; b.textContent = money(changeFor); } else changeFor = Number(b.dataset.v); }));
      } else if (m.type === "card") { payDetail.innerHTML = `<div class="small muted">Pay by card at the counter.</div>`; }
      else {
        // One-tap GCash: remote orders send now and tap "I've sent"; at the store you just pay at the counter.
        const amt = money(cartSubtotal() + fee + smallFeeOf(cartSubtotal()));
        const remote = isRemote();
        const arrivalOpt = serviceType === "delivery";
        payDetail.innerHTML = remote
          ? `${arrivalOpt ? `<div class="c-service" style="padding:4px;margin:0 0 8px"><button type="button" data-gwhen="now" class="${gWhen === "now" ? "active" : ""}">Send now</button><button type="button" data-gwhen="arrival" class="${gWhen === "arrival" ? "active" : ""}">When the rider arrives</button></div>` : ""}${arrivalOpt && gWhen === "arrival" ? `<div class="c-paybox"><div><b>${esc(m.name)} on delivery</b><div class="small muted">Send ${amt} to ${esc(m.number || "the store")} when the rider arrives — the rider confirms it.</div></div></div>` : `<div class="c-paybox">${m.qrUrl ? `<img src="${esc(m.qrUrl)}" alt="QR"/>` : ""}<div><div><b>${esc(m.name)}</b> ${esc(m.number || "")} ${m.number ? `<button type="button" class="c-copy" data-copy="${esc(String(m.number).replace(/\s/g, ""))}">Copy</button>` : ""}</div><div class="small muted">${esc(m.accountName || "")}</div><div class="small" style="margin-top:4px">Send <b>${amt}</b>, then tap <b>I've sent</b>. The store checks their ${esc(m.name)} and confirms.</div></div></div>
            ${m.askRef === true ? `<label>Reference number</label><input data-ref placeholder="e.g. 1234 567 890" maxlength="60"/>` : `<details class="c-refopt"><summary>Add reference no. (optional)</summary><input data-ref placeholder="e.g. 1234 567 890" maxlength="60"/></details>`}`}`
          : `<div class="c-paybox"><div><div><b>Pay with ${esc(m.name)} at the counter</b></div><div class="small muted">Scan the store's ${esc(m.name)} QR or send to ${esc(m.number || "the store")} when you pay — staff will confirm.</div></div></div>`;
        payDetail.querySelectorAll("[data-gwhen]").forEach((b) => (b.onclick = () => { gWhen = b.dataset.gwhen; pick(m); }));
        payDetail.querySelector("[data-copy]")?.addEventListener("click", async (e) => { try { await navigator.clipboard.writeText(e.target.dataset.copy); e.target.textContent = "Copied ✓"; } catch { e.target.textContent = e.target.dataset.copy; } });
      }
      setPlaceLabel();
    };
    payEl.querySelectorAll("button").forEach((b) => (b.onclick = () => pick(payMethods.find((m) => m.id === b.dataset.id))));
    if (payMethods.length === 1) pick(payMethods[0]);
  }
  // --- schedule picker ---
  let whenMode = "asap";
  const slotsEl = body.querySelector("[data-slots]");
  if (slotsEl) {
    const lead = (Number(svc.scheduleLeadMin) || 30) * 60000;
    const dsel = body.querySelector("[data-sdate]"), tsel = body.querySelector("[data-stime]");
    const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() + i); return d; });
    dsel.innerHTML = days.map((d, i) => `<option value="${i}">${i === 0 ? "Today" : i === 1 ? "Tomorrow" : d.toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric" })}</option>`).join("");
    const fillTimes = () => {
      const d = days[Number(dsel.value)];
      const rgs = rangesFor(store.hours, DAYS[d.getDay()]);
      const inRange = (t) => !rgs.length ? t >= "08:00" && t <= "22:00" : rgs.some(([o, c]) => (c > o ? t >= o && t <= c : t >= o || t <= c));
      const opts = [];
      for (let m = 0; m < 24 * 60; m += 15) {
        const hh = String(Math.floor(m / 60)).padStart(2, "0"), mm = String(m % 60).padStart(2, "0"), t = `${hh}:${mm}`;
        if (!inRange(t)) continue;
        const when = new Date(d); when.setHours(Math.floor(m / 60), m % 60, 0, 0);
        if (when.getTime() < Date.now() + lead) continue;
        opts.push(`<option value="${when.toISOString()}">${when.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}</option>`);
      }
      tsel.innerHTML = opts.join("") || `<option value="">No available times</option>`;
    };
    dsel.onchange = fillTimes; fillTimes();
    if (advanceOnly()) { // closed now → order for later only
      whenMode = "later"; slotsEl.classList.remove("hidden");
      body.querySelector('[data-when="asap"]')?.remove(); body.querySelector('[data-when="later"]')?.classList.add("active");
      if (!tsel.value) { dsel.value = "1"; fillTimes(); }
    }
    body.querySelectorAll("[data-when]").forEach((b) => (b.onclick = () => { whenMode = b.dataset.when; body.querySelectorAll("[data-when]").forEach((x) => x.classList.toggle("active", x === b)); slotsEl.classList.toggle("hidden", whenMode !== "later"); }));
  }
  const foot = html(`<div class="c-ftrow"><button class="c-btn brand block" data-place><span>Place order</span><b data-ft></b></button></div>`);
  setTimeout(setPlaceLabel, 0);
  const serviceLabel = Object.fromEntries(availableServices())[serviceType] || serviceType;

  function draw() {
    const lines = body.querySelector("[data-lines]");
    lines.innerHTML = "";
    if (!cart.length) { closeSheet(); renderMenu(true); return; }
    cart.forEach((l) => {
      const row = html(`<div class="c-line">
        <div><div class="n">${esc(l.name)}</div><div class="m">${l.choices.map((c) => esc(c.label)).join(", ")}${l.note ? (l.choices.length ? " · " : "") + esc(l.note) : ""}</div></div>
        <div class="r"><div>${money(l.unitPrice * l.qty)}</div><div class="c-qty"><button data-m>−</button><span>${l.qty}</span><button data-p>+</button></div></div>
      </div>`);
      const li = lineInfo(l);
      if (li.discount) row.querySelector(".r > div").innerHTML = `<s class="was">${money(li.gross)}</s> ${money(li.net)} <span class="c-badge">${esc(li.label)}</span>`;
      row.querySelector("[data-m]").onclick = () => { l.qty--; if (l.qty <= 0) cart = cart.filter((x) => x !== l); draw(); };
      row.querySelector("[data-p]").onclick = () => { l.qty = Math.min(99, l.qty + 1); draw(); };
      lines.appendChild(row);
    });
    const sub = cartSubtotal(), pd = cartPromoDiscount();
    body.querySelector("[data-sub]").textContent = money(sub);
    body.querySelector("[data-promorow]").classList.toggle("hidden", !pd);
    body.querySelector("[data-promo]").textContent = "−" + money(pd);
    const vd = voucher ? Math.min(voucher.discount, sub) : 0;
    body.querySelector("[data-vrow]").classList.toggle("hidden", !voucher);
    body.querySelector(".c-voucher").classList.toggle("hidden", !!voucher);
    if (voucher) { body.querySelector("[data-vcodelbl]").textContent = voucher.code; body.querySelector("[data-vdisc]").textContent = "−" + money(vd); }
    const fd = freeDelOf(sub);
    fee = fd ? 0 : baseFee; feeByCounter = fd ? false : feeByCounterBase;
    const small = smallFeeOf(sub);
    const feeEl = body.querySelector("[data-fee]");
    if (feeEl) feeEl.innerHTML = fd ? `<s class="was">${baseFee ? money(baseFee) : ""}</s> <b style="color:var(--ok, #1d7b55)">FREE</b>` : feeByCounter ? `<span class="muted small">set by the store based on your address</span>` : money(fee);
    body.querySelector("[data-smallrow]").style.display = small ? "" : "none";
    body.querySelector("[data-small]").textContent = money(small);
    const nudges = [];
    if (small) nudges.push(`Add <b>${money(Number(svc.smallOrderMin) - sub)}</b> more to skip the ${money(small)} small-order fee.`);
    if (!fd && freeDelAny && sub < Number(freeDelAny.value || 0)) nudges.push(`Add <b>${money(Number(freeDelAny.value) - sub)}</b> more for <b>FREE delivery</b> 🛵`);
    const ng = body.querySelector("[data-nudge]"); ng.style.display = nudges.length ? "" : "none"; ng.innerHTML = nudges.join("<br>");
    body.querySelector("[data-totlbl]").textContent = feeByCounter ? "Total (before delivery fee)" : "Total";
    const ld = useReward && loy ? Math.min(loy.rewardValue || 0, Math.max(0, sub - vd)) : 0;
    body.querySelector("[data-lrow]")?.classList.toggle("hidden", !ld); if (ld) body.querySelector("[data-ldisc]").textContent = "−" + money(ld);
    const total = Math.max(0, sub - vd - ld) + fee + small;
    body.querySelector("[data-total]").textContent = money(total);
    foot.querySelector("[data-ft]").textContent = money(total);
  }
  // ⭐ loyalty card (by mobile number)
  let loy = null, useReward = false;
  const loyBox = body.querySelector("[data-loy]");
  const drawLoy = () => {
    if (!loyBox) return;
    if (!loy) { loyBox.innerHTML = `<span>⭐ <b>${esc(store.loyalty.rewardText || "Loyalty reward")}</b> after ${store.loyalty.stamps} stamps${store.loyalty.minTotal ? ` · 1 stamp per order of ${money(store.loyalty.minTotal)}+` : ""}. Enter your mobile number to see your card.</span>`; return; }
    const full = loy.stamps >= loy.of;
    loyBox.innerHTML = `<div class="c-stamps">${Array.from({ length: loy.of }, (_, i) => `<i class="${i < loy.stamps ? "on" : ""}"></i>`).join("")}</div><span><b>${Math.min(loy.stamps, loy.of)}/${loy.of} stamps</b>${full ? ` — your reward is ready!` : ` · ${loy.of - loy.stamps} more for ${esc(loy.rewardText || "a reward")}`}</span>${full ? `<label class="check" style="margin:6px 0 0"><input type="checkbox" data-usereward ${useReward ? "checked" : ""}/> Use my reward now: ${esc(loy.rewardText || "")} (−${money(loy.rewardValue)})</label>` : ""}`;
    loyBox.querySelector("[data-usereward]")?.addEventListener("change", (e) => { useReward = e.target.checked; draw(); });
  };
  const loadLoy = async () => {
    const ph = (body.querySelector("[data-phone]")?.value || loadLocal().customer?.phone || "").replace(/\D/g, "");
    if (!loyBox || ph.length < 10) { loy = null; useReward = false; drawLoy(); draw(); return; }
    try { const r = await call("myStamps", { slug, phone: ph }); loy = r && typeof r.stamps === "number" && r.of ? r : null; } catch { loy = null; }
    if (!loy || loy.stamps < loy.of) useReward = false;
    drawLoy(); draw();
  };
  if (loyBox) { drawLoy(); loadLoy(); body.querySelector("[data-phone]")?.addEventListener("change", loadLoy); }
  body.querySelector("[data-vapply]").onclick = async () => {
    const code = body.querySelector("[data-vcode]").value.trim().toUpperCase();
    if (!code) return;
    try {
      const r = await call("checkVoucher", { slug, code, subtotal: cartSubtotal(), serviceType, phone: body.querySelector("[data-phone]")?.value || loadLocal().customer?.phone || "" });
      voucher = { code: r.code, discount: r.discount }; toast(`Voucher applied: −${money(r.discount)}`); draw();
    } catch (e) { toast(e.message || "Invalid voucher"); }
  };
  body.querySelector("[data-vremove]").onclick = (e) => { e.preventDefault(); voucher = null; draw(); };
  draw();

  foot.querySelector("[data-place]").onclick = async () => {
    const btn = foot.querySelector("[data-place]");
    const err = body.querySelector("[data-err]");
    const customer = {
      name: body.querySelector("[data-name]")?.value.trim() || "",
      phone: body.querySelector("[data-phone]")?.value.trim() || "",
      address: body.querySelector("[data-address]")?.value.trim() || "",
      messenger: readMsgr(body),
    };
    err.innerHTML = "";
    if (store.qrMode === "single" && serviceType === "dine_in" && !table) { closeSheet(); return pickTable(() => openCart()); }
    if (needInfo && (!customer.name || !customer.phone)) return (err.innerHTML = `<div class="c-alert error">Name and phone number are required.</div>`);
    if (slotsEl && whenMode === "later" && !body.querySelector("[data-stime]").value) return (err.innerHTML = `<div class="c-alert error">Please pick a time.</div>`);
    if (payMethods.length && !payMethodId) return (err.innerHTML = `<div class="c-alert error">Please choose a payment method.</div>`);
    const pm = payMethods.find((m) => m.id === payMethodId);
    const refNo = body.querySelector("[data-ref]")?.value.trim() || "";
    if (pm && !["cash", "card"].includes(pm.type) && isRemote() && sendsNow() && pm.askRef === true && refNo.length < 4) return (err.innerHTML = `<div class="c-alert error">Enter your ${esc(pm.name)} reference number.</div>`);
    if (serviceType === "delivery" && !customer.address) return (err.innerHTML = `<div class="c-alert error">Delivery address is required.</div>`);
    btn.disabled = true; btn.textContent = "Placing order…";
    try {
      const res = await call("placeOrder", {
        slug, serviceType, tableToken: tableToken || null, tableId: !tableToken && table ? table.id : null,
        items: cart.map((l) => ({ itemId: l.itemId, qty: l.qty, choices: l.choices.map((c) => ({ group: c.group, label: c.label })), note: l.note })),
        customer, note: body.querySelector("[data-onote]").value.trim(),
        scheduledAt: slotsEl && whenMode === "later" ? body.querySelector("[data-stime]").value || null : null,
        payment: payMethodId ? { methodId: payMethodId, changeFor, refNo, sent: !!(pm && !["cash", "card"].includes(pm.type) && isRemote() && sendsNow()) } : null,
        voucherCode: voucher?.code || null, useReward: !!useReward,
        reservationId: preorderFor?.id || null,
        addTo: addTo?.id || null,
        pack: !!body.querySelector("[data-pack]")?.checked,
      });
      setAddTo(null);
      voucher = null;
      if (preorderFor) { preorderFor = null; sessionStorage.removeItem("orderqr:preorder:" + slug); }
      if (customer.name || customer.phone) saveLocal({ customer: { ...(loadLocal().customer || {}), ...Object.fromEntries(Object.entries(customer).filter(([, v]) => v)) } });
      const rec = { id: res.orderId, storeId: res.storeId, at: Date.now() };
      myOrders = [rec, ...myOrders].slice(0, 10);
      saveLocal({ orders: myOrders, lastOrder: rec });
      cart = [];
      closeSheet();
      renderStatus(rec);
    } catch (e) {
      console.error(e);
      err.innerHTML = `<div class="c-alert error">${esc(e.message || "Couldn't place your order. Please try again.")}</div>`;
      btn.disabled = false; btn.innerHTML = `<span>Place order</span><b data-ft></b>`; setPlaceLabel(); try { draw(); } catch {}
    }
  };
  openSheet(`Your order`, body, foot, `${serviceLabel}${table ? " — " + table.label : ""}`);
}

// ---------------- ORDER STATUS ----------------
const STAGES = {
  table:   [["pending", "Order received", "Waiting for the store to accept"], ["preparing", "Preparing", "Your order is being made"], ["ready", "Ready", "Ready — being served / ready to collect"], ["completed", "Completed", "Thank you!"]],
  delivery:[["pending", "Order received", "Waiting for the store to accept"], ["preparing", "Preparing", "Your order is being made"], ["ready", "Ready", "Waiting for the rider"], ["out_for_delivery", "Out for delivery", "On its way to you"], ["delivered", "Delivered", "Thank you!"]],
  pickup_t:[["pending", "Order received", "Waiting for the store to accept"], ["preparing", "Preparing", "Your order is being made"], ["ready", "Ready for pickup", "Ready to collect at the counter"], ["completed", "Picked up", "Thank you!"]],
  pickup:  [["received", "Received", "We've got it"], ["processing", "Processing", "In progress"], ["ready", "Ready for pickup", "Ready to collect"], ["picked_up", "Picked up", "Thank you!"]],
  booking: [["pending", "Requested", "Waiting for confirmation"], ["confirmed", "Confirmed", "You're scheduled"], ["in_progress", "In progress", ""], ["done", "Done", "Thank you!"]],
  laundry: [["received", "Received", "Your laundry is with us"], ["weighed", "Weighed & priced", "Final price is set"], ["washing", "Washing", "In the washer"], ["drying", "Drying", "In the dryer"], ["folding", "Folding", "Being folded / pressed"], ["ready", "Ready for pickup", "Bring your claim stub"], ["claimed", "Claimed", "Thank you!"]],
};
// ===================== SALON: team, book, status =====================
// stylist schedule for customers: today's status + the week + upcoming leaves
const WK = [["mon", "Mon"], ["tue", "Tue"], ["wed", "Wed"], ["thu", "Thu"], ["fri", "Fri"], ["sat", "Sat"], ["sun", "Sun"]];
function teamSchedHTML(sc) {
  const phNow = new Date(Date.now() + 8 * 3600e3), ymd = phNow.toISOString().slice(0, 10), todayK = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"][phNow.getUTCDay()];
  const leaves = (sc?.leaves || []).filter((d) => d >= ymd);
  const hm = (d) => (d.from && d.to ? `${fmt12(d.from)}–${fmt12(d.to)}` : "Shop hours");
  let status;
  if (leaves.includes(ymd)) status = `<span class="c-sched-st off">🌴 On leave today</span>`;
  else if (sc?.days && sc.days[todayK] && !sc.days[todayK].on) status = `<span class="c-sched-st off">Day off today</span>`;
  else status = `<span class="c-sched-st on">● Working today${sc?.days?.[todayK]?.from ? ` · ${hm(sc.days[todayK])}` : ""}</span>`;
  const week = sc?.days ? `<div class="c-sched-week">${WK.map(([k, l]) => { const d = sc.days[k]; const on = !d || d.on; return `<div class="${on ? "" : "off"} ${k === todayK ? "today" : ""}"><b>${l}</b><span>${on ? (d ? hm(d) : "Shop hours") : "Off"}</span></div>`; }).join("")}</div>` : `<div class="small muted">Available during shop hours.</div>`;
  const brk = sc?.breakFrom && sc?.breakTo ? `<div class="small muted">Break ${fmt12(sc.breakFrom)}–${fmt12(sc.breakTo)}</div>` : "";
  const lv = leaves.filter((d) => d !== ymd).length ? `<div class="small">🌴 On leave: ${leaves.filter((d) => d !== ymd).map((d) => new Date(d + "T00:00:00").toLocaleDateString("en-PH", { month: "short", day: "numeric" })).join(", ")}</div>` : "";
  return `<details class="c-sched"><summary>${status}<span class="small muted">Schedule ▾</span></summary>${week}${brk}${lv}</details>`;
}
function renderTeam(body) {
  const team = store.team || []; const cats = store.categories || [];
  body.innerHTML = `<div class="c-team">${team.map((t) => `<div class="c-member"><div class="av">${t.photoUrl ? `<img src="${esc(t.photoUrl)}" alt=""/>` : esc(t.name[0] || "·")}</div><div><b>${esc(t.name)}</b> <span class="small" data-tlive="${esc(t.id)}"></span>${t.rating ? ` <span class="small" style="color:var(--accent);font-weight:700">★ ${t.rating.avg.toFixed(1)}</span> <span class="small muted">(${t.rating.n})</span>` : ""}${t.bio ? `<div class="muted small">${esc(t.bio)}</div>` : ""}<div class="small">${(t.skills || []).map((k) => cats.find((c) => c.id === k)?.name).filter(Boolean).map((n) => `<span class="c-skill">${esc(n)}</span>`).join(" ")}</div></div><button class="c-btn ghost sm" data-with="${esc(t.id)}">Book with ${esc(t.name.split(" ")[0])}</button></div>${teamSchedHTML(t.schedule)}${(t.portfolio || []).length ? `<div class="c-portfolio">${t.portfolio.map((p) => `<a href="${esc(p.url)}" target="_blank" rel="noopener"><img src="${esc(p.url)}" alt="${esc(p.service || p.label || "")}" loading="lazy"/>${p.label || p.service ? `<span>${esc([p.label, p.service].filter(Boolean).join(" · "))}</span>` : ""}</a>`).join("")}</div>` : ""}`).join("") || `<p class="muted" style="text-align:center;margin-top:30px">Team profiles coming soon.</p>`}</div>`;
  body.querySelectorAll("[data-with]").forEach((b) => (b.onclick = () => { bookPrefProvider = b.dataset.with; uiTab = "book"; renderMenu(); }));
  loadLive().then((av) => (av?.staff || []).forEach((x) => { const el = body.querySelector(`[data-tlive="${x.id}"]`); if (el) el.textContent = staffLiveText(x); }));
}
// ---------------- GIFT CARDS ----------------
const giftOn = () => !!(store?.salon?.giftcards?.enabled && store.pro?.giftcards !== false);
function renderGiftShop(body) {
  const gc = store.salon.giftcards; const saved = loadLocal().customer || {};
  const amounts = (gc.amounts && gc.amounts.length ? gc.amounts : [500, 1000, 2000, 3000]).map(Number);
  const pays = (store.payments || []).filter((m) => m.type !== "cash");
  const mine = loadLocal().gifts || [];
  let amount = amounts[1] || amounts[0], design = "classic";
  body.innerHTML = `<div class="c-card-soft"><h2>🎁 Give a gift card</h2>
    ${mine.length ? `<div class="c-chips" style="margin-bottom:10px">${mine.map((g) => `<button type="button" class="chip" data-mine="${esc(g.id)}">My gift card · ${money(g.amount)}</button>`).join("")}</div>` : ""}
    <canvas data-prev style="width:100%;border-radius:18px;box-shadow:0 10px 30px rgba(0,0,0,.18)"></canvas>
    <div class="c-step"><span>1</span> Design</div><div class="c-chips">${Object.entries(GIFT_DESIGNS).map(([k, d]) => `<button type="button" class="chip ${k === design ? "on" : ""}" data-design="${k}">${d.emoji} ${d.name}</button>`).join("")}</div>
    <div class="c-step"><span>2</span> Amount</div><div class="c-chips">${amounts.map((a) => `<button type="button" class="chip ${a === amount ? "on" : ""}" data-amt="${a}">${money(a)}</button>`).join("")}<input data-custom type="number" inputmode="numeric" placeholder="Other" style="max-width:110px" min="${gc.min || 300}" max="${gc.max || 20000}"/></div>
    <div class="c-step"><span>3</span> Details</div>
    <label>For (recipient's name)</label><input data-to maxlength="40" placeholder="e.g. Ella"/>
    <label>Message (optional)</label><input data-msg maxlength="120" placeholder="Happy birthday! Treat yourself 💛"/>
    <label>From (your name)</label><input data-from value="${esc(saved.name || "")}"/>
    <label>Your mobile number</label><input data-fphone type="tel" value="${esc(saved.phone || "")}" placeholder="09XX XXX XXXX"/>
    <div class="c-step"><span>4</span> Payment</div>
    ${pays.length ? `<div class="c-chips">${pays.map((m, i) => `<button type="button" class="chip ${i === 0 ? "on" : ""}" data-pm="${esc(m.id)}">${esc(m.name)}</button>`).join("")}</div><div data-pinfo class="small" style="margin:6px 0"></div>
      <details class="c-refopt"><summary>Add reference no. or screenshot (optional)</summary><input data-ref2 inputmode="numeric" placeholder="e.g. 1234 5678 9012"/><input type="file" accept="image/*" data-proof style="margin-top:6px"/></details><p class="small muted" style="margin:6px 0 0">Send the amount, then tap <b>I've sent</b>.</p>` : `<div class="c-alert warn">Please message us to buy a gift card.</div>`}
    <p class="small muted">The salon checks your payment, then your gift card becomes active — download it and send it to ${"the recipient"}. Valid ${gc.validMonths || 12} months.</p>
    <div class="c-bookbar"><button class="c-btn brand block" data-buy ${pays.length ? "" : "disabled"}>Buy gift card</button></div></div>`;
  const g = (x) => body.querySelector(x);
  let logo = null; loadLogo(store.logoUrl).then((im) => { logo = im; prev(); });
  const prev = () => drawGiftCard(g("[data-prev]"), { storeName: store.name, logoImg: logo, amount, to: g("[data-to]").value || "Someone special", from: g("[data-from]").value, message: g("[data-msg]").value, code: "GC-XXXX-XXXX", design, status: "preview" });
  const info = (id) => { const m = pays.find((x) => x.id === id); if (m && g("[data-pinfo]")) g("[data-pinfo]").innerHTML = `Send <b>${money(amount)}</b> to ${m.accountName ? `<b>${esc(m.accountName)}</b> · ` : ""}${esc(m.number || "")}${m.qrUrl ? `<br><img src="${esc(m.qrUrl)}" alt="QR" style="max-width:160px;border-radius:10px;margin-top:6px"/>` : ""}`; };
  body.querySelectorAll("[data-design]").forEach((b) => (b.onclick = () => { design = b.dataset.design; body.querySelectorAll("[data-design]").forEach((x) => x.classList.toggle("on", x === b)); prev(); }));
  body.querySelectorAll("[data-amt]").forEach((b) => (b.onclick = () => { amount = Number(b.dataset.amt); g("[data-custom]").value = ""; body.querySelectorAll("[data-amt]").forEach((x) => x.classList.toggle("on", x === b)); prev(); info(body.querySelector("[data-pm].on")?.dataset.pm); }));
  g("[data-custom]").oninput = (e) => { const v = Number(e.target.value || 0); if (v) { amount = v; body.querySelectorAll("[data-amt]").forEach((x) => x.classList.remove("on")); prev(); info(body.querySelector("[data-pm].on")?.dataset.pm); } };
  ["[data-to]", "[data-msg]", "[data-from]"].forEach((k) => (g(k).oninput = prev));
  body.querySelectorAll("[data-pm]").forEach((b) => (b.onclick = () => { body.querySelectorAll("[data-pm]").forEach((x) => x.classList.toggle("on", x === b)); info(b.dataset.pm); }));
  body.querySelectorAll("[data-mine]").forEach((b) => (b.onclick = () => renderGiftStatus(mine.find((x) => x.id === b.dataset.mine))));
  info(pays[0]?.id); prev();
  g("[data-buy]").onclick = async (e) => {
    const to = g("[data-to]").value.trim(), from = g("[data-from]").value.trim(), phone = g("[data-fphone]").value.trim(), refNo = g("[data-ref2]")?.value.trim() || "";
    if (!to || !from || !phone) return toast("Enter the recipient, your name and mobile number");
    // one-tap: the reference no. is optional
    e.target.disabled = true; e.target.textContent = "Sending…";
    try {
      const f = g("[data-proof]")?.files?.[0]; let proofUrl = null;
      if (f) { try { proofUrl = await uploadPrivateImage(store.storeId, auth.currentUser.uid, f, { max: 1200 }); } catch {} }
      const r = await call("buyGiftCard", { slug, amount, design, to: { name: to }, from: { name: from, phone }, message: g("[data-msg]").value.trim(), payment: { methodId: body.querySelector("[data-pm].on")?.dataset.pm, refNo, proofUrl } });
      const rec = { id: r.id, storeId: r.storeId, amount, at: Date.now() };
      saveLocal({ customer: { ...saved, name: from, phone }, gifts: [rec, ...mine].slice(0, 10) });
      renderGiftStatus(rec);
    } catch (err) { toast(err.message); e.target.disabled = false; e.target.textContent = "Buy gift card"; }
  };
}
let giftUnsub = null;
function renderGiftStatus(rec) {
  giftUnsub?.(); window.onscroll = null; renderCartBar();
  app.innerHTML = `<div class="c-status"><div class="c-loading" style="min-height:40vh"><div class="c-spinner"></div></div></div>`;
  let logo = null; const lp = loadLogo(store.logoUrl).then((im) => (logo = im));
  giftUnsub = onSnapshot(doc(db, "stores", rec.storeId, "giftcards", rec.id), async (snap) => {
    if (!snap.exists()) { giftUnsub?.(); return renderMenu(); }
    const x = snap.data(); await lp;
    const st = x.status === "active" && x.expires < Date.now() ? "expired" : x.status;
    app.innerHTML = `<div><header class="c-head"><div class="top"><div class="logo">${store.logoUrl ? `<img src="${esc(store.logoUrl)}" alt=""/>` : esc(store.name.trim()[0] || "·")}</div><div><h1>${esc(store.name)}</h1><div class="sub">Gift card</div></div></div></header>${seasonBar()}
      <div class="c-status">
        <canvas data-card style="width:100%;border-radius:18px;box-shadow:0 10px 30px rgba(0,0,0,.18)"></canvas>
        ${st === "pending" ? `<div class="c-alert warn">⏳ Waiting for the salon to check your ${esc(x.payment?.methodName || "")} payment (ref ${esc(x.payment?.refNo || "")}). This page updates by itself — your code appears here once it's confirmed.</div>`
          : st === "rejected" ? `<div class="c-alert error">We couldn't confirm this payment${x.rejectNote ? `: ${esc(x.rejectNote)}` : ""}. Please message the salon.</div>`
          : st === "active" ? `<div class="c-alert ok">✅ Active · balance <b>${money(x.balance)}</b>${x.balance < x.amount ? ` of ${money(x.amount)}` : ""} · valid until ${new Date(x.expires).toLocaleDateString("en-PH", { dateStyle: "medium" })}</div><button class="c-btn brand block" data-dl>⬇ Download gift card (PNG)</button><button class="c-btn ghost block" data-sharegc style="margin-top:8px">📤 Share</button>`
          : `<div class="c-alert">This gift card is ${esc(st)}.</div>`}
        <button class="c-btn ghost block" data-back style="margin-top:8px">Back</button>
      </div></div>`;
    const cv = drawGiftCard(app.querySelector("[data-card]"), { storeName: store.name, logoImg: logo, amount: x.amount, to: x.to?.name, from: x.from?.name, message: x.message, code: st === "active" || st === "used" ? x.code : null, expires: x.expires, design: x.design, status: st });
    app.querySelector("[data-dl]")?.addEventListener("click", () => downloadCanvas(cv, `gift-card-${x.code}.png`));
    app.querySelector("[data-sharegc]")?.addEventListener("click", async () => { try { const blob = await new Promise((r) => cv.toBlob(r, "image/png")); const file = new File([blob], `gift-card-${x.code}.png`, { type: "image/png" }); if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: `${store.name} gift card`, text: `A gift for you! Code ${x.code}` }); else downloadCanvas(cv, `gift-card-${x.code}.png`); } catch {} });
    app.querySelector("[data-back]").onclick = () => { giftUnsub?.(); uiTab = "gift"; renderMenu(); };
  }, () => { giftUnsub?.(); renderMenu(); });
}

let bookIntake = null, bookIntakeLast = false, bookCode = null;
let bookPrefProvider = null, bookSel = new Set(), bookHome = false, bookPax = 1, bookGender = "";
// "Nasa home service, back ~3PM" etc. — the owner's status switch
function presenceLine(p) {
  if (!p?.state || p.state === "in") return "";
  const back = p.backAt ? ` · back ~${fmt12(p.backAt)}` : "";
  return ({ home: "🏠 Out on home service", break: "☕ On a short break", closed: "🔴 Closed today", away: "🚶 Stepped out" }[p.state] || "") + back;
}
// 🛡 "Book in the app" protection + private report to the owner (salon)
const protectHTML = (compact = false) => store.mode === "salon" ? `<div class="c-protect ${compact ? "sm" : ""}"><b>🛡 Book only in the app</b><span>Your booking, price and stylist are protected here. If a staff member offers you a service outside the app, please tell the owner — it's private.</span><button type="button" class="c-linkbtn" data-reportoffer>Report a staff offer</button></div>` : "";
function bindProtect(root, apptId = null) {
  root.querySelectorAll("[data-reportoffer]").forEach((b) => (b.onclick = () => {
    const el = html(`<div><p class="muted small" style="margin-top:0">Only the owner sees this. The staff member is not told who reported.</p>
      ${(store.team || []).length ? `<label>Staff member (optional)</label><select data-rs><option value="">— I'm not sure —</option>${store.team.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join("")}</select>` : ""}
      <label>What happened?</label><textarea data-rd rows="4" placeholder="e.g. She gave me her number and offered a cheaper home service if I book with her directly."></textarea>
      <label>Your mobile (optional — if the owner may contact you)</label><input data-rp type="tel" placeholder="09XX XXX XXXX"/></div>`);
    const foot = html(`<div class="c-ftrow"><button class="c-btn brand block" data-go>Send privately</button></div>`);
    foot.querySelector("[data-go]").onclick = async (e) => {
      e.target.disabled = true;
      try { await call("reportStaffOffer", { slug, staffId: el.querySelector("[data-rs]")?.value || null, details: el.querySelector("[data-rd]").value, phone: el.querySelector("[data-rp]").value, apptId }); closeSheet(); toast("Thank you — sent privately to the owner."); }
      catch (x) { toast(x.message); e.target.disabled = false; }
    };
    openSheet("Report a staff offer", el, foot);
  }));
}

document.addEventListener("click", (e) => { if (e.target.closest?.("[data-quote]")) openQuoteForm(inqCtx(), e.target.closest("[data-quote]").dataset.quote || "quote"); if (e.target.closest?.("[data-myinq]")) { const L = loadLocal().lastInquiry; if (L) renderInquiry(inqCtx(), L); } });
/** "Non-refundable · reschedule up to 2× until 24 h before · ₱200 moving date fee" */
export function policyText(bp, money) { if (!bp) return ""; const R = bp.reschedule || {}; const parts = [bp.refundable === false ? "Non-refundable" : ""]; parts.push(R.allowed === false ? "No rescheduling" : `Reschedule${R.max ? ` up to ${R.max}×` : ""}${R.cutoffHours ? ` until ${R.cutoffHours} h before` : ""}`); if (R.allowed !== false && R.fee) parts.push(`${R.feeType === "percent" ? `${R.fee}%` : money(R.fee)} moving date fee`); return parts.filter(Boolean).join(" · "); }
const inqCtx = () => ({ app, slug, call, db, auth, esc, html, money, toast, openSheet, closeSheet, loadLocal, saveLocal, store, back: () => renderMenu() });
function renderSalonBook(body) {
  const cfg = store.salon || {}; const saved = loadLocal().customer || {}; const cats = store.categories || []; const items = (store.items || []).filter((i) => i.available !== false && !i.retail);
  const dpPay = (store.payments || []).filter((m) => m.type !== "cash");
  let dpNeeded = 0;
  const team = store.team || [];
  const days = Array.from({ length: Math.min(60, cfg.maxDaysAhead || 14) }, (_, i) => { const d = new Date(); d.setDate(d.getDate() + i); return d; });
  const hs = cfg.homeService || {}; const place = store.setup?.place || (hs.enabled ? "both" : "shop");
  const areas = (hs.areas || []).filter((a) => a && a.name);
  let home = place === "home" || (place === "both" && bookHome);
  const pres = cfg.presence; const awayOff = pres?.state && pres.state !== "in" && cfg.walkInWhenAway === "off" && team.length <= 1;
  body.innerHTML = `${quoteCTA(store, esc)}<div class="c-card-soft"><h2>${place === "home" ? (store.businessType === "freelance" ? "Book on location" : "Book a home service") : store.businessType === "freelance" ? "Book a date" : "Book a service"}</h2>
    ${store.bookingPolicy ? `<div class="small muted" style="margin:-4px 0 10px">📅 ${esc(policyText(store.bookingPolicy, money))}</div>` : ""}
    <div class="c-step"><span>1</span> Services</div>
    ${(() => { const grouped = [...cats.map((c) => [c, items.filter((i) => i.categoryId === c.id)]), [{ id: "_other", name: "Other" }, items.filter((i) => !cats.some((c) => c.id === i.categoryId))]].filter(([, its]) => its.length);
      const selHas = (i) => [...bookSel].some((k) => k === i.id || k.startsWith(i.id + "~"));
      return grouped.length ? grouped.map(([c, its]) => `<details class="c-svcgroup" ${its.some(selHas) || grouped.length === 1 || c === grouped[0][0] ? "open" : ""}><summary>${esc(c.name)} <small>${its.length}</small></summary>${its.map((i) => (i.variants || []).length
        ? `<div class="c-choice c-svcline c-varline" role="group" aria-label="${esc(i.name)}"><span><b>${esc(i.name)}</b><small>Choose one:</small></span><div class="c-chips">${i.variants.map((v, vi) => `<label class="chip ${bookSel.has(`${i.id}~${vi}`) ? "on" : ""}"><input type="checkbox" class="sr" data-svc="${i.id}~${vi}" data-item="${i.id}" data-cat="${i.categoryId || c.id}" ${bookSel.has(`${i.id}~${vi}`) ? "checked" : ""}/>${esc(v.label)} · ${money(v.price)}${v.duration ? ` · ${v.duration}m` : ""}</label>`).join("")}</div></div>`
        : `<label class="c-choice c-svcline"><input type="checkbox" data-svc="${i.id}" data-cat="${i.categoryId || c.id}" ${bookSel.has(i.id) ? "checked" : ""}/><span><b>${esc(i.name)}</b><small>${Number(i.price) ? money(i.price) : "Price on consult"} · ${i.wholeDay || (i.durationMinutes || 0) >= 480 ? "whole day" : `~${i.durationMinutes || 30} min`}</small></span></label>`).join("")}</details>`).join("")
        : `<div class="c-alert warn">No services are bookable yet. Please message the salon or check back soon.</div>`; })()}
    <div class="small muted" data-sum style="margin-top:6px"></div>
    ${(store.products || []).length ? `<div class="c-step"><span>🛍</span> Add products (optional)</div><div class="c-prodlist">${store.products.map((p) => `<div class="c-choice c-svcline" style="align-items:center">${p.imageUrl ? `<img src="${esc(p.imageUrl)}" alt="" style="width:44px;height:44px;border-radius:8px;object-fit:cover"/>` : ""}<span style="flex:1"><b>${esc(p.name)}</b><small>${money(p.price)}${p.description ? ` · ${esc(p.description.slice(0, 60))}` : ""}${p.stock != null && p.stock <= 3 ? ` · only ${p.stock} left` : ""}</small></span><span class="c-qty"><button type="button" data-pq="${p.id}" data-d="-1">−</button><span data-pqn="${p.id}">0</span><button type="button" data-pq="${p.id}" data-d="1">+</button></span></div>`).join("")}</div>` : ""}
    ${cfg.allowPax2 && team.length >= 2 ? `<div class="c-step"><span>👥</span> How many people?</div><div class="c-chips" role="radiogroup"><button type="button" class="chip ${bookPax === 2 ? "" : "on"}" data-pax="1">Just me</button><button type="button" class="chip ${bookPax === 2 ? "on" : ""}" data-pax="2">2 people · same time${cfg.rooms?.length ? " (couple room)" : ""}</button></div>` : ""}
    ${cfg.genderPick && team.some((t) => t.gender) ? `<div class="c-step"><span>🙋</span> Preference</div><div class="c-chips" role="radiogroup">${[["", "Anyone"], ["female", "Female only"], ["male", "Male only"]].map(([k, l]) => `<button type="button" class="chip ${bookGender === k ? "on" : ""}" data-gender="${k}">${l}</button>`).join("")}</div>` : ""}
    <div ${team.length <= 1 || bookPax === 2 ? 'style="display:none"' : ""}><div class="c-step"><span>2</span> Staff</div><div data-staff class="c-chips"></div></div>
    ${place === "both" ? `<div class="c-step"><span>📍</span> Where</div><div class="c-chips" role="radiogroup" aria-label="Where"><button type="button" class="chip ${home ? "" : "on"}" data-where="shop" role="radio" aria-checked="${!home}">🏪 At the salon</button><button type="button" class="chip ${home ? "on" : ""}" data-where="home" role="radio" aria-checked="${home}">🏠 Home service${areas.length ? ` · from ${money(Math.min(...areas.map((a) => Number(a.fee) || 0)))}` : hs.fee ? ` · from ${money(hs.fee)}` : ""}</button></div>` : ""}
    <div class="c-step"><span>3</span> Date &amp; time</div><div class="c-chips c-when">${home ? `<span class="small muted" style="width:100%">🏠 Times shown are when we can come to you${hs.travelMin ? "" : ""}.</span>` : awayOff ? `<span class="small muted" style="width:100%">${esc(presenceLine(pres))} — book a time below.</span>` : isOpenNow(store.hours) || testing() ? `<button type="button" class="chip" data-walkin>🎟️ Join the line (today)</button>` : `<span class="small muted" style="width:100%">🌙 Closed now — book a time below.</span>`}<button type="button" class="chip" data-day="0">Today</button><button type="button" class="chip" data-day="1">Tomorrow</button><select data-date>${days.map((d, i) => `<option value="${i}">${d.toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric" })}</option>`).join("")}</select></div>
    <div data-slots class="c-slots"><p class="muted small">Pick services first.</p></div>
    ${cfg.intake?.enabled ? `<div data-intake></div>` : ""}
    <div class="c-step"><span>4</span> Your details</div>
    <label>Name</label><input data-name value="${esc(saved.name || "")}"/>
    <label>Phone</label><input data-phone type="tel" value="${esc(saved.phone || "")}" placeholder="09XX XXX XXXX"/>
    ${msgrField(saved)}
    <div data-homebox ${home ? "" : 'style="display:none"'} class="c-homebox">
      <div class="eyebrow">🏠 Where should we go?</div>
      ${areas.length ? `<label>Area</label><select data-area><option value="">Choose your area</option>${areas.map((a) => `<option value="${esc(a.name)}" ${saved.area === a.name ? "selected" : ""}>${esc(a.name)} · ${Number(a.fee) ? money(a.fee) : "free"}</option>`).join("")}</select>` : ""}
      <label>Address</label><input data-address placeholder="House no., street, barangay, city" value="${esc(saved.address || "")}" autocomplete="street-address"/>
      <label>Landmark <span class="muted small">(optional)</span></label><input data-landmark placeholder="e.g. green gate beside the sari-sari store" value="${esc(saved.landmark || "")}"/>
      <label>Map pin <span class="muted small">(required — so the stylist can find you)</span></label><div style="display:flex;gap:6px"><input data-map placeholder="Paste a Google Maps link" value="${esc(saved.mapUrl || "")}" style="flex:1"/><button type="button" class="c-btn ghost sm" data-loc>📍 My location</button></div>
      <div data-idbox ${saved.homeIdOk ? 'style="display:none"' : ""}><label>Valid ID <span class="muted small">(first home service only)</span></label><input type="file" accept="image/*" data-hsid/><p class="muted small" style="margin:4px 0 0">🔒 ${esc(PRIVACY_NOTE)}</p></div>
      <p class="muted small">${hs.minSpend ? `Minimum ${money(hs.minSpend)} in services. ` : ""}${areas.length ? "The transport fee is added to your bill." : esc(hs.note || "Transport fee depends on your area; the final fee is confirmed by the salon and shown on your status page.")}${areas.length && hs.note ? " " + esc(hs.note) : ""}</p>
    </div>
    <label>Notes (optional)</label><input data-notes placeholder="e.g. reference photo on Messenger, allergies"/>
    <div class="c-grid2"><div><label>Birthday <span class="muted small">(optional — for a birthday treat 🎂)</span></label><div style="display:flex;gap:6px"><select data-bm><option value="">Month</option>${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"].map((m, i) => `<option value="${String(i + 1).padStart(2, "0")}" ${(saved.birthday || "").slice(0, 2) === String(i + 1).padStart(2, "0") ? "selected" : ""}>${m}</option>`).join("")}</select><select data-bd><option value="">Day</option>${Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, "0")).map((x) => `<option ${(saved.birthday || "").slice(3) === x ? "selected" : ""}>${x}</option>`).join("")}</select></div></div>
    ${store.salon?.referral?.enabled ? `<div><label>Referral code <span class="muted small">(first visit: ₱${Number(store.salon.referral.reward) || 100} off)</span></label><input data-ref placeholder="e.g. ANA-7K2" style="text-transform:uppercase" value="${esc(new URLSearchParams(location.search).get("ref") || "")}"/></div>` : ""}</div>
    ${store.pro?.promos !== false ? `<div><label>Promo code <span class="muted small">(optional)</span></label><div style="display:flex;gap:6px"><input data-pcode placeholder="e.g. SPA50" style="text-transform:uppercase;flex:1" autocapitalize="characters" value="${esc(bookCode?.code || "")}"/><button type="button" class="c-btn ghost" data-pcheck>Apply</button></div><div data-pcmsg class="small"></div></div>` : ""}
    <div data-promosum></div>
    <div data-dpbox></div>
    ${store.policies?.salon ? `<label>Policy</label><div class="waiver-text">${esc(store.policies.salon)}</div><label class="c-agree"><input type="checkbox" data-agree/> I have read and agree</label>` : ""}
    <p class="muted small">${store.confirm?.mode && store.confirm.mode !== "off" ? `You'll need to confirm via Messenger within ${cfg.confirmMinutes || 60} minutes or the slot is released.` : ""}</p>
    ${protectHTML(true)}
    <div class="c-bookbar"><button class="c-btn brand block" data-book disabled>Choose a time slot</button></div></div>`;
  const g = (sel) => body.querySelector(sel);
  let chosen = null, dayIdx = 0, provider = bookPrefProvider, plans = null; bookPrefProvider = null;
  const prodQty = {}; body.querySelectorAll("[data-pq]").forEach((b) => (b.onclick = () => { const id = b.dataset.pq; const p = (store.products || []).find((x) => x.id === id); prodQty[id] = Math.max(0, Math.min(p?.stock ?? 50, (prodQty[id] || 0) + Number(b.dataset.d))); body.querySelector(`[data-pqn="${id}"]`).textContent = prodQty[id]; }));
  // reservation fee (DP): shown up-front for bigger bookings, or when the server asks for it (e.g. after a no-show)
  const svcOf = (key) => { const [id, vi] = String(key).split("~"); const it = items.find((i) => i.id === id); if (!it) return null; const v = vi !== undefined ? (it.variants || [])[Number(vi)] : null; return v ? { ...it, name: `${it.name} (${v.label})`, price: Number(v.price) || 0, durationMinutes: v.duration || it.durationMinutes } : it; };
  const drawDp = () => {
    const sel = [...bookSel].map(svcOf).filter(Boolean); const tot = sel.reduce((a, i) => a + (Number(i.price) || 0), 0);
    const dc = cfg.deposit || {};
    const base = dc.enabled && store.pro?.salondp !== false && !walkIn && tot >= (Number(dc.minTotal) || 0) ? Number(dc.amount) || 0 : 0;
    const amt = dpNeeded || Math.max(base, home && store.pro?.salondp !== false && hs.dp !== false ? Number(hs.dpAmount) || 0 : 0);
    const box = g("[data-dpbox]"); if (!box) return;
    if (!amt) { box.innerHTML = ""; return; }
    if (box.dataset.amt === String(amt)) return; box.dataset.amt = String(amt);
    box.innerHTML = `<div class="c-ticket main" style="margin-top:10px;text-align:left"><div class="eyebrow">💵 Reservation fee ${money(amt)}</div><p class="small muted" style="margin:4px 0 8px">Pay first to lock your slot. It is <b>deducted from your bill</b>; it is kept by the salon if you don't show up.</p>
      ${dpPay.length ? `<div class="c-chips">${dpPay.map((m, i) => `<button type="button" class="chip ${i === 0 ? "on" : ""}" data-dpm="${esc(m.id)}">${esc(m.name)}</button>`).join("")}</div><div data-dpinfo class="small"></div>
      <label>GCash reference no. <span class="muted small">(or attach the screenshot)</span></label><input data-dpref inputmode="numeric" placeholder="e.g. 1234 5678 9012"/><input type="file" accept="image/*" data-dpproof style="margin-top:6px"/><p class="small muted" style="margin:6px 0 0">Send the fee, then tap <b>I've sent · Book</b>. The salon checks and confirms.</p>` : `<div class="c-alert warn">Please message the salon to pay the reservation fee.</div>`}</div>`;
    const info = (id) => { const m = dpPay.find((x) => x.id === id); const el = box.querySelector("[data-dpinfo]"); if (el && m) el.innerHTML = `${m.accountName ? `<b>${esc(m.accountName)}</b> · ` : ""}${esc(m.accountNumber || m.number || "")}${m.qrUrl ? `<br><img src="${esc(m.qrUrl)}" alt="QR" style="max-width:160px;border-radius:10px;margin-top:6px"/>` : ""}`; };
    box.querySelectorAll("[data-dpm]").forEach((b) => (b.onclick = () => { box.querySelectorAll("[data-dpm]").forEach((x) => x.classList.toggle("on", x === b)); info(b.dataset.dpm); }));
    info(dpPay[0]?.id);
  };
  const selCats = () => [...new Set([...body.querySelectorAll("[data-svc]:checked")].map((c) => c.dataset.cat))];
  const drawStaff = () => { const cs = selCats(); const ok = team.filter((t) => (!(t.skills || []).length || cs.every((c) => t.skills.includes(c))) && (!bookGender || t.gender === bookGender)); if (provider && !ok.some((t) => t.id === provider)) provider = null; g("[data-staff]").innerHTML = `${cfg.allowAnyone !== false ? `<button type="button" class="chip ${!provider ? "on" : ""}" data-p="">Any available</button>` : ""}${ok.map((t) => `<button type="button" class="chip ${provider === t.id ? "on" : ""}" data-p="${esc(t.id)}">${t.photoUrl ? `<img src="${esc(t.photoUrl)}" alt=""/>` : ""}${esc(t.name.split(" ")[0])}</button>`).join("")}${!ok.length && cs.length > 1 ? `<span class="small muted">👥 Different staff will do these one after another — pick a time below.</span>` : ""}`; g("[data-staff]").querySelectorAll("[data-p]").forEach((b) => (b.onclick = () => { provider = b.dataset.p || null; drawStaff(); if (walkIn) drawLine(); else loadSlots(); })); paintLive(); };
  // live status under each staff chip (free now / free at …)
  const paintLive = () => { const st = liveAv?.staff || []; g("[data-staff]")?.querySelectorAll("[data-p]").forEach((b) => { const x = st.find((y) => y.id === b.dataset.p); b.querySelector(".live")?.remove(); if (x) b.insertAdjacentHTML("beforeend", `<small class="live">${esc(staffLiveText(x))}</small>`); }); };
  loadLive().then(paintLive);
  const sum = () => { const keys = [...body.querySelectorAll("[data-svc]:checked")].map((c) => c.dataset.svc).filter((k) => svcOf(k)); const sel = keys.map(svcOf); bookSel = new Set(keys); g("[data-sum]").textContent = sel.length ? `${sel.length} service${sel.length > 1 ? "s" : ""} · ${money(sel.reduce((a, i) => a + i.price, 0))} · ~${sel.reduce((a, i) => a + (i.durationMinutes || 30), 0)} min` : ""; };
  const drawPromo = () => {
    const box = g("[data-promosum]"); if (!box) return;
    const sel = [...bookSel].map(svcOf).filter(Boolean); if (!sel.length) { box.innerHTML = ""; return; }
    const at = walkIn ? Date.now() : chosen;
    const promos = [...(store.promos || []), ...(bookCode?.promo ? [bookCode.promo] : [])];
    const lines = sel.map((i) => ({ itemId: i.id, categoryId: i.categoryId, price: Number(i.price) || 0 }));
    const gross = lines.reduce((a, l) => a + l.price, 0);
    if (!at) { const any = promos.some((p) => p.type === "free_home_fee" || p.type === "bundle" || lines.some((l) => promoHits(p, l))); box.innerHTML = any ? `<p class="c-hint">Pick a time to see your promo price.</p>` : ""; return; }
    const r = calcSalonPromos(promos, { lines, at, home, pax: bookPax, providerId: bookPax === 2 ? null : provider, codes: bookCode?.promo ? [bookCode.promo.id] : [], preview: true });
    const fv = r.applied.filter((x) => x.audience === "first_visit");
    let vtxt = "";
    if (bookCode?.voucher) { const v = bookCode.voucher; const base = gross - r.discount; const vd = base >= (v.minOrder || 0) ? Math.min(v.type === "percent" ? base * v.value / 100 : v.value, v.maxDiscount || Infinity) : 0; vtxt = vd ? `<div class="c-kv"><span>Code ${esc(v.code)} (at checkout)</span><b>−${money(Math.round(vd * 100) / 100)}</b></div>` : `<p class="c-hint">Code ${esc(v.code)} needs a minimum of ${money(v.minOrder)}.</p>`; }
    box.innerHTML = r.discount > 0 || r.homeFeeWaived || vtxt ? `<div class="c-box"><div class="c-boxhead">Your promo</div>
      ${r.applied.map((x) => `<div class="c-kv"><span>${esc(x.name || x.label)}</span><b>${x.homeFee ? "Free transport" : "−" + money(x.amount)}</b></div>`).join("")}${vtxt}
      ${r.discount > 0 ? `<div class="c-kv total"><span>Services${bookPax === 2 ? " (each)" : ""}</span><span><s class="muted" style="font-weight:400">${money(gross)}</s> <b>${money(gross - r.discount)}</b></span></div>` : ""}
      ${fv.length ? `<p class="c-hint">The first-visit promo applies only if it's your first time here.</p>` : ""}</div>` : "";
  };
  const loadSlots = async () => {
    drawPromo();
    const ids = [...bookSel]; const box = g("[data-slots]"); chosen = null; g("[data-book]").disabled = true; g("[data-book]").textContent = "Choose a time slot";
    if (!ids.length) return (box.innerHTML = `<p class="muted small">Pick services first.</p>`);
    box.innerHTML = `<p class="muted small">Checking availability…</p>`;
    const d = days[dayIdx]; const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    try { const r = await call("getSlots", { slug, itemIds: ids, date, providerId: bookPax === 2 ? null : provider, homeService: home, pax: bookPax, gender: bookGender || null }); plans = r.plans || null; box.innerHTML = r.full ? `<p class="muted small">📅 ${esc(r.why || "This day is fully booked. Please pick another day.")}</p>` : r.slots.length ? r.slots.map((t) => `<button type="button" class="slot" data-t="${t}">${new Date(t).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}</button>`).join("") : `<p class="muted small">No available slots on this day${provider ? " for this staff" : ""}. Try another day${provider ? " or \"Any available\"" : ""}.</p>${store.pro?.waitlist !== false ? `<button type="button" class="c-btn ghost block" data-notify style="margin-top:6px">📋 Notify me if a slot opens on this day</button>` : ""}`; box.querySelector("[data-notify]")?.addEventListener("click", async (ev) => { const name = g("[data-name]").value.trim(), phone = g("[data-phone]").value.trim(); if (!name || !phone) { g("[data-name]").scrollIntoView({ behavior: "smooth", block: "center" }); return toast("Enter your name and mobile number below first"); } ev.target.disabled = true; try { const w = await call("joinSlotWait", { slug, date, itemIds: ids, providerId: provider, customer: { name, phone } }); ev.target.textContent = w.existing ? "✓ You're already on the waitlist for this day" : "✓ We'll text you if a slot opens"; } catch (e) { toast(e.message); ev.target.disabled = false; } }); box.querySelectorAll(".slot").forEach((b) => (b.onclick = () => { chosen = Number(b.dataset.t); drawPromo(); box.querySelectorAll(".slot").forEach((x) => x.classList.toggle("on", x === b)); g("[data-book]").disabled = false; g("[data-book]").textContent = `Book · start ${new Date(chosen).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}`; box.querySelector("[data-plan]")?.remove(); if (plans?.[chosen]) box.insertAdjacentHTML("beforeend", `<p class="small" data-plan style="width:100%;margin:6px 0 0">👥 ${esc(plans[chosen])}</p>`); })); }
    catch (e) { box.innerHTML = `<p class="muted small">${esc(e.message)}</p>`; }
  };
  body.querySelectorAll("[data-svc]").forEach((c) => (c.onchange = () => { if (c.dataset.item) { if (c.checked) body.querySelectorAll(`[data-item="${c.dataset.item}"]`).forEach((x) => { if (x !== c) x.checked = false; }); body.querySelectorAll(`[data-item="${c.dataset.item}"]`).forEach((x) => x.closest("label").classList.toggle("on", x.checked)); } sum(); drawStaff(); drawDp(); if (walkIn) { g("[data-book]").disabled = !bookSel.size; if (bookSel.size) drawLine(); } else loadSlots(); }));
  let walkIn = false;
  const drawLine = async () => {
    const box = g("[data-slots]"); box.innerHTML = `<p class="muted small">Checking the line…</p>`;
    const av = await loadLive({ itemIds: [...bookSel], providerId: bookPax === 2 ? null : provider, gender: bookGender || null }, true);
    const q = av?.queue; if (!walkIn) return;
    if (!q) { box.innerHTML = `<p class="muted small">Couldn't check the line. Try again.</p>`; return; }
    const free = (av.staff || []).filter((x) => x.status === "free" && (!provider || x.id === provider));
    if (q.ok || (free.length && !q.count)) {
      box.innerHTML = `<div class="c-box"><div class="c-boxhead">The line now</div>${free.length && !q.count ? `<div class="c-kv"><span>Wait</span><b>None, someone is free</b></div>` : `<div class="c-kv"><span>Wait</span><b>About ${q.waitMin} min</b></div><div class="c-kv"><span>Ahead of you</span><b>${q.count}</b></div>${q.etaAt ? `<div class="c-kv"><span>Your turn</span><b>Around ${tShort(q.etaAt)}</b></div>` : ""}`}<p class="c-hint">You'll get a number and can follow your place in line here. You can step out and come back when it says you're next.</p></div>`;
      g("[data-book]").disabled = !bookSel.size; g("[data-book]").textContent = "🎟️ Get my number";
    } else {
      box.innerHTML = `<div class="c-alert warn"><b>${esc(q.reason)}</b>${q.waitMin != null && q.code === "QUEUE_FULL" ? `<br><span class="small">Wait is about ${q.waitMin} min with ${q.count} in line.</span>` : ""}</div><div data-early></div>`;
      g("[data-book]").disabled = true; g("[data-book]").textContent = "Line not available";
      showEarliest();
    }
  };
  const showEarliest = async (ms) => {
    const box = g("[data-early]") || g("[data-slots]");
    if (!ms) { try { for (let i = 0; i < 7 && !ms; i++) { const d = days[i]; if (!d) break; const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; const r = await call("getSlots", { slug, itemIds: [...bookSel], date, providerId: bookPax === 2 ? null : provider, homeService: home, pax: bookPax, gender: bookGender || null }); ms = (r.slots || []).find((t) => t > Date.now() + 15 * 60000); } } catch {} }
    if (!ms || !box) return;
    const b = html(`<button type="button" class="c-btn brand block" style="margin-top:8px">📅 Reserve ${new Date(ms).toLocaleString("en-PH", { weekday: "short", hour: "numeric", minute: "2-digit" })} instead</button>`);
    b.onclick = () => { walkIn = false; g("[data-walkin]")?.classList.remove("on"); const di = days.findIndex((d) => d.toDateString() === new Date(ms).toDateString()); dayIdx = Math.max(0, di); g("[data-date]").value = dayIdx; loadSlots().then(() => { const sb = g(`.slot[data-t="${ms}"]`); sb?.click(); sb?.scrollIntoView({ behavior: "smooth", block: "center" }); }); };
    box.appendChild(b);
  };
  if (g("[data-walkin]")) g("[data-walkin]").onclick = () => { walkIn = !walkIn; g("[data-walkin]").classList.toggle("on", walkIn); if (walkIn) { chosen = null; drawPromo(); if (!bookSel.size) { g("[data-slots]").innerHTML = `<p class="muted small">Pick services first.</p>`; return; } drawLine(); } else loadSlots(); };
  body.querySelectorAll("[data-day]").forEach((b) => (b.onclick = () => { walkIn = false; g("[data-walkin]")?.classList.remove("on"); dayIdx = Number(b.dataset.day); g("[data-date]").value = dayIdx; loadSlots(); }));
  g("[data-date]").onchange = (e) => { dayIdx = Number(e.target.value); loadSlots(); };
  body.querySelectorAll("[data-where]").forEach((b) => (b.onclick = () => { bookHome = b.dataset.where === "home"; renderSalonBook(body); }));
  { const ib = body.querySelector("[data-intake]"); if (ib) { if (!bookIntake) { bookIntake = loadLocal().intake || null; bookIntakeLast = !!bookIntake; } const f = intakeForm(bookIntake, esc, (v) => (bookIntake = v), bookIntakeLast); ib.appendChild(f.el); if (!bookIntake) bookIntake = f.value(); } }
  g("[data-pcheck]")?.addEventListener("click", async (e) => {
    const code = g("[data-pcode]").value.trim(); const msg = g("[data-pcmsg]");
    if (!code) { bookCode = null; msg.textContent = ""; drawPromo(); return; }
    e.target.disabled = true;
    try { const r = await call("checkBookingCode", { slug, code }); bookCode = { code: code.toUpperCase(), ...r }; msg.innerHTML = `<span style="color:var(--ok, #16a34a)">✓ ${esc(r.promo ? `${salonPromoTag(r.promo)} ${r.promo.name}` : r.voucher.label || `${r.voucher.type === "percent" ? r.voucher.value + "%" : money(r.voucher.value)} off`)}</span>${r.voucher ? " · taken off at checkout" : ""}`; }
    catch (x) { bookCode = null; msg.innerHTML = `<span style="color:var(--danger)">${esc(x.message)}</span>`; }
    e.target.disabled = false; drawPromo();
  });
  body.querySelectorAll("[data-pax]").forEach((b) => (b.onclick = () => { bookPax = Number(b.dataset.pax); if (bookPax === 2) provider = null; bookPrefProvider = provider; renderSalonBook(body); }));
  body.querySelectorAll("[data-gender]").forEach((b) => (b.onclick = () => { bookGender = b.dataset.gender; body.querySelectorAll("[data-gender]").forEach((x) => x.classList.toggle("on", x === b)); if (bookGender && provider && team.find((t) => t.id === provider)?.gender !== bookGender) { provider = null; drawStaff(); } loadSlots(); }));
  g("[data-loc]")?.addEventListener("click", (ev) => { if (!navigator.geolocation) return toast("Location isn't available on this phone — paste a Maps link instead"); ev.target.disabled = true; ev.target.textContent = "Locating…"; navigator.geolocation.getCurrentPosition((p) => { g("[data-map]").value = `https://maps.google.com/?q=${p.coords.latitude.toFixed(6)},${p.coords.longitude.toFixed(6)}`; ev.target.disabled = false; ev.target.textContent = "📍 Got it"; }, () => { ev.target.disabled = false; ev.target.textContent = "📍 My location"; toast("Couldn't get your location — paste a Maps link instead"); }, { enableHighAccuracy: true, timeout: 12000 }); });
  sum(); drawStaff(); drawDp(); bindProtect(body); if (bookSel.size) loadSlots();
  g("[data-book]").onclick = async (e) => {
    const customer = { name: g("[data-name]").value.trim(), phone: g("[data-phone]").value.trim(), messenger: readMsgr(body), ...(home ? { address: g("[data-address]")?.value.trim() || "", landmark: g("[data-landmark]")?.value.trim() || "", mapUrl: g("[data-map]")?.value.trim() || "", area: g("[data-area]")?.value || "" } : {}) };
    if (!customer.name || !customer.phone) return toast("Name and phone are required");
    if (g("[data-agree]") && !g("[data-agree]").checked) return toast("Please agree to the policy");
    if (home && areas.length && !customer.area) { g("[data-area]").focus(); return toast("Choose your area for home service"); }
    if (home && customer.address.length < 5) { g("[data-address]").focus(); return toast("Enter your address for home service"); }
    if (home && !customer.mapUrl) { g("[data-map]")?.focus(); return toast("Add your map pin — tap 📍 My location"); }
    if (home && customer.mapUrl && !/^https:\/\//.test(customer.mapUrl)) return toast("The map pin should be a Google Maps link");
    let idUrl = null;
    const idFile = home ? g("[data-hsid]")?.files?.[0] : null;
    if (idFile) { e.target.disabled = true; e.target.textContent = "Uploading ID…"; try { idUrl = await uploadPrivateImage(store.storeId, auth.currentUser.uid, idFile, { max: 1400, name: "home-id" }); } catch (x) { e.target.disabled = false; e.target.textContent = "Book"; return toast("Couldn't upload the ID: " + x.message); } }
    e.target.disabled = true; e.target.textContent = "Booking…";
    try {
      if (!walkIn && !chosen) { e.target.disabled = false; e.target.textContent = "Choose a time slot"; return toast("Pick a time slot"); }
      const box = g("[data-dpbox]"); let payment = null;
      if (box?.dataset.amt && box.querySelector("[data-dpref]")) {
        const refNo = box.querySelector("[data-dpref]").value.trim();
        // one-tap: sending is enough; the salon confirms Received / Not received
        const f = box.querySelector("[data-dpproof]")?.files?.[0]; let proofUrl = null;
        const dpm = dpPay.find((x) => x.id === (box.querySelector("[data-dpm].on")?.dataset.dpm || dpPay[0]?.id));
        if (dpm?.askRefBookings !== false && refNo.replace(/\s/g, "").length < 4 && !f) { e.target.disabled = false; e.target.textContent = "Book"; return toast("Enter the GCash reference no. or attach the screenshot of your reservation fee."); }
        if (f) { e.target.textContent = "Uploading…"; try { proofUrl = await uploadPrivateImage(store.storeId, auth.currentUser.uid, f, { max: 1200 }); } catch {} }
        payment = { methodId: box.querySelector("[data-dpm].on")?.dataset.dpm || dpPay[0]?.id, refNo, proofUrl };
      }
      const birthday = g("[data-bm]")?.value && g("[data-bd]")?.value ? `${g("[data-bm]").value}-${g("[data-bd]").value}` : null;
      const intake = cfg.intake?.enabled ? bookIntake : null;
      if (intake) saveLocal({ intake });
      const r = await call("bookAppointment", { slug, atShop, intake, products: Object.entries(prodQty).filter(([, n]) => n > 0).map(([id, qty]) => ({ id, qty })), promoCode: bookCode?.code || (g("[data-pcode]")?.value.trim() || null), itemIds: [...bookSel], providerId: bookPax === 2 ? null : provider, pax: bookPax, gender: bookGender || null, walkIn, startAt: walkIn ? null : new Date(chosen).toISOString(), notes: g("[data-notes]").value.trim(), customer, homeService: home ? { area: customer.area || "" } : false, idUrl, payment, birthday, refCode: g("[data-ref]")?.value.trim() || null });
      if (birthday) customer.birthday = birthday;
      const rec = { id: r.id, storeId: r.storeId, at: Date.now() }; bookSel = new Set();
      saveLocal({ customer: { ...customer, ...(home ? { homeIdOk: true } : {}) }, lastAppt: rec, appts: [...(loadLocal().appts || []), rec] });
      renderApptStatus(rec);
    } catch (err) {
      const m = /^DP_REQUIRED:(\d+(?:\.\d+)?):(.*)$/.exec(err.message || "");
      if (m) { dpNeeded = Number(m[1]); g("[data-dpbox]").dataset.amt = ""; drawDp(); g("[data-dpbox]").scrollIntoView({ behavior: "smooth", block: "center" }); toast(m[2]); }
      else if (/^ID_REQUIRED:/.test(err.message || "")) { const box = g("[data-idbox]"); if (box) { box.style.display = ""; box.scrollIntoView({ behavior: "smooth", block: "center" }); } saveLocal({ customer: { ...(loadLocal().customer || {}), homeIdOk: false } }); toast(err.message.replace(/^ID_REQUIRED:/, "")); }
      else if (/^QUEUE_[A-Z_]+:/.test(err.message || "")) { const [, early, ...rest] = err.message.split(":"); g("[data-slots]").innerHTML = `<div class="c-alert warn"><b>${esc(rest.join(":"))}</b></div><div data-early></div>`; showEarliest(Number(early) || 0); g("[data-slots]").scrollIntoView({ behavior: "smooth", block: "center" }); }
      else toast(err.message);
      e.target.disabled = false; e.target.textContent = "Book";
    }
  };
}
const APPT_STAGES = { unconfirmed: ["Confirm via Messenger", "Message us to confirm your slot"], pending: ["Requested", "Waiting for the salon to confirm"], confirmed: ["Confirmed", "See you then!"], in_progress: ["In progress", "Enjoy your service"], done: ["Done", "Thank you! Please rate us"], cancelled: ["Cancelled", ""], no_show: ["No-show", "You didn't arrive within the grace period"] };
// ---------------- next visit link from the salon: confirm / change / cancel ----------------
async function renderVisit(v) {
  apptUnsub?.(); statusUnsub?.(); renderCartBar();
  app.innerHTML = `<div class="c-status"><div class="c-loading" style="min-height:40vh"><div class="c-spinner"></div></div></div>`;
  let info;
  try { info = await call("visitInfo", { slug, v }); } catch (e) { app.innerHTML = `<div class="c-status"><div class="c-alert error" role="alert">${esc(e.message)}</div><button class="c-btn ghost block" data-m>See the menu</button></div>`; app.querySelector("[data-m]").onclick = () => { history.replaceState(null, "", location.pathname); renderMenu(); }; return; }
  if (info.mine) { const rec = { id: info.id, storeId: info.storeId, at: Date.now() }; saveLocal({ lastAppt: rec, appts: [...(loadLocal().appts || []).filter((x) => x.id !== rec.id), rec] }); }
  drawVisit(info, v);
}
function drawVisit(info, v) {
  const when = new Date(info.startAt); const vc = info.visitConfirm?.status;
  const closed = ["cancelled", "no_show", "done"].includes(info.status);
  app.innerHTML = `<div><header class="c-head"><div class="top"><div class="logo">${store.logoUrl ? `<img src="${esc(store.logoUrl)}" alt=""/>` : esc(store.name.trim()[0] || "·")}</div><div><h1>${esc(store.name)}</h1><div class="sub">Your ${info.homeService ? "home service" : "appointment"}</div></div></div></header>
    <div class="c-status"><div class="c-ticket main c-visit">
      <div class="eyebrow">Hi ${esc(info.customerName || "")}! ${info.tentative && vc === "waiting" ? "Are we still on?" : ""}</div>
      <div style="font-size:1.15rem;margin:6px 0">📅 <b>${when.toLocaleDateString("en-PH", { weekday: "long", month: "long", day: "numeric" })}</b><br>🕒 <b>${when.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}</b></div>
      <div class="muted small">${info.items.map((l) => esc(l.name)).join(", ")}${info.providerName ? ` · ${esc(info.providerName)}` : ""}</div>
      ${info.homeService ? `<div class="c-when">🏠 ${esc(info.homeService.address || "")}${info.homeService.area ? ` · ${esc(info.homeService.area)}` : ""}</div>` : ""}
      <div class="c-mini"><span>Total${info.homeFee ? " (incl. transport)" : ""}</span><span class="amt">${money((info.total || 0) + (info.homeFee || 0))}</span></div>
      ${closed ? `<div class="c-alert">${info.status === "cancelled" ? "❌ This booking is cancelled." : "This booking is finished."}</div>`
        : vc === "yes" || vc === "moved" || (!info.tentative && info.status === "confirmed") ? `<div class="c-alert ok" role="status">✅ Confirmed — see you then!</div><div class="acts"><button class="c-btn ghost block" data-move>🔁 Change the day / time</button><button class="c-btn ghost block" data-no>❌ I can't make it</button></div>`
        : `<div class="acts"><button class="c-btn brand block" data-yes>✅ Yes, I'll be there</button><button class="c-btn ghost block" data-move>🔁 Change day / time</button><button class="c-btn ghost block" data-no>❌ I can't make it</button></div>`}
      <div data-pick></div>
    </div><button class="c-btn ghost block" data-menu style="margin-top:8px">See services</button></div></div>`;
  const busy = (b, t) => { b.disabled = true; b.textContent = t; };
  const respond = async (b, body) => { try { const r = await call("visitRespond", { slug, v, ...body }); drawVisit({ ...info, ...r }, v); toast(body.answer === "no" ? "Okay, cancelled. Thank you for letting us know!" : "Thank you! ✅"); } catch (e) { toast(e.message); b.disabled = false; drawVisit(info, v); } };
  app.querySelector("[data-yes]")?.addEventListener("click", (e) => { busy(e.target, "Saving…"); respond(e.target, { answer: "yes" }); });
  app.querySelector("[data-no]")?.addEventListener("click", (e) => { if (!confirm("Cancel this booking?")) return; busy(e.target, "Cancelling…"); respond(e.target, { answer: "no" }); });
  app.querySelector("[data-menu]").onclick = () => { history.replaceState(null, "", location.pathname); uiTab = "menu"; renderMenu(); };
  app.querySelector("[data-move]")?.addEventListener("click", () => {
    const box = app.querySelector("[data-pick]"); const days = Array.from({ length: Math.min(60, store.salon?.maxDaysAhead || 21) }, (_, i) => { const d = new Date(); d.setDate(d.getDate() + i); return d; });
    box.innerHTML = `<div class="c-step"><span>📅</span> Pick a new day</div><select data-d>${days.map((d, i) => `<option value="${i}">${d.toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric" })}</option>`).join("")}</select><div data-s class="c-slots" style="margin-top:8px"></div>`;
    const load = async () => { const d = days[Number(box.querySelector("[data-d]").value)]; const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; const s = box.querySelector("[data-s]"); s.innerHTML = `<p class="muted small">Checking…</p>`;
      try { const r = await call("visitSlots", { slug, v, date }); s.innerHTML = r.slots.length ? r.slots.map((t) => `<button type="button" class="slot" data-t="${t}">${new Date(t).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}</button>`).join("") : `<p class="muted small">No free time that day — try another day.</p>`;
        s.querySelectorAll("[data-t]").forEach((b) => (b.onclick = () => { if (!confirm(`Move to ${new Date(Number(b.dataset.t)).toLocaleString("en-PH", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}?`)) return; busy(b, "…"); respond(b, { answer: "move", startAt: new Date(Number(b.dataset.t)).toISOString() }); })); }
      catch (e) { s.innerHTML = `<p class="muted small">${esc(e.message)}</p>`; } };
    box.querySelector("[data-d]").onchange = load; box.querySelector("[data-d]").value = String(Math.max(0, Math.min(days.length - 1, Math.round((info.startAt - Date.now()) / 864e5)))); load();
  });
}
let apptUnsub = null;
// 💝 tip for the stylist / therapist after the session (sent by GCash / Maya, confirmed by reception)
function tipBoxHTML(a, done) {
  if (!(done || a.status === "in_progress") || store.salon?.tips === false || !a.providerName) return "";
  const pays = (store.payments || []).filter((m) => m.type !== "cash"); if (!pays.length) return "";
  const t = a.tipOnline;
  if (t && t.status !== "rejected") return `<div class="c-box"><div class="c-boxhead">Your tip for ${esc(a.providerName.split(" ")[0])}</div><div class="c-kv"><span>${esc(t.methodName)}</span><b>${money(t.amount)}</b></div><p class="c-hint">${t.status === "verified" ? "Received. Thank you!" : "The shop is checking it."}</p></div>`;
  return `<div class="c-box" data-tipbox><div class="c-boxhead">Leave a tip for ${esc(a.providerName.split(" ")[0])}</div>${t?.status === "rejected" ? `<p class="c-hint" style="color:var(--danger)">${esc(t.note || "The shop couldn't find your last tip.")} Try again below.</p>` : `<p class="c-hint" style="margin:0 0 8px">Optional. All of it goes to your ${store.businessType === "spa" ? "therapist" : "stylist"}.</p>`}
    <div class="c-chips">${[50, 100, 200].map((v) => `<button type="button" class="chip" data-tipv="${v}">${money(v)}</button>`).join("")}<input data-tipamt type="number" min="10" inputmode="numeric" placeholder="Other ₱" style="max-width:110px"/></div>
    <div data-tipmore style="display:none;margin-top:8px"><div class="c-chips">${pays.map((m, i) => `<button type="button" class="chip ${i ? "" : "on"}" data-tipm="${esc(m.id)}">${esc(m.name)}</button>`).join("")}</div><div data-tipinfo class="small" style="margin:6px 0"></div>
      <label>Reference no.</label><input data-tipref inputmode="numeric" placeholder="e.g. 1234 5678 9012"/><button type="button" class="c-btn brand block" data-tipsend style="margin-top:10px">Send tip</button></div></div>`;
}
function bindTipBox(root, rec, a) {
  const box = root.querySelector("[data-tipbox]"); if (!box) return;
  const pays = (store.payments || []).filter((m) => m.type !== "cash"); let method = pays[0]?.id; let amt = 0;
  const info = () => { const m = pays.find((x) => x.id === method); box.querySelector("[data-tipinfo]").innerHTML = m ? `Send to ${m.accountName ? `<b>${esc(m.accountName)}</b> · ` : ""}${esc(m.accountNumber || m.number || "")}${m.qrUrl ? `<br><img src="${esc(m.qrUrl)}" alt="QR" style="max-width:150px;border-radius:10px;margin-top:6px"/>` : ""}` : ""; };
  const show = () => { box.querySelector("[data-tipmore]").style.display = amt >= 10 ? "" : "none"; info(); };
  box.querySelectorAll("[data-tipv]").forEach((b) => (b.onclick = () => { amt = Number(b.dataset.tipv); box.querySelector("[data-tipamt]").value = ""; box.querySelectorAll("[data-tipv]").forEach((x) => x.classList.toggle("on", x === b)); show(); }));
  box.querySelector("[data-tipamt]").oninput = (e) => { amt = Number(e.target.value) || 0; box.querySelectorAll("[data-tipv]").forEach((x) => x.classList.remove("on")); show(); };
  box.querySelectorAll("[data-tipm]").forEach((b) => (b.onclick = () => { method = b.dataset.tipm; box.querySelectorAll("[data-tipm]").forEach((x) => x.classList.toggle("on", x === b)); info(); }));
  box.querySelector("[data-tipsend]").onclick = async (e) => {
    e.target.disabled = true;
    try { await call("apptTip", { storeId: rec.storeId, id: rec.id, amount: amt, methodId: method, refNo: box.querySelector("[data-tipref]").value }); toast("Thank you! 💝"); }
    catch (x) { toast(x.message); e.target.disabled = false; }
  };
}
// 🎟️ walk-in line ticket on the status page
let ticketPrev = {};
function ticketHTML(a) {
  const q = a.queue || {}; const c = a.queueCalled; const now = Date.now();
  const grace = (store.salon?.queue?.graceMin || 10) * 60000;
  const cls = c?.at ? "called" : q.next ? "next" : "";
  const st = c?.at ? `🔔 It's your turn — please come in now!` : q.next ? `⏰ You're next — please be at the shop` : q.ahead != null ? `⏳ ${q.ahead} ahead of you${q.etaAt ? ` · about ${tShort(q.etaAt)}` : ""}` : "⏳ In line";
  return `<div class="c-ticketbig ${cls}" role="status" aria-live="polite"><div class="small muted">Your number</div><div class="no">#${a.waitNo || "—"}</div><div class="st">${st}</div>
    ${c?.at ? `<p class="small" style="margin:6px 0 0">Please come within <b data-gcd="${c.at + grace + (c.onWay ? 5 * 60000 : 0)}">–</b> or you'll move to the back of the line.</p>${c.onWay ? `<p class="small">✓ We told the shop you're on the way.</p>` : `<button type="button" class="c-btn brand" data-qway style="margin-top:8px">🚶 I'm on my way (5 min)</button>`}` : q.etaAt && !q.next ? `<p class="small muted" style="margin:6px 0 0">You can step out — we'll show “You're next” here${store.salon?.queue?.sms ? " and text you" : ""}. Keep this page open or come back to it.</p>` : ""}
    ${a.couple ? `<p class="c-hint" style="margin:6px 0 0">2 people — your companion has the next number${a.groupPart === 1 ? ` (#${(a.waitNo || 0) + 1})` : ""}.</p>` : ""}
    ${a.waitNote ? `<p class="small" style="color:var(--danger);margin:6px 0 0">${esc(a.waitNote)}</p>` : ""}
    <div data-qswap></div>
    <button type="button" class="c-btn ghost" data-qleave style="margin-top:10px">Leave the line</button></div>`;
}
function bindTicket(root, rec, a) {
  const k = rec.id, cur = a.queueCalled?.at ? "called" : a.queue?.next ? "next" : "wait";
  if (ticketPrev[k] && ticketPrev[k] !== cur && cur !== "wait") { try { navigator.vibrate?.([300, 120, 300, 120, 300]); } catch {} try { const ac = new (window.AudioContext || window.webkitAudioContext)(); const o = ac.createOscillator(); o.frequency.value = 880; o.connect(ac.destination); o.start(); o.stop(ac.currentTime + 0.35); } catch {} }
  ticketPrev[k] = cur;
  // "please come in" after a staff member accepted from the line
  if (!a.waiting && a.queueCalled?.auto && ["pending", "confirmed"].includes(a.status) && Date.now() - a.queueCalled.at < 30 * 60000) { const st = root.querySelector(".c-status"); st?.insertAdjacentHTML("afterbegin", `<div class="c-ticketbig called"><div class="no">#${a.waitNo || ""}</div><div class="st">🔔 ${esc(a.providerName || "Your therapist")} is ready for you — please come in!</div></div>`); }
  if (!a.waiting) return;
  const cd = root.querySelector("[data-gcd]");
  if (cd) { clearInterval(window.__gcd); const tick = () => { if (!cd.isConnected) return clearInterval(window.__gcd); const left = Math.max(0, Math.round((Number(cd.dataset.gcd) - Date.now()) / 1000)); cd.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`; }; tick(); window.__gcd = setInterval(tick, 1000); }
  root.querySelector("[data-qway]")?.addEventListener("click", async (e) => { e.target.disabled = true; try { await call("queueAction", { storeId: rec.storeId, id: rec.id, action: "onmyway" }); } catch (x) { toast(x.message); e.target.disabled = false; } });
  root.querySelector("[data-qleave]")?.addEventListener("click", async (e) => { if (!confirm("Leave the line? You'll lose your number.")) return; e.target.disabled = true; try { await call("queueAction", { storeId: rec.storeId, id: rec.id, action: "leave" }); toast("You left the line"); } catch (x) { toast(x.message); e.target.disabled = false; } });
  // long wait → offer a reserved time instead (so they can leave and come back at a fixed time)
  const sw = root.querySelector("[data-qswap]");
  if (sw && !a.queueCalled?.at && (a.queue?.etaAt || 0) - Date.now() > 30 * 60000) {
    const ids = (a.items || []).map((l) => (l.variantIdx != null ? `${l.itemId}~${l.variantIdx}` : l.itemId)).filter(Boolean);
    const d = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    call("getSlots", { slug, itemIds: ids, date: d, providerId: a.requestedProviderId || null, gender: a.genderPref || null }).then((r) => {
      const opts = (r.data?.slots || r.slots || []).filter((t) => t > Date.now() + 30 * 60000).slice(0, 3); if (!opts.length || !sw.isConnected) return;
      sw.innerHTML = `<p class="small" style="margin:10px 0 4px"><b>Long wait?</b> Reserve a fixed time instead:</p><div class="c-chips" style="justify-content:center">${opts.map((t) => `<button type="button" class="chip" data-swapt="${t}">${tShort(t)}</button>`).join("")}</div>`;
      sw.querySelectorAll("[data-swapt]").forEach((b) => (b.onclick = async () => { if (!confirm(`Leave the line and reserve ${tShort(Number(b.dataset.swapt))}?`)) return; try { await call("queueAction", { storeId: rec.storeId, id: rec.id, action: "swap", startAt: Number(b.dataset.swapt) }); toast("Reserved ✓"); } catch (x) { toast(x.message); } }));
    }).catch(() => {});
  }
}
function renderApptStatus(rec) {
  apptUnsub?.(); statusUnsub?.(); renderCartBar();
  app.innerHTML = `<div class="c-status"><div class="c-loading" style="min-height:40vh"><div class="c-spinner"></div></div></div>`;
  apptUnsub = onSnapshot(doc(db, "stores", rec.storeId, "appointments", rec.id), (snap) => {
    if (!snap.exists()) { saveLocal({ lastAppt: null }); return renderMenu(); }
    const a = snap.data(); const cfg = store.salon || {};
    const [title, sub] = APPT_STAGES[a.status] || [a.status, ""];
    const order = ["pending", "confirmed", "in_progress", "done"]; const idx = order.indexOf(a.status === "unconfirmed" ? "pending" : a.status);
    const bad = ["cancelled", "no_show"].includes(a.status); const done = a.status === "done";
    const start = a.startAt?.toDate?.(); const dl = a.confirmDeadline?.toDate?.();
    const canChange = ["unconfirmed", "pending", "confirmed"].includes(a.status) && start && start - Date.now() > (cfg.cancelHours || 0) * 3600000;
    const dur = a.durationConfirmed || a.durationEst;
    app.innerHTML = `<div>
      <header class="c-head"><div class="top"><div class="logo">${store.logoUrl ? `<img src="${esc(store.logoUrl)}" alt=""/>` : esc(store.name.trim()[0] || "·")}</div><div><h1>${esc(store.name)}</h1><div class="sub">Appointment</div></div></div></header>${seasonBar()}
      <div class="c-status">
        ${a.waiting ? ticketHTML(a) : a.source === "walkin" && ["pending", "confirmed"].includes(a.status) && a.startAt?.toDate && a.startAt.toDate() - Date.now() > 5 * 60000 ? `<div class="c-alert ok"><b>Estimated start: ${a.startAt.toDate().toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}</b> — set by the counter. Please be back a few minutes before.</div>` : ""}
        ${a.status === "unconfirmed" ? `<div class="c-alert warn"><b>⏳ Confirm your booking on Messenger</b> — reply to us within <b data-countdown>${cfg.confirmMinutes || 60}:00</b> or this slot is released to other clients.<br>${store.confirm?.messengerLink ? `<a class="c-btn brand block" style="margin-top:8px" href="${esc(store.confirm.messengerLink)}" target="_blank">Open Messenger</a>` : ""}<button class="c-btn ghost block" style="margin-top:6px" data-copymsg>Copy message</button></div>` : ""}
        <div class="c-ticket main">
          <div class="eyebrow">${bad ? "Booking" : "Your appointment"}</div>
          <div class="c-orderno" style="font-size:1.6rem">${esc(a.code)}</div>
          ${start ? `<div class="c-when">📅 ${start.toLocaleDateString("en-PH", { weekday: "long", month: "short", day: "numeric" })} · <b>Start ${start.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}</b></div>` : ""}
          <div class="muted small">~${dur} min ${a.durationConfirmed ? `<span style="color:var(--primary)">(confirmed by ${esc(a.durationBy || a.providerName || "the salon")})</span>` : "— estimate; your stylist will confirm the duration depending on your services"}</div>
          ${a.providerName ? `<div class="c-when">💇 ${esc(a.providerName)}</div>` : a.requestedProviderId ? "" : `<div class="muted small">Staff will be assigned by the salon</div>`}
          ${(a.shopMessenger || store.contact?.messenger) && !["cancelled", "no_show"].includes(a.status) ? `<div style="margin-top:8px">${msgrBtn(a.shopMessenger || store.contact.messenger, "c-btn ghost", `💬 Message ${esc(store.name)} on Messenger`)}</div>` : ""}
          ${a.homeService ? `<div class="c-when">🏠 Home service · ${esc(a.homeService.address || "")}${a.homeService.area ? ` · ${esc(a.homeService.area)}` : ""}</div>` : ""}
          ${a.roomName && !a.homeService && !bad && !done ? `<div class="small muted" style="margin:6px 0">🚪 Your room: <b>${esc(a.roomName)}</b>${a.couple ? " · couple booking (2 therapists)" : ""}</div>` : a.couple && !bad ? `<div class="small muted" style="margin:6px 0">👥 Booking for 2 · ${esc((a.group || []).map((x) => x.providerName).filter(Boolean).join(" + "))}</div>` : ""}
          ${a.escort && a.homeService && !bad && ["to_client", "dropped"].includes(a.escort.status) && !done ? `<div class="c-onway" role="status">${a.escort.status === "to_client" ? `🛵 ${esc((a.providerName || "Your therapist").split(" ")[0])} is on the way with our rider${a.onTheWay?.etaAt > Date.now() ? ` · around <b>${new Date(a.onTheWay.etaAt).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}</b>` : ""}` : `✅ ${esc((a.providerName || "Your therapist").split(" ")[0])} has arrived`}</div>` : ""}
          ${a.onTheWay && !a.escort && !bad && !done ? `<div class="c-onway" role="status">🚗 ${esc(a.onTheWay.by ? a.onTheWay.by.split(" ")[0] : "Your stylist")} is on the way${a.onTheWay.etaAt > Date.now() ? ` · arriving around <b>${new Date(a.onTheWay.etaAt).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}</b>` : ""}</div>` : ""}
          ${a.tentative && a.visitConfirm?.status === "waiting" && a.visitToken && !bad ? `<div class="c-alert warn">📅 This is your <b>next visit</b> set by the salon. Please confirm. <button class="c-btn brand block" data-vgo style="margin-top:8px">Confirm or change</button></div>` : ""}
          ${bad ? `<div class="c-cancel">${esc(title)}</div><p class="muted">${esc(a.cancelReason || sub)}</p>` : `<div class="c-timeline">${order.map((k, i) => `<div class="c-tl ${i <= idx ? "on" : ""} ${i === idx ? "now" : ""}"><div><div class="dot"></div>${i < 3 ? `<div class="line"></div>` : ""}</div><div class="lab">${esc(APPT_STAGES[k][0])}${i === idx ? `<small>${esc(a.staffNote || sub)}</small>` : ""}</div></div>`).join("")}</div>`}
          ${a.paid ? `<div class="c-paid">Paid</div>` : ""}
        </div>
        <div class="c-ticket">${(a.items || []).map((l) => `<div class="c-mini"><span>${esc(l.name)} <span class="muted small">~${l.duration} min</span></span><span class="amt">${money(l.price)}</span></div>`).join("")}${a.homeService ? `<div class="c-mini muted"><span>🏠 Home service fee${a.homeService.feeConfirmed ? "" : " (to be confirmed by the salon)"}</span><span class="amt">${money(a.homeFee || 0)}</span></div>` : ""}${a.discounts?.promo ? `<div class="c-mini"><span>Promo</span><span class="amt">−${money(a.discounts.promo)}</span></div>` : a.bookPromo ? `${(a.bookPromo.applied || []).map((x) => `<div class="c-mini"><span>${esc(x.name || x.label)}</span><span class="amt">${x.homeFee ? "Free transport" : "−" + money(x.amount)}</span></div>`).join("")}` : ""}${a.voucherCode && !a.paid ? `<div class="c-mini muted"><span>Code ${esc(a.voucherCode)} (at checkout)</span><span></span></div>` : ""}${a.discounts?.package ? `<div class="c-mini"><span>Package session${a.packageUsed ? ` · ${esc(a.packageUsed.name)}` : ""}</span><span class="amt">−${money(a.discounts.package)}</span></div>` : ""}${a.discounts?.loyalty ? `<div class="c-mini"><span>⭐ Loyalty reward</span><span class="amt">−${money(a.discounts.loyalty)}</span></div>` : ""}${a.discounts?.voucher ? `<div class="c-mini"><span>Voucher</span><span class="amt">−${money(a.discounts.voucher)}</span></div>` : ""}${a.discounts?.member ? `<div class="c-mini"><span>Member perks</span><span class="amt">−${money(a.discounts.member)}</span></div>` : ""}${a.discounts?.referral ? `<div class="c-mini"><span>Referral (first visit)</span><span class="amt">−${money(a.discounts.referral)}</span></div>` : ""}${a.discounts?.gift ? `<div class="c-mini"><span>🎁 Gift card ${esc(a.gift?.code || "")}</span><span class="amt">−${money(a.discounts.gift)}</span></div>` : ""}${a.dp && ["verified", "used"].includes(a.dp.status) ? `<div class="c-mini"><span>Reservation fee paid</span><span class="amt">−${money(a.dp.amount)}</span></div>` : ""}<div class="c-total big"><span>${a.paid ? "Paid" : "Total"}</span><span>${money(a.amountDue ?? Math.max(0, (a.total || 0) + (a.homeFee || 0) - (a.dp && a.dp.status === "verified" ? a.dp.amount : 0)))}</span></div>${a.tip ? `<div class="c-mini muted"><span>Tip</span><span class="amt">${money(a.tip)}</span></div>` : ""}${a.notes ? `<div class="muted small" style="margin-top:6px">Note: ${esc(a.notes)}</div>` : ""}</div>
        ${["pending", "confirmed", "unconfirmed"].includes(a.status) && start && start - Date.now() < 3 * 3600e3 ? (a.arrivedAt ? `<div class="c-alert ok">📍 Checked in ${new Date(a.arrivedAt).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })} — please have a seat, we'll call you.</div>` : `<div class="c-ticket main"><div class="eyebrow">Arriving?</div><div class="row" style="gap:8px"><button class="c-btn brand block" data-here>📍 I'm here</button><button class="c-btn ghost block" data-late>⏰ Running late</button></div>${a.lateBy ? `<p class="small muted" style="margin:6px 0 0">We know you're ~${a.lateBy.minutes} min late. Thanks for telling us!</p>` : ""}</div>`) : ""}
        ${a.dp ? `<div class="c-alert ${{ verified: "ok", used: "ok", to_verify: "warn" }[a.dp.status] || "error"}">💵 Reservation fee ${money(a.dp.amount)} · ${esc(a.dp.methodName)} ref ${esc(a.dp.refNo)} — ${{ to_verify: "waiting for the salon to check", verified: "received ✓ (deducted from your bill)", used: "deducted from your bill ✓", rejected: `not found${a.dp.rejectNote ? ": " + esc(a.dp.rejectNote) : ""} — please message the salon`, forfeited: "kept by the salon (missed appointment)", refund_due: "to be refunded — the salon will contact you" }[a.dp.status] || esc(a.dp.status)}</div>` : ""}
        ${a.group?.length > 1 ? `<div class="c-ticket"><div class="eyebrow">👥 Your visit · ${a.group.length} staff</div>${a.group.map((g, i) => `<div class="c-mini"><span>${i + 1}. ${new Date(g.startAt).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })} · ${esc(g.providerName)}</span><span class="small">${g.items.map(esc).join(", ")}</span></div>`).join("")}</div>` : ""}
        ${a.loyalty ? `<div class="c-ticket main"><div class="eyebrow">⭐ Loyalty card</div><div class="c-stamps">${Array.from({ length: a.loyalty.of }, (_, i) => `<span class="${i < a.loyalty.stamps ? "on" : ""}">${i < a.loyalty.stamps ? "★" : "☆"}</span>`).join("")}</div><div class="small">${a.loyalty.rewardUsed ? "Reward used today 🎉" : a.loyalty.stamps >= a.loyalty.of ? `<b>Reward ready:</b> ${esc(a.loyalty.rewardText)} — ask at your next visit!` : `${a.loyalty.of - a.loyalty.stamps} more visit${a.loyalty.of - a.loyalty.stamps > 1 ? "s" : ""} for: ${esc(a.loyalty.rewardText)}`}</div></div>` : ""}
        ${a.memberBought ? `<div class="c-alert ok">💎 You're a <b>${esc(a.memberBought.name)}</b> member until ${new Date(a.memberBought.expires).toLocaleDateString("en-PH", { dateStyle: "medium" })}${a.memberBought.discountPct ? ` · ${a.memberBought.discountPct}% off services` : ""}${a.memberBought.freeLeft ? ` · ${a.memberBought.freeLeft} free session(s) left` : ""}.</div>` : ""}
        ${a.gift?.balanceAfter > 0 ? `<div class="c-alert ok">🎁 Gift card ${esc(a.gift.code)} balance left: <b>${money(a.gift.balanceAfter)}</b></div>` : ""}
        ${a.myRefCode && store.salon?.referral?.enabled ? `<div class="c-ticket main"><div class="eyebrow">💌 Invite your friends</div><div class="c-orderno" style="font-size:1.6rem">${esc(a.myRefCode)}</div><p class="small">Friends get <b>₱${Number(store.salon.referral.reward) || 100} off</b> their first visit with your code — and you get ₱${Number(store.salon.referral.reward) || 100} off too!</p><button class="c-btn brand block" data-share>Share my code</button></div>` : ""}
        ${a.packageBought ? `<div class="c-alert ok">🎁 Package <b>${esc(a.packageBought.name)}</b> — ${a.packageBought.remaining} of ${a.packageBought.sessions} sessions left · valid until ${new Date(a.packageBought.expires).toLocaleDateString("en-PH", { dateStyle: "medium" })}. Use it at your next visit (same mobile number).</div>` : ""}
        ${["pending", "confirmed", "in_progress"].includes(a.status) ? `<button class="c-btn ghost block" data-addsvc style="margin-bottom:8px">➕ Add a service</button>` : ""}
        ${a.followUpId ? `<div class="c-alert ok">Your added service is booked as a follow-up right after — it will show on your status when this one is done.</div>` : ""}
        ${canChange ? `<div class="row" style="gap:8px"><button class="c-btn ghost block" data-resched>📅 Reschedule</button><button class="c-btn ghost block" data-cancel>Cancel</button></div>` : !bad && !done && a.status !== "in_progress" ? `<p class="muted small" style="text-align:center">Changes are allowed up to ${cfg.cancelHours || 0} h before. Please message the salon for changes.</p>` : ""}
        ${done && store.feedback?.enabled !== false ? (a.rating ? `<div class="c-ticket main"><div class="eyebrow">Your rating</div><div style="font-size:1.6rem;color:var(--accent)">${"★".repeat(a.rating)}</div><div class="muted small">Thanks for your feedback!</div></div>` : `<div class="c-ticket main" data-rate><div class="eyebrow">How was it?</div><div class="c-stars">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-star="${n}">★</button>`).join("")}</div><div class="muted small">Tap to rate</div></div>`) : ""}
        ${tipBoxHTML(a, done)}
        <div data-incident></div>
        ${!bad && store.incidents?.enabled !== false && ["in_progress", "done"].includes(a.status) ? `<button class="c-btn ghost block" data-report style="margin-bottom:8px">⚠️ Report a problem <span class="small">(photo required)</span></button>` : ""}
        ${!bad ? smsCardHTML(rec, a, "appt") : ""}
        ${protectHTML()}
        <button class="c-btn block ${done || bad ? "" : "ghost"}" data-more style="margin-top:8px">${done || bad ? "Book again" : "Back to services"}</button>
        <p class="muted small" style="text-align:center;margin-top:16px">This page updates on its own.</p>
      </div></div>`;
    saveLocal({ lastActive: done || bad ? null : { id: rec.id, storeId: rec.storeId, at: Date.now(), orderNo: a.code, status: title, kind: "appt" } });
    app.querySelector("[data-vgo]")?.addEventListener("click", () => { apptUnsub?.(); renderVisit(`${snap.id}.${a.visitToken}`); });
    bindProtect(app, rec.id);
    app.querySelector("[data-more]").onclick = () => { apptUnsub?.(); if (done || bad) saveLocal({ lastAppt: null }); else saveLocal({ lastAppt: null, lastActiveAppt: rec }); uiTab = done || bad ? "book" : "menu"; renderMenu(); };
    startCountdown(a.status === "unconfirmed" ? dl?.getTime() : null);
    bindTicket(app, rec, a);
    if (false) { const upd = async () => { try { const r = await call("waitlistPosition", { storeId: rec.storeId, id: rec.id }); const el = app.querySelector("[data-waitpos]"); if (el && r.waiting) el.textContent = r.ahead ? `· ${r.ahead} ahead of you` : "· you're next in line"; } catch {} }; upd(); clearInterval(window.__wl); window.__wl = setInterval(() => { if (!app.querySelector("[data-waitpos]")) return clearInterval(window.__wl); upd(); }, 60000); }
    app.querySelector("[data-copymsg]")?.addEventListener("click", () => { navigator.clipboard?.writeText(`Hi! Confirming my booking ${a.code} on ${start?.toLocaleString("en-PH", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} — ${a.customer?.name}`); toast("Copied — paste it in Messenger"); });
    app.querySelector("[data-cancel]")?.addEventListener("click", async () => { if (!confirm("Cancel this appointment?")) return; try { await call("cancelAppointment", { storeId: rec.storeId, id: rec.id }); toast("Cancelled"); } catch (e) { toast(e.message); } });
    app.querySelector("[data-resched]")?.addEventListener("click", () => openReschedule(rec, a));
    app.querySelector("[data-addsvc]")?.addEventListener("click", () => openAddService(rec, a));
    app.querySelector("[data-here]")?.addEventListener("click", async (ev) => { ev.target.disabled = true; try { await call("apptCheckIn", { storeId: rec.storeId, id: rec.id }); toast("Checked in ✓"); } catch (e) { toast(e.message); ev.target.disabled = false; } });
    app.querySelector("[data-late]")?.addEventListener("click", async () => { const m = prompt("About how many minutes late?", "10"); if (!m) return; try { await call("apptCheckIn", { storeId: rec.storeId, id: rec.id, action: "late", minutes: Number(m) }); toast("Thanks — we'll let your stylist know"); } catch (e) { toast(e.message); } });
    app.querySelector("[data-share]")?.addEventListener("click", async () => { const url = `${location.origin}/m/${slug}?ref=${encodeURIComponent(a.myRefCode)}`; const text = `Book at ${store.name} with my code ${a.myRefCode} and get ₱${Number(store.salon?.referral?.reward) || 100} off your first visit! ${url}`; try { if (navigator.share) await navigator.share({ title: store.name, text }); else { await navigator.clipboard.writeText(text); toast("Copied — paste it to your friends"); } } catch {} });
    app.querySelectorAll("[data-star]").forEach((b) => (b.onclick = () => openRate(rec, { ...a, orderNo: a.code, items: a.items }, Number(b.dataset.star))));
    bindTipBox(app, rec, a);
    app.querySelector("[data-report]")?.addEventListener("click", () => openReport(rec, { ...a, orderNo: a.code, serviceType: a.homeService ? "delivery" : "dine_in" }));
    watchIncident(rec, a);
  }, () => { saveLocal({ lastAppt: null }); renderMenu(); });
}
function openAddService(rec, a) {
  const items = (store.items || []).filter((i) => i.available !== false && !i.retail); const cats = store.categories || [];
  const body = html(`<div>${cats.map((c) => { const its = items.filter((i) => i.categoryId === c.id); return its.length ? `<div class="muted small" style="margin:10px 0 2px;font-weight:700">${esc(c.name)}</div>${its.map((i) => `<label class="c-choice c-svcline"><input type="checkbox" data-add="${i.id}"/><span><b>${esc(i.name)}</b><small>${money(i.price)} · ~${i.durationMinutes || 30} min</small></span></label>`).join("")}` : ""; }).join("")}<p class="muted small" style="margin-top:10px">If your stylist is free right after, it's added to this visit. Otherwise another available stylist takes it right after, or we'll show you the estimated wait.</p><div data-res></div></div>`);
  const foot = html(`<div class="c-ftrow"><button class="c-btn brand block" data-ok>Add</button></div>`);
  const go = async (waitOk) => {
    const ids = [...body.querySelectorAll("[data-add]:checked")].map((c) => c.dataset.add); if (!ids.length) return toast("Pick a service");
    foot.querySelector("[data-ok]").disabled = true;
    try {
      const r = await call("addServiceToAppointment", { storeId: rec.storeId, id: rec.id, itemIds: ids, waitOk });
      if (r.mode === "wait") { body.querySelector("[data-res]").innerHTML = `<div class="c-alert warn"><b>Estimated wait: ${r.waitMinutes} min</b> — ${esc(r.provider)} can take it at ${new Date(r.startAt).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}. Willing to wait?<br><button class="c-btn brand block" style="margin-top:8px" data-wait>Yes, book it</button></div>`; body.querySelector("[data-wait]").onclick = () => go(true); foot.querySelector("[data-ok]").disabled = false; return; }
      closeSheet(); toast(r.mode === "extended" ? `Added · +${r.minutes} min with your stylist` : `Booked with ${r.provider} at ${new Date(r.startAt).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })} (${r.code})`);
    } catch (e) { toast(e.message); foot.querySelector("[data-ok]").disabled = false; }
  };
  foot.querySelector("[data-ok]").onclick = () => go(false);
  openSheet("Add a service", body, foot, a.code);
}
function openReschedule(rec, a) {
  const cfg = store.salon || {}; const days = Array.from({ length: Math.min(60, cfg.maxDaysAhead || 14) }, (_, i) => { const d = new Date(); d.setDate(d.getDate() + i); return d; });
  const body = html(`<div><label>Day</label><select data-date>${days.map((d, i) => `<option value="${i}">${d.toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric" })}</option>`).join("")}</select><div data-slots class="c-slots"></div></div>`);
  let chosen = null;
  const load = async () => { const d = days[Number(body.querySelector("[data-date]").value)]; const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; const box = body.querySelector("[data-slots]"); box.innerHTML = "Checking…"; try { const r = await call("getSlots", { slug, itemIds: (a.items || []).map((l) => l.itemId), date, providerId: a.providerId || a.requestedProviderId || null }); box.innerHTML = r.slots.length ? r.slots.map((t) => `<button type="button" class="slot" data-t="${t}">${new Date(t).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}</button>`).join("") : `<p class="muted small">No slots that day.</p>`; box.querySelectorAll(".slot").forEach((b) => (b.onclick = () => { chosen = Number(b.dataset.t); box.querySelectorAll(".slot").forEach((x) => x.classList.toggle("on", x === b)); })); } catch (e) { box.textContent = e.message; } };
  body.querySelector("[data-date]").onchange = load; load();
  const foot = html(`<div class="c-ftrow"><button class="c-btn brand block" data-ok>Move appointment</button></div>`);
  foot.querySelector("[data-ok]").onclick = async () => { if (!chosen) return toast("Pick a slot"); try { await call("rescheduleAppointment", { storeId: rec.storeId, id: rec.id, startAt: new Date(chosen).toISOString() }); closeSheet(); toast("Rescheduled ✓"); } catch (e) { toast(e.message); } };
  openSheet("Reschedule", body, foot, a.code);
}
const LB_MODES = { rider_rider: ["🛵 Rider pickup · 🛵 Rider delivery", "We pick up at your address and deliver it back."], rider_pickup: ["🛵 Rider pickup · 🚶 You pick up", "We pick up at your address; you claim it at the shop."], dropoff_delivery: ["🚶 You drop off · 🛵 Rider delivery", "Bring it to the shop; we deliver it back."] };
function laundryBookModes() { const m = store.laundry?.modes || {}; return Object.keys(LB_MODES).filter((k) => m[k] !== false && store.addons?.delivery !== false); }
function renderLaundryBook(body) {
  const cfg = store.laundry || {}; const saved = loadLocal().customer || {}; const last = loadLocal().lastLaundry || null;
  const modes = laundryBookModes();
  const svcItems = (store.items || []).filter((i) => i.available !== false && (store.categories || []).some((c) => c.id === i.categoryId));
  const slots = []; for (let i = 0; i < 3; i++) { const d = new Date(); d.setDate(d.getDate() + i); const rgs = rangesFor(store.hours, DAYS[d.getDay()]); const [o, c] = rgs[0] || ["08:00", "18:00"]; for (let m = Number(o.slice(0, 2)) * 60 + Number(o.slice(3)); m + 60 <= Number(c.slice(0, 2)) * 60 + Number(c.slice(3)) + (c < o ? 1440 : 0); m += 120) { const w = new Date(d); w.setHours(Math.floor(m / 60), m % 60, 0, 0); if (w.getTime() < Date.now() + 3600000) continue; slots.push(w); } }
  body.innerHTML = `
    ${store.laundry?.pause?.active ? `<div class="c-alert warn"><b>⏸ ${esc(store.laundry.pause.reason)}</b>${store.laundry.pause.until ? ` · expected to resume ${esc(store.laundry.pause.until)}` : ""}</div>` : ""}
    ${store.laundry?.busy ? `<div class="c-alert warn"><b>🔥 We're busy right now</b> — jobs take about <b>+${store.laundry.busy.extraDays} day${store.laundry.busy.extraDays > 1 ? "s" : ""}</b> longer than usual.${store.laundry.busy.note ? ` ${esc(store.laundry.busy.note)}` : ""}<br><label class="c-agree" style="margin-top:8px"><input type="radio" name="busyc" value="wait" data-busywait/> I'm willing to wait (ready in ~${Math.round(((cfg.etaHours || 24) + (store.laundry.busy.extraHours || 0)) / 24 * 10) / 10} days)</label><label class="c-agree"><input type="radio" name="busyc" value="rush" data-busyrush/> ⚡ Add Rush (${cfg.rushMode === "fixed" ? `+${money(cfg.rushValue)}` : cfg.rushMode === "double" ? "2× price" : `+${cfg.rushValue ?? 50}%`}) — ready in ~${cfg.rushEtaHours || 6} h</label></div>` : ""}
    <div class="c-card-soft"><h2>Book a pickup / delivery</h2>
      ${last ? `<button class="c-btn ghost block" data-repeat style="margin-bottom:10px">🔁 Same as last time (${esc(last.summary || "")})</button>` : ""}
      <label>How</label><div class="c-opts" data-modes>${modes.map((k, i) => `<label class="c-choice"><input type="radio" name="lbmode" value="${k}" ${i === 0 ? "checked" : ""}/><span><b>${LB_MODES[k][0]}</b><small>${LB_MODES[k][1]}</small></span></label>`).join("")}</div>
      <div data-pickupwrap><label>Pickup time</label><select data-pickup>${slots.map((w) => `<option value="${w.toISOString()}">${w.toLocaleString("en-PH", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</option>`).join("") || `<option value="">No slots — call the shop</option>`}</select></div>
      <label>Services</label>
      ${svcItems.map((i) => `<label class="c-choice c-svcline"><input type="checkbox" data-svc="${i.id}"/><span><b>${esc(i.name)}</b><small>${i.unit === "estimate" ? "Quote after inspection" : `${money(i.price)} / ${esc(i.unit || "piece")}`}</small></span>${i.unit === "kg" ? `<input type="number" step="0.5" min="0" placeholder="~kg" data-qty="${i.id}" class="c-kg"/>` : i.unit === "piece" ? `<input type="number" min="1" placeholder="pcs" data-qty="${i.id}" class="c-kg"/>` : ""}</label>`).join("")}
      <p class="muted small">Final price is computed after weighing at the shop (min ${cfg.minKg || 0} kg). You'll see it on your status page and we'll message you.</p>
      <label class="c-agree"><input type="checkbox" data-rush/> ⚡ Rush (${cfg.rushMode === "fixed" ? `+${money(cfg.rushValue)}` : cfg.rushMode === "double" ? "2× price" : `+${cfg.rushValue ?? 50}%`}, ready in ${cfg.rushEtaHours || 6}h)</label>
      <label class="c-agree"><input type="checkbox" data-sep ${cfg.separateWhites !== false ? "checked" : ""}/> Separate whites / colors</label>
      ${!cfg.foldFree && cfg.foldFee ? `<label class="c-agree"><input type="checkbox" data-fold checked/> Fold (+${money(cfg.foldFee)}/kg)</label>` : ""}
      <label>Hand wash (optional — which items?)</label><input data-hand placeholder="e.g. 2 barong"/>
      <label>Name</label><input data-name value="${esc(saved.name || "")}"/>
      <label>Phone</label><input data-phone type="tel" value="${esc(saved.phone || "")}" placeholder="09XX XXX XXXX"/>
      ${msgrField(saved)}
      <label>Address</label><input data-address value="${esc(saved.address || "")}" placeholder="House no., street, barangay — landmarks help"/>
      <label>Notes</label><input data-note placeholder="optional"/>
      ${store.policies?.laundry ? `<label>Shop policy</label><div class="waiver-text">${esc(store.policies.laundry)}</div><label class="c-agree"><input type="checkbox" data-agree/> I have read and agree to the policy</label>` : ""}
      <button class="c-btn brand block" data-book style="margin-top:14px">Book now</button>
    </div>`;
  const g = (sel) => body.querySelector(sel);
  const modeChange = () => { const m = body.querySelector("[name=lbmode]:checked")?.value; g("[data-pickupwrap]").style.display = m === "dropoff_delivery" ? "none" : ""; };
  body.querySelectorAll("[name=lbmode]").forEach((r) => (r.onchange = modeChange)); modeChange();
  g("[data-repeat]")?.addEventListener("click", () => { (last.items || []).forEach((l) => { const cb = body.querySelector(`[data-svc="${l.itemId}"]`); if (cb) cb.checked = true; const q = body.querySelector(`[data-qty="${l.itemId}"]`); if (q && l.qty) q.value = l.qty; }); if (last.mode) { const r = body.querySelector(`[name=lbmode][value="${last.mode}"]`); if (r) r.checked = true; modeChange(); } g("[data-rush]").checked = !!last.rush; if (last.handWash) g("[data-hand]").value = last.handWash; toast("Filled in from your last booking"); });
  g("[data-book]").onclick = async (e) => {
    const items = [...body.querySelectorAll("[data-svc]:checked")].map((cb) => ({ itemId: cb.dataset.svc, qty: Number(body.querySelector(`[data-qty="${cb.dataset.svc}"]`)?.value || 0) }));
    if (!items.length) return toast("Pick at least one service");
    const customer = { name: g("[data-name]").value.trim(), phone: g("[data-phone]").value.trim(), address: g("[data-address]").value.trim(), messenger: readMsgr(body) };
    if (!customer.name || !customer.phone || !customer.address) return toast("Name, phone and address are required");
    const mode = body.querySelector("[name=lbmode]:checked")?.value;
    if (g("[data-agree]") && !g("[data-agree]").checked) return toast("Please agree to the shop policy");
    e.target.disabled = true; e.target.textContent = "Booking…";
    try {
      if (store.laundry?.busy && !g("[data-busywait]")?.checked && !g("[data-busyrush]")?.checked) { e.target.disabled = false; e.target.textContent = "Book now"; return toast("We're busy — choose 'willing to wait' or Rush"); }
      if (g("[data-busyrush]")?.checked) g("[data-rush]").checked = true;
      const r = await call("bookLaundryJob", { slug, mode, items, pickupAt: mode === "dropoff_delivery" ? null : g("[data-pickup]").value, waitOk: !!g("[data-busywait]")?.checked, rush: g("[data-rush]").checked, separateWhites: g("[data-sep]").checked, fold: g("[data-fold]") ? g("[data-fold]").checked : true, handWash: g("[data-hand]").value.trim(), note: g("[data-note]").value.trim(), customer });
      const rec = { id: r.orderId, storeId: r.storeId, at: Date.now() };
      const L0 = loadLocal();
      saveLocal({ customer, lastOrder: rec, orders: [...(L0.orders || []), rec], lastLaundry: { mode, items, rush: g("[data-rush]").checked, handWash: g("[data-hand]").value.trim(), summary: `${LB_MODES[mode][0].replace(/🛵|🚶/g, "").trim()} · ${items.length} service${items.length > 1 ? "s" : ""}` } });
      renderStatus(rec);
    } catch (err) { toast(err.message); e.target.disabled = false; e.target.textContent = "Book now"; }
  };
}
function laundryStages(o) {
  const cfg = store.laundry || {};
  let st = STAGES.laundry.filter(([k]) => (k !== "drying" || cfg.steps?.drying !== false) && (k !== "folding" || cfg.steps?.folding !== false));
  if (o.status === "unconfirmed") st = [["unconfirmed", "Confirm via Messenger", "Message us within the time limit"], ...st];
  if (["booked", "picking_up", "unconfirmed"].includes(o.status) || ["rider_rider", "rider_pickup"].includes(o.laundry?.mode)) st = [["booked", "Booked", o.laundry?.mode === "dropoff_delivery" ? "Drop off at the shop" : "Rider will pick up"], ...(o.laundry?.mode !== "dropoff_delivery" ? [["picking_up", "Rider picking up", "On the way to you"]] : []), ...st];
  if (o.status === "waiting_payment" || (o.laundry?.mode && !o.paid && cfg.paymentFirst)) st = st.flatMap((x) => x[0] === "weighed" ? [x, ["waiting_payment", "Waiting for payment", "Pay to start washing"]] : [x]);
  if (o.serviceType === "delivery") st = st.map((x) => x[0] === "ready" ? ["ready", "Ready", "Waiting for the rider"] : x[0] === "claimed" ? ["claimed", "Delivered", "Thank you!"] : x).flatMap((x) => x[0] === "ready" ? [x, ["out_for_delivery", "Out for delivery", "On its way to you"]] : [x]);
  return st;
}
function laundryCardHTML(o) {
  const L = o.laundry || {}; const cfg = store.laundry || {}; const pause = cfg.pause;
  const rb = L.readyBy?.toDate?.();
  const hist = (L.priceHistory || []).slice(-3);
  const gcash = (store.payments || []).filter((m) => m.type !== "cash");
  return `${pause?.active ? `<div class="c-alert warn"><b>⏸ ${esc(pause.reason)}</b>${pause.until ? ` · expected to resume ${esc(pause.until)}` : ""}<br><span class="small">Jobs may take longer than usual. Sorry for the inconvenience.</span></div>` : ""}${cfg.busy && !["ready", "claimed", "cancelled"].includes(o.status) && !L.rush ? `<div class="c-alert warn">🔥 <b>Busy period</b> — expect about +${cfg.busy.extraDays} day${cfg.busy.extraDays > 1 ? "s" : ""}. Ask the counter to add Rush if you need it sooner.</div>` : ""}
    <div class="c-ticket main c-stub">
      <div class="eyebrow">Claim stub · keep this</div>
      <div class="c-orderno"><i>#</i>${esc(L.ticketNo || o.orderNo)}</div>
      <div class="c-claim">Claim code <b>${esc(L.claimCode || "")}</b></div>
      <div class="muted small">${L.kg ? `${L.kg} kg · ${L.loads} load${L.loads > 1 ? "s" : ""}` : ""}${L.pcs != null ? ` · ${L.pcs} pcs` : ""}${L.rush ? " · ⚡ Rush" : ""}${L.container && L.container !== "none" ? ` · ${esc(L.container)}` : ""}</div>
      ${o.status === "booked" && L.pickupAt?.toDate ? `<div class="c-when">🛵 Pickup ${L.pickupAt.toDate().toLocaleString("en-PH", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>` : ""}
      ${rb && !["claimed", "cancelled"].includes(o.status) ? `<div class="c-when">⏰ Ready by ${rb.toLocaleString("en-PH", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>` : ""}
      <div class="small muted" style="margin-top:8px">Garments are released only to whoever presents this claim code. Screenshot this page.</div>
    </div>
    ${(() => { const ph = L.proof?.photos || []; if (!ph.length && L.pcs == null) return ""; const K = { scale: "⚖️ Weight", stain: "🟤 Stain", damage: "🩹 Damage", bag: "🧺 Pieces" };
      return `<div class="c-ticket"><div class="eyebrow">📷 Intake check · taken before washing</div>
      <div class="c-mini"><span>Pieces received</span><span class="amt"><b>${L.pcs != null ? `${L.pcs} pcs` : "—"}</b></span></div>${L.kg ? `<div class="c-mini"><span>Weight</span><span class="amt"><b>${L.kg} kg</b></span></div>` : ""}
      ${ph.length ? `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:8px">${ph.map((x) => `<figure style="margin:0"><img data-priv="${esc(x.url)}" data-priv-order="${esc(o.id)}" alt="" onclick="this.src&&window.open(this.src,'_blank')" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:10px;background:#eee;cursor:zoom-in"/><figcaption class="small">${K[x.kind] || ""}${x.note ? ` · ${esc(x.note)}` : ""}</figcaption></figure>`).join("")}</div>` : ""}
      <div class="small muted" style="margin-top:6px">Please check these. Message the shop right away if something looks wrong.</div></div>`; })()}
    ${(() => { if (o.status !== "ready" || !cfg.storageFeePerDay || !o.readyAt?.toDate) return ""; const days = Math.floor((Date.now() - o.readyAt.toDate()) / 86400000) - (cfg.storageFreeDays || 0); return days > 0 ? `<div class="c-alert warn">📦 <b>Storage fee running:</b> ${money(cfg.storageFeePerDay)} × ${days} day${days > 1 ? "s" : ""} = ${money(days * cfg.storageFeePerDay)} — added to your bill at pickup.</div>` : `<div class="c-alert ok">📦 Ready for pickup · free storage for ${cfg.storageFreeDays || 0} days${cfg.storageFeePerDay ? `, then ${money(cfg.storageFeePerDay)}/day` : ""}</div>`; })()}
    ${L.loyalty ? `<div class="c-ticket"><div class="eyebrow">🎁 Loyalty</div><div class="c-mini"><span>Washed so far</span><span class="amt">${L.loyalty.kgTotal} kg</span></div><div class="c-mini"><span>Free kg available</span><span class="amt"><b>${L.loyalty.available} kg</b></span></div><div class="muted small">Every ${L.loyalty.every} kg = ${L.loyalty.free} kg free. Ask the counter to apply it on your next job.</div></div>` : ""}
    ${store.policies?.laundry && ["received", "weighed", "washing", "booked"].includes(o.status) ? `<details class="c-ticket"><summary class="eyebrow" style="cursor:pointer">Shop policy</summary><div class="waiver-text" style="margin-top:8px">${esc(store.policies.laundry)}</div></details>` : ""}
    ${L.estimateOnly && !o.total ? `<div class="c-alert warn">💬 <b>Price to be quoted</b> after inspection. We'll message you — or message us first.</div>` : hist.length ? `<div class="c-alert ok">💰 <b>Price updated</b> to ${money(o.total)} (${L.kg} kg)${hist[hist.length - 1].from ? ` — was ${money(hist[hist.length - 1].from)}` : ""}</div>` : ""}
    ${!o.paid && o.total > 0 && gcash.length ? `<div class="c-ticket"><div class="eyebrow">Pay online (optional)</div>${gcash.map((m) => `<div class="c-mini"><span>${esc(m.name)}</span><span class="amt">${esc(m.number || "")}${m.accountName ? ` · ${esc(m.accountName)}` : ""}</span></div>${m.qrUrl ? `<img src="${esc(m.qrUrl)}" alt="" style="width:160px;display:block;margin:6px auto"/>` : ""}`).join("")}<div class="small muted">After paying, message us the reference number so we can mark it paid.</div></div>` : ""}`;
}
let statusUnsub = null;
let cdTimer = null, etaTimer = null;
/** "Ready in about N min" — counts down from accept time + prep minutes */
function startEta() {
  clearInterval(etaTimer);
  const tick = () => { const el = app.querySelector("[data-eta]"); if (!el) return clearInterval(etaTimer); const left = Math.ceil((Number(el.dataset.eta) - Date.now()) / 60000); el.textContent = left > 1 ? `Ready in about ${left} min` : left === 1 ? "Ready in about 1 min" : "Almost ready…"; };
  tick(); etaTimer = setInterval(tick, 15000);
}
/** live "mm:ss" countdown into [data-countdown] elements; auto-stops when gone */
function startCountdown(deadlineMs) {
  clearInterval(cdTimer); if (!deadlineMs) return;
  const tick = () => { const el = app.querySelector("[data-countdown]"); if (!el) return clearInterval(cdTimer); const left = Math.max(0, deadlineMs - Date.now()); const m = Math.floor(left / 60000), sec = Math.floor((left % 60000) / 1000); el.textContent = left <= 0 ? "0:00" : `${m}:${String(sec).padStart(2, "0")}`; };
  tick(); cdTimer = setInterval(tick, 1000);
}

function renderStatus(rec) {
  statusUnsub?.();
  window.onscroll = null;
  renderCartBar();
  app.innerHTML = `<div class="c-status"><div class="c-loading" style="min-height:40vh"><div class="c-spinner"></div></div></div>`;
  statusUnsub = onSnapshot(doc(db, "stores", rec.storeId, "orders", rec.id), (snap) => {
    if (!snap.exists()) { saveLocal({ lastOrder: null }); return renderMenu(); }
    const o = snap.data();
    let stages = o.type === "laundry" ? laundryStages(o) : o.serviceType === "delivery" ? STAGES.delivery : o.serviceType === "pickup" && o.type === "table" ? STAGES.pickup_t : (STAGES[o.type] || STAGES.table);
    if (o.needsConfirm) stages = [["unconfirmed", "Awaiting confirmation", "Confirm via Messenger"], ...stages];
    const schedAt = o.scheduledAt?.toDate?.();
    const idx = Math.max(0, stages.findIndex((s) => s[0] === o.status));
    const cancelled = o.status === "cancelled";
    const done = idx === stages.length - 1 || cancelled;
    const stage = stages[idx] || stages[0];
    const svcLabel = o.type === "laundry" ? ({ dropoff_pickup: "Drop-off · Pickup", rider_rider: "Rider pickup · Delivery", dropoff_delivery: "Drop-off · Delivery", rider_pickup: "Rider pickup · Store pickup" }[o.laundry?.mode] || "Laundry") : { dine_in: "Dine-in", take_out: "Take-out", pickup: "Pickup", delivery: "Delivery" }[o.serviceType] || "";
    const doneNow = ["completed", "delivered", "picked_up", "claimed", "cancelled"].includes(o.status);
    saveLocal({ lastActive: doneNow ? null : { id: rec.id, storeId: rec.storeId, at: Date.now(), orderNo: o.orderNo, status: (stages.find((s) => s[0] === o.status) || [])[1] || o.status } });
    app.innerHTML = `<div>
      <header class="c-head"><div class="top"><div class="logo">${store.logoUrl ? `<img src="${esc(store.logoUrl)}" alt=""/>` : esc(store.name.trim()[0] || "·")}</div><div><h1>${esc(store.name)}</h1><div class="sub">${svcLabel}${o.tableLabel ? " — " + esc(o.tableLabel) : ""}</div></div></div></header>${seasonBar()}
      <div class="c-status">
        <div data-roombar>${roomBarHTML()}</div>
        ${o.type === "laundry" ? laundryCardHTML(o) : ""}
        <div class="c-ticket main">
          ${o.type === "laundry" ? `<div class="eyebrow">Status</div>` : `<div class="eyebrow">Your order number</div>
          <div class="c-orderno"><i>#</i>${o.orderNo}</div>${o.parentId ? `<div class="c-when">➕ Add-on to order #${esc(o.parentOrderNo)}</div>` : ""}`}
          ${o.reservationCode ? `<div class="c-when">📅 Pre-order for ${esc(o.reservationCode)}${schedAt ? " · " + schedAt.toLocaleString("en-PH", { weekday: "short", hour: "numeric", minute: "2-digit" }) : ""}</div>` : schedAt ? `<div class="c-when">⏰ ${o.serviceType === "delivery" ? "Delivery" : "Pickup"} ${schedAt.toLocaleString("en-PH", { weekday: "short", hour: "numeric", minute: "2-digit" })}</div>` : ""}
          ${o.status === "out_for_delivery" && o.riderName ? `<div class="c-when">🛵 Rider: ${esc(o.riderName)}</div>` : ""}
          ${o.status === "unconfirmed" ? `<div class="c-alert warn" style="margin-top:12px;text-align:left"><b>To confirm your order</b>, message us on Messenger within <b data-countdown>${store.confirm?.minutes || 15}:00</b> — otherwise it is cancelled automatically and the slot is released.</div><button class="c-btn brand block" data-msgr>💬 Confirm via Messenger</button>` : ""}
          ${o.payment ? `<div class="c-when small">${o.payment.method === "cash" ? `💵 ${esc(o.payment.methodName)}${o.payment.switchedFrom ? ` (instead of ${esc(o.payment.switchedFrom)})` : ""}${o.payment.changeFor && o.payment.changeFor > o.total ? ` · change for ${money(o.payment.changeFor)}` : ""}` : `📱 ${esc(o.payment.methodName)}${o.payment.refNo ? ` · ref ${esc(o.payment.refNo)}` : ""} · ${o.paid ? "received ✓" : o.payment.status === "at_counter" ? "pay at the counter" : o.payment.status === "on_arrival" ? "send it when the rider arrives" : o.payment.status === "not_received" ? "not received yet" : "sent — the store is checking"}`}</div>` : ""}
          ${o.loyaltyReward ? `<div class="c-when small">🎁 Loyalty reward used: ${esc(o.loyaltyReward.text || "")} (−${money(o.loyaltyReward.value)})</div>` : ""}${o.loyaltyStamp === "earned" ? `<div class="c-alert ok" style="margin-top:10px;text-align:left">⭐ <b>You earned a loyalty stamp!</b></div>` : store.loyalty && !cancelled && !o.loyaltyStamp && o.customer?.phone && (o.total || 0) >= (store.loyalty.minTotal || 0) ? `<div class="c-when small">⭐ You'll get a loyalty stamp once this order is paid and completed.</div>` : ""}
          ${store.service?.payFirst && ["dine_in", "take_out"].includes(o.serviceType) && !o.paid && o.status === "pending" && !cancelled ? `<div class="c-alert warn" style="margin-top:12px;text-align:left">💵 <b>Please pay ${money(o.total)} at the counter.</b><br><span class="small">We start preparing your order once it's paid.</span></div>` : ""}
          ${o.payment && !o.paid && o.payment.status === "not_received" && !cancelled ? `<div class="c-alert error" style="margin-top:12px;text-align:left"><b>We haven't received your ${esc(o.payment.methodName)} payment yet.</b>${o.payment.note ? `<br><span class="small">${esc(o.payment.note)}</span>` : ""}<br><span class="small">Please check your ${esc(o.payment.methodName)} app. Your order is on hold until it's received.</span>
            <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><button class="c-btn sm brand" data-payagain>I sent it again</button>${(store.payments || []).some((m) => m.type === "cash") ? `<button class="c-btn sm ghost" data-paycash>I'll pay cash instead</button>` : ""}</div></div>` : ""}
          ${(o.comps || []).map((c) => `<div class="c-alert ok" style="margin-top:12px;text-align:left">🎁 <b>FREE for you:</b> ${esc(c.text)}</div>`).join("")}
          ${o.vipVoucher ? `<div class="c-alert ok" style="margin-top:12px;text-align:left">👑 <b>${o.vipVoucher.hours} free VIP room hour${o.vipVoucher.hours > 1 ? "s" : ""}!</b><br>Code <b style="letter-spacing:.06em">${esc(o.vipVoucher.code)}</b> · show it at the counter when you use a VIP room · valid until ${esc(o.vipVoucher.validTo)}<br><span class="small">Waiver signing required. Hourly rooms only.</span></div>` : ""}
          ${o.serviceType === "dine_in" && !o.roomId && tableToken && store.vip?.enabled && (store.vip.rooms || []).length && !cancelled && !["completed", "picked_up"].includes(o.status) ? `<button class="c-btn ghost block" data-movevip style="margin-top:10px">👑 Move to a VIP room</button>` : ""}
          ${o.lastEdit ? `<div class="c-alert warn" style="margin-top:12px;text-align:left">✏️ <b>Your order was updated by our staff</b> — ${esc(o.lastEdit.summary)}<br><span class="small">Reason: ${esc(o.lastEdit.reason)} · new total ${money(o.total)}</span></div>` : ""}
          ${o.balanceDue ? `<div class="c-alert warn" style="margin-top:12px;text-align:left">💰 Balance to pay: <b>${money(o.balanceDue)}</b></div>` : ""}
          ${o.heldForAddOn && o.status === "preparing" ? `<div class="c-alert ok" style="margin-top:12px;text-align:left">⏸ We're holding your order so your add-on goes out together.</div>` : ""}
          ${cancelled ? `<div class="c-cancel">Cancelled</div><p class="muted">${esc(o.cancelReason || "Please ask the staff.")}</p>` : `
          <div class="c-timeline">${stages.map((s, i) => `<div class="c-tl ${i <= idx ? "on" : ""} ${i === idx ? "now" : ""}"><div><div class="dot"></div>${i < stages.length - 1 ? `<div class="line"></div>` : ""}</div><div class="lab">${esc(s[1])}${i === idx ? `<small>${o.etaMinutes && !done && o.acceptedAt?.toMillis && ["preparing", "pending"].includes(o.status) ? `<span data-eta="${o.acceptedAt.toMillis() + o.etaMinutes * 60000}">Ready in about ${o.etaMinutes} min</span>` : o.etaMinutes && !done ? `Around ${o.etaMinutes} minutes` : esc(s[2])}</small>` : ""}${i === idx && o.status === "preparing" && o.stations && Object.keys(o.stations).length > 1 ? `<small>${Object.entries(o.stations).map(([k, v]) => `${{ kitchen: "Food", barista: "Drinks", counter: "Counter" }[k] || k}: ${v === "ready" ? "ready ✓" : "preparing"}`).join(" · ")}</small>` : ""}</div></div>`).join("")}</div>`}
          ${o.paid ? `<div class="c-paid">Paid</div>` : ""}
        </div>
        ${(() => { const packed = ["pickup", "delivery"].includes(o.serviceType); const can = o.type === "table" && !cancelled && !done && (packed ? ["pending", "preparing"].includes(o.status) : o.status !== "unconfirmed"); const call = o.serviceType === "dine_in" && !done && !cancelled && canCallStaff();
          return can || call ? `<div class="c-actions">${can ? `<button class="c-bigbtn" data-addmore><span class="ic">➕</span><span><b>Add more to this order</b><small>Extra rice, drinks, dessert — same ${packed ? "order" : "table"}, one bill</small></span></button>` : ""}${call ? `<button class="c-bigbtn alt" data-callstaff><span class="ic">🔔</span><span><b>Call staff</b><small>Water, utensils, the bill — we'll come to your table</small></span></button>` : ""}</div>` : ""; })()}
        <div class="c-ticket">
          ${o.items.map((l) => `<div class="c-mini"><span>${l.label ? esc(l.label) + " · " : l.qty + "× "}${esc(l.name)}${l.choices?.length ? ` <span class="muted small">${l.choices.map((c) => esc(c.label)).join(", ")}</span>` : ""}</span><span class="amt">${money(l.subtotal)}</span></div>`).join("")}
          ${o.discounts?.promo ? `<div class="c-mini muted"><span>Promo savings</span><span class="amt">−${money(o.discounts.promo)}</span></div>` : ""}
          ${o.voucher ? `<div class="c-mini muted"><span>Voucher ${esc(o.voucher.code)}</span><span class="amt">−${money(o.voucher.discount)}</span></div>` : ""}
          ${o.deliveryFee ? `<div class="c-mini muted"><span>Delivery fee</span><span class="amt">${money(o.deliveryFee)}</span></div>` : o.freeDelivery ? `<div class="c-mini muted"><span>Delivery fee</span><span class="amt">FREE 🛵</span></div>` : o.deliveryFeePending ? `<div class="c-mini muted"><span>Delivery fee</span><span class="amt">to be confirmed by the store</span></div>` : ""}
          ${o.smallOrderFee ? `<div class="c-mini muted"><span>Small-order fee</span><span class="amt">${money(o.smallOrderFee)}</span></div>` : ""}
          ${o.discounts?.incident ? `<div class="c-mini muted"><span>Sorry discount</span><span class="amt">−${money(o.discounts.incident)}</span></div>` : ""}
          <div class="c-total big"><span>Total</span><span>${money(o.total)}</span></div>
          <div data-alltotal></div>
          ${o.note ? `<div class="muted small" style="margin-top:8px">Note: ${esc(o.note)}</div>` : ""}
        </div>
        ${done && !cancelled && store.feedback?.enabled !== false ? (o.rating ? `<div class="c-ticket main"><div class="eyebrow">Your rating</div>${o.foodRating || o.serviceRating ? `<div class="c-mini"><span>🍽 Food</span><span style="color:var(--accent)">${"★".repeat(o.foodRating || 0)}</span></div><div class="c-mini"><span>🙋 Service</span><span style="color:var(--accent)">${"★".repeat(o.serviceRating || 0)}</span></div>` : `<div style="font-size:1.6rem;color:var(--accent)">${"★".repeat(o.rating)}</div>`}<div class="muted small">Thanks for your feedback!</div>${o.feedbackReply ? `<div class="c-alert ok" style="text-align:left;margin-top:10px"><b>${{ thanks: "💛 Thank you!", investigating: "🔎 We're looking into it", refund: "💸 Refund approved", voucher: "🎟️ A voucher for you", resolved: "✅ Reviewed" }[o.feedbackReply.type] || "Reply"}</b>${o.feedbackReply.note ? `<br>${esc(o.feedbackReply.note)}` : ""}${o.feedbackReply.voucherCode ? `<br>Code <b style="letter-spacing:.06em">${esc(o.feedbackReply.voucherCode)}</b> · ₱${o.feedbackReply.amount} off your next order · 1-time use until ${esc(o.feedbackReply.validTo || "")}` : ""}${o.feedbackReply.type === "refund" ? `<br><span class="small">Message us on Messenger to receive your refund${o.feedbackReply.amount ? ` of ₱${o.feedbackReply.amount}` : ""}.</span>` : ""}</div>` : ""}</div>` : `<div class="c-ticket main" data-rate><div class="eyebrow">How was your order? ${o.type === "table" ? "Rate the food &amp; service" : ""}</div><div class="c-stars">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-star="${n}">★</button>`).join("")}</div><div class="muted small">Tap to rate</div></div>`) : ""}
        ${!cancelled ? smsCardHTML(rec, o, "order") : ""}
        <div data-incident></div>
        ${(() => { if (cancelled || store.incidents?.enabled === false || o.status === "unconfirmed") return ""; if (o.type === "laundry" && o.laundry?.claimedAt?.toDate) { const hrs = store.laundry?.complaintHours || 24; const left = hrs * 3600000 - (Date.now() - o.laundry.claimedAt.toDate()); if (left <= 0) return `<p class="muted small" style="text-align:center">Complaint window (${hrs} h after claiming) has closed.</p>`; return `<button class="c-btn ghost block" data-report style="margin-bottom:8px">⚠️ Report a problem <span class="small">(${Math.ceil(left / 3600000)} h left · photo required)</span></button>`; } return `<button class="c-btn ghost block" data-report style="margin-bottom:8px">⚠️ Report a problem</button>`; })()}
        <button class="c-btn ghost block" data-receipt style="margin-bottom:8px">🧾 View receipt</button>
        <button class="c-btn block ${done ? "" : "ghost"}" data-more>${o.type === "laundry" ? "View services & news" : done ? "Order again" : "Back to menu"}</button>
        ${myOrders.length > 1 ? `<button class="c-btn ghost block" style="margin-top:8px" data-myorders>My orders</button>` : ""}
        <p class="muted small" style="text-align:center;margin-top:16px">This page updates on its own — no need to refresh.</p>
      </div></div>`;
    app.querySelector("[data-more]").onclick = () => { statusUnsub?.(); if (o.type === "laundry" && !doneNow) saveLocal({ lastActive: { id: rec.id, storeId: rec.storeId, at: Date.now(), orderNo: o.laundry?.ticketNo || o.orderNo, status: stage[1] } }); saveLocal({ lastOrder: null }); renderMenu(); };
    app.querySelector("[data-receipt]").onclick = () => openReceipt(o);
    app.querySelector("[data-payagain]")?.addEventListener("click", async (e) => { const refNo = prompt(`Sent it again? Add the ${o.payment.methodName} reference no. (optional):`, "") ; if (refNo === null) return; e.target.disabled = true; try { await call("customerPayAgain", { storeId: rec.storeId, orderId: rec.id, refNo }); toast("Thanks! The store will check again."); } catch (x) { toast(x.message); e.target.disabled = false; } });
    app.querySelector("[data-paycash]")?.addEventListener("click", async (e) => { e.target.disabled = true; try { await call("customerPayAgain", { storeId: rec.storeId, orderId: rec.id, cash: true }); toast("Okay — pay in cash when you get your order."); } catch (x) { toast(x.message); e.target.disabled = false; } });
    app.querySelector("[data-callstaff]")?.addEventListener("click", () => openCallSheet());
    if (o.serviceType === "dine_in" && !doneNow) renderCallButton();
    app.querySelector("[data-addmore]")?.addEventListener("click", () => { statusUnsub?.(); setAddTo({ id: o.parentId || rec.id, orderNo: o.parentOrderNo || o.orderNo, serviceType: o.serviceType }); saveLocal({ lastOrder: null, lastActive: { id: rec.id, storeId: rec.storeId, at: Date.now(), orderNo: o.orderNo, status: stage[1] } }); cart = []; renderMenu(); toast("Pick what to add — it goes on the same bill"); });
    startEta();
    // total for all orders (first order + add-ons)
    (async () => {
      const root = o.parentId ? (await getDoc(doc(db, "stores", rec.storeId, "orders", o.parentId)).catch(() => null))?.data() : o;
      const ids = root?.addOns || [];
      if (!ids.length) return;
      const kids = (await Promise.all(ids.map((id) => getDoc(doc(db, "stores", rec.storeId, "orders", id)).then((d) => d.data()).catch(() => null)))).filter(Boolean);
      const all = [root, ...kids].filter((x) => x && x.status !== "cancelled");
      const el = app.querySelector("[data-alltotal]"); if (!el) return;
      el.innerHTML = `<div class="c-allbill"><div class="eyebrow">Total for all orders</div>${all.map((x) => `<div class="c-mini"><span>#${x.orderNo}${x.parentId ? " (add-on)" : ""}</span><span class="amt">${money(x.total)}</span></div>`).join("")}<div class="c-total big"><span>All orders</span><span>${money(all.reduce((a, x) => a + (x.total || 0), 0))}</span></div></div>`;
    })();
    bindSms(app, rec, "order");
    app.querySelector("[data-movevip]")?.addEventListener("click", () => openMoveVip());
    startCountdown(o.status === "unconfirmed" ? o.confirmDeadline?.toMillis?.() : null);
    if (o.type === "laundry") hydratePrivate(app);
    app.querySelectorAll("[data-star]").forEach((b) => (b.onclick = () => openRate(rec, o, Number(b.dataset.star))));
    app.querySelector("[data-report]")?.addEventListener("click", () => openReport(rec, o));
    watchIncident(rec, o);
    app.querySelector("[data-msgr]")?.addEventListener("click", async () => {
      const msg = `Hi! Order #${o.orderNo} — ${o.customer?.name || ""}, ${o.customer?.phone || ""}. ${svcLabel}${o.customer?.address ? " to " + o.customer.address : ""}. Total ${money(o.total)}${o.payment ? ", " + o.payment.methodName : ""}. Please confirm. Thank you!`;
      try { await navigator.clipboard.writeText(msg); toast("Message copied — paste it in Messenger"); } catch {}
      const link = store.confirm?.messengerLink || "";
      if (link) setTimeout(() => window.open(link.startsWith("http") ? link : "https://" + link, "_blank"), 600);
      else toast("This store has no Messenger link. Please call " + (store.contact?.phone || "the store"));
    });
    renderCallButton();
    app.querySelector("[data-myorders]")?.addEventListener("click", () => renderMyOrders());
  }, (err) => {
    console.error(err);
    saveLocal({ lastOrder: null });
    renderMenu();
  });
}

function renderMyOrders() {
  statusUnsub?.();
  const body = html(`<div>${myOrders.map((r) => `<button class="c-btn ghost block" style="margin-bottom:8px;justify-content:space-between" data-id="${r.id}"><span>Order</span><span class="muted small">${new Date(r.at).toLocaleString("en-PH", { dateStyle: "short", timeStyle: "short" })}</span></button>`).join("") || `<p class="muted">No orders yet.</p>`}</div>`);
  body.querySelectorAll("[data-id]").forEach((b) => (b.onclick = () => { const r = myOrders.find((x) => x.id === b.dataset.id); closeSheet(); saveLocal({ lastOrder: r }); renderStatus(r); }));
  openSheet("My orders", body, null);
}

// ---------------- RESERVATION ----------------
const RESV_STAGES = { unconfirmed: ["Confirm via Messenger", "Message us to confirm your request"], pending: ["Requested", "Waiting for the store to confirm"], confirmed: ["Confirmed", "Your table is reserved"], seated: ["Seated", "Welcome!"], done: ["Done", "Thanks for visiting"], cancelled: ["Cancelled", ""], no_show: ["No-show", "Didn't arrive on time"] };
let resvUnsub = null;

function roomPriceText(r) {
  if (r.pricing === "consumable") return `Min. consumable ${money(r.minSpend)}`;
  if (r.pricing === "hour_consumable") return `${money(r.ratePerHour)} / hour, consumable`;
  return `${money(r.ratePerHour)} / hour`;
}
function openReserve(kind = "table") {
  const rs = store.reservations || {}, ev = store.events || {}, vp = store.vip || {};
  const saved = loadLocal().customer || {};
  const todayPH = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const maxPax = kind === "table" ? (rs.maxPax || 12) : kind === "vip" ? ((vp.rooms || []).reduce((m, r) => Math.max(m, Number(r.capacity) || 0), 0) || 20) : (ev.maxPax || 100);
  const titles = { table: "Reserve a table", event: "Book an event", vip: "Book a VIP room" };
  const intro = {
    table: `${rs.leadTimeHours ? `Please book at least ${rs.leadTimeHours} hours ahead. ` : ""}Up to ${rs.maxPax || 12} pax. For larger groups, use Event booking${store.contact?.phone ? ` or call ${esc(store.contact.phone)}` : ""}.`,
    event: `${ev.leadTimeDays ? `Please book at least ${ev.leadTimeDays} days ahead. ` : ""}${ev.depositPercent ? `A ${ev.depositPercent}% deposit is required to confirm. ` : ""}${esc(ev.note || "")}`,
    vip: `${vp.leadTimeHours ? `Please book at least ${vp.leadTimeHours} hours ahead. ` : ""}${esc(vp.note || "")}`,
  }[kind];

  const body = html(`<div>
    <p class="desc">${intro}</p>
    ${kind === "event" && (ev.packages || []).length ? `<label>Package</label><div class="c-pick" data-pkgs>${ev.packages.map((p) => `<button type="button" data-id="${p.id}"><b>${esc(p.name)}</b><span>${money(p.price)}${p.pricing === "flat" ? " flat" : " / head"}${p.minPax ? ` · min ${p.minPax} pax` : ""}</span>${p.description ? `<small>${esc(p.description)}</small>` : ""}</button>`).join("")}</div>` : ""}
    ${kind === "vip" ? `<div data-slots></div><label>Room</label><div class="c-pick" data-rooms>${(vp.rooms || []).map((r) => `<button type="button" data-id="${r.id}"><b>${esc(r.name)}</b><span>${roomPriceText(r)} · up to ${r.capacity} pax · min ${r.minHours || 1}h</span>${r.description ? `<small>${esc(r.description)}</small>` : ""}</button>`).join("")}</div>` : ""}
    <div class="c-grid2">
      <div><label>Date</label><input data-date type="date" min="${todayPH}" value="${todayPH}"/></div>
      <div><label>${kind === "event" ? "Start time" : "Time"}</label><input data-time type="time" step="900"/></div>
      ${kind === "event" ? `<div><label>End time</label><input data-endtime type="time" step="900"/></div>` : ""}
      ${kind === "vip" ? `<div><label>Hours</label><select data-hours>${[1,2,3,4,5,6,8].map((h) => `<option value="${h}" ${h === 2 ? "selected" : ""}>${h} hour${h > 1 ? "s" : ""}</option>`).join("")}</select></div>` : ""}
    </div>
    <label>How many people? <span class="muted small">(max ${maxPax})</span></label>
    <input data-paxn type="number" inputmode="numeric" min="1" max="${maxPax}" placeholder="e.g. ${kind === "event" ? 30 : 2}" />
    <label>Name</label><input data-name value="${esc(saved.name || "")}" placeholder="Your name"/>
    <label>Phone number</label><input data-phone type="tel" value="${esc(saved.phone || "")}" placeholder="09XX XXX XXXX"/>
    ${msgrField(saved)}
    <label>Occasion (optional)</label><input data-occ placeholder="${kind === "event" ? "Birthday, christening, team meeting…" : "Birthday, meeting, date…"}" maxlength="60"/>
    <label>Notes (optional)</label><input data-notes placeholder="${kind === "vip" ? "Song requests, decorations…" : "Window seat, high chair, allergies…"}" maxlength="300"/>
    <div class="c-est" data-est></div>
    ${store.policies?.[kind] || kind === "vip" ? `<label>Booking policy</label><div class="waiver-text">${esc([store.policies?.[kind], kind === "vip" ? overtimeClause(store.vip?.overtime) : "", kind === "vip" && (store.vip?.cleanMin ?? 30) ? `🧹 The room is cleaned for ${store.vip?.cleanMin ?? 30} minutes between bookings, so please finish on time — your room may still be getting ready a few minutes before your start.` : ""].filter(Boolean).join("\n\n"))}</div><label class="c-agree"><input type="checkbox" data-agree/> I have read and agree to the booking policy</label>` : ""}
    ${store.waiver?.[kind] ? `<p class="small muted" style="margin-top:8px">📝 After requesting, you'll sign a waiver on your phone (you'll get a PDF copy).</p>` : ""}
    <div data-err></div>
  </div>`);

  let pax = 0, packageId = null, roomId = null;
  body.querySelector("[data-paxn]").addEventListener("input", (e) => { pax = Number(e.target.value || 0); est(); });
  body.querySelectorAll("[data-pkgs] button").forEach((b) => (b.onclick = () => { packageId = b.dataset.id; body.querySelectorAll("[data-pkgs] button").forEach((x) => x.classList.toggle("on", x === b)); est(); }));
  body.querySelectorAll("[data-rooms] button").forEach((b) => (b.onclick = () => { roomId = b.dataset.id; body.querySelectorAll("[data-rooms] button").forEach((x) => x.classList.toggle("on", x === b)); est(); }));
  body.querySelector("[data-hours]")?.addEventListener("change", () => { est(); slots(); });
  if (kind === "vip") { body.querySelector("[data-date]").addEventListener("change", slots); body.querySelectorAll("[data-rooms] button").forEach((b) => b.addEventListener("click", slots)); const sl = body.querySelector("[data-slots]"); body.querySelector("[data-rooms]").after(sl); }
  let slotSeq = 0;
  async function slots() {
    const el = body.querySelector("[data-slots]"); if (!el || !roomId) return;
    const date = body.querySelector("[data-date]").value; if (!date) return;
    const my = ++slotSeq; el.innerHTML = `<p class="small muted">Checking free times…</p>`;
    try {
      const res = await call("getVipSlots", { slug, roomId, date, hours: Number(body.querySelector("[data-hours]").value) });
      if (my !== slotSeq) return;
      const free = res.slots.filter((x) => x.ok);
      const useNote = res.inUseUntil ? `<div class="c-alert warn" style="margin:6px 0">🔴 <b>In use right now</b> — free from about ${new Date(res.freeFrom).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })} (after cleaning). Pick a later time or another room.</div>` : "";
      el.innerHTML = useNote + `<label>Free start times <span class="muted small">(${res.hours}h · includes 30-min cleaning)</span></label>${free.length ? `<div class="c-chips">${res.slots.map((x) => { const t = new Date(x.t + 8 * 3600e3).toISOString().slice(11, 16); const lab = new Date(x.t).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" }); return `<button type="button" class="chip ${x.ok ? "" : "off"}" ${x.ok ? `data-t="${t}"` : "disabled"}>${lab}</button>`; }).join("")}</div>` : `<div class="c-alert warn">No free time for ${res.hours}h on this date. Try another date or fewer hours.</div>`}`;
      el.querySelectorAll("[data-t]").forEach((b) => (b.onclick = () => { body.querySelector("[data-time]").value = b.dataset.t; el.querySelectorAll("[data-t]").forEach((x) => x.classList.toggle("on", x === b)); }));
    } catch (e) { if (my === slotSeq) el.innerHTML = `<p class="small muted">${esc(e.message)}</p>`; }
  }
  function est() {
    const el = body.querySelector("[data-est]");
    let txt = "";
    if (kind === "event" && packageId) { const p = ev.packages.find((x) => x.id === packageId); const total = p.pricing === "flat" ? p.price : p.price * (pax || 0); txt = `Estimated: <b>${money(total)}</b>${ev.depositPercent ? ` · deposit ${money(Math.round(total * ev.depositPercent) / 100)}` : ""}`; }
    if (kind === "vip" && roomId) { const r = vp.rooms.find((x) => x.id === roomId); const h = Number(body.querySelector("[data-hours]").value);
      txt = r.pricing === "consumable" ? `No room fee · <b>min. consumable ${money(r.minSpend)}</b> (spent on orders)` : `Room: <b>${money((r.ratePerHour || 0) * h)}</b> for ${h}h${r.pricing === "hour_consumable" ? " · consumable (deducted from your bill)" : ""}`; }
    el.innerHTML = txt;
  }

  const foot = html(`<div><button class="c-btn brand block" data-go>${kind === "table" ? "Request reservation" : "Request booking"}</button></div>`);
  foot.querySelector("[data-go]").onclick = async () => {
    const g = (k) => body.querySelector(`[data-${k}]`)?.value.trim() || "";
    const err = body.querySelector("[data-err]");
    err.innerHTML = "";
    if (!g("date") || !g("time")) return (err.innerHTML = `<div class="c-alert error">Please pick a date and time.</div>`);
    if (!pax) return (err.innerHTML = `<div class="c-alert error">Enter the number of people.</div>`);
    if (pax > maxPax) return (err.innerHTML = `<div class="c-alert error">Up to ${maxPax} pax only. ${kind === "table" && store.events?.enabled ? "Use Event booking for larger groups." : store.contact?.phone ? `Please call ${esc(store.contact.phone)}.` : ""}</div>`);
    if (kind === "event" && (ev.packages || []).length && !packageId) return (err.innerHTML = `<div class="c-alert error">Please choose a package.</div>`);
    if (kind === "vip" && !roomId) return (err.innerHTML = `<div class="c-alert error">Please choose a room.</div>`);
    if (!g("name") || !g("phone")) return (err.innerHTML = `<div class="c-alert error">Name and phone number are required.</div>`);
    if (body.querySelector("[data-agree]") && !body.querySelector("[data-agree]").checked) return (err.innerHTML = `<div class="c-alert error">Please accept the booking policy.</div>`);
    const btn = foot.querySelector("[data-go]");
    btn.disabled = true; btn.textContent = "Sending…";
    try {
      const res = await call("createReservation", { slug, kind, policyAccepted: true, name: g("name"), phone: g("phone"), messenger: readMsgr(body), date: g("date"), time: g("time"), endTime: g("endtime") || null, hours: Number(g("hours") || 0) || null, pax, packageId, roomId, occasion: g("occ"), notes: g("notes") });
      saveLocal({ customer: { ...saved, name: g("name"), phone: g("phone"), messenger: readMsgr(body) } });
      const rec = { id: res.id, storeId: res.storeId, code: res.code, kind, at: Date.now() };
      myResv = [rec, ...myResv].slice(0, 10);
      saveLocal({ resv: myResv, lastResv: rec });
      closeSheet();
      renderResvStatus(rec);
    } catch (e) {
      err.innerHTML = `<div class="c-alert error">${esc(e.message || "Couldn't send. Please try again.")}</div>`;
      btn.disabled = false; btn.textContent = kind === "table" ? "Request reservation" : "Request booking";
    }
  };
  openSheet(titles[kind], body, foot, store.name);
}

function renderResvStatus(rec) {
  resvUnsub?.(); statusUnsub?.();
  window.onscroll = null;
  renderCartBar();
  app.innerHTML = `<div class="c-status"><div class="c-loading" style="min-height:40vh"><div class="c-spinner"></div></div></div>`;
  resvUnsub = onSnapshot(doc(db, "stores", rec.storeId, "reservations", rec.id), (snap) => {
    if (!snap.exists()) { saveLocal({ lastResv: null }); return renderMenu(); }
    const r = snap.data();
    const [title, sub] = RESV_STAGES[r.status] || [r.status, ""];
    const bad = r.status === "cancelled" || r.status === "no_show";
    const when = r.scheduledAt?.toDate?.() || new Date(`${r.date}T${r.time}:00+08:00`);
    const order = ["pending", "confirmed", "seated", "done"];
    const idx = order.indexOf(r.status);
    app.innerHTML = `<div>
      <header class="c-head"><div class="top"><div class="logo">${store.logoUrl ? `<img src="${esc(store.logoUrl)}" alt=""/>` : esc(store.name.trim()[0] || "·")}</div><div><h1>${esc(store.name)}</h1><div class="sub">Table reservation</div></div></div></header>${seasonBar()}
      <div class="c-status">
        <div class="c-ticket main">
          <div class="eyebrow">${{ event: "Event booking", vip: "VIP room booking" }[r.kind] || "Reservation"} code</div>
          <div class="c-orderno" style="font-size:2.4rem">${esc(r.code)}</div>
          <div class="c-when">${when.toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric" })} · ${when.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}${r.endTime ? `–${esc(r.endTime)}` : ""} · ${r.pax} pax${r.roomName ? ` · ${esc(r.roomName)}` : ""}${r.tableLabel ? ` · ${esc(r.tableLabel)}` : ""}</div>
          ${bad ? `<div class="c-cancel">${esc(title)}</div><p class="muted">${esc(r.staffNote || sub || "Please contact the store.")}</p>` : `
          <div class="c-timeline">${order.map((k, i) => `<div class="c-tl ${i <= idx ? "on" : ""} ${i === idx ? "now" : ""}"><div><div class="dot"></div>${i < 3 ? `<div class="line"></div>` : ""}</div><div class="lab">${esc(RESV_STAGES[k][0])}${i === idx ? `<small>${esc(r.staffNote || RESV_STAGES[k][1])}</small>` : ""}</div></div>`).join("")}</div>`}
        </div>
        <div class="c-ticket">
          <div class="c-mini"><span>Name</span><span>${esc(r.name)}</span></div>
          <div class="c-mini"><span>Phone</span><span>${esc(r.phone)}</span></div>
          ${r.packageName ? `<div class="c-mini"><span>Package</span><span>${esc(r.packageName)}</span></div>` : ""}
          ${r.estimate != null ? `<div class="c-mini"><span>${r.roomPricing === "consumable" ? "Min. consumable" : "Estimated"}</span><span><b>${money(r.estimate)}</b>${r.roomPricing === "hour_consumable" ? ` <span class="muted small">consumable</span>` : ""}</span></div>` : ""}
          ${r.deposit ? `<div class="c-mini"><span>Deposit</span><span>${money(r.deposit)}</span></div>` : ""}
          ${r.dpPaid ? `<div class="c-mini"><span>Downpayment received</span><span><b>${money(r.dpPaid)}</b> ✓</span></div>` : ""}
          ${r.extraHours ? `<div class="c-mini"><span>Extended</span><span>+${r.extraHours}h · ${money(r.extensionFee || 0)}</span></div>` : ""}
          ${r.dpPaid && (r.estimate || r.preorder) ? (() => { const tot = (r.kind === "vip" && r.roomPricing === "consumable" ? 0 : r.kind === "table" ? 0 : r.estimate || 0) + (r.preorder?.total || 0) + (r.extensionFee || 0); return tot ? `<div class="c-mini"><span>Balance (so far)</span><span><b>${money(Math.max(0, tot - r.dpPaid))}</b></span></div>` : ""; })() : ""}
          ${r.occasion ? `<div class="c-mini"><span>Occasion</span><span>${esc(r.occasion)}</span></div>` : ""}
          ${r.notes ? `<div class="c-mini"><span>Notes</span><span>${esc(r.notes)}</span></div>` : ""}
        </div>
        ${r.storeNote ? `<div class="c-alert warn">${esc(r.storeNote)}</div>` : ""}
        ${r.needsWaiver ? (r.waiver?.pdfUrl ? `<div class="c-ticket"><div class="eyebrow">📝 Waiver</div><div class="c-alert ok">Signed ✓ ${r.waiver.signedAt?.toDate ? r.waiver.signedAt.toDate().toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" }) : ""}</div><a class="c-btn ghost block" data-priv="${esc(r.waiver.pdfUrl)}" target="_blank">⬇ Download waiver PDF</a></div>` : !bad ? `<div class="c-ticket main"><div class="eyebrow">📝 Waiver</div><div class="c-alert warn">Please sign the waiver so your booking can be confirmed.</div><button class="c-btn brand block" data-sign>✍️ Sign waiver</button></div>` : "") : ""}
        ${r.preorder ? `<div class="c-ticket"><div class="eyebrow">📅 Pre-order #${r.preorder.orderNo}</div><div class="small">${(r.preorder.items || []).map(esc).join(", ")}</div><div class="c-total big" style="margin-top:4px"><span>Total</span><span>${money(r.preorder.total)}</span></div><button class="c-btn ghost block" data-viewpre style="margin-top:8px">View order status</button></div>`
          : ["pending", "confirmed"].includes(r.status) ? `<div class="c-ticket main"><div class="eyebrow">Want to pre-order?</div><p class="muted small">We'll have it ready before you arrive. Optional — you can also order when you get here.</p><button class="c-btn brand block" data-preorder>🍽️ Pre-order now</button></div>` : ""}
        ${r.reschedule?.status === "requested" ? `<div class="c-alert warn">📅 Reschedule requested → <b>${esc(r.reschedule.date)} ${esc(r.reschedule.time)}</b>. Waiting for the store.</div>` : r.reschedule?.status === "approved" ? `<div class="c-alert ok">📅 Your booking was moved to the new date ✓</div>` : r.reschedule?.status === "declined" ? `<div class="c-alert error">📅 The store couldn't move your booking. Please call us.</div>` : ""}
        ${["unconfirmed", "pending", "confirmed"].includes(r.status) && r.reschedule?.status !== "requested" ? `<button class="c-btn ghost block" data-resched>📅 Request a new date</button>` : ""}
        ${r.kind === "vip" && ["confirmed", "seated"].includes(r.status) && Date.now() > when.getTime() - 3600e3 ? `<button class="c-btn brand block" data-extend>⏱ Extend my hours</button>` : ""}
        <p class="muted small" style="text-align:center">Show this code when you arrive. Reschedule requests need ${r.kind === "event" ? "3 days'" : "1 day's"} notice. ${store.contact?.phone ? `To cancel, call ${esc(store.contact.phone)}.` : ""}</p>
        ${!bad ? smsCardHTML(rec, r, "resv") : ""}
        <button class="c-btn ghost block" data-back>Back to menu</button>
      </div></div>`;
    bindSms(app, rec, "resv");
    app.querySelector("[data-resched]")?.addEventListener("click", () => openResched(rec, r));
    app.querySelector("[data-extend]")?.addEventListener("click", async (ev) => {
      const h = prompt("Add how many hours? (1–3)", "1"); if (!h) return;
      ev.target.disabled = true;
      try { const res = await call("extendReservation", { storeId: rec.storeId, resvId: rec.id, hours: Number(h) }); toast(`Extended ✓ +${money(res.fee)} · now ${res.hours}h`); } catch (e) { alert(e.message); }
      ev.target.disabled = false;
    });
    startCountdown(r.status === "unconfirmed" ? r.confirmDeadline?.toMillis?.() || null : null);
    app.querySelector("[data-back]").onclick = () => { resvUnsub?.(); saveLocal({ lastResv: null }); renderMenu(); };
    hydratePrivate(app);
    app.querySelector("[data-sign]")?.addEventListener("click", () => openWaiver(rec, r));
    app.querySelector("[data-preorder]")?.addEventListener("click", () => {
      preorderFor = { id: rec.id, code: r.code, kind: r.kind, when: `${when.toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric" })} ${when.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}` };
      sessionStorage.setItem("orderqr:preorder:" + slug, JSON.stringify(preorderFor));
      resvUnsub?.(); saveLocal({ lastResv: null }); serviceType = "dine_in"; uiTab = "menu"; landed = true; renderMenu();
    });
    app.querySelector("[data-viewpre]")?.addEventListener("click", () => { const o = { id: r.preorder.orderId, storeId: rec.storeId, at: Date.now() }; if (!myOrders.find((x) => x.id === o.id)) { myOrders = [o, ...myOrders]; saveLocal({ orders: myOrders }); } resvUnsub?.(); saveLocal({ lastResv: null, lastOrder: o }); renderStatus(o); });
  }, () => { saveLocal({ lastResv: null }); renderMenu(); });
}

function openResched(rec, r) {
  const days = r.kind === "event" ? 3 : 1;
  const minD = new Date(Date.now() + 8 * 3600e3 + 86400e3).toISOString().slice(0, 10);
  const body = html(`<div><p class="desc">Requests need at least ${days} day${days > 1 ? "s" : ""} before your booking. The store will approve or decline.</p>
    <div class="c-grid2"><div><label>New date</label><input data-d type="date" min="${minD}" value="${esc(r.date || minD)}"/></div><div><label>New time</label><input data-t type="time" step="900" value="${esc(r.time || "")}"/></div></div>
    <label>Note (optional)</label><input data-n maxlength="160" placeholder="Reason or flexible times"/><div data-err></div></div>`);
  const foot = html(`<div><button class="c-btn brand block" data-go>Send request</button></div>`);
  foot.querySelector("[data-go]").onclick = async (ev) => {
    const err = body.querySelector("[data-err]"); err.innerHTML = ""; ev.target.disabled = true;
    try { await call("requestReschedule", { storeId: rec.storeId, resvId: rec.id, date: body.querySelector("[data-d]").value, time: body.querySelector("[data-t]").value, note: body.querySelector("[data-n]").value }); closeSheet(); toast("Request sent ✓"); }
    catch (e) { err.innerHTML = `<div class="c-alert error">${esc(e.message)}</div>`; ev.target.disabled = false; }
  };
  openSheet("Request a new date", body, foot, r.code);
}
function openMoveVip() {
  const rooms = store.vip?.rooms || [];
  const body = html(`<div><p class="desc">Pick a room. Our staff will check if it's free and move you — your current orders can count toward the room.</p><div class="c-pick" data-rooms>${rooms.map((r) => `<button type="button" data-id="${r.id}"><b>${esc(r.name)}</b><span>${roomPriceText(r)} · up to ${r.capacity} pax · min ${r.minHours || 1}h</span></button>`).join("")}</div>
    <label>Hours</label><select data-h>${[1, 2, 3, 4, 5, 6].map((h) => `<option ${h === 2 ? "selected" : ""} value="${h}">${h} hour${h > 1 ? "s" : ""}</option>`).join("")}</select><div data-err></div></div>`);
  let room = null;
  body.querySelectorAll("[data-id]").forEach((b) => (b.onclick = () => { room = rooms.find((x) => x.id === b.dataset.id); body.querySelectorAll("[data-id]").forEach((x) => x.classList.toggle("on", x === b)); }));
  const foot = html(`<div><button class="c-btn brand block" data-go>👑 Ask staff to move us</button></div>`);
  foot.querySelector("[data-go]").onclick = async (ev) => {
    const err = body.querySelector("[data-err]"); err.innerHTML = "";
    if (!room) return (err.innerHTML = `<div class="c-alert error">Choose a room.</div>`);
    ev.target.disabled = true;
    try { await call("callStaff", { slug, tableToken, type: "vip", message: `Move to ${room.name} for ${body.querySelector("[data-h]").value}h` }); closeSheet(); toast("Request sent — staff will come to your table ✓"); }
    catch (e) { err.innerHTML = `<div class="c-alert error">${esc(e.message)}</div>`; ev.target.disabled = false; }
  };
  openSheet("Move to a VIP room", body, foot, store.name);
}
function openWaiver(rec, r) {
  const idMode = store.waiver?.idMode || "optional";
  const pad = signaturePad();
  const body = html(`<div>
    <div class="waiver-text">${esc([store.waiver?.text, r.kind === "vip" ? overtimeClause(store.vip?.overtime) : ""].filter(Boolean).join("\n\n"))}</div>
    <label>Full name</label><input data-sname value="${esc(r.name || "")}"/>
    ${idMode !== "off" ? `<label>ID photo ${idMode === "required" ? "(required)" : "(optional)"}</label><input type="file" accept="image/*" capture="environment" data-idf/><div class="small muted">🔒 ${PRIVACY_NOTE}</div>` : ""}
    <label>Signature</label><div data-pad></div>
    <p class="small muted" style="margin-top:8px">By signing, you agree to the waiver above. You'll receive a PDF copy.</p>
    <div data-err></div></div>`);
  body.querySelector("[data-pad]").appendChild(pad.el);
  const foot = html(`<div><button class="c-btn brand block" data-go>✍️ Submit signature</button></div>`);
  foot.querySelector("[data-go]").onclick = async () => {
    const err = body.querySelector("[data-err]"); err.innerHTML = "";
    const signerName = body.querySelector("[data-sname]").value.trim();
    const idFile = body.querySelector("[data-idf]")?.files?.[0] || null;
    if (signerName.length < 2) return (err.innerHTML = `<div class="c-alert error">Enter your full name.</div>`);
    if (idMode === "required" && !idFile) return (err.innerHTML = `<div class="c-alert error">An ID photo is required.</div>`);
    if (pad.isEmpty()) return (err.innerHTML = `<div class="c-alert error">Please sign in the box.</div>`);
    const btn = foot.querySelector("[data-go]"); btn.disabled = true; btn.textContent = "Creating PDF…";
    try {
      const files = await signAndUploadWaiver({ storeId: rec.storeId, uid: auth.currentUser.uid, store, resv: { ...r, code: r.code }, waiverText: [store.waiver?.text, r.kind === "vip" ? overtimeClause(store.vip?.overtime) : ""].filter(Boolean).join("\n\n"), signerName, sigDataUrl: pad.dataUrl(), idFile });
      await call("attachWaiver", { storeId: rec.storeId, reservationId: rec.id, ...files, signerName });
      closeSheet(); toast("Waiver signed ✓");
    } catch (e) { console.error(e); err.innerHTML = `<div class="c-alert error">${esc(e.message || "Upload failed.")}</div>`; btn.disabled = false; btn.textContent = "✍️ Submit signature"; }
  };
  openSheet("Sign waiver", body, foot, r.code);
}

function renderMyResv() {
  const body = html(`<div><div class="c-ticket" style="margin-bottom:12px"><div class="eyebrow">Find my booking</div><div class="c-grid2"><div><label>Reference no.</label><input data-fcode placeholder="e.g. V-1024-AB12" style="text-transform:uppercase"/></div><div><label>Mobile no. used</label><input data-fphone type="tel" placeholder="09XX XXX XXXX"/></div></div><div data-ferr></div><button class="c-btn brand block" data-find style="margin-top:8px">🔎 Find</button></div>${myResv.map((r) => `<button class="c-btn ghost block" style="margin-bottom:8px;justify-content:space-between" data-id="${r.id}"><span>${esc(r.code)}</span><span class="muted small">${new Date(r.at).toLocaleDateString("en-PH", { dateStyle: "medium" })}</span></button>`).join("") || `<p class="muted">No reservations on this phone yet.</p>`}</div>`);
  body.querySelectorAll("[data-id]").forEach((b) => (b.onclick = () => { const r = myResv.find((x) => x.id === b.dataset.id); closeSheet(); saveLocal({ lastResv: r }); renderResvStatus(r); }));
  body.querySelector("[data-find]").onclick = async (ev) => {
    const err = body.querySelector("[data-ferr]"); err.innerHTML = "";
    const code = body.querySelector("[data-fcode]").value.trim(), phone = body.querySelector("[data-fphone]").value.trim();
    if (!code || !phone) return (err.innerHTML = `<div class="c-alert error">Enter the reference no. and your mobile number.</div>`);
    ev.target.disabled = true;
    try {
      const res = await call("findReservation", { slug, code, phone });
      const rec = { id: res.id, storeId: res.storeId, code: res.code, kind: res.kind, at: Date.now() };
      myResv = [rec, ...myResv.filter((x) => x.id !== rec.id)].slice(0, 10); saveLocal({ resv: myResv, lastResv: rec });
      closeSheet(); renderResvStatus(rec);
    } catch (e) { err.innerHTML = `<div class="c-alert error">${esc(e.message)}</div>`; ev.target.disabled = false; }
  };
  openSheet("My reservations", body, null);
}

// ---------------- CALL STAFF ----------------
const CALL_LABELS = { bill: "💵 Bill out", water: "💧 Water", utensils: "🍴 Utensils / condiments", help: "🙋 Help with order", clean: "🧹 Clean table", other: "💬 Other" };
let callUnsub = null, callTimer = null, activeCall = null;
const callKey = () => `orderqr:call:${slug}`;

function canCallStaff() { return store?.callStaff?.enabled && table && tableToken && !store.locked; }

/** floating button with a cooldown countdown */
function renderCallButton() {
  document.querySelector(".c-callbtn")?.remove();
  clearInterval(callTimer);
  if (!canCallStaff()) return;
  const btn = html(`<button class="c-callbtn" type="button">🔔<span>Call staff</span></button>`);
  document.body.appendChild(btn);
  const saved = JSON.parse(localStorage.getItem(callKey()) || "null");
  if (saved?.id && saved.storeId) watchCall(saved);
  const tick = () => {
    const rec = JSON.parse(localStorage.getItem(callKey()) || "null");
    const until = rec?.until || 0;
    const left = Math.ceil((until - Date.now()) / 1000);
    const open = activeCall && activeCall.status !== "done";
    if (open) { btn.innerHTML = `🔔<span>${activeCall.status === "claimed" ? esc(activeCall.claimedByName || "Staff") + " on the way" : "Request sent"}</span>`; btn.classList.add("live"); }
    else if (left > 0) { btn.innerHTML = `🔔<span>${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}</span>`; btn.classList.add("wait"); btn.classList.remove("live"); }
    else { btn.innerHTML = `🔔<span>Call staff</span>`; btn.classList.remove("wait", "live"); }
  };
  tick(); callTimer = setInterval(tick, 1000);
  btn.onclick = () => openCallSheet();
}

function watchCall(rec) {
  callUnsub?.();
  callUnsub = onSnapshot(doc(db, "stores", rec.storeId, "requests", rec.id), (snap) => {
    activeCall = snap.exists() ? { id: snap.id, ...snap.data() } : null;
    if (activeCall?.status === "done") { const r = JSON.parse(localStorage.getItem(callKey()) || "{}"); localStorage.setItem(callKey(), JSON.stringify({ ...r, until: 0 })); }
    if (document.querySelector(".c-sheet [data-callthread]")) drawCallThread();
  }, () => {});
}

function openCallSheet() {
  const cs = store.callStaff || {};
  const rec = JSON.parse(localStorage.getItem(callKey()) || "null");
  const left = Math.ceil(((rec?.until || 0) - Date.now()) / 1000);
  const open = activeCall && activeCall.status !== "done";
  if (open) return openCallThread();
  if (left > 0) { toast(`You can call again in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`); return; }
  const opts = (cs.options && cs.options.length ? cs.options : Object.keys(CALL_LABELS)).filter((k) => CALL_LABELS[k]);
  let type = null;
  const body = html(`<div>
    <p class="desc">${esc(table.label)} · What do you need?</p>
    <div class="c-pick" data-opts>${opts.map((k) => `<button type="button" data-k="${k}"><b>${CALL_LABELS[k]}</b></button>`).join("")}</div>
    ${cs.allowMessage !== false ? `<label>Message (optional)</label><input data-msg maxlength="200" placeholder="e.g. out of tissue, extra rice…"/>` : ""}
    <p class="muted small" style="margin-top:10px">One request every ${cs.cooldownMin || 5} minutes.</p>
    <div data-err></div>
  </div>`);
  body.querySelectorAll("[data-k]").forEach((b) => (b.onclick = () => { type = b.dataset.k; body.querySelectorAll("[data-k]").forEach((x) => x.classList.toggle("on", x === b)); }));
  const foot = html(`<div><button class="c-btn brand block" data-send>Send request</button></div>`);
  foot.querySelector("[data-send]").onclick = async () => {
    const err = body.querySelector("[data-err]");
    if (!type) return (err.innerHTML = `<div class="c-alert error">Please choose what you need.</div>`);
    const btn = foot.querySelector("[data-send]"); btn.disabled = true; btn.textContent = "Sending…";
    try {
      const res = await call("callStaff", { slug, tableToken, type, message: body.querySelector("[data-msg]")?.value.trim() || "" });
      localStorage.setItem(callKey(), JSON.stringify({ id: res.id, storeId: res.storeId, until: Date.now() + res.cooldownMs }));
      watchCall(res);
      closeSheet(); toast("Sent! Staff is on the way.");
      setTimeout(openCallThread, 400);
    } catch (e) {
      err.innerHTML = `<div class="c-alert error">${esc(e.message)}</div>`; btn.disabled = false; btn.textContent = "Send request";
    }
  };
  openSheet("Call staff", body, foot, store.name);
}

function openCallThread() {
  const body = html(`<div data-callthread><div data-th></div></div>`);
  const foot = html(`<div class="c-ftrow"><input data-reply placeholder="Reply…" maxlength="200" style="flex:1"/><button class="c-btn" data-send>Send</button></div>`);
  foot.querySelector("[data-send]").onclick = async () => {
    const text = foot.querySelector("[data-reply]").value.trim();
    if (!text || !activeCall) return;
    const rec = JSON.parse(localStorage.getItem(callKey()) || "{}");
    await updateDoc(doc(db, "stores", rec.storeId, "requests", activeCall.id), { messages: arrayUnion({ from: "customer", text, at: Date.now() }), updatedAt: serverTimestamp() }).catch((e) => toast(e.message));
    foot.querySelector("[data-reply]").value = "";
  };
  openSheet("Your request", body, activeCall?.status === "done" ? null : foot, table.label);
  drawCallThread();
}
function drawCallThread() {
  const th = document.querySelector(".c-sheet [data-th]");
  if (!th || !activeCall) return;
  const r = activeCall;
  const st = r.status === "done" ? "Done ✓" : r.status === "claimed" ? `${esc(r.claimedByName || "Staff")} is on the way` : "Waiting for staff…";
  th.innerHTML = `<div class="c-alert ${r.status === "done" ? "ok" : r.status === "claimed" ? "ok" : "warn"}"><b>${CALL_LABELS[r.type] || esc(r.type)}</b> · ${st}</div>
    <div class="c-thread">${(r.messages || []).map((m) => `<div class="msg ${m.from}"><span>${esc(m.text)}</span><small>${m.from === "customer" ? "You" : esc(m.staffName || "Staff")} · ${new Date(m.at).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}</small></div>`).join("") || `<p class="muted small">No messages yet.</p>`}</div>`;
}

// ---------------- RECEIPT ----------------
function openReceipt(o) {
  const paidAt = o.paidAt?.toDate?.();
  const body = html(`<div class="c-receipt">
    <div class="rh">${store.logoUrl ? `<img src="${esc(store.logoUrl)}" alt=""/>` : ""}<b>${esc(store.name)}</b>${store.contact?.address ? `<div>${esc(store.contact.address)}</div>` : ""}${store.contact?.phone ? `<div>${esc(store.contact.phone)}</div>` : ""}</div>
    <div class="rl"><span>Order</span><span>#${o.orderNo}</span></div>
    <div class="rl"><span>Date</span><span>${(o.createdAt?.toDate?.() || new Date()).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" })}</span></div>
    <div class="rl"><span>Type</span><span>${{ dine_in: "Dine-in", take_out: "Take-out", pickup: "Pickup", delivery: "Delivery" }[o.serviceType] || ""}${o.tableLabel ? " · " + esc(o.tableLabel) : ""}</span></div>
    <hr/>${o.items.map((l) => `<div class="rl"><span>${l.qty}× ${esc(l.name)}${l.choices?.length ? `<br><small>${l.choices.map((c) => esc(c.label)).join(", ")}</small>` : ""}</span><span>${money(l.subtotal)}</span></div>`).join("")}<hr/>
    ${o.discounts?.promo ? `<div class="rl"><span>Promo savings</span><span>−${money(o.discounts.promo)}</span></div>` : ""}
    ${o.voucher ? `<div class="rl"><span>Voucher ${esc(o.voucher.code)}</span><span>−${money(o.voucher.discount)}</span></div>` : ""}
    ${o.deliveryFee ? `<div class="rl"><span>Delivery fee</span><span>${money(o.deliveryFee)}</span></div>` : ""}
    ${o.smallOrderFee ? `<div class="rl"><span>Small-order fee</span><span>${money(o.smallOrderFee)}</span></div>` : ""}
    <div class="rl big"><span>TOTAL</span><span>${money(o.total)}</span></div>
    ${o.paid ? `<div class="rpaid">PAID${o.paymentMethodName || o.paymentMethod ? " · " + esc((o.paymentMethodName || o.paymentMethod).toUpperCase()) : ""}${paidAt ? " · " + paidAt.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" }) : ""}</div>` : `<div class="rl muted"><span>Payment</span><span>Unpaid</span></div>`}
    <p class="muted small" style="text-align:center;margin-top:14px">This is your digital receipt. Thank you!</p>
  </div>`);
  const foot = html(`<div class="c-ftrow"><button class="c-btn ghost" data-print>🖨 Print / Save PDF</button>${navigator.share ? `<button class="c-btn" data-share>Share</button>` : ""}</div>`);
  foot.querySelector("[data-print]").onclick = () => { document.body.classList.add("print-receipt"); window.print(); setTimeout(() => document.body.classList.remove("print-receipt"), 500); };
  foot.querySelector("[data-share]")?.addEventListener("click", () => navigator.share({ title: `${store.name} receipt #${o.orderNo}`, text: `Order #${o.orderNo} · ${money(o.total)} · ${o.paid ? "PAID" : "Unpaid"}`, url: location.href }).catch(() => {}));
  openSheet("Receipt", body, foot, `#${o.orderNo}`);
}

// ---------------- FEEDBACK ----------------
function openRate(rec, o, initial) {
  let rating = initial;
  const kind = o.code ? "appt" : o.type === "laundry" ? "laundry" : "order";
  const RR = rateRows(kind, initial); const dual = true;
  const body = html(`<div>
    ${RR.html}
    <label>Comment (optional)</label><textarea data-c rows="3" maxlength="500" placeholder="What did you like, or what could be better?"></textarea>
    ${store.feedback?.askPhoto ? `<label>Photo (optional)</label><input type="file" accept="image/*" data-f/><div class="small muted" data-fs></div>` : ""}
    <div data-err></div></div>`);
  RR.bind(body);
  const foot = html(`<div><button class="c-btn brand block" data-send>Submit rating</button></div>`);
  foot.querySelector("[data-send]").onclick = async () => {
    if (!RR.complete()) { body.querySelector("[data-err]").innerHTML = `<div class="c-alert error">Please rate each one (tap the stars).</div>`; return; }
    const btn = foot.querySelector("[data-send]"); btn.disabled = true; btn.textContent = "Sending…";
    try {
      let photoUrl = null;
      const f = body.querySelector("[data-f]")?.files?.[0];
      if (f) { body.querySelector("[data-fs]").textContent = "Uploading photo…"; photoUrl = await uploadCustomerImage(rec.storeId, auth.currentUser.uid, f, { max: 1000 }); }
    await call("submitFeedback", { storeId: rec.storeId, orderId: rec.id, kind, cats: RR.R, comment: body.querySelector("[data-c]").value.trim(), photoUrl });
      closeSheet(); toast("Thanks for your feedback! ⭐");
      const stars = RR.avg(); void rating; void dual;
      if (stars >= 5 && store.reviewUrl) { const b = html(`<div><p>We're so happy you loved it! 💛 Would you share a quick review on Google? It really helps a small business like ours.</p></div>`); const f2 = html(`<div class="c-ftrow"><a class="c-btn brand block" href="${esc(store.reviewUrl)}" target="_blank" rel="noopener">⭐ Review us on Google</a><button class="c-btn ghost block" data-x>Maybe later</button></div>`); f2.querySelector("[data-x]").onclick = closeSheet; f2.querySelector("a").addEventListener("click", () => setTimeout(closeSheet, 300)); setTimeout(() => openSheet("Thank you!", b, f2, store.name), 400); }
    } catch (e) { body.querySelector("[data-err]").innerHTML = `<div class="c-alert error">${esc(e.message)}</div>`; btn.disabled = false; btn.textContent = "Submit rating"; }
  };
  openSheet("Rate your order", body, foot, `#${o.orderNo}`);
}

// ---------------- INCIDENT REPORT ----------------
const INC_TYPES = { wrong: "Wrong order / item", missing: "Missing item", quality: "Damaged / poor quality", late: "Took too long", hygiene: "Cleanliness", other: "Something else" };
let incUnsub = null;
function openReport(rec, o) {
  const remote = o.serviceType === "pickup" || o.serviceType === "delivery";
  const needProof = remote && store.incidents?.requireProof !== false;
  let type = null;
  const body = html(`<div>
    <p class="desc">${remote ? "A photo is needed as proof. Staff will review it and offer a resolution." : "We'll send the manager to your table to talk it through."}</p>
    <div class="c-pick" data-types>${Object.entries(INC_TYPES).map(([k, l]) => `<button type="button" data-k="${k}"><b>${l}</b></button>`).join("")}</div>
    <label>What happened?</label><textarea data-d rows="3" maxlength="600" placeholder="Describe the problem…"></textarea>
    <label>Photo${needProof ? " (required)" : " (optional)"}</label><input type="file" accept="image/*" capture="environment" data-f/><div class="small muted" data-fs></div>
    <div data-err></div></div>`);
  body.querySelectorAll("[data-k]").forEach((b) => (b.onclick = () => { type = b.dataset.k; body.querySelectorAll("[data-k]").forEach((x) => x.classList.toggle("on", x === b)); }));
  const foot = html(`<div><button class="c-btn brand block" data-send>Submit report</button></div>`);
  foot.querySelector("[data-send]").onclick = async () => {
    const err = body.querySelector("[data-err]"); err.innerHTML = "";
    if (!type) return (err.innerHTML = `<div class="c-alert error">Please choose the type of problem.</div>`);
    const f = body.querySelector("[data-f]").files[0];
    if (needProof && !f) return (err.innerHTML = `<div class="c-alert error">A photo is required as proof.</div>`);
    const btn = foot.querySelector("[data-send]"); btn.disabled = true; btn.textContent = "Sending…";
    try {
      let photoUrl = null;
      if (f) { body.querySelector("[data-fs]").textContent = "Uploading photo…"; photoUrl = await uploadCustomerImage(rec.storeId, auth.currentUser.uid, f, { max: 1200 }); }
      await call("reportIncident", { storeId: rec.storeId, orderId: rec.id, kind: o.code ? "appt" : "order", type, description: body.querySelector("[data-d]").value.trim(), photoUrl });
      closeSheet(); toast("Report sent. Staff will be with you shortly.");
    } catch (e) { err.innerHTML = `<div class="c-alert error">${esc(e.message)}</div>`; btn.disabled = false; btn.textContent = "Submit report"; }
  };
  openSheet("Report a problem", body, foot, `#${o.orderNo}`);
}
function watchIncident(rec, o) {
  incUnsub?.();
  incUnsub = onSnapshot(query(collection(db, "stores", rec.storeId, "incidents"), where("orderId", "==", rec.id), limit(3)), (snap) => {
    const el = app.querySelector("[data-incident]"); if (!el) return;
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    el.innerHTML = list.map((i) => {
      const st = { open: ["Submitted", "Waiting for staff"], in_discussion: ["Manager on the way / in discussion", i.claimedByName ? `Handled by: ${i.claimedByName}` : ""], resolved: ["Resolved", ""], dismissed: ["Dismissed", i.resolution?.note || ""] }[i.status] || [i.status, ""];
      const r = i.resolution;
      return `<div class="c-ticket"><div class="eyebrow">⚠️ Report: ${INC_TYPES[i.type] || esc(i.type)}</div><div><b>${st[0]}</b> <span class="muted small">${esc(st[1])}</span></div>
        ${r && i.status === "resolved" ? `<div class="c-alert ok" style="margin-top:8px">${r.type === "voucher" ? `🎟️ A voucher for you: <b>${esc(r.voucherCode)}</b> (${r.mode === "percent" ? r.amount + "%" : money(r.amount)} off, valid until ${esc(r.voucherValidTo || "")}). Use it on your next order.` : r.type === "refund" ? `💸 Refund ${money(r.amount)} via ${esc(r.method || "")}${r.refNo ? " · ref " + esc(r.refNo) : ""}` : r.type === "remake" ? `🔁 Your order will be replaced / remade.` : `✓ Resolved`}${r.note ? `<div class="small">${esc(r.note)}</div>` : ""}</div>` : ""}
        ${(i.messages || []).length ? `<div class="c-thread" style="margin-top:8px">${i.messages.map((m) => `<div class="msg ${m.from}"><span>${esc(m.text)}</span><small>${m.from === "customer" ? "You" : esc(m.staffName || "Staff")}</small></div>`).join("")}</div>` : ""}
        ${["open", "in_discussion"].includes(i.status) ? `<div class="c-ftrow" style="margin-top:8px"><input data-ireply="${i.id}" placeholder="Reply…" maxlength="300" style="flex:1"/><button class="c-btn sm" data-isend="${i.id}">Send</button></div>` : ""}</div>`;
    }).join("");
    el.querySelectorAll("[data-isend]").forEach((b) => (b.onclick = async () => { const inp = el.querySelector(`[data-ireply="${b.dataset.isend}"]`); const t = inp.value.trim(); if (!t) return; await updateDoc(doc(db, "stores", rec.storeId, "incidents", b.dataset.isend), { messages: arrayUnion({ from: "customer", text: t, at: Date.now() }), updatedAt: serverTimestamp() }).catch((e) => toast(e.message)); inp.value = ""; }));
  }, () => {});
}

// ---------------- sheet ----------------
function openSheet(title, body, foot, subtitle) {
  closeSheet();
  const wrap = html(`<div class="c-sheet-wrap"><div class="c-sheet"><div class="hd"><div><h3>${esc(title)}</h3>${subtitle ? `<div class="muted small">${esc(subtitle)}</div>` : ""}</div><button class="x" aria-label="Close">×</button></div><div class="bd"></div>${foot ? `<div class="ft"></div>` : ""}</div></div>`);
  wrap.querySelector(".bd").appendChild(body);
  if (foot) wrap.querySelector(".ft").appendChild(foot);
  wrap.querySelector(".x").onclick = closeSheet;
  wrap.addEventListener("click", (e) => e.target === wrap && closeSheet());
  document.body.appendChild(wrap);
  document.body.style.overflow = "hidden";
}
function closeSheet() {
  document.querySelector(".c-sheet-wrap")?.remove();
  document.body.style.overflow = "";
}

// ---------------- 🪑 WAITLIST (waitlist QR at the entrance) ----------------
let wlUnsub = null;
function renderWaitlist() {
  const saved = loadLocal().waitlist;
  if (saved?.id && Date.now() - (saved.at || 0) < 6 * 3600e3) return waitlistStatus(saved);
  const c = loadLocal().customer || {};
  app.innerHTML = `<div class="c-page">${infoCard("Waitlist")}${seasonBar()}<div class="c-body"><div class="c-card-soft">
    <h2>🪑 Join the waitlist</h2><p class="muted small">We'll show your place in line here. Keep this page open — it updates by itself.</p>
    <label>Your name</label><input data-n value="${esc(c.name || "")}" maxlength="40"/>
    <label>How many persons?</label><div class="c-pax wide" data-pax>${[1, 2, 3, 4, 5, 6, 8, 10, 12].map((n) => `<button type="button" data-p="${n}">${n}</button>`).join("")}<input type="number" min="1" max="60" data-px placeholder="Other" style="width:90px"/></div>
    <label>Mobile no. (optional)</label><input data-ph type="tel" value="${esc(c.phone || "")}" placeholder="09XX XXX XXXX"/>
    <button class="c-btn brand block" data-go style="margin-top:14px">Join the line</button>
    <button class="c-btn ghost block" data-menu style="margin-top:8px">Just browse the menu</button></div></div></div>`;
  let pax = 0;
  app.querySelectorAll("[data-p]").forEach((b) => (b.onclick = () => { pax = +b.dataset.p; app.querySelector("[data-px]").value = ""; app.querySelectorAll("[data-p]").forEach((x) => x.classList.toggle("on", x === b)); }));
  app.querySelector("[data-px]").oninput = (e) => { pax = parseInt(e.target.value, 10) || 0; app.querySelectorAll("[data-p]").forEach((x) => x.classList.remove("on")); };
  app.querySelector("[data-menu]").onclick = () => { landed = true; renderMenu(); };
  app.querySelector("[data-go]").onclick = async (e) => {
    const name = app.querySelector("[data-n]").value.trim(), phone = app.querySelector("[data-ph]").value.trim();
    if (name.length < 2) return toast("Enter your name");
    if (!pax) return toast("How many persons?");
    e.target.disabled = true; e.target.textContent = "Joining…";
    try {
      const r = await call("joinWaitlist", { slug, tableToken, name, pax, phone });
      const rec = { id: r.id, storeId: r.storeId, at: Date.now() };
      saveLocal({ waitlist: rec, customer: { ...(loadLocal().customer || {}), name, ...(phone ? { phone } : {}) } });
      waitlistStatus(rec);
    } catch (err) { toast(err.message); e.target.disabled = false; e.target.textContent = "Join the line"; }
  };
}
function waitlistStatus(rec) {
  wlUnsub?.();
  app.innerHTML = `<div class="c-status"><div class="c-loading" style="min-height:40vh"><div class="c-spinner"></div></div></div>`;
  let timer = null;
  wlUnsub = onSnapshot(doc(db, "stores", rec.storeId, "waitlist", rec.id), (snap) => {
    if (!snap.exists()) { saveLocal({ waitlist: null }); return renderWaitlist(); }
    const w = snap.data();
    const left = w.holdUntil ? Math.max(0, w.holdUntil - Date.now()) : 0;
    const done = ["seated", "no_show", "left"].includes(w.status);
    app.innerHTML = `<div class="c-page">${infoCard("Waitlist")}${seasonBar()}<div class="c-status"><div class="c-ticket main">
      <div class="eyebrow">${esc(w.name)} · ${w.pax} pax</div>
      ${w.status === "waiting" ? `<div class="eyebrow" style="margin-top:8px">Your place in line</div><div class="c-orderno"><i>#</i>${w.position || "…"}</div><p class="muted">About ${w.estMin || 10} min · we'll call you here</p>`
        : w.status === "called" ? `<div class="c-orderno" style="font-size:2.4rem">🎉 Your table is ready!</div><p>Please come to the counter within <b data-wlhold>${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, "0")}</b>${w.tableLabel ? ` · <b>${esc(w.tableLabel)}</b>` : ""}</p><button class="c-btn brand block" data-seated>✅ We are seated now</button>`
        : w.status === "seated" ? `<div class="c-orderno" style="font-size:2.2rem">✅ Seated</div><p class="muted">Enjoy! Scan the QR on your table to order.</p>`
        : `<div class="c-cancel">${w.status === "no_show" ? "Your spot was released" : "You left the line"}</div><p class="muted">You can join again anytime.</p>`}
      </div>
      ${!done ? `<button class="c-btn ghost block" data-menu>📋 Look at the menu while waiting</button><button class="c-btn ghost block" data-leave style="margin-top:8px">Leave the line</button>` : `<button class="c-btn brand block" data-again>Join again</button>`}
    </div></div>`;
    app.querySelector("[data-seated]")?.addEventListener("click", () => updateDoc(snap.ref, { status: "seated", seatedBy: "customer", seatedAt: Date.now(), updatedAt: serverTimestamp() }).catch((e) => toast(e.message)));
    app.querySelector("[data-leave]")?.addEventListener("click", () => { if (confirm("Leave the waitlist?")) updateDoc(snap.ref, { status: "left", updatedAt: serverTimestamp() }).catch((e) => toast(e.message)); });
    app.querySelector("[data-menu]")?.addEventListener("click", () => { landed = true; renderMenu(); });
    app.querySelector("[data-again]")?.addEventListener("click", () => { saveLocal({ waitlist: null }); wlUnsub?.(); renderWaitlist(); });
    clearInterval(timer);
    if (w.status === "called" && w.holdUntil) timer = setInterval(() => { const el = app.querySelector("[data-wlhold]"); if (!el) return clearInterval(timer); const l = Math.max(0, w.holdUntil - Date.now()); el.textContent = `${Math.floor(l / 60000)}:${String(Math.floor((l % 60000) / 1000)).padStart(2, "0")}`; }, 1000);
  }, () => { saveLocal({ waitlist: null }); renderWaitlist(); });
}
