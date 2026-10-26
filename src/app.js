import { renderCalendarPage } from "./pages/calendar.js";
import { applyWording } from "./wording.js";
import { trustToken } from "./security.js";
import { checkForUpdate, APP_VERSION as TT_VERSION } from "./updates.js";
import { openAppFeedback } from "./appfeedback.js";
import { auth, db, call, DEMO_VIEW, DEMO_MSG } from "./firebase.js";
import { PRESETS } from "./presets.js";
import { applyTheme, SEASONS } from "./themes.js";
import { APP_VERSION } from "./version.js";
import { entitled, limitMode, PRO_FEATURES, FEATURE_TIER, PLANS, planOf, limitsFor, LIMIT_LABEL, UNLIMITED } from "./plans.js";
import { $, esc, toast, closeModal } from "./ui.js";
import { onAuthStateChanged, onIdTokenChanged, signOut, signInWithCustomToken, sendEmailVerification } from "firebase/auth";
import { showDeviceBlockedDashboard, ownerIdleGuard, deviceSignIn, savedDevice } from "./device.js";
import { getDocFromCache, doc, getDoc, updateDoc, serverTimestamp, onSnapshot, collection, getCountFromServer, query, where, getDocs, orderBy, limit, Timestamp } from "firebase/firestore";
import { branchesAllowed } from "./pages/branches.js";
import { money } from "./ui.js";
import { renderMenuPage } from "./pages/menu.js";
import { renderTablesPage } from "./pages/tables.js";
import { renderSettingsPage } from "./pages/settings.js";
import { renderOrdersPage } from "./pages/orders.js";
import { renderReservationsPage } from "./pages/reservations.js";
import { renderProjectsPage } from "./pages/projects.js";
import { renderCreatorsPage } from "./pages/creators.js";
import { renderMePage } from "./pages/me.js";
import { renderBillingPage } from "./pages/billing.js";
import { renderReportsPage } from "./pages/reports.js";
import { renderCustomersPage } from "./pages/customers.js";
import { renderPromosPage } from "./pages/promos.js";
import { renderFeedbackPage } from "./pages/feedback.js";
import { renderAnnouncementsPage } from "./pages/announcements.js";
import { renderFeedPage } from "./pages/feed.js";
import { renderProsPage } from "./pages/pros.js";
import { renderBranchesPage, switchTo } from "./pages/branches.js";
import { renderRoomsPage, renderStaysPage } from "./pages/rooms.js";
import { renderToolsPage } from "./pages/tools.js";
import { resumeGuide, maybeTour } from "./onboarding.js";
import { renderOverview } from "./overview.js";
import { mountBell } from "./bell.js";
import { watchMaintenance } from "./maint.js";
watchMaintenance("owner");
import { autoSolo } from "./solo.js";
import { openSupport, supportBadge, supportAsShop } from "./support.js";

// 20px stroke icons for the main nav
const ICONS = {
  overview: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  orders: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  menu: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5M9 7h6"/>',
  tables: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 17v4h-4"/>',
  staff: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6 6 0 0 1 3.5 6"/>',
  reports: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  tools: '<path d="M14.7 6.3a4 4 0 0 0 5 5L21 13l-8 8-3-3 8-8-1.3-1.3a4 4 0 0 1-5-5L13 2z" transform="translate(-1 0)"/><path d="M3 21l6-6"/>',
  rooms: '<path d="M3 18v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6M3 14h18M3 18v2M21 18v2"/><path d="M7 10V7h4v3"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18M8 14h3M13 14h3M8 17h3"/>',
  stays: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/>',
};
const icon = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k] || ICONS.tools}</svg>`;

const show = (id) => $(id).classList.remove("hidden");
const hide = (id) => $(id).classList.add("hidden");

let currentUser = null;
let addingBusiness = false; // owner adding another business (café + salon, etc.)
let claims = null;
let ctx = null; // { storeId, store, labels, mode, role, reload }
let unsubPage = null;
let unsubSub = null;

// ----------------------------------------------------------------------------
// Boot
// ----------------------------------------------------------------------------
// read-only owner demo: sign in to this tab only as a viewer of a demo store
async function startDemoViewer() {
  try { const r = await call("demoViewer", { slug: DEMO_VIEW }); await signInWithCustomToken(auth, r.token); }
  catch (e) { hide("loading"); document.body.insertAdjacentHTML("afterbegin", `<div class="alert error" style="margin:20px">${esc(e.message || "Couldn't open the demo.")} <a href="/#demo">Back to TapTayo</a></div>`); }
}
const ownerish = () => claims?.role === "owner" || claims?.role === "viewer";
onAuthStateChanged(auth, async (user) => {
  if ((!user || user.isAnonymous) && DEMO_VIEW) return startDemoViewer();
  if (!user || user.isAnonymous) return location.replace("/login/");
  currentUser = user;
  claims = (await user.getIdTokenResult()).claims;           // cached token = instant (refreshed below only when needed)
  if (!claims.storeId) claims = (await user.getIdTokenResult(true)).claims; // just signed up / switched business
  if (claims.role === "device") { hide("loading"); let mode = null; try { mode = (await getDoc(doc(db, "stores", claims.storeId))).data()?.mode; } catch {} return showDeviceBlockedDashboard(mode); }
  if (claims.role !== "viewer") ownerIdleGuard(15);
  // owner session revoked ("Log out everywhere") or not yet confirmed by the 2-step email → back to login
  // (runs in the background so the dashboard never waits for a cold server; the server and rules enforce it anyway)
  if (claims.role === "owner") {
    call("securityStatus", { deviceToken: trustToken() }, { timeout: 15000 }).then(async (st) => { if (!st.approved) { if (st.revoked) await signOut(auth); location.replace("/login/?next=/app/"); } }).catch(() => {});
  }
  if (claims.storeId && claims.role === "owner" && !claims.orgId) { try { const r = await call("ensureOrg"); if (r.refresh) { await user.getIdToken(true); claims = (await user.getIdTokenResult(true)).claims; } } catch {} }
  hide("loading");
  if (claims.storeId) {
    if (location.hash === "#addbusiness") location.hash = "#overview";
    await loadDashboard();
  } else { initWizard(); show("wizard"); }
});

// version + "Check for updates" at the bottom of the menu
{ const side = document.getElementById("sideNav"); if (side && !document.getElementById("ttVer")) { const v = document.createElement("div"); v.id = "ttVer"; v.className = "tt-ver"; v.innerHTML = `<a href="#" data-fb class="tt-fb">💬 Feedback &amp; suggestions</a>Version ${TT_VERSION} · <a href="#" data-chk>Check for updates</a>`; v.querySelector("[data-chk]").onclick = (e) => { e.preventDefault(); checkForUpdate({ manual: true }); }; v.querySelector("[data-fb]").onclick = (e) => { e.preventDefault(); document.body.classList.remove("nav-open"); openAppFeedback(); }; side.appendChild(v); } }
$("logoutBtn").onclick = async () => { await signOut(auth); if (savedDevice() && (await deviceSignIn())) location.replace("/counter/"); };
$("navToggle").onclick = (e) => { e.stopPropagation(); const on = document.body.classList.toggle("nav-open"); e.currentTarget.setAttribute("aria-expanded", String(on)); if (on) document.querySelector("#nav a")?.focus(); };
document.addEventListener("click", (e) => { if (document.body.classList.contains("nav-open") && !e.target.closest(".side") && !e.target.closest("#navToggle")) document.body.classList.remove("nav-open"); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && document.body.classList.contains("nav-open")) { document.body.classList.remove("nav-open"); $("navToggle").focus(); } });

// Safety: if another tab logs in as a different account (or the store/branch changes), reload so this tab never edits the wrong store.
onIdTokenChanged(auth, async (u) => {
  if (!currentUser) return;
  if (!u || u.uid !== currentUser.uid || u.isAnonymous) return location.reload();
  try { const c = (await u.getIdTokenResult()).claims; if (claims && c.storeId !== claims.storeId) location.reload(); } catch {}
});

// ----------------------------------------------------------------------------
// Wizard
// ----------------------------------------------------------------------------
const wiz = { businessType: null, name: "", phone: "", address: "", setup: null, ownerWorks: false };
// setup choices per store type (only salon and café/restaurant have them)
const SETUPS = {
  salon: { title: "How do you run your salon?", choices: [["team", "👥", "I have staff", "Stylists / technicians with their own PIN, skills and schedule. Rotation, duty and staff pay included."], ["solo", "🙋", "Just me (owner-only)", "You are the only one serving clients. Simple 'My day' list and calendar. Add staff anytime."]] },
  table: { title: "How do you sell?", choices: [["shop", "🏪", "I have a shop and staff", "Dine-in tables with QR, take-out, and staff with roles (counter, kitchen, barista, rider)."], ["home", "🏠", "Home-based (delivery / pickup only)", "No tables. Staff optional — you can still use the Kitchen, Dispatch (check before sending out) and Rider screens yourself."]] },
};
const setupMode = () => PRESETS[wiz.businessType]?.mode;
// Food business: more than one way to sell (shop on weekdays, night market on weekends, pre-order bilao…)
const FOOD = [["dinein", "🍽", "Dine-in shop", "Café, karinderya, resto — table QR, kitchen & counter screens"], ["takeout", "🥤", "Take-out counter / kiosk", "Milk tea, shawarma stand — order numbers and ready alerts"], ["popup", "🌙", "Pop-up / night market / bazaar", "Pay first, waiting timer, “come back when it's ready”"], ["home", "🏠", "Home-based", "Lutong-bahay, baked goods — pickup and delivery"], ["preorder", "🎂", "Bilao / pre-order", "Bilao, cakes, party trays — pickup date and a daily limit"], ["online", "🛵", "Online only / cloud kitchen", "Delivery and pickup, no tables"]];
const isFood = () => wiz.businessType === "cafe";
const foodKind = () => (wiz.channels?.has("dinein") ? "shop" : "home");
const foodPayDefault = () => (wiz.channels?.size === 1 && wiz.channels.has("dinein") ? "after" : "first");
const PLACES = [["shop", "🏪 In my shop", "Walk-ins and bookings at your shop."], ["home", "🏠 Home service only", "You go to your clients. No walk-ins — bookings with address, area fee and travel time."], ["both", "🏪+🏠 Both", "Shop and home service, each with its own hours on your calendar."]];
function drawPlace() {
  const box = $("placeChoices"); if (!box) return;
  const show = setupMode() === "salon" && !!wiz.setup; $("placeBox").classList.toggle("hidden", !show); if (!show) return;
  if (!wiz.place) wiz.place = wiz.setup === "solo" ? "both" : "shop";
  box.innerHTML = PLACES.map(([k, l]) => `<button type="button" class="chip ${wiz.place === k ? "on" : ""}" role="radio" aria-checked="${wiz.place === k}" data-place="${k}" style="border:1px solid ${wiz.place === k ? "#C62828" : "#D1D5DB"};border-radius:999px;padding:8px 14px;font-weight:${wiz.place === k ? 600 : 500};color:${wiz.place === k ? "#B91C1C" : "#111"};background:${wiz.place === k ? "#FDECEC" : "#fff"}">${l}</button>`).join("");
  $("placeHint").textContent = PLACES.find(([k]) => k === wiz.place)?.[2] || "";
  box.querySelectorAll("[data-place]").forEach((b) => (b.onclick = () => { wiz.place = b.dataset.place; drawPlace(); }));
}
const needsOwnerProfile = () => (setupMode() === "salon" && wiz.setup !== "solo" && wiz.ownerWorks) || (setupMode() === "table" && wiz.setup === "home" && wiz.team !== "solo");

