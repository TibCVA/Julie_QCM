/* Service Worker — Julie la championne (rev. 2025-08-13b)
   - Pré-cache les assets principaux + JSON
   - Cache-first pour statiques / Stale-While-Revalidate pour JSON
   - Compatible GitHub Pages (chemins relatifs)
*/
const CACHE = 'julie-cache-v11';

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  // Data (disponible hors-ligne)
  './data/annales_qcm_2020_2024_enrichi.json',
  './data/qcm_actualites_2024Q4.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => k !== CACHE ? caches.delete(k) : Promise.resolve()))
    ).then(() => self.clients.claim())
  );
});

async function staleWhileRevalidate(event){
  const cache = await caches.open(CACHE);
  const cached = await cache.match(event.request, { ignoreSearch:true });
  const fetchPromise = fetch(event.request)
    .then(res => { cache.put(event.request, res.clone()); return res; })
    .catch(() => cached || Promise.reject('offline'));
  return cached || fetchPromise;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  if (url.pathname.endsWith('.json')){
    event.respondWith(staleWhileRevalidate(event));
    return;
  }

  event.respondWith(
    caches.match(req, { ignoreSearch:true })
      .then(hit => hit || fetch(req))
  );
});