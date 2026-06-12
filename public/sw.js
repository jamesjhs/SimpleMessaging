'use strict';

const CACHE_NAME  = 'tls-__APP_VERSION__'; // replaced with the real version by the server at runtime
const SHELL_URLS  = ['/', '/style.css', '/script.js', '/icon.svg', '/android.png'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Network-first strategy – fall back to cache for shell assets
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  if (event.request.cache === 'only-if-cached' && event.request.mode !== 'same-origin') {
    return;
  }

  // Never cache API calls, uploads, or admin routes
  if (url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/uploads/') ||
      url.pathname.startsWith('/admin')) {
    return;
  }

  event.respondWith(
    fetch(event.request, { cache: 'no-store' })
      .then(response => {
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// ── Push notifications ────────────────────────────────────────────────────────

self.addEventListener('push', event => {
  let title = 'TLS';
  let body  = 'New message';
  let icon  = '/icon.svg';
  const badge = '/android.png';

  try {
    if (event.data) {
      const data = event.data.json();
      if (data.title) title = data.title;
      if (data.body)  body  = data.body;
    }
  } catch { /* ignore parse errors */ }

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon,
      badge,
      tag:   'tls-message',
      renotify: true,
    })
  );
});

// Focus or open the app when a notification is clicked
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});
