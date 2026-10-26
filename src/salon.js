// Salon counter (reception) — used by /counter/ when store.mode === "salon".
// Today board per stylist, assign with rotation, walk-in / phone booking, confirm duration, start/done/no-show, checkout.
import { msgrBtn } from "./msgr.js";
import { db, call } from "./firebase.js";
import { hydratePrivate } from "./privfiles.js";
import { payMethods, apptOp } from "./orderops.js";
import { offReason, apptReceipt } from "./salonpay.js";
import { printReceipt, printCfg } from "./print.js";
import { getActiveStaff, feat, chime } from "./staffauth.js";
import { watchDue, dueGroups, needsReminder, dueCardHTML, bindDueActions, fmtDate } from "./dueback.js";
import { clientCard, clientFlag } from "./clientcard.js";
import { mountCalendar } from "./calendar.js";
import { contactRow, onMyWay, mapsHref, homeLinksHTML, VISIT_TAG } from "./contact.js";
import { intakeHTML } from "./intake.js";
import { pushButton, refreshPush } from "./pushclient.js";
import { collection, doc, onSnapshot, query, orderBy, where, updateDoc, serverTimestamp, writeBatch, Timestamp } from "firebase/firestore";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const html = (str) => { const t = document.createElement("template"); t.innerHTML = str.trim(); return t.content.firstElementChild; };
let CUR = "PHP";
// counter can override these warnings (busy stylist, stylist off / on break, same number already booked)
const OVERRIDE_RE = /already has a client|already has an active booking| is (on leave|on a day off|off duty|on break|blocked off)/;
const money = (n) => (CUR === "PHP" ? "₱" : CUR + " ") + Number(n || 0).toLocaleString("en-PH", { maximumFractionDigits: 2 });
const STATUS = { unconfirmed: ["⏳ Awaiting Messenger", "var(--new)"], pending: ["Requested", "var(--new)"], confirmed: ["Confirmed", "var(--prep)"], in_progress: ["In progress", "var(--prep)"], done: ["Done", "var(--ready)"], cancelled: ["Cancelled", "var(--line)"], no_show: ["No-show", "var(--danger)"] };
const fmtT = (d) => d.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" });
const dstr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

let calInst = null, pendingNext = null;
const stTok = () => getActiveStaff(ctx.storeId)?.token || null;
const placeOf = () => ctx.store.settings?.setup?.place || (ctx.store.settings?.salon?.homeService?.enabled ? "both" : "shop");
let ctx, appts = [], staff = [], items = [], cats = [], duties = [], day = new Date(), tab = "board", headEl, mainEl, unsubDay = null, due = [], prefill = null;

export function bootSalon(c) {
  startCountdown(); setTimeout(() => refreshPush(c.storeId, "counter"), 3000);
  ctx = c; CUR = c.store.settings?.currency || "PHP";
  c.app.innerHTML = `<div><div id="head"></div><div id="main" class="c-main"></div></div>`;
  headEl = document.getElementById("head"); mainEl = document.getElementById("main");
  onSnapshot(query(collection(db, "stores", c.storeId, "staff"), orderBy("name")), (snap) => { staff = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((x) => x.active !== false); if (tab === "board") draw(); });
  onSnapshot(query(collection(db, "stores", c.storeId, "items"), orderBy("sortOrder")), (snap) => { items = snap.docs.map((d) => ({ id: d.id, ...d.data() })); });
  onSnapshot(query(collection(db, "stores", c.storeId, "categories"), orderBy("sortOrder")), (snap) => { cats = snap.docs.map((d) => ({ id: d.id, ...d.data() })); });
  onSnapshot(query(collection(db, "stores", c.storeId, "duties"), where("status", "in", ["pending", "on"])), (snap) => { duties = snap.docs.map((d) => ({ id: d.id, ...d.data() })); drawHead(); }, () => {});
  watchDay(); drawHead(); draw();
  // clients due back (from checkout "rebook after N weeks")
  const startDue = () => watchDue(c.storeId, (list) => {
    due = list; drawHead(); if (tab === "due" || tab === "board") draw();
    // chime once a day when someone needs a reminder
    const key = `salon:duechime:${c.storeId}:${dstr(new Date())}`;
    try { if (needsReminder(due).length && !localStorage.getItem(key)) { localStorage.setItem(key, "1"); chime(0.25); } } catch {}
  });
  let unsubDue = startDue();
  watchGifts(); watchWaits(); watchBirthdays();
  setInterval(() => { unsubDue?.(); unsubDue = startDue(); }, 3 * 3600e3); // refresh the 14-day window
}
export function salonStoreUpdated(store) { if (!ctx) return; ctx.store = store; CUR = store.settings?.currency || "PHP"; drawHead(); }
export function salonShiftUpdated(sh) { ctx.openShift = sh; drawHead(); }

function watchDay() {
  unsubDay?.();
  const start = new Date(day); start.setHours(0, 0, 0, 0); const end = new Date(start.getTime() + 86400000);
  let first = true;
  unsubDay = onSnapshot(query(collection(db, "stores", ctx.storeId, "appointments"), where("startAt", ">=", Timestamp.fromDate(start)), where("startAt", "<", Timestamp.fromDate(end)), orderBy("startAt")), (snap) => {
    const prev = new Map(appts.map((a) => [a.id, a]));
    appts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    // a client checked in from their phone → chime + toast
    if (!first) appts.filter((a) => a.arrivedAt && a.arrivedBy === "customer" && !prev.get(a.id)?.arrivedAt).forEach((a) => { chime(0.3); toastMsg(`📍 ${a.customer?.name || "A client"} is here${a.providerName ? ` (for ${a.providerName.split(" ")[0]})` : ""}`); });
    first = false; drawHead(); if (tab === "board") draw();
  }, (e) => console.warn(e));
}
const stylists = () => staff.filter((x) => (x.roles || []).includes("stylist"));
// owner-only salon: one "My day" list, no assigning / rotation / duty
const solo = () => ctx.store.settings?.setup?.kind === "solo";
const active = () => appts.filter((a) => ["unconfirmed", "pending", "confirmed", "in_progress"].includes(a.status));

function drawHead() {
  const isToday = dstr(day) === dstr(new Date());
  const unassigned = active().filter((a) => !a.providerId).length;
  headEl.innerHTML = `<header class="k-head">
    ${ctx.store.logoUrl ? `<img src="${esc(ctx.store.logoUrl)}" alt="" style="width:34px;height:34px;border-radius:8px;object-fit:cover"/>` : ""}<span class="name">${esc(ctx.store.name)}</span>
    <button class="k-btn sm ${tab === "board" ? "primary" : ""}" data-tab="board">📅 ${solo() ? "My day" : "Board"} <span class="k-tag">${active().length}</span></button>
    <button class="k-btn sm ${tab === "calendar" ? "primary" : ""}" data-tab="calendar">🗓 Calendar</button>
    <button class="k-btn sm ${tab === "walkin" ? "primary" : ""}" data-tab="walkin">➕ ${placeOf() === "home" ? "Booking" : "Walk-in / booking"}</button>
    ${ctx.store.settings?.salon?.giftcards?.enabled ? `<button class="k-btn sm ${tab === "gift" ? "primary" : ""}" data-tab="gift">🎁 Gift cards ${gifts.length ? `<span class="k-badge">${gifts.length}</span>` : ""}</button>` : ""}
    <button class="k-btn sm ${tab === "due" ? "primary" : ""}" data-tab="due">🔁 Due back ${needsReminder(due).length ? `<span class="k-badge">${needsReminder(due).length}</span>` : due.length ? `<span class="k-tag">${due.length}</span>` : ""}</button>
    <span class="row" style="gap:4px"><button class="k-btn sm" data-prev>‹</button><b style="min-width:120px;text-align:center">${isToday ? "Today" : day.toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric" })}</b><button class="k-btn sm" data-next>›</button></span>
    <span class="sp"></span>
    ${unassigned && !solo() ? `<span class="k-tag" style="color:var(--new)">${unassigned} to assign</span>` : ""}
    ${ctx.store.settings?.salon?.queue?.enabled !== false ? `<a class="k-btn sm" href="/tv/${esc(ctx.store.slug)}" target="_blank" rel="noopener" title="Open on a TV or tablet at the shop">📺 Queue TV</a>` : ""}
    ${isToday && ctx.store.settings?.salon?.queue?.enabled !== false ? `<button class="k-btn sm ${ctx.store.settings?.salon?.queue?.paused ? "danger" : ""}" id="qPause" title="Walk-in line">${ctx.store.settings?.salon?.queue?.paused ? "▶ Open the line" : `⏸ Pause line`} <span class="k-tag">${active().filter((a) => a.waiting).length} in line</span></button>` : ""}
    ${solo() ? "" : duties.filter((d) => d.status === "pending").map((d) => `<span class="k-tag" style="color:var(--new);padding:6px 8px">⏳ ${esc(d.name)} started duty <button class="k-btn sm ready" data-acc="${d.id}">Accept</button><button class="k-btn sm" data-dec="${d.id}">✕</button></span>`).join("")}
    ${solo() ? "" : `<span class="k-tag paid">${duties.filter((d) => d.status === "on").length} on duty</span>`}
    ${showPresence() ? `<button class="k-btn sm" id="presBtn" title="What customers see">${presLabel()}</button>` : ""}
    <button class="k-btn sm ${ctx.openShift ? "" : "danger"}" id="shiftBtn">${ctx.openShift ? (ctx.openShift.status === "needs_count" ? "🌙 Count cash" : ctx.openShift.status !== "open" ? "⚠️ Shift check" : "📊 Shift") : "▶ Start shift"}</button>
    <button class="k-btn sm" id="userBtn">👤 ${esc(ctx.me?.name || "")}</button>
  </header>`;
  headEl.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => { tab = b.dataset.tab; drawHead(); draw(); }));
  headEl.querySelector("[data-prev]").onclick = () => { day = new Date(day.getTime() - 86400000); watchDay(); drawHead(); };
  headEl.querySelector("[data-next]").onclick = () => { day = new Date(day.getTime() + 86400000); watchDay(); drawHead(); };
  headEl.querySelector("#shiftBtn").onclick = ctx.openShiftPanel;
  headEl.querySelectorAll("[data-acc]").forEach((b) => (b.onclick = async () => { b.disabled = true; try { await call("acceptDuty", { id: b.dataset.acc, staffName: ctx.me?.name }); } catch (e) { alert(e.message); } }));
  headEl.querySelectorAll("[data-dec]").forEach((b) => (b.onclick = async () => { if (!confirm("Decline this duty start?")) return; try { await call("acceptDuty", { id: b.dataset.dec, decline: true, staffName: ctx.me?.name }); } catch (e) { alert(e.message); } }));
  headEl.querySelector("#userBtn").onclick = ctx.switchUser;
  { const pb = pushButton(ctx.storeId, "counter"); headEl.querySelector("#userBtn").before(pb); }
  headEl.querySelector("#presBtn")?.addEventListener("click", presencePanel);
  headEl.querySelector("#qPause")?.addEventListener("click", async () => { const paused = !!ctx.store.settings?.salon?.queue?.paused; if (!paused && !confirm("Pause the line? People already in line stay; new people can't join until you open it again.")) return; try { await call("queueOps", { action: paused ? "resume" : "pause", staffToken: stTok() }); } catch (e) { alert(e.message); } });
}
// ---------------- owner status shown to customers ----------------
const PRES = [["in", "🟢 In the shop"], ["home", "🏠 On home service"], ["break", "☕ Short break"], ["away", "🚶 Stepped out"], ["closed", "🔴 Closed today"]];
const curPres = () => { const p = ctx.store.salonLive?.presence; return p && (!p.until || p.until > Date.now()) ? p : null; };
const showPresence = () => solo() || placeOf() !== "shop" || ctx.store.settings?.salon?.ownerWorks;
const presLabel = () => { const p = curPres(); const l = (PRES.find(([k]) => k === (p?.state || "in")) || PRES[0])[1]; return `${l}${p?.backAt && p.state !== "in" ? ` · back ${p.backAt}` : ""}${p?.waitNote ? " · " + esc(p.waitNote) : ""}`; };
function presencePanel() {
  const p = curPres() || { state: "in" };
  const el = html(`<div><p class="small muted">Shown on your customer page. Resets at midnight.</p>
    <div class="stack" style="gap:6px">${PRES.map(([k, l]) => `<label class="check" style="margin:0"><input type="radio" name="ps" value="${k}" ${p.state === k ? "checked" : ""}/> ${l}</label>`).join("")}</div>
    <label>Back at (optional)</label><input class="k-input" type="time" data-back value="${esc(p.backAt || "")}"/>
    <label>Line / wait note (optional)</label><input class="k-input" data-wait maxlength="80" value="${esc(p.waitNote || "")}" placeholder="e.g. 2 in line · about 40 min"/>
    <p class="small muted">${solo() && ctx.store.settings?.salon?.walkInWhenAway === "off" ? "While you're out, walk-ins are paused (Tools → Home service)." : "While you're out, walk-ins can still join the line and are served when you're back."}</p>
    <button class="k-btn primary" data-save style="width:100%;margin-top:8px">Save</button></div>`);
  el.querySelector("[data-save]").onclick = async (e) => {
    e.target.disabled = true;
    try { await call("setPresence", { state: el.querySelector("[name=ps]:checked")?.value || "in", backAt: el.querySelector("[data-back]").value || null, waitNote: el.querySelector("[data-wait]").value.trim(), staffToken: stTok() }); ctx.closeDrawer(); }
    catch (x) { alert(x.message); e.target.disabled = false; }
  };
  ctx.openDrawer("What customers see", el);
}
function draw() {
  if (tab === "calendar") { if (calInst && mainEl.querySelector(".cal")) { if (pendingNext) { calInst.nextVisit(pendingNext); pendingNext = null; } return; } calInst?.destroy(); mainEl.innerHTML = ""; const host = document.createElement("div"); mainEl.appendChild(host); calInst = mountCalendar(host, { storeId: ctx.storeId, getStore: () => ctx.store, cur: CUR, open: (t, n) => ctx.openDrawer(t, n), close: () => ctx.closeDrawer(), staffToken: stTok, meName: () => ctx.me?.name || null }); if (pendingNext) { calInst.nextVisit(pendingNext); pendingNext = null; } return; }
  calInst?.destroy(); calInst = null;
  mainEl.innerHTML = ""; if (tab === "board") { dueBanner(); drawBoard(); } if (tab === "walkin") { walkinForm(prefill); prefill = null; } if (tab === "due") drawDue(); if (tab === "gift") drawGifts(); }

