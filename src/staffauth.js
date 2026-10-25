// Shared: PIN gate for staff screens (kitchen, barista, counter, rider), wake lock, and sound.
import { db, call, auth } from "./firebase.js";
import { collection, onSnapshot, query, orderBy, doc, getDoc, getDocs, where, setDoc, serverTimestamp } from "firebase/firestore";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const html = (str) => { const t = document.createElement("template"); t.innerHTML = str.trim(); return t.content.firstElementChild; };
const KEY = (storeId) => `orderqr:staff:${storeId}`;
const HB = (storeId) => `orderqr:hb:${storeId}`;
const AUTO_OFF_MS = 10 * 60000;
const ROLE_LABEL = { manager: "Manager", crew: "Crew", kitchen: "Kitchen", barista: "Barista", rider: "Rider", stylist: "Stylist", dispatch: "Dispatch", cleaner: "Caretaker (rooms)" };

// A staff member who resigned / was removed is logged out of every open screen right away.
let accessWatch = null;
function watchAccess(storeId, s) {
  if (!s || s.test || s.staffId === "owner" || accessWatch?.key === storeId + "/" + s.staffId) return;
  accessWatch?.unsub?.();
  const key = storeId + "/" + s.staffId;
  const unsub = onSnapshot(doc(db, "stores", storeId, "staff", s.staffId), (d) => {
    if (typeof d?.exists !== "function") return;
    if (d.metadata?.fromCache && !d.exists()) return; // offline / not loaded yet — only a confirmed server answer logs out
    if (d.exists() && d.data().active !== false && !d.data().planLocked) return;
    localStorage.removeItem(KEY(storeId)); localStorage.removeItem(HB(storeId));
    alert(d.exists() && d.data().planLocked ? `${s.name || "This staff"}'s PIN is paused — the shop's plan has fewer staff slots now. Ask the owner.` : `${s.name || "This staff"} no longer has access to this store. Please log in with another PIN.`);
    location.reload();
  }, () => {});
  accessWatch = { key, unsub };
}
export function getActiveStaff(storeId) {
  const s0 = getActiveStaffRaw(storeId);
  if (s0) try { watchAccess(storeId, s0); } catch {}
  return s0;
}
function getActiveStaffRaw(storeId) {
  try {
    // auto log-off: the app was closed (no heartbeat) for 10+ minutes → PIN again
    const hb = Number(localStorage.getItem(HB(storeId)) || 0);
    if (hb && Date.now() - hb > AUTO_OFF_MS) { localStorage.removeItem(KEY(storeId)); localStorage.removeItem(HB(storeId)); return null; }
    const s = JSON.parse(localStorage.getItem(KEY(storeId)) || "null");
    if (!s || Date.now() - s.at > 14 * 3600 * 1000) return null; // 14h max (one shift)
    if (!s.token && !s.test) return null; // logged in before the server-checked staff tokens → log in again
    return s;
  } catch { return null; }
}
export function clearActiveStaff(storeId) { localStorage.removeItem(KEY(storeId)); }
export const roleLabel = (r) => ROLE_LABEL[r] || r;

/**
 * Show the PIN screen. requireRoles: which roles are allowed ([] = anyone).
 * resolve({ staffId, name, roles })
 */
