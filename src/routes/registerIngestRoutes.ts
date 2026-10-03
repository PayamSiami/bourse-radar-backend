import {
  ingestArchiveForSymbol,
  ingestArchiveForSymbols,
  runFullIngest,
  isCodalCoolingDown,
  codalThrottleStatus,
  WATCHLIST,
} from "#services/ingest";
import type { ArchiveResult } from "#services/ingest";
import type { FastifyInstance, FastifyReply } from "fastify";

/**
 * Single-flight guard + async execution.
 *
 * `/api/admin/ingest` without params runs `runFullIngest()` which
 * scrapes TSETMC + all watchlist symbols from Codal via Playwright.
 * That takes 3-15 minutes. Holding the HTTP socket that long makes
 * every reverse proxy (Traefik / nginx / Cloudflare) time out and
 * the client sees "socket hang up" — it is NOT a crash.
 *
 * Fix: full-pipeline and watchlist-wide archive runs are now async
 * by default: we reply 202 immediately and run in the background.
 * Single-symbol archive stays sync (fast) unless ?async=1 is passed.
 * Progress can be polled via GET /api/admin/ingest/status.
 */
let ingestInFlight: { mode: string; startedAt: number; promise: Promise<unknown> } | null = null;
let lastResult: unknown | null = null;
let lastError: string | null = null;
let lastCompletedAt: number | null = null;

function tryAcquireIngest(mode: string, promise: Promise<unknown>): boolean {
  if (ingestInFlight) return false;
  ingestInFlight = { mode, startedAt: Date.now(), promise };
  // Attach handlers that record result and release — but don't create
  // an unhandled rejection if caller already attached via status poll.
  promise
    .then((r) => {
      lastResult = r;
      lastError = null;
    })
    .catch((e) => {
      lastResult = null;
      lastError = e instanceof Error ? e.message : String(e);
    })
    .finally(() => {
      lastCompletedAt = Date.now();
      ingestInFlight = null;
    });
  // Prevent "unhandledRejection" — we already caught above
  promise.catch(() => {});
  return true;
}

function busy(reply: FastifyReply) {
  const f = ingestInFlight!;
  const since = Math.round((Date.now() - f.startedAt) / 1000);
  return reply.code(409).send({
    ok: false as const,
    error: `ingest busy: ${f.mode} since ${since}s ago — wait for it to finish or poll /api/admin/ingest/status`,
    retryAfterSec: 120,
    ingestMode: f.mode,
    throttle: codalThrottleStatus(),
    coolingDown: isCodalCoolingDown(),
  });
}

/**
 * Merged ingest route. One endpoint, driven by query params:
 *
 *   GET /api/admin/ingest                        → full pipeline (async 202)
 *   GET /api/admin/ingest?symbol=فسبزوار         → Codal archive, single symbol (sync)
 *   GET /api/admin/ingest?symbols=all            → Codal archive, watchlist (async 202)
 *   GET /api/admin/ingest?symbols=فولاد,فخوز    → Codal archive, selected (async if >3)
 *   GET /api/admin/ingest?async=0                → force sync (will hang — not recommended on VPS)
 *   GET /api/admin/ingest/status                 → poll current / last run
 *
 * Legacy GET /api/admin/archive/:symbol and /archive-all delegate to the
 * same helpers.
 */
