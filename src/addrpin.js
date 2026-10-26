// Address with a map pin — like Grab: the pin stays in the middle, you drag the map under it.
//  • "📍 Use my current location" (automatic when the phone already allowed location)
//  • search a place ("SM Tagaytay", "Brgy. San Roque, Antipolo")
//  • the address line fills in by itself from the pin (you can still edit it) + a landmark
// Keeps the field names the forms already read: [data-address] [data-landmark] [data-map] (Google Maps link with the coordinates).
// Map: Leaflet + OpenStreetMap (free). Loaded only when a pin box is on screen.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const MANILA = { lat: 14.5995, lng: 120.9842 };
/** coordinates inside a maps link (…?q=lat,lng · …@lat,lng · …ll=lat,lng) */
export const parsePin = (url) => { const m = /(?:q=|@|ll=|query=)(-?\d{1,2}\.\d+),\s*(-?\d{1,3}\.\d+)/.exec(String(url || "")); return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null; };
export const pinUrl = (lat, lng) => `https://maps.google.com/?q=${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}`;

let L = null;
async function leaflet() {
  if (L) return L;
  const [m] = await Promise.all([import("leaflet"), import("leaflet/dist/leaflet.css")]);
  return (L = m.default || m);
}
function css() {
  if (document.getElementById("tt-pin-css")) return;
  const s = document.createElement("style"); s.id = "tt-pin-css";
  s.textContent = `.pin-box{margin:4px 0 8px}.pin-map{position:relative;height:190px;border-radius:14px;overflow:hidden;background:#E8EEF3;border:1px solid #E5E7EB;isolation:isolate}
  .pin-map .leaflet-container{height:100%;width:100%;font:inherit}.pin-center{position:absolute;left:50%;top:50%;z-index:500;transform:translate(-50%,-100%);font-size:34px;line-height:1;pointer-events:none;filter:drop-shadow(0 4px 3px rgba(0,0,0,.3));transition:transform .15s}
  .pin-map.moving .pin-center{transform:translate(-50%,-118%)}.pin-dot{position:absolute;left:50%;top:50%;z-index:499;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:50%;background:rgba(0,0,0,.35);pointer-events:none}
  .pin-me{position:absolute;z-index:600;right:8px;bottom:8px;border:0;background:#fff;color:#111;font-weight:700;font-size:13px;padding:8px 12px;border-radius:999px;box-shadow:0 2px 10px rgba(0,0,0,.18);cursor:pointer}
  .pin-me.big{left:50%;right:auto;bottom:50%;transform:translate(-50%,50%);font-size:15px;padding:12px 18px}
  .pin-find{display:flex;gap:6px;margin:0 0 6px}.pin-find input{flex:1}.pin-res{border:1px solid #E5E7EB;border-radius:12px;background:#fff;margin:-2px 0 8px;overflow:hidden}
  .pin-res button{display:block;width:100%;text-align:left;border:0;border-top:1px solid #F1F2F4;background:#fff;padding:9px 12px;font:inherit;font-size:13px;cursor:pointer}.pin-res button:first-child{border-top:0}
  .pin-hint{font-size:12px;color:#6B7280;margin:4px 2px 0}.pin-ok{color:#15803D;font-weight:600}`;
  document.head.appendChild(s);
}

/** the HTML (put it where the address fields were) */
export function pinBlock(v = {}, { who = "we", required = true, landmark = true, search = true, btn = "c-btn ghost sm" } = {}) {
  return `<div class="pin-box" data-pinbox data-req="${required ? 1 : 0}">
    ${search ? `<div class="pin-find"><input data-pinq placeholder="Search a place or barangay" autocomplete="off"/><button type="button" class="${btn}" data-pinfind>Search</button></div><div class="pin-res" data-pinres hidden></div>` : ""}
    <div class="pin-map" data-pinmap><span class="pin-center">📍</span><span class="pin-dot"></span><button type="button" class="pin-me ${v.mapUrl ? "" : "big"}" data-pinme>📍 Use my current location</button></div>
    <div class="pin-hint" data-pinhint>${v.mapUrl ? `<span class="pin-ok">✓ Pin set</span> · drag the map to move it` : `Move the map so the pin is on your door — so ${esc(who)} can find you.`}</div>
    <input type="hidden" data-map value="${esc(v.mapUrl || "")}"/>
    <label>Address</label><input data-address placeholder="House no., street, barangay, city" value="${esc(v.address || "")}" autocomplete="street-address"/>
    ${landmark ? `<label>Landmark <span class="muted small">(optional)</span></label><input data-landmark placeholder="e.g. green gate beside the sari-sari store" value="${esc(v.landmark || "")}"/>` : ""}
  </div>`;
}

