// Shallow batch capture for prospect qualification.
//
// Scans every candidate site (home + up to 3-4 key pages), desktop + mobile,
// and writes per-site capture artefacts. Optimised for throughput, not
// completeness (no sitemap discovery, no BFS, no asset inventory).
// No LLM here — this captures what exists. Dead sites are a signal, not an error.
//
// Ported from the pipeline's scan.mjs. The per-site capture logic is unchanged;
// what changed is the shell around it, and two deliberate behaviour changes:
//
//   * robots.txt is now honoured. The original ignored it entirely, which was
//     defensible for a hand-picked local batch and is not defensible for a
//     server that scans hundreds of third-party sites unattended.
//   * every candidate URL passes the SSRF guard, and per-domain politeness is
//     shared with any concurrent crawl job.
//
// The batch.json resume model is kept as-is: it was already the better of the
// two workers in this respect, and the job engine relies on it to make a
// restarted scan pick up where it left off.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

import { launchBrowser } from '../capture/browser.mjs';
import { extractInPage, SCAN_CAPABILITIES } from '../capture/extract.mjs';
import { loadRobots, makeRobotsBlocker } from '../capture/robots.mjs';
import { checkFrontierUrl } from '../net/guard.mjs';

export class ScanAbortedError extends Error {
  constructor(reason) {
    super(`scan aborted: ${reason}`);
    this.name = 'ScanAbortedError';
    this.code = 'aborted';
  }
}

// ---------- pre-flight probe (no browser) ----------
function classifyFetchError(e) {
  const code = (e && (e.cause?.code || e.code)) || '';
  const msg = String(e && (e.cause?.message || e.message) || e);
  if (/CERT|certificate|altname|self.signed|UNABLE_TO_VERIFY/i.test(code + ' ' + msg)) return 'cert_error';
  if (/ENOTFOUND|EAI_AGAIN/i.test(code)) return 'dns_error';
  if (/ECONNREFUSED/i.test(code)) return 'connection_refused';
  if (/ECONNRESET|EPIPE/i.test(code)) return 'connection_reset';
  if (/abort/i.test(msg) || e?.name === 'AbortError' || e?.name === 'TimeoutError') return 'timeout';
  return 'error';
}

async function followRedirects(startUrl, timeoutMs, maxHops = 5) {
  const chain = [];
  let current = startUrl;
  for (let hop = 0; hop <= maxHops; hop++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(current, {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'user-agent': 'Mozilla/5.0 ProspectScanBot/1.0' },
      });
      clearTimeout(t);
      const rec = { url: current, status: res.status };
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        rec.location = new URL(loc, current).toString();
        chain.push(rec);
        current = rec.location;
        continue;
      }
      chain.push(rec);
      return { ok: res.status > 0 && res.status < 500, finalUrl: current, finalStatus: res.status, chain, error: null };
    } catch (e) {
      clearTimeout(t);
      return { ok: false, finalUrl: current, finalStatus: 0, chain, error: classifyFetchError(e), errorDetail: String(e?.cause?.code || e?.message || e).slice(0, 200) };
    }
  }
  return { ok: false, finalUrl: current, finalStatus: 0, chain, error: 'too_many_redirects' };
}

export async function preflight(candidateUrl, timeoutMs) {
  const u = new URL(candidateUrl);
  const host = u.hostname;
  const httpUrl = `http://${host}${u.pathname === '/' ? '' : u.pathname}`;
  const httpsUrl = `https://${host}${u.pathname === '/' ? '' : u.pathname}`;
  const [http, https] = await Promise.all([
    followRedirects(httpUrl, timeoutMs),
    followRedirects(httpsUrl, timeoutMs),
  ]);
  const httpLandsOnHttps = http.ok && /^https:/i.test(http.finalUrl);
  let browseUrl = null;
  if (https.ok) browseUrl = https.finalUrl;
  else if (http.ok) browseUrl = http.finalUrl;
  return { http, https, httpLandsOnHttps, browseUrl, dead: !browseUrl };
}

// The in-page extractor now lives in capture/extract.mjs and is shared with
// the crawl worker. SCAN_CAPABILITIES reproduces exactly what this file used
// to extract on its own: no images, blocks, readable text or a11y tree, and
// visible text capped at 400 nodes without bounding boxes.

