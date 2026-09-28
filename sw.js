// 画面の部品を端末に保存し、電波がなくてもアプリを開けるようにする
const CACHE = "kokuyurin-photo-v2";
const SHELL = ["./", "index.html", "app.js", "config.js", "manifest.webmanifest", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return; // 送信は触らない
  // 山間部の弱い電波でも待たされないよう、保存済みをすぐ表示し、裏で最新に更新する
  e.respondWith(
    caches.open(CACHE).then((c) => c.match(req, { ignoreSearch: true }).then((cached) => {
      const net = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => null);
      return cached || net.then((r) => r || c.match("index.html"));
    }))
  );
});