function toastMsg(t) { const el = html(`<div style="position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--ready-bg);color:#052e16;font-weight:800;padding:12px 18px;border-radius:14px;border:2px solid var(--edge);z-index:99;box-shadow:0 10px 30px rgba(0,0,0,.4)">${esc(t)}</div>`); document.body.appendChild(el); setTimeout(() => el.remove(), 6000); }

// ---------------- gift cards (counter) ----------------
let gifts = [];
function watchGifts() { let firstG = true; onSnapshot(query(collection(db, "stores", ctx.storeId, "giftcards"), where("status", "==", "pending")), (snap) => { const before = gifts.length; gifts = snap.docs.map((d) => ({ id: d.id, ...d.data() })); if (!firstG && gifts.length > before) { chime(0.25); toastMsg("🎁 New gift card payment to verify"); } firstG = false; drawHead(); if (tab === "gift") draw(); }, () => {}); }
function drawGifts() {
  const wrap = html(`<div class="lj-form"><div class="lj-col"><h3>⏳ Online gift cards to verify <span class="k-tag">${gifts.length}</span></h3><div data-pend></div>
      <h3 style="margin-top:18px">🔎 Check balance</h3><div style="display:flex;gap:6px"><input class="k-input" data-lk placeholder="GC-XXXX-XXXX" style="text-transform:uppercase;flex:1"/><button class="k-btn" data-lkgo>Check</button></div><div data-lkres class="small" style="margin-top:6px"></div></div>
    <div class="lj-col"><h3>🎁 Sell a gift card</h3>
      <label>Amount (₱)</label><input class="k-input" data-amt type="number" min="100" value="1000"/>
      <label>For (recipient)</label><input class="k-input" data-to/>
      <label>From (buyer)</label><input class="k-input" data-from/><input class="k-input" data-fphone placeholder="Buyer's mobile (optional)" inputmode="tel"/>
      <label>Message</label><input class="k-input" data-msg maxlength="120"/>
      <label>Design</label><select class="k-input" data-design><option value="classic">✨ Classic</option><option value="birthday">🎂 Birthday</option><option value="love">💖 Love</option><option value="holiday">🎄 Holiday</option></select>
      <div class="c-methods" style="margin-top:10px">${payMethods(ctx.store).map((m) => `<button data-m="${esc(m.id)}">${m.icon} ${esc(m.name)}</button>`).join("")}</div></div></div>`);
  const pend = wrap.querySelector("[data-pend]");
  pend.innerHTML = gifts.map((g) => `<div class="k-card" style="margin-bottom:8px"><div class="top"><div><div class="no">${money(g.amount)}</div><div class="where">${esc(g.from?.name)} → ${esc(g.to?.name)} · ${esc(g.from?.phone || "")}</div></div><div class="time">${esc(g.payment?.methodName || "")}<span class="eta">ref ${esc(g.payment?.refNo || "")}</span></div></div>${g.payment?.proofUrl ? `<a class="small" data-priv="${esc(g.payment.proofUrl)}" target="_blank">View screenshot</a>` : ""}<div class="acts"><button class="k-btn ready sm" data-ok="${g.id}">✓ Payment received</button><button class="k-btn sm danger" data-no="${g.id}">✕ Not found</button></div></div>`).join("") || `<p class="small muted">Nothing to verify.</p>`;
  hydratePrivate(pend);
  pend.querySelectorAll("[data-ok]").forEach((b) => (b.onclick = async () => { b.disabled = true; try { const r = await call("giftOps", { action: "verify", id: b.dataset.ok, staffToken: getActiveStaff(ctx.storeId)?.token || null }); toastMsg(`Gift card active: ${r.code}`); } catch (e) { alert(e.message); b.disabled = false; } }));
  pend.querySelectorAll("[data-no]").forEach((b) => (b.onclick = async () => { const n = prompt("Reason (shown to the buyer):", "We couldn't find this reference number."); if (n === null) return; try { await call("giftOps", { action: "reject", id: b.dataset.no, note: n, staffToken: getActiveStaff(ctx.storeId)?.token || null }); } catch (e) { alert(e.message); } }));
  wrap.querySelector("[data-lkgo]").onclick = async () => { const res = wrap.querySelector("[data-lkres]"); try { const r = await call("giftOps", { action: "lookup", code: wrap.querySelector("[data-lk]").value, staffToken: getActiveStaff(ctx.storeId)?.token || null }); res.innerHTML = `<b>${esc(r.code)}</b> · ${esc(r.status)} · balance <b>${money(r.balance)}</b> of ${money(r.amount)} · for ${esc(r.to?.name || "")} · until ${fmtDate(r.expires)}`; } catch (e) { res.textContent = e.message; } };
  wrap.querySelectorAll("[data-m]").forEach((b) => (b.onclick = async () => {
    const v = (k) => wrap.querySelector(`[data-${k}]`).value.trim();
    if (!Number(v("amt")) || !v("to")) return alert("Enter the amount and the recipient.");
    if (!confirm(`Sell a ${money(v("amt"))} gift card paid by ${b.textContent.trim()}?`)) return;
    b.disabled = true;
    try {
      const r = await call("giftOps", { action: "sell", amount: Number(v("amt")), to: { name: v("to") }, from: { name: v("from"), phone: v("fphone") }, message: v("msg"), design: v("design"), methodId: b.dataset.m, staffToken: getActiveStaff(ctx.storeId)?.token || null });
      const { drawGiftCard, downloadCanvas, loadLogo } = await import("./giftcard.js");
      const cv = drawGiftCard(document.createElement("canvas"), { storeName: ctx.store.name, logoImg: await loadLogo(ctx.store.logoUrl), amount: Number(v("amt")), to: v("to"), from: v("from"), message: v("msg"), code: r.code, expires: r.expires, design: v("design"), status: "active" });
      const box = html(`<div><p>Gift card <b>${esc(r.code)}</b> is active.</p><img src="${cv.toDataURL("image/png")}" style="width:100%;border-radius:14px"/><div class="acts" style="margin-top:10px"><button class="k-btn primary" data-dl>⬇ Download PNG</button><button class="k-btn" data-pr>🖨 Print</button></div></div>`);
      box.querySelector("[data-dl]").onclick = () => downloadCanvas(cv, `gift-card-${r.code}.png`);
      box.querySelector("[data-pr]").onclick = () => { const w = window.open(""); if (!w) return; w.document.write(`<img src="${cv.toDataURL("image/png")}" style="width:100%"/><script>setTimeout(()=>print(),300)<\/script>`); w.document.close(); };
      ctx.openDrawer("Gift card sold", box); draw();
    } catch (e) { alert(e.message); }
    b.disabled = false;
  }));
  mainEl.appendChild(wrap);
}

