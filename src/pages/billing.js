// Billing (owner): current plan & usage, compare plans for THIS business type, add-ons, pay by GCash (+ screenshot),
// payment history. A submitted payment turns the plan on right away for up to 3 days while TapTayo checks it.
import { db, call, auth } from "../firebase.js";
import { collection, getCountFromServer, onSnapshot, query, orderBy, limit, where, doc, getDoc, Timestamp } from "firebase/firestore";
import { esc, html, toast, money } from "../ui.js";
import { packFor, PLANS, SELLABLE, sellableFor, LIMITS, LIMIT_LABEL, FEATURE_TIER, PRO_FEATURES, ADDONS, UNLIMITED, planOf, tierOf, addonQty, limitsFor, limitMode } from "../plans.js";
import { uploadPrivateImage } from "../upload.js";

const fmtLim = (v) => (v >= UNLIMITED ? "Unlimited" : v === 0 ? "—" : String(v));
const TIER_COLS = ["free", "starter", "plus", "business"];
// what each plan means, in words, per business type (Free is different for each)
const FREE_WORDS = {
  table: "Menu + counter only (the counter takes orders, prepares and pays out — no kitchen/barista/dispatch screens)",
  salon: "Solo / home-service freelancer: your booking page and calendar, you are the only stylist, up to 2 bookings a day and 15 a month",
  laundry: "Counter + jobs, up to 15 jobs a day",
  spa: "Solo / home-service therapist: your booking page and calendar, up to 3 bookings a day and 20 a month",
  stay: "1 room, up to 20 bookings a month",
  pickup: "Menu + counter only",
  freelance: "Your booking page, rate card, offers & counter-offers, up to 3 brand deals and 20 bookings a month, 6 portfolio samples",
};

