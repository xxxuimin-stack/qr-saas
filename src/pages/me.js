// "Me" tab (phones) — layout B: red header with the shop + plan, today's numbers, a grid of big icon tiles, invite banner, account list.
import { db } from "../firebase.js";
import { doc, getDoc } from "firebase/firestore";
import { esc } from "../ui.js";
import { PLANS, planOf } from "../plans.js";

const I = {
  shop: '<path d="M3 9l1.5-5h15L21 9"/><path d="M4 9v11h16V9"/><path d="M9 20v-6h6v6"/>',
  hours: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  pay: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M16 12h2"/>',
  qr: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3zM20 14v7h-6"/>',
  staff: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>',
  promo: '<path d="M3 12V3h9l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  collab: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>',
  rooms: '<path d="M3 20V8l9-5 9 5v12"/><path d="M9 20v-6h6v6"/>',
  gift: '<rect x="3" y="8" width="18" height="13" rx="1"/><path d="M12 8v13M3 12h18"/><path d="M12 8c-2-4-6-4-6-1s4 1 6 1c2 0 6 2 6-1s-4-3-6 1z"/>',
  card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .8-1 1.7"/><path d="M12 17h.01"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  out: '<path d="M15 4h4v16h-4"/><path d="M10 8l-4 4 4 4M6 12h10"/>',
  swap: '<path d="M7 4L3 8l4 4"/><path d="M3 8h14"/><path d="M17 20l4-4-4-4"/><path d="M21 16H7"/>',
};
const svg = (k, s = 22, w = 2) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[k]}</svg>`;
const CSS = `.me-wrap{margin:-16px -16px 0;font-family:inherit}.me-head{background:#C62828;color:#fff;padding:20px 16px 56px}.me-row{display:flex;align-items:center;gap:12px}.me-ava{width:48px;height:48px;border-radius:50%;background:#fff;color:#C62828;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;overflow:hidden;flex-shrink:0}.me-ava img{width:100%;height:100%;object-fit:cover}.me-sw{height:36px;border-radius:999px;border:1.5px solid #fff;background:transparent;color:#fff;font:600 13px inherit;padding:0 12px;display:flex;align-items:center;gap:6px;cursor:pointer;text-decoration:none}
.me-stats{margin:-40px 16px 0;background:#fff;border-radius:20px;padding:14px 8px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));box-shadow:0 6px 20px rgba(17,17,17,.08)}.me-stats div{display:flex;flex-direction:column;align-items:center;gap:2px}.me-stats div+div{border-left:1px solid #F3F4F6}.me-stats b{font-size:18px}.me-stats span{font-size:12px;color:#4B5563}
.me-body{padding:18px 16px 24px;display:flex;flex-direction:column;gap:12px}.me-h{font-size:14px;font-weight:700;margin:4px 0 0}.me-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px 6px}.me-tile{position:relative;display:flex;flex-direction:column;align-items:center;gap:6px;text-decoration:none;color:#111;font-size:12px;font-weight:500;text-align:center}.me-tile i{width:52px;height:52px;border-radius:16px;background:#fff;border:1px solid #E5E7EB;display:flex;align-items:center;justify-content:center}.me-tile em{position:absolute;top:-4px;right:2px;font-style:normal;font-size:9px;font-weight:700;color:#fff;background:#16A34A;border-radius:999px;padding:1px 6px}
.me-banner{display:flex;align-items:center;gap:12px;background:#FFF7E6;border:1px solid #FDE68A;border-radius:16px;padding:12px 14px;text-decoration:none;color:#111}.me-banner i{width:40px;height:40px;border-radius:12px;background:#fff;color:#B45309;display:flex;align-items:center;justify-content:center;flex-shrink:0}.me-list{background:#fff;border-radius:16px;border:1px solid #E5E7EB;overflow:hidden}.me-li{display:flex;align-items:center;gap:12px;padding:13px 14px;text-decoration:none;color:#111;font-size:14px;font-weight:500;width:100%;background:none;border:0;font-family:inherit;cursor:pointer;text-align:left;min-height:48px;box-sizing:border-box}.me-li+.me-li{border-top:1px solid #F3F4F6}.me-li span{flex-grow:1}.me-li small{color:#6B7280;font-size:12px}`;

export function renderMePage(root, ctx) {
  const { store, storeId } = ctx; const mode = store.mode; const fl = store.businessType === "freelance";
  if (!document.getElementById("mecss")) { const s = document.createElement("style"); s.id = "mecss"; s.textContent = CSS; document.head.appendChild(s); }
  const eff = planOf(ctx.sub); const plan = PLANS[eff]?.name || "Free";
  const rating = store.stats?.ratingCount ? (store.stats.ratingSum / store.stats.ratingCount).toFixed(1) : "—";
  const owner = ctx.role === "owner" || ctx.claims?.role === "owner";
  const color = { shop: "#C62828", staff: "#1D4ED8", promo: "#B45309", collab: "#15803D", bell: "#6D28D9" };
  const T = [
    ["shop", "Shop info", "#tools/shop:info"], ["hours", "Hours", "#tools/shop:hours"], ["pay", "Payments", "#tools/selling:payments"],
    mode === "stay" ? ["rooms", "Rooms", "#rooms"] : ["qr", fl ? "Link & QR" : "QR & link", "#tables"],
    ["staff", "Staff", "#staff"], mode === "stay" ? ["promo", "Stay rules", "#tools/booking:stay"] : ["promo", "Promos", "#promos"],
    ["bell", "Alerts", "#tools/alerts:telegram"],
  ];
  root.innerHTML = `<div class="me-wrap">
    <div class="me-head"><div class="me-row"><div class="me-ava">${store.logoUrl && !/icon-512/.test(store.logoUrl) ? `<img src="${esc(store.logoUrl)}" alt=""/>` : esc((store.name || "?").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase())}</div>
      <div style="flex-grow:1;min-width:0"><div style="font-weight:700;font-size:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(store.name)}</div><div style="font-size:13px;color:#FDE2E2">${owner ? "Owner" : "Staff"} · ${esc(plan)} plan</div></div>
      ${owner ? `<a class="me-sw" href="#branches">${svg("swap", 14, 2.4)}Switch</a>` : ""}</div></div>
    <div class="me-stats"><div><b data-today>…</b><span>${mode === "salon" || mode === "stay" ? "Bookings · month" : mode === "laundry" ? "Jobs today" : "Orders today"}</span></div><div><b>${rating === "—" ? "—" : `${rating} ★`}</b><span>Rating</span></div><div><b data-credits>${store.credits ? `₱${Number(store.credits).toLocaleString("en-PH")}` : esc(eff === "trial" ? "Trial" : plan)}</b><span>${store.credits ? "Credits" : "Plan"}</span></div></div>
    <div class="me-body">
      <div class="me-h">Manage</div>
      <div class="me-grid">${T.map(([k, t, h, n]) => `<a class="me-tile" href="${h}"><i style="color:${color[k] || "#C62828"};${k === "collab" ? "background:#ECFDF3;border-color:#BBF7D0" : ""}">${svg(k)}</i>${esc(t)}${n ? "<em>NEW</em>" : ""}</a>`).join("")}</div>
      ${owner ? `<a class="me-banner" href="#billing"><i>${svg("gift", 20)}</i><span style="flex-grow:1"><b style="display:block;font-size:14px">Invite a business</b><span style="font-size:12px;color:#4B5563">Get 1 month free for each</span></span><span aria-hidden="true">›</span></a>` : ""}
      <div class="me-h">Account</div>
      <div class="me-list">
        ${owner ? `<a class="me-li" href="#billing">${svg("card", 18)}<span>Plan &amp; billing</span><small>${esc(plan)}</small></a>` : ""}
        <a class="me-li" href="#tools">${svg("gear", 18)}<span>All settings</span></a>
        <button type="button" class="me-li" data-help>${svg("help", 18)}<span>Help &amp; chat</span><small>reply in 24 h</small></button>
        <a class="me-li" href="/me/">${svg("user", 18)}<span>My TapTayo</span><small>my bookings as a client</small></a>
        <button type="button" class="me-li" data-menu>${svg("menu", 18)}<span>Full menu</span></button>
        <button type="button" class="me-li" data-out style="color:#B42318">${svg("out", 18)}<span>Log out</span></button>
      </div>
    </div></div>`;
  root.querySelector("[data-help]").onclick = () => document.getElementById("helpBtn")?.click();
  root.querySelector("[data-menu]").onclick = (e) => { e.stopPropagation(); document.getElementById("navToggle")?.click(); };
  root.querySelector("[data-out]").onclick = () => document.getElementById("logoutBtn")?.click();
  getDoc(doc(db, "stores", storeId, "stats", "usage")).then((s) => {
    const u = s.data() || {}; const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); const mon = day.slice(0, 7);
    root.querySelector("[data-today]").textContent = mode === "salon" || mode === "stay" ? (u.month === mon ? u.bookings || 0 : 0) : u.day === day ? Math.max(0, (u.orders || 0) - (u.cancelledDay === day ? u.cancelled || 0 : 0)) : 0;
  }).catch(() => (root.querySelector("[data-today]").textContent = "—"));
}
