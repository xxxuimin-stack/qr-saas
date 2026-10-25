// Notification bell: things the owner should act on, live (payments to verify, unconfirmed orders, shifts to check, due back, low stock…)
import { db } from "./firebase.js";
import { collection, query, where, onSnapshot, limit } from "firebase/firestore";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let state = null; // { storeId, counts: { key: n }, slots: Set<el>, unsubs: [] }

function sources(ctx) {
  const sid = ctx.storeId, m = ctx.mode, c = (...p) => collection(db, "stores", sid, ...p);
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const L = [
    ["shift", "💰 Shift to check", "/counter/#shift", query(c("shifts"), where("status", "in", ["pending_check", "needs_count", "investigating"]), limit(5))],
  ];
  if (m === "salon") {
    L.push(["help", "🆘 Staff asked for HELP on a home service", "/counter/", query(c("appointments"), where("helpOpen", "==", true), limit(10))]);
    L.push(["overdue", "⏰ Home service running late — check on your staff", "/counter/", query(c("appointments"), where("overdueOpen", "==", true), limit(10))]);
  }
  if (m === "table" || m === "laundry") {
    L.push(["unconf", "💬 Waiting for Messenger confirmation", "#orders", query(c("orders"), where("status", "==", "unconfirmed"), limit(50))]);
    L.push(["verify", "📱 GCash/Maya payments to verify", "#orders", query(c("orders"), where("paid", "==", false), where("createdAt", ">=", t0), limit(100)), (d) => d.payment && !["cash", "card"].includes(d.payment.method) && d.status !== "cancelled"]);
    L.push(["inc", "⚠️ Open incident reports", "/counter/", query(c("incidents"), where("status", "in", ["open", "in_discussion"]), limit(20))]);
  }
  if (m === "salon") {
    L.push(["dp", "💵 Reservation fees to verify", "/counter/", query(c("appointments"), where("dp.status", "==", "to_verify"), limit(50))]);
    L.push(["gift", "🎁 Gift card payments to verify", "/counter/", query(c("giftcards"), where("status", "==", "pending"), limit(50))]);
    L.push(["due", "🔁 Clients to remind today", "/counter/", query(c("customers"), where("nextDue.at", "<", t0.getTime() + 86400e3), limit(200)), (d) => ["due", "snoozed"].includes(d.nextDue?.status) && !d.nextDue?.contactedAt]);
    L.push(["stock", "📦 Products running low", "#menu", query(c("items"), where("retail", "==", true), limit(200)), (d) => d.stock != null && d.stock <= 3]);
    L.push(["unconfA", "💬 Bookings waiting for Messenger", "/counter/", query(c("appointments"), where("status", "==", "unconfirmed"), limit(50))]);
    L.push(["visit", "📞 Next visits to confirm (today / tomorrow)", "#calendar", query(c("appointments"), where("tentative", "==", true), limit(200)), (d) => ["pending", "confirmed"].includes(d.status) && d.visitConfirm?.status === "waiting" && d.startAt?.toMillis?.() < t0.getTime() + 2 * 86400e3 && d.startAt?.toMillis?.() > Date.now() - 3600e3]);
  }
  if (m === "stay") L.push(["stay", "🧳 Bookings to approve", "#stays", query(c("stays"), where("status", "in", ["unconfirmed", "pending"]), limit(50))]);
  return L;
}
function render() {
  if (!state) return;
  const items = state.list.filter(([k]) => state.counts[k] > 0);
  const total = items.reduce((a, [k]) => a + state.counts[k], 0);
  for (const el of state.slots) {
    if (!el.isConnected) { state.slots.delete(el); continue; }
    const open = el.dataset.open === "1";
    el.innerHTML = `<div class="bell"><button class="btn ghost" type="button" aria-haspopup="true" aria-expanded="${open}" aria-label="Notifications${total ? `: ${total} to check` : ""}">🔔${total ? `<span class="cnt">${total > 99 ? "99+" : total}</span>` : ""}</button>
      ${open ? `<div class="bell-pop" role="menu">${items.length ? items.map(([k, label, href]) => `<a role="menuitem" href="${href}" ${href.startsWith("/") ? 'target="_blank" rel="noopener"' : ""}>${esc(label)}<span class="n">${state.counts[k]}</span></a>`).join("") : `<p class="empty" style="padding:10px;margin:0">All clear — nothing to check right now. ✨</p>`}</div>` : ""}</div>`;
    const btn = el.querySelector("button");
    btn.onclick = (e) => { e.stopPropagation(); el.dataset.open = open ? "0" : "1"; render(); if (!open) el.querySelector(".bell-pop a, .bell-pop p")?.focus?.(); };
  }
}
document.addEventListener("click", () => { if (!state) return; let ch = false; for (const el of state.slots) if (el.dataset.open === "1") { el.dataset.open = "0"; ch = true; } if (ch) render(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state) { for (const el of state.slots) el.dataset.open = "0"; render(); } });

export function mountBell(el, ctx) {
  if (!el || ctx.role !== "owner") return;
  if (!state || state.storeId !== ctx.storeId) {
    state?.unsubs.forEach((u) => u());
    state = { storeId: ctx.storeId, counts: {}, slots: new Set(), unsubs: [], list: sources(ctx) };
    for (const [k, , , q, filter] of state.list) state.unsubs.push(onSnapshot(q, (snap) => { state.counts[k] = filter ? snap.docs.filter((d) => filter(d.data())).length : snap.size; render(); }, () => { state.counts[k] = 0; }));
  }
  state.slots.add(el); render();
}
