// Announcements (owner) — shown on the customer page (menu + landing) and/or staff screens (kitchen/counter/rider)
import { db } from "../firebase.js";
import { collection, doc, addDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy, serverTimestamp } from "firebase/firestore";
import { esc, html, toast, openModal, closeModal, confirmDialog } from "../ui.js";
import { uploadImage } from "../upload.js";

export function renderAnnouncementsPage(root, ctx) {
  const { storeId } = ctx;
  let rows = [];
  root.innerHTML = `
    <div class="tile">
      <div class="row between wrap"><div><h3>📣 Announcements</h3><p class="small muted">e.g. "Closed on Nov 1", "New: Matcha series!", "New house rules". Shown at the top of the customer menu and/or on staff screens. Supports pinning, scheduling (dates), and an optional image.</p></div><button class="btn sm" id="add" type="button">+ New announcement</button></div>
      <div id="list" class="itemlist"></div>
    </div>`;

  const unsub = onSnapshot(query(collection(db, "stores", storeId, "announcements"), orderBy("createdAt", "desc")), (s) => { rows = s.docs.map((d) => ({ id: d.id, ...d.data() })); draw(); });

  function draw() {
    const el = root.querySelector("#list");
    el.innerHTML = rows.length ? "" : `<p class="small muted">No announcements yet.</p>`;
    const today = new Date().toISOString().slice(0, 10);
    rows.forEach((a) => {
      const expired = a.dateTo && a.dateTo < today, upcoming = a.dateFrom && a.dateFrom > today;
      const aud = [a.audience?.customers !== false ? "Customers" : null, a.audience?.staff ? "Staff" : null].filter(Boolean).join(" + ") || "—";
      const row = html(`<div class="item ${a.active === false ? "off" : ""}" style="grid-template-columns:auto 1fr auto auto">
        <div class="thumb">${a.imageUrl ? `<img src="${esc(a.imageUrl)}" alt=""/>` : "📣"}</div>
        <div class="info"><div class="n">${a.pinned ? "📌 " : ""}${esc(a.title)} ${expired ? `<span class="tag">expired</span>` : upcoming ? `<span class="tag">scheduled</span>` : a.active !== false ? `<span class="tag">LIVE</span>` : ""}</div>
          <div class="d muted small">${esc((a.body || "").slice(0, 120))}${(a.body || "").length > 120 ? "…" : ""}</div>
          <div class="d muted small">${esc(aud)}${a.dateFrom || a.dateTo ? ` · ${a.dateFrom || "…"} → ${a.dateTo || "…"}` : ""}</div></div>
        <label class="switch"><input type="checkbox" ${a.active !== false ? "checked" : ""}/><span></span></label>
        <span class="acts"><button data-edit>✎</button><button data-del>🗑</button></span></div>`);
      row.querySelector(".switch input").onchange = (e) => updateDoc(doc(db, "stores", storeId, "announcements", a.id), { active: e.target.checked, updatedAt: serverTimestamp() });
      row.querySelector("[data-edit]").onclick = () => form(a);
      row.querySelector("[data-del]").onclick = async () => { if (await confirmDialog(`Delete "${a.title}"?`)) deleteDoc(doc(db, "stores", storeId, "announcements", a.id)); };
      el.appendChild(row);
    });
  }

  function form(a) {
    let imageUrl = a?.imageUrl || null;
    const body = html(`<div class="form2">
      <div><label>Type</label><select name="type">${[["news", "📢 News"], ["event", "🎉 Event"], ["closed", "⛔ Closed / schedule change (red banner on the menu)"], ["hiring", "🧑‍🍳 We're hiring"], ["promo", "🏷️ Promo"]].map(([k, l]) => `<option value="${k}" ${(a?.type || "news") === k ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div></div>
      <div class="span2"><label>Title</label><input name="title" maxlength="80" value="${esc(a?.title || "")}" placeholder="e.g. Closed on Nov 1 (All Saints' Day)"/></div>
      <div class="span2"><label>Message</label><textarea name="body" rows="4" maxlength="600" placeholder="Short details…">${esc(a?.body || "")}</textarea></div>
      <div><label>Button text (optional)</label><input name="btnText" maxlength="40" value="${esc(a?.btnText || "")}" placeholder="e.g. Apply now"/></div>
      <div><label>Button link (https://…)</label><input name="btnUrl" value="${esc(a?.btnUrl || "")}" placeholder="https://forms.gle/…"/><p class="small muted" style="margin:4px 0 0">For “We're hiring”, customers also see a QR code of this link.</p></div>
      <div><label>Show from (optional)</label><input name="dateFrom" type="date" value="${esc(a?.dateFrom || "")}"/></div>
      <div><label>Until (optional)</label><input name="dateTo" type="date" value="${esc(a?.dateTo || "")}"/></div>
      <div class="span2"><label>Where to show</label>
        <label class="check"><input type="checkbox" name="audCust" ${a?.audience?.customers !== false ? "checked" : ""}/> Customer page (menu + landing)</label>
        <label class="check"><input type="checkbox" name="audStaff" ${a?.audience?.staff ? "checked" : ""}/> Staff screens (kitchen, counter, rider) — e.g. "Ube is out of stock", "Manager meeting 3PM"</label>
        <label class="check"><input type="checkbox" name="pinned" ${a?.pinned ? "checked" : ""}/> 📌 Pin to top</label></div>
      <div class="span2"><label>Image (optional)</label><div class="row"><div data-img class="thumb" style="width:72px;height:72px">${imageUrl ? `<img src="${esc(imageUrl)}" alt=""/>` : "🖼"}</div><input type="file" accept="image/*" data-file/></div></div>
    </div>`);
    body.querySelector("[data-file]").onchange = async (e) => { const f = e.target.files[0]; if (!f) return; try { imageUrl = await uploadImage(storeId, `ann-${a?.id || Date.now()}`, f, { max: 1200 }); body.querySelector("[data-img]").innerHTML = `<img src="${imageUrl}" alt=""/>`; toast("Uploaded"); } catch (err) { toast(err.message, "error"); } };
    const foot = html(`<div class="row" style="justify-content:flex-end"><button class="btn ghost" data-no>Cancel</button><button class="btn" data-yes>${a ? "Save" : "Publish"}</button></div>`);
    foot.querySelector("[data-no]").onclick = closeModal;
    foot.querySelector("[data-yes]").onclick = async () => {
      const g = (n) => body.querySelector(`[name=${n}]`);
      const title = g("title").value.trim(); if (!title) return toast("Enter a title", "error");
      const btnUrl = g("btnUrl").value.trim(); if (btnUrl && !/^https:\/\//.test(btnUrl)) return toast("The button link must start with https://", "error");
      if (g("dateFrom").value && g("dateTo").value && g("dateTo").value < g("dateFrom").value) return toast("“Until” can't be before “Show from”", "error");
      const data = { title, body: g("body").value.trim(), dateFrom: g("dateFrom").value || null, dateTo: g("dateTo").value || null, audience: { customers: g("audCust").checked, staff: g("audStaff").checked }, pinned: g("pinned").checked, imageUrl, type: g("type").value, btnText: g("btnText").value.trim() || null, btnUrl: btnUrl || null, updatedAt: serverTimestamp() };
      try {
        if (a) await updateDoc(doc(db, "stores", storeId, "announcements", a.id), data);
        else await addDoc(collection(db, "stores", storeId, "announcements"), { ...data, active: true, createdAt: serverTimestamp() });
        closeModal(); toast(a ? "Saved" : "Published ✓");
      } catch (e) { toast(e.message, "error"); }
    };
    openModal({ title: a ? "Edit announcement" : "New announcement", body, footer: foot, wide: true });
  }
  root.querySelector("#add").onclick = () => form(null);
  return unsub;
}
