// Branded QR codes: store color, rounded dots, logo / photo / initials in the middle, a frame with the call to action.
// Error correction "H" (30%) + a center mark ≤ 22% of the width keeps every code scannable.
// Exports: PDF table tents (fold in half), PDF stickers (9 per A4), PDF A4 / A5 posters, PNG, SVG.
// The printed link never changes (?t=<table token>); only what's behind it can change.
import QRCode from "qrcode";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const FONT = "Poppins, Arial, Helvetica, sans-serif";

export const QR_DEFAULTS = { center: "logo", color: null, dots: "round", frameText: "", showLabel: true, showNoApp: true };
export const designOf = (store) => ({ ...QR_DEFAULTS, ...(store.settings?.qrDesign || {}) });
export const colorOf = (store, d) => d.color || store.theme?.primary || "#C62828";
export const ctaOf = (store, d) => d.frameText || (store.mode === "salon" || store.mode === "laundry" ? "Scan to book" : store.mode === "stay" ? "Scan for requests" : "Scan to order");

/** Fetch an image as a data URL (needed so PDFs/PNGs can include it). Returns null when it can't be read. */
const imgCache = new Map();
export async function dataUrlOf(url) {
  if (!url) return null;
  if (url.startsWith("data:")) return url;
  if (imgCache.has(url)) return imgCache.get(url);
  const p = (async () => { try { const r = await fetch(url, { mode: "cors" }); if (!r.ok) return null; const b = await r.blob(); return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(null); fr.readAsDataURL(b); }); } catch { return null; } })();
  imgCache.set(url, p);
  return p;
}

/** QR dots need contrast: a light brand color (yellow, pastel) is darkened for the code only. */
export function qrInk(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || ""); if (!m) return "#111111";
  let [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  const lum = () => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  let k = 0; while (lum() > 0.18 && k++ < 20) { r *= 0.85; g *= 0.85; b *= 0.85; }
  return "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
}

/** The QR itself as SVG <g> markup, drawn in a size×size box at (x,y). */
export function qrGroup(text, { x = 0, y = 0, size = 200, color = "#111", dots = "round", hole = 0 } = {}) {
  color = qrInk(color);
  const q = QRCode.create(text, { errorCorrectionLevel: "H" });
  const n = q.modules.size, data = q.modules.data, cell = size / n;
  const at = (r, c) => data[r * n + c];
  const inFinder = (r, c) => (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
  // alignment patterns (5×5) are drawn solid so every scanner finds them
  const ver = q.version, al = [];
  if (ver > 1) { const cnt = Math.floor(ver / 7) + 2, step = n === 145 ? 26 : Math.ceil((n - 13) / (2 * cnt - 2)) * 2, pos = [n - 7]; for (let i = 1; i < cnt - 1; i++) pos[i] = pos[i - 1] - step; pos.push(6); pos.reverse();
    for (const r of pos) for (const c of pos) if (!((r === 6 && c === 6) || (r === 6 && c === n - 7) || (r === n - 7 && c === 6))) al.push([r, c]); }
  const inAlign = (r, c) => al.some(([ar, ac]) => Math.abs(r - ar) <= 2 && Math.abs(c - ac) <= 2);
  // round hole just big enough for the center mark (+ a thin white ring)
  const holeR = hole > 0 ? hole / cell / 2 + 0.7 : 0, mid = n / 2;
  const inHole = (r, c) => holeR && Math.hypot(r + 0.5 - mid, c + 0.5 - mid) < holeR;
  let out = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!at(r, c) || inFinder(r, c) || inAlign(r, c) || inHole(r, c)) continue;
    const px = x + c * cell, py = y + r * cell;
    if (dots === "round") out += `<circle cx="${(px + cell / 2).toFixed(2)}" cy="${(py + cell / 2).toFixed(2)}" r="${(cell * 0.5).toFixed(2)}"/>`;
    else if (dots === "rounded") out += `<rect x="${(px + cell * 0.04).toFixed(2)}" y="${(py + cell * 0.04).toFixed(2)}" width="${(cell * 0.92).toFixed(2)}" height="${(cell * 0.92).toFixed(2)}" rx="${(cell * 0.3).toFixed(2)}"/>`;
    else out += `<rect x="${px.toFixed(2)}" y="${py.toFixed(2)}" width="${(cell + 0.2).toFixed(2)}" height="${(cell + 0.2).toFixed(2)}"/>`;
  }
  // finder patterns (the three big squares): rounded frames + rounded centers
  const finder = (r0, c0) => { const fx = x + c0 * cell, fy = y + r0 * cell, rr = dots === "square" ? 0 : cell * 1.6;
    return `<rect x="${(fx + cell / 2).toFixed(2)}" y="${(fy + cell / 2).toFixed(2)}" width="${(cell * 6).toFixed(2)}" height="${(cell * 6).toFixed(2)}" rx="${rr.toFixed(2)}" fill="none" stroke="${color}" stroke-width="${cell.toFixed(2)}"/>
      <rect x="${(fx + cell * 2).toFixed(2)}" y="${(fy + cell * 2).toFixed(2)}" width="${(cell * 3).toFixed(2)}" height="${(cell * 3).toFixed(2)}" rx="${(dots === "square" ? 0 : cell * 0.9).toFixed(2)}" fill="${color}"/>`; };
  const align = ([r0, c0]) => { const ax = x + (c0 - 2) * cell, ay = y + (r0 - 2) * cell, rr = dots === "square" ? 0 : cell;
    return `<rect x="${(ax + cell / 2).toFixed(2)}" y="${(ay + cell / 2).toFixed(2)}" width="${(cell * 4).toFixed(2)}" height="${(cell * 4).toFixed(2)}" rx="${rr.toFixed(2)}" fill="none" stroke="${color}" stroke-width="${cell.toFixed(2)}"/><rect x="${(ax + cell * 2).toFixed(2)}" y="${(ay + cell * 2).toFixed(2)}" width="${cell.toFixed(2)}" height="${cell.toFixed(2)}" rx="${(dots === "square" ? 0 : cell * 0.3).toFixed(2)}" fill="${color}"/>`; };
  return `<g fill="${color}">${out}</g>${finder(0, 0)}${finder(0, n - 7)}${finder(n - 7, 0)}${al.filter(([r, c]) => !inHole(r, c)).map(align).join("")}`;
}

