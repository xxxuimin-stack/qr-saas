// Freelancer (/pro/): one account — profile & portfolio (10+ photos), proof (ID / certificate or training), the one "Available" switch,
// job offers with a countdown from every shop that accepted you (area + distance + your share shown before you accept),
// today's jobs (on the way → arrived → start → service change? → done with after photo → client paid me), shops hiring near you,
// rate your shops (★ + pays on time), earnings CSV.
import "./pro.css";
import { auth, call } from "./firebase.js";
import { onAuthStateChanged, sendEmailVerification } from "firebase/auth";
import { resizeImage, uploadPrivateImage } from "./upload.js";
import { pinBlock, wirePin, readPin } from "./addrpin.js";
import { startI18n, langSwitch } from "./i18n.js";
startI18n();

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const peso = (n) => "₱" + Math.round(Number(n) || 0).toLocaleString("en-PH");
const app = document.getElementById("app");
const t12 = (ms) => new Date(ms).toLocaleString("en-PH", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const toast = (m) => { document.querySelector(".pr-toast")?.remove(); const t = document.createElement("div"); t.className = "pr-toast"; t.textContent = m; document.body.appendChild(t); setTimeout(() => t.remove(), 3500); };
let H = null, editing = false, shops = null, uid = null;

onAuthStateChanged(auth, async (u) => {
  if (!u || u.isAnonymous) { location.replace("/login/?next=/pro/&signup=1&role=client"); return; }
  uid = u.uid; langSwitch({ into: document.getElementById("langSlot") });
  await load(); setInterval(() => { if (!document.hidden && !editing) load(true); }, 20000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && !editing) load(true); });
});

async function load(quiet) {
  try { H = await call("proHome", {}); } catch (e) { if (!quiet) app.innerHTML = `<p>${esc(e.message)}</p>`; return; }
  if (!H.profile || !H.profile.listed && !quiet && !H.links.length) editing = editing || !H.profile;
  draw();
}

