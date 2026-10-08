-- Seed the persistent rotation from covers already attached to existing queue rows.
BEGIN;

UPDATE public.video_cover_images AS c
SET selection_count = history.selection_count
FROM (
  SELECT q.cover_image_id, count(*)::bigint AS selection_count
  FROM public.reels_queue AS q
  WHERE q.cover_image_id IS NOT NULL
  GROUP BY q.cover_image_id
) AS history
WHERE c.id = history.cover_image_id
  AND history.selection_count > c.selection_count;

COMMIT;
