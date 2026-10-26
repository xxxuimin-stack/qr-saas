// Demo playground stories. Each story = a few people's phones (roles), a list of steps (the guided path),
// actions (what a tap changes + who gets notified) and views (the HTML each phone shows, in the real app's style).
// Nothing here talks to the server — it all runs in the visitor's browser.
import { trustBadge } from "../trust.js";
export const peso = (n) => "₱" + Math.round(Number(n) || 0).toLocaleString("en-PH");
const IMG = (p) => `/demo/${p}`;
export const PLAN_COLOR = { Free: "#16A34A", Basic: "#2563EB", Pro: "#C62828", Business: "#111111", "Creator Pro": "#16A34A" };

// tiny builders (real app classes)
const cbtn = (label, act, cls = "", arg = "") => `<button class="c-btn ${cls}" data-act="${act}"${arg !== "" ? ` data-arg="${arg}"` : ""}>${label}</button>`;
const kbtn = (label, act, cls = "", arg = "") => `<button class="k-btn ${cls}" data-act="${act}"${arg !== "" ? ` data-arg="${arg}"` : ""}>${label}</button>`;
const obtn = (label, act, cls = "", arg = "") => `<button class="btn ${cls}" data-act="${act}"${arg !== "" ? ` data-arg="${arg}"` : ""}>${label}</button>`;
const info = (label, text, cls = "c-btn ghost") => `<button class="${cls}" data-info="${text.replace(/"/g, "&quot;")}">${label}</button>`;
const chip = (t, c = "") => `<span class="tt-chip ${c}">${t}</span>`;
const feed = (d) => `<div class="tt-feed">${d.feed.slice(-8).reverse().map(([t, x]) => `<div><time>${t.replace(/^\w+ /, "")}</time><span>${x}</span></div>`).join("") || `<span class="tt-muted">Nothing yet today.</span>`}</div>`;
const ownerTop = (name, plan = "PRO") => `<div class="tt-top"><span style="font-size:20px">👑</span><b>${name}</b><span class="tt-plan">${plan}</span></div>`;
const staffHead = (icon, who, shop, app) => `<header class="k-head"><span class="name">${icon} ${who}</span><span class="k-app">${app}</span><span class="sp"></span><span class="muted small">${shop}</span></header>`;
const stamp = (d, t, x) => { d.time = t; d.feed.push([t, x]); };
// the real customer-page top (cover photo → white info card with logo, name + gold seal badge, 📍 Directions, counts, tabs) — same classes as /m/
const DEMO_TRUST = { trust: { badges: ["verified", "dti", "bir", "permit"], tx: 1240 } };
const nameB = (name, extra = {}) => { const b = trustBadge({ name, ...DEMO_TRUST, ...extra }); const i = name.lastIndexOf(" "); return `${i > 0 ? name.slice(0, i + 1) : ""}<span style="white-space:nowrap">${name.slice(i + 1)}${b}</span>`; };
function shopTop({ name, cover, tag, where, count, rating, open, tabs = [], on = 0, news = "" }) {
  return `<header class="c-cover has-cover"><img class="cover" src="${IMG(cover)}" alt=""/></header>
    <section class="c-info"><div class="ci-top"><div class="ci-logo"><img src="/icons/icon-512.png" alt=""/></div><div class="ci-name"><h1>${nameB(name)}</h1><div class="ci-tag">${tag}</div>
      <a class="ci-where" data-info="Opens Google Maps with directions to the shop."><span>📍 ${where}</span><b>Directions</b></a><div class="ci-badges"><span class="ci-badge" style="color:#57534e;background:#f5f5f4">${count}</span></div></div></div>
      <div class="ci-meta"><span class="ci-rate">★ ${rating[0]} <span>(${rating[1]})</span></span><span class="ci-open">${open}</span></div></section>
    ${tabs.length ? `<nav class="c-tabs">${tabs.map((t, i) => `<button class="${i === on ? "active on" : ""}" data-info="${t} tab">${t}</button>`).join("")}</nav>` : ""}
    ${news ? `<div style="padding:10px 16px 0"><div class="tt-card" style="margin:0">📌 ${news}</div></div>` : ""}`;
}
const mins = (since, until) => Math.max(1, Math.round((((until || Date.now()) - since) / 1000)));

