// 旅の記録 — オフラインでも開けるようにアプリ本体を保存しておく
const VERSION = 'v3';
const SHELL = `shell-${VERSION}`;
const TILES = 'tiles-v1';
const ASSETS = [
  './', './index.html', './style.css', './app.js', './manifest.webmanifest',
  './icons/icon.svg', './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k !== SHELL && k !== TILES).map(k => caches.delete(k))
  )).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // GitHubと地名検索は毎回取りに行く（保存しない）
  if (url.hostname === 'api.github.com' || url.hostname.endsWith('nominatim.openstreetmap.org')) return;

  // 地図タイル：一度見た場所は保存しておく
  if (url.hostname.endsWith('basemaps.cartocdn.com')) {
    e.respondWith(caches.open(TILES).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }));
    return;
  }

  // アプリ本体：保存分をすぐ出し、裏で新しいものに入れ替える
  if (url.origin === location.origin || url.hostname === 'unpkg.com') {
    e.respondWith(caches.open(SHELL).then(async c => {
      const hit = await c.match(req, { ignoreSearch: true });
      const net = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
  }
});
