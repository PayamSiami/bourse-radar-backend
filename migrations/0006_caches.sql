-- 0006_caches.sql
-- LLM / computed-output caches. Both tables are pruned by a cron that
-- DELETEs WHERE expires_at < now(). Document that in your scheduler.
--
-- cache_key / metric_hash MUST include the model name AND a prompt/
-- version identifier so a prompt change cannot reuse a stale payload.

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
    symbol       TEXT NOT NULL REFERENCES stocks(symbol) ON DELETE CASCADE,
    metric_hash  TEXT NOT NULL,
    narrative    JSONB NOT NULL,
    model        TEXT,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (symbol, metric_hash)
);

CREATE INDEX IF NOT EXISTS idx_narrative_cache_expires
    ON narrative_cache (expires_at);