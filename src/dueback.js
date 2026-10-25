// Salon "Due back": clients who should come back (set at checkout from each service's "rebook after N weeks").
// Data lives on stores/{id}/customers/{phone}.nextDue = { at, service, providerId, providerName, lastVisit, status: due|snoozed|booked|lost, smsAt, contactedAt }
import { db } from "./firebase.js";
import { collection, query, where, orderBy, onSnapshot, doc, updateDoc } from "firebase/firestore";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const DAY = 86400e3;
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const fmtDate = (ms) => new Date(ms).toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric" });

/** Live list of clients due back within the next 14 days (and overdue), excluding booked / not coming back */
export function watchDue(storeId, cb, { providerId = null, days = 14 } = {}) {
  const q = providerId
    ? query(collection(db, "stores", storeId, "customers"), where("nextDue.providerId", "==", providerId))
    : query(collection(db, "stores", storeId, "customers"), where("nextDue.at", "<=", Date.now() + days * DAY), orderBy("nextDue.at"));
  return onSnapshot(q, (snap) => {
    const until = Date.now() + days * DAY;
    cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((c) => c.nextDue && ["due", "snoozed"].includes(c.nextDue.status) && c.nextDue.at <= until && !c.flagged).sort((a, b) => a.nextDue.at - b.nextDue.at));
  }, (e) => { console.warn("due back", e); cb([]); });
}

/** overdue / today / this week / next week */
export function dueGroups(list) {
  const t0 = startOfToday(), t1 = t0 + DAY, w = t0 + 7 * DAY;
  return [
    ["🔴 Overdue", list.filter((c) => c.nextDue.at < t0)],
    ["🟠 Today", list.filter((c) => c.nextDue.at >= t0 && c.nextDue.at < t1)],
    ["🟡 This week", list.filter((c) => c.nextDue.at >= t1 && c.nextDue.at < w)],
    ["⚪ Next week", list.filter((c) => c.nextDue.at >= w)],
  ];
}
/** clients the counter should remind now: overdue or due today, not contacted yet */
export const needsReminder = (list) => list.filter((c) => c.nextDue.at < startOfToday() + DAY && !c.nextDue.contactedAt);

export function dueMessage(c, storeName, link) {
  const n = c.nextDue;
  return `Hi ${(c.name || "").split(" ")[0] || "there"}! This is ${storeName}. It's time for your next ${n.service || "visit"}${n.providerName ? ` with ${n.providerName.split(" ")[0]}` : ""} 😊 Book here: ${link} or reply to this message for your preferred time.`;
}

/** Card for one client (counter + stylist app) */
export function dueCardHTML(c, { money, compact = false } = {}) {
  const n = c.nextDue; const late = n.at < startOfToday();
  const days = Math.round((n.at - startOfToday()) / DAY);
  return `<article class="k-card" style="border-top-color:${late ? "var(--danger)" : days === 0 ? "var(--new)" : "var(--prep)"}">
    <div class="top"><div><div class="no">${esc(c.name || "—")}</div><div class="where">${esc(c.phone || "")}</div></div>
      <div class="time">${late ? `<b style="color:var(--danger)">${-days} day${-days === 1 ? "" : "s"} late</b>` : days === 0 ? "<b>Today</b>" : `in ${days} day${days === 1 ? "" : "s"}`}<span class="eta">due ${fmtDate(n.at)}</span></div></div>
    <div class="small">🔁 <b>${esc(n.service || "Next visit")}</b>${n.providerName ? ` · ${esc(n.providerName)}` : ""} · last visit ${n.lastVisit ? fmtDate(n.lastVisit) : "—"}</div>
    <div class="small muted" style="margin-top:4px">${n.smsAt > 0 ? `📱 SMS sent ${fmtDate(n.smsAt)}` : n.smsAt === -1 ? "📱 SMS failed" : "📱 SMS not sent yet"}${n.contactedAt ? ` · ✅ contacted by ${esc(n.contactedBy || "staff")} ${fmtDate(n.contactedAt)}` : ""}${n.status === "snoozed" ? " · ⏭ snoozed" : ""}${c.allergies ? ` · <b style="color:var(--danger)">⚠️ ${esc(c.allergies)}</b>` : ""}</div>
    ${compact ? (c.phone ? `<div class="acts" data-key="${esc(c.id)}"><a class="k-btn sm" href="tel:${esc(c.phone)}" data-act="call">📞 Call</a><a class="k-btn sm" href="sms:${esc(c.phone)}" data-act="text">💬 Text</a><button class="k-btn sm" data-act="copy">📋 Copy message</button></div>` : "") : `<div class="acts" data-key="${esc(c.id)}">
      <button class="k-btn primary sm" data-act="book">📅 Book now</button>
      ${c.phone ? `<a class="k-btn sm" href="tel:${esc(c.phone)}" data-act="call">📞 Call</a><a class="k-btn sm" href="sms:${esc(c.phone)}" data-act="text">💬 Text</a>` : ""}
      <button class="k-btn sm" data-act="copy">📋 Copy message</button>
      ${n.contactedAt ? "" : `<button class="k-btn sm" data-act="contacted">✅ Contacted</button>`}
      <button class="k-btn sm" data-act="snooze">⏭ 1 week</button>
      <button class="k-btn sm danger" data-act="lost">✕ Not coming</button></div>`}
  </article>`;
}

/** Wire the buttons of dueCardHTML() */
export function bindDueActions(root, list, { storeId, me, storeName, link, onBook }) {
  root.querySelectorAll(".acts[data-key]").forEach((box) => {
    const c = list.find((x) => x.id === box.dataset.key); if (!c) return;
    const ref = doc(db, "stores", storeId, "customers", c.id);
    const set = (patch) => updateDoc(ref, patch).catch((e) => alert(e.message));
    const mark = () => !c.nextDue.contactedAt && set({ "nextDue.contactedAt": Date.now(), "nextDue.contactedBy": me?.name || "staff" });
    box.querySelectorAll("[data-act]").forEach((b) => (b.onclick = async (e) => {
      const act = b.dataset.act;
      if (act === "book") return onBook(c);
      if (act === "call" || act === "text") { mark(); return; }
      e.preventDefault();
      if (act === "copy") { try { await navigator.clipboard.writeText(dueMessage(c, storeName, link)); b.textContent = "Copied ✓"; } catch { prompt("Copy this message:", dueMessage(c, storeName, link)); } mark(); }
      if (act === "contacted") mark();
      if (act === "snooze") set({ "nextDue.at": Math.max(Date.now(), c.nextDue.at) + 7 * DAY, "nextDue.status": "snoozed", "nextDue.contactedAt": null });
      if (act === "lost" && confirm(`Remove ${c.name || c.phone} from "Due back"? (not coming back)`)) set({ "nextDue.status": "lost", "nextDue.lostBy": me?.name || "staff", "nextDue.lostAt": Date.now() });
    }));
  });
}
