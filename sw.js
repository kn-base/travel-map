// 旅の記録 — オフラインでも開けるようにアプリ本体を保存しておく
const VERSION = 'v15';
const SHELL = `shell-${VERSION}`;
const ASSETS = [
  './', './index.html', './style.css', './app.js', './manifest.webmanifest',
  './icons/icon.svg', './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/maplibre-gl@5.9.0/dist/maplibre-gl.css',
  'https://unpkg.com/maplibre-gl@5.9.0/dist/maplibre-gl.js',
  'https://unpkg.com/@maplibre/maplibre-gl-leaflet@0.1.3/leaflet-maplibre-gl.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    // 同じ kn-base.github.io の持ち物アプリの保存分は消さない（自分の「shell-」だけ消す）
    keys.filter(k => k.startsWith('shell-') && k !== SHELL).map(k => caches.delete(k))
  )).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // GitHubと地名検索は毎回取りに行く（保存しない）
  if (url.hostname === 'api.github.com' || url.hostname.endsWith('nominatim.openstreetmap.org')) return;

  // 地図タイルは保存しない（OpenStreetMapの利用ルールに合わせ、ブラウザの通常のキャッシュに任せる）
  if (url.hostname === 'tile.openstreetmap.org' || url.hostname.endsWith('openfreemap.org')) return;

  // アプリ本体：保存分をすぐ出し、裏で新しいものに入れ替える
  if (url.origin === location.origin || url.hostname === 'unpkg.com') {
    e.respondWith(caches.open(SHELL).then(async c => {
      const hit = await c.match(req, { ignoreSearch: true });
      const net = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
  }
});
