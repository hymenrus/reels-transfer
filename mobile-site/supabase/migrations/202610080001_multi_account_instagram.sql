-- ReelFlow multi-account migration. Existing credentials and queue history are retained.

-- Give every Instagram account a stable internal identity while allowing many accounts per app user.
ALTER TABLE public.instagram_accounts
  ADD COLUMN IF NOT EXISTS id uuid,
  ADD COLUMN IF NOT EXISTS disconnected_at timestamptz;
UPDATE public.instagram_accounts SET id = gen_random_uuid() WHERE id IS NULL;
ALTER TABLE public.instagram_accounts ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE public.instagram_accounts ALTER COLUMN id SET NOT NULL;

-- Break the old credentials -> accounts(user_id) relationship before replacing that key.
ALTER TABLE public.instagram_credentials DROP CONSTRAINT IF EXISTS instagram_credentials_instagram_account_id_fkey;
ALTER TABLE public.instagram_credentials DROP CONSTRAINT IF EXISTS instagram_credentials_user_id_fkey;
ALTER TABLE public.instagram_credentials DROP CONSTRAINT IF EXISTS instagram_credentials_pkey;
ALTER TABLE public.instagram_credentials ADD COLUMN IF NOT EXISTS instagram_account_id uuid;
UPDATE public.instagram_credentials AS c
SET instagram_account_id = a.id
FROM public.instagram_accounts AS a
WHERE c.user_id = a.user_id AND c.instagram_account_id IS NULL;

ALTER TABLE public.instagram_accounts DROP CONSTRAINT IF EXISTS instagram_accounts_pkey;
ALTER TABLE public.instagram_accounts DROP CONSTRAINT IF EXISTS instagram_accounts_user_id_key;
ALTER TABLE public.instagram_accounts ADD CONSTRAINT instagram_accounts_pkey PRIMARY KEY (id);
ALTER TABLE public.instagram_accounts
  ADD CONSTRAINT instagram_accounts_id_user_id_key UNIQUE (id, user_id);
ALTER TABLE public.instagram_credentials ALTER COLUMN instagram_account_id SET NOT NULL;
ALTER TABLE public.instagram_credentials ADD CONSTRAINT instagram_credentials_pkey PRIMARY KEY (instagram_account_id);
ALTER TABLE public.instagram_credentials
  ADD CONSTRAINT instagram_credentials_account_owner_fkey
  FOREIGN KEY (instagram_account_id, user_id) REFERENCES public.instagram_accounts(id, user_id) ON DELETE CASCADE;
ALTER TABLE public.instagram_credentials
  ADD CONSTRAINT instagram_credentials_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS instagram_accounts_user_id_idx ON public.instagram_accounts (user_id);
CREATE INDEX IF NOT EXISTS instagram_credentials_user_id_idx ON public.instagram_credentials (user_id);

-- Bind every queue item to its intended Instagram account. Preserve ambiguity rather than retargeting it.
ALTER TABLE public.reels_queue ADD COLUMN IF NOT EXISTS instagram_account_id uuid;
UPDATE public.reels_queue AS q
SET instagram_account_id = a.id
FROM public.instagram_accounts AS a
WHERE q.user_id = a.user_id
  AND q.instagram_account_id IS NULL
  AND (
    (q.status IN ('queued', 'processing', 'failed') AND EXISTS (
      SELECT 1 FROM public.instagram_credentials AS c
      WHERE c.instagram_account_id = a.id AND c.user_id = a.user_id
    ))
    OR (q.status = 'published' AND q.published_instagram_user_id = a.instagram_user_id)
  );
UPDATE public.reels_queue
SET stage = CASE WHEN status = 'queued' THEN 'Hedef Instagram hesabı seçilmeli' ELSE stage END,
    error_message = CASE WHEN status = 'failed' AND error_message IS NULL THEN 'Bu eski Reel için hedef Instagram hesabını seç.' ELSE error_message END
