import plaid from './plaid.js';
import { config } from './config.js';

const CACHE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 5_000;

const cachedHealth = { plaid: 'unknown', actual: 'unknown', lastCheck: 0 };

async function probePlaid() {
  try {
    // Without the timeout a hung connection holds /api/status open while the UI
    // adds another poll every few seconds.
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
    // fetch only rejects on a transport failure. A 4xx still proves something
    // is answering; a 5xx is a server that cannot serve.
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

// lastCheck is only written once both probes settle, so callers that arrive
// meanwhile share this rather than starting a fresh pair of requests.
let inFlight = null;

export async function checkExternalHealth() {
  if (Date.now() - cachedHealth.lastCheck < CACHE_TTL_MS) return cachedHealth;

  inFlight ??= probe().finally(() => {
    inFlight = null;
  });
  return inFlight;
}
