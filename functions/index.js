const { onCall: onCallRaw, HttpsError, onRequest } = require("firebase-functions/v2/https");
// Every callable goes through ownerSessionGuard: an owner session must not be revoked ("Log out everywhere")
// and, with 2-step on, must have been approved (trusted browser or email-link confirmation).
// Exempt (use onCallRaw): createStore, securityStatus, trustDevice, logoutEverywhere.
const onCall = (opts, fn) => {
  if (typeof opts === "function") { fn = opts; opts = {}; }
  return onCallRaw(opts, async (req) => { await ownerSessionGuard(req); return fn(req); });
};
const { setGlobalOptions } = require("firebase-functions/v2");
const { onDocumentWritten, onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { PRESETS, MODE_DEFAULTS, TRIAL_DAYS, TRIAL_LIMITS } = require("./presets");
const { PLANS, SELLABLE, sellableFor, GRACE_DAYS, MONTH_DAYS, ADDONS, PRO_FEATURES, entitled, limitsFor, limitMode, planOf, tierOf, addonQty, UNLIMITED, LIMIT_LABEL } = require("./plans.js");
const { calcSalonPromos, salonPromoTag } = require("./salonpromo.js");
const { promoForItem, freeDeliveryPromo, lineDiscount, promoLabel, voucherDiscount, round2, promoActive, overtimeFor } = require("./promo.js");

admin.initializeApp();
const db = getFirestore();
if (typeof db.settings === "function") db.settings({ ignoreUndefinedProperties: true }); // a missing optional field never breaks a write

// Singapore region = closest to the Philippines. Must match VITE_FUNCTIONS_REGION.
// Cloud Run counts (max instances × CPU) of EVERY function against the region's CPU quota, so most functions
// stay small (2). The busy customer / counter functions get more room (HOT below).
setGlobalOptions({ region: "asia-southeast1", maxInstances: 2 });
const HOT = { maxInstances: 8 };

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function slugify(s) {
  return String(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

const RESERVED_SLUGS = new Set(["app", "m", "kitchen", "admin", "api", "login", "signup", "www"]);

/** Find a slug not yet in use: "kapehan", "kapehan-2", "kapehan-3", ... */
async function uniqueSlug(base) {
  let slug = base || "store";
  if (RESERVED_SLUGS.has(slug)) slug = slug + "-1";
  for (let i = 2; i < 50; i++) {
    const taken = await db.collection("publicStores").doc(slug).get();
    if (!taken.exists) return slug;
    slug = `${base}-${i}`;
  }
  // fallback: random suffix
  return `${base}-${Math.random().toString(36).slice(2, 6)}`;
}

function requireAuth(req) {
  if (!req.auth) throw new HttpsError("unauthenticated", "Please log in first.");
  return req.auth;
}

// ---------------------------------------------------------------------------
// createStore — called by the setup wizard after signup
// ---------------------------------------------------------------------------
/** Build a store (first store or a branch). Returns { storeId, slug }. */
async function buildStore({ uid, token, data, orgId, copyFrom = null }) {
  const name = String(data.name || "").trim();
  const businessType = String(data.businessType || "").trim();
  const phone = String(data.phone || "").trim().slice(0, 30);
  const address = String(data.address || "").trim().slice(0, 200);
  if (name.length < 2 || name.length > 60) throw new HttpsError("invalid-argument", "Business name must be 2–60 characters.");
  const preset = PRESETS[businessType];
  if (!preset) throw new HttpsError("invalid-argument", `Unknown business type: ${businessType}`);
  // Stay / Airbnb is open for sign-ups (Oct 2026).
  const slug = await uniqueSlug(slugify(name));
  const storeRef = db.collection("stores").doc();
  const storeId = storeRef.id;
  const now = FieldValue.serverTimestamp();
  const src = copyFrom ? (await db.doc(`stores/${copyFrom}`).get()).data() : null;
  const store = {
    name, slug, businessType, mode: preset.mode, ownerUid: uid, orgId, referredBy: typeof data.ref === "string" && /^[a-z0-9-]{2,60}$/.test(data.ref) ? data.ref : null,
    logoUrl: src?.logoUrl || null, coverUrl: src?.coverUrl || null,
    theme: src?.theme || preset.theme,
    contact: { phone, address },
    hours: src?.hours || {},
    settings: src ? { ...src.settings, pause: null, telegram: null, sms: null } : { currency: "PHP", labels: preset.labels, ...MODE_DEFAULTS[preset.mode] },
    createdAt: now, updatedAt: now,
  };
  // business setup picked in the wizard (salon: team / solo; café: shop / home-based) + guided setup state
  const setup = setupFrom(preset.mode, data.setup);
  if (!src) {
    store.settings.setup = setup;
    store.settings.live = false; // "Coming soon" until the owner taps Go live
    store.settings.onboarding = { done: {}, later: {}, tourDone: false, startedAt: Date.now() };
    if (preset.mode === "salon") store.settings.salon = { ...(store.settings.salon || {}), ownerWorks: setup.kind === "solo" || !!setup.ownerWorks, ...(setup.place !== "shop" ? { homeService: { enabled: true, fee: 0, note: "", travelMin: 30, areas: [], exclusive: true } } : {}), ...(setup.kind === "solo" ? { allowAnyone: true } : {}) };
    if (businessType === "spa") store.settings.salon = { ...store.settings.salon, rooms: [], roomBufferMin: 10, allowPax2: true, genderPick: true, intake: { enabled: true } };
  if (businessType === "spa") store.settings.policies = { ...(store.settings.policies || {}), salon: "• Please arrive 10 minutes early to change and relax. A 15-minute grace period applies; late arrivals may get a shorter session.\n• Cancel or reschedule at least 2 hours before your booking.\n• Tell your therapist about injuries, pregnancy, allergies or medical conditions before the session.\n• Repeated no-shows may require a reservation fee for future bookings.\n• Our therapists offer professional massage only — any inappropriate request ends the session without refund.\n• Home service: please prepare a safe, private space. Our rider drops off and picks up the therapist." };
    if (preset.mode === "table" && setup.kind === "home") store.settings.service = { ...(store.settings.service || {}), dineIn: false, takeOut: false, pickup: true, delivery: true };
  }
  const batch = db.batch();
  batch.set(storeRef, store);
  let categories = [];
  if (src) {
    // copy categories + items + promos from the source branch
    const [cats, items, promos] = await Promise.all([db.collection(`stores/${copyFrom}/categories`).get(), db.collection(`stores/${copyFrom}/items`).get(), db.collection(`stores/${copyFrom}/promos`).get()]);
    const catMap = {};
    cats.docs.forEach((d) => { const ref = storeRef.collection("categories").doc(); catMap[d.id] = ref.id; batch.set(ref, { ...d.data(), createdAt: now }); categories.push({ id: ref.id, name: d.data().name, sortOrder: d.data().sortOrder }); });
    items.docs.forEach((d) => { const it = d.data(); batch.set(storeRef.collection("items").doc(), { ...it, categoryId: catMap[it.categoryId] || it.categoryId, createdAt: now }); });
    promos.docs.forEach((d) => { const pr = d.data(); batch.set(storeRef.collection("promos").doc(), { ...pr, categoryIds: (pr.categoryIds || []).map((c) => catMap[c] || c), itemIds: [], createdAt: now }); });
  } else {
    categories = preset.categories.map((catName, i) => {
      const ref = storeRef.collection("categories").doc();
      const station = /drink|beverage|coffee|dessert/i.test(catName) ? "barista" : "kitchen";
      batch.set(ref, { name: catName, sortOrder: i + 1, active: true, station, createdAt: now });
      return { id: ref.id, name: catName, sortOrder: i + 1 };
    });
    const seed = (rows) => rows.forEach(([cat, n, price, extra], i) => { const c = categories.find((x) => x.name === cat); if (!c) return; batch.set(storeRef.collection("items").doc(), { categoryId: c.id, name: n, price, available: true, options: [], sortOrder: i + 1, createdAt: now, ...extra }); });
    if (preset.mode === "table") seed([["Drinks", "Iced Latte", 120, { description: "Espresso, milk, ice", options: [{ name: "Size", required: true, multi: false, choices: [{ label: "Regular", add: 0 }, { label: "Large", add: 25 }] }] }], ["Drinks", "Americano", 100, {}], ["Drinks", "Matcha Latte", 140, {}], ["Food", "Carbonara", 180, { description: "Creamy, with bacon bits" }], ["Food", "Clubhouse Sandwich", 160, {}], ["Desserts", "Cheesecake slice", 120, {}]]);
    if (businessType === "spa") {
      const sp = (v) => ({ durationMinutes: v, staffPay: { type: "percent", value: 35 } });
      seed([["Massage", "Swedish massage (60 min)", 500, { ...sp(60), description: "Relaxing full-body oil massage" }], ["Massage", "Hilot (90 min)", 750, { ...sp(90), description: "Traditional Filipino healing massage" }], ["Massage", "Shiatsu (60 min)", 600, { ...sp(60), description: "Dry pressure-point massage" }], ["Massage", "Deep tissue (90 min)", 850, sp(90)], ["Foot spa", "Foot spa & reflexology (45 min)", 350, sp(45)], ["Body scrub", "Body scrub (60 min)", 650, sp(60)], ["Facial", "Basic facial (60 min)", 600, sp(60)], ["Add-ons", "Ventosa / hot stone add-on (30 min)", 250, sp(30)]]);
    }
    if (businessType === "freelance") {
      store.settings.solo = { enabled: true, rider: "none" };
      store.settings.salon = { ...(store.settings.salon || {}), ownerWorks: true, allowAnyone: false, deposit: { enabled: true, amount: 500, minTotal: 0 }, freelance: { quotes: true, platforms: [] } };
      seed([["Shoots & sessions", "Portrait / product shoot (2 hours)", 3500, { durationMinutes: 120, description: "Includes 20 edited photos" }], ["Shoots & sessions", "Makeup session", 2500, { durationMinutes: 90 }], ["Whole-day events", "Whole-day event coverage", 15000, { durationMinutes: 600, wholeDay: true, description: "Weddings, debuts, corporate — blocks the whole day" }], ["Content & collabs", "1 TikTok / Reel (brand collab)", 5000, { durationMinutes: 60, description: "Concept, shoot, edit, 1 revision" }], ["Add-ons", "Extra edited photos (10)", 1000, { durationMinutes: 15 }]]);
    } else if (preset.mode === "salon" && businessType !== "spa") seed([["Hair", "Haircut (women)", 350, { durationMinutes: 45, staffPay: { type: "percent", value: 30 } }], ["Hair", "Hair color (full)", 1500, { durationMinutes: 120, staffPay: { type: "percent", value: 30 } }], ["Hair", "Rebond / keratin", 2500, { durationMinutes: 180, staffPay: { type: "percent", value: 30 } }], ["Hair extension", "Hair extension (per bundle)", 2000, { durationMinutes: 120, staffPay: { type: "fixed", value: 400 } }], ["Lashes", "Classic lash extension", 999, { durationMinutes: 90, staffPay: { type: "percent", value: 35 } }], ["Lashes", "Lash lift & tint", 650, { durationMinutes: 60, staffPay: { type: "percent", value: 35 } }], ["Brows", "Brow shaping & tint", 350, { durationMinutes: 30, staffPay: { type: "percent", value: 35 } }], ["Nails", "Gel manicure", 450, { durationMinutes: 60, staffPay: { type: "percent", value: 35 } }], ["Nails", "Gel pedicure", 550, { durationMinutes: 60, staffPay: { type: "percent", value: 35 } }], ["Aesthetic", "Classic facial", 800, { durationMinutes: 60, staffPay: { type: "percent", value: 30 } }], ["Aesthetic", "Diamond peel", 1200, { durationMinutes: 45, staffPay: { type: "percent", value: 30 } }], ["Aesthetic", "RF skin tightening (machine)", 1500, { durationMinutes: 60, staffPay: { type: "percent", value: 25 } }], ["Aesthetic", "IPL hair removal (underarm)", 900, { durationMinutes: 30, staffPay: { type: "percent", value: 25 } }], ["Aesthetic", "Underarm whitening", 600, { durationMinutes: 30, staffPay: { type: "percent", value: 30 } }]]);
    if (preset.mode === "stay") {
      [["Garden Room", "Cozy · nature view", 2, "1 queen bed", 1800, 2300, ["Aircon", "WiFi", "Hot shower", "Smart TV", "Pool access"]], ["Family Suite", "Spacious · good for groups", 6, "2 queen beds + sofa bed", 3500, 4200, ["Aircon", "WiFi", "Kitchen", "Hot shower", "Balcony", "Pool access", "Parking"]]].forEach(([n, theme, cap, beds, price, wk, am], i) =>
        batch.set(storeRef.collection("rooms").doc(), { name: n, theme, capacity: cap, beds, price, weekendPrice: wk, amenities: am, description: "", photos: [], posters: [], rules: "", active: true, sortOrder: i + 1, createdAt: now }));
    }
    if (preset.mode === "laundry") {
      const SAMPLE = [["Wash · Dry · Fold", "Wash · Dry · Fold", 45, "kg", "Regular detergent included"], ["Wash only", "Wash only", 30, "kg", ""], ["Dry only", "Dry only", 25, "kg", ""], ["Dry clean", "Dry clean — barong / suit / gown", 0, "estimate", "Quoted after inspection"], ["Add-ons", "Extra detergent", 15, "piece", ""], ["Add-ons", "Fabric conditioner", 15, "piece", ""], ["Add-ons", "Extra rinse", 10, "piece", ""], ["Add-ons", "Hand wash (per piece)", 40, "piece", "Delicate items"]];
      SAMPLE.forEach(([cat, n, price, unit, desc], i) => { const c = categories.find((x) => x.name === cat); if (!c) return; batch.set(storeRef.collection("items").doc(), { categoryId: c.id, name: n, price, unit, description: desc, available: true, options: [], sortOrder: i + 1, createdAt: now }); });
    }
  }
  batch.set(db.doc(`publicStores/${slug}`), { storeId, name, slug, businessType, mode: preset.mode, theme: store.theme, labels: store.settings.labels || preset.labels, contact: { phone, address }, acceptOrders: true, locked: false, categories, items: [], updatedAt: now });
  await batch.commit();
  // the owner works too (salon solo / owner works with staff / home-based café) → a staff profile with a PIN for the counter & screens
  if (!src && data.createOwnerStaff === true && ownerProfileNeeded(preset.mode, setup)) {
    const pin = String(data.ownerPin || "");
    if (!/^\d{4,6}$/.test(pin)) throw new HttpsError("invalid-argument", "Set a 4–6 digit PIN for yourself.");
    const roles = preset.mode === "salon" ? ["manager", "crew", "stylist"] : ["manager", "crew", "kitchen", "barista", "dispatch", "rider"];
    const sref = storeRef.collection("staff").doc();
    await sref.set({ name: String(data.ownerName || token.name || "Owner").trim().slice(0, 40) || "Owner", roles, active: true, isOwner: true, skills: [], photoUrl: null, bio: "", showToCustomers: true, salary: { basicPerDay: 0, commission: false }, sortOrder: 0, createdAt: now, updatedAt: now, lastAssignedAt: null, jobsTotal: 0 });
    await db.doc(`stores/${storeId}/private/staffPins`).set({ [sref.id]: pinHash(storeId, pin) }, { merge: true });
  }
  return { storeId, slug, mode: preset.mode, preset };
}
function setupFrom(mode, s) {
  const k = String(s?.kind || "");
  if (mode === "salon") { const place = ["shop", "home", "both"].includes(s?.place) ? s.place : k === "solo" ? "both" : "shop"; return { kind: k === "solo" ? "solo" : "team", ownerWorks: k === "solo" || !!s?.ownerWorks, place }; }
  if (mode === "table") return { kind: k === "home" ? "home" : "shop" };
  return { kind: "default" };
}
const ownerProfileNeeded = (mode, setup) => (mode === "salon" && (setup.kind === "solo" || setup.ownerWorks)) || (mode === "table" && setup.kind === "home");
/** Owner: change the business setup later (Tools → Business setup) */
exports.changeSetup = onCall(async (req) => {
  const t = requireOwner(req);
  const store = (await db.doc(`stores/${t.storeId}`).get()).data();
  const setup = setupFrom(store.mode, req.data?.setup || {});
  const patch = { "settings.setup": setup, updatedAt: FieldValue.serverTimestamp() };
  if (store.mode === "salon") { patch["settings.salon.ownerWorks"] = setup.kind === "solo" || !!setup.ownerWorks; patch["settings.salon.homeService"] = { travelMin: 30, areas: [], exclusive: true, fee: 0, note: "", ...(store.settings?.salon?.homeService || {}), enabled: setup.place !== "shop" }; }
  if (store.mode === "table" && setup.kind === "home") Object.assign(patch, { "settings.service.dineIn": false, "settings.service.takeOut": false, "settings.service.pickup": true, "settings.service.delivery": true });
  if (store.mode === "table" && setup.kind === "shop") Object.assign(patch, { "settings.service.dineIn": true, "settings.service.takeOut": true });
  await db.doc(`stores/${t.storeId}`).update(patch);
  // make sure the owner has a staff profile when they work too
  if (ownerProfileNeeded(store.mode, setup)) {
    const has = (await db.collection(`stores/${t.storeId}/staff`).where("isOwner", "==", true).limit(1).get()).docs[0];
    if (!has) {
      const pin = String(req.data?.ownerPin || ""); if (!/^\d{4,6}$/.test(pin)) throw new HttpsError("invalid-argument", "Set a 4–6 digit PIN for yourself.");
      const pins = (await db.doc(`stores/${t.storeId}/private/staffPins`).get()).data() || {};
      if (Object.values(pins).includes(pinHash(t.storeId, pin))) throw new HttpsError("already-exists", "That PIN is already used by a staff member.");
      const sref = db.collection(`stores/${t.storeId}/staff`).doc();
      await sref.set({ name: String(req.data?.ownerName || "Owner").slice(0, 40), roles: store.mode === "salon" ? ["manager", "crew", "stylist"] : ["manager", "crew", "kitchen", "barista", "dispatch", "rider"], active: true, isOwner: true, skills: [], showToCustomers: true, salary: { basicPerDay: 0, commission: false }, sortOrder: 0, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      await db.doc(`stores/${t.storeId}/private/staffPins`).set({ [sref.id]: pinHash(t.storeId, pin) }, { merge: true });
    }
  }
  return { ok: true, setup };
});

// ---- SIGNUP OTP (TapTayo's own Semaphore account, set in Admin → Settings) ----
const otpHash = (uid, code) => crypto.createHash("sha256").update(`${uid}:${code}`).digest("hex");
exports.sendSignupOtp = onCallRaw(async (req) => {
  const { uid } = requireAuth(req);
  const cfg = (await db.doc("config/platformSms").get()).data() || {};
  if (!cfg.apiKey || cfg.required === false) return { skipped: true };
  const phone = phPhone(req.data?.phone);
  if (!phone) throw new HttpsError("invalid-argument", "Enter your mobile number (09XX XXX XXXX) — we'll text you a code.");
  const now = Date.now(), ref = db.doc(`otp/${uid}`), pRef = db.doc(`otpPhones/${phone}`);
  const [o, pp] = await Promise.all([ref.get(), pRef.get()]);
  const recent = (arr) => (arr || []).filter((t) => t > now - 3600e3);
  const mine = recent(o.data()?.sends), forPhone = recent(pp.data()?.sends);
  if (mine.length >= 3 || forPhone.length >= 3) throw new HttpsError("resource-exhausted", "Too many codes sent. Please try again in an hour.");
  if (o.data()?.lastAt && now - o.data().lastAt < 45000) throw new HttpsError("resource-exhausted", "Please wait a few seconds before asking for a new code.");
  const code = String(crypto.randomInt(100000, 1000000));
  const body = new URLSearchParams({ apikey: cfg.apiKey, number: phone, message: "Your TapTayo code is {otp}. It expires in 10 minutes. Don't share it with anyone.", code });
  if (cfg.senderName) body.set("sendername", cfg.senderName);
  const res = await fetch(`${SEM}/otp`, { method: "POST", body }).catch(() => null);
  const j = res ? await res.json().catch(() => null) : null;
  if (!res || !res.ok || !Array.isArray(j) || !j.length) { logger.warn("otp send failed", { status: res?.status, j }); throw new HttpsError("unavailable", "We couldn't send the code right now. Please try again in a minute."); }
  await Promise.all([ref.set({ phone, hash: otpHash(uid, code), exp: now + 10 * 60000, tries: 0, lastAt: now, sends: [...mine, now], verifiedPhone: null }, { merge: true }), pRef.set({ sends: [...forPhone, now] }, { merge: true })]);
  return { sent: true, phone: phone.replace(/^(\d{4})\d{4}(\d{3})$/, "$1 •••• $2") };
});
exports.verifySignupOtp = onCallRaw(async (req) => {
  const { uid } = requireAuth(req);
  const ref = db.doc(`otp/${uid}`); const o = (await ref.get()).data();
  if (!o?.hash) throw new HttpsError("failed-precondition", "Ask for a code first.");
  if (o.exp < Date.now()) throw new HttpsError("deadline-exceeded", "That code expired. Tap “Send a new code”.");
  if ((o.tries || 0) >= 5) throw new HttpsError("resource-exhausted", "Too many wrong codes. Tap “Send a new code”.");
  if (otpHash(uid, String(req.data?.code || "").trim()) !== o.hash) { await ref.update({ tries: FieldValue.increment(1) }); throw new HttpsError("invalid-argument", "Wrong code. Please check the text message."); }
  await ref.update({ verifiedPhone: o.phone, verifiedAt: Date.now(), hash: null });
  return { ok: true, phone: o.phone };
});
async function requireVerifiedPhone() {
  // Signup OTP is paused until delivery is reliable; phone remains available for business contact/trial abuse checks.
  return;
}

/** One free trial per business type per mobile number / browser — a repeat starts on the Free plan (no time limit). */
const trialKeyIds = (mode, phone, bid) => { const h = (x) => crypto.createHash("sha256").update(x).digest("hex").slice(0, 32); const out = []; const ph = String(phone || "").replace(/\D/g, "").replace(/^63/, "0").slice(-10); if (ph.length >= 10) out.push(h(`p:${mode}:${ph}`)); if (/^[a-z0-9]{12,40}$/i.test(String(bid || ""))) out.push(h(`b:${mode}:${bid}`)); return out; };
async function trialUsed(mode, phone, bid) { const ids = trialKeyIds(mode, phone, bid); if (!ids.length) return false; const snaps = await db.getAll(...ids.map((i) => db.doc(`trialKeys/${i}`))); return snaps.some((x) => x.exists); }
function markTrial(batch, mode, phone, bid, storeId) { for (const i of trialKeyIds(mode, phone, bid)) batch.set(db.doc(`trialKeys/${i}`), { storeId, at: FieldValue.serverTimestamp() }); }
const freeSub = (now) => ({ plan: "free", status: "active", trialEndsAt: null, paidUntil: null, paymentMethod: null, paymongoSubscriptionId: null, startedFree: true, createdAt: now, updatedAt: now });

exports.createStore = onCallRaw(async (req) => {
  const { uid, token } = requireAuth(req);
  const data = req.data || {};
  if (token.storeId) throw new HttpsError("already-exists", "This account already has a store.");
  const userRef = db.doc(`users/${uid}`);
  const userSnap = await userRef.get();
  if (userSnap.exists && userSnap.data().storeId) throw new HttpsError("already-exists", "This account already has a store.");
  await requireVerifiedPhone(uid, data.phone);
  const orgRef = db.collection("orgs").doc();
  const { storeId, slug, mode } = await buildStore({ uid, token, data, orgId: orgRef.id });
  const now = FieldValue.serverTimestamp();
  const trialEnds = Timestamp.fromMillis(Date.now() + TRIAL_DAYS * 86400000);
  const batch = db.batch();
  const repeat = await trialUsed(mode, data.phone, data.bid);
  batch.set(db.doc(`stores/${storeId}/subscription/current`), repeat ? freeSub(now) : { plan: "trial", status: "trial", trialEndsAt: trialEnds, paidUntil: null, paymentMethod: null, paymongoSubscriptionId: null, limits: TRIAL_LIMITS, createdAt: now, updatedAt: now });
  if (!repeat) markTrial(batch, mode, data.phone, data.bid, storeId);
  batch.set(orgRef, { name: String(data.name || "").trim(), ownerUid: uid, ownerEmail: token.email || null, mainStoreId: storeId, branches: [{ storeId, name: String(data.name || "").trim(), slug, createdAt: Date.now() }], createdAt: now, updatedAt: now });
  batch.set(userRef, { email: token.email || null, name: token.name || data.ownerName || null, storeId, orgId: orgRef.id, role: "owner", createdAt: now, businesses: [{ storeId, orgId: orgRef.id, name: String(data.name || "").trim(), businessType: String(data.businessType || "") }], storeIds: [storeId] }, { merge: true });
  await batch.commit();
  await admin.auth().setCustomUserClaims(uid, { storeId, role: "owner", orgId: orgRef.id });
  logger.info("store created", { storeId, slug, uid, orgId: orgRef.id });
  return { storeId, slug, mode };
});

// ===========================================================================
// MULTI-BUSINESS — one owner, several businesses (e.g. a café AND a salon). Each business has its own org,
// plan and branches. users/{uid}.businesses = [{ storeId, orgId, name, businessType }]
// ===========================================================================
async function myBusinesses(uid) {
  const u = (await db.doc(`users/${uid}`).get()).data() || {};
  const list = [...(u.businesses || [])];
  if (u.storeId && u.orgId && !list.some((b) => b.orgId === u.orgId)) {
    const st = (await db.doc(`stores/${u.storeId}`).get()).data() || {};
    const org = (await db.doc(`orgs/${u.orgId}`).get()).data() || {};
    list.unshift({ storeId: org.mainStoreId || u.storeId, orgId: u.orgId, name: st.name || "My business", businessType: st.businessType || "" });
  }
  return { u, list };
}
exports.listBusinesses = onCall(async (req) => {
  const { uid, token } = requireAuth(req);
  if (token.role !== "owner") throw new HttpsError("permission-denied", "Owner only.");
  const { list } = await myBusinesses(uid);
  return { businesses: list, current: token.orgId || null };
});
exports.addBusiness = onCall(async () => {
  throw new HttpsError("failed-precondition", "Each business must use its own email account.");
});
exports.switchBusiness = onCall(async () => {
  throw new HttpsError("failed-precondition", "Business switching is paused. Log in with the email used for that business.");
});
// ===========================================================================
// MULTI-BRANCH — orgs/{orgId}; subscription lives on the main store and is mirrored to branches
// ===========================================================================
const BRANCH_TIERS = [{ key: "branches3", max: 4 }, { key: "branches6", max: 7 }, { key: "branches9", max: 10 }];
async function orgFor(token) {
  if (!token.orgId) throw new HttpsError("failed-precondition", "Your account is not linked to an organization yet. Log out and log in again.");
  const snap = await db.doc(`orgs/${token.orgId}`).get();
  if (!snap.exists || snap.data().ownerUid !== token.uid) throw new HttpsError("permission-denied", "Not your organization.");
  return { ref: snap.ref, org: snap.data() };
}
const branchesAllowed = (sub) => require("./plans.js").branchesAllowedFor(sub);
exports.addBranch = onCall(async (req) => {
  const { uid, token } = requireAuth(req);
  if (token.role !== "owner") throw new HttpsError("permission-denied", "Owner only.");
  const { ref, org } = await orgFor({ ...token, uid });
  const sub = (await db.doc(`stores/${org.mainStoreId}/subscription/current`).get()).data();
  const allowed = branchesAllowed(sub);
  if ((org.branches || []).length >= allowed) throw new HttpsError("resource-exhausted", `Your plan allows ${allowed} branch${allowed > 1 ? "es" : ""}. Add "+1 branch" in Billing.`);
  const d = req.data || {};
  const main = (await db.doc(`stores/${org.mainStoreId}`).get()).data();
  const copyFrom = d.copyFrom && (org.branches || []).some((b) => b.storeId === d.copyFrom) ? d.copyFrom : null;
  const { storeId, slug } = await buildStore({ uid, token, data: { ...d, businessType: main.businessType }, orgId: ref.id, copyFrom });
  const now = FieldValue.serverTimestamp();
  await db.doc(`stores/${storeId}/subscription/current`).set({ ...sub, mirroredFrom: org.mainStoreId, updatedAt: now });
  await ref.update({ branches: FieldValue.arrayUnion({ storeId, name: String(d.name || "").trim(), slug, createdAt: Date.now() }), updatedAt: now });
  return { storeId, slug };
});
exports.switchBranch = onCall(async (req) => {
  const { uid, token } = requireAuth(req);
  if (token.role !== "owner") throw new HttpsError("permission-denied", "Owner only.");
  const { org } = await orgFor({ ...token, uid });
  const storeId = String(req.data?.storeId || "");
  if (!(org.branches || []).some((b) => b.storeId === storeId)) throw new HttpsError("not-found", "Branch not found.");
  await admin.auth().setCustomUserClaims(uid, { storeId, role: "owner", orgId: token.orgId });
  await db.doc(`users/${uid}`).set({ storeId, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { ok: true };
});
exports.renameBranch = onCall(async (req) => {
  const { uid, token } = requireAuth(req);
  if (token.role !== "owner") throw new HttpsError("permission-denied", "Owner only.");
  const { ref, org } = await orgFor({ ...token, uid });
  const storeId = String(req.data?.storeId || ""), name = String(req.data?.name || "").trim().slice(0, 60);
  if (name.length < 2) throw new HttpsError("invalid-argument", "Name too short.");
  const branches = (org.branches || []).map((b) => (b.storeId === storeId ? { ...b, name } : b));
  await ref.update({ branches, updatedAt: FieldValue.serverTimestamp() });
  await db.doc(`stores/${storeId}`).update({ name, updatedAt: FieldValue.serverTimestamp() });
  return { ok: true };
});
exports.archiveBranch = onCall(async (req) => {
  const { uid, token } = requireAuth(req);
  if (token.role !== "owner") throw new HttpsError("permission-denied", "Owner only.");
  const { ref, org } = await orgFor({ ...token, uid });
  const storeId = String(req.data?.storeId || "");
  if (storeId === org.mainStoreId) throw new HttpsError("failed-precondition", "The main branch can't be archived.");
  if (storeId === token.storeId) throw new HttpsError("failed-precondition", "Switch to another branch first.");
  const branches = (org.branches || []).map((b) => (b.storeId === storeId ? { ...b, archived: true } : b));
  await ref.update({ branches, updatedAt: FieldValue.serverTimestamp() });
  await db.doc(`stores/${storeId}`).update({ archived: true, "settings.acceptOrders": false, updatedAt: FieldValue.serverTimestamp() });
  return { ok: true };
});
// link legacy owners (created before orgs) to an org on login
exports.ensureOrg = onCall(async (req) => {
  const { uid, token } = requireAuth(req);
  if (token.role !== "owner" || !token.storeId) return { ok: false };
  if (token.orgId) return { ok: true, orgId: token.orgId };
  const store = (await db.doc(`stores/${token.storeId}`).get()).data();
  if (!store) return { ok: false };
  let orgId = store.orgId;
  if (!orgId) {
    const orgRef = db.collection("orgs").doc(); orgId = orgRef.id;
    await orgRef.set({ name: store.name, ownerUid: uid, ownerEmail: token.email || null, mainStoreId: token.storeId, branches: [{ storeId: token.storeId, name: store.name, slug: store.slug, createdAt: Date.now() }], createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    await db.doc(`stores/${token.storeId}`).update({ orgId });
  }
  await admin.auth().setCustomUserClaims(uid, { storeId: token.storeId, role: "owner", orgId });
  await db.doc(`users/${uid}`).set({ orgId }, { merge: true });
  return { ok: true, orgId, refresh: true };
});
// per-branch daily totals → orgs/{orgId}/daily/{storeId}_{day} (owner reads these for the all-branches summary; 1 doc per branch per day)
exports.orgDailyStats = onDocumentWritten("stores/{storeId}/orders/{id}", async (event) => {
  const a = event.data?.after?.data(), b = event.data?.before?.data();
  if (!a || a.test) return;
  const created = !b;
  const doneNow = ["completed", "delivered", "picked_up", "claimed"].includes(a.status) && (!b || !["completed", "delivered", "picked_up", "claimed"].includes(b.status));
  const cancelledNow = a.status === "cancelled" && b?.status !== "cancelled";
  if (!created && !doneNow && !cancelledNow) return;
  const store = (await db.doc(`stores/${event.params.storeId}`).get()).data(); if (!store?.orgId) return;
  const day = a.dayKey || dayKey(a.createdAt?.toDate?.() || new Date(), store.settings?.businessDayCutoff);
  const ref = db.doc(`orgs/${store.orgId}/daily/${event.params.storeId}_${day}`);
  await ref.set({ storeId: event.params.storeId, day, ...(created ? { orders: FieldValue.increment(1) } : {}), ...(doneNow ? { completed: FieldValue.increment(1), sales: FieldValue.increment(a.total || 0), ...(a.laundry?.kg ? { kg: FieldValue.increment(a.laundry.kg) } : {}) } : {}), ...(cancelledNow ? { cancelled: FieldValue.increment(1) } : {}), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
});
/** Is this branch within the org's allowed count? (branch order = creation order; main is always allowed) */
async function branchOverLimit(store, storeId, sub) {
  if (!store?.orgId) return false;
  const org = (await db.doc(`orgs/${store.orgId}`).get()).data(); if (!org) return false;
  const active = (org.branches || []).filter((x) => !x.archived);
  const idx = active.findIndex((x) => x.storeId === storeId);
  return idx >= branchesAllowed(sub);
}
// mirror the main store's subscription to every branch
exports.mirrorSubscription = onDocumentWritten("stores/{storeId}/subscription/{id}", async (event) => {
  const after = event.data?.after?.data(); if (!after || after.mirroredFrom) return;
  const store = (await db.doc(`stores/${event.params.storeId}`).get()).data(); if (!store?.orgId) return;
  const org = (await db.doc(`orgs/${store.orgId}`).get()).data(); if (!org || org.mainStoreId !== event.params.storeId) return;
  const batch = db.batch();
  (org.branches || []).filter((b) => b.storeId !== event.params.storeId).forEach((b) => batch.set(db.doc(`stores/${b.storeId}/subscription/current`), { ...after, mirroredFrom: event.params.storeId }));
  await batch.commit();
});

// ---------------------------------------------------------------------------
// whoAmI — debugging helper: inspect the logged-in user's claims
// ---------------------------------------------------------------------------
exports.whoAmI = onCall(async (req) => {
  const { uid, token } = requireAuth(req);
  return { uid, storeId: token.storeId || null, role: token.role || null, email: token.email || null };
});

// ---------------------------------------------------------------------------
// syncPublicStore — when the store / categories / items change,
// rebuild publicStores/{slug} (what the customer page reads)
// ---------------------------------------------------------------------------

/** Current limits for a store (plan + add-ons). */
async function storeLimits(storeId, mode) {
  if (mode === "salon") { const st = (await db.doc(`stores/${storeId}`).get()).data(); mode = limitMode(st || { mode }); }
  const sub = (await db.doc(`stores/${storeId}/subscription/current`).get()).data();
  return { sub, lim: limitsFor(sub, mode), plan: planOf(sub) };
}
const limitMsg = (what, n, plan) => `${PLANS[plan]?.name || "Your"} plan limit reached: ${n} ${what}. Upgrade in Billing to get more.`;
/** Monthly booking counter (salon / stay): stores/{id}/stats/usage { month, bookings } — throws when the plan limit is reached. */
/** shop-wide booking policy (Settings → Booking policy): non-refundable, reschedule limits, moving-date fee */
function bookingPolicy(store) {
  const p = store?.settings?.bookingPolicy || {}; const r = p.reschedule || {};
  return { refundable: p.refundable !== false, reschedule: { allowed: r.allowed !== false, max: r.max == null ? 2 : Math.max(0, Number(r.max)), cutoffHours: r.cutoffHours == null ? 24 : Math.max(0, Number(r.cutoffHours)), fee: Math.max(0, Number(r.fee) || 0), feeType: r.feeType === "percent" ? "percent" : "fixed" } };
}
/** throws if moving is not allowed; returns the moving-date fee (customer must pass acceptFee when > 0) */
function reschedFee(pol, startMs, count, total, acceptFee) {
  const R = pol.reschedule;
  if (!R.allowed) throw new HttpsError("failed-precondition", "This shop doesn't allow rescheduling. Please message them.");
  if (R.max && count >= R.max) throw new HttpsError("failed-precondition", `You can only reschedule ${R.max} time${R.max > 1 ? "s" : ""}.`);
  if (R.cutoffHours && startMs - Date.now() < R.cutoffHours * 3600000) throw new HttpsError("failed-precondition", `Changes must be made at least ${R.cutoffHours} hours before.`);
  const fee = round2(R.feeType === "percent" ? (Number(total) || 0) * R.fee / 100 : R.fee);
  if (fee > 0 && !acceptFee) throw new HttpsError("failed-precondition", `FEE:${fee}:A moving date fee of ₱${fee.toLocaleString("en-PH")} applies. Continue?`);
  return fee;
}
async function countBooking(storeId, lim, plan, test, startAt = null) {
  if (test) return;
  const max = lim.bookingsPerMonth; const ref = db.doc(`stores/${storeId}/stats/usage`);
  const mon = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 7);
  // per-day cap (salon Free): active appointments already on that date
  const maxDay = lim.bookingsPerDay;
  if (startAt && maxDay != null && maxDay < UNLIMITED) {
    const ymd = new Date(startAt.getTime() + 8 * 3600e3).toISOString().slice(0, 10);
    const n = (await dayAppointments(storeId, ymd)).length;
    if (n >= maxDay) { await ref.set({ limitHit: { key: "bookingsPerDay", max: maxDay, at: Date.now(), date: ymd } }, { merge: true }); throw new HttpsError("resource-exhausted", `This day is fully booked (${maxDay} bookings a day on this shop's plan). Please pick another day or message the shop.`); }
  }
  const full = await db.runTransaction(async (tx) => {
    const u = (await tx.get(ref)).data() || {}; const n = u.month === mon ? u.bookings || 0 : 0;
    if (max != null && max < UNLIMITED && n >= max) return true;
    tx.set(ref, { month: mon, bookings: n + 1 }, { merge: true }); return false;
  });
  if (full) { await ref.set({ limitHit: { key: "bookingsPerMonth", max, at: Date.now() } }, { merge: true }); throw new HttpsError("resource-exhausted", `This shop has reached its booking limit for this month (${max}). Please message the shop directly.`); }
}
/** a salon / stay booking was cancelled, declined or expired → give back one of this month's bookings */
async function uncountBooking(storeId, createdAt) {
  const mon = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 7);
  if (createdAt?.toMillis && new Date(createdAt.toMillis() + 8 * 3600e3).toISOString().slice(0, 7) !== mon) return;
  const ref = db.doc(`stores/${storeId}/stats/usage`);
  await db.runTransaction(async (tx) => { const u = (await tx.get(ref)).data() || {}; if (u.month === mon && (u.bookings || 0) > 0) tx.set(ref, { bookings: u.bookings - 1 }, { merge: true }); }).catch(() => {});
}
const BOOKING_GONE = ["cancelled", "declined", "expired", "rejected"];
const bookingEndHandler = async (ev) => {
  const b = ev.data?.before?.data(), a = ev.data?.after?.data();
  if (!b || !a || a.test || BOOKING_GONE.includes(b.status) || !BOOKING_GONE.includes(a.status)) return;
  await uncountBooking(ev.params.storeId, a.createdAt);
};
exports.usageApptEnd = onDocumentWritten("stores/{storeId}/appointments/{id}", bookingEndHandler);
exports.usageStayEnd = onDocumentWritten("stores/{storeId}/stays/{id}", bookingEndHandler);
async function storeEntitled(storeId, key) {
  const sub = (await db.doc(`stores/${storeId}/subscription/current`).get()).data();
  return entitled(sub, key);
}
/** plan staff slots: the oldest N active staff can work; the rest get planLocked (kept, logged out) until the plan allows them */
async function enforceStaffLimit(storeId, max) {
  const all = (await db.collection(`stores/${storeId}/staff`).where("active", "==", true).get()).docs.sort((a, b) => (a.data().createdAt?.toMillis?.() || 0) - (b.data().createdAt?.toMillis?.() || 0));
  const b = db.batch(); let n = 0;
  all.forEach((d, i) => { const lock = i >= max; if (!!d.data().planLocked !== lock) { b.update(d.ref, { planLocked: lock }); n++; } });
  if (n) await b.commit();
}
async function rebuildPublicStore(storeId) {
  const storeRef = db.doc(`stores/${storeId}`);
  const storeSnap = await storeRef.get();
  if (!storeSnap.exists) return;
  const store = storeSnap.data();

  // no orderBy() on purpose: Firestore drops docs without the field — sort in code instead
  const bySort = (snap) => ({ docs: [...snap.docs].sort((a, b) => (Number(a.data().sortOrder) || 0) - (Number(b.data().sortOrder) || 0)) });
  const safe = async (label, fn, fallback) => { try { return await fn(); } catch (e) { logger.error(`rebuildPublicStore ${storeId}: ${label} failed`, e); return fallback; } };
  const roomsSnap = store.mode === "stay" ? bySort(await storeRef.collection("rooms").get()) : { docs: [] };
  const [catSnap, itemSnap, subSnap, tableSnap] = await Promise.all([
    storeRef.collection("categories").get().then(bySort),
    storeRef.collection("items").get().then(bySort),
    storeRef.collection("subscription").doc("current").get(),
    store.mode === "table" ? storeRef.collection("tables").get().then(bySort) : Promise.resolve({ docs: [] }),
  ]);
  const tables = tableSnap.docs
    .filter((d) => d.data().active !== false)
    .map((d) => ({ id: d.id, label: d.data().label, qrToken: d.data().qrToken, isRoom: !!d.data().isRoom, roomId: d.data().roomId || null, ...(d.data().isWaitlist ? { isWaitlist: true } : {}) }));

  const hiddenCats = store.mode === "salon" && store.settings?.salonTypes ? new Set(Object.entries(store.settings.salonTypes).filter(([, on]) => on === false).map(([k]) => k)) : new Set();
  const categories = catSnap.docs
    .filter((d) => d.data().active !== false && !hiddenCats.has(d.id))
    .map((d) => ({ id: d.id, name: d.data().name, description: d.data().description || "", sortOrder: d.data().sortOrder, ...(d.data().adult ? { adult: true } : {}) }));
  const activeCatIds = new Set(categories.map((c) => c.id));

  const items = itemSnap.docs
    .filter((d) => activeCatIds.has(d.data().categoryId) && !d.data().retail) // retail products are sold at the counter only
    .map((d) => {
      const it = d.data();
      return {
        id: d.id,
        categoryId: it.categoryId,
        name: it.name,
        price: it.price,
        unit: it.unit || "piece",
        durationMinutes: it.durationMinutes || null, wholeDay: !!it.wholeDay, variants: Array.isArray(it.variants) && it.variants.length ? it.variants.map((v) => ({ label: v.label, price: Number(v.price) || 0, duration: Number(v.duration) || null })) : null,
        description: it.description || "",
        imageUrl: it.imageUrl || null,
        thumbUrl: it.thumbUrl || null,
        options: it.options || [],
        available: it.available !== false,
        ...(it.available === false && Number(it.soldUntil) > Date.now() ? { soldUntil: Number(it.soldUntil) } : {}),
        sortOrder: it.sortOrder || 0,
        ...(Number(it.compareAt) > Number(it.price) ? { compareAt: Number(it.compareAt) } : {}),
        ...(it.createdAt?.toMillis && Date.now() - it.createdAt.toMillis() < 14 * 86400000 ? { isNew: true } : {}),
      };
    });

  // products customers can add while booking (prints, frames, lashes, lenses…)
  const products = store.mode === "salon" ? itemSnap.docs.filter((d) => d.data().retail && d.data().sellOnline && d.data().available !== false && activeCatIds.has(d.data().categoryId)).slice(0, 30).map((d) => { const it = d.data(); return { id: d.id, name: it.name, price: Number(it.price) || 0, description: it.description || "", imageUrl: it.thumbUrl || it.imageUrl || null, stock: it.stock ?? null }; }) : [];
  const s = store.settings || {};
  const FLp = s.salon?.freelance || {};
  // creator profile (directory + "why book me"): only safe, public fields
  const cPort = store.businessType === "freelance" ? await safe("cportfolio", async () => (await storeRef.collection("portfolio").get()).docs.map((d) => d.data()).filter((x) => x.creator).sort((a, b) => (b.at || 0) - (a.at || 0)), []) : [];
  const creator = store.businessType === "freelance" ? { xdeal: FLp.xdeal?.on && FLp.adult && store.kycAt && !store.xBanned ? { minTip: Number(FLp.xdeal.minTip) || 0, types: FLp.xdeal.types || XDEAL_TYPES, releaseDays: Number(FLp.xdeal.releaseDays) || 5, cap: xCap(store) } : null, xDone: store.stats?.xDone || 0, xRating: store.stats?.xRateN ? Math.round((store.stats.xRateSum / store.stats.xRateN) * 10) / 10 : null, kyc: !!store.kycAt, portfolio: cPort.slice(0, 12).map((x) => ({ url: x.url || "", thumb: x.thumb || (x.kind === "photo" ? x.url : null), kind: x.kind || "photo", label: x.label || "", ugc: !!x.ugc, brand: x.brand || "" })), portfolioCount: cPort.length, ugc: !!FLp.ugc, adult: !!FLp.adult, paused: FLp.availability?.paused && (!FLp.availability.until || FLp.availability.until > Date.now()) ? { until: FLp.availability.until || null } : null, sideJob: FLp.availability?.sideJob || "", maxPerWeek: Number(FLp.availability?.maxPerWeek) || 0, projectsDone: store.stats?.projectsDone || 0, verified: !!store.creatorVerified, niches: (FLp.niches || []).slice(0, 8), pitch: String(FLp.pitch || "").slice(0, 600), brands: (FLp.brands || []).slice(0, 12), city: FLp.city || "", offers: FLp.offers !== false, minFee: Number(FLp.minFee) || 0, rush: FLp.rush?.enabled ? { hours: Number(FLp.rush.hours) || 24, fee: Number(FLp.rush.fee) || 0 } : null, rushMiss: FLp.rushMiss || "refund", rushMissPct: Number(FLp.rushMissPct) || 10, release: FLp.release || null, idOnSite: !!FLp.requireIdOnSite, radiusKm: Number(s.salon?.homeService?.radiusKm) || 0, onTime: (store.stats?.delTotal || 0) >= 3 ? { rate: Math.round(((store.stats.delOnTime || 0) / store.stats.delTotal) * 100), n: store.stats.delTotal } : null, followers: (FLp.platforms || []).reduce((a, x) => a + (parseFloat(String(x.followers || "").replace(/,/g, "")) * (/m/i.test(x.followers || "") ? 1e6 : /k/i.test(x.followers || "") ? 1e3 : 1) || 0), 0) } : null;
  const fb = s.feedback || {};
  let reviews = [];
  if (fb.display === "3plus" || fb.display === "all") {
    reviews = await safe("reviews", async () => {
      const fSnap = await storeRef.collection("feedback").orderBy("createdAt", "desc").limit(30).get();
      return fSnap.docs.map((d) => d.data()).filter((f) => !f.hidden && f.comment && (fb.display === "all" || f.rating >= 3)).slice(0, 10).map((f) => ({ rating: f.rating, comment: f.comment, name: (f.customerName || "Customer").split(" ")[0], at: f.createdAt?.toMillis?.() || null }));
    }, []);
  }
  const announcements = await safe("announcements", () => publicAnnouncements(storeRef), []);
  const promoSnap = await safe("promos", () => storeRef.collection("promos").where("active", "==", true).get(), { docs: [] });
  const promos = promoSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => p.audience !== "code").map((p) => ({ id: p.id, name: p.name, type: p.type, value: p.value, allItems: !!p.allItems, itemIds: p.itemIds || [], categoryIds: p.categoryIds || [], schedule: p.schedule || {}, badge: p.badge || "", validFor: p.validFor || "all", audience: p.audience || "all", place: p.place || "any", staffIds: p.staffIds || [], stack: !!p.stack, maxUses: p.maxUses || null, usedCount: p.usedCount || 0, note: p.note || "" }));
  const sub = subSnap.exists ? subSnap.data() : null;
  const overLimit = await safe("branchLimit", () => branchOverLimit(store, storeId, sub), false);
  const portfolio = store.mode === "salon" ? await safe("portfolio", async () => (await storeRef.collection("portfolio").get()).docs.map((d) => d.data()).sort((a, b) => (b.at || 0) - (a.at || 0)), []) : [];
  const team = store.mode === "salon" ? await safe("team", async () => (await storeRef.collection("staff").where("active", "==", true).get()).docs.map((d) => ({ id: d.id, ...d.data() })).filter((x) => (x.roles || []).includes("stylist") && x.showToCustomers !== false).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)).map((x) => ({ id: x.id, name: x.name, photoUrl: x.photoUrl || null, bio: x.bio || "", gender: x.gender || null, rating: (x.ratingCount || 0) >= 3 ? { avg: Math.round((x.ratingSum / x.ratingCount) * 10) / 10, n: x.ratingCount } : null, skills: x.skills || [], portfolio: portfolio.filter((p) => p.providerId === x.id).slice(0, 9).map((p) => ({ url: p.url, label: p.label || "", service: p.service || "" })), schedule: pubSchedule(x.schedule) })), []) : null;
  const locked = !sub || sub.status === "locked" || overLimit || !!store.archived;
  const can = (k) => entitled(sub, k);
  const planLim = limitsFor(sub, limitMode(store));
  await enforceStaffLimit(storeId, planLim.staff ?? UNLIMITED).catch((e) => logger.warn("staff limit", e.message));
  const service = s.service ? { ...s.service, delivery: !!s.service.delivery && can("delivery") } : null;
  const addons = Object.fromEntries(Object.keys(ADDONS).map((k) => [k, can(k)]));
  const pro = Object.fromEntries(Object.keys(PRO_FEATURES).map((k) => [k, can(k)]));

  await db.doc(`publicStores/${store.slug}`).set({
    storeId,
    name: store.name,
    slug: store.slug,
    businessType: store.businessType,
    mode: store.mode,
    products, creator,
    creatorListed: !!creator && (s.demo || (FLp.directory === true && FLp.adult === true && cPort.length >= 3 && !locked)),
    ...(creator ? { creatorScore: creatorScore(creator, store) } : {}),
    swapListed: xEligible(store) && s.collab?.swap === true && !locked,
    theme: pro.themes ? store.theme || {} : { ...(store.theme || {}), season: null },
    logoUrl: store.logoUrl || null,
    coverUrl: store.coverUrl || null,
    floorPlanUrl: store.floorPlanUrl || null,
    policies: s.policies || null,
    waiver: s.waiver ? { text: s.waiver.text || "", table: !!s.waiver.table, event: s.waiver.event !== false, vip: s.waiver.vip !== false, idMode: s.waiver.idMode || "optional" } : null,
    tagline: s.tagline || "",
    labels: s.labels || {},
    contact: store.businessType === "freelance" ? (({ messenger, ...c }) => c)(store.contact || {}) : store.contact || {}, // a freelancer's Messenger shows to the client only after they book
    hours: store.hours || {},
    currency: s.currency || "PHP",
    welcome: s.welcome || "",
    acceptOrders: s.acceptOrders !== false && !locked,
    testMode: testOn(s) ? { until: s.demo ? Date.now() + 3650 * 86400000 : Number(s.testMode.until) } : null,
    lateUntil: Number(s.lateUntil) > Date.now() ? Number(s.lateUntil) : null,
    v: SERVER_VERSION,
    kitchen: s.kitchen?.status === "busy" ? { status: "busy", busyExtra: s.kitchen.busyExtra || 0, busyPrep: Number(s.service?.busyPrep) || 35 } : null,
    locked, overLimit,
    service,
    addons, pro,
    qrMode: s.qrMode || "per_table",
    callStaff: pro.callstaff ? s.callStaff || null : null,
    payments: (s.payments?.methods || []).filter((m) => m.enabled !== false),
    confirm: s.confirm || store.mode === "table" || store.mode === "salon" ? { mode: s.confirm?.mode || "messenger", messengerLink: s.confirm?.messengerLink || "", minutes: s.confirm?.minutes || 60, skipReturning: s.confirm?.skipReturning !== false } : null,
    landing: s.landing !== false,
    reservations: pro.reservations ? s.reservations || null : null,
    events: can("events_vip") ? s.events || null : null,
    vip: can("events_vip") ? s.vip || null : null,
    booking: s.booking || null,
    pickup: s.pickup || null,
    loyalty: store.mode === "table" && s.loyalty?.enabled && can("loyalty") ? { stamps: Math.max(2, Number(s.loyalty.stamps) || 10), minTotal: Number(s.loyalty.minTotal) || 0, rewardText: s.loyalty.rewardText || "", rewardValue: Number(s.loyalty.rewardValue) || 0 } : null,
    laundry: store.mode === "laundry" ? { ...(s.laundry || {}), pause: s.pause || null, busy: s.busy?.active ? s.busy : null } : null,
    salon: store.mode === "salon" ? { ...(s.salon || {}), presence: store.salonLive?.presence && (!store.salonLive.presence.until || store.salonLive.presence.until > Date.now()) ? store.salonLive.presence : null, types: s.salonTypes || null, giftcards: pro.giftcards ? s.salon?.giftcards || null : null, referral: pro.referral ? s.salon?.referral || null : null } : null,
    reviewUrl: /^https:\/\//.test(String(s.reviewUrl || "")) ? String(s.reviewUrl) : null,
    bookingPolicy: bookingPolicy(store),
    comingSoon: s.live === false,
    setup: s.setup || null,
    advanceWhenClosed: s.advanceWhenClosed !== false,
    team: Array.isArray(team) ? team.slice(0, Math.max(1, planLim.staff ?? 1e9)) : team,
    categories,
    // plan limits: extra items / tables / rooms stay saved but are hidden from customers until the plan allows them
    items: items.slice(0, planLim.items ?? items.length),
    tables: (() => { let n = 0; return tables.filter((t) => t.isRoom || t.isWaitlist || ++n <= (planLim.tables ?? 1e9)); })(),
    hideBranding: !!(store.settings?.hideBranding && can("whitelabel")) && !store.settings?.demo,
    demo: !!store.settings?.demo,
    planTier: tierOf(sub),
    promos: pro.promos ? promos : [],
    upcomingPromos: pro.promos ? promoSnap.docs.map((d) => d.data()).filter((p) => p.schedule?.dateFrom && p.schedule.dateFrom > new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)).sort((a, b) => a.schedule.dateFrom.localeCompare(b.schedule.dateFrom)).filter((p) => p.audience !== "code").slice(0, 8).map((p) => ({ name: p.name || "", label: store.mode === "salon" ? salonPromoTag(p) : promoLabel(p), dateFrom: p.schedule.dateFrom, dateTo: p.schedule.dateTo || null, note: p.note || "", days: p.schedule.days || [], start: p.schedule.start || null, end: p.schedule.end || null })) : [],
    announcements: pro.announcements ? announcements : [],
    sms: can("sms") && s.sms?.enabled ? { enabled: true, optInText: s.sms.optInText || "Send me promos and updates via text" } : null,
    feedback: { enabled: fb.enabled !== false && can("feedback"), display: fb.display || "stars", askPhoto: !!fb.askPhoto, avg: store.stats?.ratingCount ? Math.round((store.stats.ratingSum / store.stats.ratingCount) * 10) / 10 : null, count: store.stats?.ratingCount || 0, cats: store.stats?.catSum ? Object.fromEntries(Object.entries(store.stats.catSum).map(([k, v]) => [k, Math.round((v / (store.stats.catCount?.[k] || 1)) * 10) / 10])) : null, reviews },
    incidents: { enabled: s.incidents?.enabled !== false && can("feedback"), requireProof: s.incidents?.requireProof !== false },
    bestsellers: s.showBestsellers === false ? [] : (store.stats?.bestsellers || []),
    rooms: roomsSnap.docs.filter((d) => d.data().active !== false).slice(0, planLim.rooms ?? 1e9).map((d) => { const r = d.data(); return { id: d.id, name: r.name, theme: r.theme || "", description: r.description || "", capacity: r.capacity || 2, beds: r.beds || "", price: Number(r.price) || 0, weekendPrice: Number(r.weekendPrice) || 0, shortPrices: r.shortPrices || null, inventory: (r.inventory || []).map((i) => ({ name: i.name, qty: i.qty, price: i.price || 0 })), deposit: r.deposit ?? null, selfDoor: !!r.passcode && r.doorType !== "meet", doorType: r.doorType || (r.passcode ? "smartlock" : "meet"), notices: (r.notices || []).filter((n) => n && n.label).map((n) => ({ label: n.label, percent: Number(n.percent) || 0 })), rating: (r.ratingCount || 0) >= 1 ? { avg: Math.round((r.ratingSum / r.ratingCount) * 10) / 10, n: r.ratingCount, cats: r.ratingCats || null } : null, amenities: r.amenities || [], photos: (r.photos || []).slice(0, Math.min(30, planLim.photos ?? 30)), posters: (r.posters || []).slice(0, 6), rules: r.rules || "" }; }),
    stay: store.mode === "stay" ? { ...stayCfg(store), policy: s.stay?.policy || "", waiverText: s.waiver?.text || s.stay?.waiverText || "", requireId: s.stay?.requireId !== false } : null,
    updatedAt: FieldValue.serverTimestamp(),
  });
}

/** Owner: change the store's customer link (/m/<slug>). The old link keeps working (redirect doc). */
exports.checkSlug = onCall(async (req) => {
  const t = requireOwner(req);
  const slug = slugify(req.data?.slug || "");
  if (slug.length < 3) return { slug, ok: false, reason: "At least 3 letters or numbers." };
  if (RESERVED_SLUGS.has(slug)) return { slug, ok: false, reason: "That link is reserved." };
  const snap = await db.doc(`publicStores/${slug}`).get();
  const mine = snap.exists && (snap.data().storeId === t.storeId || snap.data().redirectStoreId === t.storeId);
  return { slug, ok: !snap.exists || mine, reason: !snap.exists || mine ? "" : "Already taken by another store." };
});
exports.changeSlug = onCall(async (req) => {
  const t = requireOwner(req);
  const slug = slugify(req.data?.slug || "");
  if (slug.length < 3) throw new HttpsError("invalid-argument", "The link needs at least 3 letters or numbers.");
  if (RESERVED_SLUGS.has(slug)) throw new HttpsError("invalid-argument", "That link is reserved.");
  const storeRef = db.doc(`stores/${t.storeId}`);
  const result = await db.runTransaction(async (tx) => {
    const st = (await tx.get(storeRef)).data();
    if (!st) throw new HttpsError("not-found", "Store not found.");
    const old = st.slug;
    if (old === slug) return { slug, old, same: true };
    const newRef = db.doc(`publicStores/${slug}`);
    const taken = await tx.get(newRef);
    if (taken.exists && taken.data().storeId !== t.storeId && taken.data().redirectStoreId !== t.storeId) throw new HttpsError("already-exists", "That link is already taken by another store.");
    tx.set(newRef, { storeId: t.storeId, name: st.name, slug, mode: st.mode, categories: [], items: [], updatedAt: FieldValue.serverTimestamp() });
    // old link → redirect (printed QR codes keep working)
    if (old) tx.set(db.doc(`publicStores/${old}`), { redirectTo: slug, redirectStoreId: t.storeId, updatedAt: FieldValue.serverTimestamp() });
    tx.update(storeRef, { slug, previousSlugs: FieldValue.arrayUnion(...(old ? [old] : [])), updatedAt: FieldValue.serverTimestamp() });
    return { slug, old };
  });
  if (!result.same) {
    // older redirects of this store point straight to the new link
    const prev = ((await storeRef.get()).data()?.previousSlugs || []).filter((x) => x !== slug);
    await Promise.all(prev.map((x) => db.doc(`publicStores/${x}`).set({ redirectTo: slug, redirectStoreId: t.storeId, updatedAt: FieldValue.serverTimestamp() })));
    if (t.orgId) {
      const orgRef = db.doc(`orgs/${t.orgId}`); const org = (await orgRef.get()).data();
      if (org?.branches) await orgRef.update({ branches: org.branches.map((b) => (b.storeId === t.storeId ? { ...b, slug } : b)) });
    }
    await rebuildPublicStore(t.storeId);
  }
  return { slug: result.slug };
});

/** Owner: delete all test orders (T1, T2…) */
exports.clearTestOrders = onCall(async (req) => {
  const t = requireOwner(req);
  let n = 0; let batch = db.batch();
  for (const col of ["orders", "appointments", "stays", "reservations", "waitlist", "giftcards", "slotWaits"]) {
    const snap = await db.collection(`stores/${t.storeId}/${col}`).where("test", "==", true).get();
    for (const d of snap.docs) { batch.delete(d.ref); if (++n % 400 === 0) { await batch.commit(); batch = db.batch(); } }
  }
  await batch.commit();
  await db.doc(`stores/${t.storeId}/meta/testCounters`).delete().catch(() => {});
  return { deleted: n };
});

/** Owner: rebuild the customer page now and report what customers will see */
exports.refreshPublicStore = onCall(async (req) => {
  const t = requireOwner(req);
  await rebuildPublicStore(t.storeId);
  const store = (await db.doc(`stores/${t.storeId}`).get()).data() || {};
  const pub = (await db.doc(`publicStores/${store.slug}`).get()).data() || {};
  return { categories: (pub.categories || []).length, items: (pub.items || []).length, available: (pub.items || []).filter((i) => i.available).length };
});

exports.syncStore = onDocumentWritten("stores/{storeId}", async (event) => {
  await rebuildPublicStore(event.params.storeId);
  await syncRoomTables(event.params.storeId, event.data?.after?.data());
});

/** Each VIP room has a matching "table" doc (with QR) so customers can order inside the room */
async function syncRoomTables(storeId, store) {
  if (!store) return;
  const vipOk = store.settings?.vip?.enabled && (await storeEntitled(storeId, "events_vip"));
  const rooms = vipOk ? store.settings.vip.rooms || [] : [];
  const col = db.collection(`stores/${storeId}/tables`);
  const existing = await col.where("isRoom", "==", true).get();
  const byRoom = new Map(existing.docs.map((d) => [d.data().roomId, d]));
  const batch = db.batch();
  let changed = false;
  rooms.forEach((r, i) => {
    const d = byRoom.get(r.id);
    if (!d) { batch.set(col.doc(`room_${r.id}`), { label: r.name, isRoom: true, roomId: r.id, qrToken: "r" + Math.random().toString(36).slice(2, 9), active: true, sortOrder: 1000 + i, createdAt: FieldValue.serverTimestamp() }); changed = true; }
    else if (d.data().label !== r.name || d.data().active === false) { batch.update(d.ref, { label: r.name, active: true }); changed = true; }
    byRoom.delete(r.id);
  });
  for (const d of byRoom.values()) { if (d.data().active !== false) { batch.update(d.ref, { active: false }); changed = true; } }
  if (changed) await batch.commit();
}
exports.syncCategories = onDocumentWritten("stores/{storeId}/categories/{id}", async (event) => {
  await rebuildPublicStore(event.params.storeId);
});
exports.syncItems = onDocumentWritten("stores/{storeId}/items/{id}", async (event) => {
  if (!event.data?.before?.exists && event.data?.after?.exists && (await overPlanLimit(event.params.storeId, "items"))) { await event.data.after.ref.delete(); return; }
  await rebuildPublicStore(event.params.storeId);
});
/** Plan limits for items / tables (the dashboard also blocks before saving) */
async function overPlanLimit(storeId, kind) {
  const sub = (await db.doc(`stores/${storeId}/subscription/current`).get()).data();
  const lim = Number(sub?.limits?.[kind]) || 0; if (!lim) return false;
  const q = db.collection(`stores/${storeId}/${kind}`);
  let n = (await q.count().get()).data().count;
  if (kind === "tables") n -= (await q.where("isRoom", "==", true).count().get()).data().count + (await q.where("isWaitlist", "==", true).count().get()).data().count; // VIP-room and waitlist QRs don't count
  if (n <= lim) return false;
  await db.doc(`stores/${storeId}`).set({ notice: { kind: "limit", text: `Your plan allows ${lim} ${kind === "items" ? "menu items" : "tables"}. The newest one was not saved — upgrade in Billing for more.`, at: Date.now() } }, { merge: true });
  return true;
}
exports.syncSubscription = onDocumentWritten("stores/{storeId}/subscription/{id}", async (event) => {
  await rebuildPublicStore(event.params.storeId);
});
// customer stats when an order is completed / cancelled
const DONE_ST = ["completed", "delivered", "picked_up", "claimed"];
/** Café loyalty: 1 stamp per completed + paid order ≥ min total, max N stamps per day per phone (anti-abuse). */
async function stampOrder(storeId, orderRef, o) {
  if (o.type !== "table" || o.loyaltyStamp || !o.paid || !DONE_ST.includes(o.status) || !o.customerKey || String(o.customerKey).length < 7) return;
  const st = (await db.doc(`stores/${storeId}`).get()).data() || {}; const L = st.settings?.loyalty;
  if (!L?.enabled || !(await storeEntitled(storeId, "loyalty"))) return;
  if ((o.total || 0) + (o.discounts?.loyalty || 0) < (Number(L.minTotal) || 0)) return;
  const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10), perDay = Math.max(1, Number(L.maxPerDay) || 1);
  const cRef = db.doc(`stores/${storeId}/customers/${o.customerKey}`);
  const ok = await db.runTransaction(async (tx) => {
    const c = (await tx.get(cRef)).data() || {};
    const today = c.stampDay === day ? c.stampsToday || 0 : 0;
    if (today >= perDay) return false;
    tx.set(cRef, { stamps: FieldValue.increment(1), stampsEarned: FieldValue.increment(1), stampDay: day, stampsToday: today + 1, lastStampAt: FieldValue.serverTimestamp() }, { merge: true });
    return true;
  });
  await orderRef.update({ loyaltyStamp: ok ? "earned" : "daily_limit" });
}
exports.onOrderStatus = onDocumentWritten("stores/{storeId}/orders/{id}", async (event) => {
  const before = event.data?.before?.data(), after = event.data?.after?.data();
  // plan limits: a cancelled order (bogus / customer cancel / not confirmed) gives its daily slot back
  if (before && after && !after.test && before.status !== "cancelled" && after.status === "cancelled" && after.dayKey) {
    const uRef = db.doc(`stores/${event.params.storeId}/stats/usage`);
    await db.runTransaction(async (tx) => { const u = (await tx.get(uRef)).data() || {}; if (u.day !== after.dayKey) return; tx.set(uRef, { cancelled: (u.cancelledDay === after.dayKey ? u.cancelled || 0 : 0) + 1, cancelledDay: after.dayKey }, { merge: true }); }).catch(() => {});
  }
  if (!after || after.test || !after.customerKey || !before) return;
  if (before.paid !== after.paid && before.status === after.status) { await stampOrder(event.params.storeId, event.data.after.ref, after).catch((e) => logger.warn("stamp", e.message)); return; }
  if (before.status === after.status) return;
  if (DONE_ST.includes(after.status)) await stampOrder(event.params.storeId, event.data.after.ref, after).catch((e) => logger.warn("stamp", e.message));
  if (after.status === "cancelled" && after.loyaltyReward && !after.loyaltyRefunded) {
    await db.doc(`stores/${event.params.storeId}/customers/${after.customerKey}`).set({ stamps: FieldValue.increment(after.loyaltyReward.stamps || 0), rewardsUsed: FieldValue.increment(-1) }, { merge: true });
    await event.data.after.ref.update({ loyaltyRefunded: true });
  }
  const ref = db.doc(`stores/${event.params.storeId}/customers/${after.customerKey}`);
  if (["completed", "delivered", "picked_up", "claimed"].includes(after.status)) await ref.set({ completed: FieldValue.increment(1), lastCompletedAt: FieldValue.serverTimestamp(), ...(after.type === "laundry" && after.laundry?.kg ? { kgTotal: FieldValue.increment(after.laundry.kg) } : {}) }, { merge: true });
  else if (after.status === "cancelled") await ref.set({ cancelled: FieldValue.increment(1) }, { merge: true });
});

// auto-cancel unconfirmed orders past their deadline (every 5 min)
exports.cancelUnconfirmed = onSchedule({ schedule: "every 5 minutes", timeZone: "Asia/Manila" }, async () => {
  const now = Date.now();
  for (const col of ["orders", "reservations"]) {
    const snap = await db.collectionGroup(col).where("status", "==", "unconfirmed").get();
    for (const d of snap.docs) {
      const dl = d.data().confirmDeadline?.toMillis?.();
      if (dl && dl < now) await d.ref.update({ status: "cancelled", cancelReason: "Not confirmed in time", updatedAt: FieldValue.serverTimestamp() });
    }
  }
});

// reservation → pre-order sync: table assignment and cancel/no-show
exports.onReservationWrite = onDocumentWritten("stores/{storeId}/reservations/{id}", async (event) => {
  const before = event.data?.before?.data(), after = event.data?.after?.data();
  if (!after?.preorder?.orderId || !before) return;
  const oRef = db.doc(`stores/${event.params.storeId}/orders/${after.preorder.orderId}`);
  const patch = {};
  if (after.tableId !== before.tableId) { patch.tableId = after.tableId || null; patch.tableLabel = after.tableLabel || null; }
  if (["cancelled", "no_show"].includes(after.status) && !["cancelled", "no_show"].includes(before.status)) { patch.status = "cancelled"; patch.cancelReason = `Reservation ${after.status.replace("_", " ")}`; }
  if (Object.keys(patch).length) await oRef.update({ ...patch, updatedAt: FieldValue.serverTimestamp() }).catch(() => {});
});

// VIP reservation → Seated = auto-start the room session
exports.onVipSeated = onDocumentWritten("stores/{storeId}/reservations/{id}", async (event) => {
  const before = event.data?.before?.data(), after = event.data?.after?.data();
  if (!after || after.kind !== "vip" || after.status !== "seated" || before?.status === "seated" || !after.roomId) return;
  const storeId = event.params.storeId;
  if (await openSessionId(storeId, after.roomId)) return;
  const storeSnap = await db.doc(`stores/${storeId}`).get();
  const room = (storeSnap.data()?.settings?.vip?.rooms || []).find((r) => r.id === after.roomId);
  if (!room) return;
  await db.collection(`stores/${storeId}/sessions`).add({
    roomId: room.id, roomName: room.name, status: "open", pax: after.pax || 0, bookedHours: after.hours || room.minHours || 1,
    pricing: room.pricing || "hour", ratePerHour: Number(room.ratePerHour) || 0, minSpend: Number(room.minSpend) || 0, minHours: Number(room.minHours) || 1,
    reservationId: event.params.id, reservationCode: after.code, customerName: after.name || "", includePrior: false, priorTotal: 0,
    startedAt: FieldValue.serverTimestamp(), startedBy: "reservation", createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  });
  // link the pre-order to the session
  if (after.preorder?.orderId) {
    const sid = await openSessionId(storeId, room.id);
    await db.doc(`stores/${storeId}/orders/${after.preorder.orderId}`).update({ sessionId: sid, roomId: room.id, tableId: `room_${room.id}`, tableLabel: room.name }).catch(() => {});
  }
});

// public copy of the room session so customers inside the room can see it (time, consumed vs min)
async function publishRoomSession(storeId, roomId) {
  const storeSnap = await db.doc(`stores/${storeId}`).get();
  const slug = storeSnap.data()?.slug; if (!slug) return;
  const sid = await openSessionId(storeId, roomId);
  const ref = db.doc(`publicStores/${slug}/rooms/${roomId}`);
  if (!sid) return ref.set({ open: false, updatedAt: FieldValue.serverTimestamp() });
  const ses = (await db.doc(`stores/${storeId}/sessions/${sid}`).get()).data();
  const oSnap = await db.collection(`stores/${storeId}/orders`).where("sessionId", "==", sid).get();
  const consumed = oSnap.docs.map((x) => x.data()).filter((o) => o.status !== "cancelled" && o.source !== "room").reduce((a, o) => a + (o.total || 0), 0) + (ses.includePrior ? ses.priorTotal || 0 : 0);
  await ref.set({ open: true, roomName: ses.roomName, pricing: ses.pricing, ratePerHour: ses.ratePerHour, minSpend: ses.minSpend, minHours: ses.minHours, bookedHours: ses.bookedHours, startedAt: ses.startedAt || FieldValue.serverTimestamp(), consumed: round2(consumed), updatedAt: FieldValue.serverTimestamp() });
}
exports.onSessionWrite = onDocumentWritten("stores/{storeId}/sessions/{id}", async (event) => {
  const d = event.data?.after?.data() || event.data?.before?.data();
  if (d?.roomId) await publishRoomSession(event.params.storeId, d.roomId);
});
exports.onRoomOrderWrite = onDocumentWritten("stores/{storeId}/orders/{id}", async (event) => {
  const a = event.data?.after?.data(), b = event.data?.before?.data();
  const roomId = a?.roomId || b?.roomId;
  if (roomId && (a?.sessionId || b?.sessionId)) await publishRoomSession(event.params.storeId, roomId);
});

// endSession — computes the room charge / consumable shortfall and creates a charge order on the bill
exports.endSession = onCall(async (req) => {
  const { token } = requireAuth(req);
  const storeId = token.storeId;
  if (!storeId) throw new HttpsError("permission-denied", "No store.");
  const d = req.data || {};
  const ref = db.doc(`stores/${storeId}/sessions/${String(d.sessionId || "")}`);
  const snap = await ref.get();
  if (!snap.exists || snap.data().status !== "open") throw new HttpsError("failed-precondition", "No open session.");
  const ses = snap.data();
  const started = ses.startedAt?.toMillis?.() || Date.now();
  const elapsedH = Math.max(0, (Date.now() - started) / 3600000);
  const storeDoc = (await db.doc(`stores/${storeId}`).get()).data() || {};
  const ot = storeDoc.settings?.vip?.overtime || null;
  const planned = Math.max(ses.minHours || 1, ses.bookedHours || 0);
  // when overtime penalty is on: booked hours only + penalty (no round-up); otherwise: round up to the hour (6-min grace)
  const hours = ot?.enabled ? planned : Math.max(ses.minHours || 1, Math.ceil(elapsedH - 0.1));
  const { overMin, penalty } = overtimeFor(ot, started, planned);
  const ordersSnap = await db.collection(`stores/${storeId}/orders`).where("sessionId", "==", snap.id).get();
  // take-out packs ordered from the room are billed separately (not part of the consumable)
  const consumed = ordersSnap.docs.map((x) => x.data()).filter((o) => o.status !== "cancelled" && o.source !== "room" && !o.pack).reduce((a, o) => a + (o.total || 0), 0) + (ses.includePrior ? ses.priorTotal || 0 : 0);
  let roomCharge = 0, shortfall = 0, label = "";
  // free VIP hours voucher (hourly rooms)
  let vipFree = 0, vipCode = null;
  if (d.voucherCode && ses.pricing === "hour") {
    const vRef = db.doc(`stores/${storeId}/vouchers/${String(d.voucherCode).trim().toUpperCase()}`); const v = (await vRef.get()).data();
    if (!v || v.type !== "viphours" || v.active === false || (v.usedCount || 0) >= (v.maxUses || 1) || (v.validTo && v.validTo < new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10))) throw new HttpsError("failed-precondition", "That free VIP hours code is invalid, used or expired.");
    vipFree = Number(v.value) || 0; vipCode = vRef.id;
    await vRef.update({ usedCount: FieldValue.increment(1), usedFor: snap.id, usedAt: FieldValue.serverTimestamp() });
  }
  if (ses.pricing === "hour") { const paidH = Math.max(0, hours - vipFree); roomCharge = ses.ratePerHour * paidH; label = `${ses.roomName} room charge · ${hours}h × ₱${ses.ratePerHour}${vipFree ? ` (−${Math.min(vipFree, hours)}h free, ${vipCode})` : ""}`; }
  else if (ses.pricing === "consumable") { shortfall = Math.max(0, ses.minSpend - consumed); label = `${ses.roomName} consumable shortfall (min ₱${ses.minSpend} − orders ₱${consumed})`; }
  else { roomCharge = ses.ratePerHour * hours; shortfall = Math.max(0, roomCharge - consumed); roomCharge = 0; label = `${ses.roomName} room charge ${hours}h × ₱${ses.ratePerHour} − consumed ₱${consumed}`; }
  const extFee = Number(ses.extensionFee) || 0;
  const charge = round2(roomCharge + shortfall + penalty + (ses.pricing === "hour" ? 0 : extFee));
  let chargeOrderId = null;
  if (charge > 0) {
    const items = [];
    if (roomCharge + shortfall > 0) items.push({ itemId: null, name: label, qty: 1, unitPrice: round2(roomCharge + shortfall), choices: [], subtotal: round2(roomCharge + shortfall), station: "counter" });
    if (penalty > 0) items.push({ itemId: null, name: `${ses.roomName} overtime · ${overMin} min`, qty: 1, unitPrice: penalty, choices: [], subtotal: penalty, station: "counter" });
    const r = await commitOrder(storeId, { type: "table", serviceType: "dine_in", status: "completed", tableId: `room_${ses.roomId}`, tableLabel: ses.roomName, roomId: ses.roomId, sessionId: snap.id, items, stations: {}, subtotal: charge, deliveryFee: 0, total: charge, note: "", customer: { name: ses.customerName || "" }, customerUid: null, source: "room", paid: false, paymentMethod: null, etaMinutes: null, completedAt: FieldValue.serverTimestamp() }, { skipLimit: true });
    chargeOrderId = r.orderId;
  }
  await ref.update({ status: "closed", endedAt: FieldValue.serverTimestamp(), hours, consumed, roomCharge: round2(roomCharge), shortfall: round2(shortfall), overtimeMin: overMin, overtimePenalty: penalty, charge, chargeOrderId, endedBy: String(d.staffName || "").slice(0, 40), updatedAt: FieldValue.serverTimestamp() });
  return { hours, consumed, roomCharge, shortfall, overtimeMin: overMin, overtimePenalty: penalty, charge, chargeOrderId };
});

exports.syncFeedback = onDocumentWritten("stores/{storeId}/feedback/{id}", async (event) => {
  await rebuildPublicStore(event.params.storeId);
});
// ===========================================================================
// ANNOUNCEMENTS — public copy (active + customers audience + within dates)
// ===========================================================================
// shift submitted for check → alert owner if variance is beyond tolerance
exports.onShiftWrite = onDocumentWritten("stores/{storeId}/shifts/{id}", async (event) => {
  const a = event.data?.after?.data(), b = event.data?.before?.data();
  if (!a || a.status !== "pending_check" || b?.status === "pending_check") return;
  const tol = Number((await db.doc(`stores/${event.params.storeId}`).get()).data()?.settings?.shifts?.tolerance) || 0;
  const worst = Math.max(...Object.values(a.variance || {}).map((v) => Math.abs(Number(v) || 0)), 0);
  if (worst > tol) await notifyTelegram(event.params.storeId, "shiftVariance", `💰 Shift closed by ${a.closedByName || "staff"} — variance ₱${worst} (tolerance ₱${tol}). Needs checking.`);
  else if (worst === 0) return;
});
exports.syncStaffPublic = onDocumentWritten("stores/{storeId}/staff/{id}", async (event) => {
  const st = (await db.doc(`stores/${event.params.storeId}`).get()).data();
  if (st?.mode === "salon") await rebuildPublicStore(event.params.storeId);
});
exports.syncAnnouncements = onDocumentWritten("stores/{storeId}/announcements/{id}", async (event) => {
  await rebuildPublicStore(event.params.storeId);
});
async function publicAnnouncements(storeRef) {
  const snap = await storeRef.collection("announcements").where("active", "==", true).get();
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); // PH date
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((a) => a.audience?.customers !== false && (!a.dateFrom || a.dateFrom <= today) && (!a.dateTo || a.dateTo >= today))
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0))
    .slice(0, 8).map((a) => ({ id: a.id, title: a.title || "", body: a.body || "", imageUrl: a.imageUrl || null, pinned: !!a.pinned, at: a.createdAt?.toMillis?.() || null, type: a.type || "news", dateTo: a.dateTo || null, ...(a.btnUrl && /^https:\/\//.test(a.btnUrl) ? { btnText: String(a.btnText || "Open").slice(0, 40), btnUrl: a.btnUrl } : {}) }));
}

// ===========================================================================
// TELEGRAM ALERTS (add-on) — token/chat in private/telegram; events in settings.telegram
// ===========================================================================
const TG = (token, method) => `https://api.telegram.org/bot${token}/${method}`;
async function tgCall(token, method, body) {
  const res = await fetch(TG(token, method), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) throw new HttpsError("failed-precondition", `Telegram: ${j.description || res.status}`);
  return j.result;
}
function inQuiet(cfg) {
  if (!cfg?.quietFrom || !cfg?.quietTo) return false;
  const now = new Date(Date.now() + 8 * 3600000); const hm = `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}`;
  return cfg.quietFrom < cfg.quietTo ? hm >= cfg.quietFrom && hm < cfg.quietTo : hm >= cfg.quietFrom || hm < cfg.quietTo;
}
/** Send to the owner (best-effort; never throws) */
async function notifyTelegram(storeId, event, text, { force = false, safety = false } = {}) {
  try {
    const storeSnap = await db.doc(`stores/${storeId}`).get();
    const cfg = storeSnap.data()?.settings?.telegram;
    if (!cfg?.enabled || (cfg.events && cfg.events[event] === false)) return;
    if (inQuiet(cfg) && !force && !safety) return;
    if (!safety && !(await storeEntitled(storeId, "telegram"))) return; // safety alerts (SOS) always go out
    const priv = (await db.doc(`stores/${storeId}/private/telegram`).get()).data();
    if (!priv?.token || !priv?.chatId) return;
    await tgCall(priv.token, "sendMessage", { chat_id: priv.chatId, text: `${storeSnap.data().name}\n${text}`, disable_web_page_preview: true });
  } catch (e) { logger.warn("telegram failed", { storeId, event, msg: e.message }); }
}
exports.saveTelegram = onCall(async (req) => {
  const { token: t } = requireAuth(req);
  if (!t.storeId || t.role !== "owner") throw new HttpsError("permission-denied", "Owner only.");
  const botToken = String(req.data?.token || "").trim();
  if (!/^\d+:[\w-]{30,}$/.test(botToken)) throw new HttpsError("invalid-argument", "That bot token looks invalid (e.g. 123456789:AAH...).");
  const me = await tgCall(botToken, "getMe", {});
  await db.doc(`stores/${t.storeId}/private/telegram`).set({ token: botToken, botName: me.username || "", chatId: null, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { botName: me.username };
});
exports.telegramDetectChat = onCall(async (req) => {
  const { token: t } = requireAuth(req);
  if (!t.storeId || t.role !== "owner") throw new HttpsError("permission-denied", "Owner only.");
  const ref = db.doc(`stores/${t.storeId}/private/telegram`);
  const priv = (await ref.get()).data();
  if (!priv?.token) throw new HttpsError("failed-precondition", "Save the bot token first.");
  const upd = await tgCall(priv.token, "getUpdates", { limit: 20 });
  const msg = [...upd].reverse().map((u) => u.message || u.channel_post).find((m) => m?.chat?.id);
  if (!msg) throw new HttpsError("not-found", "No message found. Open the bot in Telegram, press Start, send any text, then try again.");
  await ref.update({ chatId: String(msg.chat.id), chatTitle: msg.chat.title || [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(" ") || msg.chat.username || "", updatedAt: FieldValue.serverTimestamp() });
  await tgCall(priv.token, "sendMessage", { chat_id: msg.chat.id, text: "✅ Connected to TapTayo. Alerts will arrive here." });
  return { chatId: String(msg.chat.id), chatTitle: msg.chat.title || msg.chat.first_name || "" };
});
exports.telegramTest = onCall(async (req) => {
  const { token: t } = requireAuth(req);
  if (!t.storeId || t.role !== "owner") throw new HttpsError("permission-denied", "Owner only.");
  const priv = (await db.doc(`stores/${t.storeId}/private/telegram`).get()).data();
  if (!priv?.token || !priv?.chatId) throw new HttpsError("failed-precondition", "Complete the token and chat setup first.");
  await tgCall(priv.token, "sendMessage", { chat_id: priv.chatId, text: "🔔 Test alert from TapTayo — it works!" });
  return { ok: true };
});
exports.telegramStatus = onCall(async (req) => {
  const { token: t } = requireAuth(req);
  if (!t.storeId || t.role !== "owner") throw new HttpsError("permission-denied", "Owner only.");
  const priv = (await db.doc(`stores/${t.storeId}/private/telegram`).get()).data() || {};
  return { hasToken: !!priv.token, botName: priv.botName || "", chatId: priv.chatId || null, chatTitle: priv.chatTitle || "" };
});

// ===========================================================================
// SMS PROMOS (Semaphore) — opt-in list + batch campaigns. API key in private/semaphore.
// ===========================================================================
const SEM = "https://api.semaphore.co/api/v4";
const phoneDigits = (p) => String(p || "").replace(/\D/g, "");
function phPhone(p) { // → 09XXXXXXXXX or null
  let d = phoneDigits(p);
  if (d.startsWith("63") && d.length === 12) d = "0" + d.slice(2);
  if (d.length === 10 && d.startsWith("9")) d = "0" + d;
  return /^09\d{9}$/.test(d) ? d : null;
}
async function semGet(path, apikey) {
  const res = await fetch(`${SEM}/${path}${path.includes("?") ? "&" : "?"}apikey=${encodeURIComponent(apikey)}`);
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new HttpsError("failed-precondition", `Semaphore: ${j?.message || j?.apikey?.[0] || res.status}`);
  return j;
}
async function semSend(apikey, numbers, message, sendername) {
  const res = await fetch(`${SEM}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ apikey, number: numbers.join(","), message, ...(sendername ? { sendername } : {}) }) });
  const j = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(j)) throw new Error(`Semaphore: ${JSON.stringify(j).slice(0, 200)}`);
  return j; // [{message_id, recipient, status, ...}]
}
const smsCredits = (msg) => Math.max(1, Math.ceil(msg.length / 160));

exports.saveSemaphore = onCall(async (req) => {
  const t = requireOwner(req);
  const apiKey = String(req.data?.apiKey || "").trim();
  if (apiKey.length < 20) throw new HttpsError("invalid-argument", "That API key looks invalid.");
  const acct = await semGet("account", apiKey);
  await db.doc(`stores/${t.storeId}/private/semaphore`).set({ apiKey, accountName: acct.account_name || "", updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { accountName: acct.account_name || "", credits: acct.credit_balance ?? null };
});
exports.semaphoreStatus = onCall(async (req) => {
  const t = requireOwner(req);
  const priv = (await db.doc(`stores/${t.storeId}/private/semaphore`).get()).data();
  if (!priv?.apiKey) return { hasKey: false };
  try { const acct = await semGet("account", priv.apiKey); return { hasKey: true, accountName: acct.account_name || "", credits: acct.credit_balance ?? null }; }
  catch (e) { return { hasKey: true, error: e.message }; }
});
exports.smsTest = onCall(async (req) => {
  const t = requireOwner(req);
  const num = phPhone(req.data?.number); if (!num) throw new HttpsError("invalid-argument", "Enter a PH mobile number (09XXXXXXXXX).");
  const priv = (await db.doc(`stores/${t.storeId}/private/semaphore`).get()).data();
  if (!priv?.apiKey) throw new HttpsError("failed-precondition", "Save the API key first.");
  const store = (await db.doc(`stores/${t.storeId}`).get()).data();
  const r = await semSend(priv.apiKey, [num], `Test from ${store.name} (TapTayo). SMS promos are working!`, store.settings?.sms?.senderName || "");
  return { status: r[0]?.status || "queued" };
});

// customer: opt-in / opt-out (from the order or reservation status page)
exports.smsOptIn = onCall(async (req) => {
  const { uid } = requireAuth(req);
  const d = req.data || {};
  const storeId = String(d.storeId || "");
  const optIn = !!d.optIn;
  const num = phPhone(d.phone);
  if (!storeId || !num) throw new HttpsError("invalid-argument", "Enter a mobile number (09XXXXXXXXX).");
  if (!(await storeEntitled(storeId, "sms"))) throw new HttpsError("failed-precondition", "Not available.");
  // they must have an order/reservation at the store (proof they are a customer)
  let name = String(d.name || "").trim().slice(0, 60), src = null;
  if (d.orderId) { const o = (await db.doc(`stores/${storeId}/orders/${String(d.orderId)}`).get()); if (!o.exists || o.data().customerUid !== uid) throw new HttpsError("permission-denied", "This is not your order."); name = name || o.data().customer?.name || ""; src = `order:${o.id}`; await o.ref.update({ smsOptIn: optIn }); }
  else if (d.reservationId) { const r = (await db.doc(`stores/${storeId}/reservations/${String(d.reservationId)}`).get()); if (!r.exists || !ownsResv(r.data(), uid)) throw new HttpsError("permission-denied", "This is not your reservation."); name = name || r.data().name || ""; src = `resv:${r.id}`; await r.ref.update({ smsOptIn: optIn }); }
  else if (d.appointmentId) { const r = (await db.doc(`stores/${storeId}/appointments/${String(d.appointmentId)}`).get()); if (!r.exists || !ownsResv(r.data(), uid)) throw new HttpsError("permission-denied", "This is not your booking."); name = name || r.data().customer?.name || ""; src = `appt:${r.id}`; await r.ref.update({ smsOptIn: optIn }); }
  else throw new HttpsError("invalid-argument", "Missing order.");
  const key = phoneDigits(num);
  await db.doc(`stores/${storeId}/customers/${key}`).set({
    phone: num, ...(name ? { name } : {}), smsOptIn: optIn, smsOptInAt: optIn ? FieldValue.serverTimestamp() : null, smsOptOutAt: optIn ? null : FieldValue.serverTimestamp(), smsSource: src,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  return { ok: true };
});

// owner: create a campaign (send now or scheduled)
exports.sendSmsCampaign = onCall({ timeoutSeconds: 540 }, async (req) => {
  const t = requireOwner(req);
  const storeId = t.storeId;
  const d = req.data || {};
  const message = String(d.message || "").trim().slice(0, 480);
  if (message.length < 10) throw new HttpsError("invalid-argument", "Message is too short.");
  if (!(await storeEntitled(storeId, "sms"))) throw new HttpsError("failed-precondition", "Add-on: SMS promos — activate it in Billing.");
  const store = (await db.doc(`stores/${storeId}`).get()).data();
  const cfg = store.settings?.sms || {};
  if (!cfg.enabled) throw new HttpsError("failed-precondition", "Turn on SMS promos in Settings first.");
  const priv = (await db.doc(`stores/${storeId}/private/semaphore`).get()).data();
  if (!priv?.apiKey) throw new HttpsError("failed-precondition", "No Semaphore API key.");
  const scheduleAt = d.scheduleAt ? new Date(d.scheduleAt) : null;
  if (scheduleAt && !(scheduleAt > new Date())) throw new HttpsError("invalid-argument", "Schedule must be in the future.");
  if (!scheduleAt && inQuiet(cfg)) throw new HttpsError("failed-precondition", `It is currently quiet hours (${cfg.quietFrom}–${cfg.quietTo}). Please schedule it instead.`);
  // 1 campaign per day (PH)
  const dayStart = new Date(); dayStart.setUTCHours(dayStart.getUTCHours() + 8); dayStart.setUTCHours(0, 0, 0, 0); dayStart.setUTCHours(dayStart.getUTCHours() - 8);
  const todaySnap = await db.collection(`stores/${storeId}/campaigns`).where("createdAt", ">=", dayStart).get();
  if (todaySnap.docs.some((x) => x.data().status !== "cancelled")) throw new HttpsError("resource-exhausted", "Only 1 campaign per day (anti-spam). Try again tomorrow or schedule it.");
  // recipients
  const filter = ["all", "returning", "inactive30"].includes(d.filter) ? d.filter : "all";
  const cSnap = await db.collection(`stores/${storeId}/customers`).where("smsOptIn", "==", true).get();
  const cutoff = Date.now() - 30 * 86400000;
  const recips = cSnap.docs.map((x) => ({ id: x.id, ...x.data() })).filter((c) => !c.flagged && phPhone(c.phone))
    .filter((c) => filter === "all" || (filter === "returning" ? (c.completed || 0) >= 2 : (c.lastOrderAt?.toMillis?.() || 0) < cutoff))
    .slice(0, 1000);
  if (!recips.length) throw new HttpsError("failed-precondition", "No opted-in customers match this filter.");
  const ref = db.collection(`stores/${storeId}/campaigns`).doc();
  const base = { message, filter, recipients: recips.length, credits: recips.length * smsCredits(message), senderName: cfg.senderName || "", scheduledAt: scheduleAt ? Timestamp.fromDate(scheduleAt) : null, status: scheduleAt ? "scheduled" : "sending", sent: 0, failed: 0, createdBy: t.email || null, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() };
  await ref.set(base);
  if (scheduleAt) return { id: ref.id, status: "scheduled", recipients: recips.length };
  const r = await runCampaign(storeId, ref.id, priv.apiKey, base, recips);
  return { id: ref.id, ...r };
});
async function runCampaign(storeId, id, apiKey, camp, recips) {
  const ref = db.doc(`stores/${storeId}/campaigns/${id}`);
  let sent = 0, failed = 0; const errors = [];
  const personalized = /\{name\}/i.test(camp.message);
  const groups = personalized ? recips.map((c) => [c]) : Array.from({ length: Math.ceil(recips.length / 100) }, (_, i) => recips.slice(i * 100, i * 100 + 100));
  for (const g of groups) {
    const msg = personalized ? camp.message.replace(/\{name\}/gi, (g[0].name || "there").split(" ")[0]) : camp.message;
    try { const r = await semSend(apiKey, g.map((c) => phPhone(c.phone)), msg, camp.senderName); sent += r.length; failed += g.length - r.length; }
    catch (e) { failed += g.length; if (errors.length < 5) errors.push(e.message); }
  }
  await ref.update({ status: failed && !sent ? "failed" : "sent", sent, failed, errors, sentAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  return { status: failed && !sent ? "failed" : "sent", sent, failed };
}
exports.cancelSmsCampaign = onCall(async (req) => {
  const t = requireOwner(req);
  const ref = db.doc(`stores/${t.storeId}/campaigns/${String(req.data?.id || "")}`);
  const snap = await ref.get();
  if (!snap.exists || snap.data().status !== "scheduled") throw new HttpsError("failed-precondition", "This can no longer be cancelled.");
  await ref.update({ status: "cancelled", updatedAt: FieldValue.serverTimestamp() });
  return { ok: true };
});
// scheduled campaigns — every 5 min
exports.runSmsCampaigns = onSchedule({ schedule: "every 5 minutes", timeZone: "Asia/Manila", timeoutSeconds: 540 }, async () => {
  const snap = await db.collectionGroup("campaigns").where("status", "==", "scheduled").where("scheduledAt", "<=", Timestamp.now()).get();
  for (const d of snap.docs) {
    const storeId = d.ref.parent.parent.id;
    try {
      if (!(await storeEntitled(storeId, "sms"))) { await d.ref.update({ status: "failed", errors: ["Add-on expired"] }); continue; }
      const priv = (await db.doc(`stores/${storeId}/private/semaphore`).get()).data();
      const camp = d.data();
      const cSnap = await db.collection(`stores/${storeId}/customers`).where("smsOptIn", "==", true).get();
      const cutoff = Date.now() - 30 * 86400000;
      const recips = cSnap.docs.map((x) => ({ id: x.id, ...x.data() })).filter((c) => !c.flagged && phPhone(c.phone))
        .filter((c) => camp.filter === "all" || (camp.filter === "returning" ? (c.completed || 0) >= 2 : (c.lastOrderAt?.toMillis?.() || 0) < cutoff)).slice(0, 1000);
      await d.ref.update({ status: "sending", recipients: recips.length });
      await runCampaign(storeId, d.id, priv?.apiKey, camp, recips);
    } catch (e) { await d.ref.update({ status: "failed", errors: [e.message] }); }
  }
});

// ===========================================================================
// LAUNDRY — jobs (walk-in via counter), claim stub binding, pricing
// ===========================================================================
const CLAIM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const claimCode = () => Array.from({ length: 5 }, () => CLAIM_ALPHABET[Math.floor(Math.random() * CLAIM_ALPHABET.length)]).join("");
function laundryPrice(items, catalog, cfg, d) {
  // items: [{ itemId, qty }] — qty = kg (unit kg), pieces (unit piece) or loads (unit load); estimate = 0 until staff prices it
  const lines = []; let subtotal = 0, kg = 0, estimateOnly = false;
  for (const line of items) {
    const it = catalog.get(String(line.itemId || "")); if (!it) throw new HttpsError("not-found", "A service is no longer on the list.");
    const unit = it.unit || "piece";
    let qty = Math.max(0, Number(line.qty) || 0);
    let unitPrice = Number(it.price) || 0, sub = 0, label = "";
    if (unit === "kg") { if (qty > 0 && qty < (cfg.minKg || 0)) qty = cfg.minKg; kg += qty; sub = round2(unitPrice * qty); label = `${qty} kg`; }
    else if (unit === "load") { sub = round2(unitPrice * Math.max(1, Math.ceil(qty))); label = `${Math.max(1, Math.ceil(qty))} load`; }
    else if (unit === "estimate") { estimateOnly = true; sub = Number(line.price) || 0; unitPrice = sub; label = sub ? "quoted" : "estimate pending"; qty = 1; }
    else { qty = Math.max(1, Math.round(qty || 1)); sub = round2(unitPrice * qty); label = `${qty} pc${qty > 1 ? "s" : ""}`; }
    subtotal += sub;
    lines.push({ itemId: it.id || String(line.itemId), name: it.name, unit, qty, unitPrice, subtotal: sub, label, note: String(line.note || "").slice(0, 120), choices: [], station: "counter" });
  }
  if (d.fold === false && !cfg.foldFree && cfg.foldFee) { /* no fold chosen: nothing added */ }
  else if (!cfg.foldFree && cfg.foldFee && d.fold !== false && kg > 0) { const f = round2(cfg.foldFee * kg); subtotal += f; lines.push({ itemId: null, name: "Folding", unit: "kg", qty: kg, unitPrice: cfg.foldFee, subtotal: f, label: `${kg} kg`, choices: [], station: "counter" }); }
  let rushFee = 0;
  if (d.rush) { rushFee = cfg.rushMode === "fixed" ? Number(cfg.rushValue) || 0 : cfg.rushMode === "double" ? subtotal : round2(subtotal * (Number(cfg.rushValue) || 50) / 100); if (rushFee) lines.push({ itemId: null, name: "Rush service", unit: "piece", qty: 1, unitPrice: rushFee, subtotal: rushFee, label: cfg.rushMode === "double" ? "2×" : cfg.rushMode === "fixed" ? "fixed" : `+${cfg.rushValue || 50}%`, choices: [], station: "counter" }); subtotal += rushFee; }
  const loads = kg ? Math.max(1, Math.ceil(kg / (cfg.maxLoadKg || 8))) : 0;
  return { lines, subtotal: round2(subtotal), kg: round2(kg), loads, estimateOnly, rushFee };
}
function storageFeeFor(o, cfg) {
  if (!cfg.storageFeePerDay || o.status !== "ready" || !o.readyAt?.toMillis) return { days: 0, fee: 0 };
  const days = Math.floor((Date.now() - o.readyAt.toMillis()) / 86400000) - (Number(cfg.storageFreeDays) || 0);
  return days > 0 ? { days, fee: round2(days * cfg.storageFeePerDay) } : { days: 0, fee: 0 };
}
async function loyaltyFor(storeId, phoneKey, cfg) {
  if (!cfg.loyalty?.enabled || !phoneKey) return null;
  const c = (await db.doc(`stores/${storeId}/customers/${phoneKey}`).get()).data() || {};
  const every = Number(cfg.loyalty.everyKg) || 10, free = Number(cfg.loyalty.freeKg) || 1;
  const earned = Math.floor((c.kgTotal || 0) / every) * free;
  return { kgTotal: round2(c.kgTotal || 0), every, free, available: Math.max(0, round2(earned - (c.kgRedeemed || 0))), toNext: round2(every - ((c.kgTotal || 0) % every)) };
}
async function laundryCatalog(storeId) {
  const snap = await db.collection(`stores/${storeId}/items`).get();
  return new Map(snap.docs.map((x) => [x.id, { id: x.id, ...x.data() }]));
}
// counter: create a walk-in / drop-off job
exports.createLaundryJob = onCall(async (req) => {
  await maintGuard(req);
  const { token } = requireAuth(req);
  const storeId = token.storeId; if (!storeId) throw new HttpsError("permission-denied", "No store.");
  const d = req.data || {};
  const store = (await db.doc(`stores/${storeId}`).get()).data();
  if (store.mode !== "laundry") throw new HttpsError("failed-precondition", "Not a laundry store.");
  const cfg = store.settings?.laundry || {};
  const customer = { name: String(d.customer?.name || "").trim().slice(0, 60), phone: String(d.customer?.phone || "").trim().slice(0, 30), address: String(d.customer?.address || "").trim().slice(0, 200), messenger: msgrOf(d.customer?.messenger) };
  if (!customer.name) throw new HttpsError("invalid-argument", "Customer name is required.");
  const items = Array.isArray(d.items) ? d.items : []; if (!items.length) throw new HttpsError("invalid-argument", "Pick at least one service.");
  const priced = laundryPrice(items, await laundryCatalog(storeId), cfg, d);
  let { lines, subtotal, kg, loads, estimateOnly, rushFee } = priced;
  const phoneKey0 = customer.phone.replace(/\D/g, "");
  const loy = await loyaltyFor(storeId, phoneKey0.length >= 7 ? phoneKey0 : null, cfg);
  let freeKgUsed = 0;
  if (loy && d.useFreeKg > 0 && kg > 0) {
    freeKgUsed = Math.min(Number(d.useFreeKg) || 0, loy.available, kg);
    const kgLine = lines.find((l) => l.unit === "kg");
    if (freeKgUsed > 0 && kgLine) { const disc = round2(freeKgUsed * kgLine.unitPrice); lines.push({ itemId: null, name: `Loyalty reward · ${freeKgUsed} kg free`, unit: "kg", qty: freeKgUsed, unitPrice: -kgLine.unitPrice, subtotal: -disc, label: "reward", choices: [], station: "counter" }); subtotal = round2(subtotal - disc); }
    else freeKgUsed = 0;
  }
  const mode = ["dropoff_pickup", "rider_rider", "dropoff_delivery", "rider_pickup"].includes(d.mode) ? d.mode : "dropoff_pickup";
  const needsDelivery = mode === "rider_rider" || mode === "dropoff_delivery";
  const deliveryFee = needsDelivery ? Math.max(0, Number(d.deliveryFee) || 0) : 0;
  const total = round2(subtotal + deliveryFee);
  const paid = !!d.paid;
  const weighed = kg > 0 || (!estimateOnly && lines.length > 0);
  const status = !weighed ? "received" : (cfg.paymentFirst && !paid) ? "waiting_payment" : "washing";
  const busyExtra = store.settings?.busy?.active && !d.rush ? Number(store.settings.busy.extraHours) || 0 : 0;
  const etaH = (d.rush ? cfg.rushEtaHours || 6 : cfg.etaHours || 24) + busyExtra;
  const phoneKey = customer.phone.replace(/\D/g, "");
  const { orderId } = await commitOrder(storeId, {
    type: "laundry", serviceType: needsDelivery ? "delivery" : "pickup", status, tableId: null, tableLabel: null,
    items: lines, stations: {}, subtotal, deliveryFee, deliveryFeePending: needsDelivery && !deliveryFee, total, note: String(d.note || "").slice(0, 300), customer,
    discounts: { promo: 0, voucher: 0 }, customerUid: null, customerKey: phoneKey.length >= 7 ? phoneKey : null, source: "counter",
    staffId: d.staffId ? String(d.staffId) : null, staffName: d.staffName ? String(d.staffName).slice(0, 40) : null,
    paid, ...(paid ? payFields(store, String(d.paymentMethod || "cash")) : { paymentMethod: null }), paidAt: paid ? FieldValue.serverTimestamp() : null, etaMinutes: null,
    laundry: { mode, ticketNo: String(d.ticketNo || "").trim().slice(0, 12), claimCode: claimCode(), container: String(d.container || "none").slice(0, 20), kg, loads, pcs: d.pcs != null ? Math.max(0, parseInt(d.pcs, 10) || 0) : null, rush: !!d.rush, rushFee, fold: d.fold !== false, separateWhites: d.separateWhites !== false, handWash: String(d.handWash || "").slice(0, 200), estimateOnly, weighedAt: weighed ? FieldValue.serverTimestamp() : null, readyBy: Timestamp.fromMillis(Date.now() + etaH * 3600000), claimedAt: null, claimedBy: null, boundUid: null, freeKgUsed, loyalty: loy ? { kgTotal: loy.kgTotal, available: round2(loy.available - freeKgUsed), every: loy.every, free: loy.free } : null },
  });
  if (phoneKey.length >= 7) await db.doc(`stores/${storeId}/customers/${phoneKey}`).set({ phone: customer.phone, name: customer.name, address: customer.address || "", orders: FieldValue.increment(1), lastOrderAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), ...(freeKgUsed ? { kgRedeemed: FieldValue.increment(freeKgUsed) } : {}) }, { merge: true });
  const snap = await db.doc(`stores/${storeId}/orders/${orderId}`).get();
  return { orderId, orderNo: snap.data().orderNo, claimCode: snap.data().laundry.claimCode, total, status };
});
// customer: online booking (rider pickup / delivery modes). Priced later at the shop.
exports.bookLaundryJob = onCall(withIndex("order", async (req) => {
  await maintGuard(req);
  const { uid } = requireAuth(req);
  const d = req.data || {};
  const pubSnap = await db.doc(`publicStores/${String(d.slug || "")}`).get();
  if (!pubSnap.exists) throw new HttpsError("not-found", "Store not found.");
  const pub = pubSnap.data(); const storeId = pub.storeId;
  if (pub.mode !== "laundry") throw new HttpsError("failed-precondition", "Not a laundry store.");
  if (pub.locked || pub.acceptOrders === false) throw new HttpsError("failed-precondition", "The shop is not accepting bookings right now."); if (pub.comingSoon && !(pub.testMode && pub.testMode.until > Date.now())) throw new HttpsError("failed-precondition", "This shop is not open yet — coming soon!");
  const cfg = pub.laundry || {};
  const mode = ["rider_rider", "rider_pickup", "dropoff_delivery"].includes(d.mode) ? d.mode : null;
  if (!mode || cfg.modes?.[mode] === false) throw new HttpsError("invalid-argument", "That service mode is not available.");
  if (!(await storeEntitled(storeId, "delivery"))) throw new HttpsError("failed-precondition", "Pickup / delivery is not available at this shop.");
  const customer = { name: String(d.customer?.name || "").trim().slice(0, 60), phone: String(d.customer?.phone || "").trim().slice(0, 30), address: String(d.customer?.address || "").trim().slice(0, 200), messenger: msgrOf(d.customer?.messenger) };
  if (customer.name.length < 2 || !customer.phone) throw new HttpsError("invalid-argument", "Name and phone number are required.");
  if (!customer.address) throw new HttpsError("invalid-argument", "Address is required for pickup / delivery.");
  const phoneKey = customer.phone.replace(/\D/g, "");
  if (phoneKey.length >= 7) { const c = (await db.doc(`stores/${storeId}/customers/${phoneKey}`).get()).data(); if (c?.flagged) throw new HttpsError("permission-denied", "We can't accept this booking. Please call the shop."); }
  const catalog = await laundryCatalog(storeId);
  const lines = (Array.isArray(d.items) ? d.items : []).map((l) => { const it = catalog.get(String(l.itemId || "")); if (!it) throw new HttpsError("not-found", "A service is no longer on the list."); const unit = it.unit || "piece"; const q = Math.max(0, Number(l.qty) || 0); return { itemId: it.id, name: it.name, unit, qty: q, unitPrice: Number(it.price) || 0, subtotal: 0, label: unit === "kg" ? (q ? `~${q} kg` : "to weigh") : unit === "estimate" ? "to quote" : q ? `${q} ${unit}` : "", choices: [], station: "counter" }; });
  if (!lines.length) throw new HttpsError("invalid-argument", "Pick at least one service.");
  let pickupAt = null;
  if (mode !== "dropoff_delivery") { const when = new Date(String(d.pickupAt || "")); if (isNaN(when.getTime())) throw new HttpsError("invalid-argument", "Choose a pickup time."); if (when.getTime() < Date.now() - 600000) throw new HttpsError("invalid-argument", "Pickup time must be in the future."); pickupAt = Timestamp.fromDate(when); }
  const rush = !!d.rush;
  const busyExtra = cfg.busy?.active && !rush ? Number(cfg.busy.extraHours) || 0 : 0;
  if (cfg.busy?.active && !rush && !d.waitOk) throw new HttpsError("failed-precondition", "We're busy right now — please choose 'willing to wait' or add Rush.");
  const etaH = (rush ? cfg.rushEtaHours || 6 : cfg.etaHours || 24) + busyExtra;
  const needsConfirmL = !!(pub.confirm?.mode && pub.confirm.mode !== "off");
  const { orderId } = await commitOrder(storeId, {
    type: "laundry", serviceType: "delivery", status: needsConfirmL ? "unconfirmed" : "booked", needsConfirm: needsConfirmL, confirmDeadline: needsConfirmL ? Timestamp.fromMillis(Math.min(Date.now() + (Number(pub.confirm.minutes) || 60) * 60000, pickupAt ? pickupAt.toMillis() : Infinity)) : null, tableId: null, tableLabel: null,
    items: lines, stations: {}, subtotal: 0, deliveryFee: 0, deliveryFeePending: true, total: 0, note: String(d.note || "").slice(0, 300), customer,
    discounts: { promo: 0, voucher: 0 }, customerUid: uid, customerKey: phoneKey.length >= 7 ? phoneKey : null, source: "customer", scheduledAt: pickupAt, isScheduled: !!pickupAt,
    paid: false, paymentMethod: null, etaMinutes: null, riderId: null, riderName: null,
    laundry: { mode, ticketNo: "", claimCode: claimCode(), container: "none", kg: 0, loads: 0, pcs: null, rush, rushFee: 0, fold: d.fold !== false, separateWhites: d.separateWhites !== false, handWash: String(d.handWash || "").slice(0, 200), estimateOnly: true, weighedAt: null, readyBy: null, etaHours: etaH, waitOk: !!d.waitOk, busyExtraHours: busyExtra, pickupAt, claimedAt: null, claimedBy: null, boundUid: uid },
  });
  if (phoneKey.length >= 7) await db.doc(`stores/${storeId}/customers/${phoneKey}`).set({ phone: customer.phone, name: customer.name, address: customer.address, orders: FieldValue.increment(1), lastOrderAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  notifyTelegram(storeId, "newOrder", `🧺 New laundry booking · ${mode.replace("_", " → ")} · ${customer.name} ${customer.phone}\n${customer.address}${pickupAt ? "\nPickup: " + pickupAt.toDate().toLocaleString("en-PH", { timeZone: "Asia/Manila" }) : ""}`);
  const snap = await db.doc(`stores/${storeId}/orders/${orderId}`).get();
  return { orderId, storeId, orderNo: snap.data().orderNo, claimCode: snap.data().laundry.claimCode };
}));
exports.laundryLoyalty = onCall(async (req) => {
  const { token } = requireAuth(req);
  if (!token.storeId) throw new HttpsError("permission-denied", "No store.");
  const cfg = (await db.doc(`stores/${token.storeId}`).get()).data()?.settings?.laundry || {};
  return (await loyaltyFor(token.storeId, String(req.data?.phone || "").replace(/\D/g, ""), cfg)) || { disabled: true };
});
// counter: re-weigh / re-price an existing job (also used for dry-clean quotes)
exports.repriceLaundryJob = onCall(async (req) => {
  const { token } = requireAuth(req);
  const storeId = token.storeId; if (!storeId) throw new HttpsError("permission-denied", "No store.");
  const d = req.data || {};
  const ref = db.doc(`stores/${storeId}/orders/${String(d.orderId || "")}`);
  const snap = await ref.get(); if (!snap.exists || snap.data().type !== "laundry") throw new HttpsError("not-found", "Job not found.");
  const o = snap.data();
  if (["claimed", "cancelled"].includes(o.status)) throw new HttpsError("failed-precondition", "Job is already closed.");
  const cfg = (await db.doc(`stores/${storeId}`).get()).data().settings?.laundry || {};
  const { lines, subtotal, kg, loads, estimateOnly, rushFee } = laundryPrice(Array.isArray(d.items) ? d.items : [], await laundryCatalog(storeId), cfg, { ...o.laundry, ...d });
  const deliveryFee = d.deliveryFee != null ? Math.max(0, Number(d.deliveryFee) || 0) : o.deliveryFee || 0;
  const total = round2(subtotal + deliveryFee);
  const prevTotal = o.total;
  const patch = { items: lines, subtotal, deliveryFee, total, "laundry.kg": kg, "laundry.loads": loads, "laundry.rush": !!d.rush, "laundry.rushFee": rushFee, "laundry.estimateOnly": estimateOnly, "laundry.weighedAt": FieldValue.serverTimestamp(), "laundry.priceHistory": FieldValue.arrayUnion({ at: Date.now(), from: prevTotal, to: total, by: String(d.staffName || "").slice(0, 40) }), updatedAt: FieldValue.serverTimestamp() };
  if (d.pcs != null) patch["laundry.pcs"] = Math.max(0, parseInt(d.pcs, 10) || 0);
  if (d.ticketNo != null) patch["laundry.ticketNo"] = String(d.ticketNo).trim().slice(0, 12);
  if (d.container) patch["laundry.container"] = String(d.container).slice(0, 20);
  if (!o.laundry?.readyBy) patch["laundry.readyBy"] = Timestamp.fromMillis(Date.now() + ((d.rush ? cfg.rushEtaHours || 6 : cfg.etaHours || 24) * 3600000));
  if (["received", "booked", "picking_up", "weighed"].includes(o.status)) patch.status = cfg.paymentFirst && !o.paid ? "waiting_payment" : "weighed";
  await ref.update(patch);
  return { total, kg, loads };
});
// customer: bind the claim stub (QR / code) to this phone so the status page can follow the job
exports.bindLaundryJob = onCall(async (req) => {
  const { uid } = requireAuth(req);
  const d = req.data || {};
  const storeId = String(d.storeId || ""), orderId = String(d.orderId || ""), code = String(d.code || "").trim().toUpperCase();
  const ref = db.doc(`stores/${storeId}/orders/${orderId}`);
  const snap = await ref.get();
  if (!snap.exists || snap.data().laundry?.claimCode !== code) throw new HttpsError("not-found", "Job not found. Check the claim code.");
  if (!snap.data().customerUid) await ref.update({ customerUid: uid, "laundry.boundUid": uid, updatedAt: FieldValue.serverTimestamp() });
  else if (snap.data().customerUid !== uid) await ref.update({ "laundry.extraUids": FieldValue.arrayUnion(uid), updatedAt: FieldValue.serverTimestamp() });
  return { ok: true, orderNo: snap.data().orderNo };
});
// staff: pause notice (water interruption, maintenance) — shown on the customer status page
exports.setPause = onCall(async (req) => {
  const { token } = requireAuth(req);
  if (!token.storeId) throw new HttpsError("permission-denied", "No store.");
  const d = req.data || {};
  const pause = d.active ? { active: true, reason: String(d.reason || "Temporarily paused").slice(0, 120), until: String(d.until || "").slice(0, 40), since: Date.now(), by: String(d.staffName || "").slice(0, 40) } : null;
  await db.doc(`stores/${token.storeId}`).update({ "settings.pause": pause, updatedAt: FieldValue.serverTimestamp() });
  return { ok: true };
});
// staff: busy mode (long queue) — customers are told jobs take longer and can choose to wait or add rush
exports.setBusy = onCall(async (req) => {
  const { token } = requireAuth(req);
  if (!token.storeId) throw new HttpsError("permission-denied", "No store.");
  const d = req.data || {};
  const busy = d.active ? { active: true, extraDays: Math.max(0, Number(d.extraDays) || 0), extraHours: Math.max(0, Number(d.extraDays) || 0) * 24, note: String(d.note || "").slice(0, 120), since: Date.now(), by: String(d.staffName || "").slice(0, 40) } : null;
  await db.doc(`stores/${token.storeId}`).update({ "settings.busy": busy, updatedAt: FieldValue.serverTimestamp() });
  return { ok: true };
});
// counter: release the job — claim code must match (no stub, no claim)
exports.claimLaundryJob = onCall(async (req) => {
  const { token } = requireAuth(req);
  const storeId = token.storeId; if (!storeId) throw new HttpsError("permission-denied", "No store.");
  const d = req.data || {};
  const code = String(d.code || "").trim().toUpperCase();
  const q = await db.collection(`stores/${storeId}/orders`).where("laundry.claimCode", "==", code).limit(1).get();
  if (q.empty) throw new HttpsError("not-found", "No job matches that claim code.");
  const ref = q.docs[0].ref, o = q.docs[0].data();
  if (o.status === "claimed") throw new HttpsError("failed-precondition", `Ticket #${o.laundry?.ticketNo || o.orderNo} was already claimed.`);
  const cfgL = (await db.doc(`stores/${storeId}`).get()).data()?.settings?.laundry || {};
  const st = o.laundry?.storageFee ? { days: o.laundry.storageDays || 0, fee: 0 } : storageFeeFor(o, cfgL);
  if (st.fee > 0) {
    // add the storage fee line once; unpaid → customer pays the new total
    const items = [...(o.items || []), { itemId: null, name: `Storage fee · ${st.days} day${st.days > 1 ? "s" : ""}`, unit: "piece", qty: st.days, unitPrice: cfgL.storageFeePerDay, subtotal: st.fee, label: `${st.days} d`, choices: [], station: "counter" }];
    const subtotal = round2((o.subtotal || 0) + st.fee), total = round2(subtotal + (o.deliveryFee || 0));
    await ref.update({ items, subtotal, total, "laundry.storageFee": st.fee, "laundry.storageDays": st.days, ...(o.paid ? { paid: false, storagePending: true } : {}), updatedAt: FieldValue.serverTimestamp() });
    o.items = items; o.subtotal = subtotal; o.total = total; if (o.paid) { o.paid = false; o.storagePending = true; }
  }
  if (!d.confirm) return { preview: true, orderId: ref.id, orderNo: o.orderNo, ticketNo: o.laundry?.ticketNo, customer: o.customer?.name, total: o.total, paid: !!o.paid, status: o.status, storageFee: o.laundry?.storageFee || st.fee || 0, storageDays: o.laundry?.storageDays || st.days || 0, storagePending: !!o.storagePending, pcs: o.laundry?.pcs ?? null, kg: o.laundry?.kg || null, proof: (o.laundry?.proof?.photos || []).map((x) => ({ kind: x.kind, note: x.note || "" })) };
  if (!o.paid && !d.paid) throw new HttpsError("failed-precondition", "Job is unpaid. Take payment first.");
  if (!["ready", "out_for_delivery", "folding"].includes(o.status) && !d.force) throw new HttpsError("failed-precondition", `Job is still "${o.status}". Mark it ready first or force the claim.`);
  await ref.update({ status: "claimed", completedAt: FieldValue.serverTimestamp(), "laundry.claimedAt": FieldValue.serverTimestamp(), "laundry.claimedBy": String(d.staffName || "").slice(0, 40), ...(d.paid && !o.paid ? { paid: true, paymentMethod: String(d.paymentMethod || "cash").slice(0, 20), paidAt: FieldValue.serverTimestamp() } : {}), updatedAt: FieldValue.serverTimestamp() });
  return { ok: true, orderNo: o.orderNo };
});

/** Laundry intake proof: weight photo + stain/damage photos taken at drop-off (anti-bintang). Customer sees them on the tracker. */
exports.laundryProof = onCall(async (req) => {
  const { token } = requireAuth(req);
  const storeId = token.storeId; if (!storeId) throw new HttpsError("permission-denied", "No store.");
  if (token.role === "viewer") throw new HttpsError("permission-denied", "Demo view only.");
  const d = req.data || {};
  const ref = db.doc(`stores/${storeId}/orders/${String(d.orderId || "")}`);
  const snap = await ref.get(); if (!snap.exists) throw new HttpsError("not-found", "Job not found.");
  const o = snap.data();
  let photos = [...(o.laundry?.proof?.photos || [])];
  const rm = new Set((d.remove || []).map(String));
  photos = photos.filter((x) => !rm.has(x.url));
  const pre = `priv:stores/${storeId}/private/`;
  for (const a of (d.add || []).slice(0, 8)) {
    const url = String(a?.url || "");
    if (!url.startsWith(pre) || url.includes("..")) throw new HttpsError("invalid-argument", "Bad photo.");
    const kind = ["scale", "stain", "damage", "bag"].includes(a.kind) ? a.kind : "stain";
    if (kind === "scale") photos = photos.filter((x) => x.kind !== "scale");
    photos.push({ url, kind, note: String(a.note || "").slice(0, 80), at: Date.now() });
  }
  if (photos.length > 8) throw new HttpsError("failed-precondition", "Up to 8 proof photos per job.");
  const up = { "laundry.proof": { photos, at: Date.now(), by: String(d.staffName || "").slice(0, 40) }, updatedAt: FieldValue.serverTimestamp() };
  if (d.pcs !== undefined && d.pcs !== null && d.pcs !== "") { const n = Math.round(Number(d.pcs)); if (n >= 0 && n <= 999) up["laundry.pcs"] = n; }
  await ref.update(up);
  return { ok: true, photos };
});

// ===========================================================================
// SALON — appointments, slots, rotation
// ===========================================================================
const APPT_ACTIVE = ["unconfirmed", "pending", "confirmed", "in_progress"];
const apptCode = () => "A-" + Array.from({ length: 4 }, () => CLAIM_ALPHABET[Math.floor(Math.random() * CLAIM_ALPHABET.length)]).join("");
function phMidnight(dateStr) { return new Date(`${dateStr}T00:00:00+08:00`); }
async function salonContext(storeId) {
  const [storeSnap, itemsSnap, staffSnap] = await Promise.all([db.doc(`stores/${storeId}`).get(), db.collection(`stores/${storeId}/items`).get(), db.collection(`stores/${storeId}/staff`).where("active", "==", true).get()]);
  const store = storeSnap.data();
  const cfg = store.settings?.salon || {};
  const blocks = (store.salonLive?.blocks || []).filter((b) => /^\d{4}-\d{2}-\d{2}$/.test(b.date));
  const stylists = staffSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((x) => (x.roles || []).includes("stylist")).map((x) => ({ ...x, _blocks: blocks.filter((b) => !b.staffId || b.staffId === x.id) }));
  return { store, cfg, items: new Map(itemsSnap.docs.map((d) => [d.id, { id: d.id, ...d.data() }])), stylists, blocks };
}
// ---- home service lanes: where the salon works (shop / home / both), home hours, travel time, areas ----
const salonPlace = (store) => store.settings?.setup?.place || (store.settings?.salon?.homeService?.enabled ? "both" : "shop");
const travelOf = (cfg) => Math.max(0, Math.min(180, Number(cfg.homeService?.travelMin ?? 30) || 0));
const hasHomeDays = (cfg) => !!(cfg.homeService?.days && Object.values(cfg.homeService.days).some((d) => d && d.on));
/** stylists who go on home service: ticked ones → else the owner → else everyone */
function homePool(ctx) {
  const t = ctx.stylists.filter((x) => x.homeService === true); if (t.length) return t;
  const o = ctx.stylists.filter((x) => x.isOwner); return o.length ? o : ctx.stylists;
}
/** opening spans (minutes from PH midnight) for a lane on a date */
function laneSpans(ctx, dateStr, lane) {
  const { store, cfg } = ctx; const hours = store.hours || {};
  const di = new Date(phMidnight(dateStr).getTime() + 8 * 3600000).getUTCDay();
  if (lane === "shop" && salonPlace(store) === "home") return [];
  if (lane === "home" && hasHomeDays(cfg)) { const d = cfg.homeService.days[WEEK[di]]; const a = hmMin(d?.from), b = hmMin(d?.to); return d?.on ? [[a ?? 540, b != null && b > (a ?? 540) ? b : 1140]] : []; }
  return Object.keys(hours).length ? [...spansFor(hours, WEEK[di]).map(([a, b]) => [a, Math.min(b, 1440)]), ...spansFor(hours, WEEK[(di + 6) % 7]).filter(([, b]) => b > 1440).map(([a, b]) => [Math.max(0, a - 1440), b - 1440])] : [[540, 1140]];
}
/** home hours are reserved for home service (owner/home staff can't take shop clients then) */
function inHomeWindow(ctx, st, s, e) {
  const { cfg, store } = ctx;
  if (salonPlace(store) !== "both" || cfg.homeService?.exclusive === false || !hasHomeDays(cfg) || !homePool(ctx).some((x) => x.id === st.id)) return false;
  const ph = new Date(s + 8 * 3600e3); const d = cfg.homeService.days[WEEK[ph.getUTCDay()]]; if (!d?.on) return false;
  const sm = ph.getUTCHours() * 60 + ph.getUTCMinutes(), em = sm + (e - s) / 60000, a = hmMin(d.from) ?? 540, b = hmMin(d.to) ?? 1140;
  return sm < b && em > a;
}
/** blocked time (calendar "block time" / sick day for everyone) */
function blockHit(blocks, s, e) {
  const ph = new Date(s + 8 * 3600e3); const ymd = ph.toISOString().slice(0, 10); const sm = ph.getUTCHours() * 60 + ph.getUTCMinutes(), em = sm + (e - s) / 60000;
  return (blocks || []).find((b) => b.date === ymd && sm < (hmMin(b.to) ?? 1440) && em > (hmMin(b.from) ?? 0)) || null;
}
/** owner switched to "on home service / break / closed" → not free for walk-ins right now */
const awayNow = (ctx, st) => { const p = ctx.store.salonLive?.presence; return !!(p && p.state && p.state !== "in" && st.isOwner && (!p.until || p.until > Date.now())); };
function apptLines(itemIds, items) {
  const lines = []; let total = 0, minutes = 0; const cats = new Set();
  for (const key of itemIds) {
    // "itemId~2" = variant #2 (e.g. Long hair) of a service
    const [id, vi] = String(key).split("~"); const it = items.get(id);
    if (!it) throw new HttpsError("not-found", "A service is no longer available."); if (it.available === false) throw new HttpsError("failed-precondition", `${it.name} is currently unavailable.`);
    const vars = Array.isArray(it.variants) ? it.variants : [];
    if (vars.length && vi === undefined) throw new HttpsError("invalid-argument", `Choose a size / length for ${it.name}.`);
    const v = vi !== undefined ? vars[Number(vi)] : null; if (vi !== undefined && !v) throw new HttpsError("not-found", `That option for ${it.name} is no longer available.`);
    const price = Number(v ? v.price : it.price) || 0, dur = Number(v?.duration) || Number(it.durationMinutes) || 30;
    lines.push({ itemId: it.id, name: v ? `${it.name} (${v.label})` : it.name, ...(v ? { variant: String(v.label), variantIdx: Number(vi) } : {}), price, duration: dur, categoryId: it.categoryId, staffPay: it.staffPay || null, ...(it.wholeDay ? { wholeDay: true } : {}) }); total += price; minutes += dur; cats.add(it.categoryId);
  }
  if (!lines.length) throw new HttpsError("invalid-argument", "Pick at least one service.");
  return { lines, total: round2(total), minutes, cats: [...cats] };
}
// a stylist with no skills ticked can do every service
const canDo = (st, cats) => !(st.skills || []).length || cats.every((c) => st.skills.includes(c));
// stylist schedule: weekly days (on/from/to), daily break, leave dates (PH time). No schedule = works all open hours.
const WEEK = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const hmMin = (v) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || "")); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
function offReason(st, s, e) {
  if (st.wentHome?.at && s >= st.wentHome.at && new Date(s + 8 * 3600e3).toISOString().slice(0, 10) === st.wentHome.date) return "gone home for the day";
  const sc = st.schedule || {}; if (!st.schedule && !(st._blocks || []).length) return null;
  const ph = new Date(s + 8 * 3600e3); const ymd = ph.toISOString().slice(0, 10);
  if ((sc.leaves || []).includes(ymd)) return "on leave";
  if (blockHit(st._blocks, s, e)) return "blocked off";
  const sm = ph.getUTCHours() * 60 + ph.getUTCMinutes(), em = sm + (e - s) / 60000;
  if (sc.days && Object.keys(sc.days).length) {
    const day = sc.days[WEEK[ph.getUTCDay()]];
    if (!day?.on) return "on a day off";
    const a = hmMin(day.from), b = hmMin(day.to);
    if ((a != null && sm < a) || (b != null && b > (a || 0) && em > b)) return "off duty at that time";
  }
  const bf = hmMin(sc.breakFrom), bt = hmMin(sc.breakTo);
  if (bf != null && bt != null && bt > bf && sm < bt && em > bf) return "on break";
  return null;
}
const stylistFree = (st, s, e) => !offReason(st, s, e);
// public view of a stylist's schedule (customer "Our team" tab): working days + hours, break, leaves in the next 45 days
function pubSchedule(sc) {
  if (!sc) return null;
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10), until = new Date(Date.now() + 8 * 3600e3 + 45 * 86400e3).toISOString().slice(0, 10);
  const days = {}; for (const k of WEEK) { const d = sc.days?.[k]; if (d) days[k] = d.on ? { on: true, from: d.from || null, to: d.to || null } : { on: false }; }
  return { days: Object.keys(days).length ? days : null, breakFrom: sc.breakFrom || null, breakTo: sc.breakTo || null, leaves: (sc.leaves || []).filter((x) => x >= today && x <= until).sort().slice(0, 20) };
}
async function dayAppointments(storeId, dateStr) {
  const start = phMidnight(dateStr), end = new Date(start.getTime() + 86400000);
  const snap = await db.collection(`stores/${storeId}/appointments`).where("startAt", ">=", Timestamp.fromDate(start)).where("startAt", "<", Timestamp.fromDate(end)).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((a) => APPT_ACTIVE.includes(a.status));
}
const overlaps = (a, s, e) => { const st0 = a.startAt.toMillis(), as = st0 - (a.travelBefore || 0) * 60000, ae = st0 + ((a.durationConfirmed || a.durationEst || 30) + (a.buffer || 0)) * 60000; return as < e && ae > s; };
// ---- treatment rooms (massage & spa, optional for salons): the system picks a free room; the customer never chooses ----
const spaRooms = (ctx) => (ctx.cfg.rooms || []).filter((r) => r && r.id && r.active !== false && Number(r.beds) > 0);
const roomBuf = (ctx) => Math.max(0, Math.min(60, Number(ctx.cfg.roomBufferMin ?? 10) || 0));
/** a room with `pax` free beds for [t, t+minutes+cleaning] → room; no rooms set up → undefined; all full → null */
function pickRoom(ctx, appts, t, minutes, pax = 1, excludeIds = []) {
  const rooms = spaRooms(ctx); if (!rooms.length) return undefined;
  const s = t, e = t + (minutes + roomBuf(ctx)) * 60000;
  const used = (r) => appts.filter((a) => a.roomId === r.id && !a.homeService && !excludeIds.includes(a.id)).filter((a) => { const as = a.startAt.toMillis(), ae = as + ((a.durationConfirmed || a.durationEst || 30) + roomBuf(ctx)) * 60000; return as < e && ae > s; }).reduce((x, a) => x + (Number(a.beds) || 1), 0);
  const ok = rooms.filter((r) => Number(r.beds) - used(r) >= pax).sort((a, b) => Number(a.beds) - Number(b.beds));
  return ok[0] || null;
}
/** therapists / stylists free at t (same rules as computeSlots), least-recently assigned first */
function freeProviders(ctx, appts, t, minutes, cats, { home = false, gender = null, exclude = [] } = {}) {
  const travel = home ? travelOf(ctx.cfg) : 0, buffer = Number(ctx.cfg.bufferMin) || 0;
  const s0 = t - travel * 60000, e = t + (minutes + (home ? travel : buffer)) * 60000;
  const base = home ? homePool(ctx) : ctx.stylists;
  return base.filter((st) => !exclude.includes(st.id) && canDo(st, cats) && (!gender || st.gender === gender) && stylistFree(st, t, t + minutes * 60000) && !(!home && inHomeWindow(ctx, st, t, t + minutes * 60000)) && !appts.some((a) => a.providerId === st.id && overlaps(a, s0, e)))
    .sort((a, b) => (a.lastAssignedAt?.toMillis?.() || 0) - (b.lastAssignedAt?.toMillis?.() || 0));
}
/** available start times (ms) for a date */
async function computeSlots(storeId, ctx, dateStr, lines, cats, minutes, providerId, opts = {}) {
  const { store, cfg } = ctx;
  const home = !!opts.home;
  const spans = laneSpans(ctx, dateStr, home ? "home" : "shop");
  if (!spans.length) return [];
  // whole-day service (events, weddings): the booking covers the whole working day → one slot at opening
  if ((lines || []).some((l) => l.wholeDay)) { const [sm, em] = spans[0]; minutes = Math.max(60, em - sm); opts = { ...opts, wholeDay: true }; }
  // no stylists set up yet → the salon works as one chair
  const noStaff = !ctx.stylists.length && !providerId;
  const base0 = noStaff ? [{ id: "__chair", _blocks: ctx.blocks || [] }] : (home ? homePool(ctx) : ctx.stylists);
  const pax = Math.max(1, Math.min(2, Number(opts.pax) || 1));
  const pool = noStaff ? base0 : base0.filter((x) => (!providerId || x.id === providerId) && canDo(x, cats) && (!opts.gender || x.gender === opts.gender));
  if (pool.length < (providerId ? 1 : pax)) return [];
  const appts = (await dayAppointments(storeId, dateStr)).filter((a) => a.id !== opts.excludeId);
  const step = (Number(cfg.slotMinutes) || 30) * 60000, buffer = Number(cfg.bufferMin) || 0, travel = home ? travelOf(cfg) : 0;
  const lead = Date.now() + (testOn(store.settings) ? 0 : (Number(cfg.leadTimeHours) || 0) * 3600000);
  const out = [];
  for (const [sm, em] of spans) {
    const base = phMidnight(dateStr).getTime();
    const open = base + sm * 60000, close = base + em * 60000;
    for (let t = open; t + minutes * 60000 <= close; t += step) {
      if (t < lead) continue;
      const s0 = t - travel * 60000, e = t + (minutes + (home ? travel : buffer)) * 60000;
      const free = noStaff ? (appts.some((a) => overlaps(a, s0, e)) || blockHit(ctx.blocks, t, t + minutes * 60000) ? [] : pool) : pool.filter((st) => stylistFree(st, t, t + minutes * 60000) && !(!home && inHomeWindow(ctx, st, t, t + minutes * 60000)) && !appts.some((a) => a.providerId === st.id && overlaps(a, s0, e)));
      // "anyone": unassigned holds also consume capacity
      const unassigned = providerId || noStaff ? 0 : appts.filter((a) => !a.providerId && overlaps(a, s0, e)).length;
      if (free.length - unassigned >= (providerId ? 1 : pax) && (home || pickRoom(ctx, appts, t, minutes, pax) !== null)) out.push(t);
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}
/** One booking, different stylists one after another (e.g. haircut with Mia, then nails with Liza). Returns [{ t, plan }] */
async function computeMultiSlots(storeId, ctx, dateStr, lines) {
  const { store, cfg } = ctx;
  const hours = store.hours || {};
  const di = new Date(phMidnight(dateStr).getTime() + 8 * 3600000).getUTCDay();
  const spans = Object.keys(hours).length ? [...spansFor(hours, WEEK[di]).map(([a, b]) => [a, Math.min(b, 1440)]), ...spansFor(hours, WEEK[(di + 6) % 7]).filter(([, b]) => b > 1440).map(([a, b]) => [Math.max(0, a - 1440), b - 1440])] : [[540, 1140]];
  const appts = await dayAppointments(storeId, dateStr);
  const step = (Number(cfg.slotMinutes) || 30) * 60000, buffer = Number(cfg.bufferMin) || 0;
  const lead = Date.now() + (testOn(store.settings) ? 0 : (Number(cfg.leadTimeHours) || 0) * 3600000);
  const total = lines.reduce((x, l) => x + l.duration, 0);
  const byRotation = [...ctx.stylists].sort((a, b) => (a.lastAssignedAt?.toMillis?.() || 0) - (b.lastAssignedAt?.toMillis?.() || 0));
  const out = [];
  for (const [sm, em] of spans) {
    const base = phMidnight(dateStr).getTime(), close = base + em * 60000;
    for (let t = base + sm * 60000; t + total * 60000 <= close; t += step) {
      if (t < lead) continue;
      let cur = t; const plan = []; let okAll = true;
      for (const l of lines) {
        const e = cur + l.duration * 60000;
        const fits = (st) => canDo(st, [l.categoryId]) && stylistFree(st, cur, e) && !appts.some((a) => a.providerId === st.id && overlaps(a, cur, e + buffer * 60000));
        const prev = plan[plan.length - 1];
        const st = (prev && fits(ctx.stylists.find((x) => x.id === prev.providerId)) ? ctx.stylists.find((x) => x.id === prev.providerId) : null) || byRotation.find(fits);
        if (!st) { okAll = false; break; }
        if (prev && prev.providerId === st.id) { prev.lines.push(l); prev.minutes += l.duration; } else plan.push({ providerId: st.id, providerName: st.name, start: cur, lines: [l], minutes: l.duration });
        cur = e;
      }
      if (okAll && plan.length) out.push({ t, plan });
    }
  }
  return out;
}
const needsMulti = (ctx, cats, providerId, home) => !home && !providerId && ctx.stylists.length > 0 && cats.length > 1 && !ctx.stylists.some((x) => canDo(x, cats));
exports.getSlots = onCall(HOT, async (req) => {
  requireAuth(req);
  const d = req.data || {};
  const pub = (await db.doc(`publicStores/${String(d.slug || "")}`).get()).data(); if (!pub) throw new HttpsError("not-found", "Store not found.");
  const ctx = await salonContext(pub.storeId);
  const { lines, cats, minutes } = apptLines(Array.isArray(d.itemIds) ? d.itemIds : [], ctx.items);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d.date || ""))) throw new HttpsError("invalid-argument", "Invalid date.");
  if (d.pax !== 2 && needsMulti(ctx, cats, d.providerId, !!d.homeService)) {
    const m = await computeMultiSlots(pub.storeId, ctx, d.date, lines);
    return { slots: m.map((x) => x.t), minutes, multi: true, plans: Object.fromEntries(m.map((x) => [x.t, x.plan.map((p) => `${p.providerName.split(" ")[0]}: ${p.lines.map((l) => l.name).join(", ")}`).join(" → ")])) };
  }
  { const { lim } = await storeLimits(pub.storeId, "salon"); if (lim.bookingsPerDay < UNLIMITED && !testOn(ctx.store.settings) && (await dayAppointments(pub.storeId, d.date)).length >= lim.bookingsPerDay) return { slots: [], minutes, full: true }; }
  if (ctx.store.businessType === "freelance") { const why = await sideJobBlock(pub.storeId, ctx.store, d.date); if (why) return { slots: [], minutes, full: true, why }; }
  const home = !!d.homeService || salonPlace(ctx.store) === "home";
  const pax = d.pax === 2 && ctx.cfg.allowPax2 !== false ? 2 : 1;
  const gender = ["female", "male"].includes(d.gender) ? d.gender : null;
  const slots = await computeSlots(pub.storeId, ctx, d.date, lines, cats, minutes, pax === 2 ? null : d.providerId ? String(d.providerId) : null, { home, pax, gender });
  return { slots, minutes, home, pax };
});
async function nextWaitNo(storeId, dk) {
  const ref = db.doc(`stores/${storeId}/meta/waitlist`);
  return db.runTransaction(async (tx) => { const c = await tx.get(ref); const cur = c.exists && c.data().dayKey === dk ? c.data().seq : 0; const seq = cur + 1; tx.set(ref, { dayKey: dk, seq }, { merge: true }); return seq; });
}
async function writeAppointment(storeId, ctx, { lines, total, minutes, cats }, { customer, uid, providerId, startAt, notes, source, status, staffName, homeService, birthday, referral, extra }) {
  const cfg = ctx.cfg;
  const ref = db.collection(`stores/${storeId}/appointments`).doc();
  const phoneKey = String(customer.phone || "").replace(/\D/g, "");
  // owner-only salon: every booking goes to the owner (the only stylist)
  if (!providerId && ctx.store.settings?.setup?.kind === "solo" && ctx.stylists.length === 1) providerId = ctx.stylists[0].id;
  if (!providerId && homeService && ctx.stylists.length) { const hp = homePool(ctx); if (hp.length === 1) providerId = hp[0].id; }
  const provider = providerId ? ctx.stylists.find((x) => x.id === providerId) : null;
  const confirmMins = Number(cfg.confirmMinutes) || 60;
  const deadline = status === "unconfirmed" ? Math.min(startAt.getTime(), Date.now() + confirmMins * 60000) : null;
  const test = testOn(ctx.store.settings);
  await ref.set({
    ...(test ? { test: true } : {}), ...(ctx.store?.contact?.messenger ? { shopMessenger: ctx.store.contact.messenger } : {}),
    code: test ? "T-" + apptCode().slice(2) : apptCode(), status, customer, customerUid: uid || null, customerKey: phoneKey.length >= 7 ? phoneKey : null,
    items: lines, total, durationEst: minutes, durationConfirmed: null, buffer: homeService ? travelOf(cfg) : Number(cfg.bufferMin) || 0, travelBefore: homeService ? travelOf(cfg) : 0, categories: cats,
    providerId: provider?.id || null, providerName: provider?.name || null, requestedProviderId: providerId || null,
    startAt: Timestamp.fromDate(startAt), dayKey: dayKey(startAt, ctx.store.settings?.businessDayCutoff), notes: String(notes || "").slice(0, 300), homeService: homeService || null,
    ...(referral ? { referral } : {}),
    source, createdBy: staffName || null, confirmDeadline: deadline ? Timestamp.fromMillis(deadline) : null,
    homeFee: homeService ? Number(homeService.fee) || 0 : 0,
    paid: false, paymentMethod: null, tip: 0, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    ...(extra || {}),
  });
  if (phoneKey.length >= 7 && !test) {
    const cRef = db.doc(`stores/${storeId}/customers/${phoneKey}`);
    const nd = (await cRef.get()).data()?.nextDue;
    const booked = nd && ["due", "snoozed"].includes(nd.status) ? { "nextDue.status": "booked", "nextDue.bookedApptId": ref.id, "nextDue.bookedAt": Date.now(), ...(nd.smsAt || nd.contactedAt ? { rebookReturnCount: FieldValue.increment(1) } : {}) } : {};
    const bd = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(String(birthday || "")) ? String(birthday) : null;
    const addr = homeService && customer.address ? { address: customer.address, landmark: customer.landmark || "", mapUrl: customer.mapUrl || "", area: homeService.area || "" } : null;
    await cRef.set({ ...(addr ? { home: addr } : {}), phone: customer.phone, name: customer.name, orders: FieldValue.increment(1), lastOrderAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), ...(bd ? { birthday: bd, birthMonth: Number(bd.slice(0, 2)) } : {}) }, { merge: true });
    if (Object.keys(booked).length) await cRef.update(booked);
  }
  return ref;
}
/** validate + price a home-service request (area fee, minimum spend, address) */
function homeServiceFor(ctx, d, customer, total) {
  const hs = ctx.cfg.homeService || {}; const place = salonPlace(ctx.store);
  const want = !!d.homeService || place === "home";
  if (!want) return null;
  if (!(hs.enabled || place !== "shop")) throw new HttpsError("failed-precondition", "Home service is not available.");
  if (customer.address.length < 5 && !d.staff) throw new HttpsError("invalid-argument", "Enter the address for home service.");
  if (!d.staff && Number(hs.minSpend) > 0 && total < Number(hs.minSpend)) throw new HttpsError("failed-precondition", `Home service needs a minimum of ₱${Number(hs.minSpend)} in services.`);
  const areas = (hs.areas || []).filter((a) => a && a.name);
  const areaName = String((typeof d.homeService === "object" && d.homeService?.area) || d.area || "").trim();
  let area = null;
  if (areas.length) { area = areas.find((a) => a.name.toLowerCase() === areaName.toLowerCase()); if (!area && !d.staff) throw new HttpsError("invalid-argument", "Choose your area for home service."); }
  if (!d.staff) radiusGuard(hs, customer.mapUrl);
  return { address: customer.address, landmark: customer.landmark || "", mapUrl: customer.mapUrl || "", area: area?.name || areaName || "", fee: area ? Number(area.fee) || 0 : Number(hs.fee) || 0, feeConfirmed: !!area };
}
/** travel radius: base pin + km (Settings → Home service / On location). Pin comes from the customer's "📍 My location". */
const pinOf = (u) => { const m = /[?&]q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(String(u || "")) || /@(-?\d+\.\d+),(-?\d+\.\d+)/.exec(String(u || "")) || /^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/.exec(String(u || "").trim()); return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null; };
const kmBetween = (a, b) => { const R = 6371, dLa = (b.lat - a.lat) * Math.PI / 180, dLo = (b.lng - a.lng) * Math.PI / 180; const x = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
function radiusGuard(hs, mapUrl) {
  const base = hs?.base && Number.isFinite(Number(hs.base.lat)) ? { lat: Number(hs.base.lat), lng: Number(hs.base.lng) } : null; const r = Number(hs?.radiusKm) || 0;
  if (!base || !r) return null;
  const p = pinOf(mapUrl); if (!p) throw new HttpsError("invalid-argument", "Share your location (📍 My location) so we can check if we can reach you.");
  const km = Math.round(kmBetween(base, p) * 10) / 10;
  if (km > r) throw new HttpsError("failed-precondition", `Sorry — that's outside our area (${km} km away; we go up to ${r} km).`);
  return km;
}
/** a logged-in client (real account, not the anonymous browser login) gets every booking in "My bookings" across all TapTayo shops */
function realAccount(req) { const t = req.auth?.token || {}; return !!(req.auth?.uid && t.email && t.firebase?.sign_in_provider !== "anonymous"); }
function withIndex(kind, fn) { return async (req) => {
  const r = await fn(req);
  try {
    if (realAccount(req) && r?.id && !r.existing) {
      const sid = r.storeId || req.data?.storeId || (req.data?.slug ? (await db.doc(`publicStores/${String(req.data.slug)}`).get()).data()?.storeId : null);
      if (sid) { const st = (await db.doc(`stores/${sid}`).get()).data() || {}; await db.doc(`users/${req.auth.uid}/bookings/${kind}_${r.id}`).set({ kind, id: r.id, storeId: sid, slug: st.slug || "", storeName: st.name || "", businessType: st.businessType || "", logoUrl: st.logoUrl || null, code: r.code || null, at: Date.now() }); }
    }
  } catch (e) { console.warn("booking index", e.message); }
  return r;
}; }
const BOOK_COLL = { appt: "appointments", order: "orders", stay: "stays", resv: "reservations", inq: "inquiries" };
/** one account, several roles: client (book & hire), creator (freelancer page), business (shop) */
exports.accountSetup = onCall(async (req) => {
  if (!realAccount(req)) throw new HttpsError("unauthenticated", "Log in first.");
  const d = req.data || {}; const role = ["client", "creator", "business"].includes(d.role) ? d.role : "client";
  const prof = { name: String(d.name || req.auth.token.name || "").trim().slice(0, 60), phone: String(d.phone || "").trim().slice(0, 30), messenger: msgrOf(d.messenger), city: String(d.city || "").trim().slice(0, 40) };
  const ref = db.doc(`users/${req.auth.uid}`); const cur = (await ref.get()).data() || {};
  const profile = { ...(cur.profile || {}), ...Object.fromEntries(Object.entries(prof).filter(([, v]) => v)) };
  if (role === "creator" && d.adult !== true && !cur.adult) throw new HttpsError("invalid-argument", "Creators on TapTayo must be 18 or older.");
  await ref.set({ email: req.auth.token.email, accountRoles: FieldValue.arrayUnion(role), profile, ...(d.adult === true ? { adult: true, adultAt: Date.now() } : {}), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { ok: true };
});
exports.myAccount = onCall(async (req) => {
  if (!realAccount(req)) return { guest: true };
  const u = (await db.doc(`users/${req.auth.uid}`).get()).data() || {};
  const businesses = (u.businesses || []).map((b) => ({ storeId: b.storeId, name: b.name, businessType: b.businessType }));
  return { roles: [...new Set([...(u.accountRoles || []), ...(u.storeId ? [businesses.some((b) => b.businessType === "freelance") ? "creator" : "business"] : [])])], hasStore: !!u.storeId, businesses, profile: u.profile || {}, adult: !!u.adult, email: u.email || req.auth.token.email };
});
exports.myBookings = onCall(async (req) => {
  if (!realAccount(req)) throw new HttpsError("unauthenticated", "Log in to see your bookings.");
  const snap = await db.collection(`users/${req.auth.uid}/bookings`).orderBy("at", "desc").limit(40).get();
  const ms = (t) => (t?.toMillis ? t.toMillis() : typeof t === "number" ? t : null);
  return Promise.all(snap.docs.map(async (x) => { const b = x.data(); const doc = (await db.doc(`stores/${b.storeId}/${BOOK_COLL[b.kind] || "orders"}/${b.id}`).get()).data() || {};
    return { ...b, status: doc.status || "removed", code: b.code || doc.code || (doc.orderNo ? `#${doc.orderNo}` : ""), when: ms(doc.startAt) || ms(doc.checkIn) || ms(doc.scheduledAt) || (doc.date ? new Date(`${doc.date}T${doc.time || "12:00"}:00+08:00`).getTime() : null) || ms(doc.createdAt), total: doc.total ?? doc.quote?.total ?? null, title: (doc.items || []).map((l) => l.name).slice(0, 3).join(", ") || doc.roomName || doc.brief?.kind || doc.kind || "" }; }));
});
/** client: save my details once → every booking form is filled for me */
exports.saveProfile = onCall(async (req) => {
  if (!realAccount(req)) throw new HttpsError("unauthenticated", "Log in first.");
  const d = req.data || {}; const profile = { name: String(d.name || "").trim().slice(0, 60), phone: String(d.phone || "").trim().slice(0, 30), messenger: msgrOf(d.messenger), city: String(d.city || "").trim().slice(0, 40), address: String(d.address || "").trim().slice(0, 200) };
  await db.doc(`users/${req.auth.uid}`).set({ profile, email: req.auth.token.email, accountRoles: FieldValue.arrayUnion("client"), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { ok: true, profile };
});
/** client / freelancer Messenger: "m.me/name", "facebook.com/name", "messenger.com/t/name" or a bare username → https://m.me/name */
function msgrOf(v) {
  const t = String(v || "").trim(); if (!t) return "";
  const m = /(?:m\.me|messenger\.com\/t|facebook\.com|fb\.com)\/(?:profile\.php\?id=)?([A-Za-z0-9.]{3,80})/i.exec(t) || /^@?([A-Za-z0-9.]{3,50})$/.exec(t);
  return m && !/^(share|groups|pages|watch|login|people)$/i.test(m[1]) ? `https://m.me/${m[1]}` : "";
}
const custFrom = (c, def = "") => ({ messenger: msgrOf(c?.messenger), name: String(c?.name || def).trim().slice(0, 60), phone: String(c?.phone || "").trim().slice(0, 30), address: String(c?.address || "").trim().slice(0, 200), landmark: String(c?.landmark || "").trim().slice(0, 120), mapUrl: /^https:\/\/(www\.)?(google\.[a-z.]+\/maps|maps\.google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl\/maps|waze\.com)/.test(String(c?.mapUrl || "")) ? String(c.mapUrl).slice(0, 300) : "" });
exports.bookAppointment = onCall(HOT, withIndex("appt", async (req) => {
  await maintGuard(req);
  const { uid } = requireAuth(req);
  const d = req.data || {};
  const pub = (await db.doc(`publicStores/${String(d.slug || "")}`).get()).data(); if (!pub) throw new HttpsError("not-found", "Store not found.");
  if (pub.locked || pub.acceptOrders === false) throw new HttpsError("failed-precondition", "Not accepting bookings right now."); if (pub.comingSoon && !(pub.testMode && pub.testMode.until > Date.now())) throw new HttpsError("failed-precondition", "This shop is not open yet — coming soon!");
  const storeId = pub.storeId; const ctx = await salonContext(storeId);
  const customer = custFrom(d.customer);
  if (customer.name.length < 2 || !customer.phone) throw new HttpsError("invalid-argument", "Name and phone number are required.");
  const phoneKey = customer.phone.replace(/\D/g, "");
  let cRec = null;
  if (phoneKey.length >= 7) {
    const c = (await db.doc(`stores/${storeId}/customers/${phoneKey}`).get()).data(); cRec = c || null; if (c?.flagged) throw new HttpsError("permission-denied", "We can't accept this booking. Please call the salon.");
    const existing = await db.collection(`stores/${storeId}/appointments`).where("customerKey", "==", phoneKey).where("status", "in", APPT_ACTIVE).limit(1).get();
    if (!existing.empty && !testOn(ctx.store.settings)) throw new HttpsError("already-exists", "You already have an active booking. Cancel or finish it first.");
  }
  if (ctx.store.businessType === "freelance" && d.startAt) { const why = await sideJobBlock(storeId, ctx.store, phYmd(new Date(d.startAt).getTime())); if (why) throw new HttpsError("failed-precondition", why); }
  const priced = apptLines(Array.isArray(d.itemIds) ? d.itemIds : [], ctx.items);
  // products to buy with the booking (prints, frames, lashes, lenses…) — retail items, no extra time
  for (const x of (Array.isArray(d.products) ? d.products : []).slice(0, 20)) {
    const it = ctx.items.get(String(x.id || "")); const qty = Math.max(0, Math.min(50, parseInt(x.qty, 10) || 0));
    if (!it || !it.retail || !it.sellOnline || it.available === false || !qty) continue;
    const price = Number(it.price) || 0; priced.lines.push({ itemId: it.id, name: it.name, price, qty, duration: 0, retail: true, categoryId: it.categoryId || null, staffPay: null }); priced.total = round2(priced.total + price * qty);
  }
  let providerId = d.providerId ? String(d.providerId) : null;
  if (providerId && !ctx.stylists.some((x) => x.id === providerId && canDo(x, priced.cats))) throw new HttpsError("invalid-argument", "That staff member can't do all the selected services.");
  const homeService = homeServiceFor(ctx, d, customer, priced.total);
  if (homeService && d.walkIn) throw new HttpsError("invalid-argument", "Home service needs a booked time — please pick a date and time.");
  // home service safety: a map pin is required, and a valid ID on the first home booking (kept private, reused next time)
  if (homeService) {
    const hsCfg = ctx.cfg.homeService || {};
    if (hsCfg.requirePin !== false && !homeService.mapUrl) throw new HttpsError("invalid-argument", "Add your map pin (tap 📍 My location) so the stylist can find you.");
    const idUrl = null; // Home-service bookings no longer collect customer ID documents.
    const keepDays = Math.max(7, Number(ctx.store.settings?.privacy?.retentionDays || 90));
    const onFile = cRec?.homeIdUrl && (cRec.homeIdAt?.toMillis?.() || 0) > Date.now() - (keepDays - 1) * 864e5 ? cRec.homeIdUrl : null; // the file is deleted after the retention period
    // No valid-ID upload is required for home-service bookings.
    homeService.idUrl = null;
    // Do not save ID document references on customer records.
  }
  const pax = d.pax === 2 && ctx.cfg.allowPax2 !== false ? 2 : 1;
  const gender = ["female", "male"].includes(d.gender) ? d.gender : null;
  if (!providerId && pax === 1 && ctx.cfg.allowAnyone === false) throw new HttpsError("invalid-argument", "Please choose a staff member.");
  let startAt, waiting = false, multiPlan = null, room, pair = null;
  if (d.walkIn) {
    // walk-in from the QR: now if a skilled stylist is free, otherwise waitlisted (counter sets the estimated time)
    startAt = new Date(); const now = Date.now();
    const todayStr = new Date(now + 8 * 3600000).toISOString().slice(0, 10);
    const appts = await dayAppointments(storeId, todayStr);
    if (salonPlace(ctx.store) === "home") throw new HttpsError("failed-precondition", "This salon does home service only — please book a time.");
    const pres = ctx.store.salonLive?.presence;
    if (pres?.state && pres.state !== "in" && (!pres.until || pres.until > Date.now()) && ctx.cfg.walkInWhenAway === "off" && !ctx.stylists.some((x) => !x.isOwner)) throw new HttpsError("failed-precondition", "Walk-ins are paused right now — please book a time.");
    const pool = providerId ? ctx.stylists.filter((x) => x.id === providerId) : ctx.stylists.filter((x) => canDo(x, priced.cats));
    const freeNow = pool.filter((st) => !awayNow(ctx, st) && stylistFree(st, now, now + priced.minutes * 60000) && !appts.some((a) => a.providerId === st.id && overlaps(a, now, now + priced.minutes * 60000)));
    waiting = !freeNow.length || pax === 2; // 2 people → two tickets in the line, served together when two staff are free
    if (!waiting) { room = pickRoom(ctx, appts, now, priced.minutes, 1); if (room === null) waiting = true; }
    // joining the line: limits (paused, full, closing soon, shop-only)
    if (waiting) {
      const qs = await queueSnapshot(storeId, ctx);
      const gate = await queueGate(storeId, ctx, qs, { minutes: priced.minutes, cats: priced.cats, providerId, gender, atShop: !!d.atShop });
      if (gate.ok && pax === 2 && qs.tickets.length + 2 > (Number(qs.cfg.maxPeople) || 8)) Object.assign(gate, { ok: false, code: "QUEUE_FULL", reason: "The line is full right now." });
      if (!gate.ok) { const early = await earliestReservation(storeId, ctx, priced, providerId, gender); throw new HttpsError("failed-precondition", `${gate.code}:${early || ""}:${gate.reason}`); }
    }
  } else {
    startAt = new Date(String(d.startAt || "")); if (isNaN(startAt.getTime())) throw new HttpsError("invalid-argument", "Choose a time.");
    const dateStr = new Date(startAt.getTime() + 8 * 3600000).toISOString().slice(0, 10);
    if (pax === 1 && needsMulti(ctx, priced.cats, providerId, !!homeService)) {
      multiPlan = (await computeMultiSlots(storeId, ctx, dateStr, priced.lines)).find((x) => x.t === startAt.getTime())?.plan || null;
      if (!multiPlan) throw new HttpsError("failed-precondition", "That time was just taken. Please pick another slot.");
    } else {
      const slots = await computeSlots(storeId, ctx, dateStr, priced.lines, priced.cats, priced.minutes, pax === 2 ? null : providerId, { home: !!homeService, pax, gender });
      if (!slots.includes(startAt.getTime())) throw new HttpsError("failed-precondition", "That time was just taken. Please pick another slot.");
      const dayA = await dayAppointments(storeId, dateStr);
      if (!homeService) { room = pickRoom(ctx, dayA, startAt.getTime(), priced.minutes, pax); if (room === null) throw new HttpsError("failed-precondition", "No room is free at that time. Please pick another slot."); }
      if (pax === 2) {
        const free = freeProviders(ctx, dayA, startAt.getTime(), priced.minutes, priced.cats, { home: !!homeService, gender });
        const first = providerId ? free.find((x) => x.id === providerId) || free[0] : free[0];
        const second = free.find((x) => x.id !== first?.id);
        if (!first || !second) throw new HttpsError("failed-precondition", "Two therapists aren't free at that time. Please pick another slot.");
        pair = [first, second];
      } else if (!providerId && gender) {
        // "female / male therapist only" with anyone → assign the first free match now
        providerId = freeProviders(ctx, dayA, startAt.getTime(), priced.minutes, priced.cats, { home: !!homeService, gender })[0]?.id || null;
      }
    }
  }
  // reservation fee (DP): for bigger bookings when enabled, and always for numbers with repeated no-shows
  const dpCfg = ctx.cfg.deposit || {};
  let dpAmt = 0;
  if (!d.walkIn) {
    if (cRec?.dpRequired) dpAmt = Number(dpCfg.amount) || 100;
    else if (dpCfg.enabled && priced.total >= (Number(dpCfg.minTotal) || 0) && (await storeEntitled(storeId, "salondp"))) dpAmt = Number(dpCfg.amount) || 0;
    // home service: reservation fee by default (long trip = no-show hurts more)
    const hsDp = Number(ctx.cfg.homeService?.dpAmount) || 0;
    if (homeService && hsDp > dpAmt && ctx.cfg.homeService?.dp !== false && (await storeEntitled(storeId, "salondp"))) dpAmt = hsDp;
  }
  let dp = null;
  if (dpAmt > 0) {
    const pms = (pub.payments || []).filter((m) => m.type !== "cash");
    const pm = pms.find((m) => m.id === d.payment?.methodId); const refNo = String(d.payment?.refNo || "").trim().slice(0, 60);
    if (!pm || (pm.askRefBookings !== false && refNo.length < 4 && !d.payment?.proofUrl)) throw new HttpsError("failed-precondition", `DP_REQUIRED:${dpAmt}:A reservation fee of ₱${dpAmt} is needed to book${cRec?.dpRequired ? " (because of a missed appointment before)" : ""}. Send it by ${pms.map((m) => m.name).join(" / ") || "GCash"} and tap "I've sent". It is deducted from your bill.`);
    dp = { amount: dpAmt, methodId: pm.id, methodName: pm.name, refNo, proofUrl: d.payment?.proofUrl ? String(d.payment.proofUrl).slice(0, 500) : null, status: "to_verify", at: Date.now() };
  }
  const needsConfirm = !d.walkIn && !!(pub.confirm?.mode && pub.confirm.mode !== "off");
  const referral = d.refCode && ctx.cfg.referral?.enabled ? await validReferral(storeId, d.refCode, phoneKey) : null;
  const intake = ctx.cfg.intake?.enabled ? cleanIntake(d.intake) : null;
  // promos at booking: checked against the SESSION time; the price is locked on the booking
  const promoCtx = await bookingPromoCtx(storeId, { code: d.promoCode, cRec, phoneKey });
  const promoFor = (lines, prov) => promoCtx ? calcSalonPromos(promoCtx.all, { lines, at: startAt.getTime(), home: !!homeService, pax, firstVisit: promoCtx.firstVisit, codes: promoCtx.codes, providerId: prov || null, blocked: promoCtx.blocked }) : null;
  const pr0 = promoFor(priced.lines, pair ? pair[0].id : providerId);
  if (promoCtx?.code && promoCtx.codes.length && !(pr0?.applied || []).some((x) => promoCtx.codes.includes(x.id))) throw new HttpsError("failed-precondition", "This promo code doesn't apply to the services or time you picked.");
  let voucherCode = null;
  if (promoCtx?.code && !promoCtx.codes.length) {
    const v = await loadVoucher(storeId, promoCtx.code);
    const vr = voucherDiscount(v, { subtotal: priced.total - (pr0?.discount || 0), serviceType: "salon", customerKey: phoneKey });
    if (!vr.ok) throw new HttpsError("failed-precondition", v ? vr.reason : "Promo code not found.");
    voucherCode = v.code;
  }
  const lockPromo = (r) => r && (r.discount > 0 || r.homeFeeWaived) ? { bookPromo: { amount: r.discount, lines: r.lines, applied: r.applied, homeFeeWaived: r.homeFeeWaived }, promoDiscount: r.discount } : {};
  if (pr0?.homeFeeWaived && homeService) Object.assign(homeService, { fee: 0, feeWaived: true, feeConfirmed: true });
  if (!d.walkIn) { const { lim, plan } = await storeLimits(storeId, "salon"); await countBooking(storeId, lim, plan, testOn(ctx.store.settings), startAt); } // walk-in line tickets do not count toward the booking limit
  if (multiPlan) {
    const groupId = db.collection("x").doc().id; const refs = [];
    for (const [i, p] of multiPlan.entries()) {
      const part = { lines: p.lines, total: round2(p.lines.reduce((x, l) => x + l.price, 0)), minutes: p.minutes, cats: [...new Set(p.lines.map((l) => l.categoryId))] };
      refs.push(await writeAppointment(storeId, ctx, part, { customer, uid, providerId: p.providerId, startAt: new Date(p.start), notes: d.notes, source: "customer", status: needsConfirm ? "unconfirmed" : "pending", homeService: i === 0 ? homeService : null, birthday: d.birthday, referral: i === 0 ? referral : null }));
    }
    const group = await Promise.all(refs.map(async (r, i) => ({ id: r.id, providerName: multiPlan[i].providerName, startAt: multiPlan[i].start, items: multiPlan[i].lines.map((l) => l.name), code: (await r.get()).data().code })));
    for (const [i, r] of refs.entries()) await r.update({ groupId, groupPart: i + 1, groupSize: refs.length, group, ...(i === 0 && dp ? { dp } : {}), ...(intake ? { intake } : {}), ...(i === 0 && voucherCode ? { voucherCode } : {}), ...lockPromo(promoFor(multiPlan[i].lines, multiPlan[i].providerId)) });
    notifyTelegram(storeId, "reservation", `💇 New booking ${customer.name} · ${startAt.toLocaleString("en-PH", { timeZone: "Asia/Manila", weekday: "short", hour: "numeric", minute: "2-digit" })} · ${multiPlan.map((p) => `${p.providerName}: ${p.lines.map((l) => l.name).join(", ")}`).join(" → ")}${dp ? ` · DP ₱${dp.amount} (${dp.methodName} ${dp.refNo})` : ""}`);
    return { id: refs[0].id, storeId, needsConfirm, waiting: false, group: group.map((g) => g.id) };
  }
  const roomFields = room ? { roomId: room.id, roomName: room.name, beds: 1 } : {};
  if (pair) {
    // couple / 2 pax: two therapists at the same time (same room in the shop), linked as one booking
    const groupId = db.collection("x").doc().id; const refs = [];
    for (const [i, p] of pair.entries()) refs.push(await writeAppointment(storeId, ctx, priced, { customer: i ? { ...customer, name: `${customer.name} (+1)` } : customer, uid, providerId: p.id, startAt, notes: d.notes, source: "customer", status: needsConfirm ? "unconfirmed" : "pending", homeService: i === 0 ? homeService : homeService ? { ...homeService, fee: 0 } : null, birthday: i ? null : d.birthday, referral: i ? null : referral, extra: { ...roomFields, pax: 2, ...(gender ? { genderPref: gender } : {}) } }));
    const group = await Promise.all(refs.map(async (r, i) => ({ id: r.id, providerName: pair[i].name, startAt: startAt.getTime(), items: priced.lines.map((l) => l.name), code: (await r.get()).data().code })));
    for (const [i, r] of refs.entries()) await r.update({ groupId, groupPart: i + 1, groupSize: 2, group, couple: true, ...(i === 0 && dp ? { dp } : {}), ...(intake ? { intake: i ? { ...intake, note: "Same form as the main guest — ask the +1 too" } : intake } : {}), ...(i === 0 && voucherCode ? { voucherCode } : {}), ...lockPromo(promoFor(priced.lines, pair[i].id)) });
    notifyTelegram(storeId, "reservation", `💆 New couple booking ${customer.name} · ${startAt.toLocaleString("en-PH", { timeZone: "Asia/Manila", weekday: "short", hour: "numeric", minute: "2-digit" })} · ${pair.map((p) => p.name).join(" + ")}${room ? ` · ${room.name}` : ""} · ${priced.lines.map((l) => l.name).join(", ")}`);
    return { id: refs[0].id, storeId, needsConfirm, waiting: false, group: group.map((g) => g.id) };
  }
  const ref = await writeAppointment(storeId, ctx, priced, { customer, uid, providerId, startAt, notes: d.notes, source: d.walkIn ? "walkin" : "customer", status: needsConfirm ? "unconfirmed" : "pending", homeService, birthday: d.birthday, referral, extra: { ...roomFields, ...(gender ? { genderPref: gender } : {}), ...(intake ? { intake } : {}), ...(voucherCode ? { voucherCode } : {}), ...lockPromo(pr0) } });
  if (dp) await ref.update({ dp });
  if (waiting) {
    const dk0 = dayKey(new Date(), ctx.store.settings?.businessDayCutoff);
    const n = await nextWaitNo(storeId, dk0);
    await ref.update({ waiting: true, waitNo: n, qpos: n, waitedSince: FieldValue.serverTimestamp(), ...(d.atShop ? { atShop: true } : {}) });
    if (d.walkIn && pax === 2) {
      // the second person: their own ticket right after, linked to the first
      const ref2 = await writeAppointment(storeId, ctx, priced, { customer: { ...customer, name: `${customer.name} (+1)` }, uid, providerId: null, startAt, notes: d.notes, source: "walkin", status: "pending", homeService: null, extra: { ...(intake ? { intake: { ...intake, note: "Same form as the main guest — ask the +1 too" } } : {}) } });
      const n2 = await nextWaitNo(storeId, dk0); const groupId = db.collection("x").doc().id;
      const group = [{ id: ref.id, providerName: "", startAt: startAt.getTime(), items: priced.lines.map((l) => l.name), code: "" }, { id: ref2.id, providerName: "", startAt: startAt.getTime(), items: priced.lines.map((l) => l.name), code: "" }];
      await ref2.update({ waiting: true, waitNo: n2, qpos: n2, waitedSince: FieldValue.serverTimestamp(), groupId, groupPart: 2, groupSize: 2, group, couple: true, ...(d.atShop ? { atShop: true } : {}) });
      await ref.update({ groupId, groupPart: 1, groupSize: 2, group, couple: true });
    }
  }
  notifyTelegram(storeId, "reservation", `💇 New booking ${customer.name} · ${startAt.toLocaleString("en-PH", { timeZone: "Asia/Manila", weekday: "short", hour: "numeric", minute: "2-digit" })} · ${priced.lines.map((l) => l.name).join(", ")}${needsConfirm ? " (awaiting Messenger confirmation)" : ""}${dp ? ` · DP ₱${dp.amount} (${dp.methodName} ${dp.refNo}) — verify` : ""}`);
  return { id: ref.id, storeId, needsConfirm, waiting };
}));
// ===== next visit (tentative) + manual confirm, owner status, blocked time, "on my way" =====
async function visitFrom(d) {
  const pub = (await db.doc(`publicStores/${String(d.slug || "")}`).get()).data(); if (!pub) throw new HttpsError("not-found", "Store not found.");
  const [id, tok] = String(d.v || "").split(".");
  if (!id || !tok || !/^[\w-]{6,40}$/.test(id)) throw new HttpsError("not-found", "This link is not valid.");
  const ref = db.doc(`stores/${pub.storeId}/appointments/${id}`); const snap = await ref.get(); const a = snap.data();
  if (!a || !a.visitToken || a.visitToken !== tok) throw new HttpsError("not-found", "This link is not valid or has expired. Please message the salon.");
  return { pub, ref, a, storeId: pub.storeId };
}
const visitView = (a, id, storeId) => ({ id, storeId, code: a.code, status: a.status, startAt: a.startAt.toMillis(), items: (a.items || []).map((l) => ({ name: l.name, price: l.price, duration: l.duration })), total: a.total, homeFee: a.homeFee || 0, homeService: a.homeService ? { address: a.homeService.address, area: a.homeService.area || "" } : null, providerName: a.providerName || null, visitConfirm: a.visitConfirm || null, tentative: !!a.tentative, customerName: (a.customer?.name || "").split(" ")[0] });
/** public: the customer opens the link the owner sent (no account needed) */
exports.visitInfo = onCall(async (req) => {
  const { uid } = requireAuth(req);
  const { ref, a, storeId } = await visitFrom(req.data || {});
  if (!a.customerUid && uid) await ref.update({ customerUid: uid }).catch(() => {});
  return { ...visitView(a, ref.id, storeId), mine: !a.customerUid || a.customerUid === uid };
});
exports.visitSlots = onCall(async (req) => {
  requireAuth(req);
  const d = req.data || {}; const { ref, a, storeId } = await visitFrom(d);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d.date || ""))) throw new HttpsError("invalid-argument", "Invalid date.");
  const ctx = await salonContext(storeId);
  const slots = await computeSlots(storeId, ctx, d.date, a.items, a.categories || [], a.durationConfirmed || a.durationEst, a.providerId || null, { home: !!a.homeService, excludeId: ref.id });
  return { slots };
});
/** public: confirm / change / cancel */
exports.visitRespond = onCall(async (req) => {
  const { uid } = requireAuth(req);
  const d = req.data || {}; const { ref, a, storeId } = await visitFrom(d);
  if (!["unconfirmed", "pending", "confirmed"].includes(a.status)) throw new HttpsError("failed-precondition", "This booking can no longer be changed. Please message the salon.");
  const ans = String(d.answer || ""); const vc = { at: Date.now(), by: "customer" };
  let patch;
  if (ans === "yes") patch = { status: "confirmed", visitConfirm: { ...vc, status: "yes" } };
  else if (ans === "no") patch = { status: "cancelled", cancelReason: String(d.reason || "Customer can't make it").slice(0, 120), cancelledAt: FieldValue.serverTimestamp(), visitConfirm: { ...vc, status: "no" } };
  else if (ans === "move") {
    const startAt = new Date(String(d.startAt || "")); if (isNaN(startAt.getTime())) throw new HttpsError("invalid-argument", "Choose a new time.");
    const ctx = await salonContext(storeId); const dateStr = new Date(startAt.getTime() + 8 * 3600000).toISOString().slice(0, 10);
    const slots = await computeSlots(storeId, ctx, dateStr, a.items, a.categories || [], a.durationConfirmed || a.durationEst, a.providerId || null, { home: !!a.homeService, excludeId: ref.id });
    if (!slots.includes(startAt.getTime())) throw new HttpsError("failed-precondition", "That time was just taken. Please pick another.");
    patch = { status: "confirmed", startAt: Timestamp.fromDate(startAt), dayKey: dayKey(startAt, ctx.store.settings?.businessDayCutoff), rescheduledFrom: a.startAt, visitConfirm: { ...vc, status: "moved", from: a.startAt.toMillis() } };
  } else throw new HttpsError("invalid-argument", "Unknown answer.");
  await ref.update({ ...patch, ...(!a.customerUid && uid ? { customerUid: uid } : {}), updatedAt: FieldValue.serverTimestamp() });
  notifyTelegram(storeId, "reservation", `${ans === "yes" ? "✅" : ans === "no" ? "❌" : "🔁"} ${a.customer?.name || "Client"} ${ans === "yes" ? "confirmed" : ans === "no" ? "can't make it" : "moved"} the visit · ${(patch.startAt || a.startAt).toDate().toLocaleString("en-PH", { timeZone: "Asia/Manila", weekday: "short", hour: "numeric", minute: "2-digit" })}`);
  return visitView({ ...a, ...patch, startAt: patch.startAt || a.startAt }, ref.id, storeId);
});
/** counter/owner: mark what the client said after calling / texting */
exports.visitMark = onCall(async (req) => {
  const who = await staffFrom(req);
  if (!hasRole(who, "crew")) throw new HttpsError("permission-denied", "Only the counter or a manager can do this.");
  const d = req.data || {}; const ref = db.doc(`stores/${who.storeId}/appointments/${String(d.id || "")}`); const a = (await ref.get()).data();
  if (!a) throw new HttpsError("not-found", "Booking not found.");
  const ans = String(d.answer || ""); const vc = { at: Date.now(), by: who.name || "Staff" };
  const patch = ans === "yes" ? { status: "confirmed", visitConfirm: { ...vc, status: "yes" } }
    : ans === "no" ? { status: "cancelled", cancelReason: "Client can't make it", cancelledAt: FieldValue.serverTimestamp(), visitConfirm: { ...vc, status: "no" } }
    : ans === "noanswer" ? { visitConfirm: { ...(a.visitConfirm || {}), status: "waiting", tries: (a.visitConfirm?.tries || 0) + 1, lastTry: Date.now() } }
    : ans === "contacted" ? { visitConfirm: { ...(a.visitConfirm || {}), status: a.visitConfirm?.status || "waiting", contactedAt: Date.now(), contactedBy: vc.by } } : null;
  if (!patch) throw new HttpsError("invalid-argument", "Unknown answer.");
  await ref.update({ ...patch, updatedAt: FieldValue.serverTimestamp() });
  await audit(who.storeId, who, "visit_" + ans, { summary: `${a.customer?.name || ""} ${a.code}` });
  return { ok: true };
});
/** counter/owner: a link the client can open to confirm / move / cancel (sent from the owner's own phone) */
exports.apptLink = onCall(async (req) => {
  const who = await staffFrom(req);
  const ref = db.doc(`stores/${who.storeId}/appointments/${String(req.data?.id || "")}`); const a = (await ref.get()).data();
  if (!a) throw new HttpsError("not-found", "Booking not found.");
  let tok = a.visitToken; if (!tok) { tok = crypto.randomBytes(12).toString("base64url"); await ref.update({ visitToken: tok }); }
  const store = (await db.doc(`stores/${who.storeId}`).get()).data();
  return { slug: store.slug, v: `${ref.id}.${tok}`, path: `/m/${store.slug}?v=${ref.id}.${tok}` };
});
/** owner status shown to customers: in / home / break / away / closed (+ back at, wait note). Resets at midnight. */
exports.setPresence = onCall(async (req) => {
  const who = await staffFrom(req);
  if (!hasRole(who, "crew")) throw new HttpsError("permission-denied", "Only the counter or a manager can do this.");
  const d = req.data || {}; const state = ["in", "home", "break", "away", "closed"].includes(d.state) ? d.state : "in";
  const endOfDay = phMidnight(new Date(Date.now() + 8 * 3600e3 + 86400e3).toISOString().slice(0, 10)).getTime();
  const presence = { state, backAt: /^\d{2}:\d{2}$/.test(String(d.backAt || "")) ? String(d.backAt) : null, waitNote: String(d.waitNote || "").trim().slice(0, 80), at: Date.now(), by: who.name || "Owner", until: endOfDay };
  await db.doc(`stores/${who.storeId}`).update({ "salonLive.presence": presence, updatedAt: FieldValue.serverTimestamp() });
  return { ok: true, presence };
});
/** counter/owner: block time on the calendar (or a whole day: "I'm sick today") */
exports.blockTime = onCall(async (req) => {
  const who = await staffFrom(req);
  if (!hasRole(who, "crew")) throw new HttpsError("permission-denied", "Only the counter or a manager can do this.");
  const d = req.data || {}; const sref = db.doc(`stores/${who.storeId}`);
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const cur = ((await sref.get()).data()?.salonLive?.blocks || []).filter((b) => b.date >= today);
  let next;
  if (d.remove) next = cur.filter((b) => b.id !== String(d.remove));
  else {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(d.date || "")) || d.date < today) throw new HttpsError("invalid-argument", "Pick today or a future date.");
    const from = /^\d{2}:\d{2}$/.test(String(d.from || "")) ? d.from : "00:00", to = /^\d{2}:\d{2}$/.test(String(d.to || "")) ? d.to : "23:59";
    if (hmMin(to) <= hmMin(from)) throw new HttpsError("invalid-argument", "End time must be after the start time.");
    next = [...cur, { id: crypto.randomBytes(5).toString("hex"), date: d.date, from, to, staffId: d.staffId ? String(d.staffId) : null, reason: String(d.reason || "").slice(0, 60), by: who.name || "" }].slice(-200);
  }
  await sref.update({ "salonLive.blocks": next, updatedAt: FieldValue.serverTimestamp() });
  await audit(who.storeId, who, d.remove ? "unblock_time" : "block_time", { summary: d.remove ? String(d.remove) : `${d.date} ${d.from || ""}-${d.to || ""}` });
  return { ok: true, blocks: next };
});
/** stylist: "On my way" — shows the ETA on the client's status page (the text itself goes from the owner's phone) */
exports.apptOnTheWay = onCall(async (req) => {
  const who = await staffFrom(req);
  const ref = db.doc(`stores/${who.storeId}/appointments/${String(req.data?.id || "")}`); const a = (await ref.get()).data();
  if (!a) throw new HttpsError("not-found", "Booking not found.");
  const eta = Math.max(0, Math.min(240, Number(req.data?.etaMin) || 0));
  await ref.update({ onTheWay: req.data?.clear ? null : { at: Date.now(), etaAt: Date.now() + eta * 60000, by: who.name || "" }, updatedAt: FieldValue.serverTimestamp() });
  // shop status while on home service: "close" (auto), "ask" (the stylist chose in the app), "open" (never)
  let presence = null;
  if (!req.data?.clear && a.homeService && req.data?.away) {
    const mins = eta + (Number(a.durationConfirmed || a.durationEst) || 60) + eta; // there + service + back
    const back = new Date(Date.now() + 8 * 3600e3 + mins * 60000); const backAt = `${String(back.getUTCHours()).padStart(2, "0")}:${String(Math.ceil(back.getUTCMinutes() / 15) * 15 % 60).padStart(2, "0")}`;
    const endOfDay = phMidnight(new Date(Date.now() + 8 * 3600e3 + 86400e3).toISOString().slice(0, 10)).getTime();
    presence = { state: "home", backAt, waitNote: "", at: Date.now(), by: who.name || "", until: endOfDay, auto: true, apptId: ref.id };
    await db.doc(`stores/${who.storeId}`).update({ "salonLive.presence": presence, updatedAt: FieldValue.serverTimestamp() });
  }
  return { ok: true, presence };
});
// customer: position on today's waitlist (skill-aware note is shown client-side)
exports.waitlistPosition = onCall(async (req) => {
  const { uid } = requireAuth(req);
  const d = req.data || {}; const storeId = String(d.storeId || "");
  const snap = await db.doc(`stores/${storeId}/appointments/${String(d.id || "")}`).get();
  if (!snap.exists || snap.data().customerUid !== uid) throw new HttpsError("permission-denied", "Not your booking.");
  const a = snap.data(); if (!a.waiting) return { waiting: false };
  const q = await db.collection(`stores/${storeId}/appointments`).where("waiting", "==", true).get();
  const all = q.docs.map((x) => x.data()).filter((x) => APPT_ACTIVE.includes(x.status) && x.dayKey === a.dayKey);
  return { waiting: true, waitNo: a.waitNo || null, ahead: all.filter((x) => (x.waitNo || 0) < (a.waitNo || 0)).length, total: all.length };
});
// customer: cancel / reschedule
exports.cancelAppointment = onCall(async (req) => {
  const { uid } = requireAuth(req);
  const d = req.data || {}; const storeId = String(d.storeId || "");
  const ref = db.doc(`stores/${storeId}/appointments/${String(d.id || "")}`); const snap = await ref.get();
  if (!snap.exists || snap.data().customerUid !== uid) throw new HttpsError("permission-denied", "Not your booking.");
  const a = snap.data(); if (!APPT_ACTIVE.includes(a.status) || a.status === "in_progress") throw new HttpsError("failed-precondition", "This booking can no longer be cancelled.");
  const cfg = (await db.doc(`stores/${storeId}`).get()).data().settings?.salon || {};
  if (a.startAt.toMillis() - Date.now() < (Number(cfg.cancelHours) || 0) * 3600000 && a.status !== "unconfirmed") throw new HttpsError("failed-precondition", `Cancellations must be made at least ${cfg.cancelHours} hours before. Please message the salon.`);
  const upd = { status: "cancelled", cancelReason: String(d.reason || "Cancelled by customer").slice(0, 120), cancelledAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() };
  const pol = bookingPolicy((await db.doc(`stores/${storeId}`).get()).data());
  await ref.update({ ...upd, ...(a.dp && ["to_verify", "verified"].includes(a.dp.status) ? { "dp.status": pol.refundable ? "refund_due" : "forfeited" } : {}) });
  for (const g of a.group || []) if (g.id !== ref.id) await db.doc(`stores/${storeId}/appointments/${g.id}`).update(upd).catch(() => {});
  notifyTelegram(storeId, "reservation", `❌ Booking cancelled by ${a.customer?.name} · ${a.startAt.toDate().toLocaleString("en-PH", { timeZone: "Asia/Manila", weekday: "short", hour: "numeric", minute: "2-digit" })}`);
  return { ok: true };
});
exports.rescheduleAppointment = onCall(async (req) => {
  const { uid } = requireAuth(req);
  const d = req.data || {}; const storeId = String(d.storeId || "");
  const ref = db.doc(`stores/${storeId}/appointments/${String(d.id || "")}`); const snap = await ref.get();
  if (!snap.exists || snap.data().customerUid !== uid) throw new HttpsError("permission-denied", "Not your booking.");
  const a = snap.data(); if (!["unconfirmed", "pending", "confirmed"].includes(a.status)) throw new HttpsError("failed-precondition", "This booking can no longer be rescheduled.");
  if (a.groupId) throw new HttpsError("failed-precondition", "This booking has more than one stylist — please message the salon to move it, or cancel and book again.");
  const ctx = await salonContext(storeId); const cfg = ctx.cfg;
  if (a.startAt.toMillis() - Date.now() < (Number(cfg.cancelHours) || 0) * 3600000 && a.status !== "unconfirmed") throw new HttpsError("failed-precondition", `Changes must be made at least ${cfg.cancelHours} hours before. Please message the salon.`);
  const fee = a.status === "unconfirmed" ? 0 : reschedFee(bookingPolicy(ctx.store), a.startAt.toMillis(), a.reschedCount || 0, (a.total || 0) + (a.homeFee || 0), d.acceptFee);
  const startAt = new Date(String(d.startAt || "")); if (isNaN(startAt.getTime())) throw new HttpsError("invalid-argument", "Choose a time.");
  const dateStr = new Date(startAt.getTime() + 8 * 3600000).toISOString().slice(0, 10);
  // exclude this appointment when checking slots: temporarily treat as cancelled
  await ref.update({ status: "cancelled" });
  const slots = await computeSlots(storeId, ctx, dateStr, a.items, a.categories || [], a.durationConfirmed || a.durationEst, a.providerId || a.requestedProviderId || null, { home: !!a.homeService });
  if (!slots.includes(startAt.getTime())) { await ref.update({ status: a.status }); throw new HttpsError("failed-precondition", "That time is not available."); }
  await ref.update({ reschedCount: (a.reschedCount || 0) + 1, ...(fee ? { total: round2((a.total || 0) + fee), reschedFees: round2((a.reschedFees || 0) + fee), extraCharges: FieldValue.arrayUnion({ label: "Moving date fee", amount: fee, at: Date.now() }) } : {}), status: a.status === "confirmed" ? "pending" : a.status, startAt: Timestamp.fromDate(startAt), dayKey: dayKey(startAt, ctx.store.settings?.businessDayCutoff), rescheduledFrom: a.startAt, durationConfirmed: null, updatedAt: FieldValue.serverTimestamp() });
  return { ok: true };
});
// staff/counter: walk-in or phone booking (no slot check for "now" walk-ins; counter decides)
exports.staffCreateAppointment = onCall(async (req) => {
  await maintGuard(req);
  const { token } = requireAuth(req); const storeId = token.storeId; if (!storeId) throw new HttpsError("permission-denied", "No store.");
  const d = req.data || {}; const ctx = await salonContext(storeId);
  const customer = custFrom(d.customer, "Walk-in");
  const priced = apptLines(Array.isArray(d.itemIds) ? d.itemIds : [], ctx.items);
  if (d.homeService && !customer.address && customer.phone.replace(/\D/g, "").length >= 7) { const h = (await db.doc(`stores/${storeId}/customers/${customer.phone.replace(/\D/g, "")}`).get()).data()?.home; if (h) Object.assign(customer, { address: h.address || "", landmark: h.landmark || "", mapUrl: h.mapUrl || "" }); if (h?.area && typeof d.homeService === "object" && !d.homeService.area) d.homeService.area = h.area; }
  const homeService = d.homeService ? homeServiceFor(ctx, { ...d, staff: true, homeService: d.homeService }, customer, 0) : null;
  if (homeService && typeof d.homeService === "object" && d.homeService.fee != null) { homeService.fee = Math.max(0, Number(d.homeService.fee) || 0); homeService.feeConfirmed = true; }
  const startAt = d.startAt ? new Date(String(d.startAt)) : new Date(); if (isNaN(startAt.getTime())) throw new HttpsError("invalid-argument", "Invalid time.");
  // same phone already has an active booking → warn the counter (they can still force it)
  const pk = customer.phone.replace(/\D/g, "");
  if (pk.length >= 7 && !d.force) {
    const ex = (await db.collection(`stores/${storeId}/appointments`).where("customerKey", "==", pk).where("status", "in", APPT_ACTIVE).limit(1).get()).docs[0];
    if (ex) throw new HttpsError("already-exists", `This number already has an active booking (${ex.data().code} · ${ex.data().startAt.toDate().toLocaleString("en-PH", { timeZone: "Asia/Manila", weekday: "short", hour: "numeric", minute: "2-digit" })}).`);
  }
  // a chosen stylist who already has a client at that time → warn the counter (they can still force it)
  if (d.providerId && !d.force) {
    const tr = homeService ? travelOf(ctx.cfg) : 0;
    const s = startAt.getTime(), e = s + (priced.minutes + (homeService ? tr : Number(ctx.cfg.bufferMin) || 0)) * 60000;
    const clash = (await dayAppointments(storeId, new Date(s + 8 * 3600000).toISOString().slice(0, 10))).find((a) => a.providerId === String(d.providerId) && a.id !== d.replaceId && overlaps(a, s - tr * 60000, e));
    if (clash) throw new HttpsError("already-exists", `${clash.providerName || "This stylist"} already has a client at that time (${clash.customer?.name || clash.code}).`);
    const stp = ctx.stylists.find((x) => x.id === String(d.providerId)); const why = stp && offReason(stp, s, s + priced.minutes * 60000);
    if (why) throw new HttpsError("already-exists", `${stp.name} is ${why} (${new Date(s).toLocaleString("en-PH", { timeZone: "Asia/Manila", weekday: "short", hour: "numeric", minute: "2-digit" })}). Book anyway?`);
  }
  const referral = d.refCode && ctx.cfg.referral?.enabled ? await validReferral(storeId, d.refCode, pk) : null;
  { const { lim, plan } = await storeLimits(storeId, "salon"); await countBooking(storeId, lim, plan, testOn(ctx.store.settings), startAt); }
  // treatment room (spa): auto-pick a free one for shop bookings; full → the counter is told (can force)
  let roomF = {};
  if (!homeService && spaRooms(ctx).length) {
    const dayA = (await dayAppointments(storeId, new Date(startAt.getTime() + 8 * 3600000).toISOString().slice(0, 10))).filter((x) => x.id !== d.replaceId);
    const r = d.roomId ? spaRooms(ctx).find((x) => x.id === String(d.roomId)) : pickRoom(ctx, dayA, startAt.getTime(), priced.minutes, 1);
    if (r) roomF = { roomId: r.id, roomName: r.name, beds: 1 }; else if (!d.force) throw new HttpsError("already-exists", "All rooms are busy at that time. Book anyway?");
  }
  const ref = await writeAppointment(storeId, ctx, priced, { customer, uid: null, providerId: d.providerId ? String(d.providerId) : null, startAt, notes: d.notes, source: d.walkIn ? "walkin" : "counter", status: d.providerId && !d.tentative ? "confirmed" : "pending", staffName: d.staffName, homeService, birthday: d.birthday, referral, extra: { ...roomF, ...(d.tentative ? { tentative: true, visitConfirm: { status: "waiting", at: Date.now() }, visitToken: crypto.randomBytes(12).toString("base64url"), ...(d.fromApptId ? { nextOf: String(d.fromApptId) } : {}) } : {}) } });
  if (d.walkIn && !d.providerId) {
    const now = Date.now(); const appts = (await dayAppointments(storeId, new Date(now + 8 * 3600000).toISOString().slice(0, 10))).filter((x) => x.id !== ref.id);
    const free = ctx.stylists.filter((st) => !awayNow(ctx, st) && canDo(st, priced.cats) && stylistFree(st, now, now + priced.minutes * 60000) && !appts.some((a) => a.providerId === st.id && overlaps(a, now, now + priced.minutes * 60000)));
    if (!free.length) await ref.update({ waiting: true, waitNo: await nextWaitNo(storeId, dayKey(new Date(), ctx.store.settings?.businessDayCutoff)), waitedSince: FieldValue.serverTimestamp() });
  }
  if (d.providerId) await db.doc(`stores/${storeId}/staff/${String(d.providerId)}`).update({ lastAssignedAt: FieldValue.serverTimestamp(), jobsTotal: FieldValue.increment(1) }).catch(() => {});
  return { id: ref.id, code: (await ref.get()).data().code };
});
// counter: assign (or reassign) a stylist; records rotation
exports.assignAppointment = onCall(async (req) => {
  const { token } = requireAuth(req); const storeId = token.storeId; if (!storeId) throw new HttpsError("permission-denied", "No store.");
  const d = req.data || {};
  const ref = db.doc(`stores/${storeId}/appointments/${String(d.id || "")}`); const snap = await ref.get(); if (!snap.exists) throw new HttpsError("not-found", "Booking not found.");
  const a = snap.data();
  const st = (await db.doc(`stores/${storeId}/staff/${String(d.providerId || "")}`).get()); if (!st.exists) throw new HttpsError("not-found", "Staff not found.");
  if (!d.force) {
    const s = a.waiting ? Date.now() : a.startAt.toMillis(), e = s + ((a.durationConfirmed || a.durationEst || 30) + (a.buffer || 0)) * 60000;
    const clash = (await dayAppointments(storeId, new Date(s + 8 * 3600000).toISOString().slice(0, 10))).find((x) => x.id !== snap.id && x.providerId === st.id && overlaps(x, s, e));
    if (clash) throw new HttpsError("already-exists", `${st.data().name} already has a client at that time (${clash.customer?.name || clash.code}).`);
    const why = offReason(st.data(), s, e);
    if (why) throw new HttpsError("already-exists", `${st.data().name} is ${why} at that time.`);
  }
  await ref.update({ providerId: st.id, providerName: st.data().name, status: a.status === "unconfirmed" ? "unconfirmed" : a.status === "pending" ? "confirmed" : a.status, ...(a.waiting ? { waiting: false, startAt: Timestamp.now() } : {}), assignedBy: String(d.staffName || "").slice(0, 40), assignedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  await st.ref.update({ lastAssignedAt: FieldValue.serverTimestamp(), jobsTotal: FieldValue.increment(1) });
  return { ok: true };
});
// appointments: customer stats, no-show strikes (auto require DP / block after N)
// ===== HOME SERVICE RIDER (hatid-sundo) · treatment rooms · therapist safety =====
const ESCORT_STEPS = { to_client: "On the way to the client", dropped: "Dropped off", pickup_requested: "Waiting for pickup", to_pickup: "On the way to pick up", picked_up: "Picked up", back: "Back at the shop", released: "Staff went home" };
async function escortOn(storeId, store) { return !!store?.settings?.salon?.homeService?.escort && (await storeEntitled(storeId, "delivery")); }
exports.apptExtras = onCall(async (req) => {
  const who = await staffFrom(req); const { storeId } = who; const d = req.data || {};
  const ref = db.doc(`stores/${storeId}/appointments/${String(d.id || "")}`); const a = (await ref.get()).data();
  if (!a) throw new HttpsError("not-found", "Booking not found.");
  const store = (await db.doc(`stores/${storeId}`).get()).data() || {};
  const now = Date.now(), hist = (s) => FieldValue.arrayUnion({ s, at: now, by: who.name || "" });
  if (d.action === "setRoom") {
    if (!hasRole(who, "crew")) throw new HttpsError("permission-denied", "Only the counter or a manager can move rooms.");
    const ctx = await salonContext(storeId); const r = spaRooms(ctx).find((x) => x.id === String(d.roomId || ""));
    if (!r) { await ref.update({ roomId: null, roomName: null, updatedAt: FieldValue.serverTimestamp() }); return { ok: true }; }
    const dayA = (await dayAppointments(storeId, new Date(a.startAt.toMillis() + 8 * 3600e3).toISOString().slice(0, 10))).filter((x) => x.id !== ref.id && x.roomId === r.id);
    const ok = pickRoom({ ...ctx, cfg: { ...ctx.cfg, rooms: [r] } }, dayA, a.startAt.toMillis(), a.durationConfirmed || a.durationEst || 60, Number(a.beds) || 1);
    if (!ok && !d.force) throw new HttpsError("already-exists", `${r.name} is busy at that time. Move anyway?`);
    await ref.update({ roomId: r.id, roomName: r.name, updatedAt: FieldValue.serverTimestamp() });
    return { ok: true };
  }
  if (d.action === "escortAssign") {
    if (!hasRole(who, "crew")) throw new HttpsError("permission-denied", "Only the counter or a manager can assign a rider.");
    if (!a.homeService) throw new HttpsError("failed-precondition", "Not a home service booking.");
    if (!(await escortOn(storeId, store))) throw new HttpsError("failed-precondition", "Rider drop-off & pick-up is off (Settings → Home service) or not on your plan.");
    const r = d.riderId ? (await db.doc(`stores/${storeId}/staff/${String(d.riderId)}`).get()).data() : null;
    if (d.riderId && (!r || !(r.roles || []).includes("rider"))) throw new HttpsError("invalid-argument", "Pick a staff member with the Rider role.");
    await ref.update({ escort: { ...(a.escort || {}), riderId: d.riderId ? String(d.riderId) : null, riderName: r?.name || null, status: a.escort?.status && a.escort.status !== "unassigned" ? a.escort.status : d.riderId ? "assigned" : "unassigned" }, updatedAt: FieldValue.serverTimestamp() });
    return { ok: true };
  }
  if (d.action === "escortStep") {
    const step = String(d.step || ""); if (!ESCORT_STEPS[step]) throw new HttpsError("invalid-argument", "Unknown step.");
    const e = a.escort || {};
    const isRider = e.riderId && e.riderId === who.staffId, isTherapist = a.providerId && a.providerId === who.staffId;
    if (step === "pickup_requested" ? !(isTherapist || isRider || hasRole(who, "crew")) : !(isRider || hasRole(who, "crew") || (!e.riderId && who.roles.includes("rider")))) throw new HttpsError("permission-denied", "This trip is assigned to another rider.");
    const patch = { "escort.status": step, "escort.history": hist(step), updatedAt: FieldValue.serverTimestamp() };
    if (!e.riderId && who.roles.includes("rider") && step !== "pickup_requested") Object.assign(patch, { "escort.riderId": who.staffId, "escort.riderName": who.name });
    if (step === "to_client") patch.onTheWay = { at: now, etaAt: now + (Number(d.etaMin) || travelOf(store.settings?.salon || {}) || 30) * 60000, by: `${a.providerName || ""} (rider ${e.riderName || who.name})`.trim() };
    if (step === "dropped") patch.onTheWay = null;
    await ref.update(patch);
    if (step === "pickup_requested" && e.riderId) notifyTelegram(storeId, "shift", `🛵 Pickup: ${a.providerName || "therapist"} is done at ${a.homeService?.address || ""} — ${e.riderName || "rider"}, please pick up.`);
    return { ok: true };
  }
  if (d.action === "goHome") {
    const isProv = a.providerId && a.providerId === who.staffId;
    if (!(isProv || hasRole(who, "crew"))) throw new HttpsError("permission-denied", "Only the assigned staff or the counter can set this.");
    const pst = a.providerId ? (await db.doc(`stores/${storeId}/staff/${a.providerId}`).get()).data() : null;
    if (d.on !== false && pst?.payType !== "oncall") throw new HttpsError("failed-precondition", "Only on-call staff can go straight home. Daily-paid staff go back to the shop.");
    await ref.update({ goHome: d.on !== false, updatedAt: FieldValue.serverTimestamp() });
    return { ok: true };
  }
  if (d.action === "tipVerify") {
    if (!hasRole(who, "crew")) throw new HttpsError("permission-denied", "Only the counter or a manager can confirm tips.");
    if (a.tipOnline?.status !== "to_verify") return { ok: true };
    if (d.reject) await ref.update({ "tipOnline.status": "rejected", "tipOnline.by": who.name || "", "tipOnline.note": String(d.note || "We couldn't find this reference number.").slice(0, 120) });
    else await ref.update({ "tipOnline.status": "verified", "tipOnline.by": who.name || "", "tipOnline.verifiedAt": now, tip: FieldValue.increment(Number(a.tipOnline.amount) || 0) });
    if (!d.reject && a.providerId) sendPush(storeId, { staffIds: [a.providerId] }, { title: `💝 You got a ₱${a.tipOnline.amount} tip!`, body: `From ${a.customer?.name || "your client"}`, url: "/staff/", tag: "tipok-" + ref.id });
    return { ok: true };
  }
  if (d.action === "clearSafety") {
    if (!hasRole(who, "crew")) throw new HttpsError("permission-denied", "Only the counter or a manager can clear this.");
    await ref.update({ helpOpen: false, overdueOpen: false, safetyCleared: { at: now, by: who.name || "" }, updatedAt: FieldValue.serverTimestamp() });
    return { ok: true };
  }
  if (d.action === "safety") {
    const state = d.state === "help" ? "help" : "safe";
    await ref.update({ helpOpen: state === "help", safety: { state, at: now, by: who.name || "", loc: typeof d.loc === "string" ? d.loc.slice(0, 200) : null }, ...(state === "help" ? { safetyAlerts: FieldValue.arrayUnion({ at: now, by: who.name || "", loc: d.loc || null }) } : {}), updatedAt: FieldValue.serverTimestamp() });
    if (state === "help") sendPush(storeId, { roles: ["crew"] }, { title: "🆘 HELP — " + (who.name || "staff"), body: `Home service at ${a.customer?.name || ""} · ${a.homeService?.address || ""}. Call them now.`, url: "/counter/", tag: "help-" + ref.id, urgent: true });
    if (state === "help") notifyTelegram(storeId, "incident", `🆘 HELP — ${who.name} at a home service: ${a.customer?.name || ""} · ${a.homeService?.address || ""}${d.loc ? `\nLocation: ${d.loc}` : ""}\nCall them now.`, { force: true });
    return { ok: true };
  }
  throw new HttpsError("invalid-argument", "Unknown action.");
});


// ===== Live queue & staff availability (salon / spa) =====
const QDEF = { enabled: true, maxPeople: 8, maxWaitMin: 90, remote: true, cutoffMin: 60, graceMin: 10, sms: false, paused: false };
const queueCfg = (cfg) => ({ ...QDEF, ...(cfg?.queue || {}) });
const qEnd = (a) => a.startAt.toMillis() + ((a.durationConfirmed || a.durationEst || 30) + (a.buffer || 0)) * 60000;
const phToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const atToday = (hm) => { const m = hmMin(hm); return m == null ? null : phMidnight(phToday()).getTime() + m * 60000; };
function closeAtToday(ctx) { const sp = laneSpans(ctx, phToday(), "shop"); if (!sp.length) return null; return phMidnight(phToday()).getTime() + Math.max(...sp.map((x) => x[1])) * 60000; }
/** when a staff member is free from `now` — current client and back-to-back bookings (not the queue) */
function staffFreeAt(st, appts, now) {
  const mine = appts.filter((a) => a.providerId === st.id && !a.waiting).sort((x, y) => x.startAt.toMillis() - y.startAt.toMillis());
  let t = now, home = false, moved = true;
  while (moved) { moved = false; for (const a of mine) { const s = a.startAt.toMillis() - (a.travelBefore || 0) * 60000, e = qEnd(a) + (a.homeService ? (a.travelBefore || 0) * 60000 : 0); if (s <= t + 10 * 60000 && e > t) { t = e; moved = true; if (a.homeService && s <= now) home = true; } } }
  return { t, home };
}
/** what customers see per staff: free now / busy until / on home service / break / later / off */
function staffLive(ctx, st, appts, now, closeAt) {
  if (awayNow(ctx, st)) return { status: "away" };
  const off = offReason(st, now, now + 15 * 60000);
  if (off === "on break") return { status: "break", until: atToday(st.schedule?.breakTo) };
  if (off === "off duty at that time") { const day = st.schedule?.days?.[WEEK[new Date(now + 8 * 3600e3).getUTCDay()]]; const from = atToday(day?.from); if (from && from > now) return { status: "later", at: from }; return { status: "off" }; }
  if (off) return { status: "off" };
  const { t, home } = staffFreeAt(st, appts, now);
  if (closeAt && t >= closeAt) return { status: "full" };
  if (t > now + 60000) return { status: home ? "home" : "busy", freeAt: t };
  return { status: "free" };
}
/** waiting tickets of today, in line order */
function queueTickets(appts) {
  return appts.filter((a) => a.waiting && APPT_ACTIVE.includes(a.status)).sort((x, y) => (x.qpos ?? x.waitNo ?? 0) - (y.qpos ?? y.waitNo ?? 0))
    .map((a) => ({ id: a.id, minutes: a.durationConfirmed || a.durationEst || 30, cats: a.categories || [], providerId: a.providerId || a.requestedProviderId || null, gender: a.genderPref || null, a }));
}
/** estimated start per ticket: each goes to the capable staff who is free first, around the booked clients */
function simulateQueue(ctx, appts, tickets, now, extra = null) {
  const buf = Number(ctx.cfg.bufferMin) || 0;
  const staff = ctx.stylists.filter((s) => !s.planLocked && !awayNow(ctx, s));
  const free = new Map();
  for (const s of staff) {
    const off = offReason(s, now, now + 15 * 60000);
    let t = staffFreeAt(s, appts, now).t;
    if (off === "on break") t = Math.max(t, atToday(s.schedule?.breakTo) || t);
    else if (off === "off duty at that time") { const day = s.schedule?.days?.[WEEK[new Date(now + 8 * 3600e3).getUTCDay()]]; const from = atToday(day?.from); if (!(from && from > now)) continue; t = Math.max(t, from); }
    else if (off) continue;
    free.set(s.id, t);
  }
  const booked = (id) => appts.filter((a) => a.providerId === id && !a.waiting && qEnd(a) > now).map((a) => [a.startAt.toMillis() - (a.travelBefore || 0) * 60000, qEnd(a)]);
  const fit = (id, t, dur) => { let s = t, moved = true; while (moved) { moved = false; for (const [bs, be] of booked(id)) if (s < be && s + dur * 60000 > bs) { s = be; moved = true; } } return s; };
  const out = [];
  for (const tk of [...tickets, ...(extra ? [extra] : [])]) {
    let best = null;
    for (const s of staff) {
      if (!free.has(s.id) || (tk.providerId && s.id !== tk.providerId) || !canDo(s, tk.cats) || (tk.gender && s.gender !== tk.gender)) continue;
      const at = fit(s.id, Math.max(now, free.get(s.id)), tk.minutes);
      if (!best || at < best.at) best = { id: s.id, at };
    }
    if (!best) { out.push({ id: tk.id, at: null, staffId: null }); continue; }
    free.set(best.id, best.at + (tk.minutes + buf) * 60000);
    out.push({ id: tk.id, at: best.at, staffId: best.id });
  }
  return out;
}
async function queueSnapshot(storeId, ctx) {
  const now = Date.now();
  const appts = await dayAppointments(storeId, phToday());
  const tickets = queueTickets(appts);
  return { now, appts, tickets, sim: simulateQueue(ctx, appts, tickets, now), cfg: queueCfg(ctx.cfg), closeAt: closeAtToday(ctx) };
}
async function earliestReservation(storeId, ctx, priced, providerId, gender) {
  for (let i = 0; i < 7; i++) {
    const ds = new Date(Date.now() + 8 * 3600e3 + i * 86400e3).toISOString().slice(0, 10);
    const sl = await computeSlots(storeId, ctx, ds, priced.lines, priced.cats, priced.minutes, providerId, { gender });
    const t = sl.find((x) => x > Date.now() + 15 * 60000); if (t) return t;
  }
  return null;
}
/** can a new person join the line now? → { ok, reason, etaAt, ahead, count, code } */
async function queueGate(storeId, ctx, snap, { minutes = 60, cats = [], providerId = null, gender = null, atShop = false } = {}) {
  const { cfg, now, tickets, appts, closeAt } = snap;
  const est = simulateQueue(ctx, appts, tickets, now, { id: "_new", minutes, cats, providerId, gender }).at(-1);
  const base = { count: tickets.length, etaAt: est?.at || null, waitMin: est?.at ? Math.max(0, Math.round((est.at - now) / 60000)) : null };
  if (cfg.enabled === false) return { ...base, ok: false, code: "QUEUE_OFF", reason: "The walk-in line is off — please reserve a time." };
  if (cfg.paused) return { ...base, ok: false, code: "QUEUE_PAUSED", reason: "The line is paused for a while — please reserve a time or try again later." };
  if (!closeAt || now > closeAt - (Number(cfg.cutoffMin) || 0) * 60000) return { ...base, ok: false, code: "QUEUE_CLOSED", reason: "The line is closed for today." };
  if (!atShop) {
    const { sub } = await storeLimits(storeId, "salon");
    if (!cfg.remote || tierOf(sub) < 1) return { ...base, ok: false, code: "QUEUE_SHOP_ONLY", reason: "To join the line, scan the QR code at the shop." };
  }
  if (!est?.at) return { ...base, ok: false, code: "QUEUE_NOSTAFF", reason: "No staff for these services is working today." };
  if (tickets.length >= (Number(cfg.maxPeople) || 8) || base.waitMin > (Number(cfg.maxWaitMin) || 90) || est.at + minutes * 60000 > closeAt) return { ...base, ok: false, code: "QUEUE_FULL", reason: "The line is full right now." };
  return { ...base, ok: true };
}
/** public: who is free now / when, plus the line (optionally for chosen services) */
exports.getAvailability = onCall(HOT, async (req) => {
  const d = req.data || {};
  const pub = (await db.doc(`publicStores/${String(d.slug || "")}`).get()).data(); if (!pub || pub.mode !== "salon") throw new HttpsError("not-found", "Store not found.");
  const ctx = await salonContext(pub.storeId); const snap = await queueSnapshot(pub.storeId, ctx);
  const shown = new Set((pub.team || []).map((t) => t.id));
  const staff = ctx.stylists.filter((s) => shown.has(s.id)).map((s) => ({ id: s.id, ...staffLive(ctx, s, snap.appts, snap.now, snap.closeAt) }));
  let minutes = 60, cats = [];
  if (Array.isArray(d.itemIds) && d.itemIds.length) { try { const p = apptLines(d.itemIds, ctx.items); minutes = p.minutes; cats = p.cats; } catch {} }
  const gate = await queueGate(pub.storeId, ctx, snap, { minutes, cats, providerId: d.providerId ? String(d.providerId) : null, gender: ["female", "male"].includes(d.gender) ? d.gender : null, atShop: !!d.atShop });
  return { staff, queue: { ...gate, enabled: snap.cfg.enabled !== false, remote: !!snap.cfg.remote, maxPeople: snap.cfg.maxPeople, now: snap.now } };
});
/** recompute the line: positions, estimated times, "you're next", call timeouts, offer the first ticket */
async function refreshQueue(storeId) {
  const ctx = await salonContext(storeId); const snap = await queueSnapshot(storeId, ctx); const { cfg, now, tickets, sim } = snap;
  const grace = (Number(cfg.graceMin) || 10) * 60000;
  for (const [i, tk] of tickets.entries()) {
    const a = tk.a, r = sim[i]; const ref = db.doc(`stores/${storeId}/appointments/${a.id}`);
    // called but not here in time → back of the line once, then no-show
    const c = a.queueCalled;
    if (c?.at && now > c.at + grace + (c.onWay ? 5 * 60000 : 0)) {
      if (!a.queueSkips) { const maxPos = Math.max(0, ...tickets.map((x) => x.a.qpos ?? x.a.waitNo ?? 0)); await ref.update({ qpos: maxPos + 1, queueSkips: 1, queueCalled: null, queue: null, waitNote: "You were moved to the back of the line because you weren't here when called." }); }
      else await ref.update({ status: "no_show", noShowAt: FieldValue.serverTimestamp(), waiting: false, queueCalled: null, cancelReason: "Not here when called (twice)" });
      continue;
    }
    const q = { ahead: i, etaAt: r?.at || null, staffId: r?.staffId || null, next: i === 0 || (r?.at && r.at - now <= 10 * 60000) };
    const old = a.queue || {};
    if (old.ahead !== q.ahead || Math.abs((old.etaAt || 0) - (q.etaAt || 0)) > 120000 || old.staffId !== q.staffId || !!old.next !== !!q.next) await ref.update({ queue: q });
    if ((q.next || q.ahead <= 2) && !a.queueNextSmsAt && cfg.sms && a.customer?.phone && !a.test && !a.queueCalled?.at) {
      const ok = await smsTo(storeId, a.customer.phone, q.ahead === 0 ? `${ctx.store.name}: You're next in line (#${a.waitNo || ""}). Please be at the shop in the next 10 minutes.` : `${ctx.store.name}: Only ${q.ahead} ahead of you (#${a.waitNo || ""}). Please head back to the shop.`).catch(() => false);
      await ref.update({ queueNextSmsAt: Date.now(), queueNextSmsOk: !!ok });
    }
    // first in line and someone can take them now → offer it to the staff (job offers on)
    const oc = offerCfg(ctx.cfg);
    if (i === 0 && oc.enabled && oc.auto && !a.providerId && r?.at && r.at <= now + 2 * 60000 && a.offer?.status !== "open" && a.offer?.status !== "moving") await startOffer(storeId, a.id, "queue").catch((e) => logger.warn("queueOffer", e.message));
  }
  // long line → ask on-call staff who are off to come in (at most once an hour)
  const longAt = Number(cfg.callOnCallAt) || 5;
  if (tickets.length >= longAt) {
    const mref = db.doc(`stores/${storeId}/meta/waitlist`); const m = (await mref.get()).data() || {};
    if (!m.onCallAlertAt || now - m.onCallAlertAt > 3600e3) {
      const off = ctx.stylists.filter((st) => st.payType === "oncall" && !readyForJobs(st, now) && st.wentHome?.date !== phToday()).map((st) => st.id);
      if (off.length) { await mref.set({ onCallAlertAt: now }, { merge: true }); sendPush(storeId, { staffIds: off }, { title: `🎟️ ${tickets.length} people in line`, body: `${ctx.store.name} is busy — can you come in? Tap to set yourself available.`, url: "/staff/", tag: "longline" }); }
    }
  }
  return { count: tickets.length };
}
exports.queueTick = onSchedule({ schedule: "every 1 minutes", timeZone: "Asia/Manila" }, async () => {
  const snap = await db.collectionGroup("appointments").where("waiting", "==", true).get();
  const stores = new Set(snap.docs.filter((x) => APPT_ACTIVE.includes(x.data().status)).map((x) => x.ref.parent.parent.id));
  for (const s of stores) await refreshQueue(s).catch((e) => logger.warn("queueTick", s, e.message));
});
/** public Queue TV: now serving (called / just started from the line), next numbers, wait — numbers and staff first names only */
exports.queueBoard = onCall(HOT, async (req) => {
  const d = req.data || {};
  const pub = (await db.doc(`publicStores/${String(d.slug || "")}`).get()).data(); if (!pub || pub.mode !== "salon") throw new HttpsError("not-found", "Store not found.");
  const ctx = await salonContext(pub.storeId); const snap = await queueSnapshot(pub.storeId, ctx); const now = snap.now;
  const first = (n) => String(n || "").trim().split(/\s+/)[0] || "";
  const serving = snap.appts.filter((a) => a.waitNo && ((a.waiting && a.queueCalled?.at) || (!a.waiting && a.queueCalled?.at && now - a.queueCalled.at < 20 * 60000 && ["pending", "confirmed", "in_progress"].includes(a.status))))
    .sort((x, y) => (y.queueCalled?.at || 0) - (x.queueCalled?.at || 0)).slice(0, 6)
    .map((a) => ({ no: a.waitNo, staff: first(a.providerName || ctx.stylists.find((s) => s.id === a.queue?.staffId)?.name), room: a.roomName || null, at: a.queueCalled.at, started: a.status === "in_progress" }));
  const next = snap.tickets.filter((t) => !t.a.queueCalled?.at).slice(0, 10).map((t, i) => ({ no: t.a.waitNo, eta: snap.sim[snap.tickets.indexOf(t)]?.at || null, i }));
  const gate = await queueGate(pub.storeId, ctx, snap, { atShop: true });
  return { name: pub.name, logoUrl: pub.logoUrl || null, theme: pub.theme || null, serving, next, count: snap.tickets.length, waitMin: gate.waitMin, open: gate.ok, reason: gate.ok ? "" : gate.reason, now };
});
/** customer: leave the line / "on my way" / switch to a reserved time */
exports.queueAction = onCall(async (req) => {
  const { uid } = requireAuth(req); const d = req.data || {};
  const storeId = String(d.storeId || ""); const ref = db.doc(`stores/${storeId}/appointments/${String(d.id || "")}`);
  const a = (await ref.get()).data(); if (!a || a.customerUid !== uid) throw new HttpsError("permission-denied", "Not your ticket.");
  if (!a.waiting || !APPT_ACTIVE.includes(a.status)) throw new HttpsError("failed-precondition", "You're not in the line anymore.");
  if (d.action === "leave") { await ref.update({ status: "cancelled", waiting: false, cancelReason: "Left the line", cancelledAt: FieldValue.serverTimestamp(), cancelledBy: "customer" }); return { ok: true }; }
  if (d.action === "onmyway") { if (!a.queueCalled?.at) throw new HttpsError("failed-precondition", "You haven't been called yet."); if (a.queueCalled.onWay) return { ok: true }; await ref.update({ "queueCalled.onWay": Date.now() }); notifyTelegram(storeId, "reservation", `🚶 #${a.waitNo} ${a.customer?.name || ""} is on the way (5 min).`); return { ok: true }; }
  if (d.action === "swap") {
    const ctx = await salonContext(storeId); const t = Number(d.startAt);
    const ds = new Date(t + 8 * 3600e3).toISOString().slice(0, 10);
    const sl = await computeSlots(storeId, ctx, ds, a.items || [], a.categories || [], a.durationEst || 30, a.requestedProviderId || null, { gender: a.genderPref || null, excludeId: ref.id });
    if (!sl.includes(t)) throw new HttpsError("failed-precondition", "That time was just taken. Please pick another one.");
    await ref.update({ waiting: false, startAt: Timestamp.fromMillis(t), dayKey: dayKey(new Date(t), ctx.store.settings?.businessDayCutoff), source: "customer", fromQueue: true, queue: null, queueCalled: null, waitNote: "" });
    return { ok: true };
  }
  throw new HttpsError("invalid-argument", "Unknown action.");
});
/** reception: call / skip / back to line, pause or open the line */
exports.queueOps = onCall(async (req) => {
  const who = await staffFrom(req); const { storeId } = who; const d = req.data || {};
  if (!hasRole(who, "crew")) throw new HttpsError("permission-denied", "Only the counter or a manager can manage the line.");
  if (d.action === "pause" || d.action === "resume") { await db.doc(`stores/${storeId}`).update({ "settings.salon.queue.paused": d.action === "pause", updatedAt: FieldValue.serverTimestamp() }); return { ok: true }; }
  const ref = db.doc(`stores/${storeId}/appointments/${String(d.id || "")}`); const a = (await ref.get()).data();
  if (!a || !a.waiting) throw new HttpsError("failed-precondition", "This client is not in the line.");
  if (d.action === "call") { await ref.update({ queueCalled: { at: Date.now(), by: who.name || "", onWay: null } }); if (a.customer?.phone && queueCfg((await salonContext(storeId)).cfg).sms) smsTo(storeId, a.customer.phone, `It's your turn (#${a.waitNo || ""})! Please come in now.`).catch(() => {}); }
  else if (d.action === "skip") { const all = (await dayAppointments(storeId, phToday())).filter((x) => x.waiting); await ref.update({ qpos: Math.max(0, ...all.map((x) => x.qpos ?? x.waitNo ?? 0)) + 1, queueCalled: null, queueSkips: FieldValue.increment(1) }); }
  else if (d.action === "uncall") await ref.update({ queueCalled: null });
  else throw new HttpsError("invalid-argument", "Unknown action.");
  await refreshQueue(storeId);
  return { ok: true };
});

// ===== Salon / spa promos at booking =====
async function bookingPromoCtx(storeId, { code, cRec, phoneKey }) {
  if (!(await storeEntitled(storeId, "promos"))) return null;
  const all = (await db.collection(`stores/${storeId}/promos`).where("active", "==", true).get()).docs.map((x) => ({ id: x.id, ...x.data() }));
  const c = String(code || "").trim().toUpperCase().slice(0, 30);
  const codes = c ? all.filter((p) => p.audience === "code" && String(p.promoCode || "").toUpperCase() === c).map((p) => p.id) : [];
  const blocked = [];
  if (phoneKey && phoneKey.length >= 7) for (const p of all.filter((x) => Number(x.perCustomer) > 0 || x.audience === "first_visit")) {
    const u = (await db.doc(`stores/${storeId}/promoUses/${p.id}_${phoneKey}`).get()).data();
    if ((u?.n || 0) >= (Number(p.perCustomer) || 1)) blocked.push(p.id);
  }
  return { all, code: c, codes, blocked, firstVisit: !(cRec && ((cRec.completed || 0) > 0 || (cRec.noShows || 0) > 0)) };
}
/** customer typed a promo code on the booking form → what it gives (promo or voucher) */
exports.checkBookingCode = onCall(async (req) => {
  requireAuth(req); const d = req.data || {};
  const pub = (await db.doc(`publicStores/${String(d.slug || "")}`).get()).data(); if (!pub) throw new HttpsError("not-found", "Store not found.");
  const code = String(d.code || "").trim().toUpperCase().slice(0, 30); if (code.length < 3) throw new HttpsError("invalid-argument", "Enter the promo code.");
  if (!(await storeEntitled(pub.storeId, "promos"))) throw new HttpsError("failed-precondition", "Promo codes are not available at this shop.");
  const p = (await db.collection(`stores/${pub.storeId}/promos`).where("active", "==", true).get()).docs.map((x) => ({ id: x.id, ...x.data() })).find((x) => x.audience === "code" && String(x.promoCode || "").toUpperCase() === code);
  if (p) return { kind: "promo", promo: { id: p.id, name: p.name, type: p.type, value: p.value, allItems: !!p.allItems, itemIds: p.itemIds || [], categoryIds: p.categoryIds || [], schedule: p.schedule || {}, audience: "code", place: p.place || "any", staffIds: p.staffIds || [], stack: !!p.stack, maxUses: p.maxUses || null, usedCount: p.usedCount || 0 } };
  const v = await loadVoucher(pub.storeId, code);
  if (!v || v.active === false) throw new HttpsError("not-found", "Promo code not found.");
  return { kind: "voucher", voucher: { code: v.code, type: v.type, value: v.value, maxDiscount: v.maxDiscount || null, minOrder: v.minOrder || 0, label: v.label || "" } };
});
/** promo usage: counted when booked, given back when the booking is cancelled */
async function promoUsage(storeId, a, sign) {
  const key = a.customerKey;
  for (const x of a.bookPromo?.applied || []) {
    await db.doc(`stores/${storeId}/promos/${x.id}`).update({ usedCount: FieldValue.increment(sign), discountTotal: FieldValue.increment(sign * (Number(x.amount) || 0)) }).catch(() => {});
    if (key) await db.doc(`stores/${storeId}/promoUses/${x.id}_${key}`).set({ n: FieldValue.increment(sign), at: Date.now() }, { merge: true }).catch(() => {});
  }
}

// ===== Tip after the session (customer sends by GCash/Maya; reception confirms) =====
exports.apptTip = onCall(async (req) => {
  const { uid } = requireAuth(req); const d = req.data || {};
  const storeId = String(d.storeId || ""); const a = await loadOwnOrder(storeId, String(d.id || ""), uid, "appt");
  if (!["completed", "in_progress"].includes(a.status)) throw new HttpsError("failed-precondition", "You can leave a tip once your service has started.");
  if (a.tipOnline && a.tipOnline.status !== "rejected") throw new HttpsError("already-exists", "You already sent a tip — thank you!");
  const amount = Math.round(Number(d.amount) || 0); if (amount < 10 || amount > 10000) throw new HttpsError("invalid-argument", "Tip amount: ₱10 to ₱10,000.");
  const store = (await db.doc(`stores/${storeId}`).get()).data() || {};
  const m = (store.settings?.payments?.methods || []).find((x) => x.id === String(d.methodId || "") && x.enabled !== false && x.type !== "cash");
  if (!m) throw new HttpsError("invalid-argument", "Choose how you sent the tip.");
  const refNo = String(d.refNo || "").replace(/\s+/g, " ").trim().slice(0, 40); if (refNo.replace(/\D/g, "").length < 6) throw new HttpsError("invalid-argument", "Enter the reference number from your GCash / Maya receipt.");
  await db.doc(`stores/${storeId}/appointments/${a.id}`).update({ tipOnline: { amount, methodId: m.id, methodName: m.name || m.type, refNo, status: "to_verify", at: Date.now(), note: String(d.note || "").slice(0, 120) }, updatedAt: FieldValue.serverTimestamp() });
  notifyTelegram(storeId, "payment", `💝 Tip ₱${amount} for ${a.providerName || "staff"} from ${a.customer?.name || "a client"} · ${m.name || m.type} ref ${refNo} — please check and confirm at Reception.`);
  sendPush(storeId, { roles: ["crew"], staffIds: a.providerId ? [a.providerId] : [] }, { title: `💝 Tip ₱${amount}`, body: `${a.customer?.name || "A client"} sent a tip for ${a.providerName || "staff"} — to verify`, url: "/counter/", tag: "tip-" + a.id });
  return { ok: true };
});
/** owner: mark a staff member's pay for a period as paid (on-call payout / payroll) */
// ===== Staff ledger & self-remittance (owners away from the shop; on-call staff who collect payment) =====
// + collect  : money the staff took from the client (cash / GCash to their own account)  → they owe the shop
// − earn     : commission per done service, basic + allowance per duty day                → the shop owes them
// − remit    : remittance the staff sent (GCash / bank / cash), counted once the owner confirms
// + payout   : pay the owner gave the staff
// balance > 0 → staff must remit · balance < 0 → the shop owes the staff
const commissionOf = (a) => round2((a.items || []).reduce((sum, l) => { const p = l.staffPay; if (!p) return sum; const q = Number(l.qty) || 1; return sum + (p.type === "percent" ? (Number(l.price) || 0) * q * (Number(p.value) || 0) / 100 : (Number(p.value) || 0) * q); }, 0));
async function ledgerAdd(storeId, id, e) { await db.doc(`stores/${storeId}/staffLedger/${id}`).set({ ...e, amount: round2(e.amount), at: e.at || Date.now() }, { merge: true }); }
const ledgerSign = (e) => (e.type === "collect" || e.type === "payout" ? 1 : e.type === "earn" || (e.type === "remit" && e.status === "confirmed") ? -1 : 0);
exports.staffRemit = onCall(async (req) => {
  await maintGuard(req);
  const who = await staffFrom(req); const d = req.data || {};
  const staffId = who.owner && d.staffId ? String(d.staffId) : who.staffId;
  if (d.action === "review") { // owner / manager confirms or rejects a remittance
    if (!(who.owner || who.roles.includes("manager"))) throw new HttpsError("permission-denied", "Only the owner or a manager can confirm.");
    const ref = db.doc(`stores/${who.storeId}/staffLedger/${String(d.id || "")}`); const e = (await ref.get()).data();
    if (!e || e.type !== "remit") throw new HttpsError("not-found", "Remittance not found.");
    await ref.update({ status: d.approve ? "confirmed" : "rejected", reviewedBy: who.name || "Owner", reviewedAt: Date.now(), reason: d.approve ? null : String(d.reason || "Not received").slice(0, 120) });
    if (e.staffId) sendPush(who.storeId, { staffIds: [e.staffId] }, { title: d.approve ? "✅ Remittance confirmed" : "❌ Remittance not received", body: `₱${e.amount} · ${e.method}${d.approve ? "" : " — " + (d.reason || "please check")}`, url: "/staff/", tag: "remit-" + ref.id });
    return { ok: true };
  }
  if (d.action === "collect") { // on-call staff collected the payment themselves
    const store = (await db.doc(`stores/${who.storeId}`).get()).data() || {};
    if (!store.settings?.salon?.remit?.enabled) throw new HttpsError("failed-precondition", "Self-collect is off — the counter takes payments.");
    const ref = db.doc(`stores/${who.storeId}/appointments/${String(d.apptId || "")}`); const a = (await ref.get()).data();
    if (!a || (a.providerId !== who.staffId && !who.owner)) throw new HttpsError("permission-denied", "Not your client.");
    if (a.paid) throw new HttpsError("failed-precondition", "Already paid.");
    const method = ["cash", "gcash", "maya", "bank"].includes(d.method) ? d.method : "cash";
    await ref.update({ paid: true, paymentMethod: method, paymentMethodId: method, paidAt: FieldValue.serverTimestamp(), cashCollectedBy: who.name, collectedById: who.staffId, ...(a.status === "in_progress" ? { status: "done", doneAt: FieldValue.serverTimestamp() } : {}), updatedAt: FieldValue.serverTimestamp() });
    return { ok: true };
  }
  if (d.action === "payout") { // owner pays the staff (salary / commission)
    if (!(who.owner || who.roles.includes("manager"))) throw new HttpsError("permission-denied", "Owner only.");
    const amt = Math.max(0, Number(d.amount) || 0); if (!amt || !d.staffId) throw new HttpsError("invalid-argument", "Enter an amount.");
    const st = (await db.doc(`stores/${who.storeId}/staff/${String(d.staffId)}`).get()).data() || {};
    await ledgerAdd(who.storeId, `payout_${Date.now()}`, { staffId: String(d.staffId), staffName: st.name || "", type: "payout", amount: amt, method: String(d.method || "cash").slice(0, 20), refNo: String(d.refNo || "").slice(0, 60), label: `Paid by ${who.name || "owner"}`, by: who.name || "Owner" });
    return { ok: true };
  }
  // staff sends a remittance
  const amount = round2(Math.max(0, Number(d.amount) || 0)); if (!amount) throw new HttpsError("invalid-argument", "Enter the amount you sent.");
  const method = ["gcash", "maya", "bank", "cash"].includes(d.method) ? d.method : "gcash";
  const refNo = String(d.refNo || "").trim().slice(0, 60);
  if (method !== "cash" && refNo.length < 4 && !d.proofUrl) throw new HttpsError("invalid-argument", "Enter the reference number (or attach the screenshot).");
  const proof = d.proofUrl ? String(d.proofUrl) : null; if (proof && !proof.startsWith(`priv:stores/${who.storeId}/private/`)) throw new HttpsError("invalid-argument", "Bad photo.");
  const id = `remit_${Date.now()}_${staffId}`;
  await ledgerAdd(who.storeId, id, { staffId, staffName: who.name || "", type: "remit", status: "pending", amount, method, refNo, proofUrl: proof, note: String(d.note || "").slice(0, 120), label: `Remittance · ${method.toUpperCase()}${refNo ? " " + refNo : ""}` });
  notifyTelegram(who.storeId, "incident", `💸 Remittance from ${who.name || "staff"}: ₱${amount} via ${method.toUpperCase()}${refNo ? ` ref ${refNo}` : ""} — confirm it in Reports → Staff balances.`, { force: true });
  sendPush(who.storeId, { roles: ["manager"] }, { title: "💸 New remittance to confirm", body: `${who.name || "Staff"} · ₱${amount} · ${method.toUpperCase()}`, url: "/app/#reports", tag: "remit-" + id });
  return { ok: true, id };
});
exports.recordPayout = onCall(async (req) => {
  const who = await staffFrom(req); if (!(who.owner || who.roles.includes("manager"))) throw new HttpsError("permission-denied", "Only the owner or a manager can record payouts.");
  const d = req.data || {}; const staffId = String(d.staffId || ""); const period = String(d.period || "").slice(0, 40);
  if (!staffId || !period) throw new HttpsError("invalid-argument", "Missing staff or period.");
  const id = `${staffId}_${period.replace(/[^\w-]+/g, "_")}`; const ref = db.doc(`stores/${who.storeId}/payouts/${id}`);
  if (d.undo) { await ref.delete(); return { ok: true }; }
  const amount = Math.max(0, Math.round((Number(d.amount) || 0) * 100) / 100);
  await ref.set({ staffId, staffName: String(d.staffName || "").slice(0, 60), period, amount, note: String(d.note || "").slice(0, 120), paidAt: Date.now(), by: who.name || "Owner" });
  return { ok: true, id };
});

// ===== Massage intake (pressure, areas to avoid, health) =====
const INTAKE = {
  pressure: ["light", "medium", "firm", "hard"],
  areas: ["head", "neck", "shoulders", "upper_back", "lower_back", "arms", "hands", "chest", "stomach", "hips", "legs", "knees", "feet"],
  health: ["pregnant", "high_blood", "recent_surgery", "injury", "skin_allergy", "varicose", "heart", "diabetes", "fever"],
  oil: ["unscented", "lavender", "eucalyptus", "coconut", "no_oil"],
};
function cleanIntake(x) {
  if (!x || typeof x !== "object") return null;
  const pick = (arr, list) => [...new Set((Array.isArray(arr) ? arr : []).map(String).filter((v) => list.includes(v)))];
  const out = {
    pressure: INTAKE.pressure.includes(x.pressure) ? x.pressure : null,
    avoid: pick(x.avoid, INTAKE.areas), avoidNote: String(x.avoidNote || "").trim().slice(0, 160), focusNote: String(x.focusNote || "").trim().slice(0, 120),
    focus: pick(x.focus, INTAKE.areas),
    health: pick(x.health, INTAKE.health), healthNote: String(x.healthNote || "").trim().slice(0, 200),
    oil: INTAKE.oil.includes(x.oil) ? x.oil : null,
    quiet: !!x.quiet, firstTime: !!x.firstTime,
  };
  out.flag = !!(out.health.length || out.avoid.length || out.avoidNote || out.healthNote);
  const empty = !out.pressure && !out.focus.length && !out.focusNote && !out.oil && !out.quiet && !out.firstTime && !out.flag;
  return empty ? null : out;
}

// ===== Push notifications to staff phones (installed app / browser) =====
const PUSH = require("./push.js").makePush(db);
exports.pushKey = onCall(async () => ({ publicKey: (await PUSH.keys()).publicKey }));
exports.pushSubscribe = onCall(async (req) => {
  const who = await staffFrom(req); const d = req.data || {}; const sub = d.sub || {};
  if (!/^https:\/\/[^\s]+$/.test(String(sub.endpoint || "")) || String(sub.endpoint).length > 900 || !sub.keys?.p256dh || !sub.keys?.auth) throw new HttpsError("invalid-argument", "This phone can't receive notifications.");
  const id = crypto.createHash("sha256").update(sub.endpoint).digest("hex").slice(0, 40);
  const ref = db.doc(`stores/${who.storeId}/pushSubs/${id}`);
  if (d.off) { await ref.delete(); return { ok: true }; }
  const rec = { staffId: who.staffId, name: who.name || "", roles: who.roles || [], app: String(d.app || "").slice(0, 20), endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh).slice(0, 200), auth: String(sub.keys.auth).slice(0, 60) }, at: FieldValue.serverTimestamp() };
  await ref.set(rec);
  if (d.test) await PUSH.sendOne(rec, { title: "🔔 Notifications are on", body: "You'll get new jobs and alerts here even when the app is closed.", url: "/" + (rec.app || "staff") + "/", tag: "test" });
  return { ok: true };
});
/** send to staff devices of a store: by staff ids and/or roles (managers & owner get role alerts too) */
async function sendPush(storeId, { staffIds = null, roles = null } = {}, data = {}) {
  try {
    const snap = await db.collection(`stores/${storeId}/pushSubs`).get();
    const subs = snap.docs.filter((x) => { const v = x.data(); return (staffIds && staffIds.includes(v.staffId)) || (roles && (v.roles || []).some((r) => roles.includes(r) || r === "manager")); });
    await Promise.all(subs.map(async (x) => { const r = await PUSH.sendOne(x.data(), data, { topic: data.tag, ttl: data.ttl || 900 }); if (r === "gone") await x.ref.delete().catch(() => {}); }));
  } catch (e) { logger.warn("push", e.message); }
}

// ===== Job offers: pass a client to staff (one at a time with a countdown, or first to accept) =====
const offerCfg = (cfg) => ({ enabled: !!cfg.offers?.enabled, mode: cfg.offers?.mode === "race" ? "race" : "rotate", seconds: Math.max(60, Math.min(900, Number(cfg.offers?.seconds) || 300)), auto: cfg.offers?.auto !== false });
const onCallStaff = (st) => st?.payType === "oncall";
const readyForJobs = (st, now) => !onCallStaff(st) || (Number(st.available?.until) || 0) > now;
async function offerCandidates(storeId, ctx, a, id) {
  const t = a.waiting ? Date.now() : a.startAt.toMillis(); const dateStr = new Date(t + 8 * 3600e3).toISOString().slice(0, 10);
  const dayA = (await dayAppointments(storeId, dateStr)).filter((x) => x.id !== id);
  const now = Date.now();
  return freeProviders(ctx, dayA, t, a.durationConfirmed || a.durationEst || 60, a.categories || [], { home: !!a.homeService, gender: a.genderPref || null }).filter((st) => !st.planLocked && readyForJobs(st, now));
}
async function pushOffer(storeId, id, a, to, seconds) {
  const when = a.startAt.toDate().toLocaleString("en-PH", { timeZone: "Asia/Manila", weekday: "short", hour: "numeric", minute: "2-digit" });
  await sendPush(storeId, { staffIds: to }, { title: `📣 New job — accept within ${Math.round(seconds / 60)} min`, body: `${(a.items || []).map((l) => l.name).join(", ")} · ${when}${a.homeService ? ` · 🏠 ${a.homeService.area || a.homeService.address || "home service"}` : ""}`, url: "/staff/", tag: "offer-" + id, ttl: seconds, badge: 1 });
}
async function advanceOffer(storeId, ref, a, ctx, oc, tried, by) {
  const cands = (await offerCandidates(storeId, ctx, a, ref.id)).filter((x) => !tried.includes(x.id));
  const now = Date.now(); const prev = a.offer?.status === "open" ? a.offer : null;
  if (!cands.length) {
    await ref.update({ offer: { ...(a.offer || {}), status: "none", tried, to: [], endedAt: now }, offerTo: [], offerOpen: false, updatedAt: FieldValue.serverTimestamp() });
    if (!a.test) notifyTelegram(storeId, "reservation", `📣 No staff accepted ${a.customer?.name || "a client"}'s booking (${a.code}) — please assign at Reception.`);
    sendPush(storeId, { roles: ["crew"] }, { title: "📣 No one accepted a job", body: `${a.customer?.name || "A client"} (${a.code}) needs a staff — assign at Reception.`, url: "/counter/", tag: "nooffer-" + ref.id });
    return { status: "none" };
  }
  const to = oc.mode === "race" ? cands.slice(0, 15).map((x) => x.id) : [cands[0].id];
  const offer = { status: "open", mode: oc.mode, seconds: oc.seconds, to, toNames: to.map((x) => cands.find((c) => c.id === x)?.name || ""), tried, expiresAt: now + oc.seconds * 1000, startedAt: prev?.startedAt || now, round: (prev?.round || 0) + 1, by };
  await ref.update({ offer, offerTo: to, offerOpen: true, updatedAt: FieldValue.serverTimestamp() });
  pushOffer(storeId, ref.id, a, to, oc.seconds);
  return { status: "open", to };
}
async function startOffer(storeId, id, by, skip = []) {
  const ref = db.doc(`stores/${storeId}/appointments/${id}`); const a = (await ref.get()).data();
  if (!a || !APPT_ACTIVE.includes(a.status)) return { status: "closed" };
  const ctx = await salonContext(storeId);
  return advanceOffer(storeId, ref, { ...a, offer: null }, ctx, offerCfg(ctx.cfg), skip, by);
}
/** time ran out: count a miss (on-call staff become unavailable), then the next staff / close */
async function expireOffer(storeId, ref, a) {
  const o = a.offer; if (!o || o.status !== "open" || Date.now() < o.expiresAt) return { status: o?.status || "closed" };
  const miss = o.to || [];
  // claim the expiry once (two callers at the same time)
  const claimed = await db.runTransaction(async (tx) => { const cur = (await tx.get(ref)).data(); if (cur?.offer?.status !== "open" || cur.offer.expiresAt !== o.expiresAt) return false; tx.update(ref, { "offer.status": "moving" }); return true; });
  if (!claimed) return { status: "busy" };
  for (const sid of miss) {
    const sref = db.doc(`stores/${storeId}/staff/${sid}`); const st = (await sref.get()).data(); if (!st) continue;
    await sref.update({ missedJobs: FieldValue.increment(1), lastMissedAt: Date.now(), ...(onCallStaff(st) ? { available: null } : {}) });
  }
  const ctx = await salonContext(storeId);
  if (!APPT_ACTIVE.includes(a.status) || a.providerId) { await ref.update({ "offer.status": "cancelled", offerTo: [], offerOpen: false }); return { status: "cancelled" }; }
  return advanceOffer(storeId, ref, { ...a, offer: { ...o, status: "open" } }, ctx, offerCfg(ctx.cfg), [...(o.tried || []), ...miss], o.by);
}
exports.apptOffer = onCall(async (req) => {
  const who = await staffFrom(req); const { storeId } = who; const d = req.data || {};
  const ref = db.doc(`stores/${storeId}/appointments/${String(d.id || "")}`); const a = (await ref.get()).data();
  if (!a) throw new HttpsError("not-found", "Booking not found.");
  if (d.action === "start") {
    if (!hasRole(who, "crew")) throw new HttpsError("permission-denied", "Only the counter or a manager can pass a client.");
    if (!APPT_ACTIVE.includes(a.status) || a.status === "in_progress") throw new HttpsError("failed-precondition", "This booking can't be passed now.");
    if (a.providerId) await ref.update({ providerId: null, providerName: null, acceptedAt: null });
    return startOffer(storeId, ref.id, who.name || "counter", a.providerId ? [a.providerId] : []);
  }
  if (d.action === "cancel") {
    if (!hasRole(who, "crew")) throw new HttpsError("permission-denied", "Only the counter or a manager can stop this.");
    await ref.update({ "offer.status": "cancelled", offerTo: [], offerOpen: false, updatedAt: FieldValue.serverTimestamp() });
    return { ok: true };
  }
  if (d.action === "check") return expireOffer(storeId, ref, a);
  if (d.action === "accept") {
    const o = a.offer || {};
    if (o.status !== "open") throw new HttpsError("failed-precondition", "This job was already taken or closed.");
    if (!(o.to || []).includes(who.staffId)) throw new HttpsError("failed-precondition", "This job is no longer offered to you.");
    if (Date.now() > o.expiresAt + 15000) throw new HttpsError("deadline-exceeded", "Too late — the time to accept ran out.");
    const ctx = await salonContext(storeId);
    if (!(await offerCandidates(storeId, ctx, a, ref.id)).some((x) => x.id === who.staffId)) throw new HttpsError("failed-precondition", "You already have a client at that time.");
    const me = ctx.stylists.find((x) => x.id === who.staffId);
    await db.runTransaction(async (tx) => {
      const cur = (await tx.get(ref)).data();
      if (cur?.offer?.status !== "open" || !(cur.offer.to || []).includes(who.staffId) || cur.providerId) throw new HttpsError("failed-precondition", "Someone else accepted this job first.");
      tx.update(ref, { ...(cur.waiting ? { waiting: false, startAt: Timestamp.fromMillis(Date.now()), queueCalled: { at: Date.now(), by: me?.name || who.name, auto: true }, queue: null } : {}), providerId: who.staffId, providerName: me?.name || who.name, acceptedAt: FieldValue.serverTimestamp(), assignedBy: "offer", assignedAt: FieldValue.serverTimestamp(), status: cur.status === "pending" ? "confirmed" : cur.status, "offer.status": "accepted", "offer.acceptedBy": who.staffId, "offer.acceptedName": me?.name || who.name, "offer.acceptedAt": Date.now(), offerTo: [], offerOpen: false, updatedAt: FieldValue.serverTimestamp() });
    });
    await db.doc(`stores/${storeId}/staff/${who.staffId}`).update({ lastAssignedAt: FieldValue.serverTimestamp(), acceptedJobs: FieldValue.increment(1) }).catch(() => {});
    return { ok: true };
  }
  if (d.action === "decline") {
    const o = a.offer || {};
    if (o.status !== "open" || !(o.to || []).includes(who.staffId)) return { ok: true };
    if (o.mode === "race" && o.to.length > 1) { await ref.update({ "offer.to": FieldValue.arrayRemove(who.staffId), offerTo: FieldValue.arrayRemove(who.staffId), "offer.tried": FieldValue.arrayUnion(who.staffId) }); return { ok: true }; }
    const ctx = await salonContext(storeId);
    return advanceOffer(storeId, ref, a, ctx, offerCfg(ctx.cfg), [...(o.tried || []), who.staffId], o.by);
  }
  throw new HttpsError("invalid-argument", "Unknown action.");
});
exports.offerTick = onSchedule({ schedule: "every 1 minutes", timeZone: "Asia/Manila" }, async () => {
  const snap = await db.collectionGroup("appointments").where("offerOpen", "==", true).get();
  for (const x of snap.docs) { const a = x.data(); if (a.offer?.expiresAt <= Date.now()) await expireOffer(x.ref.parent.parent.id, x.ref, a).catch((e) => logger.warn("offerTick", e.message)); }
});
/** staff: "Available for jobs until …" (on-call staff); off when they miss a job */
exports.staffAvailability = onCall(async (req) => {
  const who = await staffFrom(req); if (who.owner) throw new HttpsError("failed-precondition", "Log in with your own staff PIN.");
  const until = req.data?.until ? Number(req.data.until) : null; const now = Date.now();
  if (until && (until < now + 5 * 60000 || until > now + 18 * 3600e3)) throw new HttpsError("invalid-argument", "Pick a time later today (up to 18 hours from now).");
  await db.doc(`stores/${who.storeId}/staff/${who.staffId}`).update({ available: until ? { until, at: now } : null, ...(until ? { wentHome: null } : {}) });
  return { ok: true, until };
});

// therapist safety: a home service still not "done" 20 min after it should have ended → alert the owner (once)
exports.homeSafetyTick = onSchedule({ schedule: "every 15 minutes", timeZone: "Asia/Manila" }, async () => {
  const snap = await db.collectionGroup("appointments").where("status", "==", "in_progress").get();
  const now = Date.now();
  for (const x of snap.docs) {
    const a = x.data(); if (!a.homeService || a.test) continue;
    // safety check-in: no "I'm safe" 45 min after start → remind the staff; still none at 75 min → tell the shop
    const st0 = a.startAt.toMillis(), safeAt = a.safety?.at || 0;
    if (safeAt < st0 && !a.checkinNudgeAt && now > st0 + 45 * 60000) {
      await x.ref.update({ checkinNudgeAt: now });
      if (a.providerId) sendPush(x.ref.parent.parent.id, { staffIds: [a.providerId] }, { title: "✅ Safety check-in", body: `Tap "I'm safe" for ${a.customer?.name || "your client"} — the shop is waiting.`, url: "/staff/", tag: "chk-" + x.id, urgent: true });
    } else if (safeAt < st0 && a.checkinNudgeAt && !a.checkinAlertAt && now > st0 + 75 * 60000) {
      await x.ref.update({ checkinAlertAt: now });
      sendPush(x.ref.parent.parent.id, { roles: ["crew"] }, { title: "⚠️ No safety check-in", body: `${a.providerName || "Staff"} hasn't checked in at ${a.customer?.name || "a client"}'s. Please call them.`, url: "/counter/", tag: "chk2-" + x.id, urgent: true });
    }
    if (a.overdueAlertAt) continue;
    const end = a.startAt.toMillis() + (a.durationConfirmed || a.durationEst || 60) * 60000;
    if (now < end + 20 * 60000) continue;
    const storeId = x.ref.parent.parent.id;
    await x.ref.update({ overdueAlertAt: now, overdueOpen: true });
    sendPush(storeId, { roles: ["crew"] }, { title: "⏰ Home service running late", body: `${a.providerName || "Staff"} is still at ${a.customer?.name || "a client"}'s — please call them.`, url: "/counter/", tag: "late-" + x.id });
    notifyTelegram(storeId, "incident", `⏰ ${a.providerName || "Your therapist"} is still at ${a.customer?.name || "a client"}'s (${a.homeService.address || ""}) — ${Math.round((now - end) / 60000)} min past the expected end. Please check on them.`, { force: true });
  }
});
exports.onApptWrite = onDocumentWritten("stores/{storeId}/appointments/{id}", async (event) => {
  const b = event.data?.before?.data(), a = event.data?.after?.data();
  // staff ledger: commission when done · collected payment when the staff took it
  if (a && !a.test && a.providerId) {
    const sid = event.params.storeId;
    if (a.status === "done" && b?.status !== "done") { const st = (await db.doc(`stores/${sid}/staff/${a.providerId}`).get()).data() || {}; const c = st.salary?.commission === false ? 0 : commissionOf(a); if (c > 0) await ledgerAdd(sid, `earn_${event.params.id}`, { staffId: a.providerId, staffName: a.providerName || st.name || "", type: "earn", amount: c, label: `Commission · ${(a.items || []).map((l) => l.name).join(", ").slice(0, 60)}`, apptId: event.params.id }); }
    if (b?.status === "done" && a.status !== "done") await db.doc(`stores/${sid}/staffLedger/earn_${event.params.id}`).delete().catch(() => {});
    const collector = a.collectedById || null;
    if (a.paid && collector && !(b?.paid && b.collectedById)) await ledgerAdd(sid, `collect_${event.params.id}`, { staffId: collector, staffName: a.cashCollectedBy || a.providerName || "", type: "collect", amount: round2(a.amountDue ?? (a.total || 0) + (a.homeFee || 0)), method: a.paymentMethod || "cash", label: `Collected from ${a.customer?.name || "client"} · ${(a.paymentMethod || "cash").toUpperCase()}`, apptId: event.params.id });
    if (b?.paid && !a.paid) await db.doc(`stores/${sid}/staffLedger/collect_${event.params.id}`).delete().catch(() => {});
  }
  // new home booking with rider drop-off & pick-up → a trip (auto-assigned when the shop has one rider)
  if (a && !b && a.homeService && !a.escort) {
    const st = (await db.doc(`stores/${event.params.storeId}`).get()).data();
    if (await escortOn(event.params.storeId, st)) {
      const riders = (await db.collection(`stores/${event.params.storeId}/staff`).where("active", "==", true).get()).docs.filter((x) => (x.data().roles || []).includes("rider") && !x.data().planLocked);
      const one = riders.length === 1 ? riders[0] : null;
      await event.data.after.ref.update({ escort: { riderId: one?.id || null, riderName: one?.data().name || null, status: one ? "assigned" : "unassigned", history: [] } });
    }
  }
  if (a && b && (a.helpOpen || a.overdueOpen) && ["done", "cancelled", "no_show"].includes(a.status) && a.status !== b.status) await event.data.after.ref.update({ helpOpen: false, overdueOpen: false });
  // therapist finished a home service → the rider is asked to pick them up
  if (a && b && a.escort && a.status === "done" && b.status !== "done" && ["assigned", "to_client", "dropped"].includes(a.escort.status)) {
    const s2 = a.goHome ? "released" : "pickup_requested";
    await event.data.after.ref.update({ "escort.status": s2, "escort.history": FieldValue.arrayUnion({ s: s2, at: Date.now(), by: "auto" }) });
    if (!a.goHome && a.escort.riderId) sendPush(event.params.storeId, { staffIds: [a.escort.riderId] }, { title: "🛵 Pickup now", body: `${a.providerName || "Staff"} is done at ${a.homeService?.address || "the client"}`, url: "/rider/", tag: "pickup-" + event.params.id });
  }
  // on-call staff going straight home → off for the rest of the day, not offered new jobs
  if (a && b && a.goHome && a.providerId && a.status === "done" && b.status !== "done") {
    const now = Date.now();
    await db.doc(`stores/${event.params.storeId}/staff/${a.providerId}`).update({ wentHome: { date: new Date(now + 8 * 3600e3).toISOString().slice(0, 10), at: now }, available: null }).catch(() => {});
  }
  if ((a?.waiting || b?.waiting) && (!a || !b || a.status !== b.status || !!a.waiting !== !!b.waiting || a.qpos !== b.qpos || a.providerId !== b.providerId) && (a || b).startAt) await refreshQueue(event.params.storeId).catch((e) => logger.warn("queue", e.message));
  if (a && b && a.status === "in_progress" && a.durationConfirmed !== b.durationConfirmed) { const w = await db.collection(`stores/${event.params.storeId}/appointments`).where("waiting", "==", true).limit(1).get(); if (!w.empty) await refreshQueue(event.params.storeId).catch(() => {}); }
  // a staff member finished → the line moves (recompute when someone is waiting)
  if (a && b && b.status !== a.status && ["done", "cancelled", "no_show"].includes(a.status) && !a.waiting) { const w = await db.collection(`stores/${event.params.storeId}/appointments`).where("waiting", "==", true).limit(1).get(); if (!w.empty) await refreshQueue(event.params.storeId).catch(() => {}); }
  if (a && !b && a.bookPromo?.applied?.length && !a.test) await promoUsage(event.params.storeId, a, 1);
  if (a && b && a.bookPromo?.applied?.length && !a.test && ["cancelled", "expired", "declined"].includes(a.status) && !["cancelled", "expired", "declined"].includes(b.status)) await promoUsage(event.params.storeId, a, -1);
  // new booking with "any available" → offer it to the staff (rotation / first to accept)
  if (a && !b && !a.providerId && !a.waiting && APPT_ACTIVE.includes(a.status) && !a.groupId) {
    const st = (await db.doc(`stores/${event.params.storeId}`).get()).data();
    const oc = offerCfg(st?.settings?.salon || {});
    if (oc.enabled && oc.auto) await startOffer(event.params.storeId, event.params.id, "auto").catch((e) => logger.warn("offer", e.message));
  }
  if (a && !b && !a.test && a.source === "customer") sendPush(event.params.storeId, { roles: ["crew"] }, { title: "📅 New booking", body: `${a.customer?.name || "A client"} · ${(a.items || []).map((l) => l.name).join(", ")} · ${a.startAt?.toDate?.().toLocaleString("en-PH", { timeZone: "Asia/Manila", weekday: "short", hour: "numeric", minute: "2-digit" }) || ""}`, url: "/counter/", tag: "appt-" + event.params.id });
  if (!a || !b || a.test || a.status === b.status) return;
  const storeId = event.params.storeId;
  // home service finished → the shop status set automatically goes back to "in"
  if (a.homeService && ["done", "cancelled", "no_show"].includes(a.status)) {
    const st = (await db.doc(`stores/${storeId}`).get()).data();
    const p = st?.salonLive?.presence;
    if (p?.auto && p.apptId === event.params.id) await db.doc(`stores/${storeId}`).update({ "salonLive.presence": { state: "in", backAt: null, waitNote: "", at: Date.now(), by: "auto", until: p.until || null }, updatedAt: FieldValue.serverTimestamp() });
  }
  if (!a.customerKey) return;
  const ref = db.doc(`stores/${storeId}/customers/${a.customerKey}`);
  if (a.status === "done") await ref.set({ completed: FieldValue.increment(1), lastCompletedAt: FieldValue.serverTimestamp() }, { merge: true });
  if (["cancelled", "no_show"].includes(a.status)) {
    const nd = (await ref.get()).data()?.nextDue;
    if (nd?.status === "booked" && nd.bookedApptId === event.params.id) await ref.update({ "nextDue.status": "due", "nextDue.bookedApptId": null, ...(nd.smsAt || nd.contactedAt ? { rebookReturnCount: FieldValue.increment(-1) } : {}) });
  }
  const into = a.status === "no_show" && b.status !== "no_show", outOf = b.status === "no_show" && a.status !== "no_show";
  if (!into && !outOf) return;
  await ref.set({ noShows: FieldValue.increment(into ? 1 : -1), ...(into ? { lastNoShowAt: FieldValue.serverTimestamp() } : {}) }, { merge: true });
  if (a.dp && ["verified", "to_verify", "forfeited"].includes(a.dp.status)) await event.data.after.ref.update({ "dp.status": into ? "forfeited" : "verified" }).catch(() => {});
  if (!into) return;
  const c = (await ref.get()).data() || {};
  const ns = (await db.doc(`stores/${storeId}`).get()).data()?.settings?.salon?.noShow || {};
  const blockAfter = Number(ns.blockAfter ?? 3), dpAfter = Number(ns.dpAfter ?? 2);
  if (blockAfter > 0 && (c.noShows || 0) >= blockAfter && !c.flagged) { await ref.update({ flagged: true, flagReason: `${c.noShows} no-shows` }); notifyTelegram(storeId, "reservation", `🚫 ${c.name || a.customer?.name} (${c.phone}) blocked after ${c.noShows} no-shows.`); }
  else if (dpAfter > 0 && (c.noShows || 0) >= dpAfter && !c.dpRequired) await ref.update({ dpRequired: true });
});
// SMS reminders (Semaphore): day before (~6 PM), 2 hours before, and "time for your retouch" rebook reminders
const SITE = `https://${process.env.GCLOUD_PROJECT || "orderqr-62446"}.web.app`;
const phHM = (ms) => new Date(ms).toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit" });
async function salonSmsCtx(storeId, cache) {
  if (cache.has(storeId)) return cache.get(storeId);
  let v = null;
  try {
    const store = (await db.doc(`stores/${storeId}`).get()).data();
    const cfg = store?.settings?.salon || {};
    if (store?.mode === "salon" && (cfg.reminders?.dayBefore || cfg.reminders?.hoursBefore || cfg.rebook?.enabled) && (await storeEntitled(storeId, "sms")) && (await storeEntitled(storeId, "salonremind"))) {
      const key = (await db.doc(`stores/${storeId}/private/semaphore`).get()).data()?.apiKey;
      if (key && !inQuiet(store.settings?.sms)) v = { store, cfg, key, sender: store.settings?.sms?.senderName || "" };
    }
  } catch (e) { logger.warn("salonSmsCtx", e.message); }
  cache.set(storeId, v); return v;
}
exports.salonRemindersTick = onSchedule({ schedule: "every 15 minutes", timeZone: "Asia/Manila", timeoutSeconds: 300 }, async () => {
  const now = Date.now(); const cache = new Map();
  const phNow = new Date(now + 8 * 3600e3); const hour = phNow.getUTCHours();
  const tomorrow = new Date(now + 8 * 3600e3 + 86400e3).toISOString().slice(0, 10);
  const snap = await db.collectionGroup("appointments").where("startAt", ">=", Timestamp.fromMillis(now)).where("startAt", "<=", Timestamp.fromMillis(now + 36 * 3600e3)).get();
  for (const d of snap.docs) {
    const a = d.data(); if (a.test || !["pending", "confirmed"].includes(a.status) || (a.groupPart || 1) > 1) continue;
    if (a.tentative && a.visitConfirm?.status !== "yes") continue; // next visits are confirmed by the owner (manual contact)
    const num = phPhone(a.customer?.phone); if (!num) continue;
    const sc = await salonSmsCtx(d.ref.parent.parent.id, cache); if (!sc) continue;
    const st = a.startAt.toMillis(); const day = new Date(st + 8 * 3600e3).toISOString().slice(0, 10);
    const what = (a.items || []).map((l) => l.name).join(", ").slice(0, 60);
    const link = `${SITE}/m/${sc.store.slug}`;
    let msg = null, flag = null;
    if (sc.cfg.reminders?.dayBefore && !a.remDay && day === tomorrow && hour >= 18) { msg = `Hi ${(a.customer?.name || "").split(" ")[0]}! Reminder from ${sc.store.name}: ${what} tomorrow ${phHM(st)}${a.providerName ? ` with ${a.providerName}` : ""} (${a.code}). To change, open ${link}`; flag = "remDay"; }
    else if (sc.cfg.reminders?.hoursBefore && !a.rem2h && st - now <= 2 * 3600e3) { msg = `Hi ${(a.customer?.name || "").split(" ")[0]}! See you at ${phHM(st)} today at ${sc.store.name} (${a.code}). Please arrive 5 minutes early.`; flag = "rem2h"; }
    if (!msg) continue;
    try { await semSend(sc.key, [num], msg.slice(0, 300), sc.sender); await d.ref.update({ [flag]: Date.now() }); }
    catch (e) { await d.ref.update({ [flag]: -1 }).catch(() => {}); logger.warn("salon reminder", e.message); }
  }
  // rebook reminders (from each client's "next due" date): once, between 10 AM and 6 PM
  if (hour < 10 || hour >= 18) return;
  // birthday month treats: a single-use voucher, texted once a year (and listed for the counter)
  const month = phNow.getUTCMonth() + 1, year = phNow.getUTCFullYear();
  const bdays = await db.collectionGroup("customers").where("birthMonth", "==", month).get();
  const bcache = new Map();
  for (const d of bdays.docs) {
    const c = d.data(); if (c.birthdayYear === year || c.flagged) continue;
    const storeId = d.ref.parent.parent.id;
    if (!bcache.has(storeId)) { const st = (await db.doc(`stores/${storeId}`).get()).data(); bcache.set(storeId, st?.mode === "salon" && st.settings?.salon?.birthday?.enabled && (await storeEntitled(storeId, "birthday")) ? st : null); }
    const st = bcache.get(storeId); if (!st) continue;
    const b = st.settings.salon.birthday; const code = `BDAY-${rnd(5)}`;
    const endOfMonth = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
    await db.doc(`stores/${storeId}/vouchers/${code}`).set({ code, type: b.type === "percent" ? "percent" : "amount", value: Number(b.value) || 100, ...(b.type === "percent" && b.maxDiscount ? { maxDiscount: Number(b.maxDiscount) } : {}), minOrder: Number(b.minOrder) || 0, maxUses: 1, perCustomer: 1, validTo: endOfMonth, services: [], label: `Birthday treat · ${c.name || ""}`, active: true, usedCount: 0, usedBy: {}, birthdayOf: d.id, createdAt: FieldValue.serverTimestamp() });
    const off = b.type === "percent" ? `${b.value}% off` : `₱${b.value} off`;
    const sent = await smsTo(storeId, c.phone, `Happy birthday month, ${(c.name || "").split(" ")[0] || "dear"}! 🎂 Enjoy ${off} at ${st.name} until ${new Date(`${endOfMonth}T12:00:00+08:00`).toLocaleDateString("en-PH", { month: "short", day: "numeric" })}. Code ${code}. Book: ${SITE}/m/${st.slug}`);
    await d.ref.update({ birthdayYear: year, birthdayVoucher: { code, off, validTo: endOfMonth, smsSent: sent, at: Date.now() } });
    await clientLog(storeId, d.id, "birthday", `Birthday voucher ${code} (${off})${sent ? " · SMS sent" : " · send it manually"}`);
  }
  // membership ends in 3 days → text once
  const soonM = await db.collectionGroup("memberships").where("expires", ">", now).where("expires", "<", now + 3 * 86400e3).get();
  for (const d of soonM.docs) {
    const m = d.data(); if (m.remindedAt) continue;
    const cRef = d.ref.parent.parent; const storeId = cRef.parent.parent.id;
    const c = (await cRef.get()).data(); const st = (await db.doc(`stores/${storeId}`).get()).data();
    const sent = await smsTo(storeId, c?.phone, `Hi ${(c?.name || "").split(" ")[0]}! Your ${m.name} membership at ${st?.name} ends on ${new Date(m.expires).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric" })}. Renew at your next visit to keep your perks.`);
    await d.ref.update({ remindedAt: Date.now(), remindSms: sent });
  }
  const due = await db.collectionGroup("customers").where("nextDue.at", "<=", now).get();
  for (const d of due.docs) {
    const c = d.data(); const nd = c.nextDue;
    if (!nd || nd.status !== "due" || nd.smsAt || c.flagged) continue;
    const storeId = d.ref.parent.parent.id; const sc = await salonSmsCtx(storeId, cache);
    if (!sc?.cfg.rebook?.enabled) continue;
    const num = phPhone(c.phone); if (!num) continue;
    const future = await db.collection(`stores/${storeId}/appointments`).where("customerKey", "==", d.id).where("status", "in", APPT_ACTIVE).limit(1).get();
    if (!future.empty) { await d.ref.update({ "nextDue.status": "booked", "nextDue.bookedApptId": future.docs[0].id }); continue; }
    try {
      await semSend(sc.key, [num], `Hi ${(c.name || "").split(" ")[0]}! It's time for your next ${nd.service || "visit"} at ${sc.store.name}${nd.providerName ? ` with ${nd.providerName.split(" ")[0]}` : ""}. Book your slot: ${SITE}/m/${sc.store.slug}`.slice(0, 300), sc.sender);
      await d.ref.update({ "nextDue.smsAt": Date.now(), rebookSmsCount: FieldValue.increment(1) });
    } catch (e) { logger.warn("rebook sms", e.message); await d.ref.update({ "nextDue.smsAt": -1 }).catch(() => {}); }
  }
});
// ---------------------------------------------------------------------------
// SALON extras: check-in, slot waitlist, gift cards, memberships, referral, birthday, client log, portfolio, cash advances, daily summary
// ---------------------------------------------------------------------------
const rnd = (n) => Array.from({ length: n }, () => CLAIM_ALPHABET[Math.floor(Math.random() * CLAIM_ALPHABET.length)]).join("");
const phYmdNow = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
/** client activity log (last entries kept on the client record, per phone number) */
async function clientLog(storeId, key, type, text) {
  if (!key) return;
  try { await db.doc(`stores/${storeId}/customers/${key}`).set({ log: FieldValue.arrayUnion({ at: Date.now(), type, text: String(text).slice(0, 160) }) }, { merge: true }); } catch (e) { logger.warn("clientLog", e.message); }
}
async function smsTo(storeId, phone, msg) {
  try {
    const num = phPhone(phone); if (!num) return false;
    if (!(await storeEntitled(storeId, "sms"))) return false;
    const store = (await db.doc(`stores/${storeId}`).get()).data();
    if (inQuiet(store?.settings?.sms)) return false;
    const key = (await db.doc(`stores/${storeId}/private/semaphore`).get()).data()?.apiKey; if (!key) return false;
    await semSend(key, [num], String(msg).slice(0, 300), store.settings?.sms?.senderName || "");
    return true;
  } catch (e) { logger.warn("smsTo", e.message); return false; }
}

// ---- check-in: "I'm here" / "running late" from the customer's status page (the counter can also tap Arrived)
exports.apptCheckIn = onCall(async (req) => {
  const { uid } = requireAuth(req);
  const d = req.data || {};
  const ref = db.doc(`stores/${String(d.storeId || "")}/appointments/${String(d.id || "")}`); const snap = await ref.get();
  if (!snap.exists || snap.data().customerUid !== uid) throw new HttpsError("permission-denied", "Not your booking.");
  const a = snap.data();
  if (!["unconfirmed", "pending", "confirmed"].includes(a.status)) throw new HttpsError("failed-precondition", "This booking is no longer active.");
  if (d.action === "late") {
    const minutes = Math.max(5, Math.min(60, parseInt(d.minutes, 10) || 10));
    await ref.update({ lateBy: { minutes, at: Date.now() }, updatedAt: FieldValue.serverTimestamp() });
    notifyTelegram(String(d.storeId), "reservation", `⏰ ${a.customer?.name} (${a.code}) is running ${minutes} min late`);
    return { ok: true };
  }
  if (a.startAt.toMillis() - Date.now() > 3 * 3600e3) throw new HttpsError("failed-precondition", "Check in when you arrive at the salon.");
  await ref.update({ arrivedAt: Date.now(), arrivedBy: "customer", updatedAt: FieldValue.serverTimestamp() });
  return { ok: true };
});

// ---- waitlist for fully booked days: "notify me if a slot opens"
exports.joinSlotWait = onCall(async (req) => {
  await maintGuard(req);
  const { uid } = requireAuth(req);
  const d = req.data || {};
  const pub = (await db.doc(`publicStores/${String(d.slug || "")}`).get()).data(); if (!pub) throw new HttpsError("not-found", "Store not found.");
  if (!pub.pro?.waitlist) throw new HttpsError("failed-precondition", "The waitlist is not available.");
  const date = String(d.date || ""); if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < phYmdNow()) throw new HttpsError("invalid-argument", "Pick a date.");
  const customer = { name: String(d.customer?.name || "").trim().slice(0, 60), phone: String(d.customer?.phone || "").trim().slice(0, 30) };
  if (customer.name.length < 2 || phoneDigits(customer.phone).length < 10) throw new HttpsError("invalid-argument", "Enter your name and mobile number so we can text you.");
  const ctx = await salonContext(pub.storeId);
  const priced = apptLines(Array.isArray(d.itemIds) ? d.itemIds : [], ctx.items);
  const key = phoneDigits(customer.phone);
  const dup = (await db.collection(`stores/${pub.storeId}/slotWaits`).where("customerKey", "==", key).get()).docs.find((x) => x.data().date === date && ["waiting", "notified"].includes(x.data().status));
  if (dup) return { id: dup.id, existing: true };
  const ref = await db.collection(`stores/${pub.storeId}/slotWaits`).add({ date, itemIds: priced.lines.map((l) => l.itemId), services: priced.lines.map((l) => l.name), providerId: d.providerId ? String(d.providerId) : null, customer, customerKey: key, uid, status: "waiting", ...(testOn(ctx.store.settings) ? { test: true } : {}), createdAt: FieldValue.serverTimestamp() });
  notifyTelegram(pub.storeId, "reservation", `📋 Waitlist ${date}: ${customer.name} ${customer.phone} · ${priced.lines.map((l) => l.name).join(", ")}`);
  return { id: ref.id };
});
async function checkSlotWaits(storeId, date) {
  if (!date || date < phYmdNow()) return;
  const waits = (await db.collection(`stores/${storeId}/slotWaits`).where("date", "==", date).get()).docs.filter((x) => x.data().status === "waiting");
  if (!waits.length) return;
  const ctx = await salonContext(storeId);
  for (const w of waits) {
    try {
      const x = w.data(); const priced = apptLines(x.itemIds, ctx.items);
      const slots = needsMulti(ctx, priced.cats, x.providerId) ? (await computeMultiSlots(storeId, ctx, date, priced.lines)).map((m) => m.t) : await computeSlots(storeId, ctx, date, priced.lines, priced.cats, priced.minutes, x.providerId);
      if (!slots.length) continue;
      const times = slots.slice(0, 3).map((t) => phHM(t)).join(", ");
      const sent = await smsTo(storeId, x.customer.phone, `Hi ${x.customer.name.split(" ")[0]}! A slot opened at ${ctx.store.name} on ${new Date(`${date}T12:00:00+08:00`).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", weekday: "short", month: "short", day: "numeric" })}: ${times}. Book fast: ${SITE}/m/${ctx.store.slug}`);
      await w.ref.update({ status: "notified", notifiedAt: Date.now(), slots: slots.slice(0, 6), smsSent: sent });
    } catch (e) { logger.warn("slotWait", e.message); }
  }
}
// a cancellation / no-show / move frees time → tell people waiting for that day
exports.onApptFreed = onDocumentWritten("stores/{storeId}/appointments/{id}", async (event) => {
  const b = event.data?.before?.data(), a = event.data?.after?.data();
  if (!b || b.test) return;
  const day = (x) => (x?.startAt?.toMillis ? new Date(x.startAt.toMillis() + 8 * 3600e3).toISOString().slice(0, 10) : null);
  const freed = (!a && APPT_ACTIVE.includes(b.status)) || (a && APPT_ACTIVE.includes(b.status) && ["cancelled", "no_show"].includes(a.status)) || (a && day(a) !== day(b) && APPT_ACTIVE.includes(a.status));
  if (freed) await checkSlotWaits(event.params.storeId, day(b));
});

// ---- gift cards (online with manual GCash/Maya payment → counter verifies; or sold at the counter)
const giftCode = () => `GC-${rnd(4)}-${rnd(4)}`;
exports.buyGiftCard = onCall(async (req) => {
  await maintGuard(req);
  const { uid } = requireAuth(req);
  const d = req.data || {};
  const pub = (await db.doc(`publicStores/${String(d.slug || "")}`).get()).data(); if (!pub) throw new HttpsError("not-found", "Store not found.");
  const gc = pub.salon?.giftcards || {};
  if (!gc.enabled || !pub.pro?.giftcards) throw new HttpsError("failed-precondition", "Gift cards are not available.");
  const amount = Math.round(Number(d.amount) || 0);
  if (amount < (Number(gc.min) || 300) || amount > (Number(gc.max) || 20000)) throw new HttpsError("invalid-argument", `Choose an amount from ₱${gc.min || 300} to ₱${gc.max || 20000}.`);
  const from = { name: String(d.from?.name || "").trim().slice(0, 60), phone: String(d.from?.phone || "").trim().slice(0, 30) };
  const to = { name: String(d.to?.name || "").trim().slice(0, 60), phone: String(d.to?.phone || "").trim().slice(0, 30) };
  if (from.name.length < 2 || phoneDigits(from.phone).length < 10 || to.name.length < 2) throw new HttpsError("invalid-argument", "Enter your name, mobile number and the recipient's name.");
  const pm = (pub.payments || []).find((m) => m.id === d.payment?.methodId && m.type !== "cash"); const refNo = String(d.payment?.refNo || "").trim().slice(0, 60);
  if (!pm || (pm.askRef === true && refNo.length < 4)) throw new HttpsError("invalid-argument", pm ? `Enter the ${pm.name} reference number.` : "Pay by GCash / Maya, then tap \"I've sent\".");
  const ref = await db.collection(`stores/${pub.storeId}/giftcards`).add({
    amount, balance: amount, from, to, message: String(d.message || "").trim().slice(0, 160), design: ["classic", "birthday", "love", "holiday"].includes(d.design) ? d.design : "classic",
    payment: { methodId: pm.id, methodName: pm.name, refNo, proofUrl: d.payment?.proofUrl ? String(d.payment.proofUrl).slice(0, 500) : null }, status: "pending", code: null, buyerUid: uid, buyerKey: phoneDigits(from.phone), source: "online",
    ...(pub.testMode && pub.testMode.until > Date.now() ? { test: true } : {}), uses: [], createdAt: FieldValue.serverTimestamp(),
  });
  notifyTelegram(pub.storeId, "newOrder", `🎁 Gift card ₱${amount} from ${from.name} for ${to.name} · ${pm.name} ref ${refNo} — verify at the counter`);
  return { id: ref.id, storeId: pub.storeId };
});
exports.giftOps = onCall(async (req) => {
  const who = await staffFrom(req); const { storeId } = who; const d = req.data || {};
  if (!hasRole(who, "crew")) throw new HttpsError("permission-denied", "Only the counter or a manager can do this.");
  const store = (await db.doc(`stores/${storeId}`).get()).data() || {};
  const months = Number(store.settings?.salon?.giftcards?.validMonths) || 12;
  const expires = Date.now() + months * 30 * 86400e3;
  if (d.action === "sell") {
    if (!(await storeEntitled(storeId, "giftcards"))) throw new HttpsError("failed-precondition", "Gift cards are a Pro feature.");
    const amount = Math.round(Number(d.amount) || 0); if (amount < 100) throw new HttpsError("invalid-argument", "Enter the amount.");
    const methods = [{ id: "cash", name: "Cash" }, ...(store.settings?.payments?.methods || []).filter((m) => m.enabled !== false && m.type !== "cash")];
    const m = methods.find((x) => x.id === String(d.methodId || "cash")) || methods[0];
    const code = giftCode();
    const ref = await db.collection(`stores/${storeId}/giftcards`).add({ amount, balance: amount, from: { name: String(d.from?.name || "").slice(0, 60), phone: String(d.from?.phone || "").slice(0, 30) }, to: { name: String(d.to?.name || "").slice(0, 60) }, message: String(d.message || "").slice(0, 160), design: d.design || "classic", payment: { methodId: m.id, methodName: m.name }, status: "active", code, expires, activatedAt: Date.now(), activatedBy: who.name, source: "counter", buyerKey: phoneDigits(d.from?.phone) || null, uses: [], ...(testOn(store.settings) ? { test: true } : {}), createdAt: FieldValue.serverTimestamp() });
    await audit(storeId, who, "gift_sell", { total: amount, method: m.name, summary: code });
    if (phoneDigits(d.from?.phone).length >= 10) await clientLog(storeId, phoneDigits(d.from.phone), "gift", `Bought gift card ${code} ₱${amount} for ${d.to?.name || ""}`);
    return { id: ref.id, code, expires };
  }
  if (d.action === "lookup") {
    const g = (await db.collection(`stores/${storeId}/giftcards`).where("code", "==", String(d.code || "").trim().toUpperCase()).limit(1).get()).docs[0];
    if (!g) throw new HttpsError("not-found", "Gift card not found.");
    const x = g.data(); return { id: g.id, code: x.code, balance: x.balance, amount: x.amount, status: x.expires < Date.now() ? "expired" : x.status, to: x.to, expires: x.expires };
  }
  const ref = db.doc(`stores/${storeId}/giftcards/${String(d.id || "")}`); const g = (await ref.get()).data();
  if (!g) throw new HttpsError("not-found", "Gift card not found.");
  if (d.action === "verify") {
    if (g.status !== "pending") throw new HttpsError("failed-precondition", "Already processed.");
    const code = giftCode();
    await ref.update({ status: "active", code, expires, activatedAt: Date.now(), activatedBy: who.name });
    await audit(storeId, who, "gift_verify", { total: g.amount, method: g.payment?.methodName, summary: `${code} ref ${g.payment?.refNo}` });
    await clientLog(storeId, g.buyerKey, "gift", `Gift card ${code} ₱${g.amount} for ${g.to?.name} (paid ${g.payment?.methodName})`);
    smsTo(storeId, g.from?.phone, `Your ₱${g.amount} gift card for ${g.to?.name} at ${store.name} is ready! Code ${code}. Open your page to download it: ${SITE}/m/${store.slug}`);
    return { ok: true, code };
  }
  if (d.action === "reject") { await ref.update({ status: "rejected", rejectNote: String(d.note || "").slice(0, 120), rejectedBy: who.name }); return { ok: true }; }
  throw new HttpsError("invalid-argument", "Unknown action.");
});

// ---- referral codes (one per client phone) → friend's first visit: both get a reward
async function ensureRefCode(storeId, key, name) {
  const cRef = db.doc(`stores/${storeId}/customers/${key}`); const c = (await cRef.get()).data() || {};
  if (c.refCode) return c.refCode;
  const base = String(name || "FRIEND").normalize("NFD").replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 5) || "FRIEND";
  const code = `${base}-${rnd(3)}`;
  await db.doc(`stores/${storeId}/refCodes/${code}`).set({ key, name: name || "", createdAt: FieldValue.serverTimestamp() });
  await cRef.set({ refCode: code }, { merge: true });
  return code;
}
async function validReferral(storeId, code, myKey) {
  if (!code) return null;
  const c = String(code).trim().toUpperCase();
  const r = (await db.doc(`stores/${storeId}/refCodes/${c}`).get()).data();
  if (!r) throw new HttpsError("invalid-argument", "That referral code was not found.");
  if (r.key === myKey) throw new HttpsError("invalid-argument", "You can't use your own referral code.");
  const me = myKey ? (await db.doc(`stores/${storeId}/customers/${myKey}`).get()).data() : null;
  if (me?.completed) throw new HttpsError("invalid-argument", "Referral codes are for first-time clients.");
  return { code: c, by: r.key, byName: r.name || "" };
}

// ---- staff cash advances (deducted from pay in the payroll report)
exports.recordAdvance = onCall(async (req) => {
  const who = await staffFrom(req); const d = req.data || {};
  if (!hasRole(who)) throw new HttpsError("permission-denied", "Only a manager or the owner can record cash advances.");
  if (d.deleteId) { await db.doc(`stores/${who.storeId}/advances/${String(d.deleteId)}`).delete(); await audit(who.storeId, who, "advance_delete", { summary: String(d.deleteId) }); return { ok: true }; }
  const st = (await db.doc(`stores/${who.storeId}/staff/${String(d.staffId || "")}`).get()).data(); if (!st) throw new HttpsError("not-found", "Staff not found.");
  const amount = Math.round(Number(d.amount) || 0); if (amount <= 0 || amount > 100000) throw new HttpsError("invalid-argument", "Enter the amount.");
  const ref = await db.collection(`stores/${who.storeId}/advances`).add({ staffId: String(d.staffId), name: st.name, amount, note: String(d.note || "").slice(0, 120), at: Date.now(), by: who.name, createdAt: FieldValue.serverTimestamp() });
  await audit(who.storeId, who, "advance", { total: amount, summary: `${st.name}${d.note ? " · " + d.note : ""}` });
  return { id: ref.id };
});

// ---- portfolio (before/after photos the client agreed to show) → customer page "Our team"
exports.syncPortfolio = onDocumentWritten("stores/{storeId}/portfolio/{id}", async (event) => { await rebuildPublicStore(event.params.storeId); });

// ---- daily summary to the owner's Telegram (9 PM)
exports.dailySummaryTick = onSchedule({ schedule: "0 21 * * *", timeZone: "Asia/Manila", timeoutSeconds: 300 }, async () => {
  const snap = await db.collection("stores").where("settings.telegram.enabled", "==", true).get();
  for (const sd of snap.docs) {
    try {
      const store = sd.data(); if (store.settings?.telegram?.events?.daily === false) continue;
      const start = new Date(`${phYmdNow()}T00:00:00+08:00`), end = new Date(start.getTime() + 86400e3);
      const money = (n) => "₱" + Math.round(n || 0).toLocaleString("en-PH");
      const lines = [`📊 Daily summary · ${start.toLocaleDateString("en-PH", { timeZone: "Asia/Manila", weekday: "short", month: "short", day: "numeric" })}`];
      if (store.mode === "salon") {
        const ap = (await db.collection(`stores/${sd.id}/appointments`).where("startAt", ">=", Timestamp.fromDate(start)).where("startAt", "<", Timestamp.fromDate(end)).get()).docs.map((x) => x.data()).filter((a) => !a.test);
        const done = ap.filter((a) => a.status === "done"), paid = done.filter((a) => a.paid);
        lines.push(`💰 Sales: ${money(paid.reduce((s, a) => s + (a.amountDue ?? (a.total || 0) + (a.homeFee || 0)) + (a.dp && a.dp.status === "used" ? a.dp.amount : 0), 0))} · tips ${money(paid.reduce((s, a) => s + (a.tip || 0), 0))}`);
        lines.push(`💇 Clients served: ${done.length}${done.length - paid.length ? ` (${done.length - paid.length} unpaid!)` : ""} · no-shows: ${ap.filter((a) => a.status === "no_show").length} · cancelled: ${ap.filter((a) => a.status === "cancelled").length}`);
        const by = {}; done.forEach((a) => { if (a.providerName) by[a.providerName] = (by[a.providerName] || 0) + 1; });
        if (Object.keys(by).length) lines.push(`⭐ ${Object.entries(by).sort((x, y) => y[1] - x[1]).map(([n, c]) => `${n.split(" ")[0]} ${c}`).join(" · ")}`);
        const dpPending = (await db.collection(`stores/${sd.id}/appointments`).where("dp.status", "==", "to_verify").get()).size;
        if (dpPending) lines.push(`💵 ${dpPending} reservation fee(s) to verify`);
        const gcPending = (await db.collection(`stores/${sd.id}/giftcards`).where("status", "==", "pending").get()).size;
        if (gcPending) lines.push(`🎁 ${gcPending} gift card payment(s) to verify`);
        const tmr = (await db.collection(`stores/${sd.id}/appointments`).where("startAt", ">=", Timestamp.fromDate(end)).where("startAt", "<", Timestamp.fromMillis(end.getTime() + 86400e3)).get()).docs.filter((x) => APPT_ACTIVE.includes(x.data().status) && !x.data().test).length;
        const dueTmr = (await db.collection(`stores/${sd.id}/customers`).where("nextDue.at", "<", end.getTime() + 86400e3).get()).docs.filter((x) => ["due", "snoozed"].includes(x.data().nextDue?.status)).length;
        lines.push(`📅 Tomorrow: ${tmr} booking(s) · 🔁 ${dueTmr} client(s) due back`);
      } else if (store.mode === "stay") {
        const all = (await db.collection(`stores/${sd.id}/stays`).get()).docs.map((x) => x.data()).filter((x) => !x.test);
        const inTo = (x, a, b) => x.checkIn?.toMillis?.() >= a && x.checkIn.toMillis() < b;
        const live = (x) => !["cancelled", "declined"].includes(x.status);
        const today = all.filter((x) => live(x) && inTo(x, start.getTime(), end.getTime()));
        const tmrIn = all.filter((x) => live(x) && inTo(x, end.getTime(), end.getTime() + 86400e3));
        const tmrOut = all.filter((x) => live(x) && x.checkOut?.toMillis?.() >= end.getTime() && x.checkOut.toMillis() < end.getTime() + 86400e3);
        const rooms = (await db.collection(`stores/${sd.id}/rooms`).get()).size || 1;
        const tonight = all.filter((x) => ["confirmed", "checked_in"].includes(x.status) && x.checkIn.toMillis() < end.getTime() && x.checkOut.toMillis() > end.getTime() - 3 * 3600e3).length;
        lines.push(`🏡 Today: ${today.length} check-in(s) · ${money(today.reduce((a, x) => a + (x.total || 0), 0))} booked · tonight ${tonight}/${rooms} rooms (${Math.round((tonight / rooms) * 100)}%)`);
        const dep = all.filter((x) => x.deposit?.status === "checked").reduce((a, x) => a + (x.deposit.refund || 0), 0); const refunds = all.filter((x) => x.refund?.status === "due").reduce((a, x) => a + x.refund.amount, 0);
        if (dep || refunds) lines.push(`🔐 To return: deposits ${money(dep)}${refunds ? ` · refunds ${money(refunds)}` : ""}`);
        const todo = all.filter((x) => ["unconfirmed", "pending"].includes(x.status) || x.deposit?.status === "to_verify" || (x.addons || []).some((a) => a.status === "pending")).length;
        if (todo) lines.push(`🕑 ${todo} booking(s) waiting for you (approval / deposit / extras)`);
        lines.push(`📅 Tomorrow: ${tmrIn.length} check-in(s) · ${tmrOut.length} check-out(s)`);
      } else {
        const os = (await db.collection(`stores/${sd.id}/orders`).where("createdAt", ">=", Timestamp.fromDate(start)).get()).docs.map((x) => x.data()).filter((o) => !o.test);
        const ok = os.filter((o) => o.status !== "cancelled");
        lines.push(`💰 Sales: ${money(ok.reduce((s, o) => s + (o.total || 0), 0))} · paid ${money(ok.filter((o) => o.paid).reduce((s, o) => s + (o.total || 0), 0))}`);
        lines.push(`🧾 Orders: ${os.length} · cancelled: ${os.length - ok.length}${ok.filter((o) => !o.paid).length ? ` · unpaid: ${ok.filter((o) => !o.paid).length}` : ""}`);
        const cnt = {}; ok.forEach((o) => (o.items || []).forEach((l) => (cnt[l.name] = (cnt[l.name] || 0) + (l.qty || 1))));
        const top = Object.entries(cnt).sort((x, y) => y[1] - x[1]).slice(0, 3); if (top.length) lines.push(`🔥 Top: ${top.map(([n, q]) => `${n} ×${q}`).join(", ")}`);
      }
      await notifyTelegram(sd.id, "daily", lines.join("\n"));
    } catch (e) { logger.warn("daily summary", sd.id, e.message); }
  }
});

// rotation recommendation: on-duty (if any duty records) stylists with the skills, least recently assigned first
/** Salon bill: services kept + added services/products, promos, package session, loyalty reward, voucher, reservation fee (DP) */
async function salonBill(storeId, store, a, d) {
  const ctx = await salonContext(storeId);
  const cfg = store.settings?.salon || {};
  const keep = (Array.isArray(d.keep) ? d.keep : (a.items || []).map((_, i) => i)).map(Number);
  const kept = (a.items || []).filter((_, i) => keep.includes(i));
  const added = Array.isArray(d.add) && d.add.length ? apptLines(d.add, ctx.items).lines : [];
  const retail = [];
  if (Array.isArray(d.products) && d.products.length) {
    if (!(await storeEntitled(storeId, "retail"))) throw new HttpsError("failed-precondition", "Retail products are a Pro feature.");
    for (const p of d.products.slice(0, 30)) {
      const it = ctx.items.get(String(p.itemId || "")); if (!it || !it.retail) throw new HttpsError("not-found", "Product not found.");
      const qty = Math.max(1, Math.min(99, parseInt(p.qty, 10) || 1));
      if (it.stock != null && it.stock < qty) throw new HttpsError("failed-precondition", `Only ${it.stock} ${it.name} left in stock.`);
      retail.push({ itemId: it.id, name: it.name, price: Number(it.price) || 0, qty, retail: true, duration: 0, categoryId: it.categoryId, staffPay: it.staffPay || null });
    }
  }
  let buyPackage = null;
  if (d.buyPackage) {
    if (!(await storeEntitled(storeId, "packages"))) throw new HttpsError("failed-precondition", "Packages are a Pro feature.");
    if (!a.customerKey) throw new HttpsError("failed-precondition", "Add the client's phone number first (packages are saved per number).");
    buyPackage = (cfg.packages || []).find((x) => x.id === String(d.buyPackage)); if (!buyPackage) throw new HttpsError("not-found", "Package not found.");
  }
  let buyMember = null;
  if (d.buyMembership) {
    if (!(await storeEntitled(storeId, "memberships"))) throw new HttpsError("failed-precondition", "Memberships are a Pro feature.");
    if (!a.customerKey) throw new HttpsError("failed-precondition", "Add the client's phone number first (memberships are saved per number).");
    buyMember = (cfg.memberships || []).find((x) => x.id === String(d.buyMembership)); if (!buyMember) throw new HttpsError("not-found", "Membership not found.");
  }
  const items = [...kept, ...added, ...retail, ...(buyPackage ? [{ itemId: null, name: `Package: ${buyPackage.name}`, price: Number(buyPackage.price) || 0, qty: 1, package: true, duration: 0 }] : []), ...(buyMember ? [{ itemId: null, name: `Membership: ${buyMember.name}`, price: Number(buyMember.price) || 0, qty: 1, package: true, duration: 0 }] : [])];
  if (!items.length) throw new HttpsError("invalid-argument", "At least one service is needed.");
  const lineTotal = (l) => (Number(l.price) || 0) * (l.qty || 1);
  const subtotal = round2(items.reduce((x, l) => x + lineTotal(l), 0));
  const svcLines = items.filter((l) => !l.retail && !l.package);
  const discounts = {};
  // automatic promos on services/products (Promos page)
  // booked online → the promo locked at booking for the services kept; walk-in / added services → promos at the session time
  if (await storeEntitled(storeId, "promos")) {
    const promos = (await db.collection(`stores/${storeId}/promos`).where("active", "==", true).get()).docs.map((x) => ({ id: x.id, ...x.data() })).filter((p) => p.audience !== "code" && p.audience !== "first_visit");
    let pr = 0;
    const locked = a.bookPromo?.lines;
    if (locked) keep.forEach((i) => { pr += Number(locked[i]) || 0; });
    const fresh = items.filter((x) => !x.package && x.itemId && (!locked || !kept.includes(x)));
    if (fresh.length) pr += calcSalonPromos(promos, { lines: fresh.map((l) => ({ itemId: l.itemId, categoryId: l.categoryId, price: (Number(l.price) || 0) * (l.qty || 1) })), at: a.startAt?.toMillis?.() || Date.now(), home: !!a.homeService, pax: a.couple ? 2 : 1, providerId: a.providerId || null }).discount;
    if (pr > 0) discounts.promo = round2(pr);
  }
  // package session (existing package of this client, or the one bought now)
  let packageUse = null;
  if (d.usePackage) {
    if (d.usePackage === "new" && buyPackage) packageUse = { new: true, name: buyPackage.name, itemId: buyPackage.itemId };
    else if (a.customerKey) {
      const pk = (await db.doc(`stores/${storeId}/customers/${a.customerKey}/packages/${String(d.usePackage)}`).get()).data();
      if (!pk || pk.remaining <= 0 || pk.expires < Date.now()) throw new HttpsError("failed-precondition", "That package has no sessions left or has expired.");
      packageUse = { id: String(d.usePackage), name: pk.name, itemId: pk.itemId };
    }
    if (packageUse) { const line = svcLines.find((l) => l.itemId === packageUse.itemId); if (!line) throw new HttpsError("failed-precondition", `This visit has no ${packageUse.name.replace(/ ×.*/, "")} service to use the package on.`); discounts.package = round2(Number(line.price) || 0); }
  }
  // membership: active one (or the one sold now) → % off services + free sessions
  let member = null, memberFree = false;
  if (a.customerKey && (await storeEntitled(storeId, "memberships"))) {
    const ms = (await db.collection(`stores/${storeId}/customers/${a.customerKey}/memberships`).get()).docs.map((x) => ({ id: x.id, ...x.data() })).filter((x) => x.expires > Date.now()).sort((x, y) => y.expires - x.expires)[0];
    member = ms || (buyMember ? { id: "new", name: buyMember.name, discountPct: Number(buyMember.discountPct) || 0, freeItemId: buyMember.freeItemId || null, freeLeft: Number(buyMember.freeCount) || 0, new: true } : null);
  }
  if (member) {
    let freeLine = null;
    if (d.useMemberFree) {
      freeLine = svcLines.find((l) => l.itemId === member.freeItemId);
      if (!freeLine || !(member.freeLeft > 0)) throw new HttpsError("failed-precondition", "No free session left for this service.");
      discounts.member = round2(Number(freeLine.price) || 0); memberFree = true;
    }
    const pct = Number(member.discountPct) || 0;
    if (pct > 0) { const base = svcLines.filter((l) => l !== freeLine && !(packageUse && l.itemId === packageUse.itemId)).reduce((x, l) => x + (Number(l.price) || 0), 0); const md = round2(base * pct / 100); if (md > 0) discounts.member = round2((discounts.member || 0) + md); }
  }
  // referral: first paid visit of a referred client
  let referral = null;
  if (a.referral && !a.referralRewarded && cfg.referral?.enabled && a.customerKey && (await storeEntitled(storeId, "referral"))) {
    const me = (await db.doc(`stores/${storeId}/customers/${a.customerKey}`).get()).data() || {};
    if (!me.completedPaid) { const left = subtotal - Object.values(discounts).reduce((x, y) => x + y, 0); const r = round2(Math.max(0, Math.min(Number(cfg.referral.reward) || 100, left))); if (r > 0) { discounts.referral = r; referral = { ...a.referral, reward: Number(cfg.referral.reward) || 100 }; } }
  }
  // loyalty reward
  const loyaltyCfg = cfg.loyalty?.enabled && a.customerKey && (await storeEntitled(storeId, "loyalty")) ? cfg.loyalty : null;
  let rewardUsed = false;
  if (d.useReward) {
    if (!loyaltyCfg) throw new HttpsError("failed-precondition", "Loyalty is not on.");
    const c = (await db.doc(`stores/${storeId}/customers/${a.customerKey}`).get()).data() || {};
    if ((c.stamps || 0) < loyaltyCfg.stamps) throw new HttpsError("failed-precondition", `Not enough stamps yet (${c.stamps || 0}/${loyaltyCfg.stamps}).`);
    const left = subtotal - (discounts.promo || 0) - (discounts.package || 0);
    discounts.loyalty = round2(Math.max(0, Math.min(Number(loyaltyCfg.rewardValue) || 0, Math.max(0, ...svcLines.map((l) => Number(l.price) || 0)), left)));
    rewardUsed = true;
  }
  // voucher
  let voucher = null;
  if (!d.voucherCode && a.voucherCode && d.useBookedVoucher !== false) d = { ...d, voucherCode: a.voucherCode };
  if (d.voucherCode) {
    const v = await loadVoucher(storeId, d.voucherCode);
    const before = subtotal - Object.values(discounts).reduce((x, y) => x + y, 0);
    const r = voucherDiscount(v, { subtotal: before, serviceType: "salon", customerKey: a.customerKey });
    if (!r.ok) throw new HttpsError("failed-precondition", r.reason);
    voucher = { code: v.code, discount: r.discount, label: v.label || "" }; discounts.voucher = r.discount;
  }
  const dp = a.dp && a.dp.status === "verified" ? a.dp : null;
  if (dp) discounts.dp = round2(Number(dp.amount) || 0);
  const discountTotal = round2(Object.entries(discounts).filter(([k]) => k !== "dp").reduce((x, [, y]) => x + y, 0));
  let amountDue = round2(Math.max(0, subtotal - discountTotal + (a.homeFee || 0) - (discounts.dp || 0)));
  // gift card (paid before) covers part or all of what is left
  let gift = null;
  if (d.giftCode) {
    const g = (await db.collection(`stores/${storeId}/giftcards`).where("code", "==", String(d.giftCode).trim().toUpperCase()).limit(1).get()).docs[0];
    const x = g?.data();
    if (!x || x.status !== "active") throw new HttpsError("failed-precondition", "Gift card not found or not active yet.");
    if (x.expires < Date.now()) throw new HttpsError("failed-precondition", "This gift card has expired.");
    if (!(x.balance > 0)) throw new HttpsError("failed-precondition", "This gift card has no balance left.");
    const use = round2(Math.min(x.balance, amountDue));
    gift = { id: g.id, code: x.code, used: use, balanceAfter: round2(x.balance - use) }; discounts.gift = use; amountDue = round2(amountDue - use);
  }
  return { items, subtotal, discounts, discountTotal, voucher, dp, gift, amountDue, homeFee: a.homeFee || 0, buyPackage, packageUse, rewardUsed, loyaltyCfg, buyMember, member: member ? { name: member.name, discountPct: member.discountPct || 0, freeLeft: member.freeLeft || 0, freeItemId: member.freeItemId || null, expires: member.expires || null, new: !!member.new } : null, memberFree, referral, catalog: ctx.items };
}
/** Salon money actions (checked by staff role): pay at the counter, home-service cash collected by the stylist, undo payment */
exports.apptOps = onCall(HOT, async (req) => {
  const who = await staffFrom(req);
  const { storeId } = who; const d = req.data || {};
  const ref = db.doc(`stores/${storeId}/appointments/${String(d.id || "")}`); const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Booking not found.");
  const a = snap.data();
  const store = (await db.doc(`stores/${storeId}`).get()).data() || {};
  const methods = [{ id: "cash", type: "cash", name: "Cash" }, ...(store.settings?.payments?.methods || []).filter((m) => m.enabled !== false && m.type !== "cash")];
  if (d.action === "quote" || d.action === "pay") {
    if (!hasRole(who, "crew")) throw new HttpsError("permission-denied", "Only the counter or a manager can take payments.");
    if (a.paid) throw new HttpsError("failed-precondition", "Already paid.");
    if (["cancelled", "no_show"].includes(a.status)) throw new HttpsError("failed-precondition", "This booking was cancelled.");
    const q = await salonBill(storeId, store, a, d);
    if (d.action === "quote") {
      let client = null;
      if (a.customerKey) {
        const c = (await db.doc(`stores/${storeId}/customers/${a.customerKey}`).get()).data() || {};
        const pk = (await db.collection(`stores/${storeId}/customers/${a.customerKey}/packages`).get()).docs.map((x) => ({ id: x.id, ...x.data() })).filter((x) => x.remaining > 0 && x.expires > Date.now()).map((x) => ({ id: x.id, name: x.name, itemId: x.itemId, remaining: x.remaining, sessions: x.sessions, expires: x.expires }));
        client = { stamps: c.stamps || 0, packages: pk, noShows: c.noShows || 0 };
      }
      return { ...q, catalog: undefined, buyMember: q.buyMember ? { id: q.buyMember.id, name: q.buyMember.name } : null, loyaltyCfg: q.loyaltyCfg ? { stamps: q.loyaltyCfg.stamps, rewardText: q.loyaltyCfg.rewardText, rewardValue: q.loyaltyCfg.rewardValue } : null, client };
    }
    const m = methods.find((x) => x.id === String(d.methodId || "cash")) || { id: String(d.methodId || "cash"), name: String(d.methodId || "Cash") };
    const tip = Math.max(0, Math.min(100000, Number(d.tip) || 0));
    const key = a.customerKey;
    const cRef = key ? db.doc(`stores/${storeId}/customers/${key}`) : null;
    // side effects: voucher use, package session, new package, loyalty, retail stock
    if (q.voucher) await db.doc(`stores/${storeId}/vouchers/${q.voucher.code}`).set({ usedCount: FieldValue.increment(1), usedBy: { [key || who.staffId]: FieldValue.increment(1) }, lastUsedAt: FieldValue.serverTimestamp() }, { merge: true });
    let boughtPkg = null;
    if (q.buyPackage && cRef) {
      const pk = q.buyPackage; const pref = cRef.collection("packages").doc();
      boughtPkg = { id: pref.id, name: pk.name, itemId: pk.itemId, sessions: pk.sessions, remaining: pk.sessions - (q.packageUse?.new ? 1 : 0), expires: Date.now() + (pk.validDays || 180) * 86400e3 };
      await pref.set({ ...boughtPkg, price: pk.price, boughtAt: FieldValue.serverTimestamp(), apptId: snap.id, uses: q.packageUse?.new ? [{ at: Date.now(), apptId: snap.id }] : [] });
    }
    if (q.packageUse && !q.packageUse.new && cRef) await cRef.collection("packages").doc(q.packageUse.id).update({ remaining: FieldValue.increment(-1), uses: FieldValue.arrayUnion({ at: Date.now(), apptId: snap.id }) });
    let loyalty = null;
    if (cRef && q.loyaltyCfg) {
      const c = (await cRef.get()).data() || {};
      let stamps = (c.stamps || 0) - (q.rewardUsed ? q.loyaltyCfg.stamps : 0);
      const earn = !q.rewardUsed && q.amountDue + (q.discounts.dp || 0) >= (q.loyaltyCfg.minTotal || 0);
      if (earn) stamps += 1;
      await cRef.set({ stamps, ...(q.rewardUsed ? { rewardsUsed: FieldValue.increment(1) } : {}) }, { merge: true });
      loyalty = { stamps, of: q.loyaltyCfg.stamps, earned: earn, rewardUsed: !!q.rewardUsed, rewardText: q.loyaltyCfg.rewardText || "" };
    }
    if (q.gift) await db.doc(`stores/${storeId}/giftcards/${q.gift.id}`).update({ balance: FieldValue.increment(-q.gift.used), ...(q.gift.balanceAfter <= 0 ? { status: "used" } : {}), uses: FieldValue.arrayUnion({ at: Date.now(), apptId: snap.id, code: a.code, amount: q.gift.used, by: who.name }) });
    let boughtMember = null;
    if (q.buyMember && cRef) {
      const bm = q.buyMember; const mref = cRef.collection("memberships").doc();
      const current = (await cRef.collection("memberships").get()).docs.map((x) => x.data()).filter((x) => x.expires > Date.now()).sort((x, y) => y.expires - x.expires)[0];
      const startAt = Math.max(Date.now(), current?.expires || 0);
      boughtMember = { id: mref.id, planId: bm.id, name: bm.name, start: startAt, expires: startAt + (Number(bm.days) || 30) * 86400e3, discountPct: Number(bm.discountPct) || 0, freeItemId: bm.freeItemId || null, freeLeft: (Number(bm.freeCount) || 0) - (q.memberFree && q.member?.new ? 1 : 0) };
      await mref.set({ ...boughtMember, price: Number(bm.price) || 0, boughtAt: FieldValue.serverTimestamp(), apptId: snap.id });
      await clientLog(storeId, key, "member", `Membership ${bm.name} until ${new Date(boughtMember.expires).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", dateStyle: "medium" })}`);
    }
    if (q.memberFree && !q.member?.new && cRef) { const cur = (await cRef.collection("memberships").get()).docs.filter((x) => x.data().expires > Date.now()).sort((x, y) => y.data().expires - x.data().expires)[0]; if (cur) await cur.ref.update({ freeLeft: FieldValue.increment(-1) }); }
    let myRefCode = null;
    if (cRef && !a.test) {
      if (store.settings?.salon?.referral?.enabled && (await storeEntitled(storeId, "referral"))) myRefCode = await ensureRefCode(storeId, key, a.customer?.name);
      await cRef.set({ completedPaid: FieldValue.increment(1) }, { merge: true });
      await clientLog(storeId, key, "visit", `Visit ${a.code} · ${q.items.map((l) => l.name).join(", ").slice(0, 80)} · paid ₱${q.amountDue}${a.providerName ? ` · ${a.providerName}` : ""}`);
    }
    if (q.referral) {
      const v = `REF-${rnd(5)}`; const reward = q.referral.reward;
      await db.doc(`stores/${storeId}/vouchers/${v}`).set({ code: v, type: "amount", value: reward, minOrder: 0, maxUses: 1, perCustomer: 1, validTo: new Date(Date.now() + 8 * 3600e3 + 90 * 86400e3).toISOString().slice(0, 10), services: [], label: `Referral reward · ${a.customer?.name || ""}`, active: true, usedCount: 0, usedBy: {}, referralFrom: key, createdAt: FieldValue.serverTimestamp() });
      await db.doc(`stores/${storeId}/customers/${q.referral.by}`).set({ referrals: FieldValue.increment(1), rewardVouchers: FieldValue.arrayUnion({ code: v, value: reward, at: Date.now(), friend: a.customer?.name || "" }) }, { merge: true });
      await clientLog(storeId, q.referral.by, "referral", `${a.customer?.name || "A friend"} used your code → voucher ${v} ₱${reward}`);
      await clientLog(storeId, key, "referral", `Referred by ${q.referral.byName || q.referral.code} · ₱${q.discounts.referral} off`);
      const by = (await db.doc(`stores/${storeId}/customers/${q.referral.by}`).get()).data();
      if (by?.phone) smsTo(storeId, by.phone, `Thanks for referring ${a.customer?.name?.split(" ")[0] || "a friend"} to ${store.name}! Here's ₱${reward} off your next visit: code ${v} (valid 90 days).`);
    }
    for (const l of q.items.filter((x) => x.retail)) {
      const iref = db.doc(`stores/${storeId}/items/${l.itemId}`);
      await iref.update({ stock: FieldValue.increment(-(l.qty || 1)) }).catch(() => {});
      const left = (await iref.get()).data()?.stock;
      if (left != null && left <= 3) notifyTelegram(storeId, "newOrder", `📦 Low stock: ${l.name} — ${left} left`);
    }
    // rebook reminder date (longest "rebook after N weeks" among the services)
    const weeks = Math.max(0, ...q.items.filter((l) => !l.retail).map((l) => Number(q.catalog.get(l.itemId)?.rebookWeeks) || 0));
    await ref.update({
      items: q.items, total: q.subtotal, subtotal: q.subtotal, discounts: q.discounts, voucher: q.voucher || null, amountDue: q.amountDue, tip,
      ...(q.dp ? { "dp.status": "used" } : {}), ...(boughtPkg ? { packageBought: boughtPkg } : {}), ...(q.packageUse ? { packageUsed: { id: boughtPkg && q.packageUse.new ? boughtPkg.id : q.packageUse.id, name: q.packageUse.name } } : {}),
      ...(loyalty ? { loyalty } : {}), ...(q.gift ? { gift: { code: q.gift.code, used: q.gift.used, balanceAfter: q.gift.balanceAfter } } : {}), ...(boughtMember ? { memberBought: boughtMember } : {}), ...(q.member && !boughtMember ? { member: q.member } : {}), ...(q.referral ? { referralRewarded: true } : {}), ...(myRefCode ? { myRefCode } : {}), ...(weeks ? { rebookAt: Date.now() + weeks * 7 * 86400e3, rebookSent: false } : {}),
      paid: true, paymentMethod: m.name, paymentMethodId: m.id, paidAt: FieldValue.serverTimestamp(), paidBy: who.name, status: "done", doneAt: a.doneAt || FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    // when the client should come back (longest "rebook after N weeks"); the counter sees it in "Due back"
    let nextDue = null;
    if (weeks && cRef && !a.test) {
      const main = q.items.filter((l) => !l.retail && !l.package).sort((x, y) => (Number(q.catalog.get(y.itemId)?.rebookWeeks) || 0) - (Number(q.catalog.get(x.itemId)?.rebookWeeks) || 0))[0];
      nextDue = { at: Date.now() + weeks * 7 * 86400e3, weeks, itemId: main?.itemId || null, service: main?.name || "", providerId: a.providerId || null, providerName: a.providerName || null, apptId: snap.id, lastVisit: Date.now(), status: "due", smsAt: null, contactedAt: null, contactedBy: null, bookedApptId: null };
      await cRef.set({ nextDue }, { merge: true });
    }
    const changed = q.items.length !== (a.items || []).length;
    await audit(storeId, who, "appt_pay", { orderNo: a.code, total: q.amountDue, method: m.name, ...(changed || q.discountTotal ? { summary: [changed ? `services/products changed at checkout (₱${a.total} → ₱${q.subtotal})` : "", q.discountTotal ? `discounts ₱${q.discountTotal}` : ""].filter(Boolean).join(" · ") } : {}) });
    return { ok: true, ...q, catalog: undefined, buyMember: undefined, loyaltyCfg: undefined, loyalty, nextDue, myRefCode };
  }
  if (d.action === "dpVerify") {
    if (!hasRole(who, "crew")) throw new HttpsError("permission-denied", "Only the counter or a manager can verify payments.");
    if (!a.dp) throw new HttpsError("failed-precondition", "No reservation fee on this booking.");
    await ref.update({ "dp.status": d.reject ? "rejected" : "verified", "dp.verifiedBy": who.name, "dp.verifiedAt": Date.now(), ...(d.reject ? { "dp.rejectNote": String(d.note || "").slice(0, 120) } : {}), updatedAt: FieldValue.serverTimestamp() });
    await audit(storeId, who, d.reject ? "dp_reject" : "dp_verify", { orderNo: a.code, total: a.dp.amount, method: a.dp.methodName });
    return { ok: true };
  }
  if (d.action === "collectHome") {
    if (!a.homeService) throw new HttpsError("failed-precondition", "Not a home service.");
    if (!hasRole(who, "crew", "stylist") || (!who.owner && !hasRole(who, "crew") && a.providerId !== who.staffId)) throw new HttpsError("permission-denied", "Only the assigned stylist or the counter can do this.");
    if (a.paid) return { ok: true };
    await ref.update({ status: "done", doneAt: FieldValue.serverTimestamp(), paid: true, paymentMethod: "cash", paymentMethodId: "cash", paidAt: FieldValue.serverTimestamp(), cashCollectedBy: who.name, collectedById: who.staffId && who.staffId === a.providerId ? who.staffId : null, updatedAt: FieldValue.serverTimestamp() });
    await audit(storeId, who, "appt_home_cash", { orderNo: a.code, total: round2((a.total || 0) + (a.homeFee || 0)) });
    return { ok: true };
  }
  if (d.action === "unpay") {
    if (!hasRole(who)) throw new HttpsError("permission-denied", "Only a manager can undo a payment.");
    await ref.update({ paid: false, paymentMethod: null, paymentMethodId: null, paidAt: null, cashCollectedBy: null, updatedAt: FieldValue.serverTimestamp() });
    await audit(storeId, who, "appt_unpay", { orderNo: a.code, reason: String(d.reason || "").slice(0, 80) });
    return { ok: true };
  }
  throw new HttpsError("invalid-argument", "Unknown action.");
});
exports.recommendStylist = onCall(async (req) => {
  const { token } = requireAuth(req); const storeId = token.storeId; if (!storeId) throw new HttpsError("permission-denied", "No store.");
  const cats = Array.isArray(req.data?.categories) ? req.data.categories : [];
  const ctx = await salonContext(storeId);
  const today = dayKey(new Date(), ctx.store.settings?.businessDayCutoff);
  const appts = await dayAppointments(storeId, today).catch(() => []);
  const at = Number(req.data?.startAt) || Date.now(), mins = Number(req.data?.minutes) || 30;
  const list = ctx.stylists.filter((x) => canDo(x, cats)).map((x) => ({ id: x.id, name: x.name, photoUrl: x.photoUrl || null, onDuty: !!x.onDuty, off: offReason(x, at, at + mins * 60000), active: appts.filter((a) => a.providerId === x.id && ["confirmed", "in_progress"].includes(a.status)).length, today: appts.filter((a) => a.providerId === x.id).length, lastAssignedAt: x.lastAssignedAt?.toMillis?.() || 0 }))
    .sort((a, b) => (!!a.off - !!b.off) || (b.onDuty - a.onDuty) || (a.lastAssignedAt - b.lastAssignedAt));
  return { candidates: list };
});
// auto-cancel unconfirmed appointments (shares the 5-min scheduler below via collectionGroup)
exports.cancelUnconfirmedAppointments = onSchedule({ schedule: "every 5 minutes", timeZone: "Asia/Manila" }, async () => {
  const snap = await db.collectionGroup("appointments").where("status", "==", "unconfirmed").get();
  const now = Date.now();
  for (const d of snap.docs) { const dl = d.data().confirmDeadline?.toMillis?.(); if (dl && dl < now) await d.ref.update({ status: "cancelled", cancelReason: "Not confirmed in time", updatedAt: FieldValue.serverTimestamp() }); }
});

// staff duty: start (staff, PIN-verified client side) → counter accepts → end
exports.startDuty = onCall(async (req) => {
  const { token } = requireAuth(req); const storeId = token.storeId; if (!storeId) throw new HttpsError("permission-denied", "No store.");
  const staffId = String(req.data?.staffId || ""); const st = await db.doc(`stores/${storeId}/staff/${staffId}`).get(); if (!st.exists) throw new HttpsError("not-found", "Staff not found.");
  const cfg = (await db.doc(`stores/${storeId}`).get()).data()?.settings || {};
  const dk = dayKey(new Date(), cfg.businessDayCutoff);
  const open = await db.collection(`stores/${storeId}/duties`).where("staffId", "==", staffId).where("status", "in", ["pending", "on"]).limit(1).get();
  if (!open.empty) return { id: open.docs[0].id, status: open.docs[0].data().status };
  const ref = await db.collection(`stores/${storeId}/duties`).add({ staffId, name: st.data().name, dayKey: dk, status: "pending", startedAt: FieldValue.serverTimestamp(), acceptedAt: null, acceptedBy: null, endedAt: null, basic: Number(st.data().salary?.basicPerDay) || 0, createdAt: FieldValue.serverTimestamp() });
  return { id: ref.id, status: "pending" };
});
exports.acceptDuty = onCall(async (req) => {
  const { token } = requireAuth(req); const storeId = token.storeId; if (!storeId) throw new HttpsError("permission-denied", "No store.");
  const ref = db.doc(`stores/${storeId}/duties/${String(req.data?.id || "")}`); const snap = await ref.get(); if (!snap.exists) throw new HttpsError("not-found", "Duty not found.");
  const d = snap.data();
  if (req.data?.decline) { await ref.update({ status: "declined", acceptedBy: String(req.data?.staffName || "").slice(0, 40), updatedAt: FieldValue.serverTimestamp() }); return { ok: true }; }
  await ref.update({ status: "on", acceptedAt: FieldValue.serverTimestamp(), acceptedBy: String(req.data?.staffName || "").slice(0, 40), updatedAt: FieldValue.serverTimestamp() });
  await db.doc(`stores/${storeId}/staff/${d.staffId}`).update({ onDuty: true, dutyId: snap.id });
  return { ok: true };
});
exports.endDuty = onCall(async (req) => {
  const { token } = requireAuth(req); const storeId = token.storeId; if (!storeId) throw new HttpsError("permission-denied", "No store.");
  const ref = db.doc(`stores/${storeId}/duties/${String(req.data?.id || "")}`); const snap = await ref.get(); if (!snap.exists) throw new HttpsError("not-found", "Duty not found.");
  const d = snap.data();
  await ref.update({ status: d.status === "on" ? "ended" : "cancelled", endedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  await db.doc(`stores/${storeId}/staff/${d.staffId}`).update({ onDuty: false, dutyId: null });
  if (d.status === "on") { const st = (await db.doc(`stores/${storeId}/staff/${d.staffId}`).get()).data() || {}; const basic = Number(d.basic ?? st.salary?.basicPerDay) || 0, allow = Number(st.salary?.allowancePerDay) || 0;
    if (basic + allow > 0) await ledgerAdd(storeId, `duty_${ref.id}`, { staffId: d.staffId, staffName: st.name || "", type: "earn", amount: round2(basic + allow), label: `Duty ${d.dayKey || ""}${basic ? ` · basic ₱${basic}` : ""}${allow ? ` · allowance ₱${allow}` : ""}` }); }
  return { ok: true };
});
// add services to an existing appointment (customer or staff). If the stylist has a gap → extend; else another free stylist → follow-up booking right after; else offer a wait time.
exports.addServiceToAppointment = onCall(async (req) => {
  const { uid, token } = requireAuth(req);
  const d = req.data || {};
  const storeId = String(d.storeId || token.storeId || "");
  const ref = db.doc(`stores/${storeId}/appointments/${String(d.id || "")}`); const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Booking not found.");
  const a = snap.data();
  const isStaff = token.storeId === storeId;
  if (!isStaff && a.customerUid !== uid) throw new HttpsError("permission-denied", "Not your booking.");
  if (!["pending", "confirmed", "in_progress"].includes(a.status)) throw new HttpsError("failed-precondition", "Services can't be added to this booking anymore.");
  const ctx = await salonContext(storeId);
  const add = apptLines(Array.isArray(d.itemIds) ? d.itemIds : [], ctx.items);
  const buffer = Number(ctx.cfg.bufferMin) || 0;
  const startMs = a.startAt.toMillis(); const curDur = a.durationConfirmed || a.durationEst;
  const endMs = Math.max(startMs + curDur * 60000, a.status === "in_progress" ? Date.now() : 0);
  const dateStr = new Date(startMs + 8 * 3600000).toISOString().slice(0, 10);
  const appts = (await dayAppointments(storeId, dateStr)).filter((x) => x.id !== snap.id);
  const freeFrom = (st, from) => stylistFree(st, from, from + add.minutes * 60000) && !appts.some((x) => x.providerId === st.id && overlaps(x, from, from + (add.minutes + buffer) * 60000));
  // 1) same stylist has room right after
  const me = a.providerId ? ctx.stylists.find((x) => x.id === a.providerId) : null;
  if (me && canDo(me, add.cats) && freeFrom(me, endMs)) {
    await ref.update({ items: [...(a.items || []), ...add.lines], total: round2((a.total || 0) + add.total), durationEst: (a.durationEst || 0) + add.minutes, durationConfirmed: a.durationConfirmed ? a.durationConfirmed + add.minutes : null, categories: [...new Set([...(a.categories || []), ...add.cats])], addedServices: FieldValue.arrayUnion({ at: Date.now(), by: isStaff ? String(d.staffName || "staff") : "customer", items: add.lines.map((l) => l.name) }), updatedAt: FieldValue.serverTimestamp() });
    return { mode: "extended", minutes: add.minutes };
  }
  // 2) another stylist free right when this one ends → follow-up booking
  const others = ctx.stylists.filter((x) => x.id !== a.providerId && canDo(x, add.cats) && freeFrom(x, endMs));
  if (others.length && !d.waitOk) {
    const st = others.sort((x, y) => (x.lastAssignedAt?.toMillis?.() || 0) - (y.lastAssignedAt?.toMillis?.() || 0))[0];
    const fref = await writeAppointment(storeId, ctx, add, { customer: a.customer, uid: a.customerUid, providerId: st.id, startAt: new Date(endMs), notes: `Follow-up of ${a.code}`, source: isStaff ? "counter" : "customer", status: "confirmed", staffName: d.staffName, homeService: a.homeService ? { ...a.homeService } : null });
    await ref.update({ followUpId: fref.id, updatedAt: FieldValue.serverTimestamp() });
    return { mode: "followup", provider: st.name, startAt: endMs, minutes: add.minutes, code: (await fref.get()).data().code };
  }
  // 3) find the earliest time anyone (incl. current stylist) is free after endMs
  const pool = ctx.stylists.filter((x) => canDo(x, add.cats)); if (!pool.length) throw new HttpsError("failed-precondition", "No stylist can do that service.");
  let t = endMs, found = null;
  for (let i = 0; i < 48 && !found; i++, t += 15 * 60000) { const st = pool.find((x) => freeFrom(x, t)); if (st) found = { st, t }; }
  if (!found) throw new HttpsError("failed-precondition", "No availability today for that service. Please book it separately.");
  if (!d.waitOk) return { mode: "wait", waitMinutes: Math.round((found.t - endMs) / 60000), startAt: found.t, provider: found.st.name, minutes: add.minutes };
  const fref = await writeAppointment(storeId, ctx, add, { customer: a.customer, uid: a.customerUid, providerId: found.st.id, startAt: new Date(found.t), notes: `Follow-up of ${a.code} (waited)`, source: isStaff ? "counter" : "customer", status: "confirmed", staffName: d.staffName, homeService: a.homeService ? { ...a.homeService } : null });
  await ref.update({ followUpId: fref.id, updatedAt: FieldValue.serverTimestamp() });
  return { mode: "followup", provider: found.st.name, startAt: found.t, minutes: add.minutes, code: (await fref.get()).data().code, waited: true };
});

exports.syncPromos = onDocumentWritten("stores/{storeId}/promos/{id}", async (event) => {
  await rebuildPublicStore(event.params.storeId);
});

// ---------------------------------------------------------------------------
// Bestsellers — top items in the last 30 days (completed orders)
// ---------------------------------------------------------------------------
async function computeBestsellers(storeId) {
  const since = new Date(Date.now() - 30 * 86400000);
  const snap = await db.collection(`stores/${storeId}/orders`).where("createdAt", ">=", since).get();
  const counts = {};
  snap.docs.forEach((d) => { const o = d.data(); if (o.test || o.status === "cancelled" || o.status === "unconfirmed") return; (o.items || []).forEach((l) => { if (l.itemId) counts[l.itemId] = (counts[l.itemId] || 0) + (l.qty || 1); }); });
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id]) => id);
  await db.doc(`stores/${storeId}`).set({ stats: { bestsellers: top, bestsellersAt: FieldValue.serverTimestamp() } }, { merge: true });
  return top;
}
exports.bestsellersDaily = onSchedule({ schedule: "30 3 * * *", timeZone: "Asia/Manila" }, async () => {
  const stores = await db.collection("stores").get();
  for (const d of stores.docs) { try { await computeBestsellers(d.id); } catch (e) { logger.warn("bestsellers", d.id, e.message); } }
});
exports.recomputeBestsellers = onCall(async (req) => {
  const { storeId } = requireOwner(req);
  return { bestsellers: await computeBestsellers(storeId) };
});

exports.syncTables = onDocumentWritten("stores/{storeId}/tables/{id}", async (event) => {
  if (!event.data?.before?.exists && event.data?.after?.exists && !event.data.after.data().isRoom && !event.data.after.data().isWaitlist && (await overPlanLimit(event.params.storeId, "tables"))) { await event.data.after.ref.delete(); return; }
  await rebuildPublicStore(event.params.storeId);
});

// ---------------------------------------------------------------------------
// placeOrder — called by the customer page (anonymous auth).
// The server computes prices; the client is not trusted.
// ---------------------------------------------------------------------------
const SERVICE_TYPES = ["dine_in", "take_out", "pickup", "delivery"];
/** Test mode: on for a limited time (max 4 h). Test orders are numbered T1, T2… and never count in sales. */
const SERVER_VERSION = "2026-10-25k"; // keep in sync with src/version.js — the dashboard warns when functions weren't deployed
const testOn = (settings) => !!(settings?.demo || (settings?.testMode?.on && Number(settings.testMode.until || 0) > Date.now()));

function dayKey(d = new Date(), cutoff = "00:00") {
  // Philippine time (UTC+8); business-day cutoff (e.g. 04:00) counts early-morning orders toward the previous day
  const [ch, cm] = String(cutoff || "00:00").split(":").map(Number);
  const ph = new Date(d.getTime() + 8 * 3600 * 1000 - ((ch || 0) * 60 + (cm || 0)) * 60000);
  return ph.toISOString().slice(0, 10);
}
function rangesFor(hours, k) { const h = (hours || {})[k] || []; const out = []; for (let i = 0; i + 1 < h.length; i += 2) if (h[i] && h[i + 1]) out.push([h[i], h[i + 1]]); return out; }
/** open at PH local time? supports 2 ranges/day, overnight ranges, and a 2nd shift after midnight (same rules as src/hours.js) */
function spansFor(hours, k) {
  const m = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const out = []; let base = 0, lastEnd = -1;
  for (const [o, c] of rangesFor(hours, k)) { let s = m(o) + base, e = m(c) + base; if (lastEnd >= 0 && s < lastEnd) { s += 1440; e += 1440; base += 1440; } if (e <= s) e += 1440; out.push([s, e]); lastEnd = e; }
  return out;
}
function isOpenAt(hours, when = new Date()) {
  if (!hours || !Object.keys(hours).length) return true;
  const ph = new Date(when.getTime() + 8 * 3600 * 1000);
  const cur = ph.getUTCHours() * 60 + ph.getUTCMinutes(), day = ph.getUTCDay();
  const DK = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  for (const [s, e] of spansFor(hours, DK[(day + 6) % 7])) if (cur + 1440 >= s && cur + 1440 <= e) return true;
  for (const [s, e] of spansFor(hours, DK[day])) if (cur >= s && cur <= e) return true;
  return false;
}

/** Customer answers a "payment not received" notice: sent it again (optional ref) or switch to cash. */
exports.customerPayAgain = onCall(async (req) => {
  const { uid } = requireAuth(req);
  const storeId = String(req.data?.storeId || ""), orderId = String(req.data?.orderId || "");
  const ref = db.doc(`stores/${storeId}/orders/${orderId}`); const snap = await ref.get();
  if (!snap.exists || snap.data().customerUid !== uid) throw new HttpsError("permission-denied", "This is not your order.");
  const o = snap.data();
  if (o.paid || !o.payment || o.payment.method === "cash") throw new HttpsError("failed-precondition", "Nothing to update.");
  if (req.data?.cash) {
    const pub = (await db.collection("publicStores").where("storeId", "==", storeId).limit(1).get()).docs[0]?.data() || {};
    const cash = (pub.payments || []).find((m) => m.type === "cash");
    if (!cash) throw new HttpsError("failed-precondition", "This store doesn't take cash for this order.");
    await ref.update({ payment: { methodId: cash.id, method: "cash", methodName: cash.name, refNo: null, changeFor: null, status: "cod", switchedFrom: o.payment.methodName || "GCash" }, updatedAt: FieldValue.serverTimestamp() });
  } else {
    const refNo = String(req.data?.refNo || "").trim().slice(0, 60);
    await ref.update({ "payment.status": "to_verify", "payment.sent": true, "payment.sentAt": Date.now(), "payment.resent": FieldValue.increment(1), ...(refNo ? { "payment.refNo": refNo } : {}), updatedAt: FieldValue.serverTimestamp() });
  }
  notifyTelegram(storeId, "newOrder", `💸 #${o.orderNo}: customer ${req.data?.cash ? "will pay CASH instead" : "says they sent the payment again — please check"}.`).catch(() => {});
  return { ok: true };
});

/** Customer: my loyalty stamps at this café (by mobile number). */
exports.myStamps = onCall(async (req) => {
  requireAuth(req);
  const slug = String(req.data?.slug || ""); const phone = String(req.data?.phone || "").replace(/\D/g, "");
  const pub = (await db.doc(`publicStores/${slug}`).get()).data();
  if (!pub?.loyalty || phone.length < 7) return { off: true };
  const c = (await db.doc(`stores/${pub.storeId}/customers/${phone}`).get()).data() || {};
  return { stamps: Math.max(0, c.stamps || 0), of: pub.loyalty.stamps, rewardText: pub.loyalty.rewardText, rewardValue: pub.loyalty.rewardValue, minTotal: pub.loyalty.minTotal };
});

/** Customer → owner, private: a staff member offered a service outside the app ("side booking"). */
exports.reportStaffOffer = onCall(async (req) => {
  const { uid } = requireAuth(req);
  const d = req.data || {}; const pub = (await db.doc(`publicStores/${String(d.slug || "")}`).get()).data();
  if (!pub) throw new HttpsError("not-found", "Shop not found.");
  const details = String(d.details || "").trim().slice(0, 600);
  if (details.length < 5) throw new HttpsError("invalid-argument", "Please tell us what happened.");
  const since = Date.now() - 864e5;
  const mine = await db.collection(`stores/${pub.storeId}/staffReports`).where("uid", "==", uid).limit(20).get();
  if (mine.docs.filter((x) => (x.data().atMs || 0) >= since).length >= 3) throw new HttpsError("resource-exhausted", "Thanks — we already have your reports. The owner will look into it.");
  const staff = (pub.team || []).find((t) => t.id === d.staffId);
  await db.collection(`stores/${pub.storeId}/staffReports`).add({ uid, atMs: Date.now(), at: FieldValue.serverTimestamp(), staffId: staff?.id || null, staffName: staff?.name || String(d.staffName || "").slice(0, 40) || null, details, phone: String(d.phone || "").slice(0, 20) || null, apptId: d.apptId ? String(d.apptId).slice(0, 40) : null, status: "new" });
  notifyTelegram(pub.storeId, "feedback", `🛡 Private report: a customer says ${staff?.name || "a staff member"} offered a service outside the app. Check Reports → Staff offer reports.`, { force: true }).catch(() => {});
  return { ok: true };
});

exports.placeOrder = onCall(HOT, withIndex("order", async (req) => {
  await maintGuard(req);
  const { uid } = requireAuth(req); // anonymous ok
  const d = req.data || {};
  const slug = String(d.slug || "").trim();
  let serviceType = String(d.serviceType || "");
  const tableToken = d.tableToken ? String(d.tableToken) : null;
  const lines = Array.isArray(d.items) ? d.items : [];
  let customer = {
    name: String(d.customer?.name || "").trim().slice(0, 60),
    phone: String(d.customer?.phone || "").trim().slice(0, 30),
    address: String(d.customer?.address || "").trim().slice(0, 200),
    messenger: msgrOf(d.customer?.messenger),
  };
  const note = String(d.note || "").trim().slice(0, 300);

  if (!slug) throw new HttpsError("invalid-argument", "Missing store.");
  if (!SERVICE_TYPES.includes(serviceType)) throw new HttpsError("invalid-argument", "Invalid service type.");
  if (!lines.length || lines.length > 50) throw new HttpsError("invalid-argument", "Your order is empty.");

  // --- store ---
  const pubSnap = await db.doc(`publicStores/${slug}`).get();
  if (!pubSnap.exists) throw new HttpsError("not-found", "Store not found.");
  const pub = pubSnap.data();
  const storeId = pub.storeId;
  // anti-spam: one phone/browser can't flood a shop with orders (protects small plans' daily limit too)
  if (!d.addTo) { const mine = await db.collection(`stores/${storeId}/orders`).where("customerUid", "==", uid).limit(40).get().catch(() => ({ docs: [] }));
    const open = mine.docs.filter((x) => ["pending", "unconfirmed", "preparing"].includes(x.data().status) && !x.data().parentId).length;
    if (open >= 3) throw new HttpsError("resource-exhausted", "You already have 3 orders waiting. Please wait for them to be accepted, or tap “Add more” on your order."); }
  if (pub.locked) throw new HttpsError("failed-precondition", "This store is not accepting orders right now."); if (pub.comingSoon && !(pub.testMode && pub.testMode.until > Date.now())) throw new HttpsError("failed-precondition", "This shop is not open yet — coming soon!");
  if (!pub.acceptOrders) throw new HttpsError("failed-precondition", "Ordering is currently closed. Please try again later.");
  const isTest = !!(pub.testMode && pub.testMode.until > Date.now());

  // --- additional order, linked to the customer's open order (same table / service / customer, one bill) ---
  let parent = null;
  if (d.addTo) {
    const pSnap = await db.doc(`stores/${storeId}/orders/${String(d.addTo)}`).get();
    if (!pSnap.exists || pSnap.data().customerUid !== uid) throw new HttpsError("permission-denied", "That order isn't yours.");
    parent = { id: pSnap.id, ...pSnap.data() };
    if (parent.parentId) parent = { ...parent, id: parent.parentId, orderNo: parent.parentOrderNo };
    const st = pSnap.data().status;
    const packed = ["pickup", "delivery"].includes(pSnap.data().serviceType);
    const okDine = !["completed", "cancelled", "delivered", "picked_up"].includes(st);
    const okPacked = ["pending", "preparing"].includes(st);
    if (!(packed ? okPacked : okDine)) throw new HttpsError("failed-precondition", packed ? "Your order is already being packed — please place a new order." : "That order is already closed — please place a new order.");
    serviceType = pSnap.data().serviceType;
    customer = { name: pSnap.data().customer?.name || customer.name, phone: pSnap.data().customer?.phone || customer.phone, address: pSnap.data().customer?.address || customer.address, messenger: customer.messenger || pSnap.data().customer?.messenger || "" };
  }

  const svc = pub.service || {};
  const allowed = { dine_in: svc.dineIn !== false, take_out: svc.takeOut !== false, pickup: !!svc.pickup, delivery: !!svc.delivery };
  if (pub.mode !== "table") {
    // laundry/booking (Step 5/6) — pickup only for now
    allowed.pickup = true; allowed.dine_in = false; allowed.take_out = false;
  }
  if (!allowed[serviceType]) throw new HttpsError("failed-precondition", "This service type is not available.");

  // --- pre-order for reservation / event / VIP ---
  let resv = null;
  if (d.reservationId) {
    const rSnap = await db.doc(`stores/${storeId}/reservations/${String(d.reservationId)}`).get();
    if (!rSnap.exists || !ownsResv(rSnap.data(), uid)) throw new HttpsError("permission-denied", "This is not your reservation.");
    resv = { id: rSnap.id, ...rSnap.data() };
    if (!["pending", "confirmed"].includes(resv.status)) throw new HttpsError("failed-precondition", "Pre-ordering is no longer available for this reservation.");
    if (resv.preorder?.orderId) throw new HttpsError("already-exists", "This reservation already has a pre-order. You can add more when you arrive at the store.");
  }

  // --- table ---
  let table = null;
  const singleQR = pub.qrMode === "single";
  if (parent) {
    table = parent.tableId ? { id: parent.tableId, label: parent.tableLabel, roomId: parent.roomId || null } : null;
  } else if (resv) {
    table = resv.tableId ? { id: resv.tableId, label: resv.tableLabel } : null;
  } else if (serviceType === "dine_in" || (serviceType === "take_out" && !singleQR)) {
    if (tableToken) {
      const tSnap = await db.collection(`stores/${storeId}/tables`).where("qrToken", "==", tableToken).limit(1).get();
      if (tSnap.empty || tSnap.docs[0].data().active === false) throw new HttpsError("not-found", "Invalid table QR.");
      table = { id: tSnap.docs[0].id, label: tSnap.docs[0].data().label, roomId: tSnap.docs[0].data().roomId || null };
    } else if (singleQR && d.tableId) {
      // single-QR mode: the customer picked the table from a list
      const tDoc = await db.doc(`stores/${storeId}/tables/${String(d.tableId)}`).get();
      if (!tDoc.exists || tDoc.data().active === false) throw new HttpsError("not-found", "Invalid table.");
      table = { id: tDoc.id, label: tDoc.data().label };
    } else if (isTest) {
      table = { id: null, label: "Test table" };
    } else {
      throw new HttpsError("invalid-argument", singleQR ? "Please select a table." : "Please scan the QR code on your table.");
    }
  }
  if ((serviceType === "pickup" || serviceType === "delivery") && (!customer.name || !customer.phone)) {
    throw new HttpsError("invalid-argument", "Name and phone number are required.");
  }
  if (serviceType === "delivery" && !customer.address) throw new HttpsError("invalid-argument", "Delivery address is required.");

  // --- scheduled pickup/delivery (ASAP if none) ---
  let scheduledAt = null;
  if (resv) scheduledAt = resv.scheduledAt;
  else if (!parent && (serviceType === "pickup" || serviceType === "delivery") && d.scheduledAt) {
    if (svc.allowSchedule === false) throw new HttpsError("failed-precondition", "Only ASAP orders are available.");
    const when = new Date(d.scheduledAt);
    if (isNaN(when.getTime())) throw new HttpsError("invalid-argument", "Invalid schedule.");
    const leadMs = (Number(svc.scheduleLeadMin) || 30) * 60000;
    if (when.getTime() < Date.now() + leadMs) throw new HttpsError("failed-precondition", `Pickup/delivery time must be at least ${svc.scheduleLeadMin || 30} minutes from now.`);
    if (when.getTime() > Date.now() + 7 * 86400000) throw new HttpsError("invalid-argument", "Advance orders are limited to 7 days ahead.");
    if (!isOpenAt(pub.hours, when)) throw new HttpsError("failed-precondition", "The store is closed at that time.");
    scheduledAt = Timestamp.fromDate(when);
  }
  // closed right now? (ASAP orders only; scheduled and reservation pre-orders were checked above) — test mode skips this
  const lateOk = Number(pub.lateUntil) > Date.now();
  if (!isTest && !lateOk && !parent && !resv && !scheduledAt && !isOpenAt(pub.hours)) throw new HttpsError("failed-precondition", "We're closed right now. You can schedule your order for later.");

  const { orderItems, subtotal, promoDiscount, hasAdult, promos } = await priceLines(storeId, lines, { vip: !!table?.roomId });
  if (hasAdult && serviceType !== "dine_in") throw new HttpsError("failed-precondition", "Beer and liquor are for dine-in only. Please remove them or order dine-in.");
  // free delivery promo (value = minimum order); add-on orders never pay delivery again
  const freeDel = serviceType === "delivery" && !parent ? freeDeliveryPromo(promos, subtotal) : null;
  const feeByCounter = serviceType === "delivery" && svc.deliveryFeeMode === "counter" && !freeDel && !parent;
  const deliveryFee = serviceType === "delivery" && !feeByCounter && !freeDel && !parent ? Number(svc.deliveryFee) || 0 : 0;
  // small-order fee: below the minimum → a small fee instead of refusing the order
  const smallFor = Array.isArray(svc.smallOrderFor) && svc.smallOrderFor.length ? svc.smallOrderFor : ["delivery"];
  const smallOrderFee = !parent && Number(svc.smallOrderMin) > 0 && Number(svc.smallOrderFee) > 0 && smallFor.includes(serviceType) && subtotal < Number(svc.smallOrderMin) ? round2(Number(svc.smallOrderFee)) : 0;
  if (!parent && serviceType === "delivery" && svc.deliveryMin && subtotal < svc.deliveryMin) {
    throw new HttpsError("failed-precondition", `Minimum order of ${svc.deliveryMin} for delivery.`);
  }
  // --- voucher ---
  const phoneKeyEarly = customer.phone.replace(/\D/g, "");
  let voucher = null;
  if (d.voucherCode) {
    const v = await loadVoucher(storeId, d.voucherCode);
    if (!v) throw new HttpsError("not-found", "No such voucher code.");
    const r = voucherDiscount(v, { subtotal, serviceType, customerKey: phoneKeyEarly || uid });
    if (!r.ok) throw new HttpsError("failed-precondition", r.reason);
    voucher = { code: v.code, discount: r.discount, type: v.type, value: v.value };
  }
  // --- loyalty reward (café): enough stamps → discount; stamps are taken now and returned if the order is cancelled
  let loyaltyUse = 0;
  if (d.useReward && pub.loyalty && !parent) {
    if (phoneKeyEarly.length < 7) throw new HttpsError("invalid-argument", "Enter your mobile number to use your loyalty reward.");
    const c = (await db.doc(`stores/${storeId}/customers/${phoneKeyEarly}`).get()).data() || {};
    if ((c.stamps || 0) < pub.loyalty.stamps) throw new HttpsError("failed-precondition", `Not enough stamps yet (${c.stamps || 0}/${pub.loyalty.stamps}).`);
    loyaltyUse = round2(Math.max(0, Math.min(pub.loyalty.rewardValue || 0, subtotal - (voucher?.discount || 0))));
  }
  const total = round2(subtotal - (voucher?.discount || 0) - loyaltyUse + deliveryFee + smallOrderFee);

  // --- payment method (chosen by the customer) ---
  const methods = (pub.payments || []).filter((m) => !m.forServices?.length || m.forServices.includes(serviceType));
  const pm = methods.find((m) => m.id === d.payment?.methodId) || null;
  const needPay = serviceType === "pickup" || serviceType === "delivery";
  if (needPay && methods.length && !pm && !parent) throw new HttpsError("invalid-argument", "Please select a payment method.");
  let payment = parent?.payment ? { ...parent.payment, refNo: null, changeFor: null, status: parent.payment.method === "cash" ? "cod" : "to_verify" } : null;
  if (pm && !parent) {
    const isCash = pm.type === "cash";
    const refNo = String(d.payment?.refNo || "").trim().slice(0, 60);
    // One-tap GCash: the reference no. is optional unless the owner turned on "Ask for reference no." (askRef) for remote orders
    const remote = needPay || !!d.reservationId;
    if (!isCash && pm.type !== "card" && remote && d.payment?.sent !== false && pm.askRef === true && refNo.length < 4) throw new HttpsError("invalid-argument", `Enter the ${pm.name} reference number.`);
    const changeFor = isCash && d.payment?.changeFor ? Math.max(total, Number(d.payment.changeFor) || 0) : null;
    const sent = !isCash && pm.type !== "card" && remote && d.payment?.sent !== false;
    payment = { methodId: pm.id, method: pm.type, methodName: pm.name, refNo: isCash ? null : refNo || null, changeFor, status: isCash ? "cod" : sent ? "to_verify" : serviceType === "delivery" ? "on_arrival" : "at_counter", sent, sentAt: sent ? Date.now() : null };
  }

  // --- customer record (phone-based): returning? flagged? ---
  let customerRec = null;
  const phoneKey = customer.phone.replace(/\D/g, "");
  if (phoneKey.length >= 7) {
    const cSnap = await db.doc(`stores/${storeId}/customers/${phoneKey}`).get();
    customerRec = cSnap.exists ? cSnap.data() : null;
    if (customerRec?.flagged) throw new HttpsError("permission-denied", "We can't accept this order. Please call the store.");
  }
  const returning = !!(customerRec && (customerRec.completed || 0) >= 1);

  // --- confirmation before preparing (pickup/delivery) ---
  const cf = pub.confirm || {};
  const needsConfirm = !resv && !parent && needPay && cf.mode && cf.mode !== "off" && !(cf.skipReturning !== false && returning);
  const initialStatus = needsConfirm ? "unconfirmed" : pub.mode === "pickup" ? "received" : "pending";

  const { orderId } = await commitOrder(storeId, {
    type: pub.mode,
    serviceType,
    status: initialStatus,
    tableId: table?.id || null,
    tableLabel: table?.label || null,
    items: orderItems,
    stations: Object.fromEntries([...new Set(orderItems.map((l) => l.station))].map((st) => [st, "pending"])),
    subtotal, deliveryFee, total, note, customer,
    smallOrderFee, freeDelivery: freeDel ? { promoId: freeDel.id, name: freeDel.name } : null,
    parentId: parent?.id || null, parentOrderNo: parent?.orderNo || null,
    discounts: { promo: promoDiscount || 0, voucher: voucher?.discount || 0, ...(loyaltyUse ? { loyalty: loyaltyUse } : {}) },
    loyaltyReward: loyaltyUse ? { stamps: pub.loyalty.stamps, text: pub.loyalty.rewardText || "", value: loyaltyUse } : null,
    voucher,
    customerUid: uid,
    customerKey: phoneKey.length >= 7 ? phoneKey : null,
    returning, customerOrders: customerRec?.completed || 0,
    risk: customerRec && ((customerRec.walkouts || 0) + (customerRec.noShows || 0) + (customerRec.failedDeliveries || 0)) ? { walkouts: customerRec.walkouts || 0, noShows: customerRec.noShows || 0, failed: customerRec.failedDeliveries || 0 } : null,
    pack: !!(parent && d.pack && ["dine_in"].includes(parent.serviceType)),
    source: "customer",
    scheduledAt, isScheduled: !!scheduledAt,
    reservationId: resv?.id || null, reservationCode: resv?.code || null, reservationKind: resv?.kind || null,
    roomId: table?.roomId || null, sessionId: table?.roomId ? await openSessionId(storeId, table.roomId) : null,
    paid: false, paymentMethod: payment?.method || null, payment, etaMinutes: null,
    riderId: null, riderName: null, deliveryFeePending: feeByCounter,
    needsConfirm, confirmDeadline: needsConfirm ? Timestamp.fromMillis(Date.now() + (Number(cf.minutes) || 15) * 60000) : null,
  });
  if (parent) {
    // the parent shows a blinking "➕ New add-on" until staff tap OK; a packed order that was already Ready waits for the add-on (+10 min)
    const pRef = db.doc(`stores/${storeId}/orders/${parent.id}`);
    const pNow = (await pRef.get()).data() || {};
    const holdPacked = ["pickup", "delivery", "take_out"].includes(pNow.serviceType) && pNow.status === "ready";
    const accMs = pNow.acceptedAt?.toMillis?.() || Date.now();
    await pRef.update({
      addOns: FieldValue.arrayUnion(orderId),
      addAlert: { orderId, at: Date.now(), count: (pNow.addAlert?.count || 0) + 1 },
      ...(holdPacked ? { status: "preparing", readyAt: null, etaMinutes: Math.ceil((Date.now() - accMs) / 60000) + 10, heldForAddOn: true } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    }).catch(() => {});
  }
  notifyTelegram(storeId, "newOrder", `🧾 New ${parent ? `ADD-ON for #${parent.orderNo} · ` : ""}${serviceType.replace("_", "-")} order${table ? " · " + table.label : ""} · ₱${total}${needsConfirm ? " (awaiting confirmation)" : ""}\n${orderItems.map((l) => `${l.qty}× ${l.name}`).join(", ").slice(0, 300)}${customer?.name ? "\n" + customer.name : ""}`);
  if (resv) {
    await db.doc(`stores/${storeId}/reservations/${resv.id}`).update({ preorder: { orderId, orderNo: (await db.doc(`stores/${storeId}/orders/${orderId}`).get()).data().orderNo, total, items: orderItems.map((l) => `${l.qty}× ${l.name}`) }, updatedAt: FieldValue.serverTimestamp() });
  }
  if (loyaltyUse) await db.doc(`stores/${storeId}/customers/${phoneKeyEarly}`).set({ stamps: FieldValue.increment(-pub.loyalty.stamps), rewardsUsed: FieldValue.increment(1), lastRewardAt: FieldValue.serverTimestamp() }, { merge: true });
  if (voucher) {
    const key = phoneKey || uid;
    await db.doc(`stores/${storeId}/vouchers/${voucher.code}`).set({ usedCount: FieldValue.increment(1), usedBy: { [key]: FieldValue.increment(1) }, lastUsedAt: FieldValue.serverTimestamp() }, { merge: true });
  }
  if (phoneKey.length >= 7) {
    await db.doc(`stores/${storeId}/customers/${phoneKey}`).set({
      phone: customer.phone, name: customer.name || customerRec?.name || "", address: customer.address || customerRec?.address || "",
      orders: FieldValue.increment(1), lastOrderAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      ...(customerRec ? {} : { completed: 0, cancelled: 0, flagged: false, createdAt: FieldValue.serverTimestamp() }),
    }, { merge: true });
  }
  logger.info("order placed", { storeId, orderId, total, serviceType, scheduled: !!scheduledAt });
  return { orderId, storeId, total };
}));

/** The room's open VIP session (if any) */
async function openSessionId(storeId, roomId) {
  const snap = await db.collection(`stores/${storeId}/sessions`).where("roomId", "==", roomId).where("status", "==", "open").limit(1).get();
  return snap.empty ? null : snap.docs[0].id;
}

/** Prices from the database (not from the client). returns { orderItems, subtotal } */
async function priceLines(storeId, lines, ctx = {}) {
  const [itemsSnap, catsSnap, promoSnap] = await Promise.all([db.collection(`stores/${storeId}/items`).get(), db.collection(`stores/${storeId}/categories`).get(), db.collection(`stores/${storeId}/promos`).where("active", "==", true).get()]);
  const catalog = new Map(itemsSnap.docs.map((x) => [x.id, x.data()]));
  const catStation = new Map(catsSnap.docs.map((x) => [x.id, x.data().station || (x.data().adult ? "barista" : "kitchen")]));
  const catAdult = new Set(catsSnap.docs.filter((x) => x.data().adult).map((x) => x.id));
  const promos = (await storeEntitled(storeId, "promos")) ? promoSnap.docs.map((x) => ({ id: x.id, ...x.data() })) : [];
  const orderItems = [];
  let subtotal = 0, promoDiscount = 0, hasAdult = false;
  for (const line of lines) {
    const it = catalog.get(String(line.itemId || ""));
    if (!it) throw new HttpsError("not-found", "An item is no longer on the menu.");
    if (it.available === false) throw new HttpsError("failed-precondition", `Sold out: ${it.name}`);
    const qty = Math.max(1, Math.min(99, parseInt(line.qty, 10) || 1));
    let unitPrice = Number(it.price) || 0;
    const choices = [];
    const picked = Array.isArray(line.choices) ? line.choices : [];
    for (const group of it.options || []) {
      const sel = picked.filter((c) => c.group === group.name);
      if (group.required && !sel.length) throw new HttpsError("invalid-argument", `Please choose a ${group.name} for ${it.name}`);
      if (!group.multi && sel.length > 1) throw new HttpsError("invalid-argument", `Only one ${group.name} allowed`);
      for (const c of sel) {
        const ch = (group.choices || []).find((x) => x.label === c.label);
        if (!ch) throw new HttpsError("invalid-argument", `Invalid option: ${c.label}`);
        unitPrice += Number(ch.add) || 0;
        choices.push({ group: group.name, label: ch.label, add: Number(ch.add) || 0 });
      }
    }
    const gross = round2(unitPrice * qty);
    const promo = promoForItem({ id: String(line.itemId), categoryId: it.categoryId, adult: catAdult.has(it.categoryId) }, promos, undefined, ctx);
    const { discount, label } = lineDiscount(promo, Number(it.price) || 0, unitPrice, qty);
    const lineTotal = round2(gross - discount);
    subtotal += lineTotal; promoDiscount += discount;
    const station = it.station || catStation.get(it.categoryId) || "kitchen";
    const adult = catAdult.has(it.categoryId); if (adult) hasAdult = true;
    const plating = station === "kitchen" && Array.isArray(it.plating) && it.plating.length ? { plating: it.plating.slice(0, 12).map((x) => String(x).slice(0, 80)), ...(it.platingPhoto ? { platingPhoto: it.platingPhoto } : {}) } : {};
    orderItems.push({ itemId: String(line.itemId), name: it.name, qty, unitPrice, choices, note: String(line.note || "").slice(0, 120), subtotal: lineTotal, station, ...(adult ? { adult: true } : {}), ...plating, ...(discount ? { promoId: promo.id, promoName: promo.name, promoLabel: label, discount } : {}) });
  }
  return { orderItems, subtotal: round2(subtotal), promoDiscount: round2(promoDiscount), hasAdult, promos };
}

/** Voucher: validate against the DB (no increment) */
async function loadVoucher(storeId, code) {
  if (!code) return null;
  const snap = await db.doc(`stores/${storeId}/vouchers/${String(code).trim().toUpperCase()}`).get();
  const v = snap.exists ? { code: snap.id, ...snap.data() } : null;
  if (v?.type === "viphours") throw new HttpsError("failed-precondition", "This is a free VIP room hours code — show it at the counter when you use a VIP room.");
  // sorry vouchers (from incident reports) always work; other codes need the Vouchers add-on
  if (!(v?.incidentId || v?.feedbackId) && !(await storeEntitled(storeId, "vouchers"))) throw new HttpsError("failed-precondition", "Voucher codes are not available at this store.");
  return v;
}

exports.checkVoucher = onCall(async (req) => {
  requireAuth(req);
  const d = req.data || {};
  const pubSnap = await db.doc(`publicStores/${String(d.slug || "")}`).get();
  if (!pubSnap.exists) throw new HttpsError("not-found", "Store not found.");
  const storeId = pubSnap.data().storeId;
  const v = await loadVoucher(storeId, d.code);
  if (!v) throw new HttpsError("not-found", "No such voucher code.");
  const r = voucherDiscount(v, { subtotal: Number(d.subtotal) || 0, serviceType: String(d.serviceType || ""), customerKey: String(d.phone || "").replace(/\D/g, "") || null });
  if (!r.ok) throw new HttpsError("failed-precondition", r.reason);
  return { code: v.code, discount: r.discount, type: v.type, value: v.value, label: v.label || "" };
});

/** Write the order with a daily order number (#1, #2, ...) */
async function commitOrder(storeId, data, { skipLimit = false } = {}) {
  const storeDoc = (await db.doc(`stores/${storeId}`).get()).data() || {};
  const storeCfg = storeDoc.settings || {};
  const today = dayKey(new Date(), storeCfg.businessDayCutoff);
  const test = data.test ?? testOn(storeCfg);
  // plan limit: orders (café) / jobs (laundry) per day — counts every order created today, cancelled ones too
  let maxPerDay = UNLIMITED, planName = "free";
  if (storeDoc.mode === "laundry" && data.source !== "counter") skipLimit = true; // laundry Free: walk-in jobs only
  if (!skipLimit && !test) { const { lim, plan } = await storeLimits(storeId, storeDoc.mode); maxPerDay = storeDoc.mode === "laundry" ? lim.jobsPerDay ?? UNLIMITED : lim.ordersPerDay ?? UNLIMITED; planName = plan; }
  const counterRef = db.doc(`stores/${storeId}/meta/${test ? "testCounters" : "counters"}`);
  const orderRef = db.collection(`stores/${storeId}/orders`).doc();
  await db.runTransaction(async (tx) => {
    const c = await tx.get(counterRef);
    const cur = c.exists && c.data().dayKey === today ? c.data().seq : 0;
    let used = cur;
    if (maxPerDay < UNLIMITED) { const u = (await tx.get(db.doc(`stores/${storeId}/stats/usage`))).data() || {}; if (u.cancelledDay === today) used = Math.max(0, cur - (u.cancelled || 0)); }
    if (used >= maxPerDay) { db.doc(`stores/${storeId}/stats/usage`).set({ limitHit: { key: storeDoc.mode === "laundry" ? "jobsPerDay" : "ordersPerDay", max: maxPerDay, at: Date.now() } }, { merge: true }).catch(() => {}); throw new HttpsError("resource-exhausted", data.source === "counter" ? limitMsg(storeDoc.mode === "laundry" ? "jobs a day" : "orders a day", maxPerDay, planName) : "This shop can't take more online orders today. Please order at the counter or message the shop."); }
    const seq = cur + 1;
    tx.set(counterRef, { dayKey: today, seq }, { merge: true });
    if (!test) tx.set(db.doc(`stores/${storeId}/stats/usage`), { day: today, orders: seq, dayMs: Date.now() }, { merge: true });
    tx.set(orderRef, { orderNo: test ? `T${seq}` : seq, dayKey: today, ...data, ...(test ? { test: true } : {}), createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  });
  return { orderId: orderRef.id };
}

// ---------------------------------------------------------------------------
// staffPlaceOrder — walk-in order from the Counter screen (logged in to the store)
// ---------------------------------------------------------------------------
exports.staffPlaceOrder = onCall(async (req) => {
  await maintGuard(req);
  const { token } = requireAuth(req);
  const storeId = token.storeId;
  if (!storeId) throw new HttpsError("permission-denied", "No store.");
  const d = req.data || {};
  const serviceType = SERVICE_TYPES.includes(d.serviceType) ? d.serviceType : "take_out";
  const lines = Array.isArray(d.items) ? d.items : [];
  if (!lines.length || lines.length > 50) throw new HttpsError("invalid-argument", "The order is empty.");
  const storeSnap = await db.doc(`stores/${storeId}`).get();
  const store = storeSnap.data();
  let table = null;
  if (d.tableId) {
    const tDoc = await db.doc(`stores/${storeId}/tables/${String(d.tableId)}`).get();
    if (tDoc.exists) table = { id: tDoc.id, label: tDoc.data().label, roomId: tDoc.data().roomId || null };
  }
  const customer = { name: String(d.customer?.name || "").trim().slice(0, 60), phone: String(d.customer?.phone || "").trim().slice(0, 30), address: String(d.customer?.address || "").trim().slice(0, 200), messenger: msgrOf(d.customer?.messenger) };
  const { orderItems, subtotal, promoDiscount } = await priceLines(storeId, lines);
  const svc = store.settings?.service || {};
  if (serviceType === "delivery" && !(await storeEntitled(storeId, "delivery"))) throw new HttpsError("failed-precondition", "Add-on: Delivery — activate it in Billing.");
  const deliveryFee = serviceType === "delivery" ? Number(svc.deliveryFee) || 0 : 0;
  const total = Math.round((subtotal + deliveryFee) * 100) / 100;
  const paid = !!d.paid;
  // offline queue: the counter retries with the same clientRef → never create the order twice
  const clientRef = d.clientRef ? String(d.clientRef).slice(0, 40) : null;
  if (clientRef) { const dup = await db.collection(`stores/${storeId}/orders`).where("clientRef", "==", clientRef).limit(1).get(); if (!dup.empty) return { orderId: dup.docs[0].id, total: dup.docs[0].data().total || 0, duplicate: true }; }
  const storeCfgFor = (await db.doc(`stores/${storeId}`).get()).data() || {};
  const { orderId } = await commitOrder(storeId, {
    clientRef, offlineAt: d.offlineAt ? Number(d.offlineAt) || null : null,
    type: store.mode, serviceType,
    status: store.mode === "pickup" ? "received" : "pending",
    tableId: table?.id || null, tableLabel: table?.label || null,
    items: orderItems,
    stations: Object.fromEntries([...new Set(orderItems.map((l) => l.station))].map((st) => [st, "pending"])),
    subtotal, deliveryFee, total, note: String(d.note || "").slice(0, 300), customer,
    discounts: { promo: promoDiscount || 0, voucher: 0 },
    customerUid: null, source: "counter", customerKey: String(customer?.phone || "").replace(/\D/g, "").length >= 7 ? String(customer.phone).replace(/\D/g, "") : null,
    roomId: table?.roomId || null, sessionId: table?.roomId ? await openSessionId(storeId, table.roomId) : null,
    staffId: d.staffId ? String(d.staffId) : null, staffName: d.staffName ? String(d.staffName).slice(0, 40) : null,
    paid, ...(paid ? payFields(storeCfgFor, String(d.paymentMethod || "cash")) : { paymentMethod: null }), paidAt: paid ? FieldValue.serverTimestamp() : null,
    etaMinutes: null,
  });
  return { orderId, total };
});

// ---------------------------------------------------------------------------
// callStaff — "Call staff" from the customer (table QR). Has a cooldown per table.
// ---------------------------------------------------------------------------
exports.callStaff = onCall(HOT, async (req) => {
  const { uid } = requireAuth(req);
  const d = req.data || {};
  const slug = String(d.slug || "").trim();
  const tableToken = String(d.tableToken || "");
  const type = String(d.type || "other").slice(0, 30);
  const message = String(d.message || "").trim().slice(0, 200);
  if (!slug || !tableToken) throw new HttpsError("invalid-argument", "Please scan the QR code on your table.");
  const pubSnap = await db.doc(`publicStores/${slug}`).get();
  if (!pubSnap.exists) throw new HttpsError("not-found", "Store not found.");
  const pub = pubSnap.data();
  const cs = pub.callStaff || {};
  if (!cs.enabled && !(type === "vip" && pub.vip?.enabled)) throw new HttpsError("failed-precondition", "Call staff is not available.");
  const storeId = pub.storeId;
  const tSnap = await db.collection(`stores/${storeId}/tables`).where("qrToken", "==", tableToken).limit(1).get();
  if (tSnap.empty) throw new HttpsError("not-found", "Invalid table QR.");
  const table = { id: tSnap.docs[0].id, label: tSnap.docs[0].data().label };

  // cooldown: this table's last request
  const cooldownMs = (Number(cs.cooldownMin) || 5) * 60 * 1000;
  const last = await db.collection(`stores/${storeId}/requests`).where("tableId", "==", table.id).orderBy("createdAt", "desc").limit(1).get();
  if (!last.empty) {
    const r = last.docs[0].data();
    const since = Date.now() - (r.createdAt?.toMillis?.() || 0);
    if (r.status !== "done" && since < cooldownMs) {
      throw new HttpsError("resource-exhausted", `Please wait ${Math.ceil((cooldownMs - since) / 1000)} seconds before requesting again.`);
    }
    if (r.status !== "done") throw new HttpsError("already-exists", "This table already has an open request.");
  }
  const ref = await db.collection(`stores/${storeId}/requests`).add({
    tableId: table.id, tableLabel: table.label, type, message,
    status: "open", claimedBy: null, claimedByName: null, claimedAt: null,
    messages: message ? [{ from: "customer", text: message, at: Date.now() }] : [],
    customerUid: uid, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  });
  notifyTelegram(storeId, "callStaff", `🔔 ${table.label} is calling staff: ${type}${message ? " — " + message : ""}`);
  return { id: ref.id, storeId, cooldownMs };
});

// ---------------------------------------------------------------------------
// Staff accounts — only the owner can create/remove them
// ---------------------------------------------------------------------------
const STAFF_ROLES = ["staff", "kitchen"];

/** Owner only. Returns the token claims (storeId, orgId, email…) plus uid and token. */
function requireOwner(req) {
  const { uid, token } = requireAuth(req);
  if (!token.storeId || token.role !== "owner") throw new HttpsError("permission-denied", "Only the owner can do this.");
  return { ...token, uid, token, storeId: token.storeId };
}

// ---------------------------------------------------------------------------
// Device logins — a shared tablet signs in as a "device" account (role: device) instead of the owner.
// A device can open the staff screens (Counter, Kitchen…) but never the owner dashboard.
// Flow: owner taps "Set up this device" (or shows a 6-digit code) → the tablet redeems it →
// gets a custom token + a device secret saved on the tablet so it can sign back in by itself.
// ---------------------------------------------------------------------------
const crypto = require("crypto");
const DEVICE_CODE_MS = 10 * 60000;
const deviceCode = () => String(Math.floor(100000 + Math.random() * 900000));
const secretHash = (storeId, secret) => crypto.createHmac("sha256", storeId).update(secret).digest("hex");

// ---------------------------------------------------------------------------
// Private customer files (valid ID, signature, waiver PDF, payment proof).
// Stored under stores/{storeId}/private/{uid}/… — not readable by URL. Staff of the store, or the
// customer who uploaded it, fetch the bytes here. Files are deleted after the retention period.
// ---------------------------------------------------------------------------
const PRIV_MAX_BYTES = 6 * 1024 * 1024;
exports.privateFile = onCall({ memory: "512MiB" }, async (req) => {
  const { uid, token } = requireAuth(req);
  const path = String(req.data?.path || "").replace(/^priv:/, "");
  const m = path.match(/^stores\/([^/]+)\/private\/([^/]+)\/([^/]+)$/);
  if (!m) throw new HttpsError("invalid-argument", "Bad file.");
  const [, storeId, ownerUid] = m;
  const mine = ownerUid === uid;
  const staff = token.storeId === storeId && ["owner", "device", "staff", "kitchen"].includes(token.role);
  const isAdm = token.admin === true || isAdminEmail(token.email);   // TapTayo admin: checking payment screenshots
  // a customer may see the intake photos of their own laundry job (weight, stains) — proof for both sides
  let custProof = false;
  if (!mine && !staff && !isAdm && req.data?.orderId) {
    const o = (await db.doc(`stores/${storeId}/orders/${String(req.data.orderId)}`).get()).data();
    custProof = !!(o && o.customerUid === uid && (o.laundry?.proof?.photos || []).some((x) => x.url === "priv:" + path || x.url === path));
    if (!custProof) { // stay: photos of stains / damage behind a deposit deduction
      const st = (await db.doc(`stores/${storeId}/stays/${String(req.data.orderId)}`).get()).data();
      custProof = !!(st && st.customerUid === uid && (st.deposit?.deductions || []).some((x) => x.photo === "priv:" + path || x.photo === path));
    }
  }
  if (!mine && !staff && !isAdm && !custProof) throw new HttpsError("permission-denied", "Not allowed.");
  const file = admin.storage().bucket().file(path);
  const [exists] = await file.exists();
  if (!exists) throw new HttpsError("not-found", "This file is no longer available (deleted after the retention period).");
  const [meta] = await file.getMetadata();
  if (Number(meta.size) > PRIV_MAX_BYTES) throw new HttpsError("resource-exhausted", "File too large.");
  const [buf] = await file.download();
  if (staff && !mine) audit(storeId, { name: token.email || token.role, staffId: token.role === "device" ? "device" : "owner" }, "viewed_private_file", { path: m[3] }).catch(() => {});
  return { contentType: meta.contentType || "application/octet-stream", base64: buf.toString("base64") };
});

/** Retention: delete private customer files older than settings.privacy.retentionDays (default 90). Runs nightly. */
exports.privateFilesCleanup = onSchedule({ schedule: "40 3 * * *", timeZone: "Asia/Manila", timeoutSeconds: 540 }, async () => {
  const bucket = admin.storage().bucket();
  const stores = await db.collection("stores").select("settings.privacy").get();
  for (const st of stores.docs) {
    const days = Math.max(7, Number(st.get("settings.privacy.retentionDays") || 90));
    const cutoff = Date.now() - days * 864e5;
    try {
      const [files] = await bucket.getFiles({ prefix: `stores/${st.id}/private/` });
      let n = 0;
      for (const f of files) { if (new Date(f.metadata.timeCreated).getTime() < cutoff) { await f.delete().catch(() => {}); n++; } }
      if (n) logger.info("private cleanup", { storeId: st.id, deleted: n, days });
    } catch (e) { logger.warn("private cleanup", st.id, e.message); }
  }
});


// ---- owner session guard (see onCall wrapper at the top) ----
const secCache = new Map(); // uid -> { sec, at }
async function userSec(uid, fresh = false) {
  const c = secCache.get(uid);
  if (!fresh && c && Date.now() - c.at < 30000) return c.sec;
  const sec = (await db.doc(`userSecurity/${uid}`).get()).data() || {};
  secCache.set(uid, { sec, at: Date.now() });
  return sec;
}
async function ownerSessionGuard(req) {
  const t = req.auth?.token;
  if (!t || t.role !== "owner") return;
  const sec = await userSec(req.auth.uid);
  const at = Number(t.auth_time || 0);
  if (sec.revokedAt && at < sec.revokedAt) throw new HttpsError("unauthenticated", "This session was logged out. Please log in again.");
  if (sec.twoStep && !(sec.sessions || {})[String(at)]) throw new HttpsError("permission-denied", "Confirm this login from the link in your email first.");
}
async function approveSession(uid, token) {
  const ref = db.doc(`userSecurity/${uid}`);
  const sec = (await ref.get()).data() || {};
  const sessions = Object.entries({ ...(sec.sessions || {}), [String(token.auth_time)]: Date.now() }).sort((a, b) => b[1] - a[1]).slice(0, 20);
  await ref.set({ sessions: null }, { merge: true });
  await ref.update({ sessions: Object.fromEntries(sessions) });
  secCache.delete(uid);
}
// ---------------------------------------------------------------------------
// Owner login security — trusted devices + optional 2-step (email link) on new devices.
// The browser keeps a random trust token; we store only its hash in userSecurity/{uid} (server-only doc).
// "Log out everywhere" revokes refresh tokens; old sessions die when their ID token expires (≤1 h).
// ---------------------------------------------------------------------------
const trustHash = (uid, tok) => crypto.createHmac("sha256", `trust:${uid}`).update(String(tok)).digest("hex");
const TRUST_MAX = 10;
async function ownerStoreIds(uid) {
  const u = (await db.doc(`users/${uid}`).get()).data() || {};
  return [u.storeId, ...(u.storeIds || [])].filter(Boolean);
}
/** Login page calls this right after sign-in: is this browser trusted? Does the owner require 2-step? */
exports.securityStatus = onCallRaw(async (req) => {
  const { uid, token } = requireAuth(req);
  if (token.role === "device") throw new HttpsError("permission-denied", "Not for device accounts.");
  const tok = String(req.data?.deviceToken || "");
  const snap = await db.doc(`userSecurity/${uid}`).get();
  const sec = snap.data() || {};
  const h = tok ? trustHash(uid, tok) : null;
  const devices = sec.devices || {};
  const trusted = !!(h && devices[h]);
  if (trusted) { await snap.ref.set({ devices: { [h]: { ...devices[h], lastAt: Date.now() } } }, { merge: true }); await approveSession(uid, token); }
  const list = Object.entries(devices).map(([k, d]) => ({ id: k.slice(0, 12), name: d.name, ua: d.ua, lastAt: d.lastAt, at: d.at, current: k === h })).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  const at = Number(token.auth_time || 0);
  const revoked = !!(sec.revokedAt && at < sec.revokedAt);
  const approved = !revoked && (trusted || !sec.twoStep || !!(sec.sessions || {})[String(at)]);
  return { twoStep: !!sec.twoStep, trusted, approved, revoked, devices: list };
});
/** Mark this browser as trusted (after a password login when 2-step is off, or after the email-link confirmation). */
exports.trustDevice = onCallRaw(async (req) => {
  const { uid, token } = requireAuth(req);
  if (token.role === "device") throw new HttpsError("permission-denied", "Not for device accounts.");
  const tok = String(req.data?.deviceToken || ""); if (tok.length < 16) throw new HttpsError("invalid-argument", "Bad token.");
  const ref = db.doc(`userSecurity/${uid}`);
  const snap = await ref.get(); const sec = snap.data() || {};
  // 2-step on → a new browser can only be trusted through confirmTwoStep (email link)
  if (sec.twoStep) throw new HttpsError("permission-denied", "Confirm the login from your email first.");
  const devices = sec.devices || {};
  const h = trustHash(uid, tok);
  devices[h] = { name: String(req.data?.name || "").slice(0, 60) || "Browser", ua: String(req.data?.ua || "").slice(0, 160), at: Date.now(), lastAt: Date.now() };
  // keep the newest TRUST_MAX
  const keep = Object.entries(devices).sort((a, b) => (b[1].lastAt || 0) - (a[1].lastAt || 0)).slice(0, TRUST_MAX);
  if (snap.exists) await ref.update({ devices: Object.fromEntries(keep), updatedAt: FieldValue.serverTimestamp() });
  else await ref.set({ devices: Object.fromEntries(keep), twoStep: false, updatedAt: FieldValue.serverTimestamp() });
  await approveSession(uid, token);
  if (!snap.exists || !(sec.devices || {})[h]) {
    for (const sid of await ownerStoreIds(uid)) notifyTelegram(sid, "security", `🔐 New owner login on ${devices[h].name}. Not you? Open Settings → Owner login security → Log out everywhere.`, { force: true }).catch(() => {});
  }
  return { ok: true };
});
/**
 * 2-step confirmation. The password session (not yet approved) sends the one-time code from the email link.
 * We redeem it with Identity Toolkit and verify the resulting ID token with the Admin SDK (audience = this project),
 * so only someone who opened the email can approve a session. The code is single-use.
 */
exports.confirmTwoStep = onCallRaw(async (req) => {
  const { uid, token } = requireAuth(req);
  if (token.role === "device") throw new HttpsError("permission-denied", "Not allowed.");
  const oobCode = String(req.data?.oobCode || ""), apiKey = String(req.data?.apiKey || "");
  const email = String(token.email || "").toLowerCase();
  if (!oobCode || !apiKey || !email) throw new HttpsError("invalid-argument", "Missing login link.");
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithEmailLink?key=${encodeURIComponent(apiKey)}`, {
    method: "POST", headers: { "content-type": "application/json", referer: (req.rawRequest?.headers?.origin || SITE) + "/" }, body: JSON.stringify({ email, oobCode }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.idToken) {
    const m = j.error?.message || "";
    throw new HttpsError("failed-precondition", /INVALID_OOB_CODE|EXPIRED_OOB_CODE/.test(m) ? "This login link has expired or was already used. Log in again to get a new one." : `Couldn't confirm the link (${m || res.status}).`);
  }
  const proof = await admin.auth().verifyIdToken(j.idToken);   // checks it belongs to THIS project
  if (proof.uid !== uid) throw new HttpsError("permission-denied", "This link is for a different account.");
  const tok = String(req.data?.deviceToken || "");
  const ref = db.doc(`userSecurity/${uid}`); const snap = await ref.get(); const sec = snap.data() || {};
  if (tok.length >= 16) {
    const h = trustHash(uid, tok);
    const devices = { ...(sec.devices || {}), [h]: { name: String(req.data?.name || "").slice(0, 60) || "Browser", ua: String(req.data?.ua || "").slice(0, 160), at: Date.now(), lastAt: Date.now() } };
    const keep = Object.entries(devices).sort((a, b) => (b[1].lastAt || 0) - (a[1].lastAt || 0)).slice(0, TRUST_MAX);
    if (snap.exists) await ref.update({ devices: Object.fromEntries(keep) }); else await ref.set({ devices: Object.fromEntries(keep), twoStep: true });
    for (const sid of await ownerStoreIds(uid)) notifyTelegram(sid, "security", `🔐 New owner login confirmed by email on ${devices[h].name}. Not you? Settings → Owner login security → Log out everywhere.`, { force: true }).catch(() => {});
  }
  await approveSession(uid, token);
  return { ok: true };
});
exports.setTwoStep = onCall(async (req) => {
  const { uid, token } = requireAuth(req);
  if (token.role !== "owner") throw new HttpsError("permission-denied", "Owner only.");
  if (!token.email) throw new HttpsError("failed-precondition", "Your account needs an email address for 2-step.");
  await db.doc(`userSecurity/${uid}`).set({ twoStep: !!req.data?.on, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  await approveSession(uid, token);
  for (const sid of await ownerStoreIds(uid)) audit(sid, { name: token.email, staffId: "owner" }, req.data?.on ? "two_step_on" : "two_step_off", {}).catch(() => {});
  return { ok: true };
});
/** Forget one trusted browser (by short id). */
exports.forgetTrustedDevice = onCall(async (req) => {
  const { uid, token } = requireAuth(req);
  if (token.role === "device") throw new HttpsError("permission-denied", "Not allowed.");
  const id = String(req.data?.id || "");
  const ref = db.doc(`userSecurity/${uid}`); const sec = (await ref.get()).data() || {};
  const devices = Object.fromEntries(Object.entries(sec.devices || {}).filter(([k]) => k.slice(0, 12) !== id));
  await ref.update({ devices });
  return { ok: true };
});
/** Log out everywhere: revoke all refresh tokens and forget every trusted browser (including this one). */
exports.logoutEverywhere = onCallRaw(async (req) => {
  const { uid, token } = requireAuth(req);
  if (token.role === "device") throw new HttpsError("permission-denied", "Not allowed.");
  await admin.auth().revokeRefreshTokens(uid);
  const ref = db.doc(`userSecurity/${uid}`);
  await ref.set({ revokedAt: Math.floor(Date.now() / 1000) + 1, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  await ref.update({ devices: {}, sessions: {} });
  secCache.delete(uid);
  for (const sid of await ownerStoreIds(uid)) audit(sid, { name: token.email || "owner", staffId: "owner" }, "logout_everywhere", {}).catch(() => {});
  return { ok: true };
});

/** Public "notify me" list for upcoming business types (e.g. Stay). One entry per contact per type. */
exports.joinWaitlist = onCallRaw(async (req) => {
  const type = String(req.data?.type || "").replace(/[^a-z]/g, "").slice(0, 20);
  const contact = String(req.data?.contact || "").trim().slice(0, 80);
  const phone = contact.replace(/[^\d+]/g, "");
  const ok = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact) || /^(\+?63|0)9\d{9}$/.test(phone);
  if (!type || !ok) throw new HttpsError("invalid-argument", "Enter a valid PH mobile number (09…) or email.");
  const key = crypto.createHash("sha256").update(`${type}:${contact.toLowerCase()}`).digest("hex").slice(0, 32);
  await db.doc(`waitlist/${key}`).set({ type, contact, at: FieldValue.serverTimestamp() }, { merge: true });
  return { ok: true };
});

exports.createDeviceCode = onCall(async (req) => {
  const { storeId, uid } = requireOwner(req);
  const name = String(req.data?.name || "").trim().slice(0, 40) || "Tablet";
  let code = deviceCode();
  for (let i = 0; i < 5 && (await db.doc(`deviceCodes/${code}`).get()).exists; i++) code = deviceCode();
  await db.doc(`deviceCodes/${code}`).set({ storeId, name, by: uid, expiresAt: Date.now() + DEVICE_CODE_MS, used: false, createdAt: FieldValue.serverTimestamp() });
  return { code, expiresAt: Date.now() + DEVICE_CODE_MS };
});

async function makeDevice(storeId, name) {
  const deviceId = `dev_${storeId.slice(0, 8)}_${crypto.randomBytes(5).toString("hex")}`;
  const secret = crypto.randomBytes(24).toString("hex");
  await admin.auth().createUser({ uid: deviceId, displayName: name });
  await admin.auth().setCustomUserClaims(deviceId, { storeId, role: "device" });
  await db.doc(`stores/${storeId}/private/devices`).set({ [deviceId]: { name, hash: secretHash(storeId, secret), createdAt: Date.now(), lastSeen: Date.now(), revoked: false } }, { merge: true });
  await db.doc(`stores/${storeId}/devices/${deviceId}`).set({ name, createdAt: FieldValue.serverTimestamp(), lastSeen: FieldValue.serverTimestamp(), revoked: false });
  const customToken = await admin.auth().createCustomToken(deviceId, { storeId, role: "device" });
  return { deviceId, secret, customToken, name };
}

/** Tablet side: redeem the 6-digit code (no login needed). */
exports.redeemDeviceCode = onCall(async (req) => {
  const code = String(req.data?.code || "").replace(/\D/g, "");
  if (code.length !== 6) throw new HttpsError("invalid-argument", "Enter the 6-digit code.");
  const ref = db.doc(`deviceCodes/${code}`);
  const snap = await ref.get();
  const d = snap.data();
  if (!snap.exists || d.used || d.expiresAt < Date.now()) throw new HttpsError("not-found", "This code is invalid or expired. Ask the owner for a new one.");
  await ref.set({ used: true, usedAt: FieldValue.serverTimestamp() }, { merge: true });
  const name = String(req.data?.name || d.name || "Tablet").trim().slice(0, 40);
  return makeDevice(d.storeId, name);
});

/** Owner already signed in on this tablet: switch it to a device login in one tap. */
exports.setupThisDevice = onCall(async (req) => {
  const { storeId } = requireOwner(req);
  const name = String(req.data?.name || "Tablet").trim().slice(0, 40);
  return makeDevice(storeId, name);
});

/** Sign a device back in with its saved secret (after an owner session on the same tablet, or a new day). */
exports.deviceSignIn = onCall(async (req) => {
  const deviceId = String(req.data?.deviceId || ""), secret = String(req.data?.secret || "");
  const m = deviceId.match(/^dev_([A-Za-z0-9]{1,8})_/);
  if (!m || !secret) throw new HttpsError("invalid-argument", "Bad device.");
  // the store is found from the auth user's claims (no login needed here, so look it up by uid)
  let user; try { user = await admin.auth().getUser(deviceId); } catch { throw new HttpsError("not-found", "This device was removed. Set it up again."); }
  const storeId = user.customClaims?.storeId;
  const rec = storeId ? ((await db.doc(`stores/${storeId}/private/devices`).get()).data() || {})[deviceId] : null;
  if (!rec || rec.revoked || rec.hash !== secretHash(storeId, secret)) throw new HttpsError("permission-denied", "This device was removed. Ask the owner to set it up again.");
  await db.doc(`stores/${storeId}/private/devices`).set({ [deviceId]: { lastSeen: Date.now() } }, { merge: true });
  db.doc(`stores/${storeId}/devices/${deviceId}`).set({ lastSeen: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
  return { customToken: await admin.auth().createCustomToken(deviceId, { storeId, role: "device" }) };
});

exports.revokeDevice = onCall(async (req) => {
  const { storeId } = requireOwner(req);
  const deviceId = String(req.data?.deviceId || "");
  if (!deviceId.startsWith("dev_")) throw new HttpsError("invalid-argument", "Bad device.");
  const user = await admin.auth().getUser(deviceId).catch(() => null);
  if (!user || user.customClaims?.storeId !== storeId) throw new HttpsError("permission-denied", "Not your device.");
  await admin.auth().updateUser(deviceId, { disabled: true });
  await admin.auth().revokeRefreshTokens(deviceId);
  await db.doc(`stores/${storeId}/private/devices`).set({ [deviceId]: { revoked: true } }, { merge: true });
  await db.doc(`stores/${storeId}/devices/${deviceId}`).set({ revoked: true, revokedAt: FieldValue.serverTimestamp() }, { merge: true });
  return { ok: true };
});

exports.createStaffUser = onCall(async (req) => {
  const { storeId } = requireOwner(req);
  const d = req.data || {};
  const email = String(d.email || "").trim().toLowerCase();
  const password = String(d.password || "");
  const name = String(d.name || "").trim().slice(0, 60);
  const role = String(d.role || "staff");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpsError("invalid-argument", "Invalid email.");
  if (password.length < 6) throw new HttpsError("invalid-argument", "Password must be at least 6 characters.");
  if (!STAFF_ROLES.includes(role)) throw new HttpsError("invalid-argument", "Invalid role.");

  // limit per subscription
  const subSnap = await db.doc(`stores/${storeId}/subscription/current`).get();
  const limit = subSnap.exists ? subSnap.data().limits?.staff ?? 3 : 3;
  const existing = await db.collection("users").where("storeId", "==", storeId).get();
  if (existing.size - 1 >= limit) throw new HttpsError("resource-exhausted", `Your plan allows up to ${limit} staff accounts.`);

  let user;
  try {
    user = await admin.auth().createUser({ email, password, displayName: name || undefined });
  } catch (e) {
    if (e.code === "auth/email-already-exists") throw new HttpsError("already-exists", "This email already has an account.");
    throw new HttpsError("internal", e.message);
  }
  await admin.auth().setCustomUserClaims(user.uid, { storeId, role });
  await db.doc(`users/${user.uid}`).set({ email, name: name || null, storeId, role, createdAt: FieldValue.serverTimestamp() });
  logger.info("staff created", { storeId, uid: user.uid, role });
  return { uid: user.uid };
});

exports.removeStaffUser = onCall(async (req) => {
  const { storeId, uid: me } = requireOwner(req);
  const uid = String(req.data?.uid || "");
  if (!uid || uid === me) throw new HttpsError("invalid-argument", "Invalid user.");
  const snap = await db.doc(`users/${uid}`).get();
  if (!snap.exists || snap.data().storeId !== storeId || snap.data().role === "owner") {
    throw new HttpsError("permission-denied", "You cannot remove this user.");
  }
  await admin.auth().deleteUser(uid).catch(() => {});
  await db.doc(`users/${uid}`).delete();
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Staff with PIN (like the reference app): stores/{id}/staff/{staffId} = { name, roles, active }
// The PIN hash lives in stores/{id}/private/staffPins (not readable by the client).
// ---------------------------------------------------------------------------
const ROLES = ["manager", "crew", "kitchen", "barista", "rider", "stylist", "dispatch", "cleaner"];
const pinHash = (storeId, pin) => crypto.createHash("sha256").update(`${storeId}:${pin}`).digest("hex");

function cleanSchedule(sc) {
  if (!sc || typeof sc !== "object") return null;
  const t = (v) => (/^\d{2}:\d{2}$/.test(String(v || "")) ? String(v) : null);
  const days = {}; for (const k of WEEK) { const x = sc.days?.[k]; if (x) days[k] = { on: !!x.on, from: t(x.from), to: t(x.to) }; }
  const leaves = [...new Set((Array.isArray(sc.leaves) ? sc.leaves : []).map(String).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x)))].sort().slice(-120);
  return { days, breakFrom: t(sc.breakFrom), breakTo: t(sc.breakTo), leaves };
}
/** Counter / manager: mark a stylist absent today (or undo) */
exports.setStylistLeave = onCall(async (req) => {
  const who = await staffFrom(req);
  if (!hasRole(who, "crew")) throw new HttpsError("permission-denied", "Only the counter or a manager can do this.");
  const ref = db.doc(`stores/${who.storeId}/staff/${String(req.data?.staffId || "")}`); const st = (await ref.get()).data();
  if (!st) throw new HttpsError("not-found", "Staff not found.");
  const ymd = /^\d{4}-\d{2}-\d{2}$/.test(String(req.data?.date || "")) ? String(req.data.date) : new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  const sc = st.schedule || { days: {}, leaves: [] }; const leaves = new Set(sc.leaves || []);
  const off = req.data?.off !== false; if (off) leaves.add(ymd); else leaves.delete(ymd);
  await ref.update({ schedule: cleanSchedule({ ...sc, leaves: [...leaves] }), updatedAt: FieldValue.serverTimestamp() });
  await audit(who.storeId, who, off ? "stylist_leave" : "stylist_leave_undo", { summary: `${st.name} ${ymd}` });
  return { ok: true, date: ymd, off };
});
exports.upsertStaff = onCall(async (req) => {
  const { storeId } = requireOwner(req);
  const d = req.data || {};
  const name = String(d.name || "").trim().slice(0, 40);
  const roles = (Array.isArray(d.roles) ? d.roles : []).filter((r) => ROLES.includes(r));
  const pin = d.pin != null && d.pin !== "" ? String(d.pin) : null;
  if (name.length < 2) throw new HttpsError("invalid-argument", "Enter a name.");
  if (!roles.length) throw new HttpsError("invalid-argument", "Select at least one role.");
  if (pin !== null && !/^\d{4,6}$/.test(pin)) throw new HttpsError("invalid-argument", "PIN must be 4–6 digits.");

  const col = db.collection(`stores/${storeId}/staff`);
  const ref = d.id ? col.doc(String(d.id)) : col.doc();
  const existing = await ref.get();
  if (!existing.exists && !pin) throw new HttpsError("invalid-argument", "A PIN is required for new staff.");

  // limit per plan
  if (!existing.exists) {
    const subSnap = await db.doc(`stores/${storeId}/subscription/current`).get();
    const limit = subSnap.exists ? subSnap.data().limits?.staff ?? 3 : 3;
    const count = (await col.where("active", "==", true).get()).size;
    if (count >= limit) throw new HttpsError("resource-exhausted", `Your plan allows up to ${limit} staff. Upgrade to add more.`);
  }
  const profile = {
    skills: (Array.isArray(d.skills) ? d.skills : []).map(String).slice(0, 50),
    photoUrl: d.photoUrl ? String(d.photoUrl).slice(0, 500) : null,
    bio: String(d.bio || "").slice(0, 200),
    showToCustomers: d.showToCustomers !== false,
    salary: { basicPerDay: Math.max(0, Number(d.salary?.basicPerDay) || 0), allowancePerDay: Math.max(0, Number(d.salary?.allowancePerDay) || 0), commission: d.salary?.commission !== false },
    sortOrder: Number(d.sortOrder) || 0,
    ...(d.schedule !== undefined ? { schedule: cleanSchedule(d.schedule) } : {}),
    ...(d.homeService !== undefined ? { homeService: !!d.homeService } : {}),
    ...(d.gender !== undefined ? { gender: ["female", "male"].includes(d.gender) ? d.gender : null } : {}),
    ...(d.payType !== undefined ? { payType: d.payType === "oncall" ? "oncall" : "daily" } : {}),
  };
  if (pin) {
    const pins = (await db.doc(`stores/${storeId}/private/staffPins`).get()).data() || {};
    const h = pinHash(storeId, pin);
    const clash = Object.entries(pins).find(([id, hash]) => id !== ref.id && hash === h);
    if (clash) {
      const other = await db.doc(`stores/${storeId}/staff/${clash[0]}`).get();
      if (other.exists && other.data().active !== false) throw new HttpsError("already-exists", "That PIN is already used by another staff member. Each staff needs their own PIN.");
    }
  }
  await ref.set({ name, roles, active: d.active !== false, ...profile, updatedAt: FieldValue.serverTimestamp(), ...(existing.exists ? {} : { createdAt: FieldValue.serverTimestamp(), lastAssignedAt: null, jobsTotal: 0 }) }, { merge: true });
  if (pin) await db.doc(`stores/${storeId}/private/staffPins`).set({ [ref.id]: pinHash(storeId, pin) }, { merge: true });
  return { id: ref.id };
});

// ---------- staff invite link: owner shares a link/QR, the employee sets their own name + PIN ----------
const INVITE_DAYS = 7;
exports.createStaffInvite = onCall(async (req) => {
  const { storeId } = requireOwner(req);
  const roles = (Array.isArray(req.data?.roles) ? req.data.roles : []).filter((r) => ROLES.includes(r));
  if (!roles.length) throw new HttpsError("invalid-argument", "Select at least one role.");
  const open = await db.collection("staffInvites").where("storeId", "==", storeId).get();
  if (open.docs.filter((d) => !d.data().usedAt && d.data().expiresAt > Date.now()).length >= 20) throw new HttpsError("resource-exhausted", "Too many open invites. Revoke some first.");
  const token = crypto.randomBytes(18).toString("base64url");
  const inv = { storeId, roles, note: String(req.data?.note || "").slice(0, 40), createdAt: Date.now(), expiresAt: Date.now() + INVITE_DAYS * 86400e3, usedAt: null, staffId: null };
  await db.doc(`staffInvites/${token}`).set(inv);
  return { token, expiresAt: inv.expiresAt };
});
exports.listStaffInvites = onCall(async (req) => {
  const { storeId } = requireOwner(req);
  const snap = await db.collection("staffInvites").where("storeId", "==", storeId).get();
  return { invites: snap.docs.map((d) => ({ token: d.id, ...d.data() })).filter((x) => !x.usedAt && x.expiresAt > Date.now()).sort((a, b) => b.createdAt - a.createdAt) };
});
exports.revokeStaffInvite = onCall(async (req) => {
  const { storeId } = requireOwner(req);
  const ref = db.doc(`staffInvites/${String(req.data?.token || "x")}`); const inv = (await ref.get()).data();
  if (!inv || inv.storeId !== storeId) throw new HttpsError("not-found", "Invite not found.");
  await ref.delete(); return { ok: true };
});
async function openInvite(token) {
  if (!/^[A-Za-z0-9_-]{16,40}$/.test(String(token || ""))) throw new HttpsError("not-found", "This invite link is not valid.");
  const ref = db.doc(`staffInvites/${token}`); const inv = (await ref.get()).data();
  if (!inv) throw new HttpsError("not-found", "This invite link is not valid or was revoked. Ask the owner for a new one.");
  if (inv.usedAt) throw new HttpsError("failed-precondition", "This invite was already used. Ask the owner for a new one.");
  if (inv.expiresAt < Date.now()) throw new HttpsError("deadline-exceeded", "This invite has expired. Ask the owner for a new one.");
  const store = (await db.doc(`stores/${inv.storeId}`).get()).data();
  if (!store) throw new HttpsError("not-found", "Store not found.");
  return { ref, inv, store };
}
/** public: show what the invite is for (store name + roles) */
exports.getStaffInvite = onCall(async (req) => {
  const { inv, store } = await openInvite(req.data?.token);
  return { storeName: store.name, logoUrl: store.logoUrl || null, slug: store.slug, mode: store.mode, roles: inv.roles, expiresAt: inv.expiresAt };
});
/** public: employee accepts the invite → staff profile + PIN (single use) */
exports.acceptStaffInvite = onCall(async (req) => {
  const { ref, inv, store } = await openInvite(req.data?.token);
  const storeId = inv.storeId;
  const name = String(req.data?.name || "").trim().slice(0, 40), pin = String(req.data?.pin || "");
  if (name.length < 2) throw new HttpsError("invalid-argument", "Enter your name.");
  if (!/^\d{4,6}$/.test(pin)) throw new HttpsError("invalid-argument", "PIN must be 4–6 digits.");
  const col = db.collection(`stores/${storeId}/staff`);
  const subSnap = await db.doc(`stores/${storeId}/subscription/current`).get();
  const limit = subSnap.exists ? subSnap.data().limits?.staff ?? 3 : 3;
  const active = (await col.where("active", "==", true).get()).docs;
  if (active.length >= limit) throw new HttpsError("resource-exhausted", "The shop has reached its staff limit. Please tell the owner.");
  if (active.some((d) => (d.data().name || "").toLowerCase() === name.toLowerCase())) throw new HttpsError("already-exists", "Someone with that name is already on the team. Add your last name or initial.");
  const pins = (await db.doc(`stores/${storeId}/private/staffPins`).get()).data() || {};
  const h = pinHash(storeId, pin);
  if (Object.entries(pins).some(([id, hash]) => hash === h && active.some((d) => d.id === id))) throw new HttpsError("already-exists", "That PIN is already used. Pick a different one.");
  const sref = col.doc();
  await db.runTransaction(async (tx) => {
    const fresh = (await tx.get(ref)).data();
    if (!fresh || fresh.usedAt) throw new HttpsError("failed-precondition", "This invite was already used.");
    if (req.data?.agreed !== true) throw new HttpsError("failed-precondition", "Please agree to the shop rules.");
    tx.set(sref, { rulesAgreedAt: Date.now(), name, roles: inv.roles, active: true, skills: [], photoUrl: null, bio: "", showToCustomers: true, salary: { basicPerDay: 0, commission: true }, sortOrder: 0, joinedViaInvite: true, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), lastAssignedAt: null, jobsTotal: 0 });
    tx.set(db.doc(`stores/${storeId}/private/staffPins`), { [sref.id]: h }, { merge: true });
    tx.update(ref, { usedAt: Date.now(), staffId: sref.id });
  });
  await audit(storeId, { name, staffId: sref.id }, "staff_joined", { summary: `${name} joined via invite (${inv.roles.join(", ")})` }).catch(() => {});
  return { ok: true, storeName: store.name, slug: store.slug, roles: inv.roles };
});

/** Staff resigned: block their PIN everywhere right away but keep their name in reports, payroll and history. */
exports.setStaffActive = onCall(async (req) => {
  const { storeId, token } = requireOwner(req);
  const id = String(req.data?.id || ""), active = !!req.data?.active;
  const ref = db.doc(`stores/${storeId}/staff/${id}`); const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Staff not found.");
  if (active) await ref.update({ active: true, resignedAt: null, updatedAt: FieldValue.serverTimestamp() });
  else {
    await ref.update({ active: false, onDuty: false, resignedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    // old PIN can never be used again (a new one is set when re-hired)
    await db.doc(`stores/${storeId}/private/staffPins`).set({ [id]: FieldValue.delete() }, { merge: true });
    await Promise.all([db.doc(`stores/${storeId}/duty/${id}`).delete().catch(() => {}), db.doc(`stores/${storeId}/duties/${id}`).set({ status: "off" }, { merge: true }).catch(() => {})]);
  }
  await audit(storeId, { name: token.email || "Owner", staffId: "owner" }, active ? "staff_rehired" : "staff_resigned", { staff: snap.data().name });
  return { ok: true };
});

exports.removeStaff = onCall(async (req) => {
  const { storeId } = requireOwner(req);
  const id = String(req.data?.id || "");
  if (!id) throw new HttpsError("invalid-argument", "Missing id.");
  await db.doc(`stores/${storeId}/staff/${id}`).delete();
  await db.doc(`stores/${storeId}/private/staffPins`).set({ [id]: FieldValue.delete() }, { merge: true });
  return { ok: true };
});

// verifyPin — called by kitchen/crew screens on a shared device (already logged in to the store)
exports.verifyPin = onCall(HOT, async (req) => {
  const { token } = requireAuth(req);
  const storeId = token.storeId;
  if (!storeId) throw new HttpsError("permission-denied", "No store.");
  const staffId = String(req.data?.staffId || "");
  const pin = String(req.data?.pin || "");
  const [staffSnap, pinsSnap] = await Promise.all([db.doc(`stores/${storeId}/staff/${staffId}`).get(), db.doc(`stores/${storeId}/private/staffPins`).get()]);
  if (!staffSnap.exists || staffSnap.data().active === false) throw new HttpsError("not-found", "Staff not found.");
  const hash = pinsSnap.exists ? pinsSnap.data()[staffId] : null;
  // lockout: 10 wrong tries → locked for 15 minutes
  const failRef = db.doc(`stores/${storeId}/private/pinFails`);
  const fails = ((await failRef.get()).data() || {})[staffId] || {};
  if (fails.lockedUntil && fails.lockedUntil > Date.now()) throw new HttpsError("resource-exhausted", `Too many wrong PINs. Try again in ${Math.ceil((fails.lockedUntil - Date.now()) / 60000)} min, or ask the owner.`);
  if (!hash || hash !== pinHash(storeId, pin)) {
    const n = (fails.count || 0) + 1;
    await failRef.set({ [staffId]: n >= PIN_MAX_TRIES ? { count: 0, lockedUntil: Date.now() + 15 * 60000 } : { count: n, lockedUntil: 0 } }, { merge: true });
    logger.warn("bad pin", { storeId, staffId, n });
    if (n >= PIN_MAX_TRIES) { notifyTelegram(storeId, "shift", `🔒 ${staffSnap.data().name}'s PIN was locked for 15 minutes after ${PIN_MAX_TRIES} wrong tries.`); throw new HttpsError("resource-exhausted", "Too many wrong PINs. Locked for 15 minutes."); }
    throw new HttpsError("permission-denied", `Wrong PIN. ${PIN_MAX_TRIES - n} ${PIN_MAX_TRIES - n === 1 ? "try" : "tries"} left.`);
  }
  if (fails.count) await failRef.set({ [staffId]: { count: 0, lockedUntil: 0 } }, { merge: true });
  const s = staffSnap.data();
  // plan limit on staff PINs: the first N active staff (oldest first) can log in
  { const st = (await db.doc(`stores/${storeId}`).get()).data() || {}; const { lim, plan } = await storeLimits(storeId, st.mode);
    const max = lim.staff ?? UNLIMITED;
    if (max < UNLIMITED) {
      const all = (await db.collection(`stores/${storeId}/staff`).where("active", "==", true).get()).docs.sort((a, b) => (a.data().createdAt?.toMillis?.() || 0) - (b.data().createdAt?.toMillis?.() || 0));
      const idx = all.findIndex((x) => x.id === staffId);
      if (idx >= max) throw new HttpsError("resource-exhausted", max <= 1 ? `The ${PLANS[plan]?.name || "Free"} plan has 1 PIN (the owner's). Upgrade to Starter to add staff.` : `Only ${max} staff PINs can log in on the ${PLANS[plan]?.name} plan. Ask the owner to upgrade or add a staff slot.`);
    } }
  const roles = s.roles || [];
  return { staffId, name: s.name, roles, token: await signStaff(storeId, { s: staffId, n: s.name, r: roles }) };
});

// ---------------------------------------------------------------------------
// Staff session tokens — proof of which staff (and role) did an action, signed by the server after the PIN.
// Owner accounts without a staff token act as owner (dashboard).
// ---------------------------------------------------------------------------
const PIN_MAX_TRIES = 10;
/** paymentMethod (type) + id + name for a chosen method id ("cash", a store payment method id, or gcash/maya/card) */
function payFields(store, methodId) {
  const m = (store?.settings?.payments?.methods || []).find((x) => x.id === methodId);
  if (m) return { paymentMethod: m.type, paymentMethodId: m.id, paymentMethodName: m.name };
  const names = { cash: "Cash", gcash: "GCash", maya: "Maya", card: "Card", bank: "Bank" };
  const id = names[methodId] ? methodId : "cash";
  return { paymentMethod: id, paymentMethodId: id, paymentMethodName: names[id] };
}
const STAFF_TOKEN_HOURS = 14;
async function staffKey(storeId) {
  const ref = db.doc(`stores/${storeId}/private/staffKey`);
  const snap = await ref.get();
  if (snap.exists && snap.data().secret) return snap.data().secret;
  const secret = crypto.randomBytes(32).toString("hex");
  await ref.set({ secret, createdAt: FieldValue.serverTimestamp() });
  return secret;
}
async function signStaff(storeId, payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, e: Date.now() + STAFF_TOKEN_HOURS * 3600e3 })).toString("base64url");
  const sig = crypto.createHmac("sha256", await staffKey(storeId)).update(body).digest("base64url");
  return `${body}.${sig}`;
}
const ALL_ROLES = ["manager", "crew", "kitchen", "barista", "dispatch", "rider", "stylist", "cleaner"];
/** Who is doing this? → { staffId, name, roles, owner, storeId } (throws if not allowed) */
async function staffFrom(req) {
  const { token } = requireAuth(req);
  const storeId = token.storeId;
  if (!storeId) throw new HttpsError("permission-denied", "Log in to the store first.");
  const st = String(req.data?.staffToken || "");
  if (st) {
    const [body, sig] = st.split(".");
    const good = body && sig && crypto.createHmac("sha256", await staffKey(storeId)).update(body).digest("base64url") === sig;
    if (!good) throw new HttpsError("unauthenticated", "Your staff login expired. Please log in again with your PIN.");
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    if (p.e < Date.now()) throw new HttpsError("unauthenticated", "Your staff login expired. Please log in again with your PIN.");
    const staffSnap = await db.doc(`stores/${storeId}/staff/${p.s}`).get();
    if (!staffSnap.exists || staffSnap.data().active === false) throw new HttpsError("permission-denied", "This staff account was removed.");
    if (staffSnap.data().planLocked) throw new HttpsError("permission-denied", "This staff PIN is paused — the shop's plan has fewer staff slots now. Ask the owner.");
    return { storeId, staffId: p.s, name: p.n, roles: staffSnap.data().roles || p.r || [], owner: false };
  }
  if (token.role === "owner") { // one-phone owners act as their own staff profile (their jobs, their commission)
    const me = (await db.collection(`stores/${storeId}/staff`).where("isOwner", "==", true).limit(1).get()).docs[0];
    return { storeId, staffId: me?.id || "owner", name: me?.data().name || "Owner", roles: ALL_ROLES, owner: true };
  }
  throw new HttpsError("unauthenticated", "Please log in with your PIN.");
}
const hasRole = (who, ...roles) => who.owner || who.roles.includes("manager") || roles.some((r) => who.roles.includes(r));
async function audit(storeId, who, action, detail = {}) {
  try { await db.collection(`stores/${storeId}/audit`).add({ at: FieldValue.serverTimestamp(), action, by: who?.name || "System", staffId: who?.staffId || null, ...detail }); } catch (e) { logger.warn("audit", e.message); }
}


/** Every refund is written to stores/{id}/refunds so it shows in the shift count and reports. */
async function recordRefund(storeId, who, { amount, method, refNo, reason, orderNo, orderId, source }) {
  const amt = Math.max(0, Number(amount) || 0);
  if (!amt) return null;
  const ref = await db.collection(`stores/${storeId}/refunds`).add({ amount: amt, method: String(method || "cash").slice(0, 20), refNo: String(refNo || "").slice(0, 60), reason: String(reason || "").slice(0, 200), orderNo: orderNo || null, orderId: orderId || null, source, by: who?.name || "Owner", staffId: who?.staffId || "owner", at: FieldValue.serverTimestamp() });
  notifyTelegram(storeId, "shift", `💸 Refund ₱${amt} (${method || "cash"}) for #${orderNo || "?"} by ${who?.name || "Owner"}${reason ? ` — ${reason}` : ""}`);
  return ref.id;
}
// ---------------------------------------------------------------------------
// orderOps — money-related order actions (cancel, payment, delivery fee, delivered). Checked by role on the server.
// ---------------------------------------------------------------------------
exports.orderOps = onCall(HOT, async (req) => {
  const who = await staffFrom(req);
  const { storeId } = who;
  const d = req.data || {};
  const action = String(d.action || "");
  const store = (await db.doc(`stores/${storeId}`).get()).data() || {};
  const methods = [{ id: "cash", type: "cash", name: "Cash" }, ...((store.settings?.payments?.methods || []).filter((m) => m.type !== "cash"))];
  const methodById = (id) => methods.find((m) => m.id === id) || (["gcash", "maya", "card", "bank"].includes(id) ? { id, type: id, name: { gcash: "GCash", maya: "Maya", card: "Card", bank: "Bank" }[id] } : null);
  const ids = (Array.isArray(d.orderIds) ? d.orderIds : [d.orderId]).map(String).filter(Boolean).slice(0, 30);
  if (!ids.length) throw new HttpsError("invalid-argument", "No order.");
  const refs = ids.map((id) => db.doc(`stores/${storeId}/orders/${id}`));
  const snaps = await Promise.all(refs.map((r) => r.get()));
  if (snaps.some((x) => !x.exists)) throw new HttpsError("not-found", "Order not found.");
  const orders = snaps.map((x) => ({ id: x.id, ref: x.ref, ...x.data() }));
  const o = orders[0];
  const stamp = { staffId: who.staffId, updatedAt: FieldValue.serverTimestamp() };
  const deny = (m) => { throw new HttpsError("permission-denied", m); };

  if (action === "cancel") {
    const reason = String(d.reason || "").trim().slice(0, 200);
    if (!reason) throw new HttpsError("invalid-argument", "Please give a reason.");
    if (["cancelled", "completed", "delivered", "picked_up", "claimed"].includes(o.status) && !hasRole(who)) deny("Only a manager can cancel a finished order.");
    if (o.paid && !hasRole(who)) deny("This order is already paid — only a manager can cancel it.");
    const outcome = ["walkout", "no_show", "failed_delivery"].includes(d.outcome) ? d.outcome : "cancelled";
    const riderNoShow = outcome === "failed_delivery" && who.roles.includes("rider") && o.status === "out_for_delivery" && o.riderId === who.staffId;
    if (!riderNoShow && !hasRole(who, "crew", "kitchen", "barista", "dispatch")) deny("Your role can't cancel orders.");
    // Crew can cancel a new order; once it's being prepared/served and above the limit, a manager must do it
    // (stops "customer paid cash → order cancelled → cash pocketed").
    const crewMax = Number((await db.doc(`stores/${storeId}`).get()).get("settings.incidents.crewCancelMax") ?? 300);
    if (!riderNoShow && !hasRole(who) && !["pending", "new", "unconfirmed"].includes(o.status) && (o.total || 0) > crewMax) deny(`Orders above ₱${crewMax} that are already being prepared need a manager to cancel.`);
    if ((o.total || 0) >= 500) notifyTelegram(storeId, "incident", `⚠️ Order #${o.orderNo} (₱${(o.total || 0).toLocaleString()}) was ${outcome.replace("_", " ")} by ${who.name}${o.paid ? " — it was already PAID" : ""}. Reason: ${reason}`).catch(() => {});
    await o.ref.update({ status: "cancelled", outcome, cancelReason: reason, cancelledBy: who.name, cancelledAt: FieldValue.serverTimestamp(), ...stamp });
    if (o.customerKey && outcome !== "cancelled") await db.doc(`stores/${storeId}/customers/${o.customerKey}`).set({ [outcome === "walkout" ? "walkouts" : outcome === "no_show" ? "noShows" : "failedDeliveries"]: FieldValue.increment(1), note: `${outcome.replace("_", " ")} · #${o.orderNo}`, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    if (o.customerKey && d.flag) await db.doc(`stores/${storeId}/customers/${o.customerKey}`).set({ flagged: true, note: `Bogus order #${o.orderNo}`, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    await audit(storeId, who, "cancel", { orderId: o.id, orderNo: o.orderNo, total: o.total || 0, paid: !!o.paid, outcome, reason });
    return { ok: true };
  }
  if (action === "pay") {
    if (!hasRole(who, "crew", "rider", "dispatch")) deny("Your role can't take payments.");
    const m = methodById(String(d.methodId || "cash")); if (!m) throw new HttpsError("invalid-argument", "Choose how the customer paid.");
    const batch = db.batch();
    for (const x of orders) if (!x.paid || x.balanceDue) batch.update(x.ref, { paid: true, paidAt: FieldValue.serverTimestamp(), paymentMethod: m.type, paymentMethodId: m.id, paymentMethodName: m.name, paidBy: who.name, paidAmount: x.total || 0, balanceDue: null, ...stamp });
    await batch.commit();
    await audit(storeId, who, "paid", { orderIds: ids, orderNo: orders.map((x) => x.orderNo).join(", "), total: orders.reduce((a, x) => a + (x.total || 0), 0), method: m.name });
    return { ok: true };
  }
  if (action === "verify") {
    if (!hasRole(who, "crew")) deny("Your role can't verify payments.");
    if (!o.payment) throw new HttpsError("failed-precondition", "No online payment on this order.");
    const m = methodById(o.payment.methodId) || { id: o.payment.methodId || o.payment.method, type: o.payment.method, name: o.payment.methodName };
    await o.ref.update({ paid: true, paidAt: FieldValue.serverTimestamp(), paymentMethod: m.type, paymentMethodId: m.id, paymentMethodName: m.name, "payment.status": "verified", "payment.verifiedBy": who.name, paidBy: who.name, ...stamp });
    await audit(storeId, who, "verify_payment", { orderId: o.id, orderNo: o.orderNo, total: o.total || 0, method: m.name, ref: o.payment.refNo || "" });
    return { ok: true };
  }
  if (action === "notReceived") {
    // counter checked their GCash and the money isn't there → tell the customer, keep the order on hold
    if (!hasRole(who, "crew")) deny("Your role can't check payments.");
    if (!o.payment || o.paid) throw new HttpsError("failed-precondition", "Nothing to check on this order.");
    const note = String(d.note || "").trim().slice(0, 160);
    await o.ref.update({ "payment.status": "not_received", "payment.checkedBy": who.name, "payment.checkedAt": Date.now(), "payment.note": note || null, ...stamp });
    await audit(storeId, who, "payment_not_received", { orderId: o.id, orderNo: o.orderNo, total: o.total || 0, method: o.payment.methodName || "", note });
    notifyTelegram(storeId, "incident", `❗ ${o.payment.methodName || "GCash"} payment for #${o.orderNo} (₱${(o.total || 0).toLocaleString()}) marked NOT received by ${who.name}.`).catch(() => {});
    return { ok: true };
  }
  if (action === "unpay") {
    if (!hasRole(who)) deny("Only a manager can undo a payment.");
    await o.ref.update({ paid: false, paidAt: null, paymentMethodId: null, paymentMethodName: null, ...stamp });
    await audit(storeId, who, "unpaid", { orderId: o.id, orderNo: o.orderNo, total: o.total || 0 });
    return { ok: true };
  }
  if (action === "deliveryFee") {
    if (!hasRole(who, "crew", "dispatch")) deny("Your role can't set delivery fees.");
    if (o.serviceType !== "delivery") throw new HttpsError("failed-precondition", "Not a delivery order.");
    const fee = Math.max(0, Math.min(5000, Number(d.fee) || 0));
    const total = round2(Math.max(0, (o.subtotal || 0) - (o.discounts?.voucher || 0) - (o.discounts?.incident || 0) + fee + (o.smallOrderFee || 0) + (o.laundry?.storageFee || 0)));
    await o.ref.update({ deliveryFee: fee, total, deliveryFeePending: false, deliveryFeeSetBy: who.name, ...stamp });
    await audit(storeId, who, "delivery_fee", { orderId: o.id, orderNo: o.orderNo, fee });
    return { ok: true, total };
  }
  if (action === "deliver") {
    if (!hasRole(who, "crew", "rider", "dispatch")) deny("Your role can't complete deliveries.");
    if (o.status !== "out_for_delivery") throw new HttpsError("failed-precondition", "This order is not out for delivery.");
    const patch = { status: o.type === "laundry" ? "claimed" : "delivered", deliveredAt: FieldValue.serverTimestamp(), completedAt: FieldValue.serverTimestamp(), ...stamp };
    if (o.type === "laundry") { patch["laundry.claimedAt"] = FieldValue.serverTimestamp(); patch["laundry.claimedBy"] = who.name; }
    if (who.roles.includes("rider") && !who.owner) { patch.riderId = who.staffId; patch.riderName = who.name; }
    // unpaid on arrival: cash to the rider, or the customer sends GCash/e-wallet in front of the rider (rider confirms)
    const ewallet = !o.paid && d.paidWith === "ewallet" && o.payment && !["cash", "card"].includes(o.payment.method);
    if (!o.paid && ewallet) Object.assign(patch, { paid: true, paidAt: FieldValue.serverTimestamp(), paymentMethod: o.payment.method, paymentMethodId: o.payment.methodId || o.payment.method, paymentMethodName: o.payment.methodName, "payment.status": "verified", "payment.verifiedBy": who.name, paidBy: who.name });
    else if (!o.paid) Object.assign(patch, { paid: true, paidAt: FieldValue.serverTimestamp(), paymentMethod: "cash", paymentMethodId: "cash", paymentMethodName: "Cash", cashCollected: o.total || 0, paidBy: who.name });
    await o.ref.update(patch);
    await audit(storeId, who, "delivered", { orderId: o.id, orderNo: o.orderNo, total: o.total || 0, cash: !o.paid && !ewallet, method: ewallet ? o.payment.methodName : !o.paid ? "Cash" : null });
    return { ok: true };
  }
  if (action === "vipGift") {
    if (!hasRole(who, "crew")) deny("Only counter crew or a manager can give free VIP hours.");
    if (!(await storeEntitled(storeId, "events_vip"))) throw new HttpsError("failed-precondition", "VIP rooms are not on your plan.");
    if (o.vipVoucher) throw new HttpsError("already-exists", `This order already has a voucher: ${o.vipVoucher.code}`);
    const v = await makeVipVoucher(storeId, Math.max(1, Math.min(6, parseInt(d.hours, 10) || 2)), `Free VIP hours · #${o.orderNo}`, { orderId: o.id, by: who.name });
    await o.ref.update({ vipVoucher: v, ...stamp });
    await audit(storeId, who, "vip_gift", { orderId: o.id, orderNo: o.orderNo, hours: v.hours, code: v.code });
    return { ok: true, ...v };
  }
  if (action === "ackAdd") {
    await o.ref.update({ addAlert: null, ...stamp });
    return { ok: true };
  }
  if (action === "comp") {
    if (!hasRole(who, "crew", "kitchen", "barista", "dispatch")) deny("Your role can't give free items.");
    if (!(await storeEntitled(storeId, "editorder"))) throw new HttpsError("failed-precondition", "Complimentary items are a Pro feature.");
    const text = String(d.text || "").trim().slice(0, 80);
    if (text.length < 2) throw new HttpsError("invalid-argument", "What will you give?");
    const late = !!d.late;
    if (!hasRole(who)) {
      // crew can give a few free items a day; beyond that a manager is needed (settings.incidents.maxCompsCrew, default 3)
      const cap = Number(store.settings?.incidents?.maxCompsCrew ?? 3);
      const dayStart = new Date(); dayStart.setHours(dayStart.getHours() + 8, 0, 0, 0); dayStart.setTime(dayStart.getTime() - 8 * 3600e3 - (dayStart.getTime() + 8 * 3600e3) % 86400e3);
      const mine = await db.collection(`stores/${storeId}/audit`).where("action", "==", "complimentary").where("staffId", "==", who.staffId).where("at", ">=", dayStart).get().catch(() => ({ size: 0 }));
      if (mine.size >= cap) deny(`You've given ${cap} free items today — ask a manager for more.`);
    }
    await o.ref.update({ comps: FieldValue.arrayUnion({ text, by: who.name, at: Date.now(), late }), ...stamp });
    await audit(storeId, who, "complimentary", { orderId: o.id, orderNo: o.orderNo, text });
    notifyTelegram(storeId, "newOrder", `🎁 Free item for #${o.orderNo}: ${text} (by ${who.name})`);
    return { ok: true };
  }
  if (action === "edit") {
    if (!(await storeEntitled(storeId, "editorder"))) throw new HttpsError("failed-precondition", "Editing orders is a Pro feature.");
    if (!hasRole(who, "crew")) deny("Only counter crew or a manager can edit orders.");
    if (["completed", "delivered", "picked_up", "claimed", "cancelled"].includes(o.status)) throw new HttpsError("failed-precondition", "This order is already closed.");
    if (o.paid && !hasRole(who)) deny("This order is paid — only a manager can edit it.");
    const reason = String(d.reason || "").trim().slice(0, 80) || "Changed by staff";
    const keep = Array.isArray(d.keep) ? d.keep : [];
    const old = o.items || [];
    const kept = [];
    const ch = [];
    old.forEach((l, i) => {
      const k = keep.find((x) => Number(x.i) === i);
      const qty = k ? Math.max(0, Math.min(99, parseInt(k.qty, 10) || 0)) : l.qty;
      if (qty === 0) ch.push(`removed ${l.name}`);
      else if (qty !== l.qty) ch.push(`${l.name} ${l.qty}→${qty}`);
      if (qty > 0) { const unitNet = (l.subtotal || 0) / (l.qty || 1); kept.push({ ...l, qty, subtotal: round2(unitNet * qty), ...(l.discount ? { discount: round2((l.discount / (l.qty || 1)) * qty) } : {}) }); }
    });
    const add = (Array.isArray(d.add) ? d.add : []).slice(0, 20);
    const added = add.length ? (await priceLines(storeId, add, { vip: !!o.roomId })).orderItems.map((l) => ({ ...l, addedByStaff: true })) : [];
    added.forEach((l) => ch.push(`added ${l.qty}× ${l.name}`));
    const items = [...kept, ...added];
    if (!items.length) throw new HttpsError("invalid-argument", "At least one item must remain. To cancel the whole order use Status → Cancelled.");
    let serviceType = o.serviceType;
    if (d.serviceType && d.serviceType !== o.serviceType) {
      if (o.parentId) throw new HttpsError("invalid-argument", "Change the order type on the main order.");
      const pairs = { dine_in: ["take_out"], take_out: ["dine_in"], pickup: ["delivery"], delivery: ["pickup"] };
      if (!(pairs[o.serviceType] || []).includes(d.serviceType)) throw new HttpsError("invalid-argument", "That switch is not allowed.");
      serviceType = d.serviceType;
      ch.push(`${o.serviceType.replace("_", "-")} → ${serviceType.replace("_", "-")}`);
    }
    const customer = { ...(o.customer || {}) };
    if (d.address != null && String(d.address).trim() !== (customer.address || "")) { customer.address = String(d.address).trim().slice(0, 200); ch.push("address updated"); }
    if (serviceType === "delivery" && !customer.address) throw new HttpsError("invalid-argument", "Delivery needs an address.");
    const svc = store.settings?.service || {};
    const subtotal = round2(items.reduce((a, l) => a + (l.subtotal || 0), 0));
    const smallFor = Array.isArray(svc.smallOrderFor) && svc.smallOrderFor.length ? svc.smallOrderFor : ["delivery"];
    const smallOrderFee = !o.parentId && Number(svc.smallOrderMin) > 0 && Number(svc.smallOrderFee) > 0 && smallFor.includes(serviceType) && subtotal < Number(svc.smallOrderMin) ? round2(Number(svc.smallOrderFee)) : 0;
    const deliveryFee = serviceType === "delivery" ? Math.max(0, Math.min(5000, d.deliveryFee != null && d.deliveryFee !== "" ? Number(d.deliveryFee) || 0 : o.deliveryFee || 0)) : 0;
    if (serviceType === "delivery" && deliveryFee !== (o.deliveryFee || 0)) ch.push(`delivery fee ₱${deliveryFee}`);
    const voucherDisc = Math.min(o.voucher?.discount || 0, subtotal);
    const total = round2(Math.max(0, subtotal - voucherDisc - (o.discounts?.incident || 0) + deliveryFee + smallOrderFee));
    const stations = { ...(o.stations || {}) };
    for (const l of added) if (!stations[l.station] || stations[l.station] === "ready") stations[l.station] = "pending";
    for (const st of Object.keys(stations)) if (!items.some((l) => (l.station || "kitchen") === st)) delete stations[st];
    const summary = ch.join(", ") || "updated";
    const edit = { at: Date.now(), by: who.name, reason, summary, before: o.total || 0, after: total };
    const prevPaid = o.paid ? (o.paidAmount ?? o.total ?? 0) : 0;
    const moneyPatch = o.paid ? (total > prevPaid ? { paid: false, balanceDue: round2(total - prevPaid), paidAmount: prevPaid } : total < prevPaid ? { refundDue: round2(prevPaid - total) } : {}) : {};
    await o.ref.update({
      items, subtotal, smallOrderFee, deliveryFee, total, serviceType, customer, stations,
      ...(o.voucher ? { voucher: { ...o.voucher, discount: voucherDisc }, "discounts.voucher": voucherDisc } : {}),
      ...(serviceType === "delivery" ? { deliveryFeePending: false } : {}),
      edits: [...(o.edits || []), edit].slice(-6), lastEdit: edit, ...moneyPatch, ...stamp,
    });
    await audit(storeId, who, "edit", { orderId: o.id, orderNo: o.orderNo, summary, before: o.total || 0, after: total, reason });
    return { ok: true, total, summary };
  }
  throw new HttpsError("invalid-argument", "Unknown action.");
});

// ---------------------------------------------------------------------------
// Every minute: Telegram reminder for orders nobody accepted yet, and auto-pause after N minutes.
// Every 5 minutes: items sold out "until" a time come back. Every 10 minutes: auto end shift at the set time.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// menuOps — managers change prices, add items, set photos and start dish promos from the staff screens (PIN-checked).
// Every change is logged (audit + price log old → new).
// ---------------------------------------------------------------------------
exports.menuOps = onCall(async (req) => {
  const who = await staffFrom(req);
  const { storeId } = who;
  if (!hasRole(who)) throw new HttpsError("permission-denied", "Only a manager (or the owner) can change the menu.");
  const d = req.data || {};
  const action = String(d.action || "");
  if (action === "price") {
    const ref = db.doc(`stores/${storeId}/items/${String(d.itemId || "")}`); const it = (await ref.get()).data();
    if (!it) throw new HttpsError("not-found", "Item not found.");
    const price = Math.round(Number(d.price) * 100) / 100;
    if (!(price >= 0 && price <= 50000)) throw new HttpsError("invalid-argument", "Enter a price from ₱0 to ₱50,000.");
    if (price === Number(it.price)) return { ok: true, same: true };
    await ref.update({ price, prevPrice: Number(it.price) || 0, priceChangedAt: Date.now(), priceChangedBy: who.name, updatedAt: FieldValue.serverTimestamp() });
    await db.collection(`stores/${storeId}/priceLog`).add({ itemId: ref.id, name: it.name, old: Number(it.price) || 0, new: price, by: who.name, at: FieldValue.serverTimestamp() });
    await audit(storeId, who, "price", { itemId: ref.id, name: it.name, old: Number(it.price) || 0, new: price });
    return { ok: true };
  }
  if (action === "addItem") {
    const name = String(d.name || "").trim().slice(0, 80);
    const price = Math.round(Number(d.price) * 100) / 100;
    if (name.length < 2) throw new HttpsError("invalid-argument", "Enter the item name.");
    if (!(price >= 0 && price <= 50000)) throw new HttpsError("invalid-argument", "Enter a price from ₱0 to ₱50,000.");
    const catRef = db.doc(`stores/${storeId}/categories/${String(d.categoryId || "")}`);
    if (!(await catRef.get()).exists) throw new HttpsError("not-found", "Choose a category.");
    const dup = await db.collection(`stores/${storeId}/items`).where("name", "==", name).limit(1).get();
    if (!dup.empty) throw new HttpsError("already-exists", "An item with this name already exists.");
    const n = (await db.collection(`stores/${storeId}/items`).where("categoryId", "==", catRef.id).get()).size;
    const ref = await db.collection(`stores/${storeId}/items`).add({ categoryId: catRef.id, name, price, description: String(d.description || "").trim().slice(0, 200), available: true, options: [], sortOrder: n + 1, createdAt: FieldValue.serverTimestamp(), addedBy: who.name });
    await audit(storeId, who, "item_add", { itemId: ref.id, name, price });
    return { ok: true, itemId: ref.id };
  }
  if (action === "photo") {
    const ref = db.doc(`stores/${storeId}/items/${String(d.itemId || "")}`); const it = (await ref.get()).data();
    if (!it) throw new HttpsError("not-found", "Item not found.");
    const url = String(d.url || "").trim();
    if (url && !/^https:\/\//.test(url)) throw new HttpsError("invalid-argument", "Use an https:// image link.");
    await ref.update({ imageUrl: url || null, thumbUrl: d.thumbUrl ? String(d.thumbUrl) : null, updatedAt: FieldValue.serverTimestamp() });
    await audit(storeId, who, "photo", { itemId: ref.id, name: it.name, removed: !url });
    return { ok: true };
  }
  if (action === "dishPromo") {
    if (!(await storeEntitled(storeId, "promos"))) throw new HttpsError("failed-precondition", "Dish promos are a Pro feature.");
    const days = Math.max(1, Math.min(31, parseInt(d.days, 10) || 1));
    const itemIds = (Array.isArray(d.itemIds) ? d.itemIds : []).map(String).slice(0, 80);
    const categoryIds = (Array.isArray(d.categoryIds) ? d.categoryIds : []).map(String).slice(0, 30);
    if (!itemIds.length && !categoryIds.length) throw new HttpsError("invalid-argument", "Pick the dishes.");
    let type = "percent", value = Math.round(Number(d.percent) || 0);
    if (d.promoPrice != null && d.promoPrice !== "") {
      if (itemIds.length !== 1 || categoryIds.length) throw new HttpsError("invalid-argument", "A fixed promo price is for one dish only.");
      const it = (await db.doc(`stores/${storeId}/items/${itemIds[0]}`).get()).data();
      const pp = Number(d.promoPrice);
      if (!it || !(pp > 0 && pp < Number(it.price))) throw new HttpsError("invalid-argument", "The promo price must be lower than the regular price.");
      type = "amount"; value = Math.round((Number(it.price) - pp) * 100) / 100;
    } else if (!(value >= 1 && value <= 90)) throw new HttpsError("invalid-argument", "Discount must be 1–90%.");
    const ph = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10);
    const from = ph(Date.now()), to = ph(Date.now() + (days - 1) * 86400e3);
    const ref = await db.collection(`stores/${storeId}/promos`).add({ name: String(d.name || (type === "percent" ? `${value}% off` : "Promo price")).slice(0, 60), type, value, allItems: false, itemIds, categoryIds, schedule: { dateFrom: from, dateTo: to }, badge: days === 1 ? "Today only" : `Until ${new Date(Date.now() + (days - 1) * 86400e3 + 8 * 3600e3).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`, validFor: "all", active: true, dishPromo: true, createdBy: who.name, createdAt: FieldValue.serverTimestamp() });
    await audit(storeId, who, "dish_promo", { promoId: ref.id, type, value, days, items: itemIds.length, categories: categoryIds.length });
    return { ok: true, promoId: ref.id };
  }
  if (action === "endPromo") {
    const ref = db.doc(`stores/${storeId}/promos/${String(d.promoId || "")}`);
    await ref.update({ active: false, updatedAt: FieldValue.serverTimestamp() });
    await audit(storeId, who, "promo_off", { promoId: ref.id });
    return { ok: true };
  }
  throw new HttpsError("invalid-argument", "Unknown action.");
});

/** Slow-moving items: sold ≤ 2 in the last 7 days (needs at least 7 days of orders). Not on promo, not sold out. */
exports.slowItems = onCall(async (req) => {
  const who = await staffFrom(req);
  const { storeId } = who;
  const since = new Date(Date.now() - 7 * 86400e3);
  const [oSnap, firstSnap, itSnap, prSnap] = await Promise.all([
    db.collection(`stores/${storeId}/orders`).where("createdAt", ">=", since).get(),
    db.collection(`stores/${storeId}/orders`).orderBy("createdAt", "asc").limit(1).get(),
    db.collection(`stores/${storeId}/items`).get(),
    db.collection(`stores/${storeId}/promos`).where("active", "==", true).get(),
  ]);
  const first = firstSnap.docs[0]?.data()?.createdAt?.toMillis?.() || Date.now();
  if (Date.now() - first < 7 * 86400e3) return { items: [], note: "Needs 7 days of orders first." };
  const sold = {}; oSnap.docs.forEach((x) => { const o = x.data(); if (o.test || o.status === "cancelled") return; (o.items || []).forEach((l) => { if (l.itemId) sold[l.itemId] = (sold[l.itemId] || 0) + (l.qty || 1); }); });
  const promos = prSnap.docs.map((x) => x.data()).filter((p) => promoActive(p));
  const onPromo = (id, cat) => promos.some((p) => p.allItems || (p.itemIds || []).includes(id) || (p.categoryIds || []).includes(cat));
  const items = itSnap.docs.map((x) => ({ id: x.id, ...x.data() })).filter((it) => it.available !== false && !onPromo(it.id, it.categoryId) && (sold[it.id] || 0) <= 2)
    .sort((a, b) => (sold[a.id] || 0) - (sold[b.id] || 0)).slice(0, 6).map((it) => ({ id: it.id, name: it.name, price: it.price, sold: sold[it.id] || 0 }));
  return { items };
});

/** Shift closed → Telegram summary; count mismatch → automatic incident for the manager */
exports.onShiftWrite = onDocumentWritten("stores/{storeId}/shifts/{id}", async (event) => {
  const a = event.data?.after?.data(), b = event.data?.before?.data();
  if (!a || !b || a.status === b.status) return;
  const storeId = event.params.storeId;
  const closedNow = ["closed", "pending_check"].includes(a.status) && ["open", "needs_count"].includes(b.status);
  if (!closedNow) return;
  try {
    const from = a.openedAt?.toDate?.() || new Date(Date.now() - 12 * 3600e3), to = a.closedAt?.toDate?.() || new Date();
    const snap = await db.collection(`stores/${storeId}/orders`).where("createdAt", ">=", from).get();
    const os = snap.docs.map((d) => d.data()).filter((o) => !o.test && (o.createdAt?.toDate?.() || new Date()) <= to);
    const done = os.filter((o) => ["completed", "delivered", "picked_up", "claimed"].includes(o.status));
    const bad = (k) => os.filter((o) => o.status === "cancelled" && (o.outcome || "cancelled") === k);
    const sum = (l) => l.reduce((x, o) => x + (o.total || 0), 0);
    const preps = done.map((o) => (o.readyAt?.toMillis?.() && o.acceptedAt?.toMillis?.() ? (o.readyAt.toMillis() - o.acceptedAt.toMillis()) / 60000 : null)).filter((x) => x != null && x > 0 && x < 300);
    const counts = {}; done.forEach((o) => (o.items || []).forEach((l) => (counts[l.name] = (counts[l.name] || 0) + (l.qty || 1))));
    const top = Object.entries(counts).sort((x, y) => y[1] - x[1]).slice(0, 5).map(([n, q]) => `${q}× ${n}`);
    const byM = {}; done.filter((o) => o.paid).forEach((o) => { const k = o.paymentMethodName || o.paymentMethod || "Cash"; byM[k] = (byM[k] || 0) + (o.total || 0); });
    const comps = os.flatMap((o) => o.comps || []).length;
    const lines = [
      `📊 SHIFT SUMMARY · ${a.openedByName || ""} → ${a.closedByName || ""}`,
      `Orders ${os.length} · completed ${done.length} · sales ₱${sum(done).toLocaleString()}`,
      Object.keys(byM).length ? "Paid: " + Object.entries(byM).map(([k, v]) => `${k} ₱${v.toLocaleString()}`).join(" · ") : "",
      `Cancelled ${bad("cancelled").length} · walked out ${bad("walkout").length} (₱${sum(bad("walkout")).toLocaleString()}) · no-show ${bad("no_show").length} · failed delivery ${bad("failed_delivery").length}`,
      preps.length ? `Average prep time ${Math.round(preps.reduce((x, y) => x + y, 0) / preps.length)} min` : "",
      top.length ? `Top: ${top.join(", ")}` : "",
      comps ? `Free items given: ${comps}` : "",
      a.status === "pending_check" ? `⚠️ Cash count does NOT match (max ₱${a.maxVariance}) — needs a manager check.` : "✅ Cash count matched.",
    ].filter(Boolean);
    notifyTelegram(storeId, "shift", lines.join("\n"));
    if (a.status === "pending_check") {
      const v = a.variance || {}, e = a.expected || {}, c = a.counted || {}, names = a.methodNames || {};
      const detail = Object.keys(v).filter((k) => v[k]).map((k) => `${names[k] || k}: expected ₱${e[k]}, counted ₱${c[k]} (${v[k] > 0 ? "+" : "−"}₱${Math.abs(v[k])})`).join("; ");
      await db.collection(`stores/${storeId}/incidents`).add({ source: "shift", shiftId: event.params.id, type: "cash", orderNo: "Shift", serviceType: "shift", description: `Cash count mismatch — closed by ${a.closedByName || "staff"}. ${detail}`, customerName: a.closedByName || "", total: Number(a.maxVariance) || 0, status: "open", messages: [], createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    }
  } catch (e) { logger.warn("onShiftWrite", e.message); }
});

exports.minuteTick = onSchedule({ schedule: "every 1 minutes", timeZone: "Asia/Manila" }, async () => {
  const snap = await db.collectionGroup("orders").where("status", "==", "pending").get();
  const byStore = {};
  for (const d of snap.docs) { const o = d.data(); if (o.acceptedAt || o.test || o.isScheduled) continue; const sid = d.ref.parent.parent.id; (byStore[sid] = byStore[sid] || []).push({ ref: d.ref, ...o }); }
  for (const [storeId, list] of Object.entries(byStore)) {
    try {
      const store = (await db.doc(`stores/${storeId}`).get()).data(); if (!store || store.mode !== "table") continue;
      const s = store.settings || {};
      const age = (o) => (Date.now() - (o.createdAt?.toMillis?.() || Date.now())) / 60000;
      for (const o of list) {
        if (age(o) >= 1 && (o.tgPings || 0) < 10) { await o.ref.update({ tgPings: FieldValue.increment(1) }); notifyTelegram(storeId, "newOrder", `🔔 Order #${o.orderNo} is still waiting — ${Math.floor(age(o))} min, nobody accepted it yet.`); }
      }
      const limitMin = Number(s.service?.autoPauseMin ?? 5);
      const oldest = Math.max(...list.map(age));
      if (s.service?.autoPause !== false && limitMin > 0 && oldest >= limitMin && s.kitchen?.status !== "paused") {
        await db.doc(`stores/${storeId}`).update({ "settings.kitchen": { ...(s.kitchen || {}), status: "paused", since: Date.now(), by: "Auto-pause", auto: true }, "settings.acceptOrders": false, updatedAt: FieldValue.serverTimestamp() });
        notifyTelegram(storeId, "newOrder", `⏸ Online orders AUTO-PAUSED — an order waited ${limitMin}+ minutes without being accepted. Accept it, then tap Normal on the counter to reopen.`);
      }
    } catch (e) { logger.warn("minuteTick", storeId, e.message); }
  }
});
exports.soldUntilTick = onSchedule({ schedule: "every 5 minutes", timeZone: "Asia/Manila" }, async () => {
  const snap = await db.collectionGroup("items").where("soldUntil", "<=", Date.now()).get();
  for (const d of snap.docs) await d.ref.update({ available: true, soldUntil: null, updatedAt: FieldValue.serverTimestamp() }).catch(() => {});
});
exports.autoEndShiftTick = onSchedule({ schedule: "every 10 minutes", timeZone: "Asia/Manila" }, async () => {
  const snap = await db.collectionGroup("shifts").where("status", "==", "open").get();
  for (const d of snap.docs) {
    try {
      const storeId = d.ref.parent.parent.id;
      const store = (await db.doc(`stores/${storeId}`).get()).data(); if (!store) continue;
      const cfg = store.settings?.shifts || {};
      const at = cfg.autoEnd === false ? null : cfg.autoEndAt || (store.mode === "table" ? "03:00" : null);
      if (!at) continue;
      const opened = d.data().openedAt?.toMillis?.(); if (!opened) continue;
      const [h, m] = at.split(":").map(Number);
      const ph = new Date(opened + 8 * 3600e3);
      const cut = Date.UTC(ph.getUTCFullYear(), ph.getUTCMonth(), ph.getUTCDate(), h, m) - 8 * 3600e3;
      const due = cut > opened ? cut : cut + 86400e3; // the first time the clock hits "at" after the shift opened
      if (Date.now() < due) continue;
      await d.ref.update({ status: "needs_count", autoEnded: true, closedAt: FieldValue.serverTimestamp(), closedByName: `Auto ${at}`, updatedAt: FieldValue.serverTimestamp() });
      await db.doc(`stores/${storeId}`).update({ "settings.lateUntil": 0 }).catch(() => {});
      notifyTelegram(storeId, "shift", `🌙 Shift ended automatically at ${at}. The next cashier must count the cash before starting a new shift.`);
    } catch (e) { logger.warn("autoEndShift", e.message); }
  }
});


/** 🌙 Accept late orders (after closing time) for up to 3 hours — counter crew / manager */
exports.setLateMode = onCall(async (req) => {
  const who = await staffFrom(req);
  if (!hasRole(who, "crew")) throw new HttpsError("permission-denied", "Only counter crew or a manager can do this.");
  const on = !!req.data?.on;
  const until = on ? Date.now() + Math.min(6, Math.max(1, Number(req.data?.hours) || 3)) * 3600e3 : 0;
  await db.doc(`stores/${who.storeId}`).update({ "settings.lateUntil": until, updatedAt: FieldValue.serverTimestamp() });
  await audit(who.storeId, who, "late_orders", { on, until });
  return { until };
});

// Pause / resume ordering — any staff of the store can do this (for the kitchen screen)
exports.setAcceptOrders = onCall(async (req) => {
  const { token } = requireAuth(req);
  if (!token.storeId) throw new HttpsError("permission-denied", "No store.");
  const accept = !!req.data?.accept;
  await db.doc(`stores/${token.storeId}`).update({ "settings.acceptOrders": accept, updatedAt: FieldValue.serverTimestamp() });
  return { accept };
});

// ---------------------------------------------------------------------------
// setKitchenStatus — café/restaurant counter: normal | busy (+extra min on every ticket) | paused (no new orders).
// Busy adds the extra to every accepted ticket still being made; back to normal removes it again.
// ---------------------------------------------------------------------------
exports.setKitchenStatus = onCall(async (req) => {
  const { token } = requireAuth(req);
  const storeId = token.storeId; if (!storeId) throw new HttpsError("permission-denied", "No store.");
  const d = req.data || {};
  const status = ["normal", "busy", "paused"].includes(d.status) ? d.status : "normal";
  const sref = db.doc(`stores/${storeId}`);
  const cur = (await sref.get()).data()?.settings?.kitchen || {};
  // paused keeps the current busy extra on the tickets; normal clears it; busy sets it
  const svc = (await sref.get()).data()?.settings?.service || {};
  const normalPrep = Number(svc.prepDefault) || 15, busyPrep = Number(svc.busyPrep) || 35;
  const extra = status === "busy" ? Math.max(0, busyPrep - normalPrep) : status === "paused" ? Number(cur.busyExtra) || 0 : 0;
  const snap = await db.collection(`stores/${storeId}/orders`).where("status", "in", ["pending", "preparing"]).get();
  let changed = 0; const batch = db.batch();
  snap.docs.forEach((doc) => {
    const o = doc.data();
    if (!o.acceptedAt || !o.etaMinutes) return;
    const had = Number(o.busyExtra) || 0;
    if (had === extra) return;
    batch.update(doc.ref, { etaMinutes: Math.max(1, o.etaMinutes - had + extra), busyExtra: extra, updatedAt: FieldValue.serverTimestamp() });
    changed++;
  });
  batch.update(sref, { "settings.kitchen": { status, busyExtra: extra, since: Date.now(), by: String(d.staffName || "").slice(0, 40) }, "settings.acceptOrders": status !== "paused", updatedAt: FieldValue.serverTimestamp() });
  await batch.commit();
  return { status, extra, changed };
});

// ---------------------------------------------------------------------------
// createReservation — table reservation from the customer page (anonymous auth)
// ---------------------------------------------------------------------------
const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
function refCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

exports.createReservation = onCall(withIndex("resv", async (req) => {
  await maintGuard(req);
  const { uid } = requireAuth(req);
  const d = req.data || {};
  const slug = String(d.slug || "").trim();
  const kind = ["table", "event", "vip"].includes(d.kind) ? d.kind : "table";
  const name = String(d.name || "").trim().slice(0, 60);
  const phone = String(d.phone || "").trim().slice(0, 30);
  const date = String(d.date || "");       // YYYY-MM-DD
  const time = String(d.time || "");       // HH:MM
  const pax = parseInt(d.pax, 10);
  const occasion = String(d.occasion || "").trim().slice(0, 60);
  const notes = String(d.notes || "").trim().slice(0, 300);

  if (!slug) throw new HttpsError("invalid-argument", "Missing store.");
  if (name.length < 2 || !phone) throw new HttpsError("invalid-argument", "Name and phone number are required.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) throw new HttpsError("invalid-argument", "Invalid date/time.");

  const pubSnap = await db.doc(`publicStores/${slug}`).get();
  if (!pubSnap.exists) throw new HttpsError("not-found", "Store not found.");
  const pub = pubSnap.data();
  if (pub.mode !== "table") throw new HttpsError("failed-precondition", "This store does not take reservations.");
  if (pub.locked) throw new HttpsError("failed-precondition", "Reservations are not being accepted right now."); if (pub.comingSoon && !(pub.testMode && pub.testMode.until > Date.now())) throw new HttpsError("failed-precondition", "This shop is not open yet — coming soon!");

  const scheduled = new Date(`${date}T${time}:00+08:00`);
  if (isNaN(scheduled.getTime())) throw new HttpsError("invalid-argument", "Invalid date/time.");
  if (scheduled.getTime() > Date.now() + 180 * 86400 * 1000) throw new HttpsError("invalid-argument", "Advance bookings are limited to 6 months ahead.");

  const checkLead = (ms, label) => {
    if (scheduled.getTime() < Date.now() + ms) throw new HttpsError("failed-precondition", ms ? `Bookings require at least ${label} notice.` : "This time has already passed.");
  };
  const checkHours = () => {
    const hours = pub.hours || {};
    if (!Object.keys(hours).length) return;
    // same rules as ordering: 2 ranges per day, overnight ranges, after-midnight 2nd shift
    if (!isOpenAt(hours, scheduled)) {
      const phDay = new Date(scheduled.getTime() + 8 * 3600 * 1000).getUTCDay();
      const r = rangesFor(hours, DAY_KEYS[phDay]);
      throw new HttpsError("failed-precondition", r.length ? `We're closed at that time. Open ${r.map(([a, b]) => `${a}–${b}`).join(", ")} that day.` : "The store is closed on that day.");
    }
  };

  const extra = {};
  let estimate = null, deposit = null;

  if (kind === "table") {
    const rs = pub.reservations || {};
    if (!pub.reservations || rs.enabled === false) throw new HttpsError("failed-precondition", "Table reservations are not available.");
    const maxPax = rs.maxPax || 12;
    if (!(pax >= 1 && pax <= maxPax)) throw new HttpsError("invalid-argument", `Pax must be 1–${maxPax}. For larger groups, use Event booking or call the store.`);
    checkLead((Number(rs.leadTimeHours) || 0) * 3600 * 1000, `${rs.leadTimeHours} hours`);
    checkHours();
  }

  if (kind === "event") {
    const ev = pub.events || {};
    if (!ev.enabled) throw new HttpsError("failed-precondition", "Event booking is not available.");
    if (!(pax >= 1 && pax <= (ev.maxPax || 100))) throw new HttpsError("invalid-argument", `Pax must be 1–${ev.maxPax || 100}.`);
    checkLead((Number(ev.leadTimeDays) || 0) * 86400 * 1000, `${ev.leadTimeDays} days`);
    const pkg = (ev.packages || []).find((p) => p.id === d.packageId);
    if ((ev.packages || []).length && !pkg) throw new HttpsError("invalid-argument", "Please select a package.");
    if (pkg) {
      if (pkg.minPax && pax < pkg.minPax) throw new HttpsError("invalid-argument", `Minimum ${pkg.minPax} pax for ${pkg.name}.`);
      estimate = pkg.pricing === "flat" ? Number(pkg.price) : Number(pkg.price) * pax;
      extra.packageId = pkg.id; extra.packageName = pkg.name; extra.packagePricing = pkg.pricing; extra.packagePrice = Number(pkg.price);
    }
    const endTime = /^\d{2}:\d{2}$/.test(String(d.endTime || "")) ? String(d.endTime) : null;
    if (endTime && endTime <= time) throw new HttpsError("invalid-argument", "End time must be later than start time.");
    extra.endTime = endTime;
    if (estimate != null && ev.depositPercent) deposit = Math.round(estimate * ev.depositPercent) / 100;
    extra.storeNote = ev.note || "";
  }

  if (kind === "vip") {
    const vp = pub.vip || {};
    if (!vp.enabled) throw new HttpsError("failed-precondition", "VIP rooms are not available.");
    const room = (vp.rooms || []).find((r) => r.id === d.roomId);
    if (!room) throw new HttpsError("invalid-argument", "Please select a room.");
    const hours = Math.max(1, Math.min(12, parseInt(d.hours, 10) || 1));
    if (hours < (room.minHours || 1)) throw new HttpsError("invalid-argument", `Minimum ${room.minHours} hours for ${room.name}.`);
    if (room.capacity && pax > room.capacity) throw new HttpsError("invalid-argument", `${room.name} holds a maximum of ${room.capacity} pax.`);
    if (!(pax >= 1)) throw new HttpsError("invalid-argument", "Enter the number of guests.");
    checkLead((Number(vp.leadTimeHours) || 0) * 3600 * 1000, `${vp.leadTimeHours} hours`);
    checkHours();
    // conflict check: same room, same day, overlapping times
    const startMs = scheduled.getTime(), endMs = startMs + hours * 3600 * 1000;
    const same = await db.collection(`stores/${pub.storeId}/reservations`).where("roomId", "==", room.id).where("date", "==", date).get();
    for (const x of same.docs) {
      const r = x.data();
      if (!["pending", "confirmed", "seated"].includes(r.status)) continue;
      const rs = r.scheduledAt.toMillis(), re = rs + (r.hours || 1) * 3600 * 1000;
      if (startMs < re && endMs > rs) throw new HttpsError("already-exists", `${room.name} is already booked at that time. Please choose another time or room.`);
    }
    // in use right now (checked in / overtime)? the new booking must start after it ends + cleaning
    { const until = await vipBusyUntil(pub.storeId, room); if (until && startMs < until + vipClean((await db.doc(`stores/${pub.storeId}`).get()).data()) * 60000) throw new HttpsError("already-exists", `${room.name} is in use right now — free from about ${new Date(until + 30 * 60000).toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit" })}. Please choose a later time or another room.`); }
    const pricing = room.pricing || "hour";
    estimate = pricing === "consumable" ? Number(room.minSpend || 0) : Number(room.ratePerHour || 0) * hours;
    extra.roomId = room.id; extra.roomName = room.name; extra.hours = hours; extra.ratePerHour = Number(room.ratePerHour || 0);
    extra.roomPricing = pricing; extra.minSpend = Number(room.minSpend || 0); extra.consumable = pricing !== "hour";
    extra.endTime = new Date(endMs + 8 * 3600 * 1000).toISOString().slice(11, 16);
    extra.storeNote = vp.note || "";
  }

  const pol = pub.policies?.[kind];
  if (pol && !d.policyAccepted) throw new HttpsError("failed-precondition", "You must agree to the booking policy.");
  const needsWaiver = !!(pub.waiver && pub.waiver[kind]);
  const ref = db.collection(`stores/${pub.storeId}/reservations`).doc();
  const prefix = { table: "R", event: "E", vip: "V" }[kind];
  const code = `${prefix}-${date.slice(5).replace("-", "")}-${refCode()}`;
  await ref.set({
    ...(pub.testMode && pub.testMode.until > Date.now() ? { test: true } : {}),
    code, kind,
    status: pub.confirm?.mode && pub.confirm.mode !== "off" ? "unconfirmed" : "pending", // unconfirmed (Messenger) → pending → confirmed → seated → done | cancelled | no_show
    confirmDeadline: pub.confirm?.mode && pub.confirm.mode !== "off" ? Timestamp.fromMillis(Math.min(Date.now() + (Number(pub.confirm.minutes) || 60) * 60000, (() => { try { return new Date(`${date}T${time}:00+08:00`).getTime(); } catch { return Infinity; } })())) : null,
    name, phone, messenger: msgrOf(d.messenger), pax, occasion, notes,
    date, time,
    scheduledAt: Timestamp.fromDate(scheduled),
    estimate, deposit,
    tableId: null, tableLabel: null, staffNote: "",
    ...extra,
    policyAcceptedAt: pol ? FieldValue.serverTimestamp() : null,
    needsWaiver, waiver: null,
    customerUid: uid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  logger.info("reservation created", { storeId: pub.storeId, id: ref.id, kind, date, time, pax });
  notifyTelegram(pub.storeId, "reservation", `📅 New ${kind} reservation ${code} · ${date} ${time} · ${pax} pax · ${name} ${phone}`);
  return { id: ref.id, storeId: pub.storeId, code, kind };
}));

// ===========================================================================
// STEP 7 — SUBSCRIPTION, BILLING, SUPER ADMIN
// ===========================================================================
// (plans are required at the top of the file)
const { ADMIN_EMAILS } = require("./admins");

const isAdminEmail = (email) => !!email && ADMIN_EMAILS.map((e) => e.toLowerCase()).includes(String(email).toLowerCase());

function requireAdmin(req) {
  const { uid, token } = requireAuth(req);
  if (!(token.admin === true || isAdminEmail(token.email))) throw new HttpsError("permission-denied", "Admin only.");
  return { uid, token };
}

// claimAdmin — called by the /admin/ page: if the email is in ADMIN_EMAILS, grant the admin claim
exports.claimAdmin = onCall(async (req) => {
  const { uid, token } = requireAuth(req);
  if (!isAdminEmail(token.email)) throw new HttpsError("permission-denied", "This email is not an admin.");
  const user = await admin.auth().getUser(uid);
  await admin.auth().setCustomUserClaims(uid, { ...(user.customClaims || {}), admin: true });
  return { ok: true };
});

/** Core subscription check — used by the scheduled function and the manual trigger */
async function runSubscriptionCheck() {
  const now = Date.now();
  const snap = await db.collectionGroup("subscription").get();
  let locked = 0, pastDue = 0;
  for (const d of snap.docs) {
    const s = d.data();
    // "active while checking" ran out without a confirmed payment → back to the plan they paid for (also re-checks staff slots)
    if (s.provisional?.until?.toMillis && s.provisional.until.toMillis() < now) await d.ref.update({ provisional: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
    if (!["trial", "active", "past_due"].includes(s.status)) continue;
    const until = (s.status === "trial" ? s.trialEndsAt : s.paidUntil)?.toMillis?.();
    if (!until || until > now) {
      if (s.status === "past_due") await d.ref.update({ status: "active", updatedAt: FieldValue.serverTimestamp() }); // turns out it was paid
      continue;
    }
    const daysOver = (now - until) / 86400000;
    if (s.status === "trial" || daysOver > GRACE_DAYS) {
      // never locked: the business continues on the Free plan (extras over the Free limits are hidden, not deleted)
      await d.ref.update({ plan: "free", status: "active", downgradedFrom: s.plan, downgradedAt: FieldValue.serverTimestamp(), paidUntil: null, addons: {}, updatedAt: FieldValue.serverTimestamp() });
      locked++;
      const sid = d.ref.parent.parent.id; rebuildPublicStore(sid).catch(() => {});
    } else if (s.status !== "past_due") {
      await d.ref.update({ status: "past_due", updatedAt: FieldValue.serverTimestamp() });
      pastDue++;
    }
  }
  logger.info("subscription check", { checked: snap.size, movedToFree: locked, pastDue });
  return { checked: snap.size, locked, pastDue };
}

// Daily at 12:10 AM Philippine time
exports.checkSubscriptions = onSchedule({ schedule: "10 0 * * *", timeZone: "Asia/Manila" }, async () => {
  await runSubscriptionCheck();
});

// Manual trigger (admin) — for testing or to run it right now
exports.runSubscriptionCheckNow = onCall(async (req) => {
  requireAdmin(req);
  return runSubscriptionCheck();
});

// adminListStores — all stores + subscription + owner + pending payments
// ---------------------------------------------------------------------------
// TapTayo feedback: owners & staff send ratings, suggestions and bug reports to the TapTayo team (admin page).
// When a suggestion is marked "done", the owner sees "You asked for it — it's here".
// ---------------------------------------------------------------------------
exports.sendAppFeedback = onCall(async (req) => {
  const { uid, token } = requireAuth(req);
  if (!token.storeId) throw new HttpsError("permission-denied", "Log in to your store first.");
  const d = req.data || {};
  const kind = ["suggestion", "bug", "rating", "praise"].includes(d.kind) ? d.kind : "suggestion";
  const text = String(d.text || "").trim().slice(0, 1500);
  const score = d.score == null || d.score === "" ? null : Math.max(0, Math.min(10, Math.round(Number(d.score))));
  if (!text && score == null) throw new HttpsError("invalid-argument", "Write something or pick a score.");
  const recent = await db.collection("appFeedback").where("uid", "==", uid).limit(30).get();
  if (recent.docs.filter((x) => (x.data().atMs || 0) > Date.now() - 3600e3).length >= 10) throw new HttpsError("resource-exhausted", "Thanks! You've sent a lot already — we'll read them all.");
  const st = (await db.doc(`stores/${token.storeId}`).get()).data() || {};
  await db.collection("appFeedback").add({ uid, email: token.email || null, role: token.role || null, staffName: String(d.staffName || "").slice(0, 40) || null, storeId: token.storeId, storeName: st.name || "", mode: st.mode || "", kind, text, score, page: String(d.page || "").slice(0, 60), version: String(d.version || "").slice(0, 20), status: "new", reply: null, atMs: Date.now(), at: FieldValue.serverTimestamp() });
  return { ok: true };
});
exports.myAppFeedback = onCall(async (req) => {
  const { uid } = requireAuth(req);
  const snap = await db.collection("appFeedback").where("uid", "==", uid).limit(50).get();
  return { items: snap.docs.map((d) => ({ id: d.id, ...d.data(), at: null })).sort((a, b) => b.atMs - a.atMs) };
});
exports.adminFeedback = onCall(async (req) => {
  requireAdmin(req);
  const d = req.data || {};
  if (d.id) {
    const patch = {};
    if (["new", "planned", "done", "wontdo"].includes(d.status)) patch.status = d.status;
    if (typeof d.reply === "string") patch.reply = d.reply.trim().slice(0, 600);
    patch.updatedAt = FieldValue.serverTimestamp();
    await db.doc(`appFeedback/${String(d.id)}`).update(patch);
    return { ok: true };
  }
  const snap = await db.collection("appFeedback").orderBy("atMs", "desc").limit(300).get();
  const items = snap.docs.map((x) => ({ id: x.id, ...x.data(), at: null }));
  const scores = items.filter((x) => x.score != null).map((x) => x.score);
  const nps = scores.length ? Math.round(((scores.filter((v) => v >= 9).length - scores.filter((v) => v <= 6).length) / scores.length) * 100) : null;
  return { items, nps, count: scores.length };
});

/** Alerts to the TapTayo admin (Telegram), e.g. a payment to check. Set up in /admin → Settings. */
async function notifyAdmin(text) {
  try { const c = (await db.doc("config/adminAlerts").get()).data(); if (!c?.botToken || !c?.chatId) return; await tgCall(c.botToken, "sendMessage", { chat_id: c.chatId, text, disable_web_page_preview: true }); }
  catch (e) { logger.warn("notifyAdmin", e.message); }
}
// ===== 🎨 Freelancer & Creator: inquiries → quote → terms + downpayment → deliverables (draft / revision / final) =====
// stores/{id}/inquiries/{id} { status new|quoted|accepted|in_progress|delivered|done|declined, brief, customer, customerUid, quote, dp, deliverables, revisionsUsed }
const INQ_ACTIVE = ["new", "quoted", "accepted", "in_progress", "delivered"];
async function inqStore(slug) { const pub = (await db.doc(`publicStores/${String(slug || "")}`).get()).data(); if (!pub) throw new HttpsError("not-found", "Page not found."); return pub; }
/** side-job flexibility for freelancers: "taking a break" and a max number of jobs per week */
async function sideJobBlock(storeId, store, ymd) {
  const A = store?.settings?.salon?.freelance?.availability || {};
  if (A.paused && (!A.until || A.until > Date.now())) return `Taking a break${A.until ? ` until ${new Date(A.until).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric" })}` : ""} — not accepting new bookings right now.`;
  const max = Number(A.maxPerWeek) || 0; if (!max || !ymd) return null;
  const dow = (new Date(`${ymd}T12:00:00+08:00`).getUTCDay() + 6) % 7; // Monday = 0
  const from = new Date(`${ymd}T00:00:00+08:00`).getTime() - dow * 86400000, to = from + 7 * 86400000;
  const ap = await db.collection(`stores/${storeId}/appointments`).where("startAt", ">=", admin.firestore.Timestamp.fromMillis(from)).where("startAt", "<", admin.firestore.Timestamp.fromMillis(to)).get();
  const nAppt = ap.docs.filter((x) => !["cancelled", "no_show", "declined"].includes(x.data().status)).length;
  const iq = await db.collection(`stores/${storeId}/inquiries`).where("status", "in", ["accepted", "in_progress"]).limit(200).get();
  const nInq = iq.docs.filter((x) => { const dt = x.data().quote?.date; return dt && dt >= phYmd(from) && dt < phYmd(to); }).length;
  return nAppt + nInq >= max ? `Fully booked that week (up to ${max} job${max > 1 ? "s" : ""} a week). Please pick another week.` : null;
}
/** quality first, not followers: portfolio, results, on-time, finished projects (+ small boost for verified) */
function creatorScore(c, store) {
  const n = store.stats?.ratingCount || 0, avg = n ? store.stats.ratingSum / n : 0;
  return Math.round((Math.min(c.portfolioCount || 0, 12) * 2 + (n ? (avg - 3) * 6 * Math.min(n, 20) / 20 : 0) + (c.onTime ? c.onTime.rate / 10 : 0) + Math.min(c.projectsDone || 0, 30) * 0.7 + (c.verified ? 4 : 0) + Math.log10(1 + (c.followers || 0)) * 0.8) * 10) / 10;
}
const isRising = (c, rating) => (c.portfolioCount || 0) >= 3 && (c.followers || 0) < 10000 && (!rating || rating.avg >= 4.5);
/** an offer in a negotiation: talent fee + transport + freebies (e.g. "free food up to 4 pax") */
function cleanOffer(o, from) {
  const x = { from, fee: Math.max(0, Math.round(Number(o?.fee) || 0)), transpo: Math.max(0, Math.round(Number(o?.transpo) || 0)), freebies: String(o?.freebies || "").trim().slice(0, 160), deliverables: String(o?.deliverables || "").trim().slice(0, 200), notes: String(o?.notes || "").trim().slice(0, 300), at: Date.now() };
  if (!x.fee && !x.transpo && !x.freebies) throw new HttpsError("invalid-argument", "Add a fee, transport or what you're offering (e.g. free food for 4).");
  return x;
}
function offerQuote(o, FL, extra = {}) {
  const lines = [...(o.fee ? [{ name: "Talent fee", price: o.fee }] : []), ...(o.transpo ? [{ name: "Transportation", price: o.transpo }] : []), ...(o.freebies ? [{ name: `Included by the client: ${o.freebies}`, price: 0 }] : [])];
  const total = round2(lines.reduce((a, l) => a + l.price, 0));
  return { lines, total, dpPercent: total ? Number(FL.dpPercent ?? 50) : 0, revisions: Number(FL.revisions ?? 2), terms: FL.terms || "", note: o.notes || "", date: extra.date || "", validUntil: Date.now() + 7 * 86400000, fromOffer: true, at: Date.now(), ...extra };
}
const inquirySendFn = async (req) => {
  await maintGuard(req);
  const { uid } = requireAuth(req); const d = req.data || {};
  const pub = await inqStore(d.slug);
  if (pub.locked || pub.acceptOrders === false) throw new HttpsError("failed-precondition", "Not accepting inquiries right now.");
  const B = d.brief || {}; const C = d.customer || {};
  const brief = { kind: String(B.kind || "").slice(0, 40), brand: String(B.brand || "").trim().slice(0, 80), platform: String(B.platform || "").slice(0, 60), budget: String(B.budget || "").slice(0, 40), deadline: /^\d{4}-\d{2}-\d{2}$/.test(String(B.deadline || "")) ? B.deadline : "", date: /^\d{4}-\d{2}-\d{2}$/.test(String(B.date || "")) ? B.date : "", location: String(B.location || "").slice(0, 120), details: String(B.details || "").trim().slice(0, 1500), deliverables: String(B.deliverables || "").slice(0, 300), rush: !!B.rush };
  const customer = { name: String(C.name || "").trim().slice(0, 60), phone: String(C.phone || "").trim().slice(0, 30), email: String(C.email || "").trim().slice(0, 80), messenger: msgrOf(C.messenger) };
  if (customer.name.length < 2 || (customer.phone.replace(/\D/g, "").length < 7 && !/@/.test(customer.email))) throw new HttpsError("invalid-argument", "Add your name and a mobile number or email.");
  if (brief.details.length < 10) throw new HttpsError("invalid-argument", "Tell us a bit more about the project.");
  const fcfg = (await db.doc(`stores/${pub.storeId}`).get()).data()?.settings?.salon || {}; const FL = fcfg.freelance || {};
  // on-site work: inside the creator's travel radius, and a valid ID for the creator's protection
  if (brief.location || B.pin) radiusGuard(fcfg.homeService, String(B.pin || ""));
  // Identity-document collection is disabled for inquiries.
  if (B.pin) brief.pin = String(B.pin).slice(0, 120);
  { const why = await sideJobBlock(pub.storeId, { settings: { salon: fcfg } }, brief.date || null); if (why) throw new HttpsError("failed-precondition", why); }
  const offer = d.offer ? cleanOffer(d.offer, "client") : null;
  if (offer) { if (FL.offers === false) throw new HttpsError("failed-precondition", "This creator only works with fixed rates — pick a service or request a quote."); if (FL.minFee && offer.fee + offer.transpo < FL.minFee) throw new HttpsError("failed-precondition", `This creator's minimum is ₱${FL.minFee.toLocaleString("en-PH")} (talent fee + transport).`); }
  const recent = await db.collection(`stores/${pub.storeId}/inquiries`).where("customerUid", "==", uid).limit(10).get();
  if (recent.docs.filter((x) => x.data().createdAtMs > Date.now() - 3600e3).length >= 3) throw new HttpsError("resource-exhausted", "You've sent a few already — please wait for a reply.");
  const ref = await db.collection(`stores/${pub.storeId}/inquiries`).add({ status: offer ? "negotiating" : "new", offers: offer ? [offer] : [], ...(d.fromStoreId && req.__internal === true ? { fromStoreId: String(d.fromStoreId), fromStoreName: String(d.fromStoreName || "").slice(0, 60) } : {}), brief, customer, customerUid: uid, code: "Q-" + Array.from({ length: 5 }, () => CLAIM_ALPHABET[Math.floor(Math.random() * CLAIM_ALPHABET.length)]).join(""), deliverables: [], revisionsUsed: 0, createdAt: FieldValue.serverTimestamp(), createdAtMs: Date.now(), updatedAt: FieldValue.serverTimestamp() });
  notifyTelegram(pub.storeId, "reservation", `📨 New inquiry from ${customer.name}${brief.brand ? ` (${brief.brand})` : ""}: ${brief.details.slice(0, 160)}${brief.budget ? ` · budget ${brief.budget}` : ""}`);
  sendPush(pub.storeId, { roles: ["manager"] }, { title: "📨 New inquiry", body: `${customer.name}${brief.brand ? ` · ${brief.brand}` : ""}`, url: "/app/#projects", tag: "inq-" + ref.id });
  return { id: ref.id, storeId: pub.storeId };
};
exports.inquirySend = onCall(withIndex("inq", inquirySendFn));
exports.inquiryAction = onCall(async (req) => { // the client: accept quote (terms + DP), ask for a revision, approve, decline
  const { uid } = requireAuth(req); const d = req.data || {};
  const ref = db.doc(`stores/${String(d.storeId || "")}/inquiries/${String(d.id || "")}`); const q = (await ref.get()).data();
  if (!q || q.customerUid !== uid) throw new HttpsError("permission-denied", "Not your inquiry.");
  const now = Date.now(); const upd = (p) => ref.update({ ...p, updatedAt: FieldValue.serverTimestamp() });
  if (d.action === "accept") {
    if (q.status !== "quoted") throw new HttpsError("failed-precondition", "There's no quote to accept.");
    if (q.quote?.validUntil && q.quote.validUntil < now) throw new HttpsError("failed-precondition", "This quote has expired — ask for a new one.");
    if (!d.terms) throw new HttpsError("invalid-argument", "Please accept the terms.");
    const dpAmt = round2((q.quote.total || 0) * (q.quote.dpPercent || 0) / 100);
    const refNo = String(d.refNo || "").trim().slice(0, 60);
    if (dpAmt > 0 && refNo.length < 4 && !d.proofUrl) throw new HttpsError("invalid-argument", "Enter the reference number of your downpayment.");
    const cm = (await db.doc(`stores/${d.storeId}`).get()).data()?.contact?.messenger || "";
    await upd({ ...(cm ? { creatorMessenger: cm } : {}), status: dpAmt ? "accepted" : "in_progress", termsAt: now, contract: { client: q.fromStoreName || q.brief?.brand || q.customer?.name || "", lines: q.quote.lines, total: q.quote.total, dpPercent: q.quote.dpPercent, revisions: q.quote.revisions ?? 2, terms: q.quote.terms || "", rush: q.quote.rush || null, usage: q.quote.usage || "", date: q.quote.date || "", acceptedAt: now }, ...(q.quote.rush && !dpAmt ? { "quote.rush.dueAt": now + q.quote.rush.hours * 3600000 } : {}), dp: dpAmt ? { amount: dpAmt, refNo, method: String(d.method || "GCash").slice(0, 20), proofUrl: d.proofUrl ? String(d.proofUrl).slice(0, 500) : null, status: "to_verify", at: now } : { amount: 0, status: "none" } });
    notifyTelegram(d.storeId, "reservation", `✅ ${q.customer?.name} accepted quote ${q.code} · ₱${q.quote.total}${dpAmt ? ` · DP ₱${dpAmt} ref ${refNo} — verify it` : ""}`);
    return { ok: true };
  }
  if (d.action === "decline") { if (!["new", "quoted", "negotiating"].includes(q.status)) throw new HttpsError("failed-precondition", "Can't decline now."); await upd({ status: "declined", declinedBy: "client", reason: String(d.reason || "").slice(0, 200) }); return { ok: true }; }
  if (d.action === "counter") {
    if (!["negotiating", "new", "quoted"].includes(q.status)) throw new HttpsError("failed-precondition", "Too late to change the offer.");
    const o = cleanOffer(d.offer, "client"); await upd({ status: "negotiating", offers: [...(q.offers || []), o] });
    notifyTelegram(d.storeId, "reservation", `💬 Counter-offer · ${q.code} · ₱${o.fee + o.transpo}${o.freebies ? ` + ${o.freebies}` : ""}`); return { ok: true };
  }
  if (d.action === "acceptOffer") { // client accepts the creator's last counter → quote → (terms + DP below)
    const last = (q.offers || []).slice(-1)[0]; if (q.status !== "negotiating" || !last || last.from !== "creator") throw new HttpsError("failed-precondition", "No offer from the creator to accept.");
    const FL = ((await db.doc(`stores/${d.storeId}`).get()).data()?.settings?.salon || {}).freelance || {};
    q.quote = offerQuote(last, FL, { date: q.brief?.date || "" }); q.status = "quoted"; await upd({ quote: q.quote, status: "quoted" });
    if (!d.terms) return { ok: true, quoted: true };
    d.action = "accept";
  }
  if (d.action === "reschedule") { // move the shoot / visit date (moving-date fee per the shop's policy)
    if (!["accepted", "in_progress"].includes(q.status) || !q.quote?.date) throw new HttpsError("failed-precondition", "Nothing to move.");
    const nd = String(d.date || ""); if (!/^\d{4}-\d{2}-\d{2}$/.test(nd) || nd < phYmd(now)) throw new HttpsError("invalid-argument", "Choose the new date.");
    const st = (await db.doc(`stores/${d.storeId}`).get()).data();
    const fee = reschedFee(bookingPolicy(st), new Date(`${q.quote.date}T09:00:00+08:00`).getTime(), q.reschedCount || 0, q.quote.total || 0, d.acceptFee);
    const lines = fee ? [...q.quote.lines, { name: "Moving date fee", price: fee }] : q.quote.lines;
    await upd({ "quote.date": nd, "quote.lines": lines, "quote.total": round2((q.quote.total || 0) + fee), reschedCount: (q.reschedCount || 0) + 1, movedFrom: q.quote.date });
    notifyTelegram(d.storeId, "reservation", `📅 ${q.customer?.name} moved ${q.code} to ${nd}${fee ? ` (+₱${fee} moving fee)` : ""}`); return { ok: true, fee };
  }
  if (d.action === "review") { // results-based testimonial after the job ("sales went up since…")
    if (q.status !== "done") throw new HttpsError("failed-precondition", "You can review once the project is done.");
    if (q.review) throw new HttpsError("already-exists", "Already reviewed.");
    const rating = Math.max(1, Math.min(5, parseInt(d.rating, 10) || 5)); const comment = String(d.comment || "").trim().slice(0, 500), result = String(d.result || "").trim().slice(0, 200);
    await upd({ review: { rating, comment, result, at: now } });
    await db.doc(`stores/${d.storeId}/feedback/inq_${req.data.id}`).set({ orderId: String(req.data.id), rating, comment: result ? `📈 ${result}${comment ? " — " + comment : ""}` : comment, result, customerName: q.fromStoreName || q.brief?.brand || q.customer?.name || "", customerUid: uid, kind: "project", hidden: false, createdAt: FieldValue.serverTimestamp() });
    await db.doc(`stores/${d.storeId}`).set({ stats: { ratingCount: FieldValue.increment(1), ratingSum: FieldValue.increment(rating) } }, { merge: true });
    return { ok: true };
  }
  const dl = (q.deliverables || []).find((x) => x.id === d.deliverableId); if (!dl) throw new HttpsError("not-found", "Deliverable not found.");
  if (d.action === "revision") {
    if (dl.status !== "review") throw new HttpsError("failed-precondition", "Nothing to review yet.");
    const lim = q.quote?.revisions ?? 2; if ((q.revisionsUsed || 0) >= lim) throw new HttpsError("failed-precondition", `You've used all ${lim} revision${lim === 1 ? "" : "s"} in the quote. Extra revisions can be quoted separately.`);
    const deliverables = q.deliverables.map((x) => (x.id === dl.id ? { ...x, status: "revision", notes: [...(x.notes || []), { from: "client", text: String(d.note || "").slice(0, 500), at: now }] } : x));
    await upd({ deliverables, revisionsUsed: (q.revisionsUsed || 0) + 1, status: "in_progress" });
    notifyTelegram(d.storeId, "reservation", `✏️ Revision request · ${q.code} · ${dl.name}: ${String(d.note || "").slice(0, 160)}`);
    return { ok: true };
  }
  if (d.action === "approve") {
    const deliverables = q.deliverables.map((x) => (x.id === dl.id ? { ...x, status: "approved", approvedAt: now } : x));
    const all = deliverables.every((x) => x.status === "approved");
    await upd({ deliverables, ...(all ? { status: "delivered" } : {}) });
    notifyTelegram(d.storeId, "reservation", `👍 ${q.customer?.name} approved "${dl.name}" (${q.code})${all ? " — all deliverables approved, collect the balance" : ""}`);
    return { ok: true };
  }
  throw new HttpsError("invalid-argument", "Unknown action.");
});
/** a business (café, salon…) invites a creator: offer = talent fee + transport + freebies */
exports.creatorOffer = onCall(async (req) => {
  await maintGuard(req);
  const who = await staffFrom(req); if (!hasRole(who, "manager")) throw new HttpsError("permission-denied", "Only the owner or a manager can send offers.");
  const st = (await db.doc(`stores/${who.storeId}`).get()).data() || {}; const d = req.data || {};
  const pub = await inqStore(d.slug); if (pub.storeId === who.storeId) throw new HttpsError("invalid-argument", "That's your own page.");
  if (st.businessType === "freelance") throw new HttpsError("failed-precondition", "Invite creators from a business account.");
  await collabLiveGuard(req, st);
  await collabUse(who.storeId, st, "offers");
  const B = d.brief || {};
  const r = await inquirySendFn({ __internal: true, auth: req.auth, rawRequest: req.rawRequest, data: { slug: d.slug, offer: d.offer, fromStoreId: who.storeId, fromStoreName: st.name || "", brief: { kind: "Brand collab / content", brand: st.name || "", platform: B.platform || "", date: B.date || "", deadline: B.deadline || "", location: B.location || [st.contact?.address, st.contact?.city].filter(Boolean).join(", "), pin: B.pin || st.contact?.mapUrl || "", idUrl: B.idUrl || "", deliverables: B.deliverables || "", details: B.details || "" }, customer: { name: d.contactName || who.name || st.name, phone: d.phone || st.contact?.phone || "", email: "", messenger: d.messenger || st.contact?.messenger || "" } } });
  return r;
});
exports.myCreatorOffers = onCall(async (req) => {
  const t = req.auth?.token || {};
  const who = t.role === "viewer" && t.demo && t.storeId ? { storeId: t.storeId } : await staffFrom(req); if (!who.role && !(t.role === "viewer" && t.demo) && !hasRole(who, "manager")) throw new HttpsError("permission-denied", "Not allowed.");
  if (who.role && !hasRole(who, "manager")) throw new HttpsError("permission-denied", "Not allowed.");
  const snap = await db.collectionGroup("inquiries").where("fromStoreId", "==", who.storeId).limit(100).get();
  const ids = [...new Set(snap.docs.map((x) => x.ref.parent.parent.id))]; const names = {};
  await Promise.all(ids.map(async (id) => { const s = (await db.doc(`stores/${id}`).get()).data() || {}; names[id] = { name: s.name || "", slug: s.slug || "" }; }));
  return snap.docs.map((x) => { const q = x.data(); const sid = x.ref.parent.parent.id; return { id: x.id, storeId: sid, creator: names[sid], code: q.code, status: q.status, kind: q.kind || "offer", item: q.item || null, x: q.x ? { ...q.x, log: undefined } : null, tipOffer: q.tipOffer || 0, xDeliver: q.xDeliver || "", releaseDays: q.releaseDays || null, shipping: q.shipping || "", deadline: q.deadline || "", instructions: q.instructions || "", revisionsUsed: q.revisionsUsed || 0, offers: q.offers || [], quote: q.quote ? { total: q.quote.total, date: q.quote.date || "" } : null, brief: { date: q.brief?.date || "", details: q.brief?.details || "" }, createdAtMs: q.createdAtMs || 0 }; }).sort((a, b) => b.createdAtMs - a.createdAtMs);
});
/** public creator directory (opt-in) */
exports.creatorDirectory = onCall(async (req) => {
  const d = req.data || {}; const snap = await db.collection("publicStores").where("creatorListed", "==", true).limit(300).get();
  const niche = String(d.niche || "").toLowerCase(), city = String(d.city || "").toLowerCase(), qq = String(d.q || "").toLowerCase();
  return snap.docs.map((x) => x.data()).filter((p) => p.creator && (!niche || (p.creator.niches || []).some((n) => n.toLowerCase() === niche)) && (!city || `${p.creator.city} ${(p.salon?.homeService?.areas || []).map((a) => a.name).join(" ")}`.toLowerCase().includes(city)) && (!qq || `${p.name} ${p.tagline} ${p.creator.pitch} ${(p.creator.niches || []).join(" ")}`.toLowerCase().includes(qq)))
    .map((p) => ({ score: p.creatorScore || 0, slug: p.slug, storeId: p.storeId, name: p.name, tagline: p.tagline || "", logoUrl: p.logoUrl || null, coverUrl: p.coverUrl || null, creator: p.creator, platforms: (p.salon?.freelance?.platforms || []).map((x) => ({ platform: x.platform, followers: x.followers })), rating: p.feedback?.avg ? { avg: p.feedback.avg, n: p.feedback.count } : null, from: Math.min(...(p.items || []).filter((i) => (i.durationMinutes || 0) >= 30).map((i) => Number(i.price) || Infinity)), demo: !!p.testMode && String(p.slug).startsWith("taptayo-") }))
    .map((x, i) => ({ ...x, from: Number.isFinite(x.from) ? x.from : null, rising: isRising(x.creator, x.rating) })).filter((x) => (!d.ugc || x.creator.ugc) && (!d.xdeal || x.creator.xdeal)).sort((a, b) => (d.sort === "followers" ? b.creator.followers - a.creator.followers : (b.score || 0) - (a.score || 0))).slice(0, Math.min(100, Number(d.limit) || 100));
});
/** creator asks TapTayo to check their socials → admin gives the Verified badge */
exports.creatorVerifyRequest = onCall(async (req) => {
  const who = await staffFrom(req); if (!hasRole(who, "manager")) throw new HttpsError("permission-denied", "Owner only.");
  const st = (await db.doc(`stores/${who.storeId}`).get()).data() || {}; const P = st.settings?.salon?.freelance?.platforms || [];
  if (!P.length) throw new HttpsError("failed-precondition", "Add your social accounts first (with links).");
  const proofs = (req.data?.proofs || []).filter((u) => typeof u === "string").slice(0, 6);
  await db.doc(`stores/${who.storeId}`).set({ verifyReq: { status: "pending", at: Date.now(), platforms: P, proofs, code: `TAPTAYO-${who.storeId.slice(0, 5).toUpperCase()}` } }, { merge: true });
  notifyAdmin(`✔️ Verify request · ${st.name} (${st.slug}) · ${P.map((p) => `${p.platform} ${p.followers}`).join(", ")}`);
  return { ok: true, code: `TAPTAYO-${who.storeId.slice(0, 5).toUpperCase()}` };
});
exports.adminCreatorVerify = onCall(async (req) => {
  requireAdmin(req); const d = req.data || {};
  if (d.action === "list") { const snap = await db.collection("stores").where("verifyReq.status", "==", "pending").limit(50).get(); return snap.docs.map((x) => ({ id: x.id, name: x.data().name, slug: x.data().slug, req: x.data().verifyReq })); }
  const ref = db.doc(`stores/${String(d.storeId || "")}`); const st = (await ref.get()).data(); if (!st) throw new HttpsError("not-found", "Store not found.");
  const ok = d.action === "approve";
  await ref.set({ creatorVerified: ok ? true : d.action === "revoke" ? false : !!st.creatorVerified, verifyReq: { ...(st.verifyReq || {}), status: ok ? "approved" : "rejected", reason: String(d.reason || "").slice(0, 200), doneAt: Date.now() } }, { merge: true });
  await rebuildPublicStore(String(d.storeId)).catch(() => {});
  return { ok: true };
});
/** Free creators: up to N brand deals a month (Creator Pro = unlimited) */
async function dealsGuard(storeId) {
  const { lim, plan } = await storeLimits(storeId, "salon"); const max = lim.dealsPerMonth ?? UNLIMITED; if (max >= UNLIMITED) return;
  const m0 = new Date(`${phYmd(Date.now()).slice(0, 7)}-01T00:00:00+08:00`).getTime();
  const n = (await db.collection(`stores/${storeId}/inquiries`).where("termsAt", ">=", m0).get()).size;
  if (n >= max) throw new HttpsError("resource-exhausted", `${PLANS[plan]?.name || "Free"} plan: up to ${max} brand deals a month. Upgrade to Creator Pro (₱${PLANS.creator.price}/month) for unlimited deals.`);
}
/** businesses: offers to creators per month + open collab posts (plan limits; the Creator Collab add-on = unlimited) */
async function collabUse(storeId, st, what) {
  const { lim, plan } = await storeLimits(storeId, st.mode || "table"); const month = phYmd(Date.now()).slice(0, 7);
  if (what === "offers") {
    const max = lim.creatorOffers ?? 1; const u = st.collabUsage?.month === month ? st.collabUsage.offers || 0 : 0;
    if (u >= max) throw new HttpsError("resource-exhausted", `${PLANS[plan]?.name || "Free"} plan: ${max} offer${max > 1 ? "s" : ""} to creators a month. Add Creator Collab (₱199/month) in Billing for unlimited offers.`);
    await db.doc(`stores/${storeId}`).set({ collabUsage: { month, offers: u + 1 } }, { merge: true });
  } else {
    const max = lim.collabPosts ?? 0; const open = (await db.collection("collabs").where("storeId", "==", storeId).get()).docs.filter((x) => x.data().status === "open").length;
    if (open >= max) throw new HttpsError("resource-exhausted", max ? `${PLANS[plan]?.name} plan: ${max} open collab post${max > 1 ? "s" : ""} at a time. Close one, or add Creator Collab (₱199/month) for unlimited.` : `Open collab posts come with the Pro plan or the Creator Collab add-on (₱199/month).`);
  }
}
const COLLAB_NICHES = ["Food", "Lifestyle", "Beauty", "Travel", "Family", "Fitness", "Tech", "Fashion", "Photography", "Events", "UGC"];
const pubCollab = (id, c) => ({ id, title: c.title, details: c.details, niche: c.niche, city: c.city, budgetEach: c.budgetEach, freebies: c.freebies, deliverables: c.deliverables, deadline: c.deadline, slots: c.slots, filled: c.filled || 0, ugc: !!c.ugc, onSite: !!c.onSite, storeName: c.storeName, storeSlug: c.storeSlug, logoUrl: c.logoUrl || null, businessType: c.businessType || "", apps: c.apps || 0, status: c.status, createdAtMs: c.createdAtMs });
/** Open Collab board: a business posts "need 3 food UGC videos, ₱1,500 each" → creators apply → the business picks */
exports.collabPost = onCall(async (req) => {
  await maintGuard(req);
  const who = await staffFrom(req); if (!hasRole(who, "manager")) throw new HttpsError("permission-denied", "Owner or manager only.");
  const st = (await db.doc(`stores/${who.storeId}`).get()).data() || {}; if (st.businessType === "freelance") throw new HttpsError("failed-precondition", "Post collabs from a business account.");
  await collabLiveGuard(req, st);
  const d = req.data || {};
  if (d.action === "close" || d.action === "reopen") { const ref = db.doc(`collabs/${String(d.id || "")}`); const c = (await ref.get()).data(); if (!c || c.storeId !== who.storeId) throw new HttpsError("not-found", "Post not found."); if (d.action === "reopen") await collabUse(who.storeId, st, "posts"); await ref.update({ status: d.action === "close" ? "closed" : "open", updatedAt: Date.now() }); return { ok: true }; }
  const c = { title: String(d.title || "").trim().slice(0, 90), details: String(d.details || "").trim().slice(0, 1200), niche: COLLAB_NICHES.includes(d.niche) ? d.niche : "Lifestyle", city: String(d.city || st.contact?.city || "").trim().slice(0, 40), budgetEach: Math.max(0, Math.round(Number(d.budgetEach) || 0)), freebies: String(d.freebies || "").trim().slice(0, 160), deliverables: String(d.deliverables || "").trim().slice(0, 200), deadline: /^\d{4}-\d{2}-\d{2}$/.test(String(d.deadline || "")) ? d.deadline : "", slots: Math.max(1, Math.min(20, parseInt(d.slots, 10) || 1)), ugc: !!d.ugc, onSite: d.onSite !== false };
  if (c.title.length < 6) throw new HttpsError("invalid-argument", "Add a short title (e.g. “3 food videos for our new menu”).");
  if (!c.budgetEach && !c.freebies) throw new HttpsError("invalid-argument", "Add a budget per creator or what you're giving (e.g. free food for 2).");
  await collabUse(who.storeId, st, "posts");
  const ref = await db.collection("collabs").add({ ...c, storeId: who.storeId, storeName: st.name || "", storeSlug: st.slug || "", logoUrl: st.logoUrl || null, businessType: st.businessType || "", address: [st.contact?.address].filter(Boolean).join(""), pin: st.contact?.mapUrl || "", status: "open", filled: 0, apps: 0, createdBy: req.auth.uid, createdAtMs: Date.now(), updatedAt: Date.now() });
  return { id: ref.id };
});
exports.collabList = onCall(async (req) => { // public — no account needed to look
  const d = req.data || {}; const snap = await db.collection("collabs").where("status", "==", "open").limit(200).get();
  const niche = String(d.niche || ""), city = String(d.city || "").toLowerCase(), q = String(d.q || "").toLowerCase();
  return snap.docs.map((x) => pubCollab(x.id, x.data())).filter((c) => (!c.deadline || c.deadline >= phYmd(Date.now())) && (!niche || c.niche === niche || (niche === "UGC" && c.ugc)) && (!city || String(c.city).toLowerCase().includes(city)) && (!q || `${c.title} ${c.details} ${c.niche} ${c.storeName}`.toLowerCase().includes(q))).sort((a, b) => b.createdAtMs - a.createdAtMs).slice(0, 60);
});
exports.collabApply = onCall(async (req) => {
  await maintGuard(req);
  const who = await staffFrom(req); if (!hasRole(who, "manager")) throw new HttpsError("permission-denied", "Owner only.");
  const st = (await db.doc(`stores/${who.storeId}`).get()).data() || {}; if (st.businessType !== "freelance") throw new HttpsError("failed-precondition", "Apply from your creator account.");
  await collabLiveGuard(req, st);
  const FL = st.settings?.salon?.freelance || {}; if (!FL.adult) throw new HttpsError("failed-precondition", "Confirm you're 18 or older in Settings → Your profile first.");
  const port = (await db.collection(`stores/${who.storeId}/portfolio`).get()).docs.filter((x) => x.data().creator).length;
  if (port < 1) throw new HttpsError("failed-precondition", "Add at least one portfolio sample first — businesses pick creators by their work.");
  const d = req.data || {}; const ref = db.doc(`collabs/${String(d.id || "")}`); const c = (await ref.get()).data();
  if (!c || c.status !== "open") throw new HttpsError("failed-precondition", "This collab is closed.");
  const aref = ref.collection("apps").doc(who.storeId); if ((await aref.get()).exists) throw new HttpsError("already-exists", "You already applied.");
  await aref.set({ creatorStoreId: who.storeId, creatorSlug: st.slug, creatorName: st.name, logoUrl: st.logoUrl || null, fee: Math.max(0, Math.round(Number(d.fee) || c.budgetEach || 0)), pitch: String(d.pitch || "").trim().slice(0, 500), sample: String(d.sample || "").trim().slice(0, 300), verified: !!st.creatorVerified, portfolio: port, status: "applied", at: Date.now() });
  await ref.update({ apps: FieldValue.increment(1) });
  notifyTelegram(c.storeId, "reservation", `🙋 ${st.name} applied to your collab “${c.title}”${d.fee ? ` · ₱${d.fee}` : ""}`);
  sendPush(c.storeId, { roles: ["manager"] }, { title: "🙋 New creator applied", body: `${st.name} → ${c.title}`, url: "/app/#creators", tag: "collab-" + d.id });
  return { ok: true };
});
exports.collabMine = onCall(async (req) => {
  const t = req.auth?.token || {};
  const who = t.role === "viewer" && t.demo && t.storeId ? { storeId: t.storeId, viewer: true } : await staffFrom(req);
  const st = (await db.doc(`stores/${who.storeId}`).get()).data() || {};
  if (st.businessType === "freelance") { // the creator: my applications
    const snap = await db.collectionGroup("apps").where("creatorStoreId", "==", who.storeId).limit(50).get();
    return { kind: "creator", apps: await Promise.all(snap.docs.map(async (x) => { const c = (await x.ref.parent.parent.get()).data() || {}; return { ...x.data(), collab: pubCollab(x.ref.parent.parent.id, c) }; })) };
  }
  const posts = (await db.collection("collabs").where("storeId", "==", who.storeId).limit(50).get()).docs;
  return { kind: "business", posts: await Promise.all(posts.map(async (x) => ({ ...pubCollab(x.id, x.data()), applicants: (await x.ref.collection("apps").get()).docs.map((a) => a.data()).sort((a, b) => b.at - a.at) }))).then((L) => L.sort((a, b) => b.createdAtMs - a.createdAtMs)) };
});
exports.collabDecide = onCall(async (req) => { // the business picks a creator → becomes a normal offer (terms + DP as usual)
  const who = await staffFrom(req); if (!hasRole(who, "manager")) throw new HttpsError("permission-denied", "Owner or manager only.");
  const d = req.data || {}; const ref = db.doc(`collabs/${String(d.id || "")}`); const c = (await ref.get()).data();
  if (!c || c.storeId !== who.storeId) throw new HttpsError("not-found", "Post not found.");
  const aref = ref.collection("apps").doc(String(d.creatorStoreId || "")); const a = (await aref.get()).data(); if (!a) throw new HttpsError("not-found", "Application not found.");
  if (d.action === "decline") { await aref.update({ status: "declined" }); return { ok: true }; }
  if (a.status === "picked") throw new HttpsError("already-exists", "Already picked.");
  const st = (await db.doc(`stores/${who.storeId}`).get()).data() || {};
  const r = await inquirySendFn({ __internal: true, auth: req.auth, rawRequest: req.rawRequest, data: { slug: a.creatorSlug, offer: { fee: a.fee || c.budgetEach, transpo: 0, freebies: c.freebies, deliverables: c.deliverables, notes: `From your application to “${c.title}”` }, fromStoreId: who.storeId, fromStoreName: st.name || "", brief: { kind: "Brand collab / content", brand: st.name || "", date: "", deadline: c.deadline, location: c.onSite ? c.address || c.city : "", pin: c.onSite ? c.pin : "", deliverables: c.deliverables, details: `${c.title}\n${c.details}`.slice(0, 1500) }, customer: { name: d.contactName || who.name || st.name, phone: d.phone || st.contact?.phone || "0000000", email: "", messenger: st.contact?.messenger || "" } } }).catch((e) => { throw e; });
  await aref.update({ status: "picked", inquiryId: r.id, pickedAt: Date.now() });
  const filled = (c.filled || 0) + 1; await ref.update({ filled, ...(filled >= c.slots ? { status: "filled" } : {}), updatedAt: Date.now() });
  return { ok: true, inquiryId: r.id, storeId: r.storeId };
});
/** creator portfolio (UGC / posted work): photos uploaded, videos as links */
exports.portfolioSave = onCall(async (req) => {
  const who = await staffFrom(req); if (!hasRole(who, "manager", "stylist")) throw new HttpsError("permission-denied", "Not allowed.");
  const d = req.data || {}; const col = db.collection(`stores/${who.storeId}/portfolio`);
  if (d.action === "delete") { const r = col.doc(String(d.id || "")); if ((await r.get()).data()?.creator) await r.delete(); return { ok: true }; }
  const url = String(d.url || "").trim().slice(0, 500); if (!/^https?:\/\//.test(url)) throw new HttpsError("invalid-argument", "Upload a photo or paste a link to the video (TikTok, Reels, YouTube, Drive).");
  const { lim, plan } = await storeLimits(who.storeId, "salon"); const n = (await col.get()).docs.filter((x) => x.data().creator).length;
  if (n >= (lim.portfolio ?? 40)) throw new HttpsError("resource-exhausted", `${PLANS[plan]?.name || "Free"} plan: up to ${lim.portfolio} portfolio samples. Creator Pro (₱${PLANS.creator.price}/month) gives you up to 40.`);
  const ref = await col.add({ creator: true, url, thumb: String(d.thumb || "").slice(0, 500) || null, kind: d.kind === "video" ? "video" : "photo", label: String(d.label || "").trim().slice(0, 80), brand: String(d.brand || "").trim().slice(0, 60), ugc: !!d.ugc, at: Date.now(), by: who.name || "" });
  return { id: ref.id };
});

// ============================================================================
// X-DEAL (barter: food / product / staycation ↔ UGC video), TapTayo Protect, B2B video swaps, Collab "coming soon"
// ============================================================================
const XDEAL_TYPES = ["food", "product", "staycation"];
const xEligible = (st) => st && st.businessType !== "freelance" && (st.mode === "table" || st.mode === "stay" || st.businessType === "products");
let COLLAB_CFG = { at: 0, v: null };
async function collabCfg() { if (Date.now() - COLLAB_CFG.at < 60000 && COLLAB_CFG.v) return COLLAB_CFG.v; const v = (await db.doc("config/collab").get()).data() || { live: false, target: 100 }; COLLAB_CFG = { at: Date.now(), v }; return v; }
/** matching opens when TapTayo has enough creators (admin switch); demo stores and admins can always try it */
async function collabLiveGuard(req, st) {
  const t = req.auth?.token || {}; if (t.admin === true || isAdminEmail(t.email) || st?.settings?.demo || st?.demo) return;
  const c = await collabCfg(); if (!c.live) throw new HttpsError("failed-precondition", `TapTayo Collab is coming soon — we're onboarding the first ${c.target || 100} creators. Join the waitlist and we'll tell you when it opens.`);
}
exports.collabStatus = onCall(async () => {
  const c = await collabCfg(); const snap = await db.collection("publicStores").where("creatorListed", "==", true).get();
  return { live: !!c.live, target: c.target || 100, city: c.city || "Metro Manila", creators: snap.docs.filter((x) => !x.data().testMode || !String(x.id).startsWith("taptayo-")).length };
});
exports.collabWaitlist = onCall(async (req) => {
  if (!realAccount(req)) throw new HttpsError("unauthenticated", "Log in to join the waitlist.");
  const d = req.data || {}; await db.doc(`collabWaitlist/${req.auth.uid}`).set({ email: req.auth.token.email, role: ["business", "creator"].includes(d.role) ? d.role : "business", city: String(d.city || "").slice(0, 40), at: Date.now() }, { merge: true });
  return { ok: true };
});
exports.adminCollabConfig = onCall(async (req) => {
  requireAdmin(req); const d = req.data || {};
  if (d.set) { await db.doc("config/collab").set({ live: !!d.live, target: Math.max(1, parseInt(d.target, 10) || 100), city: String(d.city || "Metro Manila").slice(0, 40), updatedAt: Date.now() }, { merge: true }); COLLAB_CFG = { at: 0, v: null }; }
  const c = await collabCfg(); const wl = await db.collection("collabWaitlist").get();
  return { ...c, waitlist: wl.size, waitBusiness: wl.docs.filter((x) => x.data().role === "business").length };
});
/** trust: new creators can take X-Deals up to ₱800 item value; ₱2,000 after 3 on-time X-Deals; verified = no cap */
const xCap = (st) => (st?.creatorVerified ? 1e9 : (st?.stats?.xDone || 0) >= 3 ? 2000 : 800);
async function xMonthly(storeId, mode) { // X-Deals + swaps started this month by a store vs its plan
  const { lim, plan } = await storeLimits(storeId, mode); const month = phYmd(Date.now()).slice(0, 7);
  const st = (await db.doc(`stores/${storeId}`).get()).data() || {}; const u = st.xUsage?.month === month ? st.xUsage.n || 0 : 0;
  return { max: lim.xdealsPerMonth ?? 2, used: u, plan, month };
}
async function xCount(storeId, mode, who) {
  const m = await xMonthly(storeId, mode);
  if (m.used >= m.max) throw new HttpsError("resource-exhausted", who === "creator" ? `Free plan: ${m.max} X-Deals a month. Creator Pro (₱${PLANS.creator.price}/month) gives you unlimited X-Deals.` : `Limit reached: ${m.max} X-Deals / swaps this month.`);
  await db.doc(`stores/${storeId}`).set({ xUsage: { month: m.month, n: m.used + 1 } }, { merge: true });
}
const cleanItem = (it) => { const type = XDEAL_TYPES.includes(it?.type) ? it.type : "product"; const desc = String(it?.desc || "").trim().slice(0, 200); const value = Math.max(0, Math.round(Number(it?.value) || 0)); if (desc.length < 3) throw new HttpsError("invalid-argument", "Describe what you'll give (e.g. “Food for 2”, “1 bottle serum”, “1-night staycation for 2”)."); if (!value) throw new HttpsError("invalid-argument", "Add the item's value (₱) — it sets the creator's trust limit and Protect cover."); return { type, desc, value }; };

/** business → creator: an X-Deal request (item + optional tip + instructions) */
exports.xdealSend = onCall(async (req) => {
  await maintGuard(req);
  const who = await staffFrom(req); if (!hasRole(who, "manager")) throw new HttpsError("permission-denied", "Owner or manager only.");
  const st = (await db.doc(`stores/${who.storeId}`).get()).data() || {};
  if (!xEligible(st)) throw new HttpsError("failed-precondition", "X-Deals are for businesses with products, food or staycations.");
  await collabLiveGuard(req, st);
  const d = req.data || {}; const pub = await inqStore(d.slug); if (pub.storeId === who.storeId) throw new HttpsError("invalid-argument", "That's your own page.");
  const cst = (await db.doc(`stores/${pub.storeId}`).get()).data() || {}; const FL = cst.settings?.salon?.freelance || {}; const X = FL.xdeal || {};
  if (!X.on) throw new HttpsError("failed-precondition", "This creator doesn't take X-Deals — send a normal offer instead.");
  if (cst.xBanned) throw new HttpsError("failed-precondition", "This creator can't take X-Deals right now.");
  if (!FL.adult || !cst.kycAt) throw new HttpsError("failed-precondition", "This creator hasn't finished ID verification yet.");
  const item = cleanItem(d.item); if (Array.isArray(X.types) && X.types.length && !X.types.includes(item.type)) throw new HttpsError("failed-precondition", `This creator takes: ${X.types.join(", ")}.`);
  if (item.value > xCap(cst)) throw new HttpsError("failed-precondition", `This creator is new — X-Deals up to ₱${xCap(cst).toLocaleString("en-PH")} item value for now. Try a smaller item, or a creator with more completed X-Deals.`);
  const tip = Math.max(0, Math.round(Number(d.tip) || 0)); const minTip = Math.max(0, Number(X.minTip) || 0);
  if (tip < minTip) throw new HttpsError("failed-precondition", `This creator asks for a minimum tip of ₱${minTip} with X-Deals.`);
  if (st.ownerUid && st.ownerUid === cst.ownerUid) throw new HttpsError("failed-precondition", "You can't send an X-Deal to your own creator page.");
  await xCount(who.storeId, st.mode, "business");
  const ref = await db.collection(`stores/${pub.storeId}/inquiries`).add({
    kind: "xdeal", status: "negotiating", item, tipOffer: tip, minTip, shipping: ["business", "creator", "talk"].includes(d.shipping) ? d.shipping : "talk",
    instructions: String(d.instructions || "").trim().slice(0, 800), deliverables: [], xDeliver: String(d.deliverables || "1 vertical video (30–60 s)").slice(0, 200), deadline: /^\d{4}-\d{2}-\d{2}$/.test(String(d.deadline || "")) ? d.deadline : "",
    fromStoreId: who.storeId, fromStoreName: st.name || "", fromOwnerUid: st.ownerUid || null, brief: { kind: "X-Deal", brand: st.name || "", details: String(d.instructions || item.desc).slice(0, 1500), location: item.type === "food" || item.type === "staycation" ? [st.contact?.address, st.contact?.city].filter(Boolean).join(", ") : "" },
    customer: { name: d.contactName || who.name || st.name, phone: String(d.phone || st.contact?.phone || "").slice(0, 30), email: "", messenger: st.contact?.messenger || "" }, customerUid: req.auth.uid,
    code: "X-" + Array.from({ length: 5 }, () => CLAIM_ALPHABET[Math.floor(Math.random() * CLAIM_ALPHABET.length)]).join(""), offers: [], x: { log: [{ a: "sent_offer", at: Date.now() }] }, revisionsUsed: 0, createdAt: FieldValue.serverTimestamp(), createdAtMs: Date.now(), updatedAt: FieldValue.serverTimestamp(),
  });
  notifyTelegram(pub.storeId, "reservation", `🎁 X-Deal from ${st.name}: ${item.desc} (₱${item.value})${tip ? ` + ₱${tip} tip` : ""}`);
  sendPush(pub.storeId, { roles: ["manager"] }, { title: "🎁 New X-Deal", body: `${st.name} · ${item.desc}`, url: "/app/#projects", tag: "x-" + ref.id });
  return { id: ref.id, storeId: pub.storeId };
});

/** both sides move an X-Deal along; every step is logged with a timestamp (the agreement + evidence) */
exports.xdealAction = onCall(async (req) => {
  const { uid } = requireAuth(req); const d = req.data || {};
  const ref = db.doc(`stores/${String(d.storeId || "")}/inquiries/${String(d.id || "")}`); const q = (await ref.get()).data();
  if (!q || q.kind !== "xdeal") throw new HttpsError("not-found", "X-Deal not found.");
  const t = req.auth.token || {};
  const isCreator = t.storeId === d.storeId && ["owner", "staff"].includes(t.role);
  const isBiz = q.customerUid === uid || (t.storeId === q.fromStoreId && ["owner", "staff"].includes(t.role));
  if (!isCreator && !isBiz) throw new HttpsError("permission-denied", "Not your X-Deal.");
  let side = isCreator ? "creator" : "business";
  const now = Date.now(); const X = q.x || {}; const log = (a, extra = {}) => ({ "x.log": [...(X.log || []), { a, at: now, by: side, ...extra }].slice(-60) });
  const upd = (p) => ref.update({ ...p, updatedAt: FieldValue.serverTimestamp() });
  const need = (s, st) => { if (s === "business" && isBiz) side = "business"; if (s === "creator" && isCreator) side = "creator"; if (side !== s) throw new HttpsError("permission-denied", s === "creator" ? "Only the creator can do that." : "Only the business can do that."); if (st && !st.includes(q.status)) throw new HttpsError("failed-precondition", "Not at this step."); };
  const A = d.action;
  if (A === "accept") { need("creator", ["negotiating"]); const cst = (await db.doc(`stores/${d.storeId}`).get()).data() || {}; await xCount(d.storeId, "salon", "creator"); const days = Math.max(1, Math.min(30, parseInt(d.releaseDays, 10) || cst.settings?.salon?.freelance?.xdeal?.releaseDays || 5)); await upd({ status: "accepted", releaseDays: days, termsAt: now, ...log("accepted", { releaseDays: days }) }); notifyTelegram(q.fromStoreId, "reservation", `✅ ${cst.name} accepted your X-Deal ${q.code} — video ${days} day(s) after they receive the item.`); return { ok: true }; }
  if (A === "decline") { if (!["negotiating", "accepted"].includes(q.status) || (side === "business" && q.status !== "negotiating")) throw new HttpsError("failed-precondition", "Too late to decline — use the dispute chat."); await upd({ status: "declined", declinedBy: side, reason: String(d.reason || "").slice(0, 200), ...log("declined") }); return { ok: true }; }
  if (A === "sent") { need("business", ["accepted"]); await upd({ status: "sent", "x.sentAt": now, "x.sentProof": String(d.proof || "").slice(0, 300), "x.tracking": String(d.tracking || "").slice(0, 120), "x.courier": String(d.courier || "").slice(0, 40), ...log("item_sent") }); return { ok: true }; }
  if (A === "received") { need("creator", ["sent", "accepted"]); const due = now + (q.releaseDays || 5) * 86400000; await upd({ status: "received", "x.receivedAt": now, "x.receivedPhoto": String(d.photo || "").slice(0, 300), "x.dueAt": due, ...log("item_received") }); return { ok: true, dueAt: due }; }
  if (A === "notReceived") { need("creator", ["sent"]); await upd({ "x.notReceived": { at: now, note: String(d.note || "").slice(0, 200) }, ...log("not_received") }); notifyAdmin(`📦 X-Deal ${q.code}: creator says the item hasn't arrived.`); return { ok: true }; }
  if (A === "submit") { need("creator", ["received", "revision"]); const link = String(d.link || "").trim().slice(0, 500); const file = typeof d.file === "string" && d.file.startsWith(`xdeal/${d.storeId}/${d.id}/`) ? d.file : null; if (!/^https?:\/\//.test(link) && !file) throw new HttpsError("invalid-argument", "Upload the 1080p preview or paste a Drive link (with watermark)."); const late = X.dueAt && now > X.dueAt; await upd({ status: "submitted", "x.submittedAt": now, "x.preview": { link: link || null, file, at: now }, "x.late": !!late, ...log("video_submitted", { late: !!late }) }); notifyTelegram(q.fromStoreId, "reservation", `🎬 X-Deal ${q.code}: the video is ready to review.`); return { ok: true, late: !!late }; }
  if (A === "revise") { need("business", ["submitted"]); if ((q.revisionsUsed || 0) >= 1) throw new HttpsError("failed-precondition", "The 1 revision in the X-Deal is used."); await upd({ status: "revision", revisionsUsed: (q.revisionsUsed || 0) + 1, "x.revisionNote": String(d.note || "").slice(0, 300), ...log("revision", { note: String(d.note || "").slice(0, 120) }) }); return { ok: true }; }
  if (A === "approve") { need("business", ["submitted"]); await upd({ status: "approved", "x.approvedAt": now, ...log("approved") }); return { ok: true }; }
  if (A === "release") { need("creator", ["approved"]); const hi = String(d.link || "").trim().slice(0, 500); if (!/^https?:\/\//.test(hi)) throw new HttpsError("invalid-argument", "Paste the Google Drive link of the high-res video."); await upd({ status: "released", "x.releasedAt": now, "x.hiRes": hi, "x.postLink": String(d.postLink || "").slice(0, 500), ...log("released") }); return { ok: true }; }
  if (A === "confirmReleased") { need("business", ["released"]);
    await upd({ status: "done", doneAt: now, "x.confirmedAt": now, ...log("confirmed") });
    const late = !!X.late; await db.doc(`stores/${d.storeId}`).set({ stats: { xDone: FieldValue.increment(1), delTotal: FieldValue.increment(1), delOnTime: FieldValue.increment(late ? 0 : 1), projectsDone: FieldValue.increment(1) } }, { merge: true });
    return { ok: true }; }
  if (A === "tip") { need("business", ["accepted", "sent", "received", "submitted", "revision", "approved", "released", "done"]); const amount = Math.max(1, Math.round(Number(d.amount) || 0)); await upd({ "x.tips": [...(X.tips || []), { amount, ref: String(d.ref || "").slice(0, 60), at: now, confirmed: false }], ...log("tip_sent", { amount }) }); notifyTelegram(d.storeId, "reservation", `💝 ${q.fromStoreName} sent you a ₱${amount} tip for ${q.code}.`); return { ok: true }; }
  if (A === "tipReceived") { need("creator"); const i = parseInt(d.i, 10) || 0; const tips = (X.tips || []).map((x, k) => (k === i ? { ...x, confirmed: true, confirmedAt: now } : x)); await upd({ "x.tips": tips, ...log("tip_received") }); return { ok: true }; }
  if (A === "review") { if (q.status !== "done") throw new HttpsError("failed-precondition", "Review after it's done."); const r = Math.max(1, Math.min(5, parseInt(d.rating, 10) || 5)); const key = side === "business" ? "x.reviewByBusiness" : "x.reviewByCreator"; if ((side === "business" ? X.reviewByBusiness : X.reviewByCreator)) throw new HttpsError("already-exists", "Already rated."); await upd({ [key]: { rating: r, comment: String(d.comment || "").slice(0, 300), at: now } });
    const target = side === "business" ? d.storeId : q.fromStoreId; await db.doc(`stores/${target}`).set({ stats: { xRateSum: FieldValue.increment(r), xRateN: FieldValue.increment(1) } }, { merge: true }); return { ok: true }; }
  throw new HttpsError("invalid-argument", "Unknown action.");
});

/** hourly: auto-approve when the business stays quiet (3 days), fail + strike when the creator ghosts (7 days past due) */
exports.xdealTick = onSchedule({ schedule: "every 60 minutes", timeZone: "Asia/Manila" }, async () => {
  const now = Date.now(); const snap = await db.collectionGroup("inquiries").where("kind", "==", "xdeal").where("status", "in", ["submitted", "received", "revision"]).limit(500).get();
  for (const x of snap.docs) {
    const q = x.data(); const X = q.x || {};
    if (q.status === "submitted" && X.submittedAt && now - X.submittedAt > 3 * 86400000) await x.ref.update({ status: "approved", "x.approvedAt": now, "x.autoApproved": true, "x.log": [...(X.log || []), { a: "auto_approved", at: now, by: "taptayo" }] });
    else if (["received", "revision"].includes(q.status) && X.dueAt && now > X.dueAt + 7 * 86400000) {
      await x.ref.update({ status: "failed", "x.failedAt": now, "x.log": [...(X.log || []), { a: "creator_no_show", at: now, by: "taptayo" }] });
      const sref = x.ref.parent.parent; const s = (await sref.get()).data() || {}; const strikes = (s.xStrikes || 0) + 1;
      await sref.set({ xStrikes: strikes, ...(strikes >= 3 ? { xBanned: true, xBannedAt: now } : {}) }, { merge: true });
      notifyTelegram(q.fromStoreId, "incident", `⚠️ X-Deal ${q.code}: the creator didn't deliver 7 days after the due date. If you have TapTayo Protect you can file a claim.`);
      notifyAdmin(`⚠️ X-Deal failed ${q.code} · creator strike ${strikes}${strikes >= 3 ? " → banned from X-Deals" : ""}`);
    }
  }
});

/** creator ID on file (private) — required for X-Deals because businesses send real items */
exports.creatorKyc = onCall(async () => {
  throw new HttpsError("failed-precondition", "Identity-document collection is disabled. The Verified badge is handled separately.");
});

/** TapTayo Protect: the creator ghosted → the declared item value comes back as TapTayo credits (reviewed by TapTayo) */
exports.protectClaim = onCall(async (req) => {
  const who = await staffFrom(req); if (!hasRole(who, "manager")) throw new HttpsError("permission-denied", "Owner or manager only.");
  const sub = (await db.doc(`stores/${who.storeId}/subscription/current`).get()).data() || {};
  if (!(addonQty(sub, "protect") > 0) || !sub.protectSince) throw new HttpsError("failed-precondition", "TapTayo Protect isn't active on your plan.");
  if (Date.now() - sub.protectSince < 14 * 86400000) throw new HttpsError("failed-precondition", "Protect covers X-Deals 14 days after it turns on.");
  const d = req.data || {}; const ref = db.doc(`stores/${String(d.creatorStoreId || "")}/inquiries/${String(d.id || "")}`); const q = (await ref.get()).data();
  if (!q || q.kind !== "xdeal" || q.fromStoreId !== who.storeId) throw new HttpsError("not-found", "X-Deal not found.");
  const X = q.x || {}; const ghosted = q.status === "failed" || (q.status === "sent" && X.sentAt && Date.now() - X.sentAt > 14 * 86400000 && !X.notReceived && (X.tracking || X.sentProof));
  if (!ghosted) throw new HttpsError("failed-precondition", "A claim is possible when the creator didn't deliver 7 days after the due date (or never confirmed a tracked delivery after 14 days).");
  if (!(X.tracking || X.sentProof || X.receivedAt)) throw new HttpsError("failed-precondition", "We need proof the item was sent (tracking number or photo).");
  if ((X.failedAt || X.sentAt) < Date.now() - 30 * 86400000) throw new HttpsError("failed-precondition", "Claims must be filed within 30 days.");
  if ((await db.collection("protectClaims").where("inquiryId", "==", String(d.id)).get()).size) throw new HttpsError("already-exists", "Already claimed.");
  const cst = (await db.doc(`stores/${d.creatorStoreId}`).get()).data() || {}; const st = (await db.doc(`stores/${who.storeId}`).get()).data() || {};
  const linked = (cst.ownerUid && cst.ownerUid === st.ownerUid) || (cst.contact?.phone && String(cst.contact.phone).replace(/\D/g, "") === String(st.contact?.phone || "").replace(/\D/g, ""));
  const month = phYmd(Date.now()).slice(0, 7); const mine = (await db.collection("protectClaims").where("storeId", "==", who.storeId).get()).docs.map((x) => x.data()).filter((c) => c.month === month && c.status !== "rejected");
  if (mine.length >= 2) throw new HttpsError("resource-exhausted", "Protect covers up to 2 claims a month.");
  const left = 3000 - mine.reduce((a, c) => a + (c.amount || 0), 0); const amount = Math.max(0, Math.min(q.item?.value || 0, 1500, left));
  if (!amount) throw new HttpsError("resource-exhausted", "You've reached this month's ₱3,000 Protect limit.");
  const cref = await db.collection("protectClaims").add({ storeId: who.storeId, storeName: st.name || "", creatorStoreId: d.creatorStoreId, creatorName: cst.name || "", inquiryId: String(d.id), code: q.code, item: q.item, amount, month, status: linked ? "flagged" : "pending", linked: !!linked, note: String(d.note || "").slice(0, 500), at: Date.now() });
  notifyAdmin(`🛡 Protect claim ${q.code} · ${st.name} · ₱${amount}${linked ? " · ⚠️ linked accounts" : ""}`);
  return { id: cref.id, amount };
});
exports.adminProtectClaims = onCall(async (req) => {
  requireAdmin(req); const d = req.data || {};
  if (d.action === "list") return (await db.collection("protectClaims").orderBy("at", "desc").limit(100).get()).docs.map((x) => ({ id: x.id, ...x.data() }));
  const ref = db.doc(`protectClaims/${String(d.id || "")}`); const c = (await ref.get()).data(); if (!c) throw new HttpsError("not-found", "Claim not found.");
  if (c.status === "approved") throw new HttpsError("already-exists", "Already approved.");
  if (d.action === "approve") { await db.doc(`stores/${c.storeId}`).set({ credits: FieldValue.increment(c.amount) }, { merge: true }); await db.collection(`stores/${c.storeId}/creditLog`).add({ amount: c.amount, reason: `Protect claim ${c.code}`, at: Date.now() }); }
  await ref.update({ status: d.action === "approve" ? "approved" : "rejected", reason: String(d.reason || "").slice(0, 200), doneAt: Date.now() });
  return { ok: true };
});

// ---- B2B video swap: two businesses make a video for each other; files unlock only when BOTH uploaded
const pubSwap = (id, s, me) => ({ id, status: s.status, a: s.a, b: s.b, give: s.give, want: s.want, deadline: s.deadline, note: s.note || "", mySide: me, files: { a: !!(s.files?.a), b: !!(s.files?.b) }, unlocked: !!(s.files?.a && s.files?.b), confirmed: s.confirmed || {}, createdAtMs: s.createdAtMs, log: (s.log || []).slice(-20) });
exports.swapDirectory = onCall(async (req) => {
  if (!realAccount(req) && !(req.auth?.token?.demo)) throw new HttpsError("unauthenticated", "Log in with your TapTayo account.");
  const snap = await db.collection("publicStores").where("swapListed", "==", true).limit(200).get(); const q = String(req.data?.q || "").toLowerCase();
  return snap.docs.map((x) => x.data()).filter((p) => !q || `${p.name} ${p.tagline} ${p.contact?.address || ""}`.toLowerCase().includes(q)).map((p) => ({ slug: p.slug, storeId: p.storeId, name: p.name, tagline: p.tagline || "", logoUrl: p.logoUrl || null, coverUrl: p.coverUrl || null, businessType: p.businessType, city: p.contact?.city || "" })).slice(0, 60);
});
exports.swapPropose = onCall(async (req) => {
  await maintGuard(req);
  const who = await staffFrom(req); if (!hasRole(who, "manager")) throw new HttpsError("permission-denied", "Owner or manager only.");
  const st = (await db.doc(`stores/${who.storeId}`).get()).data() || {}; if (!xEligible(st)) throw new HttpsError("failed-precondition", "B2B swaps are for businesses with products, food or staycations.");
  await collabLiveGuard(req, st);
  const d = req.data || {}; const pub = (await db.doc(`publicStores/${String(d.slug || "")}`).get()).data(); if (!pub) throw new HttpsError("not-found", "Business not found.");
  if (pub.storeId === who.storeId) throw new HttpsError("invalid-argument", "That's your own business.");
  const ost = (await db.doc(`stores/${pub.storeId}`).get()).data() || {}; if (!xEligible(ost) || ost.settings?.collab?.swap !== true) throw new HttpsError("failed-precondition", "This business isn't open to swaps.");
  await xCount(who.storeId, st.mode, "business");
  const side = (s, sid) => ({ storeId: sid, name: s.name || "", slug: s.slug || "", logoUrl: s.logoUrl || null, ownerUid: s.ownerUid || null });
  const ref = await db.collection("swaps").add({ status: "proposed", a: side(st, who.storeId), b: side(ost, pub.storeId), give: String(d.give || "").trim().slice(0, 300), want: String(d.want || "").trim().slice(0, 300), note: String(d.note || "").slice(0, 500), deadline: /^\d{4}-\d{2}-\d{2}$/.test(String(d.deadline || "")) ? d.deadline : "", files: {}, confirmed: {}, parties: [who.storeId, pub.storeId], log: [{ a: "proposed", at: Date.now(), by: "a" }], createdAtMs: Date.now() });
  notifyTelegram(pub.storeId, "reservation", `🤝 ${st.name} wants a B2B video swap: ${String(d.give || "").slice(0, 100)}`);
  return { id: ref.id };
});
async function swapSide(req, id) {
  const who = await staffFrom(req); const ref = db.doc(`swaps/${String(id || "")}`); const s = (await ref.get()).data();
  if (!s) throw new HttpsError("not-found", "Swap not found."); const me = s.a.storeId === who.storeId ? "a" : s.b.storeId === who.storeId ? "b" : null;
  if (!me) throw new HttpsError("permission-denied", "Not your swap."); return { who, ref, s, me, other: me === "a" ? "b" : "a" };
}
exports.swapAction = onCall(async (req) => {
  const d = req.data || {}; const { who, ref, s, me, other } = await swapSide(req, d.id); const now = Date.now(); const log = (a) => [...(s.log || []), { a, at: now, by: me }].slice(-40);
  if (!hasRole(who, "manager")) throw new HttpsError("permission-denied", "Owner or manager only.");
  if (d.action === "accept") { if (me !== "b" || s.status !== "proposed") throw new HttpsError("failed-precondition", "Can't accept now."); const st = (await db.doc(`stores/${who.storeId}`).get()).data() || {}; await xCount(who.storeId, st.mode, "business"); await ref.update({ status: "accepted", acceptedAt: now, log: log("accepted") }); return { ok: true }; }
  if (d.action === "decline" || d.action === "cancel") { if (!["proposed", "accepted"].includes(s.status) || (s.status === "accepted" && (s.files?.a || s.files?.b))) throw new HttpsError("failed-precondition", "Too late — a video is already uploaded."); await ref.update({ status: d.action === "decline" ? "declined" : "cancelled", log: log(d.action) }); return { ok: true }; }
  if (d.action === "upload") { if (s.status !== "accepted") throw new HttpsError("failed-precondition", "Accept the swap first."); const link = String(d.link || "").trim().slice(0, 500); const file = typeof d.file === "string" && d.file.startsWith(`swaps/${d.id}/${me}/`) ? d.file : null; if (!/^https?:\/\//.test(link) && !file) throw new HttpsError("invalid-argument", "Upload the 1080p video or paste a Drive link (with watermark)."); await ref.update({ [`files.${me}`]: { link: link || null, file, at: now }, log: log("uploaded") }); const both = !!(s.files?.[other]); if (both) notifyTelegram(s[other].storeId, "reservation", `🔓 Swap with ${s[me].name}: both videos are in — you can download now.`); return { ok: true, unlocked: both }; }
  if (d.action === "get") { // the other side's video — only when BOTH have uploaded (double lock)
    if (!(s.files?.a && s.files?.b)) throw new HttpsError("failed-precondition", "🔒 Unlocks when both of you have uploaded.");
    const f = s.files[other]; let url = f.link || null;
    if (f.file) { try { const [u] = await admin.storage().bucket().file(f.file).getSignedUrl({ action: "read", expires: now + 3600000 }); url = u; } catch (e) { throw new HttpsError("unavailable", "Couldn't prepare the download — try again."); } }
    await ref.update({ [`downloads.${me}`]: now }); return { url };
  }
  if (d.action === "confirm") { if (!(s.files?.a && s.files?.b)) throw new HttpsError("failed-precondition", "Both videos first."); const c = { ...(s.confirmed || {}), [me]: now }; await ref.update({ confirmed: c, ...(c.a && c.b ? { status: "done", doneAt: now } : {}), log: log("confirmed") }); return { ok: true }; }
  throw new HttpsError("invalid-argument", "Unknown action.");
});
exports.swapMine = onCall(async (req) => {
  const t = req.auth?.token || {}; const who = t.role === "viewer" && t.demo && t.storeId ? { storeId: t.storeId } : await staffFrom(req);
  const snap = await db.collection("swaps").where("parties", "array-contains", who.storeId).limit(50).get();
  return snap.docs.map((x) => pubSwap(x.id, x.data(), x.data().a.storeId === who.storeId ? "a" : "b")).sort((a, b) => b.createdAtMs - a.createdAtMs);
});
/** X-Deal preview download for the business (signed link, 1 hour) — files auto-delete 3 days after the first download */
exports.xfileUrl = onCall(async (req) => {
  const { uid } = requireAuth(req); const d = req.data || {}; const q = (await db.doc(`stores/${String(d.storeId || "")}/inquiries/${String(d.id || "")}`).get()).data();
  if (!q || q.kind !== "xdeal") throw new HttpsError("not-found", "Not found."); const t = req.auth.token || {};
  if (!(q.customerUid === uid || t.storeId === q.fromStoreId || t.storeId === d.storeId)) throw new HttpsError("permission-denied", "Not yours.");
  const f = q.x?.preview?.file; if (!f) return { url: q.x?.preview?.link || null };
  const [url] = await admin.storage().bucket().file(f).getSignedUrl({ action: "read", expires: Date.now() + 3600000 });
  if (t.storeId !== d.storeId && !q.x?.downloadedAt) await db.doc(`stores/${d.storeId}/inquiries/${d.id}`).update({ "x.downloadedAt": Date.now() });
  return { url };
});
exports.xfileCleanup = onSchedule({ schedule: "every 6 hours", timeZone: "Asia/Manila" }, async () => {
  const cut = Date.now() - 3 * 86400000; const bucket = admin.storage().bucket();
  const xs = await db.collectionGroup("inquiries").where("x.downloadedAt", "<", cut).limit(200).get();
  for (const x of xs.docs) { const f = x.data().x?.preview?.file; if (f) { await bucket.file(f).delete().catch(() => {}); await x.ref.update({ "x.preview.file": null, "x.preview.deleted": Date.now() }); } }
  const sw = await db.collection("swaps").where("status", "==", "done").limit(200).get();
  for (const x of sw.docs) { const s = x.data(); if (Math.min(s.downloads?.a || Infinity, s.downloads?.b || Infinity) < cut) for (const k of ["a", "b"]) { const f = s.files?.[k]?.file; if (f) { await bucket.file(f).delete().catch(() => {}); await x.ref.update({ [`files.${k}.file`]: null, [`files.${k}.deleted`]: Date.now() }); } } }
});
exports.inquiryOwner = onCall(async (req) => { // the freelancer: quote, verify DP, deliver drafts, finish, decline
  const who = await staffFrom(req); if (!hasRole(who, "crew", "stylist")) throw new HttpsError("permission-denied", "Not allowed.");
  const d = req.data || {}; const ref = db.doc(`stores/${who.storeId}/inquiries/${String(d.id || "")}`); const q = (await ref.get()).data(); if (!q) throw new HttpsError("not-found", "Inquiry not found.");
  const now = Date.now(); const upd = (p) => ref.update({ ...p, updatedAt: FieldValue.serverTimestamp() });
  if (["quote", "acceptOffer"].includes(d.action) && q.status !== "quoted") await dealsGuard(who.storeId);
  if (d.action === "counter" || d.action === "acceptOffer") {
    if (!["negotiating", "new", "quoted"].includes(q.status)) throw new HttpsError("failed-precondition", "Too late to negotiate.");
    const FL = ((await db.doc(`stores/${who.storeId}`).get()).data()?.settings?.salon || {}).freelance || {};
    if (d.action === "counter") { const o = cleanOffer(d.offer, "creator"); await upd({ status: "negotiating", offers: [...(q.offers || []), o] }); return { ok: true }; }
    const last = (q.offers || []).slice(-1)[0]; if (!last || last.from !== "client") throw new HttpsError("failed-precondition", "No client offer to accept.");
    await upd({ status: "quoted", quote: offerQuote(last, FL, { date: q.brief?.date || "" }) }); return { ok: true };
  }
  if (d.action === "quote") {
    if (!["new", "quoted", "negotiating"].includes(q.status)) throw new HttpsError("failed-precondition", "Already accepted.");
    const lines = (d.lines || []).slice(0, 20).map((l) => ({ name: String(l.name || "").trim().slice(0, 80), price: Math.max(0, Number(l.price) || 0) })).filter((l) => l.name);
    if (!lines.length) throw new HttpsError("invalid-argument", "Add at least one line.");
    const total = round2(lines.reduce((a, l) => a + l.price, 0));
    const deliverables = (d.deliverables || []).slice(0, 20).map((x, i) => ({ id: "d" + (i + 1), name: String(x.name || "").trim().slice(0, 80), due: /^\d{4}-\d{2}-\d{2}$/.test(String(x.due || "")) ? x.due : "", status: "todo", versions: [], notes: [] })).filter((x) => x.name);
    const rush = Number(d.rushHours) > 0 ? { hours: Math.min(720, Math.round(Number(d.rushHours))), fee: Math.max(0, Number(d.rushFee) || 0) } : null;
    if (rush?.fee) lines.push({ name: `Rush · within ${rush.hours} h`, price: rush.fee });
    const qDate = /^\d{4}-\d{2}-\d{2}$/.test(String(d.date || "")) ? d.date : q.brief?.date || "";
    // photographers: raw copies / final edits due N days after the shoot
    if (qDate && (Number(d.rawDays) > 0 || Number(d.finalDays) > 0)) { const due = (n) => ymdAdd(qDate, Math.round(n)); if (Number(d.rawDays) > 0 && !deliverables.some((x) => /raw/i.test(x.name))) deliverables.push({ id: "raw", name: "Raw copies", due: due(d.rawDays), status: "todo", versions: [], notes: [] }); if (Number(d.finalDays) > 0 && !deliverables.some((x) => /final/i.test(x.name))) deliverables.push({ id: "final", name: "Final edited copies", due: due(d.finalDays), status: "todo", versions: [], notes: [] }); }
    const total2 = round2(lines.reduce((a, l) => a + l.price, 0));
    const quote = { lines, rush, usage: String(d.usage || "").slice(0, 200), total: total2, dpPercent: Math.max(0, Math.min(100, Number(d.dpPercent ?? 50))), revisions: Math.max(0, Math.min(10, parseInt(d.revisions ?? 2, 10))), terms: String(d.terms || "").slice(0, 3000), note: String(d.note || "").slice(0, 500), date: /^\d{4}-\d{2}-\d{2}$/.test(String(d.date || "")) ? d.date : q.brief?.date || "", validUntil: now + Math.max(1, Math.min(60, Number(d.validDays) || 7)) * 86400000, by: who.name, at: now };
    quote.date = qDate; delete quote.lines_; await upd({ status: "quoted", quote: { ...quote, lines }, deliverables });
    return { ok: true, total: total2 };
  }
  if (d.action === "verifyDp") { if (!q.dp || q.dp.status !== "to_verify") throw new HttpsError("failed-precondition", "No downpayment to verify."); await upd({ "dp.status": "verified", "dp.by": who.name, "dp.verifiedAt": now, status: "in_progress", paidAmount: q.dp.amount, ...(q.quote?.rush ? { "quote.rush.dueAt": now + q.quote.rush.hours * 3600000 } : {}) }); return { ok: true }; }
  if (d.action === "refundSent") { if (!q.refund) throw new HttpsError("failed-precondition", "No refund due."); await upd({ "refund.status": "sent", "refund.sentAt": now, "refund.ref": String(d.ref || "").slice(0, 60) }); return { ok: true }; }
  if (d.action === "checkin") { // on-site safety: arrived / I'm safe / done & left / 🆘
    const kind = ["arrived", "safe", "left", "sos"].includes(d.kind) ? d.kind : "safe";
    const c = { kind, at: now, pin: String(d.pin || "").slice(0, 120), by: who.name };
    await upd({ checkins: [...(q.checkins || []).slice(-30), c] });
    if (kind === "sos") { notifyTelegram(who.storeId, "incident", `🆘 SOS from ${who.name} at ${q.brief?.location || "the shoot"} (${q.code})${c.pin ? ` — ${c.pin}` : ""}. Client: ${q.customer?.name} ${q.customer?.phone || ""}`, { safety: true }); notifyAdmin(`🆘 Creator SOS · ${who.storeId} · ${q.code}`); }
    return { ok: true };
  }
  if (d.action === "postProof") { // after posting: link + views/likes (+ screenshot) — proof for the brand
    const deliverables = (q.deliverables || []).map((x) => (x.id === d.deliverableId ? { ...x, post: { link: String(d.link || "").slice(0, 500), views: Math.max(0, Number(d.views) || 0), likes: Math.max(0, Number(d.likes) || 0), shot: d.shot ? String(d.shot).slice(0, 300) : null, at: now } } : x));
    await upd({ deliverables }); return { ok: true };
  }
  if (d.action === "dpReject") { await upd({ "dp.status": "rejected", status: "quoted", "dp.reason": String(d.reason || "Not found").slice(0, 120) }); return { ok: true }; }
  if (d.action === "deliver") {
    const link = String(d.link || "").trim().slice(0, 500); if (!/^https?:\/\//.test(link)) throw new HttpsError("invalid-argument", "Paste the link to the file (Google Drive, Dropbox, YouTube…).");
    const dl = (q.deliverables || []).find((x) => x.id === d.deliverableId); if (!dl) throw new HttpsError("not-found", "Deliverable not found.");
    const late = dl.due && now > new Date(`${dl.due}T23:59:59+08:00`).getTime();
    const deliverables = (q.deliverables || []).map((x) => (x.id === d.deliverableId ? { ...x, status: "review", ...(d.final ? { deliveredAt: now, late: !!late } : {}), versions: [...(x.versions || []), { link, note: String(d.note || "").slice(0, 300), final: !!d.final, at: now }] } : x));
    const patch = { deliverables, status: "in_progress" };
    // rush missed → the client is compensated automatically (the freelancer's default: refund the rush fee, a discount next time, or both)
    const R = q.quote?.rush;
    if (d.final && R?.dueAt && !R.done) {
      const missed = now > R.dueAt; patch["quote.rush.done"] = now; patch["quote.rush.missed"] = missed;
      if (missed) {
        const FL = ((await db.doc(`stores/${who.storeId}`).get()).data()?.settings?.salon || {}).freelance || {}; const mode = FL.rushMiss || "refund";
        if ((mode === "refund" || mode === "both") && R.fee) patch.refund = { amount: R.fee, status: "due", reason: "Rush deadline missed — rush fee returned", at: now };
        if (mode === "discount" || mode === "both") patch.nextDiscount = { percent: Number(FL.rushMissPct) || 10, reason: "Rush deadline missed", at: now };
        notifyTelegram(who.storeId, "incident", `⏰ Rush deadline missed · ${q.code} — ${mode === "refund" ? `refund ₱${R.fee}` : mode === "discount" ? `${Number(FL.rushMissPct) || 10}% off next booking` : `refund ₱${R.fee} + ${Number(FL.rushMissPct) || 10}% off next`} for the client.`);
      }
    }
    await upd(patch);
    if (d.final && dl.due) await db.doc(`stores/${who.storeId}`).set({ stats: { delTotal: FieldValue.increment(1), delOnTime: FieldValue.increment(late ? 0 : 1) } }, { merge: true });
    return { ok: true, late: !!late };
  }
  if (d.action === "addDeliverable") { const deliverables = [...(q.deliverables || []), { id: "d" + ((q.deliverables || []).length + 1) + "_" + (now % 1000), name: String(d.name || "").slice(0, 80), due: d.due || "", status: "todo", versions: [], notes: [] }]; await upd({ deliverables }); return { ok: true }; }
  if (d.action === "paid") { await upd({ paidAmount: round2(Math.min(q.quote?.total || 0, (q.paidAmount || 0) + Math.max(0, Number(d.amount) || 0))), payments: FieldValue.arrayUnion({ amount: Number(d.amount) || 0, method: String(d.method || "cash").slice(0, 20), at: now, by: who.name }) }); return { ok: true }; }
  if (d.action === "done") { await upd({ status: "done", doneAt: now }); if (q.status !== "done") await db.doc(`stores/${who.storeId}`).set({ stats: { projectsDone: FieldValue.increment(1) } }, { merge: true }); return { ok: true }; }
  if (d.action === "decline") { await upd({ status: "declined", declinedBy: "owner", reason: String(d.reason || "Not available").slice(0, 200) }); return { ok: true }; }
  throw new HttpsError("invalid-argument", "Unknown action.");
});
// ===== 💬 Support chat (homepage + in-app) — no calls; TapTayo replies within 24 hours from /admin =====
// supportThreads/{id} { uid, storeId, storeName, name, contact, status open|answered|closed, unreadAdmin, unreadUser, lastAt, lastText }
//   └ messages/{id} { from: user|admin, text, photo, at }
const SUPPORT_SAVED = ["Thanks for messaging! We're checking this now.", "Could you send a screenshot of what you see?", "Fixed on our side — please reload the app (pull down or close and open again).", "Sorry for the trouble — we added free days to your plan.", "Glad it works now! Closing this chat — message us anytime."];
async function supportMsg(threadId, m) { await db.collection(`supportThreads/${threadId}/messages`).add({ ...m, at: Date.now() }); }
exports.supportSend = onCall(async (req) => {
  const { uid, token } = requireAuth(req); const d = req.data || {};
  const text = String(d.text || "").trim().slice(0, 1500); const photo = String(d.photo || "");
  if (!text && !photo) throw new HttpsError("invalid-argument", "Type your message.");
  if (photo && !photo.startsWith(`support/${uid}/`)) throw new HttpsError("invalid-argument", "Bad photo.");
  let ref = d.threadId ? db.doc(`supportThreads/${String(d.threadId)}`) : null; let th = ref ? (await ref.get()).data() : null;
  if (th && th.uid !== uid) throw new HttpsError("permission-denied", "Not your chat.");
  const recent = await db.collection("supportThreads").where("uid", "==", uid).limit(20).get();
  if (!th && recent.docs.filter((x) => x.data().createdAt > Date.now() - 3600e3).length >= 3) throw new HttpsError("resource-exhausted", "You've opened a few chats already — please continue in your open chat.");
  const now = Date.now();
  if (!th || th.status === "closed") {
    const st = token.storeId ? (await db.doc(`stores/${token.storeId}`).get()).data() || {} : {};
    const name = String(d.name || st.name || token.name || "").trim().slice(0, 60), contact = String(d.contact || token.email || st.contact?.phone || "").trim().slice(0, 80);
    if (!token.storeId && (!name || contact.length < 5)) throw new HttpsError("invalid-argument", "Please add your name and mobile number or email so we can reply.");
    th = { uid, storeId: token.storeId || null, storeName: st.name || null, slug: st.slug || null, mode: st.mode || null, role: token.role || "visitor", name, contact, page: String(d.page || "").slice(0, 80), status: "open", unreadAdmin: 0, unreadUser: 0, createdAt: now };
    ref = db.collection("supportThreads").doc(); await ref.set(th);
  }
  await supportMsg(ref.id, { from: "user", text, photo: photo || null });
  await ref.update({ status: "open", lastAt: now, lastText: (text || "📷 Photo").slice(0, 120), lastFrom: "user", unreadAdmin: FieldValue.increment(1) });
  notifyAdmin(`💬 Support · ${th.storeName || th.name || "visitor"}${th.mode ? ` (${th.mode})` : ""}: ${(text || "📷 photo").slice(0, 300)}\nReply: taptayo.com/admin/#support`);
  return { threadId: ref.id };
});
exports.supportClose = onCall(async (req) => {
  const { uid } = requireAuth(req); const ref = db.doc(`supportThreads/${String(req.data?.threadId || "")}`); const th = (await ref.get()).data();
  if (!th || th.uid !== uid) throw new HttpsError("permission-denied", "Not your chat.");
  const rating = req.data?.rating ? Math.max(1, Math.min(5, parseInt(req.data.rating, 10) || 0)) : null;
  await ref.update({ ...(req.data?.close !== false ? { status: "closed", closedAt: Date.now() } : {}), ...(rating ? { rating } : {}), unreadUser: 0 });
  return { ok: true };
});
exports.supportSeen = onCall(async (req) => { const { uid } = requireAuth(req); const ref = db.doc(`supportThreads/${String(req.data?.threadId || "")}`); const th = (await ref.get()).data(); if (th?.uid === uid) await ref.update({ unreadUser: 0 }); return { ok: true }; });
exports.supportAdmin = onCall(async (req) => {
  const { token } = requireAdmin(req); const d = req.data || {}; const now = Date.now();
  if (d.action === "list") {
    const snap = await db.collection("supportThreads").orderBy("lastAt", "desc").limit(150).get();
    return { threads: snap.docs.map((x) => ({ id: x.id, ...x.data() })), saved: SUPPORT_SAVED };
  }
  const ref = db.doc(`supportThreads/${String(d.threadId || "")}`); const th = (await ref.get()).data(); if (!th) throw new HttpsError("not-found", "Chat not found.");
  if (d.action === "get") {
    const msgs = (await ref.collection("messages").orderBy("at").limit(300).get()).docs.map((x) => ({ id: x.id, ...x.data() }));
    let sub = null; if (th.storeId) { const sd = (await db.doc(`stores/${th.storeId}/subscription/current`).get()).data(); if (sd) sub = { plan: sd.plan, status: sd.status, trialEndsAt: sd.trialEndsAt?.toMillis?.() || null, paidUntil: sd.paidUntil?.toMillis?.() || null, bonusDays: sd.bonusDays || 0 }; }
    await ref.update({ unreadAdmin: 0 });
    return { thread: { id: ref.id, ...th }, messages: msgs, sub };
  }
  if (d.action === "reply") {
    const text = String(d.text || "").trim().slice(0, 1500); if (!text) throw new HttpsError("invalid-argument", "Type a reply.");
    await supportMsg(ref.id, { from: "admin", text, by: token.email || "TapTayo" });
    await ref.update({ status: "answered", lastAt: now, lastText: text.slice(0, 120), lastFrom: "admin", unreadUser: FieldValue.increment(1) });
    if (th.storeId) sendPush(th.storeId, { roles: ["manager"] }, { title: "💬 TapTayo replied", body: text.slice(0, 120), url: "/app/#help", tag: "support-" + ref.id }).catch?.(() => {});
    return { ok: true };
  }
  if (d.action === "close") { await ref.update({ status: "closed", closedAt: now }); return { ok: true }; }
  if (d.action === "addDays") { // sorry for the trouble → free days on their plan
    if (!th.storeId) throw new HttpsError("failed-precondition", "This chat isn't linked to a shop.");
    const days = Math.max(1, Math.min(60, parseInt(d.days, 10) || 3)); const reason = String(d.reason || "For the trouble").slice(0, 120);
    const sRef = db.doc(`stores/${th.storeId}/subscription/current`); const sd = (await sRef.get()).data(); if (!sd) throw new HttpsError("not-found", "No subscription.");
    const add = days * 86400000; const patch = { bonusDays: FieldValue.increment(days), bonusLog: FieldValue.arrayUnion({ days, reason, by: token.email || "admin", at: now }), updatedAt: FieldValue.serverTimestamp() };
    if (sd.status === "trial" || sd.plan === "trial") patch.trialEndsAt = Timestamp.fromMillis(Math.max(now, sd.trialEndsAt?.toMillis?.() || now) + add);
    else if (sd.paidUntil && sd.plan !== "free") patch.paidUntil = Timestamp.fromMillis(Math.max(now, sd.paidUntil.toMillis()) + add);
    else { patch.provisional = { plan: "starter", until: Timestamp.fromMillis(now + add), reason }; }
    await sRef.update(patch);
    const text = `🎁 We added ${days} free day${days > 1 ? "s" : ""} to your plan — ${reason}. Salamat sa pasensya!`;
    await supportMsg(ref.id, { from: "admin", text, by: token.email || "TapTayo", gift: days });
    await ref.update({ lastAt: now, lastText: text.slice(0, 120), lastFrom: "admin", unreadUser: FieldValue.increment(1), status: "answered" });
    return { ok: true, days };
  }
  throw new HttpsError("invalid-argument", "Unknown action.");
});
exports.supportFile = onCall(async (req) => {
  const { uid, token } = requireAuth(req); const path = String(req.data?.path || "");
  const m = path.match(/^support\/([^/]+)\/[^/]+$/); if (!m) throw new HttpsError("invalid-argument", "Bad file.");
  if (m[1] !== uid && !(token.admin === true || isAdminEmail(token.email))) throw new HttpsError("permission-denied", "Not allowed.");
  const [buf] = await admin.storage().bucket().file(path).download(); if (buf.length > 6 * 1024 * 1024) throw new HttpsError("failed-precondition", "Too big.");
  return { base64: buf.toString("base64"), contentType: "image/jpeg" };
});
/** Admin settings: TapTayo's own GCash details (shown on every Billing page) + admin Telegram alerts. */
// ===== Maintenance window (config/maintenance) — admin picks a time; new orders/bookings pause, status pages keep working =====
let MAINT = { at: 0, v: null };
async function maintNow() {
  if (Date.now() - MAINT.at > 20000) { MAINT = { at: Date.now(), v: (await db.doc("config/maintenance").get()).data() || null }; }
  const m = MAINT.v; const now = Date.now();
  return m && m.start <= now && now < m.end ? m : null;
}
/** throw if a maintenance window is on (TapTayo admin bypasses) */
async function maintGuard(req) {
  const t = req.auth?.token || {};
  if (t.admin === true || isAdminEmail(t.email)) return;
  const m = await maintNow();
  if (m) { const at = new Date(m.end).toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit" }); throw new HttpsError("unavailable", `🛠 We're updating TapTayo — we'll be right back at ${at}. Ordering and booking are paused until then.`); }
}
exports.adminMaintenance = onCall(async (req) => {
  const { token } = requireAdmin(req);
  const d = req.data || {}; const ref = db.doc("config/maintenance"); const now = Date.now();
  const cur = (await ref.get()).data() || null;
  let next = null;
  if (d.action === "end" || d.action === "cancel") next = cur ? { ...cur, end: Math.min(cur.end, now), endedEarly: now, start: Math.min(cur.start, now) } : null;
  else {
    const start = d.action === "now" ? now : Number(d.start);
    const mins = Math.max(10, Math.min(360, Number(d.minutes) || 60));
    if (!start || start < now - 60000) throw new HttpsError("invalid-argument", "Pick a start time in the future.");
    if (start > now + 30 * 86400000) throw new HttpsError("invalid-argument", "Pick a time within 30 days.");
    next = { start, end: start + mins * 60000, minutes: mins, message: String(d.message || "").trim().slice(0, 200), setBy: token.email || "admin", updatedAt: now };
  }
  if (next) await ref.set(next); MAINT = { at: 0, v: null };
  return { ok: true, maintenance: next };
});
exports.adminConfig = onCall(async (req) => {
  requireAdmin(req);
  const d = req.data || {};
  if (d.payment) {
    const P = d.payment; await db.doc("config/payment").set({ gcashNumber: String(P.gcashNumber || "").slice(0, 30), gcashName: String(P.gcashName || "").slice(0, 60), bankNote: String(P.bankNote || "").slice(0, 120), contact: String(P.contact || "").slice(0, 120), qrUrl: String(P.qrUrl || "").slice(0, 500) || null, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }
  if (d.alerts) {
    const A = d.alerts; const patch = { chatId: String(A.chatId || "").slice(0, 40) || null };
    if (A.botToken) { const me = await tgCall(String(A.botToken).trim(), "getMe", {}); patch.botToken = String(A.botToken).trim(); patch.botName = me.username || ""; }
    await db.doc("config/adminAlerts").set(patch, { merge: true });
    if (d.alerts.test) await notifyAdmin("✅ TapTayo admin alerts are working.");
  }
  if (d.sms) {
    const S = d.sms; const patch = { senderName: String(S.senderName || "").trim().slice(0, 11) || null, required: S.required !== false };
    if (S.apiKey) { const key = String(S.apiKey).trim(); const acct = await semGet("account", key); if (!acct || acct.status === "error" || acct.message) throw new HttpsError("invalid-argument", "Semaphore didn't accept that API key."); patch.apiKey = key; patch.account = acct.account_name || ""; patch.balance = acct.credit_balance ?? null; }
    await db.doc("config/platformSms").set(patch, { merge: true });
  }
  const [p, a, sm] = await Promise.all([db.doc("config/payment").get(), db.doc("config/adminAlerts").get(), db.doc("config/platformSms").get()]);
  let balance = null; if (sm.data()?.apiKey) { const acct = await semGet("account", sm.data().apiKey).catch(() => null); balance = acct?.credit_balance ?? null; }
  return { payment: p.data() || {}, alerts: { chatId: a.data()?.chatId || "", botName: a.data()?.botName || "", hasToken: !!a.data()?.botToken },
    sms: { hasKey: !!sm.data()?.apiKey, senderName: sm.data()?.senderName || "", required: sm.data()?.required !== false, account: sm.data()?.account || "", balance } };
});

// ---- DEMO STORES (TapTayo Café / Salon / Laundry / Airbnb) ----
let _demo = null;
const demoKit = () => (_demo ||= require("./demo.js")({ db, FieldValue, Timestamp, dayKey, rebuildPublicStore, MODE_DEFAULTS, PRESETS }));
/** read-only owner demo dashboard: a short-lived login to one demo store as a "viewer" (reads only — rules block writes) */
exports.demoViewer = onCallRaw(async (req) => {
  const slug = String(req.data?.slug || "");
  if (!demoKit().DEMOS.some((D) => D.slug === slug)) throw new HttpsError("not-found", "Demo not found.");
  const pub = (await db.doc(`publicStores/${slug}`).get()).data();
  if (!pub?.storeId || !pub.demo) throw new HttpsError("failed-precondition", "This demo isn't ready yet. Please try again later.");
  return { token: await admin.auth().createCustomToken(`demo-viewer-${slug}`, { storeId: pub.storeId, role: "viewer", demo: true }) };
});
exports.adminSeedDemos = onCall({ timeoutSeconds: 300, memory: "512MiB" }, async (req) => {
  requireAdmin(req);
  const { DEMOS, seedOne } = demoKit();
  const only = req.data?.slug ? [String(req.data.slug)] : null;
  const out = [];
  for (const D of DEMOS) if (!only || only.includes(D.slug)) { try { out.push(await seedOne(D, req.auth.uid)); } catch (e) { out.push({ slug: D.slug, error: e.message }); } }
  return { demos: out };
});
// every 3 hours: clear pretend orders; once a day (4 AM): refresh the sample data so dates stay current
exports.demoTick = onSchedule({ schedule: "0 1,4,7,10,13,16,19,22 * * *", timeZone: "Asia/Manila", timeoutSeconds: 300, memory: "512MiB" }, async () => {
  const { DEMOS, seedOne, cleanDemos } = demoKit();
  const hourPH = new Date(Date.now() + 8 * 3600e3).getUTCHours();
  if (hourPH === 4) {
    for (const D of DEMOS) { const pub = (await db.doc(`publicStores/${D.slug}`).get()).data(); if (!pub?.storeId) continue; const st = (await db.doc(`stores/${pub.storeId}`).get()).data(); if (st?.settings?.demo) await seedOne(D, st.ownerUid).catch((e) => logger.warn("demo reseed", D.slug, e.message)); }
  } else logger.info("demo cleanup", { removed: await cleanDemos(3) });
});

// demo stores: a visitor's pretend order moves on by itself so they see the live status page work
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function demoStore(storeId) { const st = (await db.doc(`stores/${storeId}`).get()).data(); return st?.settings?.demo ? st : null; }
exports.demoAdvanceOrder = onDocumentCreated({ document: "stores/{storeId}/orders/{orderId}", timeoutSeconds: 120, maxInstances: 3 }, async (ev) => {
  const o = ev.data?.data(); if (!o?.test || o.sample) return;
  if (!(await demoStore(ev.params.storeId))) return;
  const ref = ev.data.ref;
  const steps = o.type === "laundry" ? [["received", 12], ["washing", 25], ["drying", 25], ["folding", 20], ["ready", 0]]
    : [["preparing", 15], ["ready", 30]];
  await sleep(10000);
  for (const [status, wait] of steps) {
    const cur = (await ref.get()).data(); if (!cur || ["cancelled", "completed", "claimed"].includes(cur.status)) return;
    const patch = { status, updatedAt: FieldValue.serverTimestamp(), ...(status === "ready" ? { readyAt: FieldValue.serverTimestamp() } : {}) };
    if (o.type !== "laundry") patch.stations = Object.fromEntries(Object.keys(cur.stations || {}).map((k) => [k, status === "ready" ? "ready" : "pending"]));
    await ref.update(patch);
    if (wait) await sleep(wait * 1000);
  }
});
exports.demoAdvanceBooking = onDocumentCreated({ document: "stores/{storeId}/appointments/{id}", timeoutSeconds: 60, maxInstances: 3 }, async (ev) => {
  const a = ev.data?.data(); if (!a?.test || a.sample || !["pending", "unconfirmed"].includes(a.status)) return;
  if (!(await demoStore(ev.params.storeId))) return;
  await sleep(12000); const cur = (await ev.data.ref.get()).data(); if (cur && ["pending", "unconfirmed"].includes(cur.status)) await ev.data.ref.update({ status: "confirmed", confirmDeadline: null, updatedAt: FieldValue.serverTimestamp() });
});
exports.demoAdvanceStay = onDocumentCreated({ document: "stores/{storeId}/stays/{id}", timeoutSeconds: 60, maxInstances: 3 }, async (ev) => {
  const a = ev.data?.data(); if (!a?.test || a.sample || !["pending", "unconfirmed"].includes(a.status)) return;
  if (!(await demoStore(ev.params.storeId))) return;
  await sleep(12000); const cur = (await ev.data.ref.get()).data(); if (cur && ["pending", "unconfirmed"].includes(cur.status)) await ev.data.ref.update({ status: "confirmed", "payment.status": "verified", confirmDeadline: null, updatedAt: FieldValue.serverTimestamp() });
});

exports.adminListStores = onCall(async (req) => {
  requireAdmin(req);
  const [stores, subs, users, payments] = await Promise.all([
    db.collection("stores").get(),
    db.collectionGroup("subscription").get(),
    db.collection("users").where("role", "==", "owner").get(),
    db.collectionGroup("payments").where("status", "==", "pending").get(),
  ]);
  const subBy = {}; subs.forEach((d) => (subBy[d.ref.parent.parent.id] = d.data()));
  const ownerBy = {}; users.forEach((d) => (ownerBy[d.data().storeId] = d.data()));
  const payBy = {}; payments.forEach((d) => { const sid = d.ref.parent.parent.id; (payBy[sid] = payBy[sid] || []).push({ id: d.id, ...d.data() }); });
  const ts = (t) => (t?.toMillis ? t.toMillis() : null);
  const orgs = await db.collection("orgs").get(); const orgBy = {}; orgs.forEach((o) => (orgBy[o.id] = o.data()));
  return stores.docs.map((d) => {
    const s = d.data(), sub = subBy[d.id] || {};
    return {
      id: d.id, name: s.name, slug: s.slug, businessType: s.businessType, mode: s.mode, archived: !!s.archived, demo: !!s.settings?.demo,
      org: s.orgId ? { id: s.orgId, name: orgBy[s.orgId]?.name || "", isMain: orgBy[s.orgId]?.mainStoreId === d.id, mainStoreId: orgBy[s.orgId]?.mainStoreId || null, branches: (orgBy[s.orgId]?.branches || []).filter((x) => !x.archived).length } : null,
      createdAt: ts(s.createdAt), ownerEmail: ownerBy[d.id]?.email || orgBy[s.orgId]?.ownerEmail || null, phone: s.contact?.phone || "",
      sub: { plan: sub.plan, status: sub.status, trialEndsAt: ts(sub.trialEndsAt), paidUntil: ts(sub.paidUntil), limits: sub.limits, addons: sub.addons || {}, comp: !!sub.comp, compNote: sub.compNote || "", mirrored: !!sub.mirroredFrom },
      pendingPayments: (payBy[d.id] || []).map((p) => ({ ...p, createdAt: ts(p.createdAt) })),
    };
  });
});

// adminUpdateSubscription — activate / extend trial / lock / unlock
/** add-ons from the admin page / a payment: { key: qty } (or an old-style array of keys) */
function normAddons(v) {
  const out = {};
  if (Array.isArray(v)) { for (const k of v) if (ADDONS[k]) out[k] = 1; return out; }
  for (const [k, q] of Object.entries(v || {})) if (ADDONS[k]) { const n = q === true ? 1 : Math.max(0, Math.min(10, Math.round(Number(q) || 0))); if (n) out[k] = ADDONS[k].qty ? n : 1; }
  return out;
}
exports.adminUpdateSubscription = onCall(async (req) => {
  const { token } = requireAdmin(req);
  const d = req.data || {};
  let storeId = String(d.storeId || "");
  const action = String(d.action || "");
  if (!storeId) throw new HttpsError("invalid-argument", "Missing storeId.");
  const ref = db.doc(`stores/${storeId}/subscription/current`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "No subscription doc.");
  const sub = snap.data();
  const now = Date.now();
  const patch = { updatedAt: FieldValue.serverTimestamp() };

  if (action === "activate") {
    // owner referral: the first paid month of a referred business gives the referrer 1 free month
    const st = (await db.doc(`stores/${storeId}`).get()).data() || {};
    const refStoreId = st.referredBy ? (await db.doc(`publicStores/${st.referredBy}`).get()).data()?.storeId : null;
    if (refStoreId && refStoreId !== storeId && !st.referralRewarded) {
      const rRef = db.doc(`stores/${refStoreId}/subscription/current`); const rs = (await rRef.get()).data();
      if (rs) { await rRef.update({ paidUntil: Timestamp.fromMillis(Math.max(now, rs.paidUntil?.toMillis?.() || 0) + MONTH_DAYS * 86400000), referralMonths: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }); await db.doc(`stores/${storeId}`).update({ referralRewarded: now }); notifyTelegram(refStoreId, "daily", `🎉 ${st.name || "A business you invited"} just subscribed — you got 1 free month of TapTayo!`, { force: true }).catch(() => {}); }
    }
    const plan = PLANS[d.plan];
    if (!plan || d.plan === "trial") throw new HttpsError("invalid-argument", "Invalid plan.");
    const months = Math.max(1, Math.min(12, parseInt(d.months, 10) || 1));
    const base = Math.max(now, sub.paidUntil?.toMillis?.() || 0);
    const paidUntil = Timestamp.fromMillis(base + months * MONTH_DAYS * 86400000);
    const addons = normAddons(d.addons);
    const addonTotal = Object.entries(addons).reduce((a, [k, q]) => a + (ADDONS[k]?.price || 0) * (q === true ? 1 : q), 0);
    if (addons.protect && !sub.protectSince) patch.protectSince = now;
    Object.assign(patch, { plan: d.plan, status: "active", paidUntil, paymentMethod: "manual", addons, lockedPrice: plan.price, comp: false, compNote: "", provisional: FieldValue.delete(), activatedAt: FieldValue.serverTimestamp() });
    const pend = await db.collection(`stores/${storeId}/payments`).where("status", "==", "pending").get();
    if (pend.empty) {
      // no claim from the owner (e.g. direct Activate) → create a record
      await db.collection(`stores/${storeId}/payments`).add({
        plan: d.plan, months, addons, amount: Number(d.amount) || (plan.price + addonTotal) * months, refNo: String(d.refNo || "").slice(0, 60),
        status: "confirmed", confirmedBy: token.email || null, createdAt: FieldValue.serverTimestamp(), confirmedAt: FieldValue.serverTimestamp(),
      });
    } else {
      // confirm the pending claim itself (no duplicates)
      for (const p of pend.docs) {
        await p.ref.update({
          status: "confirmed", plan: d.plan, months, addons, amount: Number(d.amount) || p.data().amount,
          confirmedAt: FieldValue.serverTimestamp(), confirmedBy: token.email || null,
        });
      }
    }
  } else if (action === "comp") {
    // 🎁 free / complimentary access — custom days, add-ons, note
    const plan = PLANS[d.plan] && d.plan !== "trial" ? d.plan : "business";
    const days = Math.max(1, Math.min(3650, parseInt(d.days, 10) || 30));
    const base = Math.max(now, sub.paidUntil?.toMillis?.() || 0);
    const addons = normAddons(d.addons);
    Object.assign(patch, { plan, status: "active", paidUntil: Timestamp.fromMillis(base + days * 86400000), paymentMethod: "comp", comp: true, compNote: String(d.note || "").slice(0, 120), addons, provisional: FieldValue.delete(), activatedAt: FieldValue.serverTimestamp() });
    await db.collection(`stores/${storeId}/payments`).add({ plan, months: 0, days, addons, amount: 0, refNo: "", note: String(d.note || "").slice(0, 120), status: "comp", confirmedBy: token.email || null, createdAt: FieldValue.serverTimestamp(), confirmedAt: FieldValue.serverTimestamp() });
  } else if (action === "extendTrial") {
    const days = Math.max(1, Math.min(90, parseInt(d.days, 10) || 7));
    const base = Math.max(now, sub.trialEndsAt?.toMillis?.() || 0);
    Object.assign(patch, { status: "trial", plan: "trial", trialEndsAt: Timestamp.fromMillis(base + days * 86400000) });
  } else if (action === "lock") {
    Object.assign(patch, { status: "locked", lockedAt: FieldValue.serverTimestamp() });
  } else if (action === "unlock") {
    const until = (sub.plan === "trial" ? sub.trialEndsAt : sub.paidUntil)?.toMillis?.() || 0;
    Object.assign(patch, { status: until > now ? (sub.plan === "trial" ? "trial" : "active") : "past_due" });
  } else if (action === "rejectPayment") {
    const pid = String(d.paymentId || "");
    await db.doc(`stores/${storeId}/payments/${pid}`).update({ status: "rejected", note: String(d.note || "").slice(0, 200), updatedAt: FieldValue.serverTimestamp() });
    // not paid → the plan that was turned on while checking goes away right now
    // a rejected (unpaid) claim → no more "active while checking" for this shop; next claims wait for the admin
    await ref.update({ ...(sub.provisional?.paymentId === pid ? { provisional: FieldValue.delete() } : {}), noProvisional: true, updatedAt: FieldValue.serverTimestamp() });
    if (sub.provisional?.paymentId === pid) rebuildPublicStore(storeId).catch(() => {});
    return { ok: true };
  } else throw new HttpsError("invalid-argument", "Unknown action.");

  await ref.update(patch);
  rebuildPublicStore(storeId).catch(() => {});
  logger.info("admin subscription", { storeId, action, by: token.email });
  return { ok: true };
});

// submitPayment — owner: "I've paid" (GCash ref). Shows up in the admin panel as pending.
exports.submitPayment = onCall(async (req) => {
  const { uid, token } = requireAuth(req);
  if (!token.storeId || token.role !== "owner") throw new HttpsError("permission-denied", "Owner only.");
  const d = req.data || {};
  const payType = (await db.doc(`stores/${token.storeId}`).get()).data()?.businessType || "";
  const planKey = d.plan === "none" ? "none" : sellableFor({ businessType: payType }).includes(d.plan) ? d.plan : null;
  if (!planKey) throw new HttpsError("invalid-argument", "Choose a plan.");
  const months = [1, 3, 6, 12].includes(Number(d.months)) ? Number(d.months) : 1;
  const refNo = String(d.refNo || "").trim().slice(0, 60);
  const proofUrl = typeof d.proofUrl === "string" && /^priv:stores\/[^/]+\/private\//.test(d.proofUrl) ? d.proofUrl.slice(0, 300) : null;
  if (refNo.length < 4 && !proofUrl) throw new HttpsError("invalid-argument", "Add the reference number or a screenshot of your payment.");
  const tier = planKey === "none" ? 0 : PLANS[planKey].tier;
  const addons = {};
  for (const [k, a] of Object.entries(ADDONS)) {
    if (a.legacy) continue; const q = Math.max(0, Math.min(10, Math.round(Number(d.addons?.[k]) || 0)));
    if (!q) continue; if ((a.minTier || 0) > tier) throw new HttpsError("invalid-argument", `${a.name} needs a higher plan.`);
    addons[k] = a.qty ? q : 1;
  }
  const monthly = (planKey === "none" ? 0 : PLANS[planKey].price) + Object.entries(addons).reduce((x, [k, q]) => x + ADDONS[k].price * q, 0);
  if (!monthly) throw new HttpsError("invalid-argument", "Choose a plan or an add-on.");
  const amount = monthly * (months === 12 ? 10 : months); // 12 months = pay 10
  let payStore = token.storeId;
  if (token.orgId) { const org = (await db.doc(`orgs/${token.orgId}`).get()).data(); if (org?.mainStoreId) payStore = org.mainStoreId; }
  const subRef = db.doc(`stores/${payStore}/subscription/current`); const sub = (await subRef.get()).data() || {};
  // "active while we check": the plan turns on for up to 3 days — once every 30 days (anti-abuse)
  const canProvisional = !sub.noProvisional && !(sub.lastProvisionalAt && sub.lastProvisionalAt.toMillis() > Date.now() - 30 * 86400000);
  const ref = await db.collection(`stores/${payStore}/payments`).add({
    plan: planKey, months, addons, amount, refNo, proofUrl, method: String(d.method || "gcash").slice(0, 20),
    status: "pending", provisional: canProvisional, submittedBy: token.email || null, submittedUid: uid, createdAt: FieldValue.serverTimestamp(),
  });
  if (canProvisional) {
    await subRef.set({ provisional: { plan: planKey === "none" ? (planOf(sub) === "trial" ? "free" : planOf(sub)) : planKey, addons, until: Timestamp.fromMillis(Date.now() + 3 * 86400000), paymentId: ref.id }, lastProvisionalAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    rebuildPublicStore(payStore).catch(() => {});
  }
  notifyAdmin(`💰 Payment to check: ${token.email || ""} · ${planKey === "none" ? "add-ons" : PLANS[planKey].name} × ${months} mo = ₱${amount}${refNo ? ` · ref ${refNo}` : ""}${proofUrl ? " · screenshot" : ""}`).catch(() => {});
  return { id: ref.id, amount, provisional: canProvisional };
});


// ===========================================================================
// FEEDBACK & INCIDENTS
// ===========================================================================
async function loadOwnOrder(storeId, orderId, uid, kind = "order") {
  const snap = await db.doc(`stores/${storeId}/${kind === "appt" ? "appointments" : kind === "stay" ? "stays" : "orders"}/${orderId}`).get();
  if (!snap.exists || snap.data().customerUid !== uid) throw new HttpsError("permission-denied", "This is not your order.");
  const o = { id: snap.id, ...snap.data() };
  if (kind === "stay") { o.type = "stay"; o.orderNo = o.code; o.serviceType = "stay"; o.status = ["checked_out", "done"].includes(o.status) ? "completed" : o.status; o.items = [{ name: o.roomName }]; }
  if (kind === "appt") { o.type = "appointment"; o.orderNo = o.code; o.serviceType = o.homeService ? "home_service" : "salon"; o.status = o.status === "done" ? "completed" : o.status; }
  return o;
}

exports.submitFeedback = onCall(async (req) => {
  const { uid } = requireAuth(req);
  const d = req.data || {};
  const storeId = String(d.storeId || ""), orderId = String(d.orderId || "");
  const stars = (x) => (x == null || x === "" ? null : Math.max(1, Math.min(5, parseInt(x, 10) || 0)) || null);
  // category stars per business (laundry: cleanliness, fragrance… · stay: cleanliness, accommodation…)
  const CATKEYS = { order: ["food", "service", "speed"], laundry: ["cleanliness", "fragrance", "folding", "ontime"], appt: ["service", "staff", "cleanliness", "value"], stay: ["cleanliness", "accommodation", "service", "location", "value"] };
  const ck = CATKEYS[d.kind === "appt" ? "appt" : d.kind === "stay" ? "stay" : d.kind === "laundry" ? "laundry" : "order"];
  const cats = d.cats && typeof d.cats === "object" ? Object.fromEntries(ck.map((k) => [k, stars(d.cats[k])]).filter(([, v]) => v)) : null;
  const cv = cats ? Object.values(cats) : [];
  const foodRating = stars(d.foodRating) || cats?.food || null, serviceRating = stars(d.serviceRating) || cats?.service || null;
  // overall = average of the categories (or food & service)
  const rating = cv.length ? Math.round(cv.reduce((a, b) => a + b, 0) / cv.length) : foodRating && serviceRating ? Math.round((foodRating + serviceRating) / 2) : stars(d.rating) || foodRating || serviceRating;
  if (!storeId || !orderId || !rating) throw new HttpsError("invalid-argument", "Missing data.");
  const storeSnap = await db.doc(`stores/${storeId}`).get();
  if (!storeSnap.exists || storeSnap.data().settings?.feedback?.enabled === false || !(await storeEntitled(storeId, "feedback"))) throw new HttpsError("failed-precondition", "Feedback is not available.");
  const o = await loadOwnOrder(storeId, orderId, uid, d.kind === "appt" ? "appt" : d.kind === "stay" ? "stay" : "order");
  if (!["completed", "delivered", "picked_up", "claimed", "done", "checked_out"].includes(o.status)) throw new HttpsError("failed-precondition", "You can only rate an order once it is completed.");
  const ref = db.doc(`stores/${storeId}/feedback/${orderId}`);
  if ((await ref.get()).exists) throw new HttpsError("already-exists", "You have already rated this order.");
  await ref.set({
    orderId, orderNo: o.orderNo, rating, foodRating, serviceRating, cats: cats || null, roomId: o.roomId || null, roomName: o.roomName || null, comment: String(d.comment || "").trim().slice(0, 500), photoUrl: d.photoUrl ? String(d.photoUrl).slice(0, 500) : null,
    serviceType: o.serviceType, tableLabel: o.tableLabel || null, items: (o.items || []).map((l) => l.name), customerName: o.customer?.name || "", customerUid: uid, providerName: o.providerName || null, providerId: o.providerId || null, kind: d.kind === "appt" ? "appt" : d.kind === "stay" ? "stay" : "order",
    hidden: false, createdAt: FieldValue.serverTimestamp(),
  });
  if (rating <= 2) notifyTelegram(storeId, "feedback", `⚠️ Low rating ${"★".repeat(rating)} · #${o.orderNo || o.code || ""}${foodRating ? ` · Food ${foodRating}/5` : ""}${serviceRating ? ` · Service ${serviceRating}/5` : ""}\n${String(d.comment || "").slice(0, 200)}`);
  await db.doc(`stores/${storeId}/${d.kind === "appt" ? "appointments" : d.kind === "stay" ? "stays" : "orders"}/${orderId}`).update({ rating, foodRating, serviceRating, rateCats: cats || null, updatedAt: FieldValue.serverTimestamp() }).catch(() => {});
  await db.doc(`stores/${storeId}`).set({ stats: { ratingCount: FieldValue.increment(1), ratingSum: FieldValue.increment(rating), ...(cats ? { catSum: Object.fromEntries(Object.entries(cats).map(([k, v]) => [k, FieldValue.increment(v)])), catCount: Object.fromEntries(Object.keys(cats).map((k) => [k, FieldValue.increment(1)])) } : {}) } }, { merge: true });
  if (d.kind === "stay" && o.roomId) await db.doc(`stores/${storeId}/rooms/${o.roomId}`).set({ ratingCount: FieldValue.increment(1), ratingSum: FieldValue.increment(rating), ...(cats ? { ratingCats: Object.fromEntries(Object.entries(cats).map(([k, v]) => [k, FieldValue.increment(v)])) } : {}) }, { merge: true });
  if (d.kind === "appt" && o.providerId) await db.doc(`stores/${storeId}/staff/${o.providerId}`).update({ ratingCount: FieldValue.increment(1), ratingSum: FieldValue.increment(serviceRating || rating) }).catch(() => {});
  return { ok: true };
});

// ---------------------------------------------------------------------------
// WAITLIST — customers scan the waitlist QR, enter name + pax, and see their place in line.
// Staff: Table ready (10-min hold) → +5/+10 → Seated / No-show.
// ---------------------------------------------------------------------------
exports.joinWaitlist = onCall(async (req) => {
  const { uid } = requireAuth(req);
  const d = req.data || {};
  const pub = (await db.doc(`publicStores/${String(d.slug || "")}`).get()).data();
  if (!pub) throw new HttpsError("not-found", "Store not found.");
  if (!pub.pro?.waitlist) throw new HttpsError("failed-precondition", "The waitlist is not available.");
  const t = (pub.tables || []).find((x) => x.qrToken === String(d.tableToken || "") && x.isWaitlist);
  if (!t) throw new HttpsError("invalid-argument", "Please scan the waitlist QR at the entrance.");
  const name = String(d.name || "").trim().slice(0, 40), pax = parseInt(d.pax, 10), phone = String(d.phone || "").trim().slice(0, 20);
  if (name.length < 2) throw new HttpsError("invalid-argument", "Enter your name.");
  if (!(pax >= 1 && pax <= 60)) throw new HttpsError("invalid-argument", "How many persons? (1–60)");
  const mine = (await db.collection(`stores/${pub.storeId}/waitlist`).where("customerUid", "==", uid).get()).docs.find((x) => ["waiting", "called"].includes(x.data().status));
  if (mine) return { id: mine.id, storeId: pub.storeId, existing: true };
  const ref = await db.collection(`stores/${pub.storeId}/waitlist`).add({ ...(pub.testMode && pub.testMode.until > Date.now() ? { test: true } : {}), name, pax, phone, status: "waiting", customerUid: uid, createdAt: FieldValue.serverTimestamp(), createdMs: Date.now(), dayKey: dayKey() });
  notifyTelegram(pub.storeId, "callStaff", `🪑 Waitlist: ${name} · ${pax} pax`);
  return { id: ref.id, storeId: pub.storeId };
});
exports.onWaitlistWrite = onDocumentWritten("stores/{storeId}/waitlist/{id}", async (event) => {
  const a = event.data?.after?.data(), b = event.data?.before?.data();
  if (a && b && a.status === b.status) return; // only when someone joins / leaves the line
  const snap = await db.collection(`stores/${event.params.storeId}/waitlist`).where("status", "==", "waiting").get();
  const list = snap.docs.sort((x, y) => (x.data().createdMs || 0) - (y.data().createdMs || 0));
  const avg = Number(((await db.doc(`stores/${event.params.storeId}`).get()).data()?.settings?.waitlist?.avgMin) || 10);
  const batch = db.batch(); let n = 0;
  list.forEach((d, i) => { if (d.data().position !== i + 1) { batch.update(d.ref, { position: i + 1, estMin: (i + 1) * avg }); n++; } });
  if (n) await batch.commit();
});

// ---------------------------------------------------------------------------
// BOOKINGS self-service (customer): find by ref, reschedule request, extend hours, VIP free-hour vouchers, VIP slots
// ---------------------------------------------------------------------------
const RESCHED_DAYS = (r) => (r.kind === "event" ? 3 : 1); // event packages need 3 days' notice; table / VIP 1 day
async function pubBySlug(slug) { const p = (await db.doc(`publicStores/${String(slug || "")}`).get()).data(); if (!p) throw new HttpsError("not-found", "Store not found."); return p; }
/** "I already have a booking" — ref code + last digits of the phone links the booking to this phone */
exports.findReservation = onCall(async (req) => {
  const { uid } = requireAuth(req);
  const d = req.data || {};
  const pub = await pubBySlug(d.slug);
  const code = String(d.code || "").trim().toUpperCase();
  const snap = await db.collection(`stores/${pub.storeId}/reservations`).where("code", "==", code).limit(1).get();
  if (snap.empty) throw new HttpsError("not-found", "No booking with that reference number.");
  const r = snap.docs[0].data();
  const last = (x) => String(x || "").replace(/\D/g, "").slice(-7);
  if (!d.phone || last(d.phone).length < 7 || last(d.phone) !== last(r.phone)) throw new HttpsError("permission-denied", "The mobile number doesn't match this booking.");
  if (r.customerUid !== uid) await snap.docs[0].ref.update({ extraUids: FieldValue.arrayUnion(uid) });
  return { id: snap.docs[0].id, storeId: pub.storeId, code: r.code, kind: r.kind };
});
const ownsResv = (r, uid) => !!r && (r.customerUid === uid || (r.extraUids || []).includes(uid));
async function ownResv(storeId, id, uid) {
  const ref = db.doc(`stores/${storeId}/reservations/${String(id || "")}`); const s = await ref.get();
  if (!s.exists) throw new HttpsError("not-found", "Booking not found.");
  const r = s.data();
  if (!ownsResv(r, uid)) throw new HttpsError("permission-denied", "This is not your booking.");
  return { ref, r };
}
/** Customer asks to move the booking (1 day notice; 3 days for event packages). Staff approve or decline. */
exports.requestReschedule = onCall(async (req) => {
  const { uid } = requireAuth(req);
  const d = req.data || {};
  const { ref, r } = await ownResv(String(d.storeId || ""), d.resvId, uid);
  if (!["unconfirmed", "pending", "confirmed"].includes(r.status)) throw new HttpsError("failed-precondition", "This booking can no longer be moved.");
  const days = RESCHED_DAYS(r);
  const at = r.scheduledAt?.toMillis?.() || 0;
  if (at - Date.now() < days * 86400e3) throw new HttpsError("failed-precondition", `Reschedule requests need at least ${days} day${days > 1 ? "s" : ""} before the booking. Please call the store.`);
  const date = String(d.date || ""), time = String(d.time || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) throw new HttpsError("invalid-argument", "Choose the new date and time.");
  const when = new Date(`${date}T${time}:00+08:00`).getTime();
  if (when < Date.now() + 86400e3 - 3600e3) throw new HttpsError("invalid-argument", "The new date must be tomorrow or later.");
  const pub = (await db.doc(`stores/${String(d.storeId)}`).get()).data();
  if (pub?.hours && Object.keys(pub.hours).length && !isOpenAt(pub.hours, new Date(when))) throw new HttpsError("failed-precondition", "We're closed at that time.");
  const rfee = r.status === "unconfirmed" ? 0 : reschedFee(bookingPolicy(pub), at, r.reschedCount || 0, r.estimate || r.total || r.deposit?.amount || 0, d.acceptFee);
  await ref.update({ reschedule: { date, time, at: when, fee: rfee, note: String(d.note || "").trim().slice(0, 160), status: "requested", requestedAt: Date.now() }, reschedCount: (r.reschedCount || 0) + 1, ...(rfee ? { reschedFees: round2((r.reschedFees || 0) + rfee) } : {}), updatedAt: FieldValue.serverTimestamp() });
  notifyTelegram(String(d.storeId), "reservation", `📅 Reschedule request · ${r.code} → ${date} ${time}${d.note ? ` (${String(d.note).slice(0, 80)})` : ""}`);
  return { ok: true };
});
/** Staff: approve / decline a reschedule, record the downpayment received, and get the booking bill */
exports.resvStaff = onCall(async (req) => {
  const who = await staffFrom(req);
  const { storeId } = who; const d = req.data || {};
  if (!hasRole(who, "crew")) throw new HttpsError("permission-denied", "Only counter crew or a manager can do this.");
  const ref = db.doc(`stores/${storeId}/reservations/${String(d.resvId || "")}`); const r = (await ref.get()).data();
  if (!r) throw new HttpsError("not-found", "Booking not found.");
  if (d.action === "resched") {
    if (!r.reschedule || r.reschedule.status !== "requested") throw new HttpsError("failed-precondition", "No reschedule request.");
    if (d.approve) {
      const at = Timestamp.fromMillis(r.reschedule.at);
      await ref.update({ scheduledAt: at, date: r.reschedule.date, time: r.reschedule.time, "reschedule.status": "approved", "reschedule.by": who.name, rescheduledFrom: r.scheduledAt || null, updatedAt: FieldValue.serverTimestamp() });
      if (r.preorder?.orderId) await db.doc(`stores/${storeId}/orders/${r.preorder.orderId}`).update({ scheduledAt: at, updatedAt: FieldValue.serverTimestamp() }).catch(() => {});
    } else await ref.update({ "reschedule.status": "declined", "reschedule.by": who.name, updatedAt: FieldValue.serverTimestamp() });
    await audit(storeId, who, d.approve ? "resched_ok" : "resched_no", { code: r.code });
    return { ok: true };
  }
  if (d.action === "dp") {
    const amount = Math.max(0, Math.min(200000, Number(d.amount) || 0));
    const method = String(d.method || "Cash").slice(0, 30);
    await ref.update({ dpPaid: amount, dpMethod: method, dpBy: who.name, dpAt: Date.now(), updatedAt: FieldValue.serverTimestamp() });
    await audit(storeId, who, "dp", { code: r.code, total: amount, method });
    return { ok: true };
  }
  throw new HttpsError("invalid-argument", "Unknown action.");
});
/** During a VIP booking: the customer adds hours (if the room is free after, with the 30-min cleaning gap, and before closing) */
exports.extendReservation = onCall(async (req) => {
  const { uid } = requireAuth(req);
  const d = req.data || {};
  const storeId = String(d.storeId || "");
  const { ref, r } = await ownResv(storeId, d.resvId, uid);
  if (r.kind !== "vip") throw new HttpsError("failed-precondition", "Only VIP room bookings can be extended.");
  const hrs = Math.max(1, Math.min(3, parseInt(d.hours, 10) || 1));
  const start = r.scheduledAt?.toMillis?.() || 0, curH = Number(r.hours || r.duration || 2) + (Number(r.extraHours) || 0);
  const end = start + curH * 3600e3, newEnd = end + hrs * 3600e3;
  if (Date.now() < start - 3600e3 || Date.now() > end + 30 * 60000) throw new HttpsError("failed-precondition", "You can extend only during your booking.");
  const store = (await db.doc(`stores/${storeId}`).get()).data() || {};
  const room = (store.settings?.vip?.rooms || []).find((x) => x.id === r.roomId) || {};
  const hours = store.hours || {};
  if (Object.keys(hours).length && !isOpenAt(hours, new Date(newEnd - 60000))) throw new HttpsError("failed-precondition", "That would go past closing time.");
  const next = (await db.collection(`stores/${storeId}/reservations`).where("roomId", "==", r.roomId).get()).docs.map((x) => ({ id: x.id, ...x.data() }))
    .filter((x) => x.id !== ref.id && ["pending", "confirmed", "seated"].includes(x.status) && (x.scheduledAt?.toMillis?.() || 0) >= start);
  if (next.some((x) => x.scheduledAt.toMillis() < newEnd + vipClean(store) * 60000)) throw new HttpsError("failed-precondition", "The room is booked right after you. Please ask the staff.");
  const rate = room.pricing === "consumable" ? Number(store.settings?.vip?.packageOvertime || room.ratePerHour || 0) : Number(room.ratePerHour || 0);
  const fee = round2(rate * hrs);
  await ref.update({ extraHours: FieldValue.increment(hrs), extensionFee: FieldValue.increment(fee), updatedAt: FieldValue.serverTimestamp() });
  const ses = (await db.collection(`stores/${storeId}/sessions`).where("reservationId", "==", ref.id).where("status", "==", "open").limit(1).get()).docs[0];
  if (ses) await ses.ref.update({ bookedHours: FieldValue.increment(hrs), extensionFee: FieldValue.increment(fee), updatedAt: FieldValue.serverTimestamp() });
  notifyTelegram(storeId, "reservation", `⏱ ${r.code} · ${room.name || "VIP"} extended +${hrs} h (₱${fee})`);
  return { ok: true, fee, hours: curH + hrs };
});
/** VIP room in use right now (checked in: walk-in session or a seated booking)? → ms when it should be free, else 0.
 *  Past the booked end (overtime, guests still inside) → busy until 30 min from now, refreshed on every check. */
async function vipBusyUntil(storeId, room) {
  const now = Date.now(); let until = 0;
  const openS = await db.collection(`stores/${storeId}/sessions`).where("roomId", "==", room.id).where("status", "==", "open").limit(3).get();
  for (const x of openS.docs) { const ses = x.data(); const end = (ses.startedAt?.toMillis?.() || now) + (Math.max(ses.bookedHours || 0, room.minHours || 1) + (Number(ses.extraHours) || 0)) * 3600e3; until = Math.max(until, end, now + 30 * 60000); }
  const seated = await db.collection(`stores/${storeId}/reservations`).where("roomId", "==", room.id).where("status", "==", "seated").limit(3).get();
  for (const x of seated.docs) { const r = x.data(); const end = (r.scheduledAt?.toMillis?.() || now) + ((Number(r.hours) || 1) + (Number(r.extraHours) || 0)) * 3600e3; until = Math.max(until, end, now + 30 * 60000); }
  return until;
}
const VIP_CLEAN_MIN = 30;
const vipClean = (store) => Math.max(0, Math.min(180, Number(store?.settings?.vip?.cleanMin ?? VIP_CLEAN_MIN)));
/** Free start times for a VIP room on a date (30-min steps), with the owner-set cleaning gap between bookings (default 30 min) */
exports.getVipSlots = onCall(async (req) => {
  requireAuth(req);
  const d = req.data || {};
  const pub = await pubBySlug(d.slug);
  const store = (await db.doc(`stores/${pub.storeId}`).get()).data() || {};
  const room = (store.settings?.vip?.rooms || []).find((x) => x.id === String(d.roomId || ""));
  if (!room) throw new HttpsError("not-found", "Room not found.");
  const date = String(d.date || ""); if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpsError("invalid-argument", "Pick a date.");
  const hrs = Math.max(Number(room.minHours) || 1, Math.min(12, Number(d.hours) || Number(room.minHours) || 2));
  const day0 = new Date(`${date}T00:00:00+08:00`).getTime();
  const busy = (await db.collection(`stores/${pub.storeId}/reservations`).where("roomId", "==", room.id).get()).docs.map((x) => x.data())
    .filter((x) => ["pending", "confirmed", "seated", "unconfirmed"].includes(x.status) && x.scheduledAt?.toMillis)
    .map((x) => { const s = x.scheduledAt.toMillis(), h = Number(x.hours || x.duration || 2) + (Number(x.extraHours) || 0); return [s - vipClean(store) * 60000, s + h * 3600e3 + vipClean(store) * 60000]; });
  const inUse = await vipBusyUntil(pub.storeId, room);
  if (inUse) busy.push([Date.now() - 3600e3, inUse + vipClean(store) * 60000]);
  const lead = (Number(store.settings?.vip?.leadTimeHours) || 0) * 3600e3;
  const out = [];
  for (let t = day0 + 6 * 3600e3; t < day0 + 30 * 3600e3; t += 30 * 60000) {
    const e = t + hrs * 3600e3;
    if (t < Date.now() + lead) continue;
    if (store.hours && Object.keys(store.hours).length && (!isOpenAt(store.hours, new Date(t)) || !isOpenAt(store.hours, new Date(e - 60000)))) continue;
    const clash = busy.some(([a, b]) => t < b && e > a);
    out.push({ t, ok: !clash });
  }
  return { slots: out, hours: hrs, inUseUntil: inUse || null, freeFrom: inUse ? inUse + vipClean(store) * 60000 : null };
});
/** VIP free-hours voucher (code VIP + 5) — given by staff, or automatically per qualifying order */
async function makeVipVoucher(storeId, hours, label, extra = {}) {
  const code = "VIP" + Math.random().toString(36).slice(2, 7).toUpperCase();
  const validTo = new Date(Date.now() + 30 * 86400e3 + 8 * 3600e3).toISOString().slice(0, 10);
  await db.doc(`stores/${storeId}/vouchers/${code}`).set({ code, type: "viphours", value: hours, minOrder: 0, maxUses: 1, perCustomer: 1, validTo, services: [], label, active: true, usedCount: 0, usedBy: {}, waiverRequired: true, createdAt: FieldValue.serverTimestamp(), ...extra });
  return { code, hours, validTo };
}
exports.onOrderDoneVip = onDocumentWritten("stores/{storeId}/orders/{id}", async (event) => {
  const a = event.data?.after?.data(), b = event.data?.before?.data();
  if (!a || !b || a.test || a.parentId || a.vipVoucher || b.status === a.status || !["completed", "delivered", "picked_up"].includes(a.status)) return;
  const store = (await db.doc(`stores/${event.params.storeId}`).get()).data() || {};
  const av = store.settings?.vip?.autoVoucher;
  if (!av?.enabled || !store.settings?.vip?.enabled || !(await storeEntitled(event.params.storeId, "events_vip"))) return;
  if ((a.subtotal || 0) < (Number(av.minSubtotal) || 0)) return;
  if (Array.isArray(av.services) && av.services.length && !av.services.includes(a.serviceType)) return;
  const v = await makeVipVoucher(event.params.storeId, Math.max(1, Math.min(6, Number(av.hours) || 2)), `Free VIP hours · #${a.orderNo}`, { orderId: event.params.id, auto: true });
  await event.data.after.ref.update({ vipVoucher: v });
});

/** Reply to a rating: thanks / investigating / refund / voucher / resolved — the customer sees it on their order */
exports.replyFeedback = onCall(async (req) => {
  const who = await staffFrom(req);
  if (!hasRole(who)) throw new HttpsError("permission-denied", "Only a manager or the owner can reply.");
  const { storeId } = who; const d = req.data || {};
  const ref = db.doc(`stores/${storeId}/feedback/${String(d.feedbackId || "")}`); const f = (await ref.get()).data();
  if (!f) throw new HttpsError("not-found", "Feedback not found.");
  const type = ["thanks", "investigating", "refund", "voucher", "resolved"].includes(d.type) ? d.type : "thanks";
  const reply = { type, note: String(d.note || "").trim().slice(0, 160), by: who.name, at: Date.now() };
  if (type === "voucher") {
    const amount = Math.round(Number(d.amount) || 0);
    if (!(amount >= 10 && amount <= 2000)) throw new HttpsError("invalid-argument", "Voucher amount must be ₱10–₱2,000.");
    const code = `SORRY-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const validTo = new Date(Date.now() + 30 * 86400000 + 8 * 3600e3).toISOString().slice(0, 10);
    await db.doc(`stores/${storeId}/vouchers/${code}`).set({ code, type: "amount", value: amount, minOrder: 0, maxUses: 1, perCustomer: 1, validTo, services: [], label: `Sorry voucher · #${f.orderNo}`, active: true, usedCount: 0, usedBy: {}, feedbackId: ref.id, createdAt: FieldValue.serverTimestamp() });
    Object.assign(reply, { amount, voucherCode: code, validTo });
  }
  if (type === "refund") { reply.amount = Math.max(0, Number(d.amount) || 0); reply.method = String(d.method || "gcash").slice(0, 20); reply.refNo = String(d.refNo || "").slice(0, 60); reply.refundId = await recordRefund(storeId, who, { amount: reply.amount, method: reply.method, refNo: reply.refNo, reason: "feedback", orderNo: f.orderNo, orderId: f.orderId, source: "feedback" }); }
  await ref.update({ reply, updatedAt: FieldValue.serverTimestamp() });
  const coll = f.kind === "appt" ? "appointments" : f.kind === "stay" ? "stays" : "orders";
  await db.doc(`stores/${storeId}/${coll}/${f.orderId}`).update({ feedbackReply: reply, updatedAt: FieldValue.serverTimestamp() }).catch(() => {});
  await audit(storeId, who, "feedback_" + type, { orderNo: f.orderNo, amount: reply.amount || 0 });
  return { ok: true, reply };
});

exports.reportIncident = onCall(async (req) => {
  const { uid } = requireAuth(req);
  const d = req.data || {};
  const storeId = String(d.storeId || ""), orderId = String(d.orderId || "");
  const type = String(d.type || "other").slice(0, 30);
  const description = String(d.description || "").trim().slice(0, 600);
  const photoUrl = d.photoUrl ? String(d.photoUrl).slice(0, 500) : null;
  if (!storeId || !orderId) throw new HttpsError("invalid-argument", "Missing data.");
  const storeSnap = await db.doc(`stores/${storeId}`).get();
  const inc = storeSnap.data()?.settings?.incidents || {};
  if (inc.enabled === false || !(await storeEntitled(storeId, "feedback"))) throw new HttpsError("failed-precondition", "Incident reports are not available.");
  if (inc.enabled === false) throw new HttpsError("failed-precondition", "Incident reports are not available.");
  const o = await loadOwnOrder(storeId, orderId, uid, d.kind === "appt" ? "appt" : "order");
  if (o.type === "appointment" && !photoUrl) throw new HttpsError("invalid-argument", "A photo is required for salon reports.");
  if (o.type === "laundry") {
    const hrs = Number(storeSnap.data()?.settings?.laundry?.complaintHours) || 24;
    const claimedAt = o.laundry?.claimedAt?.toMillis?.();
    if (claimedAt && Date.now() - claimedAt > hrs * 3600000) throw new HttpsError("failed-precondition", `Complaints are accepted within ${hrs} hours after claiming.`);
    if (!photoUrl) throw new HttpsError("invalid-argument", "A photo is required for laundry reports.");
  }
  const remote = o.serviceType === "pickup" || o.serviceType === "delivery";
  if (remote && inc.requireProof !== false && !photoUrl) throw new HttpsError("invalid-argument", "A photo is required as proof for pickup/delivery.");
  if (description.length < 5) throw new HttpsError("invalid-argument", "Please describe the problem.");
  const open = await db.collection(`stores/${storeId}/incidents`).where("orderId", "==", orderId).where("status", "in", ["open", "in_discussion"]).get();
  if (!open.empty) throw new HttpsError("already-exists", "This order already has an open report.");
  const ref = await db.collection(`stores/${storeId}/incidents`).add({
    orderId, orderNo: o.orderNo, type, description, photoUrl, serviceType: o.serviceType, tableId: o.tableId || null, tableLabel: o.tableLabel || null, total: o.total,
    customerName: o.customer?.name || "", customerPhone: o.customer?.phone || "", customerKey: o.customerKey || null, customerUid: uid,
    status: "open", claimedBy: null, claimedByName: null, resolution: null, messages: [],
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  });
  notifyTelegram(storeId, "incident", `⚠️ Incident on order #${o.orderNo}: ${type} — ${description.slice(0, 200)}`);
  // dine-in: call the manager to the table (shows up in Requests)
  if (!remote && o.tableId) {
    await db.collection(`stores/${storeId}/requests`).add({
      tableId: o.tableId, tableLabel: o.tableLabel, type: "incident", message: `⚠️ Incident #${o.orderNo}: ${type} — ${description.slice(0, 80)}`, incidentId: ref.id,
      status: "open", claimedBy: null, claimedByName: null, claimedAt: null, messages: [], customerUid: uid, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
  }
  return { id: ref.id };
});

// resolveIncident — manager/crew (per settings). Creates a voucher when the resolution is a voucher.
exports.resolveIncident = onCall(async (req) => {
  const who = await staffFrom(req);
  const storeId = who.storeId;
  const d = req.data || {};
  const incCfg = ((await db.doc(`stores/${storeId}`).get()).data()?.settings?.incidents) || {};
  const ref = db.doc(`stores/${storeId}/incidents/${String(d.incidentId || "")}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Incident not found.");
  const inc = snap.data();
  const action = String(d.action || "");
  const staff = { staffId: who.staffId, staffName: who.name };
  const patch = { updatedAt: FieldValue.serverTimestamp() };
  const isMgr = hasRole(who);
  if (["resolve", "dismiss"].includes(action) && incCfg.who === "manager" && !isMgr) throw new HttpsError("permission-denied", "Only a manager can resolve or dismiss reports.");
  if (action === "claim") Object.assign(patch, { status: inc.serviceType === "dine_in" || inc.serviceType === "take_out" ? "in_discussion" : "open", claimedBy: staff.staffId, claimedByName: staff.staffName, claimedAt: FieldValue.serverTimestamp() });
  else if (action === "discuss") Object.assign(patch, { status: "in_discussion" });
  else if (action === "resolve") {
    const r = d.resolution || {};
    const type = ["voucher", "refund", "remake", "discount", "none"].includes(r.type) ? r.type : "none";
    const resolution = { type, note: String(r.note || "").slice(0, 300), amount: Number(r.amount) || 0, by: staff.staffName, at: Date.now() };
    const crewMax = Number(incCfg.maxVoucherCrew ?? 100) || 100;
    if (!isMgr && ["voucher", "refund"].includes(type) && r.mode !== "percent" && resolution.amount > crewMax) throw new HttpsError("permission-denied", `Crew can give up to ₱${crewMax}. Ask a manager for more.`);
    if (type === "voucher") {
      if (!(resolution.amount > 0)) throw new HttpsError("invalid-argument", "Enter the voucher amount.");
      const code = `SORRY-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const validTo = new Date(Date.now() + 60 * 86400000 + 8 * 3600 * 1000).toISOString().slice(0, 10);
      await db.doc(`stores/${storeId}/vouchers/${code}`).set({ code, type: r.mode === "percent" ? "percent" : "amount", value: resolution.amount, minOrder: 0, maxUses: 1, perCustomer: 1, validTo, services: [], label: `Sorry voucher · #${inc.orderNo}`, active: true, usedCount: 0, usedBy: {}, incidentId: ref.id, createdAt: FieldValue.serverTimestamp() });
      resolution.voucherCode = code; resolution.voucherValidTo = validTo;
    }
    if (type === "discount") {
      if (!(resolution.amount > 0)) throw new HttpsError("invalid-argument", "Enter the discount amount.");
      const oRef = db.doc(`stores/${storeId}/orders/${inc.orderId}`); const o = (await oRef.get()).data();
      if (!o || o.paid || ["completed", "delivered", "picked_up", "cancelled"].includes(o.status)) throw new HttpsError("failed-precondition", "A bill discount only works on an open, unpaid order. Use a voucher or refund instead.");
      const amt = Math.min(resolution.amount, o.total || 0);
      await oRef.update({ total: round2((o.total || 0) - amt), "discounts.incident": round2((o.discounts?.incident || 0) + amt), incidentDiscount: { amount: amt, by: staff.staffName, at: Date.now() }, updatedAt: FieldValue.serverTimestamp() });
      resolution.amount = amt;
    }
    if (type === "refund") { resolution.method = String(r.method || "cash").slice(0, 20); resolution.refNo = String(r.refNo || "").slice(0, 60); resolution.refundId = await recordRefund(storeId, who, { amount: resolution.amount, method: resolution.method, refNo: resolution.refNo, reason: inc.type || "incident", orderNo: inc.orderNo, orderId: inc.orderId, source: "incident" }); }
    if (type === "remake") {
      // new ₱0 order so it shows up in the kitchen
      const oSnap = await db.doc(`stores/${storeId}/orders/${inc.orderId}`).get();
      const o = oSnap.data();
      const items = (o.items || []).filter((l) => !r.itemNames?.length || r.itemNames.includes(l.name)).map((l) => ({ ...l, unitPrice: 0, subtotal: 0, discount: 0 }));
      const { orderId } = await commitOrder(storeId, { type: o.type, serviceType: o.serviceType, status: "pending", tableId: o.tableId || null, tableLabel: o.tableLabel || null, items, stations: Object.fromEntries([...new Set(items.map((l) => l.station || "kitchen"))].map((st) => [st, "pending"])), subtotal: 0, deliveryFee: 0, total: 0, note: `REMAKE for #${o.orderNo} — ${resolution.note || inc.type}`, customer: o.customer || {}, customerUid: o.customerUid || null, source: "remake", remakeOf: inc.orderId, paid: true, paymentMethod: "remake", etaMinutes: null }, { skipLimit: true });
      resolution.remakeOrderId = orderId;
    }
    Object.assign(patch, { status: "resolved", resolution, resolvedAt: FieldValue.serverTimestamp() });
  } else if (action === "dismiss") {
    const reason = String(d.reason || "").trim().slice(0, 300);
    if (reason.length < 3) throw new HttpsError("invalid-argument", "Enter a reason.");
    Object.assign(patch, { status: "dismissed", resolution: { type: "dismissed", note: reason, by: staff.staffName, at: Date.now() }, resolvedAt: FieldValue.serverTimestamp() });
  } else if (action === "message") {
    const text = String(d.text || "").trim().slice(0, 300);
    if (!text) throw new HttpsError("invalid-argument", "Empty.");
    patch.messages = FieldValue.arrayUnion({ from: "staff", staffName: staff.staffName, text, at: Date.now() });
  } else throw new HttpsError("invalid-argument", "Unknown action.");
  await ref.update(patch);
  if (["resolve", "dismiss"].includes(action)) await audit(storeId, who, "incident_" + (patch.resolution?.type || action), { incidentId: ref.id, orderNo: inc.orderNo, amount: patch.resolution?.amount || 0 });
  return { ok: true, resolution: patch.resolution || null };
});

// attachWaiver — after the customer signs (PDF already uploaded)
exports.attachWaiver = onCall(async (req) => {
  const { uid, token } = requireAuth(req);
  const d = req.data || {};
  const storeId = String(d.storeId || ""), id = String(d.reservationId || "");
  const ref = db.doc(`stores/${storeId}/reservations/${id}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Reservation not found.");
  const r = snap.data();
  const isStaff = token.storeId === storeId;
  if (!ownsResv(r, uid) && !isStaff) throw new HttpsError("permission-denied", "This is not your reservation.");
  if (!d.pdfUrl || !d.signatureUrl) throw new HttpsError("invalid-argument", "Missing files.");
  await ref.update({ waiver: { pdfUrl: String(d.pdfUrl), signatureUrl: String(d.signatureUrl), idPhotoUrl: null, signerName: String(d.signerName || "").slice(0, 60), signedAt: FieldValue.serverTimestamp(), signedOnDevice: isStaff ? "store" : "customer" }, updatedAt: FieldValue.serverTimestamp() });
  return { ok: true };
});

// Next (optional): paymongoWebhook, Telegram/SMS alerts, laundry and booking modes
//   Step 6: createReservation (callable)
//   Step 7: checkSubscriptions (scheduled), activateSubscription (callable, admin)

// ===========================================================================
// STAY / AIRBNB — rooms (stores/{id}/rooms), bookings (stores/{id}/stays), caretaker + cleaner
// statuses: unconfirmed (Messenger) → pending (caretaker approval) → confirmed → checked_in → checked_out → done
// ===========================================================================
const STAY_ACTIVE = ["unconfirmed", "pending", "confirmed", "checked_in"];
const STAY_DK = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const ymdAdd = (ymd, n) => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const phAt = (ymd, hm) => new Date(`${ymd}T${hm || "14:00"}:00+08:00`);
const phYmd = (ms) => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
function stayCfg(store) {
  const c = store.settings?.stay || {};
  return { checkIn: c.checkIn || "14:00", checkOut: c.checkOut || "12:00", downPct: c.downPct ?? 50, weekendNights: c.weekendNights || ["fri", "sat"], holidays: c.holidays || [], pool: c.pool || { mode: "none", price: 0 }, extension: c.extension || { enabled: false, pricePerHour: 0, maxHours: 6 }, maxNights: c.maxNights || 14, maxDaysAhead: c.maxDaysAhead || 180,
    addons: (c.addons || []).filter((a) => a && a.name).slice(0, 30).map((a, i) => ({ id: String(a.id || "a" + i), name: String(a.name).slice(0, 40), price: Math.max(0, Number(a.price) || 0), per: a.per === "night" ? "night" : "stay", approval: !!a.approval, kind: a.kind === "kit" ? "kit" : "extra", max: Math.max(1, Math.min(20, Number(a.max) || 4)) })),
    deposit: { amount: Math.max(0, Number(c.deposit?.amount) || 0), checkMinutes: Math.max(15, Math.min(720, Number(c.deposit?.checkMinutes) || 60)) },
    guestIds: false, requireId: false, selfCheck: c.selfCheck?.enabled === true, codeHoursBefore: Number(c.selfCheck?.codeHoursBefore) || 2,
    overstay: { enabled: c.overstay?.enabled !== false, graceMin: Math.max(0, Number(c.overstay?.graceMin ?? 15)), ratePerHour: Math.max(0, Number(c.overstay?.ratePerHour) || 0) },
    cleaning: { minutes: Math.max(0, Math.min(480, Number(c.cleaning?.minutes ?? 60))), showGuests: c.cleaning?.showGuests !== false },
    promos: (c.promos || []).filter((x) => x && x.name && Number(x.percent) > 0).slice(0, 12).map((x, i) => ({ id: String(x.id || "p" + i), name: String(x.name).slice(0, 40), percent: Math.min(90, Number(x.percent)), days: (x.days || []).filter((d) => STAY_DK.includes(d)), applies: ["night", "short", "both"].includes(x.applies) ? x.applies : "both", from: x.from || "", until: x.until || "", start: x.start || "", end: x.end || "" })),
    loyalty: c.loyalty?.enabled ? { enabled: true, every: Math.max(2, Number(c.loyalty.every) || 5), percent: Math.min(100, Math.max(1, Number(c.loyalty.percent) || 20)) } : { enabled: false },
    noIdOk: true, kids: { freeUnder: Number(c.kids?.freeUnder ?? 7), countInPax: c.kids?.countInPax === true },
    amenities: (c.amenities || []).filter((a) => a && a.name).slice(0, 20).map((a, i) => ({ id: String(a.id || "m" + i), name: String(a.name).slice(0, 40), unit: ["free", "head", "hour", "stay"].includes(a.unit) ? a.unit : "free", price: Math.max(0, Number(a.price) || 0) })),
    nearby: (c.nearby || []).filter((x) => x && x.name).slice(0, 20).map((x) => ({ name: String(x.name).slice(0, 50), kind: String(x.kind || "").slice(0, 20), mins: Number(x.mins) || null, map: String(x.map || "").slice(0, 300) })),
    cancel: { fullDays: Math.max(0, Number(c.cancel?.fullDays) || 0), partialDays: Math.max(0, Number(c.cancel?.partialDays) || 0), partialPct: Math.max(0, Math.min(100, Number(c.cancel?.partialPct) || 0)) },
    lastMinute: c.lastMinute?.enabled ? { enabled: true, percent: Math.min(80, Math.max(1, Number(c.lastMinute.percent) || 20)), after: c.lastMinute.after || "18:00" } : { enabled: false },
    houseRules: String(c.houseRules || "").slice(0, 2000), visitorLog: c.visitorLog === true,
    ical: { exportShort: c.ical?.exportShort !== false },
    short: c.short?.enabled ? { enabled: true, timerOnArrival: c.short.timerOnArrival !== false, graceMin: Number(c.short.graceMin ?? 15), packages: (c.short.packages || []).filter((x) => [1, 3, 6, 12].includes(x.hours)), from: c.short.from || "08:00", until: c.short.until || "20:00", bufferMin: c.short.bufferMin ?? 60 } : { enabled: false, packages: [] } };
}
/** hour package price: the room's own price, else the shop's */
const shortPrice = (room, cfg, h) => { const r = room.shortPrices?.[h] ?? room.shortPrices?.[String(h)]; if (r != null && r !== "") return Number(r) || 0; const p = cfg.short.packages.find((x) => x.hours === h); return p ? Number(p.price) || 0 : null; };
/** price per night (weekday / weekend & holiday) */
function stayNights(room, cfg, inYmd, outYmd) {
  const nights = []; let d = inYmd, guard = 0;
  while (d < outYmd && guard++ < 60) {
    const dow = STAY_DK[new Date(`${d}T00:00:00Z`).getUTCDay()];
    const special = cfg.weekendNights.includes(dow) || cfg.holidays.includes(d);
    nights.push({ date: d, price: Number(special && room.weekendPrice ? room.weekendPrice : room.price) || 0, special });
    d = ymdAdd(d, 1);
  }
  return nights;
}
async function roomStays(storeId, roomId) {
  const snap = await db.collection(`stores/${storeId}/stays`).where("roomId", "==", roomId).get();
  return snap.docs.map((x) => ({ id: x.id, ...x.data() })).filter((s) => STAY_ACTIVE.includes(s.status));
}
/** dates booked on Airbnb.com / Booking.com (imported iCal) */
const icalClash = (room, startMs, endMs) => (room.icalBlocks || []).find((b) => b.start < endMs && b.end > startMs);
function stayConflict(stays, room, startMs, endMs, exceptId, inYmd, outYmd) {
  const ic = icalClash(room, startMs, endMs); if (ic) return `Those dates are already booked${ic.source ? ` on ${ic.source}` : ""}.`;
  if (stays.some((s) => s.id !== exceptId && s.checkIn.toMillis() - (s.short?.bufMs || 0) < endMs && s.checkOut.toMillis() + (s.short?.bufMs || 0) > startMs)) return "Those dates are already booked.";
  if (inYmd && (room.blocked || []).some((b) => b >= inYmd && b < outYmd)) return "The room is not available on some of those dates.";
  return null;
}
async function staySetup(slug) {
  const pub = (await db.doc(`publicStores/${String(slug || "")}`).get()).data();
  if (!pub || pub.mode !== "stay") throw new HttpsError("not-found", "Store not found.");
  const store = (await db.doc(`stores/${pub.storeId}`).get()).data();
  return { pub, store, storeId: pub.storeId, cfg: stayCfg(store) };
}
function stayTotal(s) {
  const charges = (s.charges || []).reduce((a, c) => a + (Number(c.amount) || 0), 0);
  const addons = (s.addons || []).filter((x) => x.status !== "declined").reduce((a, x) => a + (Number(x.amount) || 0), 0);
  return round2(Math.max(0, (s.subtotal || 0) + (s.poolFee || 0) + addons + charges - (s.discount?.amount || 0) - (s.noticeDiscount?.amount || 0)));
}
const phoneKeyOf = (p) => String(p || "").replace(/\D/g, "");
/** best promo (slow days / hours) or loyalty reward for a booking — no stacking */
function stayDiscount(cfg, { nights, short, startMs, subtotal, visits }) {
  let best = null;
  const dowOf = (ms) => STAY_DK[new Date(ms + 8 * 3600000).getUTCDay()];
  for (const p of cfg.promos) {
    const ymd = phYmd(startMs);
    if ((p.start && ymd < p.start) || (p.end && ymd > p.end)) continue;
    let amt = 0;
    if (short) {
      if (p.applies === "night") continue;
      const hm = new Date(startMs + 8 * 3600000).toISOString().slice(11, 16);
      if (p.days.length && !p.days.includes(dowOf(startMs))) continue;
      if ((p.from && hm < p.from) || (p.until && hm > p.until)) continue;
      amt = subtotal * p.percent / 100;
    } else {
      if (p.applies === "short") continue;
      amt = nights.filter((n) => !p.days.length || p.days.includes(STAY_DK[new Date(`${n.date}T00:00:00Z`).getUTCDay()])).reduce((a, n) => a + n.price, 0) * p.percent / 100;
    }
    if (amt > 0 && (!best || amt > best.amount)) best = { kind: "promo", name: p.name, percent: p.percent, amount: round2(amt) };
  }
  if (cfg.lastMinute.enabled && !short && nights.length && nights[0].date === phYmd(Date.now()) && new Date(Date.now() + 8 * 3600000).toISOString().slice(11, 16) >= cfg.lastMinute.after) {
    const amt = round2(nights[0].price * cfg.lastMinute.percent / 100);
    if (!best || amt > best.amount) best = { kind: "lastminute", name: `Tonight's deal · ${cfg.lastMinute.percent}% off`, percent: cfg.lastMinute.percent, amount: amt };
  }
  if (cfg.loyalty.enabled && (visits + 1) % cfg.loyalty.every === 0) {
    const amt = round2(subtotal * cfg.loyalty.percent / 100);
    if (!best || amt > best.amount) best = { kind: "loyalty", name: `Loyalty · stay #${visits + 1}`, percent: cfg.loyalty.percent, amount: amt };
  }
  return best;
}
/** may the guest see the door code / self check-in? confirmed + downpayment verified + deposit held */
function stayKeyReady(s, cfg, now) {
  if (!["confirmed", "checked_in"].includes(s.status)) return "Your booking isn't confirmed yet.";
  if ((s.downpayment || 0) > 0 && s.payment?.status !== "verified" && (s.paidAmount || 0) + 0.01 < (s.downpayment || 0)) return "We're still checking your downpayment.";
  if ((s.deposit?.amount || 0) > 0 && !["held", "checking", "checked"].includes(s.deposit.status)) return "Pay the security deposit first.";
  if (now < s.checkIn.toMillis() - cfg.codeHoursBefore * 3600000) return `The door code shows ${cfg.codeHoursBefore} hours before check-in.`;
  if (now > s.checkOut.toMillis() + (cfg.overstay.graceMin || 0) * 60000 && s.status !== "checked_in") return "Your stay has ended.";
  return null;
}

// calendar: booked nights for a room (next ~6 months)
exports.getStayCalendar = onCall(async (req) => {
  requireAuth(req);
  const { storeId, cfg } = await staySetup(req.data?.slug);
  const roomId = String(req.data?.roomId || "");
  const room = (await db.doc(`stores/${storeId}/rooms/${roomId}`).get()).data();
  if (!room) throw new HttpsError("not-found", "Room not found.");
  const booked = new Set(room.blocked || []);
  const stays = await roomStays(storeId, roomId);
  const buf = (cfg.short.bufferMin || 0) * 60000;
  stays.forEach((s) => {
    if (s.short) { // a few hours in the day: blocks that night only if it runs into the overnight check-in
      const d = phYmd(s.checkIn.toMillis()); if (s.checkOut.toMillis() + buf > phAt(d, cfg.checkIn).getTime()) booked.add(d);
      const d0 = ymdAdd(d, -1); if (s.checkIn.toMillis() - buf < phAt(d, cfg.checkOut).getTime()) booked.add(d0);
      return;
    }
    let d = phYmd(s.checkIn.toMillis()); const out = phYmd(s.checkOut.toMillis() - 3600000); let g = 0; while (d <= out && g++ < 90) { booked.add(d); d = ymdAdd(d, 1); }
  });
  for (const b of (room.icalBlocks || [])) { let d = phYmd(b.start); const out = phYmd(b.end - 3600000); let g = 0; while (d <= out && g++ < 90) { booked.add(d); d = ymdAdd(d, 1); } }
  const soon = Date.now() + 62 * 86400000;
  const busy = stays.filter((s) => s.checkIn.toMillis() < soon && s.checkOut.toMillis() > Date.now()).map((s) => [s.checkIn.toMillis() - buf, s.checkOut.toMillis() + buf]);
  for (const b of (room.icalBlocks || [])) if (b.end > Date.now() && b.start < soon) busy.push([b.start - buf, b.end + buf]);
  return { booked: [...booked].sort(), busy, blocked: room.blocked || [] };
});

exports.bookStay = onCall(withIndex("stay", async (req) => {
  await maintGuard(req);
  const { uid } = requireAuth(req);
  const d = req.data || {};
  const { pub, store, storeId, cfg } = await staySetup(d.slug);
  if (pub.locked || pub.acceptOrders === false) throw new HttpsError("failed-precondition", "Not accepting bookings right now."); if (pub.comingSoon && !(pub.testMode && pub.testMode.until > Date.now())) throw new HttpsError("failed-precondition", "This shop is not open yet — coming soon!");
  const roomRef = db.doc(`stores/${storeId}/rooms/${String(d.roomId || "")}`); const room = (await roomRef.get()).data();
  if (!room || room.active === false) throw new HttpsError("not-found", "Room not available.");
  const shortH = d.shortHours ? Number(d.shortHours) : 0;
  if (shortH && ![1, 3, 6, 12].includes(shortH)) throw new HttpsError("invalid-argument", "Pick an hour package.");
  let short = null, startMs, endMs;
  const inYmd = String(d.checkIn || "");
  let outYmd = String(d.checkOut || "");
  if (shortH) {
    // ⏳ short stay (hour package): check-in at the chosen time, out after N hours
    if (!cfg.short.enabled) throw new HttpsError("failed-precondition", "Short stays are not offered.");
    const price = shortPrice(room, cfg, shortH);
    if (price == null) throw new HttpsError("invalid-argument", "That hour package is not offered.");
    const hm = String(d.startTime || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(inYmd) || !/^\d{2}:\d{2}$/.test(hm)) throw new HttpsError("invalid-argument", "Choose the date and start time.");
    if (hm < cfg.short.from || hm > cfg.short.until) throw new HttpsError("invalid-argument", `Short stays start between ${cfg.short.from} and ${cfg.short.until}.`);
    startMs = phAt(inYmd, hm).getTime(); endMs = startMs + shortH * 3600000;
    if (startMs < Date.now() + 20 * 60000) throw new HttpsError("invalid-argument", "Pick a start time at least 20 minutes from now.");
    outYmd = phYmd(endMs);
    short = { hours: shortH, price, startTime: hm, bufMs: (cfg.short.bufferMin != null && cfg.short.bufferMin !== "" ? Number(cfg.short.bufferMin) || 0 : cfg.cleaning.minutes) * 60000 };
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(inYmd) || !/^\d{4}-\d{2}-\d{2}$/.test(outYmd) || outYmd <= inYmd) throw new HttpsError("invalid-argument", "Choose your check-in and check-out dates.");
  const today = phYmd(Date.now());
  if (inYmd < today) throw new HttpsError("invalid-argument", "Check-in can't be in the past.");
  if (inYmd > ymdAdd(today, cfg.maxDaysAhead)) throw new HttpsError("invalid-argument", `Bookings open up to ${cfg.maxDaysAhead} days ahead.`);
  const nights = short ? [] : stayNights(room, cfg, inYmd, outYmd);
  if (nights.length > cfg.maxNights) throw new HttpsError("invalid-argument", `Maximum stay is ${cfg.maxNights} nights.`);
  const adults = Math.max(1, parseInt(d.adults ?? d.guests, 10) || 1), kids = Math.max(0, parseInt(d.kids, 10) || 0);
  const pax = adults + (cfg.kids.countInPax ? kids : 0);
  if (pax > (Number(room.capacity) || 20)) throw new HttpsError("invalid-argument", `This room allows up to ${room.capacity} guests${cfg.kids.countInPax ? " (kids included)" : ""}.`);
  const guests = pax;
  const customer = { name: String(d.customer?.name || "").trim().slice(0, 60), phone: String(d.customer?.phone || "").trim().slice(0, 30), messenger: msgrOf(d.customer?.messenger) };
  if (customer.name.length < 2 || customer.phone.replace(/\D/g, "").length < 7) throw new HttpsError("invalid-argument", "Name and phone number are required.");
  if (!d.policyAccepted || !d.noRefundAccepted) throw new HttpsError("invalid-argument", "Please accept the house policy and the no-refund policy.");
  const noId = !!d.noId && !d.waiver?.idPhotoUrl;
  // Valid ID collection is disabled; booking eligibility must not depend on ID uploads.
  if (cfg.houseRules && !d.rulesAck) throw new HttpsError("invalid-argument", "Please accept the house rules.");
  const ovRate = cfg.overstay.enabled ? Number(cfg.overstay.ratePerHour) || Number(cfg.extension.pricePerHour) || 0 : 0;
  if (ovRate && d.overstayAck !== true) throw new HttpsError("invalid-argument", `Please acknowledge the overstay fee (₱${ovRate} per hour after check-out).`);
  if (!d.waiver?.signatureUrl) throw new HttpsError("invalid-argument", "Please sign the waiver.");
  // every guest shows a valid ID (the booker's is idPhotoUrl; the rest go in guestIds)
  const guestIds = []; // Do not collect or persist guest ID uploads.
  if (!short) { startMs = phAt(inYmd, cfg.checkIn).getTime(); endMs = phAt(outYmd, cfg.checkOut).getTime(); }
  const sbuf = (cfg.short.bufferMin || 0) * 60000;
  const conflict = short
    ? ((await roomStays(storeId, roomRef.id)).some((x) => x.checkIn.toMillis() - sbuf < endMs && x.checkOut.toMillis() + sbuf > startMs) || icalClash(room, startMs - sbuf, endMs + sbuf) ? "That time is taken — pick another start time." : (room.blocked || []).includes(inYmd) ? "The room is not available that day." : null)
    : stayConflict(await roomStays(storeId, roomRef.id), room, startMs, endMs, null, inYmd, outYmd);
  if (conflict) throw new HttpsError("already-exists", conflict);
  const phoneKey = customer.phone.replace(/\D/g, "");
  const cRec = (await db.doc(`stores/${storeId}/customers/${phoneKey}`).get()).data();
  if (cRec?.flagged) throw new HttpsError("permission-denied", "We can't accept this booking. Please message us.");
  // Per-guest ID collection is disabled.
  const subtotal = short ? round2(short.price) : round2(nights.reduce((a, n) => a + n.price, 0));
  // add-ons: extra bed foam, blankets, towels, amenity kits… (limited items wait for the caretaker's OK)
  const addons = [];
  for (const x of (Array.isArray(d.addons) ? d.addons : []).slice(0, 30)) {
    const a = cfg.addons.find((y) => y.id === String(x.id)); const qty = Math.max(0, Math.min(a?.max || 0, parseInt(x.qty, 10) || 0));
    if (!a || !qty) continue;
    const times = a.per === "night" ? Math.max(1, nights.length) : 1;
    addons.push({ id: a.id, name: a.name, qty, price: a.price, per: a.per, kind: a.kind, amount: round2(a.price * qty * times), status: a.approval ? "pending" : "approved" });
  }
  // use of amenities (pool, gym, videoke…): paid ones are added to the bill
  for (const x of (Array.isArray(d.amenities) ? d.amenities : []).slice(0, 20)) {
    const a = cfg.amenities.find((y) => y.id === String(x.id)); if (!a || a.unit === "free" || !a.price) continue;
    const qty = Math.max(0, Math.min(50, parseInt(x.qty, 10) || 0)); if (!qty) continue;
    const hrs = a.unit === "hour" ? Math.max(1, Math.min(24, parseInt(x.hours, 10) || 1)) : 1;
    addons.push({ id: "am_" + a.id, name: `${a.name}${a.unit === "head" ? ` · ${qty} pax` : a.unit === "hour" ? ` · ${hrs} h` : ""}`, qty: a.unit === "head" ? qty : 1, price: a.price, per: "stay", kind: "amenity", amount: round2(a.price * (a.unit === "head" ? qty : 1) * hrs), status: "approved" });
  }
  // room notice: known issues (no heater, broken aircon…) → discount the guest accepts before booking
  const notices = (room.notices || []).filter((n) => n && n.label);
  if (notices.length && !d.noticeAck) throw new HttpsError("invalid-argument", "Please read and accept the room notice.");
  const nPct = Math.max(0, ...notices.map((n) => Number(n.percent) || 0));
  const noticeDiscount = notices.length ? { labels: notices.map((n) => n.label), percent: nPct, amount: round2(subtotal * nPct / 100) } : null;
  const visits = phoneKeyOf(customer.phone) ? ((await db.doc(`stores/${storeId}/customers/${phoneKeyOf(customer.phone)}`).get()).data()?.stays || 0) : 0;
  const discount = stayDiscount(cfg, { nights, short, startMs, subtotal, visits });
  const depositAmt = Math.max(0, Number(room.deposit ?? cfg.deposit.amount) || 0);
  const poolGuests = cfg.pool.mode === "per_head" ? Math.max(0, Math.min(guests, parseInt(d.poolGuests, 10) || 0)) : 0;
  const poolFee = round2(poolGuests * (Number(cfg.pool.price) || 0));
  const total = stayTotal({ subtotal, poolFee, addons, discount, noticeDiscount });
  const downpayment = round2(total * (Number(cfg.downPct) || 0) / 100);
  const pm = (pub.payments || []).find((m) => m.id === d.payment?.methodId) || null;
  const refNo = String(d.payment?.refNo || "").trim().slice(0, 60);
  if (downpayment > 0 && pm && pm.type !== "cash" && pm.askRefBookings !== false && refNo.length < 4 && !d.payment?.proofUrl) throw new HttpsError("invalid-argument", `Enter the ${pm.name} reference number for the downpayment.`);
  const code = /^S-[A-Z0-9]{4,6}$/.test(String(d.code || "")) ? String(d.code) : "S-" + Array.from({ length: 5 }, () => CLAIM_ALPHABET[Math.floor(Math.random() * CLAIM_ALPHABET.length)]).join("");
  const needsConfirm = !!(pub.confirm?.mode && pub.confirm.mode !== "off");
  const reqText = String(d.request || "").trim().slice(0, 300);
  const stayTest = testOn(store.settings);
  { const { lim, plan } = await storeLimits(storeId, "stay"); await countBooking(storeId, lim, plan, false); }
  const ref = await db.collection(`stores/${storeId}/stays`).add({
    ...(stayTest ? { test: true } : {}),
    code, roomId: roomRef.id, roomName: room.name, checkIn: Timestamp.fromMillis(startMs), checkOut: Timestamp.fromMillis(endMs), checkInYmd: inYmd, checkOutYmd: outYmd,
    adults, kids, noId: false, needsIdOk: false, noticeDiscount, rulesAck: cfg.houseRules ? Date.now() : null, overstayAck: ovRate ? { rate: ovRate, graceMin: cfg.overstay.graceMin, at: Date.now() } : null, cancelPolicy: cfg.cancel, visitors: [], issues: [],
    nights, nightsCount: nights.length, short, guests, poolGuests, addons, discount: discount || null, deposit: depositAmt ? { amount: depositAmt, status: "due" } : null, inventory: (room.inventory || []).slice(0, 40), visitNo: visits + 1, poolFee, subtotal, charges: [], total, downpayment, paidAmount: 0,
    payment: pm ? { methodId: pm.id, method: pm.type, methodName: pm.name, refNo: refNo || null, proofUrl: d.payment?.proofUrl ? String(d.payment.proofUrl).slice(0, 500) : null, status: "to_verify" } : null,
    customer, customerUid: uid, customerKey: phoneKey, waiver: { guestIds, signatureUrl: String(d.waiver.signatureUrl).slice(0, 500), idPhotoUrl: null, pdfUrl: d.waiver.pdfUrl ? String(d.waiver.pdfUrl).slice(0, 500) : null, acceptedAt: FieldValue.serverTimestamp() },
    noRefundAccepted: true, requests: reqText ? [{ id: "r1", type: "Note", text: reqText, status: "pending", at: Date.now() }] : [],
    status: needsConfirm ? "unconfirmed" : "pending", needsConfirm, confirmDeadline: needsConfirm ? Timestamp.fromMillis(Math.min(Date.now() + (Number(pub.confirm.minutes) || 60) * 60000, startMs)) : null,
    reschedule: null, extension: null, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  });
  if (!stayTest) await db.doc(`stores/${storeId}/customers/${phoneKey}`).set({ phone: customer.phone, name: customer.name, orders: FieldValue.increment(1), lastOrderAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  if ((room.icalImports || []).length) notifyTelegram(storeId, "reservation", `📅 Block ${room.name} ${short ? inYmd : `${inYmd} → ${outYmd}`} on ${(room.icalImports || []).map((x) => x.name || "your other sites").join(" / ")} too — their calendars only refresh every few hours.`);
  notifyTelegram(storeId, "reservation", `${stayTest ? "🧪 TEST · " : ""}🏡 New stay ${code} · ${room.name} · ${short ? `${inYmd} ${short.startTime} · ⏳ ${short.hours}-hour stay` : `${inYmd} → ${outYmd} (${nights.length} night${nights.length > 1 ? "s" : ""})`} · ${customer.name} ${customer.phone} · ₱${total}${needsConfirm ? " (awaiting Messenger)" : ""}`);
  return { id: ref.id, storeId, code, needsConfirm };
}));

async function ownStay(storeId, id, uid) {
  const ref = db.doc(`stores/${storeId}/stays/${String(id || "")}`); const snap = await ref.get();
  if (!snap.exists || snap.data().customerUid !== uid) throw new HttpsError("permission-denied", "This is not your booking.");
  return { ref, s: { id: snap.id, ...snap.data() } };
}
// guest: request · reschedule · extend · checkout
exports.stayGuestAction = onCall(async (req) => {
  const { uid } = requireAuth(req);
  const d = req.data || {};
  const storeId = String(d.storeId || "");
  const store = (await db.doc(`stores/${storeId}`).get()).data(); if (!store) throw new HttpsError("not-found", "Store not found.");
  const cfg = stayCfg(store);
  const { ref, s } = await ownStay(storeId, d.id, uid);
  const now = Date.now();
  if (d.action === "request") {
    const text = String(d.text || "").trim().slice(0, 300); if (text.length < 2) throw new HttpsError("invalid-argument", "Type your request.");
    if (!["pending", "confirmed", "checked_in", "unconfirmed"].includes(s.status)) throw new HttpsError("failed-precondition", "Requests are closed for this booking.");
    const r = { id: "r" + now, type: String(d.type || "Other").slice(0, 30), text, status: "pending", at: now };
    await ref.update({ requests: FieldValue.arrayUnion(r), updatedAt: FieldValue.serverTimestamp() });
    notifyTelegram(storeId, "reservation", `🏡 Request · ${s.code} · ${s.roomName}: [${r.type}] ${text}`);
    return { ok: true };
  }
  if (d.action === "reschedule") {
    if (!["unconfirmed", "pending", "confirmed"].includes(s.status)) throw new HttpsError("failed-precondition", "You can only reschedule before check-in.");
    const mfee = s.status === "unconfirmed" ? 0 : reschedFee(bookingPolicy(store), s.checkIn.toMillis(), s.reschedCount || 0, stayTotal(s), d.acceptFee);
    const inYmd = String(d.checkIn || ""), outYmd = String(d.checkOut || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(inYmd) || !/^\d{4}-\d{2}-\d{2}$/.test(outYmd) || outYmd <= inYmd || inYmd < phYmd(now)) throw new HttpsError("invalid-argument", "Choose new dates.");
    const room = (await db.doc(`stores/${storeId}/rooms/${s.roomId}`).get()).data();
    const startMs = phAt(inYmd, cfg.checkIn).getTime(), endMs = phAt(outYmd, cfg.checkOut).getTime();
    const c = stayConflict(await roomStays(storeId, s.roomId), room, startMs, endMs, s.id, inYmd, outYmd); if (c) throw new HttpsError("already-exists", c);
    const nights = stayNights(room, cfg, inYmd, outYmd);
    await ref.update({ reschedule: { checkIn: inYmd, checkOut: outYmd, nights: nights.length, fee: mfee, subtotal: round2(nights.reduce((a, n) => a + n.price, 0)), status: "pending", at: now }, updatedAt: FieldValue.serverTimestamp() });
    notifyTelegram(storeId, "reservation", `🏡 Reschedule request · ${s.code} · ${s.roomName}: ${inYmd} → ${outYmd}`);
    return { ok: true };
  }
  if (d.action === "extend") {
    if (!cfg.extension.enabled) throw new HttpsError("failed-precondition", "Extensions aren't available.");
    if (s.status !== "checked_in") throw new HttpsError("failed-precondition", "You can extend once you're checked in.");
    const hours = Math.max(1, Math.min(Number(cfg.extension.maxHours) || 6, parseInt(d.hours, 10) || 1));
    const newEnd = s.checkOut.toMillis() + hours * 3600000;
    const next = (await roomStays(storeId, s.roomId)).find((x) => x.id !== s.id && x.checkIn.toMillis() < newEnd && x.checkIn.toMillis() >= s.checkOut.toMillis() - 60000);
    const price = round2(hours * (Number(cfg.extension.pricePerHour) || 0));
    if (next) { await ref.update({ extension: { hours, price, status: "declined", reason: "The room is booked right after your stay.", at: now }, updatedAt: FieldValue.serverTimestamp() }); return { declined: true, reason: "Sorry — the room is booked right after your stay." }; }
    await ref.update({ extension: { hours, price, status: "pending", at: now }, updatedAt: FieldValue.serverTimestamp() });
    notifyTelegram(storeId, "reservation", `🏡 Extension request · ${s.code} · ${s.roomName}: +${hours}h (₱${price})`);
    return { ok: true, price };
  }
  if (d.action === "checkout") {
    if (s.status !== "checked_in") throw new HttpsError("failed-precondition", "You're not checked in.");
    await stayCheckedOut(storeId, ref, s, cfg, "guest", now);
    notifyTelegram(storeId, "reservation", `🧹 Guest checked out · ${s.roomName} (${s.code}) — check the room${s.deposit?.amount ? ` and release the ₱${s.deposit.amount} deposit` : ""}`);
    return { ok: true };
  }
  if (d.action === "ack") { // guest confirms the room's item list (counted again at check-out)
    if (!["confirmed", "checked_in", "pending"].includes(s.status)) throw new HttpsError("failed-precondition", "Not available now.");
    await ref.update({ inventoryAck: { at: now, items: s.inventory || [] }, updatedAt: FieldValue.serverTimestamp() }); return { ok: true };
  }
  if (d.action === "passcode" || d.action === "selfCheckin") {
    const why = stayKeyReady(s, cfg, now); if (why) throw new HttpsError("failed-precondition", why);
    const room = (await db.doc(`stores/${storeId}/rooms/${s.roomId}`).get()).data() || {};
    if (room.doorType === "meet") throw new HttpsError("failed-precondition", "The caretaker will meet you and let you in.");
    if (d.action === "passcode") { if (!room.passcode) throw new HttpsError("not-found", "This room has no door code — the caretaker will meet you."); return { code: room.passcode, note: room.doorNote || "", until: s.checkOut.toMillis() }; }
    if (!cfg.selfCheck) throw new HttpsError("failed-precondition", "Self check-in is off — the caretaker will check you in.");
    if (s.status === "checked_in") return { ok: true };
    if ((s.inventory || []).length && !s.inventoryAck) throw new HttpsError("failed-precondition", "Please confirm the room's item list first.");
    if (now < s.checkIn.toMillis() - 30 * 60000) throw new HttpsError("failed-precondition", "Self check-in opens 30 minutes before your check-in time.");
    let tpatch = {};
    if (s.short && cfg.short.timerOnArrival) { const start = Math.min(now, s.checkIn.toMillis() + (cfg.short.graceMin || 0) * 60000); if (start < s.checkIn.toMillis()) { const end = start + s.short.hours * 3600000; tpatch = { checkIn: Timestamp.fromMillis(start), checkOut: Timestamp.fromMillis(end), "short.startedAt": start }; } else tpatch = { "short.startedAt": Math.max(start, s.checkIn.toMillis()) }; }
    await ref.update({ status: "checked_in", checkedInAt: FieldValue.serverTimestamp(), checkedInBy: "guest (self)", ...tpatch, updatedAt: FieldValue.serverTimestamp() });
    await db.doc(`stores/${storeId}/rooms/${s.roomId}`).set({ housekeeping: { status: "occupied", stayId: s.id, since: now } }, { merge: true });
    notifyTelegram(storeId, "reservation", `🔑 Self check-in · ${s.roomName} (${s.code}) · ${s.customer?.name || ""}`);
    return { ok: true };
  }
  if (d.action === "cancel") { // refund follows the policy the guest accepted at booking
    if (!["unconfirmed", "pending", "confirmed"].includes(s.status)) throw new HttpsError("failed-precondition", "This booking can't be cancelled now.");
    const pol = s.cancelPolicy || cfg.cancel; const days = (s.checkIn.toMillis() - now) / 86400000;
    const pct = !bookingPolicy(store).refundable ? 0 : pol.fullDays && days >= pol.fullDays ? 100 : pol.partialDays && days >= pol.partialDays ? pol.partialPct : 0;
    const amount = round2((s.paidAmount || 0) * pct / 100);
    await ref.update({ status: "cancelled", cancelReason: String(d.reason || "Cancelled by the guest").slice(0, 200), cancelledBy: "guest", refund: amount ? { amount, pct, status: "due", reason: `Cancelled ${Math.floor(days)} day(s) before · ${pct}% refund`, at: now } : { amount: 0, pct, status: "none" }, ...(s.deposit?.amount && ["held", "to_verify"].includes(s.deposit.status) ? { "deposit.status": "checked", "deposit.refund": s.deposit.amount, "deposit.deductions": [] } : {}), updatedAt: FieldValue.serverTimestamp() });
    notifyTelegram(storeId, "reservation", `✕ Guest cancelled ${s.code} · ${s.roomName} · refund ${pct}% = ₱${amount}`);
    return { ok: true, pct, amount };
  }
  if (d.action === "visitor") { // visitor log (security)
    if (!["confirmed", "checked_in"].includes(s.status)) throw new HttpsError("failed-precondition", "Only during your stay.");
    const name = String(d.name || "").trim().slice(0, 60); if (name.length < 2) throw new HttpsError("invalid-argument", "Enter the visitor's name.");
    const v = { name, count: Math.max(1, Math.min(20, parseInt(d.count, 10) || 1)), until: String(d.until || "").slice(0, 20), at: now };
    await ref.update({ visitors: FieldValue.arrayUnion(v), updatedAt: FieldValue.serverTimestamp() });
    notifyTelegram(storeId, "reservation", `👥 Visitor · ${s.roomName} (${s.code}): ${name} × ${v.count}${v.until ? ` until ${v.until}` : ""}`);
    return { ok: true };
  }
  if (d.action === "issue") { // something broken during the stay — reported with a photo (proof it wasn't the guest)
    if (!["checked_in", "confirmed"].includes(s.status)) throw new HttpsError("failed-precondition", "Only during your stay.");
    const text = String(d.text || "").trim().slice(0, 300); if (text.length < 3) throw new HttpsError("invalid-argument", "Describe the problem.");
    const photo = String(d.photo || ""); if (photo && !photo.startsWith(`priv:stores/${storeId}/private/${uid}/`)) throw new HttpsError("invalid-argument", "Bad photo.");
    const it = { id: "i" + now, text, photo: photo || null, at: now, status: "open" };
    await ref.update({ issues: FieldValue.arrayUnion(it), updatedAt: FieldValue.serverTimestamp() });
    notifyTelegram(storeId, "incident", `🛠 ${s.roomName} (${s.code}): guest reported "${text}"${photo ? " (with photo)" : ""}`, { force: true });
    return { ok: true };
  }
  if (d.action === "roomChange") {
    if (!["confirmed", "checked_in", "pending"].includes(s.status)) throw new HttpsError("failed-precondition", "Not available now.");
    await ref.update({ roomChange: { roomId: String(d.roomId || ""), reason: String(d.reason || "").slice(0, 200), status: "pending", at: now }, updatedAt: FieldValue.serverTimestamp() });
    notifyTelegram(storeId, "reservation", `🔁 Room change request · ${s.code} (${s.roomName}): ${String(d.reason || "").slice(0, 120)}`);
    return { ok: true };
  }
  if (d.action === "disputeDeposit") { // guest disagrees with a deduction → disputed amount on hold until the owner decides
    const dep = s.deposit; if (!dep || !["checked", "released"].includes(dep.status) || !(dep.deductions || []).length) throw new HttpsError("failed-precondition", "There's nothing to dispute.");
    if (dep.dispute) throw new HttpsError("already-exists", "You already sent a dispute.");
    if ((dep.checkedAt || 0) < now - 48 * 3600000) throw new HttpsError("failed-precondition", "Disputes must be sent within 48 hours of the room check.");
    const reason = String(d.reason || "").trim().slice(0, 500); if (reason.length < 5) throw new HttpsError("invalid-argument", "Tell us what's wrong with the deduction.");
    const photo = String(d.photo || ""); if (photo && !photo.startsWith(`priv:stores/${storeId}/private/${uid}/`)) throw new HttpsError("invalid-argument", "Bad photo.");
    const items = (Array.isArray(d.items) ? d.items : []).map(String).slice(0, 12);
    const lines = (dep.deductions || []).filter((x, i) => !items.length || items.includes(String(i)));
    await ref.update({ "deposit.dispute": { status: "open", reason, photo: photo || null, lines: lines.map((x) => x.label), amount: round2(lines.reduce((a, x) => a + (x.amount || 0), 0)), at: now }, updatedAt: FieldValue.serverTimestamp() });
    notifyTelegram(storeId, "incident", `⚖️ Deposit dispute · ${s.roomName} (${s.code}) · ₱${round2(lines.reduce((a, x) => a + (x.amount || 0), 0))}: ${reason.slice(0, 200)}`, { force: true });
    return { ok: true };
  }
  if (d.action === "payDeposit") {
    if (!s.deposit?.amount || !["due", "rejected"].includes(s.deposit.status)) throw new HttpsError("failed-precondition", "No deposit to pay.");
    const pub = (await db.doc(`publicStores/${store.slug}`).get()).data() || {};
    const pm = (pub.payments || []).find((m) => m.id === d.methodId);
    const refNo = String(d.refNo || "").trim().slice(0, 60);
    if (!pm || (refNo.length < 4 && !d.proofUrl)) throw new HttpsError("invalid-argument", "Pick how you paid and enter the reference number.");
    await ref.update({ "deposit.status": "to_verify", "deposit.payment": { methodId: pm.id, methodName: pm.name, refNo, proofUrl: d.proofUrl ? String(d.proofUrl).slice(0, 500) : null, at: now }, updatedAt: FieldValue.serverTimestamp() });
    notifyTelegram(storeId, "reservation", `🔐 Security deposit sent · ${s.code} · ₱${s.deposit.amount} · ${pm.name} ref ${refNo}`);
    return { ok: true };
  }
  throw new HttpsError("invalid-argument", "Unknown action.");
});

/** check-out (guest or caretaker): final overstay, deposit → "waiting for room check" with a deadline */
async function stayCheckedOut(storeId, ref, s, cfg, by, now) {
  const patch = { status: "checked_out", checkedOutAt: FieldValue.serverTimestamp(), checkedOutBy: by, updatedAt: FieldValue.serverTimestamp() };
  const ov = overstayCharge(s, cfg, now);
  if (ov) { const charges = [...(s.charges || []).filter((c) => c.kind !== "overstay"), ov.line]; patch.charges = charges; patch.total = stayTotal({ ...s, charges }); patch.overstay = { ...(s.overstay || {}), hours: ov.hours, amount: ov.line.amount, final: true }; }
  if (s.deposit?.amount && ["held", "to_verify", "due"].includes(s.deposit.status)) { patch["deposit.statusBefore"] = s.deposit.status; patch["deposit.status"] = "checking"; patch["deposit.checkBy"] = now + cfg.deposit.checkMinutes * 60000; }
  await ref.update(patch);
  await db.doc(`stores/${storeId}/rooms/${s.roomId}`).set({ housekeeping: { status: "to_clean", stayId: s.id, since: now, needsCheck: true } }, { merge: true });
  { const nx = await nextGuestRoomState(storeId, s.roomId, { status: "to_clean", at: now, eta: now + cfg.cleaning.minutes * 60000 }); if (nx) sendPush(storeId, { roles: ["cleaner", "manager"] }, { title: `🧹 Clean ${s.roomName} — next guest ${new Date(nx.checkIn).toLocaleString("en-PH", { timeZone: "Asia/Manila", weekday: "short", hour: "numeric", minute: "2-digit" })}`, body: `${nx.name} checks in next. Tap “Finished cleaning” when it's ready.`, url: "/staff/", tag: "clean-" + s.roomId }); }
  if (s.customerKey && !s.visitCounted) { await db.doc(`stores/${storeId}/customers/${s.customerKey}`).set({ stays: FieldValue.increment(1) }, { merge: true }); await ref.update({ visitCounted: true }); }
}
/** overstay: past check-out + grace → per started hour at the extension rate (since = check-out, or when the cleaner found the guest inside) */
function overstayCharge(s, cfg, now) {
  if (!cfg.overstay.enabled || !s.checkOut?.toMillis) return null;
  const since = s.checkOut.toMillis(); const end = now;
  if (end <= since + cfg.overstay.graceMin * 60000) return null;
  const hours = Math.ceil((end - since) / 3600000); const rate = Number(cfg.overstay.ratePerHour) || Number(cfg.extension.pricePerHour) || 0;
  if (!rate) return null;
  return { hours, line: { label: `Overstay · ${hours} h past check-out`, amount: round2(hours * rate), kind: "overstay" } };
}

/** the next guest of a room sees whether it's being cleaned / ready (and when) on their booking page */
async function nextGuestRoomState(storeId, roomId, state) {
  try {
    const snap = await db.collection(`stores/${storeId}/stays`).where("roomId", "==", roomId).where("status", "in", ["confirmed", "pending", "unconfirmed"]).get();
    const nx = snap.docs.map((x) => ({ ref: x.ref, ...x.data() })).filter((x) => x.checkIn?.toMillis && x.checkIn.toMillis() > Date.now() - 6 * 3600000).sort((a, b) => a.checkIn.toMillis() - b.checkIn.toMillis())[0];
    if (!nx) return null; await nx.ref.update({ roomState: state }); return { checkIn: nx.checkIn.toMillis(), name: nx.customer?.name || "Guest" };
  } catch (e) { console.warn("roomState", e.message); return null; }
}
/** every 30 min: a guest checks in within 3 h and the room isn't ready → remind the caretaker (or the owner) once */
exports.cleaningReminder = onSchedule({ schedule: "every 30 minutes", timeZone: "Asia/Manila" }, async () => {
  const now = Date.now(); const snap = await db.collectionGroup("stays").where("status", "==", "confirmed").where("checkIn", ">=", admin.firestore.Timestamp.fromMillis(now)).where("checkIn", "<=", admin.firestore.Timestamp.fromMillis(now + 3 * 3600000)).limit(300).get();
  for (const x of snap.docs) {
    const s = x.data(); if (s.cleanReminded) continue; const storeId = x.ref.parent.parent.id;
    const room = (await db.doc(`stores/${storeId}/rooms/${s.roomId}`).get()).data(); const hk = room?.housekeeping?.status;
    if (hk === "to_clean" || hk === "cleaning") { await x.ref.update({ cleanReminded: now }); sendPush(storeId, { roles: ["cleaner", "manager"] }, { title: `⏰ ${s.roomName} not ready yet`, body: `${s.customer?.name || "Next guest"} checks in at ${s.checkIn.toDate().toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit" })}.`, url: "/staff/", tag: "cleanrem-" + x.id }); }
  }
});
// caretaker (staff device): approve / decline / requests / reschedule / extension / payments / check-in / check-out / cleaning
exports.stayStaffAction = onCall(async (req) => {
  const { token } = requireAuth(req);
  const storeId = token.storeId; if (!storeId) throw new HttpsError("permission-denied", "No store.");
  const d = req.data || {}; const now = Date.now(); const by = String(d.staffName || "").slice(0, 40);
  const store = (await db.doc(`stores/${storeId}`).get()).data(); const cfg = stayCfg(store);
  if (d.action === "roomClean" || d.action === "roomCleaning" || d.action === "roomSkip") {
    const rRef = db.doc(`stores/${storeId}/rooms/${String(d.roomId || "")}`); const room = (await rRef.get()).data(); if (!room) throw new HttpsError("not-found", "Room not found.");
    if (d.action === "roomCleaning") { await rRef.set({ housekeeping: { ...(room.housekeeping || {}), status: "cleaning", cleanerName: by, startedAt: now } }, { merge: true }); await nextGuestRoomState(storeId, String(d.roomId), { status: "cleaning", at: now, eta: now + cfg.cleaning.minutes * 60000 }); return { ok: true }; }
    if (d.action === "roomSkip") { // e.g. the guest barely used it / the owner checked it — logged, never blocks bookings
      await rRef.set({ housekeeping: { status: "clean", skipped: true, skipReason: String(d.reason || "").slice(0, 120), cleanerName: by, cleanedAt: now, readyAt: now } }, { merge: true });
      await nextGuestRoomState(storeId, String(d.roomId), { status: "ready", at: now }); return { ok: true };
    }
    await rRef.set({ housekeeping: { status: "clean", cleanerName: by, cleanedAt: now, readyAt: now, startedAt: room.housekeeping?.startedAt || null, minutes: room.housekeeping?.startedAt ? Math.round((now - room.housekeeping.startedAt) / 60000) : null } }, { merge: true });
    await nextGuestRoomState(storeId, String(d.roomId), { status: "ready", at: now });
    notifyTelegram(storeId, "reservation", `✅ ${room.name} is clean — ready since ${new Date(now).toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit" })}${by ? ` (by ${by})` : ""}`);
    if (room.housekeeping?.stayId) await db.doc(`stores/${storeId}/stays/${room.housekeeping.stayId}`).update({ status: "done", cleanedAt: FieldValue.serverTimestamp(), cleanedBy: by }).catch(() => {});
    return { ok: true };
  }
  const ref = db.doc(`stores/${storeId}/stays/${String(d.id || "")}`); const snap = await ref.get(); if (!snap.exists) throw new HttpsError("not-found", "Booking not found.");
  const s = { id: snap.id, ...snap.data() };
  const upd = (patch) => ref.update({ ...patch, updatedAt: FieldValue.serverTimestamp() });
  switch (d.action) {
    case "approve": if (!["unconfirmed", "pending"].includes(s.status)) throw new HttpsError("failed-precondition", "Already handled."); await upd({ status: "confirmed", approvedBy: by, approvedAt: FieldValue.serverTimestamp(), ...(s.needsIdOk ? { needsIdOk: false, idOkBy: by, idOkAt: now } : {}) }); break;
    case "arrived": { // hour package: the clock starts when the guest is in the room (never later than booked start + grace)
      if (!s.short) throw new HttpsError("failed-precondition", "Only for hour packages.");
      const start = Math.min(now, s.checkIn.toMillis() + (cfg.short.graceMin || 0) * 60000); const end = start + s.short.hours * 3600000;
      const clash = (await roomStays(storeId, s.roomId)).find((x) => x.id !== s.id && x.checkIn.toMillis() < end + (s.short.bufMs || 0) && x.checkOut.toMillis() > start);
      if (clash) throw new HttpsError("already-exists", "Starting now would overlap the next booking — start at the booked time instead.");
      await upd({ checkIn: Timestamp.fromMillis(start), checkOut: Timestamp.fromMillis(end), "short.startedAt": start, "short.startedBy": by, ...(s.status !== "checked_in" ? { status: "checked_in", checkedInAt: FieldValue.serverTimestamp(), checkedInBy: by } : {}) });
      await db.doc(`stores/${storeId}/rooms/${s.roomId}`).set({ housekeeping: { status: "occupied", stayId: s.id, since: now } }, { merge: true });
      break;
    }
    case "moveRoom": { // transfer to another room — price follows (upgrade = charge, downgrade = refund)
      const toRef = db.doc(`stores/${storeId}/rooms/${String(d.roomId || "")}`); const to = (await toRef.get()).data();
      if (!to || toRef.id === s.roomId) throw new HttpsError("invalid-argument", "Pick another room.");
      if (to.active === false) throw new HttpsError("failed-precondition", "That room is not active.");
      if (s.guests > (Number(to.capacity) || 20)) throw new HttpsError("failed-precondition", `${to.name} fits only ${to.capacity} guests.`);
      const from = Math.max(now, s.checkIn.toMillis());
      const clash = (await roomStays(storeId, toRef.id)).find((x) => x.checkIn.toMillis() < s.checkOut.toMillis() && x.checkOut.toMillis() > from);
      if (clash) throw new HttpsError("already-exists", `${to.name} is booked during this stay.`);
      let newSub;
      if (s.short) { const p = shortPrice(to, cfg, s.short.hours); if (p == null) throw new HttpsError("failed-precondition", `${to.name} has no ${s.short.hours}-hour price.`); newSub = round2(p); }
      else { const left = (s.nights || []).filter((n) => phAt(n.date, cfg.checkIn).getTime() + 86400000 > now); const done = (s.nights || []).filter((n) => !left.includes(n)); const nn = stayNights(to, cfg, s.checkInYmd, s.checkOutYmd).filter((n) => left.some((l) => l.date === n.date)); newSub = round2(done.reduce((a, n) => a + n.price, 0) + nn.reduce((a, n) => a + n.price, 0)); }
      const diff = round2(newSub - (s.subtotal || 0));
      // the price follows the room: new subtotal (+ that room's notice discount); paid more than the new total → refund the difference
      const nts = (to.notices || []).filter((n) => n && n.label); const nPct = Math.max(0, ...nts.map((n) => Number(n.percent) || 0));
      const noticeDiscount = nts.length ? { labels: nts.map((n) => n.label), percent: nPct, amount: round2(newSub * nPct / 100) } : null;
      const next = { ...s, subtotal: newSub, noticeDiscount };
      const total = stayTotal(next); const over = round2((s.paidAmount || 0) - total);
      const refund = over > 0 ? { amount: over, status: "due", reason: `Moved to ${to.name} (cheaper)`, at: now } : (s.refund?.status === "due" && /Moved to/.test(s.refund.reason || "") ? null : s.refund || null);
      const moves = [...(s.moves || []), { from: s.roomName, to: to.name, diff, by, at: now }];
      await upd({ roomId: toRef.id, roomName: to.name, subtotal: newSub, noticeDiscount, total, refund, moves, inventory: (to.inventory || []).slice(0, 40), roomChange: s.roomChange ? { ...s.roomChange, status: "done" } : null });
      if (s.status === "checked_in") {
        await db.doc(`stores/${storeId}/rooms/${s.roomId}`).set({ housekeeping: { status: "to_clean", stayId: null, since: now, needsCheck: false } }, { merge: true });
        await toRef.set({ housekeeping: { status: "occupied", stayId: s.id, since: now } }, { merge: true });
      }
      break;
    }
    case "roomChangeDecline": await upd({ "roomChange.status": "declined", "roomChange.reply": String(d.reply || "No other room available").slice(0, 120) }); break;
    case "disputeResolve": { // full = return the disputed amount · partial = return d.amount · reject = keep, with a reason
      const dp = s.deposit?.dispute; if (!dp || dp.status !== "open") throw new HttpsError("failed-precondition", "No open dispute.");
      const back = d.decision === "full" ? dp.amount : d.decision === "partial" ? Math.max(0, Math.min(dp.amount, Number(d.amount) || 0)) : 0;
      const reason = String(d.reason || "").slice(0, 300); if (d.decision === "reject" && reason.length < 5) throw new HttpsError("invalid-argument", "Give the guest a reason.");
      const patch = { "deposit.dispute.status": d.decision === "reject" ? "rejected" : "accepted", "deposit.dispute.back": back, "deposit.dispute.reply": reason, "deposit.dispute.by": by, "deposit.dispute.at2": now };
      if (back > 0) { if (s.deposit.status === "released") patch.refund = { amount: round2((s.refund?.status === "due" ? s.refund.amount : 0) + back), status: "due", reason: "Deposit dispute — returned", at: now }; else patch["deposit.refund"] = round2((s.deposit.refund || 0) + back); }
      await upd(patch); break;
    }
    case "refundSent": if (!s.refund) throw new HttpsError("failed-precondition", "No refund."); await upd({ "refund.status": "sent", "refund.method": String(d.method || "gcash").slice(0, 20), "refund.ref": String(d.ref || "").slice(0, 60), "refund.sentAt": now, "refund.by": by }); break;
    case "issueReply": { const issues = (s.issues || []).map((x) => (x.id === d.issueId ? { ...x, status: d.done ? "fixed" : "seen", reply: String(d.reply || "").slice(0, 160), by } : x)); await upd({ issues }); break; }
    case "decline": await upd({ status: "declined", cancelReason: String(d.reason || "Not available").slice(0, 200), declinedBy: by }); break;
    case "cancel": await upd({ status: "cancelled", cancelReason: String(d.reason || "Cancelled").slice(0, 200), cancelledBy: by }); break;
    case "verifyPayment": { const amt = Math.max(0, Number(d.amount) || s.downpayment || 0); await upd({ paidAmount: round2(Math.min(stayTotal(s), (s.paidAmount || 0) + amt)), "payment.status": "verified", payments: FieldValue.arrayUnion({ amount: amt, method: String(d.method || s.payment?.method || "gcash").slice(0, 20), by, at: now }) }); break; }
    case "addPayment": { const amt = Math.max(0, Number(d.amount) || 0); if (!amt) throw new HttpsError("invalid-argument", "Enter an amount."); await upd({ paidAmount: round2((s.paidAmount || 0) + amt), payments: FieldValue.arrayUnion({ amount: amt, method: String(d.method || "cash").slice(0, 20), by, at: now }) }); break; }
    case "request": {
      const reqs = (s.requests || []).map((r) => (r.id === d.requestId ? { ...r, status: d.approve ? "approved" : "declined", reply: String(d.reply || "").slice(0, 200), price: d.approve ? Math.max(0, Number(d.price) || 0) : 0, by } : r));
      const r = reqs.find((x) => x.id === d.requestId); if (!r) throw new HttpsError("not-found", "Request not found.");
      const charges = [...(s.charges || [])]; if (d.approve && r.price) charges.push({ label: `${r.type}: ${r.text}`.slice(0, 80), amount: r.price });
      await upd({ requests: reqs, charges, total: stayTotal({ ...s, charges }) }); break;
    }
    case "reschedule": {
      if (!s.reschedule || s.reschedule.status !== "pending") throw new HttpsError("failed-precondition", "No pending reschedule.");
      if (!d.approve) { await upd({ "reschedule.status": "declined", "reschedule.reply": String(d.reply || "").slice(0, 200) }); break; }
      const room = (await db.doc(`stores/${storeId}/rooms/${s.roomId}`).get()).data();
      const startMs = phAt(s.reschedule.checkIn, cfg.checkIn).getTime(), endMs = phAt(s.reschedule.checkOut, cfg.checkOut).getTime();
      const c = stayConflict(await roomStays(storeId, s.roomId), room, startMs, endMs, s.id, s.reschedule.checkIn, s.reschedule.checkOut); if (c) throw new HttpsError("already-exists", c);
      const nights = stayNights(room, cfg, s.reschedule.checkIn, s.reschedule.checkOut); const subtotal = round2(nights.reduce((a, n) => a + n.price, 0));
      const rch = s.reschedule.fee ? [...(s.charges || []), { label: "Moving date fee", amount: s.reschedule.fee, kind: "resched" }] : (s.charges || []);
      await upd({ charges: rch, reschedCount: (s.reschedCount || 0) + 1, checkIn: Timestamp.fromMillis(startMs), checkOut: Timestamp.fromMillis(endMs), checkInYmd: s.reschedule.checkIn, checkOutYmd: s.reschedule.checkOut, nights, nightsCount: nights.length, subtotal, total: stayTotal({ ...s, subtotal, charges: rch }), "reschedule.status": "approved", "reschedule.by": by, previousDates: { checkIn: s.checkInYmd, checkOut: s.checkOutYmd } });
      break;
    }
    case "extension": {
      if (!s.extension || s.extension.status !== "pending") throw new HttpsError("failed-precondition", "No pending extension.");
      if (!d.approve) { await upd({ "extension.status": "declined", "extension.reason": String(d.reply || "Not available").slice(0, 200) }); break; }
      const newEnd = s.checkOut.toMillis() + s.extension.hours * 3600000;
      const next = (await roomStays(storeId, s.roomId)).find((x) => x.id !== s.id && x.checkIn.toMillis() < newEnd && x.checkIn.toMillis() >= s.checkOut.toMillis() - 60000);
      if (next) { await upd({ "extension.status": "declined", "extension.reason": "The room is booked right after your stay." }); throw new HttpsError("already-exists", "Another booking starts before the extended time — declined."); }
      const charges = [...(s.charges || []), { label: `Extension +${s.extension.hours}h`, amount: s.extension.price || 0 }];
      await upd({ checkOut: Timestamp.fromMillis(newEnd), charges, total: stayTotal({ ...s, charges }), "extension.status": "approved", "extension.by": by });
      break;
    }
    case "checkin": if (!["confirmed", "pending"].includes(s.status)) throw new HttpsError("failed-precondition", "Approve the booking first.");
      if (store.settings?.stay?.payFirst && (s.paidAmount || 0) + 0.01 < stayTotal(s)) throw new HttpsError("failed-precondition", `Pay first is on: the guest still owes ₱${round2(stayTotal(s) - (s.paidAmount || 0)).toLocaleString()}. Record the payment, then check in.`); await upd({ status: "checked_in", checkedInAt: FieldValue.serverTimestamp(), checkedInBy: by }); await db.doc(`stores/${storeId}/rooms/${s.roomId}`).set({ housekeeping: { status: "occupied", stayId: s.id, since: now } }, { merge: true }); break;
    case "checkout": if (s.status !== "checked_in") throw new HttpsError("failed-precondition", "Guest is not checked in."); await stayCheckedOut(storeId, ref, s, cfg, by, now); break;
    case "addon": {
      const addons = (s.addons || []).map((x) => (x.id === d.addonId ? { ...x, status: d.approve ? "approved" : "declined", reply: String(d.reply || "").slice(0, 120) } : x));
      await upd({ addons, total: stayTotal({ ...s, addons }) }); break;
    }
    case "depositPaid": if (!s.deposit?.amount) throw new HttpsError("failed-precondition", "No deposit on this booking.");
      await upd({ "deposit.status": s.status === "checked_out" ? "checking" : "held", "deposit.statusBefore": "held", "deposit.receivedBy": by, "deposit.receivedAt": now, "deposit.method": String(d.method || s.deposit.payment?.methodName || "cash").slice(0, 20) }); break;
    case "depositReject": await upd({ "deposit.status": "rejected", "deposit.reason": String(d.reason || "Payment not found").slice(0, 120) }); break;
    case "roomCheck": { // cleaner counts the items and notes stains / damage with photos → deposit deductions
      if (!s.deposit && !(s.inventory || []).length && !(d.deductions || []).length) { await upd({ roomCheck: { at: now, by, ok: true } }); break; }
      const lines = [];
      for (const it of (s.inventory || [])) { const got = Math.max(0, parseInt(d.counts?.[it.name], 10)); const miss = Number.isFinite(got) ? Math.max(0, (Number(it.qty) || 0) - got) : 0; if (miss) lines.push({ label: `Missing: ${it.name} × ${miss}`, amount: round2(miss * (Number(it.price) || 0)), photo: null }); }
      for (const x of (d.deductions || []).slice(0, 12)) { const amt = Math.max(0, Number(x.amount) || 0); const label = String(x.label || "").trim().slice(0, 80); if (!label) continue; const photo = String(x.photo || ""); if (photo && !photo.startsWith(`priv:stores/${storeId}/private/`)) throw new HttpsError("invalid-argument", "Bad photo."); lines.push({ label, amount: amt, photo: photo || null }); }
      // unpaid overstay comes out of the deposit too
      const overstay = (s.charges || []).filter((c) => c.kind === "overstay").reduce((a, c) => a + c.amount, 0);
      const unpaid = Math.max(0, round2(stayTotal(s) - (s.paidAmount || 0)));
      if (overstay && unpaid > 0 && s.deposit) lines.push({ label: "Overstay (unpaid)", amount: round2(Math.min(overstay, unpaid)), photo: null, kind: "overstay" });
      const ded = round2(lines.reduce((a, l) => a + l.amount, 0));
      const amount = s.deposit?.amount || 0;
      const fromDeposit = Math.min(amount, ded);
      await upd({ roomCheck: { at: now, by, lines, ok: !lines.length }, ...(s.deposit ? { "deposit.status": "checked", "deposit.deductions": lines, "deposit.refund": round2(Math.max(0, amount - fromDeposit)), "deposit.owed": round2(Math.max(0, ded - amount)), "deposit.checkedAt": now, "deposit.checkedBy": by } : {}) });
      await db.doc(`stores/${storeId}/rooms/${s.roomId}`).set({ housekeeping: { needsCheck: false } }, { merge: true });
      notifyTelegram(storeId, "reservation", `🔍 Room checked · ${s.roomName} (${s.code}) · ${lines.length ? lines.map((l) => `${l.label} ₱${l.amount}`).join(", ") : "no issues"}${s.deposit ? ` · return ₱${round2(Math.max(0, amount - fromDeposit))}` : ""}`);
      break;
    }
    case "depositReleased": if (!s.deposit) throw new HttpsError("failed-precondition", "No deposit."); await upd({ "deposit.status": "released", "deposit.releasedAt": now, "deposit.releasedBy": by, "deposit.releaseMethod": String(d.method || "cash").slice(0, 20), "deposit.releaseRef": String(d.ref || "").slice(0, 60) }); break;
    case "stillInside": { // cleaner found the guest still in the room after they tapped "checked out" → overstay counts again
      if (s.status !== "checked_out") throw new HttpsError("failed-precondition", "Only after a check-out.");
      await upd({ status: "checked_in", stillInsideAt: now, stillInsideBy: by, ...(s.deposit ? { "deposit.status": s.deposit.statusBefore || "held" } : {}), overstay: { ...(s.overstay || {}), final: false, foundInside: now } });
      await db.doc(`stores/${storeId}/rooms/${s.roomId}`).set({ housekeeping: { status: "occupied", stayId: s.id, since: now } }, { merge: true });
      notifyTelegram(storeId, "incident", `⚠️ ${s.roomName}: guest ${s.customer?.name || ""} tapped "checked out" but is still inside (${by}). Overstay is counting.`, { force: true });
      break;
    }
    default: throw new HttpsError("invalid-argument", "Unknown action.");
  }
  return { ok: true };
});

// overstay (past check-out + grace) → hourly charge, caretaker alerted (urgent if the next guest is coming);
// room check not done by the deadline → deposit is returned in full (protects the guest)
exports.stayTick = onSchedule({ schedule: "every 10 minutes", timeZone: "Asia/Manila" }, async () => {
  const now = Date.now(); const cfgs = new Map();
  const cfgOf = async (storeId) => { if (!cfgs.has(storeId)) cfgs.set(storeId, stayCfg((await db.doc(`stores/${storeId}`).get()).data() || {})); return cfgs.get(storeId); };
  for (const x of (await db.collectionGroup("stays").where("status", "==", "checked_in").get()).docs) {
    const s = { id: x.id, ...x.data() }; const storeId = x.ref.parent.parent.id; const cfg = await cfgOf(storeId);
    const ov = overstayCharge(s, cfg, now); if (!ov || s.overstay?.hours === ov.hours) continue;
    const charges = [...(s.charges || []).filter((c) => c.kind !== "overstay"), ov.line];
    await x.ref.update({ charges, total: stayTotal({ ...s, charges }), overstay: { ...(s.overstay || {}), hours: ov.hours, amount: ov.line.amount, since: s.checkOut.toMillis() }, updatedAt: FieldValue.serverTimestamp() });
    const next = (await roomStays(storeId, s.roomId)).filter((y) => y.id !== s.id && y.checkIn.toMillis() > s.checkOut.toMillis() - 60000).sort((a, b) => a.checkIn.toMillis() - b.checkIn.toMillis())[0];
    const soon = next && next.checkIn.toMillis() - now < 3 * 3600000;
    if (ov.hours === 1 || soon) notifyTelegram(storeId, soon ? "incident" : "reservation", `⏰ ${s.roomName}: ${s.customer?.name || "guest"} is ${ov.hours} h past check-out (₱${ov.line.amount} overstay).${soon ? ` NEXT GUEST at ${new Date(next.checkIn.toMillis()).toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit" })} — please call them now.` : ""}`, soon ? { force: true } : {});
  }
  for (const x of (await db.collectionGroup("stays").where("deposit.status", "==", "checking").get()).docs) {
    const s = x.data(); if (!s.deposit?.checkBy || s.deposit.checkBy > now) continue;
    await x.ref.update({ "deposit.status": "checked", "deposit.deductions": [], "deposit.refund": s.deposit.amount, "deposit.autoNoIssues": true, "deposit.checkedAt": now, updatedAt: FieldValue.serverTimestamp() });
    notifyTelegram(x.ref.parent.parent.id, "reservation", `🔐 ${s.roomName} (${s.code}): room wasn't checked in time — return the full ₱${s.deposit.amount} deposit.`);
  }
});
// ===== iCal sync with Airbnb.com / Booking.com =====
// export: every room has a private .ics feed (paste it in Airbnb → Availability → Sync calendars → Import)
// import: paste their export link in Rooms → we read it every 20 minutes and block those dates here
const icsDate = (ms) => phYmd(ms).replace(/-/g, "");
function parseIcs(text) {
  const out = []; const unfold = String(text || "").replace(/\r?\n[ \t]/g, "");
  for (const blk of unfold.split("BEGIN:VEVENT").slice(1)) {
    const get = (k) => { const m = blk.match(new RegExp("^" + k + "(;[^:\\r\\n]*)?:([^\\r\\n]*)", "m")); return m ? { p: m[1] || "", v: m[2].trim() } : null; };
    const toMs = (x) => { if (!x) return null; const v = x.v; if (/^\d{8}$/.test(v)) return phAt(`${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`, "00:00").getTime(); const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/); if (!m) return null; const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ? "Z" : "+08:00"}`; return new Date(iso).getTime(); };
    const st = toMs(get("DTSTART")); let en = toMs(get("DTEND")); if (!st) continue; if (!en || en <= st) en = st + 86400000;
    const st0 = get("STATUS"); if (st0 && /CANCELLED/i.test(st0.v)) continue;
    out.push({ start: st, end: en, uid: (get("UID") || {}).v || "", summary: ((get("SUMMARY") || {}).v || "").slice(0, 60) });
  }
  return out;
}
async function icalImportRoom(storeId, rRef, room) {
  const now = Date.now(); const blocks = []; const status = [];
  for (const src of (room.icalImports || []).slice(0, 4)) {
    const url = String(src.url || ""); if (!/^https:\/\//.test(url)) continue;
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
      const res = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": "TapTayo-iCal/1.0" } }); clearTimeout(t);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const evs = parseIcs(await res.text()).filter((e) => e.end > now - 86400000 && e.start < now + 400 * 86400000);
      evs.forEach((e) => blocks.push({ ...e, source: String(src.name || "Other site").slice(0, 30) }));
      status.push({ name: src.name || "", ok: true, events: evs.length, at: now });
    } catch (e) { status.push({ name: src.name || "", ok: false, error: String(e.message || e).slice(0, 80), at: now }); }
  }
  // stays here that overlap a booking made on the other site → double booking alert (once per pair)
  const stays = await roomStays(storeId, rRef.id); const seen = new Set(room.icalAlerted || []); const alerts = [];
  for (const s of stays) for (const b of blocks) { const key = `${s.id}:${b.uid || b.start}`; if (!seen.has(key) && s.checkIn.toMillis() < b.end && s.checkOut.toMillis() > b.start) { seen.add(key); alerts.push(`${s.code} (${s.customer?.name || ""}) vs ${b.source} ${phYmd(b.start)}`); } }
  await rRef.set({ icalBlocks: blocks.slice(0, 300), icalStatus: status, icalSyncedAt: now, icalAlerted: [...seen].slice(-200) }, { merge: true });
  if (alerts.length) notifyTelegram(storeId, "incident", `⚠️ DOUBLE BOOKING · ${room.name}: ${alerts.join("; ")}. Fix it now — move one guest to another room or cancel on the other site.`, { force: true });
  return { status, blocks: blocks.length, conflicts: alerts.length };
}
exports.icalTick = onSchedule({ schedule: "every 20 minutes", timeZone: "Asia/Manila", memory: "512MiB" }, async () => {
  const snap = await db.collectionGroup("rooms").where("icalOn", "==", true).get();
  for (const d of snap.docs) { if (d.ref.parent.parent.parent.id !== "stores") continue; await icalImportRoom(d.ref.parent.parent.id, d.ref, d.data()).catch(() => {}); }
});
exports.icalSyncNow = onCall(async (req) => {
  const { token } = requireAuth(req); const storeId = token.storeId; if (!storeId || !["owner", "device"].includes(token.role)) throw new HttpsError("permission-denied", "Owner only.");
  const rRef = db.doc(`stores/${storeId}/rooms/${String(req.data?.roomId || "")}`); const room = (await rRef.get()).data(); if (!room) throw new HttpsError("not-found", "Room not found.");
  const patch = { icalOn: (room.icalImports || []).length > 0 }; if (!room.icalToken) patch.icalToken = crypto.randomBytes(12).toString("hex");
  await rRef.set(patch, { merge: true });
  const r = patch.icalOn ? await icalImportRoom(storeId, rRef, { ...room, ...patch }) : { status: [], blocks: 0, conflicts: 0 };
  return { ...r, token: patch.icalToken || room.icalToken };
});
exports.ical = onRequest({ cors: false }, async (req, res) => {
  const m = String(req.path || "").match(/^\/?([^/]+)\/([^/]+)\/([a-f0-9]{24})(\.ics)?$/);
  if (!m) { res.status(404).send("Not found"); return; }
  const [, storeId, roomId, tok] = m;
  const room = (await db.doc(`stores/${storeId}/rooms/${roomId}`).get()).data();
  if (!room || room.icalToken !== tok) { res.status(404).send("Not found"); return; }
  const cfg = stayCfg((await db.doc(`stores/${storeId}`).get()).data() || {});
  const stays = (await roomStays(storeId, roomId)).filter((s) => cfg.ical.exportShort || !s.short);
  const L = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//TapTayo//Stay//EN", "CALSCALE:GREGORIAN", `X-WR-CALNAME:${String(room.name || "Room").replace(/[,;\n]/g, " ")} (TapTayo)`];
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  for (const s of stays) { const a = s.checkIn.toMillis(), b = s.checkOut.toMillis(); const endDay = s.short ? icsDate(a + 86400000) : icsDate(b); L.push("BEGIN:VEVENT", `UID:${s.id}@taptayo`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${icsDate(a)}`, `DTEND;VALUE=DATE:${endDay === icsDate(a) ? icsDate(a + 86400000) : endDay}`, "SUMMARY:Booked (TapTayo)", "END:VEVENT"); }
  for (const d of (room.blocked || [])) L.push("BEGIN:VEVENT", `UID:block-${d}@taptayo`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${d.replace(/-/g, "")}`, `DTEND;VALUE=DATE:${ymdAdd(d, 1).replace(/-/g, "")}`, "SUMMARY:Not available", "END:VEVENT");
  L.push("END:VCALENDAR");
  res.set("Content-Type", "text/calendar; charset=utf-8").set("Cache-Control", "private, max-age=300").send(L.join("\r\n"));
});
exports.cancelUnconfirmedStays = onSchedule({ schedule: "every 5 minutes", timeZone: "Asia/Manila" }, async () => {
  const snap = await db.collectionGroup("stays").where("status", "==", "unconfirmed").get();
  const now = Date.now();
  for (const d of snap.docs) { const dl = d.data().confirmDeadline?.toMillis?.(); if (dl && dl < now) await d.ref.update({ status: "cancelled", cancelReason: "Not confirmed on Messenger in time", updatedAt: FieldValue.serverTimestamp() }); }
});
exports.syncRooms = onDocumentWritten("stores/{storeId}/rooms/{id}", async (event) => {
  const b = event.data?.before?.data(), a = event.data?.after?.data();
  // housekeeping-only changes don't need a public rebuild
  const strip = (x) => { if (!x) return x; const { housekeeping, updatedAt, icalBlocks, icalStatus, icalSyncedAt, icalAlerted, ...rest } = x; return JSON.stringify(rest); };
  if (strip(b) === strip(a)) return;
  await rebuildPublicStore(event.params.storeId);
});
