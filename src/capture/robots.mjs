// robots.txt and sitemap discovery, lifted from the pipeline's crawl.mjs.
//
// Two behavioural changes from the original. `fetchText` takes a User-Agent: a
// crawler that runs from a server and identifies itself is the minimum courtesy
// a site operator is owed; the CLI could get away with the default. And
// `parseRobots` honours rules addressed to the crawler's own product token, so
// an operator who reads that name in their logs can write a rule for it.

import { DEFAULT_USER_AGENT as DEFAULT_UA, DEFAULT_ROBOTS_TOKEN } from '../config.mjs';

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

/**
 * { disallow: [paths], sitemaps: [urls], group } for one crawler.
 *
 * Group selection follows RFC 9309: rules addressed to our own product token
 * (`User-agent: RapiderITBot`, any case) are the ones that apply, and they
 * replace the `*` rules rather than adding to them; only when no group names us
 * do the `*` rules apply. Several groups naming the same crawler are merged,
 * and consecutive `User-agent` lines share the rules that follow them. Sitemaps
 * are global. `group` records which rules were used: 'token', '*' or null.
 *
 * Within the chosen group this stays a prefix match on `Disallow` only, as the
 * original was: `Allow` and wildcards are not interpreted, which can only make
 * the crawler stay away from more than it had to.
 */
export function parseRobots(txt, robotsToken = DEFAULT_ROBOTS_TOKEN) {
  const out = { disallow: [], sitemaps: [], group: null };
  if (!txt) return out;
  const token = String(robotsToken ?? '').toLowerCase();
  const own = [];
  const star = [];
  let ownSeen = false;
  let starSeen = false;
  let forOwn = false;
  let forStar = false;
  let inAgentLines = false;
  for (const line of txt.split(/\r?\n/)) {
    const l = line.replace(/^﻿/, '').replace(/#.*$/, '').trim();
    if (!l) continue;
    const [rawK, ...rest] = l.split(':');
    const k = rawK.trim().toLowerCase();
    const v = rest.join(':').trim();
    if (k === 'user-agent') {
      // A User-agent line after a rule starts a new group; after another
      // User-agent line it widens the one being declared.
      if (!inAgentLines) { forOwn = false; forStar = false; }
      inAgentLines = true;
      // `RapiderITBot/1.0` and `rapideritbot` both address the token.
      const named = (/^[a-z0-9_-]+/i.exec(v)?.[0] ?? '').toLowerCase();
      if (v === '*') { forStar = true; starSeen = true; }
      else if (token && named === token) { forOwn = true; ownSeen = true; }
      continue;
    }
    if (k === 'sitemap') { out.sitemaps.push(v); continue; }
    // Only rule lines close the run of User-agent lines; anything unrecognised
    // is skipped without ending the group.
    if (k !== 'disallow' && k !== 'allow' && k !== 'crawl-delay') continue;
    inAgentLines = false;
    if (k === 'disallow' && v) {
      if (forOwn) own.push(v);
      if (forStar) star.push(v);
    }
  }
  out.disallow = ownSeen ? own : star;
  out.group = ownSeen ? 'token' : starSeen ? '*' : null;
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
export async function loadRobots(origin, { respect, timeoutMs, userAgent, robotsToken }) {
  if (!respect) return { robots: { disallow: [], sitemaps: [], group: null }, robotsTxtFound: false };
  const txt = await fetchText(origin + '/robots.txt', timeoutMs, userAgent);
  if (!txt) return { robots: { disallow: [], sitemaps: [], group: null }, robotsTxtFound: false };
  return { robots: parseRobots(txt, robotsToken), robotsTxtFound: true };
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