/* ───────────────────────── 🏡 STAYCATION ───────────────────────── */
const CLEAN = ["Change bed sheets & pillowcases", "Clean & disinfect bathroom", "Replace towels & toiletries", "Sweep & mop floors", "Empty trash bins", "Check aircon, lights, TV remote", "Report damages or lost items"];
const stay = {
  id: "stay", label: "Staycation / Airbnb", short: "Staycation", icon: "🏡", color: "#0D9488",
  shop: "Casa Laguna Staycation", signup: "stay",
  pitch: "From booking to a clean room — guest, caretaker, cleaner and owner, all in sync.",
  roles: [
    { id: "guest", label: "Guest", icon: "🙋", kind: "customer" },
    { id: "care", label: "Caretaker", icon: "🛎", kind: "staff" },
    { id: "clean", label: "Cleaner", icon: "🧹", kind: "staff" },
    { id: "owner", label: "Owner", icon: "👑", kind: "owner" },
  ],
  init: () => ({ stage: "browse", time: "Mon 10:10 AM", room: "free", issue: null, addon: null, checked: false, deposit: "none", ticks: CLEAN.map(() => false), cleanStart: 0, cleanEnd: 0, extra: 0, rated: 0, promo: false, sms: false, feed: [] }),
  steps: [
    { role: "guest", act: "book", title: "Book a room", hint: "On the <b>Guest</b> phone, tap <b>Book</b> — dates, guests, ID and GCash downpayment are already filled in.", did: "The owner's phone rang with the new booking and the GCash reference to check. The caretaker sees it too.", plan: "Free", feat: "Online booking + downpayment" },
    { role: "owner", act: "approve", title: "Owner checks the GCash payment", hint: "On the <b>Owner</b> phone, tap <b>✓ Payment received — approve</b>.", did: "The guest got the confirmation instantly. No more “nareceive mo na po ba?” chats.", plan: "Free", feat: "Payment check + approve" },
    { role: "care", act: "checkin", title: "Guest arrives — caretaker checks in", hint: "It's Saturday 2 PM. On the <b>Caretaker</b> phone, tap <b>🔑 Check in</b>.", did: "The guest got the WiFi password and house rules on their phone. The owner sees the room as occupied.", plan: "Basic", feat: "Caretaker app (staff PIN)" },
    { role: "guest", act: "issue", title: "Guest reports a problem", hint: "On the <b>Guest</b> phone, tap <b>🛠 Report a problem</b> (aircon not cold).", did: "The caretaker's phone rang right away — the owner doesn't have to relay messages at 9 PM.", plan: "Basic", feat: "Guest requests & problem reports" },
    { role: "care", act: "fix", title: "Caretaker fixes it", hint: "On the <b>Caretaker</b> phone, tap <b>✓ Fixed</b>.", did: "The guest got “fixed 👍” and the owner has a record of it.", plan: "Basic", feat: "Issue tracking" },
    { role: "guest", act: "checkout", title: "Guest checks out", hint: "Sunday morning. On the <b>Guest</b> phone, tap <b>🚪 I'm checking out</b>.", did: "The cleaner's phone is ringing 🔔 and the owner sees Garden Room as “To clean”.", plan: "Basic", feat: "Auto alert to the cleaner" },
    { role: "clean", act: "roomcheck", title: "Cleaner checks the room first", hint: "On the <b>Cleaner</b> phone, count the items and tap <b>✓ Room checked</b>.", did: "Nothing missing, no damage — the owner can return the deposit with proof. Disputes become rare.", plan: "Free", feat: "Room check & deposit" },
    { role: "clean", act: "startclean", title: "Start cleaning", hint: "Tap <b>🧽 Start cleaning</b>. Watch the Owner phone — a live timer starts.", did: "The owner sees “Cleaning · 1 min… 2 min…” live, and when it'll be ready.", plan: "Basic", feat: "Live cleaning timer" },
    { role: "clean", act: "finish", title: "Finish the checklist", hint: "Tick the checklist (or <b>Tick all</b>), then <b>✓ Finished cleaning — room ready</b>.", did: "Owner: Garden Room is ready, with how long it took. The next guest can be told they may come early.", plan: "Basic", feat: "Cleaning checklist" },
    { role: "owner", act: "refund", title: "Return the deposit", hint: "On the <b>Owner</b> phone, tap <b>💸 Return ₱1,000</b>.", did: "The guest got the refund notice with the room-check result. Done — no chat needed.", plan: "Free", feat: "Deposit return with proof" },
    { role: "owner", act: "promo", title: "Fill weekdays with a promo", hint: "Bonus · On the <b>Owner</b> phone, tap <b>🔥 Turn on Weekday Escape −20%</b>.", did: "The promo shows on your page right away — the guest phone already sees it.", plan: "Pro", feat: "Promos (weekday, short stay, early bird)", bonus: true },
    { role: "owner", act: "sms", title: "Text your past guests", hint: "Bonus · Tap <b>📱 Text past guests</b>.", did: "Past guests got an SMS with your link. One tap → more bookings.", plan: "Business", feat: "SMS promos", bonus: true },
  ],
  extras: [["Free", "Add-ons that need your OK (foam, blanket)"], ["Free", "Late check-out & extensions"], ["Free", "Reschedule & room moves"], ["Free", "Waiver + valid ID, kept private"], ["Pro", "Short stays (3 / 6 / 12 hours)"], ["Basic", "Reports: occupancy, cleaning time"], ["Business", "Gift cards"], ["Business", "Telegram alerts"], ["Business", "Your brand only — no “Powered by”"]],
  acts: {
    book(d) { d.stage = "pending"; stamp(d, "Mon 10:12 AM", "🆕 New booking B-2481 · Bea Santos · Garden Room"); return [["owner", "🆕 New booking B-2481 · Garden Room · Sat–Sun · GCash ₱900 to check"], ["care", "📅 New booking for Sat — waiting for the owner's OK"]]; },
    approve(d) { d.stage = "confirmed"; stamp(d, "Mon 10:20 AM", "✅ Approved B-2481 · GCash ₱900 received"); return [["guest", "✅ Booking confirmed! Garden Room · Sat Oct 31, check-in 2 PM"], ["care", "📅 Sat 2 PM: Bea Santos · Garden Room · 2 guests"]]; },
    decline() { return [["owner", "In the real app the guest gets your reason and the dates open up again. For this demo, approve it 🙂"]]; },
    addon(d) { if (d.addon) return []; d.addon = "pending"; stamp(d, d.time, "🙋 Request: Single bed foam ₱300"); return [["owner", "🙋 Bea asks for a single bed foam (₱300)"], ["care", "🙋 Garden Room: single bed foam requested"]]; },
    addonOk(d) { d.addon = "ok"; stamp(d, d.time, "✓ Foam approved (+₱300)"); return [["guest", "✓ Your single bed foam is approved (+₱300)"], ["care", "🧺 Prepare: single bed foam × 1 · Garden Room"]]; },
    checkin(d) { d.stage = "in"; d.room = "occupied"; stamp(d, "Sat 2:03 PM", "🔑 Bea checked in · Garden Room"); return [["guest", "🔑 Welcome to Casa Laguna! WiFi: CasaGuest · password tayo2026"], ["owner", "🔑 Bea checked in · Garden Room"]]; },
    issue(d) { if (d.issue) return []; d.issue = "open"; stamp(d, "Sat 8:40 PM", "🛠 Garden Room: aircon not cold"); return [["care", "🛠 Garden Room: “Aircon not cold” 🔔"], ["owner", "🛠 Problem reported · Garden Room"]]; },
    fix(d) { d.issue = "fixed"; stamp(d, "Sat 8:52 PM", "✓ Aircon fixed (12 min)"); return [["guest", "✅ Caretaker: filter cleaned — it's cold now 👍"]]; },
    checkout(d) { d.stage = "out"; d.room = "to_clean"; stamp(d, "Sun 11:42 AM", "🚪 Checked out · Garden Room → cleaner notified"); return [["clean", "🧹 Garden Room — guest left. Time to clean! 🔔"], ["care", "🚪 Bea checked out · Garden Room"], ["owner", "🚪 Garden Room checked out → cleaner notified"]]; },
    count() { return []; },
    roomcheck(d) { d.checked = true; d.deposit = "checked"; stamp(d, "Sun 11:50 AM", "🔍 Room check: complete, no damage"); return [["owner", "🔍 Room check OK — deposit ₱1,000 can be returned"], ["guest", "🔍 Room checked — all good! Your deposit is being returned."]]; },
    damage() { return [["clean", "In the real app: type it (e.g. “blanket stain — ₱150”), add a photo, and the guest sees it as proof before anything is deducted."]]; },
    startclean(d) { d.room = "cleaning"; d.cleanStart = Date.now(); stamp(d, "Sun 11:52 AM", "🧽 Joy started cleaning Garden Room"); return [["owner", "🧽 Joy started cleaning Garden Room"]]; },
    tick(d, i) { d.ticks[Number(i)] = !d.ticks[Number(i)]; return []; },
    tickall(d) { d.ticks = d.ticks.map(() => true); return []; },
    more(d) { d.extra += 15; stamp(d, d.time, "⏱ Cleaning needs +15 min"); return [["owner", "⏱ Joy needs 15 more minutes for Garden Room"]]; },
    finish(d) { d.room = "ready"; d.cleanEnd = Date.now(); const m = Math.max(28, mins(d.cleanStart, d.cleanEnd)); d.cleanMin = m; stamp(d, "Sun 12:" + String(Math.min(59, 22 + m)).padStart(2, "0") + " PM", `✅ Garden Room ready · cleaned in ${m} min`); return [["owner", `✅ Garden Room is ready · cleaned in ${m} min`], ["care", "✅ Garden Room is clean and ready"]]; },
    refund(d) { d.deposit = "returned"; stamp(d, "Sun 1:05 PM", "💸 Deposit ₱1,000 returned · GCash"); return [["guest", "💸 Your ₱1,000 deposit was returned to GCash. Thanks for staying!"]]; },
    rate(d) { if (d.rated) return []; d.rated = 5; stamp(d, d.time, "⭐ 5-star review from Bea"); return [["owner", "⭐⭐⭐⭐⭐ “Super clean, fast caretaker!” — Bea"]]; },
    promo(d) { d.promo = true; stamp(d, d.time, "🔥 Weekday Escape −20% is live"); return [["guest", "🔥 Casa Laguna: Weekday Escape — 20% off Mon–Thu"]]; },
    sms(d) { d.sms = true; stamp(d, d.time, "📱 SMS sent to 48 past guests"); return [["guest", "📱 SMS from CASALAGUNA: Miss the pool? Mon–Thu 20% off. Book: taptayo.com/m/casa-laguna"]]; },
  },
  views: {
    guest(d, ui) {
      if (ui.sheet === "book" && d.stage === "browse") return stayHome(d) + `<div class="tt-shade" data-ui="sheet" data-arg=""></div><div class="tt-sheet">
        <div class="tt-row" style="padding:0"><b style="font-size:1.15rem">Garden Room</b><button class="c-btn ghost" style="min-height:34px;padding:4px 12px" data-ui="sheet" data-arg="">✕</button></div>
        <div class="tt-muted">Book your stay · step 4 of 4</div><div class="tt-steps"><i></i><i></i><i></i><i></i></div>
        <div class="tt-card" style="margin:0 0 10px">
          <div class="tt-row"><span>📅 Sat Oct 31 → Sun Nov 1</span><b>1 night</b></div>
          <div class="tt-row"><span>👥 Guests</span><b>2 adults</b></div>
          <div class="tt-row"><span>🕑 Check-in 2 PM · out 12 NN</span>${chip("Non-refundable", "wait")}</div>
          <div class="tt-row"><span>🪪 Valid ID</span>${chip("✓ uploaded", "ok")}</div>
          <div class="tt-row"><span>🔐 Security deposit</span><b>${peso(1000)}</b></div>
        </div>
        <div class="tt-card" style="margin:0 0 10px"><div class="tt-row"><span>Total</span><b>${peso(d.promo ? 1440 : 1800)}</b></div><div class="tt-row"><span>Downpayment (50%) · <b>GCash</b> ref 8812 3344</span><b>${peso(d.promo ? 720 : 900)}</b></div></div>
        <label class="tt-check on"><i>✓</i> I agree to the house policy and waiver</label>
        <p class="tt-muted" style="margin:8px 0 12px">In the real app this is 4 short steps (dates → guests → details → confirm).</p>
        ${cbtn(`Book · pay ${peso(d.promo ? 720 : 900)} DP`, "book", "brand", "")}</div>`;
      if (d.stage === "browse") return stayHome(d);
      const top = `<div class="s-topbar"><button class="s-back" data-info="Back to all rooms">‹ Rooms</button><b>Casa Laguna Staycation</b></div>`;
      const sms = d.sms ? `<div class="tt-sms"><small>Messages · CASALAGUNA</small>Miss the pool? 🏊 Mon–Thu 20% off at Casa Laguna. Book: taptayo.com/m/casa-laguna</div>` : "";
      if (d.stage === "pending") return `${top}<div class="tt-pad"><div class="c-ticket main" style="text-align:left"><div class="small muted">Booking</div><div class="tt-big">B-2481</div>${chip("⏳ Waiting for the owner", "wait")}
        <ul class="tt-tl"><li class="on">Booking sent<small>Mon 10:12 AM</small></li><li>Owner checks your GCash ₱900</li><li>Confirmed</li></ul></div>
        <p class="tt-muted">You'll get a notification here (and Messenger/SMS if you allow it). No need to message the owner.</p></div>`;
      const stayCard = `<div class="tt-card"><div class="tt-row"><b>Garden Room</b>${d.stage === "out" ? chip("Checked out", "") : d.stage === "in" ? chip("🔑 Checked in", "ok") : chip("✅ Confirmed", "ok")}</div>
        <div class="tt-row"><span>📅 Sat Oct 31, 2 PM → Sun Nov 1, 12 NN</span></div><div class="tt-row"><span>Paid</span><b>${peso(900)} · balance ${peso(900)} at check-in</b></div></div>`;
      if (d.stage === "confirmed") return `${top}<div class="tt-pad">${sms}<div class="tt-big">You're booked! 🎉</div>${stayCard}
        <div class="tt-h">Before you arrive</div>
        <div class="tt-card"><div class="tt-row"><span>📍 Brgy. Pansol, Calamba · <u>Open in Google Maps</u></span></div><div class="tt-row"><span>🛎 Caretaker: Mang Ruben · arrives with your key</span></div></div>
        ${d.addon ? `<div class="tt-card">🛏 Single bed foam × 1 · ${peso(300)} ${d.addon === "ok" ? chip("✓ Approved", "ok") : chip("Waiting for OK", "wait")}</div>` : `<button class="c-btn ghost" data-act="addon" style="width:100%">🛏 Add extra: single bed foam (${peso(300)})</button>`}
        <p class="tt-muted" style="margin-top:12px">Next: the caretaker checks you in on Saturday.</p></div>`;
      if (d.stage === "in") return `${top}<div class="tt-pad">${sms}<div class="tt-big">Welcome! 🌴</div>
        <div class="tt-card" style="background:#ECFDF5;border-color:#A7F3D0"><b>📶 WiFi: CasaGuest</b><br>Password: <b>tayo2026</b><div class="tt-muted" style="margin-top:6px">Pool 7 AM–10 PM · Quiet hours 10 PM · Check-out 12 NN</div></div>
        ${d.issue === "open" ? `<div class="tt-card">🛠 <b>Aircon not cold</b> — sent to the caretaker ${chip("On the way", "wait")}</div>` : d.issue === "fixed" ? `<div class="tt-card">🛠 Aircon not cold ${chip("✓ Fixed", "ok")}<div class="tt-muted">Caretaker: “Filter cleaned — it's cold now 👍”</div></div>` : ""}
        <div class="tt-grid2" style="margin:10px 0">${d.issue ? info("🙋 Request", "Ask for towels, extra pillows, late check-out… the caretaker gets it instantly.") : cbtn("🛠 Report a problem", "issue", "ghost")}${info("🍳 Order food", "If the place has a kitchen or partner store, guests can order from here.")}</div>
        ${stayCard}<button class="c-btn" data-act="checkout" style="width:100%;margin-top:6px">🚪 I'm checking out</button></div>`;
      // checked out
      return `${top}<div class="tt-pad">${sms}<div class="tt-big">Thanks for staying! 💚</div>
        <div class="tt-card"><div class="tt-row"><b>🔐 Deposit ${peso(1000)}</b>${d.deposit === "returned" ? chip("💸 Returned", "ok") : d.checked ? chip("Being returned", "blue") : chip("Room check", "wait")}</div>
        ${d.checked ? `<div class="tt-muted">Room check: all items complete · no damage ✓</div>` : `<div class="tt-muted">The cleaner checks the room first — you'll see the result here.</div>`}</div>
        <div class="tt-card" style="text-align:center"><b>Rate your stay</b><div class="tt-stars">${d.rated ? "★★★★★" : `<span data-act="rate" style="cursor:pointer">☆☆☆☆☆</span>`}</div>${d.rated ? `<div class="tt-muted">Thank you! Your review helps Casa Laguna.</div>` : `<div class="tt-muted">Tap the stars</div>`}</div>
        ${d.promo ? `<div class="tt-promo">🔥 Weekday Escape: 20% off Mon–Thu — book your next stay</div>` : ""}${stayCard}</div>`;
    },
    care(d) {
      let body = "";
      if (d.stage === "browse") body = `<div class="k-empty">No arrivals yet.<br><span class="small">You'll hear a chime when a booking comes in.</span></div>`;
      if (d.stage === "pending") body = `<article class="k-card" style="border-top-color:var(--new)"><div class="top"><div><div class="no" style="font-size:1.2rem">B-2481 <span class="k-tag">⏳ Waiting for owner</span></div><div class="where">Garden Room · 👥 2 · Sat → Sun</div></div></div><div class="small">Bea Santos</div></article>`;
      if (d.stage === "confirmed") body = `<div class="k-note" style="margin-bottom:10px;border-left:4px solid var(--prep)"><b>🛎 Arriving · Garden Room</b> · Bea Santos · Sat 2:00 PM · 👥 2
        <div class="small" style="margin:6px 0">🪪 ID on file ✓ · 💵 Balance to collect: ${peso(900)}${d.addon === "ok" ? " · 🧺 Prepare: single bed foam × 1" : ""}</div>
        ${d.addon === "pending" ? `<div class="small" style="margin-bottom:6px">🙋 Foam requested — waiting for the owner</div>` : ""}${kbtn("🔑 Check in", "checkin", "prep")}</div>`;
      if (d.stage === "in") body = (d.issue === "open" ? `<div class="k-note" style="margin-bottom:10px;border-left:4px solid var(--danger)"><b>🛠 Garden Room: Aircon not cold</b><div class="small muted">Reported 8:40 PM by the guest</div><div style="margin-top:8px;display:flex;gap:8px">${kbtn("✓ Fixed", "fix", "ready sm")}${info("💬 Reply", "Send the guest a message, e.g. “On my way!” — it shows on their phone.", "k-btn sm")}</div></div>` : "")
        + `<h3 style="margin:6px 4px 8px">🛏 In-house</h3><article class="k-card" style="border-top-color:#9f93dc"><div class="top"><div><div class="no" style="font-size:1.2rem">Garden Room</div><div class="where">🔑 Bea Santos · out Sun 12 NN</div></div></div>${d.issue === "fixed" ? `<div class="small">🛠 Aircon — fixed ✓</div>` : ""}<div class="acts">${info("🚪 Check out", "The guest can check out on their own phone — or you tap this.", "k-btn")}</div></article>`;
      if (d.stage === "out") body = `<div class="k-note" style="margin-bottom:10px"><b>🚪 Bea checked out</b> · Sun 11:42 AM · cleaner notified</div>
        <h3 style="margin:6px 4px 8px">Rooms</h3><div class="k-item" style="display:block">${[["Garden Room", d.room === "ready" ? "✅ Ready" : d.room === "cleaning" ? "🧽 Cleaning · Joy" : "🧹 To clean"], ["Pool Villa", "🛏 Booked · Fri"], ["Family Loft", "✅ Ready"]].map(([n, s]) => `<div style="display:flex;justify-content:space-between;padding:6px 0"><span>${n}</span><span class="small muted">${s}</span></div>`).join("")}</div>`;
      return staffHead("🛎", "Mang Ruben", "Casa Laguna", "Caretaker") + `<div class="tt-tabs"><span class="on">Today</span><span>Approvals</span><span>Requests</span><span>Rooms</span></div><div class="r-main" style="padding:12px">${body}</div>`;
    },
    clean(d) {
      let body;
      if (!["to_clean", "cleaning"].includes(d.room)) body = `<div class="k-remind">📱 Keep this app open — it rings when a guest checks out.</div><div class="k-empty">✨ All rooms are clean.<br><span class="small">You'll hear a chime when a guest checks out.</span></div>`;
      else if (!d.checked) body = `<article class="k-card" style="border-top-color:var(--new)"><div class="top"><div><div class="no">Garden Room</div><div class="where">🧹 Guest left just now</div></div></div>
        <div class="k-item" style="display:block;margin-top:8px"><b>🔍 Check the room first</b> <span class="small muted">— deposit ${peso(1000)}</span>
        ${[["Bath towels", 4], ["Pillows", 4], ["TV remote", 1], ["Aircon remote", 1]].map(([n, q]) => `<div style="display:flex;justify-content:space-between;align-items:center;margin:6px 0"><span>${n} <span class="small muted">(should be ${q})</span></span><b class="k-input" style="width:56px;text-align:center;padding:6px">${q}</b></div>`).join("")}
        ${kbtn("+ Stain / damage", "damage", "sm")}
        <div style="display:flex;gap:8px;margin-top:10px">${kbtn("✓ Room checked", "roomcheck", "ready", "")}</div></div></article>`;
      else if (d.room === "to_clean") body = `<article class="k-card" style="border-top-color:var(--new)"><div class="top"><div><div class="no">Garden Room</div><div class="where">🧹 Checked ✓ · ready to clean</div></div></div><div class="small" style="background:#fff4d6;border-radius:10px;padding:8px 10px;margin-top:6px">🛎 <b>Next guest Sun 2:00 PM</b> · 👥 3<br>✨ Make sure the room is clean by 1:00 PM</div><div class="acts">${kbtn("🧽 Start cleaning", "startclean", "prep")}${info("⏭ Skip", "Skip when the room wasn't used (e.g. a cancelled stay).", "k-btn")}</div></article>`;
      else { const all = d.ticks.every(Boolean); body = `<article class="k-card" style="border-top-color:var(--prep)"><div class="top"><div><div class="no">Garden Room</div><div class="where">🧽 Cleaning · Joy · <span data-since="${d.cleanStart}"></span></div></div></div>
        <div style="margin:8px 0 0">${CLEAN.map((c, i) => `<div class="tt-check ${d.ticks[i] ? "on" : ""}" data-act="tick" data-arg="${i}"><i>${d.ticks[i] ? "✓" : ""}</i>${c}</div>`).join("")}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">${all ? "" : `<button class="k-btn sm" data-act="tickall" data-act-hint="finish">✓ Tick all (demo)</button>`}${kbtn("+15 min", "more", "sm")}</div>
        <div class="acts" style="margin-top:8px"><button class="k-btn ready" style="flex:1" data-act="finish" ${all ? "" : "disabled"}>✓ Finished cleaning — room ready</button></div></article>`; }
      return staffHead("🧹", "Joy", "Casa Laguna", "Cleaner") + `<div class="r-main" style="padding:12px">${body}</div>`;
    },
    owner(d) {
      const st = { free: ["Free", ""], occupied: ["🔑 Occupied", "violet"], to_clean: ["🧹 To clean", "wait"], cleaning: ["🧽 Cleaning", "blue"], ready: ["✅ Ready", "ok"] }[d.room];
      const confirmed = !["browse", "pending"].includes(d.stage);
      const earned = confirmed ? (d.stage === "confirmed" ? 900 : 1800) + (d.addon === "ok" ? 300 : 0) : 0;
      const action = [];
      if (d.stage === "pending") action.push(`<div class="tile" style="padding:14px;border-left:4px solid #F59E0B"><div class="tt-row" style="padding:0"><b>🆕 B-2481 · Bea Santos</b>${chip("To verify", "wait")}</div>
        <div class="tt-muted" style="margin:6px 0">Garden Room · Sat Oct 31 → Sun Nov 1 · 👥 2 · ID ✓</div>
        <div class="tt-row"><span>GCash ref <b>8812 3344</b></span><b>${peso(d.promo ? 720 : 900)}</b></div>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">${obtn("✓ Payment received — approve", "approve", "sm")}${obtn("Decline", "decline", "ghost sm")}</div></div>`);
      if (d.addon === "pending") action.push(`<div class="tile" style="padding:14px"><b>🙋 Single bed foam × 1 · ${peso(300)}</b><div class="tt-muted">Garden Room · Bea Santos</div><div style="margin-top:8px">${obtn("✓ Approve", "addonOk", "sm")}</div></div>`);
      if (d.issue === "open") action.push(`<div class="tile" style="padding:14px;border-left:4px solid #B91C1C"><b>🛠 Aircon not cold · Garden Room</b><div class="tt-muted">The caretaker was alerted · 8:40 PM</div></div>`);
      if (d.deposit === "checked") action.push(`<div class="tile" style="padding:14px;border-left:4px solid #16A34A"><div class="tt-row" style="padding:0"><b>🔐 Deposit ${peso(1000)} · Bea</b>${chip("Room OK", "ok")}</div><div class="tt-muted" style="margin:4px 0 8px">Joy's room check: items complete, no damage.</div>${obtn(`💸 Return ${peso(1000)}`, "refund", "sm")}</div>`);
      const roomLine = `<div class="tt-row"><span>🌿 Garden Room</span><span>${chip(st[0], st[1])}${d.room === "cleaning" ? ` <span class="tt-muted"><span data-since="${d.cleanStart}"></span>${d.extra ? ` · +${d.extra}` : ""}</span>` : d.room === "ready" && d.cleanMin ? ` <span class="tt-muted">${d.cleanMin} min</span>` : ""}</span></div>`;
      return ownerTop("Casa Laguna", "PRO") + `<div class="tt-pad" style="padding-top:10px">
        <div class="tt-kpis"><div class="tt-kpi"><span>Bookings</span><b>${confirmed ? 6 : 5}</b></div><div class="tt-kpi"><span>This week</span><b>${peso(14200 + earned)}</b></div><div class="tt-kpi"><span>Rating</span><b>${d.rated ? "4.9★" : "4.8★"}</b></div></div>
        ${action.length ? `<div class="tt-h">Needs you</div>${action.join("")}` : ""}
        <div class="tt-h">Rooms now</div><div class="tile" style="padding:6px 14px">${roomLine}<div class="tt-row"><span>🏊 Pool Villa</span>${chip("🛏 Booked · Fri", "violet")}</div><div class="tt-row"><span>👨‍👩‍👧 Family Loft</span>${chip("✅ Ready", "ok")}</div></div>
        <div class="tt-h">Grow your bookings</div><div class="tile" style="padding:12px;display:grid;gap:8px">
          ${d.promo ? `<div>🔥 Weekday Escape −20% ${chip("Live", "ok")}</div>` : obtn("🔥 Turn on Weekday Escape −20%", "promo", "ghost sm")}
          ${d.sms ? `<div>📱 SMS sent to 48 past guests ${chip("Sent", "ok")}</div>` : obtn("📱 Text past guests", "sms", "ghost sm")}
          <button class="btn ghost sm" data-info="Reports: occupancy, earnings per room, average cleaning time, where guests found you.">📊 This month's report</button></div>
        <div class="tt-h">Live activity</div><div class="tile" style="padding:12px">${feed(d)}</div></div>`;
    },
  },
};
function stayHome(d) {
  return `<header class="s-hero" style="background-image:linear-gradient(180deg,rgba(0,0,0,.1),rgba(0,0,0,.65)),url('${IMG("stay/pool-tropical.jpg")}')"><div class="s-hero-in"><h1>${nameB("Casa Laguna Staycation")}</h1><p>Private pool · 1 hr from Manila</p>
      <a class="ci-where" data-info="Opens Google Maps with directions."><span>📍 Brgy. Pansol, Calamba</span><b>Directions</b></a><div class="ci-badges"><span class="ci-badge" style="color:#57534e;background:#f5f5f4">1,240 bookings on TapTayo</span></div>
      <div class="s-chips"><span>🕑 Check-in 2 PM</span><span>Check-out 12 PM</span><span>★ 4.9 (49)</span></div></div></header>
    <div class="tt-pad" style="padding-top:6px">${d.promo ? `<div class="tt-promo">🔥 Weekday Escape: 20% off Mon–Thu</div>` : ""}
    <h2 class="s-h">Rooms</h2><div class="s-rooms">
    ${[["Garden Room", "stay/garden-room.jpg", 1800, "Boho · garden view", 2, "1 queen bed", true], ["Pool Villa", "stay/villa-deck.jpg", 3500, "Private deck · pool view", 6, "2 queen beds", false], ["Family Loft", "stay/white-room.jpg", 2600, "Bright · good for families", 4, "2 beds", false]].map(([n, img, p, theme, cap, beds, main]) => `
      <article class="s-room"><div class="s-room-img" style="background-image:url('${IMG(img)}')"><span class="s-count">📷 3</span></div>
      <div class="s-room-in"><div class="s-room-top"><b>${n}</b><span class="s-price">${peso(d.promo ? p * 0.8 : p)}<small>/night</small></span></div><div class="muted small">${theme}</div>
      <div class="s-meta">👥 Up to ${cap} · 🛏 ${beds}</div><div class="s-ams"><span>Aircon</span><span>WiFi</span><span>Hot shower</span><span>Pool access</span></div>
      ${main ? `<button class="c-btn brand block" style="margin-top:10px" data-ui="sheet" data-arg="book" data-act-hint="book">View &amp; book</button>` : `<button class="c-btn brand block" style="margin-top:10px" data-info="Photos, amenities and the calendar of free nights.">View &amp; book</button>`}</div></article>`).join("")}</div>
    <div class="c-card-soft"><h2>Amenities</h2>${[["Swimming pool", "₱100 / person"], ["Videoke", "₱200 / hour"], ["Grill area", "₱300 / stay"], ["Netflix", "Free"]].map(([a, p]) => `<div class="c-mini"><span>${a}</span><span class="amt">${p}</span></div>`).join("")}</div></div>`;
}



