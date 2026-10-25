// Image upload to Firebase Storage, with client-side resize to keep files fast and small
import { storage } from "./firebase.js";
import { ref, uploadBytesResumable, getDownloadURL } from "firebase/storage";

// ---- upload progress: a floating pill shows "Uploading photo… 42%" for every upload in progress ----
const live = new Map(); let nUp = 0;
function pill() {
  let el = document.getElementById("upPill");
  if (!el) { el = document.createElement("div"); el.id = "upPill"; el.setAttribute("role", "status"); el.style.cssText = "position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:9999;background:#1e1b2e;color:#fff;padding:10px 16px;border-radius:999px;font:600 14px system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25);display:none;align-items:center;gap:10px;white-space:nowrap"; document.body.appendChild(el); }
  return el;
}
function drawPill(doneMsg) {
  const el = pill();
  if (doneMsg) { el.innerHTML = doneMsg; el.style.display = "flex"; clearTimeout(el._t); el._t = setTimeout(() => { if (!live.size) el.style.display = "none"; }, 2200); return; }
  if (!live.size) { el.style.display = "none"; return; }
  const pct = Math.round([...live.values()].reduce((a, b) => a + b, 0) / live.size);
  el.innerHTML = `<span style="width:14px;height:14px;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;border-radius:50%;display:inline-block;animation:upspin .8s linear infinite"></span>Uploading ${live.size > 1 ? live.size + " photos" : "photo"}… ${pct}%<style>@keyframes upspin{to{transform:rotate(360deg)}}</style>`;
  el.style.display = "flex";
}
/** uploadBytes with progress (shown in the pill and passed to onProgress) */
export function uploadBytes(r, blob, meta, onProgress) {
  const id = ++nUp; live.set(id, 0); drawPill();
  return new Promise((resolve, reject) => {
    const task = uploadBytesResumable(r, blob, meta);
    task.on("state_changed", (s) => { const p = s.totalBytes ? (s.bytesTransferred / s.totalBytes) * 100 : 0; live.set(id, p); drawPill(); onProgress?.(Math.round(p)); },
      (e) => { live.delete(id); drawPill(`⚠️ Upload failed — ${e.code === "storage/unauthorized" ? "no permission" : "check your internet"}`); reject(e); },
      () => { live.delete(id); live.size ? drawPill() : drawPill("✓ Photo uploaded"); resolve(task.snapshot); });
  });
}
/** true while any upload is still running */
export const uploading = () => live.size > 0;

let webpOK = null;
function canWebp() { if (webpOK === null) { try { webpOK = document.createElement("canvas").toDataURL("image/webp").startsWith("data:image/webp"); } catch { webpOK = false; } } return webpOK; }

/** Resize the image file to a max dimension (px) and encode as a WebP (or JPEG/PNG fallback) blob */
export function resizeImage(file, max = 1200, quality = 0.85, { webp = false } = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      const keepPng = file.type === "image/png" && max <= 600; // logo with transparency
      const type = keepPng ? "image/png" : webp && canWebp() ? "image/webp" : "image/jpeg";
      c.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not process the image"))), type, quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Invalid image file")); };
    img.src = url;
  });
}

/**
 * uploadImage(storeId, "logo" | "cover" | "items/<id>", file, { max })
 * returns download URL
 */
export async function uploadImage(storeId, name, file, { max = 1200 } = {}) {
  if (!file.type.startsWith("image/")) throw new Error("Image files only (JPG/PNG).");
  const blob = await resizeImage(file, max);
  const ext = blob.type === "image/png" ? "png" : "jpg";
  const path = `stores/${storeId}/${name}.${ext}`;
  const r = ref(storage, path);
  await uploadBytes(r, blob, { contentType: blob.type, cacheControl: "public,max-age=31536000" });
  const url = await getDownloadURL(r);
  // cache-bust so the new image shows immediately even though the path is unchanged
  return url + (url.includes("?") ? "&" : "?") + "v=" + Date.now();
}

/** Menu/service photo: uploads a full image (800px) + a small thumbnail (360px) for fast lists. Returns { url, thumbUrl } */
export async function uploadItemImage(storeId, id, file) {
  if (!file.type.startsWith("image/")) throw new Error("Image files only (JPG/PNG).");
  const [full, thumb] = await Promise.all([resizeImage(file, 800, 0.8, { webp: true }), resizeImage(file, 360, 0.72, { webp: true })]);
  const ext = (b) => (b.type === "image/webp" ? "webp" : b.type === "image/png" ? "png" : "jpg");
  const put = async (blob, name) => { const r = ref(storage, `stores/${storeId}/items/${name}.${ext(blob)}`); await uploadBytes(r, blob, { contentType: blob.type, cacheControl: "public,max-age=31536000" }); const u = await getDownloadURL(r); return u + (u.includes("?") ? "&" : "?") + "v=" + Date.now(); };
  const [url, thumbUrl] = await Promise.all([put(full, id), put(thumb, `${id}_t`)]);
  return { url, thumbUrl };
}

/** Customer upload (feedback photo / incident proof) — stores/{storeId}/customer/{uid}/... */
export async function uploadCustomerImage(storeId, uid, file, { max = 1200 } = {}) {
  if (!file.type.startsWith("image/")) throw new Error("Image files only (JPG/PNG).");
  const blob = await resizeImage(file, max);
  const r = ref(storage, `stores/${storeId}/customer/${uid}/${Date.now()}.jpg`);
  await uploadBytes(r, blob, { contentType: blob.type });
  return getDownloadURL(r);
}

/** Sensitive customer upload (ID, payment proof) → private folder; returns "priv:<path>" (never a public URL) */
export async function uploadPrivateImage(storeId, uid, file, { max = 1200, name = "" } = {}) {
  if (!file.type.startsWith("image/")) throw new Error("Image files only (JPG/PNG).");
  const blob = await resizeImage(file, max);
  const path = `stores/${storeId}/private/${uid}/${name || Date.now()}.jpg`;
  await uploadBytes(ref(storage, path), blob, { contentType: blob.type });
  return `priv:${path}`;
}

/** Small helper: file input with preview and upload button */
export function imageField({ label, current, onUpload, hint = "JPG or PNG, up to 3MB", shape = "square" }) {
  const el = document.createElement("div");
  el.className = "imgfield";
  el.innerHTML = `<label>${label}</label>
    <div class="row" style="align-items:flex-start">
      <div class="imgprev ${shape}">${current ? `<img src="${current}" alt=""/>` : `<span class="muted small">No image</span>`}</div>
      <div class="stack" style="flex:1">
        <input type="file" accept="image/*" />
        <p class="small muted" style="margin:0">${hint}</p>
        <div class="imgstatus small"></div>
      </div>
    </div>`;
  const input = el.querySelector("input");
  const status = el.querySelector(".imgstatus");
  input.onchange = async () => {
    const f = input.files[0];
    if (!f) return;
    status.textContent = "Uploading…";
    try {
      const url = await onUpload(f);
      el.querySelector(".imgprev").innerHTML = `<img src="${url}" alt=""/>`;
      status.textContent = "Uploaded ✓";
    } catch (e) {
      status.textContent = "Error: " + (e.message || e.code);
    }
    input.value = "";
  };
  return el;
}
