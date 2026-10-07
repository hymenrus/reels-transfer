-- Track the Instagram account and publication time for safe media reconciliation.
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

-- Backfill only rows last updated after this app user's currently connected
-- Instagram account was linked; older account switches are intentionally left unknown.
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
  set status = 'published',
      progress = 100,
      stage = 'Instagramda yayınlandı',
      ig_media_id = p_media_id,
      published_instagram_user_id = (select a.instagram_user_id from public.instagram_accounts a where a.user_id = p_user_id),
      published_at = now(),
      is_deleted_on_instagram = false,
      instagram_deleted_at = null,
      error_message = null,
      publish_now = false,
      updated_at = now()
  where id = p_id and user_id = p_user_id and status = 'processing';
  if not found then return false; end if;
  update public.instagram_accounts
  set last_published_at = now(),
      last_processed_at = now(),
      last_media_sync_at = null,
      updated_at = now()
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
