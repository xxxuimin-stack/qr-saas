import { feat } from "./staffauth.js";
// Café/restaurant station flow (Counter is the hub):
//   Counter accepts → Kitchen (food) / Barista (drinks, beer, liquor) / Counter (ready-made)
//   Kitchen "Cooked" → Dispatch checks plating → "Ready to serve" → crew serves → Dispatch "Served"
//   Barista "Ready" → "Served" (barista serves drinks directly)
//   Pickup / delivery / take-out: Dispatch packs everything (food + drinks) → order Ready → Counter hands over
// stations[key] = "pending" | "ready" | "served"
export const RANK = { pending: 0, ready: 1, served: 2 };
export const PACKED = (o) => o.serviceType === "pickup" || o.serviceType === "delivery" || o.serviceType === "take_out";
export const dispatchOn = (store) => store?.mode === "table" && store?.settings?.service?.dispatch !== false && feat("dispatch");

/** station map, filled in from the item lines when missing */
export function stationsOf(o) {
  const st = { ...(o.stations || {}) };
  for (const l of o.items || []) { const k = l.station || "kitchen"; if (!st[k]) st[k] = "pending"; }
  return st;
}
export const hasKitchen = (o) => Object.prototype.hasOwnProperty.call(stationsOf(o), "kitchen");

/** order status from the station map */
export function statusFrom(o, stations, store) {
  const disp = dispatchOn(store);
  const keys = Object.keys(stations);
  if (!keys.length) return o.status;
  if (PACKED(o)) {
    // packed orders become Ready when Dispatch packs them (or, without Dispatch, when every station is ready)
    if (disp) return o.dispatch?.packedAt ? "ready" : "preparing";
    return keys.every((k) => RANK[stations[k]] >= 1) ? "ready" : "preparing";
  }
  const lvl = keys.map((k) => (k === "kitchen" && disp && stations[k] === "ready" && !o.dispatch?.readyAt ? 0 : RANK[stations[k]] || 0));
  const min = Math.min(...lvl);
  return min >= 2 ? "completed" : min >= 1 ? "ready" : "preparing";
}

/** Firestore patch: set some stations to a value and recompute the order status */
export function stationPatch(o, keys, value, store, extra = {}) {
  const stations = stationsOf(o);
  keys.forEach((k) => { if (k in stations) stations[k] = value; });
  const next = { ...o, ...extra, stations };
  const status = statusFrom(next, stations, store);
  const p = { ...extra, stations };
  if (status !== o.status) {
    p.status = status;
    if (status === "ready") p.readyAt = new Date();
    if (status === "completed") p.completedAt = new Date();
  }
  return p;
}

/** does this order need Dispatch right now? */
export function atDispatch(o, store) {
  if (!dispatchOn(store) || !["preparing", "ready", "pending"].includes(o.status)) return false;
  const st = stationsOf(o);
  if (PACKED(o)) return !o.dispatch?.packedAt && Object.values(st).some((v) => v !== "pending") && (st.kitchen ? st.kitchen !== "pending" : Object.values(st).every((v) => v !== "pending"));
  return st.kitchen === "ready";
}
