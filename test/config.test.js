import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The smallest environment that passes every check, so each test below can
// break exactly one thing.
const VALID_ENV = {
  PLAID_CLIENT_ID: 'client-id',
  PLAID_SECRET: 'plaid-secret',
  ACTUAL_PASSWORD: 'hunter2',
  ACTUAL_BUDGET_ID: 'budget-1',
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plactual-config-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

// validateConfig and ensureDataDirs read the configuration the module built when
// it was imported, so that environment has to be in place first. Everything else
// here takes its environment as an argument.
Object.assign(process.env, VALID_ENV, {
  DB_FILE: path.join(tmpDir, 'sync-files', 'db.json'),
  ACTUAL_DATA_DIR: path.join(tmpDir, 'actual-cache'),
  DEBUG: 'true',
});

const { buildConfig, configErrors, redactedConfig, validateConfig, ensureDataDirs } =
  await import('../src/config.js');

const errorsFor = (env) => configErrors(buildConfig(env), env);
const errorsAbout = (env, subject) => errorsFor(env).filter((e) => e.includes(subject));

// fail() ends the process; throwing instead lets a test see the message.
class Exited extends Error {}

function catchExit(t) {
  const logged = [];
  t.mock.method(console, 'error', (...args) => logged.push(args.join(' ')));
  t.mock.method(console, 'log', () => {});
  t.mock.method(process, 'exit', (code) => {
    throw new Exited(`exit ${code}`);
  });
  return logged;
}

function secretFile(name, contents) {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, contents);
  return file;
}

describe('buildConfig', () => {
  it('reads only the environment it is handed, never process.env', () => {
    const config = buildConfig({ PORT: '9000' });
    assert.equal(config.port, 9000);
    assert.equal(config.plaid.clientId, undefined);
  });

  it('falls back to the shipped defaults', () => {
    const config = buildConfig({});
    assert.equal(config.port, 3131);
    assert.equal(config.cronSchedule, '0 */6 * * *');
    assert.equal(config.shutdownGraceMs, 25000);
    assert.equal(config.dbFile, '/data/sync-files/db.json');
    assert.equal(config.debug, false);
    assert.equal(config.plaid.environment, 'sandbox');
    assert.equal(config.actual.dataDir, '/data/actual-cache');
    assert.equal(config.actual.serverUrl, 'http://actualbudget:5006');
  });

  it('treats an empty variable as unset, as writing `PORT=` in .env means', () => {
    assert.equal(buildConfig({ PORT: '' }).port, 3131);
    assert.equal(buildConfig({ CRON_SCHEDULE: '' }).cronSchedule, '0 */6 * * *');
  });

  it('reads DEBUG case-insensitively and only accepts "true"', () => {
    assert.equal(buildConfig({ DEBUG: 'TRUE' }).debug, true);
    assert.equal(buildConfig({ DEBUG: 'true' }).debug, true);
    assert.equal(buildConfig({ DEBUG: '1' }).debug, false);
    assert.equal(buildConfig({ DEBUG: 'yes' }).debug, false);
  });

  it('refuses to half-parse a malformed number', () => {
    // parseInt would read these as 3131 and 80.
    assert.ok(Number.isNaN(buildConfig({ PORT: '3131abc' }).port));
    assert.ok(Number.isNaN(buildConfig({ PORT: '80.9' }).port));
    assert.ok(Number.isNaN(buildConfig({ SHUTDOWN_GRACE_MS: '25s' }).shutdownGraceMs));
  });

  it('tolerates whitespace around a number', () => {
    assert.equal(buildConfig({ PORT: ' 8080 ' }).port, 8080);
  });

  describe('<NAME>_FILE secrets', () => {
    it('prefers the file over the plain variable, trimming it', () => {
      const config = buildConfig({
        PLAID_SECRET: 'from-env',
        PLAID_SECRET_FILE: secretFile('plaid_secret', 'from-file\n'),
      });
      assert.equal(config.plaid.secret, 'from-file');
    });

    it('covers all three credentials', () => {
      const config = buildConfig({
        PLAID_CLIENT_ID_FILE: secretFile('client_id', 'id'),
        PLAID_SECRET_FILE: secretFile('secret', 'shh'),
        ACTUAL_PASSWORD_FILE: secretFile('password', 'hunter2'),
      });
      assert.equal(config.plaid.clientId, 'id');
      assert.equal(config.plaid.secret, 'shh');
      assert.equal(config.actual.password, 'hunter2');
    });

    it('falls back to the plain variable when the file is not there', () => {
      const config = buildConfig({
        PLAID_SECRET: 'from-env',
        PLAID_SECRET_FILE: path.join(tmpDir, 'does-not-exist'),
      });
      assert.equal(config.plaid.secret, 'from-env');
    });
  });
});

