-- Message ledger for native replies and reactions.
--
-- Maps a provider-side message identifier (Telegram message_id, WhatsApp
-- message key / wamid, Signal sent timestamp) to the Talon thread it belongs
-- to, so an inbound reply or reaction can be resolved back to the message it
-- targets and an outbound reply or reaction can address one.
--
-- A row is not a message: one outbound `messages` row can be delivered as
-- several provider messages (text flushed before a tool call, then the final
-- block), each with its own ref, and `message_id` is NULL for provider
-- messages that have no stored counterpart. `excerpt` is a bounded plain-text
-- copy used to render reply/reaction context and to build provider quotes.

CREATE TABLE message_refs (
  thread_id    TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  external_id  TEXT NOT NULL,
  direction    TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  message_id   TEXT,
  sender_id    TEXT,
  excerpt      TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (thread_id, external_id)
);

CREATE INDEX idx_message_refs_message ON message_refs(message_id);
CREATE INDEX idx_message_refs_thread_created ON message_refs(thread_id, direction, created_at);
