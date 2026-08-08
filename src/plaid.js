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

// A stale bank login: an expected state rather than a failure. The affected
// mappings are flagged so the UI can offer Link's update mode.
function isLoginRequiredError(error) {
  return error?.response?.data?.error_code === 'ITEM_LOGIN_REQUIRED';
}

// Axios errors stringify to "{}", so pull out what Plaid actually said. Safe on
// any error.
function plaidErrorMessage(error) {
  return error?.response?.data?.error_message || error?.message || 'unknown error';
}

export default new PlaidApi(configuration);
export { isLoginRequiredError, plaidErrorMessage };
