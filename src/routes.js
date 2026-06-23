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

router.get('/mappings', async (req, res) => {
  const list = db.data.mappings.map(({ access_token: _access_token, ...rest }) => rest); // omit raw tokens for safety
  if (config.debug) console.log('Mappings:\n', list);
  res.json(list);
});

router.patch('/mappings/:plaid_account_id/sync', async (req, res) => {
  const { plaid_account_id } = req.params;
  const { sync } = req.body;

  let updated = false;
  await db.update(({ mappings }) => {
    const mapping = mappings.find((m) => m.plaid_account_id === plaid_account_id);
    if (mapping) {
      mapping.sync = !!sync;
      updated = true;
    }
  });

  if (!updated) {
    return res.status(404).json({ ok: false, error: 'Mapping not found' });
  }
  res.json({ ok: true });
});

router.post('/mappings/refresh', async (req, res) => {
  const { success, errors } = await ensureAllAccountMappings();
  if (!success) {
    return res.status(500).json({
      ok: false,
      error: 'Failed to process some mappings',
      errors,
    });
  }

  const list = db.data.mappings.map(({ access_token: _access_token, ...rest }) => rest); // omit raw tokens for safety
  if (config.debug) console.log('Refreshed Mappings:\n', list);
  res.json(list);
});

router.post('/create_link_token', async (req, res) => {
  const plaidUserId = db.data.users[0]?.plaid_user_id || (await generatePlaidUserId());
  if (config.debug) console.log(`Plaid user_id: ${plaidUserId}`);
  const linkTokenRequest = {
    user_id: plaidUserId,
    client_name: 'Plactual',
    products: [Products.Auth, Products.Transactions],
    country_codes: ['US'],
    language: 'en',
  };
  const response = await plaid.linkTokenCreate(linkTokenRequest);
  if (config.debug) console.log('Link token create response data:\n', response.data, '\n');
  res.json({ link_token: response.data.link_token });
});

router.post('/exchange_public_token', async (req, res) => {
  const { public_token: publicToken } = req.body;
  if (!publicToken) {
    const error = new Error('public_token required');
    error.status = 400;
    throw error;
  }

  const exchangeRes = await plaid.itemPublicTokenExchange({ public_token: publicToken });
  if (config.debug) console.log('Token exchange response data:\n', exchangeRes.data);
  const { access_token: accessToken, item_id: itemId } = exchangeRes.data;

  const savedMappings = await createAccountMappings(accessToken);

  // Do not echo access_token back to the client.
  const accounts = savedMappings.map(({ access_token: _access_token, ...safe }) => safe);

  res.json({ ok: true, item_id: itemId, accounts });
});

router.post('/sync', async (req, res) => {
  const result = await runSync();
  if (config.debug) console.log('Sync result:\n', result);
  res.json({ ok: true, results: result?.results ?? [] });
});

router.get('/status', async (req, res) => {
  const mappedItemsCount = new Set(db.data.mappings.map((m) => m.item_id)).size;
  const health = await checkExternalHealth();

  const status = {
    items: mappedItemsCount,
    cron: config.cronSchedule,
    plaid_env: config.plaid.environment,
    services: {
      plaid: health.plaid,
      actual: health.actual,
    },
  };
  if (config.debug) console.log('The status is: \n', status);
  res.json(status);
});

export default router;
