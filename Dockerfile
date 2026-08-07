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

EXPOSE 3131

CMD ["npm", "start"]
