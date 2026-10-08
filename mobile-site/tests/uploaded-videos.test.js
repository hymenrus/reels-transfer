import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  MAX_ORIGINAL_VIDEO_BYTES,
  createVideoObjectPath,
  formatVideoFileSize,
  isOwnedVideoObjectPath,
  normalizedVideoMimeType,
  resumableUploadFingerprint,
  tusResumableEndpoint,
  validateUploadedVideo,
  VIDEO_STORAGE_BUCKET,
} from '../src/uploaded-video-utils.js';

const migration = await readFile(new URL('../supabase/migrations/202610080005_uploaded_video_library.sql', import.meta.url), 'utf8');
const safetyMigration = await readFile(new URL('../supabase/migrations/202610080006_private_video_safety.sql', import.meta.url), 'utf8');
const schema = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
const app = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');
const worker = await readFile(new URL('../../reels_transfer/github_worker.py', import.meta.url), 'utf8');

test('validates MP4/MOV originals and enforces the 50 MiB limit before upload', () => {
  assert.equal(MAX_ORIGINAL_VIDEO_BYTES, 50 * 1024 * 1024);
  assert.deepEqual(validateUploadedVideo({ name: 'clip.mp4', type: 'video/mp4', size: 100 }), {
    ok: true, mimeType: 'video/mp4', extension: 'mp4',
  });
  assert.equal(validateUploadedVideo({ name: 'phone.mov', type: '', size: 100 }).mimeType, 'video/quicktime');
  assert.equal(validateUploadedVideo({ name: 'large.mp4', type: 'video/mp4', size: MAX_ORIGINAL_VIDEO_BYTES + 1 }).reason, 'file_too_large');
  assert.equal(validateUploadedVideo({ name: 'movie.avi', type: 'video/x-msvideo', size: 100 }).reason, 'unsupported_type');
  assert.equal(normalizedVideoMimeType({ name: 'clip.m4v', type: '' }), 'video/x-m4v');
});

test('creates private object keys under the authenticated user and supports browser TUS endpoint construction', () => {
  const owner = '123e4567-e89b-42d3-a456-426614174000';
  assert.equal(createVideoObjectPath(owner, 'mp4', 'upload_1234567890abcdef'), `${owner}/upload_1234567890abcdef.mp4`);
  assert.throws(() => createVideoObjectPath(owner, '../mp4', 'upload_1234567890abcdef'));
  assert.equal(isOwnedVideoObjectPath(`${owner}/clip.mp4`, owner), true);
  assert.equal(isOwnedVideoObjectPath('other-user/clip.mp4', owner), false);
  assert.equal(tusResumableEndpoint('https://fwscsiswefezkyfblres.supabase.co'), 'https://fwscsiswefezkyfblres.storage.supabase.co/storage/v1/upload/resumable');
  assert.throws(() => tusResumableEndpoint('http://localhost:54321'));
  assert.match(resumableUploadFingerprint(owner, { name: 'clip.mp4', size: 123, lastModified: 456 }), /clip\.mp4:123:456$/);
  assert.match(formatVideoFileSize(50 * 1024 * 1024), /50/);
  assert.equal(VIDEO_STORAGE_BUCKET, 'reelflow-original-videos');
});

test('migration creates private per-user storage with RLS and no public bucket access', () => {
  assert.match(migration, /INSERT INTO storage\.buckets[\s\S]*'reelflow-original-videos'[\s\S]*false[\s\S]*52428800/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.uploaded_videos/);
  assert.match(migration, /ALTER TABLE public\.uploaded_videos ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /storage\.foldername\(name\).*auth\.uid/s);
  assert.match(migration, /CREATE POLICY "ReelFlow users read their private originals"/);
  assert.match(migration, /CREATE POLICY "ReelFlow users delete only untracked or claimed originals"/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.enqueue_uploaded_video/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.claim_uploaded_video_cleanups/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.finish_uploaded_video_cleanup/);
  assert.doesNotMatch(migration, /CREATE POLICY[^;]+\bUSING\s*\(\s*true\s*\)/i);
  assert.match(safetyMigration, /worker_temporary_video_objects/);
  assert.match(safetyMigration, /JOIN public\.instagram_credentials/);
  assert.match(safetyMigration, /CREATE POLICY "ReelFlow users replace only untracked originals"/);
  const claimFunction = safetyMigration.split('CREATE OR REPLACE FUNCTION public.claim_uploaded_video_cleanup(')[1].split('$$;')[0];
  assert.doesNotMatch(claimFunction, /UPDATE public\.reels_queue/);
  const finishFunction = safetyMigration.split('CREATE OR REPLACE FUNCTION public.finish_uploaded_video_cleanup(')[1].split('$$;')[0];
  assert.match(finishFunction, /SET status = 'cancelled'/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS public\.uploaded_videos/);
});

test('PWA exposes resumable upload, account/template selection, playback, queueing and cleanup UI hooks', () => {
  assert.match(app, /tus-js-client/);
  assert.match(app, /id="video-library-section"/);
  assert.match(app, /id="video-upload-form"/);
  assert.match(app, /data-video-account-select/);
  assert.match(app, /data-video-template-select/);
  assert.match(app, /data-action="preview-uploaded-video"/);
  assert.match(app, /data-action="queue-uploaded-video"/);
  assert.match(app, /data-action="delete-uploaded-video"/);
  assert.match(app, /createSignedUrl/);
  assert.match(app, /cleanup_pending/);
  assert.match(app, /fileAvailable = Boolean\(video\.storage_path\)/);
  assert.match(app, /Dosya depodan kaldırıldı/);
  assert.match(app, /'x-upsert': 'true'/);
  assert.match(app, /removeUntrackedVideoObject/);
  assert.match(app, /savedRow/);
});

test('worker supports private-storage source jobs and calls cleanup only after publication is recorded', () => {
  assert.match(worker, /uploaded_video_id/);
  assert.match(worker, /claim_uploaded_video_cleanups/);
  assert.match(worker, /finish_uploaded_video_cleanup/);
  assert.match(worker, /download_uploaded_video/);
  assert.match(worker, /public_video_url/);
  assert.match(worker, /upload_temporary_video/);
  assert.match(worker, /cleanup_stale_temporary_videos/);
});
