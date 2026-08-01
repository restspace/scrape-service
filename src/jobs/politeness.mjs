// Per-domain politeness, shared across every job on the box.
//
// Locally this did not exist and did not need to: crawl.mjs was sequential and
// scan.mjs ran a handful of hand-picked sites. On a server, two jobs can target
// the same host at once, and "concurrency 2" quietly becomes "two simultaneous
// crawlers hammering one small business's shared hosting". This makes that
// impossible regardless of how many jobs are in flight.
//
// Two constraints per domain: a minimum interval between requests, and a cap on
// simultaneous requests. Both are enforced by the same gate.

import { politenessKey } from '../capture/urls.mjs';

export class PolitenessGate {
  constructor({ minIntervalMs = 800, maxConcurrentPerDomain = 1 } = {}) {
    this.minIntervalMs = minIntervalMs;
    this.maxConcurrentPerDomain = maxConcurrentPerDomain;
    /** @type {Map<string, {lastAt: number, active: number, waiters: Array<() => void>}>} */
    this.domains = new Map();
  }

  #state(key) {
    let s = this.domains.get(key);
    if (!s) {
      s = { lastAt: 0, active: 0, waiters: [] };
      this.domains.set(key, s);
    }
    return s;
  }

  /**
   * Wait until it is polite to hit this URL's domain. Always pair with
   * release() in a finally block, or the domain's slot leaks and every later
   * request for that host blocks forever.
   */
  async acquire(url, signal) {
    const key = politenessKey(url);
    const s = this.#state(key);

    while (s.active >= this.maxConcurrentPerDomain) {
      if (signal?.aborted) throw new Error('aborted while waiting for politeness slot');
      await new Promise((resolve) => s.waiters.push(resolve));
    }
    s.active += 1;

    const wait = this.minIntervalMs - (Date.now() - s.lastAt);
    if (wait > 0) await sleep(wait, signal);
    s.lastAt = Date.now();
    return key;
  }

  release(url) {
    const key = politenessKey(url);
    const s = this.domains.get(key);
    if (!s) return;
    s.active = Math.max(0, s.active - 1);
    s.lastAt = Date.now();
    const next = s.waiters.shift();
    if (next) next();
  }

  /** Convenience wrapper so callers cannot forget to release. */
  async run(url, fn, signal) {
    await this.acquire(url, signal);
    try {
      return await fn();
    } finally {
      this.release(url);
    }
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => { clearTimeout(t); reject(new Error('aborted')); };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
