// Laundry counter (POS) — used by /counter/ when store.mode === "laundry".
// Jobs board, New job (walk-in), Fold queue, Claim (stub code), Pause notice, Customers lookup.
import { msgrBtn } from "./msgr.js";
import { orderOp } from "./orderops.js";
import { db, call, auth } from "./firebase.js";
import { uploadPrivateImage } from "./upload.js";
import { hydratePrivate } from "./privfiles.js";
import { collection, doc, onSnapshot, query, orderBy, limit, updateDoc, serverTimestamp, getDocs, where } from "firebase/firestore";
import QRCode from "qrcode";
import { FLOW, LAUNDRY_MODES } from "./pages/orders.js";
import { printClaimStub, printReceipt, printCfg } from "./print.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const html = (str) => { const t = document.createElement("template"); t.innerHTML = str.trim(); return t.content.firstElementChild; };
let CUR = "PHP";
const money = (n) => (CUR === "PHP" ? "₱" : CUR + " ") + Number(n || 0).toLocaleString("en-PH", { maximumFractionDigits: 2 });
const MODE_SHORT = { dropoff_pickup: "🚶 Drop-off · 🚶 Pickup", rider_rider: "🛵 Pickup · 🛵 Delivery", dropoff_delivery: "🚶 Drop-off · 🛵 Delivery", rider_pickup: "🛵 Pickup · 🚶 Pickup" };
const CONTAINERS = { none: "No container", basket: "🧺 Customer basket", ecobag: "👜 Eco bag", plastic: "🛍️ Plastic" };
const STEP_COLOR = { unconfirmed: "var(--new)", booked: "var(--new)", received: "var(--new)", weighed: "var(--prep)", waiting_payment: "var(--danger)", washing: "var(--prep)", drying: "var(--prep)", folding: "var(--prep)", ready: "var(--ready)", out_for_delivery: "var(--ready)", claimed: "var(--line)" };

let ctx; // { storeId, store, me, openDrawer, closeDrawer, askMethod, openShiftPanel, switchUser, openShift }
let orders = [], items = [], cats = [], customers = [], tab = "jobs", filter = "active", mainEl, headEl;

export function bootLaundry(c) {
  ctx = c; CUR = c.store.settings?.currency || "PHP";
  c.app.innerHTML = `<div><div id="head"></div><div id="main" class="c-main"></div></div>`;
  headEl = document.getElementById("head"); mainEl = document.getElementById("main");
  onSnapshot(query(collection(db, "stores", c.storeId, "orders"), orderBy("createdAt", "desc"), limit(300)), (snap) => { orders = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((o) => o.type === "laundry"); drawHead(); if (["jobs", "fold", "claim"].includes(tab)) draw(); });
  onSnapshot(query(collection(db, "stores", c.storeId, "items"), orderBy("sortOrder")), (snap) => { items = snap.docs.map((d) => ({ id: d.id, ...d.data() })); });
  onSnapshot(query(collection(db, "stores", c.storeId, "categories"), orderBy("sortOrder")), (snap) => { cats = snap.docs.map((d) => ({ id: d.id, ...d.data() })); });
  drawHead(); draw();
}
export function laundryStoreUpdated(store) { if (!ctx) return; ctx.store = store; CUR = store.settings?.currency || "PHP"; drawHead(); }
export function laundryShiftUpdated(sh) { ctx.openShift = sh; drawHead(); }

const cfg = () => ctx.store.settings?.laundry || {};
const flow = () => FLOW.laundry.filter(([k]) => (k !== "drying" || cfg().steps?.drying !== false) && (k !== "folding" || cfg().steps?.folding !== false));
const isActive = (o) => !["claimed", "cancelled"].includes(o.status);
const ticket = (o) => o.laundry?.ticketNo ? `#${o.laundry.ticketNo}` : `J${o.orderNo}`;
const readyDays = (o) => o.status === "ready" && o.readyAt?.toDate ? Math.floor((Date.now() - o.readyAt.toDate()) / 86400000) : 0;

function drawHead() {
  const active = orders.filter(isActive);
  const unclaimed = orders.filter((o) => readyDays(o) >= 2).length;
  const pause = ctx.store.settings?.pause;
  const tabs = [["jobs", `Jobs <span class="k-tag">${active.length}</span>`], ["new", "➕ New job"], ["fold", `Fold queue <span class="k-tag">${orders.filter((o) => ["washing", "drying", "folding"].includes(o.status)).length}</span>`], ["claim", "🎫 Claim"], ["customers", "👥 Customers"]];
  headEl.innerHTML = `<header class="k-head">
    ${ctx.store.logoUrl ? `<img src="${esc(ctx.store.logoUrl)}" alt="" style="width:34px;height:34px;border-radius:8px;object-fit:cover"/>` : ""}<span class="name">${esc(ctx.store.name)}</span>
    ${tabs.map(([k, l]) => `<button class="k-btn sm ${tab === k ? "primary" : ""}" data-tab="${k}">${l}</button>`).join("")}
    <span class="sp"></span>
    ${unclaimed ? `<span class="k-tag" style="color:var(--danger)">📦 ${unclaimed} unclaimed 2+ days</span>` : ""}
    <button class="k-btn sm ${ctx.store.settings?.busy?.active ? "on" : ""}" id="busyBtn">${ctx.store.settings?.busy?.active ? `🔥 BUSY +${ctx.store.settings.busy.extraDays}d` : "🔥 Busy mode"}</button>
    <button class="k-btn sm ${pause?.active ? "on" : ""}" id="pauseBtn">${pause?.active ? "⏸ PAUSED" : "⏸ Pause"}</button>
    <button class="k-btn sm ${ctx.openShift ? "" : "danger"}" id="shiftBtn">${ctx.openShift ? (ctx.openShift.status === "needs_count" ? "🌙 Count cash" : ctx.openShift.status !== "open" ? "⚠️ Shift check" : "📊 Shift") : "▶ Start shift"}</button>
    <button class="k-btn sm" id="userBtn">👤 ${esc(ctx.me?.name || "")}</button>
  </header>
  ${pause?.active ? `<div class="k-paused">⏸ <b>${esc(pause.reason)}</b>${pause.until ? ` · expected to resume ${esc(pause.until)}` : ""} — customers see this on their status page.</div>` : ""}`;
  headEl.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => { tab = b.dataset.tab; drawHead(); draw(); }));
  headEl.querySelector("#pauseBtn").onclick = pausePanel;
  headEl.querySelector("#busyBtn").onclick = busyPanel;
  headEl.querySelector("#shiftBtn").onclick = ctx.openShiftPanel;
  headEl.querySelector("#userBtn").onclick = ctx.switchUser;
}
function draw() {
  mainEl.innerHTML = "";
  if (tab === "jobs") drawJobs();
  if (tab === "new") newJobForm(null);
  if (tab === "fold") drawFold();
  if (tab === "claim") drawClaim();
  if (tab === "customers") drawCustomers();
}

