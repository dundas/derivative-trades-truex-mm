# TrueX Market Maker - Production Dockerfile
FROM oven/bun:1.1-alpine

WORKDIR /app

# Install dependencies first (for better caching)
COPY package.json ./
RUN bun install --production

# Copy source code
COPY src/ ./src/
COPY lib/ ./lib/
COPY scripts/ ./scripts/

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs

# Create logs directory
RUN mkdir -p /app/logs && chown -R nodejs:nodejs /app

USER nodejs

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD bun --version || exit 1

# Default command (can be overridden)
CMD ["bun", "run", "start"]
