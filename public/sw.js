/* Crude Maps service worker: keeps the app and location list working with weak or no signal.
   Bump VERSION whenever files change so phones pick up the new copy. */
const VERSION = 'crude-maps-v3';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './locations.js',
  './config.js',
  './manifest.webmanifest',
  './fonts/overpass-400.woff2',
  './fonts/overpass-600.woff2',
  './fonts/overpass-800.woff2',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './brand/pin.png',
  './brand/wordmark.png'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Google Maps and other sites go straight to the network
  event.respondWith(networkFirst(req));
});

// Try the network first (so updates arrive), but fall back to the saved copy if the signal is slow or gone.
async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  const net = fetch(req).then(res => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  });
  net.catch(() => {});
  const slow = new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), 3500));
  try {
    return await Promise.race([net, slow]);
  } catch (e) {
    const hit = (await cache.match(req, { ignoreSearch: true })) ||
      (req.mode === 'navigate' ? await cache.match('./index.html') : undefined);
    if (hit) return hit;
    return net;
  }
}
