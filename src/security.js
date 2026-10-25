// Owner login security: trusted browsers + optional 2-step confirmation (email link) on a new browser.
// The browser keeps a random trust token in localStorage; the server stores only its hash.
import { auth, call } from "./firebase.js";
import { sendSignInLinkToEmail, signOut } from "firebase/auth";

const KEY = "taptayo:trust";
const EMAIL_KEY = "taptayo:2stepEmail";

export function trustToken() {
  let t = null;
  try { t = localStorage.getItem(KEY); } catch {}
  if (!t) {
    const b = new Uint8Array(24); crypto.getRandomValues(b);
    t = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    try { localStorage.setItem(KEY, t); } catch {}
  }
  return t;
}

export function deviceName() {
  const ua = navigator.userAgent;
  const os = /Android/i.test(ua) ? "Android" : /iPhone|iPad/i.test(ua) ? "iPhone / iPad" : /Windows/i.test(ua) ? "Windows" : /Mac/i.test(ua) ? "Mac" : /Linux/i.test(ua) ? "Linux" : "Device";
  const br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /Firefox\//.test(ua) ? "Firefox" : "Browser";
  return `${br} on ${os}`;
}

/** One-time code from a 2-step email link in this page's URL (null if none). */
export function linkCode() {
  const q = new URLSearchParams(location.search);
  return q.get("mode") === "signIn" && q.get("oobCode") ? { oobCode: q.get("oobCode"), apiKey: q.get("apiKey") } : null;
}

/**
 * Called by the login page right after a sign-in.
 * "ok" → continue; "verify" → an email link was sent (the session stays signed in but locked until confirmed).
 */
export async function afterLogin(user, { nextUrl = "/app/" } = {}) {
  const deviceToken = trustToken();
  const code = linkCode();
  if (code) {
    // back from the email link: the server redeems the code and approves this session + trusts this browser
    await call("confirmTwoStep", { ...code, deviceToken, name: deviceName(), ua: navigator.userAgent });
    // turning 2-step ON goes through a test link first (so a broken email setup can never lock the owner out)
    if (new URLSearchParams(location.search).get("enable2step") === "1") await call("setTwoStep", { on: true });
    history.replaceState(null, "", location.pathname + (nextUrl ? `?next=${encodeURIComponent(nextUrl)}` : ""));
    return "ok";
  }
  const st = await call("securityStatus", { deviceToken });
  if (st.trusted) return "ok";
  if (st.twoStep) {
    if (!user.email) return "ok";
    const url = new URL("/login/", location.origin); if (nextUrl) url.searchParams.set("next", nextUrl);
    await sendSignInLinkToEmail(auth, user.email, { url: url.toString(), handleCodeInApp: true });
    return "verify";
  }
  await call("trustDevice", { deviceToken, name: deviceName(), ua: navigator.userAgent }).catch(() => {});
  return "ok";
}

export const securityStatus = () => call("securityStatus", { deviceToken: trustToken() });
export const setTwoStep = (on) => call("setTwoStep", { on });
/** Step 1 of turning 2-step on: email a login link to the owner. 2-step switches on only when that link is opened. */
export async function startTwoStep(email) {
  const url = new URL("/login/", location.origin); url.searchParams.set("next", "/app/#staff"); url.searchParams.set("enable2step", "1");
  await sendSignInLinkToEmail(auth, email, { url: url.toString(), handleCodeInApp: true });
}
export const forgetTrustedDevice = (id) => call("forgetTrustedDevice", { id });
export async function logoutEverywhere() { await call("logoutEverywhere", {}); try { localStorage.removeItem(KEY); } catch {} await signOut(auth); }
