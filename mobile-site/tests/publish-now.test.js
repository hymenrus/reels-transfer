import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

test('Hemen Paylaş tek dokunuşta ilerler ve browser confirm penceresi göstermez', () => {
  const start = source.indexOf("if (button.dataset.action === 'publish-now')");
  const end = source.indexOf("if (button.dataset.action === 'cancel')", start);
  assert.notEqual(start, -1, 'Hemen Paylaş click handler bulunmalı');
  assert.notEqual(end, -1, 'Hemen Paylaş handler sınırı bulunmalı');

  const handler = source.slice(start, end);
  assert.doesNotMatch(handler, /window\.confirm\s*\(/);
  assert.match(handler, /request_immediate_publish/);
  assert.match(handler, /functions\.invoke\('publish-now-trigger'/);
});
