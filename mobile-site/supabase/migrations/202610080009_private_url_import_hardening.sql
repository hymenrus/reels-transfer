-- Enforce URL-only browser ingestion and make upload/session cleanup recoverable.
BEGIN;

-- Browser clients may read their own library, but only the service-role worker
-- may create Storage objects or register uploaded_videos metadata.
REVOKE INSERT ON public.uploaded_videos FROM authenticated;
DROP POLICY IF EXISTS "ReelFlow users register their own uploaded videos" ON public.uploaded_videos;
DROP POLICY IF EXISTS "ReelFlow users upload originals into their private folder" ON storage.objects;
DROP POLICY IF EXISTS "ReelFlow users replace only untracked originals" ON storage.objects;

ALTER TABLE public.video_import_jobs
  ADD COLUMN IF NOT EXISTS active_storage_path text;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'video_import_jobs_active_storage_path_check'
      AND conrelid = 'public.video_import_jobs'::regclass
  ) THEN
    ALTER TABLE public.video_import_jobs
      ADD CONSTRAINT video_import_jobs_active_storage_path_check
      CHECK (
        active_storage_path IS NULL OR
        active_storage_path ~ (
          '^' || user_id::text || '/import-' || replace(id::text, '-', '') || '\.(mp4|mov|m4v)$'
        )
      );
  END IF;
END;
$$;
CREATE INDEX IF NOT EXISTS video_import_jobs_unregistered_objects_idx
  ON public.video_import_jobs (status, updated_at)
  WHERE active_storage_path IS NOT NULL;
GRANT ALL ON public.video_import_jobs TO service_role;

