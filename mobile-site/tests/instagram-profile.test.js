import assert from 'node:assert/strict';
import test from 'node:test';
import { extractInstagramProfile, extractLongLivedToken } from '../supabase/functions/instagram-oauth-callback/instagram-profile.js';

test('extracts professional Instagram ID and username from Meta /me data array', () => {
  assert.deepEqual(
    extractInstagramProfile({ data: [{ user_id: 'ig-professional-id', username: 'second_account' }] }, 'app-scoped-id'),
    { instagramUserId: 'ig-professional-id', username: 'second_account' },
  );
});

test('supports object and flat /me shapes and safely falls back to token user ID', () => {
  assert.deepEqual(
    extractInstagramProfile({ data: { id: 'app-scoped-id', username: 'profile' } }),
    { instagramUserId: 'app-scoped-id', username: 'profile' },
  );
  assert.deepEqual(
    extractInstagramProfile({ data: [{ username: 'profile' }] }, 'token-user-id'),
    { instagramUserId: 'token-user-id', username: 'profile' },
  );
});

test('extracts Meta long-lived token from the documented flat response', () => {
  assert.deepEqual(
    extractLongLivedToken({ access_token: 'long-token', expires_in: 5184000 }),
    { accessToken: 'long-token', expiresIn: 5184000 },
  );
});

test('supports a long-lived token wrapped in a data array', () => {
  assert.deepEqual(
    extractLongLivedToken({ data: [{ access_token: 'long-token', expires_in: '5184000' }] }),
    { accessToken: 'long-token', expiresIn: 5184000 },
  );
});
