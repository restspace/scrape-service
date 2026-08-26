// Request validation.
//
// Every field is checked against the hard ceilings in config/defaults.json
// before a job is created. Two rules that matter:
//
//   * A request may ask for less than a ceiling, never more. Asking for more is
//     an error, not a silent clamp — a caller who asked for 500 pages and
//     received 200 without being told would draw wrong conclusions from the
//     result.
//   * Unknown fields are rejected. A typo'd 'maxpages' that silently did
//     nothing would be far harder to diagnose than a 400.

export class ValidationError extends Error {
  constructor(code, message, field) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.field = field;
    this.status = 400;
  }
}

const CRAWL_FIELDS = new Set([
  'rootUrl', 'maxPages', 'crawlDepth', 'respectRobotsTxt', 'captureDesktop', 'captureMobile',
  'excludedPathPatterns', 'timeoutMs', 'navWaitUntil', 'businessCategoryHint', 'targetMarket',
  'allowedDomains', 'maxQueryVariantsPerPath',
]);

const NAV_WAIT = new Set(['load', 'domcontentloaded', 'networkidle', 'commit']);

function rejectUnknown(body, allowed, kind) {
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      throw new ValidationError('unknown_field', `unknown field '${key}' for a ${kind} request`, key);
    }
  }
}

function requireString(body, field, { required = false } = {}) {
  const v = body[field];
  if (v === undefined || v === null) {
    if (required) throw new ValidationError('field_required', `'${field}' is required`, field);
    return undefined;
  }
  if (typeof v !== 'string' || !v.trim()) {
    throw new ValidationError('field_invalid', `'${field}' must be a non-empty string`, field);
  }
  return v.trim();
}

function optionalInt(body, field, { min, max }) {
  const v = body[field];
  if (v === undefined || v === null) return undefined;
  if (!Number.isInteger(v)) throw new ValidationError('field_invalid', `'${field}' must be an integer`, field);
  if (v < min) throw new ValidationError('field_out_of_range', `'${field}' must be >= ${min}`, field);
  if (v > max) {
    throw new ValidationError(
      'field_exceeds_ceiling',
      `'${field}' is ${v} but this server's ceiling is ${max}`,
      field,
    );
  }
  return v;
}

function optionalBool(body, field) {
  const v = body[field];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new ValidationError('field_invalid', `'${field}' must be a boolean`, field);
  return v;
}

function optionalStringArray(body, field, { maxItems = 100 } = {}) {
  const v = body[field];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) {
    throw new ValidationError('field_invalid', `'${field}' must be an array of strings`, field);
  }
  if (v.length > maxItems) {
    throw new ValidationError('field_out_of_range', `'${field}' may have at most ${maxItems} entries`, field);
  }
  return v;
}

/** Validate and normalise a crawl request into a job spec. */
export function validateCrawlRequest(body, limits) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('body_invalid', 'request body must be a JSON object');
  }
  rejectUnknown(body, CRAWL_FIELDS, 'crawl');

  const spec = {};
  spec.rootUrl = requireString(body, 'rootUrl', { required: true });

  const maxPages = optionalInt(body, 'maxPages', { min: 1, max: limits.maxPagesCeiling });
  if (maxPages !== undefined) spec.maxPages = maxPages;

  const crawlDepth = optionalInt(body, 'crawlDepth', { min: 0, max: 6 });
  if (crawlDepth !== undefined) spec.crawlDepth = crawlDepth;

  // How many query-string variants of one path a crawl may fetch (0 = unlimited). Raise it
  // for a site whose real pages live behind ?p= / ?id= keys; the default protects the budget
  // from parameterised redirect farms.
  const maxQueryVariantsPerPath = optionalInt(body, 'maxQueryVariantsPerPath', { min: 0, max: 500 });
  if (maxQueryVariantsPerPath !== undefined) spec.maxQueryVariantsPerPath = maxQueryVariantsPerPath;

  const timeoutMs = optionalInt(body, 'timeoutMs', { min: 1000, max: 120_000 });
  if (timeoutMs !== undefined) spec.timeoutMs = timeoutMs;

  for (const f of ['respectRobotsTxt', 'captureDesktop', 'captureMobile']) {
    const v = optionalBool(body, f);
    if (v !== undefined) spec[f] = v;
  }

  // Turning robots off is a deliberate, auditable choice, not a convenience.
  if (spec.respectRobotsTxt === false && !limits.allowRobotsOverride) {
    throw new ValidationError(
      'robots_override_forbidden',
      'this server does not allow respectRobotsTxt:false',
      'respectRobotsTxt',
    );
  }

  const excluded = optionalStringArray(body, 'excludedPathPatterns');
  if (excluded !== undefined) spec.excludedPathPatterns = excluded;

  const allowed = optionalStringArray(body, 'allowedDomains', { maxItems: 20 });
  if (allowed !== undefined) spec.allowedDomains = allowed;

  if (body.navWaitUntil !== undefined && body.navWaitUntil !== null) {
    if (!NAV_WAIT.has(body.navWaitUntil)) {
      throw new ValidationError(
        'field_invalid',
        `'navWaitUntil' must be one of ${[...NAV_WAIT].join(', ')}`,
        'navWaitUntil',
      );
    }
    spec.navWaitUntil = body.navWaitUntil;
  }

  for (const f of ['businessCategoryHint', 'targetMarket']) {
    const v = requireString(body, f);
    if (v !== undefined) spec[f] = v;
  }

  return spec;
}

