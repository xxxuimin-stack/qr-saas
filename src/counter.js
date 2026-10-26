// Counter / POS screen: /counter/ — crew at manager. Walk-in orders, mark paid, bills per table, requests, shift.
import { pinLinks } from "./addrpin.js";
import { msgrBtn } from "./msgr.js";
import { applyWording } from "./wording.js";
import { orderOp, payMethods } from "./orderops.js";
import { setShell } from "./appshell.js";
import { openStatus } from "./hours.js";
const isOpenNow = (hours) => !hours || !Object.keys(hours).length || openStatus(hours).open;
import { overtimeFor } from "./promo.js";
import { auth, db, call } from "./firebase.js";
import { deviceSignIn, showDeviceSetup, ownerOnStaffBanner } from "./device.js";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { collection, doc, onSnapshot, query, orderBy, limit, updateDoc, serverTimestamp, writeBatch, addDoc, where, increment, getDocs } from "firebase/firestore";
import { FLOW } from "./pages/orders.js";
import { printReceipt, printKitchenTicket, printCfg } from "./print.js";
import { bootLaundry, laundryStoreUpdated, laundryShiftUpdated } from "./laundry.js";
import { bootSalon, salonStoreUpdated, salonShiftUpdated } from "./salon.js";
import { startDuty, watchDuty, dutyBoardHTML, watchFeatures, feat, pinGate, getActiveStaff, clearActiveStaff, roleLabel, tapToStart, chime, startRinging, stopRinging } from "./staffauth.js";
import { closeShiftForm, verifyShiftPanel, mountStaffNotes, watchRequests, renderRequests, watchOpenShift, startShift, computeShiftTally, endShift, tallyHTML, orderTagsHTML, watchIncidents, renderIncidents } from "./staffpanels.js";
import { watchMaintenance } from "./maint.js";
watchMaintenance("staff");

