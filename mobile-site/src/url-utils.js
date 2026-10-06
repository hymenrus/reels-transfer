const REEL_PATH = /^\/(?:[^/]+\/)?(reel|reels|p)\/([A-Za-z0-9_-]+)\/?$/i;

export function parseReelLine(rawLine) {
  const line = String(rawLine ?? '').trim();
  if (!line || line.startsWith('#')) return { kind: 'empty' };
  const [rawUrl, ...captionParts] = line.split('|');
  const candidate = rawUrl.trim();
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return { kind: 'invalid', raw: line, reason: 'Geçerli bir URL değil.' };
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const match = parsed.protocol === 'https:' && host === 'instagram.com'
    ? parsed.pathname.match(REEL_PATH)
    : null;
  if (!match) return { kind: 'invalid', raw: line, reason: 'Instagram Reel bağlantısı olmalı.' };
  const shortcode = match[2];
  return {
    kind: 'valid',
    shortcode,
    shortcodeKey: shortcode.toLowerCase(),
    url: `https://www.instagram.com/reel/${shortcode}/`,
    caption: captionParts.join('|').trim(),
  };
}

export function parseReelLines(text) {
  const parsed = String(text ?? '').split(/\r?\n/).map(parseReelLine);
  const seen = new Set();
  const unique = [];
  let duplicates = 0;
  const invalid = [];
  for (const item of parsed) {
    if (item.kind === 'empty') continue;
    if (item.kind === 'invalid') { invalid.push(item); continue; }
    if (seen.has(item.shortcodeKey)) { duplicates += 1; continue; }
    seen.add(item.shortcodeKey);
    unique.push(item);
  }
  return { items: unique, duplicates, invalid };
}
