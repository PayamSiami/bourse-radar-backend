import type { FastifyInstance } from "fastify";
import { TicketService } from "#services/tickets";
import { createAuthMiddleware } from "../middleware/auth.js";
import { z } from "zod";

const AddTicketSchema = z.object({
  title: z.string().trim().min(1, "عنوان الزامی است").max(255),
  description: z.string().trim().min(1, "توضیحات الزامی است").max(1000),
});

const ListTicketsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

const AddMessageSchema = z.object({
  message: z.string().trim().min(1, "متن پیام الزامی است").max(5000),
});

export function registerTicketsRoutes(server: FastifyInstance, prefix = "") {
  // ── POST /api/tickets
  server.post(
    `${prefix}`,
    {
      preHandler: [createAuthMiddleware(server)],
      schema: {
        tags: ["tickets"],
        summary: "create ticket",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const parsed = AddTicketSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: parsed.error.issues,
        });
      }

      try {
        const service = new TicketService(server.db);
        const id = await service.addTicket(
          req.user!.id,
          parsed.data.title,
          parsed.data.description,
        );

        return reply.status(201).send({
          success: true,
          id,
          message: "تیکت با موفقیت ثبت شد",
        });
      } catch (error) {
        req.log.error({ err: error }, "Failed to add ticket");
        return reply.status(500).send({
          success: false,
          error: "خطا در ثبت تیکت",
        });
      }
    },
  );

  // ── GET /api/tickets ── لیست تیکت‌ها
  server.get(
    `${prefix}`,
    {
      preHandler: [createAuthMiddleware(server)],
      schema: {
        tags: ["tickets"],
        summary: "دریافت لیست تیکت‌های کاربر",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const parsed = ListTicketsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: parsed.error.issues,
        });
      }

      try {
        const service = new TicketService(server.db);
        const tickets = await service.listByUser(
          req.user!.id,
          parsed.data.limit,
          parsed.data.offset,
        );

        return reply.send({
          success: true,
          count: tickets.length,
          tickets,
        });
      } catch (error) {
        req.log.error({ err: error }, "Failed to list tickets");
        return reply.status(500).send({
          success: false,
          error: "خطا در دریافت تیکت‌ها",
        });
      }
    },
  );

  // ── GET /api/tickets/:id ── جزئیات یک تیکت
  server.get(
    `${prefix}/:id`,
    {
      preHandler: [createAuthMiddleware(server)],
      schema: {
        tags: ["tickets"],
        summary: "دریافت جزئیات یک تیکت",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const id = Number((req.params as { id: string }).id);
      if (!Number.isInteger(id) || id <= 0) {
        return reply.status(400).send({
          success: false,
          error: "شناسهٔ تیکت نامعتبر است",
        });
      }

      try {
        const service = new TicketService(server.db);
        const ticket = await service.findById(req.user!.id, id);

        if (!ticket) {
          return reply.status(404).send({
            success: false,
            error: "تیکت یافت نشد",
          });
        }

        return reply.send({ success: true, ticket });
      } catch (error) {
        req.log.error({ err: error }, "Failed to fetch ticket");
        return reply.status(500).send({
          success: false,
          error: "خطا در دریافت تیکت",
        });
      }
    },
  );

  server.post(
    `${prefix}/:id/messages`,
    {
      preHandler: [createAuthMiddleware(server)],
      schema: {
        tags: ["tickets"],
        summary: "افزودن پیام به تیکت",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const id = Number((req.params as { id: string }).id);
      if (!Number.isInteger(id) || id <= 0) {
        return reply.status(400).send({
          success: false,
          error: "شناسهٔ تیکت نامعتبر است",
        });
      }

      const parsed = AddMessageSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          error: parsed.error.issues,
        });
      }

      try {
        const service = new TicketService(server.db);
        const message = await service.addMessage(
          req.user!.id,
          id,
          parsed.data.message,
        );

        if (!message) {
          return reply.status(404).send({
            success: false,
            error: "تیکت یافت نشد",
          });
        }

        return reply.status(201).send({
          success: true,
          message: "پیام با موفقیت ثبت شد",
          data: message,
        });
      } catch (error) {
        req.log.error({ err: error }, "Failed to add ticket message");
        return reply.status(500).send({
          success: false,
          error: "خطا در ثبت پیام",
        });
      }
    },
  );

  server.get(
    `${prefix}/:id/messages`,
    {
      preHandler: [createAuthMiddleware(server)],
      schema: {
        tags: ["tickets"],
        summary: "دریافت پیام‌های تیکت",
        security: [{ bearerAuth: [] }],
      },
    },
    async (req, reply) => {
      const id = Number((req.params as { id: string }).id);
      if (!Number.isInteger(id) || id <= 0) {
        return reply
          .status(400)
          .send({ success: false, error: "شناسهٔ تیکت نامعتبر است" });
      }

      const parsed = ListTicketsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ success: false, error: parsed.error.issues });
      }

      try {
        const service = new TicketService(server.db);
        const messages = await service.listMessages(
          req.user!.id,
          id,
          parsed.data.limit,
          parsed.data.offset,
        );
        if (messages === null) {
          return reply
            .status(404)
            .send({ success: false, error: "Ticket not found!" });
        }
        return reply.send({ success: true, count: messages.length, messages });
      } catch (error) {
        req.log.error({ err: error }, "Failed to list ticket messages");
        return reply
          .status(500)
          .send({ success: false, error: "خطا در دریافت پیام‌ها" });
      }
    },
  );
}
