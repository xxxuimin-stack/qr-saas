// "Log in to book" — one tap with Google, on any customer page (shop menu, stays, creator pages).
// The anonymous browser login is upgraded in place (linkWithPopup), so orders and bookings made a minute ago stay theirs.
import { GoogleAuthProvider, linkWithPopup, signInWithPopup } from "firebase/auth";
import { auth, call } from "./firebase.js";

export const isRealAccount = () => { const u = auth.currentUser; return !!(u && !u.isAnonymous && u.email); };
export const loginNeeded = (e) => /LOGIN_REQUIRED/.test(e?.message || "");

/** Resolves true once the person has a real TapTayo account (already, or after signing in here). */
export function ensureAccount({ openSheet, closeSheet, html, toast }, why = "book") {
  if (isRealAccount()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const next = encodeURIComponent(location.pathname + location.search);
    const body = html(`<div style="text-align:center">
      <div style="font-size:2.4rem" aria-hidden="true">👋</div>
      <p style="margin:6px 0"><b>Log in to ${why}</b></p>
      <p class="small muted" style="margin:0">One free TapTayo account for all your bookings, orders and receipts — in every shop. We never post anything for you.</p></div>`);
    const foot = html(`<div style="display:flex;flex-direction:column;gap:8px">
      <button class="c-btn brand block" type="button" data-g>Continue with Google</button>
      <a class="c-btn ghost block" href="/login/?signup=1&role=client&next=${next}">Use email instead</a></div>`);
    foot.querySelector("[data-g]").onclick = async (e) => {
      e.target.disabled = true; const p = new GoogleAuthProvider();
      try {
        if (auth.currentUser?.isAnonymous) {
          try { await linkWithPopup(auth.currentUser, p); }
          catch (x) {
            if (!/credential-already-in-use|email-already-in-use|provider-already-linked/.test(x.code || x.message || "")) throw x;
            const guestTok = await auth.currentUser.getIdToken().catch(() => null); // to move this phone's guest bookings to the account
            await signInWithPopup(auth, p);
            if (guestTok) call("claimGuestBookings", { token: guestTok }).catch(() => {});
          }
        } else await signInWithPopup(auth, p);
        await auth.currentUser?.getIdToken(true);
        closeSheet(); toast?.("✓ Logged in"); resolve(true);
      } catch (x) { e.target.disabled = false; if (!/popup-closed|cancelled-popup/.test(x.code || "")) toast?.(x.message); }
    };
    openSheet("Log in", body, foot);
  });
}

// Form draft — so a half-filled booking survives "Use email instead" (leaves the page) or a refresh.
const DKEY = (k) => "tt:draft:" + k;
export function saveDraft(root, key) {
  try {
    const v = {}; root.querySelectorAll("input, textarea, select").forEach((el) => {
      if (el.type === "file" || el.type === "password") return;
      const dn = el.getAttributeNames().find((x) => x.startsWith("data-") && x !== "data-wired");
      const id = el.name || (dn ? dn + (el.type === "checkbox" || el.type === "radio" ? "=" + (el.getAttribute(dn) || el.value) : "") : "");
      if (!id) return;
      v[id] = el.type === "checkbox" || el.type === "radio" ? el.checked : el.value;
    });
    sessionStorage.setItem(DKEY(key), JSON.stringify({ at: Date.now(), v }));
  } catch {}
}
/** restores once (then forgets it); fires change events so totals and slots update. Returns true if something was restored. */
export function restoreDraft(root, key) {
  let d = null; try { d = JSON.parse(sessionStorage.getItem(DKEY(key)) || "null"); sessionStorage.removeItem(DKEY(key)); } catch {}
  if (!d || Date.now() - d.at > 30 * 60000) return false;
  let n = 0;
  root.querySelectorAll("input, textarea, select").forEach((el) => {
    if (el.type === "file" || el.type === "password") return;
    const dn = el.getAttributeNames().find((x) => x.startsWith("data-") && x !== "data-wired");
    const id = el.name || (dn ? dn + (el.type === "checkbox" || el.type === "radio" ? "=" + (el.getAttribute(dn) || el.value) : "") : "");
    if (!id || !(id in d.v)) return;
    if (el.type === "checkbox" || el.type === "radio") { if (el.checked !== d.v[id]) { el.checked = d.v[id]; el.dispatchEvent(new Event("change", { bubbles: true })); n++; } }
    else if (d.v[id] && el.value !== d.v[id]) { el.value = d.v[id]; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); n++; }
  });
  return n > 0;
}
