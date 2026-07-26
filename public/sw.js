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
// visit). The HTML app shell ('/') is DELIBERATELY NOT precached: index.html pins the
// content-hashed `/assets/index-<hash>.js` bundle, so a precached shell becomes a
// time-bomb — after a redeploy mints a new bundle hash, a stale cached shell points at
// an `/assets/index-<oldhash>.js` that 404s, the app bundle never executes, and every
// title-screen button (LOGIN / ENTER ARENA) goes inert while the static HTML still
// renders (v0.2.226 entry-flow regression — see entry-flow report). The shell is always
// network-first (cached only opportunistically by networkFirst for offline fallback,
// inside this VERSION-named cache that is purged each deploy, so shell+bundle in cache
// always stay a consistent pair).
// v0.2.260 audit R3: keep precache to critical-path UI assets only.
// GLBs are now Draco+webp-compressed (~5 MB total, down from 14.7 MB) and are
// cached opportunistically on first request by the cacheFirst() fetch handler
// below — there's no need to fetch them all at install time. Pre-fetching them
// blocked install on slow networks and wasted bandwidth for users who never
// reached the arena (e.g. closed the tab on the landing screen).
//
// GLB assets shipped under public/ and served by cacheFirst() on demand:
//   /banker-rigged.glb, /chiefmonkey6.glb, /chiefmonkey-headless.glb,
//   /nostrich3.glb, /torii-gate.glb, /torii-gateway-experience.glb,
//   /gun-steampunk.glb.
//
// Store names relative to this worker's registration scope. Under the root deploy they
// resolve to `/wall-texture.webp`; under the Suite mount they resolve to
// `/quest/wall-texture.webp`. A root-relative manifest would silently bypass the mount.
const PRECACHE_ASSETS = [
  'wall-texture.webp', // arena floor — visible the instant the player loads in
  'bitcoin-b.png',     // sats HUD icon — visible on every frame in-arena
];

// ── Install — precache all static assets ─────────────────────────────────────
// nostrich: precache each asset INDEPENDENTLY rather than via cache.addAll().
// addAll() is ATOMIC — a single un-fetchable entry rejects the WHOLE install, so
// self.skipWaiting() never runs and the new SW never activates. A wedged upgrade
// then leaves a STALE controlling SW serving a bundle/wasm pair that can mismatch
// the freshly-deployed shell, which surfaces as ENTER ARENA failing (Rapier WASM
// fetch fails → bootstrap catch → back to menu). That is exactly how the v0.2.239
// travel-gateway GLB (a large, possibly-not-yet-propagated asset) took down entry
// on the live deploy. Per-asset add keeps the SW resilient: one bad decorative
// asset can never block install/activation — it is simply skipped and served from
// network on demand by cacheFirst().
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.all(
        PRECACHE_ASSETS.map(asset => {
          const scopedAsset = new URL(asset, self.registration.scope).href;
          return cache.add(scopedAsset).catch(err => {
            console.warn('[sw] precache skipped (non-fatal):', scopedAsset, err);
          });
        })
      ))
      .then(() => self.skipWaiting()) // activate immediately, don't wait for tabs to close
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
    ).then(() => self.clients.claim()) // take control of all open tabs immediately
  );
});

// ── Fetch — route by asset type ──────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;

  // Cache-first: GLBs, images, fonts — these never change between deploys
  if (isStaticAsset(path)) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // Network-first: JS bundles, CSS, HTML — may update on deploy
  event.respondWith(networkFirst(event.request));
});

function isStaticAsset(path) {
  return path.endsWith('.glb')
    || path.endsWith('.webp')
    || path.endsWith('.jpg')
    || path.endsWith('.png')
    || path.endsWith('.woff2')
    || path.endsWith('.wasm'); // Rapier WASM
}

// Cache-first: serve from cache, fall back to network, store result
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

// Network-first: try network, fall back to cache
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