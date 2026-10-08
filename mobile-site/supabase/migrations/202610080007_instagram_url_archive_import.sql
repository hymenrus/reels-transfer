-- Queue Instagram Reel URL imports for the private cloud archive.
BEGIN;

ALTER TABLE public.uploaded_videos
  ADD COLUMN IF NOT EXISTS source_shortcode text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uploaded_videos_source_shortcode_check'
      AND conrelid = 'public.uploaded_videos'::regclass
  ) THEN
    ALTER TABLE public.uploaded_videos
      ADD CONSTRAINT uploaded_videos_source_shortcode_check
      CHECK (source_shortcode IS NULL OR source_shortcode ~ '^[A-Za-z0-9_-]{1,64}$');
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS uploaded_videos_owner_source_shortcode_active_uq
  ON public.uploaded_videos (user_id, lower(source_shortcode))
  WHERE source_shortcode IS NOT NULL AND storage_path IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.video_import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  shortcode text NOT NULL CHECK (shortcode ~ '^[A-Za-z0-9_-]{1,64}$'),
  source_url text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'processing', 'ready', 'failed', 'cancelled')),
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  stage text NOT NULL DEFAULT 'Bulut indirme kuyruğunda',
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error_message text,
  rights_confirmed boolean NOT NULL DEFAULT false CHECK (rights_confirmed),
  uploaded_video_id uuid REFERENCES public.uploaded_videos(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS video_import_jobs_owner_created_idx
  ON public.video_import_jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS video_import_jobs_pending_idx
  ON public.video_import_jobs (created_at)
  WHERE status = 'queued';
CREATE UNIQUE INDEX IF NOT EXISTS video_import_jobs_active_shortcode_uq
  ON public.video_import_jobs (user_id, lower(shortcode))
  WHERE status IN ('queued', 'processing');

ALTER TABLE public.video_import_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.video_import_jobs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.video_import_jobs TO authenticated;
GRANT ALL ON public.video_import_jobs TO service_role;
DROP POLICY IF EXISTS "ReelFlow users read their own video imports" ON public.video_import_jobs;
CREATE POLICY "ReelFlow users read their own video imports"
  ON public.video_import_jobs FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE OR REPLACE FUNCTION public.enqueue_video_import(
  p_source_url text,
  p_rights_confirmed boolean
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
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
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
      AND NOT v.cleanup_pending
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
REVOKE ALL ON FUNCTION public.enqueue_video_import(text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enqueue_video_import(text, boolean) TO authenticated;

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
        AND NOT v.cleanup_pending
    );
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.retry_video_import(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.retry_video_import(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.claim_video_import_job()
RETURNS TABLE(id uuid, user_id uuid, shortcode text, source_url text, attempts integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
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
  RETURNING j.id, j.user_id, j.shortcode, j.source_url, j.attempts;
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
  IF v_job.status <> 'processing' THEN
    RAISE EXCEPTION 'video import is not processing' USING ERRCODE = '55000';
  END IF;
  IF p_storage_path !~ ('^' || v_job.user_id::text || '/[A-Za-z0-9_-]+\.(mp4|mov|m4v)$')
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
      AND NOT v.cleanup_pending
    ORDER BY v.created_at DESC
    LIMIT 1;
    IF v_video_id IS NULL THEN
      RAISE EXCEPTION 'video metadata could not be registered' USING ERRCODE = '23505';
    END IF;
  END IF;

  UPDATE public.video_import_jobs AS j
  SET status = 'ready', progress = 100, stage = 'Özel bulut arşivine kaydedildi',
      uploaded_video_id = v_video_id, error_message = NULL,
      updated_at = now(), finished_at = now()
  WHERE j.id = p_import_id;
  RETURN v_video_id;
END;
$$;
REVOKE ALL ON FUNCTION public.finish_video_import(uuid, text, text, text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_video_import(uuid, text, text, text, bigint) TO service_role;

CREATE OR REPLACE FUNCTION public.fail_video_import(p_import_id uuid, p_error_message text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  UPDATE public.video_import_jobs AS j
  SET status = 'failed', progress = 0, stage = 'Instagram’dan indirilemedi',
      error_message = left(coalesce(p_error_message, 'Bulut indirme tamamlanamadı.'), 1000),
      updated_at = now(), finished_at = now()
  WHERE j.id = p_import_id AND j.status = 'processing';
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.fail_video_import(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_video_import(uuid, text) TO service_role;

COMMENT ON TABLE public.video_import_jobs IS
  'Private owner-visible queue of Instagram URL archive downloads processed by the scheduled worker.';
COMMENT ON COLUMN public.uploaded_videos.source_shortcode IS
  'Instagram short code for an archived URL import; retained after the private object is cleaned up.';
NOTIFY pgrst, 'reload schema';
COMMIT;
