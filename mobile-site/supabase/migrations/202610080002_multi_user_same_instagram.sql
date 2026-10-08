-- Allow the same Instagram profile to be independently connected to multiple ReelFlow users.
-- Each connection keeps its own owner-scoped credential, queue, and settings.
ALTER TABLE public.instagram_accounts
  DROP CONSTRAINT IF EXISTS instagram_accounts_instagram_user_id_key;
DROP INDEX IF EXISTS public.instagram_accounts_instagram_user_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS instagram_accounts_user_instagram_user_id_key
  ON public.instagram_accounts (user_id, instagram_user_id);

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
  ON CONFLICT (user_id, instagram_user_id) DO UPDATE SET
    username = EXCLUDED.username,
    granted_scopes = EXCLUDED.granted_scopes,
    connected_at = now(),
    token_expires_at = EXCLUDED.token_expires_at,
    disconnected_at = NULL,
    updated_at = now()
  RETURNING id INTO v_account_id;

  IF v_account_id IS NULL THEN RAISE EXCEPTION 'Instagram connection could not be saved'; END IF;

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

COMMENT ON INDEX public.instagram_accounts_user_instagram_user_id_key IS
  'One Instagram profile may be independently connected by multiple ReelFlow users; each user retains an isolated account and credential row.';
