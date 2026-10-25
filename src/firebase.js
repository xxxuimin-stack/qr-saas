// Single Firebase init for all pages (login, dashboard, customer menu, kitchen)
import { initializeApp } from "firebase/app";
import { getAuth, initializeAuth, inMemoryPersistence, browserPopupRedirectResolver, GoogleAuthProvider, connectAuthEmulator } from "firebase/auth";
import { getFirestore, initializeFirestore, persistentLocalCache, persistentMultipleTabManager, connectFirestoreEmulator } from "firebase/firestore";
import { getFunctions, httpsCallable, connectFunctionsEmulator } from "firebase/functions";
import { getStorage, connectStorageEmulator } from "firebase/storage";

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
export const storage = getStorage(app);
export const googleProvider = new GoogleAuthProvider();

// EMULATOR MODE: when VITE_USE_EMULATOR=true in .env, connect to the local emulators
// (firebase emulators:start) instead of real Firebase. Free, no Blaze plan needed.
if (env.VITE_USE_EMULATOR === "true") {
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
  connectFunctionsEmulator(functions, "127.0.0.1", 5001);
  connectStorageEmulator(storage, "127.0.0.1", 9199);
  console.info("%c[EMULATOR MODE] connected to local Firebase emulators", "color:#b57a12;font-weight:bold");
}

/** Shortcut for calling a callable Cloud Function: await call("createStore", {...}) */
const DEMO_OK = new Set(["demoViewer", "getAvailability", "queueBoard", "getSlots", "creatorDirectory", "myCreatorOffers", "collabMine", "collabList", "collabStatus", "swapMine", "swapDirectory"]);
export async function call(name, data, { timeout } = {}) {
  if (DEMO_VIEW && !DEMO_OK.has(name)) throw new Error(DEMO_MSG);
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
