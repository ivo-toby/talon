-- Signal gate state is keyed by canonical ACI, never a configured channel name.
CREATE TABLE IF NOT EXISTS signal_account_state (
  account_uuid TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  last_send_start INTEGER CHECK (last_send_start BETWEEN 0 AND 9007199254740991),
  last_device_check_start INTEGER CHECK (last_device_check_start BETWEEN 0 AND 9007199254740991),
  -- Deliberately not a FK: purging a queue item cannot erase a possibly written RPC.
  reservation_queue_item_id TEXT,
  reservation_delivery_id TEXT,
  reservation_purpose TEXT CHECK (reservation_purpose IN ('reply', 'background', 'explicit', 'progress')),
  reservation_started_at INTEGER CHECK (reservation_started_at BETWEEN 0 AND 9007199254740991),
  rate_limit_not_before INTEGER NOT NULL DEFAULT 0 CHECK (rate_limit_not_before BETWEEN 0 AND 9007199254740991),
  recovery_not_before INTEGER NOT NULL DEFAULT 0 CHECK (recovery_not_before BETWEEN 0 AND 9007199254740991),
  challenge INTEGER NOT NULL DEFAULT 0 CHECK (challenge IN (0, 1)),
  pause_kind TEXT GENERATED ALWAYS AS (
    CASE WHEN challenge = 1 THEN 'challenge'
         WHEN rate_limit_not_before > 0 THEN 'rate_limit'
         WHEN recovery_not_before > 0 THEN 'recovery' ELSE 'none' END
  ) STORED,
  not_before INTEGER GENERATED ALWAYS AS (MAX(rate_limit_not_before, recovery_not_before)) STORED,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((reservation_queue_item_id IS NULL AND reservation_delivery_id IS NULL
          AND reservation_purpose IS NULL AND reservation_started_at IS NULL)
      OR (reservation_queue_item_id IS NOT NULL AND reservation_delivery_id IS NOT NULL
          AND reservation_purpose IS NOT NULL AND reservation_started_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS signal_destination_leases (
  account_uuid TEXT NOT NULL,
  external_thread_id TEXT NOT NULL,
  -- Fresh identity prevents a late release from deleting a subsequently reacquired lease.
  lease_id TEXT NOT NULL UNIQUE,
  queue_item_id TEXT NOT NULL REFERENCES queue_items(id) ON DELETE CASCADE,
  delivery_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('reply', 'background', 'explicit', 'progress')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_uuid, external_thread_id)
);
CREATE INDEX IF NOT EXISTS idx_signal_destination_leases_queue ON signal_destination_leases(queue_item_id);
