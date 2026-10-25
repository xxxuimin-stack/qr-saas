// 📱 One-phone mode: an owner who runs everything alone switches between their screens from one bar.
// Shown on the owner dashboard and every staff screen when Settings → "I run my shop alone" is on (or in the demo).
import { auth, db, DEMO_VIEW } from "./firebase.js";
import { doc, getDoc } from "firebase/firestore";
import { onAuthStateChanged } from "firebase/auth";

const LINKS = {
  table: (r) => [["🏠", "Dashboard", "/app/"], ["🧾", "Counter", "/counter/"], ["🍳", "Kitchen", "/kitchen/"], ...(r ? [["🛵", "Rider", "/rider/"]] : [])],
  salon: (r) => [["🏠", "Dashboard", "/app/"], ["🛎", "Reception", "/counter/"], ["💆", "My jobs", "/staff/"], ...(r ? [["🛵", "Rider", "/rider/"]] : [])],
  laundry: (r) => [["🏠", "Dashboard", "/app/"], ["🧾", "Counter", "/counter/"], ...(r ? [["🛵", "Pickup & delivery", "/rider/"]] : [])],
  stay: () => [["🏠", "Dashboard", "/app/"], ["🛎", "Front desk", "/counter/"], ["🧹", "Caretaker", "/staff/"]],
};
let shown = false;
export function mountSoloBar(mode, rider, demoSlug) {
  if (shown) return; shown = true;
  const links = [...(demoSlug ? [["👤", "Customer", `/m/${demoSlug}`]] : []), ...(LINKS[mode] || LINKS.table)(rider)];
  const here = location.pathname.replace(/\/+$/, "/").split("/").slice(0, 2).join("/") + "/";
  const st = document.createElement("style");
  st.textContent = `.tt-solo{position:fixed;left:50%;bottom:calc(env(safe-area-inset-bottom,0px) + 74px);transform:translateX(-50%);z-index:9000;display:flex;gap:4px;background:#141414;border-radius:999px;padding:5px;box-shadow:0 8px 24px rgba(0,0,0,.25);font:600 12px/1 Poppins,system-ui,sans-serif;max-width:calc(100vw - 24px);overflow-x:auto}
  .tt-solo a{color:#fff !important;text-decoration:none !important;padding:8px 11px;border-radius:999px;white-space:nowrap;display:flex;gap:5px;align-items:center}.tt-solo a.on{background:#fff;color:#141414 !important}
  .tt-solo b{font-weight:600}@media (max-width:480px){.tt-solo a:not(.on) b{display:none}.tt-solo a{padding:8px 10px;font-size:15px}.tt-solo a.on{font-size:12px}}
  @media (min-width:900px){.tt-solo{bottom:18px}}`;
  document.head.appendChild(st);
  const bar = document.createElement("nav"); bar.className = "tt-solo"; bar.setAttribute("aria-label", "One-phone mode");
  bar.innerHTML = links.map(([i, l, u]) => `<a href="${u}${DEMO_VIEW && !u.startsWith("/m/") ? location.search : ""}" class="${u === here ? "on" : ""}" title="${l}"><span>${i}</span><b>${l}</b></a>`).join("");
  document.body.appendChild(bar);
}
/** read the store's one-phone setting (owner only) and show the bar */
let watching = false;
export function autoSolo() { if (watching) return; watching = true; onAuthStateChanged(auth, (u) => { if (u && !u.isAnonymous) check(u); }); }
async function check(u) {
  try {
    const t = await u.getIdTokenResult(); if (!["owner", "viewer"].includes(t.claims.role) || !t.claims.storeId) return;
    const s = (await getDoc(doc(db, "stores", t.claims.storeId))).data(); const solo = s?.settings?.solo;
    if (t.claims.role === "viewer") return mountSoloBar(s.mode, s.mode === "table" || s.mode === "laundry", s.slug);
    if (solo?.enabled) mountSoloBar(s.mode, solo.rider === "self");
  } catch {}
}
