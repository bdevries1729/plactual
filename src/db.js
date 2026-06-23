import { JSONFilePreset } from 'lowdb/node';
import { config } from './config.js';

const dbStructure = { mappings: [], users: [] };

// mappings
// {
//   "institution_id": "ins_56",
//   "institution_name": "Chase",
//   "item_id": "abc123",
//   "access_token": "access-sandbox-abc123",
//   "account_name": "Plaid Checking",
//   "type": "depository",
//   "plaid_account_id": "abc123",
//   "actual_account_id": "some-uuid-thing",
//   "cursor": "abc123",
//   "sync": true
// }

// users
// {
//   "client_user_id": "some-UUID",
//   "plaid_user_id": "some-other-UUID"
// }

const db = await JSONFilePreset(config.dbFile, dbStructure);

export default db;
