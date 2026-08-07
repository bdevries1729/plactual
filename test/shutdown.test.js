import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createShutdownHandler } from '../src/shutdown.js';

// Fakes for everything the handler touches, plus a virtual clock so the grace
// period can elapse without the test actually waiting.
function harness({ syncRunningFor = 0, graceMs = 25_000 } = {}) {
  const calls = [];
  let clock = 0;
  let polls = 0;

  const record = (name) => calls.push(name);

  const shutdown = createShutdownHandler({
    graceMs,
    server: {
      close: () => record('server.close'),
      closeIdleConnections: () => record('server.closeIdleConnections'),
      closeAllConnections: () => record('server.closeAllConnections'),
    },
    cronTask: {
      destroy: async () => record('cron.destroy'),
    },
    // Reports "running" for the first `syncRunningFor` polls.
    isSyncRunning: () => polls < syncRunningFor,
    log: { log: (m) => calls.push(`log: ${m.trim()}`), warn: (m) => calls.push(`warn: ${m}`) },
    exit: (code) => {
      calls.push(`exit(${code})`);
      return code;
    },
    wait: async (ms) => {
      polls++;
      clock += ms;
    },
    now: () => clock,
  });

  return { shutdown, calls, pollCount: () => polls };
}

describe('createShutdownHandler', () => {
  it('stops new work before waiting, then closes and exits 0', async () => {
    const { shutdown, calls } = harness();
    await shutdown('SIGTERM');

    const order = calls.filter((c) => !c.startsWith('log:') && !c.startsWith('warn:'));
    assert.deepEqual(order, [
      // Scheduling stops first so nothing new starts during the wait.
      'cron.destroy',
      'server.close',
      'server.closeIdleConnections',
      'server.closeAllConnections',
      'exit(0)',
    ]);
  });

  it('does not wait at all when no sync is running', async () => {
    const { shutdown, pollCount } = harness({ syncRunningFor: 0 });
    await shutdown('SIGTERM');
    assert.equal(pollCount(), 0);
  });

  it('waits for an in-flight sync and then exits 0', async () => {
    const { shutdown, calls, pollCount } = harness({ syncRunningFor: 3 });
    await shutdown('SIGTERM');

    assert.equal(pollCount(), 3, 'should have polled until the sync finished');
    assert.ok(
      calls.some((c) => c.includes('a sync is in progress')),
      'should say it is waiting'
    );
    assert.ok(
      !calls.some((c) => c.startsWith('warn:')),
      'a sync that finishes in time is not a warning'
    );
    assert.ok(calls.includes('exit(0)'));
  });

  it('gives up once the grace period elapses, and says so', async () => {
    // Never stops running; grace allows 4 polls of 250ms.
    const { shutdown, calls, pollCount } = harness({ syncRunningFor: Infinity, graceMs: 1000 });
    await shutdown('SIGTERM');

    assert.equal(pollCount(), 4, 'should stop polling at the deadline');
    assert.ok(
      calls.some((c) => c.startsWith('warn:') && c.includes('gave up waiting')),
      'abandoning a sync must be surfaced'
    );
    // Still a clean exit: we were asked to stop, and we stopped.
    assert.ok(calls.includes('exit(0)'));
  });

  it('a zero grace period abandons the sync immediately', async () => {
    const { shutdown, calls, pollCount } = harness({ syncRunningFor: Infinity, graceMs: 0 });
    await shutdown('SIGTERM');
    assert.equal(pollCount(), 0);
    assert.ok(calls.some((c) => c.includes('gave up waiting')));
  });

  it('a second signal exits at once with a non-zero code', async () => {
    const { shutdown, calls } = harness({ syncRunningFor: Infinity, graceMs: 60_000 });

    const first = shutdown('SIGTERM');
    const second = await shutdown('SIGINT');

    assert.equal(second, 1, 'second signal exits 1');
    assert.ok(calls.some((c) => c.includes('SIGINT again')));
    await first;
  });

  it('names the signal it received', async () => {
    const { shutdown, calls } = harness();
    await shutdown('SIGINT');
    assert.ok(calls.some((c) => c.includes('SIGINT received')));
  });
});