// ---- upload helpers (public work photos / private proof)
async function upload(file, folder, max = 1400) {
  const { storage, ref, uploadBytes, getDownloadURL } = await import("./storage.js");
  const blob = file.type === "application/pdf" ? file : await resizeImage(file, max, 0.82, { webp: folder === "public" });
  const ext = blob.type === "application/pdf" ? "pdf" : blob.type === "image/webp" ? "webp" : blob.type === "image/png" ? "png" : "jpg";
  const path = `pros/${uid}/${folder}/${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
  const r = ref(storage, path); await uploadBytes(r, blob, { contentType: blob.type, ...(folder === "public" ? { cacheControl: "public,max-age=31536000" } : {}) });
  return folder === "public" ? await getDownloadURL(r) : path;
}

const needsEmail = () => { const u = auth.currentUser; return !!u && !u.emailVerified && (u.providerData || []).some((x) => x.providerId === "password"); };
function draw() {
  const P = H.profile;
  if (!P || editing) return drawProfile();
  const avail = P.availableUntil && P.availableUntil > Date.now(), paused = P.pausedUntil && P.pausedUntil > Date.now();
  const acc = H.links.filter((l) => l.status === "accepted");
  app.innerHTML = `
    <section class="pr-hero ${avail ? "on" : ""}">
      <div class="pr-me">${P.photoUrl ? `<img src="${esc(P.photoUrl)}" alt=""/>` : `<span>🧑‍🎨</span>`}<div><b>${esc(P.name)}</b><small>${P.skills.map((k) => esc(H.skills[k] || k)).join(" · ")}${P.badges.length ? ` · ${P.badges.map((b) => ({ id: "🪪 ID checked", cert: "📜 Certified / trained", trusted: "⭐ Trusted" }[b])).join(" · ")}` : ""}</small></div></div>
      ${P.banned ? `<p class="pr-warn">Your freelancer account is closed. Message TapTayo if you think this is a mistake.</p>`
        : paused ? `<p class="pr-warn">⏸ Paused until ${new Date(P.pausedUntil).toLocaleDateString("en-PH", { month: "short", day: "numeric" })}.</p>`
        : `<div class="pr-switch"><div><b>${avail ? "🟢 Available for jobs" : "⚪ Not available"}</b><small>${avail ? `until ${new Date(P.availableUntil).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })} · ${acc.length} shop${acc.length === 1 ? "" : "s"}` : acc.length ? "Turn on to get job offers from your shops" : "Apply to shops below first"}</small></div>
          ${avail ? `<button class="pr-btn ghost" data-off>Turn off</button>` : acc.length ? `<div class="pr-hrs">${[4, 8, 12].map((h) => `<button class="pr-btn" data-on="${h}">${h} h</button>`).join("")}</div>` : ""}</div>
          <p class="pr-note">If you don't answer a job in time, you're switched off at all your shops — turn it on again when you're ready.</p>`}
      ${P.portfolioFlag ? `<p class="pr-warn">⚠️ A shop's report about your portfolio was confirmed. Replace the photos that aren't your own work (Edit profile) to be listed again.</p>` : P.strikes ? `<p class="pr-note">⚠️ ${P.strikes} confirmed shop report${P.strikes > 1 ? "s" : ""}. 2 = paused 14 days · 3 = account closed.</p>` : ""}
      <button class="pr-link" data-push>🔔 Get job alerts on this phone</button>
    </section>
    ${needsEmail() ? `<div class="pr-warn" style="margin-top:12px">📧 Confirm your email to apply to shops. <button class="pr-link" data-ev>Send me the link</button> · <button class="pr-link" data-evdone>I've confirmed it</button></div>` : ""}
    ${H.offers.length ? `<h2 class="pr-h">📣 Job offers</h2>${H.offers.map(offerCard).join("")}` : ""}
    <h2 class="pr-h">📅 My jobs</h2>${H.jobs.length ? H.jobs.map(jobCard).join("") : `<p class="pr-muted">No jobs yet. ${avail ? "Offers show up here and ring your phone." : "Turn on Available to get offers."}</p>`}
    <h2 class="pr-h">🏪 My shops</h2>${H.links.length ? H.links.map(linkRow).join("") : `<p class="pr-muted">Not with any shop yet — apply below.</p>`}
    ${acc.length ? `<div class="pr-row" style="margin:6px 0"><button class="pr-link" data-csv>⬇ Download my earnings (CSV, last 30 days)</button></div>` : ""}
    ${acc.length ? `<details class="pr-card"><summary><b>💸 Send a remittance</b> <small>(cash you collected → the shop's share)</small></summary>
      <label>Shop</label><select data-rshop>${acc.map((l) => `<option value="${l.storeId}">${esc(l.storeName)}</option>`).join("")}</select>
      <div class="pr-g2"><div><label>Amount</label><input data-ramt type="number" min="1" placeholder="₱"/></div><div><label>Sent by</label><select data-rmeth><option value="gcash">GCash</option><option value="maya">Maya</option><option value="bank">Bank</option><option value="cash">Cash (handed over)</option></select></div></div>
      <label>Reference no.</label><input data-rref placeholder="e.g. 1234 567 890"/><button class="pr-btn" data-remit style="margin-top:10px">Send</button></details>` : ""}
    <h2 class="pr-h">🔎 Shops hiring near you</h2><div data-shops><p class="pr-muted">Loading…</p></div>
    <div class="pr-row" style="margin-top:20px"><button class="pr-btn ghost" data-edit>✎ Edit my freelancer profile & portfolio</button></div>`;
  bind(); tick(); loadShops();
}
const offerCard = (o) => `<article class="pr-card offer"><div class="pr-row between"><b>${esc(o.storeName)}</b><span class="pr-cd" data-cd="${o.offer.expiresAt}">–</span></div>
  <div>${esc(o.items.join(", "))}</div><small class="pr-muted">${t12(o.startAt)} · ${o.minutes} min${o.total ? ` · bill ${peso(o.total)}` : ""}</small>
  <div class="pr-addr">${o.where === "home" ? "🏠 Home service" : "🏪 At the shop"} · <b>${esc(o.place || "area not set")}</b>${o.distKm != null ? ` · ${o.distKm} km from you` : ""}${o.where === "home" ? ` <small>(exact address shows 3 h before)</small>` : ""}</div>
  ${o.myShare ? `<div style="margin-top:6px"><b>You earn ${peso(o.myShare)}</b> <small class="pr-muted">(after the shop's cut)</small></div>` : ""}
  <div class="pr-row" style="margin-top:10px"><button class="pr-btn" data-acc="${o.storeId}|${o.id}">✓ Accept</button><button class="pr-btn ghost" data-dec="${o.storeId}|${o.id}">Decline</button></div></article>`;
function jobCard(j) {
  const p = j.pro || {}; const k = `${j.storeId}|${j.id}`; const chg = j.change;
  const step = j.status === "done" ? "" : j.status === "in_progress" ? `<button class="pr-btn" data-done="${k}" ${chg?.status === "pending" ? "disabled" : ""}>✓ Done</button>` : !p.onway ? `<button class="pr-btn" data-step="onway|${k}">🛵 On the way</button>` : !p.arrived ? `<button class="pr-btn" data-step="arrived|${k}">📍 I'm here</button>` : `<button class="pr-btn" data-step="start|${k}">▶ Start</button>`;
  const change = j.status === "done" ? "" : chg?.status === "pending" ? `<div class="pr-warn" style="margin-top:8px">🔁 Change to <b>${esc(chg.items.join(", "))}</b> (${peso(chg.from)} → ${peso(chg.to)}) — waiting for ${[chg.client === null ? "the client" : "", chg.shop !== "yes" ? "the shop" : ""].filter(Boolean).join(" and ")}</div>` : chg?.status === "applied" ? `<small class="pr-muted">✅ Services changed</small>` : ["rejected", "declined"].includes(chg?.status) ? `<small class="pr-muted">❌ Change not approved — keep the booked services</small>` : "";
  return `<article class="pr-card"><div class="pr-row between"><b>${esc(j.storeName)}</b><span class="pr-pill ${j.status}">${{ pending: "Booked", confirmed: "Confirmed", unconfirmed: "Booked", in_progress: "In progress", done: "Done ✓" }[j.status] || esc(j.status)}</span></div>
    <div>${esc(j.items.join(", "))} · ${esc(j.client || "Client")}</div><small class="pr-muted">${t12(j.startAt)} · ${j.minutes} min${j.distKm != null ? ` · ${j.distKm} km` : ""}${j.myShare ? ` · you earn ${peso(j.myShare)}` : ""}</small>${change}
    ${j.home ? `<div class="pr-addr">🏠 ${j.home.address ? `${esc(j.home.address)}${j.home.landmark ? ` · ${esc(j.home.landmark)}` : ""}${j.home.mapUrl ? ` · <a href="${esc(j.home.mapUrl)}" target="_blank" rel="noopener">Open map</a>` : ""}` : `${esc(j.home.area || "Home service")} <small>(exact address shows 3 hours before)</small>`}</div>` : ""}
    <div class="pr-row" style="margin-top:10px">${step}${j.status !== "done" && chg?.status !== "pending" ? `<button class="pr-btn ghost" data-change="${k}">🔁 Client wants a different service</button>` : ""}${j.status === "done" && !j.paid && j.remit ? `<button class="pr-btn ghost" data-collect="${k}">💵 Client paid me</button>` : ""}<a class="pr-btn ghost" href="/m/${esc(j.slug)}" target="_blank" rel="noopener">Shop page</a></div></article>`;
}
const linkRow = (l) => `<div class="pr-shop"><span><b>${esc(l.storeName)}</b><small>${{ applied: "⏳ Applied — waiting for the shop", invited: "📩 Invited you", accepted: `✅ You're a freelancer here${l.done ? ` · ${l.done} job${l.done > 1 ? "s" : ""}` : ""}${l.myRating ? ` · you rated ★ ${l.myRating.stars}` : ""}`, rejected: "Not this time", left: "You left", removed: "Removed" }[l.status] || esc(l.status)}</small></span>
  ${l.status === "invited" ? `<button class="pr-btn" data-apply="${esc(l.slug)}">Accept</button>` : l.status === "accepted" ? `<span class="pr-row" style="gap:4px">${l.canRate ? `<button class="pr-link" data-rateshop="${l.storeId}">★ Rate shop</button>` : ""}<button class="pr-link" data-leave="${l.storeId}">Leave</button></span>` : ""}</div>`;
async function loadShops() {
  const box = app.querySelector("[data-shops]"); if (!box) return;
  try { shops = shops || (await call("proShops", {})); } catch (e) { box.innerHTML = `<p class="pr-muted">${esc(e.message)}</p>`; return; }
  const list = shops.filter((s) => !["accepted"].includes(s.status));
  box.innerHTML = list.length ? list.map((s) => `<div class="pr-shop"><span class="pr-logo">${s.logoUrl ? `<img src="${esc(s.logoUrl)}" alt=""/>` : "🏪"}</span><span style="flex:1"><b>${esc(s.name)}${s.verified ? " ✓" : ""}</b><small>${[s.distKm != null ? `${s.distKm} km` : "", (s.skills || []).map((k) => H.skills[k] || k).join(", "), s.requireCert ? "📜 certificate needed" : "", s.rating ? `★ ${s.rating.avg} by freelancers${s.rating.paysOnTime != null ? ` · ${s.rating.paysOnTime}% pays on time` : ""}` : "", s.note].filter(Boolean).map(esc).join(" · ")}</small></span>
    ${s.status === "applied" ? `<small class="pr-muted">Applied</small>` : s.status === "rejected" ? "" : `<button class="pr-btn ${s.match ? "" : "ghost"}" data-apply="${esc(s.slug)}">${s.status === "invited" ? "Accept" : "Apply"}</button>`}</div>`).join("") : `<p class="pr-muted">No shops near you are hiring freelancers yet. Tell your favorite salon about TapTayo 🙂</p>`;
  box.querySelectorAll("[data-apply]").forEach(applyBtn);
}
function applyBtn(b) { b.onclick = async () => { const note = b.textContent === "Apply" ? prompt("A short note to the shop (optional):", "") : ""; if (note === null) return; b.disabled = true; try { const r = await call("proApply", { slug: b.dataset.apply, note }); toast(r.status === "accepted" ? "You're in! 🎉" : "Applied ✓ — the shop will look at your portfolio"); shops = null; load(); } catch (e) { b.disabled = false; toast(e.message); } }; }

function bind() {
  const act = async (fn, okMsg) => { try { await fn(); if (okMsg) toast(okMsg); await load(true); } catch (e) { toast(e.message); } };
  app.querySelectorAll("[data-on]").forEach((b) => (b.onclick = () => act(() => call("proAvailable", { on: true, hours: Number(b.dataset.on) }), "You're available 🟢")));
  app.querySelector("[data-off]")?.addEventListener("click", () => act(() => call("proAvailable", { on: false }), "Turned off"));
  app.querySelectorAll("[data-acc]").forEach((b) => (b.onclick = () => { const [s, i] = b.dataset.acc.split("|"); b.disabled = true; act(() => call("proOffer", { storeId: s, id: i, action: "accept" }), "Job accepted ✓"); }));
  app.querySelectorAll("[data-dec]").forEach((b) => (b.onclick = () => { const [s, i] = b.dataset.dec.split("|"); act(() => call("proOffer", { storeId: s, id: i, action: "decline" })); }));
  app.querySelectorAll("[data-step]").forEach((b) => (b.onclick = () => { const [step, s, i] = b.dataset.step.split("|"); b.disabled = true;
    const go = (pos) => act(() => call("proJob", { storeId: s, id: i, step, ...(pos ? { lat: pos.coords.latitude, lng: pos.coords.longitude } : {}) }), { onway: "The shop knows you're on the way", arrived: "The shop knows you're here", start: "Started" }[step]);
    if ((step === "onway" || step === "arrived") && navigator.geolocation) navigator.geolocation.getCurrentPosition(go, () => go(null), { timeout: 8000 }); else go(null); }));
  app.querySelectorAll("[data-done]").forEach((b) => (b.onclick = () => { const [s, i] = b.dataset.done.split("|"); doneDialog(s, i); }));
  app.querySelectorAll("[data-change]").forEach((b) => (b.onclick = () => { const [s, i] = b.dataset.change.split("|"); changeDialog(s, i); }));
  app.querySelectorAll("[data-rateshop]").forEach((b) => (b.onclick = () => { const st = prompt("Rate this shop (1–5 stars):", "5"); if (!st) return; const pays = confirm("Does this shop pay you on time?\n\nOK = yes · Cancel = no"); act(() => call("proRateShop", { storeId: b.dataset.rateshop, stars: Number(st), paysOnTime: pays }), "Thanks — your rating helps other freelancers"); }));
  app.querySelector("[data-csv]")?.addEventListener("click", downloadCsv);
  app.querySelectorAll("[data-collect]").forEach((b) => (b.onclick = () => { const [s, i] = b.dataset.collect.split("|"); const m = prompt("How did the client pay you? (cash / gcash / maya / bank)", "cash"); if (!m) return; act(() => call("proJob", { storeId: s, id: i, step: "collect", method: m.trim().toLowerCase() }), "Recorded — remit the shop's share"); }));
  app.querySelectorAll("[data-leave]").forEach((b) => (b.onclick = () => { if (confirm("Leave this shop? Your upcoming jobs there go back to the shop.")) act(() => call("proLeave", { storeId: b.dataset.leave }), "You left the shop"); }));
  app.querySelectorAll(".pr-shop [data-apply]").forEach(applyBtn);
  app.querySelector("[data-remit]")?.addEventListener("click", () => act(() => call("proJob", { step: "remit", storeId: app.querySelector("[data-rshop]").value, amount: Number(app.querySelector("[data-ramt]").value), method: app.querySelector("[data-rmeth]").value, refNo: app.querySelector("[data-rref]").value }), "Sent — the shop confirms it"));
  app.querySelector("[data-edit]").onclick = () => { editing = true; draw(); };
  app.querySelector("[data-ev]")?.addEventListener("click", async () => { try { await sendEmailVerification(auth.currentUser, { url: `${location.origin}/pro/` }); toast(`Link sent to ${auth.currentUser.email} — check Spam too`); } catch (e) { toast(/too-many/.test(e.code || "") ? "Please wait a minute before asking again." : e.message); } });
  app.querySelector("[data-evdone]")?.addEventListener("click", async () => { await auth.currentUser.reload().catch(() => {}); if (auth.currentUser.emailVerified) { await auth.currentUser.getIdToken(true); toast("Email confirmed ✓"); draw(); } else toast("Not confirmed yet — open the link in the email first."); });
  app.querySelector("[data-push]").onclick = enablePush;
}
// Done = after photo of the work (proof for you, the client and the shop) — or say why there's none
function doneDialog(storeId, id) {
  const d = document.createElement("div"); d.className = "pr-toast"; d.style.cssText = "bottom:0;left:0;right:0;transform:none;max-width:none;border-radius:18px 18px 0 0;background:#fff;color:var(--ink);padding:16px;border-top:1px solid var(--line)";
  d.innerHTML = `<b>✓ Finish the job</b><p class="pr-muted" style="margin:4px 0 10px">Take an <b>after photo</b> of your work. The shop and the client see it — it protects you if there's a complaint.</p>
    <label class="pr-btn ghost">📷 After photo<input type="file" accept="image/*" capture="environment" data-af hidden/></label> <span class="pr-muted" data-afs></span>
    <label style="margin-top:10px">No photo? Say why</label><input data-nop placeholder="e.g. client said no photo"/>
    <div class="pr-row" style="margin-top:12px"><button class="pr-btn" data-ok>Done ✓</button><button class="pr-btn ghost" data-x>Back</button></div>`;
  document.body.appendChild(d); let photo = null;
  d.querySelector("[data-af]").onchange = async (e) => { const f = e.target.files[0]; if (!f) return; d.querySelector("[data-afs]").textContent = "Uploading…"; try { photo = await uploadPrivateImage(storeId, uid, f, { max: 1400, name: `after_${id}_${Date.now()}` }); d.querySelector("[data-afs]").textContent = "✓ attached"; } catch (x) { d.querySelector("[data-afs]").textContent = x.message; } };
  d.querySelector("[data-x]").onclick = () => d.remove();
  d.querySelector("[data-ok]").onclick = async (e) => { e.target.disabled = true; try { const r = await call("proJob", { storeId, id, step: "done", photo, noPhoto: d.querySelector("[data-nop]").value }); d.remove(); const ask = document.createElement("div"); ask.className = "pr-toast"; ask.style.cssText = "bottom:0;left:0;right:0;transform:none;max-width:none;border-radius:18px 18px 0 0;background:#fff;color:var(--ink);padding:16px;border-top:1px solid var(--line)"; ask.innerHTML = "<b>" + (r.short ? "Done early" : "Done") + "</b><p class=""pr-muted"">Turn on Available now so the next job can reach you while you are still out.</p><div class=""pr-row"" style=""margin-top:12px""><button class=""pr-btn"" data-yes>Available for 3 hours</button><button class=""pr-btn ghost"" data-no>Not now</button></div>"; document.body.appendChild(ask); ask.querySelector("[data-no]").onclick = () => { ask.remove(); load(true); }; ask.querySelector("[data-yes]").onclick = async (ev) => { ev.target.disabled = true; try { await call("proAvailable", { on: true, hours: 3 }); toast("Available"); } catch (err) { toast(err.message); } ask.remove(); load(true); }; } catch (x) { toast(x.message); e.target.disabled = false; } };
}
// The client wants something else: pick from the SHOP's menu (prices are the shop's), say why; a cheaper service needs a photo and the shop's OK
async function changeDialog(storeId, id) {
  let M; try { M = await call("proJob", { storeId, id, step: "menu" }); } catch (e) { return toast(e.message); }
  const d = document.createElement("div"); d.className = "pr-toast"; d.style.cssText = "bottom:0;left:0;right:0;transform:none;max-width:none;max-height:85vh;overflow:auto;border-radius:18px 18px 0 0;background:#fff;color:var(--ink);padding:16px;border-top:1px solid var(--line)";
  const opt = (it) => it.variants.length ? it.variants.map((v) => ({ key: `${it.id}~${v.i}`, name: `${it.name} (${v.label})`, price: v.price })) : [{ key: it.id, name: it.name, price: it.price }];
  const all = M.items.flatMap(opt); const cur = new Set(M.current);
  d.innerHTML = `<b>🔁 Change services</b><p class="pr-muted" style="margin:4px 0 10px">Tick what the client is getting now. The client confirms on their phone and the shop approves. A cheaper service needs a photo.</p>
    <div style="display:grid;gap:4px">${all.map((o) => `<label class="pr-check"><input type="checkbox" value="${esc(o.key)}" ${cur.has(o.key) ? "checked" : ""}/> ${esc(o.name)} <span class="pr-muted">· ${peso(o.price)}</span></label>`).join("")}</div>
    <label style="margin-top:10px">Why</label><input data-why placeholder="e.g. client changed to gel polish"/>
    <label class="pr-btn ghost" style="margin-top:8px">📷 Photo (needed if cheaper)<input type="file" accept="image/*" capture="environment" data-cf hidden/></label> <span class="pr-muted" data-cfs></span>
    <div class="pr-row" style="margin-top:12px"><button class="pr-btn" data-ok>Send for approval</button><button class="pr-btn ghost" data-x>Back</button></div>`;
  document.body.appendChild(d); let photo = null;
  d.querySelector("[data-cf]").onchange = async (e) => { const f = e.target.files[0]; if (!f) return; d.querySelector("[data-cfs]").textContent = "Uploading…"; try { photo = await uploadPrivateImage(storeId, uid, f, { max: 1400, name: `change_${id}_${Date.now()}` }); d.querySelector("[data-cfs]").textContent = "✓ attached"; } catch (x) { d.querySelector("[data-cfs]").textContent = x.message; } };
  d.querySelector("[data-x]").onclick = () => d.remove();
  d.querySelector("[data-ok]").onclick = async (e) => { e.target.disabled = true; try { const items = [...d.querySelectorAll("input[type=checkbox]:checked")].map((x) => x.value); const r = await call("proJob", { storeId, id, step: "change", items, reason: d.querySelector("[data-why]").value, photo }); d.remove(); toast(r.downgrade ? "Sent — the shop has to approve a cheaper service" : "Sent — the client and the shop will confirm"); load(true); } catch (x) { toast(x.message); e.target.disabled = false; } };
}
async function downloadCsv() {
  try {
    const r = await call("proEarnings", {}); const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [["Date", "Shop", "Type", "Details", "Amount", "Status", "Method"], ...r.rows.map((x) => [new Date(x.at).toLocaleString("en-PH"), x.shop, x.type, x.label, x.amount, x.status, x.method]), [], ["Earned", "", "", "", r.totals.earned], ["Collected from clients", "", "", "", r.totals.collected], ["Remitted to shops", "", "", "", r.totals.remitted], ["Paid out by shops", "", "", "", r.totals.paidOut]];
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["\ufeff" + rows.map((row) => row.map(q).join(",")).join("\n")], { type: "text/csv" })); a.download = `taptayo-earnings-${new Date().toISOString().slice(0, 10)}.csv`; a.click();
    toast(`Earned ${peso(r.totals.earned)} in the last 30 days`);
  } catch (e) { toast(e.message); }
}
function tick() { app.querySelectorAll("[data-cd]").forEach((el) => { const s = Math.max(0, Math.round((Number(el.dataset.cd) - Date.now()) / 1000)); el.textContent = s ? `⏱ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "Time's up"; el.classList.toggle("low", s < 60); }); }
setInterval(tick, 1000);
async function enablePush() {
  try {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("This phone can't get alerts here. On iPhone: Share → Add to Home Screen, then open TapTayo Pro from the icon.");
    if ((await Notification.requestPermission()) !== "granted") throw new Error("Alerts are blocked — allow notifications for this site.");
    const reg = await navigator.serviceWorker.register("/sw.js"); await navigator.serviceWorker.ready;
    const { publicKey } = await call("pushKey", {}); const key = Uint8Array.from(atob((publicKey + "=".repeat((4 - (publicKey.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
    const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
    await call("proPushSubscribe", { sub: sub.toJSON(), test: true }); toast("Job alerts are on 🔔");
  } catch (e) { toast(e.message); }
}

// ---- profile editor
function drawProfile() {
  const P = H.profile || { skills: [], portfolio: [], proof: { id: "none", cert: "none" } };
  let pics = [...(P.portfolio || [])], photo = P.photoUrl || null;
  app.innerHTML = `<h1 class="pr-title">${H.profile ? "My freelancer profile" : "Work as a freelancer 🧑‍🎨"}</h1>
    <p class="pr-muted">Shops near you see your work and send you jobs when you're free. You choose when you're available — and you can say no.</p>
    <section class="pr-card"><div class="pr-row"><span class="pr-av" data-av>${photo ? `<img src="${esc(photo)}" alt=""/>` : "🧑‍🎨"}</span><label class="pr-btn ghost">📷 Profile photo<input type="file" accept="image/*" data-avf hidden/></label></div>
      <label>Name</label><input data-name value="${esc(P.name || "")}" placeholder="Your full name"/>
      <label>About you</label><textarea data-bio rows="3" placeholder="e.g. 5 years doing gel nails & nail art. I bring my own tools.">${esc(P.bio || "")}</textarea>
      <label>What you do</label><div class="pr-chips" data-skills>${Object.entries(H.skills).map(([k, l]) => `<button type="button" class="pr-chip ${(P.skills || []).includes(k) ? "on" : ""}" data-k="${k}">${l}${H.certSkills.includes(k) ? " 📜" : ""}</button>`).join("")}</div>
      <div class="pr-g2"><div><label>Rate (optional)</label><input data-rate value="${esc(P.rateNote || "")}" placeholder="e.g. ₱350 / set"/></div><div><label>Mobile</label><input data-phone type="tel" value="${esc(P.phone || "")}" placeholder="09XX XXX XXXX"/></div></div>
      <label>Where you work from <small>(only your distance is shown to shops)</small></label>${pinBlock({ mapUrl: P.mapSet ? "set" : "" }, { who: "shops near you", landmark: false, btn: "pr-btn ghost" })}
      <label>How far you'll travel</label><select data-radius>${[3, 5, 10, 15, 20, 30, 50].map((k) => `<option value="${k}" ${(P.radiusKm || 10) === k ? "selected" : ""}>${k} km</option>`).join("")}</select>
      <label class="pr-check"><input type="checkbox" data-adult ${P.adult ? "checked" : ""}/> I'm 18 or older and I follow TapTayo's freelancer rules (no services outside the app, no "extra" services)</label></section>
    <section class="pr-card"><b>🖼 My work</b> <small class="pr-muted">— at least ${H.minPics || 10} photos (before/after, your best sets). Shops decide from these.</small> <span class="pr-pill" data-piccount></span>
      <div class="pr-pics" data-pics></div><label class="pr-btn ghost" style="margin-top:8px">+ Add photos<input type="file" accept="image/*" multiple data-picf hidden/></label><span class="pr-muted" data-picst></span></section>
    <section class="pr-card"><b>🪪 Proof</b> <small class="pr-muted">— only TapTayo sees these. You get a badge; the file is deleted after checking.</small>
      ${[["id", "Valid ID", "🪪 ID checked"], ["cert", "Certificate or proof of training (TESDA NC II, DOH, school, training center) — some shops require it, esp. massage & spa", "📜 Certified / trained"]].map(([k, l, b]) => `<div class="pr-shop"><span><b>${l}</b><small>${{ none: "Not sent", pending: "⏳ Checking (1–3 days)", approved: `✅ ${b}`, rejected: `❌ Not accepted${P.proof?.note ? " — " + esc(P.proof.note) : ""}` }[P.proof?.[k] || "none"]}</small></span>${P.proof?.[k] === "approved" ? "" : `<label class="pr-btn ghost">Upload<input type="file" accept="image/*,application/pdf" data-proof="${k}" hidden/></label>`}</div>`).join("")}</section>
    <div class="pr-row"><button class="pr-btn" data-save>Save</button>${H.profile ? `<button class="pr-btn ghost" data-cancel>Back</button>` : ""}<span class="pr-muted" data-msg></span></div>`;
  wirePin(app);
  const drawPics = () => { const pc = app.querySelector("[data-piccount]"); if (pc) { pc.textContent = `${pics.length} / ${H.minPics || 10}`; pc.style.background = pics.length >= (H.minPics || 10) ? "#DCFCE7" : "#FEF3C7"; } app.querySelector("[data-pics]").innerHTML = pics.map((p, i) => `<span class="pr-pic"><img src="${esc(p.url)}" alt=""/><input data-cap="${i}" value="${esc(p.caption || "")}" placeholder="Caption"/><button type="button" data-rm="${i}">✕</button></span>`).join("") || `<p class="pr-muted">No photos yet.</p>`;
    app.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => { pics.splice(Number(b.dataset.rm), 1); drawPics(); }));
    app.querySelectorAll("[data-cap]").forEach((inp) => (inp.oninput = () => { pics[Number(inp.dataset.cap)].caption = inp.value; })); };
  drawPics();
  app.querySelectorAll("[data-k]").forEach((b) => (b.onclick = () => b.classList.toggle("on")));
  app.querySelector("[data-avf]").onchange = async (e) => { const f = e.target.files[0]; if (!f) return; try { photo = await upload(f, "public", 600); app.querySelector("[data-av]").innerHTML = `<img src="${esc(photo)}" alt=""/>`; } catch (x) { toast(x.message); } };
  app.querySelector("[data-picf]").onchange = async (e) => { const st = app.querySelector("[data-picst]"); for (const f of [...e.target.files].slice(0, 24 - pics.length)) { st.textContent = " Uploading…"; try { pics.push({ url: await upload(f, "public"), caption: "" }); drawPics(); } catch (x) { toast(x.message); } } st.textContent = ""; };
  app.querySelectorAll("[data-proof]").forEach((inp) => (inp.onchange = async (e) => { const f = e.target.files[0]; if (!f) return; try { const path = await upload(f, "private", 1600); await call("proProof", { kind: inp.dataset.proof, path }); toast("Sent for checking ✓"); H = await call("proHome", {}); drawProfile(); } catch (x) { toast(x.message); } }));
  app.querySelector("[data-cancel]")?.addEventListener("click", () => { editing = false; draw(); });
  app.querySelector("[data-save]").onclick = async (e) => {
    const pin = readPin(app); const skills = [...app.querySelectorAll("[data-k].on")].map((b) => b.dataset.k);
    e.target.disabled = true;
    try {
      const r = await call("proSave", { name: app.querySelector("[data-name]").value, bio: app.querySelector("[data-bio]").value, skills, rateNote: app.querySelector("[data-rate]").value, phone: app.querySelector("[data-phone]").value, radiusKm: Number(app.querySelector("[data-radius]").value), adult: app.querySelector("[data-adult]").checked, photoUrl: photo, portfolio: pics, ...(pin?.mapUrl && pin.mapUrl !== "set" ? { mapUrl: pin.mapUrl } : {}) });
      toast(r.listed ? "Saved ✓ — shops near you can see you" : `Saved. Still needed: ${r.missing.join(", ")}`);
      editing = false; shops = null; await load();
    } catch (x) { toast(x.message); e.target.disabled = false; }
  };
}