const app = document.getElementById("app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const html = (str) => { const t = document.createElement("template"); t.innerHTML = str.trim(); return t.content.firstElementChild; };
let CUR = "PHP";
const money = (n) => (CUR === "PHP" ? "₱" : CUR + " ") + Number(n || 0).toLocaleString("en-PH", { maximumFractionDigits: 2 });
const SVC = { dine_in: "🍽️ Dine-in", take_out: "🥡 Take-out", pickup: "🛍️ Pickup", delivery: "🛵 Delivery" };

let dutyList = null, waitlist = [];
let storeId, store, flow, me, orders = [], items = [], cats = [], tables = [], requests = [], openReq = 0, incidents = [], openInc = 0, openShift = null, tab = "orders", seen = null, sessions = [], resvToday = [];
const isManager = () => (me?.roles || []).includes("manager");
// Counter = the hub (café/restaurant): every new order rings here until a crew member accepts it with a prep time.
// Kitchen / barista only see an order after it is accepted.
const hub = () => store?.mode === "table";
const fireMs = () => (Number(store?.settings?.service?.fireBeforeMin) || 30) * 60000;
const isLater = (o) => !!o.scheduledAt && o.scheduledAt.toMillis() - Date.now() > fireMs();
const needsAccept = (o) => hub() && o.status === "pending" && !o.acceptedAt;
let ringVol = Number(localStorage.getItem("orderqr:cvol") || 0.6);
function updateRing() {
  if (!hub()) return;
  if (orders.some(needsAccept) || orders.some((o) => o.addAlert)) startRinging(ringVol); else stopRinging();
}
const fmtT = (d) => d.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" });
const kst = () => { const k = store?.settings?.kitchen || {}; return store?.settings?.acceptOrders === false ? "paused" : k.status === "busy" ? "busy" : "normal"; };
const busyExtra = () => (kst() === "busy" || kst() === "paused") ? Number(store?.settings?.kitchen?.busyExtra) || 0 : 0;
const prepDefault = () => Number(store?.settings?.service?.prepDefault) || 15;
const busyPrep = () => Number(store?.settings?.service?.busyPrep) || 35;
/** pick the prep time (10 / 15 / 20, +5 per tap; busy adds its extra); later-scheduled orders are accepted for their time instead */
const payFirstHold = (o) => !!(store.settings?.service?.payFirst || o.payFirst) && ["dine_in", "take_out"].includes(o.serviceType) && !o.paid && !o.parentPaidFirst;
function acceptPicker(o, extra = {}) {
  if (payFirstHold(o)) { if (confirm(`Pay first is on.\n\nOrder #${o.orderNo} (${money(o.total)}) isn't paid yet. Collect the payment now?`)) askMethod([o]); return; }
  const later = isLater(o);
  const busy = kst() === "busy";
  let base = busy ? busyPrep() : prepDefault();
  const el = html(`<div><p class="muted">Order <b style="color:var(--ink)">#${o.orderNo}</b> · ${(o.items || []).map((l) => `${l.qty}× ${esc(l.name)}`).join(", ")}</p>
    ${later ? `<p>Scheduled for <b>${o.scheduledAt.toDate().toLocaleString("en-PH", { weekday: "short", hour: "numeric", minute: "2-digit" })}</b>. It goes to the kitchen ${store.settings?.service?.fireBeforeMin || 30} min before.</p><button class="k-btn primary" data-later style="width:100%">✓ Accept scheduled order</button>`
      : `<p class="muted small">Prep time — the customer sees this.${busy ? ` <b style="color:var(--new)">Store is Busy — standard ${busyPrep()} min.</b>` : ""}</p>
      <div class="k-etas">${[...new Set([10, 15, 20, ...(busy ? [busyPrep()] : [])])].map((m) => `<button data-b="${m}">${m}<br><small>min</small></button>`).join("")}<button data-plus>+5<br><small>min</small></button></div>
      <button class="k-btn primary" data-ok style="width:100%;margin-top:12px;font-size:1.15rem;padding:16px"></button>`}</div>`);
  const go = (patch) => { updateDoc(doc(db, "stores", storeId, "orders", o.id), { ...extra, ...patch, acceptedAt: serverTimestamp(), acceptedBy: me?.name || null, staffId: me?.staffId || null, updatedAt: serverTimestamp() }).catch((e) => alert(e.message)); closeDrawer(); };
  const paint = () => { const ok = el.querySelector("[data-ok]"); if (!ok) return; ok.innerHTML = `✓ Accept · ${base} min`; el.querySelectorAll("[data-b]").forEach((b) => b.classList.toggle("on", Number(b.dataset.b) === base)); };
  el.querySelector("[data-later]")?.addEventListener("click", () => go({ status: "pending" }));
  el.querySelectorAll("[data-b]").forEach((b) => (b.onclick = () => { base = Number(b.dataset.b); paint(); }));
  el.querySelector("[data-plus]")?.addEventListener("click", () => { base = Math.min(240, base + 5); paint(); });
  el.querySelector("[data-ok]")?.addEventListener("click", () => go({ status: "preparing", etaMinutes: base, busyExtra: busy ? Math.max(0, busyPrep() - prepDefault()) : 0 }));
  paint();
  openDrawer(later ? "Accept order" : "Accept — set prep time", el);
}
async function setStatus(status, extraMin) {
  try { const r = await call("setKitchenStatus", { status, extra: extraMin, staffName: me?.name }); if (r.changed) toastMsg(`${r.changed} ticket${r.changed > 1 ? "s" : ""} ${status === "busy" ? `+${r.extra} min (Busy)` : status === "normal" ? "back to normal time" : "updated"}`); }
  catch (e) { alert(e.message); }
}
function toastMsg(t) { const n = html(`<div class="c-toast">${esc(t)}</div>`); document.body.appendChild(n); setTimeout(() => n.remove(), 2600); }
function statusPicker() {
  const cur = kst();
  const el = html(`<div>
    <button class="k-btn ${cur === "normal" ? "primary" : ""}" data-s="normal" style="width:100%;margin-bottom:8px">🟢 Normal <small>— standard prep ${prepDefault()} min</small></button>
    <button class="k-btn ${cur === "busy" ? "primary" : ""}" data-s="busy" style="width:100%;margin-bottom:8px">🟠 Busy <small>— standard prep ${busyPrep()} min · customers see it on the menu</small></button>
    <button class="k-btn ${cur === "paused" ? "danger" : ""}" data-s="paused" style="width:100%">⏸ Paused <small>— customers can't place new orders</small></button>
    <p class="muted small" style="margin-top:12px">Switching to Busy adds ${Math.max(0, busyPrep() - prepDefault())} min to tickets still being made; back to Normal removes it. Change the times in Settings → Service.</p></div>`);
  el.querySelectorAll("[data-s]").forEach((b) => (b.onclick = () => { closeDrawer(); setStatus(b.dataset.s); }));
  openDrawer("Store status", el);
}
function addTime(o) {
  const el = html(`<div><p class="muted">Order <b style="color:var(--ink)">#${o.orderNo}</b> · now ${o.etaMinutes} min</p><div class="k-etas">${[10, 15, 20].map((m) => `<button data-a="${m}">+${m}<br><small>min</small></button>`).join("")}</div></div>`);
  el.querySelectorAll("[data-a]").forEach((b) => (b.onclick = () => { updateDoc(doc(db, "stores", storeId, "orders", o.id), { etaMinutes: (o.etaMinutes || 0) + Number(b.dataset.a), staffId: me?.staffId || null, updatedAt: serverTimestamp() }).catch((e) => alert(e.message)); closeDrawer(); }));
  openDrawer("Add time", el);
}

onAuthStateChanged(auth, async (user) => {
  if (!user || user.isAnonymous) { if (await deviceSignIn()) return; return showDeviceSetup("/counter/"); }
  const claims = (await user.getIdTokenResult(true)).claims;
  if (!claims.storeId) return location.replace("/app/");
  if (claims.role === "owner") ownerOnStaffBanner();
  storeId = claims.storeId;
  setTimeout(() => { drawOfflineBar(); flushOffline(); }, 2500);
  onSnapshot(doc(db, "stores", storeId), async (s) => {
    const first = !store;
    store = { id: storeId, ...s.data() }; applyWording(store); setShell({ app: store.mode === "salon" ? "Reception" : store.mode === "stay" ? "Front desk" : "Counter", icon: "", mode: store.mode });
    CUR = store.settings?.currency || "PHP";
    flow = FLOW[store.mode] || FLOW.table;
    if (store.mode === "laundry") flow = [["received", "Received"], ["washing", "Washing"], ["ready", "Ready"], ["claimed", "Claimed"]];
    if (store.mode === "salon") flow = [["pending", "Requested"], ["confirmed", "Confirmed"], ["in_progress", "In progress"], ["done", "Done"]];
    if (first) {
      // re-draw the header when plan features change — each store type has its own header
      watchFeatures(store.slug, () => { if (!document.getElementById("head") || !me) return; if (store.mode === "salon") salonStoreUpdated(store); else if (store.mode === "laundry") laundryStoreUpdated(store); else if (store.mode !== "stay") drawHead(); });
      await tapToStart("Tap to open Counter");
      me = getActiveStaff(storeId) || (await pinGate({ storeId, storeName: store.name, requireRoles: ["crew"], screenName: store.mode === "stay" ? "Caretaker" : "Counter / POS" }));
      boot();
    } else if (store.mode === "stay") window.__stayDesk?.stayDeskStore(store);
    else if (store.mode === "laundry") laundryStoreUpdated(store); else if (store.mode === "salon") salonStoreUpdated(store); else drawHead();
  });
});

function boot() {
  if (store.mode === "stay") {
    import("./staydesk.js").then((m) => {
      const sctx = { app, storeId, store, me, switchUser: async () => { clearActiveStaff(storeId); me = await pinGate({ storeId, storeName: store.name, requireRoles: ["crew"], screenName: "Caretaker" }); sctx.me = me; m.stayDeskStore(store); } };
      m.bootStayDesk(sctx); window.__stayDesk = m;
    });
    mountStaffNotes(storeId);
    return;
  }
  if (store.mode === "salon") {
    const sctx = { app, storeId, store, me, openDrawer, closeDrawer, askMethod, openShift: null, openShiftPanel: () => openShiftPanel(), switchUser: async () => { clearActiveStaff(storeId); me = await pinGate({ storeId, storeName: store.name, requireRoles: ["crew"], screenName: "Counter / Reception" }); sctx.me = me; salonStoreUpdated(store); } };
    bootSalon(sctx);
    let shiftHash = location.hash === "#shift";
    watchOpenShift(storeId, (sh) => { openShift = sh; salonShiftUpdated(sh); if (shiftHash) { shiftHash = false; setTimeout(() => openShiftPanel(), 300); } });
    if (location.hash === "#new") setTimeout(() => document.querySelector('[data-tab="walkin"]')?.click(), 300);
    mountStaffNotes(storeId);
    onSnapshot(query(collection(db, "stores", storeId, "staff"), orderBy("name")), (snap) => { staffList = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((x) => x.active !== false); });
    if (store.settings?.incidents?.enabled !== false) watchIncidents(storeId, { sound: true, onChange: (rows, n) => { incidents = rows; openInc = n; } });
    return;
  }
  if (store.mode === "laundry") {
    const lctx = { app, storeId, store, me, openDrawer, closeDrawer, askMethod, openShift: null, openShiftPanel: () => openShiftPanel(), switchUser: async () => { clearActiveStaff(storeId); me = await pinGate({ storeId, storeName: store.name, requireRoles: ["crew"], screenName: "Counter / POS" }); lctx.me = me; laundryStoreUpdated(store); } };
    bootLaundry(lctx);
    watchOpenShift(storeId, (sh) => { openShift = sh; laundryShiftUpdated(sh); });
    mountStaffNotes(storeId);
    onSnapshot(query(collection(db, "stores", storeId, "staff"), orderBy("name")), (snap) => { staffList = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((x) => x.active !== false); });
    if (store.settings?.incidents?.enabled !== false) watchIncidents(storeId, { sound: true, onChange: (rows, n) => { incidents = rows; openInc = n; } });
    return;
  }
  app.innerHTML = `<div><div id="head"></div><div id="main" class="c-main"></div></div>`;
  onSnapshot(query(collection(db, "stores", storeId, "orders"), orderBy("createdAt", "desc"), limit(200)), (snap) => {
    orders = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const fresh = orders.filter((o) => o.status === flow[0][0]).map((o) => o.id);
    if (hub()) { updateRing(); if (seen && orders.some((o) => o.status === "unconfirmed" && !seen.has(o.id))) chime(ringVol); }
    else if (seen && fresh.some((id) => !seen.has(id))) chime(0.25);
    seen = new Set(orders.map((o) => o.id));
    drawHead(); if (["orders", "tables"].includes(tab)) draw();
  });
  onSnapshot(query(collection(db, "stores", storeId, "items"), orderBy("sortOrder")), (snap) => { items = snap.docs.map((d) => ({ id: d.id, ...d.data() })); if (tab === "new") draw(); });
  onSnapshot(query(collection(db, "stores", storeId, "categories"), orderBy("sortOrder")), (snap) => { cats = snap.docs.map((d) => ({ id: d.id, ...d.data() })); if (tab === "new") draw(); });
  onSnapshot(query(collection(db, "stores", storeId, "tables"), orderBy("sortOrder")), (snap) => { tables = snap.docs.map((d) => ({ id: d.id, ...d.data() })); });
  watchOpenShift(storeId, (sh) => { openShift = sh; drawHead(); });
  mountStaffNotes(storeId);
  onSnapshot(query(collection(db, "stores", storeId, "staff"), orderBy("name")), (snap) => { staffList = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((x) => x.active !== false); });
  if (store.settings?.vip?.enabled) {
    onSnapshot(query(collection(db, "stores", storeId, "sessions"), orderBy("createdAt", "desc"), limit(50)), (snap) => { sessions = snap.docs.map((d) => ({ id: d.id, ...d.data() })); drawHead(); if (tab === "vip") draw(); });
    onSnapshot(query(collection(db, "stores", storeId, "reservations"), orderBy("scheduledAt", "asc"), limit(100)), (snap) => { resvToday = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((r) => r.kind === "vip" && ["pending", "confirmed"].includes(r.status)); if (tab === "vip") draw(); });
  }
  onSnapshot(query(collection(db, "stores", storeId, "waitlist"), orderBy("createdMs", "desc"), limit(60)), (snap) => {
    const before = new Set(waitlist.map((w) => w.id));
    waitlist = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (before.size && waitlist.some((w) => !before.has(w.id) && w.status === "waiting")) chime(0.35);
    drawHead(); if (tab === "waitlist") draw();
  }, () => {});
  if (feat("duty")) { startDuty(storeId, me, "counter"); watchDuty(storeId, (l) => { dutyList = l; drawHead(); if (tab === "requests") draw(); }); }
  if (store.settings?.callStaff?.enabled) watchRequests(storeId, { sound: true, me, onChange: (rows, n) => { requests = rows; openReq = n; drawHead(); if (tab === "requests") draw(); } });
  if (store.settings?.incidents?.enabled !== false) watchIncidents(storeId, { sound: true, onChange: (rows, n) => { incidents = rows; openInc = n; drawHead(); if (tab === "incidents") draw(); } });
  // links from the owner's dashboard: /counter/#new (new order) and /counter/#shift (count cash)
  if (location.hash === "#new") tab = "new";
  drawHead(); draw();
  if (location.hash === "#shift") setTimeout(() => openShiftPanel(), 600);
  setInterval(() => { if (tab === "orders" && !document.querySelector(".k-drawer-wrap")) { drawHead(); draw(); } }, 30000);
}

// ---------------- header / tabs ----------------
function drawHead() {
  const head = document.getElementById("head"); if (!head) return;
  const active = orders.filter((o) => flow.slice(0, -1).map((f) => f[0]).includes(o.status));
  const unpaid = orders.filter((o) => !o.paid && o.status !== "cancelled" && o.status !== flow[flow.length - 1][0]);
  const tabs = [["orders", `Orders <span class="k-tag">${active.length}</span>`], ["new", "➕ New order"], ...(store.settings?.setup?.kind === "home" ? [] : [["tables", `Tables${unpaid.length ? ` <span class="k-badge">${unpaid.length}</span>` : ""}`]])];
  if (store.settings?.vip?.enabled && feat("events_vip")) tabs.push(["vip", `🎤 VIP rooms${sessions.filter((x) => x.status === "open").length ? ` <span class="k-tag">${sessions.filter((x) => x.status === "open").length} open</span>` : ""}`]);
  if (store.settings?.callStaff?.enabled && feat("callstaff")) tabs.push(["requests", `🔔 Requests${openReq ? ` <span class="k-badge">${openReq}</span>` : ""}`]);
  if (feat("waitlist") && tables.some((t) => t.isWaitlist)) { const n = waitlist.filter((w) => ["waiting", "called"].includes(w.status)).length; tabs.push(["waitlist", `🪑 Waitlist${n ? ` <span class="k-badge">${n}</span>` : ""}`]); }
  if (store.settings?.incidents?.enabled !== false && feat("feedback")) tabs.push(["incidents", `⚠️ Incidents${openInc ? ` <span class="k-badge">${openInc}</span>` : ""}`]);
  const waiting = orders.filter(needsAccept).length;
  const inProg = hub() ? orders.filter((o) => (o.status === "preparing" || needsAccept(o))).length : 0;
  const remindAt = Number(store.settings?.service?.busyRemind ?? 8);
  const remind = hub() && remindAt > 0 && kst() === "normal" && inProg >= remindAt;
  const closedNow = !isOpenNow(store.hours);
  const lateOn = Number(store.settings?.lateUntil) > Date.now();
  const lateBar = (closedNow || lateOn) && hub() ? `<div class="c-latebar">${lateOn ? `🌙 <b>LATE ORDERS ON</b> until ${fmtT(new Date(store.settings.lateUntil))} <button class="k-btn sm" data-late="0">Stop late orders</button>` : `🌙 We're past closing time — online orders are closed. <button class="k-btn sm" data-late="1">Accept late orders</button>`}</div>` : "";
  const autoBar = store.settings?.kitchen?.auto && kst() === "paused" ? `<div class="c-autobar">⏸ <b>AUTO-PAUSED</b> — an order waited too long without being accepted, so new online orders are on hold. Accept the waiting order, then tap <b>🟢 Normal</b> to reopen.</div>` : "";
  const needBarista = cats.some((c) => c.station === "barista") || items.some((i) => i.station === "barista");
  const dutyBar = feat("duty") && dutyList ? dutyBoardHTML(dutyList, { needBarista, needRider: !!store.settings?.service?.delivery && feat("delivery") }) : "";
  head.innerHTML = `${autoBar}${lateBar}${waiting ? `<div class="c-ringbar" id="ringBar">🔔 ${waiting} new order${waiting > 1 ? "s" : ""} — tap to accept and set the prep time. Ringing until accepted.</div>` : ""}${remind ? `<div class="c-remind" id="busyRemind">🔥 ${inProg} orders in progress — switch to <b>Busy</b> (${busyPrep()} min)? <button class="k-btn sm" data-gobusy>Set Busy</button></div>` : ""}<header class="k-head">
    ${store.logoUrl ? `<img src="${esc(store.logoUrl)}" alt="" style="width:34px;height:34px;border-radius:8px;object-fit:cover"/>` : ""}<span class="name">${esc(store.name)}</span>
    <span class="k-stations">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${tab === k ? "on" : ""}">${l}</button>`).join("")}</span>
    <span class="sp"></span>
    ${feat("shifts") ? `<button class="k-btn sm ${openShift ? "" : "danger"}" id="shiftBtn">${openShift ? (openShift.status === "needs_count" ? "🌙 Count cash" : openShift.status !== "open" ? "⚠️ Shift check" : "📊 Shift") : "▶ Start shift"}</button>` : ""}
    ${hub() ? `<button class="k-btn sm k-status ${kst()}" id="stBtn">${kst() === "busy" ? `🟠 Busy · ${busyPrep()}m` : kst() === "paused" ? "⏸ Paused" : "🟢 Normal"}</button><button class="k-btn sm" id="volBtn" title="Ringtone volume">🔔</button>` : ""}
    ${isManager() && store.mode === "table" ? `<button class="k-btn sm" id="toolsBtn">🧰 Menu</button>` : ""}
    <button class="k-btn sm" id="userBtn">👤 ${esc(me?.name || "")} <span class="k-tag">${esc(roleLabel(me?.roles?.[0] || ""))}</span></button>
  </header>${dutyBar}`;
  head.querySelector("#ringBar")?.addEventListener("click", () => { tab = "orders"; drawHead(); draw(); const first = orders.filter(needsAccept).sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0))[0]; if (first) acceptPicker(first); });
  head.querySelector("#stBtn")?.addEventListener("click", statusPicker);
  head.querySelector("#toolsBtn")?.addEventListener("click", () => menuTools());
  head.querySelector("[data-late]")?.addEventListener("click", async (e) => { const on = e.target.dataset.late === "1"; try { await call("setLateMode", { on, staffToken: me?.token || null }); } catch (err) { alert(err.message); } });
  head.querySelector("[data-gobusy]")?.addEventListener("click", () => setStatus("busy"));
  head.querySelector("#volBtn")?.addEventListener("click", () => {
    const el = html(`<div><p class="muted small">New orders ring here non-stop until someone accepts them. Keep this screen open and the volume up.</p><label>Volume</label><input type="range" min="0.1" max="1" step="0.05" value="${ringVol}" data-v style="width:100%"/><button class="k-btn" data-test style="margin-top:12px">🔔 Test</button></div>`);
    el.querySelector("[data-v]").oninput = (e) => { ringVol = Number(e.target.value); try { localStorage.setItem("orderqr:cvol", String(ringVol)); } catch {} if (orders.some(needsAccept)) { stopRinging(); startRinging(ringVol); } };
    el.querySelector("[data-test]").onclick = () => chime(ringVol);
    openDrawer("Ringtone", el);
  });
  head.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => { tab = b.dataset.tab; drawHead(); draw(); }));
  head.querySelector("#shiftBtn")?.addEventListener("click", openShiftPanel);
  head.querySelector("#userBtn").onclick = async () => { clearActiveStaff(storeId); me = await pinGate({ storeId, storeName: store.name, requireRoles: ["crew"], screenName: "Counter / POS" }); drawHead(); };
}

function draw() {
  const main = document.getElementById("main"); if (!main) return;
  main.innerHTML = "";
  if (tab === "orders") drawOrders(main);
  if (tab === "new") drawNewOrder(main);
  if (tab === "tables") drawTables(main);
  if (tab === "vip") drawVip(main);
  if (tab === "waitlist") return drawWaitlist(main);
  if (tab === "requests") renderRequests(main, { storeId, me, rows: requests, isManager: isManager(), currency: CUR, duty: feat("duty") ? dutyList : null });
  if (tab === "incidents") { const inc = store.settings?.incidents || {}; const canResolve = isManager() || inc.who === "crew"; renderIncidents(main, { storeId, me, rows: incidents, canResolve, maxVoucher: isManager() ? 0 : (inc.maxVoucherCrew || 0), currency: CUR }); }
}

// ---------------- ORDERS ----------------
function drawOrders(main) {
  const doneKey = flow[flow.length - 1][0];
  const byTime = (a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0);
  const fresh = orders.filter(needsAccept).sort(byTime);
  const active = orders.filter((o) => !needsAccept(o) && o.status !== "cancelled" && o.status !== doneKey && o.status !== "delivered" && o.status !== "unconfirmed").sort(byTime);
  const unconfirmed = orders.filter((o) => o.status === "unconfirmed");
  const wrap = html(`<div>${fresh.length ? `<h3 style="margin:0 0 8px;color:var(--new)">🔔 New — accept to send to the kitchen (${fresh.length})</h3><div class="c-grid" data-new style="margin-bottom:16px"></div>` : ""}${unconfirmed.length ? `<h3 style="margin:0 0 8px;color:var(--new)">⏳ Awaiting confirmation (${unconfirmed.length})</h3><div class="c-grid" data-unc style="margin-bottom:16px"></div>` : ""}<div class="c-toolbar"><input class="k-input" data-q placeholder="Search order # / table / name" style="max-width:320px"/><span class="muted small">${active.length} active</span></div><div class="c-grid" data-list></div>
    <details style="margin-top:16px"><summary class="muted" style="cursor:pointer">Completed today</summary><div class="c-grid" data-done style="margin-top:10px;opacity:.7"></div></details></div>`);
  const list = wrap.querySelector("[data-list]"), done = wrap.querySelector("[data-done]");
  const render = (q = "") => {
    const f = (o) => !q || String(o.orderNo).includes(q) || (o.tableLabel || "").toLowerCase().includes(q) || (o.customer?.name || "").toLowerCase().includes(q);
    list.innerHTML = ""; done.innerHTML = "";
    active.filter(f).forEach((o) => list.appendChild(orderCard(o)));
    if (!list.children.length) list.innerHTML = `<div class="k-empty">No active orders.</div>`;
    orders.filter((o) => o.status === doneKey && f(o)).slice(0, 30).forEach((o) => done.appendChild(orderCard(o, true)));
  };
  wrap.querySelector("[data-q]").oninput = (e) => render(e.target.value.toLowerCase());
  render();
  unconfirmed.forEach((o) => wrap.querySelector("[data-unc]").appendChild(orderCard(o)));
  fresh.forEach((o) => wrap.querySelector("[data-new]").appendChild(orderCard(o)));
  main.appendChild(wrap);
}

function orderCard(o, compact = false) {
  const idx = flow.findIndex((f) => f[0] === o.status);
  const next = flow[idx + 1];
  const t = o.createdAt?.toDate?.();
  const el = html(`<article class="k-card st-${esc(o.status)}" style="border-top-color:${o.status === flow[0][0] ? "var(--new)" : o.status === "ready" ? "var(--ready)" : "var(--prep)"}">
    <div class="top"><div><div class="no">#${o.orderNo}${o.test ? ` <span class="k-tag test">TEST</span>` : ""}${o.paid ? ` <span class="k-tag paid">Paid · ${esc(o.paymentMethodName || o.paymentMethod || "")}</span>` : ` <span class="k-tag" style="color:var(--new)">Unpaid</span>`}</div>
      <div class="where">${o.tableLabel ? esc(o.tableLabel) + " · " : ""}${SVC[o.serviceType] || ""}${o.customer?.name ? " · " + esc(o.customer.name) : ""}${o.customer?.messenger ? " " + msgrBtn(o.customer.messenger, "k-tag", "💬") : ""}</div></div>
      <div class="time">${t ? t.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" }) : ""}<span class="eta">${o.status === "out_for_delivery" ? "🛵 " + esc(o.riderName || "Out") : esc(flow[idx]?.[1] || o.status)}</span>${o.scheduledAt ? `<span class="eta">⏰ ${o.scheduledAt.toDate().toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}</span>` : ""}</div></div>
    ${orderTagsHTML(o, CUR)}
    ${o.customer?.address ? `<div class="small muted">📍 ${esc(o.customer.address)}${o.customer.landmark ? ` · ${esc(o.customer.landmark)}` : ""} ${pinLinks(o.customer, "k-tag")}</div>` : ""}
    <ul>${o.items.map((l) => `<li><span class="q">${l.qty}×</span><span>${esc(l.name)}${l.choices?.length ? `<span class="opt">${l.choices.map((c) => esc(c.label)).join(", ")}</span>` : ""}</span></li>`).join("")}</ul>
    <div class="top"><b style="font-size:1.2rem">${money(o.total)}</b></div>
    <div class="acts"></div></article>`);
  if (compact) return el;
  const acts = el.querySelector(".acts");
  const set = (patch) => updateDoc(doc(db, "stores", storeId, "orders", o.id), { ...patch, staffId: me?.staffId || null, updatedAt: serverTimestamp() }).catch((e) => alert(e.message));
  if (o.addAlert) {
    const al = html(`<div class="k-addalert"><span>➕ NEW ADD-ON ORDER${o.addAlert.count > 1 ? ` (${o.addAlert.count})` : ""} for this ${o.tableLabel ? "table" : "order"}</span><button type="button">👍 OK, seen</button></div>`);
    al.querySelector("button").onclick = () => orderOp(storeId, "ackAdd", { orderId: o.id }).catch((e) => alert(e.message));
    acts.appendChild(al);
  }
  if (o.status === "unconfirmed") {
    const dl = o.confirmDeadline?.toMillis?.();
    if (dl) { const left = Math.max(0, dl - Date.now()); acts.appendChild(html(`<span class="small" style="flex-basis:100%;color:var(--new)">💬 Waiting for the customer's Messenger message · auto-cancels in ${Math.floor(left / 60000)} min${o.customer?.phone ? ` · ${esc(o.customer.phone)}` : ""}</span>`)); }
    const b = html(`<button class="k-btn primary">✅ Confirmed — ${hub() ? "accept" : "send to kitchen"}</button>`); b.onclick = () => hub() ? acceptPicker(o, { confirmedAt: serverTimestamp(), confirmedBy: me?.name || null }) : set({ status: store.mode === "pickup" ? "received" : "pending", confirmedAt: serverTimestamp(), confirmedBy: me?.name || null }); acts.appendChild(b);
    const x = html(`<button class="k-btn danger">✕ Bogus / no reply</button>`); x.onclick = () => { if (confirm("Cancel and flag this customer? This phone number will no longer be able to order.")) orderOp(storeId, "cancel", { orderId: o.id, reason: "Not confirmed", flag: true }).catch((e) => alert(e.message)); }; acts.appendChild(x);
    return el;
  }
  if (needsAccept(o)) {
    el.style.borderTopColor = "var(--new)"; el.classList.add("c-ringing");
    const b = html(`<button class="k-btn primary" style="flex-basis:100%">${payFirstHold(o) ? `💵 Collect ${money(o.total)} first` : `🔔 ${isLater(o) ? "Accept scheduled order" : "Accept — set prep time"}`}</button>`); b.onclick = () => acceptPicker(o); acts.appendChild(b);
  } else if (hub() && o.status === "pending" && o.acceptedAt) acts.appendChild(html(`<span class="small muted" style="flex-basis:100%">✓ Accepted by ${esc(o.acceptedBy || "")} · goes to the kitchen ${o.scheduledAt ? fmtT(new Date(o.scheduledAt.toMillis() - fireMs())) : "soon"}</span>`));
  else if (hub() && o.status === "preparing" && o.etaMinutes && o.acceptedAt?.toDate) {
    acts.appendChild(html(`<span class="small muted" style="flex-basis:100%">⏱ ${o.etaMinutes} min${o.busyExtra ? ` (incl. +${o.busyExtra} busy)` : ""} · due ${fmtT(new Date(o.acceptedAt.toDate().getTime() + o.etaMinutes * 60000))}${o.acceptedBy ? ` · accepted by ${esc(o.acceptedBy)}` : ""}</span>`));
    const at = html(`<button class="k-btn sm">⏱ +time</button>`); at.onclick = () => addTime(o); acts.appendChild(at);
  }
  if (!o.paid && o.payment && o.payment.method !== "cash" && o.payment.method !== "card") {
    // One-tap GCash: the customer tapped "I've sent" (or will pay at the counter) → check your GCash, then Received / Not received
    const p = o.payment, st = p.status;
    const info = st === "not_received" ? `❗ Marked not received${p.checkedBy ? ` by ${esc(p.checkedBy)}` : ""} — waiting for the customer` : st === "at_counter" ? `📱 Will pay with ${esc(p.methodName)} at the counter` : st === "on_arrival" ? `📱 Will send ${esc(p.methodName)} when the rider arrives — the rider confirms` : `📱 Customer sent ${esc(p.methodName)} ${money(o.total)}${p.refNo ? ` · ref ${esc(p.refNo)}` : ""}${p.resent ? " · sent again" : ""} — check your ${esc(p.methodName)}`;
    acts.appendChild(html(`<span class="c-payinfo ${st === "not_received" ? "bad" : ""}">${info}</span>`));
    const ok = html(`<button class="k-btn ready">✓ Received</button>`); ok.onclick = () => { if (confirm(`${p.methodName} ${money(o.total)} is in your account?`)) orderOp(storeId, "verify", { orderId: o.id }).catch((e) => alert(e.message)); }; acts.appendChild(ok);
    if (!["not_received", "at_counter", "on_arrival"].includes(st)) { const no = html(`<button class="k-btn danger">✗ Not received</button>`); no.onclick = () => { const note = prompt(`Not in your ${p.methodName} yet? The customer will be asked to check and send again or pay cash.\n\nNote (optional):`, ""); if (note === null) return; orderOp(storeId, "notReceived", { orderId: o.id, note }).catch((e) => alert(e.message)); }; acts.appendChild(no); }
    if (st === "at_counter") { const c = html(`<button class="k-btn">💵 Paid cash instead</button>`); c.onclick = () => askMethod([o]); acts.appendChild(c); }
  }
  else if (!o.paid) { const b = html(`<button class="k-btn primary">💵 Mark paid</button>`); b.onclick = () => askMethod([o]); acts.appendChild(b); }
  if (printCfg(store).enabled) { const pr = html(`<button class="k-btn">🖨 Receipt</button>`); pr.onclick = () => printReceipt(store, o, { cur: CUR, staffName: me?.name }); acts.appendChild(pr); }
  if (printCfg(store).enabled && printCfg(store).kitchenTicket) { const kt = html(`<button class="k-btn">🎫 Kitchen ticket</button>`); kt.onclick = () => printKitchenTicket(store, o); acts.appendChild(kt); }
  if (o.serviceType === "delivery" && !o.freeDelivery && !o.parentId && (o.deliveryFeePending || (store.settings?.service?.deliveryFeeMode === "counter" && !["out_for_delivery", "delivered", "cancelled"].includes(o.status)))) {
    const b = html(`<button class="k-btn">🛵 ${o.deliveryFeePending ? "Set delivery fee" : `Delivery fee ${money(o.deliveryFee || 0)} ✎`}</button>`);
    b.onclick = () => { const v = prompt(`Delivery fee for:\n${o.customer?.address || ""}\n\nEnter amount (₱):`, o.deliveryFee || ""); if (v == null || v === "") return; orderOp(storeId, "deliveryFee", { orderId: o.id, fee: Math.max(0, Number(v) || 0) }).catch((e) => alert(e.message)); };
    acts.appendChild(b);
  }
  // Free plan (no Kitchen / Barista screens): the counter prepares too → mark the whole order ready here
  if (hub() && !feat("stations") && o.status === "preparing") { const b = html(`<button class="k-btn ready">✓ Ready</button>`); b.onclick = () => set({ status: "ready", readyAt: serverTimestamp(), stations: Object.fromEntries(Object.keys(o.stations || {}).map((k) => [k, "ready"])) }); acts.appendChild(b); }
  if (o.serviceType === "delivery" && o.status === "ready") { const b = html(`<button class="k-btn prep">🛵 Out for delivery</button>`); b.onclick = () => { if (o.deliveryFeePending) return alert("Set the delivery fee first."); assignRider(o, set); }; acts.appendChild(b); }
  else if (o.serviceType === "delivery" && o.status === "out_for_delivery") { const ew = !o.paid && o.payment && !["cash", "card"].includes(o.payment.method); const b = html(`<button class="k-btn ready">✓ Delivered${o.paid ? "" : ew ? ` · ${esc(o.payment.methodName)} received` : " · cash " + money(o.total)}</button>`); b.onclick = () => { if (!o.paid && !confirm(ew ? `${o.payment.methodName} ${money(o.total)} received?` : `Collected ${money(o.total)} in cash?`)) return; orderOp(storeId, "deliver", { orderId: o.id, paidWith: ew ? "ewallet" : "cash" }).catch((e) => alert(e.message)); }; acts.appendChild(b); }
  else if (next && o.status === "ready") { const b = html(`<button class="k-btn ready">✓ ${o.serviceType === "pickup" ? "Picked up" : esc(next[1])}</button>`); b.onclick = () => set({ status: next[0], completedAt: serverTimestamp() }); acts.appendChild(b); }
  if (o.status === flow[0][0] && store.mode !== "table") { const b = html(`<button class="k-btn prep">Accept</button>`); b.onclick = () => set({ status: flow[1][0], acceptedAt: serverTimestamp() }); acts.appendChild(b); }
  if (store.mode === "table" && feat("editorder") && !["completed", "delivered", "picked_up", "cancelled"].includes(o.status) && (isManager() || !o.paid)) {
    const e = html(`<button class="k-btn">✏️ Edit</button>`); e.onclick = () => editOrder(o); acts.appendChild(e);
  }
  // paid, then an item ran out (night market, pre-order) → record the refund; the customer sees it on their order page
  if (store.mode === "table" && (o.paid || o.payment) && !o.refund && o.status !== "cancelled") {
    const rf = html(`<button class="k-btn">↩️ Sold out → refund</button>`);
    rf.onclick = async () => {
      const names = (o.items || []).map((l) => `${l.qty}× ${l.name}`);
      const which = prompt(`What ran out? (the customer sees this)\n\n${names.join("\n")}`, names.length === 1 ? names[0] : ""); if (which === null) return;
      const amt = prompt(`Refund amount (₱) — the whole order is ${money(o.total)}:`, String(o.total)); if (amt === null) return;
      try { const me = getActiveStaff(storeId); const r = await call("orderRefund", { orderId: o.id, amount: Number(amt), items: which ? [which] : [], reason: "Sold out", staffToken: me?.token || null }); toastMsg(r.cancelled ? "Order cancelled — refund due" : "Refund recorded — mark it refunded when you hand it back"); } catch (e) { alert(e.message); }
    };
    acts.appendChild(rf);
  }
  if (o.refund && o.refund.status !== "refunded") {
    const rd = html(`<button class="k-btn ready">✓ Refund ${money(o.refund.amount)} given</button>`);
    rd.onclick = async () => { const how = prompt("How did you refund? (cash / gcash + reference)", o.refund.method || "cash"); if (how === null) return; try { const me = getActiveStaff(storeId); await call("orderRefund", { orderId: o.id, step: "refunded", method: how.split(/\s+/)[0], ref: how.split(/\s+/).slice(1).join(" "), staffToken: me?.token || null }); toastMsg("Refund marked as given"); } catch (e) { alert(e.message); } };
    acts.appendChild(rd);
  }
  if (store.mode === "table" && feat("editorder") && !["completed", "delivered", "picked_up", "cancelled"].includes(o.status)) {
    const due = o.acceptedAt?.toMillis?.() && o.etaMinutes ? o.acceptedAt.toMillis() + o.etaMinutes * 60000 : 0;
    const late = !!due && Date.now() > due && ["preparing", "pending"].includes(o.status);
    const g = html(`<button class="k-btn ${late ? "comp-late" : ""}">🎁 ${late ? "Late — give a free item?" : "Free item"}</button>`);
    if (store.settings?.vip?.enabled && !o.vipVoucher && !o.roomId) { const vb = html(`<button class="k-btn">👑 Free VIP hours</button>`); vb.onclick = () => { const h = prompt("Free VIP hours to give (1–6):", "2"); if (h) orderOp(storeId, "vipGift", { orderId: o.id, hours: Number(h) }).then((r) => alert(`Voucher ${r.code} — ${r.hours} free hour(s), valid until ${r.validTo}. The customer sees it on their order.`)).catch((err) => alert(err.message)); }; acts.appendChild(vb); }
    g.onclick = () => { const t = prompt(late ? "Free item for the customer (they will see this):" : "Complimentary item (the customer will see this):", late ? "Free Iced Tea — sorry for the wait" : "Free Iced Tea — on the house"); if (t && t.trim()) orderOp(storeId, "comp", { orderId: o.id, text: t.trim(), late }).catch((err) => alert(err.message)); };
    acts.appendChild(g);
  }
  if (isManager() || !o.paid) {
    const x = html(`<button class="k-btn danger" title="Order didn't go through">⚠ Status</button>`);
    x.onclick = () => outcomePicker(o, set);
    acts.appendChild(x);
  }
  return el;
}

