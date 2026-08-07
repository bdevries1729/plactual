import cron from 'node-cron';
import api from '@actual-app/api';
import fs from 'fs';

function getSecret(name) {
  const path = process.env[`${name}_FILE`];
  if (path && fs.existsSync(path)) {
    return fs.readFileSync(path, "utf8").trim();
  }
  return process.env[name];
}

const config = {
  debug:
    process.env.DEBUG === 'true' || process.env.DEBUG === 'TRUE' || process.env.DEBUG === 'True',
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

function validateCronSchedule() {
  if (!cron.validate(config.cronSchedule)) {
    console.error(`Invalid CRON_SCHEDULE: "${config.cronSchedule}"`);
    process.exit(1);
  }
}

function validatePlaid() {
  if (config.plaid.environment !== 'sandbox' && config.plaid.environment !== 'production') {
    console.error(
      `Invalid PLAID_ENV: "${config.plaid.environment}". Must be 'sandbox' or 'production'.`
    );
    process.exit(1);
  }
  if (!config.plaid.clientId) {
    console.error('PLAID_CLIENT_ID is not configured.');
    process.exit(1);
  }
  if (!config.plaid.secret) {
    console.error('PLAID_SECRET is not configured.');
    process.exit(1);
  }
}

async function validateActual() {
  if (!config.actual.password) {
    console.error('ACTUAL_PASSWORD is not configured.');
    process.exit(1);
  }
  await api.init({
    verbose: config.debug,
    dataDir: config.actual.dataDir,
    serverURL: config.actual.serverUrl,
    password: config.actual.password,
  });
  const budgets = await api.getBudgets();
  if (!budgets.some((b) => b.groupId === config.actual.budgetId)) {
    console.error(`No budgets found matching ACTUAL_BUDGET_ID: "${config.actual.budgetId}"`);
    process.exit(1);
  }
  await api.shutdown();
}

async function validateConfig() {
  if (config.debug) console.log('\nServer Configuration:\n', config);

  validateCronSchedule();
  validatePlaid();
  await validateActual();

  if (config.debug) console.log('Configuration validated.\n');
}

export { config, validateConfig };
