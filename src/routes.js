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

// This must be called before creating the link token. All the items generated are associated with one user. 
// This operation is idempotent.
router.post('/plaid_user', async (req, res) => {
  const clientUser = db.data.users[0]?.client_user_id || crypto.randomUUID();
  if (config.debug) console.log("\nPOST /plaid_user. Will use client_user_id: ", clientUser);
  if (db.data.users.length === 0) {
    db.update(({ users }) => users.push({client_user_id: clientUser }));
  }

  try {
    const response = await plaid.userCreate({ client_user_id: clientUser });
    if (config.debug) console.log("Create user response data:\n", response.data, "\n");
    const plaidUserId = response.data.user_id;
    db.update(({ users }) => users[0].plaid_user_id = plaidUserId);
    res.json({ client_user_id: clientUser, plaid_user_id: plaidUserId });
  } catch (err) {
    console.error('create user error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error_message || err.message });
  }
});

router.get('/plaid_user', async (req, res) => {
  const user = db.data.users[0];
  if (!user) {
    const err = 'no plaid user found.';
    if (config.debug) console.log(err);
    res.status(404).json({ error: err });
    return;
  }
  res.json(user);
});

router.post('/create_link_token', async (req, res) => {
  const linkTokenRequest = {
    user: { // swap this out for the user_id from the create user so we can poll how many items that user has
      client_user_id: 'plaid-sync-user',
    },
    client_name: 'Plaid Sync',
    products: [Products.Auth, Products.Transactions],
    country_codes: ['US'],
    language: 'en',
  };
  try {
    const response = await plaid.linkTokenCreate(linkTokenRequest);
    if (config.debug) console.log("\nPOST /create_link_token. Link token create response data:\n", response.data, "\n");
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
  const status = {
    items:  [...new Set(db.data.mappings.map(m => m.item_id))].length,
    cron:      config.cronSchedule,
    plaid_env: config.plaid.environment,
  };
  if (config.debug) console.log("\nGET /status. The status is: \n", status, "\n");
  res.json(status);
});

export default router;
