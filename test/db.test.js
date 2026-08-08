import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import db, { initDb } from '../src/db.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plactual-db-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

// A fresh path per test: initDb replaces the module's open database.
let counter = 0;

function dbFile(contents) {
  const file = path.join(tmpDir, `db-${counter++}.json`);
  if (contents !== undefined) fs.writeFileSync(file, contents);
  return file;
}

const readFile = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const MAPPING = {
  plaid_account_id: 'plaid-1',
  item_id: 'item-1',
  account_name: 'Checking',
  access_token: 'access-sandbox-1',
  sync: true,
  login_required: false,
};

describe('initDb', () => {
  it('starts an empty database for a file that does not exist yet', async () => {
    await initDb(dbFile());
    assert.deepEqual(db.data, { mappings: [], users: [] });
  });

  it('does not write anything until there is something to write', async () => {
    const file = dbFile();
    await initDb(file);
    assert.equal(fs.existsSync(file), false);
  });

  it('reads an existing database', async () => {
    await initDb(dbFile(JSON.stringify({ mappings: [MAPPING], users: [{ plaid_user_id: 'u1' }] })));
    assert.equal(db.data.mappings[0].account_name, 'Checking');
    assert.equal(db.data.users[0].plaid_user_id, 'u1');
  });

  it('fills in a collection the file predates', async () => {
    // lowdb replaces db.data wholesale on read; the defaults do not merge in.
    await initDb(dbFile(JSON.stringify({ mappings: [] })));
    assert.deepEqual(db.data.users, []);
  });

  it('explains a corrupt file instead of throwing a bare parse error', async () => {
    const file = dbFile('{ not json');
    await assert.rejects(initDb(file), (err) => {
      assert.match(err.message, /Could not read the database file/);
      assert.match(err.message, /re-linking your banks/);
      assert.ok(err.cause, 'keeps the parse error as the cause');
      return true;
    });
  });

  it('rejects an empty file, which a stray `touch` leaves behind', async () => {
    await assert.rejects(initDb(dbFile('')), /Could not read the database file/);
  });

  it('rejects a file that is valid JSON but the wrong shape', async () => {
    for (const contents of ['[]', '"a string"', '42']) {
      await assert.rejects(initDb(dbFile(contents)), /must contain a JSON object/, contents);
    }
  });

  it('treats a file holding `null` as an empty database', async () => {
    // lowdb reads it as "no data yet", the same as a missing file.
    await initDb(dbFile('null'));
    assert.deepEqual(db.data, { mappings: [], users: [] });
  });

  it('rejects a collection that is not an array rather than crashing later', async () => {
    // Failing at startup names the file; `mappings.filter is not a function` does not.
    await assert.rejects(
      initDb(dbFile(JSON.stringify({ mappings: { 'plaid-1': MAPPING } }))),
      /has a "mappings" that is not an array/
    );
  });

  it('does not leak defaults between databases', async () => {
    const first = dbFile();
    await initDb(first);
    await db.update(({ mappings }) => mappings.push(MAPPING));

    await initDb(dbFile());
    assert.deepEqual(db.data.mappings, []);
  });
});

// Captured while this file loads: the only moment before a test opens one.
const beforeAnyInit = {
  read: (() => {
    try {
      return db.data && null;
    } catch (err) {
      return err;
    }
  })(),
  write: (() => {
    try {
      return db.update(() => {}) && null;
    } catch (err) {
      return err;
    }
  })(),
};

describe('using the database before initDb', () => {
  it('says what is wrong rather than dereferencing a null', () => {
    // Only reachable by wiring the startup sequence in the wrong order.
    assert.match(beforeAnyInit.read.message, /call initDb\(\) first/);
    assert.match(beforeAnyInit.write.message, /call initDb\(\) first/);
  });
});

describe('db.updateMappings', () => {
  let file;

  beforeEach(async () => {
    file = dbFile(
      JSON.stringify({
        mappings: [
          { ...MAPPING, plaid_account_id: 'plaid-1', item_id: 'item-1' },
          { ...MAPPING, plaid_account_id: 'plaid-2', item_id: 'item-1' },
          { ...MAPPING, plaid_account_id: 'plaid-3', item_id: 'item-2' },
        ],
        users: [],
      })
    );
    await initDb(file);
  });

  it('applies the change to every match and reports how many', async () => {
    const changed = await db.updateMappings(
      (m) => m.item_id === 'item-1',
      (m) => {
        m.login_required = true;
      }
    );

    assert.equal(changed, 2);
    assert.deepEqual(
      db.data.mappings.map((m) => m.login_required),
      [true, true, false]
    );
  });

  it('reports zero when nothing matches, which is what lets callers 404', async () => {
    const changed = await db.updateMappings(
      (m) => m.plaid_account_id === 'nope',
      (m) => {
        m.sync = false;
      }
    );
    assert.equal(changed, 0);
  });

  it('persists to disk, not just to memory', async () => {
    await db.updateMappings(
      (m) => m.plaid_account_id === 'plaid-2',
      (m) => {
        m.sync = false;
      }
    );

    const written = readFile(file).mappings.find((m) => m.plaid_account_id === 'plaid-2');
    assert.equal(written.sync, false);
  });

  it('updates the caller’s own reference in place', async () => {
    // sync.js holds mappings from db.data while it works through them.
    const held = db.data.mappings[0];
    await db.updateMappings(
      (m) => m.plaid_account_id === 'plaid-1',
      (m) => {
        m.cursor = 'cursor-42';
      }
    );
    assert.equal(held.cursor, 'cursor-42');
  });

  it('writes the file readable only by its owner', async (t) => {
    if (process.platform === 'win32') return t.skip('POSIX file modes only');
    // The default 0644 would expose it to every user on the host.
    process.umask(0o077);
    await db.updateMappings(
      () => true,
      (m) => {
        m.sync = true;
      }
    );
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
});
