// Maintenance window — config/maintenance { start, end, message } set by the TapTayo admin.
// 24 h before: a heads-up banner (dashboard + staff apps). During: customers see "We'll be right back"
// (status pages keep working, new orders/bookings are paused by the server); staff/owner apps go read-only.
// It ends on its own at `end`. TapTayo admin bypasses.
import { doc, onSnapshot } from "firebase/firestore";
import { db, auth } from "./firebase.js";

const T = (ms) => new Date(ms).toLocaleTimeString("en-PH", { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit" });
const D = (ms) => new Date(ms).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", weekday: "short", month: "short", day: "numeric" });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let M = null, kind = "staff", timer = null, viewOnly = false, isAdmin = false, started = false;
const DISMISS = "tt_maint_seen";

export const maintActive = () => !!(M && M.start <= Date.now() && Date.now() < M.end && !isAdmin);

function css() {
  if (document.getElementById("tt-maint-css")) return;
  const st = document.createElement("style"); st.id = "tt-maint-css";
  st.textContent = `
  .tt-mbar{position:fixed;left:0;right:0;top:0;z-index:99990;background:#2b1a3a;color:#fff;font:600 13px/1.35 Poppins,system-ui,sans-serif;padding:8px 40px 8px 14px;text-align:center}
  .tt-mbar.on{background:#b42318}.tt-mbar button{position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:0;color:#fff;font-size:18px;cursor:pointer}
  .tt-mover{position:fixed;inset:0;z-index:99991;background:rgba(20,10,30,.72);display:grid;place-items:center;padding:16px;font-family:Poppins,system-ui,sans-serif}
  .tt-mcard{background:#fff;color:#1b1320;border-radius:20px;max-width:380px;width:100%;padding:26px 22px;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.35)}
  .tt-mcard .ic{font-size:44px}.tt-mcard h2{margin:6px 0 4px;font-size:1.35rem}.tt-mcard p{margin:6px 0;color:#5a4f60;font-size:.92rem}
  .tt-mcard .cd{font-size:2rem;font-weight:800;color:#7B2D8E;letter-spacing:.02em;margin:10px 0}
  .tt-mcard button{margin-top:12px;border:1px solid #d9cfe0;background:#fff;border-radius:999px;padding:9px 16px;font:600 .9rem Poppins,system-ui,sans-serif;cursor:pointer}
  .tt-msheet{position:fixed;left:12px;right:12px;bottom:12px;z-index:99991;background:#fff;color:#1b1320;border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.25);padding:14px 16px;font:500 .9rem/1.4 Poppins,system-ui,sans-serif;max-width:520px;margin:0 auto;border-top:4px solid #7B2D8E}
  .tt-msheet b{display:block;font-size:1rem}`;
  document.head.appendChild(st);
}
const clear = () => document.querySelectorAll(".tt-mbar,.tt-mover,.tt-msheet").forEach((e) => e.remove());

function render() {
  clear();
  if (!M || !M.end || Date.now() >= M.end) { document.body.classList.remove("tt-maint"); return; }
  css();
  const now = Date.now(), on = M.start <= now;
  const when = `${T(M.start)}–${T(M.end)}`;
  if (!on) {
    if (M.start - now > 24 * 3600000 || kind === "customer") return;
    let seen = null; try { seen = localStorage.getItem(DISMISS); } catch {}
    if (seen === String(M.start)) return;
    const bar = document.createElement("div"); bar.className = "tt-mbar";
    bar.innerHTML = `🛠 Scheduled update <b>${D(M.start)} · ${when}</b> — the app pauses during this time, then comes back on its own.${M.message ? ` ${esc(M.message)}` : ""}<button aria-label="Close">×</button>`;
    bar.querySelector("button").onclick = () => { try { localStorage.setItem(DISMISS, String(M.start)); } catch {} bar.remove(); };
    document.body.appendChild(bar); return;
  }
  if (isAdmin) { const bar = document.createElement("div"); bar.className = "tt-mbar on"; bar.innerHTML = `🛠 Maintenance is ON until ${T(M.end)} — you're the admin, so you can keep working.`; document.body.appendChild(bar); return; }
  const left = Math.max(0, M.end - now); const mm = Math.floor(left / 60000), ss = Math.floor((left % 60000) / 1000);
  if (kind === "customer") {
    const sh = document.createElement("div"); sh.className = "tt-msheet";
    sh.innerHTML = `<b>🛠 We'll be right back at ${T(M.end)}</b>We're updating the app. New orders and bookings are paused for a few minutes — your order or booking status still works.${M.message ? `<div style="margin-top:4px;color:#5a4f60">${esc(M.message)}</div>` : ""}`;
    document.body.appendChild(sh); return;
  }
  if (viewOnly) { const bar = document.createElement("div"); bar.className = "tt-mbar on"; bar.innerHTML = `🛠 Updating — <b>view only</b> until ${T(M.end)} (${mm}:${String(ss).padStart(2, "0")} left). Changes are paused.`; document.body.appendChild(bar); return; }
  const ov = document.createElement("div"); ov.className = "tt-mover";
  ov.innerHTML = `<div class="tt-mcard"><div class="ic">🛠</div><h2>We'll be right back</h2><p>TapTayo is updating. This screen comes back on its own at <b>${T(M.end)}</b>.</p>
    <div class="cd">${mm}:${String(ss).padStart(2, "0")}</div>${M.message ? `<p>${esc(M.message)}</p>` : ""}<p class="small">Customers can still see their order and booking status. New orders and bookings are paused.</p>
    <button data-vo>View only</button></div>`;
  ov.querySelector("[data-vo]").onclick = () => { viewOnly = true; render(); };
  document.body.appendChild(ov);
}

/** call once per app: kind = "customer" | "staff" | "owner" */
export function watchMaintenance(k = "staff") {
  if (started) return; started = true; kind = k;
  if (location.pathname.startsWith("/admin")) isAdmin = true;
  auth.onAuthStateChanged?.(async (u) => { try { const r = u && await u.getIdTokenResult(); isAdmin = location.pathname.startsWith("/admin") || r?.claims?.admin === true; } catch {} render(); });
  onSnapshot(doc(db, "config", "maintenance"), (s) => {
    M = s.data() || null; viewOnly = false; render();
  }, () => {});
  clearInterval(timer);
  let prev = false;
  timer = setInterval(() => {
    const on = maintActive();
    // window just ended → reload the staff screens so they pick up the new version
    if (prev && !on && kind !== "customer") setTimeout(() => location.reload(), 1500 + Math.random() * 4000);
    prev = on; render();
  }, 1000);
}
