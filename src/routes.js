import express from 'express';
import { Products } from 'plaid';
import api from '@actual-app/api';
import fs from 'fs';
import plaid from './plaid.js';
import mappings from './mappings.js';
import { runSync } from './sync.js';
import { toActualAmount } from './helpers.js';
import { config } from './config.js';

const router = express.Router();

router.get('/mappings', (req, res) => {
  const list = mappings.load().map(({ access_token, ...rest }) => rest); // omit raw tokens for safety
  res.json(list);
});

router.delete('/mappings/:id', (req, res) => {
  mappings.remove(req.params.id);
  res.json({ ok: true });
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
    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error('link-token error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error_message || err.message });
  }
});

router.post('/exchange_public_token', async (req, res) => {
  const { public_token: publicToken } = req.body;
  if (!publicToken) return res.status(400).json({ error: 'public_token required' });

  try {
    const exchangeRes = await plaid.itemPublicTokenExchange({ public_token: publicToken });
    const {
      access_token: accessToken,
      item_id: itemId
    } = exchangeRes.data;

    fs.mkdirSync(config.actual.dataDir, { recursive: true });
    await api.init({ verbose: config.debug, dataDir: config.actual.dataDir, serverURL: config.actual.serverUrl, password: config.actual.password });
    await api.downloadBudget(config.actual.budgetId);

    const accountsRes = await plaid.accountsGet({ access_token: accessToken });

    const savedAccountMappings = await Promise.allSettled(
      accountsRes.data.accounts.map(async a => {
        const actualAccountId = await api.createAccount(
          { name: a.name },
          toActualAmount(a.balances.current)
        );
        return mappings.add({
          actual_account_id: actualAccountId,
          plaid_account_id: a.account_id,
          account_name: a.name,
          access_token: accessToken,
          cursor: null,
        });
      })
    );

    await api.shutdown();

    // Do not echo access_token back to the client.
    const accounts = savedAccountMappings
      .filter(r => r.status === 'fulfilled')
      .map(r => {
        const { access_token: _omit, ...safe } = r.value;
        return safe;
      });

    res.json({ ok: true, item_id: itemId, accounts });
  } catch (err) {
    console.error('exchange error:', err.response?.data || err.message);
    res.status(500).json({ error: err.response?.data?.error_message || err.message });
  }
});

router.post('/sync', async (req, res) => {
  try {
    const result = await runSync();
    res.json({ ok: true, results: result?.results ?? [] });
  } catch (err) {
    console.error('manual sync error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/status', (req, res) => {
  const mappingList = mappings.load();
  res.json({
    mappings:  mappingList.length,
    cron:      config.cronSchedule,
    plaid_env: config.plaid.environment,
  });
});

export default router;
