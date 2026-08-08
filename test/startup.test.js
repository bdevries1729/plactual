import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// index.js starts a server and schedules a cron job, so it is exercised as a
// process. Every case here fails before the server would listen, and nothing
// reaches Plaid or a real Actual server.
const entryPoint = fileURLToPath(new URL('../src/index.js', import.meta.url));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plactual-startup-'));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

let counter = 0;

// A working configuration, pointed at a closed port for Actual.
function validEnv() {
  const dir = path.join(tmpDir, `case-${counter++}`);
  return {
    dir,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      PLAID_CLIENT_ID: 'client-id',
      PLAID_SECRET: 'plaid-secret',
      ACTUAL_PASSWORD: 'hunter2',
      ACTUAL_BUDGET_ID: 'budget-1',
      // Nothing is listening here, so the startup check fails on its own.
      ACTUAL_SERVER_URL: 'http://127.0.0.1:1',
      DB_FILE: path.join(dir, 'sync-files', 'db.json'),
      ACTUAL_DATA_DIR: path.join(dir, 'actual-cache'),
    },
  };
}

function start(env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [entryPoint], { env, timeout: 60_000 }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

describe('startup', () => {
  it('reports every configuration problem at once, then exits', async () => {
    const { code, stderr } = await start({
      PATH: process.env.PATH,
      PORT: 'abc',
      PLAID_ENV: 'staging',
      CRON_SCHEDULE: 'not a cron',
    });

    assert.equal(code, 1);
    assert.match(stderr, /Configuration is invalid:/);
    assert.match(stderr, /Invalid PORT: "abc"/);
    assert.match(stderr, /Invalid PLAID_ENV: "staging"/);
    assert.match(stderr, /Invalid CRON_SCHEDULE: "not a cron"/);
    assert.match(stderr, /PLAID_CLIENT_ID is not configured/);
  });

  it('creates no data directories for a configuration it rejects', async () => {
    const { dir, env } = validEnv();
    const { code } = await start({ ...env, PORT: 'abc' });

    assert.equal(code, 1);
    assert.equal(fs.existsSync(dir), false);
  });

  it('explains a corrupt database and exits, rather than a stack trace', async () => {
    const { dir, env } = validEnv();
    fs.mkdirSync(path.join(dir, 'sync-files'), { recursive: true });
    fs.writeFileSync(env.DB_FILE, '{ not json');

    const { code, stderr } = await start(env);

    assert.equal(code, 1);
    assert.match(stderr, /Could not read the database file/);
    assert.match(stderr, /re-linking your banks/);
  });

  it('creates its data directories, then fails on the Actual server it cannot reach', async () => {
    // Reaching this message proves the rest of the sequence ran first.
    const { dir, env } = validEnv();

    const { code, stderr } = await start(env);

    assert.equal(code, 1);
    assert.match(stderr, /Could not reach Actual at http:\/\/127\.0\.0\.1:1/);
    assert.ok(fs.statSync(path.join(dir, 'sync-files')).isDirectory());
    assert.ok(fs.statSync(path.join(dir, 'actual-cache')).isDirectory());
  });
});
