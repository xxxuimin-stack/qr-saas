import { auth, googleProvider } from "./firebase.js";
import {
  onAuthStateChanged,
  signOut,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  sendPasswordResetEmail,
} from "firebase/auth";
import { afterLogin, linkCode } from "./security.js";
import { call } from "./firebase.js";

const $ = (id) => document.getElementById(id);
let mode = "login"; // login | signup
let role = "business"; // Business accounts only while marketplace features are paused.
const ROLE_TXT = { business: ["Shop name", "Kapehan sa Kanto", "Let's set up your shop", "Takes about 10 minutes. Free for 14 days."] };
function drawRole() {
  document.querySelectorAll("[data-role]").forEach((b) => { const on = b.dataset.role === role; b.classList.toggle("on", on); b.setAttribute("aria-checked", String(on)); });
  const t = ROLE_TXT[role]; $("shopLabel").textContent = t[0]; $("a-shop").placeholder = t[1];
  $("adultField")?.classList.add("hidden");
  if (mode === "signup") { $("authTitle").textContent = t[2]; $("authSub").textContent = t[3]; $("ctaText").textContent = role === "business" ? "Start free trial" : "Create account"; }
  try { localStorage.setItem("taptayo:role", "business"); localStorage.removeItem("taptayo:newRole"); } catch {}
}
let showPw = false;

// If already logged in, go straight to the dashboard (it decides between wizard and dashboard)
const nextUrl = new URLSearchParams(location.search).get("next");
let deviceSignedOut = false;
let checking = false;
const safeNext = nextUrl && nextUrl.startsWith("/") ? nextUrl : "/app/";
onAuthStateChanged(auth, async (user) => {
  if (!user || user.isAnonymous || checking) return;
  // a shared tablet (device login) landed here to log in as the owner: sign the device out first
  const claims = (await user.getIdTokenResult()).claims;
  if (claims.role === "device") { if (!deviceSignedOut) { deviceSignedOut = true; await signOut(auth); } return; }
  checking = true;
  try {
    const r = await afterLogin(user, { nextUrl: safeNext });
    if (r === "verify") {
      showMsg(`<b>Confirm it's you.</b> We sent a login link to <b>${user.email}</b>. Open it on <u>this device and browser</u> to continue — this browser isn't on your trusted list yet. <a href="#" id="tsOut">Use another account</a>`, "warn");
      document.getElementById("tsOut").onclick = (e) => { e.preventDefault(); signOut(auth); showMsg(""); };
      $("submitBtn").disabled = false;
      checking = false;
      return;
    }
  } catch (e) {
    console.warn("security check", e);
    if (linkCode()) { showMsg(friendly(e)); checking = false; $("submitBtn").disabled = false; return; }
  }
  location.replace(await roleNext(user));
});
/** where to go after login: a shop → dashboard; a client → My TapTayo; a new creator / business → setup */
async function roleNext(user) {
  if (nextUrl && nextUrl.startsWith("/")) return safeNext;
  try {
    if (mode === "signup" || localStorage.getItem("taptayo:newRole")) {
      const r = "business";
      await call("accountSetup", { role: r, name: $("a-shop")?.value.trim() || user.displayName || "", adult: !!$("a-adult")?.checked });
      localStorage.removeItem("taptayo:newRole");
      if (r === "client") return "/me/";
    }
    const a = await call("myAccount", {});
    if (a.hasStore) return "/app/";
    // While marketplace roles are paused, every new account enters business setup.
    return "/app/";
  } catch (e) { console.warn("role", e); }
  return "/app/";
}
// Opened the 2-step link but not logged in on this browser → ask to log in here to finish
if (linkCode()) setTimeout(() => { if (!auth.currentUser) showMsg("Log in on this browser to finish confirming your login.", "warn"); }, 1500);

