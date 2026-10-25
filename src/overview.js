// Owner Overview. Every number comes from the store's own data (orders / appointments / stays, staff, shifts).
import { db, call } from "./firebase.js";
import { collection, query, where, orderBy, limit, getDocs, onSnapshot, doc, getDoc, updateDoc, serverTimestamp, Timestamp } from "firebase/firestore";
import { openStatus, fmt12 } from "./hours.js";
import { esc, toast, money as fmtMoney } from "./ui.js";
import { FLOW } from "./pages/orders.js";
import { checklistCard } from "./onboarding.js";
import { mountBell } from "./bell.js";
import { APP_VERSION } from "./version.js";

const DAY = 86400e3;
const DONE = ["completed", "delivered", "picked_up", "claimed", "done", "checked_out"];
const startOfDay = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const periodRange = (p) => { const t0 = startOfDay(); if (p === "today") return [t0, new Date(t0.getTime() + DAY)]; const n = p === "7d" ? 7 : 30; return [new Date(t0.getTime() - (n - 1) * DAY), new Date(t0.getTime() + DAY)]; };
const prevRange = (p) => { const [a, b] = periodRange(p); if (p === "today") return [new Date(a.getTime() - 7 * DAY), new Date(b.getTime() - 7 * DAY)]; const len = b - a; return [new Date(a.getTime() - len), a]; };

/** Normalized rows for any store type */
async function loadRows(ctx, from, to) {
  const sid = ctx.storeId, m = ctx.mode;
  if (m === "salon") {
    const s = await getDocs(query(collection(db, "stores", sid, "appointments"), where("startAt", ">=", Timestamp.fromDate(from)), orderBy("startAt", "asc"), limit(4000)));
    return s.docs.map((d) => ({ id: d.id, ...d.data() })).filter((a) => !a.test && a.startAt.toMillis() < to.getTime()).map((a) => ({
      at: a.startAt.toDate(), status: a.status, cancelled: ["cancelled", "no_show"].includes(a.status), done: a.status === "done", paid: !!a.paid,
      total: (a.paid && a.amountDue != null ? a.amountDue : (a.total || 0) + (a.homeFee || 0)) + (a.dp && ["used", "forfeited"].includes(a.dp.status) ? a.dp.amount : 0),
      method: a.paid ? ((a.paymentMethodId || a.paymentMethod || "cash").toString().toLowerCase().startsWith("cash") ? "cash" : "online") : null,
      items: (a.items || []).map((l) => ({ name: l.name, qty: l.qty || 1 })), staff: a.providerName ? [a.providerName] : [], staffId: a.providerId || null,
    }));
  }
  if (m === "stay") {
    const s = await getDocs(query(collection(db, "stores", sid, "stays"), where("checkIn", ">=", Timestamp.fromDate(from)), orderBy("checkIn", "asc"), limit(2000)));
    return s.docs.map((d) => d.data()).filter((x) => !x.test && x.checkIn.toMillis() < to.getTime()).map((x) => ({ at: x.checkIn.toDate(), status: x.status, cancelled: ["cancelled", "no_show", "rejected"].includes(x.status), done: ["checked_out", "done"].includes(x.status), paid: (x.paidAmount || 0) >= (x.total || 0) && x.total > 0, total: x.paidAmount || 0, method: x.payment?.method ? (x.payment.method === "cash" ? "cash" : "online") : null, items: [{ name: x.roomName, qty: 1 }], staff: [] }));
  }
  const s = await getDocs(query(collection(db, "stores", sid, "orders"), where("createdAt", ">=", Timestamp.fromDate(from)), orderBy("createdAt", "asc"), limit(5000)));
  return s.docs.map((d) => d.data()).filter((o) => !o.test && (o.createdAt?.toMillis?.() || 0) < to.getTime()).map((o) => ({
    at: o.createdAt?.toDate?.() || new Date(), status: o.status, cancelled: o.status === "cancelled", done: DONE.includes(o.status), paid: !!o.paid, total: o.total || 0,
    method: o.paid ? (String(o.paymentMethodId || o.payment?.methodId || o.paymentMethod || o.payment?.method || "cash").toLowerCase().startsWith("cash") ? "cash" : "online") : null,
    items: (o.items || []).map((l) => ({ name: l.name, qty: l.qty || 1 })), staff: [o.acceptedBy, o.paidBy].filter(Boolean),
  }));
}
const sales = (rows) => rows.filter((r) => !r.cancelled && (r.paid || r.done)).reduce((a, r) => a + r.total, 0);

