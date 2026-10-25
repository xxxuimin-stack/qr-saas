// SALON / SPA PROMOS — shared by the server (functions/salonpromo.js) and the customer page (src/salonpromo.js, ESM copy).
// Promo fields: type percent | amount | bundle | free_home_fee · value · audience all | first_visit | couple | code
// place any | shop | home · staffIds [] · allItems / categoryIds / itemIds · schedule (checked at the SESSION time) · maxUses / usedCount · perCustomer
const SP_DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const r2 = (n) => Math.round(n * 100) / 100;

/** is the promo valid for a session at time `at` (ms, Philippine time rules) */
function promoAt(p, at) {
  if (!p || p.active === false) return false;
  const ph = new Date(Number(at || Date.now()) + 8 * 3600 * 1000);
  const ymd = ph.toISOString().slice(0, 10), hm = ph.toISOString().slice(11, 16), day = SP_DAYS[ph.getUTCDay()];
  const s = p.schedule || {};
  if (s.dateFrom && ymd < s.dateFrom) return false;
  if (s.dateTo && ymd > s.dateTo) return false;
  if (s.days && s.days.length && !s.days.includes(day)) return false;
  if (s.start && hm < s.start) return false;
  if (s.end && hm > s.end) return false;
  return true;
}
function salonPromoOk(p, c) {
  if (!promoAt(p, c.at)) return false;
  const aud = p.audience || "all";
  if (aud === "first_visit" && !(c.firstVisit === true || (c.preview && c.firstVisit == null))) return false;
  if (aud === "couple" && c.pax !== 2) return false;
  if (aud === "code" && !(c.codes || []).includes(p.id)) return false;
  if (p.place === "shop" && c.home) return false;
  if (p.place === "home" && !c.home) return false;
  if (p.staffIds && p.staffIds.length && !(c.providerId && p.staffIds.includes(c.providerId))) return false;
  if (p.maxUses && (Number(p.usedCount) || 0) >= Number(p.maxUses)) return false;
  if (c.blocked && c.blocked.includes(p.id)) return false;
  return true;
}
const promoHits = (p, l) => !!(p.allItems || (p.itemIds || []).includes(l.itemId) || (p.categoryIds || []).includes(l.categoryId));
function salonPromoTag(p) {
  if (!p) return "";
  if (p.type === "percent") return `-${p.value}%`;
  if (p.type === "amount") return `₱${p.value} off`;
  if (p.type === "bundle") return `Combo ₱${p.value}`;
  if (p.type === "free_home_fee") return "Free transport";
  return p.name || "Promo";
}
/**
 * c: { lines:[{itemId, categoryId, price}], at, home, pax, firstVisit, codes, providerId, preview, blocked }
 * → { lines:[discount per line], discount, homeFeeWaived, applied:[{id,name,label,amount,audience}] }
 */
function calcSalonPromos(promos, c) {
  const lines = (c.lines || []).map((l) => ({ ...l, price: Number(l.price) || 0 }));
  const ok = (promos || []).filter((p) => salonPromoOk(p, c));
  const per = lines.map(() => ({ d: 0, p: null }));
  lines.forEach((l, i) => {
    for (const p of ok) {
      if (!["percent", "amount"].includes(p.type) || p.stack || !promoHits(p, l)) continue;
      const v = Number(p.value) || 0;
      const d = p.type === "percent" ? r2((l.price * Math.min(100, v)) / 100) : r2(Math.min(v, l.price));
      if (d > per[i].d) per[i] = { d, p };
    }
  });
  // combos: all the combo's services in this booking → combo price (if better than the per-service promos)
  const used = new Set();
  const bundles = ok.filter((p) => p.type === "bundle" && (p.itemIds || []).length >= 2)
    .map((p) => { const idx = []; for (const id of p.itemIds) { const i = lines.findIndex((l, k) => l.itemId === id && !idx.includes(k)); if (i < 0) return null; idx.push(i); } const base = idx.reduce((x, i) => x + lines[i].price, 0); return { p, idx, d: r2(Math.max(0, base - (Number(p.value) || 0))) }; })
    .filter(Boolean).sort((a, b) => b.d - a.d);
  for (const b of bundles) {
    if (b.idx.some((i) => used.has(i))) continue;
    const cur = b.idx.reduce((x, i) => x + per[i].d, 0);
    if (b.d <= cur) continue;
    b.idx.forEach((i, k) => { used.add(i); per[i] = { d: k === 0 ? b.d : 0, p: b.p }; });
  }
  // "add on top" promos (e.g. couple ₱100 off, first visit 10%): applied after the best promo, on what is left
  const extra = lines.map(() => []);
  for (const p of ok.filter((x) => x.stack && ["percent", "amount"].includes(x.type))) {
    lines.forEach((l, i) => {
      if (!promoHits(p, l)) return;
      const left = l.price - per[i].d - extra[i].reduce((x, y) => x + y.d, 0); if (left <= 0) return;
      const v = Number(p.value) || 0; const d = p.type === "percent" ? r2((left * Math.min(100, v)) / 100) : r2(Math.min(v, left));
      if (d > 0) extra[i].push({ d, p });
    });
  }
  const discount = r2(per.reduce((x, y) => x + y.d, 0) + extra.flat().reduce((x, y) => x + y.d, 0));
  const after = lines.reduce((x, l) => x + l.price, 0) - discount;
  const fh = c.home ? ok.find((p) => p.type === "free_home_fee" && after >= (Number(p.value) || 0)) : null;
  const applied = {};
  [...per, ...extra.flat()].forEach((x) => { if (x.p && x.d > 0) { const a = (applied[x.p.id] = applied[x.p.id] || { id: x.p.id, name: x.p.name || "", label: salonPromoTag(x.p), amount: 0, audience: x.p.audience || "all" }); a.amount = r2(a.amount + x.d); } });
  if (fh) applied[fh.id] = { id: fh.id, name: fh.name || "", label: salonPromoTag(fh), amount: 0, audience: fh.audience || "all", homeFee: true };
  return { lines: per.map((x, i) => r2(x.d + extra[i].reduce((a, y) => a + y.d, 0))), discount, homeFeeWaived: !!fh, applied: Object.values(applied) };
}
/** best promo tag to show on a service in the list (now, any audience shown with a note) */
function servicePromo(promos, item, at) {
  const l = { itemId: item.id, categoryId: item.categoryId, price: Number(item.price) || 0 };
  let best = null;
  for (const p of promos || []) {
    if (!["percent", "amount"].includes(p.type) || !promoAt(p, at) || !promoHits(p, l) || p.audience === "code") continue;
    if (p.maxUses && (Number(p.usedCount) || 0) >= Number(p.maxUses)) continue;
    const v = Number(p.value) || 0; const d = p.type === "percent" ? r2((l.price * Math.min(100, v)) / 100) : r2(Math.min(v, l.price));
    if (!best || d > best.d) best = { p, d };
  }
  return best;
}
module.exports = { promoAt, salonPromoOk, calcSalonPromos, servicePromo, salonPromoTag, promoHits };
