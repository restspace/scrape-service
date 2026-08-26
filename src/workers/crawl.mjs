// Deep single-site capture.
//
// Ported from the pipeline's crawl.mjs. The capture logic is unchanged — the
// parity fixtures exist to prove that. What changed is the shape around it:
//
//   * a job spec replaces argv, and the function returns the crawl index
//     instead of calling process.exit
//   * every URL passes the SSRF guard: the root fails the job, a bad frontier
//     URL is skipped with a reason, exactly like robots or offsite
//   * progress is emitted structurally so the parent process can track it,
//     while the human log lines stay identical for the client shim to replay
//   * an AbortSignal makes cancellation and wall-clock timeouts possible
//
// Everything else — the tiered frontier, the settle ritual, the metadata-image
// fallback, the artefact layout — is the original behaviour.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

import { launchBrowser, makeDesktopContext, makeMobileContext } from '../capture/browser.mjs';
import { extractInPage, collectMetadataImages, FULL_CAPABILITIES } from '../capture/extract.mjs';
import { settlePage } from '../capture/settle.mjs';
import { loadRobots, discoverSitemapUrls, makeRobotsBlocker } from '../capture/robots.mjs';
import { normalizeUrl, hostAllowed, pathExcluded, slugForUrl, sha256, variantCapExceeded } from '../capture/urls.mjs';
import { assertNavigable, checkFrontierUrl, BlockedUrlError } from '../net/guard.mjs';

export class CrawlAbortedError extends Error {
  constructor(reason) {
    super(`crawl aborted: ${reason}`);
    this.name = 'CrawlAbortedError';
    this.code = 'aborted';
  }
}

/** Fill a job spec out with defaults and derive allowedDomains, as loadConfig did. */
export function resolveCrawlSpec(spec, defaults) {
  const cfg = { ...defaults, ...spec };
  if (!cfg.rootUrl) {
    const err = new Error('rootUrl is required');
    err.code = 'spec_invalid';
    throw err;
  }
  const rootHost = new URL(cfg.rootUrl).hostname;
  if (!cfg.allowedDomains || cfg.allowedDomains.length === 0) {
    const bare = rootHost.replace(/^www\./, '');
    cfg.allowedDomains = [bare, 'www.' + bare];
  }
  return cfg;
}

/**
 * Delay a 429 asks for: the Retry-After header (delta-seconds or HTTP-date)
 * when the server sent a usable one, else the caller's backoff — capped, so a
 * hostile or broken header cannot stall a job for its whole wall clock.
 */
export function retryAfterMs(headers, fallbackMs, capMs = 60_000) {
  const v = headers?.['retry-after'];
  let ms = fallbackMs;
  if (v !== undefined && v !== '') {
    const secs = Number(v);
    ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(v) - Date.now();
    if (!Number.isFinite(ms) || ms < 0) ms = fallbackMs;
  }
  return Math.min(ms, capMs);
}

// Which tier the next page comes from. Exported for tests: this one decision is why a blog
// archive is reachable or not. The tier furthest BELOW its quota share wins; a tier with
// nothing queued is skipped entirely, so its share flows to the others rather than idling.
export function chooseTier(has, taken, quotas) {
  const total = taken.reduce((a, b) => a + b, 0);
  let pick = -1, worst = Infinity;
  for (let t = 0; t < quotas.length; t++) {
    if (!has[t]) continue;
    const deficit = taken[t] - quotas[t] * Math.max(1, total);
    if (deficit < worst) { worst = deficit; pick = t; }
  }
  return pick === -1 ? 0 : pick;
}

