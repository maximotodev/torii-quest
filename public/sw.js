// sw.js — Torii Quest Service Worker
// Strategy: cache-first for GLBs/images/fonts, network-first for JS/CSS/HTML.
// On install: precache the big IMMUTABLE binary assets only — NEVER the HTML shell.
// On activate: purge old cache versions.

// CACHE_VERSION tracks the app VERSION (src/config.js) so every shipped version
// bump mints a fresh cache name and the activate handler purges the prior version's
// assets — no stale assets after an asset-changing deploy. Bump in lockstep with the
// other version markers; regression-check [5] FAILS if this does not embed the current
// EXPECTED_VERSION (so it can never silently rot back to a stale literal like 'tq-v1').
const CACHE_VERSION = 'tq-v0.2.404-alpha';
const CACHE_NAME    = `torii-quest-${CACHE_VERSION}`;

// Static assets to precache on install — ONLY immutable binary assets whose URL never
// changes between deploys (GLBs/textures, ~7MB that would otherwise re-download every
// visit). The HTML app shell is deliberately not precached.
//
// Store names relative to this worker's registration scope. Under the root deploy they
// resolve to `/wall-texture.webp`; under the Suite mount they resolve to
// `/quest/wall-texture.webp`. A root-relative manifest would silently bypass the mount.
const PRECACHE_ASSET_NAMES = [
  'wall-texture.webp', // arena floor — visible the instant the player loads in
  'bitcoin-b.png',     // sats HUD icon — visible on every frame in-arena
];

function scopeAssetUrl(name) {
  return new URL(name, self.registration.scope).href;
}

// ── Install — precache all static assets ─────────────────────────────────────
// Precache each asset independently rather than via cache.addAll(): one unavailable
// decorative asset must never block install, skipWaiting, or activation.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.all(
        PRECACHE_ASSET_NAMES.map(name => {
          const asset = scopeAssetUrl(name);
          return cache.add(asset).catch(err => {
            console.warn('[sw] precache skipped (non-fatal):', asset, err);
          });
        })
      ))
      .then(() => self.skipWaiting())
  );
});

// ── Activate — purge stale caches ────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key.startsWith('torii-quest-') && key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch — route by asset type ──────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Only handle same-origin requests.
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;

  // Cache-first: GLBs, images, fonts — these never change between deploys.
  if (isStaticAsset(path)) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // Network-first: JS bundles, CSS, HTML — may update on deploy.
  event.respondWith(networkFirst(event.request));
});

function isStaticAsset(path) {
  return path.endsWith('.glb')
    || path.endsWith('.webp')
    || path.endsWith('.jpg')
    || path.endsWith('.png')
    || path.endsWith('.woff2')
    || path.endsWith('.wasm');
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Asset unavailable offline', { status: 503 });
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response('Offline', { status: 503 });
  }
}
