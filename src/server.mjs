#!/usr/bin/env node
// The sidecar HTTP API.
//
// Binds loopback only. RS2's `proxy` mount is the sole ingress and supplies TLS,
// auth and the public hostname; a publicly reachable instance of this process
// would be an open SSRF proxy, so the bind address is not a preference.
//
// RS2 strips the mount prefix before forwarding (`/scrape/crawls` arrives here
// as `/crawls`), so routes are defined at the root. The `/scrape` prefix is
// also accepted so that a direct curl can use the same path as the public URL.

import http from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { JobStore, STATUS, TERMINAL } from './jobs/store.mjs';
import { JobQueue } from './jobs/queue.mjs';
import { ArtefactGC, diskUsagePct } from './jobs/gc.mjs';
import { validateCrawlRequest, validateScanRequest, ValidationError } from './validate.mjs';
import { assertNavigable, BlockedUrlError } from './net/guard.mjs';
import { chromiumVersion } from './capture/browser.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY_BYTES = 1_000_000;

/** Job kinds with a worker behind them. Anything else is an explicit 501. */
const IMPLEMENTED_KINDS = new Set(['crawl', 'scan']);

export async function createServer({ config, logger = console }) {
  const store = new JobStore({
    jobRoot: path.resolve(here, '..', config.server.jobRoot),
    artefactRoot: path.resolve(here, '..', config.server.artefactRoot),
  });
  await store.init();

  const recovered = await store.recover();
  if (recovered.length) {
    logger.warn?.(`recovered ${recovered.length} interrupted job(s): ${recovered.map((r) => `${r.jobId}=${r.action}`).join(', ')}`);
  }

  const queue = new JobQueue({
    store,
    limits: config.limits,
    concurrency: config.server.concurrentJobs,
    logger,
  });
  const gc = new ArtefactGC({ store, ...config.gc, logger });

  let cachedChromium = null;

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    try {
      await route(req, res);
    } catch (err) {
      if (!res.headersSent) sendError(res, err);
      else res.end();
    } finally {
      logger.info?.(`${req.method} ${req.url} -> ${res.statusCode} (${Date.now() - started}ms)`);
    }
  });

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    // Tolerate both the RS2-stripped path and the full public path.
    const pathname = url.pathname.replace(/^\/scrape(?=\/|$)/, '') || '/';
    const segments = pathname.split('/').filter(Boolean);

    if (segments[0] === 'health' && req.method === 'GET') return health(res);

    // /crawls, /scans, /shots
    const collection = segments[0];
    const kind = { crawls: 'crawl', scans: 'scan', shots: 'shot' }[collection];
    if (!kind) return sendJson(res, 404, { error: { code: 'not_found', message: `no route for ${pathname}` } });

    if (!IMPLEMENTED_KINDS.has(kind)) {
      return sendJson(res, 501, {
        error: {
          code: 'not_implemented',
          message: `'${collection}' is not available on this server yet`,
        },
      });
    }

    const id = segments[1];
    const sub = segments[2];

    if (!id) {
      if (req.method === 'POST') return createJob(req, res, kind);
      if (req.method === 'GET') return listJobs(res, url, kind);
      return methodNotAllowed(res, ['POST', 'GET']);
    }
    if (sub === 'log' && req.method === 'GET') return jobLog(res, id);
    if (sub === 'artefacts' && req.method === 'GET') {
      return artefacts(res, id, segments.slice(3).join('/'));
    }
    if (sub) return sendJson(res, 404, { error: { code: 'not_found', message: `no route for ${pathname}` } });
    if (req.method === 'GET') return getJob(res, id);
    if (req.method === 'DELETE') return deleteJob(res, id);
    return methodNotAllowed(res, ['GET', 'DELETE']);
  }

  async function health(res) {
    if (!cachedChromium) {
      cachedChromium = await chromiumVersion().catch((e) => `unavailable: ${e.message}`);
    }
    const usage = await diskUsagePct(store.artefactRoot);
    const { jobs } = await store.list({ status: STATUS.QUEUED, limit: 200 });
    sendJson(res, 200, {
      ok: typeof cachedChromium === 'string' && !cachedChromium.startsWith('unavailable'),
      chromiumVersion: cachedChromium,
      activeJobs: queue.activeCount,
      queueDepth: jobs.length,
      diskUsedPct: usage === null ? null : Number(usage.toFixed(1)),
      concurrency: config.server.concurrentJobs,
      uptimeS: Math.round(process.uptime()),
    });
  }

  async function createJob(req, res, kind) {
    const body = await readJsonBody(req);
    const spec = kind === 'scan'
      ? validateScanRequest(body, config.limits)
      : validateCrawlRequest(body, config.limits);

    // Fail fast and legibly: a caller who posts a private address should get a
    // 400 now, not a job that fails a minute later with a cryptic worker error.
    //
    // A crawl has one target, so a bad one is fatal. A scan has many, and one
    // bad candidate out of two hundred should not reject the batch — those are
    // checked per site by the worker and recorded as that site's outcome. What
    // is rejected here is a batch where nothing at all is fetchable, which is
    // always a caller mistake.
    if (kind === 'scan') {
      const checks = await Promise.all(
        spec.candidates.map((c) => assertNavigable(c.url).then(() => true, () => false)),
      );
      if (!checks.some(Boolean)) {
        throw new ValidationError('field_invalid', 'no candidate URL is fetchable', 'candidates');
      }
    } else {
      await assertNavigable(spec.rootUrl);
    }

    const duplicate = await store.findDuplicate(kind, spec, { windowMs: config.server.dedupeWindowMs });
    if (duplicate) {
      return sendJson(res, 200, { ...jobView(duplicate), deduplicated: true });
    }

    const job = await store.create(kind, spec);
    queue.poke();
    res.setHeader('location', `/scrape/${kind}s/${job.jobId}`);
    sendJson(res, 202, jobView(job));
  }

  async function listJobs(res, url, kind) {
    const status = url.searchParams.get('status') ?? undefined;
    if (status && !Object.values(STATUS).includes(status)) {
      throw new ValidationError('field_invalid', `unknown status '${status}'`, 'status');
    }
    const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
    const cursor = url.searchParams.get('cursor') ?? undefined;
    const { jobs, nextCursor } = await store.list({ status, limit, cursor });
    sendJson(res, 200, {
      jobs: jobs.filter((j) => j.kind === kind).map(jobView),
      nextCursor,
    });
  }

  async function getJob(res, id) {
    const job = await store.get(id);
    if (!job) return sendJson(res, 404, { error: { code: 'not_found', message: `no job '${id}'` } });
    sendJson(res, 200, jobView(job));
  }

  async function jobLog(res, id) {
    const job = await store.get(id);
    if (!job) return sendJson(res, 404, { error: { code: 'not_found', message: `no job '${id}'` } });
    // Each worker names its own log after its kind; crawl.log is the one the
    // pipeline's client shim mirrors into runs/<slug>/.
    const logPath = path.join(store.artefactDir(id), 'logs', `${job.kind}.log`);
    try {
      const text = await readFile(logPath, 'utf8');
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(text);
    } catch {
      // The log only exists once the worker has written it; an empty 200 is a
      // truer answer than a 404 for a job that is queued or still starting.
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('');
    }
  }

  /**
   * Artefact access.
   *
   * With no sub-path this returns a flat recursive manifest; with one it
   * streams that file. The RS2 `/scrape-runs` file mount serves the same tree
   * for humans, but clients use this so there is exactly one download path that
   * behaves identically against a local sidecar and through the proxy.
   */
  async function artefacts(res, id, relPath) {
    const job = await store.get(id);
    if (!job) return sendJson(res, 404, { error: { code: 'not_found', message: `no job '${id}'` } });

    const root = store.artefactDir(id);
    if (!relPath) {
      const files = await manifest(root);
      return sendJson(res, 200, { jobId: id, files });
    }

    // Resolve then verify containment: the only reliable defence against
    // traversal, encoded or otherwise.
    const decoded = decodeURIComponent(relPath);
    const target = path.resolve(root, decoded);
    if (target !== root && !target.startsWith(root + path.sep)) {
      return sendJson(res, 400, { error: { code: 'path_escape', message: 'artefact path escapes the job directory' } });
    }
    try {
      const data = await readFile(target);
      res.writeHead(200, {
        'content-type': contentTypeFor(target),
        'content-length': data.length,
      });
      res.end(data);
    } catch {
      sendJson(res, 404, { error: { code: 'not_found', message: `no artefact '${decoded}'` } });
    }
  }

  async function deleteJob(res, id) {
    const job = await store.get(id);
    if (!job) return sendJson(res, 404, { error: { code: 'not_found', message: `no job '${id}'` } });
    const cancelled = await queue.cancel(id);
    if (!cancelled && !TERMINAL.has(job.status)) {
      await store.update(id, {
        status: STATUS.CANCELLED,
        finishedAt: new Date().toISOString(),
        error: { code: 'cancelled', message: 'cancelled before it started' },
      });
    }
    await store.remove(id);
    sendJson(res, 200, { jobId: id, deleted: true, wasRunning: cancelled });
  }

  server.on('close', () => { gc.stop(); queue.stop(); });

  return {
    server,
    store,
    queue,
    gc,
    async listen() {
      gc.start();
      queue.start().catch((e) => logger.error?.(`queue loop died: ${e.stack ?? e}`));
      await new Promise((resolve) => server.listen(config.server.port, config.server.host, resolve));
      logger.info?.(`scrape-service listening on http://${config.server.host}:${config.server.port}`);
      return server;
    },
    async close() {
      await queue.drain();
      gc.stop();
      // close() alone waits out every keep-alive connection, which a polling
      // client (or fetch's default agent) will happily hold open forever.
      server.closeIdleConnections?.();
      const done = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections?.();
      await done;
    },
  };
}

