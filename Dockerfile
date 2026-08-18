# TrueX Market Maker - Production Dockerfile
FROM oven/bun:1.3.3-alpine@sha256:d2bc1fbc3afcd3d70afc2bb2544235bf559caae2a3084e9abed126e233797511

WORKDIR /app

# Install curl for healthcheck
RUN apk add --no-cache curl

# Install dependencies first (for better caching)
COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

# Copy source code
COPY src/ ./src/
COPY lib/ ./lib/
COPY scripts/ ./scripts/
COPY utils/ ./utils/

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs

# Create logs directory
RUN mkdir -p /app/logs && chown -R nodejs:nodejs /app

USER nodejs

# Health check — overridden per-service in docker-compose.prod.yml
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD curl -sf http://localhost:3100/api/v1/health | grep -q '"status":"healthy"' || exit 1

# Default command (can be overridden)
CMD ["bun", "run", "start"]
