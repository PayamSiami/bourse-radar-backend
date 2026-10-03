import type { FastifyInstance } from "fastify";

/**
 * Shared Redis cache helper for read-heavy GET routes.
 *
 * Each route in this codebase re-implements the same envelope
 * ({ data, _cachedAt }) + TTL dance with slightly different bugs
 * (mixed seconds/ms, missing try/catch, different key shapes).
 * Use this instead — one contract everywhere:
 *
 *   const { data, hit } = await getOrSet(server, "sectors:list", 300, () => compute());
 *   reply.header("x-cache", hit ? "HIT" : "MISS");
 *   return reply.send(data);
 *
 * Design notes:
 *  - Fail-open: Redis down/corrupt => recompute and return fresh data.
 *    Never 500 on a cache failure. The write-through is best-effort.
 *  - TTL envelope stored inside the payload so a stale `setex` that
 *    outlives a code change can't serve ancient data silently.
 *    (Readers ignore entries older than `ttlSeconds`, belt and braces.)
 *  - Keys are namespaced `v1:` so a future schema change can bump the
 *    prefix instead of flushing the whole DB.
 */

const KEY_PREFIX = "v1:";

interface Envelope<T> {
  data: T;
  _cachedAt: number;
}

export async function getOrSet<T>(
  server: FastifyInstance,
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>,
): Promise<{ data: T; hit: boolean }> {
  const fullKey = `${KEY_PREFIX}${key}`;

  try {
    const raw = await server.redis.get(fullKey);
    if (raw) {
      try {
        const envelope = JSON.parse(raw) as Envelope<T>;
        if (Date.now() - envelope._cachedAt < ttlSeconds * 1000) {
          return { data: envelope.data, hit: true };
        }
      } catch {
        // Corrupt entry — fall through and recompute.
        server.log.warn({ key: fullKey }, "cache entry corrupt, recomputing");
      }
    }
  } catch (e) {
    // Redis unreachable — still serve fresh data, just don't cache it.
    server.log.warn({ err: e, key: fullKey }, "cache read failed");
  }

  const data = await compute();

  try {
    const envelope: Envelope<T> = { data, _cachedAt: Date.now() };
    await server.redis.setex(fullKey, ttlSeconds, JSON.stringify(envelope));
  } catch (e) {
    server.log.warn({ err: e, key: fullKey }, "cache write failed");
  }

  return { data, hit: false };
}
