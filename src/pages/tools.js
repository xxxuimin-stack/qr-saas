// Tools: every setting in one organized place (groups → settings cards / pages), with search.
import { call } from "../firebase.js";
import { esc, html, toast, openModal, closeModal } from "../ui.js";
import { renderSettingsPage, SECTION_HELP } from "./settings.js";
import { maybeTour } from "../onboarding.js";

/** Groups shown on the Tools hub. items: [title, keywords, go, help?] */
export function toolGroups(ctx) {
  const m = ctx.mode, owner = ctx.role === "owner";
  const G = [
    { id: "shop", icon: "🏪", title: "Shop", sub: "Info, logo, link, theme, hours", items: [["Business info", "name tagline phone address", "#tools/shop:info"], ["Logo & cover photo", "branding logo cover", "#tools/shop:branding"], ["Store link", "slug url address link", "#tools/shop:link"], ["Theme & colors", "theme colors layout seasonal", "#tools/shop:theme"], ["Opening hours", "hours schedule open close closed", "#tools/shop:hours"]] },
    { id: "selling", icon: "💳", title: m === "salon" ? "Payments" : "Selling", sub: m === "salon" ? "GCash, Maya, cash" : "Order types, delivery, payments, confirmation", items: [...(m === "salon" ? [] : [["Order types & delivery", "dine-in take-out pickup delivery fee small order advance closed", "#tools/selling:service"]]), ["Payment methods", "gcash maya bank cash qr", "#tools/selling:payments"], ...(m === "table" ? [["Messenger confirmation", "fake orders confirm messenger", "#tools/selling:confirm"]] : [])] },
    ...(m === "salon" || m === "stay" || m === "table" ? [{ id: "booking", icon: "📅", title: "Booking rules", sub: m === "salon" ? "Slots, cancellations, home service, no-shows, DP" : m === "stay" ? "Check-in, downpayment, pool, rules" : "Reservations, events, VIP rooms", items: m === "salon" ? [["Booking & salon rules", "slot buffer advance cancel grace home service no-show deposit dp", "#tools/booking:salon"], ["Messenger confirmation", "confirm messenger", "#tools/booking:confirm"]] : m === "stay" ? [["Stay settings", "check-in check-out downpayment pool extension waiver", "#tools/booking:stay"], ["Messenger confirmation", "confirm messenger", "#tools/booking:confirm"]] : [["Reservations, events & VIP rooms", "reservation event vip ktv call staff features", "#tools/booking:features"], ["Reservations list", "reservations bookings", "#reservations"]] }] : []),
    { id: "team", icon: "👥", title: "Team", sub: "Staff, PINs, shifts & cash count", items: [["Staff & PINs", "staff pin roles stylist invite schedule", "#staff"], ["Shift & cash count", "shift cash blind count tolerance", "#tools/team:shifts"]] },
    { id: "grow", icon: "📈", title: "Grow", sub: "Promos, vouchers, SMS, news, loyalty", items: [["Promos & vouchers", "promo discount voucher combo", "#promos"], ...(ctx.store?.businessType === "freelance" ? [] : [["🎥 Invite a creator", "creator influencer vlogger tiktok collab marketing", "#creators"]]), ["News & announcements", "announcement news hiring closed", "#announcements"], ["SMS promos", "sms text semaphore", "#tools/grow:sms"], ...(m === "salon" ? [["Loyalty, gift cards, memberships, referral, birthday", "loyalty gift card membership referral birthday packages reminders rebook", "#tools/grow:salongrow"]] : []), ["Google review link", "google review stars", "#tools/shop:info"]] },
    { id: "customers", icon: "⭐", title: "Customers & feedback", sub: "Client records, ratings, incidents", items: [["Customers", "customers clients phone blocked no-show", "#customers"], ["Feedback & ratings", "feedback rating review incident", "#feedback"]] },
    { id: "alerts", icon: "🔔", title: "Printing & alerts", sub: "Receipt printer, Telegram, daily summary", items: [["Printing", "printer receipt kitchen ticket", "#tools/alerts:printing"], ["Telegram alerts & daily summary", "telegram alert notify daily summary", "#tools/alerts:telegram"]] },
    ...(owner ? [{ id: "branches", icon: "🏬", title: "Branches", sub: "Run more than one branch", items: [["Branches", "branch multi location", "#branches"]] }, { id: "billing", icon: "💳", title: "Plan & billing", sub: "Your plan, add-ons, payment", items: [["Plan & billing", "plan billing subscription pro basic addon", "#billing"]] }] : []),
    { id: "advanced", icon: "🧪", title: "Advanced", sub: "Test mode, business setup, all settings", items: [["Test mode", "test practice try one device", "#tools/advanced:test"], ["Business setup", "setup staff solo home-based owner works", "#tools/advanced:setup"], ["All settings (one page)", "settings all", "#settings"]] },
  ];
  return G;
}

