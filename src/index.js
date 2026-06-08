const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const { Configuration, Products, PlaidApi, PlaidEnvironments } = require('plaid');

const app = express();
app.use(
  bodyParser.urlencoded({
    extended: false,
  }),
);
app.use(bodyParser.json());
const port = 3000;



// ------------- PLAID LINK BANK -------------

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/create_link_token', async function (request, response) {
  const linkTokenRequest = {
    user: {
      client_user_id: PLAID_CLIENT_ID,
    },
    client_name: 'Plaid Sync',
    products: [Products.Auth, Products.Transactions],
    country_codes: ['US'],
    language: 'en',
  };
  try {
    const createTokenResponse = await client.linkTokenCreate(linkTokenRequest);
    response.json(createTokenResponse.data);
  } catch (error) {
    res.status(500).json(error.response?.data || error);
  }
});

app.post('/exchange_public_token', async function (request, response) {
  const publicToken = request.body.public_token;
  try {
    const tokenResponse = await client.itemPublicTokenExchange({
      public_token: publicToken,
    });

    // These values should be saved to a persistent database and
    // associated with the currently signed-in user
    const accessToken = tokenResponse.data.access_token;
    console.log(accessToken)
    const itemID = tokenResponse.data.item_id;
    console.log(itemID)

    response.json({ public_token_exchange: 'complete' });
  } catch (error) {
    res.status(500).json(error.response?.data || error);
  }
});


// ------------- TRANSACTION SYNC -------------

async function syncTransactions() {
  const accessToken = "tmp";

  try {
    // 1. Initialize Actual Budget API
    await actual.init({
      dataDir: '/data', // Persistent docker volume
      serverURL: process.env.ACTUAL_SERVER_URL,
      password: process.env.ACTUAL_PASSWORD,
    });
    await actual.downloadBudget(process.env.ACTUAL_SYNC_ID);

    // 2. Fetch Plaid Transactions using the /transactions/sync endpoint
    let cursor = null;
    const cursorFile = '/data/plaid_cursor.txt';
    if (fs.existsSync(cursorFile)) cursor = fs.readFileSync(cursorFile, 'utf8');

    let added = [];
    let hasMore = true;

    while (hasMore) {
      const response = await plaidClient.transactionsSync({
        access_token: process.env.PLAID_ACCESS_TOKEN,
        cursor: cursor,
      });
      added = added.concat(response.data.added);
      cursor = response.data.next_cursor;
      hasMore = response.data.has_more;
    }

    if (added.length === 0) {
      console.log('No new transactions to sync.');
      await actual.shutdown();
      return;
    }

    // 3. Format & Push to Actual
    const actualTransactions = added.map(t => ({
      account: process.env.ACTUAL_ACCOUNT_ID,
      date: t.date,
      // Plaid treats expenses as positive. Actual expects expenses as negative integers (cents).
      amount: Math.round(t.amount * -100), 
      payee_name: t.merchant_name || t.name,
      imported_id: t.transaction_id,
      notes: t.name,
    }));

    // Actual's API handles deduplication automatically using the imported_id
    const result = await actual.importTransactions(
      process.env.ACTUAL_ACCOUNT_ID, 
      actualTransactions
    );
    
    console.log(`Sync complete. Added: ${result.added.length}, Updated: ${result.updated.length}`);

    // 4. Save cursor state & shutdown cleanly
    fs.writeFileSync(cursorFile, cursor);
    await actual.shutdown();

  } catch (error) {
    console.error('Sync failed:', error);
  }
}

// Run the sync engine every 6 hours
cron.schedule('0 */6 * * *', syncTransactions);


// ------------- RUN SERVER -------------

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Application is running at http://localhost:${port}`);
  });
}

module.exports = app;
