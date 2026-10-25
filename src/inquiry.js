// 🎨 Freelancer & Creator — customer side: "Request a quote" / "Make an offer" → negotiate → accept terms + downpayment → deliverables review → results review.
import { doc, onSnapshot } from "firebase/firestore";
import { uploadPrivateImage } from "./upload.js";
import { msgrField, readMsgr } from "./msgr.js";
import { xdealHTML, xdealActions, X_ST } from "./xdeal.js";

let C = null, unsub = null, tick = null;
const ST = { new: ["📨", "Sent — waiting for a quote"], negotiating: ["💬", "Negotiating"], quoted: ["💬", "Quote ready"], accepted: ["⏳", "Checking your downpayment"], in_progress: ["🎬", "In progress"], delivered: ["✅", "All delivered"], done: ["🏁", "Completed"], declined: ["✕", "Declined"] };
const fmtD = (s) => (s ? new Date(`${s}T00:00:00`).toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric" }) : "");
const peso = (n) => "₱" + Math.round(Number(n) || 0).toLocaleString("en-PH");
/** "2d 4h left" / "3h 12m left" / "late by 2h" */
export function countdown(ms) {
  const d = ms - Date.now(); const a = Math.abs(d); const D = Math.floor(a / 86400000), H = Math.floor((a % 86400000) / 3600000), M = Math.floor((a % 3600000) / 60000);
  const t = D ? `${D}d ${H}h` : H ? `${H}h ${M}m` : `${M}m`; return d >= 0 ? `${t} left` : `late by ${t}`;
}
const dueMs = (ymd) => new Date(`${ymd}T23:59:59+08:00`).getTime();
export const offerLine = (o) => [o.fee ? `${peso(o.fee)} talent fee` : "", o.transpo ? `${peso(o.transpo)} transport` : "", o.freebies || ""].filter(Boolean).join(" + ");
/** the back-and-forth of offers, newest last */
export function offersHTML(q, esc, mine = "client") {
  const L = q.offers || []; if (!L.length) return "";
  return `<div class="neg">${L.map((o) => `<div class="neg-row ${o.from === mine ? "me" : ""}"><div class="neg-who">${o.from === "creator" ? "🎨 Creator" : "🏪 Client"} · ${new Date(o.at).toLocaleDateString("en-PH", { month: "short", day: "numeric" })}</div><b>${esc(offerLine(o))}</b>${o.deliverables ? `<div class="small">For: ${esc(o.deliverables)}</div>` : ""}${o.notes ? `<div class="small muted">${esc(o.notes)}</div>` : ""}</div>`).join("")}</div>`;
}
export const NEG_CSS = `.neg{display:flex;flex-direction:column;gap:6px;margin:6px 0}.neg-row{background:#f3f4f6;border-radius:12px;padding:8px 10px;max-width:88%}.neg-row.me{align-self:flex-end;background:#dcfce7}.neg-who{font-size:.72rem;opacity:.7}.cd{display:inline-block;font-weight:700;border-radius:999px;padding:2px 9px;font-size:.78rem;background:#dcfce7;color:#166534}.cd.late{background:#fee2e2;color:#991b1b}`;
function css() { if (document.getElementById("negcss")) return; const s = document.createElement("style"); s.id = "negcss"; s.textContent = NEG_CSS; document.head.appendChild(s); }

/** offer form fields (talent fee, transport, freebies, what for, note) */
export function offerFields(esc, o = {}) {
  return `<div class="row" style="gap:8px"><div style="flex:1"><label>Talent fee (₱)</label><input data-o-fee type="number" min="0" value="${o.fee ?? ""}" placeholder="0"/></div><div style="flex:1"><label>Transport (₱)</label><input data-o-tr type="number" min="0" value="${o.transpo ?? ""}" placeholder="1000"/></div></div>
    <label>Freebies / what's included</label><input data-o-free maxlength="160" value="${esc(o.freebies || "")}" placeholder="e.g. Free food up to 4 pax"/>
    <label>Content you want</label><input data-o-del maxlength="200" value="${esc(o.deliverables || "")}" placeholder="e.g. 1 TikTok vlog + 3 IG stories"/>
    <label>Note (optional)</label><input data-o-note maxlength="300" value="${esc(o.notes || "")}"/>`;
}
export const readOffer = (root) => { const v = (k) => root.querySelector(`[data-o-${k}]`)?.value.trim() || ""; return { fee: Number(v("fee")) || 0, transpo: Number(v("tr")) || 0, freebies: v("free"), deliverables: v("del"), notes: v("note") }; };

export function quoteCTA(store, esc) {
  const F = store.salon?.freelance || {}; const cr = store.creator || {};
  if (store.businessType !== "freelance" || F.quotes === false) return "";
  const facts = [cr.verified ? `<span class="chip" style="background:#dcfce7;color:#166534">✔ Verified by TapTayo</span>` : "", cr.onTime ? `<span class="chip">⏱ ${cr.onTime.rate}% on time (${cr.onTime.n})</span>` : "", ...(cr.niches || []).map((n) => `<span class="chip">${esc(n)}</span>`), cr.radiusKm ? `<span class="chip">📍 up to ${cr.radiusKm} km${cr.city ? ` from ${esc(cr.city)}` : ""}</span>` : cr.city ? `<span class="chip">📍 ${esc(cr.city)}</span>` : "", cr.rush ? `<span class="chip">⚡ Rush ${cr.rush.hours}h +${peso(cr.rush.fee)}</span>` : ""].filter(Boolean).join("");
  void facts; return quoteBox(cr);
}
export function creatorProfile(store, esc) {
  const F = store.salon?.freelance || {}; const cr = store.creator || {}; if (store.businessType !== "freelance") return "";
  const facts = [cr.verified ? `<span class="chip" style="background:#dcfce7;color:#166534">✔ Verified by TapTayo</span>` : "", cr.onTime ? `<span class="chip">⏱ ${cr.onTime.rate}% on time (${cr.onTime.n})</span>` : "", ...(cr.niches || []).map((n) => `<span class="chip">${esc(n)}</span>`), cr.radiusKm ? `<span class="chip">📍 up to ${cr.radiusKm} km${cr.city ? ` from ${esc(cr.city)}` : ""}</span>` : cr.city ? `<span class="chip">📍 ${esc(cr.city)}</span>` : "", cr.rush ? `<span class="chip">⚡ Rush ${cr.rush.hours}h +${peso(cr.rush.fee)}</span>` : ""].filter(Boolean).join("");
  const res = (store.feedback?.reviews || []).filter((r) => /^📈/.test(r.comment || "")).slice(0, 3);
  const P = (cr.portfolio || []).slice(0, 9);
  const port = P.length ? `<div class="c-ticket" style="margin-bottom:12px"><div class="eyebrow">🖼 Portfolio${cr.ugc ? " · 📱 UGC" : ""}</div><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:6px">${P.map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener" style="position:relative;aspect-ratio:1;border-radius:10px;overflow:hidden;background:#f3f4f6;display:block">${x.thumb ? `<img src="${esc(x.thumb)}" alt="${esc(x.label)}" loading="lazy" style="width:100%;height:100%;object-fit:cover"/>` : `<span style="display:grid;place-items:center;height:100%;font-size:1.6rem">🎬</span>`}<span style="position:absolute;left:4px;right:4px;bottom:4px;background:rgba(0,0,0,.6);color:#fff;font-size:.62rem;border-radius:6px;padding:1px 5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${x.kind === "video" ? "▶ " : ""}${esc(x.label || x.brand || "")}</span></a>`).join("")}</div></div>` : "";
  const avail = cr.paused ? `<div class="c-alert warn" style="margin-bottom:10px">⏸ Taking a break${cr.paused.until ? ` until ${new Date(cr.paused.until).toLocaleDateString("en-PH", { month: "short", day: "numeric" })}` : ""} — not accepting new bookings right now.</div>` : "";
  return `${avail}${facts ? `<div class="c-chips" style="margin:0 0 10px">${facts}${cr.sideJob ? `<span class="chip">🕒 ${esc(cr.sideJob)}</span>` : ""}${cr.ugc ? `<span class="chip">📱 UGC</span>` : ""}</div>` : ""}${port}${cr.pitch ? `<div class="c-ticket" style="margin-bottom:12px"><div class="eyebrow">💡 Why book me</div><p class="small" style="margin:4px 0 0;white-space:pre-wrap">${esc(cr.pitch)}</p>${(cr.brands || []).length ? `<div class="small muted" style="margin-top:6px">Worked with: ${cr.brands.map(esc).join(" · ")}</div>` : ""}</div>` : ""}${res.length ? `<div class="c-ticket" style="margin-bottom:12px"><div class="eyebrow">📈 Client results</div>${res.map((r) => `<p class="small" style="margin:6px 0">${"★".repeat(r.rating)} ${esc(r.comment.replace(/^📈\s*/, ""))} <span class="muted">— ${esc(r.name)}</span></p>`).join("")}</div>` : ""}`;
}
function quoteBox(cr) {
  return `<div class="c-ticket" style="margin-bottom:12px"><div class="eyebrow">📨 Brand collab or custom project?</div><p class="small" style="margin:4px 0 8px">${cr.offers !== false ? "Send a brief for a quote — or make your own offer (talent fee, transport, freebies). The creator can accept, decline or counter." : "Send a short brief — get a quote."} Your date is locked once you accept the terms and pay the downpayment.</p>
    <div class="row" style="gap:6px"><button class="c-btn brand" style="flex:1" data-quote>Request a quote</button>${cr.offers !== false ? `<button class="c-btn ghost" style="flex:1" data-quote="offer">💸 Make an offer</button>` : ""}</div>${cr.minFee ? `<p class="small muted" style="margin:6px 0 0">Minimum offer ${peso(cr.minFee)} (talent fee + transport).</p>` : ""}</div>`;
}
/** media kit: platforms + followers (from Settings) */
export function mediaKit(store, esc) {
  const P = store.salon?.freelance?.platforms || []; if (store.businessType !== "freelance" || !P.length) return "";
  return `<div class="c-chips" style="margin:4px 0 12px">${P.map((p) => `<a class="chip" href="${esc(p.url || "#")}" target="_blank" rel="noopener" style="text-decoration:none">${esc(p.platform || "")} <b>${esc(p.followers || "")}</b>${p.handle ? ` <span class="muted small">${esc(p.handle)}</span>` : ""}${store.creator?.verified ? " ✔" : ""}</a>`).join("")}</div>`;
}

export function openQuoteForm(ctx, mode = "quote") {
  C = ctx; css(); const { esc, html, store } = C; const saved = C.loadLocal().customer || {}; const cr = store.creator || {};
  const isOffer = mode === "offer";
  const body = html(`<div>
    ${isOffer ? `<div class="c-alert">💸 Your offer goes straight to the creator. They can accept, decline or send a counter-offer.</div>${offerFields(esc)}` : `<label>What do you need?</label><select data-kind><option>Brand collab / content</option><option>Photo or video shoot</option><option>Event coverage (whole day)</option><option>Makeup / styling</option><option>Design / marketing</option><option>Other</option></select>`}
    <label>Brand or project name (optional)</label><input data-brand maxlength="80"/>
    <label>Platform (optional)</label><input data-platform placeholder="TikTok, Instagram, YouTube, print…" maxlength="60"/>
    <div class="row" style="gap:8px"><div style="flex:1"><label>Event / shoot date</label><input type="date" data-date/></div><div style="flex:1"><label>Deadline</label><input type="date" data-deadline/></div></div>
    ${cr.rush ? `<label class="c-agree"><input type="checkbox" data-rush/> ⚡ I need it rush — within ${cr.rush.hours} h (+${peso(cr.rush.fee)})</label>` : ""}
    ${isOffer ? "" : `<label>Budget (optional)</label><input data-budget placeholder="e.g. ₱10,000–₱15,000" maxlength="40"/>`}
    <label>On-site? Where (optional)</label><input data-loc maxlength="120" placeholder="Shop name, street, city"/>
    <div data-onsite hidden><div style="display:flex;gap:6px"><input data-pin placeholder="Paste a Google Maps link" style="flex:1"/><button type="button" class="c-btn ghost" data-mypin>📍 My location</button></div>${cr.radiusKm ? `<p class="c-hint">The creator travels up to ${cr.radiusKm} km.</p>` : ""}
      ${cr.idOnSite ? `<label>Valid ID of the person meeting the creator <span class="muted small">(for the creator's safety — only they see it)</span></label><input type="file" accept="image/*" data-id/>` : ""}</div>
    ${isOffer ? "" : `<label>Deliverables you want</label><input data-del placeholder="e.g. 2 TikToks + 3 stories" maxlength="300"/>`}
    <label>Tell us about it</label><textarea data-details rows="4" maxlength="1500" placeholder="Goal, style, references, anything we should know"></textarea>
    <label>Your name</label><input data-name value="${esc(saved.name || "")}"/>
    <label>Mobile</label><input data-phone type="tel" value="${esc(saved.phone || "")}"/>
    ${msgrField(saved)}
    <label>Email (optional)</label><input data-email type="email"/>
    <div data-err></div></div>`);
  const q = (k) => body.querySelector(`[data-${k}]`);
  q("loc").oninput = () => (q("onsite").hidden = !q("loc").value.trim());
  q("mypin").onclick = (ev) => { if (!navigator.geolocation) return C.toast("Paste a Maps link instead"); ev.target.textContent = "Locating…"; navigator.geolocation.getCurrentPosition((p) => { q("pin").value = `https://maps.google.com/?q=${p.coords.latitude.toFixed(6)},${p.coords.longitude.toFixed(6)}`; ev.target.textContent = "📍 Got it"; }, () => { ev.target.textContent = "📍 My location"; C.toast("Couldn't get your location — paste a Maps link"); }, { enableHighAccuracy: true, timeout: 12000 }); };
  const foot = html(`<div><button class="c-btn brand block" data-send>${isOffer ? "Send offer" : "Send inquiry"}</button></div>`);
  foot.querySelector("[data-send]").onclick = async (e) => {
    const g = (k) => body.querySelector(`[data-${k}]`)?.value.trim() || ""; e.target.disabled = true;
    try {
      let idUrl = ""; const f = q("id")?.files?.[0];
      if (f && g("loc")) { e.target.textContent = "Uploading ID…"; idUrl = await uploadPrivateImage(store.storeId, C.auth.currentUser.uid, f, { max: 1400, name: `inqid_${Date.now()}` }); }
      const det = g("details") || (isOffer ? readOffer(body).deliverables : "");
      const r = await C.call("inquirySend", { slug: C.slug, ...(isOffer ? { offer: readOffer(body) } : {}), brief: { kind: isOffer ? "Brand collab / content" : g("kind"), brand: g("brand"), platform: g("platform"), date: g("date"), deadline: g("deadline"), budget: g("budget"), location: g("loc"), pin: g("loc") ? g("pin") : "", idUrl, rush: !!q("rush")?.checked, deliverables: g("del") || (isOffer ? readOffer(body).deliverables : ""), details: det } , customer: { name: g("name"), phone: g("phone"), email: g("email"), messenger: readMsgr(body) } });
      C.saveLocal({ customer: { ...(C.loadLocal().customer || {}), name: g("name"), phone: g("phone"), messenger: readMsgr(body) }, lastInquiry: { id: r.id, storeId: r.storeId, at: Date.now() } });
      C.closeSheet(); renderInquiry(C, { id: r.id, storeId: r.storeId });
    } catch (x) { body.querySelector("[data-err]").innerHTML = `<div class="c-alert error">${esc(x.message)}</div>`; e.target.disabled = false; e.target.textContent = isOffer ? "Send offer" : "Send inquiry"; }
  };
  C.openSheet(isOffer ? "Make an offer" : "Request a quote", body, foot, store.name);
}

