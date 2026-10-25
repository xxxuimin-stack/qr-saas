// Tables + QR codes (table mode) / Store QR (booking and pickup mode)
import { planLim, planName, limitNote } from "../planui.js";
import { entitled } from "../plans.js";
import { db } from "../firebase.js";
import { collection, doc, addDoc, updateDoc, deleteDoc, onSnapshot, query, orderBy, serverTimestamp, writeBatch } from "firebase/firestore";
import QRCode from "qrcode";
import { resolveTheme } from "../themes.js";
import { esc, html, toast, openModal, closeModal, confirmDialog, randomToken } from "../ui.js";
import { openQRDesigner, openQRDownloads } from "./qrdesign.js";
import { qrOnlySVG, designOf, dataUrlOf, downloadPNG } from "../brandqr.js";

const QR_OPTS = { width: 320, margin: 1, color: { dark: "#1d1a17", light: "#ffffff" } };

export function renderTablesPage(root, ctx) {
  const { storeId, store, labels, mode } = ctx;
  const base = `${location.origin}/m/${store.slug}`;

  // home-based café (delivery / pickup only) has no tables — just the store link & QR
  if (mode !== "table" || store.settings?.setup?.kind === "home") return renderStoreQR(root, ctx, base);

  const col = collection(db, "stores", storeId, "tables");
  let tables = [];

  const single = false;
  root.innerHTML = `
    <div class="tile">
      <div class="row between wrap">
        <div>
          <h3>${esc(labels.unit)}s & QR codes</h3>
          <p class="small muted">Each ${esc(labels.unit.toLowerCase())} has its own QR. When scanned, the system knows which ${esc(labels.unit.toLowerCase())} the order came from.</p>
        </div>
        <div class="row">
          <button class="btn ghost" id="qrDesign" type="button" title="Logo in the middle, color, dots, frame text">🎨 QR design</button>
          <button class="btn ghost" id="posterAll" type="button" title="PDF table tents, stickers, posters, PNG, SVG">⬇ Download QR codes</button>
          <button class="btn ghost" id="printAll" type="button">🖨 Print all</button>
          <button class="btn ghost" id="printAll18" type="button" title="Beer & liquor on top + full food menu, with an 18+ age check">🔞 Print 18+ QRs</button>
          ${mode === "table" ? `<button class="btn ghost" id="addWaitlist" type="button" title="Customers scan it at the entrance to get a place in line">🪑 Waitlist QR</button>` : ""}
          <span id="limTables"></span><button class="btn" id="addTable" type="button">+ Add ${esc(labels.unit.toLowerCase())}</button>
        </div>
      </div>
      <div id="tableGrid" class="qrgrid"></div>
    </div>
    <div class="tile" style="margin-top:14px">
      <h3>${single ? "Store QR (print this)" : "Pickup / delivery link (no table)"}</h3>
      <p class="small muted">${single ? "One QR for everything — dine-in, take-out, pickup, delivery, reservations." : "For customers who aren't seated — post it on your Facebook page or print it for the counter."}</p>
      <div class="row wrap"><span class="code">${esc(base)}</span><button class="btn ghost sm" id="copyBase" type="button">Copy</button><button class="btn ghost sm" id="qrBase" type="button">Show QR</button></div>
    </div>`;

  root.querySelector("#copyBase").onclick = () => navigator.clipboard.writeText(base).then(() => toast("Copied"));
  root.querySelector("#qrBase").onclick = () => showQR(store.name, base);
  const qrTargets = () => [
    ...tables.filter((t) => t.active !== false && !t.isRoom).map((t) => ({ label: t.label, url: `${base}?t=${t.qrToken}`, waitlist: !!t.isWaitlist })),
    { label: "Pickup / delivery", url: base, general: true },
  ];
  root.querySelector("#posterAll").onclick = () => openQRDownloads(ctx, qrTargets());
  root.querySelector("#qrDesign").onclick = () => { ctx.onQRDesign = () => draw(); openQRDesigner(ctx, qrTargets()[0]); };

  const unsub = onSnapshot(query(col, orderBy("sortOrder")), async (snap) => {
    tables = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    { const el = root.querySelector("#limTables"); if (el && ctx.store.mode === "table") el.innerHTML = limitNote(ctx, "tables", tables.filter((x) => !x.isRoom && !x.isWaitlist).length); }
    await draw();
  });

  async function draw() {
    const grid = root.querySelector("#tableGrid");
    grid.innerHTML = tables.length ? "" : `<p class="muted small">No ${labels.unit.toLowerCase()}s yet. Click "+ Add".</p>`;
    for (const t of tables) {
      if (t.active === false && t.isRoom) continue;
      const url = `${base}?t=${t.qrToken}`;
      const card = html(`
        <div class="qrcard ${t.active === false ? "off" : ""}">
          <img alt="QR ${esc(t.label)}" />
          <div class="lbl">${t.isRoom ? "🎤 " : ""}${esc(t.label)}${t.isRoom ? `<div class="small muted">VIP room</div>` : ""}</div>
          <div class="row" style="justify-content:center;gap:6px">
            <button class="btn ghost sm" data-dl title="Download PNG">⬇</button>
            ${t.isRoom ? "" : `<button class="btn ghost sm" data-dl18 title="Download 18+ menu QR">🔞</button>`}
            <button class="btn ghost sm" data-edit title="Rename">✎</button>
            <button class="btn ghost sm" data-del title="Delete">🗑</button>
          </div>
        </div>`);
      const img = card.querySelector("img");
      const dsg = designOf(store), cimg = dsg.center === "photo" ? (await dataUrlOf(store.coverUrl)) || (await dataUrlOf(store.logoUrl)) : dsg.center === "logo" ? await dataUrlOf(store.logoUrl) : null;
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(qrOnlySVG(url, { store, design: dsg, img: cimg, size: 320 }));
      card.querySelector("[data-dl]").onclick = () => downloadPNG(store, designOf(store), { label: t.label, url }).catch((e) => toast(e.message, "error"));
      card.querySelector("[data-dl18]")?.addEventListener("click", async () => download(`${store.slug}-${t.label}-18plus.png`, await QRCode.toDataURL(`${url}&menu=18`, { ...QR_OPTS, width: 600 })));
      card.querySelector("[data-edit]").onclick = () => tableForm(t);
      if (t.isRoom) { card.querySelector("[data-del]").remove(); card.querySelector("[data-edit]").remove(); }
      else card.querySelector("[data-del]").onclick = async () => {
        if (await confirmDialog(`Delete "${t.label}"? Its QR code will stop working.`)) await deleteDoc(doc(col, t.id));
      };
      grid.appendChild(card);
    }
  }

  function tableForm(t) {
    const body = html(`<div>
      ${t ? "" : `<label>How many?</label><input name="count" type="number" min="1" max="50" value="1" />`}
      <label>${t ? "Label" : "Label prefix"}</label>
      <input name="label" value="${esc(t?.label || labels.unit + " ")}" placeholder="${esc(labels.unit)} 1" />
      ${t ? "" : `<p class="small muted">e.g. prefix "Table " + count 10 → Table 1 … Table 10</p>`}
      ${t ? `<label class="check"><input type="checkbox" name="active" ${t.active !== false ? "checked" : ""}/> Active</label>` : ""}
    </div>`);
    const foot = html(`<div class="row" style="justify-content:flex-end"><button class="btn ghost" data-cancel type="button">Cancel</button><button class="btn" data-save type="button">Save</button></div>`);
    foot.querySelector("[data-cancel]").onclick = closeModal;
    foot.querySelector("[data-save]").onclick = async () => {
      const label = body.querySelector("[name=label]").value;
      if (!label.trim()) return toast("Enter a label", "error");
      if (t) {
        await updateDoc(doc(col, t.id), { label: label.trim(), active: body.querySelector("[name=active]").checked, updatedAt: serverTimestamp() });
      } else {
        const count = Math.min(50, Math.max(1, Number(body.querySelector("[name=count]").value || 1)));
        const lim = (planLim(ctx).tables || 0), have = tables.filter((x) => !x.isRoom && !x.isWaitlist).length;
        if (lim && have + count > lim) return toast(`The ${planName(ctx)} plan has up to ${lim} tables (you have ${have}). Add “+4 tables” or upgrade in Billing.`, "error");
        const batch = writeBatch(db);
        const startNum = tables.length + 1;
        for (let i = 0; i < count; i++) {
          const ref = doc(col);
          batch.set(ref, {
            label: count === 1 ? label.trim() : `${label}${startNum + i}`.replace(/\s+/g, " ").trim(),
            qrToken: randomToken(8),
            active: true,
            sortOrder: startNum + i,
            createdAt: serverTimestamp(),
          });
        }
        await batch.commit();
      }
      closeModal();
      toast("Saved");
    };
    openModal({ title: t ? "Edit" : `Add ${labels.unit.toLowerCase()}s`, body, footer: foot });
  }
  root.querySelector("#addTable").onclick = () => tableForm(null);
  root.querySelector("#addWaitlist")?.addEventListener("click", async () => {
    if (!entitled(ctx.sub, "waitlist")) return toast("The waitlist is a Pro feature. See Billing.", "error");
    const have = tables.find((t) => t.isWaitlist);
    if (have) return toast("You already have a waitlist QR — it's in the list below.");
    await addDoc(col, { label: "Waitlist", isWaitlist: true, qrToken: randomToken(8), active: true, sortOrder: 999, createdAt: serverTimestamp() });
    toast("Waitlist QR added — print it and put it at the entrance");
  });

  root.querySelector("#printAll18").onclick = async () => {
    const list = tables.filter((t) => t.active !== false && !t.isRoom);
    if (!list.length) return toast("No tables yet", "error");
    const cards = await Promise.all(list.map(async (t) => {
      const src = await QRCode.toDataURL(`${base}?t=${t.qrToken}&menu=18`, { ...QR_OPTS, width: 600 });
      return `<div class="pc">${store.logoUrl ? `<img class="lg" src="${esc(store.logoUrl)}"/>` : ""}<div class="sn">${esc(store.name)}</div><img src="${src}"/><div class="tl">${esc(t.label)}</div><div class="hint">🔞 18+ Menu · Beer &amp; liquor · Scan to order</div></div>`;
    }));
    printHTML(cards.join(""));
  };
  root.querySelector("#printAll").onclick = async () => {
    if (!tables.length) return toast("No tables yet", "error");
    const cards = await Promise.all(tables.filter((t) => t.active !== false).map(async (t) => {
      const src = await QRCode.toDataURL(`${base}?t=${t.qrToken}`, { ...QR_OPTS, width: 600 });
      return `<div class="pc">${store.logoUrl ? `<img class="lg" src="${esc(store.logoUrl)}"/>` : ""}<div class="sn">${esc(store.name)}</div><img src="${src}"/><div class="tl">${esc(t.label)}</div><div class="hint">Scan to order</div></div>`;
    }));
    printHTML(cards.join(""));
  };

  return unsub;
}

