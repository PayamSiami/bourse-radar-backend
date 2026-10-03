-- 0002_rankings_view.sql
-- Bourse Radar — materialized ranking view
--
-- Refresh with: REFRESH MATERIALIZED VIEW stock_rankings;
-- (scheduled by the compute-rankings cron job)

CREATE MATERIALIZED VIEW IF NOT EXISTS stock_rankings AS
SELECT
    s.symbol,
    s.name,
    s.sector,
    p.last_price                AS last_price,
    p.volume                    AS volume,
    fp.forward_pe,
    fp.estimated_annual_eps,
    fp.confidence,
    fp.confidence_score,
    fp.calculation_json,
    PERCENT_RANK() OVER (ORDER BY fp.forward_pe ASC) * 100 AS pe_percentile,
    CUME_DIST() OVER (PARTITION BY s.sector ORDER BY p.volume DESC) * 100 AS liquidity_pct,
    -- Attractiveness score: inverse_PE * 0.30 + confidence * 0.25
    --                       + liquidity * 0.25 + stability * 0.10 + mc * 0.10
    ROUND(
        COALESCE(1.0 / (1.0 + fp.forward_pe / 15.0), 0) * 0.30
      + COALESCE(fp.confidence_score, 0)                 * 0.25
      + LEAST(LOG(10, GREATEST(p.volume, 1)) / 10.0, 1.0) * 0.25
      + 0.10
      + 0.10
    , 2) AS attractiveness_score,
    ROW_NUMBER() OVER (ORDER BY
        COALESCE(1.0 / (1.0 + fp.forward_pe / 15.0), 0) * 0.30
      + COALESCE(fp.confidence_score, 0)                 * 0.25
      + LEAST(LOG(10, GREATEST(p.volume, 1)) / 10.0, 1.0) * 0.25
      + 0.10
      + 0.10
      DESC) AS rank
FROM stocks s
JOIN LATERAL (
    SELECT last_price, volume, timestamp
    FROM prices
    WHERE symbol = s.symbol
    ORDER BY timestamp DESC LIMIT 1
) p ON TRUE
LEFT JOIN LATERAL (
    SELECT forward_pe, estimated_annual_eps, confidence, confidence_score,
           calculation_json, calculated_at
    FROM forward_pe
    WHERE symbol = s.symbol
    ORDER BY calculated_at DESC LIMIT 1
) fp ON TRUE
WHERE fp.forward_pe IS NOT NULL
  AND fp.confidence != 'non_calculable';

CREATE UNIQUE INDEX IF NOT EXISTS idx_rankings_symbol ON stock_rankings (symbol);
CREATE INDEX IF NOT EXISTS idx_rankings_score ON stock_rankings (attractiveness_score DESC);
CREATE INDEX IF NOT EXISTS idx_rankings_sector ON stock_rankings (sector);