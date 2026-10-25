// "New version available" — every app checks /version.json when it comes back to the screen (and every 15 min).
// Updating = reload; the installed app never needs to be reinstalled.
import { APP_VERSION } from "./version.js";

let shown = false, lastCheck = 0;
export async function checkForUpdate({ manual = false } = {}) {
  if (Date.now() - lastCheck < 30000 && !manual) return null;
  lastCheck = Date.now();
  try {
    const r = await fetch("/version.json", { cache: "no-store" });
    if (!r.ok) return null;
    const { v } = await r.json();
    const newer = v && v !== APP_VERSION && v !== "dev";
    if (newer) showBanner(v); else if (manual) toastLite("You're on the latest version ✓");
    return { current: APP_VERSION, latest: v, newer };
  } catch { if (manual) toastLite("Couldn't check — are you online?"); return null; }
}
export async function applyUpdate() {
  try { const reg = await navigator.serviceWorker?.getRegistration(); await reg?.update(); } catch {}
  location.reload();
}
function showBanner(v) {
  if (shown || document.getElementById("ttUpdate")) return; shown = true;
  const el = document.createElement("div"); el.id = "ttUpdate";
  el.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:calc(86px + env(safe-area-inset-bottom));z-index:95;background:#111;color:#fff;border-radius:14px;padding:10px 12px 10px 16px;display:flex;gap:12px;align-items:center;font:500 14px Poppins,system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25);max-width:calc(100vw - 24px)";
  el.innerHTML = `<span>✨ New version of TapTayo is ready</span><button type="button" style="font:600 14px Poppins,system-ui,sans-serif;height:36px;padding:0 14px;border:0;border-radius:10px;background:#C62828;color:#fff;cursor:pointer">Update</button><button type="button" aria-label="Later" style="background:none;border:0;color:#bbb;font-size:18px;cursor:pointer">✕</button>`;
  el.querySelector("button").onclick = applyUpdate;
  el.querySelectorAll("button")[1].onclick = () => el.remove();
  document.body.appendChild(el);
}
function toastLite(t) { const n = document.createElement("div"); n.textContent = t; n.style.cssText = "position:fixed;left:50%;bottom:100px;transform:translateX(-50%);background:#111;color:#fff;padding:10px 16px;border-radius:12px;z-index:96;font:500 14px Poppins,system-ui,sans-serif"; document.body.appendChild(n); setTimeout(() => n.remove(), 2400); }

document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkForUpdate(); });
setInterval(() => { if (document.visibilityState === "visible") checkForUpdate(); }, 15 * 60000);
setTimeout(checkForUpdate, 8000);
export { APP_VERSION };