// ---------------- jobs board ----------------
function drawJobs() {
  const fl = flow();
  const counts = Object.fromEntries(fl.map(([k]) => [k, orders.filter((o) => o.status === k).length]));
  const wrap = html(`<div>
    <div class="row wrap" style="gap:6px;margin-bottom:12px">
      <input class="k-input" data-q placeholder="Search ticket # / name / phone" style="max-width:260px;margin:0"/>
      <button class="k-btn sm ${filter === "active" ? "primary" : ""}" data-f="active">All active</button>
      ${fl.filter(([k]) => k !== "claimed").map(([k, l]) => `<button class="k-btn sm ${filter === k ? "primary" : ""}" data-f="${k}">${l} <span class="k-tag">${counts[k] || 0}</span></button>`).join("")}
      <button class="k-btn sm ${filter === "claimed" ? "primary" : ""}" data-f="claimed">Claimed today</button>
    </div><div class="c-grid" data-list></div></div>`);
  const list = wrap.querySelector("[data-list]");
  const render = (q = "") => {
    list.innerHTML = "";
    let rows = filter === "active" ? orders.filter(isActive) : orders.filter((o) => o.status === filter);
    if (filter === "claimed") rows = rows.slice(0, 40);
    rows = rows.filter((o) => !q || ticket(o).toLowerCase().includes(q) || (o.customer?.name || "").toLowerCase().includes(q) || (o.customer?.phone || "").includes(q));
    rows.forEach((o) => list.appendChild(jobCard(o)));
    if (!list.children.length) list.innerHTML = `<div class="k-empty">No jobs here.</div>`;
  };
  wrap.querySelectorAll("[data-f]").forEach((b) => (b.onclick = () => { filter = b.dataset.f; draw(); }));
  wrap.querySelector("[data-q]").oninput = (e) => render(e.target.value.toLowerCase());
  render(); mainEl.appendChild(wrap);
}
function jobCard(o) {
  const L = o.laundry || {}; const fl = flow();
  const idx = fl.findIndex((f) => f[0] === o.status); const next = fl[idx + 1];
  const t = o.createdAt?.toDate?.(); const rb = L.readyBy?.toDate?.();
  const days = readyDays(o);
  const el = html(`<article class="k-card" style="border-top-color:${STEP_COLOR[o.status] || "var(--line)"}">
    <div class="top"><div><div class="no">${esc(ticket(o))} <span class="k-tag">${esc((fl[idx] || [, o.status])[1])}</span>${o.test ? ` <span class="k-tag" style="background:#ffe58a;color:#6b4a00">🧪 TEST</span>` : ""}${o.paid ? ` <span class="k-tag paid">Paid · ${esc(o.paymentMethod || "")}</span>` : ` <span class="k-tag" style="color:var(--new)">Unpaid</span>`}${L.rush ? ` <span class="k-tag" style="color:var(--danger)">⚡ RUSH</span>` : ""}${days >= 2 ? ` <span class="k-tag" style="color:var(--danger)">📦 ${days} days${cfg().storageFeePerDay && days > (cfg().storageFreeDays || 0) ? ` · storage ${money((days - (cfg().storageFreeDays || 0)) * cfg().storageFeePerDay)}` : ""}</span>` : ""}</div>
      <div class="where">${esc(o.customer?.name || "")}${o.customer?.phone ? ` · ${esc(o.customer.phone)}` : ""}${o.customer?.messenger ? " " + msgrBtn(o.customer.messenger, "k-tag", "💬") : ""}</div>
      <div class="small muted">${MODE_SHORT[L.mode] || ""}${L.container && L.container !== "none" ? ` · ${CONTAINERS[L.container] || L.container}` : ""}${L.pcs != null ? ` · ${L.pcs} pcs` : ""}</div></div>
      <div class="time">${t ? t.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" }) : ""}<span class="eta">${rb ? "Ready by " + rb.toLocaleString("en-PH", { weekday: "short", hour: "numeric", minute: "2-digit" }) : ""}</span></div></div>
    ${o.customer?.address && o.serviceType === "delivery" ? `<div class="small muted">📍 ${esc(o.customer.address)}</div>` : ""}
    ${L.pickupAt?.toDate && ["booked", "picking_up"].includes(o.status) ? `<div class="small" style="color:var(--new)">🛵 Pickup ${L.pickupAt.toDate().toLocaleString("en-PH", { weekday: "short", hour: "numeric", minute: "2-digit" })}</div>` : ""}
    <ul>${(o.items || []).map((l) => `<li><span class="q">${esc(l.label || l.qty)}</span><span>${esc(l.name)}${l.note ? `<span class="opt">${esc(l.note)}</span>` : ""}</span><span class="amt">${money(l.subtotal)}</span></li>`).join("")}</ul>
    ${L.handWash ? `<div class="small" style="color:var(--new)">🧼 Hand wash: ${esc(L.handWash)}</div>` : ""}${L.separateWhites === false ? `<div class="small muted">Mixed wash (no separation)</div>` : ""}${L.fold === false ? `<div class="small muted">No fold</div>` : ""}
    ${o.note ? `<div class="small muted">📝 ${esc(o.note)}</div>` : ""}
    <div class="top"><b style="font-size:1.2rem">${L.estimateOnly && !o.total ? "Estimate pending" : money(o.total)}</b><span class="small muted">${L.kg ? `${L.kg} kg · ${L.loads} load${L.loads > 1 ? "s" : ""}` : ""}${o.deliveryFeePending ? " · delivery fee not set" : o.deliveryFee ? ` · delivery ${money(o.deliveryFee)}` : ""}</span></div>
    <div class="acts"></div></article>`);
  const acts = el.querySelector(".acts");
  const set = (patch) => updateDoc(doc(db, "stores", ctx.storeId, "orders", o.id), { ...patch, staffId: ctx.me?.staffId || null, updatedAt: serverTimestamp() }).catch((e) => alert(e.message));
  if (o.status === "claimed" || o.status === "cancelled") return el;
  // status select + next
  if (o.status === "unconfirmed") { const b = html(`<button class="k-btn primary">✅ Confirmed on Messenger</button>`); b.onclick = () => set({ status: "booked", confirmedAt: serverTimestamp(), confirmedBy: ctx.me?.name || null }); acts.appendChild(b); const dl = o.confirmDeadline?.toDate?.(); if (dl) acts.appendChild(html(`<span class="small muted">auto-cancels ${dl.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}</span>`)); }
  if (o.status === "booked") { const b = html(`<button class="k-btn prep">📥 Received at shop</button>`); b.onclick = () => set({ status: "received" }); acts.appendChild(b); if (["rider_rider", "rider_pickup"].includes(L.mode)) acts.appendChild(html(`<span class="small muted">or wait for the rider to pick it up (Rider app)</span>`)); }
  if (o.status === "picking_up") acts.appendChild(html(`<span class="small muted">🛵 ${esc(o.riderName || "Rider")} is picking this up…</span>`));
  const sel = html(`<select class="k-input" style="width:auto;margin:0;padding:8px 10px">${fl.map(([k, l]) => `<option value="${k}" ${k === o.status ? "selected" : ""}>${l}</option>`).join("")}</select>`);
  sel.onchange = () => { if (sel.value === "claimed") { sel.value = o.status; return alert("Use the Claim tab — the customer's claim code is required."); } if (sel.value === "washing" && cfg().paymentFirst && !o.paid) { sel.value = o.status; return alert("Payment-first is on: take payment before washing."); } set({ status: sel.value, ...(sel.value === "ready" ? { readyAt: serverTimestamp() } : {}) }); };
  acts.appendChild(sel);
  if (next && next[0] !== "claimed" && !(next[0] === "waiting_payment" && o.paid) && !(next[0] === "out_for_delivery" && !["rider_rider", "dropoff_delivery"].includes(L.mode))) {
    const b = html(`<button class="k-btn ${next[0] === "ready" ? "ready" : "prep"}">▶ ${esc(next[1])}</button>`);
    b.onclick = () => { if (next[0] === "washing" && cfg().paymentFirst && !o.paid) return alert("Payment-first is on: take payment before washing."); if (next[0] === "washing" && !o.laundry?.kg && !o.laundry?.estimateOnly) return alert("Weigh / price the job first."); set({ status: next[0], ...(next[0] === "ready" ? { readyAt: serverTimestamp() } : {}) }); };
    acts.appendChild(b);
  }
  if (next?.[0] === "waiting_payment" && o.paid) { const b = html(`<button class="k-btn prep">▶ Washing</button>`); b.onclick = () => set({ status: "washing" }); acts.appendChild(b); }
  const w = html(`<button class="k-btn">⚖️ ${L.kg || L.estimateOnly ? "Re-weigh / price" : "Weigh & price"}</button>`); w.onclick = () => repriceDrawer(o); acts.appendChild(w);
  if (!o.paid && (o.total > 0)) { const b = html(`<button class="k-btn primary">💵 Mark paid</button>`); b.onclick = () => ctx.askMethod([o], () => { if (o.status === "waiting_payment") set({ status: "washing" }); }); acts.appendChild(b); }
  if (o.serviceType === "delivery" && o.status !== "claimed") { const b = html(`<button class="k-btn">🛵 ${o.deliveryFeePending ? "Set delivery fee" : `Delivery fee ${money(o.deliveryFee || 0)} ✎`}</button>`); b.onclick = () => { const v = prompt(`Delivery fee for:\n${o.customer?.address || ""}\n\nAmount (₱):`, o.deliveryFee || ""); if (v == null || v === "") return; orderOp(ctx.storeId, "deliveryFee", { orderId: o.id, fee: Math.max(0, Number(v) || 0) }).catch((e) => alert(e.message)); }; acts.appendChild(b); }
  const np = (L.proof?.photos || []).length;
  const pf = html(`<button class="k-btn">📷 Proof${np ? ` (${np})` : ""}</button>`); pf.onclick = () => proofDrawer(o); acts.appendChild(pf);
  const msg = html(`<button class="k-btn">💬 Message</button>`); msg.onclick = () => messagePanel(o); acts.appendChild(msg);
  const stub = html(`<button class="k-btn">🎫 Stub</button>`); stub.onclick = () => showStub(o); acts.appendChild(stub);
  const x = html(`<button class="k-btn danger">✕</button>`); x.onclick = () => { const r = prompt("Cancel this job? Reason:"); if (!r) return; orderOp(ctx.storeId, "cancel", { orderId: o.id, reason: r }).catch((e) => alert(e.message)); }; acts.appendChild(x);
  return el;
}

