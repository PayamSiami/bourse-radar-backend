import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { AdminService } from "#services/admin";
import { adminMiddleware } from "#middleware/admin";
import { createAuthMiddleware } from "#middleware/auth";

export async function registerAdminRoutes(server: FastifyInstance) {
  const service = new AdminService(server.db);
  const authMiddlewareHandler = createAuthMiddleware(server);

  // GET /api/admin/users
  server.get(
    "/api/admin/users",
    {
      preHandler: [authMiddlewareHandler, adminMiddleware],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const query = req.query as any;
        const { page = 1, pageSize = 20, search = "", is_admin = undefined, verified = undefined } = query;
        const result = await service.listUsers({ page: Number(page), pageSize: Number(pageSize), search, is_admin, verified });
        return reply.send({ success: true, data: result, message: "??????? ?? ?????? ?????? ????" });
      } catch (error: any) {
        server.log.error(error, "Admin failed to list users");
        return reply.status(500).send({ success: false, error: error.message || "??? ?? ?????? ???? ???????" });
      }
    }
  );

  // GET /api/admin/users/:id
  server.get(
    "/api/admin/users/:id",
    {
      preHandler: [authMiddlewareHandler, adminMiddleware],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = parseInt((req.params as any).id, 10);
        const user = await service.getUser(userId);
        if (!user) return reply.status(404).send({ success: false, error: "????? ???? ???" });
        return reply.send({ success: true, data: user, message: "????? ?? ?????? ?????? ??" });
      } catch (error: any) {
        server.log.error(error, `Admin failed to get user: ${(req.params as any).id}`);
        return reply.status(500).send({ success: false, error: error.message || "??? ?? ?????? ?????" });
      }
    }
  );

  // PUT /api/admin/users/:id/role
  server.put(
    "/api/admin/users/:id/role",
    {
      preHandler: [authMiddlewareHandler, adminMiddleware],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = parseInt((req.params as any).id, 10);
        const body = req.body as { is_admin: boolean };
        const is_admin = body.is_admin ?? false;
        const user = await service.updateUserRole(userId, is_admin);
        return reply.send({ success: true, data: user, message: "??? ????? ?? ?????? ????? ??" });
      } catch (error: any) {
        server.log.error(error, `Admin failed to update user role: ${(req.params as any).id}`);
        return reply.status(500).send({ success: false, error: error.message || "??? ?? ????? ??? ?????" });
      }
    }
  );

  // DELETE /api/admin/users/:id
  server.delete(
    "/api/admin/users/:id",
    {
      preHandler: [authMiddlewareHandler, adminMiddleware],
      },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const userId = parseInt((req.params as any).id, 10);
        await service.deleteUser(userId);
        return reply.send({ success: true, message: "????? ?? ?????? ??? ??" });
      } catch (error: any) {
        server.log.error(error, `Admin failed to delete user: ${(req.params as any).id}`);
        return reply.status(500).send({ success: false, error: error.message || "??? ?? ??? ?????" });
      }
    }
  );

  // GET /api/admin/tickets
  server.get(
    "/api/admin/tickets",
    {
      preHandler: [authMiddlewareHandler, adminMiddleware],
       },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const query = req.query as any;
        const { page = 1, pageSize = 20, status = "", userId = undefined, search = "" } = query;
        const result = await service.listTickets({ page: Number(page), pageSize: Number(pageSize), status, userId: userId ? Number(userId) : undefined, search });
        return reply.send({ success: true, data: result, message: "??????? ?? ?????? ?????? ????" });
      } catch (error: any) {
        server.log.error(error, "Admin failed to list tickets");
        return reply.status(500).send({ success: false, error: error.message || "??? ?? ?????? ???? ???????" });
      }
    }
  );

  // GET /api/admin/tickets/:id
  server.get(
    "/api/admin/tickets/:id",
    {
      preHandler: [authMiddlewareHandler, adminMiddleware],
      },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const ticketId = parseInt((req.params as any).id, 10);
        const ticket = await service.getTicket(ticketId);
        if (!ticket) return reply.status(404).send({ success: false, error: "???? ???? ???" });
        return reply.send({ success: true, data: ticket, message: "???? ?? ?????? ?????? ??" });
      } catch (error: any) {
        server.log.error(error, `Admin failed to get ticket: ${(req.params as any).id}`);
        return reply.status(500).send({ success: false, error: error.message || "??? ?? ?????? ????" });
      }
    }
  );

  // PUT /api/admin/tickets/:id/status
  server.put(
    "/api/admin/tickets/:id/status",
    {
      preHandler: [authMiddlewareHandler, adminMiddleware],
      schema: { tags: ["admin"], summary: "????? ????? ????", params: { type: "object", properties: { id: { type: "string" } } }, body: { type: "object", properties: { status: { type: "string", enum: ["open", "pending", "resolved", "closed"] } } } },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const ticketId = parseInt((req.params as any).id, 10);
        const body = req.body as { status: string };
        const status = body.status;
        const ticket = await service.updateTicketStatus(ticketId, status);
        return reply.send({ success: true, data: ticket, message: "????? ???? ?? ?????? ????? ??" });
      } catch (error: any) {
        server.log.error(error, `Admin failed to update ticket status: ${(req.params as any).id}`);
        return reply.status(500).send({ success: false, error: error.message || "??? in ????? ????? ????" });
      }
    }
  );

  // POST /api/admin/tickets/:id/message
  server.post(
    "/api/admin/tickets/:id/message",
    {
      preHandler: [authMiddlewareHandler, adminMiddleware],
      schema: { tags: ["admin"], summary: "?????? ???? ?? ????", params: { type: "object", properties: { id: { type: "string" } } }, body: { type: "object", properties: { message: { type: "string" } } } },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const ticketId = parseInt((req.params as any).id, 10);
        const body = req.body as { message: string };
        const message = body.message;
        const userId = req.user?.id;
        if (!userId) return reply.status(401).send({ success: false, error: "????? ????? ???? ???? ???" });
        const messageData = await service.addTicketMessage(ticketId, userId, message);
        return reply.send({ success: true, data: messageData, message: "???? ?? ?????? ??? ??" });
      } catch (error: any) {
        server.log.error(error, `Admin failed to add ticket message: ${(req.params as any).id}`);
        return reply.status(500).send({ success: false, error: error.message || "??? ?? ??? ????" });
      }
    }
  );

  // GET /api/admin/tickets/:id/messages
  server.get(
    "/api/admin/tickets/:id/messages",
    {
      preHandler: [authMiddlewareHandler, adminMiddleware],
      schema: { tags: ["admin"], summary: "???? ???????? ????", params: { type: "object", properties: { id: { type: "string" } } }, querystring: { type: "object", properties: { page: { type: "number", default: 1 }, pageSize: { type: "number", default: 50 } } } },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const ticketId = parseInt((req.params as any).id, 10);
        const query = req.query as any;
        const { page = 1, pageSize = 50 } = query;
        const messages = await service.getTicketMessages(ticketId, Number(page), Number(pageSize));
        return reply.send({ success: true, data: messages, message: "???????? ???? ?? ?????? ?????? ????" });
      } catch (error: any) {
        server.log.error(error, `Admin failed to get ticket messages: ${(req.params as any).id}`);
        return reply.status(500).send({ success: false, error: error.message || "??? ?? ?????? ???????? ????" });
      }
    }
  );

  // PUT /api/admin/stocks/:symbol
  server.put(
    "/api/admin/stocks/:symbol",
    {
      preHandler: [authMiddlewareHandler, adminMiddleware],
      schema: { tags: ["admin"], summary: "?????? ????", params: { type: "object", properties: { symbol: { type: "string" } } }, body: { type: "object", properties: { name: { type: "string" }, sector: { type: "string" }, isin: { type: "string" }, shares_outstanding: { type: "number" } } } },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const symbol = (req.params as any).symbol;
        const body = req.body as { name?: string; sector?: string; isin?: string; shares_outstanding?: number };
        const stock = await service.updateStock(symbol, body);
        return reply.send({ success: true, data: stock, message: "???? ?? ?????? ????????? ??" });
      } catch (error: any) {
        server.log.error(error, `Admin failed to update stock: ${(req.params as any).symbol}`);
        return reply.status(500).send({ success: false, error: error.message || "??? ?? ????????? ????" });
      }
    }
  );

  // DELETE /api/admin/stocks/:symbol
  server.delete(
    "/api/admin/stocks/:symbol",
    {
      preHandler: [authMiddlewareHandler, adminMiddleware],
      schema: { tags: ["admin"], summary: "??? ????", params: { type: "object", properties: { symbol: { type: "string" } } } },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const symbol = (req.params as any).symbol;
        await service.deleteStock(symbol);
        return reply.send({ success: true, message: "???? ?? ?????? ??? ??" });
      } catch (error: any) {
        server.log.error(error, `Admin failed to delete stock: ${(req.params as any).symbol}`);
        return reply.status(500).send({ success: false, error: error.message || "??? ?? ??? ????" });
      }
    }
  );

  // GET /api/admin/dashboard/stats
  server.get(
    "/api/admin/dashboard/stats",
    {
      preHandler: [authMiddlewareHandler, adminMiddleware],
      schema: { tags: ["admin"], summary: "???? ??????? ??????" },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const today = new Date();
        const thisMonth = new Date(today.getFullYear(), today.getMonth(), 1);
        const userStats = await server.db<{ total: number; newUsers: number; admins: number; verifiedUsers: number }[]>`
          SELECT (SELECT COUNT(*)::int FROM users) as "total", (SELECT COUNT(*)::int FROM users WHERE created_at >= ${thisMonth}) as "newUsers", (SELECT COUNT(*)::int FROM users WHERE is_admin = true) as "admins", (SELECT COUNT(*)::int FROM users WHERE verified = true) as "verifiedUsers"
        `;
        const ticketStats = await server.db<{ total: number; open: number; pending: number; resolved: number }[]>`
          SELECT (SELECT COUNT(*)::int FROM tickets) as "total", (SELECT COUNT(*)::int FROM tickets WHERE status = 'open') as "open", (SELECT COUNT(*)::int FROM tickets WHERE status = 'pending') as "pending", (SELECT COUNT(*)::int FROM tickets WHERE status = 'resolved') as "resolved"
        `;
        const stockStats = await server.db<{ total: number; activeWithPrice: number }[]>`
          SELECT (SELECT COUNT(*)::int FROM stocks) as "total", (SELECT COUNT(*)::int FROM stocks s WHERE EXISTS (SELECT 1 FROM prices p WHERE p.symbol = s.symbol AND p.timestamp > NOW() - INTERVAL '1 day')) as "activeWithPrice"
        `;
        return reply.send({ success: true, data: { users: userStats[0], tickets: ticketStats[0], stocks: stockStats[0] }, message: "???? ??????? ?????? ??" });
      } catch (error: any) {
        server.log.error(error, "Admin failed to get dashboard stats");
        return reply.status(500).send({ success: false, error: error.message || "??? ?? ?????? ????" });
      }
    }
  );

  server.log.info("Admin routes registered");
}
