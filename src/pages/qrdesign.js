// QR design (owner) + downloads: PDF table tents / stickers / posters, PNG, SVG
import { db } from "../firebase.js";
import { doc, updateDoc, serverTimestamp } from "firebase/firestore";
import { esc, html, toast, openModal, closeModal } from "../ui.js";
import { designOf, colorOf, ctaOf, previewCard, testPNG, scanTest, downloadPDF, downloadPNG, downloadSVG } from "../brandqr.js";

const COLORS = ["#C62828", "#111111", "#1D4ED8", "#0F766E", "#BE185D", "#92400E", "#6D28D9", "#15803D"];

export function openQRDesigner(ctx, sample) {
  const { store, storeId } = ctx;
  let d = designOf(store);
  const body = html(`<div class="qd">
    <div class="qd-prev"><div data-pv class="qd-card"><div class="skel" style="height:300px"></div></div><div data-scan class="small muted" style="margin-top:8px;text-align:center"></div></div>
    <div class="qd-form">
      <label>Center</label><div class="seg" data-g="center">${[["logo", "My logo"], ["photo", "My photo"], ["initials", "Initials"], ["none", "None"]].map(([k, l]) => `<button type="button" data-v="${k}">${l}</button>`).join("")}</div>
      ${!store.logoUrl ? `<p class="small muted" style="margin:4px 0 0">No logo yet — add one in Settings → Shop info (initials are used until then).</p>` : ""}
      <label>Color</label><div class="qd-colors">${COLORS.map((c) => `<button type="button" data-c="${c}" style="background:${c}" aria-label="${c}"></button>`).join("")}<input type="color" data-cc title="Custom color"/></div>
      <label>Dot style</label><div class="seg" data-g="dots">${[["round", "Round"], ["rounded", "Rounded square"], ["square", "Classic"]].map(([k, l]) => `<button type="button" data-v="${k}">${l}</button>`).join("")}</div>
      <label>Frame text</label><input data-ft maxlength="28" placeholder="${esc(ctaOf(store, { ...d, frameText: "" }))}" value="${esc(d.frameText || "")}"/>
      <label class="check"><input type="checkbox" data-sl ${d.showLabel !== false ? "checked" : ""}/> Show table / room number</label>
      <label class="check"><input type="checkbox" data-na ${d.showNoApp !== false ? "checked" : ""}/> Show “No app needed”</label>
      <p class="small muted">The printed link never changes. You can change the design anytime and reprint — old prints keep working.</p>
    </div></div>`);
  const sync = () => {
    body.querySelectorAll("[data-g]").forEach((g) => g.querySelectorAll("[data-v]").forEach((b) => b.classList.toggle("on", d[g.dataset.g] === b.dataset.v)));
    const col = colorOf(store, d);
    body.querySelectorAll("[data-c]").forEach((b) => b.classList.toggle("on", b.dataset.c.toLowerCase() === col.toLowerCase()));
    body.querySelector("[data-cc]").value = /^#[0-9a-f]{6}$/i.test(col) ? col : "#C62828";
  };
  let seq = 0;
  const draw = async () => {
    const my = ++seq; sync();
    const svg = await previewCard(store, d, sample); if (my !== seq) return;
    body.querySelector("[data-pv]").innerHTML = svg;
    const el = body.querySelector("[data-scan]"); el.textContent = "Checking if phones can read it…";
    try { const ok = await scanTest(await testPNG(store, d, sample)); if (my !== seq) return; el.innerHTML = ok === true ? `✅ <b>Scan test passed</b> — phones can read this code.` : ok === false ? `⚠️ <b>Hard to scan.</b> Try "Classic" dots, a darker color, or "None" in the center.` : `Strong error correction keeps it readable with your logo. Test it with your phone camera.`; }
    catch { el.textContent = "Test it with your phone camera before printing."; }
  };
  body.querySelectorAll("[data-g]").forEach((g) => g.querySelectorAll("[data-v]").forEach((b) => (b.onclick = () => { d = { ...d, [g.dataset.g]: b.dataset.v }; draw(); })));
  body.querySelectorAll("[data-c]").forEach((b) => (b.onclick = () => { d = { ...d, color: b.dataset.c }; draw(); }));
  body.querySelector("[data-cc]").oninput = (e) => { d = { ...d, color: e.target.value }; draw(); };
  let t; body.querySelector("[data-ft]").oninput = (e) => { d = { ...d, frameText: e.target.value.trim() }; clearTimeout(t); t = setTimeout(draw, 300); };
  body.querySelector("[data-sl]").onchange = (e) => { d = { ...d, showLabel: e.target.checked }; draw(); };
  body.querySelector("[data-na]").onchange = (e) => { d = { ...d, showNoApp: e.target.checked }; draw(); };
  const foot = html(`<div class="row" style="gap:8px;justify-content:flex-end"><button class="btn ghost" type="button" data-x>Cancel</button><button class="btn" type="button" data-save>Save design</button></div>`);
  foot.querySelector("[data-x]").onclick = closeModal;
  foot.querySelector("[data-save]").onclick = async (e) => {
    e.target.disabled = true;
    try { await updateDoc(doc(db, "stores", storeId), { "settings.qrDesign": d, updatedAt: serverTimestamp() }); store.settings = { ...(store.settings || {}), qrDesign: d }; toast("QR design saved"); closeModal(); ctx.onQRDesign?.(); }
    catch (x) { toast(x.message, "error"); e.target.disabled = false; }
  };
  openModal({ title: "QR design", body, footer: foot, wide: true });
  draw();
}

