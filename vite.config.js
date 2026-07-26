import { writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { defineConfig } from 'vite';
import { CSP_VALUE, headersFileBody, headersFileBodyForSha, cspValueForSha } from './tools/csp.mjs';

// CSP via HTTP header (S3, v0.2.266). The policy lives in tools/csp.mjs (single source).
// This plugin: (1) rewrites the BUILT index.html so the trusted classic inline bootstrap
// script `import()`s the pinned entry (assets/torii-entry.js) instead of a static
// <script> tag — letting `strict-dynamic` cover the whole module graph; (2) writes
// dist/_headers for the static host; (3) serves the same header from `vite preview`.
//
// v0.2.285: the entry import now carries a per-build cache-bust query (?v=<stamp>) so
// Cloudflare's 4h edge cache can never serve a stale entry that points at a dead/old
// chunk hash after a publish. Because that changes the inline-script text, the CSP sha is
// recomputed from the EMITTED inline script at writeBundle time and written into
// dist/_headers — so the policy always matches the shipped bootstrap.
//
// v0.2.285: the versioned query MUST also be injected into every chunk's back-reference
// import of the entry (`from"./torii-entry.js"`). Without this the browser sees two
// different module URLs for the same entry — `torii-entry.js?v=<stamp>` (from the inline
// bootstrap, fresh) and `torii-entry.js` (from the chunk, CDN-stale) — fetches the stale
// one, and throws "does not provide an export named 'Lt'" (or any symbol added since).
// Rewriting both to the same versioned URL makes the browser dedupe to the fresh fetch.
const BUILD_STAMP = Date.now().toString(36);
const ENTRY_BASE = 'torii-entry.js';
// Matches import specifiers pointing at the pinned entry, e.g. from"./torii-entry.js"
// or from'./torii-entry.js' or from"/assets/torii-entry.js" or from"/quest/assets/torii-entry.js".
// Avoids touching the entry file itself or unrelated strings.
const ENTRY_IMPORT_RE = /(from\s*["'])([.\w/-]*\/assets\/torii-entry\.js|[.]+\/torii-entry\.js)(["'])/g;

// v0.2.370-alpha: the pinned-entry URL MUST carry the deploy base (import.meta
// env BASE_URL — '/' at root, '/quest/' on the Torii Suite mount). Previously the
// inline bootstrap import AND every chunk back-reference were hardcoded to the
// root-absolute `/assets/torii-entry.js?v=<stamp>`, which 404s under `/quest/`.
// The 404 rejected the ENTER ARENA `import('./arenaRuntime.js')` graph (arenaRuntime
// statically imports the entry), so the arena never booted on the subpath deploy.
// Vite normalises base to always end in '/', so `${base}assets/…` is correct for
// both '/' and '/quest/'.
function entryUrl(base) {
  return `${base}assets/${ENTRY_BASE}?v=${BUILD_STAMP}`;
}

function serviceWorkerRegistration(base) {
  return `navigator.serviceWorker.register('${base}sw.js', { scope: '${base}' })`;
}

// Recompute the sha256 of the single attribute-less inline <script> in dist/index.html.
// Must match the extraction regex used by tools/regression-check.mjs (check 16c).
function inlineScriptShaOf(html) {
  const matches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (!matches.length) return null;
  return 'sha256-' + createHash('sha256').update(matches[0], 'utf8').digest('base64');
}
function cspHeaderPlugin() {
  // Deploy base ('/' at root, '/quest/' on the Suite mount). Captured from the
  // resolved Vite config so the emitted entry URL is base-correct.
  let resolvedBase = '/';
  return {
    name: 'torii-csp-http-header',
    configResolved(config) {
      resolvedBase = config.base || '/';
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        // Only the built HTML (ctx.bundle present); the dev server keeps the
        // static module tag (no CSP header in dev — strict-dynamic would block
        // Vite's own injected client/HMR scripts).
        if (!ctx.bundle) return html;
        // Drop the parser-inserted entry tag + any modulepreload hint for it; the
        // trusted inline bootstrap loads it via import() so strict-dynamic applies.
        // Base-agnostic: matches `/assets/…` and base-prefixed `/quest/assets/…`.
        let out = html
          .replace(/\s*<script\b[^>]*\bsrc="[^"]*\/assets\/torii-entry\.js"[^>]*><\/script>/, '')
          .replace(/\s*<link\b[^>]*\bhref="[^"]*\/assets\/torii-entry\.js"[^>]*>/g, '')
          .replace("navigator.serviceWorker.register('/sw.js')", serviceWorkerRegistration(resolvedBase));
        // Append the versioned entry import to the LAST inline bootstrap <script>
        // in the document. v0.2.360-alpha regression fix: previously matched
        // `\n</script>\n</body>` verbatim, which silently no-op'd when v0.2.358
        // added DOM elements (Instance Settings overlay) between the script and
        // </body>, shipping a live build with NO entry import and every button
        // dead. This lastIndexOf-based append is decoupled from what sits between
        // </script> and </body>.
        const lastCloseIdx = out.lastIndexOf('</script>');
        if (lastCloseIdx === -1) {
          throw new Error('torii-csp-http-header: no </script> found in built HTML — refusing to emit a bootstrap-less bundle');
        }
        const versionedImportLine = `  import('${entryUrl(resolvedBase)}');`;
        out = out.slice(0, lastCloseIdx) + `\n${versionedImportLine}\n` + out.slice(lastCloseIdx);
        return out;
      },
    },
    writeBundle(options) {
      const dir = options.dir || join(process.cwd(), 'dist');
      const assetsDir = join(dir, 'assets');
      // v0.2.285: rewrite every chunk's back-reference import of the pinned entry to the
      // SAME versioned URL the inline bootstrap uses, so the browser dedupes to one fresh
      // module fetch instead of hitting the CDN-stale un-versioned URL.
      if (existsSync(assetsDir)) {
        for (const f of readdirSync(assetsDir)) {
          if (!f.endsWith('.js') || f === ENTRY_BASE) continue; // skip the entry itself
          const p = join(assetsDir, f);
          const src = readFileSync(p, 'utf8');
          // Skip if this chunk doesn't import the entry at all (cheap guard).
          if (!src.includes(ENTRY_BASE)) continue;
          const rewritten = src.replace(ENTRY_IMPORT_RE, (_m, pre, _spec, post) =>
            `${pre}${entryUrl(resolvedBase)}${post}`);
          if (rewritten !== src) writeFileSync(p, rewritten);
        }
      }
      // Recompute the inline-bootstrap sha from the EMITTED dist/index.html (which now
      // carries the versioned import line) and write _headers with the matching policy.
      const htmlPath = join(dir, 'index.html');
      let body = headersFileBody(); // fallback to the hardcoded sha
      if (existsSync(htmlPath)) {
        const sha = inlineScriptShaOf(readFileSync(htmlPath, 'utf8'));
        if (sha) body = headersFileBodyForSha(sha);
      }
      writeFileSync(join(dir, '_headers'), body);
    },
    configurePreviewServer(server) {
      // Serve the CSP that matches the built dist inline script if one exists; otherwise
      // fall back to the hardcoded sha (pre-build preview of the source shell).
      const distHtmlPath = join(process.cwd(), 'dist', 'index.html');
      let csp = CSP_VALUE;
      if (existsSync(distHtmlPath)) {
        const sha = inlineScriptShaOf(readFileSync(distHtmlPath, 'utf8'));
        if (sha) csp = cspValueForSha(sha);
      }
      server.middlewares.use((_req, res, next) => {
        res.setHeader('Content-Security-Policy', csp);
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [cspHeaderPlugin()],
  server: { port: 5174 },
  build: {
    outDir: 'dist',
    // Rapier (2.2M) is an intentional LAZY chunk (dynamic import on Enter
    // Arena) and never blocks initial paint, so 700K is the right bar for the
    // UPFRONT chunks (three-vendor + game logic); the lazy physics giant is
    // expected and does not trip a real-size warning.
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      output: {
        // Pin the entry chunk to a stable filename so the inline bootstrap's
        // import() target (and therefore its sha256 in the CSP) never churns.
        entryFileNames: 'assets/torii-entry.js',
        manualChunks(id) {
          // All three.js core + addons in one vendor chunk. (Addons can't be
          // deferred separately yet: the arena modules that import them are
          // statically imported at startup. Deferring them is a future
          // arena-bundle lazy-load behind Enter Arena — a game-loop refactor.)
          if (id.includes('/three/')) return 'three-vendor';
        }
      }
    }
  },
  // Silence Rolldown codeSplitting suggestion — we're handling it manually
  optimizeDeps: {
    exclude: ['@dimforge/rapier3d-compat'] // don't pre-bundle Rapier — it's lazy
  },
  // Vitest config (v0.2.120, perf tuning v0.2.260). Node environment — the unit
  // suite covers pure logic seams (state machine, event bus, headshot classifier)
  // only, so no jsdom/Three/Rapier/browser is needed. `npm test` runs `vitest run`.
  //
  // pool: 'threads' + isolate: false — the suite is 108 files / 1834 tests but
  // every test imports only PURE helpers (no THREE, no Rapier, no DOM, no module-
  // scope mutation). Per-file isolation was costing ~26 s of collect/prepare overhead
  // for ~1.5 s of actual test execution. Sharing the worker module graph drops the
  // full suite from ~28.7 s to ~2.7 s with all 1834 tests still green. If a future
  // test ever needs a fresh module graph (rare for pure-logic seams), move it to a
  // dedicated vitest project with isolate:true rather than reverting this default.
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    pool: 'threads',
    poolOptions: { threads: { isolate: false, singleThread: false } },
  },
});