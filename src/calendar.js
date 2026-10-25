// Salon calendar (owner / counter): Day · Week · Month, colored by type (walk-in, shop booking, home service + travel,
// tentative next visit, blocked time). Tap an empty spot to add a booking or block time; tap a booking for details.
// Also: "To confirm" list (next visits), today's route, and "Can't work today".
import { msgrBtn } from "./msgr.js";
import "./calendar.css";
import { db, call } from "./firebase.js";
import { collection, doc, onSnapshot, query, where, orderBy, updateDoc, serverTimestamp, Timestamp } from "firebase/firestore";
import { contactRow, onMyWay, mapsHref, VISIT_TAG, fmtTime, fmtWhen } from "./contact.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const html = (str) => { const t = document.createElement("template"); t.innerHTML = str.trim(); return t.content.firstElementChild; };
const pad = (n) => String(n).padStart(2, "0");
const dstr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (v) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || "")); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const minOf = (d) => d.getHours() * 60 + d.getMinutes();
const WK = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const ACTIVE = ["unconfirmed", "pending", "confirmed", "in_progress", "done"];
const OVERRIDE_RE = /already has a client|already has an active booking| is (on leave|on a day off|off duty|on break|blocked off)/;
const PX = 1.1; // px per minute

export function typeOf(a) {
  if (a.tentative && a.visitConfirm?.status !== "yes" && a.visitConfirm?.status !== "moved") return "tent";
  if (a.homeService) return "home";
  return a.source === "walkin" ? "walkin" : "shop";
}
const TYPE_LABEL = { walkin: "Walk-in", shop: "Shop booking", home: "Home service", tent: "Next visit (not confirmed)", block: "Blocked" };