export function pinGate({ storeId, storeName, requireRoles = [], screenName = "" }) {
  return new Promise((resolve) => {
    const wrap = html(`<div class="pin-wrap">
      <div class="pin-box">
        <div class="pin-head"><div class="pin-store">${esc(storeName)}</div><div class="pin-title">${esc(screenName || "Staff login")}</div></div>
        <p class="pin-hint">Select your name, then enter your PIN.</p>
        <div class="pin-staff" data-staff><div class="pin-muted">Loading…</div></div>
        <div class="pin-pad hidden" data-padwrap>
          <div class="pin-who"><span data-who></span> <button type="button" class="pin-back" data-back>Change</button></div>
          <div class="pin-dots" data-dots></div>
          <div class="pin-keys">${[1,2,3,4,5,6,7,8,9,"",0,"⌫"].map((k) => `<button type="button" data-k="${k}" ${k === "" ? "disabled" : ""}>${k}</button>`).join("")}</div>
          <div class="pin-err" data-err></div>
        </div>
        <div data-testskip></div>
        <p class="pin-foot">No PIN? Ask your manager.</p>
      </div></div>`);
    document.body.appendChild(wrap);
    document.body.classList.add("pin-open");

    let staff = [], chosen = null, pin = "";
    // Test mode: the owner can skip the PIN (to try every screen on one device)
    (async () => {
      try {
        const [st, tok] = await Promise.all([getDoc(doc(db, "stores", storeId)), auth.currentUser?.getIdTokenResult()]);
        const tm = st.data()?.settings?.testMode;
        if (tok?.claims?.role === "viewer") { // demo: pick a sample staff member for this screen
          const sq = await getDocs(collection(db, "stores", storeId, "staff"));
          const all = sq.docs.map((d) => ({ id: d.id, ...d.data() })).filter((x) => x.active !== false);
          const me = all.find((x) => (x.roles || []).some((r) => requireRoles.includes(r))) || all[0];
          const rec = { staffId: me?.id || "demo", name: me?.name || "Demo", roles: ["manager", "crew", "kitchen", "barista", "dispatch", "rider", "stylist", "cleaner"], demo: true, at: Date.now() };
          unsub(); wrap.remove(); document.body.classList.remove("pin-open"); resolve(rec); return;
        }
        // 📱 one-phone mode: the owner runs every screen — no PIN, acts as their own staff profile
        if (tok?.claims?.role === "owner" && st.data()?.settings?.solo?.enabled) {
          const sq = await getDocs(query(collection(db, "stores", storeId, "staff"), where("isOwner", "==", true)));
          const me = sq.docs[0];
          const rec = { staffId: me?.id || "owner", name: me?.data().name || "Owner", roles: ["manager", "crew", "kitchen", "barista", "dispatch", "rider", "stylist", "cleaner"], solo: true, at: Date.now() };
          localStorage.setItem(KEY(storeId), JSON.stringify(rec));
          unsub(); wrap.remove(); document.body.classList.remove("pin-open"); resolve(rec); return;
        }
        if (tok?.claims?.role === "owner" && tm?.on && Number(tm.until) > Date.now()) {
          const box = wrap.querySelector("[data-testskip]");
          box.innerHTML = `<button type="button" class="pin-testskip">🧪 Test mode · continue as Owner (no PIN)</button>`;
          box.querySelector("button").onclick = () => {
            const rec = { staffId: "owner", name: "Owner (test)", roles: ["manager", "crew", "kitchen", "barista", "dispatch", "rider", "stylist", "cleaner"], test: true, at: Date.now() };
            localStorage.setItem(KEY(storeId), JSON.stringify(rec));
            unsub(); wrap.remove(); document.body.classList.remove("pin-open"); resolve(rec);
          };
        }
      } catch {}
    })();
    const listEl = wrap.querySelector("[data-staff]");
    const unsub = onSnapshot(query(collection(db, "stores", storeId, "staff"), orderBy("name")), (snap) => {
      staff = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((s) => s.active !== false);
      const ok = staff.filter((s) => !requireRoles.length || (s.roles || []).some((r) => requireRoles.includes(r) || r === "manager"));
      listEl.innerHTML = ok.length ? "" : `<div class="pin-muted">No staff have access here. Owner: Settings → Staff & PINs.</div>`;
      ok.forEach((s) => {
        const b = html(`<button type="button" class="pin-name"><b>${esc(s.name)}</b><span>${(s.roles || []).map(roleLabel).join(" · ")}</span></button>`);
        b.onclick = () => { chosen = s; pin = ""; wrap.querySelector("[data-who]").textContent = s.name; wrap.querySelector("[data-padwrap]").classList.remove("hidden"); listEl.classList.add("hidden"); drawDots(); };
        listEl.appendChild(b);
      });
    }, (e) => (listEl.innerHTML = `<div class="pin-muted">Error: ${esc(e.message)}</div>`));

    const drawDots = () => { wrap.querySelector("[data-dots]").innerHTML = Array.from({ length: Math.max(4, pin.length) }, (_, i) => `<span class="${i < pin.length ? "on" : ""}"></span>`).join(""); };
    wrap.querySelector("[data-back]").onclick = () => { chosen = null; pin = ""; wrap.querySelector("[data-padwrap]").classList.add("hidden"); listEl.classList.remove("hidden"); wrap.querySelector("[data-err]").textContent = ""; };
    wrap.querySelectorAll("[data-k]").forEach((b) => (b.onclick = async () => {
      const k = b.dataset.k;
      if (k === "⌫") pin = pin.slice(0, -1);
      else if (pin.length < 6) pin += k;
      drawDots();
      wrap.querySelector("[data-err]").textContent = "";
      if (pin.length >= 4) {
        // auto-submit at 4 digits; for 5–6 digit PINs, wait a moment
        clearTimeout(wrap._t);
        wrap._t = setTimeout(() => submit(), pin.length >= 6 ? 0 : 500);
      }
    }));
    async function submit() {
      if (!chosen || pin.length < 4) return;
      const p = pin;
      try {
        const res = await call("verifyPin", { staffId: chosen.id, pin: p });
        const rec = { ...res, at: Date.now() };
        localStorage.setItem(KEY(storeId), JSON.stringify(rec));
        unsub(); wrap.remove(); document.body.classList.remove("pin-open");
        resolve(rec);
      } catch (e) {
        pin = ""; drawDots();
        wrap.querySelector("[data-err]").textContent = e.message || "Wrong PIN";
        wrap.querySelector(".pin-box").classList.add("shake"); setTimeout(() => wrap.querySelector(".pin-box").classList.remove("shake"), 400);
      }
    }
  });
}

