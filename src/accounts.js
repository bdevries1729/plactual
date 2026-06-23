import plaid from './plaid.js';
import { config } from './config.js';
import db from './db.js';
import { getUserItems } from './user.js';

// if accountIds is undefined, create mappings for all accounts associated with accessToken.
// otherwise, create mappings only for the accounts with the given accountIds.
async function createAccountMappings(accessToken, accountIds = undefined) {
  const { accounts, item } = await getItemAndAccounts(accessToken, accountIds);

  const newMappings = accounts.map((a) => ({
    institution_id: item.institution_id,
    institution_name: item.institution_name,
    item_id: item.item_id,
    access_token: accessToken,
    account_name: a.name,
    type: a.type,
    subtype: a.subtype,
    plaid_account_id: a.account_id,
    actual_account_id: null, // this will get populated when the sync is run and the new account is created.
    cursor: null,
    sync: true,
  }));

  await db.update(({ mappings }) => mappings.push(...newMappings));
  return newMappings;
}

// if accountIds is undefined, get all accounts. otherwise, get only the accounts with the given accountIds.
async function getItemAndAccounts(accessToken, accountIds = undefined) {
  const response = await plaid.accountsGet({
    access_token: accessToken,
    account_ids: accountIds,
  });
  if (config.debug) console.log('\nAccounts associated with token:\n', response.data);
  return { accounts: response.data.accounts, item: response.data.item };
}

async function ensureAllAccountMappings() {
  const items = await getUserItems();

  const results = await Promise.all(
    items.map(async (item) => {
      try {
        const mappingWithItem = db.data.mappings.find((m) => m.item_id === item.item_id);
        if (!mappingWithItem) {
          throw new Error(`Could not find mapping with item ${item.item_id}.`);
        }

        const accessToken = mappingWithItem.access_token;
        if (!accessToken) {
          throw new Error(`Could not find access token for item ${item.item_id}.`);
        }

        const { accounts } = await getItemAndAccounts(accessToken);
        const unmappedAccounts = accounts
          .filter((a) => !db.data.mappings.some((m) => m.plaid_account_id === a.account_id))
          .map((a) => a.account_id);

        if (unmappedAccounts.length > 0) {
          if (config.debug)
            console.log('Adding mapping(s) for missing accounts: ', unmappedAccounts);
          await createAccountMappings(accessToken, unmappedAccounts);
        }
        return { item_id: item.item_id, success: true, accounts };
      } catch (err) {
        console.error(`Error processing item ${item.item_id}:`, err);
        return { item_id: item.item_id, success: false, error: err.message };
      }
    })
  );

  const failed = results.filter((r) => !r.success);
  const allAccounts = results.filter((r) => r.success).flatMap((r) => r.accounts);
  return {
    success: failed.length === 0,
    errors: failed.map((f) => ({ item_id: f.item_id, error: f.error })),
    accounts: allAccounts,
  };
}

export { createAccountMappings, getItemAndAccounts, ensureAllAccountMappings };
