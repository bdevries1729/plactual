# package.json requires Node >= 22. The floor is set by @actual-app/api, which
# touches the `navigator` global at module load time — Node only exposes it from
# v21 (and `navigator.platform` from v21.2) — and by the language features used
# here. This image tracks a newer line than that floor deliberately.
FROM node:26-alpine

WORKDIR /app

COPY package*.json ./

# Native dependencies like better-sqlite3 need build tools on Alpine. Installing
# and removing them in one layer keeps them out of the final image.
RUN apk add --no-cache python3 make g++ \
    && npm ci --omit=dev \
    && apk del python3 make g++

COPY src/ ./src/
COPY public/ ./public/

ENV NODE_ENV=production
ENV DB_FILE=/data/sync-files/db.json
ENV ACTUAL_DATA_DIR=/data/actual-cache

# Run as the unprivileged `node` user (uid 1000) that the base image ships,
# rather than root: db.json holds the Plaid access tokens for every linked bank.
# /data is created and handed over here so an empty named volume inherits the
# ownership. A *bind* mount does not — Docker creates a missing host directory
# as root, so the host side must be writable by uid 1000 (see compose.yml).
RUN mkdir -p /data/sync-files /data/actual-cache && chown -R node:node /data
USER node

EXPOSE 3131

# Polls the liveness route, which makes no external calls — so an unreachable
# Plaid or Actual server doesn't get the container restarted. The start period
# covers startup validation, which connects to Actual before the server listens.
# node rather than curl/wget so this honours PORT and needs nothing extra in the
# image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3131) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# node directly rather than `npm start`: npm's notices otherwise land in the
# container logs and bury the startup validation messages, and this leaves node
# as PID 1 rather than a child of an extra process. (Not a signal-handling fix —
# npm does forward SIGTERM to its child.)
CMD ["node", "src/index.js"]