/* ───────────────────────── ☕ CAFÉ ───────────────────────── */
const MENU = [["Iced Spanish Latte", 140, "drink/iced-spanish-latte.jpg", "Bar"], ["Sisig Rice Bowl", 220, "food/sisig.jpg", "Kitchen"], ["Caramel Macchiato", 150, "drink/caramel-macchiato.jpg", "Bar"], ["Longsilog", 180, "food/longsilog.jpg", "Kitchen"]];
const cafe = {
  id: "cafe", label: "Café / Restaurant", short: "Café", icon: "☕", color: "#C62828", shop: "TapTayo Café", signup: "cafe",
  pitch: "Table QR → kitchen & bar screens → cashier → owner. No more shouting orders.",
  roles: [
    { id: "cust", label: "Customer", icon: "🙋", kind: "customer" },
    { id: "kit", label: "Kitchen & Bar", icon: "🍳", kind: "staff" },
    { id: "cash", label: "Cashier", icon: "💵", kind: "staff" },
    { id: "owner", label: "Owner", icon: "👑", kind: "owner" },
  ],
  init: () => ({ stage: "menu", time: "Sat 12:28 PM", cart: [0, 1], items: { Bar: "new", Kitchen: "new" }, called: false, paid: false, rated: 0, promo: false, gift: false, feed: [], started: 0 }),
  steps: [
    { role: "cust", act: "order", title: "Order from the table", hint: "On the <b>Customer</b> phone (they scanned the QR on Table 4), tap <b>Place order</b>.", did: "The order split itself: the latte went to the bar, the sisig to the kitchen. The owner sees it live.", plan: "Free", feat: "QR menu ordering" },
    { role: "kit", act: "start", title: "Kitchen & bar start", hint: "On the <b>Kitchen & Bar</b> screen, tap <b>▶ Start</b>.", did: "The customer sees “Preparing” — no more “ilang minutes pa po?”", plan: "Basic", feat: "Kitchen & barista screens" },
    { role: "kit", act: "ready", title: "Mark it ready", hint: "Tap <b>✓ Ready</b>.", did: "The customer's phone says it's on the way. The cashier knows Table 4 is served.", plan: "Basic", feat: "Live order status" },
    { role: "cust", act: "call", title: "Customer asks for the bill", hint: "On the <b>Customer</b> phone, tap <b>🙋 Call staff → Bill please</b>.", did: "The cashier screen rang with “Table 4: Bill please”. No waving needed.", plan: "Basic", feat: "Call staff from the table" },
    { role: "cash", act: "pay", title: "Cashier takes payment", hint: "On the <b>Cashier</b> screen, tap <b>✓ Paid · GCash</b>.", did: "Receipt on the customer's phone, a loyalty stamp added, and the owner's sales updated.", plan: "Free", feat: "Counter & receipts" },
    { role: "cust", act: "rate", title: "Customer rates the meal", hint: "On the <b>Customer</b> phone, tap the ⭐ stars.", did: "The owner got the rating right away — bad ones come to you first, privately.", plan: "Basic", feat: "Ratings & feedback" },
    { role: "owner", act: "promo", title: "Happy hour promo", hint: "Bonus · On the <b>Owner</b> phone, tap <b>🔥 Happy hour: drinks −20%</b>.", did: "The menu on every table changed instantly — no reprinting.", plan: "Pro", feat: "Promos & combos", bonus: true },
    { role: "owner", act: "gift", title: "Sell gift cards", hint: "Bonus · Tap <b>🎁 Start selling gift cards</b>.", did: "Customers can now buy and send gift cards from your page.", plan: "Business", feat: "Gift cards", bonus: true },
  ],
  extras: [["Pro", "Delivery + rider app"], ["Pro", "Table reservations & pre-orders"], ["Pro", "Loyalty stamps"], ["Pro", "Queue TV"], ["Basic", "Shifts & blind cash count"], ["Basic", "Reports & audit log"], ["Business", "Events & VIP rooms"], ["Business", "SMS promos"]],
  acts: {
    add(d, i) { d.cart.push(Number(i)); return []; },
    order(d) { d.stage = "sent"; d.started = Date.now(); stamp(d, "12:31 PM", "🆕 Order #128 · Table 4 · " + peso(total(d))); return [["kit", "🆕 #128 Table 4 · 1 drink, 1 food 🔔"], ["owner", "🆕 Order #128 · Table 4 · " + peso(total(d))]]; },
    start(d) { d.items = { Bar: "prep", Kitchen: "prep" }; stamp(d, "12:32 PM", "▶ #128 preparing"); return [["cust", "👨‍🍳 Your order is being prepared"]]; },
    ready(d) { d.items = { Bar: "ready", Kitchen: "ready" }; d.stage = "served"; stamp(d, "12:41 PM", "✓ #128 ready in 9 min"); return [["cust", "✅ Your order is ready — serving now!"], ["cash", "🍽 Table 4 served · #128"]]; },
    call(d) { d.called = true; stamp(d, "1:05 PM", "🙋 Table 4: bill please"); return [["cash", "🙋 Table 4: Bill please 🔔"]]; },
    pay(d) { d.paid = true; d.stage = "paid"; stamp(d, "1:06 PM", "💵 #128 paid · GCash " + peso(total(d))); return [["cust", "🧾 Paid " + peso(total(d)) + " · stamp 4 of 10 ☕"], ["owner", "💵 Table 4 paid · " + peso(total(d))]]; },
    rate(d) { if (d.rated) return []; d.rated = 5; stamp(d, d.time, "⭐ 5 stars · Table 4"); return [["owner", "⭐⭐⭐⭐⭐ “Sisig was 🔥, fast too!” — Table 4"]]; },
    promo(d) { d.promo = true; stamp(d, d.time, "🔥 Happy hour −20% drinks is live"); return [["cust", "🔥 Happy hour! Drinks 20% off until 5 PM"]]; },
    gift(d) { d.gift = true; stamp(d, d.time, "🎁 Gift cards on sale"); return [["cust", "🎁 New: TapTayo Café gift cards — send one to a friend"]]; },
  },
  views: {
    cust(d) {
      const head = shopTop({ name: "TapTayo Café", cover: "cafe/bright.jpg", tag: "Coffee, silog and merienda — Table 4 · Dine in", where: "Legazpi Village, Makati", count: "1,240 orders on TapTayo", rating: ["4.7", 96], open: "Open now · until 10 PM", tabs: ["Menu", "Reserve", "News"], news: d.stage === "menu" ? "<b>☕ New: Ube Spanish Latte</b> — our November special" : "" });
      if (d.stage === "menu") return head + `<div class="c-cats"><a style="color:#111;border-color:#111">Coffee</a><a>Rice meals</a><a>Pasta</a></div><div style="padding:0 18px 110px">
        ${d.promo ? `<div class="tt-promo">🔥 Happy hour: drinks −20% until 5 PM</div>` : ""}
        ${MENU.map(([n, p, img, st], i) => `<div class="c-item" data-act="add" data-arg="${i}"><div><div class="n">${n}</div><div class="d">${st === "Bar" ? "Espresso, milk, our house syrup" : "Sizzling, with egg and garlic rice"}</div><div class="p">${peso(d.promo && st === "Bar" ? p * 0.8 : p)}${d.cart.filter((x) => x === i).length ? ` <span class="tt-chip ok">× ${d.cart.filter((x) => x === i).length} in cart</span>` : ""}</div></div><div class="img"><img src="${IMG(img)}" alt=""/></div></div>`).join("")}</div>
        <div class="c-cartbar"><button data-act="order"><span class="cnt">${d.cart.length}</span><span class="lbl">Place order · Table 4</span><span>${peso(total(d))}</span></button></div>`;
      const st = d.stage === "sent" ? (d.items.Bar === "prep" ? ["👨‍🍳 Preparing", "blue"] : ["⏳ Sent to the kitchen", "wait"]) : d.stage === "served" ? ["✅ Served", "ok"] : ["🧾 Paid", "ok"];
      return head + `<div class="tt-pad"><div class="c-ticket main" style="text-align:left"><div class="small muted">Order</div><div class="tt-big">#128</div>${chip(st[0], st[1])}
        <ul class="tt-tl"><li class="on">Order sent<small>12:31 PM</small></li><li class="${d.items.Bar !== "new" ? "on" : ""}">Preparing</li><li class="${["served", "paid"].includes(d.stage) ? "on" : ""}">Served</li><li class="${d.paid ? "on" : ""}">Paid</li></ul></div>
        <div class="tt-card">${d.cart.map((i) => `<div class="tt-row"><span>${MENU[i][0]}</span><b>${peso(MENU[i][1])}</b></div>`).join("")}<div class="tt-row"><b>Total</b><b>${peso(total(d))}</b></div></div>
        ${d.paid ? `<div class="tt-card"><b>☕ Loyalty card</b><div style="font-size:1.4rem;letter-spacing:4px;margin:6px 0">●●●●○○○○○○</div><div class="tt-muted">4 of 10 — the 10th drink is free</div></div>
          <div class="tt-card" style="text-align:center"><b>How was it?</b><div class="tt-stars">${d.rated ? "★★★★★" : `<span data-act="rate" style="cursor:pointer">☆☆☆☆☆</span>`}</div></div>`
          : `<div class="tt-grid2">${d.called ? `<div class="tt-card" style="margin:0">🙋 Bill requested ${chip("Coming", "wait")}</div>` : cbtn("🙋 Call staff → Bill please", "call", "ghost")}${info("➕ Order more", "Add more to the same table bill anytime.")}</div>`}
        ${d.gift ? `<div class="tt-promo">🎁 Send a TapTayo Café gift card</div>` : ""}</div>`;
    },
    kit(d) {
      const card = (st, label, item) => `<article class="k-card" style="border-top-color:${d.items[st] === "ready" ? "var(--ready)" : d.items[st] === "prep" ? "var(--prep)" : "var(--new)"}"><div class="top"><div><div class="no">#128 <span class="k-tag">${label}</span></div><div class="where">Table 4 · dine in</div></div><div class="time">${d.items[st] === "new" ? "now" : d.items[st] === "prep" ? `<span data-since="${d.started}"></span>` : "✓"}</div></div><div class="k-item"><b>1×</b> ${item}</div></article>`;
      const body = d.stage === "menu" ? `<div class="k-empty">No orders yet.<br><span class="small">New orders ring here.</span></div>`
        : card("Kitchen", "🍳 Kitchen", "Sisig Rice Bowl · extra egg") + card("Bar", "☕ Bar", "Iced Spanish Latte · less sweet")
          + `<div class="acts" style="display:flex;gap:8px;margin-top:6px">${d.items.Bar === "new" ? kbtn("▶ Start", "start", "prep") : d.items.Bar === "prep" ? kbtn("✓ Ready", "ready", "ready") : `<span class="small muted">Done · served in 9 min</span>`}</div>`;
      return staffHead("🍳", "Kitchen & Bar", "TapTayo Café", "Stations") + `<div style="padding:12px">${body}</div>`;
    },
    cash(d) {
      const bill = `<article class="k-card" style="border-top-color:${d.called && !d.paid ? "var(--danger)" : "var(--ready)"}"><div class="top"><div><div class="no">Table 4</div><div class="where">#128 · ${d.paid ? "paid ✓" : d.stage === "menu" ? "" : "open bill"}</div></div><div class="time">${peso(total(d))}</div></div>
        ${d.cart.map((i) => `<div class="small" style="display:flex;justify-content:space-between"><span>${MENU[i][0]}</span><span>${peso(MENU[i][1])}</span></div>`).join("")}
        <div class="acts" style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">${d.paid ? `<span class="small muted">🧾 Receipt sent to the customer's phone</span>` : `${kbtn("✓ Paid · GCash", "pay", "ready")}${info("💵 Cash", "Cash works too — the screen tells you the change.", "k-btn")}${info("✂ Split", "Split the bill by person or by item.", "k-btn")}`}</div></article>`;
      const body = d.stage === "menu" ? `<div class="k-empty">No open tables.</div>` : (d.called && !d.paid ? `<div class="k-note" style="margin-bottom:10px;border-left:4px solid var(--danger)"><b>🙋 Table 4: Bill please</b></div>` : "") + bill;
      return staffHead("💵", "Counter", "TapTayo Café", "Cashier") + `<div class="tt-tabs"><span class="on">Tables</span><span>Orders</span><span>Shift</span></div><div style="padding:12px">${body}</div>`;
    },
    owner(d) {
      const sales = 18420 + (d.paid ? total(d) : 0);
      return ownerTop("TapTayo Café", "PRO") + `<div class="tt-pad" style="padding-top:10px">
        <div class="tt-kpis"><div class="tt-kpi"><span>Sales today</span><b>${peso(sales)}</b></div><div class="tt-kpi"><span>Orders</span><b>${d.stage === "menu" ? 61 : 62}</b></div><div class="tt-kpi"><span>Avg prep</span><b>${d.stage === "served" || d.paid ? "9 min" : "11 min"}</b></div></div>
        <div class="tt-h">Live orders</div><div class="tile" style="padding:6px 14px">${d.stage === "menu" ? `<div class="tt-row"><span class="tt-muted">Waiting for orders…</span></div>` : `<div class="tt-row"><span>#128 · Table 4</span>${chip(d.paid ? "Paid" : d.stage === "served" ? "Served" : d.items.Bar === "prep" ? "Preparing" : "New", d.paid ? "ok" : d.stage === "served" ? "blue" : "wait")}</div>`}<div class="tt-row"><span>#127 · Take-out</span>${chip("Paid", "ok")}</div><div class="tt-row"><span>#126 · Table 2</span>${chip("Served", "blue")}</div></div>
        <div class="tt-h">Grow</div><div class="tile" style="padding:12px;display:grid;gap:8px">${d.promo ? `<div>🔥 Happy hour −20% drinks ${chip("Live", "ok")}</div>` : obtn("🔥 Happy hour: drinks −20%", "promo", "ghost sm")}${d.gift ? `<div>🎁 Gift cards ${chip("On sale", "ok")}</div>` : obtn("🎁 Start selling gift cards", "gift", "ghost sm")}<button class="btn ghost sm" data-info="Best sellers, busiest hours, staff sales and cash count per shift.">📊 Today's report</button></div>
        <div class="tt-h">Live activity</div><div class="tile" style="padding:12px">${feed(d)}</div></div>`;
    },
  },
};
const total = (d) => d.cart.reduce((a, i) => a + (d.promo && MENU[i][3] === "Bar" ? MENU[i][1] * 0.8 : MENU[i][1]), 0);

/* ───────────────────────── 💇 SALON & SPA ───────────────────────── */
const salon = {
  id: "salon", label: "Salon & Spa", short: "Salon & Spa", icon: "💇", color: "#FF3D7F", shop: "TapTayo Salon", signup: "salon",
  pitch: "Online booking with downpayment, a stylist app, upsells and commissions — computed for you.",
  roles: [
    { id: "client", label: "Client", icon: "🙋", kind: "customer" },
    { id: "desk", label: "Reception", icon: "🛎", kind: "staff" },
    { id: "sty", label: "Stylist", icon: "✂️", kind: "staff" },
    { id: "owner", label: "Owner", icon: "👑", kind: "owner" },
  ],
  init: () => ({ stage: "browse", time: "Thu 7:45 PM", add: null, paid: false, started: 0, rated: 0, remind: false, member: false, feed: [] }),
  steps: [
    { role: "client", act: "book", title: "Client books online", hint: "On the <b>Client</b> phone, tap <b>Book · pay ₱200 DP</b> (Haircut + Color with Liza, Sat 2 PM).", did: "Reception got the booking with the GCash ref. Liza's Saturday is blocked — no double booking.", plan: "Basic", feat: "Online booking + reservation fee" },
    { role: "desk", act: "confirm", title: "Reception confirms", hint: "On the <b>Reception</b> phone, tap <b>✓ DP received — confirm</b>.", did: "The client got the confirmation. Liza sees her Saturday client.", plan: "Basic", feat: "Team of stylists & reception" },
    { role: "desk", act: "arrive", title: "Client arrives Saturday", hint: "It's Saturday 2 PM. Tap <b>✓ Arrived — send to Liza</b>.", did: "Liza's phone rang: “Your client is here.”", plan: "Basic", feat: "Check-in & stylist alerts" },
    { role: "sty", act: "start", title: "Stylist starts", hint: "On the <b>Stylist</b> phone, tap <b>▶ Start service</b>.", did: "The owner sees Liza's chair busy with a live timer.", plan: "Basic", feat: "Live chair board" },
    { role: "sty", act: "upsell", title: "Suggest an add-on", hint: "Tap <b>+ Suggest: Keratin treatment ₱350</b>.", did: "The client got the suggestion on their phone — they decide, no awkward selling.", plan: "Free", feat: "Add a service mid-visit" },
    { role: "client", act: "okadd", title: "Client says yes", hint: "On the <b>Client</b> phone, tap <b>Yes, add it</b>.", did: "The bill and Liza's time updated by themselves.", plan: "Free", feat: "Bill updates itself" },
    { role: "sty", act: "done", title: "Finish", hint: "On the <b>Stylist</b> phone, tap <b>✓ Done</b>.", did: "Reception sees the balance to collect (DP already deducted).", plan: "Basic", feat: "Stylist app" },
    { role: "desk", act: "pay", title: "Collect payment", hint: "On the <b>Reception</b> phone, tap <b>✓ Paid · GCash</b>.", did: "Liza's commission was computed automatically. The client got a receipt and a stamp.", plan: "Basic", feat: "Auto commissions & reports" },
    { role: "owner", act: "remind", title: "Fewer no-shows", hint: "Bonus · On the <b>Owner</b> phone, tap <b>📱 Turn on SMS reminders</b>.", did: "Clients get a text the day before. No-shows drop a lot.", plan: "Pro", feat: "SMS reminders", bonus: true },
    { role: "owner", act: "member", title: "Monthly members", hint: "Bonus · Tap <b>💎 Launch VIP membership</b>.", did: "Regulars pay monthly for perks — steady income even on slow weeks.", plan: "Business", feat: "Memberships", bonus: true },
  ],
  extras: [["Pro", "Loyalty stamps & prepaid packages"], ["Pro", "Walk-in waitlist & Queue TV"], ["Pro", "Client card (allergies, color formula)"], ["Free", "Home service with map pin"], ["Basic", "Shifts & reports"], ["Business", "SMS promos"], ["Business", "Gift cards"]],
  acts: {
    book(d) { d.stage = "pending"; stamp(d, "Thu 7:46 PM", "🆕 Bea · Haircut + Color · Sat 2 PM · Liza"); return [["desk", "🆕 Bea · Sat 2 PM · Liza · GCash ₱200 to check 🔔"], ["owner", "🆕 New booking · Sat 2 PM · ₱1,850"]]; },
    confirm(d) { d.stage = "confirmed"; stamp(d, "Thu 7:50 PM", "✅ Confirmed · DP ₱200"); return [["client", "✅ See you Sat 2 PM with Liza!"], ["sty", "📅 Sat 2 PM: Bea · Haircut + Color"]]; },
    arrive(d) { d.stage = "here"; stamp(d, "Sat 1:58 PM", "👋 Bea arrived"); return [["sty", "👋 Your client Bea is here 🔔"]]; },
    start(d) { d.stage = "in"; d.started = Date.now(); stamp(d, "Sat 2:01 PM", "✂️ Liza started · Bea"); return [["owner", "✂️ Liza started with Bea"]]; },
    upsell(d) { d.add = "asked"; stamp(d, d.time, "💡 Liza suggested Keratin ₱350"); return [["client", "💡 Liza suggests Keratin treatment (₱350, +30 min). Add it?"]]; },
    okadd(d) { d.add = "yes"; stamp(d, "Sat 2:40 PM", "➕ Keratin added (+₱350)"); return [["sty", "✓ Bea said yes — Keratin added"], ["desk", "➕ Bea: Keratin added · new total ₱2,200"]]; },
    noadd(d) { d.add = "no"; return [["sty", "Bea said no thanks"]]; },
    done(d) { d.stage = "done"; stamp(d, "Sat 4:05 PM", "✓ Liza done · Bea"); return [["desk", "✓ Bea is done — collect " + peso(bal(d)) + " 🔔"]]; },
    pay(d) { d.paid = true; d.stage = "paid"; stamp(d, "Sat 4:08 PM", "💵 Paid " + peso(bal(d)) + " · Liza +₱" + Math.round(totalS(d) * 0.3)); return [["client", "🧾 Paid · thank you! Stamp 3 of 8 💖"], ["sty", "💰 +₱" + Math.round(totalS(d) * 0.3) + " commission for Bea's visit"], ["owner", "💵 " + peso(totalS(d)) + " · Liza"]]; },
    rate(d) { if (d.rated) return []; d.rated = 5; stamp(d, d.time, "⭐ 5 stars for Liza"); return [["owner", "⭐⭐⭐⭐⭐ “Liza is the best!” — Bea"], ["sty", "⭐ Bea gave you 5 stars!"]]; },
    remind(d) { d.remind = true; stamp(d, d.time, "📱 SMS reminders on"); return [["client", "📱 SMS: Hi Bea! Reminder: TapTayo Salon tomorrow 2 PM with Liza. Reply C to cancel."]]; },
    member(d) { d.member = true; stamp(d, d.time, "💎 VIP membership launched"); return [["client", "💎 New at TapTayo Salon: VIP ₱999/mo — 1 blowout weekly + 10% off"]]; },
  },
  views: {
    client(d) {
      const head = shopTop({ name: "TapTayo Salon", cover: "salon/interior-pink.jpg", tag: "Hair, nails and lashes — book your slot in 30 seconds", where: "Uptown Mall, BGC, Taguig", count: "1,240 bookings on TapTayo", rating: ["4.7", 143], open: "Open now · until 8 PM", tabs: ["Services", "Book", "Our team", "News"], on: d.stage === "browse" ? 1 : 0 });
      const sms = d.remind ? `<div class="tt-sms"><small>Messages · TAPTAYO</small>Hi Bea! Reminder: TapTayo Salon tomorrow 2 PM with Liza. Reply C to cancel.</div>` : "";
      if (d.stage === "browse") return head + `<div class="tt-pad"><div class="tt-h">Book</div>
        <div class="tt-card"><div class="tt-row"><span>💇 Haircut + Color</span><b>${peso(1850)}</b></div><div class="tt-row"><span>✂️ Stylist</span><b>Liza · ★4.9</b></div><div class="tt-row"><span>📅 Sat Oct 31</span><b>2:00 PM</b></div><div class="tt-row"><span>⏱ About 2 h</span><span class="tt-muted">ends ~4 PM</span></div></div>
        <div class="tt-h">Pick a time</div><div class="tt-grid3">${["11:00", "1:00", "2:00", "3:30", "5:00", "6:30"].map((t) => `<span class="tt-chip ${t === "2:00" ? "ok" : ""}" style="justify-content:center;padding:8px">${t}</span>`).join("")}</div>
        <div class="tt-card"><div class="tt-row"><span>Reservation fee · GCash ref 4410 2291</span><b>${peso(200)}</b></div><div class="tt-muted">Deducted from your bill.</div></div>
        ${cbtn(`Book · pay ${peso(200)} DP`, "book", "brand")}${d.member ? `<div class="tt-promo">💎 VIP ₱999/mo — weekly blowout + 10% off</div>` : ""}</div>`;
      const card = `<div class="tt-card"><div class="tt-row"><b>Haircut + Color${d.add === "yes" ? " + Keratin" : ""}</b>${chip(d.stage === "pending" ? "⏳ Waiting" : d.paid ? "🧾 Paid" : d.stage === "in" ? "✂️ In progress" : d.stage === "done" ? "✓ Done" : "✅ Confirmed", d.stage === "pending" ? "wait" : "ok")}</div><div class="tt-row"><span>Liza · Sat 2:00 PM</span><b>${peso(totalS(d))}</b></div><div class="tt-row"><span>DP paid</span><span>−${peso(200)}</span></div></div>`;
      let extra = "";
      if (d.add === "asked") extra = `<div class="tt-card" style="border-color:#F9A8D4;background:#FFF1F7"><b>💡 Liza suggests: Keratin treatment</b><div class="tt-muted">+₱350 · +30 min · makes the color last longer</div><div class="tt-grid2" style="margin-top:10px">${cbtn("Yes, add it", "okadd", "brand")}${cbtn("No thanks", "noadd", "ghost")}</div></div>`;
      if (d.paid) extra = `<div class="tt-card"><b>💖 Stamps</b><div style="font-size:1.4rem;letter-spacing:4px;margin:6px 0">●●●○○○○○</div><div class="tt-muted">3 of 8 — free blowout at 8</div></div><div class="tt-card" style="text-align:center"><b>Rate Liza</b><div class="tt-stars">${d.rated ? "★★★★★" : `<span data-act="rate" style="cursor:pointer">☆☆☆☆☆</span>`}</div></div>`;
      return head + `<div class="tt-pad">${sms}${extra}${card}${d.stage === "confirmed" ? `<p class="tt-muted">📍 Uptown Mall, BGC · Open in Google Maps<br>Need to move it? You can reschedule up to 24 h before.</p>` : ""}${d.member ? `<div class="tt-promo">💎 VIP ₱999/mo — weekly blowout + 10% off</div>` : ""}</div>`;
    },
    desk(d) {
      let body = `<div class="k-empty">No new bookings.<br><span class="small">Bookings ring here.</span></div>`;
      if (d.stage === "pending") body = `<article class="k-card" style="border-top-color:var(--new)"><div class="top"><div><div class="no">Bea Santos <span class="k-tag">To verify</span></div><div class="where">Haircut + Color · Liza · Sat 2:00 PM</div></div></div><div class="small">💵 GCash ₱200 · ref 4410 2291</div><div class="acts" style="display:flex;gap:8px;margin-top:8px">${kbtn("✓ DP received — confirm", "confirm", "ready")}${info("✕", "Decline with a reason — the slot opens again.", "k-btn")}</div></article>`;
      if (d.stage === "confirmed") body = `<h3 style="margin:4px">Today · Sat</h3><article class="k-card" style="border-top-color:var(--prep)"><div class="top"><div><div class="no">2:00 PM · Bea Santos</div><div class="where">Haircut + Color · Liza</div></div></div><div class="acts" style="margin-top:8px">${kbtn("✓ Arrived — send to Liza", "arrive", "prep")}</div></article>`;
      if (["here", "in"].includes(d.stage)) body = `<article class="k-card" style="border-top-color:var(--prep)"><div class="top"><div><div class="no">Bea Santos</div><div class="where">${d.stage === "in" ? "✂️ With Liza" : "👋 Waiting for Liza"}${d.add === "yes" ? " · + Keratin" : ""}</div></div></div></article>`;
      if (d.stage === "done") body = `<article class="k-card" style="border-top-color:var(--danger)"><div class="top"><div><div class="no">Bea Santos · done</div><div class="where">Haircut + Color${d.add === "yes" ? " + Keratin" : ""}</div></div><div class="time">${peso(bal(d))}</div></div><div class="small">Total ${peso(totalS(d))} − DP ${peso(200)}</div><div class="acts" style="display:flex;gap:8px;margin-top:8px">${kbtn("✓ Paid · GCash", "pay", "ready")}${info("💵 Cash", "Cash works too.", "k-btn")}</div></article>`;
      if (d.paid) body = `<div class="k-note">🧾 Bea paid ${peso(bal(d))} · receipt sent</div>`;
      return staffHead("🛎", "Reception", "TapTayo Salon", "Front desk") + `<div style="padding:12px">${body}</div>`;
    },
    sty(d) {
      let body = `<div class="k-empty">No clients yet today.</div>`;
      const svc = `Haircut + Color${d.add === "yes" ? " + Keratin" : ""}`;
      if (["confirmed", "pending"].includes(d.stage)) body = d.stage === "confirmed" ? `<div class="k-note">📅 Sat 2:00 PM · Bea · ${svc}</div>` : body;
      if (d.stage === "here") body = `<article class="k-card" style="border-top-color:var(--new)"><div class="top"><div><div class="no">Bea Santos 👋</div><div class="where">${svc} · here now</div></div></div><div class="small">📝 Client card: “Ash brown last time · sensitive scalp”</div><div class="acts" style="margin-top:8px">${kbtn("▶ Start service", "start", "prep")}</div></article>`;
      if (d.stage === "in") body = `<article class="k-card" style="border-top-color:var(--prep)"><div class="top"><div><div class="no">Bea Santos</div><div class="where">✂️ ${svc} · <span data-since="${d.started}"></span></div></div></div>
        <div class="acts" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">${d.add ? (d.add === "asked" ? `<span class="small muted">💡 Waiting for Bea's answer…</span>` : "") : kbtn("+ Suggest: Keratin ₱350", "upsell", "sm")}${kbtn("✓ Done", "done", "ready")}</div></article>`;
      if (["done", "paid"].includes(d.stage)) body = `<div class="k-note">✓ Bea · ${svc}${d.paid ? ` · 💰 commission +₱${Math.round(totalS(d) * 0.3)}` : " · waiting for payment"}</div><div class="k-item" style="display:block;margin-top:10px"><b>Today</b><div class="small" style="display:flex;justify-content:space-between"><span>Clients</span><b>${d.paid ? 4 : 3}</b></div><div class="small" style="display:flex;justify-content:space-between"><span>My commission</span><b>${peso(1240 + (d.paid ? Math.round(totalS(d) * 0.3) : 0))}</b></div></div>`;
      return staffHead("✂️", "Liza", "TapTayo Salon", "Stylist") + `<div style="padding:12px">${body}</div>`;
    },
    owner(d) {
      const chair = d.stage === "in" ? `${chip("✂️ Busy", "blue")} <span class="tt-muted"><span data-since="${d.started}"></span></span>` : d.stage === "here" ? chip("👋 Client waiting", "wait") : chip("Free", "ok");
      return ownerTop("TapTayo Salon", "PRO") + `<div class="tt-pad" style="padding-top:10px">
        <div class="tt-kpis"><div class="tt-kpi"><span>Sales</span><b>${peso(9800 + (d.paid ? totalS(d) : 0))}</b></div><div class="tt-kpi"><span>Bookings</span><b>${d.stage === "browse" ? 11 : 12}</b></div><div class="tt-kpi"><span>No-shows</span><b>${d.remind ? "2%" : "9%"}</b></div></div>
        <div class="tt-h">Chairs now</div><div class="tile" style="padding:6px 14px"><div class="tt-row"><span>✂️ Liza</span><span>${chair}</span></div><div class="tt-row"><span>💅 Joy</span>${chip("💅 Busy", "blue")}</div><div class="tt-row"><span>👁 Mia</span>${chip("Free", "ok")}</div></div>
        <div class="tt-h">Grow</div><div class="tile" style="padding:12px;display:grid;gap:8px">${d.remind ? `<div>📱 SMS reminders ${chip("On", "ok")}</div>` : obtn("📱 Turn on SMS reminders", "remind", "ghost sm")}${d.member ? `<div>💎 VIP membership ${chip("Live", "ok")}</div>` : obtn("💎 Launch VIP membership", "member", "ghost sm")}<button class="btn ghost sm" data-info="Sales per stylist, commissions, best services, repeat clients.">📊 Commissions report</button></div>
        <div class="tt-h">Live activity</div><div class="tile" style="padding:12px">${feed(d)}</div></div>`;
    },
  },
};
const totalS = (d) => 1850 + (d.add === "yes" ? 350 : 0);
const bal = (d) => totalS(d) - 200;

