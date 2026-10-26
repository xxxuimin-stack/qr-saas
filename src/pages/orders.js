// Orders page (dashboard): live list of today's orders, with status buttons
import { msgrBtn } from "../msgr.js";
import { orderOp, payMethods } from "../orderops.js";
import { db } from "../firebase.js";
import { collection, doc, updateDoc, onSnapshot, query, orderBy, limit, serverTimestamp } from "firebase/firestore";
import { esc, money, html, toast, openModal, closeModal } from "../ui.js";

// status flow per order type
export const FLOW = {
  table:   [["pending", "New"], ["preparing", "Preparing"], ["ready", "Ready"], ["completed", "Completed"]],
  pickup:  [["received", "Received"], ["processing", "Processing"], ["ready", "Ready"], ["picked_up", "Picked up"]],
  booking: [["pending", "Requested"], ["confirmed", "Confirmed"], ["in_progress", "In progress"], ["done", "Done"]],
  salon: [["pending", "Requested"], ["confirmed", "Confirmed"], ["in_progress", "In progress"], ["done", "Done"]],
  laundry: [["unconfirmed", "Awaiting Messenger"], ["booked", "Booked"], ["picking_up", "Rider picking up"], ["received", "Received"], ["weighed", "Weighed / priced"], ["waiting_payment", "Waiting for payment"], ["washing", "Washing"], ["drying", "Drying"], ["folding", "Folding"], ["ready", "Ready"], ["out_for_delivery", "Out for delivery"], ["claimed", "Claimed"]],
};
export const LAUNDRY_MODES = { dropoff_pickup: "Customer drop-off · Customer pickup", rider_rider: "Rider pickup · Rider delivery", dropoff_delivery: "Customer drop-off · Rider delivery", rider_pickup: "Rider pickup · Customer pickup" };
const SVC = { dine_in: "🍽️ Dine-in", take_out: "🥡 Take-out", pickup: "🛍️ Pickup", delivery: "🛵 Delivery" };

export function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880; g.gain.value = 0.15;
    o.start(); o.stop(ctx.currentTime + 0.18);
    setTimeout(() => { const o2 = ctx.createOscillator(); o2.connect(g); o2.frequency.value = 1175; o2.start(); o2.stop(ctx.currentTime + 0.4); }, 200);
  } catch {}
}

