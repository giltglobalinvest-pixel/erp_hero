// ERP Hero · Service Worker
// Minimaler SW fuer PWA-Installierbarkeit + Network-first mit Offline-Fallback.
// Bewusst klein gehalten — die App lebt von Live-Daten ueber den eigenen Server.
// Anfragen an /api/ und /healthz gehen immer direkt ans Netz und werden nie
// gespeichert; gecacht wird nur die App-Shell (index.html) fuer den Offline-Fall.

const SW_VERSION = 'erp-hero-sw-v2';

self.addEventListener('install', (event) => {
  // Sofort aktivieren — keine Wartezeit auf alten Worker
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Alte Caches aufraeumen — v1 hat auch API-Antworten gespeichert
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k !== SW_VERSION).map((k) => caches.delete(k))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch-Handler: Network-first fuer alles. Wenn das Netz ausfaellt + es einen
// Cache-Eintrag gibt, geben wir den. Dieser Handler ist primaer fuer die
// PWA-Installability noetig — Chrome verlangt einen fetch-Listener.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Nur same-origin Requests + GET
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // API und Healthcheck nie abfangen: Die Antworten gehoeren zu einer Sitzung und sind Live-Daten.
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return;

  event.respondWith(
    fetch(req).then((res) => {
      // Erfolgreichen Response cachen (best-effort, schluckt Fehler)
      if (res && res.status === 200 && res.type === 'basic') {
        const copy = res.clone();
        caches.open(SW_VERSION).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => {
      return caches.match(req).then((cached) => cached || new Response('Offline', { status: 503, statusText: 'Offline' }));
    })
  );
});
