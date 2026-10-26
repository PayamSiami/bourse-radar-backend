import type { FastifyRequest, FastifyReply } from "fastify";
import { logger } from "#utils/logger";

declare module "fastify" {
  export interface FastifyRequest {
    user?: {
      id: number;
      email: string;
      is_admin?: boolean;
    };
  }
}

/**
 * Admin-only middleware - requires user to have admin role
 */
export async function adminMiddleware(request: FastifyRequest, reply: FastifyReply) {
  // Check if user is authenticated
  if (!request.user) {
    return reply.status(401).send({ error: "دسترسی نیازمند احراز هویت است" });
  }

  // Check if user has admin permission
  if (!request.user.is_admin) {
    logger.warn(`Admin access denied to user ${request.user.id} (${request.user.email})`);
    return reply.status(403).send({ error: "دسترسی به این بخش برای شما مجاز نیست" });
  }
}

/**
 * Admin API token middleware
 * For API access via API tokens
 */
export async function adminTokenMiddleware(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;
  
  if (!authHeader?.startsWith("Bearer ")) {
    return reply.status(401).send({ error: "API token required" });
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return reply.status(401).send({ error: "API token is missing" });
  }

  // Token validation logic would go here
  // This will be implemented in the admin services
  // For now, we'll use a placeholder
}
