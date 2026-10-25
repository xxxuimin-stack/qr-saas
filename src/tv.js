// Queue TV — /tv/<slug>: big screen at the shop. Now serving, next numbers, wait time, "join the line" QR.
import { call } from "./firebase.js";
import { THEMES } from "./themes.js";

const slug = (location.pathname.split("/")[2] || new URLSearchParams(location.search).get("s") || "").trim();
const root = document.getElementById("tv");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const tShort = (ms) => new Date(ms).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" });
let lastTop = null, started = false, ac = null, qrDone = false;

const css = `
:root { --c: #7B2D8E; --c2: #5E1F6E; --ink: #141414; --paper: #F6F4F8; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--paper); color: var(--ink); font-family: var(--tt-font, Poppins, system-ui, sans-serif); overflow: hidden; }
.tv { height: 100vh; display: grid; grid-template-rows: auto 1fr auto; gap: 2vh; padding: 3vh 3vw; }
.tv-head { display: flex; align-items: center; gap: 1.2vw; }
.tv-head img { width: 6vh; height: 6vh; border-radius: 1.4vh; object-fit: cover; }
.tv-head h1 { margin: 0; font-size: 3.4vh; font-weight: 700; flex: 1; }
.tv-head .clock { font-size: 3.4vh; font-weight: 600; font-variant-numeric: tabular-nums; color: #57534E; }
.tv-main { display: grid; grid-template-columns: 1.5fr 1fr; gap: 2.4vw; min-height: 0; }
.tv-sec { background: #fff; border-radius: 2.4vh; padding: 2.6vh 2vw; display: flex; flex-direction: column; min-height: 0; box-shadow: 0 1px 2px rgba(0,0,0,.05); }
.tv-sec h2 { margin: 0 0 1.6vh; font-size: 2.2vh; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: #6B6470; }
.tv-now { display: grid; gap: 1.6vh; }
.tv-card { display: flex; align-items: center; gap: 2vw; padding: 2vh 2vw; border-radius: 2vh; background: #F6F4F8; }
.tv-card .no { font-size: 9vh; font-weight: 800; line-height: 1; letter-spacing: -.03em; color: var(--c); min-width: 18vh; }
.tv-card .who { font-size: 3.4vh; font-weight: 600; line-height: 1.25; }
.tv-card .who small { display: block; font-size: 2.4vh; font-weight: 500; color: #6B6470; }
.tv-card.top { background: var(--c); color: #fff; }
.tv-card.top .no { color: #fff; font-size: 14vh; }
.tv-card.top .who small { color: rgba(255,255,255,.85); }
.tv-card.flash { animation: tvflash 1s ease-in-out 3; }
@keyframes tvflash { 50% { transform: scale(1.03); box-shadow: 0 0 0 1.2vh rgba(123,45,142,.25); } }
@media (prefers-reduced-motion: reduce) { .tv-card.flash { animation: none; } }
.tv-next { display: grid; grid-template-columns: repeat(2, 1fr); gap: 1.4vh 1.4vw; align-content: start; }
.tv-next div { padding: 1.6vh 1vw; border-radius: 1.6vh; background: #F6F4F8; display: flex; align-items: baseline; justify-content: space-between; gap: 1vw; }
.tv-next b { font-size: 5vh; font-weight: 800; letter-spacing: -.02em; }
.tv-next span { font-size: 2.2vh; color: #6B6470; }
.tv-empty { font-size: 3vh; color: #8A8390; margin: auto 0; }
.tv-foot { display: flex; align-items: center; gap: 2vw; background: var(--c2); color: #fff; border-radius: 2.4vh; padding: 2vh 2vw; }
.tv-foot .wait { flex: 1; font-size: 3.4vh; font-weight: 600; }
.tv-foot .wait small { display: block; font-size: 2.2vh; font-weight: 400; opacity: .85; }
.tv-foot canvas { width: 13vh !important; height: 13vh !important; background: #fff; border-radius: 1.2vh; padding: .6vh; }
.tv-foot .scan { font-size: 2.6vh; font-weight: 600; max-width: 22vw; line-height: 1.25; }
.tv-start { position: fixed; inset: 0; display: grid; place-items: center; background: rgba(20,20,20,.55); z-index: 5; }
.tv-start button { font: 600 3vh var(--tt-font, Poppins, sans-serif); padding: 2.4vh 4vw; border: 0; border-radius: 999px; background: #fff; color: var(--ink); cursor: pointer; }
.tv-start p { color: #fff; font-size: 2.2vh; text-align: center; margin: 1.6vh 0 0; }
@media (orientation: portrait) { .tv-main { grid-template-columns: 1fr; } .tv-card.top .no { font-size: 10vh; } .tv-foot .scan { max-width: none; } }
`;
document.head.insertAdjacentHTML("beforeend", `<style>${css}</style>`);

