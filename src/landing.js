// remember which store's "Powered by taptayo" link brought this visitor (for referral credit at sign-up)
try { const r = new URLSearchParams(location.search).get("ref"); if (r && /^[a-z0-9-]{2,60}$/.test(r)) localStorage.setItem("taptayo:ref", r); } catch {}
// TapTayo landing page — edition picker + live phone mockups
const E = {
  cafe: {
    icon: "☕", name: "Food business", short: "QR menu per table", color: "#ff7a2f", soft: "#fff0e4",
    title: "Orders fly from the table to the kitchen.",
    lead: "Every table gets its own QR. Customers order and add more anytime — the counter accepts, the kitchen and barista get their tickets, and you see it all live.",
    feats: ["QR per table, pickup & delivery", "Counter, kitchen, barista & dispatch screens", "Busy mode with live wait times", "18+ menu, VIP rooms & events", "Promos, combos & free delivery", "Rider app with COD & change-for"],
    steps: [["Scan", "Customer scans the QR on the table."], ["Order", "Picks food, pays GCash or cash."], ["Serve", "Kitchen cooks, counter serves — done."]],
    sticker: "🔔 New order · Table 4",
    screen: () => `
      <div class="m-head" style="background:linear-gradient(135deg,#ff9a3c,#ff5a36)"><div class="m-av">K</div><b>Kapehan</b><small>Table 4 · Dine in</small></div>
      <div class="m-tabs"><span class="on">Coffee</span><span>Pasta</span><span>Desserts</span></div>
      ${[["Iced Spanish Latte", "₱140", "🔥 Top pick"], ["Caramel Macchiato", "₱150", ""], ["Truffle Carbonara", "₱220", "NEW"], ["Ube Cheesecake", "₱120", ""]].map(([n, p, b]) => `<div class="m-item"><div><b>${n}</b>${b ? `<i>${b}</i>` : ""}<small>${p}</small></div><span class="m-plus">+</span></div>`).join("")}
      <div class="m-bar" style="background:#1e1b2e">🛒 3 items · ₱510 <span>Review ›</span></div>`,
  },
  laundry: {
    icon: "🧺", name: "Laundry Shop", short: "Track every load", color: "#1f9bff", soft: "#e6f4ff",
    title: "No more “tapos na ba?” texts.",
    lead: "Customers drop off or book a rider pickup, then follow their load from washing to ready — with the price computed after weighing.",
    feats: ["Drop-off or rider pickup & delivery", "Live status: washing → drying → ready", "Claim stub with QR", "Rush service & busy mode", "Price by kilo, computed at the shop", "Loyalty & SMS promos"],
    steps: [["Drop off", "Or book a rider to pick it up."], ["Track", "Live status on the customer's phone."], ["Claim", "Pay and claim with the stub."]],
    sticker: "✅ Ready for pickup",
    screen: () => `
      <div class="m-head" style="background:linear-gradient(135deg,#46b4ff,#1f7bff)"><div class="m-av">L</div><b>Labada Express</b><small>Ticket #41</small></div>
      <div class="m-card"><small>Your load</small><b style="font-size:20px">6.5 kg · ₱227</b><small>Wash · Dry · Fold</small></div>
      <div class="m-track">${[["Received", 1], ["Washing", 1], ["Drying", 1], ["Folding", 2], ["Ready", 0]].map(([n, s]) => `<div class="${s === 1 ? "done" : s === 2 ? "now" : ""}"><span></span>${n}</div>`).join("")}</div>
      <div class="m-bar" style="background:#1f7bff">Ready in about 2 hours</div>`,
  },
  salon: {
    icon: "💇", name: "Salon & Aesthetic", short: "Book the right stylist", color: "#ff3d7f", soft: "#ffe8f0",
    title: "A full booking calendar, zero DMs.",
    lead: "Clients pick services, a stylist and a time slot in seconds. Walk-ins join the waitlist, and each stylist sees their own queue and earnings.",
    feats: ["Online booking with real time slots", "Pick a stylist or “any available”", "Walk-in waitlist & queue", "Staff app with commission tally", "Home service with transport fee", "Waivers, policies & reviews"],
    steps: [["Pick", "Services and a stylist."], ["Book", "Choose a free time slot."], ["Glow", "Get reminders, then rate."]],
    sticker: "📅 Booked · Sat 2:00 PM",
    screen: () => `
      <div class="m-head" style="background:linear-gradient(135deg,#ff7aa8,#e8336f)"><div class="m-av">G</div><b>Glow &amp; Go</b><small>Book a service</small></div>
      ${[["Haircut & blow-dry", "₱350 · 45 min", 1], ["Brazilian Botox", "₱699 · 90 min", 0], ["Gel manicure", "₱450 · 60 min", 1]].map(([n, p, c]) => `<div class="m-item check ${c ? "on" : ""}"><span class="m-box">${c ? "✓" : ""}</span><div><b>${n}</b><small>${p}</small></div></div>`).join("")}
      <div class="m-chips"><span class="on">Any</span><span>👩 Ana</span><span>👩‍🦱 Mia</span><span>🧑 Joy</span></div>
      <div class="m-slots"><span>10:00</span><span class="on">2:00</span><span>3:30</span><span>5:00</span></div>
      <div class="m-bar" style="background:#e8336f">Book · Sat 2:00 PM</div>`,
  },
  stay: {
    icon: "🏡", name: "Stay & Airbnb", short: "Rooms, dates, done", color: "#14b8a6", soft: "#e2f8f4",
    title: "Your rooms, booked while you sleep.",
    lead: "Guests see each room's photos, pick dates on a calendar, sign the waiver and send a downpayment. Your caretaker and cleaners get their own screens.",
    feats: ["Room pages with photos by area", "Calendar with weekend & holiday rates", "Downpayment via GCash, ID & waiver", "Extend, reschedule & late checkout", "Caretaker console & cleaner checklist", "Guest ratings after checkout"],
    steps: [["Choose", "A room and the dates."], ["Pay", "Downpayment, ID and waiver."], ["Check in", "Caretaker approves — enjoy."]],
    sticker: "🧳 2 nights · Confirmed",
    screen: () => `
      <div class="m-photo"><span>Garden Room</span></div>
      <div class="m-card"><b>₱2,500 <small>/ night</small></b><small>👥 4 guests · 1 queen bed · Pool</small></div>
      <div class="m-cal">${["S", "M", "T", "W", "T", "F", "S"].map((d) => `<i>${d}</i>`).join("")}${Array.from({ length: 14 }, (_, i) => `<span class="${i === 5 || i === 6 ? "sel" : i === 2 ? "off" : ""}">${i + 8}</span>`).join("")}</div>
      <div class="m-bar" style="background:#0f9b8e">Book 2 nights · ₱5,600</div>`,
  },
};
const ORDER = ["cafe", "laundry", "salon", "stay"];
const $ = (id) => document.getElementById(id);
let cur = "cafe";
try { const s = localStorage.getItem("taptayo:edition"); if (E[s]) cur = s; } catch {}
if (E[location.hash.slice(1)]) cur = location.hash.slice(1);

