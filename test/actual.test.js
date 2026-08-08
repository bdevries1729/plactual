import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The module reads the configuration when it connects, so the environment has
// to be in place before config.js is imported.
process.env.ACTUAL_SERVER_URL = 'http://actual.test:5006';
process.env.ACTUAL_PASSWORD = 'hunter2';
process.env.ACTUAL_DATA_DIR = '/tmp/plactual-actual-test-cache';
process.env.ACTUAL_BUDGET_ID = 'budget-under-test';

const { default: api } = await import('@actual-app/api');
const { withActual, withBudget, verifyActualAccess } = await import('../src/actual.js');

// fail() ends the process; throwing instead lets a test see the message.
class Exited extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

function stubActual(t, { budgets = [{ groupId: 'budget-under-test' }] } = {}) {
  const calls = { init: [], shutdown: 0, downloadBudget: [] };
  t.mock.method(api, 'init', async (options) => calls.init.push(options));
  t.mock.method(api, 'shutdown', async () => calls.shutdown++);
  t.mock.method(api, 'downloadBudget', async (id) => calls.downloadBudget.push(id));
  t.mock.method(api, 'getBudgets', async () => budgets);
  t.mock.method(console, 'error', () => {});
  t.mock.method(process, 'exit', (code) => {
    throw new Exited(code);
  });
  return calls;
}

describe('withActual', () => {
  it('connects with the configured options', async (t) => {
    const calls = stubActual(t);

    await withActual(async () => {});

    assert.deepEqual(calls.init, [
      {
        verbose: false,
        dataDir: '/tmp/plactual-actual-test-cache',
        serverURL: 'http://actual.test:5006',
        password: 'hunter2',
      },
    ]);
  });

  it('returns what the caller’s function returned', async (t) => {
    stubActual(t);
    assert.equal(await withActual(async () => 'result'), 'result');
  });

  it('releases the connection even when the work throws', async (t) => {
    const calls = stubActual(t);

    await assert.rejects(
      withActual(async () => {
        throw new Error('boom');
      }),
      /boom/
    );
    assert.equal(calls.shutdown, 1);
  });
});

describe('withBudget', () => {
  it('downloads the configured budget before running the work', async (t) => {
    const calls = stubActual(t);
    const order = [];
    t.mock.method(api, 'downloadBudget', async (id) => {
      calls.downloadBudget.push(id);
      order.push('download');
    });

    await withBudget(async () => order.push('work'));

    assert.deepEqual(calls.downloadBudget, ['budget-under-test']);
    assert.deepEqual(order, ['download', 'work']);
    assert.equal(calls.shutdown, 1);
  });

  it('releases the connection when the budget will not download', async (t) => {
    const calls = stubActual(t);
    t.mock.method(api, 'downloadBudget', async () => {
      throw new Error('budget is locked');
    });

    await assert.rejects(
      withBudget(async () => {}),
      /budget is locked/
    );
    assert.equal(calls.shutdown, 1);
  });
});

describe('verifyActualAccess', () => {
  it('passes when the configured budget is on the server', async (t) => {
    const calls = stubActual(t, {
      budgets: [{ groupId: 'another-budget' }, { groupId: 'budget-under-test' }],
    });

    await verifyActualAccess();

    assert.equal(calls.init.length, 1);
    assert.equal(calls.shutdown, 1);
  });

  it('exits when the server cannot be reached, naming the URL', async (t) => {
    stubActual(t);
    t.mock.method(api, 'init', async () => {
      throw new Error('network-failure');
    });

    const error = await verifyActualAccess().catch((e) => e);
    assert.ok(error instanceof Exited);
    assert.equal(error.code, 1);
    assert.match(console.error.mock.calls[0].arguments[0], /Could not reach Actual at http:/);
  });

  it('exits when the budget list cannot be read', async (t) => {
    const calls = stubActual(t);
    t.mock.method(api, 'getBudgets', async () => {
      throw new Error('unauthorized');
    });

    await assert.rejects(verifyActualAccess(), Exited);
    assert.match(console.error.mock.calls[0].arguments[0], /Could not list budgets/);
    // Still released, or the failed startup leaves the cache locked.
    assert.equal(calls.shutdown, 1);
  });

  it('exits when no budget matches ACTUAL_BUDGET_ID', async (t) => {
    stubActual(t, { budgets: [{ groupId: 'someone-elses-budget' }] });

    await assert.rejects(verifyActualAccess(), Exited);
    assert.match(console.error.mock.calls[0].arguments[0], /No budgets found matching/);
  });

  it('matches on groupId, the sync id Actual shows in its settings', async (t) => {
    // `id` is the local file id, which is not what the user is asked for.
    stubActual(t, { budgets: [{ id: 'budget-under-test', groupId: 'something-else' }] });

    await assert.rejects(verifyActualAccess(), Exited);
  });
});
