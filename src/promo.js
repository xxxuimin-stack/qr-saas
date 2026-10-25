// PROMO ENGINE — shared logic for the server (functions) and the client (src/promo.js is the ESM copy).
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Is the promo active right now (Philippine time)? */
export function promoActive(p, now = new Date()) {
  if (!p || p.active === false) return false;
  const ph = new Date(now.getTime() + 8 * 3600 * 1000);
  const ymd = ph.toISOString().slice(0, 10), hm = ph.toISOString().slice(11, 16), day = DAYS[ph.getUTCDay()];
  const s = p.schedule || {};
  if (s.dateFrom && ymd < s.dateFrom) return false;
  if (s.dateTo && ymd > s.dateTo) return false;
  if (s.days && s.days.length && !s.days.includes(day)) return false;
  if (s.start && hm < s.start) return false;
  if (s.end && hm > s.end) return false;
  return true;
}

/** Find the best promo for an item */
/** ctx: { vip } — VIP-room order. item.adult = beer/liquor (18+ category) */
export function promoForItem(item, promos, now, ctx = {}) {
  const list = (promos || []).filter((p) => p.type !== "free_delivery" && promoActive(p, now)
    && (!p.validFor || p.validFor === "all" || (p.validFor === "vip" && ctx.vip) || (p.validFor === "vip_adult" && ctx.vip && item.adult) || (p.validFor === "adult" && item.adult))
    && (p.allItems || (p.itemIds || []).includes(item.id) || (p.categoryIds || []).includes(item.categoryId)));
  return list[0] || null;
}
/** Active free-delivery promo that this subtotal qualifies for (value = minimum order) */
export function freeDeliveryPromo(promos, subtotal, now) {
  return (promos || []).find((p) => p.type === "free_delivery" && promoActive(p, now) && subtotal >= (Number(p.value) || 0)) || null;
}

/**
 * Discount for a single order line. basePrice = item price without options; unitPrice = including options.
 * returns { discount, label }
 */
export function lineDiscount(promo, basePrice, unitPrice, qty) {
  if (!promo) return { discount: 0, label: "" };
  const v = Number(promo.value) || 0;
  if (promo.type === "percent") return { discount: round2(unitPrice * qty * v / 100), label: `-${v}%` };
  if (promo.type === "amount") return { discount: round2(Math.min(v, basePrice) * qty), label: `-₱${v}` };
  if (promo.type === "bogo") return { discount: round2(Math.floor(qty / 2) * basePrice), label: "Buy 1 Take 1" };
  return { discount: 0, label: "" };
}
export const round2 = (n) => Math.round(n * 100) / 100;

export function promoLabel(p) {
  if (!p) return "";
  if (p.type === "percent") return `-${p.value}%`;
  if (p.type === "amount") return `-₱${p.value}`;
  if (p.type === "bogo") return "B1T1";
  if (p.type === "free_delivery") return "Free delivery";
  return p.name || "Promo";
}

/** Voucher check (no DB access). returns { ok, discount, reason } */
export function voucherDiscount(v, { subtotal, serviceType, customerKey, now = new Date() }) {
  if (!v || v.active === false) return { ok: false, reason: "Invalid voucher." };
  const ms = now.getTime();
  const from = v.validFrom ? new Date(v.validFrom + "T00:00:00+08:00").getTime() : 0;
  const to = v.validTo ? new Date(v.validTo + "T23:59:59+08:00").getTime() : Infinity;
  if (ms < from) return { ok: false, reason: "This voucher isn't valid yet." };
  if (ms > to) return { ok: false, reason: "This voucher has expired." };
  if (v.maxUses && (v.usedCount || 0) >= v.maxUses) return { ok: false, reason: "This voucher has been fully redeemed." };
  if (v.services && v.services.length && !v.services.includes(serviceType)) return { ok: false, reason: "This voucher can't be used for this service type." };
  if (v.minOrder && subtotal < v.minOrder) return { ok: false, reason: `Minimum order of ₱${v.minOrder} for this voucher.` };
  if (v.perCustomer && customerKey && (v.usedBy?.[customerKey] || 0) >= v.perCustomer) return { ok: false, reason: "You've already used this voucher." };
  let discount = v.type === "percent" ? subtotal * (Number(v.value) || 0) / 100 : Number(v.value) || 0;
  if (v.maxDiscount) discount = Math.min(discount, v.maxDiscount);
  discount = round2(Math.min(discount, subtotal));
  return { ok: true, discount };
}


/** Overtime penalty: whole minutes only (no seconds). returns { overMin, penalty } */
export function overtimeFor(ot, startedMs, plannedHours, nowMs = Date.now()) {
  if (!ot?.enabled) return { overMin: 0, penalty: 0 };
  const overMin = Math.floor((nowMs - (startedMs + plannedHours * 3600000)) / 60000);
  if (overMin <= 0) return { overMin: 0, penalty: 0 };
  const penalty = (ot.firstFee || 0) + Math.max(0, overMin - (ot.firstMinutes || 5)) * (ot.perMinute || 0);
  return { overMin, penalty: Math.round(penalty * 100) / 100 };
}
export function overtimeClause(ot) {
  if (!ot?.enabled) return "";
  return `OVERTIME: If you go past your booked hours, an extra ₱${ot.firstFee} applies for the first ${ot.firstMinutes} minutes, then ₱${ot.perMinute} per minute after that (counted in whole minutes, not seconds). This is calculated when the session ends / at payment.`;
}