-- Bind every browser submission to the exact ReelFlow owner captured before the
-- network request, preventing an auth-session switch from changing ownership.
DROP FUNCTION IF EXISTS public.enqueue_video_import(text, boolean);
CREATE OR REPLACE FUNCTION public.enqueue_video_import(
  p_source_url text,
  p_rights_confirmed boolean,
  p_expected_user_id uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_match text[];
  v_shortcode text;
  v_job_id uuid;
  v_status text;
BEGIN
  IF v_user_id IS NULL OR p_expected_user_id IS DISTINCT FROM v_user_id THEN
    RAISE EXCEPTION 'session owner changed; retry the import' USING ERRCODE = '42501';
  END IF;
  IF p_rights_confirmed IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'content rights confirmation required' USING ERRCODE = '22023';
  END IF;
  v_match := regexp_match(
    coalesce(p_source_url, ''),
    '^https://(www\.)?instagram\.com/(reel|reels|p)/([A-Za-z0-9_-]{1,64})/?$',
    'i'
  );
  IF v_match IS NULL THEN
    RAISE EXCEPTION 'Instagram Reel URL is invalid' USING ERRCODE = '22023';
  END IF;
  v_shortcode := v_match[3];

  IF EXISTS (
    SELECT 1 FROM public.uploaded_videos AS v
    WHERE v.user_id = v_user_id
      AND lower(v.source_shortcode) = lower(v_shortcode)
      AND v.storage_path IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'video_already_archived' USING ERRCODE = '23505';
  END IF;

  SELECT j.id, j.status INTO v_job_id, v_status
  FROM public.video_import_jobs AS j
  WHERE j.user_id = v_user_id AND lower(j.shortcode) = lower(v_shortcode)
  ORDER BY j.created_at DESC
  LIMIT 1
  FOR UPDATE;
  IF FOUND THEN
    IF v_status IN ('queued', 'processing') THEN
      RAISE EXCEPTION 'video_import_duplicate' USING ERRCODE = '23505';
    END IF;
    UPDATE public.video_import_jobs AS j
    SET source_url = 'https://www.instagram.com/reel/' || v_shortcode || '/',
        status = 'queued', progress = 0, stage = 'Bulut indirme kuyruğunda',
        attempts = 0, error_message = NULL, uploaded_video_id = NULL,
        rights_confirmed = true, updated_at = now(), finished_at = NULL
    WHERE j.id = v_job_id;
    RETURN v_job_id;
  END IF;

  INSERT INTO public.video_import_jobs (
    user_id, shortcode, source_url, status, progress, stage, rights_confirmed
  ) VALUES (
    v_user_id, v_shortcode, 'https://www.instagram.com/reel/' || v_shortcode || '/',
    'queued', 0, 'Bulut indirme kuyruğunda', true
  ) RETURNING id INTO v_job_id;
  RETURN v_job_id;
END;
$$;
REVOKE ALL ON FUNCTION public.enqueue_video_import(text, boolean, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enqueue_video_import(text, boolean, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.retry_video_import(p_import_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  UPDATE public.video_import_jobs AS j
  SET status = 'queued', progress = 0, stage = 'Bulut indirme kuyruğunda',
      attempts = 0, error_message = NULL, updated_at = now(), finished_at = NULL
  WHERE j.id = p_import_id
    AND j.user_id = v_user_id
    AND j.status = 'failed'
    AND NOT EXISTS (
      SELECT 1 FROM public.uploaded_videos AS v
      WHERE v.user_id = v_user_id
        AND lower(v.source_shortcode) = lower(j.shortcode)
        AND v.storage_path IS NOT NULL
    );
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.retry_video_import(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.retry_video_import(uuid) TO authenticated;

-- Persist the reserved object path before upload and return it to the worker if
-- an interrupted import is reclaimed, so every orphan can be safely removed.
DROP FUNCTION IF EXISTS public.claim_video_import_job();
CREATE FUNCTION public.claim_video_import_job()
RETURNS TABLE(id uuid, user_id uuid, shortcode text, source_url text, attempts integer, active_storage_path text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;

  UPDATE public.video_import_jobs AS j
  SET status = CASE WHEN j.attempts >= 3 THEN 'failed' ELSE 'queued' END,
      progress = 0,
      stage = CASE WHEN j.attempts >= 3
        THEN 'Önceki bulut indirme denemeleri tamamlanamadı'
        ELSE 'Önceki işlem yarıda kaldı · yeniden sıraya alındı' END,
      error_message = CASE WHEN j.attempts >= 3
        THEN 'Bulut işçisi aktarımı birkaç denemede tamamlayamadı. Yeniden dene veya URL’yi kontrol et.'
        ELSE NULL END,
      updated_at = now(),
      finished_at = CASE WHEN j.attempts >= 3 THEN now() ELSE NULL END
  WHERE j.status = 'processing'
    AND j.updated_at < now() - interval '45 minutes';

  RETURN QUERY
  WITH next_job AS (
    SELECT j.id
    FROM public.video_import_jobs AS j
    WHERE j.status = 'queued'
    ORDER BY j.created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE public.video_import_jobs AS j
  SET status = 'processing', progress = 3,
      stage = 'Instagram bağlantısı hazırlanıyor', attempts = j.attempts + 1,
      error_message = NULL, updated_at = now()
  FROM next_job
  WHERE j.id = next_job.id
  RETURNING j.id, j.user_id, j.shortcode, j.source_url, j.attempts, j.active_storage_path;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_video_import_job() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_video_import_job() TO service_role;

CREATE OR REPLACE FUNCTION public.finish_video_import(
  p_import_id uuid,
  p_storage_path text,
  p_original_filename text,
  p_mime_type text,
  p_size_bytes bigint
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job public.video_import_jobs%ROWTYPE;
  v_video_id uuid;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  SELECT j.* INTO v_job
  FROM public.video_import_jobs AS j
  WHERE j.id = p_import_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'video import job not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_job.status = 'ready' AND v_job.uploaded_video_id IS NOT NULL THEN
    RETURN v_job.uploaded_video_id;
  END IF;
  IF v_job.status <> 'processing' OR v_job.active_storage_path IS DISTINCT FROM p_storage_path THEN
    RAISE EXCEPTION 'video import path is not reserved for this job' USING ERRCODE = '55000';
  END IF;
  IF p_storage_path !~ ('^' || v_job.user_id::text || '/import-' || replace(v_job.id::text, '-', '') || '\.(mp4|mov|m4v)$')
     OR p_mime_type NOT IN ('video/mp4', 'video/quicktime', 'video/x-m4v')
     OR p_size_bytes < 1 OR p_size_bytes > 52428800
     OR char_length(btrim(coalesce(p_original_filename, ''))) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'imported video metadata is invalid' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.uploaded_videos (
    user_id, original_filename, storage_path, mime_type, size_bytes, source_shortcode
  ) VALUES (
    v_job.user_id, left(btrim(p_original_filename), 255), p_storage_path,
    p_mime_type, p_size_bytes, v_job.shortcode
  )
  ON CONFLICT (user_id, (lower(source_shortcode)))
    WHERE source_shortcode IS NOT NULL AND storage_path IS NOT NULL
  DO NOTHING
  RETURNING id INTO v_video_id;

  IF v_video_id IS NULL THEN
    SELECT v.id INTO v_video_id
    FROM public.uploaded_videos AS v
    WHERE v.user_id = v_job.user_id
      AND lower(v.source_shortcode) = lower(v_job.shortcode)
      AND v.storage_path IS NOT NULL
    ORDER BY v.created_at DESC
    LIMIT 1;
    IF v_video_id IS NULL THEN
      RAISE EXCEPTION 'video metadata could not be registered' USING ERRCODE = '23505';
    END IF;
  END IF;

  UPDATE public.video_import_jobs AS j
  SET status = 'ready', progress = 100, stage = 'Özel bulut arşivine kaydedildi',
      uploaded_video_id = v_video_id, active_storage_path = NULL,
      error_message = NULL, updated_at = now(), finished_at = now()
  WHERE j.id = p_import_id;
  RETURN v_video_id;
END;
$$;
REVOKE ALL ON FUNCTION public.finish_video_import(uuid, text, text, text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_video_import(uuid, text, text, text, bigint) TO service_role;

-- Keep manual deletion available to the owner, but only finalize metadata after
-- the Storage object itself is absent.
CREATE OR REPLACE FUNCTION public.finish_uploaded_video_cleanup(p_uploaded_video_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner_id uuid;
  v_storage_path text;
BEGIN
  IF coalesce(auth.role(), '') NOT IN ('service_role', 'authenticated') THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  SELECT v.user_id, v.storage_path INTO v_owner_id, v_storage_path
  FROM public.uploaded_videos AS v
  WHERE v.id = p_uploaded_video_id
    AND v.cleanup_pending
    AND v.storage_path IS NOT NULL
    AND (auth.role() = 'service_role' OR v.user_id = auth.uid())
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF EXISTS (
    SELECT 1 FROM storage.objects AS o
    WHERE o.bucket_id = 'reelflow-original-videos'
      AND o.name = v_storage_path
  ) THEN
    RAISE EXCEPTION 'storage_object_still_exists' USING ERRCODE = '55000';
  END IF;
  UPDATE public.reels_queue AS q
  SET status = 'cancelled', stage = 'Kaynak video depodan silindi',
      error_message = NULL, updated_at = now()
  WHERE q.uploaded_video_id = p_uploaded_video_id
    AND q.user_id = v_owner_id
    AND q.status = 'failed';
  UPDATE public.uploaded_videos AS v
  SET storage_path = NULL, cleanup_pending = false, cleaned_at = now()
  WHERE v.id = p_uploaded_video_id AND v.user_id = v_owner_id;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.finish_uploaded_video_cleanup(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finish_uploaded_video_cleanup(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
