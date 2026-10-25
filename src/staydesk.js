// Stay / Airbnb — caretaker screen (runs inside /counter/ when store.mode === "stay")
// Approvals (Messenger-confirmed, ID + signature + downpayment), today's arrivals / in-house / departures,
// requests · reschedules · extensions, room housekeeping board.
import { msgrBtn } from "./msgr.js";
import { db, call } from "./firebase.js";
import { hydratePrivate } from "./privfiles.js";
import { collection, doc, onSnapshot, query, orderBy, limit } from "firebase/firestore";
import { chime, startRinging, stopRinging } from "./staffauth.js";

let X = null, stays = [], rooms = [], tab = "today", known = null;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const html = (str) => { const t = document.createElement("template"); t.innerHTML = str.trim(); return t.content.firstElementChild; };
const money = (n) => "₱" + Number(n || 0).toLocaleString("en-PH", { maximumFractionDigits: 2 });
const fmtD = (s) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric" }) : "");
const fmtT = (ts) => (ts?.toDate ? ts.toDate().toLocaleString("en-PH", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const dur = (ms) => { if (ms <= 0) return "now"; const m = Math.floor(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m % 60}m` : `${m % 60}m`; };
const ST = { unconfirmed: ["⏳", "Awaiting Messenger", "wait"], pending: ["🕑", "Needs approval", "wait"], confirmed: ["✅", "Confirmed", "ok"], checked_in: ["🛏", "Checked in", "prog"], checked_out: ["🧹", "Checked out", ""], done: ["✔", "Done", "ok"], cancelled: ["✕", "Cancelled", ""], declined: ["✕", "Declined", ""] };
const HK = { clean: ["✅", "Ready"], to_clean: ["🧹", "To clean"], cleaning: ["🧽", "Cleaning"], occupied: ["🛏", "Occupied"] };
const todayYmd = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

async function act(action, extra = {}) {
  try { await call("stayStaffAction", { action, staffName: X.me?.name || "", ...extra }); } catch (e) { alert(e.message); }
}
const needsMe = (s) => s.deposit?.dispute?.status === "open" || s.needsIdOk || s.roomChange?.status === "pending" || (s.issues || []).some((x) => x.status === "open") || s.refund?.status === "due" || (s.addons || []).some((a) => a.status === "pending") || ["to_verify", "checked"].includes(s.deposit?.status) || (s.status === "checked_in" && s.overstay?.hours) || ["unconfirmed", "pending"].includes(s.status) || (s.requests || []).some((r) => r.status === "pending") || s.reschedule?.status === "pending" || s.extension?.status === "pending" || (s.payment?.status === "to_verify" && !["cancelled", "declined"].includes(s.status));

export function bootStayDesk(ctx) {
  X = ctx;
  X.app.innerHTML = `<div><div id="head"></div><div id="main" class="c-main"></div></div>`;
  onSnapshot(query(collection(db, "stores", X.storeId, "stays"), orderBy("checkIn", "desc"), limit(300)), (snap) => {
    stays = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const keys = new Set(stays.filter(needsMe).map((s) => s.id + JSON.stringify([s.status, (s.requests || []).length, s.reschedule?.status, s.extension?.status])));
    if (known && [...keys].some((k) => !known.has(k))) startRinging(0.5);
    if (!keys.size) stopRinging();
    known = keys; draw();
  });
  onSnapshot(query(collection(db, "stores", X.storeId, "rooms"), orderBy("sortOrder")), (snap) => { rooms = snap.docs.map((d) => ({ id: d.id, ...d.data() })); draw(); });
  document.addEventListener("pointerdown", () => stopRinging(), true);
  setInterval(draw, 30000);
}
export const stayDeskStore = (s) => { if (X) { X.store = s; draw(); } };

function draw() {
  const head = document.getElementById("head"), main = document.getElementById("main"); if (!head || !main) return;
  const t = todayYmd();
  const approvals = stays.filter((s) => ["unconfirmed", "pending"].includes(s.status) || (s.payment?.status === "to_verify" && !["cancelled", "declined", "unconfirmed", "pending"].includes(s.status)));
  const reqs = stays.filter((s) => (s.requests || []).some((r) => r.status === "pending") || s.reschedule?.status === "pending" || s.extension?.status === "pending");
  const dirty = rooms.filter((r) => ["to_clean", "cleaning"].includes(r.housekeeping?.status));
  const tabs = [["today", "Today"], ["approvals", `Approvals${approvals.length ? ` <span class="k-badge">${approvals.length}</span>` : ""}`], ["requests", `Requests${reqs.length ? ` <span class="k-badge">${reqs.length}</span>` : ""}`], ["rooms", `Rooms${dirty.length ? ` <span class="k-badge">${dirty.length}</span>` : ""}`], ["upcoming", "Upcoming"]];
  head.innerHTML = `<header class="k-head"><span class="name">🔑 ${esc(X.store.name)}</span><span class="k-stations">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${tab === k ? "on" : ""}">${l}</button>`).join("")}</span><span class="sp"></span><button class="k-btn sm" id="userBtn">👤 ${esc(X.me?.name || "")}</button></header>`;
  head.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => { tab = b.dataset.tab; draw(); }));
  head.querySelector("#userBtn").onclick = () => X.switchUser?.();
  main.innerHTML = "";
  const grid = html(`<div class="c-grid"></div>`);
  const put = (list, empty) => { list.forEach((s) => grid.appendChild(card(s))); if (!list.length) grid.innerHTML = `<div class="k-empty">${empty}</div>`; main.appendChild(grid); };
  if (tab === "today") {
    const arrivals = stays.filter((s) => s.checkInYmd === t && ["confirmed", "pending"].includes(s.status));
    const inhouse = stays.filter((s) => s.status === "checked_in").sort((a, b) => a.checkOut.toMillis() - b.checkOut.toMillis());
    const sec = (title, list, empty) => { main.appendChild(html(`<h3 style="margin:6px 4px 8px">${title} <span class="muted">(${list.length})</span></h3>`)); const g = html(`<div class="c-grid" style="margin-bottom:16px"></div>`); list.forEach((s) => g.appendChild(card(s))); if (!list.length) g.innerHTML = `<div class="k-empty">${empty}</div>`; main.appendChild(g); };
    sec("🛬 Arriving today", arrivals, "No arrivals today.");
    sec("🛏 In-house", inhouse, "No guests checked in.");
    main.appendChild(html(`<h3 style="margin:6px 4px 8px">🧹 Rooms to clean <span class="muted">(${dirty.length})</span></h3>`));
    main.appendChild(roomsBoard(dirty, true));
    return;
  }
  if (tab === "approvals") return put(approvals.sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0)), "Nothing to approve.");
  if (tab === "requests") return put(reqs, "No open requests.");
  if (tab === "rooms") { main.appendChild(roomsBoard(rooms)); return; }
  if (tab === "upcoming") return put(stays.filter((s) => s.checkInYmd >= t && ["unconfirmed", "pending", "confirmed"].includes(s.status)).sort((a, b) => a.checkIn.toMillis() - b.checkIn.toMillis()), "No upcoming bookings.");
}

