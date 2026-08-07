import plaid from './plaid.js';
import { config } from './config.js';

const CACHE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 5_000;

const cachedHealth = { plaid: 'unknown', actual: 'unknown', lastCheck: 0 };

export async function checkExternalHealth() {
  const now = Date.now();
  if (now - cachedHealth.lastCheck < CACHE_TTL_MS) return cachedHealth;

  try {
    await plaid.categoriesGet({});
    cachedHealth.plaid = 'up';
  } catch {
    cachedHealth.plaid = 'down';
  }

  try {
    await fetch(config.actual.serverUrl, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    cachedHealth.actual = 'up';
  } catch {
    cachedHealth.actual = 'down';
  }

  cachedHealth.lastCheck = now;
  return cachedHealth;
}