export function renderOrdersPage(root, ctx) {
  const { storeId, store, labels } = ctx;
  const col = collection(db, "stores", storeId, "orders");
  let orders = [];
  let tab = "active";
  let seen = null; // set of order ids already seen (for the beep)
  const flow = FLOW[store.mode] || FLOW.table;
  const firstStatus = flow[0][0];
  const activeStatuses = ["unconfirmed", ...flow.slice(0, -1).map((f) => f[0]), "out_for_delivery"];
  const doneStatus = flow[flow.length - 1][0];
  const isDone = (o) => o.status === doneStatus || o.status === "delivered";

  root.innerHTML = `
    <div class="row between wrap" style="margin-bottom:12px">
      <div class="tabs" style="margin:0;max-width:420px;flex:1">
        <button data-tab="active" class="active">Active <span class="tag" id="cntActive">0</span></button>
        <button data-tab="done">Completed</button>
        <button data-tab="cancelled">Cancelled</button>
      </div>
      <label class="check small"><input type="checkbox" id="soundOn" checked/> 🔔 Sound for new ${esc(labels.order.toLowerCase())}s</label>
    </div>
    <div id="orderList" class="orders"></div>`;

  root.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => { tab = b.dataset.tab; root.querySelectorAll("[data-tab]").forEach((x) => x.classList.toggle("active", x === b)); draw(); }));

  const unsub = onSnapshot(query(col, orderBy("createdAt", "desc"), limit(200)), (snap) => {
    orders = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const newIds = orders.filter((o) => o.status === firstStatus).map((o) => o.id);
    if (seen && root.querySelector("#soundOn")?.checked && newIds.some((id) => !seen.has(id))) beep();
    seen = new Set(orders.map((o) => o.id));
    draw();
  });

  function draw() {
    const list = root.querySelector("#orderList");
    const active = orders.filter((o) => activeStatuses.includes(o.status));
    root.querySelector("#cntActive").textContent = active.length;
    const rows = tab === "active" ? active : tab === "done" ? orders.filter(isDone) : orders.filter((o) => o.status === "cancelled");
    list.innerHTML = rows.length ? "" : `<div class="tile muted">No ${tab === "active" ? "active" : tab} ${labels.order.toLowerCase()}s.</div>`;
    if (tab === "active") rows.sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0)); // oldest first
    rows.forEach((o) => list.appendChild(orderCard(o)));
  }

  function orderCard(o) {
    const t = o.createdAt?.toDate?.();
    const mins = t ? Math.floor((Date.now() - t) / 60000) : 0;
    const stepIdx = flow.findIndex((f) => f[0] === o.status);
    const next = flow[stepIdx + 1];
    const stLabel = o.status === "cancelled" ? "Cancelled" : o.status === "unconfirmed" ? "⏳ Awaiting confirmation" : o.status === "out_for_delivery" ? "Out for delivery" : o.status === "delivered" ? "Delivered" : flow[stepIdx]?.[1] || o.status;
    const sched = o.scheduledAt?.toDate?.();
    const card = html(`
      <div class="ocard st-${esc(o.status)} ${o.status === firstStatus ? "new" : ""}">
        <div class="ohead">
          <div><span class="ono">#${o.orderNo}</span> <span class="pill ${o.status === "cancelled" ? "locked" : o.status === firstStatus ? "trial" : "active"}">${esc(stLabel)}</span>${o.paid ? ` <span class="pill active">Paid</span>` : ""}</div>
          <div class="small muted">${t ? t.toLocaleTimeString("en-PH", { hour: "2-digit", minute: "2-digit" }) : ""} · ${mins} min ago</div>
        </div>
        <div class="osub">${sched ? `<span class="pill trial">⏰ ${sched.toLocaleString("en-PH", { weekday: "short", hour: "numeric", minute: "2-digit" })}</span> ` : ""}${o.riderName ? `🛵 ${esc(o.riderName)} · ` : ""}${SVC[o.serviceType] || ""}${o.tableLabel ? ` · <b>${esc(o.tableLabel)}</b>` : ""}${o.customer?.name ? ` · ${esc(o.customer.name)}` : ""}${o.customer?.phone ? ` · ${esc(o.customer.phone)}` : ""}${o.customer?.messenger ? " " + msgrBtn(o.customer.messenger, "pill", "💬 Messenger") : ""}${o.etaMinutes ? ` · ETA ${o.etaMinutes} min` : ""}</div>
        ${o.customer?.address ? `<div class="small muted">📍 ${esc(o.customer.address)}</div>` : ""}
        ${o.payment ? `<div class="small">${o.payment.method === "cash" ? `💵 ${esc(o.payment.methodName)}${o.payment.changeFor > o.total ? ` · change for ${money(o.payment.changeFor)}` : ""}` : `📱 ${esc(o.payment.methodName)} · ref ${esc(o.payment.refNo || "")} · ${o.paid ? "verified ✓" : "<b>to verify</b>"}`}${o.customerKey ? ` · ${o.returning ? `<span class="pill active">Returning · ${o.customerOrders}</span>` : `<span class="pill trial">New</span>`}` : ""}</div>` : ""}
        ${o.stations && Object.keys(o.stations).length > 1 && o.status === "preparing" ? `<div class="small">${Object.entries(o.stations).map(([k, v]) => `<span class="pill ${v === "ready" ? "active" : "trial"}">${{ kitchen: "🍳", barista: "☕", counter: "🧾" }[k] || k} ${v === "ready" ? "ready" : "…"}</span>`).join(" ")}</div>` : ""}
        <ul class="olines">${o.items.map((l) => `<li><b>${l.qty}×</b> ${esc(l.name)}${l.choices?.length ? ` <span class="muted">(${l.choices.map((c) => esc(c.label)).join(", ")})</span>` : ""}${l.note ? ` <span class="note">“${esc(l.note)}”</span>` : ""}</li>`).join("")}</ul>
        ${o.note ? `<div class="small note">Note: ${esc(o.note)}</div>` : ""}
        <div class="ofoot">
          <b>${money(o.total, store.settings?.currency)}</b>
          <div class="row wrap" data-acts></div>
        </div>
      </div>`);
    const acts = card.querySelector("[data-acts]");
    const set = (patch) => updateDoc(doc(col, o.id), { ...patch, updatedAt: serverTimestamp() }).catch((e) => toast(e.message, "error"));

    { const rb = html(`<button class="btn ghost sm" title="Report or block this customer">🚩</button>`); rb.onclick = () => import("../clientreport.js").then((m) => m.openClientActions({ kind: "order", id: o.id, storeId, name: o.customer?.name || "" })); acts.appendChild(rb); }
    if (o.status === "cancelled") return card;
    if (o.status === "unconfirmed") {
      const b = html(`<button class="btn sm" type="button">✅ Confirmed</button>`); b.onclick = () => set({ status: store.mode === "pickup" ? "received" : "pending", confirmedAt: serverTimestamp() }); acts.appendChild(b);
      const c = html(`<button class="btn ghost sm danger-text" type="button">Cancel</button>`); c.onclick = () => askCancel(o, set); acts.appendChild(c);
      return card;
    }
    if (!o.paid && o.payment && !["cash", "card"].includes(o.payment.method)) { const v = html(`<button class="btn sm" type="button">✓ Verify ${esc(o.payment.methodName)}</button>`); v.onclick = () => { if (confirm(`Seen the ${o.payment.methodName} payment (ref ${o.payment.refNo || "—"})?`)) orderOp(storeId, "verify", { orderId: o.id }).catch((e) => toast(e.message, "error")); }; acts.appendChild(v); }
    if (o.serviceType === "delivery" && (o.status === "ready" || o.status === "out_for_delivery")) {
      if (o.status === "ready") { const b = html(`<button class="btn sm" type="button">🛵 Out for delivery</button>`); b.onclick = () => { const n = prompt("Rider name:", o.riderName || ""); if (n !== null) set({ status: "out_for_delivery", riderName: n || "Rider", outAt: serverTimestamp() }); }; acts.appendChild(b); }
      else { const b = html(`<button class="btn sm" type="button">✓ Delivered</button>`); b.onclick = () => set({ status: "delivered", deliveredAt: serverTimestamp(), completedAt: serverTimestamp() }); acts.appendChild(b); }
    } else if (next) {
      const b = html(`<button class="btn sm" type="button">${o.status === firstStatus ? "✅ Accept" : "→ " + esc(next[1])}</button>`);
      b.onclick = () => {
        if (o.status === firstStatus && store.mode === "table") return askEta(o, next[0], set);
        const patch = { status: next[0] };
        if (next[0] === "ready") patch.readyAt = serverTimestamp();
        if (next[0] === doneStatus) patch.completedAt = serverTimestamp();
        set(patch);
      };
      acts.appendChild(b);
    }
    if (!o.paid) {
      const p = html(`<button class="btn ghost sm" type="button">💵 Mark paid</button>`);
      p.onclick = () => {
        const body = html(`<div><p class="muted">How did the customer pay order #${esc(o.orderNo)} (${money(o.total, store.settings?.currency)})?</p><div class="row wrap" style="gap:8px">${payMethods(store).map((m) => `<button class="btn ghost" type="button" data-m="${esc(m.id)}">${m.icon} ${esc(m.name)}</button>`).join("")}</div></div>`);
        body.querySelectorAll("[data-m]").forEach((b) => (b.onclick = async () => { try { await orderOp(storeId, "pay", { orderId: o.id, methodId: b.dataset.m }); closeModal(); toast("Marked paid"); } catch (e) { toast(e.message, "error"); } }));
        openModal({ title: "Mark paid", body });
      };
      acts.appendChild(p);
    }
    if (!isDone(o)) {
      const c = html(`<button class="btn ghost sm danger-text" type="button">Cancel</button>`);
      c.onclick = () => askCancel(o, set);
      acts.appendChild(c);
    }
    return card;
  }

  function askEta(o, nextStatus, set) {
    const body = html(`<div><p class="muted">How long until order #${o.orderNo} is ready?</p>
      <div class="row wrap" data-etas>${[5, 10, 15, 20, 30, 45].map((m) => `<button class="btn ghost" type="button" data-m="${m}">${m} min</button>`).join("")}</div></div>`);
    body.querySelectorAll("[data-m]").forEach((b) => (b.onclick = () => { set({ status: nextStatus, etaMinutes: Number(b.dataset.m), acceptedAt: serverTimestamp() }); closeModal(); }));
    openModal({ title: "Accept order", body });
  }

  function askCancel(o, set) {
    const body = html(`<div><p class="muted">Cancel order #${o.orderNo}?</p><label>Reason (visible to customer)</label>
      <select name="reason"><option>Sold out</option><option>Customer request</option><option>No-show / unpaid</option><option>Kitchen closed</option><option>Other</option></select></div>`);
    const foot = html(`<div class="row" style="justify-content:flex-end"><button class="btn ghost" type="button" data-no>Back</button><button class="btn danger" type="button" data-yes>Cancel order</button></div>`);
    foot.querySelector("[data-no]").onclick = closeModal;
    foot.querySelector("[data-yes]").onclick = () => { orderOp(storeId, "cancel", { orderId: o.id, reason: body.querySelector("select").value }).then(closeModal).catch((e) => toast(e.message, "error")); };
    openModal({ title: "Cancel order", body, footer: foot });
  }

  return unsub;
}
