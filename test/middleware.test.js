import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  refuseCrossSiteWrites,
  securityHeaders,
  CONTENT_SECURITY_POLICY,
} from '../src/middleware.js';

// Minimal stand-ins for Express's req/res: the middleware only reads headers
// (case-insensitively, as req.get does) and either calls next() or answers.
function makeReq(method, headers = {}) {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { method, get: (name) => lower.get(name.toLowerCase()) };
}

function run(req) {
  const result = { nexted: false, status: null, body: null };
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
  refuseCrossSiteWrites(req, res, () => {
    result.nexted = true;
  });
  return result;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

describe('securityHeaders', () => {
  function headersFor() {
    const set = {};
    let nexted = false;
    securityHeaders({}, { setHeader: (k, v) => (set[k] = v) }, () => (nexted = true));
    return { set, nexted };
  }

  it('sets the policy and the companion headers, then continues', () => {
    const { set, nexted } = headersFor();
    assert.equal(nexted, true);
    assert.equal(set['Content-Security-Policy'], CONTENT_SECURITY_POLICY);
    assert.equal(set['X-Content-Type-Options'], 'nosniff');
    assert.equal(set['Referrer-Policy'], 'no-referrer');
    assert.equal(set['X-Frame-Options'], 'DENY');
  });

  // These four directives were verified against the real Plaid Link flow in a
  // browser: with any of them missing or narrower, Link fails to load or open.
  // Tighten them only after re-testing that flow.
  it('allows exactly what Plaid Link and the webfonts need', () => {
    const directives = new Map(
      CONTENT_SECURITY_POLICY.split('; ').map((d) => {
        const [name, ...values] = d.split(' ');
        return [name, values];
      })
    );

    assert.deepEqual(directives.get('script-src'), ["'self'", 'https://cdn.plaid.com']);
    // Link opens link.html from the same host in an iframe.
    assert.deepEqual(directives.get('frame-src'), ['https://cdn.plaid.com']);
    assert.deepEqual(directives.get('style-src'), ["'self'", 'https://fonts.googleapis.com']);
    assert.deepEqual(directives.get('font-src'), ['https://fonts.gstatic.com']);
  });

  it('keeps the restrictive defaults that make the rest meaningful', () => {
    for (const directive of [
      "default-src 'self'",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "object-src 'none'",
    ]) {
      assert.ok(
        CONTENT_SECURITY_POLICY.includes(directive),
        `policy should contain "${directive}"`
      );
    }
  });

  it("does not resort to 'unsafe-inline' or 'unsafe-eval'", () => {
    assert.ok(!CONTENT_SECURITY_POLICY.includes('unsafe-inline'));
    assert.ok(!CONTENT_SECURITY_POLICY.includes('unsafe-eval'));
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
