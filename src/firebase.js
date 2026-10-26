// Single Firebase init for all pages (login, dashboard, customer menu, kitchen)
import { initializeApp } from "firebase/app";
import { getAuth, initializeAuth, inMemoryPersistence, browserPopupRedirectResolver, GoogleAuthProvider, FacebookAuthProvider, connectAuthEmulator } from "firebase/auth";
import { getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager, connectFirestoreEmulator } from "firebase/firestore";
import { getFunctions, httpsCallable, connectFunctionsEmulator } from "firebase/functions";

const env = import.meta.env;

const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID,
};

if (!firebaseConfig.apiKey) {
  console.error(
    "Missing Firebase config. Copy .env.example -> .env and fill in the values from the Firebase Console."
  );
}

// Read-only owner demo (/app/?demo=taptayo-spa): its own Firebase app with an in-memory login,
// so it never touches the visitor's real TapTayo login in this browser.
export const DEMO_VIEW = (() => { try { const q = new URLSearchParams(location.search).get("demo"); return /^\/(app|counter|kitchen|staff|rider)(\/|$)/.test(location.pathname) && /^taptayo-[a-z]+$/.test(q || "") ? q : null; } catch { return null; } })();
export const DEMO_MSG = "This is a read-only demo — create a free account to try it on your own shop.";
export const app = initializeApp(firebaseConfig, DEMO_VIEW ? "demo-viewer" : undefined);
export const auth = DEMO_VIEW ? initializeAuth(app, { persistence: inMemoryPersistence, popupRedirectResolver: browserPopupRedirectResolver }) : getAuth(app);
// Offline cache (IndexedDB): reopening the app shows the last data instantly, then updates live.
function makeDb() {
  if (env.VITE_USE_EMULATOR === "true" || DEMO_VIEW) return getFirestore(app);
  try { return initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
  catch { return getFirestore(app); }
}
export const db = makeDb();
export const functions = getFunctions(app, env.VITE_FUNCTIONS_REGION || "asia-southeast1");
export const googleProvider = new GoogleAuthProvider();
export const facebookProvider = new FacebookAuthProvider();
facebookProvider.addScope("email");

// EMULATOR MODE: when VITE_USE_EMULATOR=true in .env, connect to the local emulators
// (firebase emulators:start) instead of real Firebase. Free, no Blaze plan needed.
if (env.VITE_USE_EMULATOR === "true") {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  console.info("%c[EMULATOR MODE] connected to local Firebase emulators", "color:#b57a12;font-weight:bold");
}

/** Shortcut for calling a callable Cloud Function: await call("createStore", {...}) */
const DEMO_OK = new Set(["demoViewer", "getAvailability", "queueBoard", "getSlots", "creatorDirectory", "myCreatorOffers", "collabMine", "collabList", "collabStatus", "swapMine", "swapDirectory"]);
export async function call(name, data, { timeout } = {}) {
  if (DEMO_VIEW && !DEMO_OK.has(name)) throw new Error(DEMO_MSG);
  if (BOT_CHECKED.has(name) && env.VITE_TURNSTILE_SITEKEY) { const cf = await turnstileToken(); if (cf) data = { ...(data || {}), cf }; }
  const fn = httpsCallable(functions, name, timeout ? { timeout } : undefined);
  try { const res = await fn(data); return res.data; }
  catch (e) {
    // moving-date fee: ask once, then retry with acceptFee
    const fm = /^FEE:([\d.]+):(.*)$/.exec(String(e?.message || ""));
    if (fm && !data?.acceptFee) { if (typeof window !== "undefined" && window.confirm(fm[2])) return call(name, { ...data, acceptFee: true }, { timeout }); throw new Error("Reschedule cancelled — nothing was changed."); }
    // weak signal: say clearly that nothing was saved, so staff tap again instead of assuming it went through
    const code = String(e?.code || "");
    if ((typeof navigator !== "undefined" && navigator.onLine === false) || /unavailable|deadline-exceeded/.test(code) || (/internal/.test(code) && /fetch|network|Failed/i.test(String(e?.message || "")))) {
      if (!/right back/i.test(String(e?.message || ""))) { const x = new Error("📶 Not sent — weak or no signal. Nothing was saved. Please try again."); x.code = "offline"; throw x; }
    }
    throw e;
  }
}


// 🛡 Cloudflare Turnstile — an invisible "not a bot" check on the few actions bots abuse (orders, bookings, reports, signup codes).
// Real customers see nothing. Off until VITE_TURNSTILE_SITEKEY is set in .env. A failed or slow check never blocks here — the server decides.
const BOT_CHECKED = new Set(["placeOrder", "bookAppointment", "bookStay", "createReservation", "bookLaundryJob", "reportShop", "partnerInquiry", "inquirySend", "sendSignupOtp", "buyGiftCard"]);
let tsReady = null, tsWidget = null;
function loadTurnstile() {
  if (tsReady) return tsReady;
  tsReady = new Promise((resolve) => {
    if (window.turnstile) return resolve(window.turnstile);
    const sc = document.createElement("script"); sc.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"; sc.async = true; sc.defer = true;
    sc.onload = () => resolve(window.turnstile || null); sc.onerror = () => resolve(null); document.head.appendChild(sc);
    setTimeout(() => resolve(window.turnstile || null), 8000);
  });
  return tsReady;
}
async function turnstileToken() {
  try {
    const ts = await loadTurnstile(); if (!ts) return null;
    let host = document.getElementById("ttTurnstile");
    if (!host) { host = document.createElement("div"); host.id = "ttTurnstile"; host.style.cssText = "position:fixed;bottom:12px;left:50%;transform:translateX(-50%);z-index:99999"; document.body.appendChild(host); }
    return await new Promise((resolve) => {
      const done = (t) => { clearTimeout(timer); resolve(t || null); };
      const timer = setTimeout(() => done(null), 9000);
      if (tsWidget !== null) { try { ts.remove(tsWidget); } catch {} }
      // "interaction-only": shows a checkbox ONLY when Cloudflare is unsure (rare for real people)
      tsWidget = ts.render(host, { sitekey: env.VITE_TURNSTILE_SITEKEY, appearance: "interaction-only", callback: done, "error-callback": () => done(null), "timeout-callback": () => done(null) });
    });
  } catch { return null; }
}

// 🐞 send real browser errors to TapTayo (a few per page, duplicates and browser-extension noise skipped)
if (typeof window !== "undefined" && !env.DEV) {
  const sent = new Set(); let n = 0;
  const send = (message, stack) => {
    const m = String(message || "").slice(0, 300); if (!m || sent.has(m) || n >= 5) return;
    if (/ResizeObserver loop|Script error|chrome-extension:|moz-extension:|Failed to fetch|NetworkError|Load failed|popup-closed|cancelled-popup/i.test(m + " " + (stack || ""))) return;
    sent.add(m); n++;
    setTimeout(() => { httpsCallable(functions, "logClientError")({ message: m, stack: String(stack || "").slice(0, 1500), url: location.pathname + location.search, page: location.pathname.split("/")[1] || "home" }).catch(() => {}); }, 0);
  };
  window.addEventListener("error", (e) => send(e.message, e.error?.stack));
  // server "no" answers (sold out, too many tries, login needed…) are normal, not bugs — only report unexpected ones
  window.addEventListener("unhandledrejection", (e) => { const c = String(e.reason?.code || ""); if ((c.startsWith("functions/") && c !== "functions/internal") || c === "offline" || c.startsWith("auth/")) return; send(e.reason?.message || e.reason, e.reason?.stack); });
}
