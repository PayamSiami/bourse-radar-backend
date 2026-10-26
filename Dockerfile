
# ─────────────────────────────────────────────
# Stage 1: Build TypeScript
# ─────────────────────────────────────────────
FROM node:22.16.0-bookworm-slim AS builder

WORKDIR /app

ENV NODE_ENV=development

# Copy npm manifests first for better Docker layer caching
COPY package.json package-lock.json ./

# Install all dependencies, including TypeScript/build tools
RUN npm ci

# Copy application source
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts

# Compile TypeScript
RUN npm run build


# ─────────────────────────────────────────────
# Stage 2: Production runtime
# ─────────────────────────────────────────────
FROM node:22.16.0-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV TZ=Asia/Tehran
ENV PORT=8001

# Install dumb-init for proper signal handling
RUN apt-get update \
    && apt-get install -y --no-install-recommends dumb-init \
    && rm -rf /var/lib/apt/lists/*

# Copy package manifests
COPY package.json package-lock.json ./

# Install only production dependencies
RUN npm ci --omit=dev \
    && npm cache clean --force

# Copy compiled application and required runtime files
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/scripts ./scripts

# Run as a non-root user
RUN groupadd --system appgroup \
    && useradd --system --gid appgroup --no-create-home appuser \
    && chown -R appuser:appgroup /app

USER appuser

EXPOSE 8001

# Health check
HEALTHCHECK \
    --interval=30s \
    --timeout=5s \
    --start-period=120s \
    --retries=5 \
    CMD ["node", "-e", "require('http').get('http://127.0.0.1:8001/api/health', r => { r.resume(); process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1))"]

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]
