// Device login for shared tablets.
// A tablet signs in as a "device" account (role: device) that can open the staff screens but never the
// owner dashboard. The device keeps a secret in localStorage so it can sign itself back in.
import { auth, call, DEMO_VIEW } from "./firebase.js";
import { signInWithCustomToken, signOut } from "firebase/auth";

const KEY = "taptayo:device";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function savedDevice() { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; } }
export function forgetDevice() { localStorage.removeItem(KEY); }
export const isDeviceClaims = (claims) => claims?.role === "device";

function remember(r) { localStorage.setItem(KEY, JSON.stringify({ deviceId: r.deviceId, secret: r.secret, name: r.name, storeId: null, at: Date.now() })); }

/** Sign this tablet in with its saved device secret. Returns true when signed in. */
export async function deviceSignIn() {
  // demo: every staff screen opens read-only on this phone (no device code, no PIN)
  if (DEMO_VIEW) { try { const r = await call("demoViewer", { slug: DEMO_VIEW }); await signInWithCustomToken(auth, r.token); return true; } catch { return false; } }
  const d = savedDevice();
  if (!d) return false;
  try {
    const r = await call("deviceSignIn", { deviceId: d.deviceId, secret: d.secret });
    await signInWithCustomToken(auth, r.customToken);
    return true;
  } catch (e) {
    if (/removed|permission|not-found/i.test(e.message)) forgetDevice();
    return false;
  }
}

/** Owner is signed in on this tablet → turn it into a device login (signs the owner out here). */
export async function switchToDevice(name) {
  const r = await call("setupThisDevice", { name });
  remember(r);
  await signOut(auth);
  await signInWithCustomToken(auth, r.customToken);
  location.reload();
}

/** Redeem a 6-digit code typed on the tablet. */
export async function redeemCode(code, name) {
  const r = await call("redeemDeviceCode", { code, name });
  remember(r);
  await signInWithCustomToken(auth, r.customToken);
}

const CSS = `
.dv-wrap{position:fixed;inset:0;background:#F5F6F8;display:flex;align-items:center;justify-content:center;padding:20px;z-index:50;font-family:Poppins,system-ui,sans-serif;color:#111}
.dv-box{width:100%;max-width:380px;background:#fff;border:1px solid #E5E7EB;border-radius:20px;padding:24px;text-align:center}
.dv-box h1{font-size:20px;font-weight:700;margin:12px 0 4px}.dv-box p{font-size:14px;color:#6B7280;margin:0 0 14px;line-height:1.45}
.dv-code{font:600 28px/1 Poppins,system-ui,sans-serif;letter-spacing:.3em;text-align:center;width:100%;height:60px;border:1.5px solid #D1D5DB;border-radius:14px;padding:0 0 0 .3em}
.dv-name{font:inherit;width:100%;height:44px;border:1px solid #D1D5DB;border-radius:12px;padding:0 12px;margin-top:10px}
.dv-btn{font:600 15px Poppins,system-ui,sans-serif;width:100%;height:48px;border:0;border-radius:12px;background:#C62828;color:#fff;margin-top:12px;cursor:pointer}
.dv-btn.s{background:#fff;color:#111;border:1px solid #E5E7EB}
.dv-err{color:#B42318;font-size:13px;min-height:18px;margin-top:8px}
.dv-foot{font-size:12px;color:#9CA3AF;margin-top:14px}
.dv-logo{width:56px;height:56px;border-radius:16px;background:#C62828;margin:0 auto;display:flex;align-items:center;justify-content:center}
`;
function ensureCss() { if (!document.getElementById("dvcss")) { const st = document.createElement("style"); st.id = "dvcss"; st.textContent = CSS; document.head.appendChild(st); } }
const logo = `<div class="dv-logo"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 20h1M17 20h1M20 17h1"/></svg></div>`;

/**
 * Not signed in on a staff screen: offer "Set up this device" (6-digit code from the owner) or owner login.
 * next = the staff screen path to return to.
 */
