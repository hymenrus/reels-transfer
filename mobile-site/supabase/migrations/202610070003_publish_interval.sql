-- User-controlled minimum gap between successful Instagram publications.
alter table public.instagram_accounts
  add column if not exists publish_interval_minutes integer not null default 360,
  add column if not exists last_published_at timestamptz;

DO $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'instagram_accounts_publish_interval_check'
      and conrelid = 'public.instagram_accounts'::regclass
    limit 1
  ) then
    alter table public.instagram_accounts
      add constraint instagram_accounts_publish_interval_check
      check (publish_interval_minutes in (60, 180, 360, 720, 1440, 2880));
  end if;
end;
$$;

-- Users may change only this one account preference; account/token fields stay server-owned.
grant update (publish_interval_minutes) on public.instagram_accounts to authenticated;
drop policy if exists "Users update own Instagram publish interval" on public.instagram_accounts;
create policy "Users update own Instagram publish interval"
  on public.instagram_accounts for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- Commit the queue status and per-user cooldown in one database transaction after Meta confirms publishing.
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
      ig_media_id = p_media_id, error_message = null, updated_at = now()
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
