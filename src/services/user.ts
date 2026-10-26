import bcrypt from "bcryptjs";
import crypto from "crypto";
import postgres from "postgres";
import { emailService } from "./email.js";
import { ConflictError, ValidationError } from "../errors.js";
import { logger } from "../utils/logger.js";

export interface CreateUserDTO {
  email: string;
  password: string;
  username?: string;
  displayName?: string;
}

export interface VerifyEmailDTO {
  token: string;
}

export interface ResetPasswordDTO {
  token: string;
  newPassword: string;
}

export interface User {
  id: number;
  email: string;
  username?: string;
  displayName?: string;
  avatarUrl?: string;
  phone?: string;
  country?: string;
  city?: string;
  verified: boolean;
  emailVerifiedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  is_admin?: boolean;
  passwordHash?: string;
}

export class UserService {
  private sql: postgres.Sql;

  constructor(sql: postgres.Sql) {
    this.sql = sql;
  }

  async createUser(dto: CreateUserDTO): Promise<{ user: User; token: string }> {
    const email = dto.email?.trim().toLowerCase();
    const username = dto.username?.trim() || null;
    const displayName = dto.displayName?.trim() || null;

    // 1) اعتبارسنجی
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(email)) {
      throw new ValidationError("ایمیل معتبر نیست");
    }
    if (!dto.password || dto.password.length < 8) {
      throw new ValidationError("رمز عبور باید حداقل ۸ کاراکتر باشد");
    }

    // 2) هش رمز + توکن
    const passwordHash = await bcrypt.hash(dto.password, 12);
    const token = crypto.randomBytes(32).toString("hex");

    // 3) INSERT — خطاهای DB را نگاشت کنید
    let user: User;
    try {
      const result = await this.sql`
      INSERT INTO users (email, password_hash, username, display_name,
                         verify_token, verify_expires_at, created_at, updated_at)
      VALUES (${email}, ${passwordHash}, ${username}, ${displayName},
              ${token}, NOW() + INTERVAL '24 hours', NOW(), NOW())
      RETURNING id, email, username, display_name, avatar_url, phone, country,
                city, verified, email_verified_at, created_at, updated_at
    `;
      if (!result?.length) throw new Error("خطا در ایجاد حساب کاربری");
      user = this.mapToUser(result[0]);

      // Send verification email
      await emailService.sendVerificationEmail(
        user.email,
        token,
        user.username || user.displayName,
      );
    } catch (err: any) {
      // 23505 = unique_violation
      if (err?.code === "23505") {
        if (err.constraint_name === "idx_users_username") {
          throw new ConflictError("این نام کاربری قبلاً گرفته شده است");
        }
        if (
          err.constraint_name === "idx_users_email" ||
          err.constraint_name?.includes("email")
        ) {
          throw new ConflictError("ایمیل از قبل ثبت شده است");
        }
        throw new ConflictError("این اطلاعات قبلاً ثبت شده است");
      }
      logger.error({ err }, "Failed to create user");
      throw err; // خطاهای ناشناخته → 500
    }

