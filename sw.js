// ERP Hero · Service Worker
// Minimaler SW fuer PWA-Installierbarkeit + Network-first mit Offline-Fallback.
// Bewusst klein gehalten — die App lebt von Live-Daten (Airtable, Freshdesk),
// daher kein aggressives Caching von API-Calls. Nur Shell (HTML/JS-CDNs) wird
// optional bei wiederholten Aufrufen schneller dank Browser-Cache.

const SW_VERSION = 'erp-hero-sw-v1';

self.addEventListener('install', (event) => {
  // Sofort aktivieren — keine Wartezeit auf alten Worker
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Alte Caches aufraeumen (falls jemals welche entstanden sind)
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