// ---------- mobile layout metrics (runs in browser, mobile viewport) ----------
function mobileMetricsInPage() {
  const vw = document.documentElement.clientWidth;
  const scrollWidth = document.documentElement.scrollWidth;
  const overflowing = [];
  const els = document.querySelectorAll('body *');
  let scanned = 0;
  for (const el of els) {
    if (scanned++ > 3000 || overflowing.length >= 10) break;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > vw + 8) {
      let sel = el.nodeName.toLowerCase();
      if (el.id) sel += '#' + el.id;
      else if (el.className && typeof el.className === 'string') sel += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
      overflowing.push({ selector: sel.slice(0, 120), right: Math.round(r.right), width: Math.round(r.width) });
    }
  }
  const bodyFontPx = parseFloat(getComputedStyle(document.body).fontSize) || null;
  // sample visible text nodes' font sizes
  let tiny = 0, sampled = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode() && sampled < 200) {
    const el = walker.currentNode.parentElement;
    if (!el) continue;
    const txt = walker.currentNode.textContent.trim();
    if (txt.length < 3) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    sampled++;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs && fs < 12) tiny++;
  }
  // tap targets above the fold
  let smallTaps = 0, taps = 0;
  for (const t of document.querySelectorAll('a[href], button')) {
    const r = t.getBoundingClientRect();
    if (r.top > window.innerHeight || r.width === 0 || r.height === 0) continue;
    taps++;
    if (r.width < 40 || r.height < 24) smallTaps++;
    if (taps >= 60) break;
  }
  return {
    clientWidth: vw,
    scrollWidth,
    overflowPx: Math.max(0, scrollWidth - vw),
    overflowing,
    bodyFontPx,
    textSampled: sampled,
    tinyTextNodes: tiny,
    tapTargets: taps,
    smallTapTargets: smallTaps,
  };
}

// ---------- helpers ----------
function pageSlug(urlStr, used) {
  let base;
  try {
    base = new URL(urlStr).pathname.replace(/^\/|\/$/g, '') || 'home';
  } catch { base = 'page'; }
  base = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'home';
  let slug = base, n = 1;
  while (used.has(slug)) slug = `${base}-${n++}`;
  used.add(slug);
  return slug;
}

function pickExtraPages(links, browseUrl, patterns, maxExtra) {
  const host = new URL(browseUrl).hostname.replace(/^www\./, '');
  const chosen = [];
  const seen = new Set([normPath(browseUrl)]);
  for (const { pattern } of patterns) {
    if (chosen.length >= maxExtra) break;
    const re = new RegExp(pattern, 'i');
    for (const l of links) {
      if (l.type !== 'internal') continue;
      let u;
      try { u = new URL(l.href); } catch { continue; }
      if (u.hostname.replace(/^www\./, '') !== host) continue;
      if (/\.(pdf|jpg|jpeg|png|gif|zip|docx?)$/i.test(u.pathname)) continue;
      const key = normPath(u.toString());
      if (seen.has(key)) continue;
      if (re.test(u.pathname)) {
        seen.add(key);
        chosen.push(u.toString());
        break; // one page per pattern group
      }
    }
  }
  return chosen;
}

function normPath(urlStr) {
  try {
    const u = new URL(urlStr);
    return u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/$/, '');
  } catch { return urlStr; }
}

async function headCheck(url, timeoutMs) {
  const tryOnce = async (method) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { method, redirect: 'follow', signal: ctrl.signal, headers: { 'user-agent': 'Mozilla/5.0 ProspectScanBot/1.0' } });
      clearTimeout(t);
      return res.status;
    } catch (e) {
      clearTimeout(t);
      return classifyFetchError(e) === 'timeout' ? -1 : 0;
    }
  };
  let status = await tryOnce('HEAD');
  if (status === 405 || status === 501 || status === 403) status = await tryOnce('GET');
  return status;
}

