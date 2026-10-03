# syntax=docker/dockerfile:1.7

# ── Build stage ──────────────────────────────────────────────
FROM node:22-bookworm-slim AS builder
WORKDIR /app

# Install all deps (including dev) for the build
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source, config, migrations, and scripts
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts

# Compile TypeScript. With rootDir="./", output is dist/src/*.js
RUN npm run build

# ── Runtime stage ────────────────────────────────────────────
FROM node:22-bookworm-slim AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    dumb-init ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV TZ=Asia/Tehran
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Production deps only + Playwright browsers in a shared path
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev \
  && npx playwright install --with-deps chromium \
  && chmod -R 755 /ms-playwright \
  && npm cache clean --force

# Copy build artifacts and runtime files from the builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/scripts ./scripts
COPY package.json ./

RUN groupadd -r appgroup && useradd -r -g appgroup appuser \
  && chown -R appuser:appgroup /app
USER appuser

EXPOSE 8001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const h=require('http');h.get('http://127.0.0.1:8001/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/src/index.js"]