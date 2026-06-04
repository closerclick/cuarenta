// Service worker del Cuarenta — patrón estándar del ecosistema CloserClick:
// navegación network-first (los deploys se ven enseguida; offline cae a caché),
// resto cache-first con refresco en segundo plano. Subir CACHE en cada cambio.
const CACHE = 'cuarenta-v3'
const CORE = ['./', './index.html', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return // no cachear proxy/goat/jsdelivr

  // Navegación (HTML): network-first.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone()
        caches.open(CACHE).then((c) => c.put(req, copy))
        return res
      }).catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
    )
    return
  }

  // Resto: cache-first con refresco en segundo plano.
  e.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(req, copy))
        }
        return res
      }).catch(() => cached)
      return cached || network
    })
  )
})
