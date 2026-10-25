// Kitchen screen: /kitchen/ — for the kitchen tablet (owner, staff, or kitchen account)
import { orderOp } from "./orderops.js";
import { setShell } from "./appshell.js";
import { auth, db, call } from "./firebase.js";
import { deviceSignIn, showDeviceSetup, ownerOnStaffBanner } from "./device.js";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { collection, doc, onSnapshot, query, orderBy, limit, updateDoc, serverTimestamp } from "firebase/firestore";
import { FLOW } from "./pages/orders.js";
import { stationsOf, stationPatch, dispatchOn, PACKED } from "./flow.js";
import { PRESETS } from "./presets.js";
import { printKitchenTicket, printCfg } from "./print.js";
import { startDuty, watchDuty, dutyBoardHTML, watchFeatures, requireFeature, feat, pinGate, getActiveStaff, clearActiveStaff, roleLabel, tapToStart, chime, startRinging, stopRinging } from "./staffauth.js";
import { closeShiftForm, verifyShiftPanel, mountStaffNotes, watchRequests, renderRequests, watchOpenShift, startShift, computeShiftTally, endShift, tallyHTML, orderTagsHTML } from "./staffpanels.js";
import { watchMaintenance } from "./maint.js";
watchMaintenance("staff");

const app = document.getElementById("app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const html = (str) => { const t = document.createElement("template"); t.innerHTML = str.trim(); return t.content.firstElementChild; };
const money = (n, c = "PHP") => (c === "PHP" ? "₱" : c + " ") + Number(n || 0).toLocaleString("en-PH", { maximumFractionDigits: 2 });
const SVC = { dine_in: "Dine-in", take_out: "Take-out", pickup: "Pickup", delivery: "Delivery" };

let storeId, store, flow, orders = [], items = [], seen = null, me = null;
let requests = [], openReq = 0, reqUnsub = null, openShift = null, view = "board"; // board | requests
const STATIONS = { kitchen: ["🍳", "Kitchen"], barista: ["☕", "Barista"], counter: ["🧾", "Counter"] };
let station = localStorage.getItem("orderqr:station") || "all";   // all | kitchen | barista | counter
function allowedStations(roles = []) {
  if (roles.includes("manager") || roles.includes("crew")) return ["all", "kitchen", "barista", "counter"];
  const out = [];
  if (roles.includes("kitchen")) out.push("kitchen");
  if (roles.includes("barista")) out.push("barista");
  return out.length ? out : ["all"];
}
function pickStationForMe() {
  const ok = allowedStations(me?.roles);
  if (!ok.includes(station)) station = ok[0];
  localStorage.setItem("orderqr:station", station);
}
const prefs = { sound: localStorage.getItem("orderqr:sound") !== "off", ring: localStorage.getItem("orderqr:ring") === "on", volume: Number(localStorage.getItem("orderqr:vol") || 0.3) };
const savePrefs = () => { localStorage.setItem("orderqr:sound", prefs.sound ? "on" : "off"); localStorage.setItem("orderqr:ring", prefs.ring ? "on" : "off"); localStorage.setItem("orderqr:vol", String(prefs.volume)); };
const LATE_MIN = 20;
// Café/restaurant: the Counter accepts every order first (with a prep time). The kitchen only sees accepted orders.
const hub = () => store?.mode === "table";
const fireWin = () => (Number(store?.settings?.service?.fireBeforeMin) || 30) * 60000;
const kitchenSees = (o) => ["preparing", "ready"].includes(o.status) || (o.status === "pending" && !!o.acceptedAt && (!o.scheduledAt || o.scheduledAt.toMillis() - Date.now() <= fireWin()));
const myKeys = (o) => { const st = stationsOf(o); return station === "all" ? Object.keys(st) : st[station] ? [station] : []; };
const myLevel = (o) => { const st = stationsOf(o), ks = myKeys(o); if (!ks.length) return null; const v = ks.map((k) => st[k]); return v.some((x) => x === "pending") ? "pending" : v.some((x) => x === "ready") ? "ready" : "served"; };
const forMe = (o) => station === "all" || (o.items || []).some((l) => (l.station || "kitchen") === station);
let known = null; // ids already announced (hub mode)
function announce() {
  if (!hub()) return;
  const ids = orders.filter((o) => kitchenSees(o) && myLevel(o) === "pending").map((o) => o.id);
  if (known && prefs.sound && ids.some((id) => !known.has(id))) { if (prefs.ring) startRinging(prefs.volume); else chime(prefs.volume); }
  known = new Set([...(known || []), ...ids]);
} // card turns red past this many minutes without being ready

onAuthStateChanged(auth, async (user) => {
  if (!user || user.isAnonymous) { if (await deviceSignIn()) return; return showDeviceSetup("/kitchen/"); }
  const claims = (await user.getIdTokenResult(true)).claims;
  if (!claims.storeId) return location.replace("/app/");
  if (claims.role === "owner") ownerOnStaffBanner();
  storeId = claims.storeId;
  onSnapshot(doc(db, "stores", storeId), async (s) => {
    const first = !store;
    store = { id: storeId, ...s.data() }; setShell({ app: station === "barista" ? "Barista" : station === "counter" ? "Counter" : "Kitchen", mode: store.mode });
    flow = FLOW[store.mode] || FLOW.table;
    if (first) {
      watchFeatures(store.slug);
      if (station !== "counter") await requireFeature(store.slug, "stations", station === "barista" ? "The Barista screen" : "The Kitchen screen");
      await tapToStart("Tap to open Kitchen");
      me = getActiveStaff(storeId) || (await pinGate({ storeId, storeName: store.name, requireRoles: ["kitchen", "barista", "crew"], screenName: "Kitchen screen" }));
      pickStationForMe();
      boot();
    } else drawHead();
  });
});

async function switchUser() {
  clearActiveStaff(storeId);
  stopRinging();
  me = await pinGate({ storeId, storeName: store.name, requireRoles: ["kitchen", "barista", "crew"], screenName: "Kitchen screen" });
  pickStationForMe();
  startRequestsWatch();
  drawHead(); drawBoard();
}

function boot() {
  app.innerHTML = `<div><div id="head"></div><div class="k-remind">📱 Keep this app open and don't lock the screen so you can hear new orders.</div><div id="paused" class="k-paused hidden">⏸ PAUSED — not accepting new orders</div><div id="board" class="k-board"></div></div>`;
  drawHead();
  onSnapshot(query(collection(db, "stores", storeId, "orders"), orderBy("createdAt", "desc"), limit(150)), (snap) => {
    orders = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (hub()) announce();
    else {
      const fresh = orders.filter((o) => o.status === flow[0][0] && forMe(o)).map((o) => o.id);
      if (seen && prefs.sound && fresh.some((id) => !seen.has(id))) { if (prefs.ring) startRinging(prefs.volume); else chime(prefs.volume); }
      if (!fresh.length) stopRinging();
    }
    seen = new Set(orders.map((o) => o.id));
    drawBoard();
    checkScheduledWindow();
  });
  onSnapshot(query(collection(db, "stores", storeId, "items"), orderBy("sortOrder")), (snap) => {
    items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (document.querySelector("#soldoutList")) drawSoldOut();
  });
  setInterval(() => { drawClock(); drawBoard(); checkScheduledWindow(); announce(); }, 30000);
  // hub mode ringtone: stops when someone touches the screen
  document.addEventListener("pointerdown", () => { if (hub()) stopRinging(); }, true);
  watchOpenShift(storeId, (sh) => { openShift = sh; drawHead(); });
  mountStaffNotes(storeId);
  startRequestsWatch();
  if (feat("duty")) { startDuty(storeId, me, station === "barista" ? "barista" : "kitchen"); watchDuty(storeId, (l) => { dutyList = l; drawDuty(); if (view === "requests") drawRequests(); }); }
  // barista: chime every 5 s while a drink ticket hasn't been acknowledged ("Got it")
  setInterval(() => {
    if (!hub() || !prefs.sound || !["barista", "all"].includes(station) || !(me?.roles || []).some((r) => ["barista", "manager"].includes(r))) return;
    if (orders.some((o) => o.status === "preparing" && stationsOf(o).barista === "pending" && !o.barista?.ack)) chime(prefs.volume);
  }, 5000);
}
let dutyList = null;
function drawDuty() {
  let el = document.getElementById("dutyBar");
  if (!el) { el = document.createElement("div"); el.id = "dutyBar"; document.getElementById("head")?.after(el); }
  el.innerHTML = dutyList ? dutyBoardHTML(dutyList, { needBarista: items.some((i) => i.station === "barista") || orders.some((o) => stationsOf(o).barista), needRider: !!store.settings?.service?.delivery && feat("delivery") }) : "";
}

function canSeeRequests() {
  const roles = me?.roles || [];
  return store.settings?.callStaff?.enabled && feat("callstaff") && (roles.includes("manager") || roles.includes("crew") || store.settings?.callStaff?.showToKitchen);
}
function startRequestsWatch() {
  reqUnsub?.(); reqUnsub = null;
  if (!canSeeRequests()) { requests = []; openReq = 0; return; }
  reqUnsub = watchRequests(storeId, { sound: true, me, onChange: (rows, n) => { requests = rows; openReq = n; drawHead(); if (view === "requests") drawRequests(); } });
}
function drawRequests() {
  const board = document.getElementById("board");
  if (!board) return;
  board.className = "k-reqwrap";
  renderRequests(board, { storeId, me, rows: requests, isManager: (me?.roles || []).includes("manager"), currency: store.settings?.currency, duty: feat("duty") ? dutyList : null });
}

// ---------------- header ----------------
function drawHead() {
  const head = document.getElementById("head");
  const paused = store.settings?.acceptOrders === false;
  const preset = PRESETS[store.businessType] || PRESETS.cafe;
  head.innerHTML = `<header class="k-head">
    ${store.logoUrl ? `<img src="${esc(store.logoUrl)}" alt="" style="width:34px;height:34px;border-radius:8px;object-fit:cover"/>` : ""}<span class="name">${esc(store.name)}</span>
    <span class="clock" id="clock"></span>
    <span class="k-stations">${allowedStations(me?.roles).map((st) => `<button data-st="${st}" class="${station === st ? "on" : ""}">${st === "all" ? "All" : STATIONS[st][0] + " " + STATIONS[st][1]}</button>`).join("")}</span>
    <span class="sp"></span>
    <span class="stat"><span>Today <b id="stToday">0</b></span><span>Done <b id="stDone">0</b></span></span>
    ${hub() ? `<span class="k-btn sm k-status ${paused ? "paused" : store.settings?.kitchen?.status === "busy" ? "busy" : ""}" title="Set at the Counter">${paused ? "⏸ Paused" : store.settings?.kitchen?.status === "busy" ? `🟠 Busy · ${store.settings?.service?.busyPrep || 35}m` : "🟢 Normal"}</span>` : `<button class="k-btn sm ${paused ? "on" : ""}" id="pauseBtn">${paused ? "▶ Resume orders" : "⏸ Pause orders"}</button>`}
    <button class="k-btn sm" id="soldBtn">${preset.labels.items === "Menu" ? "🍳 Sold out" : "Availability"}</button>
    ${canSeeRequests() ? `<button class="k-btn sm ${view === "requests" ? "primary" : ""}" id="reqBtn">🔔 Requests${openReq ? ` <span class="k-badge">${openReq}</span>` : ""}</button>` : ""}
    ${(() => { const fm = (Number(store.settings?.service?.fireBeforeMin) || 30) * 60000; const n = orders.filter((o) => o.scheduledAt && o.status === flow[0][0] && o.scheduledAt.toMillis() - Date.now() > fm).length; return n ? `<button class="k-btn sm" id="schedBtn">⏰ Scheduled (${n})</button>` : ""; })()}
    ${feat("shifts") ? `<button class="k-btn sm ${openShift ? "" : "danger"}" id="sumBtn">${openShift ? (openShift.status === "needs_count" ? "🌙 Count cash" : openShift.status !== "open" ? "⚠️ Shift check" : "📊 Shift") : "▶ Start shift"}</button>` : ""}
    <button class="k-btn sm" id="soundBtn" title="Sound settings">${prefs.sound ? (prefs.ring ? "🔔 Ring" : "🔔") : "🔕"}</button>
    <button class="k-btn sm" id="userBtn" title="Switch user">👤 ${esc(me?.name || "")}${me?.roles?.length ? ` <span class="k-tag">${esc(roleLabel(me.roles[0]))}</span>` : ""}</button>
  </header>`;
  document.getElementById("paused").classList.toggle("hidden", !paused);
  drawClock();
  if (head.querySelector("#pauseBtn")) head.querySelector("#pauseBtn").onclick = async () => { try { await call("setAcceptOrders", { accept: paused }); } catch (e) { alert(e.message); } };
  head.querySelector("#soldBtn").onclick = openSoldOut;
  head.querySelector("#sumBtn")?.addEventListener("click", openShiftPanel);
  head.querySelector("#schedBtn")?.addEventListener("click", () => {
    const fireMs = (Number(store.settings?.service?.fireBeforeMin) || 30) * 60000;
    const list = orders.filter((o) => o.scheduledAt && o.scheduledAt.toMillis() - Date.now() > fireMs && o.status === flow[0][0]).sort((a, b) => a.scheduledAt.toMillis() - b.scheduledAt.toMillis());
    const el = html(`<div><p class="muted small">Appears in the New column ${store.settings?.service?.fireBeforeMin || 30} min before the scheduled time.</p>${list.map((o) => `<div class="k-item" style="display:block"><b>#${o.orderNo} · ${o.scheduledAt.toDate().toLocaleString("en-PH", { weekday: "short", hour: "numeric", minute: "2-digit" })}</b> · ${o.serviceType === "delivery" ? "🛵 Delivery" : "🛍️ Pickup"} · ${esc(o.customer?.name || "")}<div class="cat">${o.items.map((l) => `${l.qty}× ${esc(l.name)}`).join(", ")}</div></div>`).join("") || `<p class="muted">None.</p>`}</div>`);
    openDrawer("Scheduled orders", el);
  });
  head.querySelector("#reqBtn")?.addEventListener("click", () => { view = view === "requests" ? "board" : "requests"; drawHead(); if (view === "requests") drawRequests(); else { document.getElementById("board").className = "k-board"; drawBoard(); } });
  head.querySelectorAll("[data-st]").forEach((b) => (b.onclick = () => { station = b.dataset.st; localStorage.setItem("orderqr:station", station); setShell({ app: station === "barista" ? "Barista" : station === "counter" ? "Counter" : "Kitchen" }); drawHead(); drawBoard(); }));
  head.querySelector("#soundBtn").onclick = openSoundSettings;
  head.querySelector("#userBtn").onclick = switchUser;
  updateStats();
}
let firedIds = new Set();
function checkScheduledWindow() {
  // when a scheduled order enters the "fire before" window → sound + shows in New
  const fireMs = (Number(store.settings?.service?.fireBeforeMin) || 30) * 60000;
  orders.filter((o) => o.scheduledAt && o.status === flow[0][0]).forEach((o) => {
    const inWindow = o.scheduledAt.toMillis() - Date.now() <= fireMs;
    if (inWindow && !firedIds.has(o.id)) { firedIds.add(o.id); if (seen && prefs.sound && !hub()) chime(prefs.volume); }
  });
}
function drawClock() { const c = document.getElementById("clock"); if (c) c.textContent = new Date().toLocaleTimeString("en-PH", { hour: "2-digit", minute: "2-digit" }); }
function updateStats() {
  const t = document.getElementById("stToday"), d = document.getElementById("stDone");
  if (!t) return;
  const today = todays();
  t.textContent = today.length;
  d.textContent = today.filter((o) => o.status === flow[flow.length - 1][0]).length;
}
const dayKey = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
const todays = () => orders.filter((o) => o.dayKey === dayKey());

// ---------------- board ----------------
function drawBoard() {
  const board = document.getElementById("board");
  if (!board || view === "requests") return;
  const [s0, s1, s2] = flow; // new, preparing, ready
  const fireMs = (Number(store.settings?.service?.fireBeforeMin) || 30) * 60000;
  const isFuture = (o) => o.scheduledAt && o.scheduledAt.toMillis() - Date.now() > fireMs && o.status === s0[0];
  const scheduled = orders.filter(isFuture);
  const mine = (o) => !isFuture(o) && (station === "all" || (o.items || []).some((l) => (l.station || "kitchen") === station));
  const stState = (o) => (station === "all" ? null : o.stations?.[station] || "pending");
  if (hub()) {
    const act = orders.filter((o) => kitchenSees(o) && myLevel(o) && myLevel(o) !== "served");
    const readyTitle = station === "kitchen" && dispatchOn(store) ? "Cooked — at Dispatch" : station === "all" ? s2[1] : `${STATIONS[station][1]} — ${s2[1]}`;
    const hcols = [["prep", station === "all" ? s1[1] : `${STATIONS[station][1]} — ${s1[1]}`, act.filter((o) => myLevel(o) === "pending")], ["ready", readyTitle, act.filter((o) => myLevel(o) === "ready")]];
    board.innerHTML = "";
    const waiting = orders.filter((o) => o.status === "pending" && !o.acceptedAt).length;
    if (waiting) board.appendChild(html(`<div class="k-empty" style="grid-column:1/-1;padding:8px">🧾 ${waiting} new order${waiting > 1 ? "s" : ""} waiting for the counter to accept</div>`));
    for (const [cls, title, rows] of hcols) {
      rows.sort((a, b) => ((a.acceptedAt || a.createdAt)?.toMillis?.() || 0) - ((b.acceptedAt || b.createdAt)?.toMillis?.() || 0));
      const col = html(`<section class="k-col ${cls}"><h2>${esc(title)}<span class="n">${rows.length}</span></h2></section>`);
      if (!rows.length) col.appendChild(html(`<div class="k-empty">—</div>`));
      rows.forEach((o) => col.appendChild(card(o, cls)));
      board.appendChild(col);
    }
    return updateStats();
  }
  const active = orders.filter((o) => mine(o) && [s0[0], s1[0], s2[0]].includes(o.status));
  const cols = station === "all"
    ? [["new", s0[1], active.filter((o) => o.status === s0[0])], ["prep", s1[1], active.filter((o) => o.status === s1[0])], ["ready", s2[1], active.filter((o) => o.status === s2[0])]]
    : [["new", s0[1], active.filter((o) => o.status === s0[0])],
       ["prep", `${STATIONS[station][1]} — ${s1[1]}`, active.filter((o) => o.status !== s0[0] && stState(o) !== "ready")],
       ["ready", `${STATIONS[station][1]} — ${s2[1]}`, active.filter((o) => o.status !== s0[0] && stState(o) === "ready")]];
  board.innerHTML = "";
  for (const [cls, title, rows] of cols) {
    rows.sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0));
    const col = html(`<section class="k-col ${cls}"><h2>${esc(title)}<span class="n">${rows.length}</span></h2></section>`);
    if (!rows.length) col.appendChild(html(`<div class="k-empty">—</div>`));
    rows.forEach((o) => col.appendChild(card(o, cls)));
    board.appendChild(col);
  }
  updateStats();
}

