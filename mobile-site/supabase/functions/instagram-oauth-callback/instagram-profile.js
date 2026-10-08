export function extractInstagramProfile(payload, fallbackUserId = '') {
  const body = payload && typeof payload === 'object' ? payload : {};
  const nested = Array.isArray(body.data) ? body.data[0] : body.data;
  const profile = nested && typeof nested === 'object' ? nested : body;
  return {
    instagramUserId: String(profile.user_id || profile.id || fallbackUserId || '').trim(),
    username: String(profile.username || '').trim(),
  };
}
