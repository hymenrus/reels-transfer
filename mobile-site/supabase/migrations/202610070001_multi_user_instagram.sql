-- Per-user Instagram Login: public metadata is owner-readable; OAuth tokens/state are service-role only.
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
create policy "Users read their own Instagram account"
  on public.instagram_accounts for select to authenticated
  using ((select auth.uid()) = user_id);
grant all on public.instagram_accounts to service_role;

alter table public.instagram_credentials enable row level security;
revoke all on public.instagram_credentials from public, anon, authenticated;
grant all on public.instagram_credentials to service_role;
drop policy if exists "Service role manages Instagram credentials" on public.instagram_credentials;
create policy "Service role manages Instagram credentials"
  on public.instagram_credentials for all to service_role using (true) with check (true);

alter table public.instagram_oauth_states enable row level security;
revoke all on public.instagram_oauth_states from public, anon, authenticated;
grant all on public.instagram_oauth_states to service_role;
drop policy if exists "Service role manages Instagram OAuth state" on public.instagram_oauth_states;
create policy "Service role manages Instagram OAuth state"
  on public.instagram_oauth_states for all to service_role using (true) with check (true);

create or replace function public.save_instagram_connection(
  p_user_id uuid,
  p_instagram_user_id text,
  p_username text,
  p_access_token text,
  p_token_expires_at timestamptz,
  p_granted_scopes text[]
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required';
  end if;
  if p_user_id is null or nullif(trim(p_instagram_user_id), '') is null
     or nullif(trim(p_username), '') is null or nullif(p_access_token, '') is null
     or p_token_expires_at <= now() then
    raise exception 'invalid Instagram connection';
  end if;
  if not coalesce(p_granted_scopes, '{}'::text[]) @> array[
    'instagram_business_basic', 'instagram_business_content_publish'
  ]::text[] then
    raise exception 'required Instagram publishing permissions were not granted';
  end if;

  insert into public.instagram_accounts (
    user_id, instagram_user_id, username, granted_scopes,
    connected_at, token_expires_at, updated_at
  ) values (
    p_user_id, p_instagram_user_id, p_username, p_granted_scopes,
    now(), p_token_expires_at, now()
  )
  on conflict (user_id) do update set
    instagram_user_id = excluded.instagram_user_id,
    username = excluded.username,
    granted_scopes = excluded.granted_scopes,
    connected_at = now(),
    token_expires_at = excluded.token_expires_at,
    updated_at = now();

  insert into public.instagram_credentials (user_id, access_token, refreshed_at, updated_at)
  values (p_user_id, p_access_token, now(), now())
  on conflict (user_id) do update set
    access_token = excluded.access_token,
    refreshed_at = now(),
    updated_at = now();
end;
$$;
revoke all on function public.save_instagram_connection(uuid, text, text, text, timestamptz, text[]) from public, anon, authenticated;
grant execute on function public.save_instagram_connection(uuid, text, text, text, timestamptz, text[]) to service_role;

-- Restrict connection-state rows to server-side OAuth handlers only.
comment on table public.instagram_credentials is 'Private long-lived Instagram OAuth tokens; service role only. Never expose to browser clients.';
comment on table public.instagram_oauth_states is 'Hashed, expiring, single-use Instagram OAuth CSRF state; service role only.';
