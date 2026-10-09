// robots.txt group selection, and the identity the crawler presents.
//
// A site operator who sees the crawler in their logs can do exactly one thing
// about it without contacting anyone: write a robots.txt rule for its name. So
// the name in the User-Agent and the name the parser answers to have to be the
// same name, and rules addressed to it have to be obeyed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';

import { parseRobots, loadRobots, makeRobotsBlocker } from '../src/capture/robots.mjs';
import { loadConfig, assertIdentity, DEFAULT_USER_AGENT, DEFAULT_ROBOTS_TOKEN } from '../src/config.mjs';

const blocks = (txt, url, token) => makeRobotsBlocker(parseRobots(txt, token), true)(url);

test('the default identity is Rapider IT', async () => {
  assert.equal(DEFAULT_ROBOTS_TOKEN, 'RapiderITBot');
  assert.match(DEFAULT_USER_AGENT, /RapiderITBot\/1\.0/);
  assert.match(DEFAULT_USER_AGENT, /\+https:\/\/rapiderit\.com\/bot\/\)/);

  const file = JSON.parse(await readFile(new URL('../config/defaults.json', import.meta.url), 'utf8'));
  assert.equal(file.server.userAgent, DEFAULT_USER_AGENT, 'config/defaults.json and src/config.mjs agree');
  assert.equal(file.server.robotsToken, DEFAULT_ROBOTS_TOKEN);
});

test('rules addressed to our token are obeyed', () => {
  const txt = 'User-agent: RapiderITBot\nDisallow: /private\n';
  assert.equal(blocks(txt, 'https://example.com/private/x'), true);
  assert.equal(blocks(txt, 'https://example.com/public'), false);
  assert.equal(parseRobots(txt).group, 'token');
});

test('the token matches in any case and with a version suffix', () => {
  for (const name of ['rapideritbot', 'RAPIDERITBOT', 'RapiderITBot/1.0', 'RapiderITBot/2']) {
    assert.equal(blocks(`User-agent: ${name}\nDisallow: /`, 'https://example.com/'), true, name);
  }
});

test('a name that merely contains or extends the token is someone else', () => {
  for (const name of ['RapiderITBotX', 'NotRapiderITBot', 'Rapider', 'AtelyrCaptureBot']) {
    assert.equal(blocks(`User-agent: ${name}\nDisallow: /`, 'https://example.com/'), false, name);
  }
});

test('our own group replaces the * group instead of adding to it', () => {
  const shutOut = 'User-agent: *\nDisallow: /a\n\nUser-agent: RapiderITBot\nDisallow: /b\n';
  assert.equal(blocks(shutOut, 'https://example.com/a'), false, '* rules do not apply once we are named');
  assert.equal(blocks(shutOut, 'https://example.com/b'), true);

  // Everyone else is banned, we are explicitly let in.
  const letIn = 'User-agent: *\nDisallow: /\n\nUser-agent: RapiderITBot\nDisallow:\n';
  assert.equal(blocks(letIn, 'https://example.com/anything'), false);

  // We are banned, everyone else is let in. Order must not matter.
  const banned = 'User-agent: RapiderITBot\nDisallow: /\n\nUser-agent: *\nDisallow:\n';
  assert.equal(blocks(banned, 'https://example.com/anything'), true);
});

test('with no group for us, the * group applies as before', () => {
  const txt = 'User-agent: Googlebot\nDisallow: /g\n\nUser-agent: *\nDisallow: /wp-admin\n';
  const robots = parseRobots(txt);
  assert.deepEqual(robots.disallow, ['/wp-admin']);
  assert.equal(robots.group, '*');
  assert.equal(parseRobots('User-agent: Googlebot\nDisallow: /').group, null);
  assert.deepEqual(parseRobots('User-agent: Googlebot\nDisallow: /').disallow, []);
});

test('consecutive User-agent lines share one group', () => {
  const txt = 'User-agent: Googlebot\nUser-agent: RapiderITBot\nUser-agent: Bingbot\nDisallow: /shared\n';
  assert.equal(blocks(txt, 'https://example.com/shared'), true);
  // The same shape used to drop the * rules when another name followed the star.
  const star = 'User-agent: *\nUser-agent: Googlebot\nDisallow: /both\n';
  assert.equal(blocks(star, 'https://example.com/both'), true);
});

test('several groups naming us are merged; sitemaps and comments are handled', () => {
  const txt = [
    '# site rules',
    'User-agent: RapiderITBot # that is us',
    'Disallow: /one',
    'Sitemap: https://example.com/sitemap.xml',
    'User-agent: Other',
    'Disallow: /other',
    'User-agent: rapideritbot',
    'Crawl-delay: 5',
    'Disallow: /two',
  ].join('\r\n');
  const robots = parseRobots(txt);
  assert.deepEqual(robots.disallow, ['/one', '/two']);
  assert.deepEqual(robots.sitemaps, ['https://example.com/sitemap.xml']);
});

test('a differently named deployment answers to its own token, not ours', () => {
  const txt = 'User-agent: RapiderITBot\nDisallow: /r\n\nUser-agent: OtherProductBot\nDisallow: /o\n';
  assert.equal(blocks(txt, 'https://example.com/o', 'OtherProductBot'), true);
  assert.equal(blocks(txt, 'https://example.com/r', 'OtherProductBot'), false);
});

test('robots.txt is requested with the configured user agent and matched with the configured token', async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers['user-agent']);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('User-agent: RapiderITBot\nDisallow: /members\n');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));

  const config = await loadConfig({});
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { robots, robotsTxtFound } = await loadRobots(origin, {
    respect: true,
    timeoutMs: 5000,
    userAgent: config.server.userAgent,
    robotsToken: config.server.robotsToken,
  });
  assert.equal(robotsTxtFound, true);
  assert.deepEqual(seen, ['RapiderITBot/1.0 (+https://rapiderit.com/bot/)']);
  assert.equal(makeRobotsBlocker(robots, true)(`${origin}/members/area`), true);
});

test('the identity is configurable from the environment, and a mismatched pair is refused', async () => {
  const other = await loadConfig({
    CRAWLER_USER_AGENT: 'Mozilla/5.0 (compatible; OtherProductBot/2.0; +https://other.example/bot)',
    CRAWLER_ROBOTS_TOKEN: 'OtherProductBot',
  });
  assert.equal(other.server.robotsToken, 'OtherProductBot');
  assert.match(other.server.userAgent, /OtherProductBot\/2\.0/);

  // Changing the User-Agent alone would leave robots.txt matching a name the
  // site never sees.
  await assert.rejects(loadConfig({ CRAWLER_USER_AGENT: 'SomethingElse/1.0' }), /does not appear in the user agent/);
  assert.throws(() => assertIdentity({ userAgent: 'x Bad Token/1.0', robotsToken: 'Bad Token' }), /robots token/);
});

test('no source file still carries the old identity', async () => {
  const { readdir } = await import('node:fs/promises');
  const root = new URL('../', import.meta.url);
  const offenders = [];
  const visit = async (dir) => {
    for (const e of await readdir(new URL(dir, root), { withFileTypes: true })) {
      const rel = `${dir}${e.name}`;
      if (e.isDirectory()) await visit(`${rel}/`);
      else if (/\.(mjs|js|json)$/.test(e.name) && /atelyrcapturebot|atelyr\.com/i.test(await readFile(new URL(rel, root), 'utf8'))) offenders.push(rel);
    }
  };
  await visit('src/');
  await visit('config/');
  assert.deepEqual(offenders, []);
});