export function registerIngestRoutes(server: FastifyInstance): void {
  const DEFAULT_FROM = "1402/01/01";
  const DEFAULT_TO = "1405/12/29";

  const JALALI_RE = /^\d{4}[/-]\d{1,2}[/-]\d{1,2}$/;

  const fullPipeline = async () => ({
    ok: true as const,
    ...(await runFullIngest(server.db)),
  });

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

  const runArchive = async (symbols: string[], from: string, to: string) => {
    if (symbols.length === 1) {
      const symbol = symbols[0]!;
      const result = await ingestArchiveForSymbol(server.db, symbol, from, to);
      return { ok: true as const, symbol, ...result };
    }
    const results = await ingestArchiveForSymbols(server.db, symbols, from, to);
    return summarise(results);
  };

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
      async: {
        type: "string",
        enum: ["0", "1", "true", "false"],
        description:
          "Force async (202) or sync. Default: async for full pipeline / watchlist, sync for single symbol.",
      },
      sync: {
        type: "string",
        enum: ["0", "1", "true", "false"],
        description: "Alias for async inverted. sync=1 means wait for completion.",
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
      "or multi-symbol archive rollup. Async runs return 202 with status=started.",
    properties: {
      ok: { type: "boolean" },
      status: { type: "string", enum: ["started", "completed"] },
      fx: { type: "integer" },
      stocks: { type: "integer" },
      prices: { type: "integer" },
      mcap: { type: "integer" },
      sales: { type: "integer" },
      quarterly: { type: "integer" },
      pe: { type: "integer" },
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
      totals: archiveTotalsSchema,
      symbols: { type: "integer" },
      results: { type: "array", items: archiveResultSchema },
      throttle: { type: "string" },
      ingestMode: { type: "string" },
      poll: { type: "string" },
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

  function shouldRunAsync(
    query: Record<string, unknown>,
    targets: string[] | null,
  ): boolean {
    const qAsync = query.async as string | undefined;
    const qSync = query.sync as string | undefined;
    if (qSync !== undefined) {
      if (qSync === "1" || qSync === "true") return false;
      if (qSync === "0" || qSync === "false") return true;
    }
    if (qAsync !== undefined) {
      if (qAsync === "1" || qAsync === "true") return true;
      if (qAsync === "0" || qAsync === "false") return false;
    }
    // Defaults: full pipeline is always async (minutes long).
    if (!targets) return true;
    // watchlist or >3 symbols => async
    if (targets.length > 3) return true;
    if (
      typeof query.symbols === "string" &&
      (query.symbols as string).toLowerCase() === "all"
    )
      return true;
    // single small symbol => sync for convenience
    return false;
  }

  // ── Status poll — register BEFORE /ingest so it is not shadowed ───

  server.get(
    "/api/admin/ingest/status",
    {
      schema: {
        tags: ["admin"],
        summary: "Poll current or last ingest run",
        response: {
          200: {
            type: "object",
            properties: {
              running: { type: "boolean" },
              mode: { type: ["string", "null"] },
              startedAt: { type: ["string", "null"] },
              elapsedSec: { type: ["integer", "null"] },
              lastCompletedAt: { type: ["string", "null"] },
              lastResult: { type: ["object", "null"] },
              lastError: { type: ["string", "null"] },
              throttle: { type: "string" },
              coolingDown: { type: "boolean" },
            },
          },
        },
      },
    },
    async () => {
      if (ingestInFlight) {
        return {
          running: true as const,
          mode: ingestInFlight.mode,
          startedAt: new Date(ingestInFlight.startedAt).toISOString(),
          elapsedSec: Math.round((Date.now() - ingestInFlight.startedAt) / 1000),
          lastCompletedAt: lastCompletedAt ? new Date(lastCompletedAt).toISOString() : null,
          lastResult,
          lastError,
          throttle: codalThrottleStatus(),
          coolingDown: isCodalCoolingDown(),
        };
      }
      return {
        running: false as const,
        mode: null,
        startedAt: null,
        elapsedSec: null,
        lastCompletedAt: lastCompletedAt ? new Date(lastCompletedAt).toISOString() : null,
        lastResult,
        lastError,
        throttle: codalThrottleStatus(),
        coolingDown: isCodalCoolingDown(),
      };
    },
  );

  // ── Primary (merged) route ────────────────────────────────────

  server.get(
    "/api/admin/ingest",
    {
      schema: {
        tags: ["admin"],
        summary: "Run ingestion (full pipeline or Codal archive)",
        description:
          "**Localhost only.** Behaviour is driven by query params:\n\n" +
          "- No `symbol`/`symbols` → **full pipeline** (FX → prices → market cap → monthly sales → quarterly → P/E → rankings). Runs **async (202)** — poll `/api/admin/ingest/status`.\n" +
          "- `?symbol=X` → Codal archive for one symbol (sync).\n" +
          "- `?symbols=all` → Codal archive for every watchlist symbol (async).\n" +
          "- `?symbols=a,b,c` → Codal archive for the listed symbols.\n\n" +
          "`from`/`to` (Jalali) apply to archive modes only. Pass `?sync=1` to force waiting (not recommended on VPS — causes socket hang up).",
        querystring: ingestQuerystringSchema,
        response: {
          200: ingestResponseSchema,
          202: ingestResponseSchema,
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

      const wantsAsync = shouldRunAsync(query, targets);

      if (wantsAsync) {
        // Start in background, reply immediately — this is what fixes
        // socket hang up on VPS (Traefik/nginx close idle sockets after 60s).
        const promise = targets
          ? runArchive(targets, boundsFrom(query).from, boundsFrom(query).to)
          : fullPipeline();

        if (!tryAcquireIngest(mode, promise as Promise<unknown>)) return busy(reply);

        // Log completion
        (promise as Promise<unknown>)
          .then((r) => server.log.info({ mode, result: r }, "[ingest] async completed"))
          .catch((e) => server.log.error(e, `[ingest] async failed: ${mode}`));

        return reply.code(202).send({
          ok: true as const,
          status: "started" as const,
          ingestMode: mode,
          poll: "/api/admin/ingest/status",
          throttle: codalThrottleStatus(),
          coolingDown: isCodalCoolingDown(),
        });
      }

      // Sync path — only for single-symbol quick runs
      if (ingestInFlight) return busy(reply);
      // Create a tracked promise even for sync so status poll works
      let syncPromise!: Promise<unknown>;
      let syncResolve!: (v: unknown) => void;
      let syncReject!: (e: unknown) => void;
      syncPromise = new Promise<unknown>((res, rej) => {
        syncResolve = res;
        syncReject = rej;
      });
      if (!tryAcquireIngest(mode, syncPromise)) return busy(reply);

      try {
        const out = targets
          ? await runArchive(targets, boundsFrom(query).from, boundsFrom(query).to)
          : await fullPipeline();
        syncResolve(out);
        return reply.send({ ...out, throttle: codalThrottleStatus() });
      } catch (e) {
        syncReject(e);
        return fail(reply, e);
      }
    },
  );

  // ── Legacy passthroughs — also made async-aware ──────────────

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
          202: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              status: { type: "string" },
              ingestMode: { type: "string" },
              poll: { type: "string" },
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

      // Single symbol legacy stays sync (fast), but still tracks status
      if (ingestInFlight) return busy(reply);
      let p!: Promise<unknown>;
      let res!: (v: unknown) => void;
      let rej!: (e: unknown) => void;
      p = new Promise<unknown>((a, b) => {
        res = a;
        rej = b;
      });
      if (!tryAcquireIngest(`archive ${sym}`, p)) return busy(reply);
      try {
        const out = await runArchive([sym], from, to);
        res(out);
        return reply.send({ ...out, throttle: codalThrottleStatus() });
      } catch (e) {
        rej(e);
        return fail(reply, e);
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
          "Behaviour is identical; prefer the `/ingest` endpoint for new callers. Runs async.",
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
          202: {
            type: "object",
            properties: {
              ok: { type: "boolean" },
              status: { type: "string" },
              ingestMode: { type: "string" },
              poll: { type: "string" },
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

      const promise = (async () => {
        const symbols = WATCHLIST.map((w) => w.sym);
        return runArchive(symbols, from, to);
      })();

      if (!tryAcquireIngest("archive-all (watchlist)", promise as Promise<unknown>)) return busy(reply);

      (promise as Promise<unknown>)
        .then((r) => server.log.info({ result: r }, "[ingest] archive-all completed"))
        .catch((e) => server.log.error(e, "[ingest] archive-all failed"));

      return reply.code(202).send({
        ok: true as const,
        status: "started" as const,
        ingestMode: "archive-all (watchlist)",
        poll: "/api/admin/ingest/status",
        throttle: codalThrottleStatus(),
        coolingDown: isCodalCoolingDown(),
      });
    },
  );
}
