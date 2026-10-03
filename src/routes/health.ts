import type { FastifyInstance } from "fastify";

/**
 * GET /api/health
 * Simple health check — no auth, no DB dependency.
 * Returns 200 if server is up.
 */
export async function registerHealthRoute(server: FastifyInstance) {
  server.get(
    "/api/health",
    {
      schema: {
        tags: ["health"],
        description: "Health check endpoint",
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string" },
              timestamp: { type: "string", format: "date-time" },
              uptime_seconds: { type: "number" },
            },
          },
        },
      },
    },
    async () => ({
      status: "ok",
      timestamp: new Date().toISOString(),
      uptime_seconds: process.uptime(),
    }),
  );
}
