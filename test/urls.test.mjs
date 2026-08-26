// Query-string variant capping and landed-URL exclusions (2026-08-26).
//
// landerstheaccountants.com gap crawl: 34 of 120 pages went to
// special_reports_downloads.php?which=<key> — each a distinct frontier entry, each redirecting
// to /login/why_register.php, which was excluded but captured 34 times because the exclusion
// only ever saw the URL asked for.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { queryVariantKey, variantCapExceeded, pathExcluded } from '../src/capture/urls.mjs';

test('a URL without a query has no variant key and never counts', () => {
  assert.equal(queryVariantKey('https://a.com/x/y'), null);
  assert.equal(queryVariantKey('https://a.com/x/y?'), null);
  const counts = new Map();
  for (let i = 0; i < 10; i++) assert.equal(variantCapExceeded(counts, 'https://a.com/page', 3), false);
  assert.equal(counts.size, 0);
});

test('variants of one path share a key regardless of the query and of case', () => {
  assert.equal(queryVariantKey('https://A.com/Reports.php?which=1'), 'a.com/reports.php');
  assert.equal(queryVariantKey('https://a.com/reports.php?which=2&x=9'), 'a.com/reports.php');
  assert.notEqual(queryVariantKey('https://a.com/other.php?which=2'), queryVariantKey('https://a.com/reports.php?which=2'));
});

test('the cap allows exactly max fetches per path, then refuses', () => {
  const counts = new Map();
  const u = (k) => `https://www.landerstheaccountants.com/resources/special_reports_downloads.php?which=${k}`;
  assert.equal(variantCapExceeded(counts, u('a'), 3), false);
  assert.equal(variantCapExceeded(counts, u('b'), 3), false);
  assert.equal(variantCapExceeded(counts, u('c'), 3), false);
  assert.equal(variantCapExceeded(counts, u('d'), 3), true);
  assert.equal(variantCapExceeded(counts, u('e'), 3), true);
  // another path is unaffected
  assert.equal(variantCapExceeded(counts, 'https://www.landerstheaccountants.com/other.php?x=1', 3), false);
});

test('a cap of 0 (or a missing setting) means unlimited', () => {
  const counts = new Map();
  for (let i = 0; i < 50; i++) assert.equal(variantCapExceeded(counts, `https://a.com/p?i=${i}`, 0), false);
  for (let i = 0; i < 50; i++) assert.equal(variantCapExceeded(counts, `https://a.com/p?i=${i}`, undefined), false);
});

test('path exclusion matches the landed URL the same way it matches the requested one', () => {
  const patterns = ['/login', '/m/'];
  assert.equal(pathExcluded('https://www.landerstheaccountants.com/login/why_register.php', patterns), true);
  assert.equal(pathExcluded('https://www.landerstheaccountants.com/login/why_register.php?redirect=x', patterns), true);
  assert.equal(pathExcluded('https://www.landerstheaccountants.com/resources/special_reports_downloads.php?which=a', patterns), false);
});
