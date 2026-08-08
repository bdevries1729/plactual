import { describe, it, beforeEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The /sync route re-creates the data directories, so the configuration has to
// point somewhere writable before config.js is first imported.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plactual-routes-'));
process.env.DB_FILE = path.join(tmpDir, 'db.json');
process.env.ACTUAL_DATA_DIR = path.join(tmpDir, 'cache');
process.env.ACTUAL_BUDGET_ID = 'budget-under-test';
process.env.CRON_SCHEDULE = '0 */6 * * *';
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const { default: db, initDb } = await import('../src/db.js');
const { default: plaid } = await import('../src/plaid.js');
const { default: api } = await import('@actual-app/api');
const { createApp } = await import('../src/app.js');
const { runSync } = await import('../src/sync.js');

let counter = 0;
let baseUrl;
let server;

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

before(async () => {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

async function openDb(mappings = [{ ...MAPPING }], users = [{ plaid_user_id: 'plaid-user-1' }]) {
  const file = path.join(tmpDir, `db-${counter++}.json`);
  fs.writeFileSync(file, JSON.stringify({ mappings, users }));
  await initDb(file);
}

// Speaks to the API the way public/app.js does: a JSON content type on every
// write, even the body-less ones.
async function request(method, url, body) {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: method === 'GET' ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text,
  };
}

const get = (url) => request('GET', url);
const post = (url, body) => request('POST', url, body);
const patch = (url, body) => request('PATCH', url, body);

function silence(t) {
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
}

describe('GET /api/mappings', () => {
  beforeEach(() => openDb());

  it('lists the mappings without their access tokens', async () => {
    const { status, body } = await get('/api/mappings');

    assert.equal(status, 200);
    assert.equal(body.length, 1);
    assert.equal('access_token' in body[0], false);
    assert.equal(body[0].account_name, 'Checking');
    assert.equal(body[0].plaid_account_id, 'plaid-1');
  });

  it('returns an empty list rather than a 404 when nothing is linked', async () => {
    await openDb([]);
    assert.deepEqual((await get('/api/mappings')).body, []);
  });
});

describe('PATCH /api/mappings/:id/sync', () => {
  beforeEach(() => openDb());

  it('turns syncing off and persists it', async () => {
    const { status, body } = await patch('/api/mappings/plaid-1/sync', { sync: false });

    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true });
    assert.equal(db.data.mappings[0].sync, false);
  });

  it('rejects anything but a boolean', async (t) => {
    silence(t);
    for (const sync of ['false', 0, null, undefined]) {
      const { status, body } = await patch('/api/mappings/plaid-1/sync', { sync });
      assert.equal(status, 400, JSON.stringify(sync));
      assert.equal(body.error, 'sync must be a boolean');
    }
    assert.equal(db.data.mappings[0].sync, true);
  });

  it('404s an account it does not know', async (t) => {
    silence(t);
    const { status, body } = await patch('/api/mappings/nope/sync', { sync: false });
    assert.equal(status, 404);
    assert.equal(body.error, 'Mapping not found');
  });
});

describe('POST /api/mappings/:item_id/resolve_login', () => {
  it('clears the flag for every account behind the item', async () => {
    await openDb([
      { ...MAPPING, login_required: true },
      { ...MAPPING, plaid_account_id: 'plaid-2', login_required: true },
    ]);

    const { status } = await post('/api/mappings/item-1/resolve_login');

    assert.equal(status, 200);
    assert.deepEqual(
      db.data.mappings.map((m) => m.login_required),
      [false, false]
    );
  });

  it('404s an item it does not know', async (t) => {
    silence(t);
    await openDb();
    assert.equal((await post('/api/mappings/nope/resolve_login')).status, 404);
  });
});

describe('POST /api/mappings/refresh', () => {
  beforeEach(() => openDb());

  it('reconciles with Plaid and answers with the refreshed list', async (t) => {
    silence(t);
    t.mock.method(plaid, 'userItemsGet', async () => ({
      data: { items: [{ item_id: 'item-1' }] },
    }));
    t.mock.method(plaid, 'accountsGet', async () => ({
      data: {
        accounts: [
          { account_id: 'plaid-1', name: 'Checking', type: 'depository', subtype: 'checking' },
          { account_id: 'plaid-2', name: 'Savings', type: 'depository', subtype: 'savings' },
        ],
        item: { item_id: 'item-1', institution_id: 'ins_1', institution_name: 'First Bank' },
      },
    }));

    const { status, body } = await post('/api/mappings/refresh');

    assert.equal(status, 200);
    assert.deepEqual(
      body.map((m) => m.account_name),
      ['Checking', 'Savings']
    );
    assert.equal(
      body.some((m) => 'access_token' in m),
      false
    );
  });

  it('reports which items failed rather than a bare 500', async (t) => {
    silence(t);
    t.mock.method(plaid, 'userItemsGet', async () => ({
      data: { items: [{ item_id: 'item-1' }] },
    }));
    t.mock.method(plaid, 'accountsGet', async () => {
      throw new Error('Plaid is down');
    });

    const { status, body } = await post('/api/mappings/refresh');

    assert.equal(status, 500);
    assert.equal(body.ok, false);
    assert.deepEqual(body.errors, [{ item_id: 'item-1', error: 'Plaid is down' }]);
  });
});

