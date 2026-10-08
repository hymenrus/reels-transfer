-- ReelFlow: saat/tarih olmadan, kullanıcının kendi Reels kuyruğu.
create table if not exists public.reels_queue (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  shortcode text not null,
  caption text not null default '',
  source_url text not null,
  status text not null default 'queued' check (status in ('queued','processing','published','failed','cancelled')),
  ig_media_id text,
  error_message text,
  attempts integer not null default 0 check (attempts >= 0),
  progress integer not null default 0 check (progress between 0 and 100),
  stage text not null default 'Kuyrukta',
  rights_confirmed boolean not null default false,
  publish_now boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.reels_queue add column if not exists shortcode_key text generated always as (lower(shortcode)) stored;
alter table public.reels_queue add column if not exists progress integer not null default 0;
alter table public.reels_queue add column if not exists stage text not null default 'Kuyrukta';
alter table public.reels_queue add column if not exists rights_confirmed boolean not null default false;
alter table public.reels_queue add column if not exists publish_now boolean not null default false;
create unique index if not exists reels_queue_user_shortcode_uq on public.reels_queue (user_id, lower(shortcode));
create unique index if not exists reels_queue_user_shortcode_key_uq on public.reels_queue (user_id, shortcode_key);
create index if not exists reels_queue_status_created_idx on public.reels_queue (status, created_at);
create index if not exists reels_queue_immediate_pending_idx on public.reels_queue (created_at) where status = 'queued' and publish_now is true;

alter table public.reels_queue enable row level security;
revoke all on public.reels_queue from anon, authenticated;
grant select, insert on public.reels_queue to authenticated;
drop policy if exists "Users can read their own Reels" on public.reels_queue;
drop policy if exists "Users can add their own Reels" on public.reels_queue;
create policy "Users can read their own Reels" on public.reels_queue for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users can add their own Reels" on public.reels_queue for insert to authenticated with check ((select auth.uid()) = user_id and status = 'queued');

drop function if exists public.enqueue_reel(text, text, text);
create or replace function public.enqueue_reel(p_shortcode text, p_source_url text, p_caption text default '', p_rights_confirmed boolean default false)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if p_rights_confirmed is distinct from true then raise exception 'content rights confirmation required'; end if;
  if p_shortcode is null or p_shortcode !~ '^[A-Za-z0-9_-]{4,20}$' then raise exception 'invalid shortcode'; end if;
  if p_source_url is null or p_source_url !~* '^https://(www[.])?instagram[.]com/(reel|reels|p)/[A-Za-z0-9_-]+/?$' then raise exception 'invalid Instagram URL'; end if;
  if length(coalesce(p_caption, '')) > 2200 then raise exception 'caption exceeds 2200 characters'; end if;
  insert into public.reels_queue (user_id, shortcode, source_url, caption, rights_confirmed)
  values (auth.uid(), p_shortcode, p_source_url, coalesce(p_caption, ''), true)
  on conflict (user_id, shortcode_key) do nothing
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.enqueue_reel(text, text, text, boolean) from public;
revoke all on function public.enqueue_reel(text, text, text, boolean) from anon;
grant execute on function public.enqueue_reel(text, text, text, boolean) to authenticated;

create or replace function public.cancel_queued_reel(p_id uuid)
returns boolean language sql security definer set search_path = '' as $$
  with changed as (
    update public.reels_queue set status = 'cancelled', publish_now = false, progress = 0, stage = 'Kuyruktan çıkarıldı', updated_at = now()
    where id = p_id and user_id = auth.uid() and status in ('queued','failed') returning 1
  ) select exists(select 1 from changed);
$$;
create or replace function public.retry_failed_reel(p_id uuid)
returns boolean language sql security definer set search_path = '' as $$
  with changed as (
    update public.reels_queue set status = 'queued', progress = 0, stage = 'Kuyrukta', error_message = null, updated_at = now()
    where id = p_id and user_id = auth.uid() and status = 'failed' returning 1
  ) select exists(select 1 from changed);
$$;
revoke all on function public.cancel_queued_reel(uuid) from public;
revoke all on function public.cancel_queued_reel(uuid) from anon;
revoke all on function public.retry_failed_reel(uuid) from public;
revoke all on function public.retry_failed_reel(uuid) from anon;
grant execute on function public.cancel_queued_reel(uuid) to authenticated;
grant execute on function public.retry_failed_reel(uuid) to authenticated;


-- Multi-user Instagram Login extension (also applied in migrations/202610070001_multi_user_instagram.sql)
create table if not exists public.instagram_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  instagram_user_id text not null,
  username text not null,
  granted_scopes text[] not null default '{}',
  connected_at timestamptz not null default now(),
  token_expires_at timestamptz not null,
  last_processed_at timestamptz,
  updated_at timestamptz not null default now()
);
create unique index if not exists instagram_accounts_user_instagram_user_id_key
  on public.instagram_accounts (user_id, instagram_user_id);