export function renderInquiry(ctx, rec) {
  C = ctx; css(); const { esc, html, money, store } = C; unsub?.(); clearInterval(tick);
  unsub = onSnapshot(doc(C.db, "stores", rec.storeId, "inquiries", rec.id), (snap) => {
    if (!snap.exists()) return;
    const q = snap.data();
    if (q.kind === "xdeal") { // business viewing its X-Deal from the creator's page
      C.app.innerHTML = ""; const st = X_ST[q.status] || ["", q.status];
      const root = html(`<div class="c-page"><div class="c-status"><div class="c-ticket main"><div class="eyebrow">X-Deal with ${esc(store.name)}</div><div class="c-orderno" style="font-size:2rem">${esc(q.code || "")}</div><div class="c-when">${st[0]} ${esc(st[1])}</div></div><div class="c-ticket">${xdealHTML(q)}<div data-acts></div></div><button class="c-btn ghost block" data-back>‹ Back to ${esc(store.name)}</button></div></div>`);
      C.app.appendChild(root); root.querySelector("[data-acts]").appendChild(xdealActions(q, "business", { storeId: rec.storeId, id: rec.id, toast: (m) => C.toast(m) }));
      root.querySelector("[data-back]").onclick = () => { unsub?.(); C.back(); }; return;
    }
    const [ic, lab] = ST[q.status] || ["", q.status]; const Q = q.quote; const pays = (store.payments || []).filter((m) => m.type !== "cash" && m.type !== "card");
    const lim = Q?.revisions ?? 2; const left = Math.max(0, lim - (q.revisionsUsed || 0));
    const last = (q.offers || []).slice(-1)[0]; const R = Q?.rush;
    C.app.innerHTML = "";
    const root = html(`<div class="c-page"><div class="c-status">
      <div class="c-ticket main"><div class="eyebrow">Inquiry</div><div class="c-orderno" style="font-size:2rem">${esc(q.code || "")}</div><div class="c-when">${ic} ${esc(lab)}</div>
        <div class="small muted">${esc(q.brief?.kind || "")}${q.brief?.brand ? ` · ${esc(q.brief.brand)}` : ""}${q.brief?.date ? ` · ${fmtD(q.brief.date)}` : ""}</div></div>
      ${q.status === "new" ? `<div class="c-alert">We got your brief. You'll get a quote here — keep this page (it updates on its own).</div>` : ""}
      ${q.status === "declined" ? `<div class="c-alert warn">${esc(q.reason || "Sorry, not available for this one.")}</div>` : ""}
      ${q.status === "negotiating" ? `<div class="c-ticket"><div class="eyebrow">💬 Offers</div>${offersHTML(q, esc, "client")}
        ${last?.from === "creator" ? `<p class="small">The creator sent a counter-offer.</p><button class="c-btn brand block" data-accoffer>✓ Accept ${esc(offerLine(last))}</button><div class="row" style="gap:6px;margin-top:6px"><button class="c-btn ghost" style="flex:1" data-counter>↩ Counter</button><button class="c-btn ghost" style="flex:1" data-decline>Decline</button></div>` : `<p class="small muted">Waiting for the creator to accept, decline or counter…</p><button class="c-btn ghost block" data-counter>Change my offer</button>`}</div>` : ""}
      ${R && ["accepted", "in_progress"].includes(q.status) && !R.done ? `<div class="c-alert">⚡ Rush job — ${R.dueAt ? `due in <span class="cd ${R.dueAt < Date.now() ? "late" : ""}" data-cd="${R.dueAt}">${countdown(R.dueAt)}</span>` : `the ${R.hours}-hour clock starts once your downpayment is confirmed`}. ${store.creator?.rushMiss ? `If it's late: ${{ refund: `the rush fee (${peso(R.fee)}) is refunded`, discount: `${store.creator.rushMissPct || 10}% off your next booking`, both: `rush fee refunded + ${store.creator.rushMissPct || 10}% off your next booking` }[store.creator.rushMiss] || ""}.` : ""}</div>` : ""}
      ${R?.done ? `<div class="c-alert ${R.missed ? "warn" : ""}">${R.missed ? "⏰ The rush deadline was missed." : "⚡ Rush delivered on time."}</div>` : ""}
      ${q.refund ? `<div class="c-alert ${q.refund.status === "sent" ? "" : "warn"}">💸 Refund ${peso(q.refund.amount)} — ${esc(q.refund.reason || "")} · ${q.refund.status === "sent" ? "sent ✓" : "being processed"}</div>` : ""}
      ${q.creatorMessenger && !["declined"].includes(q.status) ? `<a class="c-btn ghost block" href="${esc(q.creatorMessenger)}" target="_blank" rel="noopener">💬 Message ${esc(store.name)} on Messenger</a>` : ""}
      ${q.nextDiscount ? `<div class="c-alert">🎟 You get <b>${q.nextDiscount.percent}% off</b> your next booking with ${esc(store.name)} — show code <b>${esc(q.code)}</b>.</div>` : ""}
      ${Q ? `<div class="c-ticket"><div class="eyebrow">💬 Quote${Q.validUntil && q.status === "quoted" ? ` · valid until ${new Date(Q.validUntil).toLocaleDateString("en-PH", { month: "short", day: "numeric" })}` : ""}</div>
        ${Q.lines.map((l) => `<div class="c-mini"><span>${esc(l.name)}</span><span class="amt">${l.price ? money(l.price) : "—"}</span></div>`).join("")}
        <div class="c-total big"><span>Total</span><span>${money(Q.total)}</span></div>
        ${Q.dpPercent ? `<div class="c-mini small"><span>Downpayment (${Q.dpPercent}%) — locks your date</span><b>${money((Q.total * Q.dpPercent) / 100)}</b></div>` : ""}
        <div class="c-mini small"><span>Revisions included</span><b>${lim}</b></div>${Q.date ? `<div class="c-mini small"><span>Date</span><b>${fmtD(Q.date)}</b></div>` : ""}${Q.usage ? `<div class="c-mini small"><span>Usage rights</span><b>${esc(Q.usage)}</b></div>` : ""}
        ${(q.deliverables || []).length ? `<div class="small muted" style="margin-top:6px">Deliverables: ${q.deliverables.map((d) => esc(d.name) + (d.due ? ` (by ${fmtD(d.due)})` : "")).join(" · ")}</div>` : ""}
        ${Q.note ? `<p class="small">${esc(Q.note)}</p>` : ""}
        ${q.contract ? `<button class="c-btn ghost block" data-contract style="margin-top:6px">📄 View our agreement</button>` : ""}
        ${["accepted", "in_progress"].includes(q.status) && Q.date ? `<button class="c-btn ghost block" data-move style="margin-top:6px">📅 Move the date${store.bookingPolicy?.reschedule?.fee ? ` (fee ${store.bookingPolicy.reschedule.feeType === "percent" ? store.bookingPolicy.reschedule.fee + "%" : peso(store.bookingPolicy.reschedule.fee)})` : ""}</button>` : ""}</div>` : ""}
      ${q.status === "quoted" ? `<div class="c-ticket"><div class="eyebrow">Accept the quote</div>${Q.terms ? `<div class="waiver-text">${esc(Q.terms)}</div>` : ""}<label class="c-agree"><input type="checkbox" data-terms/> I accept the terms</label>
        ${Q.dpPercent ? `${pays.length ? `<div class="c-pick" data-pays>${pays.map((m, i) => `<button type="button" data-pm="${esc(m.name)}" class="${i ? "" : "on"}"><b>${esc(m.name)}</b><span>${esc(m.number || "")}${m.accountName ? " · " + esc(m.accountName) : ""}</span></button>`).join("")}</div>` : ""}<label>Downpayment reference no.</label><input data-ref maxlength="60" placeholder="e.g. 1234 567 890"/>` : ""}
        <button class="c-btn brand block" data-accept style="margin-top:8px">Accept${Q.dpPercent ? " & send downpayment" : ""}</button><button class="c-btn ghost block" data-decline style="margin-top:6px">No thanks</button></div>` : ""}
      ${q.dp?.status === "rejected" ? `<div class="c-alert error">Downpayment not found: ${esc(q.dp.reason || "")} — please check the reference number.</div>` : ""}
      ${(q.checkins || []).length && ["in_progress", "accepted"].includes(q.status) ? `<div class="c-alert">📍 ${{ arrived: "The creator arrived", safe: "Creator checked in", left: "The creator finished and left", sos: "Creator asked for help" }[q.checkins.slice(-1)[0].kind]} · ${new Date(q.checkins.slice(-1)[0].at).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}</div>` : ""}
      ${(q.deliverables || []).length && ["in_progress", "delivered", "done"].includes(q.status) ? `<div class="c-ticket"><div class="eyebrow">📦 Deliverables · ${left} revision${left === 1 ? "" : "s"} left</div>${q.deliverables.map((d) => { const v = (d.versions || []).slice(-1)[0]; const open = d.status !== "approved" && !d.deliveredAt && d.due; return `<div style="border-top:1px solid #eee;padding:8px 0"><div class="row between"><b>${esc(d.name)}</b><span class="pill ${d.status === "approved" ? "ok" : d.status === "review" ? "wait" : ""}">${{ todo: "in progress", review: "ready to review", revision: "revising", approved: "approved" }[d.status] || d.status}</span></div>${d.due ? `<div class="small muted">Due ${fmtD(d.due)} ${open ? `<span class="cd ${dueMs(d.due) < Date.now() ? "late" : ""}" data-cd="${dueMs(d.due)}">${countdown(dueMs(d.due))}</span>` : d.late ? "· delivered late" : d.deliveredAt ? "· on time ✓" : ""}</div>` : ""}${v ? `<a class="c-btn ghost block" href="${esc(v.link)}" target="_blank" rel="noopener" style="margin-top:6px">▶ Open ${v.final ? "final" : `draft ${(d.versions || []).length}`}</a>${v.note ? `<div class="small">${esc(v.note)}</div>` : ""}` : ""}${d.post ? `<div class="small" style="margin-top:6px">📣 Posted: <a href="${esc(d.post.link)}" target="_blank" rel="noopener">view post</a>${d.post.views ? ` · 👁 ${Number(d.post.views).toLocaleString("en-PH")}` : ""}${d.post.likes ? ` · ❤ ${Number(d.post.likes).toLocaleString("en-PH")}` : ""}</div>` : ""}${d.status === "review" ? `<div class="row" style="gap:6px;margin-top:6px"><button class="c-btn brand" style="flex:1" data-ok="${d.id}">👍 Approve</button><button class="c-btn ghost" style="flex:1" data-rev="${d.id}" ${left ? "" : "disabled"}>✏️ Revision</button></div>` : ""}</div>`; }).join("")}</div>` : ""}
      ${q.status === "done" && !q.review ? `<div class="c-ticket"><div class="eyebrow">⭐ How did it go?</div><div class="c-chips" data-stars>${[5, 4, 3, 2, 1].map((n) => `<button type="button" data-star="${n}" class="chip ${n === 5 ? "on" : ""}">${n} ★</button>`).join("")}</div><label>Results (optional)</label><input data-result maxlength="200" placeholder="e.g. Sales up 40% that week · 50K views"/><label>Comment</label><textarea data-comment rows="2" maxlength="500"></textarea><button class="c-btn brand block" data-review style="margin-top:8px">Post review</button></div>` : ""}
      ${q.review ? `<div class="c-alert">⭐ ${"★".repeat(q.review.rating)} — thanks for your review!</div>` : ""}
      ${Q ? `<div class="c-ticket"><div class="c-mini"><span>Paid</span><span class="amt">${money(q.paidAmount || 0)}</span></div><div class="c-mini"><span><b>Balance</b></span><span class="amt"><b>${money(Math.max(0, (Q.total || 0) - (q.paidAmount || 0)))}</b></span></div></div>` : ""}
      <button class="c-btn ghost block" data-back>‹ Back to ${esc(store.name)}</button>
      <p class="muted small" style="text-align:center">This page updates on its own and stays on this phone.</p></div></div>`);
    C.app.appendChild(root);
    clearInterval(tick); tick = setInterval(() => root.querySelectorAll("[data-cd]").forEach((el) => { const t = Number(el.dataset.cd); el.textContent = countdown(t); el.classList.toggle("late", t < Date.now()); }), 30000);
    const act = (b) => C.call("inquiryAction", { storeId: rec.storeId, id: rec.id, ...b }).catch((x) => C.toast(x.message));
    const g = (s) => root.querySelector(s);
    root.querySelectorAll("[data-pm]").forEach((b) => (b.onclick = () => root.querySelectorAll("[data-pm]").forEach((x) => x.classList.toggle("on", x === b))));
    root.querySelectorAll("[data-star]").forEach((b) => (b.onclick = () => root.querySelectorAll("[data-star]").forEach((x) => x.classList.toggle("on", x === b))));
    g("[data-accept]")?.addEventListener("click", () => { if (!g("[data-terms]").checked) return C.toast("Please accept the terms."); act({ action: "accept", terms: true, refNo: g("[data-ref]")?.value.trim() || "", method: g("[data-pm].on")?.dataset.pm || "GCash" }); });
    g("[data-decline]")?.addEventListener("click", () => { if (confirm("Decline?")) act({ action: "decline" }); });
    g("[data-accoffer]")?.addEventListener("click", () => act({ action: "acceptOffer" }));
    g("[data-counter]")?.addEventListener("click", () => { const b = html(`<div>${offerFields(esc, last || {})}</div>`); const f = html(`<div><button class="c-btn brand block">Send counter-offer</button></div>`); f.querySelector("button").onclick = async () => { await act({ action: "counter", offer: readOffer(b) }); C.closeSheet(); }; C.openSheet("Your counter-offer", b, f, store.name); });
    g("[data-move]")?.addEventListener("click", () => { const nd = prompt("New date (YYYY-MM-DD):", Q.date); if (nd) act({ action: "reschedule", date: nd }); });
    g("[data-contract]")?.addEventListener("click", () => { const k = q.contract; const b = html(`<div class="small"><p><b>${esc(store.name)}</b> and <b>${esc(k.client)}</b> agreed on ${new Date(k.acceptedAt).toLocaleString("en-PH")}:</p>${k.lines.map((l) => `<div class="c-mini"><span>${esc(l.name)}</span><b>${l.price ? money(l.price) : "—"}</b></div>`).join("")}<div class="c-total"><span>Total</span><span>${money(k.total)}</span></div><p>Downpayment ${k.dpPercent}% · ${k.revisions} revision(s)${k.date ? ` · ${fmtD(k.date)}` : ""}${k.rush ? ` · rush ${k.rush.hours} h` : ""}${k.usage ? ` · usage: ${esc(k.usage)}` : ""}</p>${k.terms ? `<div class="waiver-text">${esc(k.terms)}</div>` : ""}<p class="muted">Code ${esc(q.code)} · accepted online on TapTayo.</p></div>`); C.openSheet("Our agreement", b, html(`<div><button class="c-btn ghost block" onclick="window.print()">🖨 Print / save PDF</button></div>`), store.name); });
    g("[data-review]")?.addEventListener("click", () => act({ action: "review", rating: Number(g("[data-star].on")?.dataset.star || 5), result: g("[data-result]").value.trim(), comment: g("[data-comment]").value.trim() }));
    root.querySelectorAll("[data-ok]").forEach((b) => (b.onclick = () => act({ action: "approve", deliverableId: b.dataset.ok })));
    root.querySelectorAll("[data-rev]").forEach((b) => (b.onclick = () => { const n = prompt("What should be changed?"); if (n) act({ action: "revision", deliverableId: b.dataset.rev, note: n }); }));
    g("[data-back]").onclick = () => { unsub?.(); clearInterval(tick); C.saveLocal({ lastInquiryOpen: false }); C.back(); };
  }, () => C.toast("Open this page on the phone you used to send the inquiry."));
}
