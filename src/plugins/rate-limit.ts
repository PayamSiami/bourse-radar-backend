import type { FastifyInstance } from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";
import { config } from "#config";
import { logger } from "#utils/logger";

/**
 * Registers global rate limiting using Redis as the store.
 * Falls back to in-memory store if Redis is unavailable.
 *
 * Per-route overrides can be set via:
 *   server.get("/api/suggestions", { config: { rateLimit: { max: 30, timeWindow: "60s" } } }, ...)
 */
export async function registerRateLimit(server: FastifyInstance) {
  const redis = server.redis;

  // Base configuration — applies to all routes
  // @fastify/rate-limit v9: uses `redis` option for distributed store
  const rateLimitOpts: Record<string, unknown> = {
    // Global: 100 requests per 60 seconds per IP
    max: config.rateLimit.global,
    timeWindow: `${config.rateLimit.globalWindow / 1000}s`,
    ban: 2,          // Ban IP for 2x the timeWindow after exceeding
    continueExceeding: false,
    // Per-route overrides are set via route `config.rateLimit`
    // @fastify/rate-limit reads route-level config automatically
    addHeaders: {
      "x-ratelimit-limit": true,
      "x-ratelimit-remaining": true,
      "x-ratelimit-reset": true,
      "retry-after": true,
    },
  };

  // Use Redis store for distributed deployments
  if (redis) {
    rateLimitOpts.redis = redis;
    logger.info("Rate limiting using Redis store");
  } else {
    logger.warn("Redis not available — using in-memory rate limiting (single instance only)");
  }

  await server.register(fastifyRateLimit, rateLimitOpts as any);

  // Register per-route overrides for expensive endpoints
  // These are applied via onRoute hook when routes are registered
  server.addHook("onRoute", (opts) => {
    if (opts.url?.startsWith("/api/suggestions")) {
      opts.config = {
        ...opts.config,
        rateLimit: {
          max: config.rateLimit.authenticated,
          timeWindow: `${config.rateLimit.authenticatedWindow / 1000}s`,
        },
      };
    }
  });

  logger.info("✓ Rate limiting registered");
}
