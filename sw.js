// 오프라인에서도 앱이 열리도록 화면 파일을 캐시. 사진은 IndexedDB에 있으므로 여기서 다루지 않음.
const CACHE = 'vb-v1';
const ASSETS = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'vendor/Sortable.min.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 인터넷이 되면 최신 파일, 안 되면(또는 3초 넘게 느리면) 저장해둔 파일
function networkFirst(req) {
  return caches.open(CACHE).then(cache => {
    const net = fetch(req).then(res => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    });
    const fallback = () => cache.match(req, { ignoreSearch: true })
      .then(r => r || (req.mode === 'navigate' ? cache.match('index.html') : undefined))
      .then(r => r || net);
    const timeout = new Promise(resolve => setTimeout(resolve, 3000)).then(fallback);
    return Promise.race([net.catch(fallback), timeout]);
  });
}

// 글꼴은 한 번 받으면 계속 사용
function cacheFirst(req) {
  return caches.open(CACHE).then(cache => cache.match(req).then(hit => hit || fetch(req).then(res => {
    if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
    return res;
  })));
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) e.respondWith(networkFirst(req));
  else if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname)) e.respondWith(cacheFirst(req));
});