describe('link tokens', () => {
  beforeEach(() => openDb());

  it('creates one for a new institution', async (t) => {
    silence(t);
    const linkTokenCreate = t.mock.method(plaid, 'linkTokenCreate', async () => ({
      data: { link_token: 'link-sandbox-1' },
    }));

    const { status, body } = await post('/api/create_link_token');

    assert.equal(status, 200);
    assert.deepEqual(body, { link_token: 'link-sandbox-1' });
    const [request] = linkTokenCreate.mock.calls[0].arguments;
    assert.deepEqual(request.products, ['transactions']);
    assert.equal(request.user_id, 'plaid-user-1');
  });

  it('creates an update-mode token from the stored access token', async (t) => {
    silence(t);
    const linkTokenCreate = t.mock.method(plaid, 'linkTokenCreate', async () => ({
      data: { link_token: 'link-sandbox-update' },
    }));

    const { status, body } = await post('/api/create_link_token_update', { item_id: 'item-1' });

    assert.equal(status, 200);
    assert.equal(body.link_token, 'link-sandbox-update');
    const [request] = linkTokenCreate.mock.calls[0].arguments;
    assert.equal(request.access_token, 'access-sandbox-secret');
    // Plaid rejects `products` in update mode.
    assert.equal('products' in request, false);
  });

  it('requires an item_id for update mode', async (t) => {
    silence(t);
    const { status, body } = await post('/api/create_link_token_update', {});
    assert.equal(status, 400);
    assert.equal(body.error, 'item_id required');
  });

  it('404s an item it holds no token for', async (t) => {
    silence(t);
    const { status } = await post('/api/create_link_token_update', { item_id: 'unknown' });
    assert.equal(status, 404);
  });
});

describe('POST /api/exchange_public_token', () => {
  beforeEach(() => openDb([]));

  it('stores the linked accounts and answers without the access token', async (t) => {
    silence(t);
    t.mock.method(plaid, 'itemPublicTokenExchange', async () => ({
      data: { access_token: 'access-sandbox-new', item_id: 'item-9' },
    }));
    t.mock.method(plaid, 'accountsGet', async () => ({
      data: {
        accounts: [{ account_id: 'plaid-9', name: 'Checking', type: 'depository' }],
        item: { item_id: 'item-9', institution_id: 'ins_9', institution_name: 'Ninth Bank' },
      },
    }));

    const { status, body } = await post('/api/exchange_public_token', {
      public_token: 'public-sandbox-1',
    });

    assert.equal(status, 200);
    assert.equal(body.item_id, 'item-9');
    assert.equal(JSON.stringify(body).includes('access-sandbox-new'), false);
    assert.equal(db.data.mappings[0].access_token, 'access-sandbox-new');
  });

  it('requires a public token', async (t) => {
    silence(t);
    const { status, body } = await post('/api/exchange_public_token', {});
    assert.equal(status, 400);
    assert.equal(body.error, 'public_token required');
  });

  it('surfaces what Plaid said when the exchange fails', async (t) => {
    silence(t);
    t.mock.method(plaid, 'itemPublicTokenExchange', async () => {
      throw { response: { data: { error_message: 'public token has expired' } } };
    });

    const { status, body } = await post('/api/exchange_public_token', { public_token: 'stale' });

    assert.equal(status, 500);
    assert.equal(body.error, 'public token has expired');
  });
});

