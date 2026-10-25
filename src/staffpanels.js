// Shared panels for staff screens: Call-staff Requests and Shift start/end tally
import { db } from "./firebase.js";
import { collection, doc, onSnapshot, query, orderBy, limit, where, updateDoc, addDoc, serverTimestamp, arrayUnion, getDocs } from "firebase/firestore";
import { chime } from "./staffauth.js";
import { call } from "./firebase.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const html = (str) => { const t = document.createElement("template"); t.innerHTML = str.trim(); return t.content.firstElementChild; };
const money = (n, c = "PHP") => (c === "PHP" ? "₱" : c + " ") + Number(n || 0).toLocaleString("en-PH", { maximumFractionDigits: 2 });
export const CALL_LABELS = { bill: "💵 Bill out", water: "💧 Water", utensils: "🍴 Utensils", help: "🙋 Help with order", clean: "🧹 Clean table", other: "💬 Other", incident: "⚠️ INCIDENT — manager needed", vip: "👑 Wants to move to a VIP room" };
const QUICK = ["On my way 🏃", "2 minutes please", "Bill coming 🧾", "Noted ✓"];

// =====================================================================
// REQUESTS — live list; returns { unsub, count() }
// =====================================================================
export function watchRequests(storeId, { onChange, sound = true, me = null, quiet = () => false }) {
  let seen = null, rows = [];
  // keeps ringing every 5 s while a call is waiting and this person hasn't taken or passed it (quiet while delivering)
  const waiting = () => rows.some((r) => r.status === "open" && !(r.passedBy || []).includes(me?.staffId));
  const ringer = setInterval(() => { if (sound && waiting() && !quiet()) { chime(0.4); setTimeout(() => chime(0.4), 300); } }, 5000);
  const unsub = onSnapshot(query(collection(db, "stores", storeId, "requests"), orderBy("createdAt", "desc"), limit(100)), (snap) => {
    rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const open = rows.filter((r) => r.status !== "done");
    if (seen && sound && !quiet() && open.some((r) => !seen.has(r.id))) { chime(0.35); setTimeout(() => chime(0.35), 350); }
    seen = new Set(rows.map((r) => r.id));
    onChange(rows, open.length);
  });
  return () => { clearInterval(ringer); unsub(); };
}

export function renderRequests(root, { storeId, me, rows, isManager, currency, duty = null }) {
  // staff who can take calls right now: on duty, app open, not out delivering
  const avail = (duty || []).filter((x) => x.live && !x.delivering && !x.returning && (x.roles || []).some((r) => ["crew", "manager"].includes(r)));
  const open = rows.filter((r) => r.status !== "done");
  const done = rows.filter((r) => r.status === "done").slice(0, 20);
  root.innerHTML = `<div class="rq-list"></div>${done.length ? `<details class="rq-done"><summary>Done today (${done.length})</summary><div class="rq-list small"></div></details>` : ""}`;
  const list = root.querySelector(".rq-list");
  if (!open.length) list.innerHTML = `<div class="k-empty">No requests. 🙂</div>`;
  open.forEach((r) => list.appendChild(card(r)));
  done.forEach((r) => root.querySelector(".rq-done .rq-list")?.appendChild(card(r, true)));

  function card(r, isDone = false) {
    const t = r.createdAt?.toDate?.();
    const mins = t ? Math.floor((Date.now() - t) / 60000) : 0;
    const mine = r.claimedBy && me && r.claimedBy === me.staffId;
    const el = html(`<article class="rq ${r.status} ${mine ? "mine" : ""}">
      <div class="top"><div><div class="no">${esc(r.tableLabel || "—")}</div><div class="ty">${CALL_LABELS[r.type] || esc(r.type)}</div></div>
        <div class="time">${mins} min${r.status === "claimed" ? `<span class="who">${esc(r.claimedByName || "")}</span>` : ""}</div></div>
      <div class="th">${(r.messages || []).map((m) => `<div class="m ${m.from}"><span>${esc(m.text)}</span><small>${m.from === "customer" ? "Customer" : esc(m.staffName || "Staff")}</small></div>`).join("")}</div>
      <div class="acts"></div>
    </article>`);
    if (isDone) return el;
    const acts = el.querySelector(".acts");
    const ref = doc(db, "stores", storeId, "requests", r.id);
    const set = (patch) => updateDoc(ref, { ...patch, staffId: me?.staffId || null, updatedAt: serverTimestamp() }).catch((e) => alert(e.message));
    if (r.status === "open") {
      const passed = r.passedBy || [];
      if (passed.length) el.querySelector(".th").insertAdjacentHTML("afterend", `<div class="small muted">⏭ Busy: ${passed.map((id) => esc((duty || []).find((x) => x.staffId === id)?.name || "staff")).join(", ")}</div>`);
      const b = html(`<button class="k-btn primary">✋ Accept · I'll assist</button>`);
      b.onclick = () => set({ status: "claimed", claimedBy: me?.staffId || "staff", claimedByName: me?.name || "Staff", claimedAt: serverTimestamp() });
      acts.appendChild(b);
      // pass to others — not if you're the last one available
      const others = avail.filter((x) => x.staffId !== me?.staffId && !passed.includes(x.staffId));
      if (duty && !passed.includes(me?.staffId)) {
        if (others.length) { const p = html(`<button class="k-btn sm">⏭ Busy now · pass to others</button>`); p.onclick = () => set({ passedBy: arrayUnion(me?.staffId || "staff") }); acts.appendChild(p); }
        else acts.appendChild(html(`<span class="small" style="color:var(--new);font-weight:700">You are the only one available — please accept.</span>`));
      }
      if (isManager && avail.length) {
        const a = html(`<select class="k-input sm" style="max-width:200px"><option value="">Assign to…</option>${avail.map((x) => `<option value="${esc(x.staffId)}">👤 ${esc(x.name)}</option>`).join("")}</select>`);
        a.onchange = () => { const x = avail.find((y) => y.staffId === a.value); if (x) set({ status: "claimed", claimedBy: x.staffId, claimedByName: x.name, claimedAt: serverTimestamp(), assignedBy: me?.name || "Manager" }); };
        acts.appendChild(a);
      }
    } else if (mine || isManager) {
      const q = html(`<div class="rq-quick">${QUICK.map((x) => `<button>${x}</button>`).join("")}</div>`);
      q.querySelectorAll("button").forEach((b) => (b.onclick = () => set({ messages: arrayUnion({ from: "staff", staffName: me?.name || "Staff", text: b.textContent, at: Date.now() }) })));
      acts.appendChild(q);
      const row = html(`<div class="rq-reply"><input placeholder="Reply…" maxlength="200"/><button class="k-btn sm">Send</button></div>`);
      row.querySelector("button").onclick = () => { const v = row.querySelector("input").value.trim(); if (v) { set({ messages: arrayUnion({ from: "staff", staffName: me?.name || "Staff", text: v, at: Date.now() }) }); row.querySelector("input").value = ""; } };
      acts.appendChild(row);
      const d = html(`<button class="k-btn ready">✓ Done</button>`); d.onclick = () => set({ status: "done", doneAt: serverTimestamp() }); acts.appendChild(d);
      const rel = html(`<button class="k-btn sm">Release</button>`); rel.onclick = () => set({ status: "open", claimedBy: null, claimedByName: null, claimedAt: null }); acts.appendChild(rel);
    } else {
      acts.appendChild(html(`<span class="muted small">Handled by ${esc(r.claimedByName || "staff")}</span>`));
    }
    return el;
  }
}

