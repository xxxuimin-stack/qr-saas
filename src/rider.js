// Rider app: /rider/ — for the rider's phone. Ready deliveries → pick up → maps/call → delivered + cash.
import { msgrBtn } from "./msgr.js";
import { applyWording } from "./wording.js";
import { orderOp } from "./orderops.js";
import { setShell } from "./appshell.js";
import { auth, db, call } from "./firebase.js";
import { deviceSignIn, showDeviceSetup, ownerOnStaffBanner } from "./device.js";
import { onAuthStateChanged } from "firebase/auth";
import { collection, doc, onSnapshot, query, orderBy, limit, updateDoc, serverTimestamp, writeBatch, arrayUnion, where, Timestamp } from "firebase/firestore";
import { pinGate, requireFeature, getActiveStaff, clearActiveStaff, tapToStart, chime, startDuty, setDutyState, watchDuty, endDuty } from "./staffauth.js";
import { mountStaffNotes } from "./staffpanels.js";
import { mapsHref } from "./contact.js";
import { uploadPrivateImage } from "./upload.js";
import { pushButton, refreshPush, setBadge } from "./pushclient.js";
import { watchMaintenance } from "./maint.js";
watchMaintenance("staff");

const app = document.getElementById("app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const html = (str) => { const t = document.createElement("template"); t.innerHTML = str.trim(); return t.content.firstElementChild; };
let CUR = "PHP";
const money = (n) => (CUR === "PHP" ? "₱" : CUR + " ") + Number(n || 0).toLocaleString("en-PH", { maximumFractionDigits: 2 });
let escorts = [], seenPickup = null;
let storeId, store, me, orders = [], seen = null, tab = "ready", picked = new Set(), duty = [], returning = false;

onAuthStateChanged(auth, async (user) => {
  if (!user || user.isAnonymous) { if (await deviceSignIn()) return; return showDeviceSetup("/rider/"); }
  const claims = (await user.getIdTokenResult(true)).claims;
  if (!claims.storeId) return location.replace("/app/");
  if (claims.role === "owner") ownerOnStaffBanner();
  storeId = claims.storeId;
  onSnapshot(doc(db, "stores", storeId), async (s) => {
    const first = !store;
    store = { id: storeId, ...s.data() }; applyWording(store); setShell({ app: store.mode === "laundry" ? "Pickup & delivery" : "Rider", mode: store.mode }); CUR = store.settings?.currency || "PHP";
    if (first) {
      await requireFeature(store.slug, "delivery", "The Rider app");
      await tapToStart("Tap to open Rider app");
      me = getActiveStaff(storeId) || (await pinGate({ storeId, storeName: store.name, requireRoles: ["rider"], screenName: "Rider" }));
      boot();
    }
  });
});

function boot() {
  app.innerHTML = `<div><div id="head"></div><div id="main" class="r-main"></div><div id="tripBar"></div></div>`;
  mountStaffNotes(storeId);
  startDuty(storeId, me, "rider", () => ({ delivering: myTrip().length > 0, returning }));
  watchDuty(storeId, (l) => { duty = l; draw(); });
  refreshPush(storeId, "rider");
  if (store.mode === "salon") {
    const t0 = new Date(); t0.setHours(0, 0, 0, 0);
    onSnapshot(query(collection(db, "stores", storeId, "appointments"), where("startAt", ">=", Timestamp.fromDate(new Date(t0.getTime() - 86400e3))), orderBy("startAt"), limit(200)), (snap) => {
      escorts = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((a) => a.escort && a.homeService && !["cancelled", "no_show"].includes(a.status) && !["back", "released"].includes(a.escort.status) && (!a.escort.riderId || a.escort.riderId === me?.staffId));
      const wait = escorts.filter((a) => a.escort.status === "pickup_requested").map((a) => a.id);
      if (seenPickup && wait.some((id) => !seenPickup.has(id))) { chime(0.5); try { navigator.vibrate?.([300, 120, 300]); } catch {} }
      seenPickup = new Set(wait);
      draw();
    }, (e) => console.warn("escorts", e));
  }
  onSnapshot(query(collection(db, "stores", storeId, "orders"), orderBy("createdAt", "desc"), limit(150)), (snap) => {
    orders = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((o) => o.serviceType === "delivery" || (o.type === "laundry" && ["rider_rider", "rider_pickup"].includes(o.laundry?.mode)));
    const ready = orders.filter((o) => o.status === "ready" || isPickupJob(o)).map((o) => o.id);
    if (seen && ready.some((id) => !seen.has(id))) chime(0.35);
    seen = new Set(ready);
    draw();
  });
}

const myTrip = () => orders.filter((o) => o.status === "out_for_delivery" && o.riderId === me?.staffId);
const isPickupJob = (o) => o.type === "laundry" && o.status === "booked" && ["rider_rider", "rider_pickup"].includes(o.laundry?.mode);
const deliverable = (o) => o.type !== "laundry" || ["rider_rider", "dropoff_delivery"].includes(o.laundry?.mode);
function draw() {
  const ready = orders.filter((o) => ((o.status === "ready" && deliverable(o)) || isPickupJob(o)) && !(o.passedBy || []).includes(me?.staffId));
  const mine = orders.filter((o) => (o.status === "out_for_delivery" || o.status === "picking_up") && (o.riderId === me?.staffId || !o.riderId));
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const done = orders.filter((o) => (o.status === "delivered" || (o.type === "laundry" && ["received", "claimed"].includes(o.status) && o.riderId === me?.staffId)) && o.riderId === me?.staffId && o.dayKey === today);
  const cash = done.reduce((a, o) => a + (o.cashCollected || 0), 0);
  document.getElementById("head").innerHTML = `<header class="k-head" style="flex-wrap:wrap">
    <span class="name">🛵 ${esc(store.name)}</span><span class="sp"></span>
    <button class="k-btn sm" id="userBtn">👤 ${esc(me?.name || "")}</button>
    <span class="k-stations" style="width:100%;margin-top:6px">
      <button data-t="ready" class="${tab === "ready" ? "on" : ""}">${store.mode === "laundry" ? "To do" : "Ready"} ${ready.length ? `<span class="k-badge">${ready.length}</span>` : ""}</button>
      <button data-t="mine" class="${tab === "mine" ? "on" : ""}">On the road ${mine.length ? `<span class="k-tag">${mine.length}${mine[0]?.trip ? ` · trip ${orders.filter((x) => x.trip === mine[0].trip && x.status !== "out_for_delivery").length}/${orders.filter((x) => x.trip === mine[0].trip).length} done` : ""}</span>` : ""}</button>
      <button data-t="done" class="${tab === "done" ? "on" : ""}">Done ${done.length}</button>
    </span></header>`;
  document.querySelectorAll("[data-t]").forEach((b) => (b.onclick = () => { tab = b.dataset.t; draw(); }));
  { const pb = pushButton(storeId, "rider"); document.getElementById("userBtn").before(pb); }
  setBadge(ready.length + escorts.filter((x) => x.escort.status === "pickup_requested").length);
  document.getElementById("userBtn").onclick = async () => { endDuty(storeId, me); clearActiveStaff(storeId); me = await pinGate({ storeId, storeName: store.name, requireRoles: ["rider"], screenName: "Rider" }); draw(); };
  const main = document.getElementById("main");
  main.innerHTML = "";
  const list = tab === "ready" ? ready : tab === "mine" ? mine : done;
  if (tab === "done") main.appendChild(html(`<div class="k-sum" style="margin-bottom:12px"><div class="box"><div class="k">Deliveries today</div><div class="v">${done.length}</div></div><div class="box"><div class="k">Cash collected (to remit)</div><div class="v">${money(cash)}</div></div></div>`));
  if (!list.length && !(tab !== "done" && escorts.length)) main.appendChild(html(`<div class="k-empty">${tab === "ready" ? "No deliveries ready." : tab === "mine" ? "You have no deliveries on the road." : "Nothing yet."}</div>`));
  if (returning && !mine.length) {
    const r = html(`<div class="k-card" style="border-top-color:var(--prep)"><b>🔙 Returning to the shop</b><p class="muted small">Calls and new deliveries wait until you're back.</p><button class="k-btn primary" style="width:100%">🏠 I'm back at the shop</button></div>`);
    r.querySelector("button").onclick = () => { returning = false; setDutyState(storeId, me, { returning: false, delivering: false }); draw(); };
    main.prepend(r);
  }
  if (tab !== "done") escorts.forEach((a) => main.prepend(escortCard(a)));
  list.forEach((o) => main.appendChild(card(o)));
  // batch: take several ready deliveries in one trip
  const bar = document.getElementById("tripBar");
  const sel = ready.filter((o) => picked.has(o.id) && o.status === "ready");
  bar.innerHTML = tab === "ready" && sel.length ? `<button class="k-btn primary r-tripbtn">🛵 On the way (${sel.length})</button>` : "";
  bar.querySelector("button")?.addEventListener("click", async () => {
    const trip = "T" + Date.now().toString(36);
    const b = writeBatch(db);
    sel.forEach((o) => b.update(doc(db, "stores", storeId, "orders", o.id), { status: "out_for_delivery", riderId: me.staffId, riderName: me.name, outAt: serverTimestamp(), trip, staffId: me.staffId, updatedAt: serverTimestamp() }));
    try { await b.commit(); picked = new Set(); returning = false; setDutyState(storeId, me, { delivering: true, returning: false }); tab = "mine"; draw(); } catch (e) { alert(e.message); }
  });
}

function card(o) {
  const set = (patch) => updateDoc(doc(db, "stores", storeId, "orders", o.id), { ...patch, staffId: me?.staffId || null, updatedAt: serverTimestamp() }).catch((e) => alert(e.message));
  const addr = o.customer?.address || "";
  const el = html(`<article class="k-card" style="border-top-color:${o.status === "ready" ? "var(--ready)" : o.status === "out_for_delivery" ? "var(--prep)" : "var(--line)"}">
    <div class="top"><div><div class="no">${o.type === "laundry" ? `🧺 ${o.laundry?.ticketNo ? "#" + esc(o.laundry.ticketNo) : "J" + o.orderNo}${isPickupJob(o) || o.status === "picking_up" ? ` <span class="k-tag" style="color:var(--new)">PICKUP</span>` : ` <span class="k-tag paid">DELIVER</span>`}` : `#${o.orderNo}`}</div><div class="where">${esc(o.customer?.name || "")}${o.paid ? ` <span class="k-tag paid">Paid · ${esc(o.paymentMethod || "")}</span>` : ` <span class="k-tag" style="color:var(--new)">COLLECT ${money(o.total)}</span>`}</div></div>
      <div class="time">${o.scheduledAt ? "⏰ " + o.scheduledAt.toDate().toLocaleString("en-PH", { weekday: "short", hour: "numeric", minute: "2-digit" }) : ""}</div></div>
    <div class="r-addr">📍 ${esc(addr)}</div>
    ${o.risk?.walkouts || o.risk?.noShows || o.risk?.failed ? `<div class="r-risk">⚠️ ${[o.risk.walkouts ? `Didn't pay before ${o.risk.walkouts}×` : "", o.risk.noShows ? `No-show before ${o.risk.noShows}×` : "", o.risk.failed ? `Failed delivery before ${o.risk.failed}×` : ""].filter(Boolean).join(" · ")}</div>` : ""}
    ${o.payment ? `<div class="r-pay ${o.paid ? "ok" : ""}">${o.payment.method === "cash" ? `💵 COD · Collect <b>${money(o.total)}</b>${o.deliveryFee ? ` (incl. delivery ${money(o.deliveryFee)})` : ""}${o.payment.changeFor && o.payment.changeFor > o.total ? ` · Customer pays <b>${money(o.payment.changeFor)}</b> → change <b>${money(o.payment.changeFor - o.total)}</b>` : " · exact"}` : `📱 ${esc(o.payment.methodName)} · ${o.paid ? "verified ✓ — nothing to collect" : "⚠️ not yet verified — check with counter"}`}</div>` : ""}
    <ul>${o.items.map((l) => `<li><span class="q">${esc(l.label || l.qty + "×")}</span><span>${esc(l.name)}</span></li>`).join("")}</ul>
    ${o.type === "laundry" && (isPickupJob(o) || o.status === "picking_up") ? `<div class="small muted">Collect the laundry, note the container, bring it to the shop for weighing.${o.laundry?.handWash ? ` · 🧼 Hand wash: ${esc(o.laundry.handWash)}` : ""}</div>` : ""}
    ${o.note ? `<div class="onote">“${esc(o.note)}”</div>` : ""}
    <div class="r-links"><a class="k-btn sm" target="_blank" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}">🗺 Maps</a>${o.customer?.phone ? `<a class="k-btn sm" href="tel:${esc(o.customer.phone)}">📞 ${esc(o.customer.phone)}</a>` : ""}${msgrBtn(o.customer?.messenger, "k-btn sm")}</div>
    <div class="acts"></div></article>`);
  const acts = el.querySelector(".acts");
  if (isPickupJob(o)) { const b = html(`<button class="k-btn primary">🛵 I'll pick it up</button>`); b.onclick = () => set({ status: "picking_up", riderId: me.staffId, riderName: me.name, outAt: serverTimestamp() }); acts.appendChild(b); }
  if (o.status === "picking_up") { const b = html(`<button class="k-btn ready">✓ Picked up — bring to shop</button>`); b.onclick = () => set({ status: "received", riderId: me.staffId, riderName: me.name, "laundry.pickedUpAt": serverTimestamp() }); acts.appendChild(b); const r = html(`<button class="k-btn sm">Back to Booked</button>`); r.onclick = () => set({ status: "booked", riderId: null, riderName: null }); acts.appendChild(r); const n = (o.laundry?.proof?.photos || []).length; const ph = html(`<label class="k-btn sm" style="margin:0">📷 Photo of bag${n ? ` (${n})` : ""}<input type="file" accept="image/*" capture="environment" hidden/></label>`); ph.querySelector("input").onchange = async (e) => { const f = e.target.files?.[0]; if (!f) return; const pcs = prompt("How many pieces? (optional — leave blank to count at the shop)", o.laundry?.pcs ?? ""); try { const url = await uploadPrivateImage(store.id, auth.currentUser.uid, f, { max: 1280, name: `proof_${o.id}_${Date.now()}` }); await call("laundryProof", { orderId: o.id, add: [{ url, kind: "bag", note: "At pickup" }], pcs: pcs === null ? undefined : pcs, staffName: me.name }); } catch (x) { alert(x.message); } }; acts.appendChild(ph); }
  if (o.status === "ready") {
    if (o.deliveryFeePending) acts.appendChild(html(`<span class="small" style="color:var(--new);font-weight:700">⏳ Waiting for the counter to set the delivery fee</span>`));
    else {
      const ck = html(`<label class="r-pick"><input type="checkbox" ${picked.has(o.id) ? "checked" : ""}/> Take this delivery</label>`);
      ck.querySelector("input").onchange = (e) => { if (e.target.checked) picked.add(o.id); else picked.delete(o.id); draw(); };
      acts.appendChild(ck);
    }
    const riders = duty.filter((x) => (x.roles || []).includes("rider") && x.staffId !== me?.staffId && !(o.passedBy || []).includes(x.staffId));
    if (riders.length) { const p = html(`<button class="k-btn sm">⏭ Pass · let others deliver</button>`); p.onclick = () => { picked.delete(o.id); set({ passedBy: arrayUnion(me.staffId) }); }; acts.appendChild(p); }
    else acts.appendChild(html(`<span class="small muted">You are the only rider on duty.</span>`));
  }
  if (o.status === "out_for_delivery") {
    const ew = !o.paid && o.payment && !["cash", "card"].includes(o.payment.method);
    if (ew) acts.appendChild(html(`<span class="c-payinfo">📱 ${esc(o.payment.methodName)} ${money(o.total)} — ${o.payment.status === "to_verify" ? "customer says sent; counter hasn't confirmed yet" : "customer will send when you arrive"}. Check their screen / your store's ${esc(o.payment.methodName)}.</span>`));
    const b = html(`<button class="k-btn ready">✓ Delivered${o.paid ? "" : ew ? ` · ${esc(o.payment.methodName)} received` : " · cash " + money(o.total)}</button>`);
    b.onclick = async () => {
      if (!o.paid && !confirm(ew ? `${o.payment.methodName} ${money(o.total)} received?` : `Collected ${money(o.total)} in cash?`)) return;
      try { await orderOp(storeId, "deliver", { orderId: o.id, paidWith: ew ? "ewallet" : "cash" }); afterTripStop(o.id); } catch (e) { alert(e.message); }
    };
    acts.appendChild(b);
    if (ew) { const c = html(`<button class="k-btn sm">💵 Paid cash instead</button>`); c.onclick = async () => { if (!confirm(`Collected ${money(o.total)} in cash?`)) return; try { await orderOp(storeId, "deliver", { orderId: o.id, paidWith: "cash" }); afterTripStop(o.id); } catch (e) { alert(e.message); } }; acts.appendChild(c); }
    const ns = html(`<button class="k-btn sm danger">🚫 No-show</button>`);
    ns.onclick = async () => {
      if (!confirm("Customer can't be reached? This marks the delivery as failed and flags the customer.")) return;
      try { await orderOp(storeId, "cancel", { orderId: o.id, outcome: "failed_delivery", reason: "No-show: the customer could not be reached" }); afterTripStop(o.id); } catch (e) { alert(e.message); }
    };
    acts.appendChild(ns);
    const r = html(`<button class="k-btn sm">Back to Ready</button>`); r.onclick = () => set({ status: "ready", riderId: null, riderName: null }); acts.appendChild(r);
  }
  return el;
}

/** after the last stop of a trip → "returning to the shop" (calls stay quiet until "I'm back") */
function afterTripStop(doneId) {
  const left = myTrip().filter((x) => x.id !== doneId);
  if (!left.length) { returning = true; setDutyState(storeId, me, { delivering: false, returning: true }); }
  draw();
}

// home service drop-off & pick-up of a therapist/stylist (salon & spa)
const NEXT = { unassigned: ["to_client", "🛵 Leaving with the staff → client"], assigned: ["to_client", "🛵 Leaving with the staff → client"], to_client: ["dropped", "✓ Dropped off at the client"], dropped: ["to_pickup", "🛵 Going to pick up (early)"], pickup_requested: ["to_pickup", "🛵 On the way to pick up"], to_pickup: ["picked_up", "✓ Picked up"], picked_up: ["back", "🏠 Back at the shop"] };
const ESC_TXT = { unassigned: "Needs a rider", assigned: "Assigned to you", to_client: "On the way to the client", dropped: "Dropped off · service ongoing", pickup_requested: "⚠️ DONE — waiting for pickup", to_pickup: "On the way to pick up", picked_up: "Heading back" };
function escortCard(a) {
  const e = a.escort || {}; const hs = a.homeService || {};
  const st = a.startAt?.toDate?.(); const urgent = e.status === "pickup_requested";
  const maps = mapsHref(hs) || "";
  const el = html(`<article class="k-card" style="border-top-color:${urgent ? "var(--danger)" : "var(--new)"}">
    <div class="top"><div><div class="no">🧑‍🤝‍🧑 Staff trip <span class="k-tag" style="color:${urgent ? "var(--danger)" : "var(--new)"}">${esc(ESC_TXT[e.status] || e.status || "")}</span></div>
      <div class="where">${esc(a.providerName || "Staff")} → ${esc(a.customer?.name || "client")}</div></div>
      <div class="time">${st ? st.toLocaleString("en-PH", { weekday: "short", hour: "numeric", minute: "2-digit" }) : ""}<span class="eta">~${a.durationConfirmed || a.durationEst || 60} min</span></div></div>
    <div class="r-addr">📍 ${esc(hs.address || "")}${hs.landmark ? ` · ${esc(hs.landmark)}` : ""}${hs.area ? ` · <b>${esc(hs.area)}</b>` : ""}</div>
    ${a.helpOpen ? `<div class="r-risk">🆘 ${esc(a.providerName || "Staff")} pressed HELP — go now / call the shop</div>` : ""}
    <div class="acts"></div></article>`);
  const acts = el.querySelector(".acts");
  if (maps) acts.appendChild(html(`<a class="k-btn" target="_blank" rel="noopener" href="${esc(maps)}">🗺 Map</a>`));
  const nx = NEXT[e.status || "unassigned"];
  if (nx) { const b = html(`<button class="k-btn ${urgent ? "danger" : "primary"}">${nx[1]}</button>`); b.onclick = async () => { b.disabled = true; try { await call("apptExtras", { id: a.id, action: "escortStep", step: nx[0], staffToken: getActiveStaff(storeId)?.token || null }); } catch (x) { alert(x.message); b.disabled = false; } }; acts.appendChild(b); }
  return el;
}
