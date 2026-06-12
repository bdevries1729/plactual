import { JSONFilePreset } from 'lowdb/node';
import { config } from './config.js';

const dbStructure = { mappings: [] }

// mappings look like this:
// {
//   "actual_account_id": "5caffa7e-0a53-425e-aff5-cda3e6e11557",
//   "plaid_account_id": "5mLoXqqxQLt519bPLznKTWnn3E4nzRS5wLqEa",
//   "account_name": "Plaid Checking",
//   "access_token": "access-sandbox-abc123",
//   "cursor": abc1234
// }

const db = await JSONFilePreset(config.dbFile, dbStructure)

export default db