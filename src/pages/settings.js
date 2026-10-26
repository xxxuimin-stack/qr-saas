// Store settings (owner only): info, theme, service options, hours
import { msgrLink } from "../msgr.js";
import { rowsEditor } from "../rowsedit.js";
import { overLimit, limitNote } from "../planui.js";
import { ADDONS, PRO_FEATURES, FEATURE_TIER, entitled } from "../plans.js";
import { db, call } from "../firebase.js";
import { doc, updateDoc, serverTimestamp, collection, query, where, orderBy, onSnapshot } from "firebase/firestore";
import { esc, html, toast, openModal, closeModal, confirmDialog } from "../ui.js";
import { THEMES, resolveTheme } from "../themes.js";
import { uploadImage, imageField } from "../upload.js";
import { securityStatus, setTwoStep, startTwoStep, forgetTrustedDevice, logoutEverywhere } from "../security.js";
import { auth } from "../firebase.js";
import QRCode from "qrcode";

const DAYS = [["mon", "Mon"], ["tue", "Tue"], ["wed", "Wed"], ["thu", "Thu"], ["fri", "Fri"], ["sat", "Sat"], ["sun", "Sun"]];

// Each settings card belongs to a Tools group (shop / selling / booking / team / grow / alerts); "sec" is the anchor used by the setup guide.
export const SETTING_SECTIONS = [
  ["Business info", "shop", "info"], ["🔗 Store link", "shop", "link"], ["Branding", "shop", "branding"], ["Theme", "shop", "theme"], ["Business hours", "shop", "hours"],
  ["Ordering", (m) => (m === "salon" ? "booking" : "selling"), (m) => (m === "salon" ? "salon" : "service")], ["Features", "booking", "features"], ["Payment methods", "selling", "payments"],
  ["Booking confirmation", "booking", "confirm"], ["Confirmation before preparing", "selling", "confirm"], ["🏡 Stay settings", "booking", "stay"],
  ["🖨 Printing", "alerts", "printing"], ["✈️ Telegram", "alerts", "telegram"], ["📱 SMS", "grow", "sms"], ["📈 Grow", "grow", "salongrow"],
  ["🏠 Home service", "booking", "homesvc"], ["Shift close", "team", "shifts"], ["Staff & PINs", "team", "staff"],
];
export const SECTION_HELP = {
  info: "Your shop name, tagline, phone and address — shown at the top of your customer page.",
  link: "Your customer page address. Changing it breaks QR codes you already printed.",
  branding: "Logo and cover photo for your customer page and receipts.",
  theme: "Colors and layout of the customer page.",
  hours: "When you're open. While closed, customers can still order or book for later (if turned on).",
  service: "Which order types you accept (dine-in, take-out, pickup, delivery), fees and advance orders.",
  salon: "How online booking works: slots, buffer, advance notice, cancellations, home service, no-shows and reservation fee.",
  homesvc: "Where you go, transport fee per area, travel time, home service hours and reservation fee.",
  features: "Reservations, events, VIP rooms, call-staff button and more.",
  payments: "GCash / Maya / bank details customers pay to. Cash is always available.",
  confirm: "Ask customers to confirm on Messenger before you prepare — stops fake orders.",
  stay: "Check-in/out times, downpayment, pool, extensions and house rules.",
  printing: "Receipt printer and kitchen tickets (optional).",
  telegram: "Alerts and a daily summary on your phone through Telegram.",
  sms: "Text promos and reminders to customers who opted in (uses your Semaphore credits).",
  salongrow: "Reminders, loyalty, gift cards, memberships, referral, birthday treats and packages.",
  shifts: "Opening float, blind cash count, auto end of shift and who verifies.",
  staff: "Staff PINs and roles. Each person needs their own PIN.",
};
function organizeSettings(root, mode, opts = {}) {
  const tiles = [...root.querySelectorAll("#settingsForm > .tile")];
  // salon: move the "grow" part of the booking card into its own card
  if (mode === "salon") {
    const start = [...root.querySelectorAll("#settingsForm h4")].find((h) => h.textContent.includes("Reminders by SMS"));
    if (start) {
      const growTile = document.createElement("div"); growTile.className = "tile"; growTile.innerHTML = `<h3>📈 Grow your salon</h3>`;
      let n = start; const moving = [];
      while (n && !(n.tagName === "P" && n.textContent.startsWith("Booking requires Messenger"))) { moving.push(n); n = n.nextElementSibling; }
      moving.forEach((x) => growTile.appendChild(x));
      start.closest(".tile").after(growTile); tiles.splice(tiles.indexOf(start.closest(".tile")) + 1, 0, growTile);
    }
  }
  const hsb = root.querySelector("#homeSvcBlock");
  if (hsb) { const ht = document.createElement("div"); ht.className = "tile"; ht.innerHTML = `<h3>🏠 Home service</h3>`; const host = hsb.closest(".tile") || tiles[0]; ht.appendChild(hsb); host.after(ht); tiles.splice(tiles.indexOf(host) + 1, 0, ht); }
  for (const t of tiles) {
    const h = t.querySelector("h3")?.textContent.trim() || "";
    const m = SETTING_SECTIONS.find(([title]) => h.startsWith(title));
    if (!m) continue;
    const g = typeof m[1] === "function" ? m[1](mode) : m[1], sec = typeof m[2] === "function" ? m[2](mode) : m[2];
    t.dataset.group = g; t.dataset.sec = sec; t.id = "sec-" + sec;
    if (SECTION_HELP[sec] && !t.querySelector(".help-q")) { const q = document.createElement("button"); q.type = "button"; q.className = "help-q"; q.setAttribute("aria-label", "What is this?"); q.textContent = "?"; q.title = SECTION_HELP[sec]; q.onclick = () => toast(SECTION_HELP[sec]); t.querySelector("h3").appendChild(q); }
  }
  if (opts.group) {
    tiles.forEach((t) => { if (t.dataset.group !== opts.group) t.style.display = "none"; });
    if (opts.sec) setTimeout(() => { const el = root.querySelector("#sec-" + opts.sec); if (el) { el.scrollIntoView({ behavior: "smooth", block: "start" }); el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 1800); } }, 150);
  }
}

