
import type { FastifyInstance } from "fastify";

export async function registerAdminDashboard(
  app: FastifyInstance,
) {
  app.get(
    "/api/admin/dashboard/stats",
    {
      preHandler: async (request, reply) => {
        if (!request.session?.adminUser) {
          return reply.code(401).send({
            message: "Unauthorized",
          });
        }
      },
    },
    async () => {
      const result = await postgresPool.query(`
        SELECT
          (SELECT COUNT(*) FROM users) AS users_count,
          (SELECT COUNT(*) FROM stocks) AS stocks_count,
          (SELECT COUNT(*) FROM tickets) AS tickets_count,
          (SELECT COUNT(*) FROM tasks) AS tasks_count
      `);

      return result.rows[0];
    },
  );
}
