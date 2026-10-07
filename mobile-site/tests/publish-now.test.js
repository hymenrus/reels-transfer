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

test('successful queue add clears URLs but retains and persists the caption draft', () => {
  const start = source.indexOf('async function addToQueue(form)');
  const end = source.indexOf('async function handleClick(event)', start);
  assert.notEqual(start, -1, 'Kuyruğa ekleme yordamı bulunmalı');
  assert.notEqual(end, -1, 'Kuyruğa ekleme yordamının sonu bulunmalı');

  const addToQueue = source.slice(start, end);
  const successStart = addToQueue.indexOf('if (failed === 0)');
  const successEnd = addToQueue.indexOf('await loadQueue(true)', successStart);
  assert.notEqual(successStart, -1, 'Başarılı ekleme dalı bulunmalı');
  assert.notEqual(successEnd, -1, 'Başarılı ekleme dalının sonu bulunmalı');

  const successBranch = addToQueue.slice(successStart, successEnd);
  assert.match(successBranch, /currentUrlInput\.value = ''/);
  assert.match(successBranch, /saveReelDraft\(\)/);
  assert.doesNotMatch(successBranch, /(?:captionInput|caption-input)\.value\s*=\s*''/);
  assert.match(source, /const draft = \{ urls: urlInput\.value, caption: captionInput\.value \}/);
});
