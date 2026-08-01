// End-to-end API tests against a real server on an ephemeral port.
//
// These deliberately do not crawl anything: they exercise validation, the job
// lifecycle, dedup and the error surface, all of which are the parts a client
// depends on and none of which need the network. Actual capture fidelity is
// covered by test/parity.mjs against the golden fixtures.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from '../src/server.mjs';

let app;
let base;
let workDir;

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'scrape-svc-test-'));
  const config = JSON.parse(await readFile(new URL('../config/defaults.json', import.meta.url), 'utf8'));
  config.server.port = 0; // ephemeral
  config.server.host = '127.0.0.1';
  config.server.jobRoot = path.join(workDir, 'jobs');
  config.server.artefactRoot = path.join(workDir, 'artefacts');
  config.server.concurrentJobs = 0; // never actually launch a browser in these tests
  config.gc.sweepIntervalMs = 3_600_000;

  app = await createServer({ config, logger: quietLogger });
  await app.listen();
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  if (app) await app.close();
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

const post = (p, body) =>
  fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('health reports readiness and queue state', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.queueDepth, 'number');
  assert.equal(typeof body.uptimeS, 'number');
  assert.equal(body.concurrency, 0);
});

test('accepts both the bare and RS2-prefixed path', async () => {
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/scrape/health`)).status, 200);
});

test('creates a crawl job and returns a pollable handle', async () => {
  const res = await post('/crawls', { rootUrl: 'https://example.com/', maxPages: 3 });
  assert.equal(res.status, 202);
  const job = await res.json();
  assert.match(job.jobId, /^[a-z0-9-]+$/);
  assert.equal(job.status, 'queued');
  assert.equal(job.kind, 'crawl');
  assert.equal(job.artefacts, `/scrape-runs/${job.jobId}/`);
  assert.equal(res.headers.get('location'), `/scrape/crawls/${job.jobId}`);

  const got = await (await fetch(`${base}/crawls/${job.jobId}`)).json();
  assert.equal(got.jobId, job.jobId);
  assert.equal(got.spec.maxPages, 3);
});

test('deduplicates an identical in-flight request', async () => {
  const spec = { rootUrl: 'https://example.com/dedupe', maxPages: 5 };
  const first = await (await post('/crawls', spec)).json();
  const res = await post('/crawls', spec);
  assert.equal(res.status, 200, 'a duplicate is not a new job');
  const second = await res.json();
  assert.equal(second.jobId, first.jobId);
  assert.equal(second.deduplicated, true);
});

test('dedup ignores property order', async () => {
  const a = await (await post('/crawls', { rootUrl: 'https://example.com/order', maxPages: 4 })).json();
  const b = await (await post('/crawls', { maxPages: 4, rootUrl: 'https://example.com/order' })).json();
  assert.equal(b.jobId, a.jobId);
});

test('rejects private and non-http targets at submit time', async () => {
  const cases = [
    ['http://127.0.0.1:3100/', 'url_private_address'],
    ['http://169.254.169.254/', 'url_private_address'],
    ['file:///etc/passwd', 'url_scheme_blocked'],
    ['http://192.168.1.1/', 'url_private_address'],
  ];
  for (const [rootUrl, code] of cases) {
    const res = await post('/crawls', { rootUrl });
    assert.equal(res.status, 400, rootUrl);
    assert.equal((await res.json()).error.code, code, rootUrl);
  }
});

test('rejects a request above the server ceiling rather than clamping', async () => {
  const res = await post('/crawls', { rootUrl: 'https://example.com/', maxPages: 100000 });
  assert.equal(res.status, 400);
  const { error } = await res.json();
  assert.equal(error.code, 'field_exceeds_ceiling');
  assert.equal(error.field, 'maxPages');
});

test('rejects unknown fields so typos surface immediately', async () => {
  const res = await post('/crawls', { rootUrl: 'https://example.com/', maxpages: 5 });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'unknown_field');
});

test('refuses to disable robots by default', async () => {
  const res = await post('/crawls', { rootUrl: 'https://example.com/', respectRobotsTxt: false });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'robots_override_forbidden');
});

test('rejects a missing rootUrl and a malformed body', async () => {
  assert.equal((await (await post('/crawls', {})).json()).error.code, 'field_required');
  const bad = await fetch(`${base}/crawls`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'body_not_json');
});

test('lists jobs and filters by status', async () => {
  const res = await fetch(`${base}/crawls?status=queued&limit=100`);
  assert.equal(res.status, 200);
  const { jobs } = await res.json();
  assert.ok(jobs.length > 0);
  assert.ok(jobs.every((j) => j.status === 'queued' && j.kind === 'crawl'));

  const badStatus = await fetch(`${base}/crawls?status=nonsense`);
  assert.equal(badStatus.status, 400);
});

test('deletes a job and its record', async () => {
  const job = await (await post('/crawls', { rootUrl: 'https://example.com/delete-me' })).json();
  const del = await fetch(`${base}/crawls/${job.jobId}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.equal((await del.json()).deleted, true);
  assert.equal((await fetch(`${base}/crawls/${job.jobId}`)).status, 404);
});

