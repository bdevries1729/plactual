import fs from 'node:fs';
import path from 'node:path';
import cron from 'node-cron';

// <NAME>_FILE (a Docker secret) takes precedence over a plain <NAME> env var.
function getSecret(env, name) {
  const filePath = env[`${name}_FILE`];
  if (filePath && fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf8').trim();
  }
  return env[name];
}

// NaN for anything that isn't a whole number, so a typo fails in configErrors
// rather than resolving to something close (parseInt reads "80.9" as 80). An
// empty variable falls back: `PORT=` in a .env file means "use the default".
function parseIntegerEnv(value, fallback) {
  const raw = value || fallback;
  return /^-?\d+$/.test(raw.trim()) ? Number(raw) : NaN;
}

// Reading the environment is all this module does at import time; the steps
// that touch the disk or the network are run explicitly from index.js.
function buildConfig(env = process.env) {
  return {
    debug: env.DEBUG?.toLowerCase() === 'true',
    cronSchedule: env.CRON_SCHEDULE || '0 */6 * * *',
    port: parseIntegerEnv(env.PORT, '3131'),
    // Longer than Docker's default 10s stop timeout, which is too short for a
    // sync; compose.yml raises stop_grace_period to match.
    shutdownGraceMs: parseIntegerEnv(env.SHUTDOWN_GRACE_MS, '25000'),
    dbFile: env.DB_FILE || '/data/sync-files/db.json',
    plaid: {
      environment: env.PLAID_ENV || 'sandbox',
      clientId: getSecret(env, 'PLAID_CLIENT_ID'),
      secret: getSecret(env, 'PLAID_SECRET'),
    },
    actual: {
      dataDir: env.ACTUAL_DATA_DIR || '/data/actual-cache',
      serverUrl: env.ACTUAL_SERVER_URL || 'http://actualbudget:5006',
      password: getSecret(env, 'ACTUAL_PASSWORD'),
      budgetId: env.ACTUAL_BUDGET_ID,
    },
  };
}

const config = buildConfig();

// A bad configuration has no degraded mode worth running in. Never returns.
function fail(message) {
  console.error(message);
  process.exit(1);
}

// Reports every problem at once rather than one per restart. `env` is only read
// for the raw text of a value that failed to parse; by then cfg holds NaN.
function configErrors(cfg, env = process.env) {
  const errors = [];

  if (!cron.validate(cfg.cronSchedule)) {
    errors.push(`Invalid CRON_SCHEDULE: "${cfg.cronSchedule}"`);
  }

  // app.listen(NaN) quietly binds a random free port instead of failing.
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    errors.push(`Invalid PORT: "${env.PORT}". Must be an integer between 1 and 65535.`);
  }

  if (!Number.isInteger(cfg.shutdownGraceMs) || cfg.shutdownGraceMs < 0) {
    errors.push(
      `Invalid SHUTDOWN_GRACE_MS: "${env.SHUTDOWN_GRACE_MS}". Must be a non-negative integer.`
    );
  }

  const { environment, clientId, secret } = cfg.plaid;
  if (environment !== 'sandbox' && environment !== 'production') {
    errors.push(`Invalid PLAID_ENV: "${environment}". Must be 'sandbox' or 'production'.`);
  }
  if (!clientId) errors.push('PLAID_CLIENT_ID is not configured.');
  if (!secret) errors.push('PLAID_SECRET is not configured.');

  if (!cfg.actual.password) errors.push('ACTUAL_PASSWORD is not configured.');
  // Checked here as well as by the budget lookup in actual.js: a local budget
  // has no groupId, so an unset id would match `b.groupId === undefined` there
  // and only fail later, inside downloadBudget().
  if (!cfg.actual.budgetId) errors.push('ACTUAL_BUDGET_ID is not configured.');

  return errors;
}

// Credentials must never reach the logs, not even with DEBUG on.
function redactedConfig(cfg) {
  const mask = (value) => (value ? '***' : value);
  return {
    ...cfg,
    plaid: { ...cfg.plaid, clientId: mask(cfg.plaid.clientId), secret: mask(cfg.plaid.secret) },
    actual: { ...cfg.actual, password: mask(cfg.actual.password) },
  };
}

function validateConfig() {
  if (config.debug) console.log('\nServer Configuration:\n', redactedConfig(config));

  const errors = configErrors(config);
  if (errors.length > 0) {
    fail(['Configuration is invalid:', ...errors.map((e) => `  - ${e}`)].join('\n'));
  }

  if (config.debug) console.log('Configuration validated.\n');
}

// Must run before the database is opened: lowdb falls back to in-memory defaults
// and then throws ENOENT on every write, and Actual's mkdir is not recursive, so
// downloadBudget fails without the cache dir. runSync repeats it in case the
// directories were removed underneath us.
function ensureDataDirs() {
  // db.json holds an access token per linked bank, and the default 0644 would
  // make it world-readable on a bind mount. 0600 for files, 0700 for dirs.
  process.umask(0o077);

  for (const dir of [path.dirname(config.dbFile), config.actual.dataDir]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      fail(`Could not create data directory "${dir}": ${err.message}`);
    }
  }
}

export { config, buildConfig, configErrors, redactedConfig, validateConfig, ensureDataDirs, fail };
