// PLANS — one plan per business. Change prices, limits and what each plan includes here.
// (functions/plans.js and src/plans.js are generated from the same text — keep them identical.)
//
//  Free ₱0      small use: café = menu + counter only · salon = solo / home-service freelancer, 2 bookings a day · 15 a month · massage/spa 3 a day · 20 a month · laundry 15 jobs/day · stay 30 bookings/month
//  Basic ₱99    kitchen & barista screens, 2 staff, shifts, reports, call staff, ratings  (key "starter" kept for existing data)
//  New accounts get Basic free for 14 days ("trial"), then go back to Free unless they upgrade.
//  Pro ₱499     dispatch, delivery + rider, promos, loyalty, reservations, client card, packages…
//  Business ₱999  everything: gift cards, events/VIP, memberships, Telegram, SMS, white-label (no "Powered by")
const PLANS = {
  trial:    { name: "Basic (free for 14 days)", price: 0, tier: 1, days: 14 },
  free:     { name: "Free",       price: 0,   tier: 0, blurb: "For small use — try it for real, no time limit" },
  starter:  { name: "Basic",      price: 99,  tier: 1, blurb: "Your own kitchen screen and a small team" },
  plus:     { name: "Pro",        price: 499, tier: 2, blurb: "Delivery, promos, loyalty and the full toolkit" },
  business: { name: "Business",   price: 999, tier: 3, blurb: "Everything, bigger limits, your brand only" },
  // freelancers & creators: one cheap plan (no Basic / Business tiers — it's a raket, not a shop)
  creator:  { name: "Creator Pro", price: 79, tier: 2, only: "freelance", blurb: "Unlimited deals, portfolio, promos, rush & contracts" },
  // older plans (kept so existing subscribers keep what they paid for)
  basic:    { name: "Pro",        price: 499, tier: 2, legacy: true },
  pro:      { name: "Business",   price: 999, tier: 3, legacy: true },
};
const SELLABLE = ["starter", "plus", "business"];
const CREATOR_SELLABLE = ["creator"];
/** the plans a business can buy (freelancers: Creator Pro only) */
const sellableFor = (store) => (store?.businessType === "freelance" ? CREATOR_SELLABLE : SELLABLE);
const TIER_KEYS = ["free", "starter", "plus", "business"];
const UNLIMITED = 1e9;
const U = UNLIMITED;

// LIMITS per business type: [Free, Basic, Pro, Business]
const LIMITS = {
  table:   { items: [10, 25, 80, 300], tables: [2, 4, 12, 40], staff: [1, 3, 6, 16], ordersPerDay: [20, U, U, U], creatorOffers: [1, 3, 10, U], collabPosts: [0, 0, 1, U], xdealsPerMonth: [U, U, U, U] },
  salon:   { items: [8, 20, 60, 200], staff: [1, 2, 5, 15], bookingsPerDay: [2, U, U, U], bookingsPerMonth: [15, U, U, U], homeAreas: [2, 3, 5, U], creatorOffers: [1, 3, 10, U], collabPosts: [0, 0, 1, U], xdealsPerMonth: [U, U, U, U] },
  spa:     { items: [8, 20, 60, 200], staff: [3, 5, 10, 20], rooms: [1, 3, 8, 20], bookingsPerDay: [3, U, U, U], bookingsPerMonth: [20, U, U, U], homeAreas: [2, 3, 5, U], creatorOffers: [1, 3, 10, U], collabPosts: [0, 0, 1, U], xdealsPerMonth: [U, U, U, U] },
  laundry: { items: [5, 10, 30, 100], staff: [1, 3, 6, 16], jobsPerDay: [15, U, U, U], creatorOffers: [1, 3, 10, U], collabPosts: [0, 0, 1, U], xdealsPerMonth: [U, U, U, U] },
  stay:    { rooms: [1, 3, 10, 40], photos: [3, 6, 15, 30], staff: [1, 3, 6, 16], bookingsPerMonth: [30, U, U, U], creatorOffers: [1, 3, 10, U], collabPosts: [0, 0, 1, U], xdealsPerMonth: [U, U, U, U] },
  pickup:  { items: [10, 25, 80, 300], staff: [1, 3, 6, 16], ordersPerDay: [20, U, U, U], creatorOffers: [1, 3, 10, U], collabPosts: [0, 0, 1, U], xdealsPerMonth: [U, U, U, U] },
  // freelancer / creator — columns used: Free (0) and Creator Pro (tier 2)
  freelance: { items: [10, 20, 60, 200], staff: [1, 1, 2, 5], bookingsPerDay: [3, U, U, U], bookingsPerMonth: [20, U, U, U], homeAreas: [3, 3, U, U], dealsPerMonth: [3, U, U, U], portfolio: [6, 6, 40, 40], xdealsPerMonth: [2, 2, U, U] },
};
const LIMIT_LABEL = { items: "items", tables: "tables", staff: "staff PINs (incl. you)", ordersPerDay: "orders a day", dealsPerMonth: "brand deals a month", portfolio: "portfolio samples", creatorOffers: "offers to creators a month", collabPosts: "open collab posts", xdealsPerMonth: "X-Deals & B2B swaps a month (free for businesses)", bookingsPerMonth: "bookings a month", bookingsPerDay: "bookings a day", jobsPerDay: "jobs a day", homeAreas: "home-service areas", rooms: "rooms", photos: "photos per room" };

