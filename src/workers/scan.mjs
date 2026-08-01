#!/usr/bin/env node
// Stage 1a — shallow batch capture for prospect qualification.
// Scans every candidate site (home + up to 3-4 key pages), desktop + mobile,
// and writes per-site capture artefacts. Optimised for throughput, not
// completeness (no robots/sitemap discovery, no BFS, no asset inventory).
// No LLM here — this captures what exists. Dead sites are a signal, not an error.
//
// Usage:
//   node scan.mjs --out <batch-dir>                 # reads <batch-dir>/candidates.json
//   node scan.mjs --out <batch-dir> --concurrency 4 --only <slug> --force
//
// Requires: playwright (chromium). If missing: npx playwright install chromium

import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--out') a.out = argv[++i];
    else if (k === '--config') a.config = argv[++i];
    else if (k === '--concurrency') a.concurrency = parseInt(argv[++i], 10);
    else if (k === '--only') a.only = argv[++i];
    else if (k === '--force') a.force = true;
    else if (k === '--max') a.max = parseInt(argv[++i], 10);
  }
  return a;
}

export async function loadConfig(configPath) {
  const cfg = JSON.parse(await readFile(path.join(SCRIPT_DIR, 'scan-config.default.json'), 'utf8'));
  if (configPath) {
    const raw = JSON.parse(await readFile(configPath, 'utf8'));
    // shallow merge, one level deep for objects
    for (const [k, v] of Object.entries(raw)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && cfg[k] && typeof cfg[k] === 'object') cfg[k] = { ...cfg[k], ...v };
      else cfg[k] = v;
    }
  }
  return cfg;
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

