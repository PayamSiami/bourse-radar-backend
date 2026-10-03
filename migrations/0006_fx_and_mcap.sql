-- 0006_fx_and_mcap.sql
-- Bourse Radar — FX rate tracking + USD-denominated market cap history
--
-- bonyadnegar.ir reports every value in BOTH Rial and USD, with FX-source
-- provenance (nobitex + wallex, quality flag). This migration adds:
--   1. fx_rates           — daily USD/IRR rate with source + quality tags
--   2. monthly_sales USD  — back-convert existing Codal Rial figures to USD
--   3. market_cap_history — daily price × shares × FX series (bonyadnegar mcap-series shape)

-- ── 1. FX rate log (one row per calendar day) ─────────────────────
CREATE TABLE IF NOT EXISTS fx_rates (
    rate_date       DATE PRIMARY KEY,
    rate_toman      NUMERIC(14,2),         -- Toman per 1 USD
    rate_rial       NUMERIC(15,2),         -- Rial per 1 USD (= rate_toman × 10)
    sources         TEXT[],                -- e.g. ARRAY['wallex'] or ['nobitex','wallex']
    quality         TEXT NOT NULL,         -- 'valid' | 'fallback' | 'suspicious'
    readings        JSONB,                 -- { "wallex": 233224, "nobitex": null }
    fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fx_rates_date ON fx_rates (rate_date DESC);

-- ── 2. USD columns on monthly_sales ───────────────────────────────
ALTER TABLE monthly_sales
  ADD COLUMN IF NOT EXISTS sales_usd       NUMERIC(22,2),
  ADD COLUMN IF NOT EXISTS domestic_usd    NUMERIC(22,2),
  ADD COLUMN IF NOT EXISTS export_usd      NUMERIC(22,2),
  ADD COLUMN IF NOT EXISTS service_usd     NUMERIC(22,2),
  ADD COLUMN IF NOT EXISTS fx_rate_rial    NUMERIC(15,2),
  ADD COLUMN IF NOT EXISTS fx_quality      TEXT,
  ADD COLUMN IF NOT EXISTS fx_sources      TEXT[],
  ADD COLUMN IF NOT EXISTS ytd_total_usd   NUMERIC(24,2),
  ADD COLUMN IF NOT EXISTS ytd_prior_year_usd NUMERIC(24,2);
COMMENT ON COLUMN monthly_sales.sales_usd IS 'Total monthly sales converted to USD at contemporaneous fx rate';
COMMENT ON COLUMN monthly_sales.fx_quality IS 'valid | fallback | suspicious';

-- ── 3. Market cap history (mirrors bonyadnegar mcap-series) ─────────
CREATE TABLE IF NOT EXISTS market_cap_history (
    symbol           TEXT NOT NULL REFERENCES stocks(symbol),
    date             DATE NOT NULL,
    price_rial       NUMERIC(20,2),
    shares_count     BIGINT,               -- constant per symbol, stored for immutability
    mcap_rial        NUMERIC(30,2),         -- price_rial × shares_count
    mcap_usd         NUMERIC(22,2),         -- mcap_rial / fx_rate_rial
    fx_rate_rial     NUMERIC(15,2),
    fx_quality       TEXT,                 -- 'valid' | 'fallback' | 'suspicious'
    fx_sources       TEXT[],               -- ['wallex'] or ['nobitex','wallex']
    source           TEXT NOT NULL,        -- 'tsetmc_fx' | 'bonyadnegar'
    PRIMARY KEY (symbol, date)
);
CREATE INDEX IF NOT EXISTS idx_mcap_symbol_date ON market_cap_history (symbol, date DESC);
CREATE INDEX IF NOT EXISTS idx_mcap_date ON market_cap_history (date DESC);