    logger.info(`User created: ${user.email} (ID: ${user.id})`);
    return { user, token };
  }

  async verifyEmail(token: string): Promise<User> {
    try {
      // Find verification token
      const tokenResult = await this.sql`
        SELECT * FROM auth_tokens 
        WHERE token = ${token} 
          AND type = 'verification'
          AND expires_at > NOW()
          AND used_at IS NULL
      `;

      if (!tokenResult || tokenResult.length === 0) {
        throw new Error("لینک تأیید معتبر نیست یا منقضی شده است");
      }

      const authToken = tokenResult[0];

      if (!authToken) {
        throw new Error("لینک بازیابی معتبر نیست یا منقضی شده است");
      }

      // Get user
      const userResult = await this.sql`
        SELECT * FROM users WHERE id = ${authToken.user_id}
      `;

      if (!userResult || userResult.length === 0) {
        throw new Error("کاربر یافت نشد");
      }

      const user = this.mapToUser(userResult[0]);

      // Mark email as verified
      await this.sql`
        UPDATE users 
        SET verified = TRUE, email_verified_at = NOW(), updated_at = NOW()
        WHERE id = ${user.id}
      `;

      // Mark token as used
      await this.sql`
        UPDATE auth_tokens 
        SET used_at = NOW()
        WHERE id = ${authToken.id}
      `;

      logger.info(`Email verified for user: ${user.email}`);

      return user;
    } catch (error) {
      logger.error(error, "Failed to verify email");
      throw error;
    }
  }

  async findByEmail(email: string): Promise<User | null> {
    try {
      const result = await this.sql`
        SELECT * FROM users WHERE email = ${email}
      `;

      if (!result || result.length === 0) {
        return null;
      }

      return this.mapToUser(result[0]);
    } catch (error) {
      logger.error(error, `Failed to find user by email: ${email}`);
      return null;
    }
  }

  async findByUserId(id: number): Promise<User | null> {
    try {
      const result = await this.sql`
        SELECT * FROM users WHERE id = ${id}
      `;

      if (!result || result.length === 0) {
        return null;
      }

      return this.mapToUser(result[0]);
    } catch (error) {
      logger.error(error, `Failed to find user by ID: ${id}`);
      return null;
    }
  }

  async updateProfile(userId: number, updates: Partial<User>): Promise<User> {
    try {
      // API field (camelCase) -> DB column (snake_case)
      const fieldMap = {
        username: "username",
        displayName: "display_name",
        avatarUrl: "avatar_url",
        phone: "phone",
        country: "country",
        city: "city",
      } as const;

      const patch: Record<string, string | null> = {};
      for (const [apiKey, column] of Object.entries(fieldMap) as [
        keyof typeof fieldMap,
        string,
      ][]) {
        const value = updates[apiKey];
        if (value === undefined) continue;
        patch[column] =
          typeof value === "string" && value.trim() === ""
            ? null
            : (value ?? null);
      }

      if (Object.keys(patch).length === 0) {
        throw new ValidationError("هیچ داده‌ای برای آپدیت وجود ندارد");
      }

      const result = await this.sql`
      UPDATE users
      SET ${this.sql(patch)}, updated_at = NOW()
      WHERE id = ${userId}
      RETURNING id, email, username, display_name, avatar_url, phone,
                country, city, verified, email_verified_at,
                created_at, updated_at
    `;

      const row = result?.[0];
      if (!row) {
        throw new Error("کاربر یافت نشد");
      }

      const updatedUser = this.mapToUser(row);
      logger.info(`Profile updated for user: ${updatedUser.email}`);
      return updatedUser;
    } catch (error) {
      logger.error(error, "Failed to update profile");
      throw error;
    }
  }

  async resetPassword(token: string, newPassword: string): Promise<User> {
    if (!newPassword || newPassword.length < 8) {
      throw new ValidationError("رمز عبور باید حداقل ۸ کاراکتر باشد");
    }

    try {
      const passwordHash = await bcrypt.hash(newPassword, 12);

      const result = await this.sql.begin(async (tx) => {
        // Lock the token row so it can't be consumed twice concurrently
        const tokenResult = await tx`
        SELECT * FROM auth_tokens
        WHERE token = ${token}
          AND type = 'password_reset'
          AND expires_at > NOW()
          AND used_at IS NULL
        FOR UPDATE
      `;

        if (!tokenResult || tokenResult.length === 0) {
          throw new Error("لینک بازیابی معتبر نیست یا منقضی شده است");
        }

        const authToken = tokenResult[0];

        if (!authToken) {
          throw new Error("لینک بازیابی معتبر نیست یا منقضی شده است");
        }

        const updatedUsers = await tx`
        UPDATE users
        SET password_hash = ${passwordHash}, updated_at = NOW()
        WHERE id = ${authToken.user_id}
        RETURNING id, email, username, display_name, avatar_url, phone,
                  country, city, verified, email_verified_at,
                  created_at, updated_at
      `;

        if (!updatedUsers || updatedUsers.length === 0) {
          throw new Error("کاربر یافت نشد");
        }

        await tx`
        UPDATE auth_tokens
        SET used_at = NOW()
        WHERE id = ${authToken.id}
      `;

        return updatedUsers[0];
      });

      const user = this.mapToUser(result);
      logger.info(`Password reset for user ID: ${user.id}`);
      return user;
    } catch (error) {
      logger.error(error, "Failed to reset password");
      throw error;
    }
  }

  async requestPasswordReset(email: string): Promise<boolean> {
    try {
      const user = await this.findByEmail(email);
      if (!user) {
        // Don't reveal if user exists or not for security
        return true;
      }

      // Generate reset token
      const token = crypto.randomBytes(32).toString("hex");

      // Store reset token (overwrite if exists)
      await this.sql`
        DELETE FROM auth_tokens WHERE user_id = ${user.id} AND type = 'password_reset' AND used_at IS NULL;

        INSERT INTO auth_tokens (user_id, token, type, expires_at)
        VALUES (${user.id}, ${token}, 'password_reset', NOW() + INTERVAL '1 hour')
      `;

      await emailService.sendPasswordResetEmail(
        user.email,
        token,
        user.username || user.displayName,
      );
      return true;
    } catch (error) {
      logger.error(error, "Failed to request password reset");
      throw error;
    }
  }

  async authenticate(email: string, password: string): Promise<User> {
    try {
      const user = await this.findByEmail(email);
      if (!user || !user.passwordHash) {
        throw new Error("ایمیل یا رمز عبور اشتباه است");
      }

      const isValid = await bcrypt.compare(password, user.passwordHash);
      if (!isValid) {
        throw new Error("ایمیل یا رمز عبور اشتباه است");
      }

      if (!user.verified) {
        throw new Error("لطفاً ابتدا ایمیل خود را تأیید کنید");
      }

      return user;
    } catch (error) {
      logger.error(error, `Authentication failed for email: ${email}`);
      throw error;
    }
  }

  private mapToUser(row: any): User {
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
      emailVerifiedAt: row.email_verified_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      passwordHash: row.password_hash,
      is_admin: row.is_admin ?? false,
    };
  }
}
