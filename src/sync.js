import api from '@actual-app/api';
import plaid, { isLoginRequiredError, plaidErrorMessage } from './plaid.js';
import db from './db.js';
import { plaidToActualTransaction, toActualAmount, toDateString, firstOfMonth } from './helpers.js';
import { ensureAllAccountMappings, flagLoginRequired } from './accounts.js';
import { withBudget } from './actual.js';
import { config, ensureDataDirs } from './config.js';

const FETCH_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class ItemLoginRequiredError extends Error {
  constructor(options) {
    super('ITEM_LOGIN_REQUIRED', options);
    this.name = 'ItemLoginRequiredError';
  }
}

// Run operations independently so one failure doesn't starve the rest.
async function settleAll(promises) {
  const results = await Promise.allSettled(promises);
  return {
    count: results.filter((r) => r.status === 'fulfilled').length,
    failures: results.filter((r) => r.status === 'rejected').map((r) => r.reason),
  };
}

// Updates the caller's own mapping object in place as well as persisting it.
function setMappingFields(plaidAccountId, fields) {
  return db.updateMappings(
    (m) => m.plaid_account_id === plaidAccountId,
    (m) => Object.assign(m, fields)
  );
}

// Pass initialCursor=null to fetch every transaction Plaid has for the account.
async function fetchPlaidTransactions(accountId, accessToken, initialCursor) {
  let lastError;

  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    // Each attempt restarts from the original cursor.
    const changes = { added: [], removed: [], modified: [], nextCursor: initialCursor };
    try {
      let hasMore;
      do {
        const { data } = await plaid.transactionsSync({
          access_token: accessToken,
          cursor: changes.nextCursor,
          options: { account_id: accountId },
        });
        changes.added.push(...data.added);
        changes.modified.push(...data.modified);
        changes.removed.push(...data.removed);
        // Only advance on a real cursor: a null one means "fetch all history"
        // downstream, which would restart the account from scratch.
        if (data.next_cursor) changes.nextCursor = data.next_cursor;
        hasMore = data.has_more;
        // Paging on an unchanged cursor would loop forever against Plaid.
        if (hasMore && !data.next_cursor) {
          throw new Error(`Plaid reported more pages but returned no cursor for ${accountId}`);
        }
      } while (hasMore);
      return changes;
    } catch (error) {
      // A stale login won't fix itself by retrying.
      if (isLoginRequiredError(error)) throw new ItemLoginRequiredError({ cause: error });

      lastError = error;
      console.error(
        `Error fetching Plaid transactions for ${accountId} ` +
          `(attempt ${attempt}/${FETCH_ATTEMPTS}): ${plaidErrorMessage(error)}`
      );
      if (attempt < FETCH_ATTEMPTS) await delay(RETRY_DELAY_MS * attempt);
    }
  }

  // Returning empty data here would look like a clean sync and hide the failure.
  throw new Error(
    `Could not fetch Plaid transactions for account ${accountId} after ` +
      `${FETCH_ATTEMPTS} attempts: ${plaidErrorMessage(lastError)}`,
    { cause: lastError }
  );
}

// Plaid's `removed` and `modified` entries carry only the Plaid transaction_id,
// stored on the Actual side as `imported_id`. Resolves a batch of them to Actual
// ids in one query.
async function findByImportedId(actualAccountId, plaidTransactionIds) {
  if (plaidTransactionIds.length === 0) return new Map();

  const { data: rows } = await api.aqlQuery(
    api
      .q('transactions')
      .filter({ account: actualAccountId, imported_id: { $oneof: plaidTransactionIds } })
      .select(['id', 'imported_id'])
  );
  return new Map(rows.map((row) => [row.imported_id, row.id]));
}

async function removeTransactions(actualAccountId, removed) {
  const ids = await findByImportedId(
    actualAccountId,
    removed.map((tx) => tx.transaction_id)
  );

  if (ids.size !== removed.length && config.debug) {
    console.log(
      `${removed.length - ids.size} removed transaction(s) were not found in Actual ` +
        `(already gone or never imported).`
    );
  }

  return settleAll([...ids.values()].map((id) => api.deleteTransaction(id)));
}

// Modified transactions we can't find in Actual yet are returned as
// `notYetImported` so the caller can import them as additions instead.
async function applyModifications(actualAccountId, modified) {
  const ids = await findByImportedId(
    actualAccountId,
    modified.map((tx) => tx.transaction_id)
  );

  const applied = await settleAll(
    modified
      .filter((tx) => ids.has(tx.transaction_id))
      .map((tx) => {
        // payee_name is only accepted when creating a transaction, not updating one.
        const { payee_name: _payeeName, ...fields } = plaidToActualTransaction(actualAccountId, tx);
        return api.updateTransaction(ids.get(tx.transaction_id), fields);
      })
  );

  return {
    ...applied,
    notYetImported: modified.filter((tx) => !ids.has(tx.transaction_id)),
  };
}

