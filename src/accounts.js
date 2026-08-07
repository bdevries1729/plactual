import plaid from './plaid.js';
import { config } from './config.js';
import db from './db.js';
import { getUserItems } from './user.js';

// Plaid signals a stale bank login with this code. It is a normal, expected
// state rather than a failure: the affected mappings get flagged so the UI can
// offer Plaid Link's update mode.
function isLoginRequiredError(error) {
  return error?.response?.data?.error_code === 'ITEM_LOGIN_REQUIRED';
}

async function flagLoginRequired(itemId) {
  await db.update(({ mappings }) => {
    mappings
      .filter((m) => m.item_id === itemId)
      .forEach((m) => {
        m.login_required = true;
      });
  });
}

// Omit accountIds to get every account behind the token.
async function getItemAndAccounts(accessToken, accountIds) {
  const response = await plaid.accountsGet({
    access_token: accessToken,
    account_ids: accountIds,
  });
  if (config.debug) console.log('\nAccounts associated with token:\n', response.data);
  return { accounts: response.data.accounts, item: response.data.item };
}

// Omit accountIds to map every account behind the token.
async function createAccountMappings(accessToken, accountIds) {
  const { accounts, item } = await getItemAndAccounts(accessToken, accountIds);

  const newMappings = accounts.map((a) => ({
    institution_id: item.institution_id,
    institution_name: item.institution_name,
    item_id: item.item_id,
    access_token: accessToken,
    account_name: a.name,
    // Raw Plaid values. Actual has no account type field, so these are never
    // sent to it; they're kept as a durable, provider-agnostic record in case
    // it reintroduces account types with a taxonomy of its own.
    type: a.type,
    subtype: a.subtype,
    plaid_account_id: a.account_id,
    actual_account_id: null, // populated by the first sync, which creates the Actual account
    cursor: null,
    sync: true,
    login_required: false,
  }));

  await db.update(({ mappings }) => mappings.push(...newMappings));
  return newMappings;
}

// Picks up accounts opened at an already-linked institution since the last run.
async function reconcileItem(item) {
  const mappingWithItem = db.data.mappings.find((m) => m.item_id === item.item_id);
  if (!mappingWithItem) {
    throw new Error(`Could not find mapping with item ${item.item_id}.`);
  }

  const accessToken = mappingWithItem.access_token;
  if (!accessToken) {
    throw new Error(`Could not find access token for item ${item.item_id}.`);
  }

  const { accounts } = await getItemAndAccounts(accessToken);
  const unmapped = accounts
    .filter((a) => !db.data.mappings.some((m) => m.plaid_account_id === a.account_id))
    .map((a) => a.account_id);

  if (unmapped.length > 0) {
    if (config.debug) console.log('Adding mapping(s) for missing accounts: ', unmapped);
    await createAccountMappings(accessToken, unmapped);
  }

  return accounts;
}

async function ensureAllAccountMappings() {
  const items = await getUserItems();

  const results = await Promise.all(
    items.map(async (item) => {
      try {
        return { item_id: item.item_id, success: true, accounts: await reconcileItem(item) };
      } catch (err) {
        if (isLoginRequiredError(err)) {
          console.error(`Item login required for item ${item.item_id}`);
          await flagLoginRequired(item.item_id);
          // Needing a re-login is a known state, not a refresh failure.
          return { item_id: item.item_id, success: true, accounts: [] };
        }
        console.error(`Error processing item ${item.item_id}:`, err);
        return { item_id: item.item_id, success: false, error: err.message };
      }
    })
  );

  const failed = results.filter((r) => !r.success);
  return {
    success: failed.length === 0,
    errors: failed.map((f) => ({ item_id: f.item_id, error: f.error })),
    accounts: results.filter((r) => r.success).flatMap((r) => r.accounts),
  };
}

export { createAccountMappings, ensureAllAccountMappings, flagLoginRequired, isLoginRequiredError };
