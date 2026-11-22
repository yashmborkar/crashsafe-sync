# Baseline comparison

The runnable `examples/baseline/import.mjs` uses `pg`, `p-retry`, a PostgreSQL session advisory lock, a checkpoint table, and one transaction per page. Run it twice with `DATABASE_URL` set to a disposable database after `npm install`. It creates its own two tables. The library example needs the supplied state and destination migrations first. Both examples process two pages per invocation.

Measured with `wc -l` on these files, the baseline contains 51 physical lines and `examples/local-import.mjs` contains 48 physical lines. These counts include comments and blank lines and measure only these examples, not the library implementation, schema, or tests. The baseline uses a dedicated connection for the entire run and releases its session lock on disconnect. It has no lease, fencing token, heartbeat, bounded duration, abort propagation, or provider-specific Retry-After policy. Its sample retries ordinary errors through p-retry and stops on its explicitly invalid checkpoint.

The library PostgreSQL suite exercises transactional rollback, restart from committed progress, concurrent runners, expired leases and takeover, stale fencing, replayed UPSERTs, and HTTP 429 retries. The baseline was run twice and reached offset 35 from offset 20. Its failure cases have not been tested, so no comparative failure-coverage claim is made.
