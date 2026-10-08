-- Show project-wide Supabase Storage usage and support private, selectable Reel covers.
BEGIN;

-- Supabase Free storage is a shared project quota. This aggregate exposes no paths,
-- filenames, bucket names, or per-user breakdown to authenticated clients.
CREATE OR REPLACE FUNCTION public.reelflow_storage_usage()
RETURNS TABLE(used_bytes bigint, quota_bytes bigint, remaining_bytes bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_used_bytes bigint;
  v_quota_bytes constant bigint := 1073741824;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(SUM(
    CASE WHEN (o.metadata->>'size') ~ '^[0-9]+$'
      THEN (o.metadata->>'size')::bigint ELSE 0 END
  ), 0)::bigint
  INTO v_used_bytes
  FROM storage.objects AS o;
  RETURN QUERY SELECT v_used_bytes, v_quota_bytes, greatest(0, v_quota_bytes - v_used_bytes);
END;
$$;
REVOKE ALL ON FUNCTION public.reelflow_storage_usage() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reelflow_storage_usage() TO authenticated;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('reelflow-cover-images', 'reelflow-cover-images', false, 8388608, ARRAY['image/jpeg']::text[])
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  public = false,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE TABLE IF NOT EXISTS public.video_cover_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  storage_path text NOT NULL UNIQUE,
  original_filename text NOT NULL CHECK (char_length(btrim(original_filename)) BETWEEN 1 AND 255),
  mime_type text NOT NULL DEFAULT 'image/jpeg' CHECK (mime_type = 'image/jpeg'),
  size_bytes bigint NOT NULL CHECK (size_bytes BETWEEN 1 AND 8388608),
  cleanup_pending boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT video_cover_images_owner_path_check CHECK (
    storage_path = user_id::text || '/' || replace(id::text, '-', '') || '.jpg'
  )
);
CREATE INDEX IF NOT EXISTS video_cover_images_owner_created_idx
  ON public.video_cover_images (user_id, created_at DESC);
ALTER TABLE public.video_cover_images ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.video_cover_images FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.video_cover_images TO authenticated;
DROP POLICY IF EXISTS "ReelFlow users read their own cover images" ON public.video_cover_images;
CREATE POLICY "ReelFlow users read their own cover images"
  ON public.video_cover_images FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);
DROP POLICY IF EXISTS "ReelFlow users register their own cover images" ON public.video_cover_images;
CREATE POLICY "ReelFlow users register their own cover images"
  ON public.video_cover_images FOR INSERT TO authenticated
  WITH CHECK (
    (SELECT auth.uid()) = user_id
    AND cleanup_pending = false
    AND size_bytes BETWEEN 1 AND 8388608
    AND mime_type = 'image/jpeg'
    AND storage_path = user_id::text || '/' || replace(id::text, '-', '') || '.jpg'
  );

ALTER TABLE public.reels_queue ADD COLUMN IF NOT EXISTS cover_image_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'reels_queue_cover_image_id_fkey'
      AND conrelid = 'public.reels_queue'::regclass
  ) THEN
    ALTER TABLE public.reels_queue
      ADD CONSTRAINT reels_queue_cover_image_id_fkey
      FOREIGN KEY (cover_image_id) REFERENCES public.video_cover_images(id) ON DELETE SET NULL;
  END IF;
END;
$$;
CREATE INDEX IF NOT EXISTS reels_queue_cover_image_id_idx
  ON public.reels_queue (cover_image_id) WHERE cover_image_id IS NOT NULL;

DROP POLICY IF EXISTS "ReelFlow users upload their own private Reel covers" ON storage.objects;
CREATE POLICY "ReelFlow users upload their own private Reel covers"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'reelflow-cover-images'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
    AND name ~ ('^' || (SELECT auth.uid())::text || '/[0-9a-f]{32}\.jpg$')
  );
DROP POLICY IF EXISTS "ReelFlow users read their own private Reel covers" ON storage.objects;
CREATE POLICY "ReelFlow users read their own private Reel covers"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'reelflow-cover-images'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
  );
DROP POLICY IF EXISTS "ReelFlow users delete only untracked or claimed Reel covers" ON storage.objects;
CREATE POLICY "ReelFlow users delete only untracked or claimed Reel covers"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id = 'reelflow-cover-images'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
    AND (
      NOT EXISTS (
        SELECT 1 FROM public.video_cover_images AS c
        WHERE c.user_id = (SELECT auth.uid()) AND c.storage_path = name
      )
      OR EXISTS (
        SELECT 1 FROM public.video_cover_images AS c
        WHERE c.user_id = (SELECT auth.uid()) AND c.storage_path = name
          AND c.cleanup_pending
          AND NOT EXISTS (
            SELECT 1 FROM public.reels_queue AS q
            WHERE q.cover_image_id = c.id AND q.status IN ('queued', 'processing')
          )
      )
    )
  );

