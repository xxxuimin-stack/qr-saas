// Loaded as a plain script (not bundled) so it keeps working even if the page's app code fails.
// <script src="/pwa.js" data-label="TapTayo Counter" defer></script>
(function () {
// Install TapTayo as an app (PWA): registers the service worker, shows a small "Install app" bar
// on phones, and wires any element with [data-install] (e.g. the sidebar link) to the install prompt.
// Android/Chrome: real install prompt. iPhone/iPad Safari: short "Share → Add to Home Screen" guide.
const DISMISS_KEY = "tt:install:dismissed";
const SNOOZE_DAYS = 14;
let deferred = null;

const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isPhone = () => matchMedia("(pointer: coarse)").matches;
const snoozed = () => { try { return Date.now() - Number(localStorage.getItem(DISMISS_KEY) || 0) < SNOOZE_DAYS * 864e5; } catch { return false; } };
const snooze = () => { try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch {} };

const canInstall = () => !isStandalone() && (!!deferred || isIOS());

async function installApp() {
  if (deferred) {
    const e = deferred; deferred = null;
    e.prompt();
    const r = await e.userChoice.catch(() => ({ outcome: "dismissed" }));
    hideBar(); syncButtons();
    return r.outcome === "accepted";
  }
  if (isIOS()) iosGuide();
  return false;
}

const ICON = `<img src="/icons/icon-192.png" width="40" height="40" alt="" style="border-radius:10px;flex:none">`;
const BAR_CSS = "position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:9999;display:flex;align-items:center;gap:12px;padding:12px 12px 12px 14px;background:#fff;color:#141414;border:1px solid #ECE5D8;border-radius:16px;box-shadow:0 10px 30px rgba(20,20,20,.14);font:500 14px/1.35 Poppins,system-ui,sans-serif;max-width:520px;margin:0 auto";
const BTN = "font:600 14px Poppins,system-ui,sans-serif;height:40px;padding:0 16px;border:0;border-radius:12px;background:#C62828;color:#fff;cursor:pointer;flex:none";
const X = "font:inherit;width:36px;height:36px;border:0;background:none;color:#8A847C;cursor:pointer;flex:none;font-size:20px;line-height:1";

function showBar(label) {
  if (document.getElementById("ttInstall") || snoozed() || !isPhone()) return;
  const el = document.createElement("div");
  el.id = "ttInstall"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "Install app");
  el.style.cssText = BAR_CSS;
  el.innerHTML = `${ICON}<div style="flex:1;min-width:0"><b style="font-weight:600;display:block">Install ${label}</b><span style="color:#57534E;font-size:13px">Opens full screen from your home screen.</span></div><button type="button" data-go style="${BTN}">Install</button><button type="button" data-x aria-label="Not now" style="${X}">×</button>`;
  el.querySelector("[data-go]").onclick = () => installApp();
  el.querySelector("[data-x]").onclick = () => { snooze(); hideBar(); };
  document.body.appendChild(el);
}
function hideBar() { document.getElementById("ttInstall")?.remove(); }

function iosGuide() {
  hideBar();
  const shareIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#1D4ED8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px"><path d="M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>`;
  const el = document.createElement("div");
  el.id = "ttInstall"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "Add to Home Screen");
  el.style.cssText = BAR_CSS + ";align-items:flex-start";
  el.innerHTML = `${ICON}<div style="flex:1"><b style="font-weight:600;display:block;margin-bottom:4px">Add to Home Screen</b><span style="color:#57534E;font-size:13px">1. Tap ${shareIcon} <b>Share</b> in Safari's toolbar<br>2. Choose <b>Add to Home Screen</b></span></div><button type="button" data-x aria-label="Close" style="${X}">×</button>`;
  el.querySelector("[data-x]").onclick = () => { snooze(); hideBar(); };
  document.body.appendChild(el);
}

function syncButtons() {
  const ok = canInstall();
  document.querySelectorAll("[data-install]").forEach((b) => {
    b.hidden = !ok;
    if (!b.dataset.wired) { b.dataset.wired = "1"; b.addEventListener("click", (e) => { e.preventDefault(); installApp(); }); }
  });
}

function initPWA({ label = "TapTayo", bar = true } = {}) {
  if ("serviceWorker" in navigator && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) navigator.serviceWorker.register("/sw.js").catch(() => {});
  const ready = () => {
    syncButtons();
    if (isStandalone()) return;
    if (bar && isIOS() && !snoozed()) setTimeout(() => showBar(label), 5000);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready); else ready();
  addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferred = e; syncButtons(); if (bar) showBar(label); });
  addEventListener("appinstalled", () => { deferred = null; hideBar(); syncButtons(); });
}

  const me = document.currentScript;
  initPWA({ label: (me && me.dataset.label) || "TapTayo" });
  window.ttInstallApp = installApp;
})();
