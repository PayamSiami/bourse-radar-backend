/*
 * Central configuration — all values read from env with explicit defaults.
 * Zod schema validates at startup so misconfigured deployments fail fast.
 */

import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8001),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  // OpenAI / LLM
  OPENAI_API_KEY: z.string().min(1),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  LLM_MODEL: z.string().default("gpt-4o-2024-08-06"),
  LLM_MAX_TOKENS: z.coerce.number().int().min(64).max(4096).default(2048),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(1).default(0.3),

  // External data sources
  TSETMC_BASE_URL: z.string().url().default("https://cdn.tsetmc.com"),
  CODAL_BASE_URL: z.string().url().default("https://www.codal.ir"),
  USER_AGENT: z.string().default("BourseRadar/0.1 (+https://bourse-radar.ir)"),

  // CORS — comma-separated list of allowed origins in production.
  // Default keeps the current bourse-radar.ir + www. Add more via .env.
  CORS_ORIGINS: z.string().default("https://bourse-radar.ir,https://www.bourse-radar.ir"),

  // Rate limits
  RATE_LIMIT_GLOBAL: z.coerce.number().int().default(100),
  RATE_LIMIT_GLOBAL_WINDOW: z.coerce.number().int().default(60_000),
  RATE_LIMIT_AUTHENTICATED: z.coerce.number().int().default(300),
  RATE_LIMIT_AUTHENTICATED_WINDOW: z.coerce.number().int().default(60_000),

  // Data freshness
  PRICE_MAX_AGE_SECONDS: z.coerce.number().int().default(300),
  MONTHLY_SALES_MAX_AGE_DAYS: z.coerce.number().int().default(45),
  QUARTERLY_MAX_AGE_DAYS: z.coerce.number().int().default(120),
  FORWARD_PE_CACHE_TTL_SECONDS: z.coerce.number().int().default(900),
});

const _env = schema.parse(process.env);

export const config = {
  app: {
    nodeEnv: _env.NODE_ENV,
    port: _env.PORT,
    logLevel: _env.LOG_LEVEL,
  },
  db: {
    url: _env.DATABASE_URL,
  },
  redis: {
    url: _env.REDIS_URL,
  },
  llm: {
    apiKey: _env.OPENAI_API_KEY,
    baseURL: _env.OPENAI_BASE_URL,
    model: _env.LLM_MODEL,
    maxTokens: _env.LLM_MAX_TOKENS,
    temperature: _env.LLM_TEMPERATURE,
  },
  sources: {
    tsetmc: _env.TSETMC_BASE_URL,
    codal: _env.CODAL_BASE_URL,
    userAgent: _env.USER_AGENT,
  },
  cors: {
    origins: _env.CORS_ORIGINS,
  },
  rateLimit: {
    global: _env.RATE_LIMIT_GLOBAL,
    globalWindow: _env.RATE_LIMIT_GLOBAL_WINDOW,
    authenticated: _env.RATE_LIMIT_AUTHENTICATED,
    authenticatedWindow: _env.RATE_LIMIT_AUTHENTICATED_WINDOW,
  },
  freshness: {
    priceMaxAgeSeconds: _env.PRICE_MAX_AGE_SECONDS,
    monthlySalesMaxAgeDays: _env.MONTHLY_SALES_MAX_AGE_DAYS,
    quarterlyMaxAgeDays: _env.QUARTERLY_MAX_AGE_DAYS,
    forwardPECacheTTL: _env.FORWARD_PE_CACHE_TTL_SECONDS,
  },
} as const;

export type Config = typeof config;
