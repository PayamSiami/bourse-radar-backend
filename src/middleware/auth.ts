import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import jwt from "jsonwebtoken";
import { UserService } from "#services/user";
import { logger } from "#utils/logger";

declare module "fastify" {
  interface FastifyRequest {
    user?: { id: number; email: string };
  }
}

const JWT_SECRET_ENV = process.env.JWT_SECRET;
if (!JWT_SECRET_ENV) {
  throw new Error("JWT_SECRET is not set — refusing to start.");
}
// Now JWT_SECRET_ENV is narrowed to `string`
const JWT_SECRET: string = JWT_SECRET_ENV;

type JwtPayload = { sub?: number | string; id?: number; email: string };

export function createAuthMiddleware(server: FastifyInstance) {
  // ✅ async, NO `done`
  return async function authMiddleware(
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    const authHeader = request.headers.authorization;

    if (!authHeader?.startsWith("Bearer ")) {
      return reply
        .status(401)
        .send({ success: false, error: "دسترسی نیازمند احراز هویت است" });
    }

    const token = authHeader.slice(7).trim();
    if (!token) {
      return reply
        .status(401)
        .send({ success: false, error: "دسترسی نیازمند احراز هویت است" });
    }

    let decoded: JwtPayload;
    try {
      decoded = jwt.verify(token, JWT_SECRET) as unknown as JwtPayload;
    } catch (err) {
      logger.error(err, "JWT verification failed");
      return reply
        .status(401)
        .send({ success: false, error: "توکن اشتباه یا منقضی شده است" });
    }

    // Resolve user id — your routes sign `{ id, email }`, not `{ sub }`
    const userId = decoded.sub ?? decoded.id;
    if (!userId) {
      return reply
        .status(401)
        .send({ success: false, error: "توکن نامعتبر است" });
    }

    // Load user + attach
    const userService = new UserService(server.db);
    const user = await userService.findByUserId(Number(userId));
    if (!user) {
      return reply
        .status(401)
        .send({ success: false, error: "کاربر یافت نشد" });
    }

    request.user = { id: user.id, email: user.email };
    // ✅ no done() — returning normally signals success
  };
}
