import cron from 'node-cron';
import { createApp } from './app.js';
import { runSync, isSyncRunning } from './sync.js';
import { createShutdownHandler } from './shutdown.js';
import { config, validateConfig, ensureDataDirs, fail } from './config.js';
import { initDb } from './db.js';
import { verifyActualAccess } from './actual.js';

// Each step is a precondition of the next, and every failure exits: none of
// them has a degraded mode worth serving requests in.
validateConfig();
ensureDataDirs();
try {
  await initDb();
} catch (err) {
  fail(err.message);
}
await verifyActualAccess();

const server = createApp().listen(config.port, () => {
  console.log(`\nplactual running at http://localhost:${config.port}`);
  console.log(`Plaid env : ${config.plaid.environment}`);
  console.log(`Actual URL: ${config.actual.serverUrl}`);
  console.log(`Schedule  : ${config.cronSchedule}\n`);
});

const syncTask = cron.schedule(config.cronSchedule, () => {
  console.log(`\n[cron] Scheduled sync triggered (${new Date().toISOString()})`);
  runSync().catch((err) => console.error('[sync] Fatal error:', err));
});

// A sync that is killed partway has to redo its work, so give one in flight a
// chance to finish.
const shutdown = createShutdownHandler({
  server,
  cronTask: syncTask,
  isSyncRunning,
  graceMs: config.shutdownGraceMs,
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