// ---------------- new job ----------------
function serviceRows(preset = {}) {
  const svcCats = cats.filter((c) => c.active !== false);
  return svcCats.map((c) => { const its = items.filter((i) => i.categoryId === c.id && i.available !== false); if (!its.length) return ""; return `<div class="lj-cat"><div class="muted small" style="margin:10px 0 4px;font-weight:700">${esc(c.name)}</div>${its.map((i) => { const u = i.unit || "piece"; const pre = preset[i.id]; return `<label class="lj-svc"><input type="checkbox" data-svc="${i.id}" ${pre ? "checked" : ""}/><span class="n">${esc(i.name)}<small>${u === "estimate" ? "estimate — price after inspection" : `${money(i.price)}/${u}`}</small></span>${u === "estimate" ? `<input type="number" class="k-input q" data-price="${i.id}" placeholder="₱ quote" value="${pre?.price ?? ""}"/>` : `<input type="number" class="k-input q" data-qty="${i.id}" step="${u === "kg" ? "0.1" : "1"}" min="0" placeholder="${u}" value="${pre?.qty ?? ""}"/>`}</label>`; }).join("")}</div>`; }).join("");
}
function readServices(el) {
  const out = [];
  el.querySelectorAll("[data-svc]:checked").forEach((cb) => { const id = cb.dataset.svc; const q = el.querySelector(`[data-qty="${id}"]`), p = el.querySelector(`[data-price="${id}"]`); out.push({ itemId: id, qty: q ? Number(q.value || 0) : 1, price: p ? Number(p.value || 0) : undefined }); });
  return out;
}
function newJobForm() {
  const c = cfg(); const modes = Object.entries(LAUNDRY_MODES).filter(([k]) => c.modes?.[k] !== false);
  const lastTicket = orders.map((o) => parseInt(o.laundry?.ticketNo, 10)).filter((n) => !isNaN(n)).sort((a, b) => b - a)[0];
  const el = html(`<div class="lj-form">
    <div class="lj-col">
      <h3>Customer</h3>
      <input class="k-input" data-cphone placeholder="Phone (search existing)" inputmode="tel"/><div class="small muted" data-cfound></div>
      <input class="k-input" data-cname placeholder="Name *"/>
      <input class="k-input" data-caddr placeholder="Address (for delivery)"/>
      <h3 style="margin-top:14px">Job</h3>
      <label>Service mode</label><select class="k-input" data-mode>${modes.map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>
      <div class="row" style="gap:8px"><div style="flex:1"><label>Ticket / hook #</label><input class="k-input" data-ticket placeholder="${lastTicket ? `last used: ${lastTicket}` : "e.g. 41"}" inputmode="numeric"/></div><div style="flex:1"><label>Container</label><select class="k-input" data-container>${Object.entries(CONTAINERS).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select></div></div>
      ${c.clothesCount ? `<label>Clothes count (pcs)</label><input class="k-input" data-pcs type="number" min="0" inputmode="numeric"/>` : ""}
      ${ctx.store.settings?.busy?.active ? `<div class="k-tag" style="display:block;padding:8px;margin:8px 0;color:var(--danger)">🔥 Busy: +${ctx.store.settings.busy.extraDays} day(s). Ask the customer: willing to wait, or add Rush?</div><label class="check"><input type="checkbox" data-waitok checked/> Customer is willing to wait (+${ctx.store.settings.busy.extraDays} day(s))</label>` : ""}
      <label class="check"><input type="checkbox" data-rush/> ⚡ Rush (${c.rushMode === "fixed" ? `+${money(c.rushValue)}` : c.rushMode === "double" ? "2× price" : `+${c.rushValue ?? 50}%`}, ready in ${c.rushEtaHours || 6}h)</label>
      <label class="check"><input type="checkbox" data-sep ${c.separateWhites !== false ? "checked" : ""}/> Separate whites / colors</label>
      ${!c.foldFree && c.foldFee ? `<label class="check"><input type="checkbox" data-fold checked/> Fold (+${money(c.foldFee)}/kg)</label>` : ""}
      <label>Hand wash (which items?)</label><input class="k-input" data-hand placeholder="optional — e.g. 2 barong, 1 blouse"/>
      <label>Notes</label><input class="k-input" data-note placeholder="optional"/>
    </div>
    <div class="lj-col">
      <h3>Services <span class="small muted">(min ${c.minKg || 0} kg · ${c.maxLoadKg || 8} kg per load)</span></h3>
      ${serviceRows() || `<p class="muted small">No services yet — add them in the owner app (Services).</p>`}
      <div class="lj-total"><div><span class="muted small">Estimated total</span><b data-total>—</b></div><div class="small muted" data-info></div></div>
      <div data-loyalty class="small muted"></div>
      <label class="check"><input type="checkbox" data-paynow/> 💵 Paid now</label>
      <div class="row" style="gap:8px"><button class="k-btn primary" data-create style="flex:1">🎫 Create job & stub</button></div>
      <p class="small muted">${c.paymentFirst ? "Payment-first is ON: unpaid jobs wait for payment before washing." : "Payment can be taken on claim."}</p>
    </div>
  </div>`);
  // live estimate
  const est = () => { const lines = readServices(el); let sub = 0, kg = 0; for (const l of lines) { const it = items.find((i) => i.id === l.itemId); if (!it) continue; const u = it.unit || "piece"; let q = l.qty; if (u === "kg") { if (q > 0 && q < (c.minKg || 0)) q = c.minKg; kg += q; sub += it.price * q; } else if (u === "load") sub += it.price * Math.max(1, Math.ceil(q)); else if (u === "estimate") sub += l.price || 0; else sub += it.price * Math.max(1, Math.round(q || 1)); }
    if (!c.foldFree && c.foldFee && el.querySelector("[data-fold]")?.checked) sub += c.foldFee * kg;
    if (el.querySelector("[data-rush]").checked) sub += c.rushMode === "fixed" ? Number(c.rushValue) || 0 : c.rushMode === "double" ? sub : sub * (Number(c.rushValue) || 50) / 100;
    el.querySelector("[data-total]").textContent = lines.length ? money(sub) : "—";
    el.querySelector("[data-info]").textContent = kg ? `${kg} kg → ${Math.max(1, Math.ceil(kg / (c.maxLoadKg || 8)))} load(s)${kg < (c.minKg || 0) ? ` · min ${c.minKg} kg applied` : ""}` : ""; };
  el.addEventListener("input", est); el.addEventListener("change", est);
  // customer lookup
  let loyAvail = 0;
  const loyCheck = async (phone) => { const box = el.querySelector("[data-loyalty]"); if (!c.loyalty?.enabled) return; try { const r = await call("laundryLoyalty", { phone }); if (r.disabled) return; loyAvail = r.available || 0; box.innerHTML = `🎁 Loyalty: <b>${r.kgTotal} kg</b> washed · <b>${r.available} kg free</b> available${r.available > 0 ? ` <label class="check" style="display:inline-flex;margin:0 0 0 8px"><input type="checkbox" data-usefree checked/> apply ${r.available} kg free</label>` : ` · ${r.toNext} kg to next reward`}`; } catch { box.textContent = ""; } };
  el.querySelector("[data-cphone]").addEventListener("change", (e) => loyCheck(e.target.value.trim()));
  el.querySelector("[data-cphone]").oninput = async (e) => { const d = e.target.value.replace(/\D/g, ""); if (d.length < 7) return; const snap = await getDocs(query(collection(db, "stores", ctx.storeId, "customers"), where("phone", ">=", e.target.value), where("phone", "<=", e.target.value + ""), limit(1))).catch(() => null); const c0 = snap?.docs?.[0]?.data(); if (c0) { el.querySelector("[data-cname]").value = c0.name || ""; el.querySelector("[data-caddr]").value = c0.address || ""; el.querySelector("[data-cfound]").textContent = `Returning customer · ${c0.orders || 0} jobs`; } };
  el.querySelector("[data-create]").onclick = async (e) => {
    const g = (sel) => el.querySelector(sel);
    const lines = readServices(el); if (!lines.length) return alert("Pick at least one service.");
    if (!g("[data-cname]").value.trim()) return alert("Customer name is required.");
    e.target.disabled = true;
    try {
      const d = { customer: { name: g("[data-cname]").value.trim(), phone: g("[data-cphone]").value.trim(), address: g("[data-caddr]").value.trim() }, items: lines, mode: g("[data-mode]").value, ticketNo: g("[data-ticket]").value.trim(), container: g("[data-container]").value, pcs: g("[data-pcs]")?.value || null, rush: g("[data-rush]").checked, separateWhites: g("[data-sep]").checked, fold: g("[data-fold]") ? g("[data-fold]").checked : true, handWash: g("[data-hand]").value.trim(), note: g("[data-note]").value.trim(), paid: g("[data-paynow]").checked, paymentMethod: "cash", staffId: ctx.me?.staffId, staffName: ctx.me?.name, useFreeKg: g("[data-usefree]")?.checked ? loyAvail : 0 };
      const r = await call("createLaundryJob", d);
      tab = "jobs"; drawHead(); draw();
      const o = orders.find((x) => x.id === r.orderId) || { id: r.orderId, orderNo: r.orderNo, total: r.total, customer: d.customer, laundry: { claimCode: r.claimCode, ticketNo: d.ticketNo, kg: 0 }, items: [] };
      showStub(o, r.claimCode);
    } catch (err) { alert(err.message); e.target.disabled = false; }
  };
  mainEl.appendChild(el);
}
function repriceDrawer(o) {
  const preset = {}; (o.items || []).forEach((l) => { if (l.itemId) preset[l.itemId] = { qty: l.qty, price: l.unit === "estimate" ? l.unitPrice : undefined }; });
  const c = cfg();
  const el = html(`<div>${!o.laundry?.ticketNo ? `<div class="row" style="gap:8px"><div style="flex:1"><label>Ticket / hook #</label><input class="k-input" data-ticket inputmode="numeric" placeholder="e.g. 41"/></div><div style="flex:1"><label>Container</label><select class="k-input" data-container>${Object.entries(CONTAINERS).map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select></div></div>` : ""}${serviceRows(preset)}
    ${c.clothesCount ? `<label>Clothes count (pcs)</label><input class="k-input" data-pcs type="number" min="0" value="${o.laundry?.pcs ?? ""}"/>` : ""}
    <label class="check"><input type="checkbox" data-rush ${o.laundry?.rush ? "checked" : ""}/> ⚡ Rush</label>
    ${!c.foldFree && c.foldFee ? `<label class="check"><input type="checkbox" data-fold ${o.laundry?.fold !== false ? "checked" : ""}/> Fold</label>` : ""}
    <button class="k-btn primary" data-save style="margin-top:12px;width:100%">Save price</button></div>`);
  el.querySelector("[data-save]").onclick = async (e) => { e.target.disabled = true; try { const r = await call("repriceLaundryJob", { orderId: o.id, items: readServices(el), ticketNo: el.querySelector("[data-ticket]")?.value, container: el.querySelector("[data-container]")?.value, rush: el.querySelector("[data-rush]").checked, fold: el.querySelector("[data-fold]") ? el.querySelector("[data-fold]").checked : true, pcs: el.querySelector("[data-pcs]")?.value || null, staffName: ctx.me?.name }); ctx.closeDrawer(); alert(`Updated: ${money(r.total)} · ${r.kg} kg · ${r.loads} load(s). The customer sees the new price on their status page.`); } catch (err) { alert(err.message); e.target.disabled = false; } };
  ctx.openDrawer(`Weigh & price · ${ticket(o)}`, el);
}

// ---------------- claim stub ----------------
export async function showStub(o, code) {
  const L = o.laundry || {}; const claim = code || L.claimCode || "";
  const link = `${location.origin}/m/${ctx.store.slug}?job=${o.id}&k=${claim}`;
  const qr = await QRCode.toDataURL(link, { width: 220, margin: 1 });
  const el = html(`<div class="lj-stub" id="stubPrint">
    <div class="stub-head"><b>${esc(ctx.store.name)}</b><br><span class="small">${esc(ctx.store.contact?.phone || "")}</span></div>
    <div class="stub-big">${esc(ticket(o))}</div>
    <div class="stub-code">Claim code <b>${esc(claim)}</b></div>
    <img src="${qr}" alt="QR" style="width:180px;height:180px;display:block;margin:6px auto"/>
    <div class="small">${esc(o.customer?.name || "")}${o.customer?.phone ? ` · ${esc(o.customer.phone)}` : ""} ${msgrBtn(o.customer?.messenger, "k-btn sm")}</div>
    <div class="small">${(o.items || []).map((l) => `${esc(l.name)} ${esc(l.label || "")}`).join(" · ")}</div>
    <div class="small">${L.kg ? `${L.kg} kg · ` : ""}${L.pcs != null ? `${L.pcs} pcs · ` : ""}${L.container && L.container !== "none" ? `${CONTAINERS[L.container]} · ` : ""}${L.rush ? "RUSH · " : ""}Total <b>${L.estimateOnly && !o.total ? "to be quoted" : money(o.total)}</b>${o.paid ? " (PAID)" : ""}</div>
    ${L.readyBy?.toDate ? `<div class="small">Ready by ${L.readyBy.toDate().toLocaleString("en-PH", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>` : ""}
    <div class="stub-policy">Keep this stub (screenshot the QR). Garments are released <b>only</b> to whoever presents this claim code — no stub, no claim. Scan the QR to follow your job status and final price.</div>
    <div class="row no-print" style="gap:8px;margin-top:12px"><button class="k-btn" data-print>🖨 Print</button><button class="k-btn" data-copy>Copy link</button><button class="k-btn" data-sms>💬 Send link</button></div>
  </div>`);
  if (!printCfg(ctx.store).enabled) el.querySelector("[data-print]").style.display = "none";
  el.querySelector("[data-print]").onclick = () => printClaimStub(ctx.store, { ...o, laundry: { ...(o.laundry || {}), claimCode: claim } }, qr, link);
  if (printCfg(ctx.store).enabled) { const rc = html(`<button class="k-btn" data-receipt>🧾 Receipt</button>`); rc.onclick = () => printReceipt(ctx.store, o, { cur: CUR, staffName: ctx.me?.name }); el.querySelector(".no-print").appendChild(rc); }
  if (code && printCfg(ctx.store).enabled && printCfg(ctx.store).autoStub) setTimeout(() => printClaimStub(ctx.store, { ...o, laundry: { ...(o.laundry || {}), claimCode: claim } }, qr, link), 300);
  el.querySelector("[data-copy]").onclick = () => { navigator.clipboard?.writeText(link); alert("Link copied."); };
  el.querySelector("[data-sms]").onclick = () => { const text = `${ctx.store.name}: your laundry ticket ${ticket(o)} — claim code ${claim}. Follow status & final price: ${link}`; location.href = `sms:${(o.customer?.phone || "").replace(/\s/g, "")}?&body=${encodeURIComponent(text)}`; };
  ctx.openDrawer("Claim stub", el);
}

// ---------------- fold queue ----------------
function drawFold() {
  const c = cfg();
  let rows = orders.filter((o) => ["washing", "drying", "folding"].includes(o.status));
  rows.sort((a, b) => { if (c.paymentFirst) { const pa = a.paidAt?.toMillis?.() || Infinity, pb = b.paidAt?.toMillis?.() || Infinity; if (pa !== pb) return pa - pb; } const ta = parseInt(a.laundry?.ticketNo, 10), tb = parseInt(b.laundry?.ticketNo, 10); if (!isNaN(ta) && !isNaN(tb) && ta !== tb) return ta - tb; return (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0); });
  const el = html(`<div><p class="muted small">Order of folding: ${c.paymentFirst ? "first paid, first folded" : "by ticket number (first in, first out)"}. Rush jobs are flagged.</p>
    <table class="k-table" style="width:100%"><thead><tr><th>#</th><th>Ticket</th><th>Customer</th><th>Status</th><th>kg / loads</th><th>Paid</th><th></th></tr></thead><tbody>
    ${rows.map((o, i) => `<tr><td><b>${i + 1}</b></td><td><b>${esc(ticket(o))}</b>${o.laundry?.rush ? ` <span class="k-tag" style="color:var(--danger)">⚡</span>` : ""}</td><td>${esc(o.customer?.name || "")}</td><td>${esc(o.status)}</td><td>${o.laundry?.kg || 0} kg · ${o.laundry?.loads || 0}</td><td>${o.paid ? "✓" : "—"}</td><td><button class="k-btn sm" data-next="${o.id}">▶ ${o.status === "folding" ? "Ready" : o.status === "washing" && c.steps?.drying !== false ? "Drying" : "Folding"}</button></td></tr>`).join("") || `<tr><td colspan="7" class="muted">Nothing in the machines.</td></tr>`}</tbody></table></div>`);
  el.querySelectorAll("[data-next]").forEach((b) => (b.onclick = () => { const o = orders.find((x) => x.id === b.dataset.next); const nxt = o.status === "folding" ? "ready" : o.status === "washing" && c.steps?.drying !== false ? "drying" : "folding"; updateDoc(doc(db, "stores", ctx.storeId, "orders", o.id), { status: nxt, ...(nxt === "ready" ? { readyAt: serverTimestamp() } : {}), staffId: ctx.me?.staffId || null, updatedAt: serverTimestamp() }); }));
  mainEl.appendChild(el);
}

// ---------------- intake proof (anti-bintang) ----------------
const PROOF_KIND = { scale: "⚖️ Weight on scale", stain: "🟤 Stain", damage: "🩹 Damage / tear", bag: "🧺 Bag / pieces" };
function proofDrawer(o) {
  const L = o.laundry || {};
  let photos = [...(L.proof?.photos || [])];
  const el = html(`<div>
    <p class="small muted">Take photos <b>before washing</b>: the weighing scale, and any stain, tear or missing button. The customer sees these on their tracker — no more "you stained it" or "kulang ang damit" arguments.</p>
    <label>Pieces received</label><input class="k-input" data-pcs type="number" min="0" inputmode="numeric" value="${L.pcs ?? ""}" placeholder="e.g. 24"/>
    <div data-grid style="display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px;margin:10px 0"></div>
    <label>Add photo</label>
    <div class="row wrap" style="gap:6px">${Object.entries(PROOF_KIND).map(([k, l]) => `<label class="k-btn" style="margin:0">${l}<input type="file" accept="image/*" capture="environment" data-kind="${k}" hidden/></label>`).join("")}</div>
    <input class="k-input" data-note placeholder="Note for the next photo (e.g. white polo, collar stain)" maxlength="80" style="margin-top:8px"/>
    <p class="small muted" data-msg></p>
    <button class="k-btn primary" data-save style="width:100%">Save</button>
    <p class="small muted">Private: seen only by the shop and the customer of this job · deleted after 90 days.</p></div>`);
  const grid = el.querySelector("[data-grid]"), msg = el.querySelector("[data-msg]");
  const added = [], removed = [];
  const draw = () => {
    grid.innerHTML = photos.map((x, i) => `<figure style="margin:0;position:relative"><img data-priv="${esc(x.url)}" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:10px;background:#eee"/><figcaption class="small">${PROOF_KIND[x.kind] || ""}${x.note ? ` · ${esc(x.note)}` : ""}</figcaption><button class="k-btn danger" data-rm="${i}" style="position:absolute;top:4px;right:4px;padding:2px 8px">✕</button></figure>`).join("") || `<div class="small muted">No photos yet.</div>`;
    hydratePrivate(grid);
    grid.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => { const x = photos.splice(+b.dataset.rm, 1)[0]; const ai = added.indexOf(x); if (ai >= 0) added.splice(ai, 1); else removed.push(x.url); draw(); }));
  };
  draw();
  el.querySelectorAll("[data-kind]").forEach((inp) => (inp.onchange = async () => {
    const f = inp.files?.[0]; inp.value = ""; if (!f) return;
    if (photos.length >= 8) return (msg.textContent = "Up to 8 photos per job.");
    msg.textContent = "Uploading…";
    try {
      const url = await uploadPrivateImage(ctx.storeId, auth.currentUser.uid, f, { max: 1280, name: `proof_${o.id}_${Date.now()}` });
      const x = { url, kind: inp.dataset.kind, note: el.querySelector("[data-note]").value.trim() };
      if (x.kind === "scale") photos = photos.filter((p) => { if (p.kind === "scale") { if (!added.includes(p)) removed.push(p.url); return false; } return true; });
      photos.push(x); added.push(x); el.querySelector("[data-note]").value = ""; msg.textContent = "Added — tap Save."; draw();
    } catch (e) { msg.textContent = e.message; }
  }));
  el.querySelector("[data-save]").onclick = async (e) => {
    e.target.disabled = true;
    try {
      await call("laundryProof", { orderId: o.id, add: added, remove: removed, pcs: el.querySelector("[data-pcs]").value, staffName: ctx.me?.name || "" });
      ctx.closeDrawer();
    } catch (x) { msg.textContent = x.message; e.target.disabled = false; }
  };
  ctx.openDrawer(`📷 Intake proof · ${esc(ticket(o))}`, el);
}

