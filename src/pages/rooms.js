// Stay / Airbnb — Rooms editor (owner): title, theme, capacity, prices, amenities, photos tagged by area, posters, blocked dates
// + Bookings list (owner overview of stays)
import { overLimit, limitNote, planLim } from "../planui.js";
import { db, call } from "../firebase.js";
import { collection, doc, addDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy, serverTimestamp, limit } from "firebase/firestore";
import { esc, money, html, toast, openModal, closeModal, confirmDialog } from "../ui.js";
import { uploadImage } from "../upload.js";
import { rowsEditor } from "../rowsedit.js";

const AREAS = ["Bedroom", "Bathroom", "Living", "Kitchen", "Balcony", "Pool", "Outside", "Other"];
const HK = { clean: ["✅", "Ready"], to_clean: ["🧹", "To clean"], cleaning: ["🧽", "Cleaning"], occupied: ["🛏", "Occupied"] };

export function renderRoomsPage(root, ctx) {
  const { storeId } = ctx;
  const col = collection(db, "stores", storeId, "rooms");
  let rooms = [];
  root.innerHTML = `<div class="tile"><div class="row between wrap"><div><h3>🏡 Rooms</h3><p class="small muted">Each room has its own photos, prices and calendar. Guests book from your link or QR.</p></div><div class="row" style="gap:8px"><span id="limRooms"></span><button class="btn" id="addRoom" type="button">+ Add room</button></div></div>
    <div id="roomList" class="itemlist" style="margin-top:12px"></div></div>`;
  const unsub = onSnapshot(query(col, orderBy("sortOrder")), (snap) => { rooms = snap.docs.map((d) => ({ id: d.id, ...d.data() })); const el = root.querySelector("#limRooms"); if (el) el.innerHTML = limitNote(ctx, "rooms", rooms.length); draw(); });
  function draw() {
    const list = root.querySelector("#roomList"); list.innerHTML = rooms.length ? "" : `<p class="muted">No rooms yet. Click "+ Add room".</p>`;
    rooms.forEach((r) => {
      const hk = HK[r.housekeeping?.status || "clean"] || HK.clean;
      const row = html(`<div class="item" style="grid-template-columns:72px 1fr auto;gap:12px">
        <div style="width:72px;height:56px;border-radius:10px;background:#eee center/cover;${r.photos?.[0] ? `background-image:url('${esc(r.photos[0].url)}')` : ""}"></div>
        <div class="info"><div class="n">${esc(r.name)} ${r.active === false ? `<span class="tag">hidden</span>` : ""}</div>
          <div class="d muted small">${money(r.price)} / night${r.weekendPrice ? ` · weekend ${money(r.weekendPrice)}` : ""} · 👥 ${r.capacity || 2} · 📷 ${(r.photos || []).length} · ${hk[0]} ${hk[1]}${r.housekeeping?.status === "cleaning" && r.housekeeping?.eta ? ` <span class="small muted">· ready around ${new Date(r.housekeeping.eta).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}${r.housekeeping.extraMin ? ` (+${r.housekeeping.extraMin} min)` : ""}</span>` : ""}${r.housekeeping?.status === "clean" && r.housekeeping?.readyAt ? ` <span class="small" style="color:#15803d">· ${r.housekeeping.skipped ? "cleaning skipped" : "ready"} since ${new Date(r.housekeeping.readyAt).toLocaleString("en-PH", { weekday: "short", hour: "numeric", minute: "2-digit" })}${r.housekeeping.cleanerName ? ` (${esc(r.housekeeping.cleanerName)})` : ""}${r.housekeeping.minutes ? ` · took ${r.housekeeping.minutes} min` : ""}</span>` : ""}</div></div>
        <span class="row" style="gap:6px"><button class="btn ghost sm" data-edit>Edit</button><button class="btn ghost sm danger-text" data-del>Delete</button></span></div>`);
      row.querySelector("[data-edit]").onclick = () => roomForm(r);
      row.querySelector("[data-del]").onclick = async () => { if (await confirmDialog(`Delete "${r.name}"? Existing bookings stay in the records.`)) deleteDoc(doc(col, r.id)); };
      list.appendChild(row);
    });
  }
  function roomForm(r) {
    let photos = [...(r?.photos || [])], posters = [...(r?.posters || [])], blocked = [...(r?.blocked || [])];
    const body = html(`<div class="form2">
      <div class="span2"><label>Room title</label><input name="name" value="${esc(r?.name || "")}" placeholder="e.g. Garden Room"/></div>
      <div class="span2"><label>Theme / short description</label><input name="theme" value="${esc(r?.theme || "")}" placeholder="e.g. Boho · nature view · good for couples"/></div>
      <div><label>Max guests</label><input name="capacity" type="number" min="1" value="${r?.capacity ?? 2}"/></div>
      <div><label>Beds</label><input name="beds" value="${esc(r?.beds || "")}" placeholder="e.g. 1 queen bed"/></div>
      <div><label>Price per night (weekday)</label><input name="price" type="number" min="0" value="${r?.price ?? ""}"/></div>
      <div><label>Weekend / holiday price</label><input name="weekendPrice" type="number" min="0" value="${r?.weekendPrice ?? ""}" placeholder="same as weekday if blank"/></div>
      <div class="span2"><label>⏳ Hour-package prices for this room <span class="muted small">(blank = use the price in Settings)</span></label><div class="row" style="gap:8px">${[3, 6, 12].map((h) => `<input name="sh${h}" type="number" min="0" placeholder="${h} h" value="${r?.shortPrices?.[h] ?? ""}" style="flex:1"/>`).join("")}</div></div>
      <div class="span2" style="border-top:1px solid var(--line);padding-top:10px"><b>📋 Items in this room</b> <span class="small muted">— the guest confirms this list at check-in; the cleaner counts it at check-out. Missing items are charged from the deposit.</span><div data-inv></div></div>
      <div><label>🔐 Security deposit for this room (₱)</label><input name="deposit" type="number" min="0" value="${r?.deposit ?? ""}" placeholder="blank = same as Settings"/></div>
      <div><label>🚪 Door</label><select name="doorType"><option value="meet" ${(r?.doorType || (r?.passcode ? "smartlock" : "meet")) === "meet" ? "selected" : ""}>Caretaker meets the guest</option><option value="smartlock" ${r?.doorType === "smartlock" || (!r?.doorType && r?.passcode) ? "selected" : ""}>Smart lock (PIN)</option><option value="lockbox" ${r?.doorType === "lockbox" ? "selected" : ""}>Key lockbox (code)</option></select></div>
      <div><label>🔑 Door / lockbox code</label><input name="passcode" value="${esc(r?.passcode || "")}" placeholder="e.g. 4821#" autocomplete="off"/></div>
      <div class="span2" style="border-top:1px solid var(--line);padding-top:10px"><b>⚠️ Room notice (known issues)</b> <span class="small muted">— e.g. "Shower has no heater", "Aircon under repair — electric fan only". Guests see it and accept it before booking, with your discount. Remove it when fixed.</span><div data-notices></div></div>
      <div class="span2" style="border-top:1px solid var(--line);padding-top:10px"><b>📅 Sync with Airbnb.com / Booking.com</b> <span class="small muted">— avoid double bookings</span>
        <p class="small muted" style="margin:4px 0">1) Paste each site's <b>export</b> calendar link below — we check it every 20 minutes and block those dates here. 2) Copy <b>this room's link</b> and paste it in Airbnb → Calendar → Availability → <i>Connect another calendar</i> (Booking.com: Rates &amp; Availability → Sync calendars). Airbnb refreshes about every 3 hours, so you also get a reminder to block new TapTayo bookings there.</p>
        <div data-icalimp></div>
        <div data-icalexp class="small" style="margin-top:6px">${r?.id ? "" : "Save the room first to get its calendar link."}</div></div>
      <div class="span2"><label>Door instructions (shown with the code)</label><input name="doorNote" value="${esc(r?.doorNote || "")}" placeholder="e.g. Press the keypad, enter the code, then turn the handle down"/><p class="small muted" style="margin:2px 0 0">Only guests with a confirmed, paid booking see the code — near their check-in time. Change it anytime.</p></div>
      <div class="span2"><label>Amenities (comma-separated)</label><input name="amenities" value="${esc((r?.amenities || []).join(", "))}" placeholder="Aircon, WiFi, Hot shower, Kitchen, Pool access, Parking"/></div>
      <div class="span2"><label>Description</label><textarea name="description" rows="3">${esc(r?.description || "")}</textarea></div>
      <div class="span2"><label>Room rules (optional)</label><textarea name="rules" rows="2">${esc(r?.rules || "")}</textarea></div>
      <div class="span2"><label>Photos — tag each one with its area</label><div data-photos class="row wrap" style="gap:10px"></div>
        <div class="row" style="gap:8px;margin-top:8px"><input type="file" accept="image/*" multiple data-pf/><span class="small muted" data-pst></span></div></div>
      <div class="span2"><label>Posters / promos for this room (optional)</label><div data-posters class="row wrap" style="gap:10px"></div><input type="file" accept="image/*" data-poster style="margin-top:6px"/></div>
      <div class="span2"><label>Block dates (maintenance, owner use)</label><div class="row" style="gap:8px"><input type="date" data-bd style="max-width:180px"/><button class="btn ghost sm" type="button" data-addbd>Block</button></div><div data-bl class="row wrap" style="gap:6px;margin-top:6px"></div></div>
      <div class="span2"><label class="check"><input type="checkbox" name="active" ${r?.active !== false ? "checked" : ""}/> Show to guests</label></div>
    </div>`);
    const drawPhotos = () => {
      const box = body.querySelector("[data-photos]"); box.innerHTML = "";
      photos.forEach((p, i) => {
        const el = html(`<div style="width:130px"><img src="${esc(p.url)}" style="width:130px;height:90px;object-fit:cover;border-radius:10px;display:block"/>
          <select data-a style="width:100%;margin-top:4px">${AREAS.map((a) => `<option ${p.area === a ? "selected" : ""}>${a}</option>`).join("")}</select>
          <div class="row between"><button type="button" class="btn ghost sm" data-l title="Move left">◀</button><button type="button" class="btn ghost sm danger-text" data-x>✕</button></div></div>`);
        el.querySelector("[data-a]").onchange = (e) => { photos[i] = { ...p, area: e.target.value }; };
        el.querySelector("[data-x]").onclick = () => { photos.splice(i, 1); drawPhotos(); };
        el.querySelector("[data-l]").onclick = () => { if (i > 0) { [photos[i - 1], photos[i]] = [photos[i], photos[i - 1]]; drawPhotos(); } };
        box.appendChild(el);
      });
      const pb = body.querySelector("[data-posters]"); pb.innerHTML = posters.map((u, i) => `<div style="position:relative"><img src="${esc(u)}" style="height:110px;border-radius:10px"/><button type="button" class="btn ghost sm danger-text" data-px="${i}" style="position:absolute;top:4px;right:4px">✕</button></div>`).join("");
      pb.querySelectorAll("[data-px]").forEach((b) => (b.onclick = () => { posters.splice(Number(b.dataset.px), 1); drawPhotos(); }));
      const bl = body.querySelector("[data-bl]"); bl.innerHTML = blocked.sort().map((d, i) => `<span class="pill">${d} <a href="#" data-bx="${i}">✕</a></span>`).join("");
      bl.querySelectorAll("[data-bx]").forEach((a) => (a.onclick = (e) => { e.preventDefault(); blocked.splice(Number(a.dataset.bx), 1); drawPhotos(); }));
    };
    drawPhotos();
    body.querySelector("[data-pf]").onchange = async (e) => {
      let files = [...e.target.files]; const st = body.querySelector("[data-pst]");
      const maxP = planLim(ctx).photos ?? 1e9; if (photos.length + files.length > maxP) { files = files.slice(0, Math.max(0, maxP - photos.length)); toast(`Your plan has up to ${maxP} photos per room. Upgrade in Billing for more.`, "error"); }
      for (let i = 0; i < files.length; i++) { st.textContent = `Uploading ${i + 1} of ${files.length}…`; try { const url = await uploadImage(storeId, `rooms/${Date.now()}-${i}`, files[i], { max: 1600 }); photos.push({ url, area: "Bedroom" }); drawPhotos(); } catch (err) { toast(err.message, "error"); } }
      st.textContent = files.length ? "Done — set the area under each photo" : ""; e.target.value = "";
    };
    body.querySelector("[data-poster]").onchange = async (e) => { const f = e.target.files[0]; if (!f) return; try { posters.push(await uploadImage(storeId, `rooms/poster-${Date.now()}`, f, { max: 1400 })); drawPhotos(); } catch (err) { toast(err.message, "error"); } };
    const notGet = rowsEditor(body.querySelector("[data-notices]"), r?.notices || [], [{ k: "label", label: "Issue", ph: "e.g. Shower has no heater", w: 3 }, { k: "percent", label: "Discount %", type: "number" }], { addLabel: "+ Add notice", max: 6 });
    const icalGet = rowsEditor(body.querySelector("[data-icalimp]"), r?.icalImports || [], [{ k: "name", label: "Site", type: "select", options: [["Airbnb", "Airbnb"], ["Booking.com", "Booking.com"], ["Agoda", "Agoda"], ["Other", "Other"]] }, { k: "url", label: "Their export link (.ics)", ph: "https://www.airbnb.com/calendar/ical/…", w: 4 }], { addLabel: "+ Add calendar link", max: 4 });
    if (r?.id) {
      const box = body.querySelector("[data-icalexp]");
      const show = (tok, st) => { const url = tok ? `https://${import.meta.env.VITE_FUNCTIONS_REGION || "asia-southeast1"}-${import.meta.env.VITE_FIREBASE_PROJECT_ID}.cloudfunctions.net/ical/${ctx.storeId}/${r.id}/${tok}.ics` : ""; box.innerHTML = `${url ? `<label>This room's calendar link</label><div class="row" style="gap:6px"><input readonly value="${esc(url)}" style="flex:1"/><button type="button" class="btn sm" data-cp>Copy</button></div>` : ""}<div class="row wrap" style="gap:8px;margin-top:6px"><button type="button" class="btn sm ghost" data-sync>🔄 Sync now</button><span class="muted">${(st || r.icalStatus || []).map((x) => `${esc(x.name)}: ${x.ok ? `✓ ${x.events} booking${x.events === 1 ? "" : "s"}` : `⚠️ ${esc(x.error || "failed")}`}`).join(" · ")}${r.icalSyncedAt ? ` · last ${new Date(r.icalSyncedAt).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" })}` : ""}</span></div>`;
        box.querySelector("[data-cp]")?.addEventListener("click", () => { navigator.clipboard?.writeText(url); toast("Copied — paste it in Airbnb / Booking.com"); });
        box.querySelector("[data-sync]").onclick = async (e) => { e.target.disabled = true; try { await updateDoc(doc(col, r.id), { icalImports: icalGet().filter((x) => /^https:\/\//.test(x.url)), icalOn: icalGet().some((x) => /^https:\/\//.test(x.url)) }); const res = await call("icalSyncNow", { roomId: r.id }); show(res.token, res.status); toast(res.conflicts ? `⚠️ ${res.conflicts} double booking(s) — check Telegram` : `Synced · ${res.blocks} dates blocked from other sites`); } catch (x) { toast(x.message, "error"); } e.target.disabled = false; };
      };
      show(r.icalToken, null);
    }
    const invGet = rowsEditor(body.querySelector("[data-inv]"), r?.inventory || [{ name: "Bath towel", qty: 2, price: 350 }, { name: "Pillow", qty: 2, price: 400 }, { name: "Blanket", qty: 1, price: 800 }, { name: "TV / aircon remote", qty: 2, price: 500 }], [{ k: "name", label: "Item", ph: "e.g. Bath towel", w: 3 }, { k: "qty", label: "Qty", type: "number" }, { k: "price", label: "Charge if missing ₱", type: "number", w: 1.5 }], { addLabel: "+ Add item", max: 40 });
    body.querySelector("[data-addbd]").onclick = () => { const v = body.querySelector("[data-bd]").value; if (v && !blocked.includes(v)) { blocked.push(v); drawPhotos(); } };
    const foot = html(`<div class="row" style="justify-content:flex-end"><button class="btn ghost" type="button" data-no>Cancel</button><button class="btn" type="button" data-yes>Save room</button></div>`);
    foot.querySelector("[data-no]").onclick = closeModal;
    foot.querySelector("[data-yes]").onclick = async () => {
      const g = (n) => body.querySelector(`[name=${n}]`);
      const data = { name: g("name").value.trim(), theme: g("theme").value.trim(), capacity: Math.max(1, Number(g("capacity").value) || 2), beds: g("beds").value.trim(), price: Number(g("price").value) || 0, weekendPrice: Number(g("weekendPrice").value) || 0, shortPrices: Object.fromEntries([3, 6, 12].filter((h) => g("sh" + h).value !== "").map((h) => [h, Math.max(0, Number(g("sh" + h).value) || 0)])),
        inventory: invGet().filter((i) => i.name).map((i) => ({ name: i.name.slice(0, 40), qty: Math.max(1, i.qty || 1), price: Math.max(0, i.price || 0) })), deposit: g("deposit").value === "" ? null : Math.max(0, Number(g("deposit").value) || 0), passcode: g("passcode").value.trim().slice(0, 30), doorType: g("doorType").value, notices: notGet().filter((n) => n.label).map((n) => ({ label: n.label.slice(0, 80), percent: Math.max(0, Math.min(90, n.percent || 0)) })), icalImports: icalGet().filter((x) => /^https:\/\//.test(x.url)).map((x) => ({ name: x.name, url: x.url.slice(0, 500) })), icalOn: icalGet().some((x) => /^https:\/\//.test(x.url)), ...(r?.icalToken ? {} : { icalToken: [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("") }), doorNote: g("doorNote").value.trim().slice(0, 200),
        amenities: g("amenities").value.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 20), description: g("description").value.trim(), rules: g("rules").value.trim(), photos, posters, blocked, active: g("active").checked, updatedAt: serverTimestamp() };
      if (!data.name) return toast("Enter a room title", "error");
      if (!data.price) return toast("Enter the price per night", "error");
      if (r) await updateDoc(doc(col, r.id), data); else await addDoc(col, { ...data, sortOrder: rooms.length + 1, createdAt: serverTimestamp() });
      closeModal(); toast("Room saved");
    };
    openModal({ title: r ? `Edit ${r.name}` : "New room", body, footer: foot, wide: true });
  }
  root.querySelector("#addRoom").onclick = () => { if (overLimit(ctx, "rooms", rooms.length, 1, toast)) return; roomForm(null); };
  return unsub;
}

const ST = { unconfirmed: ["⏳", "Awaiting Messenger"], pending: ["🕑", "Needs approval"], confirmed: ["✅", "Confirmed"], checked_in: ["🛏", "Checked in"], checked_out: ["🧹", "Checked out"], done: ["✔", "Done"], cancelled: ["✕", "Cancelled"], declined: ["✕", "Declined"] };
export function renderStaysPage(root, ctx) {
  const { storeId } = ctx;
  root.innerHTML = `<div class="tile"><div class="row between wrap"><h3>🧳 Bookings</h3><a class="btn sm" href="/counter/" target="_blank">Open caretaker screen ↗</a></div><p class="small muted">Approve, check in/out and handle requests in the caretaker screen (Counter). This list is read-only.</p><div id="stayList" class="itemlist" style="margin-top:10px"></div></div>`;
  return onSnapshot(query(collection(db, "stores", storeId, "stays"), orderBy("checkIn", "desc"), limit(100)), (snap) => {
    const list = root.querySelector("#stayList"); list.innerHTML = snap.empty ? `<p class="muted">No bookings yet.</p>` : "";
    snap.docs.map((d) => d.data()).forEach((s) => {
      const st = ST[s.status] || ["", s.status];
      list.appendChild(html(`<div class="item" style="grid-template-columns:1fr auto"><div class="info"><div class="n">${esc(s.code)} · ${esc(s.roomName)} <span class="pill">${st[0]} ${st[1]}</span>${s.test ? ` <span class="pill" style="background:#ffe58a;color:#6b4a00">🧪 TEST</span>` : ""}</div>
        <div class="d muted small">${esc(s.checkInYmd)} → ${esc(s.checkOutYmd)} · ${s.short ? `⏳ ${s.short.hours}-hour stay` : `${s.nightsCount} night${s.nightsCount > 1 ? "s" : ""}`} · 👥 ${s.guests} · ${esc(s.customer?.name || "")} ${esc(s.customer?.phone || "")}</div></div>
        <div style="text-align:right"><b>${money(s.total)}</b><div class="small muted">paid ${money(s.paidAmount || 0)}</div></div></div>`));
    });
  });
}
