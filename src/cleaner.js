// Stay / Airbnb — cleaner app (inside /staff/ when store.mode === "stay"): rooms to clean, chime when a guest checks out
import { db, call } from "./firebase.js";
import { collection, onSnapshot, query, orderBy, limit } from "firebase/firestore";
import { auth } from "./firebase.js";
import { uploadPrivateImage } from "./upload.js";
import { chime, startRinging, stopRinging, clearActiveStaff, pinGate } from "./staffauth.js";
import { watchMaintenance } from "./maint.js";
watchMaintenance("staff");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const html = (str) => { const t = document.createElement("template"); t.innerHTML = str.trim(); return t.content.firstElementChild; };
const ago = (ms) => { const m = Math.max(0, Math.floor((Date.now() - ms) / 60000)); return m < 60 ? `${m} min ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`; };

export function bootCleaner({ app, storeId, store, me }) {
  let rooms = [], known = null, stays = [], checkOpen = {};
  const CHECK = ["Change bed sheets & pillowcases", "Clean & disinfect bathroom", "Replace towels & toiletries", "Sweep & mop floors", "Empty trash bins", "Check aircon, lights, TV remote", "Report damages or lost items"];
  app.innerHTML = `<div><header class="k-head"><span class="name">🧹 ${esc(me?.name || "")}</span><span class="muted small">${esc(store.name)}</span><span class="sp"></span><button class="k-btn sm" id="sw">👤 Switch</button></header>
    <div class="k-remind">📱 Keep this app open — it rings when a guest checks out.</div><div id="main" class="r-main"></div></div>`;
  app.querySelector("#sw").onclick = async () => { clearActiveStaff(storeId); await pinGate({ storeId, storeName: store.name, requireRoles: ["cleaner"], screenName: "Caretaker app" }); location.reload(); };
  document.addEventListener("pointerdown", () => stopRinging(), true);
  const act = async (action, roomId, extra = {}) => { try { await call("stayStaffAction", { action, roomId, staffName: me?.name || "", ...extra }); } catch (e) { alert(e.message); } };
  const t12 = (ms) => new Date(ms).toLocaleString("en-PH", { weekday: "short", hour: "numeric", minute: "2-digit" });
  const nextFor = (roomId) => stays.filter((x) => x.roomId === roomId && ["confirmed", "pending", "unconfirmed"].includes(x.status) && x.checkIn?.toMillis?.() > Date.now() - 3600000).sort((a, b) => a.checkIn.toMillis() - b.checkIn.toMillis())[0];
  const nextHTML = (r) => { const n = nextFor(r.id); if (!n) return `<div class="small muted">No next booking yet.</div>`; const by = n.checkIn.toMillis() - 3600000; const prep = (n.addons || []).filter((a) => a.status === "approved");
    return `<div class="small" style="background:#fff4d6;border-radius:10px;padding:8px 10px;margin-top:6px">🛎 <b>Next guest ${t12(n.checkIn.toMillis())}</b> · 👥 ${n.guests}${n.short ? ` · ⏳ ${n.short.hours} h` : ""}<br>✨ Make sure the room is clean by <b>${new Date(by).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}</b>${prep.length ? `<br>🧺 Prepare: ${prep.map((a) => `${esc(a.name)} × ${a.qty}`).join(" · ")}` : ""}</div>`; };
  // 🔍 room check at check-out → items counted, stains / damage with photo → deposit deductions
  function checkForm(r, st) {
    const el = html(`<div class="k-item" style="display:block;margin-top:8px"><b>🔍 Check the room first</b> <span class="small muted">— before cleaning${st.deposit?.amount ? ` · deposit ₱${st.deposit.amount}` : ""}</span>
      ${(st.inventory || []).map((i) => `<div style="display:flex;justify-content:space-between;align-items:center;margin:6px 0"><span>${esc(i.name)} <span class="small muted">(should be ${i.qty})</span></span><input class="k-input" type="number" min="0" data-cnt="${esc(i.name)}" value="${i.qty}" style="width:72px;margin:0"/></div>`).join("")}
      <div data-ded></div>
      <button class="k-btn sm" data-addd type="button">+ Stain / damage</button>
      <div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><button class="k-btn ready" data-done style="flex:1">✓ Room checked</button><button class="k-btn danger" data-inside>🚪 Guest still inside</button></div></div>`);
    const dedBox = el.querySelector("[data-ded]");
    el.querySelector("[data-addd]").onclick = () => { const row = html(`<div style="border-top:1px dashed #ddd;padding-top:6px;margin-top:6px"><input class="k-input" data-dl placeholder="e.g. Blanket stain — laundry" style="margin:0 0 6px"/><div style="display:flex;gap:6px"><input class="k-input" data-da type="number" min="0" placeholder="₱ amount" style="margin:0;flex:1"/><label class="k-btn sm" style="margin:0">📷 Photo<input type="file" accept="image/*" capture="environment" data-dp hidden/></label></div><div class="small muted" data-dps></div></div>`);
      row.querySelector("[data-dp]").onchange = async (e) => { const f = e.target.files?.[0]; if (!f) return; row.querySelector("[data-dps]").textContent = "Uploading…"; try { row.dataset.photo = await uploadPrivateImage(storeId, auth.currentUser.uid, f, { max: 1280, name: `check_${st.id}_${Date.now()}` }); row.querySelector("[data-dps]").textContent = "📷 Photo attached ✓"; } catch (x) { row.querySelector("[data-dps]").textContent = x.message; } };
      dedBox.appendChild(row); };
    el.querySelector("[data-done]").onclick = async (e) => {
      const counts = Object.fromEntries([...el.querySelectorAll("[data-cnt]")].map((i) => [i.dataset.cnt, Number(i.value)]));
      const deductions = [...dedBox.children].map((rw) => ({ label: rw.querySelector("[data-dl]").value.trim(), amount: Number(rw.querySelector("[data-da]").value || 0), photo: rw.dataset.photo || "" })).filter((x) => x.label);
      if (deductions.some((x) => !x.photo) && !confirm("Some items have no photo. The guest sees photos as proof — continue without?")) return;
      e.target.disabled = true;
      try { await call("stayStaffAction", { action: "roomCheck", id: st.id, counts, deductions, staffName: me?.name || "" }); delete checkOpen[r.id]; } catch (x) { alert(x.message); e.target.disabled = false; }
    };
    el.querySelector("[data-inside]").onclick = async () => { if (!confirm("The guest is still in the room? Overstay will keep counting and the caretaker is alerted.")) return; try { await call("stayStaffAction", { action: "stillInside", id: st.id, staffName: me?.name || "" }); } catch (x) { alert(x.message); } };
    return el;
  }
  const draw = () => {
    const main = document.getElementById("main"); main.innerHTML = "";
    const todo = rooms.filter((r) => ["to_clean", "cleaning"].includes(r.housekeeping?.status));
    if (!todo.length) main.appendChild(html(`<div class="k-empty">✨ All rooms are clean.<br><span class="small">You'll hear a chime when a guest checks out.</span></div>`));
    todo.forEach((r) => {
      const st = r.housekeeping.status;
      const el = html(`<article class="k-card" style="border-top-color:${st === "cleaning" ? "var(--prep)" : "var(--new)"}">
        <div class="top"><div><div class="no">${esc(r.name)}</div><div class="where">${st === "cleaning" ? `🧽 Cleaning · ${esc(r.housekeeping.cleanerName || "")}` : `🧹 Guest left ${r.housekeeping.since ? ago(r.housekeeping.since) : ""}`}</div></div></div>
        ${st === "cleaning" ? `<div class="d-comps" style="margin:8px 0 0">${CHECK.map((c, i) => `<label class="d-comp"><input type="checkbox" data-c="${i}"/> ${c}</label>`).join("")}</div>` : ""}
        <div class="acts"></div></article>`);
      const a = el.querySelector(".acts");
      el.insertBefore(html(`<div>${nextHTML(r)}</div>`), a);
      const sty = stays.find((x) => x.id === r.housekeeping.stayId);
      if (r.housekeeping.needsCheck && sty && !sty.roomCheck && ((sty.inventory || []).length || sty.deposit?.amount)) { el.insertBefore(checkForm(r, sty), a); main.appendChild(el); return; }
      if (st === "to_clean") { const b = html(`<button class="k-btn prep" style="flex:1">🧽 Start cleaning</button>`); b.onclick = () => act("roomCleaning", r.id); a.appendChild(b); const sk = html(`<button class="k-btn">⏭ Skip</button>`); sk.onclick = () => { const why = prompt("Skip cleaning — why? (e.g. guest didn't use it)", "Not used"); if (why !== null) act("roomSkip", r.id, { reason: why }); }; a.appendChild(sk); }
      else { const b = html(`<button class="k-btn ready" style="flex:1" disabled>✓ Finished cleaning — room ready</button>`); b.onclick = () => act("roomClean", r.id); a.appendChild(b);
        // need more time? the guest's "ready around" moves and the owner sees it's still being cleaned
        const more = html(`<div class="row" style="gap:6px;width:100%;margin-top:6px;align-items:center"><span class="small muted" style="flex:1">${r.housekeeping.eta ? `Ready around ${new Date(r.housekeeping.eta).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}${r.housekeeping.extraMin ? ` (+${r.housekeeping.extraMin} min)` : ""}` : "Need more time?"}</span><button class="k-btn sm" data-more="15">+15 min</button><button class="k-btn sm" data-more="30">+30 min</button></div>`);
        more.querySelectorAll("[data-more]").forEach((m) => (m.onclick = () => act("roomMore", r.id, { minutes: Number(m.dataset.more) })));
        a.style.flexWrap = "wrap"; a.appendChild(more);
        el.querySelectorAll("[data-c]").forEach((c) => (c.onchange = () => { c.closest(".d-comp").classList.toggle("on", c.checked); b.disabled = ![...el.querySelectorAll("[data-c]")].every((x) => x.checked); })); }
      main.appendChild(el);
    });
    // arriving now (hour packages start when the guest is in) + open problems reported by guests
    stays.filter((x) => ["confirmed", "pending"].includes(x.status) && x.checkIn?.toMillis?.() - Date.now() < 3600000 && x.checkIn.toMillis() - Date.now() > -3 * 3600000).forEach((x) => {
      const el = html(`<div class="k-note" style="margin-bottom:10px;border-left:4px solid var(--prep)"><b>🛎 Arriving · ${esc(x.roomName)}</b> · ${esc(x.customer?.name || "")} · ${t12(x.checkIn.toMillis())}${x.short ? ` · ⏳ ${x.short.hours} h` : ""}<div style="margin-top:6px"><button class="k-btn sm prep">✓ Guest is in the room${x.short ? " — start the clock" : ""}</button></div></div>`);
      el.querySelector("button").onclick = () => call("stayStaffAction", { action: x.short ? "arrived" : "checkin", id: x.id, staffName: me?.name || "" }).catch((e) => alert(e.message));
      main.insertBefore(el, main.firstChild);
    });
    stays.filter((x) => x.status === "checked_in" && (x.issues || []).some((i) => i.status !== "fixed")).forEach((x) => (x.issues || []).filter((i) => i.status !== "fixed").forEach((i) => {
      const el = html(`<div class="k-note" style="margin-bottom:10px;border-left:4px solid var(--danger)"><b>🛠 ${esc(x.roomName)}: ${esc(i.text)}</b><div style="margin-top:6px"><button class="k-btn sm ready">✓ Fixed</button></div></div>`);
      el.querySelector("button").onclick = () => call("stayStaffAction", { action: "issueReply", id: x.id, issueId: i.id, done: true, reply: "Fixed", staffName: me?.name || "" }).catch((e) => alert(e.message));
      main.insertBefore(el, main.firstChild);
    }));
    const cancelled = stays.filter((x) => ["cancelled", "declined"].includes(x.status) && x.checkIn?.toMillis?.() > Date.now() - 86400000 && (x.updatedAt?.toMillis?.() || 0) > Date.now() - 3 * 86400000);
    if (cancelled.length) main.appendChild(html(`<div class="k-item" style="display:block;margin-top:12px"><b>✕ Cancelled — no need to prepare</b>${cancelled.map((x) => `<div class="small" style="padding:4px 0">${esc(x.roomName)} · ${t12(x.checkIn.toMillis())} · ${esc(x.customer?.name || "")}</div>`).join("")}</div>`));
    const rest = rooms.filter((r) => !todo.includes(r));
    if (rest.length) main.appendChild(html(`<div class="k-item" style="display:block;margin-top:12px">${rest.map((r) => `<div style="display:flex;justify-content:space-between;padding:6px 0"><span>${esc(r.name)}</span><span class="small muted">${r.housekeeping?.status === "occupied" ? "🛏 Occupied" : "✅ Ready"}${nextFor(r.id) ? ` · next ${t12(nextFor(r.id).checkIn.toMillis())}` : ""}</span></div>`).join("")}</div>`));
  };
  onSnapshot(query(collection(db, "stores", storeId, "rooms"), orderBy("sortOrder")), (snap) => {
    rooms = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const dirty = new Set(rooms.filter((r) => r.housekeeping?.status === "to_clean").map((r) => r.id + (r.housekeeping.since || "")));
    if (known && [...dirty].some((k) => !known.has(k))) startRinging(0.6);
    if (!dirty.size) stopRinging();
    known = dirty; draw();
  });
  onSnapshot(query(collection(db, "stores", storeId, "stays"), orderBy("checkIn", "desc"), limit(120)), (snap) => { stays = snap.docs.map((d) => ({ id: d.id, ...d.data() })); draw(); }, () => {});
  setInterval(draw, 60000);
}