// ---------------- claim ----------------
function drawClaim() {
  const ready = orders.filter((o) => o.status === "ready");
  const el = html(`<div style="max-width:560px">
    <h3>🎫 Claim</h3><p class="muted small">Ask for the customer's claim stub. Type the <b>claim code</b> (or scan the QR with a scanner). Garments are released only when the code matches — no stub, no claim.</p>
    <div class="row" style="gap:8px"><input class="k-input" data-code placeholder="Claim code (e.g. 7K3MQ)" style="text-transform:uppercase;font-size:1.3rem;letter-spacing:.1em;margin:0"/><button class="k-btn primary" data-find>Find</button></div>
    <div data-result style="margin-top:14px"></div>
    <h4 style="margin-top:22px">Ready for pickup (${ready.length})</h4>
    <div class="small muted">${ready.map((o) => `${esc(ticket(o))} ${esc(o.customer?.name || "")}${readyDays(o) >= 2 ? ` <span style="color:var(--danger)">(${readyDays(o)} days)</span>` : ""}`).join(" · ") || "—"}</div>
  </div>`);
  const find = async () => {
    const code = el.querySelector("[data-code]").value.trim().toUpperCase(); if (code.length < 4) return;
    const res = el.querySelector("[data-result]"); res.innerHTML = `<p class="muted">Looking up…</p>`;
    try {
      const p = await call("claimLaundryJob", { code });
      const o = orders.find((x) => x.id === p.orderId);
      res.innerHTML = `<div class="k-card" style="border-top-color:var(--ready)"><div class="no">Ticket #${esc(p.ticketNo || p.orderNo)} · ${esc(p.customer || "")}</div><div>Status: <b>${esc(p.status)}</b> · Total <b>${money(p.total)}</b>${p.storageFee ? ` <span class="k-tag" style="color:var(--danger)">incl. storage ${money(p.storageFee)} (${p.storageDays} d)${p.storagePending ? " — unpaid" : ""}</span>` : ""} ${p.paid ? `<span class="k-tag paid">Paid</span>` : `<span class="k-tag" style="color:var(--danger)">UNPAID</span>`}</div>
        ${p.pcs != null || p.proof?.length ? `<div class="c-alert" style="background:#fff7e0;border-radius:10px;padding:8px 10px;margin:8px 0">🔎 <b>Count before release:</b> ${p.pcs != null ? `<b>${p.pcs} pcs</b> received` : "pieces not counted"}${p.kg ? ` · ${p.kg} kg` : ""}${p.proof?.length ? ` · ${p.proof.length} intake photo${p.proof.length > 1 ? "s" : ""} (${esc(p.proof.filter((x) => x.kind !== "scale").map((x) => x.note || x.kind).join(", ") || "scale")})` : ""}</div>` : ""}
        <div class="acts">${!p.paid ? `<button class="k-btn primary" data-pay>💵 Take payment & release</button>` : `<button class="k-btn ready" data-release>✓ Release to customer</button>`}${p.status !== "ready" ? `<span class="small muted">Job is still "${esc(p.status)}" — releasing will force-close it.</span>` : ""}</div></div>`;
      const release = async (paidNow, method) => { try { await call("claimLaundryJob", { code, confirm: true, force: p.status !== "ready", paid: paidNow, paymentMethod: method, staffName: ctx.me?.name }); res.innerHTML = `<div class="k-card" style="border-top-color:var(--ready)"><b>✓ Released ticket #${esc(p.ticketNo || p.orderNo)}</b> ${printCfg(ctx.store).enabled ? `<button class="k-btn sm" data-rc>🖨 Receipt</button>` : ""}</div>`; el.querySelector("[data-code]").value = ""; if (res.querySelector("[data-rc]")) res.querySelector("[data-rc]").onclick = () => { const oo = orders.find((x) => x.id === p.orderId); if (oo) printReceipt(ctx.store, { ...oo, paid: true, paymentMethod: method || oo.paymentMethod }, { cur: CUR, staffName: ctx.me?.name }); }; if (printCfg(ctx.store).enabled && printCfg(ctx.store).autoPaid) { const oo = orders.find((x) => x.id === p.orderId); if (oo) printReceipt(ctx.store, { ...oo, paid: true, paymentMethod: method || oo.paymentMethod }, { cur: CUR, staffName: ctx.me?.name }); } } catch (e) { alert(e.message); } };
      res.querySelector("[data-release]")?.addEventListener("click", () => release(false));
      res.querySelector("[data-pay]")?.addEventListener("click", () => { if (o) ctx.askMethod([o], () => release(true, o.paymentMethod || "cash")); else release(true, "cash"); });
    } catch (e) { res.innerHTML = `<div class="k-card" style="border-top-color:var(--danger)"><b>${esc(e.message)}</b></div>`; }
  };
  el.querySelector("[data-find]").onclick = find; el.querySelector("[data-code]").onkeydown = (e) => e.key === "Enter" && find();
  mainEl.appendChild(el); el.querySelector("[data-code]").focus();
}

