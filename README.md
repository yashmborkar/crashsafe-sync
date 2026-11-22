# crashsafe-sync

**Persist a page of external API records and its continuation checkpoint in one PostgreSQL transaction.**

`crashsafe-sync` is a small, dependency-free TypeScript library core for resumable paginated API imports. Bring your own API SDK and PostgreSQL client. It does not replace Airbyte, Nango, Temporal, queues, or your provider's cursor rules.

> **Status: 0.1.0-beta.0 in preparation.** Publishing requires the test suite and a disposable PostgreSQL database.

## Why it exists

The dangerous sequence is:

```text
fetch page 5 → save checkpoint 5 → crash → page 5 database writes never happen
```

Instead, this package runs business writes **and** the checkpoint update inside a single Postgres transaction:

```text
fetch page 5 → BEGIN → UPSERT page 5 → save checkpoint 5 → COMMIT
```

If the transaction fails, neither write is committed. A later invocation resumes from the last committed checkpoint. It still may retry a page after an uncertain acknowledgement; your destination must use stable IDs and idempotent UPSERTs.

## What is included

- PostgreSQL checkpoint table + one SQL migration, **no extensions**
- `createSync()` with `fetchPage()` / `writeBatch()` callbacks
- Atomic application writes + checkpoint movement on one database connection
- Single active runner per sync key, lease renewal and fencing against stale workers
- Bounded runs (`maxPages`, `maxDurationMs`) suitable for cron or repeated serverless invocations
- Configurable retries **for page fetching only**; `HttpResponseError` with `Retry-After` support
- Explicit errors for stale checkpoints and failed leases
- Progress, resumed/completed state and a test-only in-memory adapter
- Zero runtime dependencies; the PostgreSQL adapter uses a structural `pg`-compatible interface

## Installation

This package is prepared for a beta release. Before publication, install from a local checkout.

```bash
npm install pg @yashborkar/crashsafe-sync
```

For local source development:

```bash
npm install
npm run build
npm test
```

## SQL migration

Apply once in your existing Postgres database:

```bash
psql "$DATABASE_URL" -f sql/001_create_sync_state.sql
```

The library **never** auto-migrates production databases. The migration creates only `crashsafe_sync_state`. Your application's record tables are separate.

## Small example

```ts
import pg from "pg";
import { createSync } from "@yashborkar/crashsafe-sync";
import { PgSyncStore } from "@yashborkar/crashsafe-sync/postgres";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const sync = createSync({
  key: "stripe:customers:tenant-123",
  store: new PgSyncStore(pool),
  retry: { attempts: 3 },
  async fetchPage({ checkpoint, signal }) {
    // Replace with a provider SDK or fetch(url, {signal}).
    const page = await getProviderPage(checkpoint, signal);
    return {
      records: page.data,
      nextCheckpoint: page.hasMore ? { lastId: page.data.at(-1).id } : null,
      done: !page.hasMore,
    };
  },
  async writeBatch({ tx, records }) {
    // CRITICAL: use tx, not pool.query or a second ORM connection.
    for (const customer of records) {
      await tx.query(
        `INSERT INTO customers(external_id,email) VALUES($1,$2)
         ON CONFLICT(external_id) DO UPDATE SET email=EXCLUDED.email`,
        [customer.id, customer.email],
      );
    }
  },
});

const result = await sync.run({ maxPages: 10, maxDurationMs: 25_000 });
console.log(result.status, result.state?.checkpoint);
await pool.end();
```

`getProviderPage` and `customers` are application-defined. A fully runnable fake-provider example is in `examples/local-import.mjs`.

## Try the runnable example

```bash
# Uses a PostgreSQL database you control.
export DATABASE_URL='postgresql://localhost/your_test_database'
npm install
npm run build
psql "$DATABASE_URL" -f sql/001_create_sync_state.sql
psql "$DATABASE_URL" -f examples/example_records.sql
node examples/local-import.mjs
node examples/local-import.mjs   # resume from checkpoint, then complete
```

Set `SIMULATE_429=1` on the first command to exercise the retry flow.

## Tests

