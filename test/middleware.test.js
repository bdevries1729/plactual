import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  refuseCrossSiteWrites,
  createSecurityHeaders,
  buildContentSecurityPolicy,
  createRequestLogger,
  apiNotFound,
  createErrorHandler,
} from '../src/middleware.js';

// Stand-in for Express's req: the middleware only reads headers, and does so
// case-insensitively, as req.get does.
function makeReq(method, headers = {}) {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { method, get: (name) => lower.get(name.toLowerCase()) };
}

// Collects what a middleware answered with.
function makeRes(result) {
  const res = {
    status(code) {
      result.status = code;
      return res;
    },
    json(payload) {
      result.body = payload;
      return res;
    },
  };
  return res;
}

function run(req) {
  const result = { nexted: false, status: null, body: null };
  refuseCrossSiteWrites(req, makeRes(result), () => {
    result.nexted = true;
  });
  return result;
}

function makeLog() {
  const lines = [];
  return { lines, log: (...args) => lines.push(args), error: (...args) => lines.push(args) };
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

describe('securityHeaders', () => {
  const policy = buildContentSecurityPolicy('sandbox');

  function directivesOf(csp) {
    return new Map(
      csp.split('; ').map((d) => {
        const [name, ...values] = d.split(' ');
        return [name, values];
      })
    );
  }

  function headersFor(plaidEnv = 'sandbox') {
    const set = {};
    let nexted = false;
    createSecurityHeaders(plaidEnv)(
      {},
      { setHeader: (k, v) => (set[k] = v) },
      () => (nexted = true)
    );
    return { set, nexted };
  }

  it('sets the policy and the companion headers, then continues', () => {
    const { set, nexted } = headersFor();
    assert.equal(nexted, true);
    assert.equal(set['Content-Security-Policy'], policy);
    assert.equal(set['X-Content-Type-Options'], 'nosniff');
    assert.equal(set['Referrer-Policy'], 'no-referrer');
    assert.equal(set['X-Frame-Options'], 'DENY');
  });

  // Verified against the real Link flow in a browser: any of these missing or
  // narrower and Link fails to load or open. Re-test that flow before tightening.
  it('allows exactly what Plaid Link and the webfonts need', () => {
    const directives = directivesOf(policy);

    assert.deepEqual(directives.get('script-src'), ["'self'", 'https://cdn.plaid.com']);
    // Link opens link.html from the same host in an iframe.
    assert.deepEqual(directives.get('frame-src'), ['https://cdn.plaid.com']);
    assert.deepEqual(directives.get('style-src'), ["'self'", 'https://fonts.googleapis.com']);
    assert.deepEqual(directives.get('font-src'), ['https://fonts.gstatic.com']);
  });

  it('lets the page reach the Plaid API for the configured environment', () => {
    assert.deepEqual(directivesOf(policy).get('connect-src'), [
      "'self'",
      'https://sandbox.plaid.com',
    ]);
    assert.deepEqual(directivesOf(buildContentSecurityPolicy('production')).get('connect-src'), [
      "'self'",
      'https://production.plaid.com',
    ]);
  });

  it('falls back to the production origin for an unrecognised environment', () => {
    // config.js rejects anything else, so this is a default, not a live path.
    assert.deepEqual(directivesOf(buildContentSecurityPolicy(undefined)).get('connect-src'), [
      "'self'",
      'https://production.plaid.com',
    ]);
  });

  it('keeps the restrictive defaults that make the rest meaningful', () => {
    for (const directive of [
      "default-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ]) {
      assert.ok(policy.includes(directive), `policy should contain "${directive}"`);
    }
  });

  it("does not resort to 'unsafe-inline' or 'unsafe-eval'", () => {
    assert.ok(!policy.includes('unsafe-inline'));
    assert.ok(!policy.includes('unsafe-eval'));
  });
});

describe('refuseCrossSiteWrites', () => {
  it('lets reads through regardless of headers', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      assert.equal(run(makeReq(method)).nexted, true, method);
    }
  });

  it('allows the UI’s own writes, including the body-less ones', () => {
    // app.js sends this header on every write, even where there is no body.
    for (const method of ['POST', 'PATCH', 'DELETE']) {
      const result = run(makeReq(method, JSON_HEADERS));
      assert.equal(result.nexted, true, method);
    }
  });

  it('accepts a charset parameter on the content type', () => {
    const result = run(makeReq('POST', { 'Content-Type': 'application/json; charset=utf-8' }));
    assert.equal(result.nexted, true);
  });

  it('is case-insensitive about the content type', () => {
    assert.equal(run(makeReq('POST', { 'content-type': 'APPLICATION/JSON' })).nexted, true);
  });

  it('refuses the content types a cross-site form can send', () => {
    for (const type of [
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'text/plain',
    ]) {
      const result = run(makeReq('POST', { 'Content-Type': type }));
      assert.equal(result.nexted, false, type);
      assert.equal(result.status, 415);
      assert.equal(result.body.ok, false);
    }
  });

  it('refuses a write with no content type at all', () => {
    const result = run(makeReq('POST'));
    assert.equal(result.nexted, false);
    assert.equal(result.status, 415);
  });

  it('allows a same-origin write when the browser sends Origin', () => {
    const result = run(
      makeReq('POST', { ...JSON_HEADERS, Origin: 'http://localhost:3131', Host: 'localhost:3131' })
    );
    assert.equal(result.nexted, true);
  });

  it('refuses a cross-origin write even with a JSON content type', () => {
    const result = run(
      makeReq('POST', { ...JSON_HEADERS, Origin: 'https://evil.example', Host: 'localhost:3131' })
    );
    assert.equal(result.nexted, false);
    assert.equal(result.status, 403);
  });

  it('compares only the host, so a TLS-terminating proxy still works', () => {
    // Origin is https while the app itself speaks http behind the proxy.
    const result = run(
      makeReq('POST', {
        ...JSON_HEADERS,
        Origin: 'https://budget.example.com',
        Host: 'budget.example.com',
      })
    );
    assert.equal(result.nexted, true);
  });

  it('treats a malformed Origin as a mismatch', () => {
    const result = run(
      makeReq('POST', { ...JSON_HEADERS, Origin: 'not a url', Host: 'localhost:3131' })
    );
    assert.equal(result.nexted, false);
    assert.equal(result.status, 403);
  });

  it('allows writes with no Origin, as non-browser clients send none', () => {
    // curl and the cron-free CLI cases: nothing to compare, and a browser
    // always sends Origin on a cross-site request.
    assert.equal(run(makeReq('POST', { ...JSON_HEADERS, Host: 'localhost:3131' })).nexted, true);
  });
});

