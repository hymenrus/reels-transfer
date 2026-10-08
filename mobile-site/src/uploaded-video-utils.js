export const VIDEO_STORAGE_BUCKET = 'reelflow-original-videos';
export const MAX_ORIGINAL_VIDEO_BYTES = 50 * 1024 * 1024;
export const ALLOWED_VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/x-m4v']);
const EXTENSION_TO_MIME = Object.freeze({ mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v' });

export function supportedVideoExtension(fileName = '') {
  const extension = String(fileName).split('.').pop()?.toLowerCase() || '';
  return Object.hasOwn(EXTENSION_TO_MIME, extension) ? extension : '';
}

export function normalizedVideoMimeType(file) {
  const mimeType = String(file?.type || '').toLowerCase();
  if (ALLOWED_VIDEO_MIME_TYPES.has(mimeType)) return mimeType;
  const extension = supportedVideoExtension(file?.name);
  return EXTENSION_TO_MIME[extension] || '';
}

export function validateUploadedVideo(file) {
  if (!file || typeof file !== 'object') return { ok: false, reason: 'file_required' };
  if (!supportedVideoExtension(file.name)) return { ok: false, reason: 'unsupported_type' };
  if (!Number.isFinite(Number(file.size)) || Number(file.size) <= 0) return { ok: false, reason: 'empty_file' };
  if (Number(file.size) > MAX_ORIGINAL_VIDEO_BYTES) return { ok: false, reason: 'file_too_large' };
  if (!normalizedVideoMimeType(file)) return { ok: false, reason: 'unsupported_type' };
  return { ok: true, mimeType: normalizedVideoMimeType(file), extension: supportedVideoExtension(file.name) };
}

export function createVideoObjectPath(userId, extension, objectId) {
  const owner = String(userId || '');
  const suffix = String(extension || '').toLowerCase();
  const id = String(objectId || '');
  if (!/^[0-9a-f-]{36}$/i.test(owner)) throw new TypeError('A valid owner UUID is required.');
  if (!/^(mp4|mov|m4v)$/.test(suffix)) throw new TypeError('Unsupported video extension.');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) throw new TypeError('A safe object ID is required.');
  return `${owner}/${id}.${suffix}`;
}

export function isOwnedVideoObjectPath(storagePath, userId) {
  const path = String(storagePath || '');
  const owner = String(userId || '');
  return Boolean(owner && path.startsWith(`${owner}/`) && !path.includes('..') && !path.includes('\\'));
}

export function resumableUploadFingerprint(userId, file) {
  return `reelflow-video-v1:${String(userId || '')}:${String(file?.name || '')}:${Number(file?.size || 0)}:${Number(file?.lastModified || 0)}`;
}

export function tusResumableEndpoint(projectUrl) {
  let parsed;
  try {
    parsed = new URL(projectUrl);
  } catch {
    throw new TypeError('A valid Supabase project URL is required.');
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.supabase.co')) {
    throw new TypeError('The Supabase project URL is not a hosted HTTPS project URL.');
  }
  const projectRef = parsed.hostname.split('.')[0];
  if (!/^[a-z0-9-]+$/i.test(projectRef)) throw new TypeError('The Supabase project reference is invalid.');
  return `https://${projectRef}.storage.supabase.co/storage/v1/upload/resumable`;
}

export function formatVideoFileSize(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return 'Boyut bilinmiyor';
  return new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 }).format(value / (1024 * 1024)) + ' MB';
}
