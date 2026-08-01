// Artefact garbage collection.
//
// A 50-page crawl with desktop and mobile full-page screenshots is 50-150 MB.
// At a few crawls a day, unattended, that fills the disk in weeks — and it is
// the same disk RS2 serves client sites from. So this is not housekeeping, it
// is the thing that stops capture work taking a production site offline.
//
// Two triggers: age (a TTL, swept periodically and on boot) and pressure (a
// disk high-water mark, evicting oldest-first). Job records and their artefacts
// are always removed together, so a client never sees a job that claims success
// with nothing behind it.

import { statfs } from 'node:fs/promises';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { STATUS, TERMINAL } from './store.mjs';

export class ArtefactGC {
  constructor({ store, ttlDays = 14, sweepIntervalMs = 3_600_000, diskHighWaterPct = 85, logger = console }) {
    this.store = store;
    this.ttlMs = ttlDays * 24 * 60 * 60 * 1000;
    this.sweepIntervalMs = sweepIntervalMs;
    this.diskHighWaterPct = diskHighWaterPct;
    this.logger = logger;
    this.timer = null;
  }

  start() {
    // Sweep on boot as well as on the interval: a server that was down over the
    // weekend should clean up before it starts accepting new work.
    this.sweep().catch((e) => this.logger.error?.(`gc: initial sweep failed: ${e.message}`));
    this.timer = setInterval(
      () => this.sweep().catch((e) => this.logger.error?.(`gc: sweep failed: ${e.message}`)),
      this.sweepIntervalMs,
    );
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sweep({ now = Date.now() } = {}) {
    const expired = await this.#sweepExpired(now);
    const evicted = await this.#sweepPressure(now);
    if (expired.length || evicted.length) {
      this.logger.info?.(`gc: removed ${expired.length} expired, ${evicted.length} evicted for disk pressure`);
    }
    return { expired, evicted };
  }

  async #sweepExpired(now) {
    const { jobs } = await this.store.list({ limit: 1000 });
    const removed = [];
    for (const job of jobs) {
      if (!TERMINAL.has(job.status)) continue; // never reap something still running
      const finished = Date.parse(job.finishedAt ?? job.createdAt);
      if (Number.isNaN(finished) || now - finished < this.ttlMs) continue;
      await this.store.remove(job.jobId);
      removed.push(job.jobId);
    }
    return removed;
  }

  async #sweepPressure(now) {
    const usage = await diskUsagePct(this.store.artefactRoot);
    if (usage === null || usage < this.diskHighWaterPct) return [];

    this.logger.warn?.(`gc: disk at ${usage.toFixed(1)}% (high-water ${this.diskHighWaterPct}%) — evicting oldest artefacts`);

    const { jobs } = await this.store.list({ limit: 1000 });
    // Oldest terminal jobs first; a running job is never a candidate.
    const candidates = jobs
      .filter((j) => TERMINAL.has(j.status))
      .sort((a, b) => Date.parse(a.finishedAt ?? a.createdAt) - Date.parse(b.finishedAt ?? b.createdAt));

    const evicted = [];
    for (const job of candidates) {
      await this.store.remove(job.jobId);
      evicted.push(job.jobId);
      const nowPct = await diskUsagePct(this.store.artefactRoot);
      if (nowPct === null || nowPct < this.diskHighWaterPct - 5) break; // hysteresis
    }
    if (!evicted.length) {
      this.logger.error?.('gc: disk over high-water mark but nothing evictable — every job is still running');
    }
    return evicted;
  }
}

/** Percentage of the filesystem in use, or null if it cannot be determined. */
export async function diskUsagePct(dir) {
  try {
    const s = await statfs(dir);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    if (!total) return null;
    return ((total - free) / total) * 100;
  } catch {
    return null;
  }
}

/** Bytes on disk under a directory. Used to enforce the per-job artefact cap. */
export async function dirSize(dir) {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else {
      try { total += (await stat(p)).size; } catch { /* raced with GC */ }
    }
  }
  return total;
}
