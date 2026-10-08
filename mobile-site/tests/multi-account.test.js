import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateQueueEta, selectInstagramAccount } from '../src/queue-utils.js';

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