-- Atomic per-job enqueue: the chosen cover must belong to the same signed-in owner
-- and cannot be in cleanup while the queue row is created.
CREATE OR REPLACE FUNCTION public.enqueue_uploaded_video_with_cover(
  p_uploaded_video_id uuid,
  p_instagram_account_id uuid,
  p_caption text,
  p_rights_confirmed boolean,
  p_cover_image_id uuid DEFAULT NULL
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
  WHERE v.id = p_uploaded_video_id AND v.user_id = v_user_id
    AND v.storage_path IS NOT NULL AND NOT v.cleanup_pending
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'video is unavailable or being removed' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.instagram_accounts AS a
  WHERE a.id = p_instagram_account_id AND a.user_id = v_user_id AND a.disconnected_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Instagram account is not connected to this user' USING ERRCODE = '42501';
  END IF;
  IF p_cover_image_id IS NOT NULL THEN
    PERFORM 1 FROM public.video_cover_images AS c
    WHERE c.id = p_cover_image_id AND c.user_id = v_user_id
      AND NOT c.cleanup_pending AND c.mime_type = 'image/jpeg'
      AND c.size_bytes BETWEEN 1 AND 8388608
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'cover image is unavailable or belongs to another user' USING ERRCODE = '42501';
    END IF;
  END IF;
  INSERT INTO public.reels_queue (
    user_id, instagram_account_id, uploaded_video_id, cover_image_id,
    shortcode, source_url, caption, status, progress, stage, rights_confirmed, publish_now
  ) VALUES (
    v_user_id, p_instagram_account_id, p_uploaded_video_id, p_cover_image_id,
    'upload_' || replace(p_uploaded_video_id::text, '-', ''), '',
    coalesce(p_caption, ''), 'queued', 0, 'Kuyrukta', true, false
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_queue_id;
  RETURN v_queue_id;
END;
$$;
REVOKE ALL ON FUNCTION public.enqueue_uploaded_video_with_cover(uuid, uuid, text, boolean, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enqueue_uploaded_video_with_cover(uuid, uuid, text, boolean, uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.claim_video_cover_cleanup(p_cover_image_id uuid)
RETURNS TABLE(storage_path text)
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
  PERFORM 1 FROM public.video_cover_images AS c
  WHERE c.id = p_cover_image_id AND c.user_id = v_user_id AND NOT c.cleanup_pending
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.reels_queue AS q
    WHERE q.cover_image_id = p_cover_image_id AND q.user_id = v_user_id
      AND q.status IN ('queued', 'processing')
  ) THEN
    RAISE EXCEPTION 'cover_in_use' USING ERRCODE = '55000';
  END IF;
  RETURN QUERY
  UPDATE public.video_cover_images AS c
  SET cleanup_pending = true
  WHERE c.id = p_cover_image_id AND c.user_id = v_user_id AND NOT c.cleanup_pending
  RETURNING c.storage_path;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_video_cover_cleanup(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_video_cover_cleanup(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.finish_video_cover_cleanup(p_cover_image_id uuid)
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
  DELETE FROM public.video_cover_images AS c
  WHERE c.id = p_cover_image_id AND c.user_id = v_user_id AND c.cleanup_pending
    AND NOT EXISTS (
      SELECT 1 FROM storage.objects AS o
      WHERE o.bucket_id = 'reelflow-cover-images' AND o.name = c.storage_path
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.reels_queue AS q
      WHERE q.cover_image_id = c.id AND q.status IN ('queued', 'processing')
    );
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.finish_video_cover_cleanup(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.finish_video_cover_cleanup(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.release_video_cover_cleanup(p_cover_image_id uuid)
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
  UPDATE public.video_cover_images AS c SET cleanup_pending = false
  WHERE c.id = p_cover_image_id AND c.user_id = v_user_id AND c.cleanup_pending
    AND EXISTS (
      SELECT 1 FROM storage.objects AS o
      WHERE o.bucket_id = 'reelflow-cover-images' AND o.name = c.storage_path
    );
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.release_video_cover_cleanup(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.release_video_cover_cleanup(uuid) TO authenticated;

COMMENT ON TABLE public.video_cover_images IS
  'Owner-scoped private JPEG Reel covers; Meta receives only short-lived signed URLs at publish time.';
COMMENT ON COLUMN public.reels_queue.cover_image_id IS
  'Optional user-owned private JPEG cover chosen for this queued Reel.';

NOTIFY pgrst, 'reload schema';
COMMIT;
