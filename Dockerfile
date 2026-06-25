FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies deterministically
# native dependencies like better-sqlite3 require build tools on Alpine
RUN apk add --no-cache python3 make g++ \
    && npm ci \
    && apk del python3 make g++

# Copy application code
COPY src/ ./src/
COPY public/ ./public/

# Create data directories
RUN mkdir -p /data/sync-files /data/actual-cache

# Default environment variables
ENV NODE_ENV=production
ENV DB_FILE=/data/sync-files/db.json
ENV ACTUAL_DATA_DIR=/data/actual-cache

# Expose the default port
EXPOSE 3131

# Start the application
CMD ["npm", "start"]
