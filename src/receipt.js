// Digital receipt (customer side) — one look for orders, salon/spa bookings, home service and stays.
// Always says it is not an official receipt (TapTayo is not a BIR-accredited POS), and carries a small
// "Powered by TapTayo" link unless the shop is on a white-label plan (store.hideBranding).
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const peso = (n) => "₱" + Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const when = (d) => (d instanceof Date && !isNaN(d) ? d.toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" }) : "");

/**
 * r = { code, kind ("Order" | "Booking" | "Stay"), date: Date, rows: [[label, value]], lines: [{ name, sub?, amt }],
 *       adj: [[label, amount]] (negative = discount), total, paid: bool, paidText?, unpaidText?, note? }
 */
export function receiptHTML(store, r) {
  const adj = (r.adj || []).filter(([, a]) => a);
  return `<div class="c-receipt">
    <div class="rh">${store.logoUrl ? `<img src="${esc(store.logoUrl)}" alt=""/>` : ""}<b>${esc(store.name)}</b>${store.contact?.address ? `<div>${esc(store.contact.address)}</div>` : ""}${store.contact?.phone ? `<div>${esc(store.contact.phone)}</div>` : ""}</div>
    <div class="rl"><span>${esc(r.kind || "Order")}</span><span>${esc(r.code ? (String(r.code).startsWith("#") || r.kind !== "Order" ? r.code : "#" + r.code) : "")}</span></div>
    ${r.date ? `<div class="rl"><span>Date</span><span>${esc(when(r.date))}</span></div>` : ""}
    ${(r.rows || []).filter(([, v]) => v).map(([l, v]) => `<div class="rl"><span>${esc(l)}</span><span>${esc(v)}</span></div>`).join("")}
    <hr/>${(r.lines || []).map((l) => `<div class="rl"><span>${esc(l.name)}${l.sub ? `<br><small>${esc(l.sub)}</small>` : ""}</span><span>${peso(l.amt)}</span></div>`).join("")}<hr/>
    ${adj.map(([l, a]) => `<div class="rl"><span>${esc(l)}</span><span>${a < 0 ? "−" + peso(-a) : peso(a)}</span></div>`).join("")}
    <div class="rl big"><span>TOTAL</span><span>${peso(r.total)}</span></div>
    ${r.paid ? `<div class="rpaid">${esc(r.paidText || "PAID")}</div>` : `<div class="rl muted"><span>${esc(r.unpaidText || "Payment")}</span><span>Not paid yet</span></div>`}
    ${r.note ? `<p class="muted small" style="margin-top:10px">${esc(r.note)}</p>` : ""}
    <p class="muted small" style="text-align:center;margin-top:14px">This is your digital receipt. Thank you!</p>
    <p class="r-legal">This is not an official receipt.</p>
    ${store.hideBranding ? "" : `<a class="r-powered" href="https://taptayo.com/?ref=${encodeURIComponent(store.slug || "")}&amp;utm_source=receipt" target="_blank" rel="noopener"><img src="/logo/favicon.svg" alt="" width="16" height="16"/><span>Powered by <b>TapTayo</b> · taptayo.com</span><em>Free account</em></a>`}
  </div>`;
}

/** Footer buttons (Print / Save PDF, Share). makeEl = the page's html() helper that turns a string into an element. */
export function receiptFoot(makeEl, store, r) {
  const foot = makeEl(`<div class="c-ftrow"><button class="c-btn ghost" data-print>🖨 Print / Save PDF</button>${navigator.share ? `<button class="c-btn" data-share>Share</button>` : ""}</div>`);
  foot.querySelector("[data-print]").onclick = () => { document.body.classList.add("print-receipt"); window.print(); setTimeout(() => document.body.classList.remove("print-receipt"), 500); };
  foot.querySelector("[data-share]")?.addEventListener("click", () => navigator.share({ title: `${store.name} receipt ${r.code || ""}`.trim(), text: `${r.kind || "Order"} ${r.code || ""} · ${peso(r.total)} · ${r.paid ? "PAID" : "Not paid yet"}`, url: location.href }).catch(() => {}));
  return foot;
}

/** Salon / spa / home-service booking → receipt data */
export function apptReceiptData(a) {
  const lines = [...(a.items || []).map((l) => ({ name: `${(l.qty || 1) > 1 ? `${l.qty}× ` : ""}${l.name}`, sub: !l.retail && a.providerName ? `with ${a.providerName}` : "", amt: (l.price || 0) * (l.qty || 1) })),
    ...(a.homeService?.prep?.fee ? [{ name: "Items brought for you", sub: (a.homeService.prep.bring || []).join(", "), amt: a.homeService.prep.fee }] : [])];
  const prepFee = Number(a.homeService?.prep?.fee) || 0;
  const start = a.startAt?.toDate?.();
  return { kind: "Booking", code: a.code || "", date: start, rows: [["Where", a.homeService ? "Home service" : "In the shop"]], lines,
    adj: [["Home service fee", Math.max(0, (a.homeFee || 0) - prepFee)], ["Discount", -(a.discount || 0)], ["Downpayment", a.dp?.paid ? -(a.dp.amount || 0) : 0]],
    total: a.amountDue ?? (a.total || 0) + (a.homeFee || 0), paid: !!a.paid, paidText: `PAID${a.paymentMethod ? " · " + String(a.paymentMethod).toUpperCase() : ""}` };
}

/** Stay → receipt data (total = the stay's own running total: room + add-ons + pool + charges − discounts) */
export function stayReceiptData(s) {
  const ci = s.checkIn?.toDate?.(), co = s.checkOut?.toDate?.();
  const n = s.nightsCount || (ci && co ? Math.max(1, Math.round((co - ci) / 86400000)) : 1);
  const paid = Number(s.paidAmount || 0), total = Number(s.total || 0);
  const lines = [{ name: s.short ? `${s.short.hours}-hour stay` : `${n} night${n === 1 ? "" : "s"}`, sub: s.roomName || "", amt: s.subtotal ?? total },
    ...(s.addons || []).filter((x) => x.status !== "declined").map((x) => ({ name: `${x.qty > 1 ? `${x.qty}× ` : ""}${x.name || "Add-on"}`, amt: Number(x.amount) || 0 })),
    ...(s.poolFee ? [{ name: "Pool fee", amt: s.poolFee }] : []),
    ...(s.charges || []).map((c) => ({ name: c.label || c.name || c.reason || "Charge", amt: Number(c.amount) || 0 }))];
  return { kind: "Stay", code: s.code || "", date: ci, rows: [["Room", s.roomName || ""], ["Check-out", co ? co.toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" }) : ""], ["Guests", s.guests ? String(s.guests) : ""]],
    lines, adj: [["Discount", -(s.discount?.amount || 0)], ["Room notice discount", -(s.noticeDiscount?.amount || 0)]],
    total, paid: total > 0 && paid >= total, paidText: `PAID ${peso(paid)}`, unpaidText: paid ? `Paid ${peso(paid)} so far` : "Payment" };
}