export function openQRDownloads(ctx, targets) {
  const { store } = ctx; const d = designOf(store);
  const n = targets.length;
  const opt = (k, title, sub) => `<button type="button" class="qd-dl" data-f="${k}"><b>${title}</b><span>${sub}</span></button>`;
  const body = html(`<div>
    <p class="small muted" style="margin-top:0">All files use your logo, color and store name (change them in <b>🎨 QR design</b>).</p>
    <div class="qd-dls">
      ${opt("tent", "PDF · table tents", `${n} page${n > 1 ? "s" : ""} · fold each page in half · A4`)}
      ${opt("sticker", "PDF · stickers", `9 per A4 · cut along the dotted lines`)}
      ${opt("a4", "PDF · A4 poster", "Counter, door, wall")}
      ${opt("a5", "PDF · A5 poster", "Smaller stands, menu holders")}
    </div>
    <label style="margin-top:14px">Single QR as an image</label>
    <div class="row wrap" style="gap:8px"><select data-one style="max-width:260px">${targets.map((t, i) => `<option value="${i}">${esc(t.label)}</option>`).join("")}</select><button class="btn ghost sm" type="button" data-png>PNG (high-res)</button><button class="btn ghost sm" type="button" data-svg>SVG (big prints / tarpaulin)</button></div>
    <div data-busy class="small muted" style="margin-top:10px"></div></div>`);
  const busy = (t) => (body.querySelector("[data-busy]").textContent = t);
  body.querySelectorAll("[data-f]").forEach((b) => (b.onclick = async () => {
    busy("Making your PDF…"); body.querySelectorAll("button").forEach((x) => (x.disabled = true));
    try { await downloadPDF(store, d, targets, b.dataset.f, { steps: store.mode === "table" ? ["Scan the QR with your phone camera", "Pick your food and drinks", "Pay with GCash or cash"] : ["Scan the QR with your phone camera", "Choose a service and time", "Get your confirmation"] }); busy("✓ Downloaded"); }
    catch (x) { busy(""); toast(x.message || "Couldn't make the PDF", "error"); }
    body.querySelectorAll("button").forEach((x) => (x.disabled = false));
  }));
  const one = () => targets[Number(body.querySelector("[data-one]").value) || 0];
  body.querySelector("[data-png]").onclick = () => downloadPNG(store, d, one()).catch((x) => toast(x.message, "error"));
  body.querySelector("[data-svg]").onclick = () => downloadSVG(store, d, one()).catch((x) => toast(x.message, "error"));
  openModal({ title: "Download QR codes", body, footer: html(`<div><button class="btn ghost" type="button" data-x>Close</button></div>`) });
  document.querySelector(".modal [data-x], [data-x]")?.addEventListener("click", closeModal);
}
