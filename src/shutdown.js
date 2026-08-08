const POLL_INTERVAL_MS = 250;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The SIGTERM/SIGINT handler: stop taking on new work, then wait for what is
// already in flight. Its dependencies are injected so the sequence can be tested
// without a real server, cron task or process.
function createShutdownHandler({
  server,
  cronTask,
  isSyncRunning,
  graceMs,
  log = console,
  exit = process.exit,
  wait = sleep,
  now = Date.now,
}) {
  let started = false;

  // Bounded: the orchestrator will SIGKILL us if we outstay its own timeout.
  async function waitForSyncToFinish() {
    if (!isSyncRunning()) return true;

    log.log(
      `[shutdown] a sync is in progress; waiting up to ${Math.round(graceMs / 1000)}s for it to finish`
    );
    const deadline = now() + graceMs;
    while (isSyncRunning() && now() < deadline) {
      await wait(POLL_INTERVAL_MS);
    }
    return !isSyncRunning();
  }

  return async function shutdown(signal) {
    // A second signal means whoever sent it is out of patience.
    if (started) {
      log.warn(`[shutdown] ${signal} again — exiting now, abandoning work in flight`);
      return exit(1);
    }
    started = true;
    log.log(`\n[shutdown] ${signal} received`);

    // No new scheduled syncs, no new connections. Idle keep-alives are dropped
    // too, or the UI's polling would hold the server open.
    await cronTask.destroy();
    server.close();
    server.closeIdleConnections?.();

    if (!(await waitForSyncToFinish())) {
      log.warn(
        '[shutdown] gave up waiting for the sync; it will pick up from its saved cursor next run'
      );
    }

    server.closeAllConnections?.();
    log.log('[shutdown] stopped cleanly');
    return exit(0);
  };
}

export { createShutdownHandler };
