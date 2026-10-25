// SUPER ADMIN panel: /admin/ — platform owner only (emails in functions/admins.js)
import { auth, call, db } from "./firebase.js";
import { doc as fsDoc, onSnapshot as fsSnap } from "firebase/firestore";
import { watchMaintenance } from "./maint.js";
watchMaintenance("owner");
import { onAuthStateChanged, signOut } from "firebase/auth";
import { $, esc, html, toast, openModal, closeModal, money } from "./ui.js";
import { PLANS, ADDONS, SELLABLE } from "./plans.js";
import { hydratePrivate } from "./privfiles.js";

let stores = [], filter = "all", search = "";
const fmt = (ms) => (ms ? new Date(ms).toLocaleDateString("en-PH", { dateStyle: "medium" }) : "—");
const daysLeft = (ms) => (ms ? Math.ceil((ms - Date.now()) / 86400000) : null);

onAuthStateChanged(auth, async (user) => {
  if (!user || user.isAnonymous) return location.replace("/login/?next=/admin/");
  let claims = (await user.getIdTokenResult()).claims;
  if (!claims.admin) {
    try { await call("claimAdmin"); claims = (await user.getIdTokenResult(true)).claims; }
    catch (e) {
      $("loading").innerHTML = `<div class="card"><h2>Not an admin</h2><p class="muted"><b>${esc(user.email)}</b> is not listed in <code>functions/admins.js</code>. Add it and redeploy the functions.</p><button class="btn ghost" id="out">Log out</button></div>`;
      $("out").onclick = () => signOut(auth);
      return;
    }
  }
  $("loading").classList.add("hidden");
  $("app").classList.remove("hidden");
  shell(user);
  await load();
});

function shell(user) {
  $("app").innerHTML = `
    <div class="main" style="max-width:1200px;margin:0 auto">
      <header>
        <div><h1>🛠 TapTayo Admin</h1><p class="muted">${esc(user.email)}</p></div>
        <div class="row"><button class="btn ghost sm" id="runCheck" type="button">Run subscription check</button><button class="btn ghost sm" id="reload" type="button">↻ Refresh</button><button class="btn ghost sm" id="out" type="button">Log out</button></div>
      </header>
      <div class="grid" id="stats" style="margin-bottom:16px"></div>
      <div id="support"></div>
      <div id="verifyBox"></div>
      <div id="collabBox"></div>
      <div id="trustBox"></div>
      <div id="partnerBox"></div>
      <div id="pending"></div>
      <div id="feedback"></div>
      <div class="tile" id="demoTile" style="margin-top:14px"><div class="row between wrap" style="gap:8px"><div><h3 style="margin:0">🧪 Demo stores</h3><p class="small muted" style="margin:4px 0 0">Live sample shops with photos and sample orders, for your homepage and ads. Visitors can order — nothing is charged and their pretend orders clear every 3 hours. Sample data refreshes daily at 4 AM.</p></div><button class="btn sm" type="button" data-seed>Create / refresh demo stores</button></div>
        <div class="row wrap" style="gap:8px;margin-top:10px">${[["taptayo-cafe", "☕ TapTayo Café"], ["taptayo-salon", "💇 TapTayo Salon"], ["taptayo-spa", "💆 TapTayo Spa"], ["taptayo-studio", "🎨 TapTayo Studio"], ["taptayo-creator", "🎥 Kain Tayo with Bea"], ["taptayo-ugc", "📸 Mika Makes UGC"], ["taptayo-laundry", "🧺 TapTayo Laundry"], ["taptayo-airbnb", "🏡 TapTayo Airbnb"]].map(([sl, n]) => `<a class="btn ghost sm" href="/m/${sl}" target="_blank" rel="noopener">${n} ↗</a>`).join("")}</div><div data-seedout class="small muted" style="margin-top:8px"></div></div>
      <details class="tile" id="adminSettings" style="margin-top:14px"><summary style="cursor:pointer;font-weight:600">⚙️ Settings — your GCash details & payment alerts</summary><div data-set class="small muted" style="margin-top:10px">Loading…</div></details>
      <div class="row between wrap" style="margin:16px 0 10px">
        <div class="tabs" style="margin:0;flex:1;max-width:620px">
          ${["all", "trial", "active", "past_due", "locked"].map((k) => `<button data-f="${k}" class="${k === "all" ? "active" : ""}">${k.replace("_", " ")}</button>`).join("")}
        </div>
        <input id="search" placeholder="Search name / slug / email" style="max-width:280px" />
      </div>
      <div class="tile" style="padding:0;overflow:auto"><table class="tbl" id="tbl"></table></div>
    </div>`;
  $("out").onclick = () => signOut(auth);
  $("reload").onclick = load;
  $("runCheck").onclick = async () => { try { const r = await call("runSubscriptionCheckNow"); toast(`Checked ${r.checked} · locked ${r.locked} · past due ${r.pastDue}`); load(); } catch (e) { toast(e.message, "error"); } };
  $("app").querySelectorAll("[data-f]").forEach((b) => (b.onclick = () => { filter = b.dataset.f; $("app").querySelectorAll("[data-f]").forEach((x) => x.classList.toggle("active", x === b)); draw(); }));
  $("search").oninput = (e) => { search = e.target.value.toLowerCase(); draw(); };
}

