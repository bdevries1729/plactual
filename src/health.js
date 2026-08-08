import plaid from './plaid.js';
import { config } from './config.js';

const CACHE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 5_000;

const cachedHealth = { plaid: 'unknown', actual: 'unknown', lastCheck: 0 };

async function probePlaid() {
  try {
    // The timeout matters as much as the call: without it a hung connection
    // holds /api/status open indefinitely, and the UI adds another poll every
    // few seconds.
    await plaid.categoriesGet({}, { timeout: PROBE_TIMEOUT_MS });
    return 'up';
  } catch {
    return 'down';
  }
}

async function probeActual() {
  try {
    const response = await fetch(config.actual.serverUrl, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // fetch only rejects on a transport failure, so the status has to be looked
    // at too: a 4xx still proves something is answering on that URL, but a 5xx
    // is a server that cannot serve, which is what "down" means here.
    return response.status < 500 ? 'up' : 'down';
  } catch {
    return 'down';
  }
}

async function probe() {
  const [plaidState, actualState] = await Promise.all([probePlaid(), probeActual()]);
  cachedHealth.plaid = plaidState;
  cachedHealth.actual = actualState;
  cachedHealth.lastCheck = Date.now();
  return cachedHealth;
}

// Shared by everyone who asks while a probe is running. lastCheck is only
// written once both probes settle, so without this the UI's polling would start
// a fresh pair of requests every few seconds for as long as one hangs.
let inFlight = null;

export async function checkExternalHealth() {
  if (Date.now() - cachedHealth.lastCheck < CACHE_TTL_MS) return cachedHealth;

  inFlight ??= probe().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
