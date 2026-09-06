/**
 * Service Worker：装到手机桌面后，断网也能玩单机（联机仍需网络）
 *
 * 策略：
 *   · 页面导航：网络优先（保证更新能拿到），断网回退缓存
 *   · 静态资源（js/css/图标）：缓存优先 + 后台静默更新（stale-while-revalidate）
 *   · 版本号 CACHE 变了 → activate 时自动清掉旧缓存
 */
const CACHE = 'wushik-v1';
const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './src/core/cards.js',
  './src/core/rules.js',
  './src/core/combo.js',
  './src/core/engine.js',
  './src/core/ai.js',
  './src/net/local.js',
  './src/net/mqtt.js',
  './src/net/ws.js',
  './src/ui/render.js',
  './src/ui/app.js',
  './src/ui/sound.js',
  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // 只管自己的静态资源

  // 页面导航：网络优先，断网回退到缓存的 index.html
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((r) => {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy));
          return r;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // 其它资源：缓存优先，后台更新
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const net = fetch(e.request)
        .then((r) => {
          if (r && r.ok) {
            const copy = r.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return r;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});