// order didn't go through: cancelled / walked out (unpaid) / no-show / failed delivery — reason always required
function outcomePicker(o, set) {
  const opts = [["cancelled", "✕ Cancelled", "Customer changed their mind, sold out…"]];
  if (o.serviceType === "dine_in" || o.serviceType === "take_out") opts.push(["walkout", "💸 Walked out / unpaid", "Left without paying"]);
  if (o.serviceType === "pickup") opts.push(["no_show", "🚫 No-show", "Never picked up"]);
  if (o.serviceType === "delivery") opts.push(["failed_delivery", "📦 Failed delivery", "Can't contact, wrong address, refused"]);
  const el = html(`<div><p class="muted">Order <b style="color:var(--ink)">#${o.orderNo}</b> · ${money(o.total)}</p>
    <div class="c-methods" data-o>${opts.map(([k, l, d]) => `<button data-k="${k}"><b>${l}</b><br><small class="muted">${d}</small></button>`).join("")}</div>
    <label class="muted small" style="display:block;margin-top:12px">Reason (the customer sees this)</label><input class="k-input" data-r placeholder="e.g. No answer after 3 calls"/>
    <button class="k-btn danger" data-go style="width:100%;margin-top:12px">Save status</button></div>`);
  let pick = null;
  el.querySelectorAll("[data-k]").forEach((b) => (b.onclick = () => { pick = b.dataset.k; el.querySelectorAll("[data-k]").forEach((x) => x.classList.toggle("on", x === b)); }));
  el.querySelector("[data-go]").onclick = () => {
    const r = el.querySelector("[data-r]").value.trim();
    if (!pick) return alert("Choose what happened.");
    if (!r) return alert("Please type the reason.");
    orderOp(storeId, "cancel", { orderId: o.id, reason: r, outcome: pick }).then(closeDrawer).catch((e) => alert(e.message));
  };
  openDrawer("What happened?", el);
}