function slugify(s) {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}
function goStep(n) {
  document.querySelectorAll("#wizard [data-step]").forEach((s) => s.classList.toggle("hidden", Number(s.dataset.step) !== n));
  [1, 2, 3, 4].forEach((i) => $("s" + i).classList.toggle("done", i <= n));
  wizMsg("");
}
function wizMsg(text, type = "error") {
  $("wizMsg").innerHTML = text ? `<div class="alert ${type}">${esc(text)}</div>` : "";
}

function initWizard() {
  if ($("wizEmail")) $("wizEmail").textContent = currentUser?.email || "";
  if (addingBusiness && $("wizWho")) $("wizWho").innerHTML = `Adding <b>another business</b> to ${esc(currentUser?.email || "your account")} — it gets its own menu, staff, QR and plan. <a href="#" id="wizSwitch">← Back to my business</a>`;
  try { const sn = localStorage.getItem("taptayo:shopName"); if (sn && $("bizName") && !$("bizName").value) $("bizName").value = sn; } catch {}
  if ($("wizSwitch")) $("wizSwitch").onclick = async (e) => { e.preventDefault(); await signOut(auth); location.replace("/login/"); };
  const wrap = $("types");
  const sellBox = $("sell");
if (sellBox && !sellBox.childElementCount) {
  [["food", "Food"], ["service", "Service"], ["stay", "Stay"]].forEach(([k, label]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "type";
    b.innerHTML = `<div class="t">${label}</div>`;
    b.onclick = () => {
      wiz.sell = k;
      wiz.businessType = null;
      sellBox.querySelectorAll(".type").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      $("next1").disabled = true;
      initWizard();
    };
    sellBox.appendChild(b);
  });
}
  wrap.innerHTML = "";
  for (const [key, p] of Object.entries(PRESETS).sort((a, b) => !!a[1].comingSoon - !!b[1].comingSoon)) {
    const sellOf = { cafe: "food", restaurant: "food", salon: "service", spa: "service", makeup: "service", tattoo: "service", clinic: "service", laundry: "service", stay: "stay" };
if ((p.hidden && key !== "restaurant" && key !== "clinic") || sellOf[key] !== wiz.sell) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "type";
    btn.dataset.key = key;
    btn.innerHTML = `<div class="ic">${p.icon}</div><div class="t">${p.title}${p.comingSoon ? ' <span style="font-size:11px;font-weight:700;background:#FDECEC;color:#B91C1C;border-radius:999px;padding:2px 8px;vertical-align:middle">Coming soon</span>' : ""}</div><div class="b">${p.blurb}</div>`;
    if (p.comingSoon) { btn.disabled = true; btn.style.opacity = ".55"; btn.style.cursor = "not-allowed"; btn.title = "Coming soon"; wrap.appendChild(btn); continue; }
    btn.onclick = () => {
      wiz.businessType = key;
      wrap.querySelectorAll(".type").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      $("next1").disabled = false;
    };
    wrap.appendChild(btn);
  }
  // preselect the edition picked on the landing page
  try {
    const pre = localStorage.getItem("taptayo:edition");
    const b = pre && wrap.querySelector(`.type[data-key="${CSS.escape(pre)}"]`);
    if (b && !b.disabled) b.click();
  } catch {}
  const drawFood = () => {
    wiz.channels ||= new Set(); $("setupTitle").textContent = "How do you sell? Pick all that apply.";
    const box = $("setupChoices"); box.innerHTML = "";
    const ready = () => { wiz.setup = wiz.channels.size ? foodKind() : null; $("next2s").disabled = !(wiz.channels.size && wiz.team && wiz.pay); };
    FOOD.forEach(([k, ic, t, b]) => {
      const btn = document.createElement("button"); btn.type = "button"; btn.className = "type" + (wiz.channels.has(k) ? " active" : ""); btn.setAttribute("aria-pressed", String(wiz.channels.has(k)));
      btn.innerHTML = `<div class="ic">${ic}</div><div class="t">${esc(t)}</div><div class="b">${esc(b)}</div>`;
      btn.onclick = () => { wiz.channels.has(k) ? wiz.channels.delete(k) : wiz.channels.add(k); btn.classList.toggle("active", wiz.channels.has(k)); btn.setAttribute("aria-pressed", String(wiz.channels.has(k))); if (!wiz.payPicked) { wiz.pay = wiz.channels.size ? foodPayDefault() : null; drawPay(); } ready(); };
      box.appendChild(btn);
    });
    const extra = document.createElement("div"); extra.style.cssText = "grid-column:1/-1;display:flex;flex-direction:column;gap:12px;margin-top:6px";
    extra.innerHTML = `<div><div style="font-weight:800;margin-bottom:6px">Who does the work?</div><div class="row wrap" style="gap:8px" role="radiogroup" aria-label="Who does the work" data-team></div></div>
      <div><div style="font-weight:800;margin-bottom:6px">When do customers pay?</div><div class="row wrap" style="gap:8px" role="radiogroup" aria-label="When do customers pay" data-pay></div><p class="small muted" style="margin:6px 0 0" data-payhint></p></div>`;
    box.appendChild(extra);
    const chip = (on, label) => `border:1px solid ${on ? "#C62828" : "#D1D5DB"};border-radius:999px;padding:8px 14px;font-weight:${on ? 600 : 500};color:${on ? "#C62828" : "inherit"};background:${on ? "#FDECEC" : "#fff"}`;
    const drawTeam = () => { const el = extra.querySelector("[data-team]"); el.innerHTML = [["solo", "🙋 Just me — one phone, no PINs"], ["staff", "👥 I have staff — roles and PINs"]].map(([k, l]) => `<button type="button" class="chip" role="radio" aria-checked="${wiz.team === k}" data-k="${k}" style="${chip(wiz.team === k)}">${l}</button>`).join(""); el.querySelectorAll("[data-k]").forEach((b) => (b.onclick = () => { wiz.team = b.dataset.k; drawTeam(); ready(); })); };
    const drawPay = () => { const el = extra.querySelector("[data-pay]"); el.innerHTML = [["first", "💵 Pay first, then we make it"], ["after", "🍽 Pay after eating"]].map(([k, l]) => `<button type="button" class="chip" role="radio" aria-checked="${wiz.pay === k}" data-k="${k}" style="${chip(wiz.pay === k)}">${l}</button>`).join(""); extra.querySelector("[data-payhint]").textContent = wiz.pay === "first" ? "Best for pop-ups, take-out, home-based and pre-orders — the order goes to the kitchen once it's paid." : wiz.pay === "after" ? "Best for dine-in — the bill is settled at the end." : ""; el.querySelectorAll("[data-k]").forEach((b) => (b.onclick = () => { wiz.pay = b.dataset.k; wiz.payPicked = true; drawPay(); ready(); })); };
    drawTeam(); drawPay(); ready();
    $("ownerWorksBox").classList.add("hidden"); $("placeBox").classList.add("hidden");
  };
  const drawSetup = () => {
    if (isFood()) return drawFood();
    const cfg = SETUPS[setupMode()]; if (!cfg) return;
    $("setupTitle").textContent = wiz.businessType === "spa" ? cfg.title.replace("salon", "spa") : cfg.title;
    const box = $("setupChoices"); box.innerHTML = "";
    cfg.choices.forEach(([k, ic, t, b]) => {
      const btn = document.createElement("button"); btn.type = "button"; btn.className = "type" + (wiz.setup === k ? " active" : "");
      btn.innerHTML = `<div class="ic">${ic}</div><div class="t">${esc(t)}</div><div class="b">${esc(b)}</div>`;
      btn.onclick = () => { wiz.setup = k; box.querySelectorAll(".type").forEach((x) => x.classList.toggle("active", x === btn)); $("next2s").disabled = false; $("ownerWorksBox").classList.toggle("hidden", !(setupMode() === "salon" && k === "team")); wiz.place = null; drawPlace(); };
      box.appendChild(btn);
    });
    $("next2s").disabled = !wiz.setup;
    $("ownerWorksBox").classList.toggle("hidden", !(setupMode() === "salon" && wiz.setup === "team"));
    drawPlace();
  };
  const toDetails = () => {
    const ob = $("ownerBox"); const t = ob?.querySelector("b"), d = ob?.querySelector("p");
    if (t) t.textContent = isFreelance() ? "Your profile" : "Your staff profile";
    if (d) d.textContent = isFreelance() ? "Your name is shown to clients. The PIN opens your bookings screen." : "You'll use this PIN on the counter and staff screens.";
    ask = 0; showAsk();
    goStep(3);
  };
  const isFreelance = () => wiz.businessType === "freelance";
  $("next1").onclick = () => {
    // freelancer / creator: always just you (no "how do you run your salon?") — clients book you, you can go to them
    if (isFreelance()) { wiz.setup = "solo"; wiz.ownerWorks = true; wiz.place = "both"; toDetails(); return; }
    if (SETUPS[setupMode()]) { if (!isFood() && !SETUPS[setupMode()].choices.some(([k]) => k === wiz.setup)) wiz.setup = null; drawSetup(); goStep(2); } else { wiz.setup = null; toDetails(); } };
  $("ownerWorks").onchange = (e) => (wiz.ownerWorks = e.target.checked);
  $("back2s").onclick = () => goStep(1);
  $("next2s").onclick = toDetails;
  $("back2").onclick = () => { if (ask > 0) { ask -= 1; showAsk(); wizMsg(""); return; } SETUPS[setupMode()] && !isFreelance() ? goStep(2) : goStep(1); };
  $("back3").onclick = () => goStep(3);
  $("bizName").oninput = (e) => ($("slugPreview").textContent = "/m/" + (slugify(e.target.value) || "…"));
  let ask = 0;
  const askList = () => [...document.querySelectorAll("#wizard [data-q]")].filter((el) => el.dataset.q !== "you" || needsOwnerProfile());
  const askTitle = { name: "What's the business name?", phone: "What's your mobile number?", address: "Where is the shop?", you: "Your name and PIN" };
  function showAsk() {
    const list = askList();
    ask = Math.max(0, Math.min(ask, list.length - 1));
    document.querySelectorAll("#wizard [data-q]").forEach((el) => el.classList.add("hidden"));
    list[ask]?.classList.remove("hidden");
    const h = $("qTitle"); if (h) h.textContent = askTitle[list[ask]?.dataset.q] || "Tell us about your business";
    const btn = $("next2"); if (btn) btn.textContent = ask === list.length - 1 ? "Continue" : "Next";
    list[ask]?.querySelector("input")?.focus();
  }
  $("next2").onclick = () => {
    const list = askList();
    const key = list[ask]?.dataset.q;
    if (key === "name" && $("bizName").value.trim().length < 2) return wizMsg("Enter your business name (min 2 characters).");
    if (key === "phone" && $("bizPhone").value.trim().length < 10) return wizMsg("Enter your mobile number.");
    if (ask < list.length - 1) { ask += 1; showAsk(); wizMsg(""); return; }
    wiz.name = $("bizName").value.trim();
    wiz.phone = $("bizPhone").value.trim();
    wiz.address = $("bizAddress").value.trim();
    if (wiz.name.length < 2) return wizMsg("Enter your business name (min 2 characters).");
    if (needsOwnerProfile()) {
      wiz.ownerName = $("ownerName").value.trim(); wiz.ownerPin = $("ownerPin").value.trim();
      if (wiz.ownerName.length < 2) return wizMsg("Enter your name for your staff profile.");
      if (!/^\d{4,6}$/.test(wiz.ownerPin)) return wizMsg("Your PIN must be 4–6 digits.");
    }
    const p = PRESETS[wiz.businessType];
    const setupLabel = isFood() && wiz.channels?.size ? `${FOOD.filter(([k]) => wiz.channels.has(k)).map(([, , t]) => t).join(" · ")} — ${wiz.team === "solo" ? "just me" : "with staff"}, ${wiz.pay === "first" ? "pay first" : "pay after"}` : SETUPS[p.mode]?.choices.find(([k]) => k === wiz.setup)?.[2];
    const placeTxt = p.mode === "salon" && wiz.place ? PLACES.find(([k]) => k === wiz.place)?.[1] || "" : "";
    const rows = [["Business", esc(wiz.name)], ["Type", `${p.icon} ${esc(p.title)}`],
      ...(setupLabel ? [["Setup", `${esc(setupLabel)}${wiz.ownerWorks && wiz.setup === "team" ? "<br><span class=\"muted small\">You also serve clients</span>" : ""}`]] : []),
      ...(placeTxt ? [["Where", esc(placeTxt.replace(/^[^A-Za-z]+/, ""))]] : []),
      [p.labels.items, esc(p.categories.join(", "))], ["Your page", `<span class="code">taptayo.com/m/${esc(slugify(wiz.name))}</span>`]];
    $("review").innerHTML = `<dl class="review-list">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;
    goStep(4);
  };
  // mobile number check (SMS code) before the store is created — one free trial per real number
  let otpOk = false;
  const otpStep = async () => {
    if (addingBusiness || otpOk) return true;
    const r = await call("sendSignupOtp", { phone: wiz.phone });
    if (r.skipped) { otpOk = true; return true; }
    return new Promise((resolve) => {
      let box = document.getElementById("otpBox"); box?.remove();
      box = document.createElement("div"); box.id = "otpBox"; box.className = "tile"; box.style.cssText = "margin-top:12px;border:2px solid var(--primary,#C62828)";
      box.innerHTML = `<b>📱 Enter the 6-digit code</b><p class="small muted" style="margin:4px 0 8px">We texted it to ${esc(r.phone)}. It may take up to a minute.</p>
        <div class="row" style="gap:8px"><input id="otpCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" style="max-width:160px;font-size:1.3rem;letter-spacing:4px;text-align:center"/><button class="btn" type="button" id="otpVerify">Verify</button></div>
        <div class="small" style="margin-top:8px"><a href="#" id="otpResend">Send a new code</a> · <a href="#" id="otpBack">Change number</a></div><div id="otpMsg" class="small" style="color:#B42318;margin-top:6px"></div>`;
      $("review").after(box); box.querySelector("#otpCode").focus();
      const msg = (t) => (box.querySelector("#otpMsg").textContent = t);
      box.querySelector("#otpVerify").onclick = async (e) => { e.target.disabled = true; try { await call("verifySignupOtp", { code: box.querySelector("#otpCode").value }); otpOk = true; box.remove(); resolve(true); } catch (x) { msg(x.message); e.target.disabled = false; } };
      box.querySelector("#otpCode").oninput = (e) => { if (e.target.value.replace(/\D/g, "").length === 6) box.querySelector("#otpVerify").click(); };
      box.querySelector("#otpResend").onclick = async (e) => { e.preventDefault(); try { await call("sendSignupOtp", { phone: wiz.phone }); msg("New code sent ✓"); } catch (x) { msg(x.message); } };
      box.querySelector("#otpBack").onclick = (e) => { e.preventDefault(); box.remove(); resolve(false); goStep(3); };
    });
  };
  // email + password sign-ups confirm their email first (free; Google accounts are already verified)
  const emailStep = () => Promise.resolve(true);
  const emailStepUnused = () => {
    const u = currentUser; if (addingBusiness || !u || u.emailVerified || !(u.providerData || []).some((x) => x.providerId === "password")) return Promise.resolve(true);
    const send = () => sendEmailVerification(u, { url: `${location.origin}/app/` }).catch((e) => { if (!/too-many/.test(e.code || "")) throw e; });
    return new Promise((resolve) => {
      let box = document.getElementById("evBox"); box?.remove();
      box = document.createElement("div"); box.id = "evBox"; box.className = "tile"; box.style.cssText = "margin-top:12px;border:2px solid var(--primary,#C62828)";
      box.innerHTML = `<b>📧 Confirm your email</b><p class="small muted" style="margin:4px 0 8px">We sent a link to <b>${esc(u.email)}</b>. Open it (check Spam / Promotions too), then come back and tap the button.</p>
        <div class="row wrap" style="gap:8px"><button class="btn" type="button" id="evDone">I've confirmed it</button><button class="btn ghost" type="button" id="evResend">Send the link again</button></div><div id="evMsg" class="small" style="margin-top:6px;color:#B42318"></div>`;
      $("review").after(box);
      const msg = (t, ok) => { const m = box.querySelector("#evMsg"); m.style.color = ok ? "#15803D" : "#B42318"; m.textContent = t; };
      send().catch((e) => msg(e.message));
      box.querySelector("#evResend").onclick = async () => { try { await sendEmailVerification(u, { url: `${location.origin}/app/` }); msg("Sent again ✓", true); } catch (e) { msg(/too-many/.test(e.code || "") ? "Please wait a minute before asking again." : e.message); } };
      box.querySelector("#evDone").onclick = async (e) => { e.target.disabled = true; await u.reload().catch(() => {}); if (u.emailVerified) { await u.getIdToken(true); box.remove(); resolve(true); } else { msg("Not confirmed yet — open the link in the email first."); e.target.disabled = false; } };
    });
  };
  $("createBtn").onclick = async () => {
    const btn = $("createBtn");
    btn.disabled = true;
    btn.textContent = "Creating…";
    try { await emailStep(); } catch (err) { wizMsg(err.message); btn.disabled = false; btn.textContent = "Create my store"; return; }
    btn.textContent = "Checking your number…";
    try { if (!(await otpStep())) { btn.disabled = false; btn.textContent = "Create my store"; return; } }
    catch (err) { wizMsg(err.message); btn.disabled = false; btn.textContent = "Create my store"; if (/mobile number/i.test(err.message)) goStep(3); return; }
    btn.textContent = "Creating…";
    try {
      await call("createStore", { bid: (() => { try { let b = localStorage.getItem("taptayo:bid"); if (!b) { b = Array.from(crypto.getRandomValues(new Uint8Array(12)), (x) => x.toString(16).padStart(2, "0")).join(""); localStorage.setItem("taptayo:bid", b); } return b; } catch { return null; } })(), ref: (() => { try { return localStorage.getItem("taptayo:ref"); } catch { return null; } })(), name: wiz.name, businessType: wiz.businessType, phone: wiz.phone, address: wiz.address, setup: wiz.setup ? { kind: wiz.setup, ownerWorks: wiz.ownerWorks, place: wiz.place || undefined, ...(isFood() && wiz.channels?.size ? { channels: [...wiz.channels], team: wiz.team, pay: wiz.pay } : {}) } : null, ownerName: wiz.ownerName || null, ownerPin: wiz.ownerPin || null });
      claims = (await currentUser.getIdTokenResult(true)).claims;
      hide("wizard");
      if (addingBusiness) { addingBusiness = false; location.hash = "#overview"; location.reload(); return; }
      await loadDashboard();
    } catch (err) {
      console.error(err);
      if (/OTP_REQUIRED/.test(err.message || "")) otpOk = false;
      wizMsg(String(err.message || "Could not create the store. Please try again.").replace("OTP_REQUIRED:", ""));
      btn.disabled = false;
      btn.textContent = "Create my store";
    }
  };
  goStep(1);
}

