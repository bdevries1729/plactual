# Plactual

## Environment Variables

### Configuration

- `PORT` (optional) - default is `3131`
- `CRON_SCHEDULE` (optional) - default is `0 */6 * * *`
- `DEBUG` (optional) - default is `false`. Set to `true` for verbose logging.

### Plaid

- `PLAID_ENV` (optional) - should be `sandbox` or `production`. Will default to `sandbox` if not set.
- `PLAID_CLIENT_ID` - for your account, which you can find on your Plaid dashboard online.
- `PLAID_SECRET` - corresponding to the `PLAID_ENV` you want to use.

### Data Persistence

- `MAPPINGS_FILE` (optional) - will default to `/data/sync-files/mappings.json`.

### Actual Budget

- `ACTUAL_DATA_DIR` (optional) - will default to `/data/user-files`.
- `ACTUAL_SERVER_URL` (optional) - will default to `http://actualbudget:5006`
- `ACTUAL_PASSWORD` - the password you use to sign in to actual budget
- `ACTUAL_BUDGET_ID` - the budget file to sync to
