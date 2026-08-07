import { JSONFilePreset } from 'lowdb/node';
import { config } from './config.js';

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

const db = await JSONFilePreset(config.dbFile, dbStructure);

export default db;