// ----------------------------------------------------------------------------
// Dashboard shell + router
// ----------------------------------------------------------------------------
const PAGES = {
  overview:     { title: "Overview",      icon: "🏠", render: renderOverview },
  rooms:        { title: "Rooms",         icon: "🏡", render: renderRoomsPage, onlyMode: "stay" },
  stays:        { title: "Bookings",      icon: "🧳", render: renderStaysPage, onlyMode: "stay" },
  menu:         { title: (l) => l.items,  icon: "📋", render: renderMenuPage, hideMode: ["stay"] },
  tables:       { title: (l, m, st) => (m === "table" && st?.settings?.setup?.kind !== "home" ? `${l.unit}s & QR` : "QR & link"), icon: "🔲", render: renderTablesPage },
  calendar:     { title: "Calendar",      icon: "🗓", render: (root, c) => renderCalendarPage(root, c), onlyMode: "salon" },
  projects:     { title: "Projects", icon: "📨", render: renderProjectsPage, onlyMode: "salon", onlyType: "freelance" },
  me:           { title: "Me", icon: "👤", render: renderMePage, hidden: true, nav: true },
  creators:     { title: "Invite a creator", icon: "🎥", render: renderCreatorsPage, ownerOnly: true, hideType: "freelance" },
  orders:       { title: (l) => `${l.order}s`, icon: "🧾", render: renderOrdersPage, hideMode: ["stay", "salon"] }, // salon appointments live in Calendar (this page read the wrong collection for salons)
  promos:       { title: "Promos",        icon: "🏷️", render: renderPromosPage, ownerOnly: true, hideMode: ["stay"], pro: "promos" },
  reservations: { title: "Reservations", icon: "📅", render: renderReservationsPage, onlyMode: "table", pro: ["reservations", "events_vip"] },
  reports:      { title: "Reports",       icon: "📈", render: renderReportsPage, ownerOnly: true, pro: "reports" },
  customers:    { title: "Customers",     icon: "👥", render: renderCustomersPage, ownerOnly: true },
  feedback:     { title: "Feedback",      icon: "⭐", render: renderFeedbackPage, ownerOnly: true, pro: "feedback" },
  announcements:{ title: "Announcements", icon: "📣", render: renderAnnouncementsPage, ownerOnly: true, pro: "announcements" },
  feed:         { title: "Explore feed", icon: "🌏", render: renderFeedPage, ownerOnly: true },
  pros:         { title: "Freelancers", icon: "🧑‍🎨", render: renderProsPage, ownerOnly: true, onlyMode: "salon" },
  branches:     { title: "Branches",      icon: "🏬", render: renderBranchesPage, ownerOnly: true },
  staff:        { title: "Staff",         icon: "👥", render: (root, c) => renderSettingsPage(root, c, { group: "team", sec: "staff" }), ownerOnly: true, nav: true },
  tools:        { title: "Tools",         icon: "🧰", render: (root, c, param) => renderToolsPage(root, c, param), ownerOnly: true, nav: true },
  settings:     { title: "All settings",  icon: "⚙️", render: renderSettingsPage, ownerOnly: true, hidden: true },
  billing:      { title: "Billing",       icon: "💳", render: renderBillingPage, ownerOnly: true },
};

