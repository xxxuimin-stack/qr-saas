// Private customer files ("priv:stores/…/private/…") are fetched through the privateFile Cloud Function.
// Templates render <img data-priv="…"> or <a data-priv="…">; call hydratePrivate(root) after rendering.
// Old records that still hold a public download URL keep working.
import { call } from "./firebase.js";

const cache = new Map(); // path -> blob URL
export const isPriv = (v) => typeof v === "string" && v.startsWith("priv:");

export async function privateUrl(v, orderId) {
  if (!isPriv(v)) return v;
  if (cache.has(v)) return cache.get(v);
  const r = await call("privateFile", { path: v, ...(orderId ? { orderId } : {}) });
  const bin = atob(r.base64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: r.contentType }));
  cache.set(v, url);
  return url;
}

/** Fill every [data-priv] in root: <img> gets src, <a> gets href (opens in a new tab). */
export function hydratePrivate(root = document) {
  root.querySelectorAll("[data-priv]").forEach(async (el) => {
    const v = el.dataset.priv; const oid = el.dataset.privOrder; delete el.dataset.priv;
    if (!isPriv(v)) { if (el.tagName === "IMG") el.src = v; else el.href = v; return; }
    if (el.tagName === "A") {
      el.href = "#"; el.onclick = async (e) => { e.preventDefault(); el.style.opacity = ".6"; try { window.open(await privateUrl(v, oid), "_blank"); } catch (x) { alert(x.message); } el.style.opacity = ""; };
      return;
    }
    try { el.src = await privateUrl(v, oid); } catch { el.alt = "Not available"; el.style.opacity = ".4"; }
  });
}

/** Open a private file (or plain URL) in a new tab. */
export async function openPrivate(v) { window.open(await privateUrl(v), "_blank"); }

export const PRIVACY_NOTE = "Seen only by the store staff · deleted automatically after 90 days · never shown publicly.";
