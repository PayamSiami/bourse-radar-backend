import {
  ingestArchiveForSymbol,
  ingestArchiveForSymbols,
  runFullIngest,
  isCodalCoolingDown,
  codalThrottleStatus,
  WATCHLIST,
} from "#services/ingest";
import type { ArchiveResult } from "#services/ingest";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * Single-flight guard.
 *
 * Two overlapping `/api/admin/ingest` calls double the request rate against
 * Codal from one IP, which is the fastest way to earn a ban. The second
 * caller is rejected immediately rather than queued — the operator can
 * simply retry once the first run reports back.
 */
let ingestInFlight: { mode: string; startedAt: number } | null = null;

function tryAcquireIngest(mode: string): boolean {
  if (ingestInFlight) return false;
  ingestInFlight = { mode, startedAt: Date.now() };
  return true;
}

function releaseIngest(): void {
  ingestInFlight = null;
}

/**
 * Merged ingest route. One endpoint, driven by query params:
 *
 *   GET /api/admin/ingest                        → full pipeline
 *   GET /api/admin/ingest?symbol=فسبزوار         → Codal archive, single symbol
 *   GET /api/admin/ingest?symbols=all            → Codal archive, watchlist
 *   GET /api/admin/ingest?symbols=فولاد,فخوز    → Codal archive, selected
 *
 * Legacy GET /api/admin/archive/:symbol and /archive-all delegate to the
 * same helpers.
 */
