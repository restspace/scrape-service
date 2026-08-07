// 429 backoff: the delay comes from Retry-After when the server sent a usable
// one, else the caller's exponential fallback — and is always capped, so a
// hostile header cannot stall a job for its whole wall clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { retryAfterMs } from '../src/workers/crawl.mjs';

test('honours a delta-seconds Retry-After', () => {
  assert.equal(retryAfterMs({ 'retry-after': '5' }, 2000), 5000);
  assert.equal(retryAfterMs({ 'retry-after': '0' }, 2000), 0);
});

test('falls back to the backoff when the header is absent or garbage', () => {
  assert.equal(retryAfterMs(undefined, 2000), 2000);
  assert.equal(retryAfterMs({}, 2000), 2000);
  assert.equal(retryAfterMs({ 'retry-after': '' }, 2000), 2000);
  assert.equal(retryAfterMs({ 'retry-after': 'soon' }, 2000), 2000);
});

test('accepts an HTTP-date and converts it to a delay from now', () => {
  const inTenSeconds = new Date(Date.now() + 10_000).toUTCString();
  const ms = retryAfterMs({ 'retry-after': inTenSeconds }, 2000);
  // toUTCString truncates to whole seconds, so allow for that plus runtime skew
  assert.ok(ms > 8000 && ms <= 10_000, `expected ~10s, got ${ms}`);
});

test('a date in the past falls back rather than going negative', () => {
  const past = new Date(Date.now() - 60_000).toUTCString();
  assert.equal(retryAfterMs({ 'retry-after': past }, 2000), 2000);
});

test('caps the delay whatever the header says', () => {
  assert.equal(retryAfterMs({ 'retry-after': '86400' }, 2000), 60_000);
  const nextYear = new Date(Date.now() + 365 * 24 * 3600 * 1000).toUTCString();
  assert.equal(retryAfterMs({ 'retry-after': nextYear }, 2000), 60_000);
  assert.equal(retryAfterMs(undefined, 999_999, 60_000), 60_000);
});
