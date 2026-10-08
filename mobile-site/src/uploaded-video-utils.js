export const VIDEO_STORAGE_BUCKET = 'reelflow-original-videos';
export const MAX_ORIGINAL_VIDEO_BYTES = 50 * 1024 * 1024;
export const MAX_VIDEO_IMPORTS_PER_BATCH = 20;
export const VIDEO_IMPORT_CONCURRENCY = 5;

export async function mapWithConcurrency(items, concurrency, mapper) {
  const list = Array.from(items || []);
  const results = new Array(list.length);
  const workerCount = Math.min(
    list.length,
    Math.max(1, Math.floor(Number(concurrency) || 1)),
  );
  let nextIndex = 0;

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= list.length) return;
      results[index] = await mapper(list[index], index);
    }
  }));

  return results;
}

export function formatVideoFileSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return 'Boyut bilinmiyor';
  return new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 }).format(value / (1024 * 1024)) + ' MB';
}
