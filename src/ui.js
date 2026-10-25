import { DEMO_VIEW, DEMO_MSG } from "./firebase.js";
// Small UI helpers used by all pages

export const $ = (id) => document.getElementById(id);

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function money(n, currency = "PHP") {
  const sym = currency === "PHP" ? "₱" : currency + " ";
  return sym + Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/** Create an element from an HTML string */
export function html(str) {
  const t = document.createElement("template");
  t.innerHTML = str.trim();
  return t.content.firstElementChild;
}

export function randomToken(len = 8) {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  for (const b of arr) out += chars[b % chars.length];
  return out;
}

// ---------------- toast ----------------
let toastTimer;
export function toast(msg, type = "ok") {
  if (DEMO_VIEW && /permission|insufficient|read-only demo/i.test(String(msg))) { msg = DEMO_MSG; type = "ok"; }
  let el = $("toast");
  if (!el) {
    el = html(`<div id="toast" class="toast"></div>`);
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
}

// ---------------- modal ----------------
/**
 * openModal({ title, body: HTMLElement|string, footer?: HTMLElement })
 * returns { close }
 */
export function openModal({ title, body, footer, wide = false }) {
  closeModal();
  const wrap = html(`
    <div id="modal" class="modal-wrap">
      <div class="modal ${wide ? "wide" : ""}">
        <div class="modal-head"><h3>${esc(title)}</h3><button class="x" type="button" aria-label="Close">×</button></div>
        <div class="modal-body"></div>
        <div class="modal-foot"></div>
      </div>
    </div>`);
  const bodyEl = wrap.querySelector(".modal-body");
  if (typeof body === "string") bodyEl.innerHTML = body;
  else bodyEl.appendChild(body);
  if (footer) wrap.querySelector(".modal-foot").appendChild(footer);
  else wrap.querySelector(".modal-foot").remove();
  wrap.querySelector(".x").onclick = closeModal;
  wrap.addEventListener("click", (e) => e.target === wrap && closeModal());
  document.body.appendChild(wrap);
  document.body.classList.add("no-scroll");
  return { close: closeModal, el: wrap };
}

export function closeModal() {
  $("modal")?.remove();
  document.body.classList.remove("no-scroll");
}

export function confirmDialog(message, { okText = "Delete", danger = true } = {}) {
  return new Promise((resolve) => {
    const foot = html(`<div class="row" style="justify-content:flex-end">
      <button class="btn ghost" type="button" data-no>Cancel</button>
      <button class="btn ${danger ? "danger" : ""}" type="button" data-yes>${esc(okText)}</button>
    </div>`);
    foot.querySelector("[data-no]").onclick = () => { closeModal(); resolve(false); };
    foot.querySelector("[data-yes]").onclick = () => { closeModal(); resolve(true); };
    openModal({ title: "Confirm", body: `<p>${esc(message)}</p>`, footer: foot });
  });
}

/** Simple form reader: { fieldName: value } from [name] elements inside root */
export function readForm(root) {
  const out = {};
  root.querySelectorAll("[name]").forEach((el) => {
    if (el.type === "checkbox") out[el.name] = el.checked;
    else if (el.type === "number") out[el.name] = el.value === "" ? null : Number(el.value);
    else out[el.name] = el.value.trim();
  });
  return out;
}
