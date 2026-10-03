import type { FastifyInstance } from "fastify";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUI from "@fastify/swagger-ui";
import { logger } from "#utils/logger";

/**
 * OpenAPI documentation via Fastify Swagger.
 * Uses "dynamic" mode: reads route schemas at runtime and builds the spec.
 */
export async function registerSwagger(server: FastifyInstance) {
  await server.register(fastifySwagger, {
    mode: "dynamic",
    swagger: {
      info: {
        title: "Bourse Radar API",
        description:
          "Quantitative Tehran Stock Exchange ranking engine. " +
          "NOT investment advice.",
        version: "0.1.0",
        contact: {
          name: "Bourse Radar",
          url: "https://bourse-radar.ir",
        },
      },
      host: "localhost:8001",
      schemes: ["http"],
    },
  });

  await server.register(fastifySwaggerUI, {
    routePrefix: "/docs",
    staticCSP: false,
    uiConfig: {
      docExpansion: "list",
      deepLinking: true,
    },
    // Add the API-key security scheme to the generated spec.
    transformSpecification: (swaggerObject) => {
      const result = { ...swaggerObject } as Record<string, any>;
      const components = (result.components ?? {}) as Record<string, any>;
      result.components = {
        ...components,
        securitySchemes: {
          ...(components.securitySchemes ?? {}),
          apiKey: { type: "apiKey", name: "X-API-Key", in: "header" },
        },
      };
      return result;
    },
  });

  logger.info("✓ Swagger UI at http://localhost:8001/docs");
}
