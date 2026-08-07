import api from '@actual-app/api';
import plaid from './plaid.js';
import db from './db.js';
import {
  plaidToActualTransaction,
  toActualAmount,
  toDateString,
  firstOfMonth,
  addDays,
} from './helpers.js';
import { ensureAllAccountMappings, flagLoginRequired, isLoginRequiredError } from './accounts.js';
import { config, ensureDataDirs } from './config.js';

const FETCH_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1000;
// Plaid's `modified` entries carry no Actual id, so we search a window either
// side of the transaction date for the row we previously imported.
const MODIFIED_SEARCH_WINDOW_DAYS = 7;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class ItemLoginRequiredError extends Error {
  constructor(options) {
    super('ITEM_LOGIN_REQUIRED', options);
    this.name = 'ItemLoginRequiredError';
  }
}

// Axios errors stringify to "{}", so pull out what Plaid actually said.
function plaidErrorMessage(error) {
  return error?.response?.data?.error_message || error?.message || 'unknown error';
}

// Run operations independently so one failure doesn't starve the rest.
async function settleAll(promises) {
  const results = await Promise.allSettled(promises);
  return {
    count: results.filter((r) => r.status === 'fulfilled').length,
    failures: results.filter((r) => r.status === 'rejected').map((r) => r.reason),
  };
}

// db.data.mappings holds the very objects callers iterate over, so this both
// updates the caller's mapping in place and persists it.
async function setMappingFields(plaidAccountId, fields) {
  await db.update(({ mappings }) => {
    const mapping = mappings.find((m) => m.plaid_account_id === plaidAccountId);
    if (mapping) Object.assign(mapping, fields);
  });
}

// Pass initialCursor=null to fetch every transaction Plaid has for the account.
async function fetchPlaidTransactions(accountId, accessToken, initialCursor) {
  let lastError;

  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    // Each attempt restarts from the original cursor, so start with a clean slate.
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
        changes.nextCursor = data.next_cursor || null;
        hasMore = data.has_more;
      } while (hasMore);
      return changes;
    } catch (error) {
      // A stale login won't fix itself by retrying; surface it immediately so
      // the item gets flagged for reconnection.
      if (isLoginRequiredError(error)) throw new ItemLoginRequiredError({ cause: error });

      lastError = error;
      console.error(
        `Error fetching Plaid transactions for ${accountId} ` +
          `(attempt ${attempt}/${FETCH_ATTEMPTS}): ${plaidErrorMessage(error)}`
      );
      if (attempt < FETCH_ATTEMPTS) await delay(RETRY_DELAY_MS * attempt);
    }
  }

  // Give up loudly. Returning empty data here would look like a clean sync and
  // hide the failure from both the logs and the UI.
  throw new Error(
    `Could not fetch Plaid transactions for account ${accountId} after ` +
      `${FETCH_ATTEMPTS} attempts: ${plaidErrorMessage(lastError)}`,
    { cause: lastError }
  );
}

// Plaid's `removed` entries only carry the Plaid transaction_id, which we store
// as Actual's `imported_id`. deleteTransaction needs Actual's own id, so resolve
// imported_id -> id first.
async function removeTransactions(actualAccountId, removed) {
  if (removed.length === 0) return { count: 0, failures: [] };

  const importedIds = removed.map((tx) => tx.transaction_id);
  const { data: rows } = await api.aqlQuery(
    api
      .q('transactions')
      .filter({ account: actualAccountId, imported_id: { $oneof: importedIds } })
      .select(['id', 'imported_id'])
  );

  if (rows.length !== removed.length && config.debug) {
    console.log(
      `${removed.length - rows.length} removed transaction(s) were not found in Actual ` +
        `(already gone or never imported).`
    );
  }

  return settleAll(rows.map((row) => api.deleteTransaction(row.id)));
}

// Modified transactions we can't find in Actual yet are returned as
// `notYetImported` so the caller can import them as additions instead.
async function applyModifications(actualAccountId, modified) {
  const notYetImported = [];
  const found = [];

  const lookups = await Promise.allSettled(
    modified.map(async (tx) => {
      const date = new Date(tx.date);
      const txList = await api.getTransactions(
        actualAccountId,
        toDateString(addDays(date, -MODIFIED_SEARCH_WINDOW_DAYS)),
        toDateString(addDays(date, MODIFIED_SEARCH_WINDOW_DAYS))
      );
      const id = txList.find((t) => t.imported_id === tx.transaction_id)?.id;
      if (id) found.push({ id, tx });
      else notYetImported.push(tx);
    })
  );

  const applied = await settleAll(
    found.map(({ id, tx }) => {
      // payee_name is only accepted when creating a transaction, not updating one.
      const { payee_name: _payeeName, ...fields } = plaidToActualTransaction(actualAccountId, tx);
      return api.updateTransaction(id, fields);
    })
  );

  return {
    count: applied.count,
    failures: [
      ...lookups.filter((r) => r.status === 'rejected').map((r) => r.reason),
      ...applied.failures,
    ],
    notYetImported,
  };
}