// ---------- single store QR (salon, clinic, laundry) ----------
function renderStoreQR(root, ctx, base) {
  const { store, labels } = ctx;
  root.innerHTML = `
    <div class="tile">
      <h3>Your ${esc(labels.order.toLowerCase())} link & QR</h3>
      <p class="small muted">Share it on Facebook/Messenger, or print it and place it at the counter. You only need one — no per-table QR.</p>
      <div class="row wrap" style="align-items:flex-start">
        <img id="storeQr" alt="QR" style="width:240px;border:1px solid var(--line);border-radius:12px" />
        <div class="stack" style="flex:1;min-width:240px">
          <div class="code">${esc(base)}</div>
          <div class="row wrap">
            <button class="btn ghost sm" id="copyBase" type="button">Copy link</button>
            <button class="btn ghost sm" id="dlQr" type="button">⬇ Download PNG</button>
            <button class="btn ghost sm" id="printQr" type="button">🖨 Print</button>
            <button class="btn ghost sm" id="qrDesign" type="button">🎨 QR design</button>
            <button class="btn sm" id="posterQr" type="button">⬇ PDF posters &amp; stickers</button>
          </div>
        </div>
      </div>
    </div>`;
  const img = root.querySelector("#storeQr");
  const drawQR = async () => { const dsg = designOf(store), cimg = dsg.center === "photo" ? (await dataUrlOf(store.coverUrl)) || (await dataUrlOf(store.logoUrl)) : dsg.center === "logo" ? await dataUrlOf(store.logoUrl) : null; img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(qrOnlySVG(base, { store, design: dsg, img: cimg, size: 480 })); };
  drawQR();
  root.querySelector("#copyBase").onclick = () => navigator.clipboard.writeText(base).then(() => toast("Copied"));
  root.querySelector("#dlQr").onclick = () => downloadPNG(store, designOf(store), { label: "qr", url: base }).catch((e) => toast(e.message, "error"));
  root.querySelector("#qrDesign").onclick = () => { ctx.onQRDesign = drawQR; openQRDesigner(ctx, { label: "", url: base }); };
  root.querySelector("#printQr").onclick = async () => {
    const src = await QRCode.toDataURL(base, { ...QR_OPTS, width: 600 });
    printHTML(`<div class="pc">${store.logoUrl ? `<img class="lg" src="${esc(store.logoUrl)}"/>` : ""}<div class="sn">${esc(store.name)}</div><img src="${src}"/><div class="hint">Scan to ${esc(labels.order.toLowerCase() === "booking" ? "book" : "order")}</div></div>`);
  };
  root.querySelector("#posterQr").onclick = () => openQRDownloads(ctx, [{ label: "", url: base, general: true }]);
  return () => {};
}

