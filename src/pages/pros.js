// Freelancers (owner): turn on "Hiring", set the shop's cut per service category, look at applicants' portfolios, accept,
// find & invite freelancers near you, rate them, report a no-show. Accepted freelancers become on-call staff of the shop:
// job offers with a countdown (rotation / first-to-accept / nearest first — Settings → Salon), self-collect & remit.
import { auth, call } from "../firebase.js";
import { esc, toast, confirmDialog } from "../ui.js";

const BADGE = { id: "🪪 ID checked", cert: "📜 Certified / trained", trusted: "⭐ Trusted" };
const fmtT = (ms) => new Date(ms).toLocaleTimeString("en-PH", { hour: "numeric", minute: "2-digit" });
export function renderProsPage(root) {
  let D = null, dir = null, dirSkill = "";
  root.innerHTML = `<div id="pz"><p class="muted small">Loading…</p></div>`;
  const $ = (s) => root.querySelector(s);
  async function load() { try { D = await call("shopPros", {}); } catch (e) { $("#pz").innerHTML = `<div class="tile">${esc(e.message)}</div>`; return; } draw(); }
  const flags = (p) => { const s = p.stats || {}; const out = []; if (s.downgrades) out.push(`${s.downgrades} cheaper-service request${s.downgrades > 1 ? "s" : ""}`); if (s.flags) out.push(`<b style="color:#B91C1C">${s.flags} client flag${s.flags > 1 ? "s" : ""}</b>`); if (s.short) out.push(`${s.short} finished too fast`); if (s.noPhoto) out.push(`${s.noPhoto} without after photo`); return out.length ? `<div class="small" style="margin-top:4px;color:#92400E">🚩 ${out.join(" · ")} <span class="muted">(of ${p.doneHere || 0} jobs here)</span></div>` : ""; };
  const card = (p, acts) => `<div class="tile" style="padding:12px;margin-top:10px"><div class="row" style="gap:10px;align-items:flex-start">
      ${p.photoUrl ? `<img src="${esc(p.photoUrl)}" alt="" style="width:52px;height:52px;border-radius:50%;object-fit:cover"/>` : `<span style="width:52px;height:52px;border-radius:50%;background:#DCFCE7;display:grid;place-items:center;font-size:24px">🧑‍🎨</span>`}
      <div style="flex:1;min-width:0"><b>${esc(p.name)}</b> ${p.busy ? `<span class="tag" style="background:#DBEAFE;color:#1D4ED8">${p.busy.state === "onway" ? "🛵 On the way" : "💇 With a client"} · until ${fmtT(p.busy.until)}</span>` : p.available ? `<span class="tag" style="background:#DCFCE7;color:#15803D">🟢 Available</span>` : ""}${p.paused ? `<span class="tag">⏸ Paused</span>` : ""}
        <div class="small muted">${p.skills.map((k) => esc(D.skills[k] || k)).join(" · ")}${p.distKm != null ? ` · ${p.distKm} km` : ""}${p.rateNote ? ` · ${esc(p.rateNote)}` : ""}</div>
        <div class="small">${p.badges.map((b) => BADGE[b]).join(" · ") || `<span class="muted">No badges yet</span>`} · ${p.jobsDone} jobs${p.rating ? ` · ★ ${p.rating} (${p.ratingCount})` : ""}${p.noShows ? ` · <b style="color:#B91C1C">${p.noShows} no-show${p.noShows > 1 ? "s" : ""}</b>` : ""}${p.strikes ? ` · <b style="color:#B91C1C">${p.strikes} confirmed report${p.strikes > 1 ? "s" : ""}</b>` : ""}</div>
        ${p.bio ? `<div class="small" style="margin-top:4px">${esc(p.bio)}</div>` : ""}${p.note ? `<div class="small" style="margin-top:4px">💬 “${esc(p.note)}”</div>` : ""}${flags(p)}</div></div>
      ${p.portfolio.length ? `<div class="row" style="gap:6px;margin-top:8px;overflow-x:auto;flex-wrap:nowrap">${p.portfolio.slice(0, 10).map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener"><img src="${esc(x.url)}" alt="${esc(x.caption || "")}" style="width:84px;height:84px;object-fit:cover;border-radius:10px"/></a>`).join("")}</div>` : ""}
      <div class="row wrap" style="gap:6px;margin-top:10px">${acts}</div></div>`;
  const cutRow = (id, label, c, isDefault) => `<div class="row" style="gap:6px;align-items:center;margin-top:6px" data-cut="${esc(id)}"><span class="small" style="flex:1;min-width:0">${esc(label)}</span>
      <select data-ct style="max-width:90px"><option value="percent" ${!c || c.type !== "fixed" ? "selected" : ""}>%</option><option value="fixed" ${c?.type === "fixed" ? "selected" : ""}>₱</option></select>
      <input data-cv type="number" min="0" step="1" style="max-width:90px" value="${c ? c.value : ""}" placeholder="${isDefault ? "30" : "default"}"/></div>`;
  function draw() {
    const H = D.hiring || {}; const acc = D.pros.filter((p) => p.status === "accepted"), app_ = D.pros.filter((p) => p.status === "applied"), inv = D.pros.filter((p) => p.status === "invited");
    const O = D.offers || {};
    $("#pz").innerHTML = `<div class="tile"><div class="row between wrap"><div><h3 style="margin:0">🧑‍🎨 Hire freelancers</h3><p class="small muted" style="margin:4px 0 0">Freelancers near you (nails, hair, lashes, massage, makeup…) apply with their portfolio (10+ photos). Accepted freelancers get your job offers when they're available — the shop keeps its cut per service, the freelancer gets the rest.</p></div>
        <label class="switch"><input type="checkbox" id="hOn" ${H.on ? "checked" : ""}/><span></span></label></div>
      ${D.needPin ? `<p class="small" style="color:#B45309">📍 Add your shop's Google Maps pin first (Settings → Contact) so freelancers near you can find you.</p>` : ""}
      <label>Looking for</label><div class="row wrap" id="hSk" style="gap:6px">${Object.entries(D.skills).map(([k, l]) => `<button type="button" class="btn sm ${(H.skills || []).includes(k) ? "" : "ghost"}" data-k="${k}">${l}</button>`).join("")}</div>
      <label class="check" style="margin-top:10px"><input type="checkbox" id="hCert" ${H.requireCert === undefined ? (H.skills || []).some((k) => (D.certSkills || []).includes(k)) : H.requireCert ? "checked" : ""}/> Require a checked certificate / proof of training <span class="muted small">(recommended for massage &amp; spa — LGU / DOH rules)</span></label>
      <label style="margin-top:10px">Note to freelancers (optional)</label><input id="hNote" value="${esc(H.note || "")}" placeholder="e.g. Weekend home service · bring your own kit"/>
      <details style="margin-top:12px"><summary><b>💰 Shop's cut per service</b> <span class="small muted">— what you keep from each service a freelancer does; the rest is theirs</span></summary>
        <p class="small muted" style="margin:6px 0 0">Example: ₱200 per eyelash service, 10% per hair service. Prices always come from your menu, so a freelancer can't under-record a service.</p>
        <div id="hCuts">${cutRow("__default", "Default (all other services)", H.cutDefault || { type: "percent", value: 30 }, true)}${(D.cats || []).map((c) => cutRow(c.id, c.name, (H.cuts || {})[c.id], false)).join("")}</div></details>
      <div class="row" style="gap:8px;margin-top:10px"><button class="btn sm" id="hSave">Save</button><span class="small muted">${acc.length} of ${D.limit >= 1e9 ? "unlimited" : D.limit} freelancers on your plan${D.limit < 1e9 ? ` · <a href="#billing">more with an upgrade</a>` : ""}</span></div>
      <p class="small muted" style="margin:10px 0 0">Job offers: <b>${O.enabled ? `${O.mode === "race" ? "all at once, first to accept" : "one at a time (rotation)"}${O.nearest ? ", nearest first" : ""}, ${Math.round((O.seconds || 300) / 60)} min to answer` : "off"}</b> — change in <a href="#settings">Settings → Salon → Job offers</a>. Turn on <b>Staff collect &amp; remit</b> if freelancers may take cash from clients.${D.rating ? ` Freelancers rate your shop <b>★ ${D.rating.avg}</b> (${D.rating.count})${D.rating.paysOnTime != null ? ` · ${D.rating.paysOnTime}% say you pay on time` : ""}.` : ""}</p></div>
      ${app_.length ? `<h3 style="margin:18px 4px 0">New applicants (${app_.length})</h3>${app_.map((p) => card(p, `<button class="btn sm" data-acc="${p.uid}">✓ Accept</button><button class="btn ghost sm" data-rej="${p.uid}">Reject</button><button class="btn ghost sm" data-rep="${p.uid}" data-name="${esc(p.name)}">🚩 Report</button>`)).join("")}` : ""}
      <h3 style="margin:18px 4px 0">My freelancers (${acc.length})</h3>${acc.length ? acc.map((p) => card(p, `<button class="btn ghost sm" data-rate="${p.uid}">★ Rate</button><button class="btn ghost sm" data-ns="${p.uid}">Report no-show</button><button class="btn ghost sm" data-rm="${p.uid}">Remove</button><button class="btn ghost sm" data-rep="${p.uid}" data-name="${esc(p.name)}">🚩 Report</button>`)).join("") : `<p class="small muted" style="margin:6px 4px">None yet — turn on hiring, or invite freelancers below.</p>`}
      ${inv.length ? `<h3 style="margin:18px 4px 0">Invited</h3>${inv.map((p) => card(p, `<span class="small muted">Waiting for ${esc(p.name.split(" ")[0])} to accept</span>`)).join("")}` : ""}
      <div class="tile" style="margin-top:18px"><div class="row between wrap"><h3 style="margin:0">🔎 Find freelancers near you</h3><select id="dSk" style="max-width:200px"><option value="">All skills</option>${Object.entries(D.skills).map(([k, l]) => `<option value="${k}" ${dirSkill === k ? "selected" : ""}>${l}</option>`).join("")}</select></div><div id="dir"><button class="btn ghost sm" id="dLoad" style="margin-top:10px">Show freelancers near my shop</button></div></div>`;
    $("#hSk").onclick = (e) => { const b = e.target.closest("[data-k]"); if (!b) return; b.classList.toggle("ghost"); if (!b.classList.contains("ghost") && (D.certSkills || []).includes(b.dataset.k)) $("#hCert").checked = true; };
    const readCuts = () => { const out = {}; let def = null; root.querySelectorAll("#hCuts [data-cut]").forEach((r) => { const v = r.querySelector("[data-cv]").value; if (v === "") return; const c = { type: r.querySelector("[data-ct]").value, value: Number(v) }; if (r.dataset.cut === "__default") def = c; else out[r.dataset.cut] = c; }); return { cuts: out, cutDefault: def }; };
    $("#hSave").onclick = async () => { try { await call("shopPros", { action: "hiring", on: $("#hOn").checked, skills: [...root.querySelectorAll("#hSk [data-k]:not(.ghost)")].map((b) => b.dataset.k), note: $("#hNote").value, requireCert: $("#hCert").checked, ...readCuts() }); toast($("#hOn").checked ? "Hiring is on — freelancers near you can apply" : "Saved"); load(); } catch (e) { toast(e.message, "error"); } };
    $("#hOn").onchange = () => $("#hSave").click();
    const act = async (body, msg) => { try { await call("shopPros", body); if (msg) toast(msg); load(); } catch (e) { toast(e.message, "error"); } };
    root.querySelectorAll("[data-acc]").forEach((b) => (b.onclick = () => act({ action: "accept", uid: b.dataset.acc }, "Accepted — they're now your freelancer (your cut per service applies)")));
    root.querySelectorAll("[data-rej]").forEach((b) => (b.onclick = () => act({ action: "reject", uid: b.dataset.rej, reason: prompt("Reason (optional, they see it):", "") || "" }, "Rejected")));
    root.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = async () => { if (await confirmDialog("Remove this freelancer? Their upcoming jobs come back to you to reassign.", { okText: "Remove" })) act({ action: "remove", uid: b.dataset.rm }, "Removed"); }));
    root.querySelectorAll("[data-rate]").forEach((b) => (b.onclick = () => { const s = prompt("Rate this freelancer (1–5 stars):", "5"); if (s) act({ action: "rate", uid: b.dataset.rate, stars: Number(s) }, "Thanks — rating saved"); }));
    root.querySelectorAll("[data-ns]").forEach((b) => (b.onclick = async () => { const code = prompt("They accepted a job but didn't come? Booking code (e.g. A-1234):", ""); if (!code) return; act({ action: "noshow", uid: b.dataset.ns, apptId: code.trim().toUpperCase() }, "No-show recorded"); }));
    root.querySelectorAll("[data-rep]").forEach((b) => (b.onclick = () => reportPro(b.dataset.rep, b.dataset.name)));
    $("#dSk").onchange = (e) => { dirSkill = e.target.value; dir = null; loadDir(); };
    $("#dLoad").onclick = loadDir; if (dir) drawDir();
  }
  // 🚩 report a freelancer to TapTayo (fake / stolen portfolio, took a client outside the app, unsafe…)
  function reportPro(uid, name) {
    const w = document.createElement("div"); w.className = "modal-back"; w.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px";
    w.innerHTML = `<div class="tile" style="max-width:480px;width:100%;margin:0"><h3 style="margin-top:0">🚩 Report ${esc(name)}</h3><p class="small muted">TapTayo checks every report. Confirmed: 1 = warning · 2 = paused 14 days · 3 = closed. A confirmed fake portfolio is hidden until the photos are replaced. Fake reports count against your shop.</p>
      <label>What happened?</label><select data-r><option value="fake">Fake or stolen portfolio photos</option><option value="bypass">Took a client outside the app</option><option value="unsafe">Rude or unsafe with a client</option><option value="work">Poor work / didn't finish the job</option><option value="other">Other</option></select>
      <label>Details</label><textarea data-d rows="3" placeholder="e.g. These photos are from another salon's Instagram (link)."></textarea>
      <label class="btn ghost sm" style="margin-top:8px;display:inline-flex">📷 Add proof<input type="file" accept="image/*" multiple data-f hidden/></label> <span class="small muted" data-fs></span>
      <div class="row" style="gap:8px;margin-top:12px;justify-content:flex-end"><button class="btn ghost" data-x>Cancel</button><button class="btn" data-ok style="background:#B91C1C">Send report</button></div></div>`;
    document.body.appendChild(w); const ev = [];
    w.querySelector("[data-x]").onclick = () => w.remove();
    w.querySelector("[data-f]").onchange = async (e) => { const { uploadPrivateImage } = await import("../upload.js"); for (const f of [...e.target.files].slice(0, 4 - ev.length)) { w.querySelector("[data-fs]").textContent = "Uploading…"; try { ev.push(await uploadPrivateImage(D.storeId, auth.currentUser.uid, f, { max: 1400, name: `proreport_${uid}_${Date.now()}` })); } catch (x) { toast(x.message, "error"); } } w.querySelector("[data-fs]").textContent = ev.length ? `${ev.length} attached ✓` : ""; };
    w.querySelector("[data-ok]").onclick = async (e) => { e.target.disabled = true; try { await call("shopPros", { action: "report", uid, reason: w.querySelector("[data-r]").value, details: w.querySelector("[data-d]").value, evidence: ev }); toast("Report sent — TapTayo will check it"); w.remove(); } catch (x) { toast(x.message, "error"); e.target.disabled = false; } };
  }
  async function loadDir() { $("#dir").innerHTML = `<p class="small muted">Loading…</p>`; try { dir = await call("shopPros", { action: "directory", skill: dirSkill }); } catch (e) { $("#dir").innerHTML = `<p class="small">${esc(e.message)}</p>`; return; } drawDir(); }
  function drawDir() {
    if (dir.needPin) { $("#dir").innerHTML = `<p class="small">📍 Add your shop's map pin first (Settings → Contact).</p>`; return; }
    $("#dir").innerHTML = dir.pros.length ? dir.pros.map((p) => card(p, p.status === "accepted" ? `<span class="small muted">✅ Already yours</span>` : p.status === "invited" ? `<span class="small muted">Invited</span>` : p.status === "applied" ? `<span class="small muted">Applied — see above</span>` : `<button class="btn sm" data-inv="${p.uid}">📩 Invite</button>`)).join("") : `<p class="small muted" style="margin-top:8px">No freelancers listed near you yet. Share taptayo.com/pro with freelancers you know.</p>`;
    root.querySelectorAll("[data-inv]").forEach((b) => (b.onclick = async () => { b.disabled = true; try { await call("shopPros", { action: "invite", uid: b.dataset.inv }); toast("Invited — they'll get a notification"); dir = null; loadDir(); load(); } catch (e) { b.disabled = false; toast(e.message, "error"); } }));
  }
  load();
}
