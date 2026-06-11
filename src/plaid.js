const { PlaidApi, PlaidEnvironments, Configuration } = require('plaid');
const { config } = require('./config')

const configuration = new Configuration({
  basePath: PlaidEnvironments[config.plaid.environment],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': config.plaid.clientId,
      'PLAID-SECRET': config.plaid.secret,
    },
  },
});

module.exports = new PlaidApi(configuration);