// ---------- in-page extraction (runs in browser, desktop) ----------
// Trimmed from website-reconstruction/scripts/crawl.mjs extractInPage:
// keeps metadata/links/forms/buttons/structured-data/visible-text, drops
// images/blocks/a11y-tree/readable (completeness features the shallow scan skips).
function extractInPage() {
  const cssPath = (el) => {
    if (!(el instanceof Element)) return null;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let sel = node.nodeName.toLowerCase();
      if (node.id) { parts.unshift(`${sel}#${node.id}`); break; }
      const parent = node.parentNode;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((c) => c.nodeName === node.nodeName);
        if (sameTag.length > 1) sel += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
      parts.unshift(sel);
      node = node.parentNode;
    }
    return parts.join(' > ');
  };
  const regionOf = (el) => {
    let n = el;
    while (n) {
      const tag = n.nodeName ? n.nodeName.toLowerCase() : '';
      const role = n.getAttribute ? n.getAttribute('role') : null;
      if (tag === 'header' || role === 'banner') return 'header';
      if (tag === 'nav' || role === 'navigation') return 'navigation';
      if (tag === 'footer' || role === 'contentinfo') return 'footer';
      if (tag === 'main' || role === 'main') return 'main';
      if (tag === 'aside') return 'aside';
      n = n.parentElement;
    }
    return 'body';
  };
  const vh = window.innerHeight;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };

  const origin = location.origin;
  const links = [...document.querySelectorAll('a[href]')]
    .map((a) => {
      const href = a.href;
      let type = 'internal';
      if (href.startsWith('mailto:')) type = 'email';
      else if (href.startsWith('tel:')) type = 'phone';
      else if (!href.startsWith(origin)) type = 'external';
      return { text: a.textContent.trim().slice(0, 160), href, type, selector: cssPath(a), appearsIn: regionOf(a) };
    })
    .filter((l) => l.href);

  const forms = [...document.querySelectorAll('form')].map((f) => ({
    selector: cssPath(f),
    method: (f.getAttribute('method') || 'GET').toUpperCase(),
    action: f.getAttribute('action') || '',
    // markers that indicate a JS-handled form (empty action is then fine)
    markers: (f.className + ' ' + (f.id || '') + ' ' + (f.getAttribute('data-hs-form') ? 'hs-form' : '') + ' ' + (f.getAttribute('data-netlify') ? 'netlify' : '')).toLowerCase().slice(0, 300),
    fields: [...f.querySelectorAll('input,textarea,select')]
      .filter((el) => el.type !== 'hidden')
      .map((el) => {
        let label = '';
        if (el.id) {
          const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (lab) label = lab.textContent.trim();
        }
        if (!label) label = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || '';
        return {
          name: el.name || '',
          label: label.slice(0, 120),
          type: el.tagName.toLowerCase() === 'textarea' ? 'textarea' : el.type || el.tagName.toLowerCase(),
          required: el.required || false,
        };
      }),
  }));

  const ctaSel = 'button, a.btn, a.button, a.cta, [class*="btn"], [role="button"]';
  const buttons = [...document.querySelectorAll(ctaSel)]
    .filter(visible)
    .slice(0, 40)
    .map((b) => {
      const r = b.getBoundingClientRect();
      return {
        text: b.textContent.trim().slice(0, 120),
        target: b.tagName.toLowerCase() === 'a' ? b.href : (b.getAttribute('formaction') || null),
        selector: cssPath(b),
        position: r.top < vh ? 'above_fold' : 'below_fold',
      };
    })
    .filter((b) => b.text);

  const structuredData = [];
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { structuredData.push(JSON.parse(s.textContent)); } catch { /* skip invalid */ }
  }

  const metaGet = (sel, attr = 'content') => {
    const el = document.querySelector(sel);
    return el ? el.getAttribute(attr) : null;
  };
  const iconLinks = [...document.querySelectorAll('link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]')]
    .map((l) => ({ rel: l.getAttribute('rel'), href: l.href }));
  const metadata = {
    title: document.title || null,
    metaDescription: metaGet('meta[name="description"]'),
    canonicalUrl: metaGet('link[rel="canonical"]', 'href'),
    generator: metaGet('meta[name="generator"]'),
    viewportMeta: metaGet('meta[name="viewport"]'),
    language: document.documentElement.getAttribute('lang') || null,
    iconLinks,
    hasMapEmbed: !!document.querySelector('iframe[src*="google.com/maps"], iframe[src*="maps.google"]'),
    inlineAnalytics: /gtag\(|GoogleAnalyticsObject|googletagmanager|fbq\(|clarity\(|_gaq/.test(document.documentElement.innerHTML.slice(0, 400000)),
    jqueryVersion: (window.jQuery && window.jQuery.fn && window.jQuery.fn.jquery) || null,
  };

  const textNodes = [];
  let order = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const txt = node.textContent.replace(/\s+/g, ' ').trim();
    if (!txt || txt.length < 2) continue;
    const el = node.parentElement;
    if (!el || !visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    order++;
    textNodes.push({
      text: txt.slice(0, 500),
      selector: cssPath(el),
      region: regionOf(el),
      pageOrder: order,
      aboveFold: r.top < vh,
    });
    if (textNodes.length > 400) break;
  }

  return { links, forms, buttons, structuredData, metadata, visibleText: textNodes };
}

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

      extracted = await page.evaluate(extractInPage);

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
async function main() {
  const args = parseArgs(process.argv);
  if (!args.out) {
    console.error('Usage: node scan.mjs --out <batch-dir> [--config <file>] [--concurrency N] [--only <slug>] [--force] [--max N]');
    process.exit(2);
  }
  const cfg = await loadConfig(args.config);
  if (args.concurrency) cfg.concurrency = args.concurrency;
  const batchDir = path.resolve(args.out);

  const { candidates } = JSON.parse(await readFile(path.join(batchDir, 'candidates.json'), 'utf8'));
  let batch = { schemaVersion: '0.1', sites: {} };
  const batchPath = path.join(batchDir, 'batch.json');
  try { batch = JSON.parse(await readFile(batchPath, 'utf8')); } catch { /* fresh batch */ }

  // serialised batch.json writes (concurrent sites finish out of order)
  let writeChain = Promise.resolve();
  const saveBatch = () => (writeChain = writeChain.then(() => writeFile(batchPath, JSON.stringify(batch, null, 2))));

  let todo = candidates.filter((c) => {
    if (args.only) return c.id === args.only;
    if (args.force) return true;
    const s = batch.sites[c.id];
    return !s || !['ok', 'dead', 'blocked'].includes(s.outcome);
  });
  if (args.max) todo = todo.slice(0, args.max);

  const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
  log(`Scanning ${todo.length} of ${candidates.length} candidates (concurrency ${cfg.concurrency})`);
  if (!todo.length) { log('Nothing to do (all scanned — use --force to rescan).'); return; }

  const browser = await chromium.launch({ headless: true });
  try {
    let idx = 0;
    const worker = async () => {
      while (idx < todo.length) {
        const cand = todo[idx++];
        batch.sites[cand.id] = { name: cand.name, url: cand.url, status: 'scanning', startedAt: new Date().toISOString() };
        saveBatch();
        let result;
        try {
          result = await scanSite(browser, cand, cfg, batchDir, log);
        } catch (e) {
          result = { outcome: 'error', error: String(e && e.message ? e.message : e).slice(0, 300) };
          log(`${cand.id}: ERROR ${result.error}`);
          const captureDir = path.join(batchDir, 'sites', cand.id, 'capture');
          await mkdir(captureDir, { recursive: true }).catch(() => {});
          await writeFile(path.join(captureDir, 'failure.json'), JSON.stringify({ stage: 'scan', error: 'exception', detail: result.error }, null, 2)).catch(() => {});
        }
        batch.sites[cand.id] = { ...batch.sites[cand.id], status: 'done', outcome: result.outcome, pages: result.pages || 0, error: result.error || null, finishedAt: new Date().toISOString() };
        saveBatch();
      }
    };
    await Promise.all(Array.from({ length: Math.min(cfg.concurrency, todo.length) }, worker));
  } finally {
    await browser.close();
    await writeChain;
  }

  const outcomes = {};
  for (const s of Object.values(batch.sites)) outcomes[s.outcome] = (outcomes[s.outcome] || 0) + 1;
  log(`Done. Outcomes: ${JSON.stringify(outcomes)}`);
  log(`Next: node signals.mjs --out ${batchDir}`);
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((e) => {
    console.error('FATAL', e);
    process.exit(1);
  });
}
