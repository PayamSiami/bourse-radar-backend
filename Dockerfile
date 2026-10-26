# ─────────────────────────────────────────────────────────────
# Stage 1: Build TypeScript
# ─────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci

COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts

# rootDir="./src" → output is dist/index.js (flat)
RUN npm run build

# ─────────────────────────────────────────────────────────────
# Stage 2: Runtime (Playwright base image
# ─────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.64.1-noble AS runner
WORKDIR /app

# Install only the tiny init process; cache apt so rebuilds are fast
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update \
 && apt-get install -y --no-install-recommends dumb-init \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    TZ=Asia/Tehran \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Runtime deps only (no devDependencies)
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev

# Compiled output + assets from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/scripts ./scripts

# Non-root user
RUN groupadd -r appgroup \
 && useradd -r -g appgroup appuser \
 && chown -R appuser:appgroup /app
USER appuser

EXPOSE 8001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "const h=require('http');h.get('http://127.0.0.1:8001/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/index.js"]