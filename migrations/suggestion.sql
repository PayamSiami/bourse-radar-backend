CREATE TABLE IF NOT EXISTS suggestion_cache (
  cache_key    TEXT PRIMARY KEY,
  payload      JSONB NOT NULL,
  model        TEXT,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_suggestion_cache_expires
  ON suggestion_cache (expires_at);

CREATE TABLE IF NOT EXISTS narrative_cache (
  symbol       TEXT NOT NULL,
  metric_hash  TEXT NOT NULL,
  narrative    JSONB NOT NULL,
  model        TEXT,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (symbol, metric_hash)
);

CREATE INDEX IF NOT EXISTS idx_narrative_cache_expires
  ON narrative_cache (expires_at);