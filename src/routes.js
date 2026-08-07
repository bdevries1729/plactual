import express from 'express';
import { Products } from 'plaid';
import plaid from './plaid.js';
import db from './db.js';
import { runSync } from './sync.js';
import { config } from './config.js';
import { createAccountMappings, ensureAllAccountMappings } from './accounts.js';
import { generatePlaidUserId } from './user.js';
import { checkExternalHealth } from './health.js';

const router = express.Router();

// Thrown errors are formatted by the error middleware in index.js.
function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// Access tokens are never exposed to the client.
const toPublicMappings = (mappings) =>
  mappings.map(({ access_token: _accessToken, ...rest }) => rest);

// Returns how many mappings were touched so callers can 404 on zero.
async function updateMappings(matches, apply) {
  let changed = 0;
  await db.update(({ mappings }) => {
    mappings.filter(matches).forEach((mapping) => {
      apply(mapping);
      changed++;
    });
  });
  return changed;
}

// `overrides` carries what differs between linking a new institution
// (`products`) and re-authenticating an existing one (`access_token`).
async function createLinkToken(overrides) {
  const plaidUserId = db.data.users[0]?.plaid_user_id || (await generatePlaidUserId());
  if (config.debug) console.log(`Plaid user_id: ${plaidUserId}`);

  const response = await plaid.linkTokenCreate({
    user_id: plaidUserId,
    client_name: 'Plactual',
    country_codes: ['US'],
    language: 'en',
    ...overrides,
  });
  if (config.debug) console.log('Link token create response data:\n', response.data, '\n');
  return response.data.link_token;
}

router.get('/mappings', (req, res) => {
  const list = toPublicMappings(db.data.mappings);
  if (config.debug) console.log('Mappings:\n', list);
  res.json(list);
});

router.patch('/mappings/:plaid_account_id/sync', async (req, res) => {
  const { plaid_account_id: plaidAccountId } = req.params;
  const { sync } = req.body;
  if (typeof sync !== 'boolean') throw httpError(400, 'sync must be a boolean');

  const changed = await updateMappings(
    (m) => m.plaid_account_id === plaidAccountId,
    (m) => {
      m.sync = sync;
    }
  );
  if (changed === 0) throw httpError(404, 'Mapping not found');
  res.json({ ok: true });
});

router.post('/mappings/:item_id/resolve_login', async (req, res) => {
  const { item_id: itemId } = req.params;

  const changed = await updateMappings(
    (m) => m.item_id === itemId,
    (m) => {
      m.login_required = false;
    }
  );
  if (changed === 0) throw httpError(404, 'Mapping not found');
  res.json({ ok: true });
});

router.post('/mappings/refresh', async (req, res) => {
  const { success, errors } = await ensureAllAccountMappings();
  if (!success) {
    // Answered here rather than thrown: the per-item `errors` detail is more
    // useful than the single message the generic error handler can carry.
    return res.status(500).json({ ok: false, error: 'Failed to process some mappings', errors });
  }

  const list = toPublicMappings(db.data.mappings);
  if (config.debug) console.log('Refreshed Mappings:\n', list);
  res.json(list);
});

router.post('/create_link_token', async (req, res) => {
  const linkToken = await createLinkToken({ products: [Products.Transactions] });
  res.json({ link_token: linkToken });
});

router.post('/create_link_token_update', async (req, res) => {
  const { item_id: itemId } = req.body;
  if (!itemId) throw httpError(400, 'item_id required');

  const mapping = db.data.mappings.find((m) => m.item_id === itemId);
  if (!mapping?.access_token) {
    throw httpError(404, 'Mapping or access token not found for item_id');
  }

  // No `products` in update mode — Plaid rejects the combination.
  const linkToken = await createLinkToken({ access_token: mapping.access_token });
  res.json({ link_token: linkToken });
});

router.post('/exchange_public_token', async (req, res) => {
  const { public_token: publicToken } = req.body;
  if (!publicToken) throw httpError(400, 'public_token required');

  const exchangeRes = await plaid.itemPublicTokenExchange({ public_token: publicToken });
  if (config.debug) console.log('Token exchange response data:\n', exchangeRes.data);
  const { access_token: accessToken, item_id: itemId } = exchangeRes.data;

  const savedMappings = await createAccountMappings(accessToken);
  res.json({ ok: true, item_id: itemId, accounts: toPublicMappings(savedMappings) });
});

router.post('/sync', async (req, res) => {
  const result = await runSync();
  // runSync returns null when a sync is already in flight.
  if (!result) throw httpError(409, 'A sync is already in progress');

  if (config.debug) console.log('Sync result:\n', result);
  res.json({ ok: true, results: result.results });
});

router.get('/status', async (req, res) => {
  const health = await checkExternalHealth();
  const status = {
    items: new Set(db.data.mappings.map((m) => m.item_id)).size,
    cron: config.cronSchedule,
    plaid_env: config.plaid.environment,
    services: { plaid: health.plaid, actual: health.actual },
  };
  if (config.debug) console.log('Status:\n', status);
  res.json(status);
});

export default router;
