import { describe, it, beforeEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';

// DEBUG=true prints request bodies and Plaid responses, so it is the mode where
// a credential could escape into the logs. It has to be set before config.js is
// imported, which is why this is its own file.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plactual-debug-'));
process.env.DEBUG = 'true';
process.env.DB_FILE = path.join(tmpDir, 'db.json');
process.env.ACTUAL_DATA_DIR = path.join(tmpDir, 'cache');
process.env.ACTUAL_BUDGET_ID = 'budget-under-test';
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const { default: db, initDb } = await import('../src/db.js');
const { default: plaid } = await import('../src/plaid.js');
const { default: api } = await import('@actual-app/api');
const { createApp } = await import('../src/app.js');

// Every credential this test hands the app. None of them may appear in the log.
const SECRETS = {
  accessToken: 'access-sandbox-must-not-be-logged',
  publicToken: 'public-sandbox-must-not-be-logged',
  linkToken: 'link-sandbox-must-not-be-logged',
};

const MAPPING = {
  institution_id: 'ins_1',
  institution_name: 'First Bank',
  item_id: 'item-1',
  access_token: SECRETS.accessToken,
  account_name: 'Checking',
  plaid_account_id: 'plaid-1',
  actual_account_id: 'actual-1',
  cursor: 'cursor-1',
  sync: true,
  login_required: false,
};

let baseUrl;
let server;
let logged;

before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

// Everything written to the console, the way a log file would see it.
function captureLog(t) {
  logged = [];
  const record =
    (level) =>
    (...args) =>
      logged.push(`${level} ${args.map((a) => util.inspect(a, { depth: null })).join(' ')}`);
  t.mock.method(console, 'log', record('log'));
  t.mock.method(console, 'error', record('error'));
  t.mock.method(console, 'warn', record('warn'));
}

const logText = () => logged.join('\n');

function assertNothingSecretLogged() {
  for (const [name, secret] of Object.entries(SECRETS)) {
    assert.equal(logText().includes(secret), false, `${name} reached the log`);
  }
}

async function post(url, body) {
  const response = await fetch(`${baseUrl}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

beforeEach(async (t) => {
  const file = path.join(tmpDir, `db-${Math.random()}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ mappings: [{ ...MAPPING }], users: [{ plaid_user_id: 'plaid-user-1' }] })
  );
  await initDb(file);
  captureLog(t);
});

describe('with DEBUG on', () => {
  it('logs the request line for every API call', async () => {
    await fetch(`${baseUrl}/api/mappings`);
    assert.match(logText(), /GET \/api\/mappings/);
  });

  it('logs the mapping list without the access tokens it holds', async () => {
    await fetch(`${baseUrl}/api/mappings`);

    assert.match(logText(), /Mappings:/);
    assertNothingSecretLogged();
  });

  it('masks the public token a link posts, and the access token it returns', async (t) => {
    t.mock.method(plaid, 'itemPublicTokenExchange', async () => ({
      data: { access_token: SECRETS.accessToken, item_id: 'item-9' },
    }));
    t.mock.method(plaid, 'accountsGet', async () => ({
      data: {
        accounts: [{ account_id: 'plaid-9', name: 'Checking', type: 'depository' }],
        item: { item_id: 'item-9', institution_id: 'ins_9', institution_name: 'Ninth Bank' },
      },
    }));

    const { status } = await post('/api/exchange_public_token', {
      public_token: SECRETS.publicToken,
    });

    assert.equal(status, 200);
    // The request body, the exchange response and the accounts response are all
    // printed at this level.
    assertNothingSecretLogged();
    assert.match(logText(), /\*\*\*/);
    // The token did reach the database, so this is not passing by never
    // having handled one.
    assert.equal(db.data.mappings.at(-1).access_token, SECRETS.accessToken);
  });

  it('masks the link token it mints', async (t) => {
    t.mock.method(plaid, 'linkTokenCreate', async () => ({
      data: { link_token: SECRETS.linkToken, expiration: '2026-08-08T00:00:00Z' },
    }));

    const { body } = await post('/api/create_link_token');

    assert.equal(body.link_token, SECRETS.linkToken);
    assertNothingSecretLogged();
  });

  it('keeps a sync’s own logging free of credentials', async (t) => {
    t.mock.method(plaid, 'userItemsGet', async () => ({ data: { items: [] } }));
    t.mock.method(plaid, 'transactionsSync', async () => ({
      data: {
        added: [
          {
            transaction_id: 'tx-1',
            date: '2026-08-07',
            amount: 12.34,
            name: 'Coffee',
            pending: false,
          },
        ],
        modified: [],
        removed: [],
        next_cursor: 'cursor-2',
        has_more: false,
      },
    }));
    t.mock.method(api, 'init', async () => {});
    t.mock.method(api, 'shutdown', async () => {});
    t.mock.method(api, 'downloadBudget', async () => {});
    t.mock.method(api, 'getAccounts', async () => [{ id: 'actual-1' }]);
    t.mock.method(api, 'importTransactions', async () => ({
      added: ['a'],
      updated: [],
      errors: [],
    }));

    const { status, body } = await post('/api/sync');

    assert.equal(status, 200);
    assert.equal(body.results[0].added, 1);
    // The sync result is printed in full here, and is built from the mapping
    // that holds the access token.
    assert.match(logText(), /Sync result:/);
    assertNothingSecretLogged();
  });
});
