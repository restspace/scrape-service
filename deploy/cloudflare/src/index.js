// Fronting Worker for scrape-service running as a Cloudflare Container.
//
// On EC2 the sidecar bound loopback and RS2's proxy mount was the only way in.
// Here the container is reachable only through this Worker, and this Worker
// admits only callers holding SCRAPE_TOKEN — which RS2's `/scrape` proxy mount
// injects from an operator infra, after RS2 has already applied the mount's own
// access roles. So the chain is unchanged: RS2 authz, then a secret only RS2
// holds, then the service.
//
// One named instance ("main"): the service owns a job queue and per-domain
// politeness, both of which assume a single process.

import { Container, getContainer } from '@cloudflare/containers';

const PORT = 8081;
const INSTANCE = 'main';

/** Consecutive failed health probes tolerated before letting the instance sleep. */
const MAX_PROBE_FAILURES = 3;

export class ScrapeContainer extends Container {
  defaultPort = PORT;
  // Idle time before the instance sleeps and billing stops. Long enough that a
  // client submitting a series of jobs does not pay a cold start for each.
  sleepAfter = '10m';
  enableInternet = true;

  constructor(ctx, env) {
    super(ctx, env);
    this.probeFailures = 0;
    // Read when the container starts, so secrets set with `wrangler secret put`
    // reach the process without being baked into the image.
    this.envVars = {
      R2_ACCOUNT_ID: env.R2_ACCOUNT_ID,
      R2_BUCKET: env.R2_BUCKET,
      R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
      // Sizing for a standard-1 instance (4 GiB memory, 8 GB scratch disk).
      CONCURRENT_JOBS: env.CONCURRENT_JOBS ?? '1',
      MAX_PAGES_CEILING: env.MAX_PAGES_CEILING ?? '120',
      ARTEFACT_BYTES_PER_JOB: env.ARTEFACT_BYTES_PER_JOB ?? String(1024 ** 3),
      ARTEFACT_TTL_DAYS: env.ARTEFACT_TTL_DAYS ?? '7',
    };
  }

  /**
   * Called when `sleepAfter` elapses with no inbound requests. A crawl can run
   * for fifteen minutes with nobody polling, and sleeping would kill it — so
   * ask the service whether it has work before stopping.
   */
  async onActivityExpired() {
    try {
      const res = await this.containerFetch(`http://container/health`, PORT);
      if (!res.ok) throw new Error(`health answered ${res.status}`);
      const health = await res.json();
      this.probeFailures = 0;
      if (health.activeJobs > 0 || health.queueDepth > 0) {
        this.renewActivityTimeout();
        return;
      }
    } catch (err) {
      // A busy instance can be slow to answer. Keep it awake for a few probes
      // rather than killing a job over one missed health check.
      this.probeFailures += 1;
      console.error(`keep-awake probe failed (${this.probeFailures}/${MAX_PROBE_FAILURES}): ${err}`);
      if (this.probeFailures < MAX_PROBE_FAILURES) {
        this.renewActivityTimeout();
        return;
      }
    }
    await this.stop();
  }
}

export default {
  async fetch(request, env) {
    if (!env.SCRAPE_TOKEN) {
      return problem(503, 'not_configured', 'SCRAPE_TOKEN is not set on this Worker');
    }
    if (!(await bearerMatches(request.headers.get('authorization'), env.SCRAPE_TOKEN))) {
      return problem(401, 'unauthorized', 'a valid bearer token is required');
    }

    // The token is for this hop only; the service never needs to see it.
    const headers = new Headers(request.headers);
    headers.delete('authorization');
    return getContainer(env.SCRAPER, INSTANCE).fetch(new Request(request, { headers }));
  },
};

async function bearerMatches(header, token) {
  const presented = /^Bearer\s+(.+)$/i.exec(header ?? '')?.[1] ?? '';
  // Compare digests so the comparison is constant-time and length-independent.
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(presented)),
    crypto.subtle.digest('SHA-256', enc.encode(token)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

/** Same error shape as the service itself, so clients have one parser. */
function problem(status, code, message) {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
