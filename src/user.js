import plaid from './plaid.js';
import db from './db.js';
import { config } from './config.js';

async function createPlaidUser() {
  const clientUser = crypto.randomUUID();
  if (config.debug) console.log('Creating plaid user. Will use client_user_id: ', clientUser);
  const response = await plaid.userCreate({ client_user_id: clientUser });
  if (config.debug) console.log('Create user response data:\n', response.data, '\n');
  const plaidUserId = response.data.user_id;
  await db.update(({ users }) => {
    users[0] = { client_user_id: clientUser, plaid_user_id: plaidUserId };
  });
  return plaidUserId;
}

// Shared between concurrent callers. Two browser tabs both booting the UI each
// ask for a link token, and without this they would each create a Plaid user
// and the second would overwrite users[0]. Items linked under the lost user
// disappear from getUserItems(), which silently stops account discovery for
// them — masked by the fact that their existing mappings keep syncing off the
// access token they already hold.
let creating = null;

async function getOrCreatePlaidUserId() {
  const existing = db.data.users[0]?.plaid_user_id;
  if (existing) return existing;

  // Cleared on both paths so a failed attempt doesn't poison later ones.
  creating ??= createPlaidUser().finally(() => {
    creating = null;
  });
  return creating;
}

async function getUserItems() {
  if (db.data.users.length === 0) {
    return [];
  }
  const response = await plaid.userItemsGet({ user_id: db.data.users[0].plaid_user_id });
  if (config.debug) console.log('Get user items response:\n', response.data);
  return response.data.items;
}

export { getOrCreatePlaidUserId, getUserItems };
