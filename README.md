# Plactual

Plactual is a self-hosted service to automatically sync transactions from your banks into your [Actual Budget](https://actualbudget.com/) instance using [Plaid](https://plaid.com/).

It features a web UI to securely link your bank accounts via Plaid Link, and a background cron job to regularly fetch and import new transactions into your Actual Budget.

## Features

- **Plaid Link Integration**: Easy-to-use web interface to connect and manage bank accounts.
- **Automated Sync**: Background cron job to sync transactions automatically on a schedule.
- **Docker Ready**: Simple deployment alongside your existing Actual Budget setup using Docker Compose.

## Getting Started

### Prerequisites

- An instance of [Actual Budget](https://actualbudget.com/).
- A [Plaid Account](https://dashboard.plaid.com/). You will need your `client_id` and `secret`.

### Docker Compose

The easiest way to run Plactual is via Docker Compose. Create a `compose.yml` (or use the provided example `compose.yml`) and update the environment variables.

```yaml
services:
  plactual:
    image: ghcr.io/bdevries1729/plactual:latest
    container_name: plactual
    ports:
      - '3131:3131'
    environment:
      - NODE_ENV=production
      - CRON_SCHEDULE=0 */6 * * *
      - PLAID_ENV=sandbox # change to 'production' for real banks
      - PLAID_CLIENT_ID=your_plaid_client_id
      - PLAID_SECRET=your_plaid_secret
      - ACTUAL_SERVER_URL=http://actualbudget:5006
      - ACTUAL_PASSWORD=your_actual_password
      - ACTUAL_BUDGET_ID=your_actual_budget_id
    volumes:
      - ./data/sync-files:/data/sync-files
```

Start the service:

```bash
docker compose up -d
```

Visit `http://localhost:3131` in your browser to link your bank accounts.

## Configuration (Environment Variables)

### General

- `PORT` (optional) - Port for the web server. Default is `3131`.
- `CRON_SCHEDULE` (optional) - Cron expression for the background sync job. Default is `0 */6 * * *` (every 6 hours).
- `DEBUG` (optional) - Set to `true` for verbose logging. Default is `false`.

### Plaid

- `PLAID_ENV` (optional) - Should be `sandbox` or `production`. Defaults to `sandbox`.
- `PLAID_CLIENT_ID` - Your Plaid Client ID, found on your Plaid dashboard.
- `PLAID_SECRET` - Your Plaid Secret corresponding to the `PLAID_ENV`.

### Actual Budget

- `ACTUAL_SERVER_URL` (optional) - URL to your Actual Budget server. Defaults to `http://actualbudget:5006`.
- `ACTUAL_PASSWORD` - The password used to sign in to Actual Budget.
- `ACTUAL_BUDGET_ID` - The Sync ID of the budget file you want to sync to. (Found in Actual under Settings -> Advanced -> Sync ID).
- `ACTUAL_DATA_DIR` (optional) - Directory to store Actual Budget cache. Defaults to `/data/actual-cache`.

### Data Persistence

- `DB_FILE` (optional) - Path to store local mappings and state. Defaults to `/data/sync-files/db.json`.

## Local Development

If you want to run or develop Plactual locally without Docker:

1. Clone the repository and install dependencies:
   ```bash
   npm install
   ```
2. Create a `.env` file in the root directory and add your environment variables.
3. Start the development server (uses nodemon):
   ```bash
   npm run dev
   ```

Other scripts:

- `npm run lint` - Runs ESLint.
- `npm run format` - Formats code with Prettier.
