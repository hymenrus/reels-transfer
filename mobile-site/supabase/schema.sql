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
