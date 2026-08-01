// SSRF guard.
//
// This is the one genuinely new risk created by putting capture behind an API.
// As a local CLI the crawler only ever visited URLs a human typed. As a service
// it visits whatever a caller posts — and it runs on a box that also serves
// client sites and speaks to RS2 on loopback. An unguarded fetcher here is an
// open proxy into the private network.
//
// Two checks, because either alone is insufficient:
//   assertSubmittable()  — at submit time, so a bad job fails fast and visibly.
//   assertNavigable()    — again at navigation time, against the *resolved* IP,
//                          which is what defeats DNS rebinding (a name that
//                          answers publicly on the first lookup and 127.0.0.1
//                          on the second).
//
// Applied to the root URL AND every frontier URL a crawl discovers — a redirect
// or an <a href> is just as caller-influenced as the submitted URL.

import dns from 'node:dns/promises';
import net from 'node:net';

export class BlockedUrlError extends Error {
  constructor(code, message, url) {
    super(message);
    this.name = 'BlockedUrlError';
    this.code = code;
    this.url = url;
  }
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

// Parse an IPv4 literal into its four octets, or null if it isn't one.
function ipv4Octets(ip) {
  if (net.isIPv4(ip) !== true) return null;
  return ip.split('.').map(Number);
}

// IPv4 ranges that must never be reachable from a caller-supplied URL.
function blockedIpv4Reason(ip) {
  const o = ipv4Octets(ip);
  if (!o) return null;
  const [a, b] = o;
  if (a === 0) return 'unspecified/this-network (0.0.0.0/8)';
  if (a === 10) return 'private (10.0.0.0/8)';
  if (a === 127) return 'loopback (127.0.0.0/8)';
  if (a === 169 && b === 254) return 'link-local, incl. cloud metadata (169.254.0.0/16)';
  if (a === 172 && b >= 16 && b <= 31) return 'private (172.16.0.0/12)';
  if (a === 192 && b === 168) return 'private (192.168.0.0/16)';
  if (a === 192 && b === 0) return 'IETF protocol assignments (192.0.0.0/24)';
  if (a === 100 && b >= 64 && b <= 127) return 'CGNAT (100.64.0.0/10)';
  if (a >= 224) return 'multicast/reserved (224.0.0.0/4, 240.0.0.0/4)';
  return null;
}

function blockedIpv6Reason(ip) {
  if (net.isIPv6(ip) !== true) return null;
  const lower = ip.toLowerCase();

  // ::ffff:a.b.c.d — an IPv4 address wearing an IPv6 hat. Judge the IPv4.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) {
    const reason = blockedIpv4Reason(mapped[1]);
    return reason ? `IPv4-mapped ${reason}` : null;
  }

  if (lower === '::' ) return 'unspecified (::)';
  if (lower === '::1') return 'loopback (::1)';

  const head = lower.split(':')[0];
  const hi = parseInt(head || '0', 16);
  if (!Number.isNaN(hi)) {
    if ((hi & 0xfe00) === 0xfc00) return 'unique local address (fc00::/7)';
    if ((hi & 0xffc0) === 0xfe80) return 'link-local (fe80::/10)';
    if ((hi & 0xff00) === 0xff00) return 'multicast (ff00::/8)';
  }
  return null;
}

/** Why this literal IP must not be fetched, or null if it is fine. */
export function blockedIpReason(ip) {
  return blockedIpv4Reason(ip) ?? blockedIpv6Reason(ip);
}

/**
 * Structural checks that need no DNS: shape, scheme, port, embedded creds.
 * Returns the parsed URL so callers can reuse it.
 */
export function assertSubmittable(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedUrlError('url_invalid', `not a valid absolute URL: ${rawUrl}`, rawUrl);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new BlockedUrlError(
      'url_scheme_blocked',
      `only http and https are fetchable, got '${url.protocol}'`,
      rawUrl,
    );
  }

  // Credentials in the URL would be forwarded to whatever the host resolves to.
  if (url.username || url.password) {
    throw new BlockedUrlError('url_credentials_blocked', 'URLs with embedded credentials are refused', rawUrl);
  }

  // A literal private IP needs no lookup to reject, and rejecting it here gives
  // the caller a far clearer error than a DNS failure would.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    const reason = blockedIpReason(host);
    if (reason) {
      throw new BlockedUrlError('url_private_address', `refusing to fetch ${host} — ${reason}`, rawUrl);
    }
  }

  // Bare hostnames and .local resolve through mDNS/search domains to whatever
  // the host's resolver decides — usually something internal.
  if (!net.isIP(host) && (!host.includes('.') || host.endsWith('.local'))) {
    throw new BlockedUrlError(
      'url_non_public_host',
      `refusing to fetch non-public hostname '${host}'`,
      rawUrl,
    );
  }

  return url;
}

/**
 * Resolve the host and reject if ANY answer is private. Checking every answer
 * matters: a name that returns one public and one loopback address would
 * otherwise be a coin flip, and the browser picks, not us.
 *
 * Returns the resolved addresses so a caller can pin them if it wants to.
 */
export async function assertResolvesPublic(url, { resolver = dns } = {}) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return [host]; // already judged in assertSubmittable

  let addresses;
  try {
    addresses = await resolver.lookup(host, { all: true, verbatim: true });
  } catch (err) {
    throw new BlockedUrlError('url_dns_failed', `could not resolve '${host}': ${err.code ?? err.message}`, url.href);
  }
  if (!addresses.length) {
    throw new BlockedUrlError('url_dns_empty', `'${host}' resolved to no addresses`, url.href);
  }

  for (const { address } of addresses) {
    const reason = blockedIpReason(address);
    if (reason) {
      throw new BlockedUrlError(
        'url_private_address',
        `'${host}' resolves to ${address} — ${reason}`,
        url.href,
      );
    }
  }
  return addresses.map((a) => a.address);
}

/** Submit-time gate: structure + DNS. Throws BlockedUrlError. */
export async function assertNavigable(rawUrl, opts = {}) {
  const url = assertSubmittable(rawUrl);
  await assertResolvesPublic(url, opts);
  return url;
}

/**
 * Frontier filter. A crawl discovers hundreds of URLs and one bad link must not
 * fail the job — so this reports rather than throws, and the caller records the
 * URL as skipped with a reason, exactly as it does for robots and offsite.
 */
export async function checkFrontierUrl(rawUrl, opts = {}) {
  try {
    await assertNavigable(rawUrl, opts);
    return { allowed: true };
  } catch (err) {
    if (err instanceof BlockedUrlError) {
      return { allowed: false, reason: err.code, detail: err.message };
    }
    throw err;
  }
}
