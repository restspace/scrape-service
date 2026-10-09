// Fronting Worker for scrape-service running as a Cloudflare Container.
//
// On EC2 the sidecar bound loopback and RS2's proxy mount was the only way in.
// Here the container is reachable only through this Worker, and this Worker
// admits only callers holding SCRAPE_TOKEN — which RS2's `/scrape` proxy mount
// injects from an operator infra, after RS2 has already applied the mount's own
// access roles. So the chain is unchanged: RS2 authz, then a secret only RS2
// holds, then the service.
//
// One named instance ("main"): the service owns a job queue, and that queue is
// what keeps two jobs off the same domain, so it assumes a single process.
// More capacity means more job slots in this instance (CONCURRENT_JOBS below),
// not more instances.

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
      // Sizing for a standard-2 instance (1 vCPU, 6 GiB memory, 12 GB disk);
      // keep in step with instance_type in wrangler.jsonc.
      //
      // Two jobs at once, each its own Chromium: 2 x 887 MiB measured peak is
      // about 1.8 GiB of the 6 GiB, and the two share one vCPU, so each gets
      // the half vCPU a lone job had on standard-1. Disk: each running job may
      // hold up to ARTEFACT_BYTES_PER_JOB locally until it is published to R2
      // and evicted, so the worst case is CONCURRENT_JOBS x that (2 GiB here)
      // of the 12 GB. Raising CONCURRENT_JOBS means re-doing this sum, and
      // moving up an instance size before the vCPU share per job drops.
      CONCURRENT_JOBS: env.CONCURRENT_JOBS ?? '2',
      MAX_PAGES_CEILING: env.MAX_PAGES_CEILING ?? '120',
      ARTEFACT_BYTES_PER_JOB: env.ARTEFACT_BYTES_PER_JOB ?? String(1024 ** 3),
      ARTEFACT_TTL_DAYS: env.ARTEFACT_TTL_DAYS ?? '7',
    };
    // Who the crawler says it is. Unset, the service uses the identity in its
    // config/defaults.json (RapiderITBot). Set both or neither: the service
    // refuses to start if the robots token is not part of the user agent.
    if (env.CRAWLER_USER_AGENT) this.envVars.CRAWLER_USER_AGENT = env.CRAWLER_USER_AGENT;
    if (env.CRAWLER_ROBOTS_TOKEN) this.envVars.CRAWLER_ROBOTS_TOKEN = env.CRAWLER_ROBOTS_TOKEN;
  }

  /**
   * Called when `sleepAfter` elapses with no inbound requests. A crawl can run
   * for fifteen minutes with nobody polling, and sleeping would kill it — so
   * ask the service whether it has work before stopping. `activeJobs` counts
   * every running job and `queueDepth` every waiting one, so this holds for
   * any CONCURRENT_JOBS.
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