export function registerIngestRoutes(server: FastifyInstance): void {
  const DEFAULT_FROM = "1402/01/01";
  const DEFAULT_TO = "1405/12/29";

  // Jalali date shape: YYYY/MM/DD or YYYY-MM-DD (4-digit year, 1-2 digit mo/day).
  const JALALI_RE = /^\d{4}[/-]\d{1,2}[/-]\d{1,2}$/;

  // ── Localhost guard, applied once via hook ────────────────────

  const LOCALHOST_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

  const requireLocalhost = (
    req: FastifyRequest,
    reply: FastifyReply,
    done: (err?: Error) => void,
  ) => {
    if (!LOCALHOST_IPS.has(req.ip)) {
      reply.code(403).send({ error: "Forbidden (localhost only)" });
      return;
    }
    done();
  };

  // ── Shared helpers ────────────────────────────────────────────

  const fullPipeline = async () => ({
    ok: true as const,
    ...(await runFullIngest(server.db)),
  });

  /** Roll up per-symbol archive results into the wire response shape. */
  const summarise = (results: ArchiveResult[]) => {
    const totals = results.reduce(
      (acc, r) => ({
        lettersFound: acc.lettersFound + r.lettersFound,
        reportsParsed: acc.reportsParsed + r.reportsParsed,
        rowsUpserted: acc.rowsUpserted + r.rowsUpserted,
        errors: acc.errors + r.errors.length,
      }),
      { lettersFound: 0, reportsParsed: 0, rowsUpserted: 0, errors: 0 },
    );
    return { ok: true as const, totals, symbols: results.length, results };
  };

  /** Single entry point used by every archive-shaped route. */
  const runArchive = async (symbols: string[], from: string, to: string) => {
    if (symbols.length === 1) {
      const symbol = symbols[0]!;
      const result = await ingestArchiveForSymbol(server.db, symbol, from, to);
      return { ok: true as const, symbol, ...result };
    }
    const results = await ingestArchiveForSymbols(server.db, symbols, from, to);
    return summarise(results);
  };

  /** Safe percent-decoding — returns the input unchanged if malformed. */
  const safeDecode = (s: string): string => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };

  const parseArchiveTargets = (
    query: Record<string, unknown>,
  ): string[] | null => {
    const single = typeof query.symbol === "string" ? query.symbol.trim() : "";
    if (single) return [safeDecode(single)];

    const raw = typeof query.symbols === "string" ? query.symbols.trim() : "";
    if (!raw) return null;
    if (raw.toLowerCase() === "all") return WATCHLIST.map((w) => w.sym);

    const parts = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map(safeDecode);

    return parts.length ? parts : null;
  };

  const boundsFrom = (q: Record<string, unknown>) => {
    const pick = (key: "from" | "to", fallback: string): string => {
      const v = q[key];
      return typeof v === "string" && JALALI_RE.test(v.trim())
        ? v.trim()
        : fallback;
    };
    return { from: pick("from", DEFAULT_FROM), to: pick("to", DEFAULT_TO) };
  };

  const fail = (reply: FastifyReply, e: unknown) => {
    server.log.error(e);
    return reply.code(500).send({
      ok: false as const,
      error: e instanceof Error ? e.message : String(e),
      throttle: codalThrottleStatus(),
      coolingDown: isCodalCoolingDown(),
    });
  };

  const busy = (reply: FastifyReply) => {
    const f = ingestInFlight!;
    const since = Math.round((Date.now() - f.startedAt) / 1000);
    return reply.code(409).send({
      ok: false as const,
      error: `ingest busy: ${f.mode} since ${since}s ago — wait for it to finish`,
      retryAfterSec: 120,
      ingestMode: f.mode,
      throttle: codalThrottleStatus(),
      coolingDown: isCodalCoolingDown(),
    });
  };

  // ── Swagger building blocks ───────────────────────────────────

  const ingestQuerystringSchema = {
    type: "object",
    properties: {
      symbol: {
        type: "string",
        description:
          "Single TSE symbol. Triggers archive mode for one symbol. " +
          "URL-encoded (e.g. `%D9%81%D8%B3%D8%A8%D8%B2%D9%88%D8%A7%D8%B1` for فسبزوار).",
        examples: ["فسبزوار"],
      },
      symbols: {
        type: "string",
        description:
          "Comma-separated symbols, or the literal `all` for the full watchlist. " +
          "Ignored if `symbol` is present.",
        examples: ["all", "فولاد,فخوز"],
      },
      from: {
        type: "string",
        pattern: "^\\d{4}[/-]\\d{1,2}[/-]\\d{1,2}$",
        default: DEFAULT_FROM,
        description: "Jalali lower bound (archive mode only).",
      },
      to: {
        type: "string",
        pattern: "^\\d{4}[/-]\\d{1,2}[/-]\\d{1,2}$",
        default: DEFAULT_TO,
        description: "Jalali upper bound (archive mode only).",
      },
    },
    additionalProperties: false,
  } as const;

  const boundsQuerystringSchema = {
    type: "object",
    properties: {
      from: {
        type: "string",
        pattern: "^\\d{4}[/-]\\d{1,2}[/-]\\d{1,2}$",
        default: DEFAULT_FROM,
      },
      to: {
        type: "string",
        pattern: "^\\d{4}[/-]\\d{1,2}[/-]\\d{1,2}$",
        default: DEFAULT_TO,
      },
    },
    additionalProperties: false,
  } as const;

  const archiveResultSchema = {
    type: "object",
    properties: {
      symbol: { type: "string" },
      lettersFound: { type: "integer" },
      reportsParsed: { type: "integer" },
      rowsUpserted: { type: "integer" },
      errors: { type: "array", items: { type: "string" } },
    },
  } as const;

  const archiveTotalsSchema = {
    type: "object",
    properties: {
      lettersFound: { type: "integer" },
      reportsParsed: { type: "integer" },
      rowsUpserted: { type: "integer" },
      errors: { type: "integer" },
    },
  } as const;

  const ingestResponseSchema = {
    type: "object",
    description:
      "Shape depends on mode: full pipeline (no symbol/symbols), single-symbol archive, " +
      "or multi-symbol archive rollup.",
    properties: {
      ok: { type: "boolean" },
      // full-pipeline fields
      fx: { type: "integer" },
      stocks: { type: "integer" },
      prices: { type: "integer" },
      mcap: { type: "integer" },
      sales: { type: "integer" },
      quarterly: { type: "integer" },
      pe: { type: "integer" },
      // single-symbol archive fields
      symbol: { type: "string" },
      lettersFound: { type: "integer" },
      reportsParsed: { type: "integer" },
      rowsUpserted: { type: "integer" },
      errors: {
        oneOf: [
          { type: "array", items: { type: "string" } },
          { type: "integer" },
        ],
      },
      // multi-symbol rollup fields
      totals: archiveTotalsSchema,
      symbols: { type: "integer" },
      results: { type: "array", items: archiveResultSchema },
    },
  } as const;

  const errorSchema = {
    type: "object",
    properties: {
      ok: { type: "boolean" },
      error: { type: "string" },
      retryAfterSec: { type: "integer" },
      ingestMode: { type: "string" },
      throttle: { type: "string" },
      coolingDown: { type: "boolean" },
    },
  } as const;

  // Apply the localhost guard to every route registered in this scope.
  // (Fastify hooks are scoped to the enclosing plugin, so this is safe as
  // long as registerIngestRoutes is called inside its own plugin wrapper.)
  server.addHook("onRequest", requireLocalhost);

  // ── Primary (merged) route ────────────────────────────────────

  server.get(
    "/api/admin/ingest",
    {
      schema: {
        tags: ["admin"],
        summary: "Run ingestion (full pipeline or Codal archive)",
        description:
          "**Localhost only.** Behaviour is driven by query params:\n\n" +
          "- No `symbol`/`symbols` → **full pipeline** (FX → prices → market cap → monthly sales → quarterly → P/E → rankings).\n" +
          "- `?symbol=X` → Codal archive for one symbol.\n" +
          "- `?symbols=all` → Codal archive for every watchlist symbol.\n" +
          "- `?symbols=a,b,c` → Codal archive for the listed symbols.\n\n" +
          "`from`/`to` (Jalali) apply to archive modes only.",
        querystring: ingestQuerystringSchema,
        response: {
          200: ingestResponseSchema,
          403: errorSchema,
          409: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const query = req.query as Record<string, unknown>;
      const targets = parseArchiveTargets(query);
      const mode = !targets
        ? "full pipeline"
        : targets.length === 1
          ? `archive ${targets[0]}`
          : `archive ${targets.length} symbols`;

      if (!tryAcquireIngest(mode)) return busy(reply);

      try {
        const out = targets
          ? await runArchive(targets, boundsFrom(query).from, boundsFrom(query).to)
          : await fullPipeline();
        return reply.send({ ...out, throttle: codalThrottleStatus() });
      } catch (e) {
        return fail(reply, e);
      } finally {
        releaseIngest();
      }
    },
  );

  // ── Legacy passthroughs ───────────────────────────────────────

  server.get(
    "/api/admin/archive/:symbol",
    {
      schema: {
        tags: ["admin"],
        summary: "Run Codal archive for one symbol",
        description:
          "Legacy alias for `GET /api/admin/ingest?symbol=…`. " +
          "Behaviour is identical; prefer the `/ingest` endpoint for new callers.",
        params: {
          type: "object",
          required: ["symbol"],
          properties: {
            symbol: {
              type: "string",
              description: "TSE symbol, URL-encoded.",
              examples: ["فسبزوار"],
            },
          },
        },
        querystring: boundsQuerystringSchema,
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              symbol: { type: "string" },
              lettersFound: { type: "integer" },
              reportsParsed: { type: "integer" },
              rowsUpserted: { type: "integer" },
              errors: { type: "array", items: { type: "string" } },
            },
          },
          403: errorSchema,
          409: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const { symbol } = req.params as { symbol: string };
      const { from, to } = boundsFrom(req.query as Record<string, unknown>);
      const sym = safeDecode(symbol);

      if (!tryAcquireIngest(`archive ${sym}`)) return busy(reply);
      try {
        const out = await runArchive([sym], from, to);
        return reply.send({ ...out, throttle: codalThrottleStatus() });
      } catch (e) {
        return fail(reply, e);
      } finally {
        releaseIngest();
      }
    },
  );

  server.get(
    "/api/admin/archive-all",
    {
      schema: {
        tags: ["admin"],
        summary: "Run Codal archive for the whole watchlist",
        description:
          "Legacy alias for `GET /api/admin/ingest?symbols=all`. " +
          "Behaviour is identical; prefer the `/ingest` endpoint for new callers.",
        querystring: boundsQuerystringSchema,
        response: {
          200: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              totals: archiveTotalsSchema,
              symbols: { type: "integer" },
              results: { type: "array", items: archiveResultSchema },
            },
          },
          403: errorSchema,
          409: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const { from, to } = boundsFrom(req.query as Record<string, unknown>);

      if (!tryAcquireIngest("archive-all (watchlist)")) return busy(reply);
      try {
        const symbols = WATCHLIST.map((w) => w.sym);
        const out = await runArchive(symbols, from, to);
        return reply.send({ ...out, throttle: codalThrottleStatus() });
      } catch (e) {
        return fail(reply, e);
      } finally {
        releaseIngest();
      }
    },
  );
}
