#!/usr/bin/env node
// Child entry point: run exactly one job, then exit.
//
// One process per job buys three things that matter more than the spawn cost:
// crash isolation (a chromium wedge kills this process, not the API), memory
// reclamation (long-lived Playwright processes leak), and a clean kill path for
// cancellation and wall-clock timeouts.
//
// Contract with the parent:
//   argv:   --job <jobId> --job-root <dir> --artefact-root <dir>
//   stdout: one JSON object per line — {type:'log'|'progress'|'result'|'error'}
//   exit:   0 success · 1 job failed · 2 usage · 3 aborted

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { runCrawl, CrawlAbortedError } from './crawl.mjs';
import { runScan, ScanAbortedError } from './scan.mjs';
import { PolitenessGate } from '../jobs/politeness.mjs';
import { BlockedUrlError } from '../net/guard.mjs';
import { loadConfig } from '../config.mjs';

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

// stdout is a structured channel; anything unstructured would corrupt it, so
// diagnostics go to stderr and the parent captures them separately.
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

if (!opt.job || !opt['job-root'] || !opt['artefact-root']) {
  process.stderr.write('usage: run-job.mjs --job <id> --job-root <dir> --artefact-root <dir>\n');
  process.exit(2);
}

const controller = new AbortController();
// The parent cancels by signalling; translate that into a cooperative abort so
// the worker can close the browser instead of leaving a chromium orphan.
process.on('SIGTERM', () => controller.abort('cancelled'));
process.on('SIGINT', () => controller.abort('cancelled'));

async function main() {
  const jobPath = path.join(opt['job-root'], opt.job, 'job.json');
  const job = JSON.parse(await readFile(jobPath, 'utf8'));
  // The same loader as the API process, so environment overrides (the crawler's
  // identity) apply to the process that makes the requests.
  const defaults = await loadConfig();

  const outDir = path.join(opt['artefact-root'], job.jobId);
  // This gate is private to the job. Jobs never share a domain while they run
  // (the queue holds back a job whose domain is already being worked), so one
  // gate per job is enough to keep a site's request rate within the limit.
  const politeness = new PolitenessGate({
    minIntervalMs: defaults.politeness.minIntervalMsPerDomain,
    maxConcurrentPerDomain: defaults.politeness.maxConcurrentPerDomain,
  });

  const ctx = {
    outDir,
    userAgent: defaults.server.userAgent,
    robotsToken: defaults.server.robotsToken,
    signal: controller.signal,
    politeness,
    onProgress: (e) => emit(e),
  };

  switch (job.kind) {
    case 'crawl': {
      const result = await runCrawl(job.spec, { ...ctx, defaults: defaults.crawl });
      emit({ type: 'result', result: summariseCrawl(result) });
      return 0;
    }
    case 'scan': {
      const result = await runScan(job.spec, { ...ctx, defaults: defaults.scan });
      emit({ type: 'result', result });
      return 0;
    }
    default: {
      emit({ type: 'error', error: { code: 'unsupported_kind', message: `no worker for kind '${job.kind}'` } });
      return 1;
    }
  }
}

/**
 * The full crawl index can be megabytes; the job record keeps a summary and the
 * index itself stays on disk where the file mount serves it.
 */
function summariseCrawl(index) {
  return {
    schemaVersion: index.schemaVersion,
    source: index.source,
    crawl: index.crawl,
    assetsCount: index.assetsCount,
    pages: index.pages.map((p) => ({
      slug: p.slug,
      finalUrl: p.finalUrl,
      title: p.title,
      status: p.status,
      depth: p.depth,
      counts: p.counts,
    })),
    skipped: index.skipped,
  };
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof CrawlAbortedError || err instanceof ScanAbortedError) {
      emit({ type: 'error', error: { code: 'aborted', message: err.message } });
      process.exit(3);
    }
    const code = err instanceof BlockedUrlError ? err.code : (err.code ?? 'worker_error');
    emit({ type: 'error', error: { code, message: err.message ?? String(err) } });
    process.stderr.write(String(err.stack ?? err) + '\n');
    process.exit(1);
  });
