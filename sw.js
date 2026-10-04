// アプリ本体をキャッシュして、電波の弱いジムでも開けるようにする。
// ファイルを更新したら CACHE の番号を上げること(古いキャッシュが破棄される)。
const CACHE = 'gymlog-v17';
const ASSETS = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'cloud.js',
  'firebase-config.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ネットから最新を取得する(4秒でタイムアウト)。取れないとき(オフライン・電波が弱い)だけ保存版を使う。
// こうすると、更新したファイルが次の起動ですぐ反映される。
const TIMEOUT_MS = 4000;

async function networkFirst(req, sameOrigin) {
  const cache = await caches.open(CACHE);
  try {
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS));
    // 同一オリジンは no-cache で、ブラウザのHTTPキャッシュに残った古い版を避ける
    const res = await Promise.race([sameOrigin ? fetch(req.url, { cache: 'no-cache' }) : fetch(req), timeout]);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // Firebase SDK (gstatic) も保存して、オフラインでも起動できるようにする
  const isSdk = url.origin === 'https://www.gstatic.com' && url.pathname.startsWith('/firebasejs/');
  const sameOrigin = url.origin === self.location.origin;
  if (req.method !== 'GET' || (!sameOrigin && !isSdk)) return;
  e.respondWith(networkFirst(req, sameOrigin));
});
