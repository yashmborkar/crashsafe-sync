import { LeaseLostError } from "./errors.js";
import type { AcquiredLease, Lease, SyncState, SyncStore } from "./types.js";

interface MemoryRow { state: SyncState; owner: string | null; fence: number; expires: number; }

/**
 * Test-only storage; NOT durable and NOT transaction-safe for external writes.
 * Use PgSyncStore for any real synchronization.
 */
export class MemorySyncStore<Transaction = undefined> implements SyncStore<Transaction> {
  private readonly rows = new Map<string, MemoryRow>();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly txForTests: () => Transaction = () => undefined as Transaction) {}

  private async exclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.locks.set(key, current);
    await prior;
    try { return await task(); }
    finally {
      release();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }

  async acquire(key: string, ttlMs: number): Promise<AcquiredLease | null> {
    return this.exclusive(key, async () => {
      let row = this.rows.get(key);
      if (!row) {
        row = { state: { key, checkpoint: null, completed: false, pagesCommitted: 0, recordsCommitted: 0 }, owner: null, fence: 0, expires: 0 };
        this.rows.set(key, row);
      }
      if (row.owner && row.expires > Date.now()) return null;
      const owner = crypto.randomUUID();
      row.owner = owner;
      row.fence++;
      row.expires = Date.now() + ttlMs;
      return { lease: { key, owner, fence: String(row.fence) }, state: structuredClone(row.state) };
    });
  }

  async renew(lease: Lease, ttlMs: number): Promise<boolean> {
    return this.exclusive(lease.key, async () => {
      const row = this.rows.get(lease.key);
      if (!row || !this.isOwner(row, lease)) return false;
      row.expires = Date.now() + ttlMs;
      return true;
    });
  }

  private isOwner(row: MemoryRow, lease: Lease): boolean {
    return row.owner === lease.owner && String(row.fence) === lease.fence && row.expires > Date.now();
  }

  async commitPage(options: { lease: Lease; nextCheckpoint: unknown | null; completed: boolean; recordCount: number; write(tx: Transaction): Promise<void>; }): Promise<SyncState> {
    return this.exclusive(options.lease.key, async () => {
      const row = this.rows.get(options.lease.key);
      if (!row || !this.isOwner(row, options.lease)) throw new LeaseLostError(options.lease.key);
      await options.write(this.txForTests());
      if (!this.isOwner(row, options.lease)) throw new LeaseLostError(options.lease.key);
      row.state = {
        key: options.lease.key,
        checkpoint: structuredClone(options.nextCheckpoint ?? null),
        completed: options.completed,
        pagesCommitted: row.state.pagesCommitted + 1,
        recordsCommitted: row.state.recordsCommitted + options.recordCount,
      };
      return structuredClone(row.state);
    });
  }

  async release(lease: Lease): Promise<void> {
    await this.exclusive(lease.key, async () => {
      const row = this.rows.get(lease.key);
      if (row && row.owner === lease.owner && String(row.fence) === lease.fence) {
        row.owner = null;
        row.expires = 0;
      }
    });
  }

  async read(key: string): Promise<SyncState | null> {
    return this.exclusive(key, async () => structuredClone(this.rows.get(key)?.state ?? null));
  }
}