/** Center mark: logo / photo / initials inside a white circle. */
function centerMark(cx, cy, d, { store, design, img, color }) {
  if (design.center === "none") return "";
  const r = d / 2, inner = r * 0.86;
  const clip = `c${Math.random().toString(36).slice(2, 8)}`;
  if ((design.center === "logo" || design.center === "photo") && img) {
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff"/><clipPath id="${clip}"><circle cx="${cx}" cy="${cy}" r="${inner}"/></clipPath><image href="${img}" x="${cx - inner}" y="${cy - inner}" width="${inner * 2}" height="${inner * 2}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clip})"/>`;
  }
  const initials = (store.name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#fff"/><circle cx="${cx}" cy="${cy}" r="${inner}" fill="${color}"/><text x="${cx}" y="${cy + inner * 0.36}" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="${inner * 0.95}" fill="#fff">${esc(initials)}</text>`;
}

/** Just the QR (square), with the center mark — for PNG / SVG downloads. */
export function qrOnlySVG(url, { store, design, img, size = 1000 }) {
  const color = colorOf(store, design), pad = size * 0.08, q = size - pad * 2, hole = design.center === "none" ? 0 : q * 0.2;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><rect width="${size}" height="${size}" rx="${size * 0.05}" fill="#fff"/>${qrGroup(url, { x: pad, y: pad, size: q, color, dots: design.dots, hole })}${centerMark(size / 2, size / 2, hole, { store, design, img, color })}</svg>`;
}

/**
 * A printable card (table tent face / sticker / poster) as SVG, in user units = mm.
 * kind: "card" (portrait card) | "poster" (A4/A5 with headline + steps)
 */
export function cardSVG({ store, design, logoImg, centerImg, url, label, w = 90, h = 120, kind = "card", headline = "", steps = [] }) {
  const color = colorOf(store, design), cta = ctaOf(store, design);
  const fullW = w; w = kind === "poster" ? Math.min(fullW, h / 1.6) : fullW; // poster: keep proportions, center on the page
  const ox = (fullW - w) / 2;
  const m = w * 0.07, qs = kind === "poster" ? w * 0.56 : w * 0.66;
  let y = m;
  let s = "";
  // header: small logo + store name
  const hz = kind === "poster" ? w * 0.075 : w * 0.1;
  const nameSize = kind === "poster" ? w * 0.05 : w * 0.065;
  const logo = logoImg ? `<clipPath id="lg"><rect x="0" y="0" width="${hz}" height="${hz}" rx="${hz * 0.25}"/></clipPath><image href="${logoImg}" x="0" y="0" width="${hz}" height="${hz}" preserveAspectRatio="xMidYMid slice" clip-path="url(#lg)"/>` : "";
  const nameW = (store.name || "").length * nameSize * 0.55;
  const gx = (w - (logoImg ? hz + 2 + nameW : nameW)) / 2;
  s += `<g transform="translate(${gx.toFixed(2)},${y.toFixed(2)})">${logo}<text x="${logoImg ? hz + 2 : 0}" y="${hz * 0.72}" font-family="${FONT}" font-weight="700" font-size="${nameSize}" fill="#111">${esc(store.name)}</text></g>`;
  y += hz + w * 0.04;
  if (kind === "poster" && headline) { s += `<text x="${w / 2}" y="${y + w * 0.07}" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="${w * 0.085}" fill="#111">${esc(headline)}</text>`; y += w * 0.12; }
  // QR with a soft frame
  const qx = (w - qs) / 2, fr = qs * 0.06;
  s += `<rect x="${qx - fr}" y="${y}" width="${qs + fr * 2}" height="${qs + fr * 2}" rx="${fr * 1.6}" fill="#fff" stroke="${color}" stroke-opacity=".18" stroke-width="${w * 0.006}"/>`;
  const hole = design.center === "none" ? 0 : qs * 0.2;
  s += qrGroup(url, { x: qx, y: y + fr, size: qs, color, dots: design.dots, hole });
  s += centerMark(w / 2, y + fr + qs / 2, hole, { store, design, img: centerImg, color });
  y += qs + fr * 2 + w * 0.05;
  // call-to-action pill
  const ph = w * 0.1;
  s += `<rect x="${m}" y="${y}" width="${w - m * 2}" height="${ph}" rx="${ph / 2}" fill="${color}"/><text x="${w / 2}" y="${y + ph * 0.66}" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="${ph * 0.5}" fill="#fff">${esc(cta)}</text>`;
  y += ph + w * 0.05;
  if (design.showLabel !== false && label) { s += `<text x="${w / 2}" y="${y + w * 0.06}" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="${kind === "poster" ? w * 0.065 : w * 0.085}" fill="#111">${esc(label)}</text>`; y += w * 0.1; }
  if (kind === "poster" && steps.length) {
    steps.slice(0, 3).forEach((t, i) => { s += `<circle cx="${m + w * 0.03}" cy="${y + w * 0.045}" r="${w * 0.028}" fill="${color}"/><text x="${m + w * 0.03}" y="${y + w * 0.056}" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="${w * 0.032}" fill="#fff">${i + 1}</text><text x="${m + w * 0.075}" y="${y + w * 0.057}" font-family="${FONT}" font-size="${w * 0.036}" fill="#374151">${esc(t)}</text>`; y += w * 0.075; });
  }
  if (design.showNoApp !== false) s += `<text x="${w / 2}" y="${Math.max(y + w * 0.03, h - m * 0.6)}" text-anchor="middle" font-family="${FONT}" font-size="${w * 0.032}" fill="#9CA3AF">No app needed · taptayo</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${fullW}mm" height="${h}mm" viewBox="0 0 ${fullW} ${h}"><rect width="${fullW}" height="${h}" fill="#fff"/><g transform="translate(${ox.toFixed(2)},0)">${s}</g></svg>`;
}

