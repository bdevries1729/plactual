import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// runSync re-creates the data directories, so the configuration has to point
// somewhere writable before config.js is imported — hence the dynamic imports.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plactual-sync-'));
process.env.DB_FILE = path.join(tmpDir, 'db.json');
process.env.ACTUAL_DATA_DIR = path.join(tmpDir, 'cache');
process.env.ACTUAL_BUDGET_ID = 'budget-under-test';
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const { default: db, initDb } = await import('../src/db.js');
const { default: plaid } = await import('../src/plaid.js');
const { default: api } = await import('@actual-app/api');
const { runSync, isSyncRunning } = await import('../src/sync.js');

let counter = 0;

const MAPPING = {
  institution_id: 'ins_1',
  institution_name: 'First Bank',
  item_id: 'item-1',
  access_token: 'access-sandbox-secret',
  account_name: 'Checking',
  type: 'depository',
  subtype: 'checking',
  plaid_account_id: 'plaid-1',
  actual_account_id: 'actual-1',
  cursor: 'cursor-1',
  sync: true,
  login_required: false,
};

const PLAID_ACCOUNT = {
  account_id: 'plaid-1',
  name: 'Checking',
  type: 'depository',
  balances: { current: 100 },
};

// A Plaid transaction, dated today so the new-account cutoff keeps it.
const today = new Date().toISOString().split('T')[0];
const plaidTx = (overrides = {}) => ({
  transaction_id: 'tx-1',
  date: today,
  amount: 12.34,
  name: 'STARBUCKS 123',
  merchant_name: 'Starbucks',
  pending: false,
  ...overrides,
});

let dbPath;

async function openDb(mappings = [{ ...MAPPING }]) {
  dbPath = path.join(tmpDir, `db-${counter++}.json`);
  fs.writeFileSync(
    dbPath,
    JSON.stringify({ mappings, users: [{ plaid_user_id: 'plaid-user-1' }] })
  );
  await initDb(dbPath);
}

const storedMappings = () => JSON.parse(fs.readFileSync(dbPath, 'utf8')).mappings;

// One page of changes by default, plus the accountsGet that
// ensureAllAccountMappings walks.
function stubPlaid(t, { pages, accounts = [PLAID_ACCOUNT] } = {}) {
  const calls = { transactionsSync: [] };
  const responses = pages ?? [{ added: [], modified: [], removed: [], next_cursor: 'cursor-2' }];
  let index = 0;

  t.mock.method(plaid, 'userItemsGet', async () => ({ data: { items: [{ item_id: 'item-1' }] } }));
  t.mock.method(plaid, 'accountsGet', async () => ({
    data: { accounts, item: { item_id: 'item-1', institution_id: 'ins_1' } },
  }));
  t.mock.method(plaid, 'transactionsSync', async (request) => {
    calls.transactionsSync.push(request);
    const page = responses[Math.min(index++, responses.length - 1)];
    if (page instanceof Error || page?.response) throw page;
    return { data: { has_more: false, ...page } };
  });

  return calls;
}

// `rows` stands in for what has already been imported, keyed the way the app
// looks them up: by imported_id within an account.
function stubActual(t, { rows = [], accounts = [{ id: 'actual-1' }], balance = 0 } = {}) {
  const calls = {
    init: 0,
    shutdown: 0,
    downloadBudget: [],
    createAccount: [],
    deleted: [],
    updated: [],
    imported: [],
    added: [],
  };
  const stub = (name, fn) => t.mock.method(api, name, fn);

  stub('init', async () => {
    calls.init++;
  });
  stub('shutdown', async () => {
    calls.shutdown++;
  });
  stub('downloadBudget', async (id) => calls.downloadBudget.push(id));
  stub('getAccounts', async () => accounts);
  stub('createAccount', async (account) => {
    calls.createAccount.push(account);
    return 'actual-new';
  });
  stub('q', (table) => ({
    table,
    filter(f) {
      this.f = f;
      return this;
    },
    select(s) {
      this.s = s;
      return this;
    },
  }));
  stub('aqlQuery', async (query) => ({
    data: rows.filter(
      (r) => r.account === query.f.account && query.f.imported_id.$oneof.includes(r.imported_id)
    ),
  }));
  stub('deleteTransaction', async (id) => calls.deleted.push(id));
  stub('updateTransaction', async (id, fields) => calls.updated.push({ id, fields }));
  stub('importTransactions', async (accountId, transactions, options) => {
    calls.imported.push({ accountId, transactions, options });
    return { added: transactions.map((_, i) => `actual-tx-${i}`), updated: [], errors: [] };
  });
  stub('getAccountBalance', async () => balance);
  stub('getCategories', async () => [{ id: 'cat-1', name: 'Starting Balances' }]);
  stub('addTransactions', async (accountId, transactions) =>
    calls.added.push({ accountId, transactions })
  );

  return calls;
}

