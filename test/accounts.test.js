import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import db, { initDb } from '../src/db.js';
import plaid from '../src/plaid.js';
import {
  saveAccountMappings,
  createAccountMappings,
  ensureAllAccountMappings,
  flagLoginRequired,
} from '../src/accounts.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plactual-accounts-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

let counter = 0;

// Seeds a database with the given rows and opens it for the modules under test.
async function openDb({ mappings = [], users = [{ plaid_user_id: 'plaid-user-1' }] } = {}) {
  const file = path.join(tmpDir, `db-${counter++}.json`);
  fs.writeFileSync(file, JSON.stringify({ mappings, users }));
  await initDb(file);
}

const ITEM = {
  item_id: 'item-1',
  institution_id: 'ins_1',
  institution_name: 'First Bank',
};

const PLAID_ACCOUNT = {
  account_id: 'plaid-1',
  name: 'Checking',
  type: 'depository',
  subtype: 'checking',
};

// A mapping after a first sync: Actual account created, cursor advanced.
const ESTABLISHED_MAPPING = {
  ...ITEM,
  access_token: 'access-old',
  account_name: 'Checking',
  type: 'depository',
  subtype: 'checking',
  plaid_account_id: 'plaid-1',
  actual_account_id: 'actual-1',
  cursor: 'cursor-99',
  sync: false,
  login_required: true,
};

// `accountsGet` records its arguments so tests can assert on what was asked for.
function stubPlaid(t, { accounts = [PLAID_ACCOUNT], item = ITEM, items = [ITEM] } = {}) {
  const calls = { accountsGet: [] };
  t.mock.method(plaid, 'accountsGet', async (request) => {
    calls.accountsGet.push(request);
    return { data: { accounts, item } };
  });
  t.mock.method(plaid, 'userItemsGet', async () => ({ data: { items } }));
  return calls;
}

describe('saveAccountMappings', () => {
  beforeEach(() => openDb());

  it('stores one mapping per Plaid account, ready for the first sync', async () => {
    const saved = await saveAccountMappings(ITEM, [PLAID_ACCOUNT], 'access-new');

    assert.deepEqual(saved, [
      {
        institution_id: 'ins_1',
        institution_name: 'First Bank',
        item_id: 'item-1',
        access_token: 'access-new',
        login_required: false,
        account_name: 'Checking',
        type: 'depository',
        subtype: 'checking',
        plaid_account_id: 'plaid-1',
        actual_account_id: null,
        cursor: null,
        sync: true,
      },
    ]);
    assert.deepEqual(db.data.mappings, saved);
  });

  it('saves nothing when Plaid reports no accounts', async () => {
    const saved = await saveAccountMappings(ITEM, [], 'access-new');
    assert.deepEqual(saved, []);
    assert.deepEqual(db.data.mappings, []);
  });

  describe('re-linking an institution the user already has', () => {
    // Plaid issues a fresh item_id and token for the same accounts.
    beforeEach(() => openDb({ mappings: [{ ...ESTABLISHED_MAPPING }] }));

    it('updates the existing mapping instead of adding a second one', async () => {
      await saveAccountMappings(
        { ...ITEM, item_id: 'item-2' },
        [PLAID_ACCOUNT],
        'access-refreshed'
      );

      assert.equal(db.data.mappings.length, 1);
      assert.equal(db.data.mappings[0].item_id, 'item-2');
      assert.equal(db.data.mappings[0].access_token, 'access-refreshed');
    });

    it('keeps the Actual account and the Plaid cursor, so nothing re-imports', async () => {
      await saveAccountMappings({ ...ITEM, item_id: 'item-2' }, [PLAID_ACCOUNT], 'access-new');

      assert.equal(db.data.mappings[0].actual_account_id, 'actual-1');
      assert.equal(db.data.mappings[0].cursor, 'cursor-99');
    });

    it('keeps the user’s sync toggle', async () => {
      await saveAccountMappings({ ...ITEM, item_id: 'item-2' }, [PLAID_ACCOUNT], 'access-new');
      assert.equal(db.data.mappings[0].sync, false);
    });

    it('clears login_required, since a fresh token is a working login', async () => {
      await saveAccountMappings({ ...ITEM, item_id: 'item-2' }, [PLAID_ACCOUNT], 'access-new');
      assert.equal(db.data.mappings[0].login_required, false);
    });

    it('refreshes the name and type Plaid reports', async () => {
      await saveAccountMappings(
        ITEM,
        [{ ...PLAID_ACCOUNT, name: 'Everyday Checking', subtype: 'savings' }],
        'access-new'
      );

      assert.equal(db.data.mappings[0].account_name, 'Everyday Checking');
      assert.equal(db.data.mappings[0].subtype, 'savings');
    });

    it('still adds accounts that are genuinely new', async () => {
      await saveAccountMappings(
        ITEM,
        [PLAID_ACCOUNT, { ...PLAID_ACCOUNT, account_id: 'plaid-2', name: 'Savings' }],
        'access-new'
      );

      assert.deepEqual(
        db.data.mappings.map((m) => m.plaid_account_id),
        ['plaid-1', 'plaid-2']
      );
    });
  });
});

