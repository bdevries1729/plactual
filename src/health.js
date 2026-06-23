import plaid from './plaid.js';
import { config } from './config.js';

let cachedHealth = { plaid: 'unknown', actual: 'unknown', lastCheck: 0 };

export async function checkExternalHealth() {
  const now = Date.now();
  if (now - cachedHealth.lastCheck < 60000) return cachedHealth;

  try {
    await plaid.categoriesGet({});
    cachedHealth.plaid = 'up';
  } catch {
    cachedHealth.plaid = 'down';
  }

  try {
    await fetch(config.actual.serverUrl, { signal: AbortSignal.timeout(5000) });
    cachedHealth.actual = 'up';
  } catch {
    cachedHealth.actual = 'down';
  }

  cachedHealth.lastCheck = now;
  return cachedHealth;
}