function silence(t) {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'warn', () => {});
}

describe('runSync', () => {
  beforeEach(() => openDb());

  it('reports nothing to do with no mappings', async (t) => {
    silence(t);
    await openDb([]);
    stubPlaid(t);
    const actual = stubActual(t);

    assert.deepEqual(await runSync(), { results: [] });
    // Never opens a connection it has no use for.
    assert.equal(actual.init, 0);
  });

  it('downloads the budget once and always releases the connection', async (t) => {
    silence(t);
    stubPlaid(t);
    const actual = stubActual(t);

    await runSync();

    assert.deepEqual(actual.downloadBudget, ['budget-under-test']);
    assert.equal(actual.init, 1);
    assert.equal(actual.shutdown, 1);
  });

  it('releases the connection even when the budget will not download', async (t) => {
    silence(t);
    stubPlaid(t);
    const actual = stubActual(t);
    t.mock.method(api, 'downloadBudget', async () => {
      throw new Error('budget is locked');
    });

    await assert.rejects(runSync(), /budget is locked/);
    assert.equal(actual.shutdown, 1);
    assert.equal(isSyncRunning(), false);
  });

  it('skips a mapping the user has switched off', async (t) => {
    silence(t);
    await openDb([{ ...MAPPING, sync: false }]);
    const plaidCalls = stubPlaid(t);
    stubActual(t);

    assert.deepEqual(await runSync(), { results: [] });
    assert.equal(plaidCalls.transactionsSync.length, 0);
  });

  it('refuses to start a second sync while one is running', async (t) => {
    silence(t);
    stubPlaid(t);
    stubActual(t);
    let release;
    t.mock.method(api, 'getAccounts', async () => {
      await new Promise((resolve) => {
        release = resolve;
      });
      return [{ id: 'actual-1' }];
    });

    const first = runSync();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(isSyncRunning(), true);
    assert.equal(await runSync(), null);

    release();
    await first;
    assert.equal(isSyncRunning(), false);
  });
});

describe('sync results', () => {
  beforeEach(() => openDb());

  it('never carries the access token to the caller', async (t) => {
    // /sync serialises these to the browser, and they are built from a mapping
    // that holds the institution's access token.
    silence(t);
    stubPlaid(t, { pages: [{ added: [plaidTx()], modified: [], removed: [] }] });
    stubActual(t);

    const { results } = await runSync();

    assert.equal(results.length, 1);
    assert.equal(JSON.stringify(results).includes('access-sandbox-secret'), false);
    assert.deepEqual(Object.keys(results[0]).sort(), [
      'account_name',
      'added',
      'error',
      'modified',
      'plaid_account_id',
      'removed',
    ]);
  });

  it('counts what it did, per account', async (t) => {
    silence(t);
    stubPlaid(t, {
      pages: [
        {
          added: [plaidTx({ transaction_id: 'tx-add' })],
          modified: [plaidTx({ transaction_id: 'tx-mod' })],
          removed: [{ transaction_id: 'tx-del' }],
        },
      ],
    });
    stubActual(t, {
      rows: [
        { id: 'actual-tx-mod', imported_id: 'tx-mod', account: 'actual-1' },
        { id: 'actual-tx-del', imported_id: 'tx-del', account: 'actual-1' },
      ],
    });

    const [result] = (await runSync()).results;

    assert.equal(result.account_name, 'Checking');
    assert.equal(result.added, 1);
    assert.equal(result.modified, 1);
    assert.equal(result.removed, 1);
    assert.equal(result.error, null);
  });
});