// =====================================================================
// SHIFTS — start / end with cash tally
// =====================================================================
export function watchOpenShift(storeId, cb) {
  return onSnapshot(query(collection(db, "stores", storeId, "shifts"), where("status", "in", ["open", "needs_count", "pending_check", "investigating"]), limit(1)), (snap) => cb(!snap.docs.length ? null : { id: snap.docs[0].id, ...snap.docs[0].data() }), () => cb(null));
}

export async function startShift(storeId, me, startingCash, note = "") {
  const ref = await addDoc(collection(db, "stores", storeId, "shifts"), {
    status: "open", openedBy: me?.staffId || null, openedByName: me?.name || "Staff", openedAt: serverTimestamp(), startingCash: Number(startingCash) || 0, note,
    createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
  });
  return ref.id;
}

/** Shift tally from orders since openedAt */
export async function computeShiftTally(storeId, shift, flowDoneKey) {
  const since = shift.openedAt?.toDate?.() || new Date(Date.now() - 12 * 3600e3);
  const snap = await getDocs(query(collection(db, "stores", storeId, "orders"), where("createdAt", ">=", since), orderBy("createdAt", "desc"), limit(1000)));
  let orders = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((o) => !o.test);
  // salon: appointments paid during the shift count as sales (home-service cash collected by staff is listed separately)
  try {
    const ap = await getDocs(query(collection(db, "stores", storeId, "appointments"), where("startAt", ">=", since), orderBy("startAt", "desc"), limit(1000)));
    const raw = ap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((a) => !a.test);
    // reservation fees (DP) received during this shift count under their payment method
    const sinceMs = since.getTime();
    const dps = raw.filter((a) => a.dp && ["verified", "used", "forfeited"].includes(a.dp.status) && (a.dp.verifiedAt || 0) >= sinceMs).map((a) => ({ id: a.id + "_dp", orderNo: a.code + " DP", total: a.dp.amount, paid: true, paymentMethodId: a.dp.methodId, paymentMethod: a.dp.methodName, status: "dp", items: [] }));
    const appts = raw.map((a) => ({ ...a, orderNo: a.code, total: a.paid && a.amountDue != null ? a.amountDue : (a.total || 0) + (a.homeFee || 0) - (a.dp && a.dp.status === "verified" ? a.dp.amount : 0), status: a.status === "done" ? flowDoneKey : a.status === "no_show" ? "cancelled" : a.status, readyAt: a.doneAt, createdAt: a.startAt, items: (a.items || []).map((l) => ({ name: l.name, qty: 1 })), paymentMethod: a.cashCollectedBy ? `cash (home · ${a.cashCollectedBy})` : a.paymentMethod }));
    // gift cards sold / verified during this shift = money received
    let gcs = [];
    try { const gq = await getDocs(query(collection(db, "stores", storeId, "giftcards"), where("activatedAt", ">=", sinceMs))); gcs = gq.docs.map((d) => d.data()).filter((g) => !g.test && g.payment).map((g) => ({ orderNo: g.code, total: g.amount, paid: true, paymentMethodId: g.payment.methodId, paymentMethod: g.payment.methodName, status: "dp", items: [] })); } catch {}
    orders = orders.concat(appts, dps, gcs);
  } catch {}
  const ok = orders.filter((o) => o.status !== "cancelled");
  // refunds given during this shift (cash refunds leave the drawer)
  let refunds = [];
  try { const rq = await getDocs(query(collection(db, "stores", storeId, "refunds"), where("at", ">=", since))); refunds = rq.docs.map((d) => d.data()); } catch {}
  const refundCash = refunds.filter((r) => (r.method || "cash") === "cash").reduce((a, r) => a + (r.amount || 0), 0);
  const refundTotal = refunds.reduce((a, r) => a + (r.amount || 0), 0);
  const byMethod = {};
  // group by the method the staff picked (its id) — falls back to the method type for older orders
  ok.filter((o) => o.paid).forEach((o) => { const m = o.paymentMethodId || o.payment?.methodId || o.paymentMethod || "cash"; byMethod[m] = (byMethod[m] || 0) + (o.total || 0); });
  const counts = {};
  ok.forEach((o) => o.items.forEach((l) => (counts[l.name] = (counts[l.name] || 0) + l.qty)));
  const lost = (k) => orders.filter((o) => o.status === "cancelled" && o.outcome === k);
  const lostSum = (k) => lost(k).reduce((a, o) => a + (o.total || 0), 0);
  const prep = ok.filter((o) => o.readyAt && o.createdAt).map((o) => (o.readyAt.toMillis() - o.createdAt.toMillis()) / 60000);
  return {
    orders: orders.filter((o) => o.status !== "dp").length,
    completed: orders.filter((o) => o.status === flowDoneKey).length,
    cancelled: orders.filter((o) => o.status === "cancelled").length,
    sales: ok.reduce((a, o) => a + (o.total || 0), 0),
    paidTotal: ok.filter((o) => o.paid).reduce((a, o) => a + (o.total || 0), 0),
    unpaidTotal: ok.filter((o) => !o.paid).reduce((a, o) => a + (o.total || 0), 0),
    byMethod,
    cashSales: byMethod.cash || 0,
    refunds: refunds.length, refundTotal, refundCash,
    topItems: Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, qty]) => ({ name, qty })),
    walkouts: lost("walkout").length, walkoutTotal: lostSum("walkout"),
    noShows: lost("no_show").length, noShowTotal: lostSum("no_show"),
    failedDeliveries: lost("failed_delivery").length, failedTotal: lostSum("failed_delivery"),
    avgPrepMin: prep.length ? Math.round(prep.reduce((a, b) => a + b, 0) / prep.length) : null,
  };
}