// ---------------- wake lock ----------------
let wakeLock = null;
export async function keepAwake() {
  try {
    if (!("wakeLock" in navigator)) return false;
    wakeLock = await navigator.wakeLock.request("screen");
    document.addEventListener("visibilitychange", async () => { if (document.visibilityState === "visible" && wakeLock?.released !== false) { try { wakeLock = await navigator.wakeLock.request("screen"); } catch {} } });
    return true;
  } catch { return false; }
}

// ---------------- sound / ringtone ----------------
let audioCtx = null;
export function unlockAudio() {
  try { audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); if (audioCtx.state === "suspended") audioCtx.resume(); } catch {}
}
export function chime(volume = 0.25) {
  try { navigator.vibrate?.([220, 90, 220]); } catch {}   // Android phones/tablets buzz too
  try {
    unlockAudio();
    const t = audioCtx.currentTime;
    [[880, 0], [1175, 0.18], [1568, 0.36]].forEach(([f, d]) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = "sine"; o.frequency.value = f; o.connect(g); g.connect(audioCtx.destination);
      g.gain.setValueAtTime(0, t + d); g.gain.linearRampToValueAtTime(volume, t + d + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t + d + 0.5);
      o.start(t + d); o.stop(t + d + 0.55);
    });
  } catch {}
}
let ringTimer = null;
/** ringtone mode: chime repeats until stopped (when no new orders remain) */
export function startRinging(volume) {
  if (ringTimer) return;
  chime(volume);
  ringTimer = setInterval(() => chime(volume), 2500);
}
export function stopRinging() { clearInterval(ringTimer); ringTimer = null; }
export const isRinging = () => !!ringTimer;

/** "Tap to start" overlay — the browser needs one tap before allowing sound and wake lock */
export function tapToStart(label = "Tap to start") {
  return new Promise((resolve) => {
    const o = html(`<div class="tap-wrap"><button type="button" class="tap-btn">${esc(label)}<small>Enable sound and keep the screen awake</small></button></div>`);
    o.querySelector("button").onclick = async () => { unlockAudio(); await keepAwake(); o.remove(); resolve(); };
    document.body.appendChild(o);
  });
}

/** Plan features for staff screens (from the public store page): feat("callstaff"), feat("events_vip")… Defaults to allowed until loaded. */
let FEAT = null;
export function watchFeatures(slug, onChange) {
  if (!slug) return;
  onSnapshot(doc(db, "publicStores", slug), (d) => { const x = d.data() || {}; FEAT = { ...(x.addons || {}), ...(x.pro || {}) }; onChange?.(FEAT); }, () => {});
}
export const feat = (k) => !FEAT || FEAT[k] !== false;
/** Screens that need a paid plan (Kitchen/Barista = Basic, Dispatch/Rider = Pro). On a lower plan → shows a notice and never opens. */
export async function requireFeature(slug, key, screen) {
  let ok = true;
  try { const d = await getDoc(doc(db, "publicStores", slug)); const x = d.data() || {}; ok = (x.pro || {})[key] !== false; } catch {}
  if (ok) return true;
  const plan = { stations: "Basic (₱99/mo)", dispatch: "Pro (₱499/mo)", delivery: "Pro (₱499/mo) or the Delivery add-on" }[key] || "a paid plan";
  document.body.innerHTML = `<div style="min-height:100vh;display:grid;place-items:center;padding:24px;font-family:Poppins,system-ui,sans-serif;background:#F5F6F8"><div style="max-width:420px;background:#fff;border-radius:20px;padding:26px;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.08)">
    <div style="font-size:2.4rem">🔒</div><h2 style="margin:8px 0 6px">${screen} isn't on your plan</h2>
    <p style="color:#6B7280;margin:0 0 16px">On the Free plan the <b>Counter</b> does everything — take orders, prepare, serve and get paid. ${screen} comes with <b>${plan}</b>.</p>
    <a href="/counter/" style="display:block;height:46px;line-height:46px;border-radius:12px;background:#C62828;color:#fff;font-weight:600;text-decoration:none;margin-bottom:8px">Open the Counter</a>
    <a href="/app/#billing" style="display:block;height:46px;line-height:46px;border-radius:12px;border:1px solid #E5E7EB;color:#111;font-weight:600;text-decoration:none">Owner: see plans</a></div></div>`;
  return new Promise(() => {});
}

