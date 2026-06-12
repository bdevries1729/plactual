import plaid from './plaid.js';
import { config } from './config.js';
import db from './db.js';

async function setUpAccountMappingsForAccessToken(accessToken) {
  const response = await plaid.accountsGet({ access_token: accessToken });
  if (config.debug) console.log("\nAccounts associated with token:\n", response.data);

  const newMappings = response.data.accounts.map(a => ({
    institution_id: response.data.item.institution_id,
    institution_name: response.data.item.institution_name,
    item_id: response.data.item.item_id,
    access_token: accessToken,
    account_name: a.name,
    type: a.type, // TODO: this may need Plaid -> Actual translation. Also the docs are kinda shakey here.
    plaid_account_id: a.account_id,
    actual_account_id: null, // this will get populated when the sync is run and the new account is created.
    cursor: null,
    sync: true
  }));

  await db.update(({ mappings}) => mappings.push(...newMappings));
  return newMappings;
}

export { setUpAccountMappingsForAccessToken };
