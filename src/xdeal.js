// 🎁 X-Deal — barter (food / product / staycation ↔ UGC video). One panel for both sides:
// offer → accepted (creator sets release days) → item sent → received (countdown) → preview (1080p / watermarked link) → approve or 1 revision → high-res on Drive → confirmed → tips & ratings.
import { call, storage, auth } from "./firebase.js";
import { ref as sref, uploadBytesResumable } from "firebase/storage";
import { uploadPrivateImage } from "./upload.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const peso = (n) => "₱" + Math.round(Number(n) || 0).toLocaleString("en-PH");
export const X_ST = { negotiating: ["🎁", "X-Deal offer", "#0891b2"], accepted: ["✅", "Accepted — send the item", "#15803d"], sent: ["📦", "Item on the way", "#b45309"], received: ["⏳", "Creator is making the video", "#7c3aed"], submitted: ["🎬", "Preview ready to review", "#2563eb"], revision: ["✏️", "Revision asked", "#b45309"], approved: ["👍", "Approved — waiting for high-res", "#15803d"], released: ["📤", "High-res sent — confirm", "#15803d"], done: ["🏁", "Done", "#6b7280"], declined: ["✕", "Declined", "#6b7280"], cancelled: ["✕", "Cancelled by the business", "#b45309"], failed: ["⚠️", "Creator didn't deliver", "#b42318"] };
const ITEM = { food: "🍽 Food", product: "📦 Product", staycation: "🏡 Staycation" };
const STEPS = [["accepted", "Accepted"], ["sent", "Item sent"], ["received", "Received"], ["submitted", "Preview"], ["approved", "Approved"], ["released", "High-res"], ["done", "Done"]];
const ORDER = ["negotiating", "accepted", "sent", "received", "submitted", "revision", "approved", "released", "done"];
const left = (ms) => { const d = ms - Date.now(); const a = Math.abs(d); const D = Math.floor(a / 864e5), H = Math.floor((a % 864e5) / 36e5); return `${D ? `${D}d ` : ""}${H}h ${d >= 0 ? "left" : "late"}`; };

