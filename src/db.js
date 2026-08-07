import { JSONFilePreset } from 'lowdb/node';
import { config, fail } from './config.js';

// lowdb is schemaless, so the shape lives here:
//
// mappings[] — one row per Plaid account, the join between the two systems.
//   institution_id, institution_name, item_id, access_token
//   account_name, type, subtype        (type/subtype are raw Plaid values)
//   plaid_account_id, actual_account_id (null until the first sync creates it)
//   cursor                             (Plaid transactionsSync cursor, null = fetch all)
//   sync                               (user toggle)
//   login_required                     (set when Plaid returns ITEM_LOGIN_REQUIRED)
//
// users[] — at most one row: { client_user_id, plaid_user_id }
const dbStructure = { mappings: [], users: [] };

// A JSON syntax error here would otherwise surface as a bare stack trace during
// module loading, before any of config.js's diagnostics get a chance to run.
// Note that an empty file is not valid JSON — a stray `touch db.json` lands
// here too.
let db;
try {
  db = await JSONFilePreset(config.dbFile, dbStructure);
} catch (err) {
  fail(
    `Could not read the database file at ${config.dbFile}: ${err.message}\n` +
      `Fix or delete the file and restart. Deleting it means re-linking your banks.`
  );
}

// lowdb's read() *replaces* db.data with the file's contents, so dbStructure is
// a default for a missing file rather than a schema that gets merged in. A file
// written before users[] existed, or one edited by hand, can be missing a
// top-level key — and every read below dereferences these unconditionally.
if (db.data === null || typeof db.data !== 'object' || Array.isArray(db.data)) {
  fail(`The database file at ${config.dbFile} must contain a JSON object.`);
}
db.data.mappings ??= [];
db.data.users ??= [];

export default db;