export function renderBillingPage(root, ctx) {
  root.addEventListener("click", (e) => { if (e.target.id === "refCopy") { const v = root.querySelector("#refLink").value; navigator.clipboard?.writeText(v); e.target.textContent = "Copied ✓"; } });
  const { storeId, store, labels } = ctx;
  const mode = store.mode || "table";
  const sub = ctx.sub || null;
  const cur = planOf(sub), curPlan = PLANS[cur] || PLANS.free;
  const lim = limitsFor(sub, limitMode(store));
  const ms = (t) => (t?.toMillis ? t.toMillis() : Number(t) || 0);
  const until = cur === "trial" ? ms(sub?.trialEndsAt) : ms(sub?.paidUntil);
  const days = until ? Math.ceil((until - Date.now()) / 86400000) : null;
  const prov = sub?.provisional && ms(sub.provisional.until) > Date.now() ? sub.provisional : null;
  const L = LIMITS[limitMode(store)] || LIMITS.table;
  // freelancers & creators only see Free vs Creator Pro (no Basic / Business tiers)
  const isCreator = store.businessType === "freelance";
  const COLS = isCreator ? ["free", "creator"] : TIER_COLS; const SELL = sellableFor(store);
  const tierIdx = (k) => PLANS[k].tier;

  root.innerHTML = `
    <div class="tile" style="margin-bottom:14px;border-left:4px solid var(--brand,#7B2D8E)"><h3 style="margin:0 0 4px">🎁 Invite a business, get 1 month free</h3>
      <p class="small muted" style="margin:0 0 8px">When a business you invite subscribes, you get a free month — every time. ${sub?.referralMonths ? `<b>You've earned ${sub.referralMonths} free month${sub.referralMonths > 1 ? "s" : ""} so far.</b>` : ""}</p>
      <div class="row" style="gap:6px"><input readonly value="https://taptayo.com/?ref=${store.slug}" style="flex:1" id="refLink"/><button class="btn sm" type="button" id="refCopy">Copy</button></div></div>
    <div class="grid">
      <div class="tile"><div class="k">Current plan</div><div class="v">${esc(curPlan.name)}</div>
        <div class="small muted">${prov ? `<span class="pill trial">Payment being checked</span> active until ${new Date(ms(prov.until)).toLocaleDateString("en-PH", { month: "short", day: "numeric" })}` : cur === "free" ? "Free forever — upgrade anytime" : cur === "trial" ? `${days ?? 0} trial days left — then Free (not locked)` : sub?.comp ? "🎁 Complimentary" : until ? `Paid until ${new Date(until).toLocaleDateString("en-PH", { dateStyle: "medium" })}` : ""}</div></div>
      ${store.credits ? `<div class="tile" style="border-left:4px solid #16a34a"><div class="k">TapTayo credits</div><div class="v">₱${Number(store.credits).toLocaleString("en-PH")}</div><div class="small muted">From TapTayo Protect — we deduct it from your next payment (tell us in the payment note).</div></div>` : ""}
      <div class="tile"><div class="k">Usage this business</div><div data-usage class="small" style="margin-top:6px">Loading…</div></div>
    </div>

    <h3 style="margin:22px 0 6px">Plans for your ${esc(labels.order === "Booking" ? "business" : "shop")} <span class="small muted" style="font-weight:500">· per business, per month</span></h3>
    <div class="tile" style="padding:0;overflow:auto"><table class="tbl plans-tbl"><thead><tr><th></th>${COLS.map((k) => `<th class="${k === cur || (cur === "trial" && k === (isCreator ? "creator" : "starter")) ? "cur" : ""}"><div>${esc(PLANS[k].name)}</div><div class="pp">${PLANS[k].price ? money(PLANS[k].price) : "₱0"}</div>${k === cur ? `<span class="pill active">Current</span>` : ""}</th>`).join("")}</tr></thead><tbody>
      ${Object.entries(L).map(([k, arr]) => `<tr><td>${esc(k === "items" ? labels.items : LIMIT_LABEL[k] || k)}</td>${COLS.map((c) => [arr[tierIdx(c)], tierIdx(c)]).map(([v, i]) => `<td>${fmtLim(v)}${k === "staff" && i === 0 ? " (you)" : ""}</td>`).join("")}</tr>`).join("")}
      ${Object.entries(FEATURE_TIER).filter(([k]) => relevant(k, mode)).map(([k, t]) => `<tr><td>${esc(PRO_FEATURES[k])}</td>${COLS.map((c) => tierIdx(c)).map((i) => `<td>${i >= t ? "✓" : ""}</td>`).join("")}</tr>`).join("")}
      <tr><td>Free plan</td><td colspan="${COLS.length}" class="small muted" style="text-align:left">${esc(FREE_WORDS[limitMode(store)] || FREE_WORDS[mode] || FREE_WORDS.table)}</td></tr>
    </tbody></table></div>

    <h3 style="margin:22px 0 6px">Add-ons <span class="small muted" style="font-weight:500">· monthly, on top of your plan</span></h3>
    <div class="grid" id="addons">${Object.entries(ADDONS).filter(([, a]) => !a.legacy && relevantAddon(a, mode) && a.notFor !== store.businessType && !(isCreator && ["staff1", "tables4", "delivery", "queuetv", "giftcards", "events_vip", "branch", "opsPack"].some((x) => ADDONS[x] === a))).map(([k, a]) => { const q = addonQty(sub, k); return `<div class="tile ${q ? "plan-current" : ""}">
      <div class="row between"><b>${esc(a.name)}</b>${q ? `<span class="pill active">${a.qty ? `× ${q}` : "On"}</span>` : ""}</div>
      <div style="font-weight:700;margin:4px 0">₱${a.price}<span class="small muted" style="font-weight:500">/month${a.qty ? " each" : ""}</span></div>
      <p class="small muted" style="margin:0">${esc(a.blurb || "")}${a.minTier ? ` · from ${esc(PLANS[TIER_COLS[a.minTier]].name)}` : " · any plan"}</p>${a.pack ? `<p class="small" style="margin:6px 0 0"><span class="pill active">Bundle</span> Includes ${a.pack.map((x) => esc(ADDONS[x]?.name || x)).join(" · ")}</p>` : packFor(k) && ADDONS[packFor(k)] && ADDONS[packFor(k)].notFor !== store.businessType ? `<p class="small" style="margin:6px 0 0;color:#15803d">Cheaper in the ${esc(ADDONS[packFor(k)].name)}</p>` : ""}</div>`; }).join("")}</div>

    <div class="tile" style="margin-top:16px" id="payBox">
      <h3>Upgrade / renew</h3>
      <div class="form2">
        <div><label>Plan</label><select name="plan">${SELL.map((k) => `<option value="${k}" ${k === (isCreator ? "creator" : tierOf(sub) >= 1 && PLANS[cur]?.tier ? TIER_COLS[Math.min(3, PLANS[cur].tier)] : "starter") ? "selected" : ""}>${esc(PLANS[k].name)} — ${money(PLANS[k].price)}/month</option>`).join("")}<option value="none">Add-ons only (stay on Free)</option></select></div>
        <div><label>Months</label><select name="months">${[1, 3, 6, 12].map((m) => `<option value="${m}">${m} month${m > 1 ? "s" : ""}${m === 12 ? " (2 months free)" : ""}</option>`).join("")}</select></div>
      </div>
      <div style="margin-top:10px"><label>Add-ons</label><div class="addon-pick">${Object.entries(ADDONS).filter(([, a]) => !a.legacy && relevantAddon(a, mode) && a.notFor !== store.businessType && !(isCreator && ["staff1", "tables4", "delivery", "queuetv", "giftcards", "events_vip", "branch", "opsPack"].some((x) => ADDONS[x] === a))).map(([k, a]) => `<label class="ap"><span><b>${esc(a.name)}</b> <span class="muted small">₱${a.price}/mo</span></span>${a.qty ? `<input type="number" min="0" max="10" value="${addonQty(sub, k)}" data-q="${k}"/>` : `<input type="checkbox" data-c="${k}" ${addonQty(sub, k) ? "checked" : ""}/>`}</label>`).join("")}</div><p class="small muted" data-addonnote></p></div>
      <div class="pay-how" data-how><div class="skel" style="height:60px"></div></div>
      <div class="form2" style="margin-top:10px">
        <div><label>Paid with</label><select name="method"><option value="gcash">GCash</option><option value="maya">Maya</option><option value="bank">Bank transfer</option></select></div>
        <div><label>Reference no. <span class="muted small">(optional if you add a screenshot)</span></label><input name="refNo" placeholder="e.g. 1234 567 890123"/></div>
        <div class="span2"><label>Screenshot of your payment</label><input type="file" accept="image/*" name="proof"/></div>
      </div>
      <div class="row between wrap" style="margin-top:12px;gap:10px"><span>Total: <b id="payTotal" style="font-size:1.2rem"></b></span><button class="btn" id="submitPay" type="button">Submit payment</button></div>
      <p class="small muted" style="margin:8px 0 0">${sub?.noProvisional || (sub?.lastProvisionalAt && ms(sub.lastProvisionalAt) > Date.now() - 30 * 86400000) ? "Your new plan turns on as soon as we confirm the payment (usually within the day)." : "Your new plan turns on <b>right away</b> while we check the payment (up to 3 days). If the payment isn't found, it goes back to your previous plan."}</p>
    </div>

    <div class="tile" style="margin-top:16px"><h3>Payment history</h3><div id="payList" class="small muted">Loading…</div></div>`;

  // usage
  (async () => {
    const cnt = async (col, w) => { try { return (await getCountFromServer(w ? query(collection(db, "stores", storeId, col), w) : collection(db, "stores", storeId, col))).data().count; } catch { return "?"; } };
    const rows = [];
    if (mode === "stay") rows.push(["Rooms", await cnt("rooms"), lim.rooms]);
    else rows.push([labels.items, await cnt("items"), lim.items]);
    if (mode === "table") rows.push(["Tables", await cnt("tables", where("isRoom", "!=", true)), lim.tables]);
    rows.push(["Staff", await cnt("staff", where("active", "==", true)), lim.staff]);
    const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10), mon = day.slice(0, 7);
    const st = (await getDoc(doc(db, "stores", storeId, "stats", "usage")).catch(() => null))?.data() || {};
    const [ch, cm] = String(store.settings?.businessDayCutoff || "00:00").split(":").map(Number);
    const dk = new Date(Date.now() + 8 * 3600e3 - ((ch || 0) * 60 + (cm || 0)) * 60000).toISOString().slice(0, 10);
    const todayN = st.day === dk ? Math.max(0, (st.orders || 0) - (st.cancelledDay === dk ? st.cancelled || 0 : 0)) : 0;
    if (lim.ordersPerDay < UNLIMITED) rows.push(["Orders today", todayN, lim.ordersPerDay]);
    if (lim.jobsPerDay < UNLIMITED) rows.push(["Jobs today", todayN, lim.jobsPerDay]);
    if (lim.bookingsPerMonth < UNLIMITED) rows.push(["Bookings this month", st.month === mon ? st.bookings || 0 : 0, lim.bookingsPerMonth]);
    root.querySelector("[data-usage]").innerHTML = rows.map(([n, u, m]) => `<div class="usage-row"><span>${esc(n)}</span><b>${u} / ${fmtLim(m)}</b><i style="--p:${m >= UNLIMITED || u === "?" ? 0 : Math.min(100, Math.round((u / Math.max(1, m)) * 100))}%"></i></div>`).join("");
  })();

  // how to pay (TapTayo's own GCash — edited by the admin, stored in config/payment)
  getDoc(doc(db, "config", "payment")).then((d) => {
    const P = d.data() || {};
    // the QR alone is enough (GCash shows a masked name when they scan) — number and name are optional
    root.querySelector("[data-how]").innerHTML = P.gcashNumber || P.qrUrl ? `<div class="pay-card">${P.qrUrl ? `<img src="${esc(P.qrUrl)}" alt="GCash QR"/>` : ""}<div><b>${P.gcashNumber ? `Send to GCash ${esc(P.gcashNumber)}` : "Scan with GCash (or any bank app via InstaPay)"}</b><div class="small muted">${[P.gcashName ? esc(P.gcashName) : "", P.qrUrl ? "Save the QR, then GCash → Pay QR → Upload from gallery" : "", P.bankNote ? `or ${esc(P.bankNote)}` : ""].filter(Boolean).join(" · ")}</div><div class="small muted">${P.contact ? `Questions: ${esc(P.contact)}` : ""}</div>${P.qrUrl ? `<a class="btn ghost sm" href="${esc(P.qrUrl)}" download="taptayo-gcash-qr.png" style="margin-top:6px">⬇ Save QR</a>` : ""}</div></div>` : `<p class="small muted">Payment details aren't set up yet — message TapTayo.</p>`;
  }).catch(() => (root.querySelector("[data-how]").innerHTML = ""));

  // total
  const g = (n) => root.querySelector(`[name=${n}]`);
  const picked = () => { const out = {}; root.querySelectorAll("[data-q]").forEach((i) => { const v = Math.max(0, Math.min(10, Number(i.value) || 0)); if (v) out[i.dataset.q] = v; }); root.querySelectorAll("[data-c]").forEach((c) => { if (c.checked) out[c.dataset.c] = 1; }); return out; };
  const total = () => { const p = g("plan").value === "none" ? 0 : PLANS[g("plan").value]?.price || 0; const a = Object.entries(picked()).reduce((x, [k, q]) => x + ADDONS[k].price * q, 0); const m = Number(g("months").value); return (p + a) * (m === 12 ? 10 : m); };
  const upd = () => {
    root.querySelector("#payTotal").textContent = money(total());
    const tier = g("plan").value === "none" ? 0 : PLANS[g("plan").value].tier;
    const bad = Object.keys(picked()).filter((k) => (ADDONS[k].minTier || 0) > tier);
    const dup = Object.keys(picked()).filter((k) => packFor(k) && picked()[packFor(k)]);
    root.querySelector("[data-addonnote]").textContent = dup.length ? `${dup.map((k) => ADDONS[k].name).join(", ")} ${dup.length > 1 ? "are" : "is"} already in the ${ADDONS[packFor(dup[0])].name} — untick ${dup.length > 1 ? "them" : "it"} to save.` : bad.length ? `${bad.map((k) => ADDONS[k].name).join(", ")} need${bad.length > 1 ? "" : "s"} the ${PLANS[TIER_COLS[Math.max(...bad.map((k) => ADDONS[k].minTier))]].name} plan or higher.` : "";
  };
  root.querySelectorAll("select, [data-q], [data-c]").forEach((e) => (e.oninput = e.onchange = upd)); upd();
  root.querySelector("#submitPay").onclick = async (e) => {
    const btn = e.target; if (!total()) return toast("Pick a plan or an add-on", "error");
    const f = g("proof").files?.[0]; const refNo = g("refNo").value.trim();
    if (!f && refNo.length < 4) return toast("Add the reference no. or a screenshot of your payment", "error");
    btn.disabled = true; btn.textContent = "Submitting…";
    try {
      let proofUrl = null; if (f) proofUrl = await uploadPrivateImage(storeId, auth.currentUser.uid, f, { max: 1600, name: "payment" });
      const r = await call("submitPayment", { plan: g("plan").value, months: Number(g("months").value), method: g("method").value, refNo, proofUrl, addons: picked() });
      toast(r.provisional ? "Submitted — your plan is on while we check the payment ✓" : "Submitted! We'll confirm it soon.");
      g("refNo").value = ""; g("proof").value = "";
    } catch (x) { toast(x.message, "error"); }
    btn.disabled = false; btn.textContent = "Submit payment";
  };

  // history
  const unsub = onSnapshot(query(collection(db, "stores", storeId, "payments"), orderBy("createdAt", "desc"), limit(20)), (snap) => {
    const el = root.querySelector("#payList");
    if (snap.empty) return (el.textContent = "No payments yet.");
    el.innerHTML = snap.docs.map((d) => {
      const p = d.data(); const t = p.createdAt?.toDate?.();
      const st = { pending: ["Being checked", "trial"], confirmed: ["Confirmed", "active"], rejected: ["Not found", "locked"], comp: ["🎁 Complimentary", "active"] }[p.status] || [p.status, ""];
      const adds = Array.isArray(p.addons) ? p.addons.map((k) => ADDONS[k]?.name || k) : Object.entries(p.addons || {}).map(([k, q]) => `${ADDONS[k]?.name || k}${q > 1 ? ` ×${q}` : ""}`);
      return `<div class="row between" style="padding:8px 0;border-bottom:1px solid var(--line)"><span>${t ? t.toLocaleDateString("en-PH", { dateStyle: "medium" }) : ""} · ${esc(PLANS[p.plan]?.name || (p.plan === "none" ? "Add-ons" : p.plan))} × ${p.status === "comp" ? `${p.days} days` : `${p.months} mo`}${adds.length ? ` + ${esc(adds.join(", "))}` : ""}${p.refNo ? ` · ref ${esc(p.refNo)}` : ""}${p.note ? ` · <i>${esc(p.note)}</i>` : ""}</span><span><b>${money(p.amount)}</b> <span class="pill ${st[1]}">${st[0]}</span></span></div>`;
    }).join("");
  }, () => {});
  return unsub;
}

function relevant(k, mode) {
  const only = { stations: ["table"], dispatch: ["table"], callstaff: ["table"], reservations: ["table"], waitlist: ["table"], events_vip: ["table"], queuetv: ["table", "laundry"],
    salonteam: ["salon"], salondp: ["salon"], clientcard: ["salon"], packages: ["salon"], retail: ["salon"], salonremind: ["salon"], memberships: ["salon"], referral: ["salon"], birthday: ["salon"], giftcards: ["salon", "table"],
    delivery: ["table", "laundry"], editorder: ["table", "laundry"], duty: ["table"], promos: ["table", "laundry"], vouchers: ["table", "laundry"], themes: ["table", "salon"] };
  return !only[k] || only[k].includes(mode);
}
function relevantAddon(a, mode) {
  if (a.unlocks) return a.unlocks.some((k) => relevant(k, mode));
  if (a.adds?.tables && mode !== "table" && mode !== "stay") return false;
  return true;
}