export async function endShift(storeId, shift, me, { countedCash, note, tally }) {
  const expectedCash = (Number(shift.startingCash) || 0) + (tally.cashSales || 0) - (tally.refundCash || 0);
  const variance = Math.round((Number(countedCash) - expectedCash) * 100) / 100;
  await updateDoc(doc(db, "stores", storeId, "shifts", shift.id), {
    status: "closed", closedBy: me?.staffId || null, closedByName: me?.name || "Staff", closedAt: serverTimestamp(),
    countedCash: Number(countedCash) || 0, expectedCash, variance, tally, closeNote: note || "", updatedAt: serverTimestamp(),
  });
  return { expectedCash, variance };
}

/** Tally HTML (dark theme classes) */
export function tallyHTML(shift, tally, currency = "PHP") {
  const exp = (Number(shift?.startingCash) || 0) + (tally.cashSales || 0) - (tally.refundCash || 0);
  return `<div class="k-sum">
    <div class="box"><div class="k">Orders</div><div class="v">${tally.orders}</div></div>
    <div class="box"><div class="k">Completed / Cancelled</div><div class="v">${tally.completed} / ${tally.cancelled}</div></div>
    <div class="box"><div class="k">Sales (excl. cancelled)</div><div class="v">${money(tally.sales, currency)}</div></div>
    <div class="box"><div class="k">Unpaid</div><div class="v">${money(tally.unpaidTotal, currency)}</div></div>
    ${Object.entries(tally.byMethod || {}).map(([m, v]) => `<div class="box"><div class="k">Paid · ${esc(m)}</div><div class="v">${money(v, currency)}</div></div>`).join("")}
    <div class="box"><div class="k">Starting cash</div><div class="v">${money(shift?.startingCash, currency)}</div></div>
    <div class="box"><div class="k">Expected cash in drawer</div><div class="v">${money(exp, currency)}</div></div>
    ${tally.refunds ? `<div class="box" style="border-color:var(--late)"><div class="k">💸 Refunds (${tally.refunds})</div><div class="v">${money(tally.refundTotal, currency)}${tally.refundCash ? ` <span class="small muted">· cash ${money(tally.refundCash, currency)}</span>` : ""}</div></div>` : ""}
    ${tally.walkouts ? `<div class="box" style="border-color:var(--late)"><div class="k">💸 Walked out / unpaid (${tally.walkouts})</div><div class="v">${money(tally.walkoutTotal, currency)}</div></div>` : ""}
    ${tally.noShows ? `<div class="box"><div class="k">🚫 No-show pickups (${tally.noShows})</div><div class="v">${money(tally.noShowTotal, currency)}</div></div>` : ""}
    ${tally.failedDeliveries ? `<div class="box"><div class="k">📦 Failed deliveries (${tally.failedDeliveries})</div><div class="v">${money(tally.failedTotal, currency)}</div></div>` : ""}
    ${tally.avgPrepMin != null ? `<div class="box"><div class="k">Avg. prep time</div><div class="v">${tally.avgPrepMin} min</div></div>` : ""}
  </div>
  <div class="k-top"><h3 style="margin:0 0 6px">Top items</h3>${(tally.topItems || []).map((t) => `<div><span>${esc(t.name)}</span><b>${t.qty}</b></div>`).join("") || `<p class="muted">—</p>`}</div>`;
}

