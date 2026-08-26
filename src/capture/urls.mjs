// URL normalisation and page-slug rules, lifted unchanged from the pipeline's
// crawl.mjs. These decide artefact directory names and de-duplication, so any
// change here silently reshapes every downstream consumer — treat them as
// frozen and let the parity fixtures police them.

import { createHash } from 'node:crypto';

export function normalizeUrl(raw, base) {
  let u;
  try {
    u = new URL(raw, base);
  } catch {
    return null;
  }
  u.hash = '';
  // strip common tracking params
  const drop = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid'];
  drop.forEach((p) => u.searchParams.delete(p));
  // remove trailing index.html
  u.pathname = u.pathname.replace(/\/index\.html?$/i, '/');
  // collapse duplicate slashes
  u.pathname = u.pathname.replace(/\/{2,}/g, '/');
  let s = u.toString();
  // normalise trailing slash (keep root slash, drop others except when query present)
  if (!u.search && s.endsWith('/') && u.pathname !== '/') s = s.slice(0, -1);
  return s;
}

export function hostAllowed(urlStr, allowedDomains) {
  try {
    const h = new URL(urlStr).hostname.toLowerCase();
    return allowedDomains.some((d) => h === d.toLowerCase());
  } catch {
    return false;
  }
}

export function pathExcluded(urlStr, patterns) {
  try {
    const p = new URL(urlStr).pathname.toLowerCase();
    return patterns.some((pat) => p.startsWith(pat.toLowerCase()));
  } catch {
    return true;
  }
}

/**
 * The host+path of a URL that carries a query string, or null when it carries none. Used to
 * cap how many query-string VARIANTS of one path a crawl will fetch: a parameterised URL is
 * usually the same page (or a redirect to the same page) under a different key, and each
 * variant costs a fetch against maxPages. Not applied inside normalizeUrl on purpose — that
 * function names artefact directories and is frozen.
 */
export function queryVariantKey(urlStr) {
  try {
    const u = new URL(urlStr);
    if (!u.search || u.search === '?') return null;
    return `${u.hostname.toLowerCase()}${u.pathname.toLowerCase()}`;
  } catch {
    return null;
  }
}

/**
 * Whether fetching `urlStr` would exceed `max` query-string variants of its path. `counts`
 * is the crawl's Map(key -> fetched so far); a URL without a query never counts. When the
 * answer is "fetch it", the count is incremented here so the caller has one decision point.
 */
export function variantCapExceeded(counts, urlStr, max) {
  const key = queryVariantKey(urlStr);
  if (!key || !Number.isFinite(max) || max <= 0) return false;
  const n = counts.get(key) ?? 0;
  if (n >= max) return true;
  counts.set(key, n + 1);
  return false;
}

export function slugForUrl(urlStr, used) {
  const u = new URL(urlStr);
  let base = u.pathname.replace(/^\/|\/$/g, '');
  if (!base) base = 'home';
  base = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'page';
  let slug = base;
  let n = 1;
  while (used.has(slug)) slug = `${base}-${n++}`;
  used.add(slug);
  return slug;
}

export function sha256(s) {
  return 'sha256:' + createHash('sha256').update(s || '').digest('hex');
}

/**
 * Registrable-ish domain, used only as the politeness bucket key. A public
 * suffix list would be more correct, but over-grouping (treating co.uk sites as
 * one bucket) would throttle unrelated hosts, and under-grouping only costs
 * politeness — so this errs toward the last two or three labels.
 */
export function politenessKey(urlStr) {
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    const parts = host.split('.');
    if (parts.length <= 2) return host;
    const twoLevelTlds = ['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'sch.uk', 'com.au', 'co.nz', 'co.za', 'com.br'];
    const lastTwo = parts.slice(-2).join('.');
    return twoLevelTlds.includes(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
  } catch {
    return urlStr;
  }
}
