export const VIDEO_STORAGE_BUCKET = 'reelflow-original-videos';
export const MAX_ORIGINAL_VIDEO_BYTES = 50 * 1024 * 1024;
export const MAX_VIDEO_IMPORTS_PER_BATCH = 20;
export const VIDEO_IMPORT_CONCURRENCY = 5;
export const VIDEO_COVER_BUCKET = 'reelflow-cover-images';
export const MAX_COVER_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_COVER_IMAGES_PER_BATCH = 20;

export function createCoverImageId(cryptoApi = globalThis.crypto) {
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues !== 'function') {
    throw new Error('Güvenli rastgele kimlik üretimi bu tarayıcıda desteklenmiyor.');
  }
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function validateCoverImageFile(file) {
  if (!file || file.type !== 'image/jpeg') return 'Yalnızca JPEG/JPG kapak görseli yüklenebilir.';
  if (!Number.isFinite(Number(file.size)) || file.size < 1 || file.size > MAX_COVER_IMAGE_BYTES) {
    return 'Her kapak görseli 8 MB veya daha küçük olmalı.';
  }
  return '';
}

export function coverImageStoragePath(userId, coverId) {
  const owner = String(userId || '');
  const id = String(coverId || '').replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f-]{36}$/.test(owner) || !/^[0-9a-f]{32}$/.test(id)) {
    throw new Error('Kapak görseli sahipliği veya kimliği geçersiz.');
  }
  return `${owner}/${id}.jpg`;
}

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
