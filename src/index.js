import express  from 'express';
import path from 'path';
import cron from 'node-cron';
import routes from './routes.js';
import { runSync } from './sync.js';
import { config, validateConfig } from './config.js';

validateConfig();

const app  = express();
app.use(express.json());
app.use(express.static(path.join(import.meta.dirname, '../public')));
app.use('/api', routes);

app.listen(config.port, () => {
  console.log(`\nplaid_sync running at http://localhost:${config.port}`);
  console.log(`Plaid env : ${config.plaid.environment}`);
  console.log(`Actual URL: ${config.actual.serverUrl}`);
  console.log(`Schedule  : ${config.cronSchedule}\n`);
});

cron.schedule(config.cronSchedule, () => {
  console.log(`\n[cron] Scheduled sync triggered (${new Date().toISOString()})`);
  runSync().catch(err =>
    console.error('[sync] Fatal error:', err)
  );
});
console.log(`[cron] Scheduler active: "${config.cronSchedule}"`);
