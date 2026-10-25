// Guided setup: steps per business type + setup, "Set up later", progress checklist, Go live, and the first-time tour.
import { db } from "./firebase.js";
import { doc, updateDoc, getCountFromServer, collection, query, where } from "firebase/firestore";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Steps for this store. Each: { id, title, why, go (hash), check(state) → true when done } */
export function stepsFor(store) {
  const m = store.mode, k = store.settings?.setup?.kind;
  const S = {
    info: { title: "Business info & logo", why: "Your name, logo and short tagline appear on your customer page.", go: "#tools/shop:info", check: (s) => !!(store.logoUrl || store.settings?.tagline) || s.done.info },
    hours: { title: "Opening hours", why: "Customers see when you're open. When closed, they can still order or book for later.", go: "#tools/shop:hours", check: (s) => Object.keys(store.hours || {}).length > 0 || s.done.hours },
    menu: { title: m === "salon" ? "Services, prices & durations" : m === "laundry" ? "Services & prices" : m === "stay" ? "Rooms & rates" : "Your menu", why: m === "salon" ? "We added sample services — edit prices and durations, delete what you don't offer." : "We added sample items — change names, prices and photos, delete what you don't sell.", go: m === "stay" ? "#rooms" : "#menu", check: (s) => !!s.done.menu },
    tables: { title: "Tables & QR codes", why: "Add your tables and print a QR for each one so orders show the table number.", go: "#tables", check: (s) => s.tables > 0 || s.done.tables },
    team: { title: m === "salon" ? "Your stylists (PIN, skills, schedule)" : "Your staff & roles", why: m === "salon" ? "Each stylist gets a PIN, the services they can do and their work days." : "Give each staff member a PIN and role: counter, kitchen, barista, rider.", go: "#staff", check: (s) => s.staff > (s.ownerProfile ? 1 : 0) || s.done.team },
    owner: { title: "Your own PIN & profile", why: "You use your PIN on the counter and staff screens.", go: "#staff", check: (s) => s.ownerProfile || s.done.owner },
    pay: { title: "Payment methods (GCash / Maya)", why: "Show your GCash/Maya number or QR so customers can pay ahead. Cash is always on.", go: "#tools/selling:payments", check: (s) => (store.settings?.payments?.methods || []).some((x) => x.type !== "cash" && x.enabled !== false) || s.done.pay },
    delivery: { title: "Delivery & pickup", why: "Set your delivery fee and area, and pickup instructions.", go: "#tools/selling:service", check: (s) => Number(store.settings?.service?.deliveryFee) > 0 || s.done.delivery },
    homesvc: { title: "Home service: areas, fee & hours", why: "Tell customers where you go, your transport fee and when you do home service.", go: "#tools/booking:homesvc", check: (s) => Number(store.settings?.salon?.homeService?.fee) > 0 || (store.settings?.salon?.homeService?.areas || []).length > 0 || s.done.homesvc },
    booking: { title: "Booking rules", why: "Advance notice, cancellation window, grace period and confirmation.", go: "#tools/booking:salon", check: (s) => !!s.done.booking },
    test: { title: "Try a test order", why: "Turn on Test mode and place an order or booking from your own phone — it won't count in sales.", go: "#tools/advanced:test", check: (s) => s.tests > 0 || s.done.test },
    share: { title: "Print or share your QR / link", why: "Put the QR on your counter, tables or Facebook page.", go: "#tables", check: (s) => !!s.done.share },
  };
  const place = store.settings?.setup?.place || (store.settings?.salon?.homeService?.enabled ? "both" : "shop");
  const ids = m === "salon" ? [...(k === "solo" ? ["info", "hours", "menu", "owner"] : ["info", "hours", "menu", "team"]), ...(place !== "shop" ? ["homesvc"] : []), "pay", "booking", "test", "share"]
    : m === "table" ? (k === "home" ? ["info", "hours", "menu", "owner", "delivery", "pay", "test", "share"] : ["info", "hours", "menu", "tables", "team", "pay", "delivery", "test", "share"])
    : m === "laundry" ? ["info", "hours", "menu", "team", "pay", "delivery", "test", "share"]
    : m === "stay" ? ["info", "menu", "team", "pay", "test", "share"] : ["info", "hours", "menu", "pay", "test", "share"];
  return ids.map((id) => ({ id, ...S[id] }));
}

/** Live counts used by the checks */
export async function loadState(ctx) {
  const st = ctx.store.settings?.onboarding || {};
  const c = async (q) => { try { return (await getCountFromServer(q)).data().count; } catch { return 0; } };
  const sid = ctx.storeId;
  const [tables, staff, ownerProfile, testsO, testsA] = await Promise.all([
    c(collection(db, "stores", sid, "tables")), c(query(collection(db, "stores", sid, "staff"), where("active", "==", true))), c(query(collection(db, "stores", sid, "staff"), where("isOwner", "==", true))),
    c(query(collection(db, "stores", sid, "orders"), where("test", "==", true))), ctx.mode === "salon" ? c(query(collection(db, "stores", sid, "appointments"), where("test", "==", true))) : 0,
  ]);
  return { done: st.done || {}, later: st.later || {}, tables, staff, ownerProfile: ownerProfile > 0, tests: testsO + testsA };
}

