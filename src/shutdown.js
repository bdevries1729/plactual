const POLL_INTERVAL_MS = 250;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Builds the SIGTERM/SIGINT handler. Everything it touches is injected, so the
// sequence can be exercised without a real server, cron task or process.
//
// The order matters: stop taking on new work, then wait for the work already in
// flight. A sync interrupted partway leaves its cursor untouched (see sync.js),
// so the worst case is repeated effort on the next run rather than lost or
// duplicated transactions.
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

  // Bounded: the orchestrator has its own timeout and will SIGKILL us if we
  // outstay it, so waiting forever only loses the chance to say goodbye.
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
    // A second signal means whoever sent it is out of patience: leave at once
    // rather than restarting the sequence.
    if (started) {
      log.warn(`[shutdown] ${signal} again — exiting now, abandoning work in flight`);
      return exit(1);
    }
    started = true;
    log.log(`\n[shutdown] ${signal} received`);

    // No new scheduled syncs, and no new connections. Idle keep-alive sockets
    // are dropped too, or the UI's polling would hold the server open.
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