describe('configErrors', () => {
  it('passes a valid configuration', () => {
    assert.deepEqual(errorsFor(VALID_ENV), []);
  });

  it('reports every problem at once, not one per restart', () => {
    const errors = errorsFor({ PORT: 'abc', PLAID_ENV: 'staging', CRON_SCHEDULE: 'nope' });
    assert.equal(errors.length, 7);
  });

  it('names the variable and quotes what was actually typed', () => {
    // The parsed value is NaN by now and says nothing about the typo.
    const [error] = errorsAbout({ ...VALID_ENV, PORT: '3131abc' }, 'PORT');
    assert.match(error, /Invalid PORT: "3131abc"/);
  });

  it('rejects ports outside the usable range', () => {
    for (const port of ['0', '-1', '65536', '80.9']) {
      assert.equal(errorsAbout({ ...VALID_ENV, PORT: port }, 'PORT').length, 1, port);
    }
    for (const port of ['1', '3131', '65535']) {
      assert.deepEqual(errorsFor({ ...VALID_ENV, PORT: port }), [], port);
    }
  });

  it('allows a zero shutdown grace but not a negative one', () => {
    assert.deepEqual(errorsFor({ ...VALID_ENV, SHUTDOWN_GRACE_MS: '0' }), []);
    assert.equal(
      errorsAbout({ ...VALID_ENV, SHUTDOWN_GRACE_MS: '-1' }, 'SHUTDOWN_GRACE_MS').length,
      1
    );
  });

  it('validates the cron expression', () => {
    assert.deepEqual(errorsFor({ ...VALID_ENV, CRON_SCHEDULE: '*/5 * * * *' }), []);
    assert.equal(errorsAbout({ ...VALID_ENV, CRON_SCHEDULE: '99 * * * *' }, 'CRON').length, 1);
  });

  it('accepts only the two Plaid environments the app is set up for', () => {
    for (const env of ['sandbox', 'production']) {
      assert.deepEqual(errorsFor({ ...VALID_ENV, PLAID_ENV: env }), [], env);
    }
    // development was retired by Plaid.
    assert.equal(errorsAbout({ ...VALID_ENV, PLAID_ENV: 'development' }, 'PLAID_ENV').length, 1);
  });

  it('requires every credential', () => {
    for (const key of ['PLAID_CLIENT_ID', 'PLAID_SECRET', 'ACTUAL_PASSWORD', 'ACTUAL_BUDGET_ID']) {
      const errors = errorsFor({ ...VALID_ENV, [key]: undefined });
      assert.deepEqual(errors, [`${key} is not configured.`]);
    }
  });

  it('requires ACTUAL_BUDGET_ID even though the budget lookup could infer it', () => {
    // An unset id would match a local budget's undefined groupId in actual.js.
    assert.deepEqual(errorsFor({ ...VALID_ENV, ACTUAL_BUDGET_ID: '' }), [
      'ACTUAL_BUDGET_ID is not configured.',
    ]);
  });
});

describe('redactedConfig', () => {
  const config = buildConfig({ ...VALID_ENV, PORT: '3131' });
  const redacted = redactedConfig(config);

  it('masks every credential', () => {
    assert.equal(redacted.plaid.clientId, '***');
    assert.equal(redacted.plaid.secret, '***');
    assert.equal(redacted.actual.password, '***');
  });

  it('leaves the rest legible, which is the point of printing it', () => {
    assert.equal(redacted.port, 3131);
    assert.equal(redacted.plaid.environment, 'sandbox');
    assert.equal(redacted.actual.budgetId, 'budget-1');
    assert.equal(redacted.actual.serverUrl, 'http://actualbudget:5006');
  });

  it('does not mask an absent value into looking present', () => {
    const blank = redactedConfig(buildConfig({}));
    assert.equal(blank.plaid.secret, undefined);
  });

  it('copies rather than mutating the configuration it was given', () => {
    assert.equal(config.plaid.secret, 'plaid-secret');
  });
});

describe('validateConfig', () => {
  it('accepts the environment this test file set up', (t) => {
    const logged = catchExit(t);
    validateConfig();
    assert.deepEqual(logged, []);
  });

  it('prints the configuration with DEBUG on, credentials masked', (t) => {
    catchExit(t);
    const printed = [];
    t.mock.method(console, 'log', (...args) => printed.push(args));

    validateConfig();

    const [, config] = printed[0];
    assert.equal(config.plaid.secret, '***');
    assert.equal(config.actual.password, '***');
    assert.equal(config.plaid.environment, 'sandbox');
  });
});

describe('ensureDataDirs', () => {
  it('creates the database and cache directories', (t) => {
    catchExit(t);
    ensureDataDirs();

    assert.ok(fs.statSync(path.join(tmpDir, 'sync-files')).isDirectory());
    assert.ok(fs.statSync(path.join(tmpDir, 'actual-cache')).isDirectory());
  });

  it('leaves them private to this user', (t) => {
    if (process.platform === 'win32') return t.skip('POSIX file modes only');
    catchExit(t);
    ensureDataDirs();

    // The default 0755 would expose db.json to every user on the host.
    assert.equal(fs.statSync(path.join(tmpDir, 'sync-files')).mode & 0o777, 0o700);
  });

  it('is safe to call again once they exist', (t) => {
    catchExit(t);
    ensureDataDirs();
    ensureDataDirs();
  });

  it('exits with the reason when a directory cannot be created', (t) => {
    const logged = catchExit(t);
    t.mock.method(fs, 'mkdirSync', () => {
      throw new Error('EROFS: read-only file system');
    });

    assert.throws(() => ensureDataDirs(), Exited);
    assert.match(logged[0], /Could not create data directory .* read-only file system/);
  });
});
