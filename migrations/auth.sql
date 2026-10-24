-- ============================================================
-- 0. Shared trigger function
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ============================================================
-- 1. users  (auth + active token, single table)
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
    id                 BIGSERIAL PRIMARY KEY,

    -- Identity
    email              VARCHAR(255) UNIQUE NOT NULL,
    password_hash      VARCHAR(255) NOT NULL,
    verified           BOOLEAN DEFAULT FALSE,
    email_verified_at  TIMESTAMPTZ,

    -- Profile (optional)
    username           VARCHAR(50),
    display_name       VARCHAR(100),
    avatar_url         VARCHAR(500),
    phone              VARCHAR(20),
    country            VARCHAR(2),
    city               VARCHAR(50),

    -- Active session (current login)
    session_token      VARCHAR(255) UNIQUE,
    session_expires_at TIMESTAMPTZ,
    session_ip         INET,
    session_user_agent TEXT,
    last_login_at      TIMESTAMPTZ,

    -- Pending email verification token
    verify_token       VARCHAR(255) UNIQUE,
    verify_expires_at  TIMESTAMPTZ,

    -- Pending password reset token
    reset_token        VARCHAR(255) UNIQUE,
    reset_expires_at   TIMESTAMPTZ,

    -- Timestamps
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_users_created_at      ON users(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_session_token   ON users(session_token) WHERE session_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_verify_token    ON users(verify_token)  WHERE verify_token  IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_reset_token     ON users(reset_token)   WHERE reset_token   IS NOT NULL;

-- updated_at trigger
DROP TRIGGER IF EXISTS users_updated_at ON users;
CREATE TRIGGER users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();