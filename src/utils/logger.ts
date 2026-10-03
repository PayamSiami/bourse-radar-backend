/**
 * Structured logger using Pino.
 * Used outside of Fastify context for cron jobs and standalone scripts.
 *
 * NOTE: No transport (pino-pretty) to avoid worker-thread issues in containerized/sandboxed environments.
 * Fastify's own logger handles request-scoped logging.
 */

import pino from "pino";
import { config } from "#config";

export const logger = pino({
  level: config.app.logLevel,
  // No transport — synchronous stdout output (works in all environments)
  redact: ["database_url", "redis.url", "llm.apiKey"],
});
