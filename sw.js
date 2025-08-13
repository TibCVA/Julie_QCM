const CACHE = 'julie-v2.1';
const ASSETS = [
  './', './index.html', './styles.css', './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png',
  // Data (si tu veux tout hors-ligne, ajoute-les ici ; sinon on les cache à la volée)
  './data/annales_qcm_2020_2024_enrichi.json',
  './data/qcm_actualites_2024Q4.json'
];

self.addEventListener('install', e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)));
});
self.addEventListener('activate', e=>{
  e.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
  );
});
self.addEventListener('fetch', e=>{
  const req = e.request;
  // Cache-then-network pour JSON, cache-first pour statiques
  if(req.url.endsWith('.json')){
    e.respondWith(
      fetch(req).then(res=>{
        const clone = res.clone();
        caches.open(CACHE).then(c=>c.put(req, clone));
        return res;
      }).catch(()=>caches.match(req))
    );
  }else{
    e.respondWith(caches.match(req).then(cached=> cached || fetch(req)));
  }
});