function roomsBoard(list, compact) {
  const g = html(`<div class="c-grid"></div>`);
  if (!list.length) { g.innerHTML = `<div class="k-empty">${compact ? "All rooms are clean ✓" : "No rooms yet — add them in the owner dashboard → Rooms."}</div>`; return g; }
  list.forEach((r) => {
    const st = r.housekeeping?.status || "clean"; const hk = HK[st] || HK.clean;
    const guest = stays.find((s) => s.roomId === r.id && s.status === "checked_in");
    const el = html(`<article class="k-card" style="border-top-color:${st === "to_clean" ? "var(--new)" : st === "cleaning" ? "var(--prep)" : st === "occupied" ? "#9f93dc" : "var(--ready)"}">
      <div class="top"><div><div class="no" style="font-size:1.3rem">${esc(r.name)}</div><div class="where">${hk[0]} ${hk[1]}${r.housekeeping?.cleanerName ? ` · ${esc(r.housekeeping.cleanerName)}` : ""}</div></div></div>
      ${guest ? `<div class="small muted">Guest: ${esc(guest.customer?.name || "")} · out ${fmtT(guest.checkOut)}</div>` : ""}<div class="acts"></div></article>`);
    const a = el.querySelector(".acts");
    if (st === "to_clean") { const b = html(`<button class="k-btn prep">🧽 Start cleaning</button>`); b.onclick = () => act("roomCleaning", { roomId: r.id }); a.appendChild(b); }
    if (st === "to_clean" || st === "cleaning") { const b = html(`<button class="k-btn ready">✓ Finished cleaning</button>`); b.onclick = () => act("roomClean", { roomId: r.id }); a.appendChild(b); const sk = html(`<button class="k-btn">⏭ Skip</button>`); sk.onclick = () => { const why = prompt("Skip cleaning — why? (e.g. guest didn't use it, checked by owner)", "Not used"); if (why !== null) act("roomSkip", { roomId: r.id, reason: why }); }; a.appendChild(sk); }
    if (st === "clean" && r.housekeeping?.readyAt) a.appendChild(html(`<span class="small muted">${r.housekeeping.skipped ? "⏭ Skipped" : "✅ Ready"} since ${new Date(r.housekeeping.readyAt).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}</span>`));
    g.appendChild(el);
  });
  return g;
}

