import type { FastifyInstance } from "fastify";
import fastifyCors from "@fastify/cors";
import { config } from "#config";
import { logger } from "#utils/logger";

export async function registerCors(server: FastifyInstance) {
  // Production origins come from CORS_ORIGINS (config.cors.origins),
  // comma-separated so new domains can be added via .env without a code change.
  const origins = config.cors.origins
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  await server.register(fastifyCors, {
    origin:
      config.app.nodeEnv === "production"
        ? origins.length > 0
          ? origins
          : ["https://bourse-radar.ir", "https://www.bourse-radar.ir"]
        : true, // Allow all in development
    credentials: true,
    methods: ["GET", "POST"],
  });
  logger.info("✓ CORS registered");
}
