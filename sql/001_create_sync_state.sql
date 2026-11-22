-- Application-owned migration. Run once before starting the synchronizer.
-- Requirements: PostgreSQL 13+ (no extensions).
CREATE TABLE IF NOT EXISTS crashsafe_sync_state (
  sync_key text PRIMARY KEY,
  checkpoint jsonb NULL,
  completed boolean NOT NULL DEFAULT false,
  pages_committed bigint NOT NULL DEFAULT 0,
  records_committed bigint NOT NULL DEFAULT 0,
  lease_owner text NULL,
  lease_fence bigint NOT NULL DEFAULT 0,
  lease_until timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT sync_counters_nonnegative CHECK (pages_committed >= 0 AND records_committed >= 0),
  CONSTRAINT sync_lease_complete CHECK ((lease_owner IS NULL) = (lease_until IS NULL))
);
