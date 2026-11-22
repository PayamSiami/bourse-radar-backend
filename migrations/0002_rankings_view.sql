-- 0002_rankings_view.sql
-- Materialized ranking view over stocks + latest price + latest forward P/E.
--
-- Refresh (blocking):
--   REFRESH MATERIALIZED VIEW stock_rankings;
-- Refresh (non-blocking, needs the UNIQUE index below):
--   REFRESH MATERIALIZED VIEW CONCURRENTLY stock_rankings;
--
-- STALENESS: this view is refreshed by the compute-rankings cron.
--   Do NOT use it to render live prices; read `prices` for that.
--
-- SCOPE: only symbols that have a calculable forward P/E appear here.
--   The join to forward_pe is INNER (not LEFT) by design.

CREATE MATERIALIZED VIEW IF NOT EXISTS stock_rankings AS
WITH latest_price AS (
    SELECT DISTINCT ON (symbol)
           symbol, last_price, volume, "timestamp" AS price_ts
    FROM prices
    ORDER BY symbol, "timestamp" DESC
),
latest_pe AS (
    SELECT DISTINCT ON (symbol)
           symbol, forward_pe, estimated_annual_eps, confidence,
           confidence_score, calculation_json, calculated_at
    FROM forward_pe
    ORDER BY symbol, calculated_at DESC
),
scored AS (
    SELECT
        s.symbol,
        s.name,
        s.sector,
        lp.last_price,
        lp.volume,
        lp.price_ts,
        pe.forward_pe,
        pe.estimated_annual_eps,
        pe.confidence,
        pe.confidence_score,
        pe.calculation_json,
        pe.calculated_at,
        -- 0.0 .. 1.0 components
        COALESCE(1.0 / (1.0 + pe.forward_pe / 15.0), 0)                       AS inv_pe_score,
        COALESCE(pe.confidence_score, 0)                                      AS conf_score,
        LEAST(LOG(10, GREATEST(lp.volume, 1)) / 10.0, 1.0)                    AS liq_score
    FROM stocks s
    JOIN latest_price lp ON lp.symbol = s.symbol
    JOIN latest_pe    pe ON pe.symbol = s.symbol
    WHERE pe.forward_pe IS NOT NULL
      AND pe.confidence IS DISTINCT FROM 'non_calculable'
)
SELECT
    symbol,
    name,
    sector,
    last_price,
    volume,
    price_ts,
    forward_pe,
    estimated_annual_eps,
    confidence,
    confidence_score,
    calculation_json,
    calculated_at,
    PERCENT_RANK() OVER (ORDER BY forward_pe ASC) * 100                       AS pe_percentile,
    CUME_DIST()     OVER (PARTITION BY sector ORDER BY volume DESC) * 100     AS liquidity_pct,
    -- Final score (weights sum to 1.00).
    -- Stability (0.10) and market-cap (0.10) terms are placeholders kept at 0.0
    -- until those inputs are wired in; remove them from the ROUND() once real.
    ROUND(
        inv_pe_score * 0.30
      + conf_score   * 0.25
      + liq_score    * 0.25
      + 0.00         * 0.10   -- stability
      + 0.00         * 0.10   -- market cap
    , 2) AS attractiveness_score,
    ROW_NUMBER() OVER (ORDER BY
        inv_pe_score * 0.30
      + conf_score   * 0.25
      + liq_score    * 0.25
      + 0.00         * 0.10
      + 0.00         * 0.10
    DESC) AS rank
FROM scored;

-- Required for REFRESH MATERIALIZED VIEW CONCURRENTLY.
CREATE UNIQUE INDEX IF NOT EXISTS idx_rankings_symbol
    ON stock_rankings (symbol);
CREATE INDEX IF NOT EXISTS idx_rankings_score
    ON stock_rankings (attractiveness_score DESC);
CREATE INDEX IF NOT EXISTS idx_rankings_sector
    ON stock_rankings (sector);