export function renderSettingsPage(root, ctx, opts = {}) {
  const { storeId, store, mode, labels, reload } = ctx;
  let sideHours = null; // creator side-job preset → opening hours
  const proLock = (k) => entitled(ctx.sub, k) ? "" : `<a class="addon-lock" href="#billing" title="${esc(PRO_FEATURES[k] || "")}">🔒 ${["Free", "Basic", "Pro", "Business"][FEATURE_TIER[k] ?? 2]} plan</a>`;
  const lock = (k) => entitled(ctx.sub, k) ? "" : ADDONS[k] && !ADDONS[k].legacy ? `<a class="addon-lock" href="#billing" title="${esc(ADDONS[k].blurb || "")}">🔒 Add-on · ${esc(ADDONS[k].name)} · ₱${ADDONS[k].price}/mo${FEATURE_TIER[k] != null ? ` (or ${["Free", "Basic", "Pro", "Business"][FEATURE_TIER[k]]} plan)` : ""}</a>` : proLock(k);
  const s = store.settings || {};
  const svc = s.service || {};
  const resv = s.reservations || {};
  const ev = s.events || {};
  const vip = s.vip || {};
  const cs = s.callStaff || {};
  const tg = s.telegram || {};
  const sms = s.sms || {};
  const pay = s.payments || {};
  const fb = s.feedback || {};
  const pol = s.policies || {};
  const wv = s.waiver || {};
  const DEF_POLICY = { table: "• Tables are held for 15 minutes from the reservation time.\n• For 8+ pax, please call the store.\n• No deposit required; please call us if you can't make it.", event: "• 50% deposit within 24 hours to confirm.\n• Cancellation 3 days before the event: full refund of deposit; later than that: forfeited.\n• Final headcount 2 days before.\n• Corkage and overtime follow the store's rates.", vip: "• Room rate is per hour; overtime will be charged.\n• Rate is consumable where stated.\n• No outside food/drinks unless corkage applies.\n• Damage to equipment is the customer's responsibility." };
  const DEF_WAIVER = "I, the undersigned, confirm that I have read and understood the store's booking policy. I agree that:\n1. I am responsible for my group and for any damage to the store's equipment or property during our booking.\n2. We will follow the house rules, including time limits, noise, and smoking.\n3. The store is not liable for lost or damaged personal belongings.\n4. Deposits and cancellations follow the stated policy.\n5. Minors must be accompanied by an adult.";
  const inc = s.incidents || {};
  const cf = s.confirm || {};
  const PAY_TYPES = [["cash", "💵 Cash / COD"], ["gcash", "📱 GCash"], ["maya", "📱 Maya"], ["bank", "🏦 Bank transfer"], ["card", "💳 Card (at counter)"], ["custom", "➕ Custom"]];
  const CALL_OPTS = [["bill", "💵 Bill out"], ["water", "💧 Water"], ["utensils", "🍴 Utensils / condiments"], ["help", "🙋 Help with order"], ["clean", "🧹 Clean table"], ["other", "💬 Other"]];
  const bk = s.booking || {};
  const pk = s.pickup || {};
  const ld = s.laundry || {};
  const sl = s.salon || {};
  const hs = sl.homeService || {}; const place = s.setup?.place || (hs.enabled ? "both" : "shop");
  let salonCats = [];
  const hours = store.hours || {};

  root.innerHTML = `
    <form id="settingsForm" class="stack">
      <div class="tile">
        <h3>Business info</h3>
        <div class="form2">
          <div><label>Business name</label>${store.verif?.permit?.status === "approved" ? `<input name="name" value="${esc(store.name)}" readonly style="background:#F3F4F6"/><div class="small muted">🔒 Verified with your business permit — the name is locked. Message support if the permit itself changed.</div>` : `<div class="row" style="gap:6px"><input name="name" value="${esc(store.name)}" ${(Number(store.nameChangedAt) || 0) + 60 * 864e5 > Date.now() ? "readonly style=\"background:#F3F4F6\"" : ""}/><button type="button" class="btn sm ghost" id="renameBtn" ${(Number(store.nameChangedAt) || 0) + 60 * 864e5 > Date.now() ? "disabled" : ""}>Rename</button></div><div class="small muted">${(Number(store.nameChangedAt) || 0) + 60 * 864e5 > Date.now() ? `Renamed ${new Date(store.nameChangedAt).toLocaleDateString("en-PH", { month: "short", day: "numeric" })} · next rename on <b>${new Date(store.nameChangedAt + 60 * 864e5).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" })}</b>` : "You can rename once every 60 days. Once your business permit is verified, the name is locked."}</div>`}</div>
          <div><label>Tagline (optional)</label><input name="tagline" value="${esc(s.tagline || "")}" placeholder="e.g. Coffee · Pasta · Good vibes" /></div>
          <div><label>Phone</label><input name="phone" value="${esc(store.contact?.phone || "")}" /></div>
          <div><label>Messenger <span class="muted small">(m.me/yourpage)</span></label><input name="cMsgr" value="${esc(store.contact?.messenger || "")}" placeholder="m.me/yourpage" /></div>
          <div><label>Address</label><input name="address" value="${esc(store.contact?.address || "")}" /></div>
          <div><label>Google Maps link <span class="muted small">(shows a map on your page)</span></label><input name="cMap" value="${esc(store.contact?.mapUrl || "")}" placeholder="Paste the Share link from Google Maps" /></div>
          <div><label>Facebook page</label><input name="cFb" value="${esc(store.contact?.facebook || "")}" placeholder="facebook.com/yourpage" /></div>
          <div><label>Instagram</label><input name="cIg" value="${esc(store.contact?.instagram || "")}" placeholder="@yourshop" /></div>
          <div><label>TikTok</label><input name="cTt" value="${esc(store.contact?.tiktok || "")}" placeholder="@yourshop" /></div>
          <div class="span2"><label>Welcome message (optional)</label><input name="welcome" value="${esc(s.welcome || "")}" placeholder="e.g. Thanks for ordering! Ready in 10–15 mins." /></div>
          <div class="span2"><label>⭐ Google review link (optional)</label><input name="reviewUrl" value="${esc(s.reviewUrl || "")}" placeholder="https://g.page/r/…/review" /><p class="small muted" style="margin:4px 0 0">Customers who give 5 stars are asked to share a Google review. Get the link in Google Business Profile → "Ask for reviews".</p></div>
        </div>
      </div>

      <div class="tile" id="verifTile">
        <h3>✔ Verified badge</h3>
        <p class="small muted">The verified badge can still appear. This app does not ask for a valid ID, DTI, BIR, or mayor's permit.</p>
      </div>

      ${["salon", "stay", "table"].includes(mode) ? (() => { const bp = s.bookingPolicy || {}; const rp = bp.reschedule || {}; return `<div class="tile">
        <h3>📅 Booking policy</h3>
        <label class="check"><input type="checkbox" name="bpNonRef" ${bp.refundable === false ? "checked" : ""}/> <b>Non-refundable</b> — downpayments / payments are not refunded when the customer cancels</label>
        <label class="check"><input type="checkbox" name="bpRes" ${rp.allowed !== false ? "checked" : ""}/> Customers can reschedule (move the date) themselves</label>
        <div class="form2"><div><label>Max reschedules per booking</label><input name="bpMax" type="number" min="0" max="10" value="${rp.max ?? 2}"/></div><div><label>Up to … hours before</label><input name="bpCut" type="number" min="0" max="720" value="${rp.cutoffHours ?? 24}"/></div>
        <div><label>Moving date fee</label><input name="bpFee" type="number" min="0" value="${rp.fee ?? 0}"/></div><div><label>Fee type</label><select name="bpFeeT"><option value="fixed" ${rp.feeType !== "percent" ? "selected" : ""}>₱ fixed</option><option value="percent" ${rp.feeType === "percent" ? "selected" : ""}>% of the booking</option></select></div></div>
        <p class="small muted">Moving a date breaks your schedule — the fee is added to the booking. Customers see this policy before they book and confirm the fee before moving.</p>
      </div>`; })() : ""}
      <div class="tile">
        <h3>📱 Who runs the shop?</h3>
        <label class="check"><input type="checkbox" name="soloOn" ${s.solo?.enabled ? "checked" : ""}/> <b>I run everything myself</b> — one phone for all my screens (no PINs, one switch bar)</label>
        <div><label>Deliveries / pickups</label><select name="soloRider"><option value="none" ${(s.solo?.rider || "none") === "none" ? "selected" : ""}>No rider</option><option value="self" ${s.solo?.rider === "self" ? "selected" : ""}>I drive myself (show the rider screen in my bar)</option><option value="staff" ${s.solo?.rider === "staff" ? "selected" : ""}>I have a rider employee (separate rider app)</option></select></div>
        <p class="small muted">Hiring staff later? Turn this off — each person then logs in to their own app with a PIN.</p>
      </div>
      <div class="tile">
        <h3>🔗 Store link</h3>
        <p class="small muted" style="margin:0 0 8px">This is the link customers open (and what your QR codes point to). Store names can be the same as other stores — only the link must be unique.</p>
        <div class="slugrow"><span class="slugbase">/m/</span><input id="slugInput" value="${esc(store.slug || "")}" autocomplete="off" spellcheck="false"/><button class="btn sm" type="button" id="slugSave" disabled>Save link</button></div>
        <div class="small" id="slugMsg" style="margin-top:6px"></div>
        <p class="small muted" style="margin:6px 0 0">Your old link and old printed QR codes keep working — they forward to the new link. Reprint table QR codes when you can. ${(Number(store.slugChangedAt) || 0) + 30 * 864e5 > Date.now() ? `<b>Next link change: ${new Date(store.slugChangedAt + 30 * 864e5).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" })}</b>` : "You can change it once every 30 days."}</p>
      </div>
      <div class="tile" id="widgetTile">
        <h3>📣 Booking button for your website &amp; Facebook</h3>
        <p class="small muted" style="margin:0 0 8px">Let people ${store.mode === "salon" ? "book" : store.mode === "stay" ? "book a stay" : store.mode === "laundry" ? "book a pickup" : "order"} straight from your Facebook page or website.</p>
        <label>Your link</label><div class="slugrow"><input readonly id="wLink" value="https://taptayo.com/m/${esc(store.slug || "")}?utm_source=facebook"/><button class="btn sm" type="button" data-copy="wLink">Copy</button></div>
        <details style="margin-top:10px"><summary><b>Facebook page</b> — add a “${store.mode === "salon" || store.mode === "stay" ? "Book now" : "Order now"}” button</summary>
          <ol class="small" style="margin:6px 0 0;padding-left:18px;line-height:1.7"><li>Open your Facebook page → tap <b>Edit</b> under the cover (or <b>+ Add action button</b>).</li><li>Pick <b>${store.mode === "salon" || store.mode === "stay" ? "Book with you" : "Start order"}</b> → <b>Link to website</b> / <b>Use a link</b>.</li><li>Paste your link above and save. Also put it in your page's <b>About</b> and pin a post with it.</li></ol></details>
        <details style="margin-top:8px"><summary><b>Website</b> — a floating button (any site: WordPress, Wix, Shopify…)</summary>
          <div class="row wrap" style="gap:8px;margin:8px 0"><input id="wLabel" value="${store.mode === "salon" ? "Book now" : store.mode === "stay" ? "Book your stay" : store.mode === "laundry" ? "Book a pickup" : "Order now"}" style="max-width:200px"/><input id="wColor" type="color" value="#C62828" style="width:56px;padding:2px"/><select id="wPos" style="max-width:140px"><option value="right">Bottom right</option><option value="left">Bottom left</option></select></div>
          <textarea id="wCode" readonly rows="3" style="font-family:ui-monospace,monospace;font-size:12.5px;width:100%"></textarea><button class="btn sm" type="button" data-copy="wCode" style="margin-top:6px">Copy code</button>
          <p class="small muted" style="margin:6px 0 0">Paste it before <code>&lt;/body&gt;</code> (or in a “Custom HTML” block). It opens your TapTayo page in a new tab.</p></details>
      </div>

      <div class="tile">
        <h3>Branding</h3>
        <p class="small muted">Logo and cover photo — shown on the customer page, kitchen screen, and QR prints.</p>
        <div class="form2"><div id="logoField"></div><div id="coverField"></div>${mode === "table" ? `<div class="span2" id="floorField"></div>` : ""}</div>
        <label class="check" style="margin-top:10px"><input type="checkbox" id="hideBrand" ${s.hideBranding ? "checked" : ""} ${entitled(ctx.sub, "whitelabel") ? "" : "disabled"}/> Hide “Powered by taptayo” on my customer pages ${proLock("whitelabel").replace("Pro plan", "Business plan")}</label>
      </div>

      <div class="tile">
        <h3>Theme</h3>
        <p class="small muted">Choose the look of your customer page. For Halloween, Christmas and other holidays, use <b>Overview → Seasonal theme</b> — one tap on, one tap off.</p>
        <div class="themes" id="themeGrid"></div>
        <label style="margin-top:12px">Menu layout</label>
        <div class="row wrap" style="gap:8px">${[["list", "☰ List", "name, description, small photo — best for big menus"], ["grid", "▦ Photo grid", "2 big photos per row — best when every item has a photo"], ["compact", "≡ Compact", "names and prices only — fastest to scan"], ["pin", "▥ Pinterest", "photo tiles of different heights, swipe for more photos — best for salons, nails, lashes, photos"]].map(([k, l, d]) => `<label class="check" style="margin:0;border:1px solid var(--line);border-radius:10px;padding:8px 12px"><input type="radio" name="layout" value="${k}" ${(store.theme?.layout === "rows" ? "list" : store.theme?.layout && !(mode === "salon" && store.theme.layout === "list") ? store.theme.layout : mode === "table" ? "grid" : mode === "salon" ? "pin" : "list") === k ? "checked" : ""}/> <span><b>${l}</b><br><span class="small muted">${d}</span></span></label>`).join("")}</div>
        <div class="form2" style="margin-top:8px">
          <div><label>Announcement banner (optional)</label><input name="banner" value="${esc(store.theme?.banner || "")}" placeholder="${esc(resolveTheme(store.theme).banner || "e.g. Buy 1 Take 1 every Friday!")}" /></div>
          <div><label>Custom brand color (optional)</label><div class="row"><input name="primary" type="color" value="${esc(store.theme?.primary || resolveTheme(store.theme).primary)}" style="width:60px;padding:4px;height:42px" /><button class="btn ghost sm" type="button" id="resetColor">Use theme color</button></div></div>
        </div>
        <label class="check"><input type="checkbox" name="decor" ${store.theme?.decor === false ? "" : "checked"}/> Show theme decorations (emojis in the header)</label>
      </div>

      <div class="tile">
        <h3>Ordering</h3>
        <label class="check"><input type="checkbox" name="acceptOrders" ${s.acceptOrders !== false ? "checked" : ""}/> Accept ${esc(labels.order.toLowerCase())}s (turn off when closed or busy)</label>
        ${mode === "table" ? `
          <p class="small muted" style="margin-top:10px">Service types available to customers:</p>
          <div class="row wrap">
            <label class="check"><input type="checkbox" name="dineIn" ${svc.dineIn !== false ? "checked" : ""}/> Dine-in</label>
            <label class="check"><input type="checkbox" name="takeOut" ${svc.takeOut !== false ? "checked" : ""}/> Take-out</label>
            <label class="check"><input type="checkbox" name="pickup" ${svc.pickup ? "checked" : ""}/> Pickup (order ahead)</label>
            <label class="check"><input type="checkbox" name="delivery" ${svc.delivery ? "checked" : ""}/> Delivery ${lock("delivery")}</label>
          </div>
          <label class="check"><input type="checkbox" name="advanceWhenClosed" ${s.advanceWhenClosed !== false ? "checked" : ""}/> 🌙 When closed, customers can still see the menu and order for later (pickup / delivery at a time you're open)</label>
          <div class="form2">
            <div><label>Delivery fee</label><select name="deliveryFeeMode"><option value="flat" ${(svc.deliveryFeeMode || "flat") === "flat" ? "selected" : ""}>Flat fee (set below)</option><option value="counter" ${svc.deliveryFeeMode === "counter" ? "selected" : ""}>Counter sets the fee per order (based on the customer's address)</option></select></div>
            <div><label>Flat delivery fee (₱)</label><input name="deliveryFee" type="number" min="0" step="1" value="${svc.deliveryFee ?? 0}" /></div>
            <div><label>Minimum order for delivery <span class="muted small">(blocks smaller orders)</span></label><input name="deliveryMin" type="number" min="0" step="1" value="${svc.deliveryMin ?? 0}" /></div>
            <div><label>Small-order fee applies below (₱)</label><input name="smallOrderMin" type="number" min="0" step="1" value="${svc.smallOrderMin ?? 0}" placeholder="e.g. 250" /></div>
            <div><label>Small-order fee (₱)</label><input name="smallOrderFee" type="number" min="0" step="1" value="${svc.smallOrderFee ?? 0}" placeholder="e.g. 20" /></div>
            <div class="span2"><label class="check"><input type="checkbox" name="smallPickup" ${(svc.smallOrderFor || []).includes("pickup") ? "checked" : ""}/> Also charge the small-order fee on pickup orders (delivery always)</label><p class="small muted" style="margin:2px 0 0">Instead of refusing small orders, customers pay a small fee — the cart shows "Add ₱X more to skip the fee".</p></div>
            <div><label>Advance order lead time (minutes)</label><input name="scheduleLeadMin" type="number" min="0" value="${svc.scheduleLeadMin ?? 30}" /></div>
            <div><label>Show in kitchen before scheduled time (minutes)</label><input name="fireBeforeMin" type="number" min="5" value="${svc.fireBeforeMin ?? 30}" /></div>
            <div><label>Standard prep time</label><select name="prepDefault">${[10, 15, 20].map((m) => `<option value="${m}" ${(svc.prepDefault || 15) === m ? "selected" : ""}>${m} min</option>`).join("")}</select></div>
            <div class="span2"><label class="check"><input type="checkbox" name="useDispatch" ${svc.dispatch !== false ? "checked" : ""}/> 📋 Use the Dispatch screen — cooked food is checked against its plating guide before serving (Dispatch completes the order)</label></div>
            <div><label>Prep time when Busy</label><select name="busyPrep">${[25, 30, 35, 40, 45, 50, 60].map((m) => `<option value="${m}" ${(svc.busyPrep || 35) === m ? "selected" : ""}>${m} min</option>`).join("")}</select></div>
            <div><label>Remind to switch to Busy at</label><select name="busyRemind">${[0, 5, 6, 8, 10, 12, 15].map((m) => `<option value="${m}" ${(svc.busyRemind ?? 8) === m ? "selected" : ""}>${m ? m + " orders in progress" : "Never"}</option>`).join("")}</select></div>
            <div><label>Auto-pause online orders if an order isn't accepted in</label><select name="autoPauseMin">${[0, 3, 5, 7, 10, 15].map((m) => `<option value="${m}" ${(svc.autoPause === false ? 0 : svc.autoPauseMin ?? 5) === m ? "selected" : ""}>${m ? m + " min" : "Off"}</option>`).join("")}</select></div>
          </div>
          <label class="check"><input type="checkbox" name="allowSchedule" ${svc.allowSchedule !== false ? "checked" : ""}/> Customers can choose a time for pickup/delivery (not just ASAP)</label>
          <h4 style="margin:16px 0 6px">⭐ Loyalty card ${proLock("loyalty")}</h4>
          <label class="check"><input type="checkbox" name="cfLoy" ${s.loyalty?.enabled ? "checked" : ""}/> Give 1 stamp per paid order — customers see their card when they order (by mobile number)</label>
          <div class="form3"><div><label>Stamps for a reward</label><input name="cfLoyN" type="number" min="2" max="30" value="${s.loyalty?.stamps ?? 10}"/></div><div><label>Min. order to earn a stamp (₱)</label><input name="cfLoyMin" type="number" min="0" value="${s.loyalty?.minTotal ?? 500}"/></div><div><label>Reward value (₱ off)</label><input name="cfLoyVal" type="number" min="0" value="${s.loyalty?.rewardValue ?? 150}"/></div></div>
          <div class="form2"><div><label>Reward text (shown to customers)</label><input name="cfLoyText" value="${esc(s.loyalty?.rewardText || "Free drink (up to ₱150)")}"/></div><div><label>Max stamps per customer per day</label><input name="cfLoyDay" type="number" min="1" max="5" value="${s.loyalty?.maxPerDay ?? 1}"/></div></div>
          <p class="small muted" style="margin:4px 0 12px">Stamps are given only when the order is <b>paid and completed</b>, one per order. A cancelled order returns the reward's stamps.</p>
          <label class="check"><input type="checkbox" name="guestOrders" ${svc.guestOrders !== false ? "checked" : ""}/> 🙋 Allow quick guest orders — customers can order without logging in (they can still log in with one tap to keep their receipts). Bookings always need a free TapTayo account.</label>
          <label class="check"><input type="checkbox" name="payFirst" ${svc.payFirst ? "checked" : ""}/> 💵 Dine-in &amp; take-out: <b>pay first</b>, then we prepare (stops walk-outs). The counter accepts the order only after it's paid.</label>
          <label class="check"><input type="checkbox" name="landing" ${s.landing !== false ? "checked" : ""}/> Show the "How would you like to order?" screen (Dine-in / Take-out / Reserve) before the menu</label>
` : ""}
        ${mode === "booking" ? `
          <div class="form2">
            <div><label>Time slot (minutes)</label><input name="slotMinutes" type="number" min="5" step="5" value="${bk.slotMinutes ?? 30}" /></div>
            <div><label>Advance notice (hours)</label><input name="leadTimeHours" type="number" min="0" value="${bk.leadTimeHours ?? 2}" /></div>
          </div>
          <label class="check"><input type="checkbox" name="requireStaff" ${bk.requireStaff !== false ? "checked" : ""}/> Customer picks a staff member</label>` : ""}
        ${mode === "salon" ? `
          <h4 style="margin:14px 0 6px">💇 Salon</h4>
          <label>Salon types offered (categories shown to customers)</label>
          <div id="salonTypes" class="row wrap" style="gap:6px 14px"></div>
          <div class="form3" style="margin-top:10px">
            <div><label>Booking slot step (minutes)</label><input name="slSlot" type="number" min="5" step="5" value="${sl.slotMinutes ?? 30}" /></div>
            <div><label>Buffer between clients (minutes)</label><input name="slBuffer" type="number" min="0" step="5" value="${sl.bufferMin ?? 10}" /></div>
            <div><label>Advance notice (hours)</label><input name="slLead" type="number" min="0" value="${sl.leadTimeHours ?? 1}" /></div>
            <div><label>Cancel / reschedule until (hours before)</label><input name="slCancel" type="number" min="0" value="${sl.cancelHours ?? 2}" /></div>
            <div><label>Grace period (minutes late)</label><input name="slGrace" type="number" min="0" value="${sl.graceMin ?? 15}" /></div>
            <div><label>Book up to (days ahead)</label><input name="slDays" type="number" min="1" max="60" value="${sl.maxDaysAhead ?? 14}" /></div>
            <div><label>Messenger confirmation window (minutes)</label><input name="slConfirm" type="number" min="10" value="${sl.confirmMinutes ?? 60}" /></div>
          </div>
          <label class="check"><input type="checkbox" name="slAnyone" ${sl.allowAnyone !== false ? "checked" : ""}/> Customers may choose "Any available staff"</label>
          <label class="check"><input type="checkbox" name="slOwnerWorks" ${sl.ownerWorks ? "checked" : ""}/> The owner also works on clients (give the owner a staff profile with skills below)</label>
          <label class="check"><input type="checkbox" name="slTips" ${sl.tips !== false ? "checked" : ""}/> Record tips at checkout</label>
          <h4 style="margin:16px 0 6px">🚪 Treatment rooms <span class="small muted">(optional — the system picks a free room; customers don't choose)</span></h4>
          <div id="spaRooms" class="stack" style="gap:6px"></div>
          <button class="btn ghost sm" type="button" id="spaAddRoom">+ Add room</button>
          <div class="form2"><div><label>Cleaning time between clients (minutes)</label><input name="slRoomBuf" type="number" min="0" max="60" value="${sl.roomBufferMin ?? 10}" /></div><div></div></div>
          <p class="small muted">No rooms = bookings depend on free staff only. A room with 2 beds fits a couple / 2-pax booking.</p>
          <label class="check"><input type="checkbox" name="slPax2" ${sl.allowPax2 !== false ? "checked" : ""}/> 👥 Allow 2-pax bookings (two ${store.businessType === "spa" ? "therapists" : "staff"} at the same time)</label>
          <label class="check"><input type="checkbox" name="slIntake" ${sl.intake?.enabled ? "checked" : ""}/> 💆 Ask massage details when booking (pressure, focus, things to avoid, health notes) — shown to reception and the ${store.businessType === "spa" ? "therapist" : "staff"}</label>
          <h4 style="margin:16px 0 6px">🎟️ Walk-in line (queue)</h4>
          <label class="check"><input type="checkbox" name="qOn" ${sl.queue?.enabled !== false ? "checked" : ""}/> Customers can join the line from your page and see their number, place in line and estimated time</label>
          <div class="form3">
            <div><label>Max people in line</label><input name="qMax" type="number" min="1" max="50" value="${sl.queue?.maxPeople ?? 8}"/></div>
            <div><label>Max wait (minutes)</label><input name="qWait" type="number" min="10" max="600" value="${sl.queue?.maxWaitMin ?? 90}"/></div>
            <div><label>Stop the line … min before closing</label><input name="qCut" type="number" min="0" max="240" value="${sl.queue?.cutoffMin ?? 60}"/></div>
            <div><label>Time to come in when called (min)</label><input name="qGrace" type="number" min="3" max="30" value="${sl.queue?.graceMin ?? 10}"/></div>
            <div><label>Ask off-duty on-call staff to come in at … people in line</label><input name="qOnCall" type="number" min="2" max="50" value="${sl.queue?.callOnCallAt ?? 5}"/></div>
          </div>
          <label class="check"><input type="checkbox" name="qRemote" ${sl.queue?.remote !== false ? "checked" : ""}/> Allow joining from anywhere (not only at the shop) ${(ctx.sub && (ctx.sub.plan === "free")) ? `<span class="small muted">— Free plan: only by scanning the shop's “Join the line” QR</span>` : ""}</label>
          <label class="check"><input type="checkbox" name="qSms" ${sl.queue?.sms ? "checked" : ""}/> Text the client when 2 are ahead of them ${lock("sms")} <span class="small muted">(uses your Semaphore credits)</span></label>
          <p class="small muted">When the line is full, paused or about to close, customers are shown the earliest time they can reserve instead. Not here when called → moved to the back once, then marked no-show. Walk-in line tickets don't count toward the plan's booking limit.</p>
          <div class="row wrap" style="gap:12px;align-items:center;margin:6px 0 10px"><canvas data-qshop width="120" height="120" style="border-radius:8px;background:#fff"></canvas><div><b>“Join the line” QR for your shop</b><p class="small muted" style="margin:2px 0 6px">Print and put it at the door. Scanning it counts as “at the shop”.</p><code class="small">${esc(location.origin)}/m/${esc(store.slug)}?shop=1</code></div></div>
          <p class="small" style="margin:0 0 10px">📺 <b>Queue TV:</b> open <a href="/tv/${esc(store.slug)}" target="_blank" rel="noopener">${esc(location.origin)}/tv/${esc(store.slug)}</a> on a TV or tablet at the shop — it shows who's being served, the next numbers, the wait and the join QR.</p>
          ${store.businessType === "freelance" ? `<h4 style="margin:16px 0 6px">🎨 Quotes &amp; media kit</h4>
          <label class="check"><input type="checkbox" name="flQuotes" ${sl.freelance?.quotes !== false ? "checked" : ""}/> Clients can “Request a quote” (brand collabs, custom projects)</label>
          <div class="form2"><div><label>Default downpayment %</label><input name="flDp" type="number" min="0" max="100" value="${sl.freelance?.dpPercent ?? 50}"/></div><div><label>Revisions included</label><input name="flRev" type="number" min="0" max="10" value="${sl.freelance?.revisions ?? 2}"/></div></div>
          <label>Default terms (shown with every quote)</label><textarea name="flTerms" rows="4" placeholder="• The downpayment locks the date and is non-refundable…">${esc(sl.freelance?.terms || "")}</textarea>
          <label>Media kit — your platforms (shown on your page)</label><div id="flPlat"></div>
          <div class="row wrap" style="gap:8px;align-items:center;margin:6px 0 10px">${store.creatorVerified ? `<span class="pill ok">✔ Verified by TapTayo</span>` : store.verifyReq?.status === "pending" ? `<span class="pill">⏳ Verification pending — post code <b>${esc(store.verifyReq.code)}</b> in one bio for a day</span>` : `${store.verifyReq?.status === "rejected" ? `<span class="small" style="color:#b45309">Not verified yet: ${esc(store.verifyReq.reason || "")}</span>` : ""}<button type="button" class="btn sm ghost" id="flVerify">✔ Get the Verified badge</button><span class="small muted">We check your accounts and follower counts (free).</span>`}</div>
          <h4 style="margin:16px 0 6px">💡 Your profile</h4>
          <label>Niches (comma-separated)</label><input name="flNiches" value="${esc((sl.freelance?.niches || []).join(", "))}" placeholder="Food, Lifestyle, Travel"/>
          <label>City</label><input name="flCity" value="${esc(sl.freelance?.city || "")}" placeholder="Makati"/>
          <label>Why book me</label><textarea name="flPitch" rows="3" maxlength="600" placeholder="Honest food reviews, 120K Manila foodies, most videos hit 50K+ views in a week.">${esc(sl.freelance?.pitch || "")}</textarea>
          <label>Brands you've worked with (comma-separated)</label><input name="flBrands" value="${esc((sl.freelance?.brands || []).join(", "))}"/>
          <label class="check"><input type="checkbox" name="flUgc" ${sl.freelance?.ugc ? "checked" : ""}/> 📱 I make UGC (videos the brand posts on its own page / ads — followers don't matter)</label>
          <label class="check"><input type="checkbox" name="flAdult" ${sl.freelance?.adult ? "checked" : ""}/> I'm 18 or older <span class="muted small">(required to be listed)</span></label>
          <label class="check"><input type="checkbox" name="flDir" ${sl.freelance?.directory ? "checked" : ""}/> 🎥 List me on TapTayo Collab (businesses can find and invite me — needs 3 portfolio samples)</label>
          <h4 style="margin:16px 0 6px">🕒 Side-job availability</h4>
          <p class="small muted" style="margin:0 0 6px">Have a day job? Take bookings only when you're free.</p>
          <div class="row wrap" style="gap:6px">${[["weekends", "Weekends only"], ["evenings", "Weeknight evenings"], ["evenings & weekends", "Evenings & weekends"], ["", "Any day"]].map(([k, t]) => `<button type="button" class="btn sm ${(sl.freelance?.availability?.sideJob || "") === k ? "" : "ghost"}" data-sidejob="${k}">${t}</button>`).join("")}</div>
          <input type="hidden" name="flSide" value="${esc(sl.freelance?.availability?.sideJob || "")}"/>
          <div class="form2"><div><label>Max jobs a week (0 = no limit)</label><input name="flMaxWk" type="number" min="0" max="50" value="${sl.freelance?.availability?.maxPerWeek || 0}"/></div>
          <div><label>Taking a break until (optional)</label><input name="flPause" type="date" value="${sl.freelance?.availability?.paused && sl.freelance.availability.until ? new Date(sl.freelance.availability.until + 8 * 3600e3).toISOString().slice(0, 10) : ""}"/></div></div>
          <p class="small muted">Picking a preset also sets your opening hours (check Hours after saving).</p>
          <h4 style="margin:16px 0 6px">💸 Offers</h4>
          <label class="check"><input type="checkbox" name="flOffers" ${sl.freelance?.offers !== false ? "checked" : ""}/> Clients can make an offer (off = fixed rates only)</label>
          <div class="form2"><div><label>Minimum offer (₱ fee + transport, 0 = none)</label><input name="flMin" type="number" min="0" value="${sl.freelance?.minFee || 0}"/></div></div>
          <h4 style="margin:16px 0 6px">⚡ Rush & on-time promise</h4>
          <label class="check"><input type="checkbox" name="flRush" ${sl.freelance?.rush?.enabled ? "checked" : ""}/> Offer rush</label>
          <div class="form2"><div><label>Rush: deliver within (hours)</label><input name="flRushH" type="number" min="1" value="${sl.freelance?.rush?.hours || 24}"/></div><div><label>Rush fee (₱)</label><input name="flRushF" type="number" min="0" value="${sl.freelance?.rush?.fee || 500}"/></div>
          <div><label>If I miss a rush deadline</label><select name="flMiss">${[["refund", "Refund the rush fee"], ["discount", "Discount on their next booking"], ["both", "Both"]].map(([k, t]) => `<option value="${k}" ${(sl.freelance?.rushMiss || "refund") === k ? "selected" : ""}>${t}</option>`).join("")}</select></div><div><label>Discount %</label><input name="flMissPct" type="number" min="0" max="100" value="${sl.freelance?.rushMissPct || 10}"/></div></div>
          <h4 style="margin:16px 0 6px">📷 Photo release (photographers)</h4>
          <div class="form3"><div><label>Release</label><select name="flRel">${[["both", "Raw first, then final"], ["together", "Raw + final together"], ["final", "Final only"]].map(([k, t]) => `<option value="${k}" ${(sl.freelance?.release?.mode || "both") === k ? "selected" : ""}>${t}</option>`).join("")}</select></div><div><label>Raw copies (days after)</label><input name="flRaw" type="number" min="0" value="${sl.freelance?.release?.rawDays ?? 3}"/></div><div><label>Final edits (days after)</label><input name="flFin" type="number" min="0" value="${sl.freelance?.release?.finalDays ?? 7}"/></div></div>
          <p class="small muted">Filled in automatically on quotes for shoots and events — the client sees a countdown.</p>
          <h4 style="margin:16px 0 6px">🛡 Safety</h4>
          <label class="check"><input type="checkbox" name="flId" ${sl.freelance?.requireIdOnSite ? "checked" : ""}/> On-site jobs need the client's valid ID (only you see it)</label>
          <h4 style="margin:16px 0 6px">🎁 X-Deals (barter: free food, product or staycation for a video)</h4>
          <label class="check"><input type="checkbox" name="xOn" ${sl.freelance?.xdeal?.on ? "checked" : ""}/> I accept X-Deals</label>
          <div class="form2"><div><label>Minimum tip with an X-Deal (₱, 0 = none)</label><input name="xTip" type="number" min="0" value="${sl.freelance?.xdeal?.minTip || 0}"/></div><div><label>Video ready (days after I receive the item)</label><input name="xDays" type="number" min="1" max="30" value="${sl.freelance?.xdeal?.releaseDays || 5}"/></div></div>
          <div class="row wrap" style="gap:12px">${[["food", "🍽 Food"], ["product", "📦 Products"], ["staycation", "🏡 Staycations"]].map(([k, t]) => `<label class="check" style="margin:0"><input type="checkbox" name="xType" value="${k}" ${!sl.freelance?.xdeal?.types || sl.freelance.xdeal.types.includes(k) ? "checked" : ""}/> ${t}</label>`).join("")}</div>
          <div style="margin-top:8px">${store.kycAt ? `<span class="pill ok">🪪 Valid ID on file</span>` : `<label class="btn sm ghost" style="cursor:pointer">🪪 Upload valid ID (required for X-Deals)<input type="file" accept="image/*" id="xKyc" hidden/></label>`}<p class="small muted" style="margin:4px 0 0">Businesses send real items, so X-Deals need your ID. Only TapTayo sees it; deleted automatically later. New creators: items up to ₱800 → ₱2,000 after 3 on-time X-Deals.</p></div>` : ""}
          <h4 style="margin:16px 0 6px">💸 Staff collect &amp; remit</h4>
          <label class="check"><input type="checkbox" name="slRemit" ${sl.remit?.enabled ? "checked" : ""}/> On-call staff take the client's payment themselves (cash or their GCash) and remit to you online</label>
          <p class="small muted" style="margin:2px 0 0">Each staff sees their balance: collected − commission / basic / allowance. They send a remittance (GCash, bank or cash) with the reference no., you confirm it in Reports. Great when you're away from the shop.</p>
          <h4 style="margin:16px 0 6px">🛡 Protect your clients (anti-direct booking)</h4>
          <label class="check"><input type="checkbox" name="slProtect" ${sl.protectClients !== false ? "checked" : ""}/> Staff never see the client's phone number, and see the exact home address only 3 hours before the job until it's done</label>
          <p class="small muted" style="margin:2px 0 0">Clients also see a "Book only in the app" note with a private "Report a staff offer" button. Protects the client and your business.</p>
          <h4 style="margin:16px 0 6px">📣 Pass clients to staff (job offers)</h4>
          <label class="check"><input type="checkbox" name="ofOn" ${sl.offers?.enabled ? "checked" : ""}/> Offer clients to staff — they accept on their phone</label>
          <div class="form3">
            <div><label>How</label><select name="ofMode"><option value="rotate" ${(sl.offers?.mode || "rotate") === "rotate" ? "selected" : ""}>One at a time (rotation) — next staff if no answer</option><option value="race" ${sl.offers?.mode === "race" ? "selected" : ""}>All at once — first to accept gets it</option></select></div>
            <div><label>Time to accept (minutes)</label><input name="ofMin" type="number" min="1" max="15" value="${Math.round((sl.offers?.seconds || 300) / 60)}"/></div>
            <div><label class="check" style="margin-top:30px"><input type="checkbox" name="ofAuto" ${sl.offers?.auto !== false ? "checked" : ""}/> Offer new "Any available" bookings automatically</label></div>
            <div><label class="check"><input type="checkbox" name="ofNear" ${sl.offers?.nearest !== false ? "checked" : ""}/> Nearest first — staff / freelancers closest to the client (home service) or the shop get the offer first</label></div>
          </div>
          <p class="small muted">Only staff who are free at that time get the offer. On-call staff and freelancers must tap "I'm available" first; if they don't answer in time they are set to not available. Staff get a phone notification when they turn on alerts in the staff app.</p>
          <label>What do you call your staff?</label><input name="slCall" maxlength="24" placeholder="therapist, doctor, stylist" value="${String(sl.staffWord || \"\").replace(/\"/g, \"\")}"/><label class="check"><input type="checkbox" name="slGender" ${sl.genderPick ? "checked" : ""}/> 🚻 Let customers choose a female or male ${store.businessType === "spa" ? "therapist" : "staff"} (set each person's gender in Staff)</label>
          <div id="homeSvcBlock">
          ${place === "home" ? `<p class="small"><b>Home service only</b> — every booking is at the client's place (change in Tools → Advanced → Business setup).</p><input type="checkbox" name="slHome" checked hidden/>` : `<label class="check"><input type="checkbox" name="slHome" ${sl.homeService?.enabled ? "checked" : ""}/> 🏠 Offer home service</label>`}
          <div class="form3">
            <div><label>Travel time before & after (minutes)</label><input name="hsTravel" type="number" min="0" max="180" value="${hs.travelMin ?? 30}" /><p class="small muted" style="margin:4px 0 0">Blocked on your calendar so no shop client is booked while you're on the road.</p></div>
            <div><label>Minimum spend (₱, 0 = none)</label><input name="hsMin" type="number" min="0" value="${hs.minSpend || 0}" /></div>
            <div><label>Default fee (₱) when no area matches</label><input name="slHomeFee" type="number" min="0" value="${hs.fee ?? 0}" /></div>
          </div>
          <div class="form3"><div><label>📍 Travel radius (km, 0 = any)</label><input name="hsRadius" type="number" min="0" max="500" value="${hs.radiusKm || 0}"/></div><div style="grid-column:span 2"><label>Your base (Maps link or "lat,lng")</label><div style="display:flex;gap:6px"><input name="hsBase" value="${hs.base ? `${hs.base.lat},${hs.base.lng}` : ""}" placeholder="14.5547,121.0244" style="flex:1"/><button type="button" class="btn ghost sm" id="hsBaseMe">📍 Here</button></div></div></div>
          <p class="small muted" style="margin:2px 0 8px">Clients farther than this see “Sorry — that's outside our area”. Works together with the areas below.</p>
          <label>Areas you go to & transport fee</label>
          <div id="hsAreas" class="stack" style="gap:6px"></div>
          <button class="btn ghost sm" type="button" id="hsAddArea">+ Add area</button>
          <p class="small muted">Customers pick their area and see the fee right away. Leave empty to confirm the fee yourself per booking.</p>
          <label style="margin-top:12px">🧺 What to prepare (shown to the client before they book)</label>
          <p class="small muted" style="margin:0 0 6px">e.g. 2 bath towels, a chair, an extension cord, hot water. Tick “We can bring it” and set a fee if your staff can bring it — the client chooses “I have it” or “Please bring”, and your staff see what to bring before leaving.</p>
          <div id="hsPrep" class="stack" style="gap:6px"></div>
          <button class="btn ghost sm" type="button" id="hsAddPrep">+ Add item</button>
          <label style="margin-top:12px">Home service hours</label>
          <p class="small muted" style="margin:0 0 6px">Leave all unticked = same as your business hours. ${place === "both" ? "Shop clients are booked outside these hours." : ""}</p>
          <div class="hs-days">${DAYS.map(([k, l]) => { const d = hs.days?.[k] || {}; return `<div class="row" style="gap:6px;align-items:center"><label class="check" style="margin:0;min-width:70px"><input type="checkbox" name="hsOn_${k}" ${d.on ? "checked" : ""}/> ${l}</label><input type="time" name="hsFrom_${k}" value="${esc(d.from || "09:00")}" style="max-width:160px"/><span>–</span><input type="time" name="hsTo_${k}" value="${esc(d.to || "12:00")}" style="max-width:160px"/></div>`; }).join("")}</div>
          ${place === "both" ? `<label class="check"><input type="checkbox" name="hsExcl" ${hs.exclusive !== false ? "checked" : ""}/> Home service hours are only for home service (no shop clients for me then)</label>
          <label>Shop status while I'm on a home service</label><select name="slHomeAway"><option value="ask" ${(sl.homeAway || "ask") === "ask" ? "selected" : ""}>Ask me each time I tap “On my way”</option><option value="close" ${sl.homeAway === "close" ? "selected" : ""}>Always show “On home service · back ~time”</option><option value="open" ${sl.homeAway === "open" ? "selected" : ""}>Keep the shop shown as open</option></select>
          <label>While I'm out on home service (no other staff in the shop)</label><select name="slAway"><option value="queue" ${sl.walkInWhenAway !== "off" ? "selected" : ""}>Walk-ins can still join the line (served when I'm back)</option><option value="off" ${sl.walkInWhenAway === "off" ? "selected" : ""}>Pause walk-ins — customers book a time instead</option></select>` : ""}
          <label class="check"><input type="checkbox" name="hsEscort" ${hs.escort ? "checked" : ""}/> 🛵 A rider drops off & picks up the ${store.businessType === "spa" ? "therapist" : "staff"} ${lock("delivery")} <span class="small muted">(rider sees the trip; when the service is done the rider is told to pick up)</span></label>
          <label class="check"><input type="checkbox" name="hsPin" ${hs.requirePin !== false ? "checked" : ""}/> 📍 Require a map pin (the client taps “My location”)</label>
          <label class="check"><input type="checkbox" name="hsId" ${hs.requireId === true ? "checked" : ""}/> 🪪 Require a valid ID on the client's <b>first</b> home service (private, kept for next bookings, auto-deleted after the retention period)</label>
          <div class="form2"><div><label>Reservation fee for home service (₱, 0 = none) ${proLock("salondp")}</label><input name="hsDp" type="number" min="0" value="${hs.dpAmount || 0}" /></div><div><label>Note shown to customer</label><input name="slHomeNote" value="${esc(hs.note || "")}" placeholder="e.g. Please prepare a chair near an outlet" /></div></div>
          </div>
          <label>Salon policy (shown on booking)</label><textarea name="polSalon" rows="5">${esc(s.policies?.salon ?? "")}</textarea>
          <h4 style="margin:16px 0 6px">🚫 No-shows</h4>
          <div class="form2"><div><label>Require a reservation fee after … no-shows (0 = never)</label><input name="slNsDp" type="number" min="0" value="${sl.noShow?.dpAfter ?? 2}" /></div><div><label>Block the number after … no-shows (0 = never)</label><input name="slNsBlock" type="number" min="0" value="${sl.noShow?.blockAfter ?? 3}" /></div></div>
          <p class="small muted">Counted per phone number. You can reset or unblock in <b>Customers</b>.</p>
          <h4 style="margin:16px 0 6px">💵 Reservation fee (DP) ${proLock("salondp")}</h4>
          <label class="check"><input type="checkbox" name="slDp" ${sl.deposit?.enabled ? "checked" : ""}/> Ask for a reservation fee when booking online</label>
          <div class="form3"><div><label>Fee (₱)</label><input name="slDpAmt" type="number" min="0" value="${sl.deposit?.amount ?? 100}" /></div><div><label>Only when the booking total is at least (₱, 0 = all)</label><input name="slDpFrom" type="number" min="0" value="${sl.deposit?.minTotal ?? 1000}" /></div><div class="small muted" style="align-self:end">Paid by GCash/Maya (your payment methods) with ref no. Deducted at checkout. Kept by the salon on a no-show. Customers with repeated no-shows always pay it.</div></div>
          <h4 style="margin:16px 0 6px">⏰ Reminders by SMS ${proLock("salonremind")} ${lock("sms")}</h4>
          <label class="check"><input type="checkbox" name="slRemDay" ${sl.reminders?.dayBefore ? "checked" : ""}/> Day before (sent around 6 PM)</label>
          <label class="check"><input type="checkbox" name="slRemHrs" ${sl.reminders?.hoursBefore ? "checked" : ""}/> 2 hours before</label>
          <label class="check"><input type="checkbox" name="slRebook" ${sl.rebook?.enabled ? "checked" : ""}/> "Time for your retouch" — rebook reminder (set the weeks per service in Services)</label>
          <p class="small muted">Uses your Semaphore credits (Settings → SMS). Sent only to the number on the booking, outside quiet hours.</p>
          <h4 style="margin:16px 0 6px">⭐ Loyalty card ${proLock("loyalty")}</h4>
          <label class="check"><input type="checkbox" name="slLoy" ${sl.loyalty?.enabled ? "checked" : ""}/> 1 stamp per paid visit</label>
          <div class="form3"><div><label>Stamps for a reward</label><input name="slLoyN" type="number" min="2" max="30" value="${sl.loyalty?.stamps ?? 10}" /></div><div><label>Min. visit total for a stamp (₱)</label><input name="slLoyMin" type="number" min="0" value="${sl.loyalty?.minTotal ?? 300}" /></div><div><label>Reward (free up to ₱)</label><input name="slLoyVal" type="number" min="0" value="${sl.loyalty?.rewardValue ?? 350}" /></div></div>
          <label>Reward text (shown to customers)</label><input name="slLoyText" value="${esc(sl.loyalty?.rewardText || "Free haircut (or ₱350 off)")}" />
          <h4 style="margin:16px 0 6px">🎁 Gift cards ${proLock("giftcards")}</h4>
          <label class="check"><input type="checkbox" name="gcOn" ${sl.giftcards?.enabled ? "checked" : ""}/> Sell gift cards on the customer page (paid by GCash/Maya, verified at the counter) and at the counter</label>
          <div class="form3"><div><label>Amount choices (₱, comma separated)</label><input name="gcAmts" value="${esc((sl.giftcards?.amounts || [500, 1000, 2000, 3000]).join(", "))}"/></div><div><label>Min / max custom (₱)</label><div class="row" style="gap:6px"><input name="gcMin" type="number" value="${sl.giftcards?.min ?? 300}"/><input name="gcMax" type="number" value="${sl.giftcards?.max ?? 10000}"/></div></div><div><label>Valid for (months)</label><input name="gcMonths" type="number" min="1" value="${sl.giftcards?.validMonths ?? 12}"/></div></div>
          <h4 style="margin:16px 0 6px">💎 Memberships ${proLock("memberships")}</h4>
          <div id="slMemList"></div><button class="btn ghost sm" type="button" id="slAddMem">+ Membership</button>
          <p class="small muted">e.g. "Glow Club" ₱999 / 30 days · 10% off services · 2 free blowouts. Sold at the counter checkout; perks apply automatically by phone number.</p>
          <h4 style="margin:16px 0 6px">💌 Referral ${proLock("referral")}</h4>
          <label class="check"><input type="checkbox" name="refOn" ${sl.referral?.enabled ? "checked" : ""}/> Each client gets a code; a friend's first visit gets a discount and the client gets a voucher</label>
          <div class="form2"><div><label>Reward for both (₱)</label><input name="refAmt" type="number" min="0" value="${sl.referral?.reward ?? 100}"/></div></div>
          <h4 style="margin:16px 0 6px">🎂 Birthday treat ${proLock("birthday")}</h4>
          <label class="check"><input type="checkbox" name="bdOn" ${sl.birthday?.enabled ? "checked" : ""}/> Give a voucher during the client's birthday month (texted if SMS is on; listed in the counter's Due back tab)</label>
          <div class="form3"><div><label>Type</label><select name="bdType"><option value="amount" ${sl.birthday?.type !== "percent" ? "selected" : ""}>₱ off</option><option value="percent" ${sl.birthday?.type === "percent" ? "selected" : ""}>% off</option></select></div><div><label>Value</label><input name="bdVal" type="number" min="1" value="${sl.birthday?.value ?? 150}"/></div><div><label>Min. bill (₱)</label><input name="bdMin" type="number" min="0" value="${sl.birthday?.minOrder ?? 0}"/></div></div>
          <h4 style="margin:16px 0 6px">🎁 Packages (prepaid sessions) ${proLock("packages")}</h4>
          <div id="slPkgList"></div><button class="btn ghost sm" type="button" id="slAddPkg">+ Package</button>
          <p class="small muted">e.g. "IPL underarm × 5" — sold at the counter checkout, each visit uses 1 session.</p>
          <p class="small muted">Booking requires Messenger confirmation when it is enabled in <b>Confirmation</b> below (same as pickup/delivery). Services, durations and staff pay are managed in the <b>Services</b> page; staff skills and salary in <b>Staff &amp; PINs</b>.</p>` : ""}
        ${mode === "laundry" ? `
          <h4 style="margin:14px 0 6px">🧺 Laundry</h4>
          <div class="form3">
            <div><label>Minimum kg per job</label><input name="ldMinKg" type="number" min="0" step="0.5" value="${ld.minKg ?? 5}" /></div>
            <div><label>Max kg per load (machine)</label><input name="ldMaxLoad" type="number" min="1" step="0.5" value="${ld.maxLoadKg ?? 8}" /></div>
            <div><label>Normal turnaround (hours)</label><input name="ldEta" type="number" min="1" value="${ld.etaHours ?? 24}" /></div>
            <div><label>Rush fee</label><select name="ldRushMode"><option value="percent" ${(ld.rushMode || "percent") === "percent" ? "selected" : ""}>% of bill</option><option value="fixed" ${ld.rushMode === "fixed" ? "selected" : ""}>Fixed ₱</option><option value="double" ${ld.rushMode === "double" ? "selected" : ""}>Double the bill</option></select></div>
            <div><label>Rush value (% or ₱)</label><input name="ldRushValue" type="number" min="0" value="${ld.rushValue ?? 50}" /></div>
            <div><label>Rush turnaround (hours)</label><input name="ldRushEta" type="number" min="1" value="${ld.rushEtaHours ?? 6}" /></div>
            <div><label>Folding</label><select name="ldFold"><option value="free" ${ld.foldFree !== false ? "selected" : ""}>Free (included)</option><option value="fee" ${ld.foldFree === false ? "selected" : ""}>Charged per kg (customer may opt out)</option></select></div>
            <div><label>Fold fee per kg (₱)</label><input name="ldFoldFee" type="number" min="0" value="${ld.foldFee ?? 0}" /></div>
            <div><label>Complaint window (hours after claim)</label><input name="ldComplaint" type="number" min="1" value="${ld.complaintHours ?? 24}" /></div>
            <div><label>Storage: free days after ready</label><input name="ldStoreFree" type="number" min="0" value="${ld.storageFreeDays ?? 7}" /></div>
            <div><label>Storage fee per day after (₱, 0 = none)</label><input name="ldStoreFee" type="number" min="0" value="${ld.storageFeePerDay ?? 0}" /></div>
          </div>
          <label class="check"><input type="checkbox" name="ldLoyalty" ${ld.loyalty?.enabled ? "checked" : ""}/> 🎁 Loyalty: every <input name="ldLoyEvery" type="number" min="1" value="${ld.loyalty?.everyKg ?? 10}" style="width:70px;display:inline-block"/> kg washed = <input name="ldLoyFree" type="number" min="0.5" step="0.5" value="${ld.loyalty?.freeKg ?? 1}" style="width:70px;display:inline-block"/> kg free (counter applies it on the next job)</label>
          <label>Laundry policy (shown on booking and on the claim stub page)</label><textarea name="polLaundry" rows="6">${esc(s.policies?.laundry ?? "")}</textarea>
          <label class="check"><input type="checkbox" name="ldPayFirst" ${ld.paymentFirst ? "checked" : ""}/> Payment first — jobs wait for payment before washing (fold queue = first paid, first folded)</label>
          <label class="check"><input type="checkbox" name="ldCount" ${ld.clothesCount ? "checked" : ""}/> Count clothes (pieces) on every job</label>
          <label class="check"><input type="checkbox" name="ldSep" ${ld.separateWhites !== false ? "checked" : ""}/> Separate whites / colors by default</label>
          <label class="check"><input type="checkbox" name="ldDry" ${ld.steps?.drying !== false ? "checked" : ""}/> Show "Drying" step</label>
          <label class="check"><input type="checkbox" name="ldFoldStep" ${ld.steps?.folding !== false ? "checked" : ""}/> Show "Folding" step</label>
          <label style="margin-top:8px">Service modes offered</label>
          <label class="check"><input type="checkbox" name="ldM1" ${ld.modes?.dropoff_pickup !== false ? "checked" : ""}/> Customer drop-off · Customer pickup</label>
          <label class="check"><input type="checkbox" name="ldM2" ${ld.modes?.rider_rider !== false ? "checked" : ""}/> Rider pickup · Rider delivery ${lock("delivery")}</label>
          <label class="check"><input type="checkbox" name="ldM3" ${ld.modes?.dropoff_delivery !== false ? "checked" : ""}/> Customer drop-off · Rider delivery ${lock("delivery")}</label>
          <label class="check"><input type="checkbox" name="ldM4" ${ld.modes?.rider_pickup !== false ? "checked" : ""}/> Rider pickup · Customer pickup ${lock("delivery")}</label>
          <p class="small muted">Services and prices (per kg / per piece / per load / estimate) are managed in the <b>Services</b> page. Delivery fee is set by the counter per job.</p>` : ""}
        ${mode === "pickup" ? `
          <div class="form2">
            <div><label>Turnaround (hours)</label><input name="turnaroundHours" type="number" min="1" value="${pk.turnaroundHours ?? 24}" /></div>
          </div>
          <label class="check"><input type="checkbox" name="requirePhone" ${pk.requirePhone !== false ? "checked" : ""}/> Require customer phone number</label>` : ""}
      </div>

      ${mode === "table" ? `
      <div class="tile">
        <h3>Features</h3>
        <p class="small muted">Turn on the features your business needs. They appear in the "Reserve" tab of the customer page.</p>

        <div class="feat">
          <label class="check big"><input type="checkbox" name="resvEnabled" ${resv.enabled !== false ? "checked" : ""}/> 🪑 Table reservations</label>
          <div class="form2 featbody">
            <div><label>Max pax per reservation</label><input name="resvMaxPax" type="number" min="1" value="${resv.maxPax ?? 12}" /></div>
            <div><label>Advance notice (hours)</label><input name="resvLeadHours" type="number" min="0" value="${resv.leadTimeHours ?? 2}" /></div>
          </div>
        </div>

        <div class="feat">
          <label class="check big"><input type="checkbox" name="csEnabled" ${cs.enabled ? "checked" : ""}/> 🔔 Call staff <span class="small muted">(customers call a crew member from their table)</span></label>
          <div class="featbody">
            <div class="form2">
              <div><label>Cooldown (minutes per table)</label><input name="csCooldown" type="number" min="1" max="30" value="${cs.cooldownMin ?? 5}" /></div>
              <div><label class="check" style="margin-top:34px"><input type="checkbox" name="csMessage" ${cs.allowMessage !== false ? "checked" : ""}/> Customers can type a message</label></div>
            </div>
            <label>Quick options</label>
            <div class="row wrap">${CALL_OPTS.map(([k, l]) => `<label class="check"><input type="checkbox" name="csOpt" value="${k}" ${!cs.options || cs.options.includes(k) ? "checked" : ""}/> ${l}</label>`).join("")}</div>
            <label class="check"><input type="checkbox" name="csKitchen" ${cs.showToKitchen ? "checked" : ""}/> Also show on kitchen/barista screens (default: crew and manager only)</label>
          </div>
        </div>

        <div class="feat">
          <label class="check big" style="cursor:default"><input type="checkbox" checked disabled/> 📜 Booking policies & waiver</label>
          <div class="featbody">
            <p class="small muted">The policy appears on the booking form with an "I agree" checkbox. The waiver is signed by the customer on their phone (e-signature) and saved as a PDF.</p>
            <label>Policy — Table reservation</label><textarea name="polTable" rows="3">${esc(pol.table ?? DEF_POLICY.table)}</textarea>
            <label>Policy — Event booking</label><textarea name="polEvent" rows="4">${esc(pol.event ?? DEF_POLICY.event)}</textarea>
            <label>Policy — VIP room</label><textarea name="polVip" rows="4">${esc(pol.vip ?? DEF_POLICY.vip)}</textarea>
            <label>Waiver text (to be signed)</label><textarea name="wvText" rows="6">${esc(wv.text ?? DEF_WAIVER)}</textarea>
            <div class="row wrap" style="margin-top:8px"><span class="small muted">Signature required for:</span>
              <label class="check"><input type="checkbox" name="wvTable" ${wv.table ? "checked" : ""}/> Table</label>
              <label class="check"><input type="checkbox" name="wvEvent" ${wv.event !== false ? "checked" : ""}/> Event</label>
              <label class="check"><input type="checkbox" name="wvVip" ${wv.vip !== false ? "checked" : ""}/> VIP</label></div>
            <div class="form2"><div><label>ID photo</label><select name="wvId"><option value="off" ${(wv.idMode || "optional") === "off" ? "selected" : ""}>Don't ask</option><option value="optional" ${(wv.idMode || "optional") === "optional" ? "selected" : ""}>Optional</option><option value="required" ${wv.idMode === "required" ? "selected" : ""}>Required</option></select></div></div>
            <label class="check"><input type="checkbox" name="wvBlock" ${wv.blockConfirm !== false ? "checked" : ""}/> Staff cannot Confirm until the waiver is signed</label>
          </div>
        </div>

        <div class="feat">
          <label class="check big"><input type="checkbox" name="fbEnabled" ${fb.enabled !== false ? "checked" : ""}/> ⭐ Customer feedback <span class="small muted">(rating after the order)</span> ${lock("feedback")}</label>
          <div class="featbody"><div class="form2">
            <div><label>Show on menu</label><select name="fbDisplay"><option value="off" ${fb.display === "off" ? "selected" : ""}>Don't show</option><option value="stars" ${(fb.display || "stars") === "stars" ? "selected" : ""}>Stars only (e.g. 4.8 ★ · 120)</option><option value="3plus" ${fb.display === "3plus" ? "selected" : ""}>Stars + comments rated 3★ and up</option><option value="all" ${fb.display === "all" ? "selected" : ""}>Stars + all comments</option></select></div>
            <div><label class="check" style="margin-top:34px"><input type="checkbox" name="fbPhoto" ${fb.askPhoto ? "checked" : ""}/> Ask for a photo (optional for customer)</label></div>
          </div></div>
        </div>

        <div class="feat">
          <label class="check big"><input type="checkbox" name="incEnabled" ${inc.enabled !== false ? "checked" : ""}/> ⚠️ Incident reports <span class="small muted">(wrong order, missing items, damaged, etc.)</span> ${lock("feedback")}</label>
          <div class="featbody">
            <label class="check"><input type="checkbox" name="incProof" ${inc.requireProof !== false ? "checked" : ""}/> Require photo proof for pickup/delivery</label>
            <div class="form2">
              <div><label>Who can resolve</label><select name="incWho"><option value="manager" ${(inc.who || "manager") === "manager" ? "selected" : ""}>Manager only</option><option value="crew" ${inc.who === "crew" ? "selected" : ""}>Crew and manager</option></select></div>
              <div><label>Max voucher crew can issue (₱)</label><input name="incMaxCrew" type="number" min="0" value="${inc.maxVoucherCrew ?? 100}" /></div>
              <div><label>Free items crew can give per day</label><input name="incMaxComps" type="number" min="0" value="${inc.maxCompsCrew ?? 3}" /></div>
              <div><label>Crew can cancel orders up to (₱) once preparing</label><input name="incCancelMax" type="number" min="0" value="${inc.crewCancelMax ?? 300}" /></div>
            </div>
            <p class="small muted">Dine-in: the manager is called to the table first (shows in Requests), talks to the customer, then resolves. Pickup/delivery: staff review the proof, then resolve or dismiss.</p>
          </div>
        </div>

        <div class="feat">
          <label class="check big"><input type="checkbox" name="evEnabled" ${ev.enabled ? "checked" : ""}/> 🎉 Event booking <span class="small muted">(birthday, meetings, parties)</span> ${lock("events_vip")}</label>
          <div class="featbody">
            <div class="form2">
              <div><label>Advance notice (days)</label><input name="evLeadDays" type="number" min="0" value="${ev.leadTimeDays ?? 3}" /></div>
              <div><label>Max pax</label><input name="evMaxPax" type="number" min="1" value="${ev.maxPax ?? 100}" /></div>
              <div><label>Deposit required (%)</label><input name="evDeposit" type="number" min="0" max="100" value="${ev.depositPercent ?? 50}" /></div>
              <div><label>Note to customer</label><input name="evNote" value="${esc(ev.note || "")}" placeholder="e.g. Deposit via GCash within 24h to confirm" /></div>
            </div>
            <div class="row between" style="margin-top:10px"><label style="margin:0">Packages</label><button class="btn ghost sm" type="button" id="addPkg">+ Package</button></div>
            <p class="small muted">e.g. "Birthday Package A" — ₱350 per head, min 20 pax; or "Venue only" — ₱3,000 flat</p>
            <div id="pkgList" class="editlist"></div>
          </div>
        </div>

        <div class="feat">
          <label class="check big"><input type="checkbox" name="vipEnabled" ${vip.enabled ? "checked" : ""}/> 🎤 VIP rooms / KTV / private rooms ${lock("events_vip")}</label>
          <div class="featbody">
            <div class="form2">
              <div><label>Advance notice (hours)</label><input name="vipLeadHours" type="number" min="0" value="${vip.leadTimeHours ?? 2}" /></div>
              <div><label>🧹 Cleaning between bookings (minutes)</label><input name="vipClean" type="number" min="0" max="180" value="${vip.cleanMin ?? 30}" /></div>
              <div><label>Note to customer</label><input name="vipNote" value="${esc(vip.note || "")}" placeholder="e.g. Room rate is consumable" /></div>
            </div>
            <p class="small muted" style="margin-top:8px"><b>Per hour</b> = room fee applies. <b>Consumable</b> = no room fee, but a minimum order is required. <b>Per hour, consumable</b> = room fee is deducted from the order bill.</p>
            <label class="check"><input type="checkbox" name="vipPrior" ${vip.includePriorOnTransfer ? "checked" : ""}/> Include earlier dine-in orders in the consumable when transferring to VIP (default: no — only orders from the start of the session)</label>
            <label class="check"><input type="checkbox" name="vipOverride" ${vip.allowManagerOverride !== false ? "checked" : ""}/> Manager can override at the time of transfer</label>
            <label class="check" style="margin-top:8px"><input type="checkbox" name="avEnabled" ${vip.autoVoucher?.enabled ? "checked" : ""}/> 👑 Give free VIP hours automatically when an order is completed</label>
            <div class="grid3"><div><label>Free hours</label><input name="avHours" type="number" min="1" max="6" value="${vip.autoVoucher?.hours ?? 1}" /></div><div><label>Min. order subtotal (₱)</label><input name="avMin" type="number" min="0" value="${vip.autoVoucher?.minSubtotal ?? 1000}" /></div><div class="small muted" style="align-self:end">Code is valid 30 days, 1 use, hourly rooms only. Staff can also give one from the Counter.</div></div>
            <label class="check" style="margin-top:8px"><input type="checkbox" name="otEnabled" ${vip.overtime?.enabled ? "checked" : ""}/> ⏱ Overtime penalty when exceeding booked hours (counted in minutes, not seconds)</label>
            <div class="form3">
              <div><label>First block (minutes)</label><input name="otFirstMin" type="number" min="1" value="${vip.overtime?.firstMinutes ?? 5}" /></div>
              <div><label>Fee for first block (₱)</label><input name="otFirstFee" type="number" min="0" value="${vip.overtime?.firstFee ?? 10}" /></div>
              <div><label>Per minute after that (₱)</label><input name="otPerMin" type="number" min="0" value="${vip.overtime?.perMinute ?? 2}" /></div>
            </div>
            <p class="small muted">e.g. 1–5 min over = ₱10; 8 min over = ₱10 + 3 × ₱2 = ₱16. This also appears in the booking policy and waiver. When enabled, per-hour rooms are <b>no longer rounded up to the full hour</b> — booked hours + penalty only.</p>
            <div class="row between" style="margin-top:10px"><label style="margin:0">Rooms (<span id="roomCount">${(vip.rooms || []).length}</span>)</label><button class="btn ghost sm" type="button" id="addRoom">+ Room</button></div>
            <div id="roomList" class="editlist"></div>
          </div>
        </div>
      </div>` : ""}

      <div class="tile">
        <h3>🖨 Printing <span class="small muted" style="font-weight:500">— optional; the customer's status page is the digital receipt</span></h3>
        <label class="check big"><input type="checkbox" name="prEnabled" ${s.printing?.enabled ? "checked" : ""}/> Enable printing buttons (receipts, bills${mode === "laundry" ? ", claim stubs" : ", kitchen tickets"})</label>
        <div class="featbody">
        <p class="small muted">Prints through the browser to any printer installed on the counter device (LAN / WiFi / USB thermal, 58 or 80 mm). <b>One-tap printing on Windows:</b> open the counter in Chrome with <code>chrome.exe --kiosk-printing --app=https://YOUR-SITE/counter/</code> and set the thermal printer as the default printer — no print dialog.</p>
        <div class="form3">
          <div><label>Paper width</label><select name="prPaper"><option value="58" ${String(s.printing?.paper || 58) === "58" ? "selected" : ""}>58 mm</option><option value="80" ${String(s.printing?.paper) === "80" ? "selected" : ""}>80 mm</option></select></div>
          <div><label>Header lines (TIN, address 2…)</label><input name="prHeader" value="${esc(s.printing?.header || "")}" placeholder="e.g. TIN 000-000-000" /></div>
          <div><label>Footer</label><input name="prFooter" value="${esc(s.printing?.footer || "Thank you!")}" /></div>
        </div>
        <label class="check"><input type="checkbox" name="prLogo" ${s.printing?.logo ? "checked" : ""}/> Print logo on top (slower on cheap printers)</label>
        <label class="check"><input type="checkbox" name="prAutoOrder" ${s.printing?.autoOrder ? "checked" : ""}/> Auto-print a receipt when the counter creates an order</label>
        <label class="check"><input type="checkbox" name="prAutoPaid" ${s.printing?.autoPaid ? "checked" : ""}/> Auto-print a receipt when an order is marked paid</label>
        ${mode === "laundry" ? `<label class="check"><input type="checkbox" name="prAutoStub" ${s.printing?.autoStub !== false ? "checked" : ""}/> Auto-print the claim stub when a job is created</label>` : `<label class="check"><input type="checkbox" name="prKitchen" ${s.printing?.kitchenTicket ? "checked" : ""}/> Kitchen ticket button (no prices) on counter &amp; kitchen cards</label>`}
        </div>
      </div>

      <div class="tile">
        <h3>✈️ Telegram alerts ${lock("telegram")}</h3>
        <p class="small muted">Get alerts on your phone when you're away from the store — new orders, customer calls, reservations, incidents. Telegram is free; just create your own bot (takes 2 minutes).</p>
        <label class="check big"><input type="checkbox" name="tgEnabled" ${tg.enabled ? "checked" : ""}/> Enable Telegram alerts</label>
        <div class="featbody">
          <ol class="small muted" style="line-height:1.7;padding-left:20px;margin:0 0 10px">
            <li>In Telegram, search for <b>@BotFather</b> → send <code>/newbot</code> → follow the prompts (name, username ending in <i>bot</i>).</li>
            <li>Copy the <b>token</b> (e.g. <code>123456789:AAH…</code>) and paste it here → <b>Save token</b>.</li>
            <li>Open your bot in Telegram → tap <b>Start</b> → send any text (e.g. "hi"). You can also add the bot to a managers' <b>group</b> and send from there.</li>
            <li>Tap <b>Detect chat</b> → then <b>Send test</b>.</li>
          </ol>
          <div class="row wrap" style="gap:8px;align-items:flex-end">
            <div style="flex:1;min-width:240px"><label>Bot token</label><input name="tgToken" placeholder="123456789:AAH…" autocomplete="off"/></div>
            <button class="btn ghost sm" type="button" id="tgSave">Save token</button>
            <button class="btn ghost sm" type="button" id="tgDetect">Detect chat</button>
            <button class="btn ghost sm" type="button" id="tgTest">Send test</button>
          </div>
          <p class="small muted" id="tgStatus" style="margin:6px 0 10px">Checking…</p>
          <label style="margin-top:6px">Which alerts</label>
          <label class="check"><input type="checkbox" name="tgNewOrder" ${tg.events?.newOrder !== false ? "checked" : ""}/> 🧾 New order</label>
          <label class="check"><input type="checkbox" name="tgCall" ${tg.events?.callStaff !== false ? "checked" : ""}/> 🔔 Customer call (call staff)</label>
          <label class="check"><input type="checkbox" name="tgResv" ${tg.events?.reservation !== false ? "checked" : ""}/> 📅 New reservation / booking</label>
          <label class="check"><input type="checkbox" name="tgInc" ${tg.events?.incident !== false ? "checked" : ""}/> ⚠️ Incident report</label>
          <label class="check"><input type="checkbox" name="tgShift" ${tg.events?.shiftVariance !== false ? "checked" : ""}/> 💰 Shift closed with cash variance beyond tolerance</label>
          <label class="check"><input type="checkbox" name="tgDaily" ${tg.events?.daily !== false ? "checked" : ""}/> 📊 Daily summary at 9 PM (sales, clients, no-shows, things to check, tomorrow)</label>
          <div class="form2" style="margin-top:8px">
            <div><label>Quiet hours — from (no alerts)</label><input name="tgQuietFrom" type="time" value="${esc(tg.quietFrom || "")}"/></div>
            <div><label>Until</label><input name="tgQuietTo" type="time" value="${esc(tg.quietTo || "")}"/></div>
          </div>
        </div>
      </div>

      <div class="tile">
        <h3>📱 SMS promos — Semaphore ${lock("sms")}</h3>
        <p class="small muted">Customers tick "send me promos via text" on the status page → their number is saved → you can send batch texts from the <b>Customers</b> tab. Requires your own <a href="https://semaphore.co" target="_blank">Semaphore</a> account (₱0.50–1 per SMS; you load the credits).</p>
        <label class="check big"><input type="checkbox" name="smsEnabled" ${sms.enabled ? "checked" : ""}/> Enable SMS promos (opt-in checkbox for customers)</label>
        <div class="featbody">
          <ol class="small muted" style="line-height:1.7;padding-left:20px;margin:0 0 10px">
            <li>Create an account at <b>semaphore.co</b> → load credits (GCash/bank).</li>
            <li>In the Semaphore dashboard → <b>API</b> → copy the <b>API key</b> → paste it here → <b>Save key</b>.</li>
            <li>Optional: apply for a <b>Sender Name</b> in Semaphore (e.g. KAPEHAN; approval takes 3–5 days). Until then, "SEMAPHORE" appears as the sender.</li>
          </ol>
          <div class="row wrap" style="gap:8px;align-items:flex-end">
            <div style="flex:1;min-width:240px"><label>Semaphore API key</label><input name="semKey" placeholder="paste API key" autocomplete="off"/></div>
            <button class="btn ghost sm" type="button" id="semSave">Save key</button>
            <input name="semTestNum" placeholder="09XXXXXXXXX" style="max-width:150px"/><button class="btn ghost sm" type="button" id="semTest">Send test</button>
          </div>
          <p class="small muted" id="semStatus" style="margin:6px 0 10px">Checking…</p>
          <div class="form2">
            <div><label>Sender name (approved in Semaphore; blank = SEMAPHORE)</label><input name="smsSender" maxlength="11" value="${esc(sms.senderName || "")}" placeholder="e.g. KAPEHAN"/></div>
            <div><label>Opt-in text shown to customers</label><input name="smsOptText" maxlength="80" value="${esc(sms.optInText || "")}" placeholder="Send me promos and updates via text"/></div>
            <div><label>Quiet hours — from (no sending)</label><input name="smsQuietFrom" type="time" value="${esc(sms.quietFrom || "21:00")}"/></div>
            <div><label>Until</label><input name="smsQuietTo" type="time" value="${esc(sms.quietTo || "08:00")}"/></div>
          </div>
          <p class="small muted">Limit: 1 campaign per day, max 1,000 recipients. Only opted-in customers receive messages (Data Privacy Act). Blocked customers are excluded.</p>
        </div>
      </div>

      <div class="tile">
        <div class="row between wrap"><div><h3>Payment methods</h3><p class="small muted">Customers choose one for pickup/delivery; also used at the counter. For GCash/Maya, upload the QR and number — customers enter a reference no., and staff verify it.</p></div><button class="btn sm" type="button" id="addPay">+ Add method</button></div>
        <div id="payList" class="editlist"></div>
      </div>

      ${mode === "stay" ? (() => { const st = s.stay || {}; const pl = st.pool || {}; const ex = st.extension || {}; const wk = st.weekendNights || ["fri", "sat"]; return `
      <div class="tile">
        <h3>🏡 Stay settings</h3>
        <div class="form2">
          <div><label>Check-in time</label><input name="stIn" type="time" value="${esc(st.checkIn || "14:00")}"/></div>
          <div><label>Check-out time</label><input name="stOut" type="time" value="${esc(st.checkOut || "12:00")}"/></div>
          <div><label>Downpayment (% of total)</label><input name="stDown" type="number" min="0" max="100" value="${st.downPct ?? 50}"/></div>
          <div><label>Max nights per booking</label><input name="stMaxN" type="number" min="1" value="${st.maxNights ?? 14}"/></div>
          <div class="span2"><label class="check"><input type="checkbox" name="stPayFirst" ${st.payFirst ? "checked" : ""}/> 💵 Pay first — the guest must be <b>fully paid</b> before check-in</label></div>
          <div class="span2"><label>Weekend-price nights</label><div class="row wrap">${[["sun", "Sun"], ["mon", "Mon"], ["tue", "Tue"], ["wed", "Wed"], ["thu", "Thu"], ["fri", "Fri"], ["sat", "Sat"]].map(([k, l]) => `<label class="check small" style="margin:0 10px 0 0"><input type="checkbox" data-wk="${k}" ${wk.includes(k) ? "checked" : ""}/> ${l} night</label>`).join("")}</div></div>
          <div class="span2"><label>Holiday dates (weekend price) — comma-separated YYYY-MM-DD</label><input name="stHol" value="${esc((st.holidays || []).join(", "))}" placeholder="2026-12-24, 2026-12-25, 2026-12-31"/></div>
          <div class="span2"><label class="check"><input type="checkbox" name="stExt" ${ex.enabled !== false ? "checked" : ""}/> ⏱ Guests can request to extend (auto-declined if the room is booked right after)</label></div>
          <div class="span2"><label class="check"><input type="checkbox" name="stRem" ${st.reminders === true ? "checked" : ""}/> 📱 Text guests a reminder the evening before check-in <span class="muted small">(uses your SMS credits · needs SMS set up · guests can turn it off)</span></label></div>
          <div><label>Extension price per hour (₱)</label><input name="stExtP" type="number" min="0" value="${ex.pricePerHour ?? 300}"/></div>
          <div><label>Max extension (hours)</label><input name="stExtH" type="number" min="1" value="${ex.maxHours ?? 6}"/></div>
          <div class="span2" style="border-top:1px solid var(--line);padding-top:10px"><label class="check"><input type="checkbox" name="stShort" ${st.short?.enabled ? "checked" : ""}/> ⏳ <b>Short stays (hour packages)</b> — sell 3 / 6 / 12-hour stays on days nobody booked the whole night</label></div>
          ${[1, 3, 6, 12].map((h) => { const pk = (st.short?.packages || []).find((x) => x.hours === h); return `<div><label>${h}-hour price (₱, blank = not offered)</label><input name="stSh${h}" type="number" min="0" value="${pk?.price ?? ""}" placeholder="${h === 1 ? "e.g. 399" : h === 3 ? "e.g. 999" : h === 6 ? "e.g. 1,599" : "e.g. 2,299"}"/></div>`; }).join("")}
          <div class="span2"><label class="check"><input type="checkbox" name="stShTimer" ${st.short?.timerOnArrival !== false ? "checked" : ""}/> ⏱ The clock starts when the guest is in the room (you or the caretaker tap "Guest arrived", or the guest self checks in) — never later than the booked time + grace</label></div>
          <div><label>Grace for late arrival (min)</label><input name="stShGrace" type="number" min="0" max="60" value="${st.short?.graceMin ?? 15}"/></div>
          <div><label>Earliest start</label><input name="stShFrom" type="time" value="${esc(st.short?.from || "08:00")}"/></div>
          <div><label>Latest start</label><input name="stShTo" type="time" value="${esc(st.short?.until || "20:00")}"/></div>
          <div><label>Cleaning time between guests (min)</label><input name="stShBuf" type="number" min="0" max="240" value="${st.short?.bufferMin ?? 60}"/></div>
          <p class="small muted span2" style="margin:0">Each room can have its own hour prices in Rooms. A short stay is blocked automatically if it would overlap an overnight booking (plus cleaning time).</p>
          <div class="span2" style="border-top:1px solid var(--line);padding-top:10px"><b>🏊 Amenities</b><p class="small muted" style="margin:2px 0 6px">Pool, videoke, PS5 / PSP games, billiards, grill… Free or paid (per head, per hour or per stay). Paid ones are added to the guest's bill when they pick them while booking.</p><div id="stAmen"></div></div>
          <div class="span2" style="border-top:1px solid var(--line);padding-top:10px"><b>📍 Nearby places</b><p class="small muted" style="margin:2px 0 6px">e.g. hospital, SM / mall, Jollibee, church, beach — with minutes away. Shown on your page.</p><div id="stNear"></div></div>
          <div class="span2" style="border-top:1px solid var(--line);padding-top:10px"><b>👨‍👩‍👧 Guests &amp; IDs</b></div>
          <div><label>Kids below this age are free</label><input name="stKidAge" type="number" min="0" max="17" value="${st.kids?.freeUnder ?? 7}"/></div>
          <div><label class="check" style="margin-top:28px"><input type="checkbox" name="stKidPax" ${st.kids?.countInPax ? "checked" : ""}/> Kids count toward the room's max guests</label></div>
          <div class="span2"><label class="check"><input type="checkbox" name="stNoId" ${st.noIdOk !== false ? "checked" : ""}/> Guests without a valid ID can still book — you decide (the booking waits for your OK)</label></div>
          <div class="span2" style="border-top:1px solid var(--line);padding-top:10px"><b>↩️ Cancellation refund</b><p class="small muted" style="margin:2px 0 6px">Leave at 0 for no refund. Example: full refund 7+ days before, 50% refund 3+ days before.</p></div>
          <div><label>Full refund if cancelled … days before (0 = never)</label><input name="stCxFull" type="number" min="0" value="${st.cancel?.fullDays ?? 0}"/></div>
          <div><label>Partial refund … days before</label><input name="stCxPart" type="number" min="0" value="${st.cancel?.partialDays ?? 0}"/></div>
          <div><label>Partial refund (%)</label><input name="stCxPct" type="number" min="0" max="100" value="${st.cancel?.partialPct ?? 50}"/></div>
          <div class="span2" style="border-top:1px solid var(--line);padding-top:10px"><label class="check"><input type="checkbox" name="stLast" ${st.lastMinute?.enabled ? "checked" : ""}/> 🌙 <b>Tonight's deal</b> — a room still empty tonight gets a discount after a set time</label></div>
          <div><label>Discount (%)</label><input name="stLastP" type="number" min="1" max="80" value="${st.lastMinute?.percent ?? 20}"/></div>
          <div><label>Starts at</label><input name="stLastT" type="time" value="${esc(st.lastMinute?.after || "18:00")}"/></div>
          <div class="span2" style="border-top:1px solid var(--line);padding-top:10px"><label>📜 House rules (guests accept these when booking)</label><textarea name="stRules" rows="4" placeholder="e.g. Quiet time 10 PM. No parties. Max 2 visitors until 9 PM. No smoking inside.">${esc(st.houseRules || "")}</textarea></div>
          <div class="span2"><label class="check"><input type="checkbox" name="stVisit" ${st.visitorLog ? "checked" : ""}/> 👥 Visitor log — guests list their visitors on their booking page (you're notified)</label></div>
          <div class="span2"><label class="check"><input type="checkbox" name="stIcalShort" ${st.ical?.exportShort !== false ? "checked" : ""}/> 📅 Send hour packages to Airbnb / Booking.com too (they block the whole day there)</label></div>
          <div class="span2" style="border-top:1px solid var(--line);padding-top:10px"><b>🛏 Add-ons guests can request when booking</b><p class="small muted" style="margin:2px 0 6px">Extra bed foam, blankets, pillows, towels — and amenity kits (toothbrush, soap, slippers, toothpaste, condoms…). Turn on "Needs OK" for items with limited stock: you approve if available. Your cleaner sees what to prepare.</p><div id="stAddons"></div></div>
          <div class="span2" style="border-top:1px solid var(--line);padding-top:10px"><b>🔐 Security deposit</b><p class="small muted" style="margin:2px 0 6px">Refundable. At check-out the cleaner counts the room's items and photographs stains or damage — deductions come out of the deposit, the rest goes back to the guest. Set each room's item list in Rooms.</p></div>
          <div><label>Deposit (₱, 0 = none)</label><input name="stDep" type="number" min="0" value="${st.deposit?.amount ?? 0}"/></div>
          <div><label>Room check within (minutes after check-out)</label><input name="stDepMin" type="number" min="15" max="720" value="${st.deposit?.checkMinutes ?? 60}"/></div>
          <p class="small muted span2" style="margin:0">If nobody checks the room in time, the guest sees "full refund" — fair to both sides.</p>
          <div class="span2"><label class="check"><input type="checkbox" name="stGuestIds" ${st.guestIds ? "checked" : ""}/> 🪪 Every guest uploads a valid ID (not just the one booking)</label></div>
          <div class="span2" style="border-top:1px solid var(--line);padding-top:10px"><label class="check"><input type="checkbox" name="stSelf" ${st.selfCheck?.enabled ? "checked" : ""}/> 🔑 <b>Self check-in / check-out</b> (smart lock) — the guest sees the door code only when the booking is confirmed, the downpayment is verified and the deposit is paid</label></div>
          <div><label>Show the door code (hours before check-in)</label><input name="stCodeH" type="number" min="0" max="24" value="${st.selfCheck?.codeHoursBefore ?? 2}"/></div>
          <p class="small muted" style="margin:0;align-self:end">Set the code per room in Rooms. Change it there anytime — guests always see the current one.</p>
          <div class="span2" style="border-top:1px solid var(--line);padding-top:10px"><label class="check"><input type="checkbox" name="stOver" ${st.overstay?.enabled !== false ? "checked" : ""}/> ⏰ <b>Overstay charge</b> — past check-out, each started hour is charged (taken from the deposit). Guests must tick that they understand it before booking.</label></div>
          <div><label>Overstay fee per hour (₱, blank = extension rate)</label><input name="stOverR" type="number" min="0" value="${st.overstay?.ratePerHour || ""}"/></div>
          <div><label>Grace period (minutes)</label><input name="stOverG" type="number" min="0" max="120" value="${st.overstay?.graceMin ?? 15}"/></div>
          <div class="span2" style="border-top:1px solid var(--line);padding-top:10px"><b>🧹 Cleaning between guests</b><p class="small muted" style="margin:2px 0 6px">Short stays keep this gap free on the calendar. Your caretaker taps “Finished cleaning” (or “Skip”) — you see when each room became ready, and the next guest sees “Your room is ready”. It never blocks a booking.</p></div>
          <div><label>Cleaning time (minutes)</label><input name="stClean" type="number" min="0" max="480" value="${st.cleaning?.minutes ?? 60}"/></div>
          <div><label class="check" style="margin-top:26px"><input type="checkbox" name="stCleanShow" ${st.cleaning?.showGuests !== false ? "checked" : ""}/> Show guests when their room is being cleaned / ready</label></div>
          <div class="span2" style="border-top:1px solid var(--line);padding-top:10px"><b>🏷️ Promos for slow days &amp; hours</b><p class="small muted" style="margin:2px 0 6px">e.g. "Weekday 20% off" (Mon–Thu nights) or "Morning short stay 15% off" (8 AM–12 NN). Guests see them on your page, upcoming ones too. The best one applies — no stacking.</p><div id="stPromos"></div></div>
          <div class="span2" style="border-top:1px solid var(--line);padding-top:10px"><label class="check"><input type="checkbox" name="stLoy" ${st.loyalty?.enabled ? "checked" : ""}/> 🎁 <b>Loyalty card</b> — every few stays, the guest gets a discount</label></div>
          <div><label>Every … stays</label><input name="stLoyN" type="number" min="2" value="${st.loyalty?.every ?? 5}"/></div>
          <div><label>Discount on that stay (%)</label><input name="stLoyP" type="number" min="1" max="100" value="${st.loyalty?.percent ?? 20}"/></div>
          <div class="span2"><label class="check"><input type="checkbox" name="stId" ${st.requireId === true ? "checked" : ""}/> 🪪 Require a valid ID photo when booking</label></div>
          <div class="span2"><label>House policy (shown when booking — include your no-refund rule)</label><textarea name="stPolicy" rows="6">${esc(st.policy || "")}</textarea></div>
          <div class="span2"><label>Waiver text (guest signs this)</label><textarea name="stWaiver" rows="4">${esc(s.waiver?.text || "")}</textarea></div>
        </div>
        <p class="small muted">Front desk = the <b>Counter</b> screen (role "Front desk"). Caretakers use the <b>Caretaker app</b> (role "Caretaker") and get a chime when a guest checks out.</p>
      </div>`; })() : ""}
      ${mode === "table" || mode === "salon" || mode === "stay" ? `
      <div class="tile">
        <h3>${mode === "salon" || mode === "stay" ? "Booking confirmation via Messenger" : "Confirmation before preparing (pickup / delivery)"}</h3>
        <p class="small muted">To prevent fake orders: customers must message you before the order is sent to the kitchen.</p>
        <div class="form2">
          <div><label>Mode</label><select name="cfMode"><option value="off" ${(cf.mode || "messenger") === "off" ? "selected" : ""}>Off — straight to the counter</option><option value="messenger" ${(cf.mode || "messenger") === "messenger" ? "selected" : ""}>Messenger — customer must message first (recommended)</option></select></div>
          <div><label>Auto-cancel if not confirmed (minutes)</label><input name="cfMinutes" type="number" min="5" value="${cf.minutes ?? 60}" /></div>
          <div class="span2"><label>Messenger link of your page (e.g. https://m.me/yourpage)</label><input name="cfLink" value="${esc(cf.messengerLink || "")}" placeholder="https://m.me/yourpage" /></div>
        </div>
        <label class="check"><input type="checkbox" name="cfSkip" ${cf.skipReturning !== false ? "checked" : ""}/> Skip confirmation for returning customers (phone number has a completed order)</label>
      </div>` : ""}

      <div class="tile">
        <h3>Business hours</h3>
        <p class="small muted">Set when customers can order. Leave every day as <b>Open 24 hours</b> if you don't want a schedule.</p>
        <div class="hrs">
          ${DAYS.map(([k, n]) => { const h = hours[k] || []; const state = !Object.keys(hours).length || (h[0] === "00:00" && h[1] === "23:59" && !h[2]) ? "24h" : !h.length ? "closed" : "open"; return `<div class="hrs-row" data-day="${k}">
            <div class="hrs-day">${n}</div>
            <select class="hrs-state" data-state="${k}"><option value="open" ${state === "open" ? "selected" : ""}>Open</option><option value="closed" ${state === "closed" ? "selected" : ""}>Closed</option><option value="24h" ${state === "24h" ? "selected" : ""}>Open 24 hours</option></select>
            <div class="hrs-times" ${state !== "open" ? 'style="display:none"' : ""}>
              <span class="hrs-range"><input type="time" name="${k}_open" value="${esc(h[0] || "08:00")}" /> <span class="muted">to</span> <input type="time" name="${k}_close" value="${esc(h[1] || "20:00")}" /></span>
              <span class="hrs-range hrs-2" ${h[2] ? "" : 'style="display:none"'}><span class="muted">and</span> <input type="time" name="${k}_open2" value="${esc(h[2] || "")}" /> <span class="muted">to</span> <input type="time" name="${k}_close2" value="${esc(h[3] || "")}" /> <button type="button" class="btn ghost sm" data-rm2="${k}" title="Remove">✕</button></span>
              <button type="button" class="btn ghost sm hrs-add" data-add2="${k}" ${h[2] ? 'style="display:none"' : ""}>+ break / 2nd shift</button>
              <div class="small hrs-note" style="width:100%;color:var(--brand,#2563eb)"></div>
            </div>
          </div>`; }).join("")}
        </div>
        <div class="row wrap" style="gap:8px;margin-top:10px"><button type="button" class="btn ghost sm" id="hrsCopy">Copy Monday to all days</button></div>
        <p class="small muted" style="margin-top:8px">Open past midnight? Set the closing time earlier than the opening time — e.g. <b>6:00 PM to 2:00 AM</b>. A 2nd shift that starts after midnight (e.g. <b>8 AM–8 PM and 12 AM–11 AM</b>) is the <b>next morning</b>: Friday's 12 AM shift = Saturday 12 AM–11 AM.</p>
        <div class="form2" style="margin-top:10px">
          <div><label class="check" style="margin-top:22px"><input type="checkbox" name="vatReg" ${s.vatRegistered ? "checked" : ""}/> VAT-registered (12% VAT) <span class="small muted">— for the senior / PWD discount</span></label></div>
          <div><label>Your day ends at (for reports &amp; order numbers)</label><select name="dayCutoff">${["00:00", "01:00", "02:00", "03:00", "04:00", "05:00", "06:00"].map((t) => `<option value="${t}" ${(s.businessDayCutoff || "00:00") === t ? "selected" : ""}>${t === "00:00" ? "Midnight (default)" : (Number(t.slice(0, 2))) + ":00 AM — for night shifts"}</option>`).join("")}</select><p class="small muted" style="margin:4px 0 0">Only change this if you're open past midnight: orders before this time count for the previous day.</p></div>
        </div>
      </div>

      <div class="tile">
        <h3>Shift close &amp; cash check</h3>
        <p class="small muted">Staff enter the counted cash and the totals per payment method <b>without seeing</b> the expected amounts (blind count). A manager then verifies with their PIN; any variance is recorded with an explanation and resolution.</p>
        <p class="small muted">🙈 Blind count is always on: the cashier enters what they counted without seeing the expected totals. Only the manager who checks the shift sees the difference.</p>
        <label class="check"><input type="checkbox" name="shPos" ${s.shifts?.externalPos ? "checked" : ""}/> We also use a separate POS — ask for its end-of-day (Z-reading) total to reconcile</label>
        <div class="form2">
          <div><label>End the shift automatically at</label><select name="shAuto"><option value="">Never</option>${["00:00", "01:00", "02:00", "03:00", "04:00", "05:00", "06:00"].map((t) => `<option value="${t}" ${(s.shifts?.autoEnd === false ? "" : s.shifts?.autoEndAt || (mode === "table" ? "03:00" : "")) === t ? "selected" : ""}>${t}</option>`).join("")}</select><p class="small muted" style="margin:4px 0 0">The next cashier counts the cash before a new shift can start. Staff can tap “Accept late orders” on the counter.</p></div>
          <div><label>Tolerance (₱) — variance within this is auto-verified</label><input name="shTol" type="number" min="0" value="${s.shifts?.tolerance ?? 20}" /></div>
          <div><label>Who can verify a shift</label><select name="shWho"><option value="manager" ${(s.shifts?.whoVerify || "manager") === "manager" ? "selected" : ""}>Managers only (PIN)</option><option value="any" ${s.shifts?.whoVerify === "any" ? "selected" : ""}>Any staff with PIN (incl. the same person on a solo shift)</option></select></div>
        </div>
      </div>

      <div class="tile">
        <div class="row between wrap">
          <div><h3>Staff & PINs</h3><p class="small muted">Employees who use the kitchen / barista / counter / rider screens. They pick their name and enter a <b>PIN</b> on the shared device. One person can have multiple roles.</p></div>
          <div class="row"><span id="limStaff"></span><button class="btn ghost sm" type="button" id="inviteStaff" title="Send a link — they set their own name and PIN">🔗 Invite link</button><button class="btn sm" type="button" id="addStaffPin">+ Add staff</button></div>
        </div>
        <div id="staffPinList" class="itemlist"></div>
        <div id="inviteList" style="margin-top:10px"></div>
        <div class="tile" style="margin-top:14px;background:var(--surface-2,#F7F7F8)">
          <div class="row between wrap">
            <div><h4 style="margin:0">Tablets &amp; shared devices</h4><p class="small muted">Give each counter / kitchen tablet its own <b>device login</b>. Staff then use their PIN. A device can never open this dashboard — so your sales and settings stay private even if someone picks up the tablet.</p></div>
            <button class="btn sm" type="button" id="deviceCode">Set up a tablet</button>
          </div>
          <div id="deviceList" class="itemlist" style="margin-top:8px"></div>
        </div>
        <div class="tile" style="margin-top:14px;background:var(--surface-2,#F7F7F8)" id="securityTile">
          <div class="row between wrap">
            <div><h4 style="margin:0">Owner login security</h4><p class="small muted">Browsers you have logged in from. With <b>2-step</b> on, a login from a new browser must be confirmed through a link sent to your email.</p></div>
            <label class="check" style="white-space:nowrap"><input type="checkbox" id="twoStep"/> Require 2-step on new browsers</label>
          </div>
          <div id="trustedList" class="itemlist" style="margin-top:8px"><p class="small muted">Loading…</p></div>
          <p class="small muted" style="margin-top:8px">🔒 Your email is the master key: anyone who controls it can reset your password. Turn on 2-step verification in your email account too (Gmail → Manage your Google Account → Security).</p>
          <div class="row between wrap" style="margin-top:8px"><span class="small muted">Lost a phone or shared your password? Log out every session.</span><button class="btn ghost sm danger" type="button" id="logoutAll">Log out everywhere</button></div>
        </div>
        <details style="margin-top:14px"><summary class="small muted" style="cursor:pointer">Device login accounts (advanced)</summary>
          <p class="small muted" style="margin-top:8px">Email/password used to log in on the device itself (e.g. the kitchen tablet). This is only needed once; after that, staff use their PIN. You can also use your own email on the device.</p>
          <div class="row between wrap"><span></span><button class="btn ghost sm" type="button" id="addStaff">+ Add device login</button></div>
          <div id="staffList" class="itemlist"></div>
        </details>
      </div>

      <div class="row between">
        <span class="small muted">Business type: <b>${esc(store.businessType)}</b> (mode: ${esc(mode)}) — cannot be changed after creation.</span>
        <button class="btn" type="submit" id="saveBtn">Save settings</button>
      </div>
    </form>`;
  organizeSettings(root, mode, opts);

  const form = root.querySelector("#settingsForm");
  // ---- store link (slug) ----
  {
    const inp = root.querySelector("#slugInput"), btn = root.querySelector("#slugSave"), msg = root.querySelector("#slugMsg");
    const clean = (v) => v.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 40);
    let timer = null, seq = 0;
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); if (!btn.disabled) btn.click(); } });
    inp.oninput = () => {
      const v = clean(inp.value); if (v !== inp.value) inp.value = v;
      const final = v.replace(/-+$/, "");
      btn.disabled = true; clearTimeout(timer);
      if (final === store.slug) { msg.innerHTML = `<span class="muted">This is your current link.</span>`; return; }
      if (final.length < 3) { msg.innerHTML = `<span class="danger-text">At least 3 letters or numbers.</span>`; return; }
      msg.innerHTML = `<span class="muted">Checking…</span>`;
      const my = ++seq;
      timer = setTimeout(async () => {
        try { const r = await call("checkSlug", { slug: final }); if (my !== seq) return;
          msg.innerHTML = r.ok ? `<span style="color:var(--ok)">✓ Available: <b>${esc(location.host)}/m/${esc(r.slug)}</b></span>` : `<span class="danger-text">✕ ${esc(r.reason)}</span>`; btn.disabled = !r.ok; }
        catch (e) { if (my === seq) msg.innerHTML = `<span class="danger-text">${esc(e.message)}</span>`; }
      }, 450);
    };
    btn.onclick = async () => {
      const final = clean(inp.value).replace(/-+$/, "");
      if (!(await confirmDialog(`Change your customer link to ${location.host}/m/${final}? The old link will forward to the new one.`))) return;
      btn.disabled = true; btn.textContent = "Saving…";
      try { const r = await call("changeSlug", { slug: final }); toast("Link updated"); store.slug = r.slug; inp.value = r.slug; msg.innerHTML = `<span style="color:var(--ok)">✓ Your link is now <b>${esc(location.host)}/m/${esc(r.slug)}</b></span>`; reload?.(); }
      catch (e) { toast(e.message, "error"); btn.disabled = false; }
      btn.textContent = "Save link";
    };
  }
  const v = (n) => form.querySelector(`[name=${n}]`);

  // ---------- packages & rooms editors (table mode) ----------
  let packages = JSON.parse(JSON.stringify(ev.packages || []));
  let rooms = JSON.parse(JSON.stringify(vip.rooms || []));
  const uid = () => Math.random().toString(36).slice(2, 8);
  const stRows = {};
  function drawPkgs() {
    const el = root.querySelector("#pkgList"); if (!el) return;
    el.innerHTML = packages.length ? "" : `<p class="small muted">No packages yet.</p>`;
    packages.forEach((p, i) => {
      const row = html(`<div class="editrow">
        <input placeholder="Package name" value="${esc(p.name)}" data-k="name" style="flex:2" />
        <input type="number" min="0" placeholder="Price" value="${p.price ?? ""}" data-k="price" style="width:100px" />
        <select data-k="pricing" style="width:110px"><option value="head" ${p.pricing !== "flat" ? "selected" : ""}>per head</option><option value="flat" ${p.pricing === "flat" ? "selected" : ""}>flat</option></select>
        <input type="number" min="0" placeholder="Min pax" value="${p.minPax ?? ""}" data-k="minPax" style="width:90px" />
        <input placeholder="Inclusions (optional)" value="${esc(p.description || "")}" data-k="description" style="flex:3" />
        <button class="btn ghost sm" type="button" data-del>✕</button></div>`);
      row.querySelectorAll("[data-k]").forEach((inp) => (inp.oninput = () => (p[inp.dataset.k] = inp.value)));
      row.querySelector("[data-del]").onclick = () => { packages.splice(i, 1); drawPkgs(); };
      el.appendChild(row);
    });
  }
  function drawRooms() {
    const el = root.querySelector("#roomList"); if (!el) return;
    el.innerHTML = rooms.length ? "" : `<p class="small muted">No rooms yet. Click "+ Room".</p>`;
    root.querySelector("#roomCount").textContent = rooms.length;
    rooms.forEach((r, i) => {
      const row = html(`<div class="editrow">
        <input placeholder="Room name (e.g. VIP 1)" value="${esc(r.name)}" data-k="name" style="flex:2" />
        <input type="number" min="1" placeholder="Capacity" value="${r.capacity ?? ""}" data-k="capacity" style="width:100px" />
        <select data-k="pricing" style="width:150px"><option value="hour" ${(r.pricing || "hour") === "hour" ? "selected" : ""}>Per hour</option><option value="consumable" ${r.pricing === "consumable" ? "selected" : ""}>Consumable (min spend)</option><option value="hour_consumable" ${r.pricing === "hour_consumable" ? "selected" : ""}>Per hour, consumable</option></select>
        <input type="number" min="0" placeholder="₱/hour" value="${r.ratePerHour ?? ""}" data-k="ratePerHour" style="width:90px" title="Room rate per hour" />
        <input type="number" min="0" placeholder="Min spend ₱" value="${r.minSpend ?? ""}" data-k="minSpend" style="width:110px" title="Minimum consumable" />
        <input type="number" min="1" placeholder="Min hrs" value="${r.minHours ?? 1}" data-k="minHours" style="width:80px" />
        <input placeholder="Description (optional)" value="${esc(r.description || "")}" data-k="description" style="flex:3" />
        <button class="btn ghost sm" type="button" data-del>✕</button></div>`);
      row.querySelectorAll("[data-k]").forEach((inp) => (inp.oninput = () => (r[inp.dataset.k] = inp.value)));
      row.querySelector("[data-del]").onclick = () => { rooms.splice(i, 1); drawRooms(); };
      el.appendChild(row);
    });
  }
  root.querySelector("#addPkg")?.addEventListener("click", () => { packages.push({ id: uid(), name: "", price: "", pricing: "head", minPax: "" }); drawPkgs(); });
  root.querySelector("#addRoom")?.addEventListener("click", () => { rooms.push({ id: uid(), name: `VIP ${rooms.length + 1}`, capacity: 10, ratePerHour: "", minHours: 2 }); drawRooms(); });
  drawPkgs(); drawRooms();
  root.querySelector("#hsBaseMe")?.addEventListener("click", () => navigator.geolocation?.getCurrentPosition((p) => (root.querySelector("[name=hsBase]").value = `${p.coords.latitude.toFixed(5)},${p.coords.longitude.toFixed(5)}`), () => toast("Couldn't get your location", "error")));
  root.querySelectorAll("[data-sidejob]").forEach((b) => (b.onclick = () => {
    root.querySelector("[name=flSide]").value = b.dataset.sidejob; root.querySelectorAll("[data-sidejob]").forEach((x) => x.classList.toggle("ghost", x !== b));
    const P = { weekends: { sat: ["09:00", "18:00"], sun: ["09:00", "18:00"] }, evenings: { mon: ["18:00", "22:00"], tue: ["18:00", "22:00"], wed: ["18:00", "22:00"], thu: ["18:00", "22:00"], fri: ["18:00", "22:00"] }, "evenings & weekends": { mon: ["18:00", "22:00"], tue: ["18:00", "22:00"], wed: ["18:00", "22:00"], thu: ["18:00", "22:00"], fri: ["18:00", "22:00"], sat: ["09:00", "20:00"], sun: ["09:00", "20:00"] } }[b.dataset.sidejob];
    if (P) { sideHours = P; toast("Hours will be set when you save"); } else sideHours = null;
  }));
  root.querySelectorAll("[data-verif]").forEach((inp) => inp.addEventListener("change", async (e) => { const f = e.target.files?.[0]; if (!f) return; const exp = inp.closest(".row")?.querySelector("[data-vexp]")?.value || ""; if (inp.dataset.verif === "permit" && !exp) { e.target.value = ""; return toast("Enter the permit's “Valid until” date first", "error"); } try { toast("Uploading privately…"); const { uploadPrivateImage } = await import("../upload.js"); const url = await uploadPrivateImage(storeId, auth.currentUser.uid, f, { max: 1600, name: `verif_${inp.dataset.verif}_${Date.now()}` }); await call("verifySubmit", { kind: inp.dataset.verif, file: url, expires: exp, note: root.querySelector(`[data-vnote="${inp.dataset.verif}"]`)?.value || "" }); toast("Sent — we'll review it within 3 days. Only the badge shows on your page."); ctx.reload?.(); } catch (x) { toast(x.message, "error"); } }));
  root.querySelector("#xKyc")?.addEventListener("change", async (e) => { const f = e.target.files?.[0]; if (!f) return; try { toast("Uploading your ID…"); const { uploadPrivateImage } = await import("../upload.js"); const url = await uploadPrivateImage(storeId, auth.currentUser.uid, f, { max: 1600, name: "kyc_id" }); await call("creatorKyc", { idUrl: url }); toast("ID saved ✓ — you can take X-Deals"); e.target.closest("label").outerHTML = `<span class="pill ok">🪪 Valid ID on file</span>`; } catch (x) { toast(x.message, "error"); } });
  root.querySelector("#flVerify")?.addEventListener("click", async (e) => { e.target.disabled = true; try { const r = await call("creatorVerifyRequest", {}); toast(`Sent! Put ${r.code} in one of your bios for a day so we can check it's you.`); } catch (x) { toast(x.message, "error"); e.target.disabled = false; } });
  if (root.querySelector("#flPlat")) stRows.plat = rowsEditor(root.querySelector("#flPlat"), (s.salon || {}).freelance?.platforms || [], [{ k: "platform", label: "Platform", type: "select", options: [["TikTok", "TikTok"], ["Instagram", "Instagram"], ["YouTube", "YouTube"], ["Facebook", "Facebook"], ["X", "X"], ["Website", "Website"], ["Portfolio", "Portfolio"]] }, { k: "handle", label: "Handle", ph: "@you" }, { k: "followers", label: "Followers", ph: "120K" }, { k: "url", label: "Link", w: 2 }], { addLabel: "+ Add platform" });
  if (root.querySelector("#stAddons")) {
    const st0 = s.stay || {};
    stRows.addons = rowsEditor(root.querySelector("#stAddons"), st0.addons || [{ name: "Single bed foam", price: 300, per: "night", approval: true, kind: "extra", max: 2 }, { name: "Extra blanket", price: 100, per: "stay", approval: true, kind: "extra", max: 3 }, { name: "Toiletry kit (toothbrush, toothpaste, soap)", price: 80, per: "stay", kind: "kit", max: 6 }, { name: "Slippers", price: 50, per: "stay", kind: "kit", max: 6 }], [
      { k: "name", label: "Item", ph: "e.g. Extra pillow", w: 3 }, { k: "price", label: "Price ₱", type: "number" },
      { k: "per", label: "Charged", type: "select", options: [["stay", "per stay"], ["night", "per night"]] },
      { k: "max", label: "Max qty", type: "number" }, { k: "kind", label: "Type", type: "select", options: [["extra", "Extra item"], ["kit", "Amenity kit"]] },
      { k: "approval", label: "Needs OK", type: "check" }], { addLabel: "+ Add item" });
    stRows.amen = rowsEditor(root.querySelector("#stAmen"), st0.amenities || (st0.pool?.mode && st0.pool.mode !== "none" ? [{ name: "Swimming pool", unit: st0.pool.mode === "per_head" ? "head" : "free", price: st0.pool.price || 0 }] : []), [
      { k: "name", label: "Amenity", ph: "e.g. Videoke", w: 3 }, { k: "unit", label: "Price", type: "select", options: [["free", "Free"], ["head", "per head"], ["hour", "per hour"], ["stay", "per stay"]] }, { k: "price", label: "₱", type: "number" }, { k: "note", label: "Note (optional)", ph: "e.g. until 10 PM", w: 2 }], { addLabel: "+ Add amenity", presets: [["🏊 Pool", "Swimming pool", "head", 100], ["🎤 Videoke", "Videoke", "stay", 500], ["🎮 PS5 / PSP", "PS5 / PSP games", "hour", 100], ["🎱 Billiards", "Billiards", "hour", 100], ["🔥 Grill", "Grill / BBQ", "stay", 200], ["📺 Netflix", "Netflix", "free", 0], ["🛶 Kayak", "Kayak", "hour", 150], ["🏋️ Gym", "Gym", "free", 0]].map(([label, name, unit, price]) => ({ label, row: { name, unit, price } })) });
    stRows.near = rowsEditor(root.querySelector("#stNear"), st0.nearby || [], [
      { k: "kind", label: "Type", type: "select", options: [["🏥", "🏥 Hospital"], ["🛍️", "🛍️ Mall / shopping"], ["🍔", "🍔 Food"], ["⛪", "⛪ Church"], ["🏖️", "🏖️ Beach"], ["🏪", "🏪 Store"], ["💊", "💊 Pharmacy"], ["⛽", "⛽ Gas"], ["🚌", "🚌 Terminal"], ["📍", "📍 Other"]] },
      { k: "name", label: "Name", ph: "e.g. SM City", w: 3 }, { k: "mins", label: "Minutes away", type: "number" }, { k: "map", label: "Map link (optional)", w: 2 }], { addLabel: "+ Add place" });
    stRows.promos = rowsEditor(root.querySelector("#stPromos"), st0.promos || [], [
      { k: "name", label: "Promo name", ph: "Weekday 20% off", w: 2 }, { k: "percent", label: "% off", type: "number" },
      { k: "applies", label: "For", type: "select", options: [["both", "Nights & hours"], ["night", "Overnight"], ["short", "Hour packages"]] },
      { k: "days", label: "Days (none = every day)", type: "days" }, { k: "from", label: "Hours from", type: "time" }, { k: "until", label: "to", type: "time" },
      { k: "start", label: "Starts", type: "date" }, { k: "end", label: "Ends", type: "date" }], { addLabel: "+ Add promo" });
  }
  // toggle featbody visibility
  root.querySelectorAll(".feat").forEach((f) => { const cb = f.querySelector("input[type=checkbox]"); const sync = () => f.classList.toggle("off", !cb.checked); cb.onchange = sync; sync(); });

  // ---------- payment methods editor ----------
  let payMethods = JSON.parse(JSON.stringify(pay.methods || [{ id: "cash", type: "cash", name: "Cash / COD", enabled: true, forServices: [] }]));
  const SVC_OPTS = [["dine_in", "Dine-in"], ["take_out", "Take-out"], ["pickup", "Pickup"], ["delivery", "Delivery"]];
  function drawPay() {
    const el = root.querySelector("#payList");
    el.innerHTML = payMethods.length ? "" : `<p class="small muted">No payment methods yet.</p>`;
    payMethods.forEach((m, i) => {
      const row = html(`<div class="paym ${m.enabled === false ? "off" : ""}">
        <div class="row wrap">
          <label class="check" style="margin:0"><input type="checkbox" data-k="enabled" ${m.enabled !== false ? "checked" : ""}/></label>
          <select data-k="type" style="width:170px">${PAY_TYPES.map(([k, l]) => `<option value="${k}" ${m.type === k ? "selected" : ""}>${l}</option>`).join("")}</select>
          <input data-k="name" value="${esc(m.name)}" placeholder="Label (e.g. GCash)" style="flex:1;min-width:120px"/>
          <button class="btn ghost sm" type="button" data-del>✕</button>
        </div>
        ${["gcash", "maya", "bank", "custom"].includes(m.type) ? `<div class="row wrap" style="margin-top:6px">
          <input data-k="number" value="${esc(m.number || "")}" placeholder="${m.type === "bank" ? "Bank + account no." : "Number"}" style="flex:1;min-width:140px"/>
          <input data-k="accountName" value="${esc(m.accountName || "")}" placeholder="Account name" style="flex:1;min-width:120px"/>
          <label class="check" style="margin:0" title="One-tap GCash: customers just tap “I've sent”. Turn this on only if you want them to type the reference no. too."><input type="checkbox" data-k="askRef" ${m.askRef === true ? "checked" : ""}/> Ask ref no. on orders</label>
          ${mode !== "table" ? `<label class="check" style="margin:0" title="Bookings with a downpayment / reservation fee: the customer must type the reference no. or attach the screenshot."><input type="checkbox" data-k="askRefBookings" ${m.askRefBookings !== false ? "checked" : ""}/> Require ref no. / screenshot for booking DP</label>` : ""}
          <div class="row" style="gap:6px"><div class="imgprev" style="width:48px;height:48px" data-qr>${m.qrUrl ? `<img src="${esc(m.qrUrl)}" alt=""/>` : `<span class="small muted">QR</span>`}</div><input type="file" accept="image/*" data-qrfile style="width:150px;padding:4px"/></div>
        </div>` : ""}
        <div class="row wrap small" style="margin-top:6px"><span class="muted">Available for:</span>${SVC_OPTS.map(([k, l]) => `<label class="check small" style="margin:0 8px 0 0"><input type="checkbox" data-svc="${k}" ${!m.forServices?.length || m.forServices.includes(k) ? "checked" : ""}/> ${l}</label>`).join("")}</div>
      </div>`);
      row.querySelectorAll("[data-k]").forEach((inp) => (inp.onchange = inp.oninput = () => { m[inp.dataset.k] = inp.type === "checkbox" ? inp.checked : inp.value; if (inp.dataset.k === "type") drawPay(); }));
      row.querySelectorAll("[data-svc]").forEach((c) => (c.onchange = () => { const all = [...row.querySelectorAll("[data-svc]")]; const on = all.filter((x) => x.checked).map((x) => x.dataset.svc); m.forServices = on.length === all.length ? [] : on; }));
      row.querySelector("[data-qrfile]")?.addEventListener("change", async (e) => { const f = e.target.files[0]; if (!f) return; try { m.qrUrl = await uploadImage(storeId, `pay-${m.id}`, f, { max: 800 }); row.querySelector("[data-qr]").innerHTML = `<img src="${m.qrUrl}" alt=""/>`; toast("QR uploaded"); } catch (err) { toast(err.message, "error"); } });
      row.querySelector("[data-del]").onclick = () => { payMethods.splice(i, 1); drawPay(); };
      el.appendChild(row);
    });
  }
  // --- Telegram buttons
  const tgStat = root.querySelector("#tgStatus");
  const tgRefresh = async () => { try { const r = await call("telegramStatus"); tgStat.innerHTML = r.hasToken ? `Bot: <b>@${esc(r.botName)}</b> ✓ · Chat: ${r.chatId ? `<b>${esc(r.chatTitle || r.chatId)}</b> ✓ — ready` : `<span style="color:#b4423a">not set — tap Detect chat</span>`}` : "No bot token yet."; } catch { tgStat.textContent = ""; } };
  tgRefresh();
  root.querySelector("#renameBtn")?.addEventListener("click", async (e) => { const name = v("name").value.trim(); if (!name || name === store.name) return toast("Type the new name first"); if (!confirm(`Rename "${store.name}" to "${name}"?\n\nYou can rename again only after 60 days.`)) return; e.target.disabled = true; try { const r = await call("renameStore", { name }); toast(r.same ? "No change" : "Renamed ✓"); store.name = name; reload?.(); } catch (x) { toast(x.message, "error"); e.target.disabled = false; } });
  { const code = () => { const l = root.querySelector("#wLabel"), c = root.querySelector("#wColor"), p = root.querySelector("#wPos"), t = root.querySelector("#wCode"); if (!t) return; t.value = `<script src="https://taptayo.com/widget.js" data-shop="${store.slug}" data-label="${(l.value || "Book now").replace(/["<>&]/g, "")}" data-color="${c.value}"${p.value === "left" ? ' data-position="left"' : ""} async></script>`; };
    ["#wLabel", "#wColor", "#wPos"].forEach((sel) => root.querySelector(sel)?.addEventListener("input", code)); code();
    root.querySelectorAll("#widgetTile [data-copy]").forEach((b) => (b.onclick = async () => { const el = root.querySelector("#" + b.dataset.copy); try { await navigator.clipboard.writeText(el.value); toast("Copied"); } catch { el.select(); document.execCommand("copy"); toast("Copied"); } })); }
  root.querySelector("#tgSave").onclick = async (e) => { e.target.disabled = true; try { const r = await call("saveTelegram", { token: v("tgToken").value.trim() }); v("tgToken").value = ""; toast(`Saved — @${r.botName}`); tgRefresh(); } catch (err) { toast(err.message, "error"); } e.target.disabled = false; };
  root.querySelector("#tgDetect").onclick = async (e) => { e.target.disabled = true; try { const r = await call("telegramDetectChat"); toast(`Connected: ${r.chatTitle || r.chatId}`); tgRefresh(); } catch (err) { toast(err.message, "error"); } e.target.disabled = false; };
  root.querySelector("#tgTest").onclick = async (e) => { e.target.disabled = true; try { await call("telegramTest"); toast("Sent! Check Telegram."); } catch (err) { toast(err.message, "error"); } e.target.disabled = false; };
  // --- Semaphore buttons
  const semStat = root.querySelector("#semStatus");
  const semRefresh = async () => { try { const r = await call("semaphoreStatus"); semStat.innerHTML = !r.hasKey ? "No API key yet." : r.error ? `<span style="color:#b4423a">${esc(r.error)}</span>` : `Account: <b>${esc(r.accountName || "—")}</b> ✓ · Credits: <b>${r.credits ?? "?"}</b>`; } catch { semStat.textContent = ""; } };
  semRefresh();
  root.querySelector("#semSave").onclick = async (e) => { e.target.disabled = true; try { const r = await call("saveSemaphore", { apiKey: v("semKey").value.trim() }); v("semKey").value = ""; toast(`Saved — ${r.accountName || "ok"} (${r.credits ?? "?"} credits)`); semRefresh(); } catch (err) { toast(err.message, "error"); } e.target.disabled = false; };
  root.querySelector("#semTest").onclick = async (e) => { e.target.disabled = true; try { await call("smsTest", { number: v("semTestNum").value.trim() }); toast("Sent! Check the phone."); } catch (err) { toast(err.message, "error"); } e.target.disabled = false; };
  root.querySelector("#addPay").onclick = () => { payMethods.push({ id: "pm" + Math.random().toString(36).slice(2, 7), type: "gcash", name: "GCash", enabled: true, askRef: false, forServices: [] }); drawPay(); };
  drawPay();

  // ---------- theme picker ----------
  let selectedTheme = store.theme?.preset || "classic";
  let customColor = !!store.theme?.primary;
  const grid = root.querySelector("#themeGrid");
  function drawThemes() {
    grid.innerHTML = "";
    for (const [k, t] of Object.entries(THEMES)) {
      if (["halloween", "christmas", "valentine"].includes(k) && selectedTheme !== k) continue; // these are in Overview → Seasonal theme now
      const card = html(`<button type="button" class="theme ${k === selectedTheme ? "active" : ""}">
        <div class="sw" style="background:linear-gradient(135deg,${t.header[0]},${t.header[1]})"><span>${t.decor.slice(0, 3).join(" ")}</span></div>
        <div class="tn">${esc(t.name)}</div>
      </button>`);
      card.onclick = () => { selectedTheme = k; if (!customColor) v("primary").value = t.primary; v("banner").placeholder = t.banner || "e.g. Buy 1 Take 1 every Friday!"; drawThemes(); };
      grid.appendChild(card);
    }
  }
  drawThemes();
  v("primary").oninput = () => (customColor = true);
  root.querySelector("#resetColor").onclick = () => { customColor = false; v("primary").value = THEMES[selectedTheme].primary; };

  // ---------- uploads ----------
  root.querySelector("#logoField").appendChild(imageField({
    label: "Logo", current: store.logoUrl, shape: "round", hint: "Square PNG/JPG, min 256×256",
    onUpload: async (f) => { const url = await uploadImage(storeId, "logo", f, { max: 512 }); await updateDoc(doc(db, "stores", storeId), { logoUrl: url, updatedAt: serverTimestamp() }); toast("Logo updated"); reload?.(); return url; },
  }));
  root.querySelector("#floorField")?.appendChild(imageField({
    label: "Floor plan / table plan (optional)", current: store.floorPlanUrl, shape: "wide", hint: "Photo or drawing of the table layout — shown to customers in Reserve and to staff in Counter",
    onUpload: async (f) => { const url = await uploadImage(storeId, "floorplan", f, { max: 1600 }); await updateDoc(doc(db, "stores", storeId), { floorPlanUrl: url, updatedAt: serverTimestamp() }); toast("Floor plan updated"); return url; },
  }));
  root.querySelector("#hideBrand")?.addEventListener("change", async (e) => { try { await updateDoc(doc(db, "stores", storeId), { "settings.hideBranding": e.target.checked, updatedAt: serverTimestamp() }); toast("Saved"); } catch (x) { toast(x.message, "error"); } });
  root.querySelector("#coverField").appendChild(imageField({
    label: "Cover photo", current: store.coverUrl, shape: "wide", hint: "Landscape, e.g. 1600×600",
    onUpload: async (f) => { const url = await uploadImage(storeId, "cover", f, { max: 1600 }); await updateDoc(doc(db, "stores", storeId), { coverUrl: url, updatedAt: serverTimestamp() }); toast("Cover updated"); return url; },
  }));
  root.querySelectorAll("[data-state]").forEach((sel) => (sel.onchange = () => (sel.closest(".hrs-row").querySelector(".hrs-times").style.display = sel.value === "open" ? "" : "none")));
  root.querySelectorAll("[data-add2]").forEach((b) => (b.onclick = () => { const row = b.closest(".hrs-row"); row.querySelector(".hrs-2").style.display = ""; b.style.display = "none"; const o2 = row.querySelector(`[name$="_open2"]`), c2 = row.querySelector(`[name$="_close2"]`); if (!o2.value) o2.value = "17:00"; if (!c2.value) c2.value = "22:00"; }));
  root.querySelectorAll("[data-rm2]").forEach((b) => (b.onclick = () => { const row = b.closest(".hrs-row"); row.querySelector(".hrs-2").style.display = "none"; row.querySelector(".hrs-add").style.display = ""; }));
  const NEXT = { mon: "Tuesday", tue: "Wednesday", wed: "Thursday", thu: "Friday", fri: "Saturday", sat: "Sunday", sun: "Monday" };
  const hrsNote = (row) => {
    const k = row.dataset.day, note = row.querySelector(".hrs-note"); if (!note) return;
    const o = v(k + "_open").value, c = v(k + "_close").value, o2 = v(k + "_open2").value, c2 = v(k + "_close2").value;
    const two = row.querySelector(".hrs-2").style.display !== "none" && o2 && c2;
    const end1 = o && c ? (c <= o ? "24:00" : c) : "";
    note.textContent = two && o2 < end1 ? `↳ 2nd shift is after midnight — counts as ${NEXT[k]} ${((h, m) => `${h % 12 || 12}${m ? ":" + String(m).padStart(2, "0") : ""} ${h < 12 ? "AM" : "PM"}`)(...o2.split(":").map(Number))} onward` : c && o && c < o ? `↳ closes the next day (${NEXT[k]} morning)` : "";
  };
  root.querySelectorAll(".hrs-row").forEach((row) => { hrsNote(row); row.addEventListener("input", () => hrsNote(row)); row.addEventListener("click", () => setTimeout(() => hrsNote(row))); });
  root.querySelector("#hrsCopy")?.addEventListener("click", () => { const m = root.querySelector('.hrs-row[data-day="mon"]'); const st = m.querySelector("[data-state]").value; const vals = ["_open", "_close", "_open2", "_close2"].map((x) => v("mon" + x).value); const two = m.querySelector(".hrs-2").style.display !== "none"; DAYS.forEach(([k]) => { if (k === "mon") return; const r = root.querySelector(`.hrs-row[data-day="${k}"]`); r.querySelector("[data-state]").value = st; r.querySelector(".hrs-times").style.display = st === "open" ? "" : "none"; ["_open", "_close", "_open2", "_close2"].forEach((x, i) => (v(k + x).value = vals[i])); r.querySelector(".hrs-2").style.display = two ? "" : "none"; r.querySelector(".hrs-add").style.display = two ? "none" : ""; }); toast("Copied Monday to all days — remember to Save"); });
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = root.querySelector("#saveBtn");
    btn.disabled = true;
    const newHours = {};
    const allDay = DAYS.every(([k]) => root.querySelector(`[data-state="${k}"]`).value === "24h");
    DAYS.forEach(([k]) => {
      const st = root.querySelector(`[data-state="${k}"]`).value;
      const o = v(`${k}_open`).value, c = v(`${k}_close`).value, o2 = v(`${k}_open2`).value, c2 = v(`${k}_close2`).value;
      const second = root.querySelector(`.hrs-row[data-day="${k}"] .hrs-2`).style.display !== "none";
      newHours[k] = st === "closed" ? [] : st === "24h" ? ["00:00", "23:59"] : o && c ? (second && o2 && c2 ? [o, c, o2, c2] : [o, c]) : [];
    });
    if (allDay) Object.keys(newHours).forEach((k) => delete newHours[k]);
    if (sideHours) DAYS.forEach(([k]) => (newHours[k] = sideHours[k] || []));
    const settings = {
      ...s,
      acceptOrders: v("acceptOrders").checked,
      welcome: v("welcome").value.trim(),
      reviewUrl: /^https:\/\//.test(v("reviewUrl").value.trim()) ? v("reviewUrl").value.trim() : null,
      ...(v("advanceWhenClosed") ? { advanceWhenClosed: v("advanceWhenClosed").checked } : {}),
      tagline: v("tagline").value.trim(),
      solo: { enabled: v("soloOn").checked, rider: v("soloRider").value },
      ...(v("bpRes") ? { bookingPolicy: { refundable: !v("bpNonRef").checked, reschedule: { allowed: v("bpRes").checked, max: Number(v("bpMax").value) || 0, cutoffHours: Number(v("bpCut").value) || 0, fee: Number(v("bpFee").value) || 0, feeType: v("bpFeeT").value } } } : {}),
    };
    if (v("slCall")) { const word = String(v("slCall").value || "").trim().slice(0, 24); if (word) settings.labels = { ...(settings.labels || {}), staff: word }; }`r`n    settings.payments = { methods: payMethods.filter((m) => m.name.trim()).map((m) => ({ id: m.id, type: m.type, name: m.name.trim(), enabled: m.enabled !== false, number: (m.number || "").trim(), accountName: (m.accountName || "").trim(), qrUrl: m.qrUrl || null, askRef: m.type !== "cash" && m.type !== "card" ? m.askRef === true : false, askRefBookings: m.askRefBookings !== false, forServices: m.forServices || [] })) };
    if ((mode === "salon" || mode === "stay") && v("cfMode")) settings.confirm = { mode: v("cfMode").value, minutes: Number(v("cfMinutes").value || 60), messengerLink: v("cfLink").value.trim(), skipReturning: v("cfSkip").checked };
    // These tiles are shown for every business type — save them for every type (was table-only before).
    if (v("dayCutoff")) settings.businessDayCutoff = v("dayCutoff").value || "00:00";
    if (v("vatReg")) settings.vatRegistered = v("vatReg").checked;
    if (v("shTol")) settings.shifts = { blindCount: true, tolerance: Number(v("shTol").value || 0), externalPos: v("shPos").checked, whoVerify: v("shWho").value, autoEnd: !!v("shAuto").value, autoEndAt: v("shAuto").value || null };
    if (v("smsEnabled")) settings.sms = { enabled: v("smsEnabled").checked, senderName: v("smsSender").value.trim(), optInText: v("smsOptText").value.trim(), quietFrom: v("smsQuietFrom").value || null, quietTo: v("smsQuietTo").value || null };
    if (v("prEnabled")) settings.printing = { enabled: v("prEnabled").checked, paper: Number(v("prPaper").value || 58), header: v("prHeader").value.trim(), footer: v("prFooter").value.trim(), logo: v("prLogo").checked, autoOrder: v("prAutoOrder").checked, autoPaid: v("prAutoPaid").checked, autoStub: v("prAutoStub") ? v("prAutoStub").checked : true, kitchenTicket: v("prKitchen") ? v("prKitchen").checked : false };
    if (v("tgEnabled")) settings.telegram = { enabled: v("tgEnabled").checked, events: { newOrder: v("tgNewOrder").checked, callStaff: v("tgCall").checked, reservation: v("tgResv").checked, incident: v("tgInc").checked, shiftVariance: v("tgShift").checked, daily: v("tgDaily").checked }, quietFrom: v("tgQuietFrom").value || null, quietTo: v("tgQuietTo").value || null };
    if (mode === "table") {
      if (v("cfMode").value === "messenger" && !v("cfLink").value.trim() && (v("pickup")?.checked || v("delivery")?.checked)) toast("Add your Messenger link (Confirmation section) so pickup/delivery customers can message you", "error");
      settings.confirm = { mode: v("cfMode").value, minutes: Number(v("cfMinutes").value || 60), messengerLink: v("cfLink").value.trim(), skipReturning: v("cfSkip").checked };
      settings.qrMode = "per_table";
      settings.landing = v("landing").checked;
      settings.service = {
        dineIn: v("dineIn").checked, takeOut: v("takeOut").checked, pickup: v("pickup").checked, delivery: v("delivery").checked,
        deliveryFeeMode: v("deliveryFeeMode").value, deliveryFee: Number(v("deliveryFee").value || 0), deliveryMin: Number(v("deliveryMin").value || 0), smallOrderMin: Number(v("smallOrderMin")?.value || 0), smallOrderFee: Number(v("smallOrderFee")?.value || 0), smallOrderFor: v("smallPickup")?.checked ? ["delivery", "pickup"] : ["delivery"],
        allowSchedule: v("allowSchedule").checked, scheduleLeadMin: Number(v("scheduleLeadMin").value || 30), fireBeforeMin: Number(v("fireBeforeMin").value || 30), prepDefault: Number(v("prepDefault")?.value || 15), busyPrep: Number(v("busyPrep")?.value || 35), dispatch: v("useDispatch") ? v("useDispatch").checked : true, busyRemind: Number(v("busyRemind")?.value ?? 8),
        autoPauseMin: Number(v("autoPauseMin")?.value ?? 5), autoPause: Number(v("autoPauseMin")?.value ?? 5) > 0,
        payFirst: !!v("payFirst")?.checked, guestOrders: v("guestOrders") ? v("guestOrders").checked : svc.guestOrders !== false,
      };
      if (v("cfLoy")) settings.loyalty = { enabled: v("cfLoy").checked, stamps: Math.max(2, Number(v("cfLoyN").value || 10)), minTotal: Math.max(0, Number(v("cfLoyMin").value || 0)), rewardValue: Math.max(0, Number(v("cfLoyVal").value || 0)), rewardText: v("cfLoyText").value.trim(), maxPerDay: Math.max(1, Number(v("cfLoyDay").value || 1)) };
      settings.reservations = { enabled: v("resvEnabled").checked, maxPax: Number(v("resvMaxPax").value || 12), leadTimeHours: Number(v("resvLeadHours").value || 0), requirePhone: true };
      settings.policies = { table: v("polTable").value.trim(), event: v("polEvent").value.trim(), vip: v("polVip").value.trim() };
      settings.waiver = { text: v("wvText").value.trim(), table: v("wvTable").checked, event: v("wvEvent").checked, vip: v("wvVip").checked, idMode: v("wvId").value, blockConfirm: v("wvBlock").checked };
      settings.feedback = { enabled: v("fbEnabled").checked, display: v("fbDisplay").value, askPhoto: v("fbPhoto").checked };
      settings.incidents = { enabled: v("incEnabled").checked, requireProof: v("incProof").checked, who: v("incWho").value, maxVoucherCrew: Number(v("incMaxCrew").value || 0), maxCompsCrew: Number(v("incMaxComps")?.value ?? 3), crewCancelMax: Number(v("incCancelMax")?.value ?? 300) };
      settings.callStaff = {
        enabled: v("csEnabled").checked, cooldownMin: Number(v("csCooldown").value || 5), allowMessage: v("csMessage").checked,
        options: [...form.querySelectorAll("[name=csOpt]:checked")].map((c) => c.value), showToKitchen: v("csKitchen").checked,
      };
      settings.events = {
        enabled: v("evEnabled").checked, leadTimeDays: Number(v("evLeadDays").value || 0), maxPax: Number(v("evMaxPax").value || 100),
        depositPercent: Number(v("evDeposit").value || 0), note: v("evNote").value.trim(),
        packages: packages.filter((p) => p.name.trim()).map((p) => ({ id: p.id, name: p.name.trim(), price: Number(p.price || 0), pricing: p.pricing || "head", minPax: Number(p.minPax || 0), description: (p.description || "").trim() })),
      };
      settings.vip = {
        enabled: v("vipEnabled").checked, leadTimeHours: Number(v("vipLeadHours").value || 0), note: v("vipNote").value.trim(), cleanMin: Math.max(0, Math.min(180, Number(v("vipClean")?.value ?? 30))),
        includePriorOnTransfer: v("vipPrior").checked, allowManagerOverride: v("vipOverride").checked,
        autoVoucher: { enabled: v("avEnabled").checked, hours: Math.max(1, Math.min(6, Number(v("avHours").value || 1))), minSubtotal: Number(v("avMin").value || 0) },
        overtime: { enabled: v("otEnabled").checked, firstMinutes: Number(v("otFirstMin").value || 5), firstFee: Number(v("otFirstFee").value || 0), perMinute: Number(v("otPerMin").value || 0) },
        rooms: rooms.filter((r) => r.name.trim()).map((r) => ({ id: r.id, name: r.name.trim(), capacity: Number(r.capacity || 0), pricing: r.pricing || "hour", ratePerHour: Number(r.ratePerHour || 0), minSpend: Number(r.minSpend || 0), minHours: Number(r.minHours || 1), description: (r.description || "").trim() })),
      };
    }
    if (mode === "booking") settings.booking = { slotMinutes: Number(v("slotMinutes").value || 30), leadTimeHours: Number(v("leadTimeHours").value || 0), requireStaff: v("requireStaff").checked };
    if (mode === "laundry") { settings.policies = { ...(s.policies || {}), laundry: v("polLaundry").value.trim() }; }
    if (mode === "stay") {
      settings.stay = { ...(s.stay || {}), payFirst: !!v("stPayFirst")?.checked, checkIn: v("stIn").value || "14:00", checkOut: v("stOut").value || "12:00", downPct: Math.max(0, Math.min(100, Number(v("stDown").value) || 0)), maxNights: Number(v("stMaxN").value || 14),
        weekendNights: [...root.querySelectorAll("[data-wk]:checked")].map((c) => c.dataset.wk), holidays: v("stHol").value.split(",").map((x) => x.trim()).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)),
        pool: { mode: "none", price: 0 }, reminders: !!v("stRem")?.checked, extension: { enabled: v("stExt").checked, pricePerHour: Number(v("stExtP").value || 0), maxHours: Number(v("stExtH").value || 6) },
        requireId: v("stId").checked, policy: v("stPolicy").value.trim(),
        addons: (stRows.addons?.() || []).filter((a) => a.name).map((a) => ({ ...a, price: a.price || 0, max: a.max || 4 })),
        deposit: { amount: Math.max(0, Number(v("stDep").value) || 0), checkMinutes: Math.max(15, Number(v("stDepMin").value) || 60) },
        guestIds: v("stGuestIds").checked, selfCheck: { enabled: v("stSelf").checked, codeHoursBefore: Math.max(0, Number(v("stCodeH").value) || 0) },
        overstay: { enabled: v("stOver").checked, graceMin: Math.max(0, Number(v("stOverG").value) || 0), ratePerHour: Math.max(0, Number(v("stOverR").value) || 0) },
        cleaning: { minutes: Math.max(0, Math.min(480, Number(v("stClean").value) || 0)), showGuests: v("stCleanShow").checked },
        promos: (stRows.promos?.() || []).filter((p) => p.name && p.percent > 0),
        amenities: (stRows.amen?.() || []).filter((a) => a.name).map((a) => ({ ...a, price: a.unit === "free" ? 0 : a.price || 0, note: String(a.note || "").slice(0, 60) })), nearby: (stRows.near?.() || []).filter((x) => x.name),
        kids: { freeUnder: Number(v("stKidAge").value) || 0, countInPax: v("stKidPax").checked }, noIdOk: v("stNoId").checked,
        cancel: { fullDays: Number(v("stCxFull").value) || 0, partialDays: Number(v("stCxPart").value) || 0, partialPct: Number(v("stCxPct").value) || 0 },
        lastMinute: { enabled: v("stLast").checked, percent: Number(v("stLastP").value) || 20, after: v("stLastT").value || "18:00" },
        houseRules: v("stRules").value.trim(), visitorLog: v("stVisit").checked, ical: { exportShort: v("stIcalShort").checked },
        loyalty: { enabled: v("stLoy").checked, every: Math.max(2, Number(v("stLoyN").value) || 5), percent: Math.max(1, Math.min(100, Number(v("stLoyP").value) || 20)) },
        short: { enabled: v("stShort").checked, timerOnArrival: v("stShTimer").checked, graceMin: Math.max(0, Number(v("stShGrace").value) || 0), packages: [1, 3, 6, 12].map((h) => ({ hours: h, price: v("stSh" + h).value === "" ? null : Math.max(0, Number(v("stSh" + h).value) || 0) })).filter((x) => x.price != null), from: v("stShFrom").value || "08:00", until: v("stShTo").value || "20:00", bufferMin: Math.max(0, Math.min(240, Number(v("stShBuf").value) || 0)) } };
      settings.waiver = { ...(s.waiver || {}), text: v("stWaiver").value.trim() };
    }
    if (mode === "salon") {
      settings.policies = { ...(s.policies || {}), salon: v("polSalon").value.trim() };
      settings.salonTypes = Object.fromEntries([...root.querySelectorAll("[data-stype]")].map((c) => [c.dataset.stype, c.checked]));
      const pkgs = [...root.querySelectorAll("[data-slpkg]")].map((r) => ({ id: r.dataset.slpkg, name: r.querySelector("[name=pkName]").value.trim(), itemId: r.querySelector("[name=pkItem]").value, sessions: Math.max(2, Number(r.querySelector("[name=pkN]").value || 5)), price: Number(r.querySelector("[name=pkPrice]").value || 0), validDays: Number(r.querySelector("[name=pkDays]").value || 180) })).filter((x) => x.name && x.itemId);
      settings.salon = { ...sl, noShow: { dpAfter: Number(v("slNsDp").value || 0), blockAfter: Number(v("slNsBlock").value || 0) },
        deposit: { enabled: v("slDp").checked, amount: Number(v("slDpAmt").value || 0), minTotal: Number(v("slDpFrom").value || 0) },
        reminders: { dayBefore: v("slRemDay").checked, hoursBefore: v("slRemHrs").checked }, rebook: { enabled: v("slRebook").checked },
        loyalty: { enabled: v("slLoy").checked, stamps: Math.max(2, Number(v("slLoyN").value || 10)), minTotal: Number(v("slLoyMin").value || 0), rewardValue: Number(v("slLoyVal").value || 0), rewardText: v("slLoyText").value.trim() },
        packages: pkgs,
        giftcards: { enabled: v("gcOn").checked, amounts: v("gcAmts").value.split(",").map((x) => Number(x.trim())).filter((x) => x > 0).slice(0, 8), min: Number(v("gcMin").value || 300), max: Number(v("gcMax").value || 10000), validMonths: Number(v("gcMonths").value || 12) },
        memberships: [...root.querySelectorAll("[data-slmem]")].map((r) => ({ id: r.dataset.slmem, name: r.querySelector("[name=mName]").value.trim(), price: Number(r.querySelector("[name=mPrice]").value || 0), days: Number(r.querySelector("[name=mDays]").value || 30), discountPct: Number(r.querySelector("[name=mPct]").value || 0), freeItemId: r.querySelector("[name=mFree]").value || null, freeCount: Number(r.querySelector("[name=mFreeN]").value || 0) })).filter((x) => x.name && x.price > 0),
        referral: { enabled: v("refOn").checked, reward: Number(v("refAmt").value || 100) },
        birthday: { enabled: v("bdOn").checked, type: v("bdType").value, value: Number(v("bdVal").value || 0), minOrder: Number(v("bdMin").value || 0) },
        rooms: [...root.querySelectorAll("[data-sproom]")].map((r) => ({ id: r.dataset.sproom, name: r.querySelector("[name=rmName]").value.trim().slice(0, 30), beds: Math.max(1, Math.min(4, Number(r.querySelector("[name=rmBeds]").value || 1))), active: r.querySelector("[name=rmOn]").checked })).filter((r) => r.name).slice(0, 40),
        roomBufferMin: Math.max(0, Math.min(60, Number(v("slRoomBuf")?.value || 0))), allowPax2: v("slPax2") ? v("slPax2").checked : sl.allowPax2 !== false, genderPick: v("slGender") ? v("slGender").checked : !!sl.genderPick, staffWord: String(v("slCall")?.value || "").trim().slice(0, 24),
        ...(store.businessType === "freelance" ? { freelance: { quotes: v("flQuotes").checked, dpPercent: Number(v("flDp").value) || 0, revisions: Number(v("flRev").value) || 0, terms: v("flTerms").value.trim(), platforms: (stRows.plat?.() || []).filter((p) => p.platform), niches: v("flNiches").value.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 8), city: v("flCity").value.trim(), pitch: v("flPitch").value.trim(), brands: v("flBrands").value.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 12), directory: v("flDir").checked, offers: v("flOffers").checked, minFee: Number(v("flMin").value) || 0, rush: { enabled: v("flRush").checked, hours: Number(v("flRushH").value) || 24, fee: Number(v("flRushF").value) || 0 }, rushMiss: v("flMiss").value, rushMissPct: Number(v("flMissPct").value) || 10, release: { mode: v("flRel").value, rawDays: v("flRel").value === "final" ? 0 : Number(v("flRaw").value) || 0, finalDays: Number(v("flFin").value) || 0 }, requireIdOnSite: v("flId").checked, ugc: v("flUgc").checked, adult: v("flAdult").checked, xdeal: { on: v("xOn").checked, minTip: Math.max(0, Number(v("xTip").value) || 0), releaseDays: Math.max(1, Math.min(30, Number(v("xDays").value) || 5)), types: [...root.querySelectorAll("[name=xType]:checked")].map((c) => c.value) }, availability: { sideJob: v("flSide").value, maxPerWeek: Math.max(0, Number(v("flMaxWk").value) || 0), paused: !!v("flPause").value && new Date(`${v("flPause").value}T23:59:59+08:00`).getTime() > Date.now(), until: v("flPause").value ? new Date(`${v("flPause").value}T23:59:59+08:00`).getTime() : null } } } : {}),
        remit: { enabled: v("slRemit") ? v("slRemit").checked : !!sl.remit?.enabled },
        protectClients: v("slProtect") ? v("slProtect").checked : sl.protectClients !== false,
        intake: { enabled: v("slIntake") ? v("slIntake").checked : !!sl.intake?.enabled },
        queue: v("qOn") ? { ...(sl.queue || {}), enabled: v("qOn").checked, maxPeople: Math.max(1, Math.min(50, Number(v("qMax").value) || 8)), maxWaitMin: Math.max(10, Math.min(600, Number(v("qWait").value) || 90)), cutoffMin: Math.max(0, Math.min(240, Number(v("qCut").value) || 0)), graceMin: Math.max(3, Math.min(30, Number(v("qGrace").value) || 10)), callOnCallAt: Math.max(2, Math.min(50, Number(v("qOnCall").value) || 5)), remote: v("qRemote").checked, sms: v("qSms").checked } : (sl.queue || {}),
        offers: v("ofOn") ? { enabled: v("ofOn").checked, mode: v("ofMode").value === "race" ? "race" : "rotate", seconds: Math.max(1, Math.min(15, Number(v("ofMin").value) || 5)) * 60, auto: v("ofAuto").checked, nearest: v("ofNear").checked } : (sl.offers || { enabled: false }),
        slotMinutes: Number(v("slSlot").value || 30), bufferMin: Number(v("slBuffer").value || 0), leadTimeHours: Number(v("slLead").value || 0), cancelHours: Number(v("slCancel").value || 0), graceMin: Number(v("slGrace").value || 15), maxDaysAhead: Number(v("slDays").value || 14), confirmMinutes: Number(v("slConfirm").value || 60), allowAnyone: v("slAnyone").checked, ownerWorks: v("slOwnerWorks").checked, tips: v("slTips").checked, homeService: { ...hs, radiusKm: Math.max(0, Number(v("hsRadius")?.value || 0)), base: (() => { const t = String(v("hsBase")?.value || ""); const m = /(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/.exec(t); return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null; })(), enabled: v("slHome").checked, fee: Number(v("slHomeFee").value || 0), note: v("slHomeNote").value.trim(), travelMin: Math.max(0, Math.min(180, Number(v("hsTravel").value || 0))), minSpend: Number(v("hsMin").value || 0), dpAmount: Number(v("hsDp").value || 0), escort: v("hsEscort") ? v("hsEscort").checked : !!hs.escort, requirePin: v("hsPin") ? v("hsPin").checked : hs.requirePin !== false, requireId: v("hsId") ? v("hsId").checked : false, exclusive: v("hsExcl") ? v("hsExcl").checked : hs.exclusive !== false,
          areas: [...root.querySelectorAll("[data-hsarea]")].map((r) => ({ name: r.querySelector("[name=haName]").value.trim().slice(0, 40), fee: Number(r.querySelector("[name=haFee]").value || 0) })).filter((a) => a.name).slice(0, 40),
          days: Object.fromEntries(DAYS.map(([k]) => [k, { on: v("hsOn_" + k).checked, from: v("hsFrom_" + k).value || "09:00", to: v("hsTo_" + k).value || "12:00" }])),
          prep: [...root.querySelectorAll("[data-hsprep]")].map((r) => ({ name: r.querySelector("[name=hpName]").value.trim().slice(0, 50), bring: r.querySelector("[name=hpBring]").checked, fee: r.querySelector("[name=hpBring]").checked ? Math.max(0, Number(r.querySelector("[name=hpFee]").value || 0)) : 0 })).filter((x) => x.name).slice(0, 20) },
        ...(v("slAway") ? { walkInWhenAway: v("slAway").value } : {}), ...(v("slHomeAway") ? { homeAway: v("slHomeAway").value } : {}) };
    }
    if (mode === "laundry") settings.laundry = { ...ld, loyalty: { enabled: v("ldLoyalty").checked, everyKg: Number(v("ldLoyEvery").value || 10), freeKg: Number(v("ldLoyFree").value || 1) }, minKg: Number(v("ldMinKg").value || 0), maxLoadKg: Number(v("ldMaxLoad").value || 8), etaHours: Number(v("ldEta").value || 24), rushMode: v("ldRushMode").value, rushValue: Number(v("ldRushValue").value || 0), rushEtaHours: Number(v("ldRushEta").value || 6), foldFree: v("ldFold").value === "free", foldFee: Number(v("ldFoldFee").value || 0), complaintHours: Number(v("ldComplaint").value || 24), storageFreeDays: Number(v("ldStoreFree").value || 0), storageFeePerDay: Number(v("ldStoreFee").value || 0), paymentFirst: v("ldPayFirst").checked, clothesCount: v("ldCount").checked, separateWhites: v("ldSep").checked, steps: { drying: v("ldDry").checked, folding: v("ldFoldStep").checked }, modes: { dropoff_pickup: v("ldM1").checked, rider_rider: v("ldM2").checked, dropoff_delivery: v("ldM3").checked, rider_pickup: v("ldM4").checked } };
    if (mode === "pickup") settings.pickup = { turnaroundHours: Number(v("turnaroundHours").value || 24), requirePhone: v("requirePhone").checked };

    try {
      await updateDoc(doc(db, "stores", storeId), {
        theme: {
          preset: selectedTheme,
          primary: customColor ? v("primary").value : null,
          banner: v("banner").value.trim(),
          decor: v("decor").checked,
          layout: ((v) => (mode === "salon" && v === "list" ? "rows" : v))(root.querySelector("[name=layout]:checked")?.value || "list"), // salons: "rows" = the owner really chose the list
          season: store.theme?.season || null,
        },
        contact: { ...(store.contact || {}), phone: v("phone").value.trim(), address: v("address").value.trim(), messenger: v("cMsgr") ? msgrLink(v("cMsgr").value) : store.contact?.messenger || "", ...(v("cMap") ? { mapUrl: v("cMap").value.trim().slice(0, 400), facebook: v("cFb").value.trim().slice(0, 200), instagram: v("cIg").value.trim().slice(0, 100), tiktok: v("cTt").value.trim().slice(0, 100) } : {}) },
        hours: newHours,
        settings,
        updatedAt: serverTimestamp(),
      });
      toast("Settings saved");
      reload?.();
    } catch (err) {
      console.error(err);
      toast("Could not save: " + (err.message || err.code), "error");
    }
    btn.disabled = false;
  };

  // ---------- staff & PINs ----------
  const ROLES = mode === "stay" ? [["manager", "👔 Manager", "everything"], ["crew", "🛎 Front desk", "approves bookings, check-in/out, requests, payments, deposits"], ["cleaner", "🧹 Caretaker", "rooms app — checks the room at check-out, cleans, prepares extras"]] : mode === "salon" ? [["manager", "👔 Manager", "everything + void/cancel, shift reports"], ["crew", "🛎 Reception / counter", "bookings, assign clients, mark paid"], ["stylist", store.businessType === "spa" ? "💆 Therapist" : "💇 Stylist / technician", "takes clients; shown to customers with photo & skills"], ...(place !== "shop" ? [["rider", "🛵 Rider", "drops off & picks up staff on home service (rider app)"]] : [])] : [["manager", "👔 Manager", "everything + void/cancel, shift reports"], ["crew", "🧑‍🍳 Crew / counter", "orders, mark paid, sold out"], ["kitchen", "🍳 Kitchen", "kitchen screen"], ["barista", "☕ Barista", "barista screen (drinks/pastry)"], ...(mode === "table" ? [["dispatch", "📋 Dispatch", "plating check before food goes out"]] : []), ["rider", "🛵 Rider", "delivery app"], ...(mode === "salon" ? [["stylist", "💇 Stylist / technician", "takes clients; shown to customers with photo & skills"]] : [])];
  const pinList = root.querySelector("#staffPinList");
  let uCats = () => {};
  let salonItems = [];
  let pkgRows = JSON.parse(JSON.stringify(sl.packages || []));
  function drawSalonPkgs() {
    const box = root.querySelector("#slPkgList"); if (!box) return;
    // keep what was typed
    box.querySelectorAll("[data-slpkg]").forEach((r) => { const p = pkgRows.find((x) => x.id === r.dataset.slpkg); if (p) Object.assign(p, { name: r.querySelector("[name=pkName]").value, itemId: r.querySelector("[name=pkItem]").value, sessions: r.querySelector("[name=pkN]").value, price: r.querySelector("[name=pkPrice]").value, validDays: r.querySelector("[name=pkDays]").value }); });
    box.innerHTML = pkgRows.map((p) => `<div class="form3" data-slpkg="${esc(p.id)}" style="align-items:end;border-bottom:1px solid var(--line);padding-bottom:8px;margin-bottom:8px">
      <div><label>Name</label><input name="pkName" value="${esc(p.name || "")}" placeholder="IPL underarm × 5"/></div>
      <div><label>Service</label><select name="pkItem">${salonItems.filter((i) => !i.retail).map((i) => `<option value="${i.id}" ${i.id === p.itemId ? "selected" : ""}>${esc(i.name)}</option>`).join("")}</select></div>
      <div class="row" style="gap:6px"><div><label>Sessions</label><input name="pkN" type="number" min="2" value="${p.sessions || 5}"/></div><div><label>Price ₱</label><input name="pkPrice" type="number" min="0" value="${p.price || ""}"/></div><div><label>Valid days</label><input name="pkDays" type="number" min="7" value="${p.validDays || 180}"/></div><button class="btn ghost sm" type="button" data-rmpkg="${esc(p.id)}">✕</button></div></div>`).join("") || `<p class="small muted">No packages yet.</p>`;
    box.querySelectorAll("[data-rmpkg]").forEach((b) => (b.onclick = () => { pkgRows = pkgRows.filter((x) => x.id !== b.dataset.rmpkg); drawSalonPkgs(); }));
  }
  if (mode === "salon") onSnapshot(query(collection(db, "stores", storeId, "items"), orderBy("sortOrder")), (snap) => { salonItems = snap.docs.map((d) => ({ id: d.id, ...d.data() })); drawSalonPkgs(); drawSalonMems(); });
  let memRows = JSON.parse(JSON.stringify(sl.memberships || []));
  function drawSalonMems() {
    const box = root.querySelector("#slMemList"); if (!box) return;
    box.querySelectorAll("[data-slmem]").forEach((r) => { const m = memRows.find((x) => x.id === r.dataset.slmem); if (m) Object.assign(m, { name: r.querySelector("[name=mName]").value, price: r.querySelector("[name=mPrice]").value, days: r.querySelector("[name=mDays]").value, discountPct: r.querySelector("[name=mPct]").value, freeItemId: r.querySelector("[name=mFree]").value, freeCount: r.querySelector("[name=mFreeN]").value }); });
    box.innerHTML = memRows.map((m) => `<div class="form3" data-slmem="${esc(m.id)}" style="align-items:end;border-bottom:1px solid var(--line);padding-bottom:8px;margin-bottom:8px">
      <div><label>Name</label><input name="mName" value="${esc(m.name || "")}" placeholder="Glow Club"/></div>
      <div class="row" style="gap:6px"><div><label>Price ₱</label><input name="mPrice" type="number" min="0" value="${m.price || ""}"/></div><div><label>Days</label><input name="mDays" type="number" min="7" value="${m.days || 30}"/></div><div><label>% off</label><input name="mPct" type="number" min="0" max="100" value="${m.discountPct || 0}"/></div></div>
      <div class="row" style="gap:6px"><div style="flex:1"><label>Free service</label><select name="mFree"><option value="">— none —</option>${salonItems.filter((i) => !i.retail).map((i) => `<option value="${i.id}" ${i.id === m.freeItemId ? "selected" : ""}>${esc(i.name)}</option>`).join("")}</select></div><div><label>× times</label><input name="mFreeN" type="number" min="0" value="${m.freeCount || 0}" style="width:70px"/></div><button class="btn ghost sm" type="button" data-rmmem="${esc(m.id)}">✕</button></div></div>`).join("") || `<p class="small muted">No memberships yet.</p>`;
    box.querySelectorAll("[data-rmmem]").forEach((b) => (b.onclick = () => { memRows = memRows.filter((x) => x.id !== b.dataset.rmmem); drawSalonMems(); }));
  }
  let areaRows = JSON.parse(JSON.stringify(hs.areas || []));
  function drawAreas() {
    const box = root.querySelector("#hsAreas"); if (!box) return;
    box.querySelectorAll("[data-hsarea]").forEach((r, i) => { areaRows[i] = { name: r.querySelector("[name=haName]").value, fee: r.querySelector("[name=haFee]").value }; });
    box.innerHTML = areaRows.map((a, i) => `<div class="row" data-hsarea="${i}" style="gap:6px"><input name="haName" value="${esc(a.name || "")}" placeholder="e.g. Brgy. San Roque / Makati" style="flex:1"/><input name="haFee" type="number" min="0" value="${a.fee ?? ""}" placeholder="₱ fee" style="max-width:110px"/><button class="btn ghost sm" type="button" data-rmarea="${i}" aria-label="Remove area">✕</button></div>`).join("") || `<p class="small muted" style="margin:0">No areas yet.</p>`;
    box.querySelectorAll("[data-rmarea]").forEach((b) => (b.onclick = () => { drawAreas(); areaRows.splice(Number(b.dataset.rmarea), 1); drawAreas(); }));
  }
  let prepRows = JSON.parse(JSON.stringify(hs.prep || []));
  function drawPrep() {
    const box = root.querySelector("#hsPrep"); if (!box) return;
    box.querySelectorAll("[data-hsprep]").forEach((r, i) => { prepRows[i] = { name: r.querySelector("[name=hpName]").value, bring: r.querySelector("[name=hpBring]").checked, fee: r.querySelector("[name=hpFee]").value }; });
    box.innerHTML = prepRows.map((a, i) => `<div class="row" data-hsprep="${i}" style="gap:6px;align-items:center;flex-wrap:wrap"><input name="hpName" value="${esc(a.name || "")}" placeholder="e.g. 2 bath towels" style="flex:1;min-width:150px"/><label class="check" style="margin:0;white-space:nowrap"><input type="checkbox" name="hpBring" ${a.bring ? "checked" : ""}/> We can bring it</label><input name="hpFee" type="number" min="0" value="${a.fee || ""}" placeholder="₱ fee" style="max-width:90px"/><button class="btn ghost sm" type="button" data-rmprep="${i}" aria-label="Remove item">✕</button></div>`).join("") || `<p class="small muted" style="margin:0">No items yet.</p>`;
    box.querySelectorAll("[data-rmprep]").forEach((b) => (b.onclick = () => { drawPrep(); prepRows.splice(Number(b.dataset.rmprep), 1); drawPrep(); }));
  }
  let spRows = JSON.parse(JSON.stringify(sl.rooms || []));
  function drawSpaRooms() {
    const box = root.querySelector("#spaRooms"); if (!box) return;
    box.querySelectorAll("[data-sproom]").forEach((r, i) => { spRows[i] = { id: r.dataset.sproom, name: r.querySelector("[name=rmName]").value, beds: r.querySelector("[name=rmBeds]").value, active: r.querySelector("[name=rmOn]").checked }; });
    box.innerHTML = spRows.map((r, i) => `<div class="row" data-sproom="${esc(r.id)}" style="gap:6px;align-items:center"><input name="rmName" value="${esc(r.name || "")}" placeholder="e.g. Room 1 / Couple room" style="flex:1"/><select name="rmBeds" style="max-width:110px">${[1, 2, 3, 4].map((n) => `<option value="${n}" ${Number(r.beds || 1) === n ? "selected" : ""}>${n} bed${n > 1 ? "s" : ""}</option>`).join("")}</select><label class="check" style="margin:0"><input type="checkbox" name="rmOn" ${r.active !== false ? "checked" : ""}/> Open</label><button class="btn ghost sm" type="button" data-rmroom="${i}" aria-label="Remove room">✕</button></div>`).join("") || `<p class="small muted" style="margin:0">No rooms yet.</p>`;
    box.querySelectorAll("[data-rmroom]").forEach((b) => (b.onclick = () => { drawSpaRooms(); spRows.splice(Number(b.dataset.rmroom), 1); drawSpaRooms(); }));
  }
  { const c = root.querySelector("[data-qshop]"); if (c) import("qrcode").then((m) => m.default.toCanvas(c, `${location.origin}/m/${store.slug}?shop=1`, { width: 120, margin: 1 })).catch(() => {}); }
  if (mode === "salon") { drawSpaRooms(); root.querySelector("#spaAddRoom")?.addEventListener("click", () => { drawSpaRooms(); spRows.push({ id: "rm" + Date.now().toString(36), name: "", beds: 1, active: true }); drawSpaRooms(); root.querySelector("#spaRooms [data-sproom]:last-child [name=rmName]")?.focus(); }); }
  if (mode === "salon") { drawPrep(); root.querySelector("#hsAddPrep")?.addEventListener("click", () => { drawPrep(); prepRows.push({ name: "", bring: false, fee: "" }); drawPrep(); root.querySelector("#hsPrep [data-hsprep]:last-child [name=hpName]")?.focus(); }); }
  if (mode === "salon") { drawAreas(); root.querySelector("#hsAddArea")?.addEventListener("click", () => { drawAreas(); areaRows.push({ name: "", fee: "" }); drawAreas(); root.querySelector("#hsAreas [data-hsarea]:last-child [name=haName]")?.focus(); }); }
  root.querySelector("#slAddMem")?.addEventListener("click", () => { drawSalonMems(); memRows.push({ id: "mb" + Date.now().toString(36), name: "", price: "", days: 30, discountPct: 10, freeItemId: "", freeCount: 0 }); drawSalonMems(); });
  root.querySelector("#slAddPkg")?.addEventListener("click", () => { drawSalonPkgs(); pkgRows.push({ id: "pk" + Date.now().toString(36), name: "", itemId: salonItems[0]?.id || "", sessions: 5, price: "", validDays: 180 }); drawSalonPkgs(); });
  if (mode === "salon") {
    uCats = onSnapshot(query(collection(db, "stores", storeId, "categories"), orderBy("sortOrder")), (snap) => {
      salonCats = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((c) => c.active !== false);
      drawSalonPkgs();
      const box = root.querySelector("#salonTypes"); if (!box) return;
      box.innerHTML = salonCats.map((c) => `<label class="check" style="margin:0"><input type="checkbox" data-stype="${c.id}" ${s.salonTypes?.[c.id] !== false ? "checked" : ""}/> ${esc(c.name)}</label>`).join("") + `<span class="small muted" style="width:100%">Uncheck the types you don't offer (e.g. a nail salon keeps only Nails). Add more categories in Services.</span>`;
    });
  }
  let activeStaffN = 0;
  const u0 = onSnapshot(query(collection(db, "stores", storeId, "staff"), orderBy("name")), (snap) => {
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    activeStaffN = rows.filter((x) => x.active !== false).length;
    { const el = root.querySelector("#limStaff"); if (el) el.innerHTML = limitNote(ctx, "staff", activeStaffN); }
    pinList.innerHTML = rows.length ? "" : `<p class="small muted">No staff yet. Add yourself as Manager, then add your employees.</p>`;
    rows.forEach((u) => {
      const row = html(`<div class="item ${u.active === false ? "off" : ""}" style="grid-template-columns:1fr auto auto">
        <div class="info"><div class="n">${esc(u.name)}${u.planLocked && u.active !== false ? ` <span class="tag" title="Over your plan's staff slots — upgrade or add +1 staff in Billing">⏸ paused · plan limit</span>` : ""}</div><div class="d muted small">${(u.roles || []).map((r) => ROLES.find((x) => x[0] === r)?.[1] || r).join(" · ")}</div></div>
        <span class="small muted">${u.active === false ? "Resigned" : "PIN set"}</span>
        <span class="acts">${u.active === false ? `<button data-rehire title="Re-hire (set a new PIN)">↩ Re-hire</button>` : `<button data-edit title="Edit">✎</button><button data-resign title="Resigned — block access, keep history">🚪 Resigned</button>`}<button data-del title="Delete completely">🗑</button></span>
      </div>`);
      row.querySelector("[data-edit]")?.addEventListener("click", () => staffForm(u));
      row.querySelector("[data-resign]")?.addEventListener("click", async () => {
        if (!(await confirmDialog(`${u.name} resigned? Their PIN stops working right away and they're logged out of every tablet. Their name stays in reports, payroll and order history.`, { okText: "Mark as resigned" }))) return;
        try { await call("setStaffActive", { id: u.id, active: false }); toast(`${u.name} can no longer log in`); } catch (e) { toast(e.message, "error"); }
      });
      row.querySelector("[data-rehire]")?.addEventListener("click", async () => {
        try { await call("setStaffActive", { id: u.id, active: true }); toast("Re-hired — set a new PIN"); staffForm({ ...u, active: true }); } catch (e) { toast(e.message, "error"); }
      });
      row.querySelector("[data-del]").onclick = async () => {
        if (!(await confirmDialog(`Delete ${u.name} completely? Use "Resigned" instead if you want to keep them in payroll and reports.`, { okText: "Delete" }))) return;
        try { await call("removeStaff", { id: u.id }); toast("Deleted"); } catch (e) { toast(e.message, "error"); }
      };
      pinList.appendChild(row);
    });
  }, (e) => console.warn("staff", e));

  function staffForm(u) {
    const body = html(`<div>
      <label>Name</label><input name="name" value="${esc(u?.name || "")}" placeholder="e.g. Ben" />
      <label>Roles</label>
      <div class="stack" style="gap:4px">${ROLES.map(([k, l, d]) => `<label class="check" style="margin:4px 0"><input type="checkbox" name="role" value="${k}" ${(u?.roles || []).includes(k) ? "checked" : ""}/> ${l} <span class="small muted">— ${d}</span></label>`).join("")}</div>
      ${mode === "salon" ? `<div data-stylist>
        <label>Skills (categories this person can do)</label><div class="row wrap" style="gap:6px 14px">${salonCats.map((c) => `<label class="check" style="margin:0"><input type="checkbox" name="skill" value="${c.id}" ${(u?.skills || []).includes(c.id) ? "checked" : ""}/> ${esc(c.name)}</label>`).join("") || `<span class="small muted">Add categories in Services first.</span>`}</div>
        <label>Work type</label><select name="payType"><option value="daily" ${u?.payType !== "oncall" ? "selected" : ""}>Daily-paid — reports to the shop, goes back after home service</option><option value="oncall" ${u?.payType === "oncall" ? "selected" : ""}>On-call — paid per job, sets own available hours, may go straight home</option></select>
        <label>Gender <span class="small muted">(only used if customers may choose female/male)</span></label><select name="gender"><option value="">— not set —</option><option value="female" ${u?.gender === "female" ? "selected" : ""}>Female</option><option value="male" ${u?.gender === "male" ? "selected" : ""}>Male</option></select>
        <label>Short bio (shown to customers)</label><input name="bio" maxlength="120" value="${esc(u?.bio || "")}" placeholder="e.g. 8 yrs · color specialist"/>
        ${place !== "shop" ? `<label class="check"><input type="checkbox" name="doesHome" ${u?.homeService ? "checked" : ""}/> 🏠 Goes on home service (home bookings go to the people ticked here; none ticked = the owner)</label>` : ""}
        <label class="check"><input type="checkbox" name="showToCustomers" ${u?.showToCustomers !== false ? "checked" : ""}/> Show on the customer page ("Our team") so clients can request this person</label>
        <div class="form2"><div><label>Basic salary per duty day (₱, 0 = none)</label><input name="basicPerDay" type="number" min="0" value="${u?.salary?.basicPerDay ?? 0}"/></div><div><label>Allowance per duty day (₱)</label><input name="allowancePerDay" type="number" min="0" value="${u?.salary?.allowancePerDay ?? 0}"/></div><div><label class="check" style="margin-top:30px"><input type="checkbox" name="commission" ${u?.salary?.commission !== false ? "checked" : ""}/> Earns commission (per-service staff pay)</label></div></div>
        <label style="margin-top:12px">🗓 Work schedule <span class="small muted">(leave all unticked = works all open hours)</span></label>
        <div class="sched">${[["mon", "Mon"], ["tue", "Tue"], ["wed", "Wed"], ["thu", "Thu"], ["fri", "Fri"], ["sat", "Sat"], ["sun", "Sun"]].map(([k, l]) => { const d = u?.schedule?.days?.[k]; return `<div class="row" style="gap:6px;margin:3px 0"><label class="check" style="margin:0;min-width:64px"><input type="checkbox" data-day="${k}" ${d?.on ? "checked" : ""}/> ${l}</label><input type="time" data-from="${k}" value="${esc(d?.from || "")}" style="max-width:120px"/><span class="small muted">to</span><input type="time" data-to="${k}" value="${esc(d?.to || "")}" style="max-width:120px"/></div>`; }).join("")}</div>
        <div class="row" style="gap:6px;margin-top:6px"><span class="small" style="min-width:64px">Break</span><input type="time" name="brFrom" value="${esc(u?.schedule?.breakFrom || "")}" style="max-width:120px"/><span class="small muted">to</span><input type="time" name="brTo" value="${esc(u?.schedule?.breakTo || "")}" style="max-width:120px"/></div>
        <label>Leave / day-off dates</label><div class="row wrap" style="gap:6px" data-leaves>${(u?.schedule?.leaves || []).filter((x) => x >= new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)).map((x) => `<span class="pill" data-lv="${x}">${x} <a href="#" data-rmlv="${x}">✕</a></span>`).join("")}<input type="date" data-addlv style="max-width:160px"/></div>
        <label>Photo</label><div class="row"><div data-photo class="thumb" style="width:64px;height:64px">${u?.photoUrl ? `<img src="${esc(u.photoUrl)}" alt=""/>` : "👤"}</div><input type="file" accept="image/*" data-photofile/></div>
      </div>` : ""}
      <label>${u ? "New PIN (leave blank to keep current)" : "PIN (4–6 digits) — must be different for every staff member"}</label><input name="pin" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="••••" />
      ${u ? `<label class="check"><input type="checkbox" name="active" ${u.active !== false ? "checked" : ""}/> Active</label>` : ""}
    </div>`);
    const foot = html(`<div class="row" style="justify-content:flex-end"><button class="btn ghost" type="button" data-cancel>Cancel</button><button class="btn" type="button" data-save>Save</button></div>`);
    foot.querySelector("[data-cancel]").onclick = closeModal;
    let photoUrl = u?.photoUrl || null;
    let leaves = [...(u?.schedule?.leaves || [])];
    const bindLv = () => body.querySelectorAll("[data-rmlv]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); leaves = leaves.filter((x) => x !== a.dataset.rmlv); a.closest("[data-lv]").remove(); }));
    bindLv();
    body.querySelector("[data-addlv]")?.addEventListener("change", (e) => { const v = e.target.value; if (!v || leaves.includes(v)) return; leaves.push(v); e.target.insertAdjacentHTML("beforebegin", `<span class="pill" data-lv="${v}">${v} <a href="#" data-rmlv="${v}">✕</a></span>`); e.target.value = ""; bindLv(); });
    const schedule = () => body.querySelector("[data-day]") ? { days: Object.fromEntries([...body.querySelectorAll("[data-day]")].map((c) => [c.dataset.day, { on: c.checked, from: body.querySelector(`[data-from="${c.dataset.day}"]`).value || null, to: body.querySelector(`[data-to="${c.dataset.day}"]`).value || null }]).filter(([, x]) => x.on || x.from)), breakFrom: body.querySelector("[name=brFrom]").value || null, breakTo: body.querySelector("[name=brTo]").value || null, leaves } : undefined;
    body.querySelector("[data-photofile]")?.addEventListener("change", async (e) => { const f = e.target.files[0]; if (!f) return; try { photoUrl = await uploadImage(storeId, `staff-${u?.id || Date.now()}`, f, { max: 600 }); body.querySelector("[data-photo]").innerHTML = `<img src="${photoUrl}" alt=""/>`; toast("Photo uploaded"); } catch (err) { toast(err.message, "error"); } });
    foot.querySelector("[data-save]").onclick = async () => {
      const btn = foot.querySelector("[data-save]"); btn.disabled = true;
      try {
        await call("upsertStaff", { id: u?.id || null, name: body.querySelector("[name=name]").value, roles: [...body.querySelectorAll("[name=role]:checked")].map((c) => c.value), skills: [...body.querySelectorAll("[name=skill]:checked")].map((c) => c.value), gender: body.querySelector("[name=gender]") ? body.querySelector("[name=gender]").value : undefined, payType: body.querySelector("[name=payType]") ? body.querySelector("[name=payType]").value : undefined, bio: body.querySelector("[name=bio]")?.value || "", showToCustomers: body.querySelector("[name=showToCustomers]")?.checked !== false, ...(body.querySelector("[name=doesHome]") ? { homeService: body.querySelector("[name=doesHome]").checked } : {}), photoUrl, schedule: schedule(), salary: { basicPerDay: Number(body.querySelector("[name=basicPerDay]")?.value || 0), allowancePerDay: Number(body.querySelector("[name=allowancePerDay]")?.value || 0), commission: body.querySelector("[name=commission]")?.checked !== false }, pin: body.querySelector("[name=pin]").value.trim() || null, active: u ? body.querySelector("[name=active]").checked : true });
        closeModal(); toast("Saved");
      } catch (e) { toast(e.message, "error"); btn.disabled = false; }
    };
    openModal({ title: u ? `Edit ${u.name}` : "Add staff", body, footer: foot });
  }
  root.querySelector("#addStaffPin").onclick = () => { if (overLimit(ctx, "staff", activeStaffN, 1, toast)) return; staffForm(null); };

  // ---------- staff invite link / QR ----------
  const joinUrl = (t) => `${location.origin}/join/?i=${encodeURIComponent(t)}`;
  async function drawInvites() {
    const box = root.querySelector("#inviteList"); if (!box) return;
    try {
      const { invites } = await call("listStaffInvites", {});
      box.innerHTML = invites.length ? `<p class="small muted" style="margin:0 0 6px"><b>Open invites</b> — single use, expire after 7 days</p>` + invites.map((v) => `<div class="item" style="grid-template-columns:1fr auto"><div class="info"><div class="n">${esc(v.note || "Invite")} · ${v.roles.map((r) => ROLES.find((x) => x[0] === r)?.[1] || r).join(", ")}</div><div class="d small muted">Expires ${new Date(v.expiresAt).toLocaleDateString("en-PH", { month: "short", day: "numeric" })}</div></div><span class="acts"><button data-ishow="${esc(v.token)}" title="Show link & QR">🔗</button><button data-irm="${esc(v.token)}" title="Revoke">🗑</button></span></div>`).join("") : "";
      box.querySelectorAll("[data-ishow]").forEach((b) => (b.onclick = () => showInvite(b.dataset.ishow)));
      box.querySelectorAll("[data-irm]").forEach((b) => (b.onclick = async () => { if (!(await confirmDialog("Revoke this invite? The link will stop working.", { okText: "Revoke" }))) return; try { await call("revokeStaffInvite", { token: b.dataset.irm }); toast("Revoked"); drawInvites(); } catch (e) { toast(e.message, "error"); } }));
    } catch (e) { box.innerHTML = ""; console.warn("invites", e); }
  }
  async function showInvite(token) {
    const url = joinUrl(token);
    const body = html(`<div class="stack" style="align-items:center;text-align:center"><img data-iqr alt="Invite QR code" style="width:220px;border:1px solid #E5E7EB;border-radius:16px"/>
      <div class="code" style="word-break:break-all">${esc(url)}</div>
      <p class="small muted">Send this to your employee (Messenger, SMS) or let them scan the QR. They'll type their name and choose their own PIN. Works once.</p>
      <div class="row wrap" style="justify-content:center"><button class="btn sm" type="button" data-icopy>Copy link</button>${navigator.share ? `<button class="btn ghost sm" type="button" data-ishare>Share…</button>` : ""}<a class="btn ghost sm" href="sms:?&body=${encodeURIComponent(`Join our team at ${store.name}: ${url}`)}">Text (SMS)</a></div></div>`);
    body.querySelector("[data-iqr]").src = await QRCode.toDataURL(url, { width: 480, margin: 1 });
    body.querySelector("[data-icopy]").onclick = async () => { try { await navigator.clipboard.writeText(url); toast("Link copied"); } catch { toast(url); } };
    body.querySelector("[data-ishare]")?.addEventListener("click", () => navigator.share({ title: `Join ${store.name}`, text: `Join our team at ${store.name} — set your PIN here:`, url }).catch(() => {}));
    openModal({ title: "Staff invite", body });
  }
  root.querySelector("#inviteStaff").onclick = () => {
    if (overLimit(ctx, "staff", activeStaffN, 1, toast)) return;
    const body = html(`<div><label>Who is this for? (optional)</label><input name="note" maxlength="40" placeholder="e.g. New cashier"/>
      <label>Roles</label><div class="stack" style="gap:4px">${ROLES.map(([k, l, d]) => `<label class="check" style="margin:4px 0"><input type="checkbox" name="irole" value="${k}" ${k === (mode === "salon" ? "stylist" : "crew") ? "checked" : ""}/> ${l} <span class="small muted">— ${d}</span></label>`).join("")}</div>
      <p class="small muted">You can edit their roles, schedule and pay after they join.</p></div>`);
    const foot = html(`<div class="row"><button class="btn ghost" type="button" data-x>Cancel</button><button class="btn" type="button" data-mk>Create link</button></div>`);
    foot.querySelector("[data-x]").onclick = closeModal;
    foot.querySelector("[data-mk]").onclick = async (e) => {
      const roles = [...body.querySelectorAll("[name=irole]:checked")].map((c) => c.value);
      if (!roles.length) return toast("Select at least one role.", "error");
      e.target.disabled = true;
      try { const r = await call("createStaffInvite", { roles, note: body.querySelector("[name=note]").value.trim() }); closeModal(); showInvite(r.token); drawInvites(); } catch (err) { toast(err.message, "error"); e.target.disabled = false; }
    };
    openModal({ title: "Invite staff", body, footer: foot });
  };
  drawInvites();

  // ---------- staff accounts ----------
  const staffList = root.querySelector("#staffList");
  const unsub = onSnapshot(query(collection(db, "users"), where("storeId", "==", storeId)), (snap) => {
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.role === "owner" ? -1 : 1));
    staffList.innerHTML = "";
    rows.forEach((u) => {
      const row = html(`<div class="item" style="grid-template-columns:1fr auto auto">
        <div class="info"><div class="n">${esc(u.name || u.email)}</div><div class="d muted small">${esc(u.email || "")}</div></div>
        <span class="pill ${u.role === "owner" ? "active" : "trial"}">${esc(u.role)}</span>
        <span class="acts">${u.role === "owner" ? "" : `<button data-del title="Remove">🗑</button>`}</span>
      </div>`);
      row.querySelector("[data-del]")?.addEventListener("click", async () => {
        if (!(await confirmDialog(`Remove ${u.email}? They will no longer be able to log in.`, { okText: "Remove" }))) return;
        try { await call("removeStaffUser", { uid: u.id }); toast("Removed"); } catch (e) { toast(e.message, "error"); }
      });
      staffList.appendChild(row);
    });
  }, (e) => console.warn("staff list", e));

  // ---- tablets / device logins
  root.querySelector("#deviceCode").onclick = async () => {
    const name = prompt("Name this device (e.g. Counter tablet):", "Counter tablet"); if (name == null) return;
    let r; try { r = await call("createDeviceCode", { name }); } catch (e) { return toast(e.message, "error"); }
    openModal({ title: "Set up a tablet", body: html(`<div style="text-align:center">
      <p class="small muted">On the tablet, open <b>${esc(location.origin)}/counter/</b> (or /kitchen/, /staff/…) and enter this code:</p>
      <div style="font-size:40px;font-weight:700;letter-spacing:.25em;margin:10px 0">${esc(r.code)}</div>
      <p class="small muted">Valid for 10 minutes · single use. If your owner account is already logged in on that tablet, open the Counter there and tap <b>Set up this device</b> instead.</p></div>`), footer: html(`<div><button class="btn" type="button" data-close>Done</button></div>`) });
    document.querySelector("[data-close]").onclick = closeModal;
  };
  onSnapshot(collection(db, "stores", ctx.storeId, "devices"), (snap) => {
    const list = root.querySelector("#deviceList"); if (!list) return;
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((d) => !d.revoked);
    list.innerHTML = rows.length ? "" : `<p class="small muted">No tablets set up yet.</p>`;
    rows.forEach((d) => {
      const seen = d.lastSeen?.toDate ? d.lastSeen.toDate() : null;
      const row = html(`<div class="row between"><div><b>${esc(d.name || "Tablet")}</b><div class="small muted">${seen ? `Last used ${seen.toLocaleString("en-PH", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "Not used yet"}</div></div><button class="btn ghost sm danger" type="button">Remove</button></div>`);
      row.querySelector("button").onclick = async () => {
        if (!(await confirmDialog(`Remove ${d.name || "this tablet"}? It will be logged out and must be set up again.`, { okText: "Remove" }))) return;
        try { await call("revokeDevice", { deviceId: d.id }); toast("Device removed"); } catch (e) { toast(e.message, "error"); }
      };
      list.appendChild(row);
    });
  }, (e) => console.warn("devices", e));

  // ---- owner login security (trusted browsers, 2-step, log out everywhere)
  {
    const list = root.querySelector("#trustedList"), two = root.querySelector("#twoStep");
    const fmt = (ms) => ms ? new Date(ms).toLocaleString("en-PH", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
    const load = async () => {
      let st; try { st = await securityStatus(); } catch (e) { list.innerHTML = `<p class="small muted">${esc(e.message)}</p>`; return; }
      two.checked = !!st.twoStep;
      list.innerHTML = st.devices.length ? "" : `<p class="small muted">No trusted browsers yet — this one is added on your next login.</p>`;
      st.devices.forEach((d) => {
        const row = html(`<div class="row between"><div><b>${esc(d.name || "Browser")}</b>${d.current ? ' <span class="badge">This browser</span>' : ""}<div class="small muted">Last used ${fmt(d.lastAt)} · added ${fmt(d.at)}</div></div>${d.current ? "" : '<button class="btn ghost sm" type="button">Forget</button>'}</div>`);
        const b = row.querySelector("button"); if (b) b.onclick = async () => { try { await forgetTrustedDevice(d.id); toast("Browser forgotten — it will need to confirm again."); load(); } catch (e) { toast(e.message, "error"); } };
        list.appendChild(row);
      });
    };
    load();
    two.onchange = async () => {
      if (two.checked) {
        two.checked = false; // stays off until the test link is opened
        const email = auth.currentUser?.email;
        if (!email) return toast("Your account needs an email address for 2-step.", "error");
        if (!(await confirmDialog(`We'll send a test login link to ${email}. 2-step turns on only after you open that link on this device — so you can't get locked out.`, { okText: "Send test link" }))) return;
        try { await startTwoStep(email); toast(`Link sent to ${email}. Open it on this device to finish (check Spam too).`); }
        catch (e) { toast(e.code === "auth/operation-not-allowed" ? "Email-link login isn't enabled yet: Firebase → Authentication → Sign-in method → Email/Password → Email link." : e.message, "error"); }
        return;
      }
      if (!(await confirmDialog("Turn off 2-step? New browsers will log in with just the password.", { okText: "Turn off" }))) { two.checked = true; return; }
      try { await setTwoStep(false); toast("2-step is off"); } catch (e) { two.checked = true; toast(e.message, "error"); }
    };
    root.querySelector("#logoutAll").onclick = async () => {
      if (!(await confirmDialog("Log out everywhere? All sessions (including this one) end and every trusted browser is forgotten. Every other device is logged out right away.", { okText: "Log out everywhere" }))) return;
      try { await logoutEverywhere(); location.replace("/login/"); } catch (e) { toast(e.message, "error"); }
    };
  }

  root.querySelector("#addStaff").onclick = () => {
    const body = html(`<div>
      <label>Name</label><input name="name" placeholder="e.g. Kuya Ben" />
      <label>Email (used to log in)</label><input name="email" type="email" placeholder="kitchen@kapehan.ph" />
      <label>Password</label><input name="password" type="text" placeholder="min 6 characters" />
      <label>Role</label>
      <select name="role"><option value="kitchen">Kitchen — kitchen screen and orders only</option><option value="staff">Staff — orders, sold out, tables</option></select>
      <p class="small muted" style="margin-top:10px">Give the email and password to your staff. You can also create one shared account for the whole kitchen (e.g. kitchen@…).</p>
    </div>`);
    const foot = html(`<div class="row" style="justify-content:flex-end"><button class="btn ghost" type="button" data-cancel>Cancel</button><button class="btn" type="button" data-save>Create account</button></div>`);
    foot.querySelector("[data-cancel]").onclick = closeModal;
    foot.querySelector("[data-save]").onclick = async () => {
      const g = (n) => body.querySelector(`[name=${n}]`).value.trim();
      const btn = foot.querySelector("[data-save]");
      btn.disabled = true;
      try {
        await call("createStaffUser", { name: g("name"), email: g("email"), password: g("password"), role: g("role") });
        closeModal(); toast("Staff account created");
      } catch (e) { toast(e.message, "error"); btn.disabled = false; }
    };
    openModal({ title: "Add staff account", body, footer: foot });
  };

  return () => { unsub(); u0(); uCats(); };
}