describe('applying Plaid changes', () => {
  beforeEach(() => openDb());

  it('deletes by resolving the Plaid id to Actual’s own id', async (t) => {
    silence(t);
    stubPlaid(t, { pages: [{ added: [], modified: [], removed: [{ transaction_id: 'tx-del' }] }] });
    const actual = stubActual(t, {
      rows: [{ id: 'actual-tx-del', imported_id: 'tx-del', account: 'actual-1' }],
    });

    await runSync();

    assert.deepEqual(actual.deleted, ['actual-tx-del']);
  });

  it('ignores a removal for something never imported', async (t) => {
    silence(t);
    stubPlaid(t, { pages: [{ added: [], modified: [], removed: [{ transaction_id: 'gone' }] }] });
    const actual = stubActual(t, { rows: [] });

    const [result] = (await runSync()).results;

    assert.deepEqual(actual.deleted, []);
    assert.equal(result.error, null);
  });

  it('updates a modified transaction in place, without payee_name', async (t) => {
    silence(t);
    stubPlaid(t, {
      pages: [{ added: [], modified: [plaidTx({ transaction_id: 'tx-mod' })], removed: [] }],
    });
    const actual = stubActual(t, {
      rows: [{ id: 'actual-tx-mod', imported_id: 'tx-mod', account: 'actual-1' }],
    });

    await runSync();

    assert.equal(actual.updated.length, 1);
    assert.equal(actual.updated[0].id, 'actual-tx-mod');
    // Actual only accepts payee_name when creating a transaction.
    assert.equal('payee_name' in actual.updated[0].fields, false);
    assert.equal(actual.updated[0].fields.imported_payee, 'Starbucks');
  });

  it('resolves a whole batch in one query rather than one call each', async (t) => {
    silence(t);
    const modified = ['a', 'b', 'c'].map((id) => plaidTx({ transaction_id: id }));
    stubPlaid(t, { pages: [{ added: [], modified, removed: [] }] });
    stubActual(t, {
      rows: modified.map((tx) => ({
        id: `actual-${tx.transaction_id}`,
        imported_id: tx.transaction_id,
        account: 'actual-1',
      })),
    });
    await runSync();

    assert.equal(api.aqlQuery.mock.callCount(), 1);
  });

  it('imports a modification for a transaction Actual has never seen', async (t) => {
    // Plaid does this for a pending transaction that predates the first sync.
    silence(t);
    stubPlaid(t, {
      pages: [{ added: [], modified: [plaidTx({ transaction_id: 'tx-new' })], removed: [] }],
    });
    const actual = stubActual(t, { rows: [] });

    await runSync();

    assert.equal(actual.updated.length, 0);
    assert.equal(actual.imported[0].transactions[0].imported_id, 'tx-new');
  });

  it('skips a transaction with no amount rather than booking $0.00', async (t) => {
    silence(t);
    stubPlaid(t, {
      pages: [
        {
          added: [
            plaidTx({ transaction_id: 'tx-ok' }),
            plaidTx({ transaction_id: 'tx-bad', amount: null }),
          ],
          modified: [],
          removed: [],
          next_cursor: 'cursor-2',
        },
      ],
    });
    const actual = stubActual(t);

    const [result] = (await runSync()).results;

    assert.deepEqual(
      actual.imported[0].transactions.map((tx) => tx.imported_id),
      ['tx-ok']
    );
    // Not a failure: that would hold the cursor back and stall the account.
    assert.equal(result.error, null);
    assert.equal(db.data.mappings[0].cursor, 'cursor-2');
  });

  it('never re-imports a transaction the user deleted in Actual', async (t) => {
    silence(t);
    stubPlaid(t, { pages: [{ added: [plaidTx()], modified: [], removed: [] }] });
    const actual = stubActual(t);

    await runSync();

    assert.deepEqual(actual.imported[0].options, { reimportDeleted: false });
  });
});

