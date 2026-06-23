import api from '@actual-app/api';
import fs from 'fs';
import plaid from './plaid.js';
import db from './db.js';
import { plaidToActualTransaction } from './helpers.js';
import { config } from './config.js';

// Fetch new transactions for an account. Pass initialCursor=null to fetch all transactions.
async function fetchPlaidTransactions(accountId, accessToken, initialCursor, retriesLeft = 3) {
  const allData = {
    added: [],
    removed: [],
    modified: [],
    nextCursor: initialCursor,
  };
  if (retriesLeft <= 0) {
    console.error('Too many retries!');
    return allData; // Return no data and keep our original cursor for use later.
  }
  try {
    let hasMore = false;
    do {
      const results = await plaid.transactionsSync({
        access_token: accessToken,
        cursor: allData.nextCursor,
        options: {
          account_id: accountId,
        },
      });
      const newData = results.data;
      allData.added = allData.added.concat(newData.added);
      allData.modified = allData.modified.concat(newData.modified);
      allData.removed = allData.removed.concat(newData.removed);
      allData.nextCursor = newData.next_cursor || null;
      hasMore = newData.has_more;
    } while (hasMore);
    return allData;
  } catch (error) {
    console.error(`Error getting Plaid transactions: ${JSON.stringify(error)} Trying again.`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return fetchPlaidTransactions(accountId, accessToken, initialCursor, retriesLeft - 1);
  }
}

async function syncAccount(mapping) {
  const {
    plaid_account_id: plaidAccountId,
    actual_account_id: actualAccountId,
    account_name: accountName,
    access_token: accessToken,
    cursor,
  } = mapping;

  const summary = { added: 0, removed: 0, modified: 0 };
  const allData = await fetchPlaidTransactions(plaidAccountId, accessToken, cursor);
  if (config.debug)
    console.log(`\nPlaid transactions fetched for plaid_account_id ${plaidAccountId}\n`, allData);

  if (allData.added.length === 0 && allData.removed.length === 0 && allData.modified.length === 0) {
    if (config.debug) console.log(`No transactions for account_name: ${accountName}`);
    return summary;
  }

  const removed = await Promise.allSettled(
    allData.removed.map((tx) => api.deleteTransaction(tx.transaction_id))
  );
  if (config.debug) console.log('Removed:\n', removed);
  summary.removed = removed.filter((tx) => tx.status === 'fulfilled').length;
  if (summary.removed !== allData.removed.length) {
    console.error(
      'Unable to remove all transactions.',
      removed.filter((tx) => tx.status === 'rejected').map((tx) => tx.reason)
    );
    return summary;
  }

  const txNotThereYet = [];
  const modified = await Promise.allSettled(
    allData.modified.map(async (tx) => {
      const dateBefore = new Date(tx.date);
      dateBefore.setDate(dateBefore.getDate() - 7);
      const dateAfter = new Date(tx.date);
      dateAfter.setDate(dateAfter.getDate() + 7);
      const txList = await api.getTransactions(
        actualAccountId,
        dateBefore.toISOString().split('T')[0],
        dateAfter.toISOString().split('T')[0]
      );
      const id = txList.find((t) => t.imported_id === tx.transaction_id)?.id;
      if (!id) {
        txNotThereYet.push(tx);
        return;
      }
      return api.updateTransaction(id, plaidToActualTransaction(actualAccountId, tx));
    })
  );
  if (config.debug) console.log('Modified:\n', modified);
  if (config.debug) console.log("Modified but tx doesn't yet exist in Actual:\n", txNotThereYet);
  summary.modified = modified.filter((tx) => tx.status === 'fulfilled').length;
  const modifiedRejected = modified.filter((tx) => tx.status === 'rejected');
  if (modifiedRejected.length > 0) {
    console.error(
      'Unable to modify all transactions.',
      modifiedRejected.map((tx) => tx.reason)
    );
    return summary;
  }

  const addedOrModifiedButNotThere = [...txNotThereYet, ...allData.added].map((tx) =>
    plaidToActualTransaction(actualAccountId, tx)
  );
  const importResult = await api.importTransactions(actualAccountId, addedOrModifiedButNotThere, {
    reimportDeleted: false,
  });
  if (config.debug) console.log('Import result on addedOrNotYetThere:\n', modified);
  summary.added = importResult.added.length;
  summary.modified += importResult.updated.length;
  if (importResult.errors.length > 0) {
    console.error('Error importing transactions.', importResult.errors);
    return summary;
  }

  if (config.debug)
    console.log(`Last cursor value for account ${accountName} was ${allData.nextCursor}`);
  await db.update(({ mappings }) =>
    mappings.forEach((m) => {
      if (m.plaid_account_id === plaidAccountId) m.cursor = allData.nextCursor;
    })
  );

  console.log(
    `  ✓ ${summary.added} added, ${summary.modified} modified, ${summary.removed} removed (${accountName})`
  );
  return summary;
}

// ------------- Run Full Sync -------------

let syncRunning = false;

async function runSync() {
  if (syncRunning) {
    console.log('Sync already in progress, skipping.');
    return null;
  }

  if (!fs.existsSync(config.actual.dataDir)) {
    console.error(`Actual Budget data directory does not exist: ${config.actual.dataDir}`);
    return { results: [] };
  }

  const mappingList = db.data.mappings;
  if (!mappingList || mappingList.length === 0) {
    console.log(
      `No account mappings found. Add some via the UI or ensure the file exists at ${config.dbFile}`
    );
    return { results: [] };
  }

  syncRunning = true;
  const results = [];
  console.log(
    `\n=== Sync started at ${new Date().toISOString()} (${mappingList.length} accounts) ===`
  );

  try {
    await api.init({
      verbose: config.debug,
      dataDir: config.actual.dataDir,
      serverURL: config.actual.serverUrl,
      password: config.actual.password,
    });
    await api.downloadBudget(config.actual.budgetId);

    for (const mapping of mappingList) {
      try {
        const r = await syncAccount(mapping);
        results.push({ mapping, ...r, error: null });
      } catch (err) {
        console.error(`  ✗ Failed "${mapping.account_name}": ${err.message}`);
        results.push({ mapping, added: 0, modified: 0, removed: 0, error: err.message });
      }
    }

    await api.shutdown();
    console.log('=== Sync complete ===\n');
  } finally {
    syncRunning = false;
  }

  return { results };
}

export { runSync };