```bash
npm test                  # TypeScript build + unit tests (no DB needed)
SYNC_TEST_DB_OK=yes DATABASE_URL='postgresql://localhost/a_disposable_db' npm run test:pg
npm run pack:check        # what npm would publish
```

**Never run `test:pg` against a production database.** The `SYNC_TEST_DB_OK=yes` opt-in exists to make that explicit. PostgreSQL tests exercise real database transactions, lease races, rollback and resuming. CI provisions a disposable Postgres service.

## Important guarantees and non-guarantees

**Guaranteed by the PostgreSQL adapter when configured correctly:**

- Destination writes executed using the provided `tx` and checkpoint updates share one transaction.
- The adapter checks the lease and fencing token before writing and again in the checkpoint update. The transaction holds the state row lock until commit, preventing another worker from taking over during that interval. The final expiry check occurs before COMMIT, so a lease can expire between that check and the commit acknowledgement.
- Each `(sync key)` has at most one currently active leased runner.
- A successfully committed checkpoint is read by subsequent runs.

**NOT guaranteed:**

- Exactly-once invocation of `fetchPage()` or `writeBatch()`; a page can run again after a crash.
- Exactly-once external side effects (emails, API writes, payment operations) inside `writeBatch()`. Such effects cannot be rolled back by Postgres.
- No duplicates if the caller inserts records without stable IDs and unique keys.
- Snapshot consistency, complete deletion detection, or correctness of provider ordering / watermark semantics.
- Automatic re-invocation when a serverless job stops. Use your cron/job runner/platform scheduler.
- Atomic writes to other database connections or stores that ignore the provided `tx`.
- Universal recovery from invalid/expired source cursors. Those require provider-specific decisions.

**Do not call `fetch` or other external services from `writeBatch()`.** It holds a DB transaction open. Prepare external data before entering that callback.

### Retry and error handling

Only `fetchPage()` is automatically retried. Throw `new HttpResponseError(429, 'rate limited', 2000)` to request a delay of 2 seconds; retryable statuses are 408, 425, 429 and 5xx. Other transient errors need `{retryable:true}` or a custom `retry.shouldRetry` callback. `CheckpointInvalidError` is never retried automatically. This prevents a failed *database write* from being silently retried without knowing if external effects occurred.

`maxDurationMs` is a **soft limit** checked between pages; it does not cancel a fetch already in progress. Forward the `signal` to HTTP clients if they support cancellation. A lease must be long enough to cover unusually slow DB commits. Heartbeats renew it while the runner is active, but a page transaction locks the lease row and can delay renewal. An expired lease causes that page transaction to roll back. A stalled database query can delay takeover until PostgreSQL releases its locks.

### Reset and re-sync

A completed sync stays completed. To full-resync, use a **new `key`** (for example `my-api:contacts:v2`) and reconcile old records in your application. Do not reset a cursor blindly when a provider says the source token expired.

See [the baseline comparison](https://github.com/yashmborkar/crashsafe-sync/blob/main/docs/BASELINE.md) for measured example size and tested failure scenarios.

## Roadmap

- [x] Small typed API, retries, resumable bounded runs, PgSyncStore + migration
- [x] Test-only in-memory store and unit tests
- [x] Real PostgreSQL concurrency/integrity integration test suite
- [x] Run integration suite on a disposable PostgreSQL instance
- [ ] Produce an actual competent-baseline comparison with raw measurements
- [ ] Test integration in a real SaaS repository and obtain maintainer feedback
- [ ] Verify npm name and repository metadata, publish v0.1.0 under the owner's account
- [ ] Expand only based on real user demand

## Security and operations

- Use distinct sync keys per tenant and source. The library treats keys as opaque; your application must ensure tenant scoping and authorization.
- Do not put API tokens or credentials inside checkpoint JSON: it is stored in plaintext JSONB.
- Do not expose the raw sync-state table to users; use appropriate database credentials and permissions.
- Avoid holding transactions open across HTTP calls or slow computations.
- Use stable external record IDs and application-level unique indexes.
- Use provider-specific policies for expired cursors, mutable pagination, rate limits and incremental timestamps.
- Record only non-sensitive progress in `onProgress`.

## License

MIT.
