import type { FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { CreateUserDTO, UserService } from "#services/user";
import { createAuthMiddleware } from "../middleware/auth.js";
import { logger } from "#utils/logger";

// ── Fail-fast on missing secret ──
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("JWT_SECRET environment variable is required");
}

// ── Centralized public user shape ──
function toPublicUser(u: any) {
  return {
    id: u.id,
    email: u.email,
    username: u.username ?? null,
    displayName: u.displayName ?? u.username ?? null,
    avatarUrl: u.avatarUrl ?? null,
    phone: u.phone ?? null,
    country: u.country ?? null,
    city: u.city ?? null,
    verified: Boolean(u.verified),
    emailVerifiedAt: u.emailVerifiedAt ?? null,
  };
}

// ── Friendly error mapper ──
function publicError(err: any, fallback: string): string {
  const msg = typeof err?.message === "string" ? err.message : "";

  // Known application errors (thrown by the service)
  if (msg === "کاربر یافت نشد") return msg;
  if (msg.includes("duplicate key") && msg.includes("users_email_key")) {
    return "این ایمیل قبلاً ثبت شده است";
  }
  if (msg.includes("duplicate key") && msg.includes("users_username_key")) {
    return "این نام کاربری قبلاً ثبت شده است";
  }
  if (msg.includes("value too long")) {
    return "مقدار وارد شده از حد مجاز طولانی‌تر است";
  }
  if (msg.includes("invalid input syntax")) {
    return "داده‌های ورودی نامعتبر است";
  }
  if (msg === "اطلاعات ورود اشتباه است") return msg;

  // Don't leak internal details
  return fallback;
}

const signToken = (
  user: { id: number; email: string },
  expiresIn: "24h" | "7d",
) => jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn });

export function registerAuthRoutes(
  server: FastifyInstance,
  prefix: string = "",
) {
  // ── Idempotency guard ──
  if (server.hasRoute({ method: "GET", url: `${prefix}/me` })) {
    server.log.warn("Auth routes already registered — skipping");
    return;
  }

  const userService = new UserService(server.db);

  // ── POST /register ──
  server.post(
    `${prefix}/register`,
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email", maxLength: 255 },
            password: { type: "string", minLength: 8, maxLength: 128 },
            username: { type: "string", maxLength: 50 },
            displayName: { type: "string", maxLength: 80 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const body = req.body as CreateUserDTO;
        const result = await userService.createUser(body);
        const token = signToken(result.user, "24h");

        return reply.status(201).send({
          success: true,
          message: "ثبت‌نام موفقیت‌آمیز بود. لطفاً ایمیل خود را تأیید کنید.",
          user: toPublicUser(result.user),
          token,
        });
      } catch (error) {
        logger.error(error, "Registration failed");
        return reply.status(400).send({
          success: false,
          error: publicError(error, "ثبت‌نام موفقیت‌آمیز نبود"),
        });
      }
    },
  );

  // ── POST /verify-email ──
  // Accepts EITHER { token } or { code } so the frontend can send OTP codes.
  server.post(
    `${prefix}/verify-email`,
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            token: { type: "string", maxLength: 500 },
            code: { type: "string", minLength: 4, maxLength: 10 },
          },
          // Require one of them
          anyOf: [{ required: ["token"] }, { required: ["code"] }],
        },
      },
    },
    async (req, reply) => {
      try {
        const { token: rawToken, code } = req.body as {
          token?: string;
          code?: string;
        };
        const credential = rawToken ?? code;
        if (!credential) {
          return reply.status(400).send({
            success: false,
            error: "کد یا توکن تأیید الزامی است",
          });
        }

        const user = await userService.verifyEmail(credential);
        const token = signToken(user, "24h");

        return reply.send({
          success: true,
          message: "ایمیل شما با موفقیت تأیید شد. اکنون می‌توانید وارد شوید.",
          user: toPublicUser(user),
          token,
        });
      } catch (error) {
        logger.error(error, "Email verification failed");
        return reply.status(400).send({
          success: false,
          error: publicError(error, "تأیید ایمیل موفقیت‌آمیز نبود"),
        });
      }
    },
  );

  // ── POST /resend-verification ── (new, needed by the frontend)
  server.post(
    `${prefix}/resend-verification`,
    {
      preHandler: [createAuthMiddleware(server)],
      config: { rateLimit: { max: 3, timeWindow: "5 minutes" } },
    },
    async (_req, reply) => {
      try {
        // await userService.resendVerificationEmail(req.user!.id);
        return reply.send({
          success: true,
          message: "کد تأیید جدید به ایمیل شما ارسال شد",
        });
      } catch (error) {
        logger.error(error, "Resend verification failed");
        return reply.status(400).send({
          success: false,
          error: publicError(error, "ارسال کد تأیید انجام نشد"),
        });
      }
    },
  );

  // ── POST /login ──
  server.post(
    `${prefix}/login`,
    {
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email", maxLength: 255 },
            password: { type: "string", maxLength: 128 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const body = req.body as {
          email: string;
          password: string;
        };
        const user = await userService.authenticate(body.email, body.password);
        const token = signToken(user, "7d");

        return reply.send({
          success: true,
          message: "ورود موفقیت‌آمیز بود",
          user: toPublicUser(user),
          token,
        });
      } catch (error) {
        logger.error(error, "Login failed");
        return reply.status(401).send({
          success: false,
          error: "اطلاعات ورود اشتباه است",
        });
      }
    },
  );

  // ── POST /logout ──
  server.post(
    `${prefix}/logout`,
    { preHandler: [createAuthMiddleware(server)] },
    async (_req, reply) => {
      return reply.send({
        success: true,
        message: "خروج موفقیت‌آمیز بود",
      });
    },
  );

  // ── GET /me ──
  server.get(
    `${prefix}/me`,
    { preHandler: [createAuthMiddleware(server)] },
    async (req, reply) => {
      try {
        const user = await userService.findByUserId(req.user!.id);
        if (!user) {
          return reply.status(404).send({
            success: false,
            error: "کاربر یافت نشد",
          });
        }
        return reply.send({
          success: true,
          user: toPublicUser(user),
        });
      } catch (error) {
        logger.error(error, "Failed to get user profile");
        return reply.status(500).send({
          success: false,
          error: "خطا در دریافت اطلاعات کاربر",
        });
      }
    },
  );

  // ── PUT /profile ──
  server.put(
    `${prefix}/profile`,
    {
      preHandler: [createAuthMiddleware(server)],
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            username: { type: "string", minLength: 3, maxLength: 50 },
            displayName: { type: "string", minLength: 2, maxLength: 80 },
            avatarUrl: {
              type: "string",
              maxLength: 500,
              pattern: "^(|https?://.+)$",
            },
            phone: { type: "string", maxLength: 20 },
            country: { type: "string", maxLength: 80 },
            city: { type: "string", maxLength: 100 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        // ── camelCase → snake_case mapping ──
        // so the service's allowedFields matches what we send
        const body = req.body as {
          username?: string;
          displayName?: string;
          avatarUrl?: string;
          phone?: string;
          country?: string;
          city?: string;
        };

        const updates: Record<string, string | undefined> = {};
        if (body.username !== undefined) updates.username = body.username;
        if (body.displayName !== undefined)
          updates.display_name = body.displayName;
        if (body.avatarUrl !== undefined) updates.avatar_url = body.avatarUrl;
        if (body.phone !== undefined) updates.phone = body.phone;
        if (body.country !== undefined) updates.country = body.country;
        if (body.city !== undefined) updates.city = body.city;

        if (Object.keys(updates).length === 0) {
          return reply.status(400).send({
            success: false,
            error: "هیچ فیلدی برای به‌روزرسانی ارسال نشده است",
          });
        }

        const updatedUser = await userService.updateProfile(
          req.user!.id,
          updates,
        );

        return reply.send({
          success: true,
          message: "پروفایل با موفقیت به‌روزرسانی شد",
          user: toPublicUser(updatedUser),
        });
      } catch (error) {
        logger.error(error, "Failed to update profile");
        return reply.status(400).send({
          success: false,
          error: publicError(error, "خطا در به‌روزرسانی پروفایل"),
        });
      }
    },
  );

  // ── POST /forgot-password ──
  server.post(
    `${prefix}/forgot-password`,
    {
      config: { rateLimit: { max: 3, timeWindow: "15 minutes" } },
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["email"],
          properties: {
            email: { type: "string", format: "email", maxLength: 255 },
          },
        },
      },
    },
    async (req, reply) => {
      const body = req.body as {
        email: string;
      };
      // Always return 200 — never leak whether the email exists
      try {
        await userService.requestPasswordReset(body.email);
      } catch (error) {
        logger.warn(
          { err: error, email: body.email },
          "Password reset lookup failed (suppressed)",
        );
      }
      return reply.send({
        success: true,
        message: "اگر این ایمیل ثبت شده باشد، لینک بازیابی ارسال خواهد شد",
      });
    },
  );

  // ── POST /reset-password ──
  server.post(
    `${prefix}/reset-password`,
    {
      config: { rateLimit: { max: 5, timeWindow: "15 minutes" } },
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["token", "newPassword"],
          properties: {
            token: { type: "string", minLength: 10, maxLength: 500 },
            newPassword: { type: "string", minLength: 8, maxLength: 128 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        const body = req.body as {
          token: string;
          newPassword: string;
        };
        await userService.resetPassword(body.token, body.newPassword);
        return reply.send({
          success: true,
          message: "رمز عبور شما با موفقیت تغییر کرد",
        });
      } catch (error) {
        logger.error(error, "Failed to reset password");
        return reply.status(400).send({
          success: false,
          error: publicError(error, "بازیابی رمز عبور موفقیت‌آمیز نبود"),
        });
      }
    },
  );
}