async function load() {
  try { stores = await call("adminListStores"); draw(); }
  catch (e) { toast(e.message, "error"); }
  loadFeedback(); loadSettings(); loadSupport(); loadVerify(); loadCollabAdmin(); loadTrust(); loadPartners();
  const sb = document.querySelector("[data-seed]"); if (sb) sb.onclick = async () => {
    if (!confirm("Create or refresh the 4 demo stores? Their sample data is rebuilt (pretend orders are removed).")) return;
    sb.disabled = true; sb.textContent = "Working… (about a minute)"; const out = document.querySelector("[data-seedout]");
    try { const r = await call("adminSeedDemos", {}, { timeout: 300000 }); out.innerHTML = r.demos.map((d) => d.error ? `❌ ${esc(d.slug)}: ${esc(d.error)}` : `✅ /m/${esc(d.slug)}`).join(" · "); }
    catch (e) { out.textContent = e.message; }
    sb.disabled = false; sb.textContent = "Create / refresh demo stores";
  };
}
/** 🛠 Maintenance window: pick a time → every app shows "We'll be right back", new orders pause, it ends on its own */
let maintUnsub = null;
function mountMaint(host) {
  let el = document.getElementById("adminMaint");
  if (!el) { el = document.createElement("div"); el.id = "adminMaint"; el.className = "card"; el.style.cssText = "margin-bottom:14px;padding:14px"; host.parentNode.insertBefore(el, host); }
  const T = (ms) => new Date(ms).toLocaleString("en-PH", { timeZone: "Asia/Manila", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const next2am = () => { const n = new Date(); const ph = new Date(n.getTime() + 8 * 3600000); ph.setUTCHours(2, 0, 0, 0); let ms = ph.getTime() - 8 * 3600000; if (ms < Date.now() + 5 * 60000) ms += 86400000; return ms; };
  const local = (ms) => { const d = new Date(ms + 8 * 3600000); return d.toISOString().slice(0, 16); };
  const draw = (m) => {
    const now = Date.now(), on = m && m.start <= now && now < m.end, soon = m && m.start > now;
    el.innerHTML = `<b>🛠 Maintenance window</b> <span class="muted small">— apps show "We'll be right back", new orders &amp; bookings pause, status pages keep working, staff screens go view-only. Owners see a banner 24 h before. Ends on its own.</span>
      <div style="margin:8px 0;font-weight:700;color:${on ? "var(--danger)" : soon ? "var(--new)" : "inherit"}">${on ? `🔴 ON now · until ${T(m.end)}` : soon ? `🗓 Scheduled ${T(m.start)} → ${T(m.end)}` : "No maintenance scheduled."}</div>
      <div class="form2"><div><label>Start (PH time)</label><input type="datetime-local" data-mst value="${local(soon ? m.start : next2am())}"/></div>
      <div><label>How long</label><select data-mmin>${[15, 30, 45, 60, 90, 120].map((x) => `<option value="${x}" ${x === (m?.minutes || 60) ? "selected" : ""}>${x} min</option>`).join("")}</select></div>
      <div class="span2"><label>Message (optional)</label><input data-mmsg maxlength="200" value="${esc(m?.message || "")}" placeholder="e.g. New features coming — salamat sa paghintay!"/></div></div>
      <div class="row wrap" style="gap:8px;margin-top:8px"><button class="btn sm" data-mset>Schedule</button><button class="btn sm ghost" data-mnow>Start now</button>${on || soon ? `<button class="btn sm danger" data-mend>${on ? "End now" : "Cancel"}</button>` : ""}</div>`;
    const go = async (body, msg) => { try { await call("adminMaintenance", body); toast(msg); } catch (e) { toast(e.message, "error"); } };
    const startMs = () => new Date(el.querySelector("[data-mst]").value + ":00+08:00").getTime();
    const base = () => ({ minutes: Number(el.querySelector("[data-mmin]").value), message: el.querySelector("[data-mmsg]").value.trim() });
    el.querySelector("[data-mset]").onclick = () => go({ action: "set", start: startMs(), ...base() }, "Scheduled — owners get a banner 24 h before");
    el.querySelector("[data-mnow]").onclick = () => { if (confirm("Start maintenance NOW? Customers can't order or book until it ends.")) go({ action: "now", ...base() }, "Maintenance is ON"); };
    el.querySelector("[data-mend]")?.addEventListener("click", () => go({ action: "end" }, "Maintenance ended"));
  };
  maintUnsub?.(); maintUnsub = fsSnap(fsDoc(db, "config", "maintenance"), (x) => draw(x.data() || null), () => draw(null));
}
async function loadSettings() {
  const box = document.querySelector("#adminSettings [data-set]"); if (!box) return;
  mountMaint(document.getElementById("adminSettings"));
  let c; try { c = await call("adminConfig", {}); } catch (e) { box.textContent = e.message; return; }
  const P = c.payment || {};
  box.innerHTML = `<div class="form2"><div><label>GCash number (owners pay here)</label><input data-k="gcashNumber" value="${esc(P.gcashNumber || "")}" placeholder="0917 123 4567"/></div><div><label>GCash name</label><input data-k="gcashName" value="${esc(P.gcashName || "")}"/></div>
    <div><label>Bank / other (optional)</label><input data-k="bankNote" value="${esc(P.bankNote || "")}" placeholder="BPI 1234-5678-90 (Name)"/></div><div><label>Contact for questions</label><input data-k="contact" value="${esc(P.contact || "")}" placeholder="Messenger: m.me/taptayo"/></div>
    <div class="span2"><label>GCash QR image URL (optional)</label><input data-k="qrUrl" value="${esc(P.qrUrl || "")}" placeholder="https://…"/></div></div>
    <button class="btn sm" data-savepay style="margin-top:8px">Save payment details</button>
    <hr style="margin:14px 0"/><b>Telegram alerts to you</b> <span class="muted">(new payment to check)</span>${c.alerts.botName ? ` · bot @${esc(c.alerts.botName)}` : ""}
    <div class="form2"><div><label>Bot token ${c.alerts.hasToken ? "(saved — leave empty to keep)" : ""}</label><input data-tok placeholder="123456789:AAH…"/></div><div><label>Your chat ID</label><input data-chat value="${esc(c.alerts.chatId || "")}" placeholder="e.g. 123456789"/></div></div>
    <button class="btn sm ghost" data-savetg style="margin-top:8px">Save & send a test</button>
    <hr style="margin:14px 0"/><b>Signup SMS code (Semaphore)</b> <span class="muted">— new owners confirm their mobile number; one free trial per real number</span>${(c.sms || {}).hasKey ? ` · ${esc((c.sms || {}).account || "connected")}${(c.sms || {}).balance != null ? ` · <b>${esc(String((c.sms || {}).balance))} credits</b>` : ""}` : ""}
    <div class="form2"><div><label>Semaphore API key ${(c.sms || {}).hasKey ? "(saved — leave empty to keep)" : ""}</label><input data-smskey placeholder="semaphore.co → Account → API"/></div><div><label>Sender name (optional, approved in Semaphore)</label><input data-smssender maxlength="11" value="${esc((c.sms || {}).senderName || "")}" placeholder="TAPTAYO"/></div></div>
    <label class="check"><input type="checkbox" data-smsreq ${(c.sms || {}).required ? "checked" : ""}/> Require the SMS code at signup</label>
    <button class="btn sm ghost" data-savesms style="margin-top:8px">Save SMS settings</button>`;
  box.querySelector("[data-savepay]").onclick = async () => { const payment = {}; box.querySelectorAll("[data-k]").forEach((i) => (payment[i.dataset.k] = i.value.trim())); try { await call("adminConfig", { payment }); toast("Saved — owners see it on their Billing page"); } catch (e) { toast(e.message, "error"); } };
  box.querySelector("[data-savesms]").onclick = async () => { try { await call("adminConfig", { sms: { apiKey: box.querySelector("[data-smskey]").value.trim(), senderName: box.querySelector("[data-smssender]").value.trim(), required: box.querySelector("[data-smsreq]").checked } }); toast("Saved"); loadSettings(); } catch (e) { toast(e.message, "error"); } };
  box.querySelector("[data-savetg]").onclick = async () => { try { await call("adminConfig", { alerts: { botToken: box.querySelector("[data-tok]").value.trim(), chatId: box.querySelector("[data-chat]").value.trim(), test: true } }); toast("Saved — check Telegram"); } catch (e) { toast(e.message, "error"); } };
}

// 💬 Feedback & suggestions from owners / staff
let fb = { items: [] }, fbFilter = "open";
async function loadFeedback() {
  try { fb = await call("adminFeedback", {}); drawFeedback(); } catch (e) { $("feedback").innerHTML = `<div class="tile"><p class="muted">Feedback: ${esc(e.message)}</p></div>`; }
}
function drawFeedback() {
  const KIND = { suggestion: "💡", bug: "🐞", praise: "❤️", rating: "⭐" };
  const list = fb.items.filter((x) => x.text && (fbFilter === "all" || (fbFilter === "open" ? ["new", "planned"].includes(x.status) : x.status === fbFilter)));
  const newCount = fb.items.filter((x) => x.text && x.status === "new").length;
  $("feedback").innerHTML = `<div class="tile" style="margin-top:14px"><div class="row between wrap"><h3 style="margin:0">💬 Feedback & suggestions ${newCount ? `<span class="pill trial">${newCount} new</span>` : ""}</h3>
    <span class="small muted">NPS ${fb.nps == null ? "—" : `<b>${fb.nps}</b>`} (${fb.count || 0} scores)</span></div>
    <div class="tabs" style="margin:10px 0">${[["open", "Open"], ["new", "New"], ["planned", "Planned"], ["done", "Done"], ["all", "All"]].map(([k, l]) => `<button data-ff="${k}" class="${fbFilter === k ? "active" : ""}">${l}</button>`).join("")}</div>
    ${list.length ? list.map((x) => `<div style="border-top:1px solid var(--line);padding:10px 0"><div class="row between wrap"><span><b>${KIND[x.kind] || "💬"} ${esc(x.storeName || "")}</b> <span class="muted small">${esc(x.mode)} · ${esc(x.role === "owner" ? "owner" : x.staffName || x.role || "")} · ${esc(x.email || "")} · ${new Date(x.atMs).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" })}${x.score != null ? ` · score <b>${x.score}</b>` : ""}${x.version ? ` · v${esc(x.version)}` : ""}</span></span>
      <span class="row" style="gap:6px"><select data-fs="${x.id}">${[["new", "New"], ["planned", "Planned"], ["done", "Done ✓"], ["wontdo", "Won't do"]].map(([k, l]) => `<option value="${k}" ${x.status === k ? "selected" : ""}>${l}</option>`).join("")}</select><button class="btn ghost sm" data-fr="${x.id}">Reply</button></span></div>
      <div style="margin-top:4px;white-space:pre-wrap">${esc(x.text)}</div>${x.reply ? `<div class="small" style="margin-top:4px;background:var(--bg);border-radius:8px;padding:6px 8px">↪ ${esc(x.reply)}</div>` : ""}</div>`).join("") : `<p class="muted small">Nothing here.</p>`}</div>`;
  $("feedback").querySelectorAll("[data-ff]").forEach((b) => (b.onclick = () => { fbFilter = b.dataset.ff; drawFeedback(); }));
  $("feedback").querySelectorAll("[data-fs]").forEach((sel) => (sel.onchange = async () => { try { await call("adminFeedback", { id: sel.dataset.fs, status: sel.value }); const it = fb.items.find((x) => x.id === sel.dataset.fs); if (it) it.status = sel.value; toast("Saved"); drawFeedback(); } catch (e) { toast(e.message, "error"); } }));
  $("feedback").querySelectorAll("[data-fr]").forEach((b) => (b.onclick = async () => { const it = fb.items.find((x) => x.id === b.dataset.fr); const r = prompt("Reply (the owner sees it in Feedback & suggestions):", it?.reply || ""); if (r == null) return; try { await call("adminFeedback", { id: b.dataset.fr, reply: r }); it.reply = r; toast("Reply saved"); drawFeedback(); } catch (e) { toast(e.message, "error"); } }));
}

function draw() {
  // stats
  const by = (st) => stores.filter((s) => s.sub.status === st).length;
  const mrr = stores.filter((s) => s.sub.status === "active" && !s.sub.comp && !s.sub.mirrored).reduce((a, s) => a + (PLANS[s.sub.plan]?.price || 0) + Object.keys(s.sub.addons || {}).filter((k) => s.sub.addons[k]).reduce((x, k) => x + (ADDONS[k]?.price || 0), 0), 0);
  $("stats").innerHTML = [["Stores", stores.length], ["Trial", by("trial")], ["Paying", stores.filter((s) => s.sub?.status === "active" && !["free", "trial"].includes(s.sub?.plan) && !s.sub?.comp && !s.demo).length], ["Free plan", stores.filter((s) => s.sub?.plan === "free").length], ["Past due", by("past_due")], ["MRR", money(mrr)]]
    .map(([k, v]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("");

  // pending payments
  const pend = stores.flatMap((s) => s.pendingPayments.map((p) => ({ ...p, store: s })));
  $("pending").innerHTML = pend.length ? `<div class="tile" style="border-left:5px solid var(--warn)"><h3>💰 Pending payments (${pend.length})</h3>
    ${pend.map((p) => `<div class="row between wrap" style="padding:8px 0;border-bottom:1px solid var(--line)">
      <span><b>${esc(p.store.name)}</b> <span class="muted small">${esc(p.store.ownerEmail || "")}</span><br><span class="small">${esc(PLANS[p.plan]?.name || p.plan)} × ${p.months} mo${(() => { const a = Array.isArray(p.addons) ? p.addons.map((k) => ADDONS[k]?.name || k) : Object.entries(p.addons || {}).map(([k, q]) => `${ADDONS[k]?.name || k}${q > 1 ? " ×" + q : ""}`); return a.length ? ` + ${esc(a.join(", "))}` : ""; })()} · <b>${money(p.amount)}</b> · ${esc(p.method || "gcash")} ref <code>${esc(p.refNo)}</code> · ${fmt(p.createdAt)}</span></span>
      <span class="row">${p.proofUrl ? `<a class="btn ghost sm" data-priv="${esc(p.proofUrl)}">🧾 Screenshot</a>` : ""}${p.provisional ? `<span class="pill trial" title="The plan is already on for up to 3 days while you check">Active while checking</span>` : ""}<button class="btn sm" data-ok="${p.store.id}" data-pid="${p.id}">✅ Confirm & activate</button><button class="btn ghost sm danger-text" data-rej="${p.store.id}" data-pid="${p.id}">Reject</button></span>
    </div>`).join("")}</div>` : "";
  hydratePrivate($("pending"));
  $("pending").querySelectorAll("[data-ok]").forEach((b) => (b.onclick = () => { const p = pend.find((x) => x.id === b.dataset.pid); return activate(b.dataset.ok, { plan: p?.plan === "none" ? "none" : p?.plan, months: p?.months, amount: p?.amount, refNo: p?.refNo, addons: Array.isArray(p?.addons) ? Object.fromEntries(p.addons.map((k) => [k, 1])) : p?.addons || {} }); }));
  $("pending").querySelectorAll("[data-rej]").forEach((b) => (b.onclick = async () => {
    const note = prompt("Reason (visible to the owner):", "Payment not found. Please send a screenshot.");
    if (note === null) return;
    await call("adminUpdateSubscription", { storeId: b.dataset.rej, action: "rejectPayment", paymentId: b.dataset.pid, note }); toast("Rejected"); load();
  }));

  // table
  const rows = stores
    .filter((s) => filter === "all" || s.sub.status === filter)
    .filter((s) => !search || [s.name, s.slug, s.ownerEmail, s.phone].join(" ").toLowerCase().includes(search))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  $("tbl").innerHTML = `<thead><tr><th>Store</th><th>Owner</th><th>Type</th><th>Plan</th><th>Status</th><th>Until</th><th>Created</th><th></th></tr></thead><tbody>
    ${rows.map((s) => {
      const until = (s.sub.plan || "trial") === "trial" ? s.sub.trialEndsAt : s.sub.paidUntil;
      const dl = daysLeft(until);
      return `<tr>
        <td><b>${esc(s.name)}</b>${s.demo ? ` <span class="pill trial">demo</span>` : ""}<br><a class="small" href="/m/${esc(s.slug)}" target="_blank">/m/${esc(s.slug)}</a></td>
        <td class="small">${esc(s.ownerEmail || "—")}<br><span class="muted">${esc(s.phone || "")}</span></td>
        <td>${esc(s.businessType)}</td>
        <td>${s.org && !s.org.isMain ? `<span class="small muted">↳ branch of ${esc(s.org.name)}</span><br>` : s.org && s.org.branches > 1 ? `<span class="small muted">🏬 ${s.org.branches} branches</span><br>` : ""}${s.sub.comp ? "🎁 " : ""}${esc(PLANS[s.sub.plan]?.name || s.sub.plan || "—")}${s.sub.comp && s.sub.compNote ? ` <span class="small muted">(${esc(s.sub.compNote)})</span>` : ""}${Object.keys(s.sub.addons || {}).filter((k) => s.sub.addons[k]).length ? `<br><span class="small muted">+ ${Object.keys(s.sub.addons).filter((k) => s.sub.addons[k]).map((k) => ADDONS[k]?.name || k).join(", ")}</span>` : ""}</td>
        <td><span class="pill ${esc(s.sub.status)}">${esc(s.sub.status || "—")}</span></td>
        <td class="small">${fmt(until)}${dl != null ? `<br><span class="${dl < 0 ? "danger-text" : "muted"}">${dl >= 0 ? dl + "d left" : -dl + "d ago"}</span>` : ""}</td>
        <td class="small muted">${fmt(s.createdAt)}</td>
        <td><div class="row" style="gap:4px;flex-wrap:wrap">
          <button class="btn sm" data-act="${s.id}">Activate</button>
          <button class="btn ghost sm" data-ext="${s.id}">+Trial</button>
          ${s.sub.status === "locked" ? `<button class="btn ghost sm" data-unlock="${s.id}">Unlock</button>` : `<button class="btn ghost sm danger-text" data-lock="${s.id}">Lock</button>`}
        </div></td></tr>`;
    }).join("") || `<tr><td colspan="8" class="muted" style="padding:20px">No stores.</td></tr>`}</tbody>`;
  $("tbl").querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => activate(b.dataset.act)));
  $("tbl").querySelectorAll("[data-ext]").forEach((b) => (b.onclick = async () => { const d = prompt("Extend trial by how many days?", "7"); if (!d) return; await call("adminUpdateSubscription", { storeId: b.dataset.ext, action: "extendTrial", days: Number(d) }); toast("Trial extended"); load(); }));
  $("tbl").querySelectorAll("[data-lock]").forEach((b) => (b.onclick = async () => { if (!confirm("Lock this store? Customers will not be able to order.")) return; await call("adminUpdateSubscription", { storeId: b.dataset.lock, action: "lock" }); toast("Locked"); load(); }));
  $("tbl").querySelectorAll("[data-unlock]").forEach((b) => (b.onclick = async () => { await call("adminUpdateSubscription", { storeId: b.dataset.unlock, action: "unlock" }); toast("Unlocked"); load(); }));
}

function activate(storeId, pre = {}) {
  const s = stores.find((x) => x.id === storeId);
  const body = html(`<div>
    <p class="muted small">${esc(s?.name)} · ${esc(s?.ownerEmail || "")}</p>
    <label>Plan</label><select name="plan">${[...SELLABLE, "creator", "none"].map((k) => `<option value="${k}" ${(pre.plan || "starter") === k ? "selected" : ""}>${k === "none" ? "Add-ons only (Free plan)" : `${esc(PLANS[k].name)} — ${money(PLANS[k].price)}/mo`}</option>`).join("")}</select>
    <label class="check"><input type="checkbox" name="comp" ${pre.comp ? "checked" : ""}/> 🎁 Free / complimentary (no payment, custom number of days)</label>
    <div data-paid><label>Months</label><input name="months" type="number" min="1" max="12" value="${pre.months || 1}" /></div>
    <div data-comp style="display:none"><label>Days of free access</label><input name="days" type="number" min="1" max="3650" value="30" /><label>Note (e.g. beta tester, friend)</label><input name="note" placeholder="optional" /></div>
    <label>Add-ons</label><div class="row wrap" style="gap:6px 14px">${Object.entries(ADDONS).filter(([, a]) => !a.legacy).map(([k, a]) => { const q = Number((pre.addons || {})[k] || 0); return a.qty ? `<label class="small" style="display:flex;gap:6px;align-items:center">${esc(a.name)} <input type="number" min="0" max="10" value="${q}" data-aq="${k}" style="width:64px"/></label>` : `<label class="check small" style="margin:0"><input type="checkbox" data-ac="${k}" ${q ? "checked" : ""}/> ${esc(a.name)}</label>`; }).join("")}</div>
    <label>Amount received (₱)</label><input name="amount" type="number" min="0" value="${pre.amount ?? ""}" placeholder="auto = (plan + add-ons) × months" />
    <label>Reference / note</label><input name="refNo" value="${esc(pre.refNo || "")}" placeholder="GCash ref no." />
    <p class="small muted" style="margin-top:10px">Months are added to the end of the current paid-until date (if still active), otherwise from today.</p>
  </div>`);
  const foot = html(`<div class="row" style="justify-content:flex-end"><button class="btn ghost" data-no>Cancel</button><button class="btn" data-yes>Activate</button></div>`);
  foot.querySelector("[data-no]").onclick = closeModal;
  foot.querySelector("[data-yes]").onclick = async () => {
    const g = (n) => body.querySelector(`[name=${n}]`).value;
    foot.querySelector("[data-yes]").disabled = true;
    try {
      const addons = {}; body.querySelectorAll("[data-aq]").forEach((i) => { if (Number(i.value) > 0) addons[i.dataset.aq] = Number(i.value); }); body.querySelectorAll("[data-ac]").forEach((c) => { if (c.checked) addons[c.dataset.ac] = 1; });
      if (body.querySelector("[name=comp]").checked) await call("adminUpdateSubscription", { storeId, action: "comp", plan: g("plan"), days: Number(g("days")), note: g("note"), addons });
      else await call("adminUpdateSubscription", { storeId, action: "activate", plan: g("plan") === "none" ? "free" : g("plan"), months: Number(g("months")), amount: g("amount") ? Number(g("amount")) : null, refNo: g("refNo"), addons });
      closeModal(); toast("Activated ✓"); load();
    } catch (e) { toast(e.message, "error"); foot.querySelector("[data-yes]").disabled = false; }
  };
  const compCb = body.querySelector("[name=comp]"); const toggComp = () => { const c = compCb.checked; body.querySelector("[data-paid]").style.display = c ? "none" : ""; body.querySelector("[data-comp]").style.display = c ? "" : "none"; }; compCb.onchange = toggComp; toggComp();
  openModal({ title: "Activate subscription", body, footer: foot });
}

// 🤝 Collab launch switch + 🛡 Protect claims
// 🛡 Trust & safety: documents to check (DTI / BIR / owner ID), shop reports, and the valid-ID counter (NPC registration at 1,000+)
async function loadTrust() {
  const box = document.getElementById("trustBox"); if (!box) return;
  try {
    const t = await call("adminTrust", {});
    const KIND = { dti: "DTI certificate", bir: "BIR 2303", permit: "Business / Mayor's permit", ownerId: "Owner's valid ID" };
    box.innerHTML = `<div class="tile" style="margin-bottom:14px"><h3 style="margin:0 0 6px">🛡 Trust & safety</h3>
      <p class="small">💾 Weekly backup: ${t.backup?.lastAt ? `${t.backup.ok ? "✅" : "⚠️ failed —"} ${new Date(t.backup.lastAt).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" })}${t.backup.ok ? "" : ` (${esc(t.backup.error || "")})`}` : "not run yet (runs Sundays 3 AM — see deploy notes)"}</p>
      <p class="small">🪪 Valid IDs on file (all shops, approx.): <b>${t.idUploads}</b>${t.idUploads >= 800 ? ` <span class="tag" style="background:#dc2626;color:#fff">${t.idUploads >= 1000 ? "Register with the NPC now" : "Close to 1,000 — prepare NPC registration"}</span>` : " · NPC registration needed at 1,000+"}</p>
      <h4 style="margin:12px 0 4px">Documents to check ${t.toCheck.length ? `<span class="tag" style="background:#dc2626;color:#fff">${t.toCheck.length}</span>` : ""}</h4>
      <p class="small muted" style="margin:0 0 4px">Check: is the name the same as the shop / owner? Not edited, not expired, readable? If unsure, ask for another proof. Goal: decide within 3 days.</p>
      ${t.toCheck.map((x) => { const days = x.sentAt ? Math.floor((Date.now() - x.sentAt) / 864e5) : 0; return `<div style="border-top:1px solid var(--line);padding:6px 0" class="small"><b>${esc(x.name)}</b>${x.creator ? ` <span class="tag">creator</span>` : ""} · ${KIND[x.kind] || x.kind}${x.number ? ` · no. ${esc(x.number)}` : ""}${x.round > 1 ? ` · <b>extra proof (round ${x.round})</b>` : ""} · <span class="${days >= 3 ? "" : "muted"}" ${days >= 3 ? 'style="color:#dc2626;font-weight:700"' : ""}>${days ? `${days} day${days > 1 ? "s" : ""} waiting${days >= 3 ? " — overdue" : ""}` : "today"}</span>${x.reason === "renamed" ? `<div style="color:#b45309">✏️ Shop renamed from “${esc(x.oldName || "")}” — does the document still match the new name?</div>` : ""}${x.expires ? `<div>📅 Valid until <b>${esc(x.expires)}</b> — check it matches the permit</div>` : ""}${x.kind !== "ownerId" ? `<div class="muted">Name to match: <b>${esc(x.name)}</b>${x.ownerName ? ` or owner <b>${esc(x.ownerName)}</b>` : ""}</div>` : ""}${x.ownerNote ? `<div>💬 Owner: ${esc(x.ownerNote)}</div>` : ""}${x.payName ? `<div class="muted">Payment account names: ${esc(x.payName)} — should match the business or the owner</div>` : ""}<div class="row wrap" style="gap:6px;margin-top:4px">${(x.urls || (x.url ? [x.url] : [])).map((u, i, a) => u ? `<a class="btn sm ghost" href="${esc(u)}" target="_blank" rel="noopener">View${a.length > 1 ? ` proof ${i + 1}` : ""} (15 min)</a>` : "").join("")}<button class="btn sm" data-va="approve:${x.storeId}:${x.kind}">Approve</button><button class="btn sm ghost" data-va="more:${x.storeId}:${x.kind}">📎 Ask for another proof</button><button class="btn sm ghost" data-va="reject:${x.storeId}:${x.kind}">Reject</button></div></div>`; }).join("") || `<p class="small muted">Nothing to check.</p>`}
      <h4 style="margin:12px 0 4px">⚑ Shop reports ${t.reports.length ? `<span class="tag" style="background:#dc2626;color:#fff">${t.reports.length}</span>` : ""}</h4>
      ${t.reports.map((r) => `<div style="border-top:1px solid var(--line);padding:6px 0" class="small"><b>${esc(r.storeName)}</b> (<a href="/m/${esc(r.slug)}" target="_blank" rel="noopener">/m/${esc(r.slug)}</a>) · ${esc(r.reason)}<div>${esc(r.details)}</div>${r.contact ? `<div class="muted">Contact: ${esc(r.contact)}</div>` : ""}<div class="row" style="gap:6px;margin-top:4px"><button class="btn sm" data-rp="resolve:${r.id}">Resolved</button><button class="btn sm ghost" data-rp="dismiss:${r.id}">Dismiss</button></div></div>`).join("") || `<p class="small muted">No open reports.</p>`}</div>`;
    box.querySelectorAll("[data-va]").forEach((b) => (b.onclick = async () => { const [action, storeId, kind] = b.dataset.va.split(":"); const note = action === "reject" ? prompt("Why? (the owner sees this)", "The name on the document doesn't match the shop.") : action === "more" ? prompt("What should they send? (the owner sees this)", "The photo is blurry — please send a clear photo of the whole document.") : ""; if (note === null) return; let nameOk = false; if (action === "approve" && kind !== "ownerId") { nameOk = confirm("Does the name on the document match the shop name or the owner's name? (OK = yes, matches)"); if (!nameOk) return toast("Not approved — use “Ask for another proof” or Reject"); } await call("adminTrust", { verif: true, action, storeId, kind, note, nameOk }); toast(action === "more" ? "Asked for another proof" : action === "approve" ? "Approved — badge is live" : "Rejected"); loadTrust(); }));
    box.querySelectorAll("[data-rp]").forEach((b) => (b.onclick = async () => { const [action, report] = b.dataset.rp.split(":"); const note = prompt("Note (optional):", "") ?? ""; await call("adminTrust", { report, action, note }); loadTrust(); }));
  } catch (e) { box.innerHTML = `<p class="muted small">Trust: ${esc(e.message)}</p>`; }
}

async function loadPartners() {
  const box = document.getElementById("partnerBox"); if (!box) return;
  try {
    const list = await call("adminPartners", {});
    if (!list.length) { box.innerHTML = ""; return; }
    box.innerHTML = `<div class="tile" style="margin-bottom:14px"><h3 style="margin:0 0 6px">🤝 Partners & investors ${list.some((x) => x.status === "new") ? `<span class="tag" style="background:#dc2626;color:#fff">${list.filter((x) => x.status === "new").length} new</span>` : ""}</h3>
      ${list.map((x) => `<div style="border-top:1px solid var(--line);padding:8px 0" class="small"><b>${esc(x.name)}</b>${x.org ? ` · ${esc(x.org)}` : ""} · <span class="tag">${esc(x.kindLabel)}</span> · <span class="muted">${new Date(x.createdAt).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" })}</span>${x.status !== "new" ? ` · <span class="muted">${esc(x.status)}</span>` : ""}
        <div style="white-space:pre-wrap;margin:4px 0">${esc(x.message)}</div><div>📇 ${esc(x.contact)}</div>${x.note ? `<div class="muted">Note: ${esc(x.note)}</div>` : ""}
        <div class="row" style="gap:6px;margin-top:4px">${x.status === "new" ? `<button class="btn sm" data-pl="replied:${x.id}">✓ Replied</button>` : ""}<button class="btn ghost sm" data-pl="closed:${x.id}">Close</button></div></div>`).join("")}</div>`;
    box.querySelectorAll("[data-pl]").forEach((b) => (b.onclick = async () => { const [status, id] = b.dataset.pl.split(":"); const note = prompt("Note (optional):", "") ?? ""; await call("adminPartners", { id, status, note }); loadPartners(); }));
  } catch (e) { box.innerHTML = `<p class="muted small">Partners: ${esc(e.message)}</p>`; }
}

async function loadCollabAdmin() {
  const box = document.getElementById("collabBox"); if (!box) return;
  try {
    const [c, st, claims, appeals] = await Promise.all([call("adminCollabConfig", {}), call("collabStatus", {}), call("adminProtectClaims", { action: "list" }), call("adminXdealAppeals", {}).catch(() => [])]);
    const open = claims.filter((x) => ["pending", "flagged"].includes(x.status));
    box.innerHTML = `<div class="tile" style="margin-bottom:14px"><div class="row between wrap"><h3 style="margin:0">🤝 TapTayo Collab</h3><span class="pill ${c.live ? "active" : "trial"}">${c.live ? "LIVE" : "Coming soon"}</span></div>
      <p class="small">Creators listed: <b>${st.creators}/${c.target || 100}</b> (${esc(c.city || "Metro Manila")}) · waitlist ${c.waitlist || 0} (${c.waitBusiness || 0} businesses)</p>
      <div class="row wrap" style="gap:6px"><input data-ct type="number" value="${c.target || 100}" style="width:90px"/><button class="btn sm ${c.live ? "ghost" : ""}" data-live="${c.live ? "0" : "1"}">${c.live ? "Switch back to Coming soon" : "🚀 Go live"}</button></div>
      <h4 style="margin:14px 0 4px">🛡 Protect claims ${open.length ? `<span class="tag" style="background:#dc2626;color:#fff">${open.length}</span>` : ""}</h4>
      ${claims.slice(0, 20).map((x) => `<div style="border-top:1px solid var(--line);padding:6px 0" class="small"><b>${esc(x.storeName)}</b> → ${esc(x.creatorName)} · ${esc(x.code)} · ${esc(x.item?.desc || "")} · <b>₱${x.amount}</b> · ${x.status}${x.linked ? " ⚠️ linked accounts" : ""}${x.note ? `<div>${esc(x.note)}</div>` : ""}${["pending", "flagged"].includes(x.status) ? `<div class="row" style="gap:6px;margin-top:4px"><button class="btn sm" data-ca="approve:${x.id}">Approve → credits</button><button class="btn sm ghost" data-ca="reject:${x.id}">Reject</button></div>` : ""}</div>`).join("") || `<p class="small muted">No claims.</p>`}</div>`;
    box.firstElementChild.insertAdjacentHTML("beforeend", `<h4 style="margin:14px 0 4px">⚖️ X-Deal appeals ${appeals.length ? `<span class="tag" style="background:#dc2626;color:#fff">${appeals.length}</span>` : ""}</h4>${appeals.map((x) => `<div style="border-top:1px solid var(--line);padding:6px 0" class="small"><b>${esc(x.bizName)}</b> cancelled ${esc(x.code)} (${esc(x.item?.desc || "")}) → creator <b>${esc(x.creatorName)}</b><div>Business: ${esc(x.reason)}</div><div>Creator: ${esc(x.note)}</div><div class="row" style="gap:6px;margin-top:4px"><button class="btn sm" data-xa="uphold:${x.id}">Uphold (creator was right)</button><button class="btn sm ghost" data-xa="reject:${x.id}">Reject</button></div></div>`).join("") || `<p class="small muted">No open appeals.</p>`}`);
    box.querySelectorAll("[data-xa]").forEach((b) => (b.onclick = async () => { const [decide, id] = b.dataset.xa.split(":"); const note = prompt("Note to the creator (optional):", "") ?? ""; await call("adminXdealAppeals", { id, decide, note }); toast(decide === "uphold" ? "Upheld — trust point returned" : "Rejected"); loadCollabAdmin(); }));
    box.querySelector("[data-live]").onclick = async (e) => { if (!confirm(e.target.dataset.live === "1" ? "Open TapTayo Collab to everyone?" : "Switch Collab back to Coming soon?")) return; await call("adminCollabConfig", { set: true, live: e.target.dataset.live === "1", target: Number(box.querySelector("[data-ct]").value) || 100 }); loadCollabAdmin(); };
    box.querySelectorAll("[data-ca]").forEach((b) => (b.onclick = async () => { const [a, id] = b.dataset.ca.split(":"); const reason = a === "reject" ? prompt("Reason (the business sees this):", "No proof the item was sent.") : ""; if (reason === null) return; await call("adminProtectClaims", { action: a, id, reason }); toast(a === "approve" ? "Credits added" : "Rejected"); loadCollabAdmin(); }));
  } catch (e) { box.innerHTML = `<p class="muted small">Collab: ${esc(e.message)}</p>`; }
}

// ✔️ Creator verification — check the socials + the TAPTAYO-xxxx code in a bio, then give the Verified badge
async function loadVerify() {
  const box = document.getElementById("verifyBox"); if (!box) return;
  try {
    const L = await call("adminCreatorVerify", { action: "list" });
    box.innerHTML = L.length ? `<div class="tile" style="margin-bottom:14px"><h3 style="margin:0 0 6px">✔️ Creator verification (${L.length})</h3>${L.map((x) => `<div style="border-top:1px solid var(--line);padding:8px 0"><b>${esc(x.name)}</b> <a href="/m/${esc(x.slug)}" target="_blank">/m/${esc(x.slug)}</a> · code <b>${esc(x.req.code)}</b><div class="small">${(x.req.platforms || []).map((p) => `<a href="${esc(p.url || "#")}" target="_blank" rel="noopener">${esc(p.platform)} ${esc(p.handle || "")}</a> ${esc(p.followers || "")}`).join(" · ")}</div><div class="row" style="gap:6px;margin-top:6px"><button class="btn sm" data-vok="${x.id}">✔ Verify</button><button class="btn sm ghost" data-vno="${x.id}">Reject</button></div></div>`).join("")}</div>` : "";
    box.querySelectorAll("[data-vok]").forEach((b) => (b.onclick = async () => { await call("adminCreatorVerify", { action: "approve", storeId: b.dataset.vok }); toast("Verified ✔"); loadVerify(); }));
    box.querySelectorAll("[data-vno]").forEach((b) => (b.onclick = async () => { const r = prompt("Reason (the creator sees this):", "We couldn't find the code in your bio."); if (r === null) return; await call("adminCreatorVerify", { action: "reject", storeId: b.dataset.vno, reason: r }); loadVerify(); }));
  } catch (e) { box.innerHTML = `<p class="muted small">Verify: ${esc(e.message)}</p>`; }
}

// 💬 Support inbox — chats from the homepage, dashboards and staff screens (no calls; reply within 24 h)
let sup = { threads: [], saved: [], open: null, filter: "open" };
async function loadSupport() {
  const box = document.getElementById("support"); if (!box) return;
  try { const r = await call("supportAdmin", { action: "list" }); sup.threads = r.threads; sup.saved = r.saved; drawSupport(); }
  catch (e) { box.innerHTML = `<div class="tile"><p class="muted">Support: ${esc(e.message)}</p></div>`; }
}
function drawSupport() {
  const box = document.getElementById("support");
  const T = sup.threads.filter((t) => sup.filter === "all" || (sup.filter === "open" ? t.status !== "closed" : t.status === "closed"));
  const unread = sup.threads.reduce((a, t) => a + (t.unreadAdmin || 0), 0);
  box.innerHTML = `<div class="tile" id="supportTile" style="margin-bottom:14px"><div class="row between wrap" style="gap:8px"><h3 style="margin:0">💬 Support inbox ${unread ? `<span class="tag" style="background:#dc2626;color:#fff">${unread} new</span>` : ""}</h3>
    <div class="row" style="gap:6px">${["open", "closed", "all"].map((f) => `<button class="btn sm ${sup.filter === f ? "" : "ghost"}" data-sf="${f}">${f}</button>`).join("")}<button class="btn sm ghost" data-sr>↻</button></div></div>
    <div class="row wrap" style="gap:14px;align-items:flex-start;margin-top:10px">
      <div style="flex:1 1 280px;max-height:460px;overflow:auto">${T.map((t) => `<button type="button" data-st="${t.id}" style="display:block;width:100%;text-align:left;border:1px solid var(--line,#ddd);border-radius:10px;padding:8px 10px;margin-bottom:6px;background:${sup.open?.thread.id === t.id ? "#f3eef6" : "#fff"};cursor:pointer"><b>${esc(t.storeName || t.name || "Visitor")}</b>${t.mode ? ` <span class="small muted">${esc(t.mode)}</span>` : ""}${t.unreadAdmin ? ` <span class="tag" style="background:#dc2626;color:#fff">${t.unreadAdmin}</span>` : ""}<div class="small muted">${esc(t.lastText || "")}</div><div class="small muted">${t.lastAt ? new Date(t.lastAt).toLocaleString("en-PH", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""} · ${esc(t.status)}${t.lastFrom === "user" && t.status !== "closed" ? ` · <b style="color:#b45309">waiting ${Math.round((Date.now() - t.lastAt) / 3600000)}h</b>` : ""}</div></button>`).join("") || `<p class="muted small">No chats.</p>`}</div>
      <div style="flex:2 1 360px" data-conv>${sup.open ? convHTML() : `<p class="muted small">Pick a chat.</p>`}</div></div></div>`;
  box.querySelectorAll("[data-sf]").forEach((b) => (b.onclick = () => { sup.filter = b.dataset.sf; drawSupport(); }));
  box.querySelector("[data-sr]").onclick = loadSupport;
  box.querySelectorAll("[data-st]").forEach((b) => (b.onclick = async () => { sup.open = await call("supportAdmin", { action: "get", threadId: b.dataset.st }); const t = sup.threads.find((x) => x.id === b.dataset.st); if (t) t.unreadAdmin = 0; drawSupport(); }));
  if (sup.open) bindConv(box);
}
function convHTML() {
  const { thread: t, messages: M, sub } = sup.open;
  const d = (ms) => (ms ? new Date(ms).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" }) : "—");
  return `<div class="small" style="background:#faf7fc;border-radius:10px;padding:8px 10px;margin-bottom:8px"><b>${esc(t.storeName || t.name || "Visitor")}</b>${t.slug ? ` · <a href="/m/${esc(t.slug)}" target="_blank">/m/${esc(t.slug)}</a>` : ""} · ${esc(t.contact || "")} · ${esc(t.role || "")}${t.page ? ` · from ${esc(t.page)}` : ""}
    ${sub ? `<br>Plan <b>${esc(sub.plan || "")}</b> (${esc(sub.status || "")}) · ${sub.plan === "trial" ? `trial ends ${d(sub.trialEndsAt)}` : `paid until ${d(sub.paidUntil)}`}${sub.bonusDays ? ` · bonus given: ${sub.bonusDays} days` : ""}` : ""}</div>
    <div style="max-height:300px;overflow:auto;border:1px solid var(--line,#ddd);border-radius:10px;padding:8px" data-msgs>${M.map((m) => `<div style="margin:6px 0;${m.from === "admin" ? "text-align:right" : ""}"><span style="display:inline-block;max-width:85%;padding:7px 10px;border-radius:12px;white-space:pre-wrap;background:${m.from === "admin" ? (m.gift ? "#e6f6ec" : "#141414") : "#f1f1f1"};color:${m.from === "admin" && !m.gift ? "#fff" : "#141414"}">${esc(m.text || "")}${m.photo ? `<br><img data-sp="${esc(m.photo)}" style="max-width:220px;border-radius:8px;margin-top:4px"/>` : ""}</span><div class="small muted">${new Date(m.at).toLocaleString("en-PH", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div></div>`).join("")}</div>
    <div class="row wrap" style="gap:4px;margin:8px 0">${sup.saved.map((x, i) => `<button class="btn sm ghost" data-sv="${i}" title="${esc(x)}">${esc(x.slice(0, 22))}…</button>`).join("")}</div>
    <textarea data-rt rows="3" placeholder="Reply…" style="width:100%"></textarea>
    <div class="row wrap" style="gap:6px;margin-top:6px"><button class="btn sm" data-rs>Send reply</button>${t.storeId ? `<input data-dd type="number" min="1" max="60" value="3" style="width:64px"/><input data-dr placeholder="Reason (e.g. sync problem)" style="flex:1;min-width:140px"/><button class="btn sm ghost" data-ad>🎁 Add free days</button>` : ""}<button class="btn sm ghost" data-cl>Close chat</button></div>`;
}
function bindConv(box) {
  const tid = sup.open.thread.id; const mm = box.querySelector("[data-msgs]"); if (mm) mm.scrollTop = mm.scrollHeight;
  box.querySelectorAll("[data-sp]").forEach(async (im) => { try { const r = await call("supportFile", { path: im.dataset.sp }); im.src = `data:${r.contentType};base64,${r.base64}`; } catch {} });
  box.querySelectorAll("[data-sv]").forEach((b) => (b.onclick = () => { box.querySelector("[data-rt]").value = sup.saved[Number(b.dataset.sv)]; }));
  const reload = async () => { sup.open = await call("supportAdmin", { action: "get", threadId: tid }); const r = await call("supportAdmin", { action: "list" }); sup.threads = r.threads; drawSupport(); };
  box.querySelector("[data-rs]").onclick = async (e) => { const t = box.querySelector("[data-rt]").value.trim(); if (!t) return; e.target.disabled = true; try { await call("supportAdmin", { action: "reply", threadId: tid, text: t }); await reload(); toast("Sent"); } catch (x) { toast(x.message, "error"); e.target.disabled = false; } };
  box.querySelector("[data-ad]")?.addEventListener("click", async (e) => { const days = Number(box.querySelector("[data-dd]").value) || 3; if (!confirm(`Add ${days} free day(s) to ${sup.open.thread.storeName}?`)) return; e.target.disabled = true; try { await call("supportAdmin", { action: "addDays", threadId: tid, days, reason: box.querySelector("[data-dr]").value.trim() || "For the trouble" }); await reload(); toast(`Added ${days} days`); } catch (x) { toast(x.message, "error"); e.target.disabled = false; } });
  box.querySelector("[data-cl]").onclick = async () => { await call("supportAdmin", { action: "close", threadId: tid }); await reload(); };
}
