const CACHE = "kamin-v15";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname === "/session") return;

  event.respondWith(fromNetwork(request));
});

async function fromNetwork(request) {
  const networkRequest =
    request.mode === "navigate" ? request : new Request(request, { cache: "no-cache" });

  try {
    const response = await fetch(networkRequest);
    if (response.ok) {
      const cache = await caches.open(CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response("Нет сети", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
}
