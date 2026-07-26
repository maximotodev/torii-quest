// tools/service-worker-base-check.mjs — static deploy-base contract for issue #27.
// Keeps service-worker URL rules scoped to the registration + precache manifest;
// legitimate root-level network routes elsewhere (for example /mp) are unaffected.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const vite = readFileSync(join(ROOT, 'vite.config.js'), 'utf8');
const sw = readFileSync(join(ROOT, 'public/sw.js'), 'utf8');

let fails = 0;
const fail = (message) => { console.error(`  ✗ ${message}`); fails++; };
const pass = (message) => console.log(`  ✓ ${message}`);

console.log('[sw-base] service-worker deploy-base contract');

const sourceRegistration = "navigator.serviceWorker.register('/sw.js')";
if (!html.includes(sourceRegistration)) {
  fail('index.html source registration marker is missing');
} else if (!vite.includes('SW_REGISTRATION_SOURCE')) {
  fail('vite.config.js does not declare the guarded registration marker');
} else if (!vite.includes('service-worker registration marker missing')) {
  fail('vite.config.js does not fail closed when the registration marker drifts');
} else if (!vite.includes("scope: '${base}'")) {
  fail('vite.config.js does not inject an explicit deploy-base scope');
} else {
  pass('source registration is guarded and build-time base injection is explicit');
}

if (!sw.includes('self.registration.scope')) {
  fail('public/sw.js does not resolve precache entries from registration scope');
} else {
  pass('precache resolution uses self.registration.scope');
}

const manifest = sw.match(/const\s+PRECACHE_ASSETS\s*=\s*\[([\s\S]*?)\];/);
if (!manifest) {
  fail('public/sw.js PRECACHE_ASSETS manifest is missing');
} else {
  const entries = [...manifest[1].matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]);
  if (entries.length === 0) {
    fail('public/sw.js precache manifest has no string entries');
  } else {
    const rootRelative = entries.filter((entry) => entry.startsWith('/'));
    if (rootRelative.length > 0) {
      fail(`precache entries must be scope-relative: ${rootRelative.join(', ')}`);
    } else {
      pass(`${entries.length} precache entries are scope-relative`);
    }
  }
}

if (fails > 0) process.exit(1);
