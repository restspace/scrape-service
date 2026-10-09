# scrape-service

Browser capture as an HTTP API: deep site crawl, batch shallow scan, and
screenshots. Runs as a **loopback-only sidecar** behind an RS2 `proxy` mount,
which supplies TLS, auth and the public hostname.

This is the single home for the capture code that used to live as
`crawl.mjs` and `scan.mjs` inside the `C:\info\websites` pipeline. That
pipeline now calls this service through thin client shims — there is no second
copy to keep in sync.

## Why a sidecar

RS2 cannot host a browser. Its `code:` JS services have no `fs`, no process
spawning and no DOM, and it has a 30s service / 120s pipeline wall clock with no
durable job queue. A 50-page crawl takes minutes. So this process owns the
browser *and* the job lifecycle; RS2 owns ingress.

## No LLM, no API keys

Capture is entirely deterministic — render the page, record what is there.
Nothing here calls a model, and the service holds no API credentials of any
kind. Interpretation (classifying pages, judging images, writing reports) stays
in the pipeline that calls this service. Image `role` and `identity` are emitted
as `null` on purpose, for that later stage to fill in.

## Layout

```
src/
  server.mjs            HTTP API, binds 127.0.0.1 only
  jobs/store.mjs        durable job records (atomic write+rename)
  config.mjs            defaults.json + environment overrides; the crawler's identity
  jobs/queue.mjs        worker pool: job slots, one job per domain at a time, timeouts
  jobs/politeness.mjs   per-domain request rate inside one job
  jobs/gc.mjs           TTL sweep + disk high-water mark
  capture/browser.mjs   chromium launch, desktop + mobile contexts
  capture/extract.mjs   the single in-page extractor
  capture/settle.mjs    anti-lazy-load ritual (delayed-JS bundles)
  capture/robots.mjs    robots.txt + sitemap discovery
  workers/crawl.mjs     deep single-site capture
  workers/scan.mjs      batch shallow scan
  workers/shot.mjs      single-URL screenshot
  net/guard.mjs         SSRF guard
config/defaults.json    all tunables, including the hard server-side ceilings
test/parity.mjs         diff a run against the golden fixtures
deploy/                 systemd unit
```

## Running locally

```
npm ci
npx playwright install chromium      # --with-deps on Linux
npm start                            # 127.0.0.1:8081
```

Running it locally is also the supported escape hatch for the pipeline when the
server is unreachable: point the client shims at `127.0.0.1:8081`. Same code,
still no fork.

## API

Public base is `https://<host>/scrape` (RS2 proxy). RS2 strips the mount prefix
before forwarding, so the sidecar's own routes live at the root
(`http://127.0.0.1:8081/crawls`); it also accepts the `/scrape` prefix so a
direct curl can use the same path as the public URL.

| Method | Path | Purpose |
|---|---|---|
| GET | `/scrape/health` | readiness, chromium version, queue depth, disk free |
| POST | `/scrape/crawls` | start a deep crawl → `202 {jobId}` |
| GET | `/scrape/crawls/{id}` | status + progress + result summary |
| GET | `/scrape/crawls/{id}/log` | crawl log tail (text/plain) |
| GET | `/scrape/crawls` | paged job list |
| DELETE | `/scrape/crawls/{id}` | cancel if running, then purge artefacts |
| POST | `/scrape/scans` | batch shallow scan over candidates |
| GET | `/scrape/scans/{id}` | rollup + per-site outcomes |
| POST | `/scrape/shots` | single-URL screenshot |

Artefacts are written straight to disk under `artefactRoot` and served by a
separate RS2 `file` mount at `/scrape-runs/<jobId>/` — this service never
uploads them. The tree shape is identical to what the original CLIs produced,
which is what lets the pipeline consume it unchanged.

## Parity

The regression this guards against is a code change silently altering what the
crawler extracts — a count quietly dropping to zero, a page slug disappearing.
So: record a baseline, change something, compare.

```bash
cp test/parity-sites.example.json test/parity-sites.json   # point it at your sites
npm run parity:record                                       # capture a baseline
# ... change capture code ...
npm run parity                                              # compare
```

It diffs structure, slugs, counts, skipped reasons and artefact presence, and
ignores timestamps, `crawlDate` and PNG bytes. Drift on live sites is reported
separately from failures, because real sites change under you.

**Neither the baseline nor the site list is committed** — they are captures of,
and pointers to, third-party business websites, and this repository is public.
Both are gitignored; generate them locally.

Choose sites that exercise different paths rather than three similar ones: one
small enough to fit under the page cap, one large enough to be truncated by it
(which is what tests the tiered frontier), and one with neither robots.txt nor a
sitemap.

## Operational notes

- Bind **127.0.0.1 only** on a shared host. RS2 is the sole ingress; a publicly
  reachable sidecar is an open SSRF proxy. (In the Cloudflare Container it binds
  0.0.0.0, but the container is reachable only through the fronting Worker,
  which demands a bearer token only RS2 holds.)
- Every caller-supplied URL passes `net/guard.mjs` — private and loopback ranges
  are rejected at submit time and re-checked at navigation time.
- `respectRobotsTxt` defaults on for *both* workers. The original scan path
  ignored robots entirely; that was defensible for a hand-picked local batch and
  is not defensible for a shared server.

## Who the crawler says it is

Every desktop page request the crawl worker makes, and every `robots.txt` and
sitemap fetch by either worker, carries:

