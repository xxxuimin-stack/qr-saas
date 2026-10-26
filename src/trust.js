// Trust badge beside a shop / creator name (style D, folded):
//   gold seal = Verified business · D / B / P letters (DTI, BIR, permit) folded behind it · pink camera = creator ID checked
//   all complete → the seal glows · not verified yet but has documents → grey seal · brand-new → green leaf
// Tap → the letters fan out and a small card explains each one. Only badges show — never the uploaded documents.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SEAL_D = "M12 1.5l2.4 1.8 3-.2 1 2.8 2.6 1.6-.7 2.9 1.2 2.7-2.2 2 -.3 3-2.9.7-1.6 2.6-2.8-1-2.7 1.3-2-2.2-3-.2-.8-2.9-2.5-1.6.9-2.9-1.3-2.7 2.2-2 .2-3 2.9-.8L9.4 2.9z";
const seal = (fill, glow) => `<svg class="tb-svg" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">${glow ? `<defs><linearGradient id="tbg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FDE047"/><stop offset=".5" stop-color="#EAB308"/><stop offset="1" stop-color="#CA8A04"/></linearGradient></defs>` : ""}<path fill="${glow ? "url(#tbg)" : fill}" d="${SEAL_D}"/><path d="M7.5 12.3l3 3 6-6.3" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const dot = (bg, inner) => `<span class="tb-dot" style="background:${bg}">${inner}</span>`;
const LEAF = `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#16A34A"/><path d="M7 17c0-6 4-10 10-10 0 6-4 10-10 10z" fill="#fff"/></svg>`;
const BOLT = `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11" fill="#EA580C"/><path d="M13 5l-5 8h3.5l-1 6 5-8H12z" fill="#fff"/></svg>`;
const CAM = `<svg width="11" height="11" viewBox="0 0 24 24"><rect x="3" y="7" width="18" height="13" rx="3" fill="#fff"/><circle cx="12" cy="13.5" r="3.6" fill="#DB2777"/><rect x="8" y="4" width="8" height="4" rx="1.5" fill="#fff"/></svg>`;
const ITEMS = [
  ["verified", "Verified business", "Real shop · 30+ days · 50+ orders · owner ID checked", "#EAB308", "✓"],
  ["creator", "Creator · ID checked", "TapTayo checked this creator's valid ID", "#DB2777", CAM],
  ["dti", "DTI registered", "Business name checked by TapTayo", "#2563EB", "D"],
  ["bir", "BIR registered", "Form 2303 checked by TapTayo", "#D97706", "B"],
  ["permit", "Business / Mayor's permit", "Permit checked by TapTayo", "#7C3AED", "P"],
];

function state(store) {
  const t = store?.trust; if (!t) return null;
  const b = new Set(t.badges || []);
  const rows = ITEMS.filter(([k]) => k !== "creator" || store.businessType === "freelance" || b.has("creator"));
  const have = rows.filter(([k]) => b.has(k));
  return { t, b, rows, have, complete: have.length === rows.length, docs: ["dti", "bir", "permit", "creator"].filter((k) => b.has(k)) };
}

/** the badge that sits right after the name (inline). Empty for demos / no data. */
export function trustBadge(store) {
  const s = state(store); if (!s) return "";
  const letters = s.docs.map((k) => { const it = ITEMS.find((x) => x[0] === k); return dot(it[3], it[4]); }).join("");
  let icon;
  if (s.b.has("verified")) icon = seal("#EAB308", s.complete);
  else if (s.docs.length) icon = seal("#D6D3D1", false);
  else if (s.b.has("active")) icon = BOLT;
  else if (s.b.has("new")) icon = LEAF;
  else return "";
  const label = s.b.has("verified") ? (s.complete ? "Fully verified business" : "Verified business") : s.b.has("active") ? "Active on TapTayo" : s.docs.length ? "Documents checked by TapTayo" : "New on TapTayo";
  return `<button type="button" class="tb${s.complete && s.b.has("verified") ? " glow" : ""}" data-trustbadge aria-label="${esc(label)} — tap for details"><span class="tb-seal">${icon}${s.complete && s.b.has("verified") ? `<i class="tb-sp">✦</i><i class="tb-sp b">✦</i>` : ""}</span>${letters ? `<span class="tb-stack">${letters}</span>` : ""}</button>`;
}

