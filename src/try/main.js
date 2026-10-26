// Demo playground (/try/): pick a business, then tap through a real day on every person's phone.
// The story state lives here; each phone is an iframe (/try/screen.html) painted in the real app's styles.
import "./try.css";
import { SCENES, PLAN_COLOR, peso } from "./scenes.js";

const $ = (id) => document.getElementById(id);
const PRICE = { Free: "₱0", Basic: "₱99/mo", Pro: "₱499/mo", Business: "₱999/mo", "Creator Pro": "₱79/mo" };
const PHONE_W = 360, PHONE_H = 740;
let S = null;            // current scene
let st = null;           // { d, step, ui, did, done:Set, active }
let frames = {};         // role → { iframe, ready, wrap }
let muted = false;

function pick(id, keepUrl) {
  S = SCENES.find((x) => x.id === id) || SCENES[0];
  st = { d: S.init(), step: 0, ui: Object.fromEntries(S.roles.map((r) => [r.id, {}])), did: "", done: new Set(), active: S.roles[0].id, badge: {} };
  if (!keepUrl) history.replaceState(null, "", `?s=${S.id}`);
  document.documentElement.style.setProperty("--scene", S.color);
  $("ctaTop").href = `/login/?signup=1&type=${S.signup}&utm_source=try`;
  drawScenes(); buildPhones(); drawGuide(); drawPlans(); layout();
}

function drawScenes() {
  $("scenes").innerHTML = SCENES.map((x) => `<button class="${x.id === S.id ? "on" : ""}" data-scene="${x.id}"><span>${x.icon}</span>${x.short}</button>`).join("");
}
$("scenes").onclick = (e) => { const b = e.target.closest("[data-scene]"); if (b && b.dataset.scene !== S.id) pick(b.dataset.scene); };

function buildPhones() {
  frames = {};
  $("phones").innerHTML = S.roles.map((r) => `<div class="ty-phone" data-role="${r.id}"><div class="ty-plabel"><span>${r.icon}</span>${r.label}<em class="ty-ping" hidden>🔔</em></div>
    <div class="ty-device"><div class="ty-scale"><iframe title="${r.label}'s phone" src="/try/screen.html?kind=${r.kind}&role=${r.id}" width="${PHONE_W}" height="${PHONE_H}"></iframe></div></div></div>`).join("");
  S.roles.forEach((r) => { const wrap = $("phones").querySelector(`[data-role="${r.id}"]`); frames[r.id] = { wrap, iframe: wrap.querySelector("iframe"), ready: false }; });
  $("roletabs").innerHTML = S.roles.map((r) => `<button role="tab" data-tab="${r.id}"><span>${r.icon}</span>${r.label}<i hidden></i></button>`).join("");
}
$("roletabs").onclick = (e) => { const b = e.target.closest("[data-tab]"); if (b) setActive(b.dataset.tab); };
function setActive(role) { st.active = role; st.badge[role] = 0; layout(); drawGuide(); }

// phones call these
window.TT_ready = (role) => { if (!frames[role]) return; frames[role].ready = true; drawOne(role); };
window.TT_ui = (role, key, val) => { st.ui[role][key] = val; drawOne(role); };
window.TT_act = (role, act, arg) => {
  const fn = S.acts[act]; if (!fn) return;
  const notes = fn(st.d, arg) || [];
  st.ui[role] = {};
  const idx = S.steps.findIndex((s, i) => i >= st.step && s.act === act && s.role === role);
  if (idx >= 0 && (!S.steps[idx].until || S.steps[idx].until(st.d))) { for (let i = st.step; i <= idx; i++) st.done.add(i); st.step = idx + 1; st.did = S.steps[idx].did; }
  drawAll();
  let rang = false;
  for (const [to, text] of notes) {
    const f = frames[to]; if (!f?.ready) continue;
    if (to === role) { f.iframe.contentWindow.TT.toast(text); continue; }
    setTimeout(() => f.iframe.contentWindow.TT.note(text), 250);
    ping(to); rang = true;
  }
  if (rang) chime();
  drawGuide(); drawPlans();
};

function drawOne(role) {
  const f = frames[role]; if (!f?.ready) return;
  const step = S.steps[st.step];
  f.iframe.contentWindow.TT.draw(S.views[role](st.d, st.ui[role]), { next: step && step.role === role ? step.act : "", primary: S.color, time: (st.d.time.match(/\d{1,2}:\d{2}/) || ["9:41"])[0] });
}
function drawAll() { S.roles.forEach((r) => drawOne(r.id)); }