/** make every pin box inside root work. onChange({ address, landmark, mapUrl, lat, lng }) */
export function wirePin(root, { onChange } = {}) {
  css();
  root.querySelectorAll("[data-pinbox]").forEach((box) => {
    if (box._pin) return; box._pin = true;
    const q = (s) => box.querySelector(s);
    const mapEl = q("[data-pinmap]"), hint = q("[data-pinhint]"), hid = q("[data-map]"), addr = q("[data-address]"), me = q("[data-pinme]");
    let map = null, typed = !!addr.value, geoT = 0, lastGeo = "";
    addr.addEventListener("input", () => { typed = !!addr.value.trim(); });
    const emit = () => onChange?.({ address: addr.value.trim(), landmark: q("[data-landmark]")?.value.trim() || "", mapUrl: hid.value, ...(parsePin(hid.value) || {}) });
    q("[data-landmark]")?.addEventListener("change", emit); addr.addEventListener("change", emit);
    const setPin = (lat, lng, { fly = false, from = "" } = {}) => {
      hid.value = pinUrl(lat, lng); me.classList.remove("big");
      hint.innerHTML = `<span class="pin-ok">✓ Pin set</span>${from ? ` · ${esc(from)}` : ""} · drag the map to move it`;
      if (map && fly) map.setView([lat, lng], Math.max(map.getZoom(), 17));
      clearTimeout(geoT); geoT = setTimeout(() => reverse(lat, lng), 700);
      emit();
    };
    async function reverse(lat, lng) {
      const k = `${lat.toFixed(4)},${lng.toFixed(4)}`; if (k === lastGeo || typed) return; lastGeo = k;
      try {
        const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&accept-language=en&lat=${lat}&lon=${lng}`);
        const j = await r.json(); const a = j.address || {};
        const line = [[a.house_number, a.road].filter(Boolean).join(" "), a.neighbourhood || a.quarter || a.village || a.suburb, a.city || a.town || a.municipality, a.state || a.province].filter(Boolean);
        if (!typed && line.length) { addr.value = [...new Set(line)].join(", "); emit(); }
      } catch {}
    }
    const locate = (quiet) => {
      if (!navigator.geolocation) { if (!quiet) hint.textContent = "Location isn't available on this device — search your place or drag the map."; return; }
      me.disabled = true; me.textContent = "Locating…";
      navigator.geolocation.getCurrentPosition((p) => { me.disabled = false; me.textContent = "📍 My location"; init().then(() => setPin(p.coords.latitude, p.coords.longitude, { fly: true, from: "your location" })); },
        () => { me.disabled = false; me.textContent = "📍 Use my current location"; if (!quiet) hint.textContent = "Location is blocked — allow it in your browser, or search your place / drag the map."; },
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
    };
    me.onclick = () => locate(false);
    async function init() {
      if (map) return map;
      const Lf = await leaflet();
      const start = parsePin(hid.value) || MANILA;
      map = Lf.map(mapEl, { zoomControl: false, attributionControl: true }).setView([start.lat, start.lng], parsePin(hid.value) ? 17 : 11); map.attributionControl.setPrefix(false);
      Lf.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(map);
      map.on("movestart", () => mapEl.classList.add("moving"));
      map.on("moveend", () => { mapEl.classList.remove("moving"); if (map._userMoved) { const c = map.getCenter(); setPin(c.lat, c.lng); } });
      map.on("dragstart zoomstart", () => { map._userMoved = true; });
      return map;
    }
    // search a place (Philippines first)
    const res = q("[data-pinres]");
    const find = async () => {
      const t = q("[data-pinq]").value.trim(); if (t.length < 3) return;
      res.hidden = false; res.innerHTML = `<button type="button" disabled>Searching…</button>`;
      try {
        const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=ph&accept-language=en&q=${encodeURIComponent(t)}`);
        const L5 = await r.json();
        res.innerHTML = L5.length ? L5.map((x, i) => `<button type="button" data-i="${i}">${esc(x.display_name)}</button>`).join("") : `<button type="button" disabled>No place found — try a barangay or landmark</button>`;
        res.querySelectorAll("[data-i]").forEach((b) => (b.onclick = async () => { const x = L5[Number(b.dataset.i)]; res.hidden = true; await init(); if (!typed) { addr.value = x.display_name.split(",").slice(0, 4).join(",").trim(); } setPin(Number(x.lat), Number(x.lon), { fly: true, from: "drag to your exact door" }); }));
      } catch { res.innerHTML = `<button type="button" disabled>Search isn't available right now</button>`; }
    };
    q("[data-pinfind]")?.addEventListener("click", find);
    q("[data-pinq]")?.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); find(); } });
    // start the map when the box is visible; use the location right away if the phone already allowed it
    const go = async () => {
      await init(); setTimeout(() => map.invalidateSize(), 50);
      if (!hid.value) { try { const p = await navigator.permissions?.query({ name: "geolocation" }); if (p?.state === "granted") locate(true); } catch {} }
    };
    if ("IntersectionObserver" in window) { const io = new IntersectionObserver((en) => { if (en.some((e) => e.isIntersecting)) { io.disconnect(); go(); } }); io.observe(mapEl); } else go();
  });
}