function drawPicker() {
  $("picker").innerHTML = ORDER.map((k) => `<button role="tab" type="button" class="pick ${k === cur ? "on" : ""}" data-k="${k}" aria-selected="${k === cur}" style="--c:${E[k].color};--s:${E[k].soft}"><span class="pi">${E[k].icon}</span><b>${E[k].name}</b><small>${E[k].short}</small></button>`).join("");
  $("picker").querySelectorAll(".pick").forEach((b) => (b.onclick = () => { select(b.dataset.k, true); }));
}
function select(k, scroll) {
  cur = k; const e = E[k];
  try { localStorage.setItem("taptayo:edition", k); } catch {}
  drawPicker();
  const sec = $("edition");
  sec.style.setProperty("--c", e.color); sec.style.setProperty("--s", e.soft);
  document.documentElement.style.setProperty("--ed", e.color);
  $("edTag").textContent = `${e.icon} ${e.name}`;
  $("edTitle").textContent = e.title;
  $("edLead").textContent = e.lead;
  $("edFeats").innerHTML = e.feats.map((f) => `<li>${f}</li>`).join("");
  $("edSteps").innerHTML = e.steps.map(([t, d], i) => `<li><span>${i + 1}</span><b>${t}</b><small>${d}</small></li>`).join("");
  const href = `/login/?signup=1&type=${k}`;
  $("edStart").href = href; $("edStart").textContent = `Start free with ${e.name.split(" ")[0]}`;
  ["navStart", "finalStart"].forEach((id) => ($(id).href = href));
  document.querySelectorAll(".plan a").forEach((a) => (a.href = href));
  const scr = $("edScreen"); scr.classList.remove("in"); scr.innerHTML = e.screen(); void scr.offsetWidth; scr.classList.add("in");
  const st = $("edSticker"); st.textContent = e.sticker; st.classList.remove("pop"); void st.offsetWidth; st.classList.add("pop");
  if (scroll) sec.scrollIntoView({ behavior: "smooth", block: "start" });
}
select(cur, false);
$("yr").textContent = new Date().getFullYear();

// logged in already? swap "Log in" for the dashboard
import("./firebase.js").then(async ({ auth }) => {
  const { onAuthStateChanged } = await import("firebase/auth");
  onAuthStateChanged(auth, (u) => {
    if (u && !u.isAnonymous) { $("loginLink").textContent = "Dashboard"; $("loginLink").href = "/app/"; }
  });
}).catch(() => {});


// "Coming soon" waitlist forms (e.g. Stay / Airbnb)
document.querySelectorAll("form[data-waitlist]").forEach((f) => {
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = f.parentElement.querySelector("[data-waitlist-msg]");
    const contact = f.contact.value.trim(); if (!contact) return;
    f.querySelector("button").disabled = true;
    try {
      const { call } = await import("./firebase.js");
      await call("joinWaitlist", { type: f.dataset.waitlist, contact });
      f.remove(); if (msg) msg.innerHTML = "<b>You're on the list!</b> We'll message you when it opens.";
    } catch (x) { if (msg) msg.textContent = x.message || "Something went wrong."; f.querySelector("button").disabled = false; }
  });
});

// 💬 Help — FAQ answers, then chat with TapTayo (we reply within 24 hours)
import("./support.js").then((m) => m.mountSupportButton());
