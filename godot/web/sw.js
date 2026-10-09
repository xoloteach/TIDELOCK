/* Retire the previous Vite/Workbox worker when an existing player revisits Pages.
   The Godot edition does not register a worker or claim offline support. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil((async () => {
  const scope = self.registration.scope;
  for (const name of await caches.keys()) {
    if (name.startsWith('workbox-') && name.includes(scope)) await caches.delete(name);
  }
  await self.clients.claim();
  await self.registration.unregister();
  for (const client of await self.clients.matchAll({type:'window'})) {
    if (client.url.startsWith(scope)) await client.navigate(client.url);
  }
})()));
