#!/usr/bin/env node
// End-to-end smoke test: start the server, submit a real crawl, poll it to
// completion, and verify the artefacts actually landed on disk.
//
// The unit tests deliberately run with concurrency 0 so they never launch a
// browser — which means they never exercise the part most likely to break in
// deployment: spawning the worker, parsing its NDJSON progress, and moving the
// job through its states. This does exactly that, against one real page.
//
// Usage: node tools/smoke.mjs [--url <url>] [--max 2] [--keep]

import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server.mjs';

const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const k = args[i].slice(2);
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) opt[k] = true;
    else { opt[k] = v; i++; }
  }
}
// Defaults to example.com: it exists to be fetched by tools like this one, so
// a fresh clone running `npm run smoke` does not crawl a real business's site
// without meaning to. Pass --url to point at something more substantial.
const URL_UNDER_TEST = opt.url ?? 'https://example.com/';
const MAX_PAGES = Number(opt.max ?? 2);

const quiet = { info() {}, warn(m) { console.warn('  ! ' + m); }, error(m) { console.error('  ! ' + m); } };
const step = (m) => console.log(`\n▸ ${m}`);
const ok = (m) => console.log(`  ✓ ${m}`);

let failures = 0;
function check(cond, label) {
  if (cond) ok(label);
  else { failures++; console.error(`  ✗ ${label}`); }
}

const workDir = await mkdtemp(path.join(tmpdir(), 'scrape-smoke-'));
const config = JSON.parse(await readFile(new URL('../config/defaults.json', import.meta.url), 'utf8'));
config.server.port = 0;
config.server.host = '127.0.0.1';
config.server.jobRoot = path.join(workDir, 'jobs');
config.server.artefactRoot = path.join(workDir, 'artefacts');
config.server.concurrentJobs = 1;

const app = await createServer({ config, logger: quiet });
await app.listen();
const base = `http://127.0.0.1:${app.server.address().port}`;

try {
  step('health');
  const health = await (await fetch(`${base}/health`)).json();
  check(health.ok === true, `chromium available (${health.chromiumVersion})`);

  step(`submitting a ${MAX_PAGES}-page crawl of ${URL_UNDER_TEST}`);
  const res = await fetch(`${base}/crawls`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rootUrl: URL_UNDER_TEST, maxPages: MAX_PAGES, captureMobile: false }),
  });
  check(res.status === 202, `accepted with 202 (got ${res.status})`);
  const submitted = await res.json();
  console.log(`  jobId ${submitted.jobId}`);

  step('polling to completion');
  const deadline = Date.now() + 10 * 60 * 1000;
  let job;
  let sawRunning = false;
  let lastReport = '';
  while (Date.now() < deadline) {
    job = await (await fetch(`${base}/crawls/${submitted.jobId}`)).json();
    if (job.status === 'running') sawRunning = true;
    const report = `${job.status} ${job.progress?.pagesCrawled ?? 0}/${job.progress?.pagesDiscovered ?? '?'}`;
    if (report !== lastReport) { console.log(`  ${report}`); lastReport = report; }
    if (['succeeded', 'failed', 'cancelled', 'expired'].includes(job.status)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }

  check(sawRunning, 'observed the job in `running` (the worker was actually spawned)');
  check(job.status === 'succeeded', `finished as succeeded (got ${job.status}${job.error ? `: ${job.error.message}` : ''})`);
  check(job.startedAt && job.finishedAt, 'recorded start and finish timestamps');
  check(job.result?.crawl?.pagesCrawled > 0, `crawled ${job.result?.crawl?.pagesCrawled ?? 0} page(s)`);
  check(Array.isArray(job.result?.pages) && job.result.pages.length > 0, 'result summary lists pages');

  step('verifying artefacts on disk');
  const dir = path.join(config.server.artefactRoot, submitted.jobId);
  check(existsSync(path.join(dir, 'crawl.json')), 'crawl.json written');
  check(existsSync(path.join(dir, 'sitemap-discovered.xml')), 'sitemap-discovered.xml written');
  check(existsSync(path.join(dir, 'assets', 'manifest.json')), 'assets/manifest.json written');
  check(existsSync(path.join(dir, 'logs', 'crawl.log')), 'logs/crawl.log written');

  const index = JSON.parse(await readFile(path.join(dir, 'crawl.json'), 'utf8'));
  const firstSlug = index.pages[0]?.slug;
  check(!!firstSlug, `first page slug is '${firstSlug}'`);
  if (firstSlug) {
    const pageDir = path.join(dir, 'pages', firstSlug);
    const files = await readdir(pageDir);
    for (const f of ['metadata.json', 'links.json', 'images.json', 'readable.md', 'content.html', 'screenshot-desktop.png']) {
      check(files.includes(f), `pages/${firstSlug}/${f}`);
    }
    // The screenshot path recorded in the index must resolve relative to the
    // artefact root, because that is exactly how it will be served as a URL.
    const rel = index.pages[0].screenshotDesktop;
    check(rel === `pages/${firstSlug}/screenshot-desktop.png`, `index records a root-relative screenshot path (${rel})`);
    check(existsSync(path.join(dir, rel)), 'that relative path resolves on disk');
  }

  step('log endpoint');
  const logText = await (await fetch(`${base}/crawls/${submitted.jobId}/log`)).text();
  check(logText.includes('Crawl start:'), 'log endpoint returns the crawl log');

  step('dedup after success');
  const dup = await fetch(`${base}/crawls`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rootUrl: URL_UNDER_TEST, maxPages: MAX_PAGES, captureMobile: false }),
  });
  const dupJob = await dup.json();
  check(dup.status === 200 && dupJob.jobId === submitted.jobId, 'an identical repeat returns the same job rather than re-crawling');

  step('delete');
  const del = await fetch(`${base}/crawls/${submitted.jobId}`, { method: 'DELETE' });
  check(del.status === 200, 'deleted');
  check(!existsSync(dir), 'artefacts removed with the job record');
} finally {
  await app.close();
  if (opt.keep) console.log(`\nwork kept at ${workDir}`);
  else await rm(workDir, { recursive: true, force: true });
}

console.log(failures ? `\nSMOKE FAILED — ${failures} check(s)\n` : '\nSMOKE OK\n');
process.exit(failures ? 1 : 0);
