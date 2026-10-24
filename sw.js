'use strict';

/* Service Worker：预缓存全部静态资源，断网也能完整游玩（摆摊/现场兜底）
 * 注意：改动任何静态资源时把 CACHE 版本号 +1，否则老设备拿不到新版本。 */
const CACHE = 'malou-v10';
const ASSETS = [
  './',
  'index.html',
  'style.css',
  'manifest.webmanifest',
  'icon.svg', 'icon-192.png', 'icon-512.png',
  'js/util.js', 'js/config.js', 'js/voice.js', 'js/sfx.js',
  'js/world.js', 'js/game.js', 'js/render.js', 'js/ui.js', 'js/bridge.js', 'js/main.js',
  'linx.js', 'opus-decoder.min.js',
  'assets/meme-office-monkey.jpg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
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
  // HTML 导航 network-first：改版立即生效（断网回落缓存）；其余资源按完整 URL（含 ?v=）cache-first
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put('index.html', res.clone()));
          return res;
        })
        .catch(() => caches.match('index.html', { ignoreSearch: true }))
    );
    return;
  }
  // 不能 ignoreSearch 命中：旧缓存里的 game.js 会冒充 game.js?v=新版，改版后首开跑旧代码
  e.respondWith(
    caches.match(e.request).then((hit) => {
      if (hit) return hit;
      return fetch(e.request).then((res) => {
        if (res.ok && new URL(e.request.url).origin === location.origin) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(e.request, { ignoreSearch: true })
        .then((old) => old || caches.match('./', { ignoreSearch: true })));
    })
  );
});
