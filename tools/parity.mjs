#!/usr/bin/env node
// Parity check: does the ported crawler still produce what the original did?
//
// The fixtures in test/fixtures/golden were captured with the pipeline's
// crawl.mjs immediately before the code moved. This re-crawls the same sites
// through the ported worker and compares the trees.
//
// What is compared: page slugs, per-page counts, skipped reasons, artefact file
// presence, asset-manifest size, and the crawl index's structural fields.
// What is deliberately NOT compared: timestamps, crawlDate, PNG bytes, and the
// exact text of live pages — the sites are real and change under us. A count
// that moves by a page's worth of content is a site edit; a count that moves to
// zero, or a slug that disappears, is a regression.
//
// This lives in tools/ rather than test/ on purpose: Node treats every file
// under a `test/` directory as a unit test, and this one drives real browsers
// against real websites for minutes at a time. It is run deliberately
// (`npm run parity`), never as part of `npm test`.
//
// Usage:
//   node tools/parity.mjs [--fixture <slug>] [--tolerance 0.15] [--out <dir>]

import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCrawl } from '../src/workers/crawl.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(here, '..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'test', 'fixtures', 'golden');

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

async function main() {
  const fixtures = opt.fixture
    ? [opt.fixture]
    : (await readdir(FIXTURE_ROOT, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);

  if (!fixtures.length) {
    console.error(`no fixtures under ${FIXTURE_ROOT}`);
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
