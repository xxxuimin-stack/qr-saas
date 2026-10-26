import { auth, googleProvider, facebookProvider } from "./firebase.js";
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
// New sign-up is a business account and opens the shop wizard. An existing shop opens Overview.
// What they came for (homepage "Start free", ?type=salon) is remembered so the wizard can preselect it.
{ try { const q = new URLSearchParams(location.search); const t = q.get("type") || "", r = q.get("role") || ""; const intent = r === "creator" || t === "freelance" ? "creator" : r === "business" || (t && /^[a-z]+$/.test(t)) ? `business:${/^[a-z]+$/.test(t) && t !== "freelance" ? t : ""}` : ""; if (intent) localStorage.setItem("taptayo:intent", intent); } catch {} }
const ROLE_TXT = { client: ["Your name", "Juan dela Cruz", "Create your free account", "Book shops, hire creators and see all your bookings in one place."], creator: ["Your creator / page name", "Kain Tayo with Bea", "Let's set up your creator page", "Your rate card, offers and bookings — free to start."], business: ["Shop name", "Kapehan sa Kanto", "Let's set up your shop", "Free account. Takes about 10 minutes."] };
let role = "business";
function drawRole() {
  $("roles")?.closest(".f")?.classList.add("hidden"); $("adultField")?.classList.add("hidden");
  if ($("shopLabel")) { $("shopLabel").textContent = "Your name"; $("a-shop").placeholder = "Juan dela Cruz"; $("a-shop").autocomplete = "name"; }
  if (mode === "signup") { $("authTitle").textContent = "Create your business account"; $("authSub").textContent = "One email, one business. Next you'll set up your shop."; $("ctaText").textContent = "Create free account"; }
  try { localStorage.setItem("taptayo:role", "business"); localStorage.removeItem("taptayo:edition"); } catch {}
}
let showPw = false;

// If already logged in, go straight to the dashboard (it decides between wizard and dashboard)
const nextUrl = new URLSearchParams(location.search).get("next");
let deviceSignedOut = false;
let checking = false;
const safeNext = nextUrl && nextUrl.startsWith("/") ? nextUrl : "/app/";
// on the homepage the same card sits on the right: someone already logged in isn't sent away — they get a shortcut instead
const EMBED = document.body.dataset.authEmbed === "home"; let acted = false;
async function showLoggedIn(user) {
  const card = document.getElementById("login"); if (!card) return;
  card.innerHTML = `<div><h2>Welcome back${user.displayName ? ", " + user.displayName.split(" ")[0].replace(/[<>&"]/g, "") : ""}!</h2><p class="sub">You're logged in as ${String(user.email || "").replace(/[<>&"]/g, "")}.</p></div><a class="primary" id="goMine" href="/app/" style="display:flex;align-items:center;justify-content:center;text-decoration:none">Open my TapTayo →</a><button type="button" class="google" id="outBtn">Use another account</button>`;
  try { document.getElementById("goMine").href = await roleNext(user); } catch {}
  document.getElementById("outBtn").onclick = () => signOut(auth).then(() => location.reload());
}
onAuthStateChanged(auth, async (user) => {
  if (!user || user.isAnonymous || checking) return;
  if (EMBED && !acted) { const c = (await user.getIdTokenResult()).claims; if (c.role !== "device") showLoggedIn(user); return; }
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
/** where to go after login: existing shop → Overview. New sign-up with no shop → business wizard. A returning customer with no shop stays on My TapTayo. */
async function roleNext(user) {
  if (nextUrl && nextUrl.startsWith("/") && !(mode === "signup" && nextUrl.startsWith("/me"))) return safeNext;
  try {
    const a = await call("myAccount", {});
    if (a.hasStore) return "/app/#overview";
    if (mode === "signup") return "/app/";
    return "/me/";
  } catch (e) { console.warn("role", e); }
  return mode === "signup" ? "/app/" : "/me/";
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
  $("authTitle").textContent = signup ? "Create your business account" : "Welcome back!";
  $("authSub").textContent = signup ? "One email, one business. Next you'll set up your shop." : "Good to see you again.";
  $("ctaText").textContent = signup ? "Create free account" : "Log in";
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
  if (type && /^[a-z]+$/.test(type)) try { localStorage.setItem("taptayo:edition", type === "freelance" ? "freelance" : type); } catch {}
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
  acted = true;
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
  acted = true;
  showMsg("");
  try {
    await signInWithPopup(auth, googleProvider); } catch (err) { showMsg(friendly(err)); } }; if ($("facebookBtn")) $("facebookBtn").onclick = async () => { acted = true; showMsg(""); try { await signInWithPopup(auth, facebookProvider); } catch (err) { showMsg(err.code === "auth/operation-not-allowed" ? "Facebook sign-in is not turned on yet. Enable it in Firebase, Authentication, Sign-in method." : friendly(err)); } };

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