// ---------------- customers ----------------
function drawCustomers() {
  const el = html(`<div><input class="k-input" data-q placeholder="Search name / phone" style="max-width:300px"/><div data-list class="small" style="margin-top:10px">Loading…</div></div>`);
  const render = (rows) => { el.querySelector("[data-list]").innerHTML = `<table class="k-table" style="width:100%"><thead><tr><th>Customer</th><th>Jobs</th><th>Last</th><th>Address</th></tr></thead><tbody>${rows.map((c) => `<tr><td><b>${esc(c.name || "")}</b><br><span class="muted">${esc(c.phone || "")}</span></td><td>${c.orders || 0}</td><td>${c.lastOrderAt?.toDate ? c.lastOrderAt.toDate().toLocaleDateString("en-PH", { dateStyle: "medium" }) : "—"}</td><td class="muted">${esc(c.address || "")}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">No customers yet.</td></tr>`}</tbody></table>`; };
  getDocs(query(collection(db, "stores", ctx.storeId, "customers"), orderBy("lastOrderAt", "desc"), limit(300))).then((s) => { customers = s.docs.map((d) => ({ id: d.id, ...d.data() })); render(customers); }).catch(() => render([]));
  el.querySelector("[data-q]").oninput = (e) => { const q = e.target.value.toLowerCase(); render(customers.filter((c) => (c.name || "").toLowerCase().includes(q) || (c.phone || "").includes(q))); };
  mainEl.appendChild(el);
}

// ---------------- message customer ----------------
function messagePanel(o) {
  const L = o.laundry || {}; const link = `${location.origin}/m/${ctx.store.slug}?job=${o.id}&k=${L.claimCode || ""}`;
  const tpl = { priced: `Hi ${o.customer?.name || ""}! Your laundry ${ticket(o)} is ${L.kg || 0} kg — total ${money(o.total)}. ${o.paid ? "" : "You can pay via GCash and message us the reference. "}Status: ${link}`, ready: `Hi ${o.customer?.name || ""}! Your laundry ${ticket(o)} is READY for pickup. Please bring your claim stub (code ${L.claimCode || ""}). ${link}`, delivery: `Hi ${o.customer?.name || ""}! Your laundry ${ticket(o)} is out for delivery. Total ${money(o.total)}${o.paid ? " (paid)" : " — please prepare payment"}.`, custom: "" };
  const el = html(`<div><label>Template</label><select class="k-input" data-t><option value="priced">Price update</option><option value="ready">Ready for pickup</option><option value="delivery">Out for delivery</option><option value="custom">Custom</option></select>
    <textarea class="k-input" data-msg rows="5">${esc(tpl.priced)}</textarea>
    <div class="row wrap" style="gap:8px"><a class="k-btn" data-sms href="#">💬 SMS app</a><a class="k-btn" data-msgr href="https://m.me/" target="_blank">Messenger</a><button class="k-btn" data-copy>Copy</button></div>
    <p class="small muted">Opens your phone's SMS app / Messenger with the text ready — free (uses your own number).</p></div>`);
  const upd = () => { const t = el.querySelector("[data-msg]").value; el.querySelector("[data-sms]").href = `sms:${(o.customer?.phone || "").replace(/\s/g, "")}?&body=${encodeURIComponent(t)}`; };
  el.querySelector("[data-t]").onchange = (e) => { el.querySelector("[data-msg]").value = tpl[e.target.value]; upd(); }; el.querySelector("[data-msg]").oninput = upd; upd();
  el.querySelector("[data-copy]").onclick = () => { navigator.clipboard?.writeText(el.querySelector("[data-msg]").value); alert("Copied."); };
  ctx.openDrawer(`Message · ${esc(o.customer?.name || "")}`, el);
}

// ---------------- pause ----------------
function pausePanel() {
  const p = ctx.store.settings?.pause;
  const el = html(`<div>${p?.active ? `<p>Currently paused: <b>${esc(p.reason)}</b>${p.until ? ` until ${esc(p.until)}` : ""}</p><button class="k-btn ready" data-resume style="width:100%">▶ Resume operations</button>` : `
    <p class="muted small">Customers will see this notice on their status page and on the services page.</p>
    <label>Reason</label><select class="k-input" data-reason><option>Water interruption</option><option>Power interruption</option><option>Machine maintenance</option><option>Holiday / closed</option><option value="custom">Other…</option></select>
    <input class="k-input" data-custom placeholder="Describe" style="display:none"/>
    <label>Expected to resume (optional)</label><input class="k-input" data-until placeholder="e.g. tomorrow 10 AM"/>
    <button class="k-btn on" data-pause style="width:100%;margin-top:10px">⏸ Pause now</button>`}</div>`);
  el.querySelector("[data-reason]")?.addEventListener("change", (e) => (el.querySelector("[data-custom]").style.display = e.target.value === "custom" ? "" : "none"));
  el.querySelector("[data-pause]")?.addEventListener("click", async () => { const r = el.querySelector("[data-reason]").value === "custom" ? el.querySelector("[data-custom]").value.trim() : el.querySelector("[data-reason]").value; try { await call("setPause", { active: true, reason: r, until: el.querySelector("[data-until]").value.trim(), staffName: ctx.me?.name }); ctx.closeDrawer(); } catch (e) { alert(e.message); } });
  el.querySelector("[data-resume]")?.addEventListener("click", async () => { try { await call("setPause", { active: false }); ctx.closeDrawer(); } catch (e) { alert(e.message); } });
  ctx.openDrawer("Pause notice", el);
}

// ---------------- busy mode ----------------
function busyPanel() {
  const b = ctx.store.settings?.busy;
  const el = html(`<div>${b?.active ? `<p>Busy mode is on: <b>+${b.extraDays} day(s)</b>${b.note ? ` · ${esc(b.note)}` : ""}</p><button class="k-btn ready" data-off style="width:100%">✓ Back to normal</button>` : `
    <p class="muted small">Tell customers that jobs take longer right now. On the QR page they must choose "willing to wait" or add Rush before booking.</p>
    <label>Extra days on top of the usual turnaround</label><input class="k-input" data-h type="number" min="1" step="1" value="1"/>
    <label>Note (optional)</label><input class="k-input" data-n placeholder="e.g. machine down / holiday rush"/>
    <button class="k-btn on" data-on style="width:100%;margin-top:10px">🔥 Turn on busy mode</button>`}</div>`);
  el.querySelector("[data-on]")?.addEventListener("click", async () => { try { await call("setBusy", { active: true, extraDays: Number(el.querySelector("[data-h]").value || 0), note: el.querySelector("[data-n]").value.trim(), staffName: ctx.me?.name }); ctx.closeDrawer(); } catch (e) { alert(e.message); } });
  el.querySelector("[data-off]")?.addEventListener("click", async () => { try { await call("setBusy", { active: false }); ctx.closeDrawer(); } catch (e) { alert(e.message); } });
  ctx.openDrawer("Busy mode", el);
}
