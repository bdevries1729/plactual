import express from 'express';
import path from 'node:path';
import cron from 'node-cron';
import routes from './routes.js';
import { runSync, isSyncRunning } from './sync.js';
import { createShutdownHandler } from './shutdown.js';
import { config, validateConfig } from './config.js';
import { redact } from './redact.js';
import { refuseCrossSiteWrites, securityHeaders } from './middleware.js';

await validateConfig();

const app = express();
app.use(securityHeaders);
app.use(express.json());
app.use(express.static(path.join(import.meta.dirname, '../public')));

app.use((req, res, next) => {
  if (config.debug) {
    console.log(`\n${req.method} ${req.originalUrl}`);
    if (Object.keys(req.body || {}).length > 0) {
      // Redacted: /exchange_public_token posts a Plaid public_token.
      console.log('Request body: ', redact(req.body));
    }
  }
  next();
});

app.use('/api', refuseCrossSiteWrites, routes);

// Express 5 forwards rejections from async handlers here, so routes throw
// rather than formatting their own error responses.
app.use((err, req, res, _next) => {
  const status = err.status || 500;
  const message = err.response?.data?.error_message || err.message || 'Internal Server Error';
  console.error(
    `${req.method} ${req.originalUrl} -> ${status}:`,
    err.response?.data ? redact(err.response.data) : err.message
  );
  res.status(status).json({ ok: false, error: message });
});

const server = app.listen(config.port, () => {
  console.log(`\nplactual running at http://localhost:${config.port}`);
  console.log(`Plaid env : ${config.plaid.environment}`);
  console.log(`Actual URL: ${config.actual.serverUrl}`);
  console.log(`Schedule  : ${config.cronSchedule}\n`);
});

const syncTask = cron.schedule(config.cronSchedule, () => {
  console.log(`\n[cron] Scheduled sync triggered (${new Date().toISOString()})`);
  runSync().catch((err) => console.error('[sync] Fatal error:', err));
});

// A sync writes to Actual and advances Plaid cursors, so being killed partway
// through means redoing work. Give one in flight a chance to finish.
const shutdown = createShutdownHandler({
  server,
  cronTask: syncTask,
  isSyncRunning,
  graceMs: config.shutdownGraceMs,
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
