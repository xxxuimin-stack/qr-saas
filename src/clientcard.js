// Salon client card — allergies, color formula, notes, before/after photos and visit history (per phone number).
// Used by the reception (counter) and the stylist app.
import { db } from "./firebase.js";
import { doc, getDoc, updateDoc, addDoc, collection, query, where, limit, getDocs, serverTimestamp, arrayUnion } from "firebase/firestore";
import { uploadImage } from "./upload.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const html = (str) => { const t = document.createElement("template"); t.innerHTML = str.trim(); return t.content.firstElementChild; };
const cache = new Map(); // key → { at, data }

async function loadClient(storeId, key, fresh = false) {
  const c = cache.get(key);
  if (c && !fresh && Date.now() - c.at < 60000) return c.data;
  const d = (await getDoc(doc(db, "stores", storeId, "customers", key)).catch(() => null))?.data() || null;
  cache.set(key, { at: Date.now(), data: d });
  return d;
}

/** Small warning line on a booking card: allergies, no-shows, loyalty stamps */
export async function clientFlag(storeId, key, el) {
  if (!key || !el) return;
  const c = await loadClient(storeId, key);
  if (!c) return;
  const bits = [];
  if (c.allergies) bits.push(`<b style="color:var(--danger)">⚠️ Allergy: ${esc(c.allergies)}</b>`);
  if (c.noShows) bits.push(`<span style="color:var(--danger)">🚫 ${c.noShows} no-show${c.noShows > 1 ? "s" : ""}</span>`);
  if (c.completed) bits.push(`<span class="muted">${c.completed} visit${c.completed > 1 ? "s" : ""}</span>`);
  if (c.stamps) bits.push(`<span>⭐ ${c.stamps}</span>`);
  el.innerHTML = bits.join(" · ");
}