export function renderToolsPage(root, ctx, param = "") {
  const [group, sec] = String(param || "").split(":");
  if (!group) return hub(root, ctx);
  if (group === "advanced") return advanced(root, ctx, sec);
  const g = toolGroups(ctx).find((x) => x.id === group);
  root.innerHTML = "";
  const head = html(`<div class="tools-head"><a class="btn ghost sm" href="#tools">‹ Tools</a><h2>${g ? `${g.icon} ${esc(g.title)}` : "Settings"}</h2></div>`);
  root.appendChild(head);
  if (g && g.items.some(([, , go]) => !go.startsWith("#tools/"))) {
    root.appendChild(html(`<div class="tools-links">${g.items.filter(([, , go]) => !go.startsWith("#tools/")).map(([t, , go]) => `<a class="tool-link" href="${go}">${esc(t)} ›</a>`).join("")}</div>`));
  }
  if (group === "shop" && ctx.drawSeasonTile) { const st = document.createElement("div"); root.appendChild(st); ctx.drawSeasonTile(st, ctx); }
  const box = document.createElement("div"); root.appendChild(box);
  return renderSettingsPage(box, ctx, { group, sec });
}

function hub(root, ctx) {
  const groups = toolGroups(ctx);
  root.innerHTML = `<div class="row between wrap" style="gap:8px;margin-bottom:10px"><span></span><button type="button" class="btn ghost sm" id="replayTour">▶ Replay the tour</button></div><div class="tools-search"><label class="sr-only" for="toolSearch">Search settings</label><input id="toolSearch" type="search" placeholder="🔎 Search settings — e.g. GCash, hours, PIN, delivery fee" autocomplete="off"/></div>
    <div class="tools-grid" id="toolGrid">${groups.map((g) => `<section class="tool-card" data-g="${g.id}" aria-labelledby="tg-${g.id}">
      <h3 id="tg-${g.id}"><span class="tool-ic" aria-hidden="true">${g.icon}</span>${esc(g.title)}</h3><p class="muted small">${esc(g.sub)}</p>
      <ul>${g.items.map(([t, kw, go]) => `<li data-kw="${esc((t + " " + kw).toLowerCase())}"><a href="${go}">${esc(t)}</a>${SECTION_HELP[go.split(":")[1]] ? `<button type="button" class="help-q" aria-label="About ${esc(t)}" data-help="${esc(SECTION_HELP[go.split(":")[1]])}">?</button>` : ""}</li>`).join("")}</ul></section>`).join("")}</div>
    <p class="muted small" id="toolNone" hidden>No settings match. Try another word.</p>`;
  root.querySelector("#replayTour").onclick = () => { document.body.classList.remove("nav-open"); location.hash = "#overview"; setTimeout(() => maybeTour(ctx, true), 500); };
  root.querySelectorAll("[data-help]").forEach((b) => (b.onclick = () => toast(b.dataset.help)));
  root.querySelector("#toolSearch").oninput = (e) => {
    const q = e.target.value.trim().toLowerCase(); let any = false;
    root.querySelectorAll(".tool-card").forEach((c) => {
      let hit = 0; c.querySelectorAll("li").forEach((li) => { const ok = !q || li.dataset.kw.includes(q); li.hidden = !ok; if (ok) hit++; });
      c.hidden = !hit; if (hit) any = true;
    });
    root.querySelector("#toolNone").hidden = any;
  };
}