// A new Actual account starts at zero with only the current month's history, so
// book the difference as a "Starting Balance" transaction. Returns how many
// transactions were added.
//
// Still-owed is tracked on the mapping as `starting_balance_date` rather than
// off `isNewAccount`, which would allow exactly one attempt: a run that couldn't
// finish would leave the account permanently out of step with the bank.
async function adjustStartingBalance(mapping, plaidAccount) {
  const {
    plaid_account_id: plaidAccountId,
    actual_account_id: actualAccountId,
    account_name: accountName,
    starting_balance_date: startingBalanceDate,
  } = mapping;

  // Both the balance and the account itself can be missing — an item that
  // wasn't reconciled this run contributes no accounts. Leave the flag set and
  // retry next run rather than booking a NaN transaction.
  const plaidCurrent = plaidAccount?.balances?.current;
  if (plaidCurrent == null) {
    console.error(
      `  ! No Plaid balance available for "${accountName}"; its Actual balance will not match ` +
        `the bank until a later sync completes the starting-balance adjustment.`
    );
    return 0;
  }

  // Plaid reports credit and loan balances as a positive amount owed; Actual
  // expects those as a negative balance.
  const owed = ['credit', 'loan'].includes(plaidAccount.type);
  const targetBalance = owed ? -toActualAmount(plaidCurrent) : toActualAmount(plaidCurrent);

  const actualBalance = await api.getAccountBalance(actualAccountId);
  const diff = targetBalance - actualBalance;
  if (diff === 0) {
    // Already reconciled: nothing to book, nothing left to retry.
    await setMappingFields(plaidAccountId, { starting_balance_date: null });
    return 0;
  }

  if (config.debug) {
    console.log(
      `Adjusting initial balance by ${diff} for ${accountName} ` +
        `(target: ${targetBalance}, actual: ${actualBalance})`
    );
  }

  const categories = await api.getCategories();
  await api.addTransactions(actualAccountId, [
    {
      account: actualAccountId,
      // When the account was created, not today: a retry that succeeds a month
      // later must not file the adjustment after what it should precede.
      date: startingBalanceDate,
      amount: diff,
      payee_name: 'Starting Balance',
      category: categories.find((c) => c.name === 'Starting Balances')?.id,
      cleared: true,
    },
  ]);
  // Cleared last, so a throw above leaves the job for the next run.
  await setMappingFields(plaidAccountId, { starting_balance_date: null });
  return 1;
}

async function syncAccount(mapping, isNewAccount, plaidAccounts) {
  const {
    plaid_account_id: plaidAccountId,
    actual_account_id: actualAccountId,
    account_name: accountName,
    access_token: accessToken,
    cursor,
  } = mapping;

  const summary = { added: 0, removed: 0, modified: 0, error: null };
  const changes = await fetchPlaidTransactions(plaidAccountId, accessToken, cursor);

  // A successful fetch proves the login works, even if the reconnect happened
  // outside the UI — resolve_login is otherwise the only thing that clears this.
  if (mapping.login_required) {
    await setMappingFields(plaidAccountId, { login_required: false });
  }

  // A missing amount would import as $0.00. Dropped rather than failed: a
  // failure holds the cursor back, stalling the account on the same rows.
  const unusable = [...changes.added, ...changes.modified].filter((tx) => tx.amount == null);
  if (unusable.length > 0) {
    console.error(
      `  ! Skipped ${unusable.length} Plaid transaction(s) with no amount for "${accountName}":`,
      unusable.map((tx) => tx.transaction_id)
    );
    changes.added = changes.added.filter((tx) => tx.amount != null);
    changes.modified = changes.modified.filter((tx) => tx.amount != null);
  }

  if (config.debug) {
    console.log(`\nPlaid transactions fetched for plaid_account_id ${plaidAccountId}\n`, changes);
  }

  // Every phase runs independently; errors are dealt with at the end.
  const failures = [];

  const removed = await removeTransactions(actualAccountId, changes.removed);
  summary.removed = removed.count;
  failures.push(...removed.failures);

  const modified = await applyModifications(actualAccountId, changes.modified);
  summary.modified = modified.count;
  failures.push(...modified.failures);

  // Modifications we couldn't find are imported as additions, so the new-account
  // cutoff applies to the combined list — history could otherwise slip in here.
  let toImport = [...modified.notYetImported, ...changes.added];
  if (isNewAccount) {
    const cutoff = toDateString(firstOfMonth());
    const before = toImport.length;
    toImport = toImport.filter((tx) => tx.date >= cutoff);
    if (config.debug) {
      console.log(
        `Filtered ${before - toImport.length} historical transactions ` +
          `because this is a new account.`
      );
    }
  }

  if (toImport.length > 0) {
    const imported = await api.importTransactions(
      actualAccountId,
      toImport.map((tx) => plaidToActualTransaction(actualAccountId, tx)),
      { reimportDeleted: false }
    );
    if (config.debug) console.log('Import result:\n', imported);
    summary.added = imported.added.length;
    summary.modified += imported.updated.length;
    failures.push(...imported.errors);
  }

  // Leave the cursor untouched so the next run retries the whole diff; every
  // operation above is idempotent.
  if (failures.length > 0) {
    console.error(`  ✗ Errors syncing "${accountName}":`, failures);
    summary.error = 'Sync completed with errors; will retry on next run.';
    return summary;
  }

  await setMappingFields(plaidAccountId, { cursor: changes.nextCursor });

  if (mapping.starting_balance_date) {
    const plaidAccount = plaidAccounts.find((a) => a.account_id === plaidAccountId);
    summary.added += await adjustStartingBalance(mapping, plaidAccount);
  }

  console.log(
    `  ✓ ${summary.added} added, ${summary.modified} modified, ` +
      `${summary.removed} removed (${accountName})`
  );
  return summary;
}

