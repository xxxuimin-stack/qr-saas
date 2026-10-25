// Reservations page (dashboard, table mode): upcoming list with confirm/seat/done/no-show/cancel
import { msgrBtn } from "../msgr.js";
import { db, call } from "../firebase.js";
import { hydratePrivate } from "../privfiles.js";
import { collection, doc, updateDoc, onSnapshot, query, orderBy, limit, serverTimestamp } from "firebase/firestore";
import { esc, html, toast, openModal, closeModal, money } from "../ui.js";
import { beep } from "./orders.js";

const ST = {
  pending: ["Requested", "trial"], confirmed: ["Confirmed", "active"], seated: ["Seated", "active"],
  done: ["Done", ""], cancelled: ["Cancelled", "locked"], no_show: ["No-show", "locked"],
};

export function renderReservationsPage(root, ctx) {
  const { storeId, store } = ctx;
  const col = collection(db, "stores", storeId, "reservations");
  const tablesCol = collection(db, "stores", storeId, "tables");
  let rows = [], tables = [], tab = "upcoming", seen = null, kindF = "all";
  const KIND = { table: ["🪑", "Table"], event: ["🎉", "Event"], vip: ["🎤", "VIP room"] };

  root.innerHTML = `
    <div class="row between wrap" style="margin-bottom:12px">
      <div class="tabs" style="margin:0;max-width:420px;flex:1">
        <button data-tab="upcoming" class="active">Upcoming <span class="tag" id="cntUp">0</span></button>
        <button data-tab="today">Today</button>
        <button data-tab="past">Past</button>
      </div>
      <div class="row">
        <select id="kindF" style="width:auto"><option value="all">All types</option><option value="table">🪑 Tables</option><option value="event">🎉 Events</option><option value="vip">🎤 VIP rooms</option></select>
        <label class="check small" style="margin:0"><input type="checkbox" id="soundOn" checked/> 🔔 Sound</label>
      </div>
    </div>
    <div id="resvList" class="orders"></div>`;
  root.querySelector("#kindF").onchange = (e) => { kindF = e.target.value; draw(); };
  root.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => { tab = b.dataset.tab; root.querySelectorAll("[data-tab]").forEach((x) => x.classList.toggle("active", x === b)); draw(); }));

  const u1 = onSnapshot(query(col, orderBy("scheduledAt", "asc"), limit(300)), (snap) => {
    rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const pend = rows.filter((r) => r.status === "pending").map((r) => r.id);
    if (seen && root.querySelector("#soundOn")?.checked && pend.some((id) => !seen.has(id))) beep();
    seen = new Set(rows.map((r) => r.id));
    draw();
  });
  const u2 = onSnapshot(query(tablesCol, orderBy("sortOrder")), (snap) => { tables = snap.docs.map((d) => ({ id: d.id, ...d.data() })); });

  const todayKey = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

  function draw() {
    const list = root.querySelector("#resvList");
    const now = Date.now();
    const upcoming = rows.filter((r) => ["unconfirmed", "pending", "confirmed", "seated"].includes(r.status) && (r.scheduledAt?.toMillis?.() || 0) > now - 3 * 3600e3);
    root.querySelector("#cntUp").textContent = upcoming.filter((r) => r.status === "pending").length || upcoming.length;
    let show = tab === "upcoming" ? upcoming
      : tab === "today" ? rows.filter((r) => r.date === todayKey())
      : rows.filter((r) => !upcoming.includes(r)).sort((a, b) => (b.scheduledAt?.toMillis?.() || 0) - (a.scheduledAt?.toMillis?.() || 0));
    if (kindF !== "all") show = show.filter((r) => (r.kind || "table") === kindF);
    list.innerHTML = show.length ? "" : `<div class="tile muted">No ${tab} reservations.</div>`;
    show.forEach((r) => list.appendChild(card(r)));
    hydratePrivate(list);
  }

  function card(r) {
    const when = r.scheduledAt?.toDate?.();
    const [label, pill] = ST[r.status] || [r.status, ""];
    const el = html(`<div class="ocard st-${esc(r.status)} ${r.status === "pending" ? "new" : ""}">
      <div class="ohead">
        <div><span class="ono">${when ? when.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" }) : r.time}${r.endTime ? `<span class="small muted">–${esc(r.endTime)}</span>` : ""}</span> <span class="pill ${pill}">${esc(label)}</span> <span class="tag">${KIND[r.kind || "table"][0]} ${KIND[r.kind || "table"][1]}</span></div>
        <div class="small muted">${when ? when.toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric" }) : r.date}</div>
      </div>
      <div class="osub"><b>${esc(r.name)}</b> · ${r.pax} pax · ${esc(r.phone)}${r.messenger ? " " + msgrBtn(r.messenger, "pill", "💬 Messenger") : ""}${r.roomName ? ` · <b>${esc(r.roomName)}</b> (${r.hours}h)` : ""}${r.tableLabel ? ` · <b>${esc(r.tableLabel)}</b>` : ""}</div>
      ${r.packageName ? `<div class="small">📦 ${esc(r.packageName)}${r.packagePricing === "flat" ? "" : ` × ${r.pax}`}</div>` : ""}
      ${r.estimate != null ? `<div class="small"><b>${money(r.estimate)}</b>${r.deposit ? ` · deposit ${money(r.deposit)}` : ""}</div>` : ""}
      ${r.occasion ? `<div class="small">🎉 ${esc(r.occasion)}</div>` : ""}
      ${r.notes ? `<div class="small note">“${esc(r.notes)}”</div>` : ""}
      ${r.staffNote ? `<div class="small muted">Staff note: ${esc(r.staffNote)}</div>` : ""}
      ${r.needsWaiver ? (r.waiver?.pdfUrl ? `<div class="small" style="margin-top:4px">📝 Waiver signed by ${esc(r.waiver.signerName || r.name)} · <a data-priv="${esc(r.waiver.pdfUrl)}" target="_blank">Download PDF</a>${r.waiver.idPhotoUrl ? ` · <a data-priv="${esc(r.waiver.idPhotoUrl)}" target="_blank">ID photo</a>` : ""}</div>` : `<div class="small" style="margin-top:4px;color:var(--danger)">⚠️ Waiver not signed yet</div>`) : ""}
      ${r.preorder ? `<div class="small" style="margin-top:4px">📅 <b>Pre-order #${r.preorder.orderNo}</b> · ${(r.preorder.items || []).map(esc).join(", ")} · ${money(r.preorder.total)}</div>` : ""}
      ${r.reschedule?.status === "requested" ? `<div class="small" style="margin-top:4px;color:var(--warn,#b7791f)">📅 <b>Reschedule request</b> → ${esc(r.reschedule.date)} ${esc(r.reschedule.time)}${r.reschedule.note ? ` · “${esc(r.reschedule.note)}”` : ""}</div>` : r.reschedule ? `<div class="small muted">Reschedule ${esc(r.reschedule.status)}${r.reschedule.by ? ` by ${esc(r.reschedule.by)}` : ""}</div>` : ""}
      ${r.dpPaid ? `<div class="small" style="margin-top:4px">💵 DP received <b>${money(r.dpPaid)}</b> · ${esc(r.dpMethod || "")}${r.dpBy ? ` · ${esc(r.dpBy)}` : ""}</div>` : ""}
      ${r.extraHours ? `<div class="small">⏱ Extended +${r.extraHours}h · ${money(r.extensionFee || 0)}</div>` : ""}
      <div class="ofoot"><span class="code">${esc(r.code)}</span><div class="row wrap" data-acts></div></div>
    </div>`);
    const acts = el.querySelector("[data-acts]");
    const set = (patch) => updateDoc(doc(col, r.id), { ...patch, updatedAt: serverTimestamp() }).catch((e) => toast(e.message, "error"));
    const btn = (txt, cls, fn) => { const b = html(`<button class="btn sm ${cls}" type="button">${txt}</button>`); b.onclick = fn; acts.appendChild(b); };

    const waiverBlock = r.needsWaiver && !r.waiver?.pdfUrl && store.settings?.waiver?.blockConfirm !== false;
    if (r.status === "unconfirmed") btn("✅ Confirmed on Messenger", "", () => updateDoc(doc(db, "stores", storeId, "reservations", r.id), { status: "pending", confirmedAt: serverTimestamp(), updatedAt: serverTimestamp() }));
    if (r.status === "pending") btn(waiverBlock ? "🔒 Confirm (waiver needed)" : "✅ Confirm", waiverBlock ? "ghost" : "", () => waiverBlock ? toast("The customer must sign the waiver first (on their phone or at the Counter).", "error") : assignTable(r, "confirmed"));
    if (r.status === "confirmed") btn("🪑 Seated", "", () => assignTable(r, "seated"));
    if (r.status === "seated") btn("Done", "ghost", () => set({ status: "done" }));
    if (["pending", "confirmed"].includes(r.status)) {
      btn("No-show", "ghost", () => set({ status: "no_show" }));
      btn("Cancel", "ghost danger-text", () => {
        const body = html(`<div><label>Message to customer</label><input name="n" placeholder="e.g. Fully booked at that time, would 7:30 PM work?"/></div>`);
        const foot = html(`<div class="row" style="justify-content:flex-end"><button class="btn ghost" data-no>Back</button><button class="btn danger" data-yes>Cancel reservation</button></div>`);
        foot.querySelector("[data-no]").onclick = closeModal;
        foot.querySelector("[data-yes]").onclick = () => { set({ status: "cancelled", staffNote: body.querySelector("input").value.trim() }); closeModal(); };
        openModal({ title: `Cancel ${r.code}`, body, footer: foot });
      });
    }
    if (["pending", "confirmed", "seated"].includes(r.status)) btn("✎ Table / note", "ghost", () => assignTable(r, r.status));
    const rs = (data) => call("resvStaff", { resvId: r.id, ...data }).then(() => toast("Saved ✓")).catch((e) => toast(e.message, "error"));
    if (r.reschedule?.status === "requested") { btn("✅ Approve new date", "", () => rs({ action: "resched", approve: true })); btn("✕ Decline", "ghost", () => rs({ action: "resched", approve: false })); }
    if (["pending", "confirmed", "seated"].includes(r.status) && (r.deposit || r.kind !== "table")) btn(r.dpPaid ? "💵 Edit DP" : "💵 DP received", "ghost", () => {
      const methods = ["Cash", ...((store.settings?.payments?.methods || []).filter((m) => m.enabled !== false && m.type !== "cash").map((m) => m.name))];
      const body = html(`<div><label>Amount received</label><input name="a" type="number" inputmode="decimal" value="${r.dpPaid || r.deposit || ""}"/><label>Paid via</label><select name="m">${methods.map((m) => `<option ${m === r.dpMethod ? "selected" : ""}>${esc(m)}</option>`).join("")}</select></div>`);
      const foot = html(`<div class="row" style="justify-content:flex-end"><button class="btn ghost" data-no>Back</button><button class="btn" data-yes>Save</button></div>`);
      foot.querySelector("[data-no]").onclick = closeModal;
      foot.querySelector("[data-yes]").onclick = () => { rs({ action: "dp", amount: Number(body.querySelector("[name=a]").value || 0), method: body.querySelector("[name=m]").value }); closeModal(); };
      openModal({ title: `Downpayment · ${r.code}`, body, footer: foot });
    });
    if (r.dpPaid || r.preorder) btn("🧾 Bill", "ghost", () => {
      const total = (r.preorder?.total || 0) + (r.kind === "vip" && r.roomPricing !== "consumable" ? r.estimate || 0 : r.kind === "event" ? r.estimate || 0 : 0) + (r.extensionFee || 0);
      const bal = Math.max(0, total - (r.dpPaid || 0));
      openModal({ title: `Bill · ${r.code}`, body: html(`<div>
        ${r.kind !== "table" && r.estimate ? `<div class="row" style="justify-content:space-between"><span>${r.kind === "vip" ? (r.roomPricing === "consumable" ? "Min. consumable (not added)" : "Room") : "Package"}</span><b>${money(r.estimate)}</b></div>` : ""}
        ${r.preorder ? `<div class="row" style="justify-content:space-between"><span>Pre-order #${r.preorder.orderNo}</span><b>${money(r.preorder.total)}</b></div>` : ""}
        ${r.extensionFee ? `<div class="row" style="justify-content:space-between"><span>Extension +${r.extraHours}h</span><b>${money(r.extensionFee)}</b></div>` : ""}
        <div class="row" style="justify-content:space-between"><span>Less: downpayment</span><b>−${money(r.dpPaid || 0)}</b></div>
        <hr/><div class="row" style="justify-content:space-between;font-size:1.1rem"><span>Balance</span><b>${money(bal)}</b></div>
        <p class="small muted">Orders added during the visit are billed on the table/room as usual.</p></div>`) });
    });
    return el;
  }

  function assignTable(r, nextStatus) {
    const body = html(`<div>
      <p class="muted small">${esc(r.name)} · ${r.pax} pax · ${r.date} ${r.time}</p>
      <label>Assign table (optional)</label>
      <select name="t"><option value="">— none —</option>${tables.map((t) => `<option value="${t.id}" ${r.tableId === t.id ? "selected" : ""}>${esc(t.label)}</option>`).join("")}</select>
      <label>Note to customer (optional)</label><input name="n" value="${esc(r.staffNote || "")}" placeholder="e.g. Window table ready. Please arrive on time."/>
    </div>`);
    const foot = html(`<div class="row" style="justify-content:flex-end"><button class="btn ghost" data-no>Cancel</button><button class="btn" data-yes>${nextStatus === r.status ? "Save" : ST[nextStatus][0]}</button></div>`);
    foot.querySelector("[data-no]").onclick = closeModal;
    foot.querySelector("[data-yes]").onclick = () => {
      const tid = body.querySelector("select").value;
      const t = tables.find((x) => x.id === tid);
      updateDoc(doc(col, r.id), { status: nextStatus, tableId: t?.id || null, tableLabel: t?.label || null, staffNote: body.querySelector("input").value.trim(), updatedAt: serverTimestamp() })
        .then(() => { closeModal(); toast("Saved"); }).catch((e) => toast(e.message, "error"));
    };
    openModal({ title: `Reservation ${r.code}`, body, footer: foot });
  }

  return () => { u1(); u2(); };
}