function card(o, cls) {
  const t = (hub() && o.acceptedAt?.toDate ? o.acceptedAt : o.createdAt)?.toDate?.();
  const mins = t ? Math.floor((Date.now() - t) / 60000) : 0;
  const late = cls !== "ready" && (o.etaMinutes ? mins > o.etaMinutes : mins > LATE_MIN);
  const idx = flow.findIndex((f) => f[0] === o.status);
  const next = flow[idx + 1];
  const sched = o.scheduledAt?.toDate?.();
  const el = html(`<article class="k-card ${late ? "late" : ""}">
    ${o.reservationCode ? `<div class="k-sched">📅 ${esc(o.reservationCode)} · ${sched ? sched.toLocaleString("en-PH", { weekday: "short", hour: "numeric", minute: "2-digit" }) : ""}</div>` : sched ? `<div class="k-sched">⏰ ${o.serviceType === "delivery" ? "Delivery" : "Pickup"} ${sched.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}</div>` : ""}
    <div class="top">
      <div><div class="no">#${o.orderNo}${o.test ? ` <span class="k-tag test">TEST</span>` : ""}</div><div class="where">${o.tableLabel ? esc(o.tableLabel) : esc(SVC[o.serviceType] || "")}${o.tableLabel ? `<span class="k-tag">${esc(SVC[o.serviceType] || "")}</span>` : ""}${o.customer?.name && !o.tableLabel ? ` · ${esc(o.customer.name)}` : ""}${o.paid ? `<span class="k-tag paid">Paid</span>` : ""}</div></div>
      <div class="time ${late ? "late" : ""}">${mins} min${o.etaMinutes ? `<span class="eta">ETA ${o.etaMinutes}</span>` : ""}</div>
    </div>
    ${orderTagsHTML(o, store.settings?.currency)}
    ${o.note ? `<div class="onote">“${esc(o.note)}”</div>` : ""}
    <ul>${o.items.map((l) => { const ls = l.station || "kitchen"; const other = station !== "all" && ls !== station; return `<li class="${other ? "other" : ""}"><span class="q">${l.qty}×</span><span>${esc(l.name)}${station === "all" && o.stations && Object.keys(o.stations).length > 1 ? ` <span class="k-tag">${STATIONS[ls]?.[0] || ""}</span>` : ""}${l.choices?.length ? `<span class="opt">${l.choices.map((c) => esc(c.label)).join(", ")}</span>` : ""}${l.note ? `<span class="note">“${esc(l.note)}”</span>` : ""}</span></li>`; }).join("")}</ul>
    ${o.stations && Object.keys(o.stations).length > 1 ? `<div class="k-stbar">${Object.entries(o.stations).map(([k, v]) => `<span class="${v === "ready" ? "ok" : ""}">${STATIONS[k]?.[0] || ""} ${STATIONS[k]?.[1] || k}: ${v === "ready" ? "ready" : "…"}</span>`).join("")}</div>` : ""}
    <div class="acts"></div>
  </article>`);
  const acts = el.querySelector(".acts");
  const set = (patch) => updateDoc(doc(db, "stores", storeId, "orders", o.id), { ...patch, staffId: me?.staffId || null, updatedAt: serverTimestamp() }).catch((e) => alert(e.message));

  if (hub()) { hubActions(o, cls, acts, set); return el; }
  if (printCfg(store).enabled && printCfg(store).kitchenTicket) { const kt = html(`<button class="k-btn sm" title="Print kitchen ticket">🖨</button>`); kt.onclick = () => printKitchenTicket(store, o, station === "all" ? "" : station); acts.appendChild(kt); }
  if (cls === "new") {
    if (store.mode === "table") {
      acts.innerHTML = `<div class="k-etas" style="width:100%">${[5, 10, 15, 20, 30].map((m) => `<button data-m="${m}">${m}<br><small>min</small></button>`).join("")}</div>`;
      acts.querySelectorAll("[data-m]").forEach((b) => (b.onclick = () => set({ status: next[0], etaMinutes: Number(b.dataset.m), acceptedAt: serverTimestamp() })));
    } else {
      const b = html(`<button class="k-btn prep">Accept</button>`); b.onclick = () => set({ status: next[0], acceptedAt: serverTimestamp() }); acts.appendChild(b);
    }
  } else if (cls === "prep") {
    const b = html(`<button class="k-btn ready">✓ ${station === "all" ? "Ready" : STATIONS[station][1] + " ready"}</button>`);
    b.onclick = () => {
      const stations = { ...(o.stations || {}) };
      if (station === "all") Object.keys(stations).forEach((k) => (stations[k] = "ready"));
      else stations[station] = "ready";
      const allReady = !Object.keys(stations).length || Object.values(stations).every((v) => v === "ready");
      set(allReady ? { status: hub() ? "ready" : next[0], stations, readyAt: serverTimestamp() } : { stations });
    };
    acts.appendChild(b);
  } else if (station !== "all" && o.status !== flow[2][0]) {
    // this station is ready but other stations are still pending
    acts.appendChild(html(`<span class="muted small">Waiting for ${Object.entries(o.stations || {}).filter(([, v]) => v !== "ready").map(([k]) => STATIONS[k]?.[1] || k).join(", ")}…</span>`));
  } else if (o.serviceType === "delivery") {
    acts.appendChild(html(`<span class="muted small">🛵 Waiting for rider…</span>`));
  } else {
    const b = html(`<button class="k-btn primary">${o.serviceType === "pickup" ? "Picked up" : "Done"}</button>`); b.onclick = () => set({ status: next[0], completedAt: serverTimestamp() }); acts.appendChild(b);
  }
  if (!o.paid || (me?.roles || []).includes("manager")) {
    const x = html(`<button class="k-btn danger" title="Cancel">✕</button>`);
    x.onclick = () => { const reason = prompt(`Cancel order #${o.orderNo}? Reason (visible to customer):`, "Sold out"); if (reason) orderOp(storeId, "cancel", { orderId: o.id, reason }).catch((e) => alert(e.message)); };
    acts.appendChild(x);
  }
  return el;
}

