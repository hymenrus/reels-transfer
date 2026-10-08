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