function card(store) {
  const s = state(store); const n = s.have.length, total = s.rows.length;
  const top = s.b.has("verified") ? (s.complete ? "🏆 Fully verified business" : "Checked by TapTayo") : s.b.has("active") ? "⚡ Active on TapTayo" : s.docs.length ? "Checked by TapTayo" : "🌱 New on TapTayo";
  const intro = !s.b.has("verified") && !s.docs.length ? `<p class="tb-intro">${s.b.has("active") ? "This shop has 20+ completed orders or bookings on TapTayo." : "This shop just joined TapTayo. To keep you safe, downpayments are capped until it's verified."}</p>` : "";
  return `<div class="tb-card" role="dialog" aria-label="Trust badges"><div class="tb-t">${top}</div>${intro}${s.rows.map(([k, l, d, c, i]) => { const on = s.b.has(k); return `<div class="tb-r${on ? "" : " off"}"><span class="tb-i" style="background:${on ? c : "#E7E5E4"}">${i}</span><span><b>${l}</b><br><small>${on ? d : "Not yet"}</small></span>${on ? `<em>✓</em>` : ""}</div>`; }).join("")}
    <div class="tb-prog"><i style="width:${Math.round((n / total) * 100)}%"></i></div><small class="tb-n">${n} of ${total}${s.complete ? " — all complete ✨" : ""}${s.t.tx >= 10 ? ` · ${Number(s.t.tx).toLocaleString("en-PH")} ${store.mode === "salon" || store.mode === "stay" ? "bookings" : "orders"} on TapTayo` : ""}</small>
    <small class="tb-foot">${store.demo ? "🧪 Demo shop — these are sample badges to show how they look." : "A badge means TapTayo checked it — it's not a guarantee. See something wrong? Use “Report this shop”."}</small></div>`;
}

/** one listener for the whole page: tap a badge → fan out + explain card (tap outside / again / scroll to close) */
let wired = false;
export function enableTrust(getStore) {
  if (wired) return; wired = true;
  const shut = () => { document.querySelector(".tb-card")?.remove(); document.querySelectorAll(".tb.open").forEach((b) => b.classList.remove("open")); };
  document.addEventListener("click", (e) => {
    const btn = e.target.closest?.("[data-trustbadge]");
    if (!btn) { if (!e.target.closest?.(".tb-card")) shut(); return; }
    e.preventDefault(); e.stopPropagation();
    const was = btn.classList.contains("open"); shut(); if (was) return;
    const store = getStore(); if (!state(store)) return;
    btn.classList.add("open");
    const wrap = document.createElement("div"); wrap.innerHTML = card(store); const el = wrap.firstElementChild; document.body.appendChild(el);
    const r = btn.getBoundingClientRect(), w = Math.min(320, window.innerWidth - 24);
    el.style.width = w + "px"; el.style.left = Math.max(12, Math.min(window.innerWidth - w - 12, r.left + r.width / 2 - w / 2)) + "px";
    el.style.top = Math.min(r.bottom + 8, window.innerHeight - 20) + "px";
  }, true);
  window.addEventListener("scroll", () => { if (document.querySelector(".tb-card")) shut(); }, { passive: true });
}

/** small line under the name: "1,240 orders on TapTayo" (badges themselves live beside the name) */
export function trustChips(store) {
  const t = store?.trust; if (!t || !(t.tx >= 10)) return "";
  return `<div class="ci-badges"><span class="ci-badge" style="color:#57534e;background:#f5f5f4">${Number(t.tx).toLocaleString("en-PH")} ${store.mode === "salon" || store.mode === "stay" ? "bookings" : "orders"} on TapTayo</span></div>`;
}

/** shop name with the badge glued to the last word (so the badge never drops to its own line) */
export function nameWithBadge(store) {
  const name = String(store?.name || "").trim(), b = trustBadge(store);
  if (!b) return esc(name);
  const i = name.lastIndexOf(" ");
  return `${i > 0 ? esc(name.slice(0, i + 1)) : ""}<span style="white-space:nowrap">${esc(name.slice(i + 1))}${b}</span>`;
}