let staffList = [];
function assignRider(o, set) {
  const riders = staffList.filter((x) => (x.roles || []).includes("rider"));
  const el = html(`<div><p class="muted">Who will deliver #${o.orderNo}?</p><div class="c-methods">${riders.map((r) => `<button data-r="${r.id}" data-n="${esc(r.name)}">🛵 ${esc(r.name)}</button>`).join("")}<button data-r="" data-n="">Other / no rider account</button></div></div>`);
  el.querySelectorAll("[data-r]").forEach((b) => (b.onclick = () => { let n = b.dataset.n; if (!n) { n = prompt("Rider name:") || "Rider"; } set({ status: "out_for_delivery", riderId: b.dataset.r || null, riderName: n, outAt: serverTimestamp() }); closeDrawer(); }));
  openDrawer("Out for delivery", el);
}
function askMethod(list, after) {
  const total = list.reduce((a, o) => a + (o.total || 0), 0);
  const el = html(`<div><p class="muted">${list.length} order${list.length > 1 ? "s" : ""} · <b style="color:var(--ink)">${money(total)}</b></p>
    <div class="c-methods">${payMethods(store).map((m) => `<button data-m="${esc(m.id)}">${m.icon} ${esc(m.name)}</button>`).join("")}</div>
    <div class="muted small" style="margin-top:14px">Cash tendered (optional)</div><input class="k-input" type="number" data-tend placeholder="₱"/><div data-change class="muted" style="margin-top:6px"></div></div>`);
  el.querySelector("[data-tend]").oninput = (e) => { const c = Number(e.target.value || 0) - total; el.querySelector("[data-change]").innerHTML = e.target.value ? `Change: <b style="color:var(--ink);font-size:1.2rem">${money(Math.max(0, c))}</b>` : ""; };
  el.querySelectorAll("[data-m]").forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    try { await orderOp(storeId, "pay", { orderIds: list.map((o) => o.id), methodId: b.dataset.m }); } catch (e) { b.disabled = false; return alert(e.message); }
    const tend = Number(el.querySelector("[data-tend]").value || 0);
    if (printCfg(store).enabled && printCfg(store).autoPaid) printReceipt(store, list.map((o) => ({ ...o, paid: true, paymentMethod: b.dataset.m, paidAt: null })), { cur: CUR, cashTendered: tend > 0 ? tend : null, staffName: me?.name });
    closeDrawer(); after?.();
  }));
  if (store.mode === "table" || store.mode === "pickup") {
    const sd = list.reduce((a, o) => a + (o.discounts?.senior || 0), 0);
    const sb = html(`<button class="k-btn" style="margin-top:12px;width:100%">👴 Senior / PWD discount${sd ? ` · −${money(sd)} ✎` : ""}</button>`);
    sb.onclick = () => seniorForm(list, () => { closeDrawer(); after?.(); });
    el.appendChild(sb);
  }
  if (printCfg(store).enabled) { const pr = html(`<button class="k-btn" style="margin-top:12px;width:100%">🖨 Print bill (unpaid)</button>`); pr.onclick = () => printReceipt(store, list, { cur: CUR, staffName: me?.name }); el.appendChild(pr); }
  openDrawer("Mark as paid", el);
}

/** Senior citizen / PWD: people at the table + name & ID of each senior/PWD → 20% off their share (VAT removed if the shop is VAT-registered) */
function seniorForm(list, after) {
  const prev = list.find((o) => o.senior)?.senior;
  const el = html(`<div><p class="small muted" style="margin-top:0">Check each senior / PWD ID. The discount is for <b>their share</b> of the bill (bill ÷ people eating).</p>
    <label class="muted small">People eating (incl. seniors / PWD)</label><input class="k-input" type="number" min="1" data-ppl value="${prev?.people || 1}"/>
    <div data-rows style="margin-top:10px"></div><button class="k-btn sm" type="button" data-add>+ Add senior / PWD</button>
    <div data-est class="small" style="margin-top:10px"></div>
    <div style="display:flex;gap:8px;margin-top:12px"><button class="k-btn primary" style="flex:1" data-ok>Apply discount</button>${prev ? `<button class="k-btn danger" data-clear>Remove</button>` : ""}</div></div>`);
  const rows = el.querySelector("[data-rows]");
  const addRow = (v = {}) => { const r = html(`<div style="display:grid;grid-template-columns:90px 1fr 1fr auto;gap:6px;margin-bottom:6px"><select class="k-input" data-k><option value="senior" ${v.kind !== "pwd" ? "selected" : ""}>Senior</option><option value="pwd" ${v.kind === "pwd" ? "selected" : ""}>PWD</option></select><input class="k-input" data-n placeholder="Full name" value="${esc(v.name || "")}"/><input class="k-input" data-i placeholder="ID no." value="${esc(v.id || "")}"/><button class="k-btn sm" type="button" data-x>✕</button></div>`); r.querySelector("[data-x]").onclick = () => { r.remove(); est(); }; r.oninput = est; rows.appendChild(r); est(); };
  const read = () => [...rows.children].map((r) => ({ kind: r.querySelector("[data-k]").value, name: r.querySelector("[data-n]").value.trim(), id: r.querySelector("[data-i]").value.trim() }));
  const est = () => { const ppl = Math.max(1, Number(el.querySelector("[data-ppl]").value) || 1), n = rows.children.length, base = list.reduce((a, o) => a + Math.max(0, (o.subtotal || 0) - (o.discounts?.voucher || 0)), 0), share = base / ppl; const per = store.settings?.vatRegistered ? share - (share / 1.12) * 0.8 : share * 0.2; el.querySelector("[data-est]").innerHTML = n ? `About <b>−${money(per * n)}</b> (${n} × ${money(per)})${store.settings?.vatRegistered ? " · VAT removed on their share" : ""}` : ""; };
  el.querySelector("[data-ppl]").oninput = est; el.querySelector("[data-add]").onclick = () => addRow();
  (prev?.ids || [{}]).forEach(addRow);
  el.querySelector("[data-ok]").onclick = async (e) => { const ids = read(); if (ids.some((x) => !x.name || !x.id)) return alert("Enter the name and ID number of each senior / PWD."); e.target.disabled = true; try { const r = await orderOp(storeId, "senior", { orderIds: list.map((o) => o.id), people: Number(el.querySelector("[data-ppl]").value) || 1, ids }); closeDrawer(); alert(`Senior / PWD discount: −${money(r.discount)}`); after?.(); } catch (x) { e.target.disabled = false; alert(x.message); } };
  el.querySelector("[data-clear]")?.addEventListener("click", async () => { try { await orderOp(storeId, "senior", { orderIds: list.map((o) => o.id), people: 1, ids: [] }); closeDrawer(); after?.(); } catch (x) { alert(x.message); } });
  openDrawer("👴 Senior / PWD discount", el);
}

