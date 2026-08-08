import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import plaid from '../src/plaid.js';
import { checkExternalHealth } from '../src/health.js';

// The cached result outlives a single test, so every test starts by moving the
// clock past the cache window; the caching tests move it further themselves.
const CACHE_TTL_MS = 60_000;
let clock = 1_000_000_000;

function startClock(t) {
  clock += CACHE_TTL_MS * 10;
  t.mock.timers.enable({ apis: ['Date'], now: clock });
}

function stubProbes(t, { plaidUp = true, actualStatus = 200, actualThrows = false } = {}) {
  const calls = { plaid: 0, actual: 0 };

  t.mock.method(plaid, 'categoriesGet', async () => {
    calls.plaid++;
    if (!plaidUp) throw new Error('Plaid is down');
    return { data: { categories: [] } };
  });

  t.mock.method(globalThis, 'fetch', async () => {
    calls.actual++;
    if (actualThrows) throw new Error('ECONNREFUSED');
    return { status: actualStatus };
  });

  return calls;
}

describe('checkExternalHealth', () => {
  beforeEach((t) => startClock(t));

  it('reports both services up', async (t) => {
    stubProbes(t);

    const health = await checkExternalHealth();
    assert.equal(health.plaid, 'up');
    assert.equal(health.actual, 'up');
  });

  it('probes the two services at once', async (t) => {
    // The UI polls /api/status every few seconds; in series that doubles its
    // worst case.
    let running = 0;
    let overlapped = false;
    const observe = async () => {
      running++;
      await new Promise((resolve) => setImmediate(resolve));
      if (running === 2) overlapped = true;
      running--;
      return { status: 200 };
    };
    t.mock.method(plaid, 'categoriesGet', observe);
    t.mock.method(globalThis, 'fetch', observe);

    await checkExternalHealth();
    assert.equal(overlapped, true);
  });

  it('marks Plaid down when its API errors', async (t) => {
    stubProbes(t, { plaidUp: false });

    const health = await checkExternalHealth();
    assert.equal(health.plaid, 'down');
    assert.equal(health.actual, 'up');
  });

  it('marks Actual down when nothing answers', async (t) => {
    stubProbes(t, { actualThrows: true });

    assert.equal((await checkExternalHealth()).actual, 'down');
  });

  it('treats a 4xx from Actual as up — something is answering there', async (t) => {
    stubProbes(t, { actualStatus: 404 });

    assert.equal((await checkExternalHealth()).actual, 'up');
  });

  it('treats a 5xx from Actual as down — it cannot serve', async (t) => {
    stubProbes(t, { actualStatus: 503 });

    assert.equal((await checkExternalHealth()).actual, 'down');
  });

  it('gives both probes a timeout, or a hung connection holds /status open', async (t) => {
    stubProbes(t);
    const plaidCall = t.mock.method(plaid, 'categoriesGet', async () => ({ data: {} }));
    const fetchCall = t.mock.method(globalThis, 'fetch', async () => ({ status: 200 }));

    await checkExternalHealth();

    assert.equal(plaidCall.mock.calls[0].arguments[1].timeout, 5000);
    assert.ok(fetchCall.mock.calls[0].arguments[1].signal instanceof AbortSignal);
  });

  it('serves later callers from the cache rather than re-probing', async (t) => {
    const calls = stubProbes(t);

    await checkExternalHealth();
    await checkExternalHealth();
    await checkExternalHealth();

    assert.deepEqual(calls, { plaid: 1, actual: 1 });
  });

  it('re-probes once the cache has expired', async (t) => {
    const calls = stubProbes(t);

    await checkExternalHealth();
    t.mock.timers.tick(CACHE_TTL_MS + 1);
    await checkExternalHealth();

    assert.deepEqual(calls, { plaid: 2, actual: 2 });
  });

  it('shares one probe between callers that arrive while it runs', async (t) => {
    // The cache is only written once both settle, so a hung probe would
    // otherwise pile up requests.
    let release;
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    const calls = { plaid: 0 };
    t.mock.method(plaid, 'categoriesGet', async () => {
      calls.plaid++;
      await blocked;
      return { data: {} };
    });
    t.mock.method(globalThis, 'fetch', async () => ({ status: 200 }));

    const first = checkExternalHealth();
    const second = checkExternalHealth();
    release();

    assert.equal((await first).plaid, 'up');
    assert.equal((await second).plaid, 'up');
    assert.equal(calls.plaid, 1);
  });
});
