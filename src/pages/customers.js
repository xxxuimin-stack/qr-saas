// Customers (owner): phone-based records — orders, completed, cancelled, flagged
import { db, call } from "../firebase.js";
import { collection, doc, onSnapshot, query, orderBy, limit, updateDoc, serverTimestamp } from "firebase/firestore";
import { esc, html, toast, confirmDialog } from "../ui.js";
import { ADDONS, entitled } from "../plans.js";

export function renderCustomersPage(root, ctx) {
  const { storeId } = ctx;
  let rows = [], q = "";
  root.innerHTML = `<div class="row between wrap" style="margin-bottom:12px"><input id="cq" placeholder="Search name / phone" style="max-width:300px"/><span class="small muted" id="cCount"></span></div>
    <div class="tile" style="padding:0;overflow:auto"><table class="tbl" id="ctbl"></table></div>
    <div class="tile" style="margin-top:16px" id="smsTile">
      <div class="row between wrap"><div><h3>📱 SMS promos</h3><p class="small muted">Batch text to customers who opted in. <span id="smsCounts"></span></p></div></div>
      ${!entitled(ctx.sub, "sms") ? `<div class="alert warn"><a class="addon-lock" href="#billing">🔒 Add-on · ${esc(ADDONS.sms.name)} · ₱${ADDONS.sms.price}/mo</a> — activate in Billing.</div>` : !ctx.store.settings?.sms?.enabled ? `<div class="alert warn">Turned off. Enable it in <a href="#settings">Settings → SMS promos</a> and add your Semaphore API key.</div>` : `
      <div class="form2">
        <div class="span2"><label>Message <span class="small muted" id="smsLen"></span></label><textarea id="smsMsg" rows="3" maxlength="480" placeholder="Hi {name}! 20% off all drinks this weekend at Kapehan ni Juan. Show this text. Valid Oct 25-26."></textarea>
          <p class="small muted" style="margin:4px 0 0">Use <code>{name}</code> for the first name. 160 characters = 1 credit; longer = 2–3 credits per recipient. Include your store name in the message.</p></div>
        <div><label>Recipients</label><select id="smsFilter"><option value="all">All opted-in</option><option value="returning">Returning only (2+ completed orders)</option><option value="inactive30">No orders in the last 30 days</option></select></div>
        <div><label>When</label><div class="row"><select id="smsWhen" style="max-width:140px"><option value="now">Send now</option><option value="later">Schedule</option></select><input id="smsAt" type="datetime-local" style="display:none"/></div></div>
      </div>
      <div class="row between wrap" style="margin-top:10px"><span class="small muted" id="smsEst">—</span><button class="btn" id="smsSend" type="button">📤 Send campaign</button></div>`}
      <h4 style="margin:16px 0 6px">History</h4><div id="campList" class="small muted">Loading…</div>
    </div>`;
  root.querySelector("#cq").oninput = (e) => { q = e.target.value.toLowerCase(); draw(); };
  // ---- SMS
  let camps = [];
  const smsCredits = (m) => Math.max(1, Math.ceil((m || "").length / 160));
  const optins = () => rows.filter((c) => c.smsOptIn && !c.flagged);
  const estimate = () => {
    const f = root.querySelector("#smsFilter")?.value || "all", msg = root.querySelector("#smsMsg")?.value || "";
    const cutoff = Date.now() - 30 * 86400000;
    const n = optins().filter((c) => f === "all" || (f === "returning" ? (c.completed || 0) >= 2 : (c.lastOrderAt?.toMillis?.() || 0) < cutoff)).length;
    const cr = smsCredits(msg.replace(/\{name\}/gi, "Juan"));
    if (root.querySelector("#smsLen")) root.querySelector("#smsLen").textContent = `(${msg.length} chars · ${cr} credit${cr > 1 ? "s" : ""} each)`;
    if (root.querySelector("#smsEst")) root.querySelector("#smsEst").innerHTML = `<b>${n}</b> recipients × ${cr} = <b>${n * cr} credits</b> (≈ ₱${(n * cr * 0.5).toFixed(0)}–${n * cr})`;
  };
  root.querySelector("#smsMsg")?.addEventListener("input", estimate);
  root.querySelector("#smsFilter")?.addEventListener("change", estimate);
  root.querySelector("#smsWhen")?.addEventListener("change", (e) => (root.querySelector("#smsAt").style.display = e.target.value === "later" ? "" : "none"));
  root.querySelector("#smsSend")?.addEventListener("click", async (e) => {
    const msg = root.querySelector("#smsMsg").value.trim(), when = root.querySelector("#smsWhen").value, at = root.querySelector("#smsAt").value;
    if (msg.length < 10) return toast("Enter a message", "error");
    if (when === "later" && !at) return toast("Pick a date/time", "error");
    if (!(await confirmDialog(`${root.querySelector("#smsEst").textContent}\n\nSend${when === "later" ? " on " + new Date(at).toLocaleString("en-PH") : " now"}? This cannot be undone once sent.`))) return;
    e.target.disabled = true;
    try { const r = await call("sendSmsCampaign", { message: msg, filter: root.querySelector("#smsFilter").value, scheduleAt: when === "later" ? new Date(at).toISOString() : null }); toast(r.status === "scheduled" ? "Scheduled ✓" : `Sent ${r.sent}, failed ${r.failed}`); root.querySelector("#smsMsg").value = ""; estimate(); }
    catch (err) { toast(err.message, "error"); }
    e.target.disabled = false;
  });
  const u2 = onSnapshot(query(collection(db, "stores", storeId, "campaigns"), orderBy("createdAt", "desc"), limit(30)), (snap) => {
    camps = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const el = root.querySelector("#campList"); if (!el) return;
    if (!camps.length) return (el.textContent = "No campaigns yet.");
    el.innerHTML = camps.map((c) => { const st = { scheduled: ["Scheduled", "trial"], sending: ["Sending…", "trial"], sent: ["Sent", "active"], failed: ["Failed", "locked"], cancelled: ["Cancelled", ""] }[c.status] || [c.status, ""];
      return `<div class="row between" style="padding:8px 0;border-bottom:1px solid var(--line);gap:10px"><span style="flex:1"><span class="pill ${st[1]}">${st[0]}</span> ${c.scheduledAt?.toDate ? c.scheduledAt.toDate().toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" }) : c.createdAt?.toDate ? c.createdAt.toDate().toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" }) : ""} · ${c.recipients} recipients · ${c.credits} credits${c.status === "sent" ? ` · sent ${c.sent}${c.failed ? `, failed ${c.failed}` : ""}` : ""}${c.errors?.length ? ` · <span class="danger-text">${esc(c.errors[0])}</span>` : ""}<br><span class="muted">${esc(c.message)}</span></span>${c.status === "scheduled" ? `<button class="btn ghost sm" data-cancel="${c.id}">Cancel</button>` : ""}</div>`; }).join("");
    el.querySelectorAll("[data-cancel]").forEach((b) => (b.onclick = async () => { try { await call("cancelSmsCampaign", { id: b.dataset.cancel }); toast("Cancelled"); } catch (err) { toast(err.message, "error"); } }));
  }, () => {});

  const unsub = onSnapshot(query(collection(db, "stores", storeId, "customers"), orderBy("lastOrderAt", "desc"), limit(500)), (snap) => { rows = snap.docs.map((d) => ({ id: d.id, ...d.data() })); draw(); });
  function draw() {
    if (root.querySelector("#smsCounts")) root.querySelector("#smsCounts").innerHTML = `<b>${optins().length}</b> of ${rows.length} opted in.`;
    estimate();
    const list = rows.filter((c) => !q || (c.name || "").toLowerCase().includes(q) || (c.phone || "").includes(q));
    root.querySelector("#cCount").textContent = `${list.length} customers`;
    root.querySelector("#ctbl").innerHTML = `<thead><tr><th>Customer</th><th>Orders</th><th>Completed</th><th>Cancelled</th><th>Last order</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map((c) => `<tr><td><b>${esc(c.name || "—")}</b><br><span class="small muted">${esc(c.phone)}${c.address ? " · " + esc(c.address) : ""}</span>${c.note ? `<br><span class="small">📝 ${esc(c.note)}</span>` : ""}${c.allergies ? `<br><span class="small danger-text">⚠️ ${esc(c.allergies)}</span>` : ""}${c.noShows ? `<br><span class="small danger-text">🚫 ${c.noShows} no-show${c.noShows > 1 ? "s" : ""}${c.dpRequired ? " · DP required" : ""}</span>` : ""}${c.stamps ? `<br><span class="small">⭐ ${c.stamps} stamps</span>` : ""}${c.nextDue && ["due", "snoozed", "booked"].includes(c.nextDue.status) ? `<br><span class="small">🔁 ${c.nextDue.status === "booked" ? "rebooked ✓" : `due back ${new Date(c.nextDue.at).toLocaleDateString("en-PH", { month: "short", day: "numeric" })}`} · ${esc(c.nextDue.service || "")}</span>` : ""}</td>
        <td>${c.orders || 0}</td><td>${c.completed || 0}</td><td class="${c.cancelled ? "danger-text" : ""}">${c.cancelled || 0}</td>
        <td class="small">${c.lastOrderAt?.toDate ? c.lastOrderAt.toDate().toLocaleDateString("en-PH", { dateStyle: "medium" }) : "—"}</td>
        <td>${c.smsOptIn ? `<span class="pill active" title="SMS opt-in">📱</span> ` : ""}${c.flagged ? `<span class="pill locked">⚠️ Blocked</span>` : (c.completed || 0) >= 1 ? `<span class="pill active">Returning</span>` : `<span class="pill trial">New</span>`}</td>
        <td><button class="btn ghost sm" data-flag="${c.id}">${c.flagged ? "Unblock" : "Block"}</button> <button class="btn ghost sm" data-note="${c.id}">Note</button>${c.noShows || c.dpRequired ? ` <button class="btn ghost sm" data-reset="${c.id}" title="Clear no-shows and the DP requirement">Reset no-shows</button>` : ""}</td></tr>`).join("") || `<tr><td colspan="7" class="muted" style="padding:20px">No customer records yet (from pickup/delivery orders with a phone number).</td></tr>`}</tbody>`;
    root.querySelectorAll("[data-flag]").forEach((b) => (b.onclick = () => { const c = rows.find((x) => x.id === b.dataset.flag); updateDoc(doc(db, "stores", storeId, "customers", c.id), { flagged: !c.flagged, updatedAt: serverTimestamp() }).then(() => toast(c.flagged ? "Unblocked" : "Blocked")).catch((e) => toast(e.message, "error")); }));
    root.querySelectorAll("[data-reset]").forEach((b) => (b.onclick = () => updateDoc(doc(db, "stores", storeId, "customers", b.dataset.reset), { noShows: 0, dpRequired: false, updatedAt: serverTimestamp() }).then(() => toast("Reset")).catch((e) => toast(e.message, "error"))));
    root.querySelectorAll("[data-note]").forEach((b) => (b.onclick = () => { const c = rows.find((x) => x.id === b.dataset.note); const n = prompt("Note:", c.note || ""); if (n !== null) updateDoc(doc(db, "stores", storeId, "customers", c.id), { note: n, updatedAt: serverTimestamp() }); }));
  }
  return () => { unsub(); u2(); };
}
