// The worker pool's concurrency, with a stand-in worker in place of Chromium.
//
// What these prove is scheduling, which is all the queue decides: how many jobs
// run at once, that the rest wait their turn in order, and that two jobs never
// work the same domain together. tools/fake-worker.mjs holds each job
// in `running` until the test releases it, so nothing here depends on timing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { JobStore, STATUS } from '../src/jobs/store.mjs';
import { JobQueue, jobDomains } from '../src/jobs/queue.mjs';

const FAKE_WORKER = fileURLToPath(new URL('../tools/fake-worker.mjs', import.meta.url));
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const limits = { crawlWallClockMs: 60_000, scanWallClockMs: 60_000, shotWallClockMs: 60_000, artefactBytesPerJob: 0 };

async function harness(t, concurrency) {
  const dir = await mkdtemp(path.join(tmpdir(), 'scrape-queue-test-'));
  const store = new JobStore({ jobRoot: path.join(dir, 'jobs'), artefactRoot: path.join(dir, 'artefacts'), logger: quiet });
  await store.init();
  const queue = new JobQueue({ store, limits, concurrency, logger: quiet, workerScript: FAKE_WORKER });
  queue.start();
  t.after(async () => {
    await queue.drain({ timeoutMs: 2_000 });
    await rm(dir, { recursive: true, force: true });
  });

  let clock = Date.now();
  return {
    store,
    queue,
    /** Job ids sort by creation time, which is what makes the queue FIFO; space them out. */
    async submit(rootUrl) {
      clock += 10;
      const job = await store.create('crawl', { rootUrl }, { now: clock });
      queue.poke();
      return job.jobId;
    },
    release: (jobId) => writeFile(path.join(store.artefactDir(jobId), 'release'), ''),
    status: async (jobId) => (await store.get(jobId)).status,
    /** Wait until the job's record reads `status`, failing with what it read instead. */
    async reaches(jobId, status) {
      const deadline = Date.now() + 15_000;
      let seen;
      while (Date.now() < deadline) {
        seen = (await store.get(jobId)).status;
        if (seen === status) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.fail(`job ${jobId} did not reach '${status}' (last seen '${seen}')`);
    },
  };
}

/** Long enough for the queue loop to have launched anything it was going to. */
const settle = () => new Promise((r) => setTimeout(r, 700));

test('with concurrency 2, two jobs run at the same time and a third waits', async (t) => {
  const h = await harness(t, 2);
  const a = await h.submit('https://one.example/');
  const b = await h.submit('https://two.example/');
  const c = await h.submit('https://three.example/');

  await h.reaches(a, STATUS.RUNNING);
  await h.reaches(b, STATUS.RUNNING);
  assert.equal(h.queue.activeCount, 2, 'both slots are in use at once');

  await settle();
  assert.equal(await h.status(c), STATUS.QUEUED, 'the third job waits while both slots are busy');
  assert.equal(h.queue.activeCount, 2);
  assert.equal(await h.status(a), STATUS.RUNNING);
  assert.equal(await h.status(b), STATUS.RUNNING);

  // Finishing the *second* job frees a slot while the first is still running.
  await h.release(b);
  await h.reaches(b, STATUS.SUCCEEDED);
  await h.reaches(c, STATUS.RUNNING);
  assert.equal(await h.status(a), STATUS.RUNNING, 'the first job is unaffected by its neighbour finishing');
  assert.equal(h.queue.activeCount, 2);

  await h.release(a);
  await h.release(c);
  await h.reaches(a, STATUS.SUCCEEDED);
  await h.reaches(c, STATUS.SUCCEEDED);
  assert.equal(h.queue.activeCount, 0);

  const startedA = Date.parse((await h.store.get(a)).startedAt);
  const startedB = Date.parse((await h.store.get(b)).startedAt);
  const finishedB = Date.parse((await h.store.get(b)).finishedAt);
  const startedC = Date.parse((await h.store.get(c)).startedAt);
  assert.ok(startedA < finishedB && startedB < finishedB, 'the first two overlapped');
  assert.ok(startedC >= finishedB, 'the third started only once a slot was free');
});

test('with concurrency 1, jobs run one at a time in submission order', async (t) => {
  const h = await harness(t, 1);
  const a = await h.submit('https://one.example/');
  const b = await h.submit('https://two.example/');

  await h.reaches(a, STATUS.RUNNING);
  await settle();
  assert.equal(await h.status(b), STATUS.QUEUED);
  assert.equal(h.queue.activeCount, 1);

  await h.release(a);
  await h.reaches(a, STATUS.SUCCEEDED);
  await h.reaches(b, STATUS.RUNNING);
  await h.release(b);
  await h.reaches(b, STATUS.SUCCEEDED);
});

test('two jobs for the same domain never run together, and do not block other domains', async (t) => {
  const h = await harness(t, 2);
  const first = await h.submit('https://www.same.example/');
  const second = await h.submit('https://same.example/pricing');
  const other = await h.submit('https://other.example/');

  await h.reaches(first, STATUS.RUNNING);
  await h.reaches(other, STATUS.RUNNING);
  await settle();
  assert.equal(await h.status(second), STATUS.QUEUED, 'held back: its domain is being crawled by the first job');

  // A free slot is not enough; the domain has to be free.
  await h.release(other);
  await h.reaches(other, STATUS.SUCCEEDED);
  await settle();
  assert.equal(await h.status(second), STATUS.QUEUED, 'still held with a slot free');
  assert.equal(h.queue.activeCount, 1);

  await h.release(first);
  await h.reaches(first, STATUS.SUCCEEDED);
  await h.reaches(second, STATUS.RUNNING);
  await h.release(second);
  await h.reaches(second, STATUS.SUCCEEDED);
});

test('jobDomains reads the domains a job spec targets', () => {
  assert.deepEqual([...jobDomains({ spec: { rootUrl: 'https://www.acme.co.uk/about' } })], ['acme.co.uk']);
  assert.deepEqual(
    [...jobDomains({ spec: { rootUrl: 'https://a.example/', allowedDomains: ['shop.b.example'] } })].sort(),
    ['a.example', 'b.example'],
  );
  assert.deepEqual(
    [...jobDomains({ spec: { candidates: [{ url: 'https://x.example/' }, 'https://blog.y.example/'] } })].sort(),
    ['x.example', 'y.example'],
  );
  assert.equal(jobDomains({ spec: {} }).size, 0);
});
