// Receipt / ticket printing via the browser (Option A). Opens a small print window sized for 58mm/80mm rolls.
// Tip (Windows): run Chrome with --kiosk-printing to skip the dialog and print straight to the default printer.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n, c = "PHP") => (c === "PHP" ? "P" : c + " ") + Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const SVC = { dine_in: "Dine-in", take_out: "Take-out", pickup: "Pickup", delivery: "Delivery" };

export const printCfg = (store) => ({ enabled: false, paper: 58, header: "", footer: "Thank you!", logo: false, autoOrder: false, autoPaid: false, autoStub: true, kitchenTicket: false, ...(store.settings?.printing || {}) });

/** Open a print window with the given inner HTML (receipt styles applied). */
export function printHTML(innerHTML, { paper = 58, title = "Print" } = {}) {
  const w = window.open("", "_blank", "width=420,height=700");
  if (!w) { alert("Allow pop-ups for this site to print."); return false; }
  const width = paper === 80 ? "72mm" : "48mm";
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
    @page { margin: 2mm; size: ${paper}mm auto; }
    body { font-family: "Courier New", Courier, monospace; font-size: ${paper === 80 ? "12px" : "11px"}; width: ${width}; margin: 0 auto; color: #000; }
    .c { text-align: center; } .b { font-weight: 700; } .big { font-size: 1.6em; font-weight: 900; } .xl { font-size: 2.4em; font-weight: 900; }
    .row { display: flex; justify-content: space-between; gap: 6px; } .row span:first-child { flex: 1; }
    hr { border: 0; border-top: 1px dashed #000; margin: 5px 0; }
    .sm { font-size: .9em; } .mt { margin-top: 6px; } img.logo { max-width: 60%; max-height: 60px; display: block; margin: 0 auto 4px; }
    img.qr { width: 140px; height: 140px; display: block; margin: 4px auto; }
    .policy { font-size: .85em; text-align: left; border-top: 1px dashed #000; margin-top: 6px; padding-top: 4px; }
  </style></head><body>${innerHTML}<script>window.onload=function(){setTimeout(function(){window.print();setTimeout(function(){window.close()},300)},150)}</script></body></html>`);
  w.document.close();
  return true;
}

function headerHTML(store, cfg) {
  return `<div class="c">${cfg.logo && store.logoUrl ? `<img class="logo" src="${esc(store.logoUrl)}"/>` : ""}<div class="big">${esc(store.name)}</div>${store.contact?.address ? `<div class="sm">${esc(store.contact.address)}</div>` : ""}${store.contact?.phone ? `<div class="sm">${esc(store.contact.phone)}</div>` : ""}${cfg.header ? `<div class="sm">${esc(cfg.header).replace(/\n/g, "<br>")}</div>` : ""}</div><hr/>`;
}

/** Customer receipt (café / laundry). orders: one order or an array (merged bill). */
export function printReceipt(store, orders, { cur = "PHP", cashTendered = null, staffName = "" } = {}) {
  const cfg = printCfg(store);
  const list = Array.isArray(orders) ? orders : [orders];
  const first = list[0];
  const total = list.reduce((a, o) => a + (o.total || 0), 0);
  const d = first.createdAt?.toDate?.() || new Date();
  const lines = list.flatMap((o) => (o.items || []).map((l) => `<div class="row"><span>${l.label ? esc(l.label) + " " : (l.qty || 1) + "x "}${esc(l.name)}${l.choices?.length ? `<br><span class="sm">&nbsp;&nbsp;${l.choices.map((c) => esc(c.label)).join(", ")}</span>` : ""}</span><span>${money(l.subtotal, cur)}</span></div>`));
  const disc = list.reduce((a, o) => a + (o.discounts?.promo || 0), 0), vouch = list.reduce((a, o) => a + (o.voucher?.discount || 0), 0), fee = list.reduce((a, o) => a + (o.deliveryFee || 0), 0), small = list.reduce((a, o) => a + (o.smallOrderFee || 0), 0);
  const paid = list.every((o) => o.paid);
  const html = `${headerHTML(store, cfg)}
    <div class="row"><span>${list.length > 1 ? `Orders ${list.map((o) => "#" + (o.laundry?.ticketNo || o.orderNo)).join(", ")}` : `${first.type === "laundry" ? "Ticket" : "Order"} #${esc(first.laundry?.ticketNo || first.orderNo)}`}</span><span>${d.toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" })}</span></div>
    <div class="row sm"><span>${first.tableLabel ? esc(first.tableLabel) + " · " : ""}${SVC[first.serviceType] || ""}${first.customer?.name ? " · " + esc(first.customer.name) : ""}</span><span>${d.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}</span></div>
    ${first.laundry ? `<div class="sm">${first.laundry.kg ? `${first.laundry.kg} kg · ${first.laundry.loads} load(s)` : ""}${first.laundry.pcs != null ? ` · ${first.laundry.pcs} pcs` : ""}${first.laundry.rush ? " · RUSH" : ""}</div>` : ""}
    <hr/>${lines.join("")}<hr/>
    ${disc ? `<div class="row"><span>Promo savings</span><span>-${money(disc, cur)}</span></div>` : ""}
    ${vouch ? `<div class="row"><span>Voucher</span><span>-${money(vouch, cur)}</span></div>` : ""}
    ${(() => { const sd = list.reduce((a, o) => a + (o.discounts?.senior || 0), 0); const S = list.find((o) => o.senior)?.senior; return sd ? `<div class="row"><span>Senior / PWD discount</span><span>-${money(sd, cur)}</span></div>${(S?.ids || []).map((x) => `<div class="row sm"><span>${x.kind === "pwd" ? "PWD" : "SC"} · ${esc(x.name)}</span><span>ID ${esc(x.id)}</span></div>`).join("")}${S?.vatExempt ? `<div class="row sm"><span>VAT-exempt sale</span><span>${money(S.vatExempt, cur)}</span></div>` : ""}<div class="row sm"><span>Signature: ______________</span><span></span></div>` : ""; })()}
    ${fee ? `<div class="row"><span>Delivery fee</span><span>${money(fee, cur)}</span></div>` : ""}
    ${small ? `<div class="row"><span>Small-order fee</span><span>${money(small, cur)}</span></div>` : ""}
    <div class="row big"><span>TOTAL</span><span>${money(total, cur)}</span></div>
    ${paid ? `<div class="row"><span>PAID${first.paymentMethod ? " · " + esc(String(first.paymentMethod).toUpperCase()) : ""}</span><span>${(first.paidAt?.toDate?.() || new Date()).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}</span></div>${cashTendered ? `<div class="row"><span>Cash</span><span>${money(cashTendered, cur)}</span></div><div class="row"><span>Change</span><span>${money(cashTendered - total, cur)}</span></div>` : ""}` : `<div class="row b"><span>UNPAID</span><span></span></div>`}
    ${staffName ? `<div class="sm mt">Served by: ${esc(staffName)}</div>` : ""}
    <hr/><div class="c sm">${esc(cfg.footer || "Thank you!").replace(/\n/g, "<br>")}</div>
    <div class="c sm mt">This is not an official receipt.</div>
    ${store.settings?.hideBranding || store.hideBranding ? "" : `<div class="c sm">Powered by TapTayo · taptayo.com</div>`}`;
  return printHTML(html, { paper: cfg.paper, title: `Receipt #${first.orderNo}` });
}

/** Kitchen ticket — no prices, big item lines. */
export function printKitchenTicket(store, o, station = "") {
  const cfg = printCfg(store);
  const d = o.createdAt?.toDate?.() || new Date();
  const html = `<div class="c xl">#${o.orderNo}</div><div class="c b">${o.tableLabel ? esc(o.tableLabel) + " · " : ""}${SVC[o.serviceType] || ""}${station ? " · " + esc(station).toUpperCase() : ""}</div>
    <div class="c sm">${d.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}${o.customer?.name ? " · " + esc(o.customer.name) : ""}${o.scheduledAt?.toDate ? " · FOR " + o.scheduledAt.toDate().toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" }) : ""}</div><hr/>
    ${(o.items || []).filter((l) => !station || (l.station || "kitchen") === station).map((l) => `<div class="big">${l.qty}x ${esc(l.name)}</div>${l.choices?.length ? `<div>&nbsp;&nbsp;${l.choices.map((c) => esc(c.label)).join(", ")}</div>` : ""}${l.note ? `<div class="b">&nbsp;&nbsp;** ${esc(l.note)}</div>` : ""}`).join("")}
    ${o.note ? `<hr/><div class="b">NOTE: ${esc(o.note)}</div>` : ""}`;
  return printHTML(html, { paper: cfg.paper, title: `Ticket #${o.orderNo}` });
}

/** Laundry claim stub. */
export function printClaimStub(store, o, qrDataUrl, link) {
  const cfg = printCfg(store); const L = o.laundry || {};
  const html = `${headerHTML(store, cfg)}
    <div class="c sm">CLAIM STUB</div><div class="c xl">#${esc(L.ticketNo || o.orderNo)}</div>
    <div class="c b">Claim code: ${esc(L.claimCode || "")}</div>
    ${qrDataUrl ? `<img class="qr" src="${qrDataUrl}"/>` : ""}
    <div class="c sm">${esc(o.customer?.name || "")}${o.customer?.phone ? " · " + esc(o.customer.phone) : ""}</div><hr/>
    ${(o.items || []).map((l) => `<div class="row"><span>${esc(l.name)}</span><span>${esc(l.label || "")}</span></div>`).join("")}
    <div class="sm mt">${L.kg ? `${L.kg} kg · ${L.loads} load(s)` : ""}${L.pcs != null ? ` · ${L.pcs} pcs` : ""}${L.container && L.container !== "none" ? ` · ${esc(L.container)}` : ""}${L.rush ? " · RUSH" : ""}</div>
    <div class="row big"><span>TOTAL</span><span>${L.estimateOnly && !o.total ? "TBQ" : money(o.total)}</span></div>${o.paid ? `<div class="row b"><span>PAID</span><span></span></div>` : ""}
    ${L.readyBy?.toDate ? `<div class="b mt">Ready by ${L.readyBy.toDate().toLocaleString("en-PH", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div>` : ""}
    <div class="policy">Keep this stub. Garments are released ONLY to whoever presents this claim code. No stub, no claim. Scan the QR for status and final price.${link ? `<br>${esc(link)}` : ""}</div>
    <div class="c sm mt">${esc(cfg.footer || "Thank you!")}</div>`;
  return printHTML(html, { paper: cfg.paper, title: `Stub #${L.ticketNo || o.orderNo}` });
}