describe('createAccountMappings', () => {
  beforeEach(() => openDb());

  it('maps every account behind the token when given no ids', async (t) => {
    const calls = stubPlaid(t);
    const saved = await createAccountMappings('access-new');

    assert.equal(calls.accountsGet[0].access_token, 'access-new');
    assert.equal(calls.accountsGet[0].account_ids, undefined);
    assert.equal(saved.length, 1);
  });

  it('asks Plaid for only the accounts it was given', async (t) => {
    const calls = stubPlaid(t);
    await createAccountMappings('access-new', ['plaid-1']);
    assert.deepEqual(calls.accountsGet[0].account_ids, ['plaid-1']);
  });
});

describe('flagLoginRequired', () => {
  it('flags every account behind the item, and only that item', async () => {
    await openDb({
      mappings: [
        { plaid_account_id: 'a', item_id: 'item-1', login_required: false },
        { plaid_account_id: 'b', item_id: 'item-1', login_required: false },
        { plaid_account_id: 'c', item_id: 'item-2', login_required: false },
      ],
    });

    await flagLoginRequired('item-1');

    assert.deepEqual(
      db.data.mappings.map((m) => m.login_required),
      [true, true, false]
    );
  });
});

describe('ensureAllAccountMappings', () => {
  it('returns nothing to do when no Plaid user exists yet', async (t) => {
    await openDb({ users: [] });
    const userItems = t.mock.method(plaid, 'userItemsGet', async () => ({ data: { items: [] } }));

    const result = await ensureAllAccountMappings();

    assert.deepEqual(result, { success: true, errors: [], accounts: [] });
    // Nothing has ever been linked, so there is nothing to ask Plaid about.
    assert.equal(userItems.mock.callCount(), 0);
  });

  it('picks up an account opened since the last run', async (t) => {
    await openDb({ mappings: [{ ...ESTABLISHED_MAPPING }] });
    const calls = stubPlaid(t, {
      accounts: [PLAID_ACCOUNT, { ...PLAID_ACCOUNT, account_id: 'plaid-2', name: 'Savings' }],
    });

    const result = await ensureAllAccountMappings();

    assert.equal(result.success, true);
    assert.deepEqual(
      db.data.mappings.map((m) => m.plaid_account_id),
      ['plaid-1', 'plaid-2']
    );
    // One round trip per item: the accounts fetched are reused to save the row.
    assert.equal(calls.accountsGet.length, 1);
  });

  it('leaves an already-mapped account untouched', async (t) => {
    await openDb({ mappings: [{ ...ESTABLISHED_MAPPING }] });
    stubPlaid(t);

    await ensureAllAccountMappings();

    assert.equal(db.data.mappings.length, 1);
    assert.equal(db.data.mappings[0].access_token, 'access-old');
    assert.equal(db.data.mappings[0].login_required, true);
  });

  it('returns the Plaid accounts, which the sync uses for starting balances', async (t) => {
    await openDb({ mappings: [{ ...ESTABLISHED_MAPPING }] });
    stubPlaid(t);

    const { accounts } = await ensureAllAccountMappings();
    assert.deepEqual(accounts, [PLAID_ACCOUNT]);
  });

  it('skips an item it holds no access token for, and says so', async (t) => {
    // A db.json restored from an older copy while the Plaid user survived.
    await openDb({ mappings: [] });
    stubPlaid(t);
    const warn = t.mock.method(console, 'warn', () => {});

    const result = await ensureAllAccountMappings();

    // A success: failing would take every healthy item down with it.
    assert.equal(result.success, true);
    assert.deepEqual(result.accounts, []);
    assert.match(warn.mock.calls[0].arguments[0], /No access token stored for Plaid item item-1/);
  });

  it('flags a stale login as a known state rather than a failure', async (t) => {
    await openDb({ mappings: [{ ...ESTABLISHED_MAPPING, login_required: false }] });
    stubPlaid(t);
    t.mock.method(console, 'error', () => {});
    t.mock.method(plaid, 'accountsGet', async () => {
      throw { response: { data: { error_code: 'ITEM_LOGIN_REQUIRED' } } };
    });

    const result = await ensureAllAccountMappings();

    assert.equal(result.success, true);
    assert.deepEqual(result.errors, []);
    assert.equal(db.data.mappings[0].login_required, true);
  });

  it('reports a genuine failure without losing the items that worked', async (t) => {
    await openDb({
      mappings: [
        { ...ESTABLISHED_MAPPING },
        {
          ...ESTABLISHED_MAPPING,
          item_id: 'item-2',
          plaid_account_id: 'plaid-9',
          access_token: 'access-broken',
        },
      ],
    });
    stubPlaid(t, { items: [ITEM, { ...ITEM, item_id: 'item-2' }] });
    t.mock.method(console, 'error', () => {});
    t.mock.method(plaid, 'accountsGet', async ({ access_token: token }) => {
      if (token === 'access-broken') throw new Error('Plaid is down');
      return { data: { accounts: [PLAID_ACCOUNT], item: ITEM } };
    });

    const result = await ensureAllAccountMappings();

    assert.equal(result.success, false);
    assert.deepEqual(result.errors, [{ item_id: 'item-2', error: 'Plaid is down' }]);
    // The healthy item still contributed its accounts.
    assert.deepEqual(result.accounts, [PLAID_ACCOUNT]);
  });
});
