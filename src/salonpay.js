// Staff pay per appointment: sum of each service's staffPay (fixed ₱ or % of price).
export function commissionFor(a) {
  return Math.round((a.items || []).reduce((sum, l) => {
    const p = l.staffPay; if (!p) return sum;
    const q = Number(l.qty) || 1;
    return sum + (p.type === "percent" ? (Number(l.price) || 0) * q * (Number(p.value) || 0) / 100 : (Number(p.value) || 0) * q);
  }, 0) * 100) / 100;
}

// Stylist schedule (same rules as the server): weekly days, daily break, leave dates — PH time.
const WEEK = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const hmMin = (v) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || "")); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
export function offReason(st, s, e = s + 60000) {
  const sc = st?.schedule; if (!sc) return null;
  const ph = new Date(s + 8 * 3600e3); const ymd = ph.toISOString().slice(0, 10);
  if ((sc.leaves || []).includes(ymd)) return "on leave";
  const sm = ph.getUTCHours() * 60 + ph.getUTCMinutes(), em = sm + (e - s) / 60000;
  if (sc.days && Object.keys(sc.days).length) {
    const day = sc.days[WEEK[ph.getUTCDay()]];
    if (!day?.on) return "on a day off";
    const a = hmMin(day.from), b = hmMin(day.to);
    if ((a != null && sm < a) || (b != null && b > (a || 0) && em > b)) return "off duty at that time";
  }
  const bf = hmMin(sc.breakFrom), bt = hmMin(sc.breakTo);
  if (bf != null && bt != null && bt > bf && sm < bt && em > bf) return "on break";
  return null;
}
/** Order-like object for printReceipt() from a salon appointment */
export function apptReceipt(a) {
  const items = [...(a.items || []).map((l) => ({ name: l.name + (l.retail ? "" : a.providerName ? ` (${a.providerName})` : ""), qty: l.qty || 1, subtotal: l.price * (l.qty || 1), choices: [] })),
    ...(a.homeFee ? [{ name: "Home service fee", qty: 1, subtotal: a.homeFee, choices: [] }] : [])];
  return { orderNo: a.code, items, total: a.amountDue ?? (a.total || 0) + (a.homeFee || 0), paid: a.paid, paymentMethod: a.paymentMethod, paidAt: a.paidAt, createdAt: a.startAt, customer: a.customer, serviceType: a.homeService ? "delivery" : "dine_in", voucher: a.voucher || null, discounts: { promo: (a.discounts?.loyalty || 0) + (a.discounts?.package || 0) + (a.discounts?.dp || 0) } };
}
