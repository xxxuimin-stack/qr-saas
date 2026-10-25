// Gift card artwork (canvas) — the same picture is shown on the page and downloaded as a PNG.
export const GIFT_DESIGNS = {
  classic: { name: "Classic", bg: ["#1f2a44", "#3b4a7a"], accent: "#f2c46d", ink: "#ffffff", emoji: "✨", pattern: "dots" },
  birthday: { name: "Birthday", bg: ["#ff7eb3", "#ff9a5a"], accent: "#fff3b0", ink: "#ffffff", emoji: "🎂", pattern: "confetti" },
  love: { name: "Love", bg: ["#c2185b", "#ff6f91"], accent: "#ffe1ea", ink: "#ffffff", emoji: "💖", pattern: "hearts" },
  holiday: { name: "Holiday", bg: ["#0f5132", "#1f8a5b"], accent: "#ffd166", ink: "#ffffff", emoji: "🎄", pattern: "snow" },
};
const W = 1200, H = 720;

function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function wrap(ctx, text, maxW) { const words = String(text || "").split(/\s+/); const lines = []; let cur = ""; for (const w of words) { const t = cur ? cur + " " + w : w; if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t; } if (cur) lines.push(cur); return lines.slice(0, 3); }
// deterministic pseudo-random so the card looks the same every time
function rng(seed) { let s = 0; for (const c of String(seed)) s = (s * 31 + c.charCodeAt(0)) >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

/** Draw the card. data = { storeName, logoImg?, amount, to, from, message, code, expires, design, status } */
export function drawGiftCard(canvas, data) {
  const d = GIFT_DESIGNS[data.design] || GIFT_DESIGNS.classic;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, d.bg[0]); g.addColorStop(1, d.bg[1]);
  rr(ctx, 0, 0, W, H, 48); ctx.fillStyle = g; ctx.fill(); ctx.save(); rr(ctx, 0, 0, W, H, 48); ctx.clip();
  // pattern
  const r = rng(data.code || data.to || "x");
  ctx.globalAlpha = 0.18;
  for (let i = 0; i < 70; i++) {
    const x = r() * W, y = r() * H, s = 6 + r() * 18;
    ctx.fillStyle = d.pattern === "confetti" ? ["#fff", "#ffe066", "#7cf", "#b5ff9e"][i % 4] : "#fff";
    if (d.pattern === "hearts" || d.pattern === "snow") { ctx.font = `${s * 2}px serif`; ctx.fillText(d.pattern === "hearts" ? "♥" : "❄", x, y); }
    else if (d.pattern === "confetti") { ctx.save(); ctx.translate(x, y); ctx.rotate(r() * 3); ctx.fillRect(-s / 2, -s / 5, s, s / 2.5); ctx.restore(); }
    else { ctx.beginPath(); ctx.arc(x, y, s / 4, 0, 7); ctx.fill(); }
  }
  ctx.globalAlpha = 1;
  // ribbon
  ctx.fillStyle = d.accent; ctx.globalAlpha = 0.9; ctx.fillRect(W - 300, 0, 46, H); ctx.fillRect(0, H - 210, W, 46); ctx.globalAlpha = 1;
  ctx.font = "120px serif"; ctx.textAlign = "center"; ctx.fillText(d.emoji, W - 277, H - 230);
  // header
  ctx.textAlign = "left"; ctx.fillStyle = d.ink;
  let x0 = 70;
  if (data.logoImg) { ctx.save(); rr(ctx, 70, 60, 96, 96, 24); ctx.clip(); ctx.drawImage(data.logoImg, 70, 60, 96, 96); ctx.restore(); x0 = 190; }
  ctx.font = "700 46px system-ui, -apple-system, Segoe UI, sans-serif"; ctx.fillText(data.storeName || "", x0, 112);
  ctx.font = "600 26px system-ui, sans-serif"; ctx.globalAlpha = 0.85; ctx.fillText("GIFT CARD", x0, 150); ctx.globalAlpha = 1;
  // amount
  ctx.font = "800 150px system-ui, sans-serif"; ctx.fillStyle = d.accent;
  ctx.fillText("₱" + Number(data.amount || 0).toLocaleString("en-PH"), 66, 330);
  // to / from / message
  ctx.fillStyle = d.ink; ctx.font = "600 34px system-ui, sans-serif";
  ctx.fillText(`For ${data.to || ""}`, 72, 392);
  ctx.font = "italic 28px Georgia, serif"; ctx.globalAlpha = 0.95;
  wrap(ctx, data.message ? `“${data.message}”` : "", 760).forEach((l, i) => ctx.fillText(l, 72, 440 + i * 36));
  ctx.globalAlpha = 1;
  // bottom band: code + validity
  ctx.fillStyle = "rgba(0,0,0,.28)"; ctx.fillRect(0, H - 164, W, 164);
  ctx.fillStyle = d.ink; ctx.font = "600 24px system-ui, sans-serif"; ctx.globalAlpha = 0.8;
  ctx.fillText(data.from ? `From ${data.from}` : "", 72, H - 112); ctx.globalAlpha = 1;
  ctx.font = "800 54px ui-monospace, Menlo, Consolas, monospace"; ctx.fillText(data.code || "PENDING", 72, H - 50);
  ctx.textAlign = "right"; ctx.font = "500 24px system-ui, sans-serif"; ctx.globalAlpha = 0.85;
  ctx.fillText(data.expires ? `Valid until ${new Date(data.expires).toLocaleDateString("en-PH", { month: "short", day: "numeric", year: "numeric" })}` : "Waiting for payment check", W - 70, H - 104);
  ctx.fillText("Show this code at the counter", W - 70, H - 60); ctx.globalAlpha = 1;
  if (data.status && data.status !== "active") { ctx.save(); ctx.translate(W / 2, H / 2); ctx.rotate(-0.25); ctx.font = "900 110px system-ui"; ctx.textAlign = "center"; ctx.fillStyle = "rgba(255,255,255,.35)"; ctx.fillText(data.status === "used" ? "USED" : data.status === "pending" ? "PENDING" : data.status.toUpperCase(), 0, 30); ctx.restore(); }
  ctx.restore();
  return canvas;
}

/** Load the store logo so it can be drawn (ignored if CORS blocks it) */
export function loadLogo(url) {
  return new Promise((res) => { if (!url) return res(null); const im = new Image(); im.crossOrigin = "anonymous"; im.onload = () => res(im); im.onerror = () => res(null); im.src = url; setTimeout(() => res(null), 3000); });
}

export function downloadCanvas(canvas, filename) {
  const go = (url) => { const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); };
  try { canvas.toBlob((b) => { if (!b) return go(canvas.toDataURL("image/png")); const u = URL.createObjectURL(b); go(u); setTimeout(() => URL.revokeObjectURL(u), 3000); }, "image/png"); }
  catch { go(canvas.toDataURL("image/png")); }
}
