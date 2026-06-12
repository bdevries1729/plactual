import express from 'express';
import { Products } from 'plaid';
import plaid from './plaid.js';
import db from './db.js';
import { runSync } from './sync.js';
import { toActualAmount } from './helpers.js';
import { config } from './config.js';
import { setUpAccountMappingsForAccessToken } from './accounts.js';

const router = express.Router();

router.get('/mappings', (req, res) => {
  const list = db.data.mappings.map(({ access_token, ...rest }) => rest); // omit raw tokens for safety
  if (config.debug) console.log("\nGET /mappings. Mappings:\n", list, "\n");
  res.json(list);
});

router.post('/create_link_token', async (req, res) => {
  const linkTokenRequest = {
    user: {
      client_user_id: 'plaid-sync-user',
    },
    client_name: 'Plaid Sync',
    products: [Products.Auth, Products.Transactions],
    country_codes: ['US'],
    language: 'en',
  };
  try {
    const response = await plaid.linkTokenCreate(linkTokenRequest);
    if (config.debug) console.log("\nPOST /create_link_token. Link token create response data:\n", response.data, "\n")
    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error('link-token error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error_message || err.message });
  }
});

router.post('/exchange_public_token', async (req, res) => {
  if (config.debug) console.log("\nPOST /exchange_public_token. Request body: ", req.body);
  const { public_token: publicToken } = req.body;
  if (!publicToken) return res.status(400).json({ error: 'public_token required' });

  try {
    const exchangeRes = await plaid.itemPublicTokenExchange({ public_token: publicToken });
    if (config.debug) console.log("Token exchange response data:\n", exchangeRes.data);
    const {
      access_token: accessToken,
      item_id: itemId
    } = exchangeRes.data;

    const savedMappings = await setUpAccountMappingsForAccessToken(accessToken);

    // Do not echo access_token back to the client.
    const accounts = savedMappings.map(({ access_token, ...safe }) => safe);

    res.json({ ok: true, item_id: itemId, accounts });
  } catch (err) {
    console.error('exchange error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error_message || err.message });
  }
});

router.post('/sync', async (req, res) => {
  try {
    const result = await runSync();
    if (config.debug) console.log("\nPOST /sync. Result:\n", result, "\n");
    res.json({ ok: true, results: result?.results ?? [] });
  } catch (err) {
    console.error('manual sync error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/status', (req, res) => {
  const items = [...new Set(db.data.mappings.map(m => m.item_id))];
  const status = {
    items:  items.length, // TODO: this should actually come from hitting the endpoint and getting all items for a user.
    cron:      config.cronSchedule,
    plaid_env: config.plaid.environment,
  };
  if (config.debug) console.log("\nGET /status. The status is: \n", status, "\n");
  res.json(status);
});

export default router;
