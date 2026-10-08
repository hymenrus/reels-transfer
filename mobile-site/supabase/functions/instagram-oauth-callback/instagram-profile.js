export function extractInstagramProfile(payload, fallbackUserId = '') {
  const body = payload && typeof payload === 'object' ? payload : {};
  const nested = Array.isArray(body.data) ? body.data[0] : body.data;
  const profile = nested && typeof nested === 'object' ? nested : body;
  return {
    instagramUserId: String(profile.user_id || profile.id || fallbackUserId || '').trim(),
    username: String(profile.username || '').trim(),
  };
}

export function extractLongLivedToken(payload) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const nested = Array.isArray(body.data) ? body.data[0] : body.data;
  const tokenData = nested && typeof nested === 'object' ? nested : body;
  return {
    accessToken: String(tokenData.access_token || '').trim(),
    expiresIn: Number(tokenData.expires_in || 0),
  };
}
