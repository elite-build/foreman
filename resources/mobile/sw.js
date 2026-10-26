self.addEventListener('push', (event) => {
  let message = { title: 'Foreman needs you', body: 'Open your attention inbox.', url: '/' }
  try { if (event.data) message = { ...message, ...event.data.json() } } catch {}
  event.waitUntil(self.registration.showNotification(message.title, {
    body: message.body,
    icon: '/icon-192.png',
    tag: 'foreman-attention',
    data: { url: message.url }
  }))
})
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
    const existing = windows[0]
    return existing ? existing.focus() : clients.openWindow(event.notification.data?.url || '/')
  }))
})
