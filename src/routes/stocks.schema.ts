// src/routes/stocks.schema.ts
// Swagger schemas + shared types for the stocks CRUD resource.

export const StockSchema = {
  type: "object",
  properties: {
    symbol: { type: "string", description: "TSE symbol, e.g. 'خودرو'" },
    name: { type: "string" },
    name_en: { type: ["string", "null"] },
    sector: { type: ["string", "null"] },
    industry_group: { type: ["string", "null"] },
    isin: { type: ["string", "null"] },
    ins_code: { type: ["string", "null"] },
    shares_outstanding: { type: ["integer", "null"] },
    is_bank: { type: "boolean" },
    is_insurance: { type: "boolean" },
    is_holding_company: { type: "boolean" },
    created_at: { type: "string", format: "date-time" },
    updated_at: { type: "string", format: "date-time" },
  },
} as const;

export const StockListQuerySchema = {
  type: "object",
  properties: {
    q: { type: "string", description: "Search symbol, name, or name_en (ILIKE)" },
    sector: { type: "string" },
    industry_group: { type: "string" },
    is_bank: { type: "boolean" },
    is_insurance: { type: "boolean" },
    is_holding_company: { type: "boolean" },
    limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
    offset: { type: "integer", minimum: 0, default: 0 },
  },
} as const;

export const StockCreateBodySchema = {
  type: "object",
  required: ["symbol", "name"],
  additionalProperties: false,
  properties: {
    symbol: { type: "string", minLength: 1, maxLength: 64 },
    name: { type: "string", minLength: 1, maxLength: 255 },
    name_en: { type: ["string", "null"], maxLength: 255 },
    sector: { type: ["string", "null"], maxLength: 255 },
    industry_group: { type: ["string", "null"], maxLength: 255 },
    isin: { type: ["string", "null"], maxLength: 32 },
    ins_code: { type: ["string", "null"], maxLength: 32 },
    shares_outstanding: { type: ["integer", "null"], minimum: 1 },
    is_bank: { type: "boolean", default: false },
    is_insurance: { type: "boolean", default: false },
    is_holding_company: { type: "boolean", default: false },
  },
} as const;

export const StockUpdateBodySchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    // symbol is intentionally NOT updatable: it is a PK referenced by
    // prices, monthly_sales, quarterly_financials, forward_pe,
    // market_cap_history, narrative_cache. Renaming would cascade or
    // orphan historical data — treat symbol as immutable.
    name: { type: "string", minLength: 1, maxLength: 255 },
    name_en: { type: ["string", "null"], maxLength: 255 },
    sector: { type: ["string", "null"], maxLength: 255 },
    industry_group: { type: ["string", "null"], maxLength: 255 },
    isin: { type: ["string", "null"], maxLength: 32 },
    ins_code: { type: ["string", "null"], maxLength: 32 },
    shares_outstanding: { type: ["integer", "null"], minimum: 1 },
    is_bank: { type: "boolean" },
    is_insurance: { type: "boolean" },
    is_holding_company: { type: "boolean" },
  },
} as const;

export const StockParamsSchema = {
  type: "object",
  required: ["symbol"],
  properties: { symbol: { type: "string", minLength: 1 } },
} as const;

export const ErrorSchema = {
  type: "object",
  properties: {
    error: { type: "string" },
    message: { type: "string" },
    details: { type: "object", additionalProperties: true },
  },
} as const;

// ── Inferred TS types (used by the handlers) ────────────────────
export interface StockRow {
  symbol: string;
  name: string;
  name_en: string | null;
  sector: string | null;
  industry_group: string | null;
  isin: string | null;
  ins_code: string | null;
  shares_outstanding: string | null; // BIGINT arrives as string from pg
  is_bank: boolean;
  is_insurance: boolean;
  is_holding_company: boolean;
  created_at: string;
  updated_at: string;
}

export interface StockCreateBody {
  symbol: string;
  name: string;
  name_en?: string | null;
  sector?: string | null;
  industry_group?: string | null;
  isin?: string | null;
  ins_code?: string | null;
  shares_outstanding?: number | null;
  is_bank?: boolean;
  is_insurance?: boolean;
  is_holding_company?: boolean;
}

export type StockUpdateBody = Partial<Omit<StockCreateBody, "symbol">>;

export interface StockListQuery {
  q?: string;
  sector?: string;
  industry_group?: string;
  is_bank?: boolean;
  is_insurance?: boolean;
  is_holding_company?: boolean;
  limit: number;
  offset: number;
}
