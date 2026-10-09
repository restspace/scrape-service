// The remote (R2) store path, against the in-memory remote.
//
// What matters here is the contract the Cloudflare deployment depends on: a job
// outlives the instance that created it, artefacts land where the RS2
// `/scrape-runs` mount reads them, reads fall back to the remote once local disk
// is gone, and an upload failure never reports success.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { JobStore, STATUS } from '../src/jobs/store.mjs';
import { MemoryRemote, remoteFromEnv } from '../src/jobs/remote.mjs';
import { createServer } from '../src/server.mjs';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

let workDir;
let remote;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'scrape-remote-test-'));
  remote = new MemoryRemote();
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** A store over its own fresh local disk — i.e. a new container instance. */
function instance(name, opts = {}) {
  return new JobStore({
    jobRoot: path.join(workDir, name, 'jobs'),
    artefactRoot: path.join(workDir, name, 'artefacts'),
    remote,
    logger: quiet,
    ...opts,
  });
}

test('remoteFromEnv is off when unset and refuses a partial configuration', () => {
  assert.equal(remoteFromEnv({}), null);
  assert.throws(() => remoteFromEnv({ R2_ACCOUNT_ID: 'a', R2_BUCKET: 'b' }), /missing R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY/);
  const r = remoteFromEnv({ R2_ACCOUNT_ID: 'a', R2_BUCKET: 'b', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's' });
  assert.equal(r.jobPrefix, '_scrape/jobs');
  assert.equal(r.artefactPrefix, 'main/.rs2-scrape');
});

test('a job record is mirrored and readable from a fresh instance', async () => {
  const a = instance('a');
  await a.init();
  const job = await a.create('crawl', { rootUrl: 'https://example.com/' });
  assert.ok(remote.objects.has(`_scrape/jobs/${job.jobId}.json`));

  const b = instance('b');
  await b.init();
  const seen = await b.get(job.jobId);
  assert.equal(seen.jobId, job.jobId);
  assert.equal(seen.status, STATUS.QUEUED);

  const { jobs } = await b.list();
  assert.deepEqual(jobs.map((j) => j.jobId), [job.jobId]);
  const local = await b.list({ localOnly: true });
  assert.equal(local.jobs.length, 0, 'localOnly must not reach the remote');
});

test('create fails when the record cannot be made durable', async () => {
  const a = instance('a');
  await a.init();
  remote.failPuts = true;
  await assert.rejects(a.create('crawl', { rootUrl: 'https://example.com/' }), /injected failure/);
});

test('an update that fails to mirror is logged, not thrown', async () => {
  const warnings = [];
  const a = instance('a', { logger: { ...quiet, warn: (m) => warnings.push(m) } });
  await a.init();
  const job = await a.create('crawl', { rootUrl: 'https://example.com/' });
  remote.failPuts = true;
  const updated = await a.update(job.jobId, { status: STATUS.RUNNING });
  assert.equal(updated.status, STATUS.RUNNING);
  assert.equal(warnings.length, 1);
});

