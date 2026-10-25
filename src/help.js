import { FAQ, FAQ_CATS, faqSearch } from "./faq.js";
import { mountSupportButton, openSupport } from "./support.js";
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
const item = (f) => `<details><summary>${esc(f[1])}</summary><p>${esc(f[2])}</p></details>`;
document.getElementById("q").oninput = (e) => { q = e.target.value.trim(); draw(); };
document.getElementById("chat").onclick = () => openSupport({ start: "new" });
mountSupportButton();
draw();
