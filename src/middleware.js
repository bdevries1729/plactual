// The page is self-hosted and has exactly two third parties: Plaid Link (the
// script, plus the iframe it opens) and Google Fonts. Everything else is 'self'
// or denied outright. Note that Subresource Integrity is deliberately *not* used
// on either — see the note in public/index.html.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  // cdn.plaid.com serves link-initialize.js…
  "script-src 'self' https://cdn.plaid.com",
  // …and link.html, which Link opens in an iframe.
  'frame-src https://cdn.plaid.com',
  "style-src 'self' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  // data: covers nothing today, but keeps inline SVG/data icons working.
  "img-src 'self' data:",
  // The UI only ever talks to its own /api.
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // frame-ancestors above covers modern browsers; this is for the rest.
  res.setHeader('X-Frame-Options', 'DENY');
  next();
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Plactual has no login of its own, so any page in the user's browser can reach
// this API. Cross-site writes are refused on two counts:
//
//   - Content-Type must be JSON. A cross-origin <form> can POST without a
//     preflight, but it can only send urlencoded, multipart or text/plain; a
//     fetch that sets a JSON type gets preflighted and blocked instead. The
//     header is read directly rather than via req.is(), which returns null for
//     a body-less request no matter what the header says — and several of these
//     routes take no body.
//   - Origin, when the browser sends one, must match the host being addressed.
//     Only the host is compared, so a TLS-terminating reverse proxy (Origin
//     https, req.protocol http) doesn't trip it.
//
// This is a CSRF guard, not access control: it stops other sites from driving
// the API through the user's browser, and does nothing about whoever can reach
// the port directly. Keep the port private (see compose.yml).
function refuseCrossSiteWrites(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

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
      // A malformed Origin isn't something a browser sends; treat it as a
      // mismatch rather than waving it through.
    }
    if (originHost !== req.get('Host')) {
      return res.status(403).json({ ok: false, error: 'Cross-origin request refused' });
    }
  }

  next();
}

export { refuseCrossSiteWrites, securityHeaders, CONTENT_SECURITY_POLICY };