// ---------------- TABLES (bills) ----------------
function drawTables(main) {
  const doneKey = flow[flow.length - 1][0];
  const open = orders.filter((o) => o.status !== "cancelled" && (!o.paid || o.status !== doneKey));
  const groups = {};
  open.forEach((o) => { const k = o.tableLabel || (SVC[o.serviceType] || "Other"); (groups[k] = groups[k] || []).push(o); });
  if (store.floorPlanUrl) main.appendChild(html(`<details style="margin-bottom:12px"><summary class="muted" style="cursor:pointer">🗺 Floor plan</summary><a href="${esc(store.floorPlanUrl)}" target="_blank"><img src="${esc(store.floorPlanUrl)}" style="max-width:100%;max-height:420px;border-radius:12px;margin-top:8px"/></a></details>`));
  const grid = html(`<div class="c-grid"></div>`);
  const keys = [...tables.map((t) => t.label).filter((l) => groups[l]), ...Object.keys(groups).filter((k) => !tables.some((t) => t.label === k))];
  if (!keys.length) grid.innerHTML = `<div class="k-empty">No open bills.</div>`;
  keys.forEach((k) => {
    const list = groups[k];
    const unpaid = list.filter((o) => !o.paid);
    const total = unpaid.reduce((a, o) => a + (o.total || 0), 0);
    const el = html(`<article class="k-card" style="border-top-color:${unpaid.length ? "var(--new)" : "var(--ready)"}">
      <div class="top"><div class="no">${esc(k)}</div><div class="time">${list.length} order${list.length > 1 ? "s" : ""}</div></div>
      <ul>${list.map((o) => `<li><span class="q">#${o.orderNo}</span><span>${o.items.map((l) => `${l.qty}× ${esc(l.name)}`).join(", ")}<span class="opt">${money(o.total)} · ${o.paid ? "paid" : "unpaid"} · ${esc(o.status)}</span></span></li>`).join("")}</ul>
      <div class="top"><b style="font-size:1.2rem">${unpaid.length ? "Due " + money(total) : "All paid ✓"}</b></div>
      <div class="acts"></div></article>`);
    if (unpaid.length) { const b = html(`<button class="k-btn primary">💵 Pay all (${unpaid.length})</button>`); b.onclick = () => askMethod(unpaid); el.querySelector(".acts").appendChild(b); }
    const open = list.filter((o) => !["completed", "delivered", "cancelled"].includes(o.status) || !o.paid);
    if (printCfg(store).enabled) { const pb = html(`<button class="k-btn sm">🖨 Bill</button>`); pb.onclick = () => printReceipt(store, list, { cur: CUR, staffName: me?.name }); el.querySelector(".acts").appendChild(pb); }
    if (open.length && list[0].tableId) { const t = html(`<button class="k-btn sm">↔ Transfer</button>`); t.onclick = () => transferBill(k, open); el.querySelector(".acts").appendChild(t); }
    grid.appendChild(el);
  });
  main.appendChild(grid);
}

/** Walk-in in a VIP room: warn if a booking for this room starts before the walk-in would end (+30 min cleaning) */
async function vipWalkinOk(roomId, roomName, hours) {
  try {
    const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    const snap = await getDocs(query(collection(db, "stores", storeId, "reservations"), where("roomId", "==", roomId), where("date", "==", today)));
    const end = Date.now() + (hours * 60 + 30) * 60000;
    const next = snap.docs.map((d) => d.data()).filter((r) => ["pending", "confirmed", "unconfirmed"].includes(r.status) && r.scheduledAt?.toMillis && r.scheduledAt.toMillis() > Date.now() - 30 * 60000).sort((a, b) => a.scheduledAt.toMillis() - b.scheduledAt.toMillis())[0];
    if (!next || next.scheduledAt.toMillis() >= end) return true;
    const at = next.scheduledAt.toDate().toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" });
    const maxH = Math.max(0, Math.floor(((next.scheduledAt.toMillis() - Date.now()) / 60000 - 30) / 60));
    return confirm(`⚠️ ${roomName} is booked at ${at} (${next.customer?.name || next.name || "a customer"}, ${next.hours || 1}h).\n\nA ${hours}h walk-in would overlap. ${maxH >= 1 ? `They can stay up to ${maxH}h only.` : "There isn't enough time before the booking."}\n\nStart anyway?`);
  } catch { return true; }
}

// ---------------- TRANSFER (table ↔ table / VIP room) ----------------
function transferBill(fromLabel, list) {
  const targets = tables.filter((t) => t.active !== false && t.label !== fromLabel);
  const el = html(`<div><p class="muted">Move ${list.length} order(s) from <b style="color:var(--ink)">${esc(fromLabel)}</b> to:</p>
    <div class="c-methods">${targets.map((t) => `<button data-t="${t.id}">${t.isRoom ? "🎤 " : ""}${esc(t.label)}</button>`).join("")}</div></div>`);
  el.querySelectorAll("[data-t]").forEach((b) => (b.onclick = async () => {
    const t = tables.find((x) => x.id === b.dataset.t);
    let sessionId = null, includePrior = false;
    if (t.isRoom) {
      const vip = store.settings?.vip || {};
      const room = (vip.rooms || []).find((r) => r.id === t.roomId);
      let ses = sessions.find((x) => x.roomId === t.roomId && x.status === "open");
      if (!ses) {
        const pax = Number(prompt(`Start VIP session in ${t.label}. How many guests?`, "4") || 0);
        if (!pax) return;
        const hours = Number(prompt("How many hours planned? (min " + (room?.minHours || 1) + ")", String(room?.minHours || 2)) || room?.minHours || 1);
        if (!(await vipWalkinOk(t.roomId, t.label, hours))) return;
        const ref = await addDoc(collection(db, "stores", storeId, "sessions"), { roomId: t.roomId, roomName: t.label, status: "open", pax, bookedHours: hours, pricing: room?.pricing || "hour", ratePerHour: Number(room?.ratePerHour) || 0, minSpend: Number(room?.minSpend) || 0, minHours: Number(room?.minHours) || 1, reservationId: null, customerName: list[0].customer?.name || "", includePrior: false, priorTotal: 0, startedAt: serverTimestamp(), startedBy: me?.name || "staff", staffId: me?.staffId || null, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
        sessionId = ref.id; ses = { id: ref.id };
      } else sessionId = ses.id;
      const priorTotal = list.filter((o) => o.status !== "cancelled").reduce((a, o) => a + (o.total || 0), 0);
      includePrior = !!vip.includePriorOnTransfer;
      if (vip.allowManagerOverride !== false && isManager() && (room?.pricing || "hour") !== "hour") includePrior = confirm(`Include earlier orders (${money(priorTotal)}) in the consumable for ${t.label}?\n\nOK = Include · Cancel = No (consumable counts from session start)`);
      await updateDoc(doc(db, "stores", storeId, "sessions", sessionId), { includePrior, priorTotal: includePrior ? priorTotal : 0, updatedAt: serverTimestamp() }).catch(() => {});
    }
    const batch = writeBatch(db);
    list.forEach((o) => batch.update(doc(db, "stores", storeId, "orders", o.id), { tableId: t.id, tableLabel: t.label, roomId: t.roomId || null, sessionId: t.isRoom && includePrior ? sessionId : (t.isRoom ? null : null), transferredFrom: fromLabel, transferredAt: serverTimestamp(), staffId: me?.staffId || null, updatedAt: serverTimestamp() }));
    await batch.commit().catch((e) => alert(e.message));
    closeDrawer(); chime(0.2);
  }));
  openDrawer("Transfer bill", el);
}

// ---------------- VIP ROOMS ----------------
function drawVip(main) {
  const vip = store.settings?.vip || {};
  const grid = html(`<div class="c-grid"></div>`);
  const now = Date.now();
  (vip.rooms || []).forEach((room) => {
    const ses = sessions.find((x) => x.roomId === room.id && x.status === "open");
    const next = resvToday.find((r) => r.roomId === room.id && r.scheduledAt?.toMillis?.() > now - 3600e3);
    const sesOrders = ses ? orders.filter((o) => o.sessionId === ses.id && o.status !== "cancelled" && o.source !== "room") : [];
    const consumed = sesOrders.filter((o) => !o.pack).reduce((a, o) => a + (o.total || 0), 0) + (ses?.includePrior ? ses.priorTotal || 0 : 0);
    const started = ses?.startedAt?.toDate?.();
    const mins = started ? Math.floor((now - started) / 60000) : 0;
    const priceTxt = room.pricing === "consumable" ? `Min consumable ${money(room.minSpend)}` : room.pricing === "hour_consumable" ? `${money(room.ratePerHour)}/h, consumable` : `${money(room.ratePerHour)}/h`;
    const el = html(`<article class="k-card" style="border-top-color:${ses ? "var(--new)" : "var(--ready)"}">
      <div class="top"><div><div class="no">🎤 ${esc(room.name)}</div><div class="where">${ses ? `Occupied · ${ses.pax} pax · ${Math.floor(mins / 60)}h ${mins % 60}m` : "Available"}</div></div><div class="time">${priceTxt}<span class="eta">up to ${room.capacity} pax · min ${room.minHours || 1}h</span></div></div>
      ${ses && (() => { const o = overtimeFor(store?.settings?.vip?.overtime, started?.getTime?.() || Date.now(), Math.max(ses.bookedHours || 0, room.minHours || 1)); return o.overMin > 0 ? `<div class="k-tag" style="background:#fde8e6;color:#b4423a;font-weight:700;margin-bottom:6px">⏱ Overtime ${o.overMin} min · penalty ${money(o.penalty)}</div>` : ""; })() || ""}
      ${ses ? `<div class="k-tags"><span class="k-tag">Started ${started ? started.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" }) : ""} · plan ${ses.bookedHours}h${ses.reservationCode ? " · " + esc(ses.reservationCode) : ""}</span>${room.pricing !== "hour" ? `<span class="k-tag" style="color:${consumed >= (room.pricing === "consumable" ? room.minSpend : room.ratePerHour * Math.max(ses.bookedHours, room.minHours || 1)) ? "var(--ready)" : "var(--new)"}">Consumed ${money(consumed)}${ses.includePrior ? " (incl. prior)" : ""}</span>` : ""}</div>
        ${room.pricing !== "hour" ? `<div class="small muted">Take-out packs don't count toward the consumable. Unused consumable is forfeited.</div>` : ""}${ses.extensionFee ? `<div class="small">⏱ Extended by customer · ${money(ses.extensionFee)}</div>` : ""}
        <ul>${sesOrders.slice(0, 6).map((o) => `<li><span class="q">#${o.orderNo}</span><span>${o.items.map((l) => `${l.qty}× ${esc(l.name)}`).join(", ")}<span class="opt">${money(o.total)} · ${o.paid ? "paid" : "unpaid"}</span></span></li>`).join("") || `<li class="muted">No orders in this session yet</li>`}</ul>` : next ? `<div class="k-tags"><span class="k-tag">Next: ${esc(next.code)} · ${next.scheduledAt.toDate().toLocaleString("en-PH", { weekday: "short", hour: "numeric", minute: "2-digit" })} · ${esc(next.name)} · ${next.pax} pax</span></div>` : ""}
      <div class="acts"></div></article>`);
    const acts = el.querySelector(".acts");
    if (!ses) { const b = html(`<button class="k-btn primary">▶ Start session (walk-in)</button>`); b.onclick = async () => {
      const name = prompt("Customer name:", "") ?? null; if (name === null) return;
      const pax = Number(prompt("How many guests?", "4") || 0); if (!pax) return;
      const hours = Number(prompt(`How many hours? (min ${room.minHours || 1})`, String(room.minHours || 2)) || room.minHours || 1);
      if (!(await vipWalkinOk(room.id, room.name, hours))) return;
      await addDoc(collection(db, "stores", storeId, "sessions"), { roomId: room.id, roomName: room.name, status: "open", pax, bookedHours: hours, pricing: room.pricing || "hour", ratePerHour: Number(room.ratePerHour) || 0, minSpend: Number(room.minSpend) || 0, minHours: Number(room.minHours) || 1, reservationId: null, customerName: name, includePrior: false, priorTotal: 0, startedAt: serverTimestamp(), startedBy: me?.name || "staff", staffId: me?.staffId || null, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
    }; acts.appendChild(b); }
    else {
      const e = html(`<button class="k-btn">■ End session & compute bill</button>`);
      e.onclick = async () => { if (!confirm(`End session in ${room.name}? Room charge/consumable will be computed.`)) return; const voucherCode = room.pricing === "hour" || !room.pricing ? (prompt("Free VIP hours code? (leave blank if none)", "") || "").trim() : "";
        try { const r = await call("endSession", { sessionId: ses.id, staffName: me?.name, voucherCode }); alert(`Session closed.\nHours: ${r.hours}\nConsumed: ${money(r.consumed)}\nRoom charge: ${money(r.roomCharge)}\nShortfall: ${money(r.shortfall)}\nOvertime: ${r.overtimeMin || 0} min = ${money(r.overtimePenalty || 0)}\n→ Added to bill: ${money(r.charge)}`); tab = "tables"; drawHead(); draw(); } catch (err) { alert(err.message); } };
      acts.appendChild(e);
    }
    grid.appendChild(el);
  });
  if (!(vip.rooms || []).length) grid.innerHTML = `<div class="k-empty">No VIP rooms. Settings → Features → VIP rooms.</div>`;
  main.appendChild(grid);
}

// ---------------- NEW ORDER (walk-in) ----------------
let cart = [], svc = "take_out", tableId = null, catSel = null;
// ---------- offline queue: counter orders made while the internet is down are sent when it's back ----------
const OQ = () => `orderqr:offlineq:${storeId}`;
const loadOQ = () => { try { return JSON.parse(localStorage.getItem(OQ()) || "[]"); } catch { return []; } };
const saveOQ = (q) => { try { localStorage.setItem(OQ(), JSON.stringify(q)); } catch {} drawOfflineBar(); };
function queueOffline(payload) { saveOQ([...loadOQ(), { ...payload, offlineAt: Date.now() }]); toastMsg("📴 No internet — order saved. It will send by itself when you're back online."); }
let flushing = false;
async function flushOffline() {
  if (flushing || !navigator.onLine) return; const q = loadOQ(); if (!q.length) return;
  flushing = true; const left = [];
  for (const p of q) { try { await call("staffPlaceOrder", p); } catch (e) { if (/network|fetch|unavailable|deadline|internal/i.test(`${e.code} ${e.message}`)) left.push(p); else { left.push({ ...p, error: e.message }); } } }
  flushing = false; saveOQ(left);
  if (left.length < q.length) toastMsg(`✓ ${q.length - left.length} saved order${q.length - left.length > 1 ? "s" : ""} sent`);
}
function drawOfflineBar() {
  let bar = document.getElementById("offlineBar"); const q = loadOQ();
  if (!q.length && navigator.onLine) { bar?.remove(); return; }
  if (!bar) { bar = document.createElement("div"); bar.id = "offlineBar"; bar.className = "c-offline"; document.body.prepend(bar); }
  bar.innerHTML = navigator.onLine ? `⏳ Sending ${q.length} saved order${q.length > 1 ? "s" : ""}…${q.some((p) => p.error) ? ` <b>Problem: ${esc(q.find((p) => p.error).error)}</b> <button class="k-btn sm" data-oqx>Discard failed</button>` : ""}` : `📴 Offline${q.length ? ` — ${q.length} order${q.length > 1 ? "s" : ""} saved on this tablet` : ""}. New counter orders are saved and sent automatically when the internet is back.`;
  bar.querySelector("[data-oqx]")?.addEventListener("click", () => saveOQ(loadOQ().filter((p) => !p.error)));
}
addEventListener("online", () => { drawOfflineBar(); flushOffline(); });
addEventListener("offline", drawOfflineBar);
setInterval(flushOffline, 20000);

function drawNewOrder(main) {
  if (store.settings?.setup?.kind === "home" && svc !== "pickup") svc = "pickup";
  if (!catSel && cats[0]) catSel = cats[0].id;
  const wrap = html(`<div class="pos">
    <div class="pos-menu">
      <div class="pos-cats">${cats.map((c) => `<button data-c="${c.id}" class="${catSel === c.id ? "on" : ""}">${esc(c.name)}</button>`).join("")}</div>
      <div class="pos-items"></div>
    </div>
    <div class="pos-cart">
      <div class="k-stations" style="margin-bottom:10px">${(store.settings?.setup?.kind === "home" ? ["pickup"] : ["dine_in", "take_out", "pickup"]).map((k) => `<button data-s="${k}" class="${svc === k ? "on" : ""}">${SVC[k]}</button>`).join("")}</div>
      ${svc === "dine_in" ? `<select class="k-input" data-table style="margin-bottom:10px"><option value="">— Table —</option>${tables.map((t) => `<option value="${t.id}" ${tableId === t.id ? "selected" : ""}>${esc(t.label)}</option>`).join("")}</select>` : ""}
      ${svc === "pickup" ? `<input class="k-input" data-name placeholder="Customer name" style="margin-bottom:8px"/><input class="k-input" data-phone placeholder="Phone" style="margin-bottom:10px"/>` : ""}
      <div class="pos-lines"></div>
      <div class="pos-total"><span>Total</span><b data-total>${money(0)}</b></div>
      <input class="k-input" data-note placeholder="Order note" style="margin:8px 0"/>
      <button class="k-btn primary" data-add style="width:100%;min-height:50px;font-size:1rem">Add to order</button>
      <p class="small muted" style="margin:6px 0 0;text-align:center">${store.settings?.service?.payFirst ? "Pay first is on — you'll take the payment next." : "Take the payment from the order card (💵 Mark paid) anytime."}</p>
    </div></div>`);
  const itemsEl = wrap.querySelector(".pos-items");
  const drawItems = () => {
    itemsEl.innerHTML = "";
    items.filter((it) => it.categoryId === catSel).forEach((it) => {
      const b = html(`<button class="pos-item ${it.available === false ? "out" : ""}" ${it.available === false ? "disabled" : ""}>${it.imageUrl ? `<img src="${esc(it.imageUrl)}" alt=""/>` : ""}<span class="n">${esc(it.name)}</span><span class="p">${money(it.price)}</span></button>`);
      b.onclick = () => (it.options?.length ? pickOptions(it) : addLine(it, []));
      itemsEl.appendChild(b);
    });
  };
  wrap.querySelectorAll("[data-c]").forEach((b) => (b.onclick = () => { catSel = b.dataset.c; wrap.querySelectorAll("[data-c]").forEach((x) => x.classList.toggle("on", x === b)); drawItems(); }));
  wrap.querySelectorAll("[data-s]").forEach((b) => (b.onclick = () => { svc = b.dataset.s; draw(); }));
  wrap.querySelector("[data-table]")?.addEventListener("change", (e) => (tableId = e.target.value));
  const linesEl = wrap.querySelector(".pos-lines");
  const drawLines = () => {
    linesEl.innerHTML = cart.length ? "" : `<div class="muted small" style="padding:20px 0;text-align:center">Tap items to add</div>`;
    cart.forEach((l, i) => {
      const row = html(`<div class="pos-line"><div><b>${esc(l.name)}</b>${l.choices.length ? `<small>${l.choices.map((c) => esc(c.label)).join(", ")}</small>` : ""}</div>
        <div class="c-qty"><button data-m>−</button><span>${l.qty}</span><button data-p>+</button></div><span>${money(l.unit * l.qty)}</span></div>`);
      row.querySelector("[data-m]").onclick = () => { l.qty--; if (l.qty <= 0) cart.splice(i, 1); drawLines(); };
      row.querySelector("[data-p]").onclick = () => { l.qty++; drawLines(); };
      linesEl.appendChild(row);
    });
    wrap.querySelector("[data-total]").textContent = money(cart.reduce((a, l) => a + l.unit * l.qty, 0));
  };
  function addLine(it, choices) {
    const unit = it.price + choices.reduce((a, c) => a + (c.add || 0), 0);
    const key = it.id + "|" + choices.map((c) => c.label).join(",");
    const ex = cart.find((l) => l.key === key);
    if (ex) ex.qty++; else cart.push({ key, itemId: it.id, name: it.name, qty: 1, unit, choices });
    drawLines();
  }
  function pickOptions(it) {
    const picked = {};
    const el = html(`<div>${(it.options || []).map((g) => `<div class="c-opt"><b>${esc(g.name)}${g.required ? ' <span style="color:var(--danger)">*</span>' : ""}</b><div class="c-methods" data-g="${esc(g.name)}">${g.choices.map((c) => `<button data-l="${esc(c.label)}">${esc(c.label)}${c.add ? ` +${money(c.add)}` : ""}</button>`).join("")}</div></div>`).join("")}<button class="k-btn primary" data-add style="margin-top:14px;width:100%">Add</button></div>`);
    el.querySelectorAll("[data-g]").forEach((gEl) => { const g = it.options.find((x) => x.name === gEl.dataset.g); picked[g.name] = []; gEl.querySelectorAll("button").forEach((b) => (b.onclick = () => { const l = b.dataset.l; if (g.multi) { b.classList.toggle("on"); picked[g.name] = b.classList.contains("on") ? [...picked[g.name], l] : picked[g.name].filter((x) => x !== l); } else { gEl.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); picked[g.name] = [l]; } })); });
    el.querySelector("[data-add]").onclick = () => {
      for (const g of it.options) if (g.required && !picked[g.name].length) return alert(`Please choose ${g.name}`);
      const choices = it.options.flatMap((g) => picked[g.name].map((l) => ({ group: g.name, label: l, add: g.choices.find((c) => c.label === l)?.add || 0 })));
      addLine(it, choices); closeDrawer();
    };
    openDrawer(it.name, el);
  }
  async function submit(paid, method) {
    if (!cart.length) return alert("The order is empty.");
    if (svc === "dine_in" && !tableId) return alert("Please select a table.");
    const customer = { name: wrap.querySelector("[data-name]")?.value || "", phone: wrap.querySelector("[data-phone]")?.value || "" };
    const payload = { serviceType: svc, tableId: svc === "dine_in" ? tableId : null, items: cart.map((l) => ({ itemId: l.itemId, qty: l.qty, choices: l.choices.map((c) => ({ group: c.group, label: c.label })) })), customer, note: wrap.querySelector("[data-note]").value, paid, paymentMethod: method, staffId: me?.staffId, staffName: me?.name, clientRef: "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7) };
    if (!navigator.onLine) { queueOffline(payload); cart = []; drawLines(); wrap.querySelector("[data-note]").value = ""; return; }
    try {
      const res = await call("staffPlaceOrder", payload);
      cart = []; drawLines(); wrap.querySelector("[data-note]").value = "";
      if (hub()) { let tries = 0; const wait = () => { const o = orders.find((x) => x.id === res.orderId); if (o) { if (needsAccept(o)) acceptPicker(o); } else if (tries++ < 20) setTimeout(wait, 150); }; wait(); }
      else chime(0.2);
      if (printCfg(store).enabled && (printCfg(store).autoOrder || (paid && printCfg(store).autoPaid))) setTimeout(() => { const o = orders.find((x) => x.id === res.orderId); if (o) printReceipt(store, o, { cur: CUR, staffName: me?.name }); }, 1200);
      if (!hub()) alert(`Order sent · ${money(res.total)}`);
    } catch (e) {
      if (!navigator.onLine || /network|fetch|unavailable|deadline|internal/i.test(`${e.code} ${e.message}`)) { queueOffline(payload); cart = []; drawLines(); wrap.querySelector("[data-note]").value = ""; return; }
      alert(e.message);
    }
  }
  const payThenSubmit = () => {
    if (!cart.length) return alert("The order is empty.");
    const total = cart.reduce((a, l) => a + l.unit * l.qty, 0);
    const el = html(`<div><p class="muted">Total <b style="color:var(--ink)">${money(total)}</b></p><div class="c-methods">${payMethods(store).map((m) => `<button data-m="${esc(m.id)}">${m.icon} ${esc(m.name)}</button>`).join("")}</div>
      <div class="muted small" style="margin-top:14px">Cash tendered (optional)</div><input class="k-input" type="number" data-tend placeholder="₱"/><div data-change class="muted" style="margin-top:6px"></div></div>`);
    el.querySelector("[data-tend]").oninput = (e) => { const c = Number(e.target.value || 0) - total; el.querySelector("[data-change]").innerHTML = e.target.value ? `Change: <b style="color:var(--ink);font-size:1.2rem">${money(Math.max(0, c))}</b>` : ""; };
    el.querySelectorAll("[data-m]").forEach((b) => (b.onclick = () => { closeDrawer(); submit(true, b.dataset.m); }));
    openDrawer("Payment", el);
  };
  // one button: "Add to order" — with Pay first on, the payment sheet opens first
  wrap.querySelector("[data-add]").onclick = () => (store.settings?.service?.payFirst && svc !== "delivery" ? payThenSubmit() : submit(false, null));
  drawItems(); drawLines();
  main.appendChild(wrap);
}

// ---------------- shift (shared logic) ----------------
async function openShiftPanel() {
  const doneKey = flow[flow.length - 1][0];
  if (!openShift) {
    const el = html(`<div><p class="muted">Start a shift to track sales and cash.</p>
      <label>Starting cash in drawer (₱)</label><input type="number" min="0" data-cash value="0" class="k-input"/>
      <label>Note (optional)</label><input data-note class="k-input" placeholder="e.g. AM shift"/>
      <button class="k-btn primary" data-go style="margin-top:14px;width:100%">▶ Start shift as ${esc(me?.name || "staff")}</button></div>`);
    el.querySelector("[data-go]").onclick = async () => { await startShift(storeId, me, el.querySelector("[data-cash]").value, el.querySelector("[data-note]").value.trim()); closeDrawer(); };
    return openDrawer("Start shift", el);
  }
  if (!["open", "needs_count"].includes(openShift.status)) { const el = verifyShiftPanel({ storeId, me, shift: openShift, store, currency: CUR, onDone: () => { closeDrawer(); } }); return openDrawer("Shift check", el); }
  const el = html(`<div><p class="muted">Loading…</p></div>`);
  openDrawer("Shift", el);
  const tally = await computeShiftTally(storeId, openShift, doneKey);
  const opened = openShift.openedAt?.toDate?.();
  const blind = true; // always a blind count
  el.innerHTML = `${openShift.status === "needs_count" ? `<div class="k-note" style="margin-bottom:10px">🌙 This shift ended automatically (${esc(openShift.closedByName || "")}). Count the cash now — a new shift can start after the count is checked.</div>` : ""}<p class="muted small">Started ${opened ? opened.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" }) : ""} by ${esc(openShift.openedByName || "")}</p>
    ${blind ? `<div class="k-sum"><div class="box"><div class="k">Orders</div><div class="v">${tally.orders}</div></div><div class="box"><div class="k">Completed / Cancelled</div><div class="v">${tally.completed} / ${tally.cancelled}</div></div><div class="box"><div class="k">Unpaid orders</div><div class="v">${money(tally.unpaidTotal)}</div></div></div><p class="muted small">Sales and cash totals are hidden (blind count).</p>` : tallyHTML(openShift, tally, CUR)}
    <div style="margin-top:18px;border-top:1px solid var(--line);padding-top:14px"><h3 style="margin:0 0 6px">End shift</h3><div data-close></div></div>`;
  el.querySelector("[data-close]").appendChild(closeShiftForm({ storeId, me, shift: openShift, tally, store, currency: CUR, onDone: (r) => { closeDrawer(); alert(r.auto ? "Count submitted ✓ Shift closed." : "Count submitted. A manager will check this shift."); } }));
}

// ---------------- drawer ----------------
function openDrawer(title, bodyEl) {
  closeDrawer();
  const w = html(`<div class="k-drawer-wrap"><div class="k-drawer"><div class="hd"><h3>${esc(title)}</h3><button class="x">×</button></div><div class="bd"></div></div></div>`);
  w.querySelector(".bd").appendChild(bodyEl);
  w.querySelector(".x").onclick = closeDrawer;
  w.addEventListener("click", (e) => e.target === w && closeDrawer());
  document.body.appendChild(w);
}
function closeDrawer() { document.querySelector(".k-drawer-wrap")?.remove(); }

// ---------------- ✏️ Edit order (counter crew / manager) — the customer sees "Your order was updated" ----------------
function editOrder(o) {
  const keep = (o.items || []).map((l) => l.qty);
  const add = [];
  let svc = o.serviceType, reason = "Customer request";
  const pairs = { dine_in: ["dine_in", "take_out"], take_out: ["take_out", "dine_in"], pickup: ["pickup", "delivery"], delivery: ["delivery", "pickup"] };
  const SV = { dine_in: "🍽 Dine-in", take_out: "🥡 Take-out", pickup: "🛍 Pickup", delivery: "🛵 Delivery" };
  const el = html(`<div class="ed">
    <div data-lines></div>
    <details class="ed-add"><summary>➕ Add item</summary><input class="k-input" data-s placeholder="Search menu…"/><div data-list class="ed-list"></div></details>
    ${o.parentId ? "" : `<label class="muted small">Order type</label><div class="c-methods" data-svc>${(pairs[o.serviceType] || [o.serviceType]).map((k) => `<button data-k="${k}" class="${k === svc ? "on" : ""}">${SV[k] || k}</button>`).join("")}</div>`}
    <div data-del style="display:none"><label class="muted small">Delivery address</label><input class="k-input" data-addr value="${esc(o.customer?.address || "")}"/>
      <label class="muted small">Delivery fee (₱)</label><div class="c-methods" data-fees>${[0, 20, 30, 40, 50, 60, 80].map((f) => `<button data-f="${f}">${f ? "₱" + f : "FREE"}</button>`).join("")}</div><input class="k-input" type="number" min="0" data-fee value="${o.deliveryFee ?? ""}" placeholder="₱"/></div>
    <label class="muted small">Reason (the customer sees this)</label><div class="c-methods" data-why>${["Out of stock", "Customer request", "Changed by staff"].map((r) => `<button data-r="${r}" class="${r === reason ? "on" : ""}">${r}</button>`).join("")}</div>
    <div class="ed-sum" data-sum></div>
    <button class="k-btn primary" data-save style="width:100%;margin-top:10px">Save changes</button>
  </div>`);
  const drawLines = () => {
    const box = el.querySelector("[data-lines]");
    box.innerHTML = (o.items || []).map((l, i) => `<div class="ed-line ${keep[i] === 0 ? "gone" : ""}"><span><b>${esc(l.name)}</b>${l.choices?.length ? `<small>${l.choices.map((c) => esc(c.label)).join(", ")}</small>` : ""}</span><span class="ed-q"><button data-m="${i}">−</button><b>${keep[i]}</b><button data-p="${i}">+</button><button data-x="${i}" title="Remove">🗑</button></span></div>`).join("")
      + add.map((a, j) => `<div class="ed-line new"><span><b>➕ ${esc(a.name)}</b>${a.choices.length ? `<small>${a.choices.map((c) => esc(c.label)).join(", ")}</small>` : ""}</span><span class="ed-q"><button data-am="${j}">−</button><b>${a.qty}</b><button data-ap="${j}">+</button></span></div>`).join("");
    box.querySelectorAll("[data-m]").forEach((b) => (b.onclick = () => { const i = +b.dataset.m; keep[i] = Math.max(0, keep[i] - 1); drawLines(); }));
    box.querySelectorAll("[data-p]").forEach((b) => (b.onclick = () => { const i = +b.dataset.p; keep[i] = Math.min(99, keep[i] + 1); drawLines(); }));
    box.querySelectorAll("[data-x]").forEach((b) => (b.onclick = () => { keep[+b.dataset.x] = 0; drawLines(); }));
    box.querySelectorAll("[data-am]").forEach((b) => (b.onclick = () => { const j = +b.dataset.am; add[j].qty--; if (add[j].qty <= 0) add.splice(j, 1); drawLines(); }));
    box.querySelectorAll("[data-ap]").forEach((b) => (b.onclick = () => { add[+b.dataset.ap].qty++; drawLines(); }));
    const keptSum = (o.items || []).reduce((a, l, i) => a + ((l.subtotal || 0) / (l.qty || 1)) * keep[i], 0);
    const addSum = add.reduce((a, x) => a + x.unit * x.qty, 0);
    const fee = svc === "delivery" ? Number(el.querySelector("[data-fee]").value || o.deliveryFee || 0) : 0;
    el.querySelector("[data-sum]").innerHTML = `Was <b>${money(o.total)}</b> → about <b>${money(keptSum + addSum - Math.min(o.voucher?.discount || 0, keptSum + addSum) + fee + (o.smallOrderFee || 0))}</b>${o.paid ? `<br><span class="small" style="color:var(--new)">This order is paid — if the total goes up, the difference shows as “Balance to collect”.</span>` : ""}`;
  };
  const drawList = (q = "") => {
    const list = el.querySelector("[data-list]");
    const rows = items.filter((it) => it.available !== false && (!q || it.name.toLowerCase().includes(q))).slice(0, 40);
    list.innerHTML = rows.map((it) => `<button data-it="${it.id}"><span>${esc(it.name)}</span><b>${money(it.price)}</b></button>`).join("") || `<p class="muted small">No match.</p>`;
    list.querySelectorAll("[data-it]").forEach((b) => (b.onclick = () => {
      const it = items.find((x) => x.id === b.dataset.it);
      const choices = []; let unit = Number(it.price) || 0;
      for (const g of it.options || []) {
        if (!g.required && !confirm(`Add an option for ${g.name}? (OK = choose, Cancel = skip)`)) continue;
        const pick = prompt(`${it.name} — ${g.name}:\n${g.choices.map((c, i) => `${i + 1}. ${c.label}${c.add ? " +₱" + c.add : ""}`).join("\n")}\n\nType the number:`, "1");
        const c = g.choices[(parseInt(pick, 10) || 1) - 1]; if (!c) continue;
        choices.push({ group: g.name, label: c.label }); unit += Number(c.add) || 0;
      }
      add.push({ itemId: it.id, name: it.name, qty: 1, choices, unit }); drawLines();
    }));
  };
  const syncSvc = () => { el.querySelector("[data-del]").style.display = svc === "delivery" ? "" : "none"; drawLines(); };
  el.querySelector("[data-s]").oninput = (e) => drawList(e.target.value.toLowerCase());
  el.querySelectorAll("[data-svc] [data-k]").forEach((b) => (b.onclick = () => { svc = b.dataset.k; el.querySelectorAll("[data-svc] [data-k]").forEach((x) => x.classList.toggle("on", x === b)); syncSvc(); }));
  el.querySelectorAll("[data-fees] [data-f]").forEach((b) => (b.onclick = () => { el.querySelector("[data-fee]").value = b.dataset.f; drawLines(); }));
  el.querySelector("[data-fee]").oninput = drawLines;
  el.querySelectorAll("[data-why] [data-r]").forEach((b) => (b.onclick = () => { reason = b.dataset.r; el.querySelectorAll("[data-why] [data-r]").forEach((x) => x.classList.toggle("on", x === b)); }));
  el.querySelector("[data-save]").onclick = async (e) => {
    if (keep.every((q) => q === 0) && !add.length) return alert("Nothing left in the order. To cancel it, use ⚠ Status → Cancelled.");
    e.target.disabled = true; e.target.textContent = "Saving…";
    try {
      const r = await orderOp(storeId, "edit", { orderId: o.id, keep: keep.map((qty, i) => ({ i, qty })), add: add.map((a) => ({ itemId: a.itemId, qty: a.qty, choices: a.choices })), serviceType: svc, address: svc === "delivery" ? el.querySelector("[data-addr]").value : undefined, deliveryFee: svc === "delivery" ? el.querySelector("[data-fee]").value : undefined, reason });
      closeDrawer(); toastMsg(`Order updated · ${money(r.total)}`);
    } catch (err) { alert(err.message); e.target.disabled = false; e.target.textContent = "Save changes"; }
  };
  drawList(); syncSvc();
  openDrawer(`Edit order #${o.orderNo}`, el);
}

// ---------------- 🧰 Menu tools (managers): prices with change log, add item, photo, dish promo + slow movers ----------------
async function menuTools(tabName = "prices") {
  const op = (action, data) => call("menuOps", { action, ...data, staffToken: me?.token || null });
  const el = html(`<div><div class="c-methods" data-tabs>${[["prices", "₱ Prices"], ["add", "➕ Add item"], ["promo", "🏷️ Dish promo"], ["log", "🕒 Changes"]].map(([k, l]) => `<button data-k="${k}" class="${k === tabName ? "on" : ""}">${l}</button>`).join("")}</div><div data-body style="margin-top:12px"></div></div>`);
  const body = el.querySelector("[data-body]");
  el.querySelectorAll("[data-tabs] [data-k]").forEach((b) => (b.onclick = () => { el.querySelectorAll("[data-tabs] [data-k]").forEach((x) => x.classList.toggle("on", x === b)); show(b.dataset.k); }));
  const pct = (a, b) => (a ? Math.round(((b - a) / a) * 100) : 0);
  function show(k) {
    if (k === "prices") {
      body.innerHTML = `<input class="k-input" data-q placeholder="Search…"/><div data-list style="margin-top:8px"></div>`;
      const draw = (q = "") => {
        const list = body.querySelector("[data-list]");
        const rows = items.filter((it) => !q || it.name.toLowerCase().includes(q)).sort((a, b) => (b.priceChangedAt || 0) - (a.priceChangedAt || 0));
        list.innerHTML = rows.map((it) => `<div class="k-item"><span>${esc(it.name)}<span class="cat">${it.prevPrice != null && it.priceChangedAt ? `${money(it.prevPrice)} → <b>${money(it.price)}</b> ${it.price > it.prevPrice ? "▲" : "▼"} ${money(Math.abs(it.price - it.prevPrice))} (${pct(it.prevPrice, it.price)}%) · ${new Date(it.priceChangedAt).toLocaleDateString("en-PH", { month: "short", day: "numeric" })}` : money(it.price)}</span></span><span class="row" style="gap:6px"><button class="k-btn sm" data-p="${it.id}">✏️ ₱</button><button class="k-btn sm" data-ph="${it.id}">📷</button></span></div>`).join("");
        list.querySelectorAll("[data-p]").forEach((b) => (b.onclick = async () => { const it = items.find((x) => x.id === b.dataset.p); const v = prompt(`New price for ${it.name} (now ${money(it.price)}):`, it.price); if (v == null || v === "") return; if (!confirm(`Change ${it.name}: ${money(it.price)} → ${money(Number(v))}? It shows on the menu right away.`)) return; try { await op("price", { itemId: it.id, price: Number(v) }); toastMsg("Price updated"); } catch (e) { alert(e.message); } }));
        list.querySelectorAll("[data-ph]").forEach((b) => (b.onclick = async () => { const it = items.find((x) => x.id === b.dataset.ph); const v = prompt(`Photo link for ${it.name} (https://…). Leave blank to remove the photo:`, it.imageUrl || ""); if (v == null) return; try { await op("photo", { itemId: it.id, url: v.trim() }); toastMsg(v.trim() ? "Photo updated" : "Photo removed"); } catch (e) { alert(e.message); } }));
      };
      body.querySelector("[data-q]").oninput = (e) => draw(e.target.value.toLowerCase()); draw();
    }
    if (k === "add") {
      body.innerHTML = `<label class="muted small">Category</label><select class="k-input" data-cat>${cats.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select>
        <label class="muted small">Name</label><input class="k-input" data-n placeholder="e.g. Tapsilog"/>
        <label class="muted small">Price (₱)</label><input class="k-input" type="number" min="0" data-pr/>
        <label class="muted small">Description (optional)</label><input class="k-input" data-d/>
        <button class="k-btn primary" data-go style="width:100%;margin-top:12px">➕ Add to menu</button>`;
      body.querySelector("[data-go]").onclick = async (e) => { e.target.disabled = true; try { await op("addItem", { categoryId: body.querySelector("[data-cat]").value, name: body.querySelector("[data-n]").value, price: Number(body.querySelector("[data-pr]").value), description: body.querySelector("[data-d]").value }); toastMsg("Added to the menu"); show("add"); } catch (err) { alert(err.message); e.target.disabled = false; } };
    }
    if (k === "promo") {
      body.innerHTML = `<div data-slow class="small muted">Checking slow-moving dishes…</div>
        <label class="muted small" style="margin-top:12px;display:block">Dishes</label><input class="k-input" data-q placeholder="Search dishes…"/><div data-pick class="ed-list" style="max-height:200px"></div>
        <div class="row wrap" style="gap:8px;margin-top:10px"><label class="muted small">% off <input class="k-input sm" type="number" min="1" max="90" value="10" data-pct style="width:80px"/></label><label class="muted small">or promo price ₱ <input class="k-input sm" type="number" min="1" data-pp style="width:100px" placeholder="1 dish only"/></label></div>
        <div class="c-methods" data-days style="margin-top:8px">${[[1, "Today"], [3, "3 days"], [7, "7 days"]].map(([d, l]) => `<button data-d="${d}" class="${d === 3 ? "on" : ""}">${l}</button>`).join("")}</div>
        <button class="k-btn primary" data-go style="width:100%;margin-top:12px">🏷️ Start dish promo</button>`;
      const picked = new Set(); let days = 3;
      const drawPick = (q = "") => { const list = body.querySelector("[data-pick]"); list.innerHTML = items.filter((it) => !q || it.name.toLowerCase().includes(q)).map((it) => `<label class="r-pick" style="justify-content:space-between"><span><input type="checkbox" data-i="${it.id}" ${picked.has(it.id) ? "checked" : ""}/> ${esc(it.name)}</span><b>${money(it.price)}</b></label>`).join(""); list.querySelectorAll("[data-i]").forEach((c) => (c.onchange = () => (c.checked ? picked.add(c.dataset.i) : picked.delete(c.dataset.i)))); };
      body.querySelector("[data-q]").oninput = (e) => drawPick(e.target.value.toLowerCase()); drawPick();
      body.querySelectorAll("[data-days] [data-d]").forEach((b) => (b.onclick = () => { days = +b.dataset.d; body.querySelectorAll("[data-days] [data-d]").forEach((x) => x.classList.toggle("on", x === b)); }));
      const go = async (ids, pctV, ppV, d) => { try { await op("dishPromo", { itemIds: ids, percent: pctV, promoPrice: ppV, days: d }); toastMsg("Dish promo started — customers see it now"); closeDrawer(); } catch (err) { alert(err.message); } };
      body.querySelector("[data-go]").onclick = () => { if (!picked.size) return alert("Pick at least one dish."); const pp = body.querySelector("[data-pp]").value; go([...picked], Number(body.querySelector("[data-pct]").value), pp ? Number(pp) : null, days); };
      call("slowItems", { staffToken: me?.token || null }).then((r) => {
        const box = body.querySelector("[data-slow]"); if (!box) return;
        box.innerHTML = r.items.length ? `<b>🐢 Slow-moving this week</b> — tap for 10% off · 3 days:<div class="row wrap" style="gap:6px;margin-top:6px">${r.items.map((it) => `<button class="k-btn sm" data-slow="${it.id}">${esc(it.name)} · sold ${it.sold}</button>`).join("")}</div>` : esc(r.note || "No slow-moving dishes this week 🎉");
        box.querySelectorAll("[data-slow]").forEach((b) => (b.onclick = () => { if (confirm(`10% off ${b.textContent.split(" · ")[0]} for 3 days?`)) go([b.dataset.slow], 10, null, 3); }));
      }).catch((e) => { const box = body.querySelector("[data-slow]"); if (box) box.textContent = e.message; });
    }
    if (k === "log") {
      body.innerHTML = `<p class="muted small">Loading…</p>`;
      getDocs(query(collection(db, "stores", storeId, "priceLog"), orderBy("at", "desc"), limit(50))).then((snap) => {
        body.innerHTML = snap.empty ? `<p class="muted small">No price changes yet.</p>` : snap.docs.map((d) => d.data()).map((x) => `<div class="k-item"><span>${esc(x.name)}<span class="cat">${money(x.old)} → <b>${money(x.new)}</b> (${x.new > x.old ? "+" : ""}${pct(x.old, x.new)}%) · ${esc(x.by)} · ${x.at?.toDate ? x.at.toDate().toLocaleString("en-PH", { dateStyle: "short", timeStyle: "short" }) : ""}</span></span></div>`).join("");
      }).catch((e) => (body.textContent = e.message));
    }
  }
  show(tabName);
  openDrawer("Menu tools", el);
}

// ---------------- 🪑 Waitlist (counter) ----------------
function drawWaitlist(main) {
  const live = waitlist.filter((w) => ["waiting", "called"].includes(w.status)).sort((a, b) => (a.createdMs || 0) - (b.createdMs || 0));
  const today = waitlist.filter((w) => ["seated", "no_show", "left"].includes(w.status)).slice(0, 15);
  const wrap = html(`<div><div class="k-cols1"></div>${today.length ? `<details class="rq-done"><summary>Done today (${today.length})</summary><div class="small">${today.map((w) => `<div class="k-item"><span>${esc(w.name)} · ${w.pax} pax</span><span class="muted">${w.status === "seated" ? "✅ seated" + (w.seatedBy === "customer" ? " (by customer)" : "") : w.status === "no_show" ? "🚫 no-show" : "left"}</span></div>`).join("")}</div></details>` : ""}</div>`);
  const col = wrap.querySelector(".k-cols1");
  if (!live.length) col.innerHTML = `<div class="k-empty">Nobody is waiting. Print the waitlist QR from Tables &amp; QR in the dashboard.</div>`;
  live.forEach((w, i) => {
    const mins = Math.floor((Date.now() - (w.createdMs || Date.now())) / 60000);
    const left = w.holdUntil ? Math.round((w.holdUntil - Date.now()) / 60000) : null;
    const el = html(`<article class="k-card" style="border-top-color:${w.status === "called" ? "var(--ready)" : "var(--new)"}"><div class="top"><div><div class="no">#${i + 1} · ${esc(w.name)}</div><div class="where">🪑 ${w.pax} pax${w.phone ? ` · ${esc(w.phone)}` : ""}</div></div><div class="time">waited ${mins} min${w.status === "called" ? `<span class="eta">${left >= 0 ? `hold ${left} min left` : `<b style="color:var(--danger)">over by ${-left} min</b>`}</span>` : ""}</div></div><div class="acts"></div></article>`);
    const acts = el.querySelector(".acts");
    const set = (patch) => updateDoc(doc(db, "stores", storeId, "waitlist", w.id), { ...patch, staffId: me?.staffId || null, updatedAt: serverTimestamp() }).catch((e) => alert(e.message));
    if (w.status === "waiting") { const b = html(`<button class="k-btn primary">📣 Table ready (hold 10 min)</button>`); b.onclick = () => { const t = prompt("Which table? (optional — the customer sees this)", ""); set({ status: "called", calledAt: Date.now(), holdUntil: Date.now() + 10 * 60000, tableLabel: t ? t.trim().slice(0, 30) : null }); }; acts.appendChild(b); }
    else { [5, 10].forEach((m) => { const b = html(`<button class="k-btn sm">+${m} min</button>`); b.onclick = () => set({ holdUntil: Math.max(Date.now(), w.holdUntil || Date.now()) + m * 60000 }); acts.appendChild(b); }); }
    const st = html(`<button class="k-btn ready">✅ Seated</button>`); st.onclick = () => set({ status: "seated", seatedBy: me?.name || "staff", seatedAt: Date.now() }); acts.appendChild(st);
    const ns = html(`<button class="k-btn sm danger">🚫 No-show</button>`); ns.onclick = () => { if (confirm(`Release ${w.name}'s spot?`)) set({ status: "no_show" }); }; acts.appendChild(ns);
    col.appendChild(el);
  });
  main.appendChild(wrap);
}