```
RapiderITBot/1.0 (+https://rapiderit.com/bot/)
```

and `robots.txt` is read as the crawler `RapiderITBot`. A group addressed to
that name (any case, with or without a version) is obeyed and replaces the
`User-agent: *` group, as RFC 9309 specifies; with no such group the `*` rules
apply. Inside the chosen group only `Disallow` is interpreted, as a path prefix:
`Allow`, wildcards and `Crawl-delay` are not, so the crawler can only stay away
from more than it was asked to. The request rate is the fixed per-domain
interval in `config/defaults.json` (`politeness`).

The scan worker differs in one respect, and has since it was ported: it checks
`robots.txt` under the identity above, but it loads pages with a desktop Chrome
and an iPhone Safari user agent, because it records how a site presents itself
to an ordinary visitor on each. Its plain-HTTP reachability and link probes say
`ProspectScanBot/1.0`. Only the crawl worker presents the identity on page
requests, and only on its desktop pass: when `captureMobile` is on, the mobile
pass re-visits the same pages under Playwright's iPhone 13 emulation, whose
user agent is mobile Safari's.

The identity is configuration, because other products run this service under
their own name: `server.userAgent` and `server.robotsToken` in
`config/defaults.json`, overridden by `CRAWLER_USER_AGENT` and
`CRAWLER_ROBOTS_TOKEN`. Set both together; the service refuses to start if the
token does not appear in the user agent, since a site could then not address the
crawler it sees in its logs. `GET /health` reports the identity in use.

## Concurrency

`CONCURRENT_JOBS` (`server.concurrentJobs`) is the number of jobs run at once,
each in its own child process with its own Chromium. Jobs beyond that wait in
submission order. What holds with more than one slot:

- **One job per domain.** A job is held back while another job is running
  against any of its domains (a crawl's root and `allowedDomains`, every
  candidate of a scan), and later jobs for other domains go ahead of it. The
  per-domain rate limit lives inside each job's process, so this is what keeps a
  site from being crawled at double the rate. It works from the job spec: a root
  URL that redirects to a domain another job is crawling is not detected.
- **Dedupe is atomic.** Identical requests arriving together create one job.
- **Disk.** Each running job may hold up to `ARTEFACT_BYTES_PER_JOB` on local
  disk, so allow `CONCURRENT_JOBS` times that, plus anything not yet evicted.
- **Memory.** One crawl was measured peaking at 887 MiB.
- **Recovery.** Jobs that were running when the process died are all requeued
  on the next boot and run together again, up to two attempts each.
- **One process.** All of the above is in-process state. Running two instances
  of the service against the same store is not supported.

## Cloudflare deployment

Production runs as a [Cloudflare Container](https://developers.cloudflare.com/containers/)
behind a small fronting Worker (`deploy/cloudflare/`), with job records and
artefacts in R2. The instance sleeps after ten idle minutes, so an idle month
costs nothing beyond the Workers Paid plan.

```
RS2 /scrape (proxy, injects bearer) ─▶ scrape-service Worker (checks bearer)
                                        └▶ ScrapeContainer "main" (this image)
                                             └▶ R2 rs2-files
                                                  _scrape/jobs/<id>.json
                                                  main/.rs2-scrape/<id>/…  ◀─ RS2 /scrape-runs
```

What changes when the `R2_*` variables are set (`src/jobs/remote.mjs`):

- Every job record is mirrored to R2, so a job outlives the instance that ran it
  and a restarted instance recovers it. Running jobs are tied to a `bootId`, so a
  recycled pid in a new container is never mistaken for the old worker.
- A finished job's artefact tree is uploaded before its terminal status is
  written, then evicted from local disk. A failed upload turns `succeeded` into
  `failed` with `artefact_upload_failed` rather than pointing clients at nothing.
- Reads of records, manifests, files and logs fall back to R2.
- Disk-pressure GC evicts only local copies. Retention in R2 is two bucket
  lifecycle rules (seven days on each prefix above).

With no `R2_*` variables the service is disk-only, exactly as before.

The container is a `standard-2` instance (1 vCPU, 6 GiB memory, 12 GB disk) and
runs two jobs at once; `CONCURRENT_JOBS` on the Worker overrides the number.
The two settings are sized together: see the comments in
`deploy/cloudflare/wrangler.jsonc` and `deploy/cloudflare/src/index.js`.

The Worker vetoes sleep while the service reports active or queued jobs
(`onActivityExpired` probes `/health`), so a long crawl with nobody polling is
not killed. The first request after a sleep pays a cold start of up to about
twenty seconds.

Deploy, from `deploy/cloudflare/` (Docker must be running; it builds the image):

```
npm ci
npx wrangler deploy
# once, or to rotate:
npx wrangler secret put SCRAPE_TOKEN          # bearer RS2 injects
npx wrangler secret put R2_ACCOUNT_ID
npx wrangler secret put R2_ACCESS_KEY_ID      # R2 token: Object Read & Write, rs2-files only
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler r2 bucket lifecycle add rs2-files scrape-artefacts-7d main/.rs2-scrape/ --expire-days 7
npx wrangler r2 bucket lifecycle add rs2-files scrape-jobs-7d _scrape/jobs/ --expire-days 7
```

The Dockerfile's Playwright base image tag must match the `playwright` version in
`package-lock.json`, or Chromium and the npm package disagree.