/** Drawer with the full client card */
export async function clientCard({ storeId, key, name, openDrawer, me, cur = "PHP", readOnly = false, stylists = [], defaultProvider = null }) {
  const money = (n) => (cur === "PHP" ? "₱" : cur + " ") + Number(n || 0).toLocaleString("en-PH", { maximumFractionDigits: 2 });
  const el = html(`<div><p class="muted">Loading…</p></div>`);
  openDrawer(`Client · ${name || key}`, el);
  const draw = async () => {
    const c = (await loadClient(storeId, key, true)) || {};
    const [pk, mb] = await Promise.all([getDocs(collection(db, "stores", storeId, "customers", key, "packages")).catch(() => ({ docs: [] })), getDocs(collection(db, "stores", storeId, "customers", key, "memberships")).catch(() => ({ docs: [] }))]);
    const pkgs = pk.docs.map((d) => d.data()).filter((x) => x.remaining > 0 && x.expires > Date.now());
    const mem = mb.docs.map((d) => d.data()).filter((x) => x.expires > Date.now()).sort((a, b) => b.expires - a.expires)[0];
    const fd = (ms) => new Date(ms).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" });
    const hist = (await getDocs(query(collection(db, "stores", storeId, "appointments"), where("customerKey", "==", key), limit(60))).catch(() => ({ docs: [] }))).docs
      .map((d) => d.data()).filter((a) => !a.test).sort((x, y) => (y.startAt?.toMillis?.() || 0) - (x.startAt?.toMillis?.() || 0)).slice(0, 25);
    el.innerHTML = `
      <div class="k-sum"><div class="box"><div class="k">Visits</div><div class="v">${c.completed || 0}</div></div><div class="box"><div class="k">No-shows</div><div class="v" style="${c.noShows ? "color:var(--danger)" : ""}">${c.noShows || 0}</div></div><div class="box"><div class="k">Stamps</div><div class="v">⭐ ${c.stamps || 0}</div></div></div>
      ${c.nextDue && ["due", "snoozed", "booked"].includes(c.nextDue.status) ? `<div class="k-note">🔁 ${c.nextDue.status === "booked" ? "Next visit already booked ✓" : `Due back <b>${new Date(c.nextDue.at).toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric" })}</b>`} · ${esc(c.nextDue.service || "")}${c.nextDue.providerName ? ` with ${esc(c.nextDue.providerName)}` : ""}</div>` : ""}
      ${c.flagged ? `<div class="k-note" style="color:var(--danger)">🚫 Blocked${c.flagReason ? ` — ${esc(c.flagReason)}` : ""}</div>` : c.dpRequired ? `<div class="k-note">💵 Reservation fee required for online bookings</div>` : ""}
      ${mem || pkgs.length || c.refCode || c.rewardVouchers?.length ? `<div class="k-note" style="margin-bottom:6px">${mem ? `💎 <b>${esc(mem.name)}</b> member until ${fd(mem.expires)}${mem.discountPct ? ` · ${mem.discountPct}% off` : ""}${mem.freeLeft ? ` · ${mem.freeLeft} free left` : ""}<br>` : ""}${pkgs.map((p) => `🎁 ${esc(p.name)} · ${p.remaining}/${p.sessions} left (until ${fd(p.expires)})`).join("<br>")}${pkgs.length ? "<br>" : ""}${c.refCode ? `💌 Referral code <b>${esc(c.refCode)}</b>${c.referrals ? ` · ${c.referrals} friend(s) referred` : ""}` : ""}${(c.rewardVouchers || []).length ? `<br>🎟 Reward vouchers: ${c.rewardVouchers.slice(-3).map((v) => `<b>${esc(v.code)}</b> ₱${v.value}`).join(", ")}` : ""}</div>` : ""}
      <label>🎂 Birthday (MM-DD)</label><input class="k-input" data-f="birthday" value="${esc(c.birthday || "")}" placeholder="e.g. 03-25" maxlength="5" ${readOnly ? "disabled" : ""}/>
      <label>⚠️ Allergies / sensitivities</label><input class="k-input" data-f="allergies" value="${esc(c.allergies || "")}" placeholder="e.g. PPD hair dye, latex" ${readOnly ? "disabled" : ""}/>
      <label>🎨 Color formula / service notes</label><textarea class="k-input" data-f="formula" rows="3" placeholder="e.g. 6.1 + 7.0 (1:1), 20 vol, 35 min · lashes: C curl 11–13mm" ${readOnly ? "disabled" : ""}>${esc(c.formula || "")}</textarea>
      <label>📝 Notes</label><textarea class="k-input" data-f="note" rows="2" ${readOnly ? "disabled" : ""}>${esc(c.note || "")}</textarea>
      ${readOnly ? "" : `<button class="k-btn primary" data-save style="width:100%;margin-top:8px">Save card</button>`}
      <h3 style="margin:16px 0 6px">📷 Photos</h3>
      <div class="row wrap" style="gap:8px">${(c.photos || []).slice(-12).reverse().map((p) => `<a href="${esc(p.url)}" target="_blank" style="text-align:center"><img src="${esc(p.url)}" alt="" style="width:86px;height:86px;object-fit:cover;border-radius:10px"/><div class="small muted">${esc(p.label || "")} ${p.at ? new Date(p.at).toLocaleDateString("en-PH", { month: "short", day: "numeric" }) : ""}</div></a>`).join("") || `<span class="small muted">No photos yet.</span>`}</div>
      <div class="row wrap" style="gap:6px;margin-top:8px"><select class="k-input" data-plabel style="max-width:130px"><option>Before</option><option>After</option><option>Reference</option></select>${stylists.length ? `<select class="k-input" data-pby style="max-width:160px">${stylists.map((s) => `<option value="${esc(s.id)}" ${s.id === (defaultProvider || me?.staffId) ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select>` : ""}<input class="k-input" data-psvc placeholder="Service (e.g. Balayage)" style="max-width:180px"/></div>
      <label class="check" style="margin-top:6px"><input type="checkbox" data-ppub/> 🌐 Show on our page (the client agreed)</label>
      <input type="file" accept="image/*" capture="environment" data-photo style="margin-top:6px"/>
      ${(c.log || []).length ? `<h3 style="margin:16px 0 6px">🗒 Activity</h3>${(c.log || []).slice(-15).reverse().map((l) => `<div class="small" style="padding:4px 0;border-bottom:1px solid var(--line)"><span class="muted">${fd(l.at)}</span> · ${esc(l.text)}</div>`).join("")}` : ""}
      <h3 style="margin:16px 0 6px">🗓 History</h3>
      ${hist.map((a) => `<div class="sl-row" style="padding:6px 0;border-bottom:1px solid var(--line)"><span><b>${a.startAt?.toDate ? a.startAt.toDate().toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "2-digit" }) : ""}</b> · ${(a.items || []).map((l) => esc(l.name)).join(", ")}<br><span class="small muted">${esc(a.providerName || "—")} · ${esc(a.status.replace("_", " "))}${a.rating ? ` · ${"★".repeat(a.rating)}` : ""}</span></span><span>${money(a.amountDue ?? a.total)}</span></div>`).join("") || `<p class="small muted">No visits yet.</p>`}`;
    el.querySelector("[data-save]")?.addEventListener("click", async (e) => {
      e.target.disabled = true;
      const patch = Object.fromEntries([...el.querySelectorAll("[data-f]")].map((x) => [x.dataset.f, x.value.trim()]));
      if (patch.birthday && !/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(patch.birthday)) { e.target.disabled = false; return alert("Birthday format: MM-DD, e.g. 03-25"); }
      patch.birthMonth = patch.birthday ? Number(patch.birthday.slice(0, 2)) : null;
      try { await updateDoc(doc(db, "stores", storeId, "customers", key), { ...patch, updatedAt: serverTimestamp() }); cache.delete(key); e.target.textContent = "Saved ✓"; } catch (err) { alert(err.message); e.target.disabled = false; }
    });
    el.querySelector("[data-photo]")?.addEventListener("change", async (e) => {
      const f = e.target.files[0]; if (!f) return; e.target.disabled = true;
      try {
        const url = await uploadImage(storeId, `client-${key}-${Date.now()}`, f, { max: 1000 });
        const label = el.querySelector("[data-plabel]").value, providerId = el.querySelector("[data-pby]")?.value || me?.staffId || null, service = el.querySelector("[data-psvc]").value.trim();
        const pub = el.querySelector("[data-ppub]").checked;
        await updateDoc(doc(db, "stores", storeId, "customers", key), { photos: arrayUnion({ url, label, at: Date.now(), by: me?.name || "", ...(pub ? { public: true } : {}) }), updatedAt: serverTimestamp() });
        if (pub) await addDoc(collection(db, "stores", storeId, "portfolio"), { url, label, providerId, service, customerKey: key, at: Date.now(), by: me?.name || "" });
        cache.delete(key); draw();
      }
      catch (err) { alert(err.message); e.target.disabled = false; }
    });
  };
  draw();
}
