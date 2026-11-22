import { AbortSyncError, InvalidPageError, LeaseLostError } from "./errors.js";
import { abortIfNeeded, retryFetch } from "./retry.js";
import type { CreateSyncOptions, RunOptions, RunResult, SyncState } from "./types.js";

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
}

/**
 * Processes one page at a time, atomically coupling destination writes with the
 * durable checkpoint via SyncStore.commitPage(). It does NOT schedule future runs.
 */
export function createSync<RecordType, Checkpoint, Transaction>(
  options: CreateSyncOptions<RecordType, Checkpoint, Transaction>,
) {
  if (!options.key || !options.key.trim()) throw new TypeError("Sync key cannot be empty");
  const ttlMs = options.leaseTtlMs ?? 60_000;
  assertPositiveInteger(ttlMs, "leaseTtlMs");
  const heartbeatMs = options.heartbeatIntervalMs ?? Math.max(250, Math.floor(ttlMs / 3));
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 0) {
    throw new RangeError("heartbeatIntervalMs must be a nonnegative integer");
  }
  if (heartbeatMs > 0 && heartbeatMs >= ttlMs) {
    throw new RangeError("heartbeatIntervalMs must be smaller than leaseTtlMs");
  }

  return {
    readState(): Promise<SyncState<Checkpoint> | null> {
      return options.store.read(options.key) as Promise<SyncState<Checkpoint> | null>;
    },
    async run(runOptions: RunOptions = {}): Promise<RunResult<Checkpoint>> {
      const maxPages = runOptions.maxPages ?? Number.MAX_SAFE_INTEGER;
      const maxDurationMs = runOptions.maxDurationMs ?? Number.MAX_SAFE_INTEGER;
      assertPositiveInteger(maxPages, "maxPages");
      assertPositiveInteger(maxDurationMs, "maxDurationMs");
      if (runOptions.signal?.aborted) throw new AbortSyncError();
      const acquired = await options.store.acquire(options.key, ttlMs);
      if (!acquired) {
        return { status: "busy", pagesProcessed: 0, recordsProcessed: 0, state: await options.store.read(options.key) as SyncState<Checkpoint> | null };
      }
      const { lease } = acquired;
      let current = acquired.state as SyncState<Checkpoint>;
      let pagesProcessed = 0;
      let recordsProcessed = 0;
      let lostLease = false;
      const local = new AbortController();
      const signal = local.signal;
      const abortFromCaller = () => local.abort();
      runOptions.signal?.addEventListener("abort", abortFromCaller, { once: true });
      if (runOptions.signal?.aborted) local.abort();
      const started = Date.now();
      let renewing = false;
      const timer = heartbeatMs > 0 ? setInterval(() => {
        if (renewing || local.signal.aborted) return;
        renewing = true;
        void options.store.renew(lease, ttlMs).then(ok => {
          if (!ok) { lostLease = true; local.abort(); }
        }).catch(() => {
          // A transient DB failure during heartbeat cannot safely be ignored.
          lostLease = true;
          local.abort();
        }).finally(() => { renewing = false; });
      }, heartbeatMs) : undefined;

      try {
        while (!current.completed && pagesProcessed < maxPages && Date.now() - started < maxDurationMs) {
          if (lostLease) throw new LeaseLostError(options.key);
          abortIfNeeded(signal);
          const previous = current.checkpoint;
          let page;
          try {
            page = await retryFetch(() => options.fetchPage({ checkpoint: previous, signal }), signal, options.retry);
          } catch (error) {
            if (lostLease) throw new LeaseLostError(options.key);
            throw error;
          }
          if (lostLease) throw new LeaseLostError(options.key);
          abortIfNeeded(signal);
          if (!page || !Array.isArray(page.records) || typeof page.done !== "boolean") {
            throw new InvalidPageError("fetchPage must return { records: [], nextCheckpoint, done: boolean }");
          }
          if (!page.done && (page.nextCheckpoint === undefined ||
            JSON.stringify(page.nextCheckpoint) === JSON.stringify(previous))) {
            throw new InvalidPageError("Non-final page must advance the checkpoint; refusing an infinite loop");
          }
          // Validate JSON-serializable cursor before beginning the database transaction.
          if (page.nextCheckpoint !== null && page.nextCheckpoint !== undefined &&
              JSON.stringify(page.nextCheckpoint) === undefined) {
            throw new InvalidPageError("Checkpoint must be JSON serializable");
          }
          current = await options.store.commitPage({
            lease,
            nextCheckpoint: page.nextCheckpoint ?? null,
            completed: page.done,
            recordCount: page.records.length,
            write: tx => options.writeBatch({
              tx, records: page.records,
              previousCheckpoint: previous,
              nextCheckpoint: page.nextCheckpoint,
            }),
          }) as SyncState<Checkpoint>;
          pagesProcessed++;
          recordsProcessed += page.records.length;
          try { await options.onProgress?.(current); } catch { /* telemetry never reverses a successful commit */ }
        }
        if (lostLease) throw new LeaseLostError(options.key);
        if (signal.aborted) throw new AbortSyncError();
        return {
          status: current.completed ? "completed" : "paused",
          pagesProcessed,
          recordsProcessed,
          state: current,
        };
      } finally {
        if (timer) clearInterval(timer);
        runOptions.signal?.removeEventListener("abort", abortFromCaller);
        local.abort();
        await options.store.release(lease).catch(() => {
          // Lease expiration + fencing provide safety if release cannot reach DB.
        });
      }
    },
  };
}