function setMode(next) {
  mode = next;
  const signup = mode === "signup";
  $("tabLogin").setAttribute("aria-selected", String(!signup));
  $("tabSignup").setAttribute("aria-selected", String(signup));
  $("nameField").classList.toggle("hidden", !signup);
  $("signupNote").classList.toggle("hidden", !signup);
  $("forgot").classList.toggle("hidden", signup);
  $("authTitle").textContent = signup ? "Let's set up your shop" : "Welcome back!";
  $("authSub").textContent = signup ? "Takes about 10 minutes. Free for 14 days." : "Let's check today's orders.";
  $("ctaText").textContent = signup ? "Start free trial" : "Log in";
  $("password").placeholder = signup ? "At least 8 characters" : "Your password";
  $("password").autocomplete = signup ? "new-password" : "current-password";
  $("password").minLength = signup ? 8 : 6;
  if (signup) drawRole();
  showMsg("");
}
$("tabLogin").onclick = () => setMode("login");
$("tabSignup").onclick = () => setMode("signup");
document.querySelectorAll("[data-role]").forEach((b) => (b.onclick = () => { role = b.dataset.role; drawRole(); }));
$("pwToggle").onclick = () => {
  showPw = !showPw;
  $("password").type = showPw ? "text" : "password";
  $("pwToggleText").textContent = showPw ? "Hide" : "Show";
  $("pwToggle").setAttribute("aria-label", showPw ? "Hide password" : "Show password");
};
// from the landing page: /login/?signup=1&type=salon
{
  const q = new URLSearchParams(location.search);
  const type = q.get("type");
  if (type && /^[a-z]+$/.test(type)) try { localStorage.setItem("taptayo:edition", type); } catch {}
  setMode(q.get("signup") ? "signup" : "login");
}

function showMsg(text, type = "error") {
  $("msg").innerHTML = text ? `<div class="alert ${type}">${text}</div>` : "";
}

function friendly(err) {
  const map = {
    "auth/invalid-credential": "Incorrect email or password.",
    "auth/user-not-found": "No account found for this email.",
    "auth/wrong-password": "Incorrect password.",
    "auth/email-already-in-use": "An account with this email already exists. Please log in instead.",
    "auth/weak-password": "Password is too weak (min 8 characters).",
    "auth/invalid-email": "Invalid email address.",
    "auth/popup-closed-by-user": "The Google sign-in popup was closed.",
    "auth/too-many-requests": "Too many attempts. Please try again later.",
    "auth/invalid-action-code": "This login link has expired or was already used. Log in again to get a new one.",
    "auth/operation-not-allowed": "Email-link login isn't enabled yet. Turn on Email link (passwordless) in Firebase → Authentication → Sign-in method → Email/Password.",
  };
  return map[err.code] || err.message || "Something went wrong.";
}

$("authForm").onsubmit = async (e) => {
  e.preventDefault();
  const email = $("email").value.trim();
  const password = $("password").value;
  if (!email) { $("email").focus(); return showMsg("Enter your email."); }
  if (password.length < (mode === "signup" ? 8 : 6)) { $("password").focus(); return showMsg(mode === "signup" ? "Use at least 8 characters for your password." : "Enter your password."); }
  
  const btn = $("submitBtn");
  btn.disabled = true;
  showMsg("");
  try {
    if (mode === "login") {
      await signInWithEmailAndPassword(auth, email, password);
    } else {
      // shop name → pre-fills the setup wizard
      const shop = $("a-shop").value.trim();
      if (shop) try { localStorage.setItem("taptayo:shopName", shop); } catch {}
      await createUserWithEmailAndPassword(auth, email, password);
    }
    // onAuthStateChanged handles the redirect
  } catch (err) {
    showMsg(friendly(err));
    btn.disabled = false;
  }
};

$("googleBtn").onclick = async () => {
  showMsg("");
  
  if (mode === "signup") { const shop = $("a-shop").value.trim(); if (shop) try { localStorage.setItem("taptayo:shopName", shop); } catch {} }
  try {
    await signInWithPopup(auth, googleProvider);
  } catch (err) {
    showMsg(friendly(err));
  }
};

$("resetLink").onclick = async (e) => {
  e.preventDefault();
  const email = $("email").value.trim();
  if (!email) { $("email").focus(); return showMsg("Enter your email above first.", "warn"); }
  try {
    await sendPasswordResetEmail(auth, email);
    showMsg("A password reset link has been sent to your email.", "ok");
  } catch (err) {
    showMsg(friendly(err));
  }
};
