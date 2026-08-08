import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import db, { initDb } from '../src/db.js';
import plaid from '../src/plaid.js';
import { getOrCreatePlaidUserId, getUserItems } from '../src/user.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plactual-user-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

let counter = 0;

async function openDb(users = []) {
  const file = path.join(tmpDir, `db-${counter++}.json`);
  fs.writeFileSync(file, JSON.stringify({ mappings: [], users }));
  await initDb(file);
}

describe('getOrCreatePlaidUserId', () => {
  beforeEach(() => openDb());

  it('returns the stored user without asking Plaid again', async (t) => {
    await openDb([{ client_user_id: 'client-1', plaid_user_id: 'plaid-user-1' }]);
    const userCreate = t.mock.method(plaid, 'userCreate', async () => {
      throw new Error('should not be called');
    });

    assert.equal(await getOrCreatePlaidUserId(), 'plaid-user-1');
    assert.equal(userCreate.mock.callCount(), 0);
  });

  it('creates one and stores both ids', async (t) => {
    t.mock.method(plaid, 'userCreate', async () => ({ data: { user_id: 'plaid-user-new' } }));

    assert.equal(await getOrCreatePlaidUserId(), 'plaid-user-new');
    assert.equal(db.data.users.length, 1);
    assert.equal(db.data.users[0].plaid_user_id, 'plaid-user-new');
    // The client_user_id is ours, and Plaid is asked to mint a user for it.
    assert.match(db.data.users[0].client_user_id, /^[0-9a-f-]{36}$/);
  });

  it('creates exactly one user for concurrent callers', async (t) => {
    // Two browser tabs booting the UI each ask for a link token; the second
    // create would overwrite users[0] and lose every item linked under it.
    const userCreate = t.mock.method(plaid, 'userCreate', async () => {
      await new Promise((resolve) => setImmediate(resolve));
      return { data: { user_id: 'plaid-user-new' } };
    });

    const ids = await Promise.all([
      getOrCreatePlaidUserId(),
      getOrCreatePlaidUserId(),
      getOrCreatePlaidUserId(),
    ]);

    assert.deepEqual(ids, ['plaid-user-new', 'plaid-user-new', 'plaid-user-new']);
    assert.equal(userCreate.mock.callCount(), 1);
    assert.equal(db.data.users.length, 1);
  });

  it('lets a later attempt succeed after a failed one', async (t) => {
    let attempt = 0;
    t.mock.method(plaid, 'userCreate', async () => {
      if (++attempt === 1) throw new Error('Plaid is down');
      return { data: { user_id: 'plaid-user-new' } };
    });

    await assert.rejects(getOrCreatePlaidUserId(), /Plaid is down/);
    assert.equal(await getOrCreatePlaidUserId(), 'plaid-user-new');
  });
});

describe('getUserItems', () => {
  it('returns nothing when no Plaid user has been created yet', async (t) => {
    await openDb([]);
    const userItemsGet = t.mock.method(plaid, 'userItemsGet', async () => ({
      data: { items: [] },
    }));

    assert.deepEqual(await getUserItems(), []);
    // Asking with an undefined user_id would be an error, not an empty list.
    assert.equal(userItemsGet.mock.callCount(), 0);
  });

  it('returns nothing for a half-written user row', async (t) => {
    await openDb([{ client_user_id: 'client-1' }]);
    const userItemsGet = t.mock.method(plaid, 'userItemsGet', async () => ({
      data: { items: [] },
    }));

    assert.deepEqual(await getUserItems(), []);
    assert.equal(userItemsGet.mock.callCount(), 0);
  });

  it('asks Plaid for the stored user’s items', async (t) => {
    await openDb([{ client_user_id: 'client-1', plaid_user_id: 'plaid-user-1' }]);
    const items = [{ item_id: 'item-1' }];
    const userItemsGet = t.mock.method(plaid, 'userItemsGet', async () => ({ data: { items } }));

    assert.deepEqual(await getUserItems(), items);
    assert.deepEqual(userItemsGet.mock.calls[0].arguments[0], { user_id: 'plaid-user-1' });
  });
});
