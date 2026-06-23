import { PlaidApi, PlaidEnvironments, Configuration } from 'plaid';
import { config } from './config.js';

const configuration = new Configuration({
  basePath: PlaidEnvironments[config.plaid.environment],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': config.plaid.clientId,
      'PLAID-SECRET': config.plaid.secret,
    },
  },
});

export default new PlaidApi(configuration);
