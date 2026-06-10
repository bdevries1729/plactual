const express  = require('express');
const path = require('path');
const cron = require('node-cron');
const routes = require('./routes');
const { runSync } = require('./sync');

const required = [
  'ACTUAL_PASSWORD',
  'ACTUAL_BUDGET_ID',
  'PLAID_CLIENT_ID',
  'PLAID_SECRET',
];
const missing = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`Missing required environment variables:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}

const app  = express();
const PORT = parseInt(process.env.PORT || '3131', 10);

app.use(express.json());

app.use(express.static(path.join(__dirname, '../public')));

app.use('/api', routes);

const schedule = process.env.CRON_SCHEDULE || '0 */6 * * *'; // every 6 hrs by default
if (!cron.validate(schedule)) {
  console.error(`Invalid CRON_SCHEDULE: "${schedule}"`);
  process.exit(1);
}

app.listen(PORT, () => {
  console.log(`\nplaid_sync running at http://localhost:${PORT}`);
  console.log(`Plaid env : ${process.env.PLAID_ENV || 'sandbox'}`);
  console.log(`Actual URL: ${process.env.ACTUAL_SERVER_URL || 'http://actualbudget:5006'}`);
  console.log(`Schedule  : ${schedule}\n`);
});

// cron.schedule(schedule, () => {
//   console.log(`\n[cron] Scheduled sync triggered (${new Date().toISOString()})`);
//   runSync().catch(err =>
//     console.error('[sync] Fatal error:', err)
//   );
// });
// console.log(`[cron] Scheduler active: "${schedule}"`);
