// Feedback & Incidents (owner)
import { db, call } from "../firebase.js";
import { collection, doc, onSnapshot, query, orderBy, limit, updateDoc, serverTimestamp } from "firebase/firestore";
import { esc, html, toast, money } from "../ui.js";
import { INC_TYPES } from "../staffpanels.js";

export function renderFeedbackPage(root, ctx) {
  const { storeId, store } = ctx;
  const cur = store.settings?.currency || "PHP";
  let fb = [], inc = [], tab = "feedback", filt = "all";
  root.innerHTML = `<div class="row between wrap" style="margin-bottom:12px">
      <div class="tabs" style="margin:0;max-width:360px;flex:1"><button data-tab="feedback" class="active">⭐ Feedback</button><button data-tab="incidents">⚠️ Incidents</button></div>
      <select id="filt" style="width:auto"><option value="all">All</option><option value="low">Low ratings (1–2★)</option><option value="comments">With comments</option></select></div>
    <div class="grid" id="stats" style="margin-bottom:12px"></div><div id="list"></div>`;
  root.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => { tab = b.dataset.tab; root.querySelectorAll("[data-tab]").forEach((x) => x.classList.toggle("active", x === b)); draw(); }));
  root.querySelector("#filt").onchange = (e) => { filt = e.target.value; draw(); };
  const u1 = onSnapshot(query(collection(db, "stores", storeId, "feedback"), orderBy("createdAt", "desc"), limit(300)), (s) => { fb = s.docs.map((d) => ({ id: d.id, ...d.data() })); draw(); });
  const u2 = onSnapshot(query(collection(db, "stores", storeId, "incidents"), orderBy("createdAt", "desc"), limit(300)), (s) => { inc = s.docs.map((d) => ({ id: d.id, ...d.data() })); draw(); });

  function draw() {
    const st = root.querySelector("#stats"), list = root.querySelector("#list");
    if (tab === "feedback") {
      const avg = fb.length ? (fb.reduce((a, f) => a + f.rating, 0) / fb.length).toFixed(1) : "—";
      const avgOf = (k) => { const xs = fb.filter((f) => f[k]); return xs.length ? (xs.reduce((a, f) => a + f[k], 0) / xs.length).toFixed(1) : null; };
      const fAvg = avgOf("foodRating"), sAvg = avgOf("serviceRating");
      const dist = [5, 4, 3, 2, 1].map((n) => `${n}★ ${fb.filter((f) => f.rating === n).length}`).join(" · ");
      st.innerHTML = `<div class="tile"><div class="k">Average</div><div class="v">${avg} ★</div><div class="small muted">${fb.length} ratings</div></div>${fAvg || sAvg ? `<div class="tile"><div class="k">Food · Service</div><div class="v">${fAvg || "—"} · ${sAvg || "—"} ★</div><div class="small muted">café orders</div></div>` : ""}<div class="tile"><div class="k">Distribution</div><div class="small" style="margin-top:8px">${dist}</div></div><div class="tile"><div class="k">Low (1–2★)</div><div class="v">${fb.filter((f) => f.rating <= 2).length}</div></div>`;
      const rows = fb.filter((f) => filt === "all" || (filt === "low" ? f.rating <= 2 : !!f.comment));
      list.innerHTML = rows.length ? "" : `<div class="tile muted">No feedback yet.</div>`;
      rows.forEach((f) => {
        const el = html(`<div class="ocard ${f.hidden ? "st-cancelled" : ""}" style="margin-bottom:10px;border-left-color:${f.rating >= 4 ? "var(--ok)" : f.rating === 3 ? "var(--warn)" : "var(--danger)"}">
          <div class="ohead"><div><span style="color:var(--warn);font-size:1.1rem">${"★".repeat(f.rating)}</span><span class="muted">${"★".repeat(5 - f.rating)}</span> <b>#${f.orderNo}</b>${f.foodRating ? ` <span class="pill">🍽 Food ${f.foodRating}/5</span>` : ""}${f.serviceRating ? ` <span class="pill">🙋 Service ${f.serviceRating}/5</span>` : ""} <span class="small muted">${esc(f.customerName || "")} · ${esc(f.serviceType || "")}${f.tableLabel ? " · " + esc(f.tableLabel) : ""}</span></div><div class="small muted">${f.createdAt?.toDate ? f.createdAt.toDate().toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" }) : ""}</div></div>
          ${f.comment ? `<div style="margin:6px 0">${esc(f.comment)}</div>` : ""}${f.photoUrl ? `<a href="${esc(f.photoUrl)}" target="_blank"><img src="${esc(f.photoUrl)}" style="max-height:120px;border-radius:8px"/></a>` : ""}
          <div class="small muted">${(f.items || []).join(", ")}</div>
          ${f.reply ? `<div class="small" style="margin:6px 0;padding:8px 10px;border-radius:8px;background:#f3f7f4">↩ <b>${{ thanks: "💛 Thanked", investigating: "🔎 Investigating", refund: "💸 Refund approved", voucher: "🎟️ Voucher " + esc(f.reply.voucherCode || ""), resolved: "✅ Resolved" }[f.reply.type] || ""}</b>${f.reply.amount ? " · ₱" + f.reply.amount : ""}${f.reply.note ? ` — ${esc(f.reply.note)}` : ""} <span class="muted">· ${esc(f.reply.by || "")}</span></div>` : ""}
          <div class="ofoot"><span class="row wrap" style="gap:6px">${f.rating <= 3 && !f.reply ? `<span class="small muted">Tip: investigate first.</span>` : ""}<button class="btn ghost sm" data-r="thanks">💛 Thank you</button><button class="btn ghost sm" data-r="investigating">🔎 Investigate</button><button class="btn ghost sm" data-r="refund">💸 Refund</button><button class="btn ghost sm" data-r="voucher">🎟️ Voucher</button><button class="btn ghost sm" data-r="resolved">✅ Resolved</button></span><button class="btn ghost sm" data-hide>${f.hidden ? "Unhide" : "Hide from menu"}</button></div></div>`);
        el.querySelector("[data-hide]").onclick = () => updateDoc(doc(db, "stores", storeId, "feedback", f.id), { hidden: !f.hidden, updatedAt: serverTimestamp() });
        el.querySelectorAll("[data-r]").forEach((b) => (b.onclick = async () => {
          const type = b.dataset.r; let amount = null;
          if (type === "voucher" || type === "refund") { const v = prompt(type === "voucher" ? "Voucher amount for the next order (₱10–₱2,000):" : "Refund amount (₱):", type === "voucher" ? "100" : ""); if (v == null) return; amount = Number(v); }
          let method = null, refNo = null;
          if (type === "refund") { method = (prompt("Refunded via (cash / gcash / maya / bank):", "gcash") || "gcash").toLowerCase().trim(); refNo = method === "cash" ? "" : (prompt("Reference no. of the refund (for your records):", "") ?? ""); }
          const note = prompt("Short message to the customer (optional, they will see this):", type === "thanks" ? "Thank you for the kind words! See you again 💛" : "") ?? "";
          try { const r = await call("replyFeedback", { feedbackId: f.id, type, amount, note, method, refNo }); toast(r.reply.voucherCode ? `Voucher ${r.reply.voucherCode} sent` : "Reply sent"); } catch (e) { toast(e.message, "error"); }
        }));
        list.appendChild(el);
      });
    } else {
      const open = inc.filter((i) => ["open", "in_discussion"].includes(i.status));
      const vouchers = inc.filter((i) => i.resolution?.type === "voucher").reduce((a, i) => a + (i.resolution.amount || 0), 0);
      const refunds = inc.filter((i) => i.resolution?.type === "refund").reduce((a, i) => a + (i.resolution.amount || 0), 0);
      const byType = Object.entries(inc.reduce((m, i) => ((m[i.type] = (m[i.type] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${INC_TYPES[k] || k} ${n}`).join(" · ");
      st.innerHTML = `<div class="tile"><div class="k">Open</div><div class="v">${open.length}</div></div><div class="tile"><div class="k">Total reports</div><div class="v">${inc.length}</div><div class="small muted">${byType}</div></div><div class="tile"><div class="k">Vouchers given</div><div class="v">${money(vouchers, cur)}</div></div><div class="tile"><div class="k">Refunds</div><div class="v">${money(refunds, cur)}</div></div>`;
      list.innerHTML = inc.length ? "" : `<div class="tile muted">No incidents yet.</div>`;
      inc.forEach((i) => {
        const r = i.resolution;
        list.appendChild(html(`<div class="ocard" style="margin-bottom:10px;border-left-color:${["open", "in_discussion"].includes(i.status) ? "var(--danger)" : i.status === "dismissed" ? "var(--line)" : "var(--ok)"}">
          <div class="ohead"><div><b>#${i.orderNo}</b> · ${INC_TYPES[i.type] || esc(i.type)} <span class="pill ${i.status === "resolved" ? "active" : i.status === "dismissed" ? "locked" : "trial"}">${esc(i.status.replace("_", " "))}</span></div><div class="small muted">${i.createdAt?.toDate ? i.createdAt.toDate().toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" }) : ""}</div></div>
          <div class="small muted">${esc(i.customerName || "")} ${esc(i.customerPhone || "")} · ${esc(i.serviceType || "")}${i.tableLabel ? " · " + esc(i.tableLabel) : ""} · order ${money(i.total, cur)}</div>
          <div style="margin:6px 0">${esc(i.description)}</div>${i.photoUrl ? `<a href="${esc(i.photoUrl)}" target="_blank"><img src="${esc(i.photoUrl)}" style="max-height:120px;border-radius:8px"/></a>` : ""}
          ${r ? `<div class="small" style="margin-top:6px"><b>${r.type === "voucher" ? `🎟️ Voucher ${esc(r.voucherCode)} ${money(r.amount, cur)}` : r.type === "refund" ? `💸 Refund ${money(r.amount, cur)} · ${esc(r.method || "")}` : r.type === "remake" ? "🔁 Remake" : r.type === "dismissed" ? "❌ Dismissed" : "✓ Resolved"}</b> — ${esc(r.note || "")} <span class="muted">by ${esc(r.by || "")}${i.claimedByName ? " · handled by " + esc(i.claimedByName) : ""}</span></div>` : ""}
        </div>`));
      });
    }
  }
  return () => { u1(); u2(); };
}
