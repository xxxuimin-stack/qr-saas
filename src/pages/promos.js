// Promos & Vouchers (owner)
import { ADDONS, entitled } from "../plans.js";
import { db, call } from "../firebase.js";
import { collection, doc, addDoc, setDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy, serverTimestamp } from "firebase/firestore";
import { esc, html, toast, money, openModal, closeModal, confirmDialog } from "../ui.js";
import { promoActive, promoLabel } from "../promo.js";
import { salonPromoTag } from "../salonpromo.js";

const DAYS = [["mon", "Mon"], ["tue", "Tue"], ["wed", "Wed"], ["thu", "Thu"], ["fri", "Fri"], ["sat", "Sat"], ["sun", "Sun"]];
const SVCS = [["dine_in", "Dine-in"], ["take_out", "Take-out"], ["pickup", "Pickup"], ["delivery", "Delivery"]];

export function renderPromosPage(root, ctx) {
  const { storeId, store, labels } = ctx;
  const cur = store.settings?.currency || "PHP";
  let promos = [], vouchers = [], items = [], cats = [], team = [];
  const salon = store.mode === "salon";
  const tag = (p) => salon ? salonPromoTag(p) : promoLabel(p);
  const staffWord = store.businessType === "spa" ? "therapist" : "stylist";
  const homeOn = store.settings?.setup?.place === "home" || store.settings?.setup?.place === "both" || !!store.settings?.salon?.homeService?.enabled;
  root.innerHTML = `
    <div class="tile">
      <div class="row between wrap"><div><h3>🏷️ Promos</h3><p class="small muted">${salon ? "% off, ₱ off, combos, couple / first-visit deals, free transport for home service, promo codes — with days, hours and dates. The schedule is checked against the <b>session time</b>, and the price is locked when the client books. Promos with a future start date show on your page as “Coming soon”." : "% off, ₱ off, or Buy 1 Take 1 — with a schedule (days/time/dates). Shows as a badge on the menu and auto-applies to the price. Promos with a future start date show as “Coming soon”."}</p></div><button class="btn sm" id="addPromo" type="button">+ Add promo</button></div>
      <div id="promoList" class="itemlist"></div>
    </div>
    <div class="tile" style="margin-top:14px">
      <div class="row between wrap"><div><h3>🎟️ Vouchers (codes)</h3><p class="small small muted">Customers enter the code in their cart. Set usage limits, min order, and expiry.</p></div><button class="btn sm" id="addVoucher" type="button">+ Add voucher</button></div>
      <div id="voucherList" class="itemlist"></div>
    </div>
    <div class="tile" style="margin-top:14px">
      <div class="row between wrap"><div><h3>🔥 Top picks</h3><p class="small muted">Computed automatically every day from the last 30 days. Shown at the top of the ${esc(labels.items.toLowerCase())}.</p></div>
        <div class="row"><label class="check" style="margin:0"><input type="checkbox" id="showBest" ${store.settings?.showBestsellers !== false ? "checked" : ""}/> Show on menu</label><button class="btn ghost sm" id="recompute" type="button">↻ Recompute now</button></div></div>
      <div id="bestList" class="small muted" style="margin-top:8px"></div>
    </div>`;

  const u1 = onSnapshot(query(collection(db, "stores", storeId, "promos"), orderBy("createdAt", "desc")), (s) => { promos = s.docs.map((d) => ({ id: d.id, ...d.data() })); drawPromos(); });
  const u2 = onSnapshot(query(collection(db, "stores", storeId, "vouchers"), orderBy("createdAt", "desc")), (s) => { vouchers = s.docs.map((d) => ({ id: d.id, ...d.data() })); drawVouchers(); });
  let suggested = null; try { suggested = sessionStorage.getItem("promo:suggestItems"); sessionStorage.removeItem("promo:suggestItems"); } catch {}
  const u3 = onSnapshot(query(collection(db, "stores", storeId, "items"), orderBy("sortOrder")), (s) => {
    items = s.docs.map((d) => ({ id: d.id, ...d.data() })); drawBest(); drawPromos();
    // from Overview → "Slow this week · Make a promo": open the form with those items ticked
    if (suggested) { const ids = suggested.split(",").filter((id) => items.some((i) => i.id === id)); suggested = null; if (ids.length) setTimeout(() => promoForm({ name: "Slow-mover deal", type: "percent", value: 10, itemIds: ids, active: true, _new: true }), 0); }
  });
  const u4 = onSnapshot(query(collection(db, "stores", storeId, "categories"), orderBy("sortOrder")), (s) => { cats = s.docs.map((d) => ({ id: d.id, ...d.data() })); });
  const u5 = salon ? onSnapshot(collection(db, "stores", storeId, "staff"), (s) => { team = s.docs.map((d) => ({ id: d.id, ...d.data() })).filter((x) => x.active !== false && (x.roles || []).includes("stylist")); drawPromos(); }) : () => {};

  // ---------- promos ----------
  function drawPromos() {
    const el = root.querySelector("#promoList");
    el.innerHTML = promos.length ? "" : `<p class="small muted">No promos yet.</p>`;
    promos.forEach((p) => {
      const targets = p.type === "free_home_fee" ? `Home service ₱${Number(p.value || 0).toLocaleString()}+` : p.allItems ? "All items" : [...(p.categoryIds || []).map((id) => cats.find((c) => c.id === id)?.name || id), ...(p.itemIds || []).map((id) => items.find((i) => i.id === id)?.name || id)].join(", ");
      const sch = p.schedule || {};
      const when = [sch.days?.length ? sch.days.map((d) => d[0].toUpperCase() + d.slice(1)).join("/") : "Daily", sch.start || sch.end ? `${sch.start || "00:00"}–${sch.end || "23:59"}` : "", sch.dateFrom || sch.dateTo ? `${sch.dateFrom || "…"} → ${sch.dateTo || "…"}` : ""].filter(Boolean).join(" · ");
      const live = promoActive(p);
      const row = html(`<div class="item ${p.active === false ? "off" : ""}" style="grid-template-columns:auto 1fr auto auto">
        <span class="pill ${live ? "active" : "trial"}" style="font-size:.9rem">${esc(tag(p))}</span>
        <div class="info"><div class="n">${esc(p.name)} ${live ? `<span class="tag">LIVE now</span>` : p.schedule?.dateFrom && p.schedule.dateFrom > new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10) ? `<span class="tag">🔜 Coming soon</span>` : ""}${p.audience === "code" ? ` <span class="code">${esc(p.promoCode || "")}</span>` : ""}</div><div class="d muted small">${esc(targets)} · ${esc(when)}${p.audience && p.audience !== "all" ? ` · ${{ first_visit: "first visit", couple: "2 pax", code: "code" }[p.audience] || ""}` : ""}${p.place && p.place !== "any" ? ` · ${p.place} only` : ""}${p.staffIds?.length ? ` · ${esc(p.staffIds.map((id) => team.find((t) => t.id === id)?.name || "?").join(", "))}` : ""}${p.stack ? " · stacks" : ""}</div>
          ${salon ? `<div class="small" style="margin-top:2px">Used <b>${p.usedCount || 0}</b>${p.maxUses ? ` / ${p.maxUses}` : ""} · ${money(p.discountTotal || 0, cur)} given</div>` : ""}</div>
        <label class="switch"><input type="checkbox" ${p.active !== false ? "checked" : ""}/><span></span></label>
        <span class="acts"><button data-share title="Copy text to share">📤</button><button data-edit>✎</button><button data-del>🗑</button></span></div>`);
      row.querySelector("[data-share]").onclick = async () => { const t = `🏷️ ${tag(p)} ${p.name}${when && when !== "Daily" ? ` (${when})` : ""}${p.audience === "code" ? ` — use code ${p.promoCode}` : ""}\nBook here: ${location.origin}/m/${store.slug}`; try { await navigator.clipboard.writeText(t); toast("Copied — paste it on Facebook / Messenger"); } catch { prompt("Copy this:", t); } };
      row.querySelector(".switch input").onchange = (e) => updateDoc(doc(db, "stores", storeId, "promos", p.id), { active: e.target.checked, updatedAt: serverTimestamp() });
      row.querySelector("[data-edit]").onclick = () => promoForm(p);
      row.querySelector("[data-del]").onclick = async () => { if (await confirmDialog(`Delete promo "${p.name}"?`)) deleteDoc(doc(db, "stores", storeId, "promos", p.id)); };
      el.appendChild(row);
    });
  }
  function promoForm(p) {
    if (salon) return salonPromoForm(p);
    const sch = p?.schedule || {};
    const body = html(`<div class="form2">
      <div class="span2"><label>Promo name</label><input name="name" value="${esc(p?.name || "")}" placeholder="e.g. Happy Hour, Merienda Promo"/></div>
      <div><label>Type</label><select name="type"><option value="percent" ${p?.type === "percent" ? "selected" : ""}>% off</option><option value="amount" ${p?.type === "amount" ? "selected" : ""}>₱ off per item</option><option value="bogo" ${p?.type === "bogo" ? "selected" : ""}>Buy 1 Take 1</option><option value="free_delivery" ${p?.type === "free_delivery" ? "selected" : ""}>🛵 Free delivery</option></select></div>
      <div><label data-vlbl>${p?.type === "free_delivery" ? "Minimum order (₱) for free delivery" : "Value"}</label><input name="value" type="number" min="0" value="${p?.value ?? ""}" placeholder="20"/></div>
      <div class="span2" data-vf><label>Valid for</label><select name="validFor">
        <option value="all" ${(p?.validFor || "all") === "all" ? "selected" : ""}>Everyone</option>
        <option value="vip" ${p?.validFor === "vip" ? "selected" : ""}>🎤 VIP room orders only</option>
        <option value="vip_adult" ${p?.validFor === "vip_adult" ? "selected" : ""}>🎤 VIP room · beer &amp; liquor only</option>
        <option value="adult" ${p?.validFor === "adult" ? "selected" : ""}>🔞 Beer &amp; liquor only (18+ menu)</option></select>
        <div class="small muted" style="margin-top:4px">Combos/bundles: add them as an item with a "Regular price" so the old price shows crossed out.</div></div>
      <div class="span2" data-apply><label>Apply to</label>
        <label class="check"><input type="checkbox" name="allItems" ${p?.allItems ? "checked" : ""}/> All items</label>
        <div class="small muted" style="margin:6px 0 2px">Categories:</div><div class="row wrap">${cats.map((c) => `<label class="check small" style="margin:0 10px 0 0"><input type="checkbox" name="cat" value="${c.id}" ${(p?.categoryIds || []).includes(c.id) ? "checked" : ""}/> ${esc(c.name)}</label>`).join("")}</div>
        <div class="small muted" style="margin:6px 0 2px">Items:</div><div class="row wrap" style="max-height:140px;overflow:auto">${items.map((i) => `<label class="check small" style="margin:0 10px 0 0"><input type="checkbox" name="item" value="${i.id}" ${(p?.itemIds || []).includes(i.id) ? "checked" : ""}/> ${esc(i.name)}</label>`).join("")}</div>
      </div>
      <div class="span2"><label>Schedule (leave blank = always)</label><div class="row wrap">${DAYS.map(([k, l]) => `<label class="check small" style="margin:0 8px 0 0"><input type="checkbox" name="day" value="${k}" ${(sch.days || []).includes(k) ? "checked" : ""}/> ${l}</label>`).join("")}</div></div>
      <div><label>From time</label><input name="start" type="time" value="${esc(sch.start || "")}"/></div><div><label>To time</label><input name="end" type="time" value="${esc(sch.end || "")}"/></div>
      <div><label>From date</label><input name="dateFrom" type="date" value="${esc(sch.dateFrom || "")}"/></div><div><label>To date</label><input name="dateTo" type="date" value="${esc(sch.dateTo || "")}"/></div>
      <div class="span2"><label class="check"><input type="checkbox" name="active" ${p?.active !== false ? "checked" : ""}/> Active</label></div>
    </div>`);
    const syncType = () => { const fd = body.querySelector("[name=type]").value === "free_delivery"; body.querySelector("[data-vlbl]").textContent = fd ? "Minimum order (₱) for free delivery" : "Value"; body.querySelector("[data-apply]").style.display = fd ? "none" : ""; body.querySelector("[data-vf]").style.display = fd ? "none" : ""; };
    body.querySelector("[name=type]").onchange = syncType; syncType();
    const foot = html(`<div class="row" style="justify-content:flex-end"><button class="btn ghost" data-no type="button">Cancel</button><button class="btn" data-yes type="button">Save</button></div>`);
    foot.querySelector("[data-no]").onclick = closeModal;
    foot.querySelector("[data-yes]").onclick = async () => {
      const g = (n) => body.querySelector(`[name=${n}]`);
      const data = {
        name: g("name").value.trim(), type: g("type").value, value: Number(g("value").value || 0), allItems: g("allItems").checked,
        categoryIds: [...body.querySelectorAll("[name=cat]:checked")].map((c) => c.value), itemIds: [...body.querySelectorAll("[name=item]:checked")].map((c) => c.value),
        schedule: { days: [...body.querySelectorAll("[name=day]:checked")].map((c) => c.value), start: g("start").value || null, end: g("end").value || null, dateFrom: g("dateFrom").value || null, dateTo: g("dateTo").value || null },
        active: g("active").checked, validFor: g("validFor")?.value || "all", updatedAt: serverTimestamp(),
      };
      if (data.type === "free_delivery") { data.allItems = true; data.validFor = "all"; }
      if (!data.name) return toast("Enter a promo name", "error");
      if (!["bogo", "free_delivery"].includes(data.type) && !(data.value > 0)) return toast("Enter a value", "error");
      if (!data.allItems && !data.categoryIds.length && !data.itemIds.length) return toast("Select items or categories", "error");
      if (p && p.id) await updateDoc(doc(db, "stores", storeId, "promos", p.id), data); else await addDoc(collection(db, "stores", storeId, "promos"), { ...data, createdAt: serverTimestamp() });
      closeModal(); toast("Saved");
    };
    openModal({ title: p && p.id ? "Edit promo" : "New promo", body, footer: foot, wide: true });
  }
  root.querySelector("#addPromo").onclick = () => promoForm(null);
  // ---------- salon / spa promo form ----------
  function salonPromoForm(p) {
    const sch = p?.schedule || {};
    const chk = (name, list, sel) => `<div class="row wrap" style="max-height:150px;overflow:auto">${list.map((x) => `<label class="check small" style="margin:0 10px 0 0"><input type="checkbox" name="${name}" value="${x.id}" ${(sel || []).includes(x.id) ? "checked" : ""}/> ${esc(x.name)}</label>`).join("")}</div>`;
    const svc = items.filter((i) => !i.retail);
    const body = html(`<div class="form2">
      <div class="span2"><label>Promo name (shown to clients)</label><input name="name" value="${esc(p?.name || "")}" placeholder="e.g. Weekday Relax, Couple Treat, Payday Sale"/></div>
      <div><label>Type</label><select name="type">${[["percent", "% off"], ["amount", "₱ off per service"], ["bundle", "Combo price — these services together"], ...(homeOn || p?.type === "free_home_fee" ? [["free_home_fee", "Free transport fee (home service)"]] : [])].map(([k, l]) => `<option value="${k}" ${p?.type === k ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div><label data-vlbl>Value</label><input name="value" type="number" min="0" value="${p?.value ?? ""}" placeholder="20"/></div>
      <div><label>Who gets it</label><select name="audience">${[["all", "Everyone"], ["first_visit", "First visit only (new numbers)"], ["couple", "2 pax / couple bookings"], ["code", "Only with a promo code"]].map(([k, l]) => `<option value="${k}" ${(p?.audience || "all") === k ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div data-code><label>Promo code</label><input name="promoCode" value="${esc(p?.promoCode || "")}" placeholder="e.g. SPA50" style="text-transform:uppercase"/></div>
      ${homeOn ? `<div><label>Where</label><select name="place">${[["any", "Shop & home service"], ["shop", "In the shop only"], ["home", "Home service only"]].map(([k, l]) => `<option value="${k}" ${(p?.place || "any") === k ? "selected" : ""}>${l}</option>`).join("")}</select></div>` : ""}
      <div class="span2" data-stackrow><label class="check"><input type="checkbox" name="stack" ${p?.stack ? "checked" : ""}/> Add on top of other promos <span class="small muted">(e.g. couple ₱100 off + weekday 20%) — otherwise the client gets the best single promo</span></label></div>
      <div class="span2" data-apply><label data-alabel>Services</label>
        <label class="check" data-allrow><input type="checkbox" name="allItems" ${p?.allItems ? "checked" : ""}/> All services</label>
        <div data-catrow><div class="small muted" style="margin:6px 0 2px">Categories:</div>${chk("cat", cats, p?.categoryIds)}</div>
        <div class="small muted" style="margin:6px 0 2px" data-ilabel>Services:</div>${chk("item", svc, p?.itemIds)}
      </div>
      ${team.length > 1 ? `<div class="span2"><label>Only with these ${staffWord}s <span class="small muted">(none ticked = everyone; good for a new ${staffWord})</span></label>${chk("staff", team, p?.staffIds)}</div>` : ""}
      <div class="span2"><label>Session days & time (leave blank = any time)</label><div class="row wrap">${DAYS.map(([k, l]) => `<label class="check small" style="margin:0 8px 0 0"><input type="checkbox" name="day" value="${k}" ${(sch.days || []).includes(k) ? "checked" : ""}/> ${l}</label>`).join("")}</div></div>
      <div><label>From time</label><input name="start" type="time" value="${esc(sch.start || "")}"/></div><div><label>To time</label><input name="end" type="time" value="${esc(sch.end || "")}"/></div>
      <div><label>Start date <span class="small muted">(future = “Coming soon”)</span></label><input name="dateFrom" type="date" value="${esc(sch.dateFrom || "")}"/></div><div><label>End date</label><input name="dateTo" type="date" value="${esc(sch.dateTo || "")}"/></div>
      <div><label>Limit — total bookings (blank = no limit)</label><input name="maxUses" type="number" min="1" value="${p?.maxUses ?? ""}" placeholder="e.g. 10"/></div>
      <div><label>Times per client (blank = no limit)</label><input name="perCustomer" type="number" min="1" value="${p?.perCustomer ?? ""}"/></div>
      <div class="span2"><label>Short note for clients (optional)</label><input name="note" maxlength="80" value="${esc(p?.note || "")}" placeholder="e.g. Bring a friend!"/></div>
      <div class="span2"><label class="check"><input type="checkbox" name="active" ${p?.active !== false ? "checked" : ""}/> Active</label></div>
    </div>`);
    const g = (n) => body.querySelector(`[name=${n}]`);
    const sync = () => {
      const t = g("type").value, aud = g("audience").value;
      body.querySelector("[data-vlbl]").textContent = t === "percent" ? "% off" : t === "amount" ? "₱ off per service" : t === "bundle" ? "Combo price (₱, all together)" : "Minimum spend for free transport (₱)";
      body.querySelector("[data-apply]").style.display = t === "free_home_fee" ? "none" : "";
      body.querySelector("[data-allrow]").style.display = body.querySelector("[data-catrow]").style.display = t === "bundle" ? "none" : "";
      body.querySelector("[data-ilabel]").textContent = t === "bundle" ? "Services in the combo (tick 2 or more):" : "Services:";
      body.querySelector("[data-code]").style.display = aud === "code" ? "" : "none";
      body.querySelector("[data-stackrow]").style.display = ["percent", "amount"].includes(t) ? "" : "none";
    };
    g("type").onchange = g("audience").onchange = sync; sync();
    const foot = html(`<div class="row" style="justify-content:flex-end"><button class="btn ghost" data-no type="button">Cancel</button><button class="btn" data-yes type="button">Save</button></div>`);
    foot.querySelector("[data-no]").onclick = closeModal;
    foot.querySelector("[data-yes]").onclick = async () => {
      const t = g("type").value; const num = (n) => (g(n)?.value === "" || !g(n) ? null : Math.max(1, Number(g(n).value) || 1));
      const data = {
        name: g("name").value.trim(), type: t, value: Number(g("value").value || 0), audience: g("audience").value,
        promoCode: g("audience").value === "code" ? g("promoCode").value.trim().toUpperCase().replace(/[^A-Z0-9-]/g, "") : null,
        place: g("place")?.value || "any", stack: ["percent", "amount"].includes(t) && g("stack").checked,
        allItems: t === "free_home_fee" || (t !== "bundle" && g("allItems").checked),
        categoryIds: t === "bundle" ? [] : [...body.querySelectorAll("[name=cat]:checked")].map((c) => c.value), itemIds: [...body.querySelectorAll("[name=item]:checked")].map((c) => c.value),
        staffIds: [...body.querySelectorAll("[name=staff]:checked")].map((c) => c.value),
        schedule: { days: [...body.querySelectorAll("[name=day]:checked")].map((c) => c.value), start: g("start").value || null, end: g("end").value || null, dateFrom: g("dateFrom").value || null, dateTo: g("dateTo").value || null },
        maxUses: num("maxUses"), perCustomer: num("perCustomer"), note: g("note").value.trim(), active: g("active").checked, validFor: "all", updatedAt: serverTimestamp(),
      };
      if (!data.name) return toast("Enter a promo name", "error");
      if (t !== "free_home_fee" && !(data.value > 0)) return toast("Enter a value", "error");
      if (t === "percent" && data.value > 100) return toast("% off can't be more than 100", "error");
      if (t === "bundle" && data.itemIds.length < 2) return toast("Tick 2 or more services for the combo", "error");
      if (t !== "bundle" && t !== "free_home_fee" && !data.allItems && !data.categoryIds.length && !data.itemIds.length) return toast("Select services or categories", "error");
      if (data.audience === "code" && (data.promoCode || "").length < 3) return toast("Promo code: 3+ letters/numbers", "error");
      if (data.audience === "code" && promos.some((x) => x.id !== p?.id && x.audience === "code" && x.promoCode === data.promoCode)) return toast("Another promo already uses this code", "error");
      if (data.schedule.dateFrom && data.schedule.dateTo && data.schedule.dateTo < data.schedule.dateFrom) return toast("End date is before the start date", "error");
      if (p && p.id) await updateDoc(doc(db, "stores", storeId, "promos", p.id), data); else await addDoc(collection(db, "stores", storeId, "promos"), { ...data, usedCount: 0, discountTotal: 0, createdAt: serverTimestamp() });
      closeModal(); toast("Saved");
    };
    openModal({ title: p && p.id ? "Edit promo" : "New promo", body, footer: foot, wide: true });
  }

  // ---------- vouchers ----------
  function drawVouchers() {
    const el = root.querySelector("#voucherList");
    if (!entitled(ctx.sub, "vouchers")) { el.innerHTML = `<div class="alert warn"><a class="addon-lock" href="#billing">🔒 Pro plan</a> — customer voucher codes won't be accepted until this is activated. You can still create codes here so they're ready.</div>` + (vouchers.length ? "" : ""); if (!vouchers.length) return; }
    el.innerHTML = vouchers.length ? "" : `<p class="small muted">No vouchers yet.</p>`;
    vouchers.forEach((v) => {
      const row = html(`<div class="item ${v.active === false ? "off" : ""}" style="grid-template-columns:auto 1fr auto auto">
        <span class="code">${esc(v.code)}</span>
        <div class="info"><div class="n">${v.type === "percent" ? `${v.value}% off` : `${money(v.value, cur)} off`}${v.maxDiscount ? ` (max ${money(v.maxDiscount, cur)})` : ""}${v.minOrder ? ` · min ${money(v.minOrder, cur)}` : ""}</div>
          <div class="d muted small">Used ${v.usedCount || 0}${v.maxUses ? ` / ${v.maxUses}` : ""}${v.perCustomer ? ` · ${v.perCustomer}× per customer` : ""}${v.validTo ? ` · until ${v.validTo}` : ""}${v.services?.length ? ` · ${v.services.join(", ")}` : ""}</div></div>
        <label class="switch"><input type="checkbox" ${v.active !== false ? "checked" : ""}/><span></span></label>
        <span class="acts"><button data-edit>✎</button><button data-del>🗑</button></span></div>`);
      row.querySelector(".switch input").onchange = (e) => updateDoc(doc(db, "stores", storeId, "vouchers", v.id), { active: e.target.checked, updatedAt: serverTimestamp() });
      row.querySelector("[data-edit]").onclick = () => voucherForm(v);
      row.querySelector("[data-del]").onclick = async () => { if (await confirmDialog(`Delete voucher ${v.code}?`)) deleteDoc(doc(db, "stores", storeId, "vouchers", v.id)); };
      el.appendChild(row);
    });
  }
  function voucherForm(v) {
    const gen = () => "SAVE" + Math.random().toString(36).slice(2, 6).toUpperCase();
    const body = html(`<div class="form2">
      <div><label>Code</label><input name="code" value="${esc(v?.code || gen())}" ${v ? "disabled" : ""} style="text-transform:uppercase"/></div>
      <div><label>Type</label><select name="type"><option value="percent" ${v?.type === "percent" ? "selected" : ""}>% off</option><option value="amount" ${v?.type === "amount" ? "selected" : ""}>₱ off</option></select></div>
      <div><label>Value</label><input name="value" type="number" min="0" value="${v?.value ?? 10}"/></div>
      <div><label>Max discount (₱, optional)</label><input name="maxDiscount" type="number" min="0" value="${v?.maxDiscount ?? ""}"/></div>
      <div><label>Minimum order (₱)</label><input name="minOrder" type="number" min="0" value="${v?.minOrder ?? 0}"/></div>
      <div><label>Max total uses (blank = unlimited)</label><input name="maxUses" type="number" min="0" value="${v?.maxUses ?? ""}"/></div>
      <div><label>Uses per customer</label><input name="perCustomer" type="number" min="0" value="${v?.perCustomer ?? 1}"/></div>
      <div><label>Valid from</label><input name="validFrom" type="date" value="${esc(v?.validFrom || "")}"/></div>
      <div><label>Valid to</label><input name="validTo" type="date" value="${esc(v?.validTo || "")}"/></div>
      <div class="span2"><label>Service types (blank = all)</label><div class="row wrap">${SVCS.map(([k, l]) => `<label class="check small" style="margin:0 10px 0 0"><input type="checkbox" name="svc" value="${k}" ${(v?.services || []).includes(k) ? "checked" : ""}/> ${l}</label>`).join("")}</div></div>
      <div class="span2"><label>Label (shown to customer, optional)</label><input name="label" value="${esc(v?.label || "")}" placeholder="e.g. Welcome discount"/></div>
    </div>`);
    const foot = html(`<div class="row" style="justify-content:flex-end"><button class="btn ghost" data-no type="button">Cancel</button><button class="btn" data-yes type="button">Save</button></div>`);
    foot.querySelector("[data-no]").onclick = closeModal;
    foot.querySelector("[data-yes]").onclick = async () => {
      const g = (n) => body.querySelector(`[name=${n}]`);
      const code = g("code").value.trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
      if (code.length < 3) return toast("Code: 3+ letters/numbers", "error");
      const num = (n) => (g(n).value === "" ? null : Number(g(n).value));
      const data = { code, type: g("type").value, value: Number(g("value").value || 0), maxDiscount: num("maxDiscount"), minOrder: num("minOrder") || 0, maxUses: num("maxUses"), perCustomer: num("perCustomer") || 0, validFrom: g("validFrom").value || null, validTo: g("validTo").value || null, services: [...body.querySelectorAll("[name=svc]:checked")].map((c) => c.value), label: g("label").value.trim(), active: true, updatedAt: serverTimestamp() };
      if (!(data.value > 0)) return toast("Enter a value", "error");
      if (v) await updateDoc(doc(db, "stores", storeId, "vouchers", v.id), data);
      else { if (vouchers.some((x) => x.id === code)) return toast("This code already exists", "error"); await setDoc(doc(db, "stores", storeId, "vouchers", code), { ...data, usedCount: 0, usedBy: {}, createdAt: serverTimestamp() }); }
      closeModal(); toast("Saved");
    };
    openModal({ title: v ? `Edit ${v.code}` : "New voucher", body, footer: foot, wide: true });
  }
  root.querySelector("#addVoucher").onclick = () => voucherForm(null);

  // ---------- bestsellers ----------
  function drawBest() {
    const ids = store.stats?.bestsellers || [];
    root.querySelector("#bestList").innerHTML = ids.length ? ids.map((id, i) => `${i + 1}. ${esc(items.find((x) => x.id === id)?.name || id)}`).join(" · ") : "Nothing yet — requires completed orders. Click \"Recompute now\" after a few orders.";
  }
  root.querySelector("#recompute").onclick = async () => { try { const r = await call("recomputeBestsellers"); toast(`Top ${r.bestsellers.length} updated`); ctx.reload?.(); } catch (e) { toast(e.message, "error"); } };
  root.querySelector("#showBest").onchange = (e) => updateDoc(doc(db, "stores", storeId), { "settings.showBestsellers": e.target.checked, updatedAt: serverTimestamp() }).then(() => toast("Saved"));

  return () => { u1(); u2(); u3(); u4(); u5(); };
}