// ---------- per-site scan ----------
async function scanSite(browser, cand, cfg, batchDir, log) {
  const siteDir = path.join(batchDir, 'sites', cand.id);
  const captureDir = path.join(siteDir, 'capture');
  const pagesDir = path.join(captureDir, 'pages');
  const htmlDir = path.join(captureDir, 'html');
  await mkdir(pagesDir, { recursive: true });
  await mkdir(htmlDir, { recursive: true });

  const deadline = Date.now() + cfg.siteBudgetMs;
  const errors = [];

  // 1. pre-flight probe
  const probe = await preflight(cand.url, cfg.probeTimeoutMs);
  await writeFile(path.join(captureDir, 'probe.json'), JSON.stringify(probe, null, 2));
  if (probe.dead) {
    await writeFile(path.join(captureDir, 'failure.json'), JSON.stringify({
      stage: 'preflight',
      error: 'dead',
      detail: { http: probe.http.error, https: probe.https.error },
    }, null, 2));
    log(`${cand.id}: DEAD (http: ${probe.http.error || probe.http.finalStatus}, https: ${probe.https.error || probe.https.finalStatus})`);
    return { outcome: 'dead' };
  }

  let browseUrl = probe.browseUrl;
  const network = { failedRequests: [], mixedContent: [], analyticsHosts: [], thirdPartyHosts: [] };
  const seenAnalytics = new Set();
  const seenThirdParty = new Set();
  const siteHost = new URL(browseUrl).hostname.replace(/^www\./, '');

  const desktop = await browser.newContext({
    viewport: cfg.desktopViewport,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    ignoreHTTPSErrors: true,
  });
  const mobile = await browser.newContext({
    viewport: cfg.mobileViewport,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    ignoreHTTPSErrors: true,
  });

  const attachNetworkLog = (page, pageUrlHttps) => {
    page.on('requestfailed', (req) => {
      if (network.failedRequests.length < 30) network.failedRequests.push({ url: req.url().slice(0, 300), failure: req.failure()?.errorText || 'failed' });
    });
    page.on('request', (req) => {
      const u = req.url();
      if (pageUrlHttps && u.startsWith('http://') && !u.startsWith('http://localhost') && network.mixedContent.length < 20) {
        network.mixedContent.push({ url: u.slice(0, 300), type: req.resourceType() });
      }
      try {
        const h = new URL(u).hostname;
        if (cfg.analyticsHosts.some((a) => h.includes(a)) && !seenAnalytics.has(h)) { seenAnalytics.add(h); network.analyticsHosts.push(h); }
        else if (!h.includes(siteHost) && !seenThirdParty.has(h) && seenThirdParty.size < 25) { seenThirdParty.add(h); network.thirdPartyHosts.push(h); }
      } catch { /* ignore */ }
    });
  };

  const usedSlugs = new Set();
  const pagesCaptured = [];
  let blocked = false;

  const capturePage = async (url, isHome) => {
    const slug = pageSlug(url, usedSlugs);
    const dir = path.join(pagesDir, slug);
    await mkdir(dir, { recursive: true });
    const isHttpsPage = /^https:/i.test(url);

    const page = await desktop.newPage();
    attachNetworkLog(page, isHttpsPage);
    let extracted = null;
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.pageTimeoutMs });
      await page.waitForTimeout(cfg.settleMs);
      const status = resp ? resp.status() : 0;
      const headers = resp ? resp.headers() : {};
      const finalUrl = page.url();

      // Cloudflare / bot-challenge detection
      const title = await page.title().catch(() => '');
      if (/just a moment|attention required|checking your browser/i.test(title)) {
        blocked = true;
        await writeFile(path.join(captureDir, 'failure.json'), JSON.stringify({ stage: 'capture', error: 'blocked', detail: `challenge page: "${title}"` }, null, 2));
        await page.close();
        return null;
      }

      // served (pre-JS) HTML — what copyright/tech-fingerprint regexes should see
      const servedHtml = resp ? await resp.text().catch(() => '') : '';
      await writeFile(path.join(htmlDir, slug + '.html'), servedHtml || (await page.content()));

      const timing = await page.evaluate(() => {
        const e = performance.getEntriesByType('navigation')[0];
        return e ? { responseMs: Math.round(e.responseEnd - e.startTime), domContentLoadedMs: Math.round(e.domContentLoadedEventEnd - e.startTime), loadMs: e.loadEventEnd > 0 ? Math.round(e.loadEventEnd - e.startTime) : null } : null;
      }).catch(() => null);

      extracted = await page.evaluate(extractInPage, SCAN_CAPABILITIES);

      const headerPick = (h) => ({
        'content-type': h['content-type'] || null,
        'last-modified': h['last-modified'] || null,
        server: h.server || null,
        'x-powered-by': h['x-powered-by'] || null,
        'strict-transport-security': h['strict-transport-security'] || null,
      });
      const w = (name, obj) => writeFile(path.join(dir, name), JSON.stringify(obj, null, 2));
      await Promise.all([
        w('response.json', { requestedUrl: url, finalUrl, status, headers: headerPick(headers), timing, isHome }),
        w('metadata.json', extracted.metadata),
        w('links.json', { links: extracted.links }),
        w('forms.json', { forms: extracted.forms }),
        w('buttons.json', { buttons: extracted.buttons }),
        w('structured-data.json', { structuredData: extracted.structuredData }),
        w('visible-text.json', { visibleText: extracted.visibleText }),
      ]);
      await page.screenshot({ path: path.join(dir, 'screenshot-desktop.png'), fullPage: true }).catch((e) => errors.push({ url, stage: 'screenshot-desktop', message: String(e).slice(0, 200) }));
    } catch (e) {
      errors.push({ url, stage: 'desktop', message: String(e && e.message ? e.message : e).slice(0, 300) });
      await page.close();
      return null;
    }
    await page.close();

    // mobile pass: metrics + screenshot
    const mp = await mobile.newPage();
    let mobileMetrics = null;
    try {
      await mp.goto(url, { waitUntil: 'domcontentloaded', timeout: cfg.pageTimeoutMs });
      await mp.waitForTimeout(cfg.settleMs);
      mobileMetrics = await mp.evaluate(mobileMetricsInPage);
      await mp.screenshot({ path: path.join(dir, 'screenshot-mobile.png'), fullPage: true });
    } catch (e) {
      errors.push({ url, stage: 'mobile', message: String(e && e.message ? e.message : e).slice(0, 300) });
    }
    await mp.close();
    if (mobileMetrics) await writeFile(path.join(dir, 'mobile-metrics.json'), JSON.stringify(mobileMetrics, null, 2));

    pagesCaptured.push({ slug, url, isHome });
    return extracted;
  };

  try {
    // 2. home page (if the https browse fails in the browser but http probed ok, fall back)
    let home = await capturePage(browseUrl, true);
    if (!home && !blocked && /^https:/i.test(browseUrl) && probe.http.ok && /^http:/i.test(probe.http.finalUrl)) {
      log(`${cand.id}: https browse failed in browser, falling back to http`);
      browseUrl = probe.http.finalUrl;
      home = await capturePage(browseUrl, true);
    }
    if (!home) {
      if (!blocked) await writeFile(path.join(captureDir, 'failure.json'), JSON.stringify({ stage: 'capture', error: 'home_failed', detail: errors }, null, 2));
      await desktop.close(); await mobile.close();
      return { outcome: blocked ? 'blocked' : 'timeout' };
    }

    // 3. extra pages by pattern priority
    const extras = pickExtraPages(home.links, browseUrl, cfg.pagePatterns, cfg.maxPagesPerSite - 1);
    for (const url of extras) {
      if (Date.now() > deadline) { errors.push({ stage: 'budget', message: 'site budget exhausted, remaining pages skipped' }); break; }
      await capturePage(url, false);
    }

    // 4. favicon probe
    const origin = new URL(browseUrl).origin;
    let favicon = { domLink: home.metadata.iconLinks.length > 0, icoStatus: null };
    if (!favicon.domLink) favicon.icoStatus = await headCheck(origin + '/favicon.ico', cfg.linkCheckTimeoutMs);
    await writeFile(path.join(captureDir, 'favicon.json'), JSON.stringify(favicon, null, 2));

    // 5. broken internal link sampling (plain fetch, no browser)
    const internal = [...new Set(home.links.filter((l) => l.type === 'internal').map((l) => l.href))]
      .filter((u) => !/\.(jpg|jpeg|png|gif|css|js|ico|svg|woff2?)(\?|$)/i.test(u))
      .slice(0, cfg.linkCheckSample);
    const linkChecks = [];
    for (const u of internal) {
      if (Date.now() > deadline) break;
      linkChecks.push({ url: u, status: await headCheck(u, cfg.linkCheckTimeoutMs) });
    }
    await writeFile(path.join(captureDir, 'link-checks.json'), JSON.stringify({ sampled: linkChecks.length, checks: linkChecks }, null, 2));

    await writeFile(path.join(captureDir, 'network.json'), JSON.stringify(network, null, 2));
    await writeFile(path.join(captureDir, 'capture.json'), JSON.stringify({
      candidate: cand,
      browseUrl,
      scannedAt: new Date().toISOString(),
      pages: pagesCaptured,
      errors,
    }, null, 2));

    log(`${cand.id}: ok (${pagesCaptured.length} pages, ${errors.length} page errors)`);
    return { outcome: 'ok', pages: pagesCaptured.length };
  } finally {
    await desktop.close().catch(() => {});
    await mobile.close().catch(() => {});
  }
}


