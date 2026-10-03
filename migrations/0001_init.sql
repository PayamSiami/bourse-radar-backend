-- 0001_init.sql
-- Bourse Radar — initial schema
-- PostgreSQL 16+

-- ── Stocks (reference data) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stocks (
    symbol              TEXT PRIMARY KEY,               -- e.g. 'خودرو'
    name                TEXT NOT NULL,
    name_en             TEXT,
    sector              TEXT,
    industry_group      TEXT,
    isin                TEXT UNIQUE,
    ins_code            TEXT UNIQUE,                    -- TSETMC numeric ID (for order book)
    shares_outstanding  BIGINT,
    is_bank             BOOLEAN NOT NULL DEFAULT FALSE,
    is_insurance        BOOLEAN NOT NULL DEFAULT FALSE,
    is_holding_company  BOOLEAN NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stocks_sector ON stocks (sector);
CREATE INDEX IF NOT EXISTS idx_stocks_ins_code ON stocks (ins_code);

-- ── Real-time prices (time-series) ────────────────────────────────
CREATE TABLE IF NOT EXISTS prices (
    symbol       TEXT NOT NULL REFERENCES stocks(symbol),
    timestamp    TIMESTAMPTZ NOT NULL,
    last_price   NUMERIC(20,2),
    open_price   NUMERIC(20,2),
    high_price   NUMERIC(20,2),
    low_price    NUMERIC(20,2),
    volume       BIGINT,
    value        NUMERIC(30,2),
    change_percent NUMERIC(8,2),
    PRIMARY KEY (symbol, timestamp)
);
CREATE INDEX IF NOT EXISTS idx_prices_symbol_time ON prices (symbol, timestamp DESC);

-- ── Monthly sales (Codal.ir فروش ماهانه) ───────────────────────────
CREATE TABLE IF NOT EXISTS monthly_sales (
    symbol         TEXT NOT NULL REFERENCES stocks(symbol),
    month_end      DATE NOT NULL,
    sales_amount   NUMERIC(30,2),          -- میلیون ریال
    is_estimated   BOOLEAN NOT NULL DEFAULT FALSE,   -- برآوردی vs. واقعی
    source_url     TEXT,
    detail         JSONB,                  -- structured breakdown (goods, totals, YTD)
    fetched_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (symbol, month_end)
);
CREATE INDEX IF NOT EXISTS idx_monthly_sales_month ON monthly_sales (month_end DESC);

-- ── Quarterly financials (Codal.ir) ────────────────────────────────
CREATE TABLE IF NOT EXISTS quarterly_financials (
    symbol         TEXT NOT NULL REFERENCES stocks(symbol),
    fiscal_year    INTEGER NOT NULL,
    quarter        INTEGER NOT NULL,
    period_start   DATE,
    period_end     DATE,
    revenue        NUMERIC(30,2),          -- میلیارد ریال
    net_profit     NUMERIC(30,2),
    net_margin     NUMERIC(8,6),           -- fraction
    extraordinary_income  NUMERIC(30,2),
    extraordinary_expense NUMERIC(30,2),
    shares_outstanding BIGINT,
    source_url     TEXT,
    fetched_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (symbol, fiscal_year, quarter)
);
CREATE INDEX IF NOT EXISTS idx_quarterly_period ON quarterly_financials (symbol, period_end DESC);

-- ── Forward P/E calculations (append-only snapshot) ────────────────
CREATE TABLE IF NOT EXISTS forward_pe (
    symbol               TEXT NOT NULL REFERENCES stocks(symbol),
    calculated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    estimated_annual_eps NUMERIC(20,4),
    forward_pe           NUMERIC(20,4),
    confidence           TEXT NOT NULL,    -- 'high' | 'medium' | 'low' | 'non_calculable'
    confidence_score     NUMERIC(6,4),     -- 0.0 – 1.0
    method               TEXT,
    margin_source        TEXT,
    margin_used          NUMERIC(10,6),
    sales_count          INTEGER,
    disclaimer           TEXT,
    calculation_json     JSONB,
    PRIMARY KEY (symbol, calculated_at)
);
CREATE INDEX IF NOT EXISTS idx_forward_pe_latest ON forward_pe (symbol, calculated_at DESC);
CREATE INDEX IF NOT EXISTS idx_forward_pe_conf ON forward_pe (confidence);