const SCAN_FIELDS = new Set(['candidates', 'concurrency', 'maxPagesPerSite', 'siteBudgetMs', 'respectRobotsTxt', 'force']);

/** Validate and normalise a batch-scan request into a job spec. */
export function validateScanRequest(body, limits) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('body_invalid', 'request body must be a JSON object');
  }
  rejectUnknown(body, SCAN_FIELDS, 'scan');

  if (!Array.isArray(body.candidates) || body.candidates.length === 0) {
    throw new ValidationError('field_required', "'candidates' must be a non-empty array", 'candidates');
  }
  if (body.candidates.length > limits.maxCandidatesPerScan) {
    throw new ValidationError(
      'field_exceeds_ceiling',
      `'candidates' has ${body.candidates.length} entries but this server's ceiling is ${limits.maxCandidatesPerScan}`,
      'candidates',
    );
  }

  const candidates = body.candidates.map((c, i) => {
    const url = typeof c === 'string' ? c : c?.url;
    if (typeof url !== 'string' || !url.trim()) {
      throw new ValidationError('field_invalid', `candidates[${i}] needs a 'url'`, `candidates[${i}].url`);
    }
    const entry = { url: url.trim() };
    if (typeof c === 'object' && c) {
      if (c.name !== undefined) {
        if (typeof c.name !== 'string') throw new ValidationError('field_invalid', `candidates[${i}].name must be a string`, `candidates[${i}].name`);
        entry.name = c.name;
      }
      if (c.slug !== undefined) {
        if (typeof c.slug !== 'string' || !/^[a-z0-9-]+$/i.test(c.slug)) {
          // Slugs become directory names under the artefact root, so anything
          // path-shaped is refused here rather than sanitised silently.
          throw new ValidationError('field_invalid', `candidates[${i}].slug must match ^[a-z0-9-]+$`, `candidates[${i}].slug`);
        }
        entry.slug = c.slug;
      }
      for (const k of Object.keys(c)) {
        if (!['url', 'name', 'slug', 'id'].includes(k)) {
          throw new ValidationError('unknown_field', `unknown field '${k}' in candidates[${i}]`, `candidates[${i}].${k}`);
        }
      }
    }
    return entry;
  });

  const spec = { candidates };

  const concurrency = optionalInt(body, 'concurrency', { min: 1, max: 8 });
  if (concurrency !== undefined) spec.concurrency = concurrency;

  const maxPagesPerSite = optionalInt(body, 'maxPagesPerSite', { min: 1, max: 10 });
  if (maxPagesPerSite !== undefined) spec.maxPagesPerSite = maxPagesPerSite;

  const siteBudgetMs = optionalInt(body, 'siteBudgetMs', { min: 10_000, max: 300_000 });
  if (siteBudgetMs !== undefined) spec.siteBudgetMs = siteBudgetMs;

  const force = optionalBool(body, 'force');
  if (force !== undefined) spec.force = force;

  const respectRobots = optionalBool(body, 'respectRobotsTxt');
  if (respectRobots === false && !limits.allowRobotsOverride) {
    throw new ValidationError(
      'robots_override_forbidden',
      'this server does not allow respectRobotsTxt:false',
      'respectRobotsTxt',
    );
  }
  if (respectRobots !== undefined) spec.respectRobotsTxt = respectRobots;

  return spec;
}
