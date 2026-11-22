// src/routes/stocks.ts
import type { FastifyInstance, FastifyReply } from "fastify";
import { getOrSet, invalidate } from "#utils/cache";
import {
  StockSchema,
  StockListQuerySchema,
  StockCreateBodySchema,
  StockUpdateBodySchema,
  StockParamsSchema,
  ErrorSchema,
  type StockRow,
  type StockCreateBody,
  type StockUpdateBody,
  type StockListQuery,
} from "./stocks.schema.js";

// ─── Helpers ────────────────────────────────────────────

/**
 * Codal/Postgres BIGINT comes back as a string from the `pg` driver.
 * We normalize to number for the JSON response. 2^53 is ~9e15 — far
 * beyond any realistic share count, so this is safe.
 */
function normalizeStock(r: StockRow) {
  return {
    ...r,
    shares_outstanding:
      r.shares_outstanding == null ? null : Number(r.shares_outstanding),
  };
}

/**
 * Map a Postgres unique-violation to a clean 409 body. The stock table has
 * three unique constraints we care about:
 *   stocks_pkey            (symbol)
 *   uq_stocks_isin         (isin, partial)
 *   uq_stocks_ins_code     (ins_code, partial)
 */
function conflictFromPgError(err: unknown): { field: string } | null {
  const e = err as { code?: string; constraint?: string; detail?: string };
  if (e?.code !== "23505") return null;

  // `constraint` is the authoritative name. `detail` is a fallback.
  const c = e.constraint ?? "";
  if (c === "stocks_pkey") return { field: "symbol" };
  if (c === "uq_stocks_isin") return { field: "isin" };
  if (c === "uq_stocks_ins_code") return { field: "ins_code" };

  // Fallback if constraint name was rewritten by a future migration.
  const d = e.detail ?? "";
  if (d.includes("(isin)")) return { field: "isin" };
  if (d.includes("(ins_code)")) return { field: "ins_code" };
  return { field: "unknown" };
}

/**
 * Postgres FK violation on DELETE — the stock is referenced by
 * prices / monthly_sales / quarterly_financials / forward_pe /
 * market_cap_history / narrative_cache.
 */
function fkRestricted(err: unknown): { table?: string } | null {
  const e = err as { code?: string; detail?: string; table?: string };
  if (e?.code !== "23503") return null;
  // detail looks like: Key (symbol)=(خودرو) is still referenced from table "prices".
  const m = /referenced from table "([^"]+)"/.exec(e.detail ?? "");
  return { table: m?.[1] };
}

function sendConflict(reply: FastifyReply, field: string) {
  return reply.code(409).send({
    error: "conflict",
    message: `A stock with this ${field} already exists`,
    details: { field },
  });
}

function sendNotFound(reply: FastifyReply, symbol: string) {
  return reply.code(404).send({
    error: "not_found",
    message: `Stock '${symbol}' not found`,
  });
}

/**
 * Invalidate every cache that could contain a stock-derived row.
 * `getOrSet` writes keys like `sectors:list`, `rankings:list`,
 * `stocks:list:...`. We use a prefix sweep so future list variants
 * (filters, pagination) are covered without bookkeeping.
 */
async function invalidateStockDerivedCaches(server: FastifyInstance) {
  await Promise.all([
    invalidate(server, "sectors:"),
    invalidate(server, "stocks:"),
    invalidate(server, "rankings:"),
  ]);
}

// ─── Route ──────────────────────────────────────────────

