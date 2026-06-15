import plaid from './plaid.js';
import db from './db.js';
import { config } from './config.js';

// Creates a Plaid user and saves the information in the DB, returing the generated user_id.
async function generatePlaidUserId() {
  const clientUser = crypto.randomUUID();
  if (config.debug) console.log("Creating plaid user. Will use client_user_id: ", clientUser);
  const response = await plaid.userCreate({ client_user_id: clientUser });
  if (config.debug) console.log("Create user response data:\n", response.data, "\n");
  const plaidUserId = response.data.user_id;
  db.update(({ users }) => users[0] = { client_user_id: clientUser , plaid_user_id: plaidUserId });
  return plaidUserId;
}

export { generatePlaidUserId };