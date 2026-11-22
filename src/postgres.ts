import { LeaseLostError } from "./errors.js";
import type { AcquiredLease, Lease, SyncState, SyncStore } from "./types.js";

/** Minimal node-postgres compatible interface. pg is NOT a runtime dependency. */
export interface SqlConnection {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  release(error?: Error | boolean): void;
}
export interface SqlPool {
  connect(): Promise<SqlConnection>;
}

function fromRow(row: Record<string, unknown>): SyncState {
  return {
    key: String(row.sync_key),
    checkpoint: row.checkpoint ?? null,
    completed: Boolean(row.completed),
    pagesCommitted: Number(row.pages_committed),
    recordsCommitted: Number(row.records_committed),
  };
}

function validLeaseMs(ttlMs: number): number {
  // PostgreSQL parameter cast is int; cap prevents overflow.
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 2_147_483_647) {
    throw new RangeError("lease ttl must be 1..2147483647 milliseconds");
  }
  return ttlMs;
}

/**
 * PostgreSQL-backed state storage with transaction-coupled business writes.
 * No implicit migrations; execute sql/001_create_sync_state.sql yourself.
 */
export class PgSyncStore implements SyncStore<SqlConnection> {
  constructor(private readonly pool: SqlPool) {}

  private async withClient<T>(fn: (client: SqlConnection) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      const result = await fn(client);
      client.release();
      return result;
    } catch (error) {
      // A failed connection or rollback must not be returned to the pool.
      client.release(true);
      throw error;
    }
  }

  async acquire(key: string, ttlMs: number): Promise<AcquiredLease | null> {
    validLeaseMs(ttlMs);
    const owner = crypto.randomUUID();
    return this.withClient(async client => {
      await client.query(
        "INSERT INTO crashsafe_sync_state (sync_key) VALUES ($1) ON CONFLICT DO NOTHING",
        [key],
      );
      const result = await client.query(`
        UPDATE crashsafe_sync_state
        SET lease_owner = $2,
            lease_fence = lease_fence + 1,
            lease_until = clock_timestamp() + ($3::integer * interval '1 millisecond'),
            updated_at = clock_timestamp()
        WHERE sync_key = $1 AND (lease_owner IS NULL OR lease_until <= clock_timestamp())
        RETURNING sync_key, checkpoint, completed, pages_committed, records_committed, lease_fence
      `, [key, owner, ttlMs]);
      const row = result.rows[0];
      if (!row) return null;
      return {
        lease: { key, owner, fence: String(row.lease_fence) },
        state: fromRow(row),
      };
    });
  }

  async renew(lease: Lease, ttlMs: number): Promise<boolean> {
    validLeaseMs(ttlMs);
    return this.withClient(async client => {
      const result = await client.query(`
        UPDATE crashsafe_sync_state
        SET lease_until = clock_timestamp() + ($4::integer * interval '1 millisecond'),
            updated_at = clock_timestamp()
        WHERE sync_key = $1 AND lease_owner = $2 AND lease_fence = $3::bigint
          AND lease_until > clock_timestamp()
      `, [lease.key, lease.owner, lease.fence, ttlMs]);
      return (result.rowCount ?? 0) > 0;
    });
  }

  async commitPage(options: {
    lease: Lease;
    nextCheckpoint: unknown | null;
    completed: boolean;
    recordCount: number;
    write(tx: SqlConnection): Promise<void>;
  }): Promise<SyncState> {
    if (!Number.isSafeInteger(options.recordCount) || options.recordCount < 0) {
      throw new RangeError("recordCount must be a nonnegative integer");
    }
    const checkpointJson = JSON.stringify(options.nextCheckpoint ?? null);
    return this.withClient(async client => {
      await client.query("BEGIN");
      try {
        const check = await client.query(`
          SELECT lease_owner, lease_fence, (lease_until > clock_timestamp()) AS active
          FROM crashsafe_sync_state WHERE sync_key = $1 FOR UPDATE
        `, [options.lease.key]);
        const row = check.rows[0];
        if (!row || row.lease_owner !== options.lease.owner ||
            String(row.lease_fence) !== options.lease.fence || row.active !== true) {
          throw new LeaseLostError(options.lease.key);
        }
        // Every application write MUST use this exact tx client; other clients are not atomic.
        await options.write(client);
        const updated = await client.query(`
          UPDATE crashsafe_sync_state
          SET checkpoint = $4::jsonb,
              completed = $5,
              pages_committed = pages_committed + 1,
              records_committed = records_committed + $6::bigint,
              updated_at = clock_timestamp()
          WHERE sync_key = $1 AND lease_owner = $2 AND lease_fence = $3::bigint
            AND lease_until > clock_timestamp()
          RETURNING sync_key, checkpoint, completed, pages_committed, records_committed
        `, [options.lease.key, options.lease.owner, options.lease.fence, checkpointJson,
          options.completed, options.recordCount]);
        if (!updated.rows[0]) throw new LeaseLostError(options.lease.key);
        await client.query("COMMIT");
        return fromRow(updated.rows[0]);
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { /* propagate original error */ }
        throw error;
      }
    });
  }

  async release(lease: Lease): Promise<void> {
    await this.withClient(async client => {
      await client.query(`
        UPDATE crashsafe_sync_state SET lease_owner = NULL, lease_until = NULL,
          updated_at = clock_timestamp()
        WHERE sync_key = $1 AND lease_owner = $2 AND lease_fence = $3::bigint
      `, [lease.key, lease.owner, lease.fence]);
    });
  }

  async read(key: string): Promise<SyncState | null> {
    return this.withClient(async client => {
      const result = await client.query(`
        SELECT sync_key, checkpoint, completed, pages_committed, records_committed
        FROM crashsafe_sync_state WHERE sync_key = $1
      `, [key]);
      return result.rows[0] ? fromRow(result.rows[0]) : null;
    });
  }
}
