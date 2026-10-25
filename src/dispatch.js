// Dispatch screen: /dispatch/ — plating check before food goes out (café / restaurant).
// Dine-in: check every dish against its plating guide → "Ready to serve" → crew serves → "Served" (Dispatch completes the food).
// Pickup / delivery / take-out: Dispatch packs food + drinks → order Ready → Counter hands it over.
import { auth, db } from "./firebase.js";
import { deviceSignIn, showDeviceSetup, ownerOnStaffBanner } from "./device.js";
import { setShell } from "./appshell.js";
import { onAuthStateChanged } from "firebase/auth";
import { collection, doc, onSnapshot, query, orderBy, limit, updateDoc, serverTimestamp } from "firebase/firestore";
import { startDuty, feat, watchFeatures, requireFeature, pinGate, getActiveStaff, clearActiveStaff, roleLabel, tapToStart, startRinging, stopRinging, chime } from "./staffauth.js";
import { mountStaffNotes } from "./staffpanels.js";
import { stationsOf, stationPatch, atDispatch, PACKED } from "./flow.js";

const app = document.getElementById("app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const html = (str) => { const t = document.createElement("template"); t.innerHTML = str.trim(); return t.content.firstElementChild; };
const SVC = { dine_in: "🍽️ Dine-in", take_out: "🥡 Take-out", pickup: "🛍️ Pickup", delivery: "🛵 Delivery" };
const STN = { kitchen: "🍳 Food", barista: "☕ Drinks", counter: "🧾 Counter" };
const fmtT = (d) => d.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" });

let storeId, store, me, orders = [], known = null;
const checks = new Map(); // orderId -> Set of checked keys (kept on this device)
const prefs = { ring: localStorage.getItem("orderqr:dring") !== "off", volume: Number(localStorage.getItem("orderqr:dvol") || 0.5) };

onAuthStateChanged(auth, async (user) => {
  if (!user || user.isAnonymous) { if (await deviceSignIn()) return; return showDeviceSetup("/dispatch/"); }
  const claims = (await user.getIdTokenResult(true)).claims;
  if (!claims.storeId) return location.replace("/app/");
  if (claims.role === "owner") ownerOnStaffBanner();
  storeId = claims.storeId;
  onSnapshot(doc(db, "stores", storeId), async (s) => {
    const first = !store;
    store = { id: storeId, ...s.data() }; setShell({ app: "Dispatch", mode: store.mode });
    if (first) {
      watchFeatures(store.slug);
      await requireFeature(store.slug, "dispatch", "The Dispatch screen");
      await tapToStart("Tap to open Dispatch");
      me = getActiveStaff(storeId) || (await pinGate({ storeId, storeName: store.name, requireRoles: ["dispatch", "crew"], screenName: "Dispatch" }));
      boot();
    } else draw();
  });
});

function boot() {
  if (feat("duty")) startDuty(storeId, me, "dispatch");
  app.innerHTML = `<div><div id="head"></div><div class="k-remind">📋 Check every dish against its plating guide before it goes out.</div><div id="board" class="d-board"></div></div>`;
  onSnapshot(query(collection(db, "stores", storeId, "orders"), orderBy("createdAt", "desc"), limit(150)), (snap) => {
    orders = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const ids = orders.filter((o) => atDispatch(o, store)).map((o) => o.id);
    if (known && ids.some((id) => !known.has(id))) { if (prefs.ring) startRinging(prefs.volume); else chime(prefs.volume); }
    known = new Set([...(known || []), ...ids]);
    draw();
  });
  document.addEventListener("pointerdown", () => stopRinging(), true);
  setInterval(draw, 30000);
  mountStaffNotes(storeId);
}

function draw() {
  const head = document.getElementById("head"); if (!head) return;
  const list = orders.filter((o) => atDispatch(o, store)).sort((a, b) => (a.readyAt?.toMillis?.() || a.updatedAt?.toMillis?.() || 0) - (b.readyAt?.toMillis?.() || b.updatedAt?.toMillis?.() || 0));
  const cooking = orders.filter((o) => ["preparing", "pending"].includes(o.status) && o.acceptedAt && !atDispatch(o, store) && stationsOf(o).kitchen === "pending").length;
  head.innerHTML = `<header class="k-head">
    ${store.logoUrl ? `<img src="${esc(store.logoUrl)}" alt="" style="width:34px;height:34px;border-radius:8px;object-fit:cover"/>` : ""}<span class="name">📋 Dispatch · ${esc(store.name)}</span>
    <span class="clock">${fmtT(new Date())}</span><span class="sp"></span>
    <span class="stat"><span>At dispatch <b>${list.length}</b></span><span>Cooking <b>${cooking}</b></span></span>
    <button class="k-btn sm" id="ringBtn">${prefs.ring ? "🔔 Ring" : "🔔 Chime"}</button>
    <button class="k-btn sm" id="userBtn">👤 ${esc(me?.name || "")}${me?.roles?.length ? ` <span class="k-tag">${esc(roleLabel(me.roles[0]))}</span>` : ""}</button>
  </header>`;
  head.querySelector("#ringBtn").onclick = () => { prefs.ring = !prefs.ring; try { localStorage.setItem("orderqr:dring", prefs.ring ? "on" : "off"); } catch {} draw(); };
  head.querySelector("#userBtn").onclick = async () => { clearActiveStaff(storeId); me = await pinGate({ storeId, storeName: store.name, requireRoles: ["dispatch", "crew"], screenName: "Dispatch" }); draw(); };
  const board = document.getElementById("board"); board.innerHTML = "";
  if (!list.length) board.appendChild(html(`<div class="k-empty" style="grid-column:1/-1">Nothing to check right now.${cooking ? `<br><span class="small">${cooking} order${cooking > 1 ? "s" : ""} still cooking.</span>` : ""}</div>`));
  list.forEach((o) => board.appendChild(card(o)));
}

function card(o) {
  const st = stationsOf(o), packed = PACKED(o);
  const set = checks.get(o.id) || new Set(); checks.set(o.id, set);
  // what Dispatch checks: food lines (with plating components); for packed orders also every other line
  const lines = (o.items || []).map((l, i) => ({ ...l, i, stn: l.station || "kitchen" })).filter((l) => l.stn === "kitchen" || packed);
  const keys = [];
  const rows = lines.map((l) => {
    const k = `l${l.i}`; keys.push(k);
    const other = l.stn !== "kitchen", made = other ? st[l.stn] !== "pending" : true;
    const comps = (l.plating || []).map((p, j) => { const ck = `l${l.i}p${j}`; keys.push(ck); return `<label class="d-comp ${set.has(ck) ? "on" : ""}"><input type="checkbox" data-k="${ck}" ${set.has(ck) ? "checked" : ""}/> ${esc(p)}</label>`; }).join("");
    return `<div class="d-line ${set.has(k) ? "on" : ""}">
      <label class="d-main"><input type="checkbox" data-k="${k}" ${set.has(k) ? "checked" : ""} ${made ? "" : "disabled"}/> <b>${l.qty}× ${esc(l.name)}</b>${other ? ` <span class="k-tag">${STN[l.stn] || l.stn}${made ? " ✓" : " · making…"}</span>` : ""}</label>
      ${l.choices?.length ? `<div class="d-opt">${l.choices.map((c) => esc(c.label)).join(", ")}</div>` : ""}${l.note ? `<div class="d-note">“${esc(l.note)}”</div>` : ""}
      ${comps ? `<div class="d-comps">${l.qty > 1 ? `<span class="muted small">For each of the ${l.qty} plates:</span>` : ""}${comps}</div>` : !other ? `<div class="muted small" style="margin-left:30px">No plating guide set (Menu → item → Plating checklist)</div>` : ""}
      ${l.platingPhoto ? `<img class="d-photo" src="${esc(l.platingPhoto)}" alt="Plating guide" data-zoom/>` : ""}
    </div>`;
  }).join("");
  const allChecked = keys.every((k) => set.has(k));
  const othersReady = Object.entries(st).filter(([k]) => k !== "kitchen").every(([, v]) => v !== "pending");
  const drinks = Object.entries(st).filter(([k]) => k !== "kitchen");
  const since = (o.readyAt || o.updatedAt)?.toDate?.();
  const el = html(`<article class="k-card d-card ${o.dispatch?.readyAt ? "d-out" : ""}">
    <div class="top"><div><div class="no">#${o.orderNo}${o.test ? ` <span class="k-tag test">TEST</span>` : ""}</div><div class="where">${o.tableLabel ? esc(o.tableLabel) + " · " : ""}${SVC[o.serviceType] || ""}${o.customer?.name ? " · " + esc(o.customer.name) : ""}</div></div>
      <div class="time">${since ? Math.max(0, Math.floor((Date.now() - since) / 60000)) + " min" : ""}${o.etaMinutes && o.acceptedAt?.toDate ? `<span class="eta">due ${fmtT(new Date(o.acceptedAt.toDate().getTime() + o.etaMinutes * 60000))}</span>` : ""}</div></div>
    ${o.note ? `<div class="onote">“${esc(o.note)}”</div>` : ""}
    <div class="d-lines">${rows}</div>
    ${!packed && drinks.length ? `<div class="small muted" style="margin-top:6px">${drinks.map(([k, v]) => `${STN[k] || k}: ${v === "served" ? "served ✓" : v === "ready" ? "ready (barista serves)" : "making…"}`).join(" · ")}</div>` : ""}
    <div class="acts"></div></article>`);
  el.querySelectorAll("[data-k]").forEach((cb) => (cb.onchange = () => { cb.checked ? set.add(cb.dataset.k) : set.delete(cb.dataset.k); draw(); }));
  el.querySelectorAll("[data-zoom]").forEach((im) => (im.onclick = () => im.classList.toggle("big")));
  const acts = el.querySelector(".acts");
  const save = (patch) => updateDoc(doc(db, "stores", storeId, "orders", o.id), { ...patch, staffId: me?.staffId || null, updatedAt: serverTimestamp() }).catch((e) => alert(e.message));
  const by = { by: me?.name || null };
  if (packed) {
    const ok = allChecked && othersReady;
    const b = html(`<button class="k-btn ready" ${ok ? "" : "disabled"}>📦 Packed — ready for ${o.serviceType === "delivery" ? "the rider" : "pickup"}</button>`);
    b.onclick = () => { save(stationPatch(o, Object.keys(st), "served", store, { dispatch: { ...(o.dispatch || {}), packedAt: new Date(), ...by } })); checks.delete(o.id); };
    acts.appendChild(b);
    if (!ok) acts.appendChild(html(`<span class="muted small">${!othersReady ? "Waiting for drinks…" : "Check every item first"}</span>`));
  } else if (!o.dispatch?.readyAt) {
    const b = html(`<button class="k-btn ready" ${allChecked ? "" : "disabled"}>✓ Plating OK — ready to serve</button>`);
    b.onclick = () => save(stationPatch(o, [], null, store, { dispatch: { ...(o.dispatch || {}), readyAt: new Date(), ...by } }));
    acts.appendChild(b);
    if (!allChecked) acts.appendChild(html(`<span class="muted small">Check every dish and side first</span>`));
  } else {
    acts.appendChild(html(`<span class="k-tag paid" style="flex-basis:100%">🚶 Crew serving · since ${fmtT(o.dispatch.readyAt.toDate ? o.dispatch.readyAt.toDate() : new Date(o.dispatch.readyAt))}</span>`));
    const b = html(`<button class="k-btn primary">✓ Served — complete</button>`);
    b.onclick = () => { save(stationPatch(o, ["kitchen", ...Object.keys(st).filter((k) => k !== "kitchen" && st[k] === "ready")], "served", store, { dispatch: { ...(o.dispatch || {}), servedAt: new Date(), ...by } })); checks.delete(o.id); };
    acts.appendChild(b);
  }
  return el;
}