// ---------------- due back ----------------
const storeLink = () => `${location.origin}/m/${ctx.store.slug}`;
function bookFromDue(c) {
  const n = c.nextDue;
  const at = Math.max(n.at, Date.now() + 3600e3); const d = new Date(at); d.setMinutes(0, 0, 0); if (d.getHours() < 10) d.setHours(10);
  prefill = { name: c.name || "", phone: c.phone || "", itemIds: n.itemId ? [n.itemId] : [], providerId: n.providerId || "", when: d.getTime(), note: `Rebook · ${n.service || ""}` };
  tab = "walkin"; drawHead(); draw();
}
function dueBanner() {
  const list = needsReminder(due); if (!list.length) return;
  const el = html(`<div class="k-note" style="margin:0 0 12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;border-left:4px solid var(--new)">
    <b>🔔 Remind ${list.length} client${list.length > 1 ? "s" : ""} today:</b>
    <span class="small">${list.slice(0, 5).map((c) => `${esc((c.name || c.phone || "").split(" ")[0])} <span class="muted">(${esc(c.nextDue.service || "visit")}${c.nextDue.at < Date.now() - 86400e3 ? ", late" : ""})</span>`).join(" · ")}${list.length > 5 ? ` +${list.length - 5} more` : ""}</span>
    <button class="k-btn sm primary" data-open>Open Due back</button></div>`);
  el.querySelector("[data-open]").onclick = () => { tab = "due"; drawHead(); draw(); };
  mainEl.appendChild(el);
}
let waits = [], bdays = [];
function watchWaits() { onSnapshot(query(collection(db, "stores", ctx.storeId, "slotWaits"), where("date", ">=", dstr(new Date()))), (snap) => { waits = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((w) => ["waiting", "notified"].includes(w.status)).sort((a, b) => a.date.localeCompare(b.date)); if (tab === "due") draw(); }, () => {}); }
function watchBirthdays() { onSnapshot(query(collection(db, "stores", ctx.storeId, "customers"), where("birthMonth", "==", new Date().getMonth() + 1)), (snap) => { bdays = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((c) => !c.flagged).sort((a, b) => (a.birthday || "").localeCompare(b.birthday || "")); if (tab === "due") draw(); }, () => {}); }
function drawWaitsAndBdays(box) {
  if (waits.length) {
    const g = html(`<div style="margin-bottom:16px"><h3 style="margin:6px 0 8px">📋 Waiting for a slot <span class="k-tag">${waits.length}</span></h3><div class="c-grid">${waits.map((w) => `<article class="k-card" style="border-top-color:${w.status === "notified" ? "var(--ready)" : "var(--new)"}"><div class="top"><div><div class="no">${esc(w.customer?.name || "")}</div><div class="where">${esc(w.customer?.phone || "")}</div></div><div class="time">${fmtDate(new Date(`${w.date}T12:00:00`).getTime())}<span class="eta">${w.status === "notified" ? `slot opened ✓${w.smsSent ? " · SMS sent" : " · call them"}` : "waiting"}</span></div></div><div class="small">${(w.services || []).map(esc).join(", ")}</div><div class="acts"><button class="k-btn primary sm" data-wbook="${w.id}">📅 Book</button>${w.customer?.phone ? `<a class="k-btn sm" href="tel:${esc(w.customer.phone)}">📞 Call</a>` : ""}<button class="k-btn sm danger" data-wx="${w.id}">✕ Remove</button></div></article>`).join("")}</div></div>`);
    g.querySelectorAll("[data-wbook]").forEach((b) => (b.onclick = () => { const w = waits.find((x) => x.id === b.dataset.wbook); prefill = { name: w.customer?.name, phone: w.customer?.phone, itemIds: w.itemIds || [], providerId: w.providerId || "", when: new Date(`${w.date}T10:00:00`).getTime(), note: "From waitlist" }; updateDoc(doc(db, "stores", ctx.storeId, "slotWaits", w.id), { status: "booked" }).catch(() => {}); tab = "walkin"; drawHead(); draw(); }));
    g.querySelectorAll("[data-wx]").forEach((b) => (b.onclick = () => updateDoc(doc(db, "stores", ctx.storeId, "slotWaits", b.dataset.wx), { status: "removed" }).catch((e) => alert(e.message))));
    box.appendChild(g);
  }
  if (bdays.length && feat("birthday")) {
    const g = html(`<div style="margin-bottom:16px"><h3 style="margin:6px 0 8px">🎂 Birthdays this month <span class="k-tag">${bdays.length}</span></h3><div class="c-grid">${bdays.map((c) => `<article class="k-card"><div class="top"><div><div class="no">${esc(c.name || "")}</div><div class="where">${esc(c.phone || "")}</div></div><div class="time">🎂 ${esc(c.birthday || "")}</div></div><div class="small">${c.birthdayVoucher && c.birthdayYear === new Date().getFullYear() ? `Voucher <b>${esc(c.birthdayVoucher.code)}</b> · ${esc(c.birthdayVoucher.off)} · until ${esc(c.birthdayVoucher.validTo)} ${c.birthdayVoucher.smsSent ? "· SMS sent ✓" : "· <b>send it manually</b>"}` : "Voucher is created automatically during the day."}</div>${c.birthdayVoucher && c.phone ? `<div class="acts"><button class="k-btn sm" data-bcopy="${esc(c.id)}">📋 Copy greeting</button><a class="k-btn sm" href="sms:${esc(c.phone)}">💬 Text</a></div>` : ""}</article>`).join("")}</div></div>`);
    g.querySelectorAll("[data-bcopy]").forEach((b) => (b.onclick = async () => { const c = bdays.find((x) => x.id === b.dataset.bcopy); const t = `Happy birthday month, ${(c.name || "").split(" ")[0]}! 🎂 Enjoy ${c.birthdayVoucher.off} at ${ctx.store.name} until ${c.birthdayVoucher.validTo}. Code ${c.birthdayVoucher.code}. Book: ${storeLink()}`; try { await navigator.clipboard.writeText(t); b.textContent = "Copied ✓"; } catch { prompt("Copy:", t); } }));
    box.appendChild(g);
  }
}
function drawDue() {
  const wrap = html(`<div><div class="k-note" style="margin-bottom:12px">🔁 Clients who should come back, based on each service's <b>"rebook after N weeks"</b> (Services page). ${ctx.store.settings?.salon?.rebook?.enabled ? "An SMS is sent automatically on the due date; " : ""}call or text the ones in red and orange, then tap <b>Contacted</b>. Booking them removes them from this list.</div><div data-groups></div></div>`);
  const box = wrap.querySelector("[data-groups]");
  drawWaitsAndBdays(box);
  if (!due.length) box.insertAdjacentHTML("beforeend", `<div class="k-empty">No clients due in the next 14 days.<br><span class="small">Set "Rebook reminder after (weeks)" on your services so clients appear here after checkout.</span></div>`);
  dueGroups(due).forEach(([label, list]) => {
    if (!list.length) return;
    const g = html(`<div style="margin-bottom:16px"><h3 style="margin:6px 0 8px">${label} <span class="k-tag">${list.length}</span></h3><div class="c-grid">${list.map((c) => dueCardHTML(c, { money })).join("")}</div></div>`);
    bindDueActions(g, list, { storeId: ctx.storeId, me: ctx.me, storeName: ctx.store.name, link: storeLink(), onBook: bookFromDue });
    box.appendChild(g);
  });
  mainEl.appendChild(wrap);
}

