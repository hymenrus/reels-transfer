import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8');
const app = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

test('discovers the fallback-friendly web fonts in the document head, not through a CSS import', () => {
  assert.match(html, /rel="stylesheet" href="https:\/\/fonts\.googleapis\.com\/css2\?family=DM\+Sans/);
  assert.match(html, /fonts\.gstatic\.com[^>]+crossorigin/);
  assert.doesNotMatch(styles, /^@import/m);
  assert.match(styles, /'DM Sans',ui-sans-serif,system-ui/);
});

test('loads independent account and queue data concurrently on startup', () => {
  assert.match(app, /await Promise\.all\(\[loadInstagramAccount\(\), loadQueue\(\)\]\)/);
});

test('keeps video previews usable with legacy viewport units and respects reduced-motion preferences', () => {
  assert.match(styles, /max-height:calc\(100vh - 36px\);max-height:calc\(100dvh - 36px\)/);
  assert.match(styles, /max-height:70vh;max-height:70dvh/);
  assert.match(styles, /max-height:68vh;max-height:68dvh/);
  assert.match(styles, /@media\(prefers-reduced-motion:reduce\)/);
});
