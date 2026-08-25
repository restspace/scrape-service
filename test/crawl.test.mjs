// 429 backoff: the delay comes from Retry-After when the server sent a usable
// one, else the caller's exponential fallback — and is always capped, so a
// hostile header cannot stall a job for its whole wall clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { retryAfterMs, chooseTier } from '../src/workers/crawl.mjs';

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

// --- frontier tiering -------------------------------------------------------
// Strict tier priority drained tier 0 completely before touching anything else, so on a site
// with a substantial nav the body links and the sitemap backlog were never reached: a
// /news/-rooted crawl of ha-accountants spent all 50 pages on nav and captured not one blog
// post, at depth 3 and again at depth 6 (2026-08-25).
const QUOTA = [0.5, 0.3, 0.2];

test('a body link is reached long before the nav tier is exhausted', () => {
  const taken = [0, 0, 0];
  const picks = [];
  for (let i = 0; i < 10; i++) {
    const t = chooseTier([true, true, true], taken, QUOTA);
    taken[t]++;
    picks.push(t);
  }
  assert.ok(picks.indexOf(1) < 4, `body tier should appear early, got ${picks.join('')}`);
  assert.ok(picks.includes(2), 'sitemap tier should get a share');
  // Roughly the declared split over a full budget.
  assert.equal(taken[0], 5);
  assert.equal(taken[1], 3);
  assert.equal(taken[2], 2);
});

test('an empty tier hands its share to the others rather than idling', () => {
  const taken = [0, 0, 0];
  for (let i = 0; i < 10; i++) taken[chooseTier([true, true, false], taken, QUOTA)]++;
  assert.equal(taken[2], 0);
  assert.equal(taken[0] + taken[1], 10, 'the whole budget is still spent');
  assert.ok(taken[1] >= 3, 'body links keep at least their own share');
});

test('with only one tier queued every page comes from it', () => {
  const taken = [0, 0, 0];
  for (let i = 0; i < 6; i++) taken[chooseTier([false, true, false], taken, QUOTA)]++;
  assert.deepEqual(taken, [0, 6, 0]);
});
