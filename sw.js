// Permite instalar la app y abrirla aunque la señal esté mala.
// Siempre intenta la versión más nueva de la red; si no hay internet, usa la guardada.
const CACHE = 'racha-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || req.url.includes('supabase.co')) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && (req.url.startsWith(self.location.origin) || req.url.includes('cdn.jsdelivr.net'))) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req)),
  );
});