/** SVG string → PNG data URL at the given pixel width. */
export function rasterize(svg, pxW, pxH, { flip = false } = {}) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => { const c = document.createElement("canvas"); c.width = pxW; c.height = pxH; const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, pxW, pxH); if (flip) { g.translate(pxW, pxH); g.rotate(Math.PI); } g.drawImage(img, 0, 0, pxW, pxH); try { res(c.toDataURL("image/png")); } catch (e) { rej(e); } };
    img.onerror = () => rej(new Error("Couldn't draw the QR image."));
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  });
}

/** Can a phone read it? Uses the browser's built-in barcode reader when it has one (Chrome / Android). */
export async function scanTest(pngDataUrl) {
  if (!("BarcodeDetector" in window)) return null; // unknown on this browser
  try {
    const det = new window.BarcodeDetector({ formats: ["qr_code"] });
    const img = new Image(); img.src = pngDataUrl; await img.decode();
    const r = await det.detect(img); return r.length > 0;
  } catch { return null; }
}

async function images(store, design) {
  const logoImg = await dataUrlOf(store.logoUrl);
  const centerImg = design.center === "photo" ? (await dataUrlOf(store.coverUrl)) || logoImg : design.center === "logo" ? logoImg : null;
  return { logoImg, centerImg };
}

/**
 * Build a PDF and download it.
 * fmt: "tent" (A4, one tent per page, fold in half) | "sticker" (9 per A4) | "a4" | "a5"
 * targets: [{ label, url }]
 */
