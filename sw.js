/* Service Worker — Julie la championne (rev. 2025-08-13e)
   - Pré-cache les assets principaux + JSON
   - Cache-first pour statiques / Stale-While-Revalidate pour JSON
   - Compatible GitHub Pages (chemins relatifs)
   - ✨ JSON: on ne "ignore" plus la querystring pour permettre un bust propre
*/
const CACHE = 'julie-cache-v13';

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

async function staleWhileRevalidateJSON(request){
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request /* pas d'ignoreSearch */);
  try {
    const network = await fetch(request);
    if (network && network.ok) cache.put(request, network.clone());
    return cached || network;
  } catch (err) {
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  if (url.pathname.endsWith('.json')){
    event.respondWith(staleWhileRevalidateJSON(req));
    return;
  }

  // Statiques : cache first (ignoreSearch pour ne pas dupliquer)
  event.respondWith(
    caches.match(req, { ignoreSearch:true })
      .then(hit => hit || fetch(req))
  );
});