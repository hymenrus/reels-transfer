const CACHE = 'reelflow-static-v11';
const SHELL_ASSETS = ['./manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png', './apple-touch-icon.png', './assets/abstract-purple-blue.jpg'];
const OFFLINE_HTML = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#10111a"><title>ReelFlow · Bağlantı yok</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#10111a;color:#f4f3fb;font:16px/1.6 system-ui,sans-serif;padding:24px;box-sizing:border-box}main{max-width:460px;padding:32px;border:1px solid #ffffff20;border-radius:20px;background:#1a1b28}h1{font-size:1.6rem;margin:0 0 12px}p{color:#c5c3d2;margin:0}</style></head><body><main><h1>İnternet bağlantısı yok</h1><p>ReelFlow kuyruk ve paylaşım durumunu buluttan kontrol eder. İnternete bağlanınca bu sayfayı yenile.</p></main></body></html>`;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const page = await fetch('./', { cache: 'reload' });
    if (!page.ok) throw new Error('ReelFlow sayfası önbelleğe alınamadı.');
    await cache.put('./', page.clone());
    await cache.addAll(SHELL_ASSETS);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        // Bypass the browser HTTP cache so a stale index cannot reference removed hashed assets.
        const response = await fetch(request.url, { cache: 'no-store', credentials: 'same-origin' });
        if (response.ok) {
          const cache = await caches.open(CACHE);
          await cache.put('./', response.clone());
        }
        return response;
      } catch {
        return (await caches.match('./')) || new Response(OFFLINE_HTML, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      }
    })());
    return;
  }

  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(request, copy));
    }
    return response;
  }).catch(() => new Response('Bu dosya çevrimdışı önbellekte yok.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  }))));
});
