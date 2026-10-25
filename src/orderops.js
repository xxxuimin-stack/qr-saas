// Money-related order actions go through the server (checked by staff role there)
import { call } from "./firebase.js";
import { getActiveStaff } from "./staffauth.js";

/** orderOp(storeId, "cancel" | "pay" | "verify" | "unpay" | "deliveryFee" | "deliver" | "edit" | "comp", { orderId | orderIds, ... }) */
export async function orderOp(storeId, action, data = {}) {
  const me = getActiveStaff(storeId);
  try { return await call("orderOps", { action, ...data, staffToken: me?.token || null }); }
  catch (e) {
    if (/log in again|log in with your PIN/i.test(e.message || "")) { alert(e.message); try { localStorage.removeItem(`orderqr:staff:${storeId}`); } catch {} location.reload(); }
    throw e;
  }
}

/** Salon money actions: apptOp(storeId, "pay" | "collectHome" | "unpay", { id, ... }) */
export async function apptOp(storeId, action, data = {}) {
  const me = getActiveStaff(storeId);
  try { return await call("apptOps", { action, ...data, staffToken: me?.token || null }); }
  catch (e) {
    if (/log in again|log in with your PIN/i.test(e.message || "")) { alert(e.message); try { localStorage.removeItem(`orderqr:staff:${storeId}`); } catch {} location.reload(); }
    throw e;
  }
}
/** Payment methods to choose from when marking paid: Cash + the store's own methods (GCash, Maya…) */
export function payMethods(store) {
  const own = (store?.settings?.payments?.methods || []).filter((m) => m.enabled !== false && m.type !== "cash");
  const icon = { gcash: "📱", maya: "📱", bank: "🏦", card: "💳" };
  const list = [{ id: "cash", name: "Cash", icon: "💵" }, ...own.map((m) => ({ id: m.id, name: m.name, icon: icon[m.type] || "💳" }))];
  if (list.length === 1) list.push({ id: "gcash", name: "GCash", icon: "📱" }, { id: "maya", name: "Maya", icon: "📱" }, { id: "card", name: "Card", icon: "💳" });
  return list;
}
