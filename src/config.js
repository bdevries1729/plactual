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
  validatePlaid();
  await validateActual();

  if (config.debug) console.log('Configuration validated.\n');
}

export { config, validateConfig, ensureDataDirs };
