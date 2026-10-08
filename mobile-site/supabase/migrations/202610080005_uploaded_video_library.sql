-- Private original-video library for ReelFlow. Files live in Supabase Storage,
-- never in public buckets or queue rows; storage paths are scoped to auth.uid().
BEGIN;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'reelflow-original-videos',
  'reelflow-original-videos',
  false,
  52428800,
  ARRAY['video/mp4', 'video/quicktime', 'video/x-m4v']::text[]
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  public = false,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE TABLE IF NOT EXISTS public.uploaded_videos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  original_filename text NOT NULL CHECK (char_length(btrim(original_filename)) BETWEEN 1 AND 255),
  storage_path text UNIQUE,
  mime_type text NOT NULL CHECK (mime_type IN ('video/mp4', 'video/quicktime', 'video/x-m4v')),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 52428800),
  cleanup_pending boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  cleaned_at timestamptz,
  CONSTRAINT uploaded_videos_owner_path_check CHECK (
    storage_path IS NULL OR (
      split_part(storage_path, '/', 1) = user_id::text
      AND storage_path !~ '(^|/)\.\.?(/|$)'
      AND storage_path ~ '^[0-9a-f-]+/[A-Za-z0-9_-]+\.(mp4|mov|m4v)$'
    )
  )
);
CREATE INDEX IF NOT EXISTS uploaded_videos_owner_created_idx
  ON public.uploaded_videos (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS uploaded_videos_cleanup_idx
  ON public.uploaded_videos (created_at)
  WHERE storage_path IS NOT NULL;

ALTER TABLE public.reels_queue
  ADD COLUMN IF NOT EXISTS uploaded_video_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reels_queue_uploaded_video_id_fkey'
      AND conrelid = 'public.reels_queue'::regclass
  ) THEN
    ALTER TABLE public.reels_queue
      ADD CONSTRAINT reels_queue_uploaded_video_id_fkey
      FOREIGN KEY (uploaded_video_id) REFERENCES public.uploaded_videos(id) ON DELETE SET NULL;
  END IF;
END;
$$;
CREATE INDEX IF NOT EXISTS reels_queue_uploaded_video_id_idx
  ON public.reels_queue (uploaded_video_id)
  WHERE uploaded_video_id IS NOT NULL;

ALTER TABLE public.uploaded_videos ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.uploaded_videos FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.uploaded_videos TO authenticated;
DROP POLICY IF EXISTS "ReelFlow users read their own uploaded videos" ON public.uploaded_videos;
CREATE POLICY "ReelFlow users read their own uploaded videos"
  ON public.uploaded_videos FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);
DROP POLICY IF EXISTS "ReelFlow users register their own uploaded videos" ON public.uploaded_videos;
CREATE POLICY "ReelFlow users register their own uploaded videos"
  ON public.uploaded_videos FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT auth.uid()) = user_id
    AND storage_path IS NOT NULL
    AND split_part(storage_path, '/', 1) = user_id::text
    AND cleanup_pending = false
  );

DROP POLICY IF EXISTS "ReelFlow users upload originals into their private folder" ON storage.objects;
CREATE POLICY "ReelFlow users upload originals into their private folder"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'reelflow-original-videos'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );
DROP POLICY IF EXISTS "ReelFlow users read their private originals" ON storage.objects;
CREATE POLICY "ReelFlow users read their private originals"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'reelflow-original-videos'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );
DROP POLICY IF EXISTS "ReelFlow users delete only untracked or claimed originals" ON storage.objects;
CREATE POLICY "ReelFlow users delete only untracked or claimed originals"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'reelflow-original-videos'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
    AND (
      NOT EXISTS (
        SELECT 1 FROM public.uploaded_videos AS v
        WHERE v.user_id = (SELECT auth.uid()) AND v.storage_path = name
      )
      OR EXISTS (
        SELECT 1 FROM public.uploaded_videos AS v
        WHERE v.user_id = (SELECT auth.uid()) AND v.storage_path = name AND v.cleanup_pending
      )
    )
  );

