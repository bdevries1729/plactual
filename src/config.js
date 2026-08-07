import cron from 'node-cron';
import api from '@actual-app/api';
import fs from 'node:fs';
import path from 'node:path';

// <NAME>_FILE (a Docker secret) takes precedence over a plain <NAME> env var.
function getSecret(name) {
  const filePath = process.env[`${name}_FILE`];
  if (filePath && fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf8').trim();
  }
  return process.env[name];
}

const config = {
  debug: process.env.DEBUG?.toLowerCase() === 'true',
  cronSchedule: process.env.CRON_SCHEDULE || '0 */6 * * *',
  port: parseInt(process.env.PORT || '3131', 10),
  // How long to let an in-flight sync finish after SIGTERM. Deliberately longer
  // than Docker's default 10s stop timeout, which is too short for a sync to
  // finish in; the shipped compose file raises stop_grace_period to match.
  shutdownGraceMs: parseInt(process.env.SHUTDOWN_GRACE_MS || '25000', 10),
  dbFile: process.env.DB_FILE || '/data/sync-files/db.json',
  plaid: {
    environment: process.env.PLAID_ENV || 'sandbox',
    clientId: getSecret('PLAID_CLIENT_ID'),
    secret: getSecret('PLAID_SECRET'),
  },
  actual: {
    dataDir: process.env.ACTUAL_DATA_DIR || '/data/actual-cache',
    serverUrl: process.env.ACTUAL_SERVER_URL || 'http://actualbudget:5006',
    password: getSecret('ACTUAL_PASSWORD'),
    budgetId: process.env.ACTUAL_BUDGET_ID,
  },
};

// A bad configuration has no degraded mode worth running in, so every check
// below exits rather than throwing. Never returns.
function fail(message) {
  console.error(message);
  process.exit(1);
}

// db.json holds the Plaid access tokens for every linked bank, and lowdb writes
// it with whatever the default mode allows (0644 — world-readable, and on a
// bind mount that means readable by every user on the host). Set this before
// ensureDataDirs() below so everything this process creates is private to its
// own user: 0600 for files, 0700 for directories.
process.umask(0o077);

// Must run before anything else loads: lowdb silently falls back to in-memory
// defaults and then throws ENOENT on every write, and Actual's mkdir is not
// recursive, so downloadBudget fails if the cache dir is missing. Called at
// module scope because db.js opens the file at import time, before
// validateConfig() runs.
function ensureDataDirs() {
  for (const dir of [path.dirname(config.dbFile), config.actual.dataDir]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      fail(`Could not create data directory "${dir}": ${err.message}`);
    }
  }
}

ensureDataDirs();

function validateCronSchedule() {
  if (!cron.validate(config.cronSchedule)) {
    fail(`Invalid CRON_SCHEDULE: "${config.cronSchedule}"`);
  }
}

// parseInt yields NaN for anything non-numeric, and app.listen(NaN) quietly
// binds a random free port instead of failing.
function validatePort() {
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    fail(`Invalid PORT: "${process.env.PORT}". Must be an integer between 1 and 65535.`);
  }
}

function validateShutdownGrace() {
  if (!Number.isInteger(config.shutdownGraceMs) || config.shutdownGraceMs < 0) {
    fail(
      `Invalid SHUTDOWN_GRACE_MS: "${process.env.SHUTDOWN_GRACE_MS}". Must be a non-negative integer.`
    );
  }
}

function validatePlaid() {
  const { environment, clientId, secret } = config.plaid;
  if (environment !== 'sandbox' && environment !== 'production') {
    fail(`Invalid PLAID_ENV: "${environment}". Must be 'sandbox' or 'production'.`);
  }
  if (!clientId) fail('PLAID_CLIENT_ID is not configured.');
  if (!secret) fail('PLAID_SECRET is not configured.');
}

async function validateActual() {
  if (!config.actual.password) fail('ACTUAL_PASSWORD is not configured.');
  // Checked for presence separately from the match below: a local, non-synced
  // budget has no groupId at all, so an unset ACTUAL_BUDGET_ID would satisfy
  // `b.groupId === undefined` and pass validation, only to fail later inside
  // downloadBudget() halfway through a sync.
  if (!config.actual.budgetId) fail('ACTUAL_BUDGET_ID is not configured.');

  try {
    await api.init({
      verbose: config.debug,
      dataDir: config.actual.dataDir,
      serverURL: config.actual.serverUrl,
      password: config.actual.password,
    });
  } catch (err) {
    fail(`Could not reach Actual at ${config.actual.serverUrl}: ${err.message}`);
  }

  try {
    const budgets = await api.getBudgets();
    if (!budgets.some((b) => b.groupId === config.actual.budgetId)) {
      fail(`No budgets found matching ACTUAL_BUDGET_ID: "${config.actual.budgetId}"`);
    }
  } catch (err) {
    fail(`Could not list budgets on the Actual server: ${err.message}`);
  }

  await api.shutdown();
}

// Credentials must never reach the logs, not even with DEBUG on.
function redactedConfig() {
  const mask = (value) => (value ? '***' : value);
  return {
    ...config,
    plaid: {
      ...config.plaid,
      clientId: mask(config.plaid.clientId),
      secret: mask(config.plaid.secret),
    },
    actual: { ...config.actual, password: mask(config.actual.password) },
  };
}

async function validateConfig() {
  if (config.debug) console.log('\nServer Configuration:\n', redactedConfig());

  validateCronSchedule();
  validatePort();
  validateShutdownGrace();
  validatePlaid();
  await validateActual();

  if (config.debug) console.log('Configuration validated.\n');
}

export { config, validateConfig, ensureDataDirs, fail };
