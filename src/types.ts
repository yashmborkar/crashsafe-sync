/** Represents application progress durably committed in the destination database. */
export interface SyncState<Checkpoint = unknown> {
  readonly key: string;
  readonly checkpoint: Checkpoint | null;
  readonly completed: boolean;
  readonly pagesCommitted: number;
  readonly recordsCommitted: number;
}

/** Opaque owner and fencing generation. Never construct this yourself. */
export interface Lease {
  readonly key: string;
  readonly owner: string;
  readonly fence: string;
}

export interface AcquiredLease {
  readonly lease: Lease;
  readonly state: SyncState;
}

/**
 * Storage is responsible for atomic commit semantics. In particular, commitPage()
 * must run write() and checkpoint advancement inside one database transaction.
 */
export interface SyncStore<Transaction> {
  acquire(key: string, ttlMs: number): Promise<AcquiredLease | null>;
  renew(lease: Lease, ttlMs: number): Promise<boolean>;
  commitPage(options: {
    lease: Lease;
    nextCheckpoint: unknown | null;
    completed: boolean;
    recordCount: number;
    write(tx: Transaction): Promise<void>;
  }): Promise<SyncState>;
  release(lease: Lease): Promise<void>;
  read(key: string): Promise<SyncState | null>;
}

export interface Page<RecordType, Checkpoint> {
  readonly records: readonly RecordType[];
  readonly nextCheckpoint: Checkpoint | null;
  /** True only when no additional page should be fetched, including future runs. */
  readonly done: boolean;
}

export interface FetchContext<Checkpoint> {
  readonly checkpoint: Checkpoint | null;
  readonly signal: AbortSignal;
}

export interface WriteContext<RecordType, Checkpoint, Transaction> {
  /** Use this transaction for EVERY destination write to be coupled to the checkpoint. */
  readonly tx: Transaction;
  readonly records: readonly RecordType[];
  readonly previousCheckpoint: Checkpoint | null;
  readonly nextCheckpoint: Checkpoint | null;
}

export interface RetrySettings {
  /** Total attempts, including the initial request. Default: 3. */
  readonly attempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Called for failed fetches ONLY, not database writes. */
  readonly shouldRetry?: (error: unknown) => boolean;
}

export interface CreateSyncOptions<RecordType, Checkpoint, Transaction> {
  readonly key: string;
  readonly store: SyncStore<Transaction>;
  readonly fetchPage: (context: FetchContext<Checkpoint>) => Promise<Page<RecordType, Checkpoint>>;
  readonly writeBatch: (context: WriteContext<RecordType, Checkpoint, Transaction>) => Promise<void>;
  readonly retry?: RetrySettings;
  /** Default: 60_000. Must exceed a single commit's expected duration. */
  readonly leaseTtlMs?: number;
  /** Default: a third of lease TTL. Set 0 to disable renewal (not recommended). */
  readonly heartbeatIntervalMs?: number;
  /** Noncritical diagnostics, called after the database transaction has committed. */
  readonly onProgress?: (state: SyncState<Checkpoint>) => void | Promise<void>;
}

export interface RunOptions {
  readonly maxPages?: number;
  /** Soft deadline checked between pages; fetchPage is NOT forcibly interrupted. */
  readonly maxDurationMs?: number;
  readonly signal?: AbortSignal;
}

export interface RunResult<Checkpoint = unknown> {
  readonly status: "completed" | "paused" | "busy";
  readonly pagesProcessed: number;
  readonly recordsProcessed: number;
  readonly state: SyncState<Checkpoint> | null;
}
