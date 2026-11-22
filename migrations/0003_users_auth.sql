-- 0003_users_auth.sql
-- Users table + auth/verification/reset tokens.
-- Sessions live in their own table (0004_sessions.sql) so a user can be
-- logged in from multiple devices; only the CURRENT auth token remains
-- denormalized here for the "who am I" fast path.

CREATE TABLE IF NOT EXISTS users (
    id                 BIGSERIAL PRIMARY KEY,

    -- Identity
    email              VARCHAR(255) UNIQUE NOT NULL,
    password_hash      VARCHAR(255) NOT NULL,
    verified           BOOLEAN NOT NULL DEFAULT FALSE,
    email_verified_at  TIMESTAMPTZ,

    -- Profile (optional)
    username           VARCHAR(50),
    display_name       VARCHAR(100),
    avatar_url         VARCHAR(500),
    phone              VARCHAR(20),
    country            VARCHAR(2),
    city               VARCHAR(50),

    -- Pending email verification token (hashed by app before storing)
    verify_token       VARCHAR(255) UNIQUE,
    verify_expires_at  TIMESTAMPTZ,

    -- Pending password reset token (hashed by app before storing)
    reset_token        VARCHAR(255) UNIQUE,
    reset_expires_at   TIMESTAMPTZ,

    -- Timestamps
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_created_at ON users (created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username
    ON users (username) WHERE username IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_verify_token
    ON users (verify_token) WHERE verify_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_reset_token
    ON users (reset_token) WHERE reset_token IS NOT NULL;

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();