describe('createRequestLogger', () => {
  const req = { method: 'POST', originalUrl: '/api/exchange_public_token' };

  it('logs the method and path, then continues', () => {
    const log = makeLog();
    let nexted = false;
    createRequestLogger({ log })({ ...req, body: {} }, {}, () => (nexted = true));

    assert.equal(nexted, true);
    assert.match(log.lines[0][0], /POST \/api\/exchange_public_token/);
  });

  it('redacts credentials out of the body it logs', () => {
    // This route posts a Plaid public_token.
    const log = makeLog();
    createRequestLogger({ log })(
      { ...req, body: { public_token: 'public-sandbox-secret', item_id: 'item-1' } },
      {},
      () => {}
    );

    const [, body] = log.lines[1];
    assert.equal(body.public_token, '***');
    assert.equal(body.item_id, 'item-1');
  });

  it('says nothing about a body that is not there', () => {
    // body-parser leaves req.body undefined for a request with no content length.
    const log = makeLog();
    createRequestLogger({ log })({ ...req, body: undefined }, {}, () => {});
    assert.equal(log.lines.length, 1);
  });
});

describe('apiNotFound', () => {
  it('answers with JSON naming the path, since fetch() is the only caller', () => {
    const result = {};
    apiNotFound({ method: 'GET', originalUrl: '/api/nope' }, makeRes(result));

    assert.equal(result.status, 404);
    assert.deepEqual(result.body, { ok: false, error: 'Cannot GET /api/nope' });
  });
});

describe('createErrorHandler', () => {
  const req = { method: 'POST', originalUrl: '/api/sync' };

  function handle(err, log = makeLog()) {
    const result = {};
    createErrorHandler({ log })(err, req, makeRes(result), () => {});
    return { ...result, logged: log.lines };
  }

  it('uses the status a route asked for', () => {
    const err = Object.assign(new Error('A sync is already in progress'), { status: 409 });
    const result = handle(err);

    assert.equal(result.status, 409);
    assert.deepEqual(result.body, { ok: false, error: 'A sync is already in progress' });
  });

  it('treats anything unexpected as a 500', () => {
    assert.equal(handle(new Error('boom')).status, 500);
  });

  it('ignores a status that is not an HTTP error code', () => {
    // res.status() would send nonsense, or throw outright on a NaN.
    for (const status of [200, 999, 'ECONNREFUSED', NaN, null]) {
      assert.equal(handle(Object.assign(new Error('boom'), { status })).status, 500, `${status}`);
    }
  });

  it('surfaces what Plaid said, not the axios error wrapping it', () => {
    const err = { response: { data: { error_message: 'public token has expired' } } };
    assert.equal(handle(err).body.error, 'public token has expired');
  });

  it('logs the Plaid response body with its credentials masked', () => {
    const err = {
      response: { data: { error_message: 'nope', access_token: 'access-sandbox-secret' } },
    };
    const logged = JSON.stringify(handle(err).logged);

    assert.equal(logged.includes('access-sandbox-secret'), false);
    assert.ok(logged.includes('***'));
  });

  it('logs our own errors whole, since the stack is what makes them debuggable', () => {
    const err = new Error('boom');
    const [, logged] = handle(err).logged[0];
    assert.equal(logged, err);
  });

  it('always answers something a client can parse', () => {
    // Including a thrown non-Error.
    assert.deepEqual(handle('a string').body, { ok: false, error: 'unknown error' });
  });
});
