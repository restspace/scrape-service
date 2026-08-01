# Deploying the capture sidecar on the rapiderit.com host

**Audience:** an agent with shell access on the Linux box that runs the
rapiderit.com RS2 node. You are installing a new service alongside RS2 and
adding two mounts to its tenant config.

**Host budget you are working within: 4 GB RAM, 40 GB disk — shared with the
RS2 node that serves live client sites.** That constraint drives most of the
non-obvious choices below. Do not raise the limits to "make it faster" without
measuring; the failure mode is a client site going down, not a slow crawl.

---

## 0. What this is, in one paragraph

`scrape-service` runs a headless Chromium and exposes browser capture (deep site
crawl, batch shallow scan) as an HTTP job API. RS2 cannot host a browser — its
sandboxed JS services have no `fs`, no process spawning and no DOM, and it has a
30 s service / 120 s pipeline wall clock with no durable job queue, while a crawl
takes minutes. So the sidecar owns the browser and the job lifecycle; RS2 owns
ingress, TLS and auth via a `proxy` mount. The sidecar binds loopback only.

It holds **no API keys and calls no model.** Capture is deterministic. If you
find yourself configuring a credential for it, something is wrong.

---

## 1. Preconditions — check before you install anything

Run these first. If any check fails, **stop and report rather than working
around it.**

```bash
# OS, arch, kernel
cat /etc/os-release; uname -m

# Node must be >= 22 (the code uses node: builtins and modern syntax throughout)
node --version || echo "NO NODE"

# Memory: 4 GB total is the stated budget. What matters is what is FREE with
# RS2 already running, and whether there is swap to absorb a Chromium spike.
free -h

# Disk: 40 GB total. Check the filesystem that will hold artefacts.
df -h /

# What RS2 is and where it lives — do not assume paths, discover them.
systemctl status rs2 --no-pager 2>/dev/null || systemctl list-units --type=service | grep -i rs2
```

**Hard stops:**

| Condition | Action |
|---|---|
| Node < 22 | Stop. Install Node 22+ first; do not try to transpile. |
| No swap configured | Stop and report. On 4 GB, Chromium OOM-kills are the single most likely failure. 2 GB of swap makes the difference between a slow crawl and a dead one. |
| Free disk < 10 GB | Stop and report. Artefacts need room; filling this disk takes client sites down with it. |
| RS2 not found / not running | Stop. This service is useless without its ingress, and you should not be guessing at the host's layout. |

**Discover, never assume, these three values.** They differ per host and every
later step depends on them:

```bash
# 1. Where is RS2's serverConfig.json?
find / -name serverConfig.json -not -path '*/node_modules/*' 2>/dev/null

# 2. From it: fileRoot (artefacts live under this) and tenantsDir
cat <path>/serverConfig.json

# 3. Which tenant serves rapiderit.com, and what does it already mount?
ls <tenantsDir>/ && cat <tenantsDir>/<tenant>.json
```

