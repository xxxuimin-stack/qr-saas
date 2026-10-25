// Reports (owner): shift history with cash tally, requests response time
import { db, call } from "../firebase.js";
import { collection, onSnapshot, query, orderBy, limit, where, getDocs, doc, updateDoc } from "firebase/firestore";
import { esc, html, money, toast, openModal, closeModal } from "../ui.js";
import { commissionFor } from "../salonpay.js";

export function renderReportsPage(root, ctx) {
  const { storeId, store } = ctx;
  const cur = store.settings?.currency || "PHP";
  // 💸 Staff balances & remittances (salon / spa) — staff who collect payments remit online; the owner confirms
  if (store.mode === "salon") {
    const box = html(`<div class="tile" style="margin-bottom:14px" id="remit"><div class="row between wrap"><h3 style="margin:0">💸 Staff balances &amp; remittances</h3><span class="small muted">+ staff owes the shop · − the shop owes the staff</span></div><div data-pend></div><div data-bal class="small muted">Loading…</div></div>`);
    root.appendChild(box);
    const sign = (e) => (e.type === "collect" || e.type === "payout" ? 1 : e.type === "earn" || (e.type === "remit" && e.status === "confirmed") ? -1 : 0);
    onSnapshot(query(collection(db, "stores", storeId, "staffLedger"), orderBy("at", "desc"), limit(2000)), (snap) => {
      const L = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const pend = L.filter((e) => e.type === "remit" && e.status === "pending");
      box.querySelector("[data-pend]").innerHTML = pend.length ? `<div style="margin:8px 0"><b>To confirm (${pend.length})</b>${pend.map((e) => `<div class="row between wrap" style="gap:8px;padding:8px 0;border-bottom:1px solid var(--line)"><span><b>${esc(e.staffName)}</b> · ${money(e.amount, cur)} · ${esc((e.method || "").toUpperCase())}${e.refNo ? ` ref <b>${esc(e.refNo)}</b>` : ""}${e.proofUrl ? ` · <a data-priv="${esc(e.proofUrl)}" target="_blank">screenshot</a>` : ""}<br><span class="muted">${new Date(e.at).toLocaleString("en-PH", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span></span><span class="row" style="gap:6px"><button class="btn sm" data-rok="${e.id}">✓ Received</button><button class="btn sm ghost" data-rno="${e.id}">Not received</button></span></div>`).join("")}</div>` : "";
      const by = {}; L.forEach((e) => { const r = (by[e.staffId] ||= { name: e.staffName, collect: 0, earn: 0, remit: 0, payout: 0, bal: 0 }); if (e.type === "remit" && e.status !== "confirmed") return; r[e.type] += e.amount; r.bal += sign(e) * e.amount; });
      const rows = Object.entries(by);
      box.querySelector("[data-bal]").outerHTML = `<div data-bal>${rows.length ? `<div style="overflow:auto"><table class="tbl"><thead><tr><th>Staff</th><th>Collected</th><th>Pay earned</th><th>Remitted</th><th>Paid out</th><th>Balance</th><th></th></tr></thead><tbody>${rows.map(([id, r]) => `<tr><td>${esc(r.name)}</td><td>${money(r.collect, cur)}</td><td>${money(r.earn, cur)}</td><td>${money(r.remit, cur)}</td><td>${money(r.payout, cur)}</td><td><b style="color:${r.bal > 0 ? "var(--danger)" : "var(--ok, #15803d)"}">${r.bal > 0 ? `owes ${money(r.bal, cur)}` : r.bal < 0 ? `you owe ${money(-r.bal, cur)}` : "settled"}</b></td><td>${r.bal < 0 ? `<button class="btn sm ghost" data-payst="${esc(id)}" data-amt="${-r.bal}">Pay</button>` : ""}</td></tr>`).join("")}</tbody></table></div>` : `<p class="small muted">No entries yet. Turn on "Staff collect &amp; remit" in Settings → Salon for on-call staff who take payments themselves.</p>`}</div>`;
      import("../privfiles.js").then((m) => m.hydratePrivate(box));
    }, () => {});
    box.addEventListener("click", async (e) => {
      const t = e.target.closest("[data-rok],[data-rno],[data-payst]"); if (!t) return;
      try {
        if (t.dataset.rok) await call("staffRemit", { action: "review", id: t.dataset.rok, approve: true });
        if (t.dataset.rno) { const r = prompt("Reason (the staff sees this):", "Not received — please check the reference number"); if (r === null) return; await call("staffRemit", { action: "review", id: t.dataset.rno, approve: false, reason: r }); }
        if (t.dataset.payst) { const a = prompt("Amount you paid this staff (₱):", t.dataset.amt); if (!a) return; const m = prompt("How? (cash / gcash / bank)", "gcash") || "cash"; await call("staffRemit", { action: "payout", staffId: t.dataset.payst, amount: Number(a), method: m }); }
        toast("Saved");
      } catch (x) { toast(x.message, "error"); }
    });
  }
  // 🧾 Activity log — who did what (cancel, payments, edits, prices, promos, free items…)
  {
    const LBL = { cancel: "✕ Cancelled order", paid: "💵 Marked paid", verify_payment: "✓ Verified payment", unpaid: "↩ Undid payment", delivery_fee: "🛵 Delivery fee", delivered: "✅ Delivered", edit: "✏️ Edited order", complimentary: "🎁 Free item", price: "₱ Price change", item_add: "➕ Added item", photo: "📷 Photo", dish_promo: "🏷️ Dish promo", promo_off: "🏷️ Promo ended", late_orders: "🌙 Late orders", incident_voucher: "🎟️ Sorry voucher", incident_refund: "💸 Refund", incident_remake: "🔁 Remake", incident_dismiss: "✖ Report dismissed", incident_dismissed: "✖ Report dismissed" };
    const box = html(`<div class="tile" style="margin-bottom:14px"><div class="row between wrap"><h3 style="margin:0">🧾 Activity log</h3><select data-f style="max-width:220px"><option value="">Everything</option><option value="money">Money (cancel, paid, edits)</option><option value="menu">Menu (prices, items, promos)</option></select></div><p class="small muted" style="margin:4px 0 10px">Every cancel, payment, order edit, free item, price change and promo — with who did it.</p><div data-log class="small muted">Loading…</div></div>`);
    root.appendChild(box);
    let rows = [];
    const draw = () => {
      const f = box.querySelector("[data-f]").value;
      const money_ = ["cancel", "paid", "verify_payment", "unpaid", "delivery_fee", "edit", "complimentary"], menu = ["price", "item_add", "photo", "dish_promo", "promo_off"];
      const list = rows.filter((r) => !f || (f === "money" ? money_ : menu).includes(r.action));
      box.querySelector("[data-log]").innerHTML = list.length ? `<table class="tbl"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead><tbody>${list.map((r) => `<tr><td>${r.at?.toDate ? r.at.toDate().toLocaleString("en-PH", { dateStyle: "short", timeStyle: "short" }) : ""}</td><td>${esc(r.by || "")}</td><td>${esc(LBL[r.action] || r.action)}</td><td>${esc([r.orderNo ? "#" + r.orderNo : "", r.name || "", r.old != null && r.new != null ? `${money(r.old, cur)} → ${money(r.new, cur)}` : "", r.total ? money(r.total, cur) : "", r.method || "", r.summary || "", r.reason || "", r.text || ""].filter(Boolean).join(" · "))}</td></tr>`).join("")}</tbody></table>` : `<p class="muted small">Nothing yet.</p>`;
    };
    box.querySelector("[data-f]").onchange = draw;
    getDocs(query(collection(db, "stores", storeId, "audit"), orderBy("at", "desc"), limit(200))).then((snap) => { rows = snap.docs.map((d) => d.data()); draw(); }).catch(() => (box.querySelector("[data-log]").textContent = "No activity yet."));
  }
  // 👀 Staff watch — who takes cash, who cancels, who gives free items (last 30 days). Flags unusual patterns.
  if (store.mode !== "stay") {
    const box = html(`<div class="tile" style="margin-bottom:14px"><div class="row between wrap"><h3 style="margin:0">👀 Staff watch — last 30 days</h3><span class="small muted">From the activity log</span></div><p class="small muted" style="margin:4px 0 10px">A staff member who takes far more <b>cash</b> than others, or cancels / gives away more, is worth a closer look. Red = well above the team average.</p><div data-sw class="small muted">Loading…</div></div>`);
    root.appendChild(box);
    const since = new Date(Date.now() - 30 * 864e5);
    getDocs(query(collection(db, "stores", storeId, "audit"), where("at", ">=", since), orderBy("at", "desc"), limit(3000))).then((snap) => {
      const by = {};
      const S = (n) => (by[n] = by[n] || { name: n, paid: 0, cash: 0, cancels: 0, cancelAmt: 0, paidCancels: 0, comps: 0, undo: 0, notRecv: 0, edits: 0, editDown: 0 });
      snap.docs.forEach((d) => {
        const r = d.data(); if (!r.by || r.by === "System") return; const x = S(r.by);
        if (r.action === "paid" || r.action === "appt_pay") { x.paid += r.total || 0; if (/cash/i.test(r.method || "")) x.cash += r.total || 0; }
        else if (r.action === "verify_payment") x.paid += r.total || 0;
        else if (r.action === "cancel") { x.cancels++; x.cancelAmt += r.total || 0; if (r.paid) x.paidCancels++; }
        else if (r.action === "complimentary") x.comps++;
        else if (r.action === "unpaid" || r.action === "appt_unpay") x.undo++;
        else if (r.action === "payment_not_received") x.notRecv++;
        else if (r.action === "edit") { x.edits++; if ((r.after || 0) < (r.before || 0)) x.editDown += (r.before || 0) - (r.after || 0); }
      });
      const rows = Object.values(by).filter((x) => x.paid || x.cancels || x.comps || x.undo || x.edits);
      if (!rows.length) { box.querySelector("[data-sw]").textContent = "No staff activity yet."; return; }
      const avg = (f) => rows.reduce((a, x) => a + f(x), 0) / rows.length;
      const cashPct = (x) => (x.paid ? Math.round((x.cash / x.paid) * 100) : 0);
      const aCash = avg(cashPct), aCan = avg((x) => x.cancels), aComp = avg((x) => x.comps);
      const flag = (v, a, min) => (rows.length > 1 && v >= min && v > a * 1.8 ? ' style="color:#B42318;font-weight:700"' : "");
      box.querySelector("[data-sw]").innerHTML = `<table class="tbl"><thead><tr><th>Staff</th><th>Took payments</th><th>Cash %</th><th>Cancels</th><th>Cancelled after paid</th><th>Free items</th><th>Undo payment</th><th>Price cuts in edits</th><th>GCash not received</th></tr></thead><tbody>${rows.sort((a, b) => b.paid - a.paid).map((x) => `<tr><td><b>${esc(x.name)}</b></td><td>${money(x.paid, cur)}</td><td${rows.length > 1 && cashPct(x) - aCash >= 20 ? ' style="color:#B42318;font-weight:700"' : ""}>${x.paid ? cashPct(x) + "%" : "—"}</td><td${flag(x.cancels, aCan, 3)}>${x.cancels}${x.cancelAmt ? ` · ${money(x.cancelAmt, cur)}` : ""}</td><td${x.paidCancels ? ' style="color:#B42318;font-weight:700"' : ""}>${x.paidCancels}</td><td${flag(x.comps, aComp, 3)}>${x.comps}</td><td${x.undo ? ' style="color:#B42318;font-weight:700"' : ""}>${x.undo}</td><td>${x.editDown ? money(x.editDown, cur) : "—"}</td><td>${x.notRecv}</td></tr>`).join("")}</tbody></table><p class="small muted" style="margin:8px 0 0">Team average cash share: ${Math.round(aCash)}%. Tip: if one person's cash share is much higher, check their shift counts and the customer QR orders on their shifts.</p>`;
    }).catch((e) => { console.warn(e); box.querySelector("[data-sw]").textContent = "Couldn't load (activity log index may still be building)."; });
  }
  // 🛡 Staff offer reports (salon) — private reports from customers about "side bookings"
  if (store.mode === "salon") {
    const box = html(`<div class="tile" style="margin-bottom:14px"><h3 style="margin:0">🛡 Staff offer reports</h3><p class="small muted" style="margin:4px 0 10px">Private reports from customers: a staff member offered a service outside the app. Staff don't see these.</p><div data-sr class="small muted">Loading…</div></div>`);
    root.appendChild(box);
    onSnapshot(query(collection(db, "stores", storeId, "staffReports"), orderBy("at", "desc"), limit(50)), (snap) => {
      const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      const el = box.querySelector("[data-sr]");
      if (!rows.length) { el.textContent = "No reports. 👍"; return; }
      el.innerHTML = rows.map((r) => `<div class="row between wrap" style="border-top:1px solid var(--edge);padding:10px 0;gap:8px"><div style="flex:1;min-width:220px"><b>${esc(r.staffName || "Staff not named")}</b> <span class="muted">· ${r.at?.toDate ? r.at.toDate().toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" }) : ""}</span><div>${esc(r.details)}</div>${r.phone ? `<div class="muted">Customer: <a href="tel:${esc(r.phone)}">${esc(r.phone)}</a></div>` : ""}</div><span>${r.status === "done" ? `<span class="pill active">Handled</span>` : `<button class="btn sm ghost" data-done="${r.id}">Mark handled</button>`}</span></div>`).join("");
      el.querySelectorAll("[data-done]").forEach((b) => (b.onclick = () => updateDoc(doc(db, "stores", storeId, "staffReports", b.dataset.done), { status: "done" })));
    }, () => (box.querySelector("[data-sr]").textContent = "No reports."));
  }
  if (ctx.orgId && (ctx.branches || []).length > 1) {
    const box = html(`<div class="tile" style="margin-bottom:14px"><h3>🏬 All branches — last 30 days</h3><div class="small muted">Loading…</div></div>`); root.appendChild(box);
    const since = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
    getDocs(query(collection(db, "orgs", ctx.orgId, "daily"), where("day", ">=", since))).then((snap) => {
      const by = {}; ctx.branches.forEach((b) => (by[b.storeId] = { name: b.name, orders: 0, completed: 0, cancelled: 0, sales: 0, kg: 0 }));
      snap.docs.forEach((d) => { const x = d.data(); const b = by[x.storeId]; if (!b) return; b.orders += x.orders || 0; b.completed += x.completed || 0; b.cancelled += x.cancelled || 0; b.sales += x.sales || 0; b.kg += x.kg || 0; });
      const rows = Object.values(by); const sum = (f) => rows.reduce((a, b) => a + b[f], 0);
      box.querySelector("div").outerHTML = `<table class="tbl"><thead><tr><th>Branch</th><th>Orders</th><th>Completed</th><th>Cancelled</th>${store.mode === "laundry" ? "<th>Kg</th>" : ""}<th>Sales</th><th>Avg / order</th></tr></thead><tbody>${rows.map((b) => `<tr><td><b>${esc(b.name)}</b></td><td>${b.orders}</td><td>${b.completed}</td><td>${b.cancelled}</td>${store.mode === "laundry" ? `<td>${Math.round(b.kg * 10) / 10}</td>` : ""}<td>${money(b.sales, cur)}</td><td>${b.completed ? money(b.sales / b.completed, cur) : "—"}</td></tr>`).join("")}<tr><td><b>Total</b></td><td><b>${sum("orders")}</b></td><td><b>${sum("completed")}</b></td><td><b>${sum("cancelled")}</b></td>${store.mode === "laundry" ? `<td><b>${Math.round(sum("kg") * 10) / 10}</b></td>` : ""}<td><b>${money(sum("sales"), cur)}</b></td><td></td></tr></tbody></table>`;
    }).catch(() => (box.querySelector("div").textContent = "No data yet."));
  }
  if (store.mode === "salon") {
    const box = html(`<div class="tile" style="margin-bottom:14px"><div class="row between wrap" style="gap:8px"><h3>💇 Staff pay &amp; ranking</h3><div class="row wrap" style="gap:6px"><select data-range>
      <option value="c1">This month · 1–15</option><option value="c2">This month · 16–end</option><option value="p1">Last month · 1–15</option><option value="p2">Last month · 16–end</option><option value="d7" selected>Last 7 days</option><option value="d1">Today</option><option value="d30">Last 30 days</option></select>
      <button class="btn ghost sm" type="button" data-adv>💸 + Cash advance</button><button class="btn ghost sm" type="button" data-csv>⬇ Excel (CSV)</button><button class="btn ghost sm" type="button" data-print>🖨 Print / PDF</button></div></div><div data-pay class="small muted">Loading…</div></div>`); root.appendChild(box);
    if (store.settings?.setup?.kind === "solo") box.style.display = "none"; // owner-only: no staff pay
    let lastRows = [], lastLabel = "", staffList = [], lastStaff = {};
    const rangeOf = (k) => {
      const ph = new Date(Date.now() + 8 * 3600e3); const y = ph.getUTCFullYear(), m = ph.getUTCMonth();
      const at = (yy, mm, dd) => new Date(Date.UTC(yy, mm, dd) - 8 * 3600e3);
      const end = (yy, mm) => new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
      if (k === "c1") return [at(y, m, 1), at(y, m, 16), `${y}-${String(m + 1).padStart(2, "0")} 1–15`];
      if (k === "c2") return [at(y, m, 16), at(y, m, end(y, m) + 1), `${y}-${String(m + 1).padStart(2, "0")} 16–${end(y, m)}`];
      const py = m === 0 ? y - 1 : y, pm = m === 0 ? 11 : m - 1;
      if (k === "p1") return [at(py, pm, 1), at(py, pm, 16), `${py}-${String(pm + 1).padStart(2, "0")} 1–15`];
      if (k === "p2") return [at(py, pm, 16), at(py, pm, end(py, pm) + 1), `${py}-${String(pm + 1).padStart(2, "0")} 16–${end(py, pm)}`];
      const days = Number(k.slice(1)); const from = at(y, m, ph.getUTCDate() - (days - 1)); return [from, new Date(Date.now() + 60000), days === 1 ? "Today" : `Last ${days} days`];
    };
    const load = async () => {
      const [from, to, label] = rangeOf(box.querySelector("[data-range]").value); lastLabel = label;
      const [ap, du, st, adv] = await Promise.all([getDocs(query(collection(db, "stores", storeId, "appointments"), where("startAt", ">=", from), orderBy("startAt", "desc"), limit(5000))), getDocs(query(collection(db, "stores", storeId, "duties"), where("createdAt", ">=", from), limit(3000))), getDocs(collection(db, "stores", storeId, "staff")), getDocs(query(collection(db, "stores", storeId, "advances"), where("at", ">=", from.getTime()))).catch(() => ({ docs: [] }))]);
      staffList = st.docs.map((d) => ({ id: d.id, ...d.data() })).filter((x) => x.active !== false);
      const advList = adv.docs.map((d) => ({ id: d.id, ...d.data() })).filter((x) => x.at < to.getTime());
      const staff = Object.fromEntries(st.docs.map((d) => [d.id, d.data()]));
      const all = ap.docs.map((d) => d.data()).filter((a) => !a.test);
      const inRange = all.filter((a) => a.startAt.toMillis() < to.getTime());
      const by = {}; const row = (id) => (by[id] = by[id] || { id, name: staff[id]?.name || "—", duty: 0, basic: 0, services: 0, products: 0, clients: new Set(), visits: 0, sales: 0, commission: 0, tips: 0, noShow: 0, booked: 0, rating: [], back: 0, adv: 0 });
      advList.forEach((x) => { row(x.staffId).adv += x.amount || 0; });
      du.docs.map((d) => d.data()).filter((d) => ["on", "ended"].includes(d.status) && d.acceptedAt && (d.createdAt?.toMillis?.() || 0) < to.getTime()).forEach((d) => { const r = row(d.staffId); r.duty++; r.basic += d.basic || 0; });
      inRange.filter((a) => a.providerId).forEach((a) => {
        const r = row(a.providerId); r.booked++;
        if (a.status === "done") {
          r.visits++; r.services += (a.items || []).filter((l) => !l.retail && !l.package).length; r.products += (a.items || []).filter((l) => l.retail).reduce((x, l) => x + (l.qty || 1), 0);
          r.sales += a.total || 0; r.tips += a.tip || 0; if (a.customerKey) r.clients.add(a.customerKey);
          if (staff[a.providerId]?.salary?.commission !== false) r.commission += commissionFor(a);
          if (a.rating) r.rating.push(a.rating);
          if (a.customerKey && all.some((x) => x.customerKey === a.customerKey && x.startAt.toMillis() > a.startAt.toMillis() && !["cancelled", "no_show"].includes(x.status))) r.back++;
        }
        if (a.status === "no_show") r.noShow++;
      });
      const rows = Object.values(by).map((r) => ({ ...r, clients: r.clients.size, total: r.basic + r.commission + r.tips, net: r.basic + r.commission + r.tips - r.adv, avg: r.visits ? r.sales / r.visits : 0, rebook: r.visits ? Math.round((r.back / r.visits) * 100) : 0, nsRate: r.booked ? Math.round((r.noShow / r.booked) * 100) : 0, stars: r.rating.length ? r.rating.reduce((a, b) => a + b, 0) / r.rating.length : 0 })).sort((a, b) => b.sales - a.sales);
      lastRows = rows;
      const paidMap = Object.fromEntries((await getDocs(query(collection(db, "stores", storeId, "payouts"), where("period", "==", label))).catch(() => ({ docs: [] }))).docs.map((d) => [d.data().staffId, d.data()]));
      lastStaff = staff;
      const paidIn = inRange.filter((a) => a.paid && a.status === "done");
      const homeA = paidIn.filter((a) => a.homeService), shopA = paidIn.filter((a) => !a.homeService);
      const amt = (l) => l.reduce((x, a) => x + (a.amountDue ?? (a.total || 0) + (a.homeFee || 0)), 0);
      const split = homeA.length ? `<div class="row wrap" style="gap:10px;margin:6px 0 10px"><div class="tile" style="flex:1;min-width:160px;margin:0"><div class="small muted">🏪 Shop</div><b>${money(amt(shopA), cur)}</b><div class="small muted">${shopA.length} visit${shopA.length === 1 ? "" : "s"}</div></div><div class="tile" style="flex:1;min-width:160px;margin:0"><div class="small muted">🏠 Home service</div><b>${money(amt(homeA), cur)}</b><div class="small muted">${homeA.length} visit${homeA.length === 1 ? "" : "s"} · transport ${money(homeA.reduce((x, a) => x + (a.homeFee || 0), 0), cur)}</div></div></div>` : "";
      box.querySelector("[data-pay]").outerHTML = `<div data-pay>${split}<p class="small muted" style="margin:6px 0">${esc(label)} · ranked by sales</p><div style="overflow:auto"><table class="tbl"><thead><tr><th>#</th><th>Staff</th><th>Duty days</th><th>Basic</th><th>Services</th><th>Products</th><th>Clients</th><th>Sales</th><th>Avg / visit</th><th>Commission</th><th>Tips</th><th>Total pay</th><th>Cash advance</th><th>Net pay</th><th>Came back</th><th>No-show</th><th>Rating</th><th>Paid</th></tr></thead><tbody>${rows.map((r, i) => `<tr><td>${i + 1}</td><td><b>${esc(r.name)}</b>${staff[r.id]?.payType === "oncall" ? ` <span class="pill trial" style="font-size:.7rem">on-call</span><div class="small muted">jobs ✓${staff[r.id]?.acceptedJobs || 0} · missed ${staff[r.id]?.missedJobs || 0}</div>` : ""}</td><td>${r.duty}</td><td>${money(r.basic, cur)}</td><td>${r.services}</td><td>${r.products}</td><td>${r.clients}</td><td>${money(r.sales, cur)}</td><td>${money(r.avg, cur)}</td><td>${money(r.commission, cur)}</td><td>${money(r.tips, cur)}</td><td>${money(r.total, cur)}</td><td class="${r.adv ? "danger-text" : ""}">${r.adv ? "−" + money(r.adv, cur) : "—"}</td><td><b>${money(r.net, cur)}</b></td><td>${r.rebook}%</td><td class="${r.nsRate >= 15 ? "danger-text" : ""}">${r.nsRate}%</td><td>${r.stars ? "★ " + r.stars.toFixed(1) : "—"}</td><td>${paidMap[r.id] ? `<span class="pill active" style="font-size:.75rem">✓ ${money(paidMap[r.id].amount, cur)}</span><div class="small muted">${new Date(paidMap[r.id].paidAt).toLocaleDateString("en-PH", { month: "short", day: "numeric" })} <a href="#" data-unpaid="${esc(r.id)}">undo</a></div>` : r.net > 0 ? `<button class="btn ghost sm" type="button" data-markpaid="${esc(r.id)}" data-amt="${r.net}" data-name="${esc(r.name)}">Mark paid</button>` : "—"}</td></tr>`).join("") || `<tr><td colspan="18" class="muted">No data yet.</td></tr>`}</tbody></table></div>
        ${advList.length ? `<details style="margin-top:8px"><summary class="small">💸 Cash advances in this period (${advList.length})</summary>${advList.sort((a, b) => b.at - a.at).map((x) => `<div class="row between small" style="padding:4px 0;border-bottom:1px solid var(--line)"><span>${new Date(x.at).toLocaleDateString("en-PH", { month: "short", day: "numeric" })} · <b>${esc(x.name)}</b> · ${money(x.amount, cur)}${x.note ? ` · ${esc(x.note)}` : ""} <span class="muted">by ${esc(x.by || "")}</span></span><button class="btn ghost sm" type="button" data-deladv="${x.id}">Delete</button></div>`).join("")}</details>` : ""}<p class="small muted">Basic counts only duties accepted by the counter. Commission = each service's / product's staff pay (fixed ₱ or % of price). "Came back" = clients who booked again after their visit. Record only — pay staff from your payroll.</p></div>`;
    };
    box.querySelector("[data-range]").onchange = () => { box.querySelector("[data-pay]").textContent = "Loading…"; load().catch(() => {}); };
    box.addEventListener("click", async (e) => {
      const mp = e.target.dataset?.markpaid, up = e.target.dataset?.unpaid;
      if (mp) { const v = prompt(`Pay ${e.target.dataset.name} for ${lastLabel}. Amount paid (₱):`, e.target.dataset.amt); if (v == null) return; try { await call("recordPayout", { staffId: mp, staffName: e.target.dataset.name, period: lastLabel, amount: Number(v) || 0 }); toast("Marked as paid"); load(); } catch (err) { toast(err.message, "error"); } return; }
      if (up) { e.preventDefault(); if (!confirm("Undo this payout record?")) return; try { await call("recordPayout", { staffId: up, period: lastLabel, undo: true }); load(); } catch (err) { toast(err.message, "error"); } return; }
    });
    box.addEventListener("click", async (e) => { const id = e.target.dataset?.deladv; if (!id || !confirm("Delete this cash advance?")) return; try { await call("recordAdvance", { deleteId: id }); toast("Deleted"); load(); } catch (err) { toast(err.message, "error"); } });
    box.querySelector("[data-adv]").onclick = () => {
      const body = html(`<div><label>Staff</label><select name="s">${staffList.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join("")}</select><label>Amount (₱)</label><input name="a" type="number" min="1"/><label>Note</label><input name="n" placeholder="e.g. bale, emergency"/></div>`);
      const foot = html(`<div class="row" style="justify-content:flex-end"><button class="btn ghost" data-no>Cancel</button><button class="btn" data-yes>Save</button></div>`);
      foot.querySelector("[data-no]").onclick = closeModal;
      foot.querySelector("[data-yes]").onclick = async () => { try { await call("recordAdvance", { staffId: body.querySelector("[name=s]").value, amount: Number(body.querySelector("[name=a]").value || 0), note: body.querySelector("[name=n]").value }); closeModal(); toast("Cash advance saved"); load(); } catch (err) { toast(err.message, "error"); } };
      openModal({ title: "💸 Cash advance", body, footer: foot });
    };
    box.querySelector("[data-csv]").onclick = () => {
      const head = ["Staff", "Duty days", "Basic", "Services", "Products", "Clients", "Sales", "Avg per visit", "Commission", "Tips", "Total pay", "Cash advance", "Net pay", "Came back %", "No-show %", "Rating"];
      const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
      const csv = [head.map(q).join(","), ...lastRows.map((r) => [r.name, r.duty, r.basic, r.services, r.products, r.clients, r.sales, r.avg.toFixed(2), r.commission, r.tips, r.total, r.adv, r.net, r.rebook, r.nsRate, r.stars ? r.stars.toFixed(1) : ""].map(q).join(","))].join("\n");
      const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv" })); a.download = `staff-pay-${lastLabel.replace(/[^\w-]+/g, "_")}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    };
    box.querySelector("[data-print]").onclick = () => {
      const w = window.open("", "_blank"); if (!w) return alert("Allow pop-ups to print.");
      w.document.write(`<!doctype html><meta charset="utf-8"><title>Staff pay ${esc(lastLabel)}</title><style>body{font:13px system-ui;margin:24px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:6px;text-align:left}th{background:#f3f3f3}</style><h2>${esc(store.name)} — Staff pay</h2><p>${esc(lastLabel)}</p>${box.querySelector("table").outerHTML}<p style="margin-top:40px">Prepared by: ____________________ &nbsp; Received by: ____________________</p><script>print()<\/script>`);
      w.document.close();
    };
    load().catch(() => (box.querySelector("[data-pay]").textContent = "No data yet."));
    // rebook reminders: who is due back, how many got an SMS / were contacted, and how many came back
    const rb = html(`<div class="tile" style="margin-bottom:14px"><h3>🔁 Rebook reminders</h3><div data-rb class="small muted">Loading…</div></div>`); root.appendChild(rb);
    getDocs(query(collection(db, "stores", storeId, "customers"), limit(3000))).then((snap) => {
      const cs = snap.docs.map((d) => d.data());
      const sent = cs.reduce((a, c) => a + (c.rebookSmsCount || 0), 0), back = cs.reduce((a, c) => a + (c.rebookReturnCount || 0), 0);
      const nd = cs.filter((c) => c.nextDue); const t0 = new Date(); t0.setHours(0, 0, 0, 0);
      const open = nd.filter((c) => ["due", "snoozed"].includes(c.nextDue.status));
      const k = (l, v, sub = "") => `<div class="stat"><div class="k">${l}</div><div class="v">${v}</div>${sub ? `<div class="small muted">${sub}</div>` : ""}</div>`;
      rb.querySelector("[data-rb]").outerHTML = `<div class="stats">${k("Overdue now", open.filter((c) => c.nextDue.at < t0.getTime()).length)}${k("Due in 14 days", open.filter((c) => c.nextDue.at >= t0.getTime() && c.nextDue.at < t0.getTime() + 14 * 86400e3).length)}${k("Rebooked", nd.filter((c) => c.nextDue.status === "booked").length, "after a due date was set")}${k("Reminded (SMS / contacted)", sent + nd.filter((c) => c.nextDue.contactedAt && !c.nextDue.smsAt).length)}${k("Came back after a reminder", back, sent ? `${Math.round((back / Math.max(1, sent)) * 100)}% of SMS sent` : "")}${k("Not coming back", nd.filter((c) => c.nextDue.status === "lost").length)}</div><p class="small muted">Set "Rebook reminder after (weeks)" on services. The counter sees the list in <b>Due back</b>.</p>`;
    }).catch(() => (rb.querySelector("[data-rb]").textContent = "No data yet."));
    // walk-in line: how long people waited, who left, peak hours
    const qb = html(`<div class="tile" style="margin-bottom:14px"><div class="row between wrap" style="gap:8px"><h3 style="margin:0">🎟️ Walk-in line</h3><select data-qr style="max-width:160px"><option value="1">Today</option><option value="7" selected>Last 7 days</option><option value="30">Last 30 days</option></select></div><div data-qb class="small muted" style="margin-top:10px">Loading…</div></div>`); root.appendChild(qb);
    const loadQ = async () => {
      const days = Number(qb.querySelector("[data-qr]").value); const from = new Date(); from.setHours(0, 0, 0, 0); from.setDate(from.getDate() - (days - 1));
      const snap = await getDocs(query(collection(db, "stores", storeId, "appointments"), where("startAt", ">=", from), orderBy("startAt", "desc"), limit(5000)));
      const t = snap.docs.map((d) => d.data()).filter((a) => a.waitNo && !a.test);
      if (!t.length) { qb.querySelector("[data-qb]").outerHTML = `<div data-qb class="small muted" style="margin-top:10px">No one joined the line in this period.</div>`; return; }
      const joined = (a) => a.waitedSince?.toMillis?.() || a.createdAt?.toMillis?.() || 0;
      const servedAt = (a) => a.queueCalled?.at || a.startedAt?.toMillis?.() || null;
      const waits = t.map((a) => (servedAt(a) && joined(a) ? (servedAt(a) - joined(a)) / 60000 : null)).filter((x) => x != null && x >= 0 && x < 600);
      const avg = waits.length ? Math.round(waits.reduce((x, y) => x + y, 0) / waits.length) : 0;
      const longest = waits.length ? Math.round(Math.max(...waits)) : 0;
      const left = t.filter((a) => a.cancelReason === "Left the line").length, ns = t.filter((a) => a.status === "no_show").length, sw = t.filter((a) => a.fromQueue).length, served = t.filter((a) => a.status === "done").length;
      const hours = Array(24).fill(0); t.forEach((a) => { const j = joined(a); if (j) hours[new Date(j).getHours()]++; });
      const max = Math.max(...hours, 1); const open = hours.map((n, h) => [h, n]).filter(([, n]) => n);
      const lo = open.length ? open[0][0] : 9, hi = open.length ? open.at(-1)[0] : 20;
      const k = (l, v, sub = "") => `<div class="stat"><div class="k">${l}</div><div class="v">${v}</div>${sub ? `<div class="small muted">${sub}</div>` : ""}</div>`;
      const fmtH = (h) => `${((h + 11) % 12) + 1}${h < 12 ? "a" : "p"}`;
      qb.querySelector("[data-qb]").outerHTML = `<div data-qb style="margin-top:10px"><div class="stats">${k("Joined", t.length)}${k("Served", served)}${k("Average wait", `${avg} min`, `longest ${longest} min`)}${k("Left the line", left, t.length ? `${Math.round((left / t.length) * 100)}%` : "")}${k("No-show", ns)}${k("Switched to a reservation", sw)}</div>
        <div class="small muted" style="margin:12px 0 6px">When people join (by hour)</div>
        <div style="display:flex;align-items:flex-end;gap:4px;height:90px" role="img" aria-label="People joining the line by hour">${hours.slice(lo, hi + 1).map((n, i) => `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;height:100%;justify-content:flex-end" title="${fmtH(lo + i)}: ${n}"><div style="width:100%;max-width:26px;height:${Math.max(n ? 6 : 2, (n / max) * 70)}px;border-radius:5px 5px 2px 2px;background:${n === max ? "var(--brand, #C62828)" : "var(--edge-strong, #D1D5DB)"}"></div><span class="small muted" style="font-size:.68rem">${fmtH(lo + i)}</span></div>`).join("")}</div>
        <p class="small muted" style="margin:8px 0 0">Busiest: <b>${fmtH(hours.indexOf(max))}</b>. Add on-call staff around this time to cut the wait.</p></div>`;
    };
    qb.querySelector("[data-qr]").onchange = () => loadQ().catch(() => {});
    loadQ().catch(() => (qb.querySelector("[data-qb]").textContent = "No data yet."));
  }
  const rest = document.createElement("div"); root.appendChild(rest); root = rest;
  root.innerHTML = (store.mode === "laundry" ? `<div class="tile" style="margin-bottom:14px"><h3>🧺 Laundry — last 30 days</h3><div id="ldStats" class="grid"></div><div id="ldDays" style="margin-top:12px"></div></div>` : "") + `<div class="tile"><h3>Shifts</h3><p class="small muted">Each shift: who opened/closed, who verified, expected vs counted per payment method, variance and resolution.</p><div id="shiftList"></div></div>
    <div class="tile" style="margin-top:14px"><h3>Variance by staff</h3><p class="small muted">Shifts closed with a variance, and deductions recorded (record only — not auto-deducted).</p><div id="varList"></div></div>`;
  if (store.mode === "laundry") {
    const since = new Date(Date.now() - 30 * 86400000);
    getDocs(query(collection(db, "stores", storeId, "orders"), where("createdAt", ">=", since), orderBy("createdAt", "desc"), limit(2000))).then((snap) => {
      const jobs = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((o) => !o.test && o.type === "laundry" && o.status !== "cancelled");
      const done = jobs.filter((o) => o.status === "claimed");
      const kg = jobs.reduce((a, o) => a + (o.laundry?.kg || 0), 0), rev = done.reduce((a, o) => a + (o.total || 0), 0);
      const unclaimed = jobs.filter((o) => o.status === "ready" && o.readyAt?.toDate && Date.now() - o.readyAt.toDate() > 2 * 86400000).length;
      const svc = {}; jobs.forEach((o) => (o.items || []).forEach((l) => { if (!l.itemId) return; svc[l.name] = svc[l.name] || { jobs: 0, kg: 0, rev: 0 }; svc[l.name].jobs++; if (l.unit === "kg") svc[l.name].kg += l.qty || 0; svc[l.name].rev += l.subtotal || 0; }));
      const byDay = {}; jobs.forEach((o) => { const k = o.dayKey || (o.createdAt?.toDate?.() || new Date()).toISOString().slice(0, 10); byDay[k] = byDay[k] || { jobs: 0, kg: 0, rev: 0 }; byDay[k].jobs++; byDay[k].kg += o.laundry?.kg || 0; if (o.status === "claimed") byDay[k].rev += o.total || 0; });
      root.querySelector("#ldStats").innerHTML = [["Jobs", jobs.length], ["Kg processed", `${Math.round(kg * 10) / 10} kg`], ["Revenue (claimed)", money(rev, cur)], ["Avg per job", jobs.length ? money(rev / Math.max(1, done.length), cur) : "—"], ["Rush jobs", jobs.filter((o) => o.laundry?.rush).length], ["Unclaimed 2+ days", unclaimed]].map(([k, v]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("");
      root.querySelector("#ldDays").innerHTML = `<div class="row wrap" style="gap:16px;align-items:flex-start"><table class="tbl" style="flex:1"><thead><tr><th>Day</th><th>Jobs</th><th>Kg</th><th>Revenue</th></tr></thead><tbody>${Object.entries(byDay).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 14).map(([d, x]) => `<tr><td>${d}</td><td>${x.jobs}</td><td>${Math.round(x.kg * 10) / 10}</td><td>${money(x.rev, cur)}</td></tr>`).join("")}</tbody></table>
        <table class="tbl" style="flex:1"><thead><tr><th>Service</th><th>Jobs</th><th>Kg</th><th>Revenue</th></tr></thead><tbody>${Object.entries(svc).sort((a, b) => b[1].rev - a[1].rev).map(([n, x]) => `<tr><td>${esc(n)}</td><td>${x.jobs}</td><td>${Math.round(x.kg * 10) / 10}</td><td>${money(x.rev, cur)}</td></tr>`).join("")}</tbody></table></div>`;
    }).catch(() => {});
  }
  const unsub = onSnapshot(query(collection(db, "stores", storeId, "shifts"), orderBy("createdAt", "desc"), limit(60)), (snap) => {
    const el = root.querySelector("#shiftList");
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (!rows.length) return (el.innerHTML = `<p class="muted small">No shifts yet. On the Kitchen or Counter screen, tap "Start shift".</p>`);
    const RES = { explained: "Explained", staff_error: "Staff error", store_absorbs: "Store absorbs", over_deposit: "Over — deposited", none: "No variance" };
    const byStaff = {};
    rows.filter((x) => x.status === "closed" && x.closedByName).forEach((x) => { const b = byStaff[x.closedByName] = byStaff[x.closedByName] || { shifts: 0, withVar: 0, short: 0, over: 0, deduct: 0 }; b.shifts++; const v = x.variance?.cash || 0; if (x.maxVariance) b.withVar++; if (v < 0) b.short += -v; if (v > 0) b.over += v; b.deduct += x.deduction || 0; });
    root.querySelector("#varList").innerHTML = Object.keys(byStaff).length ? `<table class="tbl"><thead><tr><th>Staff</th><th>Shifts</th><th>With variance</th><th>Cash short</th><th>Cash over</th><th>Deductions recorded</th></tr></thead><tbody>${Object.entries(byStaff).map(([n, b]) => `<tr><td><b>${esc(n)}</b></td><td>${b.shifts}</td><td>${b.withVar}</td><td class="${b.short ? "danger-text" : ""}">${money(b.short, cur)}</td><td>${money(b.over, cur)}</td><td><b>${money(b.deduct, cur)}</b></td></tr>`).join("")}</tbody></table>` : `<p class="muted small">No closed shifts yet.</p>`;
    el.innerHTML = `<table class="tbl"><thead><tr><th>Date</th><th>Opened</th><th>Closed</th><th>Status</th><th>Orders</th><th>Sales</th><th>Expected → Counted</th><th>Variance</th><th>Verified by</th></tr></thead><tbody>
      ${rows.map((s) => {
        const o = s.openedAt?.toDate?.(), c = s.closedAt?.toDate?.();
        const t = s.tally || {};
        const v = s.variance;
        const stPill = { open: ["Open", "trial"], pending_check: ["Pending check", "locked"], investigating: ["Investigating", "locked"], closed: [s.resolution && s.resolution !== "none" ? RES[s.resolution] || s.resolution : "Verified ✓", "active"] }[s.status] || [s.status, ""];
        return `<tr>
          <td>${o ? o.toLocaleDateString("en-PH", { dateStyle: "medium" }) : "—"}</td>
          <td class="small">${o ? o.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" }) : ""}<br><span class="muted">${esc(s.openedByName || "")}</span></td>
          <td class="small">${c ? c.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" }) : "—"}<br><span class="muted">${esc(s.closedByName || "")}</span></td>
          <td><span class="pill ${stPill[1]}">${stPill[0]}</span>${s.deduction ? `<br><span class="small danger-text">deduct ${money(s.deduction, cur)}</span>` : ""}</td>
          <td>${t.orders ?? "—"}${t.cancelled ? `<br><span class="small muted">${t.cancelled} cancelled</span>` : ""}</td>
          <td><b>${t.sales != null ? money(t.sales, cur) : "—"}</b>${t.byMethod ? `<br><span class="small muted">${Object.entries(t.byMethod).map(([m, x]) => `${m} ${money(x, cur)}`).join(" · ")}</span>` : ""}</td>
          <td class="small">${s.expected ? Object.keys(s.expected).map((k) => `${esc(k === "pos" ? "POS" : s.methodNames?.[k] || k)}: ${money(s.expected[k], cur)} → ${money(s.counted?.[k], cur)}`).join("<br>") : s.expectedCash != null ? `${money(s.expectedCash, cur)} → ${money(s.countedCash, cur)}` : "—"}</td>
          <td class="small">${s.variance && typeof s.variance === "object" ? Object.entries(s.variance).map(([k, x]) => `<b style="color:${x === 0 ? "var(--ok)" : "var(--danger)"}">${x > 0 ? "+" : ""}${money(x, cur)}</b>`).join("<br>") : v == null ? "—" : `<b style="color:${v === 0 ? "var(--ok)" : "var(--danger)"}">${v > 0 ? "+" : ""}${money(v, cur)}</b>`}${s.closeNote ? `<br><span class="muted">${esc(s.closeNote)}</span>` : ""}${s.resolutionNote ? `<br><span class="muted">↳ ${esc(s.resolutionNote)}</span>` : ""}</td>
          <td class="small">${esc(s.verifiedByName || "—")}${s.selfVerified ? `<br><span class="muted">self-verified</span>` : ""}</td></tr>`;
      }).join("")}</tbody></table>`;
  });
  return unsub;
}
