import api from '@actual-app/api';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from './config.js';

// The Actual server rate-limits POST /account/login, so every superfluous login
// is a step toward `too-many-requests`. api.init() signs in on every call and
// api.shutdown() discards the session token, so cycling them per sync burns one
// login per run. Instead we sign in once and keep the connection for the life of
// the process; downloadBudget() already closes and re-opens the budget per run.
let connection = null;
let connecting = null;

// Reasons worth waiting out. Anything else (invalid-password, network-failure
// against a wrong URL) fails identically on every attempt and would only spend
// more of our login budget.
const TRANSIENT_LOGIN_ERRORS = ['too-many-requests', 'network-failure'];
const LOGIN_BACKOFF_MS = [5000, 15000, 45000, 120000];

function loginErrorReason(err) {
  return /^Authentication failed: (.+)$/.exec(err?.message || '')?.[1] || null;
}

async function login() {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api.init({
        verbose: config.debug,
        dataDir: config.actual.dataDir,
        serverURL: config.actual.serverUrl,
        password: config.actual.password,
      });
    } catch (err) {
      const reason = loginErrorReason(err);
      if (!TRANSIENT_LOGIN_ERRORS.includes(reason) || attempt >= LOGIN_BACKOFF_MS.length) {
        throw err;
      }
      const waitMs = LOGIN_BACKOFF_MS[attempt];
      console.warn(
        `Actual login failed (${reason}); retrying in ${waitMs / 1000}s ` +
          `(attempt ${attempt + 1}/${LOGIN_BACKOFF_MS.length + 1}).`
      );
      await sleep(waitMs);
    }
  }
}

// Sign in to the Actual server, at most once per process. Concurrent callers
// share the in-flight login rather than each firing their own.
async function connectActual() {
  if (connection) return connection;
  if (!connecting) {
    connecting = login()
      .then((conn) => {
        connection = conn;
        return conn;
      })
      .finally(() => {
        connecting = null;
      });
  }
  return connecting;
}

async function disconnectActual() {
  if (!connection) return;
  connection = null;
  await api.shutdown();
}

// Verify we can reach Actual with the configured credentials and that the
// budget we're told to sync into actually exists. Run once at startup so a bad
// password or sync id surfaces immediately instead of at the first cron tick.
async function validateActual() {
  if (!config.actual.password) {
    console.error('ACTUAL_PASSWORD is not configured.');
    process.exit(1);
  }

  try {
    await connectActual();
  } catch (err) {
    const reason = loginErrorReason(err);
    console.error(
      `Could not sign in to Actual at ${config.actual.serverUrl}: ${reason ?? err.message}`
    );
    if (reason === 'too-many-requests') {
      console.error(
        "The Actual server is rate-limiting logins. Its limiter is in-memory, so restarting the Actual server clears it; otherwise wait for the window to pass. If this keeps happening, check that plactual isn't restart-looping."
      );
    }
    process.exit(1);
  }

  const budgets = await api.getBudgets();
  if (!budgets.some((b) => b.groupId === config.actual.budgetId)) {
    console.error(`No budgets found matching ACTUAL_BUDGET_ID: "${config.actual.budgetId}"`);
    console.error(
      `Available sync ids: ${budgets.map((b) => `${b.groupId} (${b.name})`).join(', ') || 'none'}`
    );
    process.exit(1);
  }
}

export { connectActual, disconnectActual, validateActual };