// ---- plan limit reminders: near / at the daily or monthly cap → banner with Upgrade ----
let unsubUsage = null, lastUsage = {};
function watchUsage() {
  unsubUsage?.(); if (claims?.role !== "owner") return;
  unsubUsage = onSnapshot(doc(db, "stores", ctx.storeId, "stats", "usage"), (s) => { lastUsage = s.data() || {}; drawUsageBanner(); }, () => {});
}
function drawUsageBanner() {
  const main = document.querySelector(".main"); if (!main || !ctx?.store) return;
  const u = lastUsage, lim = limitsFor(ctx.sub, limitMode(ctx.store)), pn = PLANS[planOf(ctx.sub)]?.name || "Free";
  const [ch, cm] = String(ctx.store.settings?.businessDayCutoff || "00:00").split(":").map(Number);
  const dk = new Date(Date.now() + 8 * 3600e3 - ((ch || 0) * 60 + (cm || 0)) * 60000).toISOString().slice(0, 10), mon = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 7);
  const rows = [];
  const dayKey = ctx.store.mode === "laundry" ? "jobsPerDay" : "ordersPerDay";
  if (lim[dayKey] < UNLIMITED) rows.push([u.day === dk ? Math.max(0, (u.orders || 0) - (u.cancelledDay === dk ? u.cancelled || 0 : 0)) : 0, lim[dayKey], ctx.store.mode === "laundry" ? "jobs today" : "orders today", "tomorrow"]);
  if (lim.bookingsPerMonth < UNLIMITED) rows.push([u.month === mon ? u.bookings || 0 : 0, lim.bookingsPerMonth, "bookings this month", "next month"]);
  const hit = u.limitHit && Date.now() - u.limitHit.at < 86400000 && lim[u.limitHit.key] < UNLIMITED ? u.limitHit : null;
  let full = rows.find(([n, m]) => n >= m), near = rows.find(([n, m]) => n < m && n >= Math.ceil(m * 0.8));
  { const top = rows.map(([n, m, what]) => ({ pct: m ? Math.min(100, Math.round((n / m) * 100)) : 0, n, m, what })).sort((a, b) => b.pct - a.pct)[0] || null; const changed = JSON.stringify(top) !== JSON.stringify(ctx.usageTop || null); ctx.usageTop = top; if (changed) drawUpgrade(); }
  let msg = null, level = "warn";
  if (full) { level = "error"; msg = `🚫 <b>You've used all ${full[1]} ${full[2]}</b> on the ${pn} plan. New ${full[2].split(" ")[0]} are paused until ${full[3]} — customers are asked to message you.`; }
  else if (hit?.key === "bookingsPerDay") { level = "error"; msg = `📅 <b>${hit.date} is fully booked</b> (${hit.max} bookings a day on the ${pn} plan). Customers can only pick other days.`; }
  else if (near) msg = `⚠️ <b>${near[0]} of ${near[1]} ${near[2]}</b> used on the ${pn} plan — almost at the limit.`;
  let ban = document.getElementById("usageBanner");
  const dismissKey = `tt:usageDismiss:${ctx.storeId}:${dk}:${level}`;
  let dismissed = false; try { dismissed = localStorage.getItem(dismissKey) === "1"; } catch {}
  if (!msg || dismissed) { ban?.remove(); return; }
  if (!ban) { ban = document.createElement("div"); ban.id = "usageBanner"; main.prepend(ban); }
  ban.className = "alert " + level; ban.style.margin = "0 0 14px";
  ban.innerHTML = `<div class="row between wrap" style="gap:8px;align-items:center"><span>${msg}</span><span class="row" style="gap:6px"><a class="btn sm" href="#billing">Upgrade — from ₱99</a><button class="btn ghost sm" type="button" data-x>Later</button></span></div>`;
  ban.querySelector("[data-x]").onclick = () => { try { localStorage.setItem(dismissKey, "1"); } catch {} ban.remove(); };
}

