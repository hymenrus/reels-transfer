-- Explicit per-Reel override for a user's regular publication interval.
alter table public.reels_queue
  add column if not exists publish_now boolean not null default false;

create index if not exists reels_queue_immediate_pending_idx
  on public.reels_queue (created_at)
  where status = 'queued' and publish_now is true;

create or replace function public.request_immediate_publish(p_id uuid)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  update public.reels_queue
  set publish_now = true, stage = 'Hemen paylaşım istendi', updated_at = now()
  where id = p_id
    and user_id = auth.uid()
    and status = 'queued'
    and rights_confirmed is true;
  return found;
end;
$$;
revoke all on function public.request_immediate_publish(uuid) from public, anon, authenticated;
grant execute on function public.request_immediate_publish(uuid) to authenticated;

-- Clear an outstanding priority request when the user removes the queued item.
create or replace function public.cancel_queued_reel(p_id uuid)
returns boolean
language sql security definer set search_path = '' as $$
  with changed as (
    update public.reels_queue
    set status = 'cancelled', publish_now = false, progress = 0,
        stage = 'Kuyruktan çıkarıldı', updated_at = now()
    where id = p_id and user_id = auth.uid() and status in ('queued','failed')
    returning 1
  ) select exists(select 1 from changed);
$$;
revoke all on function public.cancel_queued_reel(uuid) from public, anon, authenticated;
grant execute on function public.cancel_queued_reel(uuid) to authenticated;

-- Completing any successful publication starts the next interval and consumes the override.
create or replace function public.mark_reel_published(
  p_user_id uuid,
  p_id uuid,
  p_media_id text
) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required';
  end if;
  if p_user_id is null or p_id is null or nullif(p_media_id, '') is null then
    raise exception 'invalid publication result';
  end if;

  update public.reels_queue
  set status = 'published', progress = 100, stage = 'Instagramda yayınlandı',
      ig_media_id = p_media_id, error_message = null, publish_now = false, updated_at = now()
  where id = p_id and user_id = p_user_id and status = 'processing';
  if not found then
    return false;
  end if;

  update public.instagram_accounts
  set last_published_at = now(), last_processed_at = now(), updated_at = now()
  where user_id = p_user_id;
  return true;
end;
$$;
revoke all on function public.mark_reel_published(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.mark_reel_published(uuid, uuid, text) to service_role;
