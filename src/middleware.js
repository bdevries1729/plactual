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

export { refuseCrossSiteWrites };
