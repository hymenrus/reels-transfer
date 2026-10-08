-- Persist cover selection counts so automatic cover assignment remains varied across devices and batches.
BEGIN;

ALTER TABLE public.video_cover_images
  ADD COLUMN IF NOT EXISTS selection_count bigint NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'video_cover_images_selection_count_check'
      AND conrelid = 'public.video_cover_images'::regclass
  ) THEN
    ALTER TABLE public.video_cover_images
      ADD CONSTRAINT video_cover_images_selection_count_check CHECK (selection_count >= 0);
  END IF;
END;
$$;

-- Keep the previous six-argument RPC available to already-open clients while
-- the new PWA version starts calling this seven-argument variant.
CREATE OR REPLACE FUNCTION public.enqueue_reel_with_auto_cover(
  p_shortcode text,
  p_source_url text,
  p_caption text DEFAULT '',
  p_rights_confirmed boolean DEFAULT false,
  p_instagram_account_id uuid DEFAULT NULL,
  p_cover_image_id uuid DEFAULT NULL,
  p_auto_select_cover boolean DEFAULT true
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_queue_id uuid;
  v_cover_id uuid := p_cover_image_id;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;

  IF v_cover_id IS NOT NULL THEN
    PERFORM 1 FROM public.video_cover_images AS c
    WHERE c.id = v_cover_id
      AND c.user_id = v_user_id
      AND NOT c.cleanup_pending
      AND c.mime_type = 'image/jpeg'
      AND c.size_bytes BETWEEN 1 AND 8388608
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'cover image is unavailable or belongs to another user' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Reuse the existing URL, rights, caption and account validation. Duplicates
  -- return NULL before touching the cover counters.
  v_queue_id := public.enqueue_reel(
    p_shortcode,
    p_source_url,
    p_caption,
    p_rights_confirmed,
    p_instagram_account_id
  );
  IF v_queue_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_cover_id IS NULL AND p_auto_select_cover IS TRUE THEN
    -- Serialize only cover selection for this owner so parallel devices also
    -- pick the least-used cover before any image gets its next selection.
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(v_user_id::text, 0)
    );
    SELECT c.id INTO v_cover_id
    FROM public.video_cover_images AS c
    WHERE c.user_id = v_user_id
      AND NOT c.cleanup_pending
      AND c.mime_type = 'image/jpeg'
      AND c.size_bytes BETWEEN 1 AND 8388608
    ORDER BY c.selection_count ASC, pg_catalog.random()
    LIMIT 1
    FOR UPDATE;
  END IF;

  IF v_cover_id IS NOT NULL THEN
    UPDATE public.video_cover_images AS c
    SET selection_count = c.selection_count + 1
    WHERE c.id = v_cover_id AND c.user_id = v_user_id AND NOT c.cleanup_pending;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'cover image is unavailable or belongs to another user' USING ERRCODE = '42501';
    END IF;

    UPDATE public.reels_queue AS q
    SET cover_image_id = v_cover_id
    WHERE q.id = v_queue_id
      AND q.user_id = v_user_id
      AND q.status = 'queued'
      AND q.cover_image_id IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'queued Reel cover could not be attached' USING ERRCODE = '55000';
    END IF;
  END IF;

  RETURN v_queue_id;
END;
$$;
REVOKE ALL ON FUNCTION public.enqueue_reel_with_auto_cover(text, text, text, boolean, uuid, uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enqueue_reel_with_auto_cover(text, text, text, boolean, uuid, uuid, boolean) TO authenticated;

COMMENT ON FUNCTION public.enqueue_reel_with_auto_cover(text, text, text, boolean, uuid, uuid, boolean) IS
  'Enqueue a Reel and attach an owner-owned cover. Automatic choices randomize among least-used covers across devices; explicit no-cover requests remain uncovered.';

NOTIFY pgrst, 'reload schema';
COMMIT;
