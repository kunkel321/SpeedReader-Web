// Service worker: lets the app open and read offline.
// Network-first, so edits pushed to GitHub appear the next time you open it online.
const CACHE = 'speedreader-v9';
// vendor/pdf*.mjs is deliberately absent: it is bigger than everything here put
// together, and only a reader who opens a PDF ever needs it. The fetch handler
// below caches it the first time one is opened, after which PDFs work offline too.
const FILES = ['./', './index.html', './app.js', './epub.js', './pdftext.js',
               './guide.txt', './manifest.json', './icon-192.png', './icon-512.png',
               './fonts/carlito-400.woff2'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })
        .then(r => r || caches.match('./index.html')))
  );
});