export function xdealHTML(q) {
  const X = q.x || {}; const i = ORDER.indexOf(q.status === "revision" ? "submitted" : q.status);
  return `<div style="border:1px solid var(--line,#e5e7eb);border-radius:14px;padding:12px">
    <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><b>${ITEM[q.item?.type] || "🎁"} · ${esc(q.item?.desc || "")}</b><span style="font-weight:700">${peso(q.item?.value)} value</span></div>
    <div style="font-size:13px;opacity:.85;margin-top:4px">${q.tipOffer ? `💝 Tip ${peso(q.tipOffer)} · ` : ""}📹 ${esc(q.xDeliver || "1 video")}${q.releaseDays ? ` · video ${q.releaseDays} day(s) after receiving` : ""} · 🚚 shipping: ${{ business: "business pays", creator: "creator pays", talk: "you'll agree" }[q.shipping] || "you'll agree"}${q.deadline ? ` · by ${esc(q.deadline)}` : ""}</div>
    ${q.instructions ? `<div style="font-size:13px;margin-top:6px;white-space:pre-wrap;background:#f9fafb;border-radius:10px;padding:8px">📝 ${esc(q.instructions)}</div>` : ""}
    ${i >= 1 ? `<div style="display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:3px;margin-top:10px">${STEPS.map(([k, t]) => { const on = ORDER.indexOf(k) <= i; return `<div style="text-align:center;font-size:10px;line-height:1.2"><div style="height:6px;border-radius:3px;background:${on ? "#16a34a" : "#e5e7eb"};margin-bottom:3px"></div>${t}</div>`; }).join("")}</div>` : ""}
    ${X.dueAt && ["received", "revision"].includes(q.status) ? `<div style="margin-top:8px;font-weight:700;color:${X.dueAt < Date.now() ? "#b42318" : "#15803d"}">⏱ Video due ${new Date(X.dueAt).toLocaleDateString("en-PH", { month: "short", day: "numeric" })} · ${left(X.dueAt)}</div>` : ""}
    ${X.tracking ? `<div style="font-size:12.5px;margin-top:4px">📦 ${esc(X.courier || "")} ${esc(X.tracking)}</div>` : ""}
    ${X.revisionNote && q.status === "revision" ? `<div style="font-size:13px;color:#b45309;margin-top:4px">✏️ ${esc(X.revisionNote)}</div>` : ""}
    ${(X.tips || []).map((t) => `<div style="font-size:12.5px;margin-top:4px">💝 Tip ${peso(t.amount)}${t.ref ? ` · ref ${esc(t.ref)}` : ""} · ${t.confirmed ? "received ✓" : "sent"}</div>`).join("")}
    ${X.autoApproved ? `<div style="font-size:12px;opacity:.7;margin-top:4px">Auto-approved after 3 days with no reply.</div>` : ""}
    ${X.biz && q.status === "negotiating" && X.biz.accepted ? `<div style="font-size:12.5px;margin-top:6px;color:${X.biz.rate >= 30 ? "#b42318" : "#57534e"}">🏪 This business cancelled ${X.biz.cancels} of ${X.biz.accepted} X-Deals (${X.biz.rate}%)</div>` : ""}
    ${q.status === "cancelled" && X.cancel ? `<div style="font-size:13px;margin-top:6px;color:#b45309">Reason: ${esc(X.cancel.reason)}. The creator keeps the item.${X.appeal ? ` · Appeal: ${esc({ open: "being reviewed", upheld: "upheld ✓ (trust point returned)", rejected: "not upheld" }[X.appeal.status] || X.appeal.status)}` : ""}</div>` : ""}
  </div>`;
}

/** action buttons for one side ("creator" | "business"); ctx = { storeId (creator store), id, onDone, toast } */
export function xdealActions(q, side, ctx) {
  const box = document.createElement("div"); box.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;margin-top:10px";
  const btn = (t, fn, ghost) => { const b = document.createElement("button"); b.type = "button"; b.className = `btn sm ${ghost ? "ghost" : ""}`; b.textContent = t; b.onclick = async () => { b.disabled = true; try { await fn(); ctx.onDone?.(); } catch (e) { ctx.toast?.(e.message, "error"); } b.disabled = false; }; box.appendChild(b); };
  const A = (action, extra = {}) => call("xdealAction", { storeId: ctx.storeId, id: ctx.id, action, ...extra });
  const X = q.x || {};
  if (side === "creator") {
    if (q.status === "negotiating") { btn("✓ Accept", async () => { const d = prompt("How many days after you RECEIVE the item will you deliver the video?", String(q.releaseDays || 5)); if (d === null) return; await A("accept", { releaseDays: Number(d) || 5 }); ctx.toast?.("Accepted — the business will send the item"); }); btn("Decline", async () => { const r = prompt("Message to the business:", "Sorry, not this time."); if (r !== null) await A("decline", { reason: r }); }, true); }
    if (["accepted", "sent"].includes(q.status)) { btn("📦 I received the item", async () => { const f = await pickFile("image/*"); let photo = ""; if (f) photo = await uploadPrivateImage(ctx.storeId, auth.currentUser.uid, f, { max: 1200, name: `xrecv_${ctx.id}` }); await A("received", { photo }); ctx.toast?.("Countdown started — deliver before the due date"); }); }
    if (q.status === "sent") btn("Not arrived yet", async () => { const n = prompt("What happened? (we'll check with the business)"); if (n) await A("notReceived", { note: n }); }, true);
    if (["received", "revision"].includes(q.status)) { btn("⬆ Upload 1080p preview", async () => { const f = await pickFile("video/*"); if (!f) return; if (f.size > 200 * 1024 * 1024) throw new Error("Max 200 MB — export at 1080p."); const path = `xdeal/${ctx.storeId}/${ctx.id}/preview_${Date.now()}.mp4`; ctx.toast?.("Uploading… keep this page open"); await new Promise((res, rej) => uploadBytesResumable(sref(storage, path), f, { contentType: f.type || "video/mp4" }).then(res, rej)); await A("submit", { file: path }); ctx.toast?.("Sent for review"); }); btn("🔗 Send watermarked link", async () => { const l = prompt("Google Drive link of the preview (with watermark):"); if (l) await A("submit", { link: l }); }, true); }
    if (q.status === "approved") btn("📤 Send high-res (Drive link)", async () => { const l = prompt("Google Drive link of the HIGH-RES video:"); if (!l) return; const p = prompt("Post link (optional, if you also posted it):", "") || ""; await A("release", { link: l, postLink: p }); });
    (X.tips || []).forEach((t, i) => { if (!t.confirmed) btn(`✓ Got the ₱${t.amount} tip`, () => A("tipReceived", { i }), true); });
    if (q.status === "cancelled" && X.cancel && !X.appeal && Date.now() - X.cancel.at < 7 * 864e5) btn("⚖️ Appeal the cancel", async () => { const n = prompt("Why was the cancel unfair? TapTayo reviews it and returns your trust point if you're right."); if (n) { await A("appeal", { note: n }); ctx.toast?.("Appeal sent — we'll review it"); } }, true);
    if (q.status === "done" && !X.reviewByCreator) btn("⭐ Rate the business", async () => { const r = prompt("Rating 1–5:", "5"); if (r) await A("review", { rating: Number(r), comment: prompt("Comment (optional):", "") || "" }); }, true);
  } else {
    if (q.status === "accepted") btn("📦 Mark item sent", async () => { const tr = prompt("Courier + tracking no. (or “visit on <date>” for food / staycation):", ""); if (tr === null) return; await A("sent", { tracking: tr, courier: "" }); });
    if (q.status === "submitted") { btn("▶ View preview", async () => { const r = await call("xfileUrl", { storeId: ctx.storeId, id: ctx.id }); if (r.url) window.open(r.url, "_blank"); }, true); btn("👍 Approve", () => A("approve")); if (!(q.revisionsUsed >= 1)) btn("✏️ Ask 1 revision", async () => { const n = prompt("What should change?"); if (n) await A("revise", { note: n }); }, true); else btn("✕ Cancel — not for us", async () => { const r = prompt("Not happy with the revised video? Cancel the X-Deal.\n\nThe creator keeps the item, loses 1 trust point, and can appeal. Your cancel rate is shown to creators.\n\nWhy are you cancelling?"); if (r) { await A("cancel", { reason: r }); ctx.toast?.("X-Deal cancelled"); } }, true); }
    if (q.status === "released") { if (X.hiRes) btn("⬇ Open high-res", async () => window.open(X.hiRes, "_blank"), true); btn("✓ Confirm I got the video", () => A("confirmReleased")); }
    if (!["negotiating", "declined", "failed", "cancelled"].includes(q.status)) btn("💝 Send a tip", async () => { const a = prompt("Tip amount (₱) — send it by GCash to the creator, then add the reference:", "200"); if (!a) return; await A("tip", { amount: Number(a), ref: prompt("GCash reference no.:", "") || "" }); ctx.toast?.("Tip recorded — thank you!"); }, true);
    if (q.status === "negotiating") btn("Cancel offer", async () => { if (confirm("Cancel this X-Deal offer?")) await A("decline", { reason: "Cancelled by the business" }); }, true);
    if (q.status === "failed" || (q.status === "sent" && X.sentAt && Date.now() - X.sentAt > 14 * 864e5)) btn("🛡 File a Protect claim", async () => { const r = await call("protectClaim", { creatorStoreId: ctx.storeId, id: ctx.id, note: prompt("Anything we should know? (optional)", "") || "" }); ctx.toast?.(`Claim filed — ₱${r.amount} in TapTayo credits once we review it`); });
    if (q.status === "done" && !X.reviewByBusiness) btn("⭐ Rate the creator", async () => { const r = prompt("Rating 1–5 (on time, followed the brief):", "5"); if (r) await A("review", { rating: Number(r), comment: prompt("Comment (optional):", "") || "" }); }, true);
  }
  return box;
}
function pickFile(accept) { return new Promise((res) => { const i = document.createElement("input"); i.type = "file"; i.accept = accept; i.onchange = () => res(i.files?.[0] || null); i.addEventListener("cancel", () => res(null)); i.click(); }); }

/** business: request an X-Deal from a creator card */
export function xdealForm(c, store, { html, openModal, closeModal, toast }) {
  const X = c.creator.xdeal || {}; const types = X.types || ["food", "product", "staycation"];
  const def = store.mode === "stay" ? "staycation" : store.businessType === "products" ? "product" : "food";
  const body = html(`<div><p class="small">To <b>${esc(c.name)}</b> · video ${X.releaseDays || 5} day(s) after receiving${X.minTip ? ` · minimum tip ${peso(X.minTip)}` : ""} · item value up to ${X.cap >= 1e9 ? "any" : peso(X.cap)}</p>
    <label>What you'll give</label><select data-t>${types.map((t) => `<option value="${t}" ${t === def ? "selected" : ""}>${ITEM[t]}</option>`).join("")}</select>
    <label>Describe it</label><input data-d maxlength="200" placeholder="${def === "staycation" ? "1-night staycation for 2" : def === "product" ? "1 bottle serum + 1 toner" : "Food for 2 (any 2 mains + drinks)"}"/>
    <div class="row" style="gap:8px"><div style="flex:1"><label>Value (₱)</label><input data-v type="number" min="1" placeholder="600"/></div><div style="flex:1"><label>Tip (₱, optional)</label><input data-tip type="number" min="0" value="${X.minTip || ""}"/></div></div>
    <label>Video you want</label><input data-del maxlength="200" value="1 vertical video (30–60 s) for our page"/>
    <label>Instructions</label><textarea data-i rows="3" maxlength="800" placeholder="Show the product in use, mention our page, no competitor brands"></textarea>
    <div class="row" style="gap:8px"><div style="flex:1"><label>Shipping</label><select data-s><option value="talk">We'll agree</option><option value="business">We pay</option><option value="creator">Creator pays</option></select></div><div style="flex:1"><label>Deadline</label><input data-dl type="date"/></div></div>
    <p class="small muted" style="margin:8px 0 0">The creator confirms when the item arrives → countdown → you approve a watermarked 1080p preview → they send the high-res on Drive. Missed deadline? Strike for the creator${store ? "" : ""}, and a TapTayo Protect claim if you have it.</p><div data-err></div></div>`);
  const foot = html(`<div class="row" style="gap:8px"><button class="btn" data-go>Send X-Deal</button><button class="btn ghost" data-x>Cancel</button></div>`);
  foot.querySelector("[data-x]").onclick = closeModal;
  foot.querySelector("[data-go]").onclick = async (e) => { const g = (k) => body.querySelector(`[data-${k}]`).value; e.target.disabled = true; try { await call("xdealSend", { slug: c.slug, item: { type: g("t"), desc: g("d"), value: Number(g("v")) }, tip: Number(g("tip")) || 0, deliverables: g("del"), instructions: g("i"), shipping: g("s"), deadline: g("dl"), phone: store.contact?.phone || "" }); toast("X-Deal sent 🎁 — you'll see it under My offers"); closeModal(); } catch (x) { body.querySelector("[data-err]").innerHTML = `<div class="alert">${esc(x.message)}${/add-on|Billing/.test(x.message) ? ` <a href="#billing">Billing ›</a>` : ""}</div>`; e.target.disabled = false; } };
  openModal({ title: "🎁 X-Deal request", body, footer: foot });
}