export function showDeviceSetup(next) {
  ensureCss();
  const el = document.createElement("div"); el.className = "dv-wrap";
  el.innerHTML = `<div class="dv-box">${logo}<h1>Set up this device</h1><p>Ask the owner for a <b>device code</b> — Staff &amp; PINs → <b>Set up a tablet</b>. The tablet gets its own login; the owner dashboard stays private.</p>
    <input class="dv-code" inputmode="numeric" maxlength="6" placeholder="000000" aria-label="Device code"/>
    <input class="dv-name" placeholder="Device name (e.g. Counter tablet)" aria-label="Device name"/>
    <div class="dv-err" data-err></div>
    <button class="dv-btn" data-go>Connect this device</button>
    <button class="dv-btn s" data-owner>I’m the owner — log in</button>
    <div class="dv-foot">No app to download · taptayo</div></div>`;
  const code = el.querySelector(".dv-code"), name = el.querySelector(".dv-name"), err = el.querySelector("[data-err]");
  el.querySelector("[data-go]").onclick = async (e) => {
    e.target.disabled = true; err.textContent = "";
    try { await redeemCode(code.value, name.value || "Tablet"); location.replace(next || "/counter/"); }
    catch (x) { err.textContent = x.message; e.target.disabled = false; }
  };
  el.querySelector("[data-owner]").onclick = () => location.replace(`/login/?next=${encodeURIComponent(next || "/counter/")}`);
  document.body.appendChild(el);
  code.focus();
}

/**
 * Owner account is signed in on a staff screen: show a small banner suggesting a device login.
 * Mount once; returns the element.
 */
export function ownerOnStaffBanner() {
  if (document.getElementById("dvBanner")) return;
  ensureCss();
  const el = document.createElement("div"); el.id = "dvBanner";
  el.style.cssText = "background:#FFF7E6;color:#92400E;padding:10px 14px;font:500 13px Poppins,system-ui,sans-serif;display:flex;gap:10px;align-items:center;flex-wrap:wrap";
  el.innerHTML = `<span style="flex:1"><b>This tablet uses your owner login.</b> Anyone holding it can open your dashboard. Switch it to a staff-only device login.</span><button type="button" style="font:600 13px Poppins,system-ui,sans-serif;height:34px;padding:0 12px;border:0;border-radius:10px;background:#C62828;color:#fff;cursor:pointer" data-sw>Set up this device</button><button type="button" style="font:inherit;background:none;border:0;color:#92400E;cursor:pointer" data-x aria-label="Dismiss">✕</button>`;
  el.querySelector("[data-sw]").onclick = async (e) => {
    const name = prompt("Device name (e.g. Counter tablet):", "Counter tablet"); if (name == null) return;
    e.target.disabled = true; e.target.textContent = "Switching…";
    try { await switchToDevice(name); } catch (x) { alert(x.message); e.target.disabled = false; e.target.textContent = "Set up this device"; }
  };
  el.querySelector("[data-x]").onclick = () => { el.remove(); sessionStorage.setItem("dvBannerOff", "1"); };
  if (sessionStorage.getItem("dvBannerOff")) return;
  document.body.prepend(el);
  return el;
}

/** Dashboard opened by a device account → explain and offer the staff screens / owner login. */
export function showDeviceBlockedDashboard(storeMode) {
  ensureCss();
  const screens = storeMode === "salon" ? [["Reception", "/counter/"], ["Staff app", "/staff/"]] : storeMode === "stay" ? [["Front desk", "/counter/"], ["Caretaker app", "/staff/"]] : storeMode === "laundry" ? [["Counter", "/counter/"], ["Rider", "/rider/"]] : [["Counter", "/counter/"], ["Kitchen", "/kitchen/"], ["Dispatch", "/dispatch/"], ["Rider", "/rider/"]];
  const d = savedDevice();
  const el = document.createElement("div"); el.className = "dv-wrap";
  el.innerHTML = `<div class="dv-box">${logo}<h1>This is a staff device</h1><p>${esc(d?.name || "This tablet")} is set up for staff screens only. The owner dashboard opens with the owner’s own login.</p>
    ${screens.map(([n, u]) => `<a class="dv-btn s" style="display:flex;align-items:center;justify-content:center;text-decoration:none" href="${u}">${n}</a>`).join("")}
    <button class="dv-btn" data-owner>Log in as owner</button>
    <div class="dv-foot">Owner sessions on this tablet end after 15 minutes idle.</div></div>`;
  el.querySelector("[data-owner]").onclick = () => location.replace("/login/?next=/app/&shared=1");
  document.body.innerHTML = ""; document.body.appendChild(el);
}

/** On a shared tablet, end an owner session after idle time and return to the device login. */
export function ownerIdleGuard(minutes = 15) {
  if (!savedDevice()) return;
  let t;
  const reset = () => { clearTimeout(t); t = setTimeout(async () => { await signOut(auth); if (await deviceSignIn()) location.replace("/counter/"); else location.replace("/login/"); }, minutes * 60000); };
  ["click", "keydown", "touchstart", "scroll"].forEach((ev) => addEventListener(ev, reset, { passive: true }));
  reset();
}