export async function runCrawl(spec, ctx = {}) {
  const {
    outDir,
    defaults = {},
    userAgent = 'Mozilla/5.0 (compatible; AtelyrCaptureBot/1.0; +https://atelyr.com/bot)',
    signal,
    onProgress = () => {},
    politeness = null,
    guardOpts = {},
  } = ctx;

  const cfg = resolveCrawlSpec(spec, defaults);
  const pagesDir = path.join(outDir, 'pages');
  const logsDir = path.join(outDir, 'logs');
  await mkdir(pagesDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });
  await mkdir(path.join(outDir, 'assets'), { recursive: true });

  const logLines = [];
  const log = (m) => {
    const line = `[${new Date().toISOString()}] ${m}`;
    logLines.push(line);
    // The human line is what the client shim replays to stdout, so its wording
    // and shape must stay exactly as the original CLI produced it.
    onProgress({ type: 'log', message: m });
  };
  const errors = [];

  const checkAborted = () => {
    if (signal?.aborted) throw new CrawlAbortedError(signal.reason ?? 'cancelled');
  };

  log(`Crawl start: ${cfg.rootUrl} (maxPages=${cfg.maxPages}, depth=${cfg.crawlDepth})`);

  // The submitted root is caller-controlled, so a bad one fails the job outright
  // rather than being recorded as a skip — there would be nothing left to crawl.
  await assertNavigable(cfg.rootUrl, guardOpts);

  // robots + sitemap discovery
  const rootOrigin = new URL(cfg.rootUrl).origin;
  const { robots, robotsTxtFound } = await loadRobots(rootOrigin, {
    respect: cfg.respectRobotsTxt,
    timeoutMs: cfg.timeoutMs,
    userAgent,
  });
  if (robotsTxtFound) {
    log(`robots.txt found (${robots.disallow.length} disallow rules, ${robots.sitemaps.length} sitemaps)`);
  }

  const sitemapCandidates = robots.sitemaps.length ? robots.sitemaps : [rootOrigin + '/sitemap.xml'];
  let sitemapUrls = [];
  for (const sm of sitemapCandidates) {
    sitemapUrls.push(...(await discoverSitemapUrls(sm, cfg.timeoutMs, new Set(), 0, userAgent)));
  }
  sitemapUrls = [...new Set(sitemapUrls.map((u) => normalizeUrl(u, rootOrigin)).filter(Boolean))];
  const sitemapXmlFound = sitemapUrls.length > 0;
  log(`Sitemap discovery: ${sitemapUrls.length} urls`);

  const robotsBlocks = makeRobotsBlocker(robots, cfg.respectRobotsTxt);

  // seed queue — tiered so the site's own navigation is never starved by a large
  // sitemap backlog (tier 0: root + header/nav/footer links, tier 1: body links,
  // tier 2: sitemap). A queued URL is promoted if later discovered at a better tier.
  // A site that answers on both schemes hands us every page twice: normalizeUrl keeps the
  // scheme, so http://host/a and https://host/a are different frontier entries and both get
  // captured. Measured on simoncooper.co.uk, 12 of 27 and 13 of 45 pages fetched in a job were
  // http:// duplicates of pages already captured over https — a third to a half of the budget
  // spent re-fetching what we already had, and 14 duplicate artefact directories to show for it.
  // Canonicalise to the ROOT's scheme, and only for the root's own host, so a genuinely
  // http-only third-party host is untouched. Done at the frontier, not in normalizeUrl: that
  // function decides artefact directory names and is deliberately frozen.
  const rootScheme = (() => { try { return new URL(cfg.rootUrl).protocol; } catch { return 'https:'; } })();
  const rootHost = (() => { try { return new URL(cfg.rootUrl).hostname.toLowerCase(); } catch { return null; } })();
  const canonicalScheme = (u) => {
    if (!u || !rootHost) return u;
    try {
      const parsed = new URL(u);
      if (parsed.protocol === rootScheme) return u;
      if (parsed.hostname.toLowerCase() !== rootHost) return u;
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return u;
      parsed.protocol = rootScheme;
      return parsed.toString();
    } catch { return u; }
  };

  const start = normalizeUrl(cfg.rootUrl, rootOrigin);
  const queue = [{ url: start, depth: 0, tier: 0 }];
  for (const raw of sitemapUrls) {
    const u = canonicalScheme(raw);
    if (hostAllowed(u, cfg.allowedDomains) && u !== start && !queue.some((q) => q.url === u)) {
      queue.push({ url: u, depth: 1, tier: 2 });
    }
  }

  const queuedEntry = new Map(queue.map((q) => [q.url, q]));
  const queued = new Set(queue.map((q) => q.url));
  // Tiers get a guaranteed SHARE of the budget, not strict priority. Strict priority was
  // introduced so a big sitemap could not starve the site's own navigation, and it
  // over-corrected: tier 0 is drained completely first, so on any site with a substantial
  // header/footer the body links (tier 1) and the sitemap backlog (tier 2) are never reached
  // at all. That is why every blog archive on this fleet was uncapturable — ha-accountants
  // spent all 50 pages of a /news/-rooted crawl on nav pages and captured not one post, at
  // depth 3 and again at depth 6 (2026-08-25). Raising maxPages, changing the root or
  // excluding paths could not fix it, because none of them changes the ORDER.
  //
  // Quotas are floors, not caps: a tier that runs out of queued URLs hands its share to
  // whoever is left, so a site with no sitemap still spends everything on nav and body.
  const TIER_QUOTA = [0.5, 0.3, 0.2]; // tier 0 nav, tier 1 body, tier 2 sitemap
  const tierTaken = [0, 0, 0];
  const dequeue = () => {
    const has = [0, 1, 2].map((t) => queue.some((q) => q.tier === t));
    const pick = chooseTier(has, tierTaken, TIER_QUOTA);
    let best = -1;
    for (let i = 0; i < queue.length; i++) {
      if (queue[i].tier !== pick) continue;
      best = i;
      break;
    }
    if (best === -1) {
      for (let i = 0; i < queue.length; i++) if (best === -1 || queue[i].tier < queue[best].tier) best = i;
    }
    const entry = queue.splice(best, 1)[0];
    if (entry && entry.tier >= 0 && entry.tier <= 2) tierTaken[entry.tier]++;
    queuedEntry.delete(entry.url);
    return entry;
  };
  const crawled = new Map(); // url -> page record
  const skipped = [];
  const usedSlugs = new Set();
  const backoffsDone = new Map(); // url -> 429 backoffs already taken
  let discovered = queued.size;

  // Resolves early on abort rather than rejecting, so callers follow it with
  // checkAborted() and the abort surfaces as CrawlAbortedError like everywhere else.
  const sleep = (ms) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => { clearTimeout(t); resolve(); };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });

  // Budget protection against parameterised URLs (2026-08-26, landerstheaccountants.com):
  // one gap crawl spent 34 of 120 pages fetching special_reports_downloads.php?which=<key>
  // — every one a distinct frontier entry, every one redirecting to the same excluded
  // /login/why_register.php, which was then captured 34 times because exclusions were only
  // ever applied to the URL asked for. Three guards, all recorded in `skipped` with a reason:
  //   variantFetches   — at most cfg.maxQueryVariantsPerPath fetches of one path's query
  //                      variants (query_variant_cap);
  //   landed-URL checks — path exclusions re-applied to where the browser LANDED, after the
  //                      HTTP redirect and again after settle (excluded_path_redirect);
  //   capturedFinal    — a redirect that lands on a page already captured is not captured
  //                      again (redirect_target_duplicate).
  const variantFetches = new Map(); // host+path -> query variants fetched
  const capturedFinal = new Set(); // every finalUrl captured so far

  const browser = await launchBrowser();
  const desktop = await makeDesktopContext(browser, { userAgent });
  const mobile = cfg.captureMobile ? await makeMobileContext(browser) : null;

  try {
    while (queue.length && crawled.size < cfg.maxPages) {
      checkAborted();
      const entry = dequeue();
      const { url, depth } = entry;
      if (crawled.has(url)) continue;
      if (!hostAllowed(url, cfg.allowedDomains)) { skipped.push({ url, reason: 'offsite' }); continue; }
      if (pathExcluded(url, cfg.excludedPathPatterns)) { skipped.push({ url, reason: 'excluded_path' }); continue; }
      if (robotsBlocks(url)) { skipped.push({ url, reason: 'robots_disallow' }); continue; }
      if (depth > cfg.crawlDepth) { skipped.push({ url, reason: 'depth_exceeded' }); continue; }
      if (variantCapExceeded(variantFetches, url, cfg.maxQueryVariantsPerPath)) { skipped.push({ url, reason: 'query_variant_cap', max: cfg.maxQueryVariantsPerPath }); continue; }

      // Re-check at navigation time, not just at discovery: this is the DNS
      // rebinding window, and a same-host redirect could land anywhere.
      const gate = await checkFrontierUrl(url, guardOpts);
      if (!gate.allowed) { skipped.push({ url, reason: gate.reason, detail: gate.detail }); continue; }

      if (politeness) await politeness.acquire(url, signal);

      const page = await desktop.newPage();
      const redirectChain = [];
      try {
        log(`Crawling [${crawled.size + 1}/${cfg.maxPages}] d${depth}: ${url}`);
        onProgress({ type: 'progress', pagesCrawled: crawled.size, pagesDiscovered: discovered, currentUrl: url });

        const resp = await page.goto(url, { waitUntil: cfg.navWaitUntil, timeout: cfg.timeoutMs }).catch(async () => {
          // fallback to domcontentloaded if networkidle times out
          return page.goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.timeoutMs });
        });
        const status = resp ? resp.status() : 0;
        const finalUrl = normalizeUrl(page.url(), rootOrigin);
        const contentType = resp ? (resp.headers()['content-type'] || '') : '';

        // The frontier checks vetted the URL we asked for, not the one the
        // browser landed on — an HTTP redirect can hop to any host.
        if (!hostAllowed(finalUrl, cfg.allowedDomains)) {
          skipped.push({ url, reason: 'offsite_redirect', finalUrl });
          await page.close();
          continue;
        }
        // Same for path exclusions: a redirect into an excluded subtree is still excluded.
        if (finalUrl !== url && pathExcluded(finalUrl, cfg.excludedPathPatterns)) {
          skipped.push({ url, reason: 'excluded_path_redirect', finalUrl });
          await page.close();
          continue;
        }

        // 429 means "not now", not "here is the page" — back off and requeue
        // rather than capturing the rate-limit interstitial as content. After
        // cfg.rateLimitRetries backoffs the URL is recorded as skipped.
        if (status === 429) {
          const attempts = backoffsDone.get(url) ?? 0;
          await page.close();
          if (attempts >= cfg.rateLimitRetries) {
            skipped.push({ url, reason: 'rate_limited', attempts });
            continue;
          }
          backoffsDone.set(url, attempts + 1);
          const delayMs = retryAfterMs(resp?.headers(), cfg.rateLimitBackoffMs * 2 ** attempts);
          log(`  429 on ${url} — backing off ${(delayMs / 1000).toFixed(1)}s (retry ${attempts + 1}/${cfg.rateLimitRetries})`);
          await sleep(delayMs);
          checkAborted();
          queue.push(entry);
          queuedEntry.set(url, entry);
          continue;
        }

        if (!contentType.includes('html') && contentType) {
          skipped.push({ url, reason: 'non_html', contentType });
          await page.close();
          continue;
        }

        // settle, then auto-scroll to trigger lazy-loaded images / intersection observers
        // (page builders defer team/hero photos until they scroll into view), then return to top
        const hadDelayedJs = await settlePage(page);

        // JS and meta-refresh redirects fire while the page settles, so the
        // host has to be re-checked before anything is captured from it.
        const settledUrl = normalizeUrl(page.url(), rootOrigin);
        if (!hostAllowed(settledUrl, cfg.allowedDomains)) {
          skipped.push({ url, reason: 'offsite_redirect', finalUrl: settledUrl });
          await page.close();
          continue;
        }
        if (settledUrl !== url && pathExcluded(settledUrl, cfg.excludedPathPatterns)) {
          skipped.push({ url, reason: 'excluded_path_redirect', finalUrl: settledUrl });
          await page.close();
          continue;
        }
        // A redirect onto a page already captured (under its own URL or via another
        // redirect) adds nothing but a duplicate artefact directory.
        if (settledUrl !== url && (capturedFinal.has(settledUrl) || crawled.has(settledUrl))) {
          skipped.push({ url, reason: 'redirect_target_duplicate', finalUrl: settledUrl });
          await page.close();
          continue;
        }

        const data = await page.evaluate(extractInPage, FULL_CAPABILITIES);

        // metadata-image fallback: fold og:image / twitter:image / JSON-LD ImageObject
        // urls into images (deduped by absolute URL) so pages whose galleries never
        // rendered (delayed JS, broken scripts) still yield real imagery downstream
        const domImageCount = data.images.length;
        const domSrcs = new Set(data.images.map((i) => i.src));
        const metaImages = collectMetadataImages(data, page.url()).filter((m) => !domSrcs.has(m.src));
        data.images.push(...metaImages);
        const imagesFromMetadataOnly = status === 200 && domImageCount === 0 && metaImages.length > 0;
        if (imagesFromMetadataOnly) log(`  WARN: zero DOM-sourced images; captured ${metaImages.length} metadata image(s) (og:image / structured data) — likely interaction-delayed JS gallery`);

        // Prefer Playwright's a11y snapshot when present; fall back to the in-page tree.
        let ax = data.accessibilityTree || {};
        if (page.accessibility && typeof page.accessibility.snapshot === 'function') {
          ax = (await page.accessibility.snapshot({ interestingOnly: true }).catch(() => null)) || ax;
        }

        const slug = slugForUrl(finalUrl, usedSlugs);
        const dir = path.join(pagesDir, slug);
        await mkdir(dir, { recursive: true });

        // screenshots
        let shotDesktop = null, shotMobile = null;
        if (cfg.captureDesktop) {
          shotDesktop = `pages/${slug}/screenshot-desktop.png`;
          await page.screenshot({ path: path.join(dir, 'screenshot-desktop.png'), fullPage: true }).catch((e) => errors.push({ url, stage: 'screenshot-desktop', message: String(e) }));
        }
        if (mobile) {
          const mp = await mobile.newPage();
          try {
            await mp.goto(finalUrl, { waitUntil: 'domcontentloaded', timeout: cfg.timeoutMs });
            await mp.waitForTimeout(500);
            shotMobile = `pages/${slug}/screenshot-mobile.png`;
            await mp.screenshot({ path: path.join(dir, 'screenshot-mobile.png'), fullPage: true });
          } catch (e) {
            errors.push({ url, stage: 'screenshot-mobile', message: String(e) });
          } finally {
            await mp.close();
          }
        }

        // write artefacts
        const metadata = {
          url: finalUrl,
          sourceUrl: url,
          status,
          contentType,
          redirectChain,
          ...data.metadata,
          textHash: sha256(data.readable),
        };
        const w = (name, obj) => writeFile(path.join(dir, name), JSON.stringify(obj, null, 2));
        await Promise.all([
          w('metadata.json', metadata),
          w('headings.json', { headings: data.headings }),
          w('links.json', { links: data.links }),
          w('images.json', { images: data.images }),
          w('forms.json', { forms: data.forms }),
          w('buttons.json', { buttons: data.buttons }),
          w('structured-data.json', { structuredData: data.structuredData }),
          w('accessibility-tree.json', ax || {}),
          w('visible-text.json', { visibleText: data.visibleText }),
          w('blocks.json', { blocks: data.blocks.map((b, i) => ({ id: `${slug}.${b.localId}`, sourceUrl: finalUrl, ...b })) }),
          writeFile(path.join(dir, 'readable.md'), `# ${data.metadata.title || finalUrl}\n\n<${finalUrl}>\n\n${data.readable}\n`),
          writeFile(path.join(dir, 'content.html'), data.contentHtml || ''),
        ]);

        capturedFinal.add(finalUrl);
        capturedFinal.add(settledUrl);
        crawled.set(url, {
          slug,
          sourceUrl: url,
          finalUrl,
          canonicalUrl: data.metadata.canonicalUrl || finalUrl,
          title: data.metadata.title,
          status,
          depth,
          redirectChain,
          screenshotDesktop: shotDesktop,
          screenshotMobile: shotMobile,
          counts: {
            headings: data.headings.length,
            links: data.links.length,
            images: data.images.length,
            forms: data.forms.length,
            blocks: data.blocks.length,
            structuredData: data.structuredData.length,
          },
          ...(imagesFromMetadataOnly ? { imagesFromMetadataOnly: true } : {}),
        });

        // enqueue internal links — header/nav/footer links crawl before body links
        // and the sitemap backlog; an already-queued URL is promoted to the better tier.
        if (depth < cfg.crawlDepth) {
          for (const l of data.links) {
            if (l.type !== 'internal') continue;
            const n = canonicalScheme(normalizeUrl(l.href, finalUrl));
            if (!n || crawled.has(n)) continue;
            if (!hostAllowed(n, cfg.allowedDomains)) continue;
            const tier = ['header', 'navigation', 'footer'].includes(l.appearsIn) ? 0 : 1;
            const existing = queuedEntry.get(n);
            if (existing) {
              if (tier < existing.tier) {
                // Promotion re-queues at the tail: a sitemap-seeded URL promoted by an
                // on-page link must not keep its early seed position, or the whole
                // sitemap backlog outranks links discovered on real pages.
                existing.tier = tier;
                const idx = queue.indexOf(existing);
                if (idx > -1) { queue.splice(idx, 1); queue.push(existing); }
              }
              if (depth + 1 < existing.depth) existing.depth = depth + 1;
              continue;
            }
            if (queued.has(n)) continue;
            queued.add(n);
            discovered++;
            const entry = { url: n, depth: depth + 1, tier };
            queue.push(entry);
            queuedEntry.set(n, entry);
          }
        }
      } catch (e) {
        if (e instanceof CrawlAbortedError) throw e;
        errors.push({ url, stage: 'crawl', message: String(e && e.message ? e.message : e) });
        log(`  ERROR: ${e && e.message ? e.message : e}`);
      } finally {
        await page.close().catch(() => {});
        // Must pair with the acquire above: every page of a crawl shares one
        // domain, so a leaked slot stalls the rest of the job outright.
        if (politeness) politeness.release(url);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  // Assets inventory — NEUTRAL evidence only. We deliberately do NOT assign a semantic
  // role here; the LLM stage classifies each image (logo / staff portrait / premises /
  // stock / icon …) and its identity from the captured context. The only fields the
  // script asserts are factual: url, dimensions, format, where it appears, and the
  // surrounding DOM context (container classes, nearby text, heading, caption, link).
  const onlyExt = (src) => (src.split('?')[0].split('#')[0].split('.').pop() || '').toLowerCase();
  const assetMap = new Map();
  for (const [, rec] of crawled) {
    const imgPath = path.join(pagesDir, rec.slug, 'images.json');
    try {
      const { images } = JSON.parse(await readFile(imgPath, 'utf8'));
      for (const img of images) {
        if (!img.src) continue;
        const key = img.src;
        if (!assetMap.has(key)) {
          assetMap.set(key, {
            id: `asset.image.${String(assetMap.size + 1).padStart(3, '0')}`,
            type: 'image',
            sourceUrl: img.src,
            ext: onlyExt(img.src),
            source: img.source || 'img',
            alt: img.alt || '',
            title: img.title || '',
            width: img.width || null,
            height: img.height || null,
            // role + identity intentionally LEFT FOR THE LLM (see SKILL.md step 3)
            role: null,
            appearsOn: [],
            contexts: [],
          });
        }
        const a = assetMap.get(key);
        a.appearsOn.push(rec.finalUrl);
        if (img.context && a.contexts.length < 4) a.contexts.push({ page: rec.slug, ...img.context });
      }
    } catch { /* ignore */ }
  }
  const assets = [...assetMap.values()];
  await writeFile(path.join(outDir, 'assets', 'manifest.json'), JSON.stringify({
    note: 'Neutral image inventory. role/identity are null by design — classify each image with an LLM using alt, dimensions, source and contexts[] (container classes, nearby text, nearest heading, caption, link).',
    assets,
  }, null, 2));

  // discovered sitemap
  const smXml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[...crawled.values()].map((r) => `  <url><loc>${r.finalUrl}</loc></url>`).join('\n')}\n</urlset>\n`;
  await writeFile(path.join(outDir, 'sitemap-discovered.xml'), smXml);

  // crawl.json index
  const crawlIndex = {
    schemaVersion: '0.1',
    source: {
      rootUrl: cfg.rootUrl,
      crawlDate: new Date().toISOString().slice(0, 10),
      businessCategoryHint: cfg.businessCategoryHint ?? null,
      targetMarket: cfg.targetMarket ?? null,
      allowedDomains: cfg.allowedDomains,
    },
    crawl: {
      maxPages: cfg.maxPages,
      pagesDiscovered: discovered,
      pagesCrawled: crawled.size,
      pagesSkipped: skipped.length,
      errors: errors.length,
      robotsTxtFound,
      sitemapXmlFound,
      captureMobile: cfg.captureMobile,
      captureDesktop: cfg.captureDesktop,
    },
    pages: [...crawled.values()],
    skipped,
    assetsCount: assets.length,
  };
  await writeFile(path.join(outDir, 'crawl.json'), JSON.stringify(crawlIndex, null, 2));
  await writeFile(path.join(logsDir, 'crawl.log'), logLines.join('\n') + '\n');
  await writeFile(path.join(logsDir, 'errors.json'), JSON.stringify(errors, null, 2));

  log(`Done. Crawled ${crawled.size}, skipped ${skipped.length}, errors ${errors.length}.`);
  log(`Output: ${outDir}`);

  return crawlIndex;
}
