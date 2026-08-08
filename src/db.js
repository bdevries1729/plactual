import { JSONFilePreset } from 'lowdb/node';
import { config } from './config.js';

// lowdb is schemaless, so the shape lives here:
//
// mappings[] — one row per Plaid account, the join between the two systems:
//   institution_id, institution_name, item_id, access_token
//   account_name, type, subtype         (type/subtype are raw Plaid values)
//   plaid_account_id, actual_account_id (null until the first sync creates it)
//   cursor                              (transactionsSync cursor, null = fetch all)
//   sync                                (user toggle)
//   login_required                      (Plaid returned ITEM_LOGIN_REQUIRED)
//   starting_balance_date               (adjustment still owed; see sync.js.
//                                        absent on older rows, meaning none owed)
//
// users[] — at most one row: { client_user_id, plaid_user_id }
const COLLECTIONS = ['mappings', 'users'];

let instance = null;

function requireInstance() {
  if (!instance) throw new Error('The database is not open; call initDb() first.');
  return instance;
}

// Opening the file is an explicit startup step rather than an import side
// effect, so modules can be loaded (and tested) without touching the disk.
async function initDb(filePath = config.dbFile) {
  try {
    // A fresh default each call: lowdb keeps it as db.data for a missing file.
    instance = await JSONFilePreset(filePath, { mappings: [], users: [] });
  } catch (err) {
    // Usually a syntax error, which would otherwise be a bare stack trace. An
    // empty file is not valid JSON, so a stray `touch db.json` lands here too.
    throw new Error(
      `Could not read the database file at ${filePath}: ${err.message}\n` +
        `Fix or delete the file and restart. Deleting it means re-linking your banks.`,
      { cause: err }
    );
  }

  // read() replaces db.data wholesale, so the defaults above never merge into an
  // existing file: one written before users[] existed, or edited by hand, can be
  // missing a key that every caller dereferences unconditionally.
  const { data } = instance;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`The database file at ${filePath} must contain a JSON object.`);
  }
  for (const key of COLLECTIONS) {
    data[key] ??= [];
    if (!Array.isArray(data[key])) {
      throw new Error(`The database file at ${filePath} has a "${key}" that is not an array.`);
    }
  }

  return db;
}

const db = {
  get data() {
    return requireInstance().data;
  },

  update(fn) {
    return requireInstance().update(fn);
  },

  // Returns how many mappings were touched, so callers can 404 on zero. These
  // are the objects callers iterate over, so their own references update too.
  async updateMappings(matches, apply) {
    let changed = 0;
    await db.update(({ mappings }) => {
      for (const mapping of mappings.filter(matches)) {
        apply(mapping);
        changed++;
      }
    });
    return changed;
  },
};

export default db;
export { initDb };
