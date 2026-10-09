#!/usr/bin/env node
// A stand-in for src/workers/run-job.mjs that launches no browser.
//
// Same contract with the queue (argv, NDJSON on stdout, exit code), but the
// "work" is waiting for the test to create `<artefact dir>/release`. That lets a
// test hold any number of jobs in the running state for as long as it needs.

import { access } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(`--${name}`) + 1];
const jobId = arg('job');
const release = path.join(arg('artefact-root'), jobId, 'release');

process.on('SIGTERM', () => process.exit(3));

process.stdout.write(JSON.stringify({ type: 'progress', pagesCrawled: 0 }) + '\n');

const deadline = Date.now() + 30_000;
for (;;) {
  try {
    await access(release);
    break;
  } catch {
    if (Date.now() > deadline) process.exit(1);
    await new Promise((r) => setTimeout(r, 25));
  }
}

process.stdout.write(JSON.stringify({ type: 'result', result: { jobId } }) + '\n');
process.exit(0);