/* ───────────────────────── 🧺 LAUNDRY ───────────────────────── */
const LSTEPS = ["Picked up", "Weighed", "Washing", "Drying", "Folding", "Ready", "Delivered"];
const laundry = {
  id: "laundry", label: "Laundry", short: "Laundry", icon: "🧺", color: "#1E8BFF", shop: "TapTayo Laundry", signup: "laundry",
  pitch: "Pickup with a map pin, weigh-in, live wash status and COD delivery.",
  roles: [
    { id: "cust", label: "Customer", icon: "🙋", kind: "customer" },
    { id: "rider", label: "Rider", icon: "🛵", kind: "staff" },
    { id: "shop", label: "Shop staff", icon: "🧺", kind: "staff" },
    { id: "owner", label: "Owner", icon: "👑", kind: "owner" },
  ],
  init: () => ({ s: -1, time: "Mon 8:05 AM", rated: 0, promo: false, sms: false, feed: [] }),
  steps: [
    { role: "cust", act: "book", title: "Book a pickup", hint: "On the <b>Customer</b> phone, tap <b>Book pickup</b> — the map pin is their saved address.", did: "The rider got the pickup with the pin and landmark. The owner sees it on today's list.", plan: "Pro", feat: "Pickup & delivery + rider app" },
    { role: "rider", act: "pickup", title: "Rider picks up", hint: "On the <b>Rider</b> phone, tap <b>✓ Picked up · 2 bags</b>.", did: "The customer got “picked up”. The shop knows 2 bags are coming.", plan: "Pro", feat: "Rider app" },
    { role: "shop", act: "weigh", title: "Weigh it", hint: "On the <b>Shop staff</b> phone, tap <b>⚖ Save 6.4 kg</b>.", did: "The customer saw the exact weight and price — no surprises.", plan: "Free", feat: "Weigh-in & price" },
    { role: "shop", act: "wash", title: "Wash → dry → fold", hint: "Tap <b>▶ Next: Washing</b> — then keep tapping until it's <b>Ready</b>.", did: "The customer watched each step live. No more “tapos na po ba?”", plan: "Free", feat: "Live laundry status", until: (d) => d.s >= 5 },
    { role: "rider", act: "deliver", title: "Deliver + collect COD", hint: "On the <b>Rider</b> phone, tap <b>✓ Delivered · ₱224 collected</b>.", did: "Paid and done. The owner sees the cash the rider holds.", plan: "Pro", feat: "COD tracking" },
    { role: "cust", act: "rate", title: "Customer rates", hint: "On the <b>Customer</b> phone, tap the ⭐ stars.", did: "Ratings come to you first — fix problems before they become bad reviews.", plan: "Basic", feat: "Ratings & feedback" },
    { role: "owner", act: "promo", title: "Every 6th load free", hint: "Bonus · On the <b>Owner</b> phone, tap <b>🎁 Turn on loyalty</b>.", did: "Customers now collect stamps automatically.", plan: "Pro", feat: "Loyalty stamps", bonus: true },
    { role: "owner", act: "sms", title: "Rainy-day promo by SMS", hint: "Bonus · Tap <b>📱 Text: “Maulan? We pick up!”</b>.", did: "Every past customer got your promo by text.", plan: "Business", feat: "SMS promos", bonus: true },
  ],
  extras: [["Free", "Claim codes & ticket numbers"], ["Free", "Rush / express jobs"], ["Basic", "Staff PINs & shifts"], ["Pro", "Promos & vouchers"], ["Basic", "Reports"], ["Business", "Your brand only"]],
  acts: {
    book(d) { d.s = 0; d.picked = false; stamp(d, "Mon 8:06 AM", "🆕 Pickup · Bea · 12 Rizal St"); return [["rider", "🛵 New pickup: Bea · 12 Rizal St (green gate) 🔔"], ["owner", "🆕 Pickup booked · Bea"]]; },
    pickup(d) { d.picked = true; d.s = 0; stamp(d, "8:31 AM", "🛵 Picked up · 2 bags"); return [["cust", "🛵 Picked up! 2 bags on the way to the shop"], ["shop", "🧺 Incoming: Bea · 2 bags · ticket 214"]]; },
    weigh(d) { d.s = 1; stamp(d, "9:02 AM", "⚖ 6.4 kg · ₱224"); return [["cust", "⚖ 6.4 kg · ₱224 (wash-dry-fold). Pay on delivery or GCash."]]; },
    wash(d) { d.s = Math.min(5, d.s + 1); stamp(d, ["", "", "9:05 AM", "10:00 AM", "10:50 AM", "11:20 AM"][d.s], `${["", "", "🌀 Washing", "♨️ Drying", "👕 Folding", "✅ Ready"][d.s]} · ticket 214`); const n = [["cust", ["", "", "🌀 Washing now", "♨️ Drying", "👕 Folding", "✅ Ready! Delivering this afternoon"][d.s]]]; if (d.s === 5) n.push(["rider", "🛵 Ready for delivery: Bea · ₱224 COD"]); return n; },
    deliver(d) { d.s = 6; stamp(d, "2:15 PM", "✅ Delivered · ₱224 COD"); return [["cust", "✅ Delivered! Paid ₱224. Thank you 💙"], ["owner", "💵 Rider collected ₱224 · Bea"]]; },
    rate(d) { if (d.rated) return []; d.rated = 5; stamp(d, d.time, "⭐ 5 stars · Bea"); return [["owner", "⭐⭐⭐⭐⭐ “Mabango and same day!” — Bea"]]; },
    promo(d) { d.promo = true; stamp(d, d.time, "🎁 Loyalty on: 6th load free"); return [["cust", "🎁 TapTayo Laundry: your 6th load is free! (1 of 6)"]]; },
    sms(d) { d.sms = true; stamp(d, d.time, "📱 SMS to 230 customers"); return [["cust", "📱 SMS from TAPTAYO: Maulan? We pick up & deliver — 10% off today."]]; },
  },
  views: {
    cust(d) {
      const head = shopTop({ name: "TapTayo Laundry", cover: "laundry/folded-shirts.jpg", tag: "Wash · dry · fold — book a rider pickup or drop off", where: "San Roque, Antipolo", count: "1,240 orders on TapTayo", rating: ["4.7", 88], open: "Open now · until 9 PM", tabs: ["Services", "Book pickup", "News", "Info"], on: d.s < 0 ? 1 : 0, news: d.s < 0 ? "<b>🌧 Maulan? We pick up!</b> Free pickup this week for 6 kg and up." : "" });
      const sms = d.sms ? `<div class="tt-sms"><small>Messages · TAPTAYO</small>Maulan? We pick up & deliver — 10% off today.</div>` : "";
      if (d.s < 0) return head + `<div class="tt-pad"><div class="tt-h">Book a pickup</div>
        <div class="tt-card"><div class="tt-row"><span>🧺 Wash · Dry · Fold</span><b>₱35/kg</b></div><div class="tt-row"><span>🕘 Pickup</span><b>Today 8:30 AM</b></div><div class="tt-row"><span>🛵 Delivery</span><b>Today, afternoon</b></div></div>
        <div class="tt-card" style="padding:0;overflow:hidden">${mapPin("12 Rizal St, San Roque", "Green gate, beside the sari-sari store")}</div>
        ${cbtn("Book pickup", "book", "brand")}<p class="tt-muted">Pay on delivery (COD) or GCash.</p></div>`;
      const at = d.s === 0 && !d.picked ? -1 : d.s;
      return head + `<div class="tt-pad">${sms}<div class="c-ticket main" style="text-align:left"><div class="small muted">Ticket</div><div class="tt-big">#214</div>${chip(d.s === 6 ? "✅ Delivered" : at < 0 ? "🛵 Rider on the way" : LSTEPS[at], d.s >= 5 ? "ok" : "blue")}
        <ul class="tt-tl">${LSTEPS.map((x, i) => `<li class="${i <= at ? "on" : ""}">${x}</li>`).join("")}</ul></div>
        ${d.s >= 1 ? `<div class="tt-card"><div class="tt-row"><span>⚖ 6.4 kg · wash-dry-fold</span><b>${peso(224)}</b></div><div class="tt-row"><span>Payment</span><b>${d.s === 6 ? "Paid · COD" : "COD"}</b></div></div>` : ""}
        ${d.s === 6 ? `<div class="tt-card" style="text-align:center"><b>How was it?</b><div class="tt-stars">${d.rated ? "★★★★★" : `<span data-act="rate" style="cursor:pointer">☆☆☆☆☆</span>`}</div></div>` : ""}
        ${d.promo ? `<div class="tt-card"><b>🎁 Loyalty</b><div style="font-size:1.4rem;letter-spacing:4px;margin:6px 0">●○○○○○</div><div class="tt-muted">Your 6th load is free</div></div>` : ""}</div>`;
    },
    rider(d) {
      let body = `<div class="k-empty">No jobs yet.<br><span class="small">New pickups ring here.</span></div>`;
      if (d.s === 0 && !d.picked) body = `<article class="k-card" style="border-top-color:var(--new)"><div class="top"><div><div class="no">Pickup · Bea</div><div class="where">12 Rizal St · green gate</div></div><div class="time">8:30</div></div>${mapPin("12 Rizal St, San Roque", "Green gate · 0917 555 1024", true)}<div class="acts" style="display:flex;gap:8px;margin-top:8px">${kbtn("✓ Picked up · 2 bags", "pickup", "ready")}${info("📞", "Call or text the customer from here.", "k-btn")}</div></article>`;
      if (d.picked && d.s < 5) body = `<div class="k-note">🧺 Bea's laundry is at the shop · ${LSTEPS[d.s]}</div>`;
      if (d.s === 5) body = `<article class="k-card" style="border-top-color:var(--prep)"><div class="top"><div><div class="no">Deliver · Bea</div><div class="where">12 Rizal St · COD ${peso(224)}</div></div></div>${mapPin("12 Rizal St, San Roque", "Green gate", true)}<div class="acts" style="margin-top:8px">${kbtn(`✓ Delivered · ${peso(224)} collected`, "deliver", "ready")}</div></article>`;
      if (d.s === 6) body = `<div class="k-note">✅ Delivered · cash on hand ${peso(224)}</div>`;
      return staffHead("🛵", "Ramon", "TapTayo Laundry", "Rider") + `<div style="padding:12px">${body}</div>`;
    },
    shop(d) {
      let body = `<div class="k-empty">No laundry in the shop.</div>`;
      if (d.picked && d.s === 0) body = `<article class="k-card" style="border-top-color:var(--new)"><div class="top"><div><div class="no">#214 · Bea</div><div class="where">2 bags · wash-dry-fold</div></div></div><div style="display:flex;align-items:center;gap:10px;margin:10px 0"><span class="small">⚖ Weight</span><b class="k-input" style="padding:8px 14px;font-size:1.2rem">6.4 kg</b><span class="small muted">= ${peso(224)}</span></div>${kbtn("⚖ Save 6.4 kg", "weigh", "ready")}</article>`;
      if (d.s >= 1 && d.s < 5) body = `<article class="k-card" style="border-top-color:var(--prep)"><div class="top"><div><div class="no">#214 · Bea</div><div class="where">6.4 kg · ${LSTEPS[d.s]}</div></div></div><div class="tt-bar2" style="margin:8px 0"><i style="width:${(d.s / 5) * 100}%"></i></div>${kbtn(`▶ Next: ${LSTEPS[d.s + 1]}`, "wash", "prep")}</article>`;
      if (d.s >= 5) body = `<div class="k-note">✅ #214 ${d.s === 6 ? "delivered" : "ready for the rider"}</div>`;
      return staffHead("🧺", "Shop", "TapTayo Laundry", "Laundry") + `<div style="padding:12px">${body}</div>`;
    },
    owner(d) {
      return ownerTop("TapTayo Laundry", "PRO") + `<div class="tt-pad" style="padding-top:10px">
        <div class="tt-kpis"><div class="tt-kpi"><span>Today</span><b>${peso(4210 + (d.s === 6 ? 224 : 0))}</b></div><div class="tt-kpi"><span>Jobs</span><b>${d.s < 0 ? 17 : 18}</b></div><div class="tt-kpi"><span>Rider cash</span><b>${peso(d.s === 6 ? 1124 : 900)}</b></div></div>
        <div class="tt-h">In the shop</div><div class="tile" style="padding:6px 14px">${d.s >= 0 ? `<div class="tt-row"><span>#214 · Bea</span>${chip(d.s === 0 && !d.picked ? "🛵 Pickup" : LSTEPS[d.s], d.s >= 5 ? "ok" : "blue")}</div>` : ""}<div class="tt-row"><span>#213 · Carlo</span>${chip("Drying", "blue")}</div><div class="tt-row"><span>#212 · Dina</span>${chip("Ready", "ok")}</div></div>
        <div class="tt-h">Grow</div><div class="tile" style="padding:12px;display:grid;gap:8px">${d.promo ? `<div>🎁 Loyalty ${chip("On", "ok")}</div>` : obtn("🎁 Turn on loyalty (6th load free)", "promo", "ghost sm")}${d.sms ? `<div>📱 SMS sent ${chip("230", "ok")}</div>` : obtn("📱 Text: “Maulan? We pick up!”", "sms", "ghost sm")}</div>
        <div class="tt-h">Live activity</div><div class="tile" style="padding:12px">${feed(d)}</div></div>`;
    },
  },
};
// a static map pin card (demo) — the real app opens Google Maps
function mapPin(addr, note, small) {
  return `<div style="position:relative;height:${small ? 110 : 150}px;background:#E8EEF3 url('data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="360" height="160"><rect width="360" height="160" fill="#EAF0F4"/><path d="M0 60 H360 M0 118 H360 M70 0 V160 M210 0 V160 M300 0 V160" stroke="#fff" stroke-width="10"/><path d="M0 20 L120 160" stroke="#FDE68A" stroke-width="8"/><rect x="230" y="70" width="60" height="38" rx="4" fill="#C7E7C9"/></svg>`).replace(/'/g, "%27")}') center/cover;border-radius:${small ? 10 : 0}px;margin:${small ? "8px 0" : 0}">
    <span style="position:absolute;left:50%;top:44%;transform:translate(-50%,-100%);font-size:30px;filter:drop-shadow(0 3px 3px rgba(0,0,0,.3))">📍</span>
    <div style="position:absolute;left:8px;right:8px;bottom:8px;background:#fff;border-radius:10px;padding:6px 10px;font-size:.78rem;box-shadow:0 2px 8px rgba(0,0,0,.12)"><b>${addr}</b><br><span style="color:#6B7280">${note}</span></div></div>`;
}

/* ───────────────────────── 📸 PHOTOGRAPHER ───────────────────────── */
const PROOFS = ["studio/wedding.jpg", "stay/infinity-deck.jpg", "studio/shooting.jpg", "asia/rooftop.jpg", "stay/pool-palms.jpg", "studio/makeup.jpg"];
const photo = {
  id: "photo", label: "Photographer", short: "Photographer", icon: "📸", color: "#16A34A", shop: "Migs Studio", signup: "freelance",
  pitch: "Booked from a listing like Airbnb Experiences — contract, DP, proofs and final photos in one place.",
  roles: [
    { id: "client", label: "Client", icon: "🙋", kind: "customer" },
    { id: "pro", label: "Photographer", icon: "📸", kind: "staff" },
  ],
  init: () => ({ stage: "browse", time: "Tue 9:12 PM", picks: [], rated: 0, rush: false, post: false, feed: [] }),
  steps: [
    { role: "client", act: "book", title: "Book a shoot in Tagaytay", hint: "On the <b>Client</b> phone, open the shoot and tap <b>Request · Sat Nov 7</b>.", did: "Migs got the request with the meeting point pin and the couple's notes.", plan: "Free", feat: "Bookable listing (like Airbnb Experiences)" },
    { role: "pro", act: "accept", title: "Accept & send the contract", hint: "On the <b>Photographer</b> phone, tap <b>✓ Accept & send contract</b>.", did: "The client got the contract and the downpayment request together.", plan: "Creator Pro", feat: "Contracts & downpayment" },
    { role: "client", act: "sign", title: "Sign & pay the DP", hint: "On the <b>Client</b> phone, tap <b>✍ Sign & pay ₱2,550</b>.", did: "Signed, paid, and the date is blocked on Migs's calendar.", plan: "Free", feat: "E-sign + GCash DP" },
    { role: "pro", act: "arrive", title: "Shoot day", hint: "Saturday 4 PM. Tap <b>📍 I'm at the meeting point</b>.", did: "The client got “Migs is here” with his photo — easy to find each other.", plan: "Free", feat: "Day-of updates" },
    { role: "pro", act: "proofs", title: "Upload proofs", hint: "Tap <b>⬆ Send 120 proofs</b>.", did: "The client has a private gallery to pick favorites — no Google Drive mess.", plan: "Creator Pro", feat: "Proof gallery" },
    { role: "client", act: "pick", title: "Client picks favorites", hint: "On the <b>Client</b> phone, tap a few photos, then <b>Send my picks</b>.", did: "Migs got the exact list to edit.", plan: "Creator Pro", feat: "Favorites & revisions" },
    { role: "pro", act: "deliver", title: "Deliver final photos", hint: "On the <b>Photographer</b> phone, tap <b>✓ Deliver final edits</b>.", did: "Balance collected, photos delivered, review requested — all in one tap.", plan: "Free", feat: "Final delivery + balance" },
    { role: "client", act: "rate", title: "Client leaves a review", hint: "On the <b>Client</b> phone, tap the ⭐ stars.", did: "The review shows on Migs's listing — it brings the next booking.", plan: "Free", feat: "Reviews on your listing" },
    { role: "pro", act: "rush", title: "Earn more with rush delivery", hint: "Bonus · Tap <b>⚡ Offer 48-hour rush (+₱1,500)</b>.", did: "Clients can now pay extra for faster delivery.", plan: "Creator Pro", feat: "Rush fees", bonus: true },
    { role: "pro", act: "post", title: "Post to the TapTayo feed", hint: "Bonus · Tap <b>📣 Post this shoot to my portfolio</b>.", did: "Your work shows in the feed of people looking for photographers near Tagaytay.", plan: "Creator Pro", feat: "Portfolio posts in the feed", bonus: true },
  ],
  extras: [["Creator Pro", "Unlimited deals & 40 portfolio samples"], ["Creator Pro", "Promos"], ["Free", "Map pin & travel fee by area"], ["Free", "Brand collabs (UGC) inbox"], ["Free", "Valid ID check on location"]],
  acts: {
    open(d) { d.stage = "detail"; return []; },
    back(d) { d.stage = "browse"; return []; },
    book(d) { d.stage = "requested"; stamp(d, "Tue 9:14 PM", "🆕 Request · Bea & Jon · Sat Nov 7 · Tagaytay"); return [["pro", "🆕 Shoot request · Sat Nov 7 · Tagaytay · 2 guests 🔔"]]; },
    accept(d) { d.stage = "contract"; stamp(d, "Tue 9:30 PM", "✓ Accepted · contract sent"); return [["client", "📸 Migs accepted! Sign the contract & pay the DP to lock Nov 7"]]; },
    sign(d) { d.stage = "booked"; stamp(d, "Tue 9:41 PM", "✍ Signed · DP ₱2,550 GCash"); return [["pro", "✍ Bea signed · DP ₱2,550 received · Nov 7 blocked"]]; },
    arrive(d) { d.stage = "shoot"; stamp(d, "Sat 3:52 PM", "📍 At Picnic Grove"); return [["client", "📍 Migs is at the Picnic Grove entrance (blue cap)"]]; },
    proofs(d) { d.stage = "proofs"; stamp(d, "Mon 6:10 PM", "⬆ 120 proofs sent"); return [["client", "🖼 Your 120 proofs are ready — pick your favorites!"]]; },
    tap(d, i) { i = Number(i); d.picks = d.picks.includes(i) ? d.picks.filter((x) => x !== i) : [...d.picks, i]; return []; },
    pick(d) { if (!d.picks.length) d.picks = [0, 1, 3]; d.stage = "picked"; stamp(d, "Mon 8:20 PM", `❤️ ${d.picks.length + 17} picks received`); return [["pro", `❤️ Bea sent ${d.picks.length + 17} favorites to edit`]]; },
    deliver(d) { d.stage = "done"; stamp(d, "Thu 7:00 PM", "✓ Final photos delivered · balance ₱5,950"); return [["client", "🎉 Your final photos are here! Balance ₱5,950 paid via GCash"]]; },
    rate(d) { if (d.rated) return []; d.rated = 5; stamp(d, d.time, "⭐ 5-star review"); return [["pro", "⭐⭐⭐⭐⭐ “Migs made us feel so comfortable!” — Bea & Jon"]]; },
    rush(d) { d.rush = true; stamp(d, d.time, "⚡ 48-h rush on"); return [["client", "⚡ Migs Studio now offers 48-hour delivery"]]; },
    post(d) { d.post = true; stamp(d, d.time, "📣 Posted to portfolio & feed"); return [["client", "📣 New from Migs Studio: “Golden hour in Tagaytay” — in your feed"]]; },
  },
  views: {
    client(d) {
      if (d.stage === "browse") return `<div class="tt-pad" style="padding-top:12px">
        <div class="tt-card" style="padding:10px 12px;display:flex;align-items:center;gap:8px;margin-top:0">📍 <b style="flex:1">Tagaytay · Nov 7–8</b><span class="tt-muted">Change</span></div>
        <div class="tt-h" style="margin-top:6px">Find services in Tagaytay</div>
        <div class="tt-grid3" style="grid-template-columns:repeat(4,1fr)">${[["📸", "Photography"], ["💅", "Nails"], ["💆", "Spa"], ["💄", "Makeup"]].map(([i, n]) => `<div style="text-align:center;font-size:.72rem"><div style="background:#F3F4F6;border-radius:14px;aspect-ratio:1;display:grid;place-items:center;font-size:24px">${i}</div>${n}</div>`).join("")}</div>
        <div class="tt-h">Photo shoots in Tagaytay</div>
        ${[["Golden-hour couple shoot in Tagaytay by Migs", "studio/wedding.jpg", 2500, "4.98", true], ["Taal view family portraits by Paulo", "stay/infinity-deck.jpg", 3200, "5.0", false]].map(([n, img, p, r, main]) => `
          <div ${main ? 'data-act="open"' : `data-info="Each photographer has a page like this — packages, reviews, map, calendar."`} style="cursor:pointer;margin-bottom:14px"><div style="position:relative"><img class="tt-photo" src="${IMG(img)}" alt=""/>${main ? `<span class="tt-chip" style="position:absolute;left:10px;top:10px;background:#fff">Popular</span>` : ""}<span style="position:absolute;right:12px;top:8px;font-size:22px">♡</span></div>
          <b style="display:block;margin-top:6px;font-size:.92rem">${n}</b><span class="tt-muted">From ${peso(p)} / guest · ★ ${r}</span></div>`).join("")}</div>`;
      const sms = d.post ? `<div class="tt-card" style="padding:10px"><b>📣 Migs Studio posted</b><img class="tt-photo" style="margin-top:6px" src="${IMG("stay/pool-palms.jpg")}" alt=""/><div class="tt-muted">Golden hour in Tagaytay · 2 slots left in Nov</div></div>` : "";
      if (d.stage === "detail") return `<div style="position:relative"><img src="${IMG("studio/wedding.jpg")}" style="width:100%;height:220px;object-fit:cover;display:block" alt=""/><button class="c-btn ghost" data-act="back" style="position:absolute;left:10px;top:10px;min-height:34px;padding:4px 12px;background:#fff">‹</button></div>
        <div class="tt-pad"><b style="font-size:1.2rem;display:block">Golden-hour couple shoot in Tagaytay</b><span class="tt-muted">by ${nameB("Migs Studio", { businessType: "freelance", trust: { badges: ["verified", "dti", "bir", "permit", "creator"], tx: 212 } })} · ★ 4.98 (212) · 7 yrs</span>
        <div class="tt-card"><div class="tt-row"><span>⏱ 3 hours · 2 guests</span><b>${peso(8500)}</b></div><div class="tt-row"><span>🖼 40 edited photos + all proofs</span></div><div class="tt-row"><span>📅 Sat Nov 7 · 4:00 PM</span>${chip("2 slots left", "wait")}</div></div>
        <div class="tt-card" style="padding:0;overflow:hidden">${mapPin("Picnic Grove, Tagaytay", "Meeting point · travel fee included")}</div>
        <div class="tt-card"><b>Notes for Migs</b><div class="tt-muted">“Pre-nup vibe, Taal view, we'll bring 2 outfits.”</div></div>
        ${cbtn("Request · Sat Nov 7", "book", "brand")}<p class="tt-muted">You pay only after Migs accepts.</p></div>`;
      const card = `<div class="tt-card"><div class="tt-row"><b>Golden-hour couple shoot</b><span>${peso(8500)}</span></div><div class="tt-row"><span>📅 Sat Nov 7 · 4 PM · Picnic Grove</span></div></div>`;
      if (d.stage === "requested") return `<div class="tt-pad">${chip("⏳ Waiting for Migs", "wait")}${card}<p class="tt-muted">Migs usually replies within an hour.</p></div>`;
      if (d.stage === "contract") return `<div class="tt-pad"><div class="tt-big">Migs accepted! 📸</div>${card}<div class="tt-card"><b>📄 Photo contract</b><div class="tt-muted" style="margin:6px 0">40 edited photos in 7 days · 2 revisions · DP 30% non-refundable · rain date allowed</div><label class="tt-check on"><i>✓</i>I agree — sign as Bea Santos</label></div>${cbtn(`✍ Sign & pay ${peso(2550)}`, "sign", "brand")}</div>`;
      if (d.stage === "booked") return `<div class="tt-pad">${sms}<div class="tt-big">Booked! 🎉</div>${card}<div class="tt-card">✍ Contract signed · DP ${peso(2550)} paid ${chip("✓", "ok")}</div><p class="tt-muted">You'll get a message on the day.</p></div>`;
      if (d.stage === "shoot") return `<div class="tt-pad">${sms}<div class="tt-card" style="display:flex;gap:10px;align-items:center"><img src="${IMG("studio/dslr.jpg")}" style="width:52px;height:52px;border-radius:50%;object-fit:cover" alt=""/><div><b>Migs is here 📍</b><div class="tt-muted">Picnic Grove entrance · blue cap</div></div></div>${card}</div>`;
      if (d.stage === "proofs") return `<div class="tt-pad"><div class="tt-big">Pick your favorites ❤️</div><p class="tt-muted">120 proofs · tap to pick (17 already picked earlier)</p>
        <div class="tt-grid3">${PROOFS.map((p, i) => `<img class="tt-thumb ${d.picks.includes(i) ? "pick" : ""}" src="${IMG(p)}" data-act="tap" data-arg="${i}" alt=""/>`).join("")}</div>
        <div style="margin-top:12px">${cbtn(`Send my picks (${d.picks.length + 17})`, "pick", "brand")}</div></div>`;
      if (d.stage === "picked") return `<div class="tt-pad"><div class="tt-big">Picks sent ✓</div><p class="tt-muted">Migs is editing your ${d.picks.length + 17} favorites. Final photos in 7 days${d.rush ? " (or 48 h with rush)" : ""}.</p>${card}</div>`;
      return `<div class="tt-pad">${sms}<div class="tt-big">Your photos are here 🎉</div><div class="tt-grid3">${PROOFS.map((p) => `<img class="tt-thumb" src="${IMG(p)}" alt=""/>`).join("")}</div>
        <div class="tt-card"><div class="tt-row"><span>Balance</span><b>${peso(5950)} · paid</b></div><div class="tt-row"><span>⬇ Download all (40 photos)</span></div></div>
        <div class="tt-card" style="text-align:center"><b>Review Migs</b><div class="tt-stars">${d.rated ? "★★★★★" : `<span data-act="rate" style="cursor:pointer">☆☆☆☆☆</span>`}</div></div></div>`;
    },
    pro(d) {
      let body = `<div class="k-empty">No new requests.<br><span class="small">Requests ring here.</span></div>`;
      if (d.stage === "requested") body = `<article class="k-card" style="border-top-color:var(--new)"><div class="top"><div><div class="no">Bea & Jon <span class="k-tag">New</span></div><div class="where">Couple shoot · Sat Nov 7 · 4 PM · ${peso(8500)}</div></div></div>${mapPin("Picnic Grove, Tagaytay", "1 h 10 min from you", true)}<div class="small">📝 “Pre-nup vibe, Taal view, 2 outfits”</div><div class="acts" style="display:flex;gap:8px;margin-top:8px">${kbtn("✓ Accept & send contract", "accept", "ready")}${info("💬", "Chat to ask questions before accepting.", "k-btn")}</div></article>`;
      if (d.stage === "contract") body = `<div class="k-note">📄 Contract sent · waiting for Bea to sign & pay the DP</div>`;
      if (d.stage === "booked") body = `<article class="k-card" style="border-top-color:var(--prep)"><div class="top"><div><div class="no">Sat Nov 7 · 4 PM</div><div class="where">Bea & Jon · Picnic Grove · DP ✓</div></div></div><div class="acts" style="margin-top:8px">${kbtn("📍 I'm at the meeting point", "arrive", "prep")}</div></article>`;
      if (d.stage === "shoot") body = `<article class="k-card" style="border-top-color:var(--prep)"><div class="top"><div><div class="no">Bea & Jon · shoot done</div><div class="where">120 photos selected for proofing</div></div></div><div class="acts" style="margin-top:8px">${kbtn("⬆ Send 120 proofs", "proofs", "prep")}</div></article>`;
      if (d.stage === "proofs") body = `<div class="k-note">🖼 Proofs sent · waiting for Bea's picks</div>`;
      if (d.stage === "picked") body = `<article class="k-card" style="border-top-color:var(--prep)"><div class="top"><div><div class="no">Edit ${d.picks.length + 17} photos</div><div class="where">Due Thu · balance ${peso(5950)}</div></div></div><div class="acts" style="margin-top:8px">${kbtn("✓ Deliver final edits", "deliver", "ready")}</div></article>`;
      if (d.stage === "done") body = `<div class="k-note">✅ Delivered · ${peso(8500)} earned</div>`;
      const tools = `<div class="k-item" style="display:block;margin-top:12px"><b>Grow</b><div style="display:grid;gap:8px;margin-top:8px">${d.rush ? `<span class="small">⚡ 48-h rush offered ✓</span>` : kbtn("⚡ Offer 48-hour rush (+₱1,500)", "rush", "sm")}${d.post ? `<span class="small">📣 Posted to the feed ✓</span>` : kbtn("📣 Post this shoot to my portfolio", "post", "sm")}</div></div>`;
      const kp = `<div class="tt-kpis" style="margin-top:0"><div class="tt-kpi"><span>This month</span><b>${peso(31500 + (d.stage === "done" ? 8500 : 0))}</b></div><div class="tt-kpi"><span>Shoots</span><b>${d.stage === "browse" ? 4 : 5}</b></div><div class="tt-kpi"><span>Rating</span><b>4.98★</b></div></div>`;
      return staffHead("📸", "Migs", "Migs Studio", "Creator") + `<div style="padding:12px">${kp}${body}${tools}<div class="k-item" style="display:block;margin-top:12px"><b>Activity</b>${feed(d)}</div></div>`;
    },
  },
};

export const SCENES = [stay, cafe, salon, laundry, photo];