test('artefacts publish under the /scrape-runs prefix with media types, then serve from the remote', async () => {
  const a = instance('a');
  await a.init();
  const job = await a.create('crawl', { rootUrl: 'https://example.com/' });
  const dir = a.artefactDir(job.jobId);
  await mkdir(path.join(dir, 'pages'), { recursive: true });
  await mkdir(path.join(dir, 'logs'), { recursive: true });
  await writeFile(path.join(dir, 'crawl.json'), '{"crawl":{}}');
  await writeFile(path.join(dir, 'pages', 'home.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await writeFile(path.join(dir, 'logs', 'crawl.log'), 'hello');

  const published = await a.publishArtefacts(job.jobId);
  assert.deepEqual(published, { files: 3, bytes: 12 + 4 + 5 });

  const key = (p) => `main/.rs2-scrape/${job.jobId}/${p}`;
  assert.equal(remote.objects.get(key('crawl.json')).contentType, 'application/json; charset=utf-8');
  assert.equal(remote.objects.get(key('pages/home.png')).contentType, 'image/png');
  assert.equal(remote.objects.get(key('logs/crawl.log')).contentType, 'text/plain; charset=utf-8');

  await a.evictLocal(job.jobId);
  const manifest = await a.artefactManifest(job.jobId);
  assert.deepEqual(manifest.map((f) => f.path), ['crawl.json', 'logs/crawl.log', 'pages/home.png']);
  const read = await a.readArtefact(job.jobId, path.join('pages', 'home.png'));
  assert.equal(read.contentType, 'image/png');
  assert.equal(read.data.length, 4);
  assert.equal(await a.readArtefact(job.jobId, 'missing.json'), null);
});

test('remove deletes the record and every published artefact', async () => {
  const a = instance('a');
  await a.init();
  const job = await a.create('crawl', { rootUrl: 'https://example.com/' });
  await writeFile(path.join(a.artefactDir(job.jobId), 'crawl.json'), '{}');
  await a.publishArtefacts(job.jobId);
  assert.equal(remote.objects.size, 2);

  await a.remove(job.jobId);
  assert.equal(remote.objects.size, 0);
  assert.equal(await instance('b').get(job.jobId), null);
});

test('recovery requeues a job another boot left running, even if its pid is alive here', async () => {
  const a = instance('a', { bootId: 'boot-a' });
  await a.init();
  const job = await a.create('crawl', { rootUrl: 'https://example.com/' });
  await a.update(job.jobId, { status: STATUS.RUNNING, pid: process.pid, bootId: 'boot-a', attempt: 1 });

  // A new instance, where that pid number happens to be a live process.
  const b = instance('b', { bootId: 'boot-b' });
  await b.init();
  const recovered = await b.recover({ isAlive: () => true });
  assert.deepEqual(recovered, [{ jobId: job.jobId, action: 'requeued' }]);

  const { jobs } = await b.list({ status: STATUS.QUEUED, localOnly: true });
  assert.deepEqual(jobs.map((j) => j.jobId), [job.jobId], 'requeued job is now local, so the queue will claim it');
});

test('recovery leaves alone a job this boot is genuinely running', async () => {
  const a = instance('a', { bootId: 'boot-a' });
  await a.init();
  const job = await a.create('crawl', { rootUrl: 'https://example.com/' });
  await a.update(job.jobId, { status: STATUS.RUNNING, pid: process.pid, bootId: 'boot-a', attempt: 1 });
  assert.deepEqual(await a.recover({ isAlive: () => true }), []);
});

test('the API serves a finished job from the remote after the instance that ran it is gone', async () => {
  const config = JSON.parse(await readFile(new URL('../config/defaults.json', import.meta.url), 'utf8'));
  const serverConfig = (name) => ({
    ...config,
    server: {
      ...config.server,
      port: 0,
      host: '127.0.0.1',
      jobRoot: path.join(workDir, name, 'jobs'),
      artefactRoot: path.join(workDir, name, 'artefacts'),
      concurrentJobs: 0,
    },
    gc: { ...config.gc, sweepIntervalMs: 3_600_000 },
  });

  // Instance one accepts the job and "finishes" it.
  const one = await createServer({ config: serverConfig('one'), logger: quiet, remote });
  await one.listen();
  const base1 = `http://127.0.0.1:${one.server.address().port}`;
  const created = await (
    await fetch(`${base1}/crawls`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rootUrl: 'https://example.com/' }),
    })
  ).json();
  const jobId = created.jobId;
  await mkdir(path.join(one.store.artefactDir(jobId), 'logs'), { recursive: true });
  await writeFile(path.join(one.store.artefactDir(jobId), 'crawl.json'), '{"crawl":{"pages":1}}');
  await writeFile(path.join(one.store.artefactDir(jobId), 'logs', 'crawl.log'), 'done');
  await one.store.publishArtefacts(jobId);
  await one.store.update(jobId, { status: STATUS.SUCCEEDED, finishedAt: new Date().toISOString() });
  await one.close();

  // Instance two has an empty disk and only the remote.
  const two = await createServer({ config: serverConfig('two'), logger: quiet, remote });
  await two.listen();
  const base2 = `http://127.0.0.1:${two.server.address().port}`;
  try {
    const job = await (await fetch(`${base2}/crawls/${jobId}`)).json();
    assert.equal(job.status, STATUS.SUCCEEDED);

    const manifest = await (await fetch(`${base2}/crawls/${jobId}/artefacts`)).json();
    assert.deepEqual(manifest.files.map((f) => f.path), ['crawl.json', 'logs/crawl.log']);

    const file = await fetch(`${base2}/crawls/${jobId}/artefacts/crawl.json`);
    assert.equal(file.status, 200);
    assert.deepEqual(await file.json(), { crawl: { pages: 1 } });

    assert.equal(await (await fetch(`${base2}/crawls/${jobId}/log`)).text(), 'done');

    // A repeat request inside the dedupe window finds the remote-only job.
    const again = await (
      await fetch(`${base2}/crawls`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rootUrl: 'https://example.com/' }),
      })
    ).json();
    assert.equal(again.jobId, jobId);
    assert.equal(again.deduplicated, true);

    const health = await (await fetch(`${base2}/health`)).json();
    assert.equal(health.remoteStore, true);
    assert.equal(health.queueDepth, 0);
  } finally {
    await two.close();
  }
});
