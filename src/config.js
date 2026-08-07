import cron from 'node-cron';
import fs from 'fs';

function getSecret(name) {
  const path = process.env[`${name}_FILE`];
  if (path && fs.existsSync(path)) {
    return fs.readFileSync(path, 'utf8').trim();
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

// Note: the Actual server is validated separately, in actual.js — it needs a
// login, and that login is kept open for the rest of the process rather than
// being torn down here.
function validateConfig() {
  if (config.debug) console.log('\nServer Configuration:\n', config);

  validateCronSchedule();
  validatePlaid();

  if (config.debug) console.log('Configuration validated.\n');
}

export { config, validateConfig };
