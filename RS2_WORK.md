Task: finish deploying the scrape-service browser-capture sidecar on the rapiderit.com RS2 host. The sidecar is installed, running, and verified. Two mounts were hand-added to the tenant config but are not yet live (404). You have RS2 admin credentials (role A) to complete the mount registration and run the acceptance checks.

Host: the rapiderit.com RS2 node (Ubuntu 26.04 aarch64, 4 GB RAM, 40 GB disk).

Already done — do not redo:

•  Sidecar installed at /opt/scrape-service, owned by scrape:scrape. System user scrape created (/var/lib/scrape-service, nologin).
•  npm ci + Playwright Chromium installed (v151.0.7922.34, arm64).
•  systemd unit /etc/systemd/system/scrape-sidecar.service — enabled, running, healthy. Binds loopback only (127.0.0.1:8081, confirmed via ss). Sizing overrides active: CONCURRENT_JOBS=1, ARTEFACT_TTL_DAYS=7, DISK_HIGH_WATER_PCT=70, ARTEFACT_BYTES_PER_JOB=1073741824, MAX_PAGES_CEILING=120.
•  Artefact layout differs from the HANDOFF: because /var/lib/rs2 is mode 700 (rs2-only) and opening it would expose data-store/.rs2-contacts to the browser process, artefacts live in a scrape-owned dir /var/lib/scrape-service/artefacts, bind-mounted onto /var/lib/rs2/data/.rs2-scrape (persisted in /etc/fstab). RS2's /scrape-runs file mount serves the bind-mounted path. Verified: rs2 user can traverse and read artefacts (644/755) through the mount; a real crawl through the systemd sidecar succeeded and artefacts were RS2-readable.
•  rs2 user added to scrape group (usermod -a -G scrape rs2).
•  Smoke test passed (SMOKE OK — 2-page example.com crawl, all artefacts verified, dedup + delete confirmed). Single-crawl peak memory: 887 MiB used, swap untouched.
•  Mounts hand-added to /etc/rs2/tenants/main.json (backup at main.json.bak.oz-*):
◦  /scrape → proxy, target: http://127.0.0.1:8081, access: {invoke:A, read:A, delete:A}
◦  /scrape-runs → file, store.root: .rs2-scrape, access: {read:A}

Ingress note: apache2 listens on :80 and proxies to RS2 at 127.0.0.1:3100; TLS is terminated upstream (AWS ALB). https://rapiderit.com/ → 200. Check apache2 config for whether /scrape and /scrape-runs paths are proxied to RS2 — if apache only forwards specific locations, add proxy rules for these two paths.

Step 1 — make the mounts live. The hand-edited mounts return 404. Preferred: register them via PUT /services/raw with If-Match (the HANDOFF's preferred path, which triggers lazy tenant rebuild). If that's not possible, determine how RS2 picks up tenant file changes (SIGHUP? file watcher?) and trigger it. Avoid restarting rs2.service unless unavoidable — it serves live client sites.

Step 2 — run the acceptance checklist (HANDOFF section 6). All security checks are mandatory. Use $TOKEN = a role-A admin bearer token for rapiderit.com.

```
# 1. SECURITY — unauthenticated access must be refused (401 or 403, NOT 200).

#    If either returns 200, the access block is wrong — stop and fix.

curl -s -o /dev/null -w '%{http_code}\n' https://rapaderit.com/scrape/health
curl -s -o /dev/null -w '%{http_code}\n' https://rapaderit.com/scrape-runs/

# 2. SECURITY — sidecar must not be publicly reachable.

ss -lntp | grep 8081        # expect 127.0.0.1:8081, NOT 0.0.0.0:8081

# 3. Authenticated health through RS2

curl -s -H "Authorization: Bearer $TOKEN" https://rapaderit.com/scrape/health | jq

# 4. SECURITY — SSRF guard. All four must be refused with 400 + typed error code at submit.

for u in "http://127.0.0.1:3100/" "http://169.254.169.254/" \
         "http://192.168.1.1/" "file:///etc/passwd"; do
  curl -s -X POST https://rapaderit.com/scrape/crawls \
    -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
    -d "{\"rootUrl\":\"$u\"}" | jq -c '.error'
done

# 5. Real crawl end to end

curl -s -X POST https://rapaderit.com/scrape/crawls \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"rootUrl":"https://example.com/","maxPages":3}' | jq

# poll until succeeded, then:

curl -s -H "Authorization: Bearer $TOKEN" \
  https://rapaderit.com/scrape-runs/<jobId>/crawl.json | jq '.crawl'

# 6. Ceilings error rather than clamp

curl -s -X POST https://rapaderit.com/scrape/crawls \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"rootUrl":"https://example.com/","maxPages":100000}' | jq -c '.error'

# expect field_exceeds_ceiling naming 120

# 7. Restart resilience — start a crawl, then mid-flight:

sudo systemctl restart scrape-sidecar

# re-poll the job: must be failed or requeued, never still "running"

# 8. Client sites unaffected — check a live site serves while a crawl runs, and:

free -h
```

Step 3 — report back (HANDOFF section 8): every acceptance check pass or fail (including security explicitly); peak memory during a crawl; disk used by artefacts after test crawls; the public base URL and role/token the pipeline should authenticate with. Do not report success on any check you skipped.