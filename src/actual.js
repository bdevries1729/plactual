import api from '@actual-app/api';
import { config, fail } from './config.js';

// Every connection is opened with these, so the startup check and the sync
// cannot drift apart.
function initOptions() {
  return {
    verbose: config.debug,
    dataDir: config.actual.dataDir,
    serverURL: config.actual.serverUrl,
    password: config.actual.password,
  };
}

// Runs `fn` against a connected client, always releasing the connection: a
// leaked one keeps the local budget cache locked against the next sync.
async function withActual(fn) {
  await api.init(initOptions());
  try {
    return await fn();
  } finally {
    await api.shutdown();
  }
}

// As withActual, with the configured budget downloaded first.
function withBudget(fn) {
  return withActual(async () => {
    await api.downloadBudget(config.actual.budgetId);
    return fn();
  });
}

// Startup check: the server is reachable and the configured budget exists, so a
// misconfiguration surfaces now rather than halfway through the first sync.
// Exits the process on failure.
async function verifyActualAccess() {
  try {
    await api.init(initOptions());
  } catch (err) {
    fail(`Could not reach Actual at ${config.actual.serverUrl}: ${err.message}`);
  }

  let budgets;
  try {
    budgets = await api.getBudgets();
  } catch (err) {
    fail(`Could not list budgets on the Actual server: ${err.message}`);
  } finally {
    await api.shutdown();
  }

  // groupId, not id: the sync id shown in Actual's settings is what
  // ACTUAL_BUDGET_ID holds.
  if (!budgets.some((b) => b.groupId === config.actual.budgetId)) {
    fail(`No budgets found matching ACTUAL_BUDGET_ID: "${config.actual.budgetId}"`);
  }
}

export { withActual, withBudget, verifyActualAccess, initOptions };