function branchBannerCheck() {
  const branches = ctx?.branches || []; const idx = branches.findIndex((b) => b.storeId === ctx.storeId);
  let ob = document.getElementById("branchBanner");
  if (ctx?.sub && idx >= 0 && idx >= branchesAllowed(ctx.sub)) { if (!ob) { ob = document.createElement("div"); ob.id = "branchBanner"; ob.className = "alert error"; document.querySelector(".main").prepend(ob); } ob.innerHTML = `🏬 <b>This branch is over your plan's branch limit</b> (${branchesAllowed(ctx.sub)} allowed). Customers can't order here until you add the Branches add-on in <a href="#billing">Billing</a> or archive other branches.`; }
  else ob?.remove();
}
let freshChecked = false;
async function loadDashboard() {
  const storeId = claims.storeId;
  // cached copy first (instant on reopen), then check the server once in the background
  const sref = doc(db, "stores", storeId);
  let snap = null; try { snap = await getDocFromCache(sref); } catch {}
  if (!snap?.exists()) snap = await getDoc(sref);
  else if (!freshChecked) { freshChecked = true; const cachedAt = snap.data()?.updatedAt?.toMillis?.() || 0; getDoc(sref).then((f) => { if ((f.data()?.updatedAt?.toMillis?.() || 0) > cachedAt) loadDashboard(); }).catch(() => {}); }
  if (!snap.exists()) { initWizard(); show("wizard"); return wizMsg("Store record not found.", "warn"); }
  const store = { id: storeId, ...snap.data() };
  const preset = PRESETS[store.businessType] || PRESETS.cafe;
  const labels = store.settings?.labels || preset.labels;
  applyWording(store);
  // spa stores made before the plum default → move them to plum once (only if the owner never picked a color)
  if (claims.role === "owner" && store.businessType === "spa" && store.theme?.preset === "teal" && ["#0F766E", "#0D9488", null, undefined, ""].includes(store.theme?.primary)) {
    store.theme = { ...(store.theme || {}), preset: "spa", primary: "#7B2D8E" };
    updateDoc(doc(db, "stores", storeId), { "theme.preset": "spa", "theme.primary": "#7B2D8E", updatedAt: serverTimestamp() }).catch(() => {});
  }
  ctx = { storeId, store, labels, mode: store.mode, role: claims.role, user: currentUser, reload: loadDashboard, orgId: claims.orgId || null, drawTestTile: (el, c) => drawTestTile(el, c), drawSeasonTile: (el, c) => drawSeasonTile(el, c) };
  document.body.classList.add("dash");
  getDoc(doc(db, "users", currentUser.uid)).then((u) => { ctx.ownerName = u.data()?.name || null; }).catch(() => {});
  // branch switcher (owner with an org)
  document.getElementById("branchSwitch")?.remove();
  if (claims.orgId && claims.role === "owner") {
    onSnapshot(doc(db, "orgs", claims.orgId), (s) => {
      const org = s.data(); const branches = (org?.branches || []).filter((b) => !b.archived);
      ctx.org = org; ctx.branches = branches;
      document.getElementById("branchSwitch")?.remove();
      branchBannerCheck();
      if (currentPage() === "overview") route();
      if (branches.length < 2) return;
      const sel = document.createElement("select"); sel.id = "branchSwitch"; sel.className = "branch-switch";
      sel.innerHTML = branches.map((b) => `<option value="${b.storeId}" ${b.storeId === storeId ? "selected" : ""}>${esc(b.name)}</option>`).join("");
      sel.onchange = () => switchTo(sel.value);
      document.querySelector(".side .store").appendChild(sel);
    }, () => {});
  }

  applyTheme({ ...(store.theme?.preset ? store.theme : { ...store.theme, primary: store.theme?.primary || preset.theme.primary }), season: null });
  $("storeName").textContent = store.name;
  if (store.mode === "laundry" || store.mode === "salon") { const k = document.getElementById("kitchenLink"); if (k) k.style.display = "none"; }
  { const rl = document.getElementById("riderLink"); if (rl) rl.style.display = store.mode === "stay" || (store.mode === "salon" && !store.settings?.salon?.homeService?.escort) ? "none" : ""; }
  { const kl = document.getElementById("kitchenLink"); if (kl && store.mode === "stay") kl.style.display = "none"; }
  { const sl = document.getElementById("staffLink"); if (sl && store.mode === "stay") { sl.style.display = ""; sl.textContent = "🧹 Caretaker app"; } }
  { const dl = document.getElementById("dispatchLink"); if (dl) dl.style.display = store.mode === "table" && store.settings?.service?.dispatch !== false ? "" : "none"; }
  if (store.mode === "salon") { const k = document.getElementById("staffLink"); if (k) k.style.display = store.settings?.setup?.kind === "solo" ? "none" : ""; }
  const logoBox = document.querySelector(".side .store");
  logoBox.querySelector(".slogo")?.remove();
  if (store.logoUrl) logoBox.prepend(Object.assign(document.createElement("img"), { src: store.logoUrl, className: "slogo", alt: "" }));
  $("storeType").textContent = `${preset.icon} ${preset.title} · ${claims.role}`;
  $("welcome").textContent = `Welcome back, ${currentUser.displayName || currentUser.email}`;
  $("openMenuLink").href = `/m/${store.slug}`;
  drawSideR(store);

  // nav
  const nav = $("nav");
  nav.innerHTML = "";
  const MAIN = ["overview", "rooms", "stays", "orders", "calendar", "projects", "menu", "tables", "staff", "reports", "creators", "tools"];
  for (const key of MAIN) {
    const p = PAGES[key];
    if (p.onlyMode && p.onlyMode !== store.mode) continue;
    if (p.onlyType && p.onlyType !== store.businessType) continue;
    if (p.hideType && p.hideType === store.businessType) continue;
    if (p.hideMode?.includes(store.mode)) continue;
    if (p.ownerOnly && !ownerish()) continue;
    if (claims.role === "viewer" && ["billing", "branches"].includes(key)) continue;
    const title = typeof p.title === "function" ? p.title(labels, store.mode, store) : p.title;
    const a = document.createElement("a");
    a.href = "#" + key;
    a.dataset.page = key;
    a.innerHTML = `${icon(key)}<span>${esc(title)}</span>${key === "orders" ? `<span class="nav-pill" id="navNew" hidden></span>` : ""}`;
    nav.appendChild(a);
  }

  // bottom tabs (phones): Home · Orders/Calendar/Bookings · Menu/Services/Rooms · Reports · Me (opens the menu sheet)
  {
    const bn = $("bnav"); bn.innerHTML = "";
    const pick = (keys) => keys.find((k) => { const p = PAGES[k]; return p && !(p.onlyMode && p.onlyMode !== store.mode) && !p.hideMode?.includes(store.mode) && !(p.ownerOnly && !ownerish() && claims.role !== "owner"); });
    const tabs = [["overview", "Home"], [pick(["orders", "calendar", "stays"]), null], [pick(["menu", "rooms"]), null], [pick(["reports", "tables"]), null]].filter(([k]) => k);
    for (const [key, name] of tabs) {
      const p = PAGES[key]; const title = name || (typeof p.title === "function" ? p.title(labels, store.mode, store) : p.title);
      const a = document.createElement("a"); a.href = "#" + key; a.dataset.page = key;
      a.innerHTML = `${icon(key)}<span>${esc(title.replace(/ & QR$/, ""))}</span>${["orders", "calendar", "stays"].includes(key) ? '<i class="bn-badge" id="bnNew" hidden></i>' : ""}`;
      bn.appendChild(a);
    }
    const me = document.createElement("button"); me.type = "button"; me.dataset.page = "_me";
    me.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg><span>Me</span>`;
    me.onclick = (e) => { e.stopPropagation(); if (location.hash === "#me") $("navToggle").click(); else location.hash = "#me"; };
    bn.appendChild(me);
  }

  // subscription (live)
  unsubSub?.();
  unsubSub = onSnapshot(doc(db, "stores", storeId, "subscription", "current"), (s) => {
    const sub = s.data();
    if (!sub) return;
    const addonsChanged = JSON.stringify(ctx.sub?.addons || null) !== JSON.stringify(sub.addons || null) || ctx.sub?.plan !== sub.plan;
    const first = !ctx.sub;
    ctx.sub = sub; branchBannerCheck();
    if ((first || addonsChanged || JSON.stringify(ctx._prov || null) !== JSON.stringify(sub.provisional || null)) && !first && ["settings", "promos", "billing", "menu", "tables", "rooms", "staff", "reports", "feedback", "reservations", "announcements"].includes(currentPage())) setTimeout(route, 0);
    ctx._prov = sub.provisional || null;
    const pill = $("subPill");
    const eff = planOf(sub), prov = sub.provisional && Number(sub.provisional.until?.toMillis?.() || sub.provisional.until || 0) > Date.now();
    const until = (eff === "trial" ? sub.trialEndsAt : sub.paidUntil)?.toDate?.();
    const days = until ? Math.max(0, Math.ceil((until - Date.now()) / 86400000)) : null;
    const pname = PLANS[eff]?.name || "Free";
    const label = eff === "trial" ? "Basic · free 14 days" : eff === "free" ? "Free plan" : prov ? `${pname} · checking payment` : `${pname} plan`;
    pill.className = "pill " + (eff === "trial" ? "trial" : eff === "free" ? "past_due" : "active");
    pill.textContent = eff === "trial" && days != null ? `${label} · ${days} days left` : label;
    { const pn = $("planName"), ps = $("planSub"), pb = $("planBtn");
      if (pn) { pn.textContent = label; ps.textContent = eff === "trial" ? `${days ?? 0} days left` : eff === "free" ? "Small use · upgrade anytime" : prov ? "Active while we check (up to 3 days)" : until ? `until ${until.toLocaleDateString("en-PH", { month: "short", day: "numeric" })}` : ""; pb.textContent = eff === "free" || eff === "trial" ? "⚡ Upgrade plan" : "Manage plan"; pb.hidden = claims.role !== "owner"; } }
    ctx.planEff = eff; ctx.planDays = days; drawUpgrade();
    for (const [id, k, t] of [["kitchenLink", "stations", "🍳 Kitchen"], ["dispatchLink", "dispatch", "📋 Dispatch"], ["riderLink", "delivery", "🛵 Rider"]]) { const a = $(id); if (!a) continue; const ok = entitled(sub, k); if (!a.dataset.t) a.dataset.t = a.textContent; a.textContent = ok ? a.dataset.t : a.dataset.t.replace(/^\S+/, "🔒"); a.title = ok ? "" : `${PRO_FEATURES[k]} — upgrade in Billing`; }
    ctx.subLabel = label; setTimeout(drawUsageBanner, 0);
    ctx.subUntil = until;
    // banner when locked / past due
    let ban = document.getElementById("subBanner");
    if (eff === "free" && sub.plan && !["free", "trial"].includes(sub.plan)) {
      if (!ban) { ban = document.createElement("div"); ban.id = "subBanner"; document.querySelector(".main").prepend(ban); }
      ban.className = "alert warn"; ban.style.margin = "0 0 16px";
      ban.innerHTML = `⚠️ Your ${esc(PLANS[sub.plan]?.name || "")} plan ended — you're on the <b>Free</b> plan now (your data is safe; extra items, tables and staff are hidden from customers). <a href="#billing">Renew →</a>`;
    } else if (false) {
      if (!ban) { ban = document.createElement("div"); ban.id = "subBanner"; document.querySelector(".main").prepend(ban); }
      ban.className = "alert " + (sub.status === "locked" ? "error" : "warn");
      ban.style.margin = "0 0 16px";
      ban.innerHTML = sub.status === "locked"
        ? `🔒 <b>Your store is locked.</b> Customers cannot place orders. <a href="#billing">Renew in Billing →</a>`
        : `⚠️ Your subscription has expired. ${Math.max(0, 3 + (days ?? 0))} day(s) left before the store is locked. <a href="#billing">Renew →</a>`;
    } else ban?.remove();
    if (currentPage() === "overview" || currentPage() === "billing") route();
  });

  watchUsage();
  window.onhashchange = route;
  route();
  show("dash");
  if (claims.role === "owner") { resumeGuide(ctx); maybeTour(ctx); }
  if (claims.role === "viewer") demoChrome(store);
  autoSolo();
  if (!window.__supWired) { window.__supWired = true; if (claims.role !== "viewer") supportAsShop();
    const hb = document.getElementById("helpBtn"); if (hb) hb.onclick = () => { document.body.classList.remove("nav-open"); openSupport(); };
    supportBadge((n) => { const d = document.getElementById("helpDot"); if (d) { d.hidden = !n; d.textContent = n; } });
    if (location.hash === "#help") openSupport(); window.addEventListener("hashchange", () => { if (location.hash === "#help") openSupport(); }); }
}

