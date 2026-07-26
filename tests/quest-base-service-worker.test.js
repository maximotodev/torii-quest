// tests/quest-base-service-worker.test.js — deploy-base service-worker contract.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '.tmp-quest-sw-base-build');
const BASE = '/quest/';
const VITE = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

let indexHtml = '';
let serviceWorker = '';

beforeAll(() => {
  rmSync(OUT, { recursive: true, force: true });
  execFileSync('node', [VITE, 'build', '--base', BASE, '--outDir', OUT], {
    cwd: ROOT,
    stdio: 'pipe',
  });
  indexHtml = readFileSync(join(OUT, 'index.html'), 'utf8');
  serviceWorker = readFileSync(join(OUT, 'sw.js'), 'utf8');
}, 60000);

afterAll(() => {
  rmSync(OUT, { recursive: true, force: true });
});

describe('quest-base service worker', () => {
  it('registers the worker under the /quest/ deploy base with an explicit matching scope', () => {
    expect(indexHtml).toContain("navigator.serviceWorker.register('/quest/sw.js', { scope: '/quest/' })");
    expect(indexHtml).not.toContain("navigator.serviceWorker.register('/sw.js')");
  });

  it('keeps precache entries relative and resolves them against the registration scope', () => {
    expect(serviceWorker).toContain("'wall-texture.webp'");
    expect(serviceWorker).toContain("'bitcoin-b.png'");
    expect(serviceWorker).toContain('new URL(name, self.registration.scope).href');
    expect(serviceWorker).not.toContain("'/wall-texture.webp'");
    expect(serviceWorker).not.toContain("'/bitcoin-b.png'");
  });
});