Record: `RS2_DIR`, `FILE_ROOT` (resolved absolute — relative paths in
serverConfig resolve against the serverConfig's own directory, **not** cwd),
`TENANT_FILE`, and the user RS2 runs as.

---

## 2. Sizing for this host

The repo's `config/defaults.json` is tuned for a roomier machine. Override via
environment in the systemd unit — do not edit the config file, so the defaults
stay meaningful and your overrides are visible in one place.

| Setting | Repo default | **Use here** | Why |
|---|---|---|---|
| `CONCURRENT_JOBS` | 2 | **1** | Each job runs a Chromium with desktop + mobile contexts: roughly 400–700 MB peak. Two at once is ~1.4 GB before RS2, the OS and page cache. On 4 GB that is where OOM lives. |
| `ARTEFACT_TTL_DAYS` | 14 | **7** | 40 GB shared with client sites. A 50-page crawl with full-page screenshots is 50–150 MB; two weeks of accumulation is real money on this disk. |
| `DISK_HIGH_WATER_PCT` | 85 | **70** | The eviction trigger must fire long before the disk that serves client sites is in trouble. 85% on a 40 GB disk leaves only 6 GB of headroom. |
| `ARTEFACT_BYTES_PER_JOB` | 2 GB | **1 GB** (`1073741824`) | Enforced every 30 s while a job runs; a runaway crawl is killed rather than allowed to fill the disk. |
| `MAX_PAGES_CEILING` | 200 | **120** | A 200-page crawl on this box is a long single-threaded job holding a Chromium the whole time. Raise later if it proves comfortable. |

Everything else can stay at its default.

---

## 3. Install

```bash
# Dedicated unprivileged user — this process drives a browser against arbitrary
# third-party websites and should own nothing it does not need.
sudo useradd --system --create-home --home-dir /var/lib/scrape-service --shell /usr/sbin/nologin scrape

sudo mkdir -p /opt/scrape-service
# Copy the repo to /opt/scrape-service (git clone, rsync, or scp — whatever this
# host normally uses). Then:
cd /opt/scrape-service
sudo -u scrape npm ci --omit=dev

# System libraries for Chromium. --with-deps is what makes this work on a bare
# server; without it Chromium installs and then fails to launch on a missing .so.
sudo npx playwright install-deps chromium
sudo -u scrape npx playwright install chromium
```

Create the artefact and job directories. **The artefact root must be the
directory the RS2 `/scrape-runs` file mount will serve** — that is the whole
point of the shared-disk design, and nothing is copied or uploaded:

```bash
sudo mkdir -p "$FILE_ROOT/.rs2-scrape" /var/lib/scrape-service/jobs
sudo chown -R scrape:scrape "$FILE_ROOT/.rs2-scrape" /var/lib/scrape-service

# RS2 must be able to READ what the sidecar writes. If RS2 runs as a different
# user, add it to the scrape group rather than making anything world-readable:
sudo usermod -a -G scrape <rs2-user>
sudo chmod 750 "$FILE_ROOT/.rs2-scrape"
```

Install the unit from `deploy/scrape-sidecar.service`, **editing the paths and
the sizing environment to match what you discovered**:

```ini
Environment=HOST=127.0.0.1
Environment=PORT=8081
Environment=ARTEFACT_ROOT=<FILE_ROOT>/.rs2-scrape
Environment=JOB_ROOT=/var/lib/scrape-service/jobs
Environment=CONCURRENT_JOBS=1
Environment=ARTEFACT_TTL_DAYS=7
Environment=DISK_HIGH_WATER_PCT=70
Environment=ARTEFACT_BYTES_PER_JOB=1073741824
Environment=MAX_PAGES_CEILING=120
```

`ReadWritePaths` in the unit must list both `<FILE_ROOT>/.rs2-scrape` and
`/var/lib/scrape-service`, or `ProtectSystem=strict` will make every write fail.

```bash
sudo cp deploy/scrape-sidecar.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now scrape-sidecar
sudo systemctl status scrape-sidecar --no-pager
```

**`HOST=127.0.0.1` is not a preference.** This service fetches
caller-supplied URLs. Publicly reachable, it is an open SSRF proxy into your
private network. RS2 is the only ingress.

---

## 4. Verify the sidecar before touching RS2

```bash
curl -s localhost:8081/health | jq
```

Expect `ok: true`, a real `chromiumVersion`, and `diskUsedPct` well under 70.
If `ok` is false, Chromium cannot launch — that is a missing system library,
and `sudo npx playwright install-deps chromium` is the fix, not a retry.

Then one real crawl, entirely local:

```bash
sudo -u scrape node tools/smoke.mjs --max 2
```

This submits a job, waits for the worker to spawn, and checks the artefacts
landed. It must print `SMOKE OK`. Watch memory while it runs (`free -h` in
another shell) — this is your one cheap chance to see what a single job actually
costs on this host before real traffic arrives.

---

## 5. Add the RS2 mounts

Two mounts on the rapiderit tenant. Prefer `PUT /services/raw` with `If-Match`
for optimistic concurrency over editing the tenant file by hand; tenants rebuild
lazily, so no restart is needed. See
`docs/manual/part-10-operating-a-node/10.4-editing-config-safely.md` in the RS2
repo.

```json
{ "path": "/scrape", "service": "proxy",
  "config": {
    "access": { "invoke": "A", "read": "A", "delete": "A" },
    "target": "http://127.0.0.1:8081",
    "description": "Browser capture API — crawl, batch scan and screenshot jobs." } }

{ "path": "/scrape-runs", "service": "file",
  "config": {
    "access": { "read": "A" },
    "store": { "adapter": "builtin:local", "root": ".rs2-scrape" },
    "description": "Capture artefacts: crawl.json, per-page JSON, screenshots." } }
```

Notes that will bite if ignored:

- **Method → permission** is POST→`invoke`, GET→`read`, DELETE→`delete`. A mount
  with no `access` block is unreachable (fail-closed), so all three are needed.
- **Never `access: "open"`.** These are third-party screenshots plus a fetcher
  that takes caller-supplied URLs. `A` is the existing admin role; a dedicated
  role is better if the tenant already has a suitable one.
- RS2 **strips the mount prefix** before forwarding: `/scrape/crawls` arrives at
  the sidecar as `/crawls`. This is expected — the sidecar serves routes at the
  root and also tolerates the `/scrape` prefix.
- The file mount is **read-only on purpose**. The sidecar writes via the
  filesystem; RS2 never writes there.
- `store.root` is relative to `fileRoot`, matching the existing `/html` mount's
  pattern.

---

## 6. Acceptance checklist

Do all of these. The security ones are not optional.

```bash
# 1. SECURITY — unauthenticated access must be refused. If either returns 200,
#    the access block is wrong. Stop and fix before going further.
curl -s -o /dev/null -w '%{http_code}\n' https://rapiderit.com/scrape/health
curl -s -o /dev/null -w '%{http_code}\n' https://rapiderit.com/scrape-runs/
# expect 401 or 403 for both

# 2. SECURITY — the sidecar must not be reachable from outside.
ss -lntp | grep 8081        # expect 127.0.0.1:8081, NOT 0.0.0.0:8081

# 3. Authenticated health through RS2
curl -s -H "Authorization: Bearer $TOKEN" https://rapiderit.com/scrape/health | jq

# 4. SECURITY — SSRF guard. All four must be refused with a 400 and a typed
#    error code, at submit time.
for u in "http://127.0.0.1:3100/" "http://169.254.169.254/" \
         "http://192.168.1.1/" "file:///etc/passwd"; do
  curl -s -X POST https://rapiderit.com/scrape/crawls \
    -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d "{\"rootUrl\":\"$u\"}" | jq -c '.error'
done

# 5. A real crawl end to end
curl -s -X POST https://rapiderit.com/scrape/crawls \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"rootUrl":"http://www.fdca.co.uk","maxPages":3}' | jq
# poll until succeeded, then:
curl -s -H "Authorization: Bearer $TOKEN" \
  https://rapiderit.com/scrape-runs/<jobId>/crawl.json | jq '.crawl'

# 6. Ceilings error rather than clamp
curl -s -X POST https://rapiderit.com/scrape/crawls \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"rootUrl":"https://example.com/","maxPages":100000}' | jq -c '.error'
# expect field_exceeds_ceiling naming 120, proving your override took effect

# 7. Restart resilience — a job must never be left stuck in "running"
#    Start a crawl, then mid-flight:
sudo systemctl restart scrape-sidecar
#    Re-poll the job: it must be failed or requeued, never still "running".

# 8. Client sites are unaffected — check a live site still serves while a crawl
#    is in flight, and watch memory:
free -h
```

**Optional: the parity suite.** Baselines are not committed (they are captures
of third-party sites), so this only helps if you have a site list to point it
at. If you do, it is a good way to confirm this host's Chromium behaves like the
machine the code was developed on:

```bash
cp test/parity-sites.example.json test/parity-sites.json   # edit to real sites
sudo -u scrape npm run parity:record                        # ~15 min
```

Recording alone proves the crawler works end to end here. To compare against the
development machine's numbers, ask for its baseline rather than re-deriving one.
Skip this if you have no site list — `tools/smoke.mjs` in step 4 already covers
"does capture work on this host".

---

## 7. If something goes wrong

| Symptom | Cause and fix |
|---|---|
| `/health` returns `ok: false` | Chromium cannot launch. `sudo npx playwright install-deps chromium`. Check `journalctl -u scrape-sidecar` for the missing library. |
| Service restart-loops | Usually the above, or `ReadWritePaths` missing a directory so every write fails. The unit has `StartLimitBurst=5` so it stops thrashing and shows in `systemctl status`. |
| Jobs fail with `worker_lost` | The worker died — most likely OOM on this 4 GB box. Check `dmesg -T | grep -i oom`. Confirm `CONCURRENT_JOBS=1` and that swap exists. |
| Jobs fail `artefact_cap_exceeded` | Working as designed: a crawl exceeded 1 GB of artefacts and was killed. Reduce `maxPages` for that site rather than raising the cap. |
| `capability_denied` from RS2 | The proxy mount's `target` is wrong, or you added an `httpOut` grant it does not need — a `proxy` mount's `target` *is* its allowlist. |
| 404 through RS2, 200 on loopback | Prefix confusion. RS2 strips `/scrape`; confirm the mount `path` and that you are calling `/scrape/crawls`, not `/scrape/scrape/crawls`. |
| Disk filling anyway | Check GC is running: `journalctl -u scrape-sidecar | grep gc:`. It logs when it evicts and when it *cannot* ("nothing evictable"). |

**Rollback is clean** — nothing here modifies RS2's existing behaviour:

```bash
sudo systemctl disable --now scrape-sidecar
# remove the two mounts from the tenant config
# artefacts, if you want the space back:
sudo rm -rf "$FILE_ROOT/.rs2-scrape"
```

---

## 8. After deployment — report back

The machine at `C:\info\websites` still declares `playwright` in two skill
`package.json` files and cannot drop it until this service is confirmed working.
Report:

1. Every acceptance check, pass or fail — including the security ones explicitly.
2. Peak memory observed during a single crawl (`free -h` during smoke/parity).
3. Disk used by artefacts after the test crawls, so the TTL can be tuned from
   evidence rather than guesswork.
4. The public base URL and the role/token the pipeline should authenticate with.

**Do not** report success on any check you skipped. A skipped security check
reported as passing is worse than a failed deployment.

---

## Appendix: what this service will not do

Deliberate scope limits, so you do not go looking for missing features:

- **No LLM, no API keys.** Interpretation (classifying pages, judging images,
  writing reports) stays in the pipeline that calls this.
- **No Google Places, Companies House, RDAP or DNS custody lookups.** Those
  stayed local with their keys.
- **`respectRobotsTxt: false` is refused** unless an operator sets
  `allowRobotsOverride`. Both the crawl and scan paths honour robots.
- **`/shots` returns 501.** The screenshot endpoint is routed but has no worker
  yet; that is explicit, not a bug.
