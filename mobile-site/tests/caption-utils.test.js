import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  captionForAccount,
  composeCaptionWithTags,
  hasReelDraftContent,
  setCaptionForAccount,
  setTagsForAccount,
  tagsForAccount,
  validateCaptionTemplate,
} from '../src/caption-utils.js';

const securityMigration = await readFile(new URL('../supabase/migrations/202610080003_caption_templates.sql', import.meta.url), 'utf8');
const sharedMigration = await readFile(new URL('../supabase/migrations/202610080004_user_shared_caption_templates.sql', import.meta.url), 'utf8');
const schemaSnapshot = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');

test('keeps local caption and tag drafts separate per Instagram account without losing shared URL drafts', () => {
  const legacyDraft = { urls: 'https://www.instagram.com/reel/ABC123/', caption: 'Eski açıklama' };
  let draft = setCaptionForAccount(legacyDraft, 'ig-a', captionForAccount(legacyDraft, 'ig-a'));
  draft = setTagsForAccount(draft, 'ig-a', '#ilk #reels');
  draft = setCaptionForAccount(draft, 'ig-b', 'İkinci hesap açıklaması');
  draft = setTagsForAccount(draft, 'ig-b', '@marka #ikinci');

  assert.equal(captionForAccount(draft, 'ig-a'), 'Eski açıklama');
  assert.equal(captionForAccount(draft, 'ig-b'), 'İkinci hesap açıklaması');
  assert.equal(captionForAccount(draft, 'ig-c'), '');
  assert.equal(tagsForAccount(draft, 'ig-a'), '#ilk #reels');
  assert.equal(tagsForAccount(draft, 'ig-b'), '@marka #ikinci');
  assert.equal(tagsForAccount(draft, 'ig-c'), '');
  assert.equal(draft.urls, legacyDraft.urls);
  assert.equal(hasReelDraftContent(draft), true);
});

test('accepts a legacy caption before it is associated with an Instagram account', () => {
  assert.equal(captionForAccount({ caption: 'Taslak açıklama' }, null), 'Taslak açıklama');
  assert.equal(captionForAccount({ caption: 'Taslak açıklama' }, 'ig-a'), 'Taslak açıklama');
});

test('automatically appends hashtag and mention blocks exactly once', () => {
  assert.equal(composeCaptionWithTags(' Yeni ürün yayında ', '#reels @marka'), 'Yeni ürün yayında\n\n#reels @marka');
  assert.equal(composeCaptionWithTags('', '#reels'), '#reels');
  assert.equal(composeCaptionWithTags('Yeni ürün\n\n#reels', '#reels'), 'Yeni ürün\n\n#reels');
  assert.equal(composeCaptionWithTags('Açıklama', ''), 'Açıklama');
});

test('validates template names, caption/tag lengths, and the final combined Instagram caption limit', () => {
  assert.deepEqual(validateCaptionTemplate('  Kampanya  ', '  Yeni ürün yayında  ', '#reels @marka'), {
    ok: true, name: 'Kampanya', caption: 'Yeni ürün yayında', tags: '#reels @marka',
  });
  assert.equal(validateCaptionTemplate('', 'Açıklama').reason, 'name_required');
  assert.equal(validateCaptionTemplate('a'.repeat(61), 'Açıklama').reason, 'name_too_long');
  assert.equal(validateCaptionTemplate('Etiketler', '', '#reels').ok, true);
  assert.equal(validateCaptionTemplate('Kampanya', ' ', ' ').reason, 'caption_required');
  assert.equal(validateCaptionTemplate('Kampanya', 'a'.repeat(2201)).reason, 'caption_too_long');
  assert.equal(validateCaptionTemplate('Etiketler', '', 'a'.repeat(2201)).reason, 'tags_too_long');
  assert.equal(validateCaptionTemplate('Kampanya', 'a'.repeat(2195), '#reels').reason, 'combined_too_long');
});

test('caption templates are private to one ReelFlow user and shared across that user’s Instagram accounts without deleting data', () => {
  assert.match(securityMigration, /ALTER TABLE public\.instagram_caption_templates ENABLE ROW LEVEL SECURITY/);
  assert.match(securityMigration, /USING \(\(SELECT auth\.uid\(\)\) = user_id\)/);
  assert.match(securityMigration, /WITH CHECK \(\(SELECT auth\.uid\(\)\) = user_id\)/);
  assert.match(sharedMigration, /UPDATE public\.instagram_caption_templates SET instagram_account_id = NULL/);
  assert.match(sharedMigration, /ADD COLUMN IF NOT EXISTS tags text NOT NULL DEFAULT ''/);
  assert.match(sharedMigration, /CREATE UNIQUE INDEX IF NOT EXISTS instagram_caption_templates_owner_name_key\s+ON public\.instagram_caption_templates \(user_id, lower\(name\)\)/);
  assert.doesNotMatch(sharedMigration, /DELETE FROM public\.instagram_caption_templates/);
  assert.match(schemaSnapshot, /instagram_caption_templates_owner_name_key/);
  assert.match(schemaSnapshot, /tags text NOT NULL DEFAULT ''/);
  assert.match(schemaSnapshot, /CREATE POLICY "Users manage their own Instagram caption templates"/);
});
