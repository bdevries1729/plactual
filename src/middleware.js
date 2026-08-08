import { redact } from './redact.js';
import { plaidErrorMessage } from './plaid.js';

// Link calls the Plaid API from the page itself, so connect-src has to allow
// the origin for the configured environment.
const PLAID_API_ORIGINS = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
};

// The only third parties are Plaid Link and Google Fonts; everything else is
// 'self' or denied. Neither third party carries an SRI hash — see the note in
// public/index.html.
function buildContentSecurityPolicy(plaidEnv) {
  const plaidApi = PLAID_API_ORIGINS[plaidEnv] ?? PLAID_API_ORIGINS.production;
  return [
    "default-src 'self'",
    "script-src 'self' https://cdn.plaid.com",
    // link.html, which Link opens in an iframe.
    'frame-src https://cdn.plaid.com',
    "style-src 'self' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data:",
    `connect-src 'self' ${plaidApi}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

function createSecurityHeaders(plaidEnv) {
  const policy = buildContentSecurityPolicy(plaidEnv);
  return function securityHeaders(req, res, next) {
    res.setHeader('Content-Security-Policy', policy);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  };
}

// Mounted only when DEBUG is on. Bodies are redacted: /exchange_public_token
// posts a Plaid public_token.
function createRequestLogger({ log = console } = {}) {
  return function logRequest(req, res, next) {
    log.log(`\n${req.method} ${req.originalUrl}`);
    if (Object.keys(req.body || {}).length > 0) {
      log.log('Request body: ', redact(req.body));
    }
    next();
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// CSRF guard — the app has no login, so any page in the user's browser can
// reach this API. A cross-origin form can only send urlencoded, multipart or
// text/plain, so requiring JSON blocks it; a fetch that sets a JSON type gets
// preflighted instead. Not access control: it does nothing about whoever can
// reach the port directly.
function refuseCrossSiteWrites(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  // Read directly rather than via req.is(), which returns null for a body-less
  // request no matter what the header says — several of these routes take none.
  const contentType = (req.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    return res.status(415).json({ ok: false, error: 'Content-Type must be application/json' });
  }

  const origin = req.get('Origin');
  if (origin) {
    let originHost = null;
    try {
      originHost = new URL(origin).host;
    } catch {
      // A malformed Origin is treated as a mismatch, not waved through.
    }
    // Host only, so a TLS-terminating proxy (Origin https, req.protocol http)
    // doesn't trip it.
    if (originHost !== req.get('Host')) {
      return res.status(403).json({ ok: false, error: 'Cross-origin request refused' });
    }
  }

  next();
}

// /api is consumed by fetch(), so unknown paths get JSON, not Express's HTML.
function apiNotFound(req, res) {
  res.status(404).json({ ok: false, error: `Cannot ${req.method} ${req.originalUrl}` });
}

// Express 5 forwards rejections from async handlers here, so routes throw
// rather than formatting their own error responses.
function createErrorHandler({ log = console } = {}) {
  return function handleError(err, req, res, _next) {
    // Ignore a `status` outside the HTTP error range: some library left it on an
    // unrelated error, and res.status() would send nonsense (or throw on NaN).
    const status =
      Number.isInteger(err.status) && err.status >= 400 && err.status <= 599 ? err.status : 500;

    // Plaid's response body says more than the axios error wrapping it; for our
    // own errors it's the stack that matters.
    log.error(
      `${req.method} ${req.originalUrl} -> ${status}:`,
      err.response?.data ? redact(err.response.data) : err
    );
    res.status(status).json({ ok: false, error: plaidErrorMessage(err) });
  };
}

export {
  refuseCrossSiteWrites,
  createSecurityHeaders,
  buildContentSecurityPolicy,
  createRequestLogger,
  apiNotFound,
  createErrorHandler,
};
