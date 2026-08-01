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
  jobs/queue.mjs        worker pool, per-domain token bucket, timeouts
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

- Bind **127.0.0.1 only**. RS2 is the sole ingress; a publicly reachable sidecar
  is an open SSRF proxy.
- Every caller-supplied URL passes `net/guard.mjs` — private and loopback ranges
  are rejected at submit time and re-checked at navigation time.
- `respectRobotsTxt` defaults on for *both* workers. The original scan path
  ignored robots entirely; that was defensible for a hand-picked local batch and
  is not defensible for a shared server.
