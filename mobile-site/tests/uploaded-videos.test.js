import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MAX_ORIGINAL_VIDEO_BYTES, formatVideoFileSize, VIDEO_STORAGE_BUCKET } from '../src/uploaded-video-utils.js';
import { parseReelLines } from '../src/url-utils.js';

const libraryMigration = await readFile(new URL('../supabase/migrations/202610080005_uploaded_video_library.sql', import.meta.url), 'utf8');
const safetyMigration = await readFile(new URL('../supabase/migrations/202610080006_private_video_safety.sql', import.meta.url), 'utf8');
const importMigration = await readFile(new URL('../supabase/migrations/202610080007_instagram_url_archive_import.sql', import.meta.url), 'utf8');
const recoveryMigration = await readFile(new URL('../supabase/migrations/202610080008_recover_stale_video_imports.sql', import.meta.url), 'utf8');
const hardeningMigration = await readFile(new URL('../supabase/migrations/202610080009_private_url_import_hardening.sql', import.meta.url), 'utf8');
const schema = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
const app = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const worker = await readFile(new URL('../../reels_transfer/github_worker.py', import.meta.url), 'utf8');
const workflow = await readFile(new URL('../../.github/workflows/process-reels.yml', import.meta.url), 'utf8');

 test('normalizes Instagram Reel URLs and keeps private archive size helpers', () => {
  assert.equal(MAX_ORIGINAL_VIDEO_BYTES, 50 * 1024 * 1024);
  assert.equal(VIDEO_STORAGE_BUCKET, 'reelflow-original-videos');
  assert.match(formatVideoFileSize(50 * 1024 * 1024), /50/);
  const parsed = parseReelLines('https://www.instagram.com/reel/ABC123/?igsh=one\nhttps://instagram.com/reels/abc123/\nhttps://instagram.com/reel/XYZ789/');
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.items[0].url, 'https://www.instagram.com/reel/ABC123/');
  assert.equal(parsed.duplicates, 1);
  assert.equal(parseReelLines('https://example.com/reel/ABC123').invalid.length, 1);
});

test('migrations keep originals private and add owner-isolated, retryable URL import jobs', () => {
  assert.match(libraryMigration, /'reelflow-original-videos'[\s\S]*false[\s\S]*52428800/);
  assert.match(libraryMigration, /CREATE TABLE IF NOT EXISTS public\.uploaded_videos/);
  assert.match(libraryMigration, /CREATE POLICY "ReelFlow users read their private originals"/);
  assert.match(libraryMigration, /CREATE OR REPLACE FUNCTION public\.enqueue_uploaded_video/);
  assert.match(safetyMigration, /worker_temporary_video_objects/);
  assert.match(safetyMigration, /CREATE POLICY "ReelFlow users replace only untracked originals"/);
  assert.match(importMigration, /CREATE TABLE IF NOT EXISTS public\.video_import_jobs/);
  assert.match(importMigration, /CREATE POLICY "ReelFlow users read their own video imports"/);
  assert.match(importMigration, /instagram\\\.com\/\(reel\|reels\|p\)/);
  assert.match(importMigration, /CREATE OR REPLACE FUNCTION public\.claim_video_import_job/);
  assert.match(importMigration, /FOR UPDATE SKIP LOCKED/);
  assert.match(importMigration, /CREATE OR REPLACE FUNCTION public\.finish_video_import/);
  assert.match(importMigration, /CREATE OR REPLACE FUNCTION public\.retry_video_import/);
  assert.match(importMigration, /GRANT EXECUTE ON FUNCTION public\.claim_video_import_job\(\) TO service_role/);
  assert.match(recoveryMigration, /45 minutes/);
  assert.match(recoveryMigration, /attempts >= 3/);
  assert.match(recoveryMigration, /status = 'processing'/);
  assert.match(hardeningMigration, /REVOKE INSERT ON public\.uploaded_videos FROM authenticated/);
  assert.match(hardeningMigration, /DROP POLICY IF EXISTS "ReelFlow users upload originals into their private folder"/);
  assert.match(hardeningMigration, /active_storage_path/);
  assert.match(hardeningMigration, /p_expected_user_id IS DISTINCT FROM v_user_id/);
  assert.match(hardeningMigration, /storage_object_still_exists/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS public\.video_import_jobs/);
  assert.match(schema, /45 minutes/);
});

test('PWA archives pasted Reel URLs and shows worker progress/retry without a file chooser', () => {
  assert.match(app, /id="video-library-section"/);
  assert.match(app, /id="video-import-form"/);
  assert.match(app, /id="video-import-urls"/);
  assert.match(app, /p_source_url: item\.url/);
  assert.match(app, /p_expected_user_id: userId/);
  assert.match(app, /authUserGeneration !== userGeneration/);
  assert.match(app, /state\.uploadedVideos\.some\(\(item\) => item\.id === videoId/);
  assert.match(app, /retry_video_import/);
  assert.match(app, /data-action="retry-video-import"/);
  assert.match(app, /data-video-account-select/);
  assert.match(app, /data-video-template-select/);
  assert.match(app, /data-action="preview-uploaded-video"/);
  assert.match(app, /data-action="queue-uploaded-video"/);
  assert.match(app, /createSignedUrl/);
  assert.doesNotMatch(app, /type="file"|tus-js-client|video-upload-form/);
});

test('scheduled worker downloads accessible Instagram Reels into the private owner bucket', () => {
  assert.match(worker, /claim_video_import_job/);
  assert.match(worker, /_canonical_import_url/);
  assert.match(worker, /download_reel\(\s*canonical_url/);
  assert.match(worker, /upload_imported_video/);
  assert.match(worker, /finish_video_import/);
  assert.match(worker, /fail_video_import/);
  assert.match(worker, /reelflow-original-videos/);
  assert.match(workflow, /MAX_VIDEO_IMPORTS_PER_RUN: '1'/);
  assert.match(workflow, /one queued Reel and one archive URL/);
});