// hub mode buttons: Cooked → Dispatch (kitchen) · Ready → Served (barista/counter)
function hubActions(o, cls, acts, set) {
  const ks = myKeys(o), disp = dispatchOn(store), packed = PACKED(o);
  const label = station === "kitchen" ? (disp ? "✓ Cooked → Dispatch" : "✓ Cooked") : station === "all" ? "✓ Ready" : `✓ ${STATIONS[station][1]} ready`;
  // barista: "👍 Got it" stops the repeating chime for this ticket
  if (cls === "prep" && ks.includes("barista") && station !== "kitchen" && stationsOf(o).barista === "pending" && !o.barista?.ack) {
    const g = html(`<button class="k-btn primary">👍 Got it</button>`);
    g.onclick = () => set({ barista: { ack: true, by: me?.name || "Barista", at: Date.now() } });
    acts.appendChild(g);
  } else if (o.barista?.ack && ks.includes("barista")) acts.appendChild(html(`<span class="small muted">🍹 Making · ${esc(o.barista.by || "")}</span>`));
  if (cls === "prep") {
    const b = html(`<button class="k-btn ready">${label}</button>`);
    b.onclick = () => set(stationPatch(o, ks.filter((k) => stationsOf(o)[k] === "pending"), "ready", store));
    acts.appendChild(b);
  } else {
    const kitchenAtDispatch = disp && ks.includes("kitchen");
    if (packed && disp) acts.appendChild(html(`<span class="muted small">📦 Dispatch packs this ${o.serviceType === "delivery" ? "delivery" : o.serviceType === "pickup" ? "pickup" : "take-out"} order</span>`));
    else if (station === "kitchen" && disp) acts.appendChild(html(`<span class="muted small">📋 At Dispatch — plating check</span>`));
    else if (packed) acts.appendChild(html(`<span class="muted small">${o.serviceType === "delivery" ? "🛵 Waiting for rider" : "🛍️ Waiting for pickup"} — Counter hands it over</span>`));
    else {
      const keys = ks.filter((k) => !(kitchenAtDispatch && k === "kitchen"));
      const b = html(`<button class="k-btn primary">🚶 Served</button>`);
      b.onclick = () => set(stationPatch(o, keys, "served", store));
      acts.appendChild(b);
      if (kitchenAtDispatch) acts.appendChild(html(`<span class="muted small">Food: at Dispatch</span>`));
    }
  }
  if (!o.paid || (me?.roles || []).includes("manager")) {
    const x = html(`<button class="k-btn danger" title="Cancel">✕</button>`);
    x.onclick = () => { const reason = prompt(`Cancel order #${o.orderNo}? Reason (visible to customer):`, "Sold out"); if (reason) orderOp(storeId, "cancel", { orderId: o.id, reason }).catch((e) => alert(e.message)); };
    acts.appendChild(x);
  }
}