// A freshly created Actual account starts at zero and only gets the current
// month's history, so book the difference as a "Starting Balance" transaction to
// line it up with the balance Plaid reports. Returns the number of transactions
// added.
async function adjustStartingBalance(mapping, plaidAccount) {
  const { actual_account_id: actualAccountId, account_name: accountName } = mapping;

  // `balances.current` can be null; skip the adjustment rather than doing
  // arithmetic on it and booking a NaN transaction.
  const plaidCurrent = plaidAccount?.balances?.current;
  if (plaidCurrent == null) return 0;

  // Plaid reports credit and loan balances as a positive amount owed; Actual
  // expects those as a negative balance.
  const owed = ['credit', 'loan'].includes(plaidAccount.type);
  const targetBalance = owed ? -toActualAmount(plaidCurrent) : toActualAmount(plaidCurrent);

  const actualBalance = await api.getAccountBalance(actualAccountId);
  const diff = targetBalance - actualBalance;
  if (diff === 0) return 0;

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
      date: toDateString(firstOfMonth()),
      amount: diff,
      payee_name: 'Starting Balance',
      category: categories.find((c) => c.name === 'Starting Balances')?.id,
      cleared: true,
    },
  ]);
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

  if (isNewAccount) {
    const cutoff = toDateString(firstOfMonth());
    const before = changes.added.length;
    changes.added = changes.added.filter((tx) => tx.date >= cutoff);
    if (config.debug) {
      console.log(
        `Filtered ${before - changes.added.length} historical transactions ` +
          `because this is a new account.`
      );
    }
  }

  if (config.debug) {
    console.log(`\nPlaid transactions fetched for plaid_account_id ${plaidAccountId}\n`, changes);
  }

  // Attempt every phase independently so a failure in one doesn't starve the
  // others. Errors are collected and dealt with at the end.
  const failures = [];

  const removed = await removeTransactions(actualAccountId, changes.removed);
  summary.removed = removed.count;
  failures.push(...removed.failures);

  const modified = await applyModifications(actualAccountId, changes.modified);
  summary.modified = modified.count;
  failures.push(...modified.failures);

  const toImport = [...modified.notYetImported, ...changes.added].map((tx) =>
    plaidToActualTransaction(actualAccountId, tx)
  );
  if (toImport.length > 0) {
    const imported = await api.importTransactions(actualAccountId, toImport, {
      reimportDeleted: false,
    });
    if (config.debug) console.log('Import result:\n', imported);
    summary.added = imported.added.length;
    summary.modified += imported.updated.length;
    failures.push(...imported.errors);
  }

  // If any phase failed, leave the cursor untouched so the next sync re-fetches
  // and retries the whole diff (every operation above is idempotent), and
  // surface the error so the caller doesn't report a false success.
  if (failures.length > 0) {
    console.error(`  ✗ Errors syncing "${accountName}":`, failures);
    summary.error = 'Sync completed with errors; will retry on next run.';
    return summary;
  }

  await setMappingFields(plaidAccountId, { cursor: changes.nextCursor });

  if (isNewAccount) {
    const plaidAccount = plaidAccounts.find((a) => a.account_id === plaidAccountId);
    summary.added += await adjustStartingBalance(mapping, plaidAccount);
  }

  console.log(
    `  ✓ ${summary.added} added, ${summary.modified} modified, ` +
      `${summary.removed} removed (${accountName})`
  );
  return summary;
}

// Creates the Actual account if it's missing, then syncs. Never throws: a
// failing account is reported alongside the ones that worked.
async function syncMapping(mapping, actualAccounts, plaidAccounts) {
  try {
    const actualAccountExists = actualAccounts.some((a) => a.id === mapping.actual_account_id);
    const isNewAccount = !mapping.actual_account_id || !actualAccountExists;

    if (isNewAccount) {
      if (config.debug) console.log(`Creating Actual account for ${mapping.account_name}...`);
      // No `type` is passed: Actual's account model has no such field and
      // createAccount silently drops it. The raw Plaid type/subtype live on
      // the mapping instead (see accounts.js).
      const actualAccountId = await api.createAccount(
        { name: mapping.account_name, offbudget: false },
        0
      );
      await setMappingFields(mapping.plaid_account_id, {
        actual_account_id: actualAccountId,
        cursor: null,
      });
    }

    return { mapping, ...(await syncAccount(mapping, isNewAccount, plaidAccounts)) };
  } catch (err) {
    console.error(`  ✗ Failed "${mapping.account_name}": ${err.message}`);
    if (err instanceof ItemLoginRequiredError) await flagLoginRequired(mapping.item_id);
    return { mapping, added: 0, modified: 0, removed: 0, error: err.message };
  }
}

let syncRunning = false;

async function runSync() {
  if (syncRunning) {
    console.log('Sync already in progress, skipping.');
    return null;
  }

  // Re-create the data dirs in case something removed them since startup.
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
    await api.init({
      verbose: config.debug,
      dataDir: config.actual.dataDir,
      serverURL: config.actual.serverUrl,
      password: config.actual.password,
    });

    const results = [];
    try {
      await api.downloadBudget(config.actual.budgetId);
      const actualAccounts = await api.getAccounts();

      for (const mapping of mappings) {
        if (!mapping.sync) {
          if (config.debug) {
            console.log(`Skipping sync for ${mapping.account_name} (sync disabled)`);
          }
          continue;
        }
        results.push(await syncMapping(mapping, actualAccounts, plaidAccounts));
      }
    } finally {
      // Always release the Actual connection, even if downloadBudget failed.
      await api.shutdown();
    }

    console.log('=== Sync complete ===\n');
    return { results };
  } finally {
    syncRunning = false;
  }
}

export { runSync };
