import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReelLine, parseReelLines } from '../src/url-utils.js';

test('normalizes reel URL and keeps caption after the first separator', () => {
  const result = parseReelLine('https://www.instagram.com/reels/AbC_9/?igsh=test | bir | iki');
  assert.deepEqual(result, {
    kind: 'valid', shortcode: 'AbC_9', shortcodeKey: 'abc_9',
    url: 'https://www.instagram.com/reel/AbC_9/', caption: 'bir | iki',
  });
});

test('parses the public /p share shape and ignores tracking query parameters', () => {
  const result = parseReelLine('https://instagram.com/p/Cxyz123-/?utm_source=test');
  assert.equal(result.kind, 'valid');
  assert.equal(result.shortcode, 'Cxyz123-');
  assert.equal(result.url, 'https://www.instagram.com/reel/Cxyz123-/');
});

test('rejects non-Instagram host, plain profile and non-HTTPS URL', () => {
  assert.equal(parseReelLine('https://example.com/reel/ABCDE/').kind, 'invalid');
  assert.equal(parseReelLine('https://instagram.com/kullanici/').kind, 'invalid');
  assert.equal(parseReelLine('http://instagram.com/reel/ABCDE/').kind, 'invalid');
});

test('deduplicates by shortcode regardless of query and slash differences', () => {
  const result = parseReelLines([
    'https://www.instagram.com/reel/ABC123/?igsh=first | ilk',
    'https://instagram.com/reels/abc123?igsh=second | tekrar',
    'https://instagram.com/reel/XYZ999/',
    'geçersiz',
  ].join('\n'));
  assert.equal(result.items.length, 2);
  assert.equal(result.duplicates, 1);
  assert.equal(result.invalid.length, 1);
});
