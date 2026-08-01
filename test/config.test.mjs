// Every `cfg.<key>` the workers read must exist in config/defaults.json.
//
// This exists because it didn't. The port from the pipeline dropped eight keys
// from the `scan` block, and the workers read config straight off `cfg` with no
// fallbacks — so `probeTimeoutMs` came through as undefined,
// `setTimeout(abort, undefined)` fired on the next tick, and every candidate
// site preflighted as `dead`. The job still returned 202, still succeeded, and
// still wrote artefacts, because "dead" is a legitimate outcome for a batch
// scan. Nothing failed loudly. Two of the other missing keys would have thrown
// a TypeError the moment preflight started working.
//
// A missing key here is never a smaller default; it is undefined behaviour.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const defaults = JSON.parse(await readFile(path.join(REPO_ROOT, 'config', 'defaults.json'), 'utf8'));

/**
 * Keys a worker legitimately gets from the job spec rather than the defaults
 * block, so their absence from defaults.json is correct.
 */
const FROM_SPEC = {
  crawl: new Set(['rootUrl']),
  scan: new Set(['candidates']),
};

/** Scrape `cfg.<key>` reads out of a worker's source. */
async function keysReadBy(worker) {
  const src = await readFile(path.join(REPO_ROOT, 'src', 'workers', `${worker}.mjs`), 'utf8');
  return new Set([...src.matchAll(/\bcfg\.([a-zA-Z_$][\w$]*)/g)].map((m) => m[1]));
}

for (const worker of ['crawl', 'scan']) {
  test(`every cfg key ${worker}.mjs reads is defined in defaults.json`, async () => {
    const read = await keysReadBy(worker);
    const defined = new Set(Object.keys(defaults[worker] ?? {}));

    const missing = [...read]
      .filter((k) => !defined.has(k))
      .filter((k) => !FROM_SPEC[worker].has(k))
      .sort();

    assert.deepEqual(
      missing,
      [],
      `${worker}.mjs reads cfg.{${missing.join(', ')}} but config/defaults.json's "${worker}" block does not define them. `
        + 'The workers have no fallbacks — add the keys rather than relying on undefined.',
    );
  });
}

test('scan timeouts are real numbers, not undefined or zero', () => {
  // The specific failure: setTimeout(fn, undefined) fires immediately, so an
  // undefined or zero timeout aborts every request before it can connect.
  for (const key of ['probeTimeoutMs', 'pageTimeoutMs', 'linkCheckTimeoutMs', 'siteBudgetMs']) {
    const value = defaults.scan[key];
    assert.equal(typeof value, 'number', `scan.${key} must be a number, got ${typeof value}`);
    assert.ok(value >= 1000, `scan.${key} is ${value}ms — too short to complete any real request`);
  }
});

test('every metadata field the workers read is one the extractor produces', async () => {
  // The same class of bug one layer down: scan.mjs read
  // `home.metadata.iconLinks`, which extract.mjs never emitted, so the favicon
  // probe threw for every site that got past preflight — after the pages were
  // captured, so the artefacts looked almost complete. Nothing caught it
  // because /scans has no end-to-end test.
  const extract = await readFile(path.join(REPO_ROOT, 'src', 'capture', 'extract.mjs'), 'utf8');

  // The `metadata` object literal is the extractor's contract.
  const block = extract.match(/const metadata = \{([\s\S]*?)\n {2}\};/);
  assert.ok(block, 'could not find the metadata object literal in extract.mjs');
  const produced = new Set([...block[1].matchAll(/^\s{4}([a-zA-Z_$][\w$]*):/gm)].map((m) => m[1]));

  for (const worker of ['crawl', 'scan']) {
    const src = await readFile(path.join(REPO_ROOT, 'src', 'workers', `${worker}.mjs`), 'utf8');
    const read = new Set([...src.matchAll(/\.metadata\.([a-zA-Z_$][\w$]*)/g)].map((m) => m[1]));
    const missing = [...read].filter((k) => !produced.has(k)).sort();
    assert.deepEqual(
      missing,
      [],
      `${worker}.mjs reads metadata.{${missing.join(', ')}} but extract.mjs does not produce them`,
    );
  }
});

test('scan list and shape config is populated, not empty', () => {
  // cfg.analyticsHosts.some(...) throws on undefined; cfg.pagePatterns drives
  // key-page discovery, so an empty list silently reduces every scan to the
  // home page only.
  assert.ok(Array.isArray(defaults.scan.analyticsHosts) && defaults.scan.analyticsHosts.length > 0);
  assert.ok(Array.isArray(defaults.scan.pagePatterns) && defaults.scan.pagePatterns.length > 0);
  for (const p of defaults.scan.pagePatterns) {
    assert.ok(p.group && p.pattern, 'each pagePattern needs a group and a pattern');
    assert.doesNotThrow(() => new RegExp(p.pattern), `pagePattern ${p.group} must compile`);
  }
  for (const vp of [defaults.scan.desktopViewport, defaults.scan.mobileViewport]) {
    assert.equal(typeof vp?.width, 'number');
    assert.equal(typeof vp?.height, 'number');
  }
});
