// TapTayo service worker
// 1) Image cache: menu/service photos are saved on the phone after the first load and shown
//    instantly afterwards. A new photo has a new URL (?v=...), so changes still appear.
// 2) Offline page: if a page can't load because there's no internet, show a friendly screen
//    instead of the browser error (needed for a proper installed app).
const CACHE = "tt-img-v1";
const SHELL = "tt-shell-v2";
const ASSETS = "tt-assets-v1";   // /assets/* files have a hash in their name → safe to keep forever
const MAX = 300;
const OFFLINE = "/offline.html";
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll([OFFLINE])).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith("tt-shell-") && k !== SHELL) await caches.delete(k);
  // keep the assets cache small: drop entries not used by the current pages after a while
  try { const c = await caches.open(ASSETS); const keys = await c.keys(); if (keys.length > 120) for (const k of keys.slice(0, keys.length - 120)) await c.delete(k); } catch {}
  await self.clients.claim();
})()));
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // App pages: try the network (4 s), else the last copy saved on the phone, else the offline page.
  if (req.mode === "navigate" && url.origin === location.origin) {
    e.respondWith((async () => {
      const cache = await caches.open(SHELL);
      const net = fetch(req).then((res) => { if (res.ok && !url.pathname.startsWith("/m/")) cache.put(url.pathname, res.clone()).catch(() => {}); return res; });
      const timeout = new Promise((r) => setTimeout(() => r(null), 4000));
      try { const res = await Promise.race([net, timeout]); if (res) return res; } catch {}
      const saved = await cache.match(url.pathname);
      if (saved) { net.catch(() => {}); return saved; }
      try { return await net; } catch { return (await caches.match(OFFLINE)) || Response.error(); }
    })());
    return;
  }
  // App code & styles (hashed file names): from the phone first, then the network
  if (url.origin === location.origin && url.pathname.startsWith("/assets/")) {
    e.respondWith((async () => {
      const cache = await caches.open(ASSETS);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    })());
    return;
  }
  const isPhoto = url.hostname === "firebasestorage.googleapis.com" && /\/o\/stores%2F/.test(url.pathname) && !/%2Fcustomer%2F/.test(url.pathname);
  if (!isPhoto) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreVary: true });
    if (hit) return hit;
    const res = await fetch(req);
    if (res && (res.ok || res.type === "opaque")) {
      cache.put(req, res.clone()).then(async () => { const keys = await cache.keys(); if (keys.length > MAX) for (const k of keys.slice(0, keys.length - MAX)) cache.delete(k); }).catch(() => {});
    }
    return res;
  })());
});

// Push notifications for staff (new job offers, pickup, help alerts) — shown even when the app is closed
self.addEventListener("push", (e) => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { title: "TapTayo", body: e.data ? e.data.text() : "" }; }
  e.waitUntil((async () => {
    await self.registration.showNotification(d.title || "TapTayo", { body: d.body || "", tag: d.tag || undefined, renotify: !!d.tag, requireInteraction: !!d.urgent || String(d.tag || "").startsWith("offer-"), icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", vibrate: d.urgent ? [400, 150, 400, 150, 400] : [250, 100, 250], data: { url: d.url || "/" } });
    try { const n = (await self.registration.getNotifications()).length; if (self.navigator.setAppBadge) await self.navigator.setAppBadge(n || 1); } catch {}
  })());
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || "/", self.location.origin).href;
  e.waitUntil((async () => {
    try { const n = (await self.registration.getNotifications()).length; if (n) await self.navigator.setAppBadge?.(n); else await self.navigator.clearAppBadge?.(); } catch {}
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const hit = wins.find((w) => w.url.startsWith(url)) || wins.find((w) => new URL(w.url).pathname.split("/")[1] === new URL(url).pathname.split("/")[1]);
    if (hit) { await hit.focus(); return; }
    await self.clients.openWindow(url);
  })());
});
