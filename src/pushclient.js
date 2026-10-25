// Staff phone notifications (works with the app closed) + number on the app icon.
// Android Chrome: works in the browser or installed. iPhone: only after "Add to Home Screen" (iOS 16.4+).
import { call } from "./firebase.js";
import { getActiveStaff } from "./staffauth.js";

const KEY = "tt:push:on";
const b64ToBytes = (s) => { const p = "=".repeat((4 - (s.length % 4)) % 4); const raw = atob((s + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(raw, (c) => c.charCodeAt(0)); };
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

export const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
export const pushState = () => !pushSupported() ? (isIOS() && !standalone() ? "ios-install" : "unsupported") : Notification.permission === "denied" ? "blocked" : Notification.permission === "granted" && localStorage.getItem(KEY) ? "on" : "off";

export async function enablePush(storeId, app, { test = true } = {}) {
  if (!pushSupported()) throw new Error(isIOS() && !standalone() ? "On iPhone: tap Share → Add to Home Screen, open the app from the icon, then turn on notifications." : "This browser can't receive notifications.");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notifications are blocked. Allow them in your phone's settings for this site/app.");
  const reg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const { data } = await call("pushKey", {});
  let sub = await reg.pushManager.getSubscription();
  if (sub && sub.options?.applicationServerKey) {
    const cur = new Uint8Array(sub.options.applicationServerKey); const want = b64ToBytes(data.publicKey);
    if (cur.length !== want.length || cur.some((v, i) => v !== want[i])) { await sub.unsubscribe(); sub = null; }
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(data.publicKey) });
  await call("pushSubscribe", { sub: sub.toJSON(), app, test, staffToken: getActiveStaff(storeId)?.token || null });
  try { localStorage.setItem(KEY, "1"); } catch {}
  return true;
}
/** re-register silently (new PIN user on this phone, or the subscription changed) */
export async function refreshPush(storeId, app) {
  if (pushState() !== "on") return;
  try { await enablePush(storeId, app, { test: false }); } catch {}
}
/** small "🔔 Notifications" button for a staff app header */
export function pushButton(storeId, app) {
  const b = document.createElement("button");
  b.className = "k-btn sm"; b.type = "button";
  const paint = () => { const s = pushState(); b.textContent = s === "on" ? "🔔" : "🔕 Alerts"; b.title = s === "on" ? "Notifications are on" : "Get new jobs and alerts even when the app is closed"; };
  paint();
  b.onclick = async () => {
    if (pushState() === "on") { alert("Notifications are on for this phone. To turn them off, use your phone's notification settings."); return; }
    b.disabled = true;
    try { await enablePush(storeId, app); paint(); } catch (e) { alert(e.message); } finally { b.disabled = false; }
  };
  return b;
}
/** number on the installed app icon (Android / iOS home-screen app / desktop) */
export function setBadge(n) {
  try { if (n > 0) navigator.setAppBadge?.(n); else navigator.clearAppBadge?.(); } catch {}
}
