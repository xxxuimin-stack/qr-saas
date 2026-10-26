// "Coming soon" — what's next on TapTayo. Shown to owners (Dashboard → Overview, with "I want this" votes so the most-wanted
// gets built first) and to clients (Explore). Keep this list short and honest: only things we actually plan to ship.
import { call } from "./firebase.js";

import { ROADMAP, roadmapFor } from "./roadmapdata.js";
export { ROADMAP, roadmapFor };


/** Owner card with votes. store.wants = keys this store voted for. */
export function roadmapCard(el, { store, mode, canVote }) {
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const wants = new Set(store?.wants || []);
  const row = (r) => `<div class="rm-row" data-rm="${r.key}"><div class="rm-ic">${r.icon}</div><div class="rm-body"><div class="rm-t"><b>${esc(r.title)}</b> <span class="rm-eta">${esc(r.eta)}</span></div><div class="small muted">${esc(r.what)}</div></div>
    ${canVote ? `<button type="button" class="btn sm ${wants.has(r.key) ? "" : "ghost"}" data-vote="${r.key}">${wants.has(r.key) ? "✓ Wanted" : "I want this"}</button>` : ""}</div>`;
  el.innerHTML = `<section class="ov-sec rm" aria-labelledby="rmT"><header><h2 id="rmT">🔜 Coming soon</h2><span class="muted small">Tap what you want — we build the most-wanted first</span></header>${roadmapFor(mode).map(row).join("")}</section>`;
  el.querySelectorAll("[data-vote]").forEach((b) => (b.onclick = async () => { b.disabled = true; try { const r = await call("roadmapVote", { key: b.dataset.vote }); b.className = `btn sm ${r.on ? "" : "ghost"}`; b.textContent = r.on ? "✓ Wanted" : "I want this"; if (store) store.wants = r.on ? [...(store.wants || []), b.dataset.vote] : (store.wants || []).filter((k) => k !== b.dataset.vote); } catch (e) { alert(e.message); } b.disabled = false; }));
}