const save = (ctx, patch) => updateDoc(doc(db, "stores", ctx.storeId), Object.fromEntries(Object.entries(patch).map(([k, v]) => [`settings.onboarding.${k}`, v]))).then(() => {
  const ob = (ctx.store.settings.onboarding = ctx.store.settings.onboarding || {});
  for (const [k, v] of Object.entries(patch)) { const [a, b] = k.split("."); if (b) { ob[a] = ob[a] || {}; ob[a][b] = v; } else ob[a] = v; }
});
export const isLive = (store) => store.settings?.live !== false;
export async function goLive(ctx, on = true) {
  await updateDoc(doc(db, "stores", ctx.storeId), { "settings.live": on });
  ctx.store.settings.live = on;
}

/** "Finish setting up" card for the Overview */
export async function checklistCard(el, ctx, onChange) {
  const ob = ctx.store.settings?.onboarding;
  if (!ob || (ob.hidden && isLive(ctx.store))) { el.remove(); return; }
  const steps = stepsFor(ctx.store); const s = await loadState(ctx);
  const done = steps.filter((x) => x.check(s));
  const pct = Math.round((done.length / steps.length) * 100);
  const live = isLive(ctx.store);
  el.innerHTML = `<div class="ob-card ${live ? "" : "highlight"}">
    <div class="ob-head"><div><span class="sticker ${live ? "lime" : "mango"}">${live ? "● Live" : "Coming soon"}</span><h2>${live ? "Finish setting up" : "Set up your shop"}</h2><p class="muted">${done.length} of ${steps.length} done${live ? "" : " — customers see “Coming soon” until you go live."}</p></div>
      <div class="ob-actions">${live ? `<button class="btn ghost sm" type="button" data-hide>Hide</button>` : `<button class="btn brand" type="button" data-live>🚀 Go live</button>`}<button class="btn ghost sm" type="button" data-guide>Open setup guide</button></div></div>
    <div class="ob-bar" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Setup progress"><span style="width:${pct}%"></span></div>
    <ol class="ob-steps">${steps.map((x, i) => { const ok = x.check(s); const later = !ok && s.later[x.id]; return `<li class="${ok ? "ok" : later ? "later" : ""}"><span class="ob-n">${ok ? "✓" : i + 1}</span><div><b>${esc(x.title)}</b>${later ? ` <span class="pill">later</span>` : ""}<div class="small muted">${esc(x.why)}</div></div>${ok ? "" : `<a class="btn ghost sm" href="${x.go}" data-step="${x.id}">Do it now</a>`}</li>`; }).join("")}</ol></div>`;
  el.querySelectorAll("[data-step]").forEach((a) => a.addEventListener("click", () => { openGuide(ctx, steps.findIndex((x) => x.id === a.dataset.step)); }));
  el.querySelector("[data-guide]").onclick = () => openGuide(ctx);
  el.querySelector("[data-hide]")?.addEventListener("click", async () => { await save(ctx, { hidden: true }); el.remove(); });
  el.querySelector("[data-live]")?.addEventListener("click", async () => {
    const essentials = steps.filter((x) => ["menu", "hours", "pay"].includes(x.id) && !x.check(s)).map((x) => x.title);
    if (!confirm(`${essentials.length ? `Not done yet: ${essentials.join(", ")}.\n\n` : ""}Go live now? Customers will be able to order / book from your link.`)) return;
    await goLive(ctx, true); onChange?.();
  });
}