WHERE instagram_account_id IS NULL AND status IN ('queued', 'failed');

ALTER TABLE public.reels_queue DROP CONSTRAINT IF EXISTS reels_queue_instagram_account_id_fkey;
ALTER TABLE public.reels_queue
  ADD CONSTRAINT reels_queue_instagram_account_owner_fkey
  FOREIGN KEY (instagram_account_id, user_id) REFERENCES public.instagram_accounts(id, user_id);
CREATE INDEX IF NOT EXISTS reels_queue_account_status_created_idx
  ON public.reels_queue (instagram_account_id, status, created_at);
CREATE INDEX IF NOT EXISTS reels_queue_published_account_idx
  ON public.reels_queue (instagram_account_id, published_at DESC)
  WHERE status = 'published' AND ig_media_id IS NOT NULL;

-- A Reel may be posted once to each connected Instagram account, but not twice to the same account.
DROP INDEX IF EXISTS public.reels_queue_user_shortcode_uq;
DROP INDEX IF EXISTS public.reels_queue_user_shortcode_key_uq;
CREATE UNIQUE INDEX IF NOT EXISTS reels_queue_account_shortcode_uq
  ON public.reels_queue (user_id, instagram_account_id, shortcode_key);

-- Only validated security-definer RPCs may create queue rows with an account target.
REVOKE INSERT ON public.reels_queue FROM public, anon, authenticated;
DROP POLICY IF EXISTS "Users can add their own Reels" ON public.reels_queue;

