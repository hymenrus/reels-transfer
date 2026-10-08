export function selectInstagramAccount(accounts = [], savedAccountId = '', preferNewest = false) {
  const connected = accounts.filter((account) => account && !account.disconnected_at);
  if (preferNewest) return connected[0] || null;
  return connected.find((account) => account.id === savedAccountId) || connected[0] || null;
}

function reelShortcodeKey(item) {
  return String(item?.shortcodeKey || item?.shortcode || '').trim().toLowerCase();
}

export function setReelAccountTarget(targets = {}, shortcodeKey, accountId) {
  const key = String(shortcodeKey || '').trim().toLowerCase();
  const id = String(accountId || '').trim();
  if (!key || !id) return { ...(targets && typeof targets === 'object' && !Array.isArray(targets) ? targets : {}) };
  return { ...(targets && typeof targets === 'object' && !Array.isArray(targets) ? targets : {}), [key]: id };
}

export function pruneReelAccountTargets(items = [], targets = {}) {
  if (!targets || typeof targets !== 'object' || Array.isArray(targets)) return {};
  const validKeys = new Set(items.map(reelShortcodeKey).filter(Boolean));
  return Object.fromEntries(Object.entries(targets)
    .map(([key, id]) => [String(key).trim().toLowerCase(), String(id || '').trim()])
    .filter(([key, id]) => validKeys.has(key) && id));
}

export function resolveReelTargetAssignments(items = [], targets = {}, defaultAccountId = '') {
  const overrides = targets && typeof targets === 'object' && !Array.isArray(targets) ? targets : {};
  const fallback = String(defaultAccountId || '').trim();
  return items.map((item) => {
    const shortcodeKey = reelShortcodeKey(item);
    return {
      shortcodeKey,
      instagramAccountId: String(overrides[shortcodeKey] || fallback).trim(),
    };
  });
}

export function estimateQueueEta(rows = [], accounts = [], now = Date.now()) {
  const estimates = new Map();
  const createdAt = (row) => {
    const time = Date.parse(row.created_at || '');
    return Number.isFinite(time) ? time : 0;
  };
  const byAge = (a, b) => createdAt(a) - createdAt(b);

  for (const account of accounts) {
    if (!account?.id || account.disconnected_at) continue;
    const accountRows = rows.filter((row) => row.instagram_account_id === account.id);
    const intervalMs = Number(account.publish_interval_minutes || 360) * 60_000;
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) continue;

    const queued = accountRows.filter((row) => row.status === 'queued');
    const priority = queued.filter((row) => row.publish_now);
    const regular = queued.filter((row) => !row.publish_now);
    priority.sort(byAge).forEach((row) => estimates.set(row.id, now));

    const accountLast = Date.parse(account.last_published_at || '');
    let lastPublished = Number.isFinite(accountLast) ? accountLast : 0;
    for (const row of accountRows) {
      if (row.status !== 'published') continue;
      const publishedAt = Date.parse(row.published_at || row.created_at || '');
      if (Number.isFinite(publishedAt)) lastPublished = Math.max(lastPublished, publishedAt);
    }

    const hasInFlightOrPriority = priority.length > 0 || accountRows.some((row) => row.status === 'processing');
    let nextAt = hasInFlightOrPriority
      ? now + intervalMs
      : lastPublished ? Math.max(now, lastPublished + intervalMs) : now;
    regular.sort(byAge).forEach((row) => {
      estimates.set(row.id, nextAt);
      nextAt += intervalMs;
    });
  }
  return estimates;
}
