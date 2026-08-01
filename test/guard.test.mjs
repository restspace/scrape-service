// The SSRF guard is the security boundary the move creates, so it gets real
// tests rather than a manual curl check. DNS is stubbed — these must pass
// offline and must never depend on what a real resolver says today.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertSubmittable,
  assertResolvesPublic,
  checkFrontierUrl,
  blockedIpReason,
  BlockedUrlError,
} from '../src/net/guard.mjs';

const stubResolver = (map) => ({
  async lookup(host) {
    if (!(host in map)) {
      const err = new Error('ENOTFOUND');
      err.code = 'ENOTFOUND';
      throw err;
    }
    return map[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  },
});

test('rejects non-http schemes', () => {
  for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com']) {
    assert.throws(() => assertSubmittable(url), (e) => e.code === 'url_scheme_blocked', url);
  }
});

test('rejects literal private and loopback addresses', () => {
  const cases = [
    ['http://127.0.0.1:3100/', 'loopback'],
    ['http://169.254.169.254/latest/meta-data/', 'cloud metadata'],
    ['http://192.168.1.1/', 'RFC1918'],
    ['http://10.0.0.5/', 'RFC1918'],
    ['http://172.16.4.2/', 'RFC1918'],
    ['http://100.64.0.1/', 'CGNAT'],
    ['http://0.0.0.0/', 'unspecified'],
    ['http://[::1]/', 'IPv6 loopback'],
    ['http://[fd00::1]/', 'IPv6 ULA'],
    ['http://[fe80::1]/', 'IPv6 link-local'],
  ];
  for (const [url, label] of cases) {
    assert.throws(() => assertSubmittable(url), (e) => e.code === 'url_private_address', label);
  }
});

test('rejects IPv4-mapped IPv6 loopback', () => {
  // ::ffff:127.0.0.1 reaches loopback while looking like an IPv6 address.
  assert.equal(blockedIpReason('::ffff:127.0.0.1'), 'IPv4-mapped loopback (127.0.0.0/8)');
});

test('rejects embedded credentials and non-public hostnames', () => {
  assert.throws(() => assertSubmittable('http://user:pw@example.com/'), (e) => e.code === 'url_credentials_blocked');
  assert.throws(() => assertSubmittable('http://intranet/'), (e) => e.code === 'url_non_public_host');
  assert.throws(() => assertSubmittable('http://printer.local/'), (e) => e.code === 'url_non_public_host');
});

test('accepts ordinary public URLs', () => {
  for (const url of ['https://example.co.uk/', 'http://www.example.org', 'https://sub.example.com:8443/a?b=c']) {
    assert.ok(assertSubmittable(url) instanceof URL, url);
  }
});

test('rejects a name resolving to a private address (rebinding)', async () => {
  const url = assertSubmittable('http://sneaky.example.com/');
  await assert.rejects(
    () => assertResolvesPublic(url, { resolver: stubResolver({ 'sneaky.example.com': ['127.0.0.1'] }) }),
    (e) => e instanceof BlockedUrlError && e.code === 'url_private_address',
  );
});

test('rejects when ANY answer is private, not just the first', async () => {
  // The browser chooses which address to use, so one bad answer is enough.
  const url = assertSubmittable('http://mixed.example.com/');
  await assert.rejects(
    () => assertResolvesPublic(url, { resolver: stubResolver({ 'mixed.example.com': ['93.184.216.34', '10.1.2.3'] }) }),
    (e) => e.code === 'url_private_address',
  );
});

test('accepts a name resolving entirely to public addresses', async () => {
  const url = assertSubmittable('http://good.example.com/');
  const addrs = await assertResolvesPublic(url, {
    resolver: stubResolver({ 'good.example.com': ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'] }),
  });
  assert.deepEqual(addrs, ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']);
});

test('surfaces DNS failure as a typed error, not a crash', async () => {
  const url = assertSubmittable('http://nope.example.com/');
  await assert.rejects(
    () => assertResolvesPublic(url, { resolver: stubResolver({}) }),
    (e) => e.code === 'url_dns_failed',
  );
});

test('frontier check reports instead of throwing', async () => {
  // One poisoned <a href> must skip that URL, not fail the whole crawl.
  const bad = await checkFrontierUrl('http://127.0.0.1/admin');
  assert.equal(bad.allowed, false);
  assert.equal(bad.reason, 'url_private_address');

  const good = await checkFrontierUrl('https://good.example.com/x', {
    resolver: stubResolver({ 'good.example.com': ['93.184.216.34'] }),
  });
  assert.equal(good.allowed, true);
});
