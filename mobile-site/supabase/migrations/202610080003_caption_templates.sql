-- Saved caption templates are private to one ReelFlow user and one Instagram account.
CREATE TABLE IF NOT EXISTS public.instagram_caption_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  instagram_account_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 60),
  caption text NOT NULL CHECK (char_length(btrim(caption)) BETWEEN 1 AND 2200),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT instagram_caption_templates_account_owner_fkey
    FOREIGN KEY (instagram_account_id, user_id)
    REFERENCES public.instagram_accounts(id, user_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS instagram_caption_templates_owner_account_name_key
  ON public.instagram_caption_templates (user_id, instagram_account_id, lower(name));
CREATE INDEX IF NOT EXISTS instagram_caption_templates_owner_account_updated_idx
  ON public.instagram_caption_templates (user_id, instagram_account_id, updated_at DESC);

ALTER TABLE public.instagram_caption_templates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.instagram_caption_templates FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.instagram_caption_templates TO authenticated;

DROP POLICY IF EXISTS "Users manage their own Instagram caption templates" ON public.instagram_caption_templates;
CREATE POLICY "Users manage their own Instagram caption templates"
  ON public.instagram_caption_templates
  FOR ALL TO authenticated
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

COMMENT ON TABLE public.instagram_caption_templates IS
  'Caption templates are account-scoped and readable only by their owning ReelFlow user.';
