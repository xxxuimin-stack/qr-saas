// Branches (owner): list branches of the organization, add (copy from a branch), rename, switch, archive
import { db, call } from "../firebase.js";
import { doc, onSnapshot } from "firebase/firestore";
import { esc, html, toast, openModal, closeModal, confirmDialog } from "../ui.js";
import { ADDONS, branchesAllowedFor } from "../plans.js";

export const branchesAllowed = (sub) => branchesAllowedFor(sub);

export function renderBranchesPage(root, ctx) {
  const { storeId } = ctx;
  if (!ctx.orgId) { root.innerHTML = `<div class="tile"><p class="muted">Setting up your organization… refresh the page in a few seconds.</p></div>`; return () => {}; }
  root.innerHTML = `<div class="tile"><div class="row between wrap"><div><h3>🏬 Branches</h3><p class="small muted">Each branch has its own QR / customer link, menu, staff PINs, orders and reports. Switch between them from the sidebar. One subscription covers all branches.</p></div><button class="btn sm" id="addBranch" type="button">+ Add branch</button></div><div id="list" class="itemlist" style="margin-top:10px"></div><p class="small muted" id="quota" style="margin-top:10px"></p></div>`;
  let org = null;
  const unsub = onSnapshot(doc(db, "orgs", ctx.orgId), (s) => { org = s.data(); draw(); }, () => {});
  function draw() {
    const list = root.querySelector("#list");
    const branches = (org?.branches || []).filter((b) => !b.archived);
    const allowed = branchesAllowed(ctx.sub);
    root.querySelector("#quota").innerHTML = `${branches.length} of ${allowed} branch${allowed > 1 ? "es" : ""} used${branches.length >= allowed ? ` — <a href="#billing">add “+1 branch”</a> (₱${ADDONS.branch.price}/mo each, Basic plan and up)` : ""}.`;
    list.innerHTML = "";
    branches.forEach((b) => {
      const isMain = b.storeId === org.mainStoreId, isCur = b.storeId === storeId;
      const row = html(`<div class="item" style="grid-template-columns:1fr auto">
        <div class="info"><div class="n">${esc(b.name)} ${isMain ? `<span class="tag">main</span>` : ""} ${isCur ? `<span class="pill active">current</span>` : ""}</div><div class="d muted small">/m/${esc(b.slug)}</div></div>
        <span class="row" style="gap:6px">${isCur ? "" : `<button class="btn sm" data-switch>Switch to</button>`}<button class="btn ghost sm" data-rename>Rename</button>${isMain || isCur ? "" : `<button class="btn ghost sm danger-text" data-archive>Archive</button>`}</span></div>`);
      row.querySelector("[data-switch]")?.addEventListener("click", () => switchTo(b.storeId));
      row.querySelector("[data-rename]").onclick = async () => { const n = prompt("Branch name:", b.name); if (!n || n.trim().length < 2) return; try { await call("renameBranch", { storeId: b.storeId, name: n.trim() }); toast("Renamed"); if (isCur) ctx.reload?.(); } catch (e) { toast(e.message, "error"); } };
      row.querySelector("[data-archive]")?.addEventListener("click", async () => { if (!(await confirmDialog(`Archive "${b.name}"? It will stop accepting orders and disappear from the list (data is kept).`))) return; try { await call("archiveBranch", { storeId: b.storeId }); toast("Archived"); } catch (e) { toast(e.message, "error"); } });
      list.appendChild(row);
    });
  }
  root.querySelector("#addBranch").onclick = () => {
    const branches = (org?.branches || []).filter((b) => !b.archived);
    const body = html(`<div class="form2">
      <div class="span2"><label>Branch name</label><input name="name" placeholder="e.g. Kapehan ni Juan — Batangas"/></div>
      <div><label>Phone</label><input name="phone"/></div><div><label>Address</label><input name="address"/></div>
      <div class="span2"><label>Start with</label><select name="copy"><option value="">Blank (default categories only)</option>${branches.map((b) => `<option value="${b.storeId}" ${b.storeId === storeId ? "selected" : ""}>Copy menu, settings, theme &amp; promos from: ${esc(b.name)}</option>`).join("")}</select></div>
      <p class="small muted span2">Staff PINs, device logins, tables and orders are NOT copied — set those up in the new branch.</p>
    </div>`);
    const foot = html(`<div class="row" style="justify-content:flex-end"><button class="btn ghost" data-no>Cancel</button><button class="btn" data-yes>Create branch</button></div>`);
    foot.querySelector("[data-no]").onclick = closeModal;
    foot.querySelector("[data-yes]").onclick = async () => {
      const g = (n) => body.querySelector(`[name=${n}]`).value.trim();
      foot.querySelector("[data-yes]").disabled = true;
      try { const r = await call("addBranch", { name: g("name"), phone: g("phone"), address: g("address"), copyFrom: g("copy") || null }); closeModal(); toast(`Branch created: /m/${r.slug}`); if (await confirmDialog("Switch to the new branch now?")) switchTo(r.storeId); }
      catch (e) { toast(e.message, "error"); foot.querySelector("[data-yes]").disabled = false; }
    };
    openModal({ title: "New branch", body, footer: foot, wide: true });
  };
  return unsub;
}

export async function switchTo(storeId) {
  try { await call("switchBranch", { storeId }); const { auth } = await import("../firebase.js"); await auth.currentUser.getIdToken(true); location.hash = "#overview"; location.reload(); }
  catch (e) { toast(e.message, "error"); }
}
