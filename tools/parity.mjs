#!/usr/bin/env node
// Parity check: does a change to the capture code alter what it extracts?
//
// Record a baseline, change something, compare. The comparison covers page
// slugs, per-page counts, skipped reasons, artefact file presence,
// asset-manifest size, and the crawl index's structural fields.
//
// What is deliberately NOT compared: timestamps, crawlDate, PNG bytes, and the
// exact text of live pages — the sites are real and change under us. A count
// that drifts by a page's worth of content is a site edit; a count that drops
// to zero, or a slug that disappears, is a regression.
//
// Neither the baseline nor the site list is committed. Both are captures of, or
// pointers to, third-party business websites, and this is a public repository.
// `test/parity-sites.example.json` shows the format; copy it to
// `test/parity-sites.json` and put your own sites in it.
//
// This lives in tools/ rather than test/ on purpose: Node treats every file
// under a `test/` directory as a unit test, and this one drives real browsers
// against real websites for minutes at a time. It is run deliberately
// (`npm run parity`), never as part of `npm test`.
//
// Usage:
//   node tools/parity.mjs --record                    # capture the baseline
//   node tools/parity.mjs                             # compare against it
//   node tools/parity.mjs [--fixture <slug>] [--tolerance 0.15] [--out <dir>]

import { readFile, readdir, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCrawl } from '../src/workers/crawl.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(here, '..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'test', 'fixtures', 'golden');
const SITES_FILE = path.join(REPO_ROOT, 'test', 'parity-sites.json');

const args = process.argv.slice(2);
const opt = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const k = args[i].slice(2);
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) opt[k] = true;
    else { opt[k] = v; i++; }
  }
}
const TOLERANCE = Number(opt.tolerance ?? 0.15);

/**
 * The sites to crawl, from a local (gitignored) file. Kept out of the repo
 * because a list of real businesses' URLs is not ours to publish, even without
 * their content attached.
 */
async function loadSites() {
  try {
    return JSON.parse(await readFile(SITES_FILE, 'utf8')).sites;
  } catch {
    console.error(`No site list at ${SITES_FILE}.`);
    console.error('');
    console.error('Copy the example and edit it to point at sites you are entitled to crawl:');
    console.error('  cp test/parity-sites.example.json test/parity-sites.json');
    console.error('');
    console.error('Pick a spread that exercises the crawler: one small site that fits under');
    console.error('the page cap, one large enough to be truncated by it (which tests the');
    console.error('tiered frontier), and one with neither robots.txt nor a sitemap.');
    process.exit(2);
  }
}

const PER_PAGE_FILES = [
  'metadata.json', 'headings.json', 'links.json', 'images.json', 'forms.json',
  'buttons.json', 'structured-data.json', 'accessibility-tree.json',
  'visible-text.json', 'blocks.json', 'readable.md', 'content.html',
];

const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));

function near(actual, expected, tolerance = TOLERANCE) {
  if (expected === 0) return actual === 0;
  return Math.abs(actual - expected) / expected <= tolerance;
}

