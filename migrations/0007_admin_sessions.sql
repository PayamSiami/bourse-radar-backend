-- 0007_admin_sessions.sql
-- Session store for the AdminJS dashboard (connect-pg-simple).
-- Separate from user API sessions in 0004_sessions.sql.

CREATE TABLE IF NOT EXISTS admin_sessions (
    sid    VARCHAR NOT NULL COLLATE "default",
    sess   JSON NOT NULL,
    expire TIMESTAMP(6) NOT NULL,
    CONSTRAINT admin_sessions_pkey PRIMARY KEY (sid) NOT DEFERRABLE INITIALLY IMMEDIATE
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_expire
    ON admin_sessions (expire);