// ---------------- order tags: payment / customer / confirm ----------------
const ord = (n) => { n = Number(n) || 1; const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };
export function orderTagsHTML(o, cur = "PHP") {
  const tags = [];
  const pm = o.payment;
  if (pm) {
    if (pm.method === "cash") tags.push(`<span class="k-tag" style="color:var(--new)">💵 ${esc(pm.methodName)}${pm.changeFor && pm.changeFor > o.total ? ` · change for ${money(pm.changeFor, cur)} = ${money(pm.changeFor - o.total, cur)}` : ""}</span>`);
    else tags.push(`<span class="k-tag" style="color:${o.paid ? "var(--ready)" : "var(--new)"}">📱 ${esc(pm.methodName)} · ref ${esc(pm.refNo || "—")} · ${o.paid ? "verified ✓" : "TO VERIFY"}</span>`);
  }
  if (o.parentId) tags.push(`<span class="k-tag" style="color:#fff;background:#b8326a">➕ ADD-ON for #${esc(o.parentOrderNo)}</span>`);
  if (o.addOns?.length) tags.push(`<span class="k-tag">+${o.addOns.length} add-on order${o.addOns.length > 1 ? "s" : ""}</span>`);
  if (o.freeDelivery) tags.push(`<span class="k-tag" style="color:var(--ready)">🛵 Free delivery</span>`);
  if (o.smallOrderFee) tags.push(`<span class="k-tag">Small-order fee ${money(o.smallOrderFee, cur)}</span>`);
  if (o.discounts?.promo) tags.push(`<span class="k-tag" style="color:var(--new)">🏷️ Promo −${money(o.discounts.promo, cur)}</span>`);
  if (o.voucher) tags.push(`<span class="k-tag" style="color:var(--new)">🎟️ ${esc(o.voucher.code)} −${money(o.voucher.discount, cur)}</span>`);
  if (o.customerKey) tags.push(o.returning ? `<span class="k-tag" style="color:var(--ready)">🔁 Returning · ${ord(o.customerOrders + 1)} order</span>` : `<span class="k-tag">⭐ New customer · 1st order</span>`);
  if (o.risk?.walkouts) tags.push(`<span class="k-tag risk">🏃 Didn't pay before ${o.risk.walkouts}×</span>`);
  if (o.risk?.noShows) tags.push(`<span class="k-tag risk">🚫 No-show before ${o.risk.noShows}×</span>`);
  if (o.risk?.failed) tags.push(`<span class="k-tag risk">📦 Failed delivery before ${o.risk.failed}×</span>`);
  if (o.pack) tags.push(`<span class="k-tag" style="color:#fff;background:#7a4b00">🥡 PACK FOR TAKE-OUT</span>`);
  if (o.test) tags.push(`<span class="k-tag test">🧪 TEST — don't cook</span>`);
  if (o.balanceDue) tags.push(`<span class="k-tag risk">💰 Balance to collect ${money(o.balanceDue, cur)}</span>`);
  if (o.refundDue) tags.push(`<span class="k-tag" style="color:var(--new)">↩ Give back ${money(o.refundDue, cur)}</span>`);
  if (o.heldForAddOn) tags.push(`<span class="k-tag" style="color:var(--new)">⏸ Wait for the add-on before handing out</span>`);
  (o.comps || []).forEach((c) => tags.push(`<span class="k-tag" style="color:#a3175a">🎁 ${esc(c.text)}</span>`));
  if (o.lastEdit) tags.push(`<span class="k-tag">✏️ Edited by ${esc(o.lastEdit.by)}: ${esc(o.lastEdit.summary)}</span>`);
  if (o.status === "unconfirmed") tags.push(`<span class="k-tag" style="color:var(--danger)">⏳ Awaiting confirmation${o.confirmDeadline ? " · until " + o.confirmDeadline.toDate().toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" }) : ""}</span>`);
  return tags.length ? `<div class="k-tags">${tags.join("")}</div>` : "";
}

