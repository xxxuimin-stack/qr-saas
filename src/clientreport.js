// Shop → client: block (they can't book / order with you again — account and phone) or report to TapTayo
// (TapTayo checks it; confirmed strikes: 1 warning · 2 = 30-day ban · 3 = banned). Owner / manager only (the server checks).
import { auth, call } from "./firebase.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** kind: "order" | "appt" | "stay" | "resv" · id: record id · storeId · staffToken (counter PIN session, optional for the owner) */
export async function openClientActions({ kind, id, storeId, staffToken = null, name = "" }) {
  const base = { kind, id, ...(staffToken ? { staffToken } : {}) };
  let S; try { S = await call("shopClient", { ...base, action: "status" }); } catch (e) { return alert(e.message); }
  const w = document.createElement("div");
  w.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.45);display:flex;align-items:flex-end;justify-content:center";
  w.innerHTML = `<div role="dialog" aria-label="Report or block client" style="background:#fff;color:#141414;width:100%;max-width:520px;max-height:90vh;overflow:auto;border-radius:20px 20px 0 0;padding:18px;font:15px/1.45 Poppins,system-ui,sans-serif">
    <div style="display:flex;justify-content:space-between;align-items:center"><b style="font-size:17px">🚩 ${esc(name || "This client")}</b><button data-x style="border:0;background:none;font-size:22px;cursor:pointer" aria-label="Close">✕</button></div>
    ${!S.hasId ? `<p style="color:#B45309">No account or phone number on this booking — nothing to block or report.</p>` : `
    <div style="margin-top:10px;padding:12px;border:1px solid #E7E5E4;border-radius:14px"><b>🚫 Block</b><p style="margin:4px 0 8px;color:#6B7280;font-size:13.5px">They can't book or order with your shop again (their account and phone number). Only you see this.</p>
      <button data-block style="padding:9px 14px;border-radius:10px;border:1px solid #141414;background:${S.blocked ? "#fff" : "#141414"};color:${S.blocked ? "#141414" : "#fff"};font-weight:700;cursor:pointer">${S.blocked ? "Unblock" : "Block this client"}</button></div>
    <div style="margin-top:12px;padding:12px;border:1px solid #E7E5E4;border-radius:14px"><b>🚩 Report to TapTayo</b>
      ${S.reported ? `<p style="margin:4px 0 0;color:#15803D">✓ Reported — TapTayo is checking it.</p>` : `<p style="margin:4px 0 8px;color:#6B7280;font-size:13.5px">For serious cases. TapTayo checks every report. Confirmed reports: 1 = warning · 2 = can't book for 30 days · 3 = banned from TapTayo. Fake reports count against your shop.</p>
      <label style="display:block;font-weight:600;font-size:13px;margin:6px 0 4px">What happened?</label><select data-reason style="width:100%;padding:9px;border-radius:10px;border:1px solid #E7E5E4">${Object.entries(S.reasons).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select>
      <label style="display:block;font-weight:600;font-size:13px;margin:8px 0 4px">Details</label><textarea data-details rows="3" style="width:100%;padding:9px;border-radius:10px;border:1px solid #E7E5E4;box-sizing:border-box" placeholder="e.g. Booked online, then paid our therapist directly at home to skip the shop."></textarea>
      <label style="display:inline-flex;gap:6px;align-items:center;margin-top:8px;cursor:pointer;font-weight:600;font-size:13.5px">📷 Add proof (screenshots, photos)<input type="file" accept="image/*" multiple data-ev hidden/></label> <span data-evs style="color:#6B7280;font-size:13px"></span>
      <label style="display:flex;gap:6px;align-items:center;margin-top:8px;font-size:13.5px"><input type="checkbox" data-alsoblock checked/> Also block them from my shop</label>
      <button data-report style="margin-top:10px;padding:10px 16px;border-radius:10px;border:0;background:#B91C1C;color:#fff;font-weight:800;cursor:pointer">Send report</button>`}</div>`}
  </div>`;
  document.body.appendChild(w);
  const close = () => w.remove(); w.querySelector("[data-x]").onclick = close; w.onclick = (e) => { if (e.target === w) close(); };
  const ev = [];
  w.querySelector("[data-ev]")?.addEventListener("change", async (e) => { const st = w.querySelector("[data-evs]"); const { uploadPrivateImage } = await import("./upload.js");
    for (const f of [...e.target.files].slice(0, 4 - ev.length)) { st.textContent = "Uploading…"; try { ev.push(await uploadPrivateImage(storeId, auth.currentUser.uid, f, { max: 1400, name: `report_${id}_${Date.now()}` })); } catch (x) { alert(x.message); } } st.textContent = ev.length ? `${ev.length} attached ✓` : ""; });
  w.querySelector("[data-block]")?.addEventListener("click", async (e) => { const unb = S.blocked; const reason = unb ? "" : prompt("Reason (only your shop sees it):", "") ?? null; if (reason === null) return; e.target.disabled = true;
    try { await call("shopClient", { ...base, action: unb ? "unblock" : "block", reason }); alert(unb ? "Unblocked" : "Blocked — they can't book or order with you again."); close(); } catch (x) { alert(x.message); e.target.disabled = false; } });
  w.querySelector("[data-report]")?.addEventListener("click", async (e) => { e.target.disabled = true;
    try { await call("shopClient", { ...base, action: "report", reason: w.querySelector("[data-reason]").value, details: w.querySelector("[data-details]").value, evidence: ev, block: w.querySelector("[data-alsoblock]").checked }); alert("Report sent — TapTayo will check it. Thank you."); close(); } catch (x) { alert(x.message); e.target.disabled = false; } });
}
