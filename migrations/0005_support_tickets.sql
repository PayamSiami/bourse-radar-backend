-- 0005_support_tickets.sql
-- Support tickets and their message thread.
--
-- NOTE: the first message of a ticket is inserted by the application inside
-- the same transaction as INSERT INTO tickets. There is deliberately NO
-- seed trigger here — having both caused duplicate first messages.

CREATE TABLE IF NOT EXISTS tickets (
    id                BIGSERIAL PRIMARY KEY,
    user_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title             VARCHAR(255) NOT NULL,
    description       TEXT,
    status            TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','pending','resolved','closed')),
    last_message      TEXT,
    last_message_at   TIMESTAMPTZ,
    last_message_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tickets_user_created
    ON tickets (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tickets_user_last_message
    ON tickets (user_id, last_message_at DESC NULLS LAST);

DROP TRIGGER IF EXISTS trg_tickets_updated_at ON tickets;
CREATE TRIGGER trg_tickets_updated_at
    BEFORE UPDATE ON tickets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── ticket_messages ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ticket_messages (
    id          BIGSERIAL PRIMARY KEY,
    ticket_id   BIGINT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        TEXT NOT NULL DEFAULT 'user'
                CHECK (role IN ('user','admin')),
    message     TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ticket_messages_ticket_created
    ON ticket_messages (ticket_id, created_at ASC, id ASC);

-- Keep tickets.last_message* in sync with every new message.
CREATE OR REPLACE FUNCTION sync_ticket_last_message()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE tickets
       SET last_message    = NEW.message,
           last_message_at = NEW.created_at,
           last_message_by = NEW.user_id
     WHERE id = NEW.ticket_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_ticket_last_message ON ticket_messages;
CREATE TRIGGER trg_sync_ticket_last_message
    AFTER INSERT ON ticket_messages
    FOR EACH ROW EXECUTE FUNCTION sync_ticket_last_message();