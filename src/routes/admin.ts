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
        const {
          page = 1,
          pageSize = 20,
          search = "",
          is_admin = undefined,
          verified = undefined,
        } = query;
        const result = await service.listUsers({
          page: Number(page),
          pageSize: Number(pageSize),
          search,
          is_admin,
          verified,
        });
        return reply.send({
          success: true,
          data: result,
          message: "کاربران دریافت شدند",
        });
      } catch (error: any) {
        server.log.error(error, "Admin failed to list users");
        return reply.status(500).send({
          success: false,
          error: error.message || "خطا در دریافت کاربران",
        });
      }
    },
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
        if (!user)
          return reply.status(404).send({ success: false, error: "کاربر یافت نشد" });
        return reply.send({
          success: true,
          data: user,
          message: "کاربر دریافت شد",
        });
      } catch (error: any) {
        server.log.error(
          error,
          `Admin failed to get user: ${(req.params as any).id}`,
        );
        return reply.status(500).send({
          success: false,
          error: error.message || "خطا در دریافت کاربر",
        });
      }
    },
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
        return reply.send({
          success: true,
          data: user,
          message: "نقش کاربر به‌روزرسانی شد",
        });
      } catch (error: any) {
        server.log.error(
          error,
          `Admin failed to update user role: ${(req.params as any).id}`,
        );
        return reply.status(500).send({
          success: false,
          error: error.message || "خطا در بروزرسانی نقش",
        });
      }
    },
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
        return reply.send({ success: true, message: "کاربر حذف شد" });
      } catch (error: any) {
        server.log.error(
          error,
          `Admin failed to delete user: ${(req.params as any).id}`,
        );
        return reply
          .status(500)
          .send({ success: false, error: error.message || "خطا در حذف کاربر" });
      }
    },
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
        const {
          page = 1,
          pageSize = 20,
          status = "",
          userId = undefined,
          search = "",
        } = query;
        const result = await service.listTickets({
          page: Number(page),
          pageSize: Number(pageSize),
          status,
          userId: userId ? Number(userId) : undefined,
          search,
        });
        return reply.send({
          success: true,
          data: result,
          message: "تیکت‌ها دریافت شدند",
        });
      } catch (error: any) {
        server.log.error(error, "Admin failed to list tickets");
        return reply.status(500).send({
          success: false,
          error: error.message || "خطا در دریافت تیکت‌ها",
        });
      }
    },
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
        if (!ticket)
          return reply.status(404).send({ success: false, error: "تیکت یافت نشد" });
        return reply.send({
          success: true,
          data: ticket,
          message: "تیکت دریافت شد",
        });
      } catch (error: any) {
        server.log.error(
          error,
          `Admin failed to get ticket: ${(req.params as any).id}`,
        );
        return reply.status(500).send({
          success: false,
          error: error.message || "خطا در دریافت تیکت",
        });
      }
    },
  );

  // PUT /api/admin/tickets/:id/status
  server.put(
    "/api/admin/tickets/:id/status",
    {
      preHandler: [authMiddlewareHandler, adminMiddleware],
      schema: {
        tags: ["admin"],
        summary: "بروزرسانی وضعیت تیکت",
        params: { type: "object", properties: { id: { type: "string" } } },
        body: {
          type: "object",
          properties: {
            status: {
              type: "string",
              enum: ["open", "pending", "resolved", "closed"],
            },
          },
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const ticketId = parseInt((req.params as any).id, 10);
        const body = req.body as { status: string };
        const status = body.status;
        const ticket = await service.updateTicketStatus(ticketId, status);
        return reply.send({
          success: true,
          data: ticket,
          message: "وضعیت تیکت به‌روزرسانی شد",
        });
      } catch (error: any) {
        server.log.error(
          error,
          `Admin failed to update ticket status: ${(req.params as any).id}`,
        );
        return reply.status(500).send({
          success: false,
          error: error.message || "خطا در بروزرسانی وضعیت تیکت",
        });
      }
    },
  );

  // POST /api/admin/tickets/:id/message
  server.post(
    "/api/admin/tickets/:id/message",
    {
      preHandler: [authMiddlewareHandler, adminMiddleware],
      schema: {
        tags: ["admin"],
        summary: "افزودن پیام به تیکت",
        params: { type: "object", properties: { id: { type: "string" } } },
        body: { type: "object", properties: { message: { type: "string" } } },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const ticketId = parseInt((req.params as any).id, 10);
        const body = req.body as { message: string };
        const message = body.message;
        const userId = req.user?.id;
        if (!userId)
          return reply
            .status(401)
            .send({ success: false, error: "کاربر شناسایی نشد" });
        const messageData = await service.addTicketMessage(
          ticketId,
          userId,
          message,
        );
        return reply.send({
          success: true,
          data: messageData,
          message: "پیام اضافه شد",
        });
      } catch (error: any) {
        server.log.error(
          error,
          `Admin failed to add ticket message: ${(req.params as any).id}`,
        );
        return reply
          .status(500)
          .send({ success: false, error: error.message || "خطا در اضافه کردن پیام" });
      }
    },
  );

  // GET /api/admin/tickets/:id/messages
  server.get(
    "/api/admin/tickets/:id/messages",
    {
      preHandler: [authMiddlewareHandler, adminMiddleware],
      schema: {
        tags: ["admin"],
        summary: "دریافت پیام‌های تیکت",
        params: { type: "object", properties: { id: { type: "string" } } },
        querystring: {
          type: "object",
          properties: {
            page: { type: "number", default: 1 },
            pageSize: { type: "number", default: 50 },
          },
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const ticketId = parseInt((req.params as any).id, 10);
        const query = req.query as any;
        const { page = 1, pageSize = 50 } = query;
        const messages = await service.getTicketMessages(
          ticketId,
          Number(page),
          Number(pageSize),
        );
        return reply.send({
          success: true,
          data: messages,
          message: "پیام‌ها دریافت شدند",
        });
      } catch (error: any) {
        server.log.error(
          error,
          `Admin failed to get ticket messages: ${(req.params as any).id}`,
        );
        return reply.status(500).send({
          success: false,
          error: error.message || "خطa in دریافت پیام‌های تیکت",
        });
      }
    },
  );

  // PUT /api/admin/stocks/:symbol
  server.put(
    "/api/admin/stocks/:symbol",
    {
      preHandler: [authMiddlewareHandler, adminMiddleware],
      schema: {
        tags: ["admin"],
        summary: "بروزرسانی سهام",
        params: { type: "object", properties: { symbol: { type: "string" } } },
        body: {
          type: "object",
          properties: {
            name: { type: "string" },
            sector: { type: "string" },
            isin: { type: "string" },
            shares_outstanding: { type: "number" },
          },
        },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const symbol = (req.params as any).symbol;
        const body = req.body as {
          name?: string;
          sector?: string;
          isin?: string;
          shares_outstanding?: number;
        };
        const stock = await service.updateStock(symbol, body);
        return reply.send({
          success: true,
          data: stock,
          message: "سهام به‌روزرسانی شد",
        });
      } catch (error: any) {
        server.log.error(
          error,
          `Admin failed to update stock: ${(req.params as any).symbol}`,
        );
        return reply.status(500).send({
          success: false,
          error: error.message || "خطa in بروزرسانی سهام",
        });
      }
    },
  );

  // DELETE /api/admin/stocks/:symbol
  server.delete(
    "/api/admin/stocks/:symbol",
    {
      preHandler: [authMiddlewareHandler, adminMiddleware],
      schema: {
        tags: ["admin"],
        summary: "حذف سهام",
        params: { type: "object", properties: { symbol: { type: "string" } } },
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const symbol = (req.params as any).symbol;
        await service.deleteStock(symbol);
        return reply.send({ success: true, message: "سهام حذف شد" });
      } catch (error: any) {
        server.log.error(
          error,
          `Admin failed to delete stock: ${(req.params as any).symbol}`,
        );
        return reply
          .status(500)
          .send({ success: false, error: error.message || "خطا in حذف سهام" });
      }
    },
  );

  // GET /api/admin/dashboard/stats
  server.get(
    "/api/admin/dashboard/stats",
    {
      preHandler: [authMiddlewareHandler, adminMiddleware],
      schema: { tags: ["admin"], summary: "دریافت آمار داشبورد" },
    },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      try {
        const today = new Date();
        const thisMonth = new Date(today.getFullYear(), today.getMonth(), 1);
        const userStats = await server.db<
          {
            total: number;
            newUsers: number;
            admins: number;
            verifiedUsers: number;
          }[]
        >`
            SELECT (SELECT COUNT(*)::int FROM users) as "total", (SELECT COUNT(*)::int FROM users WHERE created_at >= ${thisMonth}) as "newUsers", (SELECT COUNT(*)::int FROM users WHERE is_admin = true) as "admins", (SELECT COUNT(*)::int FROM users WHERE verified = true) as "verifiedUsers"
          `;
        const ticketStats = await server.db<
          { total: number; open: number; pending: number; resolved: number }[]
        >`
            SELECT (SELECT COUNT(*)::int FROM tickets) as "total", (SELECT COUNT(*)::int FROM tickets WHERE status = 'open') as "open", (SELECT COUNT(*)::int FROM tickets WHERE status = 'pending') as "pending", (SELECT COUNT(*)::int FROM tickets WHERE status = 'resolved') as "resolved"
          `;
        const stockStats = await server.db<
          { total: number; activeWithPrice: number }[]
        >`
            SELECT (SELECT COUNT(*)::int FROM stocks) as "total", (SELECT COUNT(*)::int FROM stocks s WHERE EXISTS (SELECT 1 FROM prices p WHERE p.symbol = s.symbol AND p.timestamp > NOW() - INTERVAL '1 day')) as "activeWithPrice"
          `;
        return reply.send({
          success: true,
          data: {
            users: userStats[0],
            tickets: ticketStats[0],
            stocks: stockStats[0],
          },
          message: "آمار دریافت شد",
        });
      } catch (error: any) {
        server.log.error(error, "Admin failed to get dashboard stats");
        return reply.status(500).send({
          success: false,
          error: error.message || "خطa in دریافت آمار",
        });
      }
    },
  );

  // GET /api/admin/tasks
  server.get(
    "/api/admin/tasks",
    {
      preHandler: [authMiddlewareHandler, adminMiddleware],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const query = req.query as any;
        const {
          page = 1,
          pageSize = 20,
          priority = undefined,
          status = undefined,
          phase = undefined,
          search = undefined,
        } = query;
        const result = await service.listTasks({
          page: Number(page),
          pageSize: Number(pageSize),
          priority,
          status,
          phase,
          search,
        });
        return reply.send({
          success: true,
          data: result,
          message: "تسک‌ها دریافت شدند",
        });
      } catch (error: any) {
        server.log.error(error, "Admin failed to list tasks");
        return reply.status(500).send({
          success: false,
          error: error.message || "خطa in دریافت تسک‌ها",
        });
      }
    },
  );

  // GET /api/admin/tasks/:id
  server.get(
    "/api/admin/tasks/:id",
    {
      preHandler: [authMiddlewareHandler, adminMiddleware],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const taskId = parseInt((req.params as any).id, 10);
        const task = await service.getTask(taskId);
        if (!task)
          return reply.status(404).send({ success: false, error: "تسک یافت نشد" });
        return reply.send({
          success: true,
          data: task,
          message: "تسک دریافت شد",
        });
      } catch (error: any) {
        server.log.error(error, `Admin failed to get task: ${(req.params as any).id}`);
        return reply.status(500).send({
          success: false,
          error: error.message || "خطa in دریافت تسک",
        });
      }
    },
  );

  // POST /api/admin/tasks
  server.post(
    "/api/admin/tasks",
    {
      preHandler: [authMiddlewareHandler, adminMiddleware],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const taskData = req.body as any;
        const task = await service.createTask(taskData);
        return reply.status(201).send({
          success: true,
          data: task,
          message: "تسک جدید ایجاد شد",
        });
      } catch (error: any) {
        server.log.error(error, "Admin failed to create task");
        return reply.status(500).send({
          success: false,
          error: error.message || "خطa in ایجاد تسک",
        });
      }
    },
  );

  // PUT /api/admin/tasks/:id
  server.put(
    "/api/admin/tasks/:id",
    {
      preHandler: [authMiddlewareHandler, adminMiddleware],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const taskId = parseInt((req.params as any).id, 10);
        const taskData = req.body as any;
        const task = await service.updateTask(taskId, taskData);
        return reply.send({
          success: true,
          data: task,
          message: "تسک به‌روزرسانی شد",
        });
      } catch (error: any) {
        server.log.error(error, `Admin failed to update task: ${(req.params as any).id}`);
        return reply.status(500).send({
          success: false,
          error: error.message || "خطa in بروزرسانی تسک",
        });
      }
    },
  );

  // DELETE /api/admin/tasks/:id
  server.delete(
    "/api/admin/tasks/:id",
    {
      preHandler: [authMiddlewareHandler, adminMiddleware],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        const taskId = parseInt((req.params as any).id, 10);
        await service.deleteTask(taskId);
        return reply.send({ success: true, message: "تسک حذف شد" });
      } catch (error: any) {
        server.log.error(error, `Admin failed to delete task: ${(req.params as any).id}`);
        return reply.status(500).send({
          success: false,
          error: error.message || "خطa in حذف تسک",
        });
      }
    },
  );

  server.log.info("Admin routes registered");
}