test('log endpoint returns empty text for a job that has not started', async () => {
  const job = await (await post('/crawls', { rootUrl: 'https://example.com/nolog' })).json();
  const res = await fetch(`${base}/crawls/${job.jobId}/log`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/plain/);
  assert.equal(await res.text(), '');
});

test('creates a scan job from a candidate list', async () => {
  const res = await post('/scans', {
    candidates: [{ url: 'https://example.com/', name: 'Example', slug: 'example' }],
    concurrency: 2,
  });
  assert.equal(res.status, 202);
  const job = await res.json();
  assert.equal(job.kind, 'scan');
  assert.equal(job.spec.candidates.length, 1);
  assert.equal(job.spec.concurrency, 2);
});

test('accepts bare URL strings as candidates', async () => {
  const res = await post('/scans', { candidates: ['https://example.com/bare'] });
  assert.equal(res.status, 202);
  assert.equal((await res.json()).spec.candidates[0].url, 'https://example.com/bare');
});

test('rejects an empty or oversized candidate list', async () => {
  assert.equal((await (await post('/scans', { candidates: [] })).json()).error.code, 'field_required');
  const many = Array.from({ length: 501 }, (_, i) => `https://example.com/${i}`);
  const res = await post('/scans', { candidates: many });
  assert.equal((await res.json()).error.code, 'field_exceeds_ceiling');
});

test('rejects a path-shaped candidate slug', async () => {
  // Slugs become directory names under the artefact root.
  const res = await post('/scans', { candidates: [{ url: 'https://example.com/', slug: '../../etc' }] });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'field_invalid');
});

test('rejects a scan where no candidate is fetchable', async () => {
  const res = await post('/scans', { candidates: ['http://127.0.0.1/', 'http://192.168.0.1/'] });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.field, 'candidates');
});

test('accepts a scan where only some candidates are bad', async () => {
  // One poisoned entry must not reject a batch; the worker records it per site.
  const res = await post('/scans', { candidates: ['http://127.0.0.1/', 'https://example.com/mixed'] });
  assert.equal(res.status, 202);
});

test('unimplemented kinds are an explicit 501, not a silent failure', async () => {
  const res = await post('/shots', { url: 'https://example.com/' });
  assert.equal(res.status, 501);
  assert.equal((await res.json()).error.code, 'not_implemented');
});

test('unknown routes and methods are typed errors', async () => {
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  const res = await fetch(`${base}/crawls`, { method: 'PUT' });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get('allow'), 'POST, GET');
});

test('rejects a traversal-shaped job id without touching disk', async () => {
  const res = await fetch(`${base}/crawls/..%2F..%2Fetc`);
  assert.equal(res.status, 404);
});