async function compare(slug, fixtureDir, freshDir) {
  const fails = [];
  const warns = [];
  const note = (list, msg) => list.push(`${slug}: ${msg}`);

  const before = await readJson(path.join(fixtureDir, 'crawl.json'));
  const after = await readJson(path.join(freshDir, 'crawl.json'));

  // --- structural fields that must match exactly ---
  if (after.schemaVersion !== before.schemaVersion) {
    note(fails, `schemaVersion ${after.schemaVersion} != ${before.schemaVersion}`);
  }
  for (const k of ['rootUrl', 'allowedDomains']) {
    if (JSON.stringify(after.source[k]) !== JSON.stringify(before.source[k])) {
      note(fails, `source.${k} changed: ${JSON.stringify(after.source[k])} != ${JSON.stringify(before.source[k])}`);
    }
  }
  for (const k of ['maxPages', 'robotsTxtFound', 'sitemapXmlFound', 'captureMobile', 'captureDesktop']) {
    if (after.crawl[k] !== before.crawl[k]) {
      note(fails, `crawl.${k} changed: ${after.crawl[k]} != ${before.crawl[k]}`);
    }
  }
  if (after.crawl.pagesCrawled !== before.crawl.pagesCrawled) {
    note(fails, `pagesCrawled ${after.crawl.pagesCrawled} != ${before.crawl.pagesCrawled}`);
  }

  // --- the page set: same slugs, same order-independent membership ---
  const beforeSlugs = before.pages.map((p) => p.slug).sort();
  const afterSlugs = after.pages.map((p) => p.slug).sort();
  const missing = beforeSlugs.filter((s) => !afterSlugs.includes(s));
  const extra = afterSlugs.filter((s) => !beforeSlugs.includes(s));
  if (missing.length) note(fails, `pages missing: ${missing.join(', ')}`);
  if (extra.length) note(fails, `pages unexpected: ${extra.join(', ')}`);

  // --- skip reasons must be the same kinds ---
  const reasonSet = (idx) => [...new Set(idx.skipped.map((s) => s.reason))].sort().join(',');
  if (reasonSet(after) !== reasonSet(before)) {
    note(fails, `skip reasons changed: [${reasonSet(after)}] != [${reasonSet(before)}]`);
  }

  // --- per-page counts, within tolerance (live sites drift) ---
  const beforeByslug = new Map(before.pages.map((p) => [p.slug, p]));
  for (const p of after.pages) {
    const b = beforeByslug.get(p.slug);
    if (!b) continue;
    for (const key of Object.keys(b.counts)) {
      const bv = b.counts[key];
      const av = p.counts[key];
      // Zero where there used to be many is the regression this whole check exists to catch.
      if (bv > 0 && av === 0) {
        note(fails, `${p.slug}.counts.${key} collapsed to 0 (was ${bv})`);
      } else if (!near(av, bv)) {
        note(warns, `${p.slug}.counts.${key} ${av} vs ${bv} (>${Math.round(TOLERANCE * 100)}% drift)`);
      }
    }
    // every artefact file must exist
    for (const f of PER_PAGE_FILES) {
      if (!existsSync(path.join(freshDir, 'pages', p.slug, f))) {
        note(fails, `${p.slug}: missing artefact ${f}`);
      }
    }
  }

  // --- assets manifest ---
  const beforeAssets = await readJson(path.join(fixtureDir, 'assets', 'manifest.json'));
  const afterAssets = await readJson(path.join(freshDir, 'assets', 'manifest.json'));
  if (beforeAssets.assets.length > 0 && afterAssets.assets.length === 0) {
    note(fails, `asset manifest collapsed to 0 (was ${beforeAssets.assets.length})`);
  } else if (!near(afterAssets.assets.length, beforeAssets.assets.length)) {
    note(warns, `assets ${afterAssets.assets.length} vs ${beforeAssets.assets.length}`);
  }
  // role must stay null — it is the LLM stage's job, and a well-meaning
  // "improvement" that starts guessing here would poison the whole pipeline.
  if (afterAssets.assets.some((a) => a.role !== null)) {
    note(fails, 'asset manifest has non-null role — classification must stay with the LLM stage');
  }

  return { fails, warns };
}

/**
 * Capture a baseline for each configured site.
 *
 * Fixtures are generated locally rather than committed: they are full captures
 * of third-party business websites, which is not something to publish in a
 * public repository. The trade-off is that a fresh clone has no baseline until
 * it makes one, so the first run records rather than compares.
 *
 * That still catches what matters. The regression this guards against is a
 * change to the capture code altering what it extracts — so a baseline taken
 * before your change and compared after it is exactly the right test, and is
 * what `--record` then `npm run parity` gives you.
 */
