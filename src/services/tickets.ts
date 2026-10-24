import type postgres from "postgres";
import { logger } from "#utils/logger";

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export interface Ticket {
  id: number;
  userId: number;
  title: string;
  description: string | null;
  status: string;
  lastMessage: string | null;
  lastMessageAt: Date | null;
  lastMessageBy: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TicketMessage {
  id: number;
  ticketId: number;
  userId: number;
  message: string;
  createdAt: Date;
}

// Raw row shapes coming out of postgres.js
interface TicketRow {
  id: number | string;
  user_id: number | string;
  title: string;
  description: string | null;
  status: string;
  last_message: string | null;
  last_message_at: Date | null;
  last_message_by: number | string | null;
  created_at: Date;
  updated_at: Date;
}

interface TicketMessageRow {
  id: number | string;
  ticket_id: number | string;
  user_id: number | string;
  message: string;
  created_at: Date;
}

interface TicketOwnerRow {
  id: number | string;
  user_id: number | string;
}

// ─────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────

export class TicketService {
  private sql: postgres.Sql;

  constructor(sql: postgres.Sql) {
    this.sql = sql;
  }

  // ─────────────────────────────────────────────
  // POST — ایجاد تیکت جدید
  // ─────────────────────────────────────────────

  async addTicket(
    userId: number,
    title: string,
    description: string,
  ): Promise<number> {
    try {
      return await this.sql.begin(async (tx) => {
        const [ticket] = await tx<{ id: number | string }[]>`
        INSERT INTO tickets (user_id, title, description, created_at, updated_at)
        VALUES (${userId}, ${title}, ${description}, NOW(), NOW())
        RETURNING id
      `;

        const id = Number(ticket!.id);

        await tx`
        INSERT INTO ticket_messages (ticket_id, user_id, message, created_at)
        VALUES (${id}, ${userId}, ${description}, NOW())
      `;

        logger.info(
          `Added ticket id=${id} with seed message (userId=${userId})`,
        );
        return id;
      });
    } catch (error) {
      logger.error(error, `Failed to add ticket "${title}"`);
      throw error;
    }
  }

  // ─────────────────────────────────────────────
  // GET — لیست تیکت‌های کاربر
  // ─────────────────────────────────────────────
  async listByUser(userId: number, limit = 20, offset = 0): Promise<Ticket[]> {
    try {
      const rows = await this.sql<TicketRow[]>`
        SELECT id, user_id, title, description, status,
               last_message, last_message_at, last_message_by,
               created_at, updated_at
        FROM tickets
        WHERE user_id = ${userId}
        ORDER BY last_message_at DESC NULLS LAST, created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      return rows.map((r) => this.mapTicketRow(r));
    } catch (error) {
      logger.error(error, `Failed to list tickets for userId=${userId}`);
      throw error;
    }
  }

  // ─────────────────────────────────────────────
  // GET /:id — جزئیات یک تیکت
  // ─────────────────────────────────────────────
  async findById(userId: number, ticketId: number): Promise<Ticket | null> {
    try {
      const [row] = await this.sql<TicketRow[]>`
        SELECT id, user_id, title, description, status,
               last_message, last_message_at, last_message_by,
               created_at, updated_at
        FROM tickets
        WHERE id = ${ticketId} AND user_id = ${userId}
        LIMIT 1
      `;
      return row ? this.mapTicketRow(row) : null;
    } catch (error) {
      logger.error(
        error,
        `Failed to find ticket id=${ticketId} for userId=${userId}`,
      );
      throw error;
    }
  }

  // ─────────────────────────────────────────────
  // POST /:id/messages — افزودن پیام
  // Returns the new message id, or null if the
  // ticket doesn't exist / doesn't belong to user.
  // ─────────────────────────────────────────────
  async addMessage(
    userId: number,
    ticketId: number,
    message: string,
    isStaff = false,
  ): Promise<number | null> {
    try {
      const [ticket] = await this.sql<TicketOwnerRow[]>`
        SELECT id, user_id FROM tickets WHERE id = ${ticketId} LIMIT 1
      `;

      if (!ticket) return null;

      // Deliberately return null (→ 404) rather than 403 so we
      // don't leak whether the ticket exists.
      if (!this.isOwnerOrStaff(ticket, userId, isStaff)) return null;

      // The `sync_ticket_last_message` trigger updates
      // tickets.last_message / last_message_at / last_message_by
      // inside the same implicit transaction.
      const [row] = await this.sql<{ id: number | string }[]>`
        INSERT INTO ticket_messages (ticket_id, user_id, message, created_at)
        VALUES (${ticketId}, ${userId}, ${message}, NOW())
        RETURNING id
      `;

      const id = Number(row!.id);
      logger.info(
        `Added message id=${id} to ticket id=${ticketId} by userId=${userId}`,
      );
      return id;
    } catch (error) {
      logger.error(
        error,
        `Failed to add message to ticket id=${ticketId} by userId=${userId}`,
      );
      throw error;
    }
  }

  // ─────────────────────────────────────────────
  // GET /:id/messages — لیست پیام‌های تیکت
  // Returns null if the ticket doesn't exist / isn't owned.
  // ─────────────────────────────────────────────
  async listMessages(
    userId: number,
    ticketId: number,
    limit = 50,
    offset = 0,
    isStaff = false,
  ): Promise<TicketMessage[] | null> {
    try {
      const [ticket] = await this.sql<TicketOwnerRow[]>`
        SELECT id, user_id FROM tickets WHERE id = ${ticketId} LIMIT 1
      `;

      if (!ticket) return null;
      if (!this.isOwnerOrStaff(ticket, userId, isStaff)) return null;

      const rows = await this.sql<TicketMessageRow[]>`
        SELECT id, ticket_id, user_id, message, created_at
        FROM ticket_messages
        WHERE ticket_id = ${ticketId}
        ORDER BY created_at ASC, id ASC
        LIMIT ${limit} OFFSET ${offset}
      `;

      return rows.map((r) => this.mapMessageRow(r));
    } catch (error) {
      logger.error(
        error,
        `Failed to list messages for ticket id=${ticketId} by userId=${userId}`,
      );
      throw error;
    }
  }

  // ─────────────────────────────────────────────
  // helpers
  // ─────────────────────────────────────────────

  /**
   * Ownership check shared by addMessage and listMessages.
   *
   * ⚠️ postgres.js returns BIGINT / BIGSERIAL columns as strings,
   * so `ticket.user_id` may be `"42"` while `userId` is `42`.
   * `"42" !== 42` is true — must coerce both sides to Number.
   */
  private isOwnerOrStaff(
    ticket: TicketOwnerRow,
    userId: number,
    isStaff: boolean,
  ): boolean {
    if (isStaff) return true;
    return Number(ticket.user_id) === Number(userId);
  }

  private mapTicketRow(r: TicketRow): Ticket {
    return {
      id: Number(r.id),
      userId: Number(r.user_id),
      title: r.title,
      description: r.description,
      status: r.status,
      lastMessage: r.last_message,
      lastMessageAt: r.last_message_at,
      lastMessageBy:
        r.last_message_by != null ? Number(r.last_message_by) : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  private mapMessageRow(r: TicketMessageRow): TicketMessage {
    return {
      id: Number(r.id),
      ticketId: Number(r.ticket_id),
      userId: Number(r.user_id),
      message: r.message,
      createdAt: r.created_at,
    };
  }
}