// ---------------- board ----------------
function drawBoard() {
  const cols = [...(solo() && !appts.some((a) => !a.providerId && a.status !== "cancelled") ? [] : [{ id: null, name: "Waitlist / unassigned" }]), ...stylists()];
  const waitingList = appts.filter((a) => a.waiting && ["pending", "confirmed"].includes(a.status)).sort((x, y) => (x.waitNo || 0) - (y.waitNo || 0));
  const wrap = html(`<div class="sl-board"></div>`);
  cols.forEach((c) => {
    const list = appts.filter((a) => (a.providerId || null) === c.id && a.status !== "cancelled").sort((x, y) => (c.id ? 0 : ((y.waiting ? 1 : 0) - (x.waiting ? 1 : 0)) || ((x.waitNo || 0) - (y.waitNo || 0))) || x.startAt.toMillis() - y.startAt.toMillis());
    const busy = list.filter((a) => a.status === "in_progress").length;
    const nextFor = c.id ? waitingList.find((a) => !(c.skills || []).length || (a.categories || []).every((k) => c.skills.includes(k))) : null;
    const dayMs = new Date(`${dstr(day)}T12:00:00+08:00`).getTime();
    const isToday = dstr(day) === dstr(new Date());
    const off = c.id ? offReason(c, isToday ? Date.now() : dayMs) : null;
    const onLeave = c.id && (c.schedule?.leaves || []).includes(dstr(day));
    const col = html(`<div class="k-col ${c.id ? "" : "new"}" ${off ? 'style="opacity:.75"' : ""}><h2>${c.photoUrl ? `<img src="${esc(c.photoUrl)}" alt="" style="width:26px;height:26px;border-radius:50%;object-fit:cover;margin-right:6px"/>` : ""}${esc(c.name)}${c.id && c.onDuty ? ` <span class="k-tag paid">on duty</span>` : ""}${off ? ` <span class="k-tag" style="color:var(--danger)">${esc(off)}</span>` : ""}${c.id ? ` <button class="k-btn sm" data-leave="${c.id}" data-off="${onLeave ? "0" : "1"}" title="Mark absent / back for this day">${onLeave ? "↩ Back" : "🚫 Absent"}</button>` : ""}<span class="n">${list.filter((a) => a.status !== "done").length}${busy ? ` · ${busy} active` : ""}</span></h2>${nextFor && !busy ? `<div class="k-tag" style="display:block;margin:0 0 10px;padding:8px;color:var(--ready);background:rgba(60,200,120,.12)">Next in line for ${esc(c.name.split(" ")[0])}: <b>#${nextFor.waitNo} ${esc(nextFor.customer?.name || "")}</b> · ${(nextFor.items || []).map((l) => esc(l.name)).join(", ")} <button class="k-btn sm" data-take="${nextFor.id}" data-st="${c.id}">Take</button></div>` : ""}</div>`);
    col.querySelector("[data-take]")?.addEventListener("click", async (e) => { e.target.disabled = true; const body = { id: e.target.dataset.take, providerId: e.target.dataset.st, staffName: ctx.me?.name }; try { await call("assignAppointment", body); } catch (err) { if (OVERRIDE_RE.test(err.message) && confirm(`${err.message}\n\nAssign anyway?`)) { try { await call("assignAppointment", { ...body, force: true }); } catch (x) { alert(x.message); } } else alert(err.message); e.target.disabled = false; } });
    col.querySelector("[data-leave]")?.addEventListener("click", async (e) => {
      const b = e.currentTarget; const off = b.dataset.off === "1";
      if (off && !confirm(`Mark ${c.name} absent on ${isToday ? "today" : dstr(day)}? Customers can't book ${c.name.split(" ")[0]} that day.`)) return;
      b.disabled = true;
      try { await call("setStylistLeave", { staffId: c.id, date: dstr(day), off, staffToken: getActiveStaff(ctx.storeId)?.token || null }); } catch (err) { alert(err.message); b.disabled = false; }
    });
    list.forEach((a) => col.appendChild(card(a)));
    if (!list.length) col.appendChild(html(`<div class="k-empty" style="padding:20px">—</div>`));
    wrap.appendChild(col);
  });
  mainEl.appendChild(wrap);
}
function card(a) {
  const [label, color] = STATUS[a.status] || [a.status, "var(--line)"];
  const st = a.startAt.toDate(); const dur = a.durationConfirmed || a.durationEst; const end = new Date(st.getTime() + dur * 60000);
  const late = ["pending", "confirmed"].includes(a.status) && Date.now() > st.getTime() + (ctx.store.settings?.salon?.graceMin || 15) * 60000;
  const el = html(`<article class="k-card" style="border-top-color:${color}${a.status === "done" ? ";opacity:.6" : ""}">
    <div class="top"><div><div class="no">${a.waiting ? `<span style="color:var(--danger)">⏳ WAIT #${a.waitNo || "?"}</span>` : fmtT(st)} <span class="k-tag">${label}</span>${a.test ? ` <span class="k-tag" style="background:#ffe58a;color:#6b4a00">🧪 TEST</span>` : ""}${a.source === "walkin" ? ` <span class="k-tag">walk-in</span>` : ""}${a.homeService ? ` <span class="k-tag">🏠 home</span>` : ""}${a.tentative ? ` <span class="k-tag" style="color:${VISIT_TAG[a.visitConfirm?.status || "waiting"][1]};background:#fff">${VISIT_TAG[a.visitConfirm?.status || "waiting"][0]}</span>` : ""}${a.onTheWay ? ` <span class="k-tag paid">🚗 on the way</span>` : ""}${a.arrivedAt && ["pending", "confirmed", "unconfirmed"].includes(a.status) ? ` <span class="k-tag paid">📍 here ${fmtT(new Date(a.arrivedAt))}</span>` : a.lateBy ? ` <span class="k-tag" style="color:var(--new)">⏰ ~${a.lateBy.minutes} min late</span>` : late ? ` <span class="k-tag" style="color:var(--danger)">late</span>` : ""}</div>
      <div class="where">${esc(a.customer?.name || "")}${a.customer?.phone ? ` · ${esc(a.customer.phone)}` : ""}${a.customer?.messenger ? " " + msgrBtn(a.customer.messenger, "k-tag", "💬 Messenger") : ""}</div></div>
      <div class="time">${esc(a.code)}<span class="eta">~${dur} min${a.durationConfirmed ? " ✓" : ""} → ${fmtT(end)}</span></div></div>
    <ul>${(a.items || []).map((l) => `<li><span class="q">${l.duration}m</span><span>${esc(l.name)}</span><span class="amt">${money(l.price)}</span></li>`).join("")}</ul>
    ${a.notes ? `<div class="small muted">📝 ${esc(a.notes)}</div>` : ""}${a.requestedProviderId && !a.providerId ? `<div class="small" style="color:var(--new)">Requested: ${esc(staff.find((x) => x.id === a.requestedProviderId)?.name || "")}</div>` : ""}
    ${a.homeService?.prep?.bring?.length ? `<div class="small" style="color:#b45309;font-weight:600">🧺 Bring: ${esc(a.homeService.prep.bring.join(", "))}</div>` : ""}${a.homeService ? `<div class="small" style="color:var(--new)">🏠 ${esc(a.homeService.address || "")}${a.homeService.landmark ? ` · ${esc(a.homeService.landmark)}` : ""}${a.homeService.area ? ` · <b>${esc(a.homeService.area)}</b>` : ""} · fee ${money(a.homeFee || 0)}${a.homeService.feeConfirmed ? " ✓" : " (unconfirmed)"}${homeLinksHTML(a.homeService, esc) ? ` · ${homeLinksHTML(a.homeService, esc)}` : ""} · 🚗 ${a.travelBefore || 0}m travel</div>` : ""}
    <div data-ct></div>
    ${a.roomName ? `<div class="small" style="color:var(--prep)">🚪 ${esc(a.roomName)}</div>` : ""}${a.genderPref ? `<div class="small muted">🚻 Prefers a ${a.genderPref} ${esc(staffWord())}</div>` : ""}
    ${a.escort ? `<div class="small" style="color:${a.escort.status === "pickup_requested" ? "var(--danger)" : "var(--new)"}">🛵 ${a.escort.riderName ? esc(a.escort.riderName) : "<b>No rider yet</b>"} · ${esc(ESC_LABEL[a.escort.status] || a.escort.status || "")}</div>` : ""}
    ${a.helpOpen ? `<div class="small" style="background:var(--danger);color:#fff;padding:6px 8px;border-radius:8px;font-weight:800">🆘 ${esc(a.safety?.by || a.providerName || "Staff")} pressed HELP${a.safety?.loc ? ` · <a style="color:#fff" target="_blank" rel="noopener" href="${esc(a.safety.loc)}">location</a>` : ""}</div>` : a.overdueOpen ? `<div class="small" style="color:var(--danger);font-weight:700">⏰ Running past the expected end — call ${esc(a.providerName || "them")}</div>` : a.safety?.state === "safe" ? `<div class="small" style="color:var(--ready)">✅ ${esc(a.safety.by || "")} checked in safe${a.safety.at ? ` · ${fmtT(new Date(a.safety.at))}` : ""}${a.safety.loc ? ` · <a target="_blank" rel="noopener" href="${esc(a.safety.loc)}">📍 map</a>` : ""}</div>` : a.homeService && a.status === "in_progress" && a.checkinNudgeAt ? `<div class="small" style="color:var(--new);font-weight:700">⚠️ No safety check-in yet from ${esc(a.providerName || "staff")} — call them</div>` : ""}
    ${a.tipOnline ? `<div class="small" style="color:${a.tipOnline.status === "to_verify" ? "var(--new)" : a.tipOnline.status === "verified" ? "var(--ready)" : "var(--danger)"}">💝 Tip ${money(a.tipOnline.amount)} · ${esc(a.tipOnline.methodName)} ref <b>${esc(a.tipOnline.refNo)}</b> · ${{ to_verify: "TO VERIFY", verified: "received", rejected: "not found" }[a.tipOnline.status] || ""}</div>` : ""}${a.bookPromo ? `<div class="small" style="color:var(--prep)">🏷️ ${esc((a.bookPromo.applied || []).map((x) => x.name).join(" + "))}${a.bookPromo.amount ? ` · −${money(a.bookPromo.amount)}` : ""}${a.bookPromo.homeFeeWaived ? " · free transport" : ""}</div>` : ""}${a.voucherCode && !a.paid ? `<div class="small muted">🎟️ Code ${esc(a.voucherCode)} — applied at checkout</div>` : ""}
    ${a.waiting ? `<div class="small" style="font-weight:700;color:${a.queueCalled?.at ? "var(--ready)" : "var(--new)"}">🎟️ #${a.waitNo || "?"} · ${a.queue?.ahead === 0 ? "first in line" : `${a.queue?.ahead ?? "?"} ahead`}${a.queue?.etaAt ? ` · ~${fmtT(new Date(a.queue.etaAt))}` : ""}${a.queue?.staffId ? ` · likely ${esc(staff.find((x) => x.id === a.queue.staffId)?.name || "")}` : ""}${a.queueCalled?.at ? ` · 📣 called ${fmtT(new Date(a.queueCalled.at))}${a.queueCalled.onWay ? " · 🚶 on the way" : ""}` : ""}${a.atShop ? " · at the shop" : " · joined online"}${a.queueSkips ? ` · skipped ${a.queueSkips}×` : ""}</div>` : ""}
    ${a.change?.status === "pending" ? `<div class="small" style="background:#FEF3C7;padding:6px 8px;border-radius:8px">${a.change.downgrade ? "⚠️ <b>Cheaper service asked</b>" : "🔁 <b>Service change</b>"} by ${esc(a.change.by || "")}: ${esc((a.change.items || []).map((x) => x.name).join(", "))} · ${money(a.change.from)} → <b>${money(a.change.to)}</b>${a.change.reason ? ` · “${esc(a.change.reason)}”` : ""}${a.change.photo ? ` · <a data-priv="${esc(a.change.photo)}" target="_blank" rel="noopener">photo</a>` : ""} · client: ${{ yes: "confirmed ✓", no: "said no", null: "not yet", "n/a": "shop decides" }[a.change.client] || esc(a.change.client || "")}</div>` : a.change?.status === "applied" ? `<div class="small muted">🔁 Services changed (approved by ${esc(a.change.shopBy || "shop")})</div>` : ""}
    ${a.pro?.afterPhoto || a.pro?.noPhoto || a.pro?.short ? `<div class="small" style="color:${a.pro.short ? "var(--danger)" : "var(--muted)"}">${a.pro.afterPhoto ? `📷 <a data-priv="${esc(a.pro.afterPhoto)}" target="_blank" rel="noopener">After photo</a>` : `📷 No after photo: ${esc(a.pro.noPhoto || "")}`}${a.pro.actualMin != null ? ` · took ${a.pro.actualMin} of ${dur} min${a.pro.short ? " ⚠️ much faster than booked" : ""}` : ""}</div>` : ""}${a.verify && !a.verify.ok ? `<div class="small" style="color:var(--danger);font-weight:700">🚩 Client says the service didn't match${a.verify.note ? `: “${esc(a.verify.note)}”` : ""}</div>` : ""}
    ${offerLine(a)}${a.goHome ? `<div class="small" style="color:var(--prep)">🏠 ${esc(a.providerName || "Staff")} goes straight home after</div>` : ""}
    ${["done", "cancelled", "no_show"].includes(a.status) ? "" : intakeHTML(a.intake, esc)}
    ${a.groupId ? `<div class="small" style="color:var(--prep)">${a.couple ? "👥 Couple · " : "🔗 "}Part ${a.groupPart}/${a.groupSize}: ${(a.group || []).map((g) => `${esc(String(g.providerName || "?").split(" ")[0])} ${fmtT(new Date(g.startAt))}`).join(" → ")}</div>` : ""}
    ${a.dp ? `<div class="small" data-dp style="color:${a.dp.status === "verified" || a.dp.status === "used" ? "var(--ready)" : a.dp.status === "to_verify" ? "var(--new)" : "var(--danger)"}">💵 DP ${money(a.dp.amount)} · ${esc(a.dp.methodName)} ref <b>${esc(a.dp.refNo)}</b> · ${{ to_verify: "TO VERIFY", verified: "verified ✓", used: "deducted ✓", rejected: "rejected", forfeited: "forfeited (no-show)", refund_due: "REFUND DUE (cancelled)" }[a.dp.status] || esc(a.dp.status)}${a.dp.proofUrl ? ` · <a data-priv="${esc(a.dp.proofUrl)}" target="_blank">proof</a>` : ""}</div>` : ""}
    <div class="small" data-cflag></div>
    <div class="top"><b style="font-size:1.1rem">${money(a.paid && a.amountDue != null ? a.amountDue : (a.total || 0) + (a.homeFee || 0))}</b>${a.paid ? `<span class="k-tag paid">Paid · ${esc(a.paymentMethod || "")}</span>` : ""}</div>
    <div class="acts"></div></article>`);
  const acts = el.querySelector(".acts");
  const set = (patch) => updateDoc(doc(db, "stores", ctx.storeId, "appointments", a.id), { ...patch, updatedAt: serverTimestamp() }).catch((e) => alert(e.message));
  clientFlag(ctx.storeId, a.customerKey, el.querySelector("[data-cflag]"));
  if (a.customerKey && feat("clientcard")) { const cc = html(`<button class="k-btn sm">👤 Client</button>`); cc.onclick = () => clientCard({ storeId: ctx.storeId, key: a.customerKey, name: a.customer?.name, openDrawer: ctx.openDrawer, me: ctx.me, cur: CUR, stylists: stylists(), defaultProvider: a.providerId }); acts.appendChild(cc); }
  if (a.dp?.status === "to_verify") {
    const v = html(`<button class="k-btn ready sm">✓ DP received</button>`); v.onclick = () => apptOp(ctx.storeId, "dpVerify", { id: a.id }).catch((e) => alert(e.message)); acts.appendChild(v);
    const r = html(`<button class="k-btn sm">✕ DP not found</button>`); r.onclick = () => { const n = prompt("Reason (shown to the customer):", "We couldn't find this reference number."); if (n !== null) apptOp(ctx.storeId, "dpVerify", { id: a.id, reject: true, note: n }).catch((e) => alert(e.message)); }; acts.appendChild(r);
  }
  hydratePrivate(el);
  if (a.tipOnline?.status === "to_verify") { const tx = (body) => call("apptExtras", { id: a.id, staffToken: stTok(), ...body }); const tv = html(`<button class="k-btn ready sm">✓ Tip received</button>`); tv.onclick = () => tx({ action: "tipVerify" }).catch((e) => alert(e.message)); acts.appendChild(tv); const tr = html(`<button class="k-btn sm">✕ Tip not found</button>`); tr.onclick = () => { const n = prompt("Reason (shown to the client):", "We couldn't find this reference number."); if (n !== null) tx({ action: "tipVerify", reject: true, note: n }).catch((e) => alert(e.message)); }; acts.appendChild(tr); }
  if (["cancelled", "no_show"].includes(a.status)) return el;
  if (a.status === "done") { const nv = html(`<button class="k-btn sm">📅 Next visit</button>`); nv.onclick = () => { pendingNext = a; tab = "calendar"; drawHead(); draw(); }; acts.appendChild(nv); }
  if (["unconfirmed", "pending", "confirmed"].includes(a.status) && a.customer?.phone && (a.tentative || a.homeService)) {
    const box = el.querySelector("[data-ct]"); box.appendChild(contactRow(a, ctx.store, { kind: "confirm", staffToken: stTok(), onContacted: () => a.tentative && call("visitMark", { id: a.id, answer: "contacted", staffToken: stTok() }).catch(() => {}) }));
    if (a.tentative && a.visitConfirm?.status === "waiting") { const mk = html(`<div class="ct-row"><button class="ct-btn ok" data-m="yes">✅ Confirmed</button><button class="ct-btn" data-m="noanswer">📵 No answer</button><button class="ct-btn bad" data-m="no">❌ Can't make it</button></div>`); mk.querySelectorAll("[data-m]").forEach((b) => (b.onclick = async () => { if (b.dataset.m === "no" && !confirm("Cancel this visit? The time becomes free.")) return; b.disabled = true; try { await call("visitMark", { id: a.id, answer: b.dataset.m, staffToken: stTok() }); } catch (x) { alert(x.message); b.disabled = false; } })); box.appendChild(mk); }
  }
  if (a.homeService && ["pending", "confirmed"].includes(a.status)) { const ow = html(`<button class="k-btn">🚗 On my way</button>`); ow.onclick = () => onMyWay(a, ctx.store, stTok()).catch((x) => alert(x.message)); acts.appendChild(ow); }
  if (a.status === "done") {
    if (!a.paid) { const b = html(`<button class="k-btn primary">💵 Checkout</button>`); b.onclick = () => checkout(a); acts.appendChild(b); }
    if (a.paid) { const rc = html(`<button class="k-btn sm">🧾 Receipt</button>`); rc.onclick = () => printReceipt(ctx.store, apptReceipt(a), { cur: CUR, staffName: a.paidBy || ctx.me?.name || "" }); acts.appendChild(rc); }
    if (a.paid && ((ctx.me?.roles || []).includes("manager") || ctx.me?.owner || ctx.me?.staffId === "owner")) { const u = html(`<button class="k-btn sm">↩ Undo payment</button>`); u.onclick = () => { const r = prompt("Reason for undoing this payment:"); if (r) apptOp(ctx.storeId, "unpay", { id: a.id, reason: r }).catch((e) => alert(e.message)); }; acts.appendChild(u); }
    return el;
  }
  if (a.waiting) {
    const qo = (action) => call("queueOps", { id: a.id, action, staffToken: stTok() }).catch((e) => alert(e.message));
    if (a.queueCalled?.at) { const u = html(`<button class="k-btn sm">↩ Not yet</button>`); u.onclick = () => qo("uncall"); acts.appendChild(u); }
    else { const c = html(`<button class="k-btn ready">📣 Call #${a.waitNo || ""}</button>`); c.onclick = () => qo("call"); acts.appendChild(c); }
    const sk = html(`<button class="k-btn sm">⏭ Skip</button>`); sk.onclick = () => { if (confirm(`Move #${a.waitNo || ""} ${a.customer?.name || ""} to the back of the line?`)) qo("skip"); }; acts.appendChild(sk);
  }
  if (a.waiting) { const w = html(`<button class="k-btn primary">⏰ Set estimated time</button>`); w.onclick = () => { const v = prompt("Estimated start time (HH:MM, 24h):", fmtT(new Date(Date.now() + 30 * 60000)).replace(/ (AM|PM)/, "")); if (!v || !/^\d{1,2}:\d{2}$/.test(v)) return; const [h, m] = v.split(":").map(Number); const n = new Date(); n.setHours(h, m, 0, 0); if (n < new Date()) n.setDate(n.getDate() + 1); const note = prompt("Note to customer (optional):", "") || ""; set({ waiting: false, startAt: Timestamp.fromDate(n), waitNote: note }); }; acts.appendChild(w); }
  if (["unconfirmed", "pending", "confirmed"].includes(a.status) && !a.arrivedAt) { const ar = html(`<button class="k-btn ready">📍 Arrived</button>`); ar.onclick = () => set({ arrivedAt: Date.now(), arrivedBy: ctx.me?.name || "counter" }); acts.appendChild(ar); }
  if (a.status === "unconfirmed") { const b = html(`<button class="k-btn primary">✅ Confirmed on Messenger</button>`); b.onclick = () => set({ status: a.providerId ? "confirmed" : "pending", confirmedAt: serverTimestamp(), confirmedBy: ctx.me?.name || null }); acts.appendChild(b); }
  if (a.homeService) { const hf = html(`<button class="k-btn">🏠 Home fee ${money(a.homeFee || 0)} ✎</button>`); hf.onclick = () => { const v = prompt(`Home service / transport fee for:\n${a.homeService.address || ""}\n\nAmount (₱):`, a.homeFee || 0); if (v == null) return; set({ homeFee: Math.max(0, Number(v) || 0), homeService: { ...a.homeService, feeConfirmed: true } }); }; acts.appendChild(hf); }
  const ext = (body) => call("apptExtras", { id: a.id, staffToken: stTok(), ...body });
  { const rb = html(`<button class="k-btn sm" title="Report or block this client">🚩</button>`); rb.onclick = () => import("./clientreport.js").then((m) => m.openClientActions({ kind: "appt", id: a.id, storeId: ctx.storeId, staffToken: stTok(), name: a.customer?.name || "" })); acts.appendChild(rb); }
  if (a.change?.status === "pending") {
    const ap = html(`<button class="k-btn prep">✅ Approve change</button>`), rj = html(`<button class="k-btn sm">✕ Reject</button>`);
    ap.onclick = async () => { const inPerson = a.change.client === null ? confirm("Did the client agree in person? OK = yes (apply now) · Cancel = wait for the client to confirm on their phone") : false; ap.disabled = true; try { const r = await call("apptChange", { action: "shop", id: a.id, ok: true, inPerson, staffToken: stTok() }); if (r.waitingClient) alert("Approved — applied once the client confirms on their phone."); } catch (e) { alert(e.message); ap.disabled = false; } };
    rj.onclick = async () => { const note = prompt("Why not? (the freelancer sees this)", ""); if (note === null) return; try { await call("apptChange", { action: "shop", id: a.id, ok: false, note, staffToken: stTok() }); } catch (e) { alert(e.message); } };
    acts.appendChild(ap); acts.appendChild(rj);
  }
  if (a.helpOpen || a.overdueOpen) { const ok = html(`<button class="k-btn ready">✓ They're OK</button>`); ok.onclick = () => ext({ action: "clearSafety" }).catch((e) => alert(e.message)); acts.appendChild(ok); }
  if (!a.homeService && rooms().length && a.status !== "done") { const rb = html(`<button class="k-btn sm">🚪 ${a.roomName ? "Change room" : "Set room"}</button>`); rb.onclick = () => roomPanel(a, ext); acts.appendChild(rb); }
  if (a.homeService && ctx.store.settings?.salon?.homeService?.escort && feat("delivery")) { const rr = html(`<button class="k-btn sm">🛵 ${a.escort?.riderId ? "Change rider" : "Assign rider"}</button>`); rr.onclick = () => riderPanel(a, ext); acts.appendChild(rr); }
  if (offersOn() && ["unconfirmed", "pending", "confirmed"].includes(a.status)) {
    if (a.offer?.status === "open") { const so = html(`<button class="k-btn sm">✋ Stop offer</button>`); so.onclick = () => call("apptOffer", { id: a.id, action: "cancel", staffToken: stTok() }).catch((e) => alert(e.message)); acts.appendChild(so); }
    else { const po = html(`<button class="k-btn ${a.providerId ? "sm" : "prep"}">📣 ${a.providerId ? "Pass to other staff" : "Offer to staff"}</button>`); po.onclick = async () => { if (a.providerId && !confirm(`Take this client from ${a.providerName} and offer to other staff?`)) return; po.disabled = true; try { const r = await call("apptOffer", { id: a.id, action: "start", staffToken: stTok() }); if (r.data?.status === "none") alert("No staff is free and available at that time. Assign manually."); } catch (e) { alert(e.message); po.disabled = false; } }; acts.appendChild(po); }
  }
  if (!solo() || !a.providerId) { const as = html(`<button class="k-btn ${a.providerId ? "" : "prep"}">${a.providerId ? "↔ Reassign" : "👤 Assign"}</button>`); as.onclick = () => assignPanel(a); acts.appendChild(as); }
  if (a.status === "pending" && a.providerId) { const b = html(`<button class="k-btn prep">✓ Confirm</button>`); b.onclick = () => set({ status: "confirmed", confirmedAt: serverTimestamp(), confirmedBy: ctx.me?.name || null }); acts.appendChild(b); }
  if (["pending", "confirmed"].includes(a.status)) {
    const d = html(`<button class="k-btn">⏱ ${a.durationConfirmed ? "Edit duration" : "Confirm duration"}</button>`); d.onclick = () => { const v = prompt(`Actual duration in minutes (estimate ${a.durationEst}):`, a.durationConfirmed || a.durationEst); if (!v) return; set({ durationConfirmed: Math.max(5, Number(v) || a.durationEst), durationBy: ctx.me?.name || null }); }; acts.appendChild(d);
    const s = html(`<button class="k-btn ready">▶ Start</button>`); s.onclick = () => { if (!a.providerId) return alert("Assign a stylist first."); set({ status: "in_progress", startedAt: serverTimestamp(), ...(a.durationConfirmed ? {} : { durationConfirmed: a.durationEst, durationBy: ctx.me?.name || null }) }); }; acts.appendChild(s);
    const t = html(`<button class="k-btn">🕒 Move</button>`); t.onclick = () => { const v = prompt("New start time (HH:MM, 24h):", fmtT(st).replace(/ (AM|PM)/, "")); if (!v || !/^\d{1,2}:\d{2}$/.test(v)) return; const [h, m] = v.split(":").map(Number); const n = new Date(st); n.setHours(h, m, 0, 0);
      const s0 = n.getTime(), e0 = s0 + ((a.durationConfirmed || a.durationEst || 30) + (a.buffer || 0)) * 60000;
      const clash = a.providerId && active().find((x) => x.id !== a.id && x.providerId === a.providerId && x.startAt.toMillis() < e0 && x.startAt.toMillis() + ((x.durationConfirmed || x.durationEst || 30) + (x.buffer || 0)) * 60000 > s0);
      if (clash && !confirm(`${a.providerName || "This stylist"} already has a client at that time (${clash.customer?.name || clash.code}).\n\nMove anyway?`)) return;
      set({ startAt: Timestamp.fromDate(n) }); }; acts.appendChild(t);
    const ns = html(`<button class="k-btn danger">No-show</button>`); ns.onclick = () => { if (confirm("Mark as no-show?")) set({ status: "no_show", noShowAt: serverTimestamp() }); }; acts.appendChild(ns);
  }
  if (["pending", "confirmed", "in_progress"].includes(a.status)) { const ad = html(`<button class="k-btn">➕ Add service</button>`); ad.onclick = () => addServicePanel(a); acts.appendChild(ad); }
  if (a.status === "in_progress") {
    [5, 15, 30].forEach((m) => { const b = html(`<button class="k-btn sm">+${m} min</button>`); b.onclick = () => set({ durationConfirmed: (a.durationConfirmed || a.durationEst) + m, extraMinutes: (a.extraMinutes || 0) + m }); acts.appendChild(b); });
    const dn = html(`<button class="k-btn ready">✓ Done → checkout</button>`); dn.onclick = () => { set({ status: "done", doneAt: serverTimestamp() }); checkout({ ...a, status: "done" }); }; acts.appendChild(dn);
  }
  const x = html(`<button class="k-btn danger">✕</button>`); x.onclick = () => { const r = prompt("Cancel this booking? Reason:"); if (r == null) return; set({ status: "cancelled", cancelReason: r || "Cancelled by salon", cancelledAt: serverTimestamp() }); }; acts.appendChild(x);
  return el;
}

// ---------------- assign with rotation ----------------
const offersOn = () => !!ctx.store.settings?.salon?.offers?.enabled;
function offerLine(a) {
  const o = a.offer; if (!o || a.status === "done") return "";
  if (o.status === "open" || o.status === "moving") return `<div class="small" style="color:var(--new);font-weight:600">📣 Offered to ${esc(o.mode === "race" ? `${(o.to || []).length} staff (first to accept)` : (o.toNames || []).join(", "))} · ⏱ <span data-cd="${o.expiresAt}" data-id="${a.id}">–</span>${o.round > 1 ? ` · try ${o.round}` : ""}</div>`;
  if (o.status === "none" && !a.providerId) return `<div class="small" style="color:var(--danger);font-weight:700">📣 No one accepted — please assign</div>`;
  if (o.status === "accepted" && a.providerId === o.acceptedBy) return `<div class="small muted">✓ ${esc(o.acceptedName || "")} accepted the job</div>`;
  return "";
}
let cdTimer = null;
function startCountdown() {
  if (cdTimer) return; const done = new Set();
  cdTimer = setInterval(() => document.querySelectorAll("[data-cd]").forEach((el) => {
    const left = Math.max(0, Math.round((Number(el.dataset.cd) - Date.now()) / 1000));
    el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    if (!left && !done.has(el.dataset.id + el.dataset.cd)) { done.add(el.dataset.id + el.dataset.cd); call("apptOffer", { id: el.dataset.id, action: "check", staffToken: stTok() }).catch(() => {}); }
  }), 1000);
}
const ESC_LABEL = { unassigned: "needs a rider", assigned: "assigned", to_client: "on the way to the client", dropped: "dropped off", pickup_requested: "WAITING FOR PICKUP", to_pickup: "on the way to pick up", picked_up: "picked up", back: "back at the shop", released: "staff went home" };
const staffWord = () => ctx.store.settings?.salon?.staffWord || (ctx.store.businessType === "spa" ? "therapist" : "stylist");
const rooms = () => (ctx.store.settings?.salon?.rooms || []).filter((r) => r && r.id && r.active !== false);
function pickList(title, opts, onPick) {
  const el = html(`<div style="position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:80;display:grid;place-items:center;padding:16px"><div class="k-card" style="max-width:380px;width:100%;border-top-color:var(--prep)"><div class="top"><b>${esc(title)}</b><button class="k-btn sm" data-x>✕</button></div><div class="stack" style="gap:6px;margin-top:8px" data-l></div></div></div>`);
  const l = el.querySelector("[data-l]");
  opts.forEach((o) => { const b = html(`<button class="k-btn${o.on ? " primary" : ""}" style="justify-content:flex-start">${esc(o.label)}</button>`); b.onclick = async () => { b.disabled = true; try { await onPick(o.value); el.remove(); } catch (e) { b.disabled = false; alert(e.message); } }; l.appendChild(b); });
  el.querySelector("[data-x]").onclick = () => el.remove(); el.onclick = (e) => { if (e.target === el) el.remove(); };
  document.body.appendChild(el);
}
function roomPanel(a, ext) {
  pickList("Move to room", [...rooms().map((r) => ({ label: `${r.name}${Number(r.beds) > 1 ? ` · ${r.beds} beds` : ""}`, value: r.id, on: r.id === a.roomId })), { label: "No room", value: "" }], async (roomId) => {
    try { await ext({ action: "setRoom", roomId }); }
    catch (e) { if (/busy/.test(e.message) && confirm(e.message)) await ext({ action: "setRoom", roomId, force: true }); else throw e; }
  });
}
function riderPanel(a, ext) {
  const riders = staff.filter((x) => x.active !== false && (x.roles || []).includes("rider"));
  if (!riders.length) return alert("No staff with the Rider role yet. Add one in Settings → Staff.");
  pickList("Rider for drop-off & pick-up", [...riders.map((r) => ({ label: r.name, value: r.id, on: r.id === a.escort?.riderId })), { label: "No rider", value: "" }], (riderId) => ext({ action: "escortAssign", riderId: riderId || null }));
}
async function assignPanel(a) {
  const el = html(`<div><p class="muted small">${(a.items || []).map((l) => esc(l.name)).join(", ")} · ~${a.durationConfirmed || a.durationEst} min · ${fmtT(a.startAt.toDate())}</p><p class="muted">Loading recommendation…</p></div>`);
  ctx.openDrawer(`Assign · ${esc(a.customer?.name || "")}`, el);
  try {
    const r = await call("recommendStylist", { categories: a.categories || [], startAt: a.waiting ? Date.now() : a.startAt.toMillis(), minutes: a.durationConfirmed || a.durationEst || 30 });
    const list = r.candidates || [];
    el.innerHTML = `<p class="muted small">${(a.items || []).map((l) => esc(l.name)).join(", ")} · ~${a.durationConfirmed || a.durationEst} min · ${fmtT(a.startAt.toDate())}</p>
      ${a.requestedProviderId ? `<div class="k-tag" style="margin-bottom:8px">Customer requested: ${esc(staff.find((x) => x.id === a.requestedProviderId)?.name || "")}</div>` : ""}
      <p class="small muted">Rotation: longest since last assignment first. Multitasking is allowed — "active" shows clients currently in progress.</p>
      ${list.map((c, i) => `<button class="k-btn" data-pick="${esc(c.id)}" style="width:100%;justify-content:space-between;margin-bottom:8px;${a.providerId === c.id ? "opacity:.5" : ""}"><span>${c.photoUrl ? `<img src="${esc(c.photoUrl)}" alt="" style="width:26px;height:26px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:6px"/>` : ""}${esc(c.name)}${i === 0 && !a.requestedProviderId && !c.off ? ` <span class="k-tag paid">recommended</span>` : ""}${c.id === a.requestedProviderId ? ` <span class="k-tag paid">requested</span>` : ""}</span><span class="small muted">${c.off ? `<b style="color:var(--danger)">${esc(c.off)}</b> · ` : ""}${c.active} active · ${c.today} today${c.onDuty ? " · on duty" : ""}</span></button>`).join("") || `<p class="muted">No stylist has all the required skills. Check Settings → Staff & PINs → skills.</p>`}`;
    el.querySelectorAll("[data-pick]").forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      const body = { id: a.id, providerId: b.dataset.pick, staffName: ctx.me?.name };
      try {
        try { await call("assignAppointment", body); }
        catch (e) { if (!OVERRIDE_RE.test(e.message) || !confirm(`${e.message}\n\nAssign anyway?`)) throw e; await call("assignAppointment", { ...body, force: true }); }
        ctx.closeDrawer();
      } catch (e) { if (!OVERRIDE_RE.test(e.message)) alert(e.message); b.disabled = false; }
    }));
  } catch (e) { el.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

// ---------------- walk-in / phone booking ----------------
function walkinForm(pre = null) {
  const el = html(`<div class="lj-form"><div class="lj-col">
      <h3>Client</h3>
      <input class="k-input" data-name placeholder="Name (or Walk-in)"/><input class="k-input" data-phone placeholder="Phone (optional)" inputmode="tel"/>
      <label>When</label><div class="row" style="gap:8px"><label class="check" style="margin:0"><input type="radio" name="when" value="now" checked/> Now (walk-in)</label><label class="check" style="margin:0"><input type="radio" name="when" value="later"/> Set time</label></div>
      <input class="k-input" data-when type="datetime-local" style="display:none"/>
      <label>Stylist</label><select class="k-input" data-staff><option value="">Assign later (rotation)</option>${stylists().map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}</select>
      ${placeOf() !== "shop" ? `${placeOf() === "home" ? `<div class="small" style="margin-top:8px">🏠 Home service</div><input type="checkbox" data-home checked hidden/>` : `<label class="check"><input type="checkbox" data-home/> 🏠 Home service</label>`}<div data-hbox ${placeOf() === "home" ? "" : 'style="display:none"'}>${(ctx.store.settings?.salon?.homeService?.areas || []).length ? `<select class="k-input" data-area><option value="">Area…</option>${ctx.store.settings.salon.homeService.areas.map((x) => `<option>${esc(x.name)}</option>`).join("")}</select>` : ""}<input class="k-input" data-address placeholder="Address (blank = saved address)"/><input class="k-input" data-landmark placeholder="Landmark (optional)"/></div>` : ""}
      <label class="check" data-tentbox style="display:none"><input type="checkbox" data-tent/> Tentative — confirm with the client before the day</label>
      <label>Notes</label><input class="k-input" data-notes placeholder="optional"/>
      <div style="display:flex;gap:8px"><div style="flex:1"><label>Birthday (MM-DD)</label><input class="k-input" data-bday placeholder="e.g. 03-25" maxlength="5"/></div>${ctx.store.settings?.salon?.referral?.enabled ? `<div style="flex:1"><label>Referral code</label><input class="k-input" data-refc placeholder="optional" style="text-transform:uppercase"/></div>` : ""}</div>
    </div><div class="lj-col"><h3>Services</h3>
      ${cats.map((c) => { const its = items.filter((i) => i.categoryId === c.id && i.available !== false && !i.retail); return its.length ? `<div class="muted small" style="margin:10px 0 4px;font-weight:700">${esc(c.name)}</div>${its.flatMap((i) => (i.variants || []).length ? i.variants.map((v, vi) => ({ k: `${i.id}~${vi}`, n: `${i.name} (${v.label})`, p: v.price, d: v.duration || i.durationMinutes, item: i.id })) : [{ k: i.id, n: i.name, p: i.price, d: i.durationMinutes }]).map((x) => `<label class="lj-svc"><input type="checkbox" data-svc="${x.k}" ${x.item ? `data-item="${x.item}"` : ""}/><span class="n">${esc(x.n)}<small>${money(x.p)} · ~${x.d || 30} min</small></span></label>`).join("")}` : ""; }).join("")}
      <div class="lj-total"><div><span class="muted small">Total</span><b data-total>—</b></div><div class="small muted" data-info></div></div>
      <button class="k-btn primary" data-create style="width:100%">Create booking</button></div></div>`);
  const svcOf = (key) => { const [id, vi] = String(key).split("~"); const it = items.find((i) => i.id === id); const v = it && vi !== undefined ? (it.variants || [])[Number(vi)] : null; return v ? { ...it, price: Number(v.price) || 0, durationMinutes: v.duration || it.durationMinutes } : it; };
  el.addEventListener("change", (e) => { const c = e.target; if (c.dataset?.item && c.checked) el.querySelectorAll(`[data-item="${c.dataset.item}"]`).forEach((x) => { if (x !== c) x.checked = false; }); });
  const upd = () => { const s = [...el.querySelectorAll("[data-svc]:checked")].map((c) => svcOf(c.dataset.svc)).filter(Boolean); el.querySelector("[data-total]").textContent = s.length ? money(s.reduce((a, i) => a + i.price, 0)) : "—"; el.querySelector("[data-info]").textContent = s.length ? `~${s.reduce((a, i) => a + (i.durationMinutes || 30), 0)} min` : ""; };
  el.addEventListener("change", upd);
  const syncWhen = () => { const later = el.querySelector("[name=when]:checked").value === "later"; el.querySelector("[data-when]").style.display = later ? "" : "none"; el.querySelector("[data-tentbox]").style.display = later ? "" : "none"; };
  el.querySelectorAll("[name=when]").forEach((r) => (r.onchange = syncWhen));
  if (placeOf() === "home") { el.querySelector('[name=when][value="later"]').checked = true; el.querySelector('[name=when][value="now"]').closest("label").style.display = "none"; syncWhen(); }
  el.querySelector("[data-home]")?.addEventListener("change", (e) => { el.querySelector("[data-hbox]").style.display = e.target.checked ? "" : "none"; if (e.target.checked) { el.querySelector('[name=when][value="later"]').checked = true; syncWhen(); } });
  if (pre) {
    el.querySelector("[data-name]").value = pre.name || ""; el.querySelector("[data-phone]").value = pre.phone || "";
    (pre.itemIds || []).forEach((id) => { const cb = el.querySelector(`[data-svc="${id}"]`); if (cb) cb.checked = true; });
    if (pre.providerId) el.querySelector("[data-staff]").value = pre.providerId;
    if (pre.when) { el.querySelector('[name=when][value="later"]').checked = true; const w = el.querySelector("[data-when]"); w.style.display = ""; const d = new Date(pre.when); w.value = `${dstr(d)}T${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; }
    if (pre.note) el.querySelector("[data-notes]").value = pre.note;
    el.prepend(html(`<div class="k-note" style="grid-column:1/-1;margin-bottom:8px">📅 Booking the next visit for <b>${esc(pre.name || pre.phone)}</b> — check the date &amp; time, then tap Create booking.</div>`));
    upd();
  }
  el.querySelector("[data-create]").onclick = async (e) => {
    const ids = [...el.querySelectorAll("[data-svc]:checked")].map((c) => c.dataset.svc); if (!ids.length) return alert("Pick at least one service.");
    const later = el.querySelector("[name=when]:checked").value === "later"; const when = el.querySelector("[data-when]").value; if (later && !when) return alert("Set the start time.");
    e.target.disabled = true;
    const body = { itemIds: ids, customer: { name: el.querySelector("[data-name]").value.trim() || "Walk-in", phone: el.querySelector("[data-phone]").value.trim(), address: el.querySelector("[data-address]")?.value.trim() || "", landmark: el.querySelector("[data-landmark]")?.value.trim() || "" }, tentative: later && !!el.querySelector("[data-tent]")?.checked, providerId: el.querySelector("[data-staff]").value || null, startAt: later ? new Date(when).toISOString() : null, walkIn: !later, notes: el.querySelector("[data-notes]").value.trim(), homeService: el.querySelector("[data-home]")?.checked ? { area: el.querySelector("[data-area]")?.value || "" } : false, staffToken: stTok(), staffName: ctx.me?.name, birthday: /^\d{2}-\d{2}$/.test(el.querySelector("[data-bday]").value.trim()) ? el.querySelector("[data-bday]").value.trim() : null, refCode: el.querySelector("[data-refc]")?.value.trim() || null };
    try {
      let r;
      try { r = await call("staffCreateAppointment", body); }
      catch (err) { if (!OVERRIDE_RE.test(err.message) || !confirm(`${err.message}\n\nBook anyway?`)) throw err; r = await call("staffCreateAppointment", { ...body, force: true }); }
      tab = "board"; if (later) { day = new Date(when); watchDay(); } drawHead(); draw(); alert(`Booking ${r.code} created.`); }
    catch (err) { alert(err.message); e.target.disabled = false; }
  };
  mainEl.appendChild(el);
}

// ---------------- checkout (priced by the server: promos, package, loyalty, voucher, DP) ----------------
function checkout(a) {
  const tipsOn = ctx.store.settings?.salon?.tips !== false;
  const cfg = ctx.store.settings?.salon || {};
  const st = { keep: (a.items || []).map((_, i) => i), add: [], products: [], voucherCode: "", useBookedVoucher: true, usePackage: null, buyPackage: null, useReward: false, buyMembership: null, useMemberFree: false, giftCode: "" };
  const services = () => items.filter((i) => i.available !== false && !i.retail);
  const products = () => items.filter((i) => i.retail && i.available !== false);
  const el = html(`<div><div data-lines></div>
    <label>Add a service</label><select class="k-input" data-add><option value="">— pick —</option>${services().map((i) => `<option value="${i.id}">${esc(i.name)} · ${money(i.price)}</option>`).join("")}</select>
    ${feat("retail") && products().length ? `<label>Add a product</label><div style="display:flex;gap:6px"><select class="k-input" data-prod style="flex:1"><option value="">— pick —</option>${products().map((i) => `<option value="${i.id}">${esc(i.name)} · ${money(i.price)}${i.stock != null ? ` · ${i.stock} left` : ""}</option>`).join("")}</select><input class="k-input" type="number" min="1" value="1" data-pqty style="width:70px"/><button class="k-btn sm" data-padd>Add</button></div>` : ""}
    <div data-perks></div>
    ${feat("packages") && (cfg.packages || []).length && a.customerKey ? `<label>Sell a package</label><select class="k-input" data-buy><option value="">— none —</option>${cfg.packages.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} · ${money(p.price)} (${p.sessions} sessions)</option>`).join("")}</select>` : ""}
    ${feat("memberships") && (cfg.memberships || []).length && a.customerKey ? `<label>Sell a membership</label><select class="k-input" data-buym><option value="">— none —</option>${cfg.memberships.map((m) => `<option value="${esc(m.id)}">${esc(m.name)} · ${money(m.price)} / ${m.days || 30} days${m.discountPct ? ` · ${m.discountPct}% off` : ""}</option>`).join("")}</select>` : ""}
    <label>Voucher code</label><div style="display:flex;gap:6px"><input class="k-input" data-vcode placeholder="optional" style="text-transform:uppercase;flex:1"/><button class="k-btn sm" data-vapply>Apply</button></div>
    ${feat("giftcards") || cfg.giftcards?.enabled ? `<label>🎁 Gift card code</label><div style="display:flex;gap:6px"><input class="k-input" data-gcode placeholder="GC-XXXX-XXXX" style="text-transform:uppercase;flex:1"/><button class="k-btn sm" data-gapply>Apply</button></div>` : ""}
    ${tipsOn ? `<label>Tip for ${esc(a.providerName || "stylist")} (₱, record only)</label><input class="k-input" data-tip type="number" min="0" value="${a.tip || 0}"/>` : ""}
    <div data-sum class="lj-total" style="display:block"></div><div data-err></div>
    <div class="c-methods">${payMethods(ctx.store).map((m) => `<button data-m="${esc(m.id)}">${m.icon} ${esc(m.name)}</button>`).join("")}</div>
    <input class="k-input" type="number" data-tend placeholder="Cash tendered (optional)" style="margin-top:10px"/><div data-change class="muted small"></div></div>`);
  let quote = null, seq = 0;
  const lineHTML = () => {
    const cur = [...(a.items || []).map((l, i) => ({ ...l, _k: `k${i}`, on: st.keep.includes(i) })).filter((l) => l.on), ...st.add.map((id, i) => { const it = items.find((x) => x.id === id); return { name: it?.name, price: it?.price, duration: it?.durationMinutes || 30, _k: `a${i}` }; }), ...st.products.map((p, i) => { const it = items.find((x) => x.id === p.itemId); return { name: `${it?.name}`, price: (it?.price || 0) * p.qty, qty: p.qty, retail: true, _k: `p${i}` }; })];
    return cur.map((l) => `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--line)"><span>${l.retail ? "🛍 " : ""}${esc(l.name)} ${l.retail ? `<span class="muted small">× ${l.qty}</span>` : `<span class="muted small">~${l.duration} min</span>`}</span><span>${money(l.price)} <button class="k-btn sm" data-rm="${l._k}">✕</button></span></div>`).join("");
  };
  const draw = () => {
    el.querySelector("[data-lines]").innerHTML = lineHTML();
    el.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => { const k = b.dataset.rm, n = Number(k.slice(1)); if (k[0] === "k") st.keep = st.keep.filter((x) => x !== n); if (k[0] === "a") st.add.splice(n, 1); if (k[0] === "p") st.products.splice(n, 1); refresh(); }));
  };
  const refresh = async () => {
    draw(); const my = ++seq; const sum = el.querySelector("[data-sum]"); const err = el.querySelector("[data-err]"); err.innerHTML = "";
    sum.innerHTML = `<span class="muted small">Computing…</span>`;
    try {
      const q = await apptOp(ctx.storeId, "quote", { id: a.id, ...st, voucherCode: st.voucherCode || null, giftCode: st.giftCode || null });
      if (my !== seq) return; quote = q;
      const D = q.discounts || {};
      sum.innerHTML = `<div class="sl-row"><span>Subtotal</span><b>${money(q.subtotal)}</b></div>
        ${D.promo ? `<div class="sl-row"><span>Promo</span><span>−${money(D.promo)}</span></div>` : ""}
        ${D.package ? `<div class="sl-row"><span>Package session</span><span>−${money(D.package)}</span></div>` : ""}
        ${D.loyalty ? `<div class="sl-row"><span>Loyalty reward</span><span>−${money(D.loyalty)}</span></div>` : ""}
        ${D.voucher ? `<div class="sl-row"><span>Voucher ${esc(q.voucher?.code || "")}</span><span>−${money(D.voucher)}</span></div>` : ""}
        ${q.homeFee ? `<div class="sl-row"><span>Home service fee</span><span>${money(q.homeFee)}</span></div>` : ""}
        ${D.member ? `<div class="sl-row"><span>💎 Member ${q.member?.discountPct ? `${q.member.discountPct}% off` : ""}${q.memberFree ? " + free session" : ""}</span><span>−${money(D.member)}</span></div>` : ""}
        ${D.referral ? `<div class="sl-row"><span>💌 Referral (first visit)</span><span>−${money(D.referral)}</span></div>` : ""}
        ${D.dp ? `<div class="sl-row"><span>Less: reservation fee paid</span><span>−${money(D.dp)}</span></div>` : ""}
        ${D.gift ? `<div class="sl-row"><span>🎁 Gift card ${esc(q.gift?.code || "")} (left after: ${money(q.gift?.balanceAfter || 0)})</span><span>−${money(D.gift)}</span></div>` : ""}
        <div class="sl-row" style="font-size:1.25rem;margin-top:6px"><span>To pay</span><b>${money(q.amountDue)}</b></div>`;
      const perks = el.querySelector("[data-perks]"); const c = q.client;
      perks.innerHTML = c ? `${q.loyaltyCfg ? `<div class="k-tag" style="display:block;padding:8px;margin-top:8px">⭐ Loyalty: <b>${c.stamps}/${q.loyaltyCfg.stamps}</b> stamps${c.stamps >= q.loyaltyCfg.stamps ? ` — <label class="check" style="display:inline;margin:0"><input type="checkbox" data-reward ${st.useReward ? "checked" : ""}/> use reward: ${esc(q.loyaltyCfg.rewardText)}</label>` : ""}</div>` : ""}
        ${q.member ? `<div class="k-tag" style="display:block;padding:8px;margin-top:8px">💎 ${q.member.new ? "New member" : "Member"}: <b>${esc(q.member.name)}</b>${q.member.expires ? ` · until ${fmtDate(q.member.expires)}` : ""}${q.member.freeItemId ? ` · free ${esc(items.find((i) => i.id === q.member.freeItemId)?.name || "session")}: ${q.member.freeLeft} left` : ""}${q.member.freeLeft > 0 && q.items.some((l) => l.itemId === q.member.freeItemId) ? ` — <label class="check" style="display:inline;margin:0"><input type="checkbox" data-mfree ${st.useMemberFree ? "checked" : ""}/> use 1 free session</label>` : ""}</div>` : ""}
        ${(c.packages || []).length || st.buyPackage ? `<label>Use a package session</label><select class="k-input" data-usepkg><option value="">— no —</option>${st.buyPackage ? `<option value="new" ${st.usePackage === "new" ? "selected" : ""}>The package sold now (1st session)</option>` : ""}${(c.packages || []).map((p) => `<option value="${esc(p.id)}" ${st.usePackage === p.id ? "selected" : ""}>${esc(p.name)} · ${p.remaining}/${p.sessions} left</option>`).join("")}</select>` : ""}` : "";
      perks.querySelector("[data-reward]")?.addEventListener("change", (e) => { st.useReward = e.target.checked; refresh(); });
      perks.querySelector("[data-mfree]")?.addEventListener("change", (e) => { st.useMemberFree = e.target.checked; refresh(); });
      perks.querySelector("[data-usepkg]")?.addEventListener("change", (e) => { st.usePackage = e.target.value || null; refresh(); });
    } catch (e) { if (my !== seq) return; sum.innerHTML = ""; err.innerHTML = `<div class="k-note" style="color:var(--danger)">${esc(e.message)}</div>`; quote = null; if (/voucher|Voucher/.test(e.message)) { st.voucherCode = ""; st.useBookedVoucher = false; } if (/package/i.test(e.message)) st.usePackage = null; if (/gift card/i.test(e.message)) st.giftCode = ""; if (/free session/i.test(e.message)) st.useMemberFree = false; }
  };
  el.querySelector("[data-add]").onchange = (e) => { if (e.target.value) st.add.push(e.target.value); e.target.value = ""; refresh(); };
  el.querySelector("[data-padd]")?.addEventListener("click", () => { const sel = el.querySelector("[data-prod]"); const id = sel.value; const q = Math.max(1, Number(el.querySelector("[data-pqty]").value || 1)); if (!id) return; const ex = st.products.find((p) => p.itemId === id); if (ex) ex.qty += q; else st.products.push({ itemId: id, qty: q }); sel.value = ""; el.querySelector("[data-pqty]").value = 1; refresh(); });
  el.querySelector("[data-buy]")?.addEventListener("change", (e) => { st.buyPackage = e.target.value || null; if (!st.buyPackage && st.usePackage === "new") st.usePackage = null; refresh(); });
  el.querySelector("[data-buym]")?.addEventListener("change", (e) => { st.buyMembership = e.target.value || null; refresh(); });
  el.querySelector("[data-gapply]")?.addEventListener("click", () => { st.giftCode = el.querySelector("[data-gcode]").value.trim().toUpperCase(); refresh(); });
  el.querySelector("[data-vapply]").onclick = () => { st.voucherCode = el.querySelector("[data-vcode]").value.trim().toUpperCase(); refresh(); };
  el.querySelector("[data-tend]").oninput = (e) => { const c = Number(e.target.value || 0) - (quote?.amountDue || 0); el.querySelector("[data-change]").textContent = e.target.value ? `Change: ${money(Math.max(0, c))}` : ""; };
  el.querySelectorAll("[data-m]").forEach((b) => (b.onclick = async () => {
    if (!quote) return alert("Fix the error above first.");
    el.querySelectorAll("[data-m]").forEach((x) => (x.disabled = true));
    try {
      const r = await apptOp(ctx.storeId, "pay", { id: a.id, ...st, voucherCode: st.voucherCode || null, giftCode: st.giftCode || null, tip: Number(el.querySelector("[data-tip]")?.value || 0), methodId: b.dataset.m });
      ctx.closeDrawer();
      const tend = Number(el.querySelector("[data-tend]").value || 0) || null;
      const msg = `Paid ${money(r.amountDue)} ✓${r.loyalty ? `\n⭐ Loyalty: ${r.loyalty.stamps}/${r.loyalty.of} stamps${r.loyalty.earned ? " (+1)" : ""}` : ""}`;
      const pc = printCfg(ctx.store);
      if (pc.autoPaid || confirm(`${msg}\n\nPrint receipt?`)) await printReceipt(ctx.store, apptReceipt({ ...a, items: r.items, amountDue: r.amountDue, voucher: r.voucher, discounts: r.discounts, paid: true, paymentMethod: payMethods(ctx.store).find((m) => m.id === b.dataset.m)?.name }), { cur: CUR, cashTendered: tend, staffName: ctx.me?.name || "" });
      if (r.nextDue && confirm(`Book ${a.customer?.name || "the client"}'s next visit now?\n\nSuggested: ${r.nextDue.service} · ${fmtDate(r.nextDue.at)}${r.nextDue.providerName ? ` with ${r.nextDue.providerName}` : ""}\n(Otherwise they'll appear in "Due back" on that date.)`)) bookFromDue({ name: a.customer?.name, phone: a.customer?.phone, nextDue: r.nextDue });
    } catch (e) { alert(e.message); el.querySelectorAll("[data-m]").forEach((x) => (x.disabled = false)); }
  }));
  ctx.openDrawer(`Checkout · ${esc(a.customer?.name || "")}`, el);
  refresh();
}

