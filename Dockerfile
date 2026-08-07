# Node 21+ is required: @actual-app/api touches the `navigator` global at
# module load time, and Node only exposes it from v21 (platform from v21.2).
FROM node:24-alpine

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

# node directly rather than `npm start`: npm's notices otherwise land in the
# container logs and bury the startup validation messages, and this leaves node
# as PID 1 rather than a child of an extra process. (Not a signal-handling fix —
# npm does forward SIGTERM to its child.)
CMD ["node", "src/index.js"]
