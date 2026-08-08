import plaid from './plaid.js';
import db from './db.js';
import { config } from './config.js';
import { redact } from './redact.js';

async function createPlaidUser() {
  const clientUser = crypto.randomUUID();
  if (config.debug) console.log('Creating plaid user. Will use client_user_id: ', clientUser);
  const response = await plaid.userCreate({ client_user_id: clientUser });
  if (config.debug) console.log('Create user response data:\n', redact(response.data), '\n');
  const plaidUserId = response.data.user_id;
  await db.update(({ users }) => {
    users[0] = { client_user_id: clientUser, plaid_user_id: plaidUserId };
  });
  return plaidUserId;
}

// Shared between concurrent callers: two browser tabs booting the UI would
// otherwise create a user each, and the second would overwrite users[0]. Items
// linked under the lost user silently drop out of getUserItems().
let creating = null;

async function getOrCreatePlaidUserId() {
  const existing = db.data.users[0]?.plaid_user_id;
  if (existing) return existing;

  // Cleared on both paths, so a failed attempt doesn't poison later ones.
  creating ??= createPlaidUser().finally(() => {
    creating = null;
  });
  return creating;
}

async function getUserItems() {
  // No user yet means nothing has ever been linked; asking Plaid with an
  // undefined user_id would be an error response rather than an empty list.
  const plaidUserId = db.data.users[0]?.plaid_user_id;
  if (!plaidUserId) return [];

  const response = await plaid.userItemsGet({ user_id: plaidUserId });
  if (config.debug) console.log('Get user items response:\n', redact(response.data));
  return response.data.items;
}

export { getOrCreatePlaidUserId, getUserItems };
