/* Cross-origin isolation on a host that cannot send headers.
 *
 * The transport parks the DuckDB thread in Atomics.wait on a SharedArrayBuffer,
 * which browsers only hand out to a cross-origin-isolated page -- that is,
 * one served with COOP: same-origin and COEP: require-corp. GitHub Pages serves
 * static files and offers no way to set either. A service worker can, because
 * once it controls the page it synthesises the responses the browser sees.
 *
 * The cost is one reload on a visitor's first arrival: the document that
 * registered the worker was itself fetched without the headers, so it has to be
 * re-fetched through the worker. Subsequent visits are already controlled.
 *
 * This file is loaded twice, in two different globals -- once as an ordinary
 * script from index.html, and once as the service worker itself -- so it
 * branches on which one it is running in.
 *
 * Adapted from the well-known coi-serviceworker pattern (gzuidhof), kept in
 * tree rather than pulled from a CDN: a script that rewrites every response
 * header on the origin is not one to load from somewhere we do not control.
 */

if (typeof window === 'undefined') {
  // --- service worker global ---

  // Statuses whose response is defined to have no body. The Response
  // constructor throws `Response with null body status cannot have body` if
  // handed one anyway -- and `fetch` does hand us one: a conditional GET that
  // revalidates comes back 304 with a (empty, but non-null) body stream, which
  // is why this fired on reload rather than on first visit. Throwing inside
  // respondWith fails the request, so a page that reloads twice loses
  // subresources; the console fills with the same TypeError and nothing says
  // it came from a 304.
  const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

  // Take over as soon as possible; the page is waiting on a reload.
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

  self.addEventListener('fetch', (event) => {
    const request = event.request;

    // A cache-only request that is not same-origin cannot be re-issued as a
    // network fetch; passing it through untouched is the only correct move.
    if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;

    event.respondWith(
      fetch(request)
        .then((response) => {
          // Opaque responses (status 0) have no readable body or headers, so
          // there is nothing to rewrite. They are already CORP-safe to embed.
          if (response.status === 0) return response;

          const headers = new Headers(response.headers);
          headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
          headers.set('Cross-Origin-Opener-Policy', 'same-origin');
          // Without this, our own same-origin subresources fail the very
          // require-corp check we just turned on.
          headers.set('Cross-Origin-Resource-Policy', 'cross-origin');

          return new Response(NULL_BODY_STATUS.has(response.status) ? null : response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        })
        // Let the failure surface as a network error rather than a silent
        // empty response, so the page's own error handling sees it.
        .catch((err) => {
          console.error('[coi] fetch failed:', err);
          throw err;
        }),
    );
  });
} else {
  // --- page global ---

  (() => {
    // Already isolated (a host that can set headers, or a second visit), or a
    // browser too old to report it. Either way there is nothing to do.
    if (window.crossOriginIsolated !== false) return;
    if (!window.isSecureContext || !('serviceWorker' in navigator)) {
      console.warn('[coi] no service worker available; SharedArrayBuffer will be unavailable');
      return;
    }

    // currentScript is only readable while this script is evaluating, which is
    // now. Registering by its own URL is what makes the scope the site root.
    const src = document.currentScript.src;

    navigator.serviceWorker.register(src).then(
      (registration) => {
        // Controlled already but not isolated means the headers changed under
        // us; a reload picks up the new ones.
        if (registration.active && !navigator.serviceWorker.controller) {
          window.location.reload();
        }
      },
      (err) => console.error('[coi] service worker registration failed:', err),
    );

    // The first controller taking over is the signal that a reload will now
    // produce an isolated page. This is the only reload trigger: reloading on
    // 'updatefound' instead would fire while the replacement worker was still
    // installing, so that reload would still be served by the old one and this
    // event would then reload a second time.
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload());
  })();
}
