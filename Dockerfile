# syntax=docker/dockerfile:1.7

# ── Build stage ──────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

# Install deps first for better layer caching
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

# Copy source + migrations
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations

# Build: tsc compiles src/ -> dist/. With rootDir=".", output is dist/src/*.js
# so dist/src/index.js is the entrypoint (NOT dist/index.js).
RUN npm run build

# ── Runtime stage ────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app

# Needed for signal handling and healthcheck wget fallback
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production
ENV TZ=Asia/Tehran

# Only production deps
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/migrations ./migrations
# package.json is needed at runtime for Node ESM subpath imports resolution
COPY package.json ./

# Run as non-root
RUN addgroup -S appgroup && adduser -S -G appgroup appuser \
  && chown -R appuser:appgroup /app
USER appuser

EXPOSE 8001

# Healthcheck hits /api/health (the real route — /health returns 404)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const h=require('http');h.get('http://127.0.0.1:8001/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/src/index.js"]
