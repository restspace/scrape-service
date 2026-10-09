// Durable job records.
//
// The runtime has no queue of its own and RS2 deliberately has none either, so
// this file is the durability story: one directory per job, one job.json inside
// it, written atomically. A crash loses in-flight browser work but never loses
// the record of what was asked for — which is what lets the server come back up
// and honestly report what happened rather than leaving jobs stuck in "running".
//
// With a `remote` (R2, see remote.mjs) the local disk becomes a cache for the
// jobs this boot is working on, and the remote is the durable copy: every record
// write is mirrored, finished artefacts are published, and reads fall back to
// the remote for jobs an earlier instance ran. Without one, nothing changes.

import { mkdir, writeFile, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

import { pool } from './remote.mjs';
import { contentTypeFor } from '../net/content-type.mjs';

export const STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
});

export const TERMINAL = new Set([STATUS.SUCCEEDED, STATUS.FAILED, STATUS.CANCELLED, STATUS.EXPIRED]);

const JOB_ID = /^[a-z0-9-]+$/i;

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
  /**
   * @param {object} opts
   * @param {string} opts.jobRoot
   * @param {string} opts.artefactRoot
   * @param {object|null} [opts.remote] R2Remote / MemoryRemote, or null for disk-only
   * @param {string} [opts.bootId] identifies this process lifetime; see recover()
   */
  constructor({ jobRoot, artefactRoot, remote = null, bootId = randomBytes(6).toString('hex'), logger = console }) {
    this.jobRoot = jobRoot;
    this.artefactRoot = artefactRoot;
    this.remote = remote;
    this.bootId = bootId;
    this.logger = logger;
    /** Terminal records read from the remote. They never change, only disappear. */
    this.remoteCache = new Map();
    /** Per-job promise chain, so mirrored writes land in the order they were made. */
    this.mirrorChains = new Map();
    /** Per-job promise chain, so read-modify-write updates of one record never interleave. */
    this.recordChains = new Map();
    this.tmpSeq = 0;
  }

  /**
   * Run `fn` once every earlier change to this job's record has finished.
   *
   * A running job's record is changed from several places at once: the queue
   * marking it running, progress flushes, the exit handler, a DELETE. Each is
   * read-modify-write, so two that overlap lose one of the changes: a progress
   * flush that read the record before it was marked running would write
   * `queued` back over `running`.
   */
  #exclusive(jobId, fn) {
    const prev = this.recordChains.get(jobId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.recordChains.set(jobId, tail);
    tail.then(() => {
      if (this.recordChains.get(jobId) === tail) this.recordChains.delete(jobId);
    });
    return next;
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

  #recordKey(jobId) {
    return `${this.remote.jobPrefix}/${jobId}.json`;
  }

  #artefactPrefix(jobId) {
    return `${this.remote.artefactPrefix}/${jobId}/`;
  }

  /**
   * Atomic: a reader never sees a half-written record.
   *
   * `strict` decides what a failed mirror means. Creating a job must fail if the
   * record cannot be made durable — accepting work we might silently lose is
   * worse than a 500. A progress or status update that fails to mirror is logged
   * and carried by the next write, because throwing from the queue's child-exit
   * handler would take the whole process down.
   */
  async #write(job, { strict = false } = {}) {
    const dir = this.dir(job.jobId);
    await mkdir(dir, { recursive: true });
    const target = path.join(dir, 'job.json');
    // Unique per write, not just per process: two writes of one record must
    // never share a temporary file.
    const tmp = path.join(dir, `.job.json.${process.pid}.${++this.tmpSeq}.tmp`);
    const json = JSON.stringify(job, null, 2);
    await writeFile(tmp, json);
    await renameOver(tmp, target);

    if (this.remote) {
      const mirrored = this.#mirror(job.jobId, json);
      if (strict) await mirrored;
      else await mirrored.catch((e) => this.logger.warn?.(`store: mirror of ${job.jobId} failed: ${e.message}`));
    }
    return job;
  }

  #mirror(jobId, json) {
    const prev = this.mirrorChains.get(jobId) ?? Promise.resolve();
    const next = prev
      .catch(() => {})
      .then(() => this.remote.put(this.#recordKey(jobId), json, 'application/json; charset=utf-8'));
    this.mirrorChains.set(jobId, next);
    const clear = () => {
      if (this.mirrorChains.get(jobId) === next) this.mirrorChains.delete(jobId);
    };
    next.then(clear, clear);
    return next;
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
      bootId: null,
      progress: {},
      result: null,
      error: null,
      artefactPath: `${jobId}/`,
    };
    await mkdir(this.artefactDir(jobId), { recursive: true });
    return this.#write(job, { strict: true });
  }

  async #getLocal(jobId) {
    try {
      return JSON.parse(await readFile(path.join(this.dir(jobId), 'job.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  async #getRemote(jobId) {
    if (!this.remote) return null;
    const cached = this.remoteCache.get(jobId);
    if (cached) return cached;
    const res = await this.remote.get(this.#recordKey(jobId));
    if (!res) return null;
    let job;
    try {
      job = JSON.parse(await res.text());
    } catch {
      return null;
    }
    if (TERMINAL.has(job.status)) this.remoteCache.set(jobId, job);
    return job;
  }

  async get(jobId) {
    // Reject anything that could climb out of the job root before touching disk.
    if (!JOB_ID.test(jobId)) return null;
    return (await this.#getLocal(jobId)) ?? (await this.#getRemote(jobId));
  }

  async update(jobId, patch) {
    return this.#exclusive(jobId, async () => {
      const job = await this.get(jobId);
      if (!job) return null;
      this.remoteCache.delete(jobId);
      return this.#write({ ...job, ...patch });
    });
  }

  /** Merge into progress without clobbering sibling keys. */
  async mergeProgress(jobId, progress) {
    return this.#exclusive(jobId, async () => {
      const job = await this.get(jobId);
      if (!job) return null;
      return this.#write({ ...job, progress: { ...job.progress, ...progress } });
    });
  }

  async #localIds() {
    try {
      return (await readdir(this.jobRoot, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return [];
    }
  }

  async #remoteIds() {
    const prefix = `${this.remote.jobPrefix}/`;
    return (await this.remote.list(prefix))
      .map((o) => o.key.slice(prefix.length))
      .filter((name) => name.endsWith('.json') && !name.includes('/'))
      .map((name) => name.slice(0, -'.json'.length))
      .filter((id) => JOB_ID.test(id));
  }

  /**
   * Newest first. `localOnly` restricts to jobs this instance holds on disk —
   * which is every queued or running job of this boot — so the queue's poll and
   * the health check never pay for a remote listing.
   */
  async list({ status, limit = 50, cursor, localOnly = false } = {}) {
    const idSet = new Set(await this.#localIds());
    if (this.remote && !localOnly) {
      for (const id of await this.#remoteIds()) idSet.add(id);
    }
    let ids = [...idSet].sort().reverse(); // ids are time-prefixed
    if (cursor) {
      const at = ids.indexOf(cursor);
      if (at >= 0) ids = ids.slice(at + 1);
    }
    const jobs = [];
    for (const id of ids) {
      if (jobs.length >= limit) break;
      const job = localOnly ? await this.#getLocal(id) : await this.get(id);
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
    if (!JOB_ID.test(jobId)) return false;
    // In turn with record updates, so one in flight cannot recreate the directory.
    await this.#exclusive(jobId, async () => {
      await rm(this.dir(jobId), { recursive: true, force: true });
      await rm(this.artefactDir(jobId), { recursive: true, force: true });
    });
    this.remoteCache.delete(jobId);
    if (this.remote) {
      // Let any in-flight mirror land first, or it would resurrect the record.
      await this.mirrorChains.get(jobId)?.catch(() => {});
      await this.remote.delete(this.#recordKey(jobId));
      await this.remote.deletePrefix(this.#artefactPrefix(jobId));
    }
    return true;
  }

  /** Free local disk for a job whose artefacts are safely published. */
  async evictLocal(jobId) {
    if (!JOB_ID.test(jobId)) return false;
    await rm(this.artefactDir(jobId), { recursive: true, force: true });
    return true;
  }

  /**
   * Upload a job's artefact tree to where the RS2 `/scrape-runs` mount reads it.
   * Returns null when there is no remote. Throws if any file fails to upload, so
   * the caller never reports success for a job whose artefacts are incomplete.
   */
  async publishArtefacts(jobId) {
    if (!this.remote || !JOB_ID.test(jobId)) return null;
    const files = await walk(this.artefactDir(jobId));
    const prefix = this.#artefactPrefix(jobId);
    let bytes = 0;
    await pool(files, 8, async (f) => {
      const data = await readFile(f.abs);
      bytes += data.length;
      await this.remote.put(`${prefix}${f.rel}`, data, contentTypeFor(f.rel));
    });
    return { files: files.length, bytes };
  }

  /** Flat recursive listing of a job's artefacts, from disk or else the remote. */
  async artefactManifest(jobId) {
    const local = await walk(this.artefactDir(jobId));
    if (local.length || !this.remote) return local.map((f) => ({ path: f.rel, bytes: f.bytes }));
    const prefix = this.#artefactPrefix(jobId);
    return (await this.remote.list(prefix)).map((o) => ({ path: o.key.slice(prefix.length), bytes: o.size }));
  }

  /**
   * One artefact as `{data, contentType}`, or null. `relPath` must already be
   * validated as contained in the job directory — this only chooses the source.
   */
  async readArtefact(jobId, relPath) {
    try {
      const data = await readFile(path.join(this.artefactDir(jobId), relPath));
      return { data, contentType: contentTypeFor(relPath) };
    } catch {
      if (!this.remote) return null;
    }
    const key = `${this.#artefactPrefix(jobId)}${relPath.split(path.sep).join('/')}`;
    const res = await this.remote.get(key);
    if (!res) return null;
    return {
      data: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') ?? contentTypeFor(relPath),
    };
  }

  /**
   * Boot-time reconciliation. A job left `running` by a crash is not running —
   * its process is gone. Reporting it honestly (or requeuing it once) matters
   * more than being clever: a job stuck in `running` forever is the single most
   * confusing state a polling client can hit.
   *
   * A pid alone cannot prove a job is alive: after a container restart the same
   * pid number can belong to an unrelated process. So a job recorded with a
   * bootId only counts as still running when that bootId is this process's.
   */
  async recover({ maxAttempts = 2, isAlive = defaultIsAlive } = {}) {
    const { jobs } = await this.list({ limit: 1000 });
    const recovered = [];
    for (const job of jobs) {
      if (job.status !== STATUS.RUNNING && job.status !== STATUS.QUEUED) continue;
      const sameBoot = !job.bootId || job.bootId === this.bootId;
      if (job.status === STATUS.RUNNING && job.pid && sameBoot && isAlive(job.pid)) continue; // genuinely still going

      if (job.attempt < maxAttempts) {
        await this.update(job.jobId, { status: STATUS.QUEUED, pid: null, bootId: null, startedAt: null });
        await mkdir(this.artefactDir(job.jobId), { recursive: true });
        recovered.push({ jobId: job.jobId, action: 'requeued' });
      } else {
        await this.update(job.jobId, {
          status: STATUS.FAILED,
          pid: null,
          bootId: null,
          finishedAt: new Date().toISOString(),
          error: { code: 'worker_lost', message: 'worker process disappeared (server restart or crash)' },
        });
        recovered.push({ jobId: job.jobId, action: 'failed' });
      }
    }
    return recovered;
  }
}

/** Files under `root`, depth-first, sorted, with forward-slash relative paths. */
async function walk(root) {
  const files = [];
  const visit = async (dir, prefix) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await visit(abs, rel);
      else {
        try {
          files.push({ abs, rel, bytes: (await stat(abs)).size });
        } catch {
          /* raced with GC */
        }
      }
    }
  };
  await visit(root, '');
  return files;
}

/**
 * rename() that tolerates a reader. On Windows, replacing a file that another
 * handle has open (a poll reading job.json at that instant) fails with EPERM,
 * EACCES or EBUSY; the handle is gone a moment later. POSIX never takes this path.
 */
async function renameOver(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(from, to);
    } catch (e) {
      if (attempt >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
      await new Promise((r) => setTimeout(r, 10 + attempt * 5));
    }
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
