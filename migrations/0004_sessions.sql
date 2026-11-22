-- 0004_sessions.sql
-- Multi-device sessions. One user → many sessions.
-- Store only the SHA-256 hash of the token, never the token itself.

CREATE TABLE IF NOT EXISTS sessions (
    id           BIGSERIAL PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash   VARCHAR(64) NOT NULL UNIQUE,   -- SHA-256 hex
    expires_at   TIMESTAMPTZ NOT NULL,
    ip           INET,
    user_agent   TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sessions_user
    ON sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_expires
    ON sessions (expires_at);