describe('the Plaid cursor', () => {
  beforeEach(() => openDb());

  it('advances and is persisted after a clean sync', async (t) => {
    silence(t);
    stubPlaid(t, { pages: [{ added: [], modified: [], removed: [], next_cursor: 'cursor-9' }] });
    stubActual(t);

    await runSync();

    assert.equal(db.data.mappings[0].cursor, 'cursor-9');
    // On disk too, or a restart brings the whole diff back.
    assert.equal(storedMappings()[0].cursor, 'cursor-9');
  });

  it('is left alone when a phase failed, so the next run retries the diff', async (t) => {
    silence(t);
    stubPlaid(t, {
      pages: [
        {
          added: [],
          modified: [],
          removed: [{ transaction_id: 'tx-del' }],
          next_cursor: 'cursor-9',
        },
      ],
    });
    stubActual(t, { rows: [{ id: 'actual-tx-del', imported_id: 'tx-del', account: 'actual-1' }] });
    t.mock.method(api, 'deleteTransaction', async () => {
      throw new Error('write failed');
    });

    const [result] = (await runSync()).results;

    assert.match(result.error, /will retry on next run/);
    assert.equal(db.data.mappings[0].cursor, 'cursor-1');
  });

  it('is not overwritten by an empty cursor from Plaid', async (t) => {
    // Accepting one would restart the account from scratch.
    silence(t);
    stubPlaid(t, { pages: [{ added: [], modified: [], removed: [], next_cursor: null }] });
    stubActual(t);

    await runSync();

    assert.equal(db.data.mappings[0].cursor, 'cursor-1');
  });

  it('pages until Plaid says there is nothing more', async (t) => {
    silence(t);
    const calls = stubPlaid(t, {
      pages: [
        {
          added: [plaidTx({ transaction_id: 'tx-1' })],
          modified: [],
          removed: [],
          next_cursor: 'page-2',
          has_more: true,
        },
        {
          added: [plaidTx({ transaction_id: 'tx-2' })],
          modified: [],
          removed: [],
          next_cursor: 'page-3',
        },
      ],
    });
    const actual = stubActual(t);

    await runSync();

    assert.deepEqual(
      calls.transactionsSync.map((c) => c.cursor),
      ['cursor-1', 'page-2']
    );
    assert.equal(actual.imported[0].transactions.length, 2);
    assert.equal(db.data.mappings[0].cursor, 'page-3');
  });

  it('refuses to page forever on an unchanged cursor', async (t) => {
    silence(t);
    stubPlaid(t, {
      pages: [{ added: [], modified: [], removed: [], next_cursor: null, has_more: true }],
    });
    stubActual(t);

    const [result] = (await runSync()).results;

    assert.match(result.error, /reported more pages but returned no cursor/);
  });
});

describe('fetch failures', () => {
  beforeEach(() => openDb());

  it('retries a transient Plaid error and carries on', async (t) => {
    silence(t);
    let attempts = 0;
    stubPlaid(t);
    stubActual(t);
    t.mock.method(plaid, 'transactionsSync', async () => {
      if (++attempts < 3) throw new Error('502 Bad Gateway');
      return { data: { added: [], modified: [], removed: [], next_cursor: 'cursor-2' } };
    });

    const [result] = (await runSync()).results;

    assert.equal(attempts, 3);
    assert.equal(result.error, null);
  });

  it('gives up loudly rather than reporting a clean sync', async (t) => {
    silence(t);
    stubPlaid(t);
    stubActual(t);
    t.mock.method(plaid, 'transactionsSync', async () => {
      throw { response: { data: { error_message: 'Plaid is unavailable' } } };
    });

    const [result] = (await runSync()).results;

    assert.match(result.error, /after 3 attempts: Plaid is unavailable/);
    assert.equal(db.data.mappings[0].cursor, 'cursor-1');
  });

  it('does not retry a stale login, and flags it for reconnection', async (t) => {
    silence(t);
    let attempts = 0;
    stubPlaid(t);
    stubActual(t);
    t.mock.method(plaid, 'transactionsSync', async () => {
      attempts++;
      throw { response: { data: { error_code: 'ITEM_LOGIN_REQUIRED' } } };
    });

    const [result] = (await runSync()).results;

    assert.equal(attempts, 1, 'retrying cannot fix a login that needs a human');
    assert.equal(result.error, 'ITEM_LOGIN_REQUIRED');
    assert.equal(db.data.mappings[0].login_required, true);
  });

  it('clears login_required once a fetch proves the login works', async (t) => {
    silence(t);
    await openDb([{ ...MAPPING, login_required: true }]);
    stubPlaid(t);
    stubActual(t);

    await runSync();

    assert.equal(db.data.mappings[0].login_required, false);
  });
});

