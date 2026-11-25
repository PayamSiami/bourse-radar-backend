-- postponed for now as the table doesn't exist yet in the schema
-- But we'll create it via Prisma or raw SQL

CREATE TABLE IF NOT EXISTS symbol_sector_margins (
  id SERIAL PRIMARY KEY,
  -- TEXT so it can reference stocks.symbol (see 0010).
  symbol TEXT NOT NULL REFERENCES stocks(symbol) ON UPDATE CASCADE ON DELETE RESTRICT,
  profit_margin NUMERIC(5,2) NOT NULL DEFAULT 0,
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to DATE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index
CREATE INDEX idx_symbol_sector_margins_symbol ON symbol_sector_margins(symbol);
CREATE INDEX idx_symbol_sector_margins_sector ON symbol_sector_margins(sector);