import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');

test('service worker installs a fresh app shell and bypasses HTTP cache on navigation', () => {
  assert.match(source, /fetch\('\.\/',\s*\{\s*cache:\s*'reload'\s*\}\)/);
  assert.match(source, /fetch\(request\.url,\s*\{\s*cache:\s*'no-store',\s*credentials:\s*'same-origin'\s*\}\)/);
  assert.match(source, /reelflow-static-v11/);
});

test('a missing cached asset does not fall back to index HTML', () => {
  assert.match(source, /status:\s*503/);
  assert.doesNotMatch(source, /catch\(\(\)\s*=>\s*caches\.match\('\.\/'\)\)/);
});