export async function registerStocksRoutes(
  server: FastifyInstance,
  prefix: string,
) {
  // ── LIST ──────────────────────────────────────────────
  server.get<{ Querystring: StockListQuery }>(
    `${prefix}/`,
    {
      schema: {
        tags: ["stocks"],
        summary: "List stocks (paginated, filterable)",
        querystring: StockListQuerySchema,
        response: {
          200: {
            type: "object",
            properties: {
              data: { type: "array", items: StockSchema },
              meta: {
                type: "object",
                properties: {
                  total: { type: "number" },
                  limit: { type: "number" },
                  offset: { type: "number" },
                },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const q = req.query;
      // Cache key MUST encode every input that changes the result.
      const cacheKey =
        `stocks:list:${JSON.stringify({
          q: q.q ?? null,
          sector: q.sector ?? null,
          industry_group: q.industry_group ?? null,
          is_bank: q.is_bank ?? null,
          is_insurance: q.is_insurance ?? null,
          is_holding_company: q.is_holding_company ?? null,
          limit: q.limit,
          offset: q.offset,
        })}`;

      const { data, hit } = await getOrSet(server, cacheKey, 60, async () => {
        // Build dynamic WHERE via the tagged-template `db` helper.
        // `sql` fragments keep identifiers safe; values are parameterized.
        const rows = await server.db<StockRow[]>`
          SELECT *
          FROM stocks
          WHERE (${q.q ?? null}::text IS NULL
                 OR symbol ILIKE '%' || ${q.q ?? ""} || '%'
                 OR name ILIKE '%' || ${q.q ?? ""} || '%'
                 OR name_en ILIKE '%' || ${q.q ?? ""} || '%')
            AND (${q.sector ?? null}::text IS NULL OR sector = ${q.sector ?? null})
            AND (${q.industry_group ?? null}::text IS NULL OR industry_group = ${q.industry_group ?? null})
            AND (${q.is_bank ?? null}::boolean IS NULL OR is_bank = ${q.is_bank ?? null})
            AND (${q.is_insurance ?? null}::boolean IS NULL OR is_insurance = ${q.is_insurance ?? null})
            AND (${q.is_holding_company ?? null}::boolean IS NULL OR is_holding_company = ${q.is_holding_company ?? null})
          ORDER BY symbol ASC
          LIMIT ${q.limit}
          OFFSET ${q.offset}
        `;

        const countRows = await server.db<{ count: number }[]>`
          SELECT COUNT(*)::int AS count
          FROM stocks
          WHERE (${q.q ?? null}::text IS NULL
                 OR symbol ILIKE '%' || ${q.q ?? ""} || '%'
                 OR name ILIKE '%' || ${q.q ?? ""} || '%'
                 OR name_en ILIKE '%' || ${q.q ?? ""} || '%')
            AND (${q.sector ?? null}::text IS NULL OR sector = ${q.sector ?? null})
            AND (${q.industry_group ?? null}::text IS NULL OR industry_group = ${q.industry_group ?? null})
            AND (${q.is_bank ?? null}::boolean IS NULL OR is_bank = ${q.is_bank ?? null})
            AND (${q.is_insurance ?? null}::boolean IS NULL OR is_insurance = ${q.is_insurance ?? null})
            AND (${q.is_holding_company ?? null}::boolean IS NULL OR is_holding_company = ${q.is_holding_company ?? null})
        `;

        return {
          data: rows.map(normalizeStock),
          meta: {
            total: countRows[0]?.count ?? 0,
            limit: q.limit,
            offset: q.offset,
          },
        };
      });

      reply.header("x-cache", hit ? "HIT" : "MISS");
      return reply.send(data);
    },
  );

  // ── GET ONE ───────────────────────────────────────────
  server.get<{ Params: { symbol: string } }>(
    `${prefix}/:symbol`,
    {
      schema: {
        tags: ["stocks"],
        summary: "Get a single stock by symbol",
        params: StockParamsSchema,
        response: { 200: StockSchema, 404: ErrorSchema },
      },
    },
    async (req, reply) => {
      const { symbol } = req.params;
      const cacheKey = `stocks:one:${symbol}`;

      const { data, hit } = await getOrSet(server, cacheKey, 60, async () => {
        const rows = await server.db<StockRow[]>`
          SELECT * FROM stocks WHERE symbol = ${symbol} LIMIT 1
        `;
        return rows[0] ? normalizeStock(rows[0]) : null;
      });

      reply.header("x-cache", hit ? "HIT" : "MISS");
      if (!data) return sendNotFound(reply, symbol);
      return reply.send(data);
    },
  );

  // ── CREATE ────────────────────────────────────────────
  server.post<{ Body: StockCreateBody }>(
    `${prefix}/`,
    {
      schema: {
        tags: ["stocks"],
        summary: "Create a stock",
        body: StockCreateBodySchema,
        response: {
          201: StockSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const b = req.body;

      try {
        const rows = await server.db<StockRow[]>`
          INSERT INTO stocks (
            symbol, name, name_en, sector, industry_group,
            isin, ins_code, shares_outstanding,
            is_bank, is_insurance, is_holding_company
          ) VALUES (
            ${b.symbol},
            ${b.name},
            ${b.name_en ?? null},
            ${b.sector ?? null},
            ${b.industry_group ?? null},
            ${b.isin ?? null},
            ${b.ins_code ?? null},
            ${b.shares_outstanding ?? null},
            ${b.is_bank ?? false},
            ${b.is_insurance ?? false},
            ${b.is_holding_company ?? false}
          )
          RETURNING *
        `;

        await invalidateStockDerivedCaches(server);

        reply.code(201);
        return reply.send(normalizeStock(rows[0]!));
      } catch (err) {
        const conflict = conflictFromPgError(err);
        if (conflict) return sendConflict(reply, conflict.field);
        throw err;
      }
    },
  );

  // ── UPDATE (PATCH semantics) ──────────────────────────
  server.patch<{ Params: { symbol: string }; Body: StockUpdateBody }>(
    `${prefix}/:symbol`,
    {
      schema: {
        tags: ["stocks"],
        summary: "Partially update a stock",
        description:
          "Only the fields provided are updated. `symbol` is immutable.",
        params: StockParamsSchema,
        body: StockUpdateBodySchema,
        response: { 200: StockSchema, 404: ErrorSchema, 409: ErrorSchema },
      },
    },
    async (req, reply) => {
      const { symbol } = req.params;
      const b = req.body;

      // Build the SET fragment from only the provided keys. We can't use
      // a plain tagged template here because the column list is dynamic;
      // postgres-js's `sql(rows)` helper handles this safely.
      const sets: Record<string, unknown> = {};
      if (b.name !== undefined) sets.name = b.name;
      if (b.name_en !== undefined) sets.name_en = b.name_en;
      if (b.sector !== undefined) sets.sector = b.sector;
      if (b.industry_group !== undefined) sets.industry_group = b.industry_group;
      if (b.isin !== undefined) sets.isin = b.isin;
      if (b.ins_code !== undefined) sets.ins_code = b.ins_code;
      if (b.shares_outstanding !== undefined)
        sets.shares_outstanding = b.shares_outstanding;
      if (b.is_bank !== undefined) sets.is_bank = b.is_bank;
      if (b.is_insurance !== undefined) sets.is_insurance = b.is_insurance;
      if (b.is_holding_company !== undefined)
        sets.is_holding_company = b.is_holding_company;

      // `minProperties: 1` in the schema guarantees this is non-empty,
      // but guard anyway in case the schema is ever weakened.
      if (Object.keys(sets).length === 0) {
        return reply.code(400).send({
          error: "bad_request",
          message: "No updatable fields provided",
        });
      }

      try {
        const rows = await server.db<StockRow[]>`
          UPDATE stocks
          SET ${server.db(sets)}
          WHERE symbol = ${symbol}
          RETURNING *
        `;

        if (rows.length === 0) return sendNotFound(reply, symbol);

        await invalidateStockDerivedCaches(server);
        return reply.send(normalizeStock(rows[0]!));
      } catch (err) {
        const conflict = conflictFromPgError(err);
        if (conflict) return sendConflict(reply, conflict.field);
        throw err;
      }
    },
  );

  // ── DELETE ────────────────────────────────────────────
  server.delete<{ Params: { symbol: string } }>(
    `${prefix}/:symbol`,
    {
      schema: {
        tags: ["stocks"],
        summary: "Delete a stock",
        description:
          "Fails with 409 if the stock is referenced by any historical " +
          "time-series (prices, monthly_sales, quarterly_financials, " +
          "forward_pe, market_cap_history, narrative_cache).",
        params: StockParamsSchema,
        response: {
          204: { type: "null" },
          404: ErrorSchema,
          409: ErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { symbol } = req.params;

      try {
        const rows = await server.db<{ symbol: string }[]>`
          DELETE FROM stocks WHERE symbol = ${symbol} RETURNING symbol
        `;
        if (rows.length === 0) return sendNotFound(reply, symbol);

        await invalidateStockDerivedCaches(server);
        return reply.code(204).send();
      } catch (err) {
        const fk = fkRestricted(err);
        if (fk) {
          return reply.code(409).send({
            error: "conflict",
            message:
              `Cannot delete '${symbol}': it is still referenced by ` +
              `'${fk.table ?? "other tables"}'.`,
            details: { referenced_by: fk.table ?? null },
          });
        }
        throw err;
      }
    },
  );
}