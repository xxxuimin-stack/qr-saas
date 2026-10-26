// Staff app (/staff/) — stylists / technicians on their own phone: my tasks today, accept / start / +min / done,
// duty start/end (accepted by the counter), today's earnings (basic + commission). No cash handling except home-service COD.
import { msgrBtn } from "./msgr.js";
import { applyWording } from "./wording.js";
import { auth, db, call } from "./firebase.js";
import { deviceSignIn, showDeviceSetup, ownerOnStaffBanner } from "./device.js";
import { setShell } from "./appshell.js";
import { onAuthStateChanged } from "firebase/auth";
import { collection, doc, onSnapshot, query, orderBy, where, updateDoc, serverTimestamp, Timestamp } from "firebase/firestore";
import { pinGate, getActiveStaff, clearActiveStaff, tapToStart, chime, watchFeatures, feat } from "./staffauth.js";
import { clientCard, clientFlag } from "./clientcard.js";
import { watchDue, dueCardHTML, bindDueActions } from "./dueback.js";
import { mountStaffNotes } from "./staffpanels.js";
import { apptOp } from "./orderops.js";
import { commissionFor } from "./salonpay.js";
import { homeLinksHTML } from "./contact.js";
import { hydratePrivate } from "./privfiles.js";
import { pushButton, refreshPush, setBadge } from "./pushclient.js";
import { intakeHTML } from "./intake.js";
import { watchMaintenance } from "./maint.js";
import { uploadPrivateImage } from "./upload.js";
watchMaintenance("staff");

const app = document.getElementById("app");
const getLoc = () => new Promise((res) => { if (!navigator.geolocation) return res(null); navigator.geolocation.getCurrentPosition((p) => res(`https://maps.google.com/?q=${p.coords.latitude},${p.coords.longitude}`), () => res(null), { timeout: 6000, enableHighAccuracy: true }); });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/** anti-direct booking: the client's exact address shows only around the job (3 h before → done) */
const addrOpen = (a) => store?.settings?.salon?.protectClients === false || (["confirmed", "in_progress"].includes(a.status) && a.startAt?.toMillis?.() - Date.now() < 3 * 3600000);
const addrHidden = (a) => `<div class="small muted">📍 ${esc(a.homeService?.area || "Home service")} · <i>${a.status === "done" ? "address hidden after the job" : "exact address shows 3 hours before"}</i> 🛡</div>`;
const html = (str) => { const t = document.createElement("template"); t.innerHTML = str.trim(); return t.content.firstElementChild; };
let CUR = "PHP";
const money = (n) => (CUR === "PHP" ? "₱" : CUR + " ") + Number(n || 0).toLocaleString("en-PH", { maximumFractionDigits: 2 });
const fmtT = (d) => d.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" });

let nextUp = [];
let offers = [], offerSeen = null, cdTimer = null, checked = new Set();
let ledger = [];
let storeId, store, me, mine = [], duty = null, staffDoc = null, seen = null, myDue = [], dueOn = false, arrivedSeen = null, arrivedNote = "", myAdv = [];

onAuthStateChanged(auth, async (user) => {
  if (!user || user.isAnonymous) { if (await deviceSignIn()) return; return showDeviceSetup("/staff/"); }
  const claims = (await user.getIdTokenResult(true)).claims;
  if (!claims.storeId) return location.replace("/app/");
  if (claims.role === "owner") ownerOnStaffBanner();
  storeId = claims.storeId;
  onSnapshot(doc(db, "stores", storeId), async (s) => {
    const first = !store; store = { id: storeId, ...s.data() }; applyWording(store); setShell({ app: store.mode === "stay" ? "Caretaker" : store.mode === "salon" ? "Stylist" : "My tasks", mode: store.mode }); CUR = store.settings?.currency || "PHP";
    if (first && store.mode === "stay") { await tapToStart("Tap to open the Caretaker app"); me = getActiveStaff(storeId) || (await pinGate({ storeId, storeName: store.name, requireRoles: ["cleaner"], screenName: "Caretaker app" })); const m = await import("./cleaner.js"); return m.bootCleaner({ app, storeId, store, me }); }
    if (store.mode === "stay") return;
    if (first) watchFeatures(store.slug);
    if (first) { await tapToStart("Tap to open My tasks"); me = getActiveStaff(storeId) || (await pinGate({ storeId, storeName: store.name, requireRoles: ["stylist"], screenName: "Staff app" })); boot(); } else draw();
  });
});

function boot() {
  app.innerHTML = `<div><div id="head"></div><div id="main" class="r-main"></div></div>`;
  mountStaffNotes(storeId);
  const start = new Date(); start.setHours(0, 0, 0, 0); const end = new Date(start.getTime() + 86400000);
  onSnapshot(query(collection(db, "stores", storeId, "appointments"), where("startAt", ">=", Timestamp.fromDate(start)), where("startAt", "<", Timestamp.fromDate(end)), orderBy("startAt")), (snap) => {
    const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    nextUp = all.filter((a) => a.waiting && ["unconfirmed", "pending", "confirmed"].includes(a.status) && a.queue?.staffId === me?.staffId).sort((x, y) => (x.queue?.etaAt || 0) - (y.queue?.etaAt || 0));
    mine = all.filter((a) => a.providerId === me?.staffId && a.status !== "cancelled");
    const fresh = mine.filter((a) => ["pending", "confirmed"].includes(a.status) && !a.acceptedAt).map((a) => a.id);
    if (seen && fresh.some((id) => !seen.has(id))) chime(0.3);
    // my client arrived (checked in from their phone or by the counter)
    const here = mine.filter((a) => a.arrivedAt && ["pending", "confirmed"].includes(a.status)).map((a) => a.id);
    if (arrivedSeen && here.some((id) => !arrivedSeen.has(id))) { chime(0.35); const a = mine.find((x) => here.includes(x.id) && !arrivedSeen.has(x.id)); arrivedNote = `📍 ${a?.customer?.name || "Your client"} is here`; setTimeout(() => { arrivedNote = ""; draw(); }, 15000); }
    arrivedSeen = new Set(here);
    seen = new Set(fresh); draw();
  }, (e) => console.warn(e));
  onSnapshot(query(collection(db, "stores", storeId, "duties"), where("staffId", "==", me?.staffId || "-"), where("status", "in", ["pending", "on"])), (snap) => { duty = snap.docs.length ? { id: snap.docs[0].id, ...snap.docs[0].data() } : null; draw(); }, () => {});
  onSnapshot(doc(db, "stores", storeId, "staff", me?.staffId || "-"), (s) => { staffDoc = s.data() || null; draw(); }, () => {});
  // jobs offered to me (passed by the counter / new "any available" bookings)
  onSnapshot(query(collection(db, "stores", storeId, "appointments"), where("offerTo", "array-contains", me?.staffId || "-")), (snap) => {
    offers = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((a) => a.offer?.status === "open").sort((a, b) => a.offer.expiresAt - b.offer.expiresAt);
    const ids = offers.map((a) => a.id);
    if (offerSeen && ids.some((id) => !offerSeen.has(id))) { chime(0.6); try { navigator.vibrate?.([300, 120, 300, 120, 300]); } catch {} }
    offerSeen = new Set(ids); draw();
  }, (e) => console.warn("offers", e));
  refreshPush(storeId, "staff");
  if (!cdTimer) cdTimer = setInterval(() => {
    document.querySelectorAll("[data-cd]").forEach((el) => {
      const left = Math.max(0, Math.round((Number(el.dataset.cd) - Date.now()) / 1000));
      el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
      if (!left && !checked.has(el.dataset.id + el.dataset.cd)) { checked.add(el.dataset.id + el.dataset.cd); call("apptOffer", { id: el.dataset.id, action: "check", staffToken: getActiveStaff(storeId)?.token || null }).catch(() => {}); }
    });
  }, 1000);
  // my cash advances this month
  const m0 = new Date(); m0.setDate(1); m0.setHours(0, 0, 0, 0);
  onSnapshot(query(collection(db, "stores", storeId, "staffLedger"), where("staffId", "==", me?.staffId || "-")), (snap) => { ledger = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => b.at - a.at); draw(); }, () => {});
  onSnapshot(query(collection(db, "stores", storeId, "advances"), where("staffId", "==", me?.staffId || "-")), (snap) => { myAdv = snap.docs.map((d) => d.data()).filter((x) => x.at >= m0.getTime()); draw(); }, () => {});
}