function ping(role) {
  const f = frames[role]; const p = f.wrap.querySelector(".ty-ping"); p.hidden = false; f.wrap.classList.remove("rang"); void f.wrap.offsetWidth; f.wrap.classList.add("rang");
  setTimeout(() => { p.hidden = true; f.wrap.classList.remove("rang"); }, 3500);
  if (tabbed() && role !== st.active) { st.badge[role] = (st.badge[role] || 0) + 1; drawTabs(); }
}
let ac;
function chime() {
  if (muted) return;
  try { ac = ac || new (window.AudioContext || window.webkitAudioContext)(); const t = ac.currentTime;
    [880, 1320].forEach((f, i) => { const o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = f; o.type = "sine"; g.gain.setValueAtTime(0.0001, t + i * 0.12); g.gain.exponentialRampToValueAtTime(0.12, t + i * 0.12 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 0.35); o.connect(g).connect(ac.destination); o.start(t + i * 0.12); o.stop(t + i * 0.12 + 0.4); });
  } catch {}
}

const roleOf = (id) => S.roles.find((r) => r.id === id);
function drawGuide() {
  const step = S.steps[st.step], total = S.steps.filter((s) => !s.bonus).length, main = S.steps.filter((s, i) => !s.bonus && st.done.has(i)).length;
  const finishedMain = main >= total;
  const r = step && roleOf(step.role);
  const go = step && tabbed() && st.active !== step.role ? `<button class="ty-go" data-go="${step.role}">Go to ${r.icon} ${r.label}'s phone →</button>` : "";
  $("guide").innerHTML = `<div class="ty-gcard">
    <div class="ty-gtop"><span class="ty-ic">${S.icon}</span><div><b>${S.shop}</b><small>${S.pitch}</small></div></div>
    <div class="ty-prog"><i style="width:${Math.round((Math.min(main, total) / total) * 100)}%"></i></div>
    ${st.did ? `<div class="ty-did"><b>✨ What just happened</b>${st.did}</div>` : `<div class="ty-did intro"><b>👋 How it works</b>Each phone is a different person. Tap the glowing button 👆 — and watch the other phones react.</div>`}
    ${step ? `<div class="ty-step ${step.bonus ? "bonus" : ""}"><div class="ty-sn">${step.bonus ? "Bonus" : `Step ${st.step + 1} of ${total}`} · ${r.icon} ${r.label}</div><h3>${step.title}</h3><p>${step.hint}</p>
      <span class="ty-plan" style="--pc:${PLAN_COLOR[step.plan]}">${step.plan}</span> <span class="ty-feat">${step.feat}</span>${go}</div>`
      : `<div class="ty-step done"><h3>🎉 That's a full day at ${S.shop}!</h3><p>Every person saw only what they needed — and nobody had to send “nareceive mo na po ba?”</p>
      <a class="ty-cta big" href="/login/?signup=1&type=${S.signup}&utm_source=try">Start free — set up in 5 minutes →</a></div>`}
    ${finishedMain && step?.bonus && st.step === S.steps.findIndex((s) => s.bonus) ? `<p class="ty-note">✅ Main story done! These bonus steps show what <b>Pro</b> and <b>Business</b> add.</p>` : ""}
    <ol class="ty-list">${S.steps.map((s, i) => `<li class="${st.done.has(i) ? "ok" : i === st.step ? "now" : ""}${s.bonus ? " b" : ""}"><span>${st.done.has(i) ? "✓" : roleOf(s.role).icon}</span>${s.title}<em style="--pc:${PLAN_COLOR[s.plan]}">${s.plan}</em></li>`).join("")}</ol>
    <div class="ty-tools"><button data-reset>↺ Start over</button><button data-mute>${muted ? "🔇 Sound off" : "🔔 Sound on"}</button></div></div>`;
  $("mini").innerHTML = step ? `<b>${step.bonus ? "Bonus" : `${st.step + 1}/${total}`} · ${r.icon} ${r.label}:</b> ${step.hint}${go}` : `🎉 Done! <a href="/login/?signup=1&type=${S.signup}&utm_source=try">Start free →</a>`;
  drawTabs();
}
$("mini").onclick = (e) => { const g = e.target.closest("[data-go]"); if (g) setActive(g.dataset.go); };
$("guide").onclick = (e) => {
  if (e.target.closest("[data-reset]")) return pick(S.id, true);
  if (e.target.closest("[data-mute]")) { muted = !muted; return drawGuide(); }
  const g = e.target.closest("[data-go]"); if (g) setActive(g.dataset.go);
};
function drawTabs() {
  const step = S.steps[st.step];
  $("roletabs").querySelectorAll("[data-tab]").forEach((b) => { const id = b.dataset.tab; b.classList.toggle("on", id === st.active); b.classList.toggle("next", !!step && step.role === id && id !== st.active); const i = b.querySelector("i"); i.hidden = !st.badge[id]; i.textContent = st.badge[id] || ""; });
}