// ---------------- sold out drawer ----------------
function openDrawer(title, bodyEl) {
  closeDrawer();
  const w = html(`<div class="k-drawer-wrap"><div class="k-drawer"><div class="hd"><h3>${esc(title)}</h3><button class="x">×</button></div><div class="bd"></div></div></div>`);
  w.querySelector(".bd").appendChild(bodyEl);
  w.querySelector(".x").onclick = closeDrawer;
  w.addEventListener("click", (e) => e.target === w && closeDrawer());
  document.body.appendChild(w);
}
function closeDrawer() { document.querySelector(".k-drawer-wrap")?.remove(); }

function openSoldOut() {
  const el = html(`<div><p class="muted small">Turn an item off when it's sold out. It shows “Sold out” on the customer menu right away. Pick a “back at” time and it comes back by itself.</p><input class="k-input" id="soldQ" placeholder="Search…" style="margin-bottom:8px"/><div id="soldoutList"></div></div>`);
  openDrawer("Availability", el);
  el.querySelector("#soldQ").oninput = () => drawSoldOut();
  drawSoldOut();
}
const fmtBack = (ms) => new Date(ms).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" });
function drawSoldOut() {
  const list = document.getElementById("soldoutList");
  if (!list) return;
  const q = (document.getElementById("soldQ")?.value || "").toLowerCase();
  list.innerHTML = "";
  const rows = items.filter((it) => !q || it.name.toLowerCase().includes(q)).sort((a, b) => (a.available === false ? 0 : 1) - (b.available === false ? 0 : 1));
  rows.forEach((it) => {
    const back = it.available === false && Number(it.soldUntil) > Date.now() ? Number(it.soldUntil) : 0;
    const row = html(`<div class="k-item ${it.available === false ? "out" : ""}"><span>${esc(it.name)}<span class="cat">${it.available === false ? (back ? `⛔ Sold out · back at ${fmtBack(back)}` : "⛔ Sold out") : money(it.price, store.settings?.currency)}</span></span>
      ${it.available === false ? `<select class="k-input sm" data-back style="max-width:130px"><option value="">Back at…</option>${Array.from({ length: 28 }, (_, i) => { const t = new Date(Math.ceil(Date.now() / 1800000) * 1800000 + i * 1800000); return `<option value="${t.getTime()}" ${back === t.getTime() ? "selected" : ""}>${fmtBack(t.getTime())}</option>`; }).join("")}</select>` : ""}
      <label class="k-sw"><input type="checkbox" ${it.available !== false ? "checked" : ""}/><span></span></label></div>`);
    row.querySelector("input[type=checkbox]").onchange = (e) => updateDoc(doc(db, "stores", storeId, "items", it.id), { available: e.target.checked, soldUntil: null, updatedAt: serverTimestamp() }).catch((err) => alert(err.message));
    row.querySelector("[data-back]")?.addEventListener("change", (e) => updateDoc(doc(db, "stores", storeId, "items", it.id), { soldUntil: e.target.value ? Number(e.target.value) : null, updatedAt: serverTimestamp() }).catch((err) => alert(err.message)));
    list.appendChild(row);
  });
}