/** The public shape of a job. Never leaks internals like pid or file paths. */
function jobView(job) {
  return {
    jobId: job.jobId,
    kind: job.kind,
    status: job.status,
    spec: job.spec,
    progress: job.progress ?? {},
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    attempt: job.attempt,
    result: job.result ?? null,
    error: job.error ?? null,
    artefacts: `/scrape-runs/${job.jobId}/`,
    self: `/scrape/${job.kind}s/${job.jobId}`,
  };
}

/** Flat recursive listing of a job's artefacts, with forward-slash paths. */
async function manifest(root) {
  const files = [];
  const walk = async (dir, prefix) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(abs, rel);
      else {
        try { files.push({ path: rel, bytes: (await stat(abs)).size }); } catch { /* raced with GC */ }
      }
    }
  };
  await walk(root, '');
  return files;
}

const CONTENT_TYPES = {
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function contentTypeFor(p) {
  return CONTENT_TYPES[path.extname(p).toLowerCase()] ?? 'application/octet-stream';
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function methodNotAllowed(res, allow) {
  res.setHeader('allow', allow.join(', '));
  sendJson(res, 405, { error: { code: 'method_not_allowed', message: `allowed: ${allow.join(', ')}` } });
}

function sendError(res, err) {
  if (err instanceof ValidationError) {
    return sendJson(res, 400, { error: { code: err.code, message: err.message, field: err.field } });
  }
  if (err instanceof BlockedUrlError) {
    return sendJson(res, 400, { error: { code: err.code, message: err.message, url: err.url } });
  }
  if (err?.code === 'body_too_large') {
    return sendJson(res, 413, { error: { code: err.code, message: err.message } });
  }
  if (err?.code === 'body_not_json') {
    return sendJson(res, 400, { error: { code: err.code, message: err.message } });
  }
  return sendJson(res, 500, { error: { code: 'internal', message: err?.message ?? String(err) } });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        const err = new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
        err.code = 'body_too_large';
        req.destroy();
        reject(err);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        const err = new Error(`request body is not valid JSON: ${e.message}`);
        err.code = 'body_not_json';
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export async function loadConfig() {
  const raw = JSON.parse(await readFile(path.join(here, '..', 'config', 'defaults.json'), 'utf8'));
  // Environment overrides exist for deployment (systemd sets these); the file
  // stays the single description of what the knobs are.
  if (process.env.PORT) raw.server.port = Number(process.env.PORT);
  if (process.env.HOST) raw.server.host = process.env.HOST;
  if (process.env.ARTEFACT_ROOT) raw.server.artefactRoot = process.env.ARTEFACT_ROOT;
  if (process.env.JOB_ROOT) raw.server.jobRoot = process.env.JOB_ROOT;
  if (process.env.CONCURRENT_JOBS) raw.server.concurrentJobs = Number(process.env.CONCURRENT_JOBS);
  // Sizing knobs a small host needs to tighten without editing the config file.
  if (process.env.ARTEFACT_TTL_DAYS) raw.gc.ttlDays = Number(process.env.ARTEFACT_TTL_DAYS);
  if (process.env.DISK_HIGH_WATER_PCT) raw.gc.diskHighWaterPct = Number(process.env.DISK_HIGH_WATER_PCT);
  if (process.env.ARTEFACT_BYTES_PER_JOB) raw.limits.artefactBytesPerJob = Number(process.env.ARTEFACT_BYTES_PER_JOB);
  if (process.env.MAX_PAGES_CEILING) raw.limits.maxPagesCeiling = Number(process.env.MAX_PAGES_CEILING);
  return raw;
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  const config = await loadConfig();
  const app = await createServer({ config });
  await app.listen();

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      console.info(`\n${sig} — draining`);
      await app.close();
      process.exit(0);
    });
  }
}
