import plaid, { isLoginRequiredError } from './plaid.js';
import { config } from './config.js';
import db from './db.js';
import { getUserItems } from './user.js';
import { redact } from './redact.js';

async function flagLoginRequired(itemId) {
  await db.updateMappings(
    (m) => m.item_id === itemId,
    (m) => {
      m.login_required = true;
    }
  );
}

// Omit accountIds to get every account behind the token.
async function getItemAndAccounts(accessToken, accountIds) {
  const response = await plaid.accountsGet({
    access_token: accessToken,
    account_ids: accountIds,
  });
  if (config.debug) console.log('\nAccounts associated with token:\n', redact(response.data));
  return { accounts: response.data.accounts, item: response.data.item };
}

// Writes the given Plaid accounts to the database and returns the stored
// mappings. Separate from the fetch above so a caller that already has the
// accounts doesn't ask Plaid for them twice.
async function saveAccountMappings(item, accounts, accessToken) {
  // Belongs to the link rather than the account: re-linking issues a fresh
  // item_id and access token for the same accounts.
  const link = {
    institution_id: item.institution_id,
    institution_name: item.institution_name,
    item_id: item.item_id,
    access_token: accessToken,
    login_required: false,
  };

  const saved = [];
  await db.update(({ mappings }) => {
    for (const account of accounts) {
      const fromPlaid = {
        account_name: account.name,
        // Raw Plaid values, kept for reference. Actual has no type field.
        type: account.type,
        subtype: account.subtype,
      };

      // Re-linking a bank the user already has (rather than using Link's update
      // mode) returns the same accounts behind a new item. Adopting the token on
      // the existing row keeps its actual_account_id and cursor; a second row
      // would sync everything twice and duplicate the account in Actual.
      const existing = mappings.find((m) => m.plaid_account_id === account.account_id);
      if (existing) {
        saved.push(Object.assign(existing, link, fromPlaid));
        continue;
      }

      const mapping = {
        ...link,
        ...fromPlaid,
        plaid_account_id: account.account_id,
        actual_account_id: null, // the first sync creates the Actual account
        cursor: null,
        sync: true,
      };
      mappings.push(mapping);
      saved.push(mapping);
    }
  });

  return saved;
}

// Omit accountIds to map every account behind the token.
async function createAccountMappings(accessToken, accountIds) {
  const { accounts, item } = await getItemAndAccounts(accessToken, accountIds);
  return saveAccountMappings(item, accounts, accessToken);
}

// Picks up accounts opened at an already-linked institution since the last run.
async function reconcileItem(item) {
  const mappingWithItem = db.data.mappings.find((m) => m.item_id === item.item_id);
  // Plaid knows this item but we hold no token for it — a db.json restored from
  // an older copy while the Plaid user survived. Nothing here can recover it,
  // and throwing would take every healthy item down with it.
  if (!mappingWithItem?.access_token) {
    console.warn(
      `No access token stored for Plaid item ${item.item_id}; skipping it. ` +
        `Re-link the institution to sync its accounts again.`
    );
    return [];
  }

  const accessToken = mappingWithItem.access_token;
  const { accounts, item: fetchedItem } = await getItemAndAccounts(accessToken);
  const unmapped = accounts.filter(
    (a) => !db.data.mappings.some((m) => m.plaid_account_id === a.account_id)
  );

  if (unmapped.length > 0) {
    if (config.debug) {
      console.log(
        'Adding mapping(s) for missing accounts: ',
        unmapped.map((a) => a.account_id)
      );
    }
    await saveAccountMappings(fetchedItem, unmapped, accessToken);
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
        // Needing a re-login is a known state, not a refresh failure.
        if (isLoginRequiredError(err)) {
          console.error(`Item login required for item ${item.item_id}`);
          await flagLoginRequired(item.item_id);
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

export { createAccountMappings, saveAccountMappings, ensureAllAccountMappings, flagLoginRequired };