describe('POST /api/sync', () => {
  beforeEach(() => openDb());

  it('runs a sync and returns the per-account results', async (t) => {
    silence(t);
    t.mock.method(plaid, 'userItemsGet', async () => ({ data: { items: [] } }));
    t.mock.method(plaid, 'transactionsSync', async () => ({
      data: { added: [], modified: [], removed: [], next_cursor: 'cursor-2', has_more: false },
    }));
    for (const [name, value] of [
      ['init', undefined],
      ['shutdown', undefined],
      ['downloadBudget', undefined],
    ]) {
      t.mock.method(api, name, async () => value);
    }
    t.mock.method(api, 'getAccounts', async () => [{ id: 'actual-1' }]);
    t.mock.method(api, 'aqlQuery', async () => ({ data: [] }));

    const { status, body } = await post('/api/sync');

    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.deepEqual(body.results, [
      {
        account_name: 'Checking',
        plaid_account_id: 'plaid-1',
        added: 0,
        modified: 0,
        removed: 0,
        error: null,
      },
    ]);
  });

  it('never sends an access token to the browser', async (t) => {
    silence(t);
    t.mock.method(plaid, 'userItemsGet', async () => ({ data: { items: [] } }));
    t.mock.method(plaid, 'transactionsSync', async () => {
      throw { response: { data: { error_code: 'ITEM_LOGIN_REQUIRED' } } };
    });
    t.mock.method(api, 'init', async () => {});
    t.mock.method(api, 'shutdown', async () => {});
    t.mock.method(api, 'downloadBudget', async () => {});
    t.mock.method(api, 'getAccounts', async () => [{ id: 'actual-1' }]);

    // Including the failure path, which names the account it could not sync.
    const { body } = await post('/api/sync');

    assert.equal(JSON.stringify(body).includes('access-sandbox-secret'), false);
  });

  it('409s rather than starting a second sync', async (t) => {
    silence(t);
    t.mock.method(plaid, 'userItemsGet', async () => ({ data: { items: [] } }));
    t.mock.method(api, 'init', async () => {});
    t.mock.method(api, 'shutdown', async () => {});
    t.mock.method(api, 'downloadBudget', async () => {});
    let release;
    t.mock.method(api, 'getAccounts', async () => {
      await new Promise((resolve) => {
        release = resolve;
      });
      return [];
    });

    const inFlight = runSync();
    await new Promise((resolve) => setImmediate(resolve));

    const { status, body } = await post('/api/sync');
    assert.equal(status, 409);
    assert.equal(body.error, 'A sync is already in progress');

    release();
    await inFlight;
  });
});

describe('GET /api/health', () => {
  beforeEach(() => openDb());

  it('answers without touching Plaid or Actual', async (t) => {
    // The container HEALTHCHECK polls this every 30s.
    const categoriesGet = t.mock.method(plaid, 'categoriesGet', async () => ({ data: {} }));
    const fetchCall = t.mock.method(globalThis, 'fetch', globalThis.fetch);

    const { status, body } = await get('/api/health');

    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true });
    assert.equal(categoriesGet.mock.callCount(), 0);
    // Only the request this test itself made.
    assert.equal(fetchCall.mock.callCount(), 1);
  });
});

describe('GET /api/status', () => {
  it('counts institutions, not accounts', async (t) => {
    silence(t);
    await openDb([
      { ...MAPPING },
      { ...MAPPING, plaid_account_id: 'plaid-2' },
      { ...MAPPING, plaid_account_id: 'plaid-3', item_id: 'item-2' },
    ]);
    t.mock.method(plaid, 'categoriesGet', async () => ({ data: {} }));

    const { status, body } = await get('/api/status');

    assert.equal(status, 200);
    assert.equal(body.items, 2);
    assert.equal(body.plaid_env, 'sandbox');
    assert.equal(body.cron, '0 */6 * * *');
    assert.ok(['up', 'down'].includes(body.services.plaid));
    assert.ok(['up', 'down'].includes(body.services.actual));
  });
});

describe('the stack around the routes', () => {
  beforeEach(() => openDb());

  it('sets the security headers on every response', async () => {
    const { headers } = await get('/api/health');

    assert.match(headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal(headers.get('x-content-type-options'), 'nosniff');
    assert.equal(headers.get('referrer-policy'), 'no-referrer');
    assert.equal(headers.get('x-frame-options'), 'DENY');
  });

  it('does not advertise the framework', async () => {
    assert.equal((await get('/api/health')).headers.get('x-powered-by'), null);
  });

  it('refuses a write that is not declared as JSON', async () => {
    // What stops a cross-site <form> from driving the API.
    const response = await fetch(`${baseUrl}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'x',
    });

    assert.equal(response.status, 415);
    assert.equal((await response.json()).ok, false);
  });

  it('answers an unknown API path with JSON, not an HTML page', async () => {
    const { status, body, headers } = await get('/api/nope');

    assert.equal(status, 404);
    assert.match(headers.get('content-type'), /application\/json/);
    assert.equal(body.ok, false);
    assert.match(body.error, /Cannot GET \/api\/nope/);
  });

  it('answers malformed JSON with a 400 rather than a crash', async (t) => {
    silence(t);
    const response = await fetch(`${baseUrl}/api/exchange_public_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not json',
    });

    assert.equal(response.status, 400);
    assert.equal((await response.json()).ok, false);
  });

  it('serves the UI', async () => {
    const { status, body } = await get('/');
    assert.equal(status, 200);
    assert.match(body, /<title>Plactual<\/title>/);
  });
});
