import api from '@actual-app/api';
import fs from 'fs';
import plaid from './plaid.js';
import db from './db.js';
import { plaidToActualTransaction, toActualAmount } from './helpers.js';
import { ensureAllAccountMappings } from './accounts.js';
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
    if (error?.response?.data?.error_code === 'ITEM_LOGIN_REQUIRED') {
      console.error('Item login required for account:', accountId);
      throw new Error('ITEM_LOGIN_REQUIRED', { cause: error });
    }
    console.error(`Error getting Plaid transactions: ${JSON.stringify(error)} Trying again.`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return fetchPlaidTransactions(accountId, accessToken, initialCursor, retriesLeft - 1);
  }
}

async function syncAccount(mapping, isNewAccount = false, preFetchedPlaidAccounts = []) {
  const {
    plaid_account_id: plaidAccountId,
    actual_account_id: actualAccountId,
    account_name: accountName,
    access_token: accessToken,
    cursor,
  } = mapping;

  const summary = { added: 0, removed: 0, modified: 0, error: null };
  const allData = await fetchPlaidTransactions(plaidAccountId, accessToken, cursor);

  if (isNewAccount) {
    const firstOfMonth = new Date();
    firstOfMonth.setDate(1);
    const firstOfMonthStr = firstOfMonth.toISOString().split('T')[0];

    const beforeFilter = allData.added.length;
    allData.added = allData.added.filter((tx) => tx.date >= firstOfMonthStr);
    if (config.debug)
      console.log(
        `Filtered ${beforeFilter - allData.added.length} historical transactions because this is a new account.`
      );
  }

  if (config.debug)
    console.log(`\nPlaid transactions fetched for plaid_account_id ${plaidAccountId}\n`, allData);

  const hasTransactions =
    allData.added.length > 0 || allData.removed.length > 0 || allData.modified.length > 0;

  if (!hasTransactions) {
    if (config.debug) console.log(`No transactions for account_name: ${accountName}`);
    if (!isNewAccount) return summary;
  } else {
    // Attempt every phase (remove / modify / add) independently so a failure in
    // one doesn't starve the others. Errors are collected here and dealt with at
    // the end rather than short-circuiting.
    let hadError = false;

    // Plaid's `removed` entries only carry the Plaid transaction_id, which we
    // store as Actual's `imported_id`. deleteTransaction needs Actual's own id,
    // so resolve imported_id -> id first (a delete on an unknown id is a no-op).
    const removedImportedIds = allData.removed.map((tx) => tx.transaction_id);
    const removedRows = removedImportedIds.length
      ? (
          await api.aqlQuery(
            api
              .q('transactions')
              .filter({ account: actualAccountId, imported_id: { $oneof: removedImportedIds } })
              .select(['id', 'imported_id'])
          )
        ).data
      : [];
    const removedActualIds = removedRows.map((r) => r.id);

    const removed = await Promise.allSettled(
      removedActualIds.map((id) => api.deleteTransaction(id))
    );
    if (config.debug) console.log('Removed:\n', removed);
    summary.removed = removed.filter((tx) => tx.status === 'fulfilled').length;
    const removedRejected = removed.filter((tx) => tx.status === 'rejected');
    if (removedRejected.length > 0) {
      hadError = true;
      console.error(
        'Unable to remove all transactions.',
        removedRejected.map((tx) => tx.reason)
      );
    }
    if (removedActualIds.length !== allData.removed.length && config.debug) {
      console.log(
        `${allData.removed.length - removedActualIds.length} removed transaction(s) were not found in Actual (already gone or never imported).`
      );
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
        const updateData = plaidToActualTransaction(actualAccountId, tx);
        delete updateData.payee_name;
        return api.updateTransaction(id, updateData);
      })
    );
    if (config.debug) console.log('Modified:\n', modified);
    if (config.debug) console.log("Modified but tx doesn't yet exist in Actual:\n", txNotThereYet);
    summary.modified = modified.filter((tx) => tx.status === 'fulfilled').length;
    const modifiedRejected = modified.filter((tx) => tx.status === 'rejected');
    if (modifiedRejected.length > 0) {
      hadError = true;
      console.error(
        'Unable to modify all transactions.',
        modifiedRejected.map((tx) => tx.reason)
      );
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
      hadError = true;
      console.error('Error importing transactions.', importResult.errors);
    }

    // If any phase failed, leave the cursor untouched so the next sync re-fetches
    // and retries the whole diff (every operation above is idempotent), and
    // surface the error so the caller doesn't report a false success.
    if (hadError) {
      summary.error = 'Sync completed with errors; will retry on next run.';
      return summary;
    }
  }

  if (config.debug)
    console.log(`Last cursor value for account ${accountName} was ${allData.nextCursor}`);
  await db.update(({ mappings }) =>
    mappings.forEach((m) => {
      if (m.plaid_account_id === plaidAccountId) m.cursor = allData.nextCursor;
    })
  );

  if (isNewAccount) {
    const plaidAccount = preFetchedPlaidAccounts.find((a) => a.account_id === plaidAccountId);
    const plaidCurrent = plaidAccount?.balances?.current;
    // Plaid's `balances.current` can be null; skip the adjustment rather than
    // producing a NaN amount from arithmetic on a null balance.
    if (plaidAccount && plaidCurrent != null) {
      let targetBalance = toActualAmount(plaidCurrent);
      if (['credit', 'loan'].includes(plaidAccount.type)) {
        targetBalance = -targetBalance;
      }

      const actualBalance = await api.getAccountBalance(actualAccountId);
      const diff = targetBalance - actualBalance;

      if (diff !== 0) {
        if (config.debug)
          console.log(
            `Adjusting initial balance by ${diff} for ${accountName} (target: ${targetBalance}, actual: ${actualBalance})`
          );
        const firstOfMonth = new Date();
        firstOfMonth.setDate(1);

        const categories = await api.getCategories();
        const startingBalanceCategory = categories.find((c) => c.name === 'Starting Balances');

        await api.addTransactions(actualAccountId, [
          {
            account: actualAccountId,
            date: firstOfMonth.toISOString().split('T')[0],
            amount: diff,
            payee_name: 'Starting Balance',
            category: startingBalanceCategory ? startingBalanceCategory.id : undefined,
            cleared: true,
          },
        ]);
        summary.added += 1;
      }
    }
  }

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

  syncRunning = true;
  const results = [];
  console.log(`\n=== Sync started at ${new Date().toISOString()} ===`);

  try {
    const { success, errors, accounts: preFetchedPlaidAccounts } = await ensureAllAccountMappings();
    if (!success) {
      console.error('Errors while ensuring account mappings:', errors);
    }

    const mappingList = db.data.mappings;
    if (!mappingList || mappingList.length === 0) {
      console.log(
        `No account mappings found. Add some via the UI or ensure the file exists at ${config.dbFile}`
      );
      return { results: [] };
    }

    console.log(`Syncing ${mappingList.length} mappings`);
    await api.init({
      verbose: config.debug,
      dataDir: config.actual.dataDir,
      serverURL: config.actual.serverUrl,
      password: config.actual.password,
    });
    await api.downloadBudget(config.actual.budgetId);

    const actualAccounts = await api.getAccounts();

    for (const mapping of mappingList) {
      if (!mapping.sync) {
        if (config.debug) console.log(`Skipping sync for ${mapping.account_name} (sync disabled)`);
        continue;
      }

      let isNewAccount = false;
      const actualAccountExists = actualAccounts.some((a) => a.id === mapping.actual_account_id);

      if (!mapping.actual_account_id || !actualAccountExists) {
        if (config.debug) console.log(`Creating Actual account for ${mapping.account_name}...`);
        // Actual's account model has no `type` field — createAccount silently
        // drops it — so we don't pass one. Instead we keep the raw Plaid
        // `type`/`subtype` on the db.json mapping (see accounts.js): a durable,
        // provider-agnostic record. If Actual ever reintroduces account types,
        // its taxonomy likely won't match Plaid's, so we map from the raw values
        // at that point rather than guessing a translation now.
        const newAccountId = await api.createAccount(
          {
            name: mapping.account_name,
            offbudget: false,
          },
          0
        );

        mapping.actual_account_id = newAccountId;
        mapping.cursor = null;
        await db.update(({ mappings }) => {
          const m = mappings.find((x) => x.plaid_account_id === mapping.plaid_account_id);
          if (m) {
            m.actual_account_id = newAccountId;
            m.cursor = null;
          }
        });
        isNewAccount = true;
      }

      try {
        const r = await syncAccount(mapping, isNewAccount, preFetchedPlaidAccounts);
        results.push({ mapping, ...r });
      } catch (err) {
        console.error(`  ✗ Failed "${mapping.account_name}": ${err.message}`);
        if (err.message === 'ITEM_LOGIN_REQUIRED') {
          await db.update(({ mappings }) => {
            mappings
              .filter((m) => m.item_id === mapping.item_id)
              .forEach((m) => {
                m.login_required = true;
              });
          });
        }
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