async function record(sites) {
  const defaults = JSON.parse(await readFile(path.join(REPO_ROOT, 'config', 'defaults.json'), 'utf8')).crawl;
  await mkdir(FIXTURE_ROOT, { recursive: true });

  for (const site of sites) {
    const slug = site.slug;
    process.stdout.write(`\n=== ${slug} — recording baseline from ${site.rootUrl} (maxPages=${site.maxPages})\n`);
    await rm(path.join(FIXTURE_ROOT, slug), { recursive: true, force: true });
    await runCrawl(
      { rootUrl: site.rootUrl, maxPages: site.maxPages },
      {
        outDir: path.join(FIXTURE_ROOT, slug),
        defaults,
        onProgress: (e) => { if (e.type === 'log') process.stdout.write(`  ${e.message}\n`); },
      },
    );
  }
  console.log(`\nBaseline recorded at ${FIXTURE_ROOT}`);
  console.log('It is gitignored on purpose — it holds captured third-party site content.');
  console.log('Re-run `npm run parity` after a code change to compare against it.');
}

async function main() {
  if (opt.record) {
    let sites = await loadSites();
    if (opt.fixture) sites = sites.filter((s) => s.slug === opt.fixture);
    if (!sites.length) {
      console.error(opt.fixture ? `no site with slug '${opt.fixture}'` : 'site list is empty');
      process.exit(2);
    }
    await record(sites);
    return;
  }

  let fixtures = [];
  try {
    fixtures = (await readdir(FIXTURE_ROOT, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch { /* no baseline yet */ }
  if (opt.fixture) fixtures = fixtures.filter((f) => f === opt.fixture);

  if (!fixtures.length) {
    console.error(`No baseline under ${FIXTURE_ROOT}.`);
    console.error('');
    console.error('Fixtures are not committed — they are captures of third-party websites.');
    console.error('Record a baseline first (this crawls real sites and takes a few minutes):');
    console.error('');
    console.error('  npm run parity:record');
    console.error('');
    console.error('Then re-run `npm run parity` after changing capture code to compare.');
    process.exit(2);
  }

  const workRoot = opt.out ? path.resolve(opt.out) : await mkdtemp(path.join(tmpdir(), 'parity-'));
  const allFails = [];
  const allWarns = [];

  for (const slug of fixtures) {
    const fixtureDir = path.join(FIXTURE_ROOT, slug);
    const before = await readJson(path.join(fixtureDir, 'crawl.json'));
    const freshDir = path.join(workRoot, slug);

    process.stdout.write(`\n=== ${slug} — recrawling ${before.source.rootUrl} (maxPages=${before.crawl.maxPages})\n`);
    const defaults = JSON.parse(await readFile(path.join(here, '..', 'config', 'defaults.json'), 'utf8')).crawl;

    await runCrawl(
      {
        rootUrl: before.source.rootUrl,
        maxPages: before.crawl.maxPages,
        captureMobile: before.crawl.captureMobile,
        captureDesktop: before.crawl.captureDesktop,
      },
      {
        outDir: freshDir,
        defaults,
        onProgress: (e) => { if (e.type === 'log') process.stdout.write(`  ${e.message}\n`); },
      },
    );

    const { fails, warns } = await compare(slug, fixtureDir, freshDir);
    allFails.push(...fails);
    allWarns.push(...warns);
  }

  console.log('\n' + '='.repeat(60));
  if (allWarns.length) {
    console.log(`\nDRIFT (site content changed since capture — review, do not necessarily act):`);
    for (const w of allWarns) console.log(`  ~ ${w}`);
  }
  if (allFails.length) {
    console.log(`\nPARITY FAILURES:`);
    for (const f of allFails) console.log(`  x ${f}`);
    console.log(`\n${allFails.length} failure(s). Work kept at ${workRoot}`);
    process.exit(1);
  }
  console.log(`\nPARITY OK — ${fixtures.length} fixture(s), ${allWarns.length} drift note(s).`);
  if (!opt.out) await rm(workRoot, { recursive: true, force: true });
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