// FEATURES: the lowest plan that includes it (0 Free · 1 Basic · 2 Pro · 3 Business). An add-on unlocks it earlier.
const FEATURE_TIER = {
  stations: 1,     // café: Kitchen & Barista screens (Free = the counter does everything)
  staffpins: 1,    // staff PIN accounts (Free = owner only; salon Free = the owner as the only stylist)
  salonteam: 1,    // salon: more than one stylist / reception
  callstaff: 1, feedback: 1, shifts: 1, reports: 1, salondp: 1, editorder: 1,
  dispatch: 2, delivery: 2, duty: 2, promos: 2, vouchers: 2, reservations: 2, waitlist: 2, loyalty: 2, clientcard: 2,
  packages: 2, retail: 2, announcements: 2, themes: 2, salonremind: 2, referral: 2, birthday: 2, queuetv: 2,
  giftcards: 3, memberships: 3, events_vip: 3, telegram: 3, sms: 3, whitelabel: 3,
};
const PRO_FEATURES = {
  stations: "Kitchen & barista screens", staffpins: "Staff PINs", salonteam: "Team of stylists & reception",
  callstaff: "Call staff from the table", feedback: "Customer ratings & incident reports", shifts: "Shifts & blind cash count",
  reports: "Reports & audit log", salondp: "Salon reservation fee (DP)", editorder: "Edit orders, free items",
  dispatch: "Dispatch / plating station", delivery: "Delivery + rider app", duty: "Staff duty board", promos: "Promos, combos & dish promos",
  vouchers: "Voucher codes", reservations: "Table reservations & pre-orders", waitlist: "Waitlist QR", loyalty: "Loyalty stamps",
  clientcard: "Client card", packages: "Prepaid packages", retail: "Retail products", announcements: "News & announcements",
  themes: "Seasonal themes", salonremind: "SMS reminders", referral: "Referral rewards", birthday: "Birthday promos", queuetv: "Queue TV display",
  giftcards: "Gift cards", memberships: "Memberships", events_vip: "Events & VIP rooms", telegram: "Telegram alerts", sms: "SMS promos", whitelabel: "No “Powered by taptayo” (your brand only)",
};

// ADD-ONS (monthly). qty = can be bought more than once. minTier = from which plan it can be added.
const ADDONS = {
  staff1:    { name: "+1 staff",              price: 29,  qty: true, adds: { staff: 1 }, minTier: 1, blurb: "One more staff PIN" },
  items20:   { name: "+20 menu items",        price: 29,  qty: true, adds: { items: 20 }, minTier: 0, blurb: "Twenty more items or services" },
  tables4:   { name: "+4 tables / +2 rooms",  price: 29,  qty: true, adds: { tables: 4, rooms: 2 }, minTier: 0, blurb: "More table QRs (or rooms)" },
  delivery:  { name: "Delivery + Rider app",  price: 99,  unlocks: ["delivery"], minTier: 1, blurb: "Delivery orders, COD, rider screen, laundry pickups" },
  queuetv:   { name: "Queue TV",              price: 49,  unlocks: ["queuetv"], minTier: 1, blurb: "Order / queue numbers on a TV" },
  telegram:  { name: "Telegram alerts",       price: 49,  unlocks: ["telegram"], minTier: 0, blurb: "Alerts on your phone when you're away" },
  giftcards: { name: "Gift cards",            price: 99,  unlocks: ["giftcards"], minTier: 1, blurb: "Sell gift cards online & at the counter" },
  events_vip:{ name: "Events & VIP rooms",    price: 149, unlocks: ["events_vip"], minTier: 1, blurb: "Event packages, VIP/KTV rooms" },
  sms:       { name: "SMS promos",            price: 99,  unlocks: ["sms"], minTier: 1, blurb: "Text promos (your own Semaphore credits)" },
  protect:   { name: "TapTayo Protect",       price: 149, minTier: 0, notFor: "freelance", blurb: "If a creator ghosts an X-Deal, we cover the declared item value (up to ₱1,500 a claim) as TapTayo credits" },
  collab:    { name: "Creator Collab",        price: 199, adds: { creatorOffers: 1e9, collabPosts: 1e9 }, minTier: 0, notFor: "freelance", blurb: "Unlimited offers to creators + open collab posts" },
  // BUNDLES — related add-ons together for less. pack = what it includes (shown in Billing). Special features stay single.
  opsPack:   { name: "Operations Pack",       price: 149, unlocks: ["delivery", "queuetv", "telegram"], pack: ["delivery", "queuetv", "telegram"], minTier: 1, blurb: "Delivery + Rider app, Queue TV and Telegram alerts (save ₱48)" },
  mktPack:   { name: "Marketing Pack",        price: 249, unlocks: ["giftcards", "sms"], pack: ["giftcards", "sms", "collab"], adds: { creatorOffers: 1e9, collabPosts: 1e9 }, minTier: 1, notFor: "freelance", blurb: "Gift cards, SMS promos and Creator Collab (save ₱148)" },
  branch:    { name: "+1 branch",             price: 149, qty: true, minTier: 1, blurb: "Another branch under the same account" },
  // older add-ons (existing subscribers)
  branches3: { name: "Branches: up to 4", price: 90,  legacy: true, group: "branches" },
  branches6: { name: "Branches: up to 7", price: 180, legacy: true, group: "branches" },
  branches9: { name: "Branches: up to 10", price: 270, legacy: true, group: "branches" },
  vouchersOld: { name: "Voucher codes", price: 149, legacy: true },
};

