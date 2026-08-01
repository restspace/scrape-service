// Durable job records.
//
// The runtime has no queue of its own and RS2 deliberately has none either, so
// this file is the durability story: one directory per job, one job.json inside
// it, written atomically. A crash loses in-flight browser work but never loses
// the record of what was asked for — which is what lets the server come back up
// and honestly report what happened rather than leaving jobs stuck in "running".

import { mkdir, writeFile, readFile, readdir, rename, rm } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

export const STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
});

export const TERMINAL = new Set([STATUS.SUCCEEDED, STATUS.FAILED, STATUS.CANCELLED, STATUS.EXPIRED]);

/**
 * Sortable, collision-resistant, filesystem-safe id. Time-prefixed so a plain
 * directory listing is chronological and the GC can shortcut on the prefix.
 */
export function newJobId(now = Date.now()) {
  return `${now.toString(36).padStart(9, '0')}-${randomBytes(5).toString('hex')}`;
}

/**
 * Stable hash of a job spec, for deduplicating identical requests. Keys are
 * sorted recursively so that two specs differing only in property order — which
 * JSON.stringify would otherwise render differently — hash the same.
 */
export function hashSpec(kind, spec) {
  return createHash('sha256').update(JSON.stringify(sortDeep({ kind, spec }))).digest('hex').slice(0, 32);
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortDeep(value[k])]));
  }
  return value;
}

export class JobStore {
  constructor({ jobRoot, artefactRoot }) {
    this.jobRoot = jobRoot;
    this.artefactRoot = artefactRoot;
  }

  async init() {
    await mkdir(this.jobRoot, { recursive: true });
    await mkdir(this.artefactRoot, { recursive: true });
  }

  dir(jobId) {
    return path.join(this.jobRoot, jobId);
  }

  artefactDir(jobId) {
    return path.join(this.artefactRoot, jobId);
  }

  /** Atomic: a reader never sees a half-written record. */
  async #write(job) {
    const dir = this.dir(job.jobId);
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, 'job.json');
    const tmp = path.join(dir, `.job.json.${process.pid}.tmp`);
    await writeFile(tmp, JSON.stringify(job, null, 2));
    await rename(tmp, target);
    return job;
  }

  async create(kind, spec, { now = Date.now() } = {}) {
    const jobId = newJobId(now);
    const job = {
      jobId,
      kind,
      spec,
      specHash: hashSpec(kind, spec),
      status: STATUS.QUEUED,
      createdAt: new Date(now).toISOString(),
      startedAt: null,
      finishedAt: null,
      attempt: 0,
      pid: null,
      progress: {},
      result: null,
      error: null,
      artefactPath: `${jobId}/`,
    };
    await mkdir(this.artefactDir(jobId), { recursive: true });
    return this.#write(job);
  }

  async get(jobId) {
    // Reject anything that could climb out of the job root before touching disk.
    if (!/^[a-z0-9-]+$/i.test(jobId)) return null;
    try {
      return JSON.parse(await readFile(path.join(this.dir(jobId), 'job.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  async update(jobId, patch) {
    const job = await this.get(jobId);
    if (!job) return null;
    return this.#write({ ...job, ...patch });
  }

  /** Merge into progress without clobbering sibling keys. */
  async mergeProgress(jobId, progress) {
    const job = await this.get(jobId);
    if (!job) return null;
    return this.#write({ ...job, progress: { ...job.progress, ...progress } });
  }

  async list({ status, limit = 50, cursor } = {}) {
    let ids;
    try {
      ids = (await readdir(this.jobRoot, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
        .reverse(); // newest first — ids are time-prefixed
    } catch {
      return { jobs: [], nextCursor: null };
    }
    if (cursor) {
      const at = ids.indexOf(cursor);
      if (at >= 0) ids = ids.slice(at + 1);
    }
    const jobs = [];
    for (const id of ids) {
      if (jobs.length >= limit) break;
      const job = await this.get(id);
      if (!job) continue;
      if (status && job.status !== status) continue;
      jobs.push(job);
    }
    const nextCursor = jobs.length === limit ? jobs[jobs.length - 1].jobId : null;
    return { jobs, nextCursor };
  }

  /**
   * An identical request already in flight, or one that succeeded recently
   * enough to still be useful. Cheaper and more durable than an idempotency
   * key, and it means an impatient client retrying does not double the load on
   * someone else's website.
   */
  async findDuplicate(kind, spec, { windowMs, now = Date.now() }) {
    const specHash = hashSpec(kind, spec);
    const { jobs } = await this.list({ limit: 200 });
    for (const job of jobs) {
      if (job.specHash !== specHash) continue;
      if (job.status === STATUS.QUEUED || job.status === STATUS.RUNNING) return job;
      if (job.status === STATUS.SUCCEEDED && now - Date.parse(job.finishedAt ?? job.createdAt) <= windowMs) {
        return job;
      }
    }
    return null;
  }

  async remove(jobId) {
    if (!/^[a-z0-9-]+$/i.test(jobId)) return false;
    await rm(this.dir(jobId), { recursive: true, force: true });
    await rm(this.artefactDir(jobId), { recursive: true, force: true });
    return true;
  }

  /**
   * Boot-time reconciliation. A job left `running` by a crash is not running —
   * its process is gone. Reporting it honestly (or requeuing it once) matters
   * more than being clever: a job stuck in `running` forever is the single most
   * confusing state a polling client can hit.
   */
  async recover({ maxAttempts = 2, isAlive = defaultIsAlive } = {}) {
    const { jobs } = await this.list({ limit: 1000 });
    const recovered = [];
    for (const job of jobs) {
      if (job.status !== STATUS.RUNNING && job.status !== STATUS.QUEUED) continue;
      if (job.status === STATUS.RUNNING && job.pid && isAlive(job.pid)) continue; // genuinely still going

      if (job.attempt < maxAttempts) {
        await this.update(job.jobId, { status: STATUS.QUEUED, pid: null, startedAt: null });
        recovered.push({ jobId: job.jobId, action: 'requeued' });
      } else {
        await this.update(job.jobId, {
          status: STATUS.FAILED,
          pid: null,
          finishedAt: new Date().toISOString(),
          error: { code: 'worker_lost', message: 'worker process disappeared (server restart or crash)' },
        });
        recovered.push({ jobId: job.jobId, action: 'failed' });
      }
    }
    return recovered;
  }
}

function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
