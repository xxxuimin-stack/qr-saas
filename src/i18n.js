// English ⇄ Filipino for customer pages (shop page, stay booking, Explore, My TapTayo).
// The pages are written in English; when Filipino is picked, on-screen words are swapped using the list below
// (also for screens that appear later — sheets, receipts, status pages). Shop content (item names, descriptions) is left as typed.
const KEY = "taptayo:lang";
export const getLang = () => { try { return localStorage.getItem(KEY) || "en"; } catch { return "en"; } };
export const setLang = (l) => { try { localStorage.setItem(KEY, l); } catch {} location.reload(); };

// exact phrases (the core text, without emoji / arrows around it)
const FIL = {
  // common
  "Total": "Kabuuan", "Subtotal": "Subtotal", "Name": "Pangalan", "Your name": "Pangalan mo", "Full name": "Buong pangalan", "Phone": "Telepono", "Phone number": "Numero ng telepono", "Mobile": "Mobile", "Address": "Address",
  "Landmark": "Palatandaan", "Notes": "Tala", "Notes (optional)": "Tala (opsyonal)", "Note (optional)": "Tala (opsyonal)", "Message (optional)": "Mensahe (opsyonal)", "Comment (optional)": "Komento (opsyonal)", "Photo (optional)": "Litrato (opsyonal)",
  "optional": "opsyonal", "(optional)": "(opsyonal)", "Required": "Kailangan", "Send": "Ipadala", "Send now": "Ipadala na", "Submit": "Isumite", "Cancel": "Kanselahin", "Back": "Bumalik", "Next": "Susunod", "Close": "Isara", "Save": "I-save", "Apply": "Gamitin",
  "Copy": "Kopyahin", "Share": "I-share", "Search": "Hanapin", "Add": "Idagdag", "Edit": "I-edit", "Delete": "Burahin", "Yes": "Oo", "No": "Hindi", "Done": "Tapos na", "Loading…": "Naglo-load…", "Details": "Detalye", "Status": "Status", "Other": "Iba pa",
  "Today": "Ngayon", "Tomorrow": "Bukas", "Date": "Petsa", "Time": "Oras", "Day": "Araw", "Month": "Buwan", "When?": "Kailan?", "Hours": "Oras ng bukas", "Open now": "Bukas ngayon", "Closed": "Sarado", "Open": "Bukas",
  "Paid": "Bayad na", "Payment": "Bayad", "Balance": "Natitirang bayad", "Downpayment": "Paunang bayad", "Deposit": "Deposito", "Reference number": "Reference number", "Reference no.": "Reference no.", "GCash reference no.": "GCash reference no.",
  "Promo": "Promo", "Promo code": "Promo code", "Voucher": "Voucher", "Code": "Code", "Tip": "Tip", "Contact": "Kontak", "Services": "Mga serbisyo", "Package": "Package", "Amenities": "Mga amenity", "Rooms": "Mga kwarto", "Room": "Kwarto",
  "Directions": "Direksyon", "See on the map": "Tingnan sa mapa", "Powered by": "Gawa gamit ang", "Thank you!": "Salamat!", "Thanks for your feedback!": "Salamat sa feedback mo!", "This page updates on its own.": "Kusang nag-a-update ang page na ito.",
  "This page updates on its own — no need to refresh.": "Kusang nag-a-update ang page na ito — hindi na kailangang i-refresh.", "Maybe later": "Mamaya na lang", "Log in": "Mag-log in", "My TapTayo": "Aking TapTayo",
  // ordering
  "Book": "Mag-book", "Book now": "Mag-book na", "Reserve": "Mag-reserve", "Reserve / Book": "Mag-reserve / Mag-book", "Place order": "Mag-order", "Review order": "Tingnan ang order", "Add to order": "Idagdag sa order", "Add more to this order": "Dagdagan ang order na ito",
  "Delivery fee": "Bayad sa delivery", "FREE delivery": "LIBRENG delivery", "FREE": "LIBRE", "Small-order fee": "Dagdag-bayad sa maliit na order", "Promo savings": "Natipid sa promo", "Order note (optional)": "Tala sa order (opsyonal)", "Change for:": "Panukli para sa:",
  "Delivery address": "Address ng delivery", "Deliver to": "Ihatid sa", "Pickup address": "Address ng pickup", "Delivery address is required.": "Kailangan ang address ng delivery.", "Please pick a time.": "Pumili ng oras.", "Please choose a payment method.": "Pumili ng paraan ng pagbayad.",
  "Name and phone number are required.": "Kailangan ang pangalan at numero ng telepono.", "How would you like to order?": "Paano mo gustong mag-order?", "Just take a look": "Titingin muna", "Call staff": "Tawagin ang staff", "My orders": "Mga order ko", "No orders yet.": "Wala pang order.",
  "Your order number": "Numero ng order mo", "View order status": "Tingnan ang status ng order", "Back to menu": "Bumalik sa menu", "See the menu": "Tingnan ang menu", "Just browse the menu": "Titingin lang sa menu", "We're closed right now": "Sarado kami ngayon",
  "Customer favorites": "Paborito ng mga customer", "Our team": "Ang aming team", "Alert me when it's ready": "Abisuhan ako pag handa na", "You earned a loyalty stamp!": "May loyalty stamp ka!", "Water, utensils, the bill — we'll come to your table": "Tubig, kubyertos, bill — pupuntahan ka namin sa mesa",
  "Which table are you at? Check the number on your table.": "Saang mesa ka? Tingnan ang numero sa mesa mo.", "Store not found": "Hindi makita ang tindahan", "Opening soon!": "Magbubukas na!",
  // salon / booking
  "Book an appointment": "Mag-book ng appointment", "Pick services, a stylist and a time": "Pumili ng serbisyo, stylist at oras", "Pick services": "Pumili ng serbisyo", "Pick services first.": "Pumili muna ng serbisyo.", "Choose a time slot": "Pumili ng oras",
  "No available times": "Walang bakanteng oras", "No free time that day — try another day.": "Walang bakante sa araw na iyon — subukan ang ibang araw.", "No slots that day.": "Walang slot sa araw na iyon.", "Any available": "Kahit sino", "Staff": "Staff", "Your details": "Mga detalye mo",
  "Where should we go?": "Saan kami pupunta?", "Area": "Lugar", "Choose your area": "Piliin ang lugar mo", "Valid ID": "Valid ID", "Birthday": "Kaarawan", "Referral code": "Referral code", "Appointment": "Appointment", "Reschedule": "Ilipat ang petsa", "Move appointment": "Ilipat ang appointment",
  "Join the line": "Pumila", "Your place in line": "Puwesto mo sa pila", "Your turn": "Ikaw na", "Ahead of you": "Nauna sa iyo", "Leave the line": "Umalis sa pila", "Your number": "Numero mo", "Yes, book it": "Oo, i-book na", "Confirm or change": "Kumpirmahin o palitan",
  "Reservation fee paid": "Bayad na ang reservation fee", "How was it?": "Kumusta?", "Tap to rate": "I-tap para mag-rate", "Your rating": "Rating mo", "Submit rating": "Ipadala ang rating",
  // laundry
  "Book a pickup": "Mag-book ng pickup", "Book pickup": "Mag-book ng pickup", "Pickup time": "Oras ng pickup", "Weight": "Timbang", "Claim code": "Claim code", "Pricelist": "Listahan ng presyo", "A rider picks up your laundry — or just drop it off": "Kukunin ng rider ang labada mo — o i-drop off mo lang",
  // stay
  "Book this room": "I-book ang kwartong ito", "Book your stay": "I-book ang stay mo", "Pick your dates": "Piliin ang petsa", "Pick your dates first.": "Piliin muna ang petsa.", "Who's coming?": "Sino ang kasama?", "Adults": "Matanda", "Kids": "Bata", "Extras": "Mga dagdag",
  "Request": "Hiling", "Before you book": "Bago ka mag-book", "Non-refundable": "Hindi ibinabalik ang bayad", "Read the house policy": "Basahin ang patakaran ng bahay", "Read the house rules": "Basahin ang mga patakaran", "Read the waiver you're signing": "Basahin ang waiver na pipirmahan mo",
  "Balance at check-in": "Babayaran sa check-in", "Check-in": "Check-in", "Check-in time": "Oras ng check-in", "Check-out time": "Oras ng check-out", "Thank you for staying with us!": "Salamat sa pag-stay sa amin!", "Thank you for staying!": "Salamat sa pag-stay!",
  "How was your stay?": "Kumusta ang stay mo?", "Make a request": "Humiling", "Report a problem": "Mag-report ng problema", "Extend my stay": "I-extend ang stay ko", "Change room": "Lumipat ng kwarto", "Cancel booking": "Kanselahin ang booking", "I've checked out": "Nakapag-check out na ako",
  "Tap when you leave so we can clean the room": "I-tap pag aalis ka na para malinis namin ang kwarto", "Your room is clean and ready": "Malinis at handa na ang kwarto mo", "Nearby": "Malapit", "House policy": "Patakaran ng bahay", "Room rules": "Patakaran sa kwarto", "View my booking": "Tingnan ang booking ko",
  "Full name (as on your ID)": "Buong pangalan (gaya sa ID mo)", "Valid ID of each guest": "Valid ID ng bawat bisita", "Screenshot of payment (optional)": "Screenshot ng bayad (opsyonal)", "What's the problem?": "Ano ang problema?", "Add visitor": "Magdagdag ng bisita",
  // trust / report / account
  "New on TapTayo": "Bago sa TapTayo", "Verified business": "Beripikadong negosyo", "Report this shop": "I-report ang shop na ito", "What happened?": "Ano ang nangyari?", "Send report": "Ipadala ang report", "Your contact": "Kontak mo",
  "Log in to book your stay": "Mag-log in para i-book ang stay mo", "Continue with Google": "Magpatuloy gamit ang Google", "Use email instead": "Email na lang ang gamitin",
  // address pin
  "Use my current location": "Gamitin ang kasalukuyang lokasyon ko", "My location": "Lokasyon ko", "Locating…": "Hinahanap…", "Pin set": "Naka-pin na", "drag the map to move it": "i-drag ang mapa para ilipat", "Search a place or barangay": "Maghanap ng lugar o barangay",
  "House no., street, barangay, city": "Bahay blg., kalye, barangay, lungsod", "e.g. green gate beside the sari-sari store": "hal. berdeng gate katabi ng sari-sari store",
  // explore
  "Find services near you": "Maghanap ng serbisyo malapit sa iyo", "For you": "Para sa iyo", "My interests": "Mga gusto ko", "Near you": "Malapit sa iyo", "Near me": "Malapit sa akin", "Where?": "Saan?", "Recent": "Kamakailan", "Popular trips": "Sikat na pasyalan",
  "Use my location": "Gamitin ang lokasyon ko", "Back to near me": "Bumalik sa malapit sa akin", "Show my feed": "Ipakita ang feed ko", "What are you into? 👀": "Ano ang hilig mo? 👀", "Search nails, photographer, staycation…": "Maghanap ng nails, photographer, staycation…",
  "Photography": "Photography", "Nails": "Kuko", "Hair": "Buhok", "Spa & massage": "Spa at masahe", "Makeup": "Makeup", "Lashes & brows": "Pilikmata at kilay", "Staycation": "Staycation", "Laundry": "Labada", "Coffee": "Kape", "Food": "Pagkain", "Creators": "Creators",
  "Popular": "Sikat", "Comes to you": "Pupunta sa iyo", "See shop & book": "Tingnan ang shop at mag-book", "See rooms & prices": "Tingnan ang kwarto at presyo", "Sample shops": "Halimbawang shop", "Invite a shop": "Mag-imbita ng shop",
  "Planning a trip? Pick where you're going — you'll see shops that serve that area, so you can book ahead.": "May lakad ka? Piliin kung saan ka pupunta — makikita mo ang mga shop doon, para makapag-book ka na agad.",
  "See what's near you": "Tingnan ang malapit sa iyo", "— allow location, or pick a place.": "— payagan ang lokasyon, o pumili ng lugar.", "Go": "Tara", "Pick a few — your feed shows these first. You can change it anytime.": "Pumili ng ilan — ito muna ang lalabas sa feed mo. Puwede mong palitan kahit kailan.",
  "Pick what you like — your feed follows it": "Piliin ang gusto mo — susunod dito ang feed mo", "Own a shop or do freelance work?": "May shop ka o freelancer ka?", "List it free on TapTayo": "Ilista nang libre sa TapTayo",
  "See how booking works — these are TapTayo demo shops.": "Tingnan kung paano mag-book — mga demo shop ito ng TapTayo.", "Know a good one? Send them TapTayo — it's free for them to list.": "May kilala kang magaling? I-share sa kanila ang TapTayo — libre ang paglista.",
  "When": "Kailan", "Guests": "Bisita", "Confirm": "Kumpirmahin", "View & book": "Tingnan at i-book", "night": "gabi", "booked": "booked na", "pick what you'll use": "piliin ang gagamitin", "included": "kasama na", "Free for guests": "Libre sa bisita",
  "Weekend & holiday nights:": "Weekend at holiday:", "All": "Lahat", "Bedroom": "Kwarto", "Bathroom": "Banyo", "Pool": "Pool", "Living": "Sala", "Kitchen": "Kusina", "Book a pickup / delivery": "Mag-book ng pickup / delivery", "Pay online (optional)": "Magbayad online (opsyonal)",
  "Downpayment received": "Natanggap ang paunang bayad", "Cancelled": "Kinansela", "Pick a date first.": "Pumili muna ng petsa.", "No times that day.": "Walang oras sa araw na iyon.", "Booking": "Booking", "Message us on Messenger": "Mag-message sa amin sa Messenger",
  "I understand: staying past check-out costs": "Naiintindihan ko: may bayad ang pag-stay lampas sa check-out", "No refund.": "Walang refund.", "Refund policy:": "Patakaran sa refund:", "Who's coming": "Sino ang kasama",
  "(pick what you'll use)": "(piliin ang gagamitin)", "per person": "bawat tao", "per stay": "bawat stay", "per hour": "bawat oras", "per night": "bawat gabi", "bookings on TapTayo": "booking sa TapTayo", "orders on TapTayo": "order sa TapTayo",
  "e.g. early check-in, extra towels, celebrating a birthday": "hal. maagang check-in, dagdag na tuwalya, may birthday", "e.g. less ice, no onions": "hal. konting yelo, walang sibuyas", "Your name": "Pangalan mo",
  "Explore services near you": "Mag-explore ng serbisyo malapit sa iyo", "My bookings": "Mga booking ko", "My details": "Mga detalye ko", "My address": "Address ko", "Saved": "Naka-save",
};
// patterns (numbers, names)
const RX = [
  [/^(\d+) nights?$/, "$1 gabi"], [/^(\d+(?:\.\d+)?) km away$/, "$1 km ang layo"], [/^(\d+) m away$/, "$1 m ang layo"], [/^From$/, "Mula"], [/^Find services in (.+)$/, "Maghanap ng serbisyo sa $1"],
  [/^Going to (.+?)\??$/, "Pupunta sa $1?"], [/^These shops serve (.+) — book ahead so it's ready when you arrive$/, "Ang mga shop na ito ay nagseserbisyo sa $1 — mag-book na para handa pagdating mo"], [/^(\d+) guests?$/, "$1 bisita"], [/^Step (\d+) of (\d+)$/, "Hakbang $1 ng $2"], [/^until (.+)$/, "hanggang $1"], [/^opens (.+)$/, "bubukas $1"],
  [/^(\d[\d,]*) bookings on TapTayo$/, "$1 booking sa TapTayo"], [/^(\d[\d,]*) orders on TapTayo$/, "$1 order sa TapTayo"], [/^Downpayment (₱[\d,]+)$/, "Paunang bayad $1"], [/^(₱[\d,]+) per person(.*)$/, "$1 bawat tao$2"], [/^(₱[\d,]+) per stay(.*)$/, "$1 bawat stay$2"], [/^(₱[\d,]+) per hour(.*)$/, "$1 bawat oras$2"], [/^Up to (\d+) guests(.*)$/, "Hanggang $1 bisita$2"], [/^Up to (\d+)(.*)$/, "Hanggang $1$2"], [/^(\d+) nights · (.+)$/, "$1 gabi · $2"], [/^per (person|stay|hour|night)( · .*)$/, (m, a, b) => ({ person: "bawat tao", stay: "bawat stay", hour: "bawat oras", night: "bawat gabi" }[a] + b.replace("until", "hanggang"))], [/^(\d+) min ago$/, "$1 minuto ang nakalipas"], [/^(\d+) h ago$/, "$1 oras ang nakalipas"], [/^(\d+) d ago$/, "$1 araw ang nakalipas"], [/^Hi, (.+)! 👋$/, "Hi, $1! 👋"],
];
const ATTRS = ["placeholder", "aria-label", "title"];
const done = new WeakMap();
function tr(raw) {
  if (!raw || !/[A-Za-z]/.test(raw)) return null;
  const m = /^(\s*[^A-Za-z(]*?)([A-Za-z(].*?)([\s.…→:!?]*)$/s.exec(raw); if (!m) return null;
  const [, pre, core0, post] = m; const core = core0.replace(/\s+/g, " ");
  const p2 = post.trim(), ws = post.slice(post.trimEnd().length);
  if (FIL[core + p2]) return pre + FIL[core + p2] + ws;
  if (FIL[core]) return pre + FIL[core] + post;
  for (const [re, to] of RX) if (re.test(core)) return pre + core.replace(re, to) + post;
  return null;
}
function walk(root) {
  if (!root) return;
  if (root.nodeType === 3) { fixText(root); return; }
  if (root.nodeType !== 1 || root.closest?.("[data-noi18n], script, style, textarea, code")) return;
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, { acceptNode: (n) => (n.nodeType === 1 && (n.hasAttribute("data-noi18n") || /^(SCRIPT|STYLE|TEXTAREA|CODE)$/.test(n.tagName)) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  for (let n = tw.currentNode; n; n = tw.nextNode()) {
    if (n.nodeType === 3) fixText(n);
    else for (const a of ATTRS) { const v = n.getAttribute?.(a); if (v) { const t = tr(v); if (t && t !== v) n.setAttribute(a, t); } }
  }
}
function fixText(n) { const v = n.data; if (done.get(n) === v) return; const t = tr(v); if (t && t !== v) { n.data = t; done.set(n, t); } else done.set(n, v); }

/** start translating this page (only when Filipino is picked) */
export function startI18n() {
  if (location.pathname === "/" || location.pathname === "/index.html") {
    document.getElementById("near")?.remove();
    document.querySelectorAll('a[href="/explore/"], a[href^="/explore/"]').forEach((a) => a.remove());
  }
  document.documentElement.lang = getLang() === "fil" ? "fil" : "en";
  if (getLang() !== "fil") return;
  const go = () => {
    walk(document.body);
    new MutationObserver((ms) => { for (const m of ms) { if (m.type === "characterData") fixText(m.target); else if (m.type === "attributes") walk(m.target); else m.addedNodes.forEach(walk); } })
      .observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  };
  if (document.body) go(); else document.addEventListener("DOMContentLoaded", go);
}

/** the EN / FIL switch. float=true → small pill fixed at the top-right of the page */
export function langSwitch({ float = false, into = null } = {}) {
  if (document.getElementById("ttLang")) return;
  const l = getLang();
  const b = document.createElement("button"); b.id = "ttLang"; b.type = "button"; b.setAttribute("data-noi18n", "");
  b.setAttribute("aria-label", l === "fil" ? "Language: Filipino. Switch to English" : "Language: English. Switch to Filipino");
  b.innerHTML = `<span aria-hidden="true">🌐</span><b class="${l === "en" ? "on" : ""}">EN</b><b class="${l === "fil" ? "on" : ""}">FIL</b>`;
  b.onclick = () => setLang(l === "fil" ? "en" : "fil");
  if (!document.getElementById("tt-lang-css")) { const s = document.createElement("style"); s.id = "tt-lang-css";
    s.textContent = `#ttLang{display:inline-flex;align-items:center;gap:4px;border:1px solid rgba(0,0,0,.12);background:rgba(255,255,255,.95);color:#111;border-radius:999px;padding:5px 8px;font:600 12px/1 Poppins,system-ui,sans-serif;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.12)}
    #ttLang b{padding:3px 6px;border-radius:999px;color:#6B7280;font-weight:700}#ttLang b.on{background:#111;color:#fff}#ttLang.float{position:absolute;top:calc(10px + env(safe-area-inset-top));right:10px;z-index:25}body:has(.s-topbar) #ttLang.float,body:has(.c-sheet-wrap) #ttLang.float{display:none}
    html.dsk #ttLang.float{position:fixed;top:14px!important;right:160px;z-index:40}`; document.head.appendChild(s); }
  if (float) { b.classList.add("float"); document.body.appendChild(b); const place = () => { const bar = document.getElementById("ttDemo"); b.style.top = bar ? `${bar.offsetHeight + 10}px` : ""; }; [0, 400, 1500, 3000].forEach((t) => setTimeout(place, t)); addEventListener("resize", place); } else (into || document.body).appendChild(b);
}
