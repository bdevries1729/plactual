# Plactual

Plactual is a self-hosted service to automatically sync transactions from your banks into your [Actual Budget](https://actualbudget.com/) instance using [Plaid](https://plaid.com/).

It features a web UI to securely link your bank accounts via Plaid Link, and a background cron job to regularly fetch and import new transactions into your Actual Budget.

## Features

- **Plaid Link Integration**: Easy-to-use web interface to connect and manage bank accounts.
- **Automated Sync**: Background cron job to sync transactions automatically on a schedule.
- **Per-account control**: Toggle syncing on or off for each linked account, or trigger a sync manually from the UI.
- **Account discovery**: New accounts at an already-linked institution are picked up automatically and created in Actual on the next sync.
- **Reconnect flow**: When an institution requires you to log in again, the account is flagged in the UI and can be repaired via Plaid Link update mode.
- **Health status**: The UI shows live status for both Plaid and your Actual Budget server.
- **Docker Ready**: Simple deployment alongside your existing Actual Budget setup using Docker Compose, with support for Docker secrets.

## Getting Started

### Prerequisites

- An instance of [Actual Budget](https://actualbudget.com/).
- A [Plaid Account](https://dashboard.plaid.com/). You will need your `client_id` and `secret`.

### Docker Compose

The easiest way to run Plactual is via Docker Compose. Use the provided example [`compose.yml`](./compose.yml) as a starting point.

Create the secret files first:

```bash
mkdir -p secrets
echo -n 'your_plaid_client_id' > secrets/plaid_client_id
echo -n 'your_plaid_secret'    > secrets/plaid_secret
echo -n 'your_actual_password' > secrets/actual_password
```

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
      - ACTUAL_SERVER_URL=http://actualbudget:5006
      - ACTUAL_BUDGET_ID=your_actual_budget_id
      - PLAID_CLIENT_ID_FILE=/run/secrets/plaid_client_id
      - PLAID_SECRET_FILE=/run/secrets/plaid_secret
      - ACTUAL_PASSWORD_FILE=/run/secrets/actual_password
    secrets:
      - plaid_client_id
      - plaid_secret
      - actual_password
    volumes:
      - ./data/sync-files:/data/sync-files

secrets:
  plaid_client_id:
    file: ./secrets/plaid_client_id
  plaid_secret:
    file: ./secrets/plaid_secret
  actual_password:
    file: ./secrets/actual_password
```

Start the service:

```bash
docker compose up -d
```

Visit `http://localhost:3131` in your browser to link your bank accounts.

## Configuration (Environment Variables)

### General

- `PORT` (optional) - Port for the web server. Default is `3131`.
- `CRON_SCHEDULE` (optional) - Cron expression for the background sync job. Default is `0 */6 * * *` (every 6 hours). Validated at startup.
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

### Secrets

Rather than putting sensitive values directly in the environment, you can point Plactual at a file containing the value by appending `_FILE` to the variable name. This works with Docker secrets, which are mounted under `/run/secrets/`.

The following variables support this:

- `PLAID_CLIENT_ID_FILE`
- `PLAID_SECRET_FILE`
- `ACTUAL_PASSWORD_FILE`

For example, setting `PLAID_SECRET_FILE=/run/secrets/plaid_secret` makes Plactual read the Plaid secret from that file. Surrounding whitespace and trailing newlines are trimmed.

If `<NAME>_FILE` is set and the file exists, it wins over the plain `<NAME>` variable. Otherwise, Plactual falls back to `<NAME>`, so the plain environment variables continue to work if you don't want to use secrets.

### Data Persistence

- `DB_FILE` (optional) - Path to store local mappings and state. Defaults to `/data/sync-files/db.json`.

`db.json` holds your account mappings, sync cursors, and the Plaid access tokens for your linked institutions. Keep the volume it lives on persistent (otherwise you'll have to re-link your banks) and treat its contents as sensitive.

The Actual Budget cache in `ACTUAL_DATA_DIR` is disposable — it's re-downloaded from your Actual server as needed — so it doesn't need a volume.

### Startup validation

On startup Plactual validates the cron expression, the Plaid environment and credentials, and connects to Actual Budget to confirm that `ACTUAL_BUDGET_ID` matches an existing budget. If any check fails, it logs the reason and exits.

## How It Works

1. You link an institution in the web UI through Plaid Link. Plactual exchanges the resulting public token for an access token and records one mapping per Plaid account in `db.json`.
2. On each sync (scheduled or manual), Plactual first checks for any accounts it hasn't seen yet at your linked institutions and creates mappings for them.
3. For every mapping with syncing enabled, it creates the corresponding account in Actual if it doesn't exist yet, then pulls new, modified, and removed transactions from Plaid using a per-account cursor.
4. Transactions are imported into Actual keyed by the Plaid transaction ID (`imported_id`), so re-running a sync won't create duplicates. If any part of a sync fails, the cursor is left untouched and the whole diff is retried on the next run.
5. For a newly created account, history is trimmed to the current month and a "Starting Balance" transaction is added so the Actual balance matches Plaid's reported balance.

If an institution needs you to log in again, Plaid returns `ITEM_LOGIN_REQUIRED`. Plactual flags the affected accounts and the UI shows a **Reconnect** button that runs Plaid Link in update mode.

## API

The web UI is built on a small JSON API under `/api`. Access tokens are never returned in any response.

| Method  | Endpoint                               | Description                                                     |
| ------- | -------------------------------------- | --------------------------------------------------------------- |
| `GET`   | `/api/status`                          | Item count, cron schedule, Plaid env, and Plaid/Actual health.  |
| `GET`   | `/api/mappings`                        | List all account mappings.                                      |
| `PATCH` | `/api/mappings/:plaid_account_id/sync` | Enable or disable syncing for one account (`{ "sync": true }`). |
| `POST`  | `/api/mappings/refresh`                | Re-check linked institutions for new accounts.                  |
| `POST`  | `/api/mappings/:item_id/resolve_login` | Clear the `login_required` flag after a successful reconnect.   |
| `POST`  | `/api/create_link_token`               | Create a Plaid Link token for linking a new institution.        |
| `POST`  | `/api/create_link_token_update`        | Create a Link token in update mode (`{ "item_id": "..." }`).    |
| `POST`  | `/api/exchange_public_token`           | Exchange a Plaid public token and create account mappings.      |
| `POST`  | `/api/sync`                            | Trigger a sync immediately.                                     |

## Local Development

If you want to run or develop Plactual locally without Docker:

1. Clone the repository and install dependencies:
   ```bash
   npm install
   ```
2. Create a `.env` file in the root directory and add your environment variables. Note that `DB_FILE` and `ACTUAL_DATA_DIR` default to paths under `/data`, so set them to local paths when running outside Docker:
   ```bash
   PLAID_CLIENT_ID=your_plaid_client_id
   PLAID_SECRET=your_plaid_secret
   PLAID_ENV=sandbox
   ACTUAL_SERVER_URL=http://localhost:5006
   ACTUAL_PASSWORD=your_actual_password
   ACTUAL_BUDGET_ID=your_actual_budget_id
   DB_FILE=./db.json
   ACTUAL_DATA_DIR=./actual-cache
   DEBUG=true
   ```
3. Start the development server (uses nodemon):
   ```bash
   npm run dev
   ```

Other scripts:

- `npm start` - Runs the server with plain `node`.
- `npm run lint` - Runs ESLint.
- `npm run format` - Formats code with Prettier.

### Project layout

| File                | Purpose                                                   |
| ------------------- | --------------------------------------------------------- |
| `src/index.js`      | Express app, middleware, cron scheduler, entry point.     |
| `src/config.js`     | Environment/secret loading and startup validation.        |
| `src/routes.js`     | The `/api` routes.                                        |
| `src/sync.js`       | Plaid → Actual transaction sync.                          |
| `src/accounts.js`   | Creating and reconciling Plaid ↔ Actual account mappings. |
| `src/plaid.js`      | Configured Plaid API client.                              |
| `src/user.js`       | Plaid user creation and item lookup.                      |
| `src/db.js`         | lowdb JSON store (`mappings`, `users`).                   |
| `src/health.js`     | Cached health checks for Plaid and Actual.                |
| `src/helpers.js`    | Plaid → Actual transaction/amount conversion.             |
| `public/index.html` | The single-page web UI.                                   |

## Releases

Pushing a `v*.*.*` tag builds and publishes a multi-arch (`linux/amd64`, `linux/arm64`) image to `ghcr.io/bdevries1729/plactual` via GitHub Actions.

## License

MIT — see [LICENSE](./LICENSE).