export async function downloadPDF(store, design, targets, fmt, opts = {}) {
  const { jsPDF } = await import("jspdf");
  const { logoImg, centerImg } = await images(store, design);
  const DPI = 300 / 25.4; // px per mm
  const page = fmt === "a5" ? [148, 210] : [210, 297];
  const pdf = new jsPDF({ unit: "mm", format: fmt === "a5" ? "a5" : "a4", orientation: "portrait", compress: true });
  let first = true;
  const newPage = () => { if (!first) pdf.addPage(); first = false; };
  if (fmt === "sticker") {
    const cw = 63, ch = 88, gx = (page[0] - cw * 3) / 4, gy = (page[1] - ch * 3) / 4;
    for (let i = 0; i < targets.length; i++) {
      if (i % 9 === 0) newPage();
      const k = i % 9, col = k % 3, row = Math.floor(k / 3);
      const png = await rasterize(cardSVG({ store, design, logoImg, centerImg, url: targets[i].url, label: targets[i].label, w: cw, h: ch }), Math.round(cw * DPI), Math.round(ch * DPI));
      const x = gx + col * (cw + gx), y = gy + row * (ch + gy);
      pdf.addImage(png, "PNG", x, y, cw, ch, undefined, "FAST");
      pdf.setDrawColor(210); pdf.setLineDashPattern([1, 1], 0); pdf.roundedRect(x, y, cw, ch, 3, 3);
    }
  } else if (fmt === "tent") {
    const cw = 104, ch = 140, x = (page[0] - cw) / 2;
    for (const t of targets) {
      newPage();
      const svg = cardSVG({ store, design, logoImg, centerImg, url: t.url, label: t.label, w: cw, h: ch });
      const png = await rasterize(svg, Math.round(cw * DPI), Math.round(ch * DPI));
      const flipped = await rasterize(svg, Math.round(cw * DPI), Math.round(ch * DPI), { flip: true });
      // top half upside down so the folded tent reads on both sides
      pdf.addImage(flipped, "PNG", x, page[1] / 2 - ch - 4, cw, ch, undefined, "FAST");
      pdf.addImage(png, "PNG", x, page[1] / 2 + 4, cw, ch, undefined, "FAST");
      pdf.setDrawColor(180); pdf.setLineDashPattern([2, 2], 0); pdf.line(10, page[1] / 2, page[0] - 10, page[1] / 2);
      pdf.setFontSize(7); pdf.setTextColor(150); pdf.text("fold here", page[0] - 10, page[1] / 2 - 1.5, { align: "right" });
    }
  } else {
    const w = page[0] - 30, h = page[1] - 30;
    for (const t of targets) {
      newPage();
      const png = await rasterize(cardSVG({ store, design, logoImg, centerImg, url: t.url, label: t.label, w, h, kind: "poster", headline: opts.headline || ctaOf(store, design), steps: opts.steps || [] }), Math.round(w * DPI * 0.8), Math.round(h * DPI * 0.8));
      pdf.addImage(png, "PNG", 15, 15, w, h, undefined, "FAST");
    }
  }
  pdf.save(`${store.slug}-${fmt === "tent" ? "table-tents" : fmt === "sticker" ? "stickers" : fmt + "-posters"}.pdf`);
}

const save = (name, href) => { const a = document.createElement("a"); a.href = href; a.download = name; document.body.appendChild(a); a.click(); a.remove(); };
export async function downloadPNG(store, design, t) {
  const { centerImg } = await images(store, design);
  save(`${store.slug}-${t.label}.png`, await rasterize(qrOnlySVG(t.url, { store, design, img: centerImg, size: 1200 }), 1200, 1200));
}
export async function downloadSVG(store, design, t) {
  const { centerImg } = await images(store, design);
  save(`${store.slug}-${t.label}.svg`, URL.createObjectURL(new Blob([qrOnlySVG(t.url, { store, design, img: centerImg, size: 1000 })], { type: "image/svg+xml" })));
}
/** Live preview (screen): a card with the current design */
export async function previewCard(store, design, t) {
  const { logoImg, centerImg } = await images(store, design);
  return cardSVG({ store, design, logoImg, centerImg, url: t.url, label: t.label, w: 90, h: 120 }).replace(/width="90mm" height="120mm"/, 'width="100%" height="auto"');
}
export async function testPNG(store, design, t) {
  const { centerImg } = await images(store, design);
  return rasterize(qrOnlySVG(t.url, { store, design, img: centerImg, size: 600 }), 600, 600);
}
