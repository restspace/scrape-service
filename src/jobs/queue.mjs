// The worker pool: picks up queued jobs, runs each in its own child process,
// folds the child's progress back into the durable record, and enforces the
// wall-clock ceilings.
//
// Concurrency is deliberately low by default. This process shares a box with
// the RS2 node that serves client sites, and each chromium context costs
// 150-300 MB — "how many can we run" is the wrong question, "what can the box
// spare without degrading the sites people are paying for" is the right one.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

import { STATUS } from './store.mjs';
import { dirSize } from './gc.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const RUN_JOB = path.join(here, '..', 'workers', 'run-job.mjs');

export class JobQueue {
  constructor({ store, limits, concurrency = 2, logger = console }) {
    this.store = store;
    this.limits = limits;
    this.concurrency = concurrency;
    this.logger = logger;
    /** @type {Map<string, {child: import('node:child_process').ChildProcess, timer: NodeJS.Timeout}>} */
    this.running = new Map();
    this.stopped = false;
    this.wakeup = null;
  }

  get activeCount() {
    return this.running.size;
  }

  /** Nudge the loop when a job is submitted, instead of waiting out the poll. */
  poke() {
    if (this.wakeup) {
      this.wakeup();
      this.wakeup = null;
    }
  }

  async start() {
    this.stopped = false;
    while (!this.stopped) {
      let launched = 0;
      while (this.running.size < this.concurrency) {
        const next = await this.#claimNext();
        if (!next) break;
        this.#launch(next);
        launched++;
      }
      // Sleep until poked or a short poll elapses. The poll is the backstop for
      // jobs requeued by recovery, which arrive without a poke.
      await new Promise((resolve) => {
        this.wakeup = resolve;
        const t = setTimeout(resolve, launched ? 200 : 2000);
        t.unref?.();
      });
    }
  }

  stop() {
    this.stopped = true;
    this.poke();
  }