function card(s) {
  const st = ST[s.status] || ["", s.status, ""];
  const bal = Math.max(0, (s.total || 0) - (s.paidAmount || 0));
  const now = Date.now();
  const el = html(`<article class="k-card" style="border-top-color:${st[2] === "wait" ? "var(--new)" : st[2] === "ok" ? "var(--ready)" : "var(--prep)"}">
    <div class="top"><div><div class="no" style="font-size:1.3rem">${esc(s.code)} <span class="k-tag">${st[0]} ${st[1]}</span>${s.test ? ` <span class="k-tag" style="background:#ffe58a;color:#6b4a00">🧪 TEST</span>` : ""}</div>
      <div class="where">${esc(s.roomName)} · 👥 ${s.guests}${s.poolGuests ? ` · 🏊 ${s.poolGuests}` : ""}</div></div>
      <div class="time">${fmtD(s.checkInYmd)} → ${fmtD(s.checkOutYmd)}<span class="eta">${s.short ? `⏳ ${s.short.hours} h · ${s.checkIn.toDate().toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}–${s.checkOut.toDate().toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}` : `${s.nightsCount} night${s.nightsCount > 1 ? "s" : ""}`}${s.status === "checked_in" ? ` · out in ${dur(s.checkOut.toMillis() - now)}` : ""}</span></div></div>
    <div class="small">${esc(s.customer?.name || "")} · ${esc(s.customer?.phone || "")}${s.customer?.messenger ? " " + msgrBtn(s.customer.messenger, "k-tag", "💬 Messenger") : ""}${s.status === "unconfirmed" && s.confirmDeadline?.toMillis ? ` · <span style="color:var(--new)">auto-cancels in ${dur(s.confirmDeadline.toMillis() - now)}</span>` : ""}</div>
    <div class="row" style="gap:8px;margin:8px 0;flex-wrap:wrap">${s.waiver?.idPhotoUrl ? `<a data-priv="${esc(s.waiver.idPhotoUrl)}" target="_blank"><img data-priv="${esc(s.waiver.idPhotoUrl)}" style="height:64px;border-radius:8px" alt="ID"/></a>` : `<span class="k-tag" style="color:var(--new)">No ID</span>`}${s.waiver?.signatureUrl ? `<img data-priv="${esc(s.waiver.signatureUrl)}" style="height:52px;background:#fff;border-radius:8px" alt="signature"/>` : ""}${s.waiver?.pdfUrl ? `<a class="k-btn sm" data-priv="${esc(s.waiver.pdfUrl)}" target="_blank">📄 Waiver</a>` : ""}${s.payment?.proofUrl ? `<a data-priv="${esc(s.payment.proofUrl)}" target="_blank"><img data-priv="${esc(s.payment.proofUrl)}" style="height:64px;border-radius:8px" alt="payment proof"/></a>` : ""}</div>
    <div class="sd-money"><div><span>Total</span><b>${money(s.total)}</b></div><div><span>Downpayment${s.payment ? ` · ${esc(s.payment.methodName)} ref ${esc(s.payment.refNo || "—")}` : ""}</span><b>${money(s.downpayment)}${s.payment?.status === "to_verify" ? ` <span class="k-tag" style="color:var(--new)">TO VERIFY</span>` : ""}</b></div><div><span>Paid / balance</span><b>${money(s.paidAmount || 0)} / ${money(bal)}</b></div></div>
    <div data-extra></div><div class="acts"></div></article>`);
  const extra = el.querySelector("[data-extra]"), acts = el.querySelector(".acts");
  const btn = (label, cls, fn) => { const b = html(`<button class="k-btn ${cls}">${label}</button>`); b.onclick = fn; acts.appendChild(b); };
  (s.requests || []).filter((r) => r.status === "pending").forEach((r) => {
    const row = html(`<div class="k-item" style="display:block;margin-bottom:6px"><b>🙋 ${esc(r.type)}</b> — ${esc(r.text)}<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px"><input class="k-input" data-p type="number" min="0" placeholder="Fee ₱ (optional)" style="max-width:150px"/><input class="k-input" data-r placeholder="Reply (optional)"/><button class="k-btn sm ready" data-ok>Approve</button><button class="k-btn sm danger" data-no>Decline</button></div></div>`);
    row.querySelector("[data-ok]").onclick = () => act("request", { id: s.id, requestId: r.id, approve: true, price: Number(row.querySelector("[data-p]").value || 0), reply: row.querySelector("[data-r]").value });
    row.querySelector("[data-no]").onclick = () => act("request", { id: s.id, requestId: r.id, approve: false, reply: row.querySelector("[data-r]").value || "Not available" });
    extra.appendChild(row);
  });
  if (s.needsIdOk) extra.appendChild(html(`<div class="small" style="background:#fff4d6;padding:6px 8px;border-radius:8px;font-weight:700;margin-bottom:6px">🪪 No valid ID — approving means you accept this guest without an ID.</div>`));
  if (s.kids) extra.appendChild(html(`<div class="small muted" style="margin-bottom:4px">👨‍👩‍👧 ${s.adults || s.guests} adult(s) · ${s.kids} kid(s)</div>`));
  if (s.noticeDiscount) extra.appendChild(html(`<div class="small muted" style="margin-bottom:4px">⚠️ Booked with room notice: ${esc(s.noticeDiscount.labels.join(", "))} (−${money(s.noticeDiscount.amount)})</div>`));
  if (s.short && ["confirmed", "pending"].includes(s.status)) { const b = html(`<button class="k-btn sm prep" style="margin-bottom:6px">⏱ Guest arrived — start ${s.short.hours} h</button>`); b.onclick = () => act("arrived", { id: s.id }); extra.appendChild(b); }
  if ((s.visitors || []).length) extra.appendChild(html(`<div class="small" style="margin-bottom:6px">👥 Visitors: ${s.visitors.map((v) => `${esc(v.name)} × ${v.count}${v.until ? ` (until ${esc(v.until)})` : ""}`).join(" · ")}</div>`));
  (s.issues || []).filter((x) => x.status !== "fixed").forEach((x) => {
    const row = html(`<div class="k-item" style="display:block;margin-bottom:6px"><b>🛠 ${esc(x.text)}</b>${x.photo ? ` · <a data-priv="${esc(x.photo)}" target="_blank">photo</a>` : ""}<div class="row" style="gap:6px;margin-top:6px"><button class="k-btn sm" data-seen>👍 On it</button><button class="k-btn sm ready" data-fix>✓ Fixed</button></div></div>`);
    row.querySelector("[data-seen]").onclick = () => act("issueReply", { id: s.id, issueId: x.id, reply: prompt("Message to the guest:", "We're on it — the caretaker is coming.") || "" });
    row.querySelector("[data-fix]").onclick = () => act("issueReply", { id: s.id, issueId: x.id, done: true, reply: "Fixed" });
    extra.appendChild(row);
  });
  if (["confirmed", "checked_in", "pending"].includes(s.status)) {
    const others = rooms.filter((r) => r.id !== s.roomId && r.active !== false);
    if (others.length) {
      const row = html(`<div class="k-item" style="display:${s.roomChange?.status === "pending" ? "block" : "none"};margin-bottom:6px" data-mv><b>🔁 Move room</b>${s.roomChange?.status === "pending" ? ` — guest asked: ${esc(s.roomChange.reason || "")}` : ""}<div class="row" style="gap:6px;margin-top:6px;flex-wrap:wrap"><select class="k-input" style="margin:0;flex:1">${others.map((r) => `<option value="${r.id}" ${r.id === s.roomChange?.roomId ? "selected" : ""}>${esc(r.name)} · ${money(r.price)}</option>`).join("")}</select><button class="k-btn sm primary" data-go>Move</button>${s.roomChange?.status === "pending" ? `<button class="k-btn sm danger" data-no>No room</button>` : ""}</div><div class="small muted">Price follows the room — more expensive = extra charge, cheaper = refund.</div></div>`);
      row.querySelector("[data-go]").onclick = () => { if (confirm("Move this guest? The price is updated.")) act("moveRoom", { id: s.id, roomId: row.querySelector("select").value }); };
      row.querySelector("[data-no]")?.addEventListener("click", () => act("roomChangeDecline", { id: s.id, reply: prompt("Message to the guest:", "Sorry, no other room is free right now.") || "No other room available" }));
      extra.appendChild(row);
      if (s.roomChange?.status !== "pending") { const t = html(`<button class="k-btn sm" style="margin-bottom:6px">🔁 Move room</button>`); t.onclick = () => { row.style.display = "block"; t.remove(); }; extra.appendChild(t); }
    }
  }
  if (s.refund?.status === "due") { const row = html(`<div class="k-item" style="display:block;margin-bottom:6px"><b>↩️ Refund ${money(s.refund.amount)}</b> · ${esc(s.refund.reason || "")}<div style="margin-top:6px"><button class="k-btn sm primary">💸 Refund sent</button></div></div>`); row.querySelector("button").onclick = () => { const m = prompt("Sent how? (gcash / cash / bank)", "gcash"); if (m) act("refundSent", { id: s.id, method: m, ref: prompt("Reference no. (optional)", "") || "" }); }; extra.appendChild(row); }
  // add-ons that need an OK
  (s.addons || []).forEach((a) => {
    if (a.status !== "pending") return;
    const row = html(`<div class="k-item" style="display:block;margin-bottom:6px"><b>🛏 ${esc(a.name)} × ${a.qty}</b> · ${money(a.amount)} <span class="small muted">(if available)</span><div class="row" style="gap:6px;margin-top:6px"><button class="k-btn sm ready" data-ok>✓ Available</button><button class="k-btn sm danger" data-no>Not available</button></div></div>`);
    row.querySelector("[data-ok]").onclick = () => act("addon", { id: s.id, addonId: a.id, approve: true });
    row.querySelector("[data-no]").onclick = () => act("addon", { id: s.id, addonId: a.id, approve: false, reply: "Not available" });
    extra.appendChild(row);
  });
  const okAdd = (s.addons || []).filter((a) => a.status === "approved");
  if (okAdd.length) extra.appendChild(html(`<div class="small" style="margin-bottom:6px">🧺 Prepare: ${okAdd.map((a) => `${esc(a.name)} × ${a.qty}`).join(" · ")}</div>`));
  if (s.status === "checked_in" && s.overstay?.hours) extra.appendChild(html(`<div class="small" style="background:var(--danger);color:#fff;padding:6px 8px;border-radius:8px;font-weight:700;margin-bottom:6px">⏰ ${s.overstay.hours} h past check-out · overstay ${money(s.overstay.amount)}</div>`));
  if (s.stillInsideAt && s.status === "checked_in") extra.appendChild(html(`<div class="small" style="color:var(--danger);font-weight:700;margin-bottom:6px">⚠️ Tapped "checked out" but was still inside</div>`));
  const dep = s.deposit;
  if (dep?.amount) {
    const lab = { due: "not paid yet", to_verify: `TO VERIFY · ${esc(dep.payment?.methodName || "")} ref ${esc(dep.payment?.refNo || "")}`, rejected: "payment not found", held: "held ✓", checking: `waiting for room check (before ${new Date(dep.checkBy).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })})`, checked: `checked · return ${money(dep.refund)}`, released: `returned ${money(dep.refund)} ✓` }[dep.status] || dep.status;
    const row = html(`<div class="k-item" style="display:block;margin-bottom:6px"><b>🔐 Deposit ${money(dep.amount)}</b> · ${lab}${(dep.deductions || []).length ? `<div class="small">${dep.deductions.map((x) => `• ${esc(x.label)} −${money(x.amount)}${x.photo ? ` <a data-priv="${esc(x.photo)}" target="_blank">photo</a>` : ""}`).join("<br>")}</div>` : ""}${dep.owed ? `<div class="small" style="color:var(--danger)">Guest still owes ${money(dep.owed)}</div>` : ""}<div class="row" style="gap:6px;margin-top:6px;flex-wrap:wrap"></div></div>`);
    const r = row.querySelector(".row");
    const b = (label, cls, fn) => { const x = html(`<button class="k-btn sm ${cls}">${label}</button>`); x.onclick = fn; r.appendChild(x); };
    if (["due", "to_verify", "rejected"].includes(dep.status) && !["cancelled", "declined"].includes(s.status)) { b("✓ Deposit received", "ready", () => act("depositPaid", { id: s.id, method: dep.payment?.methodName || prompt("How was it paid? (cash / gcash / bank)", "cash") || "cash" })); if (dep.status === "to_verify") b("Not found", "danger", () => act("depositReject", { id: s.id, reason: prompt("Reason (shown to the guest):", "We can't find that payment — please check the reference number.") || "Payment not found" })); }
    if (dep.dispute?.status === "open") { const dd = html(`<div style="background:#fff4d6;border-radius:8px;padding:8px;margin-top:6px"><b>⚖️ Guest disputes ${money(dep.dispute.amount)}</b>: ${esc(dep.dispute.reason)}${dep.dispute.photo ? ` · <a data-priv="${esc(dep.dispute.photo)}" target="_blank">photo</a>` : ""}<div class="row" style="gap:6px;margin-top:6px;flex-wrap:wrap"><button class="k-btn sm ready" data-full>Return all</button><button class="k-btn sm" data-part>Return part</button><button class="k-btn sm danger" data-rej>Keep (explain)</button></div></div>`);
      dd.querySelector("[data-full]").onclick = () => act("disputeResolve", { id: s.id, decision: "full", reason: prompt("Message to the guest:", "Sorry about that — we're returning it.") || "" });
      dd.querySelector("[data-part]").onclick = () => { const a = prompt(`How much will you return? (max ${money(dep.dispute.amount)})`, String(Math.round(dep.dispute.amount / 2))); if (a) act("disputeResolve", { id: s.id, decision: "partial", amount: Number(a), reason: prompt("Message to the guest:", "We're returning part of it.") || "" }); };
      dd.querySelector("[data-rej]").onclick = () => { const r = prompt("Why are you keeping it? (the guest sees this)", "The photo shows the stain was found at check-out."); if (r) act("disputeResolve", { id: s.id, decision: "reject", reason: r }); };
      row.appendChild(dd); }
    if (dep.status === "checked") b(`💸 Returned ${money(dep.refund)}`, "primary", () => { const m = prompt(`Returned ${money(dep.refund)} how? (gcash / cash / bank)`, "gcash"); if (!m) return; act("depositReleased", { id: s.id, method: m, ref: prompt("Reference no. (optional)", "") || "" }); });
    extra.appendChild(row);
  }
  if (s.reschedule?.status === "pending") { const row = html(`<div class="k-item" style="display:block;margin-bottom:6px"><b>📅 Reschedule</b> → ${fmtD(s.reschedule.checkIn)} – ${fmtD(s.reschedule.checkOut)} (${s.reschedule.nights} nights · ${money(s.reschedule.subtotal)})<div class="row" style="gap:6px;margin-top:6px"><button class="k-btn sm ready" data-ok>Approve</button><button class="k-btn sm danger" data-no>Decline</button></div></div>`); row.querySelector("[data-ok]").onclick = () => act("reschedule", { id: s.id, approve: true }); row.querySelector("[data-no]").onclick = () => act("reschedule", { id: s.id, approve: false, reply: prompt("Reason (shown to the guest):", "Those dates aren't available") || "" }); extra.appendChild(row); }
  if (s.extension?.status === "pending") { const row = html(`<div class="k-item" style="display:block;margin-bottom:6px"><b>⏱ Extension</b> +${s.extension.hours}h · ${money(s.extension.price)}<div class="row" style="gap:6px;margin-top:6px"><button class="k-btn sm ready" data-ok>Approve</button><button class="k-btn sm danger" data-no>Decline</button></div></div>`); row.querySelector("[data-ok]").onclick = () => act("extension", { id: s.id, approve: true }); row.querySelector("[data-no]").onclick = () => act("extension", { id: s.id, approve: false }); extra.appendChild(row); }
  if (["unconfirmed", "pending"].includes(s.status)) {
    btn(s.status === "unconfirmed" ? "✅ Messaged — approve" : "✅ Approve booking", "primary", () => act("approve", { id: s.id }));
    btn("✕ Decline", "danger", () => { const r = prompt("Reason (shown to the guest):", "Sorry, those dates are not available"); if (r !== null) act("decline", { id: s.id, reason: r }); });
  }
  if (s.payment?.status === "to_verify" && !["cancelled", "declined"].includes(s.status)) btn(`✓ Downpayment received (${money(s.downpayment)})`, "ready", () => { if (confirm(`Seen the ${s.payment.methodName} payment ref ${s.payment.refNo || ""}?`)) act("verifyPayment", { id: s.id, amount: s.downpayment, method: s.payment.method }); });
  if (["confirmed", "pending"].includes(s.status)) btn("🔑 Check in", "prep", () => act("checkin", { id: s.id }));
  if (s.status === "checked_in") btn("🚪 Check out", "ready", () => { if (confirm("Mark the guest as checked out? The caretaker gets notified.")) act("checkout", { id: s.id }); });
  if (bal > 0 && ["confirmed", "checked_in", "checked_out"].includes(s.status)) btn(`💵 Add payment`, "", () => { const v = prompt(`Amount received (balance ${money(bal)}):`, String(bal)); if (v) act("addPayment", { id: s.id, amount: Number(v), method: (prompt("Method (cash / gcash / maya / card):", "cash") || "cash").toLowerCase() }); });
  if (["confirmed"].includes(s.status)) btn("Cancel", "danger", () => { const r = prompt("Cancel this booking? Reason (no refund policy applies):", "Guest no-show"); if (r !== null) act("cancel", { id: s.id, reason: r }); });
  hydratePrivate(el);
  return el;
}
