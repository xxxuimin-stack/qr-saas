// 💬 Messenger links on bookings — the client adds theirs (faster contact), the shop / freelancer adds theirs.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** "m.me/name", "facebook.com/name", "messenger.com/t/name" or a bare username → https://m.me/name ("" if it doesn't look right) */
export function msgrLink(v) {
  const t = String(v || "").trim(); if (!t) return "";
  const m = /(?:m\.me|messenger\.com\/t|facebook\.com|fb\.com)\/(?:profile\.php\?id=)?([A-Za-z0-9.]{3,80})/i.exec(t) || /^@?([A-Za-z0-9.]{3,50})$/.exec(t);
  return m && !/^(share|groups|pages|watch|login|people)$/i.test(m[1]) ? `https://m.me/${m[1]}` : "";
}
/** the optional input on booking forms */
export function msgrField(saved = {}, label = "Messenger") {
  return `<label>${label} <span class="muted small">(optional — for faster replies)</span></label><input data-msgr inputmode="url" autocomplete="url" placeholder="m.me/yourname or your Facebook link" value="${esc(saved.messenger || "")}" maxlength="120"/>`;
}
export const readMsgr = (root) => root.querySelector("[data-msgr]")?.value.trim() || "";
/** a small "💬 Messenger" button (staff / owner side, or the client's status page) */
export function msgrBtn(v, cls = "btn sm ghost", text = "💬 Messenger") {
  const u = msgrLink(v); return u ? `<a class="${cls}" href="${esc(u)}" target="_blank" rel="noopener">${text}</a>` : "";
}
