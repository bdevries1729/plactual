const config = {
  cronSchedule: process.env.CRON_SCHEDULE || '0 */6 * * *',
  port: parseInt(process.env.PORT || '3131', 10),
  mappingsFile: process.env.MAPPINGS_FILE || '/data/sync-files/mappings.json',
  plaid: {
    environment: process.env.PLAID_ENV || 'sandbox',
    clientId: process.env.PLAID_CLIENT_ID,
    secret: process.env.PLAID_SECRET,
  },
  actual: {
    dataDir: process.env.ACTUAL_DATA_DIR || '/data/user-files',
    serverUrl: process.env.ACTUAL_SERVER_URL || 'http://actualbudget:5006',
    password: process.env.ACTUAL_PASSWORD,
    budgetId: process.env.ACTUAL_BUDGET_ID,
  }
};

function validateCronSchedule() {
  if (!cron.validate(config.cronSchedule)) {
    console.error(`Invalid CRON_SCHEDULE: "${config.cronSchedule}"`);
    process.exit(1);
  }
}

function validatePlaid() {
  if (config.plaid.environment !== 'sandbox' || config.plaid.environment !== 'production'){
    console.error(`Invalid PLAID_ENV: "${config.plaid.environment}". Must be 'sandbox' or 'production'.`);
    process.exit(1);
  }
  if (!config.plaid.clientId) {
    console.error("PLAID_CLIENT_ID is not configured.");
    process.exit(1);
  }
  if (!config.plaid.secret) {
    console.error("PLAID_SECRET is not configured.");
    process.exit(1);
  }
}

function validateActual() {
  if (!config.actual.password) {
    console.error("ACTUAL_PASSWORD is not configured.");
    process.exit(1);
  }
  if (!config.actual.budgetId) {
    console.error("ACTUAL_BUDGET_ID is not configured.");
    process.exit(1);
  }
}

function validateConfig() {
  validateCronSchedule();
  validatePlaid();
  validateActual();
}

module.exports = { config, validateConfig };