/** the bundle that includes this add-on (for "save with the pack" hints), or null */
const packFor = (key) => Object.entries(ADDONS).find(([, a]) => a.pack?.includes(key))?.[0] || null;
/** The plan in effect: trial/paid/provisional (payment being checked) → else Free. Never "locked" for Free. */
function planOf(sub) {
  if (!sub) return "free";
  const now = Date.now(), ms = (t) => (t?.toMillis ? t.toMillis() : Number(t) || 0);
  if (sub.status === "locked" && sub.plan !== "free") return "free";
  if (sub.provisional && ms(sub.provisional.until) > now && PLANS[sub.provisional.plan]) return sub.provisional.plan;
  if (sub.plan === "trial") return ms(sub.trialEndsAt) > now ? "trial" : "free";
  if (PLANS[sub.plan] && sub.plan !== "free") { const until = ms(sub.paidUntil); if (sub.comp || !until || until + 3 * 86400000 > now) return sub.plan; return "free"; }
  return "free";
}
const tierOf = (sub) => PLANS[planOf(sub)]?.tier ?? 0;
const addonQty = (sub, key) => {
  const ms = (t) => (t?.toMillis ? t.toMillis() : Number(t) || 0);
  const prov = sub?.provisional && ms(sub.provisional.until) > Date.now() ? sub.provisional.addons || {} : {};
  const until = ms(sub?.paidUntil), paidOk = sub?.comp || sub?.plan === "trial" || !until || until + 3 * 86400000 > Date.now();
  const v = prov[key] != null ? prov[key] : paidOk ? sub?.addons?.[key] : 0;
  return v === true ? 1 : Math.max(0, Number(v) || 0);
};

/** Does the store have access to this feature / add-on? */
function entitled(sub, key) {
  if (key && key.startsWith("branches")) return !!(sub?.addons && sub.addons[key]);
  if (key === "vouchers" && sub?.addons?.vouchers) return true;
  if (key === "feedback" && sub?.addons?.feedback) return true;
  const tier = tierOf(sub);
  if (ADDONS[key] && addonQty(sub, key) > 0) return true;
  for (const [k, a] of Object.entries(ADDONS)) if ((a.unlocks?.includes(key) || a.pack?.includes(key)) && addonQty(sub, k) > 0) return true;
  const need = FEATURE_TIER[key];
  return need == null ? true : tier >= need;
}
/** Limits for this business type + bought add-ons. */
function limitsFor(sub, mode) {
  const t = tierOf(sub), base = LIMITS[mode] || LIMITS.table, out = {};
  for (const [k, arr] of Object.entries(base)) out[k] = arr[Math.min(3, t)];
  for (const [k, a] of Object.entries(ADDONS)) { const q = addonQty(sub, k); if (q && a.adds) for (const [lk, n] of Object.entries(a.adds)) if (out[lk] != null && out[lk] < UNLIMITED) out[lk] += n * q; }
  return out;
}
const branchesAllowedFor = (sub) => { let max = 1; for (const [k, m] of [["branches3", 4], ["branches6", 7], ["branches9", 10]]) if (sub?.addons?.[k]) max = Math.max(max, m); max += addonQty(sub, "branch"); if (planOf(sub) === "trial") max = Math.max(max, 2); return max; };
/** which limits table a store uses (massage & spa runs on the salon engine with its own limits) */
const limitMode = (store) => (store?.businessType === "spa" ? "spa" : store?.businessType === "freelance" ? "freelance" : store?.mode || "table");
const GRACE_DAYS = 3;
const MONTH_DAYS = 30;

module.exports = { packFor, PLANS, SELLABLE, CREATOR_SELLABLE, sellableFor, TIER_KEYS, LIMITS, LIMIT_LABEL, FEATURE_TIER, PRO_FEATURES, ADDONS, UNLIMITED, planOf, tierOf, addonQty, entitled, limitsFor, limitMode, branchesAllowedFor, GRACE_DAYS, MONTH_DAYS };
