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
  'allowedDomains',
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
