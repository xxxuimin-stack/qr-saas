// Explore feed (owner): post what's new, portfolio shots and promos — they show to people near you who like what you offer.
import { call } from "../firebase.js";
import { esc, html, toast, confirmDialog } from "../ui.js";
import { uploadImage } from "../upload.js";

const KINDS = [["update", "📣 Update"], ["new", "✨ New"], ["promo", "🔥 Promo"], ["portfolio", "🖼 Portfolio"]];
const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 60 ? `${Math.max(1, m)} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };

export function renderFeedPage(root, ctx) {
  const { storeId, store } = ctx;
  let kind = "update", photos = [], info = null;
  root.innerHTML = `<div class="tile" id="fstat"><p class="muted small">Loading…</p></div>
    <div class="tile" style="margin-top:14px"><h3 style="margin:0 0 4px">🌏 Post to the TapTayo feed</h3>
      <p class="small muted" style="margin:0 0 10px">Shows in <a href="/explore/" target="_blank" rel="noopener">Explore</a> to people near you (and people planning a trip here) who like what you offer. Good posts: new service, before/after, this week's promo, free slots today.</p>
      <div class="row wrap" id="fk" style="gap:6px;margin-bottom:8px">${KINDS.map(([k, l]) => `<button class="btn sm ${k === kind ? "" : "ghost"}" data-k="${k}">${l}</button>`).join("")}</div>
      <textarea id="ft" rows="4" maxlength="500" placeholder="e.g. Chrome cat-eye nails 💅 this week only ₱450! 3 slots left today." style="width:100%"></textarea>
      <div class="row between small muted"><span id="fc">0 / 500</span><span></span></div>
      <div class="row wrap" id="fp" style="gap:8px;margin:8px 0"></div>
      <label class="btn ghost sm" style="cursor:pointer">📷 Add photos (up to 4)<input type="file" accept="image/*" multiple id="ff" hidden/></label>
      <div class="row" style="gap:8px;margin-top:12px"><button class="btn" id="fgo">Post</button><span class="small muted" id="fmsg"></span></div></div>
    <div class="tile" style="margin-top:14px"><h3 style="margin:0 0 8px">My posts</h3><div id="fl"><p class="muted small">Loading…</p></div></div>`;
  const $ = (s) => root.querySelector(s);
  $("#fk").onclick = (e) => { const b = e.target.closest("[data-k]"); if (!b) return; kind = b.dataset.k; $("#fk").querySelectorAll("[data-k]").forEach((x) => x.classList.toggle("ghost", x.dataset.k !== kind)); };
  $("#ft").oninput = () => { $("#fc").textContent = `${$("#ft").value.length} / 500`; };
  const drawPics = () => { $("#fp").innerHTML = photos.map((u, i) => `<span style="position:relative"><img src="${esc(u)}" style="width:76px;height:76px;object-fit:cover;border-radius:10px"/><button class="btn ghost sm" data-rm="${i}" style="position:absolute;top:-8px;right:-8px;padding:2px 7px">✕</button></span>`).join(""); };
  $("#fp").onclick = (e) => { const b = e.target.closest("[data-rm]"); if (b) { photos.splice(Number(b.dataset.rm), 1); drawPics(); } };
  $("#ff").onchange = async (e) => {
    const files = [...e.target.files].slice(0, 4 - photos.length); e.target.value = "";
    for (const f of files) { $("#fmsg").textContent = "Uploading photo…"; try { photos.push(await uploadImage(storeId, `feed_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`, f, { max: 1200 })); drawPics(); } catch (x) { toast(x.message, "error"); } }
    $("#fmsg").textContent = "";
  };
  $("#fgo").onclick = async (e) => {
    const text = $("#ft").value.trim(); if (text.length < 8) return toast("Write a little more first", "error");
    e.target.disabled = true; $("#fmsg").textContent = "Posting…";
    try { await call("feedPost", { text, photos, kind }); $("#ft").value = ""; photos = []; drawPics(); $("#fc").textContent = "0 / 500"; toast("Posted to the feed 🎉"); load(); }
    catch (x) { const m = String(x.message || ""); toast(m.replace(/^NO_PIN:/, ""), "error"); if (/^NO_PIN:/.test(m)) $("#fstat").scrollIntoView({ behavior: "smooth" }); }
    e.target.disabled = false; $("#fmsg").textContent = "";
  };
  async function load() {
    try { info = await call("feedMine", {}); } catch (x) { $("#fstat").innerHTML = `<p class="small">${esc(x.message)}</p>`; return; }
    const D = info.discover || {};
    $("#fstat").innerHTML = !Number.isFinite(D.lat)
      ? `<h3 style="margin:0 0 4px">📍 Add your map pin to show up in Explore</h3><p class="small muted" style="margin:0 0 10px">Customers search by place (“near me”, “Tagaytay”). Paste your Google Maps link in Settings → Contact${store.mode === "salon" ? ", or set a home-service base pin" : ""}.</p><a class="btn sm" href="#settings">Open Settings</a>`
      : `<div class="row between wrap" style="gap:10px"><div><h3 style="margin:0 0 4px">${D.listed ? "✅ You're in Explore" : "⏸ Not shown in Explore yet"}</h3>
        <p class="small muted" style="margin:0">${D.listed ? `People within <b>${D.reachKm} km</b>${D.home ? " (your home-service area)" : ""} see you${(D.niches || []).length ? ` when they look for <b>${D.niches.map((k) => esc(info.niches[k] || k)).join(", ")}</b>` : ""}.` : "Turn your page on (it's still “coming soon”) to be listed."}</p></div>
        <div class="small"><b>${info.used}${info.limit ? ` of ${info.limit}` : ""}</b> posts this month${info.limit ? ` · <a href="#billing">Pro: unlimited</a>` : ""}</div></div>
        <a class="small" href="/explore/" target="_blank" rel="noopener">See Explore as a customer →</a>`;
    $("#fl").innerHTML = info.posts.length ? info.posts.map((p) => `<div class="item" style="grid-template-columns:auto 1fr auto"><div class="thumb">${p.photos?.[0] ? `<img src="${esc(p.photos[0])}" alt=""/>` : "📣"}</div>
      <div class="info"><div class="n">${(KINDS.find((k) => k[0] === p.kind) || KINDS[0])[1]} <span class="muted small">· ${ago(p.createdAt)}</span></div><div class="d small">${esc(p.text.slice(0, 160))}${p.text.length > 160 ? "…" : ""}</div></div>
      <span class="acts"><button data-del="${p.id}">🗑</button></span></div>`).join("") : `<p class="small muted">No posts yet. Your first one takes 30 seconds ✨</p>`;
    $("#fl").querySelectorAll("[data-del]").forEach((b) => (b.onclick = async () => { if (!(await confirmDialog("Delete this post?"))) return; try { await call("feedDelete", { id: b.dataset.del }); load(); } catch (x) { toast(x.message, "error"); } }));
  }
  load();
}