export function mountCalendar(el, o) {
  const S = { view: o.view || (matchMedia("(max-width: 700px)").matches ? "day" : "week"), anchor: new Date(), appts: [], staff: [], items: [], cats: [], toConfirm: [], unsubs: [], rangeUnsub: null, ready: {} };
  // forms need staff / services loaded first
  const whenReady = (fn) => { const t0 = Date.now(); const tick = () => (S.ready.staff && S.ready.items && S.ready.cats) || Date.now() - t0 > 4000 ? fn() : setTimeout(tick, 80); tick(); };
  const store = () => S.store || o.getStore();
  const cur = o.cur || "PHP";
  const money = (n) => (cur === "PHP" ? "₱" : cur + " ") + Number(n || 0).toLocaleString("en-PH", { maximumFractionDigits: 2 });
  const tok = () => (typeof o.staffToken === "function" ? o.staffToken() : o.staffToken) || null;
  const stylists = () => S.staff.filter((x) => (x.roles || []).includes("stylist"));
  const place = () => store().settings?.setup?.place || (store().settings?.salon?.homeService?.enabled ? "both" : "shop");
  const hsCfg = () => store().settings?.salon?.homeService || {};

  S.unsubs.push(onSnapshot(doc(db, "stores", o.storeId), (s) => { if (s.exists()) { S.store = { id: s.id, ...s.data() }; drawBody(); } }, () => {}));
  S.unsubs.push(onSnapshot(query(collection(db, "stores", o.storeId, "staff"), orderBy("name")), (s) => { S.staff = s.docs.map((d) => ({ id: d.id, ...d.data() })).filter((x) => x.active !== false); S.ready.staff = true; draw(); }, () => {}));
  S.unsubs.push(onSnapshot(query(collection(db, "stores", o.storeId, "items"), orderBy("sortOrder")), (s) => { S.items = s.docs.map((d) => ({ id: d.id, ...d.data() })); S.ready.items = true; }, () => {}));
  S.unsubs.push(onSnapshot(query(collection(db, "stores", o.storeId, "categories"), orderBy("sortOrder")), (s) => { S.cats = s.docs.map((d) => ({ id: d.id, ...d.data() })); S.ready.cats = true; }, () => {}));
  S.unsubs.push(onSnapshot(query(collection(db, "stores", o.storeId, "appointments"), where("tentative", "==", true)), (s) => {
    const now = Date.now(), end = new Date(); end.setHours(0, 0, 0, 0); end.setDate(end.getDate() + 2);
    S.toConfirm = s.docs.map((d) => ({ id: d.id, ...d.data() })).filter((a) => ["pending", "confirmed"].includes(a.status) && a.visitConfirm?.status === "waiting" && a.startAt.toMillis() > now - 3600e3 && a.startAt.toMillis() < end.getTime()).sort((x, y) => x.startAt.toMillis() - y.startAt.toMillis());
    drawConfirm();
  }, () => {}));

  function range() {
    const a = new Date(S.anchor); a.setHours(0, 0, 0, 0);
    if (S.view === "day") return [a, new Date(a.getTime() + 864e5)];
    if (S.view === "week") { const s = new Date(a); s.setDate(a.getDate() - ((a.getDay() + 6) % 7)); const e = new Date(s); e.setDate(s.getDate() + 7); return [s, e]; }
    const s = new Date(a.getFullYear(), a.getMonth(), 1); s.setDate(s.getDate() - ((s.getDay() + 6) % 7)); const e = new Date(s); e.setDate(s.getDate() + 42); return [s, e];
  }
  function watch() {
    S.rangeUnsub?.();
    const [s, e] = range();
    S.rangeUnsub = onSnapshot(query(collection(db, "stores", o.storeId, "appointments"), where("startAt", ">=", Timestamp.fromDate(s)), where("startAt", "<", Timestamp.fromDate(e)), orderBy("startAt")), (snap) => { S.appts = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((a) => ACTIVE.includes(a.status)); drawBody(); }, (err) => console.warn("calendar", err));
  }

  el.innerHTML = `<div class="cal">
    <div class="cal-top">
      <div class="cal-views" role="tablist" aria-label="Calendar view">${["day", "week", "month"].map((v) => `<button type="button" role="tab" data-view="${v}">${v[0].toUpperCase() + v.slice(1)}</button>`).join("")}</div>
      <div class="cal-nav"><button type="button" data-nav="-1" aria-label="Previous">‹</button><button type="button" data-nav="0">Today</button><button type="button" data-nav="1" aria-label="Next">›</button><b data-label aria-live="polite"></b></div>
      <div class="cal-acts"><button type="button" data-act="add">➕ Booking</button><button type="button" data-act="block">⛔ Block time</button><button type="button" data-act="route">🗺 Route</button><button type="button" data-act="sick">🤒 Can't work</button></div>
    </div>
    <div data-confirm></div>
    <div class="cal-legend">${["walkin", "shop", "home", "tent", "block"].map((k) => `<span><i class="lg ${k}"></i>${TYPE_LABEL[k]}</span>`).join("")}</div>
    <div data-body class="cal-body"></div>
  </div>`;
  el.querySelectorAll("[data-view]").forEach((b) => (b.onclick = () => { S.view = b.dataset.view; watch(); draw(); }));
  el.querySelectorAll("[data-nav]").forEach((b) => (b.onclick = () => {
    const n = Number(b.dataset.nav); const a = new Date(S.anchor);
    if (!n) S.anchor = new Date(); else if (S.view === "day") a.setDate(a.getDate() + n); else if (S.view === "week") a.setDate(a.getDate() + 7 * n); else a.setMonth(a.getMonth() + n);
    if (n) S.anchor = a; watch(); draw();
  }));
  el.querySelector('[data-act="add"]').onclick = () => whenReady(() => addForm(defaultStart()));
  el.querySelector('[data-act="block"]').onclick = () => blockForm(dstr(S.anchor), "13:00", "14:00");
  el.querySelector('[data-act="route"]').onclick = routePanel;
  el.querySelector('[data-act="sick"]').onclick = sickDay;

  function defaultStart() { const d = new Date(S.anchor); const n = new Date(); if (dstr(d) === dstr(n)) { d.setHours(n.getHours() + 1, 0, 0, 0); } else d.setHours(10, 0, 0, 0); return d; }
  function draw() {
    el.querySelectorAll("[data-view]").forEach((b) => { b.classList.toggle("on", b.dataset.view === S.view); b.setAttribute("aria-selected", String(b.dataset.view === S.view)); });
    const [s, e] = range(); const last = new Date(e.getTime() - 864e5);
    el.querySelector("[data-label]").textContent = S.view === "day" ? S.anchor.toLocaleDateString("en-PH", { weekday: "long", month: "long", day: "numeric" }) : S.view === "week" ? `${s.toLocaleDateString("en-PH", { month: "short", day: "numeric" })} – ${last.toLocaleDateString("en-PH", { month: "short", day: "numeric" })}` : S.anchor.toLocaleDateString("en-PH", { month: "long", year: "numeric" });
    drawBody(); drawConfirm();
  }

  // ---------- grid helpers ----------
  function gridHours() {
    const hrs = store().hours || {}; let lo = 24 * 60, hi = 0;
    for (const k of WK) { const r = hrs[k] || []; for (let i = 0; i + 1 < r.length; i += 2) { const a = hm(r[i]), b = hm(r[i + 1]); if (a != null) lo = Math.min(lo, a); if (b != null) hi = Math.max(hi, b > (a || 0) ? b : 24 * 60); } }
    const hd = hsCfg().days || {}; for (const k of WK) if (hd[k]?.on) { lo = Math.min(lo, hm(hd[k].from) ?? lo); hi = Math.max(hi, hm(hd[k].to) ?? hi); }
    if (lo >= hi) { lo = 8 * 60; hi = 20 * 60; }
    for (const a of S.appts) { const d = a.startAt.toDate(); const m = minOf(d) - (a.travelBefore || 0); lo = Math.min(lo, m); hi = Math.max(hi, minOf(d) + (a.durationConfirmed || a.durationEst || 30) + (a.buffer || 0)); }
    return [Math.max(0, Math.floor(lo / 60) * 60 - 60), Math.min(24 * 60, Math.ceil(hi / 60) * 60 + 60)];
  }
  const blocksOn = (ymd, staffId) => (store().salonLive?.blocks || []).filter((b) => b.date === ymd && (!staffId || staffId === "*" || !b.staffId || b.staffId === staffId));
  const leaveOn = (ymd, staffId) => S.staff.filter((x) => (x.schedule?.leaves || []).includes(ymd) && (!staffId || staffId === "*" || x.id === staffId));
  function homeBand(date) { const hd = hsCfg().days; if (place() === "shop" || !hd) return null; const d = hd[WK[date.getDay()]]; return d?.on ? [hm(d.from) ?? 540, hm(d.to) ?? 720] : null; }
  function lanes(list) { // side-by-side when they overlap
    const ends = []; const out = new Map();
    for (const a of [...list].sort((x, y) => x.startAt.toMillis() - y.startAt.toMillis())) {
      const s = a.startAt.toMillis() - (a.travelBefore || 0) * 60000, e = a.startAt.toMillis() + ((a.durationConfirmed || a.durationEst || 30) + (a.buffer || 0)) * 60000;
      let i = ends.findIndex((x) => x <= s); if (i < 0) { i = ends.length; ends.push(e); } else ends[i] = e; out.set(a.id, i);
    }
    return { out, n: Math.max(1, ends.length) };
  }
  function evHTML(a, g0, lane, nl) {
    const d = a.startAt.toDate(), dur = a.durationConfirmed || a.durationEst || 30, t = typeOf(a);
    const top = (minOf(d) - g0) * PX, h = Math.max(22, dur * PX), tb = (a.travelBefore || 0) * PX, ta = a.homeService ? (a.buffer || 0) * PX : 0;
    const w = 100 / nl, left = lane * w;
    const vc = a.tentative ? VISIT_TAG[a.visitConfirm?.status || "waiting"] : null;
    return `<button type="button" class="ev ${t} ${a.status === "done" ? "done" : ""}" data-ev="${a.id}" style="top:${top}px;height:${h}px;left:calc(${left}% + 2px);width:calc(${w}% - 4px)" aria-label="${esc(`${fmtTime(d.getTime())} ${a.customer?.name || ""} · ${TYPE_LABEL[t]}`)}">
      ${tb ? `<span class="travel before" style="height:${tb}px;top:${-tb}px" aria-hidden="true">🚗</span>` : ""}${ta ? `<span class="travel after" style="height:${ta}px;bottom:${-ta}px" aria-hidden="true"></span>` : ""}
      <b>${S.view === "week" ? d.toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" }).replace(/\s?([AP])M/, (_, x) => x.toLowerCase()) : fmtTime(d.getTime())} ${esc(a.customer?.name || "")}</b><span>${esc((a.items || []).map((l) => l.name).join(", "))}</span>${a.homeService ? `<span>🏠 ${esc(a.homeService.area || a.homeService.address || "")}</span>` : ""}${vc ? `<span style="color:${vc[1]}">${vc[0]}</span>` : ""}</button>`;
  }
  function blockHTML(b, g0) { const s = hm(b.from) ?? 0, e = hm(b.to) ?? 1440; return `<button type="button" class="ev block" data-block="${esc(b.id)}" style="top:${(s - g0) * PX}px;height:${Math.max(18, (e - s) * PX)}px;left:2px;width:calc(100% - 4px)"><b>⛔ ${esc(b.from)}–${esc(b.to)}</b><span>${esc(b.reason || "Blocked")}</span></button>`; }

  function drawBody() {
    const body = el.querySelector("[data-body]"); if (!body) return;
    if (S.view === "month") return drawMonth(body);
    const [g0, g1] = gridHours(); const H = (g1 - g0) * PX;
    const [rs] = range();
    const days = S.view === "day" ? [new Date(S.anchor)] : Array.from({ length: 7 }, (_, i) => { const d = new Date(rs); d.setDate(rs.getDate() + i); return d; });
    const multi = S.view === "day" && stylists().length > 1;
    const cols = multi ? [...(S.appts.some((a) => !a.providerId && dstr(a.startAt.toDate()) === dstr(days[0])) ? [{ id: null, name: "Unassigned" }] : []), ...stylists()].map((x) => ({ date: days[0], staffId: x.id, title: x.name })) : days.map((d) => ({ date: d, staffId: "*", title: S.view === "day" ? "" : d.toLocaleDateString("en-PH", { weekday: "short", day: "numeric" }) }));
    const today = dstr(new Date());
    body.innerHTML = `<div class="grid" style="--cols:${cols.length}">
      <div class="hcol"><div class="ch"></div><div class="hrs" style="height:${H}px">${Array.from({ length: (g1 - g0) / 60 + 1 }, (_, i) => `<span style="top:${i * 60 * PX}px">${((g0 / 60 + i) % 12) || 12}${g0 / 60 + i < 12 ? "a" : "p"}</span>`).join("")}</div></div>
      ${cols.map((c, ci) => { const ymd = dstr(c.date); const list = S.appts.filter((a) => dstr(a.startAt.toDate()) === ymd && (c.staffId === "*" || (a.providerId || null) === c.staffId)); const L = lanes(list); const band = homeBand(c.date); const lv = leaveOn(ymd, c.staffId);
        return `<div class="dcol ${ymd === today ? "today" : ""}"><div class="ch">${esc(c.title)}${lv.length && c.staffId !== "*" ? ` <span class="lv">on leave</span>` : ""}</div>
        <div class="slots" data-col="${ci}" style="height:${H}px">
          ${Array.from({ length: (g1 - g0) / 60 }, (_, i) => `<div class="cal-hl" style="top:${i * 60 * PX}px"></div>`).join("")}
          ${band ? `<div class="hband" style="top:${(band[0] - g0) * PX}px;height:${(band[1] - band[0]) * PX}px" title="Home service hours"><span>🏠 home service hours</span></div>` : ""}
          ${lv.length && (c.staffId !== "*" || stylists().length <= 1) ? `<div class="leave" aria-label="On leave"><span>🌴 ${esc(lv.map((x) => x.name.split(" ")[0]).join(", "))} on leave</span></div>` : ""}
          ${blocksOn(ymd, c.staffId).map((b) => blockHTML(b, g0)).join("")}
          ${list.map((a) => evHTML(a, g0, L.out.get(a.id), L.n)).join("")}
          ${ymd === today ? `<div class="now" style="top:${(minOf(new Date()) - g0) * PX}px" aria-hidden="true"></div>` : ""}
        </div></div>`; }).join("")}
    </div>${!S.appts.length ? `<p class="cal-empty">No bookings ${S.view === "day" ? "this day" : "this week"} yet. Tap an empty time to add one.</p>` : ""}`;
    body.querySelectorAll("[data-col]").forEach((colEl) => (colEl.onclick = (e) => {
      if (e.target.closest("[data-ev],[data-block]")) return;
      const c = cols[Number(colEl.dataset.col)]; const r = colEl.getBoundingClientRect(); const m = g0 + Math.round((e.clientY - r.top) / PX / 15) * 15;
      const d = new Date(c.date); d.setHours(Math.floor(m / 60), m % 60, 0, 0);
      slotMenu(d, c.staffId && c.staffId !== "*" ? c.staffId : null);
    }));
    body.querySelectorAll("[data-ev]").forEach((b) => (b.onclick = () => details(S.appts.find((a) => a.id === b.dataset.ev))));
    body.querySelectorAll("[data-block]").forEach((b) => (b.onclick = () => { const bl = (store().salonLive?.blocks || []).find((x) => x.id === b.dataset.block); if (bl && confirm(`Remove this blocked time (${bl.date} ${bl.from}–${bl.to}${bl.reason ? ` · ${bl.reason}` : ""})?`)) call("blockTime", { remove: bl.id, staffToken: tok() }).catch((x) => alert(x.message)); }));
    const nowEl = body.querySelector(".now"); if (nowEl && S.view !== "month" && !S._scrolled) { S._scrolled = true; nowEl.scrollIntoView({ block: "center" }); }
  }
  function drawMonth(body) {
    const [s] = range(); const m = S.anchor.getMonth(); const today = dstr(new Date());
    const cells = Array.from({ length: 42 }, (_, i) => { const d = new Date(s); d.setDate(s.getDate() + i); return d; });
    body.innerHTML = `<div class="month">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((x) => `<div class="mh">${x}</div>`).join("")}
      ${cells.map((d) => { const ymd = dstr(d); const list = S.appts.filter((a) => dstr(a.startAt.toDate()) === ymd); const by = {}; list.forEach((a) => { const t = typeOf(a); by[t] = (by[t] || 0) + 1; }); const bl = blocksOn(ymd, "*").length || leaveOn(ymd, "*").length;
        return `<button type="button" class="mc ${d.getMonth() !== m ? "out" : ""} ${ymd === today ? "today" : ""}" data-day="${ymd}" aria-label="${esc(d.toDateString())}: ${list.length} bookings"><span class="dn">${d.getDate()}</span>${Object.entries(by).map(([t, n]) => `<span class="mchip ${t}">${n} ${t === "tent" ? "to confirm" : t === "walkin" ? "walk-in" : t}</span>`).join("")}${bl ? `<span class="mchip block">⛔ blocked</span>` : ""}</button>`; }).join("")}</div>`;
    body.querySelectorAll("[data-day]").forEach((b) => (b.onclick = () => { S.anchor = new Date(`${b.dataset.day}T12:00:00`); S.view = "day"; watch(); draw(); }));
  }

  // ---------- "To confirm" (next visits in the next 2 days) ----------
  function drawConfirm() {
    const box = el.querySelector("[data-confirm]"); if (!box) return;
    if (!S.toConfirm.length) { box.innerHTML = ""; return; }
    box.innerHTML = `<div class="cal-confirm"><b>📞 To confirm (${S.toConfirm.length})</b> <span class="small">— next visits today/tomorrow. Call or text, then mark the answer.</span><div data-list></div></div>`;
    const list = box.querySelector("[data-list]");
    S.toConfirm.forEach((a) => {
      const row = html(`<div class="cc-row"><div><b>${esc(a.customer?.name || "")}</b> · ${fmtWhen(a.startAt.toMillis())}${a.homeService ? ` · 🏠 ${esc(a.homeService.area || "")}` : ""}${a.visitConfirm?.tries ? ` · <span class="small">no answer ×${a.visitConfirm.tries}</span>` : ""}${a.visitConfirm?.contactedAt ? ` · <span class="small">texted ${fmtTime(a.visitConfirm.contactedAt)}</span>` : ""}</div><div class="cc-acts"></div></div>`);
      const acts = row.querySelector(".cc-acts");
      acts.appendChild(contactRow(a, store(), { kind: "confirm", staffToken: tok(), onContacted: () => call("visitMark", { id: a.id, answer: "contacted", staffToken: tok() }).catch(() => {}) }));
      acts.appendChild(markRow(a));
      list.appendChild(row);
    });
  }
  function markRow(a) {
    const r = html(`<div class="ct-row"><button type="button" class="ct-btn ok" data-m="yes">✅ Confirmed</button><button type="button" class="ct-btn" data-m="noanswer">📵 No answer</button><button type="button" class="ct-btn bad" data-m="no">❌ Can't make it</button></div>`);
    r.querySelectorAll("[data-m]").forEach((b) => (b.onclick = async () => { if (b.dataset.m === "no" && !confirm(`Cancel ${a.customer?.name || "this client"}'s visit? The time becomes free.`)) return; b.disabled = true; try { await call("visitMark", { id: a.id, answer: b.dataset.m, staffToken: tok() }); o.close?.(); } catch (x) { alert(x.message); b.disabled = false; } }));
    return r;
  }

  // ---------- details ----------
  function details(a) {
    if (!a) return;
    const d = a.startAt.toDate(), dur = a.durationConfirmed || a.durationEst || 30, t = typeOf(a);
    const vc = a.tentative ? VISIT_TAG[a.visitConfirm?.status || "waiting"] : null;
    const map = mapsHref(a.homeService);
    const node = html(`<div class="cal-det">
      <p><span class="tag ${t}">${TYPE_LABEL[t]}</span> ${vc ? `<span class="tag" style="color:${vc[1]}">${vc[0]}</span>` : ""} <span class="small">${esc(a.code || "")}</span></p>
      <p><b>${fmtWhen(d.getTime())}</b> → ${fmtTime(d.getTime() + dur * 60000)} · ~${dur} min${a.providerName ? ` · ${esc(a.providerName)}` : ""}</p>
      <p><b>${esc(a.customer?.name || "")}</b>${a.customer?.phone ? ` · ${esc(a.customer.phone)}` : ""} ${msgrBtn(a.customer?.messenger)}</p>
      <ul>${(a.items || []).map((l) => `<li>${esc(l.name)} · ${money(l.price)}</li>`).join("")}</ul>
      ${a.homeService?.prep?.bring?.length ? `<div class="small" style="color:#b45309;font-weight:600">🧺 Bring: ${esc(a.homeService.prep.bring.join(", "))}</div>` : ""}${a.homeService ? `<p>🏠 ${esc(a.homeService.address || "")}${a.homeService.landmark ? ` · ${esc(a.homeService.landmark)}` : ""}${a.homeService.area ? ` · <b>${esc(a.homeService.area)}</b>` : ""} · fee ${money(a.homeFee || 0)}${map ? ` · <a href="${esc(map)}" target="_blank" rel="noopener">Open map ↗</a>` : ""}</p><p class="small">🚗 ${a.travelBefore || 0} min travel before & after is blocked.</p>` : ""}
      ${a.onTheWay ? `<p class="small">🚗 On the way · ETA ${fmtTime(a.onTheWay.etaAt)}</p>` : ""}
      ${a.notes ? `<p class="small">📝 ${esc(a.notes)}</p>` : ""}
      <p><b>${money((a.total || 0) + (a.homeFee || 0))}</b> ${a.paid ? "· paid" : ""}</p>
      <div data-c></div><div data-mk></div>
      <div class="ct-row" data-ops></div></div>`);
    node.querySelector("[data-c]").appendChild(contactRow(a, store(), { kind: "confirm", staffToken: tok() }));
    if (a.tentative && ["pending", "confirmed"].includes(a.status)) node.querySelector("[data-mk]").appendChild(markRow(a));
    const ops = node.querySelector("[data-ops]");
    const add = (label, fn, cls = "") => { const b = html(`<button type="button" class="ct-btn ${cls}">${label}</button>`); b.onclick = fn; ops.appendChild(b); };
    if (["pending", "confirmed", "unconfirmed"].includes(a.status)) {
      if (a.homeService) add("🚗 On my way", () => onMyWay(a, store(), tok()).catch((x) => alert(x.message)));
      add("🕒 Move", () => moveForm(a));
      add("✕ Cancel", async () => { const r = prompt("Cancel this booking? Reason:"); if (r == null) return; await updateDoc(doc(db, "stores", o.storeId, "appointments", a.id), { status: "cancelled", cancelReason: r || "Cancelled by salon", cancelledAt: serverTimestamp(), updatedAt: serverTimestamp() }).catch((x) => alert(x.message)); o.close?.(); }, "bad");
    }
    if (a.status === "done" || a.paid) add("📅 Next visit", () => nextVisitForm(a));
    o.open(`${esc(a.customer?.name || "Booking")}`, node);
  }
  function moveForm(a) {
    const d = a.startAt.toDate();
    const node = html(`<div class="cal-form"><label>New date & time</label><input type="datetime-local" data-when value="${dstr(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}"/><p class="small">The client is not told automatically — use 💬 Text after moving.</p><button type="button" class="ct-btn ok" data-go>Move</button></div>`);
    node.querySelector("[data-go]").onclick = async () => {
      const n = new Date(node.querySelector("[data-when]").value); if (isNaN(n)) return alert("Pick a date and time.");
      const s0 = n.getTime() - (a.travelBefore || 0) * 60000, e0 = n.getTime() + ((a.durationConfirmed || a.durationEst || 30) + (a.buffer || 0)) * 60000;
      const clash = a.providerId && S.appts.find((x) => x.id !== a.id && x.providerId === a.providerId && x.status !== "done" && x.startAt.toMillis() - (x.travelBefore || 0) * 60000 < e0 && x.startAt.toMillis() + ((x.durationConfirmed || x.durationEst || 30) + (x.buffer || 0)) * 60000 > s0);
      if (clash && !confirm(`${a.providerName || "This stylist"} already has ${clash.customer?.name || "a client"} at that time.\n\nMove anyway?`)) return;
      try { await updateDoc(doc(db, "stores", o.storeId, "appointments", a.id), { startAt: Timestamp.fromDate(n), updatedAt: serverTimestamp() }); o.close?.(); const moved = { ...a, startAt: Timestamp.fromDate(n) }; const box = html(`<div><p>Moved to <b>${fmtWhen(n.getTime())}</b>. Let the client know:</p></div>`); box.appendChild(contactRow(moved, store(), { kind: "moved" })); o.open("Moved", box); }
      catch (x) { alert(x.message); }
    };
    o.open("Move booking", node);
  }

  // ---------- add booking / next visit ----------
  function slotMenu(d, staffId) {
    const node = html(`<div class="cal-form"><p><b>${fmtWhen(d.getTime())}</b></p><div class="ct-row"><button type="button" class="ct-btn ok" data-a>➕ Add booking here</button><button type="button" class="ct-btn" data-b>⛔ Block from here</button></div></div>`);
    node.querySelector("[data-a]").onclick = () => addForm(d, { providerId: staffId });
    node.querySelector("[data-b]").onclick = () => { const e = new Date(d.getTime() + 60 * 60000); blockForm(dstr(d), `${pad(d.getHours())}:${pad(d.getMinutes())}`, `${pad(e.getHours())}:${pad(e.getMinutes())}`, staffId); };
    o.open("Free time", node);
  }
  function nextVisitForm(a) {
    const weeks = Math.max(0, ...(a.items || []).map((l) => Number(S.items.find((i) => i.id === l.itemId)?.rebookWeeks) || 0)) || 4;
    const d = new Date(a.startAt.toMillis() + weeks * 7 * 864e5);
    addForm(d, { tentative: true, fromApptId: a.id, name: a.customer?.name, phone: a.customer?.phone, itemIds: (a.items || []).map((l) => (l.variantIdx != null ? `${l.itemId}~${l.variantIdx}` : l.itemId)).filter(Boolean), home: !!a.homeService, area: a.homeService?.area || "", providerId: a.providerId, title: "📅 Next visit" });
  }
  function addForm(d, pre = {}) {
    const hs = hsCfg(); const areas = (hs.areas || []).filter((x) => x.name); const pl = place();
    const svc = S.items.filter((i) => i.available !== false && !i.retail);
    const homeOn = pl === "home" || (pl === "both" && pre.home);
    const node = html(`<div class="cal-form">
      ${pre.tentative ? `<p class="small">Saved as a <b>tentative</b> booking — the time is reserved. The day before, it shows in <b>📞 To confirm</b> so you can call or text the client.</p>` : ""}
      <div class="g2"><div><label>Client name</label><input data-name value="${esc(pre.name || "")}"/></div><div><label>Phone</label><input data-phone inputmode="tel" value="${esc(pre.phone || "")}"/></div></div>
      <div class="g2"><div><label>Date & time</label><input type="datetime-local" data-when value="${dstr(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}"/></div>
      <div><label>Staff</label><select data-staff>${stylists().length ? "" : `<option value="">—</option>`}${stylists().length > 1 ? `<option value="">Assign later</option>` : ""}${stylists().map((s) => `<option value="${s.id}" ${pre.providerId === s.id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></div></div>
      ${pl === "both" ? `<label class="ck"><input type="checkbox" data-home ${homeOn ? "checked" : ""}/> 🏠 Home service</label>` : pl === "home" ? `<p class="small">🏠 Home service</p>` : ""}
      <div data-hbox ${homeOn ? "" : 'style="display:none"'}>
        ${areas.length ? `<label>Area</label><select data-area><option value="">— choose —</option>${areas.map((x) => `<option ${pre.area === x.name ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select>` : ""}
        <label>Address <span class="small">(blank = client's saved address)</span></label><input data-address/>
        <label>Landmark</label><input data-landmark/>
      </div>
      <label>Services</label><div class="svcs">${S.cats.map((c) => { const its = svc.filter((i) => i.categoryId === c.id); return its.length ? `<div class="small" style="font-weight:700;margin-top:6px">${esc(c.name)}</div>${its.flatMap((i) => (i.variants || []).length ? i.variants.map((v, vi) => ({ k: `${i.id}~${vi}`, n: `${i.name} (${v.label})`, p: v.price, d: v.duration || i.durationMinutes, item: i.id })) : [{ k: i.id, n: i.name, p: i.price, d: i.durationMinutes }]).map((x) => `<label class="ck"><input type="checkbox" data-svc="${x.k}" ${x.item ? `data-item="${x.item}"` : ""} ${(pre.itemIds || []).includes(x.k) ? "checked" : ""}/> ${esc(x.n)} <span class="small">${money(x.p)} · ${x.d || 30}m</span></label>`).join("")}` : ""; }).join("")}</div>
      <label class="ck"><input type="checkbox" data-tent ${pre.tentative ? "checked" : ""}/> Tentative — confirm with the client before the day</label>
      <label>Notes</label><input data-notes/>
      <button type="button" class="ct-btn ok" data-go style="width:100%;margin-top:10px">Save booking</button></div>`);
    node.querySelector("[data-home]")?.addEventListener("change", (e) => (node.querySelector("[data-hbox]").style.display = e.target.checked ? "" : "none"));
    node.addEventListener("change", (e) => { const c = e.target; if (c.dataset?.item && c.checked) node.querySelectorAll(`[data-item="${c.dataset.item}"]`).forEach((x) => { if (x !== c) x.checked = false; }); });
    node.querySelector("[data-go]").onclick = async (e) => {
      const ids = [...node.querySelectorAll("[data-svc]:checked")].map((c) => c.dataset.svc); if (!ids.length) return alert("Pick at least one service.");
      const when = new Date(node.querySelector("[data-when]").value); if (isNaN(when)) return alert("Set the date and time.");
      const home = pl === "home" || !!node.querySelector("[data-home]")?.checked;
      const body = { itemIds: ids, startAt: when.toISOString(), providerId: node.querySelector("[data-staff]").value || null, customer: { name: node.querySelector("[data-name]").value.trim() || "Client", phone: node.querySelector("[data-phone]").value.trim(), address: node.querySelector("[data-address]")?.value.trim() || "", landmark: node.querySelector("[data-landmark]")?.value.trim() || "" }, homeService: home ? { area: node.querySelector("[data-area]")?.value || "" } : false, tentative: node.querySelector("[data-tent]").checked, fromApptId: pre.fromApptId || null, notes: node.querySelector("[data-notes]").value.trim(), staffName: o.meName?.() || null, staffToken: tok(), force: !!pre.fromApptId };
      e.target.disabled = true;
      try {
        try { await call("staffCreateAppointment", body); }
        catch (err) { if (!OVERRIDE_RE.test(err.message) || !confirm(`${err.message}\n\nBook anyway?`)) throw err; await call("staffCreateAppointment", { ...body, force: true }); }
        o.close?.(); S.anchor = when; watch(); draw();
      } catch (err) { alert(err.message); e.target.disabled = false; }
    };
    o.open(pre.title || "New booking", node);
  }

  // ---------- block time / can't work ----------
  function blockForm(date, from, to, staffId = null) {
    const node = html(`<div class="cal-form"><div class="g2"><div><label>Date</label><input type="date" data-d value="${date}"/></div><div><label>Who</label><select data-s><option value="">Everyone</option>${stylists().map((s) => `<option value="${s.id}" ${s.id === staffId ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></div></div>
      <div class="g2"><div><label>From</label><input type="time" data-f value="${from}"/></div><div><label>To</label><input type="time" data-t value="${to}"/></div></div>
      <label>Reason (only you see this)</label><input data-r placeholder="e.g. errands, lunch, dentist"/>
      <button type="button" class="ct-btn ok" data-go style="width:100%;margin-top:10px">Block this time</button></div>`);
    node.querySelector("[data-go]").onclick = async (e) => { e.target.disabled = true; try { await call("blockTime", { date: node.querySelector("[data-d]").value, from: node.querySelector("[data-f]").value, to: node.querySelector("[data-t]").value, staffId: node.querySelector("[data-s]").value || null, reason: node.querySelector("[data-r]").value, staffToken: tok() }); o.close?.(); } catch (x) { alert(x.message); e.target.disabled = false; } };
    o.open("Block time", node);
  }
  function sickDay() {
    const ymd = dstr(S.anchor); const isToday = ymd === dstr(new Date());
    const node = html(`<div class="cal-form"><p>Block <b>${isToday ? "today" : S.anchor.toLocaleDateString("en-PH", { weekday: "long", month: "short", day: "numeric" })}</b> so no one can book, then message the clients you already have.</p>
      ${stylists().length > 1 ? `<label>Who can't work</label><select data-s>${stylists().map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}</select>` : ""}
      <button type="button" class="ct-btn bad" data-go style="width:100%;margin-top:10px">🤒 Block the whole day</button><div data-list style="margin-top:12px"></div></div>`);
    node.querySelector("[data-go]").onclick = async (e) => {
      const sid = node.querySelector("[data-s]")?.value || stylists()[0]?.id || null;
      e.target.disabled = true;
      try {
        await call("blockTime", { date: ymd, from: "00:00", to: "23:59", staffId: stylists().length > 1 ? sid : null, reason: "Can't work (sick / emergency)", staffToken: tok() });
        e.target.textContent = "✓ Day blocked";
        const affected = S.appts.filter((a) => dstr(a.startAt.toDate()) === ymd && ["unconfirmed", "pending", "confirmed"].includes(a.status) && (stylists().length <= 1 || !sid || a.providerId === sid));
        const list = node.querySelector("[data-list]");
        list.innerHTML = affected.length ? `<p><b>${affected.length} client${affected.length > 1 ? "s" : ""} to message</b> — each text has a link to pick a new time:</p>` : `<p class="small">No clients booked that day. 👍</p>`;
        affected.forEach((a) => { const row = html(`<div class="cc-row"><div><b>${esc(a.customer?.name || "")}</b> · ${fmtTime(a.startAt.toMillis())}</div></div>`); row.appendChild(contactRow(a, store(), { kind: "sick", staffToken: tok() })); list.appendChild(row); });
      } catch (x) { alert(x.message); e.target.disabled = false; }
    };
    o.open("Can't work", node);
  }
  function routePanel() {
    const ymd = dstr(S.anchor);
    const list = S.appts.filter((a) => a.homeService && dstr(a.startAt.toDate()) === ymd && a.status !== "done").sort((x, y) => x.startAt.toMillis() - y.startAt.toMillis());
    const node = html(`<div class="cal-form">${list.length ? `<ol class="route">${list.map((a) => { const m = mapsHref(a.homeService); return `<li><b>${fmtTime(a.startAt.toMillis())}</b> · ${esc(a.customer?.name || "")}<br><span class="small">${esc(a.homeService.address || "")}${a.homeService.landmark ? ` · ${esc(a.homeService.landmark)}` : ""}${a.homeService.area ? ` · ${esc(a.homeService.area)}` : ""}</span>${m ? `<br><a class="ct-btn" href="${esc(m)}" target="_blank" rel="noopener">🗺 Open in Maps</a>` : ""} ${a.customer?.phone ? `<a class="ct-btn" href="tel:${esc(a.customer.phone)}">📞</a>` : ""}</li>`; }).join("")}</ol>` : `<p>No home service ${ymd === dstr(new Date()) ? "today" : "this day"}.</p>`}</div>`);
    o.open(`🗺 Route · ${S.anchor.toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric" })}`, node);
  }

  watch(); draw();
  return { destroy() { S.unsubs.forEach((u) => u()); S.rangeUnsub?.(); }, refresh: () => draw(), nextVisit: (a) => whenReady(() => nextVisitForm(a)), details: (a) => details(a), goto(d, view) { S.anchor = d; if (view) S.view = view; watch(); draw(); } };
}
