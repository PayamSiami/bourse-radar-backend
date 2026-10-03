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
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS runner
WORKDIR /app

# No need to install dumb-init or browsers — the image has them
ENV NODE_ENV=production
ENV TZ=Asia/Tehran

# Install production deps only (no Playwright browser download)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy build artifacts from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/scripts ./scripts
COPY package.json ./

# Create non-root user (image runs as root by default)
RUN groupadd -r appgroup && useradd -r -g appgroup appuser \
  && chown -R appuser:appgroup /app
USER appuser

EXPOSE 8001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const h=require('http');h.get('http://127.0.0.1:8001/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/src/index.js"]