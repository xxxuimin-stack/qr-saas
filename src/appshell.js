// Shared look for all staff apps: theme (light / 🌙 dark per device), app name chip,
// bottom tabs on phones (mirrors the header's [data-tab] buttons) and the "Me" sheet
// (who's on duty, switch staff, shift, other screens, Back to Overview for the owner, log out).
import { auth } from "./firebase.js";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { checkForUpdate, APP_VERSION } from "./updates.js";
import { openAppFeedback } from "./appfeedback.js";
import { autoSolo } from "./solo.js";
autoSolo();
// 📶 offline banner on every staff screen
(() => { const show = () => { let b = document.getElementById("ttOffline"); if (navigator.onLine) { b?.remove(); return; } if (b) return; b = document.createElement("div"); b.id = "ttOffline"; b.textContent = "📶 No signal — taps won't be sent until you're back online."; b.style.cssText = "position:fixed;left:0;right:0;top:0;z-index:99995;background:#b42318;color:#fff;font:600 13px/1.3 Poppins,system-ui,sans-serif;padding:8px 12px;text-align:center"; document.body.appendChild(b); }; window.addEventListener("offline", show); window.addEventListener("online", show); if (document.readyState !== "loading") show(); else document.addEventListener("DOMContentLoaded", show); })();

const KEY = "taptayo:theme";
let appName = "", appIcon = "", mode = "";
let role = null; // auth role: owner | device | staff | kitchen
onAuthStateChanged(auth, async (u) => { try { role = u && !u.isAnonymous ? (await u.getIdTokenResult()).claims.role || null : null; } catch { role = null; } });

function apply(t) { document.documentElement.dataset.theme = t === "dark" ? "dark" : "light"; const m = document.querySelector('meta[name="theme-color"]'); if (m) m.content = t === "dark" ? "#141517" : "#FFFFFF"; }
let cur = "light"; try { cur = localStorage.getItem(KEY) || "light"; } catch {}
apply(cur);
export function toggleTheme() { cur = cur === "dark" ? "light" : "dark"; try { localStorage.setItem(KEY, cur); } catch {} apply(cur); decorate(); }

/** app = label on the header chip (e.g. "Counter"); mode = business type */
export function setShell({ app, icon, mode: m } = {}) {
  if (app != null) appName = app; if (icon != null) appIcon = icon;
  if (m) { mode = m; document.body.dataset.mode = m; }
  if (app) document.title = `${app} · TapTayo`;
  decorate();
}

