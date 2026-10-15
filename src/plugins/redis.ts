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
  // Redis 7.2 (and Docker/NAT in front of it) drops idle TCP after ~5 min.
  // Without keepalive the next cache hit/rate-limit write throws ECONNRESET
  // and ioredis reconnects — noisy but fail-open. Keep the socket alive.
  const redis = new Redis(config.redis.url, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    enableOfflineQueue: true,
    keepAlive: 10_000,
    connectTimeout: 10_000,
    // TCP keepalive at the socket level (ms). 0 = OS default, which on
    // Windows is ~2h — too late. 10s matches Redis timeout defaults.
    family: 0,
    retryStrategy: (times: number) => Math.min(times * 200, 5_000),
    reconnectOnError: (err: Error) => {
      const msg = err.message || "";
      // Reconnect on the idle-drop class of errors; don't loop on AUTH.
      return /ECONNRESET|EPIPE|ETIMEDOUT|READONLY/i.test(msg);
    },
  });

  redis.on("error", (err: Error) => {
    // ECONNRESET on an idle connection is expected until keepalive kicks
    // in; log at warn so it doesn't look like a crash.
    if (/ECONNRESET|EPIPE/i.test(err.message)) {
      logger.warn({ err: err.message }, "Redis socket reset — will reconnect");
      return;
    }
    logger.error(err, "Redis error");
  });
  redis.on("reconnecting", () => logger.warn("Redis reconnecting…"));
  redis.on("ready", () => logger.info("✓ Redis ready"));

  try {
    await redis.ping();
    logger.info("✓ Redis connected");
  } catch (err) {
    logger.error(err, "✗ Redis connection failed");
  }

  // Redis 7.2 `timeout` (and Docker/NAT idle drop) kills sockets that sit
  // unused for a few minutes. Ping every 30s so the connection never looks
  // idle. Harmless if Redis is already gone — ioredis queues / reconnects.
  const pingTimer = setInterval(() => {
    if (redis.status === "ready") {
      redis.ping().catch(() => {
        /* reconnectOnError / retryStrategy handle it */
      });
    }
  }, 30_000);
  pingTimer.unref();

  server.decorate("redis", redis);
  server.addHook("onClose", async () => {
    clearInterval(pingTimer);
    redis.disconnect();
    logger.info("Redis disconnected");
  });
}