function chime() {
  try {
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    [[880, 0], [1175, 0.22]].forEach(([f, t]) => { const o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = f; o.type = "sine"; g.gain.setValueAtTime(0.0001, ac.currentTime + t); g.gain.exponentialRampToValueAtTime(0.35, ac.currentTime + t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + t + 0.6); o.connect(g).connect(ac.destination); o.start(ac.currentTime + t); o.stop(ac.currentTime + t + 0.65); });
  } catch {}
}
async function wake() { try { await navigator.wakeLock?.request("screen"); } catch {} }

function paint(d) {
  const th = THEMES[d.theme?.preset] || {};
  const c = d.theme?.primary || th.primary || "#7B2D8E", c2 = (th.header && th.header[1]) || c;
  document.documentElement.style.setProperty("--c", c); document.documentElement.style.setProperty("--c2", c2);
  document.title = `${d.name} · Queue`;
  const [top, ...rest] = d.serving;
  root.innerHTML = `<div class="tv">
    <header class="tv-head">${d.logoUrl ? `<img src="${esc(d.logoUrl)}" alt=""/>` : ""}<h1>${esc(d.name)}</h1><span class="clock" data-clock>${tShort(Date.now())}</span></header>
    <main class="tv-main">
      <section class="tv-sec" aria-live="polite"><h2>Now serving</h2>
        ${d.serving.length ? `<div class="tv-now">${[top, ...rest.slice(0, 3)].map((x, i) => `<div class="tv-card ${i === 0 ? "top" : ""}${i === 0 && lastTop !== null && lastTop !== `${x.no}-${x.at}` ? " flash" : ""}"><span class="no">#${esc(x.no)}</span><span class="who">${x.staff ? esc(x.staff) : "Please come in"}${x.room ? `<small>${esc(x.room)}</small>` : x.started ? "<small>In session</small>" : "<small>Please proceed</small>"}</span></div>`).join("")}</div>` : `<p class="tv-empty">No one called yet.</p>`}
      </section>
      <section class="tv-sec"><h2>Next</h2>
        ${d.next.length ? `<div class="tv-next">${d.next.map((x) => `<div><b>#${esc(x.no)}</b><span>${x.eta ? "~" + tShort(x.eta) : ""}</span></div>`).join("")}</div>` : `<p class="tv-empty">No one waiting.</p>`}
      </section>
    </main>
    <footer class="tv-foot"><div class="wait">${d.open ? `Wait now about ${d.waitMin ?? 0} min` : esc(d.reason || "The line is closed")}<small>${d.count} in line</small></div>${d.open ? `<span class="scan">Scan to join the line and get your number</span><canvas data-qr width="200" height="200"></canvas>` : ""}</footer>
  </div>`;
  const nowTop = top ? `${top.no}-${top.at}` : "";
  if (lastTop !== null && nowTop && nowTop !== lastTop && started) chime();
  lastTop = nowTop;
  const q = root.querySelector("[data-qr]");
  if (q) import("qrcode").then((m) => m.default.toCanvas(q, `${location.origin}/m/${slug}?shop=1`, { width: 200, margin: 1 })).catch(() => {});
}
async function tick() {
  try { paint(await call("queueBoard", { slug })); }
  catch (e) { root.innerHTML = `<div class="tv"><p class="tv-empty" style="margin:auto">${esc(e.message || "Can't load the line.")} Retrying…</p></div>`; }
}
setInterval(() => { const c = document.querySelector("[data-clock]"); if (c) c.textContent = tShort(Date.now()); }, 15000);
if (!slug) root.innerHTML = `<div class="tv"><p class="tv-empty" style="margin:auto">Open this page from Reception → Queue TV.</p></div>`;
else {
  tick(); setInterval(tick, 8000);
  const st = document.createElement("div"); st.className = "tv-start";
  st.innerHTML = `<div><button type="button">▶ Start Queue TV</button><p>Turns on the sound for new numbers and keeps the screen awake.</p></div>`;
  st.querySelector("button").onclick = async () => { started = true; chime(); wake(); try { await document.documentElement.requestFullscreen?.(); } catch {} st.remove(); };
  document.body.appendChild(st);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && started) wake(); });
}
