import postgres from "postgres";
import { logger } from "#utils/logger";

export interface UserWithRole {
  id: number;
  email: string;
  username?: string;
  displayName?: string;
  avatarUrl?: string;
  phone?: string;
  country?: string;
  city?: string;
  verified: boolean;
  is_admin: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface PaginatedUserList {
  users: UserWithRole[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export class AdminService {
  private sql: postgres.Sql;

  constructor(sql: postgres.Sql) {
    this.sql = sql;
  }

  // ============ User Management ============

  async listUsers(
    filters: {
      page?: number;
      pageSize?: number;
      search?: string;
      is_admin?: boolean;
      verified?: boolean;
      dateFrom?: Date;
      dateTo?: Date;
    } = {},
  ): Promise<PaginatedUserList> {
    try {
      const {
        page = 1,
        pageSize = 20,
        search = "",
        is_admin = undefined,
        verified = undefined,
        dateFrom = undefined,
        dateTo = undefined,
      } = filters;

      const start = (page - 1) * pageSize;

      // Build query conditions as sql fragments (NOT $n strings)
      const conditions = [];

      if (search) {
        const like = `%${search}%`;
        conditions.push(
          this
            .sql`(users.email ILIKE ${like} OR users.username ILIKE ${like} OR users.display_name ILIKE ${like})`,
        );
      }

      if (is_admin !== undefined) {
        conditions.push(this.sql`users.is_admin = ${is_admin}`);
      }

      if (verified !== undefined) {
        conditions.push(this.sql`users.verified = ${verified}`);
      }

      if (dateFrom) {
        conditions.push(this.sql`users.created_at >= ${dateFrom}`);
      }

      if (dateTo) {
        conditions.push(this.sql`users.created_at <= ${dateTo}`);
      }

      const whereClause = conditions.length
        ? this.sql`WHERE ${conditions.reduce((acc, c, i) =>
            i === 0 ? c : this.sql`${acc} AND ${c}`,
          )}`
        : this.sql``;

      // Count total
      const countResult = await this.sql`
      SELECT COUNT(*)::int as total
      FROM users
      ${whereClause}
    `;

      const total = countResult[0]?.total || 0;
      const totalPages = Math.ceil(total / pageSize);

      // Get users
      const result = await this.sql`
      SELECT
        users.id,
        users.email,
        users.username,
        users.display_name,
        users.avatar_url,
        users.phone,
        users.country,
        users.city,
        users.verified,
        users.is_admin,
        users.created_at,
        users.updated_at
      FROM users
      ${whereClause}
      ORDER BY users.created_at DESC
      LIMIT ${pageSize}
      OFFSET ${start}
    `;

      const users = result.map((row) => this.mapToUserWithRole(row));

      return { users, total, page, pageSize, totalPages };
    } catch (error) {
      logger.error(error, "Failed to list users");
      throw error;
    }
  }

  async getUser(id: number): Promise<UserWithRole | null> {
    try {
      const result = await this.sql`
        SELECT 
          users.id,
          users.email,
          users.username,
          users.display_name,
          users.avatar_url,
          users.phone,
          users.country,
          users.city,
          users.verified,
          users.is_admin,
          users.created_at,
          users.updated_at
        FROM users
        WHERE users.id = ${id}
      `;

      if (result.length === 0) {
        return null;
      }

      return this.mapToUserWithRole(result[0]);
    } catch (error) {
      logger.error(error, `Failed to get user: ${id}`);
      throw error;
    }
  }

  async updateUserRole(id: number, is_admin: boolean): Promise<UserWithRole> {
    try {
      const result = await this.sql`
        UPDATE users
        SET is_admin = ${is_admin}, updated_at = NOW()
        WHERE id = ${id}
        RETURNING 
          users.id,
          users.email,
          users.username,
          users.display_name,
          users.avatar_url,
          users.phone,
          users.country,
          users.city,
          users.verified,
          users.is_admin,
          users.created_at,
          users.updated_at
      `;

      if (result.length === 0) {
        throw new Error("کاربر یافت نشد");
      }

      logger.info(`Admin role updated for user ${id}: is_admin=${is_admin}`);
      return this.mapToUserWithRole(result[0]);
    } catch (error) {
      logger.error(error, `Failed to update user role: ${id}`);
      throw error;
    }
  }

  async deleteUser(id: number): Promise<void> {
    try {
      // Prevent self-deletion
      const adminId = await this.getAdminUserId();
      if (id === adminId) {
        throw new Error("نمی‌توانید حساب مدیر فعلی را حذف کنید");
      }

      const result = await this.sql`
        DELETE FROM users WHERE id = ${id}
      `;

      logger.info(`User deleted: ${id}`);
    } catch (error) {
      logger.error(error, `Failed to delete user: ${id}`);
      throw error;
    }
  }

  async getAdminUserId(): Promise<number> {
    const result = await this.sql`
      SELECT id FROM users WHERE is_admin = true LIMIT 1
    `;
    return result[0]?.id;
  }

  // ============ Ticket Management ============

  async listTickets(
    filters: {
      page?: number;
      pageSize?: number;
      status?: string;
      userId?: number;
      search?: string;
    } = {},
  ) {
    try {
      const {
        page = 1,
        pageSize = 20,
        status = undefined,
        userId = undefined,
        search = "",
      } = filters;

      const start = (page - 1) * pageSize;

      let conditions: string[] = [];
      let params: any[] = [];
      let id = 1;

      if (status) {
        conditions.push(`t.status = ${id}`);
        params.push(status);
        id++;
      }

      if (userId) {
        conditions.push(`t.user_id = ${id}`);
        params.push(userId);
        id++;
      }

      if (search) {
        conditions.push(`(t.title ILIKE ${id} OR t.description ILIKE ${id})`);
        params.push(`%${search}%`);
        id++;
      }

      const whereClause =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      // Count total
      const countResult = await this.sql`
        SELECT COUNT(*)::int as total FROM tickets t ${whereClause}
      `;

      const total = countResult[0]?.total || 0;
      const totalPages = Math.ceil(total / pageSize);

      // Get tickets
      const result = await this.sql`
        SELECT 
          t.id,
          t.user_id,
          t.title,
          t.description,
          t.status,
          t.last_message,
          t.last_message_at,
          t.created_at,
          t.updated_at,
          u.email as user_email,
          u.display_name as user_name
        FROM tickets t
        JOIN users u ON t.user_id = u.id
        ${whereClause}
        ORDER BY t.created_at DESC
        LIMIT ${pageSize}
        OFFSET ${start}
      `;

      return {
        tickets: result,
        total,
        page,
        pageSize,
        totalPages,
      };
    } catch (error) {
      logger.error(error, "Failed to list tickets");
      throw error;
    }
  }

  async getTicket(id: number) {
    try {
      const result = await this.sql`
        SELECT 
          t.id,
          t.user_id,
          t.title,
          t.description,
          t.status,
          t.last_message,
          t.last_message_at,
          t.created_at,
          t.updated_at,
          u.email as user_email,
          u.display_name as user_name
        FROM tickets t
        JOIN users u ON t.user_id = u.id
        WHERE t.id = ${id}
      `;

      if (result.length === 0) {
        return null;
      }

      return result[0];
    } catch (error) {
      logger.error(error, `Failed to get ticket: ${id}`);
      throw error;
    }
  }

  async updateTicketStatus(id: number, status: string) {
    try {
      const validStatuses = ["open", "pending", "resolved", "closed"];
      if (!validStatuses.includes(status)) {
        throw new Error("وضعیت نامعتبر است");
      }

      const result = await this.sql`
        UPDATE tickets
        SET status = ${status}, updated_at = NOW()
        WHERE id = ${id}
        RETURNING *
      `;

      if (result.length === 0) {
        throw new Error("تیکت یافت نشد");
      }

      logger.info(`Ticket status updated: ${id} to ${status}`);
      return result[0];
    } catch (error) {
      logger.error(error, `Failed to update ticket status: ${id}`);
      throw error;
    }
  }

  async addTicketMessage(ticketId: number, userId: number, message: string) {
    try {
      const result = await this.sql`
        INSERT INTO ticket_messages (ticket_id, user_id, message, created_at)
        VALUES (${ticketId}, ${userId}, ${message}, NOW())
        RETURNING *
      `;

      logger.info(`Message added to ticket ${ticketId} by user ${userId}`);
      return result[0];
    } catch (error) {
      logger.error(error, `Failed to add ticket message: ${ticketId}`);
      throw error;
    }
  }

  async getTicketMessages(ticketId: number, page = 1, pageSize = 50) {
    const start = (page - 1) * pageSize;

    const result = await this.sql`
      SELECT 
        tm.id,
        tm.ticket_id,
        tm.user_id,
        tm.message,
        tm.created_at,
        u.email as user_email,
        u.display_name as user_name,
        u.is_admin
      FROM ticket_messages tm
      JOIN users u ON tm.user_id = u.id
      WHERE tm.ticket_id = ${ticketId}
      ORDER BY tm.created_at ASC, tm.id ASC
      LIMIT ${pageSize}
      OFFSET ${start}
    `;

    return result;
  }

  // ============ Stock Management ============

  async updateStock(symbol: string, updates: Partial<any>) {
    try {
      const allowedFields = ["name", "sector", "isin", "shares_outstanding"];
      const validUpdates: Record<string, any> = {};

      for (const field of allowedFields) {
        if (updates[field] !== undefined) {
          validUpdates[field] = updates[field];
        }
      }

      if (Object.keys(validUpdates).length === 0) {
        throw new Error("هیچ داده‌ای برای آپدیت وجود ندارد");
      }

      const result = await this.sql`
        UPDATE stocks
        SET ${this.sql(validUpdates)}, updated_at = NOW()
        WHERE symbol = ${symbol}
        RETURNING *
      `;

      if (result.length === 0) {
        throw new Error("سهام یافت نشد");
      }

      logger.info(`Stock ${symbol} updated by admin`);
      return result[0];
    } catch (error) {
      logger.error(error, `Failed to update stock: ${symbol}`);
      throw error;
    }
  }

  async deleteStock(symbol: string) {
    try {
      const result = await this.sql`
        DELETE FROM stocks WHERE symbol = ${symbol}
      `;

      if (result.length === 0) {
        throw new Error("سهام یافت نشد");
      }

      logger.info(`Stock ${symbol} deleted by admin`);
    } catch (error) {
      logger.error(error, `Failed to delete stock: ${symbol}`);
      throw error;
    }
  }

  private mapToUserWithRole(row: any): UserWithRole {
    return {
      id: row.id,
      email: row.email,
      username: row.username,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      phone: row.phone,
      country: row.country,
      city: row.city,
      verified: row.verified,
      is_admin: row.is_admin,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