const SVG = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${p}</svg>`;
const IC = {
  orders: '<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2"/>',
  new: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
  tables: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  board: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>',
  calendar: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4M8 13h3M13 13h3M8 17h3"/>',
  walkin: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
  gift: '<path d="M20 12v9H4v-9M2 7h20v5H2zM12 21V7M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7zM12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/>',
  due: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/>',
  jobs: '<path d="M20.4 6.6 16 4a4 4 0 0 1-8 0L3.6 6.6a1 1 0 0 0-.5 1.2l1.2 3.4a1 1 0 0 0 1.3.6L7 11.3V20a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-8.7l1.4.5a1 1 0 0 0 1.3-.6l1.2-3.4a1 1 0 0 0-.5-1.2z"/>',
  fold: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  claim: '<path d="M2 9a3 3 0 0 0 0 6v3a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-3a3 3 0 0 0 0-6V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2z"/><path d="M13 5v2M13 17v2M13 11v2"/>',
  customers: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20a7 7 0 0 1 14 0M16 4.5a3.5 3.5 0 0 1 0 7M22 20a7 7 0 0 0-4-6.3"/>',
  today: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  approvals: '<path d="M20 6 9 17l-5-5"/>',
  requests: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  rooms: '<path d="M2 20V8M2 16h20v4M22 16v-4a3 3 0 0 0-3-3h-8v7M6 12a2 2 0 1 0 0-.01"/>',
  upcoming: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  incidents: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2"/>',
  done: '<path d="M20 6 9 17l-5-5"/>',
  map: '<path d="m9 3-6 3v15l6-3 6 3 6-3V3l-6 3zM9 3v15M15 6v15"/>',
  queue: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  reports: '<path d="M3 3v18h18M7 15l4-4 3 3 5-6"/>',
  _dot: '<circle cx="12" cy="12" r="3"/>',
  me: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const stripEmoji = (s) => s.replace(/^[\p{Extended_Pictographic}️‍\s]+/u, "").trim();

function whoOf(btn) { const c = btn.cloneNode(true); c.querySelectorAll(".k-tag, .k-badge").forEach((x) => x.remove()); const t = stripEmoji(c.textContent).replace(/\s+/g, " ").trim(); return /^switch$/i.test(t) ? "" : t; }
function tabInfo(btn) {
  const c = btn.cloneNode(true);
  const badge = c.querySelector(".k-badge, .k-tag"); const count = badge ? badge.textContent.trim() : "";
  c.querySelectorAll(".k-badge, .k-tag").forEach((x) => x.remove());
  const urgent = !!btn.querySelector(".k-badge");
  return { key: btn.dataset.tab, label: stripEmoji(c.textContent).replace(/\s+/g, " ").slice(0, 16), count, urgent, on: btn.classList.contains("on") || btn.classList.contains("primary") };
}

function decorate() {
  document.querySelectorAll(".k-head").forEach((h) => {
    const name = h.querySelector(".name");
    if (appName && name && !h.querySelector(".k-app")) name.insertAdjacentHTML("afterend", `<span class="k-app">${appIcon ? appIcon + " " : ""}${appName.replace(/[<>&]/g, "")}</span>`);
    else if (appName && h.querySelector(".k-app")) h.querySelector(".k-app").textContent = `${appIcon ? appIcon + " " : ""}${appName}`;
    let b = h.querySelector(".k-theme");
    if (!b) { b = document.createElement("button"); b.type = "button"; b.className = "k-theme"; b.onclick = toggleTheme; const after = h.querySelector(".k-app") || h.querySelector(".name"); if (after) after.after(b); else h.appendChild(b); }
    b.textContent = cur === "dark" ? "☀️" : "🌙"; b.title = cur === "dark" ? "Switch to light" : "Switch to dark";
    b.setAttribute("aria-label", b.title);
    // "Me" button in the header (wide screens); phones use the bottom tab
    if (!h.querySelector(".k-me")) { const me = document.createElement("button"); me.type = "button"; me.className = "k-btn sm k-me"; me.onclick = () => openMe(h); h.appendChild(me); }
    { const ub = h.querySelector("#userBtn, #sw"); const nm = ub ? whoOf(ub) : ""; h.querySelector(".k-me").innerHTML = `${SVG(IC.me)}<span>${esc(nm ? nm.split(" ")[0] : "Me")}</span>`; }
  });
  drawBottomNav();
}

// ---------- bottom tabs (phones) ----------
function drawBottomNav() {
  const h = document.querySelector(".k-head");
  let nav = document.getElementById("kBnav");
  if (!h) { nav?.remove(); document.body.classList.remove("has-bnav"); return; }
  const tabs = [...h.querySelectorAll("[data-tab]")];
  if (!nav) { nav = document.createElement("nav"); nav.id = "kBnav"; nav.className = "k-bnav"; nav.setAttribute("aria-label", "Tabs"); document.body.appendChild(nav); }
  document.body.classList.add("has-bnav");
  const main = tabs.slice(0, 4);
  nav.innerHTML = main.map((t) => { const i = tabInfo(t); return `<button type="button" data-k="${esc(i.key)}" class="${i.on ? "on" : ""}">${SVG(IC[i.key] || IC._dot)}<span>${esc(i.label)}</span>${i.count && i.count !== "0" ? `<i class="${i.urgent ? "u" : ""}">${esc(i.count)}</i>` : ""}</button>`; }).join("")
    + `<button type="button" data-k="_me" class="${main.some((t) => tabInfo(t).on) ? "" : tabs.length ? "" : "on"}">${SVG(IC.me)}<span>Me</span></button>`;
  nav.querySelectorAll("[data-k]").forEach((b) => (b.onclick = () => {
    if (b.dataset.k === "_me") return openMe(h);
    document.querySelector(`.k-head [data-tab="${CSS.escape(b.dataset.k)}"]`)?.click();
  }));
}

// ---------- Me sheet ----------
function screens() {
  if (mode === "salon") return [["Reception", "/counter/"], ["Stylist app", "/staff/"]];
  if (mode === "laundry") return [["Counter", "/counter/"], ["Rider", "/rider/"]];
  if (mode === "stay") return [["Front desk", "/counter/"], ["Caretaker app", "/staff/"]];
  return [["Counter", "/counter/"], ["Kitchen", "/kitchen/"], ["Dispatch", "/dispatch/"], ["Rider", "/rider/"]];
}
function openMe(h) {
  document.getElementById("kMe")?.remove();
  const userBtn = h.querySelector("#userBtn, #sw");
  const shiftBtn = h.querySelector("#shiftBtn");
  const who = userBtn ? whoOf(userBtn) : "";
  const extraTabs = [...h.querySelectorAll("[data-tab]")].slice(4);
  const here = location.pathname;
  const row = (attrs, icon, label, sub = "", cls = "") => `<button type="button" class="k-me-row ${cls}" ${attrs}><span class="ri">${SVG(icon)}</span><span class="rt">${label}${sub ? `<small>${sub}</small>` : ""}</span><svg class="chv" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg></button>`;
  const el = document.createElement("div"); el.id = "kMe"; el.className = "k-me-wrap";
  el.innerHTML = `<div class="k-me-dim" data-x></div><div class="k-me-sheet" role="dialog" aria-label="Me"><div class="grab"></div>
    <div class="k-me-head"><div class="av">${esc((who || "?").slice(0, 1).toUpperCase())}</div><div><b>${esc(who || "Not signed in")}</b><small>${esc(appName || "")}${role === "owner" ? " · Owner" : role === "device" ? " · Shared device" : ""}</small></div></div>
    <div class="k-me-list">
      ${extraTabs.map((t) => { const i = tabInfo(t); return row(`data-tab2="${esc(i.key)}"`, IC[i.key] || IC._dot, esc(i.label), i.count ? `${esc(i.count)}` : ""); }).join("")}
      ${role === "owner" ? row('data-go="/app/"', '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>', "Back to Overview", "Owner dashboard") : ""}
      ${userBtn ? row("data-sw", '<path d="M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3"/>', "Switch staff", "Next person enters their PIN") : ""}
      ${shiftBtn ? row("data-shift", '<rect x="2" y="6" width="20" height="13" rx="2"/><circle cx="12" cy="12.5" r="2.5"/>', "Shift & cash", stripEmoji(shiftBtn.textContent)) : ""}
      ${row("data-theme", '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>', cur === "dark" ? "Light mode" : "Dark mode")}
    </div>
    <div class="k-me-lbl">Other screens</div>
    <div class="k-me-screens">${screens().filter(([, u]) => u !== here).map(([n, u]) => `<a href="${u}">${esc(n)}</a>`).join("")}</div>
    <div class="k-me-list">${row("data-help", '<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>', "Help & support", "Questions · chat with TapTayo")}${row("data-fb", '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>', "Suggest an improvement", "Goes to the TapTayo team")}${row("data-upd", '<path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/>', "Check for updates", `Version ${APP_VERSION} · no need to reinstall`)}${row("data-out", '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>', "Log out", role === "device" ? "Ends your staff session on this device" : role === "owner" ? "Owner account" : "", "danger")}</div>
  </div>`;
  document.body.appendChild(el);
  const close = () => el.remove();
  el.querySelector("[data-x]").onclick = close;
  el.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  el.querySelectorAll("[data-tab2]").forEach((b) => (b.onclick = () => { close(); document.querySelector(`.k-head [data-tab="${CSS.escape(b.dataset.tab2)}"]`)?.click(); }));
  el.querySelector("[data-go]")?.addEventListener("click", () => location.assign("/app/"));
  el.querySelector("[data-sw]")?.addEventListener("click", () => { close(); userBtn.click(); });
  el.querySelector("[data-shift]")?.addEventListener("click", () => { close(); shiftBtn.click(); });
  el.querySelector("[data-theme]").onclick = () => { toggleTheme(); close(); };
  el.querySelector("[data-upd]").onclick = () => { close(); checkForUpdate({ manual: true }); };
  el.querySelector("[data-fb]").onclick = () => { close(); openAppFeedback({ staffName: who }); };
  el.querySelector("[data-help]").onclick = () => { close(); import("./support.js").then((m) => { m.supportAsShop(); m.openSupport(); }); };
  el.querySelector("[data-out]").onclick = async () => {
    close();
    if (role === "device") { // a shared tablet stays signed in as the device; "log out" ends the staff PIN session
      try { Object.keys(localStorage).filter((k) => /^orderqr:(staff|hb):/.test(k)).forEach((k) => localStorage.removeItem(k)); } catch {}
      location.reload();
      return;
    }
    await signOut(auth); location.replace("/login/");
  };
  el.querySelector(".k-me-sheet button")?.focus();
}

// headers are re-rendered often → re-decorate whenever one appears
new MutationObserver((list) => { if (list.some((m) => [...m.addedNodes].some((n) => n.nodeType === 1 && (n.classList?.contains("k-head") || n.querySelector?.(".k-head"))))) decorate(); }).observe(document.documentElement, { childList: true, subtree: true });
