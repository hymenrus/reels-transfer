-- Explicitly document server-only access and index the OAuth-state user foreign key.
create index if not exists instagram_oauth_states_user_id_idx on public.instagram_oauth_states (user_id);

drop policy if exists "Service role manages Instagram credentials" on public.instagram_credentials;
create policy "Service role manages Instagram credentials"
  on public.instagram_credentials for all to service_role using (true) with check (true);

drop policy if exists "Service role manages Instagram OAuth state" on public.instagram_oauth_states;
create policy "Service role manages Instagram OAuth state"
  on public.instagram_oauth_states for all to service_role using (true) with check (true);
