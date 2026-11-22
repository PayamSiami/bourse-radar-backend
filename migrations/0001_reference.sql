-- 0001_reference.sql
-- Bourse Radar — reference data, market time-series, Codal financials,
-- FX rates, and USD-denominated market-cap history.
-- PostgreSQL 16+
--
-- ── UNIT CONVENTIONS (READ THIS) ─────────────────────────────────
--   *_rial                    → Rial (integer-ish NUMERIC)
--   *_million_rial            → millions of Rial
--   *_billion_rial            → billions of Rial
--   *_usd                     → USD
--   Net margin / confidence_score / weight fractions → 0.0 .. 1.0
--
-- ── PARTITIONING INTENT ──────────────────────────────────────────
--   `prices` and `market_cap_history` are high-volume time-series.
--   They are created UNPARTITIONED for simplicity, but the PK is
--   (symbol, <time>) and the application MUST plan a migration to
--   RANGE-partition by time (monthly for prices, yearly for mcap)
--   before row counts exceed ~50M. Do not add a surrogate id PK;
--   it would block that migration.

-- ── Shared trigger function ──────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── Stocks (reference data) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS stocks (
    symbol              TEXT PRIMARY KEY,               -- e.g. 'خودرو'
    name                TEXT NOT NULL,
    name_en             TEXT,
    sector              TEXT,
    industry_group      TEXT,
    isin                TEXT,
    ins_code            TEXT,                           -- TSETMC numeric ID (for order book)
    shares_outstanding  BIGINT CHECK (shares_outstanding IS NULL OR shares_outstanding > 0),
    is_bank             BOOLEAN NOT NULL DEFAULT FALSE,
    is_insurance        BOOLEAN NOT NULL DEFAULT FALSE,
    is_holding_company  BOOLEAN NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_stocks_isin
    ON stocks (isin) WHERE isin IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_stocks_ins_code
    ON stocks (ins_code) WHERE ins_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stocks_sector ON stocks (sector);

DROP TRIGGER IF EXISTS trg_stocks_updated_at ON stocks;
CREATE TRIGGER trg_stocks_updated_at
    BEFORE UPDATE ON stocks
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Real-time prices (time-series) ───────────────────────────────
CREATE TABLE IF NOT EXISTS prices (
    symbol          TEXT NOT NULL REFERENCES stocks(symbol) ON DELETE RESTRICT,
    timestamp       TIMESTAMPTZ NOT NULL,
    last_price      NUMERIC(20,2),
    open_price      NUMERIC(20,2),
    high_price      NUMERIC(20,2),
    low_price       NUMERIC(20,2),
    volume          BIGINT CHECK (volume IS NULL OR volume >= 0),
    value           NUMERIC(30,2),
    change_percent  NUMERIC(8,2),
    PRIMARY KEY (symbol, timestamp)
);
CREATE INDEX IF NOT EXISTS idx_prices_symbol_time
    ON prices (symbol, timestamp DESC);

-- ── Monthly sales (Codal.ir فروش ماهانه) ─────────────────────────
--   sales_amount_million_rial is the canonical monthly sales figure
--   (Rial, in millions). The `detail` JSONB stores the full structured
--   report breakdown as extracted by extractMonthlyReport().
CREATE TABLE IF NOT EXISTS monthly_sales (
    symbol                      TEXT NOT NULL REFERENCES stocks(symbol) ON DELETE RESTRICT,
    month_end                   DATE NOT NULL,
    sales_amount_million_rial   NUMERIC(30,2),           -- میلیون ریال
    is_estimated                BOOLEAN NOT NULL DEFAULT FALSE,
    source_url                  TEXT,
    detail                      JSONB,
    fetched_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (symbol, month_end)
);
COMMENT ON COLUMN monthly_sales.sales_amount_million_rial IS
    'Monthly sales total in MILLIONS of Rial.';
COMMENT ON COLUMN monthly_sales.detail IS
    'Structured monthly report: {periodEnd, goods:[], totals:[{rowCode,label,...}], '
    'monthlySalesTotal, ytdSalesTotal, priorYtdSalesTotal, domesticMonthly, exportMonthly}.';
CREATE INDEX IF NOT EXISTS idx_monthly_sales_month
    ON monthly_sales (month_end DESC);

-- ── Quarterly financials (Codal.ir) ──────────────────────────────
--   revenue / net_profit are in BILLIONS of Rial (matches Codal UI).
--   eps_rials is (net_profit_billion_rial × 1e9) / shares_outstanding
--   → Rial per share. Stored explicitly so charts can query it directly.
CREATE TABLE IF NOT EXISTS quarterly_financials (
    symbol                 TEXT NOT NULL REFERENCES stocks(symbol) ON DELETE RESTRICT,
    fiscal_year            INTEGER NOT NULL,
    quarter                INTEGER NOT NULL CHECK (quarter BETWEEN 1 AND 4),
    period_start           DATE,
    period_end             DATE,
    revenue_billion_rial   NUMERIC(30,2),           -- میلیارد ریال
    net_profit_billion_rial NUMERIC(30,2),          -- میلیارد ریال
    net_margin             NUMERIC(8,6) CHECK (net_margin IS NULL OR net_margin BETWEEN -1 AND 1),
    extraordinary_income_billion_rial  NUMERIC(30,2),
    extraordinary_expense_billion_rial NUMERIC(30,2),
    shares_outstanding     BIGINT,
    eps_rials              NUMERIC(20,4),           -- net_profit × 1e9 / shares
    source_url             TEXT,
    fetched_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (symbol, fiscal_year, quarter),
    CHECK (period_end IS NULL OR period_start IS NULL OR period_end >= period_start)
);
COMMENT ON COLUMN quarterly_financials.revenue_billion_rial IS
    'Quarterly revenue in BILLIONS of Rial.';
COMMENT ON COLUMN quarterly_financials.net_profit_billion_rial IS
    'Quarterly net profit in BILLIONS of Rial.';
COMMENT ON COLUMN quarterly_financials.eps_rials IS
    'Earnings per share in Rial = net_profit_billion_rial × 1e9 / shares_outstanding.';
CREATE INDEX IF NOT EXISTS idx_quarterly_period
    ON quarterly_financials (symbol, period_end DESC);

-- ── Forward P/E calculations (append-only snapshot) ──────────────
--   calculated_at defaults to clock_timestamp() so batch inserts in a
--   single transaction get DISTINCT timestamps and retries don't PK-collide.
CREATE TABLE IF NOT EXISTS forward_pe (
    symbol               TEXT NOT NULL REFERENCES stocks(symbol) ON DELETE RESTRICT,
    calculated_at        TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    estimated_annual_eps NUMERIC(20,4),
    forward_pe           NUMERIC(20,4),
    confidence           TEXT NOT NULL
                         CHECK (confidence IN ('high','medium','low','non_calculable')),
    confidence_score     NUMERIC(6,4) CHECK (confidence_score IS NULL OR confidence_score BETWEEN 0 AND 1),
    method               TEXT,
    margin_source        TEXT,
    margin_used          NUMERIC(10,6),
    sales_count          INTEGER,
    disclaimer           TEXT,
    calculation_json     JSONB,
    PRIMARY KEY (symbol, calculated_at)
);
CREATE INDEX IF NOT EXISTS idx_forward_pe_latest
    ON forward_pe (symbol, calculated_at DESC);
CREATE INDEX IF NOT EXISTS idx_forward_pe_conf
    ON forward_pe (confidence);

-- ── FX rates (one row per calendar day) ──────────────────────────
--   rate_toman is the source of truth; rate_rial is GENERATED.
CREATE TABLE IF NOT EXISTS fx_rates (
    rate_date       DATE PRIMARY KEY,
    rate_toman      NUMERIC(14,2) NOT NULL CHECK (rate_toman > 0),
    rate_rial       NUMERIC(15,2) GENERATED ALWAYS AS (rate_toman * 10) STORED,
    sources         TEXT[],
    quality         TEXT NOT NULL CHECK (quality IN ('valid','fallback','suspicious')),
    readings        JSONB,                 -- {"wallex": 233224, "nobitex": null}
    fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fx_rates_date ON fx_rates (rate_date DESC);

-- ── Market cap history (mirrors bonyadnegar mcap-series) ─────────
--   mcap_rial / mcap_usd are GENERATED so they cannot disagree with
--   price_rial × shares_count or with the fx rate.
CREATE TABLE IF NOT EXISTS market_cap_history (
    symbol        TEXT NOT NULL REFERENCES stocks(symbol) ON DELETE RESTRICT,
    date          DATE NOT NULL,
    price_rial    NUMERIC(20,2) NOT NULL CHECK (price_rial >= 0),
    shares_count  BIGINT NOT NULL CHECK (shares_count > 0),
    mcap_rial     NUMERIC(30,2) GENERATED ALWAYS AS (price_rial * shares_count) STORED,
    fx_rate_rial  NUMERIC(15,2),
    mcap_usd      NUMERIC(22,2) GENERATED ALWAYS AS
                  (CASE WHEN fx_rate_rial > 0
                        THEN (price_rial * shares_count) / fx_rate_rial
                   END) STORED,
    fx_quality    TEXT CHECK (fx_quality IS NULL OR fx_quality IN ('valid','fallback','suspicious')),
    fx_sources    TEXT[],
    source        TEXT NOT NULL CHECK (source IN ('tsetmc_fx','bonyadnegar')),
    PRIMARY KEY (symbol, date)
);
CREATE INDEX IF NOT EXISTS idx_mcap_symbol_date
    ON market_cap_history (symbol, date DESC);
CREATE INDEX IF NOT EXISTS idx_mcap_date
    ON market_cap_history (date DESC);