/** Floating step-by-step guide (Save & next / Set up later / Back) */
let guideEl = null;
export async function openGuide(ctx, index = null) {
  const steps = stepsFor(ctx.store);
  const s = await loadState(ctx);
  if (index == null) { index = steps.findIndex((x) => !x.check(s) && !s.later[x.id]); if (index < 0) index = Math.max(0, steps.findIndex((x) => !x.check(s))); }
  index = Math.max(0, Math.min(steps.length - 1, index));
  guideEl?.remove();
  const x = steps[index]; const ok = x.check(s);
  guideEl = document.createElement("aside");
  guideEl.className = "ob-guide"; guideEl.setAttribute("aria-label", "Setup guide");
  guideEl.innerHTML = `<div class="ob-g-top"><span class="small muted">Setup guide · step ${index + 1} of ${steps.length}</span><button type="button" class="ob-x" aria-label="Close setup guide">×</button></div>
    <div class="ob-dots">${steps.map((y, i) => `<span class="${y.check(s) ? "ok" : ""} ${i === index ? "now" : ""}"></span>`).join("")}</div>
    <h3>${ok ? "✓ " : ""}${esc(x.title)}</h3><p>${esc(x.why)}</p>
    <div class="ob-g-btns"><a class="btn sm" href="${x.go}" data-open>Open ${x.go.startsWith("#tools") ? "settings" : "page"}</a>
      <button class="btn brand sm" type="button" data-next>${index === steps.length - 1 ? "Finish" : "✓ Done, next"}</button></div>
    <div class="ob-g-btns"><button class="btn ghost sm" type="button" data-back ${index === 0 ? "disabled" : ""}>‹ Back</button><button class="btn ghost sm" type="button" data-later>Set up later</button></div>`;
  document.body.appendChild(guideEl);
  const go = (i) => openGuide(ctx, i);
  guideEl.querySelector(".ob-x").onclick = () => { guideEl.remove(); guideEl = null; save(ctx, { guide: "closed" }); };
  guideEl.querySelector("[data-back]").onclick = () => go(index - 1);
  guideEl.querySelector("[data-later]").onclick = async () => { await save(ctx, { [`later.${x.id}`]: true }); index === steps.length - 1 ? finish() : go(index + 1); };
  guideEl.querySelector("[data-next]").onclick = async () => { await save(ctx, { [`done.${x.id}`]: true, [`later.${x.id}`]: false }); index === steps.length - 1 ? finish() : go(index + 1); };
  const finish = () => { guideEl.remove(); guideEl = null; save(ctx, { guide: "closed" }); location.hash = "#overview"; };
  save(ctx, { guide: "open", step: index });
}
/** Re-open the guide on load if it was open */
export function resumeGuide(ctx) { const ob = ctx.store.settings?.onboarding; if (ob && ob.guide === "open") openGuide(ctx, ob.step || 0); }

/** First-time tour: spotlight a few places, once */
const TOUR = [
  ["[data-page=overview]", "Overview", "Today's sales, live orders and your setup checklist live here."],
  ["[data-page=menu], [data-page=rooms]", "Menu / Services", "Add what you sell — names, prices, photos."],
  ["[data-page=tables]", "QR & link", "Your customer link and QR codes to print or share."],
  ["[data-page=orders], [data-page=calendar], [data-page=stays]", "Orders & bookings", "Every order or booking, with status and payment."],
  ["[data-page=tools], .bnav [data-page=_me]", "Settings", "Payments, hours, team, promos and alerts. On a phone, tap Me."],
  ["#openMenuLink", "Your shop page", "See exactly what customers see."],
];
export function maybeTour(ctx, force = false, steps = null) {
  const TOUR_STEPS = steps || TOUR;
  const ob = ctx.store.settings?.onboarding || {}; if (!force && (!ctx.store.settings?.onboarding || ob.tourDone)) return;
  document.querySelector(".tour")?.remove();
  let i = 0;
  const wrap = document.createElement("div"); wrap.className = "tour"; document.body.appendChild(wrap);
  const end = () => { wrap.remove(); window.removeEventListener("resize", draw); if (!force) { save(ctx, { tourDone: true }); if (!ob.guide) openGuide(ctx); } };
  // a target counts only if it's really on screen (the side menu is hidden off-screen on phones)
  const shown = (x) => { if (!x.offsetParent) return false; const cs = getComputedStyle(x); if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return false; const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight; };
  function draw() {
    let el = null; while (i < TOUR_STEPS.length && !(el = [...document.querySelectorAll(TOUR_STEPS[i][0])].find(shown))) i++;
    if (i >= TOUR_STEPS.length) return end();
    const r = el.getBoundingClientRect(); const [, t, b] = TOUR_STEPS[i];
    const phone = innerWidth < 600;
    const nearBottom = r.top > innerHeight * 0.55;
    const pos = phone ? (nearBottom ? "left:16px;right:16px;top:calc(16px + env(safe-area-inset-top))" : "left:16px;right:16px;bottom:calc(16px + env(safe-area-inset-bottom))")
      : `left:${Math.min(innerWidth - 300, Math.max(12, r.left))}px;top:${r.bottom + 12 + 180 > innerHeight ? Math.max(12, r.top - 180) : r.bottom + 12}px`;
    wrap.innerHTML = `<div class="tour-hole" style="left:${r.left - 6}px;top:${r.top - 6}px;width:${r.width + 12}px;height:${r.height + 12}px"></div>
      <div class="tour-tip${phone ? " sheet" : ""}" role="dialog" aria-label="${esc(t)}" style="${pos}"><div class="row between" style="align-items:baseline"><b>${esc(t)}</b><span class="small muted">${i + 1} of ${TOUR_STEPS.length}</span></div><p>${esc(b)}</p><div class="row between"><button class="btn ghost sm" type="button" data-skip>Skip tour</button><button class="btn brand sm" type="button" data-n>${i === TOUR_STEPS.length - 1 ? (steps ? "Done" : "Start setup") : "Next"}</button></div></div>`;
    wrap.querySelector("[data-skip]").onclick = end;
    wrap.querySelector("[data-n]").onclick = () => { i++; draw(); };
    wrap.querySelector("[data-n]").focus();
  }
  window.addEventListener("resize", draw);
  setTimeout(draw, 400);
}
