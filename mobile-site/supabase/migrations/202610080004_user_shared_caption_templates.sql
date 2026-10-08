-- Promote every account-scoped caption template to a shared template for its ReelFlow owner.
-- Preserve all templates: only same-owner duplicate names are disambiguated before the global unique index is added.
ALTER TABLE public.instagram_caption_templates
  DROP CONSTRAINT IF EXISTS instagram_caption_templates_account_owner_fkey;
ALTER TABLE public.instagram_caption_templates
  ALTER COLUMN instagram_account_id DROP NOT NULL;
DROP INDEX IF EXISTS public.instagram_caption_templates_owner_account_name_key;
DROP INDEX IF EXISTS public.instagram_caption_templates_owner_account_updated_idx;

ALTER TABLE public.instagram_caption_templates
  ADD COLUMN IF NOT EXISTS tags text NOT NULL DEFAULT '';
ALTER TABLE public.instagram_caption_templates
  DROP CONSTRAINT IF EXISTS instagram_caption_templates_caption_check;
ALTER TABLE public.instagram_caption_templates
  ADD CONSTRAINT instagram_caption_templates_caption_check
  CHECK (char_length(btrim(caption)) <= 2200);
ALTER TABLE public.instagram_caption_templates
  DROP CONSTRAINT IF EXISTS instagram_caption_templates_tags_check;
ALTER TABLE public.instagram_caption_templates
  ADD CONSTRAINT instagram_caption_templates_tags_check
  CHECK (char_length(btrim(tags)) <= 2200);

-- Old clients allowed a same-name template for each Instagram account. Keep each caption,
-- but disambiguate collisions so all of them can become one user's shared templates.
DO $$
DECLARE
  v_row record;
  v_hash text;
  v_hash_length integer;
  v_suffix text;
  v_candidate text;
  v_counter integer;
BEGIN
  FOR v_row IN
    SELECT t.id, t.user_id, t.name
    FROM public.instagram_caption_templates AS t
    WHERE EXISTS (
      SELECT 1
      FROM public.instagram_caption_templates AS other
      WHERE other.user_id = t.user_id
        AND other.id <> t.id
        AND lower(other.name) = lower(t.name)
    )
    ORDER BY t.user_id, t.id
  LOOP
    v_hash := replace(v_row.id::text, '-', '');
    v_hash_length := 8;
    v_suffix := ' · ' || left(v_hash, v_hash_length);
    v_candidate := left(v_row.name, 60 - char_length(v_suffix)) || v_suffix;
    v_counter := 0;
    WHILE EXISTS (
      SELECT 1
      FROM public.instagram_caption_templates AS other
      WHERE other.user_id = v_row.user_id
        AND other.id <> v_row.id
        AND lower(other.name) = lower(v_candidate)
    ) LOOP
      IF v_hash_length < char_length(v_hash) THEN
        v_hash_length := least(v_hash_length + 2, char_length(v_hash));
      ELSE
        v_counter := v_counter + 1;
      END IF;
      v_suffix := ' · ' || left(v_hash, v_hash_length);
      IF v_counter > 0 THEN v_suffix := v_suffix || '-' || v_counter::text; END IF;
      v_candidate := left(v_row.name, 60 - char_length(v_suffix)) || v_suffix;
    END LOOP;
    UPDATE public.instagram_caption_templates
    SET name = v_candidate, updated_at = now()
    WHERE id = v_row.id;
  END LOOP;
END;
$$;

-- NULL marks the shared scope; retain the nullable legacy column for safe rollout compatibility.
UPDATE public.instagram_caption_templates SET instagram_account_id = NULL;
CREATE UNIQUE INDEX IF NOT EXISTS instagram_caption_templates_owner_name_key
  ON public.instagram_caption_templates (user_id, lower(name));
CREATE INDEX IF NOT EXISTS instagram_caption_templates_owner_updated_idx
  ON public.instagram_caption_templates (user_id, updated_at DESC);

COMMENT ON TABLE public.instagram_caption_templates IS
  'Caption templates and their hashtag/mention blocks are private to one ReelFlow user and shared across that user’s Instagram accounts.';
COMMENT ON COLUMN public.instagram_caption_templates.instagram_account_id IS
  'Deprecated compatibility column; NULL denotes the shared per-user template scope.';

NOTIFY pgrst, 'reload schema';
