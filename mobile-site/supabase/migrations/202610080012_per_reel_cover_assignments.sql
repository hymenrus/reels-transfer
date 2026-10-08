-- Allow each public Reel URL queue item to reference an owner-owned archived cover.
BEGIN;

CREATE OR REPLACE FUNCTION public.enqueue_reel_with_cover(
  p_shortcode text,
  p_source_url text,
  p_caption text DEFAULT '',
  p_rights_confirmed boolean DEFAULT false,
  p_instagram_account_id uuid DEFAULT NULL,
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

  IF p_cover_image_id IS NOT NULL THEN
    PERFORM 1 FROM public.video_cover_images AS c
    WHERE c.id = p_cover_image_id
      AND c.user_id = v_user_id
      AND NOT c.cleanup_pending
      AND c.mime_type = 'image/jpeg'
      AND c.size_bytes BETWEEN 1 AND 8388608
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'cover image is unavailable or belongs to another user' USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Reuse the established URL, rights, caption and Instagram-account validation.
  v_queue_id := public.enqueue_reel(
    p_shortcode,
    p_source_url,
    p_caption,
    p_rights_confirmed,
    p_instagram_account_id
  );

  IF v_queue_id IS NOT NULL AND p_cover_image_id IS NOT NULL THEN
    UPDATE public.reels_queue AS q
    SET cover_image_id = p_cover_image_id
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
REVOKE ALL ON FUNCTION public.enqueue_reel_with_cover(text, text, text, boolean, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.enqueue_reel_with_cover(text, text, text, boolean, uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.enqueue_reel_with_cover(text, text, text, boolean, uuid, uuid) IS
  'Enqueue a validated Instagram Reel for its selected account and optionally attach an owner-owned private cover image.';

NOTIFY pgrst, 'reload schema';
COMMIT;