// =====================================================================
// DUTY — who is on duty, with the app open (sound works) or closed (no sound!)
// Each staff screen sends a heartbeat every 20 s to stores/{id}/duty/{staffId}.
// =====================================================================
let dutyTimer = null, dutyState = {};
export function startDuty(storeId, me, screen, extra = () => ({})) {
  if (!me?.staffId) return;
  const ref = doc(db, "stores", storeId, "duty", me.staffId);
  const beat = (visible = !document.hidden) => {
    try { if (visible) localStorage.setItem(HB(storeId), String(Date.now())); } catch {}
    setDoc(ref, { staffId: me.staffId, name: me.name, roles: me.roles || [], screen, visible, at: serverTimestamp(), atMs: Date.now(), ...dutyState, ...extra() }, { merge: true }).catch(() => {});
  };
  clearInterval(dutyTimer); beat(); dutyTimer = setInterval(() => { if (!document.hidden) beat(true); }, 20000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      const hb = Number(localStorage.getItem(HB(storeId)) || 0);
      if (hb && Date.now() - hb > AUTO_OFF_MS) { alert("You were away for more than 10 minutes, so you were signed out. Please log in again with your PIN."); localStorage.removeItem(KEY(storeId)); localStorage.removeItem(HB(storeId)); location.reload(); return; }
    }
    beat(!document.hidden);
  });
  window.addEventListener("pagehide", () => beat(false));
}
export function setDutyState(storeId, me, patch) {
  dutyState = { ...dutyState, ...patch };
  if (me?.staffId) setDoc(doc(db, "stores", storeId, "duty", me.staffId), { ...patch, at: serverTimestamp(), atMs: Date.now() }, { merge: true }).catch(() => {});
}
export function endDuty(storeId, me) {
  clearInterval(dutyTimer);
  if (me?.staffId) setDoc(doc(db, "stores", storeId, "duty", me.staffId), { off: true, visible: false, at: serverTimestamp(), atMs: Date.now() }, { merge: true }).catch(() => {});
}
/** live list of staff on duty (last 12 h, not signed off) → cb(list) with .live (app open now) and .gone (minutes since last beat) */
export function watchDuty(storeId, cb) {
  return onSnapshot(collection(db, "stores", storeId, "duty"), (snap) => {
    const now = Date.now();
    const list = snap.docs.map((d) => d.data()).filter((x) => !x.off && now - (x.atMs || 0) < 12 * 3600e3)
      .map((x) => ({ ...x, live: x.visible !== false && now - (x.atMs || 0) < 45000, gone: Math.floor((now - (x.atMs || 0)) / 60000) }))
      .filter((x) => x.gone < 10 || x.delivering || x.returning); // auto off after 10 min without the app (unless out delivering)
    cb(list);
  }, () => cb([]));
}
export function dutyBoardHTML(list, { needBarista = false, needRider = false } = {}) {
  const has = (r) => list.some((x) => (x.roles || []).includes(r) && (x.live || x.delivering));
  const warn = [needBarista && !has("barista") ? "No BARISTA on duty" : "", needRider && !has("rider") ? "No RIDER on duty" : ""].filter(Boolean);
  const chip = (x) => `<span class="duty-chip ${x.delivering ? "out" : x.returning ? "back" : x.live ? "on" : "off"}">${x.delivering ? "🛵" : x.returning ? "🔙" : x.live ? "🟢" : "🔴"} ${esc(x.name)}${x.delivering ? " · on the way" : x.returning ? " · returning" : x.live ? "" : ` · app closed ${x.gone} min — no sound!`}</span>`;
  return `<div class="duty-board">${warn.map((w) => `<span class="duty-warn">⚠️ ${w}</span>`).join("")}<span class="duty-lbl">👥 On duty:</span>${list.length ? list.map(chip).join("") : `<span class="duty-chip off">nobody logged in</span>`}</div>`;
}
