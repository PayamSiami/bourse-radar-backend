import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";

// ─── نوع سازگار با postgres.js برای JSONB ────────────────
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/** TTL برای کش کامل پاسخ endpoint (پیش‌فرض ۳۰ دقیقه) */
export const SUGGESTIONS_CACHE_TTL_SEC = 1800;

/** TTL برای روایت هر سهم (پیش‌فرض ۶ ساعت) */
export const NARRATIVE_CACHE_TTL_SEC = 6 * 3600;

/** حداکثر سنی که کش Redis به‌عنوان fresh پذیرفته می‌شود */
export const CACHE_STALE_MS = SUGGESTIONS_CACHE_TTL_SEC * 1000;

// ────────────────────────────────────────────────────────────
// کلید پایدار برای پارامترهای endpoint
// ────────────────────────────────────────────────────────────
export function buildCacheKey(params: Record<string, unknown>): string {
  const normalized = {
    top_n: params.top_n ?? 20,
    min_confidence: params.min_confidence ?? "medium",
    sector: params.sector ?? null,
  };
  return `suggestions:${JSON.stringify(normalized)}`;
}

// ────────────────────────────────────────────────────────────
// هش متریک‌های مؤثر برای کش روایت هر سهم
// ────────────────────────────────────────────────────────────
export function hashMetrics(row: Record<string, unknown>): string {
  const relevant = {
    forward_pe: row.forward_pe,
    estimated_annual_eps: row.estimated_annual_eps,
    confidence: row.confidence,
    confidence_score: row.confidence_score,
    attractiveness_score: row.attractiveness_score,
    overallRank: row.overallRank,
    sector: row.sector,
  };
  return createHash("sha256").update(JSON.stringify(relevant)).digest("hex");
}

// ────────────────────────────────────────────────────────────
// خواندن کش (Redis → Postgres → null)
// ────────────────────────────────────────────────────────────
export async function readCache<T = unknown>(
  server: FastifyInstance,
  key: string,
): Promise<T | null> {
  // 1) Redis
  try {
    const raw = await server.redis.get(key);
    if (raw) {
      const parsed = JSON.parse(raw) as { data: T; _cachedAt?: number };
      return parsed.data;
    }
  } catch (e) {
    server.log.warn({ err: e }, "cache redis read failed");
  }

  // 2) Postgres
  try {
    const [row] = await server.db<{ payload: T }[]>`
      SELECT payload
      FROM suggestion_cache
      WHERE cache_key = ${key}
        AND expires_at > now()
    `;
    if (row) {
      try {
        await server.redis.setex(
          key,
          SUGGESTIONS_CACHE_TTL_SEC,
          JSON.stringify({ data: row.payload, _cachedAt: Date.now() }),
        );
      } catch {
        /* ignore */
      }
      return row.payload;
    }
  } catch (e) {
    server.log.warn({ err: e }, "cache postgres read failed");
  }

  return null;
}

// ────────────────────────────────────────────────────────────
// نوشتن کش
// ────────────────────────────────────────────────────────────
export async function writeCache(
  server: FastifyInstance,
  key: string,
  payload: unknown,
  model: string | null,
  ttlSec = SUGGESTIONS_CACHE_TTL_SEC,
): Promise<void> {
  const jsonPayload = toJsonValue(payload);

  // Postgres اول
  try {
    await server.db`
      INSERT INTO suggestion_cache (cache_key, payload, model, expires_at)
      VALUES (
        ${key},
        ${server.db.json(jsonPayload)},
        ${model},
        now() + (${ttlSec} || ' seconds')::interval
      )
      ON CONFLICT (cache_key) DO UPDATE
        SET payload      = EXCLUDED.payload,
            model        = EXCLUDED.model,
            generated_at = now(),
            expires_at   = EXCLUDED.expires_at
    `;
  } catch (e) {
    server.log.warn({ err: e }, "cache postgres write failed");
  }

  // Redis (best-effort)
  try {
    await server.redis.setex(
      key,
      ttlSec,
      JSON.stringify({ data: payload, _cachedAt: Date.now() }),
    );
  } catch (e) {
    server.log.warn({ err: e }, "cache redis write failed");
  }
}

