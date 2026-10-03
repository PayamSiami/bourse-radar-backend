import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { config } from "#config";
import { logger } from "#utils/logger";

declare module "fastify" {
  interface FastifyInstance {
    redis: Redis;
  }
}

export async function registerRedis(server: FastifyInstance) {
  const redis = new Redis(config.redis.url, {
    maxRetriesPerRequest: 3,
    retryStrategy: (times: number) => Math.min(times * 50, 2000),
  });

  redis.on("error", (err: Error) => logger.error(err, "Redis error"));
  redis.on("reconnecting", () => logger.warn("Redis reconnecting…"));

  try {
    await redis.ping();
    logger.info("✓ Redis connected");
  } catch (err) {
    logger.error(err, "✗ Redis connection failed");
  }

  server.decorate("redis", redis);
  server.addHook("onClose", async () => {
    redis.disconnect();
    logger.info("Redis disconnected");
  });
}