// =====================================================================
// INCIDENTS — staff panel (manager/crew)
// =====================================================================
export const INC_TYPES = { cash: "💰 Cash count mismatch", wrong: "Wrong order", missing: "Missing items", quality: "Quality", late: "Late", hygiene: "Hygiene", other: "Other" };
export function watchIncidents(storeId, { onChange, sound = true }) {
  let seen = null;
  return onSnapshot(query(collection(db, "stores", storeId, "incidents"), orderBy("createdAt", "desc"), limit(100)), (snap) => {
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const open = rows.filter((r) => ["open", "in_discussion"].includes(r.status));
    if (seen && sound && open.some((r) => !seen.has(r.id))) { chime(0.4); setTimeout(() => chime(0.4), 300); setTimeout(() => chime(0.4), 600); }
    seen = new Set(rows.map((r) => r.id));
    onChange(rows, open.length);
  });
}

export function renderIncidents(root, { storeId, me, rows, canResolve, maxVoucher, currency }) {
  const open = rows.filter((r) => ["open", "in_discussion"].includes(r.status));
  const closed = rows.filter((r) => !["open", "in_discussion"].includes(r.status)).slice(0, 20);
  root.innerHTML = `<div class="rq-list"></div>${closed.length ? `<details class="rq-done"><summary>Resolved / dismissed (${closed.length})</summary><div class="rq-list small"></div></details>` : ""}`;
  const list = root.querySelector(".rq-list");
  if (!open.length) list.innerHTML = `<div class="k-empty">No open incidents. 🙂</div>`;
  open.forEach((r) => list.appendChild(card(r)));
  closed.forEach((r) => root.querySelector(".rq-done .rq-list")?.appendChild(card(r, true)));

  function card(r, isDone = false) {
    const t = r.createdAt?.toDate?.();
    const remote = r.serviceType === "pickup" || r.serviceType === "delivery";
    const el = html(`<article class="rq ${r.status === "in_discussion" ? "claimed" : r.status === "open" ? "open" : "done"}" style="border-top-color:${isDone ? "var(--line)" : "var(--danger)"}">
      <div class="top"><div><div class="no">⚠️ #${r.orderNo}</div><div class="ty">${INC_TYPES[r.type] || esc(r.type)} · ${r.tableLabel ? esc(r.tableLabel) : esc(r.serviceType || "")}</div></div>
        <div class="time">${t ? t.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" }) : ""}<span class="who">${r.status === "in_discussion" ? "In discussion · " + esc(r.claimedByName || "") : r.status === "open" ? "Open" : esc(r.status)}</span></div></div>
      <div class="small">${esc(r.customerName || "")} ${esc(r.customerPhone || "")} · order ${money(r.total, currency)}</div>
      <div class="m customer" style="margin:8px 0">${esc(r.description)}</div>
      ${r.photoUrl ? `<a href="${esc(r.photoUrl)}" target="_blank"><img src="${esc(r.photoUrl)}" alt="proof" style="width:100%;max-height:220px;object-fit:cover;border-radius:10px"/></a>` : remote ? `<div class="small" style="color:var(--danger)">No photo proof</div>` : ""}
      <div class="th">${(r.messages || []).map((m) => `<div class="m ${m.from}"><span>${esc(m.text)}</span><small>${m.from === "customer" ? "Customer" : esc(m.staffName || "Staff")}</small></div>`).join("")}</div>
      ${r.resolution ? `<div class="k-tag" style="display:block;padding:8px;color:${r.status === "dismissed" ? "var(--danger)" : "var(--ready)"}">${r.status === "dismissed" ? "Dismissed" : r.resolution.type === "voucher" ? `Voucher ${esc(r.resolution.voucherCode)} (${r.resolution.mode === "percent" ? r.resolution.amount + "%" : money(r.resolution.amount, currency)})` : r.resolution.type === "refund" ? `Refund ${money(r.resolution.amount, currency)} · ${esc(r.resolution.method || "")}` : r.resolution.type === "remake" ? "Remake sent to kitchen" : "Resolved"} — ${esc(r.resolution.note || "")} <span class="muted">by ${esc(r.resolution.by || "")}</span></div>` : ""}
      <div class="acts"></div></article>`);
    if (isDone) return el;
    const acts = el.querySelector(".acts");
    const act = (payload) => call("resolveIncident", { incidentId: r.id, staffToken: me?.token || null, ...payload }).catch((e) => alert(e.message));
    if (r.status === "open" && !r.claimedBy) { const b = html(`<button class="k-btn primary">✋ I'll handle this</button>`); b.onclick = () => act({ action: "claim" }); acts.appendChild(b); }
    const row = html(`<div class="rq-reply"><input placeholder="Message to customer…" maxlength="300"/><button class="k-btn sm">Send</button></div>`);
    row.querySelector("button").onclick = () => { const v = row.querySelector("input").value.trim(); if (v) { act({ action: "message", text: v }); row.querySelector("input").value = ""; } };
    acts.appendChild(row);
    if (r.customerPhone && r.source !== "shift") {
      const h = rows.filter((x) => x.customerPhone && x.customerPhone === r.customerPhone);
      if (h.length > 1) el.querySelector(".acts").insertAdjacentHTML("beforebegin", `<div class="small" style="color:var(--new)">📋 This customer: ${h.length} reports · ${h.filter((x) => x.status === "dismissed").length} dismissed · ${h.filter((x) => x.resolution?.type === "refund").length} refunded</div>`);
    }
    if (r.source === "shift") {
      if (canResolve) { const b = html(`<button class="k-btn ready">✓ Explained / resolved</button>`); b.onclick = () => { const why = prompt("What happened? (saved in the record)"); if (why && why.trim().length >= 3) act({ action: "dismiss", reason: why.trim() }); }; acts.appendChild(b); }
      return el;
    }
    if (canResolve) {
      if (!remote && r.status === "open" && r.claimedBy) { const b = html(`<button class="k-btn prep">💬 Spoke with customer (in discussion)</button>`); b.onclick = () => act({ action: "discuss" }); acts.appendChild(b); }
      const canFinal = remote || r.status === "in_discussion";
      const res = html(`<div class="rq-quick"><button data-r="voucher" ${canFinal ? "" : "disabled"}>🎟️ Voucher</button><button data-r="refund" ${canFinal ? "" : "disabled"}>💸 Refund</button><button data-r="remake" ${canFinal ? "" : "disabled"}>🔁 Remake</button><button data-r="discount" ${canFinal ? "" : "disabled"}>🏷️ Discount this bill</button><button data-r="dismiss">❌ Dismiss</button></div>`);
      if (!canFinal) res.insertAdjacentHTML("beforebegin", `<div class="small muted">Talk to the customer first (In discussion) before resolving.</div>`);
      res.querySelectorAll("[data-r]").forEach((b) => (b.onclick = () => resolveForm(r, b.dataset.r, act)));
      acts.appendChild(res);
    }
    return el;
  }

  function resolveForm(r, type, act) {
    if (type === "dismiss") { const reason = prompt("Reason (visible to customer):", "Insufficient proof."); if (reason) act({ action: "dismiss", reason }); return; }
    if (type === "remake") { const note = prompt("Remake note (optional):", "We'll replace the wrong item"); if (note !== null) act({ action: "resolve", resolution: { type: "remake", note } }); return; }
    if (type === "voucher") {
      const amt = prompt(`Voucher amount (₱)${maxVoucher ? ` — max ${money(maxVoucher, currency)} for crew` : ""}:`, "50");
      if (amt === null) return;
      const amount = Number(amt) || 0;
      if (maxVoucher && amount > maxVoucher) return alert(`You can give at most ${money(maxVoucher, currency)}. A manager is needed for larger amounts.`);
      const note = prompt("Note to customer (optional):", "We're sorry. We hope to make it up to you next time!") || "";
      act({ action: "resolve", resolution: { type: "voucher", amount, mode: "amount", note } }); return;
    }
    if (type === "discount") {
      const amt = prompt(`Discount on the current bill (₱) — order total ${money(r.total, currency)}. Only for unpaid orders:`, "50"); if (amt === null) return;
      const amount = Number(amt) || 0;
      if (maxVoucher && amount > maxVoucher) return alert(`You can give at most ${money(maxVoucher, currency)}. A manager is needed for larger amounts.`);
      act({ action: "resolve", resolution: { type: "discount", amount, note: "Discount on your bill — sorry about this" } }); return;
    }
    if (type === "refund") {
      const amt = prompt(`Refund amount (₱) — order total ${money(r.total, currency)}:`, String(r.total)); if (amt === null) return;
      const method = prompt("Method (cash / gcash / maya):", r.serviceType === "delivery" ? "gcash" : "cash") || "cash";
      const refNo = method !== "cash" ? prompt("Refund reference no. (optional):", "") || "" : "";
      const note = prompt("Note to customer (optional):", "") || "";
      act({ action: "resolve", resolution: { type: "refund", amount: Number(amt) || 0, method, refNo, note } });
    }
  }
}