// ────────────────────────────────────────────────────────────
// کش روایت هر سهم
// ────────────────────────────────────────────────────────────
export async function readNarrative(
  server: FastifyInstance,
  symbol: string,
  metricHash: string,
): Promise<unknown | null> {
  const redisKey = `narrative:${symbol}:${metricHash}`;
  try {
    const raw = await server.redis.get(redisKey);
    if (raw) return JSON.parse(raw);
  } catch (e) {
    server.log.warn({ err: e }, "narrative redis read failed");
  }

  try {
    const [row] = await server.db<{ narrative: unknown }[]>`
      SELECT narrative
      FROM narrative_cache
      WHERE symbol = ${symbol}
        AND metric_hash = ${metricHash}
        AND expires_at > now()
    `;
    if (row) {
      try {
        await server.redis.setex(
          redisKey,
          NARRATIVE_CACHE_TTL_SEC,
          JSON.stringify(row.narrative),
        );
      } catch {
        /* ignore */
      }
      return row.narrative;
    }
  } catch (e) {
    server.log.warn({ err: e }, "narrative postgres read failed");
  }
  return null;
}

export async function writeNarrative(
  server: FastifyInstance,
  symbol: string,
  metricHash: string,
  narrative: unknown,
  model: string | null,
): Promise<void> {
  const jsonNarrative = toJsonValue(narrative);

  try {
    await server.db`
      INSERT INTO narrative_cache (symbol, metric_hash, narrative, model, expires_at)
      VALUES (
        ${symbol},
        ${metricHash},
        ${server.db.json(jsonNarrative)},
        ${model},
        now() + (${NARRATIVE_CACHE_TTL_SEC} || ' seconds')::interval
      )
      ON CONFLICT (symbol, metric_hash) DO UPDATE
        SET narrative    = EXCLUDED.narrative,
            model        = EXCLUDED.model,
            generated_at = now(),
            expires_at   = EXCLUDED.expires_at
    `;
  } catch (e) {
    server.log.warn({ err: e }, "narrative postgres write failed");
  }

  try {
    await server.redis.setex(
      `narrative:${symbol}:${metricHash}`,
      NARRATIVE_CACHE_TTL_SEC,
      JSON.stringify(narrative),
    );
  } catch {
    /* ignore */
  }
}

// ────────────────────────────────────────────────────────────
// پاکسازی ردیف‌های منقضی (برای cron)
// ────────────────────────────────────────────────────────────
export async function purgeExpired(server: FastifyInstance): Promise<void> {
  try {
    await server.db`DELETE FROM suggestion_cache WHERE expires_at <= now()`;
    await server.db`DELETE FROM narrative_cache  WHERE expires_at <= now()`;
  } catch (e) {
    server.log.warn({ err: e }, "cache purge failed");
  }
}

// ────────────────────────────────────────────────────────────
// خواندن کش کهنه (بدون چک expires_at)
// ────────────────────────────────────────────────────────────
export async function readStaleCache<T = unknown>(
  server: FastifyInstance,
  key: string,
): Promise<{ data: T; ageMs: number } | null> {
  try {
    const [row] = await server.db<
      {
        payload: T;
        generated_at: Date;
      }[]
    >`
      SELECT payload, generated_at
      FROM suggestion_cache
      WHERE cache_key = ${key}
    `;
    if (!row) return null;
    const ageMs = Date.now() - new Date(row.generated_at).getTime();
    return { data: row.payload, ageMs };
  } catch (e) {
    server.log.warn({ err: e }, "stale cache read failed");
    return null;
  }
}

// ────────────────────────────────────────────────────────────
// Single-flight
// ────────────────────────────────────────────────────────────
const inflight = new Map<string, Promise<unknown>>();

export async function withSingleFlight<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const promise = fn().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

// ────────────────────────────────────────────────────────────
// 🔧 توابع جدید برای پاک کردن کش (مهم برای مشکل فعلی)
// ────────────────────────────────────────────────────────────

/** پاک کردن یک کلید خاص از Redis + Postgres */
export async function invalidateCache(
  server: FastifyInstance,
  key: string,
): Promise<void> {
  try {
    await server.redis.del(key);
  } catch (e) {
    server.log.warn({ err: e, key }, "redis invalidate failed");
  }

  try {
    await server.db`DELETE FROM suggestion_cache WHERE cache_key = ${key}`;
  } catch (e) {
    server.log.warn({ err: e, key }, "postgres invalidate failed");
  }
}

/** پاک کردن تمام کش‌های suggestions (برای مواقع اضطراری) */
export async function invalidateAllSuggestions(
  server: FastifyInstance,
): Promise<void> {
  try {
    // Redis
    const keys = await server.redis.keys("suggestions:*");
    if (keys.length > 0) {
      await server.redis.del(...keys);
    }
  } catch (e) {
    server.log.warn({ err: e }, "redis invalidateAll failed");
  }

  try {
    await server.db`DELETE FROM suggestion_cache`;
  } catch (e) {
    server.log.warn({ err: e }, "postgres invalidateAll failed");
  }

  server.log.info("All suggestions cache invalidated");
}