function drawPlans() {
  const by = {}; S.steps.forEach((s, i) => { (by[s.plan] = by[s.plan] || []).push([s, st.done.has(i)]); });
  const order = ["Free", "Basic", "Pro", "Business", "Creator Pro"].filter((p) => by[p]);
  $("plans").innerHTML = `<h2>What you just tried — and which plan has it</h2><p class="ty-sub">Start on <b>Free</b> forever. New shops get <b>Basic free for 14 days</b>. Upgrade only when you need more.</p>
    <div class="ty-pgrid">${order.map((p) => `<div class="ty-pcol" style="--pc:${PLAN_COLOR[p]}"><div class="ty-ph"><b>${p}</b><span>${PRICE[p]}</span></div>${by[p].map(([s, ok]) => `<div class="ty-pf ${ok ? "ok" : ""}">${ok ? "✓" : "○"} ${s.feat}</div>`).join("")}</div>`).join("")}</div>
    ${S.extras ? `<h3>More features you get</h3><div class="ty-extras">${S.extras.map(([p, t]) => `<span style="--pc:${PLAN_COLOR[p]}"><em>${p}</em>${t}</span>`).join("")}</div>` : ""}
    <div class="ty-end"><a class="ty-cta big" href="/login/?signup=1&type=${S.signup}&utm_source=try">Start free →</a><a class="ty-link" href="/m/taptayo-${S.id === "stay" ? "airbnb" : S.id === "photo" ? "studio" : S.id}" target="_blank" rel="noopener">Open the live demo shop</a>
    ${SCENES.filter((x) => x.id !== S.id).map((x) => `<button class="ty-link" data-scene2="${x.id}">${x.icon} Try ${x.short}</button>`).join("")}</div>`;
}
$("plans").onclick = (e) => { const b = e.target.closest("[data-scene2]"); if (b) { pick(b.dataset.scene2); scrollTo({ top: 0, behavior: "smooth" }); } };

// layout: all phones side by side when they fit, otherwise one phone + role tabs
const tabbed = () => document.body.classList.contains("tabbed");
function layout() {
  if (!S) return;
  const n = S.roles.length, area = $("phones"), gap = 18;
  document.body.classList.remove("tabbed");
  let w = area.parentElement.clientWidth;
  const hFit = (innerHeight - 150) / (PHONE_H + 34);
  let s = Math.min(1, (w - gap * (n - 1) - n * 44) / (n * PHONE_W), hFit);
  const isTab = innerWidth < 760 || s < 0.6;
  document.body.classList.toggle("tabbed", isTab);
  let ph = PHONE_H;
  if (isTab) { w = area.parentElement.clientWidth; const avail = Math.min(w - 16, 430); s = avail / PHONE_W; ph = Math.round(Math.max(560, Math.min(900, (innerHeight - 190) / s))); } // phones: fill the screen height instead of shrinking
  Object.entries(frames).forEach(([id, f]) => {
    f.wrap.hidden = isTab && id !== st.active;
    const sc = f.wrap.querySelector(".ty-scale"), dev = f.wrap.querySelector(".ty-device");
    f.iframe.height = ph; sc.style.height = ph + "px";
    sc.style.transform = `scale(${s})`; dev.style.width = PHONE_W * s + "px"; dev.style.height = ph * s + "px";
  });
  drawTabs();
}
addEventListener("resize", () => { clearTimeout(layout.t); layout.t = setTimeout(() => { layout(); drawGuide(); }, 120); });

pick(new URLSearchParams(location.search).get("s") || "stay", true);
