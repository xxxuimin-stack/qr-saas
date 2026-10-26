import { FAQ, FAQ_CATS, faqSearch } from "./faq.js";
import { mountSupportButton, openSupport } from "./support.js";
import { auth, call } from "./firebase.js";
import { signInAnonymously } from "firebase/auth";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let cat = "", q = "";
const list = document.getElementById("list"), chips = document.getElementById("chips");
function draw() {
  chips.innerHTML = [["", "All"], ...Object.entries(FAQ_CATS)].map(([k, l]) => `<button data-c="${k}" class="${cat === k ? "on" : ""}">${esc(l)}</button>`).join("");
  chips.querySelectorAll("[data-c]").forEach((b) => (b.onclick = () => { cat = b.dataset.c; draw(); }));
  const rows = q ? faqSearch(q, 30) : FAQ.filter((f) => !cat || f[0] === cat);
  if (q) { list.innerHTML = rows.length ? rows.map(item).join("") : `<p>No answer found — tap “Message TapTayo” below.</p>`; return; }
  list.innerHTML = Object.keys(FAQ_CATS).filter((k) => !cat || k === cat).map((k) => `<h2>${esc(FAQ_CATS[k])}</h2>${rows.filter((f) => f[0] === k).map(item).join("")}`).join("");
}
const link = (t) => esc(t).replace(/taptayo\.com\/try/g, '<a href="/try/" style="font-weight:700">taptayo.com/try</a>').replace(/taptayo\.com\/pro\b/g, '<a href="/pro/" style="font-weight:700">taptayo.com/pro</a>');
const item = (f) => `<details><summary>${esc(f[1])}</summary><p>${link(f[2])}</p></details>`;
document.getElementById("q").oninput = (e) => { q = e.target.value.trim(); draw(); };
document.getElementById("chat").onclick = () => openSupport({ start: "new" });
mountSupportButton();
draw();
// 🤝 partner / investor form → Admin
const pf = document.getElementById("pform"), pmsg = document.getElementById("pmsg");
if (location.hash === "#partner") pf?.closest("details")?.setAttribute("open", "");
pf?.addEventListener("submit", async (e) => {
  e.preventDefault(); const f = new FormData(pf), btn = pf.querySelector("button"); btn.disabled = true; pmsg.textContent = "Sending…"; pmsg.style.color = "";
  try {
    await auth.authStateReady?.(); if (!auth.currentUser) await signInAnonymously(auth);
    await call("partnerInquiry", Object.fromEntries(f.entries()));
    pf.innerHTML = `<p class="msg">✓ Thank you! We got your message and will reply within a few days.</p>`;
  } catch (x) { pmsg.textContent = x.message || "Couldn't send. Please try again."; pmsg.style.color = "#B91C1C"; btn.disabled = false; }
});
