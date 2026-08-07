import express from 'express';
import path from 'node:path';
import cron from 'node-cron';
import routes from './routes.js';
import { runSync } from './sync.js';
import { config, validateConfig } from './config.js';

await validateConfig();

const app = express();
app.use(express.json());
app.use(express.static(path.join(import.meta.dirname, '../public')));

app.use((req, res, next) => {
  if (config.debug) {
    console.log(`\n${req.method} ${req.originalUrl}`);
    if (Object.keys(req.body || {}).length > 0) {
      console.log('Request body: ', req.body);
    }
  }
  next();
});

app.use('/api', routes);

// Express 5 forwards rejections from async handlers here, so routes throw
// rather than formatting their own error responses.
app.use((err, req, res, _next) => {
  const status = err.status || 500;
  const message = err.response?.data?.error_message || err.message || 'Internal Server Error';
  console.error(
    `${req.method} ${req.originalUrl} -> ${status}:`,
    err.response?.data || err.message
  );
  res.status(status).json({ ok: false, error: message });
});

app.listen(config.port, () => {
  console.log(`\nplactual running at http://localhost:${config.port}`);
  console.log(`Plaid env : ${config.plaid.environment}`);
  console.log(`Actual URL: ${config.actual.serverUrl}`);
  console.log(`Schedule  : ${config.cronSchedule}\n`);
});

cron.schedule(config.cronSchedule, () => {
  console.log(`\n[cron] Scheduled sync triggered (${new Date().toISOString()})`);
  runSync().catch((err) => console.error('[sync] Fatal error:', err));
});
