-- One-off inspection: how much duplicate work is actually stored?
-- Read-only. Run via: node --experimental-strip-types tools/inspect-dupes.ts

SELECT 'prices' AS tbl, COUNT(*) AS total FROM prices
UNION ALL SELECT 'monthly_sales', COUNT(*) FROM monthly_sales
UNION ALL SELECT 'quarterly_financials', COUNT(*) FROM quarterly_financials
UNION ALL SELECT 'forward_pe', COUNT(*) FROM forward_pe
UNION ALL SELECT 'stocks', COUNT(*) FROM stocks
UNION ALL SELECT 'market_cap_history', COUNT(*) FROM market_cap_history;
