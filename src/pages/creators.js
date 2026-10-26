// 🎥 Invite a creator — for cafés, salons, spas, laundries, stays: find vloggers / marketers in the TapTayo creator directory,
// send an offer (talent fee + transport + freebies like "free food up to 4 pax"), see counter-offers and accept.
import { call, auth } from "../firebase.js";
import { esc, money, html, toast, openModal, closeModal } from "../ui.js";
import { offerFields, readOffer, offerLine, offersHTML, NEG_CSS } from "../inquiry.js";
import { uploadPrivateImage } from "../upload.js";
import { xdealHTML, xdealActions, xdealForm, X_ST } from "../xdeal.js";
import { storage } from "../storage.js";
import { ref as sref, uploadBytesResumable } from "firebase/storage";

const ST = { new: "📨 Sent", negotiating: "💬 Negotiating", quoted: "💬 Quote ready — accept it", accepted: "⏳ DP being checked", in_progress: "🎬 In progress", delivered: "✅ Delivered", done: "🏁 Done", declined: "✕ Declined" };
const kfmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : n >= 1e3 ? Math.round(n / 1e3) + "K" : String(n || 0));

export const NICHE_FOR = { cafe: "Food", restaurant: "Food", salon: "Beauty", spa: "Beauty", laundry: "Lifestyle", stay: "Travel" };
/** a creator card — portfolio first (UGC creators win on their work, not followers) */
export function creatorCard(c, i, esc, money) {
  const P = (c.creator.portfolio || []).slice(0, 4);
  const plain = (s) => String(s || "").replace(/\p{Extended_Pictographic}/gu, "").replace(/\s+/g, " ").trim();
  return `<div class="cr-card">
    <div class="cr-top">${c.logoUrl ? `<img src="${esc(c.logoUrl)}" alt=""/>` : `<div class="cr-ph">${esc((c.name || "?").trim()[0] || "·")}</div>`}
    <div style="flex:1;min-width:0"><div class="row between wrap"><b>${esc(c.name)}${c.creator.verified ? ` <span class="cr-ok">Verified</span>` : ""}</b><span class="small">${c.rating ? `${Number(c.rating.avg).toFixed(1)} (${c.rating.n})` : ""}</span></div>
    <div class="row wrap" style="gap:4px;margin:6px 0">${c.rising ? `<span class="pill">Rising</span>` : ""}${c.creator.ugc ? `<span class="pill">UGC</span>` : ""}${c.creator.sideJob ? `<span class="pill">${esc(plain(c.creator.sideJob))}</span>` : ""}${c.creator.paused ? `<span class="pill">On a break</span>` : ""}</div>
    <div class="small muted">${(c.creator.niches || []).map((n) => esc(plain(n))).join(" · ")}${c.creator.city ? ` · ${esc(c.creator.city)}` : ""}${c.creator.radiusKm ? ` · ${c.creator.radiusKm} km` : ""}</div>
    <div class="small cr-meta">${(c.platforms || []).map((p) => `${esc(plain(p.platform))} ${esc(p.followers)}`).filter(Boolean).join(" · ")}${c.creator.onTime ? ` · ${c.creator.onTime.rate}% on time` : ""}${c.creator.projectsDone ? ` · ${c.creator.projectsDone} done` : ""}${c.creator.xDone ? ` · ${c.creator.xDone} X-Deals` : ""}${c.creator.kyc ? " · ID on file" : ""}${c.from ? ` · from ${money(c.from)}` : ""}</div></div></div>
    ${P.length ? `<div class="cr-photos">${P.map((x) => x.thumb ? `<img src="${esc(x.thumb)}" alt="${esc(x.label || "")}"/>` : `<span>Video</span>`).join("")}</div>` : ""}
    ${c.creator.pitch ? `<div class="small" style="margin-top:8px">${esc(c.creator.pitch.slice(0, 140))}${c.creator.pitch.length > 140 ? "…" : ""}</div>` : ""}
    <div class="cr-acts">${c.creator.xdeal && !c.creator.paused ? `<button class="btn sm" data-xd="${i}">X-Deal</button>` : ""}${c.creator.offers && !c.creator.paused ? `<button class="btn sm ghost" data-offer="${i}">Make an offer</button>` : ""}<a class="btn sm ghost" href="/m/${esc(c.slug)}" target="_blank" rel="noopener">View page</a></div>${c.creator.minFee ? `<div class="small muted" style="margin-top:6px">Minimum ${money(c.creator.minFee)}</div>` : ""}</div>`;
}
export function renderCreatorsPage(root, ctx) {
  const { store } = ctx;
  if (!document.getElementById("negcss")) { const s = document.createElement("style"); s.id = "negcss"; s.textContent = NEG_CSS; document.head.appendChild(s); }
  const myNiche = NICHE_FOR[store.businessType] || NICHE_FOR[store.mode === "table" ? "cafe" : store.mode] || "";
  const myCity = store.contact?.city || "";
  root.innerHTML = `<div class="tile"><div class="row between wrap"><h3 style="margin:0">Suggested for ${esc(store.name)}</h3><a class="small" href="/collab/" target="_blank" rel="noopener">TapTayo Collab</a></div><p class="small muted" style="margin:4px 0 0">${myNiche ? `${esc(myNiche)} creators` : "Creators"}${myCity ? ` near ${esc(myCity)}` : ""}. Picked by their work, results and on-time rate.</p><div data-sugg><p class="muted small">Loading…</p></div></div>
    <div class="tile"><h3 style="margin:0">Invite a creator</h3><p class="small muted">Get creators to feature ${esc(store.name)}. Make an offer — for example free food for 4 plus transport. They can accept, decline, or send a counter-offer.</p>
    <div class="row wrap" style="gap:6px"><input data-q placeholder="Search name or niche" style="flex:1;min-width:160px"/><select data-niche><option value="">All niches</option>${["Food", "Lifestyle", "Beauty", "Travel", "Family", "Fitness", "Tech", "Fashion", "Photography", "Events", "UGC"].map((n) => `<option>${n}</option>`).join("")}</select><input data-city placeholder="City" style="width:120px"/><label class="check small" style="margin:0"><input type="checkbox" data-ugc/> UGC only</label><label class="check small" style="margin:0"><input type="checkbox" data-xonly/> X-Deal only</label><button class="btn" data-go>Search</button></div>
    <div data-list style="margin-top:10px"><p class="muted small">Loading creators…</p></div></div>
    <div class="tile"><div class="row between wrap"><h3 style="margin:0">📣 Open collab posts</h3><button class="btn sm" data-newpost>+ Post a collab</button></div><p class="small muted">Post what you need (e.g. “3 food UGC videos, ₱1,200 each”) — creators apply, you pick. Shown on TapTayo Collab.</p><div data-posts><p class="muted small">Loading…</p></div></div>
    <div class="tile" data-swaptile><div class="row between wrap"><h3 style="margin:0">🤝 Business-to-business video swaps</h3><label class="check small" style="margin:0"><input type="checkbox" data-swapon ${store.settings?.collab?.swap ? "checked" : ""}/> Open to swaps</label></div>
      <p class="small muted">Make a video for another business, they make one for you. Videos unlock only when BOTH have uploaded — then both can download. Free for businesses.</p>
      <div class="row wrap" style="gap:6px"><input data-swq placeholder="Find a business to swap with" style="flex:1;min-width:160px"/><button class="btn sm" data-swgo>Search</button></div><div data-swlist style="margin-top:8px"></div>
      <h4 style="margin:14px 0 4px">My swaps</h4><div data-swmine class="small muted">Loading…</div></div>
    <div class="tile"><div class="row between"><h3 style="margin:0">📤 My offers</h3><button class="btn sm ghost" data-ref>↻</button></div><div data-mine><p class="muted small">Loading…</p></div></div>`;
  const g = (s) => root.querySelector(s);
  const search = async () => {
    g("[data-list]").innerHTML = `<p class="muted small">Searching…</p>`;
    try {
      const niche = g("[data-niche]").value; const L = await call("creatorDirectory", { q: g("[data-q]").value.trim(), niche: niche === "UGC" ? "" : niche, ugc: niche === "UGC" || g("[data-ugc]").checked, xdeal: g("[data-xonly]").checked, city: g("[data-city]").value.trim() });
      g("[data-list]").innerHTML = L.map((c, i) => creatorCard(c, i, esc, money)).join("") || `<p class="muted small">No creators found. Try another niche or city.</p>`;
      g("[data-list]").querySelectorAll("[data-offer]").forEach((b) => (b.onclick = () => offerForm(L[Number(b.dataset.offer)])));
      g("[data-list]").querySelectorAll("[data-xd]").forEach((b) => (b.onclick = () => xdealForm(L[Number(b.dataset.xd)], store, { html, openModal, closeModal, toast })));
    } catch (e) { g("[data-list]").innerHTML = `<p class="small">${esc(e.message)}</p>`; }
  };
  const mine = async () => {
    try {
      const L = await call("myCreatorOffers", {});
      g("[data-mine]").innerHTML = L.map((x, i) => { if (x.kind === "xdeal") { const st = X_ST[x.status] || ["", x.status]; return `<div style="border:1px solid var(--line);border-left:4px solid #16a34a;border-radius:12px;padding:8px 10px;margin:6px 0"><div class="row between"><b>🎁 ${esc(x.creator?.name || "")}</b><span class="small">${st[0]} ${esc(st[1])}</span></div><div class="small muted">${esc(x.code)} · ${esc(x.item?.desc || "")} · ${money(x.item?.value || 0)}${x.tipOffer ? ` + ${money(x.tipOffer)} tip` : ""}</div><div class="row wrap" style="gap:6px;margin-top:6px"><button class="btn sm" data-xopen="${i}">Open</button></div></div>`; } const last = (x.offers || []).slice(-1)[0]; return `<div style="border:1px solid var(--line);border-radius:12px;padding:8px 10px;margin:6px 0"><div class="row between"><b>${esc(x.creator?.name || "")}</b><span class="small">${ST[x.status] || x.status}</span></div><div class="small muted">${esc(x.code)}${x.brief.date ? ` · 📅 ${esc(x.brief.date)}` : ""}${x.quote ? ` · ${money(x.quote.total)}` : last ? ` · ${esc(offerLine(last))}` : ""}</div>
        ${x.status === "negotiating" && last?.from === "creator" ? `<div class="small" style="color:#0891b2;font-weight:700">↩ The creator sent a counter-offer</div>` : ""}<div class="row wrap" style="gap:6px;margin-top:6px">${x.status === "negotiating" ? `<button class="btn sm ghost" data-neg="${i}">💬 See offers</button>` : ""}<a class="btn sm ${["quoted"].includes(x.status) ? "" : "ghost"}" href="/m/${esc(x.creator?.slug || "")}?inq=${esc(x.id)}" target="_blank" rel="noopener">Open ›</a></div></div>`; }).join("") || `<p class="muted small">No offers yet. Find a creator above and make an offer.</p>`;
      root.querySelectorAll("[data-neg]").forEach((b) => (b.onclick = () => negotiate(L[Number(b.dataset.neg)])));
      root.querySelectorAll("[data-xopen]").forEach((b) => (b.onclick = () => { const x = L[Number(b.dataset.xopen)]; const body = html(`<div>${xdealHTML(x)}</div>`); body.appendChild(xdealActions(x, "business", { storeId: x.storeId, id: x.id, toast, onDone: () => { closeModal(); mine(); } })); openModal({ title: `🎁 ${x.creator?.name || ""} · ${x.code}`, body, wide: true }); }));
    } catch (e) { g("[data-mine]").innerHTML = `<p class="small">${esc(e.message)}</p>`; }
  };
  function negotiate(x) {
    const last = (x.offers || []).slice(-1)[0];
    const body = html(`<div>${offersHTML(x, esc, "client")}${last?.from === "creator" ? `<div class="row wrap" style="gap:6px;margin-top:10px"><button class="btn" data-a>✓ Accept ${esc(offerLine(last))}</button><button class="btn ghost" data-c>↩ Counter</button><button class="btn ghost" data-d>Decline</button></div>` : `<p class="small muted">Waiting for the creator…</p>`}<div data-cbox></div></div>`);
    const A = (b) => call("inquiryAction", { storeId: x.storeId, id: x.id, ...b });
    body.querySelector("[data-a]")?.addEventListener("click", async () => { try { await A({ action: "acceptOffer" }); toast("Accepted — open it to accept the terms and pay the downpayment"); closeModal(); window.open(`/m/${x.creator.slug}?inq=${x.id}`, "_blank"); mine(); } catch (e) { toast(e.message, "error"); } });
    body.querySelector("[data-d]")?.addEventListener("click", async () => { if (!confirm("Decline the counter-offer?")) return; try { await A({ action: "decline" }); closeModal(); mine(); } catch (e) { toast(e.message, "error"); } });
    body.querySelector("[data-c]")?.addEventListener("click", () => { const cb = body.querySelector("[data-cbox]"); cb.innerHTML = `${offerFields(esc, last)}<button class="btn" data-s style="margin-top:8px">Send counter-offer</button>`; cb.querySelector("[data-s]").onclick = async () => { try { await A({ action: "counter", offer: readOffer(cb) }); toast("Counter-offer sent"); closeModal(); mine(); } catch (e) { toast(e.message, "error"); } }; });
    openModal({ title: `💬 ${x.creator?.name || "Creator"} · ${x.code}`, body });
  }
  function offerForm(c) {
    const addr = [store.contact?.address, store.contact?.city].filter(Boolean).join(", ");
    const body = html(`<div><p class="small">To <b>${esc(c.name)}</b>${c.creator.minFee ? ` · minimum ${money(c.creator.minFee)} (fee + transport)` : ""}</p>${offerFields(esc, { transpo: 1000, freebies: store.mode === "table" ? "Free food up to 4 pax" : store.mode === "stay" ? "Free 1-night stay for 2" : "Free service for the creator", deliverables: "1 TikTok / Reel featuring us" })}
      <div class="row" style="gap:8px"><div style="flex:1"><label>Preferred date</label><input type="date" data-date/></div><div style="flex:1"><label>Platform</label><input data-plat placeholder="TikTok, IG, FB…"/></div></div>
      <label>Where</label><input data-loc value="${esc(addr)}"/><div style="display:flex;gap:6px;margin-top:6px"><input data-pin placeholder="Google Maps link of your shop" value="${esc(store.contact?.mapUrl || "")}" style="flex:1"/><button type="button" class="btn ghost sm" data-my>📍 Here</button></div>
      ${c.creator.idOnSite ? `<label>Valid ID of the person meeting the creator <span class="muted small">(the creator asks this for safety)</span></label><input type="file" accept="image/*" data-id/>` : ""}
      <label>Your name & mobile</label><div class="row" style="gap:6px"><input data-nm value="${esc(ctx.staffName || auth.currentUser?.displayName || "")}" placeholder="Name" style="flex:1"/><input data-ph value="${esc(store.contact?.phone || "")}" placeholder="09…" style="flex:1"/></div>
      <label>Your Messenger <span class="muted small">(optional)</span></label><input data-msgr value="${esc(store.contact?.messenger || "")}" placeholder="m.me/yourpage"/>
      <label>Message</label><textarea data-det rows="3">Hi! We'd love you to feature ${esc(store.name)}. </textarea><div data-err></div></div>`);
    const q = (k) => body.querySelector(`[data-${k}]`);
    q("my").onclick = () => navigator.geolocation?.getCurrentPosition((p) => (q("pin").value = `https://maps.google.com/?q=${p.coords.latitude.toFixed(6)},${p.coords.longitude.toFixed(6)}`), () => toast("Couldn't get the location"));
    const foot = html(`<div class="row" style="gap:8px"><button class="btn" data-s>Send offer</button><button class="btn ghost" data-x>Cancel</button></div>`);
    foot.querySelector("[data-x]").onclick = closeModal;
    foot.querySelector("[data-s]").onclick = async (e) => {
      e.target.disabled = true;
      try {
        let idUrl = ""; const f = q("id")?.files?.[0]; if (f) { e.target.textContent = "Uploading ID…"; idUrl = await uploadPrivateImage(c.storeId, auth.currentUser.uid, f, { max: 1400, name: `inqid_${Date.now()}` }); }
        const o = readOffer(body);
        await call("creatorOffer", { slug: c.slug, offer: o, contactName: q("nm").value.trim(), phone: q("ph").value.trim(), messenger: q("msgr").value.trim(), brief: { date: q("date").value, platform: q("plat").value.trim(), location: q("loc").value.trim(), pin: q("pin").value.trim(), idUrl, deliverables: o.deliverables, details: q("det").value.trim() || o.deliverables || "Feature our shop" } });
        toast("Offer sent 💸 — you'll see their answer under My offers"); closeModal(); mine();
      } catch (x) { q("err").innerHTML = `<div class="alert">${esc(x.message)}</div>`; e.target.disabled = false; e.target.textContent = "Send offer"; }
    };
    openModal({ title: "💸 Make an offer", body, footer: foot });
  }
  const suggest = async () => {
    try {
      let L = await call("creatorDirectory", { niche: myNiche, city: myCity, limit: 6 });
      if (L.length < 3) L = [...L, ...(await call("creatorDirectory", { niche: myNiche, limit: 6 })).filter((x) => !L.some((y) => y.slug === x.slug))].slice(0, 6);
      if (L.length < 3) L = [...L, ...(await call("creatorDirectory", { limit: 6 })).filter((x) => !L.some((y) => y.slug === x.slug))].slice(0, 6);
      g("[data-sugg]").innerHTML = L.slice(0, 3).map((c, i) => creatorCard(c, i, esc, money)).join("") || `<p class="muted small">No creators yet in your area — post an open collab below so they find you.</p>`;
      g("[data-sugg]").querySelectorAll("[data-offer]").forEach((b) => (b.onclick = () => offerForm(L[Number(b.dataset.offer)])));
      g("[data-sugg]").querySelectorAll("[data-xd]").forEach((b) => (b.onclick = () => xdealForm(L[Number(b.dataset.xd)], store, { html, openModal, closeModal, toast })));
    } catch (e) { g("[data-sugg]").innerHTML = `<p class="small">${esc(e.message)}</p>`; }
  };
  const posts = async () => {
    try {
      const r = await call("collabMine", {}); const P = r.posts || [];
      g("[data-posts]").innerHTML = P.map((p, i) => `<div style="border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin:8px 0"><div class="row between wrap"><b>${esc(p.title)}</b><span class="pill ${p.status === "open" ? "ok" : ""}">${{ open: "Open", filled: "Filled", closed: "Closed" }[p.status] || p.status}</span></div>
        <div class="small muted">${esc(p.niche)}${p.ugc ? " · UGC" : ""} · ${p.budgetEach ? money(p.budgetEach) + " each" : ""}${p.freebies ? ` + ${esc(p.freebies)}` : ""} · ${p.filled}/${p.slots} picked${p.deadline ? ` · by ${esc(p.deadline)}` : ""}</div>
        ${(p.applicants || []).map((a) => `<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;border-top:1px solid var(--line);padding:6px 0;margin-top:6px">${a.logoUrl ? `<img src="${esc(a.logoUrl)}" alt="" style="width:34px;height:34px;border-radius:50%;object-fit:cover"/>` : "🎥"}<div style="flex:1 1 60%;min-width:180px"><b>${esc(a.creatorName)}</b>${a.verified ? " ✔" : ""} <span class="small muted">· ${money(a.fee)} · ${a.portfolio} samples</span>${a.pitch ? `<div class="small">${esc(a.pitch)}</div>` : ""}</div><a class="btn sm ghost" href="/m/${esc(a.creatorSlug)}" target="_blank" rel="noopener">View</a>${a.status === "applied" ? `<button class="btn sm" data-pick="${i}:${esc(a.creatorStoreId)}">Pick</button><button class="btn sm ghost" data-nope="${i}:${esc(a.creatorStoreId)}">✕</button>` : `<span class="small">${a.status === "picked" ? "🎉 Picked" : "Declined"}</span>`}</div>`).join("") || `<div class="small muted" style="margin-top:6px">No applicants yet.</div>`}
        <div style="margin-top:6px">${p.status === "open" ? `<button class="btn sm ghost" data-close="${p.id}">Close post</button>` : p.status === "closed" ? `<button class="btn sm ghost" data-reopen="${p.id}">Reopen</button>` : ""}</div></div>`).join("") || `<p class="muted small">No posts yet.</p>`;
      g("[data-posts]").querySelectorAll("[data-pick],[data-nope]").forEach((b) => (b.onclick = async () => { const [i, sid] = (b.dataset.pick || b.dataset.nope).split(":"); try { const r2 = await call("collabDecide", { id: P[Number(i)].id, creatorStoreId: sid, action: b.dataset.pick ? "pick" : "decline", phone: store.contact?.phone || "" }); toast(b.dataset.pick ? "Picked 🎉 — it's now an offer under My offers (terms + DP as usual)" : "Declined"); posts(); mine(); void r2; } catch (x) { toast(x.message, "error"); } }));
      g("[data-posts]").querySelectorAll("[data-close],[data-reopen]").forEach((b) => (b.onclick = async () => { try { await call("collabPost", { action: b.dataset.close ? "close" : "reopen", id: b.dataset.close || b.dataset.reopen }); posts(); } catch (x) { toast(x.message, "error"); } }));
    } catch (e) { g("[data-posts]").innerHTML = `<p class="small">${esc(e.message)}</p>`; }
  };
  g("[data-newpost]").onclick = () => {
    const body = html(`<div><label>What do you need?</label><input data-t maxlength="90" placeholder="3 food UGC videos for our new menu"/>
      <div class="row" style="gap:8px"><div style="flex:1"><label>Niche</label><select data-n>${["Food", "Lifestyle", "Beauty", "Travel", "Family", "Fitness", "Tech", "Fashion", "Photography", "Events", "UGC"].map((n) => `<option ${n === myNiche ? "selected" : ""}>${n}</option>`).join("")}</select></div><div style="flex:1"><label>How many creators</label><input data-sl type="number" min="1" max="20" value="1"/></div></div>
      <div class="row" style="gap:8px"><div style="flex:1"><label>Budget per creator (₱)</label><input data-b type="number" min="0" placeholder="1500"/></div><div style="flex:1"><label>Deadline</label><input data-dl type="date"/></div></div>
      <label>Freebies</label><input data-f maxlength="160" placeholder="${store.mode === "table" ? "Free food for 2" : store.mode === "stay" ? "Free 1-night stay" : "Free service"}"/>
      <label>Deliverables</label><input data-de maxlength="200" placeholder="1 vertical video + 3 photos"/>
      <label class="check"><input type="checkbox" data-u checked/> UGC is OK (we post the videos on our page — followers don't matter)</label>
      <label class="check"><input type="checkbox" data-os checked/> On-site at our shop</label>
      <label>City</label><input data-c value="${esc(myCity)}"/>
      <label>Details</label><textarea data-dt rows="3" maxlength="1200" placeholder="What to feature, style, references"></textarea><div data-err></div></div>`);
    const foot = html(`<div class="row" style="gap:8px"><button class="btn" data-s>Post collab</button><button class="btn ghost" data-x>Cancel</button></div>`);
    foot.querySelector("[data-x]").onclick = closeModal;
    foot.querySelector("[data-s]").onclick = async (e) => { const q = (k) => body.querySelector(`[data-${k}]`); e.target.disabled = true; try { await call("collabPost", { title: q("t").value, niche: q("n").value, slots: Number(q("sl").value), budgetEach: Number(q("b").value), deadline: q("dl").value, freebies: q("f").value, deliverables: q("de").value, ugc: q("u").checked, onSite: q("os").checked, city: q("c").value, details: q("dt").value }); toast("Posted 📣 — creators can apply now"); closeModal(); posts(); } catch (x) { q("err").innerHTML = `<div class="alert">${esc(x.message)}${/add-on|Pro plan/.test(x.message) ? ` <a href="#billing">Open Billing ›</a>` : ""}</div>`; e.target.disabled = false; } };
    openModal({ title: "📣 Post an open collab", body, footer: foot });
  };
  // ---- B2B swaps
  const eligible = store.mode === "table" || store.mode === "stay" || store.businessType === "products";
  if (!eligible) g("[data-swaptile]").remove();
  else {
    g("[data-swapon]").onchange = async (e) => { try { const { db } = await import("../firebase.js"); const { doc, updateDoc } = await import("firebase/firestore"); await updateDoc(doc(db, "stores", ctx.storeId), { "settings.collab.swap": e.target.checked }); toast(e.target.checked ? "Other businesses can now propose swaps" : "Swaps turned off"); } catch (x) { toast(x.message, "error"); e.target.checked = !e.target.checked; } };
    const swSearch = async () => { try { const L = await call("swapDirectory", { q: g("[data-swq]").value.trim() }); g("[data-swlist]").innerHTML = L.filter((b) => b.storeId !== ctx.storeId).map((b, i) => `<div style="display:flex;gap:10px;align-items:center;border:1px solid var(--line);border-radius:12px;padding:8px 10px;margin:6px 0">${b.logoUrl ? `<img src="${esc(b.logoUrl)}" alt="" style="width:40px;height:40px;border-radius:10px;object-fit:cover"/>` : "🏪"}<div style="flex:1;min-width:0"><b>${esc(b.name)}</b><div class="small muted">${esc(b.tagline || b.city || "")}</div></div><button class="btn sm" data-swp="${i}">Propose swap</button></div>`).join("") || `<p class="small muted">No businesses open to swaps yet.</p>`; g("[data-swlist]").querySelectorAll("[data-swp]").forEach((btn) => (btn.onclick = async () => { const b = L.filter((x) => x.storeId !== ctx.storeId)[Number(btn.dataset.swp)]; const give = prompt(`What video will you make for ${b.name}?`, "1 vertical video (30–60 s) featuring your bestseller at our shop"); if (!give) return; const want = prompt("What video do you want from them?", "1 vertical video (30–60 s) featuring our product"); if (!want) return; try { await call("swapPropose", { slug: b.slug, give, want, deadline: prompt("Deadline (YYYY-MM-DD, optional):", "") || "" }); toast("Swap proposed 🤝"); swMine(); } catch (x) { toast(x.message, "error"); } })); } catch (x) { g("[data-swlist]").innerHTML = `<p class="small">${esc(x.message)}</p>`; } };
    const swMine = async () => { try { const L = await call("swapMine", {}); g("[data-swmine]").innerHTML = L.map((w, i) => { const other = w.mySide === "a" ? w.b : w.a; return `<div style="border:1px solid var(--line);border-radius:12px;padding:8px 10px;margin:6px 0;color:var(--ink,#111)"><div class="row between"><b>🤝 ${esc(other.name)}</b><span class="small">${{ proposed: w.mySide === "b" ? "Wants a swap" : "Waiting for them", accepted: w.unlocked ? "🔓 Unlocked" : "🔒 Upload your video", done: "🏁 Done", declined: "Declined", cancelled: "Cancelled" }[w.status] || w.status}</span></div><div class="small">You make: ${esc(w.mySide === "a" ? w.give : w.want)}<br>They make: ${esc(w.mySide === "a" ? w.want : w.give)}${w.deadline ? `<br>By ${esc(w.deadline)}` : ""}</div><div class="small muted">Your video: ${w.files[w.mySide] ? "uploaded ✓" : "not yet"} · Theirs: ${w.files[w.mySide === "a" ? "b" : "a"] ? "uploaded ✓" : "not yet"}</div><div class="row wrap" style="gap:6px;margin-top:6px">${w.status === "proposed" && w.mySide === "b" ? `<button class="btn sm" data-sa="accept:${i}">Accept</button><button class="btn sm ghost" data-sa="decline:${i}">Decline</button>` : ""}${w.status === "accepted" && !w.files[w.mySide] ? `<button class="btn sm" data-sa="upfile:${i}">⬆ Upload 1080p</button><button class="btn sm ghost" data-sa="uplink:${i}">🔗 Watermarked link</button>` : ""}${w.unlocked ? `<button class="btn sm" data-sa="get:${i}">⬇ Get their video</button>${!w.confirmed[w.mySide] ? `<button class="btn sm ghost" data-sa="confirm:${i}">✓ All good</button>` : ""}` : ""}</div></div>`; }).join("") || "No swaps yet.";
      g("[data-swmine]").querySelectorAll("[data-sa]").forEach((b) => (b.onclick = async () => { const [a, i] = b.dataset.sa.split(":"); const w = L[Number(i)]; try {
        if (a === "upfile") { const f = await new Promise((res) => { const inp = document.createElement("input"); inp.type = "file"; inp.accept = "video/*"; inp.onchange = () => res(inp.files?.[0] || null); inp.click(); }); if (!f) return; if (f.size > 200 * 1024 * 1024) throw new Error("Max 200 MB — export at 1080p."); const path = `swaps/${w.id}/${w.mySide}/v_${Date.now()}.mp4`; toast("Uploading… keep this page open"); await uploadBytesResumable(sref(storage, path), f, { contentType: f.type || "video/mp4" }); const r = await call("swapAction", { id: w.id, action: "upload", file: path }); toast(r.unlocked ? "🔓 Both in — you can download theirs now" : "Uploaded — it unlocks when they upload too"); }
        else if (a === "uplink") { const l = prompt("Drive link of your video (with watermark):"); if (!l) return; const r = await call("swapAction", { id: w.id, action: "upload", link: l }); toast(r.unlocked ? "🔓 Unlocked" : "Saved — unlocks when they upload too"); }
        else if (a === "get") { const r = await call("swapAction", { id: w.id, action: "get" }); if (r.url) window.open(r.url, "_blank"); }
        else await call("swapAction", { id: w.id, action: a });
        swMine(); } catch (x) { toast(x.message, "error"); } }));
    } catch (x) { g("[data-swmine]").innerHTML = esc(x.message); } };
    g("[data-swgo]").onclick = swSearch; swSearch(); swMine();
  }
  g("[data-go]").onclick = search; g("[data-q]").onkeydown = (e) => e.key === "Enter" && search(); g("[data-ref]").onclick = mine;
  call("collabStatus", {}).then((c) => { if (c.live || store.settings?.demo) return; const b = html(`<div class="tile collab-soon"><b>TapTayo Collab</b><div class="small">Coming soon. You can look around now. Offers, X-Deals and swaps open at launch.</div><button class="btn sm" type="button" data-wl>Notify me at launch</button></div>`); b.querySelector("[data-wl]").onclick = async (e) => { try { await call("collabWaitlist", { role: "business", city: store.contact?.city || "" }); e.target.textContent = "You're on the list"; e.target.disabled = true; } catch (x) { toast(x.message, "error"); } }; root.prepend(b); }).catch(() => {});
  suggest(); search(); posts(); mine();
}