/** read the values of the first pin box in root */
export function readPin(root) {
  const box = root.querySelector("[data-pinbox]"); if (!box) return null;
  const mapUrl = box.querySelector("[data-map]").value;
  return { address: box.querySelector("[data-address]").value.trim(), landmark: box.querySelector("[data-landmark]")?.value.trim() || "", mapUrl, ...(parsePin(mapUrl) || {}) };
}

/** for staff / riders: address + landmark + Google Maps / Waze buttons */
export function pinLinks(c, cls = "k-btn sm") {
  if (!c) return "";
  const p = parsePin(c.mapUrl);
  const gm = c.mapUrl || (c.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.address)}` : "");
  return [gm ? `<a class="${cls}" target="_blank" rel="noopener" href="${esc(gm)}">🗺 ${p ? "Pin" : "Maps"}</a>` : "", p ? `<a class="${cls}" target="_blank" rel="noopener" href="https://waze.com/ul?ll=${p.lat},${p.lng}&navigate=yes">🚗 Waze</a>` : ""].join("");
}

/** wire pin boxes automatically whenever a form with one appears (sheets, re-renders) */
let watching = false;
export function autoWirePins(onChange) {
  if (watching) return; watching = true;
  const run = () => { if (document.querySelector("[data-pinbox]:not([data-pinwired])")) document.querySelectorAll("[data-pinbox]:not([data-pinwired])").forEach((b) => { b.setAttribute("data-pinwired", ""); wirePin(b.parentElement || document, { onChange }); }); };
  new MutationObserver(run).observe(document.body, { childList: true, subtree: true }); run();
}

/** 📍 shop address + Directions (Google Maps) — right under the name */
export function whereLine(st) {
  const c = st?.contact || {}; const url = /^https:\/\//.test(c.mapUrl || "") ? c.mapUrl : c.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.address + (st.name ? " " + st.name : ""))}` : "";
  if (!c.address && !url) return "";
  return `<a class="ci-where" href="${esc(url)}" target="_blank" rel="noopener"><span>📍 ${esc(c.address || "See on the map")}</span><b>Directions</b></a>`;
}