DROP FUNCTION IF EXISTS public.enqueue_reel(text, text, text, boolean);
CREATE FUNCTION public.enqueue_reel(
  p_shortcode text,
  p_source_url text,
  p_caption text DEFAULT '',
  p_rights_confirmed boolean DEFAULT false,
  p_instagram_account_id uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_id uuid;
  v_account_id uuid := p_instagram_account_id;
  v_account_count bigint;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF p_rights_confirmed IS DISTINCT FROM true THEN RAISE EXCEPTION 'content rights confirmation required'; END IF;
  IF p_shortcode IS NULL OR p_shortcode !~ '^[A-Za-z0-9_-]{4,20}$' THEN RAISE EXCEPTION 'invalid shortcode'; END IF;
  IF p_source_url IS NULL OR p_source_url !~* '^https://(www[.])?instagram[.]com/(reel|reels|p)/[A-Za-z0-9_-]+/?$' THEN RAISE EXCEPTION 'invalid Instagram URL'; END IF;
  IF length(coalesce(p_caption, '')) > 2200 THEN RAISE EXCEPTION 'caption exceeds 2200 characters'; END IF;

  IF v_account_id IS NULL THEN
    -- Backward compatibility for an old one-account client; refuse ambiguity rather than guessing.
    SELECT a.id, count(*) OVER () INTO v_account_id, v_account_count
    FROM public.instagram_accounts AS a
    WHERE a.user_id = auth.uid()
      AND a.disconnected_at IS NULL
      AND EXISTS (SELECT 1 FROM public.instagram_credentials AS c WHERE c.instagram_account_id = a.id)
    ORDER BY a.connected_at DESC
    LIMIT 1;
    IF v_account_count IS NULL THEN RAISE EXCEPTION 'Instagram account required'; END IF;
    IF v_account_count <> 1 THEN RAISE EXCEPTION 'Instagram account selection required'; END IF;
  ELSIF NOT EXISTS (
    SELECT 1
    FROM public.instagram_accounts AS a
    JOIN public.instagram_credentials AS c ON c.instagram_account_id = a.id
    WHERE a.id = v_account_id AND a.user_id = auth.uid() AND a.disconnected_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Instagram account is unavailable';
  END IF;

  INSERT INTO public.reels_queue (user_id, instagram_account_id, shortcode, source_url, caption, rights_confirmed)
  VALUES (auth.uid(), v_account_id, p_shortcode, p_source_url, coalesce(p_caption, ''), true)
  ON CONFLICT (user_id, instagram_account_id, shortcode_key) DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.enqueue_reel(text, text, text, boolean, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.enqueue_reel(text, text, text, boolean, uuid) TO authenticated;

-- Explicitly assign an old/disconnected queue item; changing the active selector alone never retargets it.
CREATE OR REPLACE FUNCTION public.assign_reel_account(p_id uuid, p_instagram_account_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  IF p_id IS NULL OR p_instagram_account_id IS NULL THEN RAISE EXCEPTION 'reel and Instagram account are required'; END IF;
  UPDATE public.reels_queue AS q
  SET instagram_account_id = p_instagram_account_id,
      status = 'queued',
      progress = 0,
      stage = 'Hedef hesap seçildi · kuyrukta',
      error_message = NULL,
      updated_at = now()
  WHERE q.id = p_id
    AND q.user_id = auth.uid()
    AND q.status IN ('queued', 'failed')
    AND EXISTS (
      SELECT 1 FROM public.instagram_accounts AS a
      JOIN public.instagram_credentials AS c ON c.instagram_account_id = a.id
      WHERE a.id = p_instagram_account_id
        AND a.user_id = auth.uid()
        AND a.disconnected_at IS NULL
    );
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.assign_reel_account(uuid, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.assign_reel_account(uuid, uuid) TO authenticated;

-- Upsert by Meta's stable account ID. Reconnect restores the same internal account; another owner cannot claim it.
CREATE OR REPLACE FUNCTION public.save_instagram_connection(
  p_user_id uuid,
  p_instagram_user_id text,
  p_username text,
  p_access_token text,
  p_token_expires_at timestamptz,
  p_granted_scopes text[]
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_account_id uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required'; END IF;
  IF p_user_id IS NULL OR nullif(trim(p_instagram_user_id), '') IS NULL
     OR nullif(trim(p_username), '') IS NULL OR nullif(p_access_token, '') IS NULL
     OR p_token_expires_at <= now() THEN
    RAISE EXCEPTION 'invalid Instagram connection';
  END IF;
  IF NOT coalesce(p_granted_scopes, '{}'::text[]) @> ARRAY[
    'instagram_business_basic', 'instagram_business_content_publish'
  ]::text[] THEN
    RAISE EXCEPTION 'required Instagram publishing permissions were not granted';
  END IF;

  INSERT INTO public.instagram_accounts (
    user_id, instagram_user_id, username, granted_scopes,
    connected_at, token_expires_at, disconnected_at, updated_at
  ) VALUES (
    p_user_id, p_instagram_user_id, p_username, p_granted_scopes,
    now(), p_token_expires_at, NULL, now()
  )
  ON CONFLICT (instagram_user_id) DO UPDATE SET
    username = EXCLUDED.username,
    granted_scopes = EXCLUDED.granted_scopes,
    connected_at = now(),
    token_expires_at = EXCLUDED.token_expires_at,
    disconnected_at = NULL,
    updated_at = now()
  WHERE public.instagram_accounts.user_id = EXCLUDED.user_id
  RETURNING id INTO v_account_id;

  IF v_account_id IS NULL THEN RAISE EXCEPTION 'Instagram account already linked'; END IF;

  INSERT INTO public.instagram_credentials (user_id, instagram_account_id, access_token, refreshed_at, updated_at)
  VALUES (p_user_id, v_account_id, p_access_token, now(), now())
  ON CONFLICT (instagram_account_id) DO UPDATE SET
    user_id = EXCLUDED.user_id,
    access_token = EXCLUDED.access_token,
    refreshed_at = now(),
    updated_at = now();
END;
$$;
REVOKE ALL ON FUNCTION public.save_instagram_connection(uuid, text, text, text, timestamptz, text[]) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_instagram_connection(uuid, text, text, text, timestamptz, text[]) TO service_role;

-- Disconnect exactly one account without deleting its queue/history row.
CREATE OR REPLACE FUNCTION public.disconnect_instagram_account(p_user_id uuid, p_instagram_account_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required'; END IF;
  IF p_user_id IS NULL OR p_instagram_account_id IS NULL THEN RAISE EXCEPTION 'user and Instagram account are required'; END IF;
  UPDATE public.instagram_accounts
  SET disconnected_at = coalesce(disconnected_at, now()), updated_at = now()
  WHERE id = p_instagram_account_id AND user_id = p_user_id;
  IF NOT FOUND THEN RETURN false; END IF;
  DELETE FROM public.instagram_credentials
  WHERE instagram_account_id = p_instagram_account_id AND user_id = p_user_id;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.disconnect_instagram_account(uuid, uuid) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.disconnect_instagram_account(uuid, uuid) TO service_role;

-- The queue row is the source of truth for the account used by the publisher.
CREATE OR REPLACE FUNCTION public.mark_reel_published(p_user_id uuid, p_id uuid, p_media_id text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_account_id uuid;
  v_instagram_user_id text;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required'; END IF;
  IF p_user_id IS NULL OR p_id IS NULL OR nullif(p_media_id, '') IS NULL THEN RAISE EXCEPTION 'invalid publication result'; END IF;

  SELECT q.instagram_account_id, a.instagram_user_id
  INTO v_account_id, v_instagram_user_id
  FROM public.reels_queue AS q
  JOIN public.instagram_accounts AS a ON a.id = q.instagram_account_id AND a.user_id = q.user_id
  WHERE q.id = p_id AND q.user_id = p_user_id AND q.status = 'processing'
  FOR UPDATE OF q;
  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE public.reels_queue
  SET status = 'published',
      progress = 100,
      stage = 'Instagramda yayınlandı',
      ig_media_id = p_media_id,
      published_instagram_user_id = v_instagram_user_id,
      published_at = now(),
      is_deleted_on_instagram = false,
      instagram_deleted_at = NULL,
      error_message = NULL,
      publish_now = false,
      updated_at = now()
  WHERE id = p_id AND user_id = p_user_id AND instagram_account_id = v_account_id AND status = 'processing';
  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE public.instagram_accounts
  SET last_published_at = now(),
      last_processed_at = now(),
      last_media_sync_at = NULL,
      updated_at = now()
  WHERE id = v_account_id AND user_id = p_user_id;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.mark_reel_published(uuid, uuid, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_reel_published(uuid, uuid, text) TO service_role;

-- A disconnected/unassigned Reel cannot be marked for immediate publication.
CREATE OR REPLACE FUNCTION public.request_immediate_publish(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  UPDATE public.reels_queue AS q
  SET publish_now = true, stage = 'Hemen paylaşım istendi', updated_at = now()
  WHERE q.id = p_id
    AND q.user_id = auth.uid()
    AND q.status = 'queued'
    AND q.rights_confirmed IS TRUE
    AND EXISTS (
      SELECT 1 FROM public.instagram_accounts AS a
      JOIN public.instagram_credentials AS c ON c.instagram_account_id = a.id
      WHERE a.id = q.instagram_account_id
        AND a.user_id = auth.uid()
        AND a.disconnected_at IS NULL
    );
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.request_immediate_publish(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.request_immediate_publish(uuid) TO authenticated;

COMMENT ON COLUMN public.instagram_accounts.disconnected_at IS
  'Non-null when the account was explicitly disconnected; metadata and queue history remain for safe reauthorization or reassignment.';
COMMENT ON COLUMN public.reels_queue.instagram_account_id IS
  'Stable internal Instagram account targeted when this Reel was queued; NULL is reserved for ambiguous legacy rows.';
COMMENT ON TABLE public.instagram_credentials IS
  'Private Instagram OAuth credentials keyed by internal account UUID; service role only. Never expose to browser clients.';

NOTIFY pgrst, 'reload schema';
