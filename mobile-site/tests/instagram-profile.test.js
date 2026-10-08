import assert from 'node:assert/strict';
import test from 'node:test';
import { extractInstagramProfile } from '../supabase/functions/instagram-oauth-callback/instagram-profile.js';

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
