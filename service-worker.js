// ==================== fitness PWA Service Worker ====================
// Network-First for pages, Cache-First for assets

const CACHE_NAME = 'fitness-v10';
const FILES_TO_CACHE = [
  './index.html',
  './manifest.json',
  './food-database.js',
  './sync.js'
];

// ==================== INSTALL ====================
self.addEventListener('install', (event) => {
  console.log('[SW] Install');
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Caching files');
      return Promise.allSettled(
        FILES_TO_CACHE.map((url) =>
          cache.add(url).catch((err) => console.warn('[SW] Failed to cache:', url, err))
        )
      );
    })
  );
  self.skipWaiting();
});

// ==================== ACTIVATE ====================
self.addEventListener('activate', (event) => {
  console.log('[SW] Activate');
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => {
            console.log('[SW] Deleting old cache:', name);
            return caches.delete(name);
          })
      );
    })
  );
  self.clients.claim();
});

// ==================== FETCH ====================
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (!event.request.url.startsWith('http')) return;

  // 只接管本站请求。跨域请求(尤其是 sync.js 对 api.github.com 的读写)绝不能进来:
  // 缓存优先分支会把带 Authorization 的 API 请求也缓存,导致后续读到过期的 sha,
  // 同步会静默失效 —— 看起来在工作,其实一直合并的是旧数据。
  if (!event.request.url.startsWith(self.location.origin)) return;

  const isNavigation = event.request.mode === 'navigate';

  if (isNavigation) {
    // Network-First for page loads — always try to get latest version
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          // Cache the latest version for offline fallback
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put('./index.html', clone);
            });
          }
          return response;
        })
        .catch(() => {
          // Offline — serve cached version
          return caches.match('./index.html');
        })
    );
  } else {
    // Cache-First for assets
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const fetchPromise = fetch(event.request).then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, clone);
            });
          }
          return response;
        });

        // Return cached immediately, update cache in background
        return cached || fetchPromise;
      })
    );
  }
});
