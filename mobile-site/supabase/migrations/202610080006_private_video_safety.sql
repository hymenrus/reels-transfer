-- Private temporary outputs for worker-side video conversion and two cleanup safety fixes.
BEGIN;

CREATE TABLE IF NOT EXISTS public.worker_temporary_video_objects (
  storage_path text PRIMARY KEY CHECK (storage_path ~ '^worker-temp/[0-9a-f]{32}\.mp4$'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS worker_temporary_video_objects_created_idx
  ON public.worker_temporary_video_objects (created_at);
ALTER TABLE public.worker_temporary_video_objects ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.worker_temporary_video_objects FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.worker_temporary_video_objects TO service_role;

DROP POLICY IF EXISTS "ReelFlow users replace only untracked originals" ON storage.objects;
CREATE POLICY "ReelFlow users replace only untracked originals"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id = 'reelflow-original-videos'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
    AND NOT EXISTS (
      SELECT 1 FROM public.uploaded_videos AS v
      WHERE v.user_id = (SELECT auth.uid()) AND v.storage_path = name
    )
  )
  WITH CHECK (
    bucket_id = 'reelflow-original-videos'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
    AND NOT EXISTS (
      SELECT 1 FROM public.uploaded_videos AS v
      WHERE v.user_id = (SELECT auth.uid()) AND v.storage_path = name
    )
  );

-- Do not accept library jobs for accounts that cannot be loaded by the worker.
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
  JOIN public.instagram_credentials AS c
    ON c.instagram_account_id = a.id AND c.user_id = a.user_id
  WHERE a.id = p_instagram_account_id
    AND a.user_id = v_user_id
    AND a.disconnected_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Instagram account is not connected or authorized for this user' USING ERRCODE = '42501';
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

-- Leave failed queue records retryable until Storage confirms deletion.
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
  UPDATE public.uploaded_videos AS v
  SET cleanup_pending = true
  WHERE v.id = p_uploaded_video_id AND v.user_id = v_user_id;
  RETURN QUERY SELECT v_path;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_uploaded_video_cleanup(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_uploaded_video_cleanup(uuid) TO authenticated;

-- The caller reaches this only after Storage removal succeeds. Queue cancellation
-- and metadata cleanup then commit atomically; failed removal leaves retry intact.
CREATE OR REPLACE FUNCTION public.finish_uploaded_video_cleanup(
  p_uploaded_video_id uuid
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner_id uuid;
BEGIN
  IF coalesce(auth.role(), '') NOT IN ('service_role', 'authenticated') THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  SELECT v.user_id INTO v_owner_id
  FROM public.uploaded_videos AS v
  WHERE v.id = p_uploaded_video_id
    AND v.cleanup_pending
    AND (auth.role() = 'service_role' OR v.user_id = auth.uid())
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
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

COMMENT ON TABLE public.worker_temporary_video_objects IS
  'Service-role-only registry for private, short-lived transcoded MP4 objects used by Meta ingestion; stale entries are removed by the worker.';
NOTIFY pgrst, 'reload schema';
COMMIT;