function advanced(root, ctx, sec) {
  const st = ctx.store.settings?.setup || {};
  const m = ctx.mode;
  const choices = m === "salon" ? [["team", "👥 I have staff"], ["solo", "🏠 Just me (owner-only / home service)"]] : m === "table" ? [["shop", "🏪 Shop with staff"], ["home", "🏠 Home-based (delivery / pickup only)"]] : [];
  root.innerHTML = `<div class="tools-head"><a class="btn ghost sm" href="#tools">‹ Tools</a><h2>🧪 Advanced</h2></div>
    <div class="tile" id="sec-test"><h3>🧪 Test mode</h3><div id="testBox"></div></div>
    ${choices.length ? `<div class="tile" id="sec-setup"><h3>🧭 Business setup</h3><p class="muted small">How you run the business. Changing it shows or hides features — nothing is deleted.</p>
      <div class="setup-choices">${choices.map(([k, l]) => `<label class="check big"><input type="radio" name="setupKind" value="${k}" ${(st.kind || (m === "salon" ? "team" : "shop")) === k ? "checked" : ""}/> ${l}</label>`).join("")}</div>
      ${m === "salon" ? `<label class="check"><input type="checkbox" id="setupOw" ${st.ownerWorks ? "checked" : ""}/> I also serve clients myself (owner works too)</label>
      <label style="margin-top:10px">Where do you serve clients?</label><select id="setupPlace">${[["shop", "🏪 In my shop"], ["home", "🏠 Home service only"], ["both", "🏪+🏠 Shop and home service"]].map(([k, l]) => `<option value="${k}" ${(st.place || (ctx.store.settings?.salon?.homeService?.enabled ? "both" : "shop")) === k ? "selected" : ""}>${l}</option>`).join("")}</select>` : ""}
      <button class="btn" type="button" id="setupSave" style="margin-top:10px">Save setup</button></div>` : ""}
    <div class="tile"><h3>⚙️ All settings</h3><p class="muted small">Prefer one long page? <a href="#settings">Open all settings</a>.</p></div>`;
  ctx.drawTestTile?.(root.querySelector("#testBox"), ctx);
  root.querySelector("#setupSave")?.addEventListener("click", async () => {
    const kind = root.querySelector("[name=setupKind]:checked")?.value; const ow = !!root.querySelector("#setupOw")?.checked;
    const needOwner = (m === "salon" && (kind === "solo" || ow)) || (m === "table" && kind === "home");
    const body = { setup: { kind, ownerWorks: ow, place: root.querySelector("#setupPlace")?.value } };
    try { await call("changeSetup", body); }
    catch (e) {
      if (needOwner && /PIN/.test(e.message)) {
        const f = html(`<div><p class="small muted">You'll use this PIN on the counter and staff screens.</p><label>Your name</label><input name="n" maxlength="40"/><label>Your PIN (4–6 digits)</label><input name="p" type="password" inputmode="numeric" maxlength="6"/></div>`);
        const foot = html(`<div class="row" style="justify-content:flex-end"><button class="btn ghost" data-no>Cancel</button><button class="btn" data-yes>Save</button></div>`);
        foot.querySelector("[data-no]").onclick = closeModal;
        foot.querySelector("[data-yes]").onclick = async () => { try { await call("changeSetup", { ...body, ownerName: f.querySelector("[name=n]").value, ownerPin: f.querySelector("[name=p]").value }); closeModal(); toast("Setup saved"); ctx.reload(); } catch (x) { toast(x.message, "error"); } };
        return openModal({ title: "Your staff profile", body: f, footer: foot });
      }
      return toast(e.message, "error");
    }
    toast("Setup saved"); ctx.reload();
  });
  if (sec) setTimeout(() => root.querySelector("#sec-" + sec)?.scrollIntoView({ behavior: "smooth" }), 100);
}
