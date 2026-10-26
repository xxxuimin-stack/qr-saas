// One phone screen inside the demo playground (/try/). The playground (parent page) owns the story;
// this page only paints the HTML it is given, in the real app's styles, and reports taps back.
//   ?kind=customer → customer page styles · staff → staff app styles · owner → owner dashboard styles
import "./screen.css";
const q = new URLSearchParams(location.search);
const kind = q.get("kind") || "customer", role = q.get("role") || "";
const css = { customer: () => import("../customer.css"), staff: () => import("../kitchen.css"), owner: () => Promise.all([import("../styles.css"), import("../dash.css")]) };
document.documentElement.dataset.kind = kind;
const app = document.getElementById("app");
const P = window.parent;

let lastHtml = "";
function draw(html, { next = "", primary = "", time = "" } = {}) {
  if (primary) document.documentElement.style.setProperty("--primary", primary);
  if (time) document.getElementById("tt-time").textContent = time;
  if (html !== lastHtml) { lastHtml = html; app.innerHTML = html; tick(); }
  app.querySelectorAll(".tt-next").forEach((x) => x.classList.remove("tt-next"));
  if (next) { const el = app.querySelector(`[data-act="${next}"]:not([disabled])`) || app.querySelector(`[data-act-hint="${next}"]`); if (el) { el.classList.add("tt-next"); if (!inView(el)) { const sh = el.closest(".tt-sheet"), r = el.getBoundingClientRect(); if (sh) sh.scrollTo({ top: sh.scrollTop + r.top - sh.getBoundingClientRect().top - 60, behavior: "smooth" }); else window.scrollBy({ top: r.top - innerHeight / 2 + r.height / 2, behavior: "smooth" }); } } }
}
const inView = (el) => { const r = el.getBoundingClientRect(); return r.top > 40 && r.bottom < innerHeight - 10; };

// phone-style notification banner (slides from the top)
function note(text) {
  const n = document.createElement("div"); n.className = "tt-note"; n.innerHTML = `<b>TapTayo</b><span>${text}</span>`;
  document.body.appendChild(n); requestAnimationFrame(() => n.classList.add("in"));
  setTimeout(() => { n.classList.remove("in"); setTimeout(() => n.remove(), 400); }, 3600);
}
function toast(text) {
  document.querySelector(".tt-toast")?.remove();
  const t = document.createElement("div"); t.className = "tt-toast"; t.textContent = text; document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}
// live timers: <span data-since="realMs" data-speed="60"> → "12 min" (1 real second = 1 demo minute)
function tick() {
  app.querySelectorAll("[data-since]").forEach((el) => { const m = Math.max(0, Math.floor(((Date.now() - Number(el.dataset.since)) / 1000) * (Number(el.dataset.speed || 60) / 60))); el.textContent = m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; });
}
setInterval(tick, 1000);

app.addEventListener("click", (e) => {
  const a = e.target.closest("[data-act]");
  if (a && !a.disabled) { e.preventDefault(); P.TT_act?.(role, a.dataset.act, a.dataset.arg ?? ""); return; }
  const i = e.target.closest("[data-info]");
  if (i) { e.preventDefault(); toast(i.dataset.info); return; }
  const u = e.target.closest("[data-ui]");
  if (u) { e.preventDefault(); P.TT_ui?.(role, u.dataset.ui, u.dataset.arg ?? ""); }
});

css[kind]().then(() => { window.TT = { draw, note, toast }; P.TT_ready?.(role); });