// ---------- batch orchestration ----------

/**
 * Run a batch scan.
 *
 * The candidate list arrives in the job spec rather than being read from
 * candidates.json, but it is still written to candidates.json in the output
 * directory — the downstream offline stages (signals.mjs, score.mjs) read that
 * file, and the whole point of preserving the artefact tree is that they keep
 * working unchanged.
 *
 * batch.json is kept as the resume record. A scan that is interrupted and
 * retried skips sites that already reached a terminal outcome, so a restart
 * costs minutes rather than starting the whole batch again.
 */
export async function runScan(spec, ctx = {}) {
  const {
    outDir,
    defaults = {},
    userAgent = 'Mozilla/5.0 (compatible; AtelyrCaptureBot/1.0; +https://atelyr.com/bot)',
    signal,
    onProgress = () => {},
    politeness = null,
    guardOpts = {},
  } = ctx;

  const cfg = { ...defaults, ...spec };
  const batchDir = outDir;
  await mkdir(batchDir, { recursive: true });

  // Mirrored to logs/scan.log so the API's log endpoint behaves the same way
  // for a scan as it does for a crawl.
  const logLines = [];
  const log = (m) => {
    logLines.push(`[${new Date().toISOString()}] ${m}`);
    onProgress({ type: 'log', message: m });
  };
  const flushLog = async () => {
    await mkdir(path.join(batchDir, 'logs'), { recursive: true }).catch(() => {});
    await writeFile(path.join(batchDir, 'logs', 'scan.log'), logLines.join('\n') + '\n').catch(() => {});
  };
  const checkAborted = () => {
    if (signal?.aborted) throw new ScanAbortedError(signal.reason ?? 'cancelled');
  };

  // Validate and de-duplicate the candidate list up front. A malformed entry
  // should fail fast, not surface as a mystery failure 40 sites in.
  const seen = new Set();
  const candidates = [];
  for (const raw of spec.candidates ?? []) {
    const url = typeof raw === 'string' ? raw : raw?.url;
    if (!url) continue;
    const entry = typeof raw === 'string' ? {} : raw;
    const id = String(entry.slug || entry.id || slugFromUrl(url)).toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    candidates.push({ id, name: entry.name ?? id, url });
  }
  await writeFile(path.join(batchDir, 'candidates.json'), JSON.stringify({ candidates }, null, 2));

  let batch = { schemaVersion: '0.1', sites: {} };
  const batchPath = path.join(batchDir, 'batch.json');
  try { batch = JSON.parse(await readFile(batchPath, 'utf8')); } catch { /* fresh batch */ }

  // serialised batch.json writes (concurrent sites finish out of order)
  let writeChain = Promise.resolve();
  const saveBatch = () => (writeChain = writeChain.then(() => writeFile(batchPath, JSON.stringify(batch, null, 2))));

  const todo = candidates.filter((c) => {
    if (spec.force) return true;
    const s = batch.sites[c.id];
    return !s || !['ok', 'dead', 'blocked'].includes(s.outcome);
  });

  log(`Scanning ${todo.length} of ${candidates.length} candidates (concurrency ${cfg.concurrency})`);
  if (!todo.length) {
    log('Nothing to do (all scanned — use force to rescan).');
    await flushLog();
    return summarise(batch, candidates);
  }

  const browser = await launchBrowser();
  let completed = 0;
  try {
    let idx = 0;
    const worker = async () => {
      while (idx < todo.length) {
        checkAborted();
        const cand = todo[idx++];

        // Guard and robots are checked per site, not per batch: one bad
        // candidate must not abort a 200-site scan, so a refusal becomes that
        // site's outcome exactly as an unreachable host would.
        const gate = await checkFrontierUrl(cand.url, guardOpts);
        if (!gate.allowed) {
          log(`${cand.id}: REFUSED ${gate.detail}`);
          batch.sites[cand.id] = {
            name: cand.name, url: cand.url, status: 'done', outcome: 'refused',
            pages: 0, error: gate.detail, finishedAt: new Date().toISOString(),
          };
          saveBatch();
          continue;
        }

        if (cfg.respectRobotsTxt && await robotsForbids(cand.url, cfg, userAgent)) {
          log(`${cand.id}: SKIPPED (robots.txt disallows)`);
          batch.sites[cand.id] = {
            name: cand.name, url: cand.url, status: 'done', outcome: 'robots_disallow',
            pages: 0, error: null, finishedAt: new Date().toISOString(),
          };
          saveBatch();
          continue;
        }

        batch.sites[cand.id] = { name: cand.name, url: cand.url, status: 'scanning', startedAt: new Date().toISOString() };
        saveBatch();

        let result;
        try {
          if (politeness) await politeness.acquire(cand.url, signal);
          try {
            result = await scanSite(browser, cand, cfg, batchDir, log);
          } finally {
            if (politeness) politeness.release(cand.url);
          }
        } catch (e) {
          if (e instanceof ScanAbortedError) throw e;
          result = { outcome: 'error', error: String(e && e.message ? e.message : e).slice(0, 300) };
          log(`${cand.id}: ERROR ${result.error}`);
          const captureDir = path.join(batchDir, 'sites', cand.id, 'capture');
          await mkdir(captureDir, { recursive: true }).catch(() => {});
          await writeFile(path.join(captureDir, 'failure.json'), JSON.stringify({ stage: 'scan', error: 'exception', detail: result.error }, null, 2)).catch(() => {});
        }
        batch.sites[cand.id] = { ...batch.sites[cand.id], status: 'done', outcome: result.outcome, pages: result.pages || 0, error: result.error || null, finishedAt: new Date().toISOString() };
        saveBatch();
        completed++;
        onProgress({ type: 'progress', sitesScanned: completed, sitesTotal: todo.length, currentSite: cand.id });
      }
    };
    await Promise.all(Array.from({ length: Math.min(cfg.concurrency, todo.length) }, worker));
  } finally {
    await browser.close().catch(() => {});
    await writeChain;
    // Flush in `finally` so an aborted or failed scan still leaves a readable
    // log — that is exactly when someone needs it most.
    await flushLog();
  }

  const summary = summarise(batch, candidates);
  log(`Done. Outcomes: ${JSON.stringify(summary.outcomes)}`);
  await flushLog();
  return summary;
}

function summarise(batch, candidates) {
  const outcomes = {};
  for (const s of Object.values(batch.sites)) outcomes[s.outcome] = (outcomes[s.outcome] || 0) + 1;
  return {
    candidates: candidates.length,
    outcomes,
    sites: Object.entries(batch.sites).map(([id, s]) => ({
      id, url: s.url, outcome: s.outcome, pages: s.pages ?? 0, error: s.error ?? null,
    })),
  };
}

/** Derive a stable site id from a URL when the caller does not supply one. */
function slugFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
  } catch {
    return url.replace(/[^a-z0-9]+/gi, '-').slice(0, 60);
  }
}

/**
 * robots.txt check for a candidate's home page. Fetched per site because a
 * batch spans many hosts; a fetch failure is treated as "not disallowed",
 * matching how the crawl path treats a missing robots.txt.
 */
async function robotsForbids(url, cfg, userAgent) {
  try {
    const origin = new URL(url).origin;
    const { robots } = await loadRobots(origin, {
      respect: true,
      timeoutMs: cfg.probeTimeoutMs ?? 15000,
      userAgent,
    });
    return makeRobotsBlocker(robots, true)(url);
  } catch {
    return false;
  }
}
