import type { FastifyInstance, FastifyReply } from "fastify";
import { AdminService } from "#services/admin";
import { adminMiddleware } from "#middleware/admin";
import { createAuthMiddleware } from "#middleware/auth";

// ─── Shared helpers ─────────────────────────────────────

function sendError(reply: FastifyReply, err: unknown, fallbackMsg: string) {
  const e = err as { statusCode?: number; code?: string; message?: string };
  const status =
    e.statusCode ??
    (e.code === "23505"
      ? 409 // unique_violation
      : e.code === "23503"
        ? 409 // foreign_key_violation
        : e.code === "23502"
          ? 400 // not_null_violation
          : e.code === "22P02"
            ? 400 // invalid_text_representation
            : 500);

  if (status >= 500) {
    // Never leak Postgres internals to the client.
    return reply
      .code(status)
      .send({ success: false, error: "internal_server_error" });
  }
  return reply.code(status).send({
    success: false,
    error: e.message ?? fallbackMsg,
  });
}

const IdParam = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "integer", minimum: 1 } },
} as const;

const SymbolParam = {
  type: "object",
  required: ["symbol"],
  properties: { symbol: { type: "string", minLength: 1, maxLength: 64 } },
} as const;

// ─── Route module ───────────────────────────────────────

export async function registerAdminRoutes(server: FastifyInstance) {
  const service = new AdminService(server.db);
  const auth = createAuthMiddleware(server);
  const guard = { preHandler: [auth, adminMiddleware] };

  // ═══════════════════ USERS ═══════════════════

  // GET /api/admin/users
  server.get(
    "/api/admin/users",
    {
      ...guard,
      schema: {
        tags: ["admin"],
        summary: "List users (paginated, searchable)",
        querystring: {
          type: "object",
          properties: {
            page: { type: "integer", minimum: 1, default: 1 },
            pageSize: {
              type: "integer",
              minimum: 1,
              maximum: 100,
              default: 20,
            },
            search: { type: "string", maxLength: 100, default: "" },
            is_admin: { type: "boolean" },
            verified: { type: "boolean" },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      try {
        const q = req.query as {
          page: number;
          pageSize: number;
          search: string;
          is_admin?: boolean;
          verified?: boolean;
        };
        const result = await service.listUsers(q);
        return reply.send({
          success: true,
          data: result,
          message: "کاربران دریافت شدند",
        });
      } catch (error) {
        server.log.error({ err: error }, "admin list users failed");
        return sendError(reply, error, "خطا در دریافت کاربران");
      }
    },
  );

  // GET /api/admin/users/:id
  server.get(
    "/api/admin/users/:id",
    {
      ...guard,
      schema: {
        tags: ["admin"],
        summary: "Get user by id",
        params: IdParam,
      },
    },
    async (req, reply) => {
      try {
        const { id } = req.params as { id: number };
        const user = await service.getUser(id);
        if (!user)
          return reply
            .code(404)
            .send({ success: false, error: "کاربر یافت نشد" });
        return reply.send({
          success: true,
          data: user,
          message: "کاربر دریافت شد",
        });
      } catch (error) {
        server.log.error(
          { err: error, id: (req.params as any).id },
          "admin get user failed",
        );
        return sendError(reply, error, "خطا در دریافت کاربر");
      }
    },
  );

  // PUT /api/admin/users/:id/role
  server.put(
    "/api/admin/users/:id/role",
    {
      ...guard,
      schema: {
        tags: ["admin"],
        summary: "Update user admin flag",
        params: IdParam,
        body: {
          type: "object",
          required: ["is_admin"],
          additionalProperties: false,
          properties: { is_admin: { type: "boolean" } },
        },
      },
    },
    async (req, reply) => {
      try {
        const { id } = req.params as { id: number };
        const { is_admin } = req.body as { is_admin: boolean };
        const actorId = req.user!.id;

        // Self-demotion guard — verified in service so the check is atomic.
        const user = await service.updateUserRole(id, is_admin, actorId);
        return reply.send({
          success: true,
          data: user,
          message: "نقش کاربر به‌روزرسانی شد",
        });
      } catch (error) {
        server.log.error(
          { err: error, id: (req.params as any).id },
          "admin update role failed",
        );
        return sendError(reply, error, "خطا در بروزرسانی نقش");
      }
    },
  );

  // DELETE /api/admin/users/:id
  server.delete(
    "/api/admin/users/:id",
    {
      ...guard,
      schema: { tags: ["admin"], summary: "Delete user", params: IdParam },
    },
    async (req, reply) => {
      try {
        const { id } = req.params as { id: number };
        if (id === req.user!.id) {
          return reply
            .code(400)
            .send({ success: false, error: "cannot delete your own account" });
        }
        await service.deleteUser(id);
        return reply.send({ success: true, message: "کاربر حذف شد" });
      } catch (error) {
        server.log.error(
          { err: error, id: (req.params as any).id },
          "admin delete user failed",
        );
        return sendError(reply, error, "خطا در حذف کاربر");
      }
    },
  );

  // ═══════════════════ TICKETS ═══════════════════

  // GET /api/admin/tickets
  server.get(
    "/api/admin/tickets",
    {
      ...guard,
      schema: {
        tags: ["admin"],
        summary: "List tickets",
        querystring: {
          type: "object",
          properties: {
            page: { type: "integer", minimum: 1, default: 1 },
            pageSize: {
              type: "integer",
              minimum: 1,
              maximum: 100,
              default: 20,
            },
            status: {
              type: "string",
              enum: ["open", "pending", "resolved", "closed", ""],
              default: "",
            },
            userId: { type: "integer", minimum: 1 },
            search: { type: "string", maxLength: 100, default: "" },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      try {
        const result = await service.listTickets(req.query as any);
        return reply.send({
          success: true,
          data: result,
          message: "تیکت‌ها دریافت شدند",
        });
      } catch (error) {
        server.log.error({ err: error }, "admin list tickets failed");
        return sendError(reply, error, "خطا در دریافت تیکت‌ها");
      }
    },
  );

  // GET /api/admin/tickets/:id
  server.get(
    "/api/admin/tickets/:id",
    {
      ...guard,
      schema: { tags: ["admin"], summary: "Get ticket", params: IdParam },
    },
    async (req, reply) => {
      try {
        const { id } = req.params as { id: number };
        const ticket = await service.getTicket(id);
        if (!ticket)
          return reply
            .code(404)
            .send({ success: false, error: "تیکت یافت نشد" });
        return reply.send({
          success: true,
          data: ticket,
          message: "تیکت دریافت شد",
        });
      } catch (error) {
        server.log.error(
          { err: error, id: (req.params as any).id },
          "admin get ticket failed",
        );
        return sendError(reply, error, "خطا در دریافت تیکت");
      }
    },
  );

  // PUT /api/admin/tickets/:id/status
  server.put(
    "/api/admin/tickets/:id/status",
    {
      ...guard,
      schema: {
        tags: ["admin"],
        summary: "Update ticket status",
        params: IdParam,
        body: {
          type: "object",
          required: ["status"],
          additionalProperties: false,
          properties: {
            status: {
              type: "string",
              enum: ["open", "pending", "resolved", "closed"],
            },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const { id } = req.params as { id: number };
        const { status } = req.body as { status: string };
        const ticket = await service.updateTicketStatus(id, status);
        return reply.send({
          success: true,
          data: ticket,
          message: "وضعیت تیکت به‌روزرسانی شد",
        });
      } catch (error) {
        server.log.error(
          { err: error, id: (req.params as any).id },
          "admin update ticket status failed",
        );
        return sendError(reply, error, "خطا در بروزرسانی وضعیت تیکت");
      }
    },
  );

  // POST /api/admin/tickets/:id/message
  server.post(
    "/api/admin/tickets/:id/message",
    {
      ...guard,
      schema: {
        tags: ["admin"],
        summary: "Post admin message to ticket",
        params: IdParam,
        body: {
          type: "object",
          required: ["message"],
          additionalProperties: false,
          properties: {
            message: { type: "string", minLength: 1, maxLength: 10_000 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const { id } = req.params as { id: number };
        const { message } = req.body as { message: string };
        const actorId = req.user!.id;

        const messageData = await service.addTicketMessage(
          id,
          actorId,
          message,
          "admin",
        );
        return reply.send({
          success: true,
          data: messageData,
          message: "پیام اضافه شد",
        });
      } catch (error) {
        server.log.error(
          { err: error, id: (req.params as any).id },
          "admin add ticket message failed",
        );
        return sendError(reply, error, "خطا در اضافه کردن پیام");
      }
    },
  );

  // GET /api/admin/tickets/:id/messages
  server.get(
    "/api/admin/tickets/:id/messages",
    {
      ...guard,
      schema: {
        tags: ["admin"],
        summary: "Get ticket messages",
        params: IdParam,
        querystring: {
          type: "object",
          properties: {
            page: { type: "integer", minimum: 1, default: 1 },
            pageSize: {
              type: "integer",
              minimum: 1,
              maximum: 200,
              default: 50,
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      try {
        const { id } = req.params as { id: number };
        const { page, pageSize } = req.query as {
          page: number;
          pageSize: number;
        };
        const messages = await service.getTicketMessages(id, page, pageSize);
        return reply.send({
          success: true,
          data: messages,
          message: "پیام‌ها دریافت شدند",
        });
      } catch (error) {
        server.log.error(
          { err: error, id: (req.params as any).id },
          "admin get ticket messages failed",
        );
        return sendError(reply, error, "خطا در دریافت پیام‌های تیکت");
      }
    },
  );

  // ═══════════════════ STOCKS ═══════════════════
  // NOTE: prefer PATCH /api/stocks/:symbol (admin-gated) over these.
  // Kept here for backward compat with existing admin UI. Delegates to the
  // same service call and the same cache invalidation helper.

  // PUT /api/admin/stocks/:symbol
  server.put(
    "/api/admin/stocks/:symbol",
    {
      ...guard,
      schema: {
        tags: ["admin"],
        summary: "Update stock (admin)",
        params: SymbolParam,
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 255 },
            name_en: { type: ["string", "null"], maxLength: 255 },
            sector: { type: ["string", "null"], maxLength: 255 },
            industry_group: { type: ["string", "null"], maxLength: 255 },
            isin: { type: ["string", "null"], maxLength: 32 },
            ins_code: { type: ["string", "null"], maxLength: 32 },
            shares_outstanding: { type: ["integer", "null"], minimum: 1 },
            is_bank: { type: "boolean" },
            is_insurance: { type: "boolean" },
            is_holding_company: { type: "boolean" },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const { symbol } = req.params as { symbol: string };
        const stock = await service.updateStock(symbol, req.body as any);
        return reply.send({
          success: true,
          data: stock,
          message: "سهام به‌روزرسانی شد",
        });
      } catch (error) {
        server.log.error(
          { err: error, symbol: (req.params as any).symbol },
          "admin update stock failed",
        );
        return sendError(reply, error, "خطا در بروزرسانی سهام");
      }
    },
  );

  // DELETE /api/admin/stocks/:symbol
  server.delete(
    "/api/admin/stocks/:symbol",
    {
      ...guard,
      schema: { tags: ["admin"], summary: "Delete stock", params: SymbolParam },
    },
    async (req, reply) => {
      try {
        const { symbol } = req.params as { symbol: string };
        await service.deleteStock(symbol);
        return reply.send({ success: true, message: "سهام حذف شد" });
      } catch (error) {
        server.log.error(
          { err: error, symbol: (req.params as any).symbol },
          "admin delete stock failed",
        );
        return sendError(reply, error, "خطا در حذف سهام");
      }
    },
  );

  // ═══════════════════ DASHBOARD ═══════════════════

  // GET /api/admin/dashboard/stats
  // GET /api/admin/dashboard/stats
  server.get(
    "/api/admin/dashboard/stats",
    { ...guard, schema: { tags: ["admin"], summary: "Dashboard stats" } },
    async (_req, reply) => {
      try {
        const [row] = await server.db<
          {
            users_total: number;
            users_new: number;
            users_admins: number;
            users_verified: number;
            tickets_total: number;
            tickets_open: number;
            tickets_pending: number;
            tickets_resolved: number;
            stocks_total: number;
            stocks_active: number;
          }[]
        >`
        SELECT
          (SELECT COUNT(*)::int FROM users)                                                AS users_total,
          (SELECT COUNT(*)::int FROM users WHERE created_at >= date_trunc('month', NOW())) AS users_new,
          (SELECT COUNT(*)::int FROM users WHERE is_admin = true)                          AS users_admins,
          (SELECT COUNT(*)::int FROM users WHERE verified = true)                          AS users_verified,
          (SELECT COUNT(*)::int FROM tickets)                                              AS tickets_total,
          (SELECT COUNT(*)::int FROM tickets WHERE status = 'open')                        AS tickets_open,
          (SELECT COUNT(*)::int FROM tickets WHERE status = 'pending')                     AS tickets_pending,
          (SELECT COUNT(*)::int FROM tickets WHERE status = 'resolved')                    AS tickets_resolved,
          (SELECT COUNT(*)::int FROM stocks)                                               AS stocks_total,
          (SELECT COUNT(*)::int FROM stocks s
            WHERE EXISTS (SELECT 1 FROM prices p
                          WHERE p.symbol = s.symbol
                            AND p."timestamp" > NOW() - INTERVAL '1 day'))                 AS stocks_active
      `;

        // A SELECT of scalar subqueries always returns exactly one row,
        // but TS can't prove it. Fall back to zeros if the invariant is
        // ever broken (e.g., after a query refactor).
        const stats = row ?? {
          users_total: 0,
          users_new: 0,
          users_admins: 0,
          users_verified: 0,
          tickets_total: 0,
          tickets_open: 0,
          tickets_pending: 0,
          tickets_resolved: 0,
          stocks_total: 0,
          stocks_active: 0,
        };

        return reply.send({
          success: true,
          data: {
            users: {
              total: stats.users_total,
              newUsers: stats.users_new,
              admins: stats.users_admins,
              verifiedUsers: stats.users_verified,
            },
            tickets: {
              total: stats.tickets_total,
              open: stats.tickets_open,
              pending: stats.tickets_pending,
              resolved: stats.tickets_resolved,
            },
            stocks: {
              total: stats.stocks_total,
              activeWithPrice: stats.stocks_active,
            },
          },
          message: "آمار دریافت شد",
        });
      } catch (error) {
        server.log.error({ err: error }, "admin dashboard stats failed");
        return sendError(reply, error, "خطا در دریافت آمار");
      }
    },
  );

  // ═══════════════════ TASKS ═══════════════════

  // GET /api/admin/tasks
  server.get(
    "/api/admin/tasks",
    {
      ...guard,
      schema: {
        tags: ["admin"],
        summary: "List tasks",
        querystring: {
          type: "object",
          properties: {
            page: { type: "integer", minimum: 1, default: 1 },
            pageSize: {
              type: "integer",
              minimum: 1,
              maximum: 100,
              default: 20,
            },
            priority: { type: "string", maxLength: 32 },
            status: { type: "string", maxLength: 32 },
            phase: { type: "string", maxLength: 32 },
            search: { type: "string", maxLength: 100 },
          },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      try {
        const result = await service.listTasks(req.query as any);
        return reply.send({
          success: true,
          data: result,
          message: "تسک‌ها دریافت شدند",
        });
      } catch (error) {
        server.log.error({ err: error }, "admin list tasks failed");
        return sendError(reply, error, "خطا در دریافت تسک‌ها");
      }
    },
  );

  // GET /api/admin/tasks/:id
  server.get(
    "/api/admin/tasks/:id",
    {
      ...guard,
      schema: { tags: ["admin"], summary: "Get task", params: IdParam },
    },
    async (req, reply) => {
      try {
        const { id } = req.params as { id: number };
        const task = await service.getTask(id);
        if (!task)
          return reply
            .code(404)
            .send({ success: false, error: "تسک یافت نشد" });
        return reply.send({
          success: true,
          data: task,
          message: "تسک دریافت شد",
        });
      } catch (error) {
        server.log.error(
          { err: error, id: (req.params as any).id },
          "admin get task failed",
        );
        return sendError(reply, error, "خطا در دریافت تسک");
      }
    },
  );

  // POST /api/admin/tasks
  server.post(
    "/api/admin/tasks",
    {
      ...guard,
      schema: {
        tags: ["admin"],
        summary: "Create task",
        body: {
          type: "object",
          required: ["title"],
          additionalProperties: false,
          properties: {
            title: { type: "string", minLength: 1, maxLength: 255 },
            description: { type: ["string", "null"], maxLength: 10_000 },
            priority: { type: ["string", "null"], maxLength: 32 },
            status: { type: ["string", "null"], maxLength: 32 },
            phase: { type: ["string", "null"], maxLength: 32 },
            due_date: { type: ["string", "null"], format: "date" },
            assignee_id: { type: ["integer", "null"], minimum: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const task = await service.createTask(req.body as any);
        return reply
          .code(201)
          .send({ success: true, data: task, message: "تسک جدید ایجاد شد" });
      } catch (error) {
        server.log.error({ err: error }, "admin create task failed");
        return sendError(reply, error, "خطا در ایجاد تسک");
      }
    },
  );

  // PUT /api/admin/tasks/:id
  server.put(
    "/api/admin/tasks/:id",
    {
      ...guard,
      schema: {
        tags: ["admin"],
        summary: "Update task",
        params: IdParam,
        body: {
          type: "object",
          additionalProperties: false,
          minProperties: 1,
          properties: {
            title: { type: "string", minLength: 1, maxLength: 255 },
            description: { type: ["string", "null"], maxLength: 10_000 },
            priority: { type: ["string", "null"], maxLength: 32 },
            status: { type: ["string", "null"], maxLength: 32 },
            phase: { type: ["string", "null"], maxLength: 32 },
            due_date: { type: ["string", "null"], format: "date" },
            assignee_id: { type: ["integer", "null"], minimum: 1 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const { id } = req.params as { id: number };
        const task = await service.updateTask(id, req.body as any);
        return reply.send({
          success: true,
          data: task,
          message: "تسک به‌روزرسانی شد",
        });
      } catch (error) {
        server.log.error(
          { err: error, id: (req.params as any).id },
          "admin update task failed",
        );
        return sendError(reply, error, "خطا در بروزرسانی تسک");
      }
    },
  );

  // DELETE /api/admin/tasks/:id
  server.delete(
    "/api/admin/tasks/:id",
    {
      ...guard,
      schema: { tags: ["admin"], summary: "Delete task", params: IdParam },
    },
    async (req, reply) => {
      try {
        const { id } = req.params as { id: number };
        await service.deleteTask(id);
        return reply.send({ success: true, message: "تسک حذف شد" });
      } catch (error) {
        server.log.error(
          { err: error, id: (req.params as any).id },
          "admin delete task failed",
        );
        return sendError(reply, error, "خطا در حذف تسک");
      }
    },
  );

  server.log.info("Admin routes registered");
}