const ICON_ORDERS = { dine_in: "Dine-in", take_out: "Take-out", pickup: "Pickup", delivery: "Delivery" };

export function renderOverview(root, ctx) {
  const { store, storeId } = ctx; const mode = store.mode;
  const money = (n) => fmtMoney(n, store.settings?.currency);
  const word = mode === "salon" ? "Appointments" : mode === "laundry" ? "Jobs" : mode === "stay" ? "Bookings" : "Orders";
  const os = openStatus(store.hours || {});
  const isOpen = store.settings?.acceptOrders !== false && !store.settings?.pause?.active && (os.open || !Object.keys(store.hours || {}).length);
  const hr = new Date().getHours(); const greet = hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening";
  const first = (ctx.ownerName || ctx.user?.displayName || (ctx.user?.email || "").split("@")[0] || "").split(/[ ._]/)[0];
  const branch = (ctx.branches || []).find((b) => b.storeId === storeId);
  const multi = (ctx.branches || []).length > 1;
  let period = sessionStorage.getItem("ov:period") || "today";
  const unsubs = [];

  root.innerHTML = `
    <div id="ovNotice"></div>
    <section class="ov-head" aria-labelledby="ovGreet">
      <div><span class="sticker ${isOpen ? "lime" : "gray"}">● ${isOpen ? "Shop is open" : "Shop is closed"}${!isOpen && os.opensAt ? ` · opens ${fmt12(os.opensAt)}` : ""}</span>
        <h1 id="ovGreet">${greet}, ${esc(first || "there")}!</h1>
        <p class="sub">${esc(store.name)}${branch && multi ? ` · ${esc(branch.name)}` : ""}</p></div>
      <div class="acts"><div id="ovBell"></div>${multi ? `<label class="sr-only" for="ovBranch">Branch</label><select id="ovBranch" class="branch-switch">${ctx.branches.map((b) => `<option value="${b.storeId}" ${b.storeId === storeId ? "selected" : ""}>${esc(b.name)}</option>`).join("")}</select>` : ""}
        <a class="btn ghost" href="/m/${esc(store.slug)}" target="_blank" rel="noopener">View shop page</a>
        <a class="btn brand" href="/counter/#new" target="_blank" rel="noopener">+ New ${mode === "salon" ? "booking" : mode === "stay" ? "booking" : "order"}</a></div>
    </section>
    <div id="obCard"></div>
    <div class="period" role="tablist" aria-label="Period">${[["today", "Today"], ["7d", "7 days"], ["30d", "30 days"]].map(([k, l]) => `<button role="tab" type="button" data-p="${k}" aria-selected="${k === period}" aria-controls="ovCards">${l}</button>`).join("")}</div>
    <section aria-label="Summary"><div class="ov-cards" id="ovCards">${[0, 1, 2, 3].map(() => `<div class="ov-card"><div class="skel" style="height:16px;width:50%"></div><div class="skel" style="height:40px;margin-top:10px"></div></div>`).join("")}</div></section>
    <div class="ov-tips" id="ovTips"></div>
    <div class="ov-mid">
      <section class="ov-sec" aria-labelledby="loT"><header><h2 id="loT">Live ${word.toLowerCase()}</h2><a href="#orders">See all</a></header><div id="ovLive"><div class="skel" style="height:44px"></div><div class="skel" style="height:44px;margin-top:8px"></div></div></section>
      <section class="ov-sec" aria-labelledby="chT"><header><h2 id="chT">Sales</h2><span class="muted small" id="chSub"></span></header><div id="ovChart"><div class="skel" style="height:190px"></div></div></section>
    </div>
    <div class="ov-bottom">
      <section class="ov-sec" aria-labelledby="bsT"><header><h2 id="bsT">Best sellers</h2></header><div id="ovBest"><div class="skel" style="height:120px"></div></div></section>
      <section class="ov-sec" aria-labelledby="stT"><header><h2 id="stT">Staff tally</h2><a href="#staff">Staff</a></header><div id="ovStaff"><div class="skel" style="height:120px"></div></div></section>
      <section aria-labelledby="ccT" id="ovCashWrap"></section>
    </div>
    <div id="ovBranches"></div>`;

  // bell, branch switcher, onboarding
  mountBell(root.querySelector("#ovBell"), ctx);
  root.querySelector("#ovBranch")?.addEventListener("change", (e) => import("./pages/branches.js").then((m) => m.switchTo(e.target.value)));
  if (ctx.role === "owner") checklistCard(root.querySelector("#obCard"), ctx, () => ctx.reload());
  // server functions up to date?
  getDoc(doc(db, "publicStores", store.slug)).then((d) => {
    if (d.data()?.v === APP_VERSION || ctx.role === "viewer") return;
    const w = root.querySelector("#ovNotice");
    w.innerHTML = `<div class="alert warn" role="status"><b>⚠️ Your server functions are not updated.</b> Your customer page may not show new items, themes or settings yet. Run <code>npm run deploy:all</code>, then <button class="btn sm ghost" type="button">Check again</button></div>`;
    w.querySelector("button").onclick = async () => { try { await call("refreshPublicStore", {}); const d2 = await getDoc(doc(db, "publicStores", store.slug)); if (d2.data()?.v === APP_VERSION) { w.innerHTML = ""; toast("Server is up to date ✓"); } else toast("Still old — deploy the functions first.", "error"); } catch (e) { toast(e.message, "error"); } };
  }).catch(() => {});

  // ---- tips under the summary: promotions running now + slow-moving items (last 7 days)
  (async () => {
    if (ctx.role !== "owner" || mode === "stay") return;
    const box = root.querySelector("#ovTips");
    try {
      const [promoSnap, itemSnap, rows7] = await Promise.all([
        getDocs(collection(db, "stores", storeId, "promos")).catch(() => ({ docs: [] })),
        getDocs(collection(db, "stores", storeId, "items")).catch(() => ({ docs: [] })),
        loadRows(ctx, new Date(startOfDay().getTime() - 6 * DAY), new Date(startOfDay().getTime() + DAY)),
      ]);
      const promos = promoSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const live = promos.filter((x) => x.active !== false);
      const now = Date.now();
      const ending = live.filter((x) => x.endsAt && (x.endsAt.toMillis?.() || x.endsAt) - now < 2 * DAY);
      const items = itemSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((i) => i.available !== false);
      const sold = {}; rows7.filter((r) => !r.cancelled).forEach((r) => r.items.forEach((l) => (sold[l.name] = (sold[l.name] || 0) + (l.qty || 1))));
      const anySales = Object.keys(sold).length > 0;
      const slow = anySales ? items.map((i) => ({ ...i, q: sold[i.name] || 0 })).sort((a, b) => a.q - b.q).filter((i) => i.q <= 2).slice(0, 3) : [];
      const promoCard = `<section class="ov-tip"><div class="ov-tip-ic">🏷️</div><div class="ov-tip-b"><b>${live.length ? `${live.length} promo${live.length > 1 ? "s" : ""} running` : "No promo running"}</b>
        <span>${ending.length ? `${esc(ending[0].name || "A promo")} ends soon — extend it?` : live.length ? esc(live.slice(0, 2).map((x) => x.name).filter(Boolean).join(" · ")) : "A merienda or weekday promo brings people in on slow hours."}</span></div>
        <a class="btn sm ghost" href="#promos">${live.length ? "Manage" : "Add promo"}</a></section>`;
      const slowCard = slow.length ? `<section class="ov-tip"><div class="ov-tip-ic">🐢</div><div class="ov-tip-b"><b>Slow this week</b><span>${slow.map((i) => `${esc(i.name)} (${i.q})`).join(" · ")}</span></div><a class="btn sm ghost" href="#promos" data-slow="${esc(slow.map((i) => i.id).join(","))}">Make a promo</a></section>` : "";
      box.innerHTML = promoCard + slowCard;
      box.querySelector("[data-slow]")?.addEventListener("click", (e) => { try { sessionStorage.setItem("promo:suggestItems", e.currentTarget.dataset.slow); } catch {} });
    } catch (e) { console.warn("tips", e); }
  })();

  // ---- summary + chart + best sellers + staff (per period)
  let seq = 0;
  async function loadPeriod() {
    const my = ++seq;
    root.querySelectorAll(".period [data-p]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.p === period)));
    const [a, b] = periodRange(period), [pa, pb] = prevRange(period);
    try {
      const [rows, prev] = await Promise.all([loadRows(ctx, a, b), loadRows(ctx, pa, pb)]);
      if (my !== seq) return;
      drawCards(rows, prev, a, b); drawChart(rows, a, b); drawBest(rows); drawStaff(rows);
    } catch (e) {
      console.warn(e); if (my !== seq) return;
      root.querySelector("#ovCards").innerHTML = `<div class="ov-card"><p class="empty">Couldn't load the numbers.</p><button class="btn sm ghost retry" type="button">Retry</button></div>`;
      root.querySelector("#ovCards .retry").onclick = loadPeriod;
    }
  }
  function drawCards(rows, prev, a) {
    const ok = rows.filter((r) => !r.cancelled), s = sales(rows), ps = sales(prev);
    const cmp = ps > 0 ? Math.round(((s - ps) / ps) * 100) : null;
    const vsLbl = period === "today" ? `vs last ${new Date(a.getTime() - 7 * DAY).toLocaleDateString("en-PH", { weekday: "short" })}` : period === "7d" ? "vs previous 7 days" : "vs previous 30 days";
    const open = ok.filter((r) => !r.done).length;
    const days = period === "today" ? 1 : period === "7d" ? 7 : 30;
    const paid = ok.filter((r) => r.paid && r.method);
    const online = paid.filter((r) => r.method === "online").reduce((x, r) => x + r.total, 0), cash = paid.filter((r) => r.method === "cash").reduce((x, r) => x + r.total, 0);
    const pct = online + cash ? Math.round((online / (online + cash)) * 100) : 0;
    const sold = ok.filter((r) => r.paid || r.done);
    root.querySelector("#ovCards").innerHTML = `
      <div class="ov-card sales"><h2>Sales</h2><div class="big">${money(s)}</div>${cmp == null ? `<span class="chip">No sales ${vsLbl.replace("vs ", "")} to compare</span>` : `<span class="chip">${cmp >= 0 ? "+" : ""}${cmp}% ${vsLbl}</span>`}</div>
      <div class="ov-card"><h2>${word}</h2><div class="big">${ok.length}</div><div class="note">${period === "today" ? `${open} open right now` : `${(ok.length / days).toFixed(1)} per day on average`}</div></div>
      <div class="ov-card"><h2>Avg. ${mode === "salon" ? "ticket" : mode === "stay" ? "booking" : "order"} value</h2><div class="big">${money(sold.length ? s / sold.length : 0)}</div><div class="note">${sold.length} paid / completed</div></div>
      <div class="ov-card"><h2>GCash vs cash</h2>${online + cash ? `<div class="split-bar" role="img" aria-label="GCash and e-wallets ${pct}%, cash ${100 - pct}%"><span class="g" style="width:${pct}%"></span><span class="c" style="width:${100 - pct}%"></span></div><div class="split-lbl"><span><i style="background:var(--lilac)"></i>GCash/e-wallet ${pct}%</span><span><i style="background:var(--mango)"></i>Cash ${100 - pct}%</span></div><div class="note">${money(online)} · ${money(cash)}</div>` : `<p class="empty">No paid ${word.toLowerCase()} yet.</p>`}</div>`;
  }
  function drawChart(rows, a, b) {
    const ok = rows.filter((r) => !r.cancelled && (r.paid || r.done));
    let buckets = [];
    if (period === "today") { buckets = Array.from({ length: 24 }, (_, h) => ({ l: h % 3 === 0 ? (h === 0 ? "12a" : h < 12 ? h + "a" : h === 12 ? "12p" : h - 12 + "p") : "", full: `${h}:00`, v: 0 })); ok.forEach((r) => (buckets[r.at.getHours()].v += r.total)); const used = buckets.map((x, i) => (x.v ? i : -1)).filter((i) => i >= 0); const lo = Math.max(0, Math.min(...(used.length ? used : [8])) - 1), hi = Math.min(23, Math.max(...(used.length ? used : [20])) + 1); buckets = buckets.slice(Math.min(lo, 8), Math.max(hi, 20) + 1); }
    else if (period === "7d") { buckets = Array.from({ length: 7 }, (_, i) => { const d = new Date(a.getTime() + i * DAY); return { l: d.toLocaleDateString("en-PH", { weekday: "short" }), full: d.toLocaleDateString("en-PH", { dateStyle: "medium" }), v: 0, d }; }); ok.forEach((r) => { const i = Math.floor((startOfDay(r.at) - a) / DAY); if (buckets[i]) buckets[i].v += r.total; }); }
    else { buckets = Array.from({ length: 5 }, (_, i) => { const s0 = new Date(b.getTime() - (5 - i) * 7 * DAY + (i === 0 ? 5 * 7 * DAY - 30 * DAY : 0)); return { l: `${s0.toLocaleDateString("en-PH", { month: "short", day: "numeric" })}`, full: `Week of ${s0.toLocaleDateString("en-PH", { dateStyle: "medium" })}`, v: 0, s: s0 }; }); ok.forEach((r) => { for (let i = buckets.length - 1; i >= 0; i--) if (r.at >= buckets[i].s) { buckets[i].v += r.total; break; } }); }
    const max = Math.max(...buckets.map((x) => x.v), 0);
    root.querySelector("#chSub").textContent = period === "today" ? "by hour" : period === "7d" ? "by day" : "by week";
    const best = buckets.reduce((m, x) => (x.v > m.v ? x : m), { v: -1 });
    const summary = max ? `Sales ${period === "today" ? "today by hour" : period === "7d" ? "for the last 7 days by day" : "for the last 30 days by week"}. Highest: ${best.full} with ${money(best.v)}. Total ${money(buckets.reduce((x, y) => x + y.v, 0))}.` : "No sales in this period yet.";
    root.querySelector("#ovChart").innerHTML = max ? `<div class="chart" role="img" aria-label="${esc(summary)}">${buckets.map((x) => `<div class="bar ${x === best ? "top" : ""}" style="height:${Math.max(x.v ? 4 : 0, Math.round((x.v / max) * 100))}%" title="${esc(x.full)} · ${money(x.v)}"></div>`).join("")}</div><div class="chart-x" aria-hidden="true">${buckets.map((x) => `<span>${esc(x.l)}</span>`).join("")}</div>` : `<p class="empty">No sales yet ${period === "today" ? "today" : "in this period"}. Share your QR to get started.</p>`;
  }
  function drawBest(rows) {
    const cnt = {}; rows.filter((r) => !r.cancelled).forEach((r) => r.items.forEach((l) => (cnt[l.name] = (cnt[l.name] || 0) + (l.qty || 1))));
    const top = Object.entries(cnt).sort((a, b) => b[1] - a[1]).slice(0, 4);
    root.querySelector("#ovBest").innerHTML = top.length ? top.map(([n, q]) => `<div class="bs-row"><div class="top"><span>${esc(n)}</span><span>${q} sold</span></div><div class="pbar" role="img" aria-label="${esc(n)}: ${q} sold"><span style="width:${Math.round((q / top[0][1]) * 100)}%"></span></div></div>`).join("") : `<p class="empty">Nothing sold ${period === "today" ? "today" : "in this period"} yet.</p>`;
  }
  let staffList = null, dutyOn = new Set();
  async function drawStaff(rows) {
    const el = root.querySelector("#ovStaff");
    try {
      if (!staffList) {
        const [s, d] = await Promise.all([getDocs(query(collection(db, "stores", storeId, "staff"), where("active", "==", true))), getDocs(collection(db, "stores", storeId, mode === "salon" ? "duties" : "duty")).catch(() => ({ docs: [] }))]);
        staffList = s.docs.map((x) => ({ id: x.id, ...x.data() }));
        d.docs.forEach((x) => { const v = x.data(); if (mode === "salon" ? v.status === "on" : !v.off && Date.now() - (v.atMs || 0) < 12 * 3600e3) dutyOn.add(v.staffId || x.id); });
        staffList.forEach((x) => { if (x.onDuty) dutyOn.add(x.id); });
      }
      if (!staffList.length) { el.innerHTML = `<p class="empty">No staff yet. <a href="#staff">Add staff &amp; PINs</a>.</p>`; return; }
      const handled = (st) => rows.filter((r) => !r.cancelled && (r.staffId === st.id || r.staff.includes(st.name))).length;
      const ROLE = { manager: "Manager", crew: mode === "salon" ? "Reception" : "Counter", kitchen: "Kitchen", barista: "Barista", rider: "Rider", stylist: "Stylist", dispatch: "Dispatch", cleaner: "Caretaker (rooms)" };
      el.innerHTML = staffList.sort((a, b) => handled(b) - handled(a)).slice(0, 6).map((st, i) => `<div class="st-row"><div class="av c${i % 3}" aria-hidden="true">${esc((st.name || "?").split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase())}</div><div><div class="n">${esc(st.name)}${st.isOwner ? " (you)" : ""}</div><div class="r">${esc((st.roles || []).map((r) => ROLE[r] || r).slice(0, 2).join(", "))} · ${dutyOn.has(st.id) ? "on shift" : "off"}</div></div><div class="c" aria-label="${handled(st)} ${word.toLowerCase()} handled">${handled(st)}</div></div>`).join("") + `<p class="small muted" style="margin:6px 0 0">${word} handled ${period === "today" ? "today" : "in this period"} (accepted, served or paid by them).</p>`;
    } catch (e) { el.innerHTML = `<p class="empty">Couldn't load staff.</p><button class="btn sm ghost retry" type="button">Retry</button>`; el.querySelector(".retry").onclick = () => { staffList = null; drawStaff(rows); }; }
  }
  root.querySelectorAll(".period [data-p]").forEach((b) => (b.onclick = () => { period = b.dataset.p; try { sessionStorage.setItem("ov:period", period); } catch {} loadPeriod(); }));
  root.querySelector(".period").addEventListener("keydown", (e) => { if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return; const ks = ["today", "7d", "30d"]; period = ks[(ks.indexOf(period) + (e.key === "ArrowRight" ? 1 : 2)) % 3]; loadPeriod(); root.querySelector(`[data-p="${period}"]`).focus(); });
  loadPeriod();

  // ---- live orders (real-time)
  const liveEl = root.querySelector("#ovLive");
  const t0 = Timestamp.fromDate(startOfDay());
  const flow = FLOW[mode] || FLOW.table;
  const chipOf = (st) => (["pending", "unconfirmed", "received", "booked"].includes(st) ? ["new", "New"] : ["preparing", "confirmed", "in_progress", "processing", "washing", "drying", "folding", "weighed", "waiting_payment", "picking_up", "checked_in"].includes(st) ? ["prep", st === "confirmed" ? "Confirmed" : st === "in_progress" ? "In progress" : "Preparing"] : ["ready", "out_for_delivery"].includes(st) ? ["ready", st === "out_for_delivery" ? "On the way" : "Ready"] : ["done", "Done"]);
  function nextAction(o) {
    if (mode === "salon") return o.status === "in_progress" ? ["Done", { status: "done", doneAt: serverTimestamp() }] : ["pending", "confirmed"].includes(o.status) && o.providerId ? ["Start", { status: "in_progress", startedAt: serverTimestamp() }] : null;
    if (mode !== "table") return null; // laundry / stay: use their own screens
    if (o.status === "unconfirmed") return ["Confirm", { status: "pending", confirmedAt: serverTimestamp() }];
    if (o.status === "pending") return ["Accept", { status: "preparing", acceptedAt: serverTimestamp(), etaMinutes: Number(store.settings?.service?.prepDefault) || 15, acceptedBy: "Owner" }];
    if (o.status === "preparing") return ["Mark ready", { status: "ready", readyAt: serverTimestamp() }];
    if (o.status === "ready" && o.serviceType === "delivery") return ["Out for delivery", { status: "out_for_delivery", outAt: serverTimestamp() }];
    if (o.status === "out_for_delivery") return ["Delivered", { status: "delivered", deliveredAt: serverTimestamp(), completedAt: serverTimestamp() }];
    if (o.status === "ready") return ["Complete", { status: flow[flow.length - 1][0], completedAt: serverTimestamp() }];
    return null;
  }
  const liveQ = mode === "salon" ? query(collection(db, "stores", storeId, "appointments"), where("startAt", ">=", t0), orderBy("startAt", "asc"), limit(120))
    : mode === "stay" ? null : query(collection(db, "stores", storeId, "orders"), where("createdAt", ">=", t0), orderBy("createdAt", "desc"), limit(120));
  if (!liveQ) liveEl.innerHTML = `<p class="empty">See today's arrivals and guests in <a href="#stays">Bookings</a>.</p>`;
  else unsubs.push(onSnapshot(liveQ, (snap) => {
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((o) => !DONE.includes(o.status) && !["cancelled", "no_show"].includes(o.status) && !o.parentId).slice(0, 6);
    const newCount = snap.docs.filter((d) => ["pending", "unconfirmed"].includes(d.data().status)).length;
    const pill = document.getElementById("navNew"); if (pill) { pill.hidden = !newCount; pill.textContent = newCount; }
    const bb = document.getElementById("bnNew"); if (bb) { bb.hidden = !newCount; bb.textContent = newCount > 99 ? "99+" : newCount; }
    if (!list.length) { liveEl.innerHTML = `<p class="empty">${snap.empty ? `No ${word.toLowerCase()} yet today — share your QR to get started.` : `All caught up — no open ${word.toLowerCase()} right now. 🎉`}</p>`; return; }
    liveEl.innerHTML = list.map((o) => {
      const [cls, lbl] = chipOf(o.status); const act = nextAction(o);
      const where = mode === "salon" ? `${o.startAt?.toDate ? o.startAt.toDate().toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" }) : ""} · ${esc(o.providerName || "unassigned")}` : o.tableLabel ? esc(o.tableLabel) : ICON_ORDERS[o.serviceType] || "";
      const pay = mode === "salon" ? (o.paid ? `paid · ${esc(o.paymentMethod || "")}` : "") : o.paid ? (o.payment && o.payment.method !== "cash" ? `${esc(o.payment.methodName || "GCash")} ref ✓` : `paid · ${esc(o.paymentMethod || "cash")}`) : o.payment && o.payment.method !== "cash" ? `${esc(o.payment.methodName)} · to verify` : "unpaid";
      const items = (o.items || []).map((l) => `${l.qty ? l.qty + "× " : ""}${l.name}`).join(", ");
      return `<div class="lo-row"><div><div class="id">${mode === "salon" ? esc(o.customer?.name || o.code) : `#${esc(o.orderNo)}`} · ${where}</div><div class="meta" title="${esc(items)}">${esc(items)} · ${money(mode === "salon" ? (o.total || 0) + (o.homeFee || 0) : o.total)} · ${pay}</div></div><span class="st ${cls}">${lbl}</span><div class="act">${act ? `<button class="btn sm ${cls === "new" ? "brand" : "ghost"}" type="button" data-id="${o.id}">${act[0]}</button>` : `<a class="btn sm ghost" href="/counter/" target="_blank" rel="noopener">Open</a>`}</div></div>`;
    }).join("");
    liveEl.querySelectorAll("[data-id]").forEach((b) => (b.onclick = async () => {
      const o = list.find((x) => x.id === b.dataset.id); const act = nextAction(o); if (!act) return;
      b.disabled = true;
      try { await updateDoc(doc(db, "stores", storeId, mode === "salon" ? "appointments" : "orders", o.id), { ...act[1], updatedAt: serverTimestamp() }); }
      catch (e) { toast(e.message, "error"); b.disabled = false; }
    }));
  }, (e) => { console.warn(e); liveEl.innerHTML = `<p class="empty">Couldn't load live ${word.toLowerCase()}.</p><button class="btn sm ghost retry" type="button" onclick="location.reload()">Retry</button>`; }));

  // ---- shift cash count
  const cashWrap = root.querySelector("#ovCashWrap");
  if (mode === "stay") cashWrap.remove();
  else unsubs.push(onSnapshot(query(collection(db, "stores", storeId, "shifts"), where("status", "in", ["open", "needs_count", "pending_check"]), limit(1)), async (snap) => {
    const sh = snap.docs[0] ? { id: snap.docs[0].id, ...snap.docs[0].data() } : null;
    if (!sh) { cashWrap.innerHTML = `<div class="cash-card"><h2 id="ccT">Shift cash count</h2><p class="empty" style="color:var(--ink)">No shift open. Start one on the counter to track the cash drawer.</p><a class="btn" href="/counter/#shift" target="_blank" rel="noopener">Open the counter</a></div>`; return; }
    let cashSales = 0;
    try { const { computeShiftTally } = await import("./staffpanels.js"); const t = await computeShiftTally(storeId, sh, (FLOW[mode] || FLOW.table).slice(-1)[0][0]); cashSales = t.byMethod?.cash || 0; } catch (e) { console.warn(e); }
    const float = Number(sh.startingCash) || 0;
    cashWrap.innerHTML = `<div class="cash-card"><h2 id="ccT">Shift cash count</h2><p class="small" style="margin:0 0 6px">${sh.status === "open" ? `Opened by ${esc(sh.openedByName || "")}${sh.openedAt?.toDate ? " · " + sh.openedAt.toDate().toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" }) : ""}` : sh.status === "needs_count" ? "Shift ended — count the cash now" : "Waiting for a manager to check"}</p>
      <div class="ln"><span>Opening float</span><span>${money(float)}</span></div><div class="ln"><span>Cash sales</span><span>${money(cashSales)}</span></div><hr/>
      <div class="ln tot"><span>Expected in drawer</span><span>${money(float + cashSales)}</span></div>
      <a class="btn" href="/counter/#shift" target="_blank" rel="noopener">Count cash &amp; close shift</a></div>`;
  }, () => { cashWrap.innerHTML = ""; }));

  // ---- all branches (multi-branch owners)
  if (ctx.orgId && multi) {
    const box = root.querySelector("#ovBranches");
    box.innerHTML = `<section class="ov-sec" aria-labelledby="brT"><header><h2 id="brT">All branches</h2><span class="muted small">completed &amp; sales</span></header><div class="empty">Loading…</div></section>`;
    const since = new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10), today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
    getDocs(query(collection(db, "orgs", ctx.orgId, "daily"), where("day", ">=", since))).then((snap) => {
      const by = {}; ctx.branches.forEach((b) => (by[b.storeId] = { name: b.name, t: { o: 0, s: 0 }, w: { o: 0, s: 0 } }));
      snap.docs.forEach((d) => { const x = d.data(); const b = by[x.storeId]; if (!b) return; b.w.o += x.completed || 0; b.w.s += x.sales || 0; if (x.day === today) { b.t.o += x.completed || 0; b.t.s += x.sales || 0; } });
      box.querySelector(".empty").outerHTML = `<div style="overflow:auto"><table class="tbl"><thead><tr><th>Branch</th><th>Today</th><th>Today sales</th><th>7 days</th><th>7 days sales</th></tr></thead><tbody>${Object.entries(by).map(([id, b]) => `<tr${id === storeId ? ' style="font-weight:800"' : ""}><td>${esc(b.name)}</td><td>${b.t.o}</td><td>${money(b.t.s)}</td><td>${b.w.o}</td><td>${money(b.w.s)}</td></tr>`).join("")}</tbody></table></div>`;
    }).catch(() => (box.querySelector(".empty").textContent = "No data yet."));
  }
  return () => unsubs.forEach((u) => u?.());
}
