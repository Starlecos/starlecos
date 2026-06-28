const CACHE = 'starlecos-v1';
const URLS  = [
  '/starlecos-vendedora.html',
  '/starlecos-financeiro.html',
  '/manifest.json'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(URLS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Sempre busca da rede primeiro (dados em tempo real), cache como fallback
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