// ---------------- sound settings ----------------
function openSoundSettings() {
  const el = html(`<div>
    <div class="k-item"><span>Sound on new orders</span><label class="k-sw"><input type="checkbox" data-s ${prefs.sound ? "checked" : ""}/><span></span></label></div>
    <div class="k-item"><span>Ringtone mode<span class="cat">${hub() ? "Repeats until someone touches the screen" : "Repeats until the order is accepted"}</span></span><label class="k-sw"><input type="checkbox" data-r ${prefs.ring ? "checked" : ""}/><span></span></label></div>
    <div class="k-item" style="display:block"><span>Volume</span><input type="range" min="0.05" max="1" step="0.05" value="${prefs.volume}" data-v style="width:100%;margin-top:8px"/></div>
    <button class="k-btn" data-test style="margin-top:12px">🔔 Test sound</button>
    <p class="muted small" style="margin-top:16px">Reminder: on a phone/tablet, <b>this app must stay open</b> and the screen must not be locked. The app tries to keep the screen awake (Android/Chrome). On iPhone: Settings → Display → Auto-Lock → Never.</p>
    <button class="k-btn danger" data-out style="margin-top:16px">Log out device</button>
  </div>`);
  el.querySelector("[data-s]").onchange = (e) => { prefs.sound = e.target.checked; savePrefs(); drawHead(); if (!prefs.sound) stopRinging(); };
  el.querySelector("[data-r]").onchange = (e) => { prefs.ring = e.target.checked; savePrefs(); drawHead(); };
  el.querySelector("[data-v]").oninput = (e) => { prefs.volume = Number(e.target.value); savePrefs(); };
  el.querySelector("[data-test]").onclick = () => chime(prefs.volume);
  el.querySelector("[data-out]").onclick = () => { if (confirm("Log out this device? The owner email will be needed to sign in again.")) { clearActiveStaff(storeId); signOut(auth); } };
  openDrawer("Sound & device", el);
}

// ---------------- shift panel: start / live summary / end ----------------
const doneKey = () => flow[flow.length - 1][0];
async function openShiftPanel() {
  if (!openShift) {
    const el = html(`<div>
      <p class="muted">Start a shift to track sales and cash.</p>
      <label>Starting cash in drawer (₱)</label><input type="number" min="0" data-cash value="0" class="k-input"/>
      <label>Note (optional)</label><input data-note class="k-input" placeholder="e.g. AM shift"/>
      <button class="k-btn primary" data-go style="margin-top:14px;width:100%">▶ Start shift as ${esc(me?.name || "staff")}</button>
    </div>`);
    el.querySelector("[data-go]").onclick = async () => { await startShift(storeId, me, el.querySelector("[data-cash]").value, el.querySelector("[data-note]").value.trim()); closeDrawer(); };
    return openDrawer("Start shift", el);
  }
  if (!["open", "needs_count"].includes(openShift.status)) { const el = verifyShiftPanel({ storeId, me, shift: openShift, store, currency: store.settings?.currency, onDone: () => { closeDrawer(); } }); return openDrawer("Shift check", el); }
  const el = html(`<div><p class="muted">Loading…</p></div>`);
  openDrawer("Shift", el);
  const tally = await computeShiftTally(storeId, openShift, doneKey());
  const opened = openShift.openedAt?.toDate?.();
  const blind = true; // always a blind count
  el.innerHTML = `${openShift.status === "needs_count" ? `<div class="k-note" style="margin-bottom:10px">🌙 This shift ended automatically (${esc(openShift.closedByName || "")}). Count the cash now — a new shift can start after the count is checked.</div>` : ""}<p class="muted small">Started ${opened ? opened.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" }) : ""} by ${esc(openShift.openedByName || "")}${openShift.note ? " · " + esc(openShift.note) : ""}</p>
    ${blind ? `<div class="k-sum"><div class="box"><div class="k">Orders</div><div class="v">${tally.orders}</div></div><div class="box"><div class="k">Completed / Cancelled</div><div class="v">${tally.completed} / ${tally.cancelled}</div></div>${tally.avgPrepMin != null ? `<div class="box"><div class="k">Avg. prep time</div><div class="v">${tally.avgPrepMin} min</div></div>` : ""}</div><p class="muted small">Sales and cash totals are hidden (blind count).</p>` : tallyHTML(openShift, tally, store.settings?.currency)}
    <div style="margin-top:18px;border-top:1px solid var(--line);padding-top:14px"><h3 style="margin:0 0 6px">End shift</h3><div data-close></div></div>`;
  if ((me?.roles || []).some((r) => ["manager", "crew"].includes(r))) el.querySelector("[data-close]").appendChild(closeShiftForm({ storeId, me, shift: openShift, tally, store, currency: store.settings?.currency, onDone: (r) => { closeDrawer(); alert(r.auto ? "Shift closed — counts within tolerance ✓" : "Count submitted. A manager needs to verify this shift (Shift button)."); } }));
  else el.querySelector("[data-close]").innerHTML = `<p class="muted small">Only crew or managers can end a shift.</p>`;
}
