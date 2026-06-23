import express from 'express';
import path from 'path';
import cron from 'node-cron';
import routes from './routes.js';
import { runSync } from './sync.js';
import { config, validateConfig } from './config.js';

validateConfig();

const app = express();
app.use(express.json());
app.use(express.static(path.join(import.meta.dirname, '../public')));

// Request logging middleware
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

// Error handling middleware
app.use((err, req, res, _next) => {
  console.error(`Route error in ${req.method} ${req.url}:`, err.response?.data || err.message);
  const status = err.status || 500;
  const message = err.response?.data?.error_message || err.message || 'Internal Server Error';
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
console.log(`[cron] Scheduler active: "${config.cronSchedule}"`);