// =====================================================================
// ANNOUNCEMENTS for staff — small strip below the header
// =====================================================================
export function mountStaffNotes(storeId) {
  const head = document.getElementById("head"); if (!head) return () => {};
  let el = document.getElementById("staffNotes");
  if (!el) { el = document.createElement("div"); el.id = "staffNotes"; el.className = "k-notes"; head.insertAdjacentElement("afterend", el); }
  const today = () => new Date().toISOString().slice(0, 10);
  return onSnapshot(query(collection(db, "stores", storeId, "announcements"), where("active", "==", true)), (snap) => {
    const t = today();
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((a) => a.audience?.staff && (!a.dateFrom || a.dateFrom <= t) && (!a.dateTo || a.dateTo >= t)).sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
    el.innerHTML = rows.map((a) => `<div class="k-note">📣 <b>${esc(a.title)}</b>${a.body ? ` — ${esc(a.body)}` : ""}</div>`).join("");
    el.style.display = rows.length ? "" : "none";
  }, () => {});
}

// =====================================================================
// SHIFT CLOSE — blind count → pending_check → verify (PIN) → investigate / resolve
// =====================================================================
const RESOLUTIONS = { explained: "Explained — no fault", staff_error: "Staff error — deduction recorded", store_absorbs: "Store absorbs", over_deposit: "Over — deposited to store", none: "Verified — no variance" };
const askPin = async (storeId, me) => {
  const pin = prompt(`${me?.name || "Staff"} — enter your PIN to sign this:`); if (pin == null) return null;
  try { const r = await call("verifyPin", { staffId: me.staffId, pin }); return r.data || r; } catch (e) { alert(e.message); return null; }
};
/** Step 1: submit counts (blind). Expected values are computed and stored but not shown when blindCount is on. */
export function closeShiftForm({ storeId, me, shift, tally, store, currency, onDone }) {
  const cfg = store.settings?.shifts || {}; const blind = true; // always a blind count
  const methods = [{ id: "cash", type: "cash", name: "Cash in drawer" }, ...(store.settings?.payments?.methods || []).filter((m) => m.enabled !== false && m.type !== "cash").map((m) => ({ id: m.id, type: m.type, name: m.name }))];
  const el = html(`<div>
    <p class="muted small">${blind ? "Blind count: enter what you actually counted. Expected totals are shown only after you submit." : "Enter what you counted."}</p>
    ${methods.map((m) => `<label>${esc(m.name)} — counted total (₱)</label><input type="number" min="0" step="0.01" class="k-input" data-m="${esc(m.id)}" placeholder="0"/>`).join("")}
    ${cfg.externalPos ? `<label>External POS end-of-day total (Z-reading) (₱)</label><input type="number" min="0" step="0.01" class="k-input" data-pos placeholder="Total sales on the other POS"/><label>Z-reading reference no. (optional)</label><input class="k-input" data-posref/>` : ""}
    <label>Note (optional)</label><input class="k-input" data-note placeholder="e.g. gave ₱20 change from own pocket"/>
    <button class="k-btn" data-submit style="margin-top:12px;width:100%;background:var(--danger);color:#fff;border-color:var(--danger)">■ Submit count & end shift (PIN)</button>
  </div>`);
  el.querySelector("[data-submit]").onclick = async () => {
    const counted = {}; for (const m of methods) { const v = el.querySelector(`[data-m="${m.id}"]`).value; if (v === "") return alert(`Enter the counted total for ${m.name}.`); counted[m.id] = Number(v); }
    const posTotal = cfg.externalPos ? Number(el.querySelector("[data-pos]").value || 0) : null;
    const who = await askPin(storeId, me); if (!who) return;
    // expected per method (cash = starting + cash sales; others = paid by that method)
    const expected = {}; for (const m of methods) expected[m.id] = m.id === "cash" ? (Number(shift.startingCash) || 0) + (tally.byMethod?.cash || 0) : (tally.byMethod?.[m.id] || 0) + (m.id !== m.type && methods.filter((x) => x.type === m.type).length === 1 ? (tally.byMethod?.[m.type] || 0) : 0);
    const variance = {}; for (const m of methods) variance[m.id] = Math.round((counted[m.id] - expected[m.id]) * 100) / 100;
    if (posTotal != null) { expected.pos = tally.paidTotal || 0; variance.pos = Math.round((posTotal - expected.pos) * 100) / 100; counted.pos = posTotal; }
    const worst = Math.max(...Object.values(variance).map((v) => Math.abs(v)), 0);
    const auto = worst <= (Number(cfg.tolerance) || 0);
    await updateDoc(doc(db, "stores", storeId, "shifts", shift.id), {
      status: auto ? "closed" : "pending_check", closedBy: who.staffId, closedByName: who.name, closedAt: serverTimestamp(), tally, counted, expected, variance, maxVariance: worst,
      countedCash: counted.cash, expectedCash: expected.cash, posTotal, posRef: cfg.externalPos ? el.querySelector("[data-posref]").value.trim() : null, closeNote: el.querySelector("[data-note]").value.trim(),
      ...(auto ? { verifiedBy: "auto", verifiedByName: "Auto (within tolerance)", verifiedAt: serverTimestamp(), resolution: "none" } : {}), methodNames: Object.fromEntries(methods.map((m) => [m.id, m.name])), updatedAt: serverTimestamp(),
    });
    onDone?.({ auto, variance, expected, counted, worst });
  };
  return el;
}
/** Step 2: verify / investigate / resolve. */
export function verifyShiftPanel({ storeId, me, shift, store, currency, onDone }) {
  const cfg = store.settings?.shifts || {};
  const canVerify = (me?.roles || []).includes("manager") || cfg.whoVerify === "any";
  const names = shift.methodNames || {};
  // blind count: the cashier who counted never sees the expected totals / difference
  const seeNums = canVerify && (me?.staffId === "owner" || me?.owner || me?.staffId !== shift.closedBy);
  const rows = !seeNums ? "" : Object.keys(shift.expected || {}).map((k) => { const e = shift.expected[k], c = shift.counted?.[k], v = shift.variance?.[k] || 0; return `<tr><td>${esc(k === "pos" ? "External POS total" : names[k] || k)}</td><td>${money(e, currency)}</td><td>${money(c, currency)}</td><td style="color:${v === 0 ? "var(--ready)" : "var(--danger)"};font-weight:700">${v === 0 ? "✓" : (v > 0 ? "+" : "−") + money(Math.abs(v), currency) + (v < 0 ? " short" : " over")}</td></tr>`; }).join("");
  const el = html(`<div>
    <p class="muted small">Closed by <b>${esc(shift.closedByName || "")}</b> ${shift.closedAt?.toDate ? shift.closedAt.toDate().toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" }) : ""}${shift.closeNote ? ` · "${esc(shift.closeNote)}"` : ""}${shift.posRef ? ` · Z-ref ${esc(shift.posRef)}` : ""}</p>
    <span class="k-tag" style="${shift.status === "investigating" ? "background:#fde8e6;color:#b4423a" : ""}">${shift.status === "investigating" ? "🔍 Under investigation" : "⏳ Pending check"}</span>
    ${seeNums ? `<table class="k-table" style="width:100%;margin-top:10px"><thead><tr><th>Method</th><th>Expected</th><th>Counted</th><th>Variance</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="muted small" style="margin-top:10px">Blind count — the expected totals and the difference are shown only to the manager who checks this shift.</p>`}
    ${(shift.messages || []).length ? `<div class="k-thread" style="margin-top:10px">${shift.messages.map((m) => `<div class="small"><b>${esc(m.by)}</b> <span class="muted">${new Date(m.at).toLocaleString("en-PH", { dateStyle: "short", timeStyle: "short" })}</span><br>${esc(m.text)}</div>`).join("")}</div>` : ""}
    ${canVerify ? `
    <label style="margin-top:12px">Explanation / finding</label><textarea class="k-input" data-note rows="2" placeholder="What happened? (required when investigating or resolving)"></textarea>
    <div class="row wrap" style="gap:8px;margin-top:8px">
      ${shift.maxVariance ? `<button class="k-btn" data-inv>🔍 Investigate (keep open)</button>` : ""}
      <button class="k-btn ready" data-ok>${shift.maxVariance ? "Resolve & close (PIN)" : "✓ Verify & close (PIN)"}</button>
    </div>
    ${shift.maxVariance ? `<label style="margin-top:10px">Resolution</label><select class="k-input" data-res>${Object.entries(RESOLUTIONS).filter(([k]) => k !== "none").map(([k, l]) => `<option value="${k}">${l}</option>`).join("")}</select>
    <label>Deduction to record (₱) — record only, not auto-deducted</label><input type="number" min="0" class="k-input" data-deduct value="0"/>` : ""}` : `<p class="muted small" style="margin-top:10px">Only a manager can verify this shift${cfg.whoVerify === "any" ? "" : " (Settings → Shift close)"}.</p>`}
  </div>`);
  const thread = (who, text) => arrayUnion({ by: who.name, staffId: who.staffId, text, at: Date.now() });
  el.querySelector("[data-inv]")?.addEventListener("click", async () => {
    const text = el.querySelector("[data-note]").value.trim(); if (!text) return alert("Write what you found or asked.");
    const who = await askPin(storeId, me); if (!who) return;
    await updateDoc(doc(db, "stores", storeId, "shifts", shift.id), { status: "investigating", messages: thread(who, text), updatedAt: serverTimestamp() }); onDone?.();
  });
  el.querySelector("[data-ok]")?.addEventListener("click", async () => {
    const text = el.querySelector("[data-note]").value.trim();
    const res = shift.maxVariance ? el.querySelector("[data-res]").value : "none";
    const deduct = shift.maxVariance ? Number(el.querySelector("[data-deduct]").value || 0) : 0;
    if (shift.maxVariance && !text) return alert("Write the explanation before resolving.");
    const who = await askPin(storeId, me); if (!who) return;
    const self = who.staffId === shift.closedBy || who.staffId === shift.openedBy;
    if (self && who.staffId !== "owner") {
      const staffN = (await getDocs(query(collection(db, "stores", storeId, "staff"), where("active", "==", true)))).size;
      if (staffN > 1) return alert("You can't check your own shift. Ask another staff member or a manager to count and check it.");
      if (!confirm("You are the only staff member, so you are checking your own shift. It will be marked as self-checked. Continue?")) return;
    }
    await updateDoc(doc(db, "stores", storeId, "shifts", shift.id), { status: "closed", verifiedBy: who.staffId, verifiedByName: who.name, verifiedAt: serverTimestamp(), selfVerified: self, resolution: res, deduction: deduct, resolutionNote: text, ...(text ? { messages: thread(who, text) } : {}), updatedAt: serverTimestamp() }); onDone?.();
  });
  return el;
}
export const RESOLUTION_LABELS = RESOLUTIONS;