function currentPage() {
  const key = (location.hash || "#overview").slice(1).split("/")[0];
  if (!PAGES[key]) return "overview";
  // pages hidden for this business type can't be opened by hash either
  const p = PAGES[key], mode = ctx?.store?.mode;
  if (mode && (p.hideMode?.includes(mode) || (p.onlyMode && p.onlyMode !== mode))) return key === "orders" && mode === "salon" ? "calendar" : "overview";
  return key;
}
const pageParam = () => (location.hash || "").slice(1).split("/").slice(1).join("/");

function route() {
  const key = currentPage();
  const p = PAGES[key];
  const navKey = PAGES[key].nav || ["overview", "rooms", "stays", "orders", "calendar", "menu", "tables", "reports"].includes(key) ? key : "tools"; // pages opened from Tools keep Tools highlighted
  document.querySelectorAll(".bnav [data-page]").forEach((a) => { const on = a.dataset.page === key || (a.dataset.page === "_me" && !document.querySelector(`.bnav [data-page="${key}"]`)); a.classList.toggle("on", on); });
  document.querySelectorAll(".nav a").forEach((a) => { const on = a.dataset.page === navKey; a.classList.toggle("active", on); if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  const title = typeof p.title === "function" ? p.title(ctx.labels, ctx.mode, ctx.store) : p.title;
  $("pageTitle").textContent = title;
  document.body.classList.toggle("on-overview", key === "overview");
  document.body.classList.remove("nav-open"); $("navToggle")?.setAttribute("aria-expanded", "false");
  mountBell($("bellSlot"), ctx);
  document.title = `${title} — ${ctx.store.name}`;

  closeModal();
  unsubPage?.();
  unsubPage = null;
  const root = $("page");
  root.innerHTML = "";
  if (p.soon) {
    root.innerHTML = `<div class="tile"><h3>${esc(title)} — coming in ${p.soon}</h3><p class="muted">Coming in a future build.</p></div>`;
    return;
  }
  if (p.pro && ctx.sub && ![].concat(p.pro).some((k) => entitled(ctx.sub, k))) {
    const need = Math.min(...[].concat(p.pro).map((k) => FEATURE_TIER[k] ?? 1)); const pn = ["Free", "Basic", "Pro", "Business"][need] || "Pro";
    root.innerHTML = `<div class="tile pro-lock"><div class="pl-ic">⭐</div><h3>${esc(title)} — ${pn} plan</h3><p class="muted">You're on the <b>${esc(PLANS[planOf(ctx.sub)]?.name || "Free")}</b> plan. ${esc(title)} comes with <b>${pn}</b> (₱${PLANS[["free", "starter", "plus", "business"][need]]?.price || 0}/month) and higher.</p><a class="btn" href="#billing">See plans</a></div>`;
    return;
  }
  const r = p.render(root, ctx, pageParam());
  if (typeof r === "function") unsubPage = r;
}

// ----------------------------------------------------------------------------
// Overview page
// ----------------------------------------------------------------------------
const testLive = (store) => !!(store.settings?.testMode?.on && Number(store.settings.testMode.until || 0) > Date.now());
/** Test mode: practice orders on one device (numbered T1, T2…, not counted in sales) */
function drawTestTile(el, ctx) {
  const { store, storeId } = ctx;
  const on = testLive(store);
  const until = on ? new Date(store.settings.testMode.until) : null;
  const m = store.mode;
  const screens = m === "table" ? [["🧾 Counter", "/counter/"], ["🍳 Kitchen", "/kitchen/"], ["☕ Barista", "/kitchen/?station=barista"], ["📋 Dispatch", "/dispatch/"], ["🛵 Rider", "/rider/"]]
    : m === "salon" ? [["🧾 Reception", "/counter/"], [store.businessType === "spa" ? "💆 Therapist app" : "💇 Staff app", "/staff/"], ...(store.settings?.salon?.homeService?.escort ? [["🛵 Rider", "/rider/"]] : [])] : m === "laundry" ? [["🧾 Counter", "/counter/"], ["🛵 Rider", "/rider/"]] : [["🛎 Front desk", "/counter/"], ["🧹 Caretaker", "/staff/"]];
  el.className = "tile test-tile" + (on ? " on" : "");
  el.innerHTML = `<div class="row between wrap" style="gap:8px"><div><h3 style="margin:0">🧪 Test mode ${on ? `<span class="pill" style="background:#ffe58a;color:#6b4a00">ON until ${until.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}</span>` : ""}</h3>
      <p class="small muted" style="margin:2px 0 0">Try everything on <b>one phone or laptop</b>: ${m === "table" ? "order as a customer, then accept, cook and serve in the other screens. Test orders are numbered <b>T1, T2…</b>, ignore opening hours and the table QR," : m === "salon" ? "book as a customer, then assign, start, finish and check out at the reception. Test bookings are coded <b>T-…</b>, skip the advance-notice rule and the one-booking-per-number rule," : m === "laundry" ? "book a job as a customer, then weigh, wash and release it at the counter. Test jobs are numbered <b>T1, T2…</b>" : "book a stay as a customer, then confirm, check in and check out at the desk. Test bookings are tagged <b>TEST</b>"} and are never counted in sales.${on ? " You can skip the PIN on staff screens while testing." : ""}</p></div>
      <button class="btn ${on ? "ghost" : ""} sm" type="button" data-test>${on ? "Turn off" : "Turn on (2 hours)"}</button></div>
    ${on ? `<div class="test-links"><a class="btn sm" href="/m/${esc(store.slug)}" target="_blank">📱 Customer page</a>${screens.map(([l, u]) => `<a class="btn ghost sm" href="${u}" target="_blank">${l}</a>`).join("")}</div>
    <p class="small muted" style="margin:8px 0 0">Tip: each button opens a new tab. Switch tabs to play each role. <a href="#" data-clear>Delete all test data</a></p>` : ""}`;
  el.querySelector("[data-test]").onclick = async () => {
    const next = on ? { on: false, until: 0 } : { on: true, until: Date.now() + 2 * 3600e3 };
    try { await updateDoc(doc(db, "stores", storeId), { "settings.testMode": next, updatedAt: serverTimestamp() }); store.settings = { ...(store.settings || {}), testMode: next }; drawTestTile(el, ctx); toast(next.on ? "Test mode is on for 2 hours" : "Test mode off"); }
    catch (e) { toast(e.message, "error"); }
  };
  el.querySelector("[data-clear]")?.addEventListener("click", async (e) => { e.preventDefault(); if (!confirm("Delete all test orders and bookings?")) return; try { const r = await call("clearTestOrders", {}); toast(`Deleted ${r.deleted} test record${r.deleted === 1 ? "" : "s"}`); } catch (err) { toast(err.message, "error"); } });
}
/** Seasonal theme picker (Tools → Shop) */
function drawSeasonTile(el, ctx) {
  const { store, storeId } = ctx;
  const locked = ctx.sub && !entitled(ctx.sub, "themes");
  el.className = "tile";
  el.innerHTML = `<h3>🎨 Seasonal theme</h3><p class="small muted">Changes the colors and decorations of your customer menu and order status page only.</p>
    ${locked ? `<p class="small">⭐ Seasonal themes are a <b>Pro</b> feature. <a href="#billing">See plans</a></p>` : `<div class="season-chips">
      <button type="button" data-season="" class="${!store.theme?.season ? "on" : ""}"><span class="sw" style="background:var(--grid)"></span>Off · default</button>
      ${Object.entries(SEASONS).map(([k, v]) => `<button type="button" data-season="${k}" class="${store.theme?.season === k ? "on" : ""}"><span class="sw" style="background:${v.g}"></span>${v.icon} ${esc(v.name)}</button>`).join("")}</div>`}`;
  el.querySelectorAll("[data-season]").forEach((b) => (b.onclick = async () => {
    const season = b.dataset.season || null;
    el.querySelectorAll("[data-season]").forEach((x) => x.classList.toggle("on", x === b));
    try { await updateDoc(doc(db, "stores", storeId), { "theme.season": season, updatedAt: serverTimestamp() }); store.theme = { ...(store.theme || {}), season }; toast(season ? `${SEASONS[season].name} theme is on` : "Seasonal theme off"); }
    catch (e) { toast(e.message, "error"); }
  }));
}

// ---- read-only demo dashboard chrome: banner, staff screens → demo pages, guided tour ----
let demoShown = false;
function demoChrome(store) {
  if (demoShown) return; demoShown = true;
  document.querySelectorAll(".screens a").forEach((a) => { if (a.id !== "openMenuLink") a.style.display = "none"; });
  ["planSticker", "logoutBtn"].forEach((id) => { const el = document.getElementById(id); if (el) el.style.display = "none"; });
  const st = document.getElementById("storeType"); if (st) st.textContent = st.textContent.replace(/· viewer$/, "· demo");
  const shop = document.getElementById("openMenuLink"); if (shop) shop.href = `/m/${store.slug}`;
  const ban = document.createElement("div");
  ban.className = "demo-banner"; ban.setAttribute("role", "status");
  ban.innerHTML = `<span>👀 <b>Demo dashboard</b> of ${esc(store.name)} — look around. Nothing you change is saved.</span><a class="btn sm" href="/m/${esc(store.slug)}" target="_blank" rel="noopener">Open the customer page</a><button class="btn sm ghost" type="button" data-tour>▶ Tour</button><a class="btn brand sm" href="/login/?signup=1&type=${esc(store.businessType || "")}">Start free</a>`;
  document.body.prepend(ban);
  const go = () => { document.body.classList.remove("nav-open"); location.hash = "#overview"; setTimeout(() => maybeTour({ store, storeId: store.id }, true, DEMO_TOUR(store)), 600); };
  ban.querySelector("[data-tour]").onclick = go;
  go();
}
const DEMO_TOUR = (store) => [
  ["[data-page=overview]", "Today at a glance", "Sales, bookings, the live line and what needs your attention — updated as it happens."],
  ["[data-page=calendar], [data-page=orders], [data-page=stays]", store.mode === "salon" ? "Calendar & bookings" : "Orders & bookings", store.mode === "salon" ? "Every booking, walk-in and home service on one calendar, per staff member." : "Every order with its status and payment, live."],
  ["[data-page=menu], [data-page=rooms]", store.mode === "salon" ? "Services & prices" : "Menu & prices", "Add what you sell with photos and prices. Customers see changes right away."],
  ["[data-page=promos]", "Promos", "Weekday deals, combos and promo codes — with the days and hours they run."],
  ["[data-page=reports]", "Reports", "Sales, staff pay, the busiest hours and how long people waited."],
  ["[data-page=tools], .bnav [data-page=_me]", "Settings", "Payments, hours, staff, the walk-in line and alerts — all in one place."],
  ["#openMenuLink, .demo-banner a[target]", "Your customer page", "This is what your customers open from your QR code or link."],
];


// Wide screens (≥ 1500px): a right column with shortcuts so the dashboard isn't half empty
async function drawSideR(store) {
  const el = document.getElementById("sideR"); if (!el) return;
  const link = `https://taptayo.com/m/${store.slug}`;
  let qr = ""; try { const { qrGroup } = await import("./brandqr.js"); qr = `<svg viewBox="0 0 120 120" width="104" height="104" aria-label="QR of your page">${qrGroup(link, { size: 120, color: "#141414" })}</svg>`; } catch {}
  const done = Number(store.stats?.txDone) || 0, people = Number(store.stats?.txCustomers) || 0;
  const created = store.createdAt?.toDate?.() || (store.createdAt?.seconds ? new Date(store.createdAt.seconds * 1000) : null);
  const ageDays = created ? Math.floor((Date.now() - created.getTime()) / 86400000) : 0;
  const gold = done >= 50 && people >= 10 && ageDays >= 7;
  const bar = (label, now, max, text) => `<div class="gb-row"><div class="gb-top"><span>${label}</span><b>${text}</b></div><div class="gb-bar"><i style="width:${Math.max(0, Math.min(100, Math.round((now / max) * 100)))}%"></i></div></div>`;
  const tips = ["Put your QR at the counter and on every table — most orders come from the QR.", "Reply to reviews: shops that reply get more repeat customers.", "Turn on reminders to cut no-shows.", "Post an announcement for holidays and new items — customers see it on your page.", "Share your page link on your Facebook page's button (Book now / Order)."];
  const esc2 = (x) => String(x ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  el.innerHTML = `<section class="tile sr-box"><h3>🔗 Your page</h3><div class="sr-share">${qr}<div><div class="small muted" style="word-break:break-all">${esc2(link.replace("https://", ""))}</div><div class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap"><button class="btn sm" type="button" data-copy>Copy link</button><a class="btn ghost sm" target="_blank" rel="noopener" href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(`https://taptayo.com/s/${store.slug}`)}">📤 Share on Facebook</a><a class="btn ghost sm" href="/m/${esc2(store.slug)}" target="_blank" rel="noopener">Open</a></div></div></div></section>
    <section class="tile sr-box"><h3>Gold badge</h3>${gold ? `<p class="small" style="margin:0">On. Customers see the gold badge.</p>` : `${bar("Finished orders", done, 50, `${done} / 50`)}${bar("Different customers", people, 10, `${people} / 10`)}${bar("Shop age", ageDays, 7, ageDays >= 7 ? "7 days" : `${ageDays} / 7 days`)}`}</section>
    <section class="tile sr-box"><h3>💡 Tip</h3><p class="small" style="margin:0">${esc2(tips[new Date().getDate() % tips.length])}</p></section>
    <section class="tile sr-box"><h3>💬 Need help?</h3><p class="small muted" style="margin:0 0 8px">We reply within 24 hours — no calls needed.</p><button class="btn ghost sm" type="button" data-help>Message TapTayo</button></section>`;
  el.querySelector("[data-copy]")?.addEventListener("click", async (e) => { try { await navigator.clipboard.writeText(`https://taptayo.com/s/${store.slug}`); /* share link: shows the cover photo + name on Facebook / Messenger */ e.target.textContent = "✓ Copied"; } catch {} });
  el.querySelector("[data-help]")?.addEventListener("click", () => document.getElementById("helpBtn")?.click());
  drawUpgrade();
}


// ⚡ Upgrade: the plan sticker (left) glows on trial / Free / near the limits; a bigger card sits on top of the right column (wide screens).
// Quiet on Business (top plan). Owners only.
function drawUpgrade() {
  const eff = ctx?.planEff; if (!eff || claims?.role !== "owner") return;
  const tier = PLANS[eff]?.tier ?? 0, top = ctx.usageTop, near = top && top.pct >= 80;
  const loud = eff === "trial" || eff === "free" || near;
  document.getElementById("planSticker")?.classList.toggle("glow", !!loud && tier < 3);
  const el = document.getElementById("sideR"); if (!el) return;
  el.querySelector(".upr")?.remove();
  if (tier >= 3 || ctx.store?.demo) return;
  const isCreator = ctx.store?.businessType === "freelance";
  const next = isCreator ? PLANS.creator : eff === "plus" || eff === "basic" ? PLANS.business : PLANS.plus;
  const perks = next === PLANS.business ? ["Your brand only (no TapTayo footer)", "Bigger limits for busy days", "More branches and staff", "Priority help"]
    : isCreator ? ["Unlimited deals and offers", "Portfolio and promos", "Rush jobs and contracts"]
    : ["Delivery + rider app", "Promos, loyalty stamps, gift cards", "More staff PINs and screens", "Reports and daily summary"];
  const head = eff === "trial" ? `Basic ends in ${ctx.planDays ?? 0} day${ctx.planDays === 1 ? "" : "s"} — keep it for ₱${PLANS.starter.price}/month` : eff === "free" ? `You're on Free · Basic is ₱${PLANS.starter.price}/month` : `₱${next.price}/month`;
  const card = document.createElement("section"); card.className = "upr";
  card.innerHTML = `<h3>👑 Upgrade to ${next.name}</h3><div class="upr-price">${head}</div>${top ? `<div class="upr-bar"><i style="width:${top.pct}%"></i></div><div class="upr-use">${top.n} of ${top.m} ${top.what} (${top.pct}%)</div>` : ""}<ul>${perks.map((x) => `<li>${x}</li>`).join("")}</ul><a class="upr-go" href="#billing">⚡ See plans</a>`;
  el.prepend(card);
}
