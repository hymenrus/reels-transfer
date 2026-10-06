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
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.reels_queue add column if not exists shortcode_key text generated always as (lower(shortcode)) stored;
alter table public.reels_queue add column if not exists progress integer not null default 0;
alter table public.reels_queue add column if not exists stage text not null default 'Kuyrukta';
alter table public.reels_queue add column if not exists rights_confirmed boolean not null default false;
create unique index if not exists reels_queue_user_shortcode_uq on public.reels_queue (user_id, lower(shortcode));
create unique index if not exists reels_queue_user_shortcode_key_uq on public.reels_queue (user_id, shortcode_key);
create index if not exists reels_queue_status_created_idx on public.reels_queue (status, created_at);

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
    update public.reels_queue set status = 'cancelled', progress = 0, stage = 'Kuyruktan çıkarıldı', updated_at = now()
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
  instagram_user_id text not null unique,
  username text not null,
  granted_scopes text[] not null default '{}',
  connected_at timestamptz not null default now(),
  token_expires_at timestamptz not null,
  last_processed_at timestamptz,
  updated_at timestamptz not null default now()
);
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
  update public.reels_queue set status = 'published', progress = 100, stage = 'Instagramda yayınlandı', ig_media_id = p_media_id, error_message = null, updated_at = now() where id = p_id and user_id = p_user_id and status = 'processing';
  if not found then return false; end if;
  update public.instagram_accounts set last_published_at = now(), last_processed_at = now(), updated_at = now() where user_id = p_user_id;
  return true;
end;
$$;
revoke all on function public.mark_reel_published(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.mark_reel_published(uuid, uuid, text) to service_role;
