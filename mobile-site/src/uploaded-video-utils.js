export const VIDEO_STORAGE_BUCKET = 'reelflow-original-videos';
export const MAX_ORIGINAL_VIDEO_BYTES = 50 * 1024 * 1024;

export function formatVideoFileSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return 'Boyut bilinmiyor';
  return new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 }).format(value / (1024 * 1024)) + ' MB';
}