function earningsToday() {
  const done = mine.filter((a) => a.status === "done" && !a.test);
  const commission = staffDoc?.salary?.commission === false ? 0 : done.reduce((sum, a) => sum + commissionFor(a), 0);
  const tips = done.reduce((s, a) => s + (a.tip || 0), 0);
  const basic = duty?.status === "on" ? (duty.basic || staffDoc?.salary?.basicPerDay || 0) : 0;
  return { done: done.length, commission, tips, basic, total: commission + basic };
}

function draw() {
  if (!me) return;
  const e = earningsToday();
  const active = mine.filter((a) => !["done", "no_show"].includes(a.status));
  const doneList = mine.filter((a) => a.status === "done");
  document.getElementById("head").innerHTML = `<header class="k-head" style="flex-wrap:wrap">
    <span class="name">${store.businessType === "spa" ? "💆" : "💇"} ${esc(me.name)}</span><span class="muted small">${esc(store.name)}</span><span class="sp"></span>
    ${duty?.status === "on" ? `<span class="k-tag paid">On duty since ${duty.acceptedAt?.toDate ? fmtT(duty.acceptedAt.toDate()) : ""}</span><button class="k-btn sm" id="dutyEnd">End duty</button>` : duty?.status === "pending" ? `<span class="k-tag" style="color:var(--new)">⏳ Waiting for the counter to accept your duty</span><button class="k-btn sm" id="dutyEnd">Cancel</button>` : `<button class="k-btn sm primary" id="dutyStart">▶ Start duty</button>`}
    <button class="k-btn sm" id="userBtn">👤</button>
    <div class="k-sum" style="width:100%;margin-top:8px"><div class="box"><div class="k">Done today</div><div class="v">${e.done}</div></div><div class="box"><div class="k">Commission</div><div class="v">${money(e.commission)}</div></div><div class="box"><div class="k">Basic (duty)</div><div class="v">${money(e.basic)}</div></div><div class="box"><div class="k">Tips</div><div class="v">${money(e.tips)}</div></div></div>
  </header>`;
  document.getElementById("dutyStart")?.addEventListener("click", async () => { try { await call("startDuty", { staffId: me.staffId }); } catch (err) { alert(err.message); } });
  document.getElementById("dutyEnd")?.addEventListener("click", async () => { if (!confirm(duty.status === "on" ? "End your duty for today?" : "Cancel the duty request?")) return; try { await call("endDuty", { id: duty.id }); } catch (err) { alert(err.message); } });
  document.getElementById("userBtn").onclick = async () => { clearActiveStaff(storeId); me = await pinGate({ storeId, storeName: store.name, requireRoles: ["stylist"], screenName: "Staff app" }); location.reload(); };
  setBadge(offers.length + active.filter((a) => ["pending", "confirmed"].includes(a.status) && !a.acceptedAt).length);
  const hd = document.querySelector("#head header");
  if (hd) { const pb = pushButton(storeId, "staff"); pb.style.marginLeft = "6px"; hd.insertBefore(pb, document.getElementById("userBtn")); }
  const main = document.getElementById("main"); main.innerHTML = "";
  if (staffDoc?.payType === "oncall") main.appendChild(availBox());
  offers.forEach((a) => main.appendChild(offerCard(a)));
  if (nextUp.length && !offers.length) main.appendChild(html(`<div class="k-note" style="margin-bottom:10px;border-left:4px solid var(--prep)"><b>⏭ Next up for you (from the line)</b>${nextUp.slice(0, 3).map((a) => `<div class="small" style="margin-top:4px">#${a.waitNo || "?"} ${esc(a.customer?.name || "")} · ${esc((a.items || []).map((l) => l.name).join(", "))}${a.queue?.etaAt ? ` · ~${fmtT(new Date(a.queue.etaAt))}` : ""}${a.intake?.flag ? " · ⚠️ see notes" : ""}</div>`).join("")}<div class="small muted" style="margin-top:4px">Estimate only — the counter or a job offer confirms who takes them.</div></div>`));
  if (arrivedNote) main.appendChild(html(`<div class="k-note" style="margin-bottom:10px;font-size:1.1rem;border-left:4px solid var(--ready)"><b>${esc(arrivedNote)}</b></div>`));
  if (store.settings?.salon?.remit?.enabled || ledger.length) main.appendChild(balanceCard());
  if (myAdv.length) main.appendChild(html(`<div class="small muted" style="margin:0 4px 10px">💸 Cash advances this month: <b>${money(myAdv.reduce((s, x) => s + x.amount, 0))}</b> (deducted from your pay)</div>`));
  if (!active.length && !offers.length) main.appendChild(html(`<div class="k-empty">No clients assigned to you right now.<br><span class="small">The counter assigns clients; you'll hear a chime when one arrives.</span></div>`));
  active.forEach((a) => main.appendChild(card(a)));
  if (doneList.length) { main.appendChild(html(`<h3 class="muted" style="margin:16px 4px 8px">Done today</h3>`)); doneList.forEach((a) => main.appendChild(card(a, true))); }
  if (!dueOn && me?.staffId) { dueOn = true; watchDue(storeId, (l) => { myDue = l; draw(); }, { providerId: me.staffId }); }
  if (myDue.length) {
    const box = html(`<div><h3 class="muted" style="margin:16px 4px 8px">🔁 My clients due back <span class="k-tag">${myDue.length}</span></h3><p class="small muted" style="margin:0 4px 8px">Send them a message — the counter books them.</p>${myDue.map((c) => dueCardHTML(c, { money, compact: true })).join("")}</div>`);
    bindDueActions(box, myDue, { storeId, me, storeName: store.name, link: `${location.origin}/m/${store.slug}`, onBook: () => {} });
    main.appendChild(box);
  }
}

const ESC_TXT = { unassigned: "waiting for a rider", assigned: "assigned", to_client: "on the way to the client", dropped: "dropped off", pickup_requested: "pickup requested — rider notified", to_pickup: "on the way to pick you up", picked_up: "picked up", back: "back at the shop" };
function card(a, compact = false) {
  const set = (patch) => updateDoc(doc(db, "stores", storeId, "appointments", a.id), { ...patch, updatedAt: serverTimestamp() }).catch((e) => alert(e.message));
  const st = a.startAt.toDate(); const dur = a.durationConfirmed || a.durationEst;
  const el = html(`<article class="k-card" style="border-top-color:${a.status === "in_progress" ? "var(--prep)" : a.status === "done" ? "var(--ready)" : a.acceptedAt ? "var(--ready)" : "var(--new)"}${compact ? ";opacity:.65" : ""}">
    <div class="top"><div><div class="no">${a.waiting ? "⏳ Waitlist" : fmtT(st)} <span class="k-tag">${esc(a.status.replace("_", " "))}</span>${a.homeService ? ` <span class="k-tag">🏠 home</span>` : ""}${!a.acceptedAt && !compact && ["pending", "confirmed"].includes(a.status) ? ` <span class="k-tag" style="color:var(--new)">NEW</span>` : ""}</div><div class="where">${esc(a.customer?.name || "")}${a.customer?.messenger && addrOpen(a) ? " " + msgrBtn(a.customer.messenger, "k-tag", "💬 Messenger") : ""}</div></div>
      <div class="time">${esc(a.code)}<span class="eta">~${dur} min${a.durationConfirmed ? " ✓" : " (est.)"}</span></div></div>
    <ul>${(a.items || []).map((l) => `<li><span class="q">${l.duration}m</span><span>${esc(l.name)}</span><span class="amt">${money(commissionFor({ items: [l] }))} pay</span></li>`).join("")}</ul>
    ${a.notes ? `<div class="small" style="color:var(--new)">📝 ${esc(a.notes)}</div>` : ""}${a.homeService?.prep?.bring?.length ? `<div class="small" style="color:#b45309;font-weight:600">🧺 Bring: ${esc(a.homeService.prep.bring.join(", "))}</div>` : ""}<div class="small" data-cflag></div>${a.homeService && !addrOpen(a) ? addrHidden(a) : a.homeService ? `<div class="small muted">📍 ${esc(a.homeService.address || "")}${a.homeService.landmark ? ` · ${esc(a.homeService.landmark)}` : ""}${a.homeFee ? ` · fee ${money(a.homeFee)}` : ""}</div><div class="small r-links">${homeLinksHTML(a.homeService, esc)}</div>` : ""}
    ${a.roomName && !a.homeService ? `<div class="small" style="color:var(--prep)">🚪 ${esc(a.roomName)}${a.couple ? " · couple booking" : ""}</div>` : a.couple ? `<div class="small" style="color:var(--prep)">👥 Couple booking — with ${esc((a.group || []).filter((g) => g.id !== a.id).map((g) => g.providerName).join(", "))}</div>` : ""}
    ${a.escort ? `<div class="small" style="color:var(--new)">🛵 Rider: <b>${esc(a.escort.riderName || "not assigned yet")}</b> · ${esc(ESC_TXT[a.escort.status] || a.escort.status || "")}</div>` : ""}
    ${a.helpOpen ? `<div class="small" style="background:var(--danger);color:#fff;padding:6px 8px;border-radius:8px;font-weight:800">🆘 Help sent — the shop was alerted</div>` : ""}
    ${compact ? "" : intakeHTML(a.intake, esc)}${a.goHome ? `<div class="small" style="color:var(--prep)">🏠 Going straight home after this job</div>` : ""}
    <div class="acts"></div></article>`);
  clientFlag(storeId, a.customerKey, el.querySelector("[data-cflag]"));
  hydratePrivate(el);
  if (compact) return el;
  const acts = el.querySelector(".acts");
  if (a.customerKey && feat("clientcard")) { const cc = html(`<button class="k-btn sm">👤 Client card</button>`); cc.onclick = () => clientCard({ storeId, key: a.customerKey, name: a.customer?.name, openDrawer, me, cur: CUR, stylists: [{ id: me.staffId, name: me.name }] }); acts.appendChild(cc); }
  if (!a.acceptedAt && ["pending", "confirmed"].includes(a.status)) { const b = html(`<button class="k-btn primary">✓ Accept client</button>`); b.onclick = () => set({ acceptedAt: serverTimestamp(), status: a.status === "pending" ? "confirmed" : a.status }); acts.appendChild(b); }
  if (["pending", "confirmed"].includes(a.status)) {
    const d = html(`<button class="k-btn">⏱ ${a.durationConfirmed ? "Edit duration" : "Confirm duration"}</button>`); d.onclick = () => { const v = prompt(`How long will this take (minutes)? Estimate ${a.durationEst}:`, a.durationConfirmed || a.durationEst); if (!v) return; set({ durationConfirmed: Math.max(5, Number(v) || a.durationEst), durationBy: me.name }); }; acts.appendChild(d);
    const s = html(`<button class="k-btn ready">▶ Start</button>`); s.onclick = () => set({ status: "in_progress", startedAt: serverTimestamp(), acceptedAt: a.acceptedAt || serverTimestamp(), ...(a.durationConfirmed ? {} : { durationConfirmed: a.durationEst, durationBy: me.name }) }); acts.appendChild(s);
  }
  if (a.status === "in_progress") {
    [5, 15, 30].forEach((m) => { const b = html(`<button class="k-btn sm">+${m} min</button>`); b.onclick = () => set({ durationConfirmed: (a.durationConfirmed || a.durationEst) + m, extraMinutes: (a.extraMinutes || 0) + m }); acts.appendChild(b); });
    { const t10 = html(`<button class="k-btn sm" title="Tells the line when you'll be free">⏱ Done in 10 min</button>`); t10.onclick = () => { const st0 = (a.startedAt?.toMillis?.() || a.startAt.toMillis()); const mins = Math.max(5, Math.ceil((Date.now() + 10 * 60000 - st0) / 60000)); set({ durationConfirmed: mins }); }; acts.appendChild(t10); }
    const dn = html(`<button class="k-btn ready">✓ Done</button>`);
    const askFree = () => { if (staffDoc?.payType === "oncall" && confirm("You are free. Turn on Available for 3 hours so the next job can reach you?")) call("staffAvailability", { until: Date.now() + 3 * 3600e3, staffToken: getActiveStaff(storeId)?.token || null }).catch((e) => alert(e.message)); }; dn.onclick = () => { if (a.homeService && !a.paid) { const total = (a.total || 0) + (a.homeFee || 0); if (!confirm(`Home service: collected ${money(total)} in cash from the client?`)) { set({ status: "done", doneAt: serverTimestamp() }); askFree(); return; } return apptOp(storeId, "collectHome", { id: a.id }).then(askFree).catch((e) => alert(e.message)); } set({ status: "done", doneAt: serverTimestamp() }); askFree(); }; acts.appendChild(dn);
  }
  if (store.settings?.salon?.remit?.enabled && ["done", "in_progress"].includes(a.status) && !a.paid && !a.homeService) { const cb = html(`<button class="k-btn sm">💵 I collected payment</button>`); cb.onclick = () => { const m = prompt(`Collected ${money((a.total || 0) + (a.homeFee || 0))} — how? Type: cash / gcash / maya / bank`, "cash"); if (!m) return; call("staffRemit", { action: "collect", apptId: a.id, method: m.trim().toLowerCase(), staffToken: getActiveStaff(storeId)?.token || null }).catch((e) => alert(e.message)); }; acts.appendChild(cb); }
  if (a.homeService && ["confirmed", "in_progress", "done"].includes(a.status) && a.status !== "done" || (a.homeService && a.status === "done" && a.escort && ["assigned", "to_client", "dropped", "unassigned"].includes(a.escort.status))) {
    const ext = (body) => call("apptExtras", { id: a.id, staffToken: getActiveStaff(storeId)?.token || null, ...body });
    if (a.status !== "done") {
      const ok = html(`<button class="k-btn sm">✅ I'm safe${a.safety?.state === "safe" && a.safety.at ? ` · ${new Date(a.safety.at).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}` : ""}</button>`); ok.onclick = async () => { ok.disabled = true; const loc = await getLoc(); ext({ action: "safety", state: "safe", loc }).then(() => alert(loc ? "Thanks — the shop can see you checked in, with your location." : "Thanks — the shop can see you checked in. (Location was not shared — allow location for a map pin.)")).catch((e) => alert(e.message)).finally(() => (ok.disabled = false)); }; acts.appendChild(ok);
      const hp = html(`<button class="k-btn danger">🆘 Help</button>`); hp.onclick = async () => {
        if (!confirm("Send a HELP alert to the shop now?")) return;
        hp.disabled = true;
        const loc = await getLoc();
        ext({ action: "safety", state: "help", loc }).then(() => alert("Help alert sent. The shop has been notified.")).catch((e) => { hp.disabled = false; alert(e.message); });
      }; acts.appendChild(hp);
    }
    if (a.escort && a.status === "done") { const pk = html(`<button class="k-btn primary">🛵 Ready — pick me up</button>`); pk.onclick = () => ext({ action: "escortStep", step: "pickup_requested" }).catch((e) => alert(e.message)); acts.appendChild(pk); }
  }
  if (staffDoc?.payType === "oncall" && ["pending", "confirmed", "in_progress"].includes(a.status)) { const gh = html(`<button class="k-btn sm">${a.goHome ? "↩ I'll go back to the shop" : "🏠 Go home after this job"}</button>`); gh.onclick = () => call("apptExtras", { id: a.id, action: "goHome", on: !a.goHome, staffToken: getActiveStaff(storeId)?.token || null }).catch((e) => alert(e.message)); acts.appendChild(gh); }
  if (!a.homeService) acts.appendChild(html(`<span class="small muted">Payment is taken at the counter.</span>`));
  return el;
}

function openDrawer(title, bodyEl) {
  document.querySelector(".k-drawer-wrap")?.remove();
  const w = html(`<div class="k-drawer-wrap"><div class="k-drawer"><div class="hd"><h3>${esc(title)}</h3><button class="x">×</button></div><div class="bd"></div></div></div>`);
  w.querySelector(".bd").appendChild(bodyEl);
  w.querySelector(".x").onclick = () => w.remove();
  w.addEventListener("click", (e) => e.target === w && w.remove());
  document.body.appendChild(w);
}

// on-call staff: "Available for jobs until …"
function availBox() {
  const until = Number(staffDoc?.available?.until) || 0, on = until > Date.now();
  const gone = staffDoc?.wentHome?.date === new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const def = new Date(Date.now() + 4 * 3600e3); const hh = `${String(def.getHours()).padStart(2, "0")}:${String(def.getMinutes() < 30 ? 30 : 0).padStart(2, "0")}`;
  const el = html(`<div class="k-card" style="border-top-color:${on ? "var(--ready)" : "var(--line)"};margin-bottom:12px">
    ${on ? `<div class="top"><b>🟢 Available for jobs until ${fmtT(new Date(until))}</b><button class="k-btn sm" data-off>Stop</button></div><p class="small muted" style="margin:6px 0 0">If you don't answer a job in time you'll be set to not available.</p>`
      : `<b>⚪ Not available for jobs</b>${staffDoc?.lastMissedAt && Date.now() - staffDoc.lastMissedAt < 6 * 3600e3 ? `<p class="small" style="color:var(--danger);margin:4px 0 0">You missed a job at ${fmtT(new Date(staffDoc.lastMissedAt))} — turn this on again when you're ready.</p>` : gone ? `<p class="small muted" style="margin:4px 0 0">You went home after your last job today.</p>` : ""}
        <div class="row" style="gap:8px;margin-top:8px;align-items:center"><span class="small">Until</span><input type="time" data-until value="${hh}" style="max-width:130px"/><button class="k-btn ready" data-on>🟢 I'm available</button></div>`}
  </div>`);
  const tok = () => getActiveStaff(storeId)?.token || null;
  el.querySelector("[data-off]")?.addEventListener("click", () => call("staffAvailability", { until: null, staffToken: tok() }).catch((e) => alert(e.message)));
  el.querySelector("[data-on]")?.addEventListener("click", () => {
    const [h, m] = (el.querySelector("[data-until]").value || "").split(":").map(Number); if (Number.isNaN(h)) return;
    const t = new Date(); t.setHours(h, m || 0, 0, 0); if (t.getTime() < Date.now()) t.setDate(t.getDate() + 1);
    call("staffAvailability", { until: t.getTime(), staffToken: tok() }).catch((e) => alert(e.message));
  });
  return el;
}
function offerCard(a) {
  const st = a.startAt.toDate(); const dur = a.durationConfirmed || a.durationEst;
  const today = st.toDateString() === new Date().toDateString();
  const el = html(`<article class="k-card" style="border-top-color:var(--new);box-shadow:0 0 0 3px color-mix(in srgb, var(--new) 35%, transparent)">
    <div class="top"><div><div class="no">📣 New job ${a.offer.mode === "race" ? `<span class="k-tag">first to accept</span>` : `<span class="k-tag">for you</span>`}</div>
      <div class="where">${today ? "Today" : st.toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric" })} · ${fmtT(st)} · ~${dur} min</div></div>
      <div class="time" style="font-size:1.4rem">⏱ <span data-cd="${a.offer.expiresAt}" data-id="${a.id}">–</span></div></div>
    <ul>${(a.items || []).map((l) => `<li><span class="q">${l.duration}m</span><span>${esc(l.name)}</span><span class="amt">${money(commissionFor({ items: [l] }))} pay</span></li>`).join("")}</ul>
    ${a.homeService ? `<div class="small" style="color:var(--new)">🏠 Home service · ${esc(a.homeService.area || "")} ${addrOpen(a) ? esc(a.homeService.address || "") : "🛡"}</div>` : a.roomName ? `<div class="small muted">🚪 ${esc(a.roomName)}</div>` : ""}
    ${intakeHTML(a.intake, esc)}
    <div class="acts"><button class="k-btn ready" data-acc style="flex:1">✓ Accept</button><button class="k-btn" data-dec>Pass</button></div></article>`);
  const tok = () => getActiveStaff(storeId)?.token || null;
  el.querySelector("[data-acc]").onclick = async (e) => { e.target.disabled = true; try { await call("apptOffer", { id: a.id, action: "accept", staffToken: tok() }); chime(0.3); } catch (x) { alert(x.message); e.target.disabled = false; } };
  el.querySelector("[data-dec]").onclick = async (e) => { if (!confirm("Pass this job to others?")) return; e.target.disabled = true; try { await call("apptOffer", { id: a.id, action: "decline", staffToken: tok() }); } catch (x) { alert(x.message); e.target.disabled = false; } };
  return el;
}

// ---------- 💰 my balance & remittance ----------
const sign = (e) => (e.type === "collect" || e.type === "payout" ? 1 : e.type === "earn" || (e.type === "remit" && e.status === "confirmed") ? -1 : 0);
function balanceCard() {
  const sum = (t, f = () => true) => ledger.filter((e) => e.type === t && f(e)).reduce((a, e) => a + e.amount, 0);
  const bal = Math.round(ledger.reduce((a, e) => a + sign(e) * e.amount, 0) * 100) / 100;
  const pend = sum("remit", (e) => e.status === "pending");
  const el = html(`<div class="k-note" style="margin-bottom:10px;border-left:4px solid ${bal > 0 ? "var(--new)" : "var(--ready)"}">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>💰 My balance</b><span style="font-size:1.2rem;font-weight:800;color:${bal > 0 ? "var(--danger)" : "var(--ready)"}">${bal > 0 ? `Remit ${money(bal - pend > 0 ? bal - pend : 0)}` : bal < 0 ? `Shop owes you ${money(-bal)}` : "All settled ✓"}</span></div>
    <div class="small" style="display:grid;grid-template-columns:1fr auto;gap:2px 10px;margin-top:6px"><span>Collected from clients</span><b>${money(sum("collect"))}</b><span>My pay (commission, basic, allowance)</span><b>− ${money(sum("earn"))}</b><span>Remitted (confirmed)</span><b>− ${money(sum("remit", (e) => e.status === "confirmed"))}</b>${sum("payout") ? `<span>Paid to me</span><b>+ ${money(sum("payout"))}</b>` : ""}${pend ? `<span>Waiting for the owner to confirm</span><b>${money(pend)}</b>` : ""}</div>
    <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">${bal - pend > 0 ? `<button class="k-btn sm primary" data-remit>💸 Send remittance</button>` : ""}<button class="k-btn sm" data-hist>History</button></div></div>`);
  el.querySelector("[data-remit]")?.addEventListener("click", () => remitForm(Math.round((bal - pend) * 100) / 100));
  el.querySelector("[data-hist]").onclick = () => openDrawer("💰 My balance history", html(`<div>${ledger.map((e) => `<div class="k-item" style="display:flex;justify-content:space-between;gap:8px"><span><b>${esc(e.label || e.type)}</b><br><span class="small muted">${new Date(e.at).toLocaleString("en-PH", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}${e.type === "remit" ? ` · ${e.status === "confirmed" ? "✅ confirmed" : e.status === "rejected" ? `❌ ${esc(e.reason || "not received")}` : "⏳ waiting for the owner"}` : ""}</span></span><b style="color:${sign(e) > 0 ? "var(--danger)" : "var(--ready)"}">${sign(e) > 0 ? "+" : sign(e) < 0 ? "−" : ""}${money(e.amount)}</b></div>`).join("") || `<p class="muted">Nothing yet.</p>`}<p class="small muted">+ = you owe the shop · − = the shop owes you</p></div>`));
  return el;
}
function remitForm(due) {
  const pays = (store.settings?.payments?.methods || []).filter((m) => m.type !== "cash" && m.enabled !== false);
  const el = html(`<div><p class="small">Send your remittance to the shop, then enter the details. The owner confirms it.</p>
    ${pays.map((m) => `<div class="k-item small"><b>${esc(m.name)}</b> · ${esc(m.number || "")} ${esc(m.accountName || "")}</div>`).join("")}
    <label>Amount (₱)</label><input class="k-input" data-amt type="number" min="1" value="${due}"/>
    <label>How</label><select class="k-input" data-m><option value="gcash">GCash</option><option value="maya">Maya</option><option value="bank">Bank deposit / transfer</option><option value="cash">Cash (handed to the owner)</option></select>
    <label>Reference no.</label><input class="k-input" data-ref placeholder="e.g. 1234 567 890"/>
    <label>Screenshot / deposit slip (optional)</label><input type="file" accept="image/*" data-pf/>
    <button class="k-btn primary" data-go style="width:100%;margin-top:10px">Send</button></div>`);
  el.querySelector("[data-go]").onclick = async (e) => { e.target.disabled = true; try { const f = el.querySelector("[data-pf]").files?.[0]; const proofUrl = f ? await uploadPrivateImage(storeId, auth.currentUser.uid, f, { max: 1400, name: `remit_${Date.now()}` }) : null;
    await call("staffRemit", { amount: Number(el.querySelector("[data-amt]").value), method: el.querySelector("[data-m]").value, refNo: el.querySelector("[data-ref]").value.trim(), proofUrl, staffToken: getActiveStaff(storeId)?.token || null }); document.querySelector(".k-drawer-wrap")?.remove(); alert("Sent — the owner will confirm it."); } catch (x) { alert(x.message); e.target.disabled = false; } };
  openDrawer("💸 Send remittance", el);
}