// Creates the Actual account if missing, then syncs. Never throws: a failing
// account is reported alongside the ones that worked.
async function syncMapping(mapping, actualAccounts, plaidAccounts) {
  // Only these two fields: the mapping also holds the institution's access
  // token, and /sync serialises these results straight to the browser.
  const identity = {
    account_name: mapping.account_name,
    plaid_account_id: mapping.plaid_account_id,
  };
  const nothingDone = { added: 0, modified: 0, removed: 0 };

  try {
    const actualAccountExists = actualAccounts.some((a) => a.id === mapping.actual_account_id);
    const isNewAccount = !mapping.actual_account_id || !actualAccountExists;

    if (isNewAccount) {
      if (config.debug) console.log(`Creating Actual account for ${mapping.account_name}...`);
      // No `type`: Actual's account model has no such field and drops it. The
      // raw Plaid type/subtype live on the mapping instead.
      const actualAccountId = await api.createAccount(
        { name: mapping.account_name, offbudget: false },
        0
      );
      await setMappingFields(mapping.plaid_account_id, {
        actual_account_id: actualAccountId,
        cursor: null,
        // Pending until adjustStartingBalance succeeds.
        starting_balance_date: toDateString(firstOfMonth()),
      });
    }

    return { ...identity, ...(await syncAccount(mapping, isNewAccount, plaidAccounts)) };
  } catch (err) {
    console.error(`  ✗ Failed "${mapping.account_name}": ${err.message}`);
    if (err instanceof ItemLoginRequiredError) await flagLoginRequired(mapping.item_id);
    return { ...identity, ...nothingDone, error: err.message };
  }
}

let syncRunning = false;

// Read by the shutdown handler, which waits for an in-flight sync.
function isSyncRunning() {
  return syncRunning;
}

async function runSync() {
  if (syncRunning) {
    console.log('Sync already in progress, skipping.');
    return null;
  }

  // In case something removed them since startup.
  ensureDataDirs();

  syncRunning = true;
  console.log(`\n=== Sync started at ${new Date().toISOString()} ===`);

  try {
    const { success, errors, accounts: plaidAccounts } = await ensureAllAccountMappings();
    if (!success) console.error('Errors while ensuring account mappings:', errors);

    const mappings = db.data.mappings;
    if (mappings.length === 0) {
      console.log(
        `No account mappings found. Add some via the UI or ensure the file exists at ${config.dbFile}`
      );
      return { results: [] };
    }

    console.log(`Syncing ${mappings.length} mappings`);

    const results = await withBudget(async () => {
      const actualAccounts = await api.getAccounts();
      const collected = [];

      for (const mapping of mappings) {
        if (!mapping.sync) {
          if (config.debug) {
            console.log(`Skipping sync for ${mapping.account_name} (sync disabled)`);
          }
          continue;
        }
        collected.push(await syncMapping(mapping, actualAccounts, plaidAccounts));
      }

      return collected;
    });

    console.log('=== Sync complete ===\n');
    return { results };
  } finally {
    syncRunning = false;
  }
}

export { runSync, isSyncRunning };