CREATE OR REPLACE FUNCTION public.enqueue_uploaded_video(
  p_uploaded_video_id uuid,
  p_instagram_account_id uuid,
  p_caption text,
  p_rights_confirmed boolean
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_queue_id uuid;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_rights_confirmed IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'content rights confirmation required' USING ERRCODE = '22023';
  END IF;
  IF char_length(coalesce(p_caption, '')) > 2200 THEN
    RAISE EXCEPTION 'caption exceeds Instagram limit' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.uploaded_videos AS v
  WHERE v.id = p_uploaded_video_id
    AND v.user_id = v_user_id
    AND v.storage_path IS NOT NULL
    AND NOT v.cleanup_pending
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'video is unavailable or being removed' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.instagram_accounts AS a
  WHERE a.id = p_instagram_account_id
    AND a.user_id = v_user_id
    AND a.disconnected_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Instagram account is not connected to this user' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.reels_queue (
    user_id, instagram_account_id, uploaded_video_id, shortcode, source_url,
    caption, status, progress, stage, rights_confirmed, publish_now
  ) VALUES (
    v_user_id, p_instagram_account_id, p_uploaded_video_id,
    'upload_' || replace(p_uploaded_video_id::text, '-', ''), '',
    coalesce(p_caption, ''), 'queued', 0, 'Kuyrukta', true, false
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_queue_id;
  RETURN v_queue_id;
END;
$$;
REVOKE ALL ON FUNCTION public.enqueue_uploaded_video(uuid, uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enqueue_uploaded_video(uuid, uuid, text, boolean) TO authenticated;

-- A user can explicitly remove an unused original. Failed queue attempts are
-- cancelled as part of that explicit deletion; queued/processing jobs are not.
CREATE OR REPLACE FUNCTION public.claim_uploaded_video_cleanup(
  p_uploaded_video_id uuid
) RETURNS TABLE(storage_path text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_path text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  SELECT v.storage_path INTO v_path
  FROM public.uploaded_videos AS v
  WHERE v.id = p_uploaded_video_id
    AND v.user_id = v_user_id
    AND v.storage_path IS NOT NULL
    AND NOT v.cleanup_pending
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.reels_queue AS q
    WHERE q.uploaded_video_id = p_uploaded_video_id
      AND q.user_id = v_user_id
      AND q.status IN ('queued', 'processing')
  ) THEN
    RAISE EXCEPTION 'video_in_use' USING ERRCODE = '55000';
  END IF;
  UPDATE public.reels_queue AS q
  SET status = 'cancelled', stage = 'Kaynak video kullanıcı tarafından silindi',
      error_message = NULL, updated_at = now()
  WHERE q.uploaded_video_id = p_uploaded_video_id
    AND q.user_id = v_user_id
    AND q.status = 'failed';
  UPDATE public.uploaded_videos AS v
  SET cleanup_pending = true
  WHERE v.id = p_uploaded_video_id AND v.user_id = v_user_id;
  RETURN QUERY SELECT v_path;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_uploaded_video_cleanup(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_uploaded_video_cleanup(uuid) TO authenticated;

-- Claim files only after every queued/failed use has ended and at least one
-- publication succeeded. Already-claimed files are returned for retry.
CREATE OR REPLACE FUNCTION public.claim_uploaded_video_cleanups(
  p_limit integer DEFAULT 50
) RETURNS TABLE(uploaded_video_id uuid, storage_path text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  WITH candidates AS MATERIALIZED (
    SELECT v.id
    FROM public.uploaded_videos AS v
    WHERE v.storage_path IS NOT NULL
      AND (
        v.cleanup_pending
        OR (
          EXISTS (
            SELECT 1 FROM public.reels_queue AS q
            WHERE q.uploaded_video_id = v.id AND q.status = 'published'
          )
          AND NOT EXISTS (
            SELECT 1 FROM public.reels_queue AS q
            WHERE q.uploaded_video_id = v.id AND q.status IN ('queued', 'processing', 'failed')
          )
        )
      )
    ORDER BY v.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT greatest(1, least(coalesce(p_limit, 50), 200))
  ), claimed AS (
    UPDATE public.uploaded_videos AS v
    SET cleanup_pending = true
    FROM candidates AS c
    WHERE v.id = c.id
    RETURNING v.id, v.storage_path
  )
  SELECT claimed.id, claimed.storage_path FROM claimed;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_uploaded_video_cleanups(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_uploaded_video_cleanups(integer) TO service_role;

CREATE OR REPLACE FUNCTION public.finish_uploaded_video_cleanup(
  p_uploaded_video_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF coalesce(auth.role(), '') NOT IN ('service_role', 'authenticated') THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  UPDATE public.uploaded_videos AS v
  SET storage_path = NULL, cleanup_pending = false, cleaned_at = now()
  WHERE v.id = p_uploaded_video_id
    AND v.cleanup_pending
    AND (auth.role() = 'service_role' OR v.user_id = auth.uid());
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.finish_uploaded_video_cleanup(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finish_uploaded_video_cleanup(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.release_uploaded_video_cleanup(
  p_uploaded_video_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF coalesce(auth.role(), '') NOT IN ('service_role', 'authenticated') THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  UPDATE public.uploaded_videos AS v
  SET cleanup_pending = false
  WHERE v.id = p_uploaded_video_id
    AND v.cleanup_pending
    AND v.storage_path IS NOT NULL
    AND (auth.role() = 'service_role' OR v.user_id = auth.uid());
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.release_uploaded_video_cleanup(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.release_uploaded_video_cleanup(uuid) TO authenticated, service_role;

COMMENT ON TABLE public.uploaded_videos IS
  'Private user-owned original video files; binary objects are stored in the private reelflow-original-videos bucket and removed after all successful queue uses finish.';
COMMENT ON COLUMN public.reels_queue.uploaded_video_id IS
  'Optional owner-scoped original-video source; source_url remains empty for library uploads.';

NOTIFY pgrst, 'reload schema';
COMMIT;
