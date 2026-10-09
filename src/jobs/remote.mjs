// Remote persistence for job records and artefacts (Cloudflare R2, S3 API).
//
// On the EC2 host the local disk *was* the durable store: RS2 served artefacts
// straight off it. In a Cloudflare Container the disk is scratch space that
// vanishes whenever the instance sleeps, and RS2 runs as a Worker that reads
// files from R2. So when this is configured:
//
//   - every job record is mirrored to `<jobPrefix>/<jobId>.json`, so a job
//     outlives the instance that ran it, and a restart can recover it;
//   - a finished job's artefact tree is uploaded to `<artefactPrefix>/<jobId>/`,
//     which is exactly where the RS2 `/scrape-runs` file mount reads from
//     (tenant `main`, store root `.rs2-scrape` -> `main/.rs2-scrape/...`).
//
// When it is not configured (tests, local runs, the old EC2 sidecar) nothing
// changes: the store stays disk-only.
//
// The interface is deliberately small — put, get, delete, list, deletePrefix —
// so tests can substitute an in-memory implementation (`MemoryRemote`).

import { AwsClient } from 'aws4fetch';

export const DEFAULT_JOB_PREFIX = '_scrape/jobs';
export const DEFAULT_ARTEFACT_PREFIX = 'main/.rs2-scrape';

/**
 * Build an R2 remote from the environment, or return null when the service is
 * running disk-only. A partial configuration is an error rather than a silent
 * fallback: losing every artefact because one variable was misspelt is the
 * failure this is here to prevent.
 */
export function remoteFromEnv(env = process.env) {
  const names = ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
  const present = names.filter((n) => env[n]);
  if (present.length === 0) return null;
  if (present.length !== names.length) {
    const missing = names.filter((n) => !env[n]);
    throw new Error(`R2 is partially configured — missing ${missing.join(', ')}`);
  }
  return new R2Remote({
    endpoint: env.R2_ENDPOINT || `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    bucket: env.R2_BUCKET,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    jobPrefix: env.R2_JOB_PREFIX || DEFAULT_JOB_PREFIX,
    artefactPrefix: env.R2_ARTEFACT_PREFIX || DEFAULT_ARTEFACT_PREFIX,
  });
}

export class RemoteError extends Error {
  constructor(op, key, status, detail) {
    super(`r2 ${op} ${key} failed: ${status}${detail ? ` ${detail}` : ''}`);
    this.code = 'remote_failed';
    this.status = status;
  }
}

export class R2Remote {
  constructor({ endpoint, bucket, accessKeyId, secretAccessKey, jobPrefix, artefactPrefix, retries = 3 }) {
    this.base = `${endpoint.replace(/\/+$/, '')}/${encodeURIComponent(bucket)}`;
    this.client = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto', retries });
    this.jobPrefix = trimSlashes(jobPrefix);
    this.artefactPrefix = trimSlashes(artefactPrefix);
  }

  #url(key, query) {
    const path = key.split('/').map(encodeURIComponent).join('/');
    const qs = query ? `?${new URLSearchParams(query)}` : '';
    return `${this.base}/${path}${qs}`;
  }

  #fetch(url, init = {}) {
    // R2 rejects signed requests without a payload hash header.
    const headers = { 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD', ...init.headers };
    return this.client.fetch(url, { ...init, headers });
  }

  async put(key, body, contentType = 'application/octet-stream') {
    const res = await this.#fetch(this.#url(key), {
      method: 'PUT',
      body,
      headers: { 'content-type': contentType },
    });
    if (!res.ok) throw new RemoteError('put', key, res.status, await safeText(res));
  }

  /** The object as a Response, or null when it does not exist. */
  async get(key) {
    const res = await this.#fetch(this.#url(key));
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) throw new RemoteError('get', key, res.status, await safeText(res));
    return res;
  }

  async delete(key) {
    const res = await this.#fetch(this.#url(key), { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new RemoteError('delete', key, res.status, await safeText(res));
  }

  /** Every object under `prefix`, as `{key, size}`, in key order. */
  async list(prefix) {
    const out = [];
    let token;
    do {
      const query = { 'list-type': '2', prefix, 'max-keys': '1000' };
      if (token) query['continuation-token'] = token;
      const res = await this.#fetch(`${this.base}?${new URLSearchParams(query)}`);
      if (!res.ok) throw new RemoteError('list', prefix, res.status, await safeText(res));
      const xml = await res.text();
      for (const block of xml.match(/<Contents>[\s\S]*?<\/Contents>/g) ?? []) {
        out.push({ key: xmlDecode(tag(block, 'Key')), size: Number(tag(block, 'Size') ?? 0) });
      }
      token = tag(xml, 'IsTruncated') === 'true' ? xmlDecode(tag(xml, 'NextContinuationToken')) : undefined;
    } while (token);
    return out;
  }

  async deletePrefix(prefix) {
    const objects = await this.list(prefix);
    await pool(objects, 8, (o) => this.delete(o.key));
    return objects.length;
  }
}

/** In-memory remote with the same interface, for tests. */
export class MemoryRemote {
  constructor({ jobPrefix = DEFAULT_JOB_PREFIX, artefactPrefix = DEFAULT_ARTEFACT_PREFIX } = {}) {
    this.jobPrefix = jobPrefix;
    this.artefactPrefix = artefactPrefix;
    /** @type {Map<string, {bytes: Buffer, contentType: string}>} */
    this.objects = new Map();
    this.failPuts = false;
  }

  async put(key, body, contentType = 'application/octet-stream') {
    if (this.failPuts) throw new RemoteError('put', key, 503, 'injected failure');
    const bytes = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body);
    this.objects.set(key, { bytes, contentType });
  }

  async get(key) {
    const o = this.objects.get(key);
    if (!o) return null;
    return new Response(o.bytes, { headers: { 'content-type': o.contentType, 'content-length': String(o.bytes.length) } });
  }

  async delete(key) {
    this.objects.delete(key);
  }

  async list(prefix) {
    return [...this.objects.keys()]
      .filter((k) => k.startsWith(prefix))
      .sort()
      .map((key) => ({ key, size: this.objects.get(key).bytes.length }));
  }

  async deletePrefix(prefix) {
    const keys = (await this.list(prefix)).map((o) => o.key);
    for (const k of keys) this.objects.delete(k);
    return keys.length;
  }
}

/** Run `fn` over `items` with at most `width` in flight. Rejects on the first failure. */
export async function pool(items, width, fn) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(lanes);
}

function trimSlashes(s) {
  return String(s).replace(/^\/+|\/+$/g, '');
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : undefined;
}

function xmlDecode(s) {
  if (s === undefined) return undefined;
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}
