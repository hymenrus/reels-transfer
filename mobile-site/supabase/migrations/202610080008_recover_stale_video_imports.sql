-- Recover URL imports left processing after a cancelled or crashed worker run.
BEGIN;

CREATE INDEX IF NOT EXISTS video_import_jobs_processing_stale_idx
  ON public.video_import_jobs (updated_at)
  WHERE status = 'processing';

CREATE OR REPLACE FUNCTION public.claim_video_import_job()
RETURNS TABLE(id uuid, user_id uuid, shortcode text, source_url text, attempts integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;

  UPDATE public.video_import_jobs AS j
  SET status = CASE WHEN j.attempts >= 3 THEN 'failed' ELSE 'queued' END,
      progress = 0,
      stage = CASE WHEN j.attempts >= 3
        THEN 'Önceki bulut indirme denemeleri tamamlanamadı'
        ELSE 'Önceki işlem yarıda kaldı · yeniden sıraya alındı' END,
      error_message = CASE WHEN j.attempts >= 3
        THEN 'Bulut işçisi aktarımı birkaç denemede tamamlayamadı. Yeniden dene veya URL’yi kontrol et.'
        ELSE NULL END,
      updated_at = now(),
      finished_at = CASE WHEN j.attempts >= 3 THEN now() ELSE NULL END
  WHERE j.status = 'processing'
    AND j.updated_at < now() - interval '45 minutes';

  RETURN QUERY
  WITH next_job AS (
    SELECT j.id
    FROM public.video_import_jobs AS j
    WHERE j.status = 'queued'
    ORDER BY j.created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE public.video_import_jobs AS j
  SET status = 'processing', progress = 3,
      stage = 'Instagram bağlantısı hazırlanıyor', attempts = j.attempts + 1,
      error_message = NULL, updated_at = now()
  FROM next_job
  WHERE j.id = next_job.id
  RETURNING j.id, j.user_id, j.shortcode, j.source_url, j.attempts;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_video_import_job() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_video_import_job() TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
