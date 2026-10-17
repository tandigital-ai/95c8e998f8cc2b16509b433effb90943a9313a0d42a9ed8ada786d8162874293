/* Service worker — CHỈ cache file tĩnh của ứng dụng để mở lại được khi mất mạng.
 * KHÔNG BAO GIỜ cache /api/* (gọi AI, models, health) — luôn đi thẳng ra mạng.
 * Chiến lược: network-first cho file tĩnh cùng origin; mất mạng ⇒ dùng bản cache.
 * Dữ liệu dự án nằm trong IndexedDB, không liên quan tới cache này.
 */
const CACHE = 'aisa-static-v0.1.1';
// Danh sách tạo tự động từ public/ (không gồm vendor nặng — vendor được cache khi dùng lần đầu).
const PRECACHE = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/mermaid-frame.html',
  '/mermaid-frame.js',
  '/mermaid-frame.css',
  '/css/tokens.css',
  '/css/layout.css',
  '/css/components.css',
  '/docs/LIMITATIONS.md',
  '/js/core/budget.js',
  '/js/core/consistency.js',
  '/js/core/contract.js',
  '/js/core/db.js',
  '/js/core/diff.js',
  '/js/core/exporter.js',
  '/js/core/hash.js',
  '/js/core/keyring.js',
  '/js/core/llmClient.js',
  '/js/core/logger.js',
  '/js/core/mermaidSanitize.js',
  '/js/core/parser.js',
  '/js/core/pipeline.js',
  '/js/core/platforms.js',
  '/js/core/projectStore.js',
  '/js/core/prompts.js',
  '/js/core/settings.js',
  '/js/core/sse.js',
  '/js/core/syntaxCheck.js',
  '/js/core/vault.js',
  '/js/features/architect.js',
  '/js/features/attachments.js',
  '/js/features/codeBuilder.js',
  '/js/features/contractBuilder.js',
  '/js/features/costView.js',
  '/js/features/diagram.js',
  '/js/features/exportUi.js',
  '/js/features/history.js',
  '/js/features/models.js',
  '/js/features/pipelineRunner.js',
  '/js/features/playground.js',
  '/js/features/providersPanel.js',
  '/js/features/review.js',
  '/js/features/seed.js',
  '/js/features/settingsView.js',
  '/js/features/vaultUi.js',
  '/js/features/workspace.js',
  '/js/main.js',
  '/js/ui/components.js',
  '/js/ui/dom.js',
  '/js/ui/markdownView.js',
  '/js/ui/modal.js',
  '/js/ui/tabs.js',
  '/js/ui/toast.js',
  '/js/ui/vendorLoader.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Từng file một: một file lỗi không làm hỏng cả lần cài.
    await Promise.all(PRECACHE.map((u) => cache.add(u).catch((e) => console.warn('[sw] precache lỗi', u, e && e.message))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('aisa-static-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // tuyệt đối không cache API
  if (url.pathname.startsWith('/preview-frame')) return;
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch((e) => console.warn('[sw] put lỗi', e && e.message));
      }
      return res;
    } catch (err) {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const shell = await caches.match('/index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});