  async #claimNext() {
    const { jobs } = await this.store.list({ status: STATUS.QUEUED, limit: 50 });
    // list() is newest-first; take the oldest queued job so the queue is FIFO.
    const job = jobs[jobs.length - 1];
    if (!job) return null;
    if (this.running.has(job.jobId)) return null;
    return job;
  }

  #wallClockFor(kind) {
    if (kind === 'scan') return this.limits.scanWallClockMs;
    if (kind === 'shot') return this.limits.shotWallClockMs;
    return this.limits.crawlWallClockMs;
  }

  #launch(job) {
    const child = spawn(
      process.execPath,
      [RUN_JOB, '--job', job.jobId, '--job-root', this.store.jobRoot, '--artefact-root', this.store.artefactRoot],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    const budget = this.#wallClockFor(job.kind);
    let timedOut = false;
    let oversized = false;
    const stop = (why) => {
      // SIGTERM first so the worker can close chromium; the child translates it
      // into a cooperative abort. SIGKILL only if it will not go.
      this.logger.warn?.(`job ${job.jobId} ${why} — terminating`);
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref?.();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stop(`exceeded ${budget}ms`);
    }, budget);
    timer.unref?.();

    // Enforce the per-job artefact cap while the job runs, not after it. A
    // runaway crawl on a small disk can fill the filesystem the RS2 node serves
    // client sites from, so noticing at completion time would be too late.
    const cap = this.limits.artefactBytesPerJob;
    const sizeTimer = cap
      ? setInterval(async () => {
          try {
            const bytes = await dirSize(this.store.artefactDir(job.jobId));
            if (bytes > cap) {
              oversized = true;
              clearInterval(sizeTimer);
              stop(`artefacts reached ${bytes} bytes (cap ${cap})`);
            }
          } catch { /* the dir may vanish under a concurrent delete */ }
        }, 30_000)
      : null;
    sizeTimer?.unref?.();

    this.running.set(job.jobId, { child, timer, sizeTimer });

    this.store.update(job.jobId, {
      status: STATUS.RUNNING,
      startedAt: new Date().toISOString(),
      pid: child.pid,
      attempt: job.attempt + 1,
    }).catch((e) => this.logger.error?.(`job ${job.jobId}: could not mark running: ${e.message}`));

    // Progress arrives as NDJSON. Throttle the disk writes: a 200-page crawl
    // emits thousands of lines and rewriting job.json per line would dominate
    // the job's I/O for no benefit to a polling client.
    let lastFlush = 0;
    let pending = null;
    let result = null;
    let workerError = null;

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        return; // a non-JSON line means a library wrote to stdout; ignore it
      }
      if (evt.type === 'result') { result = evt.result; return; }
      if (evt.type === 'error') { workerError = evt.error; return; }
      if (evt.type === 'progress') {
        pending = { ...pending, ...evt, type: undefined };
        const now = Date.now();
        if (now - lastFlush > 1500) {
          lastFlush = now;
          const snapshot = pending;
          pending = null;
          this.store.mergeProgress(job.jobId, stripUndefined(snapshot)).catch(() => {});
        }
      }
    });

    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4000); });

    child.on('error', (err) => {
      workerError = { code: 'spawn_failed', message: err.message };
    });

    child.on('close', async (code, signal) => {
      clearTimeout(timer);
      if (sizeTimer) clearInterval(sizeTimer);
      this.running.delete(job.jobId);
      rl.close();

      const finishedAt = new Date().toISOString();
      const current = await this.store.get(job.jobId);
      // A DELETE that arrived mid-run already set the terminal state; do not
      // overwrite an explicit cancellation with a derived one.
      if (current?.status === STATUS.CANCELLED) return;

      if (pending) await this.store.mergeProgress(job.jobId, stripUndefined(pending)).catch(() => {});

      if (oversized) {
        await this.store.update(job.jobId, {
          status: STATUS.FAILED, finishedAt, pid: null,
          error: { code: 'artefact_cap_exceeded', message: `job artefacts exceeded the ${cap}-byte cap` },
        });
      } else if (timedOut) {
        await this.store.update(job.jobId, {
          status: STATUS.FAILED, finishedAt, pid: null,
          error: { code: 'wall_clock_exceeded', message: `job exceeded its ${budget}ms budget` },
        });
      } else if (code === 0) {
        await this.store.update(job.jobId, { status: STATUS.SUCCEEDED, finishedAt, pid: null, result, error: null });
      } else if (code === 3) {
        await this.store.update(job.jobId, {
          status: STATUS.CANCELLED, finishedAt, pid: null,
          error: workerError ?? { code: 'aborted', message: 'job aborted' },
        });
      } else {
        await this.store.update(job.jobId, {
          status: STATUS.FAILED, finishedAt, pid: null,
          error: workerError ?? {
            code: 'worker_failed',
            message: signal
              ? `worker killed by ${signal}`
              : `worker exited ${code}${stderr ? `: ${stderr.split('\n').filter(Boolean).slice(-1)[0]}` : ''}`,
          },
        });
      }
      this.poke();
    });
  }

  /** Cancel a running job. Returns false if it was not running here. */
  async cancel(jobId) {
    const entry = this.running.get(jobId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    if (entry.sizeTimer) clearInterval(entry.sizeTimer);
    await this.store.update(jobId, {
      status: STATUS.CANCELLED,
      finishedAt: new Date().toISOString(),
      pid: null,
      error: { code: 'cancelled', message: 'cancelled by request' },
    });
    entry.child.kill('SIGTERM');
    setTimeout(() => entry.child.kill('SIGKILL'), 10_000).unref?.();
    this.running.delete(jobId);
    return true;
  }

  /** Stop accepting work and let in-flight children finish or die. */
  async drain({ timeoutMs = 15_000 } = {}) {
    this.stop();
    const deadline = Date.now() + timeoutMs;
    while (this.running.size && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    for (const [, entry] of this.running) entry.child.kill('SIGKILL');
  }
}

function stripUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}
