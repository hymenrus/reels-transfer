import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateQueueEta, pruneReelAccountTargets, pruneReelCaptionTemplateSelections, pruneReelCoverImageSelections, resolveReelTargetAssignments, selectInstagramAccount, setReelAccountTarget, setReelCoverImageSelection } from '../src/queue-utils.js';

const now = Date.parse('2026-10-08T12:00:00Z');
const accounts = [
  { id: 'a', username: 'first', publish_interval_minutes: 360, last_published_at: '2026-10-08T06:00:00Z' },
  { id: 'b', username: 'second', publish_interval_minutes: 60, last_published_at: '2026-10-08T11:40:00Z' },
  { id: 'c', username: 'disconnected', publish_interval_minutes: 60, disconnected_at: '2026-10-08T10:00:00Z' },
];

test('selects the saved account, defaults to newest connected, and selects a newly connected account after OAuth', () => {
  assert.equal(selectInstagramAccount(accounts, 'b')?.id, 'b');
  assert.equal(selectInstagramAccount(accounts, 'missing')?.id, 'a');
  assert.equal(selectInstagramAccount(accounts, 'a', true)?.id, 'a');
  assert.equal(selectInstagramAccount([{ ...accounts[0], disconnected_at: '2026-10-08T11:00:00Z' }]), null);
});

test('resolves each Reel to its explicit Instagram account or the selected default', () => {
  const items = [
    { shortcode: 'AbC123', shortcodeKey: 'abc123' },
    { shortcode: 'XyZ456', shortcodeKey: 'xyz456' },
  ];
  const targets = setReelAccountTarget({}, 'ABC123', 'account-b');
  const assignments = resolveReelTargetAssignments(items, targets, 'account-a');

  assert.deepEqual(assignments, [
    { shortcodeKey: 'abc123', instagramAccountId: 'account-b' },
    { shortcodeKey: 'xyz456', instagramAccountId: 'account-a' },
  ]);
});

test('prunes only target overrides for URLs removed from the draft and preserves others', () => {
  const items = [{ shortcode: 'AbC123', shortcodeKey: 'abc123' }];
  const stored = { ABC123: 'account-a', gone123: 'account-b', invalid: '' };

  assert.deepEqual(pruneReelAccountTargets(items, stored), { abc123: 'account-a' });
});

test('preserves a saved template selection per URL and prunes selections when the URL is removed', () => {
  const items = [{ shortcode: 'AbC123', shortcodeKey: 'abc123' }];
  const stored = { ABC123: 'template-1', gone123: 'template-2' };

  assert.deepEqual(pruneReelCaptionTemplateSelections(items, stored), { abc123: 'template-1' });
});

test('preserves a saved cover per URL and prunes only covers for removed URLs', () => {
  const items = [{ shortcode: 'AbC123', shortcodeKey: 'abc123' }, { shortcode: 'XyZ456', shortcodeKey: 'xyz456' }];
  const selections = setReelCoverImageSelection({}, 'ABC123', 'cover-a');
  const withSecond = setReelCoverImageSelection(selections, 'xyz456', 'cover-b');

  assert.deepEqual(pruneReelCoverImageSelections(items, withSecond), { abc123: 'cover-a', xyz456: 'cover-b' });
  assert.deepEqual(pruneReelCoverImageSelections([items[0]], withSecond), { abc123: 'cover-a' });
  assert.deepEqual(setReelCoverImageSelection(withSecond, 'ABC123', ''), { xyz456: 'cover-b' });
});

test('calculates normal queue ETAs independently for each Instagram account', () => {
  const rows = [
    { id: 'a1', instagram_account_id: 'a', status: 'queued', created_at: '2026-10-08T10:00:00Z' },
    { id: 'a2', instagram_account_id: 'a', status: 'queued', created_at: '2026-10-08T10:05:00Z' },
    { id: 'b1', instagram_account_id: 'b', status: 'queued', created_at: '2026-10-08T10:01:00Z' },
    { id: 'priority', instagram_account_id: 'b', status: 'queued', publish_now: true, created_at: '2026-10-08T11:00:00Z' },
    { id: 'unassigned', instagram_account_id: null, status: 'queued' },
    { id: 'c1', instagram_account_id: 'c', status: 'queued' },
  ];

  const eta = estimateQueueEta(rows, accounts, now);

  assert.equal(eta.get('a1'), Date.parse('2026-10-08T12:00:00Z'));
  assert.equal(eta.get('a2'), Date.parse('2026-10-08T18:00:00Z'));
  assert.equal(eta.get('priority'), now);
  assert.equal(eta.get('b1'), Date.parse('2026-10-08T13:00:00Z'));
  assert.equal(eta.has('unassigned'), false);
  assert.equal(eta.has('c1'), false);
});
