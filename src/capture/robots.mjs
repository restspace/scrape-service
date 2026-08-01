// robots.txt and sitemap discovery, lifted from the pipeline's crawl.mjs.
//
// One behavioural change from the original: `fetchText` now takes a User-Agent.
// A crawler that runs from a server and identifies itself is the minimum courtesy
// a site operator is owed; the CLI could get away with the default.

const DEFAULT_UA = 'Mozilla/5.0 (compatible; AtelyrCaptureBot/1.0; +https://atelyr.com/bot)';

export async function fetchText(url, timeoutMs, userAgent = DEFAULT_UA) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'user-agent': userAgent },
    });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** { disallow: [paths], sitemaps: [urls] } for User-agent: * (and global sitemaps). */
export function parseRobots(txt) {
  const out = { disallow: [], sitemaps: [] };
  if (!txt) return out;
  let applies = false;
  for (const line of txt.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    const [rawK, ...rest] = l.split(':');
    const k = rawK.trim().toLowerCase();
    const v = rest.join(':').trim();
    if (k === 'user-agent') applies = v === '*';
    else if (k === 'sitemap') out.sitemaps.push(v);
    else if (k === 'disallow' && applies && v) out.disallow.push(v);
  }
  return out;
}

export async function discoverSitemapUrls(sitemapUrl, timeoutMs, seen = new Set(), depth = 0, userAgent = DEFAULT_UA) {
  if (depth > 3 || seen.has(sitemapUrl)) return [];
  seen.add(sitemapUrl);
  const xml = await fetchText(sitemapUrl, timeoutMs, userAgent);
  if (!xml) return [];
  const urls = [];
  const locs = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1]);
  const isIndex = /<sitemapindex/i.test(xml);
  if (isIndex) {
    for (const child of locs) urls.push(...(await discoverSitemapUrls(child, timeoutMs, seen, depth + 1, userAgent)));
  } else {
    urls.push(...locs);
  }
  return urls;
}

/**
 * Fetch and parse robots.txt for an origin. Returns the rules plus whether a
 * robots.txt actually existed, which the crawl index records.
 */
export async function loadRobots(origin, { respect, timeoutMs, userAgent }) {
  if (!respect) return { robots: { disallow: [], sitemaps: [] }, robotsTxtFound: false };
  const txt = await fetchText(origin + '/robots.txt', timeoutMs, userAgent);
  if (!txt) return { robots: { disallow: [], sitemaps: [] }, robotsTxtFound: false };
  return { robots: parseRobots(txt), robotsTxtFound: true };
}

/** Prefix-match disallow check, matching the original's semantics exactly. */
export function makeRobotsBlocker(robots, respect) {
  return (u) =>
    respect &&
    robots.disallow.some((d) => {
      try {
        return new URL(u).pathname.startsWith(d);
      } catch {
        return false;
      }
    });
}