create table if not exists public.instagram_credentials (
  user_id uuid primary key references public.instagram_accounts(user_id) on delete cascade,
  access_token text not null,
  refreshed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.instagram_oauth_states (
  state_hash text primary key check (state_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists instagram_oauth_states_expiry_idx on public.instagram_oauth_states (expires_at);
create index if not exists instagram_oauth_states_user_id_idx on public.instagram_oauth_states (user_id);
alter table public.instagram_accounts enable row level security;
revoke all on public.instagram_accounts from public, anon, authenticated;
grant select on public.instagram_accounts to authenticated;
drop policy if exists "Users read their own Instagram account" on public.instagram_accounts;
create policy "Users read their own Instagram account" on public.instagram_accounts for select to authenticated using ((select auth.uid()) = user_id);
grant all on public.instagram_accounts to service_role;
alter table public.instagram_credentials enable row level security;
revoke all on public.instagram_credentials from public, anon, authenticated;
grant all on public.instagram_credentials to service_role;
drop policy if exists "Service role manages Instagram credentials" on public.instagram_credentials;
create policy "Service role manages Instagram credentials" on public.instagram_credentials for all to service_role using (true) with check (true);
alter table public.instagram_oauth_states enable row level security;
revoke all on public.instagram_oauth_states from public, anon, authenticated;
grant all on public.instagram_oauth_states to service_role;
drop policy if exists "Service role manages Instagram OAuth state" on public.instagram_oauth_states;
create policy "Service role manages Instagram OAuth state" on public.instagram_oauth_states for all to service_role using (true) with check (true);
create or replace function public.save_instagram_connection(p_user_id uuid, p_instagram_user_id text, p_username text, p_access_token text, p_token_expires_at timestamptz, p_granted_scopes text[])
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service role required'; end if;
  if p_user_id is null or nullif(trim(p_instagram_user_id), '') is null or nullif(trim(p_username), '') is null or nullif(p_access_token, '') is null or p_token_expires_at <= now() then raise exception 'invalid Instagram connection'; end if;
  if not coalesce(p_granted_scopes, '{}'::text[]) @> array['instagram_business_basic', 'instagram_business_content_publish']::text[] then raise exception 'required Instagram publishing permissions were not granted'; end if;
  insert into public.instagram_accounts (user_id, instagram_user_id, username, granted_scopes, connected_at, token_expires_at, updated_at)
  values (p_user_id, p_instagram_user_id, p_username, p_granted_scopes, now(), p_token_expires_at, now())
  on conflict (user_id) do update set instagram_user_id = excluded.instagram_user_id, username = excluded.username, granted_scopes = excluded.granted_scopes, connected_at = now(), token_expires_at = excluded.token_expires_at, updated_at = now();
  insert into public.instagram_credentials (user_id, access_token, refreshed_at, updated_at)
  values (p_user_id, p_access_token, now(), now())
  on conflict (user_id) do update set access_token = excluded.access_token, refreshed_at = now(), updated_at = now();
end;
$$;
revoke all on function public.save_instagram_connection(uuid, text, text, text, timestamptz, text[]) from public, anon, authenticated;
grant execute on function public.save_instagram_connection(uuid, text, text, text, timestamptz, text[]) to service_role;
comment on table public.instagram_credentials is 'Private long-lived Instagram OAuth tokens; service role only. Never expose to browser clients.';
comment on table public.instagram_oauth_states is 'Hashed, expiring, single-use Instagram OAuth CSRF state; service role only.';


-- User-controlled publication interval and atomic cooldown update (202610070003_publish_interval.sql)
alter table public.instagram_accounts
  add column if not exists publish_interval_minutes integer not null default 360,
  add column if not exists last_published_at timestamptz;
DO $$
begin
  if not exists (select 1 from pg_constraint where conname = 'instagram_accounts_publish_interval_check' and conrelid = 'public.instagram_accounts'::regclass limit 1) then
    alter table public.instagram_accounts add constraint instagram_accounts_publish_interval_check check (publish_interval_minutes in (60, 180, 360, 720, 1440, 2880));
  end if;
end;
$$;
grant update (publish_interval_minutes) on public.instagram_accounts to authenticated;
drop policy if exists "Users update own Instagram publish interval" on public.instagram_accounts;
create policy "Users update own Instagram publish interval" on public.instagram_accounts for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create or replace function public.mark_reel_published(p_user_id uuid, p_id uuid, p_media_id text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service role required'; end if;
  if p_user_id is null or p_id is null or nullif(p_media_id, '') is null then raise exception 'invalid publication result'; end if;
  update public.reels_queue set status = 'published', progress = 100, stage = 'Instagramda yayınlandı', ig_media_id = p_media_id, error_message = null, publish_now = false, updated_at = now() where id = p_id and user_id = p_user_id and status = 'processing';
  if not found then return false; end if;
  update public.instagram_accounts set last_published_at = now(), last_processed_at = now(), updated_at = now() where user_id = p_user_id;
  return true;
end;
$$;
revoke all on function public.mark_reel_published(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.mark_reel_published(uuid, uuid, text) to service_role;

-- Explicit per-Reel override for a user's regular publication interval (202610070004_immediate_publish.sql).
create or replace function public.request_immediate_publish(p_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  update public.reels_queue set publish_now = true, stage = 'Hemen paylaşım istendi', updated_at = now()
  where id = p_id and user_id = auth.uid() and status = 'queued' and rights_confirmed is true;
  return found;
end;
$$;
revoke all on function public.request_immediate_publish(uuid) from public, anon, authenticated;
grant execute on function public.request_immediate_publish(uuid) to authenticated;


-- Instagram media reconciliation (also applied by migrations/202610070005_instagram_media_reconciliation.sql).
alter table public.instagram_accounts
  add column if not exists last_media_sync_at timestamptz;
alter table public.reels_queue
  add column if not exists published_instagram_user_id text,
  add column if not exists published_at timestamptz,
  add column if not exists is_deleted_on_instagram boolean not null default false,
  add column if not exists instagram_deleted_at timestamptz;
create index if not exists reels_queue_published_instagram_idx
  on public.reels_queue (user_id, published_instagram_user_id, published_at desc)
  where status = 'published' and ig_media_id is not null;
update public.reels_queue q
set published_instagram_user_id = a.instagram_user_id,
    published_at = coalesce(q.published_at, q.updated_at)
from public.instagram_accounts a
where q.user_id = a.user_id
  and q.status = 'published'
  and q.ig_media_id is not null
  and q.published_instagram_user_id is null
  and q.updated_at >= a.connected_at;
create or replace function public.mark_reel_published(p_user_id uuid, p_id uuid, p_media_id text)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'service role required'; end if;
  if p_user_id is null or p_id is null or nullif(p_media_id, '') is null then raise exception 'invalid publication result'; end if;
  update public.reels_queue
  set status = 'published', progress = 100, stage = 'Instagramda yayınlandı', ig_media_id = p_media_id,
      published_instagram_user_id = (select a.instagram_user_id from public.instagram_accounts a where a.user_id = p_user_id),
      published_at = now(), is_deleted_on_instagram = false, instagram_deleted_at = null,
      error_message = null, publish_now = false, updated_at = now()
  where id = p_id and user_id = p_user_id and status = 'processing';
  if not found then return false; end if;
  update public.instagram_accounts
  set last_published_at = now(), last_processed_at = now(), last_media_sync_at = null, updated_at = now()
  where user_id = p_user_id;
  return true;
end;
$$;
revoke all on function public.mark_reel_published(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.mark_reel_published(uuid, uuid, text) to service_role;
comment on column public.reels_queue.is_deleted_on_instagram is
  'True only after a successful, coverage-verified read of the owning account media list no longer returns this media ID; queue history is retained.';
comment on column public.instagram_accounts.last_media_sync_at is
  'Timestamp of the last attempted server-side inventory of the connected account media list.';


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

-- User-owned caption templates are shared across all Instagram accounts on the same ReelFlow login.
CREATE TABLE IF NOT EXISTS public.instagram_caption_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  instagram_account_id uuid,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  caption text NOT NULL CHECK (char_length(btrim(caption)) <= 2200),
  tags text NOT NULL DEFAULT '' CHECK (char_length(btrim(tags)) <= 2200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS instagram_caption_templates_owner_name_key
  ON public.instagram_caption_templates (user_id, lower(name));
CREATE INDEX IF NOT EXISTS instagram_caption_templates_owner_updated_idx
  ON public.instagram_caption_templates (user_id, updated_at DESC);
ALTER TABLE public.instagram_caption_templates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.instagram_caption_templates FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.instagram_caption_templates TO authenticated;
DROP POLICY IF EXISTS "Users manage their own Instagram caption templates" ON public.instagram_caption_templates;
CREATE POLICY "Users manage their own Instagram caption templates"
  ON public.instagram_caption_templates FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);
COMMENT ON TABLE public.instagram_caption_templates IS
  'Caption templates and hashtag/mention blocks are private to one ReelFlow user and shared across that user’s Instagram accounts.';
COMMENT ON COLUMN public.instagram_caption_templates.instagram_account_id IS
  'Deprecated compatibility column; NULL denotes the shared per-user template scope.';

NOTIFY pgrst, 'reload schema';

-- Private original-video library for ReelFlow. Files live in Supabase Storage,
-- never in public buckets or queue rows; storage paths are scoped to auth.uid().

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

-- Follow-up migration: private temporary conversion storage and safe queue/cleanup behavior.
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

-- Follow-up migration: Instagram URL to private cloud archive imports.
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

-- Follow-up migration: recover interrupted Instagram URL archive jobs.
-- Recover URL imports left processing after a cancelled or crashed worker run.
BEGIN;

CREATE INDEX IF NOT EXISTS video_import_jobs_processing_stale_idx
  ON public.video_import_jobs (updated_at)
  WHERE status = 'processing';

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
  RETURNING j.id, j.user_id, j.shortcode, j.source_url, j.attempts;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_video_import_job() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_video_import_job() TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- Follow-up migration: URL-only worker ingestion, owner binding, and retryable object cleanup.
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
-- Use a bracketed literal dot so PostgreSQL string and regex escaping cannot diverge.
BEGIN;
DROP POLICY IF EXISTS "ReelFlow users upload their own private Reel covers" ON storage.objects;
CREATE POLICY "ReelFlow users upload their own private Reel covers"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'reelflow-cover-images'
    AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
    AND name ~ ('^' || (SELECT auth.uid())::text || '/[0-9a-f]{32}[.]jpg$')
  );
COMMIT;
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