// ---------------- add service (staff side) ----------------
function addServicePanel(a) {
  const el = html(`<div>${cats.map((c) => { const its = items.filter((i) => i.categoryId === c.id && i.available !== false && !i.retail); return its.length ? `<div class="muted small" style="margin:10px 0 4px;font-weight:700">${esc(c.name)}</div>${its.map((i) => `<label class="lj-svc"><input type="checkbox" data-add="${i.id}"/><span class="n">${esc(i.name)}<small>${money(i.price)} · ~${i.durationMinutes || 30} min</small></span></label>`).join("")}` : ""; }).join("")}
    <p class="small muted">Same stylist if free right after; otherwise another free stylist gets a follow-up booking, or you'll see the wait time.</p><div data-res></div><button class="k-btn primary" data-ok style="width:100%;margin-top:10px">Add</button></div>`);
  const go = async (waitOk) => { const ids = [...el.querySelectorAll("[data-add]:checked")].map((c) => c.dataset.add); if (!ids.length) return alert("Pick a service."); try { const r = await call("addServiceToAppointment", { id: a.id, itemIds: ids, waitOk, staffName: ctx.me?.name }); if (r.mode === "wait") { el.querySelector("[data-res]").innerHTML = `<div class="k-tag" style="display:block;padding:8px;margin:8px 0;color:var(--new)">Wait ~${r.waitMinutes} min — ${esc(r.provider)} free at ${fmtT(new Date(r.startAt))}. <button class="k-btn sm" data-wait>Book it</button></div>`; el.querySelector("[data-wait]").onclick = () => go(true); return; } ctx.closeDrawer(); alert(r.mode === "extended" ? `Added · +${r.minutes} min` : `Follow-up ${r.code} with ${r.provider} at ${fmtT(new Date(r.startAt))}`); } catch (e) { alert(e.message); } };
  el.querySelector("[data-ok]").onclick = () => go(false);
  ctx.openDrawer(`Add service · ${esc(a.customer?.name || "")}`, el);
}