describe('a mapping with no Actual account yet', () => {
  beforeEach(() => openDb([{ ...MAPPING, actual_account_id: null, cursor: null }]));

  it('creates the Actual account and records its id', async (t) => {
    silence(t);
    stubPlaid(t);
    const actual = stubActual(t, { accounts: [] });

    await runSync();

    assert.deepEqual(actual.createAccount, [{ name: 'Checking', offbudget: false }]);
    assert.equal(db.data.mappings[0].actual_account_id, 'actual-new');
  });

  it('re-creates the account if it vanished from Actual', async (t) => {
    // The budget file can be replaced or the account deleted by hand.
    silence(t);
    await openDb([{ ...MAPPING, actual_account_id: 'actual-gone' }]);
    stubPlaid(t);
    const actual = stubActual(t, { accounts: [{ id: 'actual-1' }] });

    await runSync();

    assert.equal(actual.createAccount.length, 1);
    assert.equal(db.data.mappings[0].actual_account_id, 'actual-new');
  });

  it('keeps history out of a brand-new account', async (t) => {
    silence(t);
    stubPlaid(t, {
      pages: [
        {
          added: [plaidTx({ transaction_id: 'old', date: '2020-01-05' }), plaidTx()],
          modified: [],
          removed: [],
        },
      ],
    });
    const actual = stubActual(t, { accounts: [] });

    await runSync();

    assert.deepEqual(
      actual.imported[0].transactions.map((tx) => tx.imported_id),
      ['tx-1']
    );
  });
});

describe('the starting balance adjustment', () => {
  const pending = { ...MAPPING, starting_balance_date: '2026-08-01' };

  it('books the difference between Actual and the bank', async (t) => {
    silence(t);
    await openDb([{ ...pending }]);
    stubPlaid(t);
    // Plaid says $100.00, Actual has nothing.
    const actual = stubActual(t, { balance: 0 });

    const [result] = (await runSync()).results;

    assert.equal(actual.added.length, 1);
    const [tx] = actual.added[0].transactions;
    assert.equal(tx.amount, 10000);
    assert.equal(tx.payee_name, 'Starting Balance');
    assert.equal(tx.category, 'cat-1');
    // When the account was created, not today.
    assert.equal(tx.date, '2026-08-01');
    assert.equal(result.added, 1);
    assert.equal(db.data.mappings[0].starting_balance_date, null);
  });

  it('negates a credit balance, which Plaid reports as an amount owed', async (t) => {
    silence(t);
    await openDb([{ ...pending }]);
    stubPlaid(t, { accounts: [{ ...PLAID_ACCOUNT, type: 'credit' }] });
    const actual = stubActual(t, { balance: 0 });

    await runSync();

    assert.equal(actual.added[0].transactions[0].amount, -10000);
  });

  it('books nothing when the balances already agree, and stops trying', async (t) => {
    silence(t);
    await openDb([{ ...pending }]);
    stubPlaid(t);
    const actual = stubActual(t, { balance: 10000 });

    await runSync();

    assert.deepEqual(actual.added, []);
    assert.equal(db.data.mappings[0].starting_balance_date, null);
  });

  it('waits for a later run when Plaid reports no balance', async (t) => {
    silence(t);
    await openDb([{ ...pending }]);
    stubPlaid(t, { accounts: [{ ...PLAID_ACCOUNT, balances: { current: null } }] });
    const actual = stubActual(t);

    await runSync();

    assert.deepEqual(actual.added, []);
    // Still owed, so the next sync picks the job back up.
    assert.equal(db.data.mappings[0].starting_balance_date, '2026-08-01');
  });

  it('is not attempted at all for an account that never needed one', async (t) => {
    silence(t);
    await openDb([{ ...MAPPING }]);
    stubPlaid(t);
    const actual = stubActual(t, { balance: 999 });

    await runSync();

    assert.deepEqual(actual.added, []);
  });
});