// ---------- poster / table tent maker ----------
const FORMATS = {
  tent: { name: "Table tent (fold in half)", page: "A4 landscape", hint: "Print on A4, fold along the dashed line so it stands on the table." },
  a5: { name: "A5 poster (2 per A4)", page: "A4 portrait", hint: "Two posters per page — cut along the dashed line." },
  a4: { name: "A4 poster", page: "A4 portrait", hint: "Full page — for the door, wall or counter." },
  sticker: { name: "Small stickers (8 per A4)", page: "A4 portrait", hint: "For tables, menus or the cashier. Print on sticker paper." },
};
function openPosterMaker(ctx, targets) {
  const { store, labels, mode } = ctx;
  const verb = mode === "salon" || mode === "stay" ? "book" : "order";
  const pays = (store.settings?.payments?.methods || store.payments || []).filter((m) => m.enabled !== false).map((m) => m.name).filter(Boolean).slice(0, 3);
  const body = html(`<div>
    <label>Format</label><select name="fmt">${Object.entries(FORMATS).map(([k, f]) => `<option value="${k}">${esc(f.name)}</option>`).join("")}</select>
    <p class="small muted" data-fhint></p>
    <div class="form2"><div><label>Headline</label><input name="h1" maxlength="30" value="Scan to ${verb}"/></div>
    <div><label>Small line</label><input name="h2" maxlength="60" value="${esc(`No app needed${pays.length ? ` · Pay with ${pays.join(", ")}` : ""}`)}"/></div></div>
    <label>Steps (shown on posters)</label><input name="steps" maxlength="90" value="${esc(verb === "book" ? "Scan · Pick a service & time · See you!" : "Scan · Choose · We'll bring it to you")}"/>
    <label>Wi-Fi (optional)</label><input name="wifi" maxlength="50" placeholder="e.g. CafeGuest / pass1234"/>
    ${targets.length > 1 ? `<label>Which QR codes</label><div class="row wrap" style="gap:6px;max-height:140px;overflow:auto">${targets.map((t, i) => `<label class="check" style="margin:0"><input type="checkbox" data-tg="${i}" ${t.waitlist ? "" : "checked"}/> ${esc(t.label)}${t.waitlist ? " (waitlist)" : ""}</label>`).join("")}</div>` : ""}
    <div data-pv style="margin-top:12px;display:flex;justify-content:center"></div></div>`);
  const foot = html(`<div class="row"><button class="btn ghost" type="button" data-x>Close</button><button class="btn" type="button" data-pr>🖨 Print</button></div>`);
  foot.querySelector("[data-x]").onclick = closeModal;
  const theme = resolveTheme(store.theme || {}, store.name);
  const opts = () => ({ fmt: body.querySelector("[name=fmt]").value, h1: body.querySelector("[name=h1]").value, h2: body.querySelector("[name=h2]").value, steps: body.querySelector("[name=steps]").value, wifi: body.querySelector("[name=wifi]").value.trim() });
  const chosen = () => targets.filter((_, i) => targets.length === 1 || body.querySelector(`[data-tg="${i}"]`)?.checked);
  async function preview() {
    const o = opts(); body.querySelector("[data-fhint]").textContent = FORMATS[o.fmt].hint;
    const t = chosen()[0] || targets[0];
    const qr = await QRCode.toDataURL(t.url, { ...QR_OPTS, width: 300 });
    body.querySelector("[data-pv]").innerHTML = `<div style="width:220px;transform-origin:top center">${posterCard(store, theme, t, o, qr, true)}</div><style>${POSTER_CSS(theme)}</style>`;
  }
  body.addEventListener("input", preview); body.addEventListener("change", preview);
  foot.querySelector("[data-pr]").onclick = async () => {
    const o = opts(), list = chosen(); if (!list.length) return toast("Pick at least one QR code", "error");
    const cards = await Promise.all(list.map(async (t) => posterCard(store, theme, t, o, await QRCode.toDataURL(t.url, { ...QR_OPTS, width: 900 }))));
    const w = window.open("", "_blank"); if (!w) return toast("Allow pop-ups to print", "error");
    const per = { tent: 1, a4: 1, a5: 2, sticker: 8 }[o.fmt];
    const pages = []; for (let i = 0; i < cards.length; i += per) pages.push(cards.slice(i, i + per));
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(store.name)} — QR ${esc(FORMATS[o.fmt].name)}</title>
      <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@600;800&display=swap" rel="stylesheet">
      <style>@page{size:${FORMATS[o.fmt].page};margin:0} body{margin:0;font-family:"Plus Jakarta Sans",system-ui,sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
      .sheet{width:${o.fmt === "tent" ? "297mm" : "210mm"};height:${o.fmt === "tent" ? "210mm" : "297mm"};page-break-after:always;display:grid;box-sizing:border-box;overflow:hidden;
        ${o.fmt === "tent" ? "grid-template-rows:1fr 1fr" : o.fmt === "a5" ? "grid-template-rows:1fr 1fr" : o.fmt === "sticker" ? "grid-template-columns:1fr 1fr;grid-template-rows:repeat(4,1fr);gap:6mm;padding:10mm" : ""}}
      .sheet > .pz{border:0} .sheet.a5 > .pz + .pz, .sheet.tent > .pz + .pz{border-top:1px dashed #999}
      .sheet.tent > .pz:first-child{transform:rotate(180deg)}
      ${POSTER_CSS(theme)} @media screen{body{background:#eee}.sheet{background:#fff;margin:10px auto;box-shadow:0 2px 10px rgba(0,0,0,.2)}}</style></head><body>
      ${pages.map((pg) => `<div class="sheet ${o.fmt}">${o.fmt === "tent" ? pg[0] + pg[0] : pg.join("")}</div>`).join("")}
      <script>document.fonts.ready.then(()=>setTimeout(()=>print(),300))<\/script></body></html>`);
    w.document.close();
  };
  openModal({ title: "Poster / table tent", body, footer: foot, wide: true });
  preview();
}
const POSTER_CSS = (t) => `.pz{--pc:${t.primary || "#FF5A36"};--pa:${t.accent || "#FFB627"};box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:6% 8%;color:#141414;background:#FFFBF2;font-family:"Plus Jakarta Sans",system-ui,sans-serif;container-type:inline-size;overflow:hidden;position:relative}
  .pz .pz-top{display:flex;align-items:center;gap:3cqw;margin-bottom:3cqw}.pz .pz-lg{width:13cqw;height:13cqw;border-radius:50%;object-fit:cover;border:.8cqw solid #141414}
  .pz .pz-sn{font-weight:800;font-size:6.5cqw;letter-spacing:-.02em}.pz .pz-h1{font-weight:800;font-size:11cqw;line-height:1;letter-spacing:-.03em;color:var(--pc);margin:1cqw 0 3cqw}
  .pz .pz-qr{background:#fff;border:1.2cqw solid #141414;border-radius:6cqw;padding:3cqw;box-shadow:2cqw 2cqw 0 #141414;width:56%}.pz .pz-qr img{width:100%;display:block}
  .pz .pz-tl{margin-top:4cqw;font-weight:800;font-size:8cqw;background:var(--pa);border:.8cqw solid #141414;border-radius:999px;padding:.8cqw 5cqw}
  .pz .pz-h2{margin-top:3cqw;font-size:3.6cqw;font-weight:600;color:#57534E}.pz .pz-steps{margin-top:2cqw;font-size:3.4cqw;font-weight:700}
  .pz .pz-wifi{margin-top:2.5cqw;font-size:3.2cqw;border:.5cqw dashed #57534E;border-radius:3cqw;padding:1cqw 3cqw}.pz .pz-ft{position:absolute;bottom:2.5cqw;font-size:2.4cqw;color:#a8a29e}
  .pz .pz-txt{display:contents}.pz .pz-top{order:1}.pz .pz-h1{order:2}.pz .pz-qr{order:3}.pz .pz-tl{order:4}.pz .pz-h2{order:5}.pz .pz-steps{order:6}.pz .pz-wifi{order:7}
  .sheet.tent .pz{flex-direction:row;gap:5%;padding:2% 8%}.sheet.tent .pz .pz-qr{width:25cqw;flex:none;border-width:.7cqw;border-radius:3.5cqw;padding:1.6cqw;box-shadow:1.2cqw 1.2cqw 0 #141414}
  .sheet.tent .pz .pz-txt{display:flex;flex-direction:column;align-items:flex-start;text-align:left;max-width:52cqw}.sheet.tent .pz .pz-top{margin-bottom:1cqw;gap:1.5cqw}.sheet.tent .pz .pz-lg{width:6cqw;height:6cqw;border-width:.5cqw}.sheet.tent .pz .pz-sn{font-size:3.4cqw}
  .sheet.tent .pz .pz-h1{font-size:6.5cqw;margin:0 0 1.5cqw}.sheet.tent .pz .pz-tl{font-size:3.6cqw;margin:0 0 1.2cqw;border-width:.5cqw;padding:.4cqw 3cqw}.sheet.tent .pz .pz-h2,.sheet.tent .pz .pz-steps,.sheet.tent .pz .pz-wifi{font-size:1.9cqw;margin-top:.8cqw}.sheet.tent .pz .pz-wifi{border-width:.3cqw}.sheet.tent .pz .pz-ft{font-size:1.3cqw;bottom:1.2cqw}
  .sheet.sticker .pz{border:.6mm dashed #bbb!important;border-radius:5mm;padding:4%;flex-direction:row;gap:4%}.sheet.sticker .pz .pz-h2,.sheet.sticker .pz .pz-steps,.sheet.sticker .pz .pz-wifi,.sheet.sticker .pz .pz-ft,.sheet.sticker .pz .pz-lg{display:none}
  .sheet.sticker .pz .pz-qr{width:44cqw;flex:none;border-width:1cqw;border-radius:5cqw;padding:2.5cqw;box-shadow:1.6cqw 1.6cqw 0 #141414}.sheet.sticker .pz .pz-txt{flex:1;min-width:0;display:flex;flex-direction:column;align-items:flex-start;text-align:left}
  .sheet.a5 .pz{padding:3% 8%}.sheet.a5 .pz .pz-qr{width:36%;border-width:.9cqw;border-radius:4.5cqw;padding:2.2cqw;box-shadow:1.5cqw 1.5cqw 0 #141414}.sheet.a5 .pz .pz-top{margin-bottom:1.5cqw}.sheet.a5 .pz .pz-lg{width:9cqw;height:9cqw}.sheet.a5 .pz .pz-sn{font-size:4.6cqw}.sheet.a5 .pz .pz-h1{font-size:7.5cqw;margin:0 0 2.5cqw}.sheet.a5 .pz .pz-tl{font-size:5cqw;margin-top:3cqw}.sheet.a5 .pz .pz-h2,.sheet.a5 .pz .pz-steps,.sheet.a5 .pz .pz-wifi{font-size:2.6cqw;margin-top:1.4cqw}.sheet.a5 .pz .pz-ft{font-size:1.6cqw;bottom:.6cqw}
  .sheet.sticker .pz .pz-sn{font-size:6cqw}.sheet.sticker .pz .pz-top{margin-bottom:1.5cqw}.sheet.sticker .pz .pz-h1{font-size:9cqw;margin:0 0 2.5cqw}.sheet.sticker .pz .pz-tl{font-size:6.5cqw;margin:0;border-width:.7cqw;padding:.6cqw 3.5cqw}`;
function posterCard(store, theme, t, o, qr, preview = false) {
  const label = t.general ? "" : t.waitlist ? "Join the waitlist" : t.label;
  return `<div class="pz" ${preview ? 'style="aspect-ratio:210/297;border:2px solid #141414;border-radius:12px;box-shadow:4px 4px 0 #141414"' : ""}>
    <div class="pz-qr"><img src="${qr}" alt="QR code"/></div>
    <div class="pz-txt"><div class="pz-top">${store.logoUrl ? `<img class="pz-lg" src="${esc(store.logoUrl)}" alt=""/>` : ""}<div class="pz-sn">${esc(store.name)}</div></div>
    <div class="pz-h1">${esc(t.waitlist ? "Scan to join the line" : o.h1)}</div>
    ${label ? `<div class="pz-tl">${esc(label)}</div>` : ""}
    ${o.h2 ? `<div class="pz-h2">${esc(o.h2)}</div>` : ""}${o.steps && !t.waitlist ? `<div class="pz-steps">${esc(o.steps)}</div>` : ""}
    ${o.wifi ? `<div class="pz-wifi">📶 Wi-Fi: ${esc(o.wifi)}</div>` : ""}</div><div class="pz-ft">powered by TapTayo</div></div>`;
}

// ---------- helpers ----------
function showQR(title, url) {
  const body = html(`<div style="text-align:center"><img style="width:260px" alt="QR"/><div class="code" style="margin-top:10px">${esc(url)}</div></div>`);
  QRCode.toDataURL(url, QR_OPTS).then((src) => (body.querySelector("img").src = src));
  openModal({ title, body });
}

function download(filename, dataUrl) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  a.click();
}

function printHTML(inner) {
  const w = window.open("", "_blank");
  w.document.write(`<!doctype html><html><head><title>Print QR</title><style>
    body{font-family:system-ui,sans-serif;margin:0;padding:16px;display:flex;flex-wrap:wrap;gap:16px}
    .pc{width:300px;border:1px dashed #999;border-radius:12px;padding:16px;text-align:center;page-break-inside:avoid}
    .pc img{width:100%} .pc img.lg{width:64px;height:64px;border-radius:50%;object-fit:cover;margin-bottom:6px} .sn{font-weight:700;font-size:18px;margin-bottom:6px} .tl{font-weight:800;font-size:26px;margin-top:6px} .hint{color:#666;font-size:13px}
    @media print{body{padding:0}}
  </style></head><body>${inner}<script>window.onload=()=>{window.print();}</script></body></html>`);
  w.document.close();
}
