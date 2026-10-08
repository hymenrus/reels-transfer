import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { captionForAccount, hasReelDraftContent, setCaptionForAccount, validateCaptionTemplate } from '../src/caption-utils.js';

const migration = await readFile(new URL('../supabase/migrations/202610080003_caption_templates.sql', import.meta.url), 'utf8');

test('keeps caption drafts separate per Instagram account without losing shared URL drafts', () => {
  const legacyDraft = { urls: 'https://www.instagram.com/reel/ABC123/', caption: 'Eski açıklama' };
  const firstAccountDraft = setCaptionForAccount(legacyDraft, 'ig-a', captionForAccount(legacyDraft, 'ig-a'));
  const bothAccountDrafts = setCaptionForAccount(firstAccountDraft, 'ig-b', 'İkinci hesap açıklaması');

  assert.equal(captionForAccount(bothAccountDrafts, 'ig-a'), 'Eski açıklama');
  assert.equal(captionForAccount(bothAccountDrafts, 'ig-b'), 'İkinci hesap açıklaması');
  assert.equal(captionForAccount(bothAccountDrafts, 'ig-c'), '');
  assert.equal(bothAccountDrafts.urls, legacyDraft.urls);
  assert.equal(hasReelDraftContent(bothAccountDrafts), true);
});

test('accepts a legacy caption before it is associated with an Instagram account', () => {
  assert.equal(captionForAccount({ caption: 'Taslak açıklama' }, null), 'Taslak açıklama');
  assert.equal(captionForAccount({ caption: 'Taslak açıklama' }, 'ig-a'), 'Taslak açıklama');
});

test('validates template names and captions against database limits', () => {
  assert.deepEqual(validateCaptionTemplate('  Kampanya  ', '  Yeni ürün yayında  '), {
    ok: true, name: 'Kampanya', caption: 'Yeni ürün yayında',
  });
  assert.equal(validateCaptionTemplate('', 'Açıklama').reason, 'name_required');
  assert.equal(validateCaptionTemplate('a'.repeat(61), 'Açıklama').reason, 'name_too_long');
  assert.equal(validateCaptionTemplate('Kampanya', ' ').reason, 'caption_required');
  assert.equal(validateCaptionTemplate('Kampanya', 'a'.repeat(2201)).reason, 'caption_too_long');
});

test('caption template storage is account-bound and protected by owner RLS', () => {
  assert.match(migration, /FOREIGN KEY \(instagram_account_id, user_id\)\s+REFERENCES public\.instagram_accounts\(id, user_id\)/);
  assert.match(migration, /ALTER TABLE public\.instagram_caption_templates ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /USING \(\(SELECT auth\.uid\(\)\) = user_id\)/);
  assert.match(migration, /WITH CHECK \(\(SELECT auth\.uid\(\)\) = user_id\)/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE ON public\.instagram_caption_templates TO authenticated/);
});
