// Manual contact from the owner's own phone (no SMS credits): call, text with a ready message, copy for Messenger/Viber.
import { call } from "./firebase.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const fmtWhen = (ms) => new Date(ms).toLocaleString("en-PH", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
export const fmtTime = (ms) => new Date(ms).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" });
const first = (a) => (a.customer?.name || "").split(" ")[0] || "there";
const dayWord = (ms) => { const d = new Date(ms), t = new Date(); t.setHours(0, 0, 0, 0); const diff = Math.round((new Date(d).setHours(0, 0, 0, 0) - t) / 864e5); return diff === 0 ? "today" : diff === 1 ? "tomorrow" : new Date(ms).toLocaleDateString("en-PH", { weekday: "long", month: "short", day: "numeric" }); };

/** ready-to-send messages (Taglish, short) */
export const MSG = {
  confirm: (a, store, link) => `Hi ${first(a)}! Reminder from ${store.name}: your ${a.homeService ? "home service" : "appointment"} is ${dayWord(a.startAt.toMillis())} at ${fmtTime(a.startAt.toMillis())} (${(a.items || []).map((l) => l.name).join(", ")}). Are we still on? You can also reply here: ${link}`,
  onway: (a, store, eta) => `Hi ${first(a)}! I'm on my way${eta ? ` — about ${eta} minutes` : ""}. — ${store.name}`,
  sick: (a, store, link) => `Hi ${first(a)}, sorry — I can't make it ${dayWord(a.startAt.toMillis())}. Please pick a new time here: ${link} Thank you! — ${store.name}`,
  moved: (a, store) => `Hi ${first(a)}! Your appointment has been moved to ${fmtWhen(a.startAt.toMillis())}. See you! — ${store.name}`,
};

export const telHref = (phone) => `tel:${String(phone || "").replace(/[^\d+]/g, "")}`;
// iOS uses "&body=", Android "?body=" — "?&body=" works on both
export const smsHref = (phone, body) => `sms:${String(phone || "").replace(/[^\d+]/g, "")}?&body=${encodeURIComponent(body)}`;
/** Waze link from a map pin that has coordinates (…?q=lat,lng or …@lat,lng) */
export const wazeHref = (hs) => { const m = /(?:q=|@|ll=)(-?\d+\.\d+),\s*(-?\d+\.\d+)/.exec(hs?.mapUrl || ""); return m ? `https://waze.com/ul?ll=${m[1]},${m[2]}&navigate=yes` : null; };
/** links row for a home-service visit: Google Maps · Waze · valid ID */
export const homeLinksHTML = (hs, esc) => [mapsHref(hs) ? `<a href="${esc(mapsHref(hs))}" target="_blank" rel="noopener">🗺 Google Maps</a>` : "", wazeHref(hs) ? `<a href="${esc(wazeHref(hs))}" target="_blank" rel="noopener">🚗 Waze</a>` : "", hs?.idUrl ? `<a data-priv="${esc(hs.idUrl)}" target="_blank" rel="noopener">🪪 ID on file</a>` : ""].filter(Boolean).join(" · ");
export const mapsHref = (hs) => hs?.mapUrl || (hs?.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([hs.address, hs.area].filter(Boolean).join(", "))}` : null);

/** the link the client opens to confirm / move / cancel */
export async function visitLink(a, staffToken) {
  const r = await call("apptLink", { id: a.id, staffToken: staffToken || null });
  return `${location.origin}${r.path}`;
}

/** a row of contact buttons; kind = confirm | sick | moved */
export function contactRow(a, store, { kind = "confirm", staffToken = null, onContacted } = {}) {
  const wrap = document.createElement("div"); wrap.className = "ct-row";
  const phone = a.customer?.phone;
  if (!phone) { wrap.innerHTML = `<span class="small muted">No phone number on this booking.</span>`; return wrap; }
  wrap.innerHTML = `<a class="ct-btn" href="${esc(telHref(phone))}" aria-label="Call ${esc(a.customer?.name || "")}">📞 Call</a><button type="button" class="ct-btn" data-sms>💬 Text</button><button type="button" class="ct-btn" data-copy>📋 Copy message</button>`;
  const getMsg = async () => (kind === "moved" ? MSG.moved(a, store) : MSG[kind](a, store, await visitLink(a, staffToken)));
  wrap.querySelector("[data-sms]").onclick = async (e) => { e.target.disabled = true; try { location.href = smsHref(phone, await getMsg()); onContacted?.(); } catch (x) { alert(x.message); } e.target.disabled = false; };
  wrap.querySelector("[data-copy]").onclick = async (e) => { try { const m = await getMsg(); await navigator.clipboard.writeText(m); e.target.textContent = "✓ Copied"; onContacted?.(); setTimeout(() => (e.target.textContent = "📋 Copy message"), 2000); } catch (x) { alert(x.message); } };
  return wrap;
}

/** "On my way": saves the ETA on the booking (client sees it) and opens a ready text */
export async function onMyWay(a, store, staffToken) {
  const v = prompt("ETA in minutes (shown to the client):", "20"); if (v == null) return;
  const eta = Math.max(0, Math.min(240, Number(v) || 0));
  // while on home service, show customers "On home service · back ~time" (Settings → Salon → shop status on home service)
  const mode = store.settings?.salon?.homeAway || "ask";
  const solo = store.settings?.setup?.kind === "solo";
  const away = a.homeService && mode !== "open" && (mode === "close" || (solo ? confirm("Show your shop as “On home service” until you're back?\n\nOK = yes, customers see when you'll be back.\nCancel = keep the shop open.") : false));
  await call("apptOnTheWay", { id: a.id, etaMin: eta, away, staffToken: staffToken || null });
  if (a.customer?.phone) location.href = smsHref(a.customer.phone, MSG.onway(a, store, eta));
}

export const VISIT_TAG = { waiting: ["⏳ Not confirmed yet", "#b45309"], yes: ["✅ Client confirmed", "#15803d"], moved: ["🔁 Moved by client", "#1d4ed8"], no: ["❌ Can't make it", "#b42318"] };
