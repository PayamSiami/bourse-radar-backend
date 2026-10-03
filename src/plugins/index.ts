import type { FastifyInstance } from "fastify";
import { config } from "#config";
import { logger } from "#utils/logger";
import { registerDb } from "#plugins/db";
import { registerRedis } from "#plugins/redis";
import { registerCors } from "#plugins/cors";
import { registerRateLimit } from "#plugins/rate-limit";
import { registerSwagger } from "#plugins/swagger";

/**
 * Register all core Fastify plugins in dependency order.
 * Each plugin is isolated and can fail gracefully without
 * bringing down the entire server (except DB which is required).
 */
export async function registerPlugins(server: FastifyInstance) {
  logger.info("→ Registering plugins");

  try {
    await registerDb(server);
  } catch (err) {
    logger.warn({ err }, "DB plugin failed — running in degraded mode");
  }
  try {
    await registerRedis(server);
  } catch (err) {
    logger.warn({ err }, "Redis plugin failed — caching disabled");
  }

  try {
    await registerCors(server);
  } catch (err) {
    logger.warn(
      { err },
      "CORS plugin failed — cross-origin requests may be blocked",
    );
  }
  try {
    await registerRateLimit(server);
  } catch (err) {
    logger.warn({ err }, "Rate limit plugin failed — no rate limiting");
  }

  if (config.app.nodeEnv === "development") {
    try {
      await registerSwagger(server);
    } catch (err) {
      logger.warn({ err }, "Swagger plugin failed — docs unavailable");
    }
  }

  logger.info("✓ All plugins attempted");
}
