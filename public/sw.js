/* ivyNote 通知用 Service Worker
   只做一件事：把到点提醒弹成系统通知，点通知回到对应笔记。
   刻意不接管 fetch，避免给页面引入缓存问题。 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

/* Android 上「添加到主屏幕」要求 Service Worker 带 fetch 处理器才会装成独立应用。
   这里刻意不 respondWith：请求照常走网络，不引入任何缓存。 */
self.addEventListener('fetch', () => {});

self.addEventListener('notificationclick', (e) => {
  const data = (e.notification && e.notification.data) || {};
  e.notification.close();
  const noteId = data.noteId || '';
  const target = new URL(noteId ? '/?n=' + encodeURIComponent(noteId) : '/', self.location.origin).href;

  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (!String(c.url).startsWith(self.location.origin)) continue;
      try { await c.focus(); } catch (err) {}
      c.postMessage({ type: 'ivy-open-note', noteId });
      return;
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});
