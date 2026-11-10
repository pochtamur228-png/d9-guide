/* D9 Справочник — офлайн-режим.
 * Страница и файлы приложения: сначала сеть (чтобы обновления приходили сразу), без сети — сохранённая копия.
 * Библиотеки и шрифты: сохранённая копия сразу, в фоне обновляем.
 * Картинки и плитки карты: из кэша, если уже открывались (храним не больше ~600 штук).
 * Общая база и территории (GET): сеть, без сети — последний ответ. Отправка данных (POST) — только сеть.
 */
const V = "d9-v3";
const APP = V + "-app", LIB = V + "-lib", IMG = V + "-img", DATA = V + "-data";
const CORE = ["./", "index.html", "assets/icon-32.png", "assets/icon-180.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(APP).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => !k.startsWith(V)).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

async function networkFirst(req, cacheName) {
  const c = await caches.open(cacheName);
  try {
    const r = await fetch(req);
    if (r.ok) c.put(req, r.clone());
    return r;
  } catch (e) {
    const hit = await c.match(req, {ignoreSearch: req.mode === "navigate"});
    if (hit) return hit;
    if (req.mode === "navigate") { const idx = await c.match("index.html"); if (idx) return idx; }
    throw e;
  }
}
async function staleWhileRevalidate(req, cacheName) {
  const c = await caches.open(cacheName);
  const hit = await c.match(req);
  const net = fetch(req).then(r => { if (r.ok || r.type === "opaque") c.put(req, r.clone()); return r; }).catch(() => hit);
  return hit || net;
}
let trimTimer = null;
async function cacheFirst(req, cacheName) {
  const c = await caches.open(cacheName);
  const hit = await c.match(req);
  if (hit) return hit;
  const r = await fetch(req);
  if (r.ok || r.type === "opaque") {
    c.put(req, r.clone());
    clearTimeout(trimTimer);
    trimTimer = setTimeout(async () => { const keys = await c.keys(); for (const k of keys.slice(0, Math.max(0, keys.length - 600))) await c.delete(k); }, 5000);
  }
  return r;
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const u = new URL(req.url);
  if (u.origin === location.origin) return e.respondWith(networkFirst(req, APP));
  if (/(^|\.)cdnjs\.cloudflare\.com$|fonts\.(googleapis|gstatic)\.com$|^telegram\.org$/.test(u.hostname)) return e.respondWith(staleWhileRevalidate(req, LIB));
  if (/(^|\.)d9-rp\.com$/.test(u.hostname) && /\.(png|jpe?g|webp)$/i.test(u.pathname)) return e.respondWith(cacheFirst(req, IMG));
  if (u.hostname.endsWith(".supabase.co") || u.hostname.endsWith(".workers.dev")) return e.respondWith(networkFirst(req, DATA));
});
