// Configuration: config/defaults.json plus environment overrides.
//
// Both the API process and each job's child process load it from here. The
// child inherits the parent's environment, so an override set on the service
// (the crawler's identity in particular) reaches the code that actually talks
// to websites.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * The crawler's identity when nothing configures one. config/defaults.json
 * carries the same two values (test/robots.test.mjs keeps them in step); these
 * are the fallback for code called without a config, such as the tools.
 *
 * The user agent is the plain product form, exactly as published on the page it
 * links to. The identity before it was wrapped as `Mozilla/5.0 (compatible;
 * ...)`, which some sites and firewalls key on; a deployment that needs that
 * shape sets CRAWLER_USER_AGENT.
 *
 * `DEFAULT_USER_AGENT` is sent with every request the crawl worker makes and
 * with every robots.txt and sitemap fetch. `DEFAULT_ROBOTS_TOKEN` is the name
 * a site addresses us by in robots.txt (`User-agent: RapiderITBot`).
 */
export const DEFAULT_USER_AGENT = 'RapiderITBot/1.0 (+https://rapiderit.com/bot/)';
export const DEFAULT_ROBOTS_TOKEN = 'RapiderITBot';

const ROBOTS_TOKEN = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Refuse an identity a site operator could not act on: robots.txt rules are
 * matched against the token, so it has to be a plain product token, and it has
 * to appear in the User-Agent the site sees in its logs (RFC 9309, 2.2.1).
 */
export function assertIdentity({ userAgent, robotsToken }) {
  if (typeof userAgent !== 'string' || !userAgent.trim() || /[\r\n]/.test(userAgent)) {
    throw new Error('crawler identity: the user agent must be a non-empty single line');
  }
  if (typeof robotsToken !== 'string' || !ROBOTS_TOKEN.test(robotsToken)) {
    throw new Error(`crawler identity: robots token '${robotsToken}' must be letters, digits, '_' or '-', starting with a letter`);
  }
  if (!userAgent.toLowerCase().includes(robotsToken.toLowerCase())) {
    throw new Error(`crawler identity: robots token '${robotsToken}' does not appear in the user agent '${userAgent}'; set CRAWLER_USER_AGENT and CRAWLER_ROBOTS_TOKEN together`);
  }
}

export async function loadConfig(env = process.env) {
  const raw = JSON.parse(await readFile(path.join(here, '..', 'config', 'defaults.json'), 'utf8'));
  // Environment overrides exist for deployment (systemd and the Cloudflare
  // Worker set these); the file stays the single description of what the knobs
  // are.
  if (env.PORT) raw.server.port = Number(env.PORT);
  if (env.HOST) raw.server.host = env.HOST;
  if (env.ARTEFACT_ROOT) raw.server.artefactRoot = env.ARTEFACT_ROOT;
  if (env.JOB_ROOT) raw.server.jobRoot = env.JOB_ROOT;
  if (env.CONCURRENT_JOBS) raw.server.concurrentJobs = Number(env.CONCURRENT_JOBS);
  // Who the crawler says it is. Other products run this service under their
  // own name, so it is configuration rather than a constant.
  if (env.CRAWLER_USER_AGENT) raw.server.userAgent = env.CRAWLER_USER_AGENT;
  if (env.CRAWLER_ROBOTS_TOKEN) raw.server.robotsToken = env.CRAWLER_ROBOTS_TOKEN;
  // Sizing knobs a small host needs to tighten without editing the config file.
  if (env.ARTEFACT_TTL_DAYS) raw.gc.ttlDays = Number(env.ARTEFACT_TTL_DAYS);
  if (env.DISK_HIGH_WATER_PCT) raw.gc.diskHighWaterPct = Number(env.DISK_HIGH_WATER_PCT);
  if (env.ARTEFACT_BYTES_PER_JOB) raw.limits.artefactBytesPerJob = Number(env.ARTEFACT_BYTES_PER_JOB);
  if (env.MAX_PAGES_CEILING) raw.limits.maxPagesCeiling = Number(env.MAX_PAGES_CEILING);

  assertIdentity(raw.server);
  return